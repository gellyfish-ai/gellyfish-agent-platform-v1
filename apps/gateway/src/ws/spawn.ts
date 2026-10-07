import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import db, { type Profile, updateConversationState, updateAgentState, UUID_RE } from '../db/index.js';
import { buildClaudeArgs, resolveWorkingDir, SessionMissingError } from '../claude-spawn.js';
import { resolveModel } from '../models.js';
import { pmClient, PMEvent } from '../pm-client.js';
import { logger } from '../logger.js';
import type { ManagedProcess } from '../session-send.js';
import { handleProcessEvent, registerProcess, formatUserMessage } from '../session-send.js';
import { sendToSocket } from './broadcast.js';
import { getRecoveryActions } from './recovery.js';
import { handleClaudeEvent } from './claude-events.js';
import { handleControlRequest } from './permissions.js';
import { agentStatusEvent } from './event-types.js';

export function getExitMessage(code: number): string | null {
  switch (code) {
    case 0: return null;
    case 143: return 'Process was stopped';
    case 137: return 'Process was force-killed';
    case 130: return 'Process interrupted (Ctrl+C)';
    default: return null;
  }
}

// Shared PM event handler used by all subscribe paths (WS and headless/Task-API).
// Routes control_request to permissions.ts, other stdout events to claude-events.ts,
// and fans out lifecycle events to the UI (no-op on processes with no sockets).
export function handlePMEvent(event: PMEvent, managed: ManagedProcess) {
  handleProcessEvent(event, managed);

  switch (event.event) {
    case 'stdout':
      handleParsedClaudeEvent(event.data as Record<string, unknown>, managed);
      break;

    case 'close': {
      const exitMessage = getExitMessage(event.code as number);
      const errorDetail = managed.lastStderr || exitMessage || null;
      sendToSocket(managed, agentStatusEvent({
        status: exitMessage || `Process exited (code ${event.code})`,
        phase: 'process_exited',
        pid: managed.pid ?? undefined,
        error: managed.lastStderr || null,
      }));
      sendToSocket(managed, {
        type: 'session_end',
        code: event.code,
        error: errorDetail,
        recoveryActions: getRecoveryActions(event.code as number, managed.lastStderr || null),
      });
      // Clear confirmed_model on process exit
      if (managed.profileId) {
        db.prepare('UPDATE profiles SET confirmed_model = NULL WHERE id = ?').run(managed.profileId);
      }
      break;
    }

    case 'error':
      sendToSocket(managed, agentStatusEvent({
        status: `Process error: ${event.message}`,
        phase: 'process_exited',
        pid: managed.pid ?? undefined,
      }));
      sendToSocket(managed, { type: 'error', error: event.message });
      break;
  }
}

function handleParsedClaudeEvent(event: Record<string, unknown>, managed: ManagedProcess) {
  if (event.type === 'assistant' && event.isApiErrorMessage) {
    const msgContent = (event.message as Record<string, unknown>)?.content as Array<Record<string, unknown>> | undefined;
    const errorText = msgContent?.[0]?.text || '';
    if (typeof errorText === 'string' && (errorText.includes('tool_use') || errorText.includes('concurrency'))) {
      logger.warn({ sessionId: managed.sessionId, profileId: managed.profileId, error: errorText }, '[process] session corrupted');
      sendToSocket(managed, {
        type: 'session_error',
        error: 'Session was corrupted. Starting fresh conversation.',
        willRetry: true,
      });
      return;
    }
  }

  if (event.type === 'control_request') {
    handleControlRequest(event, managed).catch(err => {
      logger.error({ sessionId: managed.sessionId, error: String(err) }, '[spawn] handleControlRequest failed');
    });
  } else {
    handleClaudeEvent(event, managed);
  }
}

export function buildSpawnFn(
  managed: ManagedProcess,
  profile: Profile | undefined,
  agent: { id?: string; workspace_dir?: string } | undefined,
  resumeSessionId: string | undefined,
  profileId: string | undefined,
  clientId: string,
  server: FastifyInstance,
  getSessionId: () => string | undefined,
  setSessionId: (id: string) => void,
): (content: string) => void {
  let triedResume = false;

  return (userContent: string) => {
    const resumeId = (resumeSessionId && !triedResume) ? resumeSessionId : undefined;
    if (resumeId) triedResume = true;

    (async () => {
      try {
        const spawnSessionId = resumeId || crypto.randomUUID();
        const model = resolveModel(profile?.model ?? null);
        const args = buildClaudeArgs({ profile, agentId: agent?.id, sessionId: resumeId, skipMcp: managed.skipMcp, model });
        const cwd = resolveWorkingDir(agent);
        const result = await pmClient.spawn({
          sessionId: spawnSessionId,
          profileId,
          args,
          cwd,
        });

        managed.pid = result.pid;
        managed.alive = true;
        managed.sessionId = spawnSessionId;
        managed.pmSessionId = spawnSessionId;
        sendToSocket(managed, agentStatusEvent({
          status: `Process started (pid ${result.pid})`,
          phase: 'process_started',
          pid: result.pid,
        }));

        registerProcess(spawnSessionId, managed);

        if (managed.conversationId) {
          updateConversationState(managed.conversationId, 'active');
        }

        server.log.info({ clientId, sessionId: managed.sessionId, pid: result.pid, profileName: profile?.name, agentId: managed.agentId, existing: result.existing }, '[process] spawned via PM');

        pmClient.subscribe(managed.pmSessionId, (event) => {
          handlePMEvent(event, managed);

          if (event.event === 'stdout') {
            const data = event.data as Record<string, unknown>;
            const currentSessionId = getSessionId();
            const dataSessionId = (data?.session_id || data?.sessionId) as string | undefined;
            if (dataSessionId && !UUID_RE.test(dataSessionId)) {
              server.log.warn({ dataSessionId, agentId: managed.agentId }, '[process] ignoring non-UUID session_id from Claude stdout');
            } else if (dataSessionId && !currentSessionId) {
              setSessionId(dataSessionId);

              if (managed.conversationId) {
                const existingLink = db.prepare(
                  'SELECT session_id FROM conversations WHERE id = ?'
                ).get(managed.conversationId) as { session_id: string } | undefined;

                if (existingLink && existingLink.session_id !== dataSessionId) {
                  server.log.error({ profileId, expectedSession: existingLink.session_id, actualSession: dataSessionId },
                    '[process] session split detected');
                  sendToSocket(managed, {
                    type: 'error',
                    error: `Session resume failed — expected ${existingLink.session_id.substring(0, 8)}... but got a new one.`,
                  });
                }
              }
            }
          }
        });

        if (managed.agentId) {
          updateAgentState(managed.agentId, 'working');
        }
        await pmClient.inject(managed.pmSessionId, formatUserMessage(userContent));

      } catch (err) {
        if (err instanceof SessionMissingError) {
          server.log.error({ clientId, sessionId: err.sessionId, conversationId: err.conversationId }, '[process] session .jsonl missing');
          sendToSocket(managed, {
            type: 'session_missing',
            sessionId: err.sessionId,
            conversationId: err.conversationId,
            agentName: err.agentName || managed.agentId,
          });
          return;
        }
        server.log.error({ clientId, error: String(err) }, '[process] spawn via PM failed');
        sendToSocket(managed, { type: 'error', error: `Failed to spawn: ${err}` });
      }
    })();
  };
}
