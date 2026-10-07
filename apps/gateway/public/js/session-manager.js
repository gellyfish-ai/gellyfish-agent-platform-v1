/**
 * Session Manager — single entry point for all session transitions.
 *
 * Layer 3: imports from state (1), connection (2), utils (0).
 * Does NOT import from views (profiles, sessions, crews) or app.
 * Views call into this module, never the reverse.
 *
 * Tab and message DOM operations are delegated via callbacks set by app.js
 * at init time, avoiding upward imports.
 */

import state, { resetSessionState } from './state.js';
import { connect, disconnect } from './connection.js';
import { escapeHtml, pushUrl, urlFor, formatSessionDate } from './utils.js';

// --- Callbacks set by app.js to avoid circular imports ---

let _openSessionTab = null;
let _openProfileTab = null;
let _openAgentTab = null;
let _findTabBySessionId = null;
let _findTabByAgentId = null;
let _switchTab = null;
let _showChatView = null;
let _closeSessionPicker = null;
let _addMessage = null;
let _showToolUse = null;
let _showToolResult = null;
let _getOrCreateDetailRows = null;
let _retryFromStalePermission = null;
let _updateActiveTabProfile = null;
let _loadProfileForSession = null;
let _renderTabs = null;
let _getActiveTab = null;
let _replayTaskEvents = null;
let _handleServerMessage = null;
let _attachReactionTriggers = null;
let _loadReactions = null;

export function initSessionManager(deps) {
  _openSessionTab = deps.openSessionTab;
  _openProfileTab = deps.openProfileTab;
  _openAgentTab = deps.openAgentTab;
  _findTabBySessionId = deps.findTabBySessionId;
  _findTabByAgentId = deps.findTabByAgentId;
  _switchTab = deps.switchTab;
  _showChatView = deps.showChatView;
  _closeSessionPicker = deps.closeSessionPicker;
  _addMessage = deps.addMessage;
  _showToolUse = deps.showToolUse;
  _showToolResult = deps.showToolResult;
  _getOrCreateDetailRows = deps.getOrCreateDetailRows;
  _retryFromStalePermission = deps.retryFromStalePermission;
  _updateActiveTabProfile = deps.updateActiveTabProfile;
  _loadProfileForSession = deps.loadProfileForSession;
  _renderTabs = deps.renderTabs;
  _getActiveTab = deps.getActiveTab;
  _replayTaskEvents = deps.replayTaskEvents;
  _handleServerMessage = deps.handleServerMessage;
  _attachReactionTriggers = deps.attachReactionTriggers;
  _loadReactions = deps.loadReactions;
}

const messagesEl = document.getElementById('messages');
const HISTORY_INITIAL_PAGE_SIZE = 50;
const HISTORY_OLDER_PAGE_SIZE = 200;

// --- Tab enrichment ---

async function enrichActiveTabFromApi(sessionId) {
  try {
    const resp = await fetch('/api/sessions');
    const sessions = (await resp.json()).sessions || [];
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    const tab = _getActiveTab();
    if (!tab || tab.sessionId !== sessionId) return;

    if (session.name) tab.name = session.name;
    if (session.formerProfileId) {
      tab.formerProfileId = session.formerProfileId;
      tab.formerProfileName = session.formerProfileName || null;
      tab.formerProfileIcon = session.formerProfileIcon || null;
      tab.formerProfileSeq = session.formerProfileSeq || 0;
    }

    _renderTabs();
  } catch {
    // Non-critical
  }
}

// --- History rendering ---

export function renderHistoryEntries(entries) {
  // Build set of tool_uses that have a matching result in this page
  const resolvedToolUseIds = new Set();
  for (const entry of entries) {
    if (entry.type === 'tool_result' && entry.toolUseId) {
      resolvedToolUseIds.add(entry.toolUseId);
    }
  }

  // Collect task_response texts so we can suppress matching assistant messages
  const taskResponseTexts = new Set();
  for (const entry of entries) {
    if (entry.type === 'task_response' && entry.data?.text) {
      taskResponseTexts.add(entry.data.text.trim());
    }
  }

  let lastWasTaskInjection = false;
  for (const entry of entries) {
    if (entry.type === 'message') {
      // Suppress task injection messages — the timeline card handles these
      if (entry.role === 'user') {
        const text = typeof entry.content === 'string' ? entry.content : '';
        // Strip optional "Human: " prefix (Claude CLI sometimes double-wraps)
        const stripped = text.replace(/^Human:\s*/i, '');
        if (/^\[Task [a-f0-9-]+\]/.test(stripped) || /^Task (completed|failed) by /.test(stripped) || /^Task (progress|update) — /.test(stripped)) {
          lastWasTaskInjection = true;
          continue;
        }
        lastWasTaskInjection = false;
      }
      // Suppress assistant messages that are task responses — shown in timeline card
      if (entry.role === 'assistant') {
        const text = typeof entry.content === 'string' ? entry.content.trim() : '';
        if (text && taskResponseTexts.has(text)) {
          taskResponseTexts.delete(text);
          lastWasTaskInjection = false;
          continue;
        }
        // Also suppress coordinator's response to a task injection
        if (lastWasTaskInjection) {
          lastWasTaskInjection = false;
          continue;
        }
      }
      // Suppress API error messages — ephemeral, handled by toast live
      if (entry.role === 'assistant' && entry.isApiErrorMessage) {
        continue;
      }
      _addMessage(entry.content, entry.role, false, entry.id, entry.timestamp);
      state.messageCount++;
      if (entry.role === 'user') {
        state.userMessageCount++;
      } else if (entry.role === 'assistant') {
        state.assistantMessageCount++;
      }
    } else if (entry.type === 'tool_use') {
      _showToolUse({
        toolUseId: entry.toolUseId,
        toolName: entry.toolName,
        input: entry.input,
      });
      state.toolCount++;

      // If no result in this history page, show a neutral status.
      // Actual pending permissions are re-sent by the backend on reconnect
      // via the managed.pendingPermissions map — no need to guess here.
      if (!resolvedToolUseIds.has(entry.toolUseId)) {
        const toolDiv = document.querySelector(`[data-tool-use-id="${entry.toolUseId}"]`);
        if (toolDiv) {
          const detailRows = _getOrCreateDetailRows(toolDiv);
          const row = document.createElement('div');
          row.className = 'tool-detail-row';
          row.innerHTML = `<span class="tool-detail-label">\u2192:</span> <span class="tool-detail-value" style="color: var(--text-muted);">no result in history</span>`;
          detailRows.appendChild(row);
        }
      }
    } else if (entry.type === 'tool_result') {
      _showToolResult({
        toolUseId: entry.toolUseId,
        content: entry.content,
        isError: entry.isError,
        images: entry.images,
      });
    } else if (entry.type === 'task_update' && entry.data) {
      // Render task bubble inline in the timeline
      if (_handleServerMessage) _handleServerMessage(entry.data);
    } else if (entry.type === 'task_progress' && entry.data) {
      // Render task progress inline
      if (_handleServerMessage) _handleServerMessage(entry.data);
    } else if (entry.type === 'task_progress_injection' && entry.data) {
      // Render in timeline card
      if (_handleServerMessage) _handleServerMessage(entry.data);
    } else if (entry.type === 'task_response' && entry.data) {
      // Render coordinator response in timeline card
      if (_handleServerMessage) _handleServerMessage(entry.data);
    } else if (entry.type === 'compaction_summary' && entry.summary) {
      // Render compaction indicator from replayed JSONL history
      if (_handleServerMessage) _handleServerMessage({ type: 'compaction_summary', summary: entry.summary });
    }
  }
}

/**
 * Load paginated session history into the messages container.
 * Shows a "Load more" button if there are older entries beyond the page.
 * Returns the fetched entries (empty array on failure).
 */
export function loadHistoryAndConnect(sessionId) {
  loadSessionHistory(sessionId)
    .then(() => hydratePendingApprovals(sessionId))
    .then(() => connect(sessionId))
    .catch(() => connect(sessionId));
}

/** Fetch pending approvals from DB and render them as cards at the bottom of chat. */
async function hydratePendingApprovals(sessionId) {
  try {
    const resp = await fetch(`/api/approvals/pending/${encodeURIComponent(sessionId)}`);
    const data = await resp.json();
    const approvals = data.approvals || [];
    for (const a of approvals) {
      if (_handleServerMessage) {
        _handleServerMessage({
          type: 'approval_request',
          id: a.id,
          humanPreview: a.human_preview,
          expiresAt: a.expires_at,
          requestId: a.request_id,
          mcpName: a.mcp_name,
          toolName: a.tool_name,
          agentName: a.agent_display_name,
          profileName: a.profile_display_name,
        });
      }
    }
  } catch {
    // Non-critical — live WebSocket will replay them anyway
  }
}

async function loadSessionHistory(sessionId) {
  // Use unified timeline: history + task events merged by timestamp
  const response = await fetch(`/api/sessions/${sessionId}/timeline?limit=${HISTORY_INITIAL_PAGE_SIZE}`);
  const data = await response.json();
  const entries = data.entries || [];
  if (entries.length === 0) return entries;

  messagesEl.innerHTML = '';

  if (data.hasMore) {
    messagesEl.appendChild(buildLoadOlderButton(sessionId, entries.length, data.total));
  }

  // Single render pass: messages, tools, AND task bubbles in chronological order
  renderHistoryEntries(entries);

  // Attach reaction triggers and load saved reactions
  if (_attachReactionTriggers) _attachReactionTriggers();
  if (_loadReactions) _loadReactions(sessionId);

  const sep = document.createElement('div');
  sep.className = 'empty-state';
  sep.style.padding = '0.5rem';
  sep.innerHTML = '<p style="font-size: 0.75rem; color: var(--text-muted);">\u2014 Session resumed \u2014</p>';
  messagesEl.appendChild(sep);

  return entries;
}

function buildLoadOlderButton(sessionId, loadedCount, total) {
  const btn = document.createElement('button');
  btn.className = 'load-more-btn';
  btn.textContent = `Load earlier messages (${total - loadedCount} more)`;
  btn.addEventListener('click', () => loadOlderEntries(sessionId, loadedCount, btn));
  return btn;
}

/**
 * Fetch the next page of older timeline entries and prepend them above the
 * existing rendered entries. The timeline endpoint returns the *last* N
 * entries, so we ask for `currentlyLoaded + PAGE_SIZE` and slice off the
 * leading `PAGE_SIZE` (the newly-revealed older block) to render. Re-draws
 * the button with an updated remaining count when more entries remain;
 * removes it when `hasMore=false`.
 */
async function loadOlderEntries(sessionId, alreadyLoadedCount, btn) {
  btn.textContent = 'Loading...';
  btn.disabled = true;
  const newLimit = alreadyLoadedCount + HISTORY_OLDER_PAGE_SIZE;

  let data;
  try {
    const resp = await fetch(`/api/sessions/${sessionId}/timeline?limit=${newLimit}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (e) {
    console.error('Failed to load earlier messages:', e);
    btn.textContent = 'Failed to load \u2014 click to retry';
    btn.disabled = false;
    return;
  }

  const entries = data.entries || [];
  const olderCount = entries.length - alreadyLoadedCount;
  btn.remove();

  if (olderCount > 0) {
    const olderEntries = entries.slice(0, olderCount);
    // Detach existing rendered children, render the older block at the top,
    // then re-append the originals so chronological order is preserved.
    const existingChildren = Array.from(messagesEl.childNodes);
    existingChildren.forEach(c => c.remove());
    renderHistoryEntries(olderEntries);
    existingChildren.forEach(c => messagesEl.appendChild(c));
  }

  if (data.hasMore) {
    messagesEl.prepend(buildLoadOlderButton(sessionId, entries.length, data.total));
  }
}

// --- Session transitions ---

/** Start a brand new session with no profile */
export function startNewSession() {
  _closeSessionPicker();
  _openSessionTab(null, 'New Chat');
  _showChatView();
  pushUrl('/');

  disconnect();
  resetSessionState();

  messagesEl.innerHTML = `
    <div class="empty-state">
      <h2>Welcome to Gellyfish</h2>
      <p>Your personal AI assistant with full tool access.<br>Type a message to get started.</p>
    </div>
  `;

  connect();
}

/** Resume an existing session by ID */
export async function resumeSession(id) {
  _closeSessionPicker();
  _showChatView();

  // Check if we already have a tab for this session
  const existingTab = _findTabBySessionId(id);
  if (existingTab) {
    _switchTab(existingTab.id);
    return;
  }

  // Look up which agent owns this session
  let agent = null;
  try {
    const resp = await fetch(`/api/sessions/${id}`);
    if (resp.ok) {
      const data = await resp.json();
      agent = data.agent || null;
    }
  } catch { /* will show error below */ }

  if (agent) {
    // Check if agent tab already exists (maybe onActiveAgents beat us)
    const agentTab = _findTabByAgentId(agent.id);
    if (agentTab) {
      _switchTab(agentTab.id);
      return;
    }
    // Create a proper agent tab
    _openAgentTab({
      id: agent.id,
      name: agent.name,
      profile_id: agent.profile_id,
      profile_icon: agent.profile_icon,
      session_id: id,
      conversation_id: agent.conversation_id || null,
      conversation_state: agent.conversation_state || null,
      issue_number: agent.issue_number || null,
    });
  } else {
    // No agent found — create a session tab but show the error
    _openSessionTab(id, 'Session ' + id.substring(0, 8));
    console.error(`[resumeSession] No agent found for session ${id}`);
  }

  pushUrl(urlFor('chat', { sessionId: id }));

  disconnect();
  resetSessionState({
    sessionId: id,
    activeAgentId: agent?.id || null,
    activeProfileId: agent?.profile_id || null,
    activeConversationId: agent?.conversation_id || null,
  });

  messagesEl.innerHTML = `
    <div class="empty-state">
      <h2>${agent ? (agent.profile_icon || '') + ' ' + escapeHtml(agent.name) : 'Loading Session...'}</h2>
      <p>${agent ? 'Resuming conversation...' : `Session ${id.substring(0, 8)}... — no agent found`}</p>
    </div>
  `;

  try {
    const entries = await loadSessionHistory(id);
    if (entries.length === 0 && !agent) {
      messagesEl.innerHTML = `
        <div class="empty-state">
          <h2>Session Error</h2>
          <p>Session <code>${id.substring(0, 8)}</code> does not belong to any agent.<br>
          It may have been deleted or the session ID is wrong.</p>
        </div>
      `;
    }
  } catch (error) {
    console.error('Failed to load session history:', error);
    messagesEl.innerHTML = `
      <div class="empty-state">
        <h2>Session Error</h2>
        <p>Could not load messages for session <code>${id.substring(0, 8)}</code>: ${escapeHtml(String(error))}</p>
      </div>
    `;
  }

  connect(id);
}

/** Start or resume a profile's session */
export function startProfileSession(profile) {
  _closeSessionPicker();

  const tab = _openProfileTab(profile);

  // Tab was already open with messages — just switch
  if (tab.messagesHtml != null) {
    _showChatView();
    return;
  }

  disconnect();

  const resumeId = profile.session_id || null;

  resetSessionState({
    sessionId: resumeId,
    resumeSessionId: resumeId,
    activeProfileId: profile.id,
  });

  pushUrl(urlFor('chat', { sessionId: resumeId }));

  if (resumeId) {
    messagesEl.innerHTML = `
      <div class="empty-state">
        <h2>${profile.icon} ${escapeHtml(profile.name)}</h2>
        <p>Resuming session...</p>
      </div>
    `;

    loadHistoryAndConnect(resumeId);
  } else {
    messagesEl.innerHTML = `
      <div class="empty-state">
        <h2>${profile.icon} ${escapeHtml(profile.name)}</h2>
        <p>Starting new session...</p>
      </div>
    `;
    connect();
  }

  _showChatView();
}

/**
 * Start or resume an agent's conversation.
 * agent object should have: id, name, profile_id, profile_icon, session_id, conversation_id, conversation_state, issue_number
 */
export async function startAgentSession(agent) {
  _closeSessionPicker();

  // Check if this agent already has a tab open
  const existingTab = _findTabByAgentId(agent.id);
  if (existingTab) {
    _switchTab(existingTab.id);
    if (existingTab.sessionId) return; // has a session, nothing to do
    // No session — fall through to recovery
  }

  _openAgentTab(agent);
  _showChatView();

  disconnect();
  resetSessionState({
    sessionId: agent.session_id || null,
    resumeSessionId: agent.session_id || null,
    activeProfileId: agent.profile_id,
    activeAgentId: agent.id,
    activeConversationId: agent.conversation_id || null,
  });

  const resumeId = agent.session_id || null;
  pushUrl(urlFor('chat', { sessionId: resumeId }));

  if (resumeId) {
    messagesEl.innerHTML = `
      <div class="empty-state">
        <h2>${agent.profile_icon || ''} ${escapeHtml(agent.name)}</h2>
        <p>Resuming conversation...</p>
      </div>
    `;

    loadHistoryAndConnect(resumeId);
  } else {
    // No session — try recovery UI if conversation exists
    if (agent.conversation_id) {
      messagesEl.innerHTML = `
        <div class="empty-state">
          <h2>${agent.profile_icon || ''} ${escapeHtml(agent.name)}</h2>
          <p>Checking for recoverable sessions...</p>
        </div>
      `;
      const recovered = await showRecoveryUI(agent.conversation_id, agent.name, agent.profile_icon);
      if (!recovered) {
        // No sessions found or recovery UI shown — also load summaries
        loadConversationSummaries(agent.conversation_id);
      }
    } else {
      messagesEl.innerHTML = `
        <div class="empty-state">
          <h2>${agent.profile_icon || ''} ${escapeHtml(agent.name)}</h2>
          <p>Starting new conversation...</p>
        </div>
      `;
      connect();
    }
  }
}

/**
 * Show recovery UI when a conversation has no session_id.
 * Lists available session files and provides Load/Compact/Delete actions.
 * Auto-recovers if exactly 1 session file exists.
 */
async function showRecoveryUI(conversationId, agentName, agentIcon) {
  if (!conversationId) return false;

  let data;
  try {
    const resp = await fetch(`/api/conversations/${conversationId}/session-files`);
    data = await resp.json();
  } catch {
    return false;
  }

  const sessions = data.sessions || [];

  // Auto-recover: exactly 1 session → load it automatically
  if (sessions.length === 1) {
    const s = sessions[0];
    try {
      const resp = await fetch(`/api/conversations/${conversationId}/recover-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: s.sessionId }),
      });
      if (resp.ok) {
        const tab = _getActiveTab();
        if (tab) tab.sessionId = s.sessionId;
        resetSessionState({ sessionId: s.sessionId, activeConversationId: conversationId });
        pushUrl(urlFor('chat', { sessionId: s.sessionId }));
        loadHistoryAndConnect(s.sessionId);
        return true;
      }
    } catch { /* fall through to show UI */ }
  }

  // Show recovery panel
  const label = agentIcon ? `${agentIcon} ${escapeHtml(agentName || '')}` : escapeHtml(agentName || 'Session');

  let html = `<div class="recovery-panel" style="padding:1rem;max-width:700px;margin:0 auto">
    <h2 style="margin:0 0 0.25rem">${label}</h2>
    <p style="color:var(--text-muted);margin:0 0 1rem;font-size:0.85rem">
      This conversation has no active session. ${sessions.length > 0 ? 'Select a session to recover, or start fresh.' : 'No session files found — start a new session.'}
    </p>
    <button id="recovery-new-session" style="margin-bottom:1rem;padding:6px 16px;cursor:pointer;font-size:0.85rem">Start New Session</button>`;

  if (sessions.length > 0) {
    html += `<div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.5rem">${sessions.length} session file${sessions.length > 1 ? 's' : ''} found:</div>`;
    for (const s of sessions) {
      const ts = formatRecoveryTimestamp(s.modifiedAt);
      const pathDisplay = s.path ? `<div style="font-size:0.65rem;color:var(--text-muted);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:500px" title="${escapeHtml(s.path)}">${escapeHtml(s.path)}</div>` : '';
      html += `<div class="recovery-session-entry" style="border:1px solid var(--border-color,#333);border-radius:6px;padding:8px 10px;margin-bottom:8px;background:var(--bg-secondary,#1a1a1a)">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px">
          <span style="font-family:monospace;font-size:0.8rem">${s.sessionId.substring(0, 8)}...</span>
          <span style="font-size:0.75rem;color:var(--text-muted)">${s.sizeMB}MB · ${ts}</span>
        </div>
        ${pathDisplay}
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
          <button class="recovery-load-btn" data-session-id="${s.sessionId}" style="padding:3px 10px;cursor:pointer;font-size:0.75rem;background:#30d158;color:#000;border:none;border-radius:3px">Load</button>
          <button class="recovery-compact-btn" data-session-id="${s.sessionId}" style="padding:3px 10px;cursor:pointer;font-size:0.75rem;border-radius:3px">Compact</button>
          <button class="recovery-delete-btn" data-session-id="${s.sessionId}" style="padding:3px 10px;cursor:pointer;font-size:0.75rem;color:#ef4444;border-radius:3px">Delete</button>
          <button class="recovery-preview-btn" data-session-id="${s.sessionId}" style="padding:3px 10px;cursor:pointer;font-size:0.75rem;border-radius:3px">Preview</button>
        </div>
        <div class="recovery-preview-container" data-session-id="${s.sessionId}" style="display:none"></div>
      </div>`;
    }
  }

  html += '</div>';
  messagesEl.innerHTML = html;

  // Wire "Start New Session" button
  const newBtn = messagesEl.querySelector('#recovery-new-session');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      messagesEl.innerHTML = `<div class="empty-state"><h2>${label}</h2><p>Starting new session...</p></div>`;
      connect();
    });
  }

  // Wire Load buttons
  for (const btn of messagesEl.querySelectorAll('.recovery-load-btn')) {
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.sessionId;
      btn.textContent = 'Loading...';
      btn.disabled = true;
      try {
        const resp = await fetch(`/api/conversations/${conversationId}/recover-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid }),
        });
        if (resp.ok) {
          const tab = _getActiveTab();
          if (tab) tab.sessionId = sid;
          resetSessionState({ sessionId: sid, activeConversationId: conversationId });
          pushUrl(urlFor('chat', { sessionId: sid }));
          loadHistoryAndConnect(sid);
        } else {
          btn.textContent = 'Failed';
        }
      } catch {
        btn.textContent = 'Failed';
      }
    });
  }

  // Wire Compact buttons
  for (const btn of messagesEl.querySelectorAll('.recovery-compact-btn')) {
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.sessionId;
      if (!confirm(`Compact session ${sid.substring(0, 8)}...? This will summarize and delete the session file.`)) return;
      btn.textContent = 'Compacting...';
      btn.disabled = true;
      try {
        await fetch(`/api/conversations/${conversationId}/compact-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid }),
        });
        // Refresh the recovery UI
        showRecoveryUI(conversationId, agentName, agentIcon);
      } catch {
        btn.textContent = 'Failed';
      }
    });
  }

  // Wire Delete buttons
  for (const btn of messagesEl.querySelectorAll('.recovery-delete-btn')) {
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.sessionId;
      if (!confirm(`Delete session ${sid.substring(0, 8)}...? This cannot be undone.`)) return;
      btn.textContent = 'Deleting...';
      btn.disabled = true;
      try {
        await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
        showRecoveryUI(conversationId, agentName, agentIcon);
      } catch {
        btn.textContent = 'Failed';
      }
    });
  }

  // Wire Preview buttons
  for (const btn of messagesEl.querySelectorAll('.recovery-preview-btn')) {
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.sessionId;
      const container = messagesEl.querySelector(`.recovery-preview-container[data-session-id="${sid}"]`);
      if (!container) return;
      if (container.style.display !== 'none') {
        container.style.display = 'none';
        return;
      }
      container.style.display = 'block';
      container.innerHTML = '<span style="color:var(--text-muted);font-size:0.7rem">Loading preview...</span>';
      try {
        const resp = await fetch(`/api/sessions/${sid}/preview`);
        const result = await resp.json();
        if (!result.messages || result.messages.length === 0) {
          container.innerHTML = '<span style="color:var(--text-muted);font-size:0.7rem">No messages</span>';
          return;
        }
        let previewHtml = '';
        for (const m of result.messages) {
          const roleColor = m.role === 'user' ? '#60a5fa' : '#34d399';
          const escaped = m.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          previewHtml += `<div style="margin:2px 0;font-size:0.7rem"><span style="color:${roleColor};font-weight:600">${m.role}:</span> ${escaped}</div>`;
        }
        container.innerHTML = `<div style="max-height:200px;overflow-y:auto;padding:4px 6px;margin-top:4px;background:var(--bg-primary,#111);border-radius:4px;border:1px solid var(--border-color,#333)">${previewHtml}</div>`;
      } catch {
        container.innerHTML = '<span style="color:#ef4444;font-size:0.7rem">Failed to load preview</span>';
      }
    });
  }

  return true;
}

function formatRecoveryTimestamp(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function loadConversationSummaries(conversationId) {
  try {
    const resp = await fetch(`/api/conversations/${conversationId}/summaries`);
    const data = await resp.json();
    const summaries = data.summaries || [];
    if (summaries.length === 0) return;

    const container = document.createElement('div');
    container.className = 'conversation-summaries';
    container.innerHTML = '<div class="summaries-header">Previous sessions</div>';

    for (const s of summaries) {
      const startDate = s.started_at ? formatSessionDate(new Date(s.started_at)) : '';
      const endDate = s.ended_at ? formatSessionDate(new Date(s.ended_at)) : '';
      const timeRange = startDate && endDate && startDate !== endDate
        ? `${startDate} – ${endDate}`
        : startDate || endDate || '';

      const el = document.createElement('div');
      el.className = 'summary-entry';
      el.innerHTML = `
        <div class="summary-meta">
          <span>${timeRange}</span>
          <span>${s.message_count} messages</span>
        </div>
        <div class="summary-text">${escapeHtml(s.summary)}</div>
      `;
      container.appendChild(el);
    }

    // Insert before the empty state or at the top of messages
    const emptyState = messagesEl.querySelector('.empty-state');
    if (emptyState) {
      messagesEl.insertBefore(container, emptyState);
    } else {
      messagesEl.prepend(container);
    }
  } catch (err) {
    console.error('Failed to load conversation summaries:', err);
  }
}
