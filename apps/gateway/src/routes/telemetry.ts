import { FastifyInstance } from 'fastify';
import { listToolCalls, summarizeToolCalls } from '../db/tool-calls.js';
import { computeDashboardMetrics, detectAnomalies } from '../mcp/observability.js';
import { generateWeeklyReport } from '../mcp/weekly-report.js';
import db from '../db/connection.js';

export async function telemetryRoutes(server: FastifyInstance) {
  server.get<{
    Querystring: { mcp_name?: string; agent_id?: string; limit?: string };
  }>('/telemetry/tool-calls', async (req) => {
    return {
      calls: listToolCalls({
        mcpName: req.query.mcp_name,
        agentId: req.query.agent_id,
        limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
      }),
    };
  });

  server.get<{
    Querystring: { window_hours?: string };
  }>('/telemetry/tool-calls/summary', async (req) => {
    const windowHours = req.query.window_hours ? parseInt(req.query.window_hours, 10) : 24;
    return { summary: summarizeToolCalls(windowHours) };
  });

  server.get<{
    Querystring: { agent_id?: string; window_hours?: string };
  }>('/telemetry/dashboard', async (req) => {
    const windowHours = req.query.window_hours ? parseInt(req.query.window_hours, 10) : 24;
    return computeDashboardMetrics(windowHours, req.query.agent_id);
  });

  server.get('/telemetry/anomalies', async () => {
    return { alerts: detectAnomalies() };
  });

  server.get('/telemetry/reports', async () => {
    const rows = db.prepare(
      'SELECT * FROM mcp_weekly_reports ORDER BY week_start DESC LIMIT 52'
    ).all() as Array<Record<string, unknown>>;
    return {
      reports: rows.map(r => ({
        ...r,
        top_tools: JSON.parse(r.top_tools as string),
        error_tools: JSON.parse(r.error_tools as string),
        latency_regressions: JSON.parse(r.latency_regressions as string),
        new_tools: JSON.parse(r.new_tools as string),
      })),
    };
  });

  server.post('/telemetry/reports/generate', async (_req, reply) => {
    const report = generateWeeklyReport();
    if (!report) {
      reply.status(409);
      return { error: 'Report for this week already exists' };
    }
    return { report };
  });
}
