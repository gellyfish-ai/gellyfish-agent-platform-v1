/**
 * Quote / reply-to state management.
 * Layer 2: manages which message is being quoted. No DOM rendering.
 */

let quotedText = null;
let quotedRole = null;

const PREVIEW_LIMIT = 100;
const MESSAGE_LIMIT = 200;

/** Extract plain text from a message element, excluding UI chrome */
function extractText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.reply-btn, .reactions, .reaction-bar, .message-timestamp, .message-quote').forEach(e => e.remove());
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

/** Set the quote target from a message DOM element */
export function setQuoteTarget(messageEl) {
  // Prefer selected text if the selection is within this message
  const sel = window.getSelection();
  let text = '';
  if (sel && sel.toString().trim() && messageEl.contains(sel.anchorNode)) {
    text = sel.toString().trim();
  } else {
    text = extractText(messageEl);
  }
  if (!text) return;
  quotedText = text;
  quotedRole = messageEl.classList.contains('user') ? 'user' : 'assistant';
  showPreview();
}

/** Clear the current quote */
export function clearQuote() {
  quotedText = null;
  quotedRole = null;
  hidePreview();
}

/** Get the formatted quote string to prepend to the message, or null */
export function getQuotedText() {
  if (!quotedText) return null;
  const truncated = quotedText.length > MESSAGE_LIMIT
    ? quotedText.substring(0, MESSAGE_LIMIT) + '\u2026'
    : quotedText;
  return `> [Replying to ${quotedRole}]: "${truncated}"`;
}

/** Whether a quote is active */
export function isQuoting() {
  return quotedText !== null;
}

// --- Preview bar UI ---

function getPreviewEl() {
  return document.getElementById('quote-preview');
}

function showPreview() {
  const el = getPreviewEl();
  if (!el || !quotedText) return;
  const truncated = quotedText.length > PREVIEW_LIMIT
    ? quotedText.substring(0, PREVIEW_LIMIT) + '\u2026'
    : quotedText;
  el.querySelector('.quote-preview-text').textContent = truncated;
  el.classList.add('visible');
  document.getElementById('message-input')?.focus();
}

function hidePreview() {
  const el = getPreviewEl();
  if (el) el.classList.remove('visible');
}

// Wire up cancel button — no DOMContentLoaded wrapper since this module
// is lazy-loaded via dynamic import() after DOM is ready
const cancelBtn = document.querySelector('#quote-preview .quote-preview-cancel');
if (cancelBtn) {
  cancelBtn.addEventListener('click', clearQuote);
}
