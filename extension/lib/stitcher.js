// Standalone stitcher used when stitching happens outside the content script context.
// Takes an array of { dataUrl, cropTop, cropHeight } objects and returns a stitched PNG dataURL.

export async function stitch(segments, width) {
  if (!segments.length) return null;
  if (segments.length === 1 && segments[0].cropTop === 0) return segments[0].dataUrl;

  const images = await Promise.all(segments.map(s => loadImage(s.dataUrl)));

  const totalHeight = segments.reduce((sum, s) => sum + s.cropHeight, 0);
  const canvas = new OffscreenCanvas(width, totalHeight);
  const ctx = canvas.getContext('2d');

  let yOffset = 0;
  for (let i = 0; i < images.length; i++) {
    const { cropTop, cropHeight } = segments[i];
    ctx.drawImage(images[i], 0, cropTop, width, cropHeight, 0, yOffset, width, cropHeight);
    yOffset += cropHeight;
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
