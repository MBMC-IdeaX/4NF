// The Supabase client, pointed at the local backend (scripts/lib/local-supabase.mjs).
//
// Swapped in for lib/supabase.js by vite.config.js only when BHADA_LOCAL_DB=1,
// so the Owner, admin and review screens can be driven end to end against a
// database with every migration applied, as real logins with real row-level
// security. It covers the calls those screens make and no more; a deployed
// build never contains it.

const BASE = (import.meta.env.VITE_LOCAL_DB_URL || 'http://localhost:8787').replace(/\/$/, '');
const KEY = 'bhada.local.session';

export const supabaseConfigured = true;

let session = (() => {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? null; } catch { return null; }
})();
const listeners = new Set();

function setSession(next, event) {
  session = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch { /* private mode: the session lasts the tab */ }
  for (const listener of listeners) listener(event, next);
}

async function post(path, body, { raw, contentType } = {}) {
  const headers = { 'Content-Type': contentType ?? 'application/json' };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  try {
    const response = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: raw ?? JSON.stringify(body ?? {}) });
    return await response.json();
  } catch (error) {
    return { error: { message: `Local backend unreachable at ${BASE}: ${error.message}` } };
  }
}

class Query {
  constructor(table) {
    this.spec = { table, filters: [], order: [] };
  }
  select() { return this; }
  eq(col, val) { this.spec.filters.push({ col, op: 'eq', val }); return this; }
  neq(col, val) { this.spec.filters.push({ col, op: 'neq', val }); return this; }
  gt(col, val) { this.spec.filters.push({ col, op: 'gt', val }); return this; }
  gte(col, val) { this.spec.filters.push({ col, op: 'gte', val }); return this; }
  lt(col, val) { this.spec.filters.push({ col, op: 'lt', val }); return this; }
  lte(col, val) { this.spec.filters.push({ col, op: 'lte', val }); return this; }
  order(col, options = {}) { this.spec.order.push({ col, asc: options.ascending !== false }); return this; }
  limit(n) { this.spec.limit = n; return this; }
  then(resolve, reject) { return post('/local/select', this.spec).then(resolve, reject); }
  insert() { return Promise.resolve({ error: { message: 'Direct writes are closed; use the owner_* functions.' } }); }
}

const auth = {
  async getSession() { return { data: { session } }; },
  onAuthStateChange(listener) {
    listeners.add(listener);
    return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
  },
  async signInWithPassword({ email, password }) {
    const answer = await post('/local/auth/signin', { email, password });
    if (answer.error) return { data: {}, error: answer.error };
    setSession(answer.data.session, 'SIGNED_IN');
    return { data: answer.data, error: null };
  },
  async signUp({ email, password }) {
    const answer = await post('/local/auth/signup', { email, password });
    if (answer.error) return { data: {}, error: answer.error };
    setSession(answer.data.session, 'SIGNED_IN');
    return { data: answer.data, error: null };
  },
  async signOut() { setSession(null, 'SIGNED_OUT'); return { error: null }; },
  async resetPasswordForEmail() { return { error: { message: 'Password reset is not available on the local backend.' } }; },
  async updateUser() { return { error: { message: 'Not available on the local backend.' } }; },
  async signInWithOtp() { return { error: { message: 'Phone sign-in is not switched on locally. Use email.' } }; },
  async verifyOtp() { return { error: { message: 'Phone sign-in is not switched on locally. Use email.' } }; },
};

const storage = {
  from(bucket) {
    return {
      async upload(path, file) {
        return post(`/local/storage/upload?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`, null,
          { raw: file, contentType: file?.type || 'application/octet-stream' });
      },
      async createSignedUrl(path) {
        return post('/local/storage/sign', { bucket, path });
      },
    };
  },
};

// No realtime locally: a channel that never connects, so callers fall back.
const quietChannel = {
  on() { return this; },
  subscribe(callback) { setTimeout(() => callback?.('CHANNEL_ERROR'), 0); return this; },
  send() { return Promise.resolve('error'); },
  unsubscribe() { return Promise.resolve('ok'); },
};

export const supabase = {
  auth,
  storage,
  from: (table) => new Query(table),
  rpc: (name, args) => post(`/local/rpc/${name}`, args ?? {}).then((r) => ({ data: r.data ?? null, error: r.error ?? null })),
  channel: () => quietChannel,
  removeChannel: () => Promise.resolve('ok'),
};
