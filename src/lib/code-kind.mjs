// What a scanned code is, before anyone tries to verify it.
//
// Every code Bhada prints starts with its version tag, so the kind is known from
// the first field alone. Telling a conductor "this is a ride code, read at the
// door" is useful; "unreadable" for a perfectly good code is how a crew decides
// the scanner is broken.

import { TOKEN_VERSION, FIELD_SEPARATOR } from '../../protocol/token.mjs';
import { TAP_VERSION, LEG_VERSION, GROUP_VERSION, PASS_VERSION } from '../../protocol/leg.mjs';
import { CREW_VERSION } from '../../protocol/crew.mjs';
import { CASH_VERSION } from '../../protocol/cash.mjs';
import { ROSTER_VERSION } from '../../protocol/inspect.mjs';

const BY_TAG = {
  [TOKEN_VERSION]: 'stage-ticket',
  [TAP_VERSION]: 'ride-code',
  [LEG_VERSION]: 'receipt',
  [PASS_VERSION]: 'pass',
  [CREW_VERSION]: 'crew-signon',
  [CASH_VERSION]: 'cash-ticket',
  [ROSTER_VERSION]: 'roster',
};

export const KIND_LABEL = {
  'stage-ticket': { ne: 'टिकट', en: 'stage-fare ticket' },
  'ride-code': { ne: 'यात्रा कोड', en: 'metered ride code' },
  'group-code': { ne: 'समूह कोड', en: 'family ride code' },
  receipt: { ne: 'रसिद', en: 'ride receipt' },
  pass: { ne: 'पास', en: 'boarding pass' },
  'crew-signon': { ne: 'खलासी कोड', en: 'crew sign-on code' },
  'cash-ticket': { ne: 'नगद टिकट', en: 'cash ticket' },
  roster: { ne: 'निरीक्षण कोड', en: 'inspection code' },
  pairing: { ne: 'जोडा कोड', en: 'bus pairing code' },
  'bus-setup': { ne: 'बस सेटअप कोड', en: 'bus setup code from the owner' },
  join: { ne: 'निमन्त्रणा कोड', en: 'company invite code' },
  unknown: { ne: 'अपरिचित कोड', en: 'code Bhada does not know' },
};

export function codeKind(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return 'unknown';
  if (text.startsWith('{')) {
    try {
      const v = JSON.parse(text)?.v;
      // BHSETUP1: the Owner app's one-time code that makes this phone a bus
      // (0034). BHJOIN1: an invite into a company (0033).
      return { BHPAIR1: 'pairing', BHSETUP1: 'bus-setup', BHJOIN1: 'join' }[v] ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
  if (text.startsWith(`${GROUP_VERSION}~`)) return 'group-code';
  const sep = text.indexOf(FIELD_SEPARATOR);
  if (sep < 0) return 'unknown';
  return BY_TAG[text.slice(0, sep)] ?? 'unknown';
}
