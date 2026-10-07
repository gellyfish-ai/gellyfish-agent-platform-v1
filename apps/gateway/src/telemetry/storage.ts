import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Use process.cwd() for portability across different Node.js environments
const DATA_DIR = join(process.cwd(), 'data');
const METRICS_FILE = join(DATA_DIR, 'claude-code-metrics.json');

export interface TokenMetric {
  timestamp: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface SessionMetric {
  sessionId: string;
  startTime: string;
  endTime?: string;
  workingDirectory?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  messageCount: number;
  toolUseCount: number;
}

export interface TelemetryData {
  tokens: TokenMetric[];
  sessions: Record<string, SessionMetric>;
  lastUpdated: string;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadTelemetryData(): TelemetryData {
  ensureDataDir();
  if (!existsSync(METRICS_FILE)) {
    return { tokens: [], sessions: {}, lastUpdated: new Date().toISOString() };
  }
  try {
    const content = readFileSync(METRICS_FILE, 'utf-8');
    return JSON.parse(content) as TelemetryData;
  } catch {
    return { tokens: [], sessions: {}, lastUpdated: new Date().toISOString() };
  }
}

export function saveTelemetryData(data: TelemetryData): void {
  ensureDataDir();
  data.lastUpdated = new Date().toISOString();
  writeFileSync(METRICS_FILE, JSON.stringify(data, null, 2));
}

export function addTokenMetric(metric: TokenMetric): void {
  const data = loadTelemetryData();
  data.tokens.push(metric);

  // Update session aggregate
  if (!data.sessions[metric.sessionId]) {
    data.sessions[metric.sessionId] = {
      sessionId: metric.sessionId,
      startTime: metric.timestamp,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalCostUsd: 0,
      messageCount: 0,
      toolUseCount: 0,
    };
  }

  const session = data.sessions[metric.sessionId];
  session.totalInputTokens += metric.inputTokens;
  session.totalOutputTokens += metric.outputTokens;
  session.totalCacheReadTokens += metric.cacheReadTokens;
  session.totalCacheCreationTokens += metric.cacheCreationTokens;
  session.totalCostUsd += metric.costUsd;
  session.messageCount += 1;
  session.endTime = metric.timestamp;

  // Keep only last 30 days of token metrics
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  data.tokens = data.tokens.filter(t => new Date(t.timestamp) > thirtyDaysAgo);

  saveTelemetryData(data);
}

export function getMetricsByDateRange(startDate: string, endDate: string): {
  tokens: TokenMetric[];
  sessions: SessionMetric[];
} {
  const data = loadTelemetryData();
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const filteredTokens = data.tokens.filter(t => {
    const ts = new Date(t.timestamp);
    return ts >= start && ts <= end;
  });

  const sessionIds = new Set(filteredTokens.map(t => t.sessionId));
  const filteredSessions = Object.values(data.sessions).filter(s => sessionIds.has(s.sessionId));

  return { tokens: filteredTokens, sessions: filteredSessions };
}

export function aggregateByDate(tokens: TokenMetric[]): Record<string, {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  requestCount: number;
  models: Record<string, { tokens: number; cost: number }>;
}> {
  const byDate: Record<string, {
    date: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    requestCount: number;
    models: Record<string, { tokens: number; cost: number }>;
  }> = {};

  for (const token of tokens) {
    const date = token.timestamp.split('T')[0];
    if (!byDate[date]) {
      byDate[date] = {
        date,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        requestCount: 0,
        models: {},
      };
    }

    const day = byDate[date];
    day.inputTokens += token.inputTokens;
    day.outputTokens += token.outputTokens;
    day.cacheReadTokens += token.cacheReadTokens;
    day.cacheCreationTokens += token.cacheCreationTokens;
    day.costUsd += token.costUsd;
    day.requestCount += 1;

    if (!day.models[token.model]) {
      day.models[token.model] = { tokens: 0, cost: 0 };
    }
    day.models[token.model].tokens += token.inputTokens + token.outputTokens;
    day.models[token.model].cost += token.costUsd;
  }

  return byDate;
}
