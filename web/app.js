import { Viewer } from './viewer.js';
import { ask, askText } from './dialog.js';
import { buildToolpath, parseTools } from './gcode.js';
import { log } from './log.js';
import { initTune, openTune, tuneLogLoad } from './tune-ui.js';
import { initSystem, systemOnState } from './system-ui.js';
import { navOnState } from './nav.js';
import { sentence, UNREACHABLE } from './msg.js';

const $ = (id) => document.getElementById(id);
const ROW_H = 20;          // must match .row height in style.css
const OVERSCAN = 30;       // extra G-code rows rendered above/below the visible area
const AXES = ['X', 'Y', 'Z', 'A', 'B', 'C'];

const viewer = new Viewer($('viewport'));

let state = {};
let coordMode = 'work';
let programId = null;
let programLoading = null;
let jobStart = null;
let wasRunning = false;
let bedOffset = null;   // work - machine, measured while idle (see the bed in onState)

// ---------------------------------------------------------------- DRO

function renderDro() {
  const vals = state[coordMode] || [];
  const decimals = state.units === 'in' ? 4 : 3;
  // Always show XYZ; rotary axes only if they're in use.
  const shown = AXES.filter((_, i) => i < 3 || Math.abs(vals[i] || 0) > 1e-9);
  const dro = $('dro');
  if (dro.childElementCount !== shown.length) {
    dro.innerHTML = shown.map((a) =>
      `<div class="axis"><span class="name">${a}</span><span class="value">0</span></div>`).join('');
  }
  shown.forEach((a, k) => {
    const v = vals[AXES.indexOf(a)] || 0;
    dro.children[k].querySelector('.value').textContent = v.toFixed(decimals);
  });
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    coordMode = tab.dataset.coord;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderDro();
  });
}

// ---------------------------------------------------------------- status / job info

function fmtDuration(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

function renderInfo() {
  const s = state;
  // The status pill in the top bar is drawn by system-ui.js, as on every page
  const file = s.program_name || s.file || '';
  $('fileName').textContent = file || 'No program loaded';
  $('fileName').title = file;

  $('feed').textContent = Math.round(s.feed || 0);
  $('feedUnit').textContent = s.units === 'in' ? 'in/min' : 'mm/min';
  $('spindle').textContent = Math.round(s.spindle || 0);
  $('tool').textContent = s.tool ?? '–';
  $('toolName').textContent = [s.tool_name, toolShown].filter(Boolean).join(' · ');
  $('toolName').title = $('toolName').textContent;
  $('coordsys').textContent = s.coordsys || '–';

  const total = s.line_count || codeLines.length || 0;
  const line = s.line || 0;
  const pct = total ? Math.min(100, Math.max(0, (line / total) * 100)) : 0;
  $('lineInfo').textContent = total ? `${line} / ${total}` : '– / –';
  $('pctInfo').textContent = pct.toFixed(pct < 10 ? 1 : 0) + ' %';
  $('jobBar').style.width = pct + '%';

  // Remaining: TNG's own estimate when available, else extrapolate from the
  // progress made since we started watching this job.
  let remain = typeof s.time_to_end === 'number' && s.time_to_end >= 0 ? s.time_to_end : null;
  if (remain == null && s.running && jobStart && pct - jobStart.pct > 1) {
    const elapsed = (s.server_time ?? Date.now() / 1000) - jobStart.time;
    remain = elapsed * (100 - pct) / (pct - jobStart.pct);
  }
  $('remainInfo').textContent = s.running ? fmtDuration(remain) : '–';
  // Since the job started (pauses included); the server keeps the start time.
  const started = s.running && typeof s.job_started === 'number' ? s.job_started : null;
  $('startInfo').textContent = started
    ? new Date(started * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–';
  $('elapsedInfo').textContent = started ? fmtDuration((s.server_time ?? Date.now() / 1000) - started) : '–';

  updateToolShape();
  $('updateInfo').textContent = s.bridge_online
    ? new Date((s.server_time ?? Date.now() / 1000) * 1000).toLocaleTimeString()
    : 'bridge offline';
}

// ---------------------------------------------------------------- G-code listing (virtualized)

const codeEl = $('code');
const rowsEl = $('codeRows');
let codeLines = [];
let activeLine = 0;
let followCode = true;
let rendered = { first: -1, last: -1, active: -1 };

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const TOKEN_CLASS = { G: 'tk-g', M: 'tk-m', F: 'tk-f', S: 'tk-s', T: 'tk-t', N: 'tk-n' };
const TOKEN_RE = /(\([^)]*\)?|;.*$)|([A-Za-z])(\s*[-+]?[\d.]*)/g;

function highlight(line) {
  let out = '', last = 0, m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line))) {
    out += esc(line.slice(last, m.index));
    if (m[1]) {
      out += `<span class="tk-c">${esc(m[1])}</span>`;
    } else {
      const L = m[2].toUpperCase();
      const cls = TOKEN_CLASS[L] || ('XYZABCUVWIJKRPQ'.includes(L) ? 'tk-xyz' : '');
      out += cls ? `<span class="${cls}">${esc(m[0])}</span>` : esc(m[0]);
    }
    last = TOKEN_RE.lastIndex;
  }
  return out + esc(line.slice(last));
}

function renderCode(force = false) {
  if (!codeLines.length) {
    rowsEl.innerHTML = `<div class="code-empty">${programLoading ? 'Loading program…' : 'No program loaded'}</div>`;
    rendered = { first: -1, last: -1, active: -1 };
    return;
  }
  const top = codeEl.scrollTop, h = codeEl.clientHeight;
  const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const last = Math.min(codeLines.length, Math.ceil((top + h) / ROW_H) + OVERSCAN);
  if (!force && first === rendered.first && last === rendered.last && activeLine === rendered.active) return;
  let html = '';
  for (let i = first; i < last; i++) {
    const n = i + 1;
    const cls = n === activeLine ? 'row active' : n < activeLine ? 'row done' : 'row';
    html += `<div class="${cls}"><span class="ln">${n}</span><span class="code-text">${highlight(codeLines[i])}</span></div>`;
  }
  rowsEl.style.transform = `translateY(${first * ROW_H}px)`;
  rowsEl.innerHTML = html;
  rendered = { first, last, active: activeLine };
}

function scrollToActive() {
  if (!followCode || !activeLine) return;
  const target = (activeLine - 1) * ROW_H - codeEl.clientHeight / 3;
  codeEl.scrollTop = Math.max(0, target);
}

function setActiveLine(n) {
  if (n === activeLine) return;
  activeLine = n;
  scrollToActive();
  renderCode();
}

codeEl.addEventListener('scroll', () => renderCode());
new ResizeObserver(() => renderCode()).observe(codeEl);
// Only real user input stops auto-follow (programmatic scrolls also fire 'scroll').
for (const ev of ['wheel', 'touchstart', 'pointerdown']) {
  codeEl.addEventListener(ev, () => {
    if (!followCode) return;
    followCode = false;
    $('resumeBtn').hidden = false;
  }, { passive: true });
}
$('resumeBtn').addEventListener('click', () => {
  followCode = true;
  $('resumeBtn').hidden = true;
  scrollToActive();
});

// The 3D view shows the simplified toolpath, built in a worker (big programs take a second or two).
let pathSeq = 0;
let pathText = '';
let pathStarted = 0;
let pathWorker = null;
try {
  pathWorker = new Worker(new URL('./toolpath-worker.js', import.meta.url), { type: 'module' });
  pathWorker.onmessage = (e) => { if (e.data.seq === pathSeq) setToolpath(e.data.path); };
  pathWorker.onerror = (e) => {
    // The worker couldn't start (old browser): do it here instead.
    log.warn(`toolpath worker failed (${e.message || 'no details'}), building the toolpath on the main thread`);
    pathWorker.terminate();
    pathWorker = null;
    showToolpath(pathText);
  };
} catch (e) {
  log.warn('no module worker, building the toolpath on the main thread:', e);
}

function setToolpath(path) {
  if (path) {
    log.info(`toolpath: ${path.count} of ${path.rawCount} moves drawn (within ${path.tolerance.toPrecision(2)}), ` +
      `built in ${Math.round(performance.now() - pathStarted)} ms`);
  } else if (pathText) {
    log.warn('toolpath: the program has no moves the preview understands');
  }
  viewer.setProgram(path);
  const k = (n) => n >= 1e4 ? Math.round(n / 1000) + 'k' : String(n);
  const unit = path?.inches ? ' in' : ' mm';
  $('pathNote').textContent = !path ? ''
    : path.count < path.rawCount ? `${k(path.count)} of ${k(path.rawCount)} moves drawn (within ${+path.tolerance.toPrecision(2)}${unit})`
    : `${k(path.count)} moves`;
}

function showToolpath(text) {
  const seq = ++pathSeq;
  pathText = text;
  pathStarted = performance.now();
  if (!text) { setToolpath(null); return; }
  if (pathWorker) { pathWorker.postMessage({ seq, text }); return; }
  setTimeout(() => {
    if (seq !== pathSeq) return;
    try {
      setToolpath(buildToolpath(text));
    } catch (e) {
      log.error('toolpath failed:', e);
    }
  });
}

// Tools the shown program uses (from its CAM tool comments) and where it selects each one;
// read again when the program or the CAM program chosen in Settings changes.
let programTools = null;
let toolShown = '';   // the drawn tool's size and source, shown under the tool number
let programToolsCam = '';

/** Draw the tool in use at the current line (Settings → Tool in the 3D view): its size from the
 *  program's tool comments, else the diameter TNG reports for the loaded tool, else the
 *  standard marker. Turned off in Settings: always the standard marker. */
function updateToolShape() {
  const view = state.tool_view || { enabled: true, cam: 'fusion' };
  if (!view.enabled) { viewer.setToolShape(null); return; }
  if (!programTools || programToolsCam !== view.cam) {
    programTools = parseTools(codeLines, view.cam);
    programToolsCam = view.cam;
  }
  const { tools, changes } = programTools;
  const line = state.line || 0;
  let num = null;
  for (const [row, t] of changes) {
    if (row > line && num != null) break;
    num = t;   // before the first T word, show the tool the program is about to use
  }
  let shape = num != null ? tools[num] : null;
  let from = 'program';
  if (!shape?.d && state.tool_diameter > 0) {
    // TNG's tool table is in TNG's units; the 3D view is in the program's units.
    let d = state.tool_diameter;
    const progInches = !!viewer.programInches;
    if (progInches && state.units === 'mm') d /= 25.4;
    else if (!progInches && state.units === 'in') d *= 25.4;
    shape = { d, cr: 0, tipAngle: 0, kind: '' };
    from = 'TNG';
  }
  viewer.setToolShape(shape?.d > 0 ? shape : null);
  // Say which size is drawn and where it came from, so a wrong one can be spotted.
  const unit = viewer.programInches ? 'in' : 'mm';
  toolShown = shape?.d > 0 ? `Ø${+shape.d.toFixed(3)} ${unit} (${from})` : '';
  $('toolName').textContent = [state.tool_name, toolShown].filter(Boolean).join(' · ');
}

function showProgram(text) {
  codeLines = text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  programTools = null;
  updateToolShape();
  $('codeSpacer').style.height = codeLines.length * ROW_H + 'px';
  showToolpath(text);
  activeLine = -1;
  setActiveLine(0);
}

async function loadProgram(id) {
  programId = id;
  const started = performance.now();
  const req = (programLoading = fetch('/api/program', { cache: 'no-store' }).then((r) => r.json()));
  codeLines = [];
  renderCode(true);
  try {
    const prog = await req;
    if (programLoading !== req || preview) return;  // a newer program arrived, or a preview took over
    log.info(`program loaded: ${prog.name || '(none)'}, ${Math.round((prog.text || '').length / 1024)} KB ` +
      `in ${Math.round(performance.now() - started)} ms`);
    showProgram(prog.text);
    setActiveLine(state.line || 0);
    if (programId !== prog.id) programId = null;  // server changed in between: refetch next update
  } catch (e) {
    log.error('program load failed:', e);
    programId = null;
  } finally {
    if (programLoading === req) programLoading = null;
    renderCode(true);
  }
}

// ---------------------------------------------------------------- viewer toolbar

for (const b of document.querySelectorAll('.vbtn[data-view]')) {
  b.addEventListener('click', () => {
    document.querySelectorAll('.vbtn[data-view]').forEach((x) => x.classList.toggle('active', x === b));
    viewer.setView(b.dataset.view);
  });
}
$('fitBtn').addEventListener('click', () => viewer.fit());
$('followBtn').addEventListener('click', (e) => {
  const on = e.currentTarget.classList.toggle('active');
  viewer.setFollow(on);
});
viewer.machineButton($('machineBtn'));
$('traceBtn').addEventListener('click', (e) => {
  const on = e.currentTarget.classList.toggle('active');
  viewer.setTraceVisible(on);
});

// ---------------------------------------------------------------- camera

const camPanel = $('camPanel');
const camImg = $('camImg');
const camToggle = $('camToggleBtn');
let camEnabled = false;   // server has a camera to stream
let camViewOn = false;    // Settings: show the camera on the dashboard (from the first update)
let camWanted = true;     // this browser hasn't folded it away (Hide)
let camOpened = 0;        // when the current stream was opened
let camRetry = null;
let liveDownSince = null; // the live updates stopped; the camera waits so its connection is free

try { camWanted = localStorage.getItem('cncCamHidden') !== '1'; } catch { /* storage unavailable */ }

function camStart() {
  clearTimeout(camRetry);
  camOpened = Date.now();
  camImg.hidden = false;
  camImg.src = '/api/camera.mjpg?t=' + camOpened;
}

function camStop() {
  clearTimeout(camRetry);
  camImg.removeAttribute('src');
  camImg.hidden = true;
}

function camShouldStream() {
  return camViewOn && camEnabled && camWanted && document.visibilityState === 'visible' && !liveDownSince;
}

function camSync() {
  // Shown whenever Settings says so, also without a camera: then it says why there's no picture.
  camPanel.hidden = !camViewOn;
  camPanel.classList.toggle('collapsed', !camWanted);
  camToggle.textContent = camWanted ? 'Hide' : 'Show';
  camToggle.classList.toggle('active', camWanted);
  $('camFullBtn').hidden = !camWanted || !camEnabled;
  const streaming = camImg.hasAttribute('src');
  if (camShouldStream() && !streaming) camStart();
  else if (!camShouldStream() && streaming) camStop();
}

const CAM_BROKEN = "Camera connection doesn't work";

function camMessage(state, title, detail = '') {
  camPanel.dataset.state = state;
  $('camMsgTitle').textContent = title;
  $('camMsgDetail').textContent = detail;
}

function camUpdate(s) {
  const view = s.camera_view !== false;
  const enabled = !!s.camera;
  if (view !== camViewOn || enabled !== camEnabled) {
    camViewOn = view;
    camEnabled = enabled;
    camSync();
  }
  if (!view || !camWanted) { camPanel.dataset.state = 'off'; return; }
  // The server streams a placeholder frame while there's no picture; it reports
  // whether the camera really delivers images in every state update.
  if (!enabled) camMessage('nosignal', CAM_BROKEN, s.camera_problem || 'The server has no camera.');
  else if (camImg.hidden) camMessage('nosignal', CAM_BROKEN, 'The picture broke off. Trying again…');
  else if (s.camera.live) camPanel.dataset.state = 'live';
  else if (Date.now() - camOpened > 4000) {
    camMessage('nosignal', CAM_BROKEN, 'No picture from the camera. Check its cable; the dashboard keeps trying.');
  } else camMessage('connecting', 'Connecting to the camera…');
}

camImg.addEventListener('error', () => {
  if (!camShouldStream()) return;
  camImg.hidden = true;
  camMessage('nosignal', CAM_BROKEN, 'The picture broke off. Trying again…');
  log.warn(`camera stream failed after ${Math.round((Date.now() - camOpened) / 1000)} s, retrying in 3 s`);
  camRetry = setTimeout(camStart, 3000);
});
camToggle.addEventListener('click', () => {
  camWanted = !camWanted;
  try { localStorage.setItem('cncCamHidden', camWanted ? '0' : '1'); } catch { /* ignore */ }
  camSync();
});
$('camFullBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else camPanel.requestFullscreen?.().catch(() => {});
});
$('camView').addEventListener('dblclick', () => { if (camEnabled) $('camFullBtn').click(); });
// In full screen the button takes you back (as do Esc and a double-click); Hide makes no sense there.
document.addEventListener('fullscreenchange', () => {
  const full = document.fullscreenElement === camPanel;
  $('camFullBtn').textContent = full ? 'Exit full screen' : 'Full';
  $('camFullBtn').title = full ? 'Back to the dashboard (Esc)' : 'Full screen';
  camToggle.hidden = full;
});
// Don't keep a video stream running from the Pi for a background tab.
document.addEventListener('visibilitychange', camSync);

// ---------------------------------------------------------------- live updates

function onState(s) {
  state = s;
  log.setDebug(s.log_debug);

  if (s.running && !wasRunning) {
    const total = s.line_count || codeLines.length;
    jobStart = { time: s.server_time ?? Date.now() / 1000, pct: total ? (s.line || 0) / total * 100 : 0 };
    viewer.clearTrace();
  }
  if (!s.running) jobStart = null;
  wasRunning = !!s.running;

  // While a file is previewed, the live program waits; it's reloaded when the preview closes.
  if (!preview) {
    if (s.program_id && s.program_id !== programId && !programLoading) loadProgram(s.program_id);
    if (!s.program_id && programId) {
      programId = null;
      showProgram('');
      renderCode(true);
    }
  }

  const w = s.work || [];
  const m = s.machine || [];
  // The bed comes in machine coordinates; shift it by the work offset (work - machine)
  // so it lines up with the toolpath, which is in work coordinates.
  // Work and machine positions aren't sampled at exactly the same instant, so while the
  // machine moves their difference jitters and the box would wobble. The offset only
  // really changes while standing still (zeroing, G54/G55, tool length), so it's only
  // re-measured when TNG reports the machine idle.
  if (w.length >= 3 && m.length >= 3 && (s.idle || !bedOffset)) {
    bedOffset = [0, 1, 2].map((k) => w[k] - m[k]);
  }
  if (s.limits && bedOffset) {
    const off = bedOffset;
    viewer.setBed({
      min: [0, 1, 2].map((k) => s.limits.min[k] + off[k]),
      max: [0, 1, 2].map((k) => s.limits.max[k] + off[k]),
    });
  } else if (s.bridge_online) {
    viewer.setBed(null);
  }
  if (w.length >= 3) {
    viewer.setToolPosition(w[0], w[1], w[2], !!(s.bridge_online && s.running && !s.paused));
  }
  if (!programLoading && !preview) setActiveLine(s.line || 0);

  renderName(s.machine_name);
  renderDro();
  renderInfo();
  filesUpdate(s);
  tuneSync(s);
  consoleUpdate(s.console_seq);
  systemOnState(s);
  navOnState(s);
  camUpdate(s);
}

// ---------------------------------------------------------------- file preview

let preview = null;   // {name, text} of a local file shown instead of TNG's program

$('openBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';  // allow re-opening the same file after editing it
  if (file) openPreview(file.name, await file.text());
});

function openPreview(name, text) {
  preview = { name, text };
  programLoading = null;
  showProgram(text);
  renderCode(true);
  $('previewName').textContent = name;
  $('previewBar').hidden = false;
}

function closePreview() {
  preview = null;
  $('previewBar').hidden = true;
  programId = null;   // makes the next update reload TNG's program
  showProgram('');
  renderCode(true);
}
$('closePreviewBtn').addEventListener('click', closePreview);

// ---------------------------------------------------------------- Pi files panel (--files-dir)

const filesPanel = $('filesPanel');
const GCODE_RE = /\.(nc|ngc|gcode|gc|tap|cnc|txt)$/i;
const ICONS = {
  view: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 4v12m0 0-5-5m5 5 5-5M5 20h14"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  tune: '<svg viewBox="0 0 24 24"><path d="M4 6h9m4 0h3M4 12h3m4 0h9M4 18h11m4 0h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  load: '<svg viewBox="0 0 24 24"><path d="M12 15V3m0 12-4-4m4 4 4-4"/><rect x="3" y="15" width="18" height="6" rx="2"/></svg>',
};
let filesPath = '';
let filesAbs = '';         // the open folder's full path on the Pi
let filesRoot = 'Files';
let filesEnabled = false;
let filesBusy = false;     // an upload is running
let dropTimer = null;

const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const fmtDate = (t) => new Date(t * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const joinPath = (dir, name) => (dir ? dir + '/' : '') + name;

/** What an action did, as a sentence; `plain` for the folder's status line ("3 items · drop files to upload"). */
function filesMessage(text, kind = '', plain = false) {
  if (kind === 'err') log.warn('files:', text);
  $('filesMsg').textContent = plain ? text : sentence(text);
  $('filesMsg').className = 'files-msg' + (kind ? ' ' + kind : '');
}

/** Drop overlay state: '' (hidden), over, busy, done, error. */
function dropState(st, text = '', progress = 0) {
  clearTimeout(dropTimer);
  filesPanel.dataset.drop = st;
  $('filesDropText').textContent = text;
  $('filesDropBar').style.width = Math.round(progress * 100) + '%';
  if (st === 'done' || st === 'error') dropTimer = setTimeout(() => dropState(''), st === 'done' ? 1400 : 2600);
}

function filesSync() {
  $('filesTab').hidden = !filesEnabled;
  $('feedsTab').hidden = !filesEnabled;
  if (filesEnabled && (savedTab === 'files' || savedTab === 'feeds')) setTab(savedTab);
  else if (!filesEnabled && (activeTab === 'files' || activeTab === 'feeds')) setTab('code');
}

// ---------------------------------------------------------------- Feeds & steps (tune-ui.js)

/** Line where the job in TNG stopped, when `path` is the program loaded in TNG and it isn't running. */
function stoppedLineFor(path) {
  return state.file_rel && state.file_rel === path && !state.running && state.line > 1 ? state.line : 0;
}
initTune({
  openPreview: (name, text) => openPreview(name, text),
  filesReload: () => { if (activeTab === 'files') filesLoad(filesPath); },
  loadedFile: () => state.file_rel || '',
});
$('tuneLoadedBtn').addEventListener('click', () => {
  if (state.file_rel) openTune(state.file_rel, stoppedLineFor(state.file_rel));
});
function tuneSync(s) {
  $('tuneLoadedBtn').hidden = activeTab !== 'code' || !s.file_rel || !!preview;
  if (activeTab === 'feeds') tuneLogLoad(false, s.tuning_seq);
}

/** Why a program can't be loaded in TNG now ('' = it can); the same reasons as on the Surfacing page. */
let tngLoad = 'TNG is not connected';
function syncLoadButtons() {
  for (const b of $('filesList').querySelectorAll('[data-load]')) {
    b.disabled = !!tngLoad;
    b.title = tngLoad || 'Load in TNG (it does not start it)';
  }
}

function filesUpdate(s) {
  const why = !s.bridge_online ? 'TNG is not connected' : s.running ? 'The machine is running: load it when it has stopped' : '';
  if (why !== tngLoad) {
    tngLoad = why;
    syncLoadButtons();
  }
  const enabled = !!s.files_enabled;
  if (enabled !== filesEnabled) {
    filesEnabled = enabled;
    filesSync();
  }
}

async function filesLoad(path) {
  let d;
  try {
    d = await (await fetch('/api/files?path=' + encodeURIComponent(path), { cache: 'no-store' })).json();
  } catch {
    d = { ok: false, message: UNREACHABLE };
  }
  if (!d.ok) {
    if (path) return filesLoad('');  // folder vanished: back to the top
    filesMessage(`Could not open the folder: ${d.message || 'failed'}`, 'err');
    return;
  }
  filesPath = d.path;
  filesRoot = d.root;
  $('filesZipBtn').href = '/api/files/zip?path=' + encodeURIComponent(d.path);
  filesAbs = d.abs || '';

  const parts = d.path ? d.path.split('/') : [];
  let crumbs = `<button data-path="" data-folder="" title="${esc(d.root)}">${esc(d.root)}</button>`;
  parts.forEach((p, i) => {
    const to = esc(parts.slice(0, i + 1).join('/'));
    crumbs += `<span>/</span><button data-path="${to}" data-folder="${to}">${esc(p)}</button>`;
  });
  $('filesCrumbs').innerHTML = crumbs;

  const rows = d.entries.map((e) => {
    const rel = joinPath(d.path, e.name);
    const p = esc(rel);
    if (e.dir) {
      return `<div class="frow" data-folder="${p}"><span class="fname"><button data-open="${p}">📁 ${esc(e.name)}</button></span>`
        + `<span class="facts"><button class="ficon" data-rename="${p}" title="Rename">${ICONS.edit}</button>`
        + `<a class="ficon" href="/api/files/zip?path=${encodeURIComponent(rel)}" download title="Download as a zip">${ICONS.down}</a></span></div>`;
    }
    const acts = [
      GCODE_RE.test(e.name) ? `<button class="ficon" data-preview="${p}" title="Preview in 3D view">${ICONS.view}</button>` : '',
      GCODE_RE.test(e.name) ? `<button class="ficon" data-load="${p}" title="Load in TNG (it does not start it)">${ICONS.load}</button>` : '',
      GCODE_RE.test(e.name) ? `<button class="ficon" data-tune="${p}" title="Feeds &amp; steps: change feeds and step height (saved as a new file)">${ICONS.tune}</button>` : '',
      `<a class="ficon" href="/api/files/download?path=${encodeURIComponent(rel)}" download title="Download">${ICONS.down}</a>`,
      `<button class="ficon del" data-delete="${p}" title="Delete">${ICONS.del}</button>`,
    ].join('');
    return `<div class="frow" draggable="true" data-file="${p}" title="${esc(e.name)} – ${fmtDate(e.mtime)} · drag onto a folder to move it"><span class="fname">${esc(e.name)}</span>
      <span class="fsize">${fmtSize(e.size)}</span><span class="facts">${acts}</span></div>`;
  });
  $('filesList').innerHTML = rows.join('') || '<div class="files-empty">Empty folder – drop files here</div>';
  syncLoadButtons();
  if (!$('filesMsg').classList.contains('err')) {
    filesMessage(`${d.entries.length} item${d.entries.length === 1 ? '' : 's'} · drop files to upload`, '', true);
  }
}

function uploadOne(url, file, onProgress) {
  // XMLHttpRequest instead of fetch: it reports upload progress for the progress bar.
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.setRequestHeader('X-CNC-Control', '1');
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      try { resolve(JSON.parse(x.responseText)); } catch { resolve({ ok: false, message: `HTTP ${x.status}` }); }
    };
    x.onerror = () => resolve({ ok: false, message: UNREACHABLE });
    x.send(file);
  });
}

async function filesUpload(fileList) {
  if (filesBusy) return;
  filesBusy = true;
  const folder = filesPath;
  let done = 0, error = null;
  for (const f of fileList) {
    const label = fileList.length > 1 ? `${f.name} (${done + 1}/${fileList.length})` : f.name;
    const url = (overwrite) => `/api/files/upload?path=${encodeURIComponent(folder)}&name=${encodeURIComponent(f.name)}`
      + (overwrite ? '&overwrite=1' : '');
    const progress = (p) => dropState('busy', `Uploading ${label}`, p);
    progress(0);
    let res = await uploadOne(url(false), f, progress);
    if (res.exists) {
      dropState('');
      if (!await ask({ title: 'Replace the file?', text: `"${f.name}" already exists on the Pi.`, ok: 'Replace', danger: true })) continue;
      progress(0);
      res = await uploadOne(url(true), f, progress);
    }
    if (!res.ok) { error = `Could not upload ${f.name}: ${res.message || 'failed'}`; break; }
    done++;
  }
  filesBusy = false;
  await filesLoad(folder);
  if (error) {
    dropState('error', error);
    filesMessage(error, 'err');
  } else if (done) {
    const what = done === 1 ? fileList[0].name : `${done} files`;
    dropState('done', `Uploaded ${what}`);
    filesMessage(`Uploaded ${what} to ${filesPath || filesRoot}`, 'ok');
  }
}

$('filesUploadBtn').addEventListener('click', () => $('filesUploadInput').click());
$('filesMkdirBtn').addEventListener('click', async () => {
  const name = await askText({ title: 'New folder', text: `In ${filesPath || filesRoot}.`, label: 'Name', ok: 'Make' });
  if (!name) return;
  let res;
  try {
    const r = await fetch('/api/files/mkdir', {
      method: 'POST', headers: { 'X-CNC-Control': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filesPath, name }),
    });
    res = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  } catch {
    res = { ok: false, message: UNREACHABLE };
  }
  filesMessage(res.ok ? res.message || 'Folder made.' : `Could not make the folder: ${res.message || 'failed'}`, res.ok ? 'ok' : 'err');
  await filesLoad(filesPath);
});
$('filesUploadInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) filesUpload(files);
});
filesPanel.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.path !== undefined) filesLoad(b.dataset.path);
  else if (b.dataset.open) filesLoad(b.dataset.open);
  else if (b.dataset.load) {
    const path = b.dataset.load;
    const name = path.split('/').pop();
    filesMessage(`Loading ${name} in TNG…`);
    b.disabled = true;
    let res;
    try {
      const r = await fetch('/api/tng/open', {
        method: 'POST', headers: { 'X-CNC-Control': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      res = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
    } catch {
      res = { ok: false, message: UNREACHABLE };
    }
    syncLoadButtons();
    filesMessage(res.ok && res.loaded ? `Loaded ${name} in TNG: start it at the machine.`
      : res.ok ? `${res.message}: check TNG` : `Could not load ${name} in TNG: ${res.message || 'failed'}`,
    res.ok && res.loaded ? 'ok' : 'err');
  }
  else if (b.dataset.tune) openTune(b.dataset.tune, stoppedLineFor(b.dataset.tune));
  else if (b.dataset.rename) {
    const path = b.dataset.rename;
    const old = path.split('/').pop();
    const name = await askText({ title: 'Rename the folder', label: 'New name', value: old, ok: 'Rename' });
    if (!name || name === old) return;
    let res;
    try {
      const r = await fetch('/api/files/rename', {
        method: 'POST', headers: { 'X-CNC-Control': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, name }),
      });
      res = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
    } catch {
      res = { ok: false, message: UNREACHABLE };
    }
    filesMessage(res.ok ? res.message || 'Renamed.' : `Could not rename: ${res.message || 'failed'}`, res.ok ? 'ok' : 'err');
    await filesLoad(filesPath);
  }
  else if (b.dataset.preview) {
    const path = b.dataset.preview;
    try {
      const r = await fetch('/api/files/download?inline=1&path=' + encodeURIComponent(path), { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      openPreview(path.split('/').pop(), await r.text());
      filesMessage('Previewing ' + path.split('/').pop());
    } catch (err) {
      filesMessage(`Could not open it: ${err.message}`, 'err');
    }
  } else if (b.dataset.delete) {
    const path = b.dataset.delete;
    if (!await ask({ title: 'Delete the file?', text: `"${path.split('/').pop()}" is deleted from the Pi. This cannot be undone.`,
      ok: 'Delete', danger: true })) return;
    let res;
    try {
      const r = await fetch('/api/files/delete', {
        method: 'POST', headers: { 'X-CNC-Control': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      res = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
    } catch {
      res = { ok: false, message: UNREACHABLE };
    }
    filesMessage(res.ok ? res.message || 'Deleted.' : `Could not delete: ${res.message || 'failed'}`, res.ok ? 'ok' : 'err');
    await filesLoad(filesPath);
  }
});

// Moving a file: drag its row onto a folder row, or onto a folder in the path above the list.
const MOVE_TYPE = 'application/x-cnc-file';
let moving = null;   // path of the file being dragged
const isMove = (e) => moving !== null && [...(e.dataTransfer?.types || [])].includes(MOVE_TYPE);
const moveTarget = (e) => {
  const t = e.target.closest?.('[data-folder]');
  return t && filesPanel.contains(t) ? t : null;
};
const parentOf = (p) => p.split('/').slice(0, -1).join('/');
const clearMoveOver = () => filesPanel.querySelectorAll('.move-over').forEach((el) => el.classList.remove('move-over'));
filesPanel.addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('[data-file]');
  if (!row) return;
  moving = row.dataset.file;
  e.dataTransfer.setData(MOVE_TYPE, moving);
  e.dataTransfer.setData('text/plain', moving.split('/').pop());
  e.dataTransfer.effectAllowed = 'move';
  row.classList.add('dragging');
});
filesPanel.addEventListener('dragend', (e) => {
  e.target.closest?.('[data-file]')?.classList.remove('dragging');
  moving = null;
  clearMoveOver();
});
filesPanel.addEventListener('dragover', (e) => {
  if (!isMove(e)) return;
  const t = moveTarget(e);
  clearMoveOver();
  if (!t || t.dataset.folder === parentOf(moving)) { e.dataTransfer.dropEffect = 'none'; return; }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  t.classList.add('move-over');
});
filesPanel.addEventListener('dragleave', (e) => {
  if (isMove(e) && !filesPanel.contains(e.relatedTarget)) clearMoveOver();
});
filesPanel.addEventListener('drop', async (e) => {
  if (!isMove(e)) return;
  e.preventDefault();
  e.stopPropagation();
  clearMoveOver();
  const t = moveTarget(e);
  const path = moving;
  moving = null;
  if (!t || t.dataset.folder === parentOf(path)) return;
  const to = t.dataset.folder;
  const name = path.split('/').pop();
  const send = async (overwrite) => {
    try {
      const r = await fetch('/api/files/move', {
        method: 'POST', headers: { 'X-CNC-Control': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, to, overwrite }),
      });
      return await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
    } catch {
      return { ok: false, message: UNREACHABLE };
    }
  };
  let res = await send(false);
  if (res.exists) {
    if (!await ask({ title: 'Replace the file?', text: `"${name}" already exists in ${to || filesRoot}.`, ok: 'Replace', danger: true })) return;
    res = await send(true);
  }
  await filesLoad(filesPath);
  filesMessage(res.ok ? res.message || 'Moved.' : `Could not move: ${res.message || 'failed'}`, res.ok ? 'ok' : 'err');
});

// Drag & drop onto the right panel, whichever tab it shows. dragenter/dragleave also fire
// for every child element, so count them to know when the pointer really left the panel.
const sidePanel = $('sidePanel');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
sidePanel.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || filesBusy || !filesEnabled) return;
  e.preventDefault();
  if (dragDepth++ === 0) {
    if (activeTab !== 'files') setTab('files');
    dropState('over', `Drop to upload to ${filesPath || filesRoot}`);
  }
});
sidePanel.addEventListener('dragover', (e) => {
  if (!hasFiles(e) || filesBusy || !filesEnabled) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
sidePanel.addEventListener('dragleave', (e) => {
  if (!hasFiles(e) || filesBusy || !filesEnabled) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    if (filesPanel.dataset.drop === 'over') dropState('');
  }
});
sidePanel.addEventListener('drop', (e) => {
  if (!hasFiles(e) || !filesEnabled) return;
  e.preventDefault();
  dragDepth = 0;
  const files = [...e.dataTransfer.files];
  if (files.length) filesUpload(files);
});
// A file dropped next to the panel would make the browser open it and leave the dashboard.
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });
// Pick up files added on the Pi itself every now and then.
setInterval(() => {
  if (filesEnabled && activeTab === 'files' && !filesBusy && document.visibilityState === 'visible') filesLoad(filesPath);
}, 15000);

// ---------------------------------------------------------------- G-code / Console / Files / Feeds tabs

let activeTab = 'code';
let savedTab = '';           // tab from the last visit; Files only appears once the server says it's on
let consoleSeq = 0;          // last console line we have
let consoleFetching = false;

function setTab(tab) {
  activeTab = tab;
  savedTab = '';
  document.querySelectorAll('.ptab').forEach((b) => b.classList.toggle('active', b.dataset.ptab === tab));
  $('code').hidden = tab !== 'code';
  $('console').hidden = tab !== 'console';
  filesPanel.hidden = tab !== 'files';
  $('tunePanel').hidden = tab !== 'feeds';
  $('tuneLoadedBtn').hidden = tab !== 'code' || !state.file_rel || !!preview;
  $('resumeBtn').hidden = tab !== 'code' || followCode;
  $('consoleClearBtn').hidden = tab !== 'console';
  $('filesUploadBtn').hidden = tab !== 'files';
  $('filesMkdirBtn').hidden = tab !== 'files';
  $('filesZipBtn').hidden = tab !== 'files';
  if (tab === 'console') {
    $('consoleBadge').hidden = true;
    const log = $('consoleLog');
    log.scrollTop = log.scrollHeight;
  } else if (tab === 'files') {
    filesLoad(filesPath);
  } else if (tab === 'feeds') {
    tuneLogLoad(true);
  } else {
    renderCode(true);
  }
  try { localStorage.setItem('cncTab', tab); } catch { /* ignore */ }
}
document.querySelectorAll('.ptab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.ptab)));
$('consoleClearBtn').addEventListener('click', () => { $('consoleLog').innerHTML = ''; });

function addConsoleLines(lines) {
  const log = $('consoleLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
  log.querySelector('.console-empty')?.remove();
  for (const l of lines) {
    const row = document.createElement('div');
    row.className = 'cline ' + l.kind;
    const time = new Date(l.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    row.innerHTML = `<span class="ct">${time}</span><span class="cx">${esc(l.text)}</span>`;
    log.appendChild(row);
  }
  while (log.childElementCount > 500) log.firstChild.remove();
  if (atBottom || activeTab !== 'console') log.scrollTop = log.scrollHeight;
  if (activeTab !== 'console' && lines.length) {
    const badge = $('consoleBadge');
    badge.hidden = false;
    if (lines.some((l) => l.kind === 'err')) badge.classList.add('err');
  }
}

async function consoleUpdate(seq) {
  if (seq == null || consoleFetching) return;
  if (seq < consoleSeq) {  // server restarted: start over
    consoleSeq = 0;
    $('consoleLog').innerHTML = '';
  }
  if (seq === consoleSeq) return;
  consoleFetching = true;
  try {
    const d = await (await fetch('/api/console?after=' + consoleSeq, { cache: 'no-store' })).json();
    if (d.lines.length) {
      consoleSeq = d.lines[d.lines.length - 1].seq;
      addConsoleLines(d.lines);
    }
  } catch { /* next update retries */ }
  consoleFetching = false;
}

$('consoleLog').innerHTML = '<div class="console-empty">Messages appear here: jobs, machine events, updates and the bridge connecting.</div>';

// ---------------------------------------------------------------- machine name (top bar, tab title)

let machineName = '';

function renderName(name) {
  if (!name || name === machineName) return;
  machineName = name;
  $('machineName').textContent = name;
  document.title = `${name} – Observatory`;
}

// ---------------------------------------------------------------- connection to the server

const STALL_MS = 6000;     // the server sends at least one update a second
let es = null;
let lastMessage = 0;

/** Live updates stopped: show it, log it once, and free the camera's connection for the reconnect. */
function connectionLost(why) {
  if (!liveDownSince) {
    liveDownSince = Date.now();
    log.warn(`live connection lost: ${why}; last update ${lastMessage ? ((Date.now() - lastMessage) / 1000).toFixed(1) + ' s ago' : 'never'}`);
    if (camImg.hasAttribute('src')) camStop();
  }
  state = { ...state, bridge_online: false };
  renderInfo();
}

function connect() {
  es?.close();
  lastMessage = Date.now();  // give the new connection time before the watchdog judges it
  es = new EventSource('/api/events');
  const me = es;
  es.onmessage = (e) => {
    lastMessage = Date.now();
    if (liveDownSince) {
      log.info(`live connection back after ${((Date.now() - liveDownSince) / 1000).toFixed(0)} s`);
      liveDownSince = null;
      camSync();  // reopen the camera stream it closed
    }
    try { onState(JSON.parse(e.data)); } catch (err) { log.error('state update failed:', err); }
  };
  es.onopen = () => {
    log.debug('live connection open');
    // After a server restart the old camera stream is dead: reopen it.
    if (camShouldStream()) camStart();
  };
  es.onerror = () => {
    if (me !== es) return;
    connectionLost(`connection error (${['connecting', 'open', 'closed'][me.readyState]})`);
    // EventSource reconnects by itself unless the server answered with an error.
    if (me.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
  };
}

// A connection can also go silent without an error (Wi-Fi dropped, a stuck proxy, the browser out
// of connections): then the page would show old values forever. Reconnect when updates stop.
setInterval(() => {
  if (!es || document.visibilityState !== 'visible' || Date.now() - lastMessage < STALL_MS) return;
  connectionLost(`no update for ${((Date.now() - lastMessage) / 1000).toFixed(0)} s`);
  log.info('reconnecting');
  connect();
}, 1000);

try {
  const tab = localStorage.getItem('cncTab');
  if (tab === 'console') setTab(tab);   // (a 'settings' tab from before: Settings is its own page now)
  else if (tab === 'files' || tab === 'feeds') savedTab = tab;
} catch { /* ignore */ }
initSystem();
renderDro();
renderCode(true);
connect();
