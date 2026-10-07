/**
 * PM Client — gateway's connection to the Process Manager.
 *
 * Sends commands (spawn, inject, kill, cancel, list, subscribe).
 * Receives responses and event streams.
 * Auto-reconnects if the PM restarts.
 */

import { connect as netConnect, Socket } from 'net';
import { join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { logger } from './logger.js';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const SOCKET_PATH = process.env.PM_SOCKET || join(DATA_DIR, 'gellyfish-pm.sock');
const PID_PATH = join(DATA_DIR, 'gellyfish-pm.pid');

export interface ProcessInfo {
  sessionId: string;
  profileId?: string;
  pid: number;
  alive: boolean;
}

export interface PMEvent {
  sessionId: string;
  event: string;
  data?: unknown;
  code?: number;
  message?: string;
  position?: number;
  remaining?: number;
}

type EventHandler = (event: PMEvent) => void;

export class PMClient {
  private socket: Socket | null = null;
  private buffer = '';
  private pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private subscriptions = new Map<string, EventHandler>(); // sessionId → handler
  private reconnecting = false;
  private connected = false;
  private reqCounter = 0;

  async connect(): Promise<void> {
    await this.ensurePMRunning();
    return this.connectToSocket();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async spawn(opts: { sessionId: string; profileId?: string; args: string[]; cwd: string }): Promise<{ pid: number; existing?: boolean }> {
    const res = await this.send('spawn', opts) as { pid: number; existing?: boolean };
    return res;
  }

  async inject(sessionId: string, message: string): Promise<void> {
    await this.send('inject', { sessionId, message });
  }

  async kill(sessionId: string): Promise<void> {
    await this.send('kill', { sessionId });
  }

  async cancel(sessionId: string): Promise<{ phase: string }> {
    const res = await this.send('cancel', { sessionId }) as { phase: string };
    return res;
  }

  async list(): Promise<ProcessInfo[]> {
    const res = await this.send('list', {}) as { processes: ProcessInfo[] };
    return res.processes;
  }

  subscribe(sessionId: string, handler: EventHandler): void {
    if (this.subscriptions.has(sessionId)) {
      return; // Already subscribed — avoid overwriting with a different ManagedProcess reference
    }
    this.subscriptions.set(sessionId, handler);
    // Fire-and-forget subscribe command
    this.send('subscribe', { sessionId }).catch(() => { /* reconnect will resubscribe */ });
  }

  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    this.send('unsubscribe', { sessionId }).catch(() => { /* */ });
  }

  // --- Internals ---

  private async ensurePMRunning(): Promise<void> {
    // Check if PM is alive via PID file
    if (existsSync(PID_PATH)) {
      const pid = parseInt(readFileSync(PID_PATH, 'utf-8').trim(), 10);
      if (pid && this.isProcessAlive(pid)) {
        logger.info({ pid }, '[pm-client] PM already running');
        return;
      }
      // Stale PID — clean up
      logger.warn({ pid }, '[pm-client] PM PID is stale, cleaning up');
      try { unlinkSync(PID_PATH); } catch { /* */ }
      try { unlinkSync(SOCKET_PATH); } catch { /* */ }
    }

    // Spawn PM as detached process
    logger.info('[pm-client] spawning process manager');
    const isProd = process.env.NODE_ENV === 'production';
    const cmd = isProd ? 'node' : 'tsx';
    const script = isProd
      ? join(process.cwd(), 'dist', 'process-manager.js')
      : join(process.cwd(), 'src', 'process-manager.ts');
    const pmProcess = spawn(cmd, [script], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
    });
    pmProcess.unref();

    // Wait for socket to become available (PM needs a moment to start)
    for (let i = 0; i < 30; i++) {
      await this.sleep(200);
      if (existsSync(SOCKET_PATH)) {
        logger.info({ pid: pmProcess.pid }, '[pm-client] PM started');
        return;
      }
    }

    throw new Error('Process manager failed to start within 6 seconds');
  }

  private connectToSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = netConnect(SOCKET_PATH);

      socket.on('connect', () => {
        this.socket = socket;
        this.connected = true;
        this.reconnecting = false;
        logger.info('[pm-client] connected to process manager');

        // Resubscribe to all active subscriptions
        for (const sessionId of this.subscriptions.keys()) {
          this.send('subscribe', { sessionId }).catch(() => { /* */ });
        }

        resolve();
      });

      let buffer = '';
      socket.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) this.handleMessage(line);
        }
      });

      socket.on('close', () => {
        this.connected = false;
        this.socket = null;
        logger.warn('[pm-client] disconnected from process manager');

        // Reject all pending requests
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error('PM connection lost'));
        }
        this.pendingRequests.clear();

        // Auto-reconnect
        if (!this.reconnecting) {
          this.reconnecting = true;
          setTimeout(() => this.reconnect(), 1000);
        }
      });

      socket.on('error', (err) => {
        if (!this.connected) {
          reject(err);
        } else {
          logger.error({ error: err.message }, '[pm-client] socket error');
        }
      });
    });
  }

  private async reconnect() {
    for (let i = 0; i < 10; i++) {
      try {
        await this.ensurePMRunning();
        await this.connectToSocket();
        return;
      } catch {
        logger.warn({ attempt: i + 1 }, '[pm-client] reconnect failed, retrying...');
        await this.sleep(2000);
      }
    }
    logger.error('[pm-client] gave up reconnecting to process manager');
  }

  private handleMessage(line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Response to a pending request
    if (msg.id && this.pendingRequests.has(msg.id as string)) {
      const pending = this.pendingRequests.get(msg.id as string)!;
      this.pendingRequests.delete(msg.id as string);
      if (msg.ok === false) {
        pending.reject(new Error(msg.error as string || 'PM request failed'));
      } else {
        pending.resolve(msg);
      }
      return;
    }

    // Event from PM
    if (msg.type === 'event') {
      const sessionId = msg.sessionId as string;
      const handler = this.subscriptions.get(sessionId);
      if (handler) {
        handler(msg as unknown as PMEvent);
      }
    }
  }

  private send(type: string, data: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to process manager'));
        return;
      }

      const id = `req-${++this.reqCounter}`;
      this.pendingRequests.set(id, { resolve, reject });

      const msg = JSON.stringify({ id, type, ...data });
      this.socket.write(msg + '\n');

      // Timeout after 10s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`PM request timed out: ${type}`));
        }
      }, 10000);
    });
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// Singleton instance
export const pmClient = new PMClient();
