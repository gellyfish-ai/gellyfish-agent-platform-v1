import type { ManagedProcess } from './types.js';

// Primary map: keyed by sessionId (process lifecycle)
const activeProcesses = new Map<string, ManagedProcess>();
// Secondary index: keyed by agentId (agent lifecycle)
const activeByAgent = new Map<string, ManagedProcess>();

export function getActiveProcess(sessionId: string): ManagedProcess | undefined {
  return activeProcesses.get(sessionId);
}

export function getActiveProcessByAgent(agentId: string): ManagedProcess | undefined {
  return activeByAgent.get(agentId);
}

export function registerProcess(sessionId: string, managed: ManagedProcess): void {
  activeProcesses.set(sessionId, managed);
  if (managed.agentId) {
    activeByAgent.set(managed.agentId, managed);
  }
}

export function unregisterProcess(sessionId: string): void {
  const managed = activeProcesses.get(sessionId);
  if (managed?.agentId) {
    activeByAgent.delete(managed.agentId);
  }
  activeProcesses.delete(sessionId);
}

export function getAllActiveProcesses(): Map<string, ManagedProcess> {
  return activeProcesses;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function isProcessStale(managed: ManagedProcess): boolean {
  if (!managed.alive || !managed.lastActivityAt) return false;
  if (!managed.agentId) return false;
  const elapsed = Date.now() - managed.lastActivityAt.getTime();
  return elapsed > STALE_THRESHOLD_MS;
}

export function getStaleProcesses(): ManagedProcess[] {
  const stale: ManagedProcess[] = [];
  for (const [, managed] of activeProcesses) {
    if (isProcessStale(managed) && !managed.staleNotified) {
      stale.push(managed);
    }
  }
  return stale;
}

export function removeTaskListener(agentId: string, taskId: string): boolean {
  const managed = activeByAgent.get(agentId);
  if (!managed) return false;
  return managed.taskEventListeners.delete(taskId);
}
