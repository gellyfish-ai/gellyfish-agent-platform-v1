/**
 * A command received from an input channel.
 */
export interface Command {
  /** Unique identifier for this command */
  id: string;
  /** Where the command came from */
  source: 'siri' | 'telegram' | 'whatsapp' | 'voice' | 'api';
  /** User who issued the command */
  userId: string;
  /** Natural language command text */
  text: string;
  /** Optional context from the input channel */
  context?: Record<string, unknown>;
}

/**
 * Result of processing a command.
 */
export interface CommandResult {
  /** The command that was processed */
  commandId: string;
  /** Whether the command succeeded */
  success: boolean;
  /** Human-readable response message */
  message: string;
  /** Structured result data */
  data?: unknown;
  /** Error details if failed */
  error?: string;
  /** Actions that were executed */
  actions: ActionResult[];
}

/**
 * Result of a single action execution.
 */
export interface ActionResult {
  /** Integration that executed the action */
  integration: string;
  /** Action that was called */
  action: string;
  /** Whether this action succeeded */
  success: boolean;
  /** Result data from the integration */
  result?: unknown;
  /** Error message if failed */
  error?: string;
}

/**
 * An action that an integration can perform.
 */
export interface IntegrationAction {
  /** Action name (e.g., 'send_message') */
  name: string;
  /** Human-readable description for the agent */
  description: string;
  /** JSON Schema for action parameters */
  parameters: Record<string, unknown>;
}

/**
 * An integration that connects to an external service.
 */
export interface Integration {
  /** Human-readable name */
  name: string;
  /** Description of what this integration does */
  description: string;
  /** Available actions */
  actions: IntegrationAction[];
  /** Execute an action */
  execute(action: string, params: unknown): Promise<unknown>;
}

/**
 * Configuration for the Agent.
 */
export interface AgentConfig {
  /** Anthropic API key */
  apiKey: string;
  /** Model to use (default: claude-sonnet-4-20250514) */
  model?: string;
  /** Maximum tokens in response */
  maxTokens?: number;
  /** System prompt additions */
  systemPrompt?: string;
}
