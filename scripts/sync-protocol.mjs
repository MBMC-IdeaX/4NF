// The Edge Function runs on Deno and cannot import from outside its own tree,
// so the protocol core is copied in before deploy. protocol/ stays the single
// source of truth; supabase/functions/_shared/protocol is generated, never edited.
//
// Bare specifiers are rewritten to npm: specifiers on the way in. Relying on an
// import map instead means the deploy bundler has to find it, and when it does
// not the failure is a bundle error at deploy time rather than anything local.

import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NPM_PINS = {
  tweetnacl: 'npm:tweetnacl@1.0.3',
};

const from = fileURLToPath(new URL('../protocol/', import.meta.url));
const to = fileURLToPath(new URL('../supabase/functions/_shared/protocol/', import.meta.url));

await rm(to, { recursive: true, force: true });
await mkdir(to, { recursive: true });

let rewrites = 0;
for (const name of await readdir(from)) {
  if (!name.endsWith('.mjs')) continue;
  let source = await readFile(join(from, name), 'utf8');
  for (const [bare, pinned] of Object.entries(NPM_PINS)) {
    const before = source;
    // Literal replace rather than a regex: both quote styles, no escaping to
    // get wrong, and it fails loudly below if a specifier is ever missed.
    source = source.split(`from '${bare}'`).join(`from '${pinned}'`);
    source = source.split(`from "${bare}"`).join(`from "${pinned}"`);
    if (source !== before) rewrites += 1;
  }
  await writeFile(join(to, name), source);
}

await writeFile(
  join(to, 'README.md'),
  '# Generated\n\nCopied from `protocol/` by `npm run sync:protocol`, with bare npm\nspecifiers pinned for Deno. Do not edit here.\n',
);
console.log(`protocol copied into supabase/functions/_shared/protocol (${rewrites} imports pinned)`);
