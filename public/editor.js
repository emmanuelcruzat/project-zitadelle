/* ZITADELLE — map editor. Edits a map definition (the same data as shared/maps/<id>.js), previews it with the
   real generator (shared/mapgen.js) and checks it (shared/mapcheck.js), then saves it as a map file to drop
   into shared/maps/. Runs entirely in the page; nothing is sent to the server. */
(() => {
'use strict';
const { buildMap } = window.ZMAPGEN, { checkMap } = window.ZMAPCHECK;
const $ = id => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d'), panel = $('panel');
const NATIONS = { de: 'Germany', su: 'Soviet Union', it: 'Italy', us: 'United States', gb: 'United Kingdom' };
const LINE_COL = ['#3f6fb0', '#b0563f', '#3f9a6a', '#9a6abf', '#b08a2f', '#2f9ab0', '#b03f8a', '#6a7a3f'];
const r0 = v => Math.round(v);

let def = null, built = null, issues = [], tool = 'move', showBld = true;
let view = { s: 0.05, ox: 0, oy: 0 };   // screen = o + world * s
let drag = null, buildTimer = 0;

// ---------- the map ----------
function blank() {
  const W = 10000, C = W / 2;
  return {
    id: 'mymap', name: 'My map', terrain: 'steppe', seed: 1, world: W, attacker: 'de', defender: 'su',
    lineT: [0, 0.35, 0.7], bow: 400,
    goals: [{ id: 'O1', name: 'Objective', x: C, y: C - 600, r: 500, capScale: 2 }],
    lines: [
      { id: 'A', goal: 'O1', bow: -1, bowAmp: 400, names: ['Farm', 'Mill', 'Crossroads'], from: { x: 1400, y: 8000 } },
      { id: 'B', goal: 'O1', bow: 1, bowAmp: 400, names: ['Orchard', 'Brickworks', 'Station'], from: { x: 8600, y: 8000 } },
    ],
    defRears: [{ x: C, y: 1200 }], farmsteads: 20,
    forests: { count: 8, size: [400, 800] },
    attackerWins: 'takes the objective',
    theatre: { lon: 24, lat: 50, kind: 'Custom map', date: '1943', desc: '' },
  };
}
function names(n, old = []) { const out = old.slice(0, n); while (out.length < n) out.push('Point ' + (out.length + 1)); return out; }
const W = () => def.world || 8000;

function setDef(d) {
  def = JSON.parse(JSON.stringify(d));
  delete def.file;
  def.theatre = def.theatre || { lon: 24, lat: 50, kind: 'Custom map', date: '1943', desc: '' };
  fit(); renderPanel(); rebuild(true);
}

// ---------- build + check ----------
function rebuild(now) {
  clearTimeout(buildTimer);
  $('busy').style.display = 'block';
  buildTimer = setTimeout(() => {
    try {
      built = buildMap(def, { WORLD: W(), CAP_R: 400 });
      issues = checkMap(def, built);
    } catch (e) { built = null; issues = [{ level: 'error', msg: 'The generator failed: ' + e.message }]; }
    $('busy').style.display = 'none';
    renderIssues(); draw();
  }, now ? 0 : 150);
}

// ---------- view ----------
function fit() {
  const w = cv.clientWidth, h = cv.clientHeight, s = Math.min(w, h) * 0.94 / W();
  view = { s, ox: (w - W() * s) / 2, oy: (h - W() * s) / 2 };
}
const sx = x => view.ox + x * view.s, sy = y => view.oy + y * view.s;
const wx = x => (x - view.ox) / view.s, wy = y => (y - view.oy) / view.s;
function resize() {
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = r.width * dpr; cv.height = r.height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

// ---------- handles: things you can drag ----------
function handles() {
  const out = [];
  if (def.city) out.push({ kind: 'city', x: def.city.x, y: def.city.y, set: (x, y) => { def.city.x = x; def.city.y = y; } });
  def.defRears.forEach(r => out.push({ kind: 'rear', x: r.x, y: r.y, set: (x, y) => { r.x = x; r.y = y; } }));
  if (def.river) def.river.pts.forEach((p, i) => out.push({ kind: 'river', i, x: p[0], y: p[1], set: (x, y) => { p[0] = x; p[1] = y; } }));
  def.lines.forEach(l => out.push({ kind: 'start', line: l, x: l.from.x, y: l.from.y, set: (x, y) => { l.from.x = x; l.from.y = y; } }));
  def.goals.forEach(g => out.push({ kind: 'goal', goal: g, x: g.x, y: g.y, set: (x, y) => { g.x = x; g.y = y; } }));
  return out;
}
function handleAt(mx, my) {
  let best = null, bd = 14;
  for (const h of handles()) { const d = Math.hypot(sx(h.x) - mx, sy(h.y) - my); if (d < bd) { bd = d; best = h; } }
  return best;
}

// ---------- drawing ----------
function draw() {
  if (!def) return;
  const w = cv.clientWidth, h = cv.clientHeight, s = view.s;
  ctx.fillStyle = '#0d0e09'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#b8ae79'; ctx.fillRect(sx(0), sy(0), W() * s, W() * s);
  if (built) {
    const B = built;
    if (def.city) { ctx.fillStyle = 'rgba(150,143,128,0.55)'; ctx.beginPath(); ctx.arc(sx(def.city.x), sy(def.city.y), def.city.r * s, 0, 7); ctx.fill(); }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#8a857a';
    for (const st of B.STREETS) { ctx.lineWidth = Math.max(1, st.w * s); ctx.beginPath(); st.pts.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y)))); ctx.stroke(); }
    ctx.fillStyle = '#55683a';
    for (const f of B.FORESTS) { ctx.beginPath(); f.pts.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y)))); ctx.closePath(); ctx.fill(); }
    if (B.RIVER) {
      ctx.strokeStyle = '#4f6f7c'; ctx.lineWidth = Math.max(2, B.RIVER.hw * 2 * s); ctx.beginPath();
      B.RIVER.pts.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y)))); ctx.stroke();
      for (const b of B.RIVER.bridges) {
        ctx.save(); ctx.translate(sx(b.x), sy(b.y)); ctx.rotate(b.a); ctx.fillStyle = '#8a6d4c';
        ctx.fillRect(-b.hw * s, -(B.RIVER.hw + 35) * s, b.hw * 2 * s, (B.RIVER.hw * 2 + 70) * s); ctx.restore();
      }
    }
    if (showBld) {
      const col = { block: '#a0624c', ruin: '#5f564c', house: '#d8c48a', barn: '#6b5a45', church: '#62796a' };
      for (const b of B.BUILDINGS) {
        ctx.save(); ctx.translate(sx(b.x), sy(b.y)); ctx.rotate(b.a); ctx.fillStyle = col[b.kind] || '#999';
        ctx.fillRect(-b.w / 2 * s, -b.h / 2 * s, Math.max(1, b.w * s), Math.max(1, b.h * s)); ctx.restore();
      }
    }
    ctx.lineCap = 'butt';
    // attack routes, capture zones, rear areas
    B.LINES.forEach((L, k) => {
      const pts = B.CAP_POINTS.filter(p => p.line === L), rear = B.REARS.find(r => r.line === L), goal = B.CAP_POINTS[pts[pts.length - 1].next];
      ctx.strokeStyle = LINE_COL[k % LINE_COL.length]; ctx.lineWidth = 3; ctx.setLineDash([10, 7]); ctx.beginPath();
      [rear, ...pts, goal].forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y)))); ctx.stroke(); ctx.setLineDash([]);
    });
    for (const r of B.REARS) {
      ctx.strokeStyle = r.team === def.attacker ? '#3f6fb0' : '#b0563f'; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
      ctx.beginPath(); ctx.arc(sx(r.x), sy(r.y), 380 * s, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const p of B.CAP_POINTS) {
      const goal = !p.line, k = goal ? -1 : B.LINES.indexOf(p.line);
      ctx.fillStyle = goal ? 'rgba(176,60,45,0.35)' : 'rgba(40,50,70,0.25)';
      ctx.strokeStyle = goal ? '#b0563f' : LINE_COL[k % LINE_COL.length]; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), p.r * s, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#11130d'; ctx.font = `600 ${Math.max(11, Math.min(18, p.r * s * 0.5))}px Oswald`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.id, sx(p.x), sy(p.y) - (goal ? 0 : 0));
    }
  }
  // handles
  for (const hd of handles()) {
    const x = sx(hd.x), y = sy(hd.y), hot = drag && drag.h && drag.h.kind === hd.kind && drag.h.x === hd.x && drag.h.y === hd.y;
    ctx.lineWidth = 2; ctx.strokeStyle = '#11130d';
    if (hd.kind === 'goal') { ctx.fillStyle = '#e8574a'; ctx.fillRect(x - 7, y - 7, 14, 14); ctx.strokeRect(x - 7, y - 7, 14, 14); }
    else if (hd.kind === 'start') {
      const k = def.lines.indexOf(hd.line); ctx.fillStyle = LINE_COL[k % LINE_COL.length];
      ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x + 8, y + 6); ctx.lineTo(x - 8, y + 6); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#f0e8c8'; ctx.font = '600 13px Oswald'; ctx.textAlign = 'left'; ctx.fillText(hd.line.id + ' start', x + 10, y);
    } else if (hd.kind === 'river') {
      ctx.fillStyle = '#7fc1dd'; ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.stroke();
    } else if (hd.kind === 'city') {
      ctx.strokeStyle = '#f0e8c8'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y); ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9); ctx.stroke();
    } else if (hd.kind === 'rear') {
      ctx.fillStyle = '#9cc05a'; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill(); ctx.stroke();
    }
    if (hot) { ctx.strokeStyle = '#fff6c8'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 13, 0, 7); ctx.stroke(); }
  }
  // problems on the map
  for (const it of issues) {
    if (it.x == null) continue;
    ctx.fillStyle = it.level === 'error' ? '#d9573f' : '#d9b46b';
    ctx.beginPath(); ctx.arc(sx(it.x), sy(it.y), 9, 0, 7); ctx.fill();
    ctx.fillStyle = '#11130d'; ctx.font = '700 13px Oswald'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', sx(it.x), sy(it.y) + 0.5);
  }
}

// ---------- mouse ----------
const HINTS = {
  move: 'Drag objectives (red squares), line starts (triangles), river points (blue), the town centre (cross) and the defenders’ rear (green). Drag empty ground to pan, scroll to zoom.',
  river: 'Click to add a river point (it slots into the nearest stretch). Right-click a river point to remove it.',
};
function setTool(t) { tool = t; document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); $('hint').textContent = HINTS[t]; }
cv.addEventListener('mousedown', e => {
  const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  if (e.button === 2) return;
  const hd = handleAt(mx, my);
  if (tool === 'river' && !hd) { addRiverPoint(wx(mx), wy(my)); return; }
  drag = hd ? { h: hd, moved: false } : { pan: true, x: mx, y: my, ox: view.ox, oy: view.oy };
});
addEventListener('mousemove', e => {
  if (!drag) return;
  const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  if (drag.pan) { view.ox = drag.ox + mx - drag.x; view.oy = drag.oy + my - drag.y; draw(); return; }
  const x = Math.max(0, Math.min(W(), r0(wx(mx)))), y = Math.max(0, Math.min(W(), r0(wy(my))));
  drag.h.set(x, y); drag.h.x = x; drag.h.y = y; drag.moved = true;
  draw();
});
addEventListener('mouseup', () => {
  if (drag && drag.moved) { rebuild(true); if (drag.h.kind === 'goal' || drag.h.kind === 'city') renderPanel(); }
  drag = null;
});
cv.addEventListener('contextmenu', e => {
  e.preventDefault();
  const r = cv.getBoundingClientRect(), hd = handleAt(e.clientX - r.left, e.clientY - r.top);
  if (hd && hd.kind === 'river' && def.river.pts.length > 2) { def.river.pts.splice(hd.i, 1); rebuild(true); }
});
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, x = wx(mx), y = wy(my);
  view.s *= Math.exp(-e.deltaY * 0.0015);
  view.ox = mx - x * view.s; view.oy = my - y * view.s;
  draw();
}, { passive: false });
function addRiverPoint(x, y) {
  x = r0(x); y = r0(y);
  if (!def.river) { def.river = { width: 220, pts: [[x, y]] }; renderPanel(); draw(); return; }
  const P = def.river.pts;
  if (P.length < 2) { P.push([x, y]); rebuild(true); return; }
  // slot it in where it lengthens the river least (or onto either end)
  let best = { at: P.length, cost: Math.hypot(x - P[P.length - 1][0], y - P[P.length - 1][1]) };
  const c0 = Math.hypot(x - P[0][0], y - P[0][1]);
  if (c0 < best.cost) best = { at: 0, cost: c0 };
  for (let i = 0; i + 1 < P.length; i++) {
    const c = Math.hypot(x - P[i][0], y - P[i][1]) + Math.hypot(x - P[i + 1][0], y - P[i + 1][1]) - Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
    if (c < best.cost) best = { at: i + 1, cost: c };
  }
  P.splice(best.at, 0, [x, y]);
  rebuild(true);
}

// ---------- side panel ----------
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// a labelled input bound to get/set; structural changes re-render the panel
function field(label, value, onChange, opts = {}) {
  const type = opts.type || (typeof value === 'number' ? 'number' : 'text');
  const row = el(`<div class="row"><label>${label}</label>${opts.select
    ? `<select>${opts.select.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`
    : `<input type="${type}" value="${esc(value)}"${opts.step ? ` step="${opts.step}"` : ''}${type === 'checkbox' && value ? ' checked' : ''}>`}</div>`);
  const inp = row.querySelector('input,select');
  inp.addEventListener('change', () => {
    const v = type === 'checkbox' ? inp.checked : type === 'number' ? Number(inp.value) : inp.value;
    onChange(v); if (opts.restructure) renderPanel(); rebuild();
  });
  return row;
}
function section(title, button) {
  const h = el(`<h3><span>${title}</span></h3>`);
  if (button) { const b = el(`<button class="btn">${button[0]}</button>`); b.onclick = button[1]; h.appendChild(b); }
  panel.appendChild(h);
}
function renderPanel() {
  panel.innerHTML = '';
  const N = def.lineT.length;
  section('Map');
  panel.append(
    field('Id (file name)', def.id, v => { def.id = v.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''); }, { restructure: true }),
    field('Name', def.name, v => { def.name = v; }),
    field('Size', W(), v => { def.world = Math.max(4000, Math.min(20000, v)); fit(); }),
    field('Seed', def.seed || 1, v => { def.seed = Math.max(1, Math.round(v)); }),
    field('Attacker', def.attacker, v => { def.attacker = v; }, { select: Object.entries(NATIONS) }),
    field('Defender', def.defender, v => { def.defender = v; }, { select: Object.entries(NATIONS) }),
    field('Points per line', def.lineT.join(', '), v => {
      const t = v.split(',').map(Number).filter(x => x >= 0 && x < 1).sort((a, b) => a - b);
      if (t.length && t[0] === 0) { def.lineT = t; def.lines.forEach(l => { l.names = names(t.length, l.names); }); }
    }, { restructure: true }),
    field('Default bend', def.bow, v => { def.bow = v; }),
    field('Open some lines', !!def.openLines, v => { if (v) def.openLines = [Math.min(2, def.lines.length), def.lines.length]; else delete def.openLines; }, { type: 'checkbox', restructure: true }),
  );
  if (def.openLines) panel.append(field('Open lines min–max', def.openLines.join('–'), v => { const [a, b] = v.split(/[^0-9]+/).map(Number); if (a && b) def.openLines = [a, b]; }));
  panel.append(
    field('Farmsteads', def.farmsteads || 0, v => { def.farmsteads = Math.max(0, v); }),
    field('Win text', def.attackerWins || '', v => { def.attackerWins = v; }),
  );
  panel.appendChild(el('<p class="note">"Points per line" are the fractions of the way from a line’s start to its objective where its points sit; the first must be 0.</p>'));

  section('Objectives', ['+ Add', () => {
    let n = 1; while (def.goals.some(g => g.id === 'O' + n)) n++;
    def.goals.push({ id: 'O' + n, name: 'Objective ' + n, x: r0(W() / 2 + (n - 1) * 700), y: r0(W() / 2), r: 450, capScale: 1.5 });
    renderPanel(); rebuild(true);
  }]);
  def.goals.forEach((g, gi) => {
    const card = el(`<div class="card"><div class="head"><b>${esc(g.id)}</b></div></div>`);
    const del = el('<button class="btn">Remove</button>');
    del.onclick = () => { def.goals.splice(gi, 1); renderPanel(); rebuild(true); };
    card.querySelector('.head').appendChild(del);
    card.append(
      field('Name', g.name, v => { g.name = v; }),
      field('Radius', g.r || 400, v => { g.r = Math.max(150, v); }),
      field('Capture time ×', g.capScale || 1, v => { g.capScale = Math.max(0.5, v); }, { step: 0.1 }),
      field('Landmark', g.church ? 'church' : g.landmark ? g.landmark.kind : 'none', v => {
        delete g.church; delete g.landmark;
        if (v === 'church') g.church = true; else if (v === 'block') g.landmark = { kind: 'block', w: 230, h: 150 }; else if (v === 'barn') g.landmark = { kind: 'barn', w: 300, h: 95 };
      }, { select: [['none', 'None'], ['church', 'Church'], ['block', 'Large building'], ['barn', 'Long hall / station']] }),
    );
    panel.appendChild(card);
  });

  section('Attack lines', ['+ Add', () => {
    const id = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find(c => !def.lines.some(l => l.id === c));
    if (!id) return;
    def.lines.push({ id, goal: def.goals[0] ? def.goals[0].id : 'O1', bow: 1, bowAmp: def.bow, names: names(N), from: { x: r0(W() * 0.15), y: r0(W() * 0.15) } });
    renderPanel(); rebuild(true);
  }]);
  def.lines.forEach((l, li) => {
    const card = el(`<div class="card"><div class="head"><b style="color:${LINE_COL[li % LINE_COL.length]}">Line ${esc(l.id)}</b></div></div>`);
    const del = el('<button class="btn">Remove</button>');
    del.onclick = () => { def.lines.splice(li, 1); if (def.openLines) def.openLines = def.openLines.map(n => Math.min(n, def.lines.length)); renderPanel(); rebuild(true); };
    card.querySelector('.head').appendChild(del);
    card.append(
      field('Leads to', l.goal, v => { l.goal = v; }, { select: def.goals.map(g => [g.id, `${g.id} — ${g.name}`]) }),
      field('Bends', l.bow, v => { l.bow = Number(v); }, { select: [[-1, 'to the left'], [1, 'to the right']] }),
      field('Bend amount', l.bowAmp != null ? l.bowAmp : def.bow, v => { l.bowAmp = v; }),
      field('Point names', names(N, l.names).join(', '), v => { l.names = names(N, v.split(',').map(s => s.trim()).filter(Boolean)); }),
    );
    panel.appendChild(card);
  });
  panel.appendChild(el('<p class="note">Names run from the attacker’s start toward the objective. Drag a line’s start (triangle) on the map.</p>'));

  section("Defenders' rear", ['+ Add', () => { def.defRears.push({ x: r0(W() / 2), y: r0(W() / 2) }); renderPanel(); rebuild(true); }]);
  def.defRears.forEach((r, i) => {
    const card = el(`<div class="card"><div class="head"><b>Rear ${i + 1}</b> <span class="note">${r0(r.x)}, ${r0(r.y)}</span></div></div>`);
    if (def.defRears.length > 1) { const del = el('<button class="btn">Remove</button>'); del.onclick = () => { def.defRears.splice(i, 1); renderPanel(); rebuild(true); }; card.querySelector('.head').appendChild(del); }
    panel.appendChild(card);
  });

  section('River', def.river ? ['Remove', () => { delete def.river; renderPanel(); rebuild(true); }] : null);
  if (def.river) panel.append(field('Width', def.river.width, v => { def.river.width = Math.max(80, v); }));
  panel.appendChild(el(`<p class="note">${def.river ? `${def.river.pts.length} points. ` : 'No river. '}Pick the River tool and click on the map to lay out its course; bridges appear wherever a route or main street crosses it.</p>`));

  section('Town', def.city ? ['Remove', () => { delete def.city; renderPanel(); rebuild(true); }] : ['+ Add', () => { def.city = { x: r0(W() / 2), y: r0(W() / 2), r: r0(W() * 0.25), core: r0(W() * 0.15) }; def.terrain = 'town'; renderPanel(); rebuild(true); }]);
  if (def.city) panel.append(
    field('Radius', def.city.r, v => { def.city.r = Math.max(800, v); }),
    field('Dense core', def.city.core, v => { def.city.core = Math.max(300, Math.min(def.city.r - 200, v)); }),
  );

  section('Woods');
  const fo = def.forests || { count: 0, size: [400, 900] };
  panel.append(
    field('Count', fo.count, v => { def.forests = Object.assign({ size: fo.size }, def.forests, { count: Math.max(0, v) }); }),
    field('Size min–max', fo.size.join('–'), v => { const [a, b] = v.split(/[^0-9]+/).map(Number); if (a && b) def.forests = Object.assign({ count: fo.count }, def.forests, { size: [Math.min(a, b), Math.max(a, b)] }); }),
  );

  section('Theatre map');
  const th = def.theatre;
  panel.append(
    field('Longitude', th.lon, v => { th.lon = v; }, { step: 0.1 }),
    field('Latitude', th.lat, v => { th.lat = v; }, { step: 0.1 }),
    field('Heading', th.kind, v => { th.kind = v; }),
    field('Date', th.date, v => { th.date = v; }),
    field('Description', th.desc, v => { th.desc = v; }),
  );
  panel.appendChild(el('<p class="note">Where the battle sits on the home screen’s map of Europe, and what its card says.</p>'));

  section('Checks');
  panel.appendChild(el('<div class="issues" id="issues"></div>'));
  section('Playing it');
  panel.appendChild(el(`<p class="note">Download the map file and put it in <code>shared/maps/</code> (keep the name <code>${esc(def.id)}.js</code>), then start the server with <code>ZITADELLE_MAP=${esc(def.id)} npm start</code>.</p>`));
  renderIssues();
}
function renderIssues() {
  const box = $('issues');
  if (!box) return;
  box.innerHTML = '';
  if (!issues.length) { box.appendChild(el('<div class="ok">No problems found.</div>')); return; }
  for (const it of issues) {
    const d = el(`<div class="${it.level}">${it.level === 'error' ? 'Problem' : 'Note'}: ${esc(it.msg)}</div>`);
    if (it.x != null) d.onclick = () => { view.ox = cv.clientWidth / 2 - it.x * view.s; view.oy = cv.clientHeight / 2 - it.y * view.s; draw(); };
    box.appendChild(d);
  }
}

// ---------- save / open ----------
function mapFile() {
  const d = JSON.parse(JSON.stringify(def));
  // shell craters: round the town if there is one, otherwise along the front from the starts to the objectives
  if (!d.craters) {
    if (d.city) d.craters = { ring: { x: d.city.x, y: d.city.y, r0: r0(d.city.core * 0.8), r1: r0(d.city.r * 1.2) } };
    else {
      const avg = pts => [r0(pts.reduce((s, p) => s + p.x, 0) / pts.length), r0(pts.reduce((s, p) => s + p.y, 0) / pts.length)];
      d.craters = { along: [avg(d.lines.map(l => l.from)), avg(d.goals)], spread: 1800 };
    }
  }
  // pretty, but with lists of plain numbers (points, ranges) kept on one line
  const json = JSON.stringify(d, null, 2).replace(/\[\s*(-?[\d.]+(?:,\s*-?[\d.]+)*)\s*\]/g, (m, inner) => '[' + inner.replace(/\s+/g, ' ') + ']');
  return `/* Map: ${String(d.name).replace(/\*\//g, '')}. Made with the Zitadelle map editor (/editor).
   Data only; shared/mapgen.js turns it into a battlefield. Format: see the top of mapgen.js. */
(function (root) {
'use strict';
const MAP = ${json};
if (typeof module !== 'undefined' && module.exports) module.exports = MAP;
else (root.ZMAPS = root.ZMAPS || {})[MAP.id] = MAP;
})(typeof self !== 'undefined' ? self : this);
`;
}
$('saveBtn').onclick = () => {
  if (issues.some(i => i.level === 'error') && !confirm('The map still has problems (see Checks). Download it anyway?')) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([mapFile()], { type: 'application/javascript' }));
  a.download = def.id + '.js'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
// open a map file: it's a script that registers itself in ZMAPS, so run it against a stand-in
$('fileIn').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const box = {};
    new Function('self', 'module', await f.text())(box, undefined);
    const d = box.ZMAPS && Object.values(box.ZMAPS)[0];
    if (!d) throw new Error('no map in that file');
    setDef(d);
  } catch (err) { alert('Could not open that map file: ' + err.message); }
  e.target.value = '';
};
$('newBtn').onclick = () => setDef(blank());
$('fitBtn').onclick = () => { fit(); draw(); };
$('showBld').onchange = e => { showBld = e.target.checked; draw(); };
document.querySelectorAll('[data-tool]').forEach(b => { b.onclick = () => setTool(b.dataset.tool); });

// for tests and tools: the map being edited and the file it would save as
window.ZEDITOR = { get def() { return def; }, get issues() { return issues; }, mapFile };

// ---------- start: the maps the server knows ----------
let known = {};
$('loadSel').onchange = e => { if (known[e.target.value]) setDef(known[e.target.value]); };
addEventListener('resize', resize);
resize(); setTool('move');
fetch('/maps.json').then(r => r.json()).then(maps => {
  known = maps;
  $('loadSel').innerHTML = '<option value="">Open a map…</option>' + Object.values(maps).map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  setDef(maps.town || Object.values(maps)[0] || blank());
}).catch(() => setDef(blank()));
})();
