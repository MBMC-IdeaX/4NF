// Getting a screen onto glass.
//
// On the bus: the ILI9341 through the kernel's fbtft driver, which gives a
// plain framebuffer at /dev/fb1, 320×240, 16 bits a pixel. Writing a frame is
// one write() of 153,600 bytes. On a laptop: the same frames as PNG files, so
// the screens can be looked at without the hardware.
//
// Drawing is coalesced. If three snapshots arrive while one frame is being
// rasterised, only the newest is drawn next — a screen that falls behind the
// door is worse than one that skips a frame.

import { openSync, writeSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { renderSvg, rasterise, toRgb565, toPng, WIDTH, HEIGHT } from './render.mjs';

export function createFramebuffer({ device = '/dev/fb1' } = {}) {
  const name = path.basename(device);
  try {
    const bits = Number(readFileSync(`/sys/class/graphics/${name}/bits_per_pixel`, 'utf8'));
    const [w, h] = readFileSync(`/sys/class/graphics/${name}/virtual_size`, 'utf8').trim().split(',').map(Number);
    if (bits !== 16 || w !== WIDTH || h !== HEIGHT) {
      throw new Error(`${device} is ${w}x${h} at ${bits} bpp; the validator draws ${WIDTH}x${HEIGHT} at 16 bpp. Check rotate= in config.txt.`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const fd = openSync(device, 'w');
  return {
    async draw(svg) {
      const frame = toRgb565(await rasterise(svg));
      writeSync(fd, frame, 0, frame.length, 0);
    },
  };
}

export function createPngSink({ dir }) {
  mkdirSync(dir, { recursive: true });
  return {
    async draw(svg, model) {
      const png = await toPng(svg);
      writeFileSync(path.join(dir, 'screen.png'), png);
      if (model?.kind) writeFileSync(path.join(dir, `screen-${model.kind}.png`), png);
    },
  };
}

export function createNullSink() {
  return { async draw() {} };
}

export function createDisplay({ sink, onError }) {
  let drawing = false;
  let next = null;
  let lastKey = null;

  async function pump() {
    if (drawing) return;
    drawing = true;
    while (next) {
      const model = next;
      next = null;
      const svg = renderSvg(model);
      // The same picture twice is not worth a 150 KB write to the panel.
      if (svg === lastKey) continue;
      try {
        await sink.draw(svg, model);
        lastKey = svg;
      } catch (error) {
        onError?.(error);
      }
    }
    drawing = false;
  }

  return {
    show(model) {
      next = model;
      pump();
    },
  };
}
