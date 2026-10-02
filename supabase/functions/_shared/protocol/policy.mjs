// Offline spending is bounded, on purpose. A phone that has not settled cannot
// keep paying forever, which is what stops a cloned wallet from draining value.
// These limits are shown to the passenger, not hidden.

export const OFFLINE_SPEND_CAP = 500; // NPR of unsettled fares
export const SETTLEMENT_WINDOW_SECONDS = 24 * 60 * 60;

/*
  The overdraft, and why a fare system has one.

  A wallet that refuses a ride at Rs 5 leaves a person standing at a bus stop in
  the dark. That is not a theoretical cost: the passengers most likely to be at
  Rs 5 are the ones with the least slack to absorb being stranded, and a system
  that does it to them once has taught them that cash is safer. Which it is, for
  them, and that is the adoption problem in one fare.

  So a balance may go two rides negative. Small enough that walking away from
  the debt is not worth anyone's while, since the phone buys nothing until it is
  cleared, and large enough that nobody is left at Koteshwor at ten at night over
  the price of a samosa. A debt, recovered from the next top-up, not a gift.

  Enforced in SQL, not here: settle_leg() and the passengers balance check read
  passengers.overdraft_npr (migration 0018), whose default must equal this.
  proof:legs holds the two together. It applies to metered legs only; the
  stage-fare path still refuses below zero.
*/
export const OVERDRAFT_NPR = 50;

export function offlineAllowance({ unsettledTotal, lastSettlementAt, now = Math.floor(Date.now() / 1000), cap = OFFLINE_SPEND_CAP, window = SETTLEMENT_WINDOW_SECONDS }) {
  const remaining = Math.max(0, cap - unsettledTotal);
  const secondsSinceSettlement = lastSettlementAt ? now - lastSettlementAt : Infinity;
  const settlementOverdue = secondsSinceSettlement > window;
  return {
    remaining,
    cap,
    settlementOverdue,
    secondsUntilSettlementDue: settlementOverdue ? 0 : window - secondsSinceSettlement,
  };
}

export function canPayOffline(fare, allowanceState) {
  if (allowanceState.settlementOverdue) {
    return { allowed: false, reason: 'settlement_due', message: 'Go online once to settle. Offline payment resumes after that.' };
  }
  if (fare > allowanceState.remaining) {
    return { allowed: false, reason: 'cap_reached', message: `Offline limit reached. Rs ${allowanceState.remaining} left of Rs ${allowanceState.cap}.` };
  }
  return { allowed: true };
}

/*
  The clean-trip bonus.

  A conductor under cash keeps whatever they do not ring up. Bhada closes that
  and hands back nothing, which is a system the crew has every reason to break —
  and the break is a ten-second reach under the seat for the meter's plug. So an
  honest trip pays: Rs 50, flat, to the crew member signed on to it.

  Flat rather than a share of the takings, because a flat number is one a
  conductor can hold in their head and argue about, and the argument is the
  point. Rs 50 against eight trips a day is a meaningful fraction of a
  conductor's wage without being large enough to be worth manufacturing trips
  for — which the leg floor below closes anyway.

  The money is not minted. Bhada holds passenger balances and owes the operator
  the fares their vehicles collected; the bonus is Rs 50 moved out of that
  payable into the crew member's wallet. `crew_bonuses` (migration 0025) records
  both sides in the one row.

  What makes a trip clean is `cleanTripVerdict()` in protocol/crew.mjs, judged in
  exactly one place from evidence the backend counts.
*/
export const CLEAN_TRIP_BONUS_NPR = 50;

// A trip that carried nobody is not a clean trip, it is an empty one, and
// paying for it turns the depot yard into a bonus mill.
export const CLEAN_TRIP_MIN_LEGS = 5;

/*
  How much of the door count has to be on the record.

  A door counter (a break-beam at the step) counts bodies; the trip's record is
  its settled rides plus its cash tickets. The difference is people who rode and
  were never recorded — the fare evasion and the skim, in one number. A trip
  whose record covers less than this share of the count earns no bonus, so the
  conductor is paid to make everyone tap or buy a ticket, rather than to look
  away.

  Ninety, not a hundred: a beam double-counts a child on a hip or a bag swung
  through it, and a rule nobody can meet is a rule crews stop trying for.
*/
export const RECORDED_SHARE_MIN_PCT = 90;
