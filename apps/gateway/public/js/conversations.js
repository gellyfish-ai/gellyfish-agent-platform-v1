/**
 * Conversations view — lists all agent conversations with state indicators.
 * Layer 5 (view): imports from layers 0-4 only.
 */

import state from './state.js';
import { escapeHtml, formatSessionDate } from './utils.js';
import { startAgentSession } from './session-manager.js';

// --- Conversation API ---

async function fetchConversations() {
  const resp = await fetch('/api/conversations');
  const data = await resp.json();
  return data.conversations || [];
}

async function deleteConversation(id) {
  if (!confirm('Delete this conversation? The agent will start fresh next time.')) return false;
  const resp = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  return resp.ok;
}

// --- State indicator ---

function stateIndicator(convState) {
  const colors = { active: '#22c55e', dormant: '#eab308', cold: '#6b7280' };
  const labels = { active: 'Active', dormant: 'Dormant', cold: 'Cold' };
  const color = colors[convState] || colors.cold;
  const label = labels[convState] || 'Cold';
  return `<span class="conv-state-dot" style="background:${color}" title="${label}"></span>`;
}

// --- Conversation card ---

const ICON_DELETE = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>`;

function renderConversationCard(conv, { onDelete, onClick }) {
  const el = document.createElement('div');
  el.className = 'session-item';
  if (state.activeConversationId === conv.id) el.classList.add('active');

  const date = conv.updated_at
    ? formatSessionDate(new Date(conv.updated_at + 'Z'))
    : '';

  const issueTag = conv.issue_number
    ? `<span class="session-badge session-badge-profile">#${conv.issue_number}</span>`
    : '';

  const agentStateBadge = conv.agent_state === 'working'
    ? '<span class="session-badge session-badge-profile">working</span>'
    : '';

  el.innerHTML = `
    <div class="session-header">
      <div class="session-user-msg">
        ${stateIndicator(conv.state)}
        <span style="font-size: 0.9rem;">${conv.profile_icon || ''}</span>
        ${escapeHtml(conv.agent_name || conv.title || 'Unnamed')}
      </div>
      <button class="session-delete" title="Delete conversation">${ICON_DELETE}</button>
    </div>
    <div class="session-meta">
      <span>${conv.profile_name || ''}</span>
      ${issueTag}
      ${agentStateBadge}
      <span>${date}</span>
    </div>
  `;

  el.querySelector('.session-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    onDelete(conv);
  });

  el.addEventListener('click', () => onClick(conv));
  return el;
}

// --- Conversations page ---

export async function renderConversationsPage() {
  const container = document.getElementById('conversations-view');
  container.innerHTML = '<div class="sessions-page"><div class="sessions-loading">Loading conversations...</div></div>';

  try {
    const conversations = await fetchConversations();

    const page = document.createElement('div');
    page.className = 'sessions-page';

    const header = document.createElement('div');
    header.className = 'sessions-page-header';
    header.innerHTML = '<h2>Conversations</h2>';
    page.appendChild(header);

    const listEl = document.createElement('div');
    listEl.className = 'sessions-page-list';
    page.appendChild(listEl);

    if (conversations.length === 0) {
      listEl.innerHTML = '<div class="no-sessions">No conversations yet. Hire an agent from a profile to start.</div>';
    } else {
      for (const conv of conversations) {
        listEl.appendChild(renderConversationCard(conv, {
          onDelete: async (c) => {
            if (await deleteConversation(c.id)) renderConversationsPage();
          },
          onClick: (c) => {
            // Build an agent-like object for startAgentSession
            startAgentSession({
              id: c.agent_id,
              name: c.agent_name,
              profile_id: c.profile_id,
              profile_icon: c.profile_icon,
              session_id: c.session_id,
              conversation_id: c.id,
              conversation_state: c.state,
              issue_number: c.issue_number,
            });
          },
        }));
      }
    }

    container.innerHTML = '';
    container.appendChild(page);
  } catch (error) {
    console.error('Failed to load conversations:', error);
    container.innerHTML = '<div class="sessions-page"><div class="no-sessions">Failed to load conversations</div></div>';
  }
}
