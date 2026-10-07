/**
 * MCP SSE proxy — transparent passthrough for SSE-based MCP servers.
 * Agents connect to gateway/mcp/<name>/sse instead of direct upstream ports.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import db from '../db/connection.js';
import { logger } from '../logger.js';
import { SseParser } from './sse-parser.js';
import type { ToolCallEvent } from './sse-parser.js';
import { logToolCallStart, logToolCallEnd, getPendingToolName } from './telemetry-logger.js';
import type { ToolCallContext } from './telemetry-logger.js';
import { checkToolRiskLevel, findApprovedRecord, waitForApproval, synthesizeJsonRpcError } from './policy-enforcer.js';

/** Resolve the upstream SSE URL for an MCP server by name. Returns null if not proxiable. */
export function resolveMcpUpstreamUrl(name: string): string | null {
  const row = db.prepare(
    'SELECT args FROM mcp_servers WHERE name = ?'
  ).get(name) as { args: string } | undefined;
  if (!row) return null;

  const args: string[] = JSON.parse(row.args || '[]');
  if (!args.includes('mcp-remote')) return null;

  const urlArg = args.find(a => a.startsWith('http'));
  return urlArg ?? null;
}

/** Proxy GET /mcp/:name/sse to upstream SSE endpoint. */
export async function proxyMcpSse(
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamUrl: string,
): Promise<void> {
  const name = (req.params as { name: string }).name;
  logger.info({ name, upstreamUrl }, '[mcp-proxy] SSE connect');

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  } catch (err) {
    logger.warn({ name, upstreamUrl, error: String(err) }, '[mcp-proxy] upstream connection failed');
    reply.status(502).send({ error: `upstream MCP '${name}' unavailable` });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    reply.status(502).send({ error: `upstream MCP '${name}' returned ${upstream.status}` });
    return;
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const gatewayBase = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const parser = new SseParser(name);
  const sessionId = (req.query as Record<string, string>).sessionId;
  const agentId = (req.query as Record<string, string>).agentId;
  const profileId = (req.query as Record<string, string>).profileId;
  const context = { sessionId, agentId, profileId, mcpName: name };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = decoder.decode(value, { stream: true });

      const events = parser.observe(chunk);
      let blocked = false;

      for (const event of events) {
        const toolName = getPendingToolName(event.mcpName, event.requestId) ?? event.toolName ?? '';
        logToolCallEnd(event);

        if (event.type === 'tool_end' && context.agentId) {
          const risk = checkToolRiskLevel(event.mcpName, toolName);
          if (risk === 'approve') {
            if (!findApprovedRecord(event.mcpName, toolName, context.agentId)) {
              logger.info({ mcpName: name, toolName, agentId: context.agentId }, '[mcp-policy] tool call held by proxy — waiting for approval');
              const outcome = await waitForApproval(event.mcpName, toolName, context.agentId);
              logger.info({ mcpName: name, toolName, agentId: context.agentId, outcome }, '[mcp-policy] tool call approval resolved');
              if (outcome !== 'approved') {
                const errFrame = synthesizeJsonRpcError(event.requestId,
                  outcome === 'rejected' ? 'Tool call rejected by policy' : 'Tool call approval timed out');
                reply.raw.write(errFrame);
                blocked = true;
              }
            }
          }
        }
      }

      if (blocked) continue;

      chunk = chunk.replace(/http:\/\/127\.0\.0\.1:\d+\/message/g, `${gatewayBase}/mcp/${name}/message`);
      reply.raw.write(chunk);
    }
  } catch (err) {
    logger.warn({ name, error: String(err) }, '[mcp-proxy] SSE stream error');
  } finally {
    reader.releaseLock();
    reply.raw.end();
  }
}

/** Proxy POST /mcp/:name/message to upstream. */
export async function proxyMcpMessage(
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamBaseUrl: string,
  context: ToolCallContext,
): Promise<void> {
  const name = (req.params as { name: string }).name;
  const sessionId = (req.query as Record<string, string>).sessionId ?? '';
  const messageUrl = upstreamBaseUrl.replace('/sse', `/message?sessionId=${sessionId}`);

  const body = req.body as Record<string, unknown>;
  if (body?.method === 'tools/call' && body.id !== undefined) {
    const params = body.params as Record<string, unknown> | undefined;
    const event: ToolCallEvent = {
      type: 'tool_start',
      requestId: body.id as string | number,
      mcpName: context.mcpName,
      toolName: params?.name as string,
      inputPreview: params?.arguments ? JSON.stringify(params.arguments).substring(0, 500) : undefined,
    };
    logToolCallStart(event, context);
  }

  let upstream: Response;
  try {
    upstream = await fetch(messageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logger.warn({ name, error: String(err) }, '[mcp-proxy] message proxy failed');
    reply.status(502).send({ error: `upstream MCP '${name}' unavailable` });
    return;
  }

  reply.status(upstream.status).send(await upstream.text());
}
