import crypto from 'crypto';
import db, {
  getAgent, getAgentForProfile, getAgentConversation,
  updateConversationState, updateAgentState,
} from '../db/index.js';
import { buildClaudeArgs, resolveWorkingDir, lookupProfile, SessionMissingError } from '../claude-spawn.js';
import { pmClient, PMEvent } from '../pm-client.js';
import { logger } from '../logger.js';
import type { ManagedProcess, SendResult } from './types.js';
import { getActiveProcess, getActiveProcessByAgent, registerProcess, unregisterProcess } from './registry.js';
import { formatUserMessage } from './format.js';
import { handlePMEvent } from '../ws/spawn.js';

export async function sendMessage(options: {
  profileId: string;
  agentId?: string;
  sessionId?: string;
  message: string;
  taskId?: string;
  onEvent?: (event: PMEvent, managed: ManagedProcess) => void;
}): Promise<SendResult> {
  const { profileId, message, onEvent } = options;

  const profile = lookupProfile(profileId);
  if (!profile) {
    logger.error({ profileId }, '[send] FAILED — profile not found');
    return { sessionId: '', managed: null as unknown as ManagedProcess, delivered: false, spawned: false, error: 'Profile not found' };
  }

  const agent = options.agentId ? getAgent(options.agentId) : getAgentForProfile(profileId);
  const conversation = agent ? getAgentConversation(agent.id) : undefined;
  const sessionId = options.sessionId || conversation?.session_id || undefined;

  logger.info({
    profileId, profileName: profile.name,
    agentId: agent?.id, agentName: agent?.name,
    conversationId: conversation?.id, conversationState: conversation?.state,
    sessionId: sessionId || 'none',
  }, '[send] resolved agent chain');

  if (agent && !conversation) {
    logger.error({ agentId: agent.id, agentName: agent.name, profileId }, '[send] FAILED — agent has no conversation. This is a data integrity error.');
    return { sessionId: '', managed: null as unknown as ManagedProcess, delivered: false, spawned: false, error: `Agent ${agent.name} has no conversation — data integrity error` };
  }

  // --- Path 1: alive process → inject ---
  const existingManaged = (agent && getActiveProcessByAgent(agent.id)) || (sessionId && getActiveProcess(sessionId)) || undefined;
  if (existingManaged?.alive) {
    try {
      await pmClient.inject(existingManaged.pmSessionId, formatUserMessage(message));
      existingManaged.lastStdinAt = new Date();
      logger.info({ sessionId: existingManaged.sessionId.substring(0, 8), profileId, agentId: agent?.id }, '[send] INJECT — delivered to alive process');

      if (conversation && conversation.state !== 'active') {
        updateConversationState(conversation.id, 'active');
      }
      if (agent && agent.state !== 'working') {
        updateAgentState(agent.id, 'working');
      }

      if (onEvent && options.taskId) {
        const taskListener = (event: PMEvent) => onEvent(event, existingManaged);
        existingManaged.taskEventListeners.set(options.taskId, taskListener);
        logger.info({ agentId: agent?.id, taskId: options.taskId, listenerCount: existingManaged.taskEventListeners.size }, '[send] registered task event listener on existing process');
      }

      return { sessionId: existingManaged.sessionId, managed: existingManaged, delivered: true, spawned: false };
    } catch (err) {
      logger.warn({ sessionId: existingManaged.sessionId, profileId, error: String(err) }, '[send] INJECT failed — cleaning up dead process, will spawn');
      unregisterProcess(existingManaged.sessionId);
    }
  } else if (existingManaged && !existingManaged.alive) {
    logger.info({ sessionId: existingManaged.sessionId, agentId: agent?.id }, '[send] found dead process — cleaning up before spawn');
    unregisterProcess(existingManaged.sessionId);
  } else {
    logger.info({ agentId: agent?.id, sessionId: sessionId || 'none' }, '[send] no existing process — will SPAWN');
  }

  // --- Path 1b: PM-level guard (authoritative, survives gateway restart) ---
  // The in-memory registry may be stale after a gateway restart. Check PM
  // directly for a running process belonging to this agent before spawning.
  if (agent) {
    try {
      const pmProcesses = await pmClient.list();
      for (const proc of pmProcesses) {
        if (!proc.alive) continue;
        // Match PM process to agent via conversation DB lookup
        const convRow = db.prepare(
          'SELECT agent_id FROM conversations WHERE session_id = ? LIMIT 1'
        ).get(proc.sessionId) as { agent_id: string } | undefined;
        if (convRow?.agent_id !== agent.id) continue;

        // Found a PM process for this agent — register it and try to inject
        logger.info({ agentId: agent.id, pmSessionId: proc.sessionId, pid: proc.pid },
          '[send] PM-level guard — found running process not in registry');

        const recovered: ManagedProcess = {
          sessionId: proc.sessionId,
          pmSessionId: proc.sessionId,
          profileId,
          agentId: agent.id,
          conversationId: conversation?.id,
          pid: proc.pid,
          alive: true,
          sockets: new Set(),
          pendingPermissions: new Map(),
          lastActivityAt: null,
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
        registerProcess(proc.sessionId, recovered);
        pmClient.subscribe(proc.sessionId, (event) => {
          handlePMEvent(event, recovered);
          onEvent?.(event, recovered);
        });

        try {
          await pmClient.inject(proc.sessionId, formatUserMessage(message));
          recovered.lastStdinAt = new Date();
          logger.info({ agentId: agent.id, sessionId: proc.sessionId }, '[send] PM-level guard — injected into recovered process');

          if (conversation && conversation.state !== 'active') {
            updateConversationState(conversation.id, 'active');
          }
          if (agent.state !== 'working') {
            updateAgentState(agent.id, 'working');
          }
          if (onEvent && options.taskId) {
            recovered.taskEventListeners.set(options.taskId, (event: PMEvent) => onEvent(event, recovered));
          }
          return { sessionId: proc.sessionId, managed: recovered, delivered: true, spawned: false };
        } catch (injectErr) {
          logger.warn({ agentId: agent.id, sessionId: proc.sessionId, error: String(injectErr) },
            '[send] PM-level guard — inject failed, killing stale PM process');
          await pmClient.kill(proc.sessionId).catch(() => {});
          unregisterProcess(proc.sessionId);
        }
        break; // Only try the first matching process
      }
    } catch (listErr) {
      logger.warn({ agentId: agent?.id, error: String(listErr) }, '[send] PM-level guard — pmClient.list() failed, proceeding to spawn');
    }
  }

  // --- Path 2: dead/missing → spawn ---
  if (agent) {
    const duplicateForAgent = getActiveProcessByAgent(agent.id);
    if (duplicateForAgent && duplicateForAgent.alive) {
      logger.warn({ agentId: agent.id, oldSessionId: duplicateForAgent.sessionId, oldPid: duplicateForAgent.pid }, '[send] killing duplicate process for agent before spawn');
      await pmClient.kill(duplicateForAgent.pmSessionId).catch(() => {});
      unregisterProcess(duplicateForAgent.sessionId);
    }
  }

  const spawnSessionId = sessionId || crypto.randomUUID();
  const resumeOrFresh = sessionId ? 'RESUME' : 'FRESH';
  logger.info({ agentId: agent?.id, spawnSessionId, resumeOrFresh, profileName: profile.name }, `[send] SPAWN ${resumeOrFresh}`);

  const args = buildClaudeArgs({ profile, agentId: agent?.id, sessionId });
  const cwd = resolveWorkingDir(agent);

  try {
    const result = await pmClient.spawn({ sessionId: spawnSessionId, profileId, args, cwd });

    const managed: ManagedProcess = {
      sessionId: spawnSessionId,
      pmSessionId: spawnSessionId,
      profileId,
      agentId: agent?.id,
      conversationId: conversation?.id,
      pid: result.pid,
      alive: true,
      sockets: new Set(),
      pendingPermissions: new Map(),
      lastActivityAt: null,
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
    registerProcess(spawnSessionId, managed);

    logger.info({ sessionId: spawnSessionId, profileId, agentId: agent?.id, pid: result.pid, existing: result.existing }, '[send] process spawned');

    if (conversation) {
      updateConversationState(conversation.id, 'active');
      // Don't store spawnSessionId here — for fresh spawns it's a PM
      // placeholder UUID, not the real Claude session_id. The actual
      // session_id arrives in Claude's init event and gets stored by
      // handleProcessEvent (events.ts:105-119). Storing prematurely
      // creates stale references when the process dies before writing
      // a JSONL file.
    }
    if (agent) {
      updateAgentState(agent.id, 'working');
    }

    pmClient.subscribe(spawnSessionId, (event) => {
      handlePMEvent(event, managed);
      onEvent?.(event, managed);
    });

    await pmClient.inject(spawnSessionId, formatUserMessage(message));
    managed.lastStdinAt = new Date();
    logger.info({ sessionId: spawnSessionId, profileId, agentId: agent?.id }, '[send] message injected after spawn');

    return { sessionId: spawnSessionId, managed, delivered: true, spawned: true };
  } catch (err) {
    if (err instanceof SessionMissingError) {
      logger.error({ sessionId: err.sessionId, conversationId: err.conversationId, agentName: err.agentName }, '[send] SESSION MISSING — .jsonl not found, user must decide');
      return {
        sessionId: spawnSessionId,
        managed: null as unknown as ManagedProcess,
        delivered: false,
        spawned: false,
        error: 'session_missing',
        sessionMissing: { sessionId: err.sessionId, conversationId: err.conversationId, agentName: err.agentName },
      };
    }
    logger.error({ sessionId: spawnSessionId, profileId, agentId: agent?.id, error: String(err) }, '[send] spawn failed');
    return { sessionId: spawnSessionId, managed: null as unknown as ManagedProcess, delivered: false, spawned: false, error: String(err) };
  }
}
