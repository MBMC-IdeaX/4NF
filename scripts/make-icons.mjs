// Render the app icons. Chrome on Android refuses to offer "install" without a
// 192px and a 512px icon, and without install there is no offline cold start —
// which is the whole point of the product.
//
// The mark is a Nepali commercial number plate: white भा on plate red.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const FONT = join(PUBLIC, 'fonts', 'khand-700-devanagari.woff2');

const base64Font = (await readFile(FONT)).toString('base64');

function plate(size, { maskable }) {
  // A maskable icon is cropped to a circle by the launcher, so its mark has to
  // sit inside the safe zone rather than filling the square.
  const inset = maskable ? size * 0.14 : 0;
  const box = size - inset * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <style>
      @font-face { font-family: 'Khand'; font-weight: 700; src: url(data:font/woff2;base64,${base64Font}) format('woff2'); }
    </style>
  </defs>
  <rect width="${size}" height="${size}" fill="#a8202f"/>
  <rect x="${inset + box * 0.06}" y="${inset + box * 0.06}" width="${box * 0.88}" height="${box * 0.88}"
        fill="none" stroke="#ffffff" stroke-width="${box * 0.045}"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
        font-family="Khand" font-weight="700" font-size="${box * 0.62}" fill="#ffffff"
        dy="${box * 0.04}">भा</text>
</svg>`;
}

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
  { file: 'favicon.png', size: 64, maskable: false },
];

for (const target of targets) {
  const svg = plate(target.size, { maskable: target.maskable });
  await sharp(Buffer.from(svg), { density: 300 }).png().toFile(join(PUBLIC, target.file));
  console.log(`wrote ${target.file} (${target.size}px)`);
}

await writeFile(join(PUBLIC, 'icon.svg'), plate(512, { maskable: false }));
console.log('wrote icon.svg');
