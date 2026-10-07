---
name: btw
description: Send a non-blocking message to another agent without waiting for a response
user-invocable: true
---

Send a non-blocking message to another agent. The message is delivered as a task but you do NOT wait for a response — continue with your current work.

## Usage
`/btw <agent-name-or-profile> <message>`

## How it works
1. Look up the target agent/profile in the database
2. Send a task via the Task API with keepAlive=false
3. Do NOT poll or wait for the task to complete
4. Continue with whatever you were doing

## Implementation
```bash
# Find the target profile
TARGET_ID=$(sqlite3 ~/Workspace/gellyfish/apps/gateway/data/gellyfish.db \
  "SELECT id FROM profiles WHERE name LIKE '%$1%' LIMIT 1")

# Find your own profile ID
MY_ID=$(sqlite3 ~/Workspace/gellyfish/apps/gateway/data/gellyfish.db \
  "SELECT id FROM profiles WHERE workspace_dir LIKE '%$(basename $PWD)%' LIMIT 1")

# Send the message
curl -s -X POST http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d "{\"creatorProfileId\": \"$MY_ID\", \"assigneeProfileId\": \"$TARGET_ID\", \"message\": \"$2\", \"keepAlive\": false}"
```

## Important
- This is fire-and-forget. You will not see a response.
- Use this for FYIs, status updates, and notifications — not for work that needs a reply.
- If you need a response, use the Task API directly with keepAlive=true and poll for the result.
