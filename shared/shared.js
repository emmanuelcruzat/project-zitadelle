/* ZITADELLE — shared definitions loaded by both the Node server and the browser client. */
(function (root) {
'use strict';

// ---------- math helpers ----------
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function angDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
  return d;
}
function turnToward(cur, target, step) {
  const d = angDiff(target, cur);
  return Math.abs(d) <= step ? target : cur + Math.sign(d) * step;
}
const lerpAngle = (a, b, t) => a + angDiff(b, a) * t;

// ---------- world ----------
const WORLD = 8000;
const CENTER = WORLD / 2;
const TEAM_SIZE = 8;          // humans + bots per side
const TICK_RATE = 60;         // simulation steps per second
const SNAP_RATE = 30;         // snapshots per second
const VIEW_W = 1750;          // world units visible across a 16:9 screen at fov 1

const TEAM_IDS = ['de', 'su', 'x'];   // 'x' = neutral (pillbox)
const KINDS = ['shell', 'mg', 'rocket'];
const enemyOf = t => (t === 'de' ? 'su' : 'de');

// ---------- objectives: two attack lines converging on O1 ----------
// Line A: A5 → A4 → A3 → A2 → A1 → O1, line B: B5 → … → B1 → O1. At the start the attacker holds A5 and B5,
// the defender holds O1, everything else is neutral. A side may only fight for a point next to one it holds
// (attackers work up from X5, defenders down from O1); everything else is locked. If the defender takes
// X5, that line is defeated: it locks and its rear assembly area is lost. The attacker wins by taking O1;
// the defender wins when both lines are defeated. A side that has used up all its reserves and has no
// vehicles left on the field also loses.
const ATTACKER = 'de', DEFENDER = 'su';
const CAP_R = 400;                 // capture zone radius
const LINES = ['A', 'B'];
const OBJ = { x: 6300, y: 1700 };  // O1, Prokhorovka
const LINE_START = { A: { x: 900, y: 4400 }, B: { x: 3600, y: 7100 } };
const LINE_BOW = { A: -1, B: 1 };  // which way each line bows out, so the two stay apart
const LINE_NAMES = {
  A: ['Bykovka', 'Yakovlevo', 'Pokrovka', 'Teterevino', 'Oktyabrsky'],
  B: ['Belenikhino', 'Leski', 'Shakhovo', 'Vinogradovka', 'Storozhevoye'],
};
const LINE_T = [0, 0.2, 0.4, 0.6, 0.78];
const CAP_POINTS = [];
for (const L of LINES) {
  const s = LINE_START[L], dx = OBJ.x - s.x, dy = OBJ.y - s.y, len = Math.hypot(dx, dy);
  const px = -dy / len * LINE_BOW[L], py = dx / len * LINE_BOW[L];   // perpendicular, bowing outward
  LINE_T.forEach((t, k) => {
    const bow = 650 * Math.sin(Math.PI * t);
    CAP_POINTS.push({ id: L + (5 - k), name: LINE_NAMES[L][k], line: L, k,
      x: Math.round(s.x + dx * t + px * bow), y: Math.round(s.y + dy * t + py * bow) });
  });
}
CAP_POINTS.push({ id: 'O1', name: 'Prokhorovka', line: null, k: 5, x: OBJ.x, y: OBJ.y });
const O_IDX = CAP_POINTS.length - 1;
// neighbours: prev = toward the attacker's start, next = toward O1
CAP_POINTS.forEach((p, i) => {
  if (p.line) { p.prev = p.k > 0 ? [i - 1] : []; p.next = p.k < 4 ? i + 1 : O_IDX; }
  else { p.prev = CAP_POINTS.filter(q => q.line && q.k === 4).map(q => CAP_POINTS.indexOf(q)); p.next = -1; }
});
// Rear assembly areas: one behind the start of each attack line, one behind O1. No protection, just
// where reinforcements arrive. An attack line's rear is lost when the line is defeated.
const REARS = (() => {
  const out = [];
  for (const L of LINES) {
    const s = LINE_START[L], dx = OBJ.x - s.x, dy = OBJ.y - s.y, len = Math.hypot(dx, dy);
    out.push({ team: ATTACKER, line: L, name: 'Rear ' + L, x: clamp(s.x - dx / len * 700, 450, WORLD - 450), y: clamp(s.y - dy / len * 700, 450, WORLD - 450) });
  }
  out.push({ team: DEFENDER, line: null, name: 'Rear', x: OBJ.x + 650, y: OBJ.y - 650 });
  return out;
})();
const CAP_TIME = 12;               // seconds for one tank to take a point from neutral
const ROUND_END = 30;              // seconds between battles (the only time you can switch sides)

// ---------- reserves ----------
// Every deployment uses one vehicle of its category from the side's reserve pool for the battle.
const CATS = [
  { key: 'lt', name: 'Light tanks', short: 'LT' },
  { key: 'mt', name: 'Medium tanks', short: 'MT' },
  { key: 'ht', name: 'Heavy tanks', short: 'HT' },
  { key: 'td', name: 'Tank destroyers', short: 'TD' },
  { key: 'htd', name: 'Heavy tank destroyers', short: 'HTD' },
];
const RESERVES = {
  de: [60, 200, 60, 100, 40],
  su: [60, 200, 50, 70, 30],
};

// ---------- realism tuning ----------
const RELOAD_MULT = { shell: 3, mg: 1.4, rocket: 2.2 };   // relative to the old arcade timings
const DMG_MULT = { shell: 2.1, mg: 1, rocket: 1.6 };
const TRAVERSE_MULT = 0.6;         // turret / casemate traverse speed
const CASEMATE_ARC = 0.2;          // casemate gun traverse either side of the hull (rad, ~11°)

// world-space size of a client's screen
function viewSize(fov, w, h) {
  const s = Math.max(w, h * 16 / 9) / (VIEW_W * fov);
  return { w: w / s, h: h / s };
}

// ---------- vehicles ----------
function G(o) {
  return Object.assign({ off: 0, ang: 0, len: 1.5, w: 0.28, reload: 1, dmg: 1, spd: 1, pen: 1, size: 1,
    spread: 0.03, delay: 0, recoil: 1, range: 1, kind: 'shell', brake: false, splash: 0 }, o);
}
function rack(n, width, ripple, o) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const off = n === 1 ? 0 : -width / 2 + width * i / (n - 1);
    out.push(G(Object.assign({}, o, { off, delay: (i / n) * ripple })));
  }
  return out;
}
function quad(o) {
  const offs = [-0.15, -0.05, 0.05, 0.15], delays = [0, 0.5, 0.25, 0.75];
  return offs.map((off, i) => G(Object.assign({}, o, { off, delay: delays[i] })));
}
function twin(spacing, o) {
  return [G(Object.assign({}, o, { off: -spacing })), G(Object.assign({}, o, { off: spacing, delay: 0.5 }))];
}

const CLASSES = {};
let FACTION = 'de';
function def(id, o) {
  CLASSES[id] = Object.assign({
    id, faction: FACTION, style: 'tank', hull: [2.0, 1.55], turret: 0.6, turretShape: 'round', turretX: 0,
    caseX: 0, caseW: 1.2, traverse: 3, speed: 1, hp: 1, fov: 1, ram: 1, size: 1,
    guns: [G({})], tier: 0, desc: '',
  }, o);
}

// ---- Germany ----
FACTION = 'de';
def('pz2c', { name: 'Panzer II C', tier: 0, hull: [1.75, 1.35], size: 0.85, turretShape: 'box', turret: 0.46, turretX: 0.05,
  traverse: 4.5, speed: 1.22, hp: 0.7,
  guns: [G({ len: 1.15, w: 0.15, reload: 0.3, dmg: 0.38, spd: 1.1, pen: 0.6, spread: 0.06, recoil: 0.3 })],
  desc: 'Early light tank with a quick-firing 20mm.' });
def('pz38t', { name: 'Panzer 38(t)', tier: 1, hull: [1.85, 1.4], size: 0.9, turretShape: 'box', turret: 0.5, turretX: 0.08,
  traverse: 4.0, speed: 1.18, hp: 0.8,
  guns: [G({ len: 1.3, w: 0.18, reload: 0.5, dmg: 0.6, spd: 1.15, pen: 0.8, spread: 0.05, recoil: 0.5 })],
  desc: 'Czech-built light tank with a 37mm gun.' });
def('luchs', { name: 'Luchs', tier: 1, hull: [1.9, 1.4], size: 0.9, turretShape: 'box', turret: 0.5, turretX: 0.02,
  traverse: 4.6, speed: 1.35, hp: 0.75, fov: 1.15,
  guns: [G({ len: 1.2, w: 0.15, reload: 0.28, dmg: 0.4, spd: 1.15, pen: 0.62, spread: 0.06, recoil: 0.3 })],
  desc: 'Fast reconnaissance tank. Sees far, hits light.' });
def('pz3', { name: 'Panzer III', tier: 0, turretShape: 'box', turret: 0.58, turretX: 0.02, traverse: 3.2,
  guns: [G({ len: 1.45, w: 0.27 })],
  desc: 'Dependable medium tank with a 50mm gun.' });
def('pz4', { name: 'Panzer IV', tier: 1, hull: [2.15, 1.6], turretShape: 'box', turret: 0.62, traverse: 2.8, fov: 1.1,
  guns: [G({ len: 1.9, w: 0.26, dmg: 1.3, spd: 1.2, pen: 1.2, brake: true, range: 1.15 })],
  desc: 'Long 75mm. The workhorse.' });
def('stug', { name: 'StuG III', tier: 1, style: 'casemate', hull: [2.1, 1.6], caseX: 0.05, caseW: 1.2, traverse: 2.0, hp: 1.15,
  guns: [G({ len: 1.55, w: 0.3, dmg: 1.7, pen: 1.3, reload: 1.25, recoil: 1.6, brake: true })],
  desc: 'Casemate assault gun. The whole hull aims.' });
def('hetzer', { name: 'Hetzer', tier: 1, style: 'casemate', hull: [1.95, 1.45], size: 0.92, caseX: -0.05, caseW: 1.15,
  traverse: 1.9, hp: 1.0, speed: 1.0, fov: 1.15,
  guns: [G({ len: 1.75, w: 0.24, dmg: 1.4, spd: 1.25, pen: 1.3, reload: 1.15, range: 1.2, recoil: 1.5 })],
  desc: 'Small, low tank destroyer. Hard to spot, hard to hit.' });
def('jgpz4', { name: 'Jagdpanzer IV', tier: 2, style: 'casemate', hull: [2.15, 1.6], caseX: 0, caseW: 1.4,
  traverse: 1.9, fov: 1.32, hp: 1.2, speed: 0.95,
  guns: [G({ len: 2.3, w: 0.24, dmg: 1.6, spd: 1.55, pen: 1.5, reload: 1.2, range: 1.45, recoil: 1.8 })],
  desc: 'Low-slung tank destroyer with the long 75mm.' });
def('sdkfz', { name: 'Sd.Kfz. 251', tier: 1, style: 'halftrack', hull: [2.2, 1.3], turret: 0.3, turretShape: 'pintle',
  turretX: 0.15, traverse: 6, speed: 1.2, hp: 0.85,
  guns: twin(0.1, { len: 1.25, w: 0.13, reload: 0.3, dmg: 0.36, pen: 0.6, spread: 0.12, kind: 'mg', recoil: 0.2 }), desc: 'Fast halftrack with twin MG 42s.' });
def('tiger', { name: 'Tiger I', tier: 2, hull: [2.3, 1.8], size: 1.1, turretShape: 'box', turret: 0.72, traverse: 1.6,
  hp: 1.6, speed: 0.82, ram: 1.4,
  guns: [G({ len: 1.95, w: 0.33, dmg: 2.1, spd: 1.15, pen: 1.6, reload: 1.45, brake: true, recoil: 2, size: 1.05 })], desc: '88mm heavy. Slow turret, brutal punch.' });
def('panther', { name: 'Panther', tier: 2, hull: [2.3, 1.65], turretShape: 'box', turret: 0.6, traverse: 2.4, fov: 1.28, speed: 1.05,
  guns: [G({ len: 2.3, w: 0.24, dmg: 1.4, spd: 1.55, pen: 1.45, reload: 1.05, brake: true, range: 1.4 })], desc: 'High-velocity 75mm. Long reach.' });
def('ferdinand', { name: 'Ferdinand', tier: 2, style: 'casemate', hull: [2.6, 1.75], size: 1.12, caseX: -0.35, caseW: 1.2,
  traverse: 1.1, fov: 1.42, hp: 1.45, speed: 0.76,
  guns: [G({ len: 2.55, w: 0.26, dmg: 2.7, spd: 1.75, pen: 2.0, reload: 1.8, range: 1.6, recoil: 2.4, brake: true })], desc: 'Heavy tank destroyer. Sniper at extreme range.' });
def('brummbaer', { name: 'Brummbär', tier: 2, style: 'casemate', hull: [2.15, 1.7], caseX: 0.1, caseW: 1.3, traverse: 1.6,
  hp: 1.55, speed: 0.85,
  guns: [G({ len: 1.15, w: 0.5, dmg: 2.6, spd: 0.62, pen: 2.2, reload: 2.0, size: 1.15, recoil: 3, range: 0.95, splash: 1.6 })], desc: '150mm assault howitzer. Shells burst on impact.' });
def('wirbelwind', { name: 'Wirbelwind', tier: 2, hull: [2.15, 1.6], turretShape: 'open', turret: 0.62, traverse: 4.5, speed: 1.05,
  guns: quad({ len: 1.5, w: 0.1, reload: 0.28, dmg: 0.42, pen: 0.7, spread: 0.1, kind: 'mg', recoil: 0.15 }), desc: 'Quad 20mm flak. A wall of lead.' });
def('stukafuss', { name: 'Stuka zu Fuß', tier: 2, style: 'halftrack', hull: [2.2, 1.35], turret: 0.42, turretShape: 'rack',
  turretX: -0.15, traverse: 2.4, speed: 1.12, hp: 0.95,
  guns: rack(6, 0.7, 0.35, { len: 1.0, w: 0.14, reload: 2.4, dmg: 1.1, pen: 1.0, spd: 0.75, spread: 0.12, kind: 'rocket', splash: 0.9, recoil: 0.3, range: 1.2 }), desc: 'Halftrack rocket frames. Ripple-fire volleys.' });
def('tiger2', { name: 'Tiger II', tier: 3, hull: [2.5, 1.85], size: 1.2, turretShape: 'box', turret: 0.74, turretX: 0.05,
  traverse: 1.4, hp: 1.95, speed: 0.74, ram: 1.7,
  guns: [G({ len: 2.35, w: 0.31, dmg: 2.5, spd: 1.35, pen: 1.95, reload: 1.5, brake: true, recoil: 2.2, range: 1.3 })],
  desc: 'King Tiger. Thick hide, long 88.' });
def('jagdpanther', { name: 'Jagdpanther', tier: 3, style: 'casemate', hull: [2.35, 1.7], caseX: -0.05, caseW: 1.5,
  traverse: 1.8, fov: 1.38, speed: 1.0, hp: 1.3,
  guns: [G({ len: 2.35, w: 0.27, dmg: 2.3, spd: 1.7, pen: 1.8, reload: 1.3, brake: true, range: 1.5, recoil: 2 })],
  desc: 'Fast tank destroyer with a long 88.' });
def('jagdtiger', { name: 'Jagdtiger', tier: 3, style: 'casemate', hull: [2.7, 1.85], size: 1.22, caseX: -0.3, caseW: 1.3,
  traverse: 0.95, fov: 1.55, hp: 1.9, speed: 0.66,
  guns: [G({ len: 2.65, w: 0.34, dmg: 3.7, spd: 1.75, pen: 2.6, reload: 2.1, brake: true, range: 1.75, recoil: 3 })],
  desc: '128mm. Nothing survives a clean hit.' });
def('sturmtiger', { name: 'Sturmtiger', tier: 3, style: 'casemate', hull: [2.3, 1.85], size: 1.15, caseX: 0.05, caseW: 1.5,
  traverse: 1.3, hp: 1.9, speed: 0.72,
  guns: [G({ len: 0.85, w: 0.62, dmg: 4.5, spd: 0.55, pen: 3.4, reload: 3.0, size: 1.3, kind: 'rocket', recoil: 2, range: 1.3, splash: 2.6 })],
  desc: '380mm rocket mortar. Flattens everything.' });
def('kugelblitz', { name: 'Kugelblitz', tier: 3, hull: [2.15, 1.6], turretShape: 'ball', turret: 0.58, traverse: 6, speed: 1.08,
  guns: twin(0.09, { len: 1.75, w: 0.14, reload: 0.17, dmg: 0.62, pen: 0.95, spread: 0.07, kind: 'mg', recoil: 0.2 }),
  desc: 'Twin 30mm cannons in a ball turret.' });
def('panzerwerfer', { name: 'Panzerwerfer 42', tier: 3, style: 'halftrack', hull: [2.3, 1.4], turret: 0.5, turretShape: 'rack',
  turretX: -0.15, traverse: 2.2, speed: 1.08, hp: 1.05,
  guns: rack(10, 0.8, 0.45, { len: 1.05, w: 0.11, reload: 2.7, dmg: 1.25, pen: 1.1, spd: 0.8, spread: 0.11, kind: 'rocket', splash: 1.0, recoil: 0.25, range: 1.3 }),
  desc: 'Ten-tube launcher. Saturate the area.' });

// ---- Soviet Union ----
FACTION = 'su';
def('t26', { name: 'T-26', tier: 0, hull: [1.85, 1.4], size: 0.9, turretShape: 'round', turret: 0.5, turretX: 0.05,
  traverse: 3.8, speed: 1.0, hp: 0.8,
  guns: [G({ len: 1.3, w: 0.19, reload: 0.48, dmg: 0.55, spd: 1.1, pen: 0.78, spread: 0.05, recoil: 0.5 })],
  desc: 'Pre-war light infantry tank with a 45mm gun.' });
def('bt7', { name: 'BT-7', tier: 1, hull: [2.0, 1.4], size: 0.92, turretShape: 'round', turret: 0.52, turretX: 0.1,
  traverse: 4.0, speed: 1.4, hp: 0.75,
  guns: [G({ len: 1.35, w: 0.19, reload: 0.46, dmg: 0.56, spd: 1.12, pen: 0.8, spread: 0.05, recoil: 0.5 })],
  desc: 'Fast tank. Outruns anything on the steppe.' });
def('t34', { name: 'T-34/76', tier: 0, turretShape: 'hex', turret: 0.58, turretX: 0.18, traverse: 2.8, speed: 1.05,
  guns: [G({ len: 1.45, w: 0.29 })],
  desc: 'Sloped armor, wide tracks. Backbone of the Red Army.' });
def('t28', { name: 'T-28', tier: 1, hull: [2.4, 1.6], size: 1.05, turretShape: 'round', turret: 0.6, turretX: 0.05,
  traverse: 2.6, speed: 0.88, hp: 1.15,
  guns: [G({ len: 1.3, w: 0.3, dmg: 1.1, spd: 0.95, pen: 0.95, reload: 1.1, recoil: 1.2 })],
  desc: 'Multi-turret medium. Short 76mm and two MG turrets.' });
def('kv1s', { name: 'KV-1S', tier: 1, hull: [2.15, 1.7], turretShape: 'hex', turret: 0.65, turretX: 0.05, traverse: 2.4,
  hp: 1.3, speed: 0.92, ram: 1.2,
  guns: [G({ len: 1.6, w: 0.3, dmg: 1.35, spd: 1.1, pen: 1.15 })],
  desc: 'Heavy tank. Soaks hits, hits back.' });
def('su122', { name: 'SU-122', tier: 1, style: 'casemate', hull: [2.05, 1.6], caseX: 0.15, caseW: 1.2, traverse: 2.0, hp: 1.12,
  guns: [G({ len: 1.3, w: 0.4, dmg: 1.9, pen: 1.5, spd: 0.8, reload: 1.55, recoil: 2, size: 1.05, splash: 1.0 })], desc: '122mm assault howitzer. Bursting shells.' });
def('su76', { name: 'SU-76', tier: 1, style: 'casemate', hull: [2.0, 1.4], size: 0.9, caseX: -0.25, caseW: 1.0,
  traverse: 2.4, speed: 1.12, hp: 0.85, fov: 1.15,
  guns: [G({ len: 1.85, w: 0.24, dmg: 1.3, spd: 1.3, pen: 1.2, reload: 1.05, range: 1.2, recoil: 1.4 })],
  desc: 'Light self-propelled gun with the ZiS-3 76mm.' });
def('t70', { name: 'T-70', tier: 1, hull: [1.85, 1.4], size: 0.92, turret: 0.5, turretShape: 'hex', turretX: -0.05,
  traverse: 4.2, speed: 1.25, hp: 0.82,
  guns: [G({ len: 1.35, w: 0.2, reload: 0.42, dmg: 0.55, spd: 1.15, pen: 0.8, spread: 0.05, recoil: 0.5 })], desc: 'Light tank. Fast, quick-firing 45mm.' });
def('kv85', { name: 'KV-85', tier: 2, hull: [2.25, 1.75], size: 1.08, turretShape: 'round', turret: 0.7, traverse: 1.9,
  hp: 1.7, speed: 0.84, ram: 1.4,
  guns: [G({ len: 1.95, w: 0.31, dmg: 2.0, spd: 1.2, pen: 1.6, reload: 1.4, recoil: 2 })], desc: '85mm heavy. Built to break Tigers.' });
def('t3485', { name: 'T-34-85', tier: 2, hull: [2.1, 1.6], turretShape: 'round', turret: 0.64, turretX: 0.12, traverse: 2.6,
  fov: 1.22, speed: 1.1, hp: 1.1,
  guns: [G({ len: 2.05, w: 0.26, dmg: 1.35, spd: 1.45, pen: 1.4, reload: 1.05, range: 1.35 })], desc: 'Upgunned T-34. Fast and far-reaching.' });
def('su152', { name: 'SU-152', tier: 2, style: 'casemate', hull: [2.3, 1.75], size: 1.08, caseX: 0, caseW: 1.4, traverse: 1.4,
  hp: 1.55, speed: 0.82,
  guns: [G({ len: 1.55, w: 0.46, dmg: 3.0, pen: 2.3, spd: 0.85, reload: 2.0, recoil: 3, size: 1.1, splash: 1.4, brake: true })], desc: '"Zveroboy" — the beast killer.' });
def('su85', { name: 'SU-85', tier: 2, style: 'casemate', hull: [2.1, 1.6], caseX: 0.1, caseW: 1.2, traverse: 1.7, fov: 1.38,
  hp: 1.2, speed: 1.0,
  guns: [G({ len: 2.3, w: 0.26, dmg: 2.2, spd: 1.65, pen: 1.8, reload: 1.45, range: 1.55, recoil: 2 })], desc: 'Tank destroyer. Long-range 85mm.' });
def('zsu37', { name: 'ZSU-37', tier: 2, hull: [1.95, 1.45], turretShape: 'open', turret: 0.58, traverse: 5, speed: 1.18, hp: 0.95,
  guns: [G({ len: 1.75, w: 0.15, reload: 0.15, dmg: 0.5, pen: 0.8, spread: 0.09, kind: 'mg', recoil: 0.2, brake: true })], desc: '37mm autocannon. An endless stream of fire.' });
def('katyusha', { name: 'Katyusha', tier: 2, style: 'truck', hull: [2.3, 1.3], turret: 0.5, turretShape: 'rack', turretX: -0.25,
  traverse: 2.2, speed: 1.1, hp: 0.9,
  guns: rack(8, 0.8, 0.4, { len: 1.2, w: 0.1, reload: 2.6, dmg: 1.15, pen: 1.0, spd: 0.78, spread: 0.13, kind: 'rocket', splash: 1.0, recoil: 0.2, range: 1.25 }), desc: 'BM-13 rocket truck. Stalin’s organ.' });
def('is2', { name: 'IS-2', tier: 3, hull: [2.45, 1.85], size: 1.18, turretShape: 'round', turret: 0.72, turretX: 0.1, traverse: 1.5,
  hp: 1.95, speed: 0.78, ram: 1.7,
  guns: [G({ len: 2.1, w: 0.38, dmg: 3.0, spd: 1.25, pen: 2.1, reload: 1.85, brake: true, recoil: 2.6, size: 1.08 })],
  desc: '122mm heavy breakthrough tank.' });
def('isu152', { name: 'ISU-152', tier: 3, style: 'casemate', hull: [2.5, 1.85], size: 1.2, caseX: 0.05, caseW: 1.5, traverse: 1.2,
  hp: 2.0, speed: 0.72,
  guns: [G({ len: 1.8, w: 0.52, dmg: 4.4, pen: 3.0, spd: 0.9, reload: 2.6, recoil: 3.4, size: 1.2, splash: 1.9, brake: true })],
  desc: '152mm on a heavy hull. Cracks anything.' });
def('su100', { name: 'SU-100', tier: 3, style: 'casemate', hull: [2.3, 1.65], caseX: 0.1, caseW: 1.25, traverse: 1.6, fov: 1.52,
  hp: 1.45, speed: 0.98,
  guns: [G({ len: 2.55, w: 0.28, dmg: 3.0, spd: 1.8, pen: 2.3, reload: 1.75, range: 1.7, recoil: 2.6 })],
  desc: '100mm sniper. Reaches across the steppe.' });
def('m17', { name: 'M17 MGMC', tier: 3, style: 'halftrack', hull: [2.25, 1.35], turret: 0.45, turretShape: 'open', turretX: -0.1,
  traverse: 6.5, speed: 1.22, hp: 0.95,
  guns: quad({ len: 1.45, w: 0.09, reload: 0.2, dmg: 0.42, pen: 0.75, spread: 0.09, kind: 'mg', recoil: 0.1 }),
  desc: 'Lend-Lease quad .50 cal halftrack.' });
def('bm31', { name: 'BM-31-12', tier: 3, style: 'truck', hull: [2.4, 1.35], turret: 0.55, turretShape: 'rack', turretX: -0.25,
  traverse: 2.0, speed: 1.06, hp: 1.0,
  guns: rack(12, 0.9, 0.45, { len: 1.15, w: 0.1, reload: 3.0, dmg: 1.6, pen: 1.3, spd: 0.75, spread: 0.13, kind: 'rocket', splash: 1.3, recoil: 0.25, range: 1.3 }),
  desc: '300mm rockets. The big organ.' });

const START_CLASS = { de: 'pz3', su: 't34' };
const CLASS_IDS = Object.keys(CLASSES);
CLASS_IDS.forEach((id, i) => { CLASSES[id].idx = i; });

// ---------- secondary machine guns (right mouse button) ----------
// Every MG that can bear on the cursor fires. Rifle-calibre MGs are for soft targets: halftracks,
// trucks, rear plates, supplies.
const MG_TYPES = {
  mg34: { name: 'MG 34', dmg: 0.22, pen: 0.5, reload: 0.09, spread: 0.07, spd: 1.15, range: 0.85 },
  dt:   { name: 'DT',    dmg: 0.2,  pen: 0.5, reload: 0.1,  spread: 0.07, spd: 1.15, range: 0.85 },
  dshk: { name: 'DShK',  dmg: 0.38, pen: 0.9, reload: 0.13, spread: 0.06, spd: 1.2,  range: 0.95 },
};
// Mount fields: f = frame it rides on ('hull', or 'turret' = turret / casemate superstructure),
// x/y = position in tank radii within that frame (+x forward, +y right), b = rest bearing relative
// to the frame, arc = traverse either side of b (PI = free-swinging pintle), len = barrel length.
const BOW = (t, c, o) => Object.assign({ pos: 'bow', f: 'hull', x: c.hull[0] * 0.42, y: c.hull[1] * 0.2, b: 0, arc: 0.44, len: 0.32, ball: true, t }, o);
const REARMG = (t, c) => ({ pos: 'rear turret', f: 'turret', x: -c.turret * 0.95, y: 0.08, b: Math.PI, arc: 0.35, len: 0.3, ball: true, t });
const ROOF = (t, x, y) => ({ pos: 'roof', f: 'turret', x, y, b: 0, arc: Math.PI, len: 0.7, ball: false, t });
const MG_FIT = {
  pz3:         c => [BOW('mg34', c)],
  pz4:         c => [BOW('mg34', c), ROOF('mg34', -0.32, 0.3)],
  stug:        c => [ROOF('mg34', -0.15, 0.3)],
  pz38t:       c => [BOW('mg34', c)],
  hetzer:      c => [ROOF('mg34', -0.1, 0.3)],
  tiger:       c => [BOW('mg34', c), ROOF('mg34', -0.32, -0.36)],
  panther:     c => [BOW('mg34', c), ROOF('mg34', -0.25, -0.3)],
  tiger2:      c => [BOW('mg34', c), ROOF('mg34', -0.32, -0.34)],
  brummbaer:   c => [BOW('mg34', c), ROOF('mg34', -0.3, 0.36)],
  jagdpanther: c => [BOW('mg34', c)],
  jagdtiger:   c => [BOW('mg34', c)],
  sturmtiger:  c => [BOW('mg34', c)],
  t34:         c => [BOW('dt', c)],
  t28:         c => [BOW('dt', c, { pos: 'left MG turret', x: c.hull[0] * 0.3, y: -c.hull[1] * 0.28, arc: 1.6 }),
                     BOW('dt', c, { pos: 'right MG turret', x: c.hull[0] * 0.3, y: c.hull[1] * 0.28, arc: 1.6 })],
  t3485:       c => [BOW('dt', c)],
  kv1s:        c => [BOW('dt', c), REARMG('dt', c)],
  kv85:        c => [BOW('dt', c), REARMG('dt', c)],
  is2:         c => [REARMG('dt', c), ROOF('dshk', -0.36, 0.3)],
  isu152:      c => [ROOF('dshk', -0.3, 0.4)],
};
for (const id in MG_FIT) CLASSES[id].mgs = MG_FIT[id](CLASSES[id]).map(m => Object.assign({}, MG_TYPES[m.t], m));
// short card/HUD description, e.g. "Bow MG 34, roof MG 34"
function mgSummary(c) {
  if (!c.mgs) return '';
  const s = c.mgs.map(m => `${m.pos} ${m.name}`).join(', ');
  return s[0].toUpperCase() + s.slice(1) + '.';
}

// ---------- steering ----------
// neutral: regenerative/electric transmissions that can counter-rotate the tracks and pivot on the spot.
// clutch:  clutch-brake / simple planetary steering; stationary they can only swing around one braked track.
// wheel:   halftracks and trucks steer with front wheels, so they must be rolling to turn at all.
const NEUTRAL_STEER = ['tiger', 'tiger2', 'panther', 'jagdpanther', 'jagdtiger', 'sturmtiger', 'ferdinand'];
for (const id of CLASS_IDS) {
  const c = CLASSES[id];
  c.steer = NEUTRAL_STEER.includes(id) ? 'neutral' : c.style === 'halftrack' || c.style === 'truck' ? 'wheel' : 'clutch';
}
const STEER_INFO = {
  neutral: 'Neutral steer: pivots in place.',
  clutch: 'Clutch-brake steering: slow pivot when stopped.',
  wheel: 'Wheeled steering: must be moving to turn.',
};

// ---------- hamlets: static, indestructible cover ----------
// Generated from a fixed seed, so the server and every client build the same villages. Each building is an
// oriented rectangle {x, y, w, h, a} that blocks vehicles, crates and shells.
const BUILDINGS = [], HAMLETS = [];
(function genHamlets() {
  let seed = 1943;
  const rnd = (a, b) => { seed = (seed * 16807) % 2147483647; return a + (seed / 2147483647) * (b - a); };
  // keep at least a tank's width of driveable gap between any two buildings
  const fits = b => BUILDINGS.every(o => Math.hypot(o.x - b.x, o.y - b.y) > o.br + b.br + 70);
  function hamlet(cx, cy, big, name) {
    const ang = rnd(0, Math.PI), n = big ? 9 + (rnd(0, 4) | 0) : 4 + (rnd(0, 4) | 0);
    const len = big ? 760 : 460;
    const h = { x: cx, y: cy, a: ang, len, name, big, b0: BUILDINGS.length };
    const streets = [ang];
    if (big || rnd(0, 1) < 0.3) streets.push(ang + Math.PI / 2 + rnd(-0.3, 0.3));
    h.streets = streets;
    if (name === 'Prokhorovka') {   // the church on the square
      const b = { x: cx + Math.cos(ang + 0.8) * 150, y: cy + Math.sin(ang + 0.8) * 150, w: 155, h: 96, a: ang, kind: 'church', s: 0.5 };
      b.br = Math.hypot(b.w, b.h) / 2; BUILDINGS.push(b);
    }
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
      if (b.x < 200 || b.y < 200 || b.x > WORLD - 200 || b.y > WORLD - 200 || !fits(b)) continue;
      BUILDINGS.push(b); placed++;
    }
    h.b1 = BUILDINGS.length; HAMLETS.push(h);
  }
  CAP_POINTS.forEach(p => hamlet(p.x, p.y, true, p.name));
  // smaller farmsteads scattered along and between the two attack lines
  const segs = [];
  for (const L of LINES) {
    const pts = CAP_POINTS.filter(p => p.line === L).concat([OBJ]);
    for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
  }
  const segDist = (x, y, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, t = clamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
    return Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
  };
  let tries = 0;
  while (HAMLETS.length < CAP_POINTS.length + 24 && tries++ < 6000) {
    const x = rnd(450, WORLD - 450), y = rnd(450, WORLD - 450);
    if (Math.min(...segs.map(([a, b]) => segDist(x, y, a, b))) > 1800) continue;
    if (HAMLETS.some(h => Math.hypot(h.x - x, h.y - y) < (h.big ? 1000 : 750))) continue;
    if (REARS.some(r => Math.hypot(r.x - x, r.y - y) < 1000)) continue;
    hamlet(x, y, false, null);
  }
})();
// spatial grid so collision queries only look at nearby buildings
const BCELL = 400, BGN = Math.ceil(WORLD / BCELL);
const BGRID = Array.from({ length: BGN * BGN }, () => []);
BUILDINGS.forEach((b, i) => {
  b.i = i; b.ca = Math.cos(b.a); b.sa = Math.sin(b.a);
  const c = v => clamp((v / BCELL) | 0, 0, BGN - 1);
  for (let y = c(b.y - b.br); y <= c(b.y + b.br); y++) for (let x = c(b.x - b.br); x <= c(b.x + b.br); x++) BGRID[y * BGN + x].push(b);
});
let bStamp = 0;
function forBuildings(x0, y0, x1, y1, fn) {
  bStamp++;
  const c = v => clamp((v / BCELL) | 0, 0, BGN - 1);
  for (let y = c(y0); y <= c(y1); y++) for (let x = c(x0); x <= c(x1); x++) {
    for (const b of BGRID[y * BGN + x]) {
      if (b._s === bStamp) continue;
      b._s = bStamp;
      if (fn(b)) return true;
    }
  }
  return false;
}
// push a circle (anything with x, y and optionally vx, vy) out of buildings; returns true on contact
function bldCollide(o, r) {
  let hit = false;
  forBuildings(o.x - r, o.y - r, o.x + r, o.y + r, b => {
    const dx = o.x - b.x, dy = o.y - b.y;
    const lx = dx * b.ca + dy * b.sa, ly = -dx * b.sa + dy * b.ca, hw = b.w / 2, hh = b.h / 2;
    let nx, ny, pen;
    if (Math.abs(lx) < hw && Math.abs(ly) < hh) {
      const px = hw - Math.abs(lx), py = hh - Math.abs(ly);
      if (px < py) { nx = Math.sign(lx) || 1; ny = 0; pen = px + r; } else { nx = 0; ny = Math.sign(ly) || 1; pen = py + r; }
    } else {
      const ex = lx - clamp(lx, -hw, hw), ey = ly - clamp(ly, -hh, hh), d2 = ex * ex + ey * ey;
      if (d2 >= r * r) return false;
      const d = Math.sqrt(d2) || 1; nx = ex / d; ny = ey / d; pen = r - d;
    }
    const wx = nx * b.ca - ny * b.sa, wy = nx * b.sa + ny * b.ca;
    o.x += wx * pen; o.y += wy * pen;
    if (o.vx !== undefined) { const vn = o.vx * wx + o.vy * wy; if (vn < 0) { o.vx -= vn * wx; o.vy -= vn * wy; } }
    hit = true;
    return false;
  });
  return hit;
}
// does a circle overlap any building?
function bldHit(x, y, r) {
  return forBuildings(x - r, y - r, x + r, y + r, b => {
    const dx = x - b.x, dy = y - b.y;
    const lx = dx * b.ca + dy * b.sa, ly = -dx * b.sa + dy * b.ca;
    const ex = Math.max(0, Math.abs(lx) - b.w / 2), ey = Math.max(0, Math.abs(ly) - b.h / 2);
    return ex * ex + ey * ey < r * r;
  });
}
// where along the segment (0..1) does it first enter building b? -1 if it misses
function segEnter(b, x0, y0, x1, y1) {
  const ax = x0 - b.x, ay = y0 - b.y, bx = x1 - b.x, by = y1 - b.y;
  const p0 = ax * b.ca + ay * b.sa, q0 = -ax * b.sa + ay * b.ca;
  const dp = (bx * b.ca + by * b.sa) - p0, dq = (-bx * b.sa + by * b.ca) - q0;
  let t0 = 0, t1 = 1;
  for (const [p, d, h] of [[p0, dp, b.w / 2], [q0, dq, b.h / 2]]) {
    if (Math.abs(d) < 1e-9) { if (Math.abs(p) > h) return -1; continue; }
    let ta = (-h - p) / d, tb = (h - p) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return -1;
  }
  return t0;
}
// is the straight line between two points blocked by a building?
function bldLine(x0, y0, x1, y1) {
  return forBuildings(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), b => segEnter(b, x0, y0, x1, y1) >= 0);
}
// fraction (0..1) of the way along the segment where the first building is hit; 1 if it's clear
function bldRay(x0, y0, x1, y1) {
  let best = 1;
  forBuildings(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), b => {
    const t = segEnter(b, x0, y0, x1, y1);
    if (t >= 0 && t < best) best = t;
    return false;
  });
  return best;
}

// ---------- ranks (cosmetic insignia next to names) ----------
// Bots carry the rank in their name; players start as an NCO tank commander and are promoted as their
// score in the current battle grows.
const RANKS = {
  de: [['Gfr.', 'Gefreiter'], ['Ogfr.', 'Obergefreiter'], ['Uffz.', 'Unteroffizier'], ['Fw.', 'Feldwebel'],
       ['Lt.', 'Leutnant'], ['Oblt.', 'Oberleutnant'], ['Hptm.', 'Hauptmann']],
  su: [['Ml. Sgt.', 'Mladshiy Serzhant'], ['Sgt.', 'Serzhant'], ['St. Sgt.', 'Starshiy Serzhant'], ['Stshn.', 'Starshina'],
       ['Lt.', 'Leytenant'], ['St. Lt.', 'Starshiy Leytenant'], ['Kpt.', 'Kapitan']],
};
const RANK_SCORE = [Infinity, Infinity, 0, 300, 800, 1600, 3000];
function rankForScore(s) { let r = 2; for (let i = 3; i < RANK_SCORE.length; i++) if (s >= RANK_SCORE[i]) r = i; return r; }

// ---------- roles (vehicle picker grouping) ----------
const ROLES = ['Light tank', 'Medium tank', 'Heavy tank', 'Tank destroyer', 'Assault gun', 'Assault mortar', 'Anti-aircraft', 'Halftrack', 'Rocket artillery'];
const ROLE = {
  pz3: 1, pz4: 1, panther: 1, t34: 1, t3485: 1, t28: 1, t70: 0, pz2c: 0, pz38t: 0, luchs: 0, t26: 0, bt7: 0,
  tiger: 2, tiger2: 2, kv1s: 2, kv85: 2, is2: 2,
  ferdinand: 3, jagdpanther: 3, jagdtiger: 3, su85: 3, su100: 3, hetzer: 3, jgpz4: 3, su76: 3,
  stug: 4, brummbaer: 4, su122: 4, su152: 4, isu152: 4, sturmtiger: 5,
  wirbelwind: 6, kugelblitz: 6, zsu37: 6, m17: 6, sdkfz: 7,
  stukafuss: 8, panzerwerfer: 8, katyusha: 8, bm31: 8,
};
for (const id of CLASS_IDS) { CLASSES[id].roleIdx = ROLE[id]; CLASSES[id].role = ROLES[ROLE[id]]; }
// reserve category (index into CATS)
const CAT = {
  t70: 0, pz2c: 0, pz38t: 0, luchs: 0, t26: 0, bt7: 0,
  pz3: 1, pz4: 1, panther: 1, t34: 1, t3485: 1, t28: 1,
  tiger: 2, tiger2: 2, kv1s: 2, kv85: 2, is2: 2,
  stug: 3, hetzer: 3, jgpz4: 3, su76: 3, su85: 3, su100: 3,
  ferdinand: 4, jagdpanther: 4, brummbaer: 4, jagdtiger: 4, su122: 4, su152: 4, isu152: 4,
};
for (const id of CLASS_IDS) CLASSES[id].cat = CAT[id] !== undefined ? CAT[id] : -1;
// For now only gun vehicles are in play: anything whose main armament is all MGs / autocannon or rockets
// (flak, halftracks, rocket launchers, Sturmtiger) is switched off. Flip this to bring them back.
const GUNS_ONLY = true;
for (const id of CLASS_IDS) {
  const c = CLASSES[id];
  c.enabled = (!GUNS_ONLY || c.guns.some(g => g.kind === 'shell')) && c.cat >= 0;
}

// ---------- obstacles ----------
const OB = {
  crate:  { r: 19, hp: 22,   body: 14, mass: 1.2, resist: 4 },
  drum:   { r: 16, hp: 36,   body: 18, mass: 1.2, resist: 6, explosive: true },
  depot:  { r: 40, hp: 240,  body: 32, mass: 5,   resist: 14 },
  bunker: { r: 80, hp: 3600, body: 70, mass: Infinity, resist: 30, gun: true },
};
const OB_TYPES = Object.keys(OB);

const Z = {
  TAU, rand, pick, clamp, lerp, angDiff, turnToward, lerpAngle,
  WORLD, CENTER, REARS, TEAM_SIZE, TICK_RATE, SNAP_RATE, VIEW_W,
  TEAM_IDS, KINDS, enemyOf, viewSize,
  BUILDINGS, HAMLETS, bldCollide, bldHit, bldLine, bldRay,
  CLASSES, CLASS_IDS, START_CLASS, OB, OB_TYPES,
  ATTACKER, DEFENDER, CAP_R, CAP_POINTS, O_IDX, LINES, CAP_TIME, ROUND_END, CATS, RESERVES,
  RELOAD_MULT, DMG_MULT, TRAVERSE_MULT, CASEMATE_ARC, STEER_INFO, mgSummary, ROLES, RANKS, rankForScore,
};
if (typeof module !== 'undefined' && module.exports) module.exports = Z;
else root.Z = Z;
})(typeof self !== 'undefined' ? self : this);
