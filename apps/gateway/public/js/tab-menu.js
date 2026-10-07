/**
 * Tab Context Menu — right-click actions for tabs.
 *
 * The info modal has been extracted to session-info.js.
 */

import state from './state.js';
import { escapeHtml } from './utils.js';
import { renderTabs, closeTab, updateActiveTabProfile } from './tabs.js';
export { openSessionInfo as openTabInfo } from './session-info.js';

let currentMenu = null;

export function closeTabMenu() {
  if (currentMenu) {
    currentMenu.remove();
    currentMenu = null;
  }
  document.removeEventListener('click', onOutsideClick);
  document.removeEventListener('keydown', onEscapeKey);
}

export function openTabMenu(tabId, anchorEl) {
  closeTabMenu();

  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return;

  const menu = document.createElement('div');
  menu.className = 'tab-menu';
  currentMenu = menu;

  const hasSession = !!tab.sessionId;
  const hasProfile = !!tab.profileId;

  if (!hasSession) {
    addMenuItem(menu, 'Name & Start', () => showInlineRename(menu, tab, true));
    addMenuDivider(menu);
    addMenuItem(menu, 'Attach to Profile', () => showProfilePicker(menu, tab));
    addMenuItem(menu, 'New Profile', () => {
      closeTabMenu();
      import('./sessions.js').then(m => m.openSessionPicker());
      setTimeout(() => import('./profiles.js').then(m => m.showCreateProfile()), 100);
    });
  } else if (!hasProfile) {
    addMenuItem(menu, 'Rename', () => showInlineRename(menu, tab, false));
    addMenuDivider(menu);
    addMenuItem(menu, 'Attach to Profile', () => showProfilePicker(menu, tab));
    addMenuItem(menu, 'New Profile from Session', () => {
      closeTabMenu();
      createProfileFromSession(tab);
    });
  } else {
    addMenuItem(menu, 'Rename', () => showInlineRename(menu, tab, false));
    addMenuDivider(menu);
    addMenuItem(menu, 'Change Profile', () => showProfilePicker(menu, tab));
    addMenuItem(menu, 'Detach from Profile', () => {
      closeTabMenu();
      detachFromProfile(tab);
    });
  }

  addMenuDivider(menu);
  addMenuItem(menu, 'Info', async () => {
    closeTabMenu();
    const { openSessionInfo } = await import('./session-info.js');
    const isActive = state.activeTabId === tab.id;
    tab.stats = {
      messages: isActive ? state.messageCount : (tab.messageCount || 0),
      userMessages: isActive ? state.userMessageCount : (tab.userMessageCount || 0),
      assistantMessages: isActive ? state.assistantMessageCount : (tab.assistantMessageCount || 0),
      toolUses: isActive ? state.toolCount : (tab.toolCount || 0),
      permissions: isActive ? state.permissionCount : (tab.permissionCount || 0),
      cost: isActive ? state.totalCost : (tab.totalCost || 0),
    };
    tab.connected = state.ws && state.ws.readyState === WebSocket.OPEN;
    openSessionInfo(tab);
  });
  addMenuItem(menu, 'Close Tab', () => {
    closeTabMenu();
    closeTab(tab.id);
  });
  if (hasSession) {
    addMenuItem(menu, 'Stop Process', async () => {
      closeTabMenu();
      await fetch(`/api/sessions/${tab.sessionId}/stop`, { method: 'POST' });
    });
    addMenuItem(menu, 'Delete Session', () => {
      showDeleteConfirm(menu, tab);
    }, 'danger');
  }

  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  menu.style.top = rect.bottom + 4 + 'px';
  menu.style.left = rect.left + 'px';

  requestAnimationFrame(() => {
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth - 8) {
      menu.style.left = (window.innerWidth - menuRect.width - 8) + 'px';
    }
  });

  setTimeout(() => {
    document.addEventListener('click', onOutsideClick);
    document.addEventListener('keydown', onEscapeKey);
  }, 0);
}

// ── Menu helpers ────────────────────────────────────────────

function addMenuItem(menu, label, onClick, variant) {
  const item = document.createElement('button');
  item.className = 'tab-menu-item' + (variant ? ` tab-menu-item-${variant}` : '');
  item.textContent = label;
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  menu.appendChild(item);
}

function addMenuDivider(menu) {
  const div = document.createElement('div');
  div.className = 'tab-menu-divider';
  menu.appendChild(div);
}

function onOutsideClick(e) {
  if (currentMenu && !currentMenu.contains(e.target)) closeTabMenu();
}

function onEscapeKey(e) {
  if (e.key === 'Escape') closeTabMenu();
}

// ── Delete confirmation ─────────────────────────────────────

function showDeleteConfirm(menu, tab) {
  menu.innerHTML = '';

  const warning = document.createElement('div');
  warning.className = 'tab-menu-item tab-menu-item-muted';
  warning.style.cssText = 'font-size: 0.75rem; padding: 0.5rem 0.6rem; white-space: normal; line-height: 1.4;';
  warning.textContent = 'This will permanently delete the session and all its conversation history. This cannot be undone.';
  menu.appendChild(warning);

  const actions = document.createElement('div');
  actions.className = 'tab-menu-input-actions';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'tab-menu-item tab-menu-item-danger';
  confirmBtn.textContent = 'Delete forever';
  confirmBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    confirmBtn.textContent = 'Deleting...';
    confirmBtn.disabled = true;
    try {
      await fetch(`/api/sessions/${tab.sessionId}`, { method: 'DELETE' });
      closeTabMenu();
      closeTab(tab.id);
    } catch (err) {
      console.error('Failed to delete session:', err);
      confirmBtn.textContent = 'Failed \u2014 try again';
      confirmBtn.disabled = false;
    }
  });
  actions.appendChild(confirmBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'tab-menu-item tab-menu-item-muted';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTabMenu(); });
  actions.appendChild(cancelBtn);

  menu.appendChild(actions);
}

// ── Inline rename ───────────────────────────────────────────

function showInlineRename(menu, tab, isNewSession) {
  menu.innerHTML = '';

  const input = document.createElement('input');
  input.className = 'tab-menu-input';
  input.type = 'text';
  input.value = (tab.name === 'New Chat' ? '' : tab.name) || '';
  input.placeholder = isNewSession ? 'Name this session...' : 'Session name...';
  menu.appendChild(input);

  const actions = document.createElement('div');
  actions.className = 'tab-menu-input-actions';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'tab-menu-item';
  confirmBtn.textContent = isNewSession ? 'Start' : 'Save';
  confirmBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const name = input.value.trim();
    if (!name) return;
    tab.name = name;
    if (tab.agentId) {
      fetch(`/api/agents/${tab.agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    }
    if (tab.sessionId) {
      fetch(`/api/sessions/${tab.sessionId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    }
    renderTabs();
    closeTabMenu();
  });
  actions.appendChild(confirmBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'tab-menu-item tab-menu-item-muted';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTabMenu(); });
  actions.appendChild(cancelBtn);

  menu.appendChild(actions);
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmBtn.click();
    if (e.key === 'Escape') closeTabMenu();
  });
}

// ── Profile picker ──────────────────────────────────────────

async function showProfilePicker(menu, tab) {
  menu.innerHTML = '';

  const loading = document.createElement('div');
  loading.className = 'tab-menu-item tab-menu-item-muted';
  loading.textContent = 'Loading profiles...';
  menu.appendChild(loading);

  try {
    const resp = await fetch('/api/profiles');
    const data = await resp.json();
    const profiles = data.profiles || [];
    menu.innerHTML = '';

    if (profiles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tab-menu-item tab-menu-item-muted';
      empty.textContent = 'No profiles yet';
      menu.appendChild(empty);
      return;
    }

    for (const profile of profiles) {
      const hasExisting = profile.session_id && profile.session_id !== tab.sessionId;
      const item = document.createElement('button');
      item.className = 'tab-menu-item';
      let label = `${profile.icon} ${escapeHtml(profile.name)}`;
      if (hasExisting) label += '<span class="tab-menu-warning"> (will detach current)</span>';
      item.innerHTML = label;
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeTabMenu();
        await attachToProfile(tab, profile);
      });
      menu.appendChild(item);
    }
  } catch {
    menu.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'tab-menu-item tab-menu-item-muted';
    err.textContent = 'Failed to load profiles';
    menu.appendChild(err);
  }
}

// ── Profile actions ─────────────────────────────────────────

async function attachToProfile(tab, profile) {
  if (!tab.sessionId) return;
  try {
    const resp = await fetch(`/api/sessions/${tab.sessionId}/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: profile.id }),
    });
    const data = await resp.json();

    tab.profileId = profile.id;
    tab.icon = profile.icon;
    tab.name = profile.name;
    tab.formerProfileId = null;
    tab.formerProfileName = null;
    tab.formerProfileIcon = null;
    tab.formerProfileSeq = 0;

    state.activeProfileId = profile.id;
    updateActiveTabProfile(profile.id, profile.icon, profile.name);

    if (data.detachedSessionId) {
      const detachedTab = state.tabs.find(t => t.sessionId === data.detachedSessionId);
      if (detachedTab) {
        detachedTab.profileId = null;
        detachedTab.formerProfileId = profile.id;
        detachedTab.formerProfileName = profile.name;
        detachedTab.formerProfileIcon = profile.icon;
        detachedTab.formerProfileSeq = 1;
      }
    }
    renderTabs();
  } catch (err) {
    console.error('Failed to attach profile:', err);
  }
}

async function detachFromProfile(tab) {
  if (!tab.sessionId) return;
  try {
    const resp = await fetch(`/api/sessions/${tab.sessionId}/profile`, { method: 'DELETE' });
    const data = await resp.json();

    tab.formerProfileId = tab.profileId;
    tab.formerProfileName = tab.name;
    tab.formerProfileIcon = tab.icon;
    tab.formerProfileSeq = data.formerProfileSeq || 1;
    tab.profileId = null;
    tab.icon = null;
    state.activeProfileId = null;
    renderTabs();
  } catch (err) {
    console.error('Failed to detach from profile:', err);
  }
}

async function createProfileFromSession(tab) {
  const name = prompt('Profile name:');
  if (!name) return;
  const icon = prompt('Icon emoji:', '\uD83E\uDD16') || '\uD83E\uDD16';
  try {
    const resp = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, icon }),
    });
    const data = await resp.json();
    if (data.profile) await attachToProfile(tab, data.profile);
  } catch (err) {
    console.error('Failed to create profile:', err);
  }
}
