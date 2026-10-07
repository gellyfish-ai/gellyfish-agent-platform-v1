import crypto from 'crypto';
import db from './connection.js';
import type { ConversationSummary } from './types.js';

export function insertSummary(opts: {
  conversationId: string;
  sessionId?: string;
  summary: string;
  startedAt?: string;
  endedAt?: string;
  messageCount?: number;
}): ConversationSummary {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO conversation_summaries (id, conversation_id, session_id, summary, started_at, ended_at, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, opts.conversationId, opts.sessionId || null, opts.summary, opts.startedAt || null, opts.endedAt || null, opts.messageCount || 0);
  return db.prepare('SELECT * FROM conversation_summaries WHERE id = ?').get(id) as ConversationSummary;
}

export function getSummaries(conversationId: string): ConversationSummary[] {
  return db.prepare(`
    SELECT * FROM conversation_summaries WHERE conversation_id = ? ORDER BY created_at
  `).all(conversationId) as ConversationSummary[];
}
