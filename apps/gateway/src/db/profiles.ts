import db from './connection.js';
import type { MemberRef, CrewContext } from './types.js';

// Re-export workspace functions from index.ts (defined there to avoid circular deps with migrations)
export { createProfileWorkspace, createAgentWorkspace } from './connection.js';

// Get the MCP config object for a profile (to write as .mcp.json)
export function getProfileMcpConfig(profileId: string): Record<string, unknown> {
  const globals = db.prepare(`
    SELECT name, command, args, env, proxied FROM mcp_servers WHERE type = 'global'
  `).all() as { name: string; command: string; args: string; env: string; proxied: number }[];

  const profileMcps = db.prepare(`
    SELECT ms.name, ms.command, ms.args, ms.env, ms.proxied
    FROM profile_mcps pm
    JOIN mcp_servers ms ON ms.id = pm.mcp_server_id
    WHERE pm.profile_id = ?
  `).all(profileId) as { name: string; command: string; args: string; env: string; proxied: number }[];

  const gatewayBase = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
  for (const m of [...globals, ...profileMcps]) {
    const entry: { command: string; args?: string[]; env?: Record<string, string> } = { command: m.command };
    let args: string[] = JSON.parse(m.args);
    if (m.proxied) {
      args = args.map(a =>
        a.match(/^http:\/\/127\.0\.0\.1:\d+\/sse$/)
          ? `${gatewayBase}/mcp/${m.name}/sse`
          : a
      );
    }
    if (args.length > 0) entry.args = args;
    const env = JSON.parse(m.env);
    if (Object.keys(env).length > 0) entry.env = env;
    mcpServers[m.name] = entry;
  }

  return { mcpServers };
}

/**
 * Resolve the best agent for a profile within a specific crew.
 * Returns agent fields or nulls if no active agent exists.
 */
function resolveCrewMember(profileId: string, crewId: string): MemberRef {
  const profile = db.prepare(
    'SELECT id, name, icon FROM profiles WHERE id = ?'
  ).get(profileId) as { id: string; name: string; icon: string };

  // Find agent explicitly assigned to this crew, or fall back to best active agent
  const agent = db.prepare(`
    SELECT a.id, a.name, a.workspace_dir,
      (SELECT c.session_id FROM conversations c WHERE c.agent_id = a.id LIMIT 1) as session_id
    FROM agents a
    LEFT JOIN crew_members cm ON cm.agent_id = a.id AND cm.crew_id = ? AND cm.profile_id = ?
    WHERE a.profile_id = ? AND a.state != 'stopped'
    ORDER BY cm.agent_id IS NOT NULL DESC,
             CASE a.state WHEN 'working' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END,
             a.created_at DESC
    LIMIT 1
  `).get(crewId, profileId, profileId) as { id: string; name: string; workspace_dir: string; session_id: string | null } | undefined;

  return {
    profile_id: profile.id,
    profile_name: profile.name,
    icon: profile.icon,
    agent_id: agent?.id ?? null,
    agent_name: agent?.name ?? null,
    workspace_dir: agent?.workspace_dir ?? null,
    session_id: agent?.session_id ?? null,
  };
}

// Crew context for a profile — what crews they lead and belong to
export function getProfileCrewContext(profileId: string): CrewContext {
  const ledCrews = db.prepare(`
    SELECT c.id, c.name FROM crews c
    JOIN agents a ON a.id = c.lead_agent_id
    WHERE a.profile_id = ?
  `).all(profileId) as { id: string; name: string }[];

  const leading = ledCrews.map(crew => {
    const memberProfileIds = db.prepare(
      'SELECT profile_id FROM crew_members WHERE crew_id = ? ORDER BY profile_id'
    ).all(crew.id) as { profile_id: string }[];

    const members = memberProfileIds.map(m => resolveCrewMember(m.profile_id, crew.id));
    return { crew_name: crew.name, members };
  });

  const memberCrews = db.prepare(`
    SELECT c.id, c.name, c.lead_agent_id
    FROM crew_members cm
    JOIN crews c ON c.id = cm.crew_id
    WHERE cm.profile_id = ?
    ORDER BY c.name
  `).all(profileId) as { id: string; name: string; lead_agent_id: string | null }[];

  const memberOf = memberCrews.map(crew => {
    const leadProfileId = crew.lead_agent_id
      ? (db.prepare('SELECT profile_id FROM agents WHERE id = ?').get(crew.lead_agent_id) as { profile_id: string } | undefined)?.profile_id
      : null;
    const lead = leadProfileId
      ? resolveCrewMember(leadProfileId, crew.id)
      : null;

    const otherMemberIds = db.prepare(
      'SELECT profile_id FROM crew_members WHERE crew_id = ? AND profile_id != ? ORDER BY profile_id'
    ).all(crew.id, profileId) as { profile_id: string }[];

    const otherMembers = otherMemberIds.map(m => resolveCrewMember(m.profile_id, crew.id));

    return {
      crew_name: crew.name,
      lead,
      other_members: otherMembers,
    };
  });

  return { leading, memberOf };
}
