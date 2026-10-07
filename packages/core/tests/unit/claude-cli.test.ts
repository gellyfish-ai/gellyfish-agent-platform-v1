import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { claudeCli, claudeCliStream, ClaudeCliSession } from '../../src/claude-cli.js';

// Mock child_process
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Helper to create a mock process
function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  return proc;
}

describe('claudeCli', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls spawn with correct arguments', async () => {
    const promise = claudeCli('Hello');

    // Simulate successful response
    mockProc.stdout.emit('data', Buffer.from('{"result": "Hi there!"}'));
    mockProc.emit('close', 0);

    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--output-format', 'json', '--print', 'result', '--', 'Hello']),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
  });

  it('returns parsed JSON result', async () => {
    const promise = claudeCli('Hello');

    mockProc.stdout.emit('data', Buffer.from('{"result": "Hi there!", "session_id": "sess-123"}'));
    mockProc.emit('close', 0);

    const response = await promise;

    expect(response).toEqual({
      result: 'Hi there!',
      success: true,
      sessionId: 'sess-123',
    });
  });

  it('handles non-JSON output gracefully', async () => {
    const promise = claudeCli('Hello');

    mockProc.stdout.emit('data', Buffer.from('Plain text response'));
    mockProc.emit('close', 0);

    const response = await promise;

    expect(response).toEqual({
      result: 'Plain text response',
      success: true,
    });
  });

  it('handles non-zero exit code', async () => {
    const promise = claudeCli('Hello');

    mockProc.stderr.emit('data', Buffer.from('Error: something went wrong'));
    mockProc.emit('close', 1);

    const response = await promise;

    expect(response).toEqual({
      result: '',
      success: false,
      error: 'Error: something went wrong',
    });
  });

  it('handles spawn error', async () => {
    const promise = claudeCli('Hello');

    mockProc.emit('error', new Error('spawn ENOENT'));

    const response = await promise;

    expect(response).toEqual({
      result: '',
      success: false,
      error: 'spawn ENOENT',
    });
  });

  it('handles timeout', async () => {
    vi.useFakeTimers();

    const promise = claudeCli('Hello', { timeout: 1000 });

    vi.advanceTimersByTime(1001);

    const response = await promise;

    expect(response).toEqual({
      result: '',
      success: false,
      error: 'Timeout after 1000ms',
    });
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

    vi.useRealTimers();
  });

  it('passes optional arguments correctly', async () => {
    const promise = claudeCli('Hello', {
      maxTokens: 100,
      systemPrompt: 'Be helpful',
      sessionId: 'sess-123',
      model: 'opus',
    });

    mockProc.stdout.emit('data', Buffer.from('{"result": "OK"}'));
    mockProc.emit('close', 0);

    await promise;

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--max-tokens');
    expect(args).toContain('100');
    expect(args).toContain('--system-prompt');
    expect(args).toContain('Be helpful');
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-123');
    expect(args).toContain('--model');
    expect(args).toContain('opus');
  });

  it('passes cwd option to spawn', async () => {
    const promise = claudeCli('Hello', { cwd: '/some/path' });

    mockProc.stdout.emit('data', Buffer.from('{"result": "OK"}'));
    mockProc.emit('close', 0);

    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.objectContaining({ cwd: '/some/path' })
    );
  });
});

describe('claudeCliStream', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits data events for each JSON line', async () => {
    const stream = claudeCliStream('Hello');
    const events: unknown[] = [];

    const endPromise = new Promise<void>((resolve) => {
      stream.on('data', (event) => events.push(event));
      stream.on('end', () => resolve());
    });

    mockProc.stdout.emit('data', Buffer.from('{"type": "text", "text": "Hello"}\n'));
    mockProc.stdout.emit('data', Buffer.from('{"type": "text", "text": " world"}\n'));
    mockProc.emit('close', 0);

    await endPromise;

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text', content: 'Hello' });
    expect(events[1]).toEqual({ type: 'text', content: ' world' });
  });

  it('handles buffered multiline data', async () => {
    const stream = claudeCliStream('Hello');
    const events: unknown[] = [];

    const endPromise = new Promise<void>((resolve) => {
      stream.on('data', (event) => events.push(event));
      stream.on('end', () => resolve());
    });

    // Send data in chunks that don't align with newlines
    mockProc.stdout.emit('data', Buffer.from('{"type": "tex'));
    mockProc.stdout.emit('data', Buffer.from('t", "text": "Hi"}\n{"type":'));
    mockProc.stdout.emit('data', Buffer.from(' "done"}\n'));
    mockProc.emit('close', 0);

    await endPromise;

    expect(events).toHaveLength(2);
  });

  it('emits end event with exit code', async () => {
    const stream = claudeCliStream('Hello');

    const endPromise = new Promise<{ code: number; success: boolean }>((resolve) => {
      stream.on('end', resolve);
    });

    mockProc.emit('close', 0);

    const result = await endPromise;
    expect(result).toEqual({ code: 0, success: true });
  });

  it('emits error on timeout', async () => {
    vi.useFakeTimers();

    const stream = claudeCliStream('Hello', { timeout: 1000 });

    const errorPromise = new Promise<Error>((resolve) => {
      stream.on('error', resolve);
    });

    vi.advanceTimersByTime(1001);

    const error = await errorPromise;
    expect(error.message).toBe('Timeout after 1000ms');

    vi.useRealTimers();
  });

  it('provides kill method', () => {
    const stream = claudeCliStream('Hello');
    stream.kill();
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('uses stream-json output format', async () => {
    const stream = claudeCliStream('Hello');

    const endPromise = new Promise<void>((resolve) => {
      stream.on('end', () => resolve());
    });

    mockProc.emit('close', 0);
    await endPromise;

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
  });
});

describe('ClaudeCliSession', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('stores session ID from response', async () => {
    const session = new ClaudeCliSession();

    expect(session.getSessionId()).toBeUndefined();

    const promise = session.send('Hello');
    mockProc.stdout.emit('data', Buffer.from('{"result": "Hi", "session_id": "sess-456"}'));
    mockProc.emit('close', 0);

    await promise;

    expect(session.getSessionId()).toBe('sess-456');
  });

  it('passes session ID on subsequent calls', async () => {
    const session = new ClaudeCliSession();

    // First call
    let promise = session.send('Hello');
    mockProc.stdout.emit('data', Buffer.from('{"result": "Hi", "session_id": "sess-456"}'));
    mockProc.emit('close', 0);
    await promise;

    // Create new mock for second call
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    // Second call should include session ID
    promise = session.send('Follow up');
    mockProc.stdout.emit('data', Buffer.from('{"result": "OK"}'));
    mockProc.emit('close', 0);
    await promise;

    const args = mockSpawn.mock.calls[1][1];
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-456');
  });

  it('reset() clears session ID', async () => {
    const session = new ClaudeCliSession();

    const promise = session.send('Hello');
    mockProc.stdout.emit('data', Buffer.from('{"result": "Hi", "session_id": "sess-456"}'));
    mockProc.emit('close', 0);
    await promise;

    expect(session.getSessionId()).toBe('sess-456');

    session.reset();

    expect(session.getSessionId()).toBeUndefined();
  });

  it('accepts initial options', () => {
    const session = new ClaudeCliSession({
      systemPrompt: 'Be helpful',
      model: 'opus',
    });

    session.send('Hello');

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--system-prompt');
    expect(args).toContain('Be helpful');
    expect(args).toContain('--model');
    expect(args).toContain('opus');
  });

  it('stream() returns EventEmitter', () => {
    const session = new ClaudeCliSession();
    const stream = session.stream('Hello');

    expect(stream).toBeInstanceOf(EventEmitter);
    expect(typeof stream.kill).toBe('function');
  });
});
