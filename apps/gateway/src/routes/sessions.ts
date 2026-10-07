import { FastifyInstance } from 'fastify';
import { readdir, readFile, unlink } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import db, { getSessionTaskEvents, getReactions, getSummaries } from '../db/index.js';
import { destroySession, killSession, generateSummaryFromSession } from '../session-send.js';
import {
  getSessionsDirForCwd, getGatewaySessionsDir,
  getSessionFilePath, extractText, listSessionFiles, deleteSessionFile,
} from '../session-file.js';

interface SessionInfo {
  id: string;
  firstMessage: string;
  firstReply: string;
  lastMessage: string;
  lastActivity: string;
  messageCount: number;
  cwd?: string;
  profileId?: string;
  profileName?: string;
  profileIcon?: string;
  name?: string;
  formerProfileId?: string;
  formerProfileName?: string;
  formerProfileIcon?: string;
  formerProfileSeq?: number;
}

async function parseSessionFile(filePath: string): Promise<SessionInfo | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    if (lines.length === 0) return null;

    let firstUserMessage = '';
    let firstReply = '';
    let lastMessage = '';
    let lastTimestamp = '';
    let messageCount = 0;
    let cwd: string | undefined;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        if (entry.type === 'user' || entry.type === 'assistant') {
          messageCount++;

          if (entry.timestamp) {
            lastTimestamp = entry.timestamp;
          }

          if (entry.cwd && !cwd) {
            cwd = entry.cwd;
          }

          // Track last message from either side
          if (entry.message?.content) {
            const text = extractText(entry.message.content);
            if (text) lastMessage = text.slice(0, 200);
          }
        }

        // First user message
        if (entry.type === 'user' && !firstUserMessage && entry.message?.content) {
          const text = extractText(entry.message.content);
          if (text) firstUserMessage = text.slice(0, 200);
        }

        // First assistant reply (skip API errors)
        if (entry.type === 'assistant' && !firstReply && !entry.isApiErrorMessage && entry.message?.content) {
          const text = extractText(entry.message.content);
          if (text) firstReply = text.slice(0, 200);
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (messageCount === 0) return null;

    const id = filePath.split('/').pop()?.replace('.jsonl', '') || '';

    return {
      id,
      firstMessage: firstUserMessage || '(No message)',
      firstReply: firstReply || '',
      lastMessage: lastMessage || firstReply || '',
      lastActivity: lastTimestamp,
      messageCount,
      cwd,
    };
  } catch {
    return null;
  }
}

export async function sessionsRoutes(server: FastifyInstance) {
  // List sessions: gateway sessions + profile sessions
  server.get('/sessions', async (_request, reply) => {
    try {
      const sessions: SessionInfo[] = [];
      const seenIds = new Set<string>();

      // Helper to scan a sessions dir
      const scanDir = async (dir: string) => {
        let files: string[];
        try {
          files = await readdir(dir);
        } catch {
          return;
        }
        for (const file of files.filter(f => f.endsWith('.jsonl'))) {
          const id = file.replace('.jsonl', '');
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          const info = await parseSessionFile(join(dir, file));
          if (info) sessions.push(info);
        }
      };

      // Gateway sessions (non-profile)
      await scanDir(getGatewaySessionsDir());

      // Agent sessions (each agent's workspace)
      const agents = db.prepare("SELECT id, workspace_dir FROM agents WHERE workspace_dir != ''")
        .all() as Array<{ id: string; workspace_dir: string }>;
      for (const a of agents) {
        await scanDir(getSessionsDirForCwd(a.workspace_dir));
      }

      // Enrich with profile data from SQLite
      const sessionIds = sessions.map(s => s.id);
      if (sessionIds.length > 0) {
        const placeholders = sessionIds.map(() => '?').join(',');
        const rows = db.prepare(`
          SELECT c.session_id, p.id as profile_id, p.name as profile_name, p.icon as profile_icon
          FROM conversations c
          JOIN agents a ON a.id = c.agent_id
          JOIN profiles p ON p.id = a.profile_id
          WHERE c.session_id IN (${placeholders})
        `).all(...sessionIds) as Array<{ session_id: string; profile_id: string; profile_name: string; profile_icon: string }>;

        const profileMap = new Map(rows.map(r => [r.session_id, r]));
        for (const session of sessions) {
          const p = profileMap.get(session.id);
          if (p) {
            session.profileId = p.profile_id;
            session.profileName = p.profile_name;
            session.profileIcon = p.profile_icon;
          }
        }
      }

      // Enrich with session metadata (names, former profiles)
      if (sessionIds.length > 0) {
        const metaPlaceholders = sessionIds.map(() => '?').join(',');
        const metaRows = db.prepare(`
          SELECT sm.session_id, sm.name, sm.former_profile_id, sm.former_profile_seq,
                 p.name as former_profile_name, p.icon as former_profile_icon
          FROM session_metadata sm
          LEFT JOIN profiles p ON p.id = sm.former_profile_id
          WHERE sm.session_id IN (${metaPlaceholders})
        `).all(...sessionIds) as Array<{
          session_id: string; name: string;
          former_profile_id: string | null; former_profile_seq: number;
          former_profile_name: string | null; former_profile_icon: string | null;
        }>;

        const metaMap = new Map(metaRows.map(r => [r.session_id, r]));
        for (const session of sessions) {
          const m = metaMap.get(session.id);
          if (m) {
            session.name = m.name || undefined;
            if (m.former_profile_id) {
              session.formerProfileId = m.former_profile_id;
              session.formerProfileName = m.former_profile_name || undefined;
              session.formerProfileIcon = m.former_profile_icon || undefined;
              session.formerProfileSeq = m.former_profile_seq || undefined;
            }
          }
        }
      }

      // Sort by last activity, most recent first
      sessions.sort((a, b) => {
        if (!a.lastActivity) return 1;
        if (!b.lastActivity) return -1;
        return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
      });

      return { sessions };
    } catch (error: unknown) {
      server.log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Failed to list sessions');
      reply.status(500);
      return { error: 'Failed to list sessions' };
    }
  });

  // Get a specific session's details
  server.get<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const filePath = getSessionFilePath(id);

      const info = await parseSessionFile(filePath);
      if (!info) {
        reply.status(404);
        return { error: 'Session not found' };
      }

      // Look up agent for this session
      const agentRow = db.prepare(`
        SELECT a.id, a.name, a.profile_id, p.icon as profile_icon, p.name as profile_name,
          c.id as conversation_id, c.state as conversation_state, c.issue_number
        FROM conversations c
        JOIN agents a ON a.id = c.agent_id
        JOIN profiles p ON p.id = a.profile_id
        WHERE c.session_id = ?
        LIMIT 1
      `).get(id) as { id: string; name: string; profile_id: string; profile_icon: string; profile_name: string; conversation_id: string; conversation_state: string; issue_number: number | null } | undefined;

      return {
        session: info,
        agent: agentRow ? {
          id: agentRow.id,
          name: agentRow.name,
          profile_id: agentRow.profile_id,
          profile_icon: agentRow.profile_icon,
          conversation_id: agentRow.conversation_id,
          conversation_state: agentRow.conversation_state,
          issue_number: agentRow.issue_number,
        } : null,
      };
    } catch (error) {
      server.log.error({ error }, 'Failed to get session');
      reply.status(500);
      return { error: 'Failed to get session' };
    }
  });

  // Stop a session's process (without deleting the session)
  server.post<{ Params: { id: string } }>('/sessions/:id/stop', async (request, reply) => {
    const { id } = request.params;
    const killed = killSession(id);
    if (!killed) {
      reply.status(404);
      return { error: 'No active process for this session' };
    }
    return { ok: true };
  });

  // Delete a session
  server.delete<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
        reply.status(400);
        return { error: 'Invalid session ID' };
      }

      await destroySession(id);
      return { ok: true };
    } catch (error: unknown) {
      server.log.error({ error }, 'Failed to delete session');
      reply.status(500);
      return { error: 'Failed to delete session' };
    }
  });

  // Get session history (messages, tool calls, tool results)
  // Supports ?limit=N to load only the last N entries, and returns hasMore flag
  server.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/sessions/:id/history', async (request, reply) => {
    try {
      const { id } = request.params;
      const filePath = getSessionFilePath(id);
      const content = await readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim());

      interface HistoryEntry {
        type: 'message' | 'tool_use' | 'tool_result';
        role?: string;
        content?: string;
        timestamp?: string;
        toolName?: string;
        toolUseId?: string;
        input?: unknown;
        isError?: boolean;
      }

      const entries: HistoryEntry[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          if (entry.type === 'assistant' && entry.message?.content) {
            const blocks = entry.message.content;
            if (Array.isArray(blocks)) {
              // Extract text blocks as a message
              const text = blocks
                .filter((b: { type: string }) => b.type === 'text')
                .map((b: { text: string }) => b.text)
                .join('\n');
              if (text) {
                entries.push({
                  type: 'message',
                  role: 'assistant',
                  content: text,
                  timestamp: entry.timestamp || '',
                });
              }

              // Extract tool_use blocks
              for (const block of blocks) {
                if (block.type === 'tool_use') {
                  entries.push({
                    type: 'tool_use',
                    toolName: block.name,
                    toolUseId: block.id,
                    input: block.input,
                    timestamp: entry.timestamp || '',
                  });
                }
              }
            }
          } else if (entry.type === 'user' && entry.message?.content) {
            const blocks = entry.message.content;

            if (typeof blocks === 'string') {
              entries.push({
                type: 'message',
                role: 'user',
                content: blocks,
                timestamp: entry.timestamp || '',
              });
            } else if (Array.isArray(blocks)) {
              // Check for user text
              const text = extractText(blocks);
              if (text) {
                entries.push({
                  type: 'message',
                  role: 'user',
                  content: text,
                  timestamp: entry.timestamp || '',
                });
              }

              // Extract tool_result blocks
              for (const block of blocks) {
                if (block.type === 'tool_result') {
                  let resultText = '';
                  if (typeof block.content === 'string') {
                    resultText = block.content;
                  } else if (Array.isArray(block.content)) {
                    resultText = block.content
                      .filter((b: { type: string }) => b.type === 'text')
                      .map((b: { text: string }) => b.text)
                      .join('\n');
                  }
                  entries.push({
                    type: 'tool_result',
                    toolUseId: block.tool_use_id,
                    content: resultText,
                    isError: block.is_error || false,
                    timestamp: entry.timestamp || '',
                  });
                }
              }
            }
          }
        } catch {
          // Skip malformed lines
        }
      }

      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 0;
      if (limit > 0 && entries.length > limit) {
        const trimmed = entries.slice(entries.length - limit);
        return { entries: trimmed, hasMore: true, total: entries.length };
      }

      return { entries, hasMore: false, total: entries.length };
    } catch (error) {
      server.log.error({ error }, 'Failed to get session history');
      reply.status(500);
      return { error: 'Failed to get session history' };
    }
  });

  // Get unified timeline: history entries + task events merged by timestamp
  server.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/sessions/:id/timeline', async (request, reply) => {
    try {
      const { id } = request.params;

      const COMPACTION_PREFIX = 'This session is being continued from a previous conversation that ran out of context';

      // Parse .jsonl history
      interface TimelineEntry {
        type: string;
        id?: string;  // Stable message ID (uuid from .jsonl, task-{id}, etc.)
        role?: string;
        content?: string | unknown[];
        timestamp: string;
        toolName?: string;
        toolUseId?: string;
        input?: unknown;
        isError?: boolean;
        images?: Array<{ media_type: string; data: string }>;
        summary?: string;
        // Task event fields
        taskId?: string;
        data?: Record<string, unknown>;
        eventType?: string;
      }

      const entries: TimelineEntry[] = [];

      // 1. Load .jsonl history
      try {
        const filePath = getSessionFilePath(id);
        const content = await readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const ts = entry.timestamp || '';
            const msgId = entry.uuid || entry.message?.id || `msg-${entries.length}`;

            if (entry.type === 'assistant' && entry.message?.content) {
              const blocks = entry.message.content;
              if (Array.isArray(blocks)) {
                const text = blocks.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('\n');
                if (text) entries.push({ type: 'message', id: msgId, role: 'assistant', content: text, timestamp: ts });
                for (const block of blocks) {
                  if (block.type === 'tool_use') {
                    entries.push({ type: 'tool_use', toolName: block.name, toolUseId: block.id, input: block.input, timestamp: ts });
                  }
                }
              }
            } else if (entry.type === 'user' && entry.message?.content) {
              const blocks = entry.message.content;
              if (typeof blocks === 'string') {
                const stripped = blocks.replace(/^Human:\s*/i, '');
                if (stripped.startsWith(COMPACTION_PREFIX)) {
                  entries.push({ type: 'compaction_summary', id: msgId, summary: stripped, timestamp: ts });
                } else {
                  entries.push({ type: 'message', id: msgId, role: 'user', content: blocks, timestamp: ts });
                }
              } else if (Array.isArray(blocks)) {
                // Check for image blocks — pass full content array to preserve images
                const hasImages = blocks.some((b: { type: string }) => b.type === 'image');
                if (hasImages) {
                  entries.push({ type: 'message', id: msgId, role: 'user', content: blocks, timestamp: ts });
                } else {
                  const text = extractText(blocks).replace(/^Human:\s*/i, '');
                  if (text.startsWith(COMPACTION_PREFIX)) {
                    entries.push({ type: 'compaction_summary', id: msgId, summary: text, timestamp: ts });
                  } else if (text) {
                    entries.push({ type: 'message', id: msgId, role: 'user', content: text, timestamp: ts });
                  }
                }
                for (const block of blocks) {
                  if (block.type === 'tool_result') {
                    let resultText = '';
                    const images: Array<{ media_type: string; data: string }> = [];
                    if (typeof block.content === 'string') {
                      resultText = block.content;
                    } else if (Array.isArray(block.content)) {
                      resultText = block.content.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('\n');
                      for (const b of block.content) {
                        if (b.type === 'image' && b.source?.type === 'base64' && b.source?.data) {
                          images.push({ media_type: b.source.media_type || 'image/png', data: b.source.data });
                        }
                      }
                    }
                    entries.push({ type: 'tool_result', toolUseId: block.tool_use_id, content: resultText, images: images.length > 0 ? images : undefined, isError: block.is_error || false, timestamp: ts });
                  }
                }
              }
            }
          } catch { /* skip malformed */ }
        }
      } catch {
        // No .jsonl file — only task events
      }

      // 2. Load task events from DB
      const taskEvents = getSessionTaskEvents(id);
      for (const te of taskEvents) {
        const data = JSON.parse(te.data);
        entries.push({
          type: te.event_type, // 'task_update' or 'task_progress'
          id: `task-${te.task_id}`,
          timestamp: new Date(te.created_at + 'Z').toISOString(),
          taskId: te.task_id,
          data,
          eventType: te.event_type,
        });
      }

      // 3. Sort by timestamp
      entries.sort((a, b) => {
        if (!a.timestamp) return -1;
        if (!b.timestamp) return 1;
        return a.timestamp.localeCompare(b.timestamp);
      });

      // 4. Paginate
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 0;
      if (limit > 0 && entries.length > limit) {
        const trimmed = entries.slice(entries.length - limit);
        return { entries: trimmed, hasMore: true, total: entries.length };
      }

      return { entries, hasMore: false, total: entries.length };
    } catch (error) {
      server.log.error({ error }, 'Failed to get timeline');
      reply.status(500);
      return { error: 'Failed to get timeline' };
    }
  });

  // Get task events for a session (kept for backward compat)
  server.get<{ Params: { id: string } }>('/sessions/:id/task-events', async (request) => {
    const events = getSessionTaskEvents(request.params.id);
    return {
      events: events.map(e => ({
        ...e,
        data: JSON.parse(e.data),
      })),
    };
  });

  // Get reactions for a session
  server.get<{ Params: { id: string } }>('/sessions/:id/reactions', async (request) => {
    return { reactions: getReactions(request.params.id) };
  });

  // GET /api/conversations/:id/summaries — conversation summary history
  server.get<{ Params: { id: string } }>('/conversations/:id/summaries', async (request) => {
    return { summaries: getSummaries(request.params.id) };
  });

  // Input history (for arrow up/down message recall)
  server.get('/input-history', async () => {
    const rows = db.prepare(
      'SELECT message FROM input_history ORDER BY id DESC LIMIT 100'
    ).all() as Array<{ message: string }>;
    return { messages: rows.map(r => r.message) };
  });

  server.post<{ Body: { message: string } }>('/input-history', async (request, reply) => {
    const { message } = request.body || {};
    if (!message?.trim()) {
      reply.status(400);
      return { error: 'Missing message' };
    }

    // Don't duplicate consecutive entries
    const last = db.prepare(
      'SELECT message FROM input_history ORDER BY id DESC LIMIT 1'
    ).get() as { message: string } | undefined;

    if (last?.message !== message) {
      db.prepare('INSERT INTO input_history (message) VALUES (?)').run(message);

      // Keep only last 100
      db.prepare(`
        DELETE FROM input_history WHERE id NOT IN (
          SELECT id FROM input_history ORDER BY id DESC LIMIT 100
        )
      `).run();
    }

    return { ok: true };
  });

  // Set/update session name
  server.put<{ Params: { id: string }; Body: { name: string } }>('/sessions/:id/name', async (request, reply) => {
    const { id } = request.params;
    const { name } = request.body || {};
    if (typeof name !== 'string') {
      reply.status(400);
      return { error: 'Name is required' };
    }

    db.prepare(`
      INSERT INTO session_metadata (session_id, name)
      VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET name = excluded.name
    `).run(id, name);

    return { ok: true };
  });

  // Legacy session-profile linking removed in Phase 5. Use agents/conversations.
  server.put<{ Params: { id: string } }>('/sessions/:id/profile', async (_request, reply) => {
    return reply.status(410).send({ error: 'Removed — use agents/conversations' });
  });
  server.delete<{ Params: { id: string } }>('/sessions/:id/profile', async (_request, reply) => {
    return reply.status(410).send({ error: 'Removed — use agents/conversations' });
  });

  // Draft autosave
  server.get('/input-draft', async () => {
    const row = db.prepare('SELECT message FROM input_draft WHERE id = 1').get() as { message: string } | undefined;
    return { draft: row?.message || '' };
  });

  server.put<{ Body: { message: string } }>('/input-draft', async (request) => {
    const message = request.body?.message ?? '';
    db.prepare('UPDATE input_draft SET message = ?, updated_at = datetime(\'now\') WHERE id = 1').run(message);
    return { ok: true };
  });

  // List all .jsonl session files for a conversation's agent workspace
  server.get<{ Params: { id: string } }>('/conversations/:id/session-files', async (request, reply) => {
    const { id } = request.params;
    const conv = db.prepare(`
      SELECT c.id, c.session_id
      FROM conversations c
      WHERE c.id = ?
    `).get(id) as { id: string; session_id: string | null } | undefined;

    if (!conv) {
      reply.status(404);
      return { error: 'Conversation not found' };
    }

    const files = listSessionFiles(conv.id);

    // Enrich with DB info (which session is currently active)
    return {
      conversationId: conv.id,
      activeSessionId: conv.session_id,
      sessions: files.map(f => ({
        ...f,
        active: f.sessionId === conv.session_id,
        sizeMB: (f.size / (1024 * 1024)).toFixed(2),
      })),
    };
  });

  // Preview the tail of a session's .jsonl file
  server.get<{ Params: { sessionId: string } }>('/sessions/:sessionId/preview', async (request, reply) => {
    try {
      const { sessionId } = request.params;
      const filePath = getSessionFilePath(sessionId);

      if (!existsSync(filePath)) {
        reply.status(404);
        return { error: 'Session file not found' };
      }

      const content = await readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim());
      const tail = lines.slice(-20);

      const messages: Array<{ role: string; text: string }> = [];
      for (const line of tail) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message?.content) {
            const text = extractText(entry.message.content);
            if (text) messages.push({ role: 'user', text: text.slice(0, 500) });
          } else if (entry.type === 'assistant' && entry.message?.content) {
            const text = extractText(entry.message.content);
            if (text) messages.push({ role: 'assistant', text: text.slice(0, 500) });
          }
        } catch { /* skip malformed */ }
      }

      return { messages };
    } catch (error) {
      server.log.error({ error }, 'Failed to get session preview');
      reply.status(500);
      return { error: 'Failed to get session preview' };
    }
  });

  // Switch a conversation to a different session (kill current process, update DB)
  server.post<{ Params: { id: string }; Body: { sessionId: string } }>('/conversations/:id/switch-session', async (request, reply) => {
    const { id } = request.params;
    const { sessionId } = request.body;

    if (!sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }

    const conv = db.prepare(`
      SELECT c.id, c.session_id, c.agent_id
      FROM conversations c
      WHERE c.id = ?
    `).get(id) as { id: string; session_id: string | null; agent_id: string } | undefined;

    if (!conv) {
      reply.status(404);
      return { error: 'Conversation not found' };
    }

    // Verify the session file exists
    const agentFiles = listSessionFiles(conv.id);
    const exists = agentFiles.some(f => f.sessionId === sessionId);
    if (!exists) {
      reply.status(404);
      return { error: 'Session file not found' };
    }

    // Kill the current process if running
    if (conv.session_id) {
      try {
        await killSession(conv.session_id);
      } catch { /* process may not be running */ }
    }

    // Update conversation to point to the new session
    db.prepare(`
      UPDATE conversations SET session_id = ?, state = 'dormant', updated_at = datetime('now')
      WHERE id = ?
    `).run(sessionId, conv.id);

    return { ok: true, conversationId: conv.id, sessionId };
  });

  // Recover a conversation by linking it to a session file (works even when session_id is null)
  server.post<{ Params: { id: string }; Body: { sessionId: string } }>('/conversations/:id/recover-session', async (request, reply) => {
    const { id } = request.params;
    const { sessionId } = request.body;

    if (!sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }

    const conv = db.prepare(`
      SELECT c.id FROM conversations c WHERE c.id = ?
    `).get(id) as { id: string } | undefined;

    if (!conv) {
      reply.status(404);
      return { error: 'Conversation not found' };
    }

    // Verify the session file exists
    const files = listSessionFiles(conv.id);
    const exists = files.some(f => f.sessionId === sessionId);
    if (!exists) {
      reply.status(404);
      return { error: 'Session file not found' };
    }

    db.prepare(`
      UPDATE conversations SET session_id = ?, state = 'dormant', updated_at = datetime('now')
      WHERE id = ?
    `).run(sessionId, id);

    return { ok: true, conversationId: id, sessionId };
  });

  // Compact a session: generate LLM summary then delete the .jsonl file
  server.post<{ Params: { id: string }; Body: { sessionId: string } }>('/conversations/:id/compact-session', async (request, reply) => {
    const { id } = request.params;
    const { sessionId } = request.body;

    if (!sessionId) {
      reply.status(400);
      return { error: 'sessionId is required' };
    }

    const conv = db.prepare(`
      SELECT c.id FROM conversations c WHERE c.id = ?
    `).get(id) as { id: string } | undefined;

    if (!conv) {
      reply.status(404);
      return { error: 'Conversation not found' };
    }

    const filePath = getSessionFilePath(sessionId);
    if (!existsSync(filePath)) {
      reply.status(404);
      return { error: 'Session file not found' };
    }

    // Read content before deleting
    let fileContent: string;
    try {
      fileContent = readFileSync(filePath, 'utf-8');
    } catch {
      reply.status(500);
      return { error: 'Failed to read session file' };
    }

    deleteSessionFile(sessionId);

    // If this session was linked to the conversation, unlink it
    db.prepare(`
      UPDATE conversations SET session_id = NULL, state = 'cold', updated_at = datetime('now')
      WHERE id = ? AND session_id = ?
    `).run(id, sessionId);

    // Generate summary in background (fire-and-forget)
    generateSummaryFromSession(id, sessionId, undefined, fileContent)
      .catch(err => server.log.error({ err }, 'Failed to generate compact summary'));

    return { ok: true };
  });

}
