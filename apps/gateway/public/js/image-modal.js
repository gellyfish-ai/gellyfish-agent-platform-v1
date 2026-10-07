/**
 * Full-screen image modal for viewing any chat image at full resolution.
 * Layer 4: no imports from other modules.
 */

let overlay = null;

function createOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'image-modal-overlay';
  overlay.innerHTML = `
    <button class="image-modal-close" title="Close">&times;</button>
    <a class="image-modal-download" title="Download" download="screenshot.png">&#x2B73;</a>
    <img class="image-modal-img" />
  `;
  overlay.querySelector('.image-modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });
  document.body.appendChild(overlay);
  return overlay;
}

function close() {
  if (overlay) overlay.classList.remove('open');
}

/**
 * Open the image modal with the given src URL.
 */
export function openImageModal(src, filename) {
  const ov = createOverlay();
  const img = ov.querySelector('.image-modal-img');
  const dl = ov.querySelector('.image-modal-download');
  img.src = src;
  dl.href = src;
  dl.download = filename || 'image.png';
  ov.classList.add('open');
}

/**
 * Make an <img> element clickable to open in the modal.
 */
export function makeImageClickable(imgEl, filename) {
  imgEl.style.cursor = 'pointer';
  imgEl.addEventListener('click', () => openImageModal(imgEl.src, filename));
}
