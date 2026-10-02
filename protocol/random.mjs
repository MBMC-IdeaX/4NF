// tweetnacl needs a random source. Node and React Native supply different ones,
// so each device injects its own at startup and the protocol stays platform-free.

import nacl from 'tweetnacl';

let source = null;

export function useRandomSource(randomBytes) {
  if (typeof randomBytes !== 'function') throw new Error('random source must be a function');
  source = randomBytes;
  nacl.setPRNG((buffer, length) => {
    const filled = randomBytes(length);
    for (let i = 0; i < length; i += 1) buffer[i] = filled[i];
  });
}

export function randomBytes(length) {
  if (!source) throw new Error('no random source: call useRandomSource() at app start');
  return source(length);
}
