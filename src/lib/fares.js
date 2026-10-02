// The fare table.
//
// Regulated fares are public information and the backend holds the
// authoritative copy, but a phone must be able to price a journey with no
// network at all. So: bundled copy ships with the app, the live table is
// fetched opportunistically and cached, and the cached copy is what gets used.
//
// The bundled copy is a fallback of last resort, not the source of truth. A
// device that has never been online still prices correctly; a device that has
// been online prices from whatever the regulator last published.

import { db } from '../storage/db';
import { STOPS } from './nepali';

export const ROUTE_ID = 'R11';

/*
  Rs 15 minimum, Rs 5 per further stop, capped at Rs 25 end to end. Generated
  from the stop order rather than typed out, by the same rule as 0002_seed.sql,
  so the two cannot silently disagree.
*/
function bundledFares() {
  const table = {};
  for (let a = 0; a < STOPS.length; a += 1) {
    for (let b = a + 1; b < STOPS.length; b += 1) {
      table[`${STOPS[a].code}|${STOPS[b].code}`] = Math.min(25, 15 + (b - a - 1) * 5);
    }
  }
  return table;
}

const BUNDLED = bundledFares();

// Today's regulated stage fare between two stops, from the bundled table. The
// public site uses it to set the metered fare beside the one it replaces.
export function stageFare(boardingStop, alightingStop) {
  return BUNDLED[`${boardingStop}|${alightingStop}`] ?? null;
}

let cache = null;

export async function loadFareTable() {
  if (cache) return cache;
  const database = await db();
  const stored = await database.get('meta', 'fareTable');
  cache = stored?.table ?? BUNDLED;
  return cache;
}

/*
  Refresh from the backend when there is a network. Never blocks a payment:
  if this fails for any reason the cached or bundled table stays in use.
*/
export async function refreshFareTable() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key || !navigator.onLine) return { refreshed: false, reason: 'offline' };

  try {
    const response = await fetch(
      `${url}/rest/v1/fares?route_id=eq.${ROUTE_ID}&select=boarding_stop,alighting_stop,amount`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!response.ok) return { refreshed: false, reason: `http_${response.status}` };
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) return { refreshed: false, reason: 'empty' };

    const table = {};
    for (const row of rows) table[`${row.boarding_stop}|${row.alighting_stop}`] = row.amount;

    const database = await db();
    await database.put('meta', { table, fetchedAt: Date.now() }, 'fareTable');
    cache = table;
    return { refreshed: true, count: rows.length };
  } catch (error) {
    return { refreshed: false, reason: error.message };
  }
}

export const CONCESSION_RATE = { none: 1, student: 0.5, senior: 0.5 };

/*
  A concession halves the fare, rounded up to the rupee. Rounding up rather than
  down because a conductor cannot make change in paisa, and the passenger seeing
  a whole rupee they can hand over matters more than the operator's half rupee.
*/
export function fareFor(table, boardingStop, alightingStop, concession = 'none') {
  const base = table[`${boardingStop}|${alightingStop}`];
  if (base === undefined) return null;
  const rate = CONCESSION_RATE[concession] ?? 1;
  return { base, amount: Math.ceil(base * rate), discounted: rate < 1 };
}

// Stops that can be reached from a given boarding point, in running order.
export function onwardStops(boardingStop) {
  const index = STOPS.findIndex((s) => s.code === boardingStop);
  return index < 0 ? [] : STOPS.slice(index + 1);
}
