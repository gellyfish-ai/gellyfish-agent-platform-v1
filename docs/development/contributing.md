# Contributing

## Development Workflow

1. **Create a branch** from `main`
   ```bash
   git checkout -b feat/my-feature
   ```

2. **Make changes** following the conventions in `claude.md`

3. **Test locally**
   ```bash
   task test    # Run all tests
   task lint    # Check linting
   ```

4. **Commit** with conventional commits
   ```bash
   git commit -m "feat(gateway): add rate limiting"
   ```

5. **Push and create PR**
   ```bash
   git push -u origin feat/my-feature
   ```

## Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `test` | Adding/updating tests |
| `refactor` | Code change that neither fixes bug nor adds feature |
| `chore` | Build process, dependencies, etc. |
| `ci` | CI/CD changes |

### Scope

Use the package name: `gateway`, `core`, `integration-gmail`, etc.

### Examples

```
feat(core): add intent parsing for calendar commands
fix(integration-gmail): handle expired OAuth tokens
test(adapters-telegram): add tests for message parsing
docs: update architecture diagram
chore(deps): update vitest to v1.0
```

## Pull Request Guidelines

1. **Title** should follow commit format: `feat(scope): description`
2. **Description** should explain:
   - What changed and why
   - How to test
   - Any breaking changes
3. **Tests** must pass
4. **Lint** must pass
5. **One package** per PR when possible (easier to review)

## Code Review

- All PRs require at least one approval
- Address all comments before merging
- Squash commits on merge

## Adding a New Package

See the `claude.md` files in `apps/` and `packages/` for detailed instructions.

Quick checklist:
- [ ] Create folder structure with `src/` and `tests/`
- [ ] Add language-specific config (package.json, Cargo.toml, etc.)
- [ ] Add `claude.md` explaining the package
- [ ] Add tests (required!)
- [ ] Update CI if new language

## Testing Requirements

Every package must have tests. Coverage targets:

| Package Type | Target |
|--------------|--------|
| Core logic | 90%+ |
| Integrations | 80%+ |
| Utilities | 70%+ |

Run coverage locally:
```bash
# JS/TS
pnpm run test -- --coverage

# Python
pytest --cov=src

# Rust
cargo tarpaulin
```

## Questions?

- Check existing `claude.md` files
- Look at similar packages for patterns
- Open an issue for discussion
