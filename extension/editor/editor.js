import { initTools, setTool, setViewportCenterGetter, setBadgePreset, setBadgeMode, setTextPreset, setRectPreset, setEllipsePreset, setHighlightPreset, setFreehandPreset, setArrowPreset, reapplyBlur, placeEmoji, placeImage, setSourceImage, getSourceImage, renumberBadgesAfterDelete, setBadgePosition } from './tools.js';
import { TEXT_PRESETS, BADGE_PRESETS, RECT_PRESETS, HIGHLIGHT_PRESETS, FREEHAND_PRESETS, ARROW_PRESETS } from './presets.js';
import { exportPNG, exportPDF, exportPDFFromDataUrl, getAnnotatedDataUrl, downloadDataUrl, setExportName } from '../lib/exporter.js';
import { initI18n, applyI18n, t } from '../lib/i18n.js';
import { dbLoad, dbSave, dbSaveThumbnail, dbDelete, dbSaveAnnotations, dbLoadAnnotations, dbDeleteAnnotations, dbLoadThumbnail, dbDeleteThumbnail, dbDeleteMany, dbDeleteManyAnnotations, dbDeleteManyThumbnails } from '../lib/db.js';

const CHECKOUT_URL = 'https://niftyneighbor.lemonsqueezy.com/checkout/buy/4f9f8aa2-08b7-49d7-bdcc-93f5330ff508';
const MAX_UNDO = 50;
const PADDING = 24; // canvas-area padding in px

const $ = id => document.getElementById(id);

let fabricCanvas = null;
let originalImageDataUrl = null;
let isPremium = false;
let confettiEnabled = true;
let showingOriginal = false;
let undoStack = [];
let undoIndex = -1;
let isRestoringUndo = false;
let currentTool = 'pan';
let toolBeforeOriginal = 'pan';
let origW = 0;
let origH = 0;
let currentZoom = 1;
let pendingDeleteId = null;
let currentHistoryId = null;
let currentObjectUrl = null;
let currentPageUrl = '';
let currentTimestamp = Date.now();
let currentScreenshotName = '';
let currentUrlFrameSettings = { style: 'none', dateTime: 'none' };
let cropState = null;
let annotationSaveTimer = null;

async function init() {
  await initI18n();
  applyI18n();
  const { confetti_enabled = true } = await chrome.storage.local.get(['confetti_enabled']);
  confettiEnabled = confetti_enabled;
  chrome.storage.onChanged.addListener((changes) => {
    if ('confetti_enabled' in changes) confettiEnabled = changes.confetti_enabled.newValue ?? true;
  });
  await loadLicenseStatus();
  await loadCustomPresets();
  await loadScreenshot();
  await setupCanvas();
  initTools(fabricCanvas, onAnnotationAdded);
  setViewportCenterGetter(() => {
    const vpt = fabricCanvas.viewportTransform;
    const area = document.querySelector('.canvas-area');
    const zoom = vpt[0], tx = vpt[4], ty = vpt[5];
    // Viewport bounds in image coordinates
    const vLeft  = -tx / zoom,               vTop    = -ty / zoom;
    const vRight = (area.clientWidth  - tx) / zoom, vBottom = (area.clientHeight - ty) / zoom;
    // Intersection with image bounds
    const iLeft  = Math.max(0,     vLeft),   iTop    = Math.max(0,     vTop);
    const iRight = Math.min(origW, vRight),  iBottom = Math.min(origH, vBottom);
    // Center of intersection (fall back to image center if fully off-screen)
    const x = iRight > iLeft  ? (iLeft  + iRight)  / 2 : origW / 2;
    const y = iBottom > iTop  ? (iTop   + iBottom)  / 2 : origH / 2;
    return { x, y };
  });
  setTool('pan');
  initGearIcon();
  bindUIEvents();
  bindKeyboardShortcuts();
  updateUndoRedoButtons();
  if (!originalImageDataUrl) showLibraryHint();
  await loadAllTags();
  await loadHistory();
  await initHistorySettingsPanel();
}


async function loadLicenseStatus() {
  const data = await chrome.storage.local.get(['license_status']);
  isPremium = data.license_status === 'active';
  updateLicenseBadge();
}

const PRO_TOOLS = ['emoji', 'image', 'crop', 'slice', 'urlframe'];

function updateLicenseBadge() {
  const btn = $('btn-license-badge');
  if (!btn) return;
  if (isPremium) {
    btn.textContent = 'PRO';
    btn.title = t('licenseProActive');
    btn.classList.add('is-pro');
    btn.classList.remove('is-free');
  } else {
    btn.textContent = 'FREE';
    btn.title = t('licenseFreeUpgrade');
    btn.classList.remove('is-pro');
    btn.classList.add('is-free');
  }
  PRO_TOOLS.forEach(tool => {
    const el = document.getElementById(`tool-${tool}`);
    if (el) {
      el.classList.toggle('tool-pro-locked', !isPremium);
      if (!isPremium) el.title = t('toolLockedPro');
    }
  });
}

async function loadScreenshot() {
  const data = await chrome.storage.session.get(['pendingScreenshotId', 'pageUrl', 'truncated']);
  if (!data.pendingScreenshotId) return;
  currentPageUrl = data.pageUrl || '';
  currentTimestamp = Date.now();
  await chrome.storage.session.remove(['pendingScreenshotId', 'pageUrl', 'truncated', 'pixelLimit']);
  const blob = await dbLoad(data.pendingScreenshotId);
  if (!blob) return;
  originalImageDataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
  if (data.truncated) {
    const limitK = ((data.pixelLimit || 50000) / 1000) + 'k';
    showToast(t('pageTooLarge').replace('{limit}', limitK), 8000);
  }
}

function setupCanvas() {
  return new Promise((resolve) => {
    const area = document.querySelector('.canvas-area');
    fabricCanvas = new fabric.Canvas('main-canvas', {
      width: area.clientWidth || 800, height: area.clientHeight || 600,
      selection: true,
      preserveObjectStacking: true,
      uniformScaling: false,
      enableRetinaScaling: false,
    });
    // Disable per-object caching so all objects are re-rendered from vector on every frame.
    // With viewportTransform zoom, cached bitmaps would be upscaled at high zoom = pixelated.
    // For a screenshot editor with few annotation objects the re-render cost is negligible.
    fabric.Object.prototype.objectCaching = false;
    fabric.Textbox.prototype.hiddenTextareaContainer = document.getElementById('canvas-container');
    if (!originalImageDataUrl) { resolve(); return; }
    const img = new Image();
    img.onerror = () => resolve();
    img.onload = () => {
      origW = img.naturalWidth;
      origH = img.naturalHeight;
      fabricCanvas._origW = origW;
      fabricCanvas._origH = origH;
      setCanvasClip(origW, origH);
      fabric.Image.fromURL(originalImageDataUrl, (fabricImg) => {
        fabricImg.set({ selectable: false, evented: false });
        fabricCanvas.setBackgroundImage(fabricImg, () => {
          fitToScreen();
          fabricCanvas.renderAll();
          saveUndo();
          setSourceImage(originalImageDataUrl);
          resolve();
        });
      });
    };
    img.src = originalImageDataUrl;
  });
}

function showToast(msg, duration = 4000) {
  const el = document.createElement('div');
  el.className = 'sf-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('sf-toast-visible'));
  setTimeout(() => {
    el.classList.remove('sf-toast-visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, duration);
}

function showLibraryHint() {
  $('library-hint').classList.remove('hidden');
  $('canvas-container').style.visibility = 'hidden';
  document.querySelector('.toolbar').classList.add('no-image');
  $('object-gear-btn').classList.add('hidden');
  $('object-format-panel').classList.add('hidden');
}

function hideLibraryHint() {
  if ($('library-hint').classList.contains('hidden')) return;
  $('library-hint').classList.add('hidden');
  $('canvas-container').style.visibility = '';
  document.querySelector('.toolbar').classList.remove('no-image');
}

function setCanvasClip(w, h) {
  fabricCanvas.clipPath = new fabric.Rect({
    width: w, height: h, left: 0, top: 0,
    absolutePositioned: true,
  });
}

// ─── Zoom / Pan via Fabric.js viewportTransform ───────────────────────────────
// The canvas element always fills the .canvas-area. Zoom and pan are handled
// by Fabric's viewportTransform so only the visible region is rasterized each frame.

function fitToScreen(bottomExtra = 0) {
  if (!origW || !fabricCanvas) return;
  const area = document.querySelector('.canvas-area');
  const zoom = Math.min(
    (area.clientWidth  - PADDING * 2) / origW,
    (area.clientHeight - PADDING * 2 - bottomExtra) / origH,
    1
  );
  const tx = (area.clientWidth  - origW * zoom) / 2;
  const ty = Math.max(PADDING, (area.clientHeight - origH * zoom - bottomExtra) / 2);
  fabricCanvas.setViewportTransform([zoom, 0, 0, zoom, tx, ty]);
  currentZoom = zoom;
  syncZoomSelect();
}

function zoomToTop() {
  if (!origW || !fabricCanvas) return;
  const area = document.querySelector('.canvas-area');
  const tx = (area.clientWidth - origW) / 2;
  fabricCanvas.setViewportTransform([1, 0, 0, 1, tx, PADDING]);
  currentZoom = 1;
  syncZoomSelect();
}

function applyZoom(zoom) {
  if (!fabricCanvas) return;
  zoom = Math.max(0.05, Math.min(5, zoom));
  const area = document.querySelector('.canvas-area');
  const vpt = [...fabricCanvas.viewportTransform];
  const oldZoom = vpt[0] || 1;
  // Zoom around viewport center
  const cx = area.clientWidth  / 2;
  const cy = area.clientHeight / 2;
  vpt[4] = cx - (cx - vpt[4]) * zoom / oldZoom;
  vpt[5] = cy - (cy - vpt[5]) * zoom / oldZoom;
  vpt[0] = zoom; vpt[3] = zoom;
  fabricCanvas.setViewportTransform(vpt);
  currentZoom = zoom;
  syncZoomSelect();
}

function syncZoomSelect() {
  const pct = Math.round((fabricCanvas?.viewportTransform?.[0] ?? 1) * 100);
  const sel = $('zoom-select');
  let best = null, bestDiff = Infinity;
  for (const opt of sel.options) {
    const diff = Math.abs(parseInt(opt.value) - pct);
    if (diff < bestDiff) { bestDiff = diff; best = opt; }
  }
  if (best) sel.value = best.value;
}

// Compute the new zoom level when using the scroll wheel (max 500%).
function computeWheelZoom(current, zoomIn) {
  const rawNew = current * (zoomIn ? 1.1 : 0.9);

  if (rawNew >= 5) return 5;

  // Snap through 100%
  if ((current < 1 && rawNew > 1) || (current > 1 && rawNew < 1)) return 1;

  return rawNew;
}

// ─── Undo/Redo ────────────────────────────────────────────────────────────────

function getObjects() {
  return fabricCanvas.getObjects()
    .filter(o => !o._isBlurOverlay)
    .map(o => o.toObject(['id', '_isBadge', '_badgeType', '_badgeValue', '_badgeShape', '_badgeBg', '_badgeFg', '_badgeDescription', '_isBlurRegion', '_blurX', '_blurY', '_blurW', '_blurH', '_blurStrength', '_blurCornerRadius', '_isHighlight', '_highlightColor', '_isFreehand', '_freehandColor', '_freehandWidth', '_freehandBorderColor', '_freehandBorderWidth', '_freehandHasShadow', '_isFreehandLine', '_isCustomImage', '_imageDataUrl']));
}

function saveUndo() {
  if (isRestoringUndo) return;
  if (undoIndex < undoStack.length - 1) undoStack = undoStack.slice(0, undoIndex + 1);
  undoStack.push(getObjects());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  undoIndex = undoStack.length - 1;
  updateUndoRedoButtons();
}

function onAnnotationAdded(obj) {
  saveUndo();
  if (!obj) obj = fabricCanvas.getActiveObject();
  if (obj?.blurOutside) {
    applyBlurOutside(obj);
    $('tool-select').click();
    // Defer setActiveObject until after Fabric has fully processed the current mouse event,
    // otherwise _mouseIsDown may still be true and cause the object to follow the cursor.
    setTimeout(() => {
      if (fabricCanvas && fabricCanvas.contains(obj)) {
        fabricCanvas.setActiveObject(obj);
        fabricCanvas.renderAll();
      }
    }, 0);
    updateExportButton();
    clearTimeout(annotationSaveTimer);
    annotationSaveTimer = setTimeout(saveCurrentAnnotations, 1500);
    return;
  }
  updateExportButton();
  if (['blur', 'image', 'emoji', 'text'].includes(currentTool)) {
    $('tool-select').click();
  } else {
    fabricCanvas.discardActiveObject();
    fabricCanvas.renderAll();
  }
  clearTimeout(annotationSaveTimer);
  annotationSaveTimer = setTimeout(saveCurrentAnnotations, 1500);
}

function undo() { if (undoIndex > 0) { undoIndex--; restoreObjects(undoStack[undoIndex]); } }
function redo() { if (undoIndex < undoStack.length - 1) { undoIndex++; restoreObjects(undoStack[undoIndex]); } }

function restoreObjects(objectsData) {
  isRestoringUndo = true;
  fabricCanvas.getObjects().slice().forEach(o => fabricCanvas.remove(o));
  if (!objectsData.length) {
    isRestoringUndo = false;
    fabricCanvas.renderAll();
    updateUndoRedoButtons();
    return;
  }
  fabric.util.enlivenObjects(objectsData, (enlivened) => {
    enlivened.forEach((o, i) => { rehydrateBadge(o, objectsData[i]); fabricCanvas.add(o); });
    rebuildGlobalBlurOverlay();
    fabricCanvas.renderAll();
    isRestoringUndo = false;
    updateUndoRedoButtons();
  });
}

function updateUndoRedoButtons() {
  $('btn-undo').disabled = undoIndex <= 0;
  $('btn-redo').disabled = undoIndex >= undoStack.length - 1;
}

// ─── Original / Edited toggle ─────────────────────────────────────────────────

function toggleView() {
  showingOriginal = !showingOriginal;
  fabricCanvas.getObjects().forEach(obj => { obj.visible = !showingOriginal; });
  $('view-toggle').dataset.state = showingOriginal ? 'original' : 'annotated';
  fabricCanvas.renderAll();

  const toolbar = document.querySelector('.toolbar');
  if (showingOriginal) {
    toolBeforeOriginal = currentTool;
    toolbar.classList.add('disabled');
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    $('tool-pan').classList.add('active');
    currentTool = 'pan';
    setTool('pan');
  } else {
    toolbar.classList.remove('disabled');
    const restore = toolBeforeOriginal || 'pan';
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    $('tool-' + restore)?.classList.add('active');
    currentTool = restore;
    setTool(restore);
  }
}

// ─── Text Preset Panel ────────────────────────────────────────────────────────

function buildTextPresetPanel() {
  const body = $('tool-options-body');
  body.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'tool-options-label';
  label.textContent = t('ofpTextStyle');
  body.appendChild(label);

  const grid = document.createElement('div');
  grid.className = 'rect-preset-grid';

  TEXT_PRESETS.forEach((preset, i) => {
    if ((deletedBuiltins.text || []).includes(preset.id)) return;
    const thumb = document.createElement('div');
    thumb.className = 'rect-preset-thumb' + (i === selectedTextPresetIndex ? ' selected' : '');

    const c = document.createElement('canvas');
    c.width = 60; c.height = 40;
    drawTextPresetThumb(c.getContext('2d'), preset, 60, 40);
    thumb.appendChild(c);
    addBuiltinDeleteBtn(thumb, 'text', preset.id);

    thumb.addEventListener('click', () => {
      grid.querySelectorAll('.rect-preset-thumb').forEach(t => t.classList.remove('selected'));
      thumb.classList.add('selected');
      selectedTextPresetIndex = i;
      setTextPreset(preset);
    });
    grid.appendChild(thumb);
  });

  appendCustomPresetsToGrid(grid, 'text', drawTextPresetThumb, (preset) => {
    setTextPreset(preset);
  });

  body.appendChild(grid);
}

function drawTextPresetThumb(ctx, preset, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(0, 0, w, h);

  const p = preset.fabricProps;
  const fontSize = Math.round(h * 0.42);
  let fontStr = '';
  if (p.fontStyle === 'italic') fontStr += 'italic ';
  if (p.fontWeight === 'bold') fontStr += 'bold ';
  fontStr += `${fontSize}px ${p.fontFamily || 'Arial, sans-serif'}`;
  ctx.font = fontStr;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const cx = w / 2, cy = h / 2;

  if (p.stroke && p.strokeWidth > 0) {
    ctx.save();
    ctx.strokeStyle = p.stroke;
    ctx.lineWidth = Math.min(p.strokeWidth / 2, 2.5);
    ctx.lineJoin = 'round';
    ctx.strokeText('AaBb', cx, cy);
    ctx.restore();
  }

  ctx.fillStyle = p.fill;
  ctx.fillText('AaBb', cx, cy);

  if (p.underline) {
    const metrics = ctx.measureText('AaBb');
    ctx.save();
    ctx.strokeStyle = p.fill;
    ctx.lineWidth = Math.max(1, fontSize * 0.07);
    ctx.beginPath();
    ctx.moveTo(cx - metrics.width / 2, cy + fontSize * 0.55);
    ctx.lineTo(cx + metrics.width / 2, cy + fontSize * 0.55);
    ctx.stroke();
    ctx.restore();
  }
}

// ─── Rect Preset Panel ────────────────────────────────────────────────────────

let selectedRectPresetIndex = 0;
let selectedEllipsePresetIndex = 0;
let selectedBadgePresetIndex = 0;
let selectedTextPresetIndex = 0;
let selectedHighlightPresetIndex = 0;
let selectedFreehandPresetIndex = 0;
let selectedArrowPresetIndex = 0;
let currentBadgeMode = 'numeric';

// ─── Custom Presets ────────────────────────────────────────────────────────────

let customPresets   = { rect: [], ellipse: [], badge: [], text: [], highlight: [], freehand: [], arrow: [], image: [] };
let deletedBuiltins = { rect: [], ellipse: [], badge: [], text: [], highlight: [], freehand: [], arrow: [] };

const BUILTIN_PRESET_COUNTS = {
  rect: RECT_PRESETS.length, ellipse: RECT_PRESETS.length,
  badge: BADGE_PRESETS.length, text: TEXT_PRESETS.length,
  highlight: HIGHLIGHT_PRESETS.length, freehand: FREEHAND_PRESETS.length,
  arrow: ARROW_PRESETS.length, image: 0,
};

function activeBuiltinCount(toolKey) {
  return (BUILTIN_PRESET_COUNTS[toolKey] ?? 0) - (deletedBuiltins[toolKey]?.length ?? 0);
}

function totalPresetCount(toolKey) {
  return activeBuiltinCount(toolKey) + (customPresets[toolKey]?.length ?? 0);
}

async function loadCustomPresets() {
  const data = await chrome.storage.local.get(['custom_presets', 'deleted_builtins']);
  if (data.custom_presets)   customPresets   = { ...customPresets,   ...data.custom_presets };
  if (data.deleted_builtins) deletedBuiltins = { ...deletedBuiltins, ...data.deleted_builtins };
}

async function persistCustomPresets() {
  await chrome.storage.local.set({ custom_presets: customPresets, deleted_builtins: deletedBuiltins });
}

function addBuiltinDeleteBtn(thumb, toolKey, presetId) {
  if (!isPremium) return;
  const isLast = toolKey !== 'image' && totalPresetCount(toolKey) <= 1;
  const delBtn = document.createElement('button');
  delBtn.className = 'preset-del-btn';
  delBtn.innerHTML = '✕';
  delBtn.title = isLast ? t('presetDeleteMinOne') : t('presetDeleteBtn');
  if (isLast) { delBtn.disabled = true; delBtn.style.opacity = '0.3'; delBtn.style.cursor = 'default'; }
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isLast) return;
    showPresetDeleteConfirm(() => {
      if (!deletedBuiltins[toolKey]) deletedBuiltins[toolKey] = [];
      deletedBuiltins[toolKey].push(presetId);
      persistCustomPresets();
      rebuildActivePresetPanel();
    });
  });
  thumb.appendChild(delBtn);
}

let _presetDelCallback = null;

function showPresetDeleteConfirm(onConfirm) {
  _presetDelCallback = onConfirm;
  $('preset-delete-modal').classList.remove('hidden');
}

function rebuildActivePresetPanel() {
  if ($('tool-options-panel').classList.contains('hidden')) return;
  const builders = {
    rect: buildRectPresetPanel, ellipse: buildEllipsePresetPanel,
    badge: buildBadgePresetPanel, text: buildTextPresetPanel,
    highlight: buildHighlightPresetPanel, freehand: buildFreehandPresetPanel,
    arrow: buildArrowPresetPanel, image: buildImagePresetPanel,
    crop: buildCropPanel, urlframe: buildUrlFramePanel,
  };
  builders[currentTool]?.();
}

function appendCustomPresetsToGrid(grid, toolKey, drawThumbFn, onSelectFn) {
  const presets = customPresets[toolKey] || [];
  presets.forEach((preset, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'rect-preset-thumb';

    if (preset.thumbUrl) {
      const img = document.createElement('img');
      img.src = preset.thumbUrl;
      img.style.cssText = 'width:60px;height:40px;object-fit:contain;display:block';
      wrap.appendChild(img);
    } else {
      const c = document.createElement('canvas');
      c.width = 60; c.height = 40;
      try { drawThumbFn(c.getContext('2d'), preset, 60, 40); } catch (_) {}
      wrap.appendChild(c);
    }

    if (isPremium) {
      const isLast = toolKey !== 'image' && totalPresetCount(toolKey) <= 1;
      const delBtn = document.createElement('button');
      delBtn.className = 'preset-del-btn';
      delBtn.innerHTML = '✕';
      delBtn.title = isLast ? t('presetDeleteMinOne') : t('presetDeleteBtn');
      if (isLast) { delBtn.disabled = true; delBtn.style.opacity = '0.3'; delBtn.style.cursor = 'default'; }
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isLast) return;
        showPresetDeleteConfirm(() => {
          customPresets[toolKey].splice(idx, 1);
          persistCustomPresets();
          rebuildActivePresetPanel();
        });
      });
      wrap.appendChild(delBtn);
    }

    wrap.addEventListener('click', () => {
      grid.querySelectorAll('.rect-preset-thumb').forEach(t => t.classList.remove('selected'));
      wrap.classList.add('selected');
      onSelectFn(preset);
    });
    grid.appendChild(wrap);
  });
}

function appendPresetSaveBtn(body, toolKey, getDataFn) {
  const sep = document.createElement('div');
  sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.07);margin:10px 0 6px';
  body.appendChild(sep);

  const btn = document.createElement('button');
  btn.className = 'ofp-preset-save-btn';

  const maxCustom = 12 - activeBuiltinCount(toolKey);
  const count = (customPresets[toolKey] || []).length;

  if (!isPremium) {
    btn.innerHTML = `★ ${t('saveAsPreset')} <span style="opacity:0.5;font-size:9px">(Pro)</span>`;
    btn.addEventListener('click', showUpgradeModal);
  } else if (count >= maxCustom) {
    btn.textContent = t('presetMaxReached').replace('{n}', maxCustom);
    btn.disabled = true;
  } else {
    btn.textContent = '★ ' + t('saveAsPreset');
    btn.addEventListener('click', async () => {
      const data = getDataFn();
      if (!data) return;
      if (!customPresets[toolKey]) customPresets[toolKey] = [];
      customPresets[toolKey].push(data);
      await persistCustomPresets();
      rebuildActivePresetPanel();
      btn.textContent = '✓ ' + t('presetSaved');
      btn.classList.add('saved');
      if (confettiEnabled) fireConfetti(btn);
      setTimeout(() => { btn.textContent = '★ ' + t('saveAsPreset'); btn.classList.remove('saved'); }, 2000);
    });
  }
  body.appendChild(btn);
}

function capturePresetFromObj(obj) {
  if (obj.type === 'vignetteRect') {
    return { id: Date.now(), stroke: obj.stroke, strokeWidth: obj.strokeWidth,
      rx: obj.rx || 0, insideFillOpacity: obj.insideFillOpacity,
      outsideFillOpacity: obj.outsideFillOpacity, fillColor: obj.fillColor,
      blurOutside: !!obj.blurOutside, strokeDashArray: obj.strokeDashArray || null };
  }
  if (obj.type === 'vignetteEllipse') {
    return { id: Date.now(), stroke: obj.stroke, strokeWidth: obj.strokeWidth,
      insideFillOpacity: obj.insideFillOpacity, outsideFillOpacity: obj.outsideFillOpacity,
      fillColor: obj.fillColor, blurOutside: !!obj.blurOutside, strokeDashArray: obj.strokeDashArray || null };
  }
  if (obj._isBadge) {
    return { id: Date.now(), bg: obj._badgeBg || '#EF4444', fg: obj._badgeFg || '#ffffff', shape: obj._badgeShape || 'circle', opacity: obj.opacity ?? 1, scale: obj.scaleX ?? 1 };
  }
  if (obj.type === 'textbox') {
    return { id: Date.now(), fabricProps: { fill: obj.fill, stroke: obj.stroke || null,
      strokeWidth: obj.strokeWidth || 0, fontFamily: obj.fontFamily, fontSize: obj.fontSize,
      fontWeight: obj.fontWeight, fontStyle: obj.fontStyle, underline: !!obj.underline,
      textAlign: obj.textAlign || 'left', padding: 4,
      shadow: obj.shadow ? { color: obj.shadow.color, blur: obj.shadow.blur, offsetX: obj.shadow.offsetX, offsetY: obj.shadow.offsetY } : null } };
  }
  if (obj._isHighlight) {
    return { id: Date.now(), color: obj._highlightColor || obj.fill || '#FDE047', opacity: obj.opacity ?? 0.42, rx: obj.rx || 0 };
  }
  if (obj._isFreehand) {
    return { id: Date.now(), color: obj._freehandColor || obj.stroke || '#EF4444',
      width: obj._freehandWidth || obj.strokeWidth || 3,
      borderColor: obj._freehandBorderColor || null, borderWidth: obj._freehandBorderWidth || 0,
      shadow: !!obj._freehandHasShadow, opacity: obj.opacity ?? 1 };
  }
  if (obj._isFreehandLine) {
    return { id: Date.now(), color: obj.arrowColor || '#EF4444', width: obj.arrowWidth || 3,
      borderColor: obj.borderColor || null, borderWidth: obj.borderWidth || 0, shadow: !!obj.arrowShadow, opacity: obj.opacity ?? 1 };
  }
  if (obj.type === 'arrowShape') {
    return { id: Date.now(), arrowType: obj.arrowType, arrowColor: obj.arrowColor, arrowWidth: obj.arrowWidth,
      borderColor: obj.borderColor || null, borderWidth: obj.borderWidth || 0, shadow: !!obj.arrowShadow, opacity: obj.opacity ?? 1 };
  }
  if (obj._isCustomImage) {
    return { id: Date.now(), dataUrl: obj._imageDataUrl || '', thumbUrl: obj._imageThumbUrl || '', opacity: obj.opacity ?? 1, scale: obj.scaleX ?? null };
  }
  return null;
}


function buildRectPresetPanel() {
  const body = $('tool-options-body');
  body.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'tool-options-label';
  label.textContent = t('ofpRectStyle');
  body.appendChild(label);

  const grid = document.createElement('div');
  grid.className = 'rect-preset-grid';

  RECT_PRESETS.forEach((preset, i) => {
    if ((deletedBuiltins.rect || []).includes(preset.id)) return;
    const thumb = document.createElement('div');
    thumb.className = 'rect-preset-thumb' + (i === selectedRectPresetIndex ? ' selected' : '');
    thumb.title = preset.id;

    const c = document.createElement('canvas');
    c.width = 60; c.height = 40;
    drawPresetThumb(c.getContext('2d'), preset, 60, 40);
    thumb.appendChild(c);
    addBuiltinDeleteBtn(thumb, 'rect', preset.id);

    thumb.addEventListener('click', () => {
      grid.querySelectorAll('.rect-preset-thumb').forEach(t => t.classList.remove('selected'));
      thumb.classList.add('selected');
      selectedRectPresetIndex = i;
      setRectPreset(preset);
    });
    grid.appendChild(thumb);
  });

  appendCustomPresetsToGrid(grid, 'rect', drawPresetThumb, (preset) => setRectPreset(preset));
  body.appendChild(grid);
}

// ─── Ellipse Preset Panel ─────────────────────────────────────────────────────

function buildEllipsePresetPanel() {
  const body = $('tool-options-body');
  body.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'tool-options-label';
  label.textContent = t('ofpEllipseStyle');
  body.appendChild(label);

  const grid = document.createElement('div');
  grid.className = 'rect-preset-grid';

  RECT_PRESETS.forEach((preset, i) => {
    if ((deletedBuiltins.ellipse || []).includes(preset.id)) return;
    const thumb = document.createElement('div');
    thumb.className = 'rect-preset-thumb' + (i === selectedEllipsePresetIndex ? ' selected' : '');

    const c = document.createElement('canvas');
    c.width = 60; c.height = 40;
    drawEllipseThumb(c.getContext('2d'), preset, 60, 40);
    thumb.appendChild(c);
    addBuiltinDeleteBtn(thumb, 'ellipse', preset.id);

    thumb.addEventListener('click', () => {
      grid.querySelectorAll('.rect-preset-thumb').forEach(t => t.classList.remove('selected'));
      thumb.classList.add('selected');
      selectedEllipsePresetIndex = i;
      setEllipsePreset(preset);
    });
    grid.appendChild(thumb);
  });

  appendCustomPresetsToGrid(grid, 'ellipse', drawEllipseThumb, (preset) => setEllipsePreset(preset));
  body.appendChild(grid);
}

function drawEllipseThumb(ctx, preset, w, h) {
  ctx.clearRect(0, 0, w, h);
  const pad = 6;
  const cx = w / 2, cy = h / 2;
  const rx = (w - pad * 2) / 2, ry = (h - pad * 2) / 2;

  if (preset.blurOutside) {
    ctx.fillStyle = 'rgba(120,120,140,0.45)';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(30,30,46,0.18)';
    ctx.fill();
    if (preset.stroke && preset.strokeWidth > 0) {
      ctx.strokeStyle = preset.stroke;
      ctx.lineWidth = Math.min(preset.strokeWidth, 3);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (preset.outsideFillOpacity > 0) {
    ctx.fillStyle = `rgba(0,0,0,${preset.outsideFillOpacity + 0.1})`;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 0.6, ry * 0.6, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();
    ctx.restore();
    return;
  }

  if (preset.insideFillOpacity > 0) {
    ctx.save();
    ctx.globalAlpha = preset.insideFillOpacity;
    ctx.fillStyle = preset.fillColor;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  if (preset.stroke && preset.strokeWidth > 0) {
    ctx.strokeStyle = preset.stroke;
    ctx.lineWidth = Math.min(preset.strokeWidth, 3);
    if (preset.strokeDashArray) ctx.setLineDash(preset.strokeDashArray);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ─── Badge Preset Panel ───────────────────────────────────────────────────────

function buildBadgePresetPanel() {
  const body = $('tool-options-body');
  body.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'tool-options-label';
  label.textContent = t('ofpBadgeStyle');
  body.appendChild(label);

  const grid = document.createElement('div');
  grid.className = 'rect-preset-grid';

  BADGE_PRESETS.forEach((preset, i) => {
    if ((deletedBuiltins.badge || []).includes(preset.id)) return;
    const thumb = document.createElement('div');
    thumb.className = 'rect-preset-thumb' + (i === selectedBadgePresetIndex ? ' selected' : '');

    const c = document.createElement('canvas');
    c.width = 60; c.height = 40;
    drawBadgeThumb(c.getContext('2d'), preset, 60, 40);
    thumb.appendChild(c);
    addBuiltinDeleteBtn(thumb, 'badge', preset.id);

    thumb.addEventListener('click', () => {
      grid.querySelectorAll('.rect-preset-thumb').forEach(t => t.classList.remove('selected'));
      thumb.classList.add('selected');
      selectedBadgePresetIndex = i;
      setBadgePreset(preset);
    });
    grid.appendChild(thumb);
  });

  appendCustomPresetsToGrid(grid, 'badge', drawBadgeThumb, (preset) => setBadgePreset(preset));
  body.appendChild(grid);

  // Mode toggle
  const sep = document.createElement('div');
  sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.08);margin:10px 0 8px';
  body.appendChild(sep);

  const modeLabel = document.createElement('div');
  modeLabel.className = 'ofp-label';
  modeLabel.textContent = t('ofpNumbering');
  body.appendChild(modeLabel);

  const modeGroup = document.createElement('div');
  modeGroup.className = 'ofp-btn-group';

  const btnNum   = document.createElement('button');
  const btnAlpha = document.createElement('button');
  btnNum.textContent   = '1, 2, 3';
  btnAlpha.textContent = 'A, B, C';
  if (currentBadgeMode === 'numeric') btnNum.classList.add('active');
  else btnAlpha.classList.add('active');

  btnNum.addEventListener('click', () => {
    btnNum.classList.add('active'); btnAlpha.classList.remove('active');
    currentBadgeMode = 'numeric'; setBadgeMode('numeric');
  });
  btnAlpha.addEventListener('click', () => {
    btnAlpha.classList.add('active'); btnNum.classList.remove('active');
    currentBadgeMode = 'alpha'; setBadgeMode('alpha');
  });

  modeGroup.appendChild(btnNum);
  modeGroup.appendChild(btnAlpha);
  body.appendChild(modeGroup);
}

// ─── Highlight Preset Panel ───────────────────────────────────────────────────

function buildHighlightPresetPanel() {
  const body = $('tool-options-body');
  body.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'tool-options-label';
  label.textContent = t('ofpHighlightColor');
  body.appendChild(label);

  const grid = document.createElement('div');
  grid.className = 'rect-preset-grid';

  HIGHLIGHT_PRESETS.forEach((preset, i) => {
    if ((deletedBuiltins.highlight || []).includes(preset.id)) return;
    const thumb = document.createElement('div');
    thumb.className = 'rect-preset-thumb' + (i === selectedHighlightPresetIndex ? ' selected' : '');

    const c = document.createElement('canvas');
    c.width = 60; c.height = 40;
    drawHighlightThumb(c.getContext('2d'), preset, 60, 40);
    thumb.appendChild(c);
    addBuiltinDeleteBtn(thumb, 'highlight', preset.id);

    thumb.addEventListener('click', () => {
      grid.querySelectorAll('.rect-preset-thumb').forEach(t => t.classList.remove('selected'));
      thumb.classList.add('selected');
      selectedHighlightPresetIndex = i;
      setHighlightPreset(preset);
    });
    grid.appendChild(thumb);
  });

  appendCustomPresetsToGrid(grid, 'highlight', drawHighlightThumb, (preset) => setHighlightPreset(preset));
  body.appendChild(grid);
}

function drawHighlightThumb(ctx, preset, w, h) {
  ctx.clearRect(0, 0, w, h);
  const pad = 7;
  ctx.save();
  ctx.globalAlpha = preset.opacity + 0.15;
  ctx.fillStyle = preset.color;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(pad, pad * 0.9, w - pad * 2, h - pad * 1.8, 3);
  else ctx.rect(pad, pad * 0.9, w - pad * 2, h - pad * 1.8);
  ctx.fill();
  ctx.restore();
}

function buildHighlightFormatControls(body, obj) {
  // Color
  const colorRow = makeRow(t('color'));
  const colorInner = document.createElement('div'); colorInner.className = 'ofp-color-row';
  const swatch = document.createElement('div'); swatch.className = 'ofp-color-swatch';
  const col = obj._highlightColor || obj.fill || '#FDE047';
  swatch.style.background = col;
  const colorInput = document.createElement('input'); colorInput.type = 'color'; colorInput.value = rgbToHex(col);
  swatch.appendChild(colorInput);
  const hexInput = document.createElement('input'); hexInput.type = 'text'; hexInput.className = 'ofp-hex-input';
  hexInput.value = colorInput.value.toUpperCase(); hexInput.maxLength = 7;
  const applyColor = (hex) => {
    swatch.style.background = hex;
    obj.set({ fill: hex }); obj._highlightColor = hex;
    obj.canvas?.renderAll(); scheduleAnnotationSave();
  };
  colorInput.addEventListener('input', e => { hexInput.value = e.target.value.toUpperCase(); applyColor(e.target.value); });
  colorInput.addEventListener('change', () => saveUndo());
  hexInput.addEventListener('change', e => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) { colorInput.value = v; applyColor(v); saveUndo(); }
  });
  colorInner.appendChild(swatch); colorInner.appendChild(hexInput);
  colorRow.appendChild(colorInner); body.appendChild(colorRow);

  // Opacity
  const opRow = makeRow(t('opacity'));
  const opRR = document.createElement('div'); opRR.className = 'ofp-range-row';
  const opRange = document.createElement('input'); opRange.type = 'range'; opRange.className = 'ofp-range';
  opRange.min = 10; opRange.max = 80; opRange.value = Math.round((obj.opacity ?? 0.42) * 100);
  const opVal = makeEditableVal(opRange, '%');
  opRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); opVal.textContent = v + '%';
    obj.set({ opacity: v / 100 }); obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  opRange.addEventListener('change', () => saveUndo());
  opRR.appendChild(opRange); opRR.appendChild(opVal);
  opRow.appendChild(opRR); body.appendChild(opRow);

  // Corner Radius
  const rxRow = makeRow(t('ofpCornerRadius'));
  const rxRR = document.createElement('div'); rxRR.className = 'ofp-range-row';
  const rxRange = document.createElement('input'); rxRange.type = 'range'; rxRange.className = 'ofp-range';
  rxRange.min = 0; rxRange.max = 30; rxRange.value = obj.rx || 0;
  const rxVal = makeEditableVal(rxRange, '');
  rxRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); rxVal.textContent = v;
    obj.set({ rx: v, ry: v }); obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  rxRange.addEventListener('change', () => saveUndo());
  rxRR.appendChild(rxRange); rxRR.appendChild(rxVal);
  rxRow.appendChild(rxRR); body.appendChild(rxRow);

  buildRotationControls(body, obj);
  appendPresetSaveBtn(body, 'highlight', () => capturePresetFromObj(obj));
}

// ─── Freehand Preset Panel ────────────────────────────────────────────────────

function buildFreehandPresetPanel() {
  const body = $('tool-options-body');
  body.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'tool-options-label';
  label.textContent = t('ofpPenStyle');
  body.appendChild(label);

  const grid = document.createElement('div');
  grid.className = 'rect-preset-grid';

  FREEHAND_PRESETS.forEach((preset, i) => {
    if ((deletedBuiltins.freehand || []).includes(preset.id)) return;
    const thumb = document.createElement('div');
    thumb.className = 'rect-preset-thumb' + (i === selectedFreehandPresetIndex ? ' selected' : '');

    const c = document.createElement('canvas');
    c.width = 60; c.height = 40;
    drawFreehandThumb(c.getContext('2d'), preset, 60, 40);
    thumb.appendChild(c);
    addBuiltinDeleteBtn(thumb, 'freehand', preset.id);

    thumb.addEventListener('click', () => {
      grid.querySelectorAll('.rect-preset-thumb').forEach(t => t.classList.remove('selected'));
      thumb.classList.add('selected');
      selectedFreehandPresetIndex = i;
      setFreehandPreset(preset);
    });
    grid.appendChild(thumb);
  });

  appendCustomPresetsToGrid(grid, 'freehand', drawFreehandThumb, (preset) => setFreehandPreset(preset));
  body.appendChild(grid);

  // Info block (occupies the second row where presets 4-6 would be)
  const info = document.createElement('div');
  info.style.cssText = 'margin-top:8px;padding:7px 9px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:6px;font-size:10px;line-height:1.5;color:rgba(255,255,255,0.55)';
  info.textContent = t('shiftStraightLine');
  body.appendChild(info);
}

function drawFreehandThumb(ctx, preset, w, h) {
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const lw = Math.min(preset.width, 8);

  if (preset.borderWidth > 0 && preset.borderColor) {
    ctx.save();
    ctx.strokeStyle = preset.borderColor;
    ctx.lineWidth = lw + preset.borderWidth * 2;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(8, cy + 4); ctx.bezierCurveTo(cx * 0.7, cy - 8, cx * 1.3, cy + 8, w - 8, cy - 4);
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  if (preset.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 4; ctx.shadowOffsetX = 1; ctx.shadowOffsetY = 1;
  }
  ctx.strokeStyle = preset.color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(8, cy + 4); ctx.bezierCurveTo(cx * 0.7, cy - 8, cx * 1.3, cy + 8, w - 8, cy - 4);
  ctx.stroke();
  ctx.restore();
}

function recomputeFreehandShadow(obj) {
  if (obj._freehandHasShadow) {
    obj.set({ shadow: new fabric.Shadow({ color: 'rgba(0,0,0,0.45)', blur: 6, offsetX: 2, offsetY: 2 }) });
  } else {
    obj.set({ shadow: null });
  }
  if (obj.type === 'freehandPath') obj.dirty = true;
}

function buildFreehandFormatControls(body, obj) {
  // Color
  const colorRow = makeRow(t('color'));
  const colorInner = document.createElement('div'); colorInner.className = 'ofp-color-row';
  const swatch = document.createElement('div'); swatch.className = 'ofp-color-swatch';
  const col = obj._freehandColor || obj.stroke || '#EF4444';
  swatch.style.background = col;
  const colorInput = document.createElement('input'); colorInput.type = 'color'; colorInput.value = rgbToHex(col);
  swatch.appendChild(colorInput);
  const hexInput = document.createElement('input'); hexInput.type = 'text'; hexInput.className = 'ofp-hex-input';
  hexInput.value = colorInput.value.toUpperCase(); hexInput.maxLength = 7;
  const applyColor = (hex) => {
    swatch.style.background = hex; obj._freehandColor = hex;
    obj.set({ stroke: hex }); obj.canvas?.renderAll(); scheduleAnnotationSave();
  };
  colorInput.addEventListener('input', e => { hexInput.value = e.target.value.toUpperCase(); applyColor(e.target.value); });
  colorInput.addEventListener('change', () => saveUndo());
  hexInput.addEventListener('change', e => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) { colorInput.value = v; applyColor(v); saveUndo(); }
  });
  colorInner.appendChild(swatch); colorInner.appendChild(hexInput);
  colorRow.appendChild(colorInner); body.appendChild(colorRow);

  // Pen width
  const pwRow = makeRow(t('ofpPenWidth'));
  const pwRR = document.createElement('div'); pwRR.className = 'ofp-range-row';
  const pwRange = document.createElement('input'); pwRange.type = 'range'; pwRange.className = 'ofp-range';
  pwRange.min = 1; pwRange.max = 30; pwRange.value = obj.strokeWidth || obj._freehandWidth || 3;
  const pwVal = makeEditableVal(pwRange, '');
  pwRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); pwVal.textContent = v;
    obj._freehandWidth = v; obj.set({ strokeWidth: v }); obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  pwRange.addEventListener('change', () => saveUndo());
  pwRR.appendChild(pwRange); pwRR.appendChild(pwVal);
  pwRow.appendChild(pwRR); body.appendChild(pwRow);

  // Border color
  const bcRow = makeRow(t('ofpBorderColor'));
  const bcInner = document.createElement('div'); bcInner.className = 'ofp-color-row';
  const bcSwatch = document.createElement('div'); bcSwatch.className = 'ofp-color-swatch';
  const bc = obj._freehandBorderColor || '#000000';
  bcSwatch.style.background = bc;
  const bcInput = document.createElement('input'); bcInput.type = 'color'; bcInput.value = rgbToHex(bc);
  bcSwatch.appendChild(bcInput);
  const bcHex = document.createElement('input'); bcHex.type = 'text'; bcHex.className = 'ofp-hex-input';
  bcHex.value = bcInput.value.toUpperCase(); bcHex.maxLength = 7;
  const applyBc = (hex) => {
    bcSwatch.style.background = hex; obj._freehandBorderColor = hex;
    if (obj.type === 'freehandPath') obj.dirty = true;
    else recomputeFreehandShadow(obj);
    obj.canvas?.renderAll(); scheduleAnnotationSave();
  };
  bcInput.addEventListener('input', e => { bcHex.value = e.target.value.toUpperCase(); applyBc(e.target.value); });
  bcInput.addEventListener('change', () => saveUndo());
  bcHex.addEventListener('change', e => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) { bcInput.value = v; applyBc(v); saveUndo(); }
  });
  bcInner.appendChild(bcSwatch); bcInner.appendChild(bcHex);
  bcRow.appendChild(bcInner); body.appendChild(bcRow);

  // Border width
  const bwRow = makeRow(t('strokeWidth'));
  const bwRR = document.createElement('div'); bwRR.className = 'ofp-range-row';
  const bwRange = document.createElement('input'); bwRange.type = 'range'; bwRange.className = 'ofp-range';
  bwRange.min = 0; bwRange.max = 6; bwRange.value = obj._freehandBorderWidth || 0;
  const bwVal = makeEditableVal(bwRange, '');
  bwRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); bwVal.textContent = v;
    obj._freehandBorderWidth = v;
    if (v > 0 && !obj._freehandBorderColor) { obj._freehandBorderColor = '#000000'; bcSwatch.style.background = '#000000'; bcInput.value = '#000000'; bcHex.value = '#000000'; }
    if (obj.type === 'freehandPath') obj.dirty = true;
    else recomputeFreehandShadow(obj);
    obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  bwRange.addEventListener('change', () => saveUndo());
  bwRR.appendChild(bwRange); bwRR.appendChild(bwVal);
  bwRow.appendChild(bwRR); body.appendChild(bwRow);

  // Opacity
  const opRow = makeRow(t('opacity'));
  const opRR = document.createElement('div'); opRR.className = 'ofp-range-row';
  const opRange = document.createElement('input'); opRange.type = 'range'; opRange.className = 'ofp-range';
  opRange.min = 10; opRange.max = 100; opRange.value = Math.round((obj.opacity ?? 1) * 100);
  const opVal = makeEditableVal(opRange, '%');
  opRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); opVal.textContent = v + '%';
    obj.set({ opacity: v / 100 }); obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  opRange.addEventListener('change', () => saveUndo());
  opRR.appendChild(opRange); opRR.appendChild(opVal);
  opRow.appendChild(opRR); body.appendChild(opRow);

  // Shadow
  const shadowRow = document.createElement('label'); shadowRow.className = 'ofp-checkbox-row';
  const shadowCb = document.createElement('input'); shadowCb.type = 'checkbox';
  shadowCb.checked = !!obj._freehandHasShadow;
  shadowCb.addEventListener('change', e => {
    obj._freehandHasShadow = e.target.checked;
    recomputeFreehandShadow(obj); obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo();
  });
  const shadowLabel = document.createElement('span'); shadowLabel.className = 'ofp-checkbox-label'; shadowLabel.textContent = t('ofpShadow');
  shadowRow.appendChild(shadowCb); shadowRow.appendChild(shadowLabel);
  body.appendChild(shadowRow);

  appendPresetSaveBtn(body, 'freehand', () => capturePresetFromObj(obj));
}

// ─── Arrow Preset Panel ───────────────────────────────────────────────────────

function buildArrowPresetPanel() {
  const body = $('tool-options-body');
  body.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'tool-options-label';
  label.textContent = t('ofpArrowStyle');
  body.appendChild(label);

  const grid = document.createElement('div');
  grid.className = 'rect-preset-grid';

  ARROW_PRESETS.forEach((preset, i) => {
    if ((deletedBuiltins.arrow || []).includes(preset.id)) return;
    const thumb = document.createElement('div');
    thumb.className = 'rect-preset-thumb' + (i === selectedArrowPresetIndex ? ' selected' : '');
    const c = document.createElement('canvas');
    c.width = 60; c.height = 40;
    drawArrowThumb(c.getContext('2d'), preset, 60, 40);
    thumb.appendChild(c);
    addBuiltinDeleteBtn(thumb, 'arrow', preset.id);
    thumb.addEventListener('click', () => {
      grid.querySelectorAll('.rect-preset-thumb').forEach(t => t.classList.remove('selected'));
      thumb.classList.add('selected');
      selectedArrowPresetIndex = i;
      setArrowPreset(preset);
    });
    grid.appendChild(thumb);
  });

  appendCustomPresetsToGrid(grid, 'arrow', drawArrowThumb, (preset) => setArrowPreset(preset));
  body.appendChild(grid);
}

// ─── Image Preset Panel ───────────────────────────────────────────────────────

function buildImagePresetPanel() {
  const body = $('tool-options-body');
  body.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'tool-options-label';
  label.textContent = t('ofpImageStyle');
  body.appendChild(label);

  const uploadBtn = document.createElement('button');
  uploadBtn.style.cssText = 'width:100%;margin-bottom:8px;padding:6px 10px;font-size:11px;font-family:inherit;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:5px;color:rgba(255,255,255,0.8);cursor:pointer;text-align:center';
  uploadBtn.textContent = t('ofpImageUpload');
  uploadBtn.addEventListener('click', () => {
    $('image-file-input').click();
    $('tool-options-panel').classList.add('hidden');
  });
  body.appendChild(uploadBtn);

  const imagePresets = customPresets.image || [];
  if (imagePresets.length > 0) {
    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.07);margin:2px 0 8px';
    body.appendChild(sep);

    const grid = document.createElement('div');
    grid.className = 'rect-preset-grid';
    appendCustomPresetsToGrid(grid, 'image', () => {}, (preset) => {
      placeImage(preset.dataUrl, preset.opacity ?? 1, preset.scale ?? null);
      $('tool-options-panel').classList.add('hidden');
    });
    body.appendChild(grid);
  }
}

function drawArrowThumb(ctx, preset, w, h) {
  ctx.clearRect(0, 0, w, h);
  const x1 = 8, y1 = h * 0.68, x2 = w - 8, y2 = h * 0.32;
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  const aw = Math.min(preset.arrowWidth, 5);
  const hs = Math.min(aw * 4.5, len * 0.4);
  const perp = angle + Math.PI / 2;

  if (preset.borderWidth > 0 && preset.borderColor) {
    _thumbArrow(ctx, x1, y1, x2, y2, preset.arrowType, preset.borderColor, aw + preset.borderWidth * 2, hs, angle, perp, dx, dy);
  }
  _thumbArrow(ctx, x1, y1, x2, y2, preset.arrowType, preset.arrowColor, aw, hs, angle, perp, dx, dy);
}

function _thumbArrow(ctx, x1, y1, x2, y2, type, color, w, hs, angle, perp, dx, dy) {
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  if (type === 'line') {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  } else if (type === 'line-dot') {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x2, y2, w * 1.5, 0, Math.PI * 2); ctx.fill();
  } else if (type === 'line-two-dots') {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x1, y1, w * 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x2, y2, w * 1.5, 0, Math.PI * 2); ctx.fill();
  } else if (type === 'simple') {
    const hx = x2 - Math.cos(angle) * hs, hy = y2 - Math.sin(angle) * hs;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(angle - 0.4) * hs, y2 - Math.sin(angle - 0.4) * hs);
    ctx.lineTo(x2 - Math.cos(angle + 0.4) * hs, y2 - Math.sin(angle + 0.4) * hs);
    ctx.closePath(); ctx.fill();
  } else if (type === 'double') {
    const h1x = x1 + Math.cos(angle) * hs, h1y = y1 + Math.sin(angle) * hs;
    const h2x = x2 - Math.cos(angle) * hs, h2y = y2 - Math.sin(angle) * hs;
    ctx.beginPath(); ctx.moveTo(h1x, h1y); ctx.lineTo(h2x, h2y); ctx.stroke();
    [[x2, y2, angle], [x1, y1, angle + Math.PI]].forEach(([px, py, a]) => {
      ctx.beginPath(); ctx.moveTo(px, py);
      ctx.lineTo(px - Math.cos(a - 0.4) * hs, py - Math.sin(a - 0.4) * hs);
      ctx.lineTo(px - Math.cos(a + 0.4) * hs, py - Math.sin(a + 0.4) * hs);
      ctx.closePath(); ctx.fill();
    });
  } else if (type === 'design' || type === 'design-gradient') {
    const tw = w * 0.2;
    const hx = x2 - Math.cos(angle) * hs * 0.85, hy = y2 - Math.sin(angle) * hs * 0.85;
    if (type === 'design-gradient') {
      const f33x = x1 + dx * 0.33, f33y = y1 + dy * 0.33;
      const grad = ctx.createLinearGradient(x1, y1, f33x, f33y);
      grad.addColorStop(0, color + '00'); grad.addColorStop(1, color);
      ctx.save(); ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x1 + Math.cos(perp)*tw/2, y1 + Math.sin(perp)*tw/2);
      ctx.lineTo(x1 - Math.cos(perp)*tw/2, y1 - Math.sin(perp)*tw/2);
      ctx.lineTo(f33x - Math.cos(perp)*w*0.35, f33y - Math.sin(perp)*w*0.35);
      ctx.lineTo(f33x + Math.cos(perp)*w*0.35, f33y + Math.sin(perp)*w*0.35);
      ctx.closePath(); ctx.fill(); ctx.restore();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(f33x + Math.cos(perp)*w*0.35, f33y + Math.sin(perp)*w*0.35);
      ctx.lineTo(f33x - Math.cos(perp)*w*0.35, f33y - Math.sin(perp)*w*0.35);
      ctx.lineTo(hx - Math.cos(perp)*w/2, hy - Math.sin(perp)*w/2);
      ctx.lineTo(hx + Math.cos(perp)*w/2, hy + Math.sin(perp)*w/2);
      ctx.closePath(); ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(x1 + Math.cos(perp)*tw/2, y1 + Math.sin(perp)*tw/2);
      ctx.lineTo(x1 - Math.cos(perp)*tw/2, y1 - Math.sin(perp)*tw/2);
      ctx.lineTo(hx - Math.cos(perp)*w/2, hy - Math.sin(perp)*w/2);
      ctx.lineTo(hx + Math.cos(perp)*w/2, hy + Math.sin(perp)*w/2);
      ctx.closePath(); ctx.fill();
    }
    ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(hx - Math.cos(perp)*w*1.3, hy - Math.sin(perp)*w*1.3);
    ctx.lineTo(hx + Math.cos(perp)*w*1.3, hy + Math.sin(perp)*w*1.3);
    ctx.closePath(); ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.restore();
}

function buildArrowFormatControls(body, obj, skipType = false) {
  // Type (hidden for freehand-shift lines)
  if (!skipType) {
    const typeRow = makeRow(t('ofpArrowType'));
    const typeSel = document.createElement('select'); typeSel.className = 'ofp-select';
    [['design', t('arrowTypeDesign')],['design-gradient', t('arrowTypeDesignGradient')],['simple', t('arrowTypeSimple')],
     ['double', t('arrowTypeDouble')],['line', t('arrowTypeLine')],['line-dot', t('arrowTypeLineDot')],['line-two-dots', t('arrowTypeLineTwoDots')]]
    .forEach(([val, lbl]) => {
      const opt = document.createElement('option'); opt.value = val; opt.textContent = lbl;
      if (obj.arrowType === val) opt.selected = true;
      typeSel.appendChild(opt);
    });
    typeSel.addEventListener('change', e => { obj.arrowType = e.target.value; obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo(); });
    typeRow.appendChild(typeSel); body.appendChild(typeRow);
  }

  // Color
  const colorRow = makeRow(t('color'));
  const colorInner = document.createElement('div'); colorInner.className = 'ofp-color-row';
  const swatch = document.createElement('div'); swatch.className = 'ofp-color-swatch';
  swatch.style.background = obj.arrowColor || '#EF4444';
  const colorInput = document.createElement('input'); colorInput.type = 'color'; colorInput.value = rgbToHex(obj.arrowColor || '#EF4444');
  swatch.appendChild(colorInput);
  const hexInput = document.createElement('input'); hexInput.type = 'text'; hexInput.className = 'ofp-hex-input';
  hexInput.value = colorInput.value.toUpperCase(); hexInput.maxLength = 7;
  const applyColor = (hex) => { swatch.style.background = hex; obj.arrowColor = hex; obj.canvas?.renderAll(); scheduleAnnotationSave(); };
  colorInput.addEventListener('input', e => { hexInput.value = e.target.value.toUpperCase(); applyColor(e.target.value); });
  colorInput.addEventListener('change', () => saveUndo());
  hexInput.addEventListener('change', e => { let v = e.target.value.trim(); if (!v.startsWith('#')) v = '#' + v; if (/^#[0-9A-Fa-f]{6}$/.test(v)) { colorInput.value = v; applyColor(v); saveUndo(); } });
  colorInner.appendChild(swatch); colorInner.appendChild(hexInput);
  colorRow.appendChild(colorInner); body.appendChild(colorRow);

  // Arrow Width
  const awRow = makeRow(t('ofpArrowWidth'));
  const awRR = document.createElement('div'); awRR.className = 'ofp-range-row';
  const awRange = document.createElement('input'); awRange.type = 'range'; awRange.className = 'ofp-range';
  awRange.min = 1; awRange.max = 20; awRange.value = obj.arrowWidth || 4;
  const awVal = makeEditableVal(awRange, '');
  awRange.addEventListener('input', e => { const v = parseInt(e.target.value); awVal.textContent = v; obj.arrowWidth = v; obj.canvas?.renderAll(); scheduleAnnotationSave(); });
  awRange.addEventListener('change', () => saveUndo());
  awRR.appendChild(awRange); awRR.appendChild(awVal);
  awRow.appendChild(awRR); body.appendChild(awRow);

  // Border Color
  const bcRow = makeRow(t('ofpBorderColor'));
  const bcInner = document.createElement('div'); bcInner.className = 'ofp-color-row';
  const bcSwatch = document.createElement('div'); bcSwatch.className = 'ofp-color-swatch';
  bcSwatch.style.background = obj.borderColor || '#000000';
  const bcInput = document.createElement('input'); bcInput.type = 'color'; bcInput.value = rgbToHex(obj.borderColor || '#000000');
  bcSwatch.appendChild(bcInput);
  const bcHex = document.createElement('input'); bcHex.type = 'text'; bcHex.className = 'ofp-hex-input';
  bcHex.value = bcInput.value.toUpperCase(); bcHex.maxLength = 7;
  const applyBc = (hex) => { bcSwatch.style.background = hex; obj.borderColor = hex; obj.canvas?.renderAll(); scheduleAnnotationSave(); };
  bcInput.addEventListener('input', e => { bcHex.value = e.target.value.toUpperCase(); applyBc(e.target.value); });
  bcInput.addEventListener('change', () => saveUndo());
  bcHex.addEventListener('change', e => { let v = e.target.value.trim(); if (!v.startsWith('#')) v = '#' + v; if (/^#[0-9A-Fa-f]{6}$/.test(v)) { bcInput.value = v; applyBc(v); saveUndo(); } });
  bcInner.appendChild(bcSwatch); bcInner.appendChild(bcHex);
  bcRow.appendChild(bcInner); body.appendChild(bcRow);

  // Border Width
  const bwRow = makeRow(t('strokeWidth'));
  const bwRR = document.createElement('div'); bwRR.className = 'ofp-range-row';
  const bwRange = document.createElement('input'); bwRange.type = 'range'; bwRange.className = 'ofp-range';
  bwRange.min = 0; bwRange.max = 8; bwRange.value = obj.borderWidth || 0;
  const bwVal = makeEditableVal(bwRange, '');
  bwRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); bwVal.textContent = v; obj.borderWidth = v;
    if (v > 0 && !obj.borderColor) { obj.borderColor = '#000000'; bcSwatch.style.background = '#000000'; bcInput.value = '#000000'; bcHex.value = '#000000'; }
    obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  bwRange.addEventListener('change', () => saveUndo());
  bwRR.appendChild(bwRange); bwRR.appendChild(bwVal);
  bwRow.appendChild(bwRR); body.appendChild(bwRow);

  // Opacity
  const opRow = makeRow(t('opacity'));
  const opRR = document.createElement('div'); opRR.className = 'ofp-range-row';
  const opRange = document.createElement('input'); opRange.type = 'range'; opRange.className = 'ofp-range';
  opRange.min = 10; opRange.max = 100; opRange.value = Math.round((obj.opacity ?? 1) * 100);
  const opVal = makeEditableVal(opRange, '%');
  opRange.addEventListener('input', e => { const v = parseInt(e.target.value); opVal.textContent = v + '%'; obj.set({ opacity: v / 100 }); obj.canvas?.renderAll(); scheduleAnnotationSave(); });
  opRange.addEventListener('change', () => saveUndo());
  opRR.appendChild(opRange); opRR.appendChild(opVal);
  opRow.appendChild(opRR); body.appendChild(opRow);

  // Shadow
  const shadowRow = document.createElement('label'); shadowRow.className = 'ofp-checkbox-row';
  const shadowCb = document.createElement('input'); shadowCb.type = 'checkbox'; shadowCb.checked = !!obj.arrowShadow;
  shadowCb.addEventListener('change', e => { obj.arrowShadow = e.target.checked; obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo(); });
  const shadowLabel = document.createElement('span'); shadowLabel.className = 'ofp-checkbox-label'; shadowLabel.textContent = t('ofpShadow');
  shadowRow.appendChild(shadowCb); shadowRow.appendChild(shadowLabel);
  body.appendChild(shadowRow);

  const toolKey = skipType ? 'freehand' : 'arrow';
  appendPresetSaveBtn(body, toolKey, () => capturePresetFromObj(obj));
}

function drawBadgeThumb(ctx, preset, w, h) {
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) / 2 - 7;

  ctx.fillStyle = preset.bg;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  if (preset.shape === 'circle') {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  } else {
    const rx = 4;
    if (ctx.roundRect) ctx.roundRect(cx - r, cy - r, r * 2, r * 2, rx);
    else ctx.rect(cx - r, cy - r, r * 2, r * 2);
  }
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = preset.fg;
  ctx.font = 'bold 11px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('1', cx, cy + 0.5);
}

function drawPresetThumb(ctx, preset, w, h) {
  ctx.clearRect(0, 0, w, h);
  const pad = 6;

  if (preset.blurOutside) {
    // Blur-outside preview: blurred grey outer, sharp inner with border
    ctx.fillStyle = 'rgba(120,120,140,0.45)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(30,30,46,0.18)';
    ctx.fillRect(pad, pad, w - pad * 2, h - pad * 2);
    if (preset.stroke && preset.strokeWidth > 0) {
      ctx.strokeStyle = preset.stroke;
      ctx.lineWidth = Math.min(preset.strokeWidth, 3);
      ctx.lineJoin = 'round';
      roundRect(ctx, pad, pad, w - pad * 2, h - pad * 2, preset.rx);
      ctx.stroke();
    }
    return;
  }

  if (preset.outsideFillOpacity > 0) {
    // Vignette preview: dark outer, lighter inner
    ctx.fillStyle = `rgba(0,0,0,${preset.outsideFillOpacity + 0.1})`;
    ctx.fillRect(0, 0, w, h);
    ctx.clearRect(pad + 4, pad + 4, w - (pad + 4) * 2, h - (pad + 4) * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(pad + 4, pad + 4, w - (pad + 4) * 2, h - (pad + 4) * 2);
    return;
  }

  if (preset.insideFillOpacity > 0) {
    ctx.globalAlpha = preset.insideFillOpacity;
    ctx.fillStyle = preset.fillColor;
    roundRect(ctx, pad, pad, w - pad * 2, h - pad * 2, preset.rx);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  if (preset.stroke && preset.strokeWidth > 0) {
    ctx.strokeStyle = preset.stroke;
    ctx.lineWidth = Math.min(preset.strokeWidth, 3);
    if (preset.strokeDashArray) ctx.setLineDash(preset.strokeDashArray);
    ctx.lineJoin = 'round';
    roundRect(ctx, pad, pad, w - pad * 2, h - pad * 2, preset.rx);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  if (r > 0 && ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
  else { ctx.beginPath(); ctx.rect(x, y, w, h); }
}

// ─── Gear Icon & Format Panel ─────────────────────────────────────────────────

let gearTarget = null;

function initGearIcon() {
  fabricCanvas.on('selection:created', (e) => updateGear(e.selected?.[0]));
  fabricCanvas.on('selection:updated', (e) => updateGear(e.selected?.[0]));
  fabricCanvas.on('selection:cleared', () => hideGear());
  fabricCanvas.on('object:moving',   (e) => { repositionGear(e.target); scheduleBlurUpdate(e.target); scheduleBlurRegionSync(e.target); });
  fabricCanvas.on('object:modified', (e) => { if (e.target?.blurOutside) rebuildGlobalBlurOverlay(); if (e.target?._isBlurRegion) syncBlurRegion(e.target); });
  fabricCanvas.on('object:removed',  (e) => { if (e.target?.blurOutside) rebuildGlobalBlurOverlay(); if (!isRestoringUndo && e.target?._isBadge) renumberBadgesAfterDelete(e.target._badgeValue, e.target._badgeType); updateExportButton(); });
  fabricCanvas.on('object:scaling',  (e) => {
    const obj = e.target;
    if (obj._isBadge || obj._isCustomImage || obj._isEmoji) {
      const s = Math.max(obj.scaleX, obj.scaleY);
      if (obj.scaleX !== s || obj.scaleY !== s) {
        // Compute anchor corner position BEFORE changing scale so it stays fixed
        const t = e.transform;
        const anchor = obj.translateToOriginPoint(obj.getCenterPoint(), t.originX, t.originY);
        obj.set({ scaleX: s, scaleY: s });
        obj.setPositionByOrigin(anchor, t.originX, t.originY);
      }
    }
    if (obj.type === 'textbox') {
      obj.set({ width: Math.max(40, obj.width * obj.scaleX), scaleX: 1, scaleY: 1 });
    }
    repositionGear(obj); scheduleBlurUpdate(obj);
  });
  fabricCanvas.on('object:rotating', (e) => { repositionGear(e.target); scheduleBlurUpdate(e.target); });
  fabricCanvas.on('after:render', () => { if (gearTarget) repositionGear(gearTarget); });

  $('object-gear-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = $('object-format-panel');
    if (panel.classList.contains('hidden')) {
      openFormatPanel();
    } else {
      panel.classList.add('hidden');
    }
  });

  $('btn-close-format').addEventListener('click', () => {
    $('object-format-panel').classList.add('hidden');
  });
}

function updateGear(obj) {
  if (!obj) { hideGear(); return; }
  gearTarget = obj;
  repositionGear(obj);
  $('object-gear-btn').classList.remove('hidden');
}

function hideGear() {
  gearTarget = null;
  $('object-gear-btn').classList.add('hidden');
  $('object-format-panel').classList.add('hidden');
}

function repositionGear(obj) {
  if (!obj || !fabricCanvas) return;
  obj.setCoords();
  const canvasEl = fabricCanvas.getElement();
  const cr = canvasEl.getBoundingClientRect();
  const tr = obj.oCoords?.tr;
  if (!tr) return;
  const btn = $('object-gear-btn');
  const bs = 26;
  const offset = 8;
  btn.style.left = (cr.left + tr.x + offset) + 'px';
  btn.style.top  = (cr.top  + tr.y - bs / 2) + 'px';

}

function positionFormatPanel(x, y) {
  const panel = $('object-format-panel');
  const pw = 220, ph = panel.offsetHeight || 280;
  const vw = window.innerWidth, vh = window.innerHeight;
  const fx = Math.min(x, vw - pw - 8);
  const fy = Math.max(8, Math.min(y, vh - ph - 8));
  panel.style.left = fx + 'px';
  panel.style.top  = fy + 'px';
}

function openFormatPanel() {
  if (!gearTarget) return;
  const panel = $('object-format-panel');
  buildFormatPanelBody(gearTarget);
  panel.classList.remove('hidden');

  const btn = $('object-gear-btn');
  const br = btn.getBoundingClientRect();
  positionFormatPanel(br.right + 6, br.top);
}

function buildFormatPanelBody(obj) {
  const body = $('object-format-body');
  body.innerHTML = '';

  if (obj.type === 'arrowShape') {
    buildArrowFormatControls(body, obj, !!obj._isFreehandLine);
  } else if (obj.type === 'vignetteRect') {
    buildRectFormatControls(body, obj);
  } else if (obj.type === 'vignetteEllipse') {
    buildEllipseFormatControls(body, obj);
  } else if (obj._isFreehand) {
    buildFreehandFormatControls(body, obj);
  } else if (obj._isHighlight) {
    buildHighlightFormatControls(body, obj);
  } else if (obj._isBlurRegion) {
    buildBlurFormatControls(body, obj);
  } else if (obj._isCustomImage) {
    buildImageFormatControls(body, obj);
  } else if (obj._isEmoji) {
    buildEmojiFormatControls(body, obj);
  } else if (obj._isBadge || obj._badgeValue != null) {
    if (!obj._isBadge) obj._isBadge = true; // re-mark after enlivenObjects
    buildBadgeFormatControls(body, obj);
  } else if (obj.type === 'textbox') {
    buildTextFormatControls(body, obj);
  } else {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.3);text-align:center;padding:12px 0;line-height:1.5';
    hint.textContent = t('ofpFormatFuture');
    body.appendChild(hint);
  }

}

function buildBlurFormatControls(body, obj) {
  // Blur strength
  const row = makeRow(t('ofpBlurStrength'));
  const rr = document.createElement('div'); rr.className = 'ofp-range-row';
  const range = document.createElement('input'); range.type = 'range'; range.className = 'ofp-range';
  range.min = 1; range.max = 40; range.value = obj._blurStrength ?? 14;
  const val = makeEditableVal(range, 'px');
  range.addEventListener('input', e => {
    val.textContent = e.target.value + 'px';
    reapplyBlur(obj, parseInt(e.target.value));
    scheduleAnnotationSave();
  });
  range.addEventListener('change', () => saveUndo());
  rr.appendChild(range); rr.appendChild(val);
  row.appendChild(rr); body.appendChild(row);

  // Corner radius
  const rxRow = makeRow(t('ofpCornerRadius'));
  const rxRR = document.createElement('div'); rxRR.className = 'ofp-range-row';
  const rxRange = document.createElement('input'); rxRange.type = 'range'; rxRange.className = 'ofp-range';
  rxRange.min = 0; rxRange.max = 40; rxRange.value = obj._blurCornerRadius ?? 0;
  const rxVal = makeEditableVal(rxRange, '');
  rxRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); rxVal.textContent = v;
    obj._blurCornerRadius = v;
    applyBlurClipPath(obj, v);
    scheduleAnnotationSave();
  });
  rxRange.addEventListener('change', () => saveUndo());
  rxRR.appendChild(rxRange); rxRR.appendChild(rxVal);
  rxRow.appendChild(rxRR); body.appendChild(rxRow);
}

function buildImageFormatControls(body, obj) {
  // Opacity
  const opRow = makeRow(t('opacity'));
  const opRR = document.createElement('div'); opRR.className = 'ofp-range-row';
  const opRange = document.createElement('input'); opRange.type = 'range'; opRange.className = 'ofp-range';
  opRange.min = 5; opRange.max = 100; opRange.value = Math.round((obj.opacity ?? 1) * 100);
  const opVal = makeEditableVal(opRange, '%');
  opRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); opVal.textContent = v + '%';
    obj.set({ opacity: v / 100 }); obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  opRange.addEventListener('change', () => saveUndo());
  opRR.appendChild(opRange); opRR.appendChild(opVal);
  opRow.appendChild(opRR); body.appendChild(opRow);

  buildRotationControls(body, obj);
  appendPresetSaveBtn(body, 'image', () => {
    const dataUrl = obj._imageDataUrl || '';
    if (!dataUrl) return null;
    // Create a small thumbnail stored alongside the full image
    const thumbUrl = (() => {
      const img2 = new Image();
      img2.src = dataUrl;
      const tc = document.createElement('canvas');
      const maxT = 120;
      const ts = Math.min(maxT / (img2.naturalWidth || 1), maxT / (img2.naturalHeight || 1), 1);
      tc.width = Math.round((img2.naturalWidth || 60) * ts);
      tc.height = Math.round((img2.naturalHeight || 40) * ts);
      tc.getContext('2d').drawImage(img2, 0, 0, tc.width, tc.height);
      return tc.toDataURL('image/jpeg', 0.7);
    })();
    return { id: Date.now(), dataUrl, thumbUrl, opacity: obj.opacity ?? 1, scale: obj.scaleX ?? null };
  });
}

// ─── Emoji Format Controls ────────────────────────────────────────────────────

function buildEmojiFormatControls(body, obj) {
  // Opacity
  const opRow = makeRow(t('opacity'));
  const opRR = document.createElement('div'); opRR.className = 'ofp-range-row';
  const opRange = document.createElement('input'); opRange.type = 'range'; opRange.className = 'ofp-range';
  opRange.min = 10; opRange.max = 100; opRange.value = Math.round((obj.opacity ?? 1) * 100);
  const opVal = makeEditableVal(opRange, '%');
  opRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); opVal.textContent = v + '%';
    obj.set({ opacity: v / 100 }); obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  opRange.addEventListener('change', () => saveUndo());
  opRR.appendChild(opRange); opRR.appendChild(opVal);
  opRow.appendChild(opRR); body.appendChild(opRow);

  // Shadow
  const shadowRow = document.createElement('label'); shadowRow.className = 'ofp-checkbox-row';
  const shadowCb = document.createElement('input'); shadowCb.type = 'checkbox';
  shadowCb.checked = !!obj.shadow;
  shadowCb.addEventListener('change', e => {
    obj.set({ shadow: e.target.checked ? new fabric.Shadow({ color: 'rgba(0,0,0,0.5)', blur: 8, offsetX: 3, offsetY: 3 }) : null });
    obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo();
  });
  const shadowLabel = document.createElement('span'); shadowLabel.className = 'ofp-checkbox-label'; shadowLabel.textContent = t('ofpShadow');
  shadowRow.appendChild(shadowCb); shadowRow.appendChild(shadowLabel);
  body.appendChild(shadowRow);
}

// ─── Emoji Picker ─────────────────────────────────────────────────────────────

const EMOJI_CATEGORIES = [
  { icon: '😀', label: 'Smileys', emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
  { icon: '👋', label: 'People', emojis: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄','🧑','👶','🧒','👦','👧','👨','👩','🧓','👴','👵','🕵️','👮','💂','🧑‍⚕️','👩‍⚕️','👨‍⚕️','🧑‍🍳','👩‍🍳','👨‍🍳','🧑‍🎓','🧑‍💻','🧑‍🎨','🧑‍✈️','🧑‍🚀'] },
  { icon: '🐶', label: 'Animals', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🦟','🦗','🕷️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦀','🦞','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🐃','🐂','🐄','🦙','🐑','🐏','🐐','🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐈‍⬛','🐓','🦃','🦤','🦚','🦜','🦢','🦩','🕊️','🐇','🦝','🦨','🦡','🦦','🦥','🐁','🐀','🐿️','🦔'] },
  { icon: '🍎', label: 'Food', emojis: ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🍜','🍝','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥮','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🧃','🥤','🧋','☕','🍵','🫖','🍺','🍻','🥂','🍷','🫗','🥃','🍸','🍹','🧉','🍾'] },
  { icon: '✈️', label: 'Travel', emojis: ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🛵','🏍️','🚲','🛴','🛹','🛼','🚏','🛣️','🛤️','⛽','🚧','🚦','🚥','🗺️','🧭','⛵','🚤','🛥️','🛳️','⛴️','🚢','✈️','🛩️','🛫','🛬','💺','🚁','🚟','🚠','🚡','🛰️','🚀','🛸','🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏭','🏗️','🏘️','🏚️','⛪','🏟️','🕌','🛕','⛩️','🕍','⛺','🏕️','🌁','🌃','🏙️','🌄','🌅','🌆','🌇','🌉','🗼','🗽','🗿','🗺️','🏔️','⛰️','🌋','🏕️','🏖️','🏜️','🏝️','🏞️'] },
  { icon: '⚽', label: 'Activities', emojis: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🏓','🏸','🏒','🏑','🥍','🏏','🪃','🥅','⛳','🪁','🏹','🎣','🤿','🥊','🥋','🎽','🛷','🏂','🪂','🏋️','🤼','🤸','⛹️','🤺','🏇','🧘','🏄','🚣','🧗','🚵','🚴','🏆','🥇','🥈','🥉','🏅','🎖️','🎗️','🎫','🎟️','🎪','🤹','🎭','🩰','🎨','🖼️','🎬','🎤','🎧','🎼','🎹','🥁','🪘','🎷','🎺','🪗','🎸','🎻','🪕','🎲','♟️','🎯','🎳','🎮','🕹️','🎰','🧩','🪅','🧸','🪆','🪄','🎉','🎊','🎈','🎀','🎁','🎆','🎇','🧨','✨','🎑','🎃','🎄','🎋','🎍','🎎','🎏','🎐','🧧','🎍'] },
  { icon: '💡', label: 'Objects', emojis: ['💡','🔦','🕯️','🪔','💰','💴','💵','💶','💷','💸','💳','🪙','💹','📈','📉','📊','✉️','📧','📨','📩','📪','📫','📬','📭','📮','🗳️','✏️','✒️','🖊️','🖋️','📝','📁','📂','🗂️','📅','📆','🗒️','🗓️','📇','📋','📌','📍','📎','🖇️','✂️','🗃️','🗄️','🗑️','🔒','🔓','🔏','🔐','🔑','🗝️','🔨','🪓','⛏️','⚒️','🛠️','🗡️','⚔️','🔧','🪛','🔩','⚙️','🗜️','⚖️','🦯','🔗','⛓️','🪝','🧲','🪜','🧪','🧫','🧬','🔭','🔬','🩺','💊','🩹','🩻','🩼','🩺','🪤','🪣','🛁','🚿','🪥','🧴','🧷','🧹','🧺','🪣','🧻','🪣','🧼','🫧','🪒','🪮'] },
  { icon: '❤️', label: 'Symbols', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','❤️‍🔥','❤️‍🩹','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','✡️','🔯','🕎','☯️','🛐','🔱','📛','🔰','♻️','✅','❎','🆗','🆙','🆕','🆓','🆒','🆖','🅰️','🅱️','🆎','🆑','🅾️','🆘','⛔','🚫','📵','🔞','💯','🔛','🔝','🔜','🔚','🔙','🔟','🔃','▶️','⏸️','⏹️','⏺️','⏭️','⏮️','🔀','🔁','🔂','⏩','⏪','🔉','🔊','🔇','📣','📢','🔔','🔕','🎵','🎶','⚠️','🚨','❗','❕','❓','❔','‼️','⁉️','💠','🔷','🔶','🔹','🔸','🔺','🔻','💠','🔘','🔲','🔳','⬛','⬜','◾','◽','▪️','▫️'] },
];

function initEmojiPicker() {
  const tabs = $('emoji-tabs');
  const grid = $('emoji-grid');
  function renderCategory(idx) {
    grid.innerHTML = '';
    EMOJI_CATEGORIES[idx].emojis.forEach(em => {
      const btn = document.createElement('button');
      btn.className = 'emoji-btn';
      btn.textContent = em;
      btn.addEventListener('click', () => {
        placeEmoji(em);
        $('emoji-picker').classList.add('hidden');
        saveUndo();
      });
      grid.appendChild(btn);
    });
    tabs.querySelectorAll('.emoji-tab').forEach((t, i) => t.classList.toggle('active', i === idx));
  }

  EMOJI_CATEGORIES.forEach((cat, i) => {
    const tab = document.createElement('button');
    tab.className = 'emoji-tab' + (i === 0 ? ' active' : '');
    tab.textContent = cat.icon;
    tab.title = cat.label;
    tab.addEventListener('click', () => renderCategory(i));
    tabs.appendChild(tab);
  });

  renderCategory(0);
}

function applyBlurClipPath(obj, r) {
  obj.clipPath = r > 0
    ? new fabric.Rect({ width: obj.width, height: obj.height, rx: r, ry: r, originX: 'center', originY: 'center' })
    : null;
  obj.dirty = true;
  obj.canvas?.renderAll();
}

function buildTextFormatControls(body, obj) {
  // B / I / U
  const styleRow = makeRow(t('ofpStyle'));
  const styleGroup = document.createElement('div'); styleGroup.className = 'ofp-btn-group';
  const btnB = document.createElement('button'); btnB.innerHTML = '<b>B</b>';
  const btnI = document.createElement('button'); btnI.innerHTML = '<i>I</i>';
  const btnU = document.createElement('button'); btnU.innerHTML = '<u>U</u>';
  if (obj.fontWeight === 'bold') btnB.classList.add('active');
  if (obj.fontStyle === 'italic') btnI.classList.add('active');
  if (obj.underline) btnU.classList.add('active');
  btnB.addEventListener('click', () => {
    const bold = obj.fontWeight === 'bold';
    obj.set({ fontWeight: bold ? 'normal' : 'bold' });
    btnB.classList.toggle('active', !bold);
    obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo();
  });
  btnI.addEventListener('click', () => {
    const italic = obj.fontStyle === 'italic';
    obj.set({ fontStyle: italic ? 'normal' : 'italic' });
    btnI.classList.toggle('active', !italic);
    obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo();
  });
  btnU.addEventListener('click', () => {
    obj.set({ underline: !obj.underline });
    btnU.classList.toggle('active', obj.underline);
    obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo();
  });
  styleGroup.appendChild(btnB); styleGroup.appendChild(btnI); styleGroup.appendChild(btnU);
  styleRow.appendChild(styleGroup); body.appendChild(styleRow);

  // Alignment
  const alignRow = makeRow(t('ofpAlignment'));
  const alignGroup = document.createElement('div'); alignGroup.className = 'ofp-btn-group';
  [['left', '←'], ['center', '↔'], ['right', '→']].forEach(([align, icon]) => {
    const btn = document.createElement('button');
    btn.textContent = icon; btn.title = align;
    if ((obj.textAlign || 'left') === align) btn.classList.add('active');
    btn.addEventListener('click', () => {
      alignGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      obj.set({ textAlign: align });
      obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo();
    });
    alignGroup.appendChild(btn);
  });
  alignRow.appendChild(alignGroup); body.appendChild(alignRow);

  // Font
  const fontRow = makeRow(t('ofpFont'));
  const fontSel = document.createElement('select');
  fontSel.className = 'ofp-select';
  [['Arial, sans-serif', 'Arial'], ['Georgia, serif', 'Georgia'], ['Courier New, monospace', 'Courier New'], ['Verdana, sans-serif', 'Verdana'], ['Impact, sans-serif', 'Impact']].forEach(([val, lbl]) => {
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = lbl;
    if ((obj.fontFamily || 'Arial, sans-serif') === val) opt.selected = true;
    fontSel.appendChild(opt);
  });
  fontSel.addEventListener('change', e => {
    obj.set({ fontFamily: e.target.value });
    obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo();
  });
  fontRow.appendChild(fontSel); body.appendChild(fontRow);

  // Text color
  const tcRow = makeRow(t('ofpTextColor'));
  const tcInner = document.createElement('div'); tcInner.className = 'ofp-color-row';
  const tcSwatch = document.createElement('div'); tcSwatch.className = 'ofp-color-swatch';
  const fill = obj.fill || '#EF4444';
  tcSwatch.style.background = fill;
  const tcInput = document.createElement('input'); tcInput.type = 'color'; tcInput.value = rgbToHex(fill);
  tcSwatch.appendChild(tcInput);
  const tcHex = document.createElement('input'); tcHex.type = 'text'; tcHex.className = 'ofp-hex-input';
  tcHex.value = tcInput.value.toUpperCase(); tcHex.maxLength = 7;
  const applyFill = (hex) => { tcSwatch.style.background = hex; obj.set({ fill: hex }); obj.canvas?.renderAll(); scheduleAnnotationSave(); };
  tcInput.addEventListener('input', e => { tcHex.value = e.target.value.toUpperCase(); applyFill(e.target.value); });
  tcInput.addEventListener('change', () => saveUndo());
  tcHex.addEventListener('change', e => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) { tcInput.value = v; applyFill(v); saveUndo(); }
  });
  tcInner.appendChild(tcSwatch); tcInner.appendChild(tcHex);
  tcRow.appendChild(tcInner); body.appendChild(tcRow);

  // Font size
  const fsRow = makeRow(t('ofpFontSize'));
  const fsRR = document.createElement('div'); fsRR.className = 'ofp-range-row';
  const fsRange = document.createElement('input'); fsRange.type = 'range'; fsRange.className = 'ofp-range';
  fsRange.min = 8; fsRange.max = 150; fsRange.value = obj.fontSize || 48;
  const fsVal = makeEditableVal(fsRange, 'px');
  fsRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); fsVal.textContent = v + 'px';
    obj.set({ fontSize: v }); obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  fsRange.addEventListener('change', () => saveUndo());
  fsRR.appendChild(fsRange); fsRR.appendChild(fsVal);
  fsRow.appendChild(fsRR); body.appendChild(fsRow);

  // Opacity
  const opRow = makeRow(t('opacity'));
  const opRR = document.createElement('div'); opRR.className = 'ofp-range-row';
  const opRange = document.createElement('input'); opRange.type = 'range'; opRange.className = 'ofp-range';
  opRange.min = 10; opRange.max = 100; opRange.value = Math.round((obj.opacity ?? 1) * 100);
  const opVal = makeEditableVal(opRange, '%');
  opRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); opVal.textContent = v + '%';
    obj.set({ opacity: v / 100 }); obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  opRange.addEventListener('change', () => saveUndo());
  opRR.appendChild(opRange); opRR.appendChild(opVal);
  opRow.appendChild(opRR); body.appendChild(opRow);

  // Border color
  const bcRow = makeRow(t('ofpBorderColor'));
  const bcInner = document.createElement('div'); bcInner.className = 'ofp-color-row';
  const bcSwatch = document.createElement('div'); bcSwatch.className = 'ofp-color-swatch';
  const stroke = obj.stroke || '#000000';
  bcSwatch.style.background = stroke;
  const bcInput = document.createElement('input'); bcInput.type = 'color'; bcInput.value = rgbToHex(stroke);
  bcSwatch.appendChild(bcInput);
  const bcHex = document.createElement('input'); bcHex.type = 'text'; bcHex.className = 'ofp-hex-input';
  bcHex.value = bcInput.value.toUpperCase(); bcHex.maxLength = 7;
  const applyStroke = (hex) => { bcSwatch.style.background = hex; obj.set({ stroke: hex }); obj.canvas?.renderAll(); scheduleAnnotationSave(); };
  bcInput.addEventListener('input', e => { bcHex.value = e.target.value.toUpperCase(); applyStroke(e.target.value); });
  bcInput.addEventListener('change', () => saveUndo());
  bcHex.addEventListener('change', e => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) { bcInput.value = v; applyStroke(v); saveUndo(); }
  });
  bcInner.appendChild(bcSwatch); bcInner.appendChild(bcHex);
  bcRow.appendChild(bcInner); body.appendChild(bcRow);

  // Border width
  const bwRow = makeRow(t('strokeWidth'));
  const bwRR = document.createElement('div'); bwRR.className = 'ofp-range-row';
  const bwRange = document.createElement('input'); bwRange.type = 'range'; bwRange.className = 'ofp-range';
  bwRange.min = 0; bwRange.max = 10; bwRange.value = obj.strokeWidth || 0;
  const bwVal = makeEditableVal(bwRange, '');
  bwRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); bwVal.textContent = v;
    const update = { strokeWidth: v };
    if (v > 0 && !obj.stroke) {
      update.stroke = '#000000';
      bcSwatch.style.background = '#000000';
      bcInput.value = '#000000';
      bcHex.value = '#000000';
    }
    obj.set(update); obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  bwRange.addEventListener('change', () => saveUndo());
  bwRR.appendChild(bwRange); bwRR.appendChild(bwVal);
  bwRow.appendChild(bwRR); body.appendChild(bwRow);

  // Shadow
  const shadowRow = document.createElement('label'); shadowRow.className = 'ofp-checkbox-row';
  const shadowCb = document.createElement('input'); shadowCb.type = 'checkbox';
  shadowCb.checked = !!obj.shadow;
  shadowCb.addEventListener('change', e => {
    obj.set({ shadow: e.target.checked ? new fabric.Shadow({ color: 'rgba(0,0,0,0.55)', blur: 6, offsetX: 2, offsetY: 2 }) : null });
    obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo();
  });
  const shadowLabel = document.createElement('span'); shadowLabel.className = 'ofp-checkbox-label'; shadowLabel.textContent = t('ofpShadow');
  shadowRow.appendChild(shadowCb); shadowRow.appendChild(shadowLabel);
  body.appendChild(shadowRow);

  buildRotationControls(body, obj);
  appendPresetSaveBtn(body, 'text', () => capturePresetFromObj(obj));
}

function rehydrateBadge(o, src) {
  if (o.type !== 'group') return;
  const children = typeof o.getObjects === 'function' ? o.getObjects() : [];
  const hasShape = children.some(c => c.type === 'circle' || c.type === 'rect');
  const hasText  = children.some(c => c.type === 'text'   || c.type === 'i-text');
  if (!hasShape || !hasText) return;
  o._isBadge  = true;
  o._shapeRef = children.find(c => c.type === 'circle' || c.type === 'rect');
  o._textRef  = children.find(c => c.type === 'text'   || c.type === 'i-text');
  // Explicitly copy all badge props from original JSON (Fabric.js may drop them)
  if (src) {
    ['_badgeDescription','_badgeType','_badgeValue','_badgeBg','_badgeFg','_badgeShape']
      .forEach(k => { if (src[k] != null) o[k] = src[k]; });
  }
  if (o._badgeValue == null && o._textRef) {
    const n = parseInt(o._textRef.text);
    if (!isNaN(n)) o._badgeValue = n;
  }
}

function buildBadgeFormatControls(body, obj) {
  // Re-derive child refs after undo/redo (they're not serialized)
  if (!obj._shapeRef || !obj._textRef) {
    const children = obj.getObjects();
    obj._shapeRef = children.find(c => c.type === 'circle' || c.type === 'rect');
    obj._textRef  = children.find(c => c.type === 'text' || c.type === 'i-text');
  }

  // Position setter
  const contRow = makeRow(t('ofpSequence'));
  const stepperWrap = document.createElement('div');
  stepperWrap.className = 'ofp-stepper';
  const btnDec = document.createElement('button'); btnDec.type = 'button'; btnDec.textContent = '−';
  const posInput = document.createElement('input');
  posInput.type = 'number'; posInput.min = '1'; posInput.value = String(obj._badgeValue ?? 1);
  const btnInc = document.createElement('button'); btnInc.type = 'button'; btnInc.textContent = '+';
  const applyBadgeVal = (newVal) => {
    if (!isNaN(newVal) && newVal >= 1) {
      const applied = setBadgePosition(obj, newVal);
      posInput.value = String(applied);
      saveUndo(); scheduleAnnotationSave();
    } else { posInput.value = String(obj._badgeValue ?? 1); }
  };
  posInput.addEventListener('change', () => applyBadgeVal(parseInt(posInput.value)));
  btnDec.addEventListener('click', () => applyBadgeVal(Math.max(1, parseInt(posInput.value || 1) - 1)));
  btnInc.addEventListener('click', () => applyBadgeVal(parseInt(posInput.value || 1) + 1));
  stepperWrap.appendChild(btnDec); stepperWrap.appendChild(posInput); stepperWrap.appendChild(btnInc);
  contRow.appendChild(stepperWrap);
  body.appendChild(contRow);

  // Fill color
  const colorRow = makeRow(t('ofpFillColor'));
  const colorInner = document.createElement('div'); colorInner.className = 'ofp-color-row';
  const swatch = document.createElement('div'); swatch.className = 'ofp-color-swatch';
  const bg = obj._badgeBg || obj._shapeRef?.fill || '#EF4444';
  swatch.style.background = bg;
  const colorInput = document.createElement('input'); colorInput.type = 'color'; colorInput.value = rgbToHex(bg);
  swatch.appendChild(colorInput);
  const hexInput = document.createElement('input'); hexInput.type = 'text'; hexInput.className = 'ofp-hex-input';
  hexInput.value = colorInput.value.toUpperCase(); hexInput.maxLength = 7;
  const applyBg = (hex) => {
    swatch.style.background = hex; obj._badgeBg = hex;
    const isOutline = obj._shapeRef?.fill === 'transparent';
    if (obj._shapeRef) obj._shapeRef.set(isOutline ? { stroke: hex } : { fill: hex });
    obj.canvas?.renderAll(); scheduleAnnotationSave();
  };
  colorInput.addEventListener('input', e => { hexInput.value = e.target.value.toUpperCase(); applyBg(e.target.value); });
  colorInput.addEventListener('change', () => saveUndo());
  hexInput.addEventListener('change', e => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) { colorInput.value = v; applyBg(v); saveUndo(); }
  });
  colorInner.appendChild(swatch); colorInner.appendChild(hexInput);
  colorRow.appendChild(colorInner); body.appendChild(colorRow);

  // Style: filled / outline
  const styleRow = makeRow(t('ofpStyle'));
  const styleGroup = document.createElement('div'); styleGroup.className = 'ofp-btn-group';
  const isOutline = obj._shapeRef?.fill === 'transparent';
  const btnFilled  = document.createElement('button'); btnFilled.textContent  = t('ofpFilled');
  const btnOutline = document.createElement('button'); btnOutline.textContent = t('ofpOutline');
  if (!isOutline) btnFilled.classList.add('active'); else btnOutline.classList.add('active');
  const applyStyle = (outline) => {
    if (!obj._shapeRef) return;
    const color = obj._badgeBg || '#EF4444';
    if (outline) {
      obj._shapeRef.set({ fill: 'transparent', stroke: color, strokeWidth: 3 });
      if (obj._textRef) obj._textRef.set({ fill: color });
    } else {
      obj._shapeRef.set({ fill: color, stroke: '#ffffff', strokeWidth: 2 });
      if (obj._textRef) obj._textRef.set({ fill: obj._badgeFg || '#ffffff' });
    }
    obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo();
  };
  btnFilled.addEventListener('click',  () => { btnFilled.classList.add('active');  btnOutline.classList.remove('active'); applyStyle(false); });
  btnOutline.addEventListener('click', () => { btnOutline.classList.add('active'); btnFilled.classList.remove('active');  applyStyle(true);  });
  styleGroup.appendChild(btnFilled); styleGroup.appendChild(btnOutline);
  styleRow.appendChild(styleGroup); body.appendChild(styleRow);

  // Text color
  const tcRow = makeRow(t('ofpTextColor'));
  const tcInner = document.createElement('div'); tcInner.className = 'ofp-color-row';
  const tcSwatch = document.createElement('div'); tcSwatch.className = 'ofp-color-swatch';
  const fg = obj._badgeFg || obj._textRef?.fill || '#ffffff';
  tcSwatch.style.background = fg;
  const tcInput = document.createElement('input'); tcInput.type = 'color'; tcInput.value = rgbToHex(fg);
  tcSwatch.appendChild(tcInput);
  const tcHex = document.createElement('input'); tcHex.type = 'text'; tcHex.className = 'ofp-hex-input';
  tcHex.value = tcInput.value.toUpperCase(); tcHex.maxLength = 7;
  const applyFg = (hex) => {
    tcSwatch.style.background = hex; obj._badgeFg = hex;
    if (obj._textRef) obj._textRef.set({ fill: hex });
    obj.canvas?.renderAll(); scheduleAnnotationSave();
  };
  tcInput.addEventListener('input', e => { tcHex.value = e.target.value.toUpperCase(); applyFg(e.target.value); });
  tcInput.addEventListener('change', () => saveUndo());
  tcHex.addEventListener('change', e => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) { tcInput.value = v; applyFg(v); saveUndo(); }
  });
  tcInner.appendChild(tcSwatch); tcInner.appendChild(tcHex);
  tcRow.appendChild(tcInner); body.appendChild(tcRow);

  // Font
  const fontRow = makeRow(t('ofpFont'));
  const fontSel = document.createElement('select');
  fontSel.className = 'ofp-select';
  [['Arial, sans-serif','Arial'], ['Georgia, serif','Georgia'], ['Courier New, monospace','Courier New'], ['Verdana, sans-serif','Verdana'], ['Impact, sans-serif','Impact']].forEach(([val, lbl]) => {
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = lbl;
    if ((obj._textRef?.fontFamily || 'Arial, sans-serif') === val) opt.selected = true;
    fontSel.appendChild(opt);
  });
  fontSel.addEventListener('change', e => {
    if (obj._textRef) obj._textRef.set({ fontFamily: e.target.value });
    obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo();
  });
  fontRow.appendChild(fontSel); body.appendChild(fontRow);

  // Opacity
  const opRow = makeRow(t('opacity'));
  const opRR = document.createElement('div'); opRR.className = 'ofp-range-row';
  const opRange = document.createElement('input'); opRange.type = 'range'; opRange.className = 'ofp-range';
  opRange.min = 10; opRange.max = 100; opRange.value = Math.round((obj.opacity ?? 1) * 100);
  const opVal = makeEditableVal(opRange, '%');
  opRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); opVal.textContent = v + '%';
    obj.set({ opacity: v / 100 }); obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  opRange.addEventListener('change', () => saveUndo());
  opRR.appendChild(opRange); opRR.appendChild(opVal);
  opRow.appendChild(opRR); body.appendChild(opRow);

  // Step Description (Pro-only: used for Guide export)
  const descRow = makeRow(t('badgeStepDescription'));
  if (!isPremium) {
    const proStar = document.createElement('span');
    proStar.textContent = ' ★';
    proStar.style.cssText = 'color:#F59E0B;font-size:9px;vertical-align:middle;cursor:pointer';
    proStar.title = t('toolLockedPro');
    proStar.addEventListener('click', () => showUpgradeModal());
    descRow.querySelector('.ofp-label').appendChild(proStar);
  }
  const descArea = document.createElement('textarea');
  descArea.className = 'badge-desc-textarea' + (isPremium ? '' : ' badge-desc-locked');
  descArea.placeholder = t('badgeStepDescriptionPlaceholder');
  descArea.value = obj._badgeDescription || '';
  descArea.rows = 3;
  if (!isPremium) {
    descArea.readOnly = true;
    descArea.style.cursor = 'pointer';
    descArea.addEventListener('click', () => showUpgradeModal());
  } else {
    descArea.addEventListener('input', e => {
      obj._badgeDescription = e.target.value;
      updateExportButton();
      scheduleAnnotationSave();
    });
    descArea.addEventListener('change', () => saveUndo());
  }
  descRow.appendChild(descArea);
  body.appendChild(descRow);

  buildRotationControls(body, obj);
  appendPresetSaveBtn(body, 'badge', () => capturePresetFromObj(obj));
}

function buildRectFormatControls(body, obj) {
  // Color
  const colorRow = makeRow(t('color'));
  const colorInner = document.createElement('div');
  colorInner.className = 'ofp-color-row';
  const swatch = document.createElement('div');
  swatch.className = 'ofp-color-swatch';
  swatch.style.background = obj.fillColor || obj.stroke || '#EF4444';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = rgbToHex(obj.fillColor || obj.stroke || '#EF4444');
  swatch.appendChild(colorInput);
  const hexInput = document.createElement('input');
  hexInput.type = 'text'; hexInput.className = 'ofp-hex-input';
  hexInput.value = colorInput.value.toUpperCase(); hexInput.maxLength = 7;
  const applyColor = (hex) => {
    swatch.style.background = hex;
    obj.set({ stroke: obj.strokeWidth > 0 ? hex : obj.stroke, fillColor: hex });
    obj.canvas?.renderAll(); scheduleAnnotationSave();
  };
  colorInput.addEventListener('input', (e) => { hexInput.value = e.target.value.toUpperCase(); applyColor(e.target.value); });
  colorInput.addEventListener('change', () => saveUndo());
  hexInput.addEventListener('change', (e) => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) { colorInput.value = v; applyColor(v); saveUndo(); }
  });
  colorInner.appendChild(swatch); colorInner.appendChild(hexInput);
  colorRow.appendChild(colorInner); body.appendChild(colorRow);

  // Stroke width
  const strokeRow = makeRow(t('strokeWidth'));
  const strokeRR = document.createElement('div'); strokeRR.className = 'ofp-range-row';
  const strokeRange = document.createElement('input');
  strokeRange.type = 'range'; strokeRange.className = 'ofp-range';
  strokeRange.min = 0; strokeRange.max = 20; strokeRange.value = obj.strokeWidth || 0;
  const strokeVal = makeEditableVal(strokeRange, '');
  strokeRange.addEventListener('input', (e) => {
    const v = parseInt(e.target.value); strokeVal.textContent = v;
    obj.set({ strokeWidth: v }); obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  strokeRange.addEventListener('change', () => saveUndo());
  strokeRR.appendChild(strokeRange); strokeRR.appendChild(strokeVal);
  strokeRow.appendChild(strokeRR); body.appendChild(strokeRow);

  // Border type
  const btRow = makeRow(t('ofpBorderType'));
  const btGroup = document.createElement('div'); btGroup.className = 'ofp-btn-group';
  const borderTypes = [{ label: '———', dash: null }, { label: '- - -', dash: [8, 5] }, { label: '· · ·', dash: [2, 4] }];
  const currentDash = JSON.stringify(obj.strokeDashArray || null);
  borderTypes.forEach(bt => {
    const btn = document.createElement('button');
    btn.textContent = bt.label;
    if (JSON.stringify(bt.dash) === currentDash) btn.classList.add('active');
    btn.addEventListener('click', () => {
      btGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      obj.set({ strokeDashArray: bt.dash }); obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo();
    });
    btGroup.appendChild(btn);
  });
  btRow.appendChild(btGroup); body.appendChild(btRow);

  // Corner radius
  const rxRow = makeRow(t('ofpCornerRadius'));
  const rxRR = document.createElement('div'); rxRR.className = 'ofp-range-row';
  const rxRange = document.createElement('input');
  rxRange.type = 'range'; rxRange.className = 'ofp-range';
  rxRange.min = 0; rxRange.max = 40; rxRange.value = obj.rx || 0;
  const rxVal = makeEditableVal(rxRange, '');
  rxRange.addEventListener('input', (e) => {
    const v = parseInt(e.target.value); rxVal.textContent = v;
    obj.set({ rx: v, ry: v }); obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  rxRange.addEventListener('change', () => saveUndo());
  rxRR.appendChild(rxRange); rxRR.appendChild(rxVal);
  rxRow.appendChild(rxRR); body.appendChild(rxRow);

  buildRotationControls(body, obj);

  // Blur outside
  const blurRow = document.createElement('label'); blurRow.className = 'ofp-checkbox-row';
  const blurCb = document.createElement('input'); blurCb.type = 'checkbox'; blurCb.checked = !!obj.blurOutside;
  const blurAmountRow = document.createElement('div'); blurAmountRow.className = 'ofp-row';
  blurAmountRow.style.display = obj.blurOutside ? '' : 'none';
  const blurAmountLabel = document.createElement('span'); blurAmountLabel.className = 'ofp-label'; blurAmountLabel.textContent = t('ofpBlurAmount');
  const blurAmountRR = document.createElement('div'); blurAmountRR.className = 'ofp-range-row';
  const blurAmountRange = document.createElement('input'); blurAmountRange.type = 'range'; blurAmountRange.min = 2; blurAmountRange.max = 40; blurAmountRange.step = 1; blurAmountRange.value = obj.blurAmount ?? 14; blurAmountRange.className = 'ofp-range';
  const blurAmountVal = makeEditableVal(blurAmountRange, '');
  blurAmountRange.addEventListener('input', () => {
    blurAmountVal.textContent = blurAmountRange.value;
    obj.blurAmount = Number(blurAmountRange.value);
    rebuildGlobalBlurOverlay();
    scheduleAnnotationSave();
  });
  blurAmountRange.addEventListener('change', () => saveUndo());
  blurAmountRR.appendChild(blurAmountRange); blurAmountRR.appendChild(blurAmountVal);
  blurAmountRow.appendChild(blurAmountLabel); blurAmountRow.appendChild(blurAmountRR);
  blurCb.addEventListener('change', (e) => {
    obj.blurOutside = e.target.checked;
    blurAmountRow.style.display = obj.blurOutside ? '' : 'none';
    if (obj.blurOutside) applyBlurOutside(obj);
    else removeBlurOutside(obj);
    scheduleAnnotationSave(); saveUndo();
  });
  const blurLabel = document.createElement('span'); blurLabel.className = 'ofp-checkbox-label'; blurLabel.textContent = t('ofpBlurOutside');
  blurRow.appendChild(blurCb); blurRow.appendChild(blurLabel);
  body.appendChild(blurRow);
  body.appendChild(blurAmountRow);

  appendPresetSaveBtn(body, 'rect', () => capturePresetFromObj(obj));
}

function buildEllipseFormatControls(body, obj) {
  // Color
  const colorRow = makeRow(t('color'));
  const colorInner = document.createElement('div'); colorInner.className = 'ofp-color-row';
  const swatch = document.createElement('div'); swatch.className = 'ofp-color-swatch';
  swatch.style.background = obj.fillColor || obj.stroke || '#EF4444';
  const colorInput = document.createElement('input'); colorInput.type = 'color';
  colorInput.value = rgbToHex(obj.fillColor || obj.stroke || '#EF4444');
  swatch.appendChild(colorInput);
  const hexInput = document.createElement('input'); hexInput.type = 'text'; hexInput.className = 'ofp-hex-input';
  hexInput.value = colorInput.value.toUpperCase(); hexInput.maxLength = 7;
  const applyColor = (hex) => {
    swatch.style.background = hex;
    obj.set({ stroke: obj.strokeWidth > 0 ? hex : obj.stroke, fillColor: hex });
    obj.canvas?.renderAll(); scheduleAnnotationSave();
  };
  colorInput.addEventListener('input', e => { hexInput.value = e.target.value.toUpperCase(); applyColor(e.target.value); });
  colorInput.addEventListener('change', () => saveUndo());
  hexInput.addEventListener('change', e => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) { colorInput.value = v; applyColor(v); saveUndo(); }
  });
  colorInner.appendChild(swatch); colorInner.appendChild(hexInput);
  colorRow.appendChild(colorInner); body.appendChild(colorRow);

  // Border width
  const strokeRow = makeRow(t('strokeWidth'));
  const strokeRR = document.createElement('div'); strokeRR.className = 'ofp-range-row';
  const strokeRange = document.createElement('input'); strokeRange.type = 'range'; strokeRange.className = 'ofp-range';
  strokeRange.min = 0; strokeRange.max = 20; strokeRange.value = obj.strokeWidth || 0;
  const strokeVal = makeEditableVal(strokeRange, '');
  strokeRange.addEventListener('input', e => {
    const v = parseInt(e.target.value); strokeVal.textContent = v;
    obj.set({ strokeWidth: v }); obj.canvas?.renderAll(); scheduleAnnotationSave();
  });
  strokeRange.addEventListener('change', () => saveUndo());
  strokeRR.appendChild(strokeRange); strokeRR.appendChild(strokeVal);
  strokeRow.appendChild(strokeRR); body.appendChild(strokeRow);

  // Border type
  const btRow = makeRow(t('ofpBorderType'));
  const btGroup = document.createElement('div'); btGroup.className = 'ofp-btn-group';
  const borderTypes = [{ label: '———', dash: null }, { label: '- - -', dash: [8, 5] }, { label: '· · ·', dash: [2, 4] }];
  const currentDash = JSON.stringify(obj.strokeDashArray || null);
  borderTypes.forEach(bt => {
    const btn = document.createElement('button');
    btn.textContent = bt.label;
    if (JSON.stringify(bt.dash) === currentDash) btn.classList.add('active');
    btn.addEventListener('click', () => {
      btGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      obj.set({ strokeDashArray: bt.dash }); obj.canvas?.renderAll(); scheduleAnnotationSave(); saveUndo();
    });
    btGroup.appendChild(btn);
  });
  btRow.appendChild(btGroup); body.appendChild(btRow);

  buildRotationControls(body, obj);

  // Blur outside
  const blurRow = document.createElement('label'); blurRow.className = 'ofp-checkbox-row';
  const blurCb = document.createElement('input'); blurCb.type = 'checkbox'; blurCb.checked = !!obj.blurOutside;
  const blurAmountRow = document.createElement('div'); blurAmountRow.className = 'ofp-row';
  blurAmountRow.style.display = obj.blurOutside ? '' : 'none';
  const blurAmountLabel = document.createElement('span'); blurAmountLabel.className = 'ofp-label'; blurAmountLabel.textContent = t('ofpBlurAmount');
  const blurAmountRR = document.createElement('div'); blurAmountRR.className = 'ofp-range-row';
  const blurAmountRange = document.createElement('input'); blurAmountRange.type = 'range'; blurAmountRange.min = 2; blurAmountRange.max = 40; blurAmountRange.step = 1; blurAmountRange.value = obj.blurAmount ?? 14; blurAmountRange.className = 'ofp-range';
  const blurAmountVal = makeEditableVal(blurAmountRange, '');
  blurAmountRange.addEventListener('input', () => {
    blurAmountVal.textContent = blurAmountRange.value;
    obj.blurAmount = Number(blurAmountRange.value);
    rebuildGlobalBlurOverlay();
    scheduleAnnotationSave();
  });
  blurAmountRange.addEventListener('change', () => saveUndo());
  blurAmountRR.appendChild(blurAmountRange); blurAmountRR.appendChild(blurAmountVal);
  blurAmountRow.appendChild(blurAmountLabel); blurAmountRow.appendChild(blurAmountRR);
  blurCb.addEventListener('change', e => {
    obj.blurOutside = e.target.checked;
    blurAmountRow.style.display = obj.blurOutside ? '' : 'none';
    if (obj.blurOutside) applyBlurOutside(obj);
    else removeBlurOutside(obj);
    scheduleAnnotationSave(); saveUndo();
  });
  const blurLabel = document.createElement('span'); blurLabel.className = 'ofp-checkbox-label'; blurLabel.textContent = t('ofpBlurOutside');
  blurRow.appendChild(blurCb); blurRow.appendChild(blurLabel);
  body.appendChild(blurRow);
  body.appendChild(blurAmountRow);

  appendPresetSaveBtn(body, 'ellipse', () => capturePresetFromObj(obj));
}

// ─── Blur Region (widget) ─────────────────────────────────────────────────────

let blurRegionSyncTimer = null;

function syncBlurRegion(obj) {
  if (!obj._isBlurRegion) return;
  // getBoundingRect gives the true visual box — always positive, handles flips
  const br = obj.getBoundingRect(true, true);
  const x = Math.round(br.left);
  const y = Math.round(br.top);
  const w = Math.max(4, Math.round(br.width));
  const h = Math.max(4, Math.round(br.height));
  obj._blurX = x;
  obj._blurY = y;
  obj._blurW = w;
  obj._blurH = h;
  reapplyBlur(obj, obj._blurStrength ?? 14);
}

function scheduleBlurRegionSync(obj) {
  if (!obj?._isBlurRegion) return;
  clearTimeout(blurRegionSyncTimer);
  blurRegionSyncTimer = setTimeout(() => syncBlurRegion(obj), 30);
}

// ─── Blur Outside ─────────────────────────────────────────────────────────────

let blurUpdateTimer = null;
function rebuildGlobalBlurOverlay() {
  if (!fabricCanvas) return;
  const srcImg = (fabricCanvas.backgroundImage?._element) || getSourceImage();

  // Preserve the currently active object — add/sendToBack can fire selection events
  const prevActive = fabricCanvas.getActiveObject();

  const blurObjs = fabricCanvas.getObjects().filter(o => o.blurOutside && !o._isBlurOverlay);

  fabricCanvas.getObjects().filter(o => o._isBlurOverlay).forEach(o => fabricCanvas.remove(o));
  if (!blurObjs.length || !srcImg) { fabricCanvas.renderAll(); return; }

  const cw = origW || Math.round(fabricCanvas.width  / fabricCanvas.getZoom());
  const ch = origH || Math.round(fabricCanvas.height / fabricCanvas.getZoom());

  const composite = document.createElement('canvas');
  composite.width = cw; composite.height = ch;
  const ctx = composite.getContext('2d');

  const maxBlur = Math.max(...blurObjs.map(o => o.blurAmount ?? 14));
  // Draw on an oversized canvas so the Gaussian kernel has pixels at every edge,
  // then crop back — prevents blur fall-off at canvas boundaries.
  const pad = Math.ceil(maxBlur * 3);
  const bigC = document.createElement('canvas');
  bigC.width = cw + pad * 2; bigC.height = ch + pad * 2;
  const bigCtx = bigC.getContext('2d');
  bigCtx.filter = `blur(${maxBlur}px)`;
  bigCtx.drawImage(srcImg, 0, 0, bigC.width, bigC.height);
  bigCtx.filter = 'none';
  ctx.drawImage(bigC, pad, pad, cw, ch, 0, 0, cw, ch);

  function getInfo(o) {
    const sw = o.strokeWidth || 0;
    const ix = (sw / 2) * (o.scaleX || 1);
    const iy = (sw / 2) * (o.scaleY || 1);
    const w  = Math.max(1, o.getScaledWidth()  - ix * 2);
    const h  = Math.max(1, o.getScaledHeight() - iy * 2);
    return { x: o.left + ix, y: o.top + iy, w, h,
             isEllipse: o.type === 'vignetteEllipse',
             rx: Math.min((o.rx || 0) * (o.scaleX || 1), w / 2, h / 2) };
  }

  function pathSegment(info) {
    if (info.isEllipse)
      ctx.ellipse(info.x + info.w / 2, info.y + info.h / 2, info.w / 2, info.h / 2, 0, 0, Math.PI * 2);
    else
      ctx.roundRect(info.x, info.y, info.w, info.h, info.rx);
  }

  function boundsOverlap(a, b) {
    const ai = getInfo(a), bi = getInfo(b);
    return !(ai.x + ai.w < bi.x || bi.x + bi.w < ai.x || ai.y + ai.h < bi.y || bi.y + bi.h < ai.y);
  }

  for (let i = 0; i < blurObjs.length; i++) {
    const obj = blurObjs[i];
    const si  = getInfo(obj);

    ctx.save();
    ctx.beginPath(); pathSegment(si); ctx.clip();
    ctx.drawImage(srcImg, 0, 0, cw, ch);
    ctx.restore();

    for (let j = i + 1; j < blurObjs.length; j++) {
      if (!boundsOverlap(obj, blurObjs[j])) continue;
      const sj = getInfo(blurObjs[j]);
      ctx.save();
      ctx.beginPath(); pathSegment(si); ctx.clip();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cw, ch); pathSegment(sj);
      ctx.clip('evenodd');
      ctx.filter = `blur(${blurObjs[j].blurAmount ?? 14}px)`;
      ctx.drawImage(srcImg, 0, 0, cw, ch);
      ctx.filter = 'none';
      ctx.restore();
      ctx.restore();
    }
  }

  // Synchronous — wrap the canvas element directly, no async fromURL.
  // Explicit width/height required: Fabric.js can't reliably read dimensions from HTMLCanvasElement.
  const compositeImg = new fabric.Image(composite, {
    left: 0, top: 0, width: cw, height: ch,
    selectable: false, evented: false, hasBorders: false, hasControls: false,
    objectCaching: false, _isBlurOverlay: true,
  });
  fabricCanvas.add(compositeImg);
  fabricCanvas.sendToBack(compositeImg);

  // Restore the previously active object if it was displaced by add/sendToBack events
  if (prevActive && fabricCanvas.contains(prevActive)) {
    fabricCanvas.setActiveObject(prevActive);
  }

  fabricCanvas.renderAll();
}

function applyBlurOutside() { rebuildGlobalBlurOverlay(); }

function removeBlurOutside() { rebuildGlobalBlurOverlay(); }

function scheduleBlurUpdate(obj) {
  if (!obj?.blurOutside) return;
  clearTimeout(blurUpdateTimer);
  blurUpdateTimer = setTimeout(rebuildGlobalBlurOverlay, 30);
}

function buildRotationControls(body, obj) {
  const divider = document.createElement('div');
  divider.style.cssText = 'height:1px;background:rgba(255,255,255,0.07);margin:8px 0 6px';
  body.appendChild(divider);

  const row = makeRow(t('ofpRotation'));

  const rr = document.createElement('div'); rr.className = 'ofp-range-row';
  const range = document.createElement('input'); range.type = 'range'; range.className = 'ofp-range';
  range.min = 0; range.max = 359; range.step = 1;
  range.setAttribute('list', 'rotation-ticks');

  // Datalist for tick marks at 0, 90, 180, 270
  let dl = document.getElementById('rotation-ticks');
  if (!dl) {
    dl = document.createElement('datalist'); dl.id = 'rotation-ticks';
    [0, 90, 180, 270].forEach(v => { const o = document.createElement('option'); o.value = v; dl.appendChild(o); });
    document.body.appendChild(dl);
  }

  const currentAngle = Math.round(((obj.angle % 360) + 360) % 360);
  range.value = currentAngle;

  const valInput = document.createElement('input');
  valInput.type = 'text'; valInput.className = 'ofp-range-val';
  valInput.value = currentAngle + '°';

  const apply = (v) => {
    v = Math.min(359, Math.max(0, Math.round(v)));
    range.value = v; valInput.value = v + '°';
    const center = obj.getCenterPoint();
    obj.set({ angle: v });
    obj.setPositionByOrigin(center, 'center', 'center');
    obj.setCoords(); obj.canvas?.renderAll();
    scheduleAnnotationSave();
  };

  range.addEventListener('input', () => apply(parseInt(range.value)));
  range.addEventListener('change', () => saveUndo());

  valInput.addEventListener('focus', () => { valInput.value = range.value; valInput.select(); });
  valInput.addEventListener('blur', () => {
    let v = parseInt(valInput.value, 10);
    apply(isNaN(v) ? parseInt(range.value) : v);
  });
  valInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); valInput.blur(); }
    if (e.key === 'Escape') { valInput.value = range.value + '°'; valInput.blur(); }
  });

  rr.append(range, valInput);
  row.appendChild(rr);
  body.appendChild(row);
}

function makeEditableVal(rangeEl, suffix = '') {
  const el = document.createElement('input');
  el.type = 'text'; el.className = 'ofp-range-val';
  el.value = rangeEl.value + suffix;
  rangeEl.addEventListener('input', () => { el.value = rangeEl.value + suffix; });
  el.addEventListener('focus', () => { el.value = rangeEl.value; el.select(); });
  el.addEventListener('blur', () => {
    let v = parseFloat(el.value);
    if (isNaN(v)) v = parseFloat(rangeEl.value);
    v = Math.min(parseFloat(rangeEl.max), Math.max(parseFloat(rangeEl.min), Math.round(v)));
    rangeEl.value = v;
    rangeEl.dispatchEvent(new Event('input', { bubbles: true }));
    el.value = v + suffix;
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { el.value = rangeEl.value + suffix; el.blur(); }
  });
  return el;
}

function makeRow(labelText) {
  const row = document.createElement('div');
  row.className = 'ofp-row';
  const lbl = document.createElement('div');
  lbl.className = 'ofp-label';
  lbl.textContent = labelText;
  row.appendChild(lbl);
  return row;
}

function rgbToHex(color) {
  if (!color) return '#EF4444';
  if (color.startsWith('#')) return color;
  const m = color.match(/\d+/g);
  if (!m || m.length < 3) return '#EF4444';
  return '#' + m.slice(0,3).map(n => parseInt(n).toString(16).padStart(2,'0')).join('');
}

function scheduleAnnotationSave() {
  clearTimeout(annotationSaveTimer);
  annotationSaveTimer = setTimeout(saveCurrentAnnotations, 1500);
}

// ─── Confetti ─────────────────────────────────────────────────────────────────

function launchConfetti() {
  const el = document.createElement('canvas');
  el.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999';
  el.width = window.innerWidth;
  el.height = window.innerHeight;
  document.body.appendChild(el);
  const ctx = el.getContext('2d');
  const W = el.width, H = el.height;
  const colors = ['#EF4444','#F59E0B','#22C55E','#3B82F6','#8B5CF6','#EC4899','#FFFFFF','#5B5BD6','#06B6D4','#84CC16','#F97316'];
  const shapes = ['rect','rect','circle','triangle'];

  const pieces = Array.from({ length: 220 }, () => {
    const spread = (Math.random() - 0.5) * 2.2; // radians from straight up
    const speed  = 10 + Math.random() * 22;
    return {
      x: W / 2 + (Math.random() - 0.5) * 160,
      y: H + 10,
      vx: Math.sin(spread) * speed,
      vy: -(Math.cos(spread) * speed),
      w: 9 + Math.random() * 13,
      h: 6 + Math.random() * 9,
      r: 5 + Math.random() * 7,
      color: colors[Math.floor(Math.random() * colors.length)],
      shape: shapes[Math.floor(Math.random() * shapes.length)],
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.3,
      opacity: 1
    };
  });

  let frame = 0;
  const animate = () => {
    ctx.clearRect(0, 0, W, H);
    let live = false;
    for (const p of pieces) {
      p.x  += p.vx;
      p.y  += p.vy;
      p.vy += 0.45;       // gravity
      p.vx *= 0.992;      // air drag
      p.angle += p.spin;
      if (frame > 65) p.opacity = Math.max(0, p.opacity - 0.017);
      if (p.opacity > 0 && p.y < H + 60) live = true;

      ctx.save();
      ctx.globalAlpha = p.opacity;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      if (p.shape === 'circle') {
        ctx.beginPath(); ctx.arc(0, 0, p.r, 0, Math.PI * 2); ctx.fill();
      } else if (p.shape === 'triangle') {
        ctx.beginPath(); ctx.moveTo(0, -p.h); ctx.lineTo(p.w/2, p.h/2); ctx.lineTo(-p.w/2, p.h/2); ctx.closePath(); ctx.fill();
      } else {
        ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
      }
      ctx.restore();
    }
    frame++;
    if (live && frame < 300) requestAnimationFrame(animate);
    else el.remove();
  };
  animate();
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

let allTags = [];
let activeTagDropdown = null;
let selectedHistoryIds = new Set();

function updateSelectionUI() {
  const n = selectedHistoryIds.size;
  $('history-list')?.classList.toggle('selection-mode', n > 0);
  const pngBtn = $('btn-save-png');
  const pdfBtn = $('btn-save-pdf');
  const cancelBtn = $('btn-cancel-selection');
  if (!pngBtn || !pdfBtn) return;
  if (n > 0) {
    pngBtn.style.display = 'none';
    pdfBtn.textContent = `${t('editorDeleteLabel')} (${n})`;
    pdfBtn.classList.replace('btn-ghost', 'btn-accent');
    if (cancelBtn) cancelBtn.style.display = '';
    document.body.classList.add('selection-active');
  } else {
    pngBtn.style.display = '';
    pdfBtn.classList.replace('btn-accent', 'btn-ghost');
    if (cancelBtn) cancelBtn.style.display = 'none';
    document.body.classList.remove('selection-active');
    updateExportButton();
  }
}

function toggleHistorySelection(id, wrapper) {
  if (selectedHistoryIds.has(id)) { selectedHistoryIds.delete(id); wrapper?.classList.remove('selected'); }
  else { selectedHistoryIds.add(id); wrapper?.classList.add('selected'); }
  updateSelectionUI();
}

async function bulkDownloadPng() {
  const ids = [...selectedHistoryIds];
  if (!ids.length) return;
  const { screenshot_history = [] } = await chrome.storage.local.get(['screenshot_history']);
  const histMap = Object.fromEntries(screenshot_history.map(h => [h.id, h]));
  for (const id of ids) {
    const dataUrl = await dbLoad(id);
    if (!dataUrl) continue;
    const item = histMap[id];
    const safeName = (item?.name || '').replace(/[^\w\s\-]/g, '').trim().replace(/\s+/g, '-').slice(0, 50);
    const now = new Date(); const pad = n => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const filename = safeName ? `${safeName}_${date}.png` : `ScreenFellow_${date}_${id.slice(-6)}.png`;
    const blob = await fetch(dataUrl).then(r => r.blob());
    const url = URL.createObjectURL(blob);
    await new Promise(resolve => chrome.downloads.download({ url, filename, saveAs: false }, () => setTimeout(() => { URL.revokeObjectURL(url); resolve(); }, 500)));
  }
  selectedHistoryIds.clear();
  document.querySelectorAll('#history-list .history-item.selected').forEach(el => el.classList.remove('selected'));
  updateSelectionUI();
}

function showBulkDeleteModal() {
  const n = selectedHistoryIds.size;
  const title = $('bulk-delete-modal-title');
  const body = $('bulk-delete-modal-body');
  if (title) title.textContent = t('bulkDeleteConfirmTitle').replace('{n}', n);
  if (body) body.textContent = t('bulkDeleteConfirmBody');
  $('bulk-delete-modal').classList.remove('hidden');
}

async function setScreenshotTag(historyId, tagName) {
  const { screenshot_history = [] } = await chrome.storage.local.get(['screenshot_history']);
  const item = screenshot_history.find(i => i.id === historyId);
  if (!item) return;
  item.tags = tagName ? [tagName] : [];
  await chrome.storage.local.set({ screenshot_history });
  await renderHistory(screenshot_history);
}

async function loadAllTags() {
  const { screenshot_tags = [] } = await chrome.storage.local.get(['screenshot_tags']);
  allTags = screenshot_tags;
}

async function saveAllTags() {
  await chrome.storage.local.set({ screenshot_tags: allTags });
}

async function addGlobalTag(name) {
  name = name.trim();
  if (!name || allTags.includes(name)) return;
  allTags.push(name);
  await saveAllTags();
}

async function deleteGlobalTag(tagName) {
  allTags = allTags.filter(t => t !== tagName);
  await saveAllTags();
  const { screenshot_history = [] } = await chrome.storage.local.get(['screenshot_history']);
  screenshot_history.forEach(i => { if ((i.tags || [])[0] === tagName) i.tags = []; });
  await chrome.storage.local.set({ screenshot_history });
  await renderHistory(screenshot_history);
}

function showTagDropdown(anchorEl, historyId, currentTag) {
  if (activeTagDropdown) { activeTagDropdown.remove(); activeTagDropdown = null; }
  const dropdown = document.createElement('div');
  dropdown.className = 'tag-dropdown';
  const rect = anchorEl.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow < 180) {
    dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    dropdown.style.top = 'auto';
  } else {
    dropdown.style.top = (rect.bottom + 4) + 'px';
  }
  dropdown.style.left = Math.min(rect.left, window.innerWidth - 234) + 'px';

  const rebuildList = () => {
    dropdown.innerHTML = '';
    if (allTags.length) {
      const list = document.createElement('div');
      list.className = 'tag-dropdown-list';
      allTags.forEach(tag => {
        const row = document.createElement('div');
        row.className = 'tag-dropdown-item' + (tag === currentTag ? ' selected' : '');
        const check = document.createElement('span'); check.className = 'tag-dropdown-check';
        check.textContent = tag === currentTag ? '✓' : '';
        const name = document.createElement('span'); name.className = 'tag-dropdown-name';
        name.textContent = tag;
        const del = document.createElement('span'); del.className = 'tag-dropdown-del';
        del.textContent = '×'; del.title = t('deleteTag');
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          await deleteGlobalTag(tag);
          dropdown.remove(); activeTagDropdown = null;
        });
        row.append(check, name, del);
        row.addEventListener('click', async () => {
          const newTag = tag === currentTag ? null : tag;
          await setScreenshotTag(historyId, newTag);
          dropdown.remove(); activeTagDropdown = null;
        });
        list.appendChild(row);
      });
      dropdown.appendChild(list);
      const divider = document.createElement('div'); divider.className = 'tag-dropdown-divider';
      dropdown.appendChild(divider);
    }
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'tag-dropdown-input';
    input.placeholder = t('tagNewPlaceholder'); input.maxLength = 12;
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = input.value.trim();
        if (!val) return;
        await addGlobalTag(val);
        await setScreenshotTag(historyId, val);
        dropdown.remove(); activeTagDropdown = null;
      }
      if (e.key === 'Escape') { dropdown.remove(); activeTagDropdown = null; }
    });
    dropdown.appendChild(input);
    setTimeout(() => input.focus(), 10);
  };

  rebuildList();
  document.body.appendChild(dropdown);
  activeTagDropdown = dropdown;
  const closeOnClick = (e) => {
    if (!dropdown.contains(e.target) && e.target !== anchorEl) {
      dropdown.remove(); activeTagDropdown = null;
      document.removeEventListener('mousedown', closeOnClick);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closeOnClick), 0);
}

// ─── Screenshot History ───────────────────────────────────────────────────────

async function loadHistory() {
  const { screenshot_history = [] } = await chrome.storage.local.get(['screenshot_history']);
  await renderHistory(screenshot_history);

  if (!screenshot_history.length) return;

  if (!originalImageDataUrl) {
    // Library mode (e.g. after license reload) — auto-load the first item properly
    const firstWrapper = document.querySelector('.history-item');
    if (firstWrapper) await switchToHistoryItem(screenshot_history[0], firstWrapper);
  } else if (!currentHistoryId) {
    // Fresh capture — the image is already on canvas, just mark the history entry
    currentHistoryId = screenshot_history[0].id;
    currentScreenshotName = screenshot_history[0].name || '';
    const nameInput = $('screenshot-name-input');
    if (nameInput) nameInput.value = currentScreenshotName;
  }
}

async function renderHistory(items) {
  const limit = await (async () => {
    if (!isPremium) return 10;
    const { history_limit_user } = await chrome.storage.local.get(['history_limit_user']);
    return history_limit_user || 500;
  })();
  const countEl = $('history-count');
  if (countEl) {
    countEl.textContent = `${items.length} / ${limit}`;
    countEl.classList.toggle('near-limit', items.length >= Math.round(limit * 0.8));
  }

  const list = $('history-list');
  list.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = t('editorNoScreenshots');
    list.appendChild(empty);
    return;
  }

  const thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach(async entry => {
      if (!entry.isIntersecting) return;
      const img = entry.target;
      thumbObserver.unobserve(img);
      const thumb = await dbLoadThumbnail(img.dataset.id);
      if (thumb) img.src = thumb;
    });
  }, { rootMargin: '120px' });

  // Apply search filter
  const searchVal = ($('history-search')?.value || '').toLowerCase().trim();
  const visible = searchVal
    ? items.filter(i => (i.name || '').toLowerCase().includes(searchVal) || (i.url || '').toLowerCase().includes(searchVal) || formatTime(i.timestamp).toLowerCase().includes(searchVal) || (i.tags || []).some(tag => tag.toLowerCase().includes(searchVal)))
    : items;

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = searchVal ? t('historyNoResults') : t('editorNoScreenshots');
    list.appendChild(empty);
    return;
  }

  visible.forEach((item) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'history-item' + (item.id === currentHistoryId ? ' active' : '');
    wrapper.dataset.id = item.id;

    const img = document.createElement('img');
    img.className = 'history-thumb';
    img.dataset.id = item.id;
    img.alt = '';
    img.draggable = false;
    thumbObserver.observe(img);

    // Dark hover overlay (makes text readable on bright screenshots)
    const hoverOverlay = document.createElement('div');
    hoverOverlay.className = 'history-hover-overlay';

    // Always-visible timestamp badge (bottom-left, normal state)
    const tsBadge = document.createElement('div');
    tsBadge.className = 'history-ts-badge';
    tsBadge.textContent = formatTime(item.timestamp);

    // Meta area — visible on hover
    const meta = document.createElement('div');
    meta.className = 'history-meta';

    if (item.name) {
      const nameEl = document.createElement('div');
      nameEl.className = 'history-name';
      nameEl.textContent = item.name;
      meta.appendChild(nameEl);
    }

    const ts = document.createElement('div');
    ts.className = 'history-timestamp';
    ts.textContent = formatTime(item.timestamp);
    meta.appendChild(ts);

    {
      const tagsArea = document.createElement('div');
      tagsArea.className = 'history-tags';
      const currentTag = (item.tags || [])[0] || null;

      if (currentTag) {
        const chip = document.createElement('button');
        chip.className = 'history-tag-chip';
        chip.title = t('changeTag');
        chip.appendChild(document.createTextNode(currentTag));
        const x = document.createElement('span');
        x.className = 'tag-chip-x';
        x.textContent = '✕';
        x.addEventListener('click', async (e) => { e.stopPropagation(); await setScreenshotTag(item.id, null); });
        chip.addEventListener('click', (e) => {
          if (e.target === x) return;
          e.stopPropagation();
          if (!isPremium) { showUpgradeModal(); return; }
          showTagDropdown(chip, item.id, currentTag);
        });
        chip.appendChild(x);
        tagsArea.appendChild(chip);
      } else {
        const addTagBtn = document.createElement('button');
        addTagBtn.className = 'history-tag-add-btn';
        addTagBtn.textContent = t('addTag');
        addTagBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!isPremium) { showUpgradeModal(); return; }
          showTagDropdown(addTagBtn, item.id, null);
        });
        tagsArea.appendChild(addTagBtn);
      }
      meta.appendChild(tagsArea);
    }

    // Round delete X (top-right, on hover)
    const deleteX = document.createElement('button');
    deleteX.className = 'history-delete-x';
    deleteX.innerHTML = '✕';
    deleteX.title = t('editorDeleteScreenshot');
    deleteX.addEventListener('click', (e) => {
      e.stopPropagation();
      pendingDeleteId = item.id;
      $('delete-modal').classList.remove('hidden');
    });

    // Fullpage badge (bottom-right, always visible)
    if (item.isFullPage) {
      const badge = document.createElement('div');
      badge.className = 'history-fullpage-badge';
      badge.title = t('fullPageBadge');
      badge.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="1" width="9" height="14" rx="1.5"/><line x1="6" y1="4.5" x2="10" y2="4.5"/><line x1="6" y1="7" x2="10" y2="7"/><line x1="6" y1="9.5" x2="10" y2="9.5"/><line x1="6" y1="12" x2="8.5" y2="12"/></svg>`;
      wrapper.appendChild(badge);
    }

    const checkbox = document.createElement('div');
    checkbox.className = 'history-checkbox';
    checkbox.addEventListener('click', (e) => { e.stopPropagation(); toggleHistorySelection(item.id, wrapper); });

    if (selectedHistoryIds.has(item.id)) wrapper.classList.add('selected');

    wrapper.appendChild(img);
    wrapper.appendChild(hoverOverlay);
    wrapper.appendChild(tsBadge);
    wrapper.appendChild(meta);
    wrapper.appendChild(deleteX);
    wrapper.appendChild(checkbox);
    wrapper.addEventListener('click', () => {
      if (selectedHistoryIds.size > 0) { toggleHistorySelection(item.id, wrapper); return; }
      switchToHistoryItem(item, wrapper);
    });
    list.appendChild(wrapper);
  });

  updateSelectionUI();
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function saveScreenshotName(name) {
  if (!currentHistoryId) return;
  currentScreenshotName = name;
  const { screenshot_history = [] } = await chrome.storage.local.get(['screenshot_history']);
  const idx = screenshot_history.findIndex(i => i.id === currentHistoryId);
  if (idx === -1) return;
  if (name) screenshot_history[idx].name = name;
  else delete screenshot_history[idx].name;
  await chrome.storage.local.set({ screenshot_history });
  await renderHistory(screenshot_history);
}

async function saveCurrentAnnotations() {
  if (!currentHistoryId || !fabricCanvas) return;
  try {
    await dbSaveAnnotations(currentHistoryId, {
      annotations: getObjects(),
      undoStack,
      undoIndex,
      urlFrameSettings: currentUrlFrameSettings,
    });
  } catch (e) {
    console.warn('ScreenFellow: failed to save annotations', e);
  }
}

async function switchToHistoryItem(item, wrapperEl) {
  if (item.id === currentHistoryId) return;

  // Persist current annotations before switching
  clearTimeout(annotationSaveTimer);
  await saveCurrentAnnotations();

  // Exit crop/slice mode if active
  if (cropState) exitCropMode();
  if (sliceState) exitSliceMode();

  // Mark active
  document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
  wrapperEl.classList.add('active');
  currentHistoryId = item.id;
  currentPageUrl = item.url || '';
  currentTimestamp = item.timestamp || Date.now();
  currentScreenshotName = item.name || '';
  const nameInput = $('screenshot-name-input');
  if (nameInput) nameInput.value = currentScreenshotName;

  // Load lossless screenshot from IndexedDB
  const blob = await dbLoad(item.id);
  if (!blob) return;
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(blob);
  const screenshotDataUrl = currentObjectUrl;

  hideLibraryHint();
  originalImageDataUrl = screenshotDataUrl;
  setSourceImage(screenshotDataUrl);

  // Load fresh annotations from IndexedDB
  const savedAnnotData = await dbLoadAnnotations(item.id);
  const savedAnnotations = savedAnnotData?.annotations;
  currentUrlFrameSettings = savedAnnotData?.urlFrameSettings || { style: 'none', dateTime: 'none' };

  await new Promise((resolve) => {
    fabric.Image.fromURL(screenshotDataUrl, (fabricImg) => {
      origW = fabricImg.width;
      origH = fabricImg.height;
      fabricCanvas._origW = origW;
      fabricCanvas._origH = origH;
      setCanvasClip(origW, origH);
      fabricImg.set({ selectable: false, evented: false });
      fabricCanvas.clear();
      fabricCanvas.setBackgroundImage(fabricImg, () => {
        fitToScreen();

        const restoreUndoState = () => {
          if (savedAnnotData?.undoStack?.length) {
            undoStack = savedAnnotData.undoStack;
            undoIndex = savedAnnotData.undoIndex ?? undoStack.length - 1;
          } else {
            undoStack = [];
            undoIndex = -1;
            saveUndo();
          }
          updateUndoRedoButtons();
        };

        if (savedAnnotations && savedAnnotations.length) {
          fabric.util.enlivenObjects(savedAnnotations, (enlivened) => {
            enlivened.forEach((o, i) => { rehydrateBadge(o, savedAnnotations[i]); fabricCanvas.add(o); });
            fabricCanvas.renderAll();
            restoreUndoState();
            updateExportButton();
            resolve();
          });
        } else {
          fabricCanvas.renderAll();
          restoreUndoState();
          updateExportButton();
          resolve();
        }
      });
    });
  });

  // Always land on pan tool after switching images
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  $('tool-pan').classList.add('active');
  currentTool = 'pan';
  setTool('pan');
  // Exit original-view mode if active so annotations are visible on the new image
  if (showingOriginal) {
    showingOriginal = false;
    $('view-toggle').dataset.state = 'annotated';
    fabricCanvas.getObjects().forEach(obj => { obj.visible = true; });
    fabricCanvas.renderAll();
    document.querySelector('.toolbar').classList.remove('disabled');
  }
}

async function deleteHistoryItem(id) {
  const { screenshot_history = [] } = await chrome.storage.local.get(['screenshot_history']);
  const filtered = screenshot_history.filter(item => item.id !== id);
  await Promise.all([dbDelete(id), dbDeleteAnnotations(id), dbDeleteThumbnail(id)]);
  await chrome.storage.local.set({ screenshot_history: filtered });
  selectedHistoryIds.delete(id);
  updateSelectionUI();

  const wasActive = id === currentHistoryId;
  currentHistoryId = null;

  await renderHistory(filtered);

  if (wasActive) {
    if (filtered.length > 0) {
      // Load the first remaining item into the canvas
      const firstWrapper = document.querySelector('#history-list .history-item');
      if (firstWrapper) await switchToHistoryItem(filtered[0], firstWrapper);
    } else {
      // Nothing left — clear canvas and show library hint
      fabricCanvas.clear();
      fabricCanvas.renderAll();
      originalImageDataUrl = null;
      origW = 0;
      origH = 0;
      undoStack = [];
      undoIndex = -1;
      updateUndoRedoButtons();
      showLibraryHint();
    }
  }
}

// ─── Guide Export ─────────────────────────────────────────────────────────────

function hasBadgeDescriptions() {
  return !!fabricCanvas?.getObjects().find(o => o._isBadge && o._badgeDescription?.trim());
}

function updateExportButton() {
  const btn = $('btn-save-pdf');
  if (!btn) return;
  const isGuide = hasBadgeDescriptions();
  btn.textContent = isGuide ? t('exportGuide') : t('saveAsPDF');
  btn.classList.toggle('guide-btn-active', isGuide);
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function numToAlphaExport(n) {
  let result = '';
  while (n > 0) { n--; result = String.fromCharCode(65 + (n % 26)) + result; n = Math.floor(n / 26); }
  return result || 'A';
}

async function exportGuide() {
  fabricCanvas.discardActiveObject();
  fabricCanvas.renderAll();

  // Collect badge data (positions are in image coordinates, convert to percentages)
  const badgeObjs = fabricCanvas.getObjects().filter(o => o._isBadge);
  const badges = [...badgeObjs]
    .sort((a, b) => (a._badgeValue ?? 0) - (b._badgeValue ?? 0))
    .map(o => {
      const isAlpha = o._badgeType === 'alpha';
      return {
        label: isAlpha ? numToAlphaExport(o._badgeValue ?? 1) : String(o._badgeValue ?? ''),
        type: isAlpha ? 'alpha' : 'numeric',
        desc: o._badgeDescription?.trim() || '',
        bg: o._badgeBg || '#EF4444',
        fg: o._badgeFg || '#ffffff',
        xPct: ((o.left + (o.width  * (o.scaleX || 1)) / 2) / origW * 100).toFixed(3),
        yPct: ((o.top  + (o.height * (o.scaleY || 1)) / 2) / origH * 100).toFixed(3),
        diamPct: ((o.width * (o.scaleX || 1)) / origW * 100).toFixed(3),
      };
    });

  // Export at full resolution using same VPT save/restore pattern as canvasToBlob
  const savedVpt = [...fabricCanvas.viewportTransform];
  const savedW = fabricCanvas.getWidth(), savedH = fabricCanvas.getHeight();
  fabricCanvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  fabricCanvas.setWidth(origW);
  fabricCanvas.setHeight(origH);
  fabricCanvas.renderAll();
  const pngDataUrl = fabricCanvas.toDataURL({ format: 'png', multiplier: 1 });
  fabricCanvas.setViewportTransform(savedVpt);
  fabricCanvas.setWidth(savedW);
  fabricCanvas.setHeight(savedH);
  fabricCanvas.renderAll();

  const html = generateGuideHTML(pngDataUrl, badges, t('guideBeaconHint'), t('guideStep'), currentUrlFrameSettings, currentPageUrl, currentTimestamp);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const namePrefix = currentScreenshotName
    ? currentScreenshotName.replace(/[^\w\s\-]/g, '').trim().replace(/\s+/g, '-').slice(0, 50)
    : '';
  const filename = namePrefix ? `${namePrefix}_Guide-${dateStr}.html` : `ScreenFellow-Guide-${dateStr}.html`;
  const dlUrl = URL.createObjectURL(blob);
  chrome.downloads.download({ url: dlUrl, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(dlUrl), 10000);
  });
}

function buildGuideFrameHTML(style, pageUrl, dateStr) {
  const esc = s => escHtml(s || '');
  const url = esc(pageUrl);
  const dt  = esc(dateStr);
  const href = pageUrl ? ` href="${url}"` : '';
  if (style === 'mac') return `
<div class="gf-mac">
  <div class="gf-mac-bar">
    <div class="gf-mac-btns"><span class="gf-btn red"></span><span class="gf-btn yellow"></span><span class="gf-btn green"></span></div>
    <div class="gf-mac-url"><a${href} target="_blank" rel="noopener">${url || '—'}</a></div>
    ${dt ? `<div class="gf-mac-dt">${dt}</div>` : ''}
  </div>`;
  if (style === 'win') return `
<div class="gf-win">
  <div class="gf-win-bar">
    <div class="gf-win-url"><a${href} target="_blank" rel="noopener">${url || '—'}</a></div>
    ${dt ? `<div class="gf-win-dt">${dt}</div>` : ''}
    <div class="gf-win-btns"><span>─</span><span>□</span><span class="gf-win-close">✕</span></div>
  </div>`;
  if (style === 'bar-top') return `
<div class="gf-bar">
  <div class="gf-bar-inner gf-bar-top">
    <span class="gf-bar-icon">🌐</span><a class="gf-bar-url"${href} target="_blank" rel="noopener">${url || '—'}</a>
    ${dt ? `<span class="gf-bar-dt">${dt}</span>` : ''}
  </div>`;
  if (style === 'bar-bottom') return `<div class="gf-bar">`;
  return '';
}

function buildGuideFrameClose(style, pageUrl, dateStr) {
  const esc = s => escHtml(s || '');
  const url = esc(pageUrl);
  const dt  = esc(dateStr);
  const href = pageUrl ? ` href="${url}"` : '';
  if (style === 'bar-bottom') return `
  <div class="gf-bar-inner gf-bar-bottom">
    <span class="gf-bar-icon">🌐</span><a class="gf-bar-url"${href} target="_blank" rel="noopener">${url || '—'}</a>
    ${dt ? `<span class="gf-bar-dt">${dt}</span>` : ''}
  </div></div>`;
  if (style === 'mac' || style === 'win' || style === 'bar-top') return `</div>`;
  return '';
}

function generateGuideHTML(pngDataUrl, badges, beaconHint, stepWord, frameSettings, pageUrl, timestamp) {
  const described  = badges.filter(b => b.desc);
  const firstClickable = badges.findIndex(b => b.desc);
  const hotspots = badges.map((b, i) => {
    const isFirst = i === firstClickable;
    const beacon = isFirst ? `
      <div class="beacon"></div>
      <div class="beacon-label">${escHtml(beaconHint || 'Click a badge ↑')}</div>` : '';
    return `
    <div class="badge-hotspot${b.desc ? ' clickable' : ''}" data-badge="${b.type}_${escHtml(b.label)}" style="left:${b.xPct}%;top:${b.yPct}%;width:${b.diamPct}%;padding-bottom:${b.diamPct}%">
      ${b.desc ? '<div class="badge-ring"></div>' : ''}
      ${b.desc ? `<div class="badge-popup" data-type="${b.type}"><div class="popup-hdr"><strong>${escHtml(stepWord)} ${escHtml(b.label)}</strong><span class="popup-nav"><button class="popup-prev" aria-label="Previous">&#8592;</button><button class="popup-next" aria-label="Next">&#8594;</button></span></div><div class="popup-body">${escHtml(b.desc)}</div></div>` : ''}${beacon}
    </div>`;
  }).join('');

  const numericSteps = described.filter(b => b.type === 'numeric');
  const alphaSteps   = described.filter(b => b.type === 'alpha');
  const hasBoth = numericSteps.length > 0 && alphaSteps.length > 0;

  const renderCol = (items) => items.map(b => `
    <div class="step-item">
      <div class="step-badge" style="background:${b.bg};color:${b.fg}">${escHtml(b.label)}</div>
      <div class="step-text">${escHtml(b.desc)}</div>
      <button class="step-goto" data-badge="${b.type}_${escHtml(b.label)}" title="${t('showInImage')}">↑</button>
    </div>`).join('');

  const singleTitle = numericSteps.length > 0 ? '1 · 2 · 3' : 'A · B · C';
  const stepsHTML = described.length === 0 ? '' : hasBoth
    ? `<div class="steps-row">
        <div class="steps-col"><div class="steps-col-title">1 · 2 · 3</div>${renderCol(numericSteps)}</div>
        <div class="steps-col"><div class="steps-col-title">A · B · C</div>${renderCol(alphaSteps)}</div>
      </div>`
    : `<div class="steps-col single"><div class="steps-col-title">${singleTitle}</div>${renderCol(described)}</div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ScreenFellow Guide</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f1a;color:#e2e2f0;font-family:system-ui,-apple-system,sans-serif;padding:32px 24px;min-height:100vh}
.sw{position:relative;display:inline-block;max-width:100%;border-radius:8px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.sw img{display:block;max-width:100%;height:auto}
/* Hotspot: transparent overlay sized to the canvas badge, positioned by percentage */
.badge-hotspot{position:absolute;transform:translate(-50%,-50%);border-radius:50%}
.badge-hotspot.clickable{cursor:pointer}
/* Visible pulse ring for clickable badges */
.badge-ring{position:absolute;inset:-2px;border-radius:50%;border:2.5px solid rgba(255,255,255,.75);pointer-events:none;animation:badge-pulse 2s ease-out infinite}
.badge-hotspot.clickable:hover .badge-ring{animation:none;border-color:rgba(255,255,255,.95);box-shadow:0 0 12px rgba(255,255,255,.35)}
@keyframes badge-pulse{0%{opacity:.85;transform:scale(1)}70%{opacity:0;transform:scale(1.65)}100%{opacity:0;transform:scale(1.65)}}
/* Semi-transparent dim for non-clickable badges */
.badge-dim{position:absolute;inset:0;border-radius:50%;background:rgba(0,0,0,.55);pointer-events:none}
.badge-popup{position:absolute;left:50%;transform:translateX(-50%);background:rgba(16,16,26,.97);border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:10px 14px;min-width:180px;max-width:260px;font-size:13px;line-height:1.5;color:#e2e2f0;display:none;z-index:10;box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:auto;white-space:normal;bottom:calc(100% + 10px)}
.popup-hdr{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}
.popup-hdr strong{color:#fff;font-weight:700;white-space:nowrap}
.popup-body{color:#e2e2f0;line-height:1.5}
.popup-nav{display:flex;gap:4px;flex-shrink:0}
.popup-nav button{width:22px;height:22px;border-radius:5px;border:1.5px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:rgba(255,255,255,.6);font-size:12px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;transition:background .15s,color .15s,border-color .15s}
.popup-nav button:hover:not(:disabled){background:rgba(255,255,255,.2);color:#fff;border-color:rgba(255,255,255,.5)}
.popup-nav button:disabled{opacity:.25;cursor:default}
.badge-popup::after{content:'';position:absolute;top:100%;left:var(--arrow-x,50%);transform:translateX(-50%);border:6px solid transparent;border-top-color:rgba(255,255,255,.15)}
.badge-popup.flip{bottom:auto;top:calc(100% + 10px)}
.badge-popup.flip::after{top:auto;bottom:100%;border-top-color:transparent;border-bottom-color:rgba(255,255,255,.15)}
.badge-popup.side-left{bottom:auto;top:50%;left:auto;right:calc(100% + 10px);transform:translateY(-50%)}
.badge-popup.side-left::after{top:50%;bottom:auto;left:auto;right:-12px;transform:translateY(-50%);border-top-color:transparent;border-left-color:rgba(255,255,255,.15)}
.badge-popup.side-right{bottom:auto;top:50%;left:calc(100% + 10px);transform:translateY(-50%)}
.badge-popup.side-right::after{top:50%;bottom:auto;left:-12px;right:auto;transform:translateY(-50%);border-top-color:transparent;border-right-color:rgba(255,255,255,.15)}
.badge-hotspot.open .badge-popup{display:block}
.steps-row{margin-top:32px;display:flex;gap:20px;align-items:flex-start}
.steps-col{display:flex;flex-direction:column;gap:8px;flex:1}
.steps-col.single{max-width:680px;margin-top:32px}
.steps-col-title{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.3);padding:0 4px;margin-bottom:2px}
.step-item{display:flex;align-items:flex-start;gap:14px;padding:12px 16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;position:relative}
.step-badge{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0;border:2px solid rgba(255,255,255,.6)}
.step-text{font-size:14px;line-height:1.55;color:#c8c8e0;padding-top:3px;flex:1;padding-right:40px}
.step-goto{position:absolute;top:10px;right:12px;width:28px;height:28px;border-radius:7px;border:1.5px solid rgba(255,255,255,.18);background:rgba(255,255,255,.07);color:rgba(255,255,255,.45);font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;transition:background .15s,color .15s,border-color .15s}
.step-goto:hover{background:rgba(255,255,255,.16);color:#fff;border-color:rgba(255,255,255,.45)}
@keyframes badge-highlight{0%{opacity:.9;transform:scale(1)}50%{opacity:.6;transform:scale(1.8)}100%{opacity:.9;transform:scale(1)}}
.badge-hotspot.highlight .badge-ring{animation:badge-highlight .6s ease-in-out infinite;border-color:rgba(255,255,255,1);box-shadow:0 0 16px rgba(255,255,255,.5)}
.footer{margin-top:40px;font-size:11px;color:rgba(255,255,255,.2);text-align:center}
.footer a{color:inherit;text-decoration:none;transition:color .2s}
.footer a:hover{color:rgba(255,255,255,.85)}
/* URL frame styles */
.gf-mac,.gf-win,.gf-bar{display:inline-block;max-width:100%;vertical-align:top}
.gf-mac .sw,.gf-win .sw,.gf-bar .sw{border-radius:0 0 8px 8px}
.gf-mac-bar{background:#1e1e1e;border-radius:8px 8px 0 0;padding:0 16px;height:44px;display:flex;align-items:center;gap:10px;border:1px solid rgba(255,255,255,.08);border-bottom:none}
.gf-mac-btns{display:flex;gap:8px;flex-shrink:0}
.gf-btn{display:inline-block;width:12px;height:12px;border-radius:50%}
.gf-btn.red{background:#FF5F57}.gf-btn.yellow{background:#FEBC2E}.gf-btn.green{background:#28C840}
.gf-mac-url{flex:1;background:#333;border-radius:5px;padding:4px 10px;font-size:11px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-align:center}
.gf-mac-url a{color:#aaa;text-decoration:none}.gf-mac-url a:hover{color:#fff}
.gf-mac-dt{flex-shrink:0;font-size:10px;color:#666}
.gf-win-bar{background:#202020;border-radius:8px 8px 0 0;padding:0 0 0 8px;height:40px;display:flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.08);border-bottom:none}
.gf-win-url{flex:1;background:#2d2d2d;border:1px solid #444;padding:4px 10px;font-size:11px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.gf-win-url a{color:#bbb;text-decoration:none}.gf-win-url a:hover{color:#fff}
.gf-win-dt{flex-shrink:0;font-size:10px;color:#888}
.gf-win-btns{display:flex;flex-shrink:0;height:100%;align-items:stretch}
.gf-win-btns span{display:flex;align-items:center;justify-content:center;width:42px;font-size:12px;color:#bbb;cursor:default}
.gf-win-close{background:#e81123;color:#fff!important}
.gf-bar-inner{background:#111827;display:flex;align-items:flex-start;gap:8px;padding:8px 12px;min-height:36px;font-size:12px;box-sizing:border-box}
.gf-bar-top{border-radius:8px 8px 0 0;border:1px solid rgba(255,255,255,.08);border-bottom:none}
.gf-bar-bottom{border-radius:0 0 8px 8px;border:1px solid rgba(255,255,255,.08);border-top:none}
.gf-bar-icon{flex-shrink:0;font-size:14px;line-height:20px}
.gf-bar-url{flex:1;color:#9ca3af;text-decoration:none;word-break:break-all;line-height:20px}.gf-bar-url:hover{color:#fff}
.gf-bar-dt{flex-shrink:0;color:#6b7280;font-size:11px;line-height:20px}
@keyframes beacon-ping{0%{transform:translate(-50%,-50%) scale(1);opacity:.9}100%{transform:translate(-50%,-50%) scale(3);opacity:0}}
.beacon{position:absolute;top:50%;left:50%;width:calc(100% + 16px);height:calc(100% + 16px);border-radius:50%;border:2.5px solid rgba(255,255,255,.9);animation:beacon-ping 1.6s ease-out infinite;pointer-events:none}
.beacon-label{position:absolute;white-space:nowrap;background:rgba(16,16,26,.95);border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:5px 10px;font-size:12px;font-weight:600;color:#fff;left:calc(100% + 12px);top:50%;transform:translateY(-50%);pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.4)}
.beacon-label::before{content:'';position:absolute;right:100%;top:50%;transform:translateY(-50%);border:5px solid transparent;border-right-color:rgba(255,255,255,.18)}
</style>
</head>
<body>
${buildGuideFrameHTML(frameSettings?.style || 'none', pageUrl, formatDateTimeStr(frameSettings?.dateTime, timestamp))}
<div class="sw">
  <img src="${pngDataUrl}" alt="Guide Screenshot">
  ${hotspots}
</div>
${buildGuideFrameClose(frameSettings?.style || 'none', pageUrl, formatDateTimeStr(frameSettings?.dateTime, timestamp))}
${stepsHTML}
<div class="footer"><a href="https://www.niftyneighbor.app" target="_blank" rel="noopener">Created with ScreenFellow</a></div>
<script>
(function(){
  function dismissBeacon(){
    document.querySelectorAll('.beacon,.beacon-label').forEach(function(el){el.remove()});
  }
  function openHotspot(h){
    document.querySelectorAll('.badge-hotspot.open').forEach(function(o){o.classList.remove('open')});
    h.classList.add('open');
    positionPopup(h);
    updateNavButtons(h);
  }
  function updateNavButtons(h){
    var popup=h.querySelector('.badge-popup');
    if(!popup)return;
    var type=popup.dataset.type;
    var peers=Array.from(document.querySelectorAll('.badge-hotspot.clickable .badge-popup[data-type="'+type+'"]'))
      .map(function(p){return p.closest('.badge-hotspot')});
    var idx=peers.indexOf(h);
    var prev=popup.querySelector('.popup-prev');
    var next=popup.querySelector('.popup-next');
    if(prev)prev.disabled=idx<=0;
    if(next)next.disabled=idx>=peers.length-1;
  }
  document.querySelectorAll('.badge-hotspot.clickable').forEach(function(h){
    h.addEventListener('click',function(e){
      dismissBeacon();
      var wasOpen=h.classList.contains('open');
      document.querySelectorAll('.badge-hotspot.open').forEach(function(o){o.classList.remove('open')});
      if(!wasOpen){
        openHotspot(h);
      }
      e.stopPropagation();
    });
    var popup=h.querySelector('.badge-popup');
    if(popup){
      popup.addEventListener('click',function(e){e.stopPropagation();});
      var prev=popup.querySelector('.popup-prev');
      var next=popup.querySelector('.popup-next');
      if(prev)prev.addEventListener('click',function(e){
        e.stopPropagation();
        var type=popup.dataset.type;
        var peers=Array.from(document.querySelectorAll('.badge-hotspot.clickable .badge-popup[data-type="'+type+'"]'))
          .map(function(p){return p.closest('.badge-hotspot')});
        var idx=peers.indexOf(h);
        if(idx>0){dismissBeacon();var t=peers[idx-1];t.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(function(){openHotspot(t);},300);}
      });
      if(next)next.addEventListener('click',function(e){
        e.stopPropagation();
        var type=popup.dataset.type;
        var peers=Array.from(document.querySelectorAll('.badge-hotspot.clickable .badge-popup[data-type="'+type+'"]'))
          .map(function(p){return p.closest('.badge-hotspot')});
        var idx=peers.indexOf(h);
        if(idx<peers.length-1){dismissBeacon();var t=peers[idx+1];t.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(function(){openHotspot(t);},300);}
      });
    }
  });
  function positionPopup(h){
    var popup=h.querySelector('.badge-popup');
    if(!popup)return;
    popup.classList.remove('flip','side-left','side-right');
    popup.style.left='50%';popup.style.right='';popup.style.top='';popup.style.bottom='';
    popup.style.transform='translateX(-50%)';popup.style.marginTop='';
    popup.style.setProperty('--arrow-x','50%');
    var sw=h.closest('.sw');
    var sr=sw?sw.getBoundingClientRect():{left:0,top:0,right:window.innerWidth,bottom:window.innerHeight};
    var hr=h.getBoundingClientRect();
    // Step 1: vertical flip (same as before)
    var pr=popup.getBoundingClientRect();
    if(pr.top<sr.top+4){popup.classList.add('flip');pr=popup.getBoundingClientRect();}
    // Step 2: horizontal check
    var dx=0;
    if(pr.left<sr.left+4){dx=sr.left+4-pr.left;}
    else if(pr.right>sr.right-4){dx=sr.right-4-pr.right;}
    if(dx!==0){
      var popW=popup.offsetWidth;
      var popH=popup.offsetHeight;
      if(Math.abs(dx)>popW*0.4){
        // Large overflow → side positioning (overrides flip)
        var sideClass=dx<0?'side-left':'side-right';
        popup.classList.add(sideClass);
        // Vertical clamp for side mode (popup centered at badge vertically)
        var estTop=hr.top+hr.height/2-popH/2;
        var mt=0;
        if(estTop<sr.top+4)mt=sr.top+4-estTop;
        else if(estTop+popH>sr.bottom-4)mt=sr.bottom-4-(estTop+popH);
        if(mt!==0)popup.style.marginTop=mt+'px';
      }else{
        // Small overflow → existing clamp with arrow adjustment
        var cur=parseFloat(popup.style.left)||0;
        popup.style.left=(cur+dx)+'px';
        popup.style.transform='none';
        var arrowX=Math.round(hr.left+hr.width/2-(pr.left+dx));
        popup.style.setProperty('--arrow-x',arrowX+'px');
      }
    }
  }
  document.addEventListener('click',function(){document.querySelectorAll('.badge-hotspot.open').forEach(function(o){o.classList.remove('open')})});
  document.addEventListener('keydown',function(e){
    if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;
    var open=document.querySelector('.badge-hotspot.open');
    if(!open)return;
    e.preventDefault();
    var popup=open.querySelector('.badge-popup');
    if(!popup)return;
    var type=popup.dataset.type;
    var peers=Array.from(document.querySelectorAll('.badge-hotspot.clickable .badge-popup[data-type="'+type+'"]'))
      .map(function(p){return p.closest('.badge-hotspot')});
    var idx=peers.indexOf(open);
    var target=e.key==='ArrowLeft'?peers[idx-1]:peers[idx+1];
    if(!target)return;
    dismissBeacon();
    target.scrollIntoView({behavior:'smooth',block:'center'});
    setTimeout(function(){openHotspot(target);},300);
  });
  document.querySelectorAll('.step-goto').forEach(function(btn){
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      dismissBeacon();
      var key=btn.dataset.badge;
      var hotspot=document.querySelector('.badge-hotspot[data-badge="'+key+'"]');
      if(!hotspot)return;
      hotspot.scrollIntoView({behavior:'smooth',block:'center'});
      hotspot.classList.add('highlight');
      setTimeout(function(){hotspot.classList.remove('highlight')},3000);
    });
  });
})();
<\/script>
</body>
</html>`;
}

// ─── Crop Tool ────────────────────────────────────────────────────────────────

let _cropOverlaySyncHandler = null;

function enterCropMode() {
  // Switch to original view without disabling the full toolbar
  if (!showingOriginal) {
    showingOriginal = true;
    fabricCanvas.getObjects().forEach(obj => { obj.visible = false; });
    $('view-toggle').dataset.state = 'original';
    fabricCanvas.renderAll();
  }
  // Zoom to fit entire document — eliminates the "overlay out of sync" issue on enter
  fitToScreen(56);
  cropState = { x: 0, y: 0, w: origW, h: origH };
  renderCropOverlay();
}

function exitCropMode() {
  cropState = null;
  if (_cropOverlaySyncHandler) { fabricCanvas.off('after:render', _cropOverlaySyncHandler); _cropOverlaySyncHandler = null; }
  const overlay = document.getElementById('crop-overlay');
  if (overlay) overlay.remove();
  const bar = document.getElementById('crop-action-bar');
  if (bar) bar.remove();
  // Restore annotated view
  if (showingOriginal) {
    showingOriginal = false;
    fabricCanvas.getObjects().forEach(obj => { obj.visible = true; });
    $('view-toggle').dataset.state = 'annotated';
    fabricCanvas.renderAll();
  }
}

function renderCropOverlay() {
  const existing = document.getElementById('crop-overlay');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'crop-overlay';
  el.innerHTML = `
    <div class="crop-shade" id="cs-t"></div>
    <div class="crop-shade" id="cs-b"></div>
    <div class="crop-shade" id="cs-l"></div>
    <div class="crop-shade" id="cs-r"></div>
    <div id="crop-rect">
      <div class="crop-handle nw"></div><div class="crop-handle n"></div><div class="crop-handle ne"></div>
      <div class="crop-handle w"></div><div class="crop-handle e"></div>
      <div class="crop-handle sw"></div><div class="crop-handle s"></div><div class="crop-handle se"></div>
    </div>`;
  document.getElementById('canvas-container').appendChild(el);

  // Action bar lives outside the scaled container so it's zoom-independent
  const existingBar = document.getElementById('crop-action-bar');
  if (existingBar) existingBar.remove();
  const bar = document.createElement('div');
  bar.id = 'crop-action-bar';
  bar.innerHTML = `
    <div class="crop-dim-row">
      <label class="crop-dim-label">${t('toolCropWidth')}</label>
      <input id="crop-input-w" class="crop-dim-input" type="number" min="1" max="${origW}" value="${Math.round(cropState.w)}">
      <label class="crop-dim-label">${t('toolCropHeight')}</label>
      <input id="crop-input-h" class="crop-dim-input" type="number" min="1" max="${origH}" value="${Math.round(cropState.h)}">
      <button id="crop-lock-btn" class="crop-lock-btn" aria-label="${t('toolCropLockAria')}" title="${t('toolCropLockAria')}"></button>
    </div>
    <div class="crop-action-btns">
      <button id="crop-cancel-btn">✕ ${t('cancel')}</button>
      <button id="crop-reset-btn">↺ ${t('toolCropReset')}</button>
      <button id="crop-apply-btn">✓ ${t('toolCropApply')}</button>
    </div>`;
  document.querySelector('.canvas-area').appendChild(bar);

  // Lock state
  let cropLocked = false;
  const lockBtn = document.getElementById('crop-lock-btn');
  const inputW  = document.getElementById('crop-input-w');
  const inputH  = document.getElementById('crop-input-h');

  function setCropLock(locked) {
    cropLocked = locked;
    lockBtn.classList.toggle('locked', locked);
    inputW.disabled = locked;
    inputH.disabled = locked;
    bar._cropLocked = locked;
  }

  lockBtn.addEventListener('click', () => setCropLock(!cropLocked));

  function applyDimensionInput() {
    if (cropLocked || !cropState) return;
    let w = Math.max(1, Math.min(parseInt(inputW.value) || 1, origW));
    let h = Math.max(1, Math.min(parseInt(inputH.value) || 1, origH));
    let x = Math.min(cropState.x, origW - w);
    let y = Math.min(cropState.y, origH - h);
    cropState = { x: Math.max(0, x), y: Math.max(0, y), w, h };
    inputW.value = Math.round(w);
    inputH.value = Math.round(h);
    updateCropShades();
  }

  inputW.addEventListener('input', applyDimensionInput);
  inputH.addEventListener('input', applyDimensionInput);

  // Keep overlay in sync with zoom/pan
  _cropOverlaySyncHandler = () => { if (cropState) updateCropShades(); };
  fabricCanvas.on('after:render', _cropOverlaySyncHandler);

  updateCropShades();
  initCropDrag(bar);
  document.getElementById('crop-apply-btn').addEventListener('click', applyCrop);
  document.getElementById('crop-reset-btn').addEventListener('click', () => {
    setCropLock(false);
    fitToScreen(56);
    cropState = { x: 0, y: 0, w: origW, h: origH };
    updateCropShades();
  });
  document.getElementById('crop-cancel-btn').addEventListener('click', () => {
    exitCropMode();
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    $('tool-pan').classList.add('active');
    currentTool = 'pan';
    setTool('pan');
  });
}

function updateCropShades() {
  if (!cropState || !fabricCanvas) return;
  const { x, y, w, h } = cropState;
  const vpt = fabricCanvas.viewportTransform;
  const zoom = vpt[0], tx = vpt[4], ty = vpt[5];
  // Convert image coordinates to screen coordinates within #canvas-container
  const sx = Math.round(tx + x * zoom);
  const sy = Math.round(ty + y * zoom);
  const sw = Math.round(w * zoom);
  const sh = Math.round(h * zoom);
  const set = (id, css) => { const el = document.getElementById(id); if (el) el.style.cssText = css; };
  set('cs-t', `position:absolute;top:0;left:0;right:0;height:${sy}px`);
  set('cs-b', `position:absolute;left:0;right:0;top:${sy + sh}px;bottom:0`);
  set('cs-l', `position:absolute;top:${sy}px;left:0;width:${sx}px;height:${sh}px`);
  set('cs-r', `position:absolute;top:${sy}px;left:${sx + sw}px;right:0;height:${sh}px`);
  const cr = document.getElementById('crop-rect');
  if (cr) { cr.style.left = sx + 'px'; cr.style.top = sy + 'px'; cr.style.width = sw + 'px'; cr.style.height = sh + 'px'; }
  const iw = document.getElementById('crop-input-w');
  const ih = document.getElementById('crop-input-h');
  if (iw && !iw.disabled) iw.value = Math.round(cropState.w);
  if (ih && !ih.disabled) ih.value = Math.round(cropState.h);
}

function initCropDrag(bar) {
  const cropRect = document.getElementById('crop-rect');
  const MIN = 20;
  let dragging = false, dragType = null, startX, startY, startCrop;
  let panning = false, panStartX, panStartY, panStartVpt;

  // Pan canvas by dragging in the dark shade areas
  document.querySelectorAll('#crop-overlay .crop-shade').forEach(shade => {
    shade.style.cursor = 'grab';
    shade.addEventListener('mousedown', (e) => {
      panning = true;
      panStartX = e.clientX; panStartY = e.clientY;
      panStartVpt = [...fabricCanvas.viewportTransform];
      shade.style.cursor = 'grabbing';
      e.preventDefault();
    });
  });

  cropRect.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('crop-handle')) return;
    dragging = true; dragType = 'move';
    startX = e.clientX; startY = e.clientY; startCrop = { ...cropState };
    e.preventDefault();
  });
  cropRect.querySelectorAll('.crop-handle').forEach(h => {
    h.addEventListener('mousedown', (e) => {
      if (bar && bar._cropLocked) return;
      dragging = true;
      dragType = [...h.classList].find(c => c !== 'crop-handle');
      startX = e.clientX; startY = e.clientY; startCrop = { ...cropState };
      e.preventDefault(); e.stopPropagation();
    });
  });
  document.addEventListener('mousemove', (e) => {
    if (panning) {
      const vpt = [...panStartVpt];
      vpt[4] = panStartVpt[4] + (e.clientX - panStartX);
      vpt[5] = panStartVpt[5] + (e.clientY - panStartY);
      fabricCanvas.setViewportTransform(vpt);
      currentZoom = vpt[0];
      updateCropShades();
      return;
    }
    if (!dragging || !cropState) return;
    const cropZoom = fabricCanvas?.viewportTransform?.[0] ?? currentZoom;
    const dx = (e.clientX - startX) / cropZoom, dy = (e.clientY - startY) / cropZoom;
    const s = startCrop;
    const elW = origW, elH = origH;
    const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let { x, y, w, h } = s;
    if (dragType === 'move') {
      x = cl(s.x + dx, 0, elW - w); y = cl(s.y + dy, 0, elH - h);
    } else {
      if (dragType.includes('e')) w = cl(s.w + dx, MIN, elW - s.x);
      if (dragType.includes('s')) h = cl(s.h + dy, MIN, elH - s.y);
      if (dragType.includes('w')) { const nx = cl(s.x + dx, 0, s.x + s.w - MIN); w = s.x + s.w - nx; x = nx; }
      if (dragType.includes('n')) { const ny = cl(s.y + dy, 0, s.y + s.h - MIN); h = s.y + s.h - ny; y = ny; }
    }
    cropState = { x, y, w, h };
    updateCropShades();
  });
  document.addEventListener('mouseup', () => {
    if (panning) {
      document.querySelectorAll('#crop-overlay .crop-shade').forEach(s => s.style.cursor = 'grab');
      panning = false;
    }
    dragging = false;
  });
}

async function applyCrop() {
  if (!cropState || !originalImageDataUrl) return;
  const ix = Math.round(cropState.x);
  const iy = Math.round(cropState.y);
  const iw = Math.round(cropState.w);
  const ih = Math.round(cropState.h);
  if (iw < 1 || ih < 1) return;

  const img = await loadImage(originalImageDataUrl);
  const c = document.createElement('canvas');
  c.width = iw; c.height = ih;
  c.getContext('2d').drawImage(img, ix, iy, iw, ih, 0, 0, iw, ih);
  const croppedUrl = c.toDataURL('image/png');

  const thumbW = 172, thumbH = Math.round(ih * thumbW / iw);
  const tc = document.createElement('canvas');
  tc.width = thumbW; tc.height = thumbH;
  tc.getContext('2d').drawImage(img, ix, iy, iw, ih, 0, 0, thumbW, thumbH);
  const thumbDataUrl = tc.toDataURL('image/jpeg', 0.65);

  const blob = await fetch(croppedUrl).then(r => r.blob());
  const newId = crypto.randomUUID();
  const newEntry = { id: newId, timestamp: Date.now(), url: currentPageUrl };

  await Promise.all([dbSave(newId, blob), dbSaveThumbnail(newId, thumbDataUrl)]);

  const { screenshot_history = [], license_status, history_limit_user } = await chrome.storage.local.get(['screenshot_history', 'license_status', 'history_limit_user']);
  const histMax = license_status === 'active' ? (history_limit_user || 500) : 10;
  screenshot_history.unshift(newEntry);
  if (screenshot_history.length > histMax) {
    const evicted = screenshot_history.splice(histMax);
    const ids = evicted.map(e => e.id);
    await Promise.all([dbDeleteMany(ids), dbDeleteManyAnnotations(ids), dbDeleteManyThumbnails(ids)]);
  }
  await chrome.storage.local.set({ screenshot_history });

  exitCropMode();
  originalImageDataUrl = null;
  currentHistoryId = null;
  $('tool-options-panel').classList.add('hidden');
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  $('tool-pan').classList.add('active');
  currentTool = 'pan';
  setTool('pan');
  await loadHistory();
}

function buildCropPanel() {
  const body = $('tool-options-body');
  body.innerHTML = '';
  const hint = document.createElement('div');
  hint.className = 'tool-options-label';
  hint.style.cssText = 'white-space:normal;line-height:1.4;margin-bottom:10px;color:rgba(255,255,255,0.5)';
  hint.textContent = t('toolCropHint');
  body.appendChild(hint);
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.style.cssText = 'width:100%;margin-top:4px';
  btn.textContent = t('toolCropApply');
  btn.addEventListener('click', applyCrop);
  body.appendChild(btn);
}

// ─── Slice Tool (Bereich entfernen) ──────────────────────────────────────────

let sliceState = null;
let _sliceOverlaySyncHandler = null;

function enterSliceMode() {
  if (!showingOriginal) {
    showingOriginal = true;
    fabricCanvas.getObjects().forEach(obj => { obj.visible = false; });
    $('view-toggle').dataset.state = 'original';
    fabricCanvas.renderAll();
  }
  fitToScreen(56);
  sliceState = { y: Math.round(origH / 3), h: Math.round(origH / 3) };
  renderSliceOverlay();
}

function exitSliceMode() {
  sliceState = null;
  if (_sliceOverlaySyncHandler) { fabricCanvas.off('after:render', _sliceOverlaySyncHandler); _sliceOverlaySyncHandler = null; }
  const overlay = document.getElementById('slice-overlay');
  if (overlay) overlay.remove();
  const bar = document.getElementById('slice-action-bar');
  if (bar) bar.remove();
  if (showingOriginal) {
    showingOriginal = false;
    fabricCanvas.getObjects().forEach(obj => { obj.visible = true; });
    $('view-toggle').dataset.state = 'annotated';
    fabricCanvas.renderAll();
  }
}

function renderSliceOverlay() {
  const existing = document.getElementById('slice-overlay');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'slice-overlay';
  el.innerHTML = `
    <div class="slice-shade" id="ss-t"></div>
    <div class="slice-shade" id="ss-b"></div>
    <div id="slice-band">
      <div class="slice-handle n"></div>
      <div class="slice-handle s"></div>
    </div>`;
  document.getElementById('canvas-container').appendChild(el);

  const existingBar = document.getElementById('slice-action-bar');
  if (existingBar) existingBar.remove();
  const bar = document.createElement('div');
  bar.id = 'slice-action-bar';
  bar.innerHTML = `<button id="slice-cancel-btn">✕ ${t('cancel')}</button><button id="slice-reset-btn">↺ ${t('toolCropReset')}</button><button id="slice-apply-btn">✓ ${t('toolSliceApply')}</button>`;
  document.querySelector('.canvas-area').appendChild(bar);

  _sliceOverlaySyncHandler = () => { if (sliceState) updateSliceShades(); };
  fabricCanvas.on('after:render', _sliceOverlaySyncHandler);

  updateSliceShades();
  initSliceDrag();

  document.getElementById('slice-apply-btn').addEventListener('click', applySlice);
  document.getElementById('slice-reset-btn').addEventListener('click', () => {
    fitToScreen(56);
    sliceState = { y: Math.round(origH / 3), h: Math.round(origH / 3) };
    updateSliceShades();
  });
  document.getElementById('slice-cancel-btn').addEventListener('click', () => {
    exitSliceMode();
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    $('tool-pan').classList.add('active');
    currentTool = 'pan';
    setTool('pan');
  });
}

function updateSliceShades() {
  if (!sliceState || !fabricCanvas) return;
  const { y, h } = sliceState;
  const vpt = fabricCanvas.viewportTransform;
  const zoom = vpt[0], ty = vpt[5];
  const sy = Math.round(ty + y * zoom);
  const sh = Math.round(h * zoom);
  const set = (id, css) => { const el = document.getElementById(id); if (el) el.style.cssText = css; };
  set('ss-t', `position:absolute;top:0;left:0;right:0;height:${sy}px`);
  set('ss-b', `position:absolute;left:0;right:0;top:${sy + sh}px;bottom:0`);
  const sb = document.getElementById('slice-band');
  if (sb) { sb.style.top = sy + 'px'; sb.style.height = sh + 'px'; }
}

function initSliceDrag() {
  const band = document.getElementById('slice-band');
  const MIN = 10;
  let dragging = false, dragType = null, startY, startSlice;
  let panning = false, panStartX, panStartY, panStartVpt;

  document.querySelectorAll('#slice-overlay .slice-shade').forEach(shade => {
    shade.style.cursor = 'grab';
    shade.addEventListener('mousedown', (e) => {
      panning = true;
      panStartX = e.clientX; panStartY = e.clientY;
      panStartVpt = [...fabricCanvas.viewportTransform];
      shade.style.cursor = 'grabbing';
      e.preventDefault();
    });
  });

  band.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('slice-handle')) return;
    dragging = true; dragType = 'move';
    startY = e.clientY; startSlice = { ...sliceState };
    e.preventDefault();
  });
  band.querySelectorAll('.slice-handle').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      dragType = handle.classList.contains('n') ? 'n' : 's';
      startY = e.clientY; startSlice = { ...sliceState };
      e.preventDefault(); e.stopPropagation();
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (panning) {
      const vpt = [...panStartVpt];
      vpt[4] = panStartVpt[4] + (e.clientX - panStartX);
      vpt[5] = panStartVpt[5] + (e.clientY - panStartY);
      fabricCanvas.setViewportTransform(vpt);
      currentZoom = vpt[0];
      updateSliceShades();
      return;
    }
    if (!dragging || !sliceState) return;
    const zoom = fabricCanvas?.viewportTransform?.[0] ?? currentZoom;
    const dy = (e.clientY - startY) / zoom;
    const s = startSlice;
    const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let { y, h } = s;
    if (dragType === 'move') {
      y = cl(s.y + dy, 0, origH - h);
    } else if (dragType === 'n') {
      const ny = cl(s.y + dy, 0, s.y + s.h - MIN);
      h = s.y + s.h - ny; y = ny;
    } else if (dragType === 's') {
      h = cl(s.h + dy, MIN, origH - s.y);
    }
    sliceState = { y, h };
    updateSliceShades();
  });
  document.addEventListener('mouseup', () => {
    if (panning) {
      document.querySelectorAll('#slice-overlay .slice-shade').forEach(s => s.style.cursor = 'grab');
      panning = false;
    }
    dragging = false;
  });
}

async function applySlice() {
  if (!sliceState || !originalImageDataUrl) return;
  const iy = Math.round(sliceState.y);
  const ih = Math.round(sliceState.h);
  if (ih < 1 || iy < 0 || iy + ih > origH) return;

  const topH = iy;
  const botY = iy + ih;
  const botH = origH - botY;
  const newH = topH + botH;
  if (newH < 1) return;

  const img = await loadImage(originalImageDataUrl);
  const c = document.createElement('canvas');
  c.width = origW; c.height = newH;
  const ctx = c.getContext('2d');
  if (topH > 0) ctx.drawImage(img, 0, 0, origW, topH, 0, 0, origW, topH);
  if (botH > 0) ctx.drawImage(img, 0, botY, origW, botH, 0, topH, origW, botH);
  const resultUrl = c.toDataURL('image/png');

  const thumbW = 172, thumbH = Math.round(newH * thumbW / origW);
  const tc = document.createElement('canvas');
  tc.width = thumbW; tc.height = thumbH;
  tc.getContext('2d').drawImage(c, 0, 0, origW, newH, 0, 0, thumbW, thumbH);
  const thumbDataUrl = tc.toDataURL('image/jpeg', 0.65);

  const blob = await fetch(resultUrl).then(r => r.blob());
  const newId = crypto.randomUUID();
  const newEntry = { id: newId, timestamp: Date.now(), url: currentPageUrl, name: currentScreenshotName };

  await Promise.all([dbSave(newId, blob), dbSaveThumbnail(newId, thumbDataUrl)]);

  const { screenshot_history = [], license_status, history_limit_user } = await chrome.storage.local.get(['screenshot_history', 'license_status', 'history_limit_user']);
  const histMax = license_status === 'active' ? (history_limit_user || 500) : 10;
  screenshot_history.unshift(newEntry);
  if (screenshot_history.length > histMax) {
    const evicted = screenshot_history.splice(histMax);
    const ids = evicted.map(e => e.id);
    await Promise.all([dbDeleteMany(ids), dbDeleteManyAnnotations(ids), dbDeleteManyThumbnails(ids)]);
  }
  await chrome.storage.local.set({ screenshot_history });

  exitSliceMode();
  originalImageDataUrl = null;
  currentHistoryId = null;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  $('tool-pan').classList.add('active');
  currentTool = 'pan';
  setTool('pan');
  await loadHistory();
}

// ─── URL Frame Tool ───────────────────────────────────────────────────────────

function buildUrlFramePanel() {
  const body = $('tool-options-body');
  body.innerHTML = '';

  const selStyle = 'width:100%;background:#1a1a2e;color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:4px;padding:4px 6px;font-size:11px;margin-top:4px;cursor:pointer;margin-bottom:10px';

  const lbl1 = document.createElement('div'); lbl1.className = 'tool-options-label'; lbl1.textContent = t('ofpUrlFrameStyle');
  const sel1 = document.createElement('select'); sel1.id = 'urlframe-style-sel'; sel1.style.cssText = selStyle;
  [['none', t('urlFrameNone')], ['mac', t('urlFrameMac')], ['win', t('urlFrameWin')], ['bar-top', t('urlFrameBarTop')], ['bar-bottom', t('urlFrameBarBottom')]].forEach(([v, label]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = label; sel1.appendChild(o);
  });
  sel1.value = currentUrlFrameSettings.style;

  const lbl2 = document.createElement('div'); lbl2.className = 'tool-options-label'; lbl2.textContent = t('ofpDateTime');
  const sel2 = document.createElement('select'); sel2.id = 'urlframe-dt-sel'; sel2.style.cssText = selStyle;
  [['none', t('dateTimeNone')], ['date', t('dateTimeDate')], ['datetime', t('dateTimeDateTime')], ['iso', t('dateTimeISO')]].forEach(([v, label]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = label; sel2.appendChild(o);
  });
  sel2.value = currentUrlFrameSettings.dateTime;

  const urlLbl = document.createElement('div');
  urlLbl.className = 'tool-options-label';
  urlLbl.style.cssText = 'margin-top:6px;margin-bottom:2px;display:flex;align-items:center;justify-content:space-between';
  const urlLblText = document.createElement('span');
  urlLblText.textContent = 'URL';
  const urlActions = document.createElement('div');
  urlActions.style.cssText = 'display:flex;gap:4px';

  if (currentPageUrl) {
    const copyBtn = document.createElement('button');
    copyBtn.title = t('copyUrl') || 'URL kopieren';
    copyBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.35);padding:0 2px;display:flex;align-items:center;transition:color 0.15s';
    copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3"/></svg>`;
    copyBtn.addEventListener('mouseenter', () => copyBtn.style.color = 'rgba(255,255,255,0.8)');
    copyBtn.addEventListener('mouseleave', () => copyBtn.style.color = 'rgba(255,255,255,0.35)');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(currentPageUrl).then(() => {
        copyBtn.style.color = '#5B5BD6';
        setTimeout(() => copyBtn.style.color = 'rgba(255,255,255,0.35)', 1200);
      });
    });

    const openBtn = document.createElement('button');
    openBtn.title = t('openUrl') || 'In neuem Tab öffnen';
    openBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.35);padding:0 2px;display:flex;align-items:center;transition:color 0.15s';
    openBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9"/><path d="M10 1h5v5"/><line x1="15" y1="1" x2="8" y2="8"/></svg>`;
    openBtn.addEventListener('mouseenter', () => openBtn.style.color = 'rgba(255,255,255,0.8)');
    openBtn.addEventListener('mouseleave', () => openBtn.style.color = 'rgba(255,255,255,0.35)');
    openBtn.addEventListener('click', () => chrome.tabs.create({ url: currentPageUrl }));

    urlActions.append(copyBtn, openBtn);
  }

  urlLbl.append(urlLblText, urlActions);

  const urlEl = document.createElement('textarea');
  urlEl.className = 'badge-desc-textarea';
  urlEl.readOnly = true;
  urlEl.rows = 3;
  urlEl.style.cursor = 'default';
  urlEl.value = currentPageUrl || '';
  urlEl.placeholder = t('noUrlCaptured');

  [lbl1, sel1, lbl2, sel2, urlLbl, urlEl].forEach(el => body.appendChild(el));

  const syncDateEnabled = () => {
    const isNone = sel1.value === 'none';
    sel2.disabled = isNone;
    sel2.style.opacity = isNone ? '0.35' : '1';
    lbl2.style.opacity = isNone ? '0.35' : '1';
  };
  syncDateEnabled();

  sel1.addEventListener('change', (e) => { currentUrlFrameSettings.style = e.target.value; saveCurrentAnnotations(); syncDateEnabled(); });
  sel2.addEventListener('change', (e) => { currentUrlFrameSettings.dateTime = e.target.value; saveCurrentAnnotations(); });

  const hint = document.createElement('div');
  hint.style.cssText = 'margin-top:12px;padding:7px 9px;background:rgba(255,255,255,0.05);border-radius:5px;font-size:10px;color:rgba(255,255,255,0.35);line-height:1.5';
  hint.textContent = t('urlFrameExportHint');
  body.appendChild(hint);
}

function loadImage(src) {
  return new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img); img.src = src; });
}

function formatDateTimeStr(mode, timestamp) {
  if (!mode || mode === 'none') return '';
  const d = new Date(timestamp || Date.now());
  const pad = n => String(n).padStart(2, '0');
  if (mode === 'date')     return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  if (mode === 'datetime') return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (mode === 'iso')      return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  return '';
}

function truncateCanvasText(ctx, text, maxWidth) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

function drawMacFrame(ctx, w, h, url, dateStr) {
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, w, h);
  [{ x: 14, c: '#FF5F57' }, { x: 34, c: '#FEBC2E' }, { x: 54, c: '#28C840' }].forEach(b => {
    ctx.beginPath(); ctx.arc(b.x, h / 2, 6, 0, Math.PI * 2); ctx.fillStyle = b.c; ctx.fill();
  });
  // Reserve space for timestamp before sizing the URL bar
  ctx.font = '10px system-ui,sans-serif';
  const dateW = dateStr ? ctx.measureText(dateStr).width + 16 : 0;
  const barX = 90, barH = 22, barY = (h - barH) / 2;
  const barW = Math.max(80, w - barX - 12 - dateW);
  ctx.fillStyle = '#333';
  ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 5); ctx.fill();
  ctx.fillStyle = '#aaa'; ctx.font = '11px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(truncateCanvasText(ctx, url, barW - 16), barX + barW / 2, barY + barH / 2);
  if (dateStr) { ctx.fillStyle = '#666'; ctx.font = '10px system-ui,sans-serif'; ctx.textAlign = 'right'; ctx.fillText(dateStr, w - 8, h / 2); }
}

function drawWinFrame(ctx, w, h, url, dateStr) {
  const BTN_W = 46;
  const midy = Math.round(h / 2);

  // Background — dark Windows chrome
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, w, h);

  // Close button: very subtle dark-red tint, not glowing
  ctx.fillStyle = '#2a1010';
  ctx.fillRect(w - BTN_W, 0, BTN_W, h);

  // ── Window control icons ──────────────────────────────────────
  // All icons: lineWidth=1.5, round caps, consistent weight
  const ic = {
    min: Math.round(w - BTN_W * 2.5),  // minimize center x
    max: Math.round(w - BTN_W * 1.5),  // maximize center x
    cls: Math.round(w - BTN_W * 0.5),  // close center x
  };
  const S = 4; // icon half-size

  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';

  // Minimize: horizontal dash
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.moveTo(ic.min - S, midy); ctx.lineTo(ic.min + S, midy);
  ctx.stroke();

  // Maximize: square outline
  ctx.beginPath();
  ctx.rect(ic.max - S, midy - S, S * 2, S * 2);
  ctx.stroke();

  // Close X: both diagonals in one path to avoid center artifact
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.beginPath();
  ctx.moveTo(ic.cls - S, midy - S); ctx.lineTo(ic.cls + S, midy + S);
  ctx.moveTo(ic.cls + S, midy - S); ctx.lineTo(ic.cls - S, midy + S);
  ctx.stroke();

  ctx.restore();

  // ── Back arrow ────────────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(22, midy - 4); ctx.lineTo(16, midy); ctx.lineTo(22, midy + 4);
  ctx.stroke();
  ctx.restore();

  // ── URL bar ───────────────────────────────────────────────────
  ctx.font = '10px system-ui,sans-serif';
  const dateW = dateStr ? ctx.measureText(dateStr).width + 20 : 0;
  const barL = 30, barR = w - BTN_W * 3 - dateW - 8;
  const barW = Math.max(60, barR - barL);

  ctx.fillStyle = '#2d2d2d';
  ctx.beginPath(); ctx.roundRect(barL, 6, barW, h - 12, 3); ctx.fill();

  // Padlock: arc (shackle) + filled rect (body)
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1.2; ctx.lineCap = 'round';
  const lx = barL + 11, ly = midy;
  ctx.beginPath(); ctx.arc(lx, ly - 2, 2.5, Math.PI, 0); ctx.stroke();
  ctx.fillRect(lx - 3, ly - 0.5, 6, 5);
  ctx.restore();

  // URL text
  ctx.save();
  ctx.font = '11px system-ui,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#c0c0c0';
  ctx.fillText(truncateCanvasText(ctx, url, barW - 24), barL + 21, midy);
  ctx.restore();

  // Date
  if (dateStr) {
    ctx.save();
    ctx.font = '10px system-ui,sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#585858';
    ctx.fillText(dateStr, w - BTN_W * 3 - 8, midy);
    ctx.restore();
  }
}

// Wraps a URL string into lines that each fit within maxW — no ellipsis.
function wrapUrlText(ctx, url, maxW) {
  if (!url) return [''];
  if (ctx.measureText(url).width <= maxW) return [url];
  const lines = [];
  let start = 0;
  while (start < url.length) {
    let lo = start + 1, hi = url.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(url.slice(start, mid)).width <= maxW) lo = mid; else hi = mid - 1;
    }
    lines.push(url.slice(start, lo));
    start = lo;
  }
  return lines;
}

// Draws URL bar for documentation style (bar-top / bar-bottom).
// Full URL — wraps to multiple lines, grows height as needed.
// Returns the actual height drawn so the caller can size the canvas correctly.
function drawUrlBar(ctx, w, url, dateStr) {
  const LINE_H = 18, PAD_V = 9, PAD_L = 30, PAD_R = 12;
  const iconR = 7, iconX = 14;

  ctx.font = '12px system-ui,sans-serif';
  const dateW = dateStr ? ctx.measureText(dateStr).width + 16 : 0;
  const textMaxW = w - PAD_L - PAD_R - dateW;
  const lines = wrapUrlText(ctx, url || '', Math.max(40, textMaxW));
  const h = Math.max(36, lines.length * LINE_H + PAD_V * 2);

  // Background
  ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, w, h);

  // Globe icon (centered vertically on first line)
  const iconY = PAD_V + LINE_H / 2;
  ctx.beginPath(); ctx.arc(iconX, iconY, iconR, 0, Math.PI * 2);
  ctx.strokeStyle = '#4b5563'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(iconX, iconY - iconR); ctx.lineTo(iconX, iconY + iconR);
  ctx.moveTo(iconX - iconR, iconY); ctx.lineTo(iconX + iconR, iconY);
  ctx.stroke();

  // URL lines
  ctx.fillStyle = '#9ca3af'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    ctx.fillText(line, PAD_L, PAD_V + i * LINE_H + LINE_H / 2);
  });

  // Date aligned to right of first line
  if (dateStr) {
    ctx.fillStyle = '#6b7280'; ctx.textAlign = 'right';
    ctx.fillText(dateStr, w - PAD_R, iconY);
  }

  return h;
}

// Measures the height drawUrlBar would use, without needing an existing ctx.
function measureUrlBarHeight(imgW, url, dateStr) {
  const tmp = document.createElement('canvas').getContext('2d');
  tmp.font = '12px system-ui,sans-serif';
  const dateW = dateStr ? tmp.measureText(dateStr).width + 16 : 0;
  const textMaxW = Math.max(40, imgW - 30 - 12 - dateW);
  const lines = wrapUrlText(tmp, url || '', textMaxW);
  return Math.max(36, lines.length * 18 + 18);
}

async function applyUrlFrameToDataUrl(dataUrl, frameSettings, pageUrl, timestamp) {
  if (!frameSettings || frameSettings.style === 'none') return dataUrl;
  const img = await loadImage(dataUrl);
  const imgW = img.width, imgH = img.height;
  const dateStr = formatDateTimeStr(frameSettings.dateTime, timestamp);
  const style = frameSettings.style;

  // Mac/Win: fixed height (browser-chrome look). Bar styles: dynamic (full URL).
  const frameH = style === 'mac' ? 44 : style === 'win' ? 40
    : measureUrlBarHeight(imgW, pageUrl, dateStr);

  const c = document.createElement('canvas');
  c.width = imgW;
  c.height = imgH + frameH;
  const ctx = c.getContext('2d');

  if (style === 'mac')             { drawMacFrame(ctx, imgW, frameH, pageUrl, dateStr); ctx.drawImage(img, 0, frameH); }
  else if (style === 'win')        { drawWinFrame(ctx, imgW, frameH, pageUrl, dateStr); ctx.drawImage(img, 0, frameH); }
  else if (style === 'bar-top')    { drawUrlBar(ctx, imgW, pageUrl, dateStr); ctx.drawImage(img, 0, frameH); }
  else if (style === 'bar-bottom') { ctx.drawImage(img, 0, 0); ctx.save(); ctx.translate(0, imgH); drawUrlBar(ctx, imgW, pageUrl, dateStr); ctx.restore(); }

  return c.toDataURL('image/png');
}

// ─── UI Events ────────────────────────────────────────────────────────────────

function bindUIEvents() {
  $('btn-license-badge').addEventListener('click', () => {
    if (!isPremium) showUpgradeModal();
  });

  // Screenshot name input
  const nameInput = $('screenshot-name-input');
  if (nameInput) {
    const commitName = () => saveScreenshotName(nameInput.value.trim());
    nameInput.addEventListener('blur', commitName);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
      if (e.key === 'Escape') { nameInput.value = currentScreenshotName; nameInput.blur(); }
    });
    nameInput.addEventListener('click', (e) => e.stopPropagation());
  }

  // History search
  const searchInput = $('history-search');
  const searchClearBtn = $('btn-search-clear');
  if (searchInput) {
    searchInput.addEventListener('input', async () => {
      if (searchClearBtn) searchClearBtn.style.display = searchInput.value ? '' : 'none';
      const { screenshot_history = [] } = await chrome.storage.local.get(['screenshot_history']);
      await renderHistory(screenshot_history);
    });
  }
  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', async () => {
      searchInput.value = '';
      searchClearBtn.style.display = 'none';
      searchInput.focus();
      const { screenshot_history = [] } = await chrome.storage.local.get(['screenshot_history']);
      await renderHistory(screenshot_history);
    });
  }

  // Tool buttons
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;

      if (!isPremium && PRO_TOOLS.includes(tool)) {
        showUpgradeModal();
        return;
      }

      // Exit crop/slice mode when switching away
      if (currentTool === 'crop' && tool !== 'crop') exitCropMode();
      if (currentTool === 'slice' && tool !== 'slice') exitSliceMode();

      const wasActive = btn.classList.contains('active');
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = tool;

      // crop, slice and urlframe don't map to canvas drawing tools — switch canvas to pan
      if (tool === 'crop' || tool === 'slice' || tool === 'urlframe') setTool('pan');
      else setTool(tool);

      const emojiPicker = $('emoji-picker');
      const textPanel   = $('preset-panel');
      const toolPanel   = $('tool-options-panel');

      const PANEL_TOOLS = ['text', 'rect', 'ellipse', 'badge', 'highlight', 'freehand', 'arrow', 'image', 'crop', 'slice', 'urlframe'];

      if (tool === 'emoji') {
        const wasHidden = emojiPicker.classList.contains('hidden');
        emojiPicker.classList.toggle('hidden');
        if (wasHidden) {
          const br = btn.getBoundingClientRect();
          emojiPicker.style.top = Math.max(50, br.top) + 'px';
        }
        textPanel.classList.add('hidden');
        toolPanel.classList.add('hidden');
      } else if (PANEL_TOOLS.includes(tool)) {
        emojiPicker.classList.add('hidden');
        textPanel.classList.add('hidden');
        if (tool === 'text')           buildTextPresetPanel();
        else if (tool === 'rect')      buildRectPresetPanel();
        else if (tool === 'ellipse')   buildEllipsePresetPanel();
        else if (tool === 'badge')     buildBadgePresetPanel();
        else if (tool === 'highlight') buildHighlightPresetPanel();
        else if (tool === 'freehand')  buildFreehandPresetPanel();
        else if (tool === 'arrow')     buildArrowPresetPanel();
        else if (tool === 'image')     buildImagePresetPanel();
        else if (tool === 'crop')     { enterCropMode(); toolPanel.classList.add('hidden'); }
        else if (tool === 'slice')    { enterSliceMode(); toolPanel.classList.add('hidden'); }
        else if (tool === 'urlframe') buildUrlFramePanel();
        if (tool !== 'crop' && tool !== 'slice') {
          const br = btn.getBoundingClientRect();
          const rawTop = br.top;
          const panelMaxTop = window.innerHeight - 280;
          toolPanel.style.top = Math.min(Math.max(60, rawTop), panelMaxTop) + 'px';
          if (wasActive) toolPanel.classList.toggle('hidden');
          else toolPanel.classList.remove('hidden');
        }
      } else {
        emojiPicker.classList.add('hidden');
        textPanel.classList.add('hidden');
        toolPanel.classList.add('hidden');
      }
    });
  });

  // Emoji picker
  initEmojiPicker();

  $('btn-view-original').addEventListener('click', () => { if (!showingOriginal) toggleView(); });
  $('btn-view-edited').addEventListener('click',   () => { if (showingOriginal)  toggleView(); });
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);

  // Zoom controls
  $('zoom-select').addEventListener('change', (e) => applyZoom(parseInt(e.target.value) / 100));
  $('btn-zoom-100').addEventListener('click', () => applyZoom(1));
  $('btn-zoom-top').addEventListener('click', zoomToTop);
  $('btn-zoom-fit').addEventListener('click', () => fitToScreen());

  // Wheel zoom: zoom-to-cursor using Fabric's zoomToPoint
  const area = document.querySelector('.canvas-area');
  area.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomIn = e.deltaY < 0;
    const newZoom = computeWheelZoom(fabricCanvas.viewportTransform[0], zoomIn);
    const areaRect = area.getBoundingClientRect();
    const mouseX = e.clientX - areaRect.left;
    const mouseY = e.clientY - areaRect.top;
    fabricCanvas.zoomToPoint(new fabric.Point(mouseX, mouseY), newZoom);
    currentZoom = newZoom;
    syncZoomSelect();
  }, { passive: false });

  // Pan by dragging on the canvas background (outside any object)
  let _bgPanStart = null;
  let _savedToolCursor = 'default';
  fabricCanvas.on('mouse:down', (e) => {
    if (fabricCanvas.isDrawingMode) return;
    if (cropState !== null || sliceState !== null) return;
    if (e.target) return;
    // Only pan when clicking outside the screenshot bounds
    const ptr = fabricCanvas.getPointer(e.e);
    if (ptr.x >= 0 && ptr.x <= origW && ptr.y >= 0 && ptr.y <= origH) return;
    _bgPanStart = { x: e.e.clientX, y: e.e.clientY, vpt: [...fabricCanvas.viewportTransform] };
    fabricCanvas.defaultCursor = 'grabbing';
    fabricCanvas.selection = false;
  });
  document.addEventListener('mousemove', (e) => {
    if (!_bgPanStart) return;
    const vpt = [..._bgPanStart.vpt];
    vpt[4] += e.clientX - _bgPanStart.x;
    vpt[5] += e.clientY - _bgPanStart.y;
    fabricCanvas.setViewportTransform(vpt);
  });
  document.addEventListener('mouseup', () => {
    if (!_bgPanStart) return;
    _bgPanStart = null;
    fabricCanvas.defaultCursor = 'grab';
    fabricCanvas.selection = true;
  });
  fabricCanvas.on('mouse:move', (e) => {
    if (_bgPanStart) return;
    if (fabricCanvas.isDrawingMode || cropState !== null || sliceState !== null) return;
    const ptr = fabricCanvas.getPointer(e.e);
    const outside = ptr.x < 0 || ptr.x > origW || ptr.y < 0 || ptr.y > origH;
    if (outside && !e.target) {
      _savedToolCursor = fabricCanvas.defaultCursor === 'grab' ? _savedToolCursor : fabricCanvas.defaultCursor;
      fabricCanvas.defaultCursor = 'grab';
    } else if (!outside || e.target) {
      if (fabricCanvas.defaultCursor === 'grab') fabricCanvas.defaultCursor = _savedToolCursor;
    }
  });

  // Resize canvas when canvas-area changes size (window resize, panel toggle, etc.)
  new ResizeObserver(() => {
    if (!fabricCanvas) return;
    const w = area.clientWidth;
    const h = area.clientHeight;
    fabricCanvas.setWidth(w);
    fabricCanvas.setHeight(h);
    fabricCanvas.renderAll();
  }).observe(area);

  // Export
  $('btn-save-png').addEventListener('click', async () => {
    if (selectedHistoryIds.size > 0) { await bulkDownloadPng(); return; }
    fabricCanvas.discardActiveObject();
    fabricCanvas.renderAll();
    setExportName(currentScreenshotName);
    if (currentUrlFrameSettings.style !== 'none') {
      const annotatedUrl = await getAnnotatedDataUrl(fabricCanvas);
      const framedUrl = await applyUrlFrameToDataUrl(annotatedUrl, currentUrlFrameSettings, currentPageUrl, currentTimestamp);
      downloadDataUrl(framedUrl, 'png');
    } else {
      await exportPNG(fabricCanvas);
    }
    if (confettiEnabled) launchConfetti();
  });
  $('btn-save-pdf').addEventListener('click', async () => {
    if (selectedHistoryIds.size > 0) { showBulkDeleteModal(); return; }
    if (!isPremium) { showUpgradeModal(); return; }
    fabricCanvas.discardActiveObject();
    fabricCanvas.renderAll();
    setExportName(currentScreenshotName);
    if (hasBadgeDescriptions()) {
      await exportGuide();
    } else if (currentUrlFrameSettings.style !== 'none') {
      const annotatedUrl = await getAnnotatedDataUrl(fabricCanvas);
      const framedUrl = await applyUrlFrameToDataUrl(annotatedUrl, currentUrlFrameSettings, currentPageUrl, currentTimestamp);
      await exportPDFFromDataUrl(framedUrl, currentPageUrl, currentUrlFrameSettings.style);
    } else {
      await exportPDF(fabricCanvas);
    }
    if (confettiEnabled) launchConfetti();
  });

  // Upgrade modal
  $('btn-upgrade-buy').addEventListener('click', () => { chrome.tabs.create({ url: CHECKOUT_URL }); closeUpgradeModal(); });
  $('btn-upgrade-license').addEventListener('click', () => { closeUpgradeModal(); showLicenseModal(); });
  $('btn-upgrade-close').addEventListener('click', closeUpgradeModal);

  // License modal
  $('btn-activate').addEventListener('click', activateLicense);
  $('btn-buy-license').addEventListener('click', () => { chrome.tabs.create({ url: CHECKOUT_URL }); });
  $('btn-cancel-license').addEventListener('click', closeLicenseModal);

  // Image file input
  $('image-file-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      placeImage(dataUrl);
      saveUndo();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  // Preset delete modal
  $('btn-preset-del-confirm').addEventListener('click', () => {
    $('preset-delete-modal').classList.add('hidden');
    if (_presetDelCallback) { _presetDelCallback(); _presetDelCallback = null; }
  });
  $('btn-preset-del-cancel').addEventListener('click', () => {
    $('preset-delete-modal').classList.add('hidden');
    _presetDelCallback = null;
  });

  // Delete modal
  $('btn-confirm-delete').addEventListener('click', async () => {
    if (pendingDeleteId) { await deleteHistoryItem(pendingDeleteId); pendingDeleteId = null; }
    $('delete-modal').classList.add('hidden');
  });
  $('btn-cancel-delete').addEventListener('click', () => {
    pendingDeleteId = null;
    $('delete-modal').classList.add('hidden');
  });

  // Bulk delete modal
  $('btn-bulk-delete-confirm').addEventListener('click', async () => {
    $('bulk-delete-modal').classList.add('hidden');
    const ids = [...selectedHistoryIds];
    if (!ids.length) return;
    const { screenshot_history = [] } = await chrome.storage.local.get(['screenshot_history']);
    const filtered = screenshot_history.filter(i => !ids.includes(i.id));
    await Promise.all([dbDeleteMany(ids), dbDeleteManyAnnotations(ids), dbDeleteManyThumbnails(ids)]);
    await chrome.storage.local.set({ screenshot_history: filtered });
    if (ids.includes(currentHistoryId)) {
      currentHistoryId = null;
      fabricCanvas.clear(); fabricCanvas.renderAll();
      originalImageDataUrl = null; origW = 0; origH = 0;
      undoStack = []; undoIndex = -1; updateUndoRedoButtons();
    }
    selectedHistoryIds.clear();
    updateSelectionUI();
    await renderHistory(filtered);
    if (!filtered.length) showLibraryHint();
  });
  $('btn-bulk-delete-cancel').addEventListener('click', () => {
    $('bulk-delete-modal').classList.add('hidden');
  });

  // Cancel selection
  $('btn-cancel-selection').addEventListener('click', () => {
    selectedHistoryIds.clear();
    document.querySelectorAll('#history-list .history-item.selected').forEach(el => el.classList.remove('selected'));
    updateSelectionUI();
  });

  // History settings gear
  $('btn-history-settings').addEventListener('click', () => {
    if (!isPremium) { showUpgradeModal(); return; }
    $('history-settings-panel').classList.toggle('hidden');
  });

  let pendingHistoryLimit = null;
  $('history-limit-slider').addEventListener('input', (e) => {
    $('history-limit-value').textContent = e.target.value;
  });
  $('history-limit-slider').addEventListener('change', async (e) => {
    const newLimit = parseInt(e.target.value, 10);
    const { screenshot_history = [] } = await chrome.storage.local.get(['screenshot_history']);
    const excess = screenshot_history.length - newLimit;
    if (excess > 0) {
      pendingHistoryLimit = newLimit;
      $('history-limit-modal-body').textContent =
        t('historyLimitDeleteWarning').replace('{n}', excess);
      $('history-limit-modal').classList.remove('hidden');
    } else {
      await applyHistoryLimit(newLimit);
    }
  });
  $('btn-history-limit-confirm').addEventListener('click', async () => {
    $('history-limit-modal').classList.add('hidden');
    if (pendingHistoryLimit !== null) {
      await applyHistoryLimit(pendingHistoryLimit);
      pendingHistoryLimit = null;
    }
  });
  $('btn-history-limit-cancel').addEventListener('click', async () => {
    $('history-limit-modal').classList.add('hidden');
    pendingHistoryLimit = null;
    // Reset slider to saved value
    const { history_limit_user } = await chrome.storage.local.get(['history_limit_user']);
    const saved = history_limit_user || 500;
    $('history-limit-slider').value = saved;
    $('history-limit-value').textContent = saved;
  });

  // Clear all history
  $('btn-clear-all-history').addEventListener('click', () => {
    $('clear-history-modal').classList.remove('hidden');
  });
  $('btn-clear-history-cancel').addEventListener('click', () => {
    $('clear-history-modal').classList.add('hidden');
  });
  $('btn-clear-history-confirm').addEventListener('click', async () => {
    $('clear-history-modal').classList.add('hidden');
    const { screenshot_history = [] } = await chrome.storage.local.get(['screenshot_history']);
    const ids = screenshot_history.map(e => e.id);
    if (ids.length) {
      await Promise.all([dbDeleteMany(ids), dbDeleteManyAnnotations(ids), dbDeleteManyThumbnails(ids)]);
      await chrome.storage.local.set({ screenshot_history: [] });
    }
    originalImageDataUrl = null;
    currentHistoryId = null;
    currentScreenshotName = '';
    selectedHistoryIds.clear();
    await renderHistory([]);
    fabricCanvas.clear();
    fabricCanvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    fabricCanvas.renderAll();
    origW = 0; origH = 0;
    currentZoom = 1;
    $('canvas-container').style.visibility = 'hidden';
    $('library-hint').classList.remove('hidden');
    updateExportButton();
  });

  // Delete key removes selected object
  fabricCanvas.on('mouse:move', (e) => {
    if (fabricCanvas._currentTransform?.action === 'rotate') {
      const snap = !!e.e?.shiftKey;
      fabricCanvas.snapAngle = snap ? 15 : 0;
      fabricCanvas.snapThreshold = snap ? 10 : 0;
    }
  });
  fabricCanvas.on('mouse:up', () => {
    fabricCanvas.snapAngle = 0;
    fabricCanvas.snapThreshold = 0;
  });

  document.addEventListener('keydown', (e) => {
    const ae = document.activeElement;
    // Allow Delete from range/checkbox/color inputs (format panel controls) but block text inputs
    const isTextInput = ae.tagName === 'TEXTAREA' ||
      (ae.tagName === 'INPUT' && !['range','checkbox','radio','color','button','submit','reset'].includes(ae.type));
    if ((e.key === 'Delete' || e.key === 'Backspace') && fabricCanvas && !isTextInput) {
      const active = fabricCanvas.getActiveObject();
      if (active) {
        if (active.type === 'activeSelection') {
          active.getObjects().forEach(obj => { fabricCanvas.remove(obj); });
          if (active.getObjects().some(o => o.blurOutside)) rebuildGlobalBlurOverlay();
          fabricCanvas.discardActiveObject();
        } else {
          const hadBlur = active.blurOutside;
          fabricCanvas.remove(active);
          if (hadBlur) rebuildGlobalBlurOverlay();
        }
        fabricCanvas.renderAll(); saveUndo();
      }
    }
  });

  // Close floating panels when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.emoji-picker') && !e.target.closest('[data-tool="emoji"]'))
      $('emoji-picker').classList.add('hidden');
    if (!e.target.closest('.preset-panel') && !e.target.closest('[data-tool="text"]'))
      $('preset-panel').classList.add('hidden');
    if (!e.target.closest('.tool-options-panel') && !e.target.closest('[data-tool="rect"]') && !e.target.closest('[data-tool="ellipse"]') && !e.target.closest('[data-tool="badge"]') && !e.target.closest('[data-tool="text"]') && !e.target.closest('[data-tool="highlight"]') && !e.target.closest('[data-tool="freehand"]') && !e.target.closest('[data-tool="arrow"]') && !e.target.closest('[data-tool="image"]') && !e.target.closest('[data-tool="urlframe"]'))
      $('tool-options-panel').classList.add('hidden');
    if (!e.target.closest('.object-format-panel') && !e.target.closest('.object-gear-btn'))
      $('object-format-panel').classList.add('hidden');
  });

  // Save annotations before page unload
  window.addEventListener('beforeunload', () => {
    clearTimeout(annotationSaveTimer);
    saveCurrentAnnotations();
  });
}

let _clipboard = null;
let _clipboardOffset = 0;

const CLONE_PROPS = [
  '_isBadge', '_badgeType', '_badgeValue', '_badgeShape', '_badgeBg', '_badgeFg', '_badgeDescription',
  '_isBlurRegion', '_blurX', '_blurY', '_blurW', '_blurH', '_blurStrength', '_blurCornerRadius',
  '_isHighlight', '_highlightColor',
  '_isFreehand', '_freehandColor', '_freehandWidth', '_freehandBorderColor', '_freehandBorderWidth', '_freehandHasShadow',
  '_isFreehandLine', '_isCustomImage', '_imageDataUrl',
];

function bindKeyboardShortcuts() {
  fabricCanvas?.upperCanvasEl?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    $('tool-select')?.click();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') { document.getElementById('tool-pan')?.click(); return; }

    // Arrow keys: move selected object(s) by 1px (10px with Shift)
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key) && fabricCanvas) {
      const active = fabricCanvas.getActiveObject();
      if (active) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowUp')    active.set('top',  active.top  - step);
        if (e.key === 'ArrowDown')  active.set('top',  active.top  + step);
        if (e.key === 'ArrowLeft')  active.set('left', active.left - step);
        if (e.key === 'ArrowRight') active.set('left', active.left + step);
        active.setCoords();
        fabricCanvas.renderAll();
        saveUndo();
        return;
      }
    }

    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z') { e.preventDefault(); undo(); return; }
      if (e.key === 'y' || (e.shiftKey && e.key === 'Z')) { e.preventDefault(); redo(); return; }
      if (e.key === 's' && !e.shiftKey) { e.preventDefault(); const _pngBtn = $('btn-save-png'); if (_pngBtn && !_pngBtn.disabled && _pngBtn.offsetParent !== null) _pngBtn.click(); return; }
      if (e.key === 'S' && e.shiftKey) {
        e.preventDefault();
        if (!isPremium) { showUpgradeModal(); return; }
        fabricCanvas.discardActiveObject(); fabricCanvas.renderAll();
        setExportName(currentScreenshotName);
        (hasBadgeDescriptions() ? exportGuide() : exportPDF(fabricCanvas)).then(() => { if (confettiEnabled) launchConfetti(); });
        return;
      }

      const active = fabricCanvas?.getActiveObject();

      if (e.key === 'c') {
        if (!active || active.isEditing) return;
        e.preventDefault();
        active.clone((cloned) => {
          _clipboard = cloned;
          _clipboardOffset = 0;
        }, CLONE_PROPS);
        return;
      }

      if (e.key === 'v') {
        if (!_clipboard || active?.isEditing) return;
        e.preventDefault();
        _clipboardOffset += 15;
        _clipboard.clone((cloned) => {
          fabricCanvas.discardActiveObject();
          cloned.set({
            left: cloned.left + _clipboardOffset,
            top:  cloned.top  + _clipboardOffset,
            evented: true, selectable: true,
          });
          if (cloned.type === 'activeSelection') {
            cloned.canvas = fabricCanvas;
            cloned.forEachObject(o => { o.set({ evented: true, selectable: true }); fabricCanvas.add(o); });
            cloned.setCoords();
          } else {
            fabricCanvas.add(cloned);
          }
          fabricCanvas.setActiveObject(cloned);
          fabricCanvas.renderAll();
          saveUndo();
          scheduleAnnotationSave();
        }, CLONE_PROPS);
        return;
      }
    }

    const toolKeys = { v: 'pan', s: 'select', r: 'rect', e: 'ellipse', c: 'badge', a: 'arrow', t: 'text', h: 'highlight', f: 'freehand', b: 'blur', i: 'image', x: 'emoji', k: 'crop', u: 'urlframe' };
    if (!e.ctrlKey && !e.metaKey && toolKeys[e.key]) {
      document.getElementById('tool-' + toolKeys[e.key])?.click();
    }
  });
}

// ─── Modals ───────────────────────────────────────────────────────────────────

async function initHistorySettingsPanel() {
  const { history_limit_user } = await chrome.storage.local.get(['history_limit_user']);
  const val = history_limit_user || 500;
  $('history-limit-slider').value = val;
  $('history-limit-value').textContent = val;
}

async function applyHistoryLimit(newLimit) {
  const { screenshot_history = [] } = await chrome.storage.local.get(['screenshot_history']);
  if (screenshot_history.length > newLimit) {
    const evicted = screenshot_history.splice(newLimit);
    const evictedIds = evicted.map(e => e.id);
    await Promise.all([
      dbDeleteMany(evictedIds),
      dbDeleteManyAnnotations(evictedIds),
      dbDeleteManyThumbnails(evictedIds),
    ]);
    await chrome.storage.local.set({ screenshot_history });
  }
  await chrome.storage.local.set({ history_limit_user: newLimit });
  await loadHistory();
}

function showUpgradeModal()  { $('upgrade-modal').classList.remove('hidden'); }
function closeUpgradeModal() { $('upgrade-modal').classList.add('hidden'); }
function showLicenseModal()  { $('license-modal').classList.remove('hidden'); $('license-key-input').focus(); }
function closeLicenseModal() { $('license-modal').classList.add('hidden'); }

let _suppressReloadForConfetti = false;

async function activateLicense() {
  const key = $('license-key-input').value.trim();
  if (!key) return;
  $('btn-activate').textContent = t('licenseActivating');
  $('btn-activate').disabled = true;
  const { activateLicense: doActivate } = await import('../lib/license.js');
  // Suppress the storage-change reload listener so confetti can play first
  _suppressReloadForConfetti = true;
  const result = await doActivate(key);
  $('btn-activate').textContent = t('activateLicense');
  $('btn-activate').disabled = false;
  const msg = $('license-msg');
  msg.classList.remove('hidden', 'success', 'error');
  if (result.success) {
    fireConfetti();
    setTimeout(() => location.reload(), 2800);
  } else {
    _suppressReloadForConfetti = false;
    msg.classList.add('error');
    msg.textContent = result.error || t('licenseError');
  }
}

// ─── Confetti ─────────────────────────────────────────────────────────────────

function fireConfetti() {
  const COLORS = ['#5B5BD6','#8B5CF6','#F59E0B','#FBBF24','#EF4444','#F472B6','#10B981','#60A5FA','#ffffff','#FCD34D','#A78BFA','#34D399'];
  const DURATION = 2600;

  // Render inside the modal box, not across the whole screen
  const host = document.querySelector('#license-modal .modal') || document.body;
  const W = host.offsetWidth;
  const H = host.offsetHeight;
  const prevPos = window.getComputedStyle(host).position;
  if (prevPos === 'static') host.style.position = 'relative';

  const cvs = document.createElement('canvas');
  cvs.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:99999;border-radius:inherit';
  cvs.width = W; cvs.height = H;
  host.appendChild(cvs);
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

  // Two corner cannons angled toward the center of the modal
  // Angles use canvas coords (y-down): negative = upward, cos/sin determine direction
  // Left cannon: -95°→-15° sweeps from near-vertical to upper-right
  // Right cannon: -165°→-85° sweeps from upper-left to near-vertical
  const particles = [
    ...makeCannon(W * 0.04, H + 4, 55, -95, -15),
    ...makeCannon(W * 0.96, H + 4, 55, -165, -85),
  ];

  const start = performance.now();

  function frame(now) {
    const elapsed = now - start;
    if (elapsed > DURATION) {
      cvs.remove();
      if (prevPos === 'static') host.style.position = '';
      return;
    }
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

// Reload when license or language changes externally (e.g. activated/released/switched in popup)
// Suppressed during in-editor activation so confetti can play first.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.license_status || changes.ui_language)) {
    if (!_suppressReloadForConfetti) location.reload();
  }
});

init();
