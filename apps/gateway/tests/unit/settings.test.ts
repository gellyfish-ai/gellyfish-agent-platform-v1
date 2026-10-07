import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../src/server.js';
import { FastifyInstance } from 'fastify';

describe('Settings API', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /api/settings/auto-approve returns default state', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/settings/auto-approve' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('enabled');
    expect(typeof body.enabled).toBe('boolean');
  });

  it('PUT /api/settings/auto-approve toggles the value', async () => {
    // Set to false
    const res1 = await server.inject({
      method: 'PUT',
      url: '/api/settings/auto-approve',
      payload: { enabled: false },
    });
    expect(res1.statusCode).toBe(200);
    expect(JSON.parse(res1.body).enabled).toBe(false);

    // Read back
    const res2 = await server.inject({ method: 'GET', url: '/api/settings/auto-approve' });
    expect(JSON.parse(res2.body).enabled).toBe(false);

    // Set back to true
    const res3 = await server.inject({
      method: 'PUT',
      url: '/api/settings/auto-approve',
      payload: { enabled: true },
    });
    expect(JSON.parse(res3.body).enabled).toBe(true);
  });
});
