import { escapeHtml, fetchProfiles } from './utils.js';
import { startAgentSession } from './session-manager.js';

let _navigateTo = null;
export function initCrews({ navigateTo }) {
  _navigateTo = navigateTo;
}

function openAgentChat(agent) {
  startAgentSession({
    id: agent.id,
    name: agent.name,
    profile_id: agent.profile_id,
    profile_icon: agent.profile_icon,
    session_id: agent.session_id || null,
    conversation_id: agent.conversation_id || null,
    conversation_state: agent.conversation_state || 'cold',
    issue_number: agent.issue_number || null,
  });
}

async function chatWithAgent(agentId) {
  const resp = await fetch(`/api/agents/${agentId}`);
  if (!resp.ok) {
    alert('Lead agent not found');
    return;
  }
  const data = await resp.json();
  openAgentChat(data.agent || data);
}

// --- SVG icons (action buttons) ---

const ICON_EDIT = (size = 16) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>`;

const ICON_DELETE = (size = 16) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>`;

const ICON_REMOVE = (size = 14) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>`;

const ICON_CHAT = (size = 14) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>`;

// --- Lucide icon rendering (programmatic, no DOM attachment needed) ---

// Convert PascalCase to kebab-case: "ArrowRight" -> "arrow-right", "XCircle" -> "x-circle"
function pascalToKebab(str) {
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

// Convert kebab-case to PascalCase: "arrow-right" -> "ArrowRight"
function kebabToPascal(str) {
  return str.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

// Build SVG string directly from lucide.icons data (array of [tag, attrs] tuples)
function renderLucideIcon(name, size = 24) {
  if (typeof lucide === 'undefined' || !lucide.icons) return '';
  const pascal = kebabToPascal(name);
  const paths = lucide.icons[pascal];
  if (!paths) return '';

  let inner = '';
  for (const [tag, attrs] of paths) {
    const attrStr = Object.entries(attrs || {}).map(([k, v]) => `${k}="${v}"`).join(' ');
    inner += `<${tag} ${attrStr}/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

function crewIconHtml(iconName, size = 24) {
  return `<span class="crew-lucide-icon" style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px">${renderLucideIcon(iconName, size)}</span>`;
}

// Get all available icon names as kebab-case, sorted
let _allIconNames = null;
function getAllIconNames() {
  if (_allIconNames) return _allIconNames;
  if (typeof lucide === 'undefined' || !lucide.icons) return [];
  _allIconNames = Object.keys(lucide.icons).map(pascalToKebab).sort();
  return _allIconNames;
}

// --- Icon picker ---

function createIconPicker(currentIcon, onSelect) {
  const picker = document.createElement('div');
  picker.className = 'icon-picker';

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'icon-picker-search';
  search.placeholder = 'Search icons... (e.g. phone, home, zap)';
  picker.appendChild(search);

  const grid = document.createElement('div');
  grid.className = 'icon-picker-grid';
  picker.appendChild(grid);

  let debounceTimer = null;

  function renderGrid(filter = '') {
    const allNames = getAllIconNames();
    const filtered = filter
      ? allNames.filter(name => name.includes(filter.toLowerCase()))
      : allNames;

    grid.innerHTML = '';

    if (filtered.length === 0) {
      grid.innerHTML = '<div class="icon-picker-empty">No icons found</div>';
      return;
    }

    // Render in batches for smooth scrolling with large result sets
    const fragment = document.createDocumentFragment();
    for (const name of filtered) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon-picker-item' + (name === currentIcon ? ' selected' : '');
      btn.title = name;
      btn.innerHTML = renderLucideIcon(name, 26);
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.icon-picker-item.selected').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        onSelect(name);
      });
      fragment.appendChild(btn);
    }
    grid.appendChild(fragment);
  }

  search.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderGrid(search.value.trim()), 150);
  });

  renderGrid();

  // Auto-scroll to selected icon
  requestAnimationFrame(() => {
    const sel = grid.querySelector('.icon-picker-item.selected');
    if (sel) sel.scrollIntoView({ block: 'center' });
  });

  return picker;
}

// --- API helpers ---

async function fetchCrews() {
  const resp = await fetch('/api/crews');
  const data = await resp.json();
  return data.crews || [];
}

async function fetchCrew(id) {
  const resp = await fetch(`/api/crews/${id}`);
  if (!resp.ok) return null;
  return resp.json();
}

async function saveCrew(id, { name, icon, lead_agent_id }) {
  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/crews/${id}` : '/api/crews';
  const resp = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, icon, lead_agent_id }),
  });
  return resp.json();
}

async function deleteCrewById(id) {
  if (!confirm('Delete this crew?')) return false;
  await fetch(`/api/crews/${id}`, { method: 'DELETE' });
  return true;
}

async function addCrewMember(crewId, profileId) {
  const resp = await fetch(`/api/crews/${crewId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile_id: profileId }),
  });
  return resp.json();
}

async function removeCrewMember(crewId, profileId) {
  await fetch(`/api/crews/${crewId}/members/${profileId}`, { method: 'DELETE' });
}

async function fetchAgentsForCrew(crewId) {
  const resp = await fetch(`/api/agents?crewId=${crewId}`);
  const data = await resp.json();
  return data.agents || [];
}

async function fetchIdleAgents() {
  const resp = await fetch('/api/agents?state=idle');
  const data = await resp.json();
  return data.agents || [];
}

// --- Crew card ---

function renderCrewCard(crew, { onEdit, onDelete, onClick, onChatLead }) {
  const el = document.createElement('div');
  el.className = 'crew-card';

  const leadText = crew.lead_name ? `${crew.lead_icon} ${escapeHtml(crew.lead_name)}` : 'No lead';
  const memberText = `${crew.member_count} member${crew.member_count !== 1 ? 's' : ''}`;
  const chatBtn = crew.lead_agent_id
    ? `<button class="profile-action-btn chat-lead-btn" title="Chat with ${escapeHtml(crew.lead_name)}">${ICON_CHAT(16)}</button>`
    : '';

  el.innerHTML = `
    <span class="crew-card-icon">${crewIconHtml(crew.icon, 32)}</span>
    <div class="crew-card-info">
      <div class="crew-card-name">${escapeHtml(crew.name)}</div>
      <div class="crew-card-meta">
        <span>${leadText}</span>
        <span>${memberText}</span>
      </div>
    </div>
    <div class="crew-card-actions">
      ${chatBtn}
      <button class="profile-action-btn edit-btn" title="Edit">${ICON_EDIT()}</button>
      <button class="profile-action-btn delete" title="Delete">${ICON_DELETE()}</button>
    </div>
  `;

  const chatLeadBtn = el.querySelector('.chat-lead-btn');
  if (chatLeadBtn) {
    chatLeadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onChatLead(crew.lead_agent_id);
    });
  }
  el.querySelector('.edit-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    onEdit(crew.id);
  });
  el.querySelector('.delete').addEventListener('click', (e) => {
    e.stopPropagation();
    onDelete(crew.id);
  });
  el.addEventListener('click', () => onClick(crew.id));

  return el;
}

// --- Crew form ---

async function showCrewForm(container, { crew, onSaved }) {
  const existing = container.querySelector('.crew-form');
  if (existing) { existing.remove(); return; }

  const isEdit = !!crew;
  const agentsResp = await fetch('/api/agents');
  const agentsData = await agentsResp.json();
  const allAgents = (agentsData.agents || []).filter(a => a.state !== 'stopped');

  let selectedIcon = isEdit ? crew.icon : 'users';

  const form = document.createElement('div');
  form.className = 'crew-form';

  let leadOptions = '<option value="">\u2014 No lead \u2014</option>';
  for (const a of allAgents) {
    const selected = isEdit && crew.lead_agent_id === a.id ? ' selected' : '';
    leadOptions += `<option value="${a.id}"${selected}>${a.profile_icon || ''} ${escapeHtml(a.name)}</option>`;
  }

  form.innerHTML = `
    <div class="form-row" style="align-items:center">
      <button type="button" class="icon-picker-trigger" title="Choose icon">${crewIconHtml(selectedIcon, 28)}</button>
      <input type="text" class="cf-name-input" placeholder="Crew name" value="${isEdit ? escapeHtml(crew.name) : ''}" />
    </div>
    <div class="icon-picker-container"></div>
    <label>Lead Agent</label>
    <select class="cf-lead-select">${leadOptions}</select>
    <div class="form-actions">
      <button class="cancel">Cancel</button>
      <button class="save">${isEdit ? 'Save' : 'Create'}</button>
    </div>
  `;

  const triggerBtn = form.querySelector('.icon-picker-trigger');
  const pickerContainer = form.querySelector('.icon-picker-container');

  triggerBtn.addEventListener('click', () => {
    if (pickerContainer.children.length > 0) {
      pickerContainer.innerHTML = '';
      return;
    }
    const picker = createIconPicker(selectedIcon, (name) => {
      selectedIcon = name;
      triggerBtn.innerHTML = crewIconHtml(name, 28);
    });
    pickerContainer.appendChild(picker);
  });

  form.querySelector('.cancel').addEventListener('click', () => form.remove());
  form.querySelector('.save').addEventListener('click', async () => {
    const name = form.querySelector('.cf-name-input').value.trim();
    const icon = selectedIcon;
    const lead_agent_id = form.querySelector('.cf-lead-select').value || null;
    if (!name) return;

    try {
      await saveCrew(isEdit ? crew.id : null, { name, icon, lead_agent_id });
      if (onSaved) onSaved();
    } catch (error) {
      console.error('Failed to save crew:', error);
    }
  });

  container.prepend(form);
  form.querySelector('.cf-name-input').focus();
}

// --- Crew detail view ---

export async function renderCrewDetail(crewId) {

  const container = document.getElementById('crews-view');
  container.innerHTML = '<div class="crew-detail"><div class="sessions-loading">Loading crew...</div></div>';

  const data = await fetchCrew(crewId);
  if (!data) {
    container.innerHTML = '<div class="crew-detail"><div class="crews-empty"><h3>Crew not found</h3></div></div>';
    return;
  }

  const { crew, members } = data;
  const agents = await fetchAgentsForCrew(crewId);
  const profiles = await fetchProfiles();
  const profileMap = new Map(profiles.map(p => [p.id, p]));
  const agentIds = new Set(agents.map(a => a.id));

  const detail = document.createElement('div');
  detail.className = 'crew-detail';

  // Back button
  const backBtn = document.createElement('button');
  backBtn.className = 'crew-detail-back';
  backBtn.innerHTML = '&larr; Back to Crews';
  backBtn.addEventListener('click', () => {
    if (_navigateTo) _navigateTo('crews');
  });
  detail.appendChild(backBtn);

  // Header
  const header = document.createElement('div');
  header.className = 'crew-detail-header';
  header.innerHTML = `
    <span class="crew-detail-icon">${crewIconHtml(crew.icon, 40)}</span>
    <span class="crew-detail-name">${escapeHtml(crew.name)}</span>
  `;
  detail.appendChild(header);

  // Lead section
  const leadAgent = agents.find(a => a.id === crew.lead_agent_id);
  const leadSection = document.createElement('div');
  leadSection.className = 'crew-detail-section';
  if (crew.lead_agent_id && crew.lead_name) {
    leadSection.innerHTML = `
      <h3>Lead</h3>
      <div class="crew-detail-lead">
        <span class="crew-detail-lead-icon">${crew.lead_icon}</span>
        <span class="crew-detail-lead-name">${escapeHtml(crew.lead_name)}</span>
        <button class="crew-chat-btn" title="Chat with ${escapeHtml(crew.lead_name)}">${ICON_CHAT(16)}</button>
      </div>
    `;
    leadSection.querySelector('.crew-chat-btn').addEventListener('click', () => {
      if (leadAgent) {
        openAgentChat(leadAgent);
      } else {
        chatWithAgent(crew.lead_agent_id);
      }
    });
  } else {
    leadSection.innerHTML = `
      <h3>Lead</h3>
      <div class="crew-detail-lead-empty">No lead assigned</div>
    `;
  }
  detail.appendChild(leadSection);

  // Members section — now shows agents, not profiles
  const membersSection = document.createElement('div');
  membersSection.className = 'crew-detail-section';
  membersSection.innerHTML = `<h3>Agents (${agents.length})</h3>`;

  const memberList = document.createElement('div');
  memberList.className = 'crew-member-list';

  if (agents.length === 0) {
    memberList.innerHTML = '<div class="crew-detail-lead-empty">No agents in this crew</div>';
  } else {
    for (const agent of agents) {
      const stateColors = { idle: '#6b7280', working: '#22c55e', stopped: '#ef4444' };
      const stateColor = stateColors[agent.state] || stateColors.idle;
      const issueTag = agent.issue_number ? ` <span style="color:var(--text-muted);font-size:0.75rem">#${agent.issue_number}</span>` : '';

      const item = document.createElement('div');
      item.className = 'crew-member-item';
      item.innerHTML = `
        <span class="conv-state-dot" style="background:${stateColor}" title="${agent.state}"></span>
        <span class="crew-member-icon">${agent.profile_icon || ''}</span>
        <span class="crew-member-name">${escapeHtml(agent.name)}${issueTag}</span>
        <span class="crew-member-state" style="font-size:0.7rem;color:var(--text-muted)">${agent.state}</span>
        <button class="crew-chat-btn" title="Open conversation">${ICON_CHAT(14)}</button>
        ${agent.state !== 'stopped' && agent.process_alive ? `<button class="crew-member-stop" title="Stop process" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.7rem;padding:2px 6px;border:1px solid #ef4444;border-radius:4px">Stop</button>` : ''}
        <button class="crew-member-remove" title="Fire agent">${ICON_REMOVE()}</button>
      `;

      item.querySelector('.crew-chat-btn').addEventListener('click', () => openAgentChat(agent));

      const stopBtn = item.querySelector('.crew-member-stop');
      if (stopBtn) {
        stopBtn.addEventListener('click', async () => {
          stopBtn.textContent = '...';
          stopBtn.disabled = true;
          await fetch(`/api/agents/${agent.id}?force=true`, { method: 'DELETE' });
          renderCrewDetail(crewId);
        });
      }

      item.querySelector('.crew-member-remove').addEventListener('click', async () => {
        if (!confirm(`Fire agent "${agent.name}"?`)) return;
        await fetch(`/api/agents/${agent.id}?force=true`, { method: 'DELETE' });
        renderCrewDetail(crewId);
      });

      memberList.appendChild(item);
    }
  }

  membersSection.appendChild(memberList);

  // Add member: hire a new agent from a profile
  const addRow = document.createElement('div');
  addRow.className = 'crew-add-member';

  let opts = '<option value="">Hire agent from profile\u2026</option>';
  for (const p of profiles) {
    opts += `<option value="${p.id}">${p.icon} ${escapeHtml(p.name)}</option>`;
  }
  addRow.innerHTML = `
    <select class="crew-add-select">${opts}</select>
    <button class="crew-add-btn">Hire &amp; Add</button>
  `;

  addRow.querySelector('.crew-add-btn').addEventListener('click', async () => {
    const profileId = addRow.querySelector('.crew-add-select').value;
    if (!profileId) return;
    try {
      const resp = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, crewId }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        alert(err.error || 'Failed to hire agent');
        return;
      }
      renderCrewDetail(crewId);
    } catch (err) {
      console.error('Failed to hire agent:', err);
      alert('Failed to hire agent');
    }
  });

  membersSection.appendChild(addRow);
  detail.appendChild(membersSection);

  container.innerHTML = '';
  container.appendChild(detail);
}

// --- Crews page (list view) ---

export async function renderCrewsPage() {
  const container = document.getElementById('crews-view');
  container.innerHTML = '<div class="crews-page"><div class="sessions-loading">Loading crews...</div></div>';
  const reload = () => renderCrewsPage();

  try {
    const crews = await fetchCrews();

    let html = '<div class="crews-page">';
    html += `<div class="crews-page-header">
      <h2>Crews</h2>
      <button class="new-crew-btn" id="crews-page-new-btn">+ New Crew</button>
    </div>`;
    html += '<div id="crews-page-form-area"></div>';
    html += '<div id="crews-page-list"></div>';
    html += '</div>';
    container.innerHTML = html;

    const listEl = document.getElementById('crews-page-list');

    const allProfiles = await fetchProfiles();
    const profileMap = new Map(allProfiles.map(p => [p.id, p]));

    if (crews.length === 0) {
      listEl.innerHTML = `<div class="crews-empty">
        <h3>No crews yet</h3>
        <p>Create a crew to group related profiles with a lead and members.</p>
      </div>`;
    } else {

      for (const crew of crews) {
        listEl.appendChild(renderCrewCard(crew, {
          onEdit: async (id) => {
            const data = await fetchCrew(id);
            if (data) {
              const formArea = document.getElementById('crews-page-form-area');
              showCrewForm(formArea, { crew: data.crew, onSaved: reload });
            }
          },
          onDelete: async (id) => {
            if (await deleteCrewById(id)) reload();
          },
          onClick: (id) => _navigateTo ? _navigateTo('crews', { crewId: id }) : renderCrewDetail(id),
          onChatLead: (agentId) => chatWithAgent(agentId),
        }));
      }
    }

    // --- Unassigned profiles section ---
    const unassigned = allProfiles.filter(p => !p.crews || p.crews.length === 0);

    if (unassigned.length > 0) {
      const section = document.createElement('div');
      section.className = 'unassigned-profiles-section';
      section.innerHTML = `<h3 class="unassigned-header">Unassigned Profiles (${unassigned.length})</h3>`;

      const grid = document.createElement('div');
      grid.className = 'unassigned-grid';

      for (const p of unassigned) {
        const card = document.createElement('div');
        card.className = 'unassigned-card';
        card.innerHTML = `
          <span class="unassigned-icon">${p.icon || ''}</span>
          <span class="unassigned-name">${escapeHtml(p.name)}</span>
        `;
        grid.appendChild(card);
      }

      section.appendChild(grid);
      listEl.parentElement.appendChild(section);
    }

    document.getElementById('crews-page-new-btn').addEventListener('click', () => {
      const formArea = document.getElementById('crews-page-form-area');
      showCrewForm(formArea, { crew: null, onSaved: reload });
    });
  } catch (error) {
    console.error('Failed to load crews:', error);
    container.innerHTML = '<div class="crews-page"><div class="crews-empty"><h3>Failed to load crews</h3></div></div>';
  }
}
