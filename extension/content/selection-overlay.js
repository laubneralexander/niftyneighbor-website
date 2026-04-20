(async () => {
  if (window.__screenFellowSelectionActive) return;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'startSelection') startSelection();
  });

  function startSelection() {
    if (window.__screenFellowSelectionActive) return;
    window.__screenFellowSelectionActive = true;

    // Build overlay
    const overlay = document.createElement('div');
    overlay.id = '__screenfellow-overlay';
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      cursor: crosshair;
      background: rgba(0,0,0,0);
    `;

    // Dark mask (4 edges around the selection rect)
    const mask = document.createElement('canvas');
    mask.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    mask.width = window.innerWidth;
    mask.height = window.innerHeight;
    overlay.appendChild(mask);
    const ctx = mask.getContext('2d');

    // Selection rect indicator
    const selRect = document.createElement('div');
    selRect.style.cssText = `
      position: absolute;
      border: 2px solid rgba(255,255,255,0.7);
      box-shadow: 0 0 0 1px rgba(0,0,0,0.4);
      display: none;
      pointer-events: none;
    `;
    overlay.appendChild(selRect);

    // ESC hint
    const hint = document.createElement('div');
    hint.style.cssText = `
      position: fixed;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.75);
      color: #fff;
      padding: 6px 14px;
      border-radius: 99px;
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      pointer-events: none;
      z-index: 2147483647;
    `;
    hint.textContent = 'Draw a selection — ESC to cancel';
    document.body.appendChild(hint);
    document.body.appendChild(overlay);

    let startX = 0, startY = 0, drawing = false;

    function drawMask(x, y, w, h) {
      ctx.clearRect(0, 0, mask.width, mask.height);
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      // Top
      ctx.fillRect(0, 0, mask.width, y);
      // Bottom
      ctx.fillRect(0, y + h, mask.width, mask.height - y - h);
      // Left
      ctx.fillRect(0, y, x, h);
      // Right
      ctx.fillRect(x + w, y, mask.width - x - w, h);
    }

    overlay.addEventListener('mousedown', (e) => {
      e.preventDefault();
      drawing = true;
      startX = e.clientX;
      startY = e.clientY;
      selRect.style.display = 'block';
      selRect.style.left = startX + 'px';
      selRect.style.top = startY + 'px';
      selRect.style.width = '0px';
      selRect.style.height = '0px';
    });

    overlay.addEventListener('mousemove', (e) => {
      if (!drawing) return;
      const x = Math.min(e.clientX, startX);
      const y = Math.min(e.clientY, startY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);

      selRect.style.left = x + 'px';
      selRect.style.top = y + 'px';
      selRect.style.width = w + 'px';
      selRect.style.height = h + 'px';

      drawMask(x, y, w, h);
    });

    overlay.addEventListener('mouseup', async (e) => {
      if (!drawing) return;
      drawing = false;

      const x = Math.min(e.clientX, startX);
      const y = Math.min(e.clientY, startY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);

      cleanup();

      if (w < 10 || h < 10) return; // Too small, ignore

      // Wait for the overlay to be painted away before capturing
      await new Promise(r => setTimeout(r, 150));

      // Capture the full viewport then crop
      const dpr = window.devicePixelRatio || 1;
      const response = await chrome.runtime.sendMessage({ action: 'captureVisibleForStitch' });
      if (!response || !response.dataUrl) return;

      const croppedDataUrl = await cropImage(response.dataUrl, x * dpr, y * dpr, w * dpr, h * dpr);

      await chrome.runtime.sendMessage({
        action: 'selectionCaptured',
        dataUrl: croppedDataUrl,
        dpr
      });
    });

    document.addEventListener('keydown', onKeyDown);

    function onKeyDown(e) {
      if (e.key === 'Escape') cleanup();
    }

    function cleanup() {
      overlay.remove();
      hint.remove();
      document.removeEventListener('keydown', onKeyDown);
      window.__screenFellowSelectionActive = false;
    }
  }

  async function cropImage(dataUrl, x, y, w, h) {
    const img = await loadImage(dataUrl);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return blobToDataUrl(blob);
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }
})();
