// The /materials page: what the Planing page fills in when you pick one, in two tables:
// - Materials: the cutting values per material (/api/planing/presets, planing_presets.json);
// - Planing bits: their diameter (/api/planing/bits, planing_bits.json).
// Change, add, delete, import and export; renaming is saving under the new name and deleting the
// old one. Both tables are the same code (libraryTable), told which values they hold.

import { ask } from './dialog.js';
import { followState } from './nav.js';
import { initSystem, systemOnState } from './system-ui.js';
import { initHelp } from './help.js';
import { sentence, fetchJson, UNREACHABLE } from './msg.js';

const writeHeaders = { 'X-CNC-Control': '1', 'Content-Type': 'application/json' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One table of named values in a card. cfg: {api, keys: [[key, label]], what, whats, file, empty, example}. */
function libraryTable(card, cfg) {
  const $ = (role) => card.querySelector(`[data-role="${role}"]`);
  const KEYS = cfg.keys.map(([k]) => k);
  let items = {};

  const message = (text, kind = '') => {
    $('msg').textContent = sentence(text);
    $('msg').className = 'mt-msg' + (kind ? ' ' + kind : '');
  };
  const numInput = (k, label, v = '') =>
    `<input data-k="${k}" type="number" step="any" min="0" inputmode="decimal" value="${esc(v)}" aria-label="${esc(label)}">`;

  // The header and the row to add one, from the keys
  $('head').innerHTML = '<th>Name</th>' + cfg.keys.map(([, label, unit]) =>
    `<th>${esc(label)}${unit ? ` <span class="unit">${esc(unit)}</span>` : ''}</th>`).join('') + '<th></th>';
  $('add').innerHTML = `<td><input class="name" data-k="name" placeholder="New ${esc(cfg.what)}" maxlength="40" aria-label="Name"></td>`
    + cfg.keys.map(([k, label]) => `<td>${numInput(k, label)}</td>`).join('')
    + '<td class="acts"><button class="vbtn tonal" type="button" data-role="addBtn">Add</button></td>';

  async function load() {
    try {
      const d = await (await fetch(cfg.api, { cache: 'no-store' })).json();
      items = d.presets || {};
    } catch {
      message(UNREACHABLE, 'err');
    }
    render();
  }

  async function call(body) {
    const res = await fetchJson(cfg.api, { method: 'POST', headers: writeHeaders, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(res.message || 'failed');
    if (res.presets) items = res.presets;
    return res;
  }

  function render() {
    const names = Object.keys(items).sort((a, b) => a.localeCompare(b));
    $('rows').innerHTML = names.length ? names.map((n) => `
      <tr data-name="${esc(n)}">
        <td><input class="name" data-k="name" maxlength="40" value="${esc(n)}" aria-label="Name"></td>
        ${cfg.keys.map(([k, label]) => `<td>${numInput(k, label, items[n][k] ?? '')}</td>`).join('')}
        <td class="acts"><button class="vbtn primary" type="button" data-save disabled>Save</button><button class="vbtn text danger" type="button" data-delete>Delete</button></td>
      </tr>`).join('')
      : `<tr><td colspan="${KEYS.length + 2}" class="mt-empty">${esc(cfg.empty)}</td></tr>`;
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

  const replaceIt = (clash) => ask({ title: `Replace the ${cfg.what}?`, text: `There is already a ${cfg.what} called ${clash}.`,
    ok: 'Replace', danger: true });

  $('rows').addEventListener('input', (e) => {
    const tr = e.target.closest('tr[data-name]');
    if (!tr) return;
    const old = tr.dataset.name;
    const { name, values, ok } = readRow(tr);
    const changed = name !== old || KEYS.some((k) => values[k] !== items[old]?.[k]);
    tr.classList.toggle('changed', changed);
    tr.querySelector('[data-save]').disabled = !changed || !ok;
  });

  $('rows').addEventListener('keydown', (e) => {
    const save = e.key === 'Enter' && e.target.closest('tr[data-name]')?.querySelector('[data-save]');
    if (save && !save.disabled) save.click();
  });

  $('rows').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    const tr = b?.closest('tr[data-name]');
    if (!tr) return;
    const old = tr.dataset.name;
    if (b.dataset.delete !== undefined) {
      if (!await ask({ title: `Delete the ${cfg.what}?`, text: `${old} is deleted, for every device; this cannot be undone.`, ok: 'Delete', danger: true })) return;
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
      const clash = Object.keys(items).find((n) => n !== old && same(n, name));
      if (clash && !await replaceIt(clash)) return;
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
    const tr = $('add');
    const { name, values, ok } = readRow(tr);
    if (!ok) { message('Fill in a name and all the values (above 0) first.', 'err'); return; }
    const clash = Object.keys(items).find((n) => same(n, name));
    if (clash && !await replaceIt(clash)) return;
    try {
      await call({ action: 'save', name, values });
      tr.querySelectorAll('input').forEach((el) => { el.value = ''; });
      message(`Added ${name}.`, 'ok');
      render();
    } catch (err) {
      message(`Could not add ${name}: ${err.message}`, 'err');
    }
  });
  $('add').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addBtn').click(); });
  $('add').addEventListener('input', (e) => e.target.classList.remove('bad'));

  // Export / import: the same format as the file on the Pi, {"presets": {name: values}}.
  $('export').addEventListener('click', () => {
    const names = Object.keys(items).sort((a, b) => a.localeCompare(b));
    if (!names.length) { message(`There are no ${cfg.whats} to export yet.`, 'err'); return; }
    const data = { presets: Object.fromEntries(names.map((n) => [n, items[n]])) };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1) + '\n'], { type: 'application/json' }));
    a.download = cfg.file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    message(`Exported ${plural(names.length, cfg.what, cfg.whats)}.`, 'ok');
  });

  $('import').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let list;
    try {
      const d = JSON.parse(await file.text());
      const src = d && typeof d.presets === 'object' ? d.presets : d;   // also a bare {name: values}
      if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error(`no ${cfg.whats} in it`);
      list = Object.entries(src).filter(([, v]) => v && typeof v === 'object'
        && KEYS.every((k) => Number.isFinite(v[k]) && v[k] > 0));
      if (!list.length) throw new Error(`no valid ${cfg.whats} in it`);
    } catch (err) {
      message(`Cannot import ${file.name}: ${err.message}`, 'err');
      return;
    }
    const clashes = list.filter(([n]) => Object.keys(items).some((p) => same(p, n.trim()))).map(([n]) => n);
    const replace = !clashes.length || await ask({ title: `Some ${cfg.whats} already exist`,
      text: `${clashes.join(', ')}.\n\nReplace them with the imported values, or keep the ones you have?`,
      ok: 'Replace them', cancel: 'Keep mine', danger: true });
    let added = 0, failed = 0;
    for (const [name, v] of list) {
      if (!replace && clashes.includes(name)) continue;
      try {
        await call({ action: 'save', name, values: Object.fromEntries(KEYS.map((k) => [k, v[k]])) });
        added++;
      } catch { failed++; }
    }
    render();
    message(`Imported ${plural(added, cfg.what, cfg.whats)}${failed ? `, ${failed} could not be saved` : ''}.`, failed ? 'err' : 'ok');
  });

  return { load };
}

const materials = libraryTable(document.getElementById('materialsCard'), {
  api: '/api/planing/presets', what: 'material', whats: 'materials', file: 'planing-materials.json',
  empty: 'No materials yet: add one below, or import a file.',
  keys: [['rpm', 'Spindle speed', 'rpm'], ['feed', 'Feed', 'mm/min'], ['plunge', 'Plunge feed', 'mm/min'],
         ['stepdown', 'Step-down', 'mm/pass'], ['stepover', 'Stepover', '% of Ø']],
});
const bits = libraryTable(document.getElementById('bitsCard'), {
  api: '/api/planing/bits', what: 'bit', whats: 'bits', file: 'planing-bits.json',
  empty: 'No bits yet: add one below, or import a file.',
  keys: [['d', 'Bit diameter', 'mm']],
});

initSystem();   // the E-stop button
initHelp();
followState(systemOnState, 'Stock & Bit');   // as in the menu

materials.load();
bits.load();
// Changed on the Planing page (another tab, or another device): pick them up when shown again
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { materials.load(); bits.load(); }
});
