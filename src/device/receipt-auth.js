import { db } from '../storage/db';
import { verifyPass, verifyLeg } from '../../protocol/leg.mjs';
import { priceDistance, TARIFFS } from '../../protocol/meter.mjs';

// Keys come only from the configured backend registry, never from a scanned QR.
export async function trustedBusKey(vehicleId) {
  const database = await db();
  const cache = (await database.get('meter', 'trustedBusKeys')) ?? {};
  const local = import.meta.env.VITE_LOCAL_DB_URL;
  const base = local ? new URL('local/rpc/rider_bus_key', new URL(local, location.origin)).href
    : import.meta.env.VITE_SUPABASE_URL ? `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/rider_bus_key` : null;
  if (navigator.onLine && base) {
    try {
      const response = await fetch(base, {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', ...(local ? {} : { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY }) },
        body: JSON.stringify({ p_vehicle_plate: vehicleId }),
      });
      const result = await response.json();
      const key = local ? result.data : result;
      if (response.ok && typeof key === 'string' && key.length === 43) {
        await database.put('meter', { ...cache, [vehicleId]: key }, 'trustedBusKeys');
        return key;
      }
    } catch { /* Offline: use previously provisioned verification material. */ }
  }
  return cache[vehicleId] ?? null;
}

export function authenticateRecord(text, record, vehiclePublicKey, { passengerPublicKey, vehicleId, legId } = {}) {
  if (record.passengerPublicKey !== passengerPublicKey || (vehicleId && record.vehicleId !== vehicleId) || (legId && record.legId !== legId)) {
    return { ok: false, reason: 'record_mismatch' };
  }
  if (!vehiclePublicKey) return { ok: false, reason: 'verification_pending' };
  try {
    if (text.startsWith('BO1|')) return verifyPass(text, { vehiclePublicKey, vehicleId });
    const signature = verifyLeg(text, { vehiclePublicKey });
    if (!signature.ok) return signature;
    if (!TARIFFS[record.tariffCode]) return { ok: false, reason: 'unsupported_tariff' };
    return verifyLeg(text, { vehiclePublicKey, priceFn: priceDistance });
  } catch { return { ok: false, reason: 'unsupported_tariff' }; }
}
