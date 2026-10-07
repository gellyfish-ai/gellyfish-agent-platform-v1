# Epic: Native iOS App

## Goal

Replace the current WKWebView wrapper with a proper native iOS app. Native navigation, native input, WKWebView only for chat messages. WhatsApp-style UX.

## Dependencies

The iOS app needs "embedded mode" in the web UI — messages only, no chrome. The web UI needs refactoring to support that cleanly. So the work flows:

```
Phase 1: Frontend refactor (decouple modules)
   ↓
Phase 2: Embedded mode (messages-only web view)
   ↓
Phase 3: Native iOS app (SwiftUI shell + embedded web chat)
   ↓
Phase 4: Native input bar + voice (replace web input with native)
   ↓
Phase 5: Polish (push notifications, camera, app icon)
```

Each phase is independently shippable and testable.

---

## Phase 1: Frontend Refactor — Decouple Modules

**Goal:** Fix coupling so modules can be initialized independently. No new features — just fixing the architecture.

**Why first:** Embedded mode is impossible without this. Every module crashes if certain DOM elements are missing.

### Ticket 1.1: Break circular import messages↔input

Move `setProcessing()` and `cancelProcessing()` out of input.js into state.js (or a new processing.js). These just toggle a boolean and send a WebSocket cancel — they don't belong in input.

**Acceptance criteria:**
- messages.js does not import from input.js
- input.js does not import from messages.js
- All existing functionality works unchanged
- QA: full test pass on web UI (desktop + mobile viewport)

### Ticket 1.2: Make DOM queries lazy and optional

Move all module-level `document.getElementById()` calls into `init()` functions. Guard with null checks — if an element doesn't exist, skip wiring it.

Files: connection.js (#status), tabs.js (#tab-bar, #messages), input.js (all form elements), messages.js (#messages)

**Acceptance criteria:**
- No module crashes at load time if DOM elements are missing
- When elements ARE present, behavior is identical to current
- QA: full test pass on web UI

### Ticket 1.3: Fix tab persistence — serialize data not HTML

Replace `messagesEl.innerHTML` save/restore with a data-based approach. Save message data array, re-render on tab switch.

**Acceptance criteria:**
- Tab switching works the same
- Event listeners survive tab switches (copy buttons, tool approvals)
- QA: test tab switching, verify copy buttons and tool pills work after switch

---

## Phase 2: Embedded Mode

**Goal:** Add `?embedded=true` query param that renders only the message area. No nav, no tabs, no input form, no auto-approve toggle.

**Depends on:** Phase 1 complete (modules must be decoupled first)

### Ticket 2.1: Embedded init mode in app.js

When `?embedded=true` is detected:
- Only initialize: connection, messages, session-manager
- Skip: tabs, input, profiles, crews, navigation, hamburger menu
- Render only #messages container, full viewport
- Expose JS bridge: `window.gellyfish.sendMessage(text)`, `window.gellyfish.attachImage(base64, mime)`

**Acceptance criteria:**
- `http://localhost:3000/session/{id}?embedded=true` shows messages only
- No nav bar, no tab bar, no input form visible
- Messages stream correctly
- Tool pills and task bubbles render
- JS bridge functions work (testable via browser console)
- QA: Playwright test — load embedded URL, verify only messages visible, send message via console bridge

### Ticket 2.2: Embedded mode API

New gateway endpoint or query param support:
- `GET /session/:id?embedded=true` serves the same page but the JS detects the param
- The WebSocket connection works the same way

**Acceptance criteria:**
- Same session loads in full mode and embedded mode
- Both can be open simultaneously without conflict
- QA: open same session in two tabs (one normal, one embedded), verify messages appear in both

---

## Phase 3: Native iOS App — SwiftUI Shell

**Goal:** Replace the current wrapper with a proper native app. Tab bar, session list, crews, profiles, settings — all native. Chat view uses embedded WKWebView.

**Depends on:** Phase 2 complete (embedded mode must work)

**Agent:** iOS Coder (new agent, Coder profile)

### Ticket 3.1: Tab bar + session list (Chats tab)

Native SwiftUI TabView with 4 tabs. Chats tab shows native List of sessions from `GET /api/sessions` + `GET /api/agents/health`.

**Acceptance criteria:**
- Tab bar with Crews, Profiles, Chats, More (SF Symbols)
- Session list shows agent emoji, name, last message preview, timestamp, status dot
- Sorted by last activity
- Pull to refresh
- QA: build in simulator, verify tabs switch, sessions load from API

### Ticket 3.2: Chat view (embedded WKWebView)

Tap session → push to chat view. Tab bar hides. Native nav bar with back button + agent name. WKWebView loads `embedded=true` URL.

**Acceptance criteria:**
- Chat view is full screen, tab bar hidden
- Native back button returns to session list
- Messages render and stream in WKWebView
- Agent name and status in nav bar
- QA: build in simulator, tap session, verify messages load, back button works

### Ticket 3.3: Crews tab (native)

Native List of crews from `GET /api/crews`. Tap crew → detail view with members.

**Acceptance criteria:**
- Crew list with emoji, name, member count
- Crew detail shows members with status
- Tap member opens their chat
- QA: verify in simulator

### Ticket 3.4: Profiles tab (native)

Native List of profiles from `GET /api/profiles`. Tap profile → detail view with agents.

**Acceptance criteria:**
- Profile list with emoji, name, agent count
- Profile detail shows agents
- Tap agent opens their chat
- QA: verify in simulator

### Ticket 3.5: More tab (native settings)

Native Form with grouped sections: Connection, Voice, System, About.

**Acceptance criteria:**
- Server URL configurable + persisted
- Voice language picker (EN/ES/CA/JA) + persisted
- System status shows agent count
- QA: verify settings persist across app restarts

### Ticket 3.6: New chat flow

Floating + button → profile picker sheet → creates session → opens chat.

**Acceptance criteria:**
- Profile picker shows available profiles
- Selecting profile creates session via API
- Chat view opens with new session
- QA: create new session from app, verify it appears in web UI too

---

## Phase 4: Native Input Bar + Voice

**Goal:** Replace web input with native input bar. Native keyboard, native mic, native image picker.

**Depends on:** Phase 3 complete

### Ticket 4.1: Native input bar

SwiftUI input bar below WKWebView. Text field + send button. Sends via JS bridge `window.gellyfish.sendMessage(text)`.

**Acceptance criteria:**
- Native text input with keyboard
- Send button sends message
- Message appears in chat (via bridge → WebSocket → back to WKWebView)
- QA: type and send messages from native input

### Ticket 4.2: Native voice input

Mic button in input bar. Apple Speech framework for on-device transcription. Transcript inserted into text field for review before sending.

**Acceptance criteria:**
- Tap mic → recording starts, red indicator
- Tap again → stops, transcript in text field
- Language setting from More tab respected
- QA: test on physical device (mic doesn't work in simulator)

### Ticket 4.3: Native image attachments

Paperclip button → UIImagePickerController (camera + photo library). Selected image sent via bridge.

**Acceptance criteria:**
- Pick photo from library → attached to message
- Take photo with camera → attached to message
- QA: test on physical device

---

## Phase 5: Polish

**Depends on:** Phase 4 complete

### Ticket 5.1: Push notifications (APNs)
### Ticket 5.2: App icon (jellyfish logo)
### Ticket 5.3: Background WebSocket keep-alive
### Ticket 5.4: Haptic feedback
### Ticket 5.5: TestFlight distribution

---

## Phase Gates — MANDATORY

**Every phase requires human (Arven) review and approval before the next phase begins.**

After each phase:
1. QA runs full test pass
2. Coordinator presents results + demo to Arven
3. Arven reviews, approves, or sends back for refinement
4. Only after explicit approval does the next phase start

No exceptions. No "moving ahead while waiting for feedback."

---

## QA Strategy

Each ticket gets QA before merge. Between phases, a full integration test:

- **After Phase 1:** Full web UI regression (no visible changes, just architecture)
- **After Phase 2:** Embedded mode + full mode side by side
- **After Phase 3:** iOS app in simulator — all tabs, navigation, session management
- **After Phase 4:** iOS app on physical device — voice, camera, keyboard
- **After Phase 5:** TestFlight build, install on iPhone, full end-to-end test

---

## Team & Capabilities

### Who does what

| Agent | Phases | What they can do | What they CANNOT do |
|-------|--------|-----------------|---------------------|
| **Coordinator** | All | Manage tickets, review PRs, coordinate QA, communicate with Arven | Write code, access Xcode GUI |
| **GAP Coder** | 1, 2 | Write TypeScript/web code, git operations, CLI tools | Xcode GUI, Apple Developer Portal |
| **iOS Coder** | 3, 4, 5 | Write Swift/SwiftUI code, xcodebuild CLI, git operations | Xcode GUI, Apple Developer Portal |
| **QA Engineer** | All | Playwright testing, code review, simulator testing via CLI | Physical device testing, Xcode GUI |
| **Mac Automation** | 3, 5 | Drive Xcode GUI (build/run, set signing), screencapture, simulator install | Requires unlocked screen |

### Human intervention required

These tasks CANNOT be done by agents — they need Arven:

| Task | Why | When |
|------|-----|------|
| **Apple Developer Portal** (certificates, provisioning profiles, APNs setup) | Requires admin Apple ID login, 2FA | Phase 5 (push notifications, TestFlight) |
| **Physical iPhone testing** | Agents can't interact with the physical device over USB | Phase 4 (voice, camera) |
| **TestFlight upload approval** | Apple review, signing with distribution cert | Phase 5 |
| **Xcode signing team selection** | First-time setup requires GUI + Apple ID auth | Phase 3 (first device build) |
| **Screen unlock for Mac Automation** | Auto-lock kills GUI automation | Any time Mac Automation needs Xcode GUI |

### Escalation path

When agents hit a blocker that needs human intervention:
1. Coordinator sends a message to Arven via the Gellyfish UI (or WhatsApp when available)
2. Clearly states: what's blocked, what human action is needed, what the agent will do once unblocked
3. Agent pauses and works on something else — never waits idle

---

## Timeline Estimate

Not estimating time — but the dependency chain is:

```
Phase 1 (3 tickets, sequential)
  → Arven review + approve
Phase 2 (2 tickets)
  → Arven review + approve
Phase 3 (6 tickets, some parallel)
  → Arven review + approve
Phase 4 (3 tickets)
  → Arven review + approve (physical device testing here)
Phase 5 (5 tickets)
  → Arven review + approve (Apple Developer Portal work here)
```

Phase 3 tickets 3.3-3.5 can run parallel with 3.1-3.2 if the iOS Coder is set up.
