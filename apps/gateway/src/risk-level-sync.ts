/**
 * Sync tool risk levels from HQ mcps.json on gateway boot.
 *
 * Reads optional `toolRiskLevels` from each MCP entry and upserts
 * into the tool_risk_levels DB table.
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { setRiskLevel, type RiskLevel } from './db/risk-levels.js';
import { logger } from './logger.js';

const VALID_LEVELS: Set<string> = new Set(['none', 'notify', 'approve']);

const DEFAULT_MCPS_PATH = join(process.env.HQ_PATH || join(homedir(), 'Workspace', 'gellyfish-hq'), 'GAP', 'mcps.json');

interface McpEntry {
  name: string;
  toolRiskLevels?: Record<string, string>;
}

export function syncRiskLevelsFromHQ(mcpsJsonPath?: string): void {
  const path = mcpsJsonPath || process.env.HQ_MCPS_PATH || DEFAULT_MCPS_PATH;

  if (!existsSync(path)) {
    logger.warn({ path }, '[risk-level-sync] mcps.json not found — skipping');
    return;
  }

  let config: { mcps: McpEntry[] };
  try {
    config = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    logger.warn({ path, error: String(err) }, '[risk-level-sync] failed to parse mcps.json — skipping');
    return;
  }

  if (!Array.isArray(config.mcps)) {
    logger.warn({ path }, '[risk-level-sync] mcps.json has no mcps array — skipping');
    return;
  }

  let count = 0;
  for (const mcp of config.mcps) {
    if (!mcp.toolRiskLevels || typeof mcp.toolRiskLevels !== 'object') continue;

    for (const [toolName, level] of Object.entries(mcp.toolRiskLevels)) {
      if (!VALID_LEVELS.has(level)) {
        logger.warn({ mcpName: mcp.name, toolName, level }, '[risk-level-sync] invalid risk level — skipping');
        continue;
      }
      setRiskLevel(mcp.name, toolName, level as RiskLevel);
      count++;
    }
  }

  if (count > 0) {
    logger.info({ count, path }, '[risk-level-sync] synced risk levels from HQ config');
  }
}
