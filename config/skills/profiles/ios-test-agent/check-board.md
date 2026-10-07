---
name: check-board
description: Check the GAP project board for tickets assigned to you or your crew
user-invocable: true
---

Check the GitHub project board for work assigned to you or available to pick up.

## Steps

1. Find your profile name from your CLAUDE.md or workspace directory name
2. Check for open issues assigned to you or your crew:

```bash
# List all open issues on the GAP repo
gh issue list --repo gellyfish-ai/Gellyfish-Agent-Platform --state open \
  --json number,title,labels,assignees \
  --jq '.[] | "#\(.number) [\(.labels | map(.name) | join(","))] \(.title)"'
```

3. Prioritize by label: P0 first, then P1, then P2
4. Check if any issues have your profile name mentioned in comments
5. Report what you found:
   - Issues you should work on (matching your role/crew)
   - Issues blocked or waiting for QA
   - Any P0s that need immediate attention

## When to use
- At the start of a session (what should I work on?)
- When you finish a task (what's next?)
- When asked for a status update
- During a scheduled check-in

## Output
Summarize briefly:
- "Found 3 issues for GAP crew: #50 (P0, permission bug), #54 (P1, skills), #14 (P0, status dots)"
- "No issues assigned to me. Board looks clear."
