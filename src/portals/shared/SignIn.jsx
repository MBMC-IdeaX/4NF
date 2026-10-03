// Sign in or create an account, by email and password or by a code sent to a
// phone. The phone path needs an SMS provider switched on in Supabase Auth;
// until then Supabase answers with an error, which is shown as it is.

import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import Icon from './Icon';

// The sign-in state and calls, shared by this office screen and the app
// sign-in (src/ui/AppSignIn.jsx), so there is one way to sign in.
/*
  Supabase Auth's own messages, in words a rider or an owner can act on. The
  rate limit is the one people hit: the built-in mailer sends only a few
  confirmation emails an hour until the project has its own SMTP.
*/
export function authMessage(message = '') {
  if (/rate limit/i.test(message)) {
    return 'Too many sign-up emails were sent in the last hour, so a new one cannot go out yet. Try again in an hour, or sign in if you already have an account.';
  }
  if (/already registered|already been registered/i.test(message)) return 'This email already has an account. Sign in instead.';
  if (/invalid login credentials/i.test(message)) return 'That email and password do not match.';
  if (/email not confirmed/i.test(message)) return 'Open the confirmation link we emailed you, then sign in.';
  return message;
}

export function useSignIn(redirectPath) {
  const [via, setVia] = useState('email'); // 'email' | 'phone'
  const [mode, setMode] = useState('in'); // 'in' | 'up'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const reset = () => { setError(null); setNote(null); };

  async function forgot() {
    reset();
    if (!email) { setError('Enter your email above, then press Forgot password.'); return; }
    setBusy(true);
    const { error: problem } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${redirectPath}`,
    });
    setBusy(false);
    if (problem) setError(authMessage(problem.message));
    else setNote(`If ${email} has an account, a reset link is on its way.`);
  }

  async function submitEmail(event) {
    event.preventDefault();
    reset();
    setBusy(true);
    const { data, error: problem } = mode === 'in'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({
        email,
        password,
        // Supabase honours this only for hosts on the project's redirect list.
        options: { emailRedirectTo: `${window.location.origin}${redirectPath}` },
      });
    setBusy(false);
    if (problem) { setError(authMessage(problem.message)); return; }
    if (mode === 'up' && !data.session) {
      setNote(`Account created. We sent a link to ${email} — open it, then sign in here.`);
      setMode('in');
    }
  }

  // Nepali mobile numbers are ten digits starting 97 or 98.
  const e164 = `+977${phone.replace(/\D/g, '').replace(/^977/, '')}`;

  async function sendCode(event) {
    event.preventDefault();
    reset();
    if (!/^\+9779[78]\d{8}$/.test(e164)) {
      setError('Enter a ten-digit Nepali mobile number, like 98XXXXXXXX.');
      return;
    }
    setBusy(true);
    const { error: problem } = await supabase.auth.signInWithOtp({ phone: e164 });
    setBusy(false);
    if (problem) {
      setError(/provider|sms|phone/i.test(problem.message)
        ? 'Phone sign-in is not switched on yet. Use email for now.'
        : authMessage(problem.message));
      return;
    }
    setCodeSent(true);
    setNote(`We sent a six-digit code to ${e164}.`);
  }

  async function verifyCode(event) {
    event.preventDefault();
    reset();
    setBusy(true);
    const { error: problem } = await supabase.auth.verifyOtp({ phone: e164, token: code.trim(), type: 'sms' });
    setBusy(false);
    if (problem) setError(authMessage(problem.message));
  }

  return {
    via, setVia, mode, setMode, email, setEmail, password, setPassword, phone, setPhone,
    code, setCode, codeSent, setCodeSent, busy, error, note, reset, forgot, submitEmail, sendCode, verifyCode, e164,
  };
}

export default function SignIn({ title, subtitle, pitch, redirectPath, allowPhone = false }) {
  const {
    via, setVia, mode, setMode, email, setEmail, password, setPassword, phone, setPhone,
    code, setCode, codeSent, setCodeSent, busy, error, note, reset, forgot, submitEmail, sendCode, verifyCode, e164,
  } = useSignIn(redirectPath);

  return (
    <div className="op-auth">
      <div className="op-auth__pitch">{pitch}</div>

      <div className="op-sheet">
        <h2>
          {title}
          <small>{subtitle}</small>
        </h2>

        {allowPhone ? (
          <div className="op-segment" role="tablist" aria-label="Sign in with">
            <button type="button" role="tab" aria-selected={via === 'email'} onClick={() => { setVia('email'); reset(); }}>Email</button>
            <button type="button" role="tab" aria-selected={via === 'phone'} onClick={() => { setVia('phone'); reset(); }}>Mobile number</button>
          </div>
        ) : null}

        {via === 'email' ? (
          <form className="op-form" onSubmit={submitEmail}>
            <label className="op-field">
              <span>इमेल / Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                autoComplete="email" placeholder="you@example.com" required />
            </label>
            <label className="op-field">
              <span>पासवर्ड / Password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'in' ? 'current-password' : 'new-password'} minLength={mode === 'up' ? 8 : undefined} required />
              {mode === 'up' ? <small className="op-field__help">At least 8 characters.</small> : null}
            </label>
            {error ? <p className="op-error" role="alert"><Icon name="alert" size={18} />{error}</p> : null}
            {note ? <p className="op-success" role="status"><Icon name="check" size={18} />{note}</p> : null}
            <button type="submit" className="op-btn op-btn--primary op-btn--block op-btn--lg" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : 'Create account'}
            </button>
            {mode === 'in' ? (
              <button type="button" className="op-link" onClick={forgot} disabled={busy}>Forgot password?</button>
            ) : null}
            <button type="button" className="op-link" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); reset(); }}>
              {mode === 'in' ? 'New here? Create an account' : 'Already have an account? Sign in'}
            </button>
          </form>
        ) : (
          <form className="op-form" onSubmit={codeSent ? verifyCode : sendCode}>
            <label className="op-field">
              <span>मोबाइल नम्बर / Mobile number</span>
              <div className="op-prefixed">
                <em>+977</em>
                <input value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 10))}
                  inputMode="tel" autoComplete="tel-national" placeholder="98XXXXXXXX" disabled={codeSent} required />
              </div>
            </label>
            {codeSent ? (
              <label className="op-field">
                <span>कोड / Code</span>
                <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required />
              </label>
            ) : null}
            {error ? <p className="op-error" role="alert"><Icon name="alert" size={18} />{error}</p> : null}
            {note ? <p className="op-success" role="status"><Icon name="check" size={18} />{note}</p> : null}
            <button type="submit" className="op-btn op-btn--primary op-btn--block op-btn--lg" disabled={busy}>
              {busy ? 'Please wait…' : codeSent ? 'Verify and sign in' : 'Send code'}
            </button>
            {codeSent ? (
              <button type="button" className="op-link" onClick={() => { setCodeSent(false); setCode(''); reset(); }}>
                Use a different number
              </button>
            ) : null}
          </form>
        )}
      </div>
    </div>
  );
}
