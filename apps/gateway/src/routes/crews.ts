import { FastifyInstance } from 'fastify';
import db, { Crew, CrewMember, Profile } from '../db/index.js';

function generateCrewSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let slug = base;
  let attempt = 0;
  while (db.prepare('SELECT 1 FROM crews WHERE slug = ?').get(slug)) {
    attempt++;
    slug = `${base}-${attempt}`;
  }
  return slug;
}

export async function crewsRoutes(server: FastifyInstance) {
  // List all crews with lead info + member count
  server.get('/crews', async () => {
    const crews = db.prepare(`
      SELECT c.*, a.name as lead_name, p.icon as lead_icon,
        (SELECT COUNT(*) FROM crew_members cm WHERE cm.crew_id = c.id) as member_count
      FROM crews c
      LEFT JOIN agents a ON a.id = c.lead_agent_id
      LEFT JOIN profiles p ON p.id = a.profile_id
      ORDER BY c.name
    `).all() as (Crew & { lead_name: string | null; lead_icon: string | null; member_count: number })[];

    return { crews };
  });

  // Create a crew
  server.post<{
    Body: { name: string; icon?: string; lead_agent_id?: string };
  }>('/crews', async (request, reply) => {
    const { name, icon, lead_agent_id } = request.body;
    if (!name) {
      reply.status(400);
      return { error: 'Name is required' };
    }

    if (lead_agent_id) {
      const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(lead_agent_id);
      if (!agent) {
        reply.status(400);
        return { error: 'Lead agent not found' };
      }
    }

    const id = crypto.randomUUID();
    const slug = generateCrewSlug(name);
    db.prepare(`
      INSERT INTO crews (id, name, slug, icon, lead_agent_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, slug, icon || 'users', lead_agent_id || null);

    const crew = db.prepare('SELECT * FROM crews WHERE id = ?').get(id) as Crew;
    return { crew };
  });

  // Get one crew with full member list
  server.get<{ Params: { id: string } }>('/crews/:id', async (request, reply) => {
    const { id } = request.params;

    const crew = db.prepare(`
      SELECT c.*, a.name as lead_name, p.icon as lead_icon
      FROM crews c
      LEFT JOIN agents a ON a.id = c.lead_agent_id
      LEFT JOIN profiles p ON p.id = a.profile_id
      WHERE c.id = ?
    `).get(id) as (Crew & { lead_name: string | null; lead_icon: string | null }) | undefined;

    if (!crew) {
      reply.status(404);
      return { error: 'Crew not found' };
    }

    const members = db.prepare(`
      SELECT p.id, p.name, p.icon, cm.added_at
      FROM crew_members cm
      JOIN profiles p ON p.id = cm.profile_id
      WHERE cm.crew_id = ?
      ORDER BY p.name
    `).all(id) as (Pick<Profile, 'id' | 'name' | 'icon'> & { added_at: string })[];

    return { crew, members };
  });

  // Update a crew
  server.put<{
    Params: { id: string };
    Body: { name?: string; icon?: string; lead_agent_id?: string | null };
  }>('/crews/:id', async (request, reply) => {
    const { id } = request.params;
    const { name, icon, lead_agent_id } = request.body;

    const existing = db.prepare('SELECT * FROM crews WHERE id = ?').get(id) as Crew | undefined;
    if (!existing) {
      reply.status(404);
      return { error: 'Crew not found' };
    }

    const newLeadId = lead_agent_id !== undefined ? lead_agent_id : existing.lead_agent_id;
    if (newLeadId) {
      const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(newLeadId);
      if (!agent) {
        reply.status(400);
        return { error: 'Lead agent not found' };
      }
    }

    db.prepare(`
      UPDATE crews
      SET name = ?, icon = ?, lead_agent_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? existing.name,
      icon ?? existing.icon,
      newLeadId || null,
      id,
    );

    const crew = db.prepare('SELECT * FROM crews WHERE id = ?').get(id) as Crew;
    return { crew };
  });

  // Delete a crew
  server.delete<{ Params: { id: string } }>('/crews/:id', async (request, reply) => {
    const { id } = request.params;
    const result = db.prepare('DELETE FROM crews WHERE id = ?').run(id);
    if (result.changes === 0) {
      reply.status(404);
      return { error: 'Crew not found' };
    }
    return { ok: true };
  });

  // Add member to crew (accepts profile_id/profileId and/or agent_id/agentId)
  server.post<{
    Params: { id: string };
    Body: { profile_id?: string; profileId?: string; agent_id?: string; agentId?: string };
  }>('/crews/:id/members', async (request, reply) => {
    const { id } = request.params;
    const profile_id = request.body.profile_id || request.body.profileId;
    const agent_id = request.body.agent_id || request.body.agentId;

    if (!profile_id) {
      reply.status(400);
      return { error: 'profile_id or profileId is required' };
    }

    const crew = db.prepare('SELECT id FROM crews WHERE id = ?').get(id);
    if (!crew) {
      reply.status(404);
      return { error: 'Crew not found' };
    }

    const profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profile_id);
    if (!profile) {
      reply.status(400);
      return { error: 'Profile not found' };
    }

    if (agent_id) {
      const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(agent_id);
      if (!agent) {
        reply.status(400);
        return { error: 'Agent not found' };
      }
    }

    try {
      db.prepare(`
        INSERT INTO crew_members (crew_id, profile_id, agent_id) VALUES (?, ?, ?)
      `).run(id, profile_id, agent_id ?? null);
    } catch {
      // Already a member (PRIMARY KEY conflict)
      reply.status(409);
      return { error: 'Profile is already a member of this crew' };
    }

    return { ok: true };
  });

  // Remove member from crew
  server.delete<{
    Params: { id: string; profileId: string };
  }>('/crews/:id/members/:profileId', async (request, reply) => {
    const { id, profileId } = request.params;
    const result = db.prepare('DELETE FROM crew_members WHERE crew_id = ? AND profile_id = ?').run(id, profileId);
    if (result.changes === 0) {
      reply.status(404);
      return { error: 'Member not found in crew' };
    }
    return { ok: true };
  });
}
