#!/bin/bash
# start-dev-gateway.sh — Starts the dev gateway (tsx watch, port 3001).
#
# Usage:
#   ./scripts/start-dev-gateway.sh              # start on current branch
#   ./scripts/start-dev-gateway.sh feat/my-branch  # checkout branch first
#
# What it does:
#   1. Kills any existing dev gateway on port 3001
#   2. Optionally checks out the given branch
#   3. Starts tsx watch with PORT=3001
#   4. Health check after startup

set -e

# Resolve paths relative to this script's location
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATEWAY_DIR="$REPO_ROOT/apps/gateway"
LOG="/tmp/dev-gateway.log"
BRANCH="${1:-}"

echo "[$(date)] Starting dev gateway" > "$LOG"

# 1. Kill any existing dev gateway on port 3001
echo "[$(date)] Killing any process on port 3001..." >> "$LOG"
lsof -ti :3001 | xargs kill 2>/dev/null || true
sleep 1

# 2. Checkout branch if given
if [ -n "$BRANCH" ]; then
    echo "[$(date)] Checking out branch: $BRANCH" >> "$LOG"
    cd "$REPO_ROOT"
    git checkout "$BRANCH" >> "$LOG" 2>&1
fi

# 3. Start dev gateway
echo "[$(date)] Starting tsx watch on port 3001..." >> "$LOG"
cd "$GATEWAY_DIR"
nohup pnpm dev >> "$LOG" 2>&1 &
DEV_PID=$!

echo "[$(date)] Dev gateway started with PID $DEV_PID" >> "$LOG"

# 4. Health check (tsx watch takes a moment to compile)
sleep 10
if curl -s http://localhost:3001/api/status > /dev/null 2>&1; then
    echo "[$(date)] Dev gateway is healthy on port 3001" >> "$LOG"
    echo "Dev gateway running on http://localhost:3001 (PID $DEV_PID)"
else
    echo "[$(date)] WARNING: Dev gateway health check failed" >> "$LOG"
    echo "WARNING: Health check failed — check $LOG"
fi
