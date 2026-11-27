// The /surfacing page: enter the rough stock, the bit and the cutting values, see the stock and the
// toolpath on the machine's bed, simulate the cut, and save the program in the Files folder.
// The program itself is built in surfacing-gcode.js. Nothing here talks to TNG: the program is only
// saved; loading and running it happens at the machine.

import * as THREE from 'three';
import { ask, askText } from './dialog.js';
import { Viewer } from './viewer.js';
import { buildToolpath } from './gcode.js';
import { planSurfacing, DEFAULTS, fmt } from './surfacing-gcode.js';
import { log } from './log.js';
import { initHelp } from './help.js';
import { navOnState } from './nav.js';
import { initSystem, systemOnState } from './system-ui.js';
import { sentence, fetchJson, UNREACHABLE } from './msg.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['length', 'width', 'thickness', 'zMode', 'startAbove', 'current', 'target', 'toolD', 'depth', 'direction', 'cutWay',
                'rpm', 'feed', 'plunge', 'stepdown', 'stepover', 'safe', 'clearance', 'clearTurn', 'cleanEdges', 'parkGap', 'dwell'];
const PRESET_KEYS = ['rpm', 'feed', 'plunge', 'stepdown', 'stepover'];   // what a stock stores (its cutting values)
const TEXT_FIELDS = new Set(['zMode', 'direction', 'cutWay']);
const CHECK_FIELDS = new Set(['clearTurn', 'cleanEdges']);
// "More settings": kept on the Pi (surfacing_defaults.json), so every device and every new tab
// starts from the last values set anywhere; the rest of the form stays in this browser
const SHARED_FIELDS = ['safe', 'clearance', 'clearTurn', 'cleanEdges', 'parkGap', 'dwell'];
const SHARED_MIN = { safe: 1, clearance: 0, parkGap: 0, dwell: 0 };
const STORE_KEY = 'surfacing.form';
const OLD_STORE_KEY = 'planing.form';   // before the page was called Surfacing: read once, then moved
const writeHeaders = { 'X-CNC-Control': '1', 'Content-Type': 'application/json' };
// Surfaced: two close tones, one pass in each by turns, so the passes show apart but the
// finished top still looks like one colour.
const COLORS = { rough: new THREE.Color('#8a6a48'), side: new THREE.Color('#5e4630'),
                 surfaced: [new THREE.Color('#e0c393'), new THREE.Color('#c9a771')] };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function duration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- the stock, as a height map

/** The stock's top as a grid of heights that the bit lowers as it passes, with walls down to the
 *  bottom. The rough top is drawn flat, at `top`. */
class Stock {
  constructor(length, width, top, bottom) {
    const dx0 = Math.max(Math.sqrt(length * width / 80000), 0.25);   // about 80 000 points at most
    const nx = this.nx = Math.max(2, Math.round(length / dx0));
    const ny = this.ny = Math.max(2, Math.round(width / dx0));
    this.dx = length / nx;
    this.dy = width / ny;
    this.top = top;
    const n = this.n = (nx + 1) * (ny + 1);
    const idx = (i, j) => j * (nx + 1) + i;

    this.h0 = new Float32Array(n).fill(top);
    this.h = new Float32Array(this.h0);

    // Perimeter, counter-clockwise from above; each top point gets a bottom point below it
    const perim = [];
    for (let i = 0; i < nx; i++) perim.push(idx(i, 0));
    for (let j = 0; j < ny; j++) perim.push(idx(nx, j));
    for (let i = nx; i > 0; i--) perim.push(idx(i, ny));
    for (let j = ny; j > 0; j--) perim.push(idx(0, j));
    const p = perim.length;

    this.pos = new Float32Array((n + p) * 3);
    this.col = new Float32Array((n + p) * 3);
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const k = idx(i, j);
        this.pos[k * 3] = i * this.dx;
        this.pos[k * 3 + 1] = j * this.dy;
      }
    }
    perim.forEach((k, m) => {
      const b = (n + m) * 3;
      this.pos[b] = this.pos[k * 3];
      this.pos[b + 1] = this.pos[k * 3 + 1];
      this.pos[b + 2] = bottom;
      this.col.set([COLORS.side.r, COLORS.side.g, COLORS.side.b], b);
    });

    const tris = new Uint32Array(nx * ny * 6 + p * 6);
    let t = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
        tris.set([a, b, c, a, c, d], t);
        t += 6;
      }
    }
    for (let m = 0; m < p; m++) {
      const q = (m + 1) % p;
      tris.set([n + m, n + q, perim[q], n + m, perim[q], perim[m]], t);
      t += 6;
    }

    const geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.colAttr = new THREE.BufferAttribute(this.col, 3);
    geom.setAttribute('position', this.posAttr);
    geom.setAttribute('color', this.colAttr);
    geom.setIndex(new THREE.BufferAttribute(tris, 1));
    this.mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
      transparent: true, opacity: 0.88 }));
    this.mesh.frustumCulled = false;
    this.reset();
  }

  reset() {
    this.h.set(this.h0);
    const { rough } = COLORS;
    for (let k = 0; k < this.n; k++) {
      this.pos[k * 3 + 2] = this.h0[k];
      this.col[k * 3] = rough.r; this.col[k * 3 + 1] = rough.g; this.col[k * 3 + 2] = rough.b;
    }
    this.dirty = true;
  }

  /** The bit (radius r, flat bottom) moving from a to b in a pass: everything under it drops to
   *  its height, in that pass's tone. */
  cut(a, b, r, pass = 1) {
    const z = Math.min(a[2], b[2]);
    if (z >= this.top) return;
    const i0 = Math.max(0, Math.ceil((Math.min(a[0], b[0]) - r) / this.dx));
    const i1 = Math.min(this.nx, Math.floor((Math.max(a[0], b[0]) + r) / this.dx));
    const j0 = Math.max(0, Math.ceil((Math.min(a[1], b[1]) - r) / this.dy));
    const j1 = Math.min(this.ny, Math.floor((Math.max(a[1], b[1]) + r) / this.dy));
    if (i0 > i1 || j0 > j1) return;
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len2 = ex * ex + ey * ey, r2 = r * r;
    const surfaced = COLORS.surfaced[(Math.max(pass, 1) - 1) % 2];
    for (let j = j0; j <= j1; j++) {
      const y = j * this.dy;
      for (let i = i0; i <= i1; i++) {
        const k = j * (this.nx + 1) + i;
        if (this.h[k] <= z) continue;
        const x = i * this.dx;
        let t = len2 ? ((x - a[0]) * ex + (y - a[1]) * ey) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = a[0] + t * ex - x, qy = a[1] + t * ey - y;
        if (qx * qx + qy * qy > r2) continue;
        this.h[k] = z;
        this.pos[k * 3 + 2] = z;
        this.col[k * 3] = surfaced.r; this.col[k * 3 + 1] = surfaced.g; this.col[k * 3 + 2] = surfaced.b;
        this.dirty = true;
      }
    }
  }

  /** Send the changes to the GPU; true if there were any. */
  commit() {
    if (!this.dirty) return false;
    this.dirty = false;
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    return true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// ---------------------------------------------------------------- the 3D view

const viewer = new Viewer($('viewport'));
let stock = null;
let stockKey = '';
let firstPath = true;

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('active', x === b));
  viewer.setView(b.dataset.view);
}));
$('fitBtn').addEventListener('click', () => viewer.fit());
viewer.machineButton($('machineBtn'));
$('pathBtn').addEventListener('click', () => {
  const on = $('pathBtn').classList.toggle('active');
  if (viewer.path) viewer.path.visible = on;
  viewer.dirty = true;
});

function showStock(p, info) {
  const key = [p.length, p.width, info.top, info.bottom].join('|');
  if (key === stockKey) return;
  stockKey = key;
  if (stock) {
    viewer.scene.remove(stock.mesh);
    stock.dispose();
  }
  stock = new Stock(p.length, p.width, info.top, info.bottom);
  viewer.scene.add(stock.mesh);
  viewer.dirty = true;
}

function showProgram(result, p) {
  const path = buildToolpath(result.text);
  viewer.setProgram(path, !firstPath);
  if (firstPath && path) firstPath = false;
  if (viewer.path) viewer.path.visible = $('pathBtn').classList.contains('active');
  viewer.setToolShape({ d: p.toolD, cr: 0, tipAngle: 0, kind: 'flat end mill',
                        length: Math.min(Math.max(10, p.toolD * 0.4), 25) });
}

// ---------------------------------------------------------------- simulation

const sim = { segs: [], total: 0, t: 0, applied: 0, playing: false, last: 0, r: 0 };

function loadSim(result, p) {
  const segs = [];
  let prev = result.info.start;
  for (const m of result.moves) {
    const b = [m.x, m.y, m.z];
    segs.push({ a: prev, b, t0: m.t0, t1: m.t1, pass: m.pass });
    prev = b;
  }
  Object.assign(sim, { segs, total: result.info.time, passes: result.info.passes, r: p.toolD / 2, start: result.info.start });
  stop();
  seek(0);
}

function segAt(t) {
  const s = sim.segs;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t1 < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function pointIn(seg, t) {
  const d = seg.t1 - seg.t0;
  const f = d > 0 ? Math.min(1, Math.max(0, (t - seg.t0) / d)) : 1;
  return [0, 1, 2].map((k) => seg.a[k] + (seg.b[k] - seg.a[k]) * f);
}

/** Cut the stock along the path from time t0 to t1. */
function cutBetween(t0, t1) {
  if (!stock || !sim.segs.length || t1 <= t0) return;
  for (let i = segAt(t0); i < sim.segs.length && sim.segs[i].t0 < t1; i++) {
    const seg = sim.segs[i];
    stock.cut(pointIn(seg, Math.max(t0, seg.t0)), pointIn(seg, Math.min(t1, seg.t1)), sim.r, seg.pass);
  }
}

function seek(t) {
  t = Math.min(Math.max(t, 0), sim.total);
  if (t < sim.applied) {   // going back: start again from the rough stock
    stock?.reset();
    sim.applied = 0;
  }
  cutBetween(sim.applied, t);
  sim.applied = sim.t = t;
  stock?.commit();
  const pos = sim.segs.length ? pointIn(sim.segs[segAt(t)], t) : sim.start || [0, 0, 0];
  viewer.setToolPosition(pos[0], pos[1], pos[2], false);
  viewer.dirty = true;
  const pass = sim.segs.length ? sim.segs[segAt(t)].pass : 0;
  $('simTime').textContent = `${pass ? `pass ${pass}/${sim.passes} · ` : ''}${duration(t)} / ${duration(sim.total)}`;
  if (document.activeElement !== $('simSlider')) $('simSlider').value = sim.total ? Math.round(t / sim.total * 1000) : 0;
}

function frame(now) {
  if (!sim.playing) return;
  const dt = Math.min((now - sim.last) / 1000, 0.1);
  sim.last = now;
  seek(sim.t + dt * Number($('simSpeed').value));
  if (sim.t >= sim.total) { stop(); return; }
  requestAnimationFrame(frame);
}

function play() {
  if (!sim.segs.length) return;
  if (sim.t >= sim.total) seek(0);
  sim.playing = true;
  sim.last = performance.now();
  $('simPlay').textContent = '⏸ Pause';
  requestAnimationFrame(frame);
}

function stop() {
  sim.playing = false;
  $('simPlay').textContent = '▶ Play';
}

$('simPlay').addEventListener('click', () => (sim.playing ? stop() : play()));
$('simReset').addEventListener('click', () => { stop(); seek(0); });
$('simEnd').addEventListener('click', () => { stop(); seek(sim.total); });
$('simSlider').addEventListener('input', () => { stop(); seek($('simSlider').value / 1000 * sim.total); });

// ---------------------------------------------------------------- the form

function readForm() {
  const p = {};
  for (const f of FIELDS) {
    const el = $(f);
    p[f] = CHECK_FIELDS.has(f) ? el.checked
      : TEXT_FIELDS.has(f) ? el.value : (el.value.trim() === '' ? NaN : Number(el.value));
  }
  p.material = $('material').value;
  p.bit = $('bit').value;
  return p;
}

function fillForm(values) {
  for (const f of FIELDS) {
    const v = values[f];
    if (v === undefined || v === null || Number.isNaN(v)) continue;
    if (CHECK_FIELDS.has(f)) $(f).checked = !!v; else $(f).value = v;
  }
}

function remember(p) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* private window: not kept */ }
}

function recall() {
  try {
    let saved = localStorage.getItem(STORE_KEY);
    if (saved === null && (saved = localStorage.getItem(OLD_STORE_KEY)) !== null) {
      localStorage.setItem(STORE_KEY, saved);
      localStorage.removeItem(OLD_STORE_KEY);
    }
    return JSON.parse(saved || 'null');
  } catch { return null; }
}

// ---------------------------------------------------------------- "More settings" on the Pi

let sharedSent = {};       // the values the Pi has, as last read or saved
let sharedTimer = null;    // a save waiting for typing to stop

async function loadShared() {
  try {
    const d = await (await fetch('/api/surfacing/defaults', { cache: 'no-store' })).json();
    if (d && d.ok && d.values) { sharedSent = d.values; return d.values; }
  } catch (e) { log.warn('surfacing: cannot read the shared settings:', e); }
  return null;
}

/** The "More settings" values that are valid now and differ from the Pi's: saved after a pause. */
function saveSharedSoon() {
  clearTimeout(sharedTimer);
  sharedTimer = setTimeout(async () => {
    sharedTimer = null;
    const p = readForm();
    const values = {};
    for (const f of SHARED_FIELDS) {
      const v = p[f];
      const ok = CHECK_FIELDS.has(f) ? typeof v === 'boolean' : Number.isFinite(v) && v >= SHARED_MIN[f];
      if (ok && sharedSent[f] !== v) values[f] = v;
    }
    if (!Object.keys(values).length) return;
    try {
      const d = await fetchJson('/api/surfacing/defaults', { method: 'POST', headers: writeHeaders, body: JSON.stringify({ values }) });
      if (d && d.ok && d.values) sharedSent = d.values;
    } catch (e) { log.warn('surfacing: cannot save the shared settings:', e); }
  }, 800);
}

let plan = null;
let lastParams = null;
let timer = null;

function update() {
  const p = readForm();
  lastParams = p;
  remember(p);
  const result = planSurfacing(p, { travel: bed });   // the end position stays inside the travel
  plan = result;

  // Each Z zero asks for its own numbers (the other mode's stay in the form for switching back)
  const spoil = p.zMode === 'bed';   // Z zero on the spoilboard (not `bed`: that's the machine's travel)
  document.querySelectorAll('#form [data-mode]').forEach((el) => { el.hidden = el.dataset.mode !== p.zMode; });
  for (const f of FIELDS) $(f).classList.toggle('bad', !TEXT_FIELDS.has(f) && !CHECK_FIELDS.has(f) && !(Number.isFinite(p[f]) && p[f] >= 0));
  $('stepoverMm').textContent = Number.isFinite(p.toolD * p.stepover) ? `% of Ø = ${fmt(p.toolD * p.stepover / 100)} mm` : '% of Ø';
  $('zHint').textContent = spoil
    ? 'To bring stock that is already flat to a thickness. Touch off Z on the spoilboard and measure the stock\'s current thickness at its highest point.'
    : 'To surface the rough top of the stock. Touch off Z on its highest point; the program removes the depth from there.';
  const ax = p.direction === 'y' ? 'Y' : 'X';
  $('cutWay').options[1].textContent = `+${ax} only`;
  $('cutWay').options[2].textContent = `−${ax} only`;
  materials.showChanged(p);
  bits.showChanged(p);

  const notes = result.errors.map((e) => `<li class="err">${esc(e)}</li>`);
  if (result.errors.length) {
    $('summary').innerHTML = '';
    $('notes').innerHTML = notes.join('');
    syncButtons();
    return;
  }
  const { info } = result;
  notes.push(...result.warnings.map((w) => `<li>${esc(w)}</li>`), ...bedNotes(info).map((w) => `<li>${esc(w)}</li>`));
  $('notes').innerHTML = notes.join('');
  const rows = [
    ['Passes', `${info.passes} × ${fmt(info.passDepth)} mm`],
    ...(p.startAbove > 0 ? [['First pass from', `Z${fmt(info.startZ)}, ${fmt(p.startAbove)} mm above Z0`]] : []),
    ['Lines per pass', `${info.lines}, ${fmt(info.step)} mm apart at most${p.cutWay === 'both' ? '' : `, all cut towards ${p.cutWay === 'plus' ? '+' : '−'}${p.direction === 'y' ? 'Y' : 'X'}`}`],
    ['Last pass at', `Z${fmt(info.finalTop)}`],
    spoil ? ['Removes', `${fmt(info.depth)} mm, ${fmt(p.current)} → ${fmt(p.target)} mm thick`]
          : ['Removes', `${fmt(info.depth)} mm from the top`],
    ['Bit centre travels', `X ${fmt(info.bounds.min[0])} … ${fmt(info.bounds.max[0])}, Y ${fmt(info.bounds.min[1])} … ${fmt(info.bounds.max[1])}`],
    ['Run time', `about ${duration(info.time)}`],
  ];
  $('summary').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  syncButtons();
  if (!nameEdited) $('fileName').value = defaultName(p);

  showStock(p, info);
  showProgram(result, p);
  loadSim(result, p);
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      update();
    } catch (e) {
      log.error('surfacing: building the program failed:', e);
      $('notes').innerHTML = `<li class="err">Could not build the program: ${esc(e.message)}</li>`;
    }
  }, 150);
}

$('form').addEventListener('input', schedule);
$('form').addEventListener('change', schedule);
for (const f of SHARED_FIELDS) {
  $(f).addEventListener('input', saveSharedSoon);
  $(f).addEventListener('change', saveSharedSoon);
}
$('form').addEventListener('submit', (e) => e.preventDefault());

// ---------------------------------------------------------------- the machine's bed

let bed = null;
let bedOffset = null;
let filesEnabled = false;

/** Where the path leaves the machine's travel, as notes for the page. */
function bedNotes(info) {
  if (!bed) return ['Machine travel unknown (TNG not connected): check that the path fits on the machine.'];
  const out = [];
  const { min, max } = info.bounds;
  for (const [k, axis] of [[0, 'X'], [1, 'Y']]) {
    if (min[k] < bed.min[k] - 0.01 || max[k] > bed.max[k] + 0.01) {
      out.push(`The bit goes outside the machine's ${axis} travel (${fmt(min[k])} … ${fmt(max[k])}; ` +
               `travel ${fmt(bed.min[k])} … ${fmt(bed.max[k])} from the current work zero).`);
    }
  }
  if (min[2] < bed.min[2] - 0.01) out.push(`Z${fmt(min[2])} is below the machine's Z travel from the current work zero.`);
  if (max[2] > bed.max[2] + 0.01) out.push(`The safe height Z${fmt(max[2])} is above the machine's Z travel from the current work zero.`);
  return out;
}

async function pollState() {
  try {
    const s = await (await fetch('/api/state', { cache: 'no-store' })).json();
    const name = s.machine_name || 'PlanetCNC';
    $('machineName').textContent = name;
    document.title = 'Surfacing – ' + name;
    navOnState(s);
    systemOnState(s);   // status and E-stop in the top bar
    const w = s.work || [], m = s.machine || [];
    if (w.length >= 3 && m.length >= 3 && (s.idle || !bedOffset)) bedOffset = [0, 1, 2].map((k) => w[k] - m[k]);
    const next = s.limits && bedOffset ? {
      min: [0, 1, 2].map((k) => s.limits.min[k] + bedOffset[k]),
      max: [0, 1, 2].map((k) => s.limits.max[k] + bedOffset[k]),
    } : null;
    const changed = JSON.stringify(next) !== JSON.stringify(bed);
    bed = next;
    viewer.setBed(bed);
    $('bedNote').textContent = bed ? 'Box: machine travel' : '';
    tngLoad = !s.bridge_online ? 'TNG is not connected'
      : (s.bridge_protocol || 1) < 4 ? 'The bridge in TNG is too old to load programs: install the update, or restart TNG'
      : s.running ? 'The machine is running: load it when it has stopped' : '';
    syncButtons();
    if (s.files_enabled !== filesEnabled) {
      filesEnabled = !!s.files_enabled;
      showFolder();
    }
    // The end position is kept inside the travel (from the current work zero): build the program again
    if (changed && plan) schedule();
  } catch {
    tngLoad = UNREACHABLE;
    syncButtons();
    systemOnState({});   // server not reachable: OFFLINE, and no E-stop from here; try again
  }
  // Every second, so the status and the E-stop button are as current as on the dashboard
  setTimeout(pollState, document.visibilityState === 'visible' ? 1000 : 5000);
}

// ---------------------------------------------------------------- materials and bits
// Named values kept on the Pi (the Stock & Bit page shows them all): a stock (oak...) holds the cutting
// values, a bit its diameter. Picking one fills in the form; "Changed" shows when the form no
// longer matches it; Save as... and Delete change the list.

function library(cfg) {
  // cfg: {api, select, save, del, msg, changed, none, what, fields: {stored key: form field}, ask}
  const sel = $(cfg.select);
  // What Save as... and Delete did: under the list, not by the program's Save button
  const message = (html, kind = '') => { $(cfg.msg).innerHTML = sentence(html); $(cfg.msg).className = 'pl-msg' + (kind ? ' ' + kind : ''); };
  const syncDelete = () => {
    $(cfg.del).disabled = !sel.value;
    $(cfg.del).title = sel.value ? `Delete the ${cfg.what} ${sel.value}` : `Pick a saved ${cfg.what} to delete it`;
  };
  const keys = Object.entries(cfg.fields);
  const lib = { items: {} };

  lib.render = (pick) => {
    const names = Object.keys(lib.items).sort((a, b) => a.localeCompare(b));
    const cur = pick ?? sel.value;
    sel.innerHTML = `<option value="">${cfg.none}</option>` + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    sel.value = names.includes(cur) ? cur : '';
    syncDelete();
  };
  // Each value that differs from the picked stock or bit: an amber field and a ↺ button that puts the saved
  // value back (as OrcaSlicer does); "Changed" next to the title while any differs
  const revertBtn = (k, f) => {
    let b = $(f).parentNode.querySelector('.pl-revert');
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.className = 'pl-revert';
      b.hidden = true;
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
      b.addEventListener('click', () => {
        const it = lib.items[sel.value];
        if (!it) return;
        $(f).value = it[k];
        $(f).dispatchEvent(new Event('input', { bubbles: true }));   // builds the program again
        $(f).focus();
      });
      $(f).before(b);
    }
    return b;
  };
  lib.showChanged = (p) => {
    const it = lib.items[sel.value];
    let any = false;
    for (const [k, f] of keys) {
      const differs = !!it && it[k] !== p[f];
      any = any || differs;
      const b = revertBtn(k, f);
      b.hidden = !differs;
      if (differs) {
        b.title = `Back to ${sel.value}'s value: ${it[k]}`;
        b.setAttribute('aria-label', b.title);
      }
      $(f).classList.toggle('changed', differs);
    }
    $(cfg.changed).hidden = !any;
  };
  lib.load = async (pick) => {
    try {
      lib.items = (await (await fetch(cfg.api, { cache: 'no-store' })).json()).presets || {};
    } catch { lib.items = {}; }
    lib.render(pick);
  };
  async function call(body) {
    const res = await fetchJson(cfg.api, { method: 'POST', headers: writeHeaders, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(res.message || 'failed');
    lib.items = res.presets || lib.items;
    return res;
  }

  sel.addEventListener('change', () => {
    const it = lib.items[sel.value];
    if (it) fillForm(Object.fromEntries(keys.map(([k, f]) => [f, it[k]])));
    syncDelete();
    schedule();
  });

  $(cfg.save).addEventListener('click', async () => {
    const p = readForm();
    const values = Object.fromEntries(keys.map(([k, f]) => [k, p[f]]));
    if (!keys.every(([k]) => Number.isFinite(values[k]) && values[k] > 0)) {
      message(cfg.missing, 'err');
      return;
    }
    const name = await askText({ ...cfg.ask, value: sel.value, ok: 'Save' });
    if (!name) return;
    const existing = Object.keys(lib.items).find((n) => n.toLowerCase() === name.toLowerCase());
    if (existing && existing !== sel.value
        && !await ask({ title: `Replace the ${cfg.what}?`, text: `${existing} is already saved.`, ok: 'Replace', danger: true })) return;
    try {
      const res = await call({ action: 'save', name, values });
      lib.render(res.name);
      lib.showChanged(readForm());
      message(`Saved the ${cfg.what} ${esc(res.name)}.`, 'ok');
      schedule();   // the file name follows the stock
    } catch (e) {
      message(`Could not save the ${cfg.what}: ${esc(e.message)}`, 'err');
    }
  });

  $(cfg.del).addEventListener('click', async () => {
    const name = sel.value;
    if (!name || !await ask({ title: `Delete the ${cfg.what}?`, text: `${name} is deleted, for every device; this cannot be undone. The values in the form stay.`,
      ok: 'Delete', danger: true })) return;
    try {
      await call({ action: 'delete', name });
      lib.render('');
      message(`Deleted ${esc(name)}.`, 'ok');
      schedule();
    } catch (e) {
      message(`Could not delete the ${cfg.what}: ${esc(e.message)}`, 'err');
    }
  });
  return lib;
}

const materials = library({
  api: '/api/surfacing/presets', select: 'material', save: 'matSave', del: 'matDelete', msg: 'matMsg', changed: 'matChanged',
  none: 'No saved stock', what: 'stock',
  fields: Object.fromEntries(PRESET_KEYS.map((k) => [k, k])),
  missing: 'Fill in spindle speed, feeds, step-down and stepover first.',
  ask: { title: 'Save as a stock', label: 'Stock',
         text: 'The spindle speed, feeds, step-down and stepover, under the name of a stock (e.g. Oak).' },
});
const bits = library({
  api: '/api/surfacing/bits', select: 'bit', save: 'bitSave', del: 'bitDelete', msg: 'bitMsg', changed: 'bitChanged',
  none: 'No saved bit', what: 'bit',
  fields: { d: 'toolD' },
  missing: 'Fill in the bit diameter first.',
  ask: { title: 'Save as a bit', label: 'Bit', text: 'The bit diameter, under the name of the bit (e.g. Surfacing 50 mm).' },
});

// Changed on the Stock & Bit page (another tab, or another device): pick them up when this page
// is shown again.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  const [shared] = await Promise.all([sharedTimer ? null : loadShared(), materials.load(), bits.load()]);
  // Changed on another device meanwhile: take them (unless a change made here is still to be saved)
  if (shared && !sharedTimer) {
    const now = readForm();
    if (SHARED_FIELDS.some((f) => f in shared && shared[f] !== now[f])) { fillForm(shared); schedule(); }
  }
  const p = readForm();
  materials.showChanged(p);
  bits.showChanged(p);
});

// ---------------------------------------------------------------- saving the program

let nameEdited = false;
$('fileName').addEventListener('input', () => { nameEdited = $('fileName').value.trim() !== ''; });
$('fileName').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('saveBtn').disabled) $('saveBtn').click(); });

function defaultName(p) {
  const mat = (p.material || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const cut = p.zMode === 'bed' ? `to${fmt(p.target)}mm` : `${fmt(p.depth)}mm`;
  return `surface_${mat ? mat + '_' : ''}${fmt(p.length)}x${fmt(p.width)}_${cut}.nc`;
}

function message(html, kind = '') {
  $('saveMsg').innerHTML = sentence(html);
  $('saveMsg').className = 'pl-msg' + (kind ? ' ' + kind : '');
}

let busy = false;      // saving or loading
let tngLoad = 'TNG is not connected';   // why the program can't be loaded in TNG now ('' = it can)

function syncButtons() {
  const ready = !!plan && !plan.errors.length && !busy;
  $('saveBtn').disabled = !ready || !filesEnabled;
  $('saveBtn').title = !filesEnabled ? 'No Files folder: choose one in Settings' : busy ? 'Busy…'
    : !ready ? 'Fix the values marked in red first' : 'Save the program in the Files folder';
  $('loadBtn').disabled = !ready || !!tngLoad;
  $('loadBtn').title = tngLoad || (busy ? 'Busy…' : !ready ? 'Fix the values marked in red first'
    : 'Load the program into the machine (TNG) without saving it (it does not start it)');
}

async function showFolder() {
  syncButtons();
  if (!filesEnabled) {
    $('folderHint').textContent = 'No Files folder: choose one in Settings to save programs.';
    return;
  }
  try {
    const d = await (await fetch('/api/files?path=', { cache: 'no-store' })).json();
    $('folderHint').textContent = d.ok ? `Saved in ${d.abs}.` : '';
  } catch { $('folderHint').textContent = ''; }
}

async function upload(name, text, overwrite) {
  const url = `/api/files/upload?path=&name=${encodeURIComponent(name)}${overwrite ? '&overwrite=1' : ''}`;
  return fetchJson(url, { method: 'POST', body: text, headers: { 'X-CNC-Control': '1', 'Content-Type': 'application/octet-stream' } });
}

/** Save the program in the Files folder; returns its name, or null when it wasn't saved. */
async function saveProgram() {
  if (!plan || plan.errors.length) return null;
  let name = $('fileName').value.trim();
  if (!name || /[\\/<>:"|?*]/.test(name) || name.startsWith('.')) { message('Enter a valid file name.', 'err'); return null; }
  if (!/\.[a-z0-9]{1,5}$/i.test(name)) name += '.nc';
  $('fileName').value = name;
  // The program carries the date it was made: rebuild it now, with the values on screen
  const text = planSurfacing(lastParams, { travel: bed }).text;
  message('Saving…');
  try {
    let res = await upload(name, text, false);
    if (!res.ok && res.exists) {
      if (!await ask({ title: 'Replace the file?', text: `${name} already exists in the Files folder.`, ok: 'Replace', danger: true })) {
        message('');
        return null;
      }
      res = await upload(name, text, true);
    }
    if (!res.ok) throw new Error(res.message || 'failed');
    log.info(`surfacing: saved ${name} (${plan.info.passes} passes, ${fmt(plan.info.depth)} mm)`);
    return name;
  } catch (e) {
    log.warn(`surfacing: saving ${name} failed:`, e.message);
    message(`Could not save: ${esc(e.message)}`, 'err');
    return null;
  }
}

async function withButtons(work) {
  busy = true;
  syncButtons();
  try { await work(); } finally { busy = false; syncButtons(); }
}

$('saveBtn').addEventListener('click', () => withButtons(async () => {
  const name = await saveProgram();
  if (name) message(`Saved ${esc(name)}. Load it into the machine to run it.`, 'ok');
}));

$('loadBtn').addEventListener('click', () => withButtons(async () => {
  if (!plan || plan.errors.length) return;
  let name = $('fileName').value.trim() || defaultName(lastParams);
  if (!/\.[a-z0-9]{1,5}$/i.test(name)) name += '.nc';
  // The program carries the date it was made: rebuild it now, with the values on screen
  const text = planSurfacing(lastParams, { travel: bed }).text;
  message('Loading into the machine…');
  const res = await fetchJson('/api/tng/send', { method: 'POST', headers: writeHeaders, body: JSON.stringify({ name, text }) });
  if (res.ok && res.loaded) {
    message(`Loaded ${esc(name)} into the machine (not saved): start it there.`, 'ok');
    log.info(`surfacing: sent ${name} to TNG (${plan.info.passes} passes, ${fmt(plan.info.depth)} mm)`);
  } else if (res.ok) {
    message(`${esc(res.message)}: check TNG.`, 'err');
  } else {
    log.warn(`surfacing: sending ${name} to TNG failed:`, res.message);
    message(`Could not load it into the machine: ${esc(res.message || 'failed')}`, 'err');
  }
}));

// ---------------------------------------------------------------- start

(async () => {
  const saved = recall();
  if (saved && saved.zMode === 'bed' && !('current' in saved) && saved.thickness > 0 && saved.depth > 0) {
    // Saved before the spoilboard mode had its own fields: same cut, in the new terms
    saved.current = saved.thickness;
    saved.target = saved.thickness - saved.depth;
  }
  initSystem();   // the E-stop button
  initHelp($('form'));
  // The Pi's "More settings" win over this browser's copy: the last ones set, on any device
  const shared = await loadShared();
  fillForm({ ...DEFAULTS, ...(saved || {}), ...(shared || {}) });
  await Promise.all([materials.load(saved?.material || ''), bits.load(saved?.bit || '')]);
  schedule();
  pollState();
})();
