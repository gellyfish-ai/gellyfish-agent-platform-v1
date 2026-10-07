/**
 * DB barrel — re-exports for backward compatibility.
 * Import directly from source files for new code.
 */

// Connection + schema
export { default, DATA_DIR, WORKSPACES_DIR, UUID_RE, createProfileWorkspace, createAgentWorkspace } from './connection.js';

// Types
export type { Profile } from './types.js';
export type { Crew, CrewMember, MemberRef, CrewContext } from './types.js';
export type { Task, TaskClarification } from './types.js';
export { TERMINAL_TASK_STATES } from './types.js';
export type { TaskState, AgentState, ConversationState } from './types.js';
export type { Agent } from './types.js';
export type { Conversation } from './types.js';
export type { McpServer } from './types.js';
export type { ConversationSummary } from './types.js';

// Repository modules
export { createAgent, getAgent, listAgents, updateAgentState, getAgentForProfile } from './agents.js';
export { createConversation, getConversation, getAgentConversation, updateConversationState, updateConversationSession } from './conversations.js';
export { createTask, updateTaskState, getTask, listTasks, storeSessionTaskEvent, getSessionTaskEvents, taskEvents, incrementBlockCount, createClarification, getClarification, getOpenClarification, answerClarification, timeoutClarification, getTaskClarifications } from './tasks.js';
export { getProfileMcpConfig, getProfileCrewContext } from './profiles.js';
export { getSetting, setSetting } from './settings.js';
export { upsertReaction, removeReaction, getReactions } from './reactions.js';
export { insertSummary, getSummaries } from './summaries.js';
export { getRiskLevel, setRiskLevel, getAllRiskLevels, getRiskLevelsForMcp, parseMcpToolName } from './risk-levels.js';
export { registerDevice, getDevices, getDevice, deleteDevice } from './devices.js';
export { insertAuditEntry, getAuditLog } from './audit-log.js';
