import { initI18n, applyI18n, setLanguage, getCurrentLanguage, t } from '../lib/i18n.js';

const CHECKOUT_URL = 'REPLACE_WITH_LEMON_SQUEEZY_CHECKOUT_URL';

const $ = id => document.getElementById(id);

async function init() {
  await initI18n();
  applyI18n();
  await checkOnlineStatus();
  await refreshLicenseUI();
  bindEvents();
  $('lang-select').value = getCurrentLanguage();
  loadShortcuts();
}

async function loadShortcuts() {
  const commands = await chrome.commands.getAll();
  const map = { 'capture-visible': 'shortcut-visible', 'capture-fullpage': 'shortcut-fullpage', 'capture-selection': 'shortcut-selection' };
  for (const cmd of commands) {
    const elId = map[cmd.name];
    if (elId && cmd.shortcut) $(elId).textContent = cmd.shortcut;
  }
}

async function checkOnlineStatus() {
  if (!navigator.onLine) {
    $('offline-banner').classList.remove('hidden');
    disableCaptureButtons();
  }
  window.addEventListener('online',  () => { $('offline-banner').classList.add('hidden');    enableCaptureButtons(); });
  window.addEventListener('offline', () => { $('offline-banner').classList.remove('hidden'); disableCaptureButtons(); });
}

function disableCaptureButtons() {
  ['btn-visible', 'btn-fullpage', 'btn-selection'].forEach(id => $(id).disabled = true);
}

function enableCaptureButtons() {
  ['btn-visible', 'btn-fullpage', 'btn-selection'].forEach(id => $(id).disabled = false);
}

async function refreshLicenseUI() {
  const data = await chrome.storage.local.get(['license_status']);
  const isPremium = data.license_status === 'active';
  const badge = $('plan-badge');
  badge.textContent = isPremium ? 'PRO' : 'FREE';
  badge.className = 'plan-badge ' + (isPremium ? 'plan-badge-pro' : 'plan-badge-free');
}

function showCaptureProgress() {
  $('capture-progress').classList.remove('hidden');
  updateProgress('analyzing', 5);
}
function hideCaptureProgress() {
  $('capture-progress').classList.add('hidden');
  $('progress-fill').style.width = '0%';
}
function updateProgress(stage, pct) {
  $('progress-fill').style.width = pct + '%';
  const labels = { analyzing: 'captureAnalyzing', capturing: 'capturing', stitching: 'captureStitching', done: 'captureDone' };
  $('progress-text').textContent = t(labels[stage] || 'capturing');
}

function bindEvents() {
  $('btn-visible').addEventListener('click', async () => {
    showCaptureProgress();
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.runtime.sendMessage({ action: 'captureVisible', tabId: tab.id });
      window.close();
    } catch (e) { hideCaptureProgress(); showError(t('captureError')); }
  });

  $('btn-fullpage').addEventListener('click', async () => {
    showCaptureProgress();
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const response = await chrome.runtime.sendMessage({ action: 'captureFullPage', tabId: tab.id });
      if (response?.limitReached) { hideCaptureProgress(); $('upgrade-modal').classList.remove('hidden'); return; }
      updateProgress('done', 100);
      await new Promise(r => setTimeout(r, 600));
      window.close();
    } catch (e) { hideCaptureProgress(); showError(t('captureError')); }
  });

  $('btn-selection').addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/selection-overlay.js'] });
      await chrome.tabs.sendMessage(tab.id, { action: 'startSelection' });
      window.close();
    } catch (e) { showError(t('captureError')); }
  });

  $('btn-library').addEventListener('click', async () => {
    await chrome.storage.session.remove(['pendingScreenshotId']);
    chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
    window.close();
  });

  // Plan badge + gear → settings view
  $('plan-badge').addEventListener('click', () => openSettingsView());
  $('btn-settings').addEventListener('click', () => openSettingsView());
  $('btn-settings-back').addEventListener('click', () => closeSettingsView());

  // Language switcher
  $('lang-select').addEventListener('change', async (e) => {
    await setLanguage(e.target.value);
    applyI18n();
  });

  // Shortcuts settings
  $('btn-open-shortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    window.close();
  });
  $('toggle-confetti').addEventListener('change', async (e) => {
    await chrome.storage.local.set({ confetti_enabled: e.target.checked });
  });
  document.querySelectorAll('.pixel-limit-opt').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.pixel-limit-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await chrome.storage.local.set({ fullpage_pixel_limit: parseInt(btn.dataset.value) });
    });
  });

  // Inline license activation (Free section in settings)
  $('btn-activate-inline').addEventListener('click', activateLicenseInline);
  $('settings-license-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') activateLicenseInline();
  });
  $('btn-buy-inline').addEventListener('click', () => {
    chrome.tabs.create({ url: CHECKOUT_URL });
    window.close();
  });

  // Release license (Pro section in settings)
  $('btn-release-license').addEventListener('click', () => {
    $('release-modal').classList.remove('hidden');
  });
  $('btn-release-confirm').addEventListener('click', async () => {
    $('release-modal').classList.add('hidden');
    await deactivateLicense();
    closeSettingsView();
  });
  $('btn-release-cancel').addEventListener('click', () => {
    $('release-modal').classList.add('hidden');
  });


  // Upgrade modal
  $('btn-buy').addEventListener('click', () => { chrome.tabs.create({ url: CHECKOUT_URL }); window.close(); });
  $('btn-enter-license').addEventListener('click', () => { closeUpgradeModal(); openSettingsView(); });
  $('btn-close-upgrade').addEventListener('click', closeUpgradeModal);

  // Live progress updates from capture.js via session storage
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes._sfProgress?.newValue) return;
    const { stage, pct } = changes._sfProgress.newValue;
    updateProgress(stage, pct);
  });
}

// ─── Settings View ────────────────────────────────────────────────────────────

async function openSettingsView() {
  $('main-view').classList.add('hidden');
  $('settings-view').classList.remove('hidden');
  // Reset inline activation state
  $('settings-license-input').value = '';
  const msg = $('settings-license-msg');
  msg.classList.add('hidden');
  msg.className = 'license-msg hidden';
  // Load confetti toggle state
  const { confetti_enabled = true, fullpage_pixel_limit = 50000 } = await chrome.storage.local.get(['confetti_enabled', 'fullpage_pixel_limit']);
  $('toggle-confetti').checked = confetti_enabled;
  document.querySelectorAll('.pixel-limit-opt').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.value) === fullpage_pixel_limit);
  });

  // Show the right license section
  const data = await chrome.storage.local.get(['license_status']);
  const isPremium = data.license_status === 'active';
  $('activate-section').classList.toggle('hidden', isPremium);
  $('license-section').classList.toggle('hidden', !isPremium);
}

function closeSettingsView() {
  $('settings-view').classList.add('hidden');
  $('main-view').classList.remove('hidden');
}

async function resetShortcuts() {
  await chrome.storage.local.remove(['custom_shortcuts']);
}

// ─── License ──────────────────────────────────────────────────────────────────

async function activateLicenseInline() {
  const key = $('settings-license-input').value.trim();
  if (!key) return;
  const btn = $('btn-activate-inline');
  btn.textContent = t('licenseActivating');
  btn.disabled = true;
  const { activateLicense } = await import('../lib/license.js');
  const result = await activateLicense(key);
  btn.textContent = t('activate');
  btn.disabled = false;
  const msg = $('settings-license-msg');
  msg.classList.remove('hidden', 'success', 'error');
  if (result.success) {
    fireConfetti();
    setTimeout(async () => {
      await refreshLicenseUI();
      closeSettingsView();
    }, 2800);
  } else {
    msg.classList.add('error');
    msg.textContent = result.alreadyActive ? t('licenseAlreadyActive') : t('licenseError');
  }
}

function fireConfetti() {
  const COLORS = ['#5B5BD6','#8B5CF6','#F59E0B','#FBBF24','#EF4444','#F472B6','#10B981','#60A5FA','#ffffff','#FCD34D','#A78BFA','#34D399'];
  const DURATION = 2600;
  const W = window.innerWidth, H = window.innerHeight;

  const cvs = document.createElement('canvas');
  cvs.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:99999';
  cvs.width = W; cvs.height = H;
  document.body.appendChild(cvs);
  const ctx = cvs.getContext('2d');

  function makeCannon(ox, oy, count, aMin, aMax) {
    return Array.from({ length: count }, () => {
      const a   = (aMin + Math.random() * (aMax - aMin)) * Math.PI / 180;
      const spd = 4 + Math.random() * 9;
      const slim = Math.random() < 0.3;
      return {
        x: ox + (Math.random() - 0.5) * 10, y: oy,
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
        w: slim ? 2 + Math.random() * 2 : 5 + Math.random() * 8,
        h: slim ? 10 + Math.random() * 16 : 4 + Math.random() * 5,
        rot: Math.random() * 360, rotV: (Math.random() - 0.5) * 14,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        shape: Math.random() < 0.6 ? 'rect' : 'ellipse',
        alpha: 1,
      };
    });
  }

  // Two corner cannons angled toward center
  const particles = [
    ...makeCannon(W * 0.04, H + 4, 55, -95, -15),
    ...makeCannon(W * 0.96, H + 4, 55, -165, -85),
  ];
  const start = performance.now();

  function frame(now) {
    const elapsed = now - start;
    if (elapsed > DURATION) { cvs.remove(); return; }
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      p.vy += 0.32; p.vx *= 0.986;
      p.rot += p.rotV; p.rotV *= 0.993;
      const lifeT = elapsed / DURATION;
      p.alpha = lifeT < 0.6 ? 1 : 1 - (lifeT - 0.6) / 0.4;
      if (p.alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot * Math.PI / 180);
      ctx.fillStyle = p.color;
      if (p.shape === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(0, 0, p.w / 2, p.h / 3, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

async function deactivateLicense() {
  const { deactivateLicense } = await import('../lib/license.js');
  const { dbDeleteMany, dbDeleteManyAnnotations, dbDeleteManyThumbnails } = await import('../lib/db.js');
  await deactivateLicense();
  // Trim screenshot history to free limit
  const { screenshot_history = [] } = await chrome.storage.local.get(['screenshot_history']);
  if (screenshot_history.length > 10) {
    const evicted = screenshot_history.splice(10);
    const evictedIds = evicted.map(e => e.id);
    await Promise.all([
      dbDeleteMany(evictedIds),
      dbDeleteManyAnnotations(evictedIds),
      dbDeleteManyThumbnails(evictedIds),
    ]);
    await chrome.storage.local.set({ screenshot_history });
  }
  await refreshLicenseUI();
}

function closeUpgradeModal() { $('upgrade-modal').classList.add('hidden'); }

function showError(msg) {
  const el = document.createElement('div');
  el.className = 'offline-banner';
  el.style.cssText = 'background:#7F1D1D;color:#FEE2E2;';
  el.textContent = msg;
  document.body.insertBefore(el, document.body.firstChild);
  setTimeout(() => el.remove(), 4000);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'showUpgrade') $('upgrade-modal').classList.remove('hidden');
});

init();
