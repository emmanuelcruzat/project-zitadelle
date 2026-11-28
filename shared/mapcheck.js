/* ZITADELLE — sanity checks for a map: what makes a layout unplayable or awkward.
   Takes a map definition and the battlefield mapgen.js built from it; returns a list of
   { level: 'error' | 'warn', msg, x, y } (x, y: where on the map, when there is a place to point at).
   Used live by the map editor, and by the server at startup. */
(function (root) {
'use strict';

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
}

function checkMap(def, built) {
  const out = [], W = def.world || 8000;
  const err = (msg, x, y) => out.push({ level: 'error', msg, x, y }), warn = (msg, x, y) => out.push({ level: 'warn', msg, x, y });
  const { CAP_POINTS: pts, REARS: rears, RIVER: river } = built;
  const NPT = (def.lineT || []).length;

  // definition
  if (!def.id || !/^[a-z0-9_-]+$/.test(def.id)) err('The map id must be lower-case letters, digits, - or _.');
  if (!def.goals || !def.goals.length) err('The map needs at least one objective.');
  if (!def.lines || !def.lines.length) err('The map needs at least one attack line.');
  if (NPT < 1) err('Lines need at least one point (lineT).');
  for (const g of def.goals || []) if (!(def.lines || []).some(l => l.goal === g.id)) err(`${g.id} has no attack line leading to it.`, g.x, g.y);
  for (const l of def.lines || []) {
    if (!(def.goals || []).some(g => g.id === l.goal)) err(`Line ${l.id} leads to ${l.goal}, which doesn't exist.`, l.from.x, l.from.y);
    if ((l.names || []).length !== NPT) warn(`Line ${l.id} has ${(l.names || []).length} names for ${NPT} points.`, l.from.x, l.from.y);
  }
  const ids = [...(def.goals || []).map(g => g.id), ...(def.lines || []).map(l => l.id)];
  ids.forEach((id, i) => { if (ids.indexOf(id) !== i) err(`The id ${id} is used twice.`); });
  if (def.openLines && (def.openLines[0] < 1 || def.openLines[1] > (def.lines || []).length || def.openLines[0] > def.openLines[1]))
    err(`Open lines must be between 1 and ${(def.lines || []).length}, with min ≤ max.`);

  // points on the map, apart from each other
  for (const p of pts) {
    if (p.x < p.r || p.y < p.r || p.x > W - p.r || p.y > W - p.r) err(`${p.id} (${p.name}) is partly off the map.`, p.x, p.y);
  }
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const a = pts[i], b = pts[j], d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < a.r + b.r) err(`${a.id} and ${b.id} overlap.`, (a.x + b.x) / 2, (a.y + b.y) / 2);
    else if (d < a.r + b.r + 250) warn(`${a.id} and ${b.id} are very close together.`, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
  // rear areas: squeezed against the edge, or on top of a point
  for (const r of rears) {
    if (!r.line) continue;
    const l = def.lines.find(q => q.id === r.line);
    if (l && Math.hypot(r.x - l.from.x, r.y - l.from.y) < 500) warn(`Rear ${r.line} is squeezed against the map edge; move line ${r.line}'s start inward.`, r.x, r.y);
  }
  // attack lines crossing each other
  const segs = [];
  for (const L of built.LINES) {
    const lp = pts.filter(p => p.line === L);
    lp.forEach((p, i) => { const q = i + 1 < lp.length ? lp[i + 1] : pts[p.next]; if (q) segs.push([L, p, q]); });
  }
  for (const [L1, a, b] of segs) for (const [L2, c, d] of segs) {
    if (L1 >= L2) continue;
    const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
    if (!den) continue;
    const u = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den, v = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
    if (u > 0.01 && u < 0.99 && v > 0.01 && v < 0.99) warn(`Lines ${L1} and ${L2} cross.`, a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u);
  }
  // river: clear of capture zones and rear areas, and crossable
  if (river) {
    const dist = (x, y) => { let d = Infinity; for (let i = 0; i + 1 < river.pts.length; i++) d = Math.min(d, segDist(x, y, ...river.pts[i], ...river.pts[i + 1])); return d; };
    for (const p of pts) { const g = dist(p.x, p.y) - p.r - river.hw; if (g < 0) err(`The river runs through ${p.id} (${p.name}).`, p.x, p.y); else if (g < 40) warn(`The river is right at the edge of ${p.id}.`, p.x, p.y); }
    for (const r of rears) { const g = dist(r.x, r.y) - 380 - river.hw; if (g < 0) err(`The river runs through ${r.name}.`, r.x, r.y); }
    if (!river.bridges.length) warn('The river has no bridges: nothing crosses it.');
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { checkMap };
else root.ZMAPCHECK = { checkMap };
})(typeof self !== 'undefined' ? self : this);
