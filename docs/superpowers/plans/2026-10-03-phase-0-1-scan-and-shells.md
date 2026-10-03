# Phase 0–1: Scanner fix, design system, three app shells — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make QR scanning work on every phone, then stand up the design system and three installable app shells (Rider, Crew, Owner) with visible auto-sync, without changing any fare rule.

**Architecture:** Pure decision logic lives in `.mjs` files with explicit import extensions so `node --test` can run it; React screens import those. One camera hook replaces the two copies of the camera loop. The three apps are shells over the existing screens at first; later phases rebuild the screens inside them.

**Tech Stack:** React 19, Vite 7, vite-plugin-pwa, plain CSS, jsQR + BarcodeDetector, `node --test`, Playwright MCP for browser checks.

**Spec:** `docs/superpowers/specs/2026-10-03-three-apps-design.md`

## Global Constraints

- No commit and no push. The owner said: "do not commit or push anything", "dont push anything to github yet". Every "Commit" step below is replaced by "Checkpoint: `git status` shows only intended files".
- `datajewellery-main/` is never committed (already in `.gitignore` and `.vercelignore`).
- `protocol/`, `supabase/`, `src/device/terminal.js` and `validator/` are not edited.
- `npm run proof:all` passes at the end of each phase.
- No new runtime dependency in this phase. No Tailwind, no icon library.
- Accent `#a8202f`, paper `#f6f3ec`, ink `#15130f`, money-in `#0c6b46`; tap targets ≥ 48 px; inputs 16 px.
- Fonts: Khand (figures, headings), Mukta (body), already in `public/fonts/`.
- Pure modules: `.mjs`, imports with explicit `.mjs` extension, no DOM access at import time.

## Review Focus

1. A QR shown on a phone in dark mode (light modules on dark ground) must still scan — `inversionAttempts: 'attemptBoth'`. Test in Task 1.
2. A browser that has `BarcodeDetector` but no `qr_code` support (many Android builds without Play Services) must fall back to jsQR, not scan nothing forever. Test in Task 1.
3. A conductor scanning a metered BT1 ride code, a pairing code or a receipt must be told what that code is, not "पढिएन / unreadable". Test in Task 2.
4. Old links (`/operator`, `/device`, `/terminal`, `/app/account`, `/crew`) printed on QR stickers must still land somewhere useful. Test in Task 4.
5. Going offline in the middle of a sync must leave items queued and the pill saying so; coming back online must sync without a tap. Test in Task 5.

---

### Task 1: One camera reader that works everywhere

**Files:**
- Create: `src/lib/qr-read.mjs` (pure decode policy)
- Create: `src/lib/useQrCamera.js` (React hook, camera lifecycle)
- Modify: `src/components/Scanner.jsx` (use the hook)
- Modify: `src/screens/Conductor.jsx` (use the hook, delete its own loop)
- Test: `tests/ui/qr-read.test.mjs`

**Interfaces:**
- Produces: `createReadPolicy({ nativeFormats })` → `{ useNative: boolean, tryFallback(tick: number, nativeFound: boolean): boolean }`;
  `JSQR_OPTIONS = { inversionAttempts: 'attemptBoth' }`;
  `useQrCamera({ videoRef, canvasRef, paused, onText }) → { error: string|null }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/ui/qr-read.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadPolicy, JSQR_OPTIONS } from '../../src/lib/qr-read.mjs';

test('native reader is used only when it reports qr_code', () => {
  assert.equal(createReadPolicy({ nativeFormats: ['ean_13'] }).useNative, false);
  assert.equal(createReadPolicy({ nativeFormats: ['qr_code'] }).useNative, true);
  assert.equal(createReadPolicy({ nativeFormats: null }).useNative, false);
});

test('jsQR still runs every third frame while native finds nothing', () => {
  const policy = createReadPolicy({ nativeFormats: ['qr_code'] });
  const runs = [1, 2, 3, 4, 5, 6].filter((tick) => policy.tryFallback(tick, false));
  assert.deepEqual(runs, [3, 6]);
  assert.equal(policy.tryFallback(3, true), false);
});

test('without native, jsQR runs every frame', () => {
  const policy = createReadPolicy({ nativeFormats: null });
  assert.equal(policy.tryFallback(1, false), true);
});

test('dark-mode codes are decoded', () => {
  assert.equal(JSQR_OPTIONS.inversionAttempts, 'attemptBoth');
});
```

- [ ] **Step 2: Run it, expect FAIL** — `node --test tests/ui/` → "Cannot find module .../qr-read.mjs".

- [ ] **Step 3: Implement**

```js
// src/lib/qr-read.mjs
export const JSQR_OPTIONS = { inversionAttempts: 'attemptBoth' };
export const SCANS_PER_SECOND = 8;
export const DECODE_WIDTH = 640;
const FALLBACK_EVERY = 3;

export function createReadPolicy({ nativeFormats }) {
  const useNative = Array.isArray(nativeFormats) && nativeFormats.includes('qr_code');
  return {
    useNative,
    tryFallback(tick, nativeFound) {
      if (!useNative) return true;
      return !nativeFound && tick % FALLBACK_EVERY === 0;
    },
  };
}
```

`useQrCamera.js`: opens `getUserMedia` (environment camera, 1280 wide), stops the stream on cleanup and on StrictMode's second run, asks `BarcodeDetector.getSupportedFormats()` once, then ticks at `SCANS_PER_SECOND`, calling `onText(text)` and skipping ticks while `paused`. Camera errors are mapped to plain sentences: `NotAllowedError` → "Camera permission is off. Allow it in the browser bar, then reopen this screen.", `NotFoundError` → "This phone has no camera this app can use.", `NotReadableError` → "Another app is using the camera. Close it and try again.", insecure origin → "The camera needs https. Open the https address."

- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Wire both screens to the hook**; delete `readNative`/`readCanvas` from `Conductor.jsx`.
- [ ] **Step 6: Browser check** with a fake camera (Task 3 harness) for both light and inverted codes.
- [ ] **Checkpoint.**

### Task 2: Tell the conductor what a code is

**Files:**
- Create: `src/lib/code-kind.mjs`
- Modify: `src/screens/Conductor.jsx` (refusal text for non-BH1)
- Test: `tests/ui/code-kind.test.mjs`

**Interfaces:**
- Produces: `codeKind(text) → 'stage-ticket'|'ride-code'|'group-code'|'receipt'|'pass'|'crew-signon'|'cash-ticket'|'pairing'|'roster'|'unknown'` and `KIND_LABEL[kind] = { ne, en }`.

- [ ] **Step 1: Failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { codeKind } from '../../src/lib/code-kind.mjs';

test('every prefix the protocol prints is recognised', () => {
  assert.equal(codeKind('BH1|abc'), 'stage-ticket');
  assert.equal(codeKind('BT1|abc'), 'ride-code');
  assert.equal(codeKind('BG1~BT1|a'), 'group-code');
  assert.equal(codeKind('BM1|abc'), 'receipt');
  assert.equal(codeKind('BO1|abc'), 'pass');
  assert.equal(codeKind('CR1|abc'), 'crew-signon');
  assert.equal(codeKind('CT1|abc'), 'cash-ticket');
  assert.equal(codeKind('RS1|abc'), 'roster');
  assert.equal(codeKind('{"v":"BHPAIR1"}'), 'pairing');
  assert.equal(codeKind('https://example.com'), 'unknown');
  assert.equal(codeKind(''), 'unknown');
  assert.equal(codeKind('  BT1|abc \n'), 'ride-code');
});
```

- [ ] **Step 2: FAIL.** 
- [ ] **Step 3: Implement** — trim, then prefix match on the first three characters; JSON with `v === 'BHPAIR1'` is pairing. The group code's exact prefix is read from `protocol/leg.mjs` `GROUP_VERSION` and its separator, not guessed.
- [ ] **Step 4: PASS.**
- [ ] **Step 5:** In `Conductor.jsx`, before `collectFare`, a non-`stage-ticket` kind returns `{ ok:false, reason:'wrong_kind', message: … }`, with `REFUSALS.wrong_kind = 'यो टिकट होइन'`. For example, "This is a metered ride code. It is read at the door, not by the stage-fare tally."
- [ ] **Checkpoint.**

### Task 3: Fake-camera browser harness

**Files:**
- Create: `scripts/fake-camera.js` (an init script injected by Playwright)

`fake-camera.js` replaces `navigator.mediaDevices.getUserMedia` with a stream from `canvas.captureStream(15)`. The canvas draws whatever `window.__fakeQr(text, { invert })` last set, rendered with the `qrcode` package that the page already bundles. Nothing loads from a CDN, because the Content Security Policy blocks it.

- [ ] Run `BHADA_HTTP=1 npm run dev`, inject the script, open `/app` and then the conductor screen, and set a real BH1 token made with `scripts/handshake-proof.mjs` helpers. The stamp must show "तिरेको".
- [ ] Repeat with `invert: true`. The stamp must show "तिरेको".
- [ ] Set a BT1 ride code. The stamp must show "यो टिकट होइन" with the ride-code sentence.

### Task 4: One router for three apps

**Files:**
- Create: `src/lib/surface.mjs`
- Modify: `src/App.jsx`
- Test: `tests/ui/surface.test.mjs`

**Interfaces:**
- Produces: `resolveSurface(pathname) → { app: 'site'|'rider'|'crew'|'owner'|'admin'|'inspect'|'demo', redirect: string|null, legacy: string|null }`

- [ ] **Failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSurface } from '../../src/lib/surface.mjs';

const cases = [
  ['/', 'site', null],
  ['/app', 'rider', null],
  ['/app/account', 'rider', '/app/wallet'],
  ['/crew', 'crew', null],
  ['/device', 'crew', '/crew/bus'],
  ['/terminal', 'crew', '/crew'],
  ['/owner', 'owner', null],
  ['/operator', 'owner', '/owner'],
  ['/admin', 'admin', null],
  ['/inspect', 'inspect', null],
  ['/demo', 'demo', null],
  ['/nope', 'site', null],
];
for (const [path, app, redirect] of cases) {
  test(`${path} → ${app}`, () => {
    const s = resolveSurface(path);
    assert.equal(s.app, app);
    assert.equal(s.redirect, redirect);
  });
}
```

`/device` and `/terminal` keep a `legacy` flag. While the Crew app is still a shell (until Phase 4), the old meter and door screens keep rendering under `/crew/bus` and `/crew/door`, so nothing stops working in between.

- [ ] Implement it, check the tests PASS, then switch `App.jsx` to `resolveSurface` with `history.replaceState` for redirects.
- [ ] **Checkpoint.**

### Task 5: Auto-sync you can see

**Files:**
- Create: `src/lib/sync-schedule.mjs` (pure)
- Create: `src/lib/useSyncStatus.js` (hook)
- Create: `src/ui/SyncPill.jsx`
- Test: `tests/ui/sync-schedule.test.mjs`

**Interfaces:**
- Produces: `nextSyncDecision({ online, waiting, syncing, lastAttemptMs, nowMs, lastError }) → { run: boolean, reason: 'online'|'interval'|'idle'|'offline'|'busy'|'backoff' }`.
  `useSyncStatus({ pending: () => Promise<number>, run: () => Promise<unknown> }) → { online, waiting, syncing, lastSyncedAt, error, syncNow }`.

Rules: run when online, `waiting > 0`, not already syncing, and the last attempt was at least 30 s ago, or at least 5 s ago on the `online` event or when the app gains focus. After an error, back off 30 s, 60 s, then 120 s at most.

- [ ] Write the failing tests covering each rule, implement, PASS.
- [ ] Browser check: queue a fare offline (DevTools offline in Playwright via `context.setOffline`), see the pill say "१ पठाउन बाँकी · 1 waiting", go online, and see it clear with no tap. The local sync server is `npm run sync:local`.
- [ ] **Checkpoint.**

### Task 6: Design tokens and the UI kit

**Files:**
- Create: `src/styles/tokens.css` (colour, type, space, radius, shadow, motion; light, dark, and `[data-glance]`)
- Create: `src/ui/ui.css` and the components `Button.jsx`, `TopBar.jsx`, `TabBar.jsx`, `Stat.jsx` (StatGrid with hairlines), `ListRow.jsx`, `Skeleton.jsx`, `Empty.jsx`, `Sheet.jsx`, `Money.jsx`
- Create: `src/ui/index.js`

Money: `<Money value={n} signed />` writes `+ रु 120` in green or `− रु 120` in ink, with tabular figures.

- [ ] Build a kitchen-sink route `/_ui` (dev only, behind `import.meta.env.DEV`) and screenshot it in light, dark and glance at 390×844 and 1280×800.
- [ ] Contrast check with a script: text tokens on their grounds are ≥ 4.5:1, and glance text is ≥ 7:1.
- [ ] **Checkpoint.**

### Task 7: Three manifests, three shells

**Files:**
- Create: `public/manifest-rider.webmanifest`, `public/manifest-crew.webmanifest`, `public/manifest-owner.webmanifest`
- Modify: `vite.config.js` (`manifest: false`, precache the three files)
- Modify: `index.html` (an inline script picks the manifest and theme colour by path before first paint, allowed by the CSP hash in `vercel.json`)
- Create: `src/apps/rider/RiderApp.jsx`, `src/apps/crew/CrewApp.jsx`, `src/apps/owner/OwnerApp.jsx`. Each has a TopBar with the SyncPill and a TabBar, and each tab mounts the existing screen for now.

| App | name | start_url / scope | theme |
|---|---|---|---|
| Rider | Bhada | `/app` | paper `#f6f3ec` |
| Crew | Bhada Crew | `/crew` | ink `#15130f` |
| Owner | Bhada Owner | `/owner` | paper `#f6f3ec` |

- [ ] Browser check: every tab of every shell renders. The `/app` manifest link names `manifest-rider`. The Lighthouse installability audit passes for all three.
- [ ] `npm run build` succeeds, the precache list does not contain three.js or Recharts, and `npm run proof:all` is green.
- [ ] **Checkpoint.**
