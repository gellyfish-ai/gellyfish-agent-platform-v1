// Re-export all session modules for backward compatibility.
// Existing `import from '../session-send.js'` paths should use './session/index.js' instead.

export type { ManagedProcess, SendResult } from './types.js';
export {
  getActiveProcess,
  getActiveProcessByAgent,
  registerProcess,
  unregisterProcess,
  getAllActiveProcesses,
  isProcessStale,
  getStaleProcesses,
  removeTaskListener,
} from './registry.js';
export { formatUserMessage, formatControlResponse, extractResultText, prefixMessage } from './format.js';
export { handleProcessEvent } from './events.js';
export { sendMessage } from './send.js';
export { syncFromPM } from './sync.js';
export { killSession, destroySession, generateSummaryFromSession } from './lifecycle.js';
