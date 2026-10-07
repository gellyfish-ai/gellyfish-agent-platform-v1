import db from './connection.js';

export function upsertReaction(sessionId: string, messageId: string, emoji: string, preview?: string): void {
  db.prepare(`
    INSERT INTO message_reactions (id, session_id, message_id, emoji, message_preview)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
    ON CONFLICT(session_id, message_id) DO UPDATE SET
      emoji = excluded.emoji,
      message_preview = excluded.message_preview,
      updated_at = datetime('now')
  `).run(sessionId, messageId, emoji, preview ?? null);
}

export function removeReaction(sessionId: string, messageId: string): void {
  db.prepare('DELETE FROM message_reactions WHERE session_id = ? AND message_id = ?').run(sessionId, messageId);
}

export function getReactions(sessionId: string): Array<{ message_id: string; emoji: string; updated_at: string }> {
  return db.prepare(`
    SELECT message_id, emoji, updated_at FROM message_reactions
    WHERE session_id = ? ORDER BY created_at
  `).all(sessionId) as Array<{ message_id: string; emoji: string; updated_at: string }>;
}
