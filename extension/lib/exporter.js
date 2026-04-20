let _exportName = '';
export function setExportName(name) { _exportName = name || ''; }

function buildFilename(ext) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  if (_exportName) {
    const safe = _exportName.replace(/[^\w\s\-]/g, '').trim().replace(/\s+/g, '-').slice(0, 50);
    if (safe) return `${safe}_${date}_${time}.${ext}`;
  }
  return `ScreenFellow-${date}_${time}.${ext}`;
}

export async function exportPNG(canvas) {
  const blob = await canvasToBlob(canvas, 'image/png');
  downloadBlob(blob, buildFilename('png'));
}

export function getAnnotatedDataUrl(fabricCanvas) {
  return new Promise((resolve) => {
    const zoom = fabricCanvas.getZoom();
    const w = Math.round(fabricCanvas.getWidth() / zoom);
    const h = Math.round(fabricCanvas.getHeight() / zoom);
    fabricCanvas.setZoom(1);
    fabricCanvas.setWidth(w);
    fabricCanvas.setHeight(h);
    fabricCanvas.renderAll();
    const dataUrl = fabricCanvas.getElement().toDataURL('image/png');
    fabricCanvas.setZoom(zoom);
    fabricCanvas.setWidth(Math.round(w * zoom));
    fabricCanvas.setHeight(Math.round(h * zoom));
    fabricCanvas.renderAll();
    resolve(dataUrl);
  });
}

export function downloadDataUrl(dataUrl, ext) {
  fetch(dataUrl)
    .then(r => r.blob())
    .then(blob => downloadBlob(blob, buildFilename(ext)));
}

export async function exportPDF(canvas) {
  const zoom = canvas.getZoom();
  const realW = Math.round(canvas.getWidth() / zoom);
  const realH = Math.round(canvas.getHeight() / zoom);
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
  const pdfBlob = await buildPDF(blob, realW, realH);
  downloadBlob(pdfBlob, buildFilename('pdf'));
}

// Export PDF from an already-composited dataUrl (e.g. with URL frame applied).
// pageUrl and frameStyle are used to add a clickable link annotation over the frame bar.
export async function exportPDFFromDataUrl(dataUrl, pageUrl = '', frameStyle = 'none') {
  const img = await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.src = dataUrl; });
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise(resolve => c.toBlob(resolve, 'image/jpeg', 0.92));

  // Build link annotation covering the frame bar
  const annotations = [];
  if (pageUrl && frameStyle !== 'none') {
    const frameH = frameStyle === 'mac' ? 44 : frameStyle === 'win' ? 40 : 36;
    if (frameStyle === 'bar-bottom') {
      annotations.push({ rect: [0, img.height - frameH, img.width, img.height], url: pageUrl });
    } else {
      annotations.push({ rect: [0, 0, img.width, frameH], url: pageUrl });
    }
  }

  const pdfBlob = await buildPDF(blob, img.width, img.height, annotations);
  downloadBlob(pdfBlob, buildFilename('pdf'));
}

// ─── Minimal PDF builder (no external library) ────────────────────────────────
// Builds a single-page PDF with one JPEG image and optional URI link annotations.
// Spec: ISO 32000 (PDF 1.4).

async function buildPDF(jpegBlob, widthPx, heightPx, linkAnnotations = []) {
  const buffer = await jpegBlob.arrayBuffer();
  const jpegBytes = new Uint8Array(buffer);
  const imgLen = jpegBytes.length;

  // PDF uses points (1 pt = 1/72 in). Screen is 96 dpi → 1 px = 72/96 pt.
  const PX_TO_PT = 72 / 96;
  const ptX = px => (px * PX_TO_PT).toFixed(3);
  // PDF y-axis is bottom-up; image y-axis is top-down — flip when converting.
  const ptY = py => ((heightPx - py) * PX_TO_PT).toFixed(3);
  const wPt = ptX(widthPx);
  const hPt = ptX(heightPx);

  // Content stream: scale-to-page and draw image
  const cs = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`;

  // Build annotation objects (objects 6, 7, ...)
  const annotObjs = linkAnnotations.map((ann, i) => {
    const [x1, y1, x2, y2] = ann.rect;
    // PDF /Rect = [llx lly urx ury] — lower-left to upper-right in PDF points
    const rect = `${ptX(x1)} ${ptY(y2)} ${ptX(x2)} ${ptY(y1)}`;
    const uri = ann.url.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    return s(`${6 + i} 0 obj\n<< /Type /Annot /Subtype /Link /Rect [${rect}]\n   /A << /Type /Action /S /URI /URI (${uri}) >>\n   /Border [0 0 0]\n>>\nendobj\n`);
  });

  const annotStr = linkAnnotations.length
    ? `/Annots [${linkAnnotations.map((_, i) => `${6 + i} 0 R`).join(' ')}]`
    : '';
  const totalObjs = 6 + linkAnnotations.length;

  const o1  = s(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  const o2  = s(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  const o3  = s(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}]\n   /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >>\n   ${annotStr}\n>>\nendobj\n`);
  const o4  = s(`4 0 obj\n<< /Length ${cs.length} >>\nstream\n${cs}\nendstream\nendobj\n`);
  const o5h = s(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx}\n   /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgLen}\n>>\nstream\n`);
  const o5f = s(`\nendstream\nendobj\n`);
  const hdr = s(`%PDF-1.4\n`);

  // Calculate byte offsets for xref table
  const off1 = hdr.length;
  const off2 = off1 + o1.length;
  const off3 = off2 + o2.length;
  const off4 = off3 + o3.length;
  const off5 = off4 + o4.length;
  let cur = off5 + o5h.length + imgLen + o5f.length;
  const annotOffsets = annotObjs.map(a => { const off = cur; cur += a.length; return off; });
  const xrefOff = cur;

  const p10 = n => String(n).padStart(10, '0');
  let xrefEntries = `0000000000 65535 f \n${p10(off1)} 00000 n \n${p10(off2)} 00000 n \n${p10(off3)} 00000 n \n${p10(off4)} 00000 n \n${p10(off5)} 00000 n \n`;
  annotOffsets.forEach(off => { xrefEntries += `${p10(off)} 00000 n \n`; });

  const xref    = s(`xref\n0 ${totalObjs}\n${xrefEntries}`);
  const trailer = s(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`);

  const parts = [hdr, o1, o2, o3, o4, o5h, jpegBytes, o5f, ...annotObjs, xref, trailer];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }

  return new Blob([out], { type: 'application/pdf' });
}

// Encode ASCII string to Uint8Array (all PDF structural text is ASCII)
function s(str) {
  return new TextEncoder().encode(str);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function canvasToBlob(fabricCanvas, type, quality = 1) {
  return new Promise((resolve) => {
    const zoom = fabricCanvas.getZoom();
    const origW = fabricCanvas.getWidth();
    const origH = fabricCanvas.getHeight();
    const w = Math.round(origW / zoom);
    const h = Math.round(origH / zoom);

    fabricCanvas.setZoom(1);
    fabricCanvas.setWidth(w);
    fabricCanvas.setHeight(h);
    fabricCanvas.renderAll();

    const el = fabricCanvas.getElement();

    const finish = (blob) => {
      fabricCanvas.setZoom(zoom);
      fabricCanvas.setWidth(origW);
      fabricCanvas.setHeight(origH);
      fabricCanvas.renderAll();
      resolve(blob);
    };

    if (type === 'image/jpeg') {
      // JPEG has no alpha channel — composite over white to prevent black output
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      const ctx = tmp.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(el, 0, 0);
      tmp.toBlob(finish, type, quality);
    } else {
      el.toBlob(finish, type, quality);
    }
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
}
