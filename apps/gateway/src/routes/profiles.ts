import { FastifyInstance } from 'fastify';
import db, { Profile, createProfileWorkspace } from '../db/index.js';
import { isValidModel } from '../models.js';

export async function profilesRoutes(server: FastifyInstance) {
  // List all profiles (enriched with crew membership)
  server.get('/profiles', async () => {
    const profiles = db.prepare(`
      SELECT p.*,
        (SELECT c.session_id FROM conversations c JOIN agents a ON a.id = c.agent_id
         WHERE a.profile_id = p.id AND a.state != 'stopped' LIMIT 1) as session_id
      FROM profiles p
      ORDER BY p.name
    `).all() as (Profile & { session_id: string | null })[];

    // Fetch all crew memberships + lead roles in one query
    const crewLinks = db.prepare(`
      SELECT cm.profile_id, c.id as crew_id, c.name as crew_name, c.icon as crew_icon, 'member' as role
      FROM crew_members cm
      JOIN crews c ON c.id = cm.crew_id
      UNION ALL
      SELECT a.profile_id, c.id as crew_id, c.name as crew_name, c.icon as crew_icon, 'lead' as role
      FROM crews c
      JOIN agents a ON a.id = c.lead_agent_id
      WHERE c.lead_agent_id IS NOT NULL
    `).all() as { profile_id: string; crew_id: string; crew_name: string; crew_icon: string; role: 'lead' | 'member' }[];

    // Group by profile_id
    const crewsByProfile = new Map<string, { id: string; name: string; icon: string; role: 'lead' | 'member' }[]>();
    for (const link of crewLinks) {
      if (!crewsByProfile.has(link.profile_id)) crewsByProfile.set(link.profile_id, []);
      crewsByProfile.get(link.profile_id)!.push({
        id: link.crew_id,
        name: link.crew_name,
        icon: link.crew_icon,
        role: link.role,
      });
    }

    // Fetch MCP assignments per profile
    const mcpLinks = db.prepare(`
      SELECT pm.profile_id, ms.id as mcp_id, ms.name as mcp_name, ms.type as mcp_type
      FROM profile_mcps pm
      JOIN mcp_servers ms ON ms.id = pm.mcp_server_id
    `).all() as { profile_id: string; mcp_id: string; mcp_name: string; mcp_type: string }[];

    const mcpsByProfile = new Map<string, { id: string; name: string; type: string }[]>();
    for (const link of mcpLinks) {
      if (!mcpsByProfile.has(link.profile_id)) mcpsByProfile.set(link.profile_id, []);
      mcpsByProfile.get(link.profile_id)!.push({
        id: link.mcp_id,
        name: link.mcp_name,
        type: link.mcp_type,
      });
    }

    // Agent counts per profile
    const agentCounts = db.prepare(`
      SELECT profile_id,
        COUNT(*) as total_agents,
        SUM(CASE WHEN state != 'stopped' THEN 1 ELSE 0 END) as active_agents
      FROM agents
      GROUP BY profile_id
    `).all() as { profile_id: string; total_agents: number; active_agents: number }[];

    const countsByProfile = new Map<string, { total_agents: number; active_agents: number }>();
    for (const c of agentCounts) {
      countsByProfile.set(c.profile_id, { total_agents: c.total_agents, active_agents: c.active_agents });
    }

    const enriched = profiles.map(p => ({
      ...p,
      crews: crewsByProfile.get(p.id) || [],
      mcps: mcpsByProfile.get(p.id) || [],
      active_agents: countsByProfile.get(p.id)?.active_agents ?? 0,
      total_agents: countsByProfile.get(p.id)?.total_agents ?? 0,
    }));

    return { profiles: enriched };
  });

  // Create a profile
  server.post<{
    Body: { name: string; icon?: string; system_prompt?: string; systemPrompt?: string; model?: string | null };
  }>('/profiles', async (request, reply) => {
    const { name, icon, system_prompt, systemPrompt, model } = request.body;
    const resolvedSystemPrompt = system_prompt || systemPrompt;
    if (!name) {
      reply.status(400);
      return { error: 'Name is required' };
    }
    if (model && !isValidModel(model)) {
      reply.status(400);
      return { error: `Invalid model: ${model}` };
    }

    const id = crypto.randomUUID();
    const workspaceDir = createProfileWorkspace(name);

    db.prepare(`
      INSERT INTO profiles (id, name, icon, system_prompt, workspace_dir, model)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, icon || '🤖', resolvedSystemPrompt || '', workspaceDir, model || null);

    // Global MCPs are merged at spawn time — no need to assign here

    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Profile;
    return { profile };
  });

  // Update a profile
  server.put<{
    Params: { id: string };
    Body: { name?: string; icon?: string; system_prompt?: string; model?: string | null };
  }>('/profiles/:id', async (request, reply) => {
    const { id } = request.params;
    const { name, icon, system_prompt, model } = request.body;

    if (model !== undefined && model !== null && !isValidModel(model)) {
      reply.status(400);
      return { error: `Invalid model: ${model}` };
    }

    const existing = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Profile | undefined;
    if (!existing) {
      reply.status(404);
      return { error: 'Profile not found' };
    }

    // If name changed and no workspace yet, create one
    const updatedName = name ?? existing.name;
    let workspaceDir = existing.workspace_dir;
    if (!workspaceDir) {
      workspaceDir = createProfileWorkspace(updatedName);
    }

    db.prepare(`
      UPDATE profiles
      SET name = ?, icon = ?, system_prompt = ?, workspace_dir = ?, model = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      updatedName,
      icon ?? existing.icon,
      system_prompt ?? existing.system_prompt,
      workspaceDir,
      model !== undefined ? (model || null) : existing.model,
      id,
    );

    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Profile;
    return { profile };
  });

  // Delete a profile
  server.delete<{ Params: { id: string } }>('/profiles/:id', async (request, reply) => {
    const { id } = request.params;
    const result = db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    if (result.changes === 0) {
      reply.status(404);
      return { error: 'Profile not found' };
    }
    return { ok: true };
  });

  // Legacy: session-profile linking removed in Phase 5. Use agents/conversations.
  server.post<{ Params: { id: string } }>('/profiles/:id/session', async (_request, reply) => {
    return reply.status(410).send({ error: 'Removed — use POST /api/agents to create an agent, then connect via agentId' });
  });

  // Get profile for a session (via conversation → agent → profile)
  server.get<{ Params: { sessionId: string } }>('/sessions/:sessionId/profile', async (request, reply) => {
    const { sessionId } = request.params;

    const row = db.prepare(`
      SELECT p.* FROM profiles p
      JOIN agents a ON a.profile_id = p.id
      JOIN conversations c ON c.agent_id = a.id
      WHERE c.session_id = ?
    `).get(sessionId) as Profile | undefined;

    if (!row) {
      return { profile: null };
    }
    return { profile: row };
  });
}
