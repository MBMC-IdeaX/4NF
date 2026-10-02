import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadVehicle } from './device/fleet';
import Crashed from './components/Crashed';
import { watchErrors } from './lib/report';
import './styles/app.css';
import './styles/surfaces.css';
// Turns the public site over to the same light, rounded register as the
// portals. Loaded last; see the note at its head.
import './styles/site-app.css';
import './styles/meter.css';

/*
  Which bus this device is provisioned for, before anything renders.

  Every surface names the vehicle in something it signs — a tap, a pass, a
  receipt — so resolving it first means no screen has to handle the moment
  before the answer arrives. It is one IndexedDB read and it never fails: an
  unprovisioned device gets the default and is a working demo.
*/
// Crashes outside React (a handler, a promise nobody awaited) are reported from
// here; crashes during a render are caught by <Crashed>.
watchErrors();

loadVehicle().finally(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <Crashed>
        <App />
      </Crashed>
    </StrictMode>,
  );
});
