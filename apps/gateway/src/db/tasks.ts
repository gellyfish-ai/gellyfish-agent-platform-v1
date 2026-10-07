import { EventEmitter } from 'events';
import db from './connection.js';
import type { Task, TaskState, TaskClarification } from './types.js';

export const taskEvents = new EventEmitter();

export function createTask(opts: {
  id: string;
  creatorAgentId: string;
  assigneeAgentId: string;
  message: string;
  keepAlive?: boolean;
}): Task {
  const keepAlive = opts.keepAlive !== false ? 1 : 0;
  db.prepare(`
    INSERT INTO tasks (id, creator_agent_id, assignee_agent_id, message, keep_alive)
    VALUES (?, ?, ?, ?, ?)
  `).run(opts.id, opts.creatorAgentId, opts.assigneeAgentId, opts.message, keepAlive);
  return getTask(opts.id)!;
}

export function updateTaskState(
  taskId: string,
  state: TaskState,
  extra?: { result?: string; error?: string; sessionId?: string },
): Task | undefined {
  const sets = ['state = ?', "updated_at = datetime('now')"];
  const params: unknown[] = [state];

  if (extra?.result !== undefined) { sets.push('result = ?'); params.push(extra.result); }
  if (extra?.error !== undefined) { sets.push('error = ?'); params.push(extra.error); }
  if (extra?.sessionId !== undefined) { sets.push('session_id = ?'); params.push(extra.sessionId); }

  params.push(taskId);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const task = getTask(taskId);
  if (task) {
    taskEvents.emit(`task:${taskId}`, task);
  }
  return task;
}

export function getTask(taskId: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
}

export function listTasks(filters?: {
  assigneeAgentId?: string;
  creatorAgentId?: string;
  state?: TaskState;
}): Task[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.assigneeAgentId) {
    conditions.push('assignee_agent_id = ?');
    params.push(filters.assigneeAgentId);
  }
  if (filters?.creatorAgentId) {
    conditions.push('creator_agent_id = ?');
    params.push(filters.creatorAgentId);
  }
  if (filters?.state) {
    conditions.push('state = ?');
    params.push(filters.state);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`).all(...params) as Task[];
}

export function storeSessionTaskEvent(sessionId: string, taskId: string, eventType: string, data: Record<string, unknown>): void {
  db.prepare(`
    INSERT INTO session_task_events (session_id, task_id, event_type, data)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, taskId, eventType, JSON.stringify(data));
}

export function getSessionTaskEvents(sessionId: string): Array<{ id: number; task_id: string; event_type: string; data: string; created_at: string }> {
  return db.prepare(`
    SELECT id, task_id, event_type, data, created_at
    FROM session_task_events
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(sessionId) as Array<{ id: number; task_id: string; event_type: string; data: string; created_at: string }>;
}

export function incrementBlockCount(taskId: string): number {
  db.prepare(`UPDATE tasks SET block_count = block_count + 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
  const row = db.prepare('SELECT block_count FROM tasks WHERE id = ?').get(taskId) as { block_count: number } | undefined;
  return row?.block_count ?? 0;
}

export function createClarification(opts: { id: string; taskId: string; question: string }): TaskClarification {
  db.prepare(`
    INSERT INTO task_clarifications (id, task_id, question, asked_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(opts.id, opts.taskId, opts.question);
  return getClarification(opts.id)!;
}

export function getClarification(id: string): TaskClarification | undefined {
  return db.prepare('SELECT * FROM task_clarifications WHERE id = ?').get(id) as TaskClarification | undefined;
}

export function getOpenClarification(taskId: string): TaskClarification | undefined {
  return db.prepare(`
    SELECT * FROM task_clarifications
    WHERE task_id = ? AND answered_at IS NULL AND timed_out = 0
    ORDER BY asked_at DESC LIMIT 1
  `).get(taskId) as TaskClarification | undefined;
}

export function answerClarification(id: string, answer: string): TaskClarification | undefined {
  db.prepare(`
    UPDATE task_clarifications SET answer = ?, answered_at = datetime('now') WHERE id = ?
  `).run(answer, id);
  return getClarification(id);
}

export function timeoutClarification(id: string): TaskClarification | undefined {
  db.prepare(`UPDATE task_clarifications SET timed_out = 1 WHERE id = ?`).run(id);
  return getClarification(id);
}

export function getTaskClarifications(taskId: string): TaskClarification[] {
  return db.prepare(`
    SELECT * FROM task_clarifications WHERE task_id = ? ORDER BY asked_at ASC
  `).all(taskId) as TaskClarification[];
}
