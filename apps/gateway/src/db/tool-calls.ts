import db from './connection.js';

export interface ToolCallRow {
  id: string;
  session_id: string | null;
  agent_id: string | null;
  profile_id: string | null;
  mcp_name: string;
  tool_name: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  success: number;
  error_code: string | null;
  input_preview: string | null;
  output_preview: string | null;
  risk_level: string;
  created_at: string;
}

export function listToolCalls(opts?: { mcpName?: string; agentId?: string; limit?: number }): ToolCallRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.mcpName) {
    conditions.push('mcp_name = ?');
    params.push(opts.mcpName);
  }
  if (opts?.agentId) {
    conditions.push('agent_id = ?');
    params.push(opts.agentId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts?.limit ?? 100;

  return db.prepare(`SELECT * FROM mcp_tool_calls ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as ToolCallRow[];
}

export interface ToolCallSummary {
  mcp_name: string;
  tool_name: string;
  count: number;
  error_rate: number;
  avg_duration_ms: number;
}

export function summarizeToolCalls(windowHours = 24): ToolCallSummary[] {
  return db.prepare(`
    SELECT
      mcp_name,
      tool_name,
      COUNT(*) as count,
      ROUND(1.0 * SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) / COUNT(*), 3) as error_rate,
      ROUND(AVG(duration_ms), 0) as avg_duration_ms
    FROM mcp_tool_calls
    WHERE started_at >= datetime('now', '-' || ? || ' hours')
    GROUP BY mcp_name, tool_name
    ORDER BY count DESC
  `).all(windowHours) as ToolCallSummary[];
}
