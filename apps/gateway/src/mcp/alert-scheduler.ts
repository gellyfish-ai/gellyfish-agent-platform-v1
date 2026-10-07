import { detectAnomalies } from './observability.js';
import { logger } from '../logger.js';

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let broadcastFn: ((alerts: unknown[]) => void) | null = null;

export function startAlertScheduler(broadcast?: (alerts: unknown[]) => void): void {
  if (schedulerHandle) return;
  broadcastFn = broadcast ?? null;

  schedulerHandle = setInterval(() => {
    try {
      const alerts = detectAnomalies();
      if (alerts.length > 0) {
        logger.warn({ alertCount: alerts.length }, '[mcp-alerts] anomalies detected');
        broadcastFn?.(alerts);
      }
    } catch (err) {
      logger.warn({ error: String(err) }, '[mcp-alerts] scheduler error');
    }
  }, 60_000);

  logger.info('[mcp-alerts] alert scheduler started (60s interval)');
}

export function stopAlertScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    broadcastFn = null;
  }
}
