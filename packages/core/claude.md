# Core

The agent orchestrator that powers Gellyfish. Uses Claude API to understand natural language commands and execute actions through integrations.

## Purpose

- Parse user intent from natural language
- Decide which integrations to call
- Execute multi-step workflows (agentic loop)
- Handle errors and return results

## Key Files

- `src/index.ts` - Public exports
- `src/agent.ts` - Main Agent class with agentic loop
- `src/registry.ts` - IntegrationRegistry for managing integrations
- `src/types.ts` - TypeScript type definitions

## Architecture

```
Command (from Gateway)
        │
        ▼
    ┌───────┐
    │ Agent │
    └───┬───┘
        │
        ▼
┌───────────────┐
│ Claude API    │ ◄── agentic loop
│ (tool use)    │     until done
└───────┬───────┘
        │
        ▼
┌───────────────────┐
│ IntegrationRegistry│
│   └─ Integration  │
│   └─ Integration  │
└───────────────────┘
        │
        ▼
  CommandResult
```

## Usage

```typescript
import { Agent, IntegrationRegistry } from '@gellyfish/core';

// Create registry and register integrations
const registry = new IntegrationRegistry();
registry.register(gmailIntegration);
registry.register(calendarIntegration);

// Create agent
const agent = new Agent({
  apiKey: process.env.ANTHROPIC_API_KEY,
}, registry);

// Process a command
const result = await agent.process({
  id: 'cmd-123',
  source: 'siri',
  userId: 'user-1',
  text: 'Send an email to mom saying I will be late',
});

console.log(result.message); // "Email sent to mom"
console.log(result.actions); // [{ integration: 'gmail', action: 'send', ... }]
```

## Creating an Integration

```typescript
import type { Integration } from '@gellyfish/core';

const myIntegration: Integration = {
  name: 'my-service',
  description: 'Does something useful',
  actions: [
    {
      name: 'do_thing',
      description: 'Does the thing',
      parameters: {
        properties: {
          input: { type: 'string', description: 'The input' },
        },
        required: ['input'],
      },
    },
  ],
  async execute(action, params) {
    if (action === 'do_thing') {
      // Do the thing
      return { success: true };
    }
    throw new Error(`Unknown action: ${action}`);
  },
};
```

## Development

```bash
pnpm install
pnpm dev          # Watch mode
pnpm test         # Run tests
pnpm build        # Build for production
```

## TODO

- [ ] Add conversation memory/context
- [ ] Add streaming support
- [ ] Add retry logic for failed API calls
- [ ] Add token counting and cost tracking
- [ ] Add integration authentication helpers
