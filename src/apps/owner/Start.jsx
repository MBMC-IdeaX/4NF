// A signed-in login with no company yet. Companies do not sign themselves up:
// Bhada visits, signs the agreements and checks the papers, then gives the
// owner a code (0038). Managers, bus owners and conductors get theirs from the
// owner. Either way, this is where the code goes.

import { useState } from 'react';
import { Button, Field, Note } from '../../ui';
import { call, say } from './data';

export default function Start({ email, onDone }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await call('accept_invite', { p_code: code, p_display_name: name.trim() || null });
    setBusy(false);
    if (!result?.ok) { setError(say(result)); return; }
    onDone();
  }

  return (
    <div className="ow" style={{ maxWidth: 520 }}>
      <header className="ow-head">
        <div>
          <p className="bx-eyebrow">सुरु गर्नुहोस् · Join your company</p>
          <h1>Enter your code</h1>
          <p>Signed in as {email}. The code says which company you join and what you can see there.</p>
        </div>
      </header>

      <form className="bx-stack" onSubmit={submit}>
        <Field label="कोड · Invite code" hint="Ten letters and numbers. Spaces and dashes do not matter.">
          <input className="bx-input ow-code" style={{ fontSize: '1.3rem' }} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoCapitalize="characters" autoComplete="off" required autoFocus />
        </Field>
        <Field label="नाम · Your name" hint="As your company knows you. Optional.">
          <input className="bx-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={60} />
        </Field>
        {error ? <Note tone="bad">{error}</Note> : null}
        <Button type="submit" size="lg" block busy={busy} disabled={code.replace(/[^A-Za-z0-9]/g, '').length < 10}>Join</Button>
      </form>

      <Note>
        <b>No code yet?</b> A bus company joins Bhada through a visit: Bhada signs the service agreement with you, checks your company’s papers and enters your buses from their bluebooks and route permits, then gives the owner a code.
        Call or write to Bhada to arrange it. Managers, bus owners and conductors get their code from the company’s owner.
      </Note>
    </div>
  );
}
