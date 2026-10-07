/**
 * Inbound MCP server — resource registry.
 *
 * Phase 1a (#726) ships an empty registry. Phase 1b (#727) will
 * populate `profile://` and `agent://` URIs. Later waves add
 * `session://` and `crew://`.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export function registerResources(server: Server): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));
}
