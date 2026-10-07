import path from 'path';
import { fileURLToPath } from 'url';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { logger } from './logger.js';
import { healthRoutes } from './routes/health.js';
import { commandRoutes } from './routes/command.js';
import { chatWsRoutes } from './routes/chat-ws.js';
import { sessionsRoutes } from './routes/sessions.js';
import { profilesRoutes } from './routes/profiles.js';
import { crewsRoutes } from './routes/crews.js';
import { mcpsRoutes } from './routes/mcps.js';
import { analyticsRoutes } from './routes/analytics.js';
import { settingsRoutes } from './routes/settings.js';
import { tasksRoutes } from './routes/tasks.js';
import { statusRoutes } from './routes/status.js';
import { versionRoutes } from './routes/version.js';
import { agentsRoutes } from './routes/agents.js';
import { conversationsRoutes } from './routes/conversations.js';
import { credentialsRoutes } from './routes/credentials.js';
import { transcribeRoutes } from './routes/transcribe.js';
import { modelsRoutes } from './routes/models.js';
import { riskLevelsRoutes } from './routes/risk-levels.js';
import { devicesRoutes } from './routes/devices.js';
import { pushRoutes } from './routes/push.js';
import { pairingRoutes } from './routes/pairing.js';
import { approvalsRoutes } from './routes/approvals.js';
import { internalRoutes } from './routes/internal.js';
import { diagnosticsRoutes } from './routes/diagnostics.js';
import { mcpProxyRoutes } from './routes/mcp-proxy.js';
import { telemetryRoutes } from './routes/telemetry.js';
import fastifyMultipart from '@fastify/multipart';
import { otelReceiverRoutes } from './telemetry/otel-receiver.js';
import { mcpServerRoutes } from './mcp-server/transport.js';
import { logsRoutes } from './routes/logs.js';
import { startAlertScheduler } from './mcp/alert-scheduler.js';
import { broadcastToAll } from './ws/broadcast.js';
import { scheduleWeeklyReport } from './mcp/weekly-report.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createServer(): Promise<FastifyInstance> {
  const server = Fastify({ loggerInstance: logger as any });

  await server.register(cors);
  await server.register(fastifyWebsocket);
  await server.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // Serve static files (web UI)
  await server.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
  });

  await server.register(healthRoutes);
  await server.register(versionRoutes);
  await server.register(commandRoutes, { prefix: '/api' });
  await server.register(chatWsRoutes, { prefix: '/api' });
  await server.register(sessionsRoutes, { prefix: '/api' });
  await server.register(profilesRoutes, { prefix: '/api' });
  await server.register(crewsRoutes, { prefix: '/api' });
  await server.register(mcpsRoutes, { prefix: '/api' });
  await server.register(settingsRoutes, { prefix: '/api' });
  await server.register(tasksRoutes, { prefix: '/api' });
  await server.register(statusRoutes, { prefix: '/api' });
  await server.register(agentsRoutes, { prefix: '/api' });
  await server.register(conversationsRoutes, { prefix: '/api' });
  await server.register(credentialsRoutes, { prefix: '/api' });
  await server.register(transcribeRoutes, { prefix: '/api' });
  await server.register(modelsRoutes, { prefix: '/api' });
  await server.register(riskLevelsRoutes, { prefix: '/api' });
  await server.register(devicesRoutes, { prefix: '/api' });
  await server.register(pushRoutes, { prefix: '/api' });
  await server.register(pairingRoutes, { prefix: '/api' });
  await server.register(approvalsRoutes, { prefix: '/api' });
  await server.register(internalRoutes, { prefix: '/api' });
  await server.register(diagnosticsRoutes, { prefix: '/api' });
  await server.register(mcpProxyRoutes);
  await server.register(telemetryRoutes, { prefix: '/api' });
  await server.register(logsRoutes, { prefix: '/api' });
  await server.register(analyticsRoutes);
  await server.register(otelReceiverRoutes); // OTEL receiver at /v1/metrics and /v1/logs
  await server.register(mcpServerRoutes, { prefix: '/api' });

  startAlertScheduler((alerts) => {
    broadcastToAll({ type: 'mcp_anomaly_alerts', alerts });
  });
  scheduleWeeklyReport();

  // SPA fallback: serve index.html for client-side routes
  server.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/v1/') || request.url.startsWith('/mcp/')) {
      reply.status(404).send({ error: 'Not found' });
    } else {
      reply.sendFile('index.html');
    }
  });

  return server;
}
