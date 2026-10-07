# Chat View Design

## Overview

Full-screen view when you tap a session from the Chats list. Tab bar hidden. Native nav bar at top, WKWebView for messages, native input bar at bottom.

## Layout

```
┌─────────────────────────────┐
│  < Back    Agent Name   ●   │  ← Native nav bar
│─────────────────────────────│
│                             │
│   [WKWebView]               │
│   Messages + tool output    │
│   Task bubbles              │
│   Streaming responses       │
│                             │
│─────────────────────────────│
│  📎  🎤  [message input]  ➤ │  ← Native input bar
└─────────────────────────────┘
```

## Native Nav Bar

- **Back button** (< chevron) — returns to session list, restores tab bar
- **Agent name** — center title, tappable for agent info sheet
- **Status indicator** — right side, SF Symbol `circle.fill` colored by state
- **Agent emoji** — next to name or in a small avatar circle

Tapping agent name opens a sheet with:
- Agent name (editable via rename)
- Profile name + icon
- Crew membership
- Current issue number
- Session ID (for debugging)
- "End Session" button

## WKWebView Content

The web view loads ONLY the chat portion — messages, tool output, task bubbles, streaming. No web UI nav bar, no web tabs, no web input bar.

**How:** Load the session URL with a query param or fragment that tells the web UI to render in "embedded" mode — hide everything except the message area.

Example: `http://10.0.0.1:3000/session/{sessionId}?embedded=true`

The web UI checks for `embedded=true` and:
- Hides the top nav bar (hamburger, tabs, system status)
- Hides the input form (native app handles input)
- Hides auto-approve toggle
- Shows only the message container, full height

## Native Input Bar

Replace the web input bar with a native one. Benefits:
- Native keyboard integration
- Native mic button with haptic feedback
- Better text editing (selection, autocorrect)
- Survives WKWebView reloads

### Elements (left to right)

| Element | SF Symbol | Behavior |
|---------|-----------|----------|
| Attach | `paperclip` | Photo picker (camera + library) |
| Mic | `mic.fill` | Tap to record, tap to stop. Red when recording. |
| Text input | — | Native UITextField, multiline, placeholder "Message..." |
| Send | `arrow.up.circle.fill` | Blue filled circle, sends message |

### Mic behavior
- Tap mic → starts Apple Speech recognition
- Recording indicator: mic icon turns red, subtle pulse
- Tap again → stops, transcript appears in text input
- User can edit before sending
- Language follows the setting in More tab

### Sending messages
The native input bar sends messages to the WKWebView via the JS bridge:
```javascript
window.gellyfish.sendMessage("the text")
```

The web UI's connection.js handles sending it through the WebSocket — same as typing in the web input.

### Image attachments
- Tap paperclip → native UIImagePickerController (camera + photo library)
- Selected image converted to base64
- Sent via bridge: `window.gellyfish.attachImage(base64, mimeType)`
- Web UI handles the rest (same as current paste/upload flow)

## Keyboard Handling

- Input bar sticks above keyboard (standard iOS behavior)
- WKWebView scrolls content up when keyboard appears
- Dismissable by scrolling down or tapping outside

## Transitions

- **Enter chat:** Push navigation (slide from right), tab bar hides
- **Leave chat:** Pop navigation (slide from left), tab bar shows
- **Agent info sheet:** Present as sheet (slide up from bottom)

## SF Symbols Used

| Element | Symbol |
|---------|--------|
| Back | `chevron.left` (automatic with NavigationStack) |
| Status active | `circle.fill` (green tint) |
| Status idle | `circle.fill` (yellow tint) |
| Status off | `circle.fill` (grey tint) |
| Attach | `paperclip` |
| Mic | `mic.fill` / `mic.fill` (red when recording) |
| Send | `arrow.up.circle.fill` |
| Agent info | `info.circle` (or tap title) |

## Web UI Changes Needed

New "embedded mode" for the web UI:
1. Detect `?embedded=true` query param
2. Hide: nav bar, tab bar, input form, auto-approve toggle, hamburger menu
3. Show: message container only, full viewport height
4. Expose JS bridge functions:
   - `window.gellyfish.sendMessage(text)` — send a chat message
   - `window.gellyfish.attachImage(base64, mimeType)` — attach an image
   - `window.gellyfish.onTranscript(text)` — (already exists) insert transcript
