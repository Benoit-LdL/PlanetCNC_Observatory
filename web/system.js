// The /system page: follows the machine state (status, E-stop button, update dot in the menu)
// and runs the System panel from system-ui.js.
import { initSystem, systemOnState } from './system-ui.js';
import { followState } from './nav.js';

initSystem();
followState(systemOnState, 'system');
