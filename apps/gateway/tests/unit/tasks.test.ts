import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from '../../src/server.js';
import { FastifyInstance } from 'fastify';
import db, {
  createTask, updateTaskState, getTask, listTasks, taskEvents,
} from '../../src/db/index.js';

// Seed test profiles and agents into the isolated test DB
function seedTestData() {
  const insertProfile = db.prepare(`
    INSERT OR IGNORE INTO profiles (id, name, icon, system_prompt, workspace_dir)
    VALUES (?, ?, ?, '', '')
  `);
  insertProfile.run('test-creator-profile', 'Test Creator', '🧪');
  insertProfile.run('test-assignee-profile', 'Test Assignee', '🎯');

  const insertAgent = db.prepare(`
    INSERT OR IGNORE INTO agents (id, profile_id, name, state, workspace_dir)
    VALUES (?, ?, ?, 'idle', '')
  `);
  insertAgent.run('test-creator', 'test-creator-profile', 'Test Creator');
  insertAgent.run('test-assignee', 'test-assignee-profile', 'Test Assignee');
}

// Safe in isolated test DB — does NOT touch production
function cleanTasks() {
  db.prepare('DELETE FROM tasks').run();
}

describe('Task DB helpers', () => {
  beforeAll(seedTestData);
  beforeEach(cleanTasks);

  it('createTask inserts and returns a task', () => {
    const task = createTask({
      id: 'task-1',
      creatorAgentId: 'test-creator',
      assigneeAgentId: 'test-assignee',
      message: 'Do something',
    });
    expect(task.id).toBe('task-1');
    expect(task.state).toBe('submitted');
    expect(task.keep_alive).toBe(1);
    expect(task.message).toBe('Do something');
  });

  it('createTask with keepAlive false', () => {
    const task = createTask({
      id: 'task-ka',
      creatorAgentId: 'test-creator',
      assigneeAgentId: 'test-assignee',
      message: 'Quick job',
      keepAlive: false,
    });
    expect(task.keep_alive).toBe(0);
  });

  it('updateTaskState transitions and emits event', () => {
    createTask({
      id: 'task-2',
      creatorAgentId: 'test-creator',
      assigneeAgentId: 'test-assignee',
      message: 'Work',
    });

    let emitted = false;
    taskEvents.once('task:task-2', (t) => {
      emitted = true;
      expect(t.state).toBe('working');
    });

    const updated = updateTaskState('task-2', 'working', { sessionId: 'sess-123' });
    expect(updated!.state).toBe('working');
    expect(updated!.session_id).toBe('sess-123');
    expect(emitted).toBe(true);
  });

  it('updateTaskState stores result and error', () => {
    createTask({
      id: 'task-3',
      creatorAgentId: 'test-creator',
      assigneeAgentId: 'test-assignee',
      message: 'Fail',
    });

    updateTaskState('task-3', 'failed', { error: 'Something broke' });
    const task = getTask('task-3');
    expect(task!.state).toBe('failed');
    expect(task!.error).toBe('Something broke');
  });

  it('listTasks filters by assignee, creator, and state', () => {
    createTask({ id: 't-a', creatorAgentId: 'test-creator', assigneeAgentId: 'test-assignee', message: 'a' });
    createTask({ id: 't-b', creatorAgentId: 'test-assignee', assigneeAgentId: 'test-creator', message: 'b' });
    updateTaskState('t-a', 'completed', { result: 'done' });

    expect(listTasks({ assigneeAgentId: 'test-assignee' })).toHaveLength(1);
    expect(listTasks({ creatorAgentId: 'test-creator' })).toHaveLength(1);
    expect(listTasks({ state: 'completed' })).toHaveLength(1);
    expect(listTasks({ state: 'submitted' })).toHaveLength(1);
    expect(listTasks()).toHaveLength(2);
  });
});

describe('Tasks API', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    seedTestData();
    server = await createServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(cleanTasks);

  it('POST /api/tasks with invalid creator returns 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        creatorAgentId: 'nonexistent',
        assigneeAgentId: 'test-assignee',
        callerSessionId: 'test-session',
        message: 'hello',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/tasks with invalid assignee returns 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        creatorAgentId: 'test-creator',
        assigneeAgentId: 'nonexistent',
        callerSessionId: 'test-session',
        message: 'hello',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/tasks/:id returns 404 for missing task', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/tasks/no-such-task' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/tasks/:id/cancel returns 404 for missing task', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/tasks/no-such-task/cancel' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/tasks/:id/cancel on completed task returns 409', async () => {
    createTask({
      id: 'done-task',
      creatorAgentId: 'test-creator',
      assigneeAgentId: 'test-assignee',
      message: 'already done',
    });
    updateTaskState('done-task', 'completed', { result: 'ok' });

    const res = await server.inject({ method: 'POST', url: '/api/tasks/done-task/cancel' });
    expect(res.statusCode).toBe(409);
  });

  it('POST /api/tasks/:id/cancel on submitted task succeeds', async () => {
    createTask({
      id: 'cancel-me',
      creatorAgentId: 'test-creator',
      assigneeAgentId: 'test-assignee',
      message: 'nope',
    });

    const res = await server.inject({ method: 'POST', url: '/api/tasks/cancel-me/cancel' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).task.state).toBe('canceled');
  });

  it('GET /api/tasks lists with filters', async () => {
    createTask({ id: 'f-1', creatorAgentId: 'test-creator', assigneeAgentId: 'test-assignee', message: 'a' });
    createTask({ id: 'f-2', creatorAgentId: 'test-assignee', assigneeAgentId: 'test-creator', message: 'b' });

    const all = await server.inject({ method: 'GET', url: '/api/tasks' });
    expect(JSON.parse(all.body).tasks.length).toBeGreaterThanOrEqual(2);

    const byAssignee = await server.inject({ method: 'GET', url: '/api/tasks?assignee=test-assignee' });
    expect(JSON.parse(byAssignee.body).tasks.every((t: { assignee_agent_id: string }) => t.assignee_agent_id === 'test-assignee')).toBe(true);

    const byCreator = await server.inject({ method: 'GET', url: '/api/tasks?creator=test-creator' });
    expect(JSON.parse(byCreator.body).tasks.every((t: { creator_agent_id: string }) => t.creator_agent_id === 'test-creator')).toBe(true);
  });
});
