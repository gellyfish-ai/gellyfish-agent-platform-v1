import { FastifyInstance } from 'fastify';
import db from '../db/index.js';
import { VERSION_INFO } from '../version.generated.js';

const STARTED_AT = new Date().toISOString();

export function getVersionInfo() {
  const dbSchemaVersion = db.pragma('user_version', { simple: true }) as number;
  return {
    version: VERSION_INFO.PACKAGE_VERSION,
    git_sha: VERSION_INFO.GIT_SHA,
    git_short: VERSION_INFO.GIT_SHORT,
    build_time: VERSION_INFO.BUILD_TIME,
    dirty: VERSION_INFO.DIRTY_FLAG,
    started_at: STARTED_AT,
    uptime_s: Math.floor(process.uptime()),
    node_version: process.version,
    db_schema_version: dbSchemaVersion,
  };
}

export async function versionRoutes(server: FastifyInstance) {
  server.get('/version', async () => getVersionInfo());
}
