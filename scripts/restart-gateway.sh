#!/bin/bash
# restart-gateway.sh — Restarts this repo's gateway.
# Reads PORT from the gateway's .env file to only kill/check the correct process.
# SAFE: pulls and builds BEFORE killing — if anything fails, the running gateway is untouched.
#
# Usage (by an agent via mac-automation):
#   nohup /path/to/scripts/restart-gateway.sh &

set -e

# Resolve paths relative to this script's location
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATEWAY_DIR="$REPO_ROOT/apps/gateway"
LOG="/tmp/gateway-restart-$(basename "$REPO_ROOT").log"
MCP_MOBILE_DIR="${MCP_MOBILE_DIR:-$HOME/Workspace/mcp-mobile}"

# Read PORT from .env
PORT=$(grep '^PORT=' "$GATEWAY_DIR/.env" 2>/dev/null | cut -d= -f2)
if [ -z "$PORT" ]; then
    echo "ERROR: No PORT in $GATEWAY_DIR/.env" >&2
    exit 1
fi

echo "[$(date)] Starting gateway restart (port $PORT, repo $(basename "$REPO_ROOT"))" > "$LOG"

# === PHASE 1: Prepare (gateway stays running) ===

# 1. Pull latest code
echo "[$(date)] Pulling latest code..." >> "$LOG"
cd "$REPO_ROOT"
if ! git pull >> "$LOG" 2>&1; then
    echo "[$(date)] ERROR: git pull failed — aborting restart, gateway untouched" >> "$LOG"
    exit 1
fi

# 2. Install deps
echo "[$(date)] Installing dependencies..." >> "$LOG"
cd "$GATEWAY_DIR"
if ! pnpm install --frozen-lockfile >> "$LOG" 2>&1; then
    echo "[$(date)] ERROR: pnpm install failed — aborting restart, gateway untouched" >> "$LOG"
    exit 1
fi

# 3. Build gateway
echo "[$(date)] Building gateway..." >> "$LOG"
if ! pnpm build >> "$LOG" 2>&1; then
    echo "[$(date)] ERROR: build failed — aborting restart, gateway untouched" >> "$LOG"
    exit 1
fi

# 4. Build mobile-mcp fork (if it exists)
if [ -d "$MCP_MOBILE_DIR" ]; then
    echo "[$(date)] Building mobile-mcp..." >> "$LOG"
    cd "$MCP_MOBILE_DIR"
    npm run build >> "$LOG" 2>&1 || true
fi

# === PHASE 2: Swap (only after successful build) ===

# 5. Kill current gateway by port
echo "[$(date)] Killing gateway on port $PORT..." >> "$LOG"
PIDS=$(lsof -ti :$PORT 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill 2>/dev/null || true
    sleep 3
fi

if lsof -ti :$PORT > /dev/null 2>&1; then
    echo "[$(date)] Gateway still alive, force killing..." >> "$LOG"
    lsof -ti :$PORT | xargs kill -9 2>/dev/null || true
    sleep 2
fi

# 6. Start gateway
echo "[$(date)] Starting gateway on port $PORT..." >> "$LOG"
cd "$GATEWAY_DIR"
nohup node dist/index.js >> "$LOG" 2>&1 &
GATEWAY_PID=$!

echo "[$(date)] Gateway started with PID $GATEWAY_PID" >> "$LOG"

# 7. Health check
sleep 5
if curl -s http://localhost:$PORT/health > /dev/null 2>&1; then
    echo "[$(date)] Gateway is healthy on port $PORT" >> "$LOG"
else
    echo "[$(date)] WARNING: Gateway health check failed on port $PORT" >> "$LOG"
fi

echo "[$(date)] Restart complete" >> "$LOG"
