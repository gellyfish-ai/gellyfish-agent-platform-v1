import { FastifyInstance } from 'fastify';
import db, {
  Conversation, ConversationState,
  getConversation, getAgentConversation,
  updateConversationState, updateConversationSession,
} from '../db/index.js';
import { destroySession } from '../session-send.js';

export async function conversationsRoutes(server: FastifyInstance) {
  // GET /api/conversations — list conversations
  server.get<{
    Querystring: { agentId?: string; state?: ConversationState };
  }>('/conversations', async (req) => {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (req.query.agentId) {
      conditions.push('c.agent_id = ?');
      params.push(req.query.agentId);
    }
    if (req.query.state) {
      conditions.push('c.state = ?');
      params.push(req.query.state);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const conversations = db.prepare(`
      SELECT c.*, a.name as agent_name, a.state as agent_state, a.profile_id,
        p.name as profile_name, p.icon as profile_icon
      FROM conversations c
      JOIN agents a ON a.id = c.agent_id
      JOIN profiles p ON p.id = a.profile_id
      ${where}
      ORDER BY c.updated_at DESC
    `).all(...params) as (Conversation & { agent_name: string; agent_state: string; profile_id: string; profile_name: string; profile_icon: string })[];

    return { conversations };
  });

  // GET /api/conversations/:id — get conversation detail
  server.get<{ Params: { id: string } }>('/conversations/:id', async (req, reply) => {
    const conversation = db.prepare(`
      SELECT c.*, a.name as agent_name, a.state as agent_state, a.profile_id,
        p.name as profile_name, p.icon as profile_icon
      FROM conversations c
      JOIN agents a ON a.id = c.agent_id
      JOIN profiles p ON p.id = a.profile_id
      WHERE c.id = ?
    `).get(req.params.id) as (Conversation & { agent_name: string; agent_state: string; profile_id: string; profile_name: string; profile_icon: string }) | undefined;

    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });
    return { conversation };
  });

  // PUT /api/conversations/:id — update title, issue_number
  server.put<{
    Params: { id: string };
    Body: { title?: string; issue_number?: number | null };
  }>('/conversations/:id', async (req, reply) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });

    const sets: string[] = ["updated_at = datetime('now')"];
    const params: unknown[] = [];

    if (req.body.title !== undefined) {
      sets.push('title = ?');
      params.push(req.body.title);
    }
    if (req.body.issue_number !== undefined) {
      sets.push('issue_number = ?');
      params.push(req.body.issue_number);
    }

    params.push(conversation.id);
    db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    return { conversation: getConversation(conversation.id) };
  });

  // DELETE /api/conversations/:id — delete conversation
  server.delete<{ Params: { id: string } }>('/conversations/:id', async (req, reply) => {
    const conv = db.prepare('SELECT id, session_id FROM conversations WHERE id = ?')
      .get(req.params.id) as { id: string; session_id: string | null } | undefined;

    if (!conv) return reply.status(404).send({ error: 'Conversation not found' });

    if (conv.session_id) {
      await destroySession(conv.session_id);
    }

    db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
    return { ok: true };
  });
}
