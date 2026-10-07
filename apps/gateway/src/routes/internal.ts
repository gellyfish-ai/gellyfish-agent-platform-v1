import { FastifyInstance } from 'fastify';
import { logger } from '../logger.js';
import { sendVaultLockPush } from '../apns/index.js';

/**
 * Internal routes — reachable only from loopback. These are signal endpoints
 * for co-located services (e.g. the Bitwarden vault container) to notify the
 * gateway of state changes. The loopback binding IS the security boundary;
 * no auth is required.
 */

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const VAULT_LOCK_RATE_LIMIT_MS = 60 * 60 * 1000; // 1 push per hour — resets on gateway restart, per HQ#22

let vaultLockLastPushAt = 0;

function isLoopback(ip: string | undefined): boolean {
  return !!ip && LOOPBACK_ADDRS.has(ip);
}

export async function internalRoutes(server: FastifyInstance) {
  // POST /api/internal/vault-locked — vault fires this when `bw serve` returns
  // "Vault is locked". Push lands on paired devices so the CEO can unlock.
  server.post('/internal/vault-locked', async (req, reply) => {
    const ip = req.ip;

    if (!isLoopback(ip)) {
      // Do not advertise the endpoint to non-loopback callers.
      logger.info({ ip }, '[vault-lock] rejecting non-loopback request');
      return reply.status(404).send({ error: 'Not found' });
    }

    const now = Date.now();
    const elapsed = now - vaultLockLastPushAt;
    if (vaultLockLastPushAt > 0 && elapsed < VAULT_LOCK_RATE_LIMIT_MS) {
      const remainingMs = VAULT_LOCK_RATE_LIMIT_MS - elapsed;
      logger.info(
        { ip, remainingMs },
        `[vault-lock] event received — rate-limited, ${Math.ceil(remainingMs / 1000)}s remaining`,
      );
      return { ok: true, pushed: false };
    }

    vaultLockLastPushAt = now;
    logger.info({ ip }, '[vault-lock] event received — firing push');
    const { sent, total } = await sendVaultLockPush();
    logger.info({ sent, total }, '[vault-lock] push dispatched');

    return { ok: true, pushed: true };
  });
}
