# Complete Task

When you receive a task (message starting with `[Task <id>]`), follow this workflow:

## 1. Do the work
Complete the assignment as described in the task message.

## 2. Mark the task complete
When done, use the curl command provided at the end of the task message to mark it complete. Write a good result summary:

**Good result summary includes:**
- What you did (1-2 sentences)
- Key deliverables (PR number, file changed, test results)
- Whether the coordinator needs to take action (merge PR, review, deploy)
- What you plan to do next (if applicable)

**Example:**
```bash
curl -s -X POST http://localhost:3000/api/tasks/<id>/complete \
  -H 'Content-Type: application/json' \
  -d '{"result": "Implemented agent health endpoint and stale detection. PR #59 created. Ready for QA review. Will start #49 next."}'
```

## 3. If you fail
If you cannot complete the task, mark it failed with a clear error:

```bash
curl -s -X POST http://localhost:3000/api/tasks/<id>/fail \
  -H 'Content-Type: application/json' \
  -d '{"error": "Build fails with type error in db.ts line 45. Need guidance on the Agent interface changes."}'
```

## Important
- Always complete or fail the task — never leave it in `working` state
- The coordinator is waiting for your response
- If you're blocked, fail the task with details rather than staying silent
