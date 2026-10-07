export interface RecoveryAction {
  label: string;
  action: string;
}

const RESUME: RecoveryAction = { label: 'Resume', action: 'resume_session' };
const FRESH: RecoveryAction = { label: 'Start fresh session', action: 'clear_session' };

export function getRecoveryActions(code: number, stderr: string | null): RecoveryAction[] {
  if (!stderr) return [RESUME, FRESH];
  const lower = stderr.toLowerCase();
  if (lower.includes('no conversation found') || lower.includes('session not found')) {
    return [FRESH];
  }
  if (lower.includes('mcp') || lower.includes('connection failed') || lower.includes('server disconnected')) {
    return [
      RESUME,
      { label: 'Restart without MCP', action: 'restart_no_mcp' },
      FRESH,
    ];
  }
  return [RESUME, FRESH];
}
