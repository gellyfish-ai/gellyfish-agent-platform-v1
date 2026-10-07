# Navigation Design

## Structure

Bottom tab bar with 4 sections. WhatsApp-style layout.

## Iconography

- **Navigation (tabs, buttons, system actions):** SF Symbols — native iOS, consistent with platform
- **Agent/profile/crew identity:** Emojis — same as web UI, cross-platform consistency (🦮, 👨‍💻, 🪼, 🧪, etc.)
- **Tab bar disappears inside conversations** — full-screen chat view with native back button, same as WhatsApp

## Tab Bar

| Position | SF Symbol | Label | Content |
|----------|-----------|-------|---------|
| 1 | `person.2.fill` | Crews | Crew list → crew detail (members, status) |
| 2 | `person.crop.rectangle.stack.fill` | Profiles | Profile list → profile detail (agents) |
| 3 | `bubble.left.and.bubble.right.fill` | Chats | Session list → chat view (WKWebView) |
| 4 | `ellipsis` | More | Settings, credentials, system status, about |

**Default tab on launch: Chats** (tab 3)

## Tab 3: Chats (Primary)

### Session List
- WhatsApp-style list
- Each row: agent icon | agent name + last message preview | timestamp
- Rows sorted by last activity (most recent first)
- Active sessions have a green dot on the agent icon
- Swipe left to delete/archive
- Pull to refresh
- Search bar at top (filter by agent name or message content)
- Floating "+" button (bottom-right) to start new chat

### New Chat Flow
- Tap "+" → profile picker (list of available profiles)
- Select profile → opens chat view with that agent
- Or: create new agent from profile

### Chat View
- Full-screen WKWebView loading the conversation
- Native back button (top-left) returns to session list
- Agent name + status in nav bar title
- The WKWebView loads only the chat portion of the web UI (messages + input)
- Input bar at bottom: native keyboard, mic button uses native Speech framework

## Tab 1: Crews

### Crew List
- List of crews with icon + name + member count
- Tap crew → crew detail

### Crew Detail
- Crew name, icon, description
- Member list: agent name, profile, status (active/idle/off), current task
- Tap member → opens their chat (switches to Chats tab)

## Tab 2: Profiles

### Profile List
- List of profiles with icon + name + agent count
- Grouped by crew (or flat list)
- Tap profile → profile detail

### Profile Detail
- Profile name, icon, system prompt summary
- Agents spawned from this profile
- MCP assignments
- Tap agent → opens their chat

## Tab 4: More

### More Menu (grouped table view)
- **Server**: URL, connection status, gateway version
- **Voice**: language picker (EN/ES/CA/JA), transcription method
- **System Status**: agent health, process list
- **Credentials**: keychain entries (read-only list)
- **About**: version, build, links

## What's Native vs Web

| Screen | Implementation |
|--------|---------------|
| Tab bar | Native SwiftUI TabView |
| Session list | Native SwiftUI List |
| Chat view | WKWebView (messages + input + streaming) |
| New chat picker | Native SwiftUI sheet |
| Crew list/detail | Native SwiftUI List + NavigationStack |
| Profile list/detail | Native SwiftUI List + NavigationStack |
| Settings/More | Native SwiftUI Form |
| System status | Native (calls /api/agents/health) |

## API Endpoints Used

All native views call the gateway REST API:

- `GET /api/sessions` → session list
- `GET /api/agents/health` → agent status
- `GET /api/crews` → crew list
- `GET /api/profiles` → profile list
- `POST /api/sessions` → create session
- `GET /api/sessions/:id/timeline` → chat history (for preview text)

## Navigation Flow

```
App Launch
  → Tab Bar
    → Chats (default)
      → Session List
        → [tap session] → Chat View (WKWebView)
        → [tap +] → Profile Picker → Chat View
    → Crews
      → Crew List
        → [tap crew] → Crew Detail
          → [tap member] → Chat View
    → Profiles
      → Profile List
        → [tap profile] → Profile Detail
          → [tap agent] → Chat View
    → More
      → Settings / Status / Credentials / About
```
