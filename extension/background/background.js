import { dbSave, dbDeleteMany, dbDeleteManyAnnotations, dbSaveThumbnail, dbDeleteManyThumbnails } from '../lib/db.js';

const HISTORY_MAX_FREE    = 10;
const HISTORY_MAX_PRO     = 500;
const FULLPAGE_LIMIT_FREE = 10;

async function isFullPageAllowed() {
  const { license_status, fullpage_count_free = 0 } = await chrome.storage.local.get(['license_status', 'fullpage_count_free']);
  return license_status === 'active' || fullpage_count_free < FULLPAGE_LIMIT_FREE;
}

async function incrementFullPageCount() {
  const { license_status, fullpage_count_free = 0 } = await chrome.storage.local.get(['license_status', 'fullpage_count_free']);
  if (license_status !== 'active') {
    await chrome.storage.local.set({ fullpage_count_free: fullpage_count_free + 1 });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('ScreenFellow installed');
});

// Keyboard command shortcuts (Chrome-managed)
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (command === 'capture-visible') await handleCaptureVisible(tab.id);
  else if (command === 'capture-fullpage') {
    if (await isFullPageAllowed()) { await incrementFullPageCount(); await handleCaptureFullPage(tab.id); }
  }
  else if (command === 'capture-selection') await startSelectionMode(tab.id);
});

// Message hub
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.action === 'captureVisible') {
        await handleCaptureVisible(msg.tabId);
        sendResponse({ ok: true });
      } else if (msg.action === 'captureFullPage') {
        if (!await isFullPageAllowed()) { sendResponse({ ok: false, limitReached: true }); return; }
        await incrementFullPageCount();
        await handleCaptureFullPage(msg.tabId);
        sendResponse({ ok: true });
      } else if (msg.action === 'selectionCaptured') {
        await openEditorTab(msg.dataUrl, sender.tab?.id, msg.dpr || 1, msg.truncated || false, msg.pixelLimit || 50000, msg.isFullPage || false);
        sendResponse({ ok: true });
      } else if (msg.action === 'captureVisibleForStitch') {
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
        sendResponse({ dataUrl });
      } else if (msg.action === 'killLenisMainWorld') {
        await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: function () {
            var instances = [];
            function isLenis(v) {
              return v && typeof v === 'object' && typeof v.stop === 'function' &&
                ('animatedScroll' in v || 'targetScroll' in v || 'lerp' in v || 'velocity' in v);
            }
            try {
              Object.getOwnPropertyNames(window).forEach(function (k) {
                try { var v = window[k]; if (isLenis(v)) { v.stop(); instances.push(v); } } catch (_) {}
              });
            } catch (_) {}
            window.__sf_smooth_instances = instances;
          }
        });
        sendResponse({ ok: true });
      } else if (msg.action === 'restoreLenisMainWorld') {
        await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: function () {
            try {
              (window.__sf_smooth_instances || []).forEach(function (l) {
                try { if (typeof l.start === 'function') l.start(); } catch (_) {}
              });
              delete window.__sf_smooth_instances;
            } catch (_) {}
          }
        });
        sendResponse({ ok: true });
      } else if (msg.action === 'setupScrollLock') {
        await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: function () {
            window.__sf_locked = false;
            window.__sf_targetY = 0;

            // Layer 1 — scrollTop property interceptor on html/body
            var stDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop') ||
                         Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
            window.__sf_stDesc = stDesc || null;
            if (stDesc && stDesc.set) {
              function intercept(el) {
                try {
                  Object.defineProperty(el, 'scrollTop', {
                    get: function () { return stDesc.get.call(this); },
                    set: function (v) {
                      if (window.__sf_locked && Math.abs(v - window.__sf_targetY) > 100) return;
                      stDesc.set.call(this, v);
                    },
                    configurable: true,
                  });
                } catch (_) {}
              }
              intercept(document.documentElement);
              intercept(document.body);
            }

            // Layer 2 — replace window.scrollTo / window.scroll
            window.__sf_origScrollTo = window.scrollTo;
            window.scrollTo = function (x, y) {
              if (typeof x === 'object' && x !== null) { y = x.top || 0; x = x.left || 0; }
              if (window.__sf_locked && Math.abs((y || 0) - window.__sf_targetY) > 100) return;
              window.__sf_origScrollTo.call(window, x || 0, y || 0);
            };
            window.scroll = window.scrollTo;

            // Layer 3 — setInterval fallback at 16 ms (rAF fires before setInterval
            // in the same frame, so our interval always overwrites Lenis's rAF reset)
            window.__sf_holdInterval = setInterval(function () {
              if (!window.__sf_locked) return;
              var y = window.__sf_targetY;
              if (stDesc && stDesc.set) stDesc.set.call(document.documentElement, y);
            }, 16);
          }
        });
        sendResponse({ ok: true });
      } else if (msg.action === 'scrollToLocked') {
        await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          args: [msg.y],
          func: function (y) {
            window.__sf_targetY = y;
            window.__sf_locked = false;
            if (window.__sf_origScrollTo) {
              window.__sf_origScrollTo.call(window, 0, y);
            } else {
              try { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); } catch (_) {}
              try { window.scrollTo(0, y); } catch (_) {}
            }
            // Belt-and-suspenders: also set via native descriptor and scrollTop directly
            if (window.__sf_stDesc && window.__sf_stDesc.set) {
              window.__sf_stDesc.set.call(document.documentElement, y);
            }
            try { document.documentElement.scrollTop = y; } catch (_) {}
            window.__sf_locked = true;
            console.log('[SF scrollToLocked] y=', y, 'scrollY=', window.scrollY, 'origScrollTo=', !!window.__sf_origScrollTo);
          }
        });
        sendResponse({ ok: true });
      } else if (msg.action === 'teardownScrollLock') {
        await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: function () {
            window.__sf_locked = false;
            if (window.__sf_holdInterval) { clearInterval(window.__sf_holdInterval); delete window.__sf_holdInterval; }
            if (window.__sf_origScrollTo) {
              window.scrollTo = window.__sf_origScrollTo;
              window.scroll = window.__sf_origScrollTo;
              delete window.__sf_origScrollTo;
            }
            try { delete document.documentElement.scrollTop; } catch (_) {}
            try { delete document.body.scrollTop; } catch (_) {}
            delete window.__sf_stDesc;
            delete window.__sf_targetY;
            delete window.__sf_locked;
          }
        });
        sendResponse({ ok: true });
      } else if (msg.action === 'shortcutCapture') {
        // Triggered by content/shortcuts.js
        const tabId = sender.tab.id;
        if (msg.captureType === 'visible') await handleCaptureVisible(tabId);
        else if (msg.captureType === 'fullpage') await handleCaptureFullPage(tabId);
        else if (msg.captureType === 'selection') await startSelectionMode(tabId);
        sendResponse({ ok: true });
      }
    } catch (e) {
      console.error('ScreenFellow background error:', e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

async function handleCaptureVisible(tabId) {
  const tab = await chrome.tabs.get(tabId);

  // Get device pixel ratio for CSS-pixel scaling
  const [{ result: dpr }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.devicePixelRatio || 1
  });

  // Hide scrollbars before capture
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const s = document.createElement('style');
      s.id = '__screenfellow-noscroll-v';
      s.textContent = '::-webkit-scrollbar{width:0!important;height:0!important}*{scrollbar-width:none!important}';
      document.head.appendChild(s);
    }
  });
  await new Promise(r => setTimeout(r, 120));

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.getElementById('__screenfellow-noscroll-v')?.remove()
  });

  await openEditorTab(dataUrl, tabId, dpr);
}

async function handleCaptureFullPage(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/capture.js']
  });
  await chrome.tabs.sendMessage(tabId, { action: 'startFullPageCapture' });
}

async function startSelectionMode(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/selection-overlay.js']
  });
  await chrome.tabs.sendMessage(tabId, { action: 'startSelection' });
}

async function openEditorTab(dataUrl, sourceTabId, dpr = 1, truncated = false, pixelLimit = 50000, isFullPage = false) {
  let pageUrl = '';
  if (sourceTabId) {
    try { pageUrl = (await chrome.tabs.get(sourceTabId)).url || ''; } catch(e) {}
  }

  // Scale physical-pixel screenshots down to CSS pixels so the editor shows at true 100%
  let cssBlob, cssDataUrl;
  if (dpr > 1) {
    cssBlob    = await scaleImage(dataUrl, 1 / dpr);
    cssDataUrl = await blobToBase64(cssBlob);
  } else {
    cssDataUrl = dataUrl;
    cssBlob    = await fetch(dataUrl).then(r => r.blob());
  }

  let entryId = null;
  try {
    const { entry, thumbDataUrl } = await buildHistoryEntry(cssDataUrl, pageUrl, isFullPage);
    await Promise.all([dbSave(entry.id, cssBlob), dbSaveThumbnail(entry.id, thumbDataUrl)]);

    const { screenshot_history = [], license_status, history_limit_user } = await chrome.storage.local.get(['screenshot_history', 'license_status', 'history_limit_user']);
    const historyMax = license_status === 'active' ? (history_limit_user || HISTORY_MAX_PRO) : HISTORY_MAX_FREE;
    screenshot_history.unshift(entry);
    if (screenshot_history.length > historyMax) {
      const evicted = screenshot_history.splice(historyMax);
      const evictedIds = evicted.map(e => e.id);
      await Promise.all([
        dbDeleteMany(evictedIds),
        dbDeleteManyAnnotations(evictedIds),
        dbDeleteManyThumbnails(evictedIds),
      ]);
    }
    await chrome.storage.local.set({ screenshot_history });
    entryId = entry.id;
  } catch (e) {
    console.warn('ScreenFellow: could not save to history', e);
  }

  // Store only the ID — the full data URL can exceed session storage quota on large pages
  await chrome.storage.session.set({ pendingScreenshotId: entryId, sourceTabId, pageUrl, truncated, pixelLimit });
  const editorUrl = chrome.runtime.getURL('editor/editor.html');
  await chrome.tabs.create({ url: editorUrl });
}

async function scaleImage(dataUrl, factor) {
  const blob = await fetch(dataUrl).then(r => r.blob());
  const bitmap = await createImageBitmap(blob);
  const w = Math.round(bitmap.width * factor);
  const h = Math.round(bitmap.height * factor);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return canvas.convertToBlob({ type: 'image/png' });
}

// ─── History helpers (OffscreenCanvas available in service worker) ───────────

async function buildHistoryEntry(dataUrl, pageUrl = '', isFullPage = false) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);

  const thumbW = 172;
  const thumbH = Math.round(bitmap.height * thumbW / bitmap.width);
  const thumbCanvas = new OffscreenCanvas(thumbW, thumbH);
  thumbCanvas.getContext('2d').drawImage(bitmap, 0, 0, thumbW, thumbH);
  const thumbBlob = await thumbCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.65 });
  const thumbDataUrl = await blobToBase64(thumbBlob);

  return {
    entry: { id: crypto.randomUUID(), timestamp: Date.now(), url: pageUrl, isFullPage },
    thumbDataUrl,
  };
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}
