import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer } from '../../src/server.js';
import type { FastifyInstance } from 'fastify';
import { getDevices } from '../../src/db/devices.js';
import db from '../../src/db/index.js';

function mockFetchResponse(body: { ok: boolean; status?: number; text?: string }) {
  return vi.fn(async () => ({
    ok: body.ok,
    status: body.status ?? (body.ok ? 200 : 500),
    text: async () => body.text ?? '',
    json: async () => ({}),
  }) as unknown as Response);
}

async function initiatePair(server: FastifyInstance, name = 'iPhone-test'): Promise<string> {
  const resp = await server.inject({
    method: 'POST',
    url: '/api/devices/pair',
    payload: { public_key: 'AAAA', device_token: 'token-' + name, device_name: name },
  });
  expect(resp.statusCode).toBe(200);
  return JSON.parse(resp.body).code as string;
}

describe('POST /api/devices/pair/confirm — vault relay fails loud', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    // Clear paired_devices so every case starts from a clean slate.
    db.prepare('DELETE FROM paired_devices').run();
  });

  it('returns 502 and rolls back when vault responds 500', async () => {
    vi.stubGlobal('fetch', mockFetchResponse({ ok: false, status: 500, text: 'vault boom' }));
    const code = await initiatePair(server, 'iPhone-500');

    const resp = await server.inject({
      method: 'POST',
      url: '/api/devices/pair/confirm',
      payload: { code },
    });

    expect(resp.statusCode).toBe(502);
    const body = JSON.parse(resp.body);
    expect(body.error).toContain('vault sync rejected');
    expect(body.vault_status).toBe(500);
    expect(getDevices()).toHaveLength(0);
  });

  it('returns 502 and rolls back when vault responds 400', async () => {
    vi.stubGlobal('fetch', mockFetchResponse({ ok: false, status: 400, text: 'bad request' }));
    const code = await initiatePair(server, 'iPhone-400');

    const resp = await server.inject({
      method: 'POST',
      url: '/api/devices/pair/confirm',
      payload: { code },
    });

    expect(resp.statusCode).toBe(502);
    expect(JSON.parse(resp.body).vault_status).toBe(400);
    expect(getDevices()).toHaveLength(0);
  });

  it('returns 502 and rolls back when vault is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const code = await initiatePair(server, 'iPhone-ECON');

    const resp = await server.inject({
      method: 'POST',
      url: '/api/devices/pair/confirm',
      payload: { code },
    });

    expect(resp.statusCode).toBe(502);
    expect(JSON.parse(resp.body).error).toContain('vault unreachable');
    expect(getDevices()).toHaveLength(0);
  });

  it('returns 200 and keeps the device when vault responds 200', async () => {
    vi.stubGlobal('fetch', mockFetchResponse({ ok: true, status: 200 }));
    const code = await initiatePair(server, 'iPhone-happy');

    const resp = await server.inject({
      method: 'POST',
      url: '/api/devices/pair/confirm',
      payload: { code },
    });

    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.device).toBeDefined();
    expect(body.device.public_key).toBe('AAAA');

    const devices = getDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].device_name).toBe('iPhone-happy');
  });
});
