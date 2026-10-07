import db from '../db/connection.js';
import { logger } from '../logger.js';
import crypto from 'crypto';

export interface WeeklyReport {
  id: string;
  week_start: string;
  week_end: string;
  total_calls: number;
  total_errors: number;
  error_rate_pct: number;
  avg_duration_ms: number | null;
  top_tools: Array<{ mcp: string; tool: string; calls: number }>;
  error_tools: Array<{ mcp: string; tool: string; errors: number; rate_pct: number }>;
  latency_regressions: Array<{ mcp: string; tool: string; prev_ms: number; curr_ms: number; change_pct: number }>;
  new_tools: Array<{ mcp: string; tool: string }>;
  created_at: string;
}

export function generateWeeklyReport(): WeeklyReport | null {
  const weekEnd = new Date();
  const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  const prevWeekStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);

  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);

  const existing = db.prepare('SELECT id FROM mcp_weekly_reports WHERE week_start = ?').get(weekStartStr);
  if (existing) {
    logger.info({ weekStart: weekStartStr }, '[weekly-report] already generated for this week, skipping');
    return null;
  }

  const totals = db.prepare(`
    SELECT COUNT(*) as total, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) as errors,
      ROUND(AVG(duration_ms), 0) as avg_duration_ms
    FROM mcp_tool_calls
    WHERE started_at >= ? AND started_at < ?
  `).get(weekStart.toISOString(), weekEnd.toISOString()) as { total: number; errors: number; avg_duration_ms: number | null };

  const errorRatePct = totals.total > 0 ? Math.round((totals.errors / totals.total) * 1000) / 10 : 0;

  const topTools = db.prepare(`
    SELECT mcp_name as mcp, tool_name as tool, COUNT(*) as calls
    FROM mcp_tool_calls WHERE started_at >= ? AND started_at < ?
    GROUP BY mcp_name, tool_name ORDER BY calls DESC LIMIT 10
  `).all(weekStart.toISOString(), weekEnd.toISOString()) as Array<{ mcp: string; tool: string; calls: number }>;

  const errorToolsRaw = db.prepare(`
    SELECT mcp_name as mcp, tool_name as tool,
      SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) as errors, COUNT(*) as total
    FROM mcp_tool_calls WHERE started_at >= ? AND started_at < ?
    GROUP BY mcp_name, tool_name HAVING total >= 3
    ORDER BY errors DESC LIMIT 10
  `).all(weekStart.toISOString(), weekEnd.toISOString()) as Array<{ mcp: string; tool: string; errors: number; total: number }>;

  const errorTools = errorToolsRaw
    .filter(r => r.errors / r.total > 0.1)
    .map(r => ({ mcp: r.mcp, tool: r.tool, errors: r.errors, rate_pct: Math.round(r.errors / r.total * 1000) / 10 }));

  const currLatency = db.prepare(`
    SELECT mcp_name as mcp, tool_name as tool, ROUND(AVG(duration_ms), 0) as avg_ms
    FROM mcp_tool_calls WHERE duration_ms IS NOT NULL AND started_at >= ? AND started_at < ?
    GROUP BY mcp_name, tool_name
  `).all(weekStart.toISOString(), weekEnd.toISOString()) as Array<{ mcp: string; tool: string; avg_ms: number }>;

  const prevLatency = db.prepare(`
    SELECT mcp_name as mcp, tool_name as tool, ROUND(AVG(duration_ms), 0) as avg_ms
    FROM mcp_tool_calls WHERE duration_ms IS NOT NULL AND started_at >= ? AND started_at < ?
    GROUP BY mcp_name, tool_name
  `).all(prevWeekStart.toISOString(), weekStart.toISOString()) as Array<{ mcp: string; tool: string; avg_ms: number }>;

  const prevMap = new Map(prevLatency.map(r => [`${r.mcp}::${r.tool}`, r.avg_ms]));
  const latencyRegressions = currLatency
    .filter(r => {
      const prev = prevMap.get(`${r.mcp}::${r.tool}`);
      return prev && prev > 0 && r.avg_ms > prev * 1.2;
    })
    .map(r => {
      const prev = prevMap.get(`${r.mcp}::${r.tool}`)!;
      return { mcp: r.mcp, tool: r.tool, prev_ms: prev, curr_ms: r.avg_ms, change_pct: Math.round((r.avg_ms - prev) / prev * 100) };
    });

  const currToolKeys = new Set(currLatency.map(r => `${r.mcp}::${r.tool}`));
  const prevToolKeys = new Set(prevLatency.map(r => `${r.mcp}::${r.tool}`));
  const newTools = [...currToolKeys]
    .filter(k => !prevToolKeys.has(k))
    .map(k => { const [mcp, tool] = k.split('::'); return { mcp, tool }; });

  const report: WeeklyReport = {
    id: crypto.randomUUID(),
    week_start: weekStartStr,
    week_end: weekEndStr,
    total_calls: totals.total,
    total_errors: totals.errors,
    error_rate_pct: errorRatePct,
    avg_duration_ms: totals.avg_duration_ms,
    top_tools: topTools,
    error_tools: errorTools,
    latency_regressions: latencyRegressions,
    new_tools: newTools,
    created_at: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO mcp_weekly_reports (id, week_start, week_end, total_calls, total_errors, error_rate_pct,
      avg_duration_ms, top_tools, error_tools, latency_regressions, new_tools, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    report.id, report.week_start, report.week_end,
    report.total_calls, report.total_errors, report.error_rate_pct,
    report.avg_duration_ms,
    JSON.stringify(report.top_tools), JSON.stringify(report.error_tools),
    JSON.stringify(report.latency_regressions), JSON.stringify(report.new_tools),
    report.created_at,
  );

  logger.info({ weekStart: weekStartStr, totalCalls: totals.total, regressions: latencyRegressions.length }, '[weekly-report] generated');
  return report;
}

export function scheduleWeeklyReport(): void {
  setInterval(() => {
    const now = new Date();
    if (now.getUTCDay() === 1 && now.getUTCHours() === 9) {
      try { generateWeeklyReport(); } catch (err) {
        logger.warn({ error: String(err) }, '[weekly-report] generation failed');
      }
    }
  }, 60 * 60 * 1000);
  logger.info('[weekly-report] scheduler registered (checks hourly, runs Monday 09:00 UTC)');
}
