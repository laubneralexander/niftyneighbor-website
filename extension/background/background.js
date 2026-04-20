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
        await openEditorTab(msg.dataUrl, sender.tab?.id, msg.dpr || 1);
        sendResponse({ ok: true });
      } else if (msg.action === 'captureVisibleForStitch') {
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
        sendResponse({ dataUrl });
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

async function openEditorTab(dataUrl, sourceTabId, dpr = 1) {
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

  try {
    const { entry, thumbDataUrl } = await buildHistoryEntry(cssDataUrl, pageUrl);
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
  } catch (e) {
    console.warn('ScreenFellow: could not save to history', e);
  }

  await chrome.storage.session.set({ pendingScreenshot: cssDataUrl, sourceTabId, pageUrl });
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

async function buildHistoryEntry(dataUrl, pageUrl = '') {
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
    entry: { id: crypto.randomUUID(), timestamp: Date.now(), url: pageUrl },
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
