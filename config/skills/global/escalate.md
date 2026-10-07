---
name: escalate
description: Escalate an issue to the CEO or crew lead when you are blocked or need a decision
user-invocable: true
---

Escalate when you are blocked, need a decision beyond your authority, or encounter something urgent that needs human attention.

## Usage
`/escalate <reason>`

## Steps

1. Identify who to escalate to:
   - **Crew lead** (Gellyfish Coordinator) for work-related blocks, technical decisions, priority questions
   - **CEO** (Gellyfish CEO Assistant) for company-level decisions, process changes, budget questions

2. Send the escalation via Task API:

```bash
# Escalate to Coordinator
COORDINATOR_ID="9d181ba2-350f-4d44-ba88-54fedc04c405"

# Escalate to CEO
CEO_ID="5e0c2b8a-6e09-43c8-a8a7-5fa621877fb8"

# Find your own profile ID
MY_ID=$(sqlite3 ~/Workspace/gellyfish/apps/gateway/data/gellyfish.db \
  "SELECT id FROM profiles WHERE workspace_dir LIKE '%$(basename $PWD)%' LIMIT 1")

curl -s -X POST http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d "{\"creatorProfileId\": \"$MY_ID\", \"assigneeProfileId\": \"$COORDINATOR_ID\", \"message\": \"ESCALATION: <reason>\", \"keepAlive\": true}"
```

3. Include in your escalation message:
   - What you were trying to do
   - What went wrong or what decision is needed
   - What you have already tried
   - Suggested options if you have any

## When to escalate
- Blocked for more than 10 minutes with no workaround
- Need to make a decision that affects other agents or the product
- Found a security issue or data problem
- A task from the board is unclear or contradictory
- Something is broken that you cannot fix yourself
