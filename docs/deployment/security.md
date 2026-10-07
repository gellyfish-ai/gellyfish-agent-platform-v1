# Security

Security considerations for running Gellyfish.

## Network Security

### Hybrid Access Model

Gellyfish uses a hybrid network model:

| Access Path | Who | What |
|-------------|-----|------|
| VPN (Tailscale/WireGuard) | You only | Full API access |
| Cloudflare Tunnel | External services | Webhooks only |

### Why Not Just Public?

- Home IP stays hidden
- Zero attack surface for main API
- DDoS protection via Cloudflare
- Webhooks are scoped and verified

### Port Exposure

```
DO:
  - Expose 7777 internally (VPN only)
  - Use Cloudflare Tunnel for webhooks

DON'T:
  - Open ports on your router
  - Expose API to public internet
  - Skip webhook verification
```

## Authentication

### API Authentication

All `/api/*` endpoints require authentication:

```http
POST /api/command
Authorization: Bearer <api-key>
```

API keys are generated and stored securely. Never commit them.

### Webhook Verification

Each webhook endpoint verifies requests:

| Service | Verification |
|---------|--------------|
| Telegram | Bot token in URL path |
| WhatsApp | X-Hub-Signature-256 header |
| GitHub | X-Hub-Signature-256 header |

Example Telegram verification:

```typescript
// URL includes secret token
// /webhooks/telegram/<bot-token>
if (request.params.token !== process.env.TELEGRAM_BOT_TOKEN) {
  return reply.status(401).send('Unauthorized');
}
```

## Secrets Management

### Environment Variables

Store all secrets in `.env`:

```bash
# .env (NEVER commit this)
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=...
WHATSAPP_VERIFY_TOKEN=...
```

### Gitignore

Ensure secrets are never committed:

```gitignore
# .gitignore
.env
.env.*
*.pem
*.key
credentials.json
```

### Docker Secrets (Production)

For production, consider Docker secrets:

```yaml
services:
  gateway:
    secrets:
      - anthropic_api_key
    environment:
      - ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic_api_key

secrets:
  anthropic_api_key:
    file: ./secrets/anthropic_api_key.txt
```

## Integration Security

### Least Privilege

Each integration requests minimum permissions:

| Integration | Scope |
|-------------|-------|
| Gmail | `gmail.send`, `gmail.readonly` |
| Calendar | `calendar.events` |
| GitHub | `repo` (specific repos only) |

### Token Storage

OAuth tokens are stored encrypted at rest. Refresh tokens are used to minimize exposure.

### Audit Logging

All actions are logged:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "action": "send_email",
  "integration": "gmail",
  "user_id": "user-123",
  "status": "success",
  "trace_id": "abc-123"
}
```

Sensitive data (email content, message bodies) is NOT logged.

## Checklist

### Before Deployment

- [ ] All secrets in `.env` (not committed)
- [ ] `.env` in `.gitignore`
- [ ] Webhook verification enabled
- [ ] VPN configured
- [ ] Cloudflare Tunnel scoped to `/webhooks/*`

### Ongoing

- [ ] Rotate API keys periodically
- [ ] Review audit logs
- [ ] Update dependencies
- [ ] Monitor for unusual activity
