import { calculateFare } from "../lib/tariff.js";
import { estimateDistance } from "../data/stops.js";

const routeForm = document.querySelector("#route-form");
const formMessage = document.querySelector("#form-message");

routeForm?.addEventListener("submit", (event) => {
  event.preventDefault();

  const formData = new FormData(routeForm);
  const from = String(formData.get("from") || "").trim();
  const to = String(formData.get("to") || "").trim();
  const hasConcession = formData.get("concession") === "on";

  if (!from || !to) {
    formMessage.innerHTML = `<span style="color: #c53030;">Please specify both departure and destination stops.</span>`;
    return;
  }

  const distanceKm = estimateDistance(from, to);
  const fareResult = calculateFare(distanceKm, hasConcession);

  formMessage.innerHTML = `
    <div style="background: var(--cream); border: 1px solid var(--line); border-radius: 12px; padding: 18px; margin-top: 10px; display: grid; gap: 10px;">
      <div style="display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px dashed var(--line); padding-bottom: 8px;">
        <span style="font-family: var(--display); font-size: 16px; font-weight: 700; color: var(--ink);">
          ${from} &rarr; ${to}
        </span>
        <span style="font-size: 12px; font-weight: 600; color: var(--muted); background: var(--paper); padding: 3px 8px; border-radius: 100px;">
          Approx. ${fareResult.distanceKm} km
        </span>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 0;">
        <div>
          <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 700;">
            ${hasConcession ? "Student / Senior Fare (45% Off)" : "Official Gazetted Fare"}
          </div>
          <div style="font-size: 12px; color: var(--muted); margin-top: 2px;">
            Stage Bracket: ${fareResult.bracketLabel}
          </div>
        </div>
        <div style="font-family: var(--display); font-size: 28px; font-weight: 700; color: #182b26;">
          NPR ${fareResult.effectiveFareNPR}
          ${hasConcession ? `<span style="font-size: 14px; text-decoration: line-through; color: var(--muted); margin-left: 4px;">NPR ${fareResult.standardFareNPR}</span>` : ""}
        </div>
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--muted); background: rgba(217, 232, 117, 0.25); padding: 8px 12px; border-radius: 8px; border-left: 3px solid #182b26;">
        <span><strong>Bhada Verified Protocol:</strong> Gazetted Tariff 2083</span>
        <span>Offline-Ready</span>
      </div>
    </div>
  `;
});