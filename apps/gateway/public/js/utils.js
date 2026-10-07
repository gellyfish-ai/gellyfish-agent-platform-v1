export function pushUrl(path) {
  if (window.location.pathname !== path) {
    history.pushState(null, '', path);
  }
}

/** Build a URL for a view + optional params. Single source of truth for all URL construction. */
export function urlFor(view, params = {}) {
  if (view === 'chat' && params.sessionId) return `/session/${params.sessionId}`;
  if (view === 'crews' && params.crewId) return `/crews/${params.crewId}`;
  if (view === 'conversations') return '/conversations';
  if (view === 'sessions') return '/sessions';
  if (view === 'profiles') return '/profiles';
  if (view === 'crews') return '/crews';
  if (view === 'credentials') return '/credentials';
  if (view === 'mcps') return '/mcps';
  if (view === 'approvals') return '/approvals';
  return '/';
}

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function formatSessionDate(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: now.getFullYear() !== date.getFullYear() ? 'numeric' : undefined,
  });
}

export function truncate(str, len = 80) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '\u2026' : str;
}

export const toolIcons = {
  Bash: '\uD83D\uDCBB',
  Edit: '\u270F\uFE0F',
  Write: '\uD83D\uDCDD',
  Read: '\uD83D\uDCD6',
  Glob: '\uD83D\uDD0D',
  Grep: '\uD83D\uDD0E',
  WebFetch: '\uD83C\uDF10',
  WebSearch: '\uD83D\uDD0D',
  default: '\uD83D\uDEE0\uFE0F',
};

export function getToolIcon(toolName) {
  return toolIcons[toolName] || toolIcons.default;
}

const ISSUE_LINK_PREFIXES = {
  GAP: 'https://github.com/gellyfish-ai/Gellyfish-Agent-Platform/issues',
  HQ: 'https://github.com/gellyfish-ai/gellyfish-hq/issues',
};

/**
 * Replace PREFIX#123 with markdown links, skipping code blocks/spans.
 * Splits on code fences and inline backticks to avoid replacing inside code.
 */
function autoLinkIssueRefs(text) {
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(/\b([A-Z]+)#(\d+)\b/g, (match, prefix, num) => {
      const base = ISSUE_LINK_PREFIXES[prefix];
      if (!base) return match;
      return '[' + prefix + '#' + num + '](' + base + '/' + num + ')';
    });
  }
  return parts.join('');
}

export function renderMarkdown(text) {
  if (typeof marked !== 'undefined') {
    const html = marked.parse(autoLinkIssueRefs(text));
    // Post-process: add target=_blank to all external links via DOM manipulation.
    // This is version-agnostic — works regardless of marked renderer API changes.
    const temp = document.createElement('div');
    temp.innerHTML = html;
    temp.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    });
    return temp.innerHTML;
  }
  return escapeHtml(text).replace(/\n/g, '<br>');
}

export const copyIcon = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
export const checkIcon = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';

// --- Shared API helpers ---

export async function fetchProfiles() {
  const resp = await fetch('/api/profiles');
  const data = await resp.json();
  return data.profiles || [];
}

export function addCopyButtons(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.innerHTML = copyIcon;
    btn.title = 'Copy';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const code = pre.querySelector('code')?.textContent || pre.textContent;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(code).then(() => {
          btn.innerHTML = checkIcon;
          btn.classList.add('copied');
          setTimeout(() => { btn.innerHTML = copyIcon; btn.classList.remove('copied'); }, 2000);
        });
      } else {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.innerHTML = checkIcon;
        btn.classList.add('copied');
        setTimeout(() => { btn.innerHTML = copyIcon; btn.classList.remove('copied'); }, 2000);
      }
    });
    pre.appendChild(btn);
  });
}
