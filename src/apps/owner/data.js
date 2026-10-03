// What the Owner app asks the backend, and how it says no.
//
// Every write is an owner_* function (migrations 0033–0036) that checks the
// caller's company and role itself; the screens never write a table.

import { useCallback, useEffect, useState, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { plateFromId } from '../../device/fleet';

const WRITES = new Set([
  'accept_agreement', 'accept_invite', 'request_payout', 'cancel_payout', 'set_bus_owner',
  'owner_bus_setup', 'owner_request', 'owner_retire_vehicle', 'owner_update_vehicle',
  'owner_withdraw_request', 'owner_submit_document', 'owner_invite', 'owner_revoke_invite',
  'owner_save_driver', 'owner_set_member', 'admin_create_company', 'admin_invite_owner',
  'admin_record_agreement', 'admin_register_vehicle', 'admin_set_company_live', 'admin_set_levy',
  'admin_submit_document', 'admin_update_vehicle', 'admin_decide_payout', 'admin_bill_month',
  'admin_publish_agreement', 'admin_set_fee', 'admin_set_reviewer', 'admin_build_route',
  'review_request', 'review_document',
]);

export async function call(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) return { ok: false, reason: 'server_error', message: error.message };
  if (data?.ok && WRITES.has(name)) window.dispatchEvent(new Event('bhada:data-changed'));
  return data;
}

export async function rows(table, order) {
  let query = supabase.from(table).select('*');
  if (order) query = query.order(order.col, { ascending: order.asc !== false });
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

// Load something, with loading / error / reload, the same way on every tab.
export function useLoad(load, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const loader = useRef(load);
  loader.current = load;
  const generation = useRef(0);
  const busy = useRef(false);
  const run = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const version = generation.current;
    setState((s) => ({ ...s, loading: s.data === null, error: null }));
    try {
      const data = await loader.current();
      if (version === generation.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (version === generation.current) setState((s) => ({ ...s, error: error.message ?? String(error), loading: false }));
    } finally { busy.current = false; }
  }, []);
  useEffect(() => {
    generation.current += 1;
    // A previous dependency's response is ignored, then the new load runs.
    let cancelled = false;
    let deferred;
    const refresh = () => {
      if (cancelled || document.hidden) return;
      if (busy.current) { clearTimeout(deferred); deferred = setTimeout(refresh, 250); return; }
      run();
    };
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('bhada:data-changed', refresh);
    document.addEventListener('visibilitychange', refresh);
    refresh();
    return () => {
      cancelled = true;
      generation.current += 1;
      clearInterval(timer);
      clearTimeout(deferred);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('bhada:data-changed', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, ...deps]);
  return { ...state, reload: run };
}

export const plateOf = (id) => plateFromId(id);
export const rs = (n) => `रु ${Number(n ?? 0).toLocaleString('en-IN')}`;
export const dateOf = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const timeOf = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

// Every reason a function can answer with, in words an owner reads.
const REASONS = {
  not_operator: 'This login is not an owner or manager of a bus company.',
  owner_only: 'Only the company owner can do this.',
  bad_plate: 'That is not a plate. Use the four parts painted on the bus, like बा २ ख ४४१२.',
  taken: 'That bus is already registered — to you or to another company. If it is yours, contact Bhada support.',
  retired: 'That bus is retired. Bring it back first.',
  unknown_route: 'Choose a route from the list.',
  bad_capacity: 'Seats must be 1–120, standing 0–120, and no more than 200 in all.',
  unknown_vehicle: 'That bus is not in your company.',
  unit_active: 'This bus already has a working phone. Use “Replace phone” if it was lost or broken.',
  bad_role: 'Choose manager or conductor.',
  last_owner: 'A company needs at least one owner. Make someone else an owner first.',
  unknown_member: 'That person is no longer in your company.',
  unknown_invite: 'That invite was already used or withdrawn.',
  unknown_code: 'That code is not right. Check it with the owner who gave it.',
  used: 'That code has already been used.',
  expired: 'That code has expired. Ask for a new one.',
  already_member: 'This login already belongs to a company.',
  not_signed_in: 'Sign in first.',
  bad_method: 'Choose eSewa or a bank account.',
  bad_amount: 'Enter at least Rs 100.',
  name_required: 'Enter the account holder’s name.',
  bad_esewa_id: 'An eSewa ID is a ten-digit mobile number starting 97 or 98.',
  bad_bank_account: 'Enter the bank’s name and the account number.',
  insufficient: 'That is more than you can withdraw right now.',
  not_open: 'That payout is no longer waiting.',
  license_required: 'Enter the driving licence number.',
  license_on_file: 'A driver with that licence number is already on file.',
  unknown_driver: 'That driver is not in your company.',
  bad_type: 'Choose which paper this is.',
  bad_path: 'The file did not upload to your company’s folder. Try again.',
  bad_file: 'Upload a PDF or a photo (JPG, PNG or WebP).',
  too_big: 'That file is over 10 MB. Take a smaller photo or a PDF.',
  upload_failed: 'The file did not upload. Check the connection and try again.',
  from_papers: 'The route and seats come from the route permit and bluebook. Ask Bhada to change them.',
  papers_required: 'Attach the bluebook and the route permit.',
  request_open: 'One is already waiting. Wait for it to be done, or cancel it.',
  route_name_required: 'Write the route as it is named on the permit.',
  permit_required: 'File this bus’s route permit first (Papers), then ask.',
  not_live: 'Payouts open once Bhada has your company live: agreements signed and company papers checked.',
  bus_owner_only: 'Only a bus owner signs the membership agreement.',
  not_current: 'A newer version of this agreement is out. Read and accept that one.',
  unknown_agreement: 'That agreement is not published yet.',
  server_error: 'The server did not answer. Check the connection and try again.',
};

export function say(result) {
  if (!result) return 'Something went wrong.';
  return REASONS[result.reason] ?? result.message ?? `Could not do that (${result.reason ?? 'unknown'}).`;
}

export const PAPERS = {
  bluebook: { ne: 'ब्लुबुक', en: 'Ownership paper (bluebook)', expires: false },
  pollution: { ne: 'प्रदूषण', en: 'Pollution test', expires: true },
  tax_clearance: { ne: 'कर चुक्ता', en: 'Tax clearance', expires: true },
  insurance: { ne: 'बीमा', en: 'Insurance', expires: true },
  route_permit: { ne: 'रुट इजाजत', en: 'Route permit', expires: true },
  driving_license: { ne: 'सवारी चालक अनुमतिपत्र', en: 'Driving licence', expires: true },
  driver_agreement: { ne: 'सम्झौता', en: 'Agreement with the bus', expires: false },
  company_registration: { ne: 'कम्पनी दर्ता', en: 'Company registration', expires: false },
  pan_vat: { ne: 'प्यान / भ्याट', en: 'PAN / VAT certificate', expires: false },
  company_tax_clearance: { ne: 'कर चुक्ता', en: 'Company tax clearance', expires: true },
  director_citizenship: { ne: 'सञ्चालकको नागरिकता', en: 'Directors’ citizenship', expires: false },
  dotm_registration: { ne: 'यातायात दर्ता', en: 'DoTM transport registration', expires: false },
};

export const STATUS = {
  missing: { label: 'Not filed', tone: 'bad' },
  pending: { label: 'Being checked', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'bad' },
  expired: { label: 'Expired', tone: 'bad' },
};

/*
  Put a file in the company's own folder in private storage. The path is new
  every time: storage never overwrites, so what was filed stays as filed.
*/
const UPLOAD_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export async function uploadToFolder(folder, name, file) {
  if (!UPLOAD_TYPES[file.type]) return { ok: false, reason: 'bad_file' };
  if (file.size > 10 * 1024 * 1024) return { ok: false, reason: 'too_big' };
  const operator = await call('current_operator_id');
  if (!operator || operator.ok === false) return { ok: false, reason: 'not_operator' };
  const path = `${operator}/${folder}/${name}-${Date.now()}.${UPLOAD_TYPES[file.type]}`;
  const stored = await supabase.storage.from('owner-documents').upload(path, file, { contentType: file.type, upsert: false });
  if (stored.error) return { ok: false, reason: 'upload_failed', message: stored.error.message };
  return { ok: true, path, name: file.name, mime: file.type, size: file.size };
}
