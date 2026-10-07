#!/bin/bash
set -e

echo "=== TestFlight Pre-flight Check ==="

# 1. Check Xcode Apple ID session
APPLE_IDS=$(defaults read com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists 2>/dev/null || echo "{}")
ENTRY_COUNT=$(echo "$APPLE_IDS" | grep -c "identifier" || true)
if [ "$ENTRY_COUNT" -eq 0 ]; then
  echo "FAIL: No Apple ID signed in to Xcode."
  echo "Fix: Open Xcode -> Settings -> Accounts -> Sign in with your Apple ID"
  exit 1
fi
echo "OK: Apple ID signed in"

# 2. Check keychain is unlocked
if ! security show-keychain-info login.keychain-db 2>&1 | grep -q "no-timeout\|timeout="; then
  echo "FAIL: Keychain may be locked."
  echo "Fix: security unlock-keychain login.keychain-db"
  exit 1
fi
echo "OK: Keychain accessible"

# 3. Check signing identity exists
IDENTITIES=$(security find-identity -v -p codesigning 2>&1)
if ! echo "$IDENTITIES" | grep -q "valid identities found"; then
  echo "FAIL: No code signing identity found."
  exit 1
fi
echo "OK: Signing identity found"

# 4. Check API key exists (optional, for future CLI uploads)
if [ -f ~/.private_keys/AuthKey_T5P75XCL6L.p8 ]; then
  echo "OK: App Store Connect API key found"
else
  echo "WARN: No API key at ~/.private_keys/ (optional)"
fi

echo ""
echo "=== All checks passed — ready to build ==="
