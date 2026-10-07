import db from './db/index.js';
import { logger } from './logger.js';
import { broadcastToAll } from './ws/broadcast.js';

interface McpHealthStatus {
  id: string;
  name: string;
  url: string;
  healthy: boolean;
  lastCheck: string;
}

const mcpHealthCache = new Map<string, McpHealthStatus>();

/** Extract SSE URL from MCP server args (mcp-remote pattern) */
function extractSseUrl(args: string): string | null {
  try {
    const parsed = JSON.parse(args) as string[];
    const idx = parsed.indexOf('mcp-remote');
    if (idx >= 0 && idx + 1 < parsed.length) {
      const url = parsed[idx + 1];
      if (url.startsWith('http')) return url;
    }
  } catch { /* not JSON or no mcp-remote */ }
  return null;
}

/** Check if an SSE endpoint is reachable */
async function checkSseEndpoint(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return resp.ok || resp.status === 200;
  } catch {
    return false;
  }
}

/** Check all SSE MCP daemons and broadcast warnings for unhealthy ones */
export async function checkMcpHealth(): Promise<void> {
  const servers = db.prepare('SELECT id, name, args FROM mcp_servers').all() as Array<{ id: string; name: string; args: string }>;

  for (const server of servers) {
    const url = extractSseUrl(server.args);
    if (!url) continue;

    const healthy = await checkSseEndpoint(url);
    const prev = mcpHealthCache.get(server.id);

    mcpHealthCache.set(server.id, {
      id: server.id,
      name: server.name,
      url,
      healthy,
      lastCheck: new Date().toISOString(),
    });

    // Only broadcast on state change: healthy → unhealthy
    if (!healthy && (!prev || prev.healthy)) {
      const dependents = db.prepare(
        'SELECT p.name FROM profile_mcps pm JOIN profiles p ON p.id = pm.profile_id WHERE pm.mcp_server_id = ?'
      ).all(server.id) as Array<{ name: string }>;

      broadcastToAll({
        type: 'mcp_health_warning',
        mcp: server.name,
        message: `MCP "${server.name}" daemon is unreachable (${url}). Affects: ${dependents.map(d => d.name).join(', ') || 'none'}.`,
      });
      logger.warn({ mcpName: server.name, url, dependents: dependents.map(d => d.name) }, '[mcp-health] SSE daemon unreachable');
    }
  }
}

export function getMcpHealthStatuses(): McpHealthStatus[] {
  return Array.from(mcpHealthCache.values());
}
