let messages = {};
let currentLang = 'en';
const SUPPORTED = ['en', 'de', 'es', 'fr', 'pt_BR', 'ru', 'zh_CN', 'ja', 'ko', 'it', 'tr', 'pl', 'nl', 'id'];

async function _load(lang) {
  const target = SUPPORTED.includes(lang) ? lang : 'en';
  try {
    const url = chrome.runtime.getURL(`_locales/${target}/messages.json`);
    const resp = await fetch(url);
    if (resp.ok) { messages = await resp.json(); currentLang = target; return; }
  } catch (_) {}
  if (target !== 'en') await _load('en');
}

export async function initI18n() {
  const stored = await chrome.storage.local.get(['ui_language']);
  const browserLang = (chrome.i18n.getUILanguage?.() || 'en').split('-')[0];
  await _load(stored.ui_language || browserLang);
}

export async function setLanguage(lang) {
  await chrome.storage.local.set({ ui_language: lang });
  await _load(lang);
}

export function getCurrentLanguage() { return currentLang; }

export function t(key) {
  return messages[key]?.message || key;
}

export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const v = t(el.dataset.i18n); if (v !== el.dataset.i18n) el.textContent = v;
  });
  root.querySelectorAll('[data-i18n-html]').forEach(el => {
    const v = t(el.dataset.i18nHtml); if (v !== el.dataset.i18nHtml) el.innerHTML = v;
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const v = t(el.dataset.i18nPlaceholder); if (v !== el.dataset.i18nPlaceholder) el.placeholder = v;
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    const v = t(el.dataset.i18nTitle); if (v !== el.dataset.i18nTitle) el.title = v;
  });
}
