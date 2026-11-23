// Planing (surfacing) program for rough stock, for the /planing page: back-and-forth passes
// over the whole top of the stock, one Z level after the other. Millimetres only.
//
// Layout of one Z level, cutting along X (along Y is the same with X and Y swapped):
//
//      W+c    ─────────────────────────────►   the last line's centre is c past the far edge
//             ◄─────────────────────────────
//      -c     ─────────────────────────────►   the first line's centre is c past the near edge
//            |<-c->|      stock      |<-c->|
//
// The bit's centre runs past every edge of the stock by the clearance c, along the cut and
// across it. c must be less than the radius, so the bit still covers the edges. The step to the
// next line happens there, with the bit partly on the stock (a sideways move at the cut depth);
// each pass starts with the bit fully beside the stock, so the plunges happen in the air.
// With clearTurn, the lines run on until the whole bit is c clear of the stock (centre r + c
// past the edge), so the steps to the next line happen in the air too.

export const RAPID_ESTIMATE = 5000;   // mm/min, only for the run-time estimate

export const DEFAULTS = {
  length: 600, width: 200, thickness: 30, zMode: 'top', startAbove: 0,
  toolD: 50, depth: 3, stepdown: 1, stepover: 40, direction: 'x',
  rpm: 18000, feed: 3000, plunge: 900,
  safe: 5, clearance: 5, clearTurn: false, dwell: 3,
  material: '',
};

/** Number for G-code: at most 3 decimals, no trailing zeros, no "-0". */
export function fmt(v) {
  const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** Positions of the line centres across the cut direction, covering 0..span. */
export function linePositions(span, c, step) {
  const first = -c, last = span + c;
  const n = Math.ceil((last - first) / step - 1e-9) + 1;
  const gap = (last - first) / (n - 1);
  return Array.from({ length: n }, (_, i) => first + i * gap);
}

/**
 * Check the inputs, and build the program and its moves.
 * @returns {{errors: string[], warnings: string[], text?: string, moves?: object[], info?: object}}
 *   moves: [{x, y, z, rapid, feed, dwell, t0, t1, pass}] from the start point, with times in seconds.
 */
export function planPlaning(input, { date = new Date() } = {}) {
  const p = { ...DEFAULTS, ...input };
  const errors = [];
  const warnings = [];
  const need = (key, label, ok, msg) => { if (!(Number.isFinite(p[key]) && ok(p[key]))) errors.push(`${label}: ${msg}`); };
  const pos = (v) => v > 0;
  need('length', 'Length', pos, 'enter a size above 0');
  need('width', 'Width', pos, 'enter a size above 0');
  need('thickness', 'Thickness', pos, 'enter a thickness above 0');
  need('toolD', 'Bit diameter', pos, 'enter a diameter above 0');
  need('depth', 'Depth to remove', pos, 'enter a depth above 0');
  need('stepdown', 'Step-down', pos, 'enter a depth per pass above 0');
  need('stepover', 'Stepover', (v) => v >= 5 && v <= 100, 'between 5 and 100 % of the diameter');
  need('rpm', 'Spindle speed', pos, 'enter a speed above 0');
  need('feed', 'Feed', pos, 'enter a feed above 0');
  need('plunge', 'Plunge feed', pos, 'enter a feed above 0');
  need('safe', 'Safe height', (v) => v >= 1, 'at least 1 mm above the stock');
  need('clearance', 'Run past the edges', (v) => v >= 0, 'enter 0 or more');
  need('dwell', 'Spin-up time', (v) => v >= 0, 'enter 0 or more seconds');
  need('startAbove', 'Start above Z0', (v) => v >= 0, 'enter 0 or more');
  if (!['top', 'bed'].includes(p.zMode)) errors.push('Z zero: choose the top of the stock or the spoilboard');
  if (!['x', 'y'].includes(p.direction)) errors.push('Direction: choose along X or along Y');
  if (!errors.length && p.depth >= p.thickness) errors.push('Depth to remove: must be less than the stock thickness');
  if (!errors.length && p.clearance >= p.toolD / 2) errors.push(`Run past the edges: must be less than the bit radius (${fmt(p.toolD / 2)} mm), or the edges are not cut`);
  if (errors.length) return { errors, warnings };

  const r = p.toolD / 2;
  const step = p.toolD * p.stepover / 100;
  const top = p.zMode === 'top' ? 0 : p.thickness;
  const bottom = top - p.thickness;
  const finalTop = top - p.depth;
  // Start above Z0: when Z may not have been touched off on the highest point, the passes start
  // this much higher and still end at the same depth - more passes, the first ones in the air or
  // only taking the high spots, instead of a first pass that bites too deep there.
  const startZ = top + p.startAbove;
  const safeZ = startZ + p.safe;
  const cutDepth = p.depth + p.startAbove;    // from the first pass's start to the final level
  const passes = Math.ceil(cutDepth / p.stepdown - 1e-9);
  const passDepth = cutDepth / passes;
  const alongX = p.direction === 'x';
  const cutLen = alongX ? p.length : p.width;     // along the cut
  const span = alongX ? p.width : p.length;       // across it
  const lines = linePositions(span, p.clearance, step);
  const turn = p.clearTurn ? r + p.clearance : p.clearance;
  const ends = [-turn, cutLen + turn];                // where the lines turn round
  const offAt = Math.max(r + 2, turn);                // bit clear of the stock: plunges
  const air = [-offAt, cutLen + offAt];
  if (p.stepover > 80) warnings.push('A stepover above 80 % can leave ridges between the lines.');
  if (passDepth > 0.25 * p.toolD) warnings.push(`Each pass cuts ${fmt(passDepth)} mm, more than a quarter of the bit diameter.`);
  if (p.plunge > p.feed) warnings.push('The plunge feed is faster than the feed.');

  // Moves, in machine order. pt(a, c): a = along the cut, c = across it.
  const pt = (a, c) => (alongX ? [a, c] : [c, a]);
  const moves = [];
  let cur = [...pt(air[0], lines[0]), safeZ];
  const start = [...cur];
  const go = (xy, z, rapid, feed, pass) => {
    const to = [xy ? xy[0] : cur[0], xy ? xy[1] : cur[1], z ?? cur[2]];
    if (to[0] === cur[0] && to[1] === cur[1] && to[2] === cur[2]) return;
    moves.push({ x: to[0], y: to[1], z: to[2], rapid, feed: rapid ? RAPID_ESTIMATE : feed, pass });
    cur = to;
  };
  const out = [];
  const G = (s) => out.push(s);
  const xy = (q) => `X${fmt(q[0])} Y${fmt(q[1])}`;

  const L = fmt(p.length), W = fmt(p.width), T = fmt(p.thickness);
  G(`(Planing${p.material ? ': ' + p.material : ''} - stock ${L} x ${W} x ${T} mm)`);
  G(`(Made with PlanetCNC Observatory, ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
  G(p.zMode === 'top'
    ? '(Z zero: highest point of the stock top)'
    : `(Z zero: spoilboard - stock top at Z${fmt(top)}, ${fmt(p.thickness - p.depth)} mm thick when done)`);
  G('(X0 Y0: front-left corner of the stock)');
  if (p.startAbove > 0) G(`(Starts ${fmt(p.startAbove)} mm above the stock top, at Z${fmt(startZ)}, in case Z was not set on its highest point)`);
  G(`(Removes ${fmt(p.depth)} mm in ${passes} pass${passes > 1 ? 'es' : ''} of ${fmt(passDepth)} mm${p.startAbove > 0 ? ` from Z${fmt(startZ)}` : ''}, cutting along ${alongX ? 'X' : 'Y'})`);
  G(`(T1 D=${fmt(p.toolD)} CR=0 - ZMIN=${fmt(finalTop)} - FLAT END MILL)`);
  G(`(Stepover ${fmt(step)} mm = ${fmt(p.stepover)} %, ${lines.length} line${lines.length > 1 ? 's' : ''} per pass)`);
  G(`(Lines run ${fmt(p.clearance)} mm past the edges${p.clearTurn ? ', turning round with the bit clear of the stock' : ''})`);
  G(`(Spindle ${fmt(p.rpm)} rpm, feed ${fmt(p.feed)} mm/min, plunge ${fmt(p.plunge)} mm/min)`);
  G('G21 G90 G94 G17');
  G(`G0 Z${fmt(safeZ)}`);
  G(`M3 S${fmt(p.rpm)}`);
  if (p.dwell > 0) {
    G(`G4 P${fmt(p.dwell)}`);
    moves.push({ x: cur[0], y: cur[1], z: cur[2], rapid: false, feed: 0, dwell: p.dwell, pass: 0 });
  }
  G(`G0 ${xy(cur)}`);
  G(`G0 Z${fmt(startZ + 1)}`);
  go(null, startZ + 1, true, 0, 0);

  let side = 0;     // which end of the cut the bit is at
  for (let k = 0; k < passes; k++) {
    const z = startZ - passDepth * (k + 1);
    // Odd passes run the lines back, starting where the last pass ended: no trip back.
    const order = k % 2 ? [...lines].reverse() : lines;
    G(`(Pass ${k + 1} of ${passes}: Z${fmt(z)})`);
    if (k > 0 && air[side] !== ends[side]) {     // off the stock first, along the line just cut
      const q = pt(air[side], order[0]);
      G(`G1 ${xy(q)}`);
      go(q, null, false, p.feed, k);
    }
    G(`G1 Z${fmt(z)} F${fmt(p.plunge)}`);
    go(null, z, false, p.plunge, k + 1);
    let first = true;
    for (const c of order) {
      if (!first) {
        const q = pt(ends[side], c);
        G(`G1 ${xy(q)}`);
        go(q, null, false, p.feed, k + 1);
      }
      side = 1 - side;
      const q = pt(ends[side], c);
      G(`G1 ${xy(q)}${first ? ' F' + fmt(p.feed) : ''}`);
      go(q, null, false, p.feed, k + 1);
      first = false;
    }
  }
  G(`G0 Z${fmt(safeZ)}`);
  go(null, safeZ, true, 0, passes);
  G('M5');
  G('G0 X0 Y0');
  go([0, 0], null, true, 0, passes);
  G('M30');

  // Times, for the simulation and the estimate
  let t = 0;
  let prev = start;
  for (const m of moves) {
    m.t0 = t;
    const dist = Math.hypot(m.x - prev[0], m.y - prev[1], m.z - prev[2]);
    t += m.dwell ? m.dwell : dist / (m.feed / 60);
    m.t1 = t;
    prev = [m.x, m.y, m.z];
  }

  const a0 = air[0], a1 = air[1];
  const c0 = Math.min(...lines), c1 = Math.max(...lines);
  const [x0, y0] = pt(a0, c0), [x1, y1] = pt(a1, c1);
  return {
    errors, warnings, moves, text: out.join('\n') + '\n',
    info: {
      start, top, bottom, finalTop, startZ, safeZ, passes, passDepth, step, lines: lines.length, time: t,
      // Where the bit's centre goes (the machine's travel limits apply to it)
      bounds: { min: [Math.min(x0, x1, 0), Math.min(y0, y1, 0), finalTop], max: [Math.max(x0, x1, 0), Math.max(y0, y1, 0), safeZ] },
    },
  };
}
