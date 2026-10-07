/**
 * Typed discriminated union for outgoing WebSocket events.
 *
 * Phase A (GAP#725) — starts with AgentStatusEvent. Other event
 * shapes will be added in follow-up tickets as they are migrated
 * from the current free-form Record<string, unknown> emit path.
 */

/**
 * Structured lifecycle label attached to every `agent_status` event.
 *
 * Lifecycle phases (from the D2 brief) describe the agent process /
 * session state. Tool phases describe short-lived status notifications
 * emitted during tool permission handling. Extend only when adding a
 * new emit site — the enum is a contract consumers depend on.
 */
export type AgentStatusPhase =
  | 'process_starting'
  | 'process_started'
  | 'process_exited'
  | 'process_respawning'
  | 'process_gone'
  | 'session_reconnected'
  | 'tool_auto_approved'
  | 'tool_auto_approve_failed';

export interface AgentStatusEvent {
  type: 'agent_status';
  /** User-facing chat-bubble text. Preserved verbatim — never reworded. */
  status: string;
  phase: AgentStatusPhase;
  pid?: number;
  /** Optional error detail. Kept for backward compat with existing emits. */
  error?: string | null;
  /** ISO timestamp, always present. */
  at: string;
}

/**
 * Build a well-formed AgentStatusEvent. All emit sites should go
 * through this factory so `at` is never forgotten and the shape
 * stays consistent.
 */
export function agentStatusEvent(opts: {
  status: string;
  phase: AgentStatusPhase;
  pid?: number;
  error?: string | null;
}): AgentStatusEvent {
  const event: AgentStatusEvent = {
    type: 'agent_status',
    status: opts.status,
    phase: opts.phase,
    at: new Date().toISOString(),
  };
  if (opts.pid !== undefined) event.pid = opts.pid;
  if (opts.error !== undefined) event.error = opts.error;
  return event;
}

/** Union of all outgoing WS events the gateway types today. Extend in follow-ups. */
export type OutgoingWsEvent = AgentStatusEvent;
