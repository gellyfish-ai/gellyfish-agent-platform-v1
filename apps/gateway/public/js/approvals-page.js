/**
 * Approvals admin page — pending approvals, audit log, paired devices.
 */

import { escapeHtml } from './utils.js';

export async function renderApprovalsPage() {
  const container = document.getElementById('approvals-view');
  if (!container) return;

  container.innerHTML = '<div class="page-content"><h2>Approvals</h2><p class="loading">Loading...</p></div>';

  const content = container.querySelector('.page-content');
  content.innerHTML = '<h2>Approvals</h2>';

  await Promise.all([
    renderPendingSection(content),
    renderDevicesSection(content),
    renderAuditSection(content),
  ]);
}

// --- Pending Approvals ---

async function renderPendingSection(content) {
  const section = document.createElement('div');
  section.className = 'admin-section';
  section.innerHTML = '<h3>Pending Approvals</h3>';

  try {
    const resp = await fetch('/api/approvals/pending');
    const data = await resp.json();
    const approvals = data.approvals || [];

    if (approvals.length === 0) {
      section.innerHTML += '<p class="admin-empty">No pending approvals</p>';
    } else {
      // Approvals are read-only from the browser — only the paired iOS device
      // can produce a valid cryptographic signature. The Status column shows
      // a pending indicator; the row disappears on the next page refresh
      // once the device resolves the approval.
      // Agent + profile snapshot fields (#658). Pre-#658 rows have null —
      // show the loud "(unknown …)" defaults so a regression is visible.
      const table = buildTable(
        ['Agent', 'Profile', 'Tool', 'MCP', 'Preview', 'Expires', 'Status'],
        approvals.map(a => [
          escapeHtml(a.agent_display_name || '(unknown agent)'),
          escapeHtml(a.profile_display_name || '(unknown profile)'),
          escapeHtml(a.tool_name),
          escapeHtml(a.mcp_name),
          `<span title="${escapeHtml(a.human_preview || '')}">${escapeHtml((a.human_preview || '').substring(0, 50))}</span>`,
          formatTimeRemaining(a.expires_at),
          '<span class="approval-pending">\u23F3 Awaiting approval on paired device</span>',
        ])
      );
      section.appendChild(table);
    }
  } catch {
    section.innerHTML += '<p class="admin-error">Failed to load pending approvals</p>';
  }

  content.appendChild(section);
}

// --- Paired Devices ---

async function renderDevicesSection(content) {
  const section = document.createElement('div');
  section.className = 'admin-section';
  section.innerHTML = '<h3>Paired Devices</h3>';

  try {
    const resp = await fetch('/api/devices');
    const data = await resp.json();
    const devices = data.devices || [];

    if (devices.length === 0) {
      section.innerHTML += '<p class="admin-empty">No paired devices \u2014 browser-only mode</p>';
    } else {
      const table = buildTable(
        ['Name', 'Paired', 'Crypto', 'Actions'],
        devices.map(d => [
          escapeHtml(d.device_name),
          formatDate(d.paired_at),
          d.public_key ? '\u2705 Yes' : '\u274C No',
          `<button class="admin-btn danger" data-id="${d.id}" data-name="${escapeHtml(d.device_name)}">Revoke</button>`,
        ])
      );
      section.appendChild(table);

      table.querySelectorAll('.admin-btn.danger').forEach(btn => {
        btn.addEventListener('click', () => {
          if (confirm(`Revoke device "${btn.dataset.name}"? This cannot be undone.`)) {
            revokeDevice(btn.dataset.id, btn);
          }
        });
      });
    }
  } catch {
    section.innerHTML += '<p class="admin-error">Failed to load devices</p>';
  }

  content.appendChild(section);
}

async function revokeDevice(deviceId, btn) {
  btn.disabled = true;
  btn.textContent = 'Revoking...';
  try {
    await fetch(`/api/devices/${deviceId}`, { method: 'DELETE' });
    const row = btn.closest('tr');
    if (row) row.remove();
  } catch {
    btn.textContent = 'Failed';
    btn.disabled = false;
  }
}

// --- Audit Log ---

async function renderAuditSection(content) {
  const section = document.createElement('div');
  section.className = 'admin-section';
  section.innerHTML = '<h3>Audit Log</h3>';

  // Filters
  const filters = document.createElement('div');
  filters.className = 'admin-filters';
  filters.innerHTML = `
    <input type="date" class="admin-input" id="audit-from" title="From date" />
    <input type="date" class="admin-input" id="audit-to" title="To date" />
    <button class="admin-btn" id="audit-filter-btn">Filter</button>
  `;
  section.appendChild(filters);

  const tableContainer = document.createElement('div');
  tableContainer.id = 'audit-table-container';
  section.appendChild(tableContainer);

  content.appendChild(section);

  // Load initial data
  await loadAuditLog(tableContainer);

  // Wire filter button
  document.getElementById('audit-filter-btn')?.addEventListener('click', () => {
    loadAuditLog(tableContainer);
  });
}

async function loadAuditLog(container) {
  const from = (document.getElementById('audit-from'))?.value;
  const to = (document.getElementById('audit-to'))?.value;

  let url = '/api/audit-log?limit=50';
  if (from) url += `&from=${from}`;
  if (to) url += `&to=${to}`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();
    const entries = data.entries || [];

    if (entries.length === 0) {
      container.innerHTML = '<p class="admin-empty">No audit entries</p>';
      return;
    }

    const actionColors = { requested: '#60a5fa', approved: '#4ade80', rejected: '#ef4444', expired: '#888', device_revoked: '#f59e0b' };

    const table = buildTable(
      ['Time', 'Action', 'Actor', 'Approval ID'],
      entries.map(e => [
        formatDate(e.created_at),
        `<span style="color:${actionColors[e.action] || '#888'};font-weight:600">${escapeHtml(e.action)}</span>`,
        escapeHtml(e.actor),
        `<code>${escapeHtml(e.approval_id.substring(0, 8))}</code>`,
      ])
    );
    container.innerHTML = '';
    container.appendChild(table);
  } catch {
    container.innerHTML = '<p class="admin-error">Failed to load audit log</p>';
  }
}

// --- Helpers ---

function buildTable(headers, rows) {
  const table = document.createElement('table');
  table.className = 'admin-table';
  table.innerHTML = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = row.map(cell => `<td>${cell}</td>`).join('');
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso + (iso.includes('Z') ? '' : 'Z')).toLocaleString();
}

function formatTimeRemaining(expiresAt) {
  if (!expiresAt) return '';
  const remaining = Math.max(0, Math.floor((new Date(expiresAt + 'Z').getTime() - Date.now()) / 1000));
  if (remaining <= 0) return '<span style="color:#888">Expired</span>';
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
