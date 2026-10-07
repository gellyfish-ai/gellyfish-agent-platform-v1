/**
 * Profiles view — renders the profiles list page and profile forms.
 * Layer 5 (view): imports from layers 0-4 only. Never imports from other views.
 */

import state from './state.js';
import { escapeHtml, fetchProfiles } from './utils.js';
import { startProfileSession } from './session-manager.js';
import { updateActiveTabProfile } from './tabs.js';

let _navigateTo = null;
export function initProfiles({ navigateTo }) {
  _navigateTo = navigateTo;
}

// --- SVG icons (shared) ---

const ICON_EDIT = (size = 14) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>`;

const ICON_DELETE = (size = 14) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>`;

async function fetchProfile(id) {
  const profiles = await fetchProfiles();
  return profiles.find(p => p.id === id) || null;
}

// Model options cache
let _modelOptions = null;
async function fetchModelOptions() {
  if (_modelOptions) return _modelOptions;
  try {
    const resp = await fetch('/api/models');
    _modelOptions = await resp.json();
  } catch { _modelOptions = { models: [], default: 'sonnet' }; }
  return _modelOptions;
}

async function saveProfile(id, { name, icon, system_prompt, model }) {
  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/profiles/${id}` : '/api/profiles';
  const resp = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, icon, system_prompt, model: model || null }),
  });
  return resp.json();
}

async function deleteProfileById(id) {
  if (!confirm('Delete this profile?')) return false;
  await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
  return true;
}

// --- Profile form (create & edit, shared) ---

function showProfileForm(container, { profile, onSaved }) {
  const existing = container.querySelector('.profile-form');
  if (existing) { existing.remove(); return; }

  const isEdit = !!profile;
  const form = document.createElement('div');
  form.className = 'profile-form';
  form.innerHTML = `
    <div class="form-row">
      <input type="text" class="pf-icon-input" placeholder="\uD83E\uDD16" value="${escapeHtml(isEdit ? profile.icon : '\uD83E\uDD16')}" maxlength="2" />
      <input type="text" class="pf-name-input" placeholder="Profile name" value="${isEdit ? escapeHtml(profile.name) : ''}" />
    </div>
    <textarea class="pf-prompt-input" placeholder="System prompt (e.g., 'You help me manage my email...')">${isEdit ? escapeHtml(profile.system_prompt) : ''}</textarea>
    <div class="form-row">
      <label class="pf-model-label">Model:</label>
      <select class="pf-model-select"><option value="">Loading...</option></select>
    </div>
    <div class="form-actions">
      <button class="cancel">Cancel</button>
      <button class="save">${isEdit ? 'Save' : 'Create'}</button>
    </div>
  `;

  form.querySelector('.cancel').addEventListener('click', () => form.remove());
  form.querySelector('.save').addEventListener('click', async () => {
    const name = form.querySelector('.pf-name-input').value.trim();
    const icon = form.querySelector('.pf-icon-input').value.trim() || '\uD83E\uDD16';
    const system_prompt = form.querySelector('.pf-prompt-input').value.trim();
    const model = form.querySelector('.pf-model-select')?.value || null;
    if (!name) return;

    try {
      await saveProfile(isEdit ? profile.id : null, { name, icon, system_prompt, model });
      if (onSaved) onSaved();
    } catch (error) {
      console.error('Failed to save profile:', error);
    }
  });

  container.prepend(form);

  // Populate model dropdown
  fetchModelOptions().then(data => {
    const sel = form.querySelector('.pf-model-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">' + (data.default ? 'Default (' + data.default + ')' : 'Default') + '</option>';
    for (const m of data.models || []) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      if (isEdit && profile.model === m.id) opt.selected = true;
      sel.appendChild(opt);
    }
  });

  form.querySelector('.pf-name-input').focus();
}

// --- SVG icons (more) ---

const ICON_PLUG = (size = 14) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 22v-5m0 0a7 7 0 007-7c0-2-1-3.9-2.8-5.2M12 17a7 7 0 01-7-7c0-2 1-3.9 2.8-5.2M9 2l1 4m4-4l-1 4" /></svg>`;

// --- MCP helpers ---

async function fetchProfileMcps(profileId) {
  const resp = await fetch(`/api/profiles/${profileId}/mcps`);
  const data = await resp.json();
  return data.mcps || [];
}

async function saveProfileMcps(profileId, mcpServerIds) {
  await fetch(`/api/profiles/${profileId}/mcps`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcp_server_ids: mcpServerIds }),
  });
}

async function createCustomMcp({ name, command, args }) {
  const resp = await fetch('/api/mcps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, command, args }),
  });
  return resp.json();
}

function showMcpPanel(container, profileId, onSaved) {
  const existing = container.querySelector('.mcp-panel');
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.className = 'mcp-panel';
  panel.innerHTML = '<div class="mcp-panel-loading">Loading MCPs...</div>';
  container.appendChild(panel);

  function loadPanel() {
    fetchProfileMcps(profileId).then(mcps => {
      panel.innerHTML = '<div class="mcp-panel-title">MCP Servers</div>';

      if (mcps.length === 0) {
        panel.innerHTML += '<div class="mcp-panel-empty">No MCP servers available</div>';
      } else {
        const list = document.createElement('div');
        list.className = 'mcp-toggle-list';

        for (const mcp of mcps) {
          const row = document.createElement('label');
          row.className = 'mcp-toggle-row';
          row.innerHTML = `
            <input type="checkbox" ${mcp.enabled ? 'checked' : ''} data-mcp-id="${mcp.id}" />
            <span class="mcp-toggle-name">${escapeHtml(mcp.name)}</span>
            <span class="mcp-toggle-type">${mcp.type}</span>
          `;
          list.appendChild(row);
        }

        panel.appendChild(list);
      }

      // Add custom MCP form (collapsed by default)
      const addLink = document.createElement('button');
      addLink.className = 'mcp-add-link';
      addLink.textContent = '+ Add custom MCP';
      panel.appendChild(addLink);

      const formArea = document.createElement('div');
      panel.appendChild(formArea);

      addLink.addEventListener('click', () => {
        if (formArea.children.length > 0) { formArea.innerHTML = ''; return; }
        const form = document.createElement('div');
        form.className = 'mcp-add-form';
        form.innerHTML = `
          <input type="text" class="mcp-add-name" placeholder="Name (e.g. keep-mcp)" />
          <input type="text" class="mcp-add-command" placeholder="Command (e.g. npx)" />
          <input type="text" class="mcp-add-args" placeholder="Args (comma-separated, e.g. -y,@anthropic/keep-mcp)" />
          <div class="mcp-panel-actions">
            <button class="mcp-save-btn mcp-add-create-btn">Create</button>
          </div>
        `;
        form.querySelector('.mcp-add-create-btn').addEventListener('click', async (e) => {
          e.stopPropagation();
          const name = form.querySelector('.mcp-add-name').value.trim();
          const command = form.querySelector('.mcp-add-command').value.trim();
          const argsStr = form.querySelector('.mcp-add-args').value.trim();
          if (!name || !command) return;
          const args = argsStr ? argsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
          const result = await createCustomMcp({ name, command, args });
          if (result.error) {
            alert(result.error);
            return;
          }
          // Re-load panel to show the new MCP
          loadPanel();
        });
        formArea.appendChild(form);
        form.querySelector('.mcp-add-name').focus();
      });

      // Save button
      const actions = document.createElement('div');
      actions.className = 'mcp-panel-actions';
      actions.innerHTML = `<button class="mcp-save-btn">Save</button>`;
      panel.appendChild(actions);

      actions.querySelector('.mcp-save-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const checked = panel.querySelectorAll('.mcp-toggle-list input[type="checkbox"]:checked');
        const ids = Array.from(checked).map(cb => cb.dataset.mcpId);
        await saveProfileMcps(profileId, ids);
        panel.remove();
        if (onSaved) onSaved();
      });
    });
  }

  loadPanel();
}

// --- Profile card rendering (shared between modal and page) ---

function renderProfileCard(profile, { variant, onEdit, onDelete, onClick }) {
  const isCompact = variant === 'compact';
  const previewLen = isCompact ? 80 : 120;
  const iconSize = isCompact ? 14 : 16;

  const promptPreview = profile.system_prompt
    ? profile.system_prompt.substring(0, previewLen) + (profile.system_prompt.length > previewLen ? '...' : '')
    : 'No system prompt';

  const el = document.createElement('div');
  el.className = isCompact ? 'profile-item' : 'profile-card';
  el.dataset.profileId = profile.id;

  if (isCompact) {
    el.innerHTML = `
      <span class="profile-icon">${profile.icon}</span>
      <div class="profile-info">
        <div class="profile-name">${escapeHtml(profile.name)}</div>
        <div class="profile-prompt-preview">${escapeHtml(promptPreview)}</div>
      </div>
      <div class="profile-actions">
        <button class="profile-action-btn edit-btn" title="Edit">${ICON_EDIT(iconSize)}</button>
        <button class="profile-action-btn delete" title="Delete">${ICON_DELETE(iconSize)}</button>
      </div>
    `;
  } else {
    const crews = profile.crews || [];
    const mcps = profile.mcps || [];
    const activeAgents = profile.active_agents || 0;
    const totalAgents = profile.total_agents || 0;
    const agentBadge = totalAgents > 0
      ? `<span class="profile-agent-badge">${activeAgents}/${5} agents</span>`
      : '<span class="profile-agent-badge empty">No agents</span>';
    const modelBadge = profile.model
      ? '<span class="profile-model-badge">' + escapeHtml(profile.model) + '</span>'
      : '';
    let metaParts = [agentBadge, modelBadge].filter(Boolean);

    let crewBadgesHtml = '';
    if (crews.length > 0) {
      crewBadgesHtml = '<div class="profile-card-crews">' + crews.map(c =>
        `<a href="/crews" class="profile-crew-badge" data-crew-id="${c.id}" title="${escapeHtml(c.name)}${c.role === 'lead' ? ' (lead)' : ''}">${escapeHtml(c.name)}${c.role === 'lead' ? ' <span class="crew-role-star">★</span>' : ''}</a>`
      ).join('') + '</div>';
    }

    let mcpBadgesHtml = '';
    if (mcps.length > 0) {
      mcpBadgesHtml = '<div class="profile-card-mcps">' + mcps.map(m =>
        `<span class="profile-mcp-badge${m.type === 'global' ? '' : ' custom'}" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>`
      ).join('') + '</div>';
    }

    el.innerHTML = `
      <span class="profile-card-icon">${profile.icon}</span>
      <div class="profile-card-info">
        <div class="profile-card-name">${escapeHtml(profile.name)}</div>
        <div class="profile-card-prompt">${escapeHtml(promptPreview)}</div>
        ${crewBadgesHtml}
        ${mcpBadgesHtml}
        <div class="profile-card-meta">${metaParts.join('')}</div>
      </div>
      <div class="profile-card-actions">
        <button class="profile-action-btn hire-btn" title="Hire Agent" style="color: var(--accent);">+</button>
        <button class="profile-action-btn mcps-btn" title="MCPs">${ICON_PLUG(iconSize)}</button>
        <button class="profile-action-btn edit-btn" title="Edit">${ICON_EDIT(iconSize)}</button>
        <button class="profile-action-btn delete" title="Delete">${ICON_DELETE(iconSize)}</button>
      </div>
    `;

    // Crew badge clicks navigate to crews view via callback
    el.querySelectorAll('.profile-crew-badge').forEach(badge => {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (_navigateTo) _navigateTo('crews');
      });
    });
  }

  el.querySelector('.edit-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    onEdit(profile.id);
  });
  el.querySelector('.delete').addEventListener('click', (e) => {
    e.stopPropagation();
    onDelete(profile.id);
  });
  const hireBtn = el.querySelector('.hire-btn');
  if (hireBtn) {
    hireBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const resp = await fetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: profile.id }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          alert(err.error || 'Failed to hire agent');
          return;
        }
        const data = await resp.json();
        // Import dynamically to avoid circular dependency
        const { startAgentSession } = await import('./session-manager.js');
        startAgentSession({
          id: data.agent.id,
          name: data.agent.name,
          profile_id: profile.id,
          profile_icon: profile.icon,
          session_id: null,
          conversation_id: data.conversation?.id || null,
          conversation_state: data.conversation?.state || 'cold',
          issue_number: null,
        });
      } catch (err) {
        console.error('Failed to hire agent:', err);
        alert('Failed to hire agent');
      }
    });
  }
  const mcpsBtn = el.querySelector('.mcps-btn');
  if (mcpsBtn) {
    mcpsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showMcpPanel(el, profile.id, () => {
        // Re-render the page to update badges
        renderProfilesPage();
      });
    });
  }
  el.addEventListener('click', () => onClick(profile));

  return el;
}

// --- Session-profile linking ---

export async function loadProfileForSession(sessionId) {
  try {
    const resp = await fetch(`/api/sessions/${sessionId}/profile`);
    const data = await resp.json();
    if (data.profile) {
      state.activeProfileId = data.profile.id;
      updateActiveTabProfile(data.profile.id, data.profile.icon, data.profile.name);
    }
  } catch {
    // No profile for this session
  }
}

// --- Modal view ---

export async function loadProfilesInModal() {
  const listEl = document.getElementById('profile-list');
  const reload = () => loadProfilesInModal();

  try {
    const profiles = await fetchProfiles();

    if (profiles.length === 0) {
      listEl.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted); padding: 0.5rem;">No profiles yet. Create one to get started.</div>';
      return;
    }

    listEl.innerHTML = '';
    for (const profile of profiles) {
      listEl.appendChild(renderProfileCard(profile, {
        variant: 'compact',
        onEdit: async (id) => {
          const p = await fetchProfile(id);
          if (p) showProfileForm(listEl, { profile: p, onSaved: reload });
        },
        onDelete: async (id) => {
          if (await deleteProfileById(id)) reload();
        },
        onClick: startProfileSession,
      }));
    }
  } catch (error) {
    console.error('Failed to load profiles:', error);
    listEl.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted); padding: 0.5rem;">Failed to load profiles</div>';
  }
}

export function showCreateProfile() {
  const listEl = document.getElementById('profile-list');
  showProfileForm(listEl, { profile: null, onSaved: () => loadProfilesInModal() });
}

// --- Full page view ---

// Persists across re-renders within the session
let profileFilter = 'all'; // 'all' | 'no-crew' | 'in-crew'

export async function renderProfilesPage() {
  const container = document.getElementById('profiles-view');
  container.innerHTML = '<div class="profiles-page"><div class="sessions-loading">Loading profiles...</div></div>';
  const reload = () => renderProfilesPage();

  try {
    const profiles = await fetchProfiles();

    // Check if any crew data exists to decide whether to show filter
    const hasAnyCrews = profiles.some(p => (p.crews || []).length > 0);

    let html = '<div class="profiles-page">';
    html += `<div class="profiles-page-header">
      <h2>Profiles</h2>
      <button class="new-profile-btn" id="profiles-page-new-btn">+ New Profile</button>
    </div>`;

    if (hasAnyCrews) {
      html += `<div class="profiles-filter-bar" id="profiles-filter-bar">
        <button class="profiles-filter-btn${profileFilter === 'all' ? ' active' : ''}" data-filter="all">All</button>
        <button class="profiles-filter-btn${profileFilter === 'in-crew' ? ' active' : ''}" data-filter="in-crew">In a crew</button>
        <button class="profiles-filter-btn${profileFilter === 'no-crew' ? ' active' : ''}" data-filter="no-crew">No crew</button>
      </div>`;
    }

    html += '<div id="profiles-page-form-area"></div>';
    html += '<div id="profiles-page-list"></div>';
    html += '</div>';
    container.innerHTML = html;

    // Wire up filter buttons
    if (hasAnyCrews) {
      document.getElementById('profiles-filter-bar').addEventListener('click', (e) => {
        const btn = e.target.closest('.profiles-filter-btn');
        if (!btn) return;
        profileFilter = btn.dataset.filter;
        renderFilteredList();
        document.querySelectorAll('.profiles-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === profileFilter));
      });
    }

    const listEl = document.getElementById('profiles-page-list');

    function renderFilteredList() {
      let filtered = profiles;
      if (profileFilter === 'no-crew') {
        filtered = profiles.filter(p => (p.crews || []).length === 0);
      } else if (profileFilter === 'in-crew') {
        filtered = profiles.filter(p => (p.crews || []).length > 0);
      }

      listEl.innerHTML = '';
      if (filtered.length === 0) {
        listEl.innerHTML = `<div class="profiles-empty">
          <h3>${profileFilter === 'all' ? 'No profiles yet' : profileFilter === 'no-crew' ? 'All profiles are in a crew' : 'No profiles in a crew yet'}</h3>
          <p>${profileFilter === 'all' ? 'Create a profile to customize your AI assistant\'s personality and behavior.' : ''}</p>
        </div>`;
      } else {
        for (const profile of filtered) {
          listEl.appendChild(renderProfileCard(profile, {
            variant: 'full',
            onEdit: async (id) => {
              const p = await fetchProfile(id);
              if (p) {
                const formArea = document.getElementById('profiles-page-form-area');
                showProfileForm(formArea, { profile: p, onSaved: reload });
              }
            },
            onDelete: async (id) => {
              if (await deleteProfileById(id)) reload();
            },
            onClick: startProfileSession,
          }));
        }
      }
    }

    renderFilteredList();

    document.getElementById('profiles-page-new-btn').addEventListener('click', () => {
      const formArea = document.getElementById('profiles-page-form-area');
      showProfileForm(formArea, { profile: null, onSaved: reload });
    });
  } catch (error) {
    console.error('Failed to load profiles:', error);
    container.innerHTML = '<div class="profiles-page"><div class="profiles-empty"><h3>Failed to load profiles</h3></div></div>';
  }
}

// Re-export for backwards compatibility (crews.js imports this)
export { startProfileSession } from './session-manager.js';
