# Agent Model — Design Document

> **Status:** Approved
> **Issue:** [#28](https://github.com/gellyfish-ai/Gellyfish-Agent-Platform/issues/28)
> **Date:** 2026-03-18
> **Authors:** Gellyfish Coordinator + CEO

---

## Overview

This document defines how Gellyfish models AI workers: **Profiles**, **Agents**, **Conversations**, **Crews**, and the three-layer runtime model (Conversation / Session / Process).

All design decisions were made collaboratively between the Coordinator and CEO on 2026-03-18.

---

## Naming Framework

User-facing language must be friendly to non-technical users. No jargon.

| User-facing | Internal/code | What it is |
|-------------|---------------|------------|
| **Profile** | `profile` | Role definition — system prompt, MCPs, icon. The job description. |
| **Agent** | `agent` | A hired worker from a profile. Gets a name. |
| **Conversation** | `session` (backend) | What the user sees in chat tabs. Permanent, DB-owned. |
| **Crew** | `crew` | A team of agents with a lead. |

### Natural language examples

- "You have 3 Coder agents working."
- "Hire a Coder." → spawns a new agent from the Coder profile
- "Fire agent Alex." → soft-stops the agent
- "Open conversation with Coder Alex" → switches to that agent's chat tab

---

## Core Concepts

### Profile (role definition)

A profile is a **job description**. It defines what an agent can do, not who it is.

- Name, icon, system prompt, MCP server assignments
- Shared by all agents hired from it
- Example: "Coder" profile → system prompt about coding, assigned to playwright + keychain MCPs
- Users "hire" agents from profiles: "Hire a Coder" creates a Coder agent

A profile is NOT an agent. You don't chat with a profile — you chat with an agent.

### Agent (hired worker)

An agent is a **specific worker** hired from a profile.

- Has a name (user-assigned or auto-generated)
- Belongs to zero or one crew
- Has one active conversation at a time
- Has a state: `idle`, `working`, `stopped`
- Has a workspace for operational state

Agents are soft-deleted (state → `stopped`) when fired. Hard delete available as a separate cleanup action.

### Conversation (chat thread)

A conversation is what the user sees in a **chat tab**. It is the permanent, DB-owned record of interaction with an agent.

- One conversation per agent (always)
- Persists beyond session boundaries
- Can exist with no session or process (COLD state)
- History is owned by the gateway DB, not Claude CLI
- Can be linked to a GitHub issue (#29)

### Crew (team)

A crew is a team of agents with a lead.

- Lead is an agent (not a profile)
- Members are agents (not profiles)
- A crew can have multiple agents from the same profile (3 Coder agents)

### Rules: Profiles, Agents, and Crews

These rules are **mandatory** for all code touching agents, crews, or crew_members:

1. **Profiles are NOT agents.** A profile is a job description. An agent is a specific instance hired from a profile. If iOS Coder profile is in both GAP and GymBells crews, each crew has a DIFFERENT agent instance — they are not interchangeable.

2. **`crew_members` stores per-crew membership.** The table has `crew_id`, `profile_id`, and `agent_id` columns. `profile_id` identifies which profile the membership is for. `agent_id` optionally pins a specific agent instance.

3. **Agent resolution is per-crew, not global.** When finding the agent for a profile in a crew, query must filter by `crew_id`. Never pick "any agent for this profile" when crew context is available.

4. **`createAgent()` must NEVER touch `crew_members`.** Agent creation and crew membership are separate operations. Agent-to-crew assignment is the crew management API's job.

5. **Never update `crew_members` without a `crew_id` filter.** Any SQL like `UPDATE crew_members SET agent_id = ? WHERE profile_id = ?` (without `AND crew_id = ?`) is a bug — it overwrites all crews.

6. **Task routing must be crew-scoped.** When a crew lead assigns a task, the Task API infers or accepts a `crewId` to route to the correct agent in that specific crew.

---

## Three-Layer Runtime Model

Three independent layers, each with its own owner and lifecycle:

```
┌─────────────────────────────────────────────────────────────┐
│  CONVERSATION          Owner: Gateway DB                    │
│  Permanent. UI concept. Can exist with no session/process.  │
│  One per agent (always).                                    │
├─────────────────────────────────────────────────────────────┤
│  SESSION               Owner: Claude CLI (disk)             │
│  ~/.claude/projects/*.jsonl                                 │
│  Can exist without conversation (orphan) or process.        │
│  Gateway doesn't own these — just points at them.           │
├─────────────────────────────────────────────────────────────┤
│  PROCESS               Owner: OS (ephemeral)                │
│  A `claude --resume <session>` running right now.           │
│  One per session at a time (from our side).                 │
└─────────────────────────────────────────────────────────────┘
```

### Conversation States

| State | DB row | Session on disk | Process running | User sees |
|-------|--------|-----------------|-----------------|-----------|
| **COLD** | ✓ | ✗ | ✗ | "No history" — next message starts fresh |
| **DORMANT** | ✓ | ✓ | ✗ | Tab shows last message, can resume |
| **ACTIVE** | ✓ | ✓ | ✓ | Live chat, streaming output |

### Rules

1. One conversation per agent (always)
2. One session per conversation at a time, but conversation outlives sessions
3. One process per session at a time (from our side)
4. Conversation history is OURS (DB). Session history is Claude CLI's (.jsonl)
5. If session is deleted, conversation continues — next message creates fresh session
6. The gateway doesn't own sessions — Claude CLI does. We just point at them.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| **Orphan session** — .jsonl on disk, no conversation in DB | Discoverable and importable via admin UI |
| **Multiple processes on same session** — user ran `claude --resume` in terminal | Detect and warn, don't crash |
| **Conversation without session** — session was deleted or never existed | Valid state (COLD). Next message creates fresh session |
| **Agent fired with active conversation** — soft-delete while running | Stop process, conversation preserved as DORMANT, agent state → stopped |

---

## Workspace Architecture

Agent operational space lives **outside the source repo** to avoid coupling.

```
~/.gellyfish/                                  # Operational home
├── workspaces/
│   ├── <profile-slug>/                        # Profile template home
│   │   ├── CLAUDE.md                          # Role definition (shared)
│   │   └── agents/
│   │       ├── <agent-id>/                    # Agent-specific state
│   │       │   ├── context.md                 # Current assignment, issue link
│   │       │   └── notes/                     # Working notes
│   │       └── ...
│   └── ...
└── config/                                    # Global config (future)

~/Workspace/gellyfish/                         # Source repo (clean, no agent data)
```

### Rules

1. **Profile CLAUDE.md** → `~/.gellyfish/workspaces/<profile>/CLAUDE.md` — role definition
2. **Agent state** → `~/.gellyfish/workspaces/<profile>/agents/<id>/` — assignment context
3. **Code work** → agents `cd` into the actual repo — they don't work from their workspace
4. **Shared crew access** → crew members can read the lead's workspace for PRDs, context
5. **Source repo stays clean** — no agent operational data in the repo tree

---

## Database Schema

### Source of Truth

The database owns ALL state. Filesystem is operational space only.

| State | Owner |
|-------|-------|
| Agent exists, name, state | `agents` table |
| Conversation exists, state, linked issue | `conversations` table |
| Crew membership | `crew_members` table |
| Task assignment | `tasks` table |
| Process alive (ephemeral) | Gateway in-memory map (rebuilt on restart) |

### Schema Changes

```sql
-- profiles table: UNCHANGED (it IS the template)

-- NEW: agents table
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle'
    CHECK (state IN ('idle', 'working', 'stopped')),
  workspace_dir TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  stopped_at TEXT
);

-- NEW: conversations table
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT,
  session_id TEXT,                               -- current Claude CLI session (nullable)
  issue_number INTEGER,                          -- linked GitHub issue (#29)
  state TEXT NOT NULL DEFAULT 'cold'
    CHECK (state IN ('cold', 'dormant', 'active')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- MODIFIED: crew_members references agents, not profiles
CREATE TABLE crew_members (
  crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (crew_id, agent_id)
);

-- MODIFIED: tasks reference agents
-- tasks.assignee_profile_id → tasks.assignee_agent_id
-- tasks.creator_profile_id → tasks.creator_agent_id

-- REMOVED: session_profiles (replaced by conversations table)
-- REMOVED: session_metadata (absorbed into conversations)
```

### Migration Plan

1. For each existing profile, create one agent with the same name
2. For each existing `session_profiles` row, create a conversation linking the agent to its session
3. Migrate `crew_members` from profile_id → agent_id (for the auto-created agent)
4. Migrate `tasks` assignee/creator from profile_id → agent_id
5. Move workspace dirs from `apps/gateway/data/workspaces/` to `~/.gellyfish/workspaces/`
6. Drop `session_profiles` and `session_metadata` tables
7. No data loss — reshape, not rebuild

---

## Task Assignment

**Manual assignment first.** Crew lead explicitly assigns tasks to named agents.

- Task API uses `assigneeAgentId`
- Auto-assignment (find idle agent or hire new one) deferred until heartbeat system (#26) provides reliable idle detection

---

## Agent Lifecycle

### Hire (create)

1. Pick a profile (e.g. "Coder")
2. Name the agent (e.g. "Alex") or auto-name
3. Agent row created in DB, state = `idle`
4. Workspace created at `~/.gellyfish/workspaces/<profile>/agents/<id>/`
5. Conversation created in DB, state = `cold`
6. **No process spawned** — starts when user opens conversation or task is assigned

### Assign work

1. Task or message sent to agent
2. Agent state → `working`
3. If no active process: spawn `claude --resume <session>` (or fresh if COLD)
4. Conversation state → `active`

### Fire (soft-delete)

1. Stop any running process
2. Agent state → `stopped`, `stopped_at` set
3. Conversation preserved (state → `dormant` or `cold`)
4. Workspace preserved
5. Agent removed from crew
6. Hard delete available as separate "cleanup" action

---

## UI Changes

### Profiles View
- Shows profiles as **role cards** (not individual agents)
- Each card shows: name, icon, system prompt excerpt, how many agents hired from it
- "Hire" button on each profile → creates a new agent
- Profile CRUD unchanged

### Agents View (new, or merged into Profiles)
- Shows all hired agents across all profiles
- Each card: profile icon, agent name, state, crew, current conversation, linked issue
- Actions: open conversation, assign task, fire

### Tab Bar
- Tabs show **conversations** (one per active agent)
- Format: `[👨‍💻 Alex — #18]` (profile icon, agent name, issue number)
- Server-driven: all connected browsers see all active conversations

### Crews View
- Shows agents in crews (not profiles)
- "Hire a Coder for this crew" → creates agent from Coder profile, adds to crew

---

## Related Issues

- **#26** — Crew heartbeat system (enables auto-assignment, health monitoring)
- **#29** — Link conversations to GitHub issues (issue_number on conversations table)
- **#15** — Server-driven tabs (conversations are the tabs)
- **#17** — New chat requires profile (becomes "new conversation requires agent")

---

## Resolved Questions

1. **Agent naming convention** — Auto-generated names. Users can rename via UI (rename action on agent card/detail). Simple defaults like "Coder #1", "Coder #2" or generated names.

2. **Max agents per profile** — Capped at 5 for now. Adjustable later. Prevents runaway resource usage on a home server.

3. **Conversation history ownership** — Don't duplicate into DB for now. History lives on disk in Claude's .jsonl files. If the session file is gone (COLD conversation), show "No history available." Future iteration: lightweight DB-side history (user/assistant text only, no tool details) so COLD conversations still show what happened. Not blocking for v1.

4. **Profile edit propagation** — Manual. Agent picks up the latest profile system prompt on next process restart or next hire/spawn. No hot-reload. Keep it simple.

---

## Future: Conversation Summaries

> **Status:** Not blocking #28. Tracked in **#92**.

A conversation may span many sessions over its lifetime. When a session ends or is deleted, generate a lightweight summary and store it in the DB. This gives COLD conversations a readable history without duplicating full message content.

### Schema

```sql
CREATE TABLE conversation_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  session_id TEXT,              -- the session this summarizes (nullable if session was deleted)
  summary TEXT NOT NULL,        -- what happened in this session
  started_at TEXT,
  ended_at TEXT,
  message_count INTEGER,
  cost REAL
);
```

### How it works

- **Active session** → full history from .jsonl on disk (as today)
- **Session ends/deleted** → generate summary, store in `conversation_summaries`
- **COLD conversation** → shows chain of summaries: "Session 3: Fixed the login bug. Session 4: Refactored auth middleware."
- **Agent resumes after context reset** → reads its own summaries to get back up to speed

### Summary generation options

1. **Claude-generated** — before session cleanup, ask Claude to summarize what was accomplished
2. **Last assistant message** — store as a "where we left off" marker (simpler, no extra API call)
3. **Hybrid** — store last message immediately, generate full summary async

### Example

A Coder agent's conversation with 3 sessions:

```
Conversation: "Coder Alex"
├── Summary #1 (session deleted): "Investigated #12 sessions loading bug.
│   Found the issue: sessions fetch depends on WS state. 14 messages, $0.08"
├── Summary #2 (session deleted): "Fixed #12 by decoupling session list
│   from WebSocket. Added HTTP-only fallback. 42 messages, $0.31"
└── Active session: [full .jsonl on disk — currently working on #18]
```

When Alex's context resets, the system prompt includes these summaries so the agent knows its history.
