import db from './connection.js';

export type RiskLevel = 'none' | 'notify' | 'approve';

interface RiskLevelRow {
  mcp_name: string;
  tool_name: string;
  risk_level: RiskLevel;
  created_at: string;
  updated_at: string;
}

/**
 * Parse a Claude CLI tool name into MCP server name and tool name.
 * e.g. "mcp__imessage__send_message" → { mcpName: "imessage", toolName: "send_message" }
 * Built-in tools (e.g. "Bash") → { mcpName: null, toolName: "Bash" }
 */
export function parseMcpToolName(fullName: string): { mcpName: string | null; toolName: string } {
  const match = fullName.match(/^mcp__([^_]+)__(.+)$/);
  if (match) {
    return { mcpName: match[1], toolName: match[2] };
  }
  return { mcpName: null, toolName: fullName };
}

/** Get the risk level for a specific MCP tool. Defaults to 'none'. */
export function getRiskLevel(mcpName: string, toolName: string): RiskLevel {
  const row = db.prepare(
    'SELECT risk_level FROM tool_risk_levels WHERE mcp_name = ? AND tool_name = ?'
  ).get(mcpName, toolName) as { risk_level: RiskLevel } | undefined;
  return row?.risk_level || 'none';
}

/** Set (upsert) the risk level for a specific MCP tool. */
export function setRiskLevel(mcpName: string, toolName: string, level: RiskLevel): void {
  db.prepare(`
    INSERT INTO tool_risk_levels (mcp_name, tool_name, risk_level)
    VALUES (?, ?, ?)
    ON CONFLICT(mcp_name, tool_name) DO UPDATE SET risk_level = ?, updated_at = datetime('now')
  `).run(mcpName, toolName, level, level);
}

/** Get all configured risk levels. */
export function getAllRiskLevels(): RiskLevelRow[] {
  return db.prepare(
    'SELECT mcp_name, tool_name, risk_level, created_at, updated_at FROM tool_risk_levels ORDER BY mcp_name, tool_name'
  ).all() as RiskLevelRow[];
}

/** Get risk levels for a specific MCP server. */
export function getRiskLevelsForMcp(mcpName: string): RiskLevelRow[] {
  return db.prepare(
    'SELECT mcp_name, tool_name, risk_level, created_at, updated_at FROM tool_risk_levels WHERE mcp_name = ? ORDER BY tool_name'
  ).all(mcpName) as RiskLevelRow[];
}
