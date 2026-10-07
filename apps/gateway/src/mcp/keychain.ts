/**
 * Keychain resolver — resolves `keychain:service/account` references
 * to secrets from the macOS Keychain at spawn time.
 *
 * DB stores the reference string, never the resolved secret.
 * Resolution only happens when writing .mcp.json for an agent spawn.
 */

import { execSync } from 'child_process';
import { logger } from '../logger.js';

const KEYCHAIN_PREFIX = 'keychain:';

/** Check if a value is a keychain reference (e.g. `keychain:bluesky/app-password`) */
export function isKeychainRef(value: string): boolean {
  return value.startsWith(KEYCHAIN_PREFIX);
}

/**
 * Parse a keychain reference into service and account.
 * Format: `keychain:<service>/<account>`
 * Throws if the format is invalid.
 */
export function parseKeychainRef(ref: string): { service: string; account: string } {
  const body = ref.slice(KEYCHAIN_PREFIX.length);
  const slashIdx = body.indexOf('/');
  if (slashIdx <= 0 || slashIdx === body.length - 1) {
    throw new Error(`Invalid keychain reference: "${ref}". Expected format: keychain:service/account`);
  }
  return {
    service: body.slice(0, slashIdx),
    account: body.slice(slashIdx + 1),
  };
}

/**
 * Resolve a keychain reference to its secret value.
 * Calls macOS `security find-generic-password` to look up the password.
 * Throws if the keychain entry is not found.
 */
export function resolveKeychainRef(ref: string): string {
  const { service, account } = parseKeychainRef(ref);

  try {
    const password = execSync(
      `security find-generic-password -s ${shellEscape(service)} -a ${shellEscape(account)} -w`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    return password;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ service, account, error: msg }, '[keychain] failed to resolve keychain ref');
    throw new Error(`Keychain lookup failed for ${service}/${account}: entry not found or access denied`);
  }
}

/**
 * Resolve all keychain references in an env object.
 * Returns a new object with resolved values. Non-keychain values pass through unchanged.
 */
export function resolveEnvKeychainRefs(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isKeychainRef(value)) {
      resolved[key] = resolveKeychainRef(value);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/** Escape a string for safe use in a shell command argument */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
