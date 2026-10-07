# Gellyfish

## CRITICAL: Dev vs Prod

This is the **DEV** repository. All code changes happen here.

- **Dev repo:** `~/Workspace/gellyfish/` — edit code here, commit here, test here
- **Prod repo:** `~/Workspace/gellyfish-prod/` — **NEVER edit. Read-only.** Built deployment only.
- **HQ repo:** `~/Workspace/gellyfish-hq/` — Company docs, processes, profile definitions, skills. Source of truth for how the company operates.

If you find yourself in `gellyfish-prod/`, stop and `cd` back to `gellyfish/`.

## Gellyfish HQ (Company Knowledge Base)

The [gellyfish-hq](https://github.com/gellyfish-ai/gellyfish-hq) repo is the source of truth for company operations. Reference it for:

- **PROCESS.md** — ticket workflow, roles, QA process
- **MCP-SECURITY.md** — how to handle credentials and secure MCPs
- **ACCOUNTS.md** — company accounts registry
- **GAP/VISION.md** — product vision, core model, roadmap
- **GAP/profiles/** — profile CLAUDE.md definitions (version-controlled)
- **GAP/skills/** — global, crew, and leadership skills
- **GAP/briefs/** — feature briefs
- **GAP/CREATING-PROFILES.md** — how to create new profiles

Local path: `~/Workspace/gellyfish-hq/` (env var: `HQ_PATH`)

## Session Continuity

On startup, check for saved context from a previous session:
```bash
cat .claude/context/session.md 2>/dev/null
```
If the file exists, read it to restore context, summarize what we were working on, then delete it. This enables seamless continuation across restarts.

To save context before restart: `/save-context`
To manually restore: `/restore-context`

Note: Context is stored per-project in `.claude/context/` to avoid conflicts with multiple Claude instances.

---

Personal AI agent platform that runs on your home server. Control your digital life from anywhere using natural language via any interface - Siri, WhatsApp, Telegram, voice, or text.

> "Hey Siri, tell Gellyfish to reply to that WhatsApp politely declining the meeting"

## Monorepo Structure

This is a **polyglot monorepo** (Google-style). Each package is self-contained with its own language, tooling, and tests.

```
gellyfish/
├── apps/                    # Deployable applications
│   ├── gateway/             # API server (TypeScript)
│   ├── ios-shortcuts/       # iOS Shortcuts app (Swift)
│   └── cli/                 # Command-line tool (Rust)
├── packages/                # Shared libraries
│   ├── core/                # Agent orchestrator (TypeScript)
│   ├── adapters-*/          # Input/output adapters
│   ├── integration-*/       # Service integrations
│   └── shared/              # Cross-language shared types
├── docs/                    # Documentation
├── .github/workflows/       # CI/CD pipelines
├── Taskfile.yml             # Universal task runner
└── claude.md                # You are here
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      INPUT CHANNELS                          │
│   Siri Shortcuts │ WhatsApp │ Telegram │ SMS │ Voice        │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│                  GELLYFISH (Home Server)                     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                      GATEWAY                            │ │
│  │              apps/gateway (TypeScript)                  │ │
│  │         API server receiving all commands               │ │
│  └──────────────────────────┬─────────────────────────────┘ │
│                             ↓                                │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                        CORE                             │ │
│  │               packages/core (TypeScript)                │ │
│  │        Agent orchestrator powered by Claude API         │ │
│  └──────────────────────────┬─────────────────────────────┘ │
│                             ↓                                │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    INTEGRATIONS                         │ │
│  │   packages/integration-* (various languages)            │ │
│  │   WhatsApp │ Gmail │ Calendar │ GitHub │ Notion │ ...   │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Languages & Tooling

| Language   | Use Case                        | Package Manager | Test Runner | Linter      |
|------------|--------------------------------|-----------------|-------------|-------------|
| TypeScript | Gateway, Core, most adapters   | pnpm            | vitest      | eslint      |
| Python     | ML, NLP, some integrations     | uv/pip          | pytest      | ruff        |
| Rust       | CLI, performance-critical      | cargo           | cargo test  | clippy      |
| Swift      | iOS app, Shortcuts             | SPM             | XCTest      | swiftlint   |
| Ruby       | Scripts, automation            | bundler         | rspec       | rubocop     |

## Task Runner

We use [Task](https://taskfile.dev) as the universal task runner. It wraps language-specific commands.

```bash
# Install Task: https://taskfile.dev/installation/

task              # Show all available tasks
task install      # Install all dependencies (all languages)
task build        # Build all packages
task test         # Run all tests
task lint         # Lint all code
task fmt          # Format all code
task ci           # Full CI pipeline

# Language-specific
task test:js      # Run only JS/TS tests
task test:python  # Run only Python tests
task test:rust    # Run only Rust tests

# Run in specific package
task run -- apps/gateway test
```

## Testing Requirements

**Every package MUST have tests.** No exceptions.

| Coverage Target | Package Type           |
|-----------------|------------------------|
| 90%+            | Core business logic    |
| 80%+            | Integrations, adapters |
| 70%+            | Utilities, helpers     |

### Test Structure

Each package should have:
```
package-name/
├── src/           # Source code
├── tests/         # Test files
│   ├── unit/      # Unit tests (fast, isolated)
│   └── integration/  # Integration tests (may need external services)
├── claude.md      # Package-specific guidance
└── ...            # Language-specific config
```

### Test Naming
- Test files: `*.test.ts`, `*_test.py`, `*_test.rs`, `*_test.swift`
- Describe what's being tested: `test_send_message_handles_rate_limit`

## Creating a New Package

### 1. Choose Location
- `apps/` - Standalone deployable (has a main entry point)
- `packages/` - Shared library (imported by other packages)

### 2. Create Structure

```bash
mkdir -p apps/my-app/src apps/my-app/tests
cd apps/my-app
```

### 3. Initialize for Your Language

**TypeScript:**
```bash
pnpm init
# Add to pnpm-workspace.yaml if not already included
```

**Python:**
```bash
touch pyproject.toml
# Configure with ruff, pytest
```

**Rust:**
```bash
cargo init
```

**Swift:**
```bash
swift package init --type executable  # or --type library
```

### 4. Add claude.md

Every package needs a `claude.md` explaining:
- What this package does
- Key files and their purposes
- Testing approach
- Any gotchas or special considerations

### 5. Add to CI

Ensure `.github/workflows/ci.yml` includes your package's language.

## Conventions

### Naming
- Folders: `lowercase-kebab-case`
- Packages: `@gellyfish/package-name` (for npm)
- Files: Language convention (snake_case for Python/Rust, camelCase for TS)

### Adapters
Named `adapters-{type}-{service}`:
- `adapters-input-telegram`
- `adapters-input-whatsapp`
- `adapters-output-push`

### Integrations
Named `integration-{service}`:
- `integration-gmail`
- `integration-github`
- `integration-notion`

### Commit Messages
```
<type>(<scope>): <description>

feat(gateway): add rate limiting
fix(integration-gmail): handle token refresh
test(core): add intent parsing tests
docs: update architecture diagram
```

Types: `feat`, `fix`, `test`, `docs`, `refactor`, `chore`, `ci`

## Security

- **Never commit secrets** - Use environment variables or `.env` files (gitignored)
- **Least privilege** - Integrations request minimum required permissions
- **Input validation** - Always validate at system boundaries
- **No logging of sensitive data** - Redact tokens, passwords, personal data

## Dependencies Between Packages

```
apps/gateway
  └── packages/core
        ├── packages/adapters-input-*
        ├── packages/adapters-output-*
        └── packages/integration-*
              └── packages/shared
```

Cross-language dependencies are handled via:
- APIs (HTTP/gRPC between services)
- FFI (for Rust libraries used from other languages)
- Shared schema files (protobuf, JSON Schema)

## Documentation

- `claude.md` - This file; always in Claude's memory. Keep concise.
- `docs/historical.md` - Changes that were removed (deprecated, outdated, problematic)
- `docs/monitoring.md` - Monitoring plan, runbooks, metrics (operational & business), logs

See `docs/` folder:
- `docs/architecture/` - System design, hybrid network architecture
- `docs/deployment/` - Docker, home server setup (VPN + Cloudflare), security
- `docs/development/` - Setup guides, contributing

## CI/CD

GitHub Actions runs on every PR:
1. **Detect changed packages** - Only test what changed
2. **Matrix build** - Run language-specific jobs in parallel
3. **Required checks** - All tests must pass, lint must pass
4. **Deploy** - On merge to main (for apps/)

See `.github/workflows/ci.yml` for details.

## Agent Development Environment

### Stuck Permission Requests (Hot Reload)

The gateway uses hot reload (`tsx watch`) during development. When an agent makes a tool call (Edit, Write, Bash, etc.), the gateway auto-approves it. But if the gateway restarts mid-request (from a hot reload triggered by file saves), the permission approval is lost and the agent hangs forever waiting for a response that will never come.

**If a tool call has no response after ~30 seconds:**
1. Assume the gateway restarted — don't wait forever
2. Retry the same tool call — the gateway will be back up and auto-approve will work
3. If the gateway is down (connection refused), wait 10 seconds and retry — it's probably mid hot-reload
4. Check gateway status: `curl -s http://localhost:3000/api/status`
