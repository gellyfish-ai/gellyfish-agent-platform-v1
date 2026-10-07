import Anthropic from '@anthropic-ai/sdk';
import type {
  Command,
  CommandResult,
  ActionResult,
  AgentConfig,
} from './types.js';
import { IntegrationRegistry } from './registry.js';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You are Gellyfish, a personal AI assistant running on the user's home server.

Your job is to help the user by executing actions through available integrations.

Guidelines:
- Be concise and direct in responses
- Use the available tools to accomplish tasks
- If you need clarification, ask
- If an action fails, explain what went wrong
- Confirm successful actions briefly

Available integrations will be provided as tools. Use them to fulfill the user's requests.`;

/**
 * The core agent that processes commands using Claude.
 */
export class Agent {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private systemPrompt: string;
  private registry: IntegrationRegistry;

  constructor(config: AgentConfig, registry?: IntegrationRegistry) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.systemPrompt = config.systemPrompt
      ? `${SYSTEM_PROMPT}\n\n${config.systemPrompt}`
      : SYSTEM_PROMPT;
    this.registry = registry ?? new IntegrationRegistry();
  }

  /**
   * Get the integration registry.
   */
  getRegistry(): IntegrationRegistry {
    return this.registry;
  }

  /**
   * Process a command and return the result.
   */
  async process(command: Command): Promise<CommandResult> {
    const actions: ActionResult[] = [];

    try {
      const tools = this.registry.toTools();

      // Initial message to Claude
      let messages: Anthropic.MessageParam[] = [
        { role: 'user', content: command.text },
      ];

      // Agentic loop - keep processing until done
      while (true) {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: this.maxTokens,
          system: this.systemPrompt,
          tools: tools.length > 0 ? tools : undefined,
          messages,
        });

        // Check if we're done (no more tool use)
        if (response.stop_reason === 'end_turn') {
          const textContent = response.content.find(
            (block) => block.type === 'text'
          );
          const message =
            textContent && textContent.type === 'text'
              ? textContent.text
              : 'Done';

          return {
            commandId: command.id,
            success: true,
            message,
            actions,
          };
        }

        // Process tool calls
        if (response.stop_reason === 'tool_use') {
          const toolUseBlocks = response.content.filter(
            (block) => block.type === 'tool_use'
          );

          // Add assistant's response to messages
          messages.push({ role: 'assistant', content: response.content });

          // Execute each tool and collect results
          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const block of toolUseBlocks) {
            if (block.type !== 'tool_use') continue;

            try {
              const { integration, action, result } =
                await this.registry.executeTool(block.name, block.input);

              actions.push({
                integration,
                action,
                success: true,
                result,
              });

              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(result),
              });
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : 'Unknown error';

              actions.push({
                integration: block.name.split('__')[0] ?? 'unknown',
                action: block.name.split('__')[1] ?? 'unknown',
                success: false,
                error: errorMessage,
              });

              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify({ error: errorMessage }),
                is_error: true,
              });
            }
          }

          // Add tool results to messages
          messages.push({ role: 'user', content: toolResults });

          continue;
        }

        // Unexpected stop reason
        return {
          commandId: command.id,
          success: false,
          message: 'Unexpected response from agent',
          error: `Unexpected stop reason: ${response.stop_reason}`,
          actions,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return {
        commandId: command.id,
        success: false,
        message: 'Failed to process command',
        error: errorMessage,
        actions,
      };
    }
  }
}
