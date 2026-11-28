/* ZITADELLE — builds a battlefield from a map definition (shared/maps/<id>.js).
   Pure and deterministic: the same definition gives the same battlefield on the server and in every browser.
   It knows nothing about game rules; it only lays out the capture-point graph, rear areas, river, buildings and streets.

   A map definition:
     world                    side of the square battlefield (default 8000)
     attacker, defender       side ids ('de', 'su')
     lineT                    where each line's points sit, as fractions of the way from its start to its goal
     bow                      how far lines bow out sideways (world units, at mid-line)
     goals: [{ id, name, x, y, r, capScale, church?, landmark? }]   the defender's objectives (O1, O2, ...)
     lines: [{ id, from: {x, y}, goal, bow: ±1, bowAmp?, names: [...] }]   attack lines, first point = attacker's start;
                              bow is which side it bends to, bowAmp how far (default: the map's bow)
     openLines?: [min, max]   how many lines are open each battle (default: all); the game picks which
     defRears: [{ x, y }]     the defender's rear assembly areas
     seed                     for the buildings
     farmsteads               how many small farms to scatter along the lines
     river?: { pts: [[x, y], ...], width }   a river's course (smoothed), bridged wherever a route or main street crosses
     forests?: { count, size: [min, max] }   woods scattered over the countryside (radius range), clear of the town,
                              the river, points, rears and villages
     city?: { x, y, r, core }  a town: winding avenues along the attack routes, ring roads and side streets, built up
                              solid in the core and thinning to houses with gardens toward r
*/
(function (root) {
'use strict';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;

// distance from p to segment ab
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1, t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
}
// where segments pq and ab cross, or null
function segCross(px, py, qx, qy, ax, ay, bx, by) {
  const d = (qx - px) * (by - ay) - (qy - py) * (bx - ax);
  if (!d) return null;
  const u = ((ax - px) * (by - ay) - (ay - py) * (bx - ax)) / d, v = ((ax - px) * (qy - py) - (ay - py) * (qx - px)) / d;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { x: px + (qx - px) * u, y: py + (qy - py) * u, v } : null;
}
// a smooth curve through control points (Catmull-Rom), sampled roughly every `step` units
function smooth(ctrl, step) {
  const out = [];
  for (let i = 0; i + 1 < ctrl.length; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(ctrl[ctrl.length - 1].slice());
  return out;
}
// corners of an oriented rectangle, grown by m on every side
function corners(b, m = 0) {
  const c = Math.cos(b.a), s = Math.sin(b.a), hw = b.w / 2 + m, hh = b.h / 2 + m;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [b.x + x * c - y * s, b.y + x * s + y * c]);
}
// do two oriented rectangles overlap (separating-axis test)?
function overlap(A, B) {
  for (const P of [A, B]) for (let i = 0; i < 4; i++) {
    const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % 4], nx = y1 - y2, ny = x2 - x1;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of A) { const v = x * nx + y * ny; a0 = Math.min(a0, v); a1 = Math.max(a1, v); }
    for (const [x, y] of B) { const v = x * nx + y * ny; b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}
// a coarse spatial grid of items {x, y, rad, ...}
function grid(cell) {
  const m = new Map(), key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
  return {
    add(it, x0, y0, x1, y1) {
      for (let x = Math.floor(x0 / cell); x <= Math.floor(x1 / cell); x++) for (let y = Math.floor(y0 / cell); y <= Math.floor(y1 / cell); y++) {
        const k = x + ',' + y; if (!m.has(k)) m.set(k, []); m.get(k).push(it);
      }
    },
    near(x, y, r) {
      const out = new Set();
      for (let gx = Math.floor((x - r) / cell); gx <= Math.floor((x + r) / cell); gx++) for (let gy = Math.floor((y - r) / cell); gy <= Math.floor((y + r) / cell); gy++)
        for (const it of m.get(gx + ',' + gy) || []) out.add(it);
      return out;
    },
  };
}

function buildMap(def, { WORLD, CAP_R }) {
  const ATTACKER = def.attacker, DEFENDER = def.defender;
  const LINES = def.lines.map(l => l.id);
  const NPT = def.lineT.length;                       // points per line
  const lineOf = L => def.lines.find(l => l.id === L);
  const goalOf = l => def.goals.find(g => g.id === l.goal);
  let seed = def.seed || 1;
  const rnd = (a, b) => { seed = (seed * 16807) % 2147483647; return a + (seed / 2147483647) * (b - a); };

  // ---------- capture points: each line's chain, then the goals ----------
  const CAP_POINTS = [];
  for (const l of def.lines) {
    const s = l.from, g = goalOf(l), dx = g.x - s.x, dy = g.y - s.y, len = Math.hypot(dx, dy);
    const px = -dy / len * l.bow, py = dx / len * l.bow;   // perpendicular, bowing outward
    def.lineT.forEach((t, k) => {
      const bow = (l.bowAmp != null ? l.bowAmp : def.bow) * Math.sin(Math.PI * t);
      CAP_POINTS.push({ id: l.id + (NPT - k), name: l.names[k], line: l.id, k, r: CAP_R, capScale: 1,
        x: Math.round(s.x + dx * t + px * bow), y: Math.round(s.y + dy * t + py * bow) });
    });
  }
  for (const g of def.goals) CAP_POINTS.push({ id: g.id, name: g.name, line: null, k: NPT, x: g.x, y: g.y, r: g.r || CAP_R, capScale: g.capScale || 1 });
  const GOALS = CAP_POINTS.map((p, i) => (p.line ? -1 : i)).filter(i => i >= 0);
  // neighbours: prev = toward the attacker's start, next = toward the goal
  CAP_POINTS.forEach((p, i) => {
    if (p.line) { p.prev = p.k > 0 ? [i - 1] : []; p.next = p.k < NPT - 1 ? i + 1 : CAP_POINTS.findIndex(q => q.id === lineOf(p.line).goal); }
    else { p.prev = CAP_POINTS.map((q, j) => (q.line && q.k === NPT - 1 && lineOf(q.line).goal === p.id ? j : -1)).filter(j => j >= 0); p.next = -1; }
  });

  // ---------- rear assembly areas: one behind each line's start, and the defender's own ----------
  const REARS = [];
  for (const l of def.lines) {
    const s = l.from, g = goalOf(l), dx = g.x - s.x, dy = g.y - s.y, len = Math.hypot(dx, dy);
    REARS.push({ team: ATTACKER, line: l.id, name: 'Rear ' + l.id, x: clamp(s.x - dx / len * 700, 450, WORLD - 450), y: clamp(s.y - dy / len * 700, 450, WORLD - 450) });
  }
  for (const r of def.defRears) REARS.push({ team: DEFENDER, line: null, name: 'Rear', x: r.x, y: r.y });

  // the main routes: each line's rear -> its points -> its goal; each goal -> the nearest defender rear
  const defRears = REARS.filter(r => r.team === DEFENDER);
  const ROUTES = def.lines.map(l => [REARS.find(r => r.line === l.id), ...CAP_POINTS.filter(p => p.line === l.id), goalOf(l)].map(p => [p.x, p.y]))
    .concat(def.goals.map(g => {
      const r = defRears.reduce((a, b) => (Math.hypot(b.x - g.x, b.y - g.y) < Math.hypot(a.x - g.x, a.y - g.y) ? b : a));
      return [[g.x, g.y], [r.x, r.y]];
    }));

  // ---------- river ----------
  const RIVER = def.river ? { pts: smooth(def.river.pts, 70), hw: def.river.width / 2, bridges: [] } : null;
  const riverDist = (x, y) => {
    if (!RIVER) return Infinity;
    let d = Infinity;
    for (let i = 0; i + 1 < RIVER.pts.length; i++) d = Math.min(d, segDist(x, y, ...RIVER.pts[i], ...RIVER.pts[i + 1]));
    return d;
  };
  // where a polyline crosses the river: [{ x, y, i }] (i = river segment)
  function riverCrossings(poly) {
    const out = [];
    if (!RIVER) return out;
    for (let j = 0; j + 1 < poly.length; j++) for (let i = 0; i + 1 < RIVER.pts.length; i++) {
      const c = segCross(...poly[j], ...poly[j + 1], ...RIVER.pts[i], ...RIVER.pts[i + 1]);
      if (c) out.push({ x: c.x, y: c.y, i });
    }
    return out;
  }

  // ---------- town streets ----------
  // Avenues follow the attack routes in from the edge of town to their goals and on to the centre, winding a
  // little; irregular ring roads circle the centre; side streets join the rings at random angles, closer
  // together in the old core than in the suburbs. Each street: { pts, w, main }.
  const city = def.city || null;
  const STREETS = [];
  const inCity = (x, y, m = 0) => !!city && Math.hypot(x - city.x, y - city.y) < city.r + m;
  function wobbly(ctrl, amp) {   // subdivide and nudge sideways, then smooth
    const out = [ctrl[0]];
    for (let i = 0; i + 1 < ctrl.length; i++) {
      const [ax, ay] = ctrl[i], [bx, by] = ctrl[i + 1], l = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(l / 320));
      for (let k = 1; k <= n; k++) {
        const t = k / n, j = k < n ? rnd(-amp, amp) : 0;
        out.push([ax + (bx - ax) * t - (by - ay) / l * j, ay + (by - ay) * t + (bx - ax) / l * j]);
      }
    }
    return smooth(out, 60);
  }
  if (city) {
    const { x: cx, y: cy, r: R, core } = city;
    const ringBase = [core * 0.32, core * 0.62, core, R * 0.8];
    const phases = ringBase.map(() => [rnd(0, TAU), rnd(0, TAU), rnd(0.04, 0.08), rnd(0.02, 0.05)]);
    const ringR = (k, a) => { const [p1, p2, a1, a2] = phases[k]; return ringBase[k] * (1 + a1 * Math.sin(3 * a + p1) + a2 * Math.sin(5 * a + p2)); };
    const atR = (a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    // avenues along the attack routes
    const avenueAngles = [];
    for (const l of def.lines) {
      const pts = CAP_POINTS.filter(p => p.line === l.id), inside = pts.filter(p => inCity(p.x, p.y));
      const first = inside[0] || goalOf(l), a = Math.atan2(first.y - cy, first.x - cx);
      avenueAngles.push(a);
      STREETS.push({ pts: wobbly([atR(a, R + 150), ...inside.map(p => [p.x, p.y]), [goalOf(l).x, goalOf(l).y], [cx, cy]], 45), w: 150, main: true });
    }
    // more avenues in the widest gaps between them
    const sorted = avenueAngles.map(a => (a + TAU) % TAU).sort((a, b) => a - b);
    sorted.forEach((a, i) => {
      const b = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + TAU, gap = b - a;
      const n = Math.floor(gap / 0.85);
      for (let k = 1; k <= n; k++) {
        const m = a + gap * k / (n + 1) + rnd(-0.1, 0.1);
        STREETS.push({ pts: wobbly([atR(m, R + 150), atR(m + rnd(-0.15, 0.15), core * 0.9), atR(m + rnd(-0.2, 0.2), ringBase[0])], 40), w: 140, main: true });
      }
    });
    // ring roads
    ringBase.forEach((_, k) => {
      const ctrl = [];
      for (let i = 0; i <= 48; i++) { const a = i / 48 * TAU; ctrl.push(atR(a, ringR(k, a))); }
      STREETS.push({ pts: smooth(ctrl, 60), w: k === 0 || k === 3 ? 120 : 135, main: true, ring: true });
    });
    // side streets: between each pair of rings, and out from the last ring to the edge of town
    const bands = [[0, 1, 260], [1, 2, 300], [2, 3, 420], [3, null, 620]];
    for (const [k0, k1, spacing] of bands) {
      const rMid = k1 == null ? (ringBase[k0] + R) / 2 : (ringBase[k0] + ringBase[k1]) / 2, n = Math.round(TAU * rMid / spacing);
      for (let i = 0; i < n; i++) {
        const a = (i + rnd(-0.35, 0.35)) / n * TAU, b = a + rnd(-0.12, 0.12);
        const p0 = atR(a, ringR(k0, a)), p1 = k1 == null ? atR(b, R * rnd(0.92, 1.02)) : atR(b, ringR(k1, b));
        if (k1 == null && rnd(0, 1) < 0.35) continue;
        STREETS.push({ pts: wobbly([p0, p1], 30), w: 105, main: false });
      }
    }
  }

  // ---------- bridges: wherever a main route or main street crosses the river, then enough to break up long stretches ----------
  if (RIVER) {
    const want = [];
    for (const poly of ROUTES) for (const c of riverCrossings(poly)) want.push(c);
    for (const s of STREETS) if (s.main) for (const c of riverCrossings(s.pts)) want.push(c);
    for (const c of want) if (!RIVER.bridges.some(b => Math.hypot(b.x - c.x, b.y - c.y) < 450)) RIVER.bridges.push({ x: c.x, y: c.y, i: c.i, hw: 95 });
    // no stretch of open water longer than ~2600 without a crossing (counting along the river)
    const along = [0];
    for (let i = 1; i < RIVER.pts.length; i++) along.push(along[i - 1] + Math.hypot(RIVER.pts[i][0] - RIVER.pts[i - 1][0], RIVER.pts[i][1] - RIVER.pts[i - 1][1]));
    const total = along[along.length - 1];
    let marks = RIVER.bridges.map(b => along[b.i]).concat([0, total]).sort((a, b) => a - b);
    for (let j = 0; j + 1 < marks.length; j++) {
      const gap = marks[j + 1] - marks[j];
      if (gap < 2600) continue;
      const n = Math.floor(gap / 2600);
      for (let k = 1; k <= n; k++) {
        const s = marks[j] + gap * k / (n + 1), i = Math.max(0, along.findIndex(v => v >= s) - 1), [x, y] = RIVER.pts[i];
        if (x < 300 || y < 300 || x > WORLD - 300 || y > WORLD - 300) continue;
        RIVER.bridges.push({ x, y, i, hw: 95 });
      }
    }
    RIVER.bridges.forEach(b => { const [ax, ay] = RIVER.pts[b.i], [bx, by] = RIVER.pts[b.i + 1]; b.a = Math.atan2(by - ay, bx - ax); });
  }

  // ---------- buildings ----------
  // Each building is an oriented rectangle {x, y, w, h, a, kind, s, br} that blocks vehicles and shells.
  // Villages (HAMLETS) sit on the points out in the country; the town is built along its streets.
  const BUILDINGS = [], HAMLETS = [], PARKS = [];
  const bgrid = grid(300);
  const add = b => {
    b.br = Math.hypot(b.w, b.h) / 2; BUILDINGS.push(b);
    bgrid.add(b, b.x - b.br, b.y - b.br, b.x + b.br, b.y + b.br);
    return b;
  };
  const dry = (x, y, r) => riverDist(x, y) > (RIVER ? RIVER.hw : 0) + r + 40;
  // keep at least a tank's width of driveable gap between any two village buildings
  const fits = b => BUILDINGS.every(o => Math.hypot(o.x - b.x, o.y - b.y) > o.br + b.br + 70);

  function hamlet(cx, cy, big, name, goal) {
    const ang = rnd(0, Math.PI), n = big ? 9 + (rnd(0, 4) | 0) : 4 + (rnd(0, 4) | 0);
    const len = big ? 760 : 460;
    const h = { x: cx, y: cy, a: ang, len, name, big, b0: BUILDINGS.length };
    const streets = [ang];
    if (big || rnd(0, 1) < 0.3) streets.push(ang + Math.PI / 2 + rnd(-0.3, 0.3));
    h.streets = streets;
    if (goal && goal.church) add({ x: cx + Math.cos(ang + 0.8) * 150, y: cy + Math.sin(ang + 0.8) * 150, w: 155, h: 96, a: ang, kind: 'church', s: 0.5 });
    let tries = 0, placed = 0;
    while (placed < n && tries++ < n * 14) {
      const sa = streets[(rnd(0, streets.length)) | 0];
      const along = rnd(-len / 2, len / 2), side = rnd(0, 1) < 0.5 ? -1 : 1;
      const r = rnd(0, 1), kind = r < 0.17 ? 'barn' : r < 0.32 ? 'ruin' : 'house';
      const w = kind === 'barn' ? rnd(165, 215) : rnd(82, 128), d = kind === 'barn' ? rnd(78, 98) : rnd(56, 78);
      const off = side * (66 + d / 2 + rnd(0, 45));
      const ca = Math.cos(sa), sn = Math.sin(sa);
      const b = { x: cx + ca * along - sn * off, y: cy + sn * along + ca * off, w, h: d, a: sa + rnd(-0.08, 0.08), kind, s: rnd(0, 1) };
      b.br = Math.hypot(w, d) / 2;
      if (b.x < 200 || b.y < 200 || b.x > WORLD - 200 || b.y > WORLD - 200 || !fits(b) || inCity(b.x, b.y, 60) || !dry(b.x, b.y, b.br)) continue;
      add(b); placed++;
    }
    h.b1 = BUILDINGS.length; HAMLETS.push(h);
  }

  function buildTown() {
    const { x: cx, y: cy, r: R, core } = city;
    // open squares: capture points and the defender's rear inside the town
    const squares = CAP_POINTS.filter(p => inCity(p.x, p.y)).map(p => ({ x: p.x, y: p.y, r: p.line ? 230 : 300 }))
      .concat(REARS.filter(r => inCity(r.x, r.y)).map(r => ({ x: r.x, y: r.y, r: 360 })));
    // landmarks on the goal squares, on the side away from the town centre
    for (const g of def.goals) {
      if (!inCity(g.x, g.y)) continue;
      const d = Math.hypot(g.x - cx, g.y - cy) || 1, ux = (g.x - cx) / d, uy = (g.y - cy) / d, a = Math.atan2(uy, ux) + Math.PI / 2;
      if (g.church) add({ x: g.x + ux * 200, y: g.y + uy * 200, w: 180, h: 110, a, kind: 'church', s: 0.5, urban: true });
      else if (g.landmark) add({ x: g.x + ux * 210, y: g.y + uy * 210, w: g.landmark.w, h: g.landmark.h, a, kind: g.landmark.kind, s: 0.3, urban: true });
    }
    // streets as a searchable set of segments
    const sgrid = grid(300);
    for (const s of STREETS) for (let i = 0; i + 1 < s.pts.length; i++) {
      const [ax, ay] = s.pts[i], [bx, by] = s.pts[i + 1], seg = { ax, ay, bx, by, hw: s.w / 2 };
      sgrid.add(seg, Math.min(ax, bx) - 80, Math.min(ay, by) - 80, Math.max(ax, bx) + 80, Math.max(ay, by) + 80);
    }
    const offStreets = cs => cs.every(([x, y]) => { for (const g of sgrid.near(x, y, 90)) if (segDist(x, y, g.ax, g.ay, g.bx, g.by) < g.hw + 2) return false; return true; });
    const clearOf = (cs, margin) => {
      const xs = cs.map(c => c[0]), ys = cs.map(c => c[1]), mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
      for (const o of bgrid.near(mx, my, 250)) if (overlap(cs, corners(o, margin))) return false;
      return true;
    };
    // parks: a few open lawns with trees, kept clear of buildings
    for (let k = 0, tries = 0; k < 10 && tries < 200; tries++) {
      const a = rnd(0, TAU), d = rnd(core * 0.55, R * 0.85), x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d, sz = rnd(150, 230);
      if (!dry(x, y, sz) || squares.some(q => Math.hypot(q.x - x, q.y - y) < q.r + sz) || PARKS.some(q => Math.hypot(q.x - x, q.y - y) < 900)) continue;
      PARKS.push({ x, y, s: sz }); squares.push({ x, y, r: sz * 0.6 }); k++;
    }
    // Suburbs: walk both sides of every street putting up detached houses that face it, with gardens behind.
    for (const s of STREETS) {
      for (const side of [-1, 1]) {
        let i = 0, t = rnd(0, 20);
        while (i + 1 < s.pts.length) {
          const [ax, ay] = s.pts[i], [bx, by] = s.pts[i + 1], l = Math.hypot(bx - ax, by - ay);
          if (t > l) { t -= l; i++; continue; }
          const tx = (bx - ax) / l, ty = (by - ay) / l, nx = -ty * side, ny = tx * side, px = ax + tx * t, py = ay + ty * t;
          const u = clamp((Math.hypot(px - cx, py - cy) - core) / (R - core), 0, 1);   // 0 in the core, 1 at the edge
          const zone = u === 0 ? 'core' : u < 0.5 ? 'mid' : 'suburb', row = zone !== 'suburb';
          if (row) { t += 40; continue; }   // the centre and middle ring are perimeter blocks (below)
          const kind = rnd(0, 1) < (zone === 'core' ? 0.18 : 0.07) ? 'ruin' : zone === 'suburb' ? (rnd(0, 1) < 0.12 ? 'barn' : 'house') : 'block';
          const w = zone === 'core' ? rnd(55, 110) : zone === 'mid' ? rnd(55, 95) : rnd(65, 100);
          const d = zone === 'core' ? rnd(78, 100) : zone === 'mid' ? rnd(66, 86) : rnd(52, 75);
          const back = row ? 2 : rnd(35, 75);                  // rows sit on the pavement; houses stand back
          const gap = row ? 0 : rnd(70, 180);
          const dens = zone === 'core' ? 1 : zone === 'mid' ? 0.96 : 0.5;
          const off = s.w / 2 + back + d / 2;
          const b = { x: px + tx * w / 2 + nx * off, y: py + ty * w / 2 + ny * off, w, h: d, a: Math.atan2(ty, tx), kind, s: rnd(0, 1),
            urban: row, gs: side };   // gs: which side a house's garden goes (away from the street)
          b.br = Math.hypot(w, d) / 2;
          const cs = corners(b);
          const ok = rnd(0, 1) < dens && inCity(b.x, b.y, -40) && dry(b.x, b.y, b.br) && b.x > 200 && b.y > 200 && b.x < WORLD - 200 && b.y < WORLD - 200
            && !squares.some(q => Math.hypot(q.x - b.x, q.y - b.y) < q.r + Math.max(w, d) / 2)
            && offStreets(cs) && clearOf(cs, row ? -5 : 35);   // rows may touch (and overlap a little on bends)
          if (ok) add(b);
          t += ok ? w + gap : row ? 12 : 30;   // a blocked spot in a row: try again just along, to keep the frontage closed
        }
      }
    }
    // City blocks, in the centre and the middle ring. First rasterise everything that has to stay open: streets,
    // squares, parks, the river and the landmarks.
    const CELL = 20, ox = cx - R, oy = cy - R, N = Math.ceil(2 * R / CELL);
    const open = new Uint8Array(N * N);   // 1 = must stay open
    const cellOf = (x, y) => { const i = Math.floor((x - ox) / CELL), j = Math.floor((y - oy) / CELL); return i < 0 || j < 0 || i >= N || j >= N ? -1 : j * N + i; };
    const reachOut = R * 0.5 + core * 0.5 + (R - core) * 0.25;   // blocks stop where the suburbs begin
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = ox + (i + 0.5) * CELL, y = oy + (j + 0.5) * CELL, dd = Math.hypot(x - cx, y - cy);
      if (dd > reachOut || squares.some(q => Math.hypot(q.x - x, q.y - y) < q.r)) open[j * N + i] = 1;
    }
    const lanes = STREETS.map(st => ({ pts: st.pts, m: st.w / 2 + 8 }));
    if (RIVER) lanes.push({ pts: RIVER.pts, m: RIVER.hw + 60 });   // the river and its banks
    for (const st of lanes) for (let k = 0; k + 1 < st.pts.length; k++) {
      const [ax, ay] = st.pts[k], [bx, by] = st.pts[k + 1], m = st.m;
      for (let y = Math.min(ay, by) - m; y <= Math.max(ay, by) + m; y += CELL) for (let x = Math.min(ax, bx) - m; x <= Math.max(ax, bx) + m; x += CELL) {
        const c = cellOf(x, y);
        if (c >= 0 && segDist(ox + (c % N + 0.5) * CELL, oy + (Math.floor(c / N) + 0.5) * CELL, ax, ay, bx, by) < m) open[c] = 1;
      }
    }
    for (const o of BUILDINGS) for (const [x, y] of corners(o, 10).concat([[o.x, o.y]])) { const c = cellOf(x, y); if (c >= 0) open[c] = 1; }   // landmarks
    const free = (x, y) => { const c = cellOf(x, y); return c >= 0 && !open[c]; };
    // Perimeter blocks: walk both sides of every street in the centre and the middle ring, putting up buildings
    // wall to wall a pavement's width back from the kerb. Each one is as deep as the block lets it be: in a
    // narrow block the rows from both sides meet in the middle and the block is solid; a wide one keeps an open
    // courtyard behind its frontages. Following the streets, the blocks follow every bend.
    const PAVE = 10, MAXD = 95;
    for (const st of STREETS) for (const side of [-1, 1]) {
      let i = 0, t = rnd(0, 20);
      while (i + 1 < st.pts.length) {
        const [ax, ay] = st.pts[i], [bx, by] = st.pts[i + 1], l = Math.hypot(bx - ax, by - ay);
        if (t > l) { t -= l; i++; continue; }
        const tx = (bx - ax) / l, ty = (by - ay) / l, nx = -ty * side, ny = tx * side, px = ax + tx * t, py = ay + ty * t;
        const u = clamp((Math.hypot(px - cx, py - cy) - core) / (R - core), 0, 1);
        if (u >= 0.5) { t += 40; continue; }   // suburbs: detached houses (above)
        const w = u === 0 ? rnd(50, 95) : rnd(50, 85), front = st.w / 2 + PAVE;
        // how much free ground lies behind the pavement here (across the block to the next street or square)
        let room = 0;
        for (let k = 0; k < 40 && free(px + tx * w / 2 + nx * (front + room + 10), py + ty * w / 2 + ny * (front + room + 10)); k++) room += 10;
        const d = room < 2 * MAXD ? Math.min(MAXD, room / 2 - 1) : MAXD;
        if (d < 35) { t += 12; continue; }
        const off = front + d / 2, b = { x: px + tx * w / 2 + nx * off, y: py + ty * w / 2 + ny * off, w, h: d, a: Math.atan2(ty, tx),
          kind: rnd(0, 1) < (u === 0 ? 0.18 : 0.08) ? 'ruin' : 'block', s: rnd(0, 1), urban: true };
        b.br = Math.hypot(w, d) / 2;
        const cs = corners(b, -3);
        if (cs.every(([x, y]) => free(x, y)) && free(b.x, b.y) && clearOf(corners(b), -4)) { add(b); t += w; }
        else t += 12;   // blocked: try again just along, to keep the frontage closed
      }
    }
  }

  // villages on the points out in the country, then the town, then farmsteads along the lines
  CAP_POINTS.forEach(p => { if (!inCity(p.x, p.y, 150)) hamlet(p.x, p.y, true, p.name, def.goals.find(g => g.id === p.id)); });
  if (city) buildTown();
  const segs = [];
  for (const l of def.lines) {
    const pts = CAP_POINTS.filter(p => p.line === l.id).concat([goalOf(l)]);
    for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
  }
  let tries = 0, farms = 0;
  while (farms < (def.farmsteads || 0) && tries++ < 6000) {
    const x = rnd(450, WORLD - 450), y = rnd(450, WORLD - 450);
    if (Math.min(...segs.map(([a, b]) => segDist(x, y, a.x, a.y, b.x, b.y))) > 1800) continue;
    if (inCity(x, y, 500) || !dry(x, y, 400)) continue;
    if (HAMLETS.some(h => Math.hypot(h.x - x, h.y - y) < (h.big ? 1000 : 750))) continue;
    if (REARS.some(r => Math.hypot(r.x - x, r.y - y) < 1000)) continue;
    hamlet(x, y, false, null, null);
    farms++;
  }

  // ---------- forests: irregular woods out in the country, kept off the town, river, points, rears and villages ----------
  const FORESTS = [];
  if (def.forests) {
    const [r0, r1] = def.forests.size;
    for (let tries = 0; FORESTS.length < def.forests.count && tries < 4000; tries++) {
      const r = rnd(r0, r1), x = rnd(r + 300, WORLD - r - 300), y = rnd(r + 300, WORLD - r - 300);
      if (inCity(x, y, r + 400) || !dry(x, y, r + 120)) continue;
      if (CAP_POINTS.some(p => Math.hypot(p.x - x, p.y - y) < p.r + r + 200)) continue;
      if (REARS.some(q => Math.hypot(q.x - x, q.y - y) < 380 + r + 150)) continue;
      if (HAMLETS.some(h => Math.hypot(h.x - x, h.y - y) < h.len * 0.6 + r + 150)) continue;
      if (FORESTS.some(f => Math.hypot(f.x - x, f.y - y) < f.r + r + 250)) continue;
      if (BUILDINGS.some(b => Math.hypot(b.x - x, b.y - y) < r * 1.2 + b.br)) continue;
      // a blob: radius wobbling with two harmonics
      const p1 = rnd(0, TAU), p2 = rnd(0, TAU), a1 = rnd(0.12, 0.22), a2 = rnd(0.06, 0.12), n = 22, pts = [];
      for (let k = 0; k < n; k++) {
        const a = k / n * TAU, rr = r * (1 + a1 * Math.sin(2 * a + p1) + a2 * Math.sin(5 * a + p2));
        pts.push([Math.round(x + Math.cos(a) * rr), Math.round(y + Math.sin(a) * rr)]);
      }
      FORESTS.push({ x, y, r, pts });
    }
  }

  return { ATTACKER, DEFENDER, LINES, NPT, CAP_POINTS, GOALS, REARS, BUILDINGS, HAMLETS, STREETS, PARKS, RIVER, ROUTES, FORESTS };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { buildMap };
else root.ZMAPGEN = { buildMap };
})(typeof self !== 'undefined' ? self : this);
