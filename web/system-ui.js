// The E-stop button (dashboard and System page), and the System page: updates (this app, the
// bridge in TNG, Raspberry Pi OS packages), the Pi's details and reboot / shut down.
//
// The E-stop is the only thing the dashboard can make the machine do. It only switches
// E-stop ON; releasing it and starting again always happen at the machine.
import { log } from './log.js';
import { ask, tell } from './dialog.js';
import { saveTopbar } from './nav.js';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const writeHeaders = { 'X-CNC-Control': '1', 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ESTOP_PROTOCOL = 3;   // bridge version that accepts the E-stop (server.py ESTOP_PROTOCOL)

let state = {};
let sys = null;             // last /api/system answer
let pollTimer = null;
let restarting = false;

const fmtAgo = (t) => {
  if (!t) return 'not yet';
  const s = Math.round(Date.now() / 1000 - t);
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago`
    : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { dateStyle: 'medium' });
const fmtUp = (sec) => {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
};

async function post(path, body = {}) {
  try {
    const r = await fetch(path, { method: 'POST', headers: writeHeaders, body: JSON.stringify(body) });
    return await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  } catch {
    return { ok: false, message: 'Server unreachable' };
  }
}

// ---------------------------------------------------------------- E-stop

let estopBusy = false;
let estopSentAt = 0;        // when the dashboard's E-stop was accepted: the popup stays while TNG catches up
const ESTOP_GRACE = 4000;   // ms

// The E-stop popup: shown while the E-stop is on (from this button, another screen or the
// machine itself), on every page, with a red and white hazard-stripe border. It closes by itself
// when the E-stop is released at the machine. "Hide" (or Esc) puts it away until the next E-stop.
let estopDlg = null;
let estopHidden = false;

function estopPopup() {
  const engaged = !!state.bridge_online && !!state.estop;
  const show = engaged || estopBusy || (estopSentAt && Date.now() - estopSentAt < ESTOP_GRACE);
  if (engaged) estopSentAt = 0;
  if (!show) {
    estopHidden = false;
    if (estopDlg) { const d = estopDlg; estopDlg = null; d.close(); d.remove(); }
    return;
  }
  if (estopHidden) return;
  if (!estopDlg) {
    const d = estopDlg = document.createElement('dialog');
    d.className = 'm3-dlg estop-dlg';
    d.setAttribute('aria-labelledby', 'estopDlgTitle');
    d.innerHTML = `
      <div class="estop-dlg-in">
        <div class="estop-dlg-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.2 2h7.6L22 8.2v7.6L15.8 22H8.2L2 15.8V8.2z"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg></div>
        <h2 id="estopDlgTitle"></h2>
        <p class="estop-dlg-text">The machine is stopped. Release the E-stop on the machine's touchscreen, in PlanetCNC TNG: this message then closes by itself.</p>
        <p class="estop-dlg-wait" aria-live="polite"><span class="estop-dlg-dot"></span><span class="estop-dlg-state"></span></p>
        <div class="m3-dlg-foot"><button type="button" class="vbtn text">Hide</button></div>
      </div>`;
    const hide = () => { estopHidden = true; estopDlg = null; d.close(); d.remove(); };
    d.querySelector('button').addEventListener('click', hide);
    d.addEventListener('cancel', (e) => { e.preventDefault(); hide(); });   // Esc
    document.body.append(d);
    d.showModal();
  }
  estopDlg.querySelector('h2').textContent = engaged ? 'E-stop engaged' : 'E-stop sent';
  estopDlg.querySelector('.estop-dlg-state').textContent = engaged
    ? 'Waiting for the release at the machine…' : 'Waiting for TNG to confirm…';
}

function renderEstop() {
  const online = !!state.bridge_online;
  const proto = state.bridge_protocol || 0;
  let label = 'E-STOP', title = 'Emergency stop: TNG stops the machine at once. Release it at the machine.';
  let disabled = estopBusy;
  if (estopBusy) label = 'STOPPING…';
  else if (online && state.estop) [label, title, disabled] = ['ENGAGED', 'E-stop is active – release it at the machine', true];
  else if (!online) [title, disabled] = ['TNG is not connected – use the E-stop at the machine', true];
  else if (proto < ESTOP_PROTOCOL) [title, disabled] = ['The bridge in TNG is too old for this – see the System page', true];
  for (const b of document.querySelectorAll('[data-estop]')) {
    b.querySelector('.estop-label').textContent = label;
    b.title = title;
    b.disabled = disabled;
    b.classList.toggle('on', online && !!state.estop);
  }
  if (!estopBusy) saveTopbar({ estop: { label, title, disabled, on: online && !!state.estop } });
  estopPopup();
}

async function estop() {
  if (estopBusy) return;
  estopBusy = true;
  renderEstop();
  const res = await post('/api/estop');
  estopBusy = false;
  if (res.ok) {
    estopSentAt = Date.now();
    setTimeout(renderEstop, ESTOP_GRACE + 50);   // TNG never confirmed: close the popup
  }
  renderEstop();
  if (!res.ok) {
    log.error(`E-stop failed: ${res.message}`);
    tell({ title: 'E-stop failed', text: `${res.message || 'No answer'}.\n\nUse the E-stop at the machine!`, danger: true });
  }
}

// ---------------------------------------------------------------- the System page
// Laid out like an update manager: one row per part with its name, its version (in blue with
// "installed › new" when there is an update), details behind the "i", and on the right a
// badge (up to date, error...) or the button that updates it. Icons: Lucide (ISC licence).

const ICON = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  update: '<circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4"/><path d="M12 16V8"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  off: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
};
const icon = (name, cls = '') => `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ''}>${ICON[name]}</svg>`;
// The icon of each kind of badge, and whether it turns
const BADGE = { ok: ['check'], update: ['update'], err: ['alert'], warn: ['alert'], busy: ['refresh', true],
  checking: ['refresh', true], na: ['off'] };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let checkingApp = false, checkingOs = false;
let appBusy = '';           // 'Updating' / 'Rolling back' while this page runs one

/** The badge or button on the right of a row. Kind 'update' can be pressed; so can 'ok' on a
 *  button (app, OS): on hover it turns into "Check update", which checks that row only. */
function setBadge(id, kind, label, { title = '', disabled = false } = {}) {
  const b = $(id);
  const recheck = kind === 'ok' && 'disabled' in b;
  if (b.dataset.kind !== kind || b.dataset.label !== label) {   // not on every poll: the spinner would restart
    const [ic, turns] = BADGE[kind];
    b.dataset.kind = kind;
    b.dataset.label = label;
    b.innerHTML = recheck
      ? `<span class="ubtn-face">${icon(ic)}<span>${esc(label)}</span></span>`
        + `<span class="ubtn-face alt">${icon('refresh')}<span>Check update</span></span>`
      : icon(ic, turns ? 'spin' : '') + `<span>${esc(label)}</span>`;
  }
  b.classList.toggle('recheck', recheck);
  b.title = recheck && !title ? 'Check for an update of this one now' : title;
  if ('disabled' in b) b.disabled = !(kind === 'update' || recheck) || disabled;
}

/** The small line under a row's version: what went wrong, or what is happening. */
function setStatus(id, text, kind = '') {
  $(id).textContent = text;
  $(id).className = 'urow-msg' + (kind ? ' ' + kind : '');
}

function setVersion(id, html, isNew = false, title = '') {
  $(id).className = 'urow-ver' + (isNew ? ' new' : '');
  $(id).innerHTML = (isNew ? icon('refresh') : '') + `<span class="t">${html}</span>`;
  $(id).title = title;
}

function kv(label, value, title = '') {
  return `<div class="kv"><span>${esc(label)}</span><b title="${esc(title || value)}">${esc(value)}</b></div>`;
}

function renderHost(h) {
  $('hostRows').innerHTML = [
    kv('Model', h.model || '–'),
    kv('System', h.os || '–'),
    kv('Kernel', h.kernel || '–'),
    kv('Python', h.python || '–'),
    kv('Address', `${h.hostname} · ${h.address}`),
    kv('Up', h.uptime != null ? fmtUp(h.uptime) : '–'),
    kv('Dashboard server', 'running ' + fmtUp(Date.now() / 1000 - h.server_started)),
  ].join('');
}

function renderApp(info, running) {
  const c = info.current, l = info.latest;
  const commits = info.commits || [];
  const blocked = info.dirty?.length ? info.dirty : null;
  if (c && l && commits.length) {
    setVersion('appVer', `<code>${esc(c.sha)}</code> › <code>${esc(l.sha)}</code><span class="dim"> · ${plural(commits.length, 'change')}</span>`,
      true, `Installed ${c.sha} from ${fmtDay(c.date)}; on GitHub ${l.sha} from ${fmtDay(l.date)}`);
  } else if (c) {
    setVersion('appVer', `<code>${esc(c.sha)}</code><span class="dim"> · ${esc(c.subject)}</span>`, false, `${c.subject} (${fmtDay(c.date)})`);
  } else {
    setVersion('appVer', info.git ? '–' : 'not a git clone');
  }
  $('updChecked').textContent = info.git ? `Checked ${fmtAgo(info.checked)}` : '';

  // Details: what is installed, what is new, roll back
  $('appRows').innerHTML = (c ? kv('Installed', `${c.sha} · ${fmtDay(c.date)}`, c.subject) : '')
    + (l ? kv('On GitHub', `${l.sha} · ${fmtDay(l.date)}`, l.subject) : '')
    + (info.git ? kv('Checked', fmtAgo(info.checked)) : '');
  $('updCommits').hidden = !commits.length;
  $('updCommits').innerHTML = commits.map((m) =>
    `<li><code>${esc(m.sha)}</code><span>${esc(m.subject)}</span><small>${esc(m.author)} · ${fmtDay(m.date)}</small></li>`).join('');
  $('updRollbackBtn').hidden = !info.can_rollback;
  $('updRollbackBtn').disabled = running || info.busy || !!appBusy || restarting;
  $('updRollbackBtn').title = running ? 'Not while a program runs' : '';

  if (restarting || appBusy) setBadge('appAct', 'busy', appBusy || 'Updating');
  else if (checkingApp) setBadge('appAct', 'checking', 'Checking');
  else if (info.busy) setBadge('appAct', 'busy', 'Updating');
  else if (!info.git) setBadge('appAct', 'na', 'Unavailable');
  else if (info.error) setBadge('appAct', 'err', 'Error');
  else if (blocked) setBadge('appAct', 'warn', 'Blocked');
  else if (commits.length) {
    setBadge('appAct', 'update', 'Update', { disabled: running,
      title: running ? 'Not while a program runs' : `Install ${plural(commits.length, 'change')} from GitHub` });
  } else setBadge('appAct', 'ok', 'Up-to-date');

  if (restarting || appBusy) return;   // keep "Installing…" / "Restarting…"
  if (!info.git) setStatus('updStatus', `Updates unavailable: ${info.message || 'the app folder must be a git clone – see README'}.`, 'err');
  else if (info.error) setStatus('updStatus', info.error, 'err');
  else if (blocked) setStatus('updStatus', `Files changed on the Pi, update blocked: ${blocked.join(', ')}`, 'warn');
  else if (!checkingApp) setStatus('updStatus', '');
}

function renderBridge(b) {
  const p = b.protocol;
  let msg = '', msgKind = '';
  if (!b.online) {
    setVersion('bridgeVer', 'not connected');
    setBadge('bridgeAct', 'na', 'Offline', { title: 'TNG is not running, or the bridge is not loaded in it' });
  } else if (p == null) {
    setVersion('bridgeVer', '–');
    setBadge('bridgeAct', 'na', 'Unknown');
  } else if (p >= b.expected) {
    setVersion('bridgeVer', `version ${p}`);
    setBadge('bridgeAct', 'ok', 'Up-to-date');
  } else {
    setVersion('bridgeVer', `version ${p} › ${b.expected}`, true);
    setBadge('bridgeAct', 'warn', 'Old');
    msg = p >= 2 ? 'It reloads itself after the app update.' : 'Restart TNG once after the app update.';
  }
  if (b.installed === 'different') [msg, msgKind] = ['The copy in TNG differs from this version: install the update, or run update.sh.', 'warn'];
  else if (b.installed === 'missing') [msg, msgKind] = ["Not found in TNG's profile – see README.", 'warn'];
  if (msgKind && $('bridgeAct').dataset.kind === 'ok') setBadge('bridgeAct', 'warn', b.installed === 'missing' ? 'Not found' : 'Differs');
  setStatus('bridgeMsg', msg, msgKind);
  const copy = { current: 'same as this version', different: 'differs from this version', missing: 'not found' }[b.installed] || '–';
  $('bridgeRows').innerHTML = kv('Running', !b.online ? 'not connected' : p == null ? '–' : `version ${p}`)
    + kv('This app needs', `version ${b.expected}`) + kv('Copy in TNG', copy, b.path);
}

function renderOs(o, running) {
  $('osInfoBtn').hidden = !o;
  if (!o) {
    setVersion('osVer', 'only on the Pi (Linux with apt)');
    setBadge('osAct', 'na', 'N/A');
    $('osReboot').hidden = true;
    return;
  }
  const pk = o.packages || [];
  const job = o.job;
  if (pk.length) setVersion('osVer', `${plural(pk.length, 'package')} can be upgraded`, true);
  else setVersion('osVer', `package lists from ${fmtAgo(o.lists_date)}`);
  if (o.busy) setBadge('osAct', 'busy', 'Upgrading');
  else if (checkingOs) setBadge('osAct', 'checking', 'Checking');
  else if (o.error) setBadge('osAct', 'err', 'Error');
  else if (pk.length) {
    setBadge('osAct', 'update', 'Upgrade', { disabled: running || !o.can_upgrade,
      title: running ? 'Not while a program runs' : !o.can_upgrade ? 'Needs tools/setup-sudo.sh on the Pi (see README)'
        : `Upgrade ${plural(pk.length, 'package')}` });
  } else setBadge('osAct', 'ok', 'Up-to-date');

  if (o.busy) setStatus('osStatus', `Upgrading, started ${fmtAgo(job.started)}…`);
  else if (checkingOs) { /* keep "can take a minute" */ }
  else if (o.error) setStatus('osStatus', o.error, 'err');
  else setStatus('osStatus', '');
  $('osReboot').hidden = !o.reboot_required;

  // Details: the lists, the packages, what is held back
  $('osRows').innerHTML = kv('Package lists', `from ${fmtAgo(o.lists_date)}`) + kv('Checked', fmtAgo(o.checked));
  $('osPkgList').hidden = !pk.length;
  $('osPkgList').innerHTML = pk.map((p) =>
    `<li><b>${esc(p.name)}</b><span>${esc(p.from)} → ${esc(p.to)}</span></li>`).join('');
  $('osHeld').hidden = !o.kept_back?.length;
  $('osHeld').textContent = o.kept_back?.length
    ? `Held back (upgrade over SSH with apt full-upgrade): ${o.kept_back.join(', ')}.` : '';
  $('osSudo').hidden = !!(o.can_upgrade && o.can_update);
  const out = $('osOut');
  out.hidden = !job;
  // An upgrade that starts (here or in another browser) opens the details once, to show its output
  if (o.busy && !osWasBusy) showMore('osMore');
  osWasBusy = !!o.busy;
  if (job) {
    const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
    const end = job.running ? '' : job.exit === 0 ? '\n— finished —' : `\n— FAILED (exit code ${job.exit}) —`;
    out.textContent = job.output.join('\n') + end;
    if (atEnd) out.scrollTop = out.scrollHeight;
  }

  $('powerSudo').hidden = !!o.can_power;
  $('rebootBtn').disabled = $('poweroffBtn').disabled = running || !o.can_power || o.busy;
  $('rebootBtn').title = $('poweroffBtn').title = running ? 'Not while a program runs' : o.busy ? 'Wait for the upgrade' : '';
}

function render() {
  if (!sys) return;
  renderHost(sys.host);
  renderApp(sys.app, sys.running);
  renderBridge(sys.bridge);
  renderOs(sys.os, sys.running);
  $('powerBlock').hidden = !sys.os;
  const checking = checkingApp || checkingOs;
  $('updCheckBtn').disabled = !!(sys.app.busy || sys.os?.busy || appBusy) || checking;
  $('updCheckBtn').classList.toggle('spin', checking);
}

async function load() {
  try {
    sys = await (await fetch('/api/system', { cache: 'no-store' })).json();
    render();
  } catch {
    setStatus('updStatus', 'Server unreachable', 'err');
  }
  clearTimeout(pollTimer);
  if (!document.hidden) pollTimer = setTimeout(load, sys?.os?.busy ? 1500 : 5000);
}

async function checkAll({ app: withApp = true, os: withOs = true } = {}) {
  withOs = withOs && !!sys?.os;
  if (!withApp && !withOs) return;
  if (withApp) checkingApp = true;   // checking one row leaves the other one's check running
  if (withOs) checkingOs = true;
  if (withApp) setStatus('updStatus', '');
  if (withOs) setStatus('osStatus', 'Refreshing the package lists can take a minute.');
  render();
  const [app, os] = await Promise.all([
    withApp ? post('/api/update/check').finally(() => { checkingApp = false; }) : null,
    withOs ? post('/api/system/os/check').finally(() => { checkingOs = false; }) : null,
  ]);
  await load();
  if (app && app.git === undefined) setStatus('updStatus', app.message || 'Check failed', 'err');
  if (os && !os.ok) setStatus('osStatus', os.message || 'Check failed', 'err');
}

// On opening the page: GitHub is checked every time (quick, and right after pushing a change
// is when it matters). The package lists only when older than this and no program runs:
// apt-get update takes a while and works the Pi hard.
const OS_AUTO_CHECK_AFTER = 15 * 60;   // s

function autoCheck() {
  if (!sys) return;
  const o = sys.os;
  const osStale = o && !o.busy && !sys.running && (!o.checked || Date.now() / 1000 - o.checked > OS_AUTO_CHECK_AFTER);
  checkAll({ app: !!sys.app?.git && !sys.app.busy, os: !!osStale });
}

/** After an update or a reboot the server restarts; wait until it answers again, then reload. */
async function waitForServer(statusId, message, first, tries) {
  setStatus(statusId, message);
  await sleep(first);
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch('/api/system', { cache: 'no-store' });
      if (r.ok) { location.reload(); return; }
    } catch { /* still restarting */ }
    await sleep(1000);
  }
  restarting = false;
  setStatus(statusId, 'The server did not come back – check it over SSH: journalctl -u planetcnc-web -n 30', 'err');
  render();
}

async function appRun(path, question) {
  if (!await ask(question)) return;
  const back = path.endsWith('rollback');
  appBusy = back ? 'Rolling back' : 'Updating';
  setStatus('updStatus', back ? 'Going back to the previous version…' : 'Installing the update…');
  render();
  const res = await post(path);
  $('updOut').hidden = false;
  $('updOut').textContent = res.output || res.message || '';
  showMore('appMore');
  if (res.restarting) {
    restarting = true;
    waitForServer('updStatus', 'Restarting the server with the new version…', 2500, 60);
    return;
  }
  appBusy = '';
  await load();
  if (!res.ok) {
    setStatus('updStatus', res.message || 'Failed', 'err');
    log.warn(`${path} failed: ${res.message}`);
  }
}

/** Open a row's details (as its arrow does). */
function showMore(id) {
  $(id).hidden = false;
  document.querySelector(`[data-more="${id}"]`)?.setAttribute('aria-expanded', 'true');
}
let osWasBusy = false;

async function osUpgrade() {
  const n = sys?.os?.packages?.length || 0;
  if (!await ask({ title: `Upgrade ${plural(n, 'package')}?`,
    text: 'This can take several minutes. TNG keeps running, but nothing should run on the machine meanwhile.\n\n'
      + 'Afterwards, restart TNG (or reboot the Pi) so it uses the new libraries.', ok: 'Upgrade' })) return;
  setBadge('osAct', 'busy', 'Upgrading');
  const res = await post('/api/system/os/upgrade');
  if (!res.ok) setStatus('osStatus', res.message || 'Failed', 'err');
  load();
}

async function power(action) {
  const q = action === 'reboot'
    ? { title: 'Reboot the Raspberry Pi?', ok: 'Reboot', danger: true,
        text: 'TNG closes, so the machine can do nothing until TNG is running again.\n\n'
          + 'The dashboard is back once the Pi has started (a minute or two).' }
    : { title: 'Shut down the Raspberry Pi?', ok: 'Shut down', danger: true,
        text: 'TNG closes. To start it again you must switch the Pi off and on at the machine.' };
  if (!await ask(q)) return;
  const res = await post('/api/system/power', { action });
  if (!res.ok) { tell({ title: action === 'reboot' ? 'Could not reboot' : 'Could not shut down', text: res.message || 'Failed' }); return; }
  $('rebootBtn').disabled = $('poweroffBtn').disabled = true;
  if (action === 'reboot') waitForServer('powerMsg', 'The Pi is rebooting… this page reloads when it is back.', 20000, 240);
  else setStatus('powerMsg', 'The Pi is shutting down. Switch it off and on at the machine to start it again.');
}

// ---------------------------------------------------------------- status pill (top bar)

function renderStatus() {
  const el = $('status');
  if (!el) return;
  let st = 'offline', label = 'Offline';
  if (state.bridge_online) {
    if (state.estop) [st, label] = ['estop', 'E-stop'];
    else if (state.paused) [st, label] = ['paused', 'Paused'];
    else if (state.running) [st, label] = ['running', 'Running'];
    else [st, label] = ['idle', 'Idle'];
  }
  el.dataset.state = st;
  el.textContent = label;
  saveTopbar({ status: [st, label] });
}

// ---------------------------------------------------------------- wiring

/** The machine state changed (every page): the status pill and the E-stop button follow it. */
export function systemOnState(s) {
  state = s || {};
  renderStatus();
  renderEstop();
}

export function initSystem() {
  // Not drawn until the first state arrives: until then the top bar shows what the previous
  // page last showed (topbar-boot.js), so it doesn't blink when moving between pages.
  for (const b of document.querySelectorAll('[data-estop]')) b.addEventListener('click', estop);
  if (!$('sysBody')) return;   // the dashboard: only the E-stop
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  load().then(autoCheck);
  $('updCheckBtn').addEventListener('click', () => checkAll());
  $('appAct').addEventListener('click', () => ($('appAct').dataset.kind === 'ok' ? checkAll({ os: false }) : appRun('/api/update/apply', {
    title: `Install ${plural(sys?.app?.commits?.length || 0, 'change')}?`, ok: 'Install',
    text: 'The update comes from GitHub. The dashboard restarts and reloads itself; TNG and the machine are not interrupted.' })));
  $('updRollbackBtn').addEventListener('click', () => appRun('/api/update/rollback', {
    title: 'Roll back?', ok: 'Roll back',
    text: 'Go back to the version that was installed before the last update.' }));
  $('osAct').addEventListener('click', () => ($('osAct').dataset.kind === 'ok' ? checkAll({ app: false }) : osUpgrade()));
  for (const btn of document.querySelectorAll('[data-more]')) {
    btn.addEventListener('click', () => {
      const more = $(btn.dataset.more);
      more.hidden = !more.hidden;
      btn.setAttribute('aria-expanded', String(!more.hidden));
    });
  }
  $('rebootBtn').addEventListener('click', () => power('reboot'));
  $('poweroffBtn').addEventListener('click', () => power('poweroff'));
}
