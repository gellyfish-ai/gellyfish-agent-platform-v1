---
name: bequeath
description: Persist your session knowledge before your process dies. Routes each piece of knowledge to the right destination. Your polyp only knows what you write down.
user-invocable: true
---

Review your full session and persist everything your polyp will need — routed to the right place.

## Usage
`/bequeath`

## Step 1 — Triage your session

Scan your entire conversation. For each piece of knowledge, decide where it belongs:

| What | Goes where |
|------|-----------|
| Open tasks, pending work, blocked items | **GitHub board** (file issue if not already there) |
| Permanent rules, identity, behavioral constraints | **system-prompt.md** in HQ profile |
| Architecture, ports, endpoints, crew structure, stable reference | **CLAUDE.md** in HQ profile |
| Recurring multi-step workflows | **New skill** in `gellyfish-hq/GAP/skills/` |
| Process changes (how the team works) | **HQ docs** (PROCESS.md, WORKFLOW.md, etc.) |
| Ephemeral/session state, ticket numbers, current PR list | **Nowhere** — discard, it's in git/board |

**Do not put in CLAUDE.md:**
- Open task lists or current bloom state (→ board)
- Ticket numbers without permanent context
- Things already documented in HQ docs (don't duplicate)
- Raw decisions without the "why"

## Step 2 — Route and write

### GitHub board
For any open task, blocked item, or decision needing follow-up that isn't already a ticket:
```bash
gh issue create --repo gellyfish-ai/Gellyfish-Agent-Platform --title "..." --body "..."
```

### system-prompt.md
File: `gellyfish-hq/GAP/profiles/<your-profile>/system-prompt.md`

This defines who the agent IS. Read the current file first, then ask:
- Does it still accurately describe this agent's role and authority?
- Are there new behavioral rules to add?
- Is there anything outdated, wrong, or redundant to remove?

**Rewrite ruthlessly.** Short, concrete, no fluff. A polyp that reads this should instantly know how to behave without needing to figure anything out.

### CLAUDE.md
File: `gellyfish-hq/GAP/profiles/<your-profile>/CLAUDE.md`  
Also sync to workspace: `<workspace>/CLAUDE.md`

Read the current file first. Then:
- **Add** new permanent facts (architecture changes, new MCPs, new crew members, lessons)
- **Remove** anything stale, superseded, or no longer true
- **Consolidate** — if a section has grown noisy, tighten it

**Good content:** stable facts, commands, architecture, lessons with permanent value  
**Bad content:** ticket numbers, current bloom state, "we decided X this session", anything in git/board

After updating, re-read the whole file. If any section feels like noise, cut it.

### New skill
If you found yourself doing a multi-step process more than once, codify it:
```bash
# Create skill in HQ
cat > gellyfish-hq/GAP/skills/global/<name>.md << 'EOF'
---
name: <name>
description: <one line>
user-invocable: true
---
[steps]
EOF
# Copy to gateway
cp gellyfish-hq/GAP/skills/global/<name>.md \
   ~/Workspace/gellyfish/config/skills/global/<name>.md
```

### HQ docs
If a process changed (how blooms work, how to deploy, team structure), update the relevant doc in `gellyfish-hq/`.

## Step 3 — Commit and push

```bash
cd ~/Workspace/gellyfish-hq
git add .
git commit -m "bequeath: <your-profile> — <one line summary>"
git push origin main
```

## Step 4 — Bequeath summary

Write a structured summary of what you persisted:

```
## Bequeath Summary

**→ GitHub board:** [list any new issues filed]
**→ system-prompt.md:** [what changed, or "no changes"]
**→ CLAUDE.md:** [what was added/updated]
**→ Skills:** [any new skills created]
**→ HQ docs:** [any docs updated]
**→ Discarded:** [what you chose NOT to persist and why]
```

## Step 5 — New agent check

Imagine you are a brand new instance of this profile, just started, reading only your updated CLAUDE.md and system-prompt.md. Ask yourself:

- Would I know how to restart the MCPs I depend on?
- Would I know who's in my crew and how to reach them?
- Would I know the standing rules and behavioral constraints?
- Would I avoid the mistakes this session hit?
- Is there anything I'd be confused about or have to rediscover?

If yes to the last question — go back and fill the gap. If everything checks out, the bequeath is done.

## Why this matters

When your process dies, your polyp starts from zero. It reads CLAUDE.md and system-prompt.md — that's it. Everything in your context window is gone. Route knowledge to the right place so your polyp inherits wisdom, not noise.
