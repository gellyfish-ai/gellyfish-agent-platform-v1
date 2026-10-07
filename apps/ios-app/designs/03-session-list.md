# Session List Design (Chats Tab)

## Overview

WhatsApp-style session list. Default tab on launch. Shows all active/recent sessions sorted by last activity.

## Layout

```
┌─────────────────────────────┐
│  Chats                 Edit │  ← Large title
│  🔍 Search                  │  ← Search bar
│─────────────────────────────│
│  🦮● CEO Assistant    22:15 │
│  MCP security policy up...  │
│─────────────────────────────│
│  👨‍💻● Coder            17:28 │
│  PR #207. New packages/...  │
│─────────────────────────────│
│  🪼● Coordinator       17:30 │
│  Bluesky MCP shipped...    │
│─────────────────────────────│
│  ...                        │
│                         [+] │  ← FAB
│                             │
│  👥    👤    💬    ···      │  ← Tab bar
└─────────────────────────────┘
```

## Session Row

Each row shows:

| Element | Position | Source |
|---------|----------|--------|
| Agent emoji | Left, 50x50 circle | Profile icon from API |
| Status dot | Bottom-right of avatar | Agent state from /api/agents/health |
| Agent name | Top-left of text area | Agent name from API |
| Last message preview | Below name, grey, truncated | Last message from session timeline |
| Timestamp | Top-right | Last activity time |
| Unread badge | Below timestamp (optional) | Count of messages since last viewed |

## Sorting

- Primary: last activity timestamp (newest first)
- Pinned sessions at top (future feature)

## Actions

### Tap row
Opens the chat view (push navigation, tab bar hides)

### Swipe left
- **Archive** (grey) — hides from list, accessible via Edit mode
- **Delete** (red) — deletes session (with confirmation alert)

### Long press
Context menu:
- Pin / Unpin
- Mark as Read
- Agent Info
- Archive
- Delete

### Pull to refresh
Reloads session list from API

### Floating + button
Starts new chat flow:
1. Profile picker sheet (list of available profiles)
2. Select profile → creates new session + opens chat view
3. Or: select existing agent → resumes their session

### Search
- Filters by agent name
- Future: search message content

### Edit button (top-right)
- Enters edit mode
- Select multiple sessions
- Bulk actions: archive, delete

## Data Source

```
GET /api/sessions — list of sessions with metadata
GET /api/agents/health — agent states
```

Combine: each session maps to an agent, get the agent state for the status dot.

## Empty State

If no sessions:
```
Welcome to Gellyfish
Your personal AI assistant.
Tap + to start a conversation.
```

## SF Symbols

| Element | Symbol |
|---------|--------|
| Search | `magnifyingglass` |
| New chat | `plus.circle.fill` |
| Archive | `archivebox.fill` |
| Delete | `trash.fill` |
| Pin | `pin.fill` |
| Mark read | `envelope.open.fill` |
| Edit | system Edit button |
