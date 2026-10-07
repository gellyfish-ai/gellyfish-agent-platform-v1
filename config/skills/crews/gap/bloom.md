---
name: bloom
description: Plan, execute, and ship a batch of tickets as a coordinated bloom
---

# /bloom — Coordinated Batch Work

A **bloom** is our unit of coordinated work — a batch of ~5-10 tickets that get assigned, developed, reviewed, tested, and deployed together. Named after jellyfish blooms.

## Phase 1: Plan

1. **Check the board** — review open tickets, priorities, dependencies:
   ```bash
   gh issue list --repo gellyfish-ai/Gellyfish-Agent-Platform --state open --json number,title,labels --jq '.[] | "#\(.number) \(.title) [\(.labels | map(.name) | join(", "))]"'
   ```

2. **Propose the bloom** — select 5-10 tickets that form a coherent batch:
   - Group by theme (bug fixes, feature, refactor)
   - Identify dependencies (which tickets must complete before others can start)
   - Identify parallelism (which tickets can run simultaneously)
   - Assign to agents based on their profile (GAP Coder, iOS Coder, QA, etc.)

3. **Present the plan** to the human/CEO:
   ```
   ## Bloom: [Name]

   | # | Title | Agent | Depends On | Parallel? |
   |---|-------|-------|------------|-----------|
   | #123 | Fix X | GAP Coder | — | Yes |
   | #124 | Add Y | GAP Coder | #123 | No |
   | #125 | Test Z | QA | #123 | After #123 |

   Estimated: [X tickets, Y agents, Z parallel tracks]
   ```

4. **Wait for approval** — the human reviews and says GO. Never start without GO.

## Phase 2: Execute

1. **Assign tickets** — send tasks to agents. Parallel where possible:
   - Group independent tickets and assign simultaneously
   - Sequential tickets wait for the previous one to complete
   - Each task message references the issue and approved approach

2. **Monitor progress** — track which agents are working, which are done:
   ```bash
   # Check your active tasks
   curl -s 'http://localhost:3000/api/tasks?creator=<your_profile_id>' | python3 -c "
   import sys, json
   for t in json.load(sys.stdin).get('tasks', []):
       print(f'{t[\"state\"]:10} | {t[\"message\"][:80]}')"
   ```

3. **Review PRs** as they come in:
   - Does the PR match the approved approach?
   - Any unrelated changes or scope creep?
   - Send to QA if approach is correct

4. **Handle failures** — if an agent gets stuck:
   - Check their conversation for errors
   - Provide guidance or reassign
   - Escalate to CEO if blocked

5. **QA pass** — every PR gets QA review:
   - Assign to QA agent with test plan
   - QA adds `qa:pass` or `qa:fail`
   - Failed PRs go back to the coder with repro steps

6. **Merge** — squash merge each PR after `qa:pass`

## Phase 3: Ship

1. **Verify all bloom tickets are merged** — check that every issue in the bloom has a merged PR

2. **Notify for deployment**:
   - Tell the human to rebuild prod: "Bloom [Name] is complete. Please restart prod to deploy."
   - If iOS changes: "TestFlight build needed for iOS changes in this bloom."

3. **Report what shipped**:
   ```
   ## Bloom [Name] — Shipped

   | # | Title | PR | Status |
   |---|-------|----|--------|
   | #123 | Fix X | #456 | Merged ✓ |
   | #124 | Add Y | #457 | Merged ✓ |

   Total: X tickets, Y PRs merged
   Needs: prod restart / TestFlight build / nothing
   ```

4. **Close issues** — close all bloom issues on GitHub

5. **Update the board** — move all bloom tickets to Done

## Rules

- **Never start Phase 2 without human GO**
- **Never skip QA** — every PR gets tested
- **Never merge without qa:pass**
- **Keep the bloom focused** — don't add tickets mid-bloom unless P0
- **Report blockers immediately** — don't wait and hope
- **One bloom at a time** — finish and ship before starting the next
