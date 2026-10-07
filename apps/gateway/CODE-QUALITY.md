# Code Quality Guidelines — GAP Gateway

## Why This Exists

The gateway codebase has accumulated severe technical debt from shipping features without maintaining quality. Session management is broken, workspace paths are inconsistent, data model is confused. This document exists to prevent that from happening again.

Every developer (human or agent) MUST follow these rules.

## Core Principles

### 1. Understand Before Changing

**NEVER** modify code you haven't fully read and understood. Before touching a function:
- Read the entire function
- Read what calls it
- Read what it calls
- Understand the data flow end to end

If you can't explain what a function does and why, you are not ready to change it.

### 2. One Source of Truth

Every piece of data has exactly ONE authoritative source. Not two. Not "one with a fallback."

| Data | Source of Truth | NOT a source |
|------|----------------|--------------|
| Profile definition | gellyfish-hq/GAP/profiles/ | Gateway DB |
| Agent workspace | ~/.gellyfish/workspaces/{agent-slug}/ | data/workspaces/ (DELETED) |
| Session files (.jsonl) | ~/.claude/projects/{project-hash}/ | Nowhere else |
| MCP assignments | Gateway DB (profile_mcps table) | .mcp.json (generated at spawn) |
| Agent state | Gateway DB (agents table) | Process manager (ephemeral) |

If you find yourself writing "try X, fall back to Y, fall back to Z" — the data model is wrong. Fix the model, don't add fallbacks.

### 3. No Hacks, No Workarounds

If a fix requires:
- Copying files to multiple locations
- Trying multiple path patterns
- "Just clearing the DB field"
- Silent fallbacks that hide failures

Then you are NOT fixing the problem. You are making it worse. Find the root cause.

### 4. Fail Loud

Every error must be visible. If something goes wrong:
- Log it with context (what, where, why)
- Return an error to the caller
- Show it in the UI

NEVER swallow errors. NEVER `catch { /* ignore */ }` unless you can explain exactly why ignoring is correct.

### 5. Test Your Changes

Before committing:
- Verify the happy path works
- Verify the error path works
- Verify existing functionality still works
- Check for regressions in related code

"It compiles" is not "it works."

## Data Model Rules

### Sessions

A session is a Claude CLI conversation. It has:
- A unique ID (UUID)
- A .jsonl file on disk at a deterministic path
- A reference in the conversations table

Rules:
- ONE conversation points to ONE session at a time
- The .jsonl path is determined by: `~/.claude/projects/{cwdToProjectPath(workspace_dir)}/{session_id}.jsonl`
- `cwdToProjectPath` replaces BOTH `/` and `.` with `-` (matching CLI behavior)
- If a .jsonl doesn't exist, the session is invalid — don't pretend it's fine
- NEVER create a DB reference to a session without verifying the .jsonl exists

### Workspaces

A workspace is where an agent runs. It contains:
- CLAUDE.md (copied from HQ at creation, synced bidirectionally)
- .mcp.json (generated at spawn from DB)
- .claude/commands/ (skill symlinks)

Rules:
- Each AGENT has their own workspace (not per-profile)
- Workspace path: `~/.gellyfish/workspaces/{agent-name-slug}/`
- HQ is the source of truth for initial CLAUDE.md content
- The workspace is the working directory passed to Claude CLI
- The CLI creates .jsonl files based on this working directory

### Profiles vs Agents

- A **profile** is a job description. It defines: system prompt, MCP assignments, crew membership.
- An **agent** is an instance. It has: a workspace, a conversation, sessions, a running process.
- Profiles do NOT have workspaces. Agents do.
- Two agents from the same profile have SEPARATE workspaces.

## Code Rules

### Path Handling

- NEVER hardcode absolute paths
- ALWAYS use path resolution functions (cwdToProjectPath, resolveWorkingDir)
- ALWAYS verify a path exists before using it
- The CLI encodes paths by replacing `/` AND `.` with `-`

### Database

- NEVER update the DB without verifying the change is valid
- NEVER clear a session_id without checking if the .jsonl exists elsewhere first
- Destructive operations (DELETE, UPDATE to NULL) require justification in the commit message

### Error Handling

- Use try/catch with meaningful error messages
- Log errors with context: `{ error, agentId, sessionId, path }`
- Return appropriate HTTP status codes (400, 404, 500)
- NEVER return 200 when something failed

### Frontend

- Module imports follow the layer rules in CLAUDE.md
- DOM queries are lazy (in init functions, not at module level)
- No circular imports
- Guard all element access with null checks

## Review Checklist

Before merging ANY PR, verify:

- [ ] Does the change have a clear purpose (linked issue)?
- [ ] Is the data model correct (one source of truth)?
- [ ] Are paths resolved correctly (cwdToProjectPath)?
- [ ] Are errors handled and surfaced?
- [ ] Does existing functionality still work?
- [ ] Are there any silent fallbacks that hide bugs?
- [ ] Is the code readable without comments explaining hacks?

## Known Debt (to fix, not to work around)

1. **Workspace model** — #288: workspaces are per-profile, should be per-agent
2. **Session file resolution** — scans multiple locations instead of one deterministic path
3. **Process manager session tracking** — can hold stale session IDs
4. **Tab restoration** — depends on server state that may be stale
5. **HQ sync** — watches wrong directory, needs to watch agent workspaces
