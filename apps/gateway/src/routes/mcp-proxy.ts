import { FastifyInstance } from 'fastify';
import { resolveMcpUpstreamUrl, proxyMcpSse, proxyMcpMessage } from '../mcp/proxy.js';
import db from '../db/connection.js';

export async function mcpProxyRoutes(server: FastifyInstance) {
  server.get('/mcp/list', async () => {
    const rows = db.prepare('SELECT name, args FROM mcp_servers ORDER BY name').all() as { name: string; args: string }[];
    const proxiable = rows.filter(r => {
      const args: string[] = JSON.parse(r.args || '[]');
      if (!args.includes('mcp-remote')) return false;
      return args.some(a => a.startsWith('http'));
    });
    return { mcps: proxiable.map(r => r.name) };
  });

  server.get('/mcp/:name/sse', async (req, reply) => {
    const { name } = req.params as { name: string };
    const upstreamUrl = resolveMcpUpstreamUrl(name);
    if (!upstreamUrl) {
      return reply.status(404).send({ error: `MCP '${name}' not found or not proxiable` });
    }
    await proxyMcpSse(req, reply, upstreamUrl);
  });

  server.post('/mcp/:name/message', async (req, reply) => {
    const { name } = req.params as { name: string };
    const upstreamUrl = resolveMcpUpstreamUrl(name);
    if (!upstreamUrl) {
      return reply.status(404).send({ error: `MCP '${name}' not found or not proxiable` });
    }
    const context = {
      sessionId: (req.query as Record<string, string>).sessionId,
      agentId: (req.query as Record<string, string>).agentId,
      profileId: (req.query as Record<string, string>).profileId,
      mcpName: name,
    };
    await proxyMcpMessage(req, reply, upstreamUrl, context);
  });
}
