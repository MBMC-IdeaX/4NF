import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openBackend, handleSync } from '../../scripts/lib/pg-backend.mjs';
import { handleLocalSupabase, prepareLocalAuth } from '../../scripts/lib/local-supabase.mjs';
import { useRandomSource } from '../../protocol/random.mjs';
useRandomSource((n) => new Uint8Array(randomBytes(n)));
const { db } = await openBackend();
await prepareLocalAuth(db);
const server = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const json = () => JSON.parse(body || '{}');
    const url = new URL(request.url, 'http://localhost:8890');
    const answer = url.pathname === '/sync' ? await handleSync(db, json())
      : url.pathname === '/health' ? [200, { ok: true, local: true }]
      : await handleLocalSupabase(db, { method: request.method, pathname: url.pathname, search: url.search, headers: request.headers, readJson: async () => json(), readBuffer: async () => Buffer.from(body) });
    response.writeHead(answer?.[0] ?? 404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(answer?.[1] ?? {}));
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
});
server.listen(8890, 'localhost');
const stop = () => server.close(async () => { await db.close(); process.exit(0); });
process.on('SIGINT', stop); process.on('SIGTERM', stop);
