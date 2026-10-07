/**
 * Diagnostics — Approvals tab.
 *
 * Surfaces the gateway's bounded ring buffer of approval verify rounds
 * (GET /api/diagnostics/approvals/recent) so the human can capture
 * ground-truth bytes for cross-referencing against the iOS side without
 * SSH-grepping prod logs.
 *
 * Polling rules:
 *   - Auto-refresh every 5s while the tab is visible.
 *   - Stops on 404 ("diagnostics disabled") — manual refresh required to
 *     resume, so we don't spam the gateway log when the flag is off.
 *   - Skips fetches when the document is hidden or the view is not active.
 */

import { escapeHtml } from './utils.js';

const API_RECENT = '/api/diagnostics/approvals/recent?limit=20';
const POLL_MS = 5000;
const VIEW_EL_ID = 'diagnostics-view';

// Module-level lifecycle handles. Replaced on every renderDiagnosticsPage()
// call so a fresh navigate-to-diagnostics restarts cleanly.
let pollHandle = null;
let viewObserver = null;
let visibilityListener = null;
let backoffMode = false;
let lastEntries = [];
let expandedId = null;

export async function renderDiagnosticsPage() {
  const container = document.getElementById(VIEW_EL_ID);
  if (!container) return;

  stopPolling();
  backoffMode = false;
  expandedId = null;

  container.innerHTML = `
    <div class="page-content diagnostics-page">
      <div class="diagnostics-header">
        <h2>Diagnostics</h2>
      </div>
      <div class="diagnostics-tabs" role="tablist">
        <button class="diagnostics-tab active" role="tab" aria-selected="true" data-tab="approvals">Approvals</button>
      </div>
      <div class="admin-section diagnostics-panel">
        <div class="diagnostics-toolbar">
          <h3>Approval verify rounds (last 20)</h3>
          <div class="diagnostics-toolbar-actions">
            <span class="diagnostics-status" id="diag-status"></span>
            <button class="admin-btn" id="diag-refresh-btn">Refresh</button>
          </div>
        </div>
        <div id="diag-table-container">
          <p class="admin-empty">Loading\u2026</p>
        </div>
      </div>
      <div id="diag-toast" class="diagnostics-toast" role="status" aria-live="polite"></div>
    </div>
  `;

  document.getElementById('diag-refresh-btn').addEventListener('click', async () => {
    backoffMode = false;
    await refreshNow();
    if (!backoffMode) startPolling();
  });

  observeViewVisibility();
  visibilityListener = () => {
    // No-op — the polling tick itself checks document.visibilityState. Listener
    // kept so we re-tick promptly when the user returns to the tab.
    if (document.visibilityState === 'visible' && !backoffMode && pollHandle === null) {
      startPolling();
    }
  };
  document.addEventListener('visibilitychange', visibilityListener);

  await refreshNow();
  if (!backoffMode) startPolling();
}

function startPolling() {
  stopPolling();
  pollHandle = setInterval(() => {
    if (backoffMode) return;
    if (document.visibilityState !== 'visible') return;
    if (!isViewActive()) return;
    void refreshNow();
  }, POLL_MS);
}

function stopPolling() {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

function isViewActive() {
  const el = document.getElementById(VIEW_EL_ID);
  return !!el && el.classList.contains('active');
}

function observeViewVisibility() {
  const el = document.getElementById(VIEW_EL_ID);
  if (!el) return;

  if (viewObserver) viewObserver.disconnect();
  viewObserver = new MutationObserver(() => {
    if (!isViewActive()) {
      stopPolling();
      if (visibilityListener) {
        document.removeEventListener('visibilitychange', visibilityListener);
        visibilityListener = null;
      }
      viewObserver?.disconnect();
      viewObserver = null;
    }
  });
  viewObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
}

async function refreshNow() {
  const status = document.getElementById('diag-status');
  if (status) status.textContent = '';

  let resp;
  try {
    resp = await fetch(API_RECENT);
  } catch (err) {
    renderError(`Network error: ${err.message}`);
    return;
  }

  if (resp.status === 404) {
    backoffMode = true;
    stopPolling();
    renderDisabledState();
    return;
  }

  if (!resp.ok) {
    renderError(`Endpoint returned ${resp.status}`);
    return;
  }

  let data;
  try {
    data = await resp.json();
  } catch (err) {
    renderError(`Invalid JSON from endpoint: ${err.message}`);
    return;
  }

  const entries = Array.isArray(data?.entries) ? data.entries : [];
  lastEntries = entries;
  renderEntries(entries);
  if (status) {
    const now = new Date().toLocaleTimeString();
    status.textContent = `Last refreshed ${now}`;
  }
}

function renderDisabledState() {
  const container = document.getElementById('diag-table-container');
  if (!container) return;
  container.innerHTML = `
    <div class="diagnostics-empty">
      <p><strong>No approvals captured yet.</strong></p>
      <p>Enable <code>diagnostics_approvals</code> in settings to start capturing.</p>
      <p class="diagnostics-empty-hint">Polling is paused while the flag is off. Click <em>Refresh</em> after enabling the flag to resume.</p>
    </div>
  `;
}

function renderError(msg) {
  const container = document.getElementById('diag-table-container');
  if (!container) return;
  container.innerHTML = `<p class="admin-error">${escapeHtml(msg)}</p>`;
}

function renderEntries(entries) {
  const container = document.getElementById('diag-table-container');
  if (!container) return;

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="diagnostics-empty">
        <p>No approval rounds in the buffer yet.</p>
        <p class="diagnostics-empty-hint">Trigger a tool that requires approval and refresh.</p>
      </div>
    `;
    return;
  }

  const table = document.createElement('table');
  table.className = 'admin-table diagnostics-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Time</th>
        <th>MCP / Tool</th>
        <th>Device</th>
        <th>Verify</th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');

  for (const entry of entries) {
    const row = document.createElement('tr');
    row.className = 'diagnostics-row';
    row.dataset.approvalId = entry.approval_id;
    row.innerHTML = `
      <td>${escapeHtml(formatTime(entry.created_at))}</td>
      <td>${escapeHtml(entry.mcp_name)} / ${escapeHtml(entry.tool_name)}</td>
      <td><code>${escapeHtml(truncate(entry.device_id, 8))}</code></td>
      <td>${entry.verify_result
        ? '<span class="diagnostics-pass">\u2713</span>'
        : '<span class="diagnostics-fail">\u2717</span>'}</td>
    `;
    row.addEventListener('click', () => toggleDetail(entry.approval_id));
    tbody.appendChild(row);

    if (entry.approval_id === expandedId) {
      const detailRow = buildDetailRow(entry);
      tbody.appendChild(detailRow);
    }
  }

  table.appendChild(tbody);
  container.innerHTML = '';
  container.appendChild(table);
}

function toggleDetail(approvalId) {
  expandedId = expandedId === approvalId ? null : approvalId;
  renderEntries(lastEntries);
}

function buildDetailRow(entry) {
  const row = document.createElement('tr');
  row.className = 'diagnostics-detail-row';
  const cell = document.createElement('td');
  cell.colSpan = 4;
  cell.appendChild(buildDetailPanel(entry));
  row.appendChild(cell);
  return row;
}

function buildDetailPanel(entry) {
  const panel = document.createElement('div');
  panel.className = 'diagnostics-detail';

  const fieldRows = [
    ['approval_id', entry.approval_id],
    ['created_at', entry.created_at],
    ['device_id', entry.device_id],
    ['agent_display_name', entry.agent_display_name ?? '(unknown agent)'],
    ['profile_display_name', entry.profile_display_name ?? '(unknown profile)'],
    ['mcp', `${entry.mcp_name} / ${entry.tool_name}`],
    ['nonce_hex', entry.nonce_hex],
    ['action_hash_hex', entry.action_hash_hex],
    ['action', entry.action],
    ['payload_utf8', entry.payload_utf8],
    ['payload_sha256_hex', entry.payload_sha256_hex],
    ['pubkey_base64', entry.pubkey_base64],
    ['pubkey_bytes_length', String(entry.pubkey_bytes_length)],
    ['is_raw_x963', String(entry.is_raw_x963)],
    ['signature_base64', entry.signature_base64],
    ['signature_der_length', String(entry.signature_der_length)],
    ['verify_result', String(entry.verify_result)],
    ['failure_reason', entry.failure_reason ?? 'n/a'],
  ];

  const dl = document.createElement('dl');
  dl.className = 'diagnostics-detail-fields';
  for (const [label, value] of fieldRows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  panel.appendChild(dl);

  const actions = document.createElement('div');
  actions.className = 'diagnostics-detail-actions';

  const copyGroundBtn = document.createElement('button');
  copyGroundBtn.className = 'admin-btn';
  copyGroundBtn.textContent = 'Copy ground truth';
  copyGroundBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void copyToClipboard(formatGroundTruth(entry));
  });

  const copyJsonBtn = document.createElement('button');
  copyJsonBtn.className = 'admin-btn';
  copyJsonBtn.textContent = 'Copy all fields as JSON';
  copyJsonBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void copyToClipboard(JSON.stringify(entry, null, 2));
  });

  actions.appendChild(copyGroundBtn);
  actions.appendChild(copyJsonBtn);
  panel.appendChild(actions);

  panel.addEventListener('click', (ev) => ev.stopPropagation());
  return panel;
}

/**
 * EXACT format from the #637 ticket — pasted verbatim into GitHub comments
 * for cross-reference with iOS-side blocks. Do not reorder or relabel.
 */
function formatGroundTruth(e) {
  return [
    `approval: ${e.approval_id}`,
    `device_id: ${e.device_id}`,
    `mcp: ${e.mcp_name} / ${e.tool_name}`,
    `nonce: ${e.nonce_hex}`,
    `action_hash: ${e.action_hash_hex}`,
    `action: ${e.action}`,
    `payload: ${e.payload_utf8}`,
    `payload_sha256: ${e.payload_sha256_hex}`,
    `pubkey (base64, raw X9.63): ${e.pubkey_base64}`,
    `pubkey_bytes: ${e.pubkey_bytes_length} is_raw_x963: ${e.is_raw_x963}`,
    `signature (base64, DER): ${e.signature_base64}`,
    `sig_der_bytes: ${e.signature_der_length}`,
    `verify_result: ${e.verify_result}`,
    `failure_reason: ${e.failure_reason ?? 'n/a'}`,
  ].join('\n');
}

async function copyToClipboard(text) {
  if (!navigator.clipboard?.writeText) {
    showToast('Copy failed — clipboard API unavailable', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied \u2713', false);
  } catch {
    showToast('Copy failed — fallback to manual select', true);
  }
}

function showToast(text, isError) {
  const toast = document.getElementById('diag-toast');
  if (!toast) return;
  toast.textContent = text;
  toast.classList.toggle('error', !!isError);
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2000);
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString();
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '\u2026' : s;
}
