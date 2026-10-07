import { FastifyInstance } from 'fastify';
import db, {
  Task, TaskState, TERMINAL_TASK_STATES,
  createTask, updateTaskState, getTask, listTasks, taskEvents, getSetting,
  getAgentForProfile, getAgent, getAgentConversation,
  storeSessionTaskEvent,
  incrementBlockCount, createClarification, getOpenClarification, answerClarification, timeoutClarification, getTaskClarifications,
} from '../db/index.js';
import { notifySession } from './chat-ws.js';
import { lookupProfile } from '../claude-spawn.js';
import { getExitMessage } from '../ws/spawn.js';
import { pmClient } from '../pm-client.js';
import { logger } from '../logger.js';
import { prefixMessage } from '../session/format.js';
import { classifyApiError, recordApiError } from '../api-errors.js';
import {
  sendMessage,
  extractResultText,
  removeTaskListener,
  getActiveProcess,
  type ManagedProcess,
} from '../session-send.js';

/** Infer the crew ID from an agent's crew membership. Returns the first crew found. */
function inferCrewId(agentId?: string): string | undefined {
  if (!agentId) return undefined;
  const agent = getAgent(agentId);
  if (!agent) return undefined;
  const row = db.prepare(`
    SELECT cm.crew_id FROM crew_members cm
    WHERE cm.profile_id = ?
    LIMIT 1
  `).get(agent.profile_id) as { crew_id: string } | undefined;
  return row?.crew_id;
}

/** Resolve the assignee agent using crew context when available. */
function resolveAssigneeAgent(
  body: { assigneeAgentId?: string; assigneeProfileId?: string },
  crewId?: string,
  creatorAgentId?: string,
): ReturnType<typeof getAgent> {
  // Direct agent ID — no resolution needed
  if (body.assigneeAgentId) return getAgent(body.assigneeAgentId);
  if (!body.assigneeProfileId) return undefined;

  // Crew-scoped resolution: find the agent for this profile in the specified crew
  if (crewId) {
    const crewAgent = db.prepare(`
      SELECT a.* FROM agents a
      JOIN crew_members cm ON cm.profile_id = a.profile_id AND cm.crew_id = ?
      WHERE a.profile_id = ? AND a.state != 'stopped'
      ORDER BY CASE a.state WHEN 'working' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END,
               a.created_at DESC
      LIMIT 1
    `).get(crewId, body.assigneeProfileId) as ReturnType<typeof getAgent>;
    if (crewAgent) return crewAgent;
  }

  // Fallback: getAgentForProfile with creator hint
  return getAgentForProfile(body.assigneeProfileId, creatorAgentId);
}

// Track which task is active on each session (for inject-into-existing-process case).
const activeTaskBySession = new Map<string, string>(); // sessionId -> taskId

// Throttle CLI progress injections: max one per 10s per task
const lastProgressInjection = new Map<string, number>(); // taskId -> timestamp
const PROGRESS_THROTTLE_MS = 10_000;

// Track clarification timeouts: clarificationId -> timeout handle
const clarificationTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const CLARIFICATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function tasksRoutes(server: FastifyInstance) {

  // POST /api/tasks — create and begin executing a task
  server.post<{
    Body: {
      creatorProfileId?: string;  // Legacy — resolved to agent
      assigneeProfileId?: string; // Legacy — resolved to agent
      creatorAgentId?: string;
      assigneeAgentId?: string;
      crewId?: string;            // Scope agent resolution to a specific crew
      message: string;
      keepAlive?: boolean;
      callerSessionId: string;
    };
  }>('/tasks', async (req, reply) => {
    const { message, keepAlive } = req.body;
    let { callerSessionId } = req.body;

    if (!callerSessionId) return reply.status(400).send({ error: 'callerSessionId is required — task creator needs feedback' });

    // Resolve callerSessionId — may be a session ID, agent ID, or profile ID
    if (!getActiveProcess(callerSessionId)) {
      // Try as agent ID
      const callerConv = getAgentConversation(callerSessionId);
      if (callerConv?.session_id) {
        server.log.warn({ callerSessionId, resolvedSessionId: callerConv.session_id }, '[task] resolved callerSessionId from agent ID');
        callerSessionId = callerConv.session_id;
      } else {
        // Try as profile ID
        const callerAgent = getAgentForProfile(callerSessionId);
        if (callerAgent) {
          const profileConv = getAgentConversation(callerAgent.id);
          if (profileConv?.session_id) {
            server.log.warn({ callerSessionId, resolvedSessionId: profileConv.session_id }, '[task] resolved callerSessionId from profile ID');
            callerSessionId = profileConv.session_id;
          }
        }
      }
    }

    // Resolve creator agent
    const creatorAgent = req.body.creatorAgentId
      ? getAgent(req.body.creatorAgentId)
      : (req.body.creatorProfileId ? getAgentForProfile(req.body.creatorProfileId) : undefined);

    // Resolve crew context: explicit crewId > auto-infer from creator
    const crewId = req.body.crewId || inferCrewId(creatorAgent?.id);

    // Resolve assignee agent — crew-scoped if possible
    const assigneeAgent = resolveAssigneeAgent(req.body, crewId, creatorAgent?.id);

    if (!creatorAgent) return reply.status(400).send({ error: 'Creator agent not found — provide creatorAgentId or creatorProfileId' });
    if (!assigneeAgent) return reply.status(400).send({ error: 'Assignee agent not found — provide assigneeAgentId or assigneeProfileId' });

    // Resolve profiles from agents
    const creator = lookupProfile(creatorAgent.profile_id);
    const assignee = lookupProfile(assigneeAgent.profile_id);
    if (!creator || !assignee) return reply.status(400).send({ error: 'Profile not found for agent' });

    const taskId = crypto.randomUUID();
    const task = createTask({
      id: taskId,
      creatorAgentId: creatorAgent.id,
      assigneeAgentId: assigneeAgent.id,
      message,
      keepAlive,
    });

    // Look up assignee's session from conversation for the "Open" button
    const assigneeConv = assigneeAgent ? getAgentConversation(assigneeAgent.id) : undefined;
    const assigneeSession = assigneeConv ? { session_id: assigneeConv.session_id } : undefined;

    const injectToCreatorCli = (msg: string) => {
      sendMessage({
        profileId: creatorAgent.profile_id,
        agentId: creatorAgent.id,
        message: msg,
      }).catch(err => {
        logger.warn({ taskId: task.id, error: String(err) }, '[task] failed to inject notification into creator process');
      });
    };

    const notifyTask = (state: string, extra?: Record<string, unknown>) => {
      // task_progress events
      if (extra?.type === 'task_progress') {
        if (callerSessionId) {
          // Send existing task_progress event (for task bubble progress lines)
          notifySession(callerSessionId, extra as Record<string, unknown>);
          storeSessionTaskEvent(callerSessionId, task.id, 'task_progress', extra as Record<string, unknown>);

          // Send task_progress_injection event (for timeline card)
          const injectionEvent = {
            type: 'task_progress_injection',
            taskId: task.id,
            agentName: assignee.name,
            agentIcon: assignee.icon,
            summary: (extra as Record<string, unknown>).summary || '',
            toolName: (extra as Record<string, unknown>).toolName,
            timestamp: (extra as Record<string, unknown>).timestamp,
          };
          notifySession(callerSessionId, injectionEvent);
          storeSessionTaskEvent(callerSessionId, task.id, 'task_progress_injection', injectionEvent);
        }
        // Throttled CLI injection for progress
        const now = Date.now();
        const lastInject = lastProgressInjection.get(task.id) || 0;
        if (now - lastInject >= PROGRESS_THROTTLE_MS) {
          lastProgressInjection.set(task.id, now);
          const summary = (extra as Record<string, unknown>).summary || (extra as Record<string, unknown>).event || '';
          // Per-tool progress goes to WebSocket/timeline only — not injected into CLI
          // to avoid forcing the crew lead to respond to every tool call
        }
        return;
      }

      // Re-resolve assignee session — it may have been created after task submission
      const latestConv = assigneeAgent ? getAgentConversation(assigneeAgent.id) : undefined;
      const latestSessionId = latestConv?.session_id || assigneeSession?.session_id;

      const eventData = {
        type: 'task_update',
        taskId: task.id,
        creator: creator.name,
        creatorIcon: creator.icon,
        target: assignee.name,
        targetIcon: assignee.icon,
        targetProfileId: assignee.id,
        targetAgentId: assigneeAgent.id,
        targetSessionId: latestSessionId,
        state,
        message: task.message,
        ...extra,
      };

      // WebSocket notification to browser
      if (callerSessionId) {
        notifySession(callerSessionId, eventData);
        storeSessionTaskEvent(callerSessionId, task.id, 'task_update', eventData);
      }

      // CLI injection for all state transitions
      if (['completed', 'failed'].includes(state)) {
        const resultSummary = extra?.result
          ? String(extra.result).substring(0, 300)
          : (extra?.error ? String(extra.error) : '');
        const verb = state === 'completed' ? 'completed' : 'failed';
        injectToCreatorCli(prefixMessage('task-result', `agent:${assignee.name}`, `Task ${verb} by ${assignee.name}: ${resultSummary}`.trim()));
        lastProgressInjection.delete(task.id); // cleanup throttle entry
      } else if (state === 'working') {
        injectToCreatorCli(prefixMessage('task-result', `agent:${assignee.name}`, `Task update — ${assignee.name} is now working`));
      }
    };

    // Auto-detect issue references in task message (e.g. #18, #29)
    // and set on the assignee agent's conversation
    const issueMatch = message.match(/#(\d+)/);
    if (issueMatch && assigneeAgent) {
      const issueNum = parseInt(issueMatch[1], 10);
      const conv = getAgentConversation(assigneeAgent.id);
      if (conv && !conv.issue_number) {
        db.prepare('UPDATE conversations SET issue_number = ?, updated_at = datetime(\'now\') WHERE id = ?').run(issueNum, conv.id);
        server.log.info({ taskId: task.id, issueNumber: issueNum, conversationId: conv.id }, '[task] auto-linked issue from task message');
      }
    }

    notifyTask('submitted');
    executeTask(task, assignee, server, notifyTask).catch(err => {
      server.log.error({ taskId: task.id, error: String(err) }, '[task] executeTask failed');
      updateTaskState(task.id, 'failed', { error: String(err) });
      notifyTask('failed');
    });

    return { task: { id: task.id, state: task.state } };
  });

  // GET /api/tasks/:id — poll task state
  server.get<{ Params: { id: string } }>('/tasks/:id', async (req, reply) => {
    const task = getTask(req.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    const creatorAgent = task.creator_agent_id ? getAgent(task.creator_agent_id) : null;
    const creatorProfile = creatorAgent ? lookupProfile(creatorAgent.profile_id) : null;
    const assigneeAgent = task.assignee_agent_id ? getAgent(task.assignee_agent_id) : null;
    const assigneeProfile = assigneeAgent ? lookupProfile(assigneeAgent.profile_id) : null;
    return {
      task: {
        ...task,
        creatorName: creatorProfile?.name || creatorAgent?.name || 'Unknown',
        creatorIcon: creatorProfile?.icon,
        assigneeName: assigneeProfile?.name || assigneeAgent?.name || 'Agent',
        assigneeIcon: assigneeProfile?.icon,
      },
    };
  });

  // GET /api/tasks — list tasks with optional filters
  server.get<{
    Querystring: { assignee?: string; creator?: string; state?: TaskState };
  }>('/tasks', async (req) => {
    const tasks = listTasks({
      assigneeAgentId: req.query.assignee,
      creatorAgentId: req.query.creator,
      state: req.query.state,
    });
    return { tasks };
  });

  // POST /api/tasks/:id/cancel — cancel a task
  server.post<{ Params: { id: string } }>('/tasks/:id/cancel', async (req, reply) => {
    const task = getTask(req.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    if (TERMINAL_TASK_STATES.includes(task.state)) {
      return reply.status(409).send({ error: `Task already in terminal state: ${task.state}` });
    }

    // Graceful cancel via PM if task has a session
    if (task.session_id) {
      try { await pmClient.cancel(task.session_id); } catch { /* */ }
    }

    // Clean up task event listener on assignee's process
    if (task.assignee_agent_id) {
      removeTaskListener(task.assignee_agent_id, task.id);
    }
    const updated = updateTaskState(task.id, 'canceled');
    return { task: updated };
  });

  // POST /api/tasks/:id/complete — mark a task as completed
  server.post<{ Params: { id: string }; Body: { result?: string } }>(
    '/tasks/:id/complete',
    async (req, reply) => {
      const task = getTask(req.params.id);
      if (!task) return reply.status(404).send({ error: 'Task not found' });
      if (TERMINAL_TASK_STATES.includes(task.state)) {
        return reply.status(409).send({ error: `Task already in terminal state: ${task.state}` });
      }
      if (task.state !== 'working' && task.state !== 'input-required' && task.state !== 'blocked') {
        return reply.status(409).send({ error: `Task must be in working, input-required, or blocked state to complete, currently: ${task.state}` });
      }

      const updated = updateTaskState(task.id, 'completed', { result: req.body?.result });
      // Clean up task event listener on assignee's process
      if (task.assignee_agent_id) {
        removeTaskListener(task.assignee_agent_id, task.id);
      }
      notifyTaskCreator(task, 'completed', { result: req.body?.result });
      return { task: updated };
    },
  );

  // POST /api/tasks/:id/fail — mark a task as failed
  server.post<{ Params: { id: string }; Body: { error?: string } }>(
    '/tasks/:id/fail',
    async (req, reply) => {
      const task = getTask(req.params.id);
      if (!task) return reply.status(404).send({ error: 'Task not found' });
      if (TERMINAL_TASK_STATES.includes(task.state)) {
        return reply.status(409).send({ error: `Task already in terminal state: ${task.state}` });
      }
      if (task.state !== 'working' && task.state !== 'input-required' && task.state !== 'blocked') {
        return reply.status(409).send({ error: `Task must be in working, input-required, or blocked state to fail, currently: ${task.state}` });
      }

      const errorText = req.body?.error || '';
      const updated = updateTaskState(task.id, 'failed', { error: errorText });
      // Clean up task event listener on assignee's process
      if (task.assignee_agent_id) {
        removeTaskListener(task.assignee_agent_id, task.id);
      }

      const apiErrorType = classifyApiError(errorText);
      if (apiErrorType && task.assignee_agent_id) {
        const agent = getAgent(task.assignee_agent_id);
        recordApiError({
          agentId: task.assignee_agent_id,
          agentName: agent?.name || task.assignee_agent_id.substring(0, 8),
          type: apiErrorType,
          raw: errorText,
          source: 'task',
        });
      }

      notifyTaskCreator(task, 'failed', { error: errorText });
      return { task: updated };
    },
  );

  // POST /api/tasks/:id/clarify — assignee asks creator a question, blocks task
  server.post<{ Params: { id: string }; Body: { question: string } }>(
    '/tasks/:id/clarify',
    async (req, reply) => {
      const task = getTask(req.params.id);
      if (!task) return reply.status(404).send({ error: 'Task not found' });
      if (TERMINAL_TASK_STATES.includes(task.state)) {
        return reply.status(409).send({ error: `Task already in terminal state: ${task.state}` });
      }
      if (task.state !== 'working') {
        return reply.status(409).send({ error: `Task must be in working state to clarify, currently: ${task.state}` });
      }
      if (!req.body?.question?.trim()) {
        return reply.status(400).send({ error: 'question is required' });
      }

      const MAX_BLOCKS = 5;
      if (task.block_count >= MAX_BLOCKS) {
        return reply.status(400).send({ error: 'Task has reached the maximum clarification limit. Fail and re-scope.' });
      }

      const newBlockCount = incrementBlockCount(task.id);
      const clarificationId = crypto.randomUUID();
      const clarification = createClarification({ id: clarificationId, taskId: task.id, question: req.body.question.trim() });
      updateTaskState(task.id, 'blocked');

      // Resolve creator agent to deliver the question
      const creatorAgent = task.creator_agent_id ? getAgent(task.creator_agent_id) : null;
      const creatorProfile = creatorAgent ? lookupProfile(creatorAgent.profile_id) : null;
      const assigneeAgent = task.assignee_agent_id ? getAgent(task.assignee_agent_id) : null;
      const assigneeProfile = assigneeAgent ? lookupProfile(assigneeAgent.profile_id) : null;
      const assigneeName = assigneeProfile?.name || assigneeAgent?.name || 'Agent';

      // Inject question into creator's CLI
      if (creatorAgent) {
        const apiBase = `http://localhost:${process.env.PORT || '3000'}`;
        const questionMsg = prefixMessage(
          'task-result',
          `agent:${assigneeName}`,
          `[Task ${task.id}] Clarification request from ${assigneeName}:\n\n${req.body.question.trim()}\n\nRespond with:\ncurl -s -X POST ${apiBase}/api/tasks/${task.id}/respond -H 'Content-Type: application/json' -d '{"answer": "your answer here"}'`,
        );
        sendMessage({
          profileId: creatorAgent.profile_id,
          agentId: creatorAgent.id,
          message: questionMsg,
        }).catch(err => {
          logger.warn({ taskId: task.id, clarificationId, error: String(err) }, '[clarify] failed to inject question into creator process');
        });

        // WebSocket notification to creator's browser
        const creatorConv = getAgentConversation(creatorAgent.id);
        if (creatorConv?.session_id) {
          const assigneeConv = assigneeAgent ? getAgentConversation(assigneeAgent.id) : null;
          const eventData = {
            type: 'task_update',
            taskId: task.id,
            creator: creatorProfile?.name || 'Unknown',
            creatorIcon: creatorProfile?.icon,
            target: assigneeName,
            targetIcon: assigneeProfile?.icon,
            targetSessionId: assigneeConv?.session_id || null,
            state: 'blocked',
            message: task.message,
            clarification: { id: clarificationId, question: req.body.question.trim(), blockCount: newBlockCount },
          };
          notifySession(creatorConv.session_id, eventData);
          storeSessionTaskEvent(creatorConv.session_id, task.id, 'task_update', eventData);
        }
      }

      // Schedule 10-minute timeout
      const timeoutHandle = setTimeout(() => {
        const current = getTask(task.id);
        if (current?.state !== 'blocked') return; // already answered or terminal
        const open = getOpenClarification(task.id);
        if (!open || open.id !== clarificationId) return;

        timeoutClarification(clarificationId);
        updateTaskState(task.id, 'working');

        // Inject timeout message into assignee's session
        if (assigneeAgent) {
          const timeoutMsg = prefixMessage(
            'system',
            'gateway',
            `[GAP/system from:gateway] Clarification timed out — no response received. Decide yourself or fail the task.`,
          );
          sendMessage({
            profileId: assigneeProfile!.id,
            agentId: assigneeAgent.id,
            message: timeoutMsg,
          }).catch(err => {
            logger.warn({ taskId: task.id, clarificationId, error: String(err) }, '[clarify] failed to inject timeout message into assignee process');
          });
        }
        clarificationTimeouts.delete(clarificationId);
        logger.info({ taskId: task.id, clarificationId }, '[clarify] clarification timed out');
      }, CLARIFICATION_TIMEOUT_MS);
      clarificationTimeouts.set(clarificationId, timeoutHandle);

      return { task: getTask(task.id), clarification };
    },
  );

  // POST /api/tasks/:id/respond — creator answers a clarification, unblocks task
  server.post<{ Params: { id: string }; Body: { answer: string } }>(
    '/tasks/:id/respond',
    async (req, reply) => {
      const task = getTask(req.params.id);
      if (!task) return reply.status(404).send({ error: 'Task not found' });
      if (task.state !== 'blocked') {
        return reply.status(409).send({ error: `Task must be in blocked state to respond, currently: ${task.state}` });
      }
      if (!req.body?.answer?.trim()) {
        return reply.status(400).send({ error: 'answer is required' });
      }

      const open = getOpenClarification(task.id);
      if (!open) return reply.status(404).send({ error: 'No open clarification found for this task' });

      // Clear timeout
      const timeoutHandle = clarificationTimeouts.get(open.id);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        clarificationTimeouts.delete(open.id);
      }

      const clarification = answerClarification(open.id, req.body.answer.trim());
      updateTaskState(task.id, 'working');

      // Resolve agents
      const assigneeAgent = task.assignee_agent_id ? getAgent(task.assignee_agent_id) : null;
      const assigneeProfile = assigneeAgent ? lookupProfile(assigneeAgent.profile_id) : null;
      const creatorAgent = task.creator_agent_id ? getAgent(task.creator_agent_id) : null;
      const creatorProfile = creatorAgent ? lookupProfile(creatorAgent.profile_id) : null;
      const creatorName = creatorProfile?.name || creatorAgent?.name || 'Unknown';

      // Inject answer into assignee's CLI
      if (assigneeAgent && assigneeProfile) {
        const apiBase = `http://localhost:${process.env.PORT || '3000'}`;
        const answerMsg = prefixMessage(
          'task-result',
          `agent:${creatorName}`,
          `[Task ${task.id}] Clarification answered by ${creatorName}:\n\nQuestion: ${open.question}\nAnswer: ${req.body.answer.trim()}\n\nResume working on the task.\n\nWhen you finish this task, mark it complete:\ncurl -s -X POST ${apiBase}/api/tasks/${task.id}/complete -H 'Content-Type: application/json' -d '{"result": "brief summary"}'`,
        );
        sendMessage({
          profileId: assigneeProfile.id,
          agentId: assigneeAgent.id,
          message: answerMsg,
        }).catch(err => {
          logger.warn({ taskId: task.id, clarificationId: open.id, error: String(err) }, '[respond] failed to inject answer into assignee process');
        });

        // WebSocket notification to assignee's browser
        const assigneeConv = getAgentConversation(assigneeAgent.id);
        if (assigneeConv?.session_id) {
          const creatorConv = creatorAgent ? getAgentConversation(creatorAgent.id) : null;
          const eventData = {
            type: 'task_update',
            taskId: task.id,
            creator: creatorName,
            creatorIcon: creatorProfile?.icon,
            target: assigneeProfile.name,
            targetIcon: assigneeProfile.icon,
            targetSessionId: assigneeConv.session_id,
            state: 'working',
            message: task.message,
            clarification: { id: open.id, question: open.question, answer: req.body.answer.trim() },
          };
          notifySession(assigneeConv.session_id, eventData);
          storeSessionTaskEvent(assigneeConv.session_id, task.id, 'task_update', eventData);
          // Also notify creator's session
          if (creatorConv?.session_id && creatorConv.session_id !== assigneeConv.session_id) {
            notifySession(creatorConv.session_id, eventData);
            storeSessionTaskEvent(creatorConv.session_id, task.id, 'task_update', eventData);
          }
        }
      }

      return { task: getTask(task.id), clarification };
    },
  );

  // GET /api/tasks/:id/clarifications — list all clarifications for a task
  server.get<{ Params: { id: string } }>('/tasks/:id/clarifications', async (req, reply) => {
    const task = getTask(req.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    return { clarifications: getTaskClarifications(task.id) };
  });

  // GET /api/tasks/:id/stream — SSE stream of state changes
  server.get<{ Params: { id: string } }>('/tasks/:id/stream', async (req, reply) => {
    const task = getTask(req.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    reply.raw.write(`event: state\ndata: ${JSON.stringify({ state: task.state, result: task.result, error: task.error, updatedAt: task.updated_at })}\n\n`);

    if (TERMINAL_TASK_STATES.includes(task.state)) {
      reply.raw.end();
      return;
    }

    const eventName = `task:${task.id}`;
    const onStateChange = (updated: Task) => {
      reply.raw.write(`event: state\ndata: ${JSON.stringify({ state: updated.state, result: updated.result, error: updated.error, updatedAt: updated.updated_at })}\n\n`);
      if (TERMINAL_TASK_STATES.includes(updated.state)) {
        taskEvents.removeListener(eventName, onStateChange);
        reply.raw.end();
      }
    };

    taskEvents.on(eventName, onStateChange);
    req.raw.on('close', () => { taskEvents.removeListener(eventName, onStateChange); });

    return reply;
  });
}

// --- Task execution ---

type TaskNotify = (state: string, extra?: Record<string, unknown>) => void;

async function executeTask(
  task: Task,
  assigneeProfile: NonNullable<ReturnType<typeof lookupProfile>>,
  server: FastifyInstance,
  notifyTask: TaskNotify,
) {
  // Resolve agent → conversation → session chain
  const agent = task.assignee_agent_id ? getAgent(task.assignee_agent_id) : null;
  const conversation = agent ? getAgentConversation(agent.id) : undefined;
  const sessionId = conversation?.session_id || undefined;

  server.log.info({
    taskId: task.id,
    assigneeProfile: assigneeProfile.name,
    agentId: agent?.id,
    conversationState: conversation?.state,
    sessionId: sessionId || 'none',
  }, '[task] executing');

  // Wrap task message with ID and completion instructions
  const apiBase = `http://localhost:${process.env.PORT || '3000'}`;
  const taskBody = `[Task ${task.id}]
${task.message}

When you finish this task, mark it complete:
curl -s -X POST ${apiBase}/api/tasks/${task.id}/complete -H 'Content-Type: application/json' -d '{"result": "brief summary of what you did"}'

If you cannot complete it:
curl -s -X POST ${apiBase}/api/tasks/${task.id}/fail -H 'Content-Type: application/json' -d '{"error": "what went wrong"}'`;
  const creatorAgent = task.creator_agent_id ? getAgent(task.creator_agent_id) : null;
  const creatorProfile = creatorAgent ? lookupProfile(creatorAgent.profile_id) : null;
  const creatorName = creatorProfile?.name || 'Unknown';
  const wrappedMessage = prefixMessage('task', `agent:${creatorName}`, taskBody);

  // Task event handler with cleanup logic
  const taskListener = (event: { event: string; data?: unknown; code?: number; message?: string }, managed: ManagedProcess) => {
    handleTaskEvent(event, managed, task, server, notifyTask);

    // Clean up listener on terminal states
    if (event.event === 'stdout') {
      const data = event.data as Record<string, unknown>;
      if (data?.type === 'result') {
        managed.taskEventListeners.delete(task.id);
      }
    }
    if (event.event === 'close' || event.event === 'error') {
      managed.taskEventListeners.delete(task.id);
    }
  };

  // sendMessage handles inject-if-alive and spawn-if-dead — one code path
  const result = await sendMessage({
    profileId: assigneeProfile.id,
    agentId: agent?.id,
    sessionId,
    message: wrappedMessage,
    taskId: task.id,
    onEvent: taskListener,
  });

  if (result.delivered) {
    server.log.info({ taskId: task.id, sessionId: result.sessionId, spawned: result.spawned, agentId: agent?.id }, '[task] message delivered');
    notifyTask('working', { status: 'Waiting for response...' });
    updateTaskState(task.id, 'working', { sessionId: result.sessionId });
    activeTaskBySession.set(result.sessionId, task.id);

    // Listen for session-result events (emitted when a result comes through)
    taskEvents.once(`session-result:${result.sessionId}`, (resultText: string) => {
      if (activeTaskBySession.get(result.sessionId) === task.id) {
        activeTaskBySession.delete(result.sessionId);
        const current = getTask(task.id);
        if (current && !TERMINAL_TASK_STATES.includes(current.state)) {
          server.log.info({ taskId: task.id, resultLength: resultText?.length }, '[task] completed via session-result');
          notifyTask('completed', { result: resultText });
          updateTaskState(task.id, 'completed', { result: resultText });
        }
      }
    });
  } else {
    server.log.error({ taskId: task.id, error: result.error, agentId: agent?.id }, '[task] delivery failed');
    notifyTask('failed', { error: result.error });
    updateTaskState(task.id, 'failed', { error: result.error || 'Delivery failed' });
  }
}

// --- Task-specific event handling ---

function handleTaskEvent(
  event: { event: string; data?: unknown; code?: number; message?: string },
  managed: ManagedProcess,
  task: Task,
  server: FastifyInstance,
  notifyTask: TaskNotify,
) {
  if (event.event === 'stdout') {
    const data = event.data as Record<string, unknown>;

    // Forward meaningful progress to creator
    forwardTaskProgress(data, task, notifyTask);

    // Task completed via result event
    if (data?.type === 'result') {
      const resultText = extractResultText(data);
      activeTaskBySession.delete(managed.sessionId);
      const current = getTask(task.id);
      if (current && !TERMINAL_TASK_STATES.includes(current.state)) {
        notifyTask('completed', { result: resultText });
        updateTaskState(task.id, 'completed', { result: resultText });
      }

      if (!task.keep_alive) {
        pmClient.kill(managed.pmSessionId).catch(() => { /* */ });
      }
    }
  }

  if (event.event === 'close') {
    const current = getTask(task.id);
    if (current && !TERMINAL_TASK_STATES.includes(current.state)) {
      if (event.code === 0) {
        notifyTask('completed', { result: current.result || '' });
        updateTaskState(task.id, 'completed', { result: current.result || '' });
      } else {
        const exitError = getExitMessage(event.code as number) || `Process exited with code ${event.code}`;
        notifyTask('failed', { error: exitError });
        updateTaskState(task.id, 'failed', { error: exitError });
      }
    }
  }

  if (event.event === 'error') {
    notifyTask('failed', { error: event.message || 'Unknown error' });
    updateTaskState(task.id, 'failed', { error: event.message || 'Unknown error' });
  }
}

// --- Task progress forwarding ---
// Extract meaningful events from the assignee's process and send to creator.

function forwardTaskProgress(
  data: Record<string, unknown>,
  task: Task,
  notifyTask: TaskNotify,
) {
  if (!data?.type) return;

  // Don't forward progress after task reaches terminal state
  const current = getTask(task.id);
  if (!current || TERMINAL_TASK_STATES.includes(current.state)) return;

  const progress: { event: string; summary: string; toolName?: string } | null = extractProgress(data);
  if (!progress) return;

  notifyTask('working', {
    type: 'task_progress',
    taskId: task.id,
    event: progress.event,
    summary: progress.summary,
    toolName: progress.toolName,
    timestamp: new Date().toISOString(),
  });
}

function extractProgress(data: Record<string, unknown>): { event: string; summary: string; toolName?: string } | null {
  // Tool use: "Reading src/db.ts" or "Running pnpm test"
  if (data.type === 'assistant') {
    const message = data.message as Record<string, unknown>;
    const content = message?.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content)) return null;

    for (const block of content) {
      if (block.type === 'tool_use') {
        const toolName = block.name as string;
        const input = block.input as Record<string, unknown> | undefined;
        const summary = summarizeToolUse(toolName, input);
        return { event: 'tool_use', summary, toolName };
      }
    }
    return null;
  }

  // Error events
  if (data.type === 'assistant' && data.isApiErrorMessage) {
    return { event: 'error', summary: 'API error' };
  }

  return null;
}

function summarizeToolUse(toolName: string, input?: Record<string, unknown>): string {
  if (!input) return toolName;

  // Common tool patterns
  switch (toolName) {
    case 'Read':
      return `Reading ${truncPath(input.file_path as string)}`;
    case 'Edit':
      return `Editing ${truncPath(input.file_path as string)}`;
    case 'Write':
      return `Writing ${truncPath(input.file_path as string)}`;
    case 'Bash':
      return `$ ${truncStr(input.command as string, 60)}`;
    case 'Grep':
      return `Searching: ${truncStr(input.pattern as string, 40)}`;
    case 'Glob':
      return `Finding: ${truncStr(input.pattern as string, 40)}`;
    case 'Agent':
      return `Agent: ${truncStr(input.description as string || input.prompt as string, 50)}`;
    case 'TodoWrite':
      return 'Updating task list';
    default:
      return toolName;
  }
}

function truncPath(path?: string): string {
  if (!path) return '?';
  // Show last 2 segments
  const parts = path.split('/');
  return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : path;
}

function truncStr(s?: string, max = 80): string {
  if (!s) return '';
  return s.length > max ? s.substring(0, max) + '...' : s;
}

// --- Notify task creator on terminal state (called from /complete and /fail endpoints) ---

function notifyTaskCreator(task: Task, state: 'completed' | 'failed', extra: { result?: string; error?: string }) {
  // Look up creator's session via agent → conversation
  const creatorAgent = task.creator_agent_id ? getAgent(task.creator_agent_id) : null;
  const creatorConv = creatorAgent ? getAgentConversation(creatorAgent.id) : null;
  const creatorSessionId = creatorConv?.session_id || null;

  // Look up assignee name via agent
  const assigneeAgent = task.assignee_agent_id ? getAgent(task.assignee_agent_id) : null;
  const assigneeProfile = assigneeAgent ? lookupProfile(assigneeAgent.profile_id) : null;
  const assigneeName = assigneeProfile?.name || assigneeAgent?.name || 'Agent';

  // Look up creator name via agent
  const creatorProfile = creatorAgent ? lookupProfile(creatorAgent.profile_id) : null;
  const creatorName = creatorProfile?.name || creatorAgent?.name || 'Unknown';

  // Resolve assignee's session for the Open button
  const assigneeConvForOpen = assigneeAgent ? getAgentConversation(assigneeAgent.id) : null;

  const eventData = {
    type: 'task_update',
    taskId: task.id,
    creator: creatorName,
    creatorIcon: creatorProfile?.icon,
    target: assigneeName,
    targetIcon: assigneeProfile?.icon,
    targetAgentId: task.assignee_agent_id,
    targetProfileId: assigneeProfile?.id,
    targetSessionId: assigneeConvForOpen?.session_id || null,
    state,
    message: task.message,
    ...extra,
  };

  // WebSocket notification to creator's browser
  if (creatorSessionId) {
    notifySession(creatorSessionId, eventData);
    storeSessionTaskEvent(creatorSessionId, task.id, 'task_update', eventData);
  }

  // WebSocket notification to assignee's browser
  const assigneeConv = assigneeAgent ? getAgentConversation(assigneeAgent.id) : null;
  const assigneeSessionId = assigneeConv?.session_id || null;
  if (assigneeSessionId && assigneeSessionId !== creatorSessionId) {
    const assigneeEventData = { ...eventData, isSelf: true };
    notifySession(assigneeSessionId, assigneeEventData);
    storeSessionTaskEvent(assigneeSessionId, task.id, 'task_update', assigneeEventData);
  }

  // Inject into creator's CLI process
  if (creatorAgent) {
    const resultSummary = extra.result
      ? String(extra.result).substring(0, 300)
      : (extra.error ? String(extra.error) : '');
    const verb = state === 'completed' ? 'completed' : 'failed';
    const injectMsg = prefixMessage('task-result', `agent:${assigneeName}`, `Task ${verb} by ${assigneeName}: ${resultSummary}`.trim());

    sendMessage({
      profileId: creatorAgent.profile_id,
      agentId: creatorAgent.id,
      message: injectMsg,
    }).catch(err => {
      logger.warn({ taskId: task.id, error: String(err) }, '[task] failed to inject completion notification into creator process');
    });
  }
}
