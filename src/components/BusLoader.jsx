// The loading state.
//
// Drawn in the same vocabulary as everything else: flat shapes, plate red on
// ink, a road made of the dashed rule the ticket stub uses for its
// perforations. No spinner, because a spinner belongs to every other app.
//
// It appears where there is genuinely something to wait for — a route change,
// the dashboard's chunk downloading, a sign-in, a settlement — and never in
// front of a fare being collected. A conductor scanning a ticket sees the
// verdict instantly; putting a bus in front of that would be a worse product
// for a nicer screenshot.

export default function BusLoader({ label = 'गाडी आउँदैछ', sub = 'Loading' }) {
  return (
    <div className="busload" role="status" aria-live="polite">
      <div className="busload__stage">
        <svg className="busload__bus" viewBox="0 0 148 60" aria-hidden="true">
          {/* Body. A Kathmandu micro in side view: flat front, long windows,
              destination board over the windscreen. */}
          <path d="M4 8 h116 a10 10 0 0 1 8 4 l14 18 v14 a4 4 0 0 1-4 4 H4 a4 4 0 0 1-4-4 V12 a4 4 0 0 1 4-4 z" fill="#a8202f" />
          {/* Destination board, the painted route sign every bus carries. */}
          <rect x="10" y="2" width="62" height="7" fill="#16130f" />
          <rect x="14" y="4" width="40" height="3" fill="#e4e1d8" opacity="0.75" />
          {/* Windows */}
          <rect x="10" y="14" width="26" height="15" fill="#e4e1d8" />
          <rect x="40" y="14" width="26" height="15" fill="#e4e1d8" />
          <rect x="70" y="14" width="26" height="15" fill="#e4e1d8" />
          <rect x="100" y="14" width="20" height="15" fill="#e4e1d8" />
          {/* Windscreen, angled with the nose */}
          <path d="M124 14 h4 l10 14 h-14 z" fill="#e4e1d8" />
          {/* Door seam and skirt */}
          <rect x="66" y="14" width="2" height="30" fill="#16130f" opacity="0.35" />
          <rect x="0" y="44" width="148" height="4" fill="#16130f" opacity="0.35" />
          {/* Wheels. They turn, because a bus with still wheels reads as parked. */}
          <g className="busload__wheel" style={{ transformOrigin: '30px 48px' }}>
            <circle cx="30" cy="48" r="9" fill="#16130f" />
            <circle cx="30" cy="48" r="3.4" fill="#e4e1d8" />
            <rect x="29" y="40" width="2" height="16" fill="#e4e1d8" opacity="0.5" />
          </g>
          <g className="busload__wheel" style={{ transformOrigin: '112px 48px' }}>
            <circle cx="112" cy="48" r="9" fill="#16130f" />
            <circle cx="112" cy="48" r="3.4" fill="#e4e1d8" />
            <rect x="111" y="40" width="2" height="16" fill="#e4e1d8" opacity="0.5" />
          </g>
        </svg>
        <div className="busload__road" aria-hidden="true" />
      </div>
      <p className="busload__label">
        {label}
        <small>{sub}</small>
      </p>
    </div>
  );
}
