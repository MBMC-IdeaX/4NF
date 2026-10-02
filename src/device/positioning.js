// What the meter and the door terminals share about positioning: turning a
// browser position into a fix, keeping the screen awake, and recording the raw
// receiver output so an accuracy claim can be checked against a real road.

/*
  A browser position, as the odometer wants it.

  `coords.speed` is the receiver's Doppler speed — measured from the carrier
  frequency, not differenced from positions — and it is the single most useful
  number for telling a crawling bus from a parked one. Browsers report null when
  they do not have it (a laptop on wifi location), and the odometer then drops to
  its conservative position-only grade.
*/
export function fixFromPosition(position, source = 'gnss') {
  const { coords } = position;
  const fix = {
    lat: coords.latitude,
    lon: coords.longitude,
    accuracy: coords.accuracy,
    at: position.timestamp,
    source,
  };
  if (Number.isFinite(coords.speed) && coords.speed >= 0) fix.speed = coords.speed;
  if (Number.isFinite(coords.heading)) fix.heading = coords.heading;
  return fix;
}

/*
  Heat, as much of it as a browser is allowed to see.

  A meter phone under a bus seat in Kathmandu runs a lit screen, a 1 Hz receiver
  and a charger into a cabin that sits near 45 °C, and the two things that follow
  are the OS throttling the receiver and the battery swelling. There is no web
  API for battery temperature — the Battery Status API exposes level, charging
  and the two time estimates, and nothing else — so a PWA cannot read the number
  the problem is actually measured in.

  What it can read is the tell: a phone on a charger whose level is going down
  anyway. That only happens when the device is drawing less than it is burning,
  which on this hardware means it is hot and throttling. Falling while plugged in
  is the signal; the threshold is the fall itself, not a temperature.

  Returns a subscription. `onChange({ charging, level, sinking })` fires whenever
  any of those change, and `sinking` is the state that matters.
*/
const SINK_WINDOW_MS = 5 * 60 * 1000;

export function watchPower(onChange = () => {}) {
  if (typeof navigator === 'undefined' || !navigator.getBattery) {
    onChange({ supported: false, charging: null, level: null, sinking: false });
    return () => {};
  }
  let battery = null;
  let stopped = false;
  let high = null; // best level seen while charging, and when

  function report() {
    if (!battery) return;
    const now = Date.now();
    if (!battery.charging) {
      high = null;
    } else if (!high || battery.level > high.level) {
      high = { level: battery.level, at: now };
    }
    // Plugged in, and lower than it was five minutes ago. A charger that cannot
    // keep up with the load is the only ordinary way this happens.
    const sinking = Boolean(
      battery.charging && high && battery.level < high.level && now - high.at > SINK_WINDOW_MS,
    );
    onChange({ supported: true, charging: battery.charging, level: battery.level, sinking });
  }

  navigator.getBattery().then((b) => {
    if (stopped) return;
    battery = b;
    for (const event of ['levelchange', 'chargingchange']) b.addEventListener(event, report);
    report();
  }).catch(() => onChange({ supported: false, charging: null, level: null, sinking: false }));

  return () => {
    stopped = true;
    if (!battery) return;
    for (const event of ['levelchange', 'chargingchange']) battery.removeEventListener(event, report);
  };
}

/*
  Keep the screen on. Android throttles or stops `watchPosition` once the screen
  sleeps, and a meter that loses fixes every time the display dims is a meter
  that under-reads every ride. The lock is released by the browser whenever the
  tab is hidden, so it is taken again whenever the tab comes back.

  `hold()` is asked before every attempt and whenever it says to let go. A meter
  passes the heat check here: a lit screen is worth losing before the receiver
  is, because a throttled receiver under-reads every fare on the bus while a
  dark screen only costs the fixes the OS was about to stop delivering anyway.
*/
export function holdScreenOn(onChange = () => {}, { hold = () => true } = {}) {
  if (typeof navigator === 'undefined' || !navigator.wakeLock) {
    onChange(false);
    return () => {};
  }
  let sentinel = null;
  let released = false;

  async function take() {
    if (released || document.visibilityState !== 'visible' || !hold()) return;
    if (sentinel && !sentinel.released) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      onChange(true);
      sentinel.addEventListener('release', () => onChange(false));
    } catch {
      onChange(false);
    }
  }

  async function drop() {
    if (!sentinel) return;
    const held = sentinel;
    sentinel = null;
    await held.release().catch(() => {});
    onChange(false);
  }

  const onVisible = () => { if (document.visibilityState === 'visible') take(); };
  document.addEventListener('visibilitychange', onVisible);
  take();

  return Object.assign(
    () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      sentinel?.release().catch(() => {});
    },
    // Re-ask `hold()`. The caller calls this when whatever it gates on changed.
    { reconsider: () => (hold() ? take() : drop()) },
  );
}

/*
  The trace recorder.

  Every fix the receiver produced — accepted or not, with the reason — and any
  marks the person holding the phone drops at known points. Exported as a file,
  it replays through the same odometer with `npm run trace:replay`, against a
  road whose length is known. That is how the meter's accuracy is confirmed on a
  real Kathmandu route rather than asserted about one.
*/
export const TRACE_VERSION = 'bhada-trace/1';
const TRACE_LIMIT = 50_000; // ~14 hours at 1 Hz

export function createRecorder() {
  let fixes = [];
  let marks = [];
  let startedAt = null;
  let on = false;

  return {
    get recording() { return on; },
    get count() { return fixes.length; },
    get marks() { return marks; },
    start() {
      fixes = [];
      marks = [];
      startedAt = Date.now();
      on = true;
    },
    stop() { on = false; },
    push(fix, result) {
      if (!on || fixes.length >= TRACE_LIMIT) return;
      fixes.push({
        lat: fix.lat,
        lon: fix.lon,
        accuracy: fix.accuracy,
        at: fix.at,
        ...(Number.isFinite(fix.speed) ? { speed: fix.speed } : {}),
        source: fix.source,
        kept: Boolean(result?.accepted),
        reason: result?.reason ?? null,
      });
    },
    mark(label, { truthM = null, odometerM = null } = {}) {
      if (!on) return null;
      const entry = { at: Date.now(), label, odometerM, ...(Number.isFinite(truthM) ? { truthM } : {}) };
      marks = [...marks, entry];
      return entry;
    },
    toJSON(meta = {}) {
      return JSON.stringify({
        v: TRACE_VERSION,
        startedAt,
        exportedAt: Date.now(),
        userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
        ...meta,
        marks,
        fixes,
      });
    },
  };
}

// Handing a file to the person holding the device. No network involved.
export function downloadText(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
