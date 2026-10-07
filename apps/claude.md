# Apps

This folder contains **deployable applications** - standalone services with their own entry points.

## What Goes Here

- API servers (e.g., `gateway/`)
- CLI tools (e.g., `cli/`)
- Mobile apps (e.g., `ios-shortcuts/`)
- Workers/daemons
- Anything with a `main()` function that runs independently

## What Does NOT Go Here

- Shared libraries → use `packages/`
- Utilities imported by multiple apps → use `packages/`

## Structure of an App

Each app is self-contained:

```
apps/my-app/
├── src/                    # Source code
│   └── main.ts             # Entry point
├── tests/
│   ├── unit/               # Fast, isolated tests
│   └── integration/        # Tests with external deps
├── claude.md               # App-specific guidance
├── Dockerfile              # Container build (if applicable)
├── package.json            # Or Cargo.toml, pyproject.toml, etc.
└── README.md               # User-facing docs for this app
```

## Current Apps

| App | Language | Purpose | Status |
|-----|----------|---------|--------|
| `gateway/` | TypeScript | Main API server - receives all commands | Implemented |
| `cli/` | Rust | Command-line interface for local use | Planned |
| `ios-shortcuts/` | Swift | iOS app for Siri integration | Planned |

## Creating a New App

1. Create the folder structure:
   ```bash
   mkdir -p apps/my-app/src apps/my-app/tests/unit apps/my-app/tests/integration
   ```

2. Initialize for your language (see examples in existing apps)

3. Add a `claude.md` explaining:
   - What this app does
   - How to run it locally
   - Key files and entry points
   - Testing approach
   - Deployment notes

4. Add a `Dockerfile` if this will be containerized

5. Update CI if adding a new language

## Apps Can Depend On

- Any package in `packages/`
- External dependencies via their package manager
- Other apps only via APIs (no direct imports)

## Testing Requirements

Apps should have:
- Unit tests for business logic
- Integration tests for API endpoints / CLI commands
- E2E tests if user-facing

Target: **80%+ coverage** for core functionality.

## Deployment

Each app manages its own deployment:
- `Dockerfile` for container builds
- CI deploys on merge to main
- See `.github/workflows/` for deployment configuration
