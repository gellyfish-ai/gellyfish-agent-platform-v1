/**
 * Task state management.
 * Layer 2: pure state, no DOM. Like quote.js for quotes.
 */

const dataStore = new Map(); // taskId -> { agentName, entries, toolCount, message, state, result, error, ... }

/** Get task data by ID */
export function getTaskData(taskId) {
  return dataStore.get(taskId);
}

/** Set or initialize task data */
export function setTaskData(taskId, data) {
  dataStore.set(taskId, data);
}

/** Update a single field on task data (creates entry if missing) */
export function updateTaskField(taskId, field, value) {
  const stored = dataStore.get(taskId);
  if (stored) {
    stored[field] = value;
  }
}

/** Check if task data exists */
export function hasTaskData(taskId) {
  return dataStore.has(taskId);
}

/** Initialize task data if not present */
export function ensureTaskData(taskId, defaults) {
  if (!dataStore.has(taskId)) {
    dataStore.set(taskId, { ...defaults });
  }
  return dataStore.get(taskId);
}

/** Format a timestamp as HH:MM */
export function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}
