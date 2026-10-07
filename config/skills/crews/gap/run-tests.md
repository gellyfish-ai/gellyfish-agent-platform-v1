---
name: run-tests
description: Run the gateway test suite and report results
user-invocable: true
---

Run the gateway test suite and report results.

## Steps

1. Navigate to the gateway directory:
```bash
cd ~/Workspace/gellyfish/apps/gateway
```

2. Run the test suite:
```bash
pnpm test 2>&1
```

3. Report results:
   - If all tests pass: "All tests pass. Ready to merge."
   - If tests fail: list failing tests with error messages
   - If no tests exist: "No test suite configured yet (tracked in #21)"

4. If tests fail, check if the failures are related to your changes:
   - Run `git diff --name-only` to see what you changed
   - Compare with the failing test files
   - If your changes caused the failure, fix before creating PR

## When to use
- Before creating a PR
- After making changes to verify nothing broke
- When QA asks you to verify
