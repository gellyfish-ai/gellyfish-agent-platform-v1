// Shared mutable state — single source of truth for the app
const state = {
  ws: null,
  currentAssistantMsg: null,
  isProcessing: false,
  totalCost: 0,
  sessionId: null,
  messageCount: 0,
  userMessageCount: 0,
  assistantMessageCount: 0,
  toolCount: 0,
  permissionCount: 0,
  toolDetails: new Map(),
  activeProfileId: null,
  activeAgentId: null,
  activeConversationId: null,
  resumeSessionId: null,
  connectionId: 0,
  reconnectAttempts: 0,
  connectingInProgress: false,
  lastToolUseId: null,
  thinkingEl: null,
  keepaliveInterval: null,

  // Message history
  messageHistory: [],
  historyIndex: -1,
  historyDraft: '',

  // Draft autosave
  draftTimer: null,

  // Current view
  currentView: 'chat', // 'chat' | 'conversations' | 'profiles' | 'crews'

  // Open tabs — each: { id, sessionId, profileId, agentId, conversationId, icon, name, ... }
  tabs: [],
  activeTabId: null,
};

/** Reset all session-specific state. Pass overrides to restore from a tab. */
export function resetSessionState(overrides = {}) {
  state.sessionId = overrides.sessionId ?? null;
  state.resumeSessionId = overrides.resumeSessionId ?? null;
  state.activeProfileId = overrides.activeProfileId ?? null;
  state.activeAgentId = overrides.activeAgentId ?? null;
  state.activeConversationId = overrides.activeConversationId ?? null;
  state.messageCount = overrides.messageCount ?? 0;
  state.userMessageCount = overrides.userMessageCount ?? 0;
  state.assistantMessageCount = overrides.assistantMessageCount ?? 0;
  state.toolCount = overrides.toolCount ?? 0;
  state.permissionCount = overrides.permissionCount ?? 0;
  state.totalCost = overrides.totalCost ?? 0;
  state.currentAssistantMsg = null;
  state.isProcessing = overrides.isProcessing ?? false;
  state.toolDetails = overrides.toolDetails ?? new Map();
}

export function setProcessing(processing) {
  state.isProcessing = processing;
}

export default state;
