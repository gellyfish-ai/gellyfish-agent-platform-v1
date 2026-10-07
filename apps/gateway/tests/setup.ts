/**
 * Test setup — isolate tests from the production database.
 *
 * Sets DATA_DIR to a temporary directory so db.ts creates a fresh
 * SQLite database for each test run. This prevents tests from
 * nuking production data (the DELETE FROM tasks disaster).
 */

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Must run before any src/ imports — db.ts reads DATA_DIR at import time
const testDataDir = mkdtempSync(join(tmpdir(), 'gellyfish-test-'));
process.env.DATA_DIR = testDataDir;

// Also prevent tests from connecting to the real PM
process.env.PM_SOCKET = join(testDataDir, 'test-pm.sock');
