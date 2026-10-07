# Documentation

This folder contains all project documentation.

## Structure

```
docs/
├── architecture/           # System design and diagrams
│   └── overview.md         # High-level architecture
├── development/            # Developer guides
│   ├── getting-started.md  # Setup and first steps
│   └── contributing.md     # How to contribute
├── deployment/             # Deployment guides
│   ├── docker.md           # Container deployment
│   ├── home-server.md      # Home server setup (VPN + Cloudflare)
│   └── security.md         # Security best practices
├── historical.md           # Removed/deprecated changes
├── monitoring.md           # Metrics, logs, alerts, runbooks
└── claude.md               # You are here
```

### Planned (not yet created)

- `architecture/decisions/` - Architecture Decision Records
- `api/` - API documentation (OpenAPI specs)
- `integrations/` - Integration guides

## Writing Documentation

### Guidelines

1. **Write for your audience**
   - `architecture/` - For developers understanding the system
   - `development/` - For contributors getting started
   - `api/` - For developers using our APIs
   - `deployment/` - For operators running Gellyfish

2. **Keep it up to date**
   - Update docs when you change code
   - PRs that change behavior should include doc updates

3. **Use examples**
   - Code samples should be copy-pasteable
   - Include expected output where helpful

4. **Link, don't duplicate**
   - Reference other docs instead of copying
   - Keep single source of truth

### Markdown Conventions

- Use ATX headers (`#`, `##`, `###`)
- Code blocks with language identifier
- Tables for structured data
- Relative links between docs

### Architecture Decision Records (ADRs)

For significant decisions, create an ADR in `architecture/decisions/`:

```markdown
# ADR-001: Use Task as Universal Task Runner

## Status
Accepted

## Context
We need a way to run build/test/lint across multiple languages.

## Decision
Use Task (taskfile.dev) as the universal task runner.

## Consequences
- All developers need to install Task
- Language-specific commands wrapped in Taskfile.yml
- Consistent interface across languages
```

## Building Documentation

We use plain Markdown. For local preview:

```bash
# Any markdown preview tool works
# Example with grip (GitHub-flavored):
pip install grip
grip docs/

# Or use your editor's markdown preview
```

## What NOT to Document Here

- **API schemas** - Use OpenAPI/Swagger in `apps/gateway/`
- **Code comments** - Document in the code itself
- **Package-specific docs** - Each package has its own README.md

## When to Create Documentation

1. **New feature** - Add to relevant section
2. **New integration** - Add to `integrations/available/`
3. **Architecture change** - Create an ADR
4. **Common question** - Add to relevant guide
