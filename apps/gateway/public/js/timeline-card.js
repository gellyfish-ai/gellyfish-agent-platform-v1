/**
 * Timeline card component — renders task progress visualization.
 * Layer 4: DOM rendering for task timeline cards.
 */

import { escapeHtml } from './utils.js';
import { getTaskData, ensureTaskData, fmtTime } from './tasks.js';

function truncate(text, max = 120) {
  if (!text || text.length <= max) return text || '';
  return text.substring(0, max) + '\u2026';
}

function getMessagesEl() {
  return document.getElementById('messages');
}

// --- Card creation ---

/** Get or create a timeline card for a task */
export function getOrCreateTimelineCard(taskId, agentName, agentIcon, targetSessionId, targetProfileId, targetAgentId) {
  const messagesEl = getMessagesEl();
  if (!messagesEl) return null;

  let card = messagesEl.querySelector(`[data-timeline-id="${taskId}"]`);
  if (card) return card;

  ensureTaskData(taskId, {
    agentName: agentName || 'Agent', entries: [], toolCount: 0,
    targetSessionId, targetProfileId, targetAgentId,
    creator: null, creatorIcon: null, targetIcon: null,
    message: null, state: 'working', result: null, error: null,
  });

  card = createCardElement(taskId, agentName, agentIcon);
  wireCardEvents(card, taskId, agentName, targetSessionId, targetProfileId, targetAgentId);
  messagesEl.appendChild(card);
  return card;
}

function createCardElement(taskId, agentName, agentIcon) {
  const card = document.createElement('div');
  card.className = 'timeline-card expanded';
  card.dataset.timelineId = taskId;

  const icon = agentIcon || '\uD83D\uDD17';
  const name = agentName || 'Agent';

  card.innerHTML = `
    <div class="timeline-header">
      <div class="timeline-agent-icon">${icon}</div>
      <div class="timeline-summary">
        <div class="title">${escapeHtml(name)}</div>
        <div class="subtitle"><span class="count">0 tool calls</span> \u00B7 <span class="tl-state">working</span></div>
      </div>
      <button class="timeline-info-btn" title="Task details">i</button>
      <button class="timeline-open-btn">Open</button>
      <div class="timeline-toggle">\u25BC</div>
    </div>
    <div class="timeline-body">
      <div class="task-goal"></div>
      <div class="tl-entries"></div>
      <div class="timeline-footer running"><span class="dot-pulse">\u25CF</span> Working\u2026</div>
    </div>
  `;
  return card;
}

function wireCardEvents(card, taskId, agentName, targetSessionId, targetProfileId, targetAgentId) {
  // Toggle expand/collapse
  card.querySelector('.timeline-header').addEventListener('click', (e) => {
    if (e.target.closest('.timeline-open-btn') || e.target.closest('.timeline-info-btn')) return;
    card.classList.toggle('expanded');
    card.classList.toggle('collapsed');
  });

  // Open button — navigate to agent's session
  const openBtn = card.querySelector('.timeline-open-btn');
  if (openBtn) {
    openBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await navigateToAgent(taskId, agentName, targetSessionId, targetProfileId, targetAgentId);
    });
  }

  // Info button
  const infoBtn = card.querySelector('.timeline-info-btn');
  if (infoBtn) {
    infoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTimelineDetailModal(taskId);
    });
  }
}

// --- Navigation ---

async function navigateToAgent(taskId, agentName, targetSessionId, targetProfileId, targetAgentId) {
  const stored = getTaskData(taskId);
  let sessionId = stored?.targetSessionId || targetSessionId;
  const profileId = stored?.targetProfileId || targetProfileId;
  const agentId = stored?.targetAgentId || targetAgentId;

  // Lookup agent data — prefer exact agent ID, fall back to profile_id
  let agent = null;
  if (agentId || profileId) {
    try {
      const resp = await fetch('/api/agents');
      const agentData = await resp.json();
      agent = (agentData.agents || []).find(a =>
        agentId ? a.id === agentId : a.profile_id === profileId
      );
      if (agent?.session_id && !sessionId) sessionId = agent.session_id;
    } catch { /* fall through */ }
  }

  // iOS native bridge
  if (window.gellyfish?._nativeApp && sessionId) {
    window.webkit?.messageHandlers?.gellyfish?.postMessage({
      action: 'openSession', sessionId,
      agentName: agentName || 'Agent', agentIcon: '',
    });
    return;
  }

  if (agent) {
    const tabs = await import('./tabs.js');
    const existing = tabs.findTabByAgentId(agent.id) || (sessionId && tabs.findTabBySessionId(sessionId));
    if (existing) {
      tabs.switchTab(existing.id);
    } else {
      tabs.openAgentTab(agent);
      tabs.showChatView();
      if (agent.session_id) {
        const { loadHistoryAndConnect } = await import('./session-manager.js');
        loadHistoryAndConnect(agent.session_id);
      }
    }
  } else if (sessionId) {
    const { findTabBySessionId, switchTab, openSessionTab } = await import('./tabs.js');
    const existing = findTabBySessionId(sessionId);
    if (existing) { switchTab(existing.id); }
    else { openSessionTab(sessionId, agentName || 'Agent'); }
  } else if (profileId) {
    const resp = await fetch('/api/profiles');
    const d = await resp.json();
    const profile = (d.profiles || []).find(p => p.id === profileId);
    if (profile) {
      const m = await import('./session-manager.js');
      m.startProfileSession(profile);
    }
  }
}

// --- Timeline entries ---

/** Shared factory for creating timeline entries */
function createTimelineEntry(entries, dotClass, agentLabel, contentHtml, timestamp) {
  // Fix rail on previous last entry
  const prevEntries = entries.querySelectorAll('.tl-entry');
  if (prevEntries.length > 0) {
    const prevLine = prevEntries[prevEntries.length - 1].querySelector('.tl-line');
    if (prevLine) prevLine.style.background = '#252540';
  }

  const entry = document.createElement('div');
  entry.className = 'tl-entry';
  entry.innerHTML = `
    <div class="tl-rail"><div class="tl-dot ${dotClass}"></div><div class="tl-line"></div></div>
    <div class="tl-content"><div class="tl-agent ${dotClass}">${escapeHtml(agentLabel)}</div><div class="tl-text">${contentHtml}</div></div>
    <div class="tl-time">${fmtTime(timestamp)}</div>
  `;
  entries.appendChild(entry);
}

/** Append a progress entry (tool use) to a timeline card */
export function appendTimelineProgress(data) {
  const card = getOrCreateTimelineCard(data.taskId, data.agentName, data.agentIcon);
  const entries = card?.querySelector('.tl-entries');
  if (!entries) return;

  const stored = getTaskData(data.taskId);
  if (stored) {
    stored.entries.push(data);
    stored.toolCount++;
    const countEl = card.querySelector('.count');
    if (countEl) countEl.textContent = `${stored.toolCount} tool call${stored.toolCount !== 1 ? 's' : ''}`;
  }

  const toolTag = data.toolName ? ` <span class="tool-tag">${escapeHtml(data.toolName)}</span>` : '';
  createTimelineEntry(entries, 'assignee', data.agentName || 'Agent', escapeHtml(data.summary || '') + toolTag, data.timestamp);
}

/** Append a coordinator response to a timeline card. Returns true if card exists. */
export function appendTimelineResponse(taskId, text) {
  const messagesEl = getMessagesEl();
  if (!messagesEl) return false;

  const card = messagesEl.querySelector(`[data-timeline-id="${taskId}"]`);
  if (!card) return false;

  const entries = card.querySelector('.tl-entries');
  if (!entries) return false;

  createTimelineEntry(entries, 'coord', 'Coordinator', `<span class="response">${escapeHtml(text)}</span>`, new Date().toISOString());
  return true;
}

// --- Goal display ---

/** Update the task goal/result summary at the top of the card */
export function updateTaskGoal(taskId) {
  const messagesEl = getMessagesEl();
  if (!messagesEl) return;
  const card = messagesEl.querySelector(`[data-timeline-id="${taskId}"]`);
  if (!card) return;
  const goalEl = card.querySelector('.task-goal');
  if (!goalEl) return;

  const stored = getTaskData(taskId);
  if (!stored) return;

  if (stored.state === 'completed' && stored.result) {
    goalEl.textContent = truncate(stored.result);
    goalEl.className = 'task-goal completed';
  } else if (stored.state === 'failed' && stored.error) {
    goalEl.textContent = truncate(stored.error);
    goalEl.className = 'task-goal failed';
  } else if (stored.message) {
    const firstLine = stored.message.split('\n')[0];
    goalEl.textContent = truncate(firstLine);
    goalEl.className = 'task-goal';
  }
}

// --- State updates ---

/** Mark a timeline card as completed/failed */
export function updateTimelineCardState(taskId, taskState, result, error) {
  const messagesEl = getMessagesEl();
  if (!messagesEl) return;

  const card = messagesEl.querySelector(`[data-timeline-id="${taskId}"]`);
  if (!card) return;

  const stored = getTaskData(taskId);
  if (stored) {
    stored.state = taskState;
    if (result) stored.result = result;
    if (error) stored.error = error;
  }

  const stateEl = card.querySelector('.tl-state');
  if (stateEl) stateEl.textContent = taskState;

  updateTaskGoal(taskId);

  const footer = card.querySelector('.timeline-footer');
  if (footer) {
    footer.classList.remove('running');
    const isError = taskState === 'failed' || taskState === 'canceled';
    if (isError) {
      footer.style.color = '#ef4444';
      footer.textContent = `\u274C ${taskState === 'failed' ? 'Failed' : 'Canceled'}${error ? ': ' + error.substring(0, 100) : ''}`;
    } else {
      footer.textContent = `\u2713 ${result ? result.substring(0, 120) : 'Completed'}`;
    }
  }

  card.classList.remove('expanded');
  card.classList.add('collapsed');
}

// --- Detail modal ---

/** Show task details in the tool-detail modal */
export async function openTimelineDetailModal(taskId) {
  const titleEl = document.getElementById('tool-detail-title');
  const contentEl = document.getElementById('tool-detail-content');
  if (!titleEl || !contentEl) return;

  let stored = getTaskData(taskId);

  if (!stored?.message || !stored?.creator) {
    try {
      const resp = await fetch('/api/tasks/' + taskId);
      const taskData = await resp.json();
      const task = taskData.task || taskData;
      if (task && stored) {
        if (task.message) stored.message = task.message;
        if (task.state) stored.state = task.state;
        if (task.result) stored.result = task.result;
        if (task.error) stored.error = task.error;
        if (task.assigneeName) stored.agentName = task.assigneeName;
        if (task.creatorName) stored.creator = task.creatorName;
        if (task.creatorIcon) stored.creatorIcon = task.creatorIcon;
        if (task.assigneeIcon) stored.targetIcon = task.assigneeIcon;
      } else if (task) {
        stored = {
          agentName: task.assigneeName || task.target || 'Agent',
          creator: task.creatorName || null,
          creatorIcon: task.creatorIcon || null,
          targetIcon: task.assigneeIcon || null,
          message: task.message, state: task.state, result: task.result, error: task.error,
        };
      }
    } catch { /* use what we have */ }
  }

  if (!stored) return;

  titleEl.textContent = (stored.creator || 'Unknown') + ' \u2192 ' + (stored.agentName || 'Agent');
  contentEl.innerHTML = buildDetailHtml(taskId, stored);
  document.getElementById('tool-detail-modal').classList.add('open');
}

function buildDetailHtml(taskId, stored) {
  let html = '';

  if (stored.creator || stored.agentName) {
    html += '<div class="tool-detail-section"><label>Participants</label>';
    html += '<div class="tool-detail-body">';
    if (stored.creator) html += '<div>' + (stored.creatorIcon || '') + ' <strong>From:</strong> ' + escapeHtml(stored.creator) + '</div>';
    if (stored.agentName) html += '<div>' + (stored.targetIcon || '') + ' <strong>To:</strong> ' + escapeHtml(stored.agentName) + '</div>';
    html += '</div></div>';
  }

  const stateClass = stored.state || 'working';
  html += '<div class="tool-detail-section"><label>Status</label>';
  html += '<div class="tool-detail-body"><span class="status-badge ' + stateClass + '">' + stateClass + '</span>';
  html += ' <code style="font-size:0.7rem;color:var(--text-muted)">' + escapeHtml(taskId.substring(0, 8)) + '</code></div></div>';

  if (stored.message) {
    html += '<div class="tool-detail-section"><label>Message</label>';
    html += '<div class="tool-detail-body tool-detail-terminal">' + escapeHtml(stored.message) + '</div></div>';
  }

  if (stored.entries && stored.entries.length > 0) {
    const lines = stored.entries.map(evt => {
      const time = evt.timestamp ? fmtTime(evt.timestamp) : '';
      return time + ' ' + (evt.summary || evt.event || '');
    }).join('\n');
    html += '<div class="tool-detail-section"><label>Progress (' + stored.entries.length + ')</label>';
    html += '<div class="tool-detail-body tool-detail-terminal">' + escapeHtml(lines) + '</div></div>';
  }

  if (stored.result) {
    html += '<div class="tool-detail-section"><label>Result</label>';
    html += '<div class="tool-detail-body">' + escapeHtml(stored.result) + '</div></div>';
  }

  if (stored.error) {
    html += '<div class="tool-detail-section"><label>Error</label>';
    html += '<div class="tool-detail-body error">' + escapeHtml(stored.error) + '</div></div>';
  }

  return html;
}

// --- Task bubbles (receiver-side compact rendering) ---

/** Create an inbound task bubble for the receiver's conversation */
export function createTaskReceivedBubble(source, content) {
  const creatorName = source.replace(/^agent:/, '');
  const taskMatch = content.match(/^\[Task ([0-9a-f-]+)\]\s*([\s\S]*)/);
  const taskId = taskMatch?.[1] || '';
  const messageBody = taskMatch?.[2] || content;
  const firstLine = messageBody.split('\n')[0].substring(0, 80);

  const bubble = document.createElement('div');
  bubble.className = 'task-bubble';
  bubble.innerHTML = `
    <span class="task-bubble-icon">\uD83D\uDCCB</span>
    <div class="task-bubble-text">
      <div class="task-bubble-title">Task received from ${escapeHtml(creatorName)}</div>
      <div class="task-bubble-preview">${escapeHtml(firstLine)}${firstLine.length < messageBody.split('\n')[0].length ? '\u2026' : ''}</div>
    </div>
  `;

  bubble.addEventListener('click', () => {
    showTaskBubbleModal('Task from ' + creatorName, taskId, messageBody);
  });

  return bubble;
}

/** Create a task result bubble for the receiver's conversation */
export function createTaskResultBubble(source, content) {
  const agentName = source.replace(/^agent:/, '');
  const isCompleted = content.toLowerCase().includes('completed');
  const icon = isCompleted ? '\u2705' : '\u274C';
  const preview = content.substring(0, 100);

  const bubble = document.createElement('div');
  bubble.className = 'task-bubble';
  bubble.innerHTML = `
    <span class="task-bubble-icon">${icon}</span>
    <div class="task-bubble-text">
      <div class="task-bubble-title">Task ${isCompleted ? 'completed' : 'update'}</div>
      <div class="task-bubble-preview">${escapeHtml(preview)}${content.length > 100 ? '\u2026' : ''}</div>
    </div>
  `;

  bubble.addEventListener('click', () => {
    showTaskBubbleModal('Task Result', '', content);
  });

  return bubble;
}

function showTaskBubbleModal(title, taskId, body) {
  const titleEl = document.getElementById('tool-detail-title');
  const contentEl = document.getElementById('tool-detail-content');
  if (!titleEl || !contentEl) return;

  titleEl.textContent = title;
  let html = '';
  if (taskId) {
    html += '<div class="tool-detail-section"><label>Task ID</label>';
    html += '<div class="tool-detail-body"><code>' + escapeHtml(taskId.substring(0, 8)) + '</code></div></div>';
  }
  html += '<div class="tool-detail-section"><label>Message</label>';
  html += '<div class="tool-detail-body tool-detail-terminal">' + escapeHtml(body) + '</div></div>';
  contentEl.innerHTML = html;
  document.getElementById('tool-detail-modal').classList.add('open');
}

// --- Replay ---

/** Fetch and replay stored task events for a session */
export async function replayTaskEvents(sessionId) {
  try {
    const resp = await fetch(`/api/sessions/${sessionId}/task-events`);
    const data = await resp.json();
    const events = data.events || [];
    if (events.length === 0) return;

    for (const event of events) {
      const eventData = event.data;
      if (!eventData || !eventData.taskId) continue;

      if (event.event_type === 'task_update') {
        getOrCreateTimelineCard(eventData.taskId, eventData.target, eventData.targetIcon, eventData.targetSessionId, eventData.targetProfileId, eventData.targetAgentId);
        const stored = getTaskData(eventData.taskId);
        if (stored) {
          if (eventData.message) stored.message = eventData.message;
          if (eventData.state) stored.state = eventData.state;
          if (eventData.result) stored.result = eventData.result;
          if (eventData.error) stored.error = eventData.error;
          if (eventData.creator) stored.creator = eventData.creator;
          if (eventData.creatorIcon) stored.creatorIcon = eventData.creatorIcon;
          if (eventData.targetIcon) stored.targetIcon = eventData.targetIcon;
          if (eventData.targetAgentId) stored.targetAgentId = eventData.targetAgentId;
        }
        if (['completed', 'failed', 'canceled'].includes(eventData.state)) {
          updateTimelineCardState(eventData.taskId, eventData.state, eventData.result, eventData.error);
        } else {
          updateTaskGoal(eventData.taskId);
        }
      } else if (event.event_type === 'task_progress') {
        appendTimelineProgress({
          taskId: eventData.taskId,
          agentName: eventData.agentName || eventData.target,
          agentIcon: eventData.agentIcon || eventData.targetIcon,
          summary: eventData.summary || eventData.event || '',
          toolName: eventData.toolName,
          timestamp: eventData.timestamp,
        });
      }
    }
  } catch {
    // Non-critical — timeline cards just won't show on reload
  }
}
