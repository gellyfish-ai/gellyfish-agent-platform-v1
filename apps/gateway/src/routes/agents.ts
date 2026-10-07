import { existsSync, readFileSync, copyFileSync, mkdirSync } from 'fs';
import crypto from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import { FastifyInstance } from 'fastify';
import db, {
  Agent, AgentState,
  createAgent, getAgent, listAgents, updateAgentState, getAgentForProfile,
  getAgentConversation,
} from '../db/index.js';
import { getActiveProcessByAgent, isProcessStale, formatUserMessage, killSession, destroySession, sendMessage } from '../session-send.js';
import { broadcastToAll } from './chat-ws.js';
import { resolveModel } from '../models.js';
import { pmClient } from '../pm-client.js';
import { logger } from '../logger.js';

export async function agentsRoutes(server: FastifyInstance) {
  // POST /api/agents — hire an agent from a profile
  server.post<{
    Body: { profileId: string; name?: string; crewId?: string };
  }>('/agents', async (req, reply) => {
    const { profileId, name, crewId } = req.body;
    if (!profileId) return reply.status(400).send({ error: 'profileId is required' });

    const profile = db.prepare('SELECT id, name FROM profiles WHERE id = ?').get(profileId) as { id: string; name: string } | undefined;
    if (!profile) return reply.status(404).send({ error: 'Profile not found' });

    // Validate crew membership before creating agent
    if (crewId) {
      const crew = db.prepare('SELECT id FROM crews WHERE id = ?').get(crewId);
      if (!crew) return reply.status(404).send({ error: 'Crew not found' });
      const existing = db.prepare('SELECT 1 FROM crew_members WHERE crew_id = ? AND profile_id = ?').get(crewId, profileId);
      if (existing) return reply.status(409).send({ error: 'This profile already has an agent in this crew' });
    }

    // Auto-name: "<ProfileName> #N"
    const agentName = name || generateAgentName(profileId, profile.name);

    let agent: Agent;
    try {
      agent = createAgent(profileId, agentName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Maximum of')) return reply.status(409).send({ error: msg });
      throw err;
    }

    // Add to crew
    if (crewId) {
      db.prepare('INSERT INTO crew_members (crew_id, profile_id, agent_id) VALUES (?, ?, ?)').run(crewId, profileId, agent.id);
    }

    const conversation = getAgentConversation(agent.id);
    const profile2 = db.prepare('SELECT name, icon FROM profiles WHERE id = ?').get(profileId) as { name: string; icon: string } | undefined;

    broadcastToAll({
      type: 'agent_hired',
      agent: { ...agent, profile_name: profile2?.name, profile_icon: profile2?.icon },
      conversation,
    });

    return { agent, conversation };
  });

  // GET /api/agents — list agents
  server.get<{
    Querystring: { profileId?: string; crewId?: string; state?: AgentState };
  }>('/agents', async (req) => {
    let agents: Agent[];

    if (req.query.crewId) {
      // Filter by crew membership — join on profile_id, prefer explicit agent_id,
      // fall back to most recent active agent for the profile
      agents = db.prepare(`
        SELECT a.* FROM agents a
        JOIN crew_members cm ON cm.profile_id = a.profile_id
        WHERE cm.crew_id = ?
        AND a.state != 'stopped'
        AND (cm.agent_id = a.id OR (cm.agent_id IS NULL AND a.id = (
          SELECT a2.id FROM agents a2
          WHERE a2.profile_id = a.profile_id AND a2.state != 'stopped'
          ORDER BY CASE a2.state WHEN 'working' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END,
                   a2.created_at DESC
          LIMIT 1
        )))
        ${req.query.state ? 'AND a.state = ?' : ''}
        ORDER BY a.name
      `).all(...[req.query.crewId, ...(req.query.state ? [req.query.state] : [])]) as Agent[];
    } else {
      agents = listAgents({
        profileId: req.query.profileId,
        state: req.query.state,
      });
    }

    // Enrich with conversation state, issue number, process status, profile info, crew info
    const enriched = agents.map(a => {
      const conv = getAgentConversation(a.id);
      const process = getActiveProcessByAgent(a.id);
      const profile = db.prepare('SELECT name, icon FROM profiles WHERE id = ?').get(a.profile_id) as { name: string; icon: string } | undefined;
      const crew = db.prepare(`
        SELECT c.id, c.name, c.icon FROM crew_members cm
        JOIN crews c ON c.id = cm.crew_id
        WHERE cm.agent_id = ?
      `).get(a.id) as { id: string; name: string; icon: string } | undefined;
      return {
        ...a,
        profile_name: profile?.name,
        profile_icon: profile?.icon,
        session_id: conv?.session_id ?? null,
        conversation_id: conv?.id ?? null,
        conversation_state: conv?.state ?? null,
        issue_number: conv?.issue_number ?? null,
        process_alive: process?.alive ?? false,
        crew_id: crew?.id ?? null,
        crew_name: crew?.name ?? null,
        crew_icon: crew?.icon ?? null,
      };
    });

    return { agents: enriched };
  });

  // GET /api/agents/:id — get agent detail
  server.get<{ Params: { id: string } }>('/agents/:id', async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const conversation = getAgentConversation(agent.id);
    const profile = db.prepare('SELECT id, name, icon FROM profiles WHERE id = ?').get(agent.profile_id) as { id: string; name: string; icon: string } | undefined;

    return { agent, conversation, profile };
  });

  // PUT /api/agents/:id — update agent (rename, change state)
  server.put<{
    Params: { id: string };
    Body: { name?: string; state?: AgentState };
  }>('/agents/:id', async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    if (req.body.name) {
      db.prepare('UPDATE agents SET name = ? WHERE id = ?').run(req.body.name, agent.id);
    }

    if (req.body.state) {
      updateAgentState(agent.id, req.body.state);
    }

    return { agent: getAgent(agent.id) };
  });

  // DELETE /api/agents/:id — fire agent (soft-delete)
  server.delete<{
    Params: { id: string };
    Querystring: { force?: string };
  }>('/agents/:id', async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    if (agent.state === 'stopped') {
      return reply.status(409).send({ error: 'Agent is already stopped' });
    }

    if (req.query.force !== 'true') {
      // Check crew memberships for this specific agent
      const crews = db.prepare(`
        SELECT c.name FROM crew_members cm
        JOIN crews c ON c.id = cm.crew_id
        WHERE cm.agent_id = ?
      `).all(agent.id) as Array<{ name: string }>;
      if (crews.length > 0) {
        return reply.status(409).send({
          error: `Agent is in crew(s): ${crews.map(c => c.name).join(', ')}. Use ?force=true to fire anyway.`,
          crews,
        });
      }

      // Check for active tasks
      const activeTasks = db.prepare(`
        SELECT COUNT(*) as cnt FROM tasks
        WHERE assignee_agent_id = ? AND state NOT IN ('completed', 'failed', 'canceled')
      `).get(agent.id) as { cnt: number };
      if (activeTasks.cnt > 0) {
        return reply.status(409).send({
          error: `Agent has ${activeTasks.cnt} active task(s). Use ?force=true to fire anyway.`,
        });
      }
    }

    // Kill the OS process if running
    const managed = getActiveProcessByAgent(agent.id);
    if (managed) {
      await killSession(managed.sessionId);
      server.log.info({ agentId: agent.id, sessionId: managed.sessionId }, '[agents] killed process for stopped agent');
    }

    updateAgentState(agent.id, 'stopped');

    return { agent: getAgent(agent.id) };
  });

  // POST /api/agents/:id/restore — un-stop a fired agent
  server.post<{
    Params: { id: string };
    Body: { crewId?: string };
  }>('/agents/:id/restore', async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    if (agent.state !== 'stopped') {
      return reply.status(409).send({ error: 'Agent is not stopped' });
    }

    updateAgentState(agent.id, 'idle');

    // Optionally re-add to crew
    if (req.body?.crewId) {
      const crew = db.prepare('SELECT id FROM crews WHERE id = ?').get(req.body.crewId);
      if (!crew) return reply.status(404).send({ error: 'Crew not found' });
      db.prepare('INSERT OR IGNORE INTO crew_members (crew_id, profile_id, agent_id) VALUES (?, ?, ?)').run(req.body.crewId, agent.profile_id, agent.id);
    }

    return { agent: getAgent(agent.id) };
  });

  // GET /api/agents/health — all non-stopped agents with health data
  server.get('/agents/health', async () => {
    const agents = db.prepare(`
      SELECT a.id, a.name, a.state, a.profile_id,
        p.name as profile_name, p.icon as profile_icon, p.model as profile_model,
        c.id as conversation_id, c.state as conversation_state,
        c.session_id, c.issue_number
      FROM agents a
      JOIN profiles p ON p.id = a.profile_id
      LEFT JOIN conversations c ON c.agent_id = a.id
      WHERE a.state != 'stopped'
      ORDER BY a.name
    `).all() as Array<{
      id: string; name: string; state: string; profile_id: string;
      profile_name: string; profile_icon: string; profile_model: string | null;
      conversation_id: string | null; conversation_state: string | null;
      session_id: string | null; issue_number: number | null;
    }>;

    const enriched = agents.map(a => {
      const process = getActiveProcessByAgent(a.id);
      const stale = process ? isProcessStale(process) : false;

      // Find active task for this agent
      const activeTask = db.prepare(`
        SELECT id, state, substr(message, 1, 80) as message_preview, created_at
        FROM tasks
        WHERE assignee_agent_id = ? AND state NOT IN ('completed', 'failed', 'canceled')
        ORDER BY created_at DESC LIMIT 1
      `).get(a.id) as { id: string; state: string; message_preview: string; created_at: string } | undefined;

      const crews = db.prepare(`
        SELECT DISTINCT c.id, c.name FROM crews c
        JOIN crew_members cm ON cm.crew_id = c.id
        WHERE cm.agent_id = ?
      `).all(a.id) as Array<{ id: string; name: string }>;

      return {
        ...a,
        model: resolveModel(a.profile_model),
        process_alive: process?.alive ?? false,
        process_pid: process?.pid ?? null,
        last_activity_at: process?.lastActivityAt?.toISOString() ?? null,
        last_event_type: process?.lastEventType ?? null,
        stale,
        active_task: activeTask || null,
        crews,
      };
    });

    return { agents: enriched };
  });

  // GET /api/agents/by-profile/:profileId — get the default agent for a profile (backward compat)
  server.get<{ Params: { profileId: string } }>('/agents/by-profile/:profileId', async (req, reply) => {
    const agent = getAgentForProfile(req.params.profileId);
    if (!agent) return reply.status(404).send({ error: 'No agent found for profile' });
    return { agent };
  });

  // POST /api/agents/:id/refresh-config — notify agent to re-read CLAUDE.md
  server.post<{ Params: { id: string } }>('/agents/:id/refresh-config', async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const process = getActiveProcessByAgent(agent.id);
    if (!process?.alive) {
      return reply.status(409).send({ error: 'Agent has no running process — changes will apply on next start' });
    }

    const profile = db.prepare('SELECT workspace_dir FROM profiles WHERE id = ?').get(agent.profile_id) as { workspace_dir: string } | undefined;
    const claudeMdPath = profile?.workspace_dir ? `${profile.workspace_dir}/CLAUDE.md` : 'your workspace';

    const msg = `[System] Your CLAUDE.md has been updated. Please re-read it now: ${claudeMdPath}`;
    try {
      await pmClient.inject(process.pmSessionId, formatUserMessage(msg));
      logger.info({ agentId: agent.id, agentName: agent.name, pid: process.pid }, '[agent] refresh-config injected');
      return { ok: true, message: 'Agent notified to re-read CLAUDE.md' };
    } catch (err) {
      logger.error({ agentId: agent.id, error: String(err) }, '[agent] refresh-config inject failed');
      return reply.status(500).send({ error: 'Failed to notify agent' });
    }
  });

  // --- Agent lifecycle management (#694) ---

  // POST /api/agents/:id/respawn — kill process, compact old session, spawn fresh
  server.post<{ Params: { id: string } }>('/agents/:id/respawn', async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    if (agent.state === 'stopped') return reply.status(409).send({ error: 'Agent is stopped — restore it first' });

    const conversation = getAgentConversation(agent.id);
    const previousSessionId = conversation?.session_id || null;

    // Step 1: Kill running process + compact old session
    if (previousSessionId) {
      await destroySession(previousSessionId, agent.profile_id);
      logger.info({ agentId: agent.id, sessionId: previousSessionId }, '[agent] respawn — destroyed old session');
    } else {
      // No session but might have a running process
      const process = getActiveProcessByAgent(agent.id);
      if (process) {
        await killSession(process.sessionId);
        logger.info({ agentId: agent.id, sessionId: process.sessionId }, '[agent] respawn — killed orphan process');
      }
    }

    // Step 2: Spawn fresh process
    const result = await sendMessage({
      profileId: agent.profile_id,
      agentId: agent.id,
      message: '[System] You have been respawned with a fresh session. Read your CLAUDE.md and check for any pending tasks.',
    });

    if (!result.delivered) {
      logger.error({ agentId: agent.id, error: result.error }, '[agent] respawn — spawn failed');
      return reply.status(500).send({ error: `Spawn failed: ${result.error}` });
    }

    logger.info({ agentId: agent.id, previousSessionId, newSessionId: result.sessionId }, '[agent] respawn complete');
    return { ok: true, previousSessionId, newSessionId: result.sessionId };
  });

  // POST /api/agents/:id/sync-config — pull config from HQ and write to workspace
  server.post<{ Params: { id: string } }>('/agents/:id/sync-config', async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const profile = db.prepare('SELECT name, workspace_dir FROM profiles WHERE id = ?')
      .get(agent.profile_id) as { name: string; workspace_dir: string } | undefined;
    if (!profile) return reply.status(404).send({ error: 'Profile not found' });

    const hqPath = process.env.HQ_PATH || join(homedir(), 'Workspace', 'gellyfish-hq');
    const profileSlug = profile.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const hqProfileDir = join(hqPath, 'GAP', 'profiles', profileSlug);

    if (!existsSync(hqProfileDir)) {
      return reply.status(404).send({ error: `HQ profile dir not found: ${hqProfileDir}` });
    }

    const targetDir = agent.workspace_dir;
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    const filesToSync = ['config.json', 'system-prompt.md', 'CLAUDE.md'];
    const synced: string[] = [];

    for (const file of filesToSync) {
      const src = join(hqProfileDir, file);
      if (existsSync(src)) {
        const dst = join(targetDir, file);
        copyFileSync(src, dst);
        synced.push(file);
        logger.info({ agentId: agent.id, file, src, dst }, '[agent] sync-config — copied file');
      }
    }

    // Notify running agent to re-read config
    const process2 = getActiveProcessByAgent(agent.id);
    let agentAlive = false;
    if (process2?.alive) {
      agentAlive = true;
      const claudeMdPath = join(targetDir, 'CLAUDE.md');
      const msg = `[System] Your configuration files have been updated from HQ (${synced.join(', ')}). Please re-read your CLAUDE.md now: ${claudeMdPath}`;
      try {
        await pmClient.inject(process2.pmSessionId, formatUserMessage(msg));
      } catch (err) {
        logger.warn({ agentId: agent.id, error: String(err) }, '[agent] sync-config — inject notification failed');
      }
    }

    return { ok: true, synced, agentAlive };
  });

  // GET /api/agents/:id/config — inspect agent's effective configuration
  server.get<{ Params: { id: string } }>('/agents/:id/config', async (req, reply) => {
    const agent = getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const dir = agent.workspace_dir;
    const config: Record<string, unknown> = { agentId: agent.id, workspaceDir: dir };

    // .mcp.json — MCP server names
    const mcpPath = join(dir, '.mcp.json');
    if (existsSync(mcpPath)) {
      try {
        const mcpData = JSON.parse(readFileSync(mcpPath, 'utf-8'));
        config.mcpServers = Object.keys(mcpData.mcpServers || {});
      } catch { config.mcpServers = null; }
    } else {
      config.mcpServers = null;
    }

    // CLAUDE.md — preview + hash
    const claudeMdPath = join(dir, 'CLAUDE.md');
    if (existsSync(claudeMdPath)) {
      const content = readFileSync(claudeMdPath, 'utf-8');
      config.claudeMd = {
        preview: content.substring(0, 500),
        hash: crypto.createHash('sha256').update(content).digest('hex'),
        length: content.length,
      };
    } else {
      config.claudeMd = null;
    }

    // system-prompt.md — preview + hash
    const sysPromptPath = join(dir, 'system-prompt.md');
    if (existsSync(sysPromptPath)) {
      const content = readFileSync(sysPromptPath, 'utf-8');
      config.systemPrompt = {
        preview: content.substring(0, 500),
        hash: crypto.createHash('sha256').update(content).digest('hex'),
        length: content.length,
      };
    } else {
      config.systemPrompt = null;
    }

    // config.json — model, allowed/disallowed tools
    const configJsonPath = join(dir, 'config.json');
    if (existsSync(configJsonPath)) {
      try {
        config.configJson = JSON.parse(readFileSync(configJsonPath, 'utf-8'));
      } catch { config.configJson = null; }
    } else {
      config.configJson = null;
    }

    return config;
  });

  // --- Open tabs (server-side, syncs across devices) ---

  // GET /api/tabs — list open tab agent IDs
  server.get('/tabs', async () => {
    const tabs = db.prepare('SELECT agent_id FROM open_tabs ORDER BY opened_at').all() as { agent_id: string }[];
    return { tabs: tabs.map(t => t.agent_id) };
  });

  // POST /api/tabs/:agentId — open a tab
  server.post<{ Params: { agentId: string } }>('/tabs/:agentId', async (req, reply) => {
    const { agentId } = req.params;
    const agent = getAgent(agentId);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    db.prepare('INSERT OR IGNORE INTO open_tabs (agent_id) VALUES (?)').run(agentId);
    // Broadcast to all connected browsers
    broadcastToAll({ type: 'tab_opened', agentId });
    return { ok: true };
  });

  // DELETE /api/tabs/:agentId — close a tab
  server.delete<{ Params: { agentId: string } }>('/tabs/:agentId', async (req) => {
    db.prepare('DELETE FROM open_tabs WHERE agent_id = ?').run(req.params.agentId);
    broadcastToAll({ type: 'tab_closed', agentId: req.params.agentId });
    return { ok: true };
  });
}

function generateAgentName(profileId: string, profileName: string): string {
  const existing = db.prepare(
    `SELECT name FROM agents WHERE profile_id = ? ORDER BY created_at`
  ).all(profileId) as { name: string }[];

  // Find next available number
  const pattern = new RegExp(`^${profileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} #(\\d+)$`);
  const usedNumbers = existing
    .map(a => pattern.exec(a.name)?.[1])
    .filter(Boolean)
    .map(Number);

  const next = usedNumbers.length > 0 ? Math.max(...usedNumbers) + 1 : 1;
  return `${profileName} #${next}`;
}
