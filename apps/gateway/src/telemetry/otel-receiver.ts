import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { addTokenMetric } from './storage.js';

// Model pricing per million tokens (as of 2025)
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  'claude-opus-4-20250514': { input: 15.0, output: 75.0, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-3-opus-20240229': { input: 15.0, output: 75.0, cacheRead: 1.50, cacheWrite: 18.75 },
  // Default fallback pricing (sonnet-like)
  'default': { input: 3.0, output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 },
};

function calculateCost(model: string, inputTokens: number, outputTokens: number, cacheRead: number, cacheWrite: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['default'];
  const cost = (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheRead / 1_000_000) * pricing.cacheRead +
    (cacheWrite / 1_000_000) * pricing.cacheWrite
  );
  return cost;
}

interface OtelMetricData {
  resourceMetrics?: Array<{
    resource?: {
      attributes?: Array<{ key: string; value: { stringValue?: string } }>;
    };
    scopeMetrics?: Array<{
      metrics?: Array<{
        name: string;
        sum?: {
          dataPoints?: Array<{
            asInt?: string;
            intValue?: number;
            asDouble?: number;
            doubleValue?: number;
            timeUnixNano?: string;
            attributes?: Array<{ key: string; value: { stringValue?: string } }>;
          }>;
        };
        gauge?: {
          dataPoints?: Array<{
            asInt?: string;
            intValue?: number;
            asDouble?: number;
            doubleValue?: number;
            timeUnixNano?: string;
            attributes?: Array<{ key: string; value: { stringValue?: string } }>;
          }>;
        };
      }>;
    }>;
  }>;
}

interface OtelLogData {
  resourceLogs?: Array<{
    resource?: {
      attributes?: Array<{ key: string; value: { stringValue?: string } }>;
    };
    scopeLogs?: Array<{
      logRecords?: Array<{
        timeUnixNano?: string;
        body?: { stringValue?: string };
        attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
      }>;
    }>;
  }>;
}

export async function otelReceiverRoutes(server: FastifyInstance) {
  // OTLP HTTP endpoint for metrics
  server.post('/v1/metrics', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as OtelMetricData;

      if (!body.resourceMetrics) {
        return reply.status(200).send({});
      }

      for (const resourceMetric of body.resourceMetrics) {
        const resourceAttrs = resourceMetric.resource?.attributes || [];
        const sessionId = resourceAttrs.find(a => a.key === 'session.id')?.value.stringValue ||
                          resourceAttrs.find(a => a.key === 'service.instance.id')?.value.stringValue ||
                          'unknown';

        for (const scopeMetric of resourceMetric.scopeMetrics || []) {
          for (const metric of scopeMetric.metrics || []) {
            const dataPoints = metric.sum?.dataPoints || metric.gauge?.dataPoints || [];

            for (const dp of dataPoints) {
              const attrs = dp.attributes || [];
              const model = attrs.find(a => a.key === 'model')?.value.stringValue ||
                           attrs.find(a => a.key === 'gen_ai.response.model')?.value.stringValue ||
                           'unknown';

              // Parse token metrics - Claude Code sends one metric with 'type' attribute per dataPoint
              if (metric.name.includes('token') || metric.name.includes('usage')) {
                // Support both protobuf (asInt/asDouble) and JSON (intValue/doubleValue) formats
                const value = (parseInt(dp.asInt || '0') || parseInt(String(dp.intValue || 0)) || dp.asDouble || dp.doubleValue || 0);
                const timestamp = dp.timeUnixNano
                  ? new Date(parseInt(dp.timeUnixNano) / 1_000_000).toISOString()
                  : new Date().toISOString();

                // Check for 'type' attribute (Claude Code format)
                const typeAttr = attrs.find(a => a.key === 'type')?.value.stringValue || '';

                // Support both formats:
                // 1. Claude Code: type attribute ("input", "output", "cacheRead", "cacheCreation")
                // 2. OpenAI: metric name contains the type ("input", "output", etc.)
                const isInput = typeAttr === 'input' || metric.name.includes('input') || metric.name.includes('prompt');
                const isOutput = typeAttr === 'output' || metric.name.includes('output') || metric.name.includes('completion');
                const isCacheRead = typeAttr === 'cacheRead' || metric.name.includes('cache_read') || metric.name.includes('cache.read');
                const isCacheWrite = typeAttr === 'cacheCreation' || metric.name.includes('cache_creation') || metric.name.includes('cache.write');

                const tokenMetric = {
                  timestamp,
                  sessionId,
                  model,
                  inputTokens: isInput ? value : 0,
                  outputTokens: isOutput ? value : 0,
                  cacheReadTokens: isCacheRead ? value : 0,
                  cacheCreationTokens: isCacheWrite ? value : 0,
                  costUsd: 0,
                };

                // Calculate cost
                tokenMetric.costUsd = calculateCost(
                  model,
                  tokenMetric.inputTokens,
                  tokenMetric.outputTokens,
                  tokenMetric.cacheReadTokens,
                  tokenMetric.cacheCreationTokens
                );

                if (tokenMetric.inputTokens > 0 || tokenMetric.outputTokens > 0) {
                  addTokenMetric(tokenMetric);
                }
              }
            }
          }
        }
      }

      return reply.status(200).send({});
    } catch (error) {
      server.log.error(error, 'Error processing OTEL metrics');
      return reply.status(500).send({ error: 'Failed to process metrics' });
    }
  });

  // OTLP HTTP endpoint for logs
  server.post('/v1/logs', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as OtelLogData;

      if (!body.resourceLogs) {
        return reply.status(200).send({});
      }

      // Process logs - extract token usage from log messages
      for (const resourceLog of body.resourceLogs) {
        const resourceAttrs = resourceLog.resource?.attributes || [];
        const sessionId = resourceAttrs.find(a => a.key === 'session.id')?.value.stringValue ||
                          resourceAttrs.find(a => a.key === 'service.instance.id')?.value.stringValue ||
                          'unknown';

        for (const scopeLog of resourceLog.scopeLogs || []) {
          for (const logRecord of scopeLog.logRecords || []) {
            const attrs = logRecord.attributes || [];
            const model = attrs.find(a => a.key === 'model')?.value.stringValue ||
                         attrs.find(a => a.key === 'gen_ai.response.model')?.value.stringValue;

            // Check if this is a token usage log (support both gen_ai.* and Claude Code's format)
            // Handle both string intValue (protobuf) and numeric intValue (JSON)
            const inputTokens = parseInt(
              String(attrs.find(a => a.key === 'gen_ai.usage.input_tokens')?.value.intValue ||
              attrs.find(a => a.key === 'input_tokens')?.value.intValue || '0')
            );
            const outputTokens = parseInt(
              String(attrs.find(a => a.key === 'gen_ai.usage.output_tokens')?.value.intValue ||
              attrs.find(a => a.key === 'output_tokens')?.value.intValue || '0')
            );
            const cacheRead = parseInt(
              String(attrs.find(a => a.key === 'gen_ai.usage.cache_read_input_tokens')?.value.intValue ||
              attrs.find(a => a.key === 'cache_read_tokens')?.value.intValue || '0')
            );
            const cacheWrite = parseInt(
              String(attrs.find(a => a.key === 'gen_ai.usage.cache_creation_input_tokens')?.value.intValue ||
              attrs.find(a => a.key === 'cache_creation_tokens')?.value.intValue || '0')
            );

            if (model && (inputTokens > 0 || outputTokens > 0)) {
              const timestamp = logRecord.timeUnixNano
                ? new Date(parseInt(logRecord.timeUnixNano) / 1_000_000).toISOString()
                : new Date().toISOString();

              const costUsd = calculateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite);

              addTokenMetric({
                timestamp,
                sessionId,
                model,
                inputTokens,
                outputTokens,
                cacheReadTokens: cacheRead,
                cacheCreationTokens: cacheWrite,
                costUsd,
              });
            }
          }
        }
      }

      return reply.status(200).send({});
    } catch (error) {
      server.log.error(error, 'Error processing OTEL logs');
      return reply.status(500).send({ error: 'Failed to process logs' });
    }
  });

  // Health check for OTEL receiver
  server.get('/v1/health', async () => {
    return { status: 'ok', service: 'otel-receiver' };
  });
}
