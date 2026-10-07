/**
 * HQ Sync — watches workspace CLAUDE.md files and syncs changes back to HQ repo.
 *
 * Only active when HQ_PATH env var is set.
 * Debounces rapid edits (5 seconds) and auto-commits + pushes to HQ.
 */

import { watch, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { logger } from './logger.js';

const DEBOUNCE_MS = 5_000;
const pendingTimers = new Map<string, NodeJS.Timeout>();

function gitCommitAndPush(hqPath: string, filePath: string, slug: string): void {
  try {
    execSync(`git add "${filePath}"`, { cwd: hqPath, stdio: 'pipe' });

    // Check if there are staged changes
    const status = execSync('git diff --cached --name-only', { cwd: hqPath, encoding: 'utf-8' }).trim();
    if (!status) {
      logger.info({ slug }, '[hq-sync] no changes to commit');
      return;
    }

    execSync(`git commit -m "sync(profiles): update ${slug}/CLAUDE.md from workspace"`, { cwd: hqPath, stdio: 'pipe' });
    execSync('git push', { cwd: hqPath, stdio: 'pipe', timeout: 30_000 });
    logger.info({ slug }, '[hq-sync] committed and pushed CLAUDE.md to HQ');
  } catch (err) {
    logger.error({ error: String(err), slug }, '[hq-sync] git commit/push failed');
  }
}

function syncToHQ(hqPath: string, workspaceClaudeMd: string, slug: string): void {
  const hqProfileDir = join(hqPath, 'GAP', 'profiles', slug);
  const hqClaudeMd = join(hqProfileDir, 'CLAUDE.md');

  try {
    // Create HQ profile directory if it doesn't exist
    if (!existsSync(hqProfileDir)) {
      mkdirSync(hqProfileDir, { recursive: true });
      logger.info({ slug }, '[hq-sync] created new HQ profile directory');
    }

    // Strip crew layers before syncing — they're appended at spawn time
    // and should not be persisted in HQ
    let content = readFileSync(workspaceClaudeMd, 'utf-8');
    const startMarker = '<!-- crew-layers:start -->';
    const endMarker = '<!-- crew-layers:end -->';
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.indexOf(endMarker);
    if (startIdx !== -1 && endIdx !== -1) {
      content = content.substring(0, startIdx).trimEnd() + content.substring(endIdx + endMarker.length);
      content = content.trimEnd() + '\n';
    }
    writeFileSync(hqClaudeMd, content);
    logger.info({ slug }, '[hq-sync] synced CLAUDE.md to HQ (crew layers stripped)');

    gitCommitAndPush(hqPath, `GAP/profiles/${slug}/CLAUDE.md`, slug);
  } catch (err) {
    logger.error({ error: String(err), slug }, '[hq-sync] sync to HQ failed');
  }
}

function watchClaudeMd(hqPath: string, workspaceDir: string, slug: string): void {
  const claudeMdPath = join(workspaceDir, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) return;

  try {
    watch(claudeMdPath, (eventType) => {
      if (eventType !== 'change') return;

      // Debounce: clear existing timer, set new one
      const existing = pendingTimers.get(slug);
      if (existing) clearTimeout(existing);

      pendingTimers.set(slug, setTimeout(() => {
        pendingTimers.delete(slug);
        if (existsSync(claudeMdPath)) {
          syncToHQ(hqPath, claudeMdPath, slug);
        }
      }, DEBOUNCE_MS));
    });

    logger.info({ slug, path: claudeMdPath }, '[hq-sync] watching CLAUDE.md');
  } catch (err) {
    logger.warn({ error: String(err), slug }, '[hq-sync] failed to watch CLAUDE.md');
  }
}

export function startHQSync(): void {
  const hqPath = process.env.HQ_PATH;
  if (!hqPath) {
    logger.info('[hq-sync] HQ_PATH not set — skipping workspace → HQ sync');
    return;
  }

  if (!existsSync(join(hqPath, 'GAP', 'profiles'))) {
    logger.warn({ hqPath }, '[hq-sync] HQ profiles directory not found');
    return;
  }

  // Find all workspace directories
  const workspacesDir = join(homedir(), '.gellyfish', 'workspaces');

  if (!existsSync(workspacesDir)) {
    logger.warn({ workspacesDir }, '[hq-sync] workspaces directory not found');
    return;
  }

  let watchCount = 0;
  for (const entry of readdirSync(workspacesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const workspaceDir = join(workspacesDir, slug);
    watchClaudeMd(hqPath, workspaceDir, slug);
    watchCount++;
  }

  logger.info({ watchCount }, '[hq-sync] started watching workspace CLAUDE.md files');
}
