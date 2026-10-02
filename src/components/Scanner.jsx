// The camera, reading one QR code and handing its text back.
//
// Shared by the door terminal (reading ride codes and passes) and the passenger
// app (keeping a boarding pass and a receipt). `BarcodeDetector` where the
// browser has it — native, fast, cheap on a battery — and jsQR everywhere else,
// at 640 px and eight frames a second, which a cheap Android can sustain
// without getting hot.

import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

const SCANS_PER_SECOND = 8;
const DECODE_WIDTH = 640;

export default function Scanner({ label, onText, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let stream = null;
    let timer = null;
    let stopped = false;
    let detector = null;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        });
      } catch (problem) {
        setError(`Camera is blocked. Allow it, then try again. (${problem.name})`);
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => {});

      if ('BarcodeDetector' in window) {
        try {
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch {
          detector = null;
        }
      }

      const tick = async () => {
        if (stopped) return;
        const text = detector ? await readNative(detector, video) : readCanvas(video, canvasRef.current);
        if (text) { onText(text); return; }
        timer = setTimeout(tick, 1000 / SCANS_PER_SECOND);
      };
      timer = setTimeout(tick, 1000 / SCANS_PER_SECOND);
    }

    start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (stream) stream.getTracks().forEach((track) => track.stop());
    };
  }, [onText]);

  return (
    <div className="scan">
      <video ref={videoRef} playsInline muted />
      <canvas ref={canvasRef} hidden />
      <div className="scan__reticle" aria-hidden="true"><i /><i /><i /><i /></div>
      <p>{error ?? label}</p>
      <button type="button" onClick={onClose}>Cancel</button>
    </div>
  );
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
  const scale = DECODE_WIDTH / video.videoWidth;
  canvas.width = DECODE_WIDTH;
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
}
