// A password field with a Show / Hide button, used by every sign-in and
// password form. Typing a password on a phone in a moving bus is hard enough
// without being unable to see what was typed.

import { useState } from 'react';
import './password-input.css';

export default function PasswordInput({ className = '', ...props }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="bx-pw">
      <input {...props} className={className} type={shown ? 'text' : 'password'} />
      <button
        type="button"
        className="bx-pw__toggle"
        onClick={() => setShown((on) => !on)}
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </span>
  );
}
