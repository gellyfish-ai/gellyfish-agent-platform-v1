import state, { setProcessing } from './state.js';

let connectionLogEl = null;
let connectionLogEntries = null;
let statusEl = null;

export function initConnection() {
  connectionLogEl = document.getElementById('connection-log');
  connectionLogEntries = document.getElementById('connection-log-entries');
  statusEl = document.getElementById('status');
}

export function toggleConnectionLog() {
  if (!connectionLogEl) return;
  connectionLogEl.classList.toggle('hidden');
}

export function connLog(msg, level = 'info') {
  if (!connectionLogEntries) return;
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + level;
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${msg}</span>`;
  connectionLogEntries.appendChild(entry);
  while (connectionLogEntries.children.length > 50) {
    connectionLogEntries.firstChild.remove();
  }
  if (connectionLogEl) connectionLogEl.scrollTop = connectionLogEl.scrollHeight;
}

export function setStatus(text, connected) {
  if (!statusEl) return;
  statusEl.textContent = text;
  const s = connected ? 'connected' : (text.includes('onnecting') ? 'connecting' : 'disconnected');
  statusEl.className = 'status ' + s;
}

// onMessage callback — wired by app.js to avoid circular deps
let onMessageCallback = null;
export function setOnMessage(cb) {
  onMessageCallback = cb;
}

export function cancelProcessing() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type: 'cancel' }));
  connLog('Sent interrupt (cancel)');
  setProcessing(false);
}

/** Close the current WebSocket and bump connectionId to prevent reconnect loops */
export function disconnect() {
  state.connectionId++;
  if (state.ws) { state.ws.close(); state.ws = null; }
}

export function connect(resumeId = null) {
  state.connectingInProgress = true;
  state.resumeSessionId = resumeId;
  state.connectionId++;
  const currentConnectionId = state.connectionId;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let wsUrl = `${protocol}//${window.location.host}/api/chat/ws`;
  const params = new URLSearchParams();
  if (resumeId) params.set('sessionId', resumeId);
  if (state.activeAgentId) params.set('agentId', state.activeAgentId);
  if (state.activeProfileId) params.set('profileId', state.activeProfileId);
  params.set('_t', Date.now().toString());
  wsUrl += '?' + params.toString();

  // Loud warning: connecting with a profileId but no sessionId means the frontend lost track
  if (state.activeProfileId && !resumeId) {
    console.warn(`[SESSION WARNING] Connecting with profileId=${state.activeProfileId} but NO sessionId. Backend will check DB for existing session.`);
    connLog(`WARNING: No session ID for profile — backend will try to recover from DB`, 'warn');
  }

  setStatus('Connecting...', false);
  connLog(`Opening WebSocket to ${window.location.host}...`);
  if (resumeId) connLog(`Resuming session ${resumeId.substring(0, 8)}...`);

  console.log('Connecting to:', wsUrl, 'connectionId:', currentConnectionId);
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    console.log('WebSocket connected, connectionId:', currentConnectionId);
    state.connectingInProgress = false;
    state.reconnectAttempts = 0;
    setStatus('Connected', true);
    connLog('WebSocket open \u2014 waiting for Claude...');
  };

  state.ws.onclose = (event) => {
    console.log('WebSocket closed, connectionId:', currentConnectionId, 'current:', state.connectionId);
    state.connectingInProgress = false;
    if (state.keepaliveInterval) {
      clearInterval(state.keepaliveInterval);
      state.keepaliveInterval = null;
    }
    const reason = event.reason || `code ${event.code}`;
    connLog(`WebSocket closed (${reason})`, 'warn');
    if (currentConnectionId === state.connectionId) {
      state.reconnectAttempts++;
      const delay = Math.min(3000 * Math.pow(1.5, state.reconnectAttempts - 1), 30000);
      const delaySec = (delay / 1000).toFixed(1);
      setStatus('Reconnecting...', false);
      connLog(`Will reconnect in ${delaySec}s (attempt ${state.reconnectAttempts})...`);
      setTimeout(() => connect(state.sessionId || state.resumeSessionId), delay);
    } else {
      setStatus('Disconnected', false);
    }
  };

  state.keepaliveInterval = setInterval(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30000);

  state.ws.onerror = () => {
    connLog('WebSocket error \u2014 server may be unreachable', 'error');
  };

  state.ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (onMessageCallback) onMessageCallback(data);
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  };
}
