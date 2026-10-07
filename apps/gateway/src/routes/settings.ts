import { FastifyInstance } from 'fastify';
import { getSetting, setSetting } from '../db/index.js';

export async function settingsRoutes(server: FastifyInstance) {
  // GET /api/settings/auto-approve
  server.get('/settings/auto-approve', async () => {
    const value = getSetting('auto_approve') ?? 'true';
    return { enabled: value === 'true' };
  });

  // PUT /api/settings/auto-approve
  server.put<{ Body: { enabled: boolean } }>('/settings/auto-approve', async (req) => {
    const enabled = req.body.enabled;
    setSetting('auto_approve', enabled ? 'true' : 'false');
    return { enabled };
  });
}
