import { FastifyInstance } from 'fastify';
import db, { listTasks, Task } from '../db/index.js';
import { getAllActiveProcesses } from './chat-ws.js';
import { pmClient } from '../pm-client.js';
import { getVersionInfo } from './version.js';

export async function statusRoutes(server: FastifyInstance) {
  // GET /api/status — live system state from PM + gateway
  server.get('/status', async () => {
    // Get process info from PM (authoritative source)
    let pmProcesses: Array<{
      sessionId: string;
      profileId?: string;
      pid: number;
      alive: boolean;
    }> = [];

    try {
      pmProcesses = await pmClient.list();
    } catch {
      // PM not connected — fall back to local map
    }

    // Enrich with gateway-side info (socket state, profile names, agent/conversation data)
    const localMap = getAllActiveProcesses();
    const processes = pmProcesses.map(p => {
      const local = localMap.get(p.sessionId);
      let profileName: string | undefined;
      const profileId = p.profileId || local?.profileId;
      if (profileId) {
        const row = db.prepare('SELECT name FROM profiles WHERE id = ?').get(profileId) as { name: string } | undefined;
        profileName = row?.name;
      }

      // Agent/conversation info from the process registry or DB
      const agentId = local?.agentId;
      const conversationId = local?.conversationId;
      let agentName: string | undefined;
      let conversationState: string | undefined;
      if (agentId) {
        const agentRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
        agentName = agentRow?.name;
      }
      let resolvedConvId = conversationId;
      let conversationSessionId: string | null = null;
      if (conversationId) {
        const convRow = db.prepare('SELECT state, session_id FROM conversations WHERE id = ?').get(conversationId) as { state: string; session_id: string | null } | undefined;
        conversationState = convRow?.state;
        conversationSessionId = convRow?.session_id ?? null;
      } else if (p.sessionId) {
        const convRow = db.prepare('SELECT id, state, session_id, agent_id FROM conversations WHERE session_id = ?').get(p.sessionId) as { id: string; state: string; session_id: string | null; agent_id: string } | undefined;
        if (convRow) {
          resolvedConvId = convRow.id;
          conversationState = convRow.state;
          conversationSessionId = convRow.session_id;
          if (!agentName) {
            const agentRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(convRow.agent_id) as { name: string } | undefined;
            agentName = agentRow?.name;
          }
        }
      }

      const sessionMatch = conversationSessionId != null
        ? conversationSessionId === p.sessionId
        : null; // null = no conversation to compare

      return {
        sessionId: p.sessionId,
        profileId,
        profileName,
        agentId,
        agentName,
        conversationId: resolvedConvId,
        conversationState,
        conversationSessionId,
        sessionMatch,
        pid: p.pid,
        alive: p.alive,
        hasSocket: (local?.sockets.size ?? 0) > 0,
        socketCount: local?.sockets.size ?? 0,
        pendingPermissions: local?.pendingPermissions.size ?? 0,
        lastActivityAt: local?.lastActivityAt?.toISOString() ?? null,
        lastEventType: local?.lastEventType ?? null,
        stale: local ? (local.alive && local.lastActivityAt && (Date.now() - local.lastActivityAt.getTime() > 5 * 60 * 1000)) : false,
      };
    });

    // In-flight tasks
    const inFlight = listTasks().filter(t => !['completed', 'failed', 'canceled'].includes(t.state));

    // Recent terminal tasks (last 10)
    const recent = db.prepare(`
      SELECT t.*, ca.name as creator_name, aa.name as assignee_name
      FROM tasks t
      LEFT JOIN agents ca ON ca.id = t.creator_agent_id
      LEFT JOIN agents aa ON aa.id = t.assignee_agent_id
      WHERE t.state IN ('completed', 'failed', 'canceled')
      ORDER BY t.updated_at DESC
      LIMIT 10
    `).all() as (Task & { creator_name: string; assignee_name: string })[];

    const inFlightEnriched = inFlight.map(t => {
      const creator = t.creator_agent_id ? db.prepare('SELECT name FROM agents WHERE id = ?').get(t.creator_agent_id) as { name: string } | undefined : undefined;
      const assignee = t.assignee_agent_id ? db.prepare('SELECT name FROM agents WHERE id = ?').get(t.assignee_agent_id) as { name: string } | undefined : undefined;
      return { ...t, creator_name: creator?.name, assignee_name: assignee?.name };
    });

    // Orphaned conversations: state = active but no running process
    const processSessionIds = new Set(pmProcesses.map(p => p.sessionId));
    const orphanedConversations = db.prepare(`
      SELECT c.id, c.session_id, c.state, a.name as agent_name, a.id as agent_id
      FROM conversations c
      JOIN agents a ON a.id = c.agent_id
      WHERE c.state = 'active' AND c.session_id IS NOT NULL
    `).all() as Array<{ id: string; session_id: string; state: string; agent_name: string; agent_id: string }>;
    const orphaned = orphanedConversations.filter(c => !processSessionIds.has(c.session_id));

    // Agents without conversations (integrity error)
    const agentsWithoutConv = db.prepare(`
      SELECT a.id, a.name, a.state FROM agents a
      WHERE a.state != 'stopped'
      AND a.id NOT IN (SELECT agent_id FROM conversations)
    `).all() as Array<{ id: string; name: string; state: string }>;

    return {
      version: getVersionInfo(),
      pm: { connected: pmClient.isConnected() },
      processes,
      integrity: {
        orphanedConversations: orphaned,
        agentsWithoutConversation: agentsWithoutConv,
      },
      tasks: {
        inFlight: inFlightEnriched,
        recent,
      },
    };
  });
}
