// What the Staff console asks the backend, and how it says no.
//
// Every write is an admin_* or review_* function (migrations 0034–0038) that
// checks the caller itself: a reviewer does onboarding, buses, papers and
// routes; only a platform admin takes a company live, publishes an agreement,
// sets a rate or pays out.

import { supabase } from '../../lib/supabase';
import { PAPERS as OWNER_PAPERS } from '../owner/data';

export { call, rows, useLoad, rs, dateOf, timeOf, plateOf } from '../owner/data';

const BUCKET = 'owner-documents';
const MAX_BYTES = 10 * 1024 * 1024;
export const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/*
  Put a scan in a company's folder. Staff may write any company's folder (0036
  storage policy); the path is new every time, so nothing filed is overwritten.
*/
export async function uploadScan(operatorId, name, file) {
  if (!FILE_TYPES.includes(file.type)) return { ok: false, reason: 'bad_file' };
  if (file.size > MAX_BYTES) return { ok: false, reason: 'too_big' };
  const path = `${operatorId}/${name}-${Date.now()}.${EXT[file.type]}`;
  const stored = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (stored.error) return { ok: false, reason: 'upload_failed', message: stored.error.message };
  return { ok: true, path, name: file.name, mime: file.type, size: file.size };
}

// Open a filed paper in a new tab, through a short-lived signed link.
export async function openScan(path) {
  const tab = window.open('', '_blank');
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300);
  if (error || !data?.signedUrl) {
    tab?.close();
    window.alert?.(`Could not open the file: ${error?.message ?? 'not found'}`);
    return;
  }
  if (tab) tab.location.href = data.signedUrl;
  else window.location.assign(data.signedUrl);
}

const REASONS = {
  not_reviewer: 'This login is not Bhada staff.',
  not_admin: 'Only a platform admin can do this.',
  unknown_operator: 'That company does not exist.',
  name_required: 'Enter the company name as registered.',
  bad_phone: 'A contact phone is a ten-digit mobile number starting 97 or 98.',
  bad_plate: 'That is not a plate. Enter it as painted, like BA 2 KHA 4412.',
  taken: 'That plate is already on Bhada.',
  retired: 'That plate belongs to a retired bus of this company.',
  unknown_route: 'Choose a route from the list.',
  bad_capacity: 'Seats 1–120, standing 0–120, no more than 200 in all.',
  unknown_member: 'That person is not a bus owner of this company.',
  unknown_vehicle: 'That bus is not in this company.',
  unknown_agreement: 'That agreement version does not exist.',
  signer_required: 'Enter the name of the person who signed.',
  scan_required: 'Attach the signed scan.',
  text_required: 'An agreement needs a title and its full text (at least 50 characters).',
  bad_kind: 'Choose a kind.',
  bad_amount: 'Enter an amount from 0 to 100,000.',
  backdated: 'A rate starts today or later, never in the past.',
  bad_type: 'Choose which paper this is.',
  bad_path: 'The file is not in this company’s folder.',
  bad_file: 'Upload a PDF or a photo (JPG, PNG or WebP).',
  too_big: 'That file is over 10 MB.',
  upload_failed: 'The file did not upload.',
  expiry_required: 'This paper expires: enter its expiry date from the paper.',
  already_expired: 'That date has passed: the paper is already out of date. Reject it instead.',
  note_required: 'Write the reason the owner will read (at least four characters).',
  already_decided: 'Someone already decided this one. Reload.',
  not_found: 'Not found. Reload.',
  register_first: 'Enter the bus first (Companies → the company → Add a bus), then approve.',
  route_name_required: 'Enter the route name in Nepali and English.',
  too_few_stops: 'A route needs at least two stops.',
  unknown_stop: 'One of the stops is not a known stop code.',
  stop_twice: 'A stop is on the route twice.',
  stop_name_required: 'A new stop needs a Nepali and an English name.',
  stop_position_required: 'A new stop needs its latitude and longitude, inside Nepal.',
  reference_required: 'Enter the partner’s transfer reference.',
  bad_decision: 'Choose approve or reject.',
  bad_month: 'Choose a month.',
  month_not_over: 'That month has not ended yet.',
  not_ready: 'Not ready to go live yet.',
  server_error: 'The server did not answer. Check the connection and try again.',
};

export function say(result) {
  if (!result) return 'Something went wrong.';
  return REASONS[result.reason] ?? result.message ?? `Could not do that (${result.reason ?? 'unknown'}).`;
}

// Throw on a refusal, for useLoad.
export async function must(promise) {
  const result = await promise;
  if (result?.ok === false) throw new Error(say(result));
  return result;
}

export const PAPERS = {
  ...OWNER_PAPERS,
  company_registration: { ne: 'कम्पनी दर्ता', en: 'Company registration', expires: false },
  pan_vat: { ne: 'प्यान / भ्याट', en: 'PAN / VAT certificate', expires: false },
  company_tax_clearance: { ne: 'कर चुक्ता', en: 'Company tax clearance', expires: true },
  director_citizenship: { ne: 'सञ्चालकको नागरिकता', en: 'Directors’ citizenship', expires: false },
  dotm_registration: { ne: 'यातायात दर्ता', en: 'DoTM transport registration', expires: false },
};
export const COMPANY_PAPERS = ['company_registration', 'pan_vat', 'company_tax_clearance', 'director_citizenship', 'dotm_registration'];

export const AGREEMENTS = {
  service: { ne: 'सेवा सम्झौता', en: 'Service agreement' },
  payout_mandate: { ne: 'भुक्तानी अख्तियारी', en: 'Payout mandate' },
  data_consent: { ne: 'तथ्याङ्क सहमति', en: 'Data consent notice' },
  membership: { ne: 'सदस्यता', en: 'Bus owner membership' },
};
export const REQUIRED_AGREEMENTS = ['service', 'payout_mandate', 'data_consent'];

export const STATUS = {
  missing: { label: 'Not filed', tone: 'bad' },
  pending: { label: 'Waiting', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'bad' },
  expired: { label: 'Expired', tone: 'bad' },
};

export function Tag({ tone, children }) {
  return <span className={`ow-tag${tone ? ` ow-tag--${tone}` : ''}`}>{children}</span>;
}
