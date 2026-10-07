import crypto from 'crypto';
import db from './connection.js';

export type AuditAction = 'requested' | 'approved' | 'rejected' | 'expired' | 'device_revoked';

export interface AuditEntry {
  id: string;
  approval_id: string;
  action: AuditAction;
  actor: string;
  created_at: string;
  metadata: string | null;
}

/** Insert an audit log entry for an approval lifecycle event. */
export function insertAuditEntry(
  approvalId: string,
  action: AuditAction,
  actor: string,
  metadata?: Record<string, unknown>,
): void {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO approval_audit_log (id, approval_id, action, actor, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, approvalId, action, actor, metadata ? JSON.stringify(metadata) : null);
}

/** Query audit log with optional filters. */
export function getAuditLog(filters?: {
  agentId?: string;
  from?: string;
  to?: string;
  limit?: number;
}): AuditEntry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.agentId) {
    conditions.push('pa.agent_id = ?');
    params.push(filters.agentId);
  }
  if (filters?.from) {
    conditions.push('al.created_at >= ?');
    params.push(filters.from);
  }
  if (filters?.to) {
    conditions.push('al.created_at <= ?');
    params.push(filters.to);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = filters?.limit || 100;

  return db.prepare(`
    SELECT al.* FROM approval_audit_log al
    LEFT JOIN pending_approvals pa ON pa.id = al.approval_id
    ${where}
    ORDER BY al.created_at DESC
    LIMIT ?
  `).all(...params, limit) as AuditEntry[];
}
