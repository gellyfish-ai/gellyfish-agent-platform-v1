/**
 * Session Info Modal — displays session, agent, and profile information.
 *
 * This module owns the info modal. It can be opened from anywhere
 * (tab menu, info button, etc.) by passing a session context object.
 *
 * Structure:
 *   fetchSessionData()  → gathers all data from canonical API endpoints
 *   render*Section()    → pure functions returning HTML strings
 *   wire*()             → attach event listeners after render
 *   openSessionInfo()   → orchestrator: fetch → render → wire
 */

import { escapeHtml, pushUrl, urlFor } from './utils.js';
import { renderTabs } from './tabs.js';

const modal = document.getElementById('tab-info-modal');
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.classList.remove('open');
});
document.getElementById('tab-info-close-btn').addEventListener('click', () => {
  modal.classList.remove('open');
});

// ── Session context type ────────────────────────────────────
// Callers pass this — it's just IDs + display data, no UI state.
//
// {
//   sessionId, profileId, agentId, conversationId,
//   name, icon, issueNumber,
//   formerProfileId, formerProfileName, formerProfileIcon, formerProfileSeq,
//   stats: { messages, userMessages, assistantMessages, toolUses, permissions, cost }
// }

// ── Data fetching ───────────────────────────────────────────

async function fetchSessionData(ctx) {
  const data = { profile: null, process: null, agent: null };

  if (ctx.profileId) {
    try {
      const resp = await fetch('/api/profiles');
      const result = await resp.json();
      data.profile = (result.profiles || []).find(p => p.id === ctx.profileId) || null;
    } catch { /* */ }
  }

  if (ctx.agentId || ctx.sessionId) {
    try {
      const resp = await fetch('/api/status');
      const result = await resp.json();
      data.process = (result.processes || []).find(p =>
        (ctx.agentId && p.agentId === ctx.agentId) ||
        (ctx.sessionId && p.sessionId === ctx.sessionId)
      ) || null;
    } catch { /* */ }
  }

  if (ctx.agentId) {
    try {
      const resp = await fetch(`/api/agents/${ctx.agentId}`);
      const result = await resp.json();
      data.agent = result.agent || null;
    } catch { /* */ }
  }

  return data;
}

// ── Section renderers (pure HTML) ───────────────────────────

function renderSessionIdSection(ctx) {
  if (!ctx.sessionId) return '';
  return `<div class="modal-section"><label>Session ID</label>
    <div class="value"><span class="session-info-id">${escapeHtml(ctx.sessionId)}</span><button class="copy-btn session-id-copy-btn">Copy</button></div>
  </div>`;
}

function renderProfileSection(profile, ctx) {
  if (!ctx.profileId) return '';
  let html = `<div class="modal-section"><label>Profile</label>`;
  html += infoRow('Name', `${ctx.icon || ''} ${escapeHtml(ctx.name)}`);
  if (profile?.workspace_dir) {
    html += infoRow('Workspace', `<code>${escapeHtml(profile.workspace_dir)}</code>`);
  }
  html += `</div>`;
  return html;
}

function renderProcessSection(process) {
  if (!process) return '';
  const stateColor = process.alive ? '#4ade80' : '#888';
  const stateLabel = process.alive ? (process.processing ? 'Working' : 'Idle') : 'Off';
  let html = `<div class="modal-section"><label>Process</label>`;
  html += infoRow('State', `<span style="color:${stateColor}">\u25CF</span> ${stateLabel}`);
  if (process.pid) html += infoRow('PID', process.pid);
  html += `</div>`;
  return html;
}

function renderModelSection(profile) {
  if (!profile) return '';
  const confirmedModel = profile.confirmed_model || null;
  const intendedModel = profile.model || null;
  const mismatch = confirmedModel && intendedModel && !confirmedModel.includes(intendedModel);

  let html = `<div class="modal-section"><label>Model</label>`;
  if (confirmedModel) {
    const mismatchBadge = mismatch
      ? ' <span style="background:#4a2020;color:#f87171;padding:1px 6px;border-radius:4px;font-size:0.6rem;margin-left:4px">mismatch</span>'
      : '';
    html += infoRow('Running', `<span class="model-badge">${escapeHtml(confirmedModel)}</span>${mismatchBadge}`);
  } else {
    html += infoRow('Running', '<span style="color:var(--text-muted);font-style:italic">Not confirmed</span>');
  }
  if (intendedModel) {
    html += infoRow('Intended', escapeHtml(intendedModel));
  }
  html += `<div class="info-row"><span class="label">Change</span><span class="val"><select class="model-select"><option value="">Loading...</option></select></span></div>`;
  html += `</div>`;
  return html;
}

function renderCrewsSection(profile) {
  if (!profile?.crews?.length) return '';
  let html = `<div class="modal-section"><label>Crews</label>`;
  for (const crew of profile.crews) {
    const roleBadge = crew.role === 'lead'
      ? '<span style="background:#4a3520;color:#e6a56c;padding:1px 6px;border-radius:4px;font-size:0.65rem;margin-left:6px">lead</span>'
      : '<span style="background:#1a2a1a;color:#4ade80;padding:1px 6px;border-radius:4px;font-size:0.65rem;margin-left:6px">member</span>';
    html += infoRow(escapeHtml(crew.name), roleBadge);
  }
  html += `</div>`;
  return html;
}

function renderMcpsSection(profile) {
  if (!profile?.mcps?.length) return '';
  let html = `<div class="modal-section"><label>MCPs</label>`;
  for (const mcp of profile.mcps) {
    const typeBadge = mcp.type === 'global'
      ? '<span style="background:#1a1a2e;color:#8888cc;padding:1px 6px;border-radius:4px;font-size:0.65rem;margin-left:6px">global</span>'
      : '';
    html += infoRow(escapeHtml(mcp.name), typeBadge);
  }
  html += `</div>`;
  return html;
}

function renderSystemPromptSection(profile) {
  if (!profile?.system_prompt) return '';
  return `<div class="modal-section"><label>System Prompt</label>
    <div class="tool-detail-body tool-detail-terminal" style="max-height:200px;overflow-y:auto;font-size:0.7rem">${escapeHtml(profile.system_prompt)}</div>
  </div>`;
}

function renderCliResumeSection(ctx, agentWorkspaceDir) {
  if (!ctx.sessionId) return '';
  let html = `<div class="modal-section"><label>Resume in CLI</label>`;
  if (agentWorkspaceDir) {
    const resumeCmd = `cd ${agentWorkspaceDir}\nclaude --resume ${ctx.sessionId}`;
    html += `<div class="cli-hint" style="display:flex;align-items:flex-start;gap:0.5rem">`;
    html += `<pre class="cli-resume-pre" style="margin:0;flex:1;white-space:pre;overflow-x:auto"><code>${escapeHtml(resumeCmd)}</code></pre>`;
    html += `<button class="copy-btn cli-resume-copy-btn" data-cmd="${escapeHtml(resumeCmd)}" style="flex-shrink:0">Copy</button>`;
    html += `</div>`;
  } else {
    html += `<div class="cli-hint" style="color:var(--text-muted)">Could not resolve agent workspace \u2014 no CLI resume available</div>`;
  }
  html += `</div>`;
  return html;
}

function renderFormerProfileSection(ctx) {
  if (!ctx.formerProfileId || ctx.profileId) return '';
  let html = `<div class="modal-section"><label>Detached Profile</label>`;
  html += infoRow('Name', `${ctx.formerProfileIcon || ''} ${escapeHtml(ctx.formerProfileName || 'Unknown')}`);
  html += infoRow('Sequence', `#${ctx.formerProfileSeq || 1}`);
  html += `</div>`;
  return html;
}

function renderIssueSection(ctx) {
  const REPO_URL = 'https://github.com/gellyfish-ai/Gellyfish-Agent-Platform';
  let html = `<div class="modal-section"><label>Linked Issue</label>`;
  if (ctx.issueNumber) {
    html += infoRow('Working on', `<a href="${REPO_URL}/issues/${ctx.issueNumber}" target="_blank" rel="noopener">#${ctx.issueNumber}</a>`);
  } else {
    html += infoRow('Status', 'No issue linked');
  }
  if (ctx.conversationId) {
    html += `<div class="info-row">
      <span class="label">Assign</span>
      <span class="val">
        <input type="number" class="issue-assign-input" placeholder="#" min="1" style="width:60px" value="${ctx.issueNumber || ''}" />
        <button class="issue-assign-btn" style="margin-left:4px">Set</button>
        ${ctx.issueNumber ? '<button class="issue-clear-btn" style="margin-left:4px">Clear</button>' : ''}
      </span>
    </div>`;
  }
  html += `</div>`;
  return html;
}

function renderStatsSection(stats) {
  if (!stats) return '';
  let html = `<div class="modal-section"><label>Stats</label>`;
  html += infoRow('Messages', `${stats.messages} <span style="font-size:0.75em;color:var(--text-muted)">(${stats.userMessages} user, ${stats.assistantMessages} assistant)</span>`);
  html += infoRow('Tool Uses', stats.toolUses);
  if (stats.permissions > 0) html += infoRow('Permissions', stats.permissions);
  html += infoRow('Cost', `$${stats.cost.toFixed(4)}`);
  html += `</div>`;
  return html;
}

function renderConnectionSection(connected) {
  const connStatus = connected ? 'Connected' : 'Disconnected';
  let html = `<div class="modal-section"><label>Connection</label>`;
  html += infoRow('Status', connStatus);
  html += infoRow('Server', window.location.host);
  html += `</div>`;
  return html;
}

function renderSessionFilesPlaceholder(ctx) {
  if (!ctx.conversationId) return '';
  return `<div class="modal-section"><label>Session Files</label>
    <div class="session-files-list" style="font-size:0.8rem">Loading...</div>
  </div>`;
}

// ── Event wiring ────────────────────────────────────────────

function wireCopyButton(container, selector, getText) {
  const btn = container.querySelector(selector);
  if (!btn) return;
  btn.addEventListener('click', () => {
    const text = getText(btn);
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  });
}

function wireModelSelect(container, ctx, profile) {
  const modelSelect = container.querySelector('.model-select');
  if (!modelSelect || !ctx.profileId) return;

  const profileModel = profile?.model || null;

  fetch('/api/models').then(r => r.json()).then(data => {
    const models = data.models || [];
    modelSelect.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      modelSelect.appendChild(opt);
    }
    modelSelect.value = profileModel || models[0]?.id || '';
  }).catch(() => {
    modelSelect.innerHTML = '<option>Error loading models</option>';
  });

  modelSelect.addEventListener('change', async () => {
    const newModel = modelSelect.value;
    if (!newModel || newModel === profileModel) return;
    const currentLabel = modelSelect.options[modelSelect.selectedIndex]?.textContent || newModel;
    if (!confirm(`Change model to ${currentLabel}? This will kill the current process and respawn.`)) {
      modelSelect.value = profileModel || '';
      return;
    }
    modelSelect.disabled = true;
    try {
      await fetch(`/api/profiles/${ctx.profileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: newModel }),
      });
      if (ctx.sessionId) {
        await fetch(`/api/sessions/${ctx.sessionId}/stop`, { method: 'POST' });
      }
      modal.classList.remove('open');
    } catch (err) {
      console.error('Failed to change model:', err);
      modelSelect.disabled = false;
      alert('Failed to change model. See console for details.');
    }
  });
}

function wireIssueButtons(container, ctx) {
  const assignBtn = container.querySelector('.issue-assign-btn');
  if (assignBtn && ctx.conversationId) {
    assignBtn.addEventListener('click', async () => {
      const input = container.querySelector('.issue-assign-input');
      const num = parseInt(input.value, 10);
      if (!num || num < 1) return;
      await fetch(`/api/conversations/${ctx.conversationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue_number: num }),
      });
      ctx.issueNumber = num;
      renderTabs();
      openSessionInfo(ctx);
    });
  }

  const clearBtn = container.querySelector('.issue-clear-btn');
  if (clearBtn && ctx.conversationId) {
    clearBtn.addEventListener('click', async () => {
      await fetch(`/api/conversations/${ctx.conversationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue_number: null }),
      });
      ctx.issueNumber = null;
      renderTabs();
      openSessionInfo(ctx);
    });
  }
}

function wireSessionFiles(container, ctx) {
  const sessionFilesList = container.querySelector('.session-files-list');
  if (!sessionFilesList || !ctx.conversationId) return;

  fetch(`/api/conversations/${ctx.conversationId}/session-files`)
    .then(r => r.json())
    .then(data => {
      if (!data.sessions || data.sessions.length === 0) {
        sessionFilesList.innerHTML = '<span style="color:var(--text-muted)">No session files found</span>';
        return;
      }
      sessionFilesList.innerHTML = data.sessions.map(s => renderSessionFileEntry(s)).join('');
      wireSessionFileButtons(sessionFilesList, ctx);
    })
    .catch(() => {
      sessionFilesList.innerHTML = '<span style="color:#ef4444">Error loading sessions</span>';
    });
}

function renderSessionFileEntry(s) {
  const active = s.active ? ' <span style="color:#30d158;font-size:0.7rem">\u25CF active</span>' : '';
  const switchBtn = s.active ? '' : `<button class="session-switch-btn" data-session-id="${s.sessionId}" style="margin-left:6px;font-size:0.7rem;padding:1px 6px;cursor:pointer">Switch</button>`;
  const ts = formatSessionTimestamp(s.modifiedAt);
  const pathDisplay = s.path ? `<div style="font-size:0.65rem;color:var(--text-muted);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:400px" title="${s.path}">${s.path}</div>` : '';
  const copyBtn = s.path ? `<button class="session-copy-path-btn" data-path="${s.path}" style="margin-left:4px;font-size:0.65rem;padding:1px 4px;cursor:pointer" title="Copy path">\uD83D\uDCCB</button>` : '';
  const previewBtn = `<button class="session-preview-btn" data-session-id="${s.sessionId}" style="margin-left:4px;font-size:0.65rem;padding:1px 4px;cursor:pointer" title="Preview messages">\uD83D\uDC41</button>`;
  return `<div style="font-size:0.75rem;margin-bottom:6px;border-bottom:1px solid var(--border-color,#333);padding-bottom:6px">
    <div class="info-row">
      <span class="label" style="font-family:monospace">${s.sessionId.substring(0, 8)}...</span>
      <span class="val">${s.sizeMB}MB \u00B7 ${ts}${active}${switchBtn}${copyBtn}${previewBtn}</span>
    </div>
    ${pathDisplay}
    <div class="session-preview-container" data-session-id="${s.sessionId}" style="display:none"></div>
  </div>`;
}

function wireSessionFileButtons(container, ctx) {
  for (const btn of container.querySelectorAll('.session-switch-btn')) {
    btn.addEventListener('click', async () => {
      const targetSession = btn.dataset.sessionId;
      btn.textContent = 'Switching...';
      btn.disabled = true;
      const resp = await fetch(`/api/conversations/${ctx.conversationId}/switch-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: targetSession }),
      });
      if (resp.ok) {
        ctx.sessionId = targetSession;
        pushUrl(urlFor('chat', { sessionId: targetSession }));
        const { loadHistoryAndConnect } = await import('./session-manager.js');
        loadHistoryAndConnect(targetSession);
        openSessionInfo(ctx);
      } else {
        btn.textContent = 'Failed';
      }
    });
  }

  for (const btn of container.querySelectorAll('.session-copy-path-btn')) {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.path).then(() => {
        const orig = btn.textContent;
        btn.textContent = '\u2713';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      });
    });
  }

  for (const btn of container.querySelectorAll('.session-preview-btn')) {
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.sessionId;
      const el = container.querySelector(`.session-preview-container[data-session-id="${sid}"]`);
      if (!el) return;
      if (el.style.display !== 'none') { el.style.display = 'none'; return; }
      el.style.display = 'block';
      el.innerHTML = '<span style="color:var(--text-muted);font-size:0.7rem">Loading preview...</span>';
      try {
        const resp = await fetch(`/api/sessions/${sid}/preview`);
        const result = await resp.json();
        if (!result.messages?.length) {
          el.innerHTML = '<span style="color:var(--text-muted);font-size:0.7rem">No messages</span>';
          return;
        }
        const previewHtml = result.messages.map(m => {
          const roleColor = m.role === 'user' ? '#60a5fa' : '#34d399';
          const escapedText = m.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<div style="margin:2px 0;font-size:0.7rem"><span style="color:${roleColor};font-weight:600">${m.role}:</span> ${escapedText}</div>`;
        }).join('');
        el.innerHTML = `<div style="max-height:200px;overflow-y:auto;padding:4px 6px;margin-top:4px;background:var(--bg-secondary,#1a1a1a);border-radius:4px;border:1px solid var(--border-color,#333)">${previewHtml}</div>`;
      } catch {
        el.innerHTML = '<span style="color:#ef4444;font-size:0.7rem">Failed to load preview</span>';
      }
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────

function infoRow(label, value) {
  return `<div class="info-row"><span class="label">${label}</span><span class="val">${value}</span></div>`;
}

function formatSessionTimestamp(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── Orchestrator ────────────────────────────────────────────

export async function openSessionInfo(ctx) {
  const titleEl = document.getElementById('tab-info-title');
  const contentEl = document.getElementById('tab-info-content');

  titleEl.textContent = ctx.profileId
    ? `${ctx.icon || ''} ${ctx.name}`.trim()
    : ctx.name || 'Session';

  const { profile, process, agent } = await fetchSessionData(ctx);

  const type = ctx.profileId ? 'Profile Session' : ctx.sessionId ? 'Session' : 'New (no session)';
  const html = [
    infoRow('Type', type),
    renderSessionIdSection(ctx),
    ctx.name && ctx.name !== 'New Chat' ? infoRow('Name', escapeHtml(ctx.name)) : '',
    renderProfileSection(profile, ctx),
    renderProcessSection(process),
    ctx.profileId ? renderModelSection(profile) : '',
    renderCrewsSection(profile),
    renderMcpsSection(profile),
    renderSystemPromptSection(profile),
    renderCliResumeSection(ctx, agent?.workspace_dir || null),
    renderFormerProfileSection(ctx),
    renderIssueSection(ctx),
    renderStatsSection(ctx.stats),
    renderConnectionSection(ctx.connected),
    renderSessionFilesPlaceholder(ctx),
  ].join('');

  contentEl.innerHTML = html;
  modal.classList.add('open');

  wireCopyButton(contentEl, '.session-id-copy-btn', () => ctx.sessionId);
  wireCopyButton(contentEl, '.cli-resume-copy-btn', btn => btn.dataset.cmd);
  wireModelSelect(contentEl, ctx, profile);
  wireIssueButtons(contentEl, ctx);
  wireSessionFiles(contentEl, ctx);
}
