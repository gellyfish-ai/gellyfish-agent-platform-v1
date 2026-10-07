/**
 * Process Manager — standalone process that owns Claude CLI child processes.
 *
 * Survives gateway restarts. Gateway talks to it over a Unix domain socket.
 * Handles: spawn, inject, kill, cancel, list, subscribe.
 *
 * No queuing — Claude CLI handles stdin queuing natively via stream-json.
 *
 * Run separately: tsx src/process-manager.ts
 */

import { createServer, Socket } from 'net';
import { spawn, ChildProcess, execSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const LOG_DIR = join(DATA_DIR, 'logs');
mkdirSync(LOG_DIR, { recursive: true });

const SOCKET_PATH = process.env.PM_SOCKET || join(DATA_DIR, 'gellyfish-pm.sock');
const PID_PATH = join(DATA_DIR, 'gellyfish-pm.pid');

const logStream = createWriteStream(join(LOG_DIR, 'process-manager.log'), { flags: 'a' });

function log(level: string, msg: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...data });
  process.stdout.write(line + '\n');
  logStream.write(line + '\n');
}

// --- Managed process state ---

interface ManagedProcess {
  process: ChildProcess;
  sessionId: string;
  profileId?: string;
  pid: number;
  buffer: string;
  subscribers: Set<Socket>;
  pendingControlRequests: Map<string, Record<string, unknown>>; // request_id -> event
}

const processes = new Map<string, ManagedProcess>();

// --- Gateway connections ---

const gatewayConnections = new Set<Socket>();

function sendTo(socket: Socket, msg: Record<string, unknown>) {
  if (!socket.destroyed) {
    socket.write(JSON.stringify(msg) + '\n');
  }
}

function broadcastToSubscribers(sessionId: string, event: Record<string, unknown>) {
  const managed = processes.get(sessionId);
  if (!managed) return;

  // Buffer control_requests — if no subscribers are alive, the event would be lost
  // and the Claude process would hang forever waiting for a permission response.
  if (event.event === 'stdout') {
    const data = event.data as Record<string, unknown>;
    if (data?.type === 'control_request') {
      const requestId = data.request_id as string;
      managed.pendingControlRequests.set(requestId, data);
      log('info', '[buffer] control_request buffered', { sessionId, requestId, tool: (data.request as Record<string, unknown>)?.tool_name });
    }
    // Clear buffer when we see a control_response was processed (tool result comes back)
    if (data?.type === 'user') {
      const content = (data.message as Record<string, unknown>)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if ((block as Record<string, unknown>).type === 'tool_result') {
            // A tool result means the permission was resolved — clear that request
            managed.pendingControlRequests.clear();
          }
        }
      }
    }
  }

  // Clean dead sockets and broadcast
  const deadSockets: Socket[] = [];
  for (const sub of managed.subscribers) {
    if (sub.destroyed) {
      deadSockets.push(sub);
    } else {
      sendTo(sub, { type: 'event', sessionId, ...event });
    }
  }
  for (const dead of deadSockets) {
    managed.subscribers.delete(dead);
  }
}

// --- Process stdout/stderr/close handling ---

function setupProcessHandlers(managed: ManagedProcess) {
  const { process: proc, sessionId } = managed;

  proc.stdout?.on('data', (data: Buffer) => {
    managed.buffer += data.toString();
    const lines = managed.buffer.split('\n');
    managed.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        broadcastToSubscribers(sessionId, { event: 'stdout', data: parsed });

        // Log every event type so we can see what Claude CLI sends
        log('info', '[stdout]', { sessionId, type: parsed.type, subtype: parsed.subtype, hasUsage: !!parsed.usage, keys: Object.keys(parsed).slice(0, 8) });

        if (parsed.type === 'result') {
          log('info', '[process] result received', { sessionId });
        }
      } catch {
        broadcastToSubscribers(sessionId, { event: 'stdout_raw', data: line });
      }
    }
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      log('warn', '[process] stderr', { sessionId, text: text.substring(0, 500) });
      broadcastToSubscribers(sessionId, { event: 'stderr', data: text });
    }
  });

  proc.on('close', (code) => {
    log('info', '[process] closed', { sessionId, code, pid: managed.pid });
    broadcastToSubscribers(sessionId, { event: 'close', code });
    processes.delete(sessionId);
  });

  proc.on('error', (err) => {
    log('error', '[process] error', { sessionId, error: err.message, pid: managed.pid });
    broadcastToSubscribers(sessionId, { event: 'error', message: err.message });
    processes.delete(sessionId);
  });
}

// --- Command handlers ---

function handleSpawn(msg: Record<string, unknown>, socket: Socket) {
  const { id, sessionId, profileId, args, cwd } = msg as {
    id: string; sessionId: string; profileId?: string; args: string[]; cwd: string;
  };

  if (processes.has(sessionId)) {
    const existing = processes.get(sessionId)!;
    if (existing.process && !existing.process.killed) {
      sendTo(socket, { id, type: 'response', ok: true, pid: existing.pid, existing: true });
      log('info', '[spawn] reusing existing process', { sessionId, pid: existing.pid });
      return;
    }
    processes.delete(sessionId);
  }

  const claudePath = (() => {
    try { return execSync('which claude', { encoding: 'utf-8' }).trim(); }
    catch { return 'claude'; }
  })();

  const { CLAUDECODE, ...cleanEnv } = process.env;
  const proc = spawn(claudePath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: cleanEnv,
    cwd,
  });

  const pid = proc.pid!;
  const managed: ManagedProcess = {
    process: proc,
    sessionId,
    profileId,
    pid,
    buffer: '',
    subscribers: new Set(),
    pendingControlRequests: new Map(),
  };

  processes.set(sessionId, managed);
  setupProcessHandlers(managed);

  log('info', '[spawn] new process', { sessionId, profileId, pid, cwd });
  sendTo(socket, { id, type: 'response', ok: true, pid });
}

function handleInject(msg: Record<string, unknown>, socket: Socket) {
  const { id, sessionId, message } = msg as { id: string; sessionId: string; message: string };
  const managed = processes.get(sessionId);

  if (!managed || managed.process.killed) {
    sendTo(socket, { id, type: 'response', ok: false, error: `No alive process for session ${sessionId}` });
    return;
  }

  // If this is a control_response, clear the buffered control_request
  try {
    const parsed = JSON.parse(message);
    if (parsed.type === 'control_response') {
      const requestId = parsed.response?.request_id;
      if (requestId && managed.pendingControlRequests.has(requestId)) {
        managed.pendingControlRequests.delete(requestId);
        log('info', '[inject] cleared buffered control_request', { sessionId, requestId });
      }
    }
  } catch { /* not JSON or no request_id — fine */ }

  try {
    managed.process.stdin?.write(message + '\n');
    log('info', '[inject] delivered', { sessionId, pid: managed.pid, contentPreview: message.substring(0, 200) });
    sendTo(socket, { id, type: 'response', ok: true });
  } catch (err) {
    log('error', '[inject] stdin write failed', { sessionId, error: String(err) });
    sendTo(socket, { id, type: 'response', ok: false, error: String(err) });
  }
}

function handleKill(msg: Record<string, unknown>, socket: Socket) {
  const { id, sessionId } = msg as { id: string; sessionId: string };
  const managed = processes.get(sessionId);

  if (!managed) {
    sendTo(socket, { id, type: 'response', ok: false, error: 'No process found' });
    return;
  }

  log('info', '[kill] SIGTERM', { sessionId, pid: managed.pid });
  managed.process.kill('SIGTERM');
  sendTo(socket, { id, type: 'response', ok: true });
}

function handleCancel(msg: Record<string, unknown>, socket: Socket) {
  const { id, sessionId } = msg as { id: string; sessionId: string };
  const managed = processes.get(sessionId);

  if (!managed || managed.process.killed) {
    sendTo(socket, { id, type: 'response', ok: false, error: 'No alive process found' });
    return;
  }

  // Send cancel to stdin — interrupts the current turn, same as ESC in Claude Code CLI.
  // Process stays alive, session preserved, ready for next message.
  log('info', '[cancel] sending cancel to stdin', { sessionId, pid: managed.pid });
  try {
    managed.process.stdin?.write(JSON.stringify({ type: 'user_message', content: '/cancel' }) + '\n');
    sendTo(socket, { id, type: 'response', ok: true });
  } catch (err) {
    log('error', '[cancel] failed to send cancel', { sessionId, error: String(err) });
    sendTo(socket, { id, type: 'response', ok: false, error: String(err) });
  }
}

function handleList(msg: Record<string, unknown>, socket: Socket) {
  const { id } = msg as { id: string };
  const list = [...processes.values()].map(m => ({
    sessionId: m.sessionId,
    profileId: m.profileId,
    pid: m.pid,
    alive: !m.process.killed,
  }));
  sendTo(socket, { id, type: 'response', ok: true, processes: list });
}

function handleSubscribe(msg: Record<string, unknown>, socket: Socket) {
  const { id, sessionId } = msg as { id: string; sessionId: string };
  const managed = processes.get(sessionId);
  if (!managed) {
    sendTo(socket, { id, type: 'response', ok: false, error: 'No process found' });
    return;
  }
  managed.subscribers.add(socket);
  log('info', '[subscribe]', { sessionId, subscriberCount: managed.subscribers.size });
  sendTo(socket, { id, type: 'response', ok: true });

  // Replay any buffered control_requests that were missed during subscriber gap.
  // This prevents Claude processes from hanging forever on lost permission requests.
  if (managed.pendingControlRequests.size > 0) {
    log('info', '[subscribe] replaying buffered control_requests', { sessionId, count: managed.pendingControlRequests.size });
    for (const [requestId, data] of managed.pendingControlRequests) {
      sendTo(socket, { type: 'event', sessionId, event: 'stdout', data });
    }
  }
}

function handleUnsubscribe(msg: Record<string, unknown>, socket: Socket) {
  const { id, sessionId } = msg as { id: string; sessionId: string };
  const managed = processes.get(sessionId);
  if (managed) {
    managed.subscribers.delete(socket);
    log('info', '[unsubscribe]', { sessionId, subscriberCount: managed.subscribers.size });
  }
  sendTo(socket, { id, type: 'response', ok: true });
}

// --- Socket server ---

function handleMessage(line: string, socket: Socket) {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    log('error', '[socket] unparseable message', { line });
    return;
  }

  switch (msg.type) {
    case 'spawn': handleSpawn(msg, socket); break;
    case 'inject': handleInject(msg, socket); break;
    case 'kill': handleKill(msg, socket); break;
    case 'cancel': handleCancel(msg, socket); break;
    case 'list': handleList(msg, socket); break;
    case 'subscribe': handleSubscribe(msg, socket); break;
    case 'unsubscribe': handleUnsubscribe(msg, socket); break;
    default:
      log('warn', '[socket] unknown message type', { type: msg.type });
      sendTo(socket, { id: msg.id, type: 'response', ok: false, error: `Unknown type: ${msg.type}` });
  }
}

function startServer() {
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch { /* */ }
  }

  const server = createServer((socket: Socket) => {
    log('info', '[socket] gateway connected');
    gatewayConnections.add(socket);

    let buffer = '';
    socket.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) handleMessage(line, socket);
      }
    });

    socket.on('close', () => {
      log('info', '[socket] gateway disconnected');
      gatewayConnections.delete(socket);
      for (const managed of processes.values()) {
        managed.subscribers.delete(socket);
      }
    });

    socket.on('error', (err) => {
      log('error', '[socket] connection error', { error: err.message });
    });
  });

  server.listen(SOCKET_PATH, () => {
    log('info', '[startup] listening', { socket: SOCKET_PATH });
  });

  server.on('error', (err) => {
    log('error', '[startup] failed to bind socket', { error: err.message, socket: SOCKET_PATH });
    process.exit(1);
  });

  return server;
}

// --- Startup ---

function detectOrphanedClaudeProcesses(): number[] {
  try {
    const output = execSync(
      'pgrep -f "claude.*--permission-prompt-tool stdio" 2>/dev/null || true',
      { encoding: 'utf-8' },
    ).trim();

    if (!output) return [];
    const pids = output.split('\n').filter(Boolean).map(p => parseInt(p, 10));
    if (pids.length === 0) return [];

    log('warn', `[startup] detected ${pids.length} orphan Claude processes — user must decide`, { pids });
    return pids;
  } catch { /* pgrep unavailable */ return []; }
}

function shutdown(signal: string) {
  log('info', `[shutdown] ${signal} received`, { processCount: processes.size });

  for (const managed of processes.values()) {
    if (!managed.process.killed) {
      log('info', '[shutdown] killing process', { sessionId: managed.sessionId, pid: managed.pid });
      managed.process.kill('SIGTERM');
    }
  }

  try { unlinkSync(SOCKET_PATH); } catch { /* */ }
  try { unlinkSync(PID_PATH); } catch { /* */ }

  setTimeout(() => process.exit(0), 500);
}

writeFileSync(PID_PATH, String(process.pid));
log('info', '[startup] process manager starting', { pid: process.pid });

detectOrphanedClaudeProcesses();
startServer();

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
