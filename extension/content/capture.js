(async () => {
  // Guard: prevent double-injection
  if (window.__stitchSnapCaptureActive) return;
  window.__stitchSnapCaptureActive = true;

  const SCROLL_PAUSE = 600; // ms to wait after each scroll for content to settle

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'startFullPageCapture') {
      runFullPageCapture().then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  async function runFullPageCapture() {
    const { fullpage_pixel_limit = 50000 } = await chrome.storage.local.get(['fullpage_pixel_limit']);
    const MAX_HEIGHT = fullpage_pixel_limit;

    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;

    // Hide scrollbars during capture (visual only, scroll still works)
    const scrollStyle = document.createElement('style');
    scrollStyle.id = '__screenfellow-noscroll';
    scrollStyle.textContent = '::-webkit-scrollbar{width:0!important;height:0!important}*{scrollbar-width:none!important}';
    document.head.appendChild(scrollStyle);

    const { height: headerHeight, elements: headerEls } = detectStickyHeader();

    window.scrollTo(0, 0);
    await pause(200);

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const devicePixelRatio = window.devicePixelRatio || 1;

    // Pre-scroll pass: trigger lazy-loaded images without capturing.
    // Uses the initial doc height as ceiling so infinite-scroll is never triggered.
    chrome.storage.local.set({ _sfProgress: { stage: 'analyzing', pct: 5 } });
    const initialDocHeight = Math.min(getDocumentHeight(), MAX_HEIGHT);
    await preScrollForLazyLoad(initialDocHeight);
    window.scrollTo(0, 0);
    // Wait for any lazy-loaded content to finish expanding before we lock in the document height
    await waitForDocumentStable();
    await pause(200);

    // Freeze JS scroll animations (GSAP, Lenis, etc.) and CSS transitions
    freezeScrollAnimations();

    // Hide non-header fixed/sticky elements so they don't appear in every stitched frame.
    // The sticky header itself is already handled via headerHeight cropping.
    const hiddenElements = hideNonHeaderFixedElements(headerEls);
    const parallaxElements = fixParallaxBackgrounds();

    const screenshots = [];
    let totalCapturedHeight = 0;
    let wasTruncated = false;
    let lastDocumentHeight = getDocumentHeight();
    const estimatedFrames = Math.max(1, Math.ceil(Math.min(lastDocumentHeight, MAX_HEIGHT) / viewportHeight));
    chrome.storage.local.set({ _sfProgress: { stage: 'capturing', pct: 25 } });

    // Track the scroll position at the time of the previous capture so we know exactly
    // how many pixels were actually scrolled — critical for the last frame where the browser
    // can't scroll as far as requested (clamped at documentHeight - viewportHeight).
    let prevCaptureScrollTop = 0;

    while (true) {
      const scrollTop = window.scrollY;

      // Re-hide anything that just became position:fixed due to JS scroll animations
      // (e.g. GSAP ScrollTrigger pins elements as you scroll to their trigger point)
      const newlyFixed = hideNewlyPinnedElements(hiddenElements, headerEls);
      hiddenElements.push(...newlyFixed);

      // Capture current viewport
      const response = await chrome.runtime.sendMessage({ action: 'captureVisibleForStitch' });
      if (!response || !response.dataUrl) break;

      const isFirstFrame = screenshots.length === 0;

      let frameHeaderHeight, newContentHeight;
      if (isFirstFrame) {
        frameHeaderHeight = 0;
        newContentHeight = Math.min(viewportHeight, lastDocumentHeight);
      } else {
        // Use the ACTUAL scroll distance, not the intended step.
        // On the last frame the browser clamps scrollY to (docHeight - viewport), so
        // actualScrolled can be much less than (viewportHeight - headerHeight).
        // Using the assumed step instead would re-copy already-captured content.
        const actualScrolled = scrollTop - prevCaptureScrollTop;
        // Start reading the screenshot from the bottom of the already-captured region.
        // Always skip at least the persistent sticky header.
        frameHeaderHeight = Math.max(headerHeight, viewportHeight - actualScrolled);
        newContentHeight = Math.max(0, viewportHeight - frameHeaderHeight);
      }
      prevCaptureScrollTop = scrollTop;

      if (newContentHeight <= 0) break; // nothing new to add

      screenshots.push({
        dataUrl: response.dataUrl,
        scrollTop,
        viewportHeight,
        captureHeight: newContentHeight,
        headerHeight: frameHeaderHeight,
        devicePixelRatio
      });

      totalCapturedHeight += newContentHeight;
      const capturePct = Math.min(85, Math.round(25 + (screenshots.length / estimatedFrames) * 60));
      chrome.storage.local.set({ _sfProgress: { stage: 'capturing', pct: capturePct } });

      if (totalCapturedHeight >= MAX_HEIGHT) {
        wasTruncated = true;
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

      // Infinite-scroll guard: distinguish lazy-loaded content (one-time growth) from
      // true infinite scroll (keeps growing on every step).
      // After the initial SCROLL_PAUSE, lazy content may still be loading — so if the
      // document grew we wait another beat and check again. Only bail if it's STILL
      // growing (second check also shows increase), which means a feed is appending.
      let newDocHeight = getDocumentHeight();
      if (newDocHeight > lastDocumentHeight + 300) {
        await pause(600);
        const confirmedHeight = getDocumentHeight();
        if (confirmedHeight > newDocHeight + 200) {
          console.warn('ScreenFellow: infinite scroll detected, stopping capture.');
          break;
        }
        newDocHeight = confirmedHeight;
      }
      lastDocumentHeight = newDocHeight;
    }

    // Restore everything
    restoreHiddenElements(hiddenElements);
    restoreParallaxBackgrounds(parallaxElements);
    restoreScrollAnimations();
    document.getElementById('__screenfellow-noscroll')?.remove();
    window.scrollTo(originalScrollX, originalScrollY);

    // Stitch and send result to background
    chrome.storage.local.set({ _sfProgress: { stage: 'stitching', pct: 90 } });
    const stitchedDataUrl = await stitchScreenshots(screenshots, viewportWidth * devicePixelRatio, devicePixelRatio, MAX_HEIGHT);

    chrome.storage.local.remove(['_sfProgress']);
    await chrome.runtime.sendMessage({
      action: 'selectionCaptured',
      dataUrl: stitchedDataUrl,
      dpr: devicePixelRatio,
      truncated: wasTruncated,
      pixelLimit: MAX_HEIGHT,
      isFullPage: true
    });
  }

  function freezeScrollAnimations() {
    // Pause CSS animations and transitions so nothing moves during capture
    const style = document.createElement('style');
    style.id = '__sf-anim-freeze';
    style.textContent = '*,*::before,*::after{animation-play-state:paused!important;transition-duration:0s!important;transition-delay:0s!important}';
    document.head.appendChild(style);

    // Kill GSAP ScrollTrigger instances (covers both global and gsap-namespaced access)
    try {
      const ST = window.ScrollTrigger || window.gsap?.ScrollTrigger;
      if (ST) ST.getAll().forEach(t => t.kill());
      window.gsap?.globalTimeline?.pause();
    } catch (_) {}

    // Stop Lenis smooth-scroll
    try { window.lenis?.stop(); } catch (_) {}

    // Stop Locomotive Scroll
    try { window.locomotive?.stop(); } catch (_) {}
  }

  function restoreScrollAnimations() {
    document.getElementById('__sf-anim-freeze')?.remove();
  }

  function fixParallaxBackgrounds() {
    const restored = [];
    document.querySelectorAll('*').forEach(el => {
      if (!window.getComputedStyle(el).backgroundAttachment.includes('fixed')) return;
      restored.push({ el, attachment: el.style.backgroundAttachment });
      el.style.backgroundAttachment = 'scroll';
    });
    return restored;
  }

  function restoreParallaxBackgrounds(restored) {
    restored.forEach(({ el, attachment }) => { el.style.backgroundAttachment = attachment; });
  }

  // Only hide fixed/sticky elements that are NOT part of the real header recorded at scrollY=0.
  function hideNonHeaderFixedElements(headerEls) {
    const hidden = [];
    document.querySelectorAll('*').forEach(el => {
      const pos = window.getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') return;
      if (headerEls.has(el)) return;
      hidden.push({ el, vis: el.style.visibility });
      el.style.visibility = 'hidden';
    });
    return hidden;
  }

  function restoreHiddenElements(hidden) {
    hidden.forEach(({ el, vis }) => { el.style.visibility = vis; });
  }

  // Re-check after each scroll step: hide anything newly pinned that is not the real header.
  // Using the recorded headerEls set avoids false-positives where a content section becomes
  // sticky at top:0 mid-scroll (same position as the nav bar) and gets mistaken for a header.
  function hideNewlyPinnedElements(alreadyHidden, headerEls) {
    const known = new Set(alreadyHidden.map(h => h.el));
    const newlyHidden = [];
    document.querySelectorAll('*').forEach(el => {
      if (known.has(el)) return;
      if (headerEls.has(el)) return;
      const pos = window.getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') return;
      newlyHidden.push({ el, vis: el.style.visibility });
      el.style.visibility = 'hidden';
    });
    return newlyHidden;
  }

  async function preScrollForLazyLoad(maxHeight) {
    const viewH = window.innerHeight;
    let pos = viewH;
    while (pos < maxHeight) {
      window.scrollTo(0, pos);
      await pause(150);
      pos += viewH;
    }
  }

  // Poll until document height stops changing, so lazy-loaded content settles before capture.
  async function waitForDocumentStable(maxWaitMs = 2000, pollMs = 200) {
    const deadline = Date.now() + maxWaitMs;
    let prev = getDocumentHeight();
    while (Date.now() < deadline) {
      await pause(pollMs);
      const h = getDocumentHeight();
      if (h === prev) return;
      prev = h;
    }
  }

  // Called once at scrollY=0 to record which elements ARE the real persistent header.
  // Returns both the header crop height and the exact element set, so later checks
  // can use identity rather than positional heuristics — preventing content sections
  // that become sticky at top:0 mid-scroll from being mistaken for the nav header.
  function detectStickyHeader() {
    const elements = new Set();
    let maxHeight = 0;
    for (const el of document.querySelectorAll('*')) {
      const pos = window.getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const rect = el.getBoundingClientRect();
      if (rect.top <= 5 && rect.height > 0 && rect.width > window.innerWidth * 0.3) {
        maxHeight = Math.max(maxHeight, rect.bottom);
        elements.add(el);
      }
    }
    return { height: Math.ceil(maxHeight), elements };
  }

  async function stitchScreenshots(shots, pxWidth, dpr, maxHeight = 50000) {
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

    // Cap to Chrome's canvas pixel limit (~268M px) and MAX_HEIGHT
    const maxSafeHeight = Math.floor(250_000_000 / pxWidth);
    totalPxHeight = Math.min(totalPxHeight, maxHeight * dpr, maxSafeHeight);

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
