# Restore Context

Restore conversation context from previous session.

## Instructions

1. Check if `.claude/context/session.md` exists in the project
2. If it exists, read it and summarize the previous session state
3. Delete the file after reading (one-time restore)
4. Continue from where we left off

```bash
cat .claude/context/session.md 2>/dev/null && rm .claude/context/session.md
```
