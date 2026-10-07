import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';

export interface ModelOption {
  id: string;
  label: string;
  shortName: string;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'sonnet', label: 'Claude Sonnet', shortName: 'sonnet' },
  { id: 'opus', label: 'Claude Opus', shortName: 'opus' },
  { id: 'haiku', label: 'Claude Haiku', shortName: 'haiku' },
];

const FALLBACK_MODEL = 'opus';

/** Read defaultModel from GAP/platform.json (version-controlled source of truth) */
function loadPlatformDefault(): string {
  const hqPath = process.env.HQ_PATH;
  if (!hqPath) return FALLBACK_MODEL;
  const platformPath = join(hqPath, 'GAP', 'platform.json');
  if (!existsSync(platformPath)) return FALLBACK_MODEL;
  try {
    const data = JSON.parse(readFileSync(platformPath, 'utf-8'));
    if (data.defaultModel && typeof data.defaultModel === 'string') {
      logger.info({ defaultModel: data.defaultModel }, '[models] loaded platform default from HQ');
      return data.defaultModel;
    }
  } catch { /* malformed file — use fallback */ }
  return FALLBACK_MODEL;
}

export const DEFAULT_MODEL: string = loadPlatformDefault();

export function isValidModel(model: string): boolean {
  return AVAILABLE_MODELS.some(m => m.id === model || m.shortName === model);
}

export function resolveModel(profileModel: string | null, conversationModel?: string | null): string {
  return conversationModel || profileModel || DEFAULT_MODEL;
}
