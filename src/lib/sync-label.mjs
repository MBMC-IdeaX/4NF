// What the sync pill says, in both languages. Pure, so it can be tested.

const DIGITS = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
export const ne = (value) => String(value).replace(/\d/g, (d) => DIGITS[Number(d)]);

function ago(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return { ne: 'भर्खरै', en: 'just now' };
  if (minutes < 60) return { ne: `${ne(minutes)} मिनेट अघि`, en: `${minutes} min ago` };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { ne: `${ne(hours)} घण्टा अघि`, en: `${hours} h ago` };
  const days = Math.floor(hours / 24);
  return { ne: `${ne(days)} दिन अघि`, en: `${days} ${days === 1 ? 'day' : 'days'} ago` };
}

export function syncLabel({ online, waiting = 0, syncing, error, lastSyncedAt, nowMs }) {
  if (!online) {
    return waiting
      ? { tone: 'offline', ne: `अफलाइन · ${ne(waiting)} बाँकी`, en: `Offline · ${waiting} waiting` }
      : { tone: 'offline', ne: 'अफलाइन', en: 'Offline' };
  }
  if (syncing) return { tone: 'syncing', ne: `${ne(waiting)} पठाउँदै`, en: `Sending ${waiting}` };
  if (waiting) {
    return error
      ? { tone: 'error', ne: `${ne(waiting)} बाँकी · फेरि प्रयास`, en: `${waiting} waiting · will retry` }
      : { tone: 'waiting', ne: `${ne(waiting)} पठाउन बाँकी`, en: `${waiting} waiting` };
  }
  if (!lastSyncedAt) return { tone: 'synced', ne: 'अद्यावधिक', en: 'Up to date' };
  const when = ago(nowMs - lastSyncedAt);
  return { tone: 'synced', ne: when.ne, en: `Synced ${when.en}` };
}
