/**
 * Heartbeat module — periodic idle detection and silent hang checks.
 * Extracted from index.ts for SOLID/DRY/KISS compliance.
 */

import db from './db/index.js';
import { getAllActiveProcesses } from './routes/chat-ws.js';
import { sendMessage, getActiveProcessByAgent } from './session-send.js';
import { sendToSocket } from './ws/broadcast.js';
import { prefixMessage } from './session/format.js';
import { logger } from './logger.js';

const IDLE_TIMEOUT_MS = parseInt(process.env.AGENT_IDLE_TIMEOUT_MS || '', 10) || 5 * 60 * 1000;
const SILENT_HANG_MS = 5 * 60 * 1000;

/** Start the heartbeat interval (default 60s). */
export function startHeartbeat(intervalMs = 60_000): void {
  setInterval(() => {
    checkSilentHangs();
    checkIdleAgents();
  }, intervalMs);
}

// --- Helpers ---

function getAgentName(agentId: string | undefined): string {
  if (!agentId) return 'unknown';
  const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
  return row?.name || agentId.substring(0, 8);
}

function getCrewLeadAgentId(agentId: string): string | null {
  const row = db.prepare(`
    SELECT c.lead_agent_id FROM crew_members cm
    JOIN crews c ON c.id = cm.crew_id
    WHERE cm.agent_id = ? AND c.lead_agent_id IS NOT NULL
    LIMIT 1
  `).get(agentId) as { lead_agent_id: string } | undefined;
  return row?.lead_agent_id ?? null;
}

// --- Silent hang detection ---

function checkSilentHangs(): void {
  for (const [, managed] of getAllActiveProcesses()) {
    if (!managed.alive || !managed.lastStdinAt || !managed.lastActivityAt) continue;
    if (managed.lastStdinAt.getTime() <= managed.lastActivityAt.getTime()) continue;
    if (Date.now() - managed.lastStdinAt.getTime() < SILENT_HANG_MS) continue;

    logger.warn({
      sessionId: managed.sessionId,
      agentId: managed.agentId,
      agentName: getAgentName(managed.agentId),
      lastStdinAt: managed.lastStdinAt.toISOString(),
      lastActivityAt: managed.lastActivityAt.toISOString(),
      lastEventType: managed.lastEventType,
      pid: managed.pid,
    }, '[heartbeat] possible silent hang — stdin written but no stdout for 5+ minutes');
  }
}

// --- Unified idle detection ---

function checkIdleAgents(): void {
  for (const [, managed] of getAllActiveProcesses()) {
    if (!managed.alive || !managed.agentId) continue;
    if (managed.staleNotified) continue;

    const idleMs = managed.lastActivityAt
      ? Date.now() - managed.lastActivityAt.getTime()
      : (managed.lastStdinAt ? Date.now() - managed.lastStdinAt.getTime() : 0);
    if (idleMs < IDLE_TIMEOUT_MS) continue;

    // Skip if agent has active tasks
    const activeTasks = db.prepare(
      "SELECT COUNT(*) as cnt FROM tasks WHERE assignee_agent_id = ? AND state NOT IN ('completed', 'failed', 'canceled')"
    ).get(managed.agentId) as { cnt: number };
    if (activeTasks.cnt > 0) continue;

    managed.staleNotified = true;

    const agentName = getAgentName(managed.agentId);
    const idleMin = Math.round(idleMs / 60_000);
    const lastActivity = managed.lastActivityAt
      ? managed.lastActivityAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
      : 'unknown';

    logger.warn({ sessionId: managed.sessionId, agentId: managed.agentId, agentName, idleMin }, '[heartbeat] agent idle');

    const idleEvent = {
      type: 'agent_idle',
      agentId: managed.agentId,
      agentName,
      sessionId: managed.sessionId,
      idleMinutes: idleMin,
      lastActivityAt: managed.lastActivityAt?.toISOString(),
      lastEventType: managed.lastEventType,
    };

    // Send to the idle agent's own session sockets (for anyone viewing that tab)
    sendToSocket(managed, idleEvent);

    // CLI injection + targeted browser notification to crew lead
    const leadAgentId = getCrewLeadAgentId(managed.agentId);
    if (leadAgentId) {
      const leadAgent = db.prepare('SELECT profile_id FROM agents WHERE id = ?').get(leadAgentId) as { profile_id: string } | undefined;
      if (leadAgent) {
        // Send to crew lead's browser session so the alert renders in their chat view
        const leadManaged = getActiveProcessByAgent(leadAgentId);
        if (leadManaged && leadManaged !== managed) {
          sendToSocket(leadManaged, idleEvent);
        }

        const msg = prefixMessage('system', 'gateway', `Agent ${agentName} has been idle for ${idleMin}+ minutes. Last activity: ${managed.lastEventType || 'unknown'} at ${lastActivity}.`);
        sendMessage({ profileId: leadAgent.profile_id, agentId: leadAgentId, message: msg }).catch(err => {
          logger.warn({ agentId: managed.agentId, error: String(err) }, '[heartbeat] failed to inject idle notification into crew lead');
        });
      }
    }
  }
}
