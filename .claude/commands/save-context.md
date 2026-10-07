# Save Context

Save current conversation context to disk for restoration after restart.

## Instructions

1. Create a summary of the current conversation state including:
   - What we were working on
   - Current progress (completed tasks, pending tasks)
   - Key decisions made
   - Any important file paths or code references
   - Next steps

2. Write this summary to `.claude/context/session.md` (project-local, not home folder)

3. Confirm the context has been saved

```bash
mkdir -p .claude/context
```

Write the context summary to `.claude/context/session.md` in markdown format.
