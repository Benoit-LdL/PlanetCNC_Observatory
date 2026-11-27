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

let shopDevices = [];     // as saved: [{entity, name, icon}]
let shopMax = 12;
let shopChoices = null;   // Home Assistant's switches, lights and fans: [{entity, name, state}]; null: not loaded
let shopChoicesError = '';
const SHOP_DOMAIN_NAMES = { switch: 'Switches', light: 'Lights', fan: 'Fans', input_boolean: 'Helpers (on/off)' };

const shopName = (eid) => shopChoices?.find((c) => c.entity === eid)?.name || '';

function renderShop(d) {
  if (!d.shop_devices) return;
  shopMax = d.shop_max || shopMax;
  const list = $('shopSet');
  // Not while a name is being typed: it would be lost
  if (JSON.stringify(d.shop_devices) !== JSON.stringify(shopDevices) || !list.contains(document.activeElement)) {
    shopDevices = d.shop_devices.map((x) => ({ ...x }));
    list.innerHTML = shopDevices.map((x, i) => `<li data-i="${i}">`
      + `<span class="shop-set-ic">${shopIcon(x.icon)}</span>`
      + `<input class="shop-set-name" value="${esc(x.name)}" placeholder="${esc(shopName(x.entity) || x.entity)}" maxlength="40" spellcheck="false" aria-label="Name on the dashboard">`
      + `<select class="shop-set-icon" aria-label="Icon">${Object.entries(SHOP_ICONS).map(([k, v]) =>
        `<option value="${k}"${k === x.icon ? ' selected' : ''}>${v.label}</option>`).join('')}</select>`
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
  $('shopAddBtn').disabled = sel.disabled || !sel.value;
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
  const res = await settingsSave({ shop_devices: devices });
  if (res.ok && done) setMessage(done, 'ok');
  return res;
}

$('shopAdd').addEventListener('change', () => { $('shopAddBtn').disabled = !$('shopAdd').value; });
$('shopAdd').addEventListener('focus', shopChoicesLoad);
$('shopAddBtn').addEventListener('click', () => {
  const eid = $('shopAdd').value;
  if (!eid) return;
  const name = shopName(eid);
  $('shopAdd').value = '';
  shopSave([...shopDevices, { entity: eid, name, icon: guessIcon(eid, name) }], `${name || eid} added to the dashboard.`);
});
$('shopSet').addEventListener('change', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const devices = shopDevices.map((x) => ({ ...x }));
  const x = devices[li.dataset.i];
  if (e.target.matches('.shop-set-name')) x.name = e.target.value.trim();
  else if (e.target.matches('.shop-set-icon')) {
    x.icon = e.target.value;
    li.querySelector('.shop-set-ic').innerHTML = shopIcon(x.icon);
  } else return;
  shopSave(devices);
});
$('shopSet').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.shop-set-name')) e.target.blur();   // saves it (change)
});
$('shopSet').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const i = Number(btn.closest('li').dataset.i);
  const devices = shopDevices.map((x) => ({ ...x }));
  if (btn.dataset.act === 'up' && i > 0) {
    [devices[i - 1], devices[i]] = [devices[i], devices[i - 1]];
    shopSave(devices);
  } else if (btn.dataset.act === 'remove') {
    const [gone] = devices.splice(i, 1);
    shopSave(devices, `${gone.name || shopName(gone.entity) || gone.entity} removed from the dashboard.`);
  }
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
