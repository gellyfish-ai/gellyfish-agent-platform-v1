import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Agent, IntegrationRegistry } from '../../src/index.js';
import type { Command, Integration } from '../../src/types.js';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn(),
      },
    })),
  };
});

describe('Agent', () => {
  let agent: Agent;
  let registry: IntegrationRegistry;

  beforeEach(() => {
    registry = new IntegrationRegistry();
    agent = new Agent({ apiKey: 'test-key' }, registry);
  });

  describe('constructor', () => {
    it('creates agent with default config', () => {
      const agent = new Agent({ apiKey: 'test-key' });
      expect(agent).toBeDefined();
      expect(agent.getRegistry()).toBeDefined();
    });

    it('uses provided registry', () => {
      const customRegistry = new IntegrationRegistry();
      const agent = new Agent({ apiKey: 'test-key' }, customRegistry);
      expect(agent.getRegistry()).toBe(customRegistry);
    });
  });

  describe('getRegistry', () => {
    it('returns the integration registry', () => {
      expect(agent.getRegistry()).toBe(registry);
    });
  });
});

describe('IntegrationRegistry', () => {
  let registry: IntegrationRegistry;

  const mockIntegration: Integration = {
    name: 'test',
    description: 'Test integration',
    actions: [
      {
        name: 'hello',
        description: 'Says hello',
        parameters: {
          properties: {
            name: { type: 'string', description: 'Name to greet' },
          },
          required: ['name'],
        },
      },
    ],
    execute: vi.fn().mockResolvedValue({ greeting: 'Hello!' }),
  };

  beforeEach(() => {
    registry = new IntegrationRegistry();
  });

  describe('register', () => {
    it('registers an integration', () => {
      registry.register(mockIntegration);
      expect(registry.get('test')).toBe(mockIntegration);
    });
  });

  describe('unregister', () => {
    it('removes an integration', () => {
      registry.register(mockIntegration);
      registry.unregister('test');
      expect(registry.get('test')).toBeUndefined();
    });
  });

  describe('all', () => {
    it('returns all registered integrations', () => {
      registry.register(mockIntegration);
      expect(registry.all()).toContain(mockIntegration);
    });
  });

  describe('toTools', () => {
    it('converts integrations to Claude tool format', () => {
      registry.register(mockIntegration);
      const tools = registry.toTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test__hello');
      expect(tools[0].description).toBe('[test] Says hello');
    });

    it('returns empty array when no integrations', () => {
      expect(registry.toTools()).toEqual([]);
    });
  });

  describe('executeTool', () => {
    beforeEach(() => {
      registry.register(mockIntegration);
    });

    it('executes a tool and returns result', async () => {
      const result = await registry.executeTool('test__hello', {
        name: 'World',
      });

      expect(result).toEqual({
        integration: 'test',
        action: 'hello',
        result: { greeting: 'Hello!' },
      });
      expect(mockIntegration.execute).toHaveBeenCalledWith('hello', {
        name: 'World',
      });
    });

    it('throws for invalid tool name format', async () => {
      await expect(registry.executeTool('invalid', {})).rejects.toThrow(
        'Invalid tool name format'
      );
    });

    it('throws for unknown integration', async () => {
      await expect(
        registry.executeTool('unknown__action', {})
      ).rejects.toThrow('Integration not found');
    });

    it('throws for unknown action', async () => {
      await expect(
        registry.executeTool('test__unknown', {})
      ).rejects.toThrow('Action not found');
    });
  });
});
