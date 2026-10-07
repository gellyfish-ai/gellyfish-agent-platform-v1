/**
 * Fastify transport for the inbound MCP server.
 *
 * Loopback-only. The gateway binds to 0.0.0.0 so the iOS app
 * reaches it on the LAN; these routes MUST self-guard at the
 * handler level per the D3 brief (Decision 2). Do not rely on
 * firewall rules.
 *
 * Endpoints:
 *   GET  /api/mcp-server/sse     — SSE stream (endpoint event tells
 *                                  client where to POST)
 *   POST /api/mcp-server/message — JSON-RPC envelope, routed by
 *                                  ?sessionId=
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { logger } from '../logger.js';
import { createMcpServer } from './index.js';

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MESSAGE_ENDPOINT = '/api/mcp-server/message';

export function isLoopback(ip: string | undefined): boolean {
  return !!ip && LOOPBACK_ADDRS.has(ip);
}

function rejectNonLoopback(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!isLoopback(req.ip)) {
    logger.warn({ ip: req.ip, url: req.url }, '[mcp-server] rejecting non-loopback request');
    reply.status(403).send({ error: 'loopback only' });
    return true;
  }
  return false;
}

// sessionId (assigned by SSEServerTransport) → live transport.
// A map, not a single instance, because multiple MCP clients may
// connect concurrently (Claude Code + MCP Inspector, for example).
const transports = new Map<string, SSEServerTransport>();

export async function mcpServerRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/mcp-server/sse', async (req, reply) => {
    if (rejectNonLoopback(req, reply)) return;

    const transport = new SSEServerTransport(MESSAGE_ENDPOINT, reply.raw);
    const server = createMcpServer();

    // server.connect() calls transport.start() which writes SSE
    // headers and the endpoint event. Register the transport only
    // after that so POST routes can find it by sessionId.
    await server.connect(transport);
    transports.set(transport.sessionId, transport);
    logger.info({ sessionId: transport.sessionId, ip: req.ip }, '[mcp-server] SSE client connected');

    transport.onclose = () => {
      transports.delete(transport.sessionId);
      logger.info({ sessionId: transport.sessionId }, '[mcp-server] SSE client disconnected');
    };

    // Fastify would otherwise think we're done; keep the socket
    // open for the SSE stream by returning the raw reply.
    return reply;
  });

  fastify.post<{ Querystring: { sessionId?: string } }>('/mcp-server/message', async (req, reply) => {
    if (rejectNonLoopback(req, reply)) return;

    const sessionId = req.query.sessionId;
    if (!sessionId) {
      return reply.status(400).send({ error: 'sessionId query parameter required' });
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      return reply.status(404).send({ error: 'unknown sessionId — SSE stream not established' });
    }

    // handlePostMessage writes the HTTP response itself. Fastify's
    // reply.raw is the Node ServerResponse the SDK expects.
    await transport.handlePostMessage(req.raw, reply.raw, req.body);
  });
}
