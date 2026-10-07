import db from '../db/connection.js';

export type RiskLevel = 'none' | 'notify' | 'approve';

export function checkToolRiskLevel(mcpName: string, toolName: string): RiskLevel {
  const row = db.prepare(
    'SELECT risk_level FROM tool_risk_levels WHERE mcp_name = ? AND tool_name = ?'
  ).get(mcpName, toolName) as { risk_level: RiskLevel } | undefined;
  return row?.risk_level ?? 'none';
}

export function findApprovedRecord(mcpName: string, toolName: string, agentId: string | undefined): boolean {
  const row = db.prepare(`
    SELECT id FROM pending_approvals
    WHERE mcp_name = ? AND tool_name = ? AND state = 'approved'
    AND (agent_id IS NULL OR agent_id = ?)
    AND expires_at > datetime('now')
    ORDER BY created_at DESC LIMIT 1
  `).get(mcpName, toolName, agentId ?? null);
  return !!row;
}

export async function waitForApproval(
  mcpName: string, toolName: string, agentId: string | undefined
): Promise<'approved' | 'rejected' | 'timeout'> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (findApprovedRecord(mcpName, toolName, agentId)) return 'approved';
    const rejected = db.prepare(`
      SELECT id FROM pending_approvals
      WHERE mcp_name = ? AND tool_name = ?
      AND (agent_id IS NULL OR agent_id = ?)
      AND state = 'rejected' AND created_at > datetime('now', '-130 seconds')
      LIMIT 1
    `).get(mcpName, toolName, agentId ?? null);
    if (rejected) return 'rejected';
    await new Promise(r => setTimeout(r, 2000));
  }
  return 'timeout';
}

export function synthesizeJsonRpcError(requestId: string | number, message: string): string {
  const errorResponse = {
    jsonrpc: '2.0',
    id: requestId,
    error: { code: -32603, message },
  };
  return `event: message\ndata: ${JSON.stringify(errorResponse)}\n\n`;
}
