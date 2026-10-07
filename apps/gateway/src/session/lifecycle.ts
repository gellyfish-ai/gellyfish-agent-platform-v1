import { readFileSync, existsSync } from 'fs';
import db, { updateConversationState, updateAgentState, insertSummary } from '../db/index.js';
import { pmClient } from '../pm-client.js';
import { logger } from '../logger.js';
import { getSessionFilePath, extractText, deleteSessionFile } from '../session-file.js';
import Anthropic from '@anthropic-ai/sdk';
import type { ManagedProcess } from './types.js';
import { getActiveProcess, unregisterProcess } from './registry.js';

export async function killSession(sessionId: string): Promise<boolean> {
  const managed = getActiveProcess(sessionId);
  if (!managed) return false;

  if (managed.conversationId) {
    updateConversationState(managed.conversationId, 'dormant');
  }
  if (managed.agentId) {
    updateAgentState(managed.agentId, 'idle');
  }
  // Clear confirmed_model — will be re-set on next spawn's init event
  if (managed.profileId) {
    db.prepare('UPDATE profiles SET confirmed_model = NULL WHERE id = ?').run(managed.profileId);
  }

  try {
    await pmClient.kill(sessionId);
  } catch { /* PM may already have cleaned it up */ }
  unregisterProcess(sessionId);
  return true;
}

export async function destroySession(sessionId: string, profileId?: string): Promise<void> {
  await killSession(sessionId);

  const conv = db.prepare('SELECT id FROM conversations WHERE session_id = ?')
    .get(sessionId) as { id: string } | undefined;

  let fileContent: string | undefined;
  if (conv) {
    try {
      const filePath = getSessionFilePath(sessionId, profileId);
      if (filePath && existsSync(filePath)) {
        fileContent = readFileSync(filePath, 'utf-8');
      }
    } catch { /* file may not exist */ }
  }

  deleteSessionFile(sessionId, profileId);

  db.prepare(`UPDATE conversations SET session_id = NULL, state = 'cold', updated_at = datetime('now') WHERE session_id = ?`)
    .run(sessionId);

  if (conv && fileContent) {
    generateSummaryFromSession(conv.id, sessionId, profileId, fileContent)
      .catch(err => logger.error({ sessionId, error: String(err) }, '[summary] async summary generation failed'));
  }
}

// --- Conversation summary generation ---

function parseSessionMessages(content: string): {
  messages: Array<{ role: string; text: string }>;
  messageCount: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
} {
  const lines = content.trim().split('\n').filter(l => l.trim());
  const messages: Array<{ role: string; text: string }> = [];
  let messageCount = 0;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      messageCount++;

      if (entry.timestamp) {
        if (!firstTimestamp) firstTimestamp = entry.timestamp;
        lastTimestamp = entry.timestamp;
      }

      if (entry.type === 'assistant' && !entry.isApiErrorMessage && entry.message?.content) {
        const text = extractText(entry.message.content);
        if (text) messages.push({ role: 'assistant', text });
      } else if (entry.type === 'user' && entry.message?.content) {
        const text = extractText(entry.message.content);
        if (text) messages.push({ role: 'user', text });
      }
    } catch { /* skip malformed lines */ }
  }

  return { messages, messageCount, firstTimestamp, lastTimestamp };
}

function sampleMessages(messages: Array<{ role: string; text: string }>): Array<{ role: string; text: string }> {
  if (messages.length <= 100) return messages;

  const KEY_TERMS = /\b(error|decision|fix|ship|merge|bug|deploy|pr|issue|commit|break|revert)\b/i;
  const first20 = messages.slice(0, 20);
  const last50 = messages.slice(-50);
  const lastStartIdx = messages.length - 50;

  const middle: Array<{ role: string; text: string }> = [];
  for (let i = 20; i < lastStartIdx; i++) {
    if (KEY_TERMS.test(messages[i].text)) {
      middle.push(messages[i]);
    }
  }

  const seen = new Set<string>();
  const result: Array<{ role: string; text: string }> = [];
  for (const m of [...first20, ...middle, ...last50]) {
    const key = m.role + ':' + m.text.slice(0, 100);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(m);
    }
  }
  return result;
}

function buildFallbackSummary(messages: Array<{ role: string; text: string }>): string {
  const tail = messages.slice(-10);
  if (tail.length === 0) return '(No messages captured)';
  const parts = tail.map(e => {
    const prefix = e.role === 'user' ? 'User: ' : 'Assistant: ';
    const truncated = e.text.length > 500 ? e.text.substring(0, 500) + '...' : e.text;
    return prefix + truncated;
  });
  let summary = parts.join('\n\n');
  if (summary.length > 4000) {
    summary = summary.substring(summary.length - 4000);
    const firstPrefix = summary.indexOf('\n\nUser: ');
    const firstAssistant = summary.indexOf('\n\nAssistant: ');
    const cutPoint = Math.min(
      firstPrefix >= 0 ? firstPrefix + 2 : Infinity,
      firstAssistant >= 0 ? firstAssistant + 2 : Infinity,
    );
    if (cutPoint !== Infinity) summary = summary.substring(cutPoint);
  }
  return summary;
}

export async function generateSummaryFromSession(
  conversationId: string,
  sessionId: string,
  profileId?: string,
  preReadContent?: string,
): Promise<void> {
  try {
    let content: string;
    if (preReadContent) {
      content = preReadContent;
    } else {
      const filePath = getSessionFilePath(sessionId, profileId);
      if (!filePath || !existsSync(filePath)) {
        logger.warn({ sessionId, conversationId }, '[summary] session file not found — skipping summary');
        return;
      }
      content = readFileSync(filePath, 'utf-8');
    }

    const { messages, messageCount, firstTimestamp, lastTimestamp } = parseSessionMessages(content);
    if (messageCount === 0) return;

    const existing = db.prepare(
      'SELECT id FROM conversation_summaries WHERE conversation_id = ? AND session_id = ?'
    ).get(conversationId, sessionId);
    if (existing) return;

    let summary: string;
    const apiKey = process.env.ANTHROPIC_ADMIN_API_KEY;

    if (apiKey && messages.length > 0) {
      try {
        const sampled = sampleMessages(messages);
        const transcript = sampled.map(m => {
          const truncated = m.text.length > 800 ? m.text.substring(0, 800) + '...' : m.text;
          return `${m.role === 'user' ? 'User' : 'Assistant'}: ${truncated}`;
        }).join('\n\n');

        const client = new Anthropic({ apiKey });
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: `Summarize this agent work session concisely. Cover:\n1. What was accomplished (features shipped, bugs fixed, PRs merged)\n2. Key decisions made\n3. Mistakes or corrections\n4. Open items / unfinished work\n\nKeep it under 2000 characters. Use markdown. Be specific — include issue numbers, file names, and concrete details.\n\n<transcript>\n${transcript}\n</transcript>`,
          }],
        });

        const textBlock = response.content.find(b => b.type === 'text');
        summary = textBlock ? textBlock.text : buildFallbackSummary(messages);
        logger.info({ conversationId, sessionId }, '[summary] LLM summary generated');
      } catch (llmErr) {
        logger.error({ conversationId, sessionId, error: String(llmErr) }, '[summary] LLM call failed — falling back to raw transcript');
        summary = buildFallbackSummary(messages);
      }
    } else {
      summary = buildFallbackSummary(messages);
    }

    insertSummary({
      conversationId,
      sessionId,
      summary,
      startedAt: firstTimestamp,
      endedAt: lastTimestamp,
      messageCount,
    });

    logger.info({ conversationId, sessionId, messageCount }, '[summary] stored conversation summary');
  } catch (err) {
    logger.error({ conversationId, sessionId, error: String(err) }, '[summary] failed to generate summary');
  }
}
