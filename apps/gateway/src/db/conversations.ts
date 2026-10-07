import { randomUUID } from 'crypto';
import db from './connection.js';
import type { Conversation, ConversationState } from './types.js';

export function createConversation(agentId: string, title?: string): Conversation {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO conversations (id, agent_id, title, state)
    VALUES (?, ?, ?, 'cold')
  `).run(id, agentId, title ?? null);
  return getConversation(id)!;
}

export function getConversation(id: string): Conversation | undefined {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | undefined;
}

export function getAgentConversation(agentId: string): Conversation | undefined {
  return db.prepare(
    `SELECT * FROM conversations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(agentId) as Conversation | undefined;
}

export function updateConversationState(id: string, state: ConversationState): Conversation | undefined {
  db.prepare(`
    UPDATE conversations SET state = ?, updated_at = datetime('now') WHERE id = ?
  `).run(state, id);
  return getConversation(id);
}

export function updateConversationSession(id: string, sessionId: string | null): Conversation | undefined {
  const state = sessionId ? 'dormant' : 'cold';
  db.prepare(`
    UPDATE conversations SET session_id = ?, state = ?, updated_at = datetime('now') WHERE id = ?
  `).run(sessionId, state, id);
  return getConversation(id);
}
