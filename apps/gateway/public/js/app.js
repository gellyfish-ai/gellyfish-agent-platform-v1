/**
 * App — routing, event wiring, initialization.
 * Layer 6: imports from all layers. This is the only module that does.
 */

// Detect iOS native app — enables native bridge for navigation
if (window.webkit?.messageHandlers?.gellyfish) {
  window.gellyfish = window.gellyfish || {};
  window.gellyfish._nativeApp = true;
}

import state from './state.js';
import { connect, setOnMessage, toggleConnectionLog, initConnection } from './connection.js';
import {
  addMessage, handleServerMessage, showToolUse, showToolResult,
  getOrCreateDetailRows, retryFromStalePermission, setAgentCallbacks,
  replayTaskEvents, showThinking, hideThinking, updateModalInfo, initMessages,
} from './messages.js';
import { attachReactionTriggers, loadReactions } from './reactions.js';
import { initInput } from './input.js';
import {
  closeSessionPicker, closeSessionPickerOnOverlay,
} from './sessions.js';
import {
  initSessionManager, startNewSession, resumeSession, startProfileSession, startAgentSession,
  loadHistoryAndConnect,
} from './session-manager.js';
import { showCreateProfile, initProfiles, loadProfileForSession } from './profiles.js';
import { initCrews } from './crews.js';
import { renderConversationsPage } from './conversations.js';
import {
  getActiveTab, setShowView, renderTabs, initTabs,
  openSessionTab, openProfileTab, openAgentTab, openAgentTabLocal,
  findTabBySessionId, findTabByAgentId,
  switchTab, showChatView, updateActiveTabProfile,
} from './tabs.js';
import { closeTabMenu } from './tab-menu.js';
import { openSessionInfo } from './session-info.js';
import { navigateTo, showView, initFromUrl, setOnShowView } from './views.js';

// Embedded mode detection
const isEmbedded = new URLSearchParams(window.location.search).has('embedded');

// Wire WebSocket messages to the handler
setOnMessage(handleServerMessage);

// --- Initialize session manager with all its dependencies ---
// This breaks circular imports: session-manager receives callbacks from
// app.js instead of importing sibling modules directly.
initSessionManager({
  openSessionTab,
  openProfileTab,
  openAgentTab,
  findTabBySessionId,
  findTabByAgentId,
  switchTab,
  showChatView,
  closeSessionPicker,
  addMessage,
  showToolUse,
  showToolResult,
  getOrCreateDetailRows,
  retryFromStalePermission,
  updateActiveTabProfile,
  loadProfileForSession,
  renderTabs,
  getActiveTab,
  replayTaskEvents,
  handleServerMessage,
  attachReactionTriggers,
  loadReactions,
});

// --- View routing ---

// Wire views.js to call renderTabs on view switch
setOnShowView(() => renderTabs());

// Give tabs.js a DOM-only view switcher (no URL push)
setShowView(showView);

// Give layer 5 views access to navigateTo via callbacks
initCrews({ navigateTo: (...args) => navigateTo(...args) });
initProfiles({ navigateTo: (...args) => navigateTo(...args) });

// Re-export navigateTo for external consumers
export { navigateTo };

// Wire agent lifecycle callbacks from WebSocket messages
setAgentCallbacks({
  onActiveAgents: (agents) => {
    // Restore tabs from server (DB-backed, syncs across devices)
    let restored = 0;
    for (const agent of agents) {
      if (agent.tab_open && !findTabByAgentId(agent.id)) {
        // Use local open — don't re-notify server (it already knows)
        openAgentTabLocal({
          id: agent.id,
          name: agent.name,
          profile_id: agent.profile_id,
          profile_icon: agent.profile_icon,
          session_id: agent.session_id,
          conversation_id: agent.conversation_id,
          conversation_state: agent.conversation_state,
          issue_number: agent.issue_number,
        });
        restored++;
      }
    }
    console.log(`[ws] restored ${restored} tabs from server (${agents.length} agents total)`);
  },
  onAgentHired: (agent) => {
    console.log(`[ws] agent_hired: ${agent.name}`);
    // If conversations page is open, refresh it
    if (state.currentView === 'conversations') {
      renderConversationsPage();
    }
  },
  onAgentFired: (agent) => {
    console.log(`[ws] agent_fired: ${agent.name}`);
    if (state.currentView === 'conversations') {
      renderConversationsPage();
    }
  },
});

// --- App menu click handlers ---
document.querySelectorAll('.app-menu-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const view = item.dataset.view;
    if (view === 'new-chat') {
      startNewSession();
    } else {
      navigateTo(view);
    }
  });
});

// Header new chat button
document.getElementById('header-new-chat-btn').addEventListener('click', () => {
  startNewSession();
});

// --- Header button handlers ---
document.getElementById('status').addEventListener('click', toggleConnectionLog);

document.getElementById('session-info-btn').addEventListener('click', () => {
  const activeTab = getActiveTab();
  const ctx = activeTab || {
    sessionId: state.sessionId,
    profileId: state.activeProfileId,
    name: 'Current Session',
    icon: null,
  };
  // Always provide fresh stats from live state or stored tab
  ctx.connected = state.ws && state.ws.readyState === WebSocket.OPEN;
  ctx.stats = {
    messages: activeTab ? (state.activeTabId === activeTab.id ? state.messageCount : (activeTab.messageCount || 0)) : state.messageCount,
    userMessages: activeTab ? (state.activeTabId === activeTab.id ? state.userMessageCount : (activeTab.userMessageCount || 0)) : state.userMessageCount,
    assistantMessages: activeTab ? (state.activeTabId === activeTab.id ? state.assistantMessageCount : (activeTab.assistantMessageCount || 0)) : state.assistantMessageCount,
    toolUses: activeTab ? (state.activeTabId === activeTab.id ? state.toolCount : (activeTab.toolCount || 0)) : state.toolCount,
    permissions: activeTab ? (state.activeTabId === activeTab.id ? state.permissionCount : (activeTab.permissionCount || 0)) : state.permissionCount,
    cost: activeTab ? (state.activeTabId === activeTab.id ? state.totalCost : (activeTab.totalCost || 0)) : state.totalCost,
  };
  openSessionInfo(ctx);
});

// --- Modal close handlers ---
document.getElementById('session-modal').addEventListener('click', closeSessionPickerOnOverlay);

document.getElementById('session-modal-close-btn').addEventListener('click', closeSessionPicker);

document.getElementById('new-session-btn').addEventListener('click', startNewSession);

document.getElementById('new-profile-modal-btn').addEventListener('click', showCreateProfile);

// Tool detail modal
document.getElementById('tool-detail-modal').addEventListener('click', (event) => {
  if (event.target === document.getElementById('tool-detail-modal')) {
    document.getElementById('tool-detail-modal').classList.remove('open');
  }
});
document.getElementById('tool-detail-close-btn').addEventListener('click', () => {
  document.getElementById('tool-detail-modal').classList.remove('open');
});

// Escape key closes modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSessionPicker();
    closeTabMenu();
    document.getElementById('tab-info-modal').classList.remove('open');
    document.getElementById('tool-detail-modal').classList.remove('open');
  }
});

// Reconnect when tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Force reconnect — WebSocket may be zombie after suspension
    state.connectingInProgress = false;
    if (state.ws) {
      try { state.ws.close(); } catch {}
      state.ws = null;
    }
    import('./connection.js').then(m => {
      m.connLog('Tab became visible — force reconnecting...');
      m.connect(state.sessionId || state.resumeSessionId);
    });
  }
});

// --- URL routing ---

/** Route to the correct view based on the current URL. */
function routeFromUrl() {
  const { viewId, params } = initFromUrl();

  if (viewId === 'chat' && params.sessionId) {
    showView('chat');
    resumeSession(params.sessionId);
  } else if (viewId === 'chat') {
    showView('chat');
    connect();
  } else {
    navigateTo(viewId, params);
    connect();
  }
}

window.addEventListener('popstate', () => {
  routeFromUrl();
});

// --- Hamburger menu (mobile) ---
const hamburgerBtn = document.getElementById('hamburger-btn');
let hamburgerMenu = null;

function closeHamburger() {
  if (hamburgerMenu) {
    const menu = hamburgerMenu;
    hamburgerMenu = null;
    // Defer removal so the click event finishes on the menu element,
    // not on whatever is underneath (e.g. System Status button).
    requestAnimationFrame(() => menu.remove());
  }
}

hamburgerBtn.addEventListener('click', () => {
  if (hamburgerMenu) { closeHamburger(); return; }

  hamburgerMenu = document.createElement('div');
  hamburgerMenu.className = 'hamburger-menu';

  // Clone nav items
  document.querySelectorAll('.app-menu-item').forEach(item => {
    const link = document.createElement('a');
    link.href = item.href;
    link.className = 'app-menu-item' + (item.classList.contains('active') ? ' active' : '');
    link.dataset.view = item.dataset.view;
    link.textContent = item.dataset.view === 'new-chat' ? '+ New Chat' : item.textContent;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeHamburger();
      if (link.dataset.view === 'new-chat') {
        startNewSession();
      } else {
        navigateTo(link.dataset.view);
      }
    });
    hamburgerMenu.appendChild(link);
  });

  // Session info link
  const infoLink = document.createElement('a');
  infoLink.href = '#';
  infoLink.className = 'app-menu-item';
  infoLink.textContent = 'Session Info';
  infoLink.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeHamburger();
    document.getElementById('session-info-btn').click();
  });
  hamburgerMenu.appendChild(infoLink);

  document.querySelector('header').appendChild(hamburgerMenu);
});

// Close hamburger when tapping outside
document.addEventListener('click', (e) => {
  if (hamburgerMenu && !hamburgerBtn.contains(e.target) && !hamburgerMenu.contains(e.target)) {
    closeHamburger();
  }
});

// --- Auto-approve toggle wired to server setting ---
const autoApproveToggle = document.getElementById('auto-approve-toggle');

async function loadAutoApprove() {
  try {
    const res = await fetch('/api/settings/auto-approve');
    const data = await res.json();
    autoApproveToggle.checked = data.enabled;
  } catch { /* keep default */ }
}

autoApproveToggle.addEventListener('change', async () => {
  try {
    await fetch('/api/settings/auto-approve', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: autoApproveToggle.checked }),
    });
  } catch { /* revert on failure */ autoApproveToggle.checked = !autoApproveToggle.checked; }
});

// --- External links open in new tab ---
// Links rendered by renderMarkdown() already have target="_blank" via DOM post-processing.
// This handler is a safety net for any external link that slips through without target.
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (!link) return;
  // Already has target="_blank" — let browser handle natively
  if (link.target === '_blank') return;
  const href = link.getAttribute('href');
  if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
    e.preventDefault();
    e.stopPropagation(); // prevent SPA router from catching this
    window.open(href, '_blank', 'noopener,noreferrer');
  }
});

// --- Initialize DOM ---
initConnection();
initMessages();

if (isEmbedded) {
  initEmbeddedMode();
} else {
  initTabs();
  initInput({ addMessage, showThinking, hideThinking, updateModalInfo });
  loadAutoApprove();
  routeFromUrl();
}

// --- Embedded mode ---

function initEmbeddedMode() {
  document.body.classList.add('embedded');

  // Extract sessionId from URL path: /session/:id
  const match = window.location.pathname.match(/\/session\/([a-f0-9-]+)/);
  const sessionId = match?.[1];

  if (sessionId) {
    loadHistoryAndConnect(sessionId);
  } else {
    connect();
  }

  // Expose bridge for native app / iframe parent
  window.gellyfish = window.gellyfish || {};
  window.gellyfish.sendMessage = (text) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    addMessage(text, 'user', false, null, new Date().toISOString());
    state.ws.send(JSON.stringify({ type: 'user_message', content: text }));
  };
  window.gellyfish.attachImage = (base64, mimeType) => {
    import('./input.js').then(m => m.queueImage(base64, mimeType));
  };
}
