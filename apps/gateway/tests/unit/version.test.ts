import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../src/server.js';
import { FastifyInstance } from 'fastify';

describe('GET /version', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('returns the full version block', async () => {
    const response = await server.inject({ method: 'GET', url: '/version' });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(typeof body.version).toBe('string');
    expect(typeof body.git_sha).toBe('string');
    expect(typeof body.git_short).toBe('string');
    expect(typeof body.build_time).toBe('string');
    expect(typeof body.started_at).toBe('string');
    expect(typeof body.uptime_s).toBe('number');
    expect(typeof body.node_version).toBe('string');
    expect(typeof body.db_schema_version).toBe('number');
    expect(typeof body.dirty).toBe('boolean');

    // started_at and build_time should be ISO timestamps
    expect(new Date(body.started_at).toString()).not.toBe('Invalid Date');
    expect(new Date(body.build_time).toString()).not.toBe('Invalid Date');

    // node_version should start with 'v'
    expect(body.node_version.startsWith('v')).toBe(true);
  });

  it('includes the version block inside /api/status', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/status' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.version).toBeDefined();
    expect(typeof body.version.version).toBe('string');
    expect(typeof body.version.git_sha).toBe('string');
    expect(typeof body.version.uptime_s).toBe('number');
  });
});
