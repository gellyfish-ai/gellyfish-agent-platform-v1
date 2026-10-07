import { FastifyInstance } from 'fastify';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

const KEYCHAIN_PATH = path.join(os.homedir(), 'Library', 'Keychains', 'automation.keychain-db');
const KEYCHAIN_PASSWORD = 'automation';

async function unlockKeychain() {
  await execFileAsync('security', ['unlock-keychain', '-p', KEYCHAIN_PASSWORD, KEYCHAIN_PATH]);
}

export async function credentialsRoutes(server: FastifyInstance) {

  // GET /api/credentials — list all credentials (service + account only, never passwords)
  server.get('/credentials', async (_req, reply) => {
    try {
      await unlockKeychain();
      const { stdout } = await execFileAsync('security', ['dump-keychain', KEYCHAIN_PATH]);

      const credentials: { service: string; account: string }[] = [];

      // Split by keychain item blocks (each starts with "keychain:" header)
      const blocks = stdout.split(/^keychain:/m);
      for (const block of blocks) {
        const serviceMatch = block.match(/"svce"<blob>="(.+?)"/);
        const accountMatch = block.match(/"acct"<blob>="(.+?)"/);
        if (serviceMatch && accountMatch) {
          credentials.push({ service: serviceMatch[1], account: accountMatch[1] });
        }
      }

      return { credentials };
    } catch (error: any) {
      server.log.error({ err: error }, 'Failed to list credentials');
      return reply.status(500).send({ error: 'Failed to list credentials' });
    }
  });

  // POST /api/credentials — add a credential to the keychain
  server.post<{
    Body: { service: string; account: string; password: string };
  }>('/credentials', async (req, reply) => {
    const { service, account, password } = req.body;

    if (!service || !account || !password) {
      return reply.status(400).send({ error: 'service, account, and password are required' });
    }

    try {
      await unlockKeychain();
      await execFileAsync('security', [
        'add-generic-password',
        '-a', account,
        '-s', service,
        '-w', password,
        '-U', // update if exists
        KEYCHAIN_PATH,
      ]);

      // Do NOT log the request body — it contains the password
      server.log.info({ service, account }, 'Credential added to keychain');
      return { ok: true };
    } catch (error: any) {
      server.log.error({ err: error, service, account }, 'Failed to add credential');
      return reply.status(500).send({ error: 'Failed to add credential' });
    }
  });

  // DELETE /api/credentials/:service/:account — remove a credential
  server.delete<{
    Params: { service: string; account: string };
  }>('/credentials/:service/:account', async (req, reply) => {
    const { service, account } = req.params;

    try {
      await unlockKeychain();
      await execFileAsync('security', [
        'delete-generic-password',
        '-a', account,
        '-s', service,
        KEYCHAIN_PATH,
      ]);

      server.log.info({ service, account }, 'Credential deleted from keychain');
      return { ok: true };
    } catch (error: any) {
      server.log.error({ err: error, service, account }, 'Failed to delete credential');
      return reply.status(500).send({ error: 'Failed to delete credential' });
    }
  });
}
