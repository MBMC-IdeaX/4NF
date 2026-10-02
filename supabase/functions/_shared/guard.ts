// What both functions do to a request before they read it.
//
// A body cap: request.json() would otherwise read whatever arrives. The largest
// honest sync is MAX_BATCH (500) signed items at well under 1 KB each, so 1 MB
// leaves room without letting a stranger make the function buffer megabytes.
//
// A request limit per client address. It lives in the isolate's memory, so it
// is per instance and resets when the instance is recycled. Measured on the
// live project on 27 Sep 2026: 75 requests from one address in a burst were all
// served, because Supabase spread them across instances. Treat it as a guard
// against one instance being pinned, not as rate limiting; a real limit needs a
// shared counter (Postgres or a KV store). Every write still goes through
// signature checks and once-only rules in Postgres, so no limit here protects
// money — only CPU and the bill.
//
// CORS stays open ('*') on purpose. Neither function trusts an ambient
// credential: sync trusts signatures inside the body, payments a bearer token
// the page must hold. A foreign origin gains nothing it could not do with curl,
// and a pinned origin would break sync the day the site gains a domain.

export const MAX_BODY_BYTES = 1_000_000;

export class TooLarge extends Error {}

export async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new TooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('empty body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

const hits = new Map<string, { windowStart: number; count: number }>();

// True when this client has used up its allowance for the current minute.
export function overLimit(request: Request, perMinute: number, now = Date.now()): boolean {
  const client = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const minute = Math.floor(now / 60_000);
  const entry = hits.get(client);
  if (!entry || entry.windowStart !== minute) {
    hits.set(client, { windowStart: minute, count: 1 });
    if (hits.size > 10_000) {
      for (const [key, value] of hits) if (value.windowStart !== minute) hits.delete(key);
    }
    return false;
  }
  entry.count += 1;
  return entry.count > perMinute;
}
