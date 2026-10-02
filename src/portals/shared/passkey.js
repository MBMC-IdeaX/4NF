// Face ID, fingerprint or screen lock in front of the account, like a banking
// app's biometric unlock.
//
// This is a local gate, and says so: the phone's own authenticator confirms the
// person holding it is its owner, and the result never leaves the phone. No
// face, fingerprint or template is sent anywhere or stored by us — WebAuthn does
// not expose them. The login itself is still the Supabase session; this only
// decides whether the portal opens on this phone without asking again.

const STORE = 'bhada.passkey.';

const bytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const toB64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function read(userId) {
  try {
    return localStorage.getItem(STORE + userId);
  } catch {
    return null;
  }
}

export async function passkeyAvailable() {
  try {
    return Boolean(window.PublicKeyCredential
      && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

export function passkeyEnrolled(userId) {
  return Boolean(userId && read(userId));
}

export async function enrolPasskey({ userId, label }) {
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: bytes(32),
      rp: { name: 'Bhada', id: window.location.hostname },
      user: { id: new TextEncoder().encode(userId).slice(0, 64), name: label, displayName: label },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60000,
    },
  });
  localStorage.setItem(STORE + userId, toB64(credential.rawId));
  return true;
}

export function forgetPasskey(userId) {
  try {
    localStorage.removeItem(STORE + userId);
  } catch {
    // Nothing stored, nothing to forget.
  }
}

// Resolves true only when the authenticator reports the user was verified —
// a face, a fingerprint or the phone's PIN — not merely present.
export async function unlockWithPasskey(userId) {
  const id = read(userId);
  if (!id) return true;
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: bytes(32),
      rpId: window.location.hostname,
      allowCredentials: [{ type: 'public-key', id: fromB64(id) }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  const flags = new Uint8Array(assertion.response.authenticatorData)[32];
  return Boolean(flags & 0x04);
}
