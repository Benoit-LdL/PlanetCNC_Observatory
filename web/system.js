// The /system page: follows the machine state (for the E-stop button and the update dot in the
// menu) and runs the System panel from system-ui.js.
import { initSystem, systemOnState } from './system-ui.js';
import { navOnState } from './nav.js';

const $ = (id) => document.getElementById(id);

async function poll() {
  try {
    const s = await (await fetch('/api/state', { cache: 'no-store' })).json();
    systemOnState(s);
    navOnState(s);
    if (s.machine_name) {
      $('machineName').textContent = s.machine_name;
      document.title = s.machine_name + ' – system';
    }
  } catch {
    systemOnState({});   // server unreachable: the E-stop shows it can't be used from here
  }
  setTimeout(poll, document.hidden ? 5000 : 1000);
}

initSystem();
poll();
