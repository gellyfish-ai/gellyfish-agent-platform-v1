/**
 * Session file helpers — centralized path resolution and text extraction.
 *
 * Used by session-send.ts (summary generation) and routes/sessions.ts (history/timeline).
 * Single source of truth for finding .jsonl files on disk.
 */

import { existsSync, unlinkSync, rmSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import db from './db/index.js';

// Convert cwd to Claude's project path format
function cwdToProjectPath(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/** Get the sessions directory for a given working directory */
export function getSessionsDirForCwd(cwd: string): string {
  const projectsBase = join(homedir(), '.claude', 'projects');
  return join(projectsBase, cwdToProjectPath(cwd));
}

/** Gateway sessions dir (non-profile sessions) */
export function getGatewaySessionsDir(): string {
  return getSessionsDirForCwd(process.cwd());
}

/** Get the sessions dir for a specific agent */
export function getAgentSessionsDir(agentId: string): string | null {
  const agent = db.prepare('SELECT workspace_dir FROM agents WHERE id = ?')
    .get(agentId) as { workspace_dir: string } | undefined;
  if (!agent?.workspace_dir) return null;
  return getSessionsDirForCwd(agent.workspace_dir);
}

/**
 * Find the .jsonl file for a session.
 *
 * Resolution order:
 * 1. Agent workspace via conversation → agent → agent.workspace_dir
 * 2. Scan all agent workspaces
 * 3. Gateway sessions dir (fallback)
 *
 * Returns the path (may not exist for case 3 fallback).
 */
/** Check for both .jsonl file and directory-format session in a directory */
export function findSessionInDir(dir: string, sessionId: string): string | null {
  const jsonlPath = join(dir, `${sessionId}.jsonl`);
  if (existsSync(jsonlPath)) return jsonlPath;
  const dirPath = join(dir, sessionId);
  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) return dirPath;
  return null;
}

export function getSessionFilePath(sessionId: string, _profileIdHint?: string): string {
  // Check agent workspace via conversation → agent
  const convAgent = db.prepare(`
    SELECT a.id as agent_id, a.workspace_dir FROM conversations c
    JOIN agents a ON a.id = c.agent_id
    WHERE c.session_id = ?
  `).get(sessionId) as { agent_id: string; workspace_dir: string } | undefined;

  if (convAgent?.workspace_dir) {
    const dir = getSessionsDirForCwd(convAgent.workspace_dir);
    const found = findSessionInDir(dir, sessionId);
    if (found) return found;
  }

  // Scan all agent workspaces
  const agents = db.prepare("SELECT id, workspace_dir FROM agents WHERE workspace_dir != ''")
    .all() as Array<{ id: string; workspace_dir: string }>;
  for (const a of agents) {
    const dir = getSessionsDirForCwd(a.workspace_dir);
    const found = findSessionInDir(dir, sessionId);
    if (found) return found;
  }

  // Default: gateway sessions dir (may not exist — fallback for new sessions)
  return join(getGatewaySessionsDir(), `${sessionId}.jsonl`);
}

/** Extract text from Claude message content (string or content block array) */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b.type === 'text')
      .map((b: Record<string, unknown>) => b.text as string)
      .join('\n');
  }
  return '';
}

/** List all .jsonl session files for a conversation's agent workspace */
export function listSessionFiles(conversationId: string): Array<{ sessionId: string; size: number; modifiedAt: string; path: string }> {
  // Look up agent workspace through conversation → agent
  const conv = db.prepare(`
    SELECT a.workspace_dir FROM conversations c
    JOIN agents a ON a.id = c.agent_id
    WHERE c.id = ?
  `).get(conversationId) as { workspace_dir: string } | undefined;

  if (!conv?.workspace_dir) return [];

  const dir = getSessionsDirForCwd(conv.workspace_dir);
  if (!dir || !existsSync(dir)) return [];

  const files: Array<{ sessionId: string; size: number; modifiedAt: string; path: string }> = [];
  const seenIds = new Set<string>();
  const entries = readdirSync(dir).sort((a, b) => {
    const aJsonl = a.endsWith('.jsonl') ? 0 : 1;
    const bJsonl = b.endsWith('.jsonl') ? 0 : 1;
    return aJsonl - bJsonl || a.localeCompare(b);
  });
  for (const entry of entries) {
    let sessionId: string;
    const filePath = join(dir, entry);
    if (entry.endsWith('.jsonl')) {
      sessionId = entry.replace('.jsonl', '');
    } else {
      // Check for directory-format session (directory named by UUID)
      try {
        if (!statSync(filePath).isDirectory()) continue;
      } catch { continue; }
      sessionId = entry;
    }
    if (seenIds.has(sessionId)) continue;
    seenIds.add(sessionId);
    try {
      const stat = statSync(filePath);
      files.push({ sessionId, size: stat.size, modifiedAt: stat.mtime.toISOString(), path: filePath });
    } catch { /* skip */ }
  }

  // Sort by modified date, newest first
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return files;
}

/** Delete a session's file or directory from disk */
export function deleteSessionFile(sessionId: string, profileId?: string): boolean {
  const filePath = getSessionFilePath(sessionId, profileId);
  if (!existsSync(filePath)) return false;
  if (statSync(filePath).isDirectory()) {
    rmSync(filePath, { recursive: true });
  } else {
    unlinkSync(filePath);
  }
  return true;
}
