export interface Command {
  source: 'siri' | 'telegram' | 'whatsapp' | 'voice' | 'api';
  user_id: string;
  command: string;
  context?: Record<string, unknown>;
}

export interface CommandResult {
  id: string;
  status: 'received' | 'processing' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
}
