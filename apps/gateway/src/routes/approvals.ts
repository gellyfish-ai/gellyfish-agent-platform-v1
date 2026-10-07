import { FastifyInstance } from 'fastify';
import { getActiveProcess } from '../session/registry.js';
import { pmClient } from '../pm-client.js';
import { broadcastToAll } from '../ws/broadcast.js';
import { logger } from '../logger.js';
import { insertAuditEntry } from '../db/audit-log.js';

const VAULT_URL = process.env.VAULT_URL || 'http://localhost:8205';

export async function approvalsRoutes(server: FastifyInstance) {
  // GET /api/approvals/pending — proxy to vault
  server.get('/approvals/pending', async (_req, reply) => {
    try {
      const vaultResp = await fetch(VAULT_URL + '/approvals/pending');
      if (!vaultResp.ok) return reply.status(vaultResp.status).send({ approvals: [] });
      return vaultResp.json();
    } catch {
      return { approvals: [] };
    }
  });

  // GET /api/approvals/pending/:sessionId — proxy to vault
  server.get<{ Params: { sessionId: string } }>('/approvals/pending/:sessionId', async (req, reply) => {
    try {
      const vaultResp = await fetch(VAULT_URL + '/approvals/pending/' + encodeURIComponent(req.params.sessionId));
      if (!vaultResp.ok) return reply.status(vaultResp.status).send({ approvals: [] });
      return vaultResp.json();
    } catch {
      return { approvals: [] };
    }
  });

  // GET /api/approvals/:id — proxy to vault.
  // Must be registered AFTER /approvals/pending and /approvals/pending/:sessionId —
  // Fastify prefers static-prefix matches, but listing order keeps the intent
  // obvious and mistake-resistant (GAP#736).
  server.get<{ Params: { id: string } }>('/approvals/:id', async (req, reply) => {
    try {
      const vaultResp = await fetch(VAULT_URL + '/approvals/' + encodeURIComponent(req.params.id));
      if (!vaultResp.ok) {
        const errBody = await vaultResp.json().catch(() => ({ error: 'vault returned error' }));
        return reply.status(vaultResp.status).send(errBody);
      }
      return vaultResp.json();
    } catch (err) {
      logger.error({ approvalId: req.params.id, error: String(err) }, '[approvals] GET proxy failed');
      return reply.status(502).send({ error: 'Vault unreachable' });
    }
  });

  // POST /api/approvals/:id/respond — relay to vault (vault handles ECDSA verification)
  server.post<{
    Params: { id: string };
    Body: { state: 'approved' | 'rejected'; signature?: string; device_id?: string };
  }>('/approvals/:id/respond', async (req, reply) => {
    const { id } = req.params;
    const { state, signature, device_id } = req.body;

    const vaultResp = await fetch(`${VAULT_URL}/approvals/${id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, signature, device_id }),
    });
    if (!vaultResp.ok) {
      const err = await vaultResp.json().catch(() => ({ error: 'Vault error' }));
      return reply.status(vaultResp.status).send(err);
    }
    const result = await vaultResp.json();

    insertAuditEntry(id, state, device_id ? `device:${device_id}` : 'http');
    return result;
  });

  // POST /api/approvals/:id/deny — relay rejection to vault (no signature required)
  server.post<{ Params: { id: string } }>('/approvals/:id/deny', async (req, reply) => {
    const { id } = req.params;

    const vaultResp = await fetch(`${VAULT_URL}/approvals/${id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'rejected' }),
    });
    if (!vaultResp.ok) {
      const err = await vaultResp.json().catch(() => ({ error: 'Vault error' }));
      return reply.status(vaultResp.status).send(err);
    }

    insertAuditEntry(id, 'rejected', 'user:web');
    logger.info({ approvalId: id }, '[approval] denied via web UI → vault');

    return { ok: true, state: 'rejected' };
  });

  // POST /api/internal/approval-resolved — webhook receiver from vault
  server.post<{
    Body: {
      approval_id: string;
      state: string;
      resolved_by: string;
      nonce?: string;
      session_id?: string;
      request_id?: string;
    };
  }>('/internal/approval-resolved', async (request, reply) => {
    const addr = request.socket?.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) {
      return reply.code(403).send({ error: 'internal only' });
    }

    const { approval_id, state, resolved_by, nonce, session_id, request_id } = request.body;
    if (!approval_id || !state) {
      return reply.code(400).send({ error: 'Missing fields' });
    }

    logger.info({ approvalId: approval_id, state, resolvedBy: resolved_by, sessionId: session_id }, '[approval-resolved] webhook received from vault');

    // Find the managed process and unblock the agent
    if (session_id && request_id) {
      const managed = getActiveProcess(session_id);
      if (managed) {
        const behavior = state === 'approved' ? 'allow' : 'deny';
        const message = state === 'approved' ? undefined : (state === 'expired' ? 'Approval expired' : 'Approval rejected');
        const response: Record<string, unknown> = { behavior };
        if (message) response.message = message;
        if (state === 'approved' && nonce) {
          response.updatedInput = { __approval_token: nonce };
        }

        const controlResponse = JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id, response },
        });
        pmClient.inject(managed.pmSessionId, controlResponse).catch(err => {
          logger.warn({ approvalId: approval_id, error: String(err) }, '[approval-resolved] inject failed');
        });

        managed.pendingApprovals.delete(approval_id);
      }
    }

    // Broadcast to all browsers
    broadcastToAll({ type: 'approval_resolved', id: approval_id, state });

    return { received: true };
  });

  // GET /api/audit-log — query approval audit log
  server.get<{
    Querystring: { agent_id?: string; from?: string; to?: string; limit?: string };
  }>('/audit-log', async (req) => {
    const { getAuditLog } = await import('../db/audit-log.js');
    return {
      entries: getAuditLog({
        agentId: req.query.agent_id,
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit ? parseInt(req.query.limit, 10) : 100,
      }),
    };
  });
}
