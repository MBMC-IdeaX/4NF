// Talking to the payments function. The passenger's own access token is the
// bearer; the function asks Supabase Auth who it belongs to.

const BASE = import.meta.env.VITE_SUPABASE_URL ?? '';
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';
const PENDING = 'bhada.pendingTopup';

async function post(body, accessToken) {
  try {
    const response = await fetch(`${BASE}/functions/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: ANON,
        Authorization: `Bearer ${accessToken ?? ANON}`,
      },
      body: JSON.stringify(body),
    });
    return await response.json();
  } catch {
    return { ok: false, reason: 'gateway_error' };
  }
}

export const gatewayConfig = () => post({ action: 'config' });

// Opens the gateway's own page. Resolves only on failure; on success the
// browser has left for eSewa.
export async function startGatewayTopup({ method, amount, accessToken }) {
  const started = await post({ action: 'start', method, amount }, accessToken);
  if (!started?.ok) return started;
  try {
    localStorage.setItem(PENDING, JSON.stringify({ method, reference: started.reference, amount }));
  } catch {
    // Without storage a cancelled eSewa payment just stays initiated until it expires.
  }
  // eSewa takes a signed form POST, not a link.
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = started.formUrl;
  for (const [name, value] of Object.entries(started.fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  return { ok: true, redirecting: true };
}

export function pendingTopup() {
  try {
    return JSON.parse(localStorage.getItem(PENDING) ?? 'null');
  } catch {
    return null;
  }
}

export function clearPendingTopup() {
  try {
    localStorage.removeItem(PENDING);
  } catch {
    // Nothing to clear.
  }
}

/*
  The passenger has come back from a gateway. Work out which, finish it, and
  report. Returns null when this page load is not a gateway return.
*/
export async function finishGatewayReturn({ accessToken }) {
  const { pathname, search } = window.location;
  const params = new URLSearchParams(search);
  const pending = pendingTopup();

  if (pathname.endsWith('/account/esewa') && params.get('data')) {
    const result = await post({ action: 'confirm', method: 'esewa', data: params.get('data') }, accessToken);
    clearPendingTopup();
    return { method: 'esewa', ...result };
  }
  if (pathname.endsWith('/account/esewa-failed')) {
    if (pending?.method === 'esewa') {
      await post({ action: 'cancel', method: 'esewa', reference: pending.reference }, accessToken);
    }
    clearPendingTopup();
    return { method: 'esewa', ok: false, reason: 'not_complete' };
  }
  return null;
}
