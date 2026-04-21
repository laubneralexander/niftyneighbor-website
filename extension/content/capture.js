(async () => {
  if (window.__stitchSnapCaptureActive) return;
  window.__stitchSnapCaptureActive = true;

  const SCROLL_PAUSE = 600;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'startFullPageCapture') {
      runFullPageCapture().then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  async function runFullPageCapture() {
    const { fullpage_pixel_limit = 50000 } = await chrome.storage.local.get(['fullpage_pixel_limit']);
    const MAX_HEIGHT = fullpage_pixel_limit;

    const originalScrollY = window.scrollY || document.documentElement.scrollTop || 0;

    // Hide scrollbars during capture
    const scrollStyle = document.createElement('style');
    scrollStyle.id = '__screenfellow-noscroll';
    scrollStyle.textContent = '::-webkit-scrollbar{width:0!important;height:0!important}*{scrollbar-width:none!important}';
    document.head.appendChild(scrollStyle);

    // Force instant scroll BEFORE any probe — defeats CSS scroll-behavior:smooth and Lenis
    const instantScrollStyle = document.createElement('style');
    instantScrollStyle.id = '__sf-instant-scroll';
    // Also force overflow-y:auto + height:auto — Lenis/Locomotive set overflow:hidden + height:100%
    // on <html>/<body> to create a fixed viewport; overriding these lets window.scrollTop work.
    instantScrollStyle.textContent = 'html,body{scroll-behavior:auto!important;overflow-y:auto!important;height:auto!important}';
    document.head.appendChild(instantScrollStyle);
    document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
    document.documentElement.style.setProperty('overflow-y', 'auto', 'important');
    document.documentElement.style.setProperty('height', 'auto', 'important');
    document.body.style.setProperty('scroll-behavior', 'auto', 'important');
    document.body.style.setProperty('overflow-y', 'auto', 'important');
    document.body.style.setProperty('height', 'auto', 'important');

    // Kill smooth-scroll libraries before we probe
    killSmoothScrollLibraries();
    await chrome.runtime.sendMessage({ action: 'killLenisMainWorld' });
    await pause(120); // let killed libs finish their current RAF frame

    // Suppress requestAnimationFrame to stop smooth-scroll library animation loops.
    const _origRAF = window.requestAnimationFrame;
    window.requestAnimationFrame = (_cb) => _origRAF(() => {});

    const { height: headerHeight, elements: headerEls } = detectStickyHeader();

    nativeScrollTo(0);
    await pause(250);

    // Detect whether window scrolls or a custom container is used
    const scrollEl = detectScrollContainer();
    const doScrollTo  = (y) => { if (scrollEl) scrollEl.scrollTop = y; else nativeScrollTo(y); };
    const getScrollY  = ()  => scrollEl ? scrollEl.scrollTop : getNativeScrollY();
    const getDocH     = ()  => scrollEl ? scrollEl.scrollHeight : getDocumentHeight();

    const viewportWidth  = window.innerWidth;
    const viewportHeight = scrollEl ? scrollEl.clientHeight : window.innerHeight;
    const devicePixelRatio = window.devicePixelRatio || 1;

    chrome.storage.local.set({ _sfProgress: { stage: 'analyzing', pct: 5 } });
    const initialDocHeight = Math.min(getDocH(), MAX_HEIGHT);
    await preScrollForLazyLoad(initialDocHeight, doScrollTo, viewportHeight);
    doScrollTo(0);
    await waitForDocumentStable(getDocH);
    await pause(200);

    freezeScrollAnimations();

    const hiddenElements = hideNonHeaderFixedElements(headerEls);
    const parallaxElements = fixParallaxBackgrounds();

    const screenshots = [];
    let totalCapturedHeight = 0;
    let wasTruncated = false;
    let lastDocumentHeight = getDocH();
    const estimatedFrames = Math.max(1, Math.ceil(Math.min(lastDocumentHeight, MAX_HEIGHT) / viewportHeight));
    chrome.storage.local.set({ _sfProgress: { stage: 'capturing', pct: 25 } });

    // Install scrollTop interceptor in the page's main world and lock at 0.
    // This blocks smooth-scroll libraries (Lenis etc.) from resetting scroll
    // during capture — even when the instance is in a module-scoped closure.
    await chrome.runtime.sendMessage({ action: 'setupScrollLock' });
    await chrome.runtime.sendMessage({ action: 'scrollToLocked', y: 0 });
    await pause(200);

    let prevCaptureScrollTop = 0;

    while (true) {
      const scrollTop = getScrollY();

      const newlyFixed = hideNewlyPinnedElements(hiddenElements, headerEls);
      hiddenElements.push(...newlyFixed);

      const response = await chrome.runtime.sendMessage({ action: 'captureVisibleForStitch' });
      if (!response || !response.dataUrl) break;

      const isFirstFrame = screenshots.length === 0;
      let frameHeaderHeight, newContentHeight;
      if (isFirstFrame) {
        frameHeaderHeight = 0;
        newContentHeight = Math.min(viewportHeight, lastDocumentHeight);
      } else {
        const actualScrolled = scrollTop - prevCaptureScrollTop;
        frameHeaderHeight = Math.max(headerHeight, viewportHeight - actualScrolled);
        newContentHeight = Math.max(0, viewportHeight - frameHeaderHeight);
      }
      prevCaptureScrollTop = scrollTop;

      if (newContentHeight <= 0) break;

      screenshots.push({ dataUrl: response.dataUrl, scrollTop, viewportHeight, captureHeight: newContentHeight, headerHeight: frameHeaderHeight, devicePixelRatio });
      totalCapturedHeight += newContentHeight;

      const capturePct = Math.min(85, Math.round(25 + (screenshots.length / estimatedFrames) * 60));
      chrome.storage.local.set({ _sfProgress: { stage: 'capturing', pct: capturePct } });

      if (totalCapturedHeight >= MAX_HEIGHT) { wasTruncated = true; break; }
      if (scrollTop + viewportHeight >= lastDocumentHeight) break;

      const nextScroll = scrollTop + viewportHeight - headerHeight;
      await chrome.runtime.sendMessage({ action: 'scrollToLocked', y: nextScroll });
      await pause(SCROLL_PAUSE);

      const afterScrollY = getScrollY();
      console.log('[SF capture] scrollTop was', scrollTop, '→ requested', nextScroll, '→ now', afterScrollY);

      // Guard: scroll didn't advance — true page bottom (browser clamped)
      if (afterScrollY <= scrollTop + 1) { console.log('[SF capture] GUARD FIRED — scroll did not advance'); break; }

      let newDocHeight = getDocH();
      if (newDocHeight > lastDocumentHeight + 300) {
        await pause(600);
        const confirmedHeight = getDocH();
        if (confirmedHeight > newDocHeight + 200) {
          console.warn('ScreenFellow: infinite scroll detected, stopping.');
          break;
        }
        newDocHeight = confirmedHeight;
      }
      lastDocumentHeight = newDocHeight;
    }

    window.requestAnimationFrame = _origRAF;
    await chrome.runtime.sendMessage({ action: 'teardownScrollLock' });
    chrome.runtime.sendMessage({ action: 'restoreLenisMainWorld' });
    restoreHiddenElements(hiddenElements);
    restoreParallaxBackgrounds(parallaxElements);
    restoreScrollAnimations();
    document.getElementById('__screenfellow-noscroll')?.remove();
    document.getElementById('__sf-instant-scroll')?.remove();
    // Remove the forced overflow/height/scroll-behavior inline styles
    ['overflow-y', 'height', 'scroll-behavior'].forEach(p => {
      document.documentElement.style.removeProperty(p);
      document.body.style.removeProperty(p);
    });

    if (scrollEl) scrollEl.scrollTop = originalScrollY;
    else nativeScrollTo(originalScrollY);

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

  // ── Scroll helpers ──────────────────────────────────────────────────────────

  function nativeScrollTo(y) {
    // Use behavior:'instant' to bypass CSS scroll-behavior:smooth
    try { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); } catch (_) {}
    // Fallback: direct property assignment also bypasses smooth scroll
    try { document.documentElement.scrollTop = y; } catch (_) {}
    try { document.body.scrollTop = y; } catch (_) {}
  }

  function getNativeScrollY() {
    return window.scrollY
      || document.documentElement.scrollTop
      || document.body.scrollTop
      || 0;
  }

  // Probe whether window scrolls natively. If not, find the real scroll container.
  function detectScrollContainer() {
    // Already scrolled → window works
    if (getNativeScrollY() > 0) return null;

    // Probe with instant scroll (avoids false-negative from smooth-scroll animations)
    nativeScrollTo(2);
    const moved = getNativeScrollY() >= 1;
    nativeScrollTo(0);
    if (moved) return null;

    // Window doesn't scroll — check html/body first, then all descendants
    const candidates = [
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll('body *')),
    ];
    let best = null;
    for (const el of candidates) {
      if (el.scrollHeight <= el.clientHeight + 50) continue;
      const oy = window.getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
    return best;
  }

  // ── Smooth-scroll library killers ───────────────────────────────────────────

  function killSmoothScrollLibraries() {
    // Named references
    ['lenis', '__lenis', 'lenisScroll', 'locomotive', 'locoScroll', 'smoothScroll'].forEach(k => {
      try { if (window[k]?.stop) window[k].stop(); } catch (_) {}
      try { if (window[k]?.destroy) window[k].destroy(); } catch (_) {}
    });

    // Scan window for Lenis-like objects (has stop() + scroll-related state)
    try {
      for (const key of Object.getOwnPropertyNames(window)) {
        if (key.length < 2) continue;
        const v = window[key];
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        if (typeof v.stop !== 'function') continue;
        if ('targetScroll' in v || 'animatedScroll' in v || 'velocity' in v || 'lerp' in v) {
          try { v.stop(); } catch (_) {}
          try { v.destroy(); } catch (_) {}
        }
      }
    } catch (_) {}

    // GSAP ScrollTrigger
    try {
      const ST = window.ScrollTrigger || window.gsap?.ScrollTrigger;
      if (ST) ST.getAll().forEach(t => t.kill());
      window.gsap?.globalTimeline?.pause();
    } catch (_) {}
  }

  // ── Animation freeze / restore ──────────────────────────────────────────────

  function freezeScrollAnimations() {
    const style = document.createElement('style');
    style.id = '__sf-anim-freeze';
    style.textContent = [
      '*,*::before,*::after{',
      '  animation-play-state:paused!important;',
      '  transition-duration:0s!important;',
      '  transition-delay:0s!important;',
      '  scroll-behavior:auto!important;',
      '}',
    ].join('');
    document.head.appendChild(style);

    killSmoothScrollLibraries();
  }

  function restoreScrollAnimations() {
    document.getElementById('__sf-anim-freeze')?.remove();
  }

  // ── Fixed/sticky element handling ───────────────────────────────────────────

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

  function hideNewlyPinnedElements(alreadyHidden, headerEls) {
    const known = new Set(alreadyHidden.map(h => h.el));
    const newlyHidden = [];
    document.querySelectorAll('*').forEach(el => {
      if (known.has(el) || headerEls.has(el)) return;
      const pos = window.getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') return;
      newlyHidden.push({ el, vis: el.style.visibility });
      el.style.visibility = 'hidden';
    });
    return newlyHidden;
  }

  async function preScrollForLazyLoad(maxHeight, doScrollTo, viewH) {
    let pos = viewH;
    while (pos < maxHeight) {
      doScrollTo(pos);
      await pause(150);
      pos += viewH;
    }
  }

  async function waitForDocumentStable(getHeight, maxWaitMs = 2000, pollMs = 200) {
    const deadline = Date.now() + maxWaitMs;
    let prev = getHeight();
    while (Date.now() < deadline) {
      await pause(pollMs);
      const h = getHeight();
      if (h === prev) return;
      prev = h;
    }
  }

  function detectStickyHeader() {
    const elements = new Set();
    let maxHeight = 0;
    const viewH = window.innerHeight;
    for (const el of document.querySelectorAll('*')) {
      const pos = window.getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const rect = el.getBoundingClientRect();
      // Ignore elements taller than half the viewport — those are content sections or overlays, not headers
      if (rect.top <= 5 && rect.height > 0 && rect.height < viewH * 0.5 && rect.width > window.innerWidth * 0.3) {
        maxHeight = Math.max(maxHeight, rect.bottom);
        elements.add(el);
      }
    }
    return { height: Math.ceil(maxHeight), elements };
  }

  // ── Stitching ───────────────────────────────────────────────────────────────

  async function stitchScreenshots(shots, pxWidth, dpr, maxHeight = 50000) {
    if (shots.length === 0) return null;
    if (shots.length === 1) return shots[0].dataUrl;

    const images = await Promise.all(shots.map(s => loadImage(s.dataUrl)));
    let totalPxHeight = 0;
    const segs = shots.map(s => {
      const srcY = s.headerHeight * dpr;
      const h    = s.captureHeight * dpr;
      totalPxHeight += h;
      return { srcY, h };
    });

    const maxSafeH = Math.floor(250_000_000 / pxWidth);
    totalPxHeight = Math.min(totalPxHeight, maxHeight * dpr, maxSafeH);

    const cvs = new OffscreenCanvas(pxWidth, totalPxHeight);
    const ctx = cvs.getContext('2d');
    let yOff = 0;
    for (let i = 0; i < images.length; i++) {
      const { srcY, h } = segs[i];
      const drawH = Math.min(h, totalPxHeight - yOff);
      if (drawH <= 0) break;
      ctx.drawImage(images[i], 0, srcY, pxWidth, drawH, 0, yOff, pxWidth, drawH);
      yOff += drawH;
    }
    return blobToDataUrl(await cvs.convertToBlob({ type: 'image/png' }));
  }

  function loadImage(dataUrl) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  }

  function blobToDataUrl(blob) {
    return new Promise(res => { const r = new FileReader(); r.onloadend = () => res(r.result); r.readAsDataURL(blob); });
  }

  function getDocumentHeight() {
    return Math.max(
      document.body.scrollHeight, document.documentElement.scrollHeight,
      document.body.offsetHeight,  document.documentElement.offsetHeight
    );
  }

  function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
