(async () => {
  // Guard: prevent double-injection
  if (window.__stitchSnapCaptureActive) return;
  window.__stitchSnapCaptureActive = true;

  const MAX_HEIGHT = 20000;
  const SCROLL_PAUSE = 350; // ms to wait after each scroll for content to settle

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'startFullPageCapture') {
      runFullPageCapture().then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  async function runFullPageCapture() {
    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;

    // Hide scrollbars during capture (visual only, scroll still works)
    const scrollStyle = document.createElement('style');
    scrollStyle.id = '__screenfellow-noscroll';
    scrollStyle.textContent = '::-webkit-scrollbar{width:0!important;height:0!important}*{scrollbar-width:none!important}';
    document.head.appendChild(scrollStyle);

    const headerHeight = detectStickyHeaderHeight();

    window.scrollTo(0, 0);
    await pause(200);

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const devicePixelRatio = window.devicePixelRatio || 1;

    const screenshots = [];
    let totalCapturedHeight = 0;
    let lastDocumentHeight = getDocumentHeight();

    let prevScrollTop = -1;

    while (true) {
      const scrollTop = window.scrollY;

      // Capture current viewport
      const response = await chrome.runtime.sendMessage({ action: 'captureVisibleForStitch' });
      if (!response || !response.dataUrl) break;

      // How many CSS pixels from this frame are new content
      const isFirstFrame = screenshots.length === 0;
      const frameHeaderHeight = isFirstFrame ? 0 : headerHeight;
      // Actual visible new content height: distance scrolled since last frame minus repeated header
      const newContentHeight = isFirstFrame
        ? Math.min(viewportHeight, lastDocumentHeight)
        : Math.min(viewportHeight - frameHeaderHeight, lastDocumentHeight - scrollTop);

      screenshots.push({
        dataUrl: response.dataUrl,
        scrollTop,
        viewportHeight,
        captureHeight: newContentHeight,
        headerHeight: frameHeaderHeight,
        devicePixelRatio
      });

      totalCapturedHeight += newContentHeight;

      if (totalCapturedHeight >= MAX_HEIGHT) {
        console.warn('ScreenFellow: page exceeds 20,000px, truncating.');
        break;
      }

      // Check if we've reached the bottom
      if (scrollTop + viewportHeight >= lastDocumentHeight) break;

      // Scroll down by one viewport minus the sticky header
      const nextScroll = scrollTop + viewportHeight - headerHeight;
      window.scrollTo(0, nextScroll);
      await pause(SCROLL_PAUSE);

      // Guard: if scroll didn't move (clamped at bottom), stop
      if (window.scrollY === scrollTop) break;

      // Infinite-scroll guard: if document grew, stop here
      const newDocHeight = getDocumentHeight();
      if (newDocHeight > lastDocumentHeight + 50) {
        console.warn('ScreenFellow: infinite scroll detected, stopping capture.');
        break;
      }
      lastDocumentHeight = newDocHeight;
    }

    // Restore scrollbars and scroll position
    document.getElementById('__screenfellow-noscroll')?.remove();
    window.scrollTo(originalScrollX, originalScrollY);

    // Stitch and send result to background
    const stitchedDataUrl = await stitchScreenshots(screenshots, viewportWidth * devicePixelRatio, devicePixelRatio);

    await chrome.runtime.sendMessage({
      action: 'selectionCaptured',
      dataUrl: stitchedDataUrl,
      dpr: devicePixelRatio
    });
  }

  function detectStickyHeaderHeight() {
    let maxHeight = 0;
    const elements = document.querySelectorAll('*');

    for (const el of elements) {
      const style = window.getComputedStyle(el);
      const position = style.position;

      if (position === 'fixed' || position === 'sticky') {
        const rect = el.getBoundingClientRect();
        // Only count elements at the top of the viewport
        if (rect.top <= 5 && rect.height > 0 && rect.width > window.innerWidth * 0.3) {
          maxHeight = Math.max(maxHeight, rect.bottom);
        }
      }
    }

    return Math.ceil(maxHeight);
  }

  async function stitchScreenshots(shots, pxWidth, dpr) {
    if (shots.length === 0) return null;
    if (shots.length === 1) return shots[0].dataUrl;

    // Load all images
    const images = await Promise.all(shots.map(s => loadImage(s.dataUrl)));

    // Each shot.captureHeight is already the new-content height (header excluded)
    let totalPxHeight = 0;
    const segmentHeights = shots.map(s => {
      const srcY = s.headerHeight * dpr;   // where to start reading in the screenshot
      const h = s.captureHeight * dpr;     // how many device pixels to copy
      totalPxHeight += h;
      return { srcY, h };
    });

    totalPxHeight = Math.min(totalPxHeight, MAX_HEIGHT * dpr);

    const canvas = new OffscreenCanvas(pxWidth, totalPxHeight);
    const ctx = canvas.getContext('2d');

    let yOffset = 0;
    for (let i = 0; i < images.length; i++) {
      const { srcY, h } = segmentHeights[i];
      const drawH = Math.min(h, totalPxHeight - yOffset);
      if (drawH <= 0) break;

      ctx.drawImage(
        images[i],
        0, srcY,               // source: skip sticky header pixels
        pxWidth, drawH,        // source width, height
        0, yOffset,            // dest x, y
        pxWidth, drawH         // dest width, height
      );
      yOffset += drawH;
    }

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

  function getDocumentHeight() {
    return Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight
    );
  }

  function pause(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
})();
