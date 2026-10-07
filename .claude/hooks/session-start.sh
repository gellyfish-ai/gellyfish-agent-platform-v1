#!/bin/bash
set -euo pipefail

# Only run in remote/web environment
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

echo "Installing dependencies for Gellyfish..."

# Install GitHub CLI
if ! command -v gh &> /dev/null; then
  echo "Installing gh CLI..."
  apt-get update -qq
  apt-get install -y -qq gh
fi

# Note: Task (taskfile.dev) installation skipped - GitHub downloads blocked by proxy
# When packages are added, consider installing via: npm install -g @go-task/cli
# or using language-specific tools directly (pnpm, cargo, etc.)

echo "Dependencies installed successfully!"
