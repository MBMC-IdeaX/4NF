// Drawing a screen model on a 320×240 ILI9341.
//
// The door terminal's instrument register, at the size of a playing card: a
// near-black panel, readout cream, and a verdict that fills the glass in one
// colour so it can be read from the back of the queue — green, red, amber. No
// gradients, no rounded corners. The panel is backlit, which is why the resting
// state is dark: a white screen at a dark bus stop blinds the person in front
// of it.
//
// A screen is built as SVG and rasterised with sharp, then packed to RGB565 for
// the framebuffer. The QR code is drawn on whole pixels with crisp edges, three
// pixels a module, because a phone camera reading a 2.8-inch panel at arm's
// length has nothing to spare. The proof decodes every QR this file draws.

import QRCode from 'qrcode';

export const WIDTH = 320;
export const HEIGHT = 240;

const C = {
  panel: '#0f0e0c',
  read: '#ece7d8',
  dim: '#8f8a7c',
  rule: '#3a3731',
  live: '#6fbf73',
  caution: '#e0a437',
  halt: '#d7514b',
  plate: '#a8202f',
  white: '#ffffff',
  ink: '#16130f',
};

const TONES = {
  good: { bg: C.live, fg: C.ink },
  bad: { bg: C.halt, fg: C.ink },
  held: { bg: C.caution, fg: C.ink },
  fault: { bg: C.panel, fg: C.halt },
  busy: { bg: C.panel, fg: C.read },
  idle: { bg: C.panel, fg: C.read },
};

const FONT = "Khand, 'DejaVu Sans Condensed', 'DejaVu Sans', 'Noto Sans Devanagari', 'Nirmala UI', Arial, sans-serif";
const BODY = "Mukta, 'DejaVu Sans', 'Noto Sans Devanagari', 'Nirmala UI', Arial, sans-serif";

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function text(x, y, value, { size = 16, weight = 400, fill = C.read, anchor = 'start', family = BODY } = {}) {
  return `<text x="${x}" y="${y}" font-family="${esc(family)}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(value)}</text>`;
}

/*
  A QR code as whole-pixel squares.

  The module size is the largest whole number of pixels that fits `box` with a
  two-module quiet zone. Error correction follows the phone door: M for a pass,
  L for a receipt, so both screens encode the same symbols.
*/
export function qrLayout(value, { box, level = 'M' }) {
  const qr = QRCode.create(value, { errorCorrectionLevel: level });
  const size = qr.modules.size;
  const quiet = 2;
  const scale = Math.floor(box / (size + quiet * 2));
  return { qr, size, quiet, scale, side: (size + quiet * 2) * scale, version: qr.version };
}

function qrSvg(value, { x, y, box, level }) {
  const { qr, size, quiet, scale, side } = qrLayout(value, { box, level });
  if (scale < 2) return { svg: text(x + box / 2, y + box / 2, 'CODE TOO LONG', { anchor: 'middle', fill: C.halt }), side: box, scale };
  let path = '';
  for (let row = 0; row < size; row += 1) {
    let run = -1;
    for (let col = 0; col <= size; col += 1) {
      const dark = col < size && qr.modules.get(row, col);
      if (dark && run < 0) run = col;
      if (!dark && run >= 0) {
        path += `M${x + (quiet + run) * scale} ${y + (quiet + row) * scale}h${(col - run) * scale}v${scale}h${-(col - run) * scale}z`;
        run = -1;
      }
    }
  }
  const svg = `<rect x="${x}" y="${y}" width="${side}" height="${side}" fill="${C.white}"/><path d="${path}" fill="#000000" shape-rendering="crispEdges"/>`;
  return { svg, side, scale };
}

function statusBar(model, fg) {
  const left = `${model.doorId || '?'} · ${model.vehicleId || '—'}`;
  const bits = [];
  if (model.aboard) bits.push(model.aboard);
  if (model.odometer) bits.push(model.odometer);
  bits.push(model.online ? 'ONLINE' : 'OFFLINE');
  return [
    text(10, 230, left, { size: 12, fill: fg, weight: 600 }),
    text(310, 230, bits.join(' · '), { size: 12, fill: fg, anchor: 'end', weight: 600 }),
  ].join('');
}

// Words to lines, by an average glyph width. Good enough for the short,
// fixed sentences these screens say; nothing here wraps user text.
export function wrap(value, { size, width }) {
  const perLine = Math.max(8, Math.floor(width / (size * 0.52)));
  const lines = [];
  let line = '';
  for (const word of String(value ?? '').split(/\s+/).filter(Boolean)) {
    if (line && (line.length + 1 + word.length) > perLine) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// The tick and the cross are drawn, not typed: a font on the Pi that lacks
// U+2713 would otherwise print a box where the verdict should be.
function icon(kind, cx, cy, size, fill) {
  const h = size / 2;
  const stroke = Math.max(4, Math.round(size / 7));
  if (kind === 'tick') {
    return `<path d="M${cx - h} ${cy} L${cx - h / 3} ${cy + h * 0.7} L${cx + h} ${cy - h * 0.7}" fill="none" stroke="${fill}" stroke-width="${stroke}" stroke-linecap="square" stroke-linejoin="miter"/>`;
  }
  if (kind === 'cross') {
    return `<path d="M${cx - h * 0.8} ${cy - h * 0.8} L${cx + h * 0.8} ${cy + h * 0.8} M${cx + h * 0.8} ${cy - h * 0.8} L${cx - h * 0.8} ${cy + h * 0.8}" fill="none" stroke="${fill}" stroke-width="${stroke}" stroke-linecap="square"/>`;
  }
  return '';
}

function splitTitle(title) {
  const value = String(title ?? '');
  if (value.startsWith('✓')) return { mark: 'tick', words: value.slice(1).trim() };
  if (value.startsWith('✕')) return { mark: 'cross', words: value.slice(1).trim() };
  return { mark: null, words: value };
}

export function renderSvg(model) {
  const tone = TONES[model.tone] ?? TONES.idle;
  const parts = [`<rect width="${WIDTH}" height="${HEIGHT}" fill="${tone.bg}"/>`];

  if (model.qr) {
    // Verdict band on the right, code on the left where the phone goes.
    const box = 228;
    const level = model.kind === 'out' ? 'L' : 'M';
    const code = qrSvg(model.qr, { x: 6, y: 6, box, level });
    parts.push(code.svg);
    const cx = 6 + code.side + (WIDTH - 6 - code.side) / 2;
    parts.push(icon('tick', cx, 30, 34, tone.fg));
    parts.push(text(cx, 74, splitTitle(model.title).words, { size: 22, weight: 700, fill: tone.fg, anchor: 'middle', family: FONT }));
    parts.push(`<rect x="${cx - 30}" y="84" width="60" height="2" fill="${tone.fg}"/>`);
    if (model.fare) {
      parts.push(text(cx, 118, model.fare, { size: 26, weight: 700, fill: tone.fg, anchor: 'middle', family: FONT }));
      parts.push(text(cx, 140, model.lines[0] ?? '', { size: 14, weight: 600, fill: tone.fg, anchor: 'middle' }));
      parts.push(text(cx, 157, model.lines[1] ?? '', { size: 11, weight: 600, fill: tone.fg, anchor: 'middle' }));
    } else {
      parts.push(text(cx, 120, 'IN', { size: 34, weight: 700, fill: tone.fg, anchor: 'middle', family: FONT }));
      parts.push(text(cx, 142, 'no fare yet', { size: 12, weight: 600, fill: tone.fg, anchor: 'middle' }));
    }
    const words = String(model.qrLabel ?? '').split(' ');
    const half = Math.ceil(words.length / 2);
    parts.push(text(cx, 196, words.slice(0, half).join(' '), { size: 12, weight: 600, fill: tone.fg, anchor: 'middle' }));
    parts.push(text(cx, 212, words.slice(half).join(' '), { size: 12, weight: 600, fill: tone.fg, anchor: 'middle' }));
    return svgDocument(parts);
  }

  if (model.kind === 'idle' || model.kind === 'held-idle') {
    parts.push(`<rect x="0" y="0" width="${WIDTH}" height="6" fill="${model.kind === 'held-idle' ? C.caution : C.plate}"/>`);
    parts.push(text(160, 78, model.title, { size: 44, weight: 700, anchor: 'middle', family: FONT, fill: C.read }));
    const main = model.lines[0] ?? '';
    parts.push(text(160, 134, main, { size: model.kind === 'held-idle' ? 34 : 24, weight: 700, anchor: 'middle', family: FONT, fill: model.kind === 'held-idle' ? C.caution : C.read }));
    if (model.lines[1]) parts.push(text(160, 162, model.lines[1], { size: 15, weight: 600, anchor: 'middle', fill: C.read }));
    if (model.offline) parts.push(text(160, 192, 'Offline — rides are still checked here', { size: 13, anchor: 'middle', fill: C.dim }));
    parts.push(`<rect x="10" y="210" width="300" height="1" fill="${C.rule}"/>`);
    parts.push(statusBar(model, C.dim));
    return svgDocument(parts);
  }

  // Full-glass verdicts and faults.
  const fg = tone.fg;
  if (model.tone === 'fault') parts.push(`<rect x="0" y="0" width="${WIDTH}" height="6" fill="${C.halt}"/>`);
  const { mark, words } = splitTitle(model.title);
  let y = 64;
  if (mark) {
    parts.push(icon(mark, 160, 36, 40, fg));
    y = 116;
  }
  const titleSize = words.length >= 11 ? 40 : words.length >= 9 ? 44 : 56;
  parts.push(text(160, y + (mark ? 0 : 30), words, { size: titleSize, weight: 700, anchor: 'middle', family: FONT, fill: fg }));
  let lineY = y + (mark ? 34 : 66);
  model.lines.forEach((line, index) => {
    const size = index === 0 ? 18 : 14;
    for (const part of wrap(line, { size, width: 290 }).slice(0, 2)) {
      parts.push(text(160, lineY, part, { size, weight: 600, anchor: 'middle', fill: fg }));
      lineY += size + 6;
    }
  });
  parts.push(`<rect x="10" y="210" width="300" height="1" fill="${model.tone === 'fault' || model.tone === 'busy' ? C.rule : fg}" opacity="0.4"/>`);
  parts.push(statusBar(model, fg));
  return svgDocument(parts);
}

function svgDocument(parts) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${parts.join('')}</svg>`;
}

// sharp is loaded on first use: it is the one heavy dependency, and a proof
// that only checks screen models should not need it.
let sharpModule = null;
async function sharp() {
  if (!sharpModule) sharpModule = (await import('sharp')).default;
  return sharpModule;
}

export async function rasterise(svg) {
  const s = await sharp();
  const { data, info } = await s(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgb: data, width: info.width, height: info.height };
}

export async function toPng(svg) {
  const s = await sharp();
  return s(Buffer.from(svg)).png().toBuffer();
}

// RGB888 → RGB565, little-endian, which is what fbtft's ili9341 framebuffer
// takes at 16 bits per pixel.
export function toRgb565({ rgb, width, height }) {
  const out = Buffer.alloc(width * height * 2);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o += 2) {
    const value = ((rgb[i] & 0xf8) << 8) | ((rgb[i + 1] & 0xfc) << 3) | (rgb[i + 2] >> 3);
    out[o] = value & 0xff;
    out[o + 1] = value >> 8;
  }
  return out;
}
