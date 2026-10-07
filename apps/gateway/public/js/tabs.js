import state, { resetSessionState } from './state.js';
import { escapeHtml, pushUrl, urlFor } from './utils.js';
import { connect, disconnect } from './connection.js';
import { updateModalInfo } from './messages.js';
import { loadHistoryAndConnect } from './session-manager.js';
import { openTabMenu, closeTabMenu } from './tab-menu.js';

// DOM-only view switcher — set by app.js. Shows/hides views without pushing URL.
let showViewFn = null;
export function setShowView(fn) {
  showViewFn = fn;
}

export function showChatView() {
  if (showViewFn) showViewFn('chat');
}

let messagesEl = null;
let tabBarEl = null;

export function initTabs() {
  messagesEl = document.getElementById('messages');
  tabBarEl = document.getElementById('tab-bar');
}

let tabIdCounter = 0;
function nextTabId() {
  return 'tab-' + (++tabIdCounter);
}

// --- Saving / restoring per-tab state ---

function saveCurrentTab() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab) return;
  tab.sessionId = state.sessionId;
  tab.agentId = state.activeAgentId || tab.agentId;
  tab.conversationId = state.activeConversationId || tab.conversationId;
  tab.messageCount = state.messageCount;
  tab.userMessageCount = state.userMessageCount;
  tab.assistantMessageCount = state.assistantMessageCount;
  tab.toolCount = state.toolCount;
  tab.permissionCount = state.permissionCount;
  tab.totalCost = state.totalCost;
  tab.toolDetails = new Map(state.toolDetails);
  tab.isProcessing = state.isProcessing;
  tab.currentAssistantMsg = null; // Can't serialize DOM ref
}

function restoreTab(tab) {
  resetSessionState({
    sessionId: tab.sessionId,
    activeProfileId: tab.profileId,
    activeAgentId: tab.agentId,
    activeConversationId: tab.conversationId,
    messageCount: tab.messageCount,
    userMessageCount: tab.userMessageCount,
    assistantMessageCount: tab.assistantMessageCount,
    toolCount: tab.toolCount,
    permissionCount: tab.permissionCount,
    totalCost: tab.totalCost,
    toolDetails: tab.toolDetails,
    isProcessing: tab.isProcessing,
  });
  state.activeTabId = tab.id;

  if (messagesEl) {
    messagesEl.innerHTML = `
      <div class="empty-state">
        <h2>${tab.icon ? tab.icon + ' ' : ''}${escapeHtml(tab.name)}</h2>
        <p>${tab.sessionId ? 'Loading...' : 'Starting new session...'}</p>
      </div>
    `;
  }
}

// --- Server-side tab persistence (syncs across devices) ---

/** Notify server that a tab was opened */
export function serverOpenTab(agentId) {
  if (!agentId) { console.warn('[tabs] serverOpenTab called with no agentId'); return; }
  console.log('[tabs] serverOpenTab', agentId);
  fetch(`/api/tabs/${agentId}`, { method: 'POST' })
    .then(r => { if (!r.ok) console.error('[tabs] serverOpenTab failed:', r.status); })
    .catch(err => console.error('[tabs] serverOpenTab error:', err));
}

/** Notify server that a tab was closed */
export function serverCloseTab(agentId) {
  if (!agentId) return;
  fetch(`/api/tabs/${agentId}`, { method: 'DELETE' }).catch(() => {});
}

/** No-op — kept for backward compat with app.js imports */
export function markTabsRestored() {}
export function getSavedTabAgentIds() { return []; }

// --- Rendering the tab bar ---

export function renderTabs() {
  if (!tabBarEl) return;
  tabBarEl.innerHTML = '';

  if (state.tabs.length === 0) {
    tabBarEl.classList.remove('visible');
    return;
  }

  tabBarEl.classList.add('visible');

  for (const tab of state.tabs) {
    const el = document.createElement('div');
    const isActive = tab.id === state.activeTabId && state.currentView === 'chat';
    el.className = 'tab-item' + (isActive ? ' active' : '');
    el.dataset.tabId = tab.id;

    // Three-dot menu + info button on active tab only
    if (isActive) {
      const menuBtn = document.createElement('button');
      menuBtn.className = 'tab-menu-btn';
      menuBtn.title = 'Tab options';
      menuBtn.textContent = '\u22EE';
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTabMenu(tab.id, menuBtn);
      });
      el.appendChild(menuBtn);
    }

    // State indicator dot
    if (tab.conversationState) {
      const dot = document.createElement('span');
      dot.className = 'tab-state-dot';
      if (tab.conversationState === 'active') {
        dot.style.background = '#22c55e';
        dot.title = 'Active';
      } else if (tab.conversationState === 'dormant') {
        dot.style.background = '#eab308';
        dot.title = 'Dormant';
      } else {
        dot.style.background = '#6b7280';
        dot.title = 'Cold';
      }
      el.appendChild(dot);
    }

    const label = document.createElement('span');
    label.className = 'tab-label';

    // Label: agent name with optional crew badge and issue number
    if (tab.agentId && tab.name) {
      const issueTag = tab.issueNumber ? ` — #${tab.issueNumber}` : '';
      const icon = tab.icon ? tab.icon + ' ' : '';
      label.textContent = icon + tab.name + issueTag;
      label.title = tab.name + (tab.crewIcon ? ` (${tab.crewIcon})` : '') + issueTag;
    } else if (tab.profileId) {
      label.textContent = (tab.icon ? tab.icon + ' ' : '') + tab.name;
      label.title = tab.name;
    } else if (tab.name && tab.name !== 'New Chat') {
      label.textContent = tab.name;
      label.title = tab.name;
    } else {
      label.textContent = 'New Chat';
      label.title = 'New Chat';
    }

    el.appendChild(label);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.title = 'Close tab';
    closeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.appendChild(closeBtn);

    el.addEventListener('click', () => switchTab(tab.id));
    tabBarEl.appendChild(el);
  }
}

// --- Public API ---

/**
 * Find an existing tab for an agent, or return null.
 */
export function findTabByAgentId(agentId) {
  return state.tabs.find(t => t.agentId === agentId) || null;
}

/**
 * Find an existing tab for a profile, or return null.
 */
export function findTabByProfileId(profileId) {
  return state.tabs.find(t => t.profileId === profileId) || null;
}

/**
 * Find an existing tab for a session, or return null.
 */
export function findTabBySessionId(sessionId) {
  return state.tabs.find(t => t.sessionId === sessionId) || null;
}

/**
 * Open a tab for an agent. If already open, switch to it.
 * Returns the tab object.
 */
export function openAgentTab(agent) {
  const existing = findTabByAgentId(agent.id);
  if (existing) {
    switchTab(existing.id);
    return existing;
  }

  saveCurrentTab();

  const tab = {
    id: nextTabId(),
    sessionId: agent.session_id || null,
    profileId: agent.profile_id,
    agentId: agent.id,
    conversationId: agent.conversation_id || null,
    conversationState: agent.conversation_state || null,
    issueNumber: agent.issue_number || null,
    icon: agent.profile_icon || agent.icon || null,
    crewIcon: agent.crew_icon || null,
    name: agent.name,
    messageCount: 0,
    toolCount: 0,
    totalCost: 0,
    toolDetails: new Map(),
    isProcessing: false,
  };

  state.tabs.push(tab);
  state.activeTabId = tab.id;
  serverOpenTab(agent.id);
  renderTabs();
  return tab;
}

/**
 * Open a tab locally without notifying server (for syncing from broadcasts).
 */
export function openAgentTabLocal(agent) {
  if (findTabByAgentId(agent.id)) return;
  const tab = {
    id: nextTabId(),
    sessionId: agent.session_id || null,
    profileId: agent.profile_id,
    agentId: agent.id,
    conversationId: agent.conversation_id || null,
    conversationState: agent.conversation_state || null,
    issueNumber: agent.issue_number || null,
    icon: agent.profile_icon || agent.icon || null,
    crewIcon: agent.crew_icon || null,
    name: agent.name,
    messageCount: 0,
    toolCount: 0,
    totalCost: 0,
    toolDetails: new Map(),
    isProcessing: false,
  };
  state.tabs.push(tab);
  renderTabs();
}

/**
 * Open a tab for a profile. If already open, switch to it.
 * Returns the tab object.
 */
export function openProfileTab(profile) {
  // Check if this profile already has an open tab
  const existing = findTabByProfileId(profile.id);
  if (existing) {
    switchTab(existing.id);
    return existing;
  }

  // Save current tab state before opening new one
  saveCurrentTab();

  const tab = {
    id: nextTabId(),
    sessionId: profile.session_id || null,
    profileId: profile.id,
    icon: profile.icon,
    name: profile.name,
    messageCount: 0,
    toolCount: 0,
    totalCost: 0,
    toolDetails: new Map(),
    isProcessing: false,
    formerProfileId: null,
    formerProfileName: null,
    formerProfileIcon: null,
    formerProfileSeq: 0,
  };

  state.tabs.push(tab);
  state.activeTabId = tab.id;
  renderTabs();
  return tab;
}

/**
 * Open a tab for a plain session (no profile).
 * Returns the tab object.
 */
export function openSessionTab(sessionId, label) {
  // Check if this session already has a tab
  if (sessionId) {
    const existing = findTabBySessionId(sessionId);
    if (existing) {
      switchTab(existing.id);
      return existing;
    }
  }

  saveCurrentTab();

  const tab = {
    id: nextTabId(),
    sessionId: sessionId || null,
    profileId: null,
    icon: null,
    name: label || 'New Chat',
    messageCount: 0,
    toolCount: 0,
    totalCost: 0,
    toolDetails: new Map(),
    isProcessing: false,
    formerProfileId: null,
    formerProfileName: null,
    formerProfileIcon: null,
    formerProfileSeq: 0,
  };

  state.tabs.push(tab);
  state.activeTabId = tab.id;
  renderTabs();
  return tab;
}

/**
 * Update the active tab's sessionId (e.g., after server assigns one).
 */
export function updateActiveTabSessionId(sessionId) {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (tab) tab.sessionId = sessionId;
}

/**
 * Update the active tab's profile info (e.g., after loading profile for a resumed session).
 */
export function updateActiveTabProfile(profileId, icon, name) {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (tab) {
    tab.profileId = profileId;
    tab.icon = icon;
    tab.name = name;
    renderTabs();
  }
}

/**
 * Switch to a tab by ID.
 */
export function switchTab(tabId) {
  const target = state.tabs.find(t => t.id === tabId);
  if (!target) return;

  // Always show chat view (even if tab is already active — user may be on profiles page)
  showChatView();

  // If this tab is already the active one, just ensure the view is shown
  if (tabId === state.activeTabId) return;

  // Save current tab
  saveCurrentTab();

  // Disconnect current WS
  disconnect();

  // Restore target
  restoreTab(target);
  renderTabs();

  // Update URL
  pushUrl(urlFor('chat', { sessionId: target.sessionId }));

  // Always load history from API on tab switch (no HTML cache)
  if (target.sessionId) {
    loadHistoryAndConnect(target.sessionId);
  } else {
    connect(null);
  }
  updateModalInfo();
}

/**
 * Close a tab by ID. Does NOT delete the session.
 */
export function closeTab(tabId) {
  const idx = state.tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  const closingTab = state.tabs[idx];
  if (closingTab.agentId) serverCloseTab(closingTab.agentId);

  const wasActive = tabId === state.activeTabId;
  state.tabs.splice(idx, 1);

  if (wasActive) {
    if (state.tabs.length > 0) {
      // Switch to the nearest tab
      const newIdx = Math.min(idx, state.tabs.length - 1);
      const newTab = state.tabs[newIdx];
      state.activeTabId = null; // Clear so switchTab doesn't bail
      switchTab(newTab.id);
    } else {
      // No tabs left — go to clean state
      state.activeTabId = null;
      disconnect();
      resetSessionState();

      messagesEl.innerHTML = `
        <div class="empty-state">
          <h2>Welcome to Gellyfish</h2>
          <p>Your personal AI assistant with full tool access.<br>Type a message to get started.</p>
        </div>
      `;

      pushUrl('/');
      connect();
      updateModalInfo();
    }
  }

  renderTabs();
}

/**
 * Close a tab locally without notifying server (for syncing from broadcasts).
 */
export function closeTabLocal(tabId) {
  const idx = state.tabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  state.tabs.splice(idx, 1);
  if (tabId === state.activeTabId && state.tabs.length > 0) {
    const newIdx = Math.min(idx, state.tabs.length - 1);
    switchTab(state.tabs[newIdx].id);
  } else if (state.tabs.length === 0) {
    state.activeTabId = null;
  }
  renderTabs();
}

/**
 * Get the active tab, or null.
 */
export function getActiveTab() {
  return state.tabs.find(t => t.id === state.activeTabId) || null;
}
