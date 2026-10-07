# Monitoring

## Overview

This document covers the monitoring strategy for Gellyfish: metrics, logs, alerts, and runbooks.

## Metrics

### Operational Metrics

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `gateway.request.latency` | API response time | > 2s |
| `gateway.request.errors` | 5xx error rate | > 1% |
| `core.agent.latency` | Claude API call time | > 10s |
| `integration.*.success_rate` | Per-integration success | < 95% |

### Business Metrics

| Metric | Description |
|--------|-------------|
| `commands.total` | Total commands processed |
| `commands.by_source` | Commands by input channel (Siri, Telegram, etc.) |
| `commands.by_integration` | Which integrations are used most |
| `commands.success_rate` | End-to-end success rate |

## Logs

### Log Levels

- `ERROR` - Failures requiring attention
- `WARN` - Degraded state, potential issues
- `INFO` - Normal operations, command flow
- `DEBUG` - Detailed debugging (disabled in production)

### Structured Logging

All logs should be JSON with fields:
- `timestamp`
- `level`
- `service` (gateway, core, integration-*)
- `trace_id` (for request correlation)
- `message`

## Alerts

(To be configured)

## Runbooks

### Gateway Unresponsive

1. Check container status: `docker ps`
2. Check logs: `docker logs gellyfish-gateway`
3. Restart if needed: `docker restart gellyfish-gateway`

### High Error Rate

1. Check error logs for patterns
2. Identify failing integration
3. Check external service status
4. Roll back recent changes if needed

### Claude API Failures

1. Check Anthropic status page
2. Verify API key is valid
3. Check rate limits
4. Review recent prompt changes

## Claude Code Usage Analytics

The gateway includes a built-in dashboard for viewing Claude Code usage metrics via OpenTelemetry. This works with any Claude account (personal or team) by collecting telemetry data locally.

### Setup

1. **Start the gateway:**
   ```bash
   cd apps/gateway
   pnpm dev
   ```

2. **Configure Claude Code to send telemetry** - Add to `~/.zshrc` or `~/.bashrc`:
   ```bash
   export CLAUDE_CODE_ENABLE_TELEMETRY=1
   export OTEL_METRICS_EXPORTER=otlp
   export OTEL_LOGS_EXPORTER=otlp
   export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
   export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000
   ```

3. **Restart Claude Code** to pick up the new environment variables

4. **Open the dashboard:**
   ```
   http://localhost:3000/analytics
   ```

### How It Works

The gateway runs an OpenTelemetry (OTLP) HTTP receiver that accepts metrics and logs from Claude Code:
- **Metrics endpoint:** `POST /v1/metrics`
- **Logs endpoint:** `POST /v1/logs`
- **Health check:** `GET /v1/health`

Telemetry data is stored locally in `apps/gateway/data/claude-code-metrics.json` and retained for 30 days.

### Features

| Feature | Description |
|---------|-------------|
| Date range filter | Select start and end dates for the report |
| Aggregated stats | Total cost, sessions, API requests, tokens |
| Model breakdown | Cost and token usage per model |
| Daily usage table | Requests, tokens, and cost per day |
| Auto-calculated costs | Based on current Anthropic pricing |

### API Endpoints

**Get analytics data:**
```
GET /api/analytics/claude-code?starting_at=2025-01-01&ending_at=2025-01-07
```

**Check telemetry status:**
```
GET /api/analytics/status
```

### Metrics Available

| Metric | Description |
|--------|-------------|
| `totalRequests` | Number of API requests to Claude |
| `totalSessions` | Number of Claude Code sessions |
| `totalInputTokens` | Total input tokens used |
| `totalOutputTokens` | Total output tokens generated |
| `totalCacheRead` | Tokens read from prompt cache |
| `totalCacheCreation` | Tokens used to create cache |
| `totalCost` | Estimated cost in USD |
| `modelBreakdown` | Per-model token usage and cost |
