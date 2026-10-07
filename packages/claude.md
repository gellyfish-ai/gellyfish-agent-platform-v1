# Packages

This folder contains **shared libraries** - reusable code imported by apps or other packages.

## What Goes Here

- Core business logic (`core/`)
- Input/output adapters (`adapters-*`)
- Service integrations (`integration-*`)
- Shared utilities (`shared/`)
- Type definitions, schemas
- Anything imported by multiple apps

## What Does NOT Go Here

- Standalone executables → use `apps/`
- App-specific code that won't be reused

## Package Naming

| Pattern | Purpose | Example |
|---------|---------|---------|
| `core` | Central orchestration logic | Agent, intent parsing |
| `adapters-input-*` | Receive commands from sources | `adapters-input-telegram` |
| `adapters-output-*` | Send responses/notifications | `adapters-output-push` |
| `integration-*` | External service connectors | `integration-gmail` |
| `shared` | Cross-cutting utilities | Types, helpers, schemas |

## Structure of a Package

```
packages/my-package/
├── src/
│   ├── index.ts            # Public API (exports)
│   └── internal/           # Private implementation
├── tests/
│   ├── unit/
│   └── integration/
├── claude.md               # Package-specific guidance
├── package.json            # Or Cargo.toml, pyproject.toml
└── README.md               # API documentation
```

## Current Packages

| Package | Language | Purpose | Status |
|---------|----------|---------|--------|
| `core/` | TypeScript | Agent orchestrator - Claude API integration | Implemented |
| `shared/` | TypeScript | Shared types and utilities | Planned |
| `adapters-input-telegram/` | TypeScript | Telegram bot input | Planned |
| `integration-gmail/` | TypeScript | Gmail API integration | Planned |

> Note: Packages will be scaffolded as needed. Start with `core/` when building the agent.

## Creating a New Package

### Adapter (Input)

Handles receiving commands from a source:

```bash
mkdir -p packages/adapters-input-whatsapp/src packages/adapters-input-whatsapp/tests
```

Must implement:
```typescript
interface InputAdapter {
  // Initialize connection/webhook
  start(): Promise<void>;

  // Normalize to common format
  parseCommand(raw: unknown): Command;

  // Clean shutdown
  stop(): Promise<void>;
}
```

### Adapter (Output)

Handles sending responses:

```bash
mkdir -p packages/adapters-output-sms/src packages/adapters-output-sms/tests
```

Must implement:
```typescript
interface OutputAdapter {
  send(response: Response): Promise<void>;
}
```

### Integration

Connects to an external service:

```bash
mkdir -p packages/integration-notion/src packages/integration-notion/tests
```

Must implement:
```typescript
interface Integration {
  // Human-readable name
  name: string;

  // Available actions for the agent
  actions: Action[];

  // Execute an action
  execute(action: string, params: unknown): Promise<Result>;
}
```

## Dependencies

Packages can depend on:
- `packages/shared` (utilities, types)
- External dependencies
- Other packages (be careful of circular deps)

Packages should NOT depend on:
- `apps/*` (apps depend on packages, not vice versa)

## Testing Requirements

| Package Type | Coverage Target | Focus |
|--------------|-----------------|-------|
| `core` | 90%+ | Business logic, edge cases |
| `adapters-*` | 80%+ | Parsing, error handling |
| `integration-*` | 80%+ | API calls, auth flows |
| `shared` | 70%+ | Utilities |

Every integration must have:
- Unit tests with mocked API responses
- At least one integration test (can be skipped in CI)

## Cross-Language Packages

For packages that need to be used from multiple languages:

1. **API approach**: Package exposes HTTP/gRPC API
2. **FFI approach**: Rust packages can be called via FFI
3. **Schema approach**: Define shared schemas in `packages/shared/schemas/`

Prefer the API approach for simplicity unless performance is critical.
