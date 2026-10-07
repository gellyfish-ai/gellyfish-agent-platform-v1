import db, { storeSessionTaskEvent, taskEvents } from '../db/index.js';
import type { ManagedProcess } from '../session-send.js';
import { sendToSocket } from './broadcast.js';
import { logger } from '../logger.js';

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content.replace(/^Human:\s*/i, '');
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join('\n')
      .replace(/^Human:\s*/i, '');
  }
  return '';
}

// Track tool_use_id → tool_name for MCP failure detection
const toolUseNames = new Map<string, Map<string, string>>();

export function trackToolUseName(sessionId: string, toolUseId: string, toolName: string) {
  if (!toolUseNames.has(sessionId)) toolUseNames.set(sessionId, new Map());
  const map = toolUseNames.get(sessionId)!;
  map.set(toolUseId, toolName);
  if (map.size > 100) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
}

export function getToolNameForResult(sessionId: string, toolUseId: string): string | null {
  return toolUseNames.get(sessionId)?.get(toolUseId) || null;
}

// MCP health tracking
const mcpFailures = new Map<string, Map<string, number>>();
const mcpWarningsSent = new Map<string, Set<string>>();

function extractMcpName(toolName: string): string | null {
  const match = toolName.match(/^mcp__([^_]+)__/);
  return match ? match[1] : null;
}

export function trackMcpResult(sessionId: string, toolName: string, isError: boolean, managed: ManagedProcess) {
  const mcpName = extractMcpName(toolName);
  if (!mcpName) return;

  if (!mcpFailures.has(sessionId)) mcpFailures.set(sessionId, new Map());
  if (!mcpWarningsSent.has(sessionId)) mcpWarningsSent.set(sessionId, new Set());
  const failures = mcpFailures.get(sessionId)!;
  const warned = mcpWarningsSent.get(sessionId)!;

  if (isError) {
    const count = (failures.get(mcpName) || 0) + 1;
    failures.set(mcpName, count);
    if (count >= 3 && !warned.has(mcpName)) {
      warned.add(mcpName);
      sendToSocket(managed, {
        type: 'mcp_health_warning',
        mcp: mcpName,
        failures: count,
        message: `MCP "${mcpName}" may be disconnected — last ${count} tool calls failed.`,
      });
    }
  } else {
    failures.delete(mcpName);
    warned.delete(mcpName);
  }
}

// Compaction silence timers — keyed by sessionId
const compactionTimers = new Map<string, ReturnType<typeof setTimeout>>();

const COMPACTION_SILENCE_MS = 15_000;

function startCompactionTimer(managed: ManagedProcess) {
  cancelCompactionTimer(managed.sessionId);
  logger.debug({ sessionId: managed.sessionId }, '[compaction] silence timer started');
  const timer = setTimeout(() => {
    compactionTimers.delete(managed.sessionId);
    logger.info({ sessionId: managed.sessionId }, '[compaction] silence timer fired — sending compaction_likely');
    sendToSocket(managed, { type: 'compaction_likely' });
  }, COMPACTION_SILENCE_MS);
  compactionTimers.set(managed.sessionId, timer);
}

function cancelCompactionTimer(sessionId: string) {
  const existing = compactionTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    compactionTimers.delete(sessionId);
  }
}

// Track streamed text length per message ID for delta computation
const streamedTextLengths = new Map<string, number>();

export function clearStreamState(sessionId: string) {
  cancelCompactionTimer(sessionId);
  for (const key of streamedTextLengths.keys()) {
    if (key.startsWith(sessionId + ':')) streamedTextLengths.delete(key);
  }
}

// Track subagent (Agent tool) depth per process
const subagentDepth = new Map<string, { depth: number; toolUseIds: Set<string> }>();

export function getSubagentState(sessionId: string) {
  if (!subagentDepth.has(sessionId)) {
    subagentDepth.set(sessionId, { depth: 0, toolUseIds: new Set() });
  }
  return subagentDepth.get(sessionId)!;
}

export function handleClaudeEvent(event: Record<string, unknown>, managed: ManagedProcess) {
  logger.debug({ type: event.type, subtype: event.subtype, sessionId: managed.sessionId }, '[claude-event] received');
  switch (event.type as string) {
    case 'system':
      if (event.subtype === 'init') {
        sendToSocket(managed, { type: 'init', sessionId: event.session_id || event.sessionId, tools: event.tools });
        // Write confirmed_model from init event to profile
        const initModel = event.model as string | undefined;
        if (initModel && managed.profileId) {
          db.prepare('UPDATE profiles SET confirmed_model = ? WHERE id = ?').run(initModel, managed.profileId);
        }
      } else if (event.subtype === 'compact_boundary') {
        cancelCompactionTimer(managed.sessionId);
        const meta = event.compactMetadata as Record<string, unknown> | undefined;
        logger.info({ sessionId: managed.sessionId, meta }, '[compaction] compact_boundary received from CLI');
        sendToSocket(managed, {
          type: 'compaction_completed',
          metadata: {
            preTokens: meta?.preTokens,
            postTokens: meta?.postTokens,
            durationMs: meta?.durationMs,
          },
        });
      }
      break;

    case 'assistant': {
      cancelCompactionTimer(managed.sessionId);
      const message = event.message as Record<string, unknown>;
      const msgUuid = (event.uuid || message?.id || '') as string;
      const content = message?.content as Array<Record<string, unknown>>;
      const sa = getSubagentState(managed.sessionId);
      const stopReason = message?.stop_reason as string | null | undefined;
      const isPartial = !stopReason;

      // Partial messages (streaming): send text deltas and tool_use blocks as they appear
      if (isPartial && content && sa.depth === 0) {
        const fullText = content
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text as string)
          .join('');
        const streamKey = managed.sessionId + ':' + msgUuid;
        const prevLength = streamedTextLengths.get(streamKey) || 0;
        if (fullText.length > prevLength) {
          const delta = fullText.substring(prevLength);
          sendToSocket(managed, { type: 'text', text: delta, messageId: msgUuid });
          streamedTextLengths.set(streamKey, fullText.length);
        }

        // Also forward tool_use blocks from partials — they appear before tool_result
        const sentToolsKey = streamKey + ':tools';
        if (!streamedTextLengths.has(sentToolsKey)) {
          streamedTextLengths.set(sentToolsKey, 0);
        }
        const sentToolCount = streamedTextLengths.get(sentToolsKey)!;
        const toolBlocks = content.filter(b => b.type === 'tool_use');
        for (let i = sentToolCount; i < toolBlocks.length; i++) {
          const block = toolBlocks[i];
          const toolName = block.name as string;
          trackToolUseName(managed.sessionId, block.id as string, toolName);
          if (toolName === 'Agent') {
            sa.depth++;
            sa.toolUseIds.add(block.id as string);
          }
          if (sa.depth === 0 || toolName === 'Agent') {
            sendToSocket(managed, { type: 'tool_use', toolUseId: block.id, toolName: block.name, input: block.input });
            // Emit agent_message for SendUserMessage tool calls (brief mode)
            if (toolName === 'SendUserMessage' && sa.depth === 0) {
              const input = block.input as Record<string, unknown> | undefined;
              const text = input?.message as string || input?.text as string || '';
              if (text) {
                sendToSocket(managed, { type: 'agent_message', text, sessionId: managed.sessionId });
              }
            }
          }
        }
        streamedTextLengths.set(sentToolsKey, toolBlocks.length);

        break;
      }

      // Final message — process tool_use, images, and any remaining text
      const streamKey = managed.sessionId + ':' + msgUuid;
      const alreadyStreamed = streamedTextLengths.has(streamKey);
      const toolsAlreadySent = streamedTextLengths.has(streamKey + ':tools');
      const sentToolCount = streamedTextLengths.get(streamKey + ':tools') || 0;
      streamedTextLengths.delete(streamKey);
      streamedTextLengths.delete(streamKey + ':tools');

      const taskContext = managed.pendingTaskContext;
      if (taskContext) managed.pendingTaskContext = null;
      let toolUseIndex = 0;
      if (content) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            if (sa.depth === 0) {
              if (alreadyStreamed) {
                // Text already sent via partial deltas — store task event and emit timeline update
                if (taskContext && managed.sessionId) {
                  const taskResponseData = {
                    type: 'task_response',
                    taskId: taskContext.taskId,
                    agentName: taskContext.agentName,
                    text: block.text as string,
                    timestamp: new Date().toISOString(),
                  };
                  storeSessionTaskEvent(managed.sessionId, taskContext.taskId, 'task_response', taskResponseData);
                  // Emit to timeline card (text was already sent to chat via partials)
                  sendToSocket(managed, { type: 'task_response', taskId: taskContext.taskId, text: block.text as string });
                }
              } else {
                // No partial streaming happened — send full text (fallback)
                const msg: Record<string, unknown> = { type: 'text', text: block.text, messageId: msgUuid };
                if (taskContext) msg.taskContext = taskContext;
                sendToSocket(managed, msg);
                if (taskContext && managed.sessionId) {
                  storeSessionTaskEvent(managed.sessionId, taskContext.taskId, 'task_response', {
                    type: 'task_response',
                    taskId: taskContext.taskId,
                    agentName: taskContext.agentName,
                    text: block.text as string,
                    timestamp: new Date().toISOString(),
                  });
                }
              }
            }
          } else if (block.type === 'tool_use') {
            toolUseIndex++;
            // Skip tool_use blocks already sent via partial messages
            if (toolsAlreadySent && toolUseIndex <= sentToolCount) {
              continue;
            }
            const toolName = block.name as string;
            trackToolUseName(managed.sessionId, block.id as string, toolName);
            if (toolName === 'Agent') {
              sa.depth++;
              sa.toolUseIds.add(block.id as string);
              sendToSocket(managed, { type: 'tool_use', toolUseId: block.id, toolName: block.name, input: block.input });
            } else if (sa.depth > 0) {
              // Inside subagent — suppress
            } else {
              sendToSocket(managed, { type: 'tool_use', toolUseId: block.id, toolName: block.name, input: block.input });
              // Emit agent_message for SendUserMessage tool calls (brief mode)
              if (toolName === 'SendUserMessage') {
                const input = block.input as Record<string, unknown> | undefined;
                const text = input?.message as string || input?.text as string || '';
                if (text) {
                  sendToSocket(managed, { type: 'agent_message', text, sessionId: managed.sessionId });
                }
              }
            }
          } else if (block.type === 'image' && block.source) {
            if (sa.depth === 0) {
              sendToSocket(managed, {
                type: 'image',
                data: (block.source as Record<string, unknown>).data,
                mediaType: (block.source as Record<string, unknown>).media_type || 'image/png',
                messageId: msgUuid,
              });
            }
          }
        }
      }
      break;
    }

    case 'user': {
      const userMessage = event.message as Record<string, unknown>;
      const userContent = userMessage?.content as Array<Record<string, unknown>>;
      const saUser = getSubagentState(managed.sessionId);

      // Extract text from user turn to detect task injections vs real user messages
      if (userContent && managed.pendingTaskContext) {
        const userText = extractUserText(userContent);
        const isTaskInjection = /^\[Task [a-f0-9-]+\]|^Task (completed|failed) by |^Task (progress|update) — /.test(userText);
        if (userText && !isTaskInjection) {
          managed.pendingTaskContext = null;
        }
      }

      // Detect compaction summary via text content (CLI doesn't emit isCompactSummary on stdout)
      if (userContent) {
        const fullText = extractUserText(userContent);
        if (fullText.startsWith('This session is being continued from a previous conversation that ran out of context')) {
          logger.info({ sessionId: managed.sessionId }, '[compaction] summary text detected in user event');
          sendToSocket(managed, { type: 'compaction_started' });
          sendToSocket(managed, { type: 'compaction_summary', summary: fullText });
          break;
        }
      }

      // Forward GAP-prefixed user messages to the UI (injected system/task messages)
      // Non-GAP user messages are already rendered locally by the input handler
      if (Array.isArray(userContent) && saUser.depth === 0) {
        let hasTextContent = false;
        for (const block of userContent) {
          if (block.type === 'text' && typeof block.text === 'string') {
            hasTextContent = true;
            const text = (block.text as string).replace(/^Human:\s*/i, '');
            if (/^\[GAP\//.test(text)) {
              sendToSocket(managed, { type: 'user_message_echo', content: text });
            }
          }
        }
        if (hasTextContent) {
          startCompactionTimer(managed);
        }
      }

      if (Array.isArray(userContent)) {
        for (const block of userContent) {
          if (block.type === 'tool_result') {
            cancelCompactionTimer(managed.sessionId);
            const toolUseId = block.tool_use_id as string;
            if (saUser.toolUseIds.has(toolUseId)) {
              saUser.depth = Math.max(0, saUser.depth - 1);
              saUser.toolUseIds.delete(toolUseId);
            } else if (saUser.depth > 0) {
              continue;
            }

            let resultText = '';
            const images: Array<{ media_type: string; data: string }> = [];
            const blockContent = block.content;
            if (typeof blockContent === 'string') {
              resultText = blockContent;
            } else if (Array.isArray(blockContent)) {
              resultText = blockContent
                .filter((b: Record<string, unknown>) => b.type === 'text')
                .map((b: Record<string, unknown>) => b.text)
                .join('\n');
              for (const b of blockContent) {
                const br = b as Record<string, unknown>;
                if (br.type === 'image' && br.source) {
                  const src = br.source as Record<string, unknown>;
                  if (src.type === 'base64' && src.data) {
                    images.push({ media_type: String(src.media_type || 'image/png'), data: String(src.data) });
                  }
                }
              }
            }
            sendToSocket(managed, { type: 'tool_result', toolUseId: block.tool_use_id, content: resultText, images: images.length > 0 ? images : undefined, isError: block.is_error || false });

            const origToolName = getToolNameForResult(managed.sessionId, toolUseId);
            if (origToolName) {
              trackMcpResult(managed.sessionId, origToolName, !!block.is_error, managed);
            }
          }
        }
      }
      break;
    }

    case 'result':
      cancelCompactionTimer(managed.sessionId);
      sendToSocket(managed, { type: 'result', result: event.result, sessionId: event.session_id || event.sessionId, cost: event.total_cost_usd, usage: event.usage });
      if (managed.sessionId) {
        const resultContent = event.result as Record<string, unknown> | undefined;
        const content = resultContent?.content as Array<Record<string, unknown>> | undefined;
        const resultText = Array.isArray(content)
          ? content.filter(b => b.type === 'text').map(b => b.text as string).join('\n')
          : '';
        taskEvents.emit(`session-result:${managed.sessionId}`, resultText);
      }
      break;
  }
}
