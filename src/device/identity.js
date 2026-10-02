// The device keypair is generated once, on first launch, with no network.
// The public key is this passenger's account name until it can be registered.

import { db } from '../storage/db';
import { useRandomSource } from '../../protocol/random.mjs';
import { createKeypair } from '../../protocol/token.mjs';
import { createMasterSeed, deriveDailyKeypair, deriveCompanionKeypair, dayIndex, buildLink, signLink, MAX_COMPANIONS } from '../../protocol/pseudonym.mjs';
import { buildAccountLink, signAccountLink } from '../../protocol/account.mjs';

// Seeded for the demo. Topping a wallet up is outside the demo script; the
// backend records the same credit in wallet_topups when the device registers.
const SEED_BALANCE = 2000;

// Student and senior accounts pay half. Hardcoded per the brief; in a real
// deployment this is set when the concession card is verified, and the backend
// is what decides it.
const SEED_CONCESSION = 'none';

let randomReady = false;

export function installRandomSource() {
  if (randomReady) return;
  useRandomSource((length) => {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  });
  randomReady = true;
}

/*
  Who this phone is, today.

  Two keys, not one. The root is the wallet — it holds the balance and it is
  what a top-up credits — and it never appears on a tap, a receipt or anything
  an operator can read. What goes on those is a pseudonym derived from a master
  seed for today's date, and tomorrow's is unlinkable to it by anyone holding
  only the public halves.

  The reason is in protocol/pseudonym.mjs: one key per phone forever lets a
  fleet owner reconstruct a commute from rows they were given to collect Rs 15.

  `publicKey` and `secretKey` are the day-key, because every caller of this
  function is signing something a bus will see. The root is named explicitly, so
  the few places that mean the wallet have to say so.
*/
export async function loadIdentity({ now = Math.floor(Date.now() / 1000) } = {}) {
  installRandomSource();
  const database = await db();
  const existing = await database.get('identity', 'me');

  if (existing) {
    // A device from before rotation has a root and no seed. Give it one now;
    // its old key stays the wallet, so no balance moves and nothing it already
    // signed stops verifying.
    const seed = existing.masterSeed ?? createMasterSeed();
    const day = dayIndex(now);
    const today = deriveDailyKeypair(seed, day);
    const changed = existing.masterSeed !== seed || existing.day !== day;
    const identity = {
      concession: SEED_CONCESSION,
      ...existing,
      masterSeed: seed,
      rootPublicKey: existing.rootPublicKey ?? existing.publicKey,
      rootSecretKey: existing.rootSecretKey ?? existing.secretKey,
      publicKey: today.publicKey,
      secretKey: today.secretKey,
      day,
    };
    if (changed) await database.put('identity', identity, 'me');
    return identity;
  }

  const root = createKeypair();
  const masterSeed = createMasterSeed();
  const day = dayIndex(now);
  const today = deriveDailyKeypair(masterSeed, day);
  const identity = {
    rootPublicKey: root.publicKey,
    rootSecretKey: root.secretKey,
    masterSeed,
    day,
    publicKey: today.publicKey,
    secretKey: today.secretKey,
    sequenceNumber: 0,
    balance: SEED_BALANCE,
    concession: SEED_CONCESSION,
    unsettledTotal: 0,
    lastSettlementAt: Math.floor(Date.now() / 1000),
  };
  await database.put('identity', identity, 'me');
  return identity;
}

/*
  The certificate that lets today's key spend from this wallet.

  Signed by both halves — the wallet authorising the key, the key proving the
  sender holds it — and sent only to the backend, never to a bus.
*/
export function keyLinkFor(identity) {
  if (!identity?.masterSeed || !identity?.rootSecretKey) return null;
  return signLink(
    buildLink({
      rootPublicKey: identity.rootPublicKey,
      pseudonymPublicKey: identity.publicKey,
      day: identity.day,
    }),
    identity.rootSecretKey,
    identity.secretKey,
  );
}

/*
  People riding on this phone's wallet today.

  A companion is a key derived from this phone's seed for today (protocol/
  pseudonym.mjs), linked to the wallet with an ordinary PK1, so each of their
  fares is charged here. The phone remembers how many it used today, so the
  links for exactly those go up with its next sync.
*/
export function companionKeys(identity, count) {
  const n = Math.max(0, Math.min(MAX_COMPANIONS, Math.round(count)));
  return Array.from({ length: n }, (_, i) => deriveCompanionKeypair(identity.masterSeed, identity.day, i + 1));
}

export function companionLinksFor(identity) {
  if (!identity?.masterSeed || !identity?.rootSecretKey) return [];
  const used = identity.companionsDay === identity.day ? identity.companionsUsed ?? 0 : 0;
  return companionKeys(identity, used).map((companion) => signLink(
    buildLink({ rootPublicKey: identity.rootPublicKey, pseudonymPublicKey: companion.publicKey, day: identity.day }),
    identity.rootSecretKey,
    companion.secretKey,
  ));
}

export async function noteCompanions(count) {
  const database = await db();
  const identity = await database.get('identity', 'me');
  if (!identity) return;
  const day = dayIndex();
  const before = identity.companionsDay === day ? identity.companionsUsed ?? 0 : 0;
  if (count <= before) return;
  await database.put('identity', { ...identity, companionsDay: day, companionsUsed: Math.min(MAX_COMPANIONS, count) }, 'me');
}

/*
  The proof that this phone's wallet belongs to a login. Signed by the wallet
  (root) key, never the day-key: it is the wallet being claimed.
*/
export function accountLinkFor(identity, userId) {
  if (!identity?.rootSecretKey || !userId) return null;
  return signAccountLink(
    buildAccountLink({ userId, walletPublicKey: identity.rootPublicKey }),
    identity.rootSecretKey,
  );
}

/*
  The server's word on the balance, once this phone is linked and online.

  The server has not seen stage fares still queued on this phone, so the local
  figure is the server's less those. The offline limits are untouched: they
  bound what a phone may sign before it next settles, whatever the balance.
*/
export async function applyServerBalance(serverBalance) {
  const database = await db();
  const current = await database.get('identity', 'me');
  if (!current || !Number.isFinite(Number(serverBalance))) return current;
  const next = {
    ...current,
    balance: Number(serverBalance) - (current.unsettledTotal ?? 0),
    serverBalance: Number(serverBalance),
    serverBalanceAt: Math.floor(Date.now() / 1000),
  };
  await database.put('identity', next, 'me');
  return next;
}

/*
  Recording a fare and advancing the wallet must be one transaction. Two writes
  would let a crash between them leave a signed ticket in the world that the
  wallet has no record of paying for.
*/
export async function recordPayment({ token, qrText, tripFare }) {
  const database = await db();
  const tx = database.transaction(['identity', 'payments'], 'readwrite');
  const identityStore = tx.objectStore('identity');
  const current = await identityStore.get('me');

  const next = {
    ...current,
    sequenceNumber: token.sequenceNumber,
    balance: current.balance - tripFare,
    unsettledTotal: current.unsettledTotal + tripFare,
  };

  await Promise.all([
    identityStore.put(next, 'me'),
    tx.objectStore('payments').put({ ...token, qrText, settled: 0 }),
    tx.done,
  ]);
  return next;
}

/*
  Which concession this account holds.

  In a real deployment an operator sets this after seeing a student or senior
  card, and the backend is authoritative — set_concession() in migration 0005
  is that path. On the device it is stored locally too, because the fare has to
  be priced with no network, and a passenger who cannot select their own
  concession offline cannot buy a ticket at all.
*/
export async function setConcession(concession) {
  const database = await db();
  const current = await database.get('identity', 'me');
  const next = { ...current, concession };
  await database.put('identity', next, 'me');
  return next;
}

export function shortKey(publicKey) {
  return `${publicKey.slice(0, 6)}…${publicKey.slice(-4)}`;
}
