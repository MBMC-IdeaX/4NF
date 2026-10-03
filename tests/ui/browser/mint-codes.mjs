// Prints test codes as JSON: real signed tickets plus the QR image of each.
// node tests/ui/browser/mint-codes.mjs > .superpowers/codes.json
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { useRandomSource } from '../../../protocol/random.mjs';
import { createKeypair, buildToken, signToken } from '../../../protocol/token.mjs';

useRandomSource((n) => new Uint8Array(randomBytes(n)));
const keys = createKeypair();
const ticket = (sequenceNumber, conductorId = 'BA2KHA4412') => signToken(buildToken({
  passengerPublicKey: keys.publicKey,
  conductorId,
  amount: 25,
  boardingStop: 'RATNAPARK',
  alightingStop: 'THAPATHALI',
  sequenceNumber,
}), keys.secretKey);

const codes = {
  stage: ticket(1),
  stage2: ticket(2),
  otherBus: ticket(3, 'BA5KHA2087'),
  ride: `BT1|${keys.publicKey}|BA2KHA4412|1|x|sig`,
  junk: 'https://example.com',
};
const out = {};
for (const [name, text] of Object.entries(codes)) {
  out[name] = { text, png: await QRCode.toDataURL(text, { margin: 2, width: 400 }) };
}
console.log(JSON.stringify(out));
