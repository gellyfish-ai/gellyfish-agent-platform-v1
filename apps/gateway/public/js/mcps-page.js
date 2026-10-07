import { escapeHtml } from './utils.js';

export async function renderMcpsPage() {
  const container = document.getElementById('mcps-view');
  if (!container) return;

  container.innerHTML = '<div class="page-content"><h2>MCP Servers</h2><p class="loading">Loading...</p></div>';

  try {
    const resp = await fetch('/api/mcps');
    const data = await resp.json();
    const mcps = data.mcps || [];

    const content = container.querySelector('.page-content');
    content.innerHTML = '<h2>MCP Servers</h2>';

    if (mcps.length === 0) {
      content.innerHTML += '<p>No MCP servers configured.</p>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'mcps-grid';

    for (const mcp of mcps) {
      const card = document.createElement('div');
      card.className = 'mcp-card';

      // Health dot
      let healthDot = '<span class="mcp-health grey" title="Local (no health check)"></span>';
      if (mcp.healthy === true) {
        healthDot = '<span class="mcp-health green" title="Reachable"></span>';
      } else if (mcp.healthy === false) {
        healthDot = '<span class="mcp-health red" title="Unreachable"></span>';
      }

      // Type badge
      const typeBadge = mcp.type === 'global'
        ? '<span class="mcp-type-badge global">global</span>'
        : '<span class="mcp-type-badge available">available</span>';

      // Command preview
      let argsPreview = '';
      try {
        const args = JSON.parse(mcp.args || '[]');
        if (args.length > 0) argsPreview = ' ' + args.join(' ');
      } catch {}
      const cmdPreview = (mcp.command + argsPreview).substring(0, 120);

      // Profile badges
      let profilesHtml = '';
      if (mcp.profiles && mcp.profiles.length > 0) {
        profilesHtml = '<div class="mcp-profiles">' +
          mcp.profiles.map(p =>
            `<span class="mcp-profile-badge" title="${escapeHtml(p.name)}">${p.icon} ${escapeHtml(p.name)}</span>`
          ).join('') + '</div>';
      }

      // Env keys (with keychain indicator)
      let envHtml = '';
      if (mcp.envKeys && mcp.envKeys.length > 0) {
        const keychainKeys = new Set(mcp.envKeychainKeys || []);
        envHtml = `<div class="mcp-env">${mcp.envKeys.map(k => {
          const icon = keychainKeys.has(k) ? '<span title="Resolved from macOS Keychain">\uD83D\uDD10</span> ' : '';
          return `<span class="mcp-env-key">${icon}${escapeHtml(k)}</span>`;
        }).join('')}</div>`;
      }

      card.innerHTML = `
        <div class="mcp-card-header">
          ${healthDot}
          <span class="mcp-card-name">${escapeHtml(mcp.name)}</span>
          ${typeBadge}
        </div>
        <div class="mcp-card-cmd">${escapeHtml(cmdPreview)}</div>
        ${envHtml}
        ${profilesHtml}
      `;

      grid.appendChild(card);
    }

    content.appendChild(grid);
  } catch (err) {
    container.querySelector('.page-content').innerHTML = `<h2>MCP Servers</h2><p class="error">Failed to load: ${escapeHtml(String(err))}</p>`;
  }
}
