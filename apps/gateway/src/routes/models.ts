import { FastifyInstance } from 'fastify';
import { AVAILABLE_MODELS, DEFAULT_MODEL } from '../models.js';

export async function modelsRoutes(server: FastifyInstance) {
  server.get('/models', async () => {
    return { models: AVAILABLE_MODELS, default: DEFAULT_MODEL };
  });
}
