// Setting a new password after following a reset link.
//
// Supabase signs the person in from the link and announces PASSWORD_RECOVERY;
// until they choose a new password, every portal shows this instead of its
// dashboard.

import { useEffect, useState } from 'react';
import { supabase, supabaseConfigured } from '../../lib/supabase';
import PasswordInput from '../../ui/PasswordInput';

export function usePasswordRecovery() {
  const [recovering, setRecovering] = useState(
    () => typeof window !== 'undefined' && /type=recovery/.test(window.location.hash),
  );

  useEffect(() => {
    if (!supabaseConfigured) return undefined;
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return [recovering, () => setRecovering(false)];
}

export function SetPassword({ onDone, onCancel }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setError(null);
    if (password !== again) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    const { error: problem } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (problem) { setError(problem.message); return; }
    window.history.replaceState({}, '', window.location.pathname);
    onDone();
  }

  return (
    <div className="op-auth">
      <div className="op-auth__pitch">
        <h1>नयाँ पासवर्ड</h1>
        <p>Choose a new password. You stay signed in on this device afterwards.</p>
      </div>
      <form className="op-sheet" onSubmit={submit}>
        <h2>
          पासवर्ड फेर्नुहोस्
          <small>Set a new password</small>
        </h2>
        <div className="op-form">
          <label className="op-field">
            <span>नयाँ पासवर्ड / New password</span>
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password" minLength={8} required />
            <small className="op-field__help">At least 8 characters.</small>
          </label>
          <label className="op-field">
            <span>फेरि / Again</span>
            <PasswordInput value={again} onChange={(e) => setAgain(e.target.value)}
              autoComplete="new-password" minLength={8} required />
          </label>
          {error ? <p className="op-error" role="alert">{error}</p> : null}
          <button type="submit" className="op-btn op-btn--block" disabled={busy}>
            {busy ? 'Saving…' : 'Save new password'}
          </button>
          {onCancel ? <button type="button" className="op-link" onClick={onCancel}>Cancel</button> : null}
        </div>
      </form>
    </div>
  );
}
