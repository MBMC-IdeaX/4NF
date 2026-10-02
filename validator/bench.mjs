// The validator on a laptop, with no hardware at all.
//
//   npm run validator:bench
//
// Codes are pasted into this terminal instead of scanned, the screen is written
// to .bench/validator/screen.png (open it in an image viewer that reloads), the
// odometer drives itself around a simulated route and the clock is the
// laptop's own. Pair it first by pasting a pairing code:
//
//   node validator/tools/codes.mjs pair     — prints a pairing code for a bench bus
//   node validator/tools/codes.mjs ride     — prints a fresh BT1 for a bench rider
//
// Any of the settings can still be overridden, so a real scanner on a Linux
// laptop is BHADA_SCANNER=/dev/ttyACM0 npm run validator:bench.

import path from 'node:path';

const defaults = {
  BHADA_DATA_DIR: path.resolve('.bench', 'validator'),
  BHADA_RTC: 'trust-system',
  BHADA_SCANNER: 'stdin',
  BHADA_PN532: 'none',
  BHADA_RS485: 'none',
  BHADA_DISPLAY: `png:${path.resolve('.bench', 'validator')}`,
  BHADA_GPIO: 'none',
  BHADA_ODOMETER: 'simulated',
  BHADA_FEED_SENSE: 'none',
};
for (const [name, value] of Object.entries(defaults)) {
  if (process.env[name] === undefined) process.env[name] = value;
}

await import('./main.mjs');
