/**
 * Emoji reactions on chat messages.
 * Uses stable message IDs (data-message-id) instead of positional index.
 * Layer 4: imports from state (1).
 */

import state from './state.js';

const EMOJIS = ['👍','👎','😂','🤔','❌','🎉','🔥','✅','❤️','😮','😢','🙏','👀','💯','⚡','🚀','🤦','🫡','👏','😬','🤷','💀','🫠','😍','🥳','🤝','☠️','💡','⭐','🐛'];

const messagesEl = document.getElementById('messages');
let activePanel = null;

// --- Emoji panel ---

function showEmojiPanel(msgEl, messageId) {
  closeEmojiPanel();

  const panel = document.createElement('div');
  panel.className = 'reaction-panel';
  panel.innerHTML = EMOJIS.map(e =>
    `<button class="reaction-emoji-btn" data-emoji="${e}">${e}</button>`
  ).join('');

  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('.reaction-emoji-btn');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    const preview = msgEl.textContent?.substring(0, 100) || '';

    const existingBadge = msgEl.querySelector('.reaction-badge');
    if (existingBadge && existingBadge.textContent === emoji) {
      sendReaction(null, messageId, preview);
      existingBadge.remove();
    } else {
      sendReaction(emoji, messageId, preview);
      setReactionBadge(msgEl, emoji, messageId);
    }
    closeEmojiPanel();
  });

  const isMobile = window.innerWidth < 600;
  if (isMobile) {
    panel.style.position = 'fixed';
    panel.style.top = '50%';
    panel.style.left = '50%';
    panel.style.transform = 'translate(-50%, -50%)';
  } else {
    const rect = msgEl.getBoundingClientRect();
    const containerRect = messagesEl.getBoundingClientRect();
    panel.style.position = 'absolute';
    panel.style.top = (rect.top - containerRect.top + messagesEl.scrollTop - 10) + 'px';
    if (msgEl.classList.contains('user')) {
      panel.style.right = '1rem';
    } else {
      panel.style.left = '1rem';
    }
    messagesEl.style.position = 'relative';
  }

  const target = isMobile ? document.body : messagesEl;
  target.appendChild(panel);
  activePanel = panel;

  setTimeout(() => {
    document.addEventListener('click', onOutsideClick);
    document.addEventListener('keydown', onEscapeKey);
  }, 0);
}

function closeEmojiPanel() {
  if (activePanel) {
    activePanel.remove();
    activePanel = null;
    document.removeEventListener('click', onOutsideClick);
    document.removeEventListener('keydown', onEscapeKey);
  }
}

function onOutsideClick(e) {
  if (activePanel && !activePanel.contains(e.target) && !e.target.closest('.reaction-trigger')) {
    closeEmojiPanel();
  }
}

function onEscapeKey(e) {
  if (e.key === 'Escape') closeEmojiPanel();
}

// --- Reaction badge ---

function setReactionBadge(msgEl, emoji, messageId) {
  const existing = msgEl.querySelector('.reaction-badge');
  if (existing) existing.remove();

  const badge = document.createElement('span');
  badge.className = 'reaction-badge';
  badge.dataset.messageId = messageId;
  badge.textContent = emoji;
  badge.title = 'Click to change reaction';
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    showEmojiPanel(msgEl, messageId);
  });
  msgEl.appendChild(badge);
}

// --- WebSocket send ---

function sendReaction(emoji, messageId, messagePreview) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({
    type: 'reaction',
    emoji,
    messageId,
    messagePreview,
  }));
}

// --- Attach hover triggers to messages ---

/** Attach reaction trigger to a single message element */
export function attachReactionToMessage(msgEl) {
  if (msgEl.querySelector('.reaction-trigger')) return;
  const messageId = msgEl.dataset.messageId;
  if (!messageId) return;

  const trigger = document.createElement('button');
  trigger.className = 'reaction-trigger';
  trigger.textContent = '😀';
  trigger.title = 'React';
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    showEmojiPanel(msgEl, messageId);
  });
  msgEl.appendChild(trigger);

  // In the native iOS wrapper, long-press is handled by the injected WKUserScript
  // which posts `messageContextMenu` to SwiftUI. Skip the web touch listeners so
  // both reaction UIs don't fire at the same time (#668).
  if (window.gellyfish?._nativeApp) return;

  let pressTimer = null;
  msgEl.addEventListener('touchstart', () => {
    pressTimer = setTimeout(() => showEmojiPanel(msgEl, messageId), 500);
  });
  msgEl.addEventListener('touchend', () => clearTimeout(pressTimer));
  msgEl.addEventListener('touchmove', () => clearTimeout(pressTimer));
}

export function attachReactionTriggers() {
  const messages = messagesEl.querySelectorAll('.message');
  messages.forEach((msgEl) => attachReactionToMessage(msgEl));
}

// --- Load reactions on session restore ---

export async function loadReactions(sessionId) {
  try {
    const resp = await fetch(`/api/sessions/${sessionId}/reactions`);
    const data = await resp.json();
    const reactions = data.reactions || [];
    if (reactions.length === 0) return;

    for (const r of reactions) {
      const msgEl = messagesEl.querySelector(`[data-message-id="${r.message_id}"]`);
      if (msgEl) {
        setReactionBadge(msgEl, r.emoji, r.message_id);
      }
    }
  } catch {
    // Non-critical
  }
}
