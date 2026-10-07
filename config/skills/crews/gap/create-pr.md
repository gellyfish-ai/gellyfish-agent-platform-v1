---
name: create-pr
description: Create a pull request for your current branch with proper formatting
user-invocable: true
---

Create a pull request for your current feature branch targeting main.

## Steps

1. Verify you are on a feature branch (not main):
```bash
BRANCH=$(git branch --show-current)
if [ "$BRANCH" = "main" ]; then echo "ERROR: You are on main. Create a feature branch first."; exit 1; fi
```

2. Push your branch:
```bash
git push -u origin $BRANCH
```

3. Generate PR title from branch name and recent commits:
- Branch `feat/agent-model-schema` → title: `feat(gateway): agent model schema`
- Include issue references from commit messages

4. Create the PR:
```bash
gh pr create --repo gellyfish-ai/Gellyfish-Agent-Platform \
  --base main \
  --head $BRANCH \
  --title "<type>(<scope>): <description>" \
  --body "$(cat <<'EOF'
## Summary
<bullet points of what changed>

## Issues
<Closes #XX, Closes #YY>

## Testing
<how this was tested>
EOF
)"
```

5. Report the PR URL back to whoever assigned the task.

## Commit message format
Follow the repo convention: `<type>(<scope>): <description>`
Types: feat, fix, test, docs, refactor, chore, ci

## Important
- Always target main
- Reference all related issue numbers
- Do NOT merge — the coordinator or QA will review first
