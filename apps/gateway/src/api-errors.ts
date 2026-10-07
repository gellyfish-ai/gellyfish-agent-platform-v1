/**
 * API error tracking — in-memory ring buffer for Anthropic API errors.
 * Classifies error strings and provides structured access via /api/health/api-errors.
 */

import { logger } from './logger.js';

export type ApiErrorType = 'rate_limit' | 'overloaded' | 'connection';

export interface ApiErrorEntry {
  timestamp: string;
  agentId: string | null;
  agentName: string;
  type: ApiErrorType;
  raw: string;
  source: 'task' | 'process';
}

const BUFFER_SIZE = 100;
const buffer: ApiErrorEntry[] = [];

export function classifyApiError(text: string): ApiErrorType | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('rate_limit')) return 'rate_limit';
  if (lower.includes('503') || lower.includes('overloaded') || lower.includes('service unavailable')) return 'overloaded';
  if (lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('enotfound') || lower.includes('etimedout')) return 'connection';
  return null;
}

export function recordApiError(entry: Omit<ApiErrorEntry, 'timestamp'>): void {
  const full: ApiErrorEntry = { ...entry, timestamp: new Date().toISOString() };
  buffer.push(full);
  if (buffer.length > BUFFER_SIZE) buffer.shift();
  logger.warn({ agentId: entry.agentId, agentName: entry.agentName, apiErrorType: entry.type, source: entry.source, raw: entry.raw.substring(0, 200) }, '[api-error] Anthropic API error detected');
}

export function getRecentApiErrors(maxAgeMs = 24 * 60 * 60 * 1000): { errors: ApiErrorEntry[]; counts: Record<ApiErrorType, number> } {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const recent = buffer.filter(e => e.timestamp >= cutoff);
  const counts: Record<ApiErrorType, number> = { rate_limit: 0, overloaded: 0, connection: 0 };
  for (const e of recent) counts[e.type]++;
  return { errors: recent, counts };
}
