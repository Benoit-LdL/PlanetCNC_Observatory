// The /materials page: the Planing page's materials (cutting values per material) in one table,
// to change, add, delete, import and export. Stored by the server in planing_presets.json
// (/api/planing/presets); renaming is saving under the new name and deleting the old one.

import { ask } from './dialog.js';
import { followState } from './nav.js';
import { initSystem, systemOnState } from './system-ui.js';

const $ = (id) => document.getElementById(id);
const KEYS = ['rpm', 'feed', 'plunge', 'stepdown', 'stepover'];
const writeHeaders = { 'X-CNC-Control': '1', 'Content-Type': 'application/json' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

let presets = {};

function message(text, kind = '') {
  $('msg').textContent = text;
  $('msg').className = 'mt-msg' + (kind ? ' ' + kind : '');
}

async function load() {
  try {
    const d = await (await fetch('/api/planing/presets', { cache: 'no-store' })).json();
    presets = d.presets || {};
  } catch {
    message('Cannot reach the server.', 'err');
  }
  render();
}

async function call(body) {
  const r = await fetch('/api/planing/presets', { method: 'POST', headers: writeHeaders, body: JSON.stringify(body) });
  const res = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  if (!res.ok) throw new Error(res.message || 'failed');
  if (res.presets) presets = res.presets;
  return res;
}

const numInput = (k, v) => `<input data-k="${k}" type="number" step="any" min="0" inputmode="decimal" value="${esc(v ?? '')}">`;

function render() {
  const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
  $('rows').innerHTML = names.length ? names.map((n) => `
    <tr data-name="${esc(n)}">
      <td><input class="name" data-k="name" maxlength="40" value="${esc(n)}" aria-label="Name"></td>
      ${KEYS.map((k) => `<td>${numInput(k, presets[n][k])}</td>`).join('')}
      <td class="acts"><button class="vbtn primary" type="button" data-save disabled>Save</button><button class="vbtn text danger" type="button" data-delete>Delete</button></td>
    </tr>`).join('')
    : '<tr><td colspan="7" class="mt-empty">No materials yet: add one below, or import a file.</td></tr>';
}

/** The row's name and values, and whether they are valid (bad inputs are marked). */
function readRow(tr) {
  const name = tr.querySelector('[data-k=name]').value.trim().replace(/\s+/g, ' ');
  const values = {};
  let ok = !!name;
  tr.querySelector('[data-k=name]').classList.toggle('bad', !name);
  for (const k of KEYS) {
    const el = tr.querySelector(`[data-k=${k}]`);
    const v = el.value.trim() === '' ? NaN : Number(el.value);
    const good = Number.isFinite(v) && v > 0;
    el.classList.toggle('bad', !good);
    ok = ok && good;
    values[k] = v;
  }
  return { name, values, ok };
}

$('rows').addEventListener('input', (e) => {
  const tr = e.target.closest('tr[data-name]');
  if (!tr) return;
  const old = tr.dataset.name;
  const { name, values, ok } = readRow(tr);
  const changed = name !== old || KEYS.some((k) => values[k] !== presets[old]?.[k]);
  tr.classList.toggle('changed', changed);
  tr.querySelector('[data-save]').disabled = !changed || !ok;
});

$('rows').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  const tr = b?.closest('tr[data-name]');
  if (!tr) return;
  const old = tr.dataset.name;
  if (b.dataset.delete !== undefined) {
    if (!await ask({ title: 'Delete the material?', text: `${old} and its cutting values are deleted, for every device.`,
      ok: 'Delete', danger: true })) return;
    try {
      await call({ action: 'delete', name: old });
      message(`Deleted ${old}.`, 'ok');
    } catch (err) {
      message(`Could not delete ${old}: ${err.message}`, 'err');
    }
    render();
  } else if (b.dataset.save !== undefined) {
    const { name, values, ok } = readRow(tr);
    if (!ok) return;
    const clash = Object.keys(presets).find((n) => n !== old && same(n, name));
    if (clash && !await ask({ title: 'Replace the material?', text: `There is already a material called ${clash}.`, ok: 'Replace', danger: true })) return;
    try {
      await call({ action: 'save', name, values });
      // Renamed: drop the old name (unless only its case changed: saving already replaced it)
      if (!same(name, old)) await call({ action: 'delete', name: old });
      message(name === old ? `Saved ${name}.` : `Saved ${old} as ${name}.`, 'ok');
    } catch (err) {
      message(`Could not save ${name}: ${err.message}`, 'err');
    }
    render();
  }
});

$('addBtn').addEventListener('click', async () => {
  const tr = $('addRow');
  const { name, values, ok } = readRow(tr);
  if (!ok) { message('Fill in a name and all the values (above 0) first.', 'err'); return; }
  const clash = Object.keys(presets).find((n) => same(n, name));
  if (clash && !await ask({ title: 'Replace the material?', text: `There is already a material called ${clash}.`, ok: 'Replace', danger: true })) return;
  try {
    await call({ action: 'save', name, values });
    tr.querySelectorAll('input').forEach((el) => { el.value = ''; });
    message(`Added ${name}.`, 'ok');
    render();
  } catch (err) {
    message(`Could not add ${name}: ${err.message}`, 'err');
  }
});
$('addRow').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addBtn').click(); });
$('addRow').addEventListener('input', (e) => e.target.classList.remove('bad'));

// Export / import: the same format as planing_presets.json on the Pi, {"presets": {name: values}}.
$('exportBtn').addEventListener('click', () => {
  const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
  if (!names.length) { message('There are no materials to export yet.', 'err'); return; }
  const data = { presets: Object.fromEntries(names.map((n) => [n, presets[n]])) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1) + '\n'], { type: 'application/json' }));
  a.download = 'planing-materials.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  message(`Exported ${names.length} material${names.length === 1 ? '' : 's'}.`, 'ok');
});

$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let list;
  try {
    const d = JSON.parse(await file.text());
    const src = d && typeof d.presets === 'object' ? d.presets : d;   // also a bare {name: values}
    if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('no materials in it');
    list = Object.entries(src).filter(([, v]) => v && typeof v === 'object'
      && KEYS.every((k) => Number.isFinite(v[k]) && v[k] > 0));
    if (!list.length) throw new Error('no valid materials in it');
  } catch (err) {
    message(`Cannot import ${file.name}: ${err.message}`, 'err');
    return;
  }
  const clashes = list.filter(([n]) => Object.keys(presets).some((p) => same(p, n.trim()))).map(([n]) => n);
  const replace = !clashes.length || await ask({ title: 'Some materials already exist',
    text: `${clashes.join(', ')}.\n\nReplace them with the imported values, or keep the ones you have?`,
    ok: 'Replace them', cancel: 'Keep mine' });
  let added = 0, failed = 0;
  for (const [name, v] of list) {
    if (!replace && clashes.includes(name)) continue;
    try {
      await call({ action: 'save', name, values: Object.fromEntries(KEYS.map((k) => [k, v[k]])) });
      added++;
    } catch { failed++; }
  }
  render();
  message(`Imported ${added} material${added === 1 ? '' : 's'}${failed ? `, ${failed} could not be saved` : ''}.`,
          failed ? 'err' : 'ok');
});

initSystem();   // the E-stop button
followState(systemOnState, 'Materials');

load();
