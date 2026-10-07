# mcp-keychain-swift

A secure MCP (Model Context Protocol) server for macOS Keychain access with browser automation capabilities.

## Features

- **Secure password filling** - Fill password fields in browsers via CDP without exposing credentials
- **Safe snapshots** - Take accessibility snapshots with password values automatically redacted
- **Keychain integration** - Access macOS Keychain passwords securely

## Security Model

This MCP server is designed with security as the primary concern:

| Principle | Implementation |
|-----------|----------------|
| No credential exposure | Passwords never returned in tool responses |
| Secure transport | Password passed to CDP via environment variable |
| Redacted snapshots | Password field values replaced with `[REDACTED]` |
| Minimal surface | 3 tools: fill, snapshot, list (no password retrieval) |

### Password Lookup Order

1. **Native Security.framework** - tries `SecItemCopyMatching` with iCloud sync enabled
2. **Automation keychain** - falls back to `~/Library/Keychains/automation.keychain-db`

The automation keychain is used for non-interactive access (no Touch ID prompts).

## Tools

### `fill_password`

Securely fill a password field in the browser.

```json
{
  "service": "microsoftonline.com",
  "account": "user@example.com",
  "selector": "input[type=password]"
}
```

**How it works:**
1. Tries native Security.framework first (for iCloud-accessible passwords)
2. Falls back to automation keychain for non-interactive access
3. Connects to Chrome via CDP (localhost:9222)
4. Fills the password field using DOM manipulation
5. Returns only success/failure status

### `safe_snapshot`

Take an accessibility snapshot with password values redacted.

```json
{}
```

**Returns:** Page snapshot in YAML format with any password field values replaced with `[REDACTED]`.

### `list_credentials`

List all available credentials (service/account pairs) without exposing passwords.

```json
{}
```

**Returns:** Markdown table showing:
- Type (generic/internet)
- Service name
- Account name
- iCloud sync status (yes/no)

## Requirements

- macOS (uses Security.framework)
- Chrome running with `--remote-debugging-port=9222`
- Node.js (for CDP scripts)
- Password stored in Keychain

## Installation

### Build

```bash
cd packages/mcp-keychain-swift
swift build -c release
npm install  # For ws module used by CDP scripts
```

### Configure MCP

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "keychain": {
      "command": "/path/to/mcp-keychain-swift/.build/release/mcp-keychain-swift"
    }
  }
}
```

### Store Password in Keychain

```bash
security add-generic-password \
  -a "user@example.com" \
  -s "service.com" \
  -w "your-password" \
  -U \
  ~/Library/Keychains/automation.keychain-db
```

**Important:** Never pass passwords through Claude/MCP - always use direct terminal input.

### Launch Chrome with CDP

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/path/to/profile
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Claude Code    │────▶│  mcp-keychain    │────▶│  macOS Keychain │
│                 │     │  (Swift MCP)     │     │                 │
└─────────────────┘     └────────┬─────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌──────────────────┐     ┌─────────────────┐
                        │  CDP Scripts     │────▶│  Chrome Browser │
                        │  (Node.js)       │     │  (port 9222)    │
                        └──────────────────┘     └─────────────────┘
```

## Files

| File | Purpose |
|------|---------|
| `Sources/mcp-keychain-swift/main.swift` | MCP server implementation |
| `fill-password.js` | CDP script for secure password filling |
| `safe-snapshot.js` | CDP script for redacted snapshots |
| `Package.swift` | Swift package manifest |

## Why Swift?

- Native macOS Keychain access via Security.framework
- No external dependencies for core functionality
- Fast startup time for MCP server
- Type-safe JSON-RPC handling

## License

MIT
