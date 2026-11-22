// The top bar's live parts, the same on every page. The menu itself is drawn by topbar-boot.js
// while the page loads; this keeps the update dot and the machine name current, and remembers
// what the top bar shows (sessionStorage) so the next page starts with the same picture.

const nav = document.getElementById('pagenav');

/** Remember part of the top bar for the next page (see topbar-boot.js). */
export function saveTopbar(patch) {
  try {
    const c = JSON.parse(sessionStorage.getItem('topbar') || '{}');
    sessionStorage.setItem('topbar', JSON.stringify(Object.assign(c, patch)));
  } catch { /* no storage: the next page just starts plain */ }
}

/** Show on the System item whether updates are waiting, and the machine's name (from /api/state). */
export function navOnState(s) {
  if (s?.machine_name) {
    const el = document.getElementById('machineName');
    if (el) el.textContent = s.machine_name;
  }
  const link = nav?.querySelector('[data-nav=system]');
  if (!link || !s) return;
  const appN = s.update?.behind || 0, osN = s.os_updates || 0;
  link.querySelector('.nav-dot').hidden = !(appN || osN);
  const parts = [];
  if (appN) parts.push(`app update available (${appN} change${appN === 1 ? '' : 's'})`);
  if (osN) parts.push(`${osN} OS package update${osN === 1 ? '' : 's'}`);
  link.title = 'Versions, updates, reboot' + (parts.length ? ' – ' + parts.join(', ') : '');
  saveTopbar({ dot: !!(appN || osN), ...(s.machine_name ? { name: s.machine_name } : {}) });
}

/** For pages without the dashboard's live connection: fetch the machine state every second
 *  (every 5 s while the page is hidden) and pass it on; an empty state when the server is
 *  unreachable, so the status shows OFFLINE and the E-stop can't be pressed from here. */
export function followState(onState, page) {
  const tick = async () => {
    let s = {};
    try {
      s = await (await fetch('/api/state', { cache: 'no-store' })).json();
      navOnState(s);
      if (s.machine_name) document.title = s.machine_name + (page ? ' – ' + page : '');
    } catch { /* offline */ }
    onState(s);
    setTimeout(tick, document.hidden ? 5000 : 1000);
  };
  tick();
}
