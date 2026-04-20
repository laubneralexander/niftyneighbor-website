// Tool implementations for the ScreenFellow editor.
// Each tool handles its own mouse interaction on the Fabric.js canvas.

import { TEXT_PRESETS, BADGE_PRESETS, RECT_PRESETS, HIGHLIGHT_PRESETS, FREEHAND_PRESETS, ARROW_PRESETS } from './presets.js';

// ─── VignetteRect ─────────────────────────────────────────────────────────────
// Custom Fabric.Rect subclass supporting inside-fill and outside-fill (vignette).
class VignetteRect extends fabric.Rect {
  constructor(options = {}) {
    super({ ...options, fill: 'transparent' });
    this.type = 'vignetteRect';
    this.insideFillOpacity  = options.insideFillOpacity  ?? 0;
    this.outsideFillOpacity = options.outsideFillOpacity ?? 0;
    this.fillColor = options.fillColor ?? (options.stroke || '#EF4444');
    this.blurOutside = options.blurOutside ?? false;
    this.blurAmount  = options.blurAmount  ?? 14;
  }
  _render(ctx) {
    const hw = this.width / 2, hh = this.height / 2;
    const sw = this.strokeWidth || 0;
    const rx = this.rx || 0;

    const path = (x, y, w, h, r) => {
      ctx.beginPath();
      if (r > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, r);
      else ctx.rect(x, y, w, h);
    };

    // Outside fill / vignette
    if (this.outsideFillOpacity > 0) {
      const BIG = 50000;
      ctx.save();
      ctx.globalAlpha = this.outsideFillOpacity;
      ctx.fillStyle = this.fillColor || '#000000';
      ctx.beginPath();
      ctx.rect(-BIG, -BIG, BIG * 2, BIG * 2);
      if (rx > 0 && ctx.roundRect) ctx.roundRect(-hw, -hh, this.width, this.height, rx);
      else ctx.rect(-hw, -hh, this.width, this.height);
      ctx.fill('evenodd');
      ctx.restore();
    }

    // Inside fill
    if (this.insideFillOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = this.insideFillOpacity;
      ctx.fillStyle = this.fillColor || '#EF4444';
      path(-hw, -hh, this.width, this.height, rx);
      ctx.fill();
      ctx.restore();
    }

    // Inside stroke: path is inset by sw/2 so the outer edge of the stroke
    // aligns with the rect's declared width/height — border grows inward only.
    if (sw > 0 && this.stroke && this.stroke !== 'transparent') {
      const inset = sw / 2;
      const pw = this.width  - sw;
      const ph = this.height - sw;
      if (pw > 0 && ph > 0) {
        ctx.save();
        ctx.strokeStyle = this.stroke;
        ctx.lineWidth   = sw;
        ctx.lineJoin    = 'round';
        if (this.strokeDashArray?.length) ctx.setLineDash(this.strokeDashArray);
        path(-pw / 2, -ph / 2, pw, ph, Math.max(0, rx - inset));
        ctx.stroke();
        ctx.restore();
      }
    }
  }
  toObject(props = []) {
    return { ...super.toObject(props), insideFillOpacity: this.insideFillOpacity, outsideFillOpacity: this.outsideFillOpacity, fillColor: this.fillColor, blurOutside: this.blurOutside, blurAmount: this.blurAmount };
  }
}
VignetteRect.fromObject = (obj, cb) => cb(new VignetteRect(obj));
fabric.VignetteRect = VignetteRect;

// ─── VignetteEllipse ──────────────────────────────────────────────────────────
class VignetteEllipse extends fabric.Ellipse {
  constructor(options = {}) {
    super({ ...options, fill: 'transparent' });
    this.type = 'vignetteEllipse';
    this.insideFillOpacity  = options.insideFillOpacity  ?? 0;
    this.outsideFillOpacity = options.outsideFillOpacity ?? 0;
    this.fillColor = options.fillColor ?? (options.stroke || '#EF4444');
    this.blurOutside = options.blurOutside ?? false;
    this.blurAmount  = options.blurAmount  ?? 14;
  }
  _render(ctx) {
    const rx = this.rx || 0;
    const ry = this.ry || 0;
    const sw = this.strokeWidth || 0;

    if (this.outsideFillOpacity > 0) {
      const BIG = 50000;
      ctx.save();
      ctx.globalAlpha = this.outsideFillOpacity;
      ctx.fillStyle = this.fillColor || '#000000';
      ctx.beginPath();
      ctx.rect(-BIG, -BIG, BIG * 2, BIG * 2);
      ctx.ellipse(0, 0, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
      ctx.fill('evenodd');
      ctx.restore();
    }

    if (this.insideFillOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = this.insideFillOpacity;
      ctx.fillStyle = this.fillColor || '#EF4444';
      ctx.beginPath();
      ctx.ellipse(0, 0, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (sw > 0 && this.stroke && this.stroke !== 'transparent') {
      const irx = Math.max(0.1, rx - sw / 2);
      const iry = Math.max(0.1, ry - sw / 2);
      ctx.save();
      ctx.strokeStyle = this.stroke;
      ctx.lineWidth = sw;
      if (this.strokeDashArray?.length) ctx.setLineDash(this.strokeDashArray);
      ctx.beginPath();
      ctx.ellipse(0, 0, irx, iry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
  toObject(props = []) {
    return { ...super.toObject(props), insideFillOpacity: this.insideFillOpacity, outsideFillOpacity: this.outsideFillOpacity, fillColor: this.fillColor, blurOutside: this.blurOutside, blurAmount: this.blurAmount };
  }
}
VignetteEllipse.fromObject = (obj, cb) => cb(new VignetteEllipse(obj));
fabric.VignetteEllipse = VignetteEllipse;

// ─── FreehandPath ─────────────────────────────────────────────────────────────
class FreehandPath extends fabric.Path {
  constructor(pathData, options = {}) {
    super(pathData, options);
    this.type                 = 'freehandPath';
    this._isFreehand          = options._isFreehand          ?? true;
    this._freehandColor       = options._freehandColor       ?? null;
    this._freehandWidth       = options._freehandWidth       ?? 3;
    this._freehandBorderColor = options._freehandBorderColor ?? null;
    this._freehandBorderWidth = options._freehandBorderWidth ?? 0;
    this._freehandHasShadow   = options._freehandHasShadow   ?? false;
  }
  _render(ctx) {
    if (this._freehandBorderWidth > 0 && this._freehandBorderColor) {
      ctx.save();
      ctx.strokeStyle = this._freehandBorderColor;
      ctx.lineWidth   = (this.strokeWidth || 1) + this._freehandBorderWidth * 2;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      this._renderPathCommands(ctx);
      ctx.stroke();
      ctx.restore();
    }
    super._render(ctx);
  }
  toObject(props = []) {
    return super.toObject(['_isFreehand', '_freehandColor', '_freehandWidth', '_freehandBorderColor', '_freehandBorderWidth', '_freehandHasShadow', ...props]);
  }
}
FreehandPath.fromObject = (obj, cb) => cb(new FreehandPath(obj.path, obj));
fabric.FreehandPath = FreehandPath;

// ─── ArrowShape ───────────────────────────────────────────────────────────────
function _arrowEndpointCtrl(which) {
  return new fabric.Control({
    x: 0, y: 0,
    cursorStyle: 'crosshair',
    positionHandler(dim, finalMatrix, obj) {
      return fabric.util.transformPoint(
        { x: which === 1 ? obj.x1 : obj.x2, y: which === 1 ? obj.y1 : obj.y2 },
        finalMatrix
      );
    },
    actionHandler(eventData, transform) {
      const obj = transform.target;
      const pt  = obj.canvas.getPointer(eventData);
      const inv = fabric.util.invertTransform(obj.calcTransformMatrix());
      const lp  = fabric.util.transformPoint(pt, inv);
      if (which === 1) { obj.x1 = lp.x; obj.y1 = lp.y; }
      else             { obj.x2 = lp.x; obj.y2 = lp.y; }
      obj._updateBBox();
      obj.dirty = true;
      obj.setCoords();
      obj.canvas.requestRenderAll();
      return true;
    },
    render(ctx, left, top) {
      ctx.save();
      ctx.strokeStyle = '#fff'; ctx.fillStyle = '#2563EB'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(left, top, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
    },
  });
}

class ArrowShape extends fabric.Object {
  constructor(options = {}) {
    const ax1 = options.x1 ?? 0, ay1 = options.y1 ?? 0;
    const ax2 = options.x2 ?? 100, ay2 = options.y2 ?? 100;
    const cx = (ax1 + ax2) / 2, cy = (ay1 + ay2) / 2;
    const pad = 30;
    super({
      left: cx, top: cy,
      originX: 'center', originY: 'center',
      width:  Math.max(1, Math.abs(ax2 - ax1)) + pad * 2,
      height: Math.max(1, Math.abs(ay2 - ay1)) + pad * 2,
      strokeWidth: 0, fill: 'transparent', stroke: 'transparent',
      ...options,
    });
    this.type        = 'arrowShape';
    this.x1          = ax1 - cx; this.y1 = ay1 - cy;
    this.x2          = ax2 - cx; this.y2 = ay2 - cy;
    this.arrowType      = options.arrowType      ?? 'design';
    this.arrowColor     = options.arrowColor     ?? '#EF4444';
    this.arrowWidth     = options.arrowWidth     ?? 4;
    this.borderColor    = options.borderColor    ?? null;
    this.borderWidth    = options.borderWidth    ?? 0;
    this.arrowShadow    = options.arrowShadow    ?? false;
    this._isFreehandLine = options._isFreehandLine ?? false;
    this.objectCaching  = false;
    const ep1 = _arrowEndpointCtrl(1), ep2 = _arrowEndpointCtrl(2);
    this.controls = { ...fabric.Object.prototype.controls, p1: ep1, p2: ep2 };
  }

  _updateBBox() {
    const pad = 30;
    const sx = this.scaleX || 1, sy = this.scaleY || 1;
    const ax1 = this.left + this.x1 * sx, ay1 = this.top + this.y1 * sy;
    const ax2 = this.left + this.x2 * sx, ay2 = this.top + this.y2 * sy;
    const ncx = (ax1 + ax2) / 2, ncy = (ay1 + ay2) / 2;
    this.x1 = ax1 - ncx; this.y1 = ay1 - ncy;
    this.x2 = ax2 - ncx; this.y2 = ay2 - ncy;
    this.left = ncx; this.top = ncy;
    this.scaleX = 1; this.scaleY = 1;
    this.width  = Math.max(1, Math.abs(ax2 - ax1)) + pad * 2;
    this.height = Math.max(1, Math.abs(ay2 - ay1)) + pad * 2;
  }

  updateFromEndpoints(ax1, ay1, ax2, ay2) {
    const pad = 30;
    const cx = (ax1 + ax2) / 2, cy = (ay1 + ay2) / 2;
    this.left = cx; this.top = cy;
    this.x1 = ax1 - cx; this.y1 = ay1 - cy;
    this.x2 = ax2 - cx; this.y2 = ay2 - cy;
    this.width  = Math.max(1, Math.abs(ax2 - ax1)) + pad * 2;
    this.height = Math.max(1, Math.abs(ay2 - ay1)) + pad * 2;
    this.setCoords();
  }

  _render(ctx) {
    const { x1, y1, x2, y2, arrowType, arrowColor, arrowWidth, borderColor, borderWidth, arrowShadow } = this;
    if (arrowShadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 6; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2;
    }
    if (borderWidth > 0 && borderColor)
      ArrowShape._draw(ctx, x1, y1, x2, y2, arrowType, borderColor, arrowWidth, borderWidth);
    if (arrowShadow) ctx.restore();
    ArrowShape._draw(ctx, x1, y1, x2, y2, arrowType, arrowColor, arrowWidth, 0);
  }

  static _draw(ctx, x1, y1, x2, y2, type, color, width, bw = 0) {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (len < 1) return;
    const angle = Math.atan2(dy, dx);
    const hs    = Math.min(width * 4.5, len * 0.4);
    const perp  = angle + Math.PI / 2;
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineCap = 'round'; ctx.lineJoin = 'miter'; ctx.miterLimit = 10;

    // Helper: for border pass, stroke a filled path outward by bw pixels
    const borderStroke = () => { if (bw > 0) { ctx.lineWidth = bw * 2; ctx.stroke(); } };

    if (type === 'line') {
      ctx.lineWidth = width + bw * 2;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

    } else if (type === 'line-dot') {
      ctx.lineWidth = width + bw * 2;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.beginPath(); ctx.arc(x2, y2, width * 1.8 + bw, 0, Math.PI * 2); ctx.fill();

    } else if (type === 'line-two-dots') {
      ctx.lineWidth = width + bw * 2;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.beginPath(); ctx.arc(x1, y1, width * 1.8 + bw, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x2, y2, width * 1.8 + bw, 0, Math.PI * 2); ctx.fill();

    } else if (type === 'simple') {
      const hx = x2 - Math.cos(angle) * hs, hy = y2 - Math.sin(angle) * hs;
      ctx.lineWidth = width + bw * 2;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - Math.cos(angle - 0.4) * hs, y2 - Math.sin(angle - 0.4) * hs);
      ctx.lineTo(x2 - Math.cos(angle + 0.4) * hs, y2 - Math.sin(angle + 0.4) * hs);
      ctx.closePath(); ctx.fill(); borderStroke();

    } else if (type === 'double') {
      const h1x = x1 + Math.cos(angle) * hs, h1y = y1 + Math.sin(angle) * hs;
      const h2x = x2 - Math.cos(angle) * hs, h2y = y2 - Math.sin(angle) * hs;
      ctx.lineWidth = width + bw * 2;
      ctx.beginPath(); ctx.moveTo(h1x, h1y); ctx.lineTo(h2x, h2y); ctx.stroke();
      [[x2, y2, angle], [x1, y1, angle + Math.PI]].forEach(([px, py, a]) => {
        ctx.beginPath(); ctx.moveTo(px, py);
        ctx.lineTo(px - Math.cos(a - 0.4) * hs, py - Math.sin(a - 0.4) * hs);
        ctx.lineTo(px - Math.cos(a + 0.4) * hs, py - Math.sin(a + 0.4) * hs);
        ctx.closePath(); ctx.fill(); borderStroke();
      });

    } else if (type === 'design' || type === 'design-gradient') {
      const tw = width * 0.2;
      const hx = x2 - Math.cos(angle) * hs * 0.85, hy = y2 - Math.sin(angle) * hs * 0.85;
      const f33x = x1 + dx * 0.33, f33y = y1 + dy * 0.33;

      if (type === 'design-gradient' && bw === 0) {
        const grad = ctx.createLinearGradient(x1, y1, f33x, f33y);
        grad.addColorStop(0, color + '00'); grad.addColorStop(1, color);
        ctx.save(); ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(x1 + Math.cos(perp)*tw/2, y1 + Math.sin(perp)*tw/2);
        ctx.lineTo(x1 - Math.cos(perp)*tw/2, y1 - Math.sin(perp)*tw/2);
        ctx.lineTo(f33x - Math.cos(perp)*width*0.35, f33y - Math.sin(perp)*width*0.35);
        ctx.lineTo(f33x + Math.cos(perp)*width*0.35, f33y + Math.sin(perp)*width*0.35);
        ctx.closePath(); ctx.fill(); ctx.restore();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(f33x + Math.cos(perp)*width*0.35, f33y + Math.sin(perp)*width*0.35);
        ctx.lineTo(f33x - Math.cos(perp)*width*0.35, f33y - Math.sin(perp)*width*0.35);
        ctx.lineTo(hx - Math.cos(perp)*width/2, hy - Math.sin(perp)*width/2);
        ctx.lineTo(hx + Math.cos(perp)*width/2, hy + Math.sin(perp)*width/2);
        ctx.closePath(); ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(x1 + Math.cos(perp)*tw/2, y1 + Math.sin(perp)*tw/2);
        ctx.lineTo(x1 - Math.cos(perp)*tw/2, y1 - Math.sin(perp)*tw/2);
        ctx.lineTo(hx - Math.cos(perp)*width/2, hy - Math.sin(perp)*width/2);
        ctx.lineTo(hx + Math.cos(perp)*width/2, hy + Math.sin(perp)*width/2);
        ctx.closePath(); ctx.fill(); borderStroke();
      }
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(hx - Math.cos(perp)*width*1.3, hy - Math.sin(perp)*width*1.3);
      ctx.lineTo(hx + Math.cos(perp)*width*1.3, hy + Math.sin(perp)*width*1.3);
      ctx.closePath(); ctx.fill(); borderStroke();
    } else {
      ctx.lineWidth = width + bw * 2;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.restore();
  }

  toObject(props = []) {
    return {
      ...super.toObject(props),
      x1: this.left + this.x1, y1: this.top + this.y1,
      x2: this.left + this.x2, y2: this.top + this.y2,
      arrowType: this.arrowType, arrowColor: this.arrowColor,
      arrowWidth: this.arrowWidth, borderColor: this.borderColor,
      borderWidth: this.borderWidth, arrowShadow: this.arrowShadow,
      ...(this._isFreehandLine ? { _isFreehandLine: true } : {}),
    };
  }
}
ArrowShape.fromObject = (obj, cb) => cb(new ArrowShape(obj));
fabric.ArrowShape = ArrowShape;

let canvas = null;
let currentTool = 'pan';
let selectedBadgePreset = BADGE_PRESETS[0];
let badgeMode = 'numeric';
let badgeNextOverride = null;
let currentEllipsePreset = RECT_PRESETS[0];
let selectedTextPreset = TEXT_PRESETS[0];
let currentRectPreset = RECT_PRESETS[0];
let currentHighlightPreset = HIGHLIGHT_PRESETS[0];
let currentFreehandPreset = FREEHAND_PRESETS[0];
let currentArrowPreset = ARROW_PRESETS[0];
let _freehandShiftStart = null;
let _freehandShiftEnd   = null;
let drawColor = '#EF4444';
let drawWidth = 3;
let isDrawingShape = false;
let shapeStartX = 0, shapeStartY = 0;
let activeShape = null;
let onObjectAdded = null;

// Pan state
let isPanning = false;
let panStartX = 0, panStartY = 0;
let panScrollStartX = 0, panScrollStartY = 0;

// Source image for blur tool
let sourceImgEl = null;

export function setSourceImage(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  sourceImgEl = img;
}

export function initTools(fabricCanvas, objectAddedCallback) {
  canvas = fabricCanvas;
  onObjectAdded = objectAddedCallback;
  bindCanvasEvents();
}

export function setTool(tool) {
  currentTool = tool;
  canvas.isDrawingMode = false;
  canvas.selection = false;
  // Prevent dragging existing objects with any tool other than select
  canvas.skipTargetFind = true;
  canvas.defaultCursor = 'crosshair';
  isPanning = false;

  if (tool === 'pan') {
    canvas.defaultCursor = 'grab';
    canvas.discardActiveObject();
    canvas.renderAll();
  } else if (tool === 'select') {
    canvas.selection = true;
    canvas.skipTargetFind = false; // only select can interact with existing objects
    canvas.defaultCursor = 'default';
  } else if (tool === 'freehand') {
    canvas.isDrawingMode = true;
    canvas.freeDrawingBrush.color = currentFreehandPreset.color;
    canvas.freeDrawingBrush.width = currentFreehandPreset.width;
    patchFreehandBrushForShift();
  } else if (tool === 'emoji') {
    canvas.defaultCursor = 'default';
  }
}

export function setDrawColor(color) {
  drawColor = color;
  if (canvas.isDrawingMode) canvas.freeDrawingBrush.color = color;
}

export function setDrawWidth(w) {
  drawWidth = w;
  if (canvas.isDrawingMode) canvas.freeDrawingBrush.width = w;
}

export function setBadgePreset(preset) { selectedBadgePreset = preset; }
export function setBadgeMode(mode) { badgeMode = mode; }
export function setBadgeNextValue(val) { badgeNextOverride = val; }
export function setEllipsePreset(preset) { currentEllipsePreset = preset; }
export function setHighlightPreset(preset) { currentHighlightPreset = preset; }
export function setFreehandPreset(preset) {
  currentFreehandPreset = preset;
  if (canvas?.isDrawingMode) {
    canvas.freeDrawingBrush.color = preset.color;
    canvas.freeDrawingBrush.width = preset.width;
  }
}

export function setArrowPreset(preset) { currentArrowPreset = preset; }

export function setTextPreset(preset) {
  selectedTextPreset = preset;
}

export function setRectPreset(preset) {
  currentRectPreset = preset;
}

export function getSourceImage() { return sourceImgEl; }

function patchFreehandBrushForShift() {
  const brush = canvas.freeDrawingBrush;
  if (brush.__shiftPatched) return;
  brush.__shiftPatched = true;

  const origDown = brush.onMouseDown.bind(brush);
  brush.onMouseDown = function(pointer, options) {
    _freehandShiftStart = options?.e?.shiftKey ? { x: pointer.x, y: pointer.y } : null;
    _freehandShiftEnd   = null;
    origDown(pointer, options);
  };

  const origMove = brush.onMouseMove.bind(brush);
  brush.onMouseMove = function(pointer, options) {
    if (_freehandShiftStart && options?.e?.shiftKey) {
      _freehandShiftEnd = { x: pointer.x, y: pointer.y };
      // Draw a clean straight-line preview on the upper canvas
      const ctx = canvas.contextTop;
      if (ctx) {
        canvas.clearContext(ctx);
        ctx.save();
        ctx.strokeStyle = this.color;
        ctx.lineWidth   = this.width;
        ctx.lineCap     = 'round';
        ctx.beginPath();
        ctx.moveTo(_freehandShiftStart.x * canvas.getZoom(), _freehandShiftStart.y * canvas.getZoom());
        ctx.lineTo(pointer.x * canvas.getZoom(), pointer.y * canvas.getZoom());
        ctx.stroke();
        ctx.restore();
      }
      // Keep _points as just the start so the finalized path is a straight line
      this._points = [
        new fabric.Point(_freehandShiftStart.x, _freehandShiftStart.y),
        new fabric.Point(pointer.x, pointer.y),
      ];
      return;
    }
    origMove(pointer, options);
  };
}

function bindCanvasEvents() {
  canvas.on('mouse:down', handleMouseDown);
  canvas.on('mouse:move', handleMouseMove);
  canvas.on('mouse:up', handleMouseUp);
  canvas.on('path:created', (e) => {
    const origPath = e.path;
    const preset   = currentFreehandPreset;

    // Shift held → replace freehand path with adjustable straight line
    if (_freehandShiftStart && _freehandShiftEnd) {
      const s = _freehandShiftStart, en = _freehandShiftEnd;
      _freehandShiftStart = null; _freehandShiftEnd = null;
      canvas.remove(origPath);
      const arrow = new ArrowShape({
        x1: s.x, y1: s.y, x2: en.x, y2: en.y,
        arrowType: 'line',
        arrowColor: preset.color,
        arrowWidth: preset.width,
        borderColor: preset.borderColor || null,
        borderWidth: preset.borderWidth || 0,
        arrowShadow: !!preset.shadow,
        opacity: preset.opacity ?? 1,
        selectable: true, evented: true,
        _isFreehandLine: true,
      });
      canvas.add(arrow);
      canvas.setActiveObject(arrow);
      canvas.renderAll();
      if (onObjectAdded) onObjectAdded();
      return;
    }
    _freehandShiftStart = null; _freehandShiftEnd = null;

    // Discard single-click dots — freehand needs actual drawing
    if ((origPath.width || 0) < MIN_DRAG && (origPath.height || 0) < MIN_DRAG) {
      canvas.remove(origPath);
      canvas.renderAll();
      return;
    }

    // Convert to FreehandPath for proper border rendering
    const fp = new FreehandPath(origPath.path, {
      stroke: origPath.stroke, strokeWidth: origPath.strokeWidth,
      fill: origPath.fill, left: origPath.left, top: origPath.top,
      scaleX: origPath.scaleX, scaleY: origPath.scaleY,
      pathOffset: origPath.pathOffset,
    });
    fp._isFreehand          = true;
    fp._freehandColor       = preset.color;
    fp._freehandWidth       = preset.width;
    fp._freehandBorderColor = preset.borderColor || null;
    fp._freehandBorderWidth = preset.borderWidth || 0;
    fp._freehandHasShadow   = !!preset.shadow;
    if (preset.shadow)
      fp.set({ shadow: new fabric.Shadow({ color: 'rgba(0,0,0,0.45)', blur: 6, offsetX: 2, offsetY: 2 }) });
    fp.set({ opacity: preset.opacity ?? 1 });

    canvas.remove(origPath);
    canvas.add(fp);
    canvas.setActiveObject(fp);
    canvas.renderAll();
    if (onObjectAdded) onObjectAdded();
  });
}

function getCanvasPoint(e) {
  const ptr = canvas.getPointer(e.e);
  return { x: ptr.x, y: ptr.y };
}

function getCanvasArea() {
  return document.querySelector('.canvas-area');
}

function handleMouseDown(e) {
  if (e.e && e.e.button !== 0) return;
  if (currentTool === 'pan') {
    isPanning = true;
    canvas.discardActiveObject();
    const area = getCanvasArea();
    panStartX = e.e.clientX;
    panStartY = e.e.clientY;
    panScrollStartX = area.scrollLeft;
    panScrollStartY = area.scrollTop;
    canvas.defaultCursor = 'grabbing';
    canvas.setCursor('grabbing');
    return;
  }

  // For select tool let Fabric.js handle object selection natively.
  // Drawing/placement tools must be able to place on top of existing objects.
  if (currentTool === 'select') return;

  if (['rect', 'ellipse', 'highlight', 'arrow', 'blur', 'text'].includes(currentTool)) {
    const pt = getCanvasPoint(e);
    shapeStartX = pt.x;
    shapeStartY = pt.y;
    isDrawingShape = true;
    canvas.discardActiveObject();

    if (currentTool === 'rect') {
      const p = currentRectPreset;
      activeShape = new VignetteRect({
        left: pt.x, top: pt.y,
        width: 0, height: 0,
        stroke: p.stroke,
        strokeWidth: p.strokeWidth,
        strokeDashArray: p.strokeDashArray || null,
        rx: p.rx, ry: p.rx,
        insideFillOpacity: p.insideFillOpacity,
        outsideFillOpacity: p.outsideFillOpacity,
        fillColor: p.fillColor,
        blurOutside: p.blurOutside ?? false,
        selectable: false
      });
    } else if (currentTool === 'ellipse') {
      const p = currentEllipsePreset;
      activeShape = new VignetteEllipse({
        left: pt.x, top: pt.y,
        rx: 0, ry: 0,
        stroke: p.stroke,
        strokeWidth: p.strokeWidth,
        strokeDashArray: p.strokeDashArray || null,
        insideFillOpacity: p.insideFillOpacity,
        outsideFillOpacity: p.outsideFillOpacity,
        fillColor: p.fillColor,
        blurOutside: p.blurOutside ?? false,
        selectable: false
      });
    } else if (currentTool === 'highlight') {
      const hp = currentHighlightPreset;
      activeShape = new fabric.Rect({
        left: pt.x, top: pt.y,
        width: 0, height: 0,
        fill: hp.color,
        opacity: hp.opacity,
        stroke: null,
        strokeWidth: 0,
        rx: hp.rx || 0, ry: hp.rx || 0,
        selectable: false
      });
      activeShape._isHighlight = true;
      activeShape._highlightColor = hp.color;
    } else if (currentTool === 'arrow') {
      const p = currentArrowPreset;
      activeShape = new ArrowShape({
        x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y,
        arrowType: p.arrowType, arrowColor: p.arrowColor,
        arrowWidth: p.arrowWidth, borderColor: p.borderColor,
        borderWidth: p.borderWidth, arrowShadow: p.shadow,
        opacity: p.opacity ?? 1,
        selectable: false,
      });
    } else if (currentTool === 'blur') {
      activeShape = new fabric.Rect({
        left: pt.x, top: pt.y,
        width: 0, height: 0,
        fill: 'rgba(120,160,200,0.18)',
        stroke: 'rgba(255,255,255,0.5)',
        strokeWidth: 1,
        strokeDashArray: [5, 4],
        selectable: false
      });
    } else if (currentTool === 'text') {
      activeShape = new fabric.Rect({
        left: pt.x, top: pt.y,
        width: 0, height: 0,
        fill: 'rgba(100,140,220,0.08)',
        stroke: 'rgba(100,140,220,0.6)',
        strokeWidth: 1,
        strokeDashArray: [5, 4],
        selectable: false
      });
    }

    if (activeShape) canvas.add(activeShape);
  }
}

function handleMouseMove(e) {
  if (currentTool === 'pan' && isPanning) {
    const area = getCanvasArea();
    area.scrollLeft = panScrollStartX - (e.e.clientX - panStartX);
    area.scrollTop  = panScrollStartY - (e.e.clientY - panStartY);
    return;
  }

  if (!isDrawingShape || !activeShape) return;
  const pt = getCanvasPoint(e);

  if (['rect', 'highlight', 'blur', 'text'].includes(currentTool)) {
    let w = Math.abs(pt.x - shapeStartX);
    let h = Math.abs(pt.y - shapeStartY);
    if (e.e.shiftKey && ['rect', 'highlight'].includes(currentTool)) {
      const s = Math.min(w, h);
      w = s; h = s;
    }
    const x = pt.x >= shapeStartX ? shapeStartX : shapeStartX - w;
    const y = pt.y >= shapeStartY ? shapeStartY : shapeStartY - h;
    activeShape.set({ left: x, top: y, width: w, height: h });
  } else if (currentTool === 'ellipse') {
    let w = Math.abs(pt.x - shapeStartX);
    let h = Math.abs(pt.y - shapeStartY);
    if (e.e.shiftKey) { const s = Math.min(w, h); w = s; h = s; }
    const x = pt.x >= shapeStartX ? shapeStartX : shapeStartX - w;
    const y = pt.y >= shapeStartY ? shapeStartY : shapeStartY - h;
    activeShape.set({ left: x, top: y, rx: w / 2, ry: h / 2 });
  } else if (currentTool === 'arrow') {
    activeShape.updateFromEndpoints(shapeStartX, shapeStartY, pt.x, pt.y);
  }

  canvas.renderAll();
}

const MIN_DRAG = 8;

function handleMouseUp(e) {
  if (e.e && e.e.button !== 0) return;
  if (currentTool === 'pan') {
    isPanning = false;
    canvas.defaultCursor = 'grab';
    canvas.setCursor('grab');
    return;
  }

  if (!isDrawingShape) {
    if (currentTool === 'badge') placeBadge(e);
    else if (currentTool === 'emoji') return;
    return;
  }

  isDrawingShape = false;
  if (!activeShape) return;

  let dragW, dragH;
  if (currentTool === 'ellipse') {
    dragW = (activeShape.rx || 0) * 2;
    dragH = (activeShape.ry || 0) * 2;
  } else if (currentTool === 'arrow') {
    dragW = Math.abs(activeShape.x2 - activeShape.x1);
    dragH = Math.abs(activeShape.y2 - activeShape.y1);
  } else {
    dragW = activeShape.width || 0;
    dragH = activeShape.height || 0;
  }
  const isClick = dragW < MIN_DRAG && dragH < MIN_DRAG;

  if (currentTool === 'blur') {
    const x = activeShape.left, y = activeShape.top;
    const w = activeShape.width, h = activeShape.height;
    canvas.remove(activeShape);
    activeShape = null;
    if (!isClick) applyBlur(x, y, w, h);
    else canvas.renderAll();
    return;
  } else if (currentTool === 'text') {
    const dw = activeShape.width;
    canvas.remove(activeShape);
    activeShape = null;
    placeTextbox(shapeStartX, shapeStartY, dw > MIN_DRAG ? dw : 200);
    return;
  } else {
    if (isClick) {
      canvas.remove(activeShape);
      activeShape = null;
      placeDefaultShape(currentTool, shapeStartX, shapeStartY);
      return;
    }
    activeShape.set({ selectable: true, evented: true });
    activeShape.setCoords();
    const placed = activeShape;
    activeShape = null;
    canvas.renderAll();
    if (onObjectAdded) onObjectAdded(placed);
    return;
  }
}

function placeDefaultShape(tool, cx, cy) {
  let placed = null;
  if (tool === 'rect') {
    const p = currentRectPreset;
    placed = new VignetteRect({
      left: cx - 100, top: cy - 60, width: 200, height: 120,
      stroke: p.stroke, strokeWidth: p.strokeWidth,
      strokeDashArray: p.strokeDashArray || null,
      rx: p.rx, ry: p.rx,
      insideFillOpacity: p.insideFillOpacity,
      outsideFillOpacity: p.outsideFillOpacity,
      fillColor: p.fillColor,
      blurOutside: p.blurOutside ?? false,
      selectable: true, evented: true,
    });
  } else if (tool === 'ellipse') {
    const p = currentEllipsePreset;
    placed = new VignetteEllipse({
      left: cx - 60, top: cy - 40, rx: 60, ry: 40,
      stroke: p.stroke, strokeWidth: p.strokeWidth,
      strokeDashArray: p.strokeDashArray || null,
      insideFillOpacity: p.insideFillOpacity,
      outsideFillOpacity: p.outsideFillOpacity,
      fillColor: p.fillColor,
      blurOutside: p.blurOutside ?? false,
      selectable: true, evented: true,
    });
  } else if (tool === 'highlight') {
    const hp = currentHighlightPreset;
    placed = new fabric.Rect({
      left: cx - 80, top: cy - 14, width: 160, height: 28,
      fill: hp.color, opacity: hp.opacity,
      stroke: null, strokeWidth: 0,
      rx: hp.rx || 0, ry: hp.rx || 0,
      selectable: true, evented: true,
    });
    placed._isHighlight = true;
    placed._highlightColor = hp.color;
  } else if (tool === 'arrow') {
    const p = currentArrowPreset;
    placed = new ArrowShape({
      x1: cx - 60, y1: cy, x2: cx + 60, y2: cy,
      arrowType: p.arrowType, arrowColor: p.arrowColor,
      arrowWidth: p.arrowWidth, borderColor: p.borderColor,
      borderWidth: p.borderWidth, arrowShadow: p.shadow,
      opacity: p.opacity ?? 1,
      selectable: true, evented: true,
    });
  }
  if (!placed) return;
  canvas.add(placed);
  canvas.renderAll();
  if (onObjectAdded) onObjectAdded(placed);
}

function renderBlurCanvas(x, y, w, h, strength) {
  const BLEED = 30;
  const tmp = document.createElement('canvas');
  tmp.width  = Math.round(w);
  tmp.height = Math.round(h);
  const ctx = tmp.getContext('2d');
  ctx.filter = `blur(${strength}px)`;
  ctx.drawImage(sourceImgEl, x - BLEED, y - BLEED, w + BLEED * 2, h + BLEED * 2, -BLEED, -BLEED, w + BLEED * 2, h + BLEED * 2);
  ctx.filter = 'none';
  return tmp;
}

function applyBlur(x, y, w, h) {
  if (w < 4 || h < 4 || !sourceImgEl) return;
  const strength = 14;
  const dataUrl = renderBlurCanvas(x, y, w, h, strength).toDataURL('image/png');
  fabric.Image.fromURL(dataUrl, (img) => {
    img.set({ left: x, top: y, selectable: true, evented: true });
    img._isBlurRegion = true;
    img._blurX = x; img._blurY = y; img._blurW = w; img._blurH = h;
    img._blurStrength = strength;
    canvas.add(img);
    canvas.setActiveObject(img);
    canvas.renderAll();
    if (onObjectAdded) onObjectAdded();
  });
}

export function reapplyBlur(obj, strength) {
  if (!obj._isBlurRegion || !sourceImgEl) return;
  const { _blurX: x, _blurY: y, _blurW: w, _blurH: h } = obj;
  if (w < 4 || h < 4) return;
  const dataUrl = renderBlurCanvas(x, y, w, h, strength).toDataURL('image/png');
  obj._blurStrength = strength;
  obj.setSrc(dataUrl, () => {
    // setSrc updates obj.width/height to the new image size; reset scale to 1
    // so the visual size stays exactly w×h and doesn't multiply on each call.
    obj.set({ left: x, top: y, scaleX: 1, scaleY: 1, flipX: false, flipY: false });
    if (obj._blurCornerRadius > 0) {
      obj.clipPath = new fabric.Rect({ width: obj.width, height: obj.height, rx: obj._blurCornerRadius, ry: obj._blurCornerRadius, originX: 'center', originY: 'center' });
    }
    obj.dirty = true;
    canvas.renderAll();
  }, { crossOrigin: null });
}

function numToAlpha(n) {
  let result = '';
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result || 'A';
}

function getNextBadgeNum() {
  if (badgeNextOverride !== null) {
    const val = badgeNextOverride;
    badgeNextOverride = null;
    return val;
  }
  let max = 0;
  canvas.getObjects().forEach(obj => {
    if (obj.type !== 'group') return;
    if (obj._isBadge && obj._badgeValue != null) {
      const sameType = badgeMode === 'alpha' ? obj._badgeType === 'alpha' : obj._badgeType !== 'alpha';
      if (sameType) max = Math.max(max, obj._badgeValue);
    } else if (!obj._isBadge) {
      obj.getObjects().forEach(child => {
        if (child.type === 'text' || child.type === 'i-text') {
          const n = parseInt(child.text);
          if (!isNaN(n) && n > max) max = n;
        }
      });
    }
  });
  return max + 1;
}

function placeBadge(e) {
  const pt = getCanvasPoint(e);
  const preset = selectedBadgePreset;
  const size = 18;
  const num = getNextBadgeNum();
  const label = badgeMode === 'numeric' ? String(num) : numToAlpha(num);

  let shapeObj;
  if (preset.shape === 'circle') {
    shapeObj = new fabric.Circle({
      radius: size, fill: preset.bg, stroke: '#ffffff', strokeWidth: 2,
      originX: 'center', originY: 'center', left: 0, top: 0
    });
  } else {
    shapeObj = new fabric.Rect({
      width: size * 2, height: size * 2, fill: preset.bg, stroke: '#ffffff', strokeWidth: 2,
      rx: 5, ry: 5, originX: 'center', originY: 'center', left: 0, top: 0
    });
  }

  const textObj = new fabric.Text(label, {
    fontSize: 14, fontWeight: 'bold', fill: preset.fg,
    fontFamily: 'Arial, sans-serif',
    originX: 'center', originY: 'center', left: 0, top: 0,
    selectable: false
  });

  const sc = preset.scale ?? 1;
  const group = new fabric.Group([shapeObj, textObj], {
    left: pt.x - size, top: pt.y - size,
    lockUniScaling: true,
    opacity: preset.opacity ?? 1,
    scaleX: sc, scaleY: sc,
  });
  group._isBadge     = true;
  group._badgeType   = badgeMode;
  group._badgeValue  = num;
  group._badgeShape  = preset.shape;
  group._badgeBg     = preset.bg;
  group._badgeFg     = preset.fg;
  group._shapeRef    = shapeObj;
  group._textRef     = textObj;

  group.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
  canvas.add(group);
  canvas.setActiveObject(group);
  canvas.renderAll();
  if (onObjectAdded) onObjectAdded();
}

function placeTextbox(x, y, width) {
  const props = { ...selectedTextPreset.fabricProps };
  if (props.shadow && !(props.shadow instanceof fabric.Shadow)) {
    props.shadow = new fabric.Shadow(props.shadow);
  }

  const textbox = new fabric.Textbox('Text', {
    left: x,
    top: y,
    width: width,
    ...props,
    editable: true
  });

  canvas.add(textbox);
  canvas.setActiveObject(textbox);
  textbox.enterEditing();
  textbox.selectAll();
  canvas.renderAll();
  if (onObjectAdded) onObjectAdded();
}


export function placeImage(dataUrl, opacity = 1, savedScale = null) {
  fabric.Image.fromURL(dataUrl, (img) => {
    const zoom = canvas.getZoom();
    const maxW = canvas.getWidth()  / zoom * 0.5;
    const maxH = canvas.getHeight() / zoom * 0.5;
    const scale = savedScale ?? Math.min(maxW / img.width, maxH / img.height, 1);
    img.set({
      left: canvas.getWidth()  / zoom / 2,
      top:  canvas.getHeight() / zoom / 2,
      originX: 'center', originY: 'center',
      scaleX: scale, scaleY: scale,
      opacity,
      lockUniScaling: true,
      selectable: true, evented: true,
    });
    img._isCustomImage = true;
    img._imageDataUrl  = dataUrl;
    img.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
    canvas.add(img);
    setTimeout(() => { canvas.setActiveObject(img); canvas.renderAll(); }, 0);
    if (onObjectAdded) onObjectAdded();
  });
}

export function placeEmoji(emoji) {
  const zoom = canvas.getZoom();
  const centerX = canvas.getWidth()  / zoom / 2;
  const centerY = canvas.getHeight() / zoom / 2;

  const text = new fabric.Text(emoji, {
    left: centerX,
    top: centerY,
    fontSize: 64,
    originX: 'center',
    originY: 'center',
    lockUniScaling: true,
  });
  text._isEmoji = true;
  text.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
  canvas.add(text);
  canvas.setActiveObject(text);
  canvas.renderAll();
  if (onObjectAdded) onObjectAdded();
}
