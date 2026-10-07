/**
 * Sessions view — renders the sessions list page and session picker modal.
 * Layer 5 (view): imports from layers 0-4 only. Never imports from other views.
 */

import state from './state.js';
import { escapeHtml, formatSessionDate } from './utils.js';
import { resumeSession, startNewSession } from './session-manager.js';
import { getActiveTab, renderTabs } from './tabs.js';

// --- Session API ---

async function fetchSessions() {
  const resp = await fetch('/api/sessions');
  const data = await resp.json();
  return data.sessions || [];
}

async function deleteSessionById(id) {
  if (!confirm('Delete this session?')) return false;
  const resp = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  if (resp.ok && state.sessionId === id) startNewSession();
  return resp.ok;
}

// --- Session card rendering (shared) ---

function sessionTitle(session) {
  if (session.profileName) {
    return `<span style="font-size: 0.9rem;">${session.profileIcon || ''}</span> ${escapeHtml(session.profileName)}`;
  }
  if (session.formerProfileName) {
    return `<span style="font-size: 0.9rem; opacity: 0.5; text-decoration: line-through;">${session.formerProfileIcon || ''} ${escapeHtml(session.formerProfileName)}</span>`;
  }
  if (session.name) return escapeHtml(session.name);
  return escapeHtml(session.firstMessage);
}

function sessionTypeBadge(session) {
  if (session.profileId) return '<span class="session-badge session-badge-profile">profile</span>';
  if (session.formerProfileId) return '<span class="session-badge session-badge-detached">detached</span>';
  return '<span class="session-badge session-badge-standalone">standalone</span>';
}

const ICON_DELETE = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>`;

function renderSessionCard(session, { onDelete, onClick }) {
  const el = document.createElement('div');
  el.className = 'session-item';
  if (state.sessionId === session.id) el.classList.add('active');

  const date = session.lastActivity
    ? formatSessionDate(new Date(session.lastActivity))
    : 'Unknown';

  const reply = session.firstReply
    ? `<div class="session-reply">${escapeHtml(session.firstReply)}</div>`
    : '';

  el.innerHTML = `
    <div class="session-header">
      <div class="session-user-msg">${sessionTitle(session)}</div>
      <button class="session-delete" title="Delete session">${ICON_DELETE}</button>
    </div>
    ${reply}
    <div class="session-meta">
      <span>${date}</span>
      ${sessionTypeBadge(session)}
      <span>${session.messageCount} messages</span>
      <span class="session-id">${session.id.substring(0, 8)}</span>
    </div>
  `;

  el.querySelector('.session-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    onDelete(session.id);
  });
  el.addEventListener('click', () => onClick(session.id));

  return el;
}

function renderSessionList(container, sessions, { onDelete, onClick }) {
  container.innerHTML = '';
  if (sessions.length === 0) {
    container.innerHTML = '<div class="no-sessions">No sessions found</div>';
    return;
  }
  for (const session of sessions) {
    container.appendChild(renderSessionCard(session, { onDelete, onClick }));
  }
}

// --- Session picker modal ---

export function openSessionPicker() {
  document.getElementById('session-modal').classList.add('open');
  import('./profiles.js').then(m => m.loadProfilesInModal());
  loadSessionsInModal();
}

export function closeSessionPicker() {
  document.getElementById('session-modal').classList.remove('open');
}

export function closeSessionPickerOnOverlay(event) {
  if (event.target === document.getElementById('session-modal')) {
    closeSessionPicker();
  }
}

async function loadSessionsInModal() {
  const listEl = document.getElementById('session-list');
  listEl.innerHTML = '<div class="sessions-loading">Loading sessions...</div>';

  try {
    const sessions = await fetchSessions();
    renderSessionList(listEl, sessions, {
      onDelete: async (id) => {
        if (await deleteSessionById(id)) loadSessionsInModal();
      },
      onClick: resumeSession,
    });
  } catch (error) {
    console.error('Failed to load sessions:', error);
    listEl.innerHTML = '<div class="no-sessions">Failed to load sessions</div>';
  }
}

// --- Sessions full-page view ---

export async function renderSessionsPage() {
  const container = document.getElementById('sessions-view');
  container.innerHTML = '<div class="sessions-page"><div class="sessions-loading">Loading sessions...</div></div>';

  try {
    const sessions = await fetchSessions();

    const page = document.createElement('div');
    page.className = 'sessions-page';

    const header = document.createElement('div');
    header.className = 'sessions-page-header';
    header.innerHTML = '<h2>Sessions</h2>';
    page.appendChild(header);

    // --- Search bar ---
    const searchBar = document.createElement('div');
    searchBar.className = 'session-search-bar';
    searchBar.innerHTML = `
      <input type="text" id="session-search-input" placeholder="Search sessions..." />
      <button id="session-search-clear" class="session-search-clear hidden">&times;</button>
    `;
    page.appendChild(searchBar);

    // --- Agent filter pills ---
    const agentNames = [...new Set(sessions.map(s => s.profileName).filter(Boolean))].sort();
    if (agentNames.length > 1) {
      const filterBar = document.createElement('div');
      filterBar.className = 'session-filter-pills';
      filterBar.innerHTML = `<button class="filter-pill active" data-agent="">All</button>` +
        agentNames.map(name => `<button class="filter-pill" data-agent="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join('');
      page.appendChild(filterBar);
    }

    const listEl = document.createElement('div');
    listEl.className = 'sessions-page-list';
    page.appendChild(listEl);

    container.innerHTML = '';
    container.appendChild(page);

    // --- Filter state ---
    let searchTerm = '';
    let activeAgent = '';
    let debounceTimer = null;

    const searchInput = page.querySelector('#session-search-input');
    const clearBtn = page.querySelector('#session-search-clear');

    function applyFilters() {
      const term = searchTerm.toLowerCase();
      const filtered = sessions.filter(s => {
        if (activeAgent && s.profileName !== activeAgent) return false;
        if (term) {
          const searchable = [s.profileName, s.name, s.firstMessage, s.firstReply]
            .filter(Boolean).join(' ').toLowerCase();
          if (!searchable.includes(term)) return false;
        }
        return true;
      });
      renderSessionList(listEl, filtered, {
        onDelete: async (id) => {
          if (await deleteSessionById(id)) renderSessionsPage();
        },
        onClick: resumeSession,
      });
    }

    // Initial render
    applyFilters();

    // Search input
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        searchTerm = searchInput.value.trim();
        clearBtn.classList.toggle('hidden', !searchTerm);
        applyFilters();
      }, 300);
    });

    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      searchTerm = '';
      clearBtn.classList.add('hidden');
      applyFilters();
      searchInput.focus();
    });

    // Agent filter pills
    const pillsContainer = page.querySelector('.session-filter-pills');
    if (pillsContainer) {
      pillsContainer.addEventListener('click', (e) => {
        const pill = e.target.closest('.filter-pill');
        if (!pill) return;
        pillsContainer.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        activeAgent = pill.dataset.agent || '';
        applyFilters();
      });
    }

  } catch (error) {
    console.error('Failed to load sessions:', error);
    container.innerHTML = '<div class="sessions-page"><div class="no-sessions">Failed to load sessions</div></div>';
  }
}

// Re-export session transitions from session-manager for backwards compatibility
export { startNewSession, resumeSession, renderHistoryEntries } from './session-manager.js';
