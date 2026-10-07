import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../src/server.js';
import { FastifyInstance } from 'fastify';

describe('Gateway Server', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  describe('GET /health', () => {
    it('returns ok status', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('GET /ready', () => {
    it('returns ready status', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ready');
    });
  });

  describe('POST /api/command', () => {
    it('accepts a valid command', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/command',
        payload: {
          source: 'api',
          user_id: 'test-user',
          command: 'send a test message',
        },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('received');
      expect(body.id).toBeDefined();
    });
  });

  describe('GET /api/command/:id', () => {
    it('returns 404 for unknown command', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/command/unknown-id',
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
