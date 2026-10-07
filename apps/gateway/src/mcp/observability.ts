import db from '../db/connection.js';

export interface McpMetrics {
  mcp_name: string;
  call_count: number;
  error_rate: number;
  avg_duration_ms: number | null;
}

export interface ToolMetrics {
  mcp_name: string;
  tool_name: string;
  call_count: number;
  error_rate: number;
  avg_duration_ms: number | null;
  p95_duration_ms: number | null;
}

export interface RecentError {
  id: string;
  mcp_name: string;
  tool_name: string;
  error_code: string | null;
  started_at: string | null;
}

export interface DashboardMetrics {
  windowHours: number;
  totalCalls: number;
  errorRate: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  byMcp: McpMetrics[];
  byTool: ToolMetrics[];
  recentErrors: RecentError[];
}

export function computeDashboardMetrics(windowHours = 24, agentId?: string): DashboardMetrics {
  const agentFilter = agentId ? ' AND agent_id = ?' : '';
  const agentParams = agentId ? [agentId] : [];

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total,
      ROUND(1.0 * SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 3) as error_rate,
      ROUND(AVG(duration_ms), 0) as avg_duration_ms
    FROM mcp_tool_calls
    WHERE started_at >= datetime('now', '-' || ? || ' hours')${agentFilter}
  `).get(windowHours, ...agentParams) as { total: number; error_rate: number; avg_duration_ms: number | null };

  const durations = db.prepare(`
    SELECT duration_ms FROM mcp_tool_calls
    WHERE duration_ms IS NOT NULL AND started_at >= datetime('now', '-' || ? || ' hours')${agentFilter}
    ORDER BY duration_ms ASC
  `).all(windowHours, ...agentParams) as { duration_ms: number }[];

  let p95DurationMs: number | null = null;
  if (durations.length >= 5) {
    p95DurationMs = durations[Math.floor(durations.length * 0.95)].duration_ms;
  }

  const byMcp = db.prepare(`
    SELECT
      mcp_name,
      COUNT(*) as call_count,
      ROUND(1.0 * SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) / COUNT(*), 3) as error_rate,
      ROUND(AVG(duration_ms), 0) as avg_duration_ms
    FROM mcp_tool_calls
    WHERE started_at >= datetime('now', '-' || ? || ' hours')${agentFilter}
    GROUP BY mcp_name
    ORDER BY call_count DESC
  `).all(windowHours, ...agentParams) as McpMetrics[];

  const byTool = db.prepare(`
    SELECT
      mcp_name,
      tool_name,
      COUNT(*) as call_count,
      ROUND(1.0 * SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) / COUNT(*), 3) as error_rate,
      ROUND(AVG(duration_ms), 0) as avg_duration_ms
    FROM mcp_tool_calls
    WHERE started_at >= datetime('now', '-' || ? || ' hours')${agentFilter}
    GROUP BY mcp_name, tool_name
    ORDER BY call_count DESC
  `).all(windowHours, ...agentParams) as (Omit<ToolMetrics, 'p95_duration_ms'> & { p95_duration_ms?: number | null })[];

  // Compute per-tool p95 in JS
  for (const tool of byTool) {
    const toolDurations = db.prepare(`
      SELECT duration_ms FROM mcp_tool_calls
      WHERE mcp_name = ? AND tool_name = ? AND duration_ms IS NOT NULL
        AND started_at >= datetime('now', '-' || ? || ' hours')${agentFilter}
      ORDER BY duration_ms ASC
    `).all(tool.mcp_name, tool.tool_name, windowHours, ...agentParams) as { duration_ms: number }[];
    tool.p95_duration_ms = toolDurations.length >= 5
      ? toolDurations[Math.floor(toolDurations.length * 0.95)].duration_ms
      : null;
  }

  const recentErrors = db.prepare(`
    SELECT id, mcp_name, tool_name, error_code, started_at
    FROM mcp_tool_calls
    WHERE success = 0 AND started_at >= datetime('now', '-' || ? || ' hours')${agentFilter}
    ORDER BY started_at DESC
    LIMIT 10
  `).all(windowHours, ...agentParams) as RecentError[];

  return {
    windowHours,
    totalCalls: totals.total,
    errorRate: totals.error_rate ?? 0,
    avgDurationMs: totals.avg_duration_ms,
    p95DurationMs,
    byMcp,
    byTool: byTool as ToolMetrics[],
    recentErrors,
  };
}

export interface AnomalyAlert {
  type: 'high_error_rate' | 'high_latency_p95';
  mcpName: string;
  toolName?: string;
  value: number;
  threshold: number;
  message: string;
}

export function detectAnomalies(): AnomalyAlert[] {
  const alerts: AnomalyAlert[] = [];

  const errorRates = db.prepare(`
    SELECT mcp_name, tool_name,
      COUNT(*) as total,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errors
    FROM mcp_tool_calls
    WHERE started_at >= datetime('now', '-5 minutes')
    GROUP BY mcp_name, tool_name
    HAVING total >= 3
  `).all() as Array<{ mcp_name: string; tool_name: string; total: number; errors: number }>;

  for (const row of errorRates) {
    const rate = row.errors / row.total;
    if (rate > 0.3) {
      alerts.push({
        type: 'high_error_rate',
        mcpName: row.mcp_name,
        toolName: row.tool_name,
        value: Math.round(rate * 100),
        threshold: 30,
        message: `${row.mcp_name}/${row.tool_name} error rate ${Math.round(rate * 100)}% over last 5 minutes`,
      });
    }
  }

  const latencyRows = db.prepare(`
    SELECT mcp_name, tool_name, duration_ms
    FROM mcp_tool_calls
    WHERE duration_ms IS NOT NULL
    ORDER BY mcp_name, tool_name, started_at DESC
  `).all() as Array<{ mcp_name: string; tool_name: string; duration_ms: number }>;

  const toolGroups = new Map<string, number[]>();
  for (const row of latencyRows) {
    const key = `${row.mcp_name}::${row.tool_name}`;
    if (!toolGroups.has(key)) toolGroups.set(key, []);
    const arr = toolGroups.get(key)!;
    if (arr.length < 100) arr.push(row.duration_ms);
  }
  for (const [key, durations] of toolGroups) {
    if (durations.length < 5) continue;
    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    if (p95 > 10_000) {
      const [mcpName, toolName] = key.split('::');
      alerts.push({
        type: 'high_latency_p95',
        mcpName,
        toolName,
        value: p95,
        threshold: 10_000,
        message: `${mcpName}/${toolName} p95 latency ${Math.round(p95 / 1000)}s over last ${durations.length} calls`,
      });
    }
  }

  return alerts;
}
