// Nepali number plates, as an owner reads them and as a token carries them.
//
// A bus plate is painted बा २ ख ४४१२: the zone it was registered in, the lot
// number, the vehicle-class series, and the vehicle's own number. Every signed
// token carries the Latin transliteration with no spaces — BA2KHA4412 —
// because the token alphabet has room for neither Devanagari nor a space. The
// form asks for the four parts separately so nobody has to know that spelling.
//
// These are the zonal plates buses carry today. Provincial plates (बागमती प्र
// ...) use a different layout and are not handled here yet.

import { toDevanagari } from '../../lib/nepali';

export const ZONES = [
  { code: 'BA', ne: 'बा', en: 'Bagmati' },
  { code: 'NA', ne: 'ना', en: 'Narayani' },
  { code: 'JA', ne: 'ज', en: 'Janakpur' },
  { code: 'SA', ne: 'स', en: 'Sagarmatha' },
  { code: 'KO', ne: 'को', en: 'Koshi' },
  { code: 'ME', ne: 'मे', en: 'Mechi' },
  { code: 'GA', ne: 'ग', en: 'Gandaki' },
  { code: 'LU', ne: 'लु', en: 'Lumbini' },
  { code: 'DH', ne: 'ध', en: 'Dhaulagiri' },
  { code: 'RA', ne: 'रा', en: 'Rapti' },
  { code: 'BH', ne: 'भे', en: 'Bheri' },
  { code: 'KA', ne: 'क', en: 'Karnali' },
  { code: 'SE', ne: 'से', en: 'Seti' },
  { code: 'MA', ne: 'म', en: 'Mahakali' },
];

// Vehicle-class letters. ख is the heavy public series most buses carry, so it
// is the default; the others are here for minibuses and the odd registration.
export const SERIES = [
  { code: 'KHA', ne: 'ख' },
  { code: 'KA', ne: 'क' },
  { code: 'GA', ne: 'ग' },
  { code: 'CHA', ne: 'च' },
  { code: 'JA', ne: 'ज' },
  { code: 'JHA', ne: 'झ' },
];

const PLATE = /^([A-Z]{2})([0-9]{1,2})([A-Z]{2,3})([0-9]{1,4})$/;

export function composePlate({ zone, lot, series, number }) {
  return `${zone}${String(lot).trim()}${series}${String(number).trim()}`;
}

export function isValidPlate(plate) {
  const parts = parsePlate(plate);
  return Boolean(parts && ZONES.some((z) => z.code === parts.zone) && SERIES.some((s) => s.code === parts.series));
}

export function parsePlate(plate) {
  const match = PLATE.exec(String(plate ?? ''));
  if (!match) return null;
  return { zone: match[1], lot: match[2], series: match[3], number: match[4] };
}

// बा २ ख ४४१२ for a plate the form understands; the Latin spelling otherwise.
export function plateNe(plate) {
  const parts = parsePlate(plate);
  const zone = parts && ZONES.find((z) => z.code === parts.zone);
  const series = parts && SERIES.find((s) => s.code === parts.series);
  if (!zone || !series) return plate;
  return `${zone.ne} ${toDevanagari(parts.lot)} ${series.ne} ${toDevanagari(parts.number)}`;
}

// BA 2 KHA 4412: the Latin form, spaced the way it is painted.
export function plateEn(plate) {
  const parts = parsePlate(plate);
  if (!parts) return plate;
  return `${parts.zone} ${parts.lot} ${parts.series} ${parts.number}`;
}
