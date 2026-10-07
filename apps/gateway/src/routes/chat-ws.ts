/**
 * Re-export from ws/ modules.
 * All logic has moved to src/ws/ — this file exists for backward compatibility.
 */
export {
  broadcastToAll,
  notifySession,
  sendToActiveSession,
  chatWsRoutes,
  getActiveProcess,
  registerProcess,
  getAllActiveProcesses,
  syncFromPM,
  killSession,
  getStaleProcesses,
  type ManagedProcess,
} from '../ws/index.js';
