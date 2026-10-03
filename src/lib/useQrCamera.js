// The one camera loop. Every screen that reads a QR code uses this, so a fix
// to reading lands everywhere at once — there used to be two copies, and the
// conductor's had drifted.
//
// `onText` is held in a ref, not listed as a dependency. A parent that re-renders
// every second (the ride screen's odometer does) hands down a new function each
// time, and a dependency on it restarted the camera on every tick: the stream
// was torn down before a single frame could be read.

import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { createReadPolicy, JSQR_OPTIONS, SCANS_PER_SECOND, DECODE_WIDTH } from './qr-read.mjs';

export function cameraErrorText(problem) {
  if (!window.isSecureContext) return 'The camera needs a secure address. Open the https:// link.';
  switch (problem?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission is off. Allow it in the browser bar, then reopen this screen.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'This phone has no camera this app can use.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Another app is using the camera. Close it and try again.';
    default:
      return `The camera did not start (${problem?.name ?? 'unknown'}).`;
  }
}

async function nativeFormats() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    return await window.BarcodeDetector.getSupportedFormats();
  } catch {
    return null;
  }
}

export function useQrCamera({ videoRef, canvasRef, paused = false, onText }) {
  const [error, setError] = useState(null);
  const onTextRef = useRef(onText);
  const pausedRef = useRef(paused);
  onTextRef.current = onText;
  pausedRef.current = paused;

  useEffect(() => {
    if (paused) return undefined;
    let stream = null;
    let timer = null;
    let stopped = false;
    let tick = 0;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(cameraErrorText({ name: 'NotFoundError' }));
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        });
      } catch (problem) {
        setError(cameraErrorText(problem));
        return;
      }
      // StrictMode runs effects twice; the second run must not leak the first stream.
      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      setError(null);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => {});

      const policy = createReadPolicy({ nativeFormats: await nativeFormats() });
      let detector = null;
      if (policy.useNative) {
        try {
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch {
          detector = null;
        }
      }

      const loop = async () => {
        if (stopped) return;
        tick += 1;
        let text = null;
        if (!pausedRef.current && video.readyState >= 2) {
          if (detector) text = await readNative(detector, video);
          if (!text && policy.tryFallback(tick, false)) text = readCanvas(video, canvasRef.current);
        }
        if (text && !stopped) await onTextRef.current?.(text);
        if (!stopped) timer = setTimeout(loop, 1000 / SCANS_PER_SECOND);
      };
      timer = setTimeout(loop, 1000 / SCANS_PER_SECOND);
    }

    start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (stream) stream.getTracks().forEach((track) => track.stop());
    };
  }, [paused, videoRef, canvasRef]);

  return { error };
}

async function readNative(detector, video) {
  try {
    const codes = await detector.detect(video);
    return codes[0]?.rawValue ?? null;
  } catch {
    return null;
  }
}

function readCanvas(video, canvas) {
  if (!video || !canvas || !video.videoWidth) return null;
  const scale = Math.min(1, DECODE_WIDTH / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(pixels.data, pixels.width, pixels.height, JSQR_OPTIONS)?.data ?? null;
}
