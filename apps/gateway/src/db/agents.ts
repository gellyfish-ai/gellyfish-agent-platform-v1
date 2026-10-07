import { randomUUID } from 'crypto';
import db, { createAgentWorkspace } from './connection.js';
import type { Agent, AgentState } from './types.js';
import { createConversation } from './conversations.js';

const MAX_AGENTS_PER_PROFILE = 5;

export function createAgent(profileId: string, name: string): Agent {
  // Enforce max agents per profile
  const count = db.prepare(
    `SELECT COUNT(*) as cnt FROM agents WHERE profile_id = ? AND state != 'stopped'`
  ).get(profileId) as { cnt: number };
  if (count.cnt >= MAX_AGENTS_PER_PROFILE) {
    throw new Error(`Maximum of ${MAX_AGENTS_PER_PROFILE} active agents per profile reached`);
  }

  const profile = db.prepare('SELECT name FROM profiles WHERE id = ?').get(profileId) as { name: string } | undefined;
  if (!profile) throw new Error(`Profile ${profileId} not found`);

  const id = randomUUID();
  const workspaceDir = createAgentWorkspace(name, profile.name);

  db.prepare(`
    INSERT INTO agents (id, profile_id, name, state, workspace_dir)
    VALUES (?, ?, ?, 'idle', ?)
  `).run(id, profileId, name, workspaceDir);

  // Auto-create conversation for the agent
  createConversation(id, name);

  return getAgent(id)!;
}

export function getAgent(id: string): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined;
}

export function listAgents(filters?: { profileId?: string; state?: AgentState }): Agent[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.profileId) {
    conditions.push('profile_id = ?');
    params.push(filters.profileId);
  }
  if (filters?.state) {
    conditions.push('state = ?');
    params.push(filters.state);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM agents ${where} ORDER BY created_at`).all(...params) as Agent[];
}

export function updateAgentState(id: string, state: AgentState): Agent | undefined {
  const sets = ['state = ?'];
  const params: unknown[] = [state];

  if (state === 'stopped') {
    sets.push("stopped_at = datetime('now')");
  }

  params.push(id);
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getAgent(id);
}

export function getAgentForProfile(profileId: string, creatorAgentId?: string): Agent | undefined {
  if (creatorAgentId) {
    // Prefer agents in the same crew as the creator
    // Find an agent for this profile that shares a crew with the creator agent
    const creatorAgent = getAgent(creatorAgentId);
    const sameCrew = creatorAgent ? db.prepare(`
      SELECT a.* FROM agents a
      JOIN crew_members cm ON cm.profile_id = a.profile_id
      JOIN crew_members creator_cm ON creator_cm.crew_id = cm.crew_id
        AND creator_cm.profile_id = ?
      WHERE a.profile_id = ? AND a.state != 'stopped'
      ORDER BY a.created_at LIMIT 1
    `).get(creatorAgent.profile_id, profileId) as Agent | undefined : undefined;
    if (sameCrew) return sameCrew;
  }
  // Fallback: any agent of this profile
  return db.prepare(
    `SELECT * FROM agents WHERE profile_id = ? AND state != 'stopped' ORDER BY created_at LIMIT 1`
  ).get(profileId) as Agent | undefined;
}

