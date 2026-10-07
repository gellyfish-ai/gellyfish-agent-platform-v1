import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

/**
 * Response from a Claude CLI invocation.
 */
export interface ClaudeCliResponse {
  /** The text result from Claude */
  result: string;
  /** Whether the command succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Session ID for conversation continuity */
  sessionId?: string;
}

/**
 * Options for Claude CLI invocation.
 */
export interface ClaudeCliOptions {
  /** Timeout in milliseconds (default: 120000) */
  timeout?: number;
  /** Maximum tokens in response */
  maxTokens?: number;
  /** System prompt to use */
  systemPrompt?: string;
  /** Session ID to resume (uses --resume). For conversation continuity. */
  sessionId?: string;
  /** Working directory for the CLI */
  cwd?: string;
  /** Model to use (e.g., 'sonnet', 'opus', 'haiku') */
  model?: string;
  /** Additional CLI arguments */
  additionalArgs?: string[];
}

/**
 * Event emitted during streaming.
 */
export interface ClaudeStreamEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'done';
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
}

const DEFAULT_TIMEOUT = 120_000;

/**
 * Execute a single prompt using Claude CLI.
 * Returns the complete response when done.
 */
export async function claudeCli(
  prompt: string,
  options: ClaudeCliOptions = {}
): Promise<ClaudeCliResponse> {
  const {
    timeout = DEFAULT_TIMEOUT,
    maxTokens,
    systemPrompt,
    sessionId,
    cwd,
    model,
    additionalArgs = [],
  } = options;

  const args = buildArgs({
    maxTokens,
    systemPrompt,
    sessionId,
    model,
    additionalArgs,
    outputFormat: 'json',
    print: 'result',
  });

  args.push('--', prompt);

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        result: '',
        success: false,
        error: `Timeout after ${timeout}ms`,
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        resolve({
          result: '',
          success: false,
          error: stderr || `CLI exited with code ${code}`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve({
          result: parsed.result ?? parsed.text ?? stdout,
          success: true,
          sessionId: parsed.session_id,
        });
      } catch {
        // Fallback if not valid JSON
        resolve({
          result: stdout.trim(),
          success: true,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        result: '',
        success: false,
        error: err.message,
      });
    });
  });
}

/**
 * Execute a prompt with streaming output.
 * Returns an EventEmitter that emits events as they arrive.
 */
export function claudeCliStream(
  prompt: string,
  options: ClaudeCliOptions = {}
): EventEmitter & { kill: () => void } {
  const {
    timeout = DEFAULT_TIMEOUT,
    maxTokens,
    systemPrompt,
    sessionId,
    cwd,
    model,
    additionalArgs = [],
  } = options;

  const emitter = new EventEmitter() as EventEmitter & {
    kill: () => void;
    _proc?: ChildProcess;
  };

  const args = buildArgs({
    maxTokens,
    systemPrompt,
    sessionId,
    model,
    additionalArgs,
    outputFormat: 'stream-json',
  });

  args.push('--', prompt);

  const proc = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
  });

  emitter._proc = proc;
  emitter.kill = () => proc.kill('SIGTERM');

  let buffer = '';

  const timer = setTimeout(() => {
    proc.kill('SIGTERM');
    emitter.emit('error', new Error(`Timeout after ${timeout}ms`));
  }, timeout);

  proc.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();

    // Process complete JSON lines
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);
        emitter.emit('data', parseStreamEvent(event));
      } catch {
        // Skip malformed lines
      }
    }
  });

  proc.stderr.on('data', (data: Buffer) => {
    emitter.emit('stderr', data.toString());
  });

  proc.on('close', (code) => {
    clearTimeout(timer);

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        emitter.emit('data', parseStreamEvent(event));
      } catch {
        // Skip malformed data
      }
    }

    emitter.emit('end', { code, success: code === 0 });
  });

  proc.on('error', (err) => {
    clearTimeout(timer);
    emitter.emit('error', err);
  });

  return emitter;
}

/**
 * Start an interactive Claude CLI session.
 * Allows sending multiple prompts in a conversation.
 */
export class ClaudeCliSession {
  private sessionId?: string;
  private options: ClaudeCliOptions;

  constructor(options: ClaudeCliOptions = {}) {
    this.options = options;
    this.sessionId = options.sessionId;
  }

  /**
   * Send a message and get a response.
   */
  async send(prompt: string): Promise<ClaudeCliResponse> {
    const response = await claudeCli(prompt, {
      ...this.options,
      sessionId: this.sessionId,
    });

    // Store session ID for conversation continuity
    if (response.sessionId) {
      this.sessionId = response.sessionId;
    }

    return response;
  }

  /**
   * Send a message with streaming response.
   */
  stream(prompt: string): EventEmitter & { kill: () => void } {
    return claudeCliStream(prompt, {
      ...this.options,
      sessionId: this.sessionId,
    });
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Reset the session (start fresh conversation).
   */
  reset(): void {
    this.sessionId = undefined;
  }
}

// Helper to build CLI arguments
function buildArgs(config: {
  maxTokens?: number;
  systemPrompt?: string;
  sessionId?: string;
  model?: string;
  additionalArgs?: string[];
  outputFormat?: string;
  print?: string;
}): string[] {
  const args: string[] = [];

  if (config.outputFormat) {
    args.push('--output-format', config.outputFormat);
  }

  if (config.print) {
    args.push('--print', config.print);
  }

  if (config.maxTokens) {
    args.push('--max-tokens', String(config.maxTokens));
  }

  if (config.systemPrompt) {
    args.push('--system-prompt', config.systemPrompt);
  }

  if (config.sessionId) {
    args.push('--resume', config.sessionId);
  }

  if (config.model) {
    args.push('--model', config.model);
  }

  if (config.additionalArgs) {
    args.push(...config.additionalArgs);
  }

  return args;
}

// Helper to parse stream events into a consistent format
function parseStreamEvent(event: Record<string, unknown>): ClaudeStreamEvent {
  if (event.type === 'text' || event.type === 'content_block_delta') {
    return {
      type: 'text',
      content:
        (event.text as string) ??
        ((event.delta as Record<string, unknown>)?.text as string),
    };
  }

  if (event.type === 'tool_use') {
    return {
      type: 'tool_use',
      toolName: event.name as string,
      toolInput: event.input,
    };
  }

  if (event.type === 'tool_result') {
    return {
      type: 'tool_result',
      toolResult: event.result,
    };
  }

  if (event.type === 'error') {
    return {
      type: 'error',
      content: (event.message as string) ?? 'Unknown error',
    };
  }

  if (
    event.type === 'message_stop' ||
    event.type === 'end' ||
    event.type === 'done'
  ) {
    return { type: 'done' };
  }

  // Unknown event type, pass through as text if it has content
  return {
    type: 'text',
    content: JSON.stringify(event),
  };
}
