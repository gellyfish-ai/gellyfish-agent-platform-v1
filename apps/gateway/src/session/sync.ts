import db, { ConversationState, updateConversationState, updateAgentState } from '../db/index.js';
import { pmClient } from '../pm-client.js';
import { logger } from '../logger.js';
import type { ManagedProcess } from './types.js';
import { getActiveProcess, getAllActiveProcesses, registerProcess, unregisterProcess } from './registry.js';
import { handlePMEvent } from '../ws/spawn.js';

export async function syncFromPM(): Promise<void> {
  try {
    const processList = await pmClient.list();
    logger.info({ count: processList.length }, '[sync] rebuilding activeProcesses from PM');

    for (const proc of processList) {
      if (!getActiveProcess(proc.sessionId)) {
        let convRow = db.prepare(
          'SELECT c.id as conv_id, c.agent_id FROM conversations c WHERE c.session_id = ? LIMIT 1'
        ).get(proc.sessionId) as { conv_id: string; agent_id: string } | undefined;

        if (!convRow) {
          logger.warn({ sessionId: proc.sessionId, profileId: proc.profileId, pid: proc.pid }, '[sync] orphan process — no conversation matches this session_id');
        }

        const managed: ManagedProcess = {
          sessionId: proc.sessionId,
          pmSessionId: proc.sessionId,
          profileId: proc.profileId,
          agentId: convRow?.agent_id,
          conversationId: convRow?.conv_id,
          pid: proc.pid,
          alive: proc.alive,
          sockets: new Set(),
          pendingPermissions: new Map(),
          lastActivityAt: new Date(),
          lastEventType: null,
          staleNotified: false,
          processing: false,
          taskEventListeners: new Map(),
          apiErrorCount: 0,
          lastApiError: null,
          lastStdinAt: null,
          pendingTaskContext: null,
          lastStderr: null,
          skipMcp: false,
          pendingApprovals: new Map(),
        };
        registerProcess(proc.sessionId, managed);

        logger.info({ sessionId: proc.sessionId, profileId: proc.profileId, agentId: convRow?.agent_id, alive: proc.alive }, '[sync] subscribing to process (PM will replay pending permissions)');
        pmClient.subscribe(proc.sessionId, (event) => {
          handlePMEvent(event, managed);
        });
      }
    }

    // Reconciliation: kill duplicate processes per agent
    const allProcesses = getAllActiveProcesses();
    const processesByAgent = new Map<string, ManagedProcess[]>();
    for (const [, managed] of allProcesses) {
      if (!managed.agentId || !managed.alive) continue;
      const list = processesByAgent.get(managed.agentId) || [];
      list.push(managed);
      processesByAgent.set(managed.agentId, list);
    }

    for (const [agentId, procs] of processesByAgent) {
      if (procs.length <= 1) continue;
      procs.sort((a, b) => (b.pid || 0) - (a.pid || 0));
      const keep = procs[0];
      for (const dup of procs.slice(1)) {
        logger.warn({ agentId, keepPid: keep.pid, killPid: dup.pid, killSession: dup.sessionId }, '[reconcile] killing duplicate process for agent');
        await pmClient.kill(dup.pmSessionId).catch(() => {});
        unregisterProcess(dup.sessionId);
      }
    }

    // Kill unlinked processes
    for (const [sessionId, managed] of allProcesses) {
      if (!managed.agentId && managed.alive) {
        logger.warn({ sessionId, pid: managed.pid }, '[reconcile] killing unlinked process (no agent)');
        await pmClient.kill(managed.pmSessionId).catch(() => {});
        unregisterProcess(sessionId);
      }
    }

    // Mark conversations as DORMANT if their session has no running process
    const activeConvs = db.prepare(
      `SELECT id, session_id, agent_id FROM conversations WHERE state = 'active'`
    ).all() as Array<{ id: string; session_id: string | null; agent_id: string }>;

    for (const conv of activeConvs) {
      if (!conv.session_id || !getActiveProcess(conv.session_id)) {
        const newState: ConversationState = conv.session_id ? 'dormant' : 'cold';
        updateConversationState(conv.id, newState);
        updateAgentState(conv.agent_id, 'idle');
        logger.info({ conversationId: conv.id, agentId: conv.agent_id, newState }, '[sync] reconciled conversation state');
      }
    }
  } catch (err) {
    logger.error({ error: String(err) }, '[sync] failed to sync from PM');
  }
}
