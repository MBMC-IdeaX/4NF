// Sign-in for an installed app. Someone who opens an app has already chosen
// it: the form comes first, filling the first screen, and nothing above it
// argues for the product. On a wide screen the bus sits beside the form.

import '../styles/tokens.css';
import { useSignIn } from '../portals/shared/SignIn';
import { Button, Field, Note, Plate } from './index';
import './sign-in.css';

const SAMPLE_PLATE = { province: 'बा', number: '२', series: 'ख', digits: '४४१२' };

export default function AppSignIn({ embedded, app, title, lead, redirectPath, allowPhone = false, signUpLabel = 'Create an account', noSignUp = false }) {
  const s = useSignIn(redirectPath);
  const signingUp = s.mode === 'up';

  return (
    <div className={embedded ? 'bx-auth bx-auth--embedded' : 'bx bx-auth'}>
      <div className="bx-auth__col">
        {embedded ? null : <header className="bx-auth__brand">
          <span className="bx-top__mark">भाडा</span>
          <span className="bx-auth__app">{app}</span>
        </header>}

        <main className="bx-auth__form">
          <h1 className="bx-auth__title">{signingUp ? 'खाता खोल्नुहोस्' : title}</h1>
          <p className="bx-auth__lead">{signingUp ? 'One account for your company. You can add buses after.' : lead}</p>

          {allowPhone ? (
            <div className="bx-seg bx-auth__via" role="group" aria-label="Sign in with">
              <button type="button" aria-pressed={s.via === 'email'} onClick={() => { s.setVia('email'); s.reset(); }}>Email</button>
              <button type="button" aria-pressed={s.via === 'phone'} onClick={() => { s.setVia('phone'); s.reset(); }}>Mobile</button>
            </div>
          ) : null}

          {s.via === 'email' ? (
            <form className="bx-stack" onSubmit={s.submitEmail}>
              <Field label="इमेल · Email">
                <input className="bx-input" type="email" value={s.email} onChange={(e) => s.setEmail(e.target.value)} autoComplete="email" required autoFocus />
              </Field>
              <Field label="पासवर्ड · Password" hint={signingUp ? 'At least 8 characters.' : undefined}>
                <input className="bx-input" type="password" value={s.password} onChange={(e) => s.setPassword(e.target.value)}
                  autoComplete={signingUp ? 'new-password' : 'current-password'} minLength={signingUp ? 8 : undefined} required />
              </Field>
              {s.error ? <Note tone="bad">{s.error}</Note> : null}
              {s.note ? <Note tone="ok">{s.note}</Note> : null}
              <Button type="submit" size="lg" block busy={s.busy}>{signingUp ? 'Create account' : 'Sign in'}</Button>
              {!signingUp ? (
                <button type="button" className="bx-auth__link" onClick={s.forgot} disabled={s.busy}>Forgot password?</button>
              ) : null}
            </form>
          ) : (
            <form className="bx-stack" onSubmit={s.codeSent ? s.verifyCode : s.sendCode}>
              <Field label="मोबाइल · Mobile number">
                <div className="bx-auth__prefixed">
                  <span>+977</span>
                  <input className="bx-input" value={s.phone} onChange={(e) => s.setPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 10))}
                    inputMode="tel" autoComplete="tel-national" disabled={s.codeSent} required autoFocus />
                </div>
              </Field>
              {s.codeSent ? (
                <Field label="कोड · Code">
                  <input className="bx-input" value={s.code} onChange={(e) => s.setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric" autoComplete="one-time-code" required />
                </Field>
              ) : null}
              {s.error ? <Note tone="bad">{s.error}</Note> : null}
              {s.note ? <Note tone="ok">{s.note}</Note> : null}
              <Button type="submit" size="lg" block busy={s.busy}>{s.codeSent ? 'Verify and sign in' : 'Send code'}</Button>
              {s.codeSent ? (
                <button type="button" className="bx-auth__link" onClick={() => { s.setCodeSent(false); s.setCode(''); s.reset(); }}>Use a different number</button>
              ) : null}
            </form>
          )}
        </main>

        {noSignUp ? null : <footer className="bx-auth__switch">
          <span>{signingUp ? 'Already have an account?' : 'New here?'}</span>
          <button type="button" className="bx-auth__link" onClick={() => { s.setMode(signingUp ? 'in' : 'up'); s.reset(); }}>
            {signingUp ? 'Sign in' : signUpLabel}
          </button>
        </footer>}
      </div>

      {embedded ? null : <aside className="bx-auth__side" aria-hidden="true">
        <Plate plate={SAMPLE_PLATE} size={64} />
        <p>Every bus, every rupee, settled once.</p>
      </aside>}
    </div>
  );
}
