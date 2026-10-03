import { useEffect, useState } from 'react';
import { navigate } from '../../lib/router';
import { shortKey, when } from '../shared/format';
import { enrolPasskey, forgetPasskey, passkeyAvailable, passkeyEnrolled } from '../shared/passkey';
import { SetPassword } from '../shared/Recovery';

export default function Settings({ session, account, onSignOut }) {
  const userId = session.user.id;
  const [available, setAvailable] = useState(null);
  const [enrolled, setEnrolled] = useState(passkeyEnrolled(userId));
  const [message, setMessage] = useState(null);
  const [changing, setChanging] = useState(false);

  useEffect(() => { passkeyAvailable().then(setAvailable); }, []);

  async function turnOn() {
    setMessage(null);
    try {
      await enrolPasskey({ userId, label: account.email ?? session.user.phone ?? 'Bhada' });
      setEnrolled(true);
      setMessage({ tone: 'ok', text: 'Face ID / fingerprint lock is on for this phone.' });
    } catch {
      setMessage({ tone: 'error', text: 'Your phone did not set up the lock. Try again.' });
    }
  }

  function turnOff() {
    forgetPasskey(userId);
    setEnrolled(false);
    setMessage({ tone: 'ok', text: 'Lock turned off for this phone.' });
  }

  return (
    <>
      <div className="op-pagehead">
        <div>
          <h1>सेटिङ</h1>
          <p>Your login, your ride account, and how this phone protects them.</p>
        </div>
      </div>

      <div className="op-grid op-grid--halves">
        <section className="op-section">
          <div className="op-section__head"><h2>खाता<small>Account</small></h2></div>
          <dl className="op-facts">
            <div><dt>Login</dt><dd>{account.email ?? session.user.phone ?? '—'}</dd></div>
            <div><dt>Account key</dt><dd className="tabular">{shortKey(account.wallet)}</dd></div>
            <div><dt>Linked</dt><dd>{when(account.linked_at)}</dd></div>
            <div><dt>Unpaid fares</dt><dd>Shown as owed, up to Rs {account.overdraft}, until a top-up clears them</dd></div>
          </dl>
          <p className="op-note">
            Bus companies see a different key for you every day and never your login. Bhada keeps
            the link between them so your rides land on this statement.
          </p>
        </section>

        <section className="op-section">
          <div className="op-section__head"><h2>सुरक्षा<small>Face ID and fingerprint</small></h2></div>
          <p className="op-note">
            Ask for Face ID, a fingerprint or the phone’s PIN whenever this account opens and before
            a top-up. It is checked on the phone; no face or fingerprint is sent to anyone.
          </p>
          {available === false ? (
            <p className="op-note"><b>This phone or browser has no biometric lock.</b> Your password still protects the account.</p>
          ) : enrolled ? (
            <button type="button" className="op-btn op-btn--ghost" onClick={turnOff}>Turn off the lock</button>
          ) : (
            <button type="button" className="op-btn" onClick={turnOn} disabled={available === null}>Turn on Face ID / fingerprint</button>
          )}
          {message ? <p className={message.tone === 'ok' ? 'op-success' : 'op-error'} role="status">{message.text}</p> : null}
        </section>
      </div>

      {changing ? (
        <SetPassword
          onCancel={() => setChanging(false)}
          onDone={() => { setChanging(false); setMessage({ tone: 'ok', text: 'Password changed.' }); }}
        />
      ) : null}

      <div className="op-actions op-actions--end">
        {!changing && session.user.email ? (
          <button type="button" className="op-btn op-btn--ghost" onClick={() => setChanging(true)}>Change password</button>
        ) : null}
        <button type="button" className="op-btn op-btn--ghost" onClick={() => navigate('/app')}>Back to riding</button>
        <button type="button" className="op-btn op-btn--ghost" onClick={onSignOut}>Sign out</button>
      </div>
    </>
  );
}
