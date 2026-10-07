#!/bin/bash
# Run the Twilio MCP as a persistent Docker container.
#
# Credentials are mounted from the host's config directory — never baked into the image.
# The inbox DB is also persisted on the host.
#
# Prerequisites:
#   - Docker installed
#   - ~/.config/gellyfish/twilio.env exists with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, etc.
#
# Usage:
#   ./docker-run.sh          # build + run
#   ./docker-run.sh rebuild  # force rebuild

set -euo pipefail

IMAGE_NAME="gellyfish-twilio-mcp"
CONTAINER_NAME="gellyfish-twilio-mcp"
CONFIG_DIR="${HOME}/.config/gellyfish"
PORT=8200

# Build (or rebuild)
if [ "${1:-}" = "rebuild" ] || ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
  echo "Building $IMAGE_NAME..."
  docker build -t "$IMAGE_NAME" "$(dirname "$0")"
fi

# Stop existing container if running
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "Stopping existing container..."
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

echo "Starting $CONTAINER_NAME on port $PORT..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart=always \
  -p "$PORT:$PORT" \
  -e MCP_TRANSPORT=sse \
  -e MCP_PORT="$PORT" \
  -e TWILIO_ENV_FILE=/config/twilio.env \
  -e TWILIO_DB_PATH=/data/inbox.db \
  -v "$CONFIG_DIR:/config:ro" \
  -v "$CONFIG_DIR:/data" \
  "$IMAGE_NAME"

echo "Running. Check logs: docker logs -f $CONTAINER_NAME"
