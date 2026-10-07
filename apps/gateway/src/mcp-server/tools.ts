/**
 * Inbound MCP server — tool registry.
 *
 * Phase 1a (#726) ships an empty registry. Later waves (D4) add
 * concrete tools that mutate gateway state.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export function registerTools(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [],
  }));
}
