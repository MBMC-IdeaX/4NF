/*
  A small stroke-icon set, drawn here rather than installed.

  An icon library is 40–300 KB to get fifteen glyphs, and this app is precached
  onto phones that go offline — every kilobyte is one a passenger downloads on a
  2G connection before they can pay. These are the only icons the portals use,
  they inherit `currentColor` and stroke width, and they are drawn on the same
  24px grid so they sit together.

  Emoji are not an option: they render differently on every handset and read as
  decoration in a screen that moves money.
*/

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const PATHS = {
  // money and wallet
  topup: <><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>,
  arrowDown: <><path d="M12 5v14" /><path d="m5 12 7 7 7-7" /></>,
  wallet: <><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a1 1 0 0 1 1 1v1.5" /><path d="M3 7.5V18a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1v-3" /><path d="M20 10.5h-4a2 2 0 0 0 0 4h4a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1Z" /></>,
  receipt: <><path d="M6 3v18l2-1.4 2 1.4 2-1.4 2 1.4 2-1.4 2 1.4V3l-2 1.4L14 3l-2 1.4L10 3 8 4.4Z" /><path d="M9 9h6" /><path d="M9 13h4" /></>,
  statement: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h10" /></>,

  // the bus world
  bus: <><rect x="4" y="4" width="16" height="13" rx="2" /><path d="M4 11h16" /><circle cx="8" cy="19" r="1.4" /><circle cx="16" cy="19" r="1.4" /></>,
  route: <><circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="18" r="2.2" /><path d="M8 6h6a4 4 0 0 1 0 8H10a4 4 0 0 0 0 8h.2" /></>,
  qr: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><path d="M14 14h2v2h-2z" /><path d="M18 18h2v2h-2z" /><path d="M14 20h2" /><path d="M20 14v2" /></>,
  door: <><path d="M5 20V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v15" /><path d="M3 20h18" /><circle cx="13" cy="12.5" r="0.9" fill="currentColor" stroke="none" /></>,

  // state
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: <><path d="M12 8v5" /><circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" /><path d="M10.3 3.9 2.5 17.4A1.8 1.8 0 0 0 4 20h16a1.8 1.8 0 0 0 1.5-2.6L13.7 3.9a2 2 0 0 0-3.4 0Z" /></>,
  power: <><path d="M12 3v9" /><path d="M6.5 6.8a8 8 0 1 0 11 0" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  shield: <><path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 9.5 4.1-1.9 7-5.3 7-9.5V6Z" /><path d="m9 12 2 2 4-4" /></>,

  // chrome
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3.4a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5V3.4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" /></>,
  users: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" /><path d="M17.5 14.4A5.5 5.5 0 0 1 20.5 20" /></>,
  download: <><path d="M12 4v11" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M5 20h14" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  back: <path d="m15 5-7 7 7 7" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
  inbox: <><path d="M4 13h4l1.5 3h5L16 13h4" /><path d="M5.6 5h12.8a1 1 0 0 1 .95.68L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l1.65-7.32A1 1 0 0 1 5.6 5Z" /></>,

  // the three apps
  home: <><path d="M4 11.5 12 5l8 6.5" /><path d="M6 10v9h12v-9" /><path d="M10 19v-5h4v5" /></>,
  ticket: <><path d="M4 7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v3a2 2 0 0 0 0 4v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3a2 2 0 0 0 0-4Z" /><path d="M14 6v12" strokeDasharray="1.6 2.2" /></>,
  user: <><circle cx="12" cy="8.5" r="3.6" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  family: <><circle cx="8" cy="8" r="2.8" /><circle cx="16.5" cy="9.5" r="2.2" /><path d="M3 19.5a5 5 0 0 1 10 0" /><path d="M13.5 19.5a3.6 3.6 0 0 1 7 0" /></>,
  camera: <><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z" /><circle cx="12" cy="13" r="3.4" /></>,
  scan: <><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" /><path d="M4 12h16" /></>,
  nfc: <><path d="M8.5 8.5a5 5 0 0 1 0 7" /><path d="M12 6a8.5 8.5 0 0 1 0 12" /><path d="M15.5 3.5a12 12 0 0 1 0 17" /><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" /></>,
  cash: <><rect x="3" y="6.5" width="18" height="11" rx="1.5" /><circle cx="12" cy="12" r="2.6" /><path d="M6 9.5v5M18 9.5v5" /></>,
  chart: <><path d="M4 20V4" /><path d="M4 20h16" /><path d="M8 16v-4M12 16V8M16 16v-6" /></>,
  sync: <><path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5" /><path d="M4 4v4.5h4.5" /><path d="M4 13a8 8 0 0 0 14.3 4.3l1.7-1.8" /><path d="M20 20v-4.5h-4.5" /></>,
  offline: <><path d="M3 3l18 18" /><path d="M8.5 16.5a5 5 0 0 1 7 0" /><path d="M5 12.6a10 10 0 0 1 4-2.4M19 12.6a10 10 0 0 0-2.7-1.9" /><path d="M2 9a15 15 0 0 1 4.2-2.6M22 9a15 15 0 0 0-9.6-3.9" /><circle cx="12" cy="20" r="0.9" fill="currentColor" stroke="none" /></>,
  close: <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5" /><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" /></>,
  cube: <><path d="M12 3 4 7.5v9L12 21l8-4.5v-9Z" /><path d="M4 7.5 12 12l8-4.5" /><path d="M12 12v9" /></>,
  pin: <><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.3" /></>,
  gauge: <><path d="M4.5 17a8.5 8.5 0 1 1 15 0" /><path d="m12 13 3.5-4" /><circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none" /></>,
  star: <path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8Z" />,
  logout: <><path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" /><path d="M10 16.5 5.5 12 10 7.5" /><path d="M5.5 12H15" /></>,
};

export default function Icon({ name, size = 20, className, title }) {
  const path = PATHS[name];
  if (!path) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...STROKE}
    >
      {title ? <title>{title}</title> : null}
      {path}
    </svg>
  );
}
