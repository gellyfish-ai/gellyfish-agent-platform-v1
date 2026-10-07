# Ship Changes

Commit all changes and push to remote. Quick workflow for shipping work.

## Arguments
- `$ARGUMENTS` - Optional: commit message. If not provided, generate one from the changes.

## Instructions

1. **Check what's changed**:
   ```bash
   git status --short
   git diff --stat
   ```

2. **Stage all changes**:
   ```bash
   git add -A
   ```

3. **Create commit**:
   - If `$ARGUMENTS` provided, use it as the commit message
   - If not provided, analyze the staged changes and generate a concise message describing what changed
   - Follow conventional commit style when appropriate (feat:, fix:, docs:, refactor:, etc.)
   - Include the standard footer

4. **Push to remote**:
   ```bash
   git push
   ```
   - If upstream not set, use `git push -u origin HEAD`

5. **Report result**:
   - Show commit hash and message
   - Confirm push succeeded
   - Show any warnings (e.g., large files, sensitive files)

## Commit Format

```
<type>: <description>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

## Safety

- Warn (but don't block) if committing .env, credentials, or secrets
- Skip empty commits
