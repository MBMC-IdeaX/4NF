// Payment gateways: what is signed, what is checked, and nothing else.
//
// A wallet top-up through eSewa or Khalti is money arriving from outside, so
// the rule is the same as for every other number here: nothing is credited on
// the word of a browser. The browser only carries messages between the
// gateway and our backend; the backend checks the gateway's own signature and
// then asks the gateway directly before a rupee moves.
//
// This file holds the parts that are pure: the field lists, the string that is
// signed, and the checks on a returned message. The HMAC itself is handed in,
// because protocol/ may not reach for a platform's crypto.
//
// eSewa ePay v2: https://developer.esewa.com.np/pages/Epay
// Khalti KPG-2:  https://docs.khalti.com/khalti-epayment/

export const GATEWAYS = ['esewa', 'khalti'];
export const MANUAL_METHODS = ['fonepay', 'imepay'];

export const ESEWA = {
  test: {
    formUrl: 'https://rc-epay.esewa.com.np/api/epay/main/v2/form',
    statusUrl: 'https://rc.esewa.com.np/api/epay/transaction/status/',
    productCode: 'EPAYTEST',
    // Published by eSewa for the test environment; not a secret.
    secretKey: '8gBm/:&EnhH.1/q',
  },
  live: {
    formUrl: 'https://epay.esewa.com.np/api/epay/main/v2/form',
    statusUrl: 'https://esewa.com.np/api/epay/transaction/status/',
  },
};

export const KHALTI = {
  test: { apiUrl: 'https://dev.khalti.com/api/v2/epayment/' },
  live: { apiUrl: 'https://khalti.com/api/v2/epayment/' },
};

// eSewa signs the values of the named fields, joined as `name=value` pairs
// with commas, in the order `signed_field_names` lists them.
export function esewaMessage(fields, names) {
  return names.split(',').map((name) => `${name}=${fields[name]}`).join(',');
}

/*
  The form the browser posts to eSewa. `hmac(key, message)` returns base64.
  Amounts are whole rupees here; tax and charges are zero because a wallet
  top-up has none.
*/
// `serviceCharge` is Bhada's flat top-up fee (platform_fees, 0035). eSewa
// charges amount + serviceCharge; the wallet is credited `amount`.
export async function esewaForm({ amount, serviceCharge = 0, transactionUuid, productCode, secretKey, successUrl, failureUrl, hmac }) {
  const fee = Math.max(0, Math.round(Number(serviceCharge) || 0));
  const fields = {
    amount: String(amount),
    tax_amount: '0',
    product_service_charge: String(fee),
    product_delivery_charge: '0',
    total_amount: String(amount + fee),
    transaction_uuid: transactionUuid,
    product_code: productCode,
    success_url: successUrl,
    failure_url: failureUrl,
    signed_field_names: 'total_amount,transaction_uuid,product_code',
  };
  fields.signature = await hmac(secretKey, esewaMessage(fields, fields.signed_field_names));
  return fields;
}

/*
  What eSewa sends back to the success URL: base64 JSON, signed over the
  fields it names. A good signature says eSewa wrote this; it does not say the
  payment is final, which is why the caller must still ask the status API.
*/
export async function readEsewaReturn(data, { secretKey, hmac }) {
  let message;
  try {
    message = JSON.parse(atob(String(data ?? '')));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const names = String(message.signed_field_names ?? '');
  if (!names.includes('transaction_uuid') || !names.includes('total_amount') || !message.signature) {
    return { ok: false, reason: 'unsigned' };
  }
  const expected = await hmac(secretKey, esewaMessage(message, names));
  if (expected !== message.signature) return { ok: false, reason: 'bad_signature' };
  if (message.status !== 'COMPLETE') return { ok: false, reason: 'not_complete', status: message.status };
  return {
    ok: true,
    transactionUuid: String(message.transaction_uuid),
    amount: Number(String(message.total_amount).replace(/,/g, '')),
    providerRef: String(message.transaction_code ?? ''),
  };
}

// A status API answer, checked against the request we hold.
export function esewaSettled(status, { transactionUuid, amount }) {
  if (!status || status.status !== 'COMPLETE') return { ok: false, reason: 'not_complete', status: status?.status };
  if (String(status.transaction_uuid) !== transactionUuid) return { ok: false, reason: 'wrong_transaction' };
  if (Math.round(Number(status.total_amount)) !== amount) return { ok: false, reason: 'amount_mismatch' };
  return { ok: true, providerRef: String(status.ref_id ?? '') };
}

// Khalti amounts are paisa.
export function khaltiInitiateBody({ amount, reference, returnUrl, websiteUrl, customer }) {
  return {
    return_url: returnUrl,
    website_url: websiteUrl,
    amount: amount * 100,
    purchase_order_id: reference,
    purchase_order_name: 'Bhada wallet top-up',
    ...(customer ? { customer_info: customer } : {}),
  };
}

export function khaltiSettled(lookup, { amount }) {
  if (!lookup || lookup.status !== 'Completed') return { ok: false, reason: 'not_complete', status: lookup?.status };
  if (Number(lookup.total_amount) !== amount * 100) return { ok: false, reason: 'amount_mismatch' };
  return { ok: true, providerRef: String(lookup.transaction_id ?? lookup.pidx ?? '') };
}
