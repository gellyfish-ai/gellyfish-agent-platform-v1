import { FastifyInstance } from 'fastify';
import { createReadStream, statSync } from 'fs';
import { join } from 'path';
import readline from 'readline';

const LOG_FILE = join(process.cwd(), 'data', 'logs', 'gateway.log');

export interface LogEntry {
  level: number;
  levelName: string;
  time: number;
  msg: string;
  agentId?: string;
  profileId?: string;
  sessionId?: string;
  error?: string;
  [key: string]: unknown;
}

function levelName(n: number): string {
  if (n >= 50) return 'error';
  if (n >= 40) return 'warn';
  if (n >= 30) return 'info';
  return 'debug';
}

async function readLogs(opts: {
  limit: number;
  level?: string;
  agentId?: string;
  search?: string;
  since?: number;
  until?: number;
}): Promise<LogEntry[]> {
  const results: LogEntry[] = [];
  const levelMin = opts.level === 'error' ? 50 : opts.level === 'warn' ? 40 : 30;

  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(LOG_FILE);
  } catch {
    return [];
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }

    const level = entry.level as number;
    if (level < levelMin) continue;
    if (opts.since && (entry.time as number) < opts.since) continue;
    if (opts.until && (entry.time as number) > opts.until) continue;
    if (opts.agentId && entry.agentId !== opts.agentId && entry.profileId !== opts.agentId) continue;
    if (opts.search) {
      const haystack = JSON.stringify(entry).toLowerCase();
      if (!haystack.includes(opts.search.toLowerCase())) continue;
    }

    results.push({ ...entry, levelName: levelName(level) } as LogEntry);
  }

  return results.slice(-opts.limit).reverse();
}

export async function logsRoutes(server: FastifyInstance) {
  server.get<{
    Querystring: { level?: string; agent_id?: string; search?: string; limit?: string; since_ms?: string; until_ms?: string };
  }>('/logs', async (req) => {
    const { level, agent_id, search, limit, since_ms, until_ms } = req.query;
    const entries = await readLogs({
      limit: limit ? Math.min(parseInt(limit, 10), 1000) : 200,
      level,
      agentId: agent_id,
      search,
      since: since_ms ? parseInt(since_ms, 10) : undefined,
      until: until_ms ? parseInt(until_ms, 10) : undefined,
    });
    return { entries, total: entries.length };
  });

  server.get('/logs/stream', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let lastSize = 0;
    try { lastSize = statSync(LOG_FILE).size; } catch {}

    const interval = setInterval(() => {
      try {
        const currentSize = statSync(LOG_FILE).size;
        if (currentSize <= lastSize) return;

        const stream = createReadStream(LOG_FILE, { start: lastSize, end: currentSize - 1 });
        lastSize = currentSize;
        const rl = readline.createInterface({ input: stream });
        rl.on('line', (line) => {
          if (!line.trim()) return;
          try { JSON.parse(line); reply.raw.write(`data: ${line}\n\n`); } catch {}
        });
      } catch {}
    }, 1000);

    req.raw.on('close', () => clearInterval(interval));
  });
}
