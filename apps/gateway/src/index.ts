import 'dotenv/config';
import { createServer } from './server.js';
import { pmClient } from './pm-client.js';
import { syncFromPM } from './routes/chat-ws.js';
import { logger } from './logger.js';
import { startHQSync } from './hq-sync.js';
import { syncSkillsFromHQ } from './claude-spawn.js';
import { checkMcpHealth } from './mcp-health.js';

const isProd = process.env.NODE_ENV === 'production';
const DEFAULT_PORT = isProd ? '3000' : '3001';
const PORT = parseInt(process.env.PORT || DEFAULT_PORT, 10);
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  // Connect to process manager (starts it if not running)
  try {
    await pmClient.connect();
    logger.info('[startup] connected to process manager');
  } catch (err) {
    logger.error({ error: String(err) }, '[startup] failed to connect to process manager');
    process.exit(1);
  }

  // Rebuild activeProcesses from PM state (survives gateway restarts)
  await syncFromPM();

  const server = await createServer();

  try {
    await server.listen({ port: PORT, host: HOST });
    logger.info({ host: HOST, port: PORT }, '[startup] gateway listening');
  } catch (err) {
    logger.error({ error: err }, '[startup] failed to start server');
    process.exit(1);
  }

  // HQ sync — skills and CLAUDE.md files
  syncSkillsFromHQ();
  startHQSync();

  // MCP daemon health monitoring
  checkMcpHealth().catch(() => {});

  // Sync risk levels from HQ config
  const { syncRiskLevelsFromHQ } = await import('./risk-level-sync.js');
  syncRiskLevelsFromHQ();

  // Approval expiry sweep handled by vault (#718)
  setInterval(() => { checkMcpHealth().catch(err => logger.error({ error: String(err) }, '[mcp-health] check failed')); }, 60_000);

  // Heartbeat — idle detection + silent hang checks
  const { startHeartbeat } = await import('./heartbeat.js');
  startHeartbeat();
}

main();
