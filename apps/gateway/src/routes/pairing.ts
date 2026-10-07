import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { registerDevice, getDevices, deleteDevice } from '../db/devices.js';
import db from '../db/index.js';
import { logger } from '../logger.js';
import { broadcastToAll } from './chat-ws.js';

const VAULT_URL = process.env.VAULT_URL || 'http://localhost:8205';

// In-memory pairing requests (5-min TTL)
interface PairingRequest {
  code: string;
  deviceToken: string;
  deviceName: string;
  publicKey: string;
  expiresAt: number;
}

const pairingRequests = new Map<string, PairingRequest>();

function generateCode(): string {
  return String(crypto.randomInt(100000, 999999));
}

function cleanExpired(): void {
  const now = Date.now();
  for (const [code, req] of pairingRequests) {
    if (now > req.expiresAt) pairingRequests.delete(code);
  }
}

export async function pairingRoutes(server: FastifyInstance) {
  // POST /api/devices/pair — initiate pairing (device sends public key)
  server.post<{
    Body: { public_key: string; device_token: string; device_name: string };
  }>('/devices/pair', async (req, reply) => {
    const { public_key, device_token, device_name } = req.body;
    if (!public_key || !device_token || !device_name) {
      return reply.status(400).send({ error: 'public_key, device_token, and device_name are required' });
    }

    cleanExpired();
    const code = generateCode();
    pairingRequests.set(code, {
      code,
      deviceToken: device_token,
      deviceName: device_name,
      publicKey: public_key,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
    });

    logger.info({ deviceName: device_name, code }, '[pairing] code generated');

    // Broadcast to all connected browsers
    broadcastToAll({
      type: 'pairing_request',
      deviceName: device_name,
      code,
      expiresIn: 300,
    });

    return { code, expires_in: 300 };
  });

  // POST /api/devices/pair/confirm — confirm pairing with code
  server.post<{
    Body: { code: string };
  }>('/devices/pair/confirm', async (req, reply) => {
    const { code } = req.body;
    if (!code) return reply.status(400).send({ error: 'code is required' });

    cleanExpired();
    const request = pairingRequests.get(code);
    if (!request) {
      return reply.status(404).send({ error: 'Invalid or expired pairing code' });
    }

    // Register device locally (keeps device_token for APNs)
    const device = registerDevice(request.deviceToken, request.deviceName);
    db.prepare('UPDATE paired_devices SET public_key = ? WHERE id = ?').run(request.publicKey, device.id);

    // Relay to vault — vault stores public key for ECDSA verification.
    // Fail loud and roll back the local pair on any failure: partial
    // state (paired locally, missing in vault) breaks downstream ECDSA
    // verification and hangs the iOS UI (GAP#734).
    let vaultResp: Response;
    try {
      vaultResp = await fetch(VAULT_URL + '/devices/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: device.id,
          device_token: request.deviceToken,
          device_name: request.deviceName,
          public_key: request.publicKey,
        }),
      });
    } catch (err) {
      logger.error({ deviceId: device.id, error: String(err) }, '[pairing] vault unreachable — rolling back pair');
      deleteDevice(device.id);
      return reply.status(502).send({ error: 'Pairing failed: vault unreachable' });
    }

    if (!vaultResp.ok) {
      const body = await vaultResp.text();
      logger.error({ status: vaultResp.status, body, deviceId: device.id }, '[pairing] vault sync rejected — rolling back pair');
      deleteDevice(device.id);
      return reply.status(502).send({
        error: 'Pairing failed: vault sync rejected',
        vault_status: vaultResp.status,
      });
    }

    logger.info({ deviceId: device.id }, '[pairing] device synced to vault');

    pairingRequests.delete(code);
    logger.info({ deviceId: device.id, deviceName: request.deviceName }, '[pairing] device paired with public key');

    // Notify browsers
    broadcastToAll({
      type: 'pairing_confirmed',
      deviceId: device.id,
      deviceName: request.deviceName,
    });

    return { device: { ...device, public_key: request.publicKey } };
  });
}
