import state, { setProcessing } from './state.js';
import { connLog, cancelProcessing } from './connection.js';

// Callbacks injected by app.js at init — avoids circular import with messages.js
let _addMessage = null;
let _showThinking = null;
let _hideThinking = null;
let _updateModalInfo = null;

let inputForm = null;
let inputEl = null;
let sendBtn = null;
let historyButtonsEl = null;
let attachBtn = null;
let attachFileInput = null;
let imagePreviewArea = null;
let recordBtn = null;
let audioPreviewArea = null;
let recordingIndicator = null;

// Pending image attachments (base64)
const pendingImages = []; // { dataUrl, mediaType, base64 }
// Pending file attachments (PDFs and text files)
const pendingFiles = []; // { name, size, type, contentBlock }

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_TEXT_SIZE = 1 * 1024 * 1024; // 1MB

const TEXT_EXTENSIONS = new Set([
  'txt', 'csv', 'json', 'md', 'js', 'ts', 'py', 'xml', 'yaml', 'yml',
  'html', 'css', 'log', 'sh', 'env', 'toml', 'ini', 'cfg', 'sql',
]);
const MAX_RECORDING_MS = 5 * 60 * 1000; // 5 minutes

// --- Voice recording state ---
let mediaRecorder = null;
let recordingChunks = [];
let recordingStartTime = null;
let recordingTimerInterval = null;
let pendingAudioBlob = null;

// --- Native iOS app bridge ---
const isNativeApp = !!(window.webkit?.messageHandlers?.gellyfish);

function updateHistoryButtons() {
  if (state.messageHistory.length > 0) {
    historyButtonsEl.classList.add('visible');
  } else {
    historyButtonsEl.classList.remove('visible');
  }
}

function navigateHistory(direction) {
  if (direction > 0) {
    if (state.historyIndex < state.messageHistory.length - 1) {
      if (state.historyIndex === -1) state.historyDraft = inputEl.value;
      state.historyIndex++;
      inputEl.value = state.messageHistory[state.historyIndex];
    }
  } else {
    if (state.historyIndex >= 0) {
      state.historyIndex--;
      inputEl.value = state.historyIndex >= 0 ? state.messageHistory[state.historyIndex] : state.historyDraft;
    }
  }
  inputEl.focus();
}

function pushHistory(message) {
  if (state.messageHistory.length > 0 && state.messageHistory[0] === message) return;
  state.messageHistory.unshift(message);
  updateHistoryButtons();
  fetch('/api/input-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }).catch(() => {});
}

function saveDraft() {
  clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(() => {
    fetch('/api/input-draft', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: inputEl.value }),
    }).catch(() => {});
  }, 500);
}

function isBtwMessage(message) {
  return /^\/btw\b/i.test(message);
}

function sendMessage(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    _addMessage('Not connected to server', 'assistant', true);
    return;
  }

  // Build content: string if text only, array of blocks if attachments
  let content;
  if (pendingImages.length > 0 || pendingFiles.length > 0) {
    content = [];
    for (const img of pendingImages) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
      });
    }
    for (const file of pendingFiles) {
      content.push(file.contentBlock);
    }
    if (message) {
      content.push({ type: 'text', text: message });
    }
    clearPendingImages();
    clearPendingFiles();
  } else {
    content = message;
  }

  // Render in chat — pass content blocks so images are shown
  _addMessage(content, 'user', false, null, new Date().toISOString());
  state.messageCount++;
  state.userMessageCount++;

  // Only show thinking/set processing for non-btw messages
  if (!isBtwMessage(message)) {
    setProcessing(true);
    _updateModalInfo();
    _showThinking();
  }

  const payload = { type: 'user_message', content };
  connLog(isBtwMessage(message) ? 'Sending additional info...' : `Sending message${Array.isArray(content) ? ` (${content.length} blocks)` : ''}...`);
  state.ws.send(JSON.stringify(payload));
}

export function initInput({ addMessage, showThinking, hideThinking, updateModalInfo }) {
  _addMessage = addMessage;
  _showThinking = showThinking;
  _hideThinking = hideThinking;
  _updateModalInfo = updateModalInfo;

  // Query DOM elements
  inputForm = document.getElementById('input-form');
  inputEl = document.getElementById('message-input');
  sendBtn = document.getElementById('send-btn');
  historyButtonsEl = document.getElementById('history-buttons');
  attachBtn = document.getElementById('attach-btn');
  attachFileInput = document.getElementById('attach-file-input');
  imagePreviewArea = document.getElementById('image-preview-area');
  recordBtn = document.getElementById('record-btn');
  audioPreviewArea = document.getElementById('audio-preview-area');
  recordingIndicator = document.getElementById('recording-indicator');

  if (!inputForm || !inputEl) return;

  // Load history from server
  fetch('/api/input-history')
    .then(r => r.json())
    .then(data => {
      state.messageHistory = data.messages || [];
      updateHistoryButtons();
    })
    .catch(() => {});

  // Restore draft
  fetch('/api/input-draft')
    .then(r => r.json())
    .then(data => {
      if (data.draft && !inputEl.value) {
        inputEl.value = data.draft;
      }
    })
    .catch(() => {});

  // Auto-resize textarea
  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    inputEl.style.overflowY = inputEl.scrollHeight > 200 ? 'auto' : 'hidden';
  }

  // Draft autosave + auto-resize
  inputEl.addEventListener('input', () => {
    saveDraft();
    autoResize();
  });

  async function submitMessage() {
    let message = inputEl.value.trim();
    if (!message && pendingImages.length === 0 && pendingFiles.length === 0) return;

    // Prepend quoted text if replying
    const { isQuoting, getQuotedText, clearQuote } = await import('./quote.js');
    if (isQuoting()) {
      const quote = getQuotedText();
      if (quote) {
        message = `${quote}\n\n${message}`;
      }
      clearQuote();
    }

    pushHistory(inputEl.value.trim());
    state.historyIndex = -1;
    state.historyDraft = '';
    inputEl.value = '';
    autoResize();
    fetch('/api/input-draft', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    }).catch(() => {});
    sendMessage(message);
  }

  // Form submission (Send button)
  inputForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitMessage();
  });

  // Enter sends, Shift+Enter adds newline
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  });

  // Escape key cancels processing
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.isProcessing) {
      e.preventDefault();
      cancelProcessing();
    }
  });

  // Arrow up/down for history (only when cursor is on first/last line)
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && state.messageHistory.length > 0) {
      // Only navigate history if cursor is on the first line
      const beforeCursor = inputEl.value.substring(0, inputEl.selectionStart);
      if (!beforeCursor.includes('\n')) {
        e.preventDefault();
        navigateHistory(1);
        autoResize();
      }
    } else if (e.key === 'ArrowDown' && state.historyIndex >= 0) {
      // Only navigate history if cursor is on the last line
      const afterCursor = inputEl.value.substring(inputEl.selectionEnd);
      if (!afterCursor.includes('\n')) {
        e.preventDefault();
        navigateHistory(-1);
        autoResize();
      }
    }
  });

  // History buttons
  document.getElementById('history-up').addEventListener('click', () => navigateHistory(1));
  document.getElementById('history-down').addEventListener('click', () => navigateHistory(-1));

  // Focus input on any key press (skip if typing in another input/textarea or a modal is open)
  document.addEventListener('keydown', (e) => {
    if (e.target !== inputEl && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      if (e.target.closest('.modal, .tab-menu')) return;
      inputEl.focus();
    }
  });

  // --- Drag and drop images ---

  const dropZone = document.getElementById('input-form');
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = e.dataTransfer?.files;
    if (files) {
      for (const file of files) {
        addAttachment(file);
      }
    }
  });

  // --- Image attachment handlers ---

  // Clipboard paste: detect files/images
  inputEl.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file') {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addAttachment(file);
        return;
      }
    }
  });

  // Attach button → file picker
  if (attachBtn) {
    attachBtn.addEventListener('click', () => attachFileInput.click());
  }
  if (attachFileInput) {
    attachFileInput.addEventListener('change', () => {
      for (const file of attachFileInput.files) {
        addAttachment(file);
      }
      attachFileInput.value = '';
    });
  }

  // Record button — tap to start, tap to stop
  if (recordBtn) {
    recordBtn.addEventListener('click', () => {
      if (isNativeApp) {
        // Native iOS app — use bridge for recording + transcription
        if (recordBtn.classList.contains('recording')) {
          window.webkit.messageHandlers.gellyfish.postMessage({ action: 'stopRecording' });
          recordBtn.classList.remove('recording');
          recordingIndicator.classList.remove('active');
          recordingIndicator.innerHTML = '';
          clearInterval(recordingTimerInterval);
        } else {
          const language = localStorage.getItem('voice-language') || 'en';
          window.webkit.messageHandlers.gellyfish.postMessage({ action: 'startRecording', language });
          recordBtn.classList.add('recording');
          recordingStartTime = Date.now();
          recordingIndicator.innerHTML = '<span class="rec-dot"></span><span class="rec-timer">0:00</span>';
          recordingIndicator.classList.add('active');
          recordingTimerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
            const mins = Math.floor(elapsed / 60);
            const secs = String(elapsed % 60).padStart(2, '0');
            const timerEl = recordingIndicator.querySelector('.rec-timer');
            if (timerEl) timerEl.textContent = `${mins}:${secs}`;
          }, 500);
        }
      } else {
        // Browser — use MediaRecorder + server-side Whisper
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          stopRecording();
        } else {
          startRecording();
        }
      }
    });
  }

  // Language picker — persist selection
  const voiceLangSelect = document.getElementById('voice-language');
  if (voiceLangSelect) {
    voiceLangSelect.value = localStorage.getItem('voice-language') || 'en';
    voiceLangSelect.addEventListener('change', () => {
      localStorage.setItem('voice-language', voiceLangSelect.value);
    });
  }

  // Native app bridge callback — receives transcript from iOS
  if (isNativeApp) {
    window.gellyfish = window.gellyfish || {};
    window.gellyfish.onTranscript = (text) => {
      if (!text) return;
      const existing = inputEl.value;
      inputEl.value = existing ? existing + ' ' + text.trim() : text.trim();
      inputEl.dispatchEvent(new Event('input'));
      inputEl.focus();
      // Clean up recording UI
      recordBtn.classList.remove('recording');
      recordingIndicator.classList.remove('active');
      recordingIndicator.innerHTML = '';
      clearInterval(recordingTimerInterval);
    };
  }
}

// --- Image helpers ---

function addImageFile(file) {
  if (file.size > MAX_IMAGE_SIZE) {
    alert(`Image too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 5MB.`);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const base64 = dataUrl.split(',')[1];
    const mediaType = file.type || 'image/png';
    pendingImages.push({ dataUrl, mediaType, base64 });
    renderImagePreviews();
    inputEl.focus();
  };
  reader.readAsDataURL(file);
}

function renderImagePreviews() {
  imagePreviewArea.innerHTML = '';
  pendingImages.forEach((img, i) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'image-preview';
    const imgEl = document.createElement('img');
    imgEl.src = img.dataUrl;
    wrapper.appendChild(imgEl);
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '\u00D7';
    removeBtn.addEventListener('click', () => {
      pendingImages.splice(i, 1);
      renderImagePreviews();
    });
    wrapper.appendChild(removeBtn);
    imagePreviewArea.appendChild(wrapper);
  });
}

function clearPendingImages() {
  pendingImages.length = 0;
  imagePreviewArea.innerHTML = '';
}

/** Queue a base64 image as a pending attachment (used by iOS bridge). */
export function queueImage(base64, mediaType) {
  const dataUrl = `data:${mediaType};base64,${base64}`;
  pendingImages.push({ dataUrl, mediaType, base64 });
  renderImagePreviews();
  if (inputEl) inputEl.focus();
}

// --- File attachment routing ---

function getFileExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.substring(dot + 1).toLowerCase() : '';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

function showToast(msg) {
  // Reuse existing toast or create one
  let toast = document.getElementById('file-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'file-toast';
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#ef4444;color:#fff;padding:8px 16px;border-radius:8px;font-size:0.85rem;z-index:9999;opacity:0;transition:opacity 0.3s';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

function addAttachment(file) {
  const ext = getFileExtension(file.name);

  if (file.type.startsWith('image/')) {
    addImageFile(file);
  } else if (ext === 'pdf' || file.type === 'application/pdf') {
    addPdfFile(file);
  } else if (TEXT_EXTENSIONS.has(ext)) {
    addTextFile(file);
  } else {
    showToast("This file type isn't supported. Try images, PDFs, or text files.");
  }
}

function addPdfFile(file) {
  if (file.size > MAX_PDF_SIZE) {
    showToast(`PDF too large (${formatSize(file.size)}). Max ${formatSize(MAX_PDF_SIZE)}.`);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    pendingFiles.push({
      name: file.name,
      size: file.size,
      type: 'pdf',
      contentBlock: {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      },
    });
    renderFileChips();
    inputEl.focus();
  };
  reader.readAsDataURL(file);
}

function addTextFile(file) {
  if (file.size > MAX_TEXT_SIZE) {
    showToast(`Text file too large (${formatSize(file.size)}). Max ${formatSize(MAX_TEXT_SIZE)}.`);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const text = reader.result;
    pendingFiles.push({
      name: file.name,
      size: file.size,
      type: 'text',
      contentBlock: {
        type: 'text',
        text: `Contents of ${file.name}:\n\n${text}`,
      },
    });
    renderFileChips();
    inputEl.focus();
  };
  reader.readAsText(file);
}

function renderFileChips() {
  // Remove existing chips (keep image previews)
  imagePreviewArea.querySelectorAll('.file-chip').forEach(el => el.remove());
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    const icon = f.type === 'pdf' ? '\uD83D\uDCC4' : '\uD83D\uDCDD';
    chip.innerHTML = `<span class="file-chip-icon">${icon}</span><span class="file-chip-name">${escapeHtml(f.name)}</span><span class="file-chip-size">(${formatSize(f.size)})</span>`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'file-chip-remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.addEventListener('click', () => {
      pendingFiles.splice(i, 1);
      renderFileChips();
    });
    chip.appendChild(removeBtn);
    imagePreviewArea.appendChild(chip);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function clearPendingFiles() {
  pendingFiles.length = 0;
  imagePreviewArea.querySelectorAll('.file-chip').forEach(el => el.remove());
}

// --- Voice recording ---

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordingChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(recordingChunks, { type: 'audio/webm' });
      pendingAudioBlob = blob;
      showAudioPreview(blob);
    };

    mediaRecorder.start(250); // collect data every 250ms
    recordingStartTime = Date.now();
    recordBtn.classList.add('recording');

    // Show recording indicator with timer
    recordingIndicator.innerHTML = '<span class="rec-dot"></span><span class="rec-timer">0:00</span>';
    recordingIndicator.classList.add('active');
    recordingTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = String(elapsed % 60).padStart(2, '0');
      const timerEl = recordingIndicator.querySelector('.rec-timer');
      if (timerEl) timerEl.textContent = `${mins}:${secs}`;
    }, 500);

    // Auto-stop at max duration
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        stopRecording();
      }
    }, MAX_RECORDING_MS);
  } catch (err) {
    console.error('Microphone access denied:', err);
    alert('Microphone access is required for voice input.');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  recordBtn.classList.remove('recording');
  recordingIndicator.classList.remove('active');
  recordingIndicator.innerHTML = '';
  clearInterval(recordingTimerInterval);
  recordingTimerInterval = null;
}

function showAudioPreview(blob) {
  const url = URL.createObjectURL(blob);
  const duration = recordingStartTime ? ((Date.now() - recordingStartTime) / 1000).toFixed(1) : '?';

  audioPreviewArea.innerHTML = `
    <div class="audio-preview">
      <button type="button" class="audio-play-btn" title="Play">&#9654;</button>
      <span class="audio-duration">${duration}s</span>
      <button type="button" class="audio-transcribe-btn">Transcribe</button>
      <button type="button" class="audio-remove-btn" title="Remove">&times;</button>
      <audio src="${url}"></audio>
    </div>
  `;

  const audioEl = audioPreviewArea.querySelector('audio');
  const playBtn = audioPreviewArea.querySelector('.audio-play-btn');
  playBtn.addEventListener('click', () => {
    if (audioEl.paused) {
      audioEl.play();
      playBtn.innerHTML = '&#9646;&#9646;';
    } else {
      audioEl.pause();
      playBtn.innerHTML = '&#9654;';
    }
  });
  audioEl.addEventListener('ended', () => { playBtn.innerHTML = '&#9654;'; });

  audioPreviewArea.querySelector('.audio-transcribe-btn').addEventListener('click', () => transcribeAudio());
  audioPreviewArea.querySelector('.audio-remove-btn').addEventListener('click', () => clearAudioPreview());
}

function clearAudioPreview() {
  const audioEl = audioPreviewArea.querySelector('audio');
  if (audioEl) URL.revokeObjectURL(audioEl.src);
  audioPreviewArea.innerHTML = '';
  pendingAudioBlob = null;
}

async function transcribeAudio() {
  if (!pendingAudioBlob) return;

  const transcribeBtn = audioPreviewArea.querySelector('.audio-transcribe-btn');
  if (transcribeBtn) {
    transcribeBtn.disabled = true;
    transcribeBtn.textContent = 'Transcribing...';
  }

  const language = localStorage.getItem('voice-language') || 'en';
  const formData = new FormData();
  formData.append('audio', pendingAudioBlob, 'recording.webm');
  formData.append('language', language);

  try {
    const resp = await fetch('/api/transcribe', { method: 'POST', body: formData });
    const data = await resp.json();

    if (resp.ok && data.transcript) {
      // Insert transcript into input area for review
      const existing = inputEl.value;
      inputEl.value = existing ? existing + ' ' + data.transcript.trim() : data.transcript.trim();
      inputEl.dispatchEvent(new Event('input')); // trigger auto-resize
      inputEl.focus();
      clearAudioPreview();
    } else {
      alert(data.error || 'Transcription failed');
      if (transcribeBtn) {
        transcribeBtn.disabled = false;
        transcribeBtn.textContent = 'Transcribe';
      }
    }
  } catch (err) {
    console.error('Transcription error:', err);
    alert('Transcription failed — check server connection');
    if (transcribeBtn) {
      transcribeBtn.disabled = false;
      transcribeBtn.textContent = 'Transcribe';
    }
  }
}
