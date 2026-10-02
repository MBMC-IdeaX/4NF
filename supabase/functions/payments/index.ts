// POST /functions/v1/payments
//
// Wallet top-ups through eSewa. The browser carries messages; this
// function decides. A payment is credited only after the gateway's signature
// checks out and eSewa itself, asked directly, says the payment
// for exactly this request and exactly this amount is complete. The money is
// moved by gateway_complete_topup() in Postgres, which credits once.
//
// Actions, each with the passenger's access token as the bearer:
//   { action: 'config' }                              -> which gateways are on
//   { action: 'start', method: 'esewa', amount }      -> the signed eSewa form
//   { action: 'confirm', method: 'esewa', data }      -> eSewa's success payload
//   { action: 'cancel', method, reference }
//
// Environment:
//   SITE_URL             where the gateways send the passenger back
//   ESEWA_ENV            'test' (default) or 'live'
//   ESEWA_PRODUCT_CODE, ESEWA_SECRET_KEY   required for live; test uses eSewa's published pair

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  ESEWA, esewaForm, readEsewaReturn, esewaSettled,
} from '../_shared/protocol/gateway.mjs';
import { readJson, overLimit, TooLarge } from '../_shared/guard.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, 'Content-Type': 'application/json' },
});

const SITE = (Deno.env.get('SITE_URL') ?? 'https://bhada-one.vercel.app').replace(/\/$/, '');

const esewaEnv = Deno.env.get('ESEWA_ENV') === 'live' ? 'live' : 'test';
const esewa = {
  ...(esewaEnv === 'live' ? ESEWA.live : ESEWA.test),
  productCode: Deno.env.get('ESEWA_PRODUCT_CODE') ?? (esewaEnv === 'test' ? ESEWA.test.productCode : ''),
  secretKey: Deno.env.get('ESEWA_SECRET_KEY') ?? (esewaEnv === 'test' ? ESEWA.test.secretKey : ''),
};
const esewaOn = Boolean(esewa.productCode && esewa.secretKey);


async function hmac(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  // deno-lint-ignore no-explicit-any
  let body: any;
  if (overLimit(request, 60)) return json({ error: 'Too many requests. Try again in a minute.' }, 429);

  try {
    body = await readJson(request);
  } catch (problem) {
    if (problem instanceof TooLarge) return json({ error: 'Body too large.' }, 413);
    return json({ error: 'Body must be JSON.' }, 400);
  }

  if (body?.action === 'config') {
    return json({ esewa: esewaOn, esewaEnv });
  }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Who is asking, from their own access token, checked by Supabase Auth.
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = token ? await db.auth.getUser(token) : { data: { user: null } };
  const userId = auth?.user?.id;
  if (!userId) return json({ ok: false, reason: 'not_signed_in' }, 401);

  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  };

  try {
    if (body.action === 'start') {
      const method = String(body.method ?? '');
      const amount = Math.round(Number(body.amount));
      if (method === 'esewa' && !esewaOn) return json({ ok: false, reason: 'gateway_off' });
      if (method !== 'esewa') return json({ ok: false, reason: 'bad_method' });

      const opened = await rpc('gateway_open_topup', { p_user_id: userId, p_method: method, p_amount: amount });
      if (!opened?.ok) return json(opened);
      const back = `${SITE}/app/account`;

      if (method === 'esewa') {
        const fields = await esewaForm({
          amount,
          transactionUuid: opened.reference,
          productCode: esewa.productCode,
          secretKey: esewa.secretKey,
          // eSewa appends ?data=… itself, so these carry no query of their own.
          successUrl: `${back}/esewa`,
          failureUrl: `${back}/esewa-failed`,
          hmac,
        });
        return json({ ok: true, method, reference: opened.reference, formUrl: esewa.formUrl, fields });
      }

      return json({ ok: false, reason: 'bad_method' });
    }

    if (body.action === 'confirm' && body.method === 'esewa') {
      const read = await readEsewaReturn(body.data, { secretKey: esewa.secretKey, hmac });
      if (!read.ok) return json(read);
      const mine = await rpc('gateway_request_for', { p_user_id: userId, p_reference: read.transactionUuid });
      if (!mine?.id) return json({ ok: false, reason: 'not_found' });

      const url = `${esewa.statusUrl}?product_code=${encodeURIComponent(esewa.productCode)}`
        + `&total_amount=${mine.amount}&transaction_uuid=${encodeURIComponent(mine.reference)}`;
      const status = await (await fetch(url)).json().catch(() => null);
      const settled = esewaSettled(status, { transactionUuid: mine.reference, amount: mine.amount });
      if (!settled.ok) return json(settled);
      return json(await rpc('gateway_complete_topup', {
        p_reference: mine.reference, p_method: 'esewa', p_amount: mine.amount,
        p_provider_ref: read.providerRef || settled.providerRef,
      }));
    }

    if (body.action === 'cancel') {
      const mine = await rpc('gateway_request_for', { p_user_id: userId, p_reference: String(body.reference ?? '') });
      if (!mine?.id) return json({ ok: false, reason: 'not_found' });
      return json(await rpc('gateway_fail_topup', {
        p_reference: mine.reference, p_method: mine.method, p_reason: 'Payment not completed',
      }));
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (error) {
    return json({ ok: false, reason: 'server_error', message: (error as Error).message }, 500);
  }
});
