import { FastifyInstance } from 'fastify';
import { registerDevice, getDevices, getDevice, deleteDevice } from '../db/devices.js';
import { insertAuditEntry } from '../db/audit-log.js';

export async function devicesRoutes(server: FastifyInstance) {
  // POST /api/devices/register — register a device for push notifications
  server.post<{
    Body: { device_token: string; device_name: string };
  }>('/devices/register', async (req, reply) => {
    const { device_token, device_name } = req.body;
    if (!device_token || !device_name) {
      return reply.status(400).send({ error: 'device_token and device_name are required' });
    }
    const device = registerDevice(device_token, device_name);
    return { device };
  });

  // GET /api/devices — list all registered devices
  server.get('/devices', async () => {
    return { devices: getDevices() };
  });

  // DELETE /api/devices/:id — remove a device
  server.delete<{ Params: { id: string } }>('/devices/:id', async (req, reply) => {
    const device = getDevice(req.params.id);
    if (!device) return reply.status(404).send({ error: 'Device not found' });
    deleteDevice(req.params.id);
    insertAuditEntry(req.params.id, 'device_revoked', 'admin', { deviceId: device.id, deviceName: device.device_name });
    return { ok: true, device: { id: device.id, device_name: device.device_name } };
  });
}
