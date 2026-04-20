// Global custom shortcut listener — reads user-defined shortcuts from storage
// and fires capture actions when matched.

(function () {
  if (window.__stitchSnapShortcutsActive) return;
  window.__stitchSnapShortcutsActive = true;

  let customShortcuts = null;

  chrome.storage.local.get(['custom_shortcuts'], (data) => {
    customShortcuts = data.custom_shortcuts || {};
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.custom_shortcuts) {
      customShortcuts = changes.custom_shortcuts.newValue || {};
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!customShortcuts) return;
    // Don't fire inside text fields
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

    for (const [captureType, sc] of Object.entries(customShortcuts)) {
      if (!sc || !sc.key) continue;
      if (
        e.key.toUpperCase() === sc.key.toUpperCase() &&
        !!e.ctrlKey === !!sc.ctrl &&
        !!e.altKey === !!sc.alt &&
        !!e.shiftKey === !!sc.shift &&
        !!e.metaKey === !!sc.meta
      ) {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ action: 'shortcutCapture', captureType });
        return;
      }
    }
  }, true);
})();
