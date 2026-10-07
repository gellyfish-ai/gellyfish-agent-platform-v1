# Architecture Overview

Gellyfish is a personal AI agent platform designed to run on your home server.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      INPUT CHANNELS                          │
│   Siri Shortcuts │ WhatsApp │ Telegram │ SMS │ Voice        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                         GATEWAY                              │
│                    apps/gateway                              │
│                                                              │
│  • Receives all incoming commands                            │
│  • Authenticates requests                                    │
│  • Normalizes input from different sources                   │
│  • Routes to Core for processing                             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                          CORE                                │
│                    packages/core                             │
│                                                              │
│  • Powered by Claude API                                     │
│  • Parses user intent from natural language                  │
│  • Decides which integrations to call                        │
│  • Chains multiple actions together                          │
│  • Handles errors and confirmations                          │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     INTEGRATIONS                             │
│               packages/integration-*                         │
│                                                              │
│  Gmail │ Calendar │ WhatsApp │ GitHub │ Notion │ ...        │
│                                                              │
│  • Each handles one external service                         │
│  • Manages its own authentication                            │
│  • Exposes actions the Core can call                         │
└─────────────────────────────────────────────────────────────┘
```

## Components

### Gateway (`apps/gateway`)

The API server that receives all commands. Responsibilities:

- **Authentication**: Verify API keys, webhook signatures
- **Normalization**: Convert various input formats to unified Command
- **Rate limiting**: Prevent abuse
- **Logging**: Audit trail of all commands
- **Routing**: Forward to Core for processing

### Core (`packages/core`)

The brain of Gellyfish. Uses Claude API to:

- **Parse intent**: "Reply to Mom's WhatsApp" → send_message(to: mom, ...)
- **Plan actions**: Break complex requests into steps
- **Execute**: Call integrations in sequence
- **Handle errors**: Retry, ask for clarification, notify user

### Adapters

**Input Adapters** (`packages/adapters-input-*`):
Receive commands from various sources and normalize them.

| Adapter | Input | Normalization |
|---------|-------|---------------|
| Telegram | Telegram Bot API | Text message → Command |
| WhatsApp | WhatsApp Business API | Message webhook → Command |
| Siri | HTTP POST from Shortcut | JSON → Command |
| Voice | Audio file | Speech-to-text → Command |

**Output Adapters** (`packages/adapters-output-*`):
Send responses back to users.

| Adapter | Output |
|---------|--------|
| Push | iOS/Android push notification |
| SMS | Text message |
| Reply | Same channel as input |

### Integrations (`packages/integration-*`)

Connect to external services. Each integration:

- Handles its own OAuth/API authentication
- Exposes clear actions (verbs the agent can use)
- Returns structured results

Example integration interface:
```typescript
interface Integration {
  name: string;
  actions: {
    name: string;
    description: string;
    parameters: Schema;
  }[];
  execute(action: string, params: unknown): Promise<Result>;
}
```

## Data Flow

1. **User** says "Reply to Mom's WhatsApp saying I'll call tonight"
2. **Siri Shortcut** sends HTTP POST to Gateway
3. **Gateway** authenticates, normalizes, forwards to Core
4. **Core** (Claude API) parses intent:
   - Action: `send_whatsapp_message`
   - Recipient: "Mom" (needs resolution)
   - Content: "I'll call tonight"
5. **Core** calls `integration-whatsapp`:
   - `get_recent_conversations()` → finds "Mom"
   - `send_message(to: "+1234567890", text: "I'll call tonight")`
6. **Core** confirms via output adapter (push notification)
7. **User** receives "Sent WhatsApp to Mom: I'll call tonight"

## Security Model

- Gateway is the only public-facing component
- All internal communication is local (same machine)
- Credentials stored in environment variables
- Each integration uses least-privilege access
- Audit log of all commands and actions

## Deployment

Designed for home server deployment with a **hybrid network approach**:

```
┌─────────────────────────────────────────────────────────────┐
│                     YOUR DEVICES                             │
│              (phone, laptop, home network)                   │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │ VPN (Tailscale/WireGuard)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      HOME SERVER                             │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Docker / Podman Container                  │ │
│  │                                                         │ │
│  │            Gateway ──► Core ──► Integrations            │ │
│  │                                                         │ │
│  │   Port 7777 (VPN only)      Port 8080 (Cloudflare)     │ │
│  │   Full access, trusted      Webhooks only, verified     │ │
│  └────────────────────────────────────────────────────────┘ │
│                              │                               │
│  ┌───────────────────────────▼────────────────────────────┐ │
│  │              Reverse Proxy (Caddy/nginx)                │ │
│  │                 HTTPS termination                       │ │
│  └───────────────────────────┬────────────────────────────┘ │
└──────────────────────────────│──────────────────────────────┘
                               │
                               │ Cloudflare Tunnel
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    EXTERNAL SERVICES                         │
│          Telegram │ WhatsApp │ GitHub Webhooks               │
└─────────────────────────────────────────────────────────────┘
```

### Network Access Layers

| Layer | Access | Use Case |
|-------|--------|----------|
| **VPN (port 7777)** | Your devices only | Full API access, sensitive commands |
| **Cloudflare (public)** | External services | Webhook receivers (`/webhooks/*`) |

### Why Hybrid?

- **VPN path**: Zero public attack surface for personal commands. Your phone/laptop connects via Tailscale or WireGuard. Maximum security.
- **Cloudflare path**: Required for services that push to you (Telegram bots, WhatsApp webhooks). Cloudflare provides DDoS protection and hides your home IP.

### Webhook Security

External webhooks are scoped and verified:
- `/webhooks/telegram` - Validates Telegram bot token
- `/webhooks/whatsapp` - Validates WhatsApp signature
- `/webhooks/github` - Validates GitHub HMAC signature

All other endpoints require VPN access or API key authentication.
