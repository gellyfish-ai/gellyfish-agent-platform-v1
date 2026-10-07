/**
 * Shared DB types — entity interfaces used across repository modules.
 */

export interface Profile {
  id: string;
  name: string;
  icon: string;
  system_prompt: string;
  workspace_dir: string;
  model: string | null;
  brief_mode: number; // 0 = off, 1 = on (SQLite boolean)
  confirmed_model: string | null; // Full model ID from process init event (e.g. "claude-opus-4-6")
  created_at: string;
  updated_at: string;
}

export interface Crew {
  id: string;
  name: string;
  slug: string | null;
  icon: string;
  lead_profile_id: string | null;
  lead_agent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrewMember {
  crew_id: string;
  profile_id: string;
  added_at: string;
}

export interface Task {
  id: string;
  creator_agent_id: string | null;
  assignee_agent_id: string | null;
  state: 'submitted' | 'working' | 'input-required' | 'blocked' | 'completed' | 'failed' | 'canceled';
  keep_alive: number;
  block_count: number;
  message: string;
  result: string | null;
  error: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export type TaskState = Task['state'];

export const TERMINAL_TASK_STATES: TaskState[] = ['completed', 'failed', 'canceled'];

export interface TaskClarification {
  id: string;
  task_id: string;
  question: string;
  answer: string | null;
  asked_at: string;
  answered_at: string | null;
  timed_out: number;
}

export type AgentState = 'idle' | 'working' | 'stopped';

export interface Agent {
  id: string;
  profile_id: string;
  name: string;
  state: AgentState;
  workspace_dir: string;
  created_at: string;
  stopped_at: string | null;
}

export type ConversationState = 'cold' | 'dormant' | 'active';

export interface Conversation {
  id: string;
  agent_id: string;
  title: string | null;
  session_id: string | null;
  issue_number: number | null;
  model: string | null;
  state: ConversationState;
  created_at: string;
  updated_at: string;
}

export interface McpServer {
  id: string;
  name: string;
  type: 'global' | 'available';
  command: string;
  args: string;
  env: string;
  created_at: string;
}

export interface MemberRef {
  profile_id: string;
  profile_name: string;
  icon: string;
  agent_id: string | null;
  agent_name: string | null;
  workspace_dir: string | null;
  session_id: string | null;
}

export interface CrewContext {
  leading: {
    crew_name: string;
    members: MemberRef[];
  }[];
  memberOf: {
    crew_name: string;
    lead: MemberRef | null;
    other_members: MemberRef[];
  }[];
}

export interface ConversationSummary {
  id: string;
  conversation_id: string;
  session_id: string | null;
  summary: string;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  created_at: string;
}
