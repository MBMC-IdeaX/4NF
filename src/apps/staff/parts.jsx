// Small parts the staff screens share: picking a scan, opening one, showing a
// one-time code.

import { useRef } from 'react';
import { Button, Icon } from '../../ui';
import { FILE_TYPES, openScan } from './data';

// A button that opens the file picker and hands back the chosen file.
export function FilePick({ children = 'Choose file', file, onFile, variant = 'secondary', busy }) {
  const input = useRef(null);
  return (
    <span className="st-pick">
      <input ref={input} type="file" accept={FILE_TYPES.join(',')} hidden onChange={(e) => { onFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
      <Button variant={variant} icon="topup" busy={busy} onClick={() => input.current?.click()}>{children}</Button>
      {file ? <span className="bx-small bx-muted">{file.name}</span> : null}
    </span>
  );
}

export function ScanLink({ path, children = 'Open file' }) {
  if (!path) return null;
  return (
    <button type="button" className="st-link" onClick={() => openScan(path)}>
      <Icon name="download" /> {children}
    </button>
  );
}

// A code shown once: the person it is for reads it now or it is gone.
export function OneTimeCode({ code, children }) {
  return (
    <div className="ow-qr">
      <span className="ow-code">{code}</span>
      <p className="bx-small bx-muted" style={{ margin: 0 }}>{children}</p>
      <Button variant="secondary" icon="statement" onClick={() => navigator.clipboard?.writeText(code)}>Copy</Button>
    </div>
  );
}
