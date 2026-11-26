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

// Air quality (a SEN55 read from Home Assistant, state.air). Each ring: the sensor, its full scale,
// amber from, red from. Dust in µg/m³: amber from the WHO 2021 24-hour guideline (PM2.5 15, PM10 45),
// red from 50 and 100, far above it. VOC and NOx are Sensirion indexes from 1 to 500: VOC 100 is the
// room's usual air, NOx 1 is clean air; both rise with pollution.
const AIR_RINGS = [
  ['pm25', 'PM2.5', 100, 15, 50, 'pm1', 'PM1'],
  ['pm10', 'PM10', 150, 45, 100, 'pm4', 'PM4'],
  ['voc', 'VOC', 500, 150, 250],
  ['nox', 'NOx', 500, 20, 150],
];
const AIR_TIPS = { pm25: 'Fine dust', pm10: 'Dust', voc: 'VOC index (solvents, glue, finishes, burning wood; 100 = usual)',
  nox: 'NOx index (combustion gases; 1 = clean)' };

const fmtAir = (key, v) => v == null ? '–' : key.startsWith('pm') && v < 10 ? v.toFixed(1) : String(Math.round(v));

/** The air quality (state.air) as rings, a status and the temperature and humidity; null when not set up. */
export function airHealth(air) {
  if (!air) return null;
  const vals = air.values || {};
  let worst = 0;
  const gauges = AIR_RINGS.filter(([key]) => vals[key]).map(([key, label, full, warnAt, errAt, alsoKey, alsoLabel]) => {
    const v = vals[key].v;
    const lvl = v == null ? 0 : v >= errAt ? 2 : v >= warnAt ? 1 : 0;
    worst = Math.max(worst, lvl);
    const unit = key.startsWith('pm') ? ' µg/m³' : '';
    let tip = `${label} ${fmtAir(key, v)}${v == null ? ' (no value)' : unit} – ${AIR_TIPS[key]}`;
    if (lvl) tip += lvl === 2 ? ' – bad' : ' – high';
    const also = alsoKey && vals[alsoKey] ? `${alsoLabel} ${fmtAir(alsoKey, vals[alsoKey].v)}${unit}` : '';
    if (also) tip += `\n${also}`;
    // v, also, warnAt and errAt: for the popup that explains the value (topbar-boot.js)
    return { key, label, frac: v == null ? 0 : v / full, value: fmtAir(key, v), unit: '', level: ['', 'warn', 'err'][lvl], tip,
             v, also, warnAt, errAt };
  });
  const t = vals.temp?.v, h = vals.hum?.v;
  // On two lines in the menu (it is narrow), on one in the phone card's title
  const climate = [t != null ? t.toFixed(1) + '°' : '', h != null ? Math.round(h) + ' %' : ''].filter(Boolean).join('\n');
  const status = air.error ? { level: 'err', text: 'No data: ' + air.error }
    : air.age == null ? { level: 'off', text: 'Waiting for Home Assistant' }
    : air.stale ? { level: 'warn', text: `Old data: last reading ${Math.round(air.age)} s ago` }
    : { level: ['', 'warn', 'err'][worst], text: ['Good', 'Elevated', 'Poor'][worst] };
  const title = `Air quality: ${status.text}` + (t != null ? `\nTemperature ${t.toFixed(1)} °C` : '')
    + (h != null ? `\nHumidity ${Math.round(h)} %` : '');
  return { gauges, status, climate, title,
           temp: t != null ? t.toFixed(1) + '°' : null, hum: h != null ? Math.round(h) + ' %' : null };
}

/** The air rings everywhere they are, and the dashboard's Air card (shown on a phone only). */
function renderAir(air) {
  window.airGauges?.(air);
  const card = document.getElementById('airCard');
  if (card) {
    card.hidden = !air;
    if (air) {
      const st = document.getElementById('airCardStatus');
      st.dataset.level = air.status.level;
      st.textContent = air.status.text.split(':')[0];
      st.title = air.status.text;
      document.getElementById('airCardClimate').innerHTML = window.climateHtml(air, ' · ');
    }
  }
  saveTopbar({ air });
}

/** Show on the System item whether updates are waiting, the machine's name and the Pi's health
 *  (from /api/state). */
export function navOnState(s) {
  if (s?.machine_name) {
    const el = document.getElementById('machineName');
    if (el) el.textContent = s.machine_name;
  }
  if (s && 'system' in s) renderPi(piHealth(s.system));
  if (s && 'air' in s) renderAir(airHealth(s.air));
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
