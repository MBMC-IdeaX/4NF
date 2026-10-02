// Sending a crash somewhere a person will read it.
//
// This runs on every surface, including the offline ones, so it does not
// import the Supabase client: one fetch to the report_client_error RPC is all
// it needs. A report that cannot be sent waits in localStorage and goes with
// the next page load or the next time the radio comes back. It never throws
// and never retries in a loop; losing a report is better than a phone that
// spends its battery on one.

const URL_BASE = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const QUEUE = 'bhada.errors';
const MAX_QUEUED = 20;

const sent = new Set();

function surfaceOf(path) {
  const first = path.split('/')[1] || 'site';
  return path.startsWith('/app/account') ? 'account' : first;
}

function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE) || '[]');
  } catch {
    return [];
  }
}

function writeQueue(items) {
  try {
    localStorage.setItem(QUEUE, JSON.stringify(items.slice(-MAX_QUEUED)));
  } catch {
    // Storage full or blocked: the report is lost, which is acceptable.
  }
}

// True when the report is done with, sent or refused for good.
async function post(report) {
  const response = await fetch(`${URL_BASE}/rest/v1/rpc/report_client_error`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
    keepalive: true,
  });
  // Worth sending again: not deployed yet, rate-limited, or the server was
  // down. Anything else the server read and refused, so it is dropped.
  return !(response.status === 404 || response.status === 429 || response.status >= 500);
}

export async function flushReports() {
  if (!URL_BASE || !KEY || !navigator.onLine) return;
  const queued = readQueue();
  if (!queued.length) return;
  writeQueue([]);
  const kept = [];
  for (const report of queued) {
    try {
      if (!(await post(report))) kept.push(report);
    } catch {
      kept.push(report);
    }
  }
  if (kept.length) writeQueue([...readQueue(), ...kept]);
}

export function reportError(error, where) {
  const message = String(error?.message ?? error ?? 'Unknown error').slice(0, 500);
  // One report per distinct message per page load: a render loop that throws
  // on every frame must not become sixty rows.
  if (sent.has(message)) return;
  sent.add(message);

  const path = window.location.pathname;
  const report = {
    p_surface: where ?? surfaceOf(path),
    p_message: message,
    p_stack: String(error?.stack ?? '').slice(0, 4000) || null,
    p_path: path + window.location.search,
    p_build: __BHADA_BUILD__,
    p_user_agent: navigator.userAgent,
  };
  writeQueue([...readQueue(), report]);
  flushReports();
}

export function watchErrors() {
  window.addEventListener('error', (event) => reportError(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => reportError(event.reason));
  window.addEventListener('online', () => flushReports());
  flushReports();
}
