import { FastifyInstance } from 'fastify';
import db, { McpServer } from '../db/index.js';
import { getMcpHealthStatuses } from '../mcp-health.js';
import { isKeychainRef, resolveKeychainRef } from '../mcp/keychain.js';

export async function mcpsRoutes(server: FastifyInstance) {
  // MCP daemon health statuses
  server.get('/mcps/health', async () => {
    return { mcps: getMcpHealthStatuses() };
  });

  // List all MCP servers (global + custom) with profile assignments and health
  server.get('/mcps', async () => {
    const mcps = db.prepare(`SELECT * FROM mcp_servers ORDER BY type, name`).all() as McpServer[];
    const healthStatuses = getMcpHealthStatuses();
    const healthByName = new Map(healthStatuses.map(h => [h.name, h]));

    const enriched = mcps.map(m => {
      const profiles = db.prepare(`
        SELECT p.id, p.name, p.icon FROM profile_mcps pm
        JOIN profiles p ON p.id = pm.profile_id
        WHERE pm.mcp_server_id = ?
        ORDER BY p.name
      `).all(m.id) as Array<{ id: string; name: string; icon: string }>;

      const health = healthByName.get(m.name);
      // Mask env values — return keys and whether each uses a keychain ref
      let envKeys: string[] = [];
      let envKeychainKeys: string[] = [];
      try {
        const env = JSON.parse(m.env || '{}') as Record<string, string>;
        envKeys = Object.keys(env);
        envKeychainKeys = Object.entries(env)
          .filter(([, v]) => isKeychainRef(v))
          .map(([k]) => k);
      } catch {}

      return {
        id: m.id,
        name: m.name,
        type: m.type,
        command: m.command,
        args: m.args,
        envKeys,
        envKeychainKeys,
        healthy: health ? health.healthy : null,
        lastHealthCheck: health?.lastCheck || null,
        profiles,
      };
    });

    return { mcps: enriched };
  });

  // Create a custom MCP server
  server.post<{
    Body: { name: string; command: string; args?: string[]; env?: Record<string, string> };
  }>('/mcps', async (request, reply) => {
    const { name, command, args, env } = request.body;
    if (!name || !command) {
      reply.status(400);
      return { error: 'Name and command are required' };
    }

    const existing = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(name);
    if (existing) {
      reply.status(409);
      return { error: 'An MCP server with this name already exists' };
    }

    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO mcp_servers (id, name, type, command, args, env)
      VALUES (?, ?, 'available', ?, ?, ?)
    `).run(id, name, command, JSON.stringify(args || []), JSON.stringify(env || {}));

    const mcp = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServer;
    return { mcp };
  });

  // Update a custom MCP server
  server.put<{
    Params: { id: string };
    Body: { name?: string; command?: string; args?: string[]; env?: Record<string, string> };
  }>('/mcps/:id', async (request, reply) => {
    const { id } = request.params;
    const { name, command, args, env } = request.body;

    const existing = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServer | undefined;
    if (!existing) {
      reply.status(404);
      return { error: 'MCP server not found' };
    }

    // Don't allow renaming globals (their name matches .mcp.json keys)
    if (existing.type === 'global' && name && name !== existing.name) {
      reply.status(400);
      return { error: 'Cannot rename a global MCP server' };
    }

    db.prepare(`
      UPDATE mcp_servers SET name = ?, command = ?, args = ?, env = ? WHERE id = ?
    `).run(
      name ?? existing.name,
      command ?? existing.command,
      args ? JSON.stringify(args) : existing.args,
      env ? JSON.stringify(env) : existing.env,
      id,
    );

    const mcp = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServer;
    return { mcp };
  });

  // Delete a custom MCP server (cannot delete globals)
  server.delete<{ Params: { id: string } }>('/mcps/:id', async (request, reply) => {
    const { id } = request.params;
    const existing = db.prepare('SELECT type FROM mcp_servers WHERE id = ?').get(id) as { type: string } | undefined;
    if (!existing) {
      reply.status(404);
      return { error: 'MCP server not found' };
    }
    if (existing.type === 'global') {
      reply.status(400);
      return { error: 'Cannot delete a global MCP server' };
    }
    db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    return { ok: true };
  });

  // Validate a keychain reference
  server.post<{
    Body: { ref: string };
  }>('/mcps/validate-keychain', async (request, reply) => {
    const { ref } = request.body;
    if (!ref || !isKeychainRef(ref)) {
      return reply.status(400).send({ error: 'Not a keychain reference. Use format: keychain:service/account' });
    }
    try {
      resolveKeychainRef(ref);
      return { valid: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: msg };
    }
  });

  // Get MCPs for a profile
  server.get<{ Params: { id: string } }>('/profiles/:id/mcps', async (request, reply) => {
    const { id } = request.params;

    const profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(id);
    if (!profile) {
      reply.status(404);
      return { error: 'Profile not found' };
    }

    // Return all MCP servers with an `enabled` flag for this profile
    const allMcps = db.prepare(`SELECT * FROM mcp_servers ORDER BY type, name`).all() as McpServer[];
    const enabledIds = new Set(
      (db.prepare(`SELECT mcp_server_id FROM profile_mcps WHERE profile_id = ?`).all(id) as { mcp_server_id: string }[])
        .map(r => r.mcp_server_id)
    );

    const mcps = allMcps.map(m => ({ ...m, enabled: enabledIds.has(m.id) }));
    return { mcps };
  });

  // Set MCPs for a profile (full replacement)
  server.put<{
    Params: { id: string };
    Body: { mcp_server_ids: string[] };
  }>('/profiles/:id/mcps', async (request, reply) => {
    const { id } = request.params;
    const { mcp_server_ids } = request.body;

    const profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(id);
    if (!profile) {
      reply.status(404);
      return { error: 'Profile not found' };
    }

    db.prepare('DELETE FROM profile_mcps WHERE profile_id = ?').run(id);
    const assign = db.prepare('INSERT INTO profile_mcps (profile_id, mcp_server_id) VALUES (?, ?)');
    for (const mcpId of mcp_server_ids) {
      assign.run(id, mcpId);
    }

    return { ok: true };
  });

  server.post<{ Params: { name: string }; Body: { proxied: boolean } }>(
    '/mcp-servers/:name/proxied',
    async (request, reply) => {
      const { name } = request.params;
      const { proxied } = request.body;
      if (typeof proxied !== 'boolean') {
        reply.status(400);
        return { error: 'proxied must be a boolean' };
      }
      const existing = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(name);
      if (!existing) {
        reply.status(404);
        return { error: `MCP server '${name}' not found` };
      }
      db.prepare('UPDATE mcp_servers SET proxied = ? WHERE name = ?').run(proxied ? 1 : 0, name);
      return { ok: true, name, proxied };
    },
  );
}
