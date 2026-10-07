/**
 * APNs push notification module.
 * Uses Node built-in http2 for HTTP/2 transport to Apple Push Notification service.
 */

import crypto from 'crypto';
import http2 from 'http2';
import { readFileSync } from 'fs';
import { logger } from '../logger.js';
import { getDevices } from '../db/devices.js';

const APNS_HOST = 'https://api.push.apple.com';

// Cached JWT token
let cachedToken: string | null = null;
let cachedTokenExpiry = 0;

function getConfig() {
  return {
    keyPath: process.env.APNS_KEY_PATH || '',
    keyId: process.env.APNS_KEY_ID || '',
    teamId: process.env.APNS_TEAM_ID || '',
    bundleId: process.env.APNS_BUNDLE_ID || '',
  };
}

function isConfigured(): boolean {
  const c = getConfig();
  return !!(c.keyPath && c.keyId && c.teamId && c.bundleId);
}

/** Generate ES256 JWT for APNs (cached for ~55 min). */
function getJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedTokenExpiry) return cachedToken;

  const config = getConfig();
  const key = readFileSync(config.keyPath, 'utf-8');

  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: config.teamId, iat: now })).toString('base64url');
  const signingInput = `${header}.${claims}`;

  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  const derSig = sign.sign(key);

  // Convert DER signature to raw r||s (64 bytes)
  const rawSig = derToRaw(derSig);
  const signature = rawSig.toString('base64url');

  cachedToken = `${signingInput}.${signature}`;
  cachedTokenExpiry = now + 55 * 60; // Cache for 55 min (APNs tokens last 60)
  return cachedToken;
}

/** Convert DER-encoded ECDSA signature to raw r||s format. */
function derToRaw(der: Buffer): Buffer {
  // DER: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
  let offset = 2; // skip 0x30 + total len
  if (der[1] & 0x80) offset += (der[1] & 0x7f); // handle multi-byte length

  // r
  offset++; // skip 0x02
  let rLen = der[offset++];
  let rStart = offset;
  offset += rLen;

  // s
  offset++; // skip 0x02
  let sLen = der[offset++];
  let sStart = offset;

  // Strip leading zeros (padding to 32 bytes)
  const r = der.subarray(rStart, rStart + rLen);
  const s = der.subarray(sStart, sStart + sLen);

  const raw = Buffer.alloc(64);
  r.copy(raw, 32 - Math.min(r.length, 32), Math.max(r.length - 32, 0));
  s.copy(raw, 64 - Math.min(s.length, 32), Math.max(s.length - 32, 0));
  return raw;
}

/** Send a push notification to a single device token. */
async function sendPush(deviceToken: string, payload: Record<string, unknown>, category?: string): Promise<boolean> {
  if (!isConfigured()) {
    logger.warn('[apns] not configured — skipping push');
    return false;
  }

  const config = getConfig();
  const jwt = getJwt();
  const body = JSON.stringify(payload);

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (success: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve(success);
    };

    const timeout = setTimeout(() => {
      logger.warn({ deviceToken: deviceToken.substring(0, 8) }, '[apns] push timed out after 10s');
      try { client.destroy(); } catch { /* */ }
      finish(false);
    }, 10_000);

    const client = http2.connect(APNS_HOST);
    client.on('error', (err: Error) => {
      logger.error({ error: String(err), deviceToken: deviceToken.substring(0, 8) }, '[apns] connection error');
      try { client.destroy(); } catch { /* */ }
      finish(false);
    });

    const headers: Record<string, string> = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${jwt}`,
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
    };
    if (category) {
      headers['apns-collapse-id'] = category;
    }

    const req = client.request(headers);
    let status = 0;
    let responseBody = '';

    req.setEncoding('utf-8');
    req.on('response', (h) => { status = h[':status'] as number; });
    req.on('data', (chunk: string) => { responseBody += chunk; });
    req.on('end', () => {
      client.close();
      if (status === 200) {
        finish(true);
      } else {
        logger.warn({ status, responseBody, deviceToken: deviceToken.substring(0, 8) }, '[apns] push failed');
        finish(false);
      }
    });
    req.on('error', (err: Error) => {
      logger.error({ error: String(err) }, '[apns] request error');
      try { client.destroy(); } catch { /* */ }
      finish(false);
    });

    req.end(body);
  });
}

/**
 * Identity envelope read by the iOS in-app approval card (#658).
 *
 * iOS already decodes these exact keys via `userInfo["agentName"]` etc.
 * (`PushNotificationManager.swift:455-460`). Any rename here MUST be
 * coordinated with the iOS Coder. The default strings are intentionally
 * loud — a literal "(unknown agent)" tells the user something is wrong
 * upstream, instead of the friendly-but-misleading "Agent" iOS used to
 * fall back to.
 */
export interface ApprovalIdentityPayload {
  agentName: string;
  profileName: string;
  /** Display label "<mcp>: <tool>" — the iOS card renders this verbatim. */
  tool: string;
  /** Human-readable preview (currently the same string as `aps.alert.body`). */
  summary: string;
  /** Raw mcp name, exposed so iOS can filter without re-parsing `tool`. */
  mcpName: string;
  /** Raw tool name, exposed so iOS can filter without re-parsing `tool`. */
  toolName: string;
}

export interface ApprovalIdentityInput {
  mcpName: string;
  toolName: string;
  agentDisplayName: string | null | undefined;
  profileDisplayName: string | null | undefined;
  humanPreview: string | null | undefined;
}

/**
 * Build the identity payload shared by APNs and the WebSocket envelope.
 * Single source of truth so the regression test can assert one shape and
 * cover both transports — see `apps/gateway/tests/unit/approval-payload.test.ts`.
 */
export function buildApprovalIdentityPayload(input: ApprovalIdentityInput): ApprovalIdentityPayload {
  const mcpName = input.mcpName || '(unknown mcp)';
  const toolName = input.toolName || '(unknown tool)';
  return {
    agentName: input.agentDisplayName || '(unknown agent)',
    profileName: input.profileDisplayName || '(unknown profile)',
    tool: `${mcpName}: ${toolName}`,
    summary: input.humanPreview || '(unknown action)',
    mcpName,
    toolName,
  };
}

/**
 * Send an approval push to all registered devices.
 *
 * `nonce` and `action_hash` are included in userInfo because iOS reads them
 * verbatim into its ECDSA signing payload (nonce || action_hash || action).
 * Omitting either field causes the device to sign with empty strings, and
 * the gateway can never verify the resulting signature.
 *
 * The identity fields (`agentName`, `profileName`, `tool`, `summary`,
 * `mcpName`, `toolName`) are required so the iOS in-app card can render
 * who is asking and what they want. iOS reads non-existent keys as
 * "(unknown agent)" / "(unknown action)" — see #658 for the full
 * contract. The regression test asserts every key is present.
 */
export async function sendApprovalPush(
  approvalId: string,
  preview: string,
  ttl: number,
  nonce: string,
  actionHash: string,
  identity: ApprovalIdentityPayload,
): Promise<void> {
  const devices = getDevices();
  if (devices.length === 0) return;

  const payload = {
    aps: {
      alert: { title: 'Approval Required', body: `${preview}\n\nOpen on iPhone to approve or deny.` },
      sound: 'default',
      category: 'approval',
      'thread-id': approvalId,
      'content-available': 1,
    },
    approvalId,
    ttl,
    nonce,
    action_hash: actionHash,
    ...identity,
  };

  const results = await Promise.allSettled(
    devices.map(d => sendPush(d.device_token, payload, 'approval'))
  );
  const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;
  logger.info({ approvalId, sent, total: devices.length }, '[apns] approval push sent');
}

/**
 * Build the full APNs payload that `sendApprovalPush` would send. Exported
 * so the regression test (#658) can assert payload shape without spinning
 * up an HTTP/2 client or hitting Apple. Production code goes through
 * `sendApprovalPush`; this is a pure shape helper.
 */
export function buildApprovalApnsPayload(args: {
  approvalId: string;
  preview: string;
  ttl: number;
  nonce: string;
  actionHash: string;
  identity: ApprovalIdentityPayload;
}): Record<string, unknown> {
  return {
    aps: {
      alert: { title: 'Approval Required', body: `${args.preview}\n\nOpen on iPhone to approve or deny.` },
      sound: 'default',
      category: 'approval',
      'thread-id': args.approvalId,
      'content-available': 1,
    },
    approvalId: args.approvalId,
    ttl: args.ttl,
    nonce: args.nonce,
    action_hash: args.actionHash,
    ...args.identity,
  };
}

/** Send a general status push to all registered devices. */
export async function sendStatusPush(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
  const devices = getDevices();
  if (devices.length === 0) return;

  const payload = {
    aps: {
      alert: { title, body },
      sound: 'default',
    },
    ...data,
  };

  await Promise.allSettled(
    devices.map(d => sendPush(d.device_token, payload))
  );
}

/**
 * Send a vault-lock alert to all paired devices. Plain notification — no
 * approvalId, no signing. Returns the dispatch count so the caller can log.
 */
export async function sendVaultLockPush(): Promise<{ sent: number; total: number }> {
  const devices = getDevices();
  if (devices.length === 0) return { sent: 0, total: 0 };

  const payload = {
    aps: {
      alert: { title: 'Vault locked', body: 'Credential flows are blocked until unlocked.' },
      sound: 'default',
      category: 'vault-lock',
    },
  };

  const results = await Promise.allSettled(
    devices.map(d => sendPush(d.device_token, payload, 'vault-lock'))
  );
  const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;
  return { sent, total: devices.length };
}
