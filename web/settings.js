// The /settings page: the machine name, camera, Files folder, tool in the 3D view, logs, Telegram,
// timelapse, and Home Assistant (its address and token, the air quality, the shop devices, MQTT).
// Everything is saved on the Pi (/api/settings) and applies to everyone.
import { ask } from './dialog.js';
import { log } from './log.js';
import { initHelp } from './help.js';
import { followState } from './nav.js';
import { initSystem, systemOnState } from './system-ui.js';
import { sentence, UNREACHABLE } from './msg.js';
import { SHOP_ICONS, shopIcon, guessIcon } from './shop.js';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const fmtDate = (t) => new Date(t * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

// ---------------------------------------------------------------- name, camera, files folder

let filesDir = '';

// What an action did goes in its card, right below the control that was used (the last one clicked,
// changed or submitted), as on the other pages; an OK message goes away after a while, an error stays
// until the next action. Without such a control (the page can't reach the server) it goes at the bottom.
let anchor = null;
let msgTimer = 0;
for (const type of ['pointerdown', 'change', 'keydown']) {
  document.addEventListener(type, (e) => {
    const card = e.target.closest?.('.set-card');
    if (card && !e.target.closest('.set-msg')) anchor = e.target;
  }, true);
}
document.addEventListener('submit', (e) => { anchor = e.submitter || e.target.querySelector('[type=submit]'); }, true);

function setMessage(text, kind = '', at = anchor) {
  const box = $('setMsg');
  clearTimeout(msgTimer);
  box.textContent = sentence(text);
  box.className = 'set-msg' + (kind ? ' ' + kind : '');
  const card = at?.closest?.('.set-card');
  if (card && text) {
    // Below the control's own block: its row, its buttons, its switch, its table
    const block = at.closest('.set-btns, .set-row, .set-check, .tg-events, .tg-chats, .shop-set') || at;
    if (block.nextElementSibling !== box) block.after(box);
  } else if (box.parentElement !== $('settings').parentElement) {
    $('settings').after(box);
  }
  if (kind === 'ok') msgTimer = setTimeout(() => { box.textContent = ''; }, 6000);
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
  $('filesDirResetBtn').title = d.files_dir_set ? `Back to the folder given when the server starts: ${d.files_default || 'none'}`
    : 'This is already the default folder (--files-dir)';
  $('filesDirHint').textContent = d.files_dir_set ? `Chosen here; kept when the Pi restarts. Default: ${d.files_default || 'none'}.`
    : 'The default folder (--files-dir).';
  $('toolShape').checked = !!d.tool_shape;
  const cams = $('toolCamSelect');
  cams.innerHTML = (d.tool_cams || []).map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
  cams.value = d.tool_cam;
  cams.disabled = !d.tool_shape;
  renderNotify(d);
  renderMqtt(d.mqtt);
  renderAir(d.air);
  renderShop(d);
}

/** Load and show the settings; returns them (null when the server can't be reached). */
async function settingsLoad() {
  try {
    const d = await (await fetch('/api/settings', { cache: 'no-store' })).json();
    renderSettings(d);
    return d;
  } catch {
    setMessage(UNREACHABLE, 'err', null);
    return null;
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
    res = { ok: false, message: UNREACHABLE };
  }
  if (res.ok) renderSettings(res);
  setMessage(res.ok ? res.message || 'Saved.' : `Could not save: ${res.message || 'failed'}`, res.ok ? 'ok' : 'err');
  if (!res.ok) log.warn(`saving settings ${JSON.stringify(changes)} failed: ${res.message}`);
  return res;
}

$('nameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  settingsSave({ name: $('nameInput').value });
});
$('camSelect').addEventListener('change', (e) => settingsSave({ camera: e.target.value }));
$('camRescanBtn').addEventListener('click', async () => {
  await settingsLoad();
  setMessage($('camHint').textContent.split('. ')[0], 'ok');   // "2 cameras found"
});
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
    d = { ok: false, message: UNREACHABLE };
  }
  $('folderMsg').textContent = d.ok ? '' : sentence(d.message || 'Cannot open that folder');
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
  anchor = $('filesDirBrowseBtn');   // the message goes in the Files card, not in the closed dialog
  $('filesDirInput').value = folderAt;
  filesDirSave(folderAt);
});
$('filesDirResetBtn').addEventListener('click', () => filesDirSave(''));

// ---------------------------------------------------------------- settings: Telegram and timelapse

function renderNotify(d) {
  const t = d.telegram;
  if (t) {
    // Don't overwrite what is being typed (as in the other forms: MQTT, air quality).
    if (!$('tgForm').contains(document.activeElement)) {
      $('tgToken').value = '';
      $('tgChat').value = '';   // shown in the status line below, like the bot
    }
    $('tgToken').placeholder = t.token_set ? 'saved – paste a new one to change it' : '123456:ABC-…';
    $('tgChat').placeholder = t.chat ? 'saved – paste a new one to change it' : 'chat id';
    $('tgClearBtn').hidden = !t.token_set;
    $('tgChats').innerHTML = t.chats.map((c) =>
      `<li><span>${esc(c.name)}</span><code>${esc(c.id)}</code>` +
      (c.id === t.chat ? '<b>in use</b>' : `<button class="vbtn" type="button" data-chat="${esc(c.id)}">Use</button>`) +
      '</li>').join('');
    const status = !t.token_set ? [`Off: no bot token.${t.chat ? ` Chat ${t.chat} saved.` : ''}`, '']
      : t.error ? [`Not connected: ${t.error}.`, 'err']
      : !t.bot ? ['Connecting to Telegram…', '']
      : !t.chat ? [`Connected as @${t.bot}. Send /start to it in Telegram, then press Refresh and choose your chat.`, '']
      : [`Connected as @${t.bot}; messages go to chat ${t.chat}.`, 'ok'];
    $('tgStatus').textContent = status[0];
    $('tgStatus').className = 'set-hint' + (status[1] ? ' ' + status[1] : '');
    $('tgTestBtn').disabled = !(t.token_set && t.chat);
    $('tgTestBtn').title = !t.token_set ? 'Save a bot token first' : !t.chat ? 'Choose a chat first' : 'Send a test message to the chat';
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
}

// Saved together with Save, like the other forms (MQTT, air quality)
$('tgForm').addEventListener('submit', (e) => {
  e.preventDefault();
  // An empty field keeps what is saved (Remove bot forgets both; Use picks another chat)
  const changes = {};
  const token = $('tgToken').value.trim(), chat = $('tgChat').value.trim();
  if (token) changes.telegram_token = token;
  if (chat) changes.telegram_chat = chat;
  if (!token && !chat) { setMessage('Nothing to save: paste a new token or chat id first.'); return; }
  document.activeElement?.blur();
  settingsSave(changes);
});
$('tgClearBtn').addEventListener('click', async () => {
  if (await ask({ title: 'Remove the bot?', text: 'The bot token and the chat are forgotten: no more Telegram messages or timelapses.', ok: 'Remove', danger: true })) {
    settingsSave({ telegram_token: '', telegram_chat: '' });
  }
});
$('tgChats').addEventListener('click', (e) => {
  const id = e.target.closest('[data-chat]')?.dataset.chat;
  if (id) settingsSave({ telegram_chat: id });
});
$('tgRefreshBtn').addEventListener('click', async () => {
  const d = await settingsLoad();
  const n = d?.telegram?.chats?.length;
  if (n !== undefined) setMessage(n ? `${n} chat${n === 1 ? '' : 's'} wrote to the bot.` : 'No chat wrote to the bot yet: send it /start in Telegram.', n ? 'ok' : '');
});
$('tgTestBtn').addEventListener('click', async () => {
  $('tgTestBtn').disabled = true;
  setMessage('Sending…');
  try {
    const r = await fetch('/api/telegram/test', { method: 'POST', headers: { 'X-CNC-Control': '1', 'Content-Type': 'application/json' }, body: '{}' });
    const res = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
    setMessage(res.message || (res.ok ? 'Sent.' : 'Failed.'), res.ok ? 'ok' : 'err');
  } catch {
    setMessage(UNREACHABLE, 'err');
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

// ---------------------------------------------------------------- MQTT (Home Assistant)

// The same words as the other interval lists (Telegram, timelapse): Every second, Every 5 s, Every minute, Every hour
const fmtEvery = (s) => s === 1 ? 'Every second' : s < 60 ? `Every ${s} s` : s === 60 ? 'Every minute'
  : s === 3600 ? 'Every hour' : `Every ${s / 60} minutes`;

function renderMqtt(m) {
  if (!m) return [];
  $('mqttOn').checked = m.enabled;
  // Don't overwrite what is being typed (the settings are reloaded a moment after each save).
  const typing = $('mqttForm').contains(document.activeElement);
  if (!typing) {
    $('mqttHost').value = m.host || '';
    $('mqttPort').value = m.port || 1883;
    $('mqttUser').value = m.user || '';
    $('mqttPassword').value = '';
    $('mqttPrefix').value = m.prefix || 'homeassistant';
    $('mqttBase').value = m.base || '';
  }
  $('mqttPassword').placeholder = m.password_set ? 'saved – paste a new one to change it' : 'the user\'s password';
  $('mqttPassClear').hidden = !m.password_set;
  $('mqttBase').placeholder = m.base_default;
  for (const [id, value] of [['mqttMachineEvery', m.machine_every], ['mqttSystemEvery', m.system_every]]) {
    $(id).innerHTML = m.every_choices.map((s) => `<option value="${s}">${fmtEvery(s)}</option>`).join('');
    $(id).value = String(value);
  }
  const status = !m.enabled ? ['Off: "Send to Home Assistant" is not ticked.', '']
    : !m.host ? ['Off: no broker address.', '']
    : m.connected ? [`Connected to ${m.host}: ${m.entities} entities on the "${m.base || m.base_default}" topics.`, 'ok']
    : m.error ? [`Not connected: ${m.error}. Trying again…`, 'err']
    : [`Connecting to ${m.host}…`, ''];
  $('mqttStatus').textContent = status[0];
  $('mqttStatus').className = 'set-hint' + (status[1] ? ' ' + status[1] : '');
  $('mqttCheckBtn').disabled = !(m.enabled && m.host);
  $('mqttCheckBtn').title = !m.enabled ? 'Tick "Send to Home Assistant" first' : !m.host ? 'Save the broker\'s address first'
    : 'Show whether it is connected now';
  return status;
}

$('mqttOn').addEventListener('change', async (e) => {
  await settingsSave({ mqtt_enabled: e.target.checked });
  setTimeout(settingsLoad, 2500);   // show whether it connected
});
$('mqttForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const changes = {
    mqtt_host: $('mqttHost').value.trim(), mqtt_port: Number($('mqttPort').value) || 1883,
    mqtt_user: $('mqttUser').value.trim(), mqtt_prefix: $('mqttPrefix').value.trim(), mqtt_base: $('mqttBase').value.trim(),
  };
  const password = $('mqttPassword').value;
  // An empty password field keeps the saved password, unless the user name was cleared too.
  if (password || !changes.mqtt_user) changes.mqtt_password = password;
  if (changes.mqtt_host && !$('mqttOn').checked) changes.mqtt_enabled = true;   // saving a broker turns it on
  document.activeElement?.blur();
  const res = await settingsSave(changes);
  if (res.ok) setTimeout(settingsLoad, 2500);
});
$('mqttPassClear').addEventListener('click', async () => {
  if (await ask({ title: 'Remove the password?', text: 'The saved MQTT password is forgotten.', ok: 'Remove', danger: true })) {
    settingsSave({ mqtt_password: '' });
  }
});
$('mqttCheckBtn').addEventListener('click', async () => {
  const d = await settingsLoad();
  if (!d?.mqtt) return;
  const [text, kind] = renderMqtt(d.mqtt);
  setMessage(text, kind || '');
});
$('mqttMachineEvery').addEventListener('change', (e) => settingsSave({ mqtt_machine_every: Number(e.target.value) }));
$('mqttSystemEvery').addEventListener('change', (e) => settingsSave({ mqtt_system_every: Number(e.target.value) }));

// ---------------------------------------------------------------- Home Assistant: address and token, air quality

const AIR_NAMES = { pm1: 'PM1', pm25: 'PM2.5', pm4: 'PM4', pm10: 'PM10', temp: 'Temperature', hum: 'Humidity', voc: 'VOC', nox: 'NOx' };
let haOn = false;   // the address and the token are saved

function renderAir(a) {
  if (!a) return;
  // Don't overwrite what is being typed.
  if (!$('haForm').contains(document.activeElement)) {
    $('haUrl').value = a.url || '';
    $('haToken').value = '';
  }
  if (!$('airForm').contains(document.activeElement)) $('airPrefix').value = a.prefix || '';
  $('haToken').placeholder = a.token_set ? 'saved – paste a new one to change it' : 'long-lived access token';
  $('airPrefix').placeholder = a.default_prefix;
  $('haClearBtn').hidden = !a.token_set;
  const on = haOn = !!(a.url && a.token_set);
  $('airCheckBtn').disabled = !on;
  $('airCheckBtn').title = !a.url ? 'Save the Home Assistant address first' : !a.token_set ? 'Save a token first' : 'Read the sensors now';
  // The sensors found: folded behind their count (opened or closed, it stays so while the page is open)
  const showEnts = on && !(a.error && !Object.keys(a.entities).length);
  $('airEntsBox').hidden = !showEnts;
  const found = a.keys.filter((k) => a.entities[k]).length;
  $('airEntsSum').textContent = `${found} of ${a.keys.length} sensors found`;
  $('airEntities').innerHTML = !showEnts ? ''
    : a.keys.map((k) => `<li><span>${AIR_NAMES[k]}</span>` + (a.entities[k]
      ? `<code title="${esc(a.entities[k])}">${esc(a.entities[k])}</code><b>found</b>`
      : '<code>–</code><span class="muted">not found</span>') + '</li>').join('');
  const [text, kind] = !a.url ? ['Off: no Home Assistant address.', '']
    : !a.token_set ? ['Off: no token.', '']
    : a.error ? [sentence(`Not reading the sensors: ${a.error}`), 'err']
    : a.ok ? [`Reading ${Object.keys(a.entities).length} sensors from ${a.url}.`, 'ok']
    : ['Connecting to Home Assistant…', ''];
  $('airStatus').textContent = text;
  $('airStatus').className = 'set-hint' + (kind ? ' ' + kind : '');
}

async function airCheck() {
  $('airCheckBtn').disabled = true;
  setMessage('Reading the sensors…');
  try {
    const r = await fetch('/api/air/check', { method: 'POST', headers: { 'X-CNC-Control': '1', 'Content-Type': 'application/json' }, body: '{}' });
    const res = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
    if (res.ok) renderSettings(res);
    setMessage(res.message || (res.ok ? 'Done.' : 'Failed.'), res.ok && !res.air?.error ? 'ok' : 'err');
  } catch {
    setMessage(UNREACHABLE, 'err');
  }
  $('airCheckBtn').disabled = false;
}

$('haForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const changes = { ha_url: $('haUrl').value.trim() };
  const token = $('haToken').value.trim();
  if (token) changes.ha_token = token;   // empty: keep the saved token
  document.activeElement?.blur();
  const res = await settingsSave(changes);
  if (res.ok && res.air?.url && res.air?.token_set) {
    shopChoicesLoad();
    airCheck();
  }
});
$('haClearBtn').addEventListener('click', async () => {
  if (await ask({ title: 'Remove the token?', text: 'The Home Assistant token is forgotten: the air quality disappears from the menu and the shop devices from the dashboard.', ok: 'Remove', danger: true })) {
    settingsSave({ ha_token: '' });
  }
});
$('airForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  document.activeElement?.blur();
  const res = await settingsSave({ air_prefix: $('airPrefix').value.trim() });
  if (res.ok && res.air?.url && res.air?.token_set) airCheck();
});
$('airCheckBtn').addEventListener('click', airCheck);
$('airEntsBtn').addEventListener('click', () => {
  const list = $('airEntities');
  list.hidden = !list.hidden;
  $('airEntsBtn').setAttribute('aria-expanded', String(!list.hidden));
});

// ---------------------------------------------------------------- Home Assistant: shop devices

let shopDevices = [];     // as saved: [{entity, name, icon, path}] (path: the drawing of an mdi: icon)
let shopMax = 12;
let shopChoices = null;   // Home Assistant's switches, lights and fans: [{entity, name, state, icon}]; null: not loaded
let shopChoicesError = '';
let shopDraft = null;     // the device being added: {entity, name, icon, haIcon}, shown before Add
const SHOP_DOMAIN_NAMES = { switch: 'Switches', light: 'Lights', fan: 'Fans', input_boolean: 'Helpers (on/off)' };
const MDI_NAME = /^mdi:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MDI_LIBRARY = 'https://pictogrammers.com/library/mdi/';

const shopChoice = (eid) => shopChoices?.find((c) => c.entity === eid);
const shopName = (eid) => shopChoice(eid)?.name || '';
const iconLabel = (icon) => SHOP_ICONS[icon]?.label || icon;

/** An mdi: icon's drawing, added to the shared icons (topbar-boot.js SHOP_ICONS) so that shopIcon() draws it,
 *  filled (Material Design Icons are shapes, the app's own icons lines). */
function shopIconAdd(icon, path) {
  if (MDI_NAME.test(icon || '') && path) {
    SHOP_ICONS[icon] = { label: icon, svg: `<path style="fill:currentColor;stroke:none" d="${esc(path)}"/>` };
  }
}

/** Look an mdi: icon up (the server downloads it once): {ok, icon, path} or {ok: false, message}. */
async function shopIconFetch(name) {
  try {
    const r = await fetch('/api/shop/icon?name=' + encodeURIComponent(name), { cache: 'no-store' });
    const res = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
    if (res.ok) shopIconAdd(res.icon, res.path);
    return res;
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

const iconBtn = (icon) => `<button class="shop-ic-btn" type="button" data-act="icon" aria-expanded="false"`
  + ` title="Icon: ${esc(iconLabel(icon))} – change it" aria-label="Icon: ${esc(iconLabel(icon))}">${shopIcon(icon)}</button>`;

function renderShop(d) {
  if (!d.shop_devices) return;
  shopMax = d.shop_max || shopMax;
  for (const x of d.shop_devices) shopIconAdd(x.icon, x.path);
  const list = $('shopSet');
  // Not while a name is being typed or an icon chosen: it would be lost
  if (JSON.stringify(d.shop_devices) !== JSON.stringify(shopDevices) || !list.contains(document.activeElement)) {
    if (pick && list.contains(pick.btn)) pickClose();
    shopDevices = d.shop_devices.map((x) => ({ ...x }));
    list.innerHTML = shopDevices.map((x, i) => `<li data-i="${i}">${iconBtn(x.icon)}`
      + `<input class="shop-set-name" value="${esc(x.name)}" placeholder="${esc(shopName(x.entity) || x.entity)}" maxlength="40" spellcheck="false" aria-label="Name on the dashboard">`
      + `<button class="icon-btn" type="button" data-act="up" title="Move up"${i ? '' : ' disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button>`
      + `<button class="icon-btn" type="button" data-act="remove" title="Remove from the dashboard"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`
      + `<code title="${esc(x.entity)}">${esc(x.entity)}</code></li>`).join('');
  }
  renderShopAdd();
}

function renderShopAdd() {
  const sel = $('shopAdd');
  const taken = new Set(shopDevices.map((x) => x.entity));
  const free = (shopChoices || []).filter((c) => !taken.has(c.entity));
  const full = shopDevices.length >= shopMax;
  if (!sel.matches(':focus')) {
    const groups = {};
    for (const c of free) (groups[c.entity.split('.')[0]] ||= []).push(c);
    const keep = sel.value;
    sel.innerHTML = !haOn ? '<option value="">Set up the address and token first</option>'
      : shopChoices === null ? `<option value="">${shopChoicesError ? 'Home Assistant not reachable' : 'Loading…'}</option>`
      : !free.length ? '<option value="">No more switches, lights or fans</option>'
      : '<option value="">Choose a switch, light or fan…</option>' + Object.entries(groups)
        .sort(([a], [b]) => (SHOP_DOMAIN_NAMES[a] || a).localeCompare(SHOP_DOMAIN_NAMES[b] || b)).map(([dom, cs]) =>
        `<optgroup label="${SHOP_DOMAIN_NAMES[dom] || dom}">${cs.map((c) =>
          `<option value="${esc(c.entity)}">${esc(c.name || c.entity)} (${esc(c.state)})</option>`).join('')}</optgroup>`).join('');
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
  sel.disabled = !haOn || !free.length || full;
  if (shopDraft && (sel.disabled || taken.has(shopDraft.entity))) shopDraftSet(null);
  const [text, kind] = !haOn ? ['Off: save the Home Assistant address and token first.', '']
    : shopChoicesError ? [sentence(`Can't list Home Assistant's devices: ${shopChoicesError}`), 'err']
    : full ? [`${shopMax} devices: the most there can be.`, '']
    : !shopDevices.length ? ['No devices yet: the dashboard shows none.', '']
    : [`${shopDevices.length} device${shopDevices.length === 1 ? '' : 's'} on the dashboard.`, 'ok'];
  $('shopStatus').textContent = text;
  $('shopStatus').className = 'set-hint' + (kind ? ' ' + kind : '');
}

async function shopChoicesLoad() {
  if (!haOn) return;
  try {
    const r = await fetch('/api/shop/choices', { cache: 'no-store' });
    const res = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
    shopChoices = res.ok ? res.entities : null;
    shopChoicesError = res.ok ? '' : res.message || 'failed';
  } catch {
    shopChoices = null;
    shopChoicesError = UNREACHABLE;
  }
  // The names Home Assistant gives them, as placeholders of the names given here
  for (const input of $('shopSet').querySelectorAll('.shop-set-name')) {
    const x = shopDevices[input.closest('li').dataset.i];
    if (x) input.placeholder = shopName(x.entity) || x.entity;
  }
  renderShopAdd();
}

async function shopSave(devices, done) {
  if ($('shopSet').contains(anchor)) anchor = $('shopSet');   // the list is drawn again: the message goes below it
  const res = await settingsSave({ shop_devices: devices.map(({ entity, name, icon }) => ({ entity, name, icon })) });
  if (res.ok && done) setMessage(done, 'ok');
  return res;
}

// ---- The device being added: its name and icon to check before Add. The icon it has in Home Assistant if it
// has one there (looked up first: shown once its drawing is here), else one guessed from its name.

function shopDraftSet(draft) {
  shopDraft = draft;
  const box = $('shopNew');
  if (pick && box.contains(pick.btn)) pickClose();
  box.hidden = !draft;
  if (!draft) { box.innerHTML = ''; return; }
  box.innerHTML = `<li>${iconBtn(draft.icon)}`
    + `<input class="shop-set-name" value="${esc(draft.name)}" placeholder="${esc(draft.entity)}" maxlength="40" spellcheck="false" aria-label="Name on the dashboard">`
    + `<button class="vbtn" type="button" data-act="add">Add</button>`
    + `<button class="icon-btn" type="button" data-act="cancel" title="Don't add it"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`
    + `<code title="${esc(draft.entity)}">${esc(draft.entity)}</code></li>`;
}
function shopDraftIcon(icon) {
  shopDraft.icon = icon;
  $('shopNew').querySelector('[data-act="icon"]').outerHTML = iconBtn(icon);
}

$('shopAdd').addEventListener('focus', shopChoicesLoad);
$('shopAdd').addEventListener('change', async () => {
  const eid = $('shopAdd').value;
  if (!eid) { shopDraftSet(null); return; }
  const c = shopChoice(eid), name = c?.name || '';
  const haIcon = c?.icon || '';
  shopDraftSet({ entity: eid, name, icon: haIcon && SHOP_ICONS[haIcon] ? haIcon : guessIcon(eid, name), haIcon });
  $('shopNew').querySelector('.shop-set-name').focus();
  if (haIcon && !SHOP_ICONS[haIcon]) {
    const res = await shopIconFetch(haIcon);
    if (res.ok && shopDraft?.entity === eid) shopDraftIcon(haIcon);
  }
});
async function shopDraftAdd() {
  const d = shopDraft;
  if (!d) return;
  d.name = $('shopNew').querySelector('.shop-set-name').value.trim();
  const res = await shopSave([...shopDevices, { entity: d.entity, name: d.name, icon: d.icon }],
    `${d.name || shopName(d.entity) || d.entity} added to the dashboard.`);
  if (res.ok) {
    $('shopAdd').value = '';
    shopDraftSet(null);
  }
}
$('shopNew').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !shopDraft) return;
  if (btn.dataset.act === 'add') shopDraftAdd();
  else if (btn.dataset.act === 'cancel') { $('shopAdd').value = ''; shopDraftSet(null); }
  else if (btn.dataset.act === 'icon') pickOpen(btn, shopDraft.icon, shopDraft.haIcon, shopDraftIcon);
});
$('shopNew').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.shop-set-name')) shopDraftAdd();
});

// ---- The devices on the dashboard: name, icon, order, remove

$('shopSet').addEventListener('change', (e) => {
  const li = e.target.closest('li');
  if (!li || !e.target.matches('.shop-set-name')) return;
  const devices = shopDevices.map((x) => ({ ...x }));
  devices[li.dataset.i].name = e.target.value.trim();
  shopSave(devices);
});
$('shopSet').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.shop-set-name')) e.target.blur();   // saves it (change)
});
$('shopSet').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !btn.closest('li[data-i]')) return;
  const i = Number(btn.closest('li').dataset.i);
  const devices = shopDevices.map((x) => ({ ...x }));
  if (btn.dataset.act === 'icon') {
    pickOpen(btn, devices[i].icon, shopChoice(devices[i].entity)?.icon || '', (icon) => {
      if (icon === devices[i].icon) return;
      devices[i].icon = icon;
      btn.innerHTML = shopIcon(icon);
      shopSave(devices, `Icon of ${devices[i].name || shopName(devices[i].entity) || devices[i].entity}: ${iconLabel(icon)}.`);
    });
  } else if (btn.dataset.act === 'up' && i > 0) {
    [devices[i - 1], devices[i]] = [devices[i], devices[i - 1]];
    shopSave(devices);
  } else if (btn.dataset.act === 'remove') {
    const [gone] = devices.splice(i, 1);
    shopSave(devices, `${gone.name || shopName(gone.entity) || gone.entity} removed from the dashboard.`);
  }
});

// ---- The icon picker, opened under a device by its icon button: the icon it has in Home Assistant, the app's
// own icons, or any Material Design Icon by its name (as in Home Assistant), shown as it is typed.

const pickBox = document.createElement('div');
pickBox.className = 'icon-pick';
pickBox.setAttribute('role', 'group');
pickBox.setAttribute('aria-label', 'Choose an icon');
let pick = null;          // {btn, current, haIcon, done(icon)}
let pickTimer = 0, pickSeq = 0;

function pickOpen(btn, current, haIcon, done) {
  if (pick?.btn === btn) { pickClose(); return; }
  pickClose();
  pick = { btn, current, haIcon, done };
  btn.setAttribute('aria-expanded', 'true');
  btn.closest('li').appendChild(pickBox);
  pickBox.innerHTML = '<div class="icon-pick-opts"></div>'
    + '<div class="icon-pick-mdi"><span class="icon-pick-prev" aria-hidden="true"></span>'
    + `<input type="text" placeholder="mdi:saw-blade" spellcheck="false" autocapitalize="off" aria-label="Material Design Icon name" value="${esc(MDI_NAME.test(current) ? current : '')}">`
    + '<button class="vbtn" type="button" data-act="use" disabled>Use</button></div>'
    + `<p class="set-hint icon-pick-msg">Any icon from <a href="${MDI_LIBRARY}" target="_blank" rel="noopener">Material Design Icons</a>, by the name Home Assistant uses.</p>`;
  pickOpts();
  pickLook();
  if (haIcon && !SHOP_ICONS[haIcon]) shopIconFetch(haIcon).then(() => { if (pick?.haIcon === haIcon) pickOpts(); });
}
function pickOpts() {
  const opts = (pick.haIcon && SHOP_ICONS[pick.haIcon] ? [[pick.haIcon, 'In Home Assistant']] : [])
    .concat(Object.keys(SHOP_ICONS).filter((k) => !MDI_NAME.test(k)).map((k) => [k, SHOP_ICONS[k].label]));
  pickBox.querySelector('.icon-pick-opts').innerHTML = opts.map(([k, label]) =>
    `<button class="icon-pick-opt" type="button" data-icon="${esc(k)}" aria-pressed="${k === pick.current}" title="${esc(k === pick.haIcon ? `${label}: ${k}` : label)}">`
    + `${shopIcon(k)}<span>${esc(label)}</span></button>`).join('');
}
function pickClose() {
  if (!pick) return;
  pick.btn.setAttribute('aria-expanded', 'false');
  pick = null;
  clearTimeout(pickTimer);
  pickBox.remove();
}
function pickChoose(icon) {
  const { done, btn } = pick;
  pickClose();
  done(icon);
  (btn.isConnected ? btn : $('shopNew').querySelector('[data-act="icon"]'))?.focus();
}
/** The name typed: look it up after a short pause, and show it. */
function pickLook() {
  clearTimeout(pickTimer);
  const input = pickBox.querySelector('input'), prev = pickBox.querySelector('.icon-pick-prev');
  const use = pickBox.querySelector('[data-act="use"]'), msg = pickBox.querySelector('.icon-pick-msg');
  let name = input.value.trim().toLowerCase();
  if (name && !name.startsWith('mdi:')) name = 'mdi:' + name;
  use.disabled = true;
  use.dataset.icon = '';
  prev.innerHTML = '';
  if (!name) return;
  if (!MDI_NAME.test(name)) {
    msg.textContent = 'A name is like mdi:saw-blade: small letters, digits and dashes.';
    msg.className = 'set-hint icon-pick-msg err';
    return;
  }
  const show = (res) => {
    if (!pick || pickBox.querySelector('input') !== input) return;
    prev.innerHTML = res.ok ? shopIcon(res.icon) : '';
    use.disabled = !res.ok;
    use.dataset.icon = res.ok ? res.icon : '';
    msg.textContent = res.ok ? `${res.icon}: press Use (or Enter).` : sentence(res.message);
    msg.className = 'set-hint icon-pick-msg' + (res.ok ? ' ok' : ' err');
  };
  if (SHOP_ICONS[name]) { show({ ok: true, icon: name }); return; }
  msg.textContent = 'Looking it up…';
  msg.className = 'set-hint icon-pick-msg';
  const seq = ++pickSeq;
  pickTimer = setTimeout(async () => {
    const res = await shopIconFetch(name);
    if (seq === pickSeq) show(res);
  }, 400);
}
pickBox.addEventListener('input', (e) => { if (e.target.matches('input')) pickLook(); });
pickBox.addEventListener('click', (e) => {
  e.stopPropagation();   // not the device's own buttons (the picker sits in its row)
  const opt = e.target.closest('.icon-pick-opt');
  const use = e.target.closest('[data-act="use"]');
  if (opt) pickChoose(opt.dataset.icon);
  else if (use?.dataset.icon) pickChoose(use.dataset.icon);
});
pickBox.addEventListener('keydown', (e) => {
  e.stopPropagation();   // Enter here isn't the row's Enter (Add, or save the name)
  if (e.key === 'Escape') { const btn = pick.btn; pickClose(); btn.focus(); }
  else if (e.key === 'Enter' && e.target.matches('input')) {
    e.preventDefault();
    const icon = pickBox.querySelector('[data-act="use"]').dataset.icon;
    if (icon) pickChoose(icon);
  }
});
pickBox.addEventListener('change', (e) => e.stopPropagation());   // typing a name isn't renaming the device
document.addEventListener('click', (e) => {   // a click elsewhere closes it
  if (pick && !pickBox.contains(e.target) && !pick.btn.contains(e.target)) pickClose();
});

// ---------------------------------------------------------------- logs

async function logsLoad() {
  let d;
  try {
    d = await (await fetch('/api/logs', { cache: 'no-store' })).json();
  } catch {
    $('logInfo').textContent = UNREACHABLE;
    return;
  }
  $('logDebug').checked = d.debug;
  $('logDebug').disabled = !d.dir;
  $('logInfo').textContent = !d.dir ? 'No log files: the server was started with --log-dir none.'
    : `${fmtSize(d.total)} of at most ${fmtSize(d.max)} used. Files older than ${d.keep_days} days are deleted. ` +
      `Folder on the Pi: ${d.dir}`;
  $('logFiles').innerHTML = !d.files.length && d.dir ? '<li class="muted">No log files yet.</li>' : d.files.map((f) =>
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
    view.textContent = UNREACHABLE;
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
    setMessage(debug ? 'Detailed logging on.' : 'Detailed logging off.', 'ok');
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
settingsLoad().then(shopChoicesLoad);
logsLoad();
