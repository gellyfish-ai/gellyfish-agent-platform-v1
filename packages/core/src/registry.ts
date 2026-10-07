import type { Integration, IntegrationAction } from './types.js';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Registry of available integrations.
 * Manages integration lifecycle and provides tool definitions for Claude.
 */
export class IntegrationRegistry {
  private integrations: Map<string, Integration> = new Map();

  /**
   * Register an integration.
   */
  register(integration: Integration): void {
    this.integrations.set(integration.name, integration);
  }

  /**
   * Unregister an integration.
   */
  unregister(name: string): void {
    this.integrations.delete(name);
  }

  /**
   * Get an integration by name.
   */
  get(name: string): Integration | undefined {
    return this.integrations.get(name);
  }

  /**
   * Get all registered integrations.
   */
  all(): Integration[] {
    return Array.from(this.integrations.values());
  }

  /**
   * Convert all integrations to Claude tool definitions.
   */
  toTools(): Anthropic.Tool[] {
    const tools: Anthropic.Tool[] = [];

    for (const integration of this.integrations.values()) {
      for (const action of integration.actions) {
        tools.push({
          name: `${integration.name}__${action.name}`,
          description: `[${integration.name}] ${action.description}`,
          input_schema: {
            type: 'object' as const,
            ...action.parameters,
          },
        });
      }
    }

    return tools;
  }

  /**
   * Execute a tool call from Claude.
   * Tool names are in format: integration__action
   */
  async executeTool(
    toolName: string,
    params: unknown
  ): Promise<{ integration: string; action: string; result: unknown }> {
    const [integrationName, actionName] = toolName.split('__');

    if (!integrationName || !actionName) {
      throw new Error(`Invalid tool name format: ${toolName}`);
    }

    const integration = this.integrations.get(integrationName);
    if (!integration) {
      throw new Error(`Integration not found: ${integrationName}`);
    }

    const action = integration.actions.find((a) => a.name === actionName);
    if (!action) {
      throw new Error(
        `Action not found: ${actionName} in ${integrationName}`
      );
    }

    const result = await integration.execute(actionName, params);

    return {
      integration: integrationName,
      action: actionName,
      result,
    };
  }
}
