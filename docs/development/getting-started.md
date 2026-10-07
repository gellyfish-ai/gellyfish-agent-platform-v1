# Getting Started

This guide helps you set up your development environment for Gellyfish.

## Prerequisites

### Required

- **Git** - Version control
- **Task** - Universal task runner ([install](https://taskfile.dev/installation/))

### Language-Specific (install as needed)

| Language | Tools Required |
|----------|---------------|
| TypeScript | Node.js 20+, pnpm |
| Python | Python 3.12+, uv or pip |
| Rust | Rust 1.75+, cargo |
| Swift | Xcode 15+ (macOS only) |

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/gellyfish.git
cd gellyfish
```

### 2. Install Task

```bash
# macOS
brew install go-task

# Linux (script)
sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d -b ~/.local/bin

# Windows (scoop)
scoop install task

# Or see: https://taskfile.dev/installation/
```

### 3. Install Dependencies

```bash
# Install all dependencies (all languages)
task install

# Or install specific languages
task install:js
task install:python
task install:rust
```

### 4. Verify Setup

```bash
# Run all tests
task test

# Run linting
task lint
```

## Project Structure

```
gellyfish/
├── apps/           # Deployable applications
├── packages/       # Shared libraries
├── docs/           # Documentation
├── .github/        # CI/CD workflows
├── Taskfile.yml    # Task runner config
└── claude.md       # AI assistant guidance
```

See the root `claude.md` for detailed structure and conventions.

## Common Tasks

```bash
task              # List all available tasks
task test         # Run all tests
task lint         # Lint all code
task fmt          # Format all code
task build        # Build all packages
task ci           # Run full CI pipeline locally
task clean        # Clean all build artifacts
```

## Working on a Package

Each package is self-contained:

```bash
cd apps/gateway    # Navigate to package
pnpm test          # Run package-specific tests (or cargo test, pytest, etc.)
```

Or use task from root:

```bash
task run -- apps/gateway pnpm test
```

## Next Steps

- Read `claude.md` in each folder you'll work on
- Check `docs/contributing.md` for contribution guidelines
- Look at existing packages for patterns to follow
