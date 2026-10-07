import crypto from 'crypto';
import db from './connection.js';

export interface PairedDevice {
  id: string;
  device_token: string;
  device_name: string;
  public_key: string | null;
  paired_at: string;
}

/** Register a device (upsert by token). */
export function registerDevice(deviceToken: string, deviceName: string): PairedDevice {
  const existing = db.prepare('SELECT * FROM paired_devices WHERE device_token = ?').get(deviceToken) as PairedDevice | undefined;
  if (existing) {
    db.prepare('UPDATE paired_devices SET device_name = ?, paired_at = datetime(\'now\') WHERE id = ?').run(deviceName, existing.id);
    return getDevice(existing.id)!;
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO paired_devices (id, device_token, device_name) VALUES (?, ?, ?)').run(id, deviceToken, deviceName);
  return getDevice(id)!;
}

/** Get all registered devices. */
export function getDevices(): PairedDevice[] {
  return db.prepare('SELECT * FROM paired_devices ORDER BY paired_at DESC').all() as PairedDevice[];
}

/** Get a device by ID. */
export function getDevice(id: string): PairedDevice | undefined {
  return db.prepare('SELECT * FROM paired_devices WHERE id = ?').get(id) as PairedDevice | undefined;
}

/** Delete a device by ID. */
export function deleteDevice(id: string): boolean {
  const result = db.prepare('DELETE FROM paired_devices WHERE id = ?').run(id);
  return result.changes > 0;
}
