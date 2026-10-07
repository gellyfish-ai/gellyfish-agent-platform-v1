import db, { updateConversationState, updateAgentState, UUID_RE } from '../db/index.js';
import { PMEvent } from '../pm-client.js';
import { logger } from '../logger.js';
import type { ManagedProcess } from './types.js';
import { registerProcess, unregisterProcess } from './registry.js';
import { classifyApiError, recordApiError } from '../api-errors.js';
export function handleProcessEvent(event: PMEvent, managed: ManagedProcess): void {
  switch (event.event) {
    case 'close':
      logger.info({ sessionId: managed.sessionId, code: event.code, pid: managed.pid, agentId: managed.agentId }, '[process] closed');
      managed.alive = false;
      unregisterProcess(managed.sessionId);

      if (managed.conversationId) {
        updateConversationState(managed.conversationId, 'dormant');
      }
      if (managed.agentId) {
        updateAgentState(managed.agentId, 'idle');
      }
      break;

    case 'error':
      logger.error({ sessionId: managed.sessionId, error: event.message, pid: managed.pid, agentId: managed.agentId }, '[process] error');
      managed.alive = false;
      break;

    case 'stderr':
      managed.lastStderr = String(event.data).substring(0, 500);
      logger.warn({ sessionId: managed.sessionId, profileId: managed.profileId, stderr: managed.lastStderr }, '[process] Claude stderr');
      break;
  }

  // Track activity on any event
  if (event.event === 'stdout' || event.event === 'stderr') {
    managed.lastActivityAt = new Date();
    managed.staleNotified = false;
  }

  // Dispatch to task event listeners
  for (const [, listener] of managed.taskEventListeners) {
    try { listener(event); } catch { /* don't let one listener break others */ }
  }

  // Capture session_id from stdout events
  if (event.event === 'stdout') {
    const data = event.data as Record<string, unknown>;
    managed.lastEventType = (data?.type as string) || 'unknown';

    if (data?.type === 'user') {
      managed.processing = true;
    } else if (data?.type === 'result') {
      managed.processing = false;
    }

    // Track consecutive API errors
    if (data?.type === 'assistant' && data?.isApiErrorMessage) {
      managed.apiErrorCount++;
      const msgContent = (data.message as Record<string, unknown>)?.content as Array<Record<string, unknown>> | undefined;
      managed.lastApiError = msgContent?.[0]?.text as string || 'Unknown API error';
      logger.warn({ sessionId: managed.sessionId, agentId: managed.agentId, apiErrorCount: managed.apiErrorCount, error: managed.lastApiError }, '[process] API error received');

      const apiErrorType = classifyApiError(managed.lastApiError);
      if (apiErrorType && managed.agentId) {
        const agentName = (db.prepare('SELECT name FROM agents WHERE id = ?').get(managed.agentId) as { name: string } | undefined)?.name || managed.agentId.substring(0, 8);
        recordApiError({ agentId: managed.agentId, agentName, type: apiErrorType, raw: managed.lastApiError, source: 'process' });
      }

      if (managed.sockets.size > 0) {
        const retryMsg = JSON.stringify({
          type: 'api_retry',
          attempt: managed.apiErrorCount,
          maxRetries: 10,
          error: managed.lastApiError,
        });
        for (const ws of managed.sockets) {
          const socket = ws as { readyState: number; send: (data: string) => void; OPEN?: number };
          if (socket.readyState === 1) socket.send(retryMsg);
        }
      }

      if (managed.apiErrorCount >= 3 && managed.sockets.size > 0) {
        const agentName = managed.agentId
          ? (db.prepare('SELECT a.name FROM agents a WHERE a.id = ?').get(managed.agentId) as { name: string } | undefined)?.name || 'Agent'
          : 'Agent';
        const promptData = {
          type: 'session_error_prompt',
          agentName,
          error: managed.lastApiError,
          errorCount: managed.apiErrorCount,
          sessionId: managed.sessionId,
          conversationId: managed.conversationId,
        };
        const msg = JSON.stringify(promptData);
        for (const ws of managed.sockets) {
          const socket = ws as { readyState: number; send: (data: string) => void; OPEN?: number };
          if (socket.readyState === 1) socket.send(msg);
        }
      }
    } else if (data?.type === 'assistant' && !data?.isApiErrorMessage) {
      if (managed.apiErrorCount > 0 && managed.sockets.size > 0) {
        const resolvedMsg = JSON.stringify({ type: 'api_retry_resolved' });
        for (const ws of managed.sockets) {
          const socket = ws as { readyState: number; send: (data: string) => void; OPEN?: number };
          if (socket.readyState === 1) socket.send(resolvedMsg);
        }
      }
      managed.apiErrorCount = 0;
      managed.lastApiError = null;
    }

    const eventSessionId = (data?.session_id || data?.sessionId) as string | undefined;
    if (eventSessionId && !UUID_RE.test(eventSessionId)) {
      logger.warn({ eventSessionId, agentId: managed.agentId }, '[process] ignoring non-UUID session_id from Claude stdout');
    } else if (eventSessionId && managed.sessionId !== eventSessionId) {
      const oldSessionId = managed.sessionId;
      managed.sessionId = eventSessionId;
      registerProcess(eventSessionId, managed);

      if (managed.conversationId) {
        db.prepare(`
          UPDATE conversations SET session_id = ?, state = 'active', updated_at = datetime('now')
          WHERE id = ?
        `).run(eventSessionId, managed.conversationId);
      }

      logger.info({ oldSessionId, newSessionId: eventSessionId, profileId: managed.profileId, agentId: managed.agentId }, '[process] session ID captured');
    }

  }
}
