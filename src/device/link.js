// The vehicle bus.
//
// On real hardware the two door terminals and the meter are three boards on one
// short cable — RS-485 or BLE, a metre of wire, no internet involved. None of
// that exists in a browser, so this stands in for it, and it stands in for it in
// the same shape: a named channel on the vehicle, messages that are small and
// idempotent, and no assumption that the far end is listening.
//
// Two carriers, used together rather than chosen between:
//
//   BroadcastChannel — same browser, other tabs. Instant, offline, free. This is
//                      what makes a laptop demo work with the network unplugged.
//   Supabase Realtime — different devices. This is the one that carries a tap
//                      from a phone at Maitighar to the meter on the projector.
//
// Every message is published on both and deduplicated by id at the receiver, so
// losing either carrier degrades the link rather than breaking it. Nothing on
// this bus is a request that waits for an answer: a terminal prices its own
// rides and announces what it did, and the meter aggregates. A fare system that
// stops working when the wifi does is not a fare system for Nepal.

const SEEN_LIMIT = 400;

/*
  A carrier that is open is not a link.

  BroadcastChannel constructs successfully in any browser, including one running
  alone on a door phone with nobody on the other end — so reporting `local`
  because the channel exists told a crew they had a vehicle bus when the two
  doors could not hear each other at all. That is the worst possible thing for
  this chip to say, because the whole point of it is to tell the crew whether a
  passenger without their own pass can be let off here.

  So the state is decided by what has been heard, not by what has been opened.
  Each unit says hello on a timer; a peer heard inside this window is a link.
*/
const HELLO_MS = 4000;
const PEER_STALE_MS = 12000;

export const LINK = {
  REALTIME: 'realtime',
  LOCAL: 'local',
  DETACHED: 'detached',
};

function channelName(vehicleId) {
  return `bhada-vehicle-${vehicleId}`;
}

let counter = 0;
function messageId() {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/*
  One link per vehicle per tab. `onMessage` sees every message from anyone else
  on the channel, already deduplicated; `send` fans out to both carriers.
*/
export function openLink(vehicleId, onMessage, { unitId = null, onPeer = null } = {}) {
  const name = channelName(vehicleId);
  const seen = new Set();
  const order = [];
  // unitId -> { at, via }. What is actually on this bus right now.
  const peers = new Map();
  let local = null;
  let realtime = null;
  let realtimeReady = false;
  let heartbeat = null;

  function notePeer(message) {
    if (!message.unitId || message.unitId === unitId) return;
    const fresh = !peers.has(message.unitId);
    peers.set(message.unitId, { at: Date.now(), via: message.via ?? 'local' });
    // A unit that has just appeared is the moment to reconcile with it: it may
    // have been boarding people for twenty minutes while this door could not
    // hear it.
    if (fresh) onPeer?.(message.unitId);
  }

  function accept(message) {
    if (!message || typeof message !== 'object' || !message.id) return;
    if (seen.has(message.id)) return;
    seen.add(message.id);
    order.push(message.id);
    // The dedupe set is bounded: a meter left running all day would otherwise
    // grow one entry per tap forever.
    while (order.length > SEEN_LIMIT) seen.delete(order.shift());
    notePeer(message);
    // `hello` is the bus's own keepalive and carries nothing anyone acts on.
    if (message.kind === 'hello') return;
    onMessage?.(message);
  }

  try {
    local = new BroadcastChannel(name);
    local.onmessage = (event) => accept(event.data);
  } catch {
    local = null;
  }

  /*
    The Supabase client is 220 KB and it is only ever useful when there is a
    network. Importing it statically would put those bytes in the precache of
    every door terminal — bytes a phone downloads before it can go offline, to
    run code that cannot work offline. So it is fetched on demand, and a
    terminal that never sees a network never pays for it.
  */
  let closed = false;
  // A demonstration runs every unit in one tab and must not reach the network
  // at all; BroadcastChannel carries everything it needs, and the Supabase
  // client is not even loaded.
  (globalThis.__BHADA_LOCAL_ONLY__ ? Promise.reject(new Error('local only')) : import('../lib/supabase')).then(({ supabase, supabaseConfigured }) => {
    if (closed || !supabaseConfigured) return;
    realtime = supabase.channel(name, { config: { broadcast: { self: false, ack: false } } });
    realtime.on('broadcast', { event: 'bus' }, ({ payload }) => accept(payload));
    realtime.subscribe((status) => {
      realtimeReady = status === 'SUBSCRIBED';
    });
  }).catch(() => { /* no network, no realtime. the local carrier still works */ });

  function send(kind, body = {}) {
    const message = { id: messageId(), kind, at: Date.now(), unitId, ...body };
    // Mark it seen before sending: BroadcastChannel does not echo to the sender
    // but Realtime can, and a meter that processes its own tap twice is a bug
    // that only shows up on the one device that matters.
    seen.add(message.id);
    order.push(message.id);
    try {
      local?.postMessage(message);
    } catch { /* a closed channel is not worth failing a tap over */ }
    if (realtime && realtimeReady) {
      realtime.send({ type: 'broadcast', event: 'bus', payload: message }).catch(() => {});
    }
    return message;
  }

  // Anything heard from recently enough to still be aboard.
  function livePeers() {
    const now = Date.now();
    for (const [id, seenAt] of peers) {
      if (now - seenAt.at > PEER_STALE_MS) peers.delete(id);
    }
    return [...peers.entries()].map(([id, seenAt]) => ({ unitId: id, via: seenAt.via }));
  }

  /*
    What the crew is told.

    `realtime` only when a peer has actually been heard over it — a subscribed
    channel with nobody else on it is a subscription, not a bus. `detached` is
    the honest answer for a door phone alone on a bus with no signal, and it is
    the answer that makes the crew reach for the passenger's own pass.
  */
  function state() {
    const live = livePeers();
    if (live.length === 0) return LINK.DETACHED;
    if (realtimeReady && live.some((peer) => peer.via === 'realtime')) return LINK.REALTIME;
    return LINK.LOCAL;
  }

  // Say hello, so the far end can count this unit as present. Cheap enough to
  // run on every carrier: one small message every four seconds is nothing
  // against a 2G SIM's monthly allowance and it is the only thing that makes
  // `state()` mean anything.
  if (unitId) {
    const hello = () => send('hello', { via: realtimeReady ? 'realtime' : 'local' });
    hello();
    heartbeat = setInterval(hello, HELLO_MS);
  }

  function close() {
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    try { local?.close(); } catch { /* already gone */ }
    const channel = realtime;
    realtime = null;
    if (channel) {
      import('../lib/supabase').then(({ supabase }) => supabase?.removeChannel(channel)).catch(() => {});
    }
  }

  return { send, state, close, name, peers: livePeers };
}
