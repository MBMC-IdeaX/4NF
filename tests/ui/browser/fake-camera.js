// Browser init script: replaces the camera with a canvas that shows whatever
// QR image the test sets with window.__fakeQr(dataUrl, { invert }).
// Used to check every camera screen without holding a phone up to a phone.
(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  let image = null;
  let invert = false;
  function draw() {
    ctx.fillStyle = invert ? '#111' : '#d8d4cc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (image) {
      ctx.save();
      if (invert) ctx.filter = 'invert(1)';
      ctx.drawImage(image, 440, 160, 400, 400);
      ctx.restore();
    }
    requestAnimationFrame(draw);
  }
  draw();
  window.__fakeQr = (dataUrl, options = {}) => new Promise((resolve) => {
    invert = Boolean(options.invert);
    if (!dataUrl) { image = null; resolve(); return; }
    const next = new Image();
    next.onload = () => { image = next; resolve(); };
    next.src = dataUrl;
  });
  // Native detection off unless a test turns it on, so jsQR is what is tested.
  if (!window.__keepBarcodeDetector) delete window.BarcodeDetector;
  const fake = async () => canvas.captureStream(15);
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = fake;
})();
