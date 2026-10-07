import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from '../../src/server.js';
import type { FastifyInstance } from 'fastify';

function fetchReturning(body: { ok: boolean; status: number; payload: unknown }) {
  return vi.fn(async () => ({
    ok: body.ok,
    status: body.status,
    json: async () => body.payload,
    text: async () => JSON.stringify(body.payload),
  }) as unknown as Response);
}

describe('GET /api/approvals/:id — vault proxy', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    vi.unstubAllGlobals();
  });

  it('forwards the vault response body on 200', async () => {
    const approval = {
      id: 'abc-123',
      state: 'pending',
      mcp_name: 'keychain',
      tool_name: 'fill_password',
      human_preview: 'keychain: fill_password',
      nonce: 'n1',
      action_hash: 'h1',
      expires_at: '2026-04-24T12:00:00Z',
    };
    vi.stubGlobal('fetch', fetchReturning({ ok: true, status: 200, payload: approval }));

    const resp = await server.inject({ method: 'GET', url: '/api/approvals/abc-123' });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body)).toEqual(approval);
  });

  it('propagates vault 404', async () => {
    vi.stubGlobal('fetch', fetchReturning({ ok: false, status: 404, payload: { error: 'not found' } }));

    const resp = await server.inject({ method: 'GET', url: '/api/approvals/missing-id' });
    expect(resp.statusCode).toBe(404);
    expect(JSON.parse(resp.body)).toEqual({ error: 'not found' });
  });

  it('propagates vault 500', async () => {
    vi.stubGlobal('fetch', fetchReturning({ ok: false, status: 500, payload: { error: 'vault boom' } }));

    const resp = await server.inject({ method: 'GET', url: '/api/approvals/any-id' });
    expect(resp.statusCode).toBe(500);
    expect(JSON.parse(resp.body)).toEqual({ error: 'vault boom' });
  });

  it('returns 502 when vault is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const resp = await server.inject({ method: 'GET', url: '/api/approvals/any-id' });
    expect(resp.statusCode).toBe(502);
    expect(JSON.parse(resp.body)).toEqual({ error: 'Vault unreachable' });
  });

  it('does not shadow /approvals/pending', async () => {
    // If the :id route were registered first (or Fastify misroutes), the
    // pending list handler would never run. Make sure `pending` still
    // returns the list shape from the pending handler, not a single
    // approval from the :id handler.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      // The pending handler hits /approvals/pending, the :id handler
      // would hit /approvals/pending — identical URL — so distinguish
      // by which shape we return.
      if (url.endsWith('/approvals/pending')) {
        return { ok: true, status: 200, json: async () => ({ approvals: ['a', 'b'] }) } as unknown as Response;
      }
      throw new Error('unexpected vault URL: ' + url);
    }));

    const resp = await server.inject({ method: 'GET', url: '/api/approvals/pending' });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body)).toEqual({ approvals: ['a', 'b'] });
  });

  it('does not shadow /approvals/pending/:sessionId', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/approvals/pending/sess-1')) {
        return { ok: true, status: 200, json: async () => ({ approvals: ['s1a', 's1b'] }) } as unknown as Response;
      }
      throw new Error('unexpected vault URL: ' + url);
    }));

    const resp = await server.inject({ method: 'GET', url: '/api/approvals/pending/sess-1' });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body)).toEqual({ approvals: ['s1a', 's1b'] });
  });
});
