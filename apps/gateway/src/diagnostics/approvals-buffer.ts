/**
 * Bounded in-memory ring buffer of approval-signature verify rounds.
 *
 * Captures only the cryptographic ground-truth bytes needed to reproduce a
 * verify offline (payload, signature, public key, hashes, result). Holds no
 * tool arguments and no PII — the schema below is the entire surface.
 *
 * Wiped on gateway restart. Gated by the `diagnostics_approvals` setting:
 * when off, append() is a no-op so the hot path costs one settings lookup
 * per verify call. Endpoints that read this buffer enforce the same flag.
 */

import { getSetting } from '../db/settings.js';

export type ApprovalAction = 'APPROVED' | 'REJECTED';

export interface ApprovalDiagnosticEntry {
  approval_id: string;
  created_at: string;
  mcp_name: string;
  tool_name: string;
  device_id: string;
  /** Snapshot of agents.name at create time (#658). Null when agent_id was unset. */
  agent_display_name: string | null;
  /** Snapshot of profiles.name at create time (#658). Null when profile_id was unset. */
  profile_display_name: string | null;
  nonce_hex: string;
  action_hash_hex: string;
  action: ApprovalAction;
  payload_utf8: string;
  payload_sha256_hex: string;
  pubkey_base64: string;
  pubkey_bytes_length: number;
  is_raw_x963: boolean;
  signature_base64: string;
  signature_der_length: number;
  verify_result: boolean;
  failure_reason: string | null;
}

const MAX_ENTRIES = 100;
const entries: ApprovalDiagnosticEntry[] = [];

export function isDiagnosticsEnabled(): boolean {
  return getSetting('diagnostics_approvals') === 'true';
}

export function appendApprovalDiagnostic(entry: ApprovalDiagnosticEntry): void {
  if (!isDiagnosticsEnabled()) return;
  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();
}

export function getRecentApprovalDiagnostics(limit: number): ApprovalDiagnosticEntry[] {
  const safe = Math.max(1, Math.min(MAX_ENTRIES, Math.floor(limit)));
  return entries.slice(-safe).reverse();
}

export function getApprovalDiagnosticById(approvalId: string): ApprovalDiagnosticEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].approval_id === approvalId) return entries[i];
  }
  return undefined;
}

// Test seam — never call from production code paths.
export function __resetApprovalDiagnosticsForTest(): void {
  entries.length = 0;
}
