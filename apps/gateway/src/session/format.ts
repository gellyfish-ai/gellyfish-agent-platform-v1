export function prefixMessage(type: string, source: string, content: string): string {
  return `[GAP/${type} from:${source}] ${content}`;
}

export function formatUserMessage(content: string | unknown[]): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
  });
}

export function formatControlResponse(requestId: string, input: unknown): string {
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { behavior: 'allow' as const, updatedInput: input || {} },
    },
  });
}

export function extractResultText(event: Record<string, unknown>): string {
  const result = event.result as Record<string, unknown> | undefined;
  if (!result) return '';
  const content = result.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return JSON.stringify(result);
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text as string)
    .join('\n');
}
