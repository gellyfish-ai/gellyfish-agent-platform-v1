/**
 * Credentials view — manage keychain credentials via the gateway API.
 * Layer 5 (view): imports from layers 0-4 only. Never imports from other views.
 */

import { escapeHtml } from './utils.js';

const ICON_DELETE = (size = 14) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>`;

async function fetchCredentials() {
  const resp = await fetch('/api/credentials');
  const data = await resp.json();
  return data.credentials || [];
}

async function addCredential(service, account, password) {
  const resp = await fetch('/api/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, account, password }),
  });
  return resp.json();
}

async function deleteCredential(service, account) {
  if (!confirm(`Delete credential for ${service} / ${account}?`)) return false;
  const resp = await fetch(`/api/credentials/${encodeURIComponent(service)}/${encodeURIComponent(account)}`, {
    method: 'DELETE',
  });
  return resp.ok;
}

export async function renderCredentialsPage() {
  const container = document.getElementById('credentials-view');
  container.innerHTML = '<div class="credentials-page"><div class="sessions-loading">Loading credentials...</div></div>';
  const reload = () => renderCredentialsPage();

  try {
    const credentials = await fetchCredentials();

    let html = '<div class="credentials-page">';
    html += `<div class="credentials-page-header">
      <h2>Credentials</h2>
    </div>`;

    // Add form
    html += `<div class="credential-form" id="credential-form">
      <div class="credential-form-row">
        <input type="text" id="cred-service" placeholder="Service name (e.g. gmail, github)" autocomplete="off" />
        <input type="text" id="cred-account" placeholder="Account / username" autocomplete="off" />
        <input type="password" id="cred-password" placeholder="Password" autocomplete="new-password" />
        <button class="credential-add-btn" id="cred-add-btn">Add</button>
      </div>
      <div class="credential-form-hint">Stored securely in the macOS automation keychain. Passwords never appear in chat sessions.</div>
    </div>`;

    html += '<div id="credentials-list"></div>';
    html += '</div>';
    container.innerHTML = html;

    // Render list
    const listEl = document.getElementById('credentials-list');

    if (credentials.length === 0) {
      listEl.innerHTML = `<div class="credentials-empty">
        <h3>No credentials yet</h3>
        <p>Add credentials above so your AI profiles can access services securely.</p>
      </div>`;
    } else {
      const table = document.createElement('table');
      table.className = 'credentials-table';
      table.innerHTML = `<thead><tr><th>Service</th><th>Account</th><th></th></tr></thead>`;
      const tbody = document.createElement('tbody');

      for (const cred of credentials) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${escapeHtml(cred.service)}</td>
          <td>${escapeHtml(cred.account)}</td>
          <td class="credentials-actions">
            <button class="credential-delete-btn" title="Delete">${ICON_DELETE()}</button>
          </td>
        `;
        tr.querySelector('.credential-delete-btn').addEventListener('click', async () => {
          if (await deleteCredential(cred.service, cred.account)) reload();
        });
        tbody.appendChild(tr);
      }

      table.appendChild(tbody);
      listEl.appendChild(table);
    }

    // Wire add button
    const addBtn = document.getElementById('cred-add-btn');
    const serviceInput = document.getElementById('cred-service');
    const accountInput = document.getElementById('cred-account');
    const passwordInput = document.getElementById('cred-password');

    async function handleAdd() {
      const service = serviceInput.value.trim();
      const account = accountInput.value.trim();
      const password = passwordInput.value;

      if (!service || !account || !password) return;

      addBtn.disabled = true;
      addBtn.textContent = 'Adding...';

      try {
        const result = await addCredential(service, account, password);
        if (result.error) {
          alert(result.error);
        } else {
          // Clear form and reload
          serviceInput.value = '';
          accountInput.value = '';
          passwordInput.value = '';
          reload();
        }
      } catch {
        alert('Failed to add credential');
      } finally {
        addBtn.disabled = false;
        addBtn.textContent = 'Add';
      }
    }

    addBtn.addEventListener('click', handleAdd);
    passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAdd();
    });

  } catch (error) {
    console.error('Failed to load credentials:', error);
    container.innerHTML = '<div class="credentials-page"><div class="credentials-empty"><h3>Failed to load credentials</h3></div></div>';
  }
}
