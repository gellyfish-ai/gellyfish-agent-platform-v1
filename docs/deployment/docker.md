# Docker Deployment

Container-based deployment for Gellyfish.

## Quick Start

```bash
# Build and run
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

## Docker Compose

```yaml
version: '3.8'

services:
  gateway:
    build:
      context: .
      dockerfile: apps/gateway/Dockerfile
    ports:
      - "7777:3000"   # VPN access
      - "8080:3000"   # Webhook access
    environment:
      - NODE_ENV=production
    env_file:
      - .env
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## Gateway Dockerfile

```dockerfile
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies
COPY apps/gateway/package.json apps/gateway/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# Build
COPY apps/gateway/ ./
RUN pnpm build

# Production image
FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | No | `production` or `development` |
| `PORT` | No | Server port (default: 3000) |
| `HOST` | No | Bind address (default: 0.0.0.0) |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` |
| `ANTHROPIC_API_KEY` | Yes | Claude API key |

## Building Images

```bash
# Build gateway
docker build -t gellyfish/gateway -f apps/gateway/Dockerfile .

# Build all services
docker compose build
```

## Development with Docker

```bash
# Run with hot reload
docker compose -f docker-compose.dev.yml up
```

`docker-compose.dev.yml`:

```yaml
version: '3.8'

services:
  gateway:
    build:
      context: .
      dockerfile: apps/gateway/Dockerfile.dev
    ports:
      - "3000:3000"
    volumes:
      - ./apps/gateway/src:/app/src
    environment:
      - NODE_ENV=development
    command: pnpm dev
```
