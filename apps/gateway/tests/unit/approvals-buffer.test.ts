import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createServer } from '../../src/server.js';
import { setSetting } from '../../src/db/settings.js';
import {
  appendApprovalDiagnostic,
  __resetApprovalDiagnosticsForTest,
  ApprovalDiagnosticEntry,
} from '../../src/diagnostics/approvals-buffer.js';

function makeEntry(overrides: Partial<ApprovalDiagnosticEntry> = {}): ApprovalDiagnosticEntry {
  return {
    approval_id: 'approval-1',
    created_at: new Date().toISOString(),
    mcp_name: 'keychain',
    tool_name: 'fill_password',
    device_id: 'device-1',
    agent_display_name: 'Coder',
    profile_display_name: 'gellyfish-coder',
    nonce_hex: 'a'.repeat(64),
    action_hash_hex: 'b'.repeat(64),
    action: 'APPROVED',
    payload_utf8: 'a'.repeat(64) + 'b'.repeat(64) + 'APPROVED',
    payload_sha256_hex: 'c'.repeat(64),
    pubkey_base64: 'BASE64KEY',
    pubkey_bytes_length: 65,
    is_raw_x963: true,
    signature_base64: 'BASE64SIG',
    signature_der_length: 70,
    verify_result: true,
    failure_reason: null,
    ...overrides,
  };
}

describe('Approval diagnostics buffer + endpoints', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    setSetting('diagnostics_approvals', 'false');
  });

  beforeEach(() => {
    __resetApprovalDiagnosticsForTest();
  });

  it('flag OFF: /recent returns 404 and append is a no-op', async () => {
    setSetting('diagnostics_approvals', 'false');

    appendApprovalDiagnostic(makeEntry({ approval_id: 'should-not-store' }));

    const res = await server.inject({ method: 'GET', url: '/api/diagnostics/approvals/recent' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'diagnostics disabled' });

    // Even if we flip the flag on now, the prior append must not be visible —
    // it was rejected at write time, not at read time.
    setSetting('diagnostics_approvals', 'true');
    const res2 = await server.inject({ method: 'GET', url: '/api/diagnostics/approvals/recent' });
    expect(JSON.parse(res2.body).entries).toEqual([]);
  });

  it('flag OFF: /:id returns 404', async () => {
    setSetting('diagnostics_approvals', 'false');
    const res = await server.inject({ method: 'GET', url: '/api/diagnostics/approvals/anything' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'diagnostics disabled' });
  });

  it('flag ON: appended entries are returned newest-first and full schema is preserved', async () => {
    setSetting('diagnostics_approvals', 'true');

    appendApprovalDiagnostic(makeEntry({ approval_id: 'first' }));
    appendApprovalDiagnostic(makeEntry({ approval_id: 'second', verify_result: false, failure_reason: 'signature verification failed' }));

    const res = await server.inject({ method: 'GET', url: '/api/diagnostics/approvals/recent' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].approval_id).toBe('second');
    expect(body.entries[1].approval_id).toBe('first');

    // Schema check — every documented field present, no extras
    const fields = Object.keys(body.entries[0]).sort();
    expect(fields).toEqual([
      'action',
      'action_hash_hex',
      'agent_display_name',
      'approval_id',
      'created_at',
      'device_id',
      'failure_reason',
      'is_raw_x963',
      'mcp_name',
      'nonce_hex',
      'payload_sha256_hex',
      'payload_utf8',
      'profile_display_name',
      'pubkey_base64',
      'pubkey_bytes_length',
      'signature_base64',
      'signature_der_length',
      'tool_name',
      'verify_result',
    ]);
  });

  it('flag ON: buffer is bounded — 101st entry evicts the 1st', async () => {
    setSetting('diagnostics_approvals', 'true');

    for (let i = 0; i < 101; i++) {
      appendApprovalDiagnostic(makeEntry({ approval_id: `id-${i}` }));
    }

    const res = await server.inject({ method: 'GET', url: '/api/diagnostics/approvals/recent?limit=100' });
    const body = JSON.parse(res.body);
    expect(body.entries).toHaveLength(100);
    // newest first, so index 0 is id-100 and the last is id-1
    expect(body.entries[0].approval_id).toBe('id-100');
    expect(body.entries[body.entries.length - 1].approval_id).toBe('id-1');
    // id-0 is gone
    const ids = body.entries.map((e: ApprovalDiagnosticEntry) => e.approval_id);
    expect(ids).not.toContain('id-0');
  });

  it('flag ON: limit query is clamped (default 20, max 100, ignores garbage)', async () => {
    setSetting('diagnostics_approvals', 'true');

    for (let i = 0; i < 50; i++) appendApprovalDiagnostic(makeEntry({ approval_id: `id-${i}` }));

    const def = await server.inject({ method: 'GET', url: '/api/diagnostics/approvals/recent' });
    expect(JSON.parse(def.body).entries).toHaveLength(20);

    const big = await server.inject({ method: 'GET', url: '/api/diagnostics/approvals/recent?limit=9999' });
    expect(JSON.parse(big.body).entries).toHaveLength(50);

    const garbage = await server.inject({ method: 'GET', url: '/api/diagnostics/approvals/recent?limit=banana' });
    expect(JSON.parse(garbage.body).entries).toHaveLength(20);
  });

  it('flag ON: /:id returns matching entry; 404 for unknown id', async () => {
    setSetting('diagnostics_approvals', 'true');
    appendApprovalDiagnostic(makeEntry({ approval_id: 'find-me' }));

    const hit = await server.inject({ method: 'GET', url: '/api/diagnostics/approvals/find-me' });
    expect(hit.statusCode).toBe(200);
    expect(JSON.parse(hit.body).approval_id).toBe('find-me');

    const miss = await server.inject({ method: 'GET', url: '/api/diagnostics/approvals/nope' });
    expect(miss.statusCode).toBe(404);
    expect(JSON.parse(miss.body)).toEqual({ error: 'not found' });
  });

  it('schema contains zero PII surface — no tool_input or credential refs', async () => {
    setSetting('diagnostics_approvals', 'true');
    appendApprovalDiagnostic(makeEntry({ approval_id: 'pii-check' }));

    const res = await server.inject({ method: 'GET', url: '/api/diagnostics/approvals/pii-check' });
    const body = res.body;
    expect(body).not.toContain('tool_input');
    expect(body).not.toContain('tool_input_preview');
    expect(body).not.toContain('credential_ref');
    expect(body).not.toContain('vault_token');
  });
});
