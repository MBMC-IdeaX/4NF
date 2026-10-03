// Putting money in.
//
// eSewa only. When the gateway is on, the passenger pays on eSewa's own page
// and the wallet is credited once eSewa confirms. When it is off, the
// passenger pays the merchant number shown, types the transaction ID, and an
// admin loads it after checking the payment arrived.

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { call } from '../shared/session';
import { explain, rupees, when, METHOD_NAMES } from '../shared/format';
import { passkeyEnrolled, unlockWithPasskey } from '../shared/passkey';
import { RequestStatus } from '../shared/Entries';
import { gatewayConfig, startGatewayTopup } from './payments';

const AMOUNTS = [100, 200, 500, 1000];

const ESEWA_GREEN = '#41a124';

export default function TopUp({ session, onDone }) {
  const [config, setConfig] = useState(null);
  const [settings, setSettings] = useState({});
  const [requests, setRequests] = useState([]);
  const method = 'esewa';
  const [amount, setAmount] = useState(500);
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  // Bhada's flat top-up fee (0035), charged by eSewa as a service charge and
  // not credited. Shown before the rider pays it.
  const [fee, setFee] = useState(0);

  const loadRequests = () => call('my_topup_requests').then((r) => setRequests(Array.isArray(r) ? r : []));

  useEffect(() => {
    gatewayConfig().then(setConfig);
    supabase.from('platform_settings').select('key, value').then(({ data }) => {
      setSettings(Object.fromEntries((data ?? []).map((row) => [row.key, row.value])));
    });
    loadRequests();
    call('fee_at', { p_kind: 'topup_flat' }).then((n) => setFee(Number.isInteger(n) ? n : 0));
  }, []);

  const instant = Boolean(config?.[method]);
  const merchant = settings[`${method}_id`];
  const qr = settings[`${method}_qr_url`];
  const valid = Number.isInteger(amount) && amount >= 10 && amount <= 10000;

  async function confirmIdentity() {
    if (!passkeyEnrolled(session.user.id)) return true;
    try {
      return await unlockWithPasskey(session.user.id);
    } catch {
      return false;
    }
  }

  async function payInstantly() {
    setMessage(null);
    if (!(await confirmIdentity())) { setMessage({ tone: 'error', text: 'Your phone did not confirm it was you.' }); return; }
    setBusy(true);
    const result = await startGatewayTopup({ method, amount, accessToken: session.access_token });
    if (!result?.redirecting) {
      setBusy(false);
      setMessage({ tone: 'error', text: explain(result, 'The payment could not start.') });
    }
  }

  async function sendRequest(event) {
    event.preventDefault();
    setMessage(null);
    if (!(await confirmIdentity())) { setMessage({ tone: 'error', text: 'Your phone did not confirm it was you.' }); return; }
    setBusy(true);
    const result = await call('request_topup', { p_method: method, p_amount: amount, p_reference: reference });
    setBusy(false);
    if (result?.ok) {
      setReference('');
      setMessage({ tone: 'ok', text: `Request sent. ${rupees(amount)} will be added once the payment is checked.` });
      loadRequests();
      onDone?.();
    } else {
      setMessage({ tone: 'error', text: explain(result) });
    }
  }

  return (
    <>
      <div className="op-pagehead">
        <div>
          <h1>रिचार्ज</h1>
          <p>Add money to your wallet. It is ready for your next ride as soon as it is loaded.</p>
        </div>
      </div>

      <div className="op-grid op-grid--aside-left">
        <form className="op-sheet" onSubmit={sendRequest}>
          <h2>
            eSewa बाट तिर्नुहोस्
            <small>Top up with eSewa</small>
          </h2>

          <div className="op-method op-method--solo" style={{ '--tint': ESEWA_GREEN }}>
            <b>eSewa</b>
            <small>{config === null ? 'Checking…' : config?.esewa ? 'Instant — credited as soon as eSewa confirms' : 'Checked by us before it is added'}</small>
          </div>

          <div className="op-form">
            <div className="op-field">
              <span>रकम / Amount</span>
              <div className="op-chips">
                {AMOUNTS.map((a) => (
                  <button key={a} type="button" aria-pressed={amount === a} onClick={() => setAmount(a)}>{rupees(a)}</button>
                ))}
              </div>
              <div className="op-prefixed">
                <em>Rs</em>
                <input
                  value={amount || ''}
                  onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, '').slice(0, 5)) || 0)}
                  inputMode="numeric"
                  aria-label="Amount in rupees"
                  className="tabular"
                />
              </div>
              <small className="op-field__help">Between Rs 10 and Rs 10,000.</small>
            </div>

            {instant ? (
              <>
                {config?.[`${method}Env`] === 'test' ? (
                  <p className="op-routecard">
                    <b>Test mode.</b>{' '}
                    Pay with eSewa ID 9711111111, password Test@123, token 123456. No real money moves.
                  </p>
                ) : null}
                {message ? <p className={message.tone === 'ok' ? 'op-success' : 'op-error'} role="status">{message.text}</p> : null}
                <button type="button" className="op-btn op-btn--block" disabled={busy || !valid} onClick={payInstantly}>
                  {busy ? 'Opening payment…' : `Pay ${rupees(amount + (fee || 0))} with ${METHOD_NAMES[method]}`}
                </button>
                <small className="op-field__help">
                  {fee ? `${rupees(amount)} goes to your wallet; ${rupees(fee)} is Bhada’s top-up fee, shown by ${METHOD_NAMES[method]} as a service charge. ` : ''}
                  You will be taken to {METHOD_NAMES[method]} and brought back here.
                </small>
              </>
            ) : (
              <>
                <div className="op-payto">
                  {qr ? <img src={qr} alt={`${METHOD_NAMES[method]} QR code`} /> : null}
                  <div>
                    <small>Send {rupees(amount)} to</small>
                    <b className="tabular">{merchant || 'Not set up yet'}</b>
                    <small>
                      {merchant
                        ? `in ${METHOD_NAMES[method]}, then enter the transaction ID below.`
                        : `${METHOD_NAMES[method]} payments are not open yet.${settings.support_phone ? ` Call ${settings.support_phone}.` : ''}`}
                    </small>
                  </div>
                </div>
                <label className="op-field">
                  <span>कारोबार नम्बर / Transaction ID</span>
                  <input
                    value={reference}
                    onChange={(e) => setReference(e.target.value.slice(0, 40))}
                    placeholder="As shown in your payment app"
                    autoComplete="off"
                    disabled={!merchant}
                  />
                </label>
                {message ? <p className={message.tone === 'ok' ? 'op-success' : 'op-error'} role="status">{message.text}</p> : null}
                <button type="submit" className="op-btn op-btn--block" disabled={busy || !valid || !reference.trim() || !merchant}>
                  {busy ? 'Sending…' : `Request ${rupees(amount)}`}
                </button>
              </>
            )}
          </div>
        </form>

        <section className="op-section">
          <div className="op-section__head">
            <h2>
              अनुरोधहरू
              <small>Your top-ups</small>
            </h2>
          </div>
          {requests.length === 0 ? (
            <div className="op-empty"><p>No top-ups yet.</p></div>
          ) : (
            <div className="op-rows op-rows--plain">
              {requests.map((r) => (
                <div key={r.id}>
                  <div className="op-row__name">
                    {METHOD_NAMES[r.method]} · {rupees(r.amount)}
                    <small>
                      {when(r.created_at)} · {r.reference}
                      {r.note ? ` · ${r.note}` : ''}
                    </small>
                  </div>
                  <RequestStatus status={r.status} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
