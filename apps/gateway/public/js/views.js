/**
 * Views — central view registry for SPA navigation.
 * Layer 3: pure view management. No WS, no session logic.
 *
 * Every page-level view is registered here. Adding a new view means
 * adding one entry to VIEWS — no if/else chains anywhere else.
 */

import state from './state.js';
import { pushUrl, urlFor } from './utils.js';

/**
 * View registry. Each entry defines:
 *   id       — short name used in navigateTo('profiles')
 *   path     — URL path prefix (matched by initFromUrl)
 *   elId     — DOM element ID
 *   render   — async function to render content (null = no-op, e.g. chat)
 *   isChatView — if true, uses 'hidden' class instead of 'active'
 */
const VIEWS = [
  {
    id: 'chat',
    path: '/',
    elId: 'chat-view',
    render: null,
    isChatView: true,
  },
  {
    id: 'sessions',
    path: '/sessions',
    elId: 'sessions-view',
    render: () => import('./sessions.js').then(m => m.renderSessionsPage()),
  },
  {
    id: 'conversations',
    path: '/conversations',
    elId: 'conversations-view',
    render: () => import('./conversations.js').then(m => m.renderConversationsPage()),
  },
  {
    id: 'profiles',
    path: '/profiles',
    elId: 'profiles-view',
    render: () => import('./profiles.js').then(m => m.renderProfilesPage()),
  },
  {
    id: 'crews',
    path: '/crews',
    elId: 'crews-view',
    render: (params) => import('./crews.js').then(m => {
      m.renderCrewsPage();
      if (params?.crewId) m.renderCrewDetail(params.crewId);
    }),
  },
  {
    id: 'credentials',
    path: '/credentials',
    elId: 'credentials-view',
    render: () => import('./credentials.js').then(m => m.renderCredentialsPage()),
  },
  {
    id: 'mcps',
    path: '/mcps',
    elId: 'mcps-view',
    render: () => import('./mcps-page.js').then(m => m.renderMcpsPage()),
  },
  {
    id: 'approvals',
    path: '/approvals',
    elId: 'approvals-view',
    render: () => import('./approvals-page.js').then(m => m.renderApprovalsPage()),
  },
  {
    id: 'diagnostics',
    path: '/diagnostics',
    elId: 'diagnostics-view',
    render: () => import('./diagnostics-approvals.js').then(m => m.renderDiagnosticsPage()),
  },
];

const appMenuItems = document.querySelectorAll('.app-menu-item');

/** Hide all views — resets every view to its hidden state. */
export function hideAllViews() {
  for (const view of VIEWS) {
    const el = document.getElementById(view.elId);
    if (!el) continue;
    if (view.isChatView) {
      el.classList.add('hidden');
    } else {
      el.classList.remove('active');
    }
  }
}

/** DOM-only view switch — no URL push, no content rendering. */
export function showView(viewId) {
  state.currentView = viewId;
  appMenuItems.forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewId && viewId !== 'chat' && viewId !== 'new-chat');
  });
  // renderTabs is called lazily — the caller (app.js) wires this up
  if (_onShowView) _onShowView();
  hideAllViews();

  const viewDef = VIEWS.find(v => v.id === viewId);
  if (!viewDef) return;

  const el = document.getElementById(viewDef.elId);
  if (!el) return;

  if (viewDef.isChatView) {
    el.classList.remove('hidden');
  } else {
    el.classList.add('active');
  }
}

/** Navigate to a view — switches DOM, renders content, pushes URL. */
export function navigateTo(viewId, params = {}) {
  showView(viewId);
  pushUrl(urlFor(viewId, params));

  const viewDef = VIEWS.find(v => v.id === viewId);
  if (viewDef?.render) {
    viewDef.render(params);
  }
}

/**
 * Sync internal state to the browser's current URL.
 * Returns { viewId, params } so the caller can handle session resume / connect.
 */
export function initFromUrl() {
  const path = window.location.pathname;

  // Special routes with params
  const sessionMatch = path.match(/^\/session\/([0-9a-f-]+)$/);
  if (sessionMatch) {
    return { viewId: 'chat', params: { sessionId: sessionMatch[1] } };
  }

  const crewMatch = path.match(/^\/crews\/([^/]+)$/);
  if (crewMatch) {
    return { viewId: 'crews', params: { crewId: crewMatch[1] } };
  }

  // Match static paths from the registry
  for (const view of VIEWS) {
    if (view.isChatView) continue; // chat is the fallback
    if (path === view.path) {
      return { viewId: view.id, params: {} };
    }
  }

  // Default: chat
  return { viewId: 'chat', params: {} };
}

// Callback for renderTabs — set by app.js to avoid circular imports
let _onShowView = null;
export function setOnShowView(fn) {
  _onShowView = fn;
}
