// Surfacing (surfacing) program for rough stock, for the /surfacing page: back-and-forth passes
// over the whole top of the stock, one Z level after the other. Millimetres only.
//
// Layout of one Z level, cutting along X (along Y is the same with X and Y swapped):
//
//      W+c    ─────────────────────────────►   the last line's centre is c past the far edge
//            ╭─────────────────────────────╯
//      -c    ╰─────────────────────────────►   the first line's centre is c past the near edge
//            |<-c->|      stock      |<-c->|
//
// The bit's centre runs past every edge of the stock by the clearance c, along the cut and
// across it. c must be less than the radius, so the bit still covers the edges. From the end of
// a line the bit turns round to the next one in a half circle (G2/G3) at the cut depth, bulging
// out past the line ends by half the gap between lines: no sharp corners, so the machine doesn't
// stop and jerk at each end. Each pass starts with the bit fully beside the stock, so the plunges
// happen in the air. With clearTurn, the lines run on until the whole bit is c clear of the stock
// (centre r + c past the edge), so the turns happen in the air too.
//
// With cleanEdges (for surfacing only part of a bigger piece, where the line ends are not in the
// air): the half circles leave a scalloped edge at both ends of the lines. After each Z level
// the bit cuts once across all the lines at each end, at that level, with its centre on the tips
// of the turns, so both ends finish as straight edges:
//
//      │╭──╮  ╭──╮│        the straight cut covers from the tips of the turns back past
//      ││  ╰──╯  ││        the line ends (half the line gap is less than the bit radius)
//      ▼          ▼
//
// With cutWay 'plus' or 'minus' every line is cut the same way (towards + or - along the cut):
// at the end of a line the bit lifts to the safe height, goes back beside the stock in a rapid,
// comes down there in the air and starts the next line - slower, but each line cuts the same
// way, which shows whether a tramming or tool-mark problem depends on the direction of travel.
//
// The Z zero picks the job:
//   'top' - surface the rough face: Z0 on the stock's highest point, remove `depth` from there.
//           `thickness` is only for drawing the stock (a rough guess will do).
//   'bed' - bring stock that's already flat to a thickness: Z0 on the spoilboard, the top at
//           Z = `current`, the last pass at Z = `target`.

export const RAPID_ESTIMATE = 5000;   // mm/min, only for the run-time estimate
const ARC_CHORDS = 16;                // a half-circle turn, in the simulation
const PARK_MARGIN = 1;                // mm inside the machine's travel limits when parking

// No default for the spoilboard mode's thicknesses: they set where the bit cuts, so a made-up
// value could cut the stock too thin.
export const DEFAULTS = {
  length: 600, width: 200, thickness: 15, zMode: 'top', startAbove: 0, current: null, target: null,
  toolD: 50, depth: 3, stepdown: 1, stepover: 40, direction: 'x', cutWay: 'both',
  rpm: 18000, feed: 3000, plunge: 900,
  safe: 5, clearance: 5, clearTurn: false, cleanEdges: false, parkGap: 10, dwell: 3,
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
export function planSurfacing(input, { date = new Date(), travel = null } = {}) {
  const p = { ...DEFAULTS, ...input };
  const errors = [];
  const warnings = [];
  const need = (key, label, ok, msg) => { if (!(Number.isFinite(p[key]) && ok(p[key]))) errors.push(`${label}: ${msg}`); };
  const pos = (v) => v > 0;
  need('length', 'Length', pos, 'enter a size above 0');
  need('width', 'Width', pos, 'enter a size above 0');
  const bed = p.zMode === 'bed';
  if (bed) {
    need('current', 'Current thickness', pos, 'measure the stock and enter its thickness');
    need('target', 'Target thickness', pos, 'enter the thickness you want, above 0');
  } else {
    need('thickness', 'Thickness (rough)', pos, 'enter a thickness above 0 (a rough guess will do)');
    need('depth', 'Depth to remove', pos, 'enter a depth above 0');
  }
  need('toolD', 'Bit diameter', pos, 'enter a diameter above 0');
  need('stepdown', 'Step-down', pos, 'enter a depth per pass above 0');
  need('stepover', 'Stepover', (v) => v >= 5 && v <= 100, 'between 5 and 100 % of the diameter');
  need('rpm', 'Spindle speed', pos, 'enter a speed above 0');
  need('feed', 'Feed', pos, 'enter a feed above 0');
  need('plunge', 'Plunge feed', pos, 'enter a feed above 0');
  need('safe', 'Safe height', (v) => v >= 1, 'at least 1 mm above the stock');
  need('parkGap', 'End clear of the back-right corner', (v) => v >= 0, 'enter 0 or more');
  need('clearance', 'Run past the edges', (v) => v >= 0, 'enter 0 or more');
  need('dwell', 'Spin-up time', (v) => v >= 0, 'enter 0 or more seconds');
  need('startAbove', 'Start above Z0', (v) => v >= 0, 'enter 0 or more');
  if (!['top', 'bed'].includes(p.zMode)) errors.push('Z zero: choose the top of the stock or the spoilboard');
  if (!['x', 'y'].includes(p.direction)) errors.push('Direction: choose along X or along Y');
  if (!['both', 'plus', 'minus'].includes(p.cutWay)) errors.push('Cut: choose both ways, only towards + or only towards -');
  if (!errors.length && bed && p.target >= p.current) errors.push('Target thickness: must be less than the current thickness');
  if (!errors.length && !bed && p.depth >= p.thickness) errors.push('Depth to remove: must be less than the stock thickness');
  if (!errors.length && p.clearance >= p.toolD / 2) errors.push(`Run past the edges: must be less than the bit radius (${fmt(p.toolD / 2)} mm), or the edges are not cut`);
  if (errors.length) return { errors, warnings };
  if (bed) {
    // The rest works from the thickness and the depth, as for the top of the stock
    p.thickness = p.current;
    p.depth = p.current - p.target;
  }

  const r = p.toolD / 2;
  // Where the program ends: past the stock's back-right corner, with the bit's edge parkGap clear
  // of the stock in X and in Y (Y: the stock's length, `width` here), kept inside the machine's
  // travel when it's known
  const park = [p.length + r + p.parkGap, p.width + r + p.parkGap];
  let parkNote = `past the back-right corner of the stock, the bit ${fmt(p.parkGap)} mm clear of it in X and Y`;
  if (travel) {
    const inside = (v, k) => Math.min(Math.max(v, travel.min[k] + PARK_MARGIN), travel.max[k] - PARK_MARGIN);
    const want = [...park];
    park[0] = inside(park[0], 0);
    park[1] = inside(park[1], 1);
    if (park[0] < want[0] || park[1] < want[1]) {
      parkNote = 'past the back-right corner of the stock, as far as the machine\'s travel allows';
      // Clear of the stock as long as it's past one of its edges
      if (park[0] < p.length + r && park[1] < p.width + r) {
        warnings.push(`Not enough travel past the back-right corner of the stock to park the bit clear of it: ` +
                      `the program ends at X${fmt(park[0])} Y${fmt(park[1])}, with the bit over the stock (at the safe height).`);
      }
    }
  }
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
  const oneWay = p.cutWay !== 'both';
  const from = p.cutWay === 'minus' ? 1 : 0;          // the end each line starts from
  const axis = alongX ? 'X' : 'Y';
  // cleanEdges: where the bit's centre runs for the straight cut at each end of the lines - on the
  // tips of the half-circle turns (half a line gap past the line ends), or with one-way lines, on
  // the line ends themselves (where they start and where they stop)
  const gap = lines.length > 1 ? lines[1] - lines[0] : 0;
  const edgeAt = oneWay
    ? (from ? [ends[0], air[1]] : [air[0], ends[1]])
    : [ends[0] - gap / 2, ends[1] + gap / 2];
  if (p.stepover > 80) warnings.push('A stepover above 80 % can leave ridges between the lines.');
  if (passDepth > 0.25 * p.toolD) warnings.push(`Each pass cuts ${fmt(passDepth)} mm, more than a quarter of the bit diameter.`);
  if (p.plunge > p.feed) warnings.push('The plunge feed is faster than the feed.');

  // Moves, in machine order. pt(a, c): a = along the cut, c = across it.
  const pt = (a, c) => (alongX ? [a, c] : [c, a]);
  const moves = [];
  let cur = [...pt(air[from], lines[0]), safeZ];
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
  // Half circle from the end of one line to the start of the next (q), at the cut depth. It
  // carries on the way the bit was going (`dir` along the cut, +1 or -1), so it bulges out past
  // the line ends and leaves and joins the lines without a corner.
  const turn180 = (q, dir, pass) => {
    const ctr = [(cur[0] + q[0]) / 2, (cur[1] + q[1]) / 2];
    const v = [ctr[0] - cur[0], ctr[1] - cur[1]];           // start to centre
    const t = pt(dir, 0);                                     // the way the bit was going
    const ccw = t[0] * v[1] - t[1] * v[0] > 0;                // centre on the left: turn left
    G(`${ccw ? 'G3' : 'G2'} ${xy(q)} I${fmt(v[0])} J${fmt(v[1])}`);
    const a0 = Math.atan2(-v[1], -v[0]);                      // centre to start
    const R = Math.hypot(v[0], v[1]), z = cur[2];
    for (let i = 1; i <= ARC_CHORDS; i++) {
      const a = a0 + (ccw ? 1 : -1) * Math.PI * i / ARC_CHORDS;
      go(i === ARC_CHORDS ? q : [ctr[0] + R * Math.cos(a), ctr[1] + R * Math.sin(a)], z, false, p.feed, pass);
    }
  };
  // cleanEdges, at the end of a pass (the bit on the last line, `at` the end it stopped at, still
  // at the pass depth): out to the straight-cut position on that end and across all the lines,
  // along the first line (already cut) to the other end, and across all the lines again.
  // Returns the end the bit is at afterwards.
  const cleanEnds = (order, at, pass) => {
    const cA = order[order.length - 1], cB = order[0];
    const path = [pt(edgeAt[at], cA), pt(edgeAt[at], cB), pt(edgeAt[1 - at], cB), pt(edgeAt[1 - at], cA)];
    G(`(Straight cuts across the line ends)`);
    for (const q of path) {
      if (q[0] === cur[0] && q[1] === cur[1]) continue;
      G(`G1 ${xy(q)} F${fmt(p.feed)}`);
      go(q, null, false, p.feed, pass);
    }
    return 1 - at;
  };

  const L = fmt(p.length), W = fmt(p.width), T = fmt(p.thickness);
  G(`(Surfacing${p.material ? ': ' + p.material : ''} - stock ${L} x ${W}${bed ? ` x ${T}` : ''} mm)`);
  G(`(Made with PlanetCNC Observatory, ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
  G(bed
    ? `(Z zero: spoilboard - stock top at Z${fmt(top)}, cut to ${fmt(p.target)} mm thick)`
    : '(Z zero: highest point of the stock top)');
  G('(X0 Y0: front-left corner of the stock)');
  if (p.startAbove > 0) G(`(Starts ${fmt(p.startAbove)} mm above the stock top, at Z${fmt(startZ)}, in case Z was not set on its highest point)`);
  G(`(Removes ${fmt(p.depth)} mm in ${passes} pass${passes > 1 ? 'es' : ''} of ${fmt(passDepth)} mm${p.startAbove > 0 ? ` from Z${fmt(startZ)}` : ''}, cutting along ${axis})`);
  if (oneWay) G(`(Every line cut towards ${from ? '-' : '+'}${axis} only: lift and rapid back between lines)`);
  G(`(T1 D=${fmt(p.toolD)} CR=0 - ZMIN=${fmt(finalTop)} - FLAT END MILL)`);
  G(`(Stepover ${fmt(step)} mm = ${fmt(p.stepover)} %, ${lines.length} line${lines.length > 1 ? 's' : ''} per pass)`);
  G(`(Lines run ${fmt(p.clearance)} mm past the edges${oneWay ? '' : ', turning round in half circles'}${p.clearTurn ? ' with the bit clear of the stock' : ''})`);
  if (p.cleanEdges) G(`(After each pass, a straight cut across the line ends at ${axis}${fmt(edgeAt[0])} and ${axis}${fmt(edgeAt[1])}, for clean edges)`);
  G(`(Spindle ${fmt(p.rpm)} rpm, feed ${fmt(p.feed)} mm/min, plunge ${fmt(p.plunge)} mm/min)`);
  G(`(Ends at the safe height ${parkNote}: X${fmt(park[0])} Y${fmt(park[1])})`);
  G('G21 G90 G94 G17 G91.1');   // G91.1: arc centres (I J) relative to the arc's start
  // Spindle up to speed before the first move, wherever the bit is parked
  G(`M3 S${fmt(p.rpm)}`);
  if (p.dwell > 0) {
    G(`G4 P${fmt(p.dwell)}`);
    moves.push({ x: cur[0], y: cur[1], z: cur[2], rapid: false, feed: 0, dwell: p.dwell, pass: 0 });
  }
  // XY first, at whatever height the bit is at, then down: no trip up to the safe height first
  G(`G0 ${xy(cur)}`);
  G(`G0 Z${fmt(startZ + 1)}`);
  go(null, startZ + 1, true, 0, 0);

  let side = 0;     // which end of the cut the bit is at
  for (let k = 0; k < passes && oneWay; k++) {
    const z = startZ - passDepth * (k + 1);
    const order = k % 2 ? [...lines].reverse() : lines;
    G(`(Pass ${k + 1} of ${passes}: Z${fmt(z)})`);
    for (const c of order) {
      const q0 = pt(air[from], c);
      if (cur[2] < startZ + 1) {                    // lift off the line just cut
        G(`G0 Z${fmt(safeZ)}`);
        go(null, safeZ, true, 0, k + 1);
      }
      if (cur[0] !== q0[0] || cur[1] !== q0[1]) {   // back beside the stock
        G(`G0 ${xy(q0)}`);
        go(q0, null, true, 0, k + 1);
      }
      if (cur[2] > z + 1) {
        G(`G0 Z${fmt(z + 1)}`);
        go(null, z + 1, true, 0, k + 1);
      }
      G(`G1 Z${fmt(z)} F${fmt(p.plunge)}`);
      go(null, z, false, p.plunge, k + 1);
      const q1 = pt(ends[1 - from], c);
      G(`G1 ${xy(q1)} F${fmt(p.feed)}`);
      go(q1, null, false, p.feed, k + 1);
    }
    if (p.cleanEdges) cleanEnds(order, 1 - from, k + 1);
  }
  for (let k = 0; k < passes && !oneWay; k++) {
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
      if (!first) turn180(pt(ends[side], c), side ? 1 : -1, k + 1);
      side = 1 - side;
      const q = pt(ends[side], c);
      G(`G1 ${xy(q)}${first ? ' F' + fmt(p.feed) : ''}`);
      go(q, null, false, p.feed, k + 1);
      first = false;
    }
    // The next pass starts from the end the bit is at, so it carries on from there
    if (p.cleanEdges) side = cleanEnds(order, side, k + 1);
  }
  if (cur[2] !== safeZ) G(`G0 Z${fmt(safeZ)}`);
  go(null, safeZ, true, 0, passes);
  G('M5');
  // Park to the right of the stock (it usually sits in the front-left corner of the bed) and at
  // the back, with the bit clear of it, instead of over X0 Y0 where it's in the way of taking the
  // stock off
  G(`G0 ${xy(park)}`);
  go(park, null, true, 0, passes);
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

  // Where the bit's centre goes, from the moves themselves (the turns bulge past the line ends)
  const lo = [start[0], start[1]], hi = [start[0], start[1]];
  for (const m of moves) {
    lo[0] = Math.min(lo[0], m.x); lo[1] = Math.min(lo[1], m.y);
    hi[0] = Math.max(hi[0], m.x); hi[1] = Math.max(hi[1], m.y);
  }
  return {
    errors, warnings, moves, text: out.join('\n') + '\n',
    info: {
      start, top, bottom, finalTop, startZ, safeZ, passes, passDepth, step, lines: lines.length, time: t,
      depth: p.depth, target: bed ? p.target : null,
      // Where the bit's centre goes (the machine's travel limits apply to it)
      bounds: { min: [lo[0], lo[1], finalTop], max: [hi[0], hi[1], safeZ] },
    },
  };
}
