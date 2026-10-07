import { FastifyInstance } from 'fastify';
import { sendStatusPush } from '../apns/index.js';

export async function pushRoutes(server: FastifyInstance) {
  // POST /api/push — send a push notification to all registered devices
  server.post<{
    Body: { title: string; body: string; category?: string; data?: Record<string, unknown> };
  }>('/push', async (req, reply) => {
    const { title, body, category, data } = req.body;
    if (!title || !body) {
      return reply.status(400).send({ error: 'title and body are required' });
    }
    // Approval pushes must go through the approval system, not this endpoint
    if (category === 'approval') {
      return reply.status(403).send({ error: 'Approval pushes must go through the approval system' });
    }
    await sendStatusPush(title, body, data);
    return { ok: true };
  });
}
