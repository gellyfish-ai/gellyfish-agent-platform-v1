# Home Server Deployment

Guide for deploying Gellyfish on your home server with the hybrid network approach.

## Prerequisites

- Home server (Linux recommended)
- Docker or Podman installed
- Domain name (for Cloudflare Tunnel)
- Tailscale or WireGuard account

## Network Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     YOUR DEVICES                             │
│              (phone, laptop, home network)                   │
└──────────────────────────┬──────────────────────────────────┘
                           │ VPN (Tailscale/WireGuard)
                           ▼
                    ┌──────────────┐
                    │  Port 7777   │ ← Full access
                    │  (internal)  │
                    └──────┬───────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                   GELLYFISH GATEWAY                          │
└──────────────────────────▲──────────────────────────────────┘
                           │
                    ┌──────┴───────┐
                    │  Cloudflare  │ ← Webhooks only
                    │  (public)    │
                    └──────┬───────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                   EXTERNAL SERVICES                          │
│           Telegram │ WhatsApp │ GitHub Webhooks              │
└─────────────────────────────────────────────────────────────┘
```

## Step 1: VPN Setup (Tailscale)

Tailscale is the easiest option for personal use.

### Install on Server

```bash
# Linux
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

### Install on Devices

- **iOS**: App Store → Tailscale
- **macOS**: `brew install tailscale`
- **Android**: Play Store → Tailscale

### Verify Connection

```bash
# On your device
tailscale status

# Should show your server's Tailscale IP (e.g., 100.x.x.x)
```

## Step 2: Cloudflare Tunnel Setup

For external webhooks (Telegram, WhatsApp, etc.)

### Install cloudflared

```bash
# Linux
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/
```

### Create Tunnel

```bash
# Login to Cloudflare
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create gellyfish

# Route DNS
cloudflared tunnel route dns gellyfish webhooks.your-domain.com
```

### Configure Tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <your-tunnel-id>
credentials-file: /home/user/.cloudflared/<tunnel-id>.json

ingress:
  # Only expose webhook endpoints
  - hostname: webhooks.your-domain.com
    path: /webhooks/*
    service: http://localhost:8080
  # Catch-all (reject everything else)
  - service: http_status:404
```

### Run as Service

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

## Step 3: Deploy Gellyfish

### Docker Compose

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  gateway:
    build: ./apps/gateway
    ports:
      - "7777:3000"   # VPN access (internal)
      - "8080:3000"   # Cloudflare access (webhooks)
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=info
    env_file:
      - .env
    restart: unless-stopped
```

### Environment Variables

Create `.env`:

```bash
# API Keys
ANTHROPIC_API_KEY=sk-ant-...

# Webhook secrets (for verification)
TELEGRAM_BOT_TOKEN=...
WHATSAPP_VERIFY_TOKEN=...
GITHUB_WEBHOOK_SECRET=...

# Optional
LOG_LEVEL=info
```

### Start Services

```bash
docker compose up -d
```

## Step 4: Configure Input Channels

### Siri Shortcuts (via VPN)

Your Siri Shortcut should POST to your Tailscale IP:

```
http://100.x.x.x:7777/api/command
```

### Telegram Bot (via Cloudflare)

Set webhook to your Cloudflare domain:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://webhooks.your-domain.com/webhooks/telegram"
```

## Verification

### Test VPN Path

```bash
# From your device (on Tailscale)
curl http://100.x.x.x:7777/health
# Should return: {"status":"ok",...}
```

### Test Cloudflare Path

```bash
# From anywhere
curl https://webhooks.your-domain.com/webhooks/telegram
# Should return 401 or webhook-specific response
```

### Test Public Endpoints are Blocked

```bash
# This should NOT work
curl https://webhooks.your-domain.com/api/command
# Should return 404 (blocked by Cloudflare config)
```

## Security Checklist

- [ ] VPN installed and working on all your devices
- [ ] Cloudflare Tunnel only exposes `/webhooks/*`
- [ ] Webhook verification enabled for each service
- [ ] `.env` file is gitignored
- [ ] No ports exposed to public internet directly
- [ ] Docker container runs as non-root user

## Troubleshooting

### Can't connect via VPN

```bash
# Check Tailscale status
tailscale status

# Ping server
ping 100.x.x.x
```

### Webhooks not arriving

```bash
# Check Cloudflare Tunnel status
cloudflared tunnel info gellyfish

# Check logs
sudo journalctl -u cloudflared -f
```

### Gateway not responding

```bash
# Check container
docker compose logs gateway

# Check if port is listening
ss -tlnp | grep 3000
```
