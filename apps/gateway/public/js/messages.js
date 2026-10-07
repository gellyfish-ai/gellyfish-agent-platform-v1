import state, { setProcessing } from './state.js';
import { escapeHtml, pushUrl, urlFor, getToolIcon, renderMarkdown, addCopyButtons, truncate } from './utils.js';
import { connLog, cancelProcessing } from './connection.js';
import { updateActiveTabSessionId } from './tabs.js';
import { attachReactionToMessage } from './reactions.js';
import { getTaskData } from './tasks.js';
import {
  getOrCreateTimelineCard, appendTimelineProgress, appendTimelineResponse,
  updateTimelineCardState, updateTaskGoal, replayTaskEvents,
  createTaskReceivedBubble, createTaskResultBubble,
} from './timeline-card.js';

// Re-export for consumers that import from messages.js
export { replayTaskEvents };

let messagesEl = null;
let inputEl = null;

export function initMessages() {
  messagesEl = document.getElementById('messages');
  inputEl = document.getElementById('message-input');

  if (!messagesEl) return;

  // Pending approvals badge — scroll to first pending card on click
  const pendingBtn = document.getElementById('pending-approvals-btn');
  if (pendingBtn) {
    pendingBtn.addEventListener('click', () => {
      const firstPending = messagesEl.querySelector('.approval-card:not(.resolved)');
      if (firstPending) firstPending.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // Scroll-to-bottom button
  const scrollBtn = document.createElement('button');
  scrollBtn.id = 'scroll-to-bottom';
  scrollBtn.innerHTML = '&#x2193;';
  scrollBtn.title = 'Scroll to bottom';
  scrollBtn.addEventListener('click', () => {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
  });
  messagesEl.parentElement.appendChild(scrollBtn);

  let userScrolledUp = false;
  let lastScrollTop = 0;

  messagesEl.addEventListener('scroll', () => {
    const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    scrollBtn.classList.toggle('visible', distFromBottom > 100);

    // Detect explicit upward scroll by user (not programmatic)
    if (messagesEl.scrollTop < lastScrollTop && distFromBottom > 200) {
      userScrolledUp = true;
    }
    // User scrolled back to bottom
    if (distFromBottom <= 100) {
      userScrolledUp = false;
      const indicator = document.getElementById('new-message-indicator');
      if (indicator) indicator.classList.remove('visible');
    }
    lastScrollTop = messagesEl.scrollTop;
  });

  // Auto-scroll via MutationObserver
  let newMessageIndicator = null;

  function getOrCreateIndicator() {
    if (!newMessageIndicator) {
      newMessageIndicator = document.createElement('button');
      newMessageIndicator.id = 'new-message-indicator';
      newMessageIndicator.innerHTML = '\u2193 New messages';
      newMessageIndicator.addEventListener('click', () => {
        messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
        newMessageIndicator.classList.remove('visible');
        userScrolledUp = false;
      });
      messagesEl.parentElement.appendChild(newMessageIndicator);
    }
    return newMessageIndicator;
  }

  const scrollObserver = new MutationObserver((mutations) => {
    // Only treat as "new messages" if actual element nodes were added
    const hasNewContent = mutations.some(m =>
      m.type === 'childList' && m.addedNodes.length > 0 &&
      Array.from(m.addedNodes).some(n => n.nodeType === 1)
    );

    if (!userScrolledUp) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (hasNewContent) {
      getOrCreateIndicator().classList.add('visible');
    }
  });
  scrollObserver.observe(messagesEl, { childList: true, subtree: true, characterData: true });

  // #358: Keyboard resize — stay at bottom if user hasn't scrolled up
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (!userScrolledUp) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    });
  }
}

// Agent lifecycle callbacks — set by app.js
let _onActiveAgents = null;
let _onAgentHired = null;
let _onAgentFired = null;
export function setAgentCallbacks({ onActiveAgents, onAgentHired, onAgentFired }) {
  _onActiveAgents = onActiveAgents;
  _onAgentHired = onAgentHired;
  _onAgentFired = onAgentFired;
}
export function clearEmptyState() {
  if (!messagesEl) return;
  const emptyState = messagesEl.querySelector('.empty-state');
  if (emptyState) emptyState.remove();
}

// Track last rendered timestamp for grouping
let lastRenderedTimestamp = 0;
const TIMESTAMP_GAP_MS = 5 * 60 * 1000; // 5 minutes

function formatMessageTime(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay) return time;
  return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ', ' + time;
}

/** Parse GAP message protocol prefix: [GAP/<type> from:<source>] <content> */
function parseGapPrefix(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/^\[GAP\/([a-z-]+)\s+from:([^\]]+)\]\s*([\s\S]*)$/);
  if (!match) return null;
  return { type: match[1], source: match[2], content: match[3] };
}

/** Render a GAP-prefixed message as a compact notification */
function renderGapNotification(parsed) {
  const div = document.createElement('div');

  if (parsed.type === 'task') {
    const bubble = createTaskReceivedBubble(parsed.source, parsed.content);
    messagesEl.appendChild(bubble);
    return bubble;
  }

  div.className = 'gap-notification';

  if (parsed.type === 'system') {
    div.classList.add('gap-system');
    div.innerHTML = '<span class="gap-label">SYSTEM</span> ' + escapeHtml(parsed.content);
  } else if (parsed.type === 'task-result') {
    const bubble = createTaskResultBubble(parsed.source, parsed.content);
    messagesEl.appendChild(bubble);
    return bubble;
  } else if (parsed.type === 'reaction') {
    div.classList.add('gap-reaction');
    div.textContent = parsed.content;
  } else {
    // Unknown type — fall through to normal rendering
    return null;
  }

  messagesEl.appendChild(div);
  return div;
}

export function addMessage(content, role, isError = false, messageId = null, timestamp = null) {
  if (!messagesEl) return;
  clearEmptyState();

  // Detect GAP-prefixed messages and render as compact notifications
  if (role === 'user' && typeof content === 'string') {
    const parsed = parseGapPrefix(content);
    if (parsed) {
      const notification = renderGapNotification(parsed);
      if (notification) return notification;
      // task type falls through to normal rendering with cleaned content
      content = parsed.content;
    }
  }

  const div = document.createElement('div');
  div.className = `message ${role}`;
  if (isError) div.classList.add('error');
  div.dataset.messageId = messageId || `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (timestamp) div.dataset.timestamp = timestamp;

  if (role === 'assistant' && content) {
    div.innerHTML = renderMarkdown(typeof content === 'string' ? content : '');
    addCopyButtons(div);
  } else if (Array.isArray(content)) {
    // Content blocks (text + images)
    for (const block of content) {
      if (block.type === 'image' && block.source?.data) {
        const img = document.createElement('img');
        img.src = `data:${block.source.media_type || 'image/png'};base64,${block.source.data}`;
        img.className = 'message-image';
        import('./image-modal.js').then(m => m.makeImageClickable(img, 'image.png'));
        div.appendChild(img);
      } else if (block.type === 'text' && block.text) {
        const textEl = document.createElement('span');
        textEl.textContent = block.text;
        div.appendChild(textEl);
      }
    }
  } else if (role === 'user' && typeof content === 'string' && content.startsWith('> [Replying to')) {
    // Render quoted text as a styled block above the user's message
    const newlineIdx = content.indexOf('\n\n');
    if (newlineIdx > 0) {
      const quoteLine = content.substring(0, newlineIdx);
      const userText = content.substring(newlineIdx + 2);
      // Extract just the quoted text from: > [Replying to role]: "text"
      const quoteMatch = quoteLine.match(/^> \[Replying to \w+\]: "(.+)"$/);
      const quoteBlock = document.createElement('div');
      quoteBlock.className = 'message-quote';
      quoteBlock.textContent = quoteMatch ? quoteMatch[1] : quoteLine.substring(2);
      div.appendChild(quoteBlock);
      const textEl = document.createElement('span');
      textEl.textContent = userText;
      div.appendChild(textEl);
    } else {
      div.textContent = content;
    }
  } else {
    div.textContent = content;
  }

  // Render timestamp if there's a 5+ minute gap since last message
  if (timestamp) {
    const tsMs = new Date(timestamp).getTime();
    if (!isNaN(tsMs) && (tsMs - lastRenderedTimestamp >= TIMESTAMP_GAP_MS || lastRenderedTimestamp === 0)) {
      const tsEl = document.createElement('span');
      tsEl.className = 'message-timestamp';
      tsEl.textContent = formatMessageTime(timestamp);
      div.appendChild(tsEl);
      lastRenderedTimestamp = tsMs;
    }
  }

  // Reply button (hover-visible)
  const replyBtn = document.createElement('button');
  replyBtn.className = 'reply-btn';
  replyBtn.innerHTML = '\u21A9';
  replyBtn.title = 'Reply';
  replyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    import('./quote.js').then(m => m.setQuoteTarget(div));
  });
  div.appendChild(replyBtn);

  messagesEl.appendChild(div);
  // Only attach reactions for non-streaming messages (user messages, history).
  // Streaming assistant messages get reactions re-attached in the 'result' handler
  // after innerHTML updates are complete.
  if (role !== 'assistant') {
    attachReactionToMessage(div);
  }
  return div;
}

let thinkingStart = 0;
let thinkingTimer = null;
let thinkingDebounce = null; // debounce for post-tool-result re-show

function showThinkingNow() {
  if (!messagesEl || state.thinkingEl) return;
  thinkingStart = Date.now();
  state.thinkingEl = document.createElement('div');
  state.thinkingEl.className = 'thinking-indicator';
  state.thinkingEl.title = 'Click to stop';
  state.thinkingEl.innerHTML = `Thinking <span class="thinking-elapsed">0s</span> <span class="thinking-dots"><span></span><span></span><span></span></span>`;
  state.thinkingEl.addEventListener('click', cancelProcessing);
  messagesEl.appendChild(state.thinkingEl);

  const elapsedEl = state.thinkingEl.querySelector('.thinking-elapsed');
  thinkingTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - thinkingStart) / 1000);
    elapsedEl.textContent = `${seconds}s`;
  }, 1000);
}

/** Show thinking immediately (e.g. user just sent a message). */
export function showThinking() {
  cancelThinkingDebounce();
  hideThinkingNow();
  showThinkingNow();
}

/** Schedule thinking indicator after a delay (e.g. after tool_result).
 *  If real content arrives before the delay fires, it gets cancelled. */
export function showThinkingDeferred() {
  cancelThinkingDebounce();
  thinkingDebounce = setTimeout(() => {
    thinkingDebounce = null;
    if (state.isProcessing && !state.thinkingEl) showThinkingNow();
  }, 400);
}

function cancelThinkingDebounce() {
  if (thinkingDebounce) { clearTimeout(thinkingDebounce); thinkingDebounce = null; }
}

function hideThinkingNow() {
  if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
  if (state.thinkingEl) {
    state.thinkingEl.remove();
    state.thinkingEl = null;
  }
}

export function hideThinking() {
  cancelThinkingDebounce();
  hideThinkingNow();
}

function showCostInfo(cost, usage) {
  const existing = document.querySelector('.cost-info');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.className = 'cost-info';

  const elapsed = thinkingStart ? Math.round((Date.now() - thinkingStart) / 1000) : 0;
  const parts = [];
  if (elapsed > 0) parts.push(`${elapsed}s`);
  if (usage) {
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    parts.push(`${input + output} tokens`);
  }
  parts.push(`$${cost.toFixed(4)}`);
  parts.push(`total: $${state.totalCost.toFixed(4)}`);

  div.textContent = parts.join(' · ');
  messagesEl.appendChild(div);
}

// No-op: the unified tab-info modal reads live data when opened
export function updateModalInfo() {}

// --- Permission handling ---

function respondPermission(requestId, approved, inputOverride) {
  const prompt = document.querySelector(`[data-request-id="${requestId}"]`);
  let toolInput = inputOverride || {};
  if (!inputOverride && prompt) {
    prompt.classList.add('resolved', approved ? 'approved' : 'denied');
    try { toolInput = JSON.parse(prompt.dataset.toolInput || '{}'); } catch {}
  }

  const statusRow = document.querySelector(`.pending-status[data-request-id="${requestId}"]`);
  if (statusRow) {
    const val = statusRow.querySelector('.tool-detail-value');
    if (val) {
      val.className = 'tool-detail-value ' + (approved ? 'approved' : 'denied');
      val.textContent = approved ? '\u2713 approved' : '\u2717 denied';
    }
  }

  state.ws.send(JSON.stringify({
    type: 'permission_response',
    requestId,
    approved,
    input: toolInput,
  }));
}

// --- Approval cards ---

const approvalTimers = new Map(); // approvalId -> intervalId

function updatePendingApprovalsBadge() {
  const btn = document.getElementById('pending-approvals-btn');
  const countEl = document.getElementById('pending-approvals-count');
  if (!btn || !countEl) return;
  const count = messagesEl ? messagesEl.querySelectorAll('.approval-card:not(.resolved)').length : 0;
  if (count > 0) {
    countEl.textContent = String(count);
    btn.style.display = 'flex';
  } else {
    btn.style.display = 'none';
  }
}

function showApprovalCard(data) {
  // Dedupe: skip if card already exists (hydrate + WebSocket replay can both fire)
  if (messagesEl.querySelector(`[data-approval-id="${data.id}"]`)) return;

  const card = document.createElement('div');
  card.className = 'approval-card';
  card.dataset.approvalId = data.id;

  // Approvals can only be answered by the paired iOS device (cryptographic
  // signing). The browser has no way to produce a valid signature, so the
  // in-session card is read-only — it shows a pending indicator and
  // clears itself on the approval_resolved WebSocket event.
  // Identity fields land via gateway broadcast (#658) so the web UI matches
  // the iOS card. Defaults below mirror buildApprovalIdentityPayload — if
  // they ever appear, the gateway forgot to populate the field.
  const agentName = data.agentName || '(unknown agent)';
  const profileName = data.profileName || '(unknown profile)';
  const tool = data.tool || `${data.mcpName || '(unknown mcp)'}: ${data.toolName || '(unknown tool)'}`;
  const summary = data.summary || data.humanPreview || tool;
  card.innerHTML = `
    <div class="approval-header">
      <span class="approval-icon">\uD83D\uDD10</span>
      <span class="approval-title">Approval Required</span>
      <span class="approval-timer"></span>
    </div>
    <div class="approval-identity">
      <span class="approval-agent">${escapeHtml(agentName)}</span>
      <span class="approval-profile">(${escapeHtml(profileName)})</span>
    </div>
    <div class="approval-tool">${escapeHtml(tool)}</div>
    <div class="approval-preview">${escapeHtml(summary)}</div>
    <div class="approval-actions">
      <span class="approval-pending">\u23F3 Awaiting approval on paired device</span>
      <button class="approval-deny-btn" data-approval-id="${escapeHtml(data.id)}">Deny</button>
    </div>
  `;

  card.querySelector('.approval-deny-btn')?.addEventListener('click', () => denyApproval(data.id));
  messagesEl.appendChild(card);
  startApprovalTimer(card, data.expiresAt, data.id);
  updatePendingApprovalsBadge();
}

function startApprovalTimer(card, expiresAt, approvalId) {
  const timerEl = card.querySelector('.approval-timer');
  if (!timerEl || !expiresAt) return;

  const update = () => {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt + 'Z').getTime() - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    timerEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
    if (remaining <= 0) {
      resolveApprovalCard(approvalId, 'expired');
    }
  };

  update();
  const intervalId = setInterval(update, 1000);
  approvalTimers.set(approvalId, intervalId);
}

function resolveApprovalCard(approvalId, resolvedState) {
  const card = messagesEl?.querySelector(`[data-approval-id="${approvalId}"]`);
  if (!card || card.classList.contains('resolved')) return;

  // Stop timer
  const timerId = approvalTimers.get(approvalId);
  if (timerId) { clearInterval(timerId); approvalTimers.delete(approvalId); }

  // Update card
  card.classList.add('resolved', resolvedState);
  const actions = card.querySelector('.approval-actions');
  if (actions) actions.remove();
  const timerEl = card.querySelector('.approval-timer');
  if (timerEl) {
    const labels = { approved: '\u2705 Approved', rejected: '\u274C Rejected', expired: '\u23F0 Expired' };
    timerEl.textContent = labels[resolvedState] || resolvedState;
  }
  updatePendingApprovalsBadge();
}

async function denyApproval(approvalId) {
  try {
    const res = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}/deny`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error('[approval] deny failed:', body.error || res.status);
    }
    // UI update happens via the approval_resolved WebSocket event
  } catch (err) {
    console.error('[approval] deny request failed:', err);
  }
}

function showAskUserQuestion(data) {
  clearEmptyState();
  state.currentAssistantMsg = null; // End current assistant message

  const container = document.createElement('div');
  container.className = 'ask-user-question';

  // Handle both formats: {questions: [...]} (new) and {question, options} (legacy)
  const questions = Array.isArray(data.input.questions)
    ? data.input.questions
    : [{ question: data.input.question, options: data.input.options }];

  for (const q of questions) {
    if (q.header) {
      const headerEl = document.createElement('div');
      headerEl.className = 'ask-user-header';
      headerEl.textContent = q.header;
      container.appendChild(headerEl);
    }

    const questionEl = document.createElement('div');
    questionEl.className = 'ask-user-question-text';
    questionEl.textContent = q.question || 'What would you like to do?';
    container.appendChild(questionEl);

    const options = q.options;
    if (!Array.isArray(options) || options.length === 0) continue;

    const btnContainer = document.createElement('div');
    btnContainer.className = 'ask-user-options';
    for (const option of options) {
      const label = typeof option === 'string' ? option : (option.label || option.value || String(option));
      const value = typeof option === 'string' ? option : (option.value || option.label || String(option));

      const btn = document.createElement('button');
      btn.className = 'ask-user-option-btn';
      const labelSpan = document.createElement('span');
      labelSpan.className = 'ask-user-option-label';
      labelSpan.textContent = label;
      btn.appendChild(labelSpan);
      if (typeof option === 'object' && option.description) {
        const desc = document.createElement('span');
        desc.className = 'ask-user-option-desc';
        desc.textContent = option.description;
        btn.appendChild(desc);
      }
      btn.addEventListener('click', () => {
        btnContainer.querySelectorAll('button').forEach(b => { b.disabled = true; });
        btn.classList.add('selected');
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          addMessage(value, 'user', false, null, new Date().toISOString());
          state.messageCount++;
          state.userMessageCount++;
          state.ws.send(JSON.stringify({ type: 'user_message', content: value }));
        }
      });
      btnContainer.appendChild(btn);
    }
    container.appendChild(btnContainer);
  }

  messagesEl.appendChild(container);
}

/** Show AskUserQuestion as a question UI when it arrives as a permission_request */
function showAskUserQuestionPermission(data) {
  clearEmptyState();
  if (state.currentAssistantMsg) {
    state.currentAssistantMsg.classList.remove('streaming');
    state.currentAssistantMsg = null;
  }

  const input = data.input || {};
  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length === 0) return;

  const container = document.createElement('div');
  container.className = 'ask-user-question';

  for (const q of questions) {
    // Header tag
    if (q.header) {
      const headerEl = document.createElement('div');
      headerEl.className = 'ask-user-header';
      headerEl.textContent = q.header;
      container.appendChild(headerEl);
    }

    // Question text
    const questionEl = document.createElement('div');
    questionEl.className = 'ask-user-question-text';
    questionEl.textContent = q.question || 'What would you like to do?';
    container.appendChild(questionEl);

    const options = q.options;
    if (!Array.isArray(options) || options.length === 0) continue;

    if (q.multiSelect) {
      // Multi-select: checkboxes + Submit button
      const optContainer = document.createElement('div');
      optContainer.className = 'ask-user-options multi';
      for (const opt of options) {
        const optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || String(opt));
        const optDesc = typeof opt === 'object' ? opt.description : null;
        const label = document.createElement('label');
        label.className = 'ask-user-checkbox';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = optLabel;
        label.appendChild(cb);
        const textSpan = document.createElement('span');
        textSpan.className = 'ask-user-option-label';
        textSpan.textContent = optLabel;
        label.appendChild(textSpan);
        if (optDesc) {
          const desc = document.createElement('span');
          desc.className = 'ask-user-option-desc';
          desc.textContent = opt.description;
          label.appendChild(desc);
        }
        optContainer.appendChild(label);
      }
      const submitBtn = document.createElement('button');
      submitBtn.className = 'ask-user-option-btn submit';
      submitBtn.textContent = 'Submit';
      submitBtn.addEventListener('click', () => {
        const selected = Array.from(optContainer.querySelectorAll('input:checked')).map(cb => cb.value);
        if (selected.length === 0) return;
        optContainer.querySelectorAll('input').forEach(cb => { cb.disabled = true; });
        submitBtn.disabled = true;
        addMessage(selected.join(', '), 'user', false, null, new Date().toISOString());
        input.answers = input.answers || {};
        input.answers[q.question] = selected.join(', ');
        respondPermission(data.requestId, true, input);
      });
      optContainer.appendChild(submitBtn);
      container.appendChild(optContainer);
    } else {
      // Single-select: clicking an option submits immediately
      const btnContainer = document.createElement('div');
      btnContainer.className = 'ask-user-options';
      for (const opt of options) {
        const optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || String(opt));
        const optDesc = typeof opt === 'object' ? opt.description : null;
        const btn = document.createElement('button');
        btn.className = 'ask-user-option-btn';
        const labelSpan = document.createElement('span');
        labelSpan.className = 'ask-user-option-label';
        labelSpan.textContent = optLabel;
        btn.appendChild(labelSpan);
        if (optDesc) {
          const desc = document.createElement('span');
          desc.className = 'ask-user-option-desc';
          desc.textContent = optDesc;
          btn.appendChild(desc);
        }
        btn.addEventListener('click', () => {
          btnContainer.querySelectorAll('button').forEach(b => { b.disabled = true; });
          btn.classList.add('selected');
          addMessage(optLabel, 'user', false, null, new Date().toISOString());
          input.answers = input.answers || {};
          input.answers[q.question] = optLabel;
          respondPermission(data.requestId, true, input);
        });
        btnContainer.appendChild(btn);
      }
      container.appendChild(btnContainer);
    }
  }

  messagesEl.appendChild(container);
}

function showPermissionPrompt(data) {
  clearEmptyState();

  const div = document.createElement('div');
  div.className = 'permission-prompt';
  div.dataset.requestId = data.requestId;
  div.dataset.toolInput = JSON.stringify(data.input || {});

  const icon = getToolIcon(data.toolName);
  const input = data.input || {};

  let details = '';
  if (data.toolName === 'Bash') {
    details = input.command || JSON.stringify(input, null, 2);
  } else if (data.toolName === 'Edit' || data.toolName === 'Write') {
    details = `File: ${input.file_path || input.path || 'unknown'}`;
  } else if (data.toolName === 'Read') {
    details = `File: ${input.file_path || input.path || 'unknown'}`;
  } else {
    details = JSON.stringify(input, null, 2);
  }

  div.innerHTML = `
    <div class="tool-header">
      <span class="tool-icon">${icon}</span>
      <span>${data.toolName}</span>
    </div>
    <div class="tool-details">${escapeHtml(details)}</div>
    <div class="tool-actions">
      <button class="approve">Approve</button>
      <button class="deny">Deny</button>
    </div>
  `;

  div.querySelector('.approve').addEventListener('click', () => respondPermission(data.requestId, true));
  div.querySelector('.deny').addEventListener('click', () => respondPermission(data.requestId, false));

  messagesEl.appendChild(div);

  const lastToolBubble = state.lastToolUseId
    ? messagesEl.querySelector(`[data-tool-use-id="${state.lastToolUseId}"]`)
    : null;
  if (lastToolBubble) {
    const detailRows = getOrCreateDetailRows(lastToolBubble);
    const row = document.createElement('div');
    row.className = 'tool-detail-row pending-status';
    row.dataset.requestId = data.requestId;
    row.innerHTML = `<span class="tool-detail-label">status:</span> <span class="tool-detail-value pending">\u23F3 pending approval</span>`;
    detailRows.appendChild(row);
  }
}

// --- Tool use handling ---

function getToolDetails(toolName, input) {
  const details = [];
  if (toolName.includes('__')) {
    const parts = toolName.split('__');
    if (parts.length >= 3) details.push({ label: 'server', value: parts[1] });
    for (const [key, val] of Object.entries(input || {})) {
      if (typeof val === 'string') details.push({ label: key, value: truncate(val) });
      if (details.length >= 4) break;
    }
    return details;
  }

  switch (toolName) {
    case 'Agent':
      if (input.description) details.push({ label: 'task', value: truncate(input.description) });
      if (input.subagent_type) details.push({ label: 'type', value: input.subagent_type });
      if (input.prompt) details.push({ label: 'prompt', value: truncate(input.prompt, 120) });
      break;
    case 'WebSearch':
      if (input.query) details.push({ label: 'query', value: truncate(input.query) });
      break;
    case 'WebFetch':
      if (input.url) details.push({ label: 'url', value: truncate(input.url) });
      break;
    case 'ToolSearch':
      if (input.query) details.push({ label: 'query', value: truncate(input.query) });
      break;
    case 'Edit':
      if (input.old_string) details.push({ label: 'replacing', value: truncate(input.old_string) });
      break;
    case 'Grep':
      if (input.path) details.push({ label: 'in', value: truncate(input.path) });
      break;
  }
  return details;
}

export function getOrCreateDetailRows(toolDiv) {
  let detailRows = toolDiv.querySelector('.tool-detail-rows');
  if (!detailRows) {
    detailRows = document.createElement('div');
    detailRows.className = 'tool-detail-rows';
    toolDiv.appendChild(detailRows);
  }
  return detailRows;
}

function getToolCommandPreview(toolName, input) {
  if (toolName === 'Bash') return (input || {}).command || '';
  if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') return (input || {}).file_path || (input || {}).path || '';
  if (toolName === 'Glob' || toolName === 'Grep') return (input || {}).pattern || '';
  return '';
}

function renderToolInput(toolName, input) {
  switch (toolName) {
    case 'Bash': {
      let html = '';
      if (input.description) {
        html += `<div class="tool-detail-section">
          <label>Description</label>
          <div class="tool-detail-desc">${escapeHtml(input.description)}</div>
        </div>`;
      }
      if (input.command) {
        html += `<div class="tool-detail-section">
          <label>Command</label>
          <div class="tool-detail-body tool-detail-terminal">${escapeHtml(input.command)}</div>
        </div>`;
      }
      return html;
    }
    case 'Read': {
      const parts = [];
      if (input.file_path) parts.push(`<div class="tool-detail-section"><label>File</label><div class="tool-detail-body">${escapeHtml(input.file_path)}</div></div>`);
      if (input.offset || input.limit) {
        const range = [input.offset ? `from line ${input.offset}` : '', input.limit ? `${input.limit} lines` : ''].filter(Boolean).join(', ');
        parts.push(`<div class="tool-detail-section"><label>Range</label><div class="tool-detail-desc">${escapeHtml(range)}</div></div>`);
      }
      return parts.join('') || null;
    }
    case 'Edit': {
      let html = '';
      if (input.file_path) html += `<div class="tool-detail-section"><label>File</label><div class="tool-detail-body">${escapeHtml(input.file_path)}</div></div>`;
      if (input.old_string != null && input.new_string != null) {
        html += `<div class="tool-detail-section"><label>Replace</label><div class="tool-detail-body tool-detail-diff"><span class="diff-del">${escapeHtml(input.old_string)}</span><span class="diff-add">${escapeHtml(input.new_string)}</span></div></div>`;
      }
      return html || null;
    }
    case 'Write': {
      let html = '';
      if (input.file_path) html += `<div class="tool-detail-section"><label>File</label><div class="tool-detail-body">${escapeHtml(input.file_path)}</div></div>`;
      if (input.content) html += `<div class="tool-detail-section"><label>Content</label><div class="tool-detail-body">${escapeHtml(input.content)}</div></div>`;
      return html || null;
    }
    case 'Grep':
    case 'Glob': {
      let html = '';
      if (input.pattern) html += `<div class="tool-detail-section"><label>Pattern</label><div class="tool-detail-body">${escapeHtml(input.pattern)}</div></div>`;
      if (input.path) html += `<div class="tool-detail-section"><label>Path</label><div class="tool-detail-desc">${escapeHtml(input.path)}</div></div>`;
      if (input.glob) html += `<div class="tool-detail-section"><label>File filter</label><div class="tool-detail-desc">${escapeHtml(input.glob)}</div></div>`;
      return html || null;
    }
    default:
      return null; // fall through to generic JSON
  }
}

function linkifyUrls(text) {
  return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function renderToolResult(toolName, result, isError) {
  if (result == null) {
    return `<div class="tool-detail-section">
      <label>Result</label>
      <div class="tool-detail-body" style="color: var(--text-muted);">Pending...</div>
    </div>`;
  }

  const errorClass = isError ? ' error' : '';
  if (toolName === 'Bash') {
    return `<div class="tool-detail-section">
      <label>Output${isError ? ' (error)' : ''}</label>
      <div class="tool-detail-body tool-detail-terminal${errorClass}">${linkifyUrls(escapeHtml(result))}</div>
    </div>`;
  }

  return `<div class="tool-detail-section">
    <label>Result</label>
    <div class="tool-detail-body${errorClass}">${linkifyUrls(escapeHtml(result))}</div>
  </div>`;
}

function openToolDetail(toolUseId) {
  const detail = state.toolDetails.get(toolUseId);
  if (!detail) return;

  const titleEl = document.getElementById('tool-detail-title');
  const contentEl = document.getElementById('tool-detail-content');

  const icon = getToolIcon(detail.toolName);
  titleEl.textContent = icon + ' ' + detail.toolName;

  let html = '';
  const input = detail.input || {};

  // Try tool-specific rendering, fall back to generic JSON
  const specificInput = renderToolInput(detail.toolName, input);
  if (specificInput) {
    html += specificInput;
  } else if (Object.keys(input).length > 0) {
    html += `<div class="tool-detail-section">
      <label>Input</label>
      <div class="tool-detail-body">${escapeHtml(JSON.stringify(input, null, 2))}</div>
    </div>`;
  }

  html += renderToolResult(detail.toolName, detail.result, detail.isError);

  contentEl.innerHTML = html;
  document.getElementById('tool-detail-modal').classList.add('open');
}

function isSystemApiCall(toolName, input) {
  if (toolName !== 'Bash' || typeof input?.command !== 'string') return false;
  return /\/api\/tasks/.test(input.command);
}

export function showToolUse(data) {
  if (!messagesEl) return;
  clearEmptyState();

  if (state.currentAssistantMsg) {
    state.currentAssistantMsg.classList.remove('streaming');
    state.currentAssistantMsg = null;
  }

  const toolUseId = data.toolUseId || crypto.randomUUID();
  const toolName = data.toolName || 'Tool';
  const input = data.input || {};

  // Suppress all task API curl commands — the task bubble provides feedback
  if (isSystemApiCall(toolName, input)) {
    state.toolDetails.set(toolUseId, { toolName, input, result: null, isError: false, hidden: true });
    state.lastToolUseId = toolUseId;
    return;
  }

  state.toolDetails.set(toolUseId, { toolName, input, result: null, isError: false });

  const div = document.createElement('div');
  div.className = 'tool-executed clickable';
  div.dataset.toolUseId = toolUseId;
  div.addEventListener('click', () => openToolDetail(toolUseId));

  state.lastToolUseId = toolUseId;

  const icon = getToolIcon(toolName);
  const cmdPreview = getToolCommandPreview(toolName, input);
  const details = getToolDetails(toolName, input);

  const wrapLabels = new Set(['prompt', 'query', 'url']);
  div.innerHTML = `
    <div class="tool-header-row">
      <span class="tool-icon">${icon}</span>
      <span class="tool-name">${escapeHtml(toolName)}</span>
      ${cmdPreview ? `<span class="tool-cmd" title="${escapeHtml(cmdPreview)}">${escapeHtml(cmdPreview)}</span>` : ''}
    </div>
    ${details.length ? `<div class="tool-detail-rows">${details.map(d =>
      `<div class="tool-detail-row"><span class="tool-detail-label">${escapeHtml(d.label)}:</span> <span class="tool-detail-value${wrapLabels.has(d.label) ? ' wrap' : ''}">${escapeHtml(d.value)}</span></div>`
    ).join('')}</div>` : ''}
  `;

  messagesEl.appendChild(div);
  return toolUseId;
}

export function showToolResult(data) {
  const content = data.content || '';

  // Suppress result for hidden task completion curls
  if (data.toolUseId && state.toolDetails.get(data.toolUseId)?.hidden) return;

  if (data.toolUseId && state.toolDetails.has(data.toolUseId)) {
    const detail = state.toolDetails.get(data.toolUseId);
    detail.result = content;
    detail.isError = data.isError || false;
  }

  if (!content && (!data.images || data.images.length === 0)) return;

  const toolDiv = data.toolUseId
    ? document.querySelector(`[data-tool-use-id="${data.toolUseId}"]`)
    : null;

  if (toolDiv) {
    const isPermissionDenied = content.startsWith('Denied by user') || content.startsWith('Tool permission request failed');
    const isPermissionApproved = content.startsWith('Approved by user');

    const firstLine = content.split('\n').filter(l => l.trim())[0] || '';
    let preview = firstLine.length > 80 ? firstLine.substring(0, 80) + '\u2026' : firstLine;
    if (isPermissionDenied) preview = '\u2717 denied';
    if (isPermissionApproved) preview = '\u2713 approved';
    if (preview) {
      const detailRows = getOrCreateDetailRows(toolDiv);
      const pendingRow = detailRows.querySelector('.pending-status');
      if (pendingRow) pendingRow.remove();

      const row = document.createElement('div');
      row.className = 'tool-detail-row';
      if (data.isError) row.classList.add('error');
      const statusClass = isPermissionDenied ? ' denied' : isPermissionApproved ? ' approved' : '';
      const label = isPermissionDenied || isPermissionApproved ? 'status' : (data.isError ? '\u2717' : '\u2192');
      row.innerHTML = `<span class="tool-detail-label">${escapeHtml(label)}:</span> <span class="tool-detail-value${statusClass}">${escapeHtml(preview)}</span>`;
      detailRows.appendChild(row);
    }
    if (data.isError) toolDiv.classList.add('tool-error');

    // Render screenshot images inline in the tool result
    if (data.images && data.images.length > 0) {
      const detailRows = getOrCreateDetailRows(toolDiv);
      for (const img of data.images) {
        const imgEl = document.createElement('img');
        imgEl.src = `data:${img.media_type};base64,${img.data}`;
        imgEl.className = 'message-image tool-result-image';
        import('./image-modal.js').then(m => m.makeImageClickable(imgEl, 'screenshot.png'));
        detailRows.appendChild(imgEl);
      }
    }
  } else {
    const div = document.createElement('div');
    div.className = 'tool-result' + (data.isError ? ' error' : '');
    const lines = content.split('\n');
    const preview = lines.slice(0, 3).join('\n');
    div.textContent = preview + (lines.length > 3 ? '\n\u2026' : '');
    // Render images for unattached tool results too
    if (data.images && data.images.length > 0) {
      for (const img of data.images) {
        const imgEl = document.createElement('img');
        imgEl.src = `data:${img.media_type};base64,${img.data}`;
        imgEl.className = 'message-image';
        import('./image-modal.js').then(m => m.makeImageClickable(imgEl, 'screenshot.png'));
        div.appendChild(imgEl);
      }
    }
    messagesEl.appendChild(div);
  }
}

export function retryFromStalePermission(userMessage, toolDiv) {
  const retryBtn = toolDiv.querySelector('.retry-btn');
  if (retryBtn) {
    retryBtn.textContent = 'Retrying...';
    retryBtn.disabled = true;
  }

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'user_message', content: userMessage }));
  } else {
    const waitForWs = setInterval(() => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        clearInterval(waitForWs);
        state.ws.send(JSON.stringify({ type: 'user_message', content: userMessage }));
      }
    }, 500);
    setTimeout(() => clearInterval(waitForWs), 10000);
  }
}

// --- Main message handler ---

export function handleServerMessage(data) {
  if (!messagesEl) return;
  switch (data.type) {
    case 'init': {
      state.sessionId = data.sessionId;
      // Only set agentId if we don't already have one (tab restore sets it first)
      if (data.agentId && !state.activeAgentId) state.activeAgentId = data.agentId;
      const pi = data.processInfo;
      let initMsg = '';
      if (pi?.reattached) {
        initMsg = `Reconnected to existing process (pid ${pi.pid})`;
      } else if (data.reconnected) {
        initMsg = 'Reconnected to session';
      } else {
        initMsg = 'New process started';
      }
      console.log(initMsg);
      connLog(initMsg, 'success');

      // Show in chat so the user sees it
      if (data.reconnected || pi?.reattached) {
        clearEmptyState();
        const statusDiv = document.createElement('div');
        statusDiv.className = 'agent-status';
        statusDiv.textContent = initMsg;
        messagesEl.appendChild(statusDiv);
      }

      if (state.sessionId) {
        pushUrl(urlFor('chat', { sessionId: state.sessionId }));
        updateActiveTabSessionId(state.sessionId);
      }
      updateModalInfo();
      break;
    }

    case 'text':
      if (data.text == null) break;
      hideThinking();
      // Route task-context responses to timeline card instead of chat
      if (data.taskContext && appendTimelineResponse(data.taskContext.taskId, data.text)) {
        break;
      }
      if (!state.currentAssistantMsg) {
        state.currentAssistantMsg = addMessage('', 'assistant', false, data.messageId, new Date().toISOString());
        state.currentAssistantMsg.classList.add('streaming');
        state.currentAssistantMsg._rawText = '';
        state.assistantMessageCount++;
        state.messageCount++;
      }
      state.currentAssistantMsg._rawText += data.text;
      state.currentAssistantMsg.innerHTML = renderMarkdown(state.currentAssistantMsg._rawText);
      // Re-show thinking after text pauses (covers gap before large tool calls)
      if (state.isProcessing) showThinkingDeferred();
      break;

    case 'image': {
      hideThinking();
      const img = document.createElement('img');
      img.src = `data:${data.mediaType || 'image/png'};base64,${data.data}`;
      img.className = 'message-image';
      import('./image-modal.js').then(m => m.makeImageClickable(img, 'screenshot.png'));
      // Append to current assistant message or create one
      if (!state.currentAssistantMsg) {
        state.currentAssistantMsg = addMessage('', 'assistant', false, data.messageId);
        state.assistantMessageCount++;
        state.messageCount++;
      }
      state.currentAssistantMsg.appendChild(img);
      break;
    }

    case 'tool_use':
      hideThinking();
      state.toolCount++;
      // AskUserQuestion is handled exclusively by permission_request path
      // to avoid double-render and ensure correct response channel.
      // Agent tool is visualized via the timeline card (task_progress_injection)
      // so suppress the raw tool_use/tool_result to avoid duplication.
      if (data.toolName === 'Agent') {
        const toolUseId = data.toolUseId || crypto.randomUUID();
        state.toolDetails.set(toolUseId, { toolName: 'Agent', input: data.input || {}, result: null, isError: false, hidden: true });
        state.lastToolUseId = toolUseId;
      } else if (data.toolName !== 'AskUserQuestion') {
        showToolUse(data);
      }
      updateModalInfo();
      break;

    case 'permission_request':
      hideThinking();
      state.permissionCount++;
      if (data.toolName === 'AskUserQuestion') {
        showAskUserQuestionPermission(data);
      } else {
        showPermissionPrompt(data);
      }
      updateModalInfo();
      break;

    case 'approval_request': {
      hideThinking();
      clearEmptyState();
      showApprovalCard(data);
      break;
    }

    case 'approval_resolved': {
      resolveApprovalCard(data.id, data.state || 'expired');
      break;
    }

    case 'tool_auto_executed':
      break;

    case 'tool_result':
      showToolResult(data);
      if (state.isProcessing) showThinkingDeferred();
      break;

    case 'result':
      hideThinking();
      if (state.currentAssistantMsg) {
        state.currentAssistantMsg.classList.remove('streaming');
        addCopyButtons(state.currentAssistantMsg);
        attachReactionToMessage(state.currentAssistantMsg);
        // Notify native app that response is complete (for TTS)
        const fullText = state.currentAssistantMsg._rawText || '';
        if (fullText) {
          try { window.gellyfish?.onResponseComplete?.(fullText); } catch { /* ignore */ }
        }
      }
      state.currentAssistantMsg = null;
      setProcessing(false);
      if (inputEl) inputEl.focus();

      if (data.sessionId && !state.sessionId) {
        state.sessionId = data.sessionId;
      }

      if (data.cost) {
        state.totalCost += data.cost;
        showCostInfo(data.cost, data.usage);
      }
      updateModalInfo();
      break;

    case 'session_end':
      hideThinking();
      setProcessing(false);
      if (data.code !== 0 && data.error) {
        clearEmptyState();
        const crashDiv = document.createElement('div');
        crashDiv.className = 'crash-banner';

        // Dismiss button
        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'crash-banner-dismiss';
        dismissBtn.innerHTML = '&times;';
        dismissBtn.addEventListener('click', () => crashDiv.remove());
        crashDiv.appendChild(dismissBtn);

        const errorMsg = document.createElement('div');
        errorMsg.className = 'crash-banner-msg';
        errorMsg.textContent = `Process crashed (code ${data.code}): ${data.error}`;
        crashDiv.appendChild(errorMsg);

        if (data.recoveryActions && data.recoveryActions.length > 0) {
          const btnContainer = document.createElement('div');
          btnContainer.className = 'crash-banner-actions';
          for (const ra of data.recoveryActions) {
            const btn = document.createElement('button');
            btn.textContent = ra.label;
            btn.className = ra.action === 'resume_session' ? 'crash-btn primary' : 'crash-btn secondary';
            btn.addEventListener('click', () => {
              if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({ type: 'recovery_action', action: ra.action, sessionId: state.sessionId }));
                crashDiv.remove();
              }
            });
            btnContainer.appendChild(btn);
          }
          crashDiv.appendChild(btnContainer);
        }
        messagesEl.appendChild(crashDiv);
      }
      connLog(`Claude process ended (code ${data.code})${data.error ? ': ' + data.error : ''}`, data.code === 0 ? 'info' : 'warn');
      break;

    case 'error':
      hideThinking();
      connLog('Error: ' + data.error, 'error');
      addMessage('Error: ' + data.error, 'assistant', true);
      setProcessing(false);
      break;

    case 'session_error':
      console.log('Session error, retrying:', data.error);
      connLog('Session error: ' + data.error + (data.willRetry ? ' \u2014 retrying...' : ''), 'error');
      if (data.willRetry) {
        state.sessionId = null;
        addMessage('(Session history could not be loaded, starting fresh)', 'assistant');
      } else {
        addMessage('Error: ' + data.error, 'assistant', true);
        setProcessing(false);
      }
      break;

    case 'session_missing': {
      clearEmptyState();
      setProcessing(false);
      const agentName = data.agentName || 'Agent';
      const dialog = document.createElement('div');
      dialog.className = 'session-missing-dialog';
      dialog.innerHTML = `
        <div class="session-missing-icon">\u26A0\uFE0F</div>
        <div class="session-missing-title">Session Not Found</div>
        <div class="session-missing-text">The session file for <strong>${escapeHtml(agentName)}</strong> was not found on disk. This could be a bug or an intentional deletion.</div>
        <button class="session-missing-btn">Start Fresh</button>
      `;
      dialog.querySelector('.session-missing-btn').addEventListener('click', () => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'start_fresh', conversationId: data.conversationId }));
        }
        dialog.remove();
      });
      messagesEl.appendChild(dialog);
      break;
    }

    case 'session_not_found': {
      clearEmptyState();
      setProcessing(false);
      const pickerName = data.agentName || 'Agent';
      const picker = document.createElement('div');
      picker.className = 'session-picker-dialog';

      let sessionsHtml = '';
      if (data.availableSessions && data.availableSessions.length > 0) {
        for (const s of data.availableSessions) {
          const shortId = s.sessionId.substring(0, 8);
          const date = s.modifiedAt ? new Date(s.modifiedAt).toLocaleString() : '';
          const activeLabel = s.active ? ' <span style="color:#30d158;font-size:0.7rem">\u25CF active</span>' : '';
          sessionsHtml += `<button class="session-option" data-session-id="${escapeHtml(s.sessionId)}">
            <span><code>${shortId}...</code>${activeLabel}</span>
            <span style="color:var(--text-muted);font-size:0.8rem">${s.sizeMB}MB \u00B7 ${date}</span>
          </button>`;
        }
      }

      picker.innerHTML = `
        <h3>\u26A0\uFE0F Session Not Found</h3>
        <p style="color:var(--text-muted);font-size:0.85rem;margin:0 0 12px">The previous session for <strong>${escapeHtml(pickerName)}</strong> is no longer available. Choose an existing session or start fresh.</p>
        ${sessionsHtml ? `<div class="session-options">${sessionsHtml}</div>` : '<p style="color:var(--text-muted);font-size:0.85rem">No previous sessions found.</p>'}
        <button class="fresh-btn">Start Fresh Session</button>
      `;

      // Wire session option clicks
      picker.querySelectorAll('.session-option').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.dataset.sessionId;
          picker.remove();
          import('./connection.js').then(m => m.connect(sid));
        });
      });

      // Wire fresh start button
      picker.querySelector('.fresh-btn').addEventListener('click', () => {
        picker.remove();
        import('./connection.js').then(m => m.connect(null));
      });

      messagesEl.appendChild(picker);
      break;
    }

    case 'api_retry': {
      // API error retry — show/update inline toast
      let toast = messagesEl.querySelector('.api-retry-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.className = 'api-retry-toast';
        messagesEl.appendChild(toast);
      }
      toast.innerHTML = `<span class="dot"></span> API ${escapeHtml((data.error || 'error').substring(0, 60))} · Retrying (${data.attempt}/${data.maxRetries || 10})`;
      break;
    }

    case 'api_retry_resolved': {
      // API recovered — remove the toast
      const toast = messagesEl.querySelector('.api-retry-toast');
      if (toast) toast.remove();
      break;
    }

    case 'session_error_prompt': {
      // Repeated API errors — prompt user to recover or retry
      const errDialog = document.createElement('div');
      errDialog.className = 'session-missing-dialog';
      errDialog.innerHTML = `
        <div class="session-missing-icon">\u26A0\uFE0F</div>
        <div class="session-missing-title">Repeated API Errors</div>
        <div class="session-missing-text"><strong>${escapeHtml(data.agentName || 'Agent')}</strong> has hit ${data.errorCount} consecutive API errors. This session may be unrecoverable.<br><br><code style="font-size:0.75rem;color:var(--text-muted)">${escapeHtml((data.error || '').substring(0, 200))}</code></div>
        <div style="display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap">
          <button class="session-missing-btn" data-action="recover" style="background:var(--accent)">Recover (Start Fresh)</button>
          <button class="session-missing-btn" data-action="retry">Retry</button>
          <button class="session-missing-btn" data-action="ignore" style="opacity:0.6">Ignore</button>
        </div>
      `;
      errDialog.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === 'recover' && state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'session_recover', conversationId: data.conversationId }));
        } else if (action === 'retry' && state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'session_retry' }));
        }
        errDialog.remove();
      });
      messagesEl.appendChild(errDialog);
      break;
    }

    case 'session_cleared':
      // Server confirmed session was cleared — reconnect fresh
      connLog('Session cleared — starting fresh');
      import('./connection.js').then(m => m.connect());
      break;

    case 'processing':
      if (data.active) {
        setProcessing(true);
        showThinking();
      } else {
        hideThinking();
        setProcessing(false);
      }
      break;

    case 'agent_status': {
      clearEmptyState();
      const statusDiv = document.createElement('div');
      statusDiv.className = 'agent-status';
      statusDiv.textContent = data.status;
      messagesEl.appendChild(statusDiv);
      break;
    }

    case 'compaction_started': {
      clearEmptyState();
      // Remove any existing compaction indicator
      messagesEl.querySelector('.compaction-indicator')?.remove();
      const indicator = document.createElement('div');
      indicator.className = 'compaction-indicator';
      indicator.innerHTML = '<span class="compaction-spinner">\u23F3</span> Compacting conversation\u2026';
      messagesEl.appendChild(indicator);
      // Disable input
      const input = document.getElementById('message-input');
      if (input) { input.disabled = true; input.classList.add('disabled'); }
      break;
    }

    case 'compaction_summary': {
      // Remove indicator, re-enable input
      messagesEl.querySelector('.compaction-indicator')?.remove();
      const inputEl2 = document.getElementById('message-input');
      if (inputEl2) { inputEl2.disabled = false; inputEl2.classList.remove('disabled'); }

      // Render as compact clickable bubble
      const bubble = document.createElement('div');
      bubble.className = 'task-bubble compaction-bubble';
      bubble.innerHTML = `
        <span class="task-bubble-icon">\uD83D\uDCCB</span>
        <div class="task-bubble-text">
          <div class="task-bubble-title">Conversation compacted</div>
          <div class="task-bubble-preview">Click to view summary</div>
        </div>
      `;
      bubble.addEventListener('click', () => {
        const titleEl = document.getElementById('tool-detail-title');
        const contentEl = document.getElementById('tool-detail-content');
        if (titleEl && contentEl) {
          titleEl.textContent = 'Compaction Summary';
          contentEl.innerHTML = '<div class="tool-detail-section"><label>Summary</label><div class="tool-detail-body tool-detail-terminal">' + escapeHtml(data.summary || '') + '</div></div>';
          document.getElementById('tool-detail-modal').classList.add('open');
        }
      });
      messagesEl.appendChild(bubble);
      break;
    }

    case 'compaction_likely': {
      clearEmptyState();
      messagesEl.querySelector('.compaction-indicator')?.remove();
      const likelyIndicator = document.createElement('div');
      likelyIndicator.className = 'compaction-indicator';
      likelyIndicator.innerHTML = '<span class="compaction-spinner">\u23F3</span> Compacting context, please wait\u2026';
      messagesEl.appendChild(likelyIndicator);
      break;
    }

    case 'compaction_completed': {
      messagesEl.querySelector('.compaction-indicator')?.remove();
      const meta = data.metadata;
      if (meta && meta.preTokens && meta.postTokens) {
        const fmtTokens = (n) => n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
        const notice = document.createElement('div');
        notice.className = 'compaction-indicator compaction-done';
        notice.textContent = `Context compacted: ${fmtTokens(meta.preTokens)} \u2192 ${fmtTokens(meta.postTokens)} tokens`;
        messagesEl.appendChild(notice);
        setTimeout(() => notice.remove(), 10000);
      }
      break;
    }

    case 'agent_message': {
      if (!data.text) break;
      clearEmptyState();
      const agentMsgEl = document.createElement('div');
      agentMsgEl.className = 'agent-message-bubble';
      agentMsgEl.innerHTML = renderMarkdown(data.text);
      messagesEl.appendChild(agentMsgEl);
      state.messageCount++;
      state.assistantMessageCount++;
      break;
    }

    case 'user_message_echo': {
      // GAP-prefixed messages echoed from CLI — render as notification
      if (data.content) {
        addMessage(data.content, 'user', false, null, new Date().toISOString());
      }
      break;
    }

    case 'mcp_health_warning': {
      clearEmptyState();
      // Only show one warning per MCP
      if (messagesEl.querySelector(`[data-mcp-warning="${data.mcp}"]`)) break;
      const warningDiv = document.createElement('div');
      warningDiv.className = 'mcp-health-warning';
      warningDiv.dataset.mcpWarning = data.mcp;
      warningDiv.style.cssText = 'border:1px solid #f59e0b;border-radius:6px;padding:10px 12px;margin:8px 0;background:rgba(245,158,11,0.1);font-size:0.85rem';
      const msgSpan = document.createElement('span');
      msgSpan.style.color = '#f59e0b';
      msgSpan.textContent = '\u26a0\ufe0f ' + data.message;
      warningDiv.appendChild(msgSpan);
      const btnContainer = document.createElement('div');
      btnContainer.style.cssText = 'margin-top:6px;display:flex;gap:8px';
      if (state.sessionId) {
        const restartBtn = document.createElement('button');
        restartBtn.textContent = 'Restart Process';
        restartBtn.style.cssText = 'padding:3px 10px;cursor:pointer;font-size:0.75rem;background:#f59e0b;color:#000;border:none;border-radius:3px';
        restartBtn.addEventListener('click', async () => {
          restartBtn.textContent = 'Restarting...';
          restartBtn.disabled = true;
          try {
            await fetch(`/api/sessions/${state.sessionId}/stop`, { method: 'POST' });
            warningDiv.remove();
          } catch { restartBtn.textContent = 'Failed'; }
        });
        btnContainer.appendChild(restartBtn);
      }
      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.style.cssText = 'padding:3px 10px;cursor:pointer;font-size:0.75rem;border-radius:3px';
      dismissBtn.addEventListener('click', () => warningDiv.remove());
      btnContainer.appendChild(dismissBtn);
      warningDiv.appendChild(btnContainer);
      messagesEl.appendChild(warningDiv);
      break;
    }

    case 'agent_idle': {
      clearEmptyState();
      // Only show one warning per agent
      if (messagesEl.querySelector(`[data-idle-warning="${data.agentId}"]`)) break;
      const warningDiv = document.createElement('div');
      warningDiv.className = 'idle-agent-warning';
      warningDiv.dataset.idleWarning = data.agentId;
      warningDiv.style.cssText = 'border:1px solid #f59e0b;border-radius:6px;padding:10px 12px;margin:8px 0;background:rgba(245,158,11,0.1);font-size:0.85rem';
      const msgSpan = document.createElement('span');
      msgSpan.style.color = '#f59e0b';
      msgSpan.textContent = `\u26a0\ufe0f Agent ${data.agentName} has been idle for ${data.idleMinutes} minutes.`;
      warningDiv.appendChild(msgSpan);
      const btnContainer = document.createElement('div');
      btnContainer.style.cssText = 'margin-top:6px;display:flex;gap:8px';
      const stopBtn = document.createElement('button');
      stopBtn.textContent = 'Stop Process';
      stopBtn.style.cssText = 'padding:3px 10px;cursor:pointer;font-size:0.75rem;background:#f59e0b;color:#000;border:none;border-radius:3px';
      stopBtn.addEventListener('click', async () => {
        stopBtn.textContent = 'Stopping...';
        stopBtn.disabled = true;
        try {
          await fetch(`/api/sessions/${data.sessionId}/stop`, { method: 'POST' });
          warningDiv.remove();
        } catch { stopBtn.textContent = 'Failed'; }
      });
      btnContainer.appendChild(stopBtn);
      if (data.sessionId) {
        const openBtn = document.createElement('button');
        openBtn.textContent = 'Open';
        openBtn.style.cssText = 'padding:3px 10px;cursor:pointer;font-size:0.75rem;background:transparent;border:1px solid #f59e0b;color:#f59e0b;border-radius:3px';
        openBtn.addEventListener('click', async () => {
          const { findTabBySessionId, switchTab, openSessionTab } = await import('./tabs.js');
          const existingTab = findTabBySessionId(data.sessionId);
          if (existingTab) {
            switchTab(existingTab.id);
          } else {
            openSessionTab(data.sessionId, data.agentName || 'Agent');
          }
          warningDiv.remove();
        });
        btnContainer.appendChild(openBtn);
      }
      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.style.cssText = 'padding:3px 10px;cursor:pointer;font-size:0.75rem;border-radius:3px';
      dismissBtn.addEventListener('click', () => warningDiv.remove());
      btnContainer.appendChild(dismissBtn);
      warningDiv.appendChild(btnContainer);
      messagesEl.appendChild(warningDiv);
      break;
    }

    case 'task_update': {
      clearEmptyState();
      getOrCreateTimelineCard(data.taskId, data.target, data.targetIcon, data.targetSessionId, data.targetProfileId, data.targetAgentId);
      const stored = getTaskData(data.taskId);
      if (stored) {
        if (data.message) stored.message = data.message;
        if (data.state) stored.state = data.state;
        if (data.result) stored.result = data.result;
        if (data.error) stored.error = data.error;
        if (data.creator) stored.creator = data.creator;
        if (data.creatorIcon) stored.creatorIcon = data.creatorIcon;
        if (data.targetIcon) stored.targetIcon = data.targetIcon;
        if (data.targetSessionId) stored.targetSessionId = data.targetSessionId;
        if (data.targetProfileId) stored.targetProfileId = data.targetProfileId;
        if (data.targetAgentId) stored.targetAgentId = data.targetAgentId;
      }
      if (['completed', 'failed', 'canceled'].includes(data.state)) {
        updateTimelineCardState(data.taskId, data.state, data.result, data.error);
      } else {
        updateTaskGoal(data.taskId);
      }
      break;
    }

    case 'task_progress': {
      // Route progress to timeline card
      appendTimelineProgress({
        taskId: data.taskId,
        agentName: data.agentName || data.target,
        summary: data.summary || data.event || '',
        toolName: data.toolName,
        timestamp: data.timestamp,
      });
      break;
    }

    case 'task_progress_injection': {
      // Append to timeline card (create if needed)
      appendTimelineProgress(data);
      break;
    }

    case 'task_response': {
      if (data.taskId && data.text) {
        appendTimelineResponse(data.taskId, data.text);
      }
      break;
    }

    case 'active_agents':
      // Populate tabs from server state on connect
      if (data.agents && _onActiveAgents) _onActiveAgents(data.agents);
      break;

    case 'agent_hired':
      // A new agent was created — add tab if handler is set
      if (data.agent && _onAgentHired) _onAgentHired(data.agent);
      break;

    case 'agent_fired':
      // An agent was stopped — update if handler is set
      if (data.agent && _onAgentFired) _onAgentFired(data.agent);
      break;

    case 'tab_opened':
      // Another device opened a tab — sync it here
      if (data.agentId) {
        fetch(`/api/agents/${data.agentId}`).then(r => r.json()).then(d => {
          if (d.agent) {
            import('./tabs.js').then(tabs => {
              if (!tabs.findTabByAgentId(data.agentId)) {
                // Open locally without notifying server (server already knows)
                tabs.openAgentTabLocal({
                  id: d.agent.id,
                  name: d.agent.name,
                  profile_id: d.agent.profile_id,
                  profile_icon: d.profile?.icon,
                  session_id: d.conversation?.session_id,
                  conversation_id: d.conversation?.id,
                  conversation_state: d.conversation?.state,
                  issue_number: d.conversation?.issue_number,
                });
              }
            });
          }
        }).catch(() => {});
      }
      break;

    case 'tab_closed':
      // Another device closed a tab — sync it here
      if (data.agentId) {
        import('./tabs.js').then(tabs => {
          const tab = tabs.findTabByAgentId(data.agentId);
          if (tab) tabs.closeTabLocal(tab.id);
        });
      }
      break;
  }
}
