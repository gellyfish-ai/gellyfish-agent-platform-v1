/**
 * SSE stream observer — parses JSON-RPC tool call events from SSE chunks
 * without modifying the byte stream. Stateful per-connection.
 */

export interface ToolCallEvent {
  type: 'tool_start' | 'tool_end';
  requestId: string | number;
  mcpName: string;
  toolName?: string;
  inputPreview?: string;
  success?: boolean;
  errorCode?: string;
  outputPreview?: string;
  durationMs?: number;
}

export class SseParser {
  private buffer = '';
  private mcpName: string;

  constructor(mcpName: string) {
    this.mcpName = mcpName;
  }

  observe(chunk: string): ToolCallEvent[] {
    this.buffer += chunk;
    const events: ToolCallEvent[] = [];

    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.substring(6).trim();
      if (!jsonStr) continue;

      try {
        const msg = JSON.parse(jsonStr);
        const parsed = this.parseMessage(msg);
        if (parsed) events.push(parsed);
      } catch {
        // Not valid JSON — skip
      }
    }

    return events;
  }

  private parseMessage(msg: Record<string, unknown>): ToolCallEvent | null {
    const id = msg.id as string | number | undefined;

    // JSON-RPC response — tool_start is captured in proxyMcpMessage
    if (id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const isError = msg.error !== undefined;
      const errorObj = msg.error as Record<string, unknown> | undefined;
      const resultObj = msg.result;
      const outputPreview = resultObj ? JSON.stringify(resultObj).substring(0, 500) : undefined;

      return {
        type: 'tool_end',
        requestId: id,
        mcpName: this.mcpName,
        success: !isError,
        errorCode: errorObj?.code !== undefined ? String(errorObj.code) : undefined,
        outputPreview,
      };
    }

    return null;
  }
}
