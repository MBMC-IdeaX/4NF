// What every one of the four builds does before its first render: report
// crashes, move an old link to where it now lives, open its own on-device
// database, and resolve which bus this device is provisioned for.
//
// The vehicle is read first so no screen has to handle the moment before the
// answer arrives. It is one IndexedDB read and it never fails: an unprovisioned
// device gets the default and is a working demo.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadVehicle } from '../device/fleet';
import { setDatabaseName } from '../storage/db';
import Crashed from '../components/Crashed';
import { watchErrors } from '../lib/report';
import { followRedirect } from '../lib/router';

export async function boot(App, { database, before } = {}) {
  watchErrors();
  if (!followRedirect()) return;
  if (database) setDatabaseName(database);
  if (before) await before().catch(() => {});
  await loadVehicle().catch(() => {});
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <Crashed>
        <App />
      </Crashed>
    </StrictMode>,
  );
}
