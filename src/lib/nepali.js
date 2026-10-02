// Devanagari numerals and the Ratna Park corridor stop names.
// The conductor surface is Devanagari-first; English sits underneath it.

const DIGITS = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];

export function toDevanagari(value) {
  return String(value).replace(/\d/g, (digit) => DIGITS[Number(digit)]);
}

/*
  Rupees as रु 25, not रु २५. Khand draws Devanagari numerals with almost
  identical forms and advance widths to Latin ones, so setting figures in
  Devanagari buys no visual distinction and costs a conductor reading for an
  amount. Devanagari carries the words; Arabic numerals carry the arithmetic.
  toDevanagari stays for the number plate, where digits are an identifier.
*/
export function rupees(amount) {
  return `रु ${amount}`;
}

/*
  Stops along the Ratna Park to Koteshwor corridor, in running order.

  `lat`/`lon` are the junction each stage is named for, to about ten metres, and
  `chainM` is the running road distance from Ratna Park — road, not straight
  line, because that is what a fare is priced from. They exist for two reasons:
  the meter falls back to them when a bus has no fix at all, and the device
  console needs somewhere to draw the vehicle.

  These are landmarks, not surveyed stops. A real deployment loads the
  regulator's route geometry; nothing in the code assumes seven of anything.
*/
export const STOPS = [
  { code: 'RATNAPARK', ne: 'रत्नपार्क', en: 'Ratna Park', lat: 27.7045, lon: 85.3145, chainM: 0 },
  { code: 'SINGHADURBAR', ne: 'सिंहदरबार', en: 'Singha Durbar', lat: 27.6975, lon: 85.3230, chainM: 1500 },
  { code: 'MAITIGHAR', ne: 'माइतीघर', en: 'Maitighar', lat: 27.6928, lon: 85.3222, chainM: 2200 },
  { code: 'THAPATHALI', ne: 'थापाथली', en: 'Thapathali', lat: 27.6905, lon: 85.3175, chainM: 2900 },
  { code: 'NEWBANESHWOR', ne: 'नयाँ बानेश्वर', en: 'New Baneshwor', lat: 27.6893, lon: 85.3400, chainM: 5300 },
  { code: 'TINKUNE', ne: 'तिनकुने', en: 'Tinkune', lat: 27.6835, lon: 85.3490, chainM: 6600 },
  { code: 'KOTESHWOR', ne: 'कोटेश्वर', en: 'Koteshwor', lat: 27.6785, lon: 85.3495, chainM: 7500 },
];

export const ROUTE_LENGTH_M = STOPS[STOPS.length - 1].chainM;

// Road distance between two stages, for the stage fallback in the meter.
export function stageMetres(fromCode, toCode) {
  const a = STOPS.find((s) => s.code === fromCode);
  const b = STOPS.find((s) => s.code === toCode);
  if (!a || !b) return null;
  return Math.abs(b.chainM - a.chainM);
}

// Where along the corridor a point sits, as a 0..1 fraction, by nearest stage.
// Good enough to place a marker on a schematic; not a map-matching algorithm.
export function chainageFor({ lat, lon }) {
  let best = null;
  for (const s of STOPS) {
    const d = (s.lat - lat) ** 2 + (s.lon - lon) ** 2;
    if (!best || d < best.d) best = { d, s };
  }
  return best ? best.s.chainM / ROUTE_LENGTH_M : 0;
}

const BY_CODE = new Map(STOPS.map((stop) => [stop.code, stop]));

export function stop(code) {
  return BY_CODE.get(code) ?? { code, ne: code, en: code };
}
