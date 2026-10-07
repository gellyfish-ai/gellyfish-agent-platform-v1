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
| **Profiles**: role definitions with their own `CLAUDE.md`, skills and MCP servers | 2026-03-13 |
| **Crews**: groups of profiles with a lead, an icon and a shared skill set | 2026-03-16 |
| **Agents and conversations**: agents hired from a profile, each with a persistent conversation | 2026-03-19 |
| **Hiring** agents into a crew from the web UI | 2026-04-02 |
| **Crew heartbeat**: periodic health checks on every agent in a crew | 2026-03-19 |
| **Profile sync**: two-way `CLAUDE.md` sync between agent workspaces and a profiles repository | 2026-03-29 |
| **Idle shutdown**: idle agent processes are stopped and resumed on the next message | 2026-04-01 |
| **Stop button** per agent in the crew view | 2026-04-01 |

## Agent-to-agent work

| Feature | Landed |
|---|---|
| **Agent-to-agent messaging**: agents message each other through `/api/chat`, which runs one-shot `claude --print` sessions | 2026-02-23 |
| **Task API**: tracked tasks that replace the one-shot path; the assignee is woken (or resumed) to do the work | 2026-03-16 |
| **Completion notices**: the assigning agent is told when a task completes or fails | 2026-03-20 |
| **Live task status** in the assigning agent's chat | 2026-03-17 |
| **Skills for coordination**: `btw` (non-blocking message to another agent), `escalate` (to the crew lead or a human), `bequeath` (write down what the session learned before the process exits), `complete-task` | 2026-03-19 |

## Process management

| Feature | Landed |
|---|---|
| **Processes survive reconnects**: closing the browser does not stop the agent | 2026-03-14 |
| **Standalone process manager**: agents outlive gateway restarts and hot reloads | 2026-03-17 |
| **Separate dev and prod gateways** sharing one process manager | 2026-03-20 |

## Permissions and approvals

| Feature | Landed |
|---|---|
| **Auto-approve toggle** for tool permissions, handled server-side | 2026-03-14 |
| **Per-tool risk levels** (none / notify / approve) with an API to configure them | 2026-04-08 |
| **Device pairing** with a key generated in the iPhone's Secure Enclave | 2026-04-08 |
| **Push approvals** over APNs, signed with Face ID | 2026-04-08 |
| **Vault backend** for credentials and approval state, outside the agents' reach | 2026-04-15 |

## Chat UI (web)

| Feature | Landed |
|---|---|
| **Web chat for a local Claude Code session**, responsive and used from a phone from day one | 2026-02-23 |
| Markdown rendering and a thinking indicator | 2026-03-14 |
| **Tabs** for every open agent conversation | 2026-03-16 |
| Tool call detail views | 2026-03-17 |
| **Emoji reactions** on messages | 2026-03-21 |
| **Image attachments** in the input | 2026-03-21 |
| **Inline screenshots** with click-to-zoom | 2026-03-21 |
| **Session search** with an agent filter | 2026-03-23 |
| **Voice input**, transcribed locally with whisper.cpp | 2026-03-27 |
| **Reply to / quote** a message, iMessage style | 2026-04-07 |

## Mobile

| Feature | Landed |
|---|---|
| **iOS app**: native navigation and input, web view for the transcript, native microphone | 2026-03-28 |
| On-device speech recognition and text-to-speech | 2026-03-31 |
| Approval notifications and signing (see above) | 2026-04-08 |
| **watchOS companion** for notifications (approval stays on the phone) | 2026-04-17 |

## Tools for agents (MCP servers)

| Feature | Landed |
|---|---|
| **Credential filler**: types passwords into pages over CDP without the model seeing them | 2026-01-02 |
| **Password entry on an iPhone** through WebDriverAgent | 2026-03-20 |
| **Mac automation** through AppleScript and accessibility | 2026-03-13 |
| **Twilio**: SMS and phone calls | 2026-03-24 |
| **Bluesky**: posting and threads | 2026-03-29 |
| **MCP proxy** with per-tool-call telemetry and weekly trend reports | 2026-04-15 |

## Observability

| Feature | Landed |
|---|---|
| **OpenTelemetry receiver** for Claude Code's own metrics and logs | 2026-01-03 |
| **Usage dashboard** for tokens and cost | 2026-01-03 |
