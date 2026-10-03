// Money, dates and durations, the same way on every portal.

const npr = new Intl.NumberFormat('en-IN');

// रु 1,250 and −रु 25, as every app writes it. Lakh grouping, because that is
// how Nepal writes money.
export function rupees(amount, { sign = false } = {}) {
  const n = Number(amount ?? 0);
  const body = `रु ${npr.format(Math.abs(n))}`;
  if (n < 0) return `− ${body}`;
  return sign && n > 0 ? `+ ${body}` : body;
}

export function when(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kathmandu',
  });
}

export function day(iso) {
  if (!iso) return 'Earlier';
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kathmandu',
  });
}

export function timeAgo(iso) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function shortKey(key) {
  return key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '—';
}

export const METHOD_NAMES = {
  esewa: 'eSewa',
  khalti: 'Khalti',
  fonepay: 'Fonepay',
  imepay: 'IME Pay',
  cash: 'Cash',
};

export const REASONS = {
  not_signed_in: 'Sign in first.',
  not_linked: 'Link this phone’s wallet to your account first.',
  suspended: 'This account is suspended. Contact support.',
  bad_method: 'Only eSewa is accepted for top-ups.',
  bad_amount: 'Enter an amount between Rs 10 and Rs 10,000.',
  reference_required: 'Enter the transaction ID from your payment app.',
  duplicate_reference: 'That transaction ID has already been used.',
  too_many_pending: 'You already have five requests waiting. Wait for one to be checked.',
  gateway_off: 'This payment method is not switched on yet.',
  gateway_error: 'The payment service did not respond. Try again in a moment.',
  not_admin: 'Your login is not a super admin.',
  already_decided: 'This request was already handled.',
  reason_required: 'Write a reason.',
  below_floor: 'That would take the wallet past its overdraft limit.',
  unknown_wallet: 'No such wallet.',
  not_found: 'Not found.',
  bad_signature: 'The payment reply did not check out.',
  not_complete: 'The payment is not complete.',
  amount_mismatch: 'The amount paid does not match the request. An admin will check it.',
  wrong_session: 'That payment session does not belong to this request.',
  wallet_taken: 'This phone’s wallet already belongs to another account.',
  account_has_wallet: 'This account is already linked to a wallet on another phone.',
  would_overdraw: 'Both phones owe money. Top up one of them first, then move.',
  not_a_wallet: 'This phone cannot hold the money. Update the app and try again.',
  wrong_user: 'The link was made for a different login. Try again.',
  stale: 'The link expired. Try again.',
  server_error: 'Something went wrong on our side. Try again.',
};

export function explain(result, fallback = 'Something went wrong.') {
  if (!result) return fallback;
  return REASONS[result.reason] ?? result.message ?? fallback;
}
