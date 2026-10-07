/**
 * MCP telemetry logger — writes tool call events to mcp_tool_calls table.
 */

import crypto from 'crypto';
import db from '../db/connection.js';
import { logger } from '../logger.js';
import type { ToolCallEvent } from './sse-parser.js';

export interface ToolCallContext {
  sessionId?: string;
  agentId?: string;
  profileId?: string;
  mcpName: string;
}

const pendingCalls = new Map<string, string>();
const pendingStartTimes = new Map<string, number>();
const pendingToolNames = new Map<string, string>();

function callKey(mcpName: string, requestId: string | number): string {
  return `${mcpName}:${requestId}`;
}

export function logToolCallStart(event: ToolCallEvent, context: ToolCallContext): void {
  const id = crypto.randomUUID();
  const key = callKey(event.mcpName, event.requestId);
  pendingCalls.set(key, id);
  pendingStartTimes.set(key, Date.now());
  if (event.toolName) pendingToolNames.set(key, event.toolName);

  try {
    db.prepare(`
      INSERT INTO mcp_tool_calls (id, session_id, agent_id, profile_id, mcp_name, tool_name, started_at, input_preview)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(id, context.sessionId ?? null, context.agentId ?? null, context.profileId ?? null,
      context.mcpName, event.toolName ?? 'unknown', event.inputPreview ?? null);
  } catch (err) {
    logger.warn({ mcpName: context.mcpName, toolName: event.toolName, error: String(err) }, '[mcp-telemetry] failed to log tool_start');
  }
}

export function logToolCallEnd(event: ToolCallEvent): void {
  const key = callKey(event.mcpName, event.requestId);
  const id = pendingCalls.get(key);
  pendingCalls.delete(key);

  if (!id) return;

  const startTime = pendingStartTimes.get(key);
  pendingStartTimes.delete(key);
  pendingToolNames.delete(key);
  const durationMs = startTime ? Date.now() - startTime : null;

  try {
    db.prepare(`
      UPDATE mcp_tool_calls
      SET finished_at = datetime('now'), duration_ms = ?, success = ?, error_code = ?, output_preview = ?
      WHERE id = ?
    `).run(durationMs, event.success ? 1 : 0, event.errorCode ?? null,
      event.outputPreview ?? null, id);
  } catch (err) {
    logger.warn({ mcpName: event.mcpName, error: String(err) }, '[mcp-telemetry] failed to log tool_end');
  }
}

export function getPendingToolName(mcpName: string, requestId: string | number): string | undefined {
  return pendingToolNames.get(callKey(mcpName, requestId));
}
