// Haptics.
//
// A conductor is looking at the passenger, the door, and the road — not at the
// phone. The screen already shouts the verdict, but a fare that can be felt is
// a fare that does not need to be looked at. Two patterns, deliberately
// unmistakable from each other through a jacket pocket:
//
//   accepted  one short tap, the stamp coming down
//   refused   three sharp taps, the pattern nothing else in the app uses
//
// vibrate() is absent on iOS Safari and inert without a user gesture on some
// Android builds, so it is treated as a bonus and never as the signal itself.

const ACCEPTED = 35;
const REFUSED = [45, 60, 45, 60, 45];

function buzz(pattern) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    // A device that refuses to vibrate is not an error worth surfacing.
  }
}

export function feedbackForVerdict(ok) {
  buzz(ok ? ACCEPTED : REFUSED);
}

// Respect the same preference the CSS does, for anything JS-driven.
export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}
