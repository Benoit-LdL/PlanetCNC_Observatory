// The top bar's and the menu's live parts, the same on every page. The menu itself is drawn by
// topbar-boot.js while the page loads; this keeps the update dot, the machine name and the
// Raspberry Pi's health rings current, and remembers what they show (sessionStorage) so the next
// page starts with the same picture.

const nav = document.getElementById('pagenav');
const GB = 1024 ** 3;

/** Remember part of the top bar for the next page (see topbar-boot.js). */
export function saveTopbar(patch) {
  try {
    const c = JSON.parse(sessionStorage.getItem('topbar') || '{}');
    sessionStorage.setItem('topbar', JSON.stringify(Object.assign(c, patch)));
  } catch { /* no storage: the next page just starts plain */ }
}

/** The Pi's health (state.system) as rings: CPU, memory, temperature, disk, each with the level
 *  it warns at (amber) and at which it is bad (red), and the power flags from the Pi's firmware. */
export function piHealth(sys) {
  if (!sys) return null;
  const ring = (key, label, frac, value, unit, tip, warnAt, errAt, warnWord, errWord) => {
    if (frac == null || Number.isNaN(frac)) return null;
    const level = frac >= errAt ? 'err' : frac >= warnAt ? 'warn' : '';
    return { key, label, frac, value, unit, level, tip: tip + (level ? ` – ${level === 'err' ? errWord : warnWord}` : '') };
  };
  const gb = (used, total) => `${(used / GB).toFixed(1)} of ${(total / GB).toFixed(1)} GB`;
  const gauges = [
    sys.cpu == null ? null
      : ring('cpu', 'CPU', sys.cpu / 100, Math.round(sys.cpu), '%', `CPU ${Math.round(sys.cpu)} %`, 0.8, 0.95, 'busy', 'busy'),
    !sys.mem_total ? null
      : ring('mem', 'RAM', sys.mem_used / sys.mem_total, Math.round(100 * sys.mem_used / sys.mem_total), '%',
        `Memory ${gb(sys.mem_used, sys.mem_total)}`, 0.85, 0.95, 'high', 'full'),
    // The ring spans 20–90 °C; the Pi slows itself down from about 80 °C.
    sys.temp == null ? null
      : ring('temp', 'Temp', (sys.temp - 20) / 70, Math.round(sys.temp), '°', `Temperature ${Math.round(sys.temp)} °C`,
        (70 - 20) / 70, (80 - 20) / 70, 'warm', 'hot'),
    !sys.disk_total ? null
      : ring('disk', 'Disk', sys.disk_used / sys.disk_total, Math.round(100 * sys.disk_used / sys.disk_total), '%',
        `Disk ${gb(sys.disk_used, sys.disk_total)}`, 0.85, 0.95, 'high', 'full'),
  ].filter(Boolean);
  // vcgencmd get_throttled bits: 0 under-voltage, 1 frequency capped, 2 throttled, 3 soft temp limit;
  // bits 16-19 = the same "has happened since boot".
  const t = sys.throttled;
  const power = t == null ? null
    : t & 0x1 ? { level: 'err', text: 'Under-voltage!' }
    : t & 0x6 ? { level: 'warn', text: 'Throttled' }
    : t & 0x8 ? { level: 'warn', text: 'Temperature limit' }
    : t & 0x10000 ? { level: 'warn', text: 'Under-voltage since boot' }
    : t & 0xE0000 ? { level: 'warn', text: 'Throttled since boot' }
    : { level: '', text: 'Power OK' };
  let up = '';
  if (sys.uptime != null) {
    const d = Math.floor(sys.uptime / 86400), h = Math.floor((sys.uptime % 86400) / 3600), m = Math.floor((sys.uptime % 3600) / 60);
    up = 'Up ' + (d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`);
  }
  return { gauges, power, up, throttled: t };
}

/** The Pi rings everywhere they are, and the dashboard's Pi card (shown on a phone only). */
function renderPi(pi) {
  window.piGauges?.(pi);
  const card = document.getElementById('sys');
  if (card) {
    card.hidden = !pi;
    if (pi) {
      document.getElementById('sysUptime').textContent = pi.up;
      const power = document.getElementById('sysPower');
      power.hidden = !pi.power;
      if (pi.power) {
        power.dataset.level = pi.power.level;
        power.textContent = pi.power.text;
        power.title = 'vcgencmd get_throttled = 0x' + pi.throttled.toString(16);
      }
    }
  }
  saveTopbar({ pi });
}

/** Show on the System item whether updates are waiting, the machine's name and the Pi's health
 *  (from /api/state). */
export function navOnState(s) {
  if (s?.machine_name) {
    const el = document.getElementById('machineName');
    if (el) el.textContent = s.machine_name;
  }
  if (s && 'system' in s) renderPi(piHealth(s.system));
  const link = nav?.querySelector('[data-nav=system]');
  if (!link || !s) return;
  const appN = s.update?.behind || 0, osN = s.os_updates || 0;
  link.querySelector('.nav-dot').hidden = !(appN || osN);
  const parts = [];
  if (appN) parts.push(`app update available (${appN} change${appN === 1 ? '' : 's'})`);
  if (osN) parts.push(`${osN} OS package update${osN === 1 ? '' : 's'}`);
  link.title = 'Versions, updates, the Raspberry Pi' + (parts.length ? ' – ' + parts.join(', ') : '');
  saveTopbar({ dot: !!(appN || osN), ...(s.machine_name ? { name: s.machine_name } : {}) });
}

/** For pages without the dashboard's live connection: fetch the machine state every second
 *  (every 5 s while the page is hidden) and pass it on; an empty state when the server is
 *  unreachable, so the status shows Offline and the E-stop can't be pressed from here. */
export function followState(onState, page) {
  const tick = async () => {
    let s = {};
    try {
      s = await (await fetch('/api/state', { cache: 'no-store' })).json();
      navOnState(s);
      if (s.machine_name) document.title = (page ? page + ' – ' : '') + s.machine_name;
    } catch { /* offline */ }
    onState(s);
    setTimeout(tick, document.hidden ? 5000 : 1000);
  };
  tick();
}
