import { WebSocket } from 'ws';
import db from '../db/index.js';
import type { ManagedProcess } from '../session-send.js';
import { getActiveProcess, getAllActiveProcesses } from '../session-send.js';
import { formatUserMessage } from '../session-send.js';
import { pmClient } from '../pm-client.js';
import { logger } from '../logger.js';

export function sendToSocket(managed: ManagedProcess, data: object) {
  const msg = JSON.stringify(data);
  for (const ws of managed.sockets) {
    const socket = ws as WebSocket;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(msg);
    }
  }
}

export function broadcastToAll(data: object): void {
  const msg = JSON.stringify(data);
  for (const [, managed] of getAllActiveProcesses()) {
    for (const ws of managed.sockets) {
      const socket = ws as WebSocket;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(msg);
      }
    }
  }
}

export function notifySession(sessionId: string, data: object): boolean {
  const managed = getActiveProcess(sessionId);
  if (!managed || managed.sockets.size === 0) return false;
  const msg = JSON.stringify(data);
  let sent = false;
  for (const ws of managed.sockets) {
    const socket = ws as WebSocket;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(msg);
      sent = true;
    }
  }
  return sent;
}

export async function sendToActiveSession(sessionId: string, message: string): Promise<{ delivered: boolean; error?: string }> {
  const managed = getActiveProcess(sessionId);
  if (!managed) {
    logger.warn({ sessionId }, '[session] sendToActiveSession MISS — not in activeProcesses');
    return { delivered: false, error: `No active process for session ${sessionId}` };
  }
  if (!managed.alive) {
    logger.warn({ sessionId, profileId: managed.profileId }, '[session] sendToActiveSession DEAD — process not alive');
    return { delivered: false, error: `Process for session ${sessionId} is dead` };
  }
  try {
    await pmClient.inject(managed.pmSessionId, formatUserMessage(message));
    logger.info({ sessionId: sessionId.substring(0, 8), profileId: managed.profileId }, '[session] sendToActiveSession OK');
    return { delivered: true };
  } catch (err) {
    logger.error({ sessionId, profileId: managed.profileId, error: String(err) }, '[session] sendToActiveSession ERROR');
    return { delivered: false, error: `Failed to inject: ${err}` };
  }
}

export function sendActiveAgentsSnapshot(socket: WebSocket) {
  const agents = db.prepare(`
    SELECT a.id, a.name, a.state, a.profile_id,
      p.name as profile_name, p.icon as profile_icon,
      c.id as conversation_id, c.state as conversation_state,
      c.session_id, c.issue_number, c.title as conversation_title
    FROM agents a
    JOIN profiles p ON p.id = a.profile_id
    LEFT JOIN conversations c ON c.agent_id = a.id
    WHERE a.state != 'stopped'
    ORDER BY a.name
  `).all() as Array<{
    id: string; name: string; state: string; profile_id: string;
    profile_name: string; profile_icon: string;
    conversation_id: string | null; conversation_state: string | null;
    session_id: string | null; issue_number: number | null; conversation_title: string | null;
  }>;

  const openTabIds = new Set(
    (db.prepare('SELECT agent_id FROM open_tabs').all() as { agent_id: string }[])
      .map(t => t.agent_id)
  );

  const enriched = agents.map(a => ({
    ...a,
    process_alive: a.session_id ? !!(getActiveProcess(a.session_id)?.alive) : false,
    tab_open: openTabIds.has(a.id),
  }));

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'active_agents', agents: enriched }));
  }
}
