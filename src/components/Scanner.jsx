// The camera, reading one QR code and handing its text back.
//
// Shared by the door terminal (reading ride codes and passes) and the passenger
// app (keeping a boarding pass and a receipt). The reading itself lives in
// useQrCamera, which every camera screen uses.

import { useRef } from 'react';
import { useQrCamera } from '../lib/useQrCamera';

export default function Scanner({ label, onText, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  // One code per Scanner: after the first, stop handing text back so a parent
  // that is still closing the scanner is not given the same code twice.
  const doneRef = useRef(false);
  const { error } = useQrCamera({
    videoRef,
    canvasRef,
    onText: (text) => {
      if (doneRef.current) return;
      doneRef.current = true;
      onText(text);
    },
  });

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
