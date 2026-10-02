// Running the phone's door terminal on a Raspberry Pi, unchanged.
//
// `src/device/terminal.js` is the door. It decides board or alight, spends the
// nonce, refuses a full bus at the boarding door and never at the exit, signs
// the BO1 pass and the BM1 receipt, and keeps the passenger's BT1 tap beside the
// ride so the backend can settle it. Every line of that was proved against the
// phones. Copying it into a Pi program would give the bus two doors that can
// disagree, so the Pi runs the same file.
//
// What the file cannot have on a Pi is a browser. It reaches for one through
// four imports — IndexedDB, the vehicle bus carrier, Web NFC and the browser's
// positioning helpers — and this hook swaps exactly those four for the Pi's
// hardware adapters in validator/adapters/. Nothing it imports from protocol/
// is touched.
//
// It also does the two things Vite does for the browser build and Node does not:
// resolve the extensionless relative imports `src/` is written with, and replace
// `import.meta.env` with the validator's own configuration.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = path.join(ROOT, 'src');
const ADAPTERS = path.join(ROOT, 'validator', 'adapters');

// Browser module → Pi adapter. Keyed by the file the import resolves to, so it
// holds whatever relative path a module in src/ happens to use.
export const SWAPS = {
  [path.join(SRC, 'storage', 'db.js')]: path.join(ADAPTERS, 'store.mjs'),
  [path.join(SRC, 'device', 'link.js')]: path.join(ADAPTERS, 'link.mjs'),
  [path.join(SRC, 'device', 'nfc.js')]: path.join(ADAPTERS, 'nfc.mjs'),
  [path.join(SRC, 'device', 'positioning.js')]: path.join(ADAPTERS, 'positioning.mjs'),
};

function inside(dir, file) {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function resolve(specifier, context, next) {
  const parent = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : null;
  if (!parent || !specifier.startsWith('.')) return next(specifier, context);

  let target = path.resolve(path.dirname(parent), specifier);
  if (!existsSync(target) && existsSync(`${target}.js`)) target = `${target}.js`;

  // An adapter may import the module it stands in for — the pure helpers in it
  // are still the right ones. Only imports from src/ are redirected.
  const swap = SWAPS[target];
  if (swap && inside(SRC, parent)) return { url: pathToFileURL(swap).href, shortCircuit: true };

  if (target !== path.resolve(path.dirname(parent), specifier)) {
    return { url: pathToFileURL(target).href, shortCircuit: true, format: 'module' };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  // Only src/ is ours. Everything else — tweetnacl is CommonJS — loads as Node
  // would load it without this hook.
  if (!url.startsWith('file:') || !inside(SRC, fileURLToPath(url))) return next(url, context);
  const result = await next(url, { ...context, format: 'module' });
  const source = String(result.source ?? '');
  if (!source.includes('import.meta.env')) return { ...result, format: 'module' };
  return {
    ...result,
    format: 'module',
    source: source.replaceAll('import.meta.env', '(globalThis.__BHADA_ENV__ ?? {})'),
  };
}
