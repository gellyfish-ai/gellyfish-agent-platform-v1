# Gateway

HTTP API server + web UI for Gellyfish. Receives all incoming commands, manages profiles/crews/sessions, and routes them to Claude CLI processes.

## Development

```bash
pnpm install
pnpm dev          # Dev instance — tsx watch, port 3001, hot reload
pnpm test         # Run tests
pnpm build        # Build TypeScript to dist/
```

## Production

```bash
pnpm build        # Build first
pnpm start        # Prod instance — node dist/index.js, port 3000
```

## Running Dev + Prod Side by Side

Both instances share the same DB and Process Manager (same `data/` dir):

| | Dev | Prod |
|---|---|---|
| Command | `pnpm dev` | `pnpm start` |
| Port | 3001 | 3000 |
| Hot reload | Yes (tsx watch) | No |
| Entry | src/index.ts | dist/index.js |

Override with env vars: `PORT`, `HOST`, `DATA_DIR`, `PM_SOCKET`, `NODE_ENV`.

## Key Files

### Backend (TypeScript)

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, orphan cleanup, server start |
| `src/server.ts` | Fastify setup, route registration |
| `src/db.ts` | SQLite schema, migrations, DB helpers |
| `src/claude-spawn.ts` | **Shared** Claude CLI spawn helpers (args, cwd, system prompts, MCP config) |
| `src/config.ts` | Template loader for `config/prompts/` |
| `src/routes/chat-ws.ts` | WebSocket sessions (interactive Claude processes) |
| `src/routes/tasks.ts` | Task API (agent-to-agent communication) |
| `src/routes/settings.ts` | Settings API (auto-approve toggle) |
| `src/routes/sessions.ts` | Session CRUD + history |
| `src/routes/profiles.ts` | Profile CRUD (enriched with crews + MCPs) |
| `src/routes/crews.ts` | Crew CRUD + membership |
| `src/routes/mcps.ts` | MCP server management |
| `src/routes/transcribe.ts` | Voice input: audio upload → ffmpeg → whisper.cpp transcription |
| `config/prompts/` | Prompt templates (crew-lead, crew-member, base-profile) |

### Frontend (ES Modules)

#### Module Dependency Layers — STRICT RULES

Modules may only import from **lower layers**. Never import from the same layer or above.

```
Layer 0: utils.js              — Pure functions. Zero imports from our code.
Layer 1: state.js              — Shared state + resetSessionState(). Imports nothing.
Layer 2: connection.js          — WebSocket connect/disconnect. Imports: state.
Layer 3: session-manager.js     — ALL session transitions. Imports: state, connection, utils.
Layer 4: tabs.js, messages.js   — DOM + state. Imports: layers 0-3.
         input.js               — Input handling. Imports: layers 0-2, messages.
         tab-menu.js            — Tab context menu. Imports: state, utils, tabs.
Layer 5: profiles.js            — Profiles VIEW (rendering only). Imports: layers 0-4.
         sessions.js            — Sessions VIEW (rendering only). Imports: layers 0-4.
         crews.js               — Crews VIEW (rendering only). Imports: layers 0-4.
Layer 6: app.js                 — Routing + event wiring. Imports: everything.
                                  Wires session-manager callbacks at init.
```

**Rules that prevent spaghetti:**
- Views (layer 5) NEVER import from each other
- Session logic (start, resume, profile connect) lives ONLY in session-manager.js
- State resets go through `resetSessionState()` — never set fields individually
- WebSocket disconnect goes through `disconnect()` — never manipulate `state.ws` directly
- `session-manager.js` receives layer 4-6 deps via callbacks (set by app.js at init), not imports

**If you need to break a rule**, the architecture is wrong — fix it, don't hack around it.

## Backend Architecture

### Claude Process Lifecycle

1. WebSocket connects → `chat-ws.ts` checks `activeProcesses` map
2. If live process exists → reattach WebSocket
3. If not → spawn Claude CLI via `claude-spawn.ts` helpers
4. On WebSocket disconnect → 30s orphan timeout before killing process
5. On server restart → `index.ts` kills orphaned Claude processes (by `--permission-prompt-tool stdio` flag)

### Agent-to-Agent Communication

All agent-to-agent communication goes through `POST /api/tasks`:
1. Requires `creatorAgentId`, `assigneeAgentId`, `callerSessionId`, `message`
2. Resolves agent → conversation → session → process
3. Active process for assignee → inject message via `sendMessage()`
4. No active process → spawn with `claude --resume`, inject message
5. Task includes completion instructions with task ID
6. Agent calls `/api/tasks/:id/complete` or `/fail` when done
7. Creator notified via WebSocket + CLI process injection

### Data Model (Phase 5)

- **session_profiles** table removed — conversations table replaces it
- **tasks** table uses agent IDs only (no profile columns)
- Session lookups go through: conversation → agent → profile chain
- If data is missing, ERROR loudly — no silent fallbacks

### Config / Seed Data

- `config/prompts/*.md` — version-controlled prompt templates (not in DB)
- `config/skills/` — global and crew skills, symlinked at spawn time
- MCP definitions from HQ repo (`HQ_PATH` env var) or existing DB
- Global MCPs merged at spawn time (no join table needed)
- Per-profile MCPs via `profile_mcps` join table
- `.env` loaded via dotenv — `DATA_DIR`, `PORT`, `HOST`, `NODE_ENV`, `HQ_PATH`, `WHISPER_BIN`, `WHISPER_MODEL`

### Voice Input

Audio recording → transcription pipeline:

1. Web UI records audio via MediaRecorder (WebM format)
2. `POST /api/transcribe` receives audio + language param (en/es/ca/ja)
3. Gateway converts WebM → WAV via ffmpeg
4. Whisper.cpp transcribes WAV → text
5. Transcript returned to UI, injected into chat input

**Setup:** Run `scripts/setup-whisper.sh` to install whisper.cpp and download the medium model.

**HTTPS limitation:** MediaRecorder requires HTTPS. Voice input works on localhost (Mac Mini direct access) but NOT from remote devices over HTTP (e.g., iPhone via VPN at http://10.0.0.1). For mobile voice input, use the iOS app wrapper (`apps/ios-app/`) which uses Apple's native Speech framework and doesn't require HTTPS.

### MCP Strict Config

Agents are spawned with `--strict-mcp-config` flag. This means agents ONLY see MCPs assigned to their profile in the DB — the repo-level `.mcp.json` is ignored. Per-profile MCP assignments are the single source of truth.

### iOS App

Native iOS app at `apps/ios-app/` (SwiftUI + WKWebView). Wraps the gateway web UI with native capabilities:
- Native mic access (bypasses HTTPS requirement)
- Apple Speech framework for on-device transcription
- Configurable server URL (default: http://10.0.0.1:3000)
- JavaScript bridge: `window.gellyfish` for native ↔ web communication
