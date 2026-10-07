/**
 * Inbound MCP server.
 *
 * A fresh Server instance is created per client connection so each
 * SSE session has its own request/notification state (matches the
 * SDK's session model). Resources and tools are registered from
 * their own modules so Phase 1b / D4 can extend them without
 * touching transport code.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

export const MCP_SERVER_NAME = 'gellyfish-gateway';
export const MCP_SERVER_VERSION = '0.1.0';

export function createMcpServer(): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { resources: {}, tools: {} } },
  );
  registerResources(server);
  registerTools(server);
  return server;
}
