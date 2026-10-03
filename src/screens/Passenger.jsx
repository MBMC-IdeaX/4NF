// Passenger surface: a ticket stub.
//
// Pick where you got on and where you get off, and the stub prices it from the
// locally cached regulated fare table, halves it if the account carries a
// concession, signs it, and draws it. None of that needs a network.

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { loadIdentity, recordPayment, setConcession, shortKey } from '../device/identity';
import { syncPassenger, syncConfigured } from '../device/sync';
import { buildToken, signToken } from '../../protocol/token.mjs';
import { offlineAllowance, canPayOffline, OFFLINE_SPEND_CAP } from '../../protocol/policy.mjs';
import { rupees, stop, STOPS } from '../lib/nepali';
import { loadFareTable, refreshFareTable, fareFor, onwardStops } from '../lib/fares';
import { announceSent } from '../lib/voice';
import { currentVehicle } from '../device/fleet';

// The bus this device is provisioned for. A phone moved to another vehicle
// is re-provisioned, not rebuilt.
// Provisioned per device, read at the moment of use.
const conductorId = () => currentVehicle().id;
const SLOT = 50; // one punch on the offline card

export default function Passenger({ onBack }) {
  const [identity, setIdentity] = useState(null);
  const [fareTable, setFareTable] = useState(null);
  const [boarding, setBoarding] = useState('RATNAPARK');
  const [alighting, setAlighting] = useState('KOTESHWOR');
  const [picking, setPicking] = useState(null); // 'boarding' | 'alighting' | null
  const [ticket, setTicket] = useState(null);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState(null);

  useEffect(() => {
    loadIdentity().then(setIdentity).catch((problem) => setError(problem.message));
    loadFareTable().then(setFareTable);
    // Opportunistic only. A failure here never blocks a payment.
    refreshFareTable().then((outcome) => {
      if (outcome.refreshed) loadFareTable().then(setFareTable);
    });
  }, []);

  // Choosing a boarding stop past the current alighting stop would price a
  // journey that runs backwards, so the alighting stop moves with it.
  function chooseBoarding(code) {
    setBoarding(code);
    setTicket(null);
    const onward = onwardStops(code);
    if (!onward.some((s) => s.code === alighting)) {
      setAlighting(onward[onward.length - 1]?.code ?? code);
    }
    setPicking(null);
  }

  function chooseAlighting(code) {
    setAlighting(code);
    setTicket(null);
    setPicking(null);
  }

  async function pay(fare) {
    setError(null);
    const allowance = offlineAllowance({
      unsettledTotal: identity.unsettledTotal,
      lastSettlementAt: identity.lastSettlementAt,
    });
    const check = canPayOffline(fare.amount, allowance);
    if (!check.allowed) {
      setError(check.message);
      return;
    }
    if (identity.balance < fare.amount) {
      setError(`Balance is Rs ${identity.balance}. Top up before paying Rs ${fare.amount}.`);
      return;
    }

    const token = buildToken({
      passengerPublicKey: identity.publicKey,
      conductorId: conductorId(),
      amount: fare.amount,
      boardingStop: boarding,
      alightingStop: alighting,
      sequenceNumber: identity.sequenceNumber + 1,
    });
    const qrText = signToken(token, identity.secretKey);

    setIdentity(await recordPayment({ token, qrText, tripFare: fare.amount }));
    // Error correction M stays readable on a dim screen without inflating the
    // module count, which is what makes a code hard to read at an angle.
    const image = await QRCode.toDataURL(qrText, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 640,
      color: { dark: '#16130fff', light: '#ffffffff' },
    });
    setTicket({ qrText, token, image });
    // The passenger is holding the phone out for the conductor, not reading it.
    announceSent(token.amount);
  }

  async function settle() {
    setSyncing(true);
    setSyncNote(null);
    try {
      const outcome = await syncPassenger();
      setIdentity(await loadIdentity());
      setSyncNote(
        outcome.cleared === 0
          ? 'Nothing left to settle.'
          : `Settled ${outcome.cleared} fares. Offline spending is free again.`,
      );
    } catch (problem) {
      setSyncNote(`Could not reach the server. ${problem.message} Your fares are still saved.`);
    } finally {
      setSyncing(false);
    }
  }

  if (!identity || !fareTable) {
    return (
      <div className="stub-page">
        <div className="stub">
          <p className="stub__empty">{error ?? 'Opening your account.'}</p>
        </div>
      </div>
    );
  }

  if (picking) {
    return (
      <StopPicker
        key={picking}
        title={picking === 'boarding' ? 'कहाँबाट चढ्ने' : 'कहाँ ओर्लने'}
        subtitle={picking === 'boarding' ? 'Where you got on' : 'Where you get off'}
        options={picking === 'boarding' ? STOPS : onwardStops(boarding)}
        chosen={picking === 'boarding' ? boarding : alighting}
        fareTable={fareTable}
        from={picking === 'alighting' ? boarding : null}
        concession={identity.concession}
        onPick={picking === 'boarding' ? chooseBoarding : chooseAlighting}
        onCancel={() => setPicking(null)}
      />
    );
  }

  const allowance = offlineAllowance({
    unsettledTotal: identity.unsettledTotal,
    lastSettlementAt: identity.lastSettlementAt,
  });
  const slots = OFFLINE_SPEND_CAP / SLOT;
  const spent = Math.min(slots, Math.ceil(identity.unsettledTotal / SLOT));
  const fare = fareFor(fareTable, boarding, alighting, identity.concession);

  return (
    <div className="stub-page">
      <div className="stub">
        <div className="stub__head">
          <div className="stub__wordmark">भाडा Bhada</div>
          <div className="stub__serial tabular">{shortKey(identity.publicKey)}</div>
        </div>

        <div className="stub__route">
          <StopField
            label="चढ्ने / Boarding"
            code={boarding}
            onPress={() => setPicking('boarding')}
          />
          <StopField
            label="ओर्लने / Alighting"
            code={alighting}
            onPress={() => setPicking('alighting')}
          />
        </div>

        <div className="perf" />

        <div className="stub__window">
          {ticket ? (
            <img src={ticket.image} alt={`Fare ticket for ${rupees(ticket.token.amount)}`} />
          ) : (
            <p className="stub__empty">
              Tap pay below, then hold the screen up for the conductor to scan.
            </p>
          )}
        </div>

        <div className="perf" />

        <div className="stub__fare">
          <div className="stub__amount tabular">
            {rupees(ticket ? ticket.token.amount : fare?.amount ?? 0)}
            <small>
              {fare?.discounted ? (
                <>
                  Half fare, {identity.concession}. Full Rs {fare.base}
                  <br />
                </>
              ) : null}
              Balance Rs {identity.balance}
            </small>
          </div>
          <div className="stub__seq tabular">
            {ticket ? `टिकट नं. ${ticket.token.sequenceNumber}` : 'टिकट बनेको छैन'}
            <br />
            {ticket ? `Ticket no. ${ticket.token.sequenceNumber}` : 'No ticket yet'}
          </div>
        </div>

        <div className="concession">
          <div className="concession__label">भाडा दर / Fare rate</div>
          <div className="concession__options">
            {[
              { key: 'none', ne: 'पूरा', en: 'Full' },
              { key: 'student', ne: 'विद्यार्थी', en: 'Student' },
              { key: 'senior', ne: 'ज्येष्ठ', en: 'Senior' },
            ].map((option) => (
              <button
                type="button"
                key={option.key}
                className={`concession__option${identity.concession === option.key ? ' is-on' : ''}`}
                onClick={async () => {
                  setTicket(null);
                  setIdentity(await setConcession(option.key));
                }}
              >
                {option.ne}
                <small>{option.en}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="punch">
          <div className="punch__label">
            Offline spend left Rs {allowance.remaining} of Rs {allowance.cap}
          </div>
          <div className="punch__slots">
            {Array.from({ length: slots }, (_, index) => (
              <div
                key={index}
                className={`punch__slot${index < spent ? ' punch__slot--spent' : ''}`}
              />
            ))}
          </div>
        </div>
      </div>

      {error ? <p className="notice">{error}</p> : null}
      {syncNote ? <p className="notice notice--quiet">{syncNote}</p> : null}

      <button
        type="button"
        className="action"
        onClick={() => pay(fare)}
        disabled={!fare || Boolean(ticket)}
      >
        {ticket ? 'टिकट तयार छ' : `${rupees(fare?.amount ?? 0)} तिर्नुहोस्`}
        <small>
          {ticket ? 'Show this to the conductor' : `Pay the ${fare?.amount ?? 0} rupee fare`}
        </small>
      </button>

      {syncConfigured() && identity.unsettledTotal > 0 ? (
        <button
          type="button"
          className={`action action--quiet${syncing ? ' action--working' : ''}`}
          onClick={settle}
          disabled={syncing}
        >
          {syncing ? 'Settling' : `Settle Rs ${identity.unsettledTotal} now`}
        </button>
      ) : null}
      <button type="button" className="action action--quiet" onClick={onBack}>
        Change role
      </button>
    </div>
  );
}

function StopField({ label, code, onPress }) {
  const s = stop(code);
  return (
    <button type="button" className="field field--button" onClick={onPress}>
      <span className="field__label">{label}</span>
      <span className="field__value">
        {s.ne}
        <small>{s.en}</small>
      </span>
    </button>
  );
}

/*
  A full-screen list, not a dropdown. A dropdown on a moving bus is a fiddly
  target; full-width rows are not. Each row carries its own fare, so choosing a
  stop and knowing the price are the same glance.
*/
function StopPicker({ title, subtitle, options, chosen, fareTable, from, concession, onPick, onCancel }) {
  return (
    <div className="picker screen">
      <div className="picker__head">
        <div className="picker__title">{title}</div>
        <div className="picker__subtitle">{subtitle}</div>
      </div>
      <div className="picker__list">
        {options.map((s) => {
          const fare = from ? fareFor(fareTable, from, s.code, concession) : null;
          return (
            <button
              type="button"
              key={s.code}
              className={`picker__row${s.code === chosen ? ' picker__row--chosen' : ''}`}
              onClick={() => onPick(s.code)}
            >
              <span className="picker__name">
                {s.ne}
                <small>{s.en}</small>
              </span>
              {fare ? <span className="picker__fare tabular">{rupees(fare.amount)}</span> : null}
            </button>
          );
        })}
      </div>
      <button type="button" className="action action--quiet" onClick={onCancel}>
        Keep the current stop
      </button>
    </div>
  );
}
