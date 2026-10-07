import { createWriteStream, mkdirSync } from 'fs';
import { join } from 'path';
import pino from 'pino';

const LOG_DIR = join(process.cwd(), 'data', 'logs');
mkdirSync(LOG_DIR, { recursive: true });

const fileStream = createWriteStream(join(LOG_DIR, 'gateway.log'), { flags: 'a' });

/**
 * Standalone pino logger that writes JSON to both stdout and the log file.
 * Fastify uses this same instance (passed via `createServer()`), so all
 * log lines — whether from route handlers or standalone helpers — share
 * one format and one destination.
 */
export const logger = pino(
  { level: 'info' },
  pino.multistream([
    { stream: process.stdout },
    { stream: fileStream },
  ]),
);
