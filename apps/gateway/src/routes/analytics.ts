import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getMetricsByDateRange, aggregateByDate, loadTelemetryData } from '../telemetry/storage.js';

interface AnalyticsQuery {
  starting_at?: string;
  ending_at?: string;
}

export async function analyticsRoutes(server: FastifyInstance) {
  // Serve the analytics dashboard
  server.get('/analytics', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.type('text/html').send(getAnalyticsDashboardHTML());
  });

  // Get analytics from local OTEL telemetry data
  server.get('/api/analytics/claude-code', async (request: FastifyRequest<{ Querystring: AnalyticsQuery }>, reply: FastifyReply) => {
    const { starting_at, ending_at } = request.query;

    if (!starting_at) {
      return reply.status(400).send({
        error: 'starting_at parameter is required (YYYY-MM-DD format)'
      });
    }

    const endDate = ending_at || starting_at;

    try {
      const { tokens, sessions } = getMetricsByDateRange(starting_at, endDate);
      const dailyAggregates = aggregateByDate(tokens);

      // Calculate totals
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheRead = 0;
      let totalCacheCreation = 0;
      let totalCost = 0;
      const modelBreakdown: Record<string, { cost: number; input: number; output: number }> = {};

      for (const token of tokens) {
        totalInputTokens += token.inputTokens;
        totalOutputTokens += token.outputTokens;
        totalCacheRead += token.cacheReadTokens;
        totalCacheCreation += token.cacheCreationTokens;
        totalCost += token.costUsd;

        if (!modelBreakdown[token.model]) {
          modelBreakdown[token.model] = { cost: 0, input: 0, output: 0 };
        }
        modelBreakdown[token.model].cost += token.costUsd;
        modelBreakdown[token.model].input += token.inputTokens;
        modelBreakdown[token.model].output += token.outputTokens;
      }

      const stats = {
        totalSessions: sessions.length,
        totalRequests: tokens.length,
        totalInputTokens,
        totalOutputTokens,
        totalCacheRead,
        totalCacheCreation,
        totalCost: totalCost.toFixed(2),
        modelBreakdown,
        recordCount: Object.keys(dailyAggregates).length,
      };

      // Format records for the dashboard
      const records = Object.values(dailyAggregates).map(day => ({
        date: day.date,
        requests: day.requestCount,
        inputTokens: day.inputTokens,
        outputTokens: day.outputTokens,
        cacheReadTokens: day.cacheReadTokens,
        cacheCreationTokens: day.cacheCreationTokens,
        costUsd: day.costUsd,
        models: day.models,
      })).sort((a, b) => b.date.localeCompare(a.date));

      return {
        records,
        stats,
        sessions: sessions.slice(0, 50), // Limit to recent 50 sessions
        query: { starting_at, ending_at: endDate },
        source: 'local-otel'
      };
    } catch (error) {
      server.log.error(error, 'Failed to fetch local analytics');
      return reply.status(500).send({
        error: 'Failed to fetch analytics',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Get telemetry status
  server.get('/api/analytics/status', async () => {
    const data = loadTelemetryData();
    return {
      status: 'ok',
      tokenCount: data.tokens.length,
      sessionCount: Object.keys(data.sessions).length,
      lastUpdated: data.lastUpdated,
      otelEndpoint: 'http://localhost:3000/v1/metrics',
    };
  });
}

function getAnalyticsDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Code Usage Analytics</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #e4e4e7;
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 {
      font-size: 2rem;
      margin-bottom: 24px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    h1::before {
      content: '';
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, #d97706 0%, #f59e0b 100%);
      border-radius: 8px;
    }
    .status-bar {
      background: rgba(34,197,94,0.2);
      border: 1px solid rgba(34,197,94,0.3);
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.875rem;
    }
    .status-bar.warning {
      background: rgba(245,158,11,0.2);
      border-color: rgba(245,158,11,0.3);
    }
    .status-bar code {
      background: rgba(0,0,0,0.3);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.8rem;
    }
    .filters {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      align-items: end;
    }
    .filter-group { display: flex; flex-direction: column; gap: 6px; }
    .filter-group label { font-size: 0.875rem; color: #a1a1aa; }
    .filter-group input {
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(0,0,0,0.3);
      color: #fff;
      font-size: 0.9rem;
      min-width: 180px;
    }
    .filter-group input:focus { outline: none; border-color: #d97706; }
    button {
      padding: 10px 24px;
      border-radius: 8px;
      border: none;
      background: linear-gradient(135deg, #d97706 0%, #f59e0b 100%);
      color: #000;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.1s, opacity 0.2s;
    }
    button:hover { transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 20px;
      border: 1px solid rgba(255,255,255,0.05);
    }
    .stat-card.highlight {
      background: linear-gradient(135deg, rgba(217,119,6,0.2) 0%, rgba(245,158,11,0.1) 100%);
      border-color: rgba(217,119,6,0.3);
    }
    .stat-value {
      font-size: 1.75rem;
      font-weight: 700;
      color: #fff;
      margin-bottom: 4px;
    }
    .stat-label { font-size: 0.875rem; color: #a1a1aa; }
    .model-breakdown {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .model-breakdown h2 { font-size: 1.25rem; margin-bottom: 16px; }
    .model-list { display: flex; flex-direction: column; gap: 12px; }
    .model-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px;
      background: rgba(0,0,0,0.2);
      border-radius: 8px;
    }
    .model-name { font-family: monospace; color: #d97706; }
    .model-stats { display: flex; gap: 24px; font-size: 0.875rem; color: #a1a1aa; }
    .table-container {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      overflow: hidden;
    }
    .table-header {
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .table-header h2 { font-size: 1.25rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px 16px; text-align: left; }
    th {
      background: rgba(0,0,0,0.2);
      font-weight: 600;
      font-size: 0.8rem;
      text-transform: uppercase;
      color: #a1a1aa;
    }
    tr:not(:last-child) td { border-bottom: 1px solid rgba(255,255,255,0.05); }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .number { font-family: monospace; }
    .cost { color: #d97706; }
    .loading {
      text-align: center;
      padding: 60px;
      color: #a1a1aa;
    }
    .error {
      background: rgba(239,68,68,0.2);
      border: 1px solid rgba(239,68,68,0.3);
      border-radius: 12px;
      padding: 20px;
      color: #fca5a5;
    }
    .setup-hint {
      background: rgba(59,130,246,0.2);
      border: 1px solid rgba(59,130,246,0.3);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .setup-hint h3 { color: #93c5fd; margin-bottom: 12px; }
    .setup-hint pre {
      background: rgba(0,0,0,0.3);
      padding: 12px;
      border-radius: 8px;
      font-size: 0.85rem;
      overflow-x: auto;
      margin: 8px 0;
    }
    .setup-hint p { margin: 8px 0; font-size: 0.9rem; color: #a1a1aa; }
    @media (max-width: 768px) {
      .filters { flex-direction: column; }
      .filter-group input { width: 100%; }
      .model-stats { flex-wrap: wrap; gap: 8px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Claude Code Usage Analytics</h1>

    <div id="statusBar" class="status-bar warning">
      <span>Checking telemetry status...</span>
    </div>

    <div id="setupHint" class="setup-hint" style="display:none;">
      <h3>Setup OpenTelemetry</h3>
      <p>Add these to your shell config (~/.zshrc or ~/.bashrc):</p>
      <pre>export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000</pre>
      <p>Then restart Claude Code for changes to take effect.</p>
    </div>

    <div class="filters">
      <div class="filter-group">
        <label for="startDate">Start Date</label>
        <input type="date" id="startDate">
      </div>
      <div class="filter-group">
        <label for="endDate">End Date</label>
        <input type="date" id="endDate">
      </div>
      <button id="fetchBtn" onclick="fetchAnalytics()">Fetch Analytics</button>
    </div>

    <div id="results">
      <div class="loading">Enter date range and click "Fetch Analytics" to load data</div>
    </div>
  </div>

  <script>
    // Set default dates (last 7 days)
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    document.getElementById('endDate').value = today.toISOString().split('T')[0];
    document.getElementById('startDate').value = weekAgo.toISOString().split('T')[0];

    // Check telemetry status on load
    checkStatus();

    async function checkStatus() {
      try {
        const response = await fetch('/api/analytics/status');
        const data = await response.json();
        const statusBar = document.getElementById('statusBar');
        const setupHint = document.getElementById('setupHint');

        if (data.tokenCount > 0) {
          statusBar.className = 'status-bar';
          statusBar.innerHTML =
            '<span>Telemetry active: ' + data.tokenCount + ' metrics, ' + data.sessionCount + ' sessions</span>' +
            '<span>Last update: ' + new Date(data.lastUpdated).toLocaleString() + '</span>';
          setupHint.style.display = 'none';
        } else {
          statusBar.className = 'status-bar warning';
          statusBar.innerHTML =
            '<span>No telemetry data yet. Configure Claude Code to send metrics here.</span>' +
            '<code>' + data.otelEndpoint + '</code>';
          setupHint.style.display = 'block';
        }
      } catch (error) {
        console.error('Failed to check status:', error);
      }
    }

    async function fetchAnalytics() {
      const startDate = document.getElementById('startDate').value;
      const endDate = document.getElementById('endDate').value;
      const btn = document.getElementById('fetchBtn');
      const results = document.getElementById('results');

      if (!startDate) {
        alert('Please select a start date');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Loading...';
      results.innerHTML = '<div class="loading">Fetching analytics data...</div>';

      try {
        const params = new URLSearchParams({ starting_at: startDate });
        if (endDate) params.set('ending_at', endDate);

        const response = await fetch('/api/analytics/claude-code?' + params);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to fetch analytics');
        }

        renderResults(data);
      } catch (error) {
        results.innerHTML = '<div class="error"><strong>Error:</strong> ' + error.message + '</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Fetch Analytics';
      }
    }

    function renderResults(data) {
      const { records, stats } = data;
      const results = document.getElementById('results');

      if (records.length === 0) {
        results.innerHTML = '<div class="loading">No data found for the selected date range.<br><br>Make sure Claude Code is configured to send telemetry to this server.</div>';
        return;
      }

      const modelBreakdownHTML = Object.entries(stats.modelBreakdown).map(([model, data]) =>
        '<div class="model-item">' +
          '<span class="model-name">' + model + '</span>' +
          '<div class="model-stats">' +
            '<span>Cost: $' + data.cost.toFixed(4) + '</span>' +
            '<span>Input: ' + formatNumber(data.input) + '</span>' +
            '<span>Output: ' + formatNumber(data.output) + '</span>' +
          '</div>' +
        '</div>'
      ).join('') || '<div class="model-item"><span>No model data</span></div>';

      const recordsHTML = records.map(r =>
        '<tr>' +
          '<td>' + r.date + '</td>' +
          '<td class="number">' + r.requests + '</td>' +
          '<td class="number">' + formatNumber(r.inputTokens) + '</td>' +
          '<td class="number">' + formatNumber(r.outputTokens) + '</td>' +
          '<td class="number">' + formatNumber(r.cacheReadTokens) + '</td>' +
          '<td class="number cost">$' + r.costUsd.toFixed(4) + '</td>' +
        '</tr>'
      ).join('');

      results.innerHTML =
        '<div class="stats-grid">' +
          '<div class="stat-card highlight">' +
            '<div class="stat-value">$' + stats.totalCost + '</div>' +
            '<div class="stat-label">Total Cost</div>' +
          '</div>' +
          '<div class="stat-card">' +
            '<div class="stat-value">' + formatNumber(stats.totalRequests) + '</div>' +
            '<div class="stat-label">API Requests</div>' +
          '</div>' +
          '<div class="stat-card">' +
            '<div class="stat-value">' + stats.totalSessions + '</div>' +
            '<div class="stat-label">Sessions</div>' +
          '</div>' +
          '<div class="stat-card">' +
            '<div class="stat-value">' + formatNumber(stats.totalInputTokens) + '</div>' +
            '<div class="stat-label">Input Tokens</div>' +
          '</div>' +
          '<div class="stat-card">' +
            '<div class="stat-value">' + formatNumber(stats.totalOutputTokens) + '</div>' +
            '<div class="stat-label">Output Tokens</div>' +
          '</div>' +
          '<div class="stat-card">' +
            '<div class="stat-value">' + formatNumber(stats.totalCacheRead) + '</div>' +
            '<div class="stat-label">Cache Read</div>' +
          '</div>' +
        '</div>' +
        '<div class="model-breakdown">' +
          '<h2>Cost by Model</h2>' +
          '<div class="model-list">' + modelBreakdownHTML + '</div>' +
        '</div>' +
        '<div class="table-container">' +
          '<div class="table-header"><h2>Daily Usage (' + records.length + ' days)</h2></div>' +
          '<table>' +
            '<thead><tr>' +
              '<th>Date</th><th>Requests</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cost</th>' +
            '</tr></thead>' +
            '<tbody>' + recordsHTML + '</tbody>' +
          '</table>' +
        '</div>';
    }

    function formatNumber(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return n.toLocaleString();
    }
  </script>
</body>
</html>`;
}
