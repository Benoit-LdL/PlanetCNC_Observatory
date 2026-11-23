// The /settings page: the machine name, camera, Files folder, tool in the 3D view, Telegram,
// timelapse and logs. Everything is saved on the Pi (/api/settings) and applies to everyone.
import { ask } from './dialog.js';
import { log } from './log.js';
import { initHelp } from './help.js';
import { followState } from './nav.js';
import { initSystem, systemOnState } from './system-ui.js';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const fmtDate = (t) => new Date(t * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

// ---------------------------------------------------------------- name, camera, files folder

let filesDir = '';

function setMessage(text, kind = '') {
  $('setMsg').textContent = text;
  $('setMsg').className = 'set-msg' + (kind ? ' ' + kind : '');
}

function renderSettings(d) {
  if (d.name) {
    $('machineName').textContent = d.name;
    document.title = `Settings – ${d.name}`;
    if (document.activeElement !== $('nameInput')) $('nameInput').value = d.name;
  }
  const sel = $('camSelect');
  const opts = [['auto', 'Automatic (first camera found)'], ...d.cameras.map((c) => [c.path, c.label]), ['none', 'Off']];
  // A chosen camera that is unplugged right now stays in the list, so the choice is visible.
  if (!opts.some(([v]) => v === d.camera)) opts.splice(opts.length - 1, 0, [d.camera, d.camera + ' (not connected)']);
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  sel.value = d.camera;
  $('camViewOn').checked = d.camera_view !== false;
  const fixed = d.camera_cmd || !!d.camera_note;
  sel.disabled = $('camRescanBtn').disabled = fixed;
  $('camHint').textContent = d.camera_note ? `Camera choice unavailable: ${d.camera_note}.`
    : `${d.cameras.length} camera${d.cameras.length === 1 ? '' : 's'} found. The choice is kept when the Pi restarts.`;
  // The camera without the dashboard, and the addresses for other programs (Home Assistant...)
  const origin = esc(location.origin);
  $('camUrls').hidden = !d.has_camera;
  $('camUrls').innerHTML = `On its own: <a href="/camera" target="_blank">${origin}/camera</a>. `
    + `For Home Assistant and other programs (no password): stream <code>${origin}/api/camera.mjpg</code>, `
    + `still picture <code>${origin}/api/camera.jpg</code>. See the README.`;
  filesDir = d.files_dir || '';
  if (document.activeElement !== $('filesDirInput')) $('filesDirInput').value = filesDir;
  $('filesDirResetBtn').disabled = !d.files_dir_set;
  $('filesDirHint').textContent = 'Shown in the dashboard\'s Files tab; kept when the Pi restarts. '
    + (d.files_dir_set ? `Default: ${d.files_default || 'none'}.` : 'This is the default (--files-dir).');
  $('toolShape').checked = !!d.tool_shape;
  const cams = $('toolCamSelect');
  cams.innerHTML = (d.tool_cams || []).map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
  cams.value = d.tool_cam;
  cams.disabled = !d.tool_shape;
  renderNotify(d);
}

async function settingsLoad() {
  try {
    renderSettings(await (await fetch('/api/settings', { cache: 'no-store' })).json());
  } catch {
    setMessage('Server unreachable', 'err');
  }
}

async function settingsSave(changes) {
  let res;
  try {
    const r = await fetch('/api/settings', {
      method: 'POST', headers: { 'X-CNC-Control': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    res = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  } catch {
    res = { ok: false, message: 'Server unreachable' };
  }
  if (res.ok) renderSettings(res);
  setMessage(res.message || (res.ok ? 'Saved' : 'Failed'), res.ok ? 'ok' : 'err');
  if (!res.ok) log.warn(`saving settings ${JSON.stringify(changes)} failed: ${res.message}`);
  return res;
}

$('nameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  settingsSave({ name: $('nameInput').value });
});
$('camSelect').addEventListener('change', (e) => settingsSave({ camera: e.target.value }));
$('camRescanBtn').addEventListener('click', () => settingsLoad());
$('camViewOn').addEventListener('change', (e) => settingsSave({ camera_view: e.target.checked }));
$('toolShape').addEventListener('change', (e) => settingsSave({ tool_shape: e.target.checked }));
$('toolCamSelect').addEventListener('change', (e) => settingsSave({ tool_cam: e.target.value }));

const filesDirSave = (folder) => settingsSave({ files_dir: folder });
$('filesDirForm').addEventListener('submit', (e) => {
  e.preventDefault();
  filesDirSave($('filesDirInput').value);
});

// ---------------------------------------------------------------- folder picker (Settings > Files)
// Folders on the Pi, by name only (/api/folders), to choose the Files folder without typing it.

const folderDlg = $('folderDlg');
let folderAt = '';

async function folderShow(path) {
  let d;
  try {
    d = await (await fetch('/api/folders' + (path ? '?path=' + encodeURIComponent(path) : ''), { cache: 'no-store' })).json();
  } catch {
    d = { ok: false, message: 'Server unreachable' };
  }
  $('folderMsg').textContent = d.ok ? '' : d.message || 'Cannot open that folder';
  if (!d.ok) return;
  folderAt = d.path;
  $('folderPath').textContent = d.path;
  $('folderPlaces').innerHTML = d.places.map((p) =>
    `<button class="vbtn toggle${p.path === d.path ? ' active' : ''}" type="button" data-folder="${esc(p.path)}">${esc(p.name)}</button>`).join('');
  const icon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const up = d.parent
    ? `<button class="frow" type="button" data-folder="${esc(d.parent)}">${icon('M12 19V5M5 12l7-7 7 7')}<span class="fname">Up one level</span></button>` : '';
  $('folderList').innerHTML = up + (d.dirs.length
    ? d.dirs.map((n) => `<button class="frow" type="button" role="option" data-folder="${esc(d.path.replace(/[\\/]$/, '') + (d.path.includes('\\') ? '\\' : '/') + n)}">`
      + `${icon('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z')}<span class="fname">${esc(n)}</span></button>`).join('')
    : '<p class="files-empty">No folders inside</p>');
  $('folderList').scrollTop = 0;
}

$('filesDirBrowseBtn').addEventListener('click', () => {
  folderDlg.showModal();
  folderShow($('filesDirInput').value.trim() || filesDir);
});
folderDlg.addEventListener('click', (e) => {
  const b = e.target.closest('[data-folder]');
  if (b) folderShow(b.dataset.folder);
});
$('folderCancel').addEventListener('click', () => folderDlg.close());
$('folderUse').addEventListener('click', () => {
  folderDlg.close();
  $('filesDirInput').value = folderAt;
  filesDirSave(folderAt);
});
$('filesDirResetBtn').addEventListener('click', () => filesDirSave(''));

// ---------------------------------------------------------------- settings: Telegram and timelapse

function renderNotify(d) {
  const t = d.telegram;
  if (t) {
    $('tgToken').value = '';
    $('tgToken').placeholder = t.token_set ? 'saved – paste a new one to change it' : '123456:ABC-…';
    $('tgTokenBtns').hidden = !t.token_set;
    if (document.activeElement !== $('tgChat')) $('tgChat').value = t.chat || '';
    $('tgChats').innerHTML = t.chats.map((c) =>
      `<li><span>${esc(c.name)}</span><code>${esc(c.id)}</code>` +
      (c.id === t.chat ? '<b>in use</b>' : `<button class="vbtn" type="button" data-chat="${esc(c.id)}">Use</button>`) +
      '</li>').join('');
    const status = !t.token_set ? ['Off: no bot token.', '']
      : t.error ? [`Telegram: ${t.error}`, 'err']
      : !t.bot ? ['Connecting to Telegram…', '']
      : !t.chat ? [`Connected as @${t.bot}. Send /start to it in Telegram, then press Refresh and choose your chat.`, '']
      : [`Connected as @${t.bot}; messages go to chat ${t.chat}.`, 'ok'];
    $('tgStatus').textContent = status[0];
    $('tgStatus').className = 'set-hint' + (status[1] ? ' ' + status[1] : '');
    $('tgTestBtn').disabled = !(t.token_set && t.chat);
  }
  $('tgProgress').value = String(d.notify_progress);
  $('tgMinutes').value = String(d.notify_minutes || 0);
  $('tgPhotos').checked = !!d.notify_photos;
  $('tgReplace').checked = d.notify_replace !== false;
  renderTgEvents(d.notify_events || []);
  $('tlGroup').hidden = !d.has_camera;
  $('tgPhotos').disabled = !d.has_camera;
  $('tlOn').checked = !!d.timelapse;
  $('tlInterval').value = String(d.timelapse_interval);
  $('tlInterval').disabled = !d.timelapse;
  $('tlFiles').innerHTML = (d.timelapses || []).map((f) =>
    `<li><a href="/api/timelapses/download?name=${encodeURIComponent(f.name)}" download>${esc(f.name)}</a>` +
    `<span>${fmtSize(f.size)}</span><span>${fmtDate(f.mtime)}</span></li>`).join('');
}

$('tgTokenForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const token = $('tgToken').value.trim();
  if (token) settingsSave({ telegram_token: token });
});
$('tgTokenClear').addEventListener('click', async () => {
  if (await ask({ title: 'Remove the bot?', text: 'The bot token is removed: no more Telegram messages are sent.', ok: 'Remove', danger: true })) {
    settingsSave({ telegram_token: '', telegram_chat: '' });
  }
});
$('tgChatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  settingsSave({ telegram_chat: $('tgChat').value.trim() });
});
$('tgChats').addEventListener('click', (e) => {
  const id = e.target.closest('[data-chat]')?.dataset.chat;
  if (id) settingsSave({ telegram_chat: id });
});
$('tgRefreshBtn').addEventListener('click', () => { settingsLoad(); setMessage(''); });
$('tgTestBtn').addEventListener('click', async () => {
  $('tgTestBtn').disabled = true;
  setMessage('Sending…');
  try {
    const r = await fetch('/api/telegram/test', { method: 'POST', headers: { 'X-CNC-Control': '1', 'Content-Type': 'application/json' }, body: '{}' });
    const res = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
    setMessage(res.message || (res.ok ? 'Sent' : 'Failed'), res.ok ? 'ok' : 'err');
  } catch {
    setMessage('Server unreachable', 'err');
  }
  $('tgTestBtn').disabled = false;
});
$('tgProgress').addEventListener('change', (e) => settingsSave({ notify_progress: Number(e.target.value) }));
$('tgMinutes').addEventListener('change', (e) => settingsSave({ notify_minutes: Number(e.target.value) }));
$('tgPhotos').addEventListener('change', (e) => settingsSave({ notify_photos: e.target.checked }));
$('tgReplace').addEventListener('change', (e) => settingsSave({ notify_replace: e.target.checked }));

/** Settings > Telegram > Messages: per kind of message, whether it is sent and whether silently. */
function renderTgEvents(events) {
  $('tgEvents').innerHTML = '<div class="tg-ev head" role="row"><span role="columnheader">Messages</span>'
    + '<span role="columnheader">Send</span><span role="columnheader">Silent</span></div>'
    + events.map((e) => `<div class="tg-ev" role="row"><span role="cell">${esc(e.label)}</span>`
      + `<span role="cell"><input type="checkbox" data-kind="${esc(e.kind)}" data-field="send" aria-label="Send: ${esc(e.label)}"${e.send ? ' checked' : ''}></span>`
      + `<span role="cell"><input type="checkbox" data-kind="${esc(e.kind)}" data-field="silent" aria-label="Silent: ${esc(e.label)}"${e.silent ? ' checked' : ''}${e.send ? '' : ' disabled'}></span></div>`).join('');
}
$('tgEvents').addEventListener('change', (e) => {
  const box = e.target.closest('input[data-kind]');
  if (!box) return;
  const { kind, field } = box.dataset;
  if (field === 'send') $('tgEvents').querySelector(`input[data-kind="${kind}"][data-field="silent"]`).disabled = !box.checked;
  settingsSave({ notify_events: { [kind]: { [field]: box.checked } } });
});
$('tlOn').addEventListener('change', (e) => settingsSave({ timelapse: e.target.checked }));
$('tlInterval').addEventListener('change', (e) => settingsSave({ timelapse_interval: Number(e.target.value) }));

// ---------------------------------------------------------------- logs

async function logsLoad() {
  let d;
  try {
    d = await (await fetch('/api/logs', { cache: 'no-store' })).json();
  } catch {
    $('logInfo').textContent = 'Server unreachable';
    return;
  }
  $('logDebug').checked = d.debug;
  $('logDebug').disabled = !d.dir;
  $('logInfo').textContent = !d.dir ? 'No log files: the server was started with --log-dir none.'
    : `${fmtSize(d.total)} of at most ${fmtSize(d.max)} used. Files older than ${d.keep_days} days are deleted. ` +
      `Folder on the Pi: ${d.dir}`;
  $('logFiles').innerHTML = d.files.map((f) =>
    `<li><a href="/api/logs/download?name=${encodeURIComponent(f.name)}" download>${esc(f.name)}</a>` +
    `<span>${fmtSize(f.size)}</span><span>${fmtDate(f.mtime)}</span></li>`).join('');
}

async function logsShow() {
  const view = $('logView');
  view.hidden = false;
  view.textContent = 'Loading…';
  try {
    const r = await fetch('/api/logs/tail?lines=400&level=' + $('logFilter').value, { cache: 'no-store' });
    view.textContent = (await r.text()) || '(nothing yet)';
  } catch {
    view.textContent = 'Server unreachable';
  }
  view.scrollTop = view.scrollHeight;
}

$('logShowBtn').addEventListener('click', logsShow);
$('logFilter').addEventListener('change', () => { if (!$('logView').hidden) logsShow(); });
$('logDebug').addEventListener('change', async (e) => {
  const debug = e.target.checked;
  try {
    const r = await fetch('/api/logs/level', {
      method: 'POST', headers: { 'X-CNC-Control': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ debug }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setMessage(debug ? 'Detailed logging on' : 'Detailed logging off', 'ok');
  } catch (err) {
    e.target.checked = !debug;
    setMessage('Could not change logging: ' + err.message, 'err');
  }
  logsLoad();
});

// ---------------------------------------------------------------- start

initHelp($('settings'));
initSystem();
followState(systemOnState, 'Settings');   // status, E-stop and the menu, as on the other pages
settingsLoad();
logsLoad();
