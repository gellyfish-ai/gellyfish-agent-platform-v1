import { FastifyInstance } from 'fastify';
import { getSetting, parseMcpToolName, getRiskLevel } from '../db/index.js';
import { pmClient } from '../pm-client.js';
import { logger } from '../logger.js';
import type { ManagedProcess } from '../session-send.js';
import { getAllActiveProcesses } from '../session-send.js';
import { sendToSocket } from './broadcast.js';
import { getSubagentState } from './claude-events.js';
import { agentStatusEvent } from './event-types.js';
import { sendApprovalPush, buildApprovalIdentityPayload } from '../apns/index.js';
import { insertAuditEntry } from '../db/audit-log.js';
import { checkApprovalRateLimit } from '../approval-rate-limit.js';
import { getDevices } from '../db/devices.js';
import db from '../db/index.js';

const VAULT_URL = process.env.VAULT_URL || 'http://localhost:8205';

export async function handlePermissionResponse(
  message: Record<string, unknown>,
  managed: ManagedProcess,
  clientId: string,
  server: FastifyInstance,
) {
  const requestId = message.requestId as string;
  managed.pendingPermissions.delete(requestId);

  if (!managed.alive) return;

  const innerResponse = message.approved
    ? { behavior: 'allow' as const, updatedInput: message.input || {} }
    : { behavior: 'deny' as const, message: (message.reason as string) || 'Denied by user' };

  const controlResponse = JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: innerResponse,
    },
  });

  server.log.info({ clientId, requestId, approved: message.approved, sessionId: managed.sessionId }, '[permission] sending response via PM');

  try {
    await pmClient.inject(managed.pmSessionId, controlResponse);
  } catch (err) {
    server.log.error({ sessionId: managed.sessionId, error: String(err) }, '[permission] failed to send response via PM');
  }
}

export async function handleControlRequest(event: Record<string, unknown>, managed: ManagedProcess) {
  const requestId = event.request_id as string;
  const request = event.request as Record<string, unknown>;

  if (request?.subtype === 'can_use_tool') {
    const toolName = request.tool_name as string;
    const input = request.input;

    const autoApproveSetting = getSetting('auto_approve');
    logger.info({ requestId, toolName, sessionId: managed.sessionId, profileId: managed.profileId, autoApprove: autoApproveSetting }, '[permission] control_request received');

    // Check risk level for MCP tools — runs BEFORE auto-approve
    const { mcpName, toolName: parsedTool } = parseMcpToolName(toolName);
    if (mcpName) {
      const riskLevel = getRiskLevel(mcpName, parsedTool);

      if (riskLevel === 'approve') {
        // Dedupe replayed control_request: on web-UI reconnect, PM replays
        // buffered control_request events. If we already created an approval
        // for this (session, requestId), reuse it instead of minting a new
        // row and firing another APNs push. Still re-emit the socket message
        // so the reconnecting browser repopulates its pending-approvals UI.
        let replayedApprovalId: string | undefined;
        for (const [approvalId, reqId] of managed.pendingApprovals) {
          if (reqId === requestId) {
            replayedApprovalId = approvalId;
            break;
          }
        }
        if (replayedApprovalId) {
          // Check vault for approval state
          try {
            const vaultCheck = await fetch(`${VAULT_URL}/approvals/${replayedApprovalId}`);
            if (vaultCheck.ok) {
              const existing = await vaultCheck.json() as Record<string, unknown>;
              if (existing.state === 'pending') {
                logger.info({ requestId, approvalId: replayedApprovalId, sessionId: managed.sessionId }, `[approval] control_request replayed — reusing existing approval ${replayedApprovalId}, no push re-fired`);
                const identity = buildApprovalIdentityPayload({
                  mcpName, toolName: parsedTool,
                  agentDisplayName: existing.agent_display_name as string | null,
                  profileDisplayName: existing.profile_display_name as string | null,
                  humanPreview: existing.human_preview as string | null,
                });
                sendToSocket(managed, {
                  type: 'approval_request', id: existing.id as string,
                  humanPreview: existing.human_preview,
                  expiresAt: existing.expires_at, requestId,
                  ...identity,
                });
                return;
              }
            }
          } catch (err) {
            logger.warn({ approvalId: replayedApprovalId, error: String(err) }, '[approval] vault check failed for replayed approval');
          }
          // Stale map entry — drop and fall through.
          managed.pendingApprovals.delete(replayedApprovalId);
        }

        // Rate limit check — prevent notification spam
        if (managed.agentId && !checkApprovalRateLimit(managed.agentId)) {
          logger.warn({ requestId, agentId: managed.agentId, mcpName, toolName: parsedTool }, '[approval] rate limited — auto-denying');
          const denyResponse = JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: 'Approval rate limit exceeded' } },
          });
          pmClient.inject(managed.pmSessionId, denyResponse).catch(() => {});
          return;
        }

        // Resolve display names for the vault
        const agentDisplayName = managed.agentId
          ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(managed.agentId) as { name: string } | undefined)?.name ?? null
          : null;
        const profileDisplayName = managed.profileId
          ? (db.prepare('SELECT name FROM profiles WHERE id = ?').get(managed.profileId) as { name: string } | undefined)?.name ?? null
          : null;

        // Create approval via vault
        let approval: { approval_id: string; nonce: string; action_hash: string; human_preview: string; expires_at: string };
        try {
          const vaultResp = await fetch(VAULT_URL + '/approvals/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mcp_name: mcpName, tool_name: parsedTool,
              tool_input: input ? JSON.stringify(input) : null,
              profile_id: managed.profileId, agent_id: managed.agentId,
              session_id: managed.sessionId, request_id: requestId,
              agent_display_name: agentDisplayName,
              profile_display_name: profileDisplayName,
            }),
          });
          if (!vaultResp.ok) {
            const errBody = await vaultResp.text();
            logger.error({ status: vaultResp.status, body: errBody }, '[approval] vault /approvals/create failed — auto-denying');
            const denyResponse = JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: 'Vault approval creation failed' } },
            });
            pmClient.inject(managed.pmSessionId, denyResponse).catch(() => {});
            return;
          }
          approval = await vaultResp.json() as typeof approval;
        } catch (err) {
          logger.error({ error: String(err) }, '[approval] vault /approvals/create unreachable — auto-denying');
          const denyResponse = JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: 'Vault unreachable' } },
          });
          pmClient.inject(managed.pmSessionId, denyResponse).catch(() => {});
          return;
        }

        managed.pendingApprovals.set(approval.approval_id, requestId);
        insertAuditEntry(approval.approval_id, 'requested', managed.agentId || 'unknown', { mcpName, toolName: parsedTool });
        logger.info({ requestId, approvalId: approval.approval_id, mcpName, toolName: parsedTool }, '[approval] created via vault — awaiting human approval');

        const identity = buildApprovalIdentityPayload({
          mcpName, toolName: parsedTool,
          agentDisplayName,
          profileDisplayName,
          humanPreview: approval.human_preview,
        });
        const pairedDevices = getDevices();
        if (pairedDevices.length > 0) {
          sendApprovalPush(
            approval.approval_id,
            approval.human_preview || `${mcpName}: ${parsedTool}`,
            120,
            approval.nonce,
            approval.action_hash,
            identity,
          ).catch(err => {
            logger.warn({ approvalId: approval.approval_id, error: String(err) }, '[approval] push notification failed');
          });
        } else {
          logger.warn({ approvalId: approval.approval_id }, '[approval] no paired devices — browser-only approval');
        }
        sendToSocket(managed, {
          type: 'approval_request', id: approval.approval_id,
          humanPreview: approval.human_preview,
          expiresAt: approval.expires_at, requestId,
          ...identity,
        });
        return; // Do NOT auto-approve — wait for human
      }

      if (riskLevel === 'notify') {
        sendToSocket(managed, {
          type: 'approval_notify', mcpName, toolName: parsedTool,
          humanPreview: `${mcpName}: ${parsedTool}`,
        });
        // Fall through to normal flow
      }
    }

    if (autoApproveSetting === 'true' && toolName !== 'AskUserQuestion') {
      logger.info({ requestId, toolName, sessionId: managed.sessionId }, '[permission] AUTO-APPROVING');
      const sa = getSubagentState(managed.sessionId);
      if (sa.depth === 0) {
        sendToSocket(managed, agentStatusEvent({ status: `Auto-approved: ${toolName}`, phase: 'tool_auto_approved' }));
      }
      const controlResponse = JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { behavior: 'allow' as const, updatedInput: input || {} },
        },
      });
      pmClient.inject(managed.pmSessionId, controlResponse).catch(err => {
        logger.error({ sessionId: managed.sessionId, error: String(err) }, '[permission] auto-approve inject failed');
        sendToSocket(managed, agentStatusEvent({ status: `Auto-approve failed for ${toolName}: ${err}`, phase: 'tool_auto_approve_failed' }));
      });
      return;
    }

    managed.pendingPermissions.set(requestId, { toolName, input });
    logger.info({ requestId, toolName, sessionId: managed.sessionId }, '[permission] NOT auto-approved — broadcasting');

    let broadcastCount = 0;
    for (const [, proc] of getAllActiveProcesses()) {
      if (proc.sessionId === managed.sessionId) {
        sendToSocket(proc, { type: 'permission_request', requestId, toolName, input });
        broadcastCount++;
      }
    }
    logger.info({ requestId, broadcastCount }, '[permission] broadcast complete');
  }
}
