// Reads the real tokens.css and checks every text colour against the grounds
// it sits on, in light and in dark. Body text 4.5:1, accent on its own ground
// 4.5:1, white on accent 4.5:1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');

function block(selectorStart) {
  const at = css.indexOf(selectorStart);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(open + 1, i); }
  }
  throw new Error(`no block ${selectorStart}`);
}

function vars(text) {
  const out = {};
  for (const [, name, value] of text.matchAll(/--b-([\w-]+):\s*(#[0-9a-f]{6})/gi)) out[name] = value;
  return out;
}

const light = vars(block(':root {'));
const dark = { ...light, ...vars(block(":root[data-theme='dark']")) };

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const PAIRS = [
  ['ink', 'ground'], ['ink', 'surface'], ['ink-2', 'ground'], ['ink-2', 'surface-2'],
  ['ink-3', 'ground'], ['ink-3', 'surface'], ['ink-3', 'surface-2'],
  ['accent', 'surface'], ['accent', 'ground'], ['accent', 'accent-soft'], ['on-accent', 'accent'],
  ['in', 'surface'], ['in', 'in-soft'], ['warn', 'warn-soft'], ['bad', 'bad-soft'], ['bad', 'surface'],
];

for (const [theme, palette] of [['light', light], ['dark', dark]]) {
  for (const [fg, bg] of PAIRS) {
    test(`${theme}: ${fg} on ${bg} ≥ 4.5`, () => {
      const r = ratio(palette[fg], palette[bg]);
      assert.ok(r >= 4.5, `${palette[fg]} on ${palette[bg]} is ${r.toFixed(2)}:1`);
    });
  }
}
