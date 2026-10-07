const modal = document.getElementById('system-status-modal');
const content = document.getElementById('system-status-content');
const openBtn = document.getElementById('system-status-btn');
const closeBtn = document.getElementById('system-status-close-btn');

let refreshInterval = null;

function timeAgo(dateStr) {
  const seconds = Math.floor((Date.now() - new Date(dateStr + 'Z').getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function activityAge(dateStr) {
  if (!dateStr) return 'no activity';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function renderProcesses(processes) {
  if (processes.length === 0) return '<div class="status-empty">No active processes</div>';
  return processes.map(p => {
    const dotClass = p.stale ? 'stale' : (p.alive ? 'alive' : 'dead');
    const staleBadge = p.stale ? '<span class="status-badge stale">STALE</span>' : '';
    const activity = p.lastActivityAt ? activityAge(p.lastActivityAt) : '';
    const activityHtml = activity ? `<span class="status-meta">${activity}${p.lastEventType ? ' · ' + p.lastEventType : ''}</span>` : '';

    // Agent linking
    const agentLabel = p.agentName
      ? `<strong>${p.agentName}</strong>`
      : `<strong>${p.profileName || p.sessionId.substring(0, 8)}</strong> <span class="status-badge error">UNLINKED</span>`;

    // Conversation linking
    const convLabel = p.conversationId
      ? `${p.conversationState || '?'}`
      : '<span class="status-badge error">NO CONV</span>';

    // Session match
    const matchLabel = p.sessionMatch === false
      ? '<span class="status-badge error">MISMATCH</span>'
      : '';

    return `
      <div class="status-row${p.stale ? ' stale-row' : ''}">
        <span class="status-dot ${dotClass}"></span>
        ${agentLabel}
        ${staleBadge}
        ${matchLabel}
        <span class="status-detail">${convLabel} · ${p.hasSocket ? 'UI' : 'no UI'} · pid ${p.pid}</span>
        ${activityHtml}
        ${p.pendingPermissions > 0 ? `<span class="status-badge warn">${p.pendingPermissions} pending</span>` : ''}
      </div>
    `;
  }).join('');
}

function renderIntegrity(integrity) {
  const items = [];

  if (integrity.orphanedConversations.length > 0) {
    items.push(`<h4 style="color:#ef4444">Orphaned Conversations (${integrity.orphanedConversations.length})</h4>`);
    for (const c of integrity.orphanedConversations) {
      items.push(`<div class="status-row"><span class="status-badge error">ORPHAN</span> <strong>${c.agent_name}</strong> <span class="status-detail">conv ${c.id.substring(0,8)} · state: ${c.state} · session: ${c.session_id.substring(0,8)}</span></div>`);
    }
  }

  if (integrity.agentsWithoutConversation.length > 0) {
    items.push(`<h4 style="color:#ef4444">Agents Without Conversation (${integrity.agentsWithoutConversation.length})</h4>`);
    for (const a of integrity.agentsWithoutConversation) {
      items.push(`<div class="status-row"><span class="status-badge error">NO CONV</span> <strong>${a.name}</strong> <span class="status-detail">agent ${a.id.substring(0,8)} · state: ${a.state}</span></div>`);
    }
  }

  return items.length > 0 ? items.join('') : '';
}

function renderTasks(tasks, label) {
  if (tasks.length === 0) return `<div class="status-empty">No ${label} tasks</div>`;
  return tasks.map(t => `
    <div class="status-row">
      <span class="status-badge ${t.state}">${t.state}</span>
      <strong>${t.assignee_name || t.assignee_agent_id?.substring(0, 8) || '?'}</strong>
      <span class="status-detail">${t.message.substring(0, 60)}${t.message.length > 60 ? '...' : ''}</span>
      <span class="status-meta">from ${t.creator_name || '?'} &middot; ${timeAgo(t.created_at)}</span>
    </div>
  `).join('');
}

async function refresh() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    const integrityHtml = data.integrity ? renderIntegrity(data.integrity) : '';

    content.innerHTML = `
      <div class="status-section">
        <h3>Active Processes (${data.processes.length})</h3>
        ${renderProcesses(data.processes)}
      </div>
      ${integrityHtml ? `<div class="status-section">${integrityHtml}</div>` : ''}
      <div class="status-section">
        <h3>Tasks In Flight (${data.tasks.inFlight.length})</h3>
        ${renderTasks(data.tasks.inFlight, 'in-flight')}
      </div>
      <div class="status-section">
        <h3>Recent Tasks</h3>
        ${renderTasks(data.tasks.recent, 'recent')}
      </div>
    `;
  } catch (err) {
    content.innerHTML = `<div class="status-empty">Failed to load status: ${err.message}</div>`;
  }
}

function open() {
  modal.classList.add('open');
  refresh();
  refreshInterval = setInterval(refresh, 3000);
}

function close() {
  modal.classList.remove('open');
  if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
}

openBtn.addEventListener('click', open);
closeBtn.addEventListener('click', close);
modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('open')) close(); });
