import { FastifyInstance } from 'fastify';
import { getRecentApiErrors } from '../api-errors.js';

export async function healthRoutes(server: FastifyInstance) {
  server.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  server.get('/ready', async () => {
    // TODO: check dependencies (database, external services)
    return { status: 'ready' };
  });

  server.get('/health/api-errors', async () => {
    return getRecentApiErrors();
  });
}
