# Bhada Payment Breach, Fraud Simulation & Defense Matrix
**System Architecture & Threat Model Specification**  
**Jurisdiction:** Kathmandu Valley Transit, Nepal (Bagmati Province Gazetted Tariffs & NRB PSP Act 2075)

---

## 1. Executive Summary

In a transit environment where **85–90% of transactions are cash**, **cellular connectivity is intermittent**, and **operating margins are razor-thin**, payment security cannot rely on naive Web2 client-server trust. Every entity in the ecosystem—**Passenger (यात्रु)**, **Conductor / Khalasi (खलासी)**, and **Bus Owner / Samiti (मालिक)**—has distinct economic incentives to game or bypass the system.

This document specifies the threat model, attack simulations, and cryptographic/hardware defense architecture implemented across the Bhada protocol.

---

## 2. Threat & Vulnerability Simulation Matrix

| # | Threat Vector | Attacking Entity | Attack Mechanism | Real-World Impact | Bhada Defense Architecture |
| :---: | :--- | :--- | :--- | :--- | :--- |
| **01** | **Tap-In & Escape (Unclosed Leg)** | Passenger | Rider taps in at Ratnapark (short hop, Rs 24), rides 16 km to Suryabinayak (Rs 39), but slips out the rear door without tapping out. | System undercharges Rs 15; operator loses revenue on high-distance rides. | **Max Corridor Hold & Exit Refund:** Stanchion validator holds maximum route fare (Rs 50) upon tap-in. When passenger taps out, difference is instantly refunded to exact distance (Rs 24). If passenger runs without tapping out, full Rs 50 is forfeited. |
| **02** | **QR Screenshot Replay ("One Pass for Two Friends")** | Passenger | Rider screenshots valid QR ticket on WhatsApp/Bluetooth to a friend boarding 5 seconds behind them. | Two passengers ride on a single fare. | **In-Flight Public Key Lock + 30s Rolling Nonce:** Stanchion validator locks the passenger's public key into `RIDING` state. Any subsequent tap-in with the same public key is rejected (`refused-replay.mp3`). QR codes rotate every 30 seconds using an Ed25519 time-decaying nonce. |
| **03** | **Clock Manipulation (Time-Spoofing)** | Passenger | Passenger shifts phone system clock back 6 months to make an expired pass or spent balance appear active. | Replay of historical offline allowances. | **Vehicle Hardware RTC as Single Authority:** Stanchion unit uses a battery-backed DS3231 Real-Time Clock and vehicle odometer chainage. Phone clocks are strictly ignored; validity is verified against vehicle RTC. |
| **04** | **DevTools Wallet Forgery & Root Exploit** | Passenger | Tech-savvy passenger edits `identity.balance = 99999` in browser IndexedDB or rooted Android. | Attempting to generate counterfeit tickets. | **Server-Attested Cryptographic Pass Vault:** Validator does not check client balance; it validates cryptographic pass vouchers signed by Bhada server private keys during the last sync. Server ledger settles with eSewa; forged client data fails signature checks. |
| **05** | **Burner SIM Overdraft Evasion** | Passenger | Rider uses Rs 50 overdraft grace, throws away SIM/app, registers fresh guest account for another free ride. | Perpetual leakage of free transit credit. | **KYC-Gated Overdraft:** Guest/anonymous accounts have Rs 0 overdraft limit. Overdraft privileges are only unlocked for accounts verified via eSewa/Khalti KYC or National Identity Card (NID). |
| **06** | **Conductor Cash Pocketing (No Ticket Issued)** | Conductor | Conductor accepts Rs 24 cash from rider, but does not press the terminal button to log a `CT1` ticket. | Conductor pockets fare; operator receives zero cash revenue. | **Door Counter Reconciliation & Value-Share:** Stanchion optical/ToF door sensor logs every physical boarding. Trips with >10% discrepancy forfeit the conductor's 25% clean-trip value-share bonus and trigger an audit flag. |
| **07** | **Physical Hardware Sabotage / Unplugging** | Conductor | Conductor unplugs the meter power cable under the seat or tapes over sensors to claim "machine failure". | Complete disabling of digital & cash auditing. | **Anti-Tamper Supercapacitor Watchdog:** Unit features a backup supercapacitor circuit that logs a signed `POWER_CUT_UNEXPECTED` event before shutdown. If power is severed while GNSS/wheel pulses show motion, the entire shift bonus is cancelled and flagged in the Owner portal. |
| **08** | **Ghost Vehicle / Subsidy Fraud** | Bus Owner | Operator fabricates fake GNSS traces and trip receipts to claim government student/senior concession subsidies. | Government/DoTM subsidy embezzlement. | **Cryptographic Rider Attestation & Doppler Validation:** Trips cannot be fabricated because each leg requires cryptographically signed tokens from unique rider private keys. Odometer traces are audited for physical Doppler speed plausibility (rejecting velocity jumps > 85 km/h). |
| **09** | **Prolonged Offline Storage Saturation** | System | Bus operates for 3–5 days in remote valley fringe (Dakshinkali/Nagdhunga) without cellular sync. | Risk of memory overflow, data corruption, or lost fare journals. | **Append-Only Merkle Journal & Micro-Sync:** Transactions are stored in an append-only hash chain (`Hash_N = SHA256(Hash_N-1 + Payload)`). High-priority journals compress to < 80 KB per shift, auto-syncing during cellular handovers at major terminals (Ratnapark, Gongabu). |
| **10** | **SaaS Subscription Default** | Bus Owner | Owner operates buses but refuses to pay the monthly software fee (NPR 3,000/bus). | Platform revenue default. | **Automated Escrow Deduction:** Bhada automatically deducts the monthly per-bus SaaS fee from the digital fare settlement escrow before releasing net revenue payouts to the company bank account. |

---

## 3. Protocol Enforcement Implementation

### 3.1 Unclosed Leg Policy (`protocol/policy.mjs`)
- **Default Hold Amount:** `MAX_CORRIDOR_HOLD_NPR = 50`
- **Minimum Fare:** `MIN_FARE_NPR = 24`
- **Formula:**
  $$\text{Charged Fare} = \begin{cases} \text{Actual Metered Fare}(\text{distance}) & \text{if Tap-Out verified} \\ \text{MAX\_CORRIDOR\_HOLD\_NPR} & \text{if Unclosed Leg} \end{cases}$$

### 3.2 In-Flight Key Locking (`src/device/terminal.js`)
```javascript
// Door validator locks active passenger public keys
if (activeRiders.has(token.passengerPublicKey)) {
  if (action === 'TAP_IN') {
    announceRefused('replay');
    return { ok: false, reason: 'ALREADY_RIDING' };
  }
}
```

### 3.3 Anti-Tamper Telemetry (`src/device/meter.js`)
- Watches power input pin voltage.
- Dispatches signed event `TAMPER_POWER_CUT` if power drops while odometer velocity $> 0$.
