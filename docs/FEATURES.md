# Features

Everything the platform did, grouped by area. Dates are when each feature first landed in the
original repository (development ran from December 2025 to April 2026, about 520 commits).

This repository was published with fresh history. The original, private repository
(`gellyfish-ai/Gellyfish-Agent-Platform`) is the audit trail: commit hashes below refer to it,
and its history, issues and pull requests are available on request.

## Timeline against Claude Code

Only comparisons the git history supports are listed here.

| Capability | Gellyfish | Claude Code |
|---|---|---|
| Driving a Claude Code session on your own machine from a phone | 2026-02-23 (web chat over the CLI, `8dfc215`) | Remote Control, announced 2026-02-24/25 as a research preview ([VentureBeat](https://venturebeat.com/ai/anthropic-just-released-a-mobile-version-of-claude-code-called-remote)) |
| Agents messaging each other | 2026-02-23 (`/api/chat`, `8dfc215`), tracked tasks from 2026-03-16 (`bd3db71`) | Agent teams, still behind an experimental flag as of version 2.1.292 |

The commit that retired `/api/chat` (`4b333d9`, 2026-03-17) describes it as "the original dumb
pipe for agent-to-agent messaging", replaced by the task system.

## Agents, profiles and crews

| Feature | Landed |
|---|---|
| **Profiles as job descriptions**: each profile has its own system prompt, `CLAUDE.md`, skills and MCP servers, so a Coder and a QA agent see different tools and know different procedures | 2026-03-13 |
| **Crews**: groups of agents with a lead and an icon | 2026-03-16 |
| **Per-profile MCP servers**, with global servers merged in for every agent | 2026-03-16 |
| **Several agents per profile**: agents are hired from a profile like employees from a job description, each with its own workspace and persistent conversation, and a coordinator assigns them work | 2026-03-19 |
| **Skills at three levels**: global skills for every agent, crew skills for one crew, profile skills for one job description, linked into each workspace at spawn time | 2026-03-19 |
| **Crew heartbeat**: periodic health checks on every agent in a crew | 2026-03-19 |
| **Conversations linked to GitHub issues**, with issue references auto-linked in chat | 2026-03-19 |
| **Config refresh**: agents are told when their `CLAUDE.md` changes | 2026-03-23 |
| **Profile sync**: two-way `CLAUDE.md` sync between agent workspaces and a profiles repository | 2026-03-29 |
| **Idle shutdown**: idle agent processes are stopped and resumed on the next message | 2026-04-01 |
| **Stop button** per agent in the crew view | 2026-04-01 |
| **Crew-specific instructions** layered on top of the profile's | 2026-04-02 |
| **Hiring and firing** agents in a crew from the web UI | 2026-04-02 |
| **Per-profile tool permissions and startup hooks**, read from the profiles repository | 2026-04-04 |
| **Model per profile**, with the model the CLI actually started with shown in the UI | 2026-04-07 |
| **Lifecycle API**: respawn an agent, re-sync its config, inspect what it was started with | 2026-04-17 |

## Agent-to-agent work

| Feature | Landed |
|---|---|
| **Agent-to-agent messaging**: agents message each other through `/api/chat`, which runs one-shot `claude --print` sessions | 2026-02-23 |
| **Task API**: tracked tasks that replace the one-shot path; the assignee is woken (or resumed) to do the work | 2026-03-16 |
| **Live task status** in the assigning agent's chat | 2026-03-17 |
| **Skills for coordination**: `btw` (non-blocking message to another agent), `escalate` (to the crew lead or a human), `bequeath` (write down what the session learned before the process exits), `complete-task` | 2026-03-19 |
| **Completion notices**: the assigning agent is told when a task completes or fails | 2026-03-20 |
| **Task timeline cards** showing a task's goal, progress and result, in both the assigner's and the assignee's chat | 2026-04-02 |
| **Message protocol**: a common prefix for every message injected into an agent (tasks, reactions, notices), shown as compact bubbles | 2026-04-07 |
| **Brief mode**: per-profile use of Claude Code's `--brief` flag; the agent's messages to the human are shown as the main chat bubbles | 2026-04-09 |
| **Clarification requests**: an assignee can block a task with a question and resume when it is answered | 2026-04-10 |

## Process management

| Feature | Landed |
|---|---|
| **Processes survive reconnects**: closing the browser does not stop the agent | 2026-03-14 |
| **Standalone process manager**: agents outlive gateway restarts and hot reloads | 2026-03-17 |
| **Separate dev and prod gateways** sharing one process manager | 2026-03-20 |
| **Conversation summaries** stored when a session closes | 2026-03-23 |
| **Broken-session recovery**: after three API errors in a row, the user is offered to summarise the session and continue in a fresh one | 2026-03-25 |
| **Session picker**: list and switch the Claude Code session files behind a conversation | 2026-04-01 |
| **Crash banner** with resume, and a notice when Claude Code compacts the context | 2026-04-08 |

## Permissions and approvals

| Feature | Landed |
|---|---|
| **Auto-approve toggle**: every permission request passes through the gateway, so skipping prompts is a switch you can flip at any time rather than a launch flag, and tools can be excepted from it | 2026-03-14 |
| **Per-tool risk levels** (none / notify / approve): `approve` tools are checked before auto-approve and always wait for a signed approval | 2026-04-08 |
| **Device pairing** with a key generated in the iPhone's Secure Enclave | 2026-04-08 |
| **Push approvals** over APNs, signed with Face ID | 2026-04-08 |
| **Approval expiry**: unanswered approvals are denied automatically | 2026-04-08 |
| **Audit log, rate limiting, several devices and device revocation** | 2026-04-09 |
| **Approvals dashboard** and a diagnostics view for the signing path | 2026-04-09 |
| **Vault backend** for credentials and approval state, outside the agents' reach | 2026-04-15 |

## Chat UI (web)

| Feature | Landed |
|---|---|
| **Web chat for a local Claude Code session**, responsive and used from a phone from day one | 2026-02-23 |
| Markdown rendering, a thinking indicator, input history with the arrow keys | 2026-03-14 |
| **Tabs** for every open agent conversation | 2026-03-16 |
| Tool call detail views | 2026-03-17 |
| **System status panel**: processes, sessions and their health | 2026-03-17 |
| **Tabs stored on the server**, so the same tabs are open on every device | 2026-03-20 |
| **Emoji reactions** on messages, passed back to the agent as feedback ("[User reacted 👎 to: …]") | 2026-03-21 |
| **Image attachments** in the input, by paste or drag and drop | 2026-03-21 |
| **Inline screenshots** with click-to-zoom | 2026-03-21 |
| **Session search** with an agent filter | 2026-03-23 |
| **Voice input**, transcribed locally with whisper.cpp | 2026-03-27 |
| **File attachments**: PDFs and text files | 2026-04-02 |
| **`AskUserQuestion` as buttons** you can tap | 2026-04-02 |
| Token-by-token streaming and a light mode | 2026-04-05 |
| **Reply to / quote** any message, iMessage style; the quoted text is sent to the agent with the reply | 2026-04-07 |
| **MCP servers page** for managing servers from the UI | 2026-04-07 |
| **Log viewer** for the gateway's structured logs | 2026-04-15 |

## Mobile

| Feature | Landed |
|---|---|
| **iOS app**: native navigation and input, web view for the transcript, native microphone | 2026-03-28 |
| Native chat list, crews and profiles tabs, voice input and image attachments | 2026-03-30 |
| **Voice mode**: hands-free conversation with on-device speech recognition, silence detection and spoken replies | 2026-03-31 |
| Crew editing and model selection from the phone | 2026-04-06 |
| Approval notifications and signing (see above) | 2026-04-08 |
| Native long-press menu for replies and reactions | 2026-04-10 |
| Live / idle filter on the chat list | 2026-04-16 |
| **watchOS companion** for notifications (approval stays on the phone) | 2026-04-17 |

## Tools for agents (MCP servers)

| Feature | Landed |
|---|---|
| **Credential filler**: types passwords into pages over CDP without the model seeing them, with password-redacted page snapshots | 2026-01-02 |
| **Mac automation** through AppleScript and accessibility | 2026-03-13 |
| **Password entry on an iPhone** through WebDriverAgent | 2026-03-20 |
| **Twilio**: SMS and phone calls | 2026-03-24 |
| **Password entry in Mac desktop apps** | 2026-03-26 |
| **Bluesky**: posting and threads | 2026-03-29 |
| **MCP health monitoring**: disconnects and dead daemons are detected and shown | 2026-04-01 |
| **MCP secrets from the macOS Keychain**, resolved at spawn time instead of stored in config | 2026-04-07 |
| **MCP proxy**: per-tool-call telemetry, policy enforcement at the transport level, anomaly alerts and weekly trend reports | 2026-04-15 |

## Observability

| Feature | Landed |
|---|---|
| **OpenTelemetry receiver** for Claude Code's own metrics and logs | 2026-01-03 |
| **Usage dashboard** for tokens and cost | 2026-01-03 |
| **Structured logging** of every agent communication path | 2026-03-17 |
| **Anthropic API errors** surfaced in the UI instead of a silent stall | 2026-04-15 |
