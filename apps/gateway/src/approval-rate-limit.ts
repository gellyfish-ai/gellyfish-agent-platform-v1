/**
 * Rate limiter for approval requests — prevents notification spam.
 * Tracks requests per agent per time window.
 */

import { logger } from './logger.js';

const MAX_REQUESTS = 10;
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// agentId -> array of timestamps
const windows = new Map<string, number[]>();

/** Check if an agent is within the rate limit. Returns true if allowed. */
export function checkApprovalRateLimit(agentId: string): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  let timestamps = windows.get(agentId);
  if (!timestamps) {
    timestamps = [];
    windows.set(agentId, timestamps);
  }

  // Prune old entries
  const filtered = timestamps.filter(t => t > cutoff);
  windows.set(agentId, filtered);

  if (filtered.length >= MAX_REQUESTS) {
    logger.warn({ agentId, count: filtered.length, maxRequests: MAX_REQUESTS }, '[rate-limit] approval rate limit exceeded');
    return false;
  }

  filtered.push(now);
  return true;
}
