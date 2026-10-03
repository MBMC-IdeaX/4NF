// Plain-HTTP static server for local verification. localhost is a secure context,
// so the camera works without a certificate. Hosting uses HTTPS.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
// The headers production sends on every path, read from vercel.json so a CSP
// that would break a screen breaks it here first.
const vercel = JSON.parse(await readFile(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8'));
// Every rule whose source matches, in order, a later one overriding an earlier
// one for the same header — so /demo gets its own policy here as it does there.
const RULES = vercel.headers.map((rule) => ({
  // Vercel sources are path patterns: '(.*)' is a regex group already, and a
  // literal dot is the only character here that needs escaping.
  pattern: new RegExp(`^${rule.source.split('(.*)').map((part) => part.replace(/\\?\./g, '\\.')).join('(.*)')}$`),
  headers: rule.headers,
}));
function headersFor(path) {
  const out = {};
  for (const rule of RULES) {
    if (rule.pattern.test(path)) for (const { key, value } of rule.headers) out[key] = value;
  }
  return out;
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };

createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const target = join(ROOT, normalize(path.endsWith('/') ? `${path}index.html` : path));
  try {
    const body = await readFile(target);
    response.writeHead(200, { ...headersFor(path), 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    // The same routing vercel.json does: legacy links move, and each app's
    // paths fall back to that app's own page.
    const moved = vercel.redirects?.find((rule) => new RegExp(`^${rule.source.replace('/:path*', '(/.*)?')}$`).test(path));
    if (moved) {
      response.writeHead(307, { Location: moved.destination + new URL(request.url, 'http://localhost').search });
      response.end();
      return;
    }
    const app = /^\/(app|crew|owner)(\/|$)/.exec(path)?.[1];
    response.writeHead(200, { ...headersFor(path), 'Content-Type': 'text/html' });
    response.end(await readFile(join(ROOT, app ? `${app}/index.html` : 'index.html')));
  }
}).listen(4173, () => console.log('serving dist on http://localhost:4173'));
