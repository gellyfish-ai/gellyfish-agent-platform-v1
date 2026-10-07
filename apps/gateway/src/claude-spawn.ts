/**
 * Claude CLI helpers — arg building, profile lookups, system prompts.
 *
 * Process spawning is handled by the Process Manager (process-manager.ts).
 * This module builds the args and resolves paths that the PM needs.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, symlinkSync, lstatSync, copyFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import db, { Profile, getProfileMcpConfig, getProfileCrewContext } from './db/index.js';
import { logger } from './logger.js';
import { renderPrompt } from './config.js';
import { getSessionFilePath } from './session-file.js';
import { DEFAULT_MODEL } from './models.js';
import { resolveEnvKeychainRefs, isKeychainRef } from './mcp/keychain.js';

// --- Session missing error ---

export class SessionMissingError extends Error {
  sessionId: string;
  conversationId?: string;
  agentName?: string;

  constructor(sessionId: string, conversationId?: string, agentName?: string) {
    super(`Session .jsonl not found on disk: ${sessionId}`);
    this.name = 'SessionMissingError';
    this.sessionId = sessionId;
    this.conversationId = conversationId;
    this.agentName = agentName;
  }
}

// --- Resolve paths once at startup ---

export const CLAUDE_PATH = (() => {
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch {
    return 'claude';
  }
})();

export const REPO_ROOT = (() => {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return join(process.cwd(), '..', '..');
  }
})();

// --- Profile / session lookups ---

/** Look up a profile by ID */
export function lookupProfile(profileId: string): Profile | undefined {
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as Profile | undefined;
}

/** Look up a profile from a session ID via conversation → agent → profile */
export function lookupProfileBySession(sessionId: string): Profile | undefined {
  return db.prepare(`
    SELECT p.* FROM profiles p
    JOIN agents a ON a.profile_id = p.id
    JOIN conversations c ON c.agent_id = a.id
    WHERE c.session_id = ?
  `).get(sessionId) as Profile | undefined;
}

/** Resolve the working directory for a Claude process.
 *  Always uses the agent workspace. Profile workspace is the template, not the cwd. */
export function resolveWorkingDir(agent?: { workspace_dir?: string } | null): string {
  if (agent?.workspace_dir && existsSync(agent.workspace_dir)) {
    return agent.workspace_dir;
  }
  logger.warn({ agentWorkspace: agent?.workspace_dir }, '[spawn] no agent workspace — falling back to gateway cwd');
  return process.cwd();
}

// --- System prompt assembly ---

function formatMemberRef(m: { profile_id: string; profile_name: string; icon: string; agent_id: string | null; agent_name: string | null; workspace_dir: string | null; session_id: string | null }): string {
  let line = `${m.icon} ${m.profile_name}`;
  if (m.workspace_dir) line += ` — workspace: ${m.workspace_dir}`;
  if (m.session_id) line += `, session: ${m.session_id}`;
  else line += ` (no active session)`;
  return line;
}

/** Build the full system prompt for a profile (workspace, user prompt, crew context) */
export function buildSystemPrompt(profile: Profile, agentId?: string | null): string | null {
  const parts: string[] = [];

  if (profile.workspace_dir && existsSync(profile.workspace_dir)) {
    parts.push(
      `Your workspace is at ${profile.workspace_dir}. ` +
      `Read the CLAUDE.md file there for your role, instructions, and reference data. ` +
      `You can create and manage files in your workspace as needed.`
    );
  }

  if (profile.system_prompt) {
    parts.push(profile.system_prompt);
  }

  // Base profile context — how to communicate with other profiles
  const basePrompt = renderPrompt('base-profile', {});
  if (basePrompt) parts.push(basePrompt);

  // Crew context
  const crewCtx = getProfileCrewContext(profile.id);

  for (const crew of crewCtx.leading) {
    const membersList = crew.members
      .map(m => `- ${formatMemberRef(m)}`)
      .join('\n');
    const rendered = renderPrompt('crew-lead', {
      crew_name: crew.crew_name,
      members_list: membersList || '(no members yet)',
    });
    if (rendered) parts.push(rendered);
  }

  for (const crew of crewCtx.memberOf) {
    const leadInfo = crew.lead ? formatMemberRef(crew.lead) : '';
    const otherMembersList = crew.other_members
      .map(m => `- ${formatMemberRef(m)}`)
      .join('\n');
    const rendered = renderPrompt('crew-member', {
      crew_name: crew.crew_name,
      lead_info: leadInfo,
      other_members: otherMembersList,
    });
    if (rendered) parts.push(rendered);
  }

  // Per-profile system prompt from HQ
  const hqPath = process.env.HQ_PATH;
  if (hqPath && profile.name) {
    const profileSlug = slugify(profile.name);
    const hqPromptPath = join(hqPath, 'GAP', 'profiles', profileSlug, 'system-prompt.md');
    if (existsSync(hqPromptPath)) {
      try {
        const hqPrompt = readFileSync(hqPromptPath, 'utf-8').trim();
        if (hqPrompt) parts.push(hqPrompt);
      } catch (err) {
        logger.warn({ error: String(err), profile: profile.name }, '[spawn] failed to read HQ system-prompt.md');
      }
    }

    // Crew system prompt layers
    const globalCrewPrompt = readHqFile(join(hqPath, 'GAP', 'crews', 'system-prompt.md'));
    if (globalCrewPrompt) parts.push(globalCrewPrompt);

    const crewSlugs = getAgentCrewSlugs(agentId, profile.id);
    for (const crewSlug of crewSlugs) {
      const crewPrompt = readHqFile(join(hqPath, 'GAP', 'crews', crewSlug, 'system-prompt.md'));
      if (crewPrompt) parts.push(crewPrompt);

      const crewProfilePrompt = readHqFile(join(hqPath, 'GAP', 'crews', crewSlug, 'profiles', profileSlug, 'system-prompt.md'));
      if (crewProfilePrompt) parts.push(crewProfilePrompt);
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

// --- MCP config ---

/** Get crew slugs for an agent */
function getAgentCrewSlugs(agentId: string | null | undefined, profileId: string): string[] {
  if (agentId) {
    const rows = db.prepare(`
      SELECT DISTINCT c.slug FROM crews c
      JOIN crew_members cm ON cm.crew_id = c.id
      WHERE c.slug IS NOT NULL AND cm.agent_id = ?
      ORDER BY c.name
    `).all(agentId) as Array<{ slug: string }>;
    return rows.map(r => r.slug);
  }
  // Fallback for spawns without agent context (e.g. ad-hoc sessions)
  const rows = db.prepare(`
    SELECT DISTINCT c.slug FROM crews c
    JOIN crew_members cm ON cm.crew_id = c.id
    WHERE c.slug IS NOT NULL AND cm.profile_id = ?
    ORDER BY c.name
  `).all(profileId) as Array<{ slug: string }>;
  return rows.map(r => r.slug);
}

/** Read an optional HQ file, return content or empty string */
function readHqFile(path: string): string {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return '';
  }
}

/** Sync CLAUDE.md from HQ to workspace at spawn time */
function syncClaudeMdFromHQ(profile?: Profile | null, agentId?: string | null): void {
  const hqPath = process.env.HQ_PATH;
  if (!hqPath || !profile?.name || !profile.workspace_dir) return;

  const profileSlug = slugify(profile.name);
  const hqClaudeMd = join(hqPath, 'GAP', 'profiles', profileSlug, 'CLAUDE.md');
  const workspaceClaudeMd = join(profile.workspace_dir, 'CLAUDE.md');

  if (existsSync(hqClaudeMd)) {
    try {
      copyFileSync(hqClaudeMd, workspaceClaudeMd);
      logger.info({ profile: profile.name, slug: profileSlug }, '[spawn] synced CLAUDE.md from HQ to workspace');
    } catch (err) {
      logger.warn({ error: String(err), profile: profile.name }, '[spawn] failed to sync CLAUDE.md from HQ');
    }
  }

  // Append crew layers to CLAUDE.md
  appendCrewClaudeMd(profile, workspaceClaudeMd, agentId);
}

const CREW_LAYERS_START = '<!-- crew-layers:start -->';
const CREW_LAYERS_END = '<!-- crew-layers:end -->';

/** Write crew-specific CLAUDE.md layers from HQ, replacing any previous crew section */
function appendCrewClaudeMd(profile: Profile, workspaceClaudeMd: string, agentId?: string | null): void {
  const hqPath = process.env.HQ_PATH;
  if (!hqPath) return;

  const profileSlug = slugify(profile.name);
  const crewSlugs = getAgentCrewSlugs(agentId, profile.id);
  const layers: string[] = [];

  // Global crew layer
  const globalLayer = readHqFile(join(hqPath, 'GAP', 'crews', 'claude-md.md'));
  if (globalLayer) layers.push(globalLayer);

  // Per-crew layers
  for (const crewSlug of crewSlugs) {
    const crewLayer = readHqFile(join(hqPath, 'GAP', 'crews', crewSlug, 'claude-md.md'));
    if (crewLayer) layers.push(crewLayer);

    const crewProfileLayer = readHqFile(join(hqPath, 'GAP', 'crews', crewSlug, 'profiles', profileSlug, 'claude-md.md'));
    if (crewProfileLayer) layers.push(crewProfileLayer);
  }

  if (layers.length === 0) return;

  const crewBlock = `${CREW_LAYERS_START}\n${layers.join('\n\n')}\n${CREW_LAYERS_END}`;

  try {
    const existing = existsSync(workspaceClaudeMd) ? readFileSync(workspaceClaudeMd, 'utf-8') : '';
    const startIdx = existing.indexOf(CREW_LAYERS_START);
    const endIdx = existing.indexOf(CREW_LAYERS_END);

    let updated: string;
    if (startIdx !== -1 && endIdx !== -1) {
      // Replace existing crew section
      updated = existing.substring(0, startIdx) + crewBlock + existing.substring(endIdx + CREW_LAYERS_END.length);
    } else {
      // First time — append
      updated = existing + '\n\n' + crewBlock;
    }
    writeFileSync(workspaceClaudeMd, updated);
    logger.info({ profile: profile.name, layerCount: layers.length }, '[spawn] wrote crew CLAUDE.md layers');
  } catch (err) {
    logger.warn({ error: String(err), profile: profile.name }, '[spawn] failed to write crew CLAUDE.md layers');
  }
}

/** Write merged .mcp.json (global + per-profile MCPs) to workspace */
export function addMcpConfig(args: string[], profile?: Profile | null): void {
  if (profile) {
    // getProfileMcpConfig already merges global MCPs + per-profile MCPs
    const mcpConfig = getProfileMcpConfig(profile.id) as {
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
    };

    // Resolve keychain:service/account references in env values
    for (const [name, server] of Object.entries(mcpConfig.mcpServers)) {
      if (server.env) {
        const hasKeychainRefs = Object.values(server.env).some(isKeychainRef);
        if (hasKeychainRefs) {
          try {
            server.env = resolveEnvKeychainRefs(server.env);
          } catch (err) {
            logger.error({ mcpName: name, error: String(err) }, '[mcp] keychain resolution failed — MCP may not authenticate');
          }
        }
      }
    }

    if (profile.workspace_dir) {
      const configPath = join(profile.workspace_dir, '.mcp.json');
      writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
      // --strict-mcp-config prevents Claude CLI from discovering repo-level .mcp.json
      // via directory walking — agents only see MCPs explicitly assigned to their profile
      args.push('--strict-mcp-config', '--mcp-config', configPath);
    }
  }
  // No profile = no MCPs (global MCPs require a profile to resolve)
}

// --- Sessions symlink ---

/** Create a sessions symlink in the agent workspace pointing to Claude's project sessions dir */
function linkSessionsDir(profile?: Profile | null): void {
  if (!profile?.workspace_dir) return;
  const workspaceDir = profile.workspace_dir;
  const projectPath = workspaceDir.replace(/[/.]/g, '-');
  const sessionDir = join(homedir(), '.claude', 'projects', projectPath);
  const sessionsLink = join(workspaceDir, 'sessions');

  try {
    const stat = lstatSync(sessionsLink);
    if (stat.isSymbolicLink()) {
      unlinkSync(sessionsLink);
      symlinkSync(sessionDir, sessionsLink);
    }
  } catch {
    try { symlinkSync(sessionDir, sessionsLink); } catch { /* session dir may not exist yet */ }
  }
}

// --- Skills sync from HQ ---

const SKILLS_DIR = join(REPO_ROOT, 'config', 'skills');

/** Sync skills from HQ repo to local config/skills/ at startup */
export function syncSkillsFromHQ(): void {
  const hqPath = process.env.HQ_PATH;
  if (!hqPath) return;

  const hqSkillsDir = join(hqPath, 'GAP', 'skills');
  if (!existsSync(hqSkillsDir)) {
    logger.info('[skills-sync] no HQ skills directory found — skipping');
    return;
  }

  mkdirSync(SKILLS_DIR, { recursive: true });
  let count = 0;

  // Recursively copy all skill files from HQ to local
  function syncDir(src: string, dest: string) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        syncDir(srcPath, destPath);
      } else if (entry.name.endsWith('.md')) {
        copyFileSync(srcPath, destPath);
        count++;
      }
    }
  }

  syncDir(hqSkillsDir, SKILLS_DIR);

  // Also sync per-profile skills from GAP/profiles/<slug>/skills/
  const hqProfilesDir = join(hqPath, 'GAP', 'profiles');
  if (existsSync(hqProfilesDir)) {
    for (const entry of readdirSync(hqProfilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const profileSkillsDir = join(hqProfilesDir, entry.name, 'skills');
      if (existsSync(profileSkillsDir)) {
        syncDir(profileSkillsDir, join(SKILLS_DIR, 'profiles', entry.name));
      }
    }
  }

  logger.info({ count, from: hqSkillsDir, to: SKILLS_DIR }, '[skills-sync] synced skills from HQ');
}

// --- Skills distribution ---

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Symlink skill files into a profile's workspace .claude/commands/ directory */
export function addSkills(profile?: Profile | null, agentId?: string | null): void {
  if (!profile?.workspace_dir) return;

  const targetDir = join(profile.workspace_dir, '.claude', 'commands');
  mkdirSync(targetDir, { recursive: true });

  const linked: string[] = [];

  // 1. Global skills — available to all agents
  const globalDir = join(SKILLS_DIR, 'global');
  if (existsSync(globalDir)) {
    for (const file of readdirSync(globalDir).filter(f => f.endsWith('.md'))) {
      symlinkSkill(join(globalDir, file), join(targetDir, file), linked);
    }
  }

  // 2. Crew skills — look up which crews this agent belongs to
  const crewQuery = agentId
    ? db.prepare(`SELECT c.name FROM crew_members cm JOIN crews c ON c.id = cm.crew_id WHERE cm.agent_id = ?`).all(agentId)
    : db.prepare(`SELECT c.name FROM crew_members cm JOIN crews c ON c.id = cm.crew_id WHERE cm.profile_id = ?`).all(profile.id);
  const crews = crewQuery as Array<{ name: string }>;

  for (const crew of crews) {
    const crewDir = join(SKILLS_DIR, 'crews', slugify(crew.name));
    if (!existsSync(crewDir)) continue;
    for (const file of readdirSync(crewDir).filter(f => f.endsWith('.md'))) {
      symlinkSkill(join(crewDir, file), join(targetDir, file), linked);
    }
  }

  // 3. Profile skills — most specific, from HQ profile template
  const profileSlug = slugify(profile.name);
  const profileDir = join(SKILLS_DIR, 'profiles', profileSlug);
  if (existsSync(profileDir)) {
    for (const file of readdirSync(profileDir).filter(f => f.endsWith('.md'))) {
      symlinkSkill(join(profileDir, file), join(targetDir, file), linked);
    }
  }

  if (linked.length > 0) {
    logger.info({ profileName: profile.name, skills: linked }, '[spawn] distributed skills');
  }
}

function symlinkSkill(source: string, target: string, linked: string[]): void {
  // Don't overwrite existing files (agent workspace skills take precedence)
  if (existsSync(target)) {
    try {
      const stat = lstatSync(target);
      // If it's already a symlink pointing to the same source, skip silently
      if (stat.isSymbolicLink()) return;
      // If it's a real file, the agent has a custom version — don't overwrite
      return;
    } catch { return; }
  }
  try {
    symlinkSync(source, target);
    linked.push(target.split('/').pop() || '');
  } catch (err) {
    logger.warn({ source, target, error: String(err) }, '[spawn] failed to symlink skill');
  }
}

// --- Session file validation ---

/** Check if a Claude CLI session .jsonl file exists on disk */
function checkSessionFileExists(sessionId: string): boolean {
  const filePath = getSessionFilePath(sessionId);
  return existsSync(filePath);
}

// --- Tool permissions ---

const DEFAULT_ALLOWED_TOOLS = 'Read,Grep,Glob,Bash,Write,Edit,Agent,TodoWrite,WebSearch,WebFetch';
const DEFAULT_DISALLOWED_TOOLS = 'Read(.env),Read(*/.env),Read(**/.env)';

interface ProfilePermissions {
  allowedTools: string;
  disallowedTools: string;
}

/** Read per-profile tool permissions from HQ config.json, falling back to defaults */
export function getProfilePermissions(profile?: Profile | null): ProfilePermissions {
  const defaults: ProfilePermissions = {
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    disallowedTools: DEFAULT_DISALLOWED_TOOLS,
  };

  const hqPath = process.env.HQ_PATH;
  if (!hqPath || !profile?.name) return defaults;

  const profileSlug = slugify(profile.name);
  const configPath = join(hqPath, 'GAP', 'profiles', profileSlug, 'config.json');
  if (!existsSync(configPath)) return defaults;

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));

    return {
      allowedTools: Array.isArray(config.allowedTools)
        ? config.allowedTools.join(',')
        : (typeof config.allowedTools === 'string' ? config.allowedTools : defaults.allowedTools),
      disallowedTools: Array.isArray(config.disallowedTools)
        ? config.disallowedTools.join(',')
        : (typeof config.disallowedTools === 'string' ? config.disallowedTools : defaults.disallowedTools),
    };
  } catch (err) {
    logger.warn({ error: String(err), profile: profile.name }, '[spawn] failed to read permissions from HQ config.json');
    return defaults;
  }
}

// --- Profile hooks ---

/** Apply per-profile hooks from HQ config.json to the agent's settings.local.json */
function applyProfileHooks(profile?: Profile | null): void {
  if (!profile?.workspace_dir || !profile.name) return;

  const hqPath = process.env.HQ_PATH;
  if (!hqPath) return;

  const configPath = join(hqPath, 'GAP', 'profiles', slugify(profile.name), 'config.json');
  if (!existsSync(configPath)) return;

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!config.hooks || typeof config.hooks !== 'object') return;

    const claudeDir = join(profile.workspace_dir, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const settingsPath = join(claudeDir, 'settings.local.json');
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch { /* corrupted — overwrite */ }
    }

    settings.hooks = config.hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    logger.info({ profile: profile.name, hooks: Object.keys(config.hooks) }, '[spawn] applied profile hooks');
  } catch (err) {
    logger.warn({ error: String(err), profile: profile.name }, '[spawn] failed to apply profile hooks');
  }
}

// --- Spawn helpers ---

export interface SpawnOptions {
  profile?: Profile | null;
  agentId?: string | null;
  sessionId?: string;
  skipMcp?: boolean;
  model?: string | null;
}

/** Build Claude CLI args for an interactive session */
export function buildClaudeArgs(options: SpawnOptions): string[] {
  const permissions = getProfilePermissions(options.profile);

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', 'default',
    '--allowedTools', permissions.allowedTools,
    '--disallowedTools', permissions.disallowedTools,
    '--include-partial-messages',
  ];

  // Always pass --model explicitly — boot seeding ensures no null models in DB
  args.push('--model', options.model || DEFAULT_MODEL);

  if (options.profile?.brief_mode) {
    args.push('--brief');
  }

  logger.info({ profileName: options.profile?.name, sessionId: options.sessionId, model: options.model }, '[spawn] building Claude args');

  syncClaudeMdFromHQ(options.profile, options.agentId);
  if (!options.skipMcp) {
    addMcpConfig(args, options.profile);
  }
  addSkills(options.profile, options.agentId);
  linkSessionsDir(options.profile);
  applyProfileHooks(options.profile);

  if (options.profile) {
    const systemPrompt = buildSystemPrompt(options.profile, options.agentId);
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  }

  if (options.sessionId) {
    // Verify session file exists on disk before passing --resume
    const sessionExists = checkSessionFileExists(options.sessionId);
    if (sessionExists) {
      args.push('--resume', options.sessionId);
    } else {
      // Graceful recovery: clear stale session_id from DB and start fresh
      const conv = db.prepare('SELECT id FROM conversations WHERE session_id = ?').get(options.sessionId) as { id: string } | undefined;
      logger.warn(
        { sessionId: options.sessionId, conversationId: conv?.id, profileName: options.profile?.name },
        '[spawn] session .jsonl not found — clearing stale reference and starting fresh'
      );
      if (conv) {
        db.prepare("UPDATE conversations SET session_id = NULL, state = 'cold', updated_at = datetime('now') WHERE id = ?").run(conv.id);
      }
      // Proceed without --resume — a new session will be created
    }
  }

  return args;
}

// Note: spawnClaudeProcess was removed — the Process Manager (process-manager.ts)
// now handles all process spawning. Use pmClient.spawn() instead.
