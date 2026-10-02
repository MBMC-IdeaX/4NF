// The signed-in user, for any portal. `undefined` while checking.

import { useEffect, useState } from 'react';
import { supabase, supabaseConfigured } from '../../lib/supabase';

const SESSION_WAIT_MS = 8000;

export function useSession() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    if (!supabaseConfigured) {
      setSession(null);
      return undefined;
    }
    // A stored session past its expiry makes getSession() refresh it first, and
    // supabase-js retries a refresh that cannot reach the server for as long as
    // the page is open. On a weak signal that left the portal on its loader with
    // no way out. After SESSION_WAIT_MS the sign-in form shows instead; if the
    // refresh lands later, onAuthStateChange carries the session in anyway.
    const giveUp = setTimeout(() => setSession((now) => (now === undefined ? null : now)), SESSION_WAIT_MS);
    supabase.auth.getSession().then(({ data }) => {
      clearTimeout(giveUp);
      setSession(data.session ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => {
      clearTimeout(giveUp);
      sub.subscription.unsubscribe();
    };
  }, []);

  return session;
}

export async function signOut() {
  await supabase.auth.signOut();
}

// A Supabase RPC that returns our { ok, reason } shapes, with transport errors
// folded into the same shape so screens handle one thing.
export async function call(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) return { ok: false, reason: 'server_error', message: error.message };
  return data;
}
