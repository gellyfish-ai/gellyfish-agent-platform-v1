import crypto from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import db, { Profile, upsertReaction, removeReaction, getAgent, getAgentForProfile, getAgentConversation, updateAgentState } from '../db/index.js';
import { lookupProfile, lookupProfileBySession } from '../claude-spawn.js';
import { getSessionsDirForCwd, listSessionFiles, findSessionInDir } from '../session-file.js';
import { pmClient } from '../pm-client.js';
import type { ManagedProcess } from '../session-send.js';
import {
  getActiveProcess,
  getActiveProcessByAgent,
  registerProcess,
  unregisterProcess,
  formatUserMessage,
  prefixMessage,
  destroySession,
} from '../session-send.js';
import { sendToSocket, sendActiveAgentsSnapshot } from './broadcast.js';
import { buildSpawnFn, handlePMEvent } from './spawn.js';
import { handlePermissionResponse } from './permissions.js';
import { agentStatusEvent } from './event-types.js';
import { buildApprovalIdentityPayload } from '../apns/index.js';
import { logger } from '../logger.js';

const VAULT_URL = process.env.VAULT_URL || 'http://localhost:8205';

function setupSocketHandlers(
  socket: WebSocket,
  managed: ManagedProcess,
  clientId: string,
  server: FastifyInstance,
  spawnFn: ((content: string) => void) | null,
) {
  socket.on('message', async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'user_message': {
          if (!managed.alive) {
            if (spawnFn) {
              server.log.info({ clientId, sessionId: managed.sessionId, profileId: managed.profileId }, '[process] spawning via PM on first user message');
              sendToSocket(managed, agentStatusEvent({ status: 'Starting process...', phase: 'process_starting' }));
              spawnFn(message.content);
              return;
            } else {
              server.log.warn({ clientId, sessionId: managed.sessionId }, '[process] no alive process and no spawnFn');
              sendToSocket(managed, agentStatusEvent({ status: 'Process is dead — reload to reconnect', phase: 'process_gone' }));
              return;
            }
          }

          const contentPreview = typeof message.content === 'string' ? message.content.substring(0, 50) : `[${Array.isArray(message.content) ? message.content.length + ' blocks' : 'unknown'}]`;
          server.log.info({ clientId, sessionId: managed.sessionId, content: contentPreview }, '[ws] sending user message');

          if (managed.agentId) {
            updateAgentState(managed.agentId, 'working');
          }
          try {
            await pmClient.inject(managed.pmSessionId, formatUserMessage(message.content));
          } catch (err) {
            server.log.warn({ sessionId: managed.sessionId, error: String(err) }, '[ws] inject failed — process likely dead, marking for respawn');
            managed.alive = false;
            sendToSocket(managed, agentStatusEvent({ status: 'Process is gone — respawning...', phase: 'process_respawning', pid: managed.pid ?? undefined }));
            if (spawnFn) {
              spawnFn(message.content);
            } else {
              sendToSocket(managed, agentStatusEvent({ status: 'Process is dead — reload to reconnect', phase: 'process_gone' }));
            }
          }
          break;
        }

        case 'permission_response':
          handlePermissionResponse(message, managed, clientId, server);
          break;

        case 'approval_response': {
          const approvalId = message.id as string;
          const approved = message.approved as boolean;
          if (approved) {
            server.log.warn({ approvalId }, '[approval] browser approval blocked — requires signed device response');
            break;
          }
          // Relay rejection to vault — vault webhook handles CLI injection + broadcast
          fetch(VAULT_URL + '/approvals/' + encodeURIComponent(approvalId) + '/respond', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: 'rejected' }),
          }).catch(err => {
            logger.warn({ approvalId, error: String(err) }, '[approval] vault reject relay failed');
          });
          const { insertAuditEntry } = await import('../db/audit-log.js');
          insertAuditEntry(approvalId, 'rejected', 'browser');
          server.log.info({ approvalId, approved }, '[approval] rejected via browser → vault');
          break;
        }

        case 'cancel':
          try {
            await pmClient.cancel(managed.pmSessionId);
          } catch { /* process may already be idle */ }
          break;

        case 'reaction': {
          const sessionId = managed.sessionId;
          if (!sessionId || !message.messageId) break;

          const preview = message.messagePreview ? String(message.messagePreview).substring(0, 100) : '';

          if (message.emoji) {
            upsertReaction(sessionId, message.messageId, message.emoji, preview);
            server.log.info({ sessionId, messageId: message.messageId, emoji: message.emoji }, '[reaction] upserted');

            if (managed.alive && managed.pmSessionId) {
              const injectMsg = prefixMessage('reaction', 'user', `Reacted ${message.emoji} to: "${preview}"`);
              try {
                await pmClient.inject(managed.pmSessionId, formatUserMessage(injectMsg));
              } catch { /* best effort */ }
            }
          } else {
            removeReaction(sessionId, message.messageId);
            server.log.info({ sessionId, messageId: message.messageId }, '[reaction] removed');

            if (managed.alive && managed.pmSessionId) {
              const injectMsg = prefixMessage('reaction', 'user', `Removed reaction from: "${preview}"`);
              try {
                await pmClient.inject(managed.pmSessionId, formatUserMessage(injectMsg));
              } catch { /* best effort */ }
            }
          }
          break;
        }

        case 'start_fresh': {
          const convId = message.conversationId;
          if (convId) {
            db.prepare("UPDATE conversations SET session_id = NULL, state = 'cold', updated_at = datetime('now') WHERE id = ?").run(convId);
            server.log.info({ conversationId: convId }, '[ws] user chose start_fresh — cleared session_id');
            sendToSocket(managed, { type: 'session_cleared', conversationId: convId });
          }
          break;
        }

        case 'session_recover': {
          const convId = message.conversationId;
          if (!convId) break;
          server.log.info({ conversationId: convId, sessionId: managed.sessionId }, '[ws] user chose session_recover');
          await destroySession(managed.sessionId, managed.profileId);
          sendToSocket(managed, { type: 'session_cleared', conversationId: convId });
          break;
        }

        case 'session_retry': {
          managed.apiErrorCount = 0;
          managed.lastApiError = null;
          server.log.info({ sessionId: managed.sessionId }, '[ws] user chose session_retry — error count reset');
          break;
        }

        case 'recovery_action': {
          const action = message.action as string;
          server.log.info({ sessionId: managed.sessionId, action }, '[ws] user chose recovery action');
          if (action === 'clear_session') {
            if (managed.conversationId) {
              db.prepare("UPDATE conversations SET session_id = NULL, state = 'cold', updated_at = datetime('now') WHERE id = ?").run(managed.conversationId);
              sendToSocket(managed, { type: 'session_cleared', conversationId: managed.conversationId });
            }
          } else if (action === 'resume_session') {
            // No-op on DB — session is still valid. Just prompt user to send a message.
            sendToSocket(managed, agentStatusEvent({ status: 'Send a message to resume.', phase: 'session_reconnected' }));
          } else if (action === 'restart_no_mcp') {
            if (managed.conversationId) {
              db.prepare("UPDATE conversations SET session_id = NULL, state = 'cold', updated_at = datetime('now') WHERE id = ?").run(managed.conversationId);
              managed.skipMcp = true;
              managed.alive = false;
              sendToSocket(managed, { type: 'session_cleared', conversationId: managed.conversationId });
              sendToSocket(managed, agentStatusEvent({ status: 'Restarting without MCP servers — send a message to continue.', phase: 'process_respawning' }));
            }
          }
          break;
        }

        case 'ping':
          break;

        default:
          server.log.warn({ clientId, messageType: message.type }, 'Unknown message type');
      }
    } catch (e) {
      server.log.error({ clientId, error: e }, 'Failed to parse client message');
    }
  });

  socket.on('close', () => {
    managed.sockets.delete(socket);
    server.log.info({ clientId, sessionId: managed.sessionId, profileId: managed.profileId, remainingSockets: managed.sockets.size }, '[ws] client disconnected — process stays alive in PM');
  });

  socket.on('error', (err: Error) => {
    server.log.error({ clientId, error: err.message }, 'WebSocket error');
  });
}

export async function chatWsRoutes(server: FastifyInstance) {
  server.get<{ Querystring: { sessionId?: string; profileId?: string; agentId?: string } }>('/chat/ws', { websocket: true }, (socket: WebSocket, req) => {
    const clientId = crypto.randomUUID();
    let sessionId: string | undefined = req.query.sessionId;
    let resumeSessionId: string | undefined = req.query.sessionId;
    const profileId: string | undefined = req.query.profileId;
    const agentId: string | undefined = req.query.agentId;

    let agent = agentId ? getAgent(agentId) : undefined;

    // Fallback 1: resolve agent from conversation.session_id
    if (!agent && resumeSessionId) {
      const convAgent = db.prepare(`
        SELECT a.id FROM conversations c
        JOIN agents a ON a.id = c.agent_id
        WHERE c.session_id = ?
      `).get(resumeSessionId) as { id: string } | undefined;
      if (convAgent) {
        agent = getAgent(convAgent.id);
        server.log.info({ clientId, agentId: agent?.id, sessionId: resumeSessionId }, '[ws] resolved agent from session (no agentId in URL)');
      }
    }

    // Fallback 2: resolve agent from session file on disk
    if (!agent && resumeSessionId) {
      const agents = db.prepare("SELECT id, workspace_dir FROM agents WHERE workspace_dir != '' AND state != 'stopped'")
        .all() as Array<{ id: string; workspace_dir: string }>;
      for (const a of agents) {
        const dir = getSessionsDirForCwd(a.workspace_dir);
        if (findSessionInDir(dir, resumeSessionId)) {
          agent = getAgent(a.id);
          server.log.info({ clientId, agentId: agent?.id, sessionId: resumeSessionId }, '[ws] resolved agent from session file on disk');
          break;
        }
      }
    }

    let conversation = agent ? getAgentConversation(agent.id) : undefined;

    if (agent && conversation && !resumeSessionId) {
      if (conversation.session_id) {
        resumeSessionId = conversation.session_id;
        sessionId = conversation.session_id;
        server.log.info({ clientId, agentId, conversationId: conversation.id, sessionId }, '[ws] resolved session from agent conversation');
      }
    }

    if (!agent && profileId) {
      agent = getAgentForProfile(profileId);
      conversation = agent ? getAgentConversation(agent.id) : undefined;
    }

    if (!resumeSessionId && conversation?.session_id) {
      resumeSessionId = conversation.session_id;
      sessionId = conversation.session_id;
      server.log.info({ clientId, agentId: agent?.id, sessionId }, '[ws] recovered session from conversation');
    }

    const resolvedProfileId = profileId || agent?.profile_id;

    server.log.info({ clientId, resumeSessionId, profileId: resolvedProfileId, agentId: agent?.id, conversationState: conversation?.state }, '[ws] client connected');

    // Detect stale session: URL has a session_id but it doesn't match the conversation
    if (agent && resumeSessionId && conversation && conversation.session_id !== resumeSessionId) {
      const sessionFiles = listSessionFiles(conversation.id);
      server.log.warn({ clientId, agentId: agent.id, requestedSession: resumeSessionId, conversationSession: conversation.session_id }, '[ws] session_not_found — sending picker to client');
      socket.send(JSON.stringify({
        type: 'session_not_found',
        requestedSessionId: resumeSessionId,
        agentId: agent.id,
        agentName: agent.name,
        conversationId: conversation.id,
        currentSessionId: conversation.session_id,
        availableSessions: sessionFiles.map(f => ({
          sessionId: f.sessionId,
          modifiedAt: f.modifiedAt,
          sizeMB: (f.size / (1024 * 1024)).toFixed(1),
          active: conversation.session_id === f.sessionId,
        })),
      }));
      sendActiveAgentsSnapshot(socket);
      return; // Don't spawn — wait for user to choose
    }

    let profile: Profile | undefined;
    if (resolvedProfileId) {
      profile = lookupProfile(resolvedProfileId);
    } else if (resumeSessionId) {
      profile = lookupProfileBySession(resumeSessionId);
    }

    sendActiveAgentsSnapshot(socket);

    const existingManaged = (agent && getActiveProcessByAgent(agent.id)) || (resumeSessionId && getActiveProcess(resumeSessionId)) || undefined;
    if (existingManaged) {
      const managed = existingManaged;

      if (managed.alive) {
        managed.sockets.add(socket);
        server.log.info({ clientId, sessionId: resumeSessionId, pid: managed.pid, socketCount: managed.sockets.size }, '[process] reattached WebSocket');

        if (agent && !managed.agentId) {
          managed.agentId = agent.id;
          managed.conversationId = conversation?.id;
          registerProcess(managed.sessionId, managed);
        }

        pmClient.subscribe(managed.pmSessionId, (event) => {
          handlePMEvent(event, managed);
        });

        for (const [requestId, perm] of managed.pendingPermissions) {
          socket.send(JSON.stringify({
            type: 'permission_request',
            requestId,
            toolName: perm.toolName,
            input: perm.input,
          }));
        }

        // Replay pending approvals from vault so reconnecting browsers show approval cards
        fetch(VAULT_URL + '/approvals/pending/' + encodeURIComponent(managed.sessionId))
          .then(resp => resp.ok ? resp.json() as Promise<{ approvals: Array<Record<string, unknown>> }> : null)
          .then(data => {
            if (!data?.approvals) return;
            for (const approval of data.approvals) {
              const identity = buildApprovalIdentityPayload({
                mcpName: approval.mcp_name as string, toolName: approval.tool_name as string,
                agentDisplayName: approval.agent_display_name as string | null,
                profileDisplayName: approval.profile_display_name as string | null,
                humanPreview: approval.human_preview as string | null,
              });
              socket.send(JSON.stringify({
                type: 'approval_request', id: approval.id,
                humanPreview: approval.human_preview,
                expiresAt: approval.expires_at, requestId: approval.request_id,
                ...identity,
              }));
            }
          })
          .catch(err => {
            logger.warn({ sessionId: managed.sessionId, error: String(err) }, '[connection] vault pending approvals fetch failed');
          });

        socket.send(JSON.stringify({
          type: 'init',
          sessionId: managed.sessionId,
          agentId: agent?.id,
          reconnected: true,
          processInfo: {
            pid: managed.pid,
            reattached: true,
          },
        }));

        if (managed.processing) {
          socket.send(JSON.stringify({ type: 'processing', active: true }));
        }

        const respawnFn = buildSpawnFn(managed, profile, agent, resumeSessionId, resolvedProfileId, clientId, server, () => sessionId, (id) => { sessionId = id; });
        setupSocketHandlers(socket, managed, clientId, server, respawnFn);
        return;
      }

      const pidInfo = managed.pid ? ` (pid ${managed.pid})` : '';
      server.log.warn({ clientId, sessionId: managed.sessionId, pid: managed.pid, profileId: managed.profileId, agentId: managed.agentId }, '[process] found dead — cleaning up');
      socket.send(JSON.stringify(agentStatusEvent({
        status: `Previous process${pidInfo} died — will start a new one on next message`,
        phase: 'process_exited',
        pid: managed.pid ?? undefined,
      })));
      unregisterProcess(managed.sessionId);
    }

    const managed: ManagedProcess = {
      sessionId: sessionId || '',
      pmSessionId: sessionId || '',
      profileId: resolvedProfileId,
      agentId: agent?.id,
      conversationId: conversation?.id,
      pid: null,
      alive: false,
      sockets: new Set([socket]),
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

    const spawnFn = buildSpawnFn(managed, profile, agent, resumeSessionId, resolvedProfileId, clientId, server, () => sessionId, (id) => { sessionId = id; });

    if (sessionId) {
      registerProcess(sessionId, managed);
    }

    // Send init event so the UI knows the session was accepted (even without a running process)
    if (resumeSessionId) {
      socket.send(JSON.stringify({
        type: 'init',
        sessionId: resumeSessionId,
        agentId: agent?.id,
        reconnected: true,
      }));
      socket.send(JSON.stringify(agentStatusEvent({
        status: 'Process not running — send a message to resume.',
        phase: 'session_reconnected',
      })));
    }

    setupSocketHandlers(socket, managed, clientId, server, spawnFn);
  });
}
