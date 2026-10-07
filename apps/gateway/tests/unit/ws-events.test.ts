import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { agentStatusEvent, type AgentStatusEvent, type AgentStatusPhase } from '../../src/ws/event-types.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const srcRoot = join(__dirname, '..', '..', 'src');

describe('agentStatusEvent factory', () => {
  it('produces type, status, phase, and ISO at timestamp', () => {
    const e = agentStatusEvent({ status: 'hello', phase: 'process_started' });
    expect(e.type).toBe('agent_status');
    expect(e.status).toBe('hello');
    expect(e.phase).toBe('process_started');
    expect(e.at).toMatch(ISO_RE);
  });

  it('includes pid when supplied', () => {
    const e = agentStatusEvent({ status: 'ok', phase: 'process_started', pid: 42 });
    expect(e.pid).toBe(42);
  });

  it('omits pid when not supplied', () => {
    const e = agentStatusEvent({ status: 'ok', phase: 'process_starting' });
    expect('pid' in e).toBe(false);
  });

  it('preserves optional error field', () => {
    const e = agentStatusEvent({ status: 'bye', phase: 'process_exited', error: 'stderr text' });
    expect(e.error).toBe('stderr text');
  });
});

/**
 * The gateway doesn't expose a single module that re-emits every
 * agent_status event, so we verify at the emit-site call level:
 * each source file's expected (phase, literal status) pair must
 * appear with an agentStatusEvent({ ... }) call, AND the free-form
 * { type: 'agent_status', status: ... } shape must no longer exist
 * anywhere outside event-types.ts.
 *
 * This keeps the `status` string check tight — the exact bytes
 * users see in chat bubbles don't drift silently.
 */

interface ExpectedEmit {
  file: string;
  status: string;
  phase: AgentStatusPhase;
  pidOptional?: boolean;
}

const EXPECTED_EMITS: ExpectedEmit[] = [
  // spawn.ts
  { file: 'ws/spawn.ts', status: 'exitMessage || `Process exited (code ${event.code})`', phase: 'process_exited', pidOptional: true },
  { file: 'ws/spawn.ts', status: '`Process error: ${event.message}`', phase: 'process_exited', pidOptional: true },
  { file: 'ws/spawn.ts', status: '`Process started (pid ${result.pid})`', phase: 'process_started' },
  // connection.ts
  { file: 'ws/connection.ts', status: "'Starting process...'", phase: 'process_starting' },
  { file: 'ws/connection.ts', status: "'Process is dead — reload to reconnect'", phase: 'process_gone' },
  { file: 'ws/connection.ts', status: "'Process is gone — respawning...'", phase: 'process_respawning', pidOptional: true },
  { file: 'ws/connection.ts', status: "'Send a message to resume.'", phase: 'session_reconnected' },
  { file: 'ws/connection.ts', status: "'Restarting without MCP servers — send a message to continue.'", phase: 'process_respawning' },
  { file: 'ws/connection.ts', status: '`Previous process${pidInfo} died — will start a new one on next message`', phase: 'process_exited', pidOptional: true },
  { file: 'ws/connection.ts', status: "'Process not running — send a message to resume.'", phase: 'session_reconnected' },
  // permissions.ts
  { file: 'ws/permissions.ts', status: '`Auto-approved: ${toolName}`', phase: 'tool_auto_approved' },
  { file: 'ws/permissions.ts', status: '`Auto-approve failed for ${toolName}: ${err}`', phase: 'tool_auto_approve_failed' },
];

describe('agent_status emit sites — dual-write verification', () => {
  const cache = new Map<string, string>();
  const readSrc = (rel: string): string => {
    if (!cache.has(rel)) cache.set(rel, readFileSync(join(srcRoot, rel), 'utf-8'));
    return cache.get(rel)!;
  };

  it.each(EXPECTED_EMITS)(
    '$file — phase $phase emit carries the expected status literal',
    ({ file, status, phase }) => {
      const src = readSrc(file);
      // The emit call must use agentStatusEvent({ ... }) with matching status + phase.
      // We substring-search because the two fields may appear on the same or adjacent lines.
      expect(src).toContain(`status: ${status}`);
      expect(src).toContain(`phase: '${phase}'`);
    },
  );

  it('no free-form { type: \'agent_status\' } emits remain outside event-types.ts', () => {
    const files = ['ws/spawn.ts', 'ws/connection.ts', 'ws/permissions.ts'];
    for (const f of files) {
      const src = readSrc(f);
      // Free-form emits look like: { type: 'agent_status', status: ... }
      // The factory output is: agentStatusEvent({ status: ..., phase: ... })
      // Any remaining 'type: \'agent_status\'' string in these files is a leak.
      expect(src).not.toMatch(/type:\s*'agent_status'/);
    }
  });
});
