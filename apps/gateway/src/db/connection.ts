import Database, { Database as DatabaseType } from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync, writeFileSync, readFileSync, copyFileSync, readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { logger } from '../logger.js';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const WORKSPACES_DIR = join(homedir(), '.gellyfish', 'workspaces');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(WORKSPACES_DIR, { recursive: true });

export { DATA_DIR, WORKSPACES_DIR };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Backup DB on startup (keeps last 3 backups)
const DB_PATH = join(DATA_DIR, 'gellyfish.db');
if (existsSync(DB_PATH)) {
  const BACKUP_DIR = join(DATA_DIR, 'backups');
  mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(DB_PATH, join(BACKUP_DIR, `gellyfish-${ts}.db`));
  const backups = readdirSync(BACKUP_DIR)
    .filter((f: string) => f.startsWith('gellyfish-') && f.endsWith('.db'))
    .sort()
    .reverse();
  for (const old of backups.slice(3)) {
    try { unlinkSync(join(BACKUP_DIR, old)); } catch { /* already deleted */ }
  }
  logger.info({ backup: `gellyfish-${ts}.db`, kept: Math.min(backups.length, 3) }, '[startup] DB backup created');
}

const db: DatabaseType = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🤖',
    system_prompt TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS input_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS input_draft (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    message TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT OR IGNORE INTO input_draft (id, message) VALUES (1, '');

  CREATE TABLE IF NOT EXISTS session_metadata (
    session_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    former_profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
    former_profile_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS crews (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'users',
    lead_profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
    lead_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS crew_members (
    crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (crew_id, profile_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_approve', 'true');
  INSERT OR IGNORE INTO settings (key, value) VALUES ('diagnostics_approvals', 'false');

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    creator_agent_id TEXT REFERENCES agents(id),
    assignee_agent_id TEXT REFERENCES agents(id),
    state TEXT NOT NULL DEFAULT 'submitted'
      CHECK (state IN ('submitted','working','input-required','completed','failed','canceled')),
    keep_alive INTEGER NOT NULL DEFAULT 1,
    message TEXT NOT NULL,
    result TEXT,
    error TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'idle'
      CHECK (state IN ('idle', 'working', 'stopped')),
    workspace_dir TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    stopped_at TEXT
  );

  CREATE TABLE IF NOT EXISTS session_task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    title TEXT,
    session_id TEXT,
    issue_number INTEGER,
    state TEXT NOT NULL DEFAULT 'cold'
      CHECK (state IN ('cold', 'dormant', 'active')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'available' CHECK (type IN ('global', 'available')),
    command TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '[]',
    env TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS message_reactions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    message_preview TEXT,
    emoji TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(session_id, message_id)
  );

  CREATE TABLE IF NOT EXISTS open_tabs (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    opened_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS profile_mcps (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    PRIMARY KEY (profile_id, mcp_server_id)
  );

  CREATE TABLE IF NOT EXISTS conversation_summaries (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    session_id TEXT,
    summary TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    message_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tool_risk_levels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mcp_name TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'none' CHECK(risk_level IN ('none', 'notify', 'approve')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(mcp_name, tool_name)
  );

  CREATE TABLE IF NOT EXISTS paired_devices (
    id TEXT PRIMARY KEY,
    device_token TEXT NOT NULL,
    device_name TEXT NOT NULL,
    public_key TEXT,
    paired_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS approval_audit_log (
    id TEXT PRIMARY KEY,
    approval_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('requested', 'approved', 'rejected', 'expired', 'device_revoked')),
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT
  );

  CREATE TABLE IF NOT EXISTS mcp_tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    agent_id TEXT,
    profile_id TEXT,
    mcp_name TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER,
    success INTEGER DEFAULT 1,
    error_code TEXT,
    input_preview TEXT,
    output_preview TEXT,
    risk_level TEXT DEFAULT 'none',
    approved_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_session ON mcp_tool_calls(session_id);
  CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_agent ON mcp_tool_calls(agent_id);
  CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_mcp_tool ON mcp_tool_calls(mcp_name, tool_name);
  CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_started ON mcp_tool_calls(started_at);
`);

// --- Workspace helpers (used by migrations below, re-exported from profiles.ts) ---

export function createProfileWorkspace(profileName: string): string {
  const slug = profileName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dir = join(WORKSPACES_DIR, slug);
  mkdirSync(dir, { recursive: true });

  const claudeMd = join(dir, 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    writeFileSync(claudeMd, `# ${profileName}

## Role

Describe what this profile does, its responsibilities, and how it should behave.

## Instructions

Add specific instructions, workflows, and reference information here.

## Other Profiles

You can discover other profiles by reading the database:
- List profiles: \`SELECT id, name, icon, workspace_dir FROM profiles\`
- Find an agent's session: \`SELECT session_id FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE a.profile_id = ?\`

The gateway API is available at http://localhost:3000/api — you can send messages
to other profiles' sessions if you need to coordinate work.
`);
  }

  return dir;
}

export function createAgentWorkspace(agentName: string, profileName: string): string {
  const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dir = join(WORKSPACES_DIR, slug);
  mkdirSync(dir, { recursive: true });

  const hqPath = process.env.HQ_PATH;
  const profileSlug = profileName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const claudeMd = join(dir, 'CLAUDE.md');

  if (!existsSync(claudeMd)) {
    let copied = false;
    if (hqPath) {
      const hqClaudeMd = join(hqPath, 'GAP', 'profiles', profileSlug, 'CLAUDE.md');
      if (existsSync(hqClaudeMd)) {
        copyFileSync(hqClaudeMd, claudeMd);
        copied = true;
      }
    }
    if (!copied) {
      writeFileSync(claudeMd, `# ${agentName}\n\nAgent of profile: ${profileName}.\n`);
    }
  }

  mkdirSync(join(dir, '.claude', 'commands'), { recursive: true });

  return dir;
}

// --- Migrations ---

try {
  db.exec(`ALTER TABLE profiles ADD COLUMN workspace_dir TEXT NOT NULL DEFAULT ''`);
} catch { /* Column already exists */ }

try {
  db.exec(`ALTER TABLE crew_members ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE`);
} catch { /* Column already exists */ }

try {
  db.exec(`ALTER TABLE crews ADD COLUMN slug TEXT`);
  const existingCrews = db.prepare('SELECT id, name FROM crews').all() as Array<{ id: string; name: string }>;
  for (const crew of existingCrews) {
    const slug = crew.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    try {
      db.prepare('UPDATE crews SET slug = ? WHERE id = ?').run(slug, crew.id);
    } catch {
      db.prepare('UPDATE crews SET slug = ? WHERE id = ?').run(`${slug}-${crew.id.substring(0, 8)}`, crew.id);
    }
  }
  logger.info({ count: existingCrews.length }, '[migration] backfilled crew slugs');
} catch { /* Column already exists */ }
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_crews_slug ON crews(slug)`);

// --- Startup integrity checks ---

const orphanedAgents = db.prepare(`
  SELECT a.id, a.name, a.profile_id FROM agents a
  WHERE a.state != 'stopped'
  AND a.id NOT IN (SELECT agent_id FROM conversations)
`).all() as Array<{ id: string; name: string; profile_id: string }>;
for (const agent of orphanedAgents) {
  logger.error({ agentId: agent.id, agentName: agent.name }, '[startup] INTEGRITY: agent has no conversation — auto-creating one');
  const convId = randomUUID();
  db.prepare(`
    INSERT INTO conversations (id, agent_id, title, state)
    VALUES (?, ?, ?, 'cold')
  `).run(convId, agent.id, agent.name);
}

try { db.exec('DROP TABLE IF EXISTS session_profiles'); } catch { /* */ }

try {
  db.prepare('SELECT message_index FROM message_reactions LIMIT 0').run();
  logger.info('[migration] recreating message_reactions with message_id instead of message_index');
  db.exec('DROP TABLE message_reactions');
  db.exec(`CREATE TABLE message_reactions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    message_preview TEXT,
    emoji TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(session_id, message_id)
  )`);
} catch { /* already migrated */ }

try {
  db.prepare('SELECT creator_profile_id FROM tasks LIMIT 0').run();
  logger.info('[migration] recreating tasks table without profile columns');
  db.exec(`
    CREATE TABLE tasks_new (
      id TEXT PRIMARY KEY,
      creator_agent_id TEXT REFERENCES agents(id),
      assignee_agent_id TEXT REFERENCES agents(id),
      state TEXT NOT NULL DEFAULT 'submitted'
        CHECK (state IN ('submitted','working','input-required','completed','failed','canceled')),
      keep_alive INTEGER NOT NULL DEFAULT 1,
      message TEXT NOT NULL,
      result TEXT,
      error TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO tasks_new (id, creator_agent_id, assignee_agent_id, state, keep_alive, message, result, error, session_id, created_at, updated_at)
      SELECT id, creator_agent_id, assignee_agent_id, state, keep_alive, message, result, error, session_id, created_at, updated_at
      FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
  `);
} catch { /* already migrated */ }

try {
  db.prepare(`INSERT INTO mcp_servers (id, name, type, command) VALUES ('__migrate_test', '__test', 'available', 'test')`).run();
  db.prepare(`DELETE FROM mcp_servers WHERE id = '__migrate_test'`).run();
} catch {
  logger.info('[migration] recreating mcp_servers with updated CHECK constraint');
  db.exec(`
    CREATE TABLE mcp_servers_new (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'available' CHECK (type IN ('global', 'available')),
      command TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      env TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO mcp_servers_new (id, name, type, command, args, env, created_at)
      SELECT id, name, CASE WHEN type = 'custom' THEN 'available' ELSE type END, command, args, env, created_at
      FROM mcp_servers;
    DROP TABLE mcp_servers;
    ALTER TABLE mcp_servers_new RENAME TO mcp_servers;
  `);
}

// Model column on profiles and conversations
try { db.exec(`ALTER TABLE profiles ADD COLUMN model TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE conversations ADD COLUMN model TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE profiles ADD COLUMN brief_mode INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE profiles ADD COLUMN confirmed_model TEXT`); } catch {}

// Migrate crews.lead_profile_id → lead_agent_id (agent model: crews have agents, not profiles)
try {
  db.exec(`ALTER TABLE crews ADD COLUMN lead_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL`);
  // Backfill: for each crew with a lead_profile_id, find the agent in that crew
  const crewsToMigrate = db.prepare(
    `SELECT id, lead_profile_id FROM crews WHERE lead_profile_id IS NOT NULL`
  ).all() as Array<{ id: string; lead_profile_id: string }>;
  for (const crew of crewsToMigrate) {
    // Find the agent for this profile — prefer one in crew_members, fall back to any active agent
    const agent = db.prepare(`
      SELECT a.id FROM agents a
      LEFT JOIN crew_members cm ON cm.agent_id = a.id AND cm.crew_id = ?
      WHERE a.profile_id = ? AND a.state != 'stopped'
      ORDER BY CASE WHEN cm.agent_id IS NOT NULL THEN 0 ELSE 1 END, a.created_at DESC
      LIMIT 1
    `).get(crew.id, crew.lead_profile_id) as { id: string } | undefined;
    if (agent) {
      db.prepare('UPDATE crews SET lead_agent_id = ? WHERE id = ?').run(agent.id, crew.id);
    }
  }
  logger.info({ count: crewsToMigrate.length }, '[migration] migrated crews.lead_profile_id → lead_agent_id');
} catch { /* Column already exists */ }

// Add blocked state + block_count to tasks (requires table recreation for CHECK constraint)
try {
  db.prepare('SELECT block_count FROM tasks LIMIT 0').run();
} catch {
  logger.info('[migration] recreating tasks table with blocked state and block_count');
  db.exec(`
    CREATE TABLE tasks_clarify (
      id TEXT PRIMARY KEY,
      creator_agent_id TEXT REFERENCES agents(id),
      assignee_agent_id TEXT REFERENCES agents(id),
      state TEXT NOT NULL DEFAULT 'submitted'
        CHECK (state IN ('submitted','working','input-required','blocked','completed','failed','canceled')),
      keep_alive INTEGER NOT NULL DEFAULT 1,
      block_count INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL,
      result TEXT,
      error TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO tasks_clarify (id, creator_agent_id, assignee_agent_id, state, keep_alive, message, result, error, session_id, created_at, updated_at)
      SELECT id, creator_agent_id, assignee_agent_id, state, keep_alive, message, result, error, session_id, created_at, updated_at
      FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_clarify RENAME TO tasks;
  `);
}

// Create task_clarifications table
db.exec(`
  CREATE TABLE IF NOT EXISTS task_clarifications (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    question TEXT NOT NULL,
    answer TEXT,
    asked_at TEXT NOT NULL,
    answered_at TEXT,
    timed_out INTEGER NOT NULL DEFAULT 0
  )
`);

// Migrate approval_audit_log CHECK constraint to include 'device_revoked'
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_audit_log_new (
      id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('requested', 'approved', 'rejected', 'expired', 'device_revoked')),
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    );
    INSERT OR IGNORE INTO approval_audit_log_new SELECT * FROM approval_audit_log;
    DROP TABLE approval_audit_log;
    ALTER TABLE approval_audit_log_new RENAME TO approval_audit_log;
  `);
} catch { /* table may not exist yet or migration already applied */ }

// Add proxied flag to mcp_servers — when true, agents connect via gateway proxy
try { db.exec(`ALTER TABLE mcp_servers ADD COLUMN proxied INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`UPDATE mcp_servers SET proxied = 1 WHERE name = 'calendar'`); } catch {}

try {
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_weekly_reports (
    id TEXT PRIMARY KEY,
    week_start TEXT UNIQUE,
    week_end TEXT NOT NULL,
    total_calls INTEGER NOT NULL DEFAULT 0,
    total_errors INTEGER NOT NULL DEFAULT 0,
    error_rate_pct REAL NOT NULL DEFAULT 0,
    avg_duration_ms REAL,
    top_tools TEXT NOT NULL DEFAULT '[]',
    error_tools TEXT NOT NULL DEFAULT '[]',
    latency_regressions TEXT NOT NULL DEFAULT '[]',
    new_tools TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
} catch {}

// --- HQ seeding ---

const HQ_PATH = process.env.HQ_PATH;
if (HQ_PATH) {
  const mcpsJsonPath = join(HQ_PATH, 'GAP', 'mcps.json');
  if (existsSync(mcpsJsonPath)) {
    try {
      const mcpsData = JSON.parse(readFileSync(mcpsJsonPath, 'utf-8'));
      const mcps = mcpsData.mcps || [];
      const upsertMcp = db.prepare(`
        INSERT INTO mcp_servers (id, name, type, command, args, env)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          type = excluded.type,
          command = excluded.command,
          args = excluded.args,
          env = excluded.env
      `);
      for (const mcp of mcps) {
        const id = `hq-${mcp.name}`;
        upsertMcp.run(id, mcp.name, mcp.type, mcp.command, JSON.stringify(mcp.args || []), JSON.stringify(mcp.env || {}));
      }
      logger.info({ count: mcps.length, path: mcpsJsonPath }, '[startup] seeded MCPs from HQ');
    } catch (err) {
      logger.error({ error: String(err), path: mcpsJsonPath }, '[startup] failed to read HQ mcps.json');
    }
  }

  const profilesDir = join(HQ_PATH, 'GAP', 'profiles');
  if (existsSync(profilesDir)) {
    const slugToProfile = new Map<string, string>();
    const allProfiles = db.prepare('SELECT id, name FROM profiles').all() as Array<{ id: string; name: string }>;
    for (const p of allProfiles) {
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      slugToProfile.set(slug, p.id);
    }

    for (const dirName of readdirSync(profilesDir)) {
      const configPath = join(profilesDir, dirName, 'config.json');
      if (!existsSync(configPath)) continue;
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        const profileId = slugToProfile.get(dirName);
        if (!profileId) continue;

        const mcpNames: string[] = config.mcps || [];
        db.prepare('DELETE FROM profile_mcps WHERE profile_id = ?').run(profileId);
        const assign = db.prepare(`
          INSERT OR IGNORE INTO profile_mcps (profile_id, mcp_server_id)
          SELECT ?, id FROM mcp_servers WHERE name = ?
        `);
        for (const mcpName of mcpNames) {
          assign.run(profileId, mcpName);
        }
        if (mcpNames.length > 0) {
          logger.info({ profile: dirName, mcps: mcpNames }, '[startup] synced profile MCPs from HQ');
        }

        if (config.systemPrompt) {
          throw new Error(`config.json uses "systemPrompt" — use "system_prompt" (snake_case) instead`);
        }
        if (typeof config.system_prompt === 'string') {
          db.prepare('UPDATE profiles SET system_prompt = ? WHERE id = ?').run(config.system_prompt, profileId);
          logger.info({ profile: dirName }, '[startup] synced system prompt from HQ');
        }

        // Seed model from config.json — only if DB model is null (idempotent)
        if (typeof config.model === 'string') {
          const profile = db.prepare('SELECT model FROM profiles WHERE id = ?').get(profileId) as { model: string | null } | undefined;
          if (profile && profile.model === null) {
            db.prepare('UPDATE profiles SET model = ? WHERE id = ?').run(config.model, profileId);
            logger.info({ profile: dirName, model: config.model }, '[startup] seeded model from HQ config');
          }
        }
      } catch { /* Invalid config.json */ }
    }
  }

  // Seed platform default model for any remaining profiles with null model
  const platformJsonPath = join(HQ_PATH, 'GAP', 'platform.json');
  let platformDefault = 'opus';
  if (existsSync(platformJsonPath)) {
    try {
      const platformData = JSON.parse(readFileSync(platformJsonPath, 'utf-8'));
      if (typeof platformData.defaultModel === 'string') platformDefault = platformData.defaultModel;
    } catch { /* use fallback */ }
  }
  const nullModelProfiles = db.prepare('SELECT id, name FROM profiles WHERE model IS NULL').all() as Array<{ id: string; name: string }>;
  if (nullModelProfiles.length > 0) {
    const stmt = db.prepare('UPDATE profiles SET model = ? WHERE id = ?');
    for (const p of nullModelProfiles) {
      stmt.run(platformDefault, p.id);
    }
    logger.info({ count: nullModelProfiles.length, model: platformDefault }, '[startup] seeded platform default model for profiles with null model');
  }
} else {
  logger.info('[startup] HQ_PATH not set — skipping MCP sync from HQ repo');
}

// Backfill workspaces
const profilesWithoutWorkspace = db.prepare(
  `SELECT id, name FROM profiles WHERE workspace_dir = ''`
).all() as Array<{ id: string; name: string }>;
for (const p of profilesWithoutWorkspace) {
  const dir = createProfileWorkspace(p.name);
  db.prepare('UPDATE profiles SET workspace_dir = ? WHERE id = ?').run(dir, p.id);
}

// Auto-migrate profiles → agents + conversations
const profilesWithoutAgent = db.prepare(`
  SELECT p.id, p.name FROM profiles p
  WHERE p.id NOT IN (SELECT profile_id FROM agents WHERE state != 'stopped')
`).all() as Array<{ id: string; name: string }>;

for (const p of profilesWithoutAgent) {
  const agentId = randomUUID();
  const workspaceDir = createAgentWorkspace(p.name, p.name);

  db.prepare(`
    INSERT INTO agents (id, profile_id, name, state, workspace_dir)
    VALUES (?, ?, ?, 'idle', ?)
  `).run(agentId, p.id, p.name, workspaceDir);

  const convId = randomUUID();
  db.prepare(`
    INSERT INTO conversations (id, agent_id, title, state)
    VALUES (?, ?, ?, 'cold')
  `).run(convId, agentId, p.name);

  logger.info({ profileId: p.id, agentId, name: p.name }, '[migration] created agent from profile');
}

export default db;
