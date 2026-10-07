/**
 * Re-export from session/ modules.
 * All logic has moved to src/session/ — this file exists for backward compatibility.
 */
export {
  type ManagedProcess,
  type SendResult,
  getActiveProcess,
  getActiveProcessByAgent,
  registerProcess,
  unregisterProcess,
  getAllActiveProcesses,
  isProcessStale,
  getStaleProcesses,
  removeTaskListener,
  formatUserMessage,
  formatControlResponse,
  extractResultText,
  prefixMessage,
  handleProcessEvent,
  sendMessage,
  syncFromPM,
  killSession,
  destroySession,
  generateSummaryFromSession,
} from './session/index.js';
