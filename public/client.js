/* ZITADELLE — browser client: input, interpolation, rendering, UI. The server owns the game state. */
(() => {
'use strict';
const {
  TAU, rand, pick, clamp, lerp, angDiff, lerpAngle,
  WORLD, CENTER, REARS, BUILDINGS, HAMLETS, O_IDX, LINES, CATS, RESERVES,
  CLASSES, CLASS_IDS, START_CLASS, OB, OB_TYPES, TEAM_IDS, KINDS, VIEW_W,
  CAP_POINTS, CAP_R, ATTACKER, DEFENDER,
} = Z;

const INTERP_DELAY = 0.1;   // seconds behind the newest snapshot we render
const INPUT_RATE = 1 / 30;

// =====================================================================
// Helpers
// =====================================================================
const rgbCache = new Map();
function hexRgb(h) {
  let v = rgbCache.get(h);
  if (!v) { const n = parseInt(h.slice(1), 16); v = [n >> 16, (n >> 8) & 255, n & 255]; rgbCache.set(h, v); }
  return v;
}
function mix(a, b, t) {
  if (t <= 0) return a;
  const A = hexRgb(a), B = hexRgb(b);
  return `rgb(${A[0] + (B[0] - A[0]) * t | 0},${A[1] + (B[1] - A[1]) * t | 0},${A[2] + (B[2] - A[2]) * t | 0})`;
}
function fmt(n) {
  n = Math.floor(n);
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function rrect(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function polyPath(c, pts) {
  c.beginPath();
  c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.closePath();
}
function ngon(c, n, R, rot = 0) {
  c.beginPath();
  for (let i = 0; i < n; i++) { const a = rot + i * TAU / n; c.lineTo(Math.cos(a) * R, Math.sin(a) * R); }
  c.closePath();
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const clsByIdx = i => CLASSES[CLASS_IDS[i]];

const TEAMS = {
  de: { id: 'de', name: 'Germany', body: '#737e87', dark: '#444c52', barrel: '#5d666d', top: '#7f8a93',
        bullet: '#ece8d4', mini: '#a7b8c4', tint: 'rgba(60,74,86,0.20)', label: 'GERMANY' },
  su: { id: 'su', name: 'Soviet Union', body: '#5f7738', dark: '#374520', barrel: '#4c5f2c', top: '#6a8340',
        bullet: '#f2c95c', mini: '#9cc05a', tint: 'rgba(150,40,30,0.13)', label: 'SOVIET UNION' },
  x: { id: 'x', bullet: '#e3e1d9', dark: '#555555' },
  wreck: { id: 'wreck', body: '#3d3832', dark: '#211e1a', barrel: '#2f2b27', top: '#46403a' },
};

// =====================================================================
// Music: public/music/victory-{de,su}.mp3 and intro-{de,su}.mp3 (or .ogg/.wav/.m4a), if present
// =====================================================================
// intro songs are switched off for now (files and code stay in); flip to bring them back
const INTRO_ENABLED = false;
const Music = (() => {
  let files = {}, cur = null, fadeT = null, muted = false;
  fetch('music.json').then(r => r.json()).then(j => { files = j || {}; }).catch(() => {});
  const stop = () => { if (cur) { cur.pause(); cur = null; } clearInterval(fadeT); };
  return {
    // kind = 'victory' | 'intro'
    play(kind, side) {
      if (kind === 'intro' && !INTRO_ENABLED) return false;
      const src = files[`${kind}-${side}`];
      if (!src) return false;
      stop();
      cur = new Audio(src);
      cur.volume = 0.7; cur.muted = muted;
      cur.play().catch(() => {});
      return true;
    },
    // let the song ring out, then fade it over a few seconds once the next battle starts
    fadeOut(secs = 4) {
      if (!cur) return;
      const a = cur, v0 = a.volume, t0 = performance.now();
      clearInterval(fadeT);
      fadeT = setInterval(() => {
        const k = 1 - (performance.now() - t0) / (secs * 1000);
        if (k <= 0) { a.pause(); if (cur === a) cur = null; clearInterval(fadeT); } else a.volume = v0 * k;
      }, 50);
    },
    setMuted(m) { muted = m; if (cur) cur.muted = m; },
  };
})();

// =====================================================================
// Canvas + input
// =====================================================================
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  send({ t: 'view', w: W, h: H });
}
addEventListener('resize', resize);

const keys = new Set();
const mouse = { x: innerWidth / 2, y: innerHeight / 2, down: false };
let autofire = false;
let state = 'menu'; // menu | play | dead
let devMode = false;
// Zoom: the scroll wheel zooms in (never out past the normal view). Shift toggles the gunner's sight: a
// magnified view centred on where you were aiming, which pans when the cursor is pushed to the edge.
const view2 = { zoom: 1, sight: false, sightZoom: 2.5, offX: 0, offY: 0 };
const ZOOM_MAX = 2.5, SIGHT_MIN = 1.6, SIGHT_MAX = 6;
const SIGHT_ENABLED = false;   // gunner's sight is switched off for now; flip to bring Shift back
const baseScale = () => Math.max(W, H * 16 / 9) / (VIEW_W * (you ? you.fov : 1.1));
function setSight(on) {
  const me = myTank();
  if (on && !me) return;
  view2.sight = on;
  if (on) {
    // keep the point under the cursor where it is: centre the sight so that point stays under the mouse
    const s1 = baseScale() * view2.sightZoom;
    const wx = cam.x + (mouse.x - W / 2) / cam.scale, wy = cam.y + (mouse.y - H / 2) / cam.scale;
    view2.offX = wx - (mouse.x - W / 2) / s1 - me.x;
    view2.offY = wy - (mouse.y - H / 2) / s1 - me.y;
  }
  bigMessage(on ? `Gunner's sight  ×${view2.sightZoom.toFixed(1)}` : 'Commander view', 1);
}

addEventListener('keydown', e => {
  if (state !== 'play' || e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === 'f' && !e.repeat) { autofire = !autofire; bigMessage(autofire ? 'Autofire ON' : 'Autofire OFF', 1.2); }
  if (k === 'm' && !e.repeat) { Sound.toggle(); bigMessage(Sound.muted ? 'Sound OFF' : 'Sound ON', 1.2); }
  if (SIGHT_ENABLED && k === 'shift' && !e.repeat) setSight(!view2.sight);
  if (k === 't' && !e.repeat) switchSides();
  if (k.startsWith('arrow') || k === ' ') e.preventDefault();
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => { keys.clear(); mouse.down = mouse.rdown = false; });
canvas.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
canvas.addEventListener('mousedown', e => {
  if (e.button === 0) mouse.down = true;
  if (e.button === 2) {
    mouse.rdown = true;
    if (state === 'play' && you && !clsByIdx(you.c).mgs) bigMessage('This vehicle has no machine guns', 1.5);
  }
  Sound.init();
});
addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; if (e.button === 2) mouse.rdown = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (state !== 'play') return;
  const f = Math.pow(1.15, -Math.sign(e.deltaY));
  if (view2.sight) view2.sightZoom = clamp(view2.sightZoom * f, SIGHT_MIN, SIGHT_MAX);
  else view2.zoom = clamp(view2.zoom * f, 1, ZOOM_MAX);
}, { passive: false });

// =====================================================================
// Sound (procedural, WebAudio)
// =====================================================================
// Every gunshot is layered: supersonic crack + driven muzzle blast + sub-bass concussion + a rolling
// echo off the steppe. Distance filters out the highs, delays arrival and pushes more into the reverb,
// so a far-off 88 is a dull, late thud and one next to you is a slap in the chest.
const Sound = (() => {
  let ac = null, noise = null, master = null, verbIn = null, budget = 0, engine = null;
  const api = { muted: false };
  const curve = (() => { const n = 1024, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(x * 3.2); } return c; })();

  function impulse(secs, decay) {
    const len = Math.floor(ac.sampleRate * secs), buf = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); let lp = 0;
      for (let i = 0; i < len; i++) {
        lp += (Math.random() * 2 - 1 - lp) * 0.18;            // darken the tail: open-field echo, not a hall
        d[i] = lp * Math.pow(1 - i / len, decay) * (i < ac.sampleRate * 0.012 ? 0 : 1);
      }
    }
    return buf;
  }
  api.init = () => {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 5; comp.attack.value = 0.002; comp.release.value = 0.3;
      comp.connect(ac.destination);
      master = ac.createGain(); master.gain.value = api.muted ? 0 : 0.85; master.connect(comp);
      const verb = ac.createConvolver(); verb.buffer = impulse(3.4, 2.6);
      verbIn = ac.createGain(); verbIn.gain.value = 0.55; verbIn.connect(verb); verb.connect(master);
      const len = ac.sampleRate * 2;
      noise = ac.createBuffer(1, len, ac.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { ac = null; }
  };
  api.toggle = () => {
    api.muted = !api.muted;
    if (master) master.gain.setTargetAtTime(api.muted ? 0 : 0.85, ac.currentTime, 0.05);
    Music.setMuted(api.muted);
  };
  api.tick = () => { budget = 0; };

  // ---- voice building blocks ----
  function voice(vol, dn, delay) {
    const t = ac.currentTime + 0.005 + delay;
    const out = ac.createGain(); out.gain.value = vol;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700 + 17000 * Math.pow(1 - dn, 2.4);
    out.connect(lp); lp.connect(master);
    const wet = ac.createGain(); wet.gain.value = 0.3 + 0.9 * dn;
    lp.connect(wet); wet.connect(verbIn);
    return { out, t };
  }
  function env(g, t, peak, atk, dec) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + atk + dec);
  }
  function nz(o, type, f0, f1, sweep, peak, atk, dec, drive, at = 0) {
    const t = o.t + at;
    const s = ac.createBufferSource(); s.buffer = noise; s.loop = true;
    const f = ac.createBiquadFilter(); f.type = type; f.Q.value = type === 'bandpass' ? 1.2 : 0.7;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + sweep);
    const g = ac.createGain(); env(g, t, peak, atk, dec);
    s.connect(f);
    if (drive) { const ws = ac.createWaveShaper(); ws.curve = curve; f.connect(ws); ws.connect(g); } else f.connect(g);
    g.connect(o.out);
    s.start(t, Math.random() * 1.5); s.stop(t + atk + dec + 0.05);
  }
  function osc(o, type, f0, f1, sweep, peak, atk, dec, at = 0) {
    const t = o.t + at;
    const s = ac.createOscillator(); s.type = type;
    s.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) s.frequency.exponentialRampToValueAtTime(f1, t + sweep);
    const g = ac.createGain(); env(g, t, peak, atk, dec);
    s.connect(g); g.connect(o.out);
    s.start(t); s.stop(t + atk + dec + 0.05);
  }

  // ---- sound recipes ----
  const R = {
    // tank guns; S scales weight with calibre
    cannon(o, S, own) {
      nz(o, 'highpass', 2400, 2400, 0, 0.9, 0.001, 0.05);                       // supersonic crack
      nz(o, 'lowpass', 6000, 130 / S, 0.45 * S, 1.5, 0.002, 0.85 * S, true);    // muzzle blast
      osc(o, 'sine', 125 / S, 28, 0.4 * S, 2.1, 0.003, 0.75 * S);              // concussion
      osc(o, 'triangle', 70 / S, 30, 0.5, 0.9, 0.004, 0.6 * S);
      nz(o, 'lowpass', 320, 180, 2, 0.65, 0.08, 2.6 * S, false, 0.04);        // rolling thunder
      if (own) {
        // breech slamming back, spent case clattering on the turret floor
        osc(o, 'sine', 410, 380, 0.2, 0.22, 0.001, 0.22, 0.11);
        osc(o, 'sine', 1170, 1100, 0.2, 0.12, 0.001, 0.18, 0.11);
        nz(o, 'bandpass', 3200, 2800, 0.1, 0.18, 0.001, 0.05, false, 0.42);
        nz(o, 'bandpass', 2700, 2500, 0.1, 0.12, 0.001, 0.05, false, 0.53);
      }
    },
    mg(o) {
      nz(o, 'highpass', 3200, 3200, 0, 0.45, 0.001, 0.025);
      nz(o, 'bandpass', 1300, 450, 0.06, 0.8, 0.001, 0.08, true);
      osc(o, 'sine', 170, 55, 0.07, 0.9, 0.002, 0.1);
      nz(o, 'lowpass', 400, 400, 0, 0.18, 0.02, 0.35);
    },
    rocket(o) {
      osc(o, 'sine', 95, 40, 0.3, 0.9, 0.003, 0.35);
      nz(o, 'bandpass', 350, 2600, 0.9, 0.55, 0.06, 1.1);                      // shriek
      nz(o, 'lowpass', 900, 180, 1.1, 0.8, 0.02, 1.4, true);                    // roar
    },
    boom(o, S) {
      nz(o, 'highpass', 1800, 1800, 0, 0.6, 0.001, 0.07);
      nz(o, 'lowpass', 4000, 45, 1.2 * S, 1.8, 0.003, 1.6 * S, true);
      osc(o, 'sine', 80, 20, 0.9 * S, 2.4, 0.004, 1.3 * S);
      nz(o, 'lowpass', 240, 160, 2, 0.8, 0.12, 3.2 * S, false, 0.05);
      nz(o, 'bandpass', 2200, 900, 0.8, 0.25, 0.05, 0.8 * S, false, 0.1);       // falling debris
    },
    hit(o) {                                                                   // penetration: crunch of steel
      nz(o, 'bandpass', 1900, 450, 0.15, 1.0, 0.001, 0.18, true);
      osc(o, 'sine', 220, 70, 0.15, 0.8, 0.002, 0.18);
    },
    clank(o) {                                                                 // ricochet: ringing plate + whine
      nz(o, 'highpass', 3500, 3500, 0, 0.5, 0.001, 0.03);
      for (const f of [1240, 2870, 4410]) osc(o, 'sine', f, f * 0.97, 0.4, 0.18, 0.001, 0.45);
      osc(o, 'triangle', 3300, 900, 0.5, 0.12, 0.01, 0.5, 0.02);
    },
    reload(o) {                                                                // breech block closing
      nz(o, 'highpass', 2600, 2600, 0, 0.5, 0.001, 0.025);
      osc(o, 'sine', 720, 640, 0.05, 0.35, 0.001, 0.08);
      nz(o, 'bandpass', 1500, 1500, 0, 0.6, 0.001, 0.05, false, 0.11);
      osc(o, 'sine', 300, 180, 0.08, 0.7, 0.002, 0.12, 0.11);
    },
  };
  const COST = { cannon: 2, boom: 2, rocket: 1.5, mg: 0.6, hit: 0.6, clank: 0.6, reload: 0.5 };

  // vol: loudness at the source; dn: 0 (on top of you) .. 1 (edge of hearing)
  api.play = (kind, vol = 1, dn = 0, S = 1, own = false) => {
    if (!ac || api.muted || dn >= 1 || budget > 14) return;
    const v = vol * Math.pow(1 - dn, 1.5);
    if (v < 0.015) return;
    budget += COST[kind] || 1;
    const o = voice(v, dn, dn * 0.6);           // sound travels: far shots arrive late
    R[kind](o, S, own);
  };
  api.tone = (freqs, dur = 0.12, vol = 0.12) => {
    if (!ac || api.muted) return;
    freqs.forEach((fr, i) => {
      const t = ac.currentTime + i * dur * 0.8;
      const o = ac.createOscillator(); o.type = 'square'; o.frequency.value = fr;
      const g = ac.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + dur);
    });
  };
  // own engine: low diesel/petrol rumble that climbs with speed
  api.engine = (on, spd) => {
    if (!ac) return;
    if (!engine) {
      const g = ac.createGain(); g.gain.value = 0;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160; lp.Q.value = 2;
      const o1 = ac.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 32;
      const o2 = ac.createOscillator(); o2.type = 'square'; o2.frequency.value = 16.3;
      const lfo = ac.createOscillator(); lfo.frequency.value = 9;
      const lg = ac.createGain(); lg.gain.value = 3; lfo.connect(lg); lg.connect(o1.frequency);
      o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(master);
      o1.start(); o2.start(); lfo.start();
      engine = { g, lp, o1, o2, lfo };
    }
    const t = ac.currentTime;
    engine.g.gain.setTargetAtTime(on ? 0.07 + 0.11 * spd : 0, t, 0.25);
    engine.o1.frequency.setTargetAtTime(30 + 30 * spd, t, 0.5);
    engine.o2.frequency.setTargetAtTime(15 + 15 * spd, t, 0.5);
    engine.lfo.frequency.setTargetAtTime(7 + 10 * spd, t, 0.5);
    engine.lp.frequency.setTargetAtTime(140 + 260 * spd, t, 0.5);
  };
  return api;
})();
const HEAR = { cannon: 3800, boom: 3800, rocket: 3000, mg: 2000, hit: 1500, clank: 1500, reload: 400 };
function soundAt(kind, x, y, vol = 1, S = 1, own = false) {
  const dn = own ? 0 : Math.hypot(x - cam.x, y - cam.y) / (HEAR[kind] || 1600);
  Sound.play(kind, vol, dn, S, own);
}

// =====================================================================
// Network
// =====================================================================
let ws = null, connected = false;
let snaps = [];             // received snapshots, oldest first
let eventQ = [];            // {tm, e} waiting for render time to reach them
let offset = null;          // serverTime - localTime estimate
let renderT = 0;
let you = null, sp = null;
// conquest state from the server: per point [prog -1..1, owner 0/1/2, contested], tickets, battle phase
// per point: [prog, owner, contested, active, de in zone, su in zone, attacker may take, defender may take]
let cps = CAP_POINTS.map(p => (p.line && p.k === 0 ? [1, 1, 0, 0, 0, 0, 0, 0] : !p.line ? [-1, 2, 0, 0, 0, 0, 0, 0] : [0, 0, 0, 0, 0, 0, 0, 0]));
let lineDead = [0, 0], rsv = [RESERVES.de.slice(), RESERVES.su.slice()], phase = 0;
const lineOf = i => CAP_POINTS[i].line;
const isLineDead = L => !!lineDead[LINES.indexOf(L)];
const OWNER = [null, 'de', 'su'];
let ping = 0;

function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

function connect() {
  setStatus('Connecting to server…');
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  ws = new WebSocket(url);
  ws.onopen = () => { connected = true; setStatus(''); resize(); };
  ws.onmessage = ev => { try { onMessage(JSON.parse(ev.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => {
    connected = false; ws = null;
    snaps = []; eventQ = []; offset = null; you = null;
    if (state !== 'menu') backToMenu();
    setStatus('Connection lost — reconnecting…');
    setTimeout(connect, 2000);
  };
}

function onMessage(m) {
  if (m.t === 'welcome') { devMode = !!m.dev; return; }
  if (m.t === 'pong') { ping = performance.now() - m.c; return; }
  if (m.t !== 's') return;
  const s = { tm: m.tm, T: new Map(), B: new Map(), O: new Map() };
  for (const a of m.T) s.T.set(a[0], { id: a[0], team: TEAM_IDS[a[1]], cls: clsByIdx(a[2]), x: a[3], y: a[4], hullA: a[5], turA: a[6], r: a[7], hp: a[8], inv: a[9], name: a[10], mgRel: Array.isArray(a[11]) ? a[11] : undefined, rank: a[12] | 0 });
  for (const a of m.B) s.B.set(a[0], { id: a[0], x: a[1], y: a[2], r: a[3], team: TEAM_IDS[a[4]], kind: KINDS[a[5]], a: a[6] });
  for (const a of m.O) s.O.set(a[0], { id: a[0], type: OB_TYPES[a[1]], x: a[2], y: a[3], a: a[4], hp: a[5], gunA: a[6], grow: a[7], r: OB[OB_TYPES[a[1]]].r });
  snaps.push(s);
  if (snaps.length > 60) snaps.shift();
  for (const e of m.E) eventQ.push({ tm: m.tm, e });
  if (eventQ.length > 800) eventQ = eventQ.filter(q => q.e.e === 'k' || q.e.e === 'die' || q.e.e === 'm');

  const sample = m.tm - performance.now() / 1000;
  if (offset === null || Math.abs(sample - offset) > 1) offset = sample;
  else offset += (sample - offset) * (sample > offset ? 0.2 : 0.02);

  you = m.you || null;
  // the server has the final say on which side we are on (it refuses switches mid-battle)
  if (you && you.team && you.team !== playerTeam && state !== 'menu') {
    playerTeam = you.team; ui.spSig = '';
    if (state === 'dead') buildPicker(ui.deathPicker, playerTeam);
  }
  sp = m.sp === undefined ? null : m.sp;
  if (m.cp) cps = m.cp;
  if (m.ln) lineDead = m.ln;
  if (m.rs) rsv = m.rs;
  if (m.ph !== undefined) phase = m.ph;
}
setInterval(() => send({ t: 'ping', c: performance.now() }), 2000);

// =====================================================================
// Client-side view state
// =====================================================================
let now = 0;                 // local seconds (drives particles/animation)
let vTanks = [], vBullets = [], vObs = [];
const tstate = new Map();    // per-tank local animation state
const ostate = new Map();    // per-obstacle hit flash
const particles = [], texts = [], wrecks = [], feed = [];
const cam = { x: CENTER, y: CENTER, scale: 1, shake: 0 };
let msg = { text: '', t: 0, dur: 0 };
function bigMessage(text, dur = 2.5) { msg = { text, t: now, dur }; }
let deathInfo = null;

function lerpEnt(a, b, f, angles) {
  const o = Object.assign({}, b);
  o.x = lerp(a.x, b.x, f); o.y = lerp(a.y, b.y, f);
  for (const k of angles) o[k] = lerpAngle(a[k], b[k], f);
  return o;
}
function interpolate() {
  if (!snaps.length || offset === null) { vTanks = []; vBullets = []; vObs = []; return; }
  renderT = now + offset - INTERP_DELAY;
  while (snaps.length > 2 && snaps[1].tm <= renderT) snaps.shift();
  const s0 = snaps[0], s1 = snaps[1] || s0;
  const f = s1.tm > s0.tm ? clamp((renderT - s0.tm) / (s1.tm - s0.tm), 0, 1) : 1;
  vTanks = []; vBullets = []; vObs = [];
  for (const [id, b] of s1.T) { const a = s0.T.get(id); vTanks.push(a ? lerpEnt(a, b, f, ['hullA', 'turA']) : b); }
  for (const [id, b] of s1.B) { const a = s0.B.get(id); vBullets.push(a ? lerpEnt(a, b, f, []) : b); }
  for (const [id, b] of s1.O) { const a = s0.O.get(id); vObs.push(a ? lerpEnt(a, b, f, ['a', 'gunA']) : b); }

  while (eventQ.length && eventQ[0].tm <= renderT) handleEvent(eventQ.shift().e);
}

function updateLocal(dt) {
  // per-tank animation: track phase, tread marks, hit flash, recoil, smoke
  for (const t of vTanks) {
    let st = tstate.get(t.id);
    if (!st || st.cls !== t.cls) {
      st = { cls: t.cls, recoil: t.cls.guns.map(() => 0), phase: st ? st.phase : 0, px: t.x, py: t.y, dist: 0, flash: 0, hp: t.hp, seen: now };
      tstate.set(t.id, st);
    }
    const dx = t.x - st.px, dy = t.y - st.py;
    if (Math.abs(dx) + Math.abs(dy) > 300) { st.px = t.x; st.py = t.y; }  // respawn teleport
    st.phase += dx * Math.cos(t.hullA) + dy * Math.sin(t.hullA);
    st.dist += Math.hypot(dx, dy);
    if (st.dist > t.r * 0.45) { st.dist = 0; addMarks(t); }
    st.px = t.x; st.py = t.y;
    if (t.hp < st.hp - 0.005) st.flash = Math.min(1, st.flash + 0.6);
    st.hp = t.hp;
    st.flash = Math.max(0, st.flash - dt * 6);
    for (let i = 0; i < st.recoil.length; i++) st.recoil[i] = Math.max(0, st.recoil[i] - dt * 4);
    st.seen = now;
    t.st = st;
    if (t.hp < 0.35 && Math.random() < dt * 10)
      addP(t.x + rand(-6, 6), t.y + rand(-6, 6), rand(-10, 10), rand(-25, -5), rand(1, 2), t.r * 0.5, '#4a4641', 'smoke');
  }
  for (const [id, st] of tstate) if (now - st.seen > 5) tstate.delete(id);

  for (const o of vObs) {
    let st = ostate.get(o.id);
    if (!st) { st = { hp: o.hp, flash: 0, seen: now }; ostate.set(o.id, st); }
    if (o.hp < st.hp - 0.001) st.flash = 1;
    st.hp = o.hp; st.flash = Math.max(0, st.flash - dt * 7); st.seen = now;
    o.flash = st.flash;
  }
  for (const [id, st] of ostate) if (now - st.seen > 3) ostate.delete(id);

  for (const b of vBullets) {
    if (b.kind === 'rocket' && Math.random() < dt * 40)
      addP(b.x - Math.cos(b.a) * b.r * 2, b.y - Math.sin(b.a) * b.r * 2, rand(-10, 10), rand(-10, 10), rand(0.4, 0.9), b.r * 1.3, '#d8d3c6', 'smoke');
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    const drag = p.type === 'smoke' ? 1.6 : p.type === 'debris' ? 3.5 : 2.5;
    const fr = Math.exp(-dt * drag);
    p.vx *= fr; p.vy *= fr;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.rot += dt * 3;
  }
  while (texts.length && now - texts[0].t > 1.4) texts.shift();
}

const myTank = () => (you ? vTanks.find(t => t.id === you.id) : null);

// =====================================================================
// Server events -> effects
// =====================================================================
const OB_COLORS = { crate: '#a57b43', drum: '#8e3a2b', depot: '#b9a877', bunker: '#8f8d86' };
function handleEvent(e) {
  switch (e.e) {
    case 'f': { // a gun fired
      const st = tstate.get(e.id);
      if (st && st.recoil[e.g] !== undefined) st.recoil[e.g] = 1;
      const mine = you && e.id === you.id;
      const kind = KINDS[e.k], r = e.r || 24, cal = e.b || 0;
      const near = clamp(1 - Math.hypot(e.x - cam.x, e.y - cam.y) / 1500, 0, 1);
      if (kind === 'mg') {
        addP(e.x, e.y, Math.cos(e.a) * 60, Math.sin(e.a) * 60, 0.06, r * 0.25, '#ffe9a8', 'flash');
        soundAt('mg', e.x, e.y, mine ? 0.8 : 0.6, 1, mine);
      } else if (kind === 'rocket') {
        for (let k = 0; k < 4; k++) addP(e.x, e.y, -Math.cos(e.a) * rand(40, 120) + rand(-30, 30), -Math.sin(e.a) * rand(40, 120) + rand(-30, 30), rand(0.5, 1), r * 0.3, '#cfcabd', 'smoke');
        soundAt('rocket', e.x, e.y, mine ? 0.8 : 0.65, 1, mine);
      } else {
        // big muzzle flash, a blast of dust thrown forward and sideways
        addP(e.x, e.y, Math.cos(e.a) * 40, Math.sin(e.a) * 40, 0.11, r * (0.6 + cal * 0.3), '#fff1b8', 'flash');
        addP(e.x, e.y, 0, 0, 0.35, r * (1 + cal * 0.5), '#fff4cc', 'ring');
        for (let k = 0; k < 3 + cal * 3; k++) {
          const sa = e.a + rand(-1.4, 1.4);
          addP(e.x, e.y, Math.cos(sa) * rand(40, 150), Math.sin(sa) * rand(40, 150), rand(0.6, 1.4), r * rand(0.3, 0.55), '#bdb7a6', 'smoke');
        }
        soundAt('cannon', e.x, e.y, mine ? 1 : 0.9, [0.8, 1, 1.4][cal], mine);
        if (mine) cam.shake = Math.min(18, cam.shake + [4, 7, 11][cal]);
        else cam.shake = Math.min(18, cam.shake + [1.5, 3, 6][cal] * near * near);
      }
      break;
    }
    case 'h':
      if (e.z === 3) {   // a shell into a house wall
        for (let k = 0; k < 6; k++) addP(e.x, e.y, -e.vx * rand(0.03, 0.12) + rand(-70, 70), -e.vy * rand(0.03, 0.12) + rand(-70, 70), rand(0.3, 0.7), rand(2, 4), rpickC(['#d8cfb4', '#9b8a68', '#bfb08a']), 'debris');
        addP(e.x, e.y, rand(-15, 15), rand(-15, 15), 1.1, 16, 'rgba(200,190,160,0.5)', 'smoke');
        soundAt('hit', e.x, e.y, 0.6);
        break;
      }
      for (let k = 0; k < 3; k++) addP(e.x, e.y, -e.vx * rand(0.05, 0.2) + rand(-60, 60), -e.vy * rand(0.05, 0.2) + rand(-60, 60), rand(0.1, 0.25), 2.5, '#ffd27a', 'spark');
      soundAt(e.z === 1 ? 'clank' : 'hit', e.x, e.y, 0.7);
      break;
    case 'x': {
      explosionFx(e.x, e.y, e.s);
      soundAt('boom', e.x, e.y, e.s > 30 ? 1 : 0.8, clamp(e.s / 35, 0.7, 1.8));
      const near = clamp(1 - Math.hypot(e.x - cam.x, e.y - cam.y) / 1400, 0, 1);
      cam.shake = Math.min(18, cam.shake + e.s * 0.12 * near * near);
      break;
    }
    case 'cp': {
      const p = CAP_POINTS[e.i], ours = you && e.t === you.team;
      const label = `${p.id} · ${p.name}`;
      if (you) {
        bigMessage(ours ? `${e.n ? 'Neutralized' : 'Captured'} ${label}` : `Enemy ${e.n ? 'neutralized' : 'captured'} ${label}`, 3);
        Sound.tone(ours ? [392, 523, 659] : [440, 349, 262], 0.14, 0.07);
      }
      feed.push({ kn: TEAMS[e.t].name, kt: e.t, vn: label, vt: e.n ? null : e.t, sym: e.n ? '⊘' : '⚑', t: now });
      if (feed.length > 6) feed.shift();
      break;
    }
    case 're':
      // the winning side's victory song if one has been supplied, otherwise a short fanfare
      if (!Music.play('victory', e.w) && you) Sound.tone(e.w === you.team ? [392, 523, 659, 784] : [392, 330, 262, 196], 0.22, 0.09);
      break;
    case 'rn':
      bigMessage('A new battle begins', 3);
      if (!(you && Music.play('intro', you.team))) Music.fadeOut();
      break;
    case 'ld':
      bigMessage(`Line ${e.l} defeated — ${TEAMS[DEFENDER].name} retook ${e.l}5`, 4);
      if (you) Sound.tone(you.team === DEFENDER ? [392, 523, 659] : [440, 349, 262], 0.16, 0.08);
      feed.push({ kn: TEAMS[DEFENDER].name, kt: DEFENDER, vn: `Line ${e.l}`, vt: null, sym: '✖', t: now });
      if (feed.length > 6) feed.shift();
      break;
    case 'rd': Sound.play('reload', 0.9); break;
    case 'd': {
      const type = OB_TYPES[e.o], col = OB_COLORS[type];
      for (let i = 0; i < 8 + e.r / 4; i++) {
        const a = rand(0, TAU), s = rand(40, 200);
        addP(e.x, e.y, Math.cos(a) * s, Math.sin(a) * s, rand(0.4, 0.9), rand(3, e.r * 0.25), col, 'debris');
      }
      if (!OB[type].explosive) soundAt('hit', e.x, e.y, 0.5);
      break;
    }
    case 'w':
      wrecks.push({ x: e.x, y: e.y, cls: clsByIdx(e.c), r: e.r, hullA: e.h, turA: e.u, t: now });
      if (wrecks.length > 40) wrecks.shift();
      break;
    case 'bf': addP(e.x, e.y, 0, 0, 0.1, 22, '#fff1b8', 'flash'); soundAt('cannon', e.x, e.y, 0.9, 1.2); break;
    case 'bb': addP(e.x, e.y, 0, 0, 0.1, e.s, '#fff1b8', 'flash'); break;
    case 'sp': addP(e.x, e.y, rand(-60, 60), rand(-60, 60), 0.2, 3, '#ffd27a', 'spark'); break;
    case 'k':
      feed.push({ kn: e.kn, kt: e.kt, kc: e.kc, kr: e.kr, vn: e.vn, vt: e.vt, vc: e.vc, vr: e.vr, t: now });
      if (feed.length > 6) feed.shift();
      break;
    // personal events
    case 't': texts.push({ x: e.x, y: e.y, text: e.text, color: e.c, size: e.s, t: now }); break;
    case 'm': bigMessage(e.text, e.d); break;
    case 'sh': cam.shake = Math.min(14, cam.shake + e.a); break;
    case 'die': onPlayerDeath(e); break;
  }
}

// ---------- particles ----------
function addP(x, y, vx, vy, life, size, color, type) {
  if (particles.length > 1500) return;
  particles.push({ x, y, vx, vy, life, max: life, size, color, type, rot: rand(0, TAU) });
}
function explosionFx(x, y, size) {
  addP(x, y, 0, 0, 0.22, size * 1.4, '#fff4cc', 'flash');
  addP(x, y, 0, 0, 0.45, size * 1.8, '#ffd27a', 'ring');
  const n = Math.min(26, 8 + size / 3);
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU), s = rand(30, 160) * (size / 40 + 0.5);
    addP(x, y, Math.cos(a) * s, Math.sin(a) * s, rand(0.25, 0.6), size * rand(0.25, 0.5), pick(['#ffb347', '#ff7b2e', '#ffd56b']), 'fire');
  }
  for (let i = 0; i < n * 0.8; i++) {
    const a = rand(0, TAU), s = rand(10, 70);
    addP(x + rand(-size, size) * 0.3, y + rand(-size, size) * 0.3, Math.cos(a) * s, Math.sin(a) * s, rand(1.2, 2.6), size * rand(0.4, 0.8), pick(['#4b4741', '#5d5850', '#3a3732']), 'smoke');
  }
}

// tread marks: ring buffer
const MARK_MAX = 2600;
const marks = new Array(MARK_MAX);
let markIdx = 0;
function addMarks(t) {
  if (Math.abs(t.x - cam.x) > 1800 || Math.abs(t.y - cam.y) > 1400) return;
  const ca = Math.cos(t.hullA), sa = Math.sin(t.hullA);
  const off = t.cls.hull[1] * t.r * 0.38;
  const w = t.cls.hull[1] * t.r * (t.cls.style === 'truck' ? 0.12 : 0.2);
  for (const s of [-1, 1]) {
    marks[markIdx] = { x: t.x - sa * off * s, y: t.y + ca * off * s, ca, sa, w, l: t.r * 0.28, t: now };
    markIdx = (markIdx + 1) % MARK_MAX;
  }
}

// =====================================================================
// Decor (purely cosmetic, generated locally)
// =====================================================================
const decor = { fields: [], craters: [], bushes: [], roads: [], gardens: [], trees: [] };
const rpickC = arr => arr[Math.floor(Math.random() * arr.length)];
(function genDecor() {
  // seeded so every player sees the same steppe
  let seed = 1943;
  const rnd = (a, b) => { seed = (seed * 16807) % 2147483647; return a + (seed / 2147483647) * (b - a); };
  const rpick = arr => arr[Math.floor(rnd(0, arr.length))];
  const nearHouse = (x, y, m) => BUILDINGS.some(b => Math.hypot(b.x - x, b.y - y) < b.br + m);
  const cols = ['#c3b679', '#aeab6d', '#bfae6a', '#b3a76b', '#c9bc84'];
  for (let i = 0; i < 110; i++) decor.fields.push({ x: rnd(0, WORLD), y: rnd(0, WORLD), w: rnd(300, 700), h: rnd(220, 560), a: rnd(-0.4, 0.4), c: rpick(cols), rows: rnd(0, 1) < 0.7 });
  // shell craters cluster along the front line (the bottom-left/top-right diagonal)
  for (let i = 0; i < 360; i++) {
    const t = rnd(0, 1), off = rnd(-1, 1) * rnd(0, 1) * 1800;
    const x = WORLD * t + off / Math.SQRT2, y = WORLD * (1 - t) + off / Math.SQRT2;
    decor.craters.push({ x, y, r: rnd(14, 46) });
  }
  for (let i = 0; i < 170; i++) {
    const x = rnd(0, WORLD), y = rnd(0, WORLD), n = 3 + Math.floor(rnd(0, 4)), blobs = [];
    if (nearHouse(x, y, 60)) continue;
    for (let k = 0; k < n; k++) blobs.push([rnd(-30, 30), rnd(-30, 30), rnd(14, 30)]);
    decor.bushes.push({ x, y, blobs });
  }
  // the main road: rear area -> every objective in order -> enemy rear, as smooth curves
  const defRear = REARS.find(r => r.team === DEFENDER);
  const chains = LINES.map(L => [REARS.find(r => r.line === L), ...CAP_POINTS.filter(p => p.line === L), CAP_POINTS[O_IDX]])
    .concat([[CAP_POINTS[O_IDX], defRear]]);
  for (const nodes of chains) for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1], dx = b.x - a.x, dy = b.y - a.y;
    decor.roads.push([a.x, a.y, a.x + dx * 0.33 + rnd(-200, 200), a.y + dy * 0.33 + rnd(-200, 200),
      a.x + dx * 0.66 + rnd(-200, 200), a.y + dy * 0.66 + rnd(-200, 200), b.x, b.y]);
  }
  // village streets, and tracks out to the nearest neighbour
  for (const h of HAMLETS) {
    for (const sa of h.streets) {
      const ex = Math.cos(sa) * h.len * 0.6, ey = Math.sin(sa) * h.len * 0.6;
      decor.roads.push([h.x - ex, h.y - ey, h.x - ex / 3, h.y - ey / 3, h.x + ex / 3, h.y + ey / 3, h.x + ex, h.y + ey]);
    }
    let nb = null, nd = Infinity;
    for (const o of HAMLETS) { const d = Math.hypot(o.x - h.x, o.y - h.y); if (o !== h && d < nd) { nd = d; nb = o; } }
    if (nb && !h.big) decor.roads.push([h.x, h.y, h.x + (nb.x - h.x) * 0.4 + rnd(-150, 150), h.y + (nb.y - h.y) * 0.4 + rnd(-150, 150),
      h.x + (nb.x - h.x) * 0.7 + rnd(-150, 150), h.y + (nb.y - h.y) * 0.7 + rnd(-150, 150), nb.x, nb.y]);
  }
  // a fenced kitchen garden behind most houses, orchard trees around the villages
  const hamletOf = b => HAMLETS.find(h => BUILDINGS.indexOf(b) >= h.b0 && BUILDINGS.indexOf(b) < h.b1);
  for (const b of BUILDINGS) {
    if (b.kind === 'church' || rnd(0, 1) < 0.25) continue;
    const h = hamletOf(b);
    // "behind" = away from the street the house faces
    const nx = -Math.sin(b.a), ny = Math.cos(b.a);
    const sd = h && ((b.x - h.x) * nx + (b.y - h.y) * ny) < 0 ? -1 : 1;
    const gd = rnd(70, 130), gw = b.w * rnd(0.9, 1.3);
    decor.gardens.push({ x: b.x + nx * sd * (b.h / 2 + gd / 2 + 6), y: b.y + ny * sd * (b.h / 2 + gd / 2 + 6), w: gw, h: gd, a: b.a, c: rpick(['#8e8f4f', '#9c9156', '#7f8748']) });
  }
  for (const h of HAMLETS) {
    const n = h.big ? 14 : 6;
    for (let i = 0; i < n; i++) {
      const a = rnd(0, TAU), d = rnd(h.len * 0.35, h.len * 0.75), x = h.x + Math.cos(a) * d, y = h.y + Math.sin(a) * d;
      if (nearHouse(x, y, 45)) continue;
      decor.trees.push({ x, y, r: rnd(16, 28), c: rpick(['#5d6b35', '#66733a', '#56632f']) });
    }
  }
})();

// =====================================================================
// Rendering — vehicles// =====================================================================
// Rendering — vehicles
// =====================================================================
function drawTrack(c, x, y, l, w, phase, r) {
  c.fillStyle = '#34352f';
  c.fillRect(x, y, l, w);
  c.strokeRect(x, y, l, w);
  const s = r * 0.22, o = ((phase % s) + s) % s;
  const lw = c.lineWidth;
  c.lineWidth = Math.max(1, r * 0.045);
  c.strokeStyle = 'rgba(0,0,0,0.5)';
  c.beginPath();
  for (let xx = x + o; xx < x + l; xx += s) { c.moveTo(xx, y + 1); c.lineTo(xx, y + w - 1); }
  c.stroke();
  c.lineWidth = lw;
}
function drawWheel(c, x, y, l, w) {
  c.fillStyle = '#2a2a26';
  rrect(c, x - l / 2, y - w / 2, l, w, w * 0.3);
  c.fill(); c.stroke();
}
function drawGun(c, g, r, rec, T) {
  const len = g.len * r * (1 - rec * 0.18), w = g.w * r;
  const y = g.off * r;
  c.save();
  c.rotate(g.ang);
  if (g.kind === 'mg') { c.fillStyle = '#3c3e39'; c.lineWidth = Math.max(1, r * 0.05); }
  else if (g.kind === 'rocket') c.fillStyle = '#56564c';
  else c.fillStyle = T.barrel;
  c.beginPath(); c.rect(0, y - w / 2, len, w); c.fill(); c.stroke();
  if (g.brake) {
    const bl = Math.max(w * 0.9, r * 0.14);
    c.beginPath(); c.rect(len - bl, y - w * 0.78, bl, w * 1.56); c.fill(); c.stroke();
  }
  if (g.kind === 'rocket' && rec < 0.5 && w < r * 0.3) {
    c.fillStyle = '#7d6c4a';
    c.beginPath(); c.rect(len * 0.25, y - w * 0.32, len * 0.6, w * 0.64); c.fill();
  }
  c.restore();
}
function drawInsignia(c, team, s) {
  if (team === 'de') {
    c.fillStyle = '#f2f2ea';
    c.beginPath(); c.rect(-s, -s * 0.32, s * 2, s * 0.64); c.rect(-s * 0.32, -s, s * 0.64, s * 2); c.fill();
    c.fillStyle = '#1b1b1b';
    c.beginPath(); c.rect(-s * 0.8, -s * 0.16, s * 1.6, s * 0.32); c.rect(-s * 0.16, -s * 0.8, s * 0.32, s * 1.6); c.fill();
  } else if (team === 'su') {
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? s * 0.42 : s, a = -Math.PI / 2 + i * Math.PI / 5;
      c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    c.closePath();
    c.fillStyle = '#c8322a'; c.fill();
    const lw = c.lineWidth; c.lineWidth = Math.max(1, s * 0.14); c.strokeStyle = '#f2f2ea'; c.stroke(); c.lineWidth = lw;
  }
}

function drawTankModel(c, cls, teamId, r, hullA, turA, recoil, phase, flash, mgRel) {
  const T = TEAMS[teamId];
  const body = flash > 0 ? mix(T.body, '#ffffff', flash * 0.6) : T.body;
  const top = flash > 0 ? mix(T.top, '#ffffff', flash * 0.6) : T.top;
  const L = cls.hull[0] * r, Wd = cls.hull[1] * r;
  const lw = Math.max(1.5, r * 0.085);
  c.lineJoin = 'round';
  c.save();
  c.rotate(hullA);
  c.lineWidth = lw; c.strokeStyle = '#1f201c';
  const tw = Wd * 0.24;

  if (cls.style === 'tank' || cls.style === 'casemate') {
    drawTrack(c, -L / 2 - r * 0.04, -Wd / 2, L + r * 0.08, tw, phase, r);
    drawTrack(c, -L / 2 - r * 0.04, Wd / 2 - tw, L + r * 0.08, tw, phase, r);
  } else if (cls.style === 'halftrack') {
    const tl = L * 0.56;
    drawTrack(c, -L / 2, -Wd / 2, tl, tw, phase, r);
    drawTrack(c, -L / 2, Wd / 2 - tw, tl, tw, phase, r);
    drawWheel(c, L * 0.33, -Wd / 2 + tw * 0.45, r * 0.42, tw * 0.9);
    drawWheel(c, L * 0.33, Wd / 2 - tw * 0.45, r * 0.42, tw * 0.9);
  } else if (cls.style === 'truck') {
    for (const fx of [-0.36, -0.16, 0.33]) {
      drawWheel(c, L * fx, -Wd / 2 + tw * 0.4, r * 0.4, tw * 0.8);
      drawWheel(c, L * fx, Wd / 2 - tw * 0.4, r * 0.4, tw * 0.8);
    }
  }

  c.fillStyle = body; c.strokeStyle = T.dark;
  if (cls.style === 'halftrack') {
    const hw = Wd * 0.4;
    polyPath(c, [-L / 2, -hw, L * 0.12, -hw, L / 2, -hw * 0.55, L / 2, hw * 0.55, L * 0.12, hw, -L / 2, hw]);
    c.fill(); c.stroke();
    c.fillStyle = 'rgba(0,0,0,0.25)';
    rrect(c, -L * 0.44, -hw * 0.72, L * 0.5, hw * 1.44, r * 0.06); c.fill();
  } else if (cls.style === 'truck') {
    const hw = Wd * 0.38;
    rrect(c, -L / 2, -hw, L * 0.68, hw * 2, r * 0.08); c.fill(); c.stroke();
    c.fillStyle = top;
    rrect(c, L * 0.22, -hw * 0.9, L * 0.28, hw * 1.8, r * 0.12); c.fill(); c.stroke();
    c.fillStyle = 'rgba(30,40,45,0.55)';
    c.fillRect(L * 0.34, -hw * 0.7, L * 0.08, hw * 1.4);
  } else {
    const hw = Wd * 0.39;
    rrect(c, -L / 2, -hw, L, hw * 2, r * 0.1); c.fill(); c.stroke();
    c.strokeStyle = 'rgba(0,0,0,0.22)';
    const lw2 = c.lineWidth; c.lineWidth = Math.max(1, r * 0.04);
    c.beginPath();
    for (let k = 0; k < 3; k++) { const x = -L * 0.44 + k * r * 0.12; c.moveTo(x, -hw * 0.5); c.lineTo(x, hw * 0.5); }
    c.stroke(); c.lineWidth = lw2; c.strokeStyle = T.dark;
  }

  if (cls.style === 'casemate') {
    for (let i = 0; i < cls.guns.length; i++) {
      c.save(); c.translate(cls.caseX * r, 0); c.rotate(angDiff(turA, hullA)); drawGun(c, cls.guns[i], r, recoil ? recoil[i] || 0 : 0, T); c.restore();
    }
    c.lineWidth = lw; c.strokeStyle = T.dark; c.fillStyle = top;
    const cw = cls.caseW * r, ch = Wd * 0.64;
    rrect(c, cls.caseX * r - cw / 2, -ch / 2, cw, ch, r * 0.1); c.fill(); c.stroke();
    c.fillStyle = 'rgba(0,0,0,0.18)';
    c.beginPath(); c.arc(cls.caseX * r - cw * 0.22, -ch * 0.2, r * 0.13, 0, TAU); c.fill();
    const ix = cls.caseX * r - cw * 0.5 - L * 0.12;
    if (ix > -L * 0.46) { c.save(); c.translate(ix, 0); drawInsignia(c, teamId, r * 0.16); c.restore(); }
  } else if (teamId !== 'wreck') {
    c.save(); c.translate(-L * 0.36, 0); drawInsignia(c, teamId, r * 0.15); c.restore();
  }
  c.restore();

  drawMgs(c, cls, teamId, r, hullA, turA, mgRel, 'hull');
  if (cls.style === 'casemate') { drawMgs(c, cls, teamId, r, hullA, turA, mgRel, 'turret'); return; }

  const tr = cls.turret * r;
  c.save();
  c.rotate(hullA);
  c.translate(cls.turretX * r, 0);
  c.rotate(turA - hullA);
  c.lineWidth = lw; c.strokeStyle = T.dark;
  if (cls.turretShape === 'rack') {
    c.fillStyle = '#3f3f37';
    rrect(c, -tr * 0.9, -tr * 0.95, tr * 1.8, tr * 1.9, r * 0.06); c.fill(); c.stroke();
  }
  for (let i = 0; i < cls.guns.length; i++) drawGun(c, cls.guns[i], r, recoil ? recoil[i] || 0 : 0, T);
  c.lineWidth = lw; c.strokeStyle = T.dark; c.fillStyle = top;
  switch (cls.turretShape) {
    case 'box':
      rrect(c, -tr * 1.05, -tr * 0.88, tr * 1.95, tr * 1.76, tr * 0.28); c.fill(); c.stroke(); break;
    case 'hex':
      polyPath(c, [tr, -tr * 0.55, tr, tr * 0.55, tr * 0.1, tr * 0.95, -tr * 0.95, tr * 0.75, -tr * 0.95, -tr * 0.75, tr * 0.1, -tr * 0.95]);
      c.fill(); c.stroke(); break;
    case 'open':
      ngon(c, 8, tr, Math.PI / 8); c.fill(); c.stroke();
      c.fillStyle = 'rgba(0,0,0,0.3)'; ngon(c, 8, tr * 0.66, Math.PI / 8); c.fill(); break;
    case 'ball':
      c.beginPath(); c.arc(0, 0, tr, 0, TAU); c.fill(); c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.12)'; c.beginPath(); c.arc(-tr * 0.3, -tr * 0.3, tr * 0.45, 0, TAU); c.fill(); break;
    case 'pintle':
      c.fillStyle = '#3c3e39'; c.beginPath(); c.arc(0, 0, tr * 0.6, 0, TAU); c.fill(); c.stroke(); break;
    case 'rack': break;
    default:
      c.beginPath(); c.arc(0, 0, tr, 0, TAU); c.fill(); c.stroke();
  }
  if (cls.turretShape === 'box' || cls.turretShape === 'hex' || cls.turretShape === 'round') {
    c.fillStyle = 'rgba(0,0,0,0.16)';
    c.beginPath(); c.arc(-tr * 0.4, -tr * 0.32, tr * 0.3, 0, TAU); c.fill();
  }
  c.restore();
  drawMgs(c, cls, teamId, r, hullA, turA, mgRel, 'turret');
}

// secondary MGs: ball mounts (bow / turret rear) and free pintle mounts on the roof.
// mgRel = per-mount angles relative to their frame, from the server (undefined in previews: rest bearing).
function drawMgs(c, cls, teamId, r, hullA, turA, mgRel, frame) {
  if (!cls.mgs) return;
  const cas = cls.style === 'casemate', T = TEAMS[teamId], wreck = teamId === 'wreck';
  cls.mgs.forEach((m, i) => {
    if ((m.f === 'hull') !== (frame === 'hull')) return;
    c.save();
    c.rotate(hullA);
    if (m.f !== 'hull') {
      c.translate((cas ? cls.caseX : cls.turretX) * r, 0);
      if (!cas) c.rotate(turA - hullA);
    }
    c.translate(m.x * r, m.y * r);
    c.rotate(mgRel && mgRel[i] !== undefined ? mgRel[i] : m.b);
    c.lineWidth = Math.max(1, r * 0.04); c.strokeStyle = '#1f201c';
    c.fillStyle = '#2f302b';
    const w = (m.t === 'dshk' ? 0.11 : 0.08) * r;
    c.fillRect(0, -w / 2, m.len * r, w); c.strokeRect(0, -w / 2, m.len * r, w);
    if (m.ball) {
      // armoured ball mount set into the plate
      c.fillStyle = wreck ? T.top : T.dark;
      c.beginPath(); c.arc(0, 0, r * 0.09, 0, TAU); c.fill(); c.stroke();
    } else {
      c.fillStyle = wreck ? T.top : T.dark;
      c.beginPath(); c.arc(0, 0, r * 0.13, 0, TAU); c.fill(); c.stroke();
      if (cas || m.t === 'mg34') {                                 // small gun shield
        c.fillStyle = wreck ? T.body : T.barrel;
        c.fillRect(r * 0.1, -r * 0.16, r * 0.06, r * 0.32);
      }
    }
    c.restore();
  });
}

function drawPreview(cv, clsId, team, t = 0) {
  const c = cv.getContext('2d');
  const cls = CLASSES[clsId];
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cv.width, cv.height);
  const ext = Math.max(cls.hull[0] / 2, ...cls.guns.map(g => (cls.style === 'casemate' ? cls.caseX : cls.turretX) + g.len)) + 0.25;
  const r = Math.min(cv.width, cv.height) * 0.5 / ext;
  c.translate(cv.width / 2 - r * 0.25, cv.height / 2 + r * 0.15);
  drawTankModel(c, cls, team, r, -0.55, -0.55 + Math.sin(t) * 0.12, null, t * 20, 0);
}

// =====================================================================
// Rendering — world
// =====================================================================
let view = { x0: 0, y0: 0, x1: 0, y1: 0 };
const inView = (x, y, m) => x > view.x0 - m && x < view.x1 + m && y > view.y0 - m && y < view.y1 + m;

function drawGround() {
  const c = ctx;
  c.fillStyle = '#b8ae79';
  c.fillRect(0, 0, WORLD, WORLD);
  for (const f of decor.fields) {
    if (!inView(f.x, f.y, 700)) continue;
    c.save(); c.translate(f.x, f.y); c.rotate(f.a);
    c.fillStyle = f.c; c.globalAlpha = 0.55;
    c.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);
    if (f.rows) {
      c.globalAlpha = 1; c.strokeStyle = 'rgba(80,65,30,0.08)'; c.lineWidth = 3;
      c.beginPath();
      for (let y = -f.h / 2 + 8; y < f.h / 2; y += 16) { c.moveTo(-f.w / 2, y); c.lineTo(f.w / 2, y); }
      c.stroke();
    }
    c.restore();
  }
  c.globalAlpha = 1;
  c.lineCap = 'round';
  for (const r of decor.roads) {
    c.beginPath(); c.moveTo(r[0], r[1]); c.bezierCurveTo(r[2], r[3], r[4], r[5], r[6], r[7]);
    c.strokeStyle = 'rgba(120,100,60,0.25)'; c.lineWidth = 58; c.stroke();
    c.strokeStyle = '#a99a6b'; c.lineWidth = 44; c.stroke();
  }
  c.lineCap = 'butt';
  const step = 64;
  c.strokeStyle = 'rgba(70,58,25,0.07)'; c.lineWidth = 1.5;
  c.beginPath();
  const gx0 = Math.max(0, Math.floor(view.x0 / step) * step), gx1 = Math.min(WORLD, view.x1);
  const gy0 = Math.max(0, Math.floor(view.y0 / step) * step), gy1 = Math.min(WORLD, view.y1);
  for (let x = gx0; x <= gx1; x += step) { c.moveTo(x, Math.max(0, view.y0)); c.lineTo(x, gy1); }
  for (let y = gy0; y <= gy1; y += step) { c.moveTo(Math.max(0, view.x0), y); c.lineTo(gx1, y); }
  c.stroke();
  for (const cr of decor.craters) {
    if (!inView(cr.x, cr.y, cr.r)) continue;
    c.fillStyle = 'rgba(95,80,45,0.35)';
    c.beginPath(); c.arc(cr.x, cr.y, cr.r, 0, TAU); c.fill();
    c.fillStyle = 'rgba(60,50,28,0.35)';
    c.beginPath(); c.arc(cr.x + cr.r * 0.12, cr.y + cr.r * 0.12, cr.r * 0.62, 0, TAU); c.fill();
  }
  for (const g of decor.gardens) {
    if (!inView(g.x, g.y, 120)) continue;
    c.save(); c.translate(g.x, g.y); c.rotate(g.a);
    c.fillStyle = g.c; c.globalAlpha = 0.55; c.fillRect(-g.w / 2, -g.h / 2, g.w, g.h);
    c.globalAlpha = 1; c.strokeStyle = 'rgba(70,60,30,0.25)'; c.lineWidth = 3; c.beginPath();
    for (let x = -g.w / 2 + 10; x < g.w / 2; x += 14) { c.moveTo(x, -g.h / 2 + 6); c.lineTo(x, g.h / 2 - 6); }
    c.stroke();
    c.strokeStyle = 'rgba(90,70,40,0.75)'; c.lineWidth = 2; c.setLineDash([7, 5]);
    c.strokeRect(-g.w / 2, -g.h / 2, g.w, g.h); c.setLineDash([]);
    c.restore();
  }
  for (const r of REARS) {
    if (!inView(r.x, r.y, 500)) continue;
    const lost = r.line && isLineDead(r.line);
    c.strokeStyle = lost ? 'rgba(150,40,30,0.4)' : 'rgba(40,35,25,0.35)'; c.lineWidth = 3; c.setLineDash([14, 10]);
    c.beginPath(); c.arc(r.x, r.y, 380, 0, TAU); c.stroke(); c.setLineDash([]);
    c.fillStyle = 'rgba(30,30,25,0.14)'; c.font = '600 54px Oswald, Impact, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(TEAMS[r.team].label, r.x, r.y - 20);
    c.font = '600 26px Oswald, Impact, sans-serif';
    c.fillText(lost ? `LINE ${r.line} — LOST` : r.line ? `LINE ${r.line} ASSEMBLY AREA` : 'ASSEMBLY AREA', r.x, r.y + 26);
  }
  c.strokeStyle = 'rgba(40,35,20,0.5)'; c.lineWidth = 8;
  c.strokeRect(0, 0, WORLD, WORLD);
}

// capture-point colours: steel grey-blue for Germany, red for the Soviet Union
const PT_COL = { de: '#8fa6b8', su: '#c4553f', none: '#d8cfa8' };
const ptColor = owner => PT_COL[owner || 'none'];

// the attack route: a dashed track from point to point, in the attacker's order
function drawRoute(c, k, ox, oy, w) {
  c.lineWidth = w; c.setLineDash([w * 3, w * 2]);
  for (const L of LINES) {
    c.strokeStyle = isLineDead(L) ? 'rgba(150,40,30,0.35)' : 'rgba(70,58,38,0.45)';
    c.beginPath();
    CAP_POINTS.filter(p => p.line === L).concat([CAP_POINTS[O_IDX]])
      .forEach((p, i) => (i ? c.lineTo(ox + p.x * k, oy + p.y * k) : c.moveTo(ox + p.x * k, oy + p.y * k)));
    c.stroke();
  }
  c.setLineDash([]);
}
function drawLock(c, x, y, s, col) {
  c.fillStyle = col; c.strokeStyle = col; c.lineWidth = s * 0.22;
  c.beginPath(); c.arc(x, y - s * 0.35, s * 0.42, Math.PI, 0); c.stroke();
  rrect(c, x - s * 0.65, y - s * 0.35, s * 1.3, s * 1.0, s * 0.15); c.fill();
}
function drawPoints() {
  const c = ctx;
  drawRoute(c, 1, 0, 0, 10);
  CAP_POINTS.forEach((p, i) => {
    if (!inView(p.x, p.y, CAP_R + 120)) return;
    const [prog, ow, contested, active] = cps[i] || [0, 0, 0, 0];
    const owner = OWNER[ow], col = ptColor(owner);
    const [cr, cg, cb] = hexRgb(col);
    c.fillStyle = `rgba(${cr},${cg},${cb},${active ? 0.16 : 0.06})`;
    c.beginPath(); c.arc(p.x, p.y, CAP_R, 0, TAU); c.fill();
    // dashed perimeter (marching while contested); locked points get a faint solid ring and a padlock
    c.strokeStyle = contested ? `rgba(230,80,50,${0.55 + 0.35 * Math.sin(now * 8)})` : `rgba(${cr},${cg},${cb},${active ? 0.85 : 0.35})`;
    c.lineWidth = active ? 5 : 3; c.setLineDash(active ? [26, 16] : []); c.lineDashOffset = contested ? -now * 60 : 0;
    c.beginPath(); c.arc(p.x, p.y, CAP_R, 0, TAU); c.stroke();
    if (!active) drawLock(c, p.x, p.y - CAP_R * 0.55, 26, `rgba(${cr * 0.4 | 0},${cg * 0.4 | 0},${cb * 0.4 | 0},0.4)`);
    c.setLineDash([]); c.lineDashOffset = 0;
    // capture progress arc, drawn in the colour of whoever the needle leans toward
    if (Math.abs(prog) > 0.01 && Math.abs(prog) < 0.999) {
      c.strokeStyle = ptColor(prog > 0 ? 'de' : 'su'); c.lineWidth = 12;
      c.beginPath(); c.arc(p.x, p.y, CAP_R - 14, -Math.PI / 2, -Math.PI / 2 + TAU * Math.abs(prog)); c.stroke();
    }
    // letter + name painted on the ground
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = `rgba(${cr * 0.35 | 0},${cg * 0.35 | 0},${cb * 0.35 | 0},0.28)`;
    c.font = '600 150px Oswald, Impact, sans-serif';
    c.fillText(p.id, p.x, p.y + 6);
    c.font = '600 30px Oswald, Impact, sans-serif';
    c.fillText(p.name.toUpperCase(), p.x, p.y + CAP_R * 0.62);
    // flagpole with a waving banner
    const fx = p.x + 70, fy = p.y - 60;
    c.strokeStyle = '#3a352a'; c.lineWidth = 4;
    c.beginPath(); c.moveTo(fx, fy + 50); c.lineTo(fx, fy - 40); c.stroke();
    c.fillStyle = col; c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(fx, fy - 40);
    for (let k = 0; k <= 6; k++) c.lineTo(fx + k * 9, fy - 40 + Math.sin(now * 5 + k * 0.9) * 3 * k / 6);
    for (let k = 6; k >= 0; k--) c.lineTo(fx + k * 9, fy - 12 + Math.sin(now * 5 + k * 0.9) * 3 * k / 6);
    c.closePath(); c.fill(); c.stroke();
  });
}

function drawMarks() {
  const buckets = [[], [], [], [], [], []];
  const life = 14;
  for (let i = 0; i < MARK_MAX; i++) {
    const m = marks[i];
    if (!m) continue;
    const age = now - m.t;
    if (age > life || !inView(m.x, m.y, 20)) continue;
    buckets[Math.min(5, (age / life * 6) | 0)].push(m);
  }
  for (let b = 0; b < 6; b++) {
    const list = buckets[b];
    if (!list.length) continue;
    ctx.fillStyle = `rgba(70,58,32,${0.22 * (1 - b / 6)})`;
    ctx.beginPath();
    for (const m of list) {
      const ax = m.ca * m.l, ay = m.sa * m.l, bx = -m.sa * m.w / 2, by = m.ca * m.w / 2;
      ctx.moveTo(m.x + ax + bx, m.y + ay + by);
      ctx.lineTo(m.x + ax - bx, m.y + ay - by);
      ctx.lineTo(m.x - ax - bx, m.y - ay - by);
      ctx.lineTo(m.x - ax + bx, m.y - ay + by);
      ctx.closePath();
    }
    ctx.fill();
  }
}

// top-down houses: shadow, two-pitch roof with a ridge, thatch/plank texture; ruins are roofless shells
const ROOFS = { house: [['#bba366', '#9d874f'], ['#c7b27a', '#a8925c'], ['#a7905a', '#8a7545']], barn: [['#7d6a52', '#635341']], church: [['#7f9a86', '#62796a']] };
function drawBuilding(c, b) {
  const hw = b.w / 2, hh = b.h / 2;
  c.save(); c.translate(b.x + 9, b.y + 11); c.rotate(b.a);
  c.fillStyle = 'rgba(45,35,15,0.3)'; c.fillRect(-hw, -hh, b.w, b.h);
  c.restore();
  c.save(); c.translate(b.x, b.y); c.rotate(b.a);
  c.lineJoin = 'round';
  if (b.kind === 'ruin') {
    c.fillStyle = '#8a7d63'; c.fillRect(-hw, -hh, b.w, b.h);
    c.fillStyle = 'rgba(60,50,35,0.55)';
    for (let i = 0; i < 6; i++) { const u = (b.s * 7 + i * 0.37) % 1, v = (b.s * 3 + i * 0.61) % 1; c.beginPath(); c.arc(-hw + u * b.w, -hh + v * b.h, 6 + 5 * ((i * b.s * 9) % 1), 0, TAU); c.fill(); }
    c.strokeStyle = '#d9d0b6'; c.lineWidth = 7; c.lineCap = 'square';
    const g = 0.25 + b.s * 0.4;   // broken wall line with a gap
    c.beginPath();
    c.moveTo(-hw, -hh + b.h * g); c.lineTo(-hw, -hh); c.lineTo(hw * (0.2 + b.s * 0.5), -hh);
    c.moveTo(hw, -hh + b.h * 0.3); c.lineTo(hw, hh); c.lineTo(-hw * 0.3, hh);
    c.stroke(); c.lineCap = 'butt';
    c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 1.5; c.strokeRect(-hw, -hh, b.w, b.h);
    c.restore(); return;
  }
  const set = ROOFS[b.kind] || ROOFS.house, [lt, dk] = set[Math.floor(b.s * set.length) % set.length];
  // whitewashed wall edge peeking out under the eaves
  c.fillStyle = b.kind === 'barn' ? '#5a4a38' : '#e4dcc4'; c.fillRect(-hw, -hh, b.w, b.h);
  const e = 3;
  c.fillStyle = lt; c.fillRect(-hw + e, -hh + e, b.w - 2 * e, hh - e);
  c.fillStyle = dk; c.fillRect(-hw + e, 0, b.w - 2 * e, hh - e);
  c.strokeStyle = 'rgba(0,0,0,0.18)'; c.lineWidth = 1.5; c.beginPath();
  const stepX = b.kind === 'barn' ? 12 : 7;
  for (let x = -hw + e + stepX; x < hw - e; x += stepX) { c.moveTo(x, -hh + e); c.lineTo(x, hh - e); }
  c.stroke();
  c.strokeStyle = 'rgba(40,30,15,0.6)'; c.lineWidth = 3;
  c.beginPath(); c.moveTo(-hw + e, 0); c.lineTo(hw - e, 0); c.stroke();
  if (b.kind === 'church') {
    c.fillStyle = '#5d7a68'; c.strokeStyle = '#2f3d33'; c.lineWidth = 2;
    c.beginPath(); c.arc(hw * 0.45, 0, hh * 0.62, 0, TAU); c.fill(); c.stroke();
    c.strokeStyle = '#d8c66a'; c.lineWidth = 3; c.beginPath();
    c.moveTo(hw * 0.45 - 9, 0); c.lineTo(hw * 0.45 + 9, 0); c.moveTo(hw * 0.45, -13); c.lineTo(hw * 0.45, 13); c.stroke();
  } else if (b.kind === 'house') {
    c.fillStyle = '#6b5a4a'; c.fillRect(hw * (0.15 + b.s * 0.4), -hh * 0.55, 9, 9);   // chimney
  }
  c.strokeStyle = 'rgba(30,22,10,0.55)'; c.lineWidth = 2; c.strokeRect(-hw, -hh, b.w, b.h);
  c.restore();
}
function drawBuildings() {
  for (const b of BUILDINGS) if (inView(b.x, b.y, b.br + 20)) drawBuilding(ctx, b);
}
function drawTrees() {
  for (const t of decor.trees) {
    if (!inView(t.x, t.y, t.r + 20)) continue;
    ctx.fillStyle = 'rgba(40,35,15,0.25)';
    ctx.beginPath(); ctx.arc(t.x + 7, t.y + 9, t.r, 0, TAU); ctx.fill();
    ctx.fillStyle = t.c;
    ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,200,0.1)';
    ctx.beginPath(); ctx.arc(t.x - t.r * 0.25, t.y - t.r * 0.3, t.r * 0.55, 0, TAU); ctx.fill();
  }
}

function drawBushes() {
  for (const b of decor.bushes) {
    if (!inView(b.x, b.y, 60)) continue;
    ctx.fillStyle = '#6d7440';
    ctx.beginPath();
    for (const [dx, dy, r] of b.blobs) { ctx.moveTo(b.x + dx + r, b.y + dy); ctx.arc(b.x + dx, b.y + dy, r, 0, TAU); }
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,200,0.08)';
    ctx.beginPath();
    for (const [dx, dy, r] of b.blobs) { ctx.moveTo(b.x + dx + r * 0.3, b.y + dy - r * 0.25); ctx.arc(b.x + dx - r * 0.2, b.y + dy - r * 0.25, r * 0.5, 0, TAU); }
    ctx.fill();
  }
}

function drawWrecks() {
  for (let i = wrecks.length - 1; i >= 0; i--) {
    const w = wrecks[i], age = now - w.t;
    if (age > 40) { wrecks.splice(i, 1); continue; }
    if (!inView(w.x, w.y, 120)) continue;
    ctx.save();
    ctx.globalAlpha = age > 30 ? (40 - age) / 10 : 1;
    ctx.translate(w.x, w.y);
    drawTankModel(ctx, w.cls, 'wreck', w.r, w.hullA, w.turA, null, 0, 0);
    ctx.restore();
    if (age < 12 && Math.random() < 0.25) addP(w.x + rand(-8, 8), w.y + rand(-8, 8), rand(-8, 8), rand(-30, -10), rand(1.5, 3), w.r * 0.6, '#3e3a35', 'smoke');
    if (age < 5 && Math.random() < 0.3) addP(w.x + rand(-w.r, w.r) * 0.5, w.y + rand(-w.r, w.r) * 0.5, 0, rand(-30, -10), rand(0.2, 0.5), w.r * 0.35, '#ff9a3c', 'fire');
  }
  ctx.globalAlpha = 1;
}

function hpBar(x, y, w, f, color) {
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  rrect(ctx, x - w / 2 - 2, y - 4, w + 4, 8, 4); ctx.fill();
  ctx.fillStyle = color;
  rrect(ctx, x - w / 2, y - 2, Math.max(4, w * clamp(f, 0, 1)), 4, 2); ctx.fill();
}

function drawObstacle(o) {
  const c = ctx;
  const s = o.grow < 1 ? 0.4 + 0.6 * o.grow : 1;
  const fl = (o.flash || 0) * 0.5, r = o.r;
  c.save();
  c.translate(o.x, o.y);
  c.rotate(o.a);
  c.scale(s, s);
  c.lineWidth = 3; c.lineJoin = 'round';
  if (o.type === 'crate') {
    const h = r * 0.82;
    c.fillStyle = mix('#b38a4c', '#ffffff', fl); c.strokeStyle = '#6e4f24';
    c.beginPath(); c.rect(-h, -h, h * 2, h * 2); c.fill(); c.stroke();
    c.lineWidth = 2.5;
    c.beginPath(); c.rect(-h * 0.7, -h * 0.7, h * 1.4, h * 1.4); c.stroke();
    c.beginPath(); c.moveTo(-h * 0.7, -h * 0.7); c.lineTo(h * 0.7, h * 0.7); c.stroke();
  } else if (o.type === 'drum') {
    c.fillStyle = mix('#a3402f', '#ffffff', fl); c.strokeStyle = '#5c1f15';
    c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill(); c.stroke();
    c.lineWidth = 2; c.strokeStyle = 'rgba(0,0,0,0.3)';
    c.beginPath(); c.arc(0, 0, r * 0.68, 0, TAU); c.stroke();
    c.fillStyle = '#3a2a22'; c.beginPath(); c.arc(r * 0.35, -r * 0.3, r * 0.17, 0, TAU); c.fill();
  } else if (o.type === 'depot') {
    c.fillStyle = mix('#c9b886', '#ffffff', fl); c.strokeStyle = '#86774c'; c.lineWidth = 4;
    ngon(c, 6, r, 0); c.fill(); c.stroke();
    c.lineWidth = 2; c.strokeStyle = 'rgba(100,85,50,0.6)';
    for (let i = 0; i < 6; i++) {
      const a0 = i * TAU / 6, a1 = (i + 1) * TAU / 6;
      for (let k = 1; k < 3; k++) {
        const t = k / 3;
        const px = lerp(Math.cos(a0) * r, Math.cos(a1) * r, t), py = lerp(Math.sin(a0) * r, Math.sin(a1) * r, t);
        c.beginPath(); c.moveTo(px, py); c.lineTo(px * 0.72, py * 0.72); c.stroke();
      }
    }
    c.fillStyle = '#8d7a52'; ngon(c, 6, r * 0.66, 0); c.fill();
    c.fillStyle = mix('#5e6b3a', '#ffffff', fl); c.strokeStyle = '#2f3a1a'; c.lineWidth = 2;
    for (const [dx, dy] of [[-0.25, -0.2], [0.2, -0.22], [-0.02, 0.24]]) {
      c.beginPath(); c.rect(dx * r - r * 0.17, dy * r - r * 0.12, r * 0.34, r * 0.24); c.fill(); c.stroke();
    }
  } else if (o.type === 'bunker') {
    c.fillStyle = mix('#9b998f', '#ffffff', fl); c.strokeStyle = '#5c5a53'; c.lineWidth = 5;
    ngon(c, 8, r, Math.PI / 8); c.fill(); c.stroke();
    c.fillStyle = 'rgba(0,0,0,0.12)'; ngon(c, 8, r * 0.75, Math.PI / 8); c.fill();
    c.restore();
    c.save(); c.translate(o.x, o.y); c.scale(s, s); c.rotate(o.gunA);
    c.fillStyle = '#4e4d47'; c.strokeStyle = '#2b2a26'; c.lineWidth = 4;
    c.beginPath(); c.rect(0, -r * 0.13, r * 1.2, r * 0.26); c.fill(); c.stroke();
    c.fillStyle = mix('#85837a', '#ffffff', fl);
    c.beginPath(); c.arc(0, 0, r * 0.45, 0, TAU); c.fill(); c.stroke();
    c.fillStyle = '#222'; c.fillRect(r * 0.15, -r * 0.24, r * 0.12, r * 0.48);
  }
  c.restore();
  if (o.hp < 0.999) hpBar(o.x, o.y + o.r * s + 10, o.r * 1.6, o.hp, '#86c25a');
}

function drawBullet(b) {
  const T = TEAMS[b.team] || TEAMS.x;
  if (b.kind === 'rocket') {
    ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.a);
    ctx.fillStyle = '#ffb347';
    ctx.beginPath(); ctx.ellipse(-b.r * 2.4, 0, b.r * 1.4 * rand(0.8, 1.2), b.r * 0.7, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = T.bullet; ctx.strokeStyle = '#2b2a26'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 0, b.r * 1.8, b.r * 0.85, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.restore();
    return;
  }
  if (b.kind === 'mg') {
    // tracer streak: glowing line trailing behind the round
    const len = 26 + b.r * 4, ca = Math.cos(b.a), sa = Math.sin(b.a);
    ctx.lineCap = 'round';
    ctx.strokeStyle = b.team === 'su' ? 'rgba(255,90,60,0.35)' : 'rgba(255,200,90,0.35)'; ctx.lineWidth = b.r * 2.6;
    ctx.beginPath(); ctx.moveTo(b.x - ca * len, b.y - sa * len); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = b.team === 'su' ? '#ffb09a' : '#fff0b8'; ctx.lineWidth = Math.max(1.5, b.r * 0.9);
    ctx.beginPath(); ctx.moveTo(b.x - ca * len * 0.7, b.y - sa * len * 0.7); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.lineCap = 'butt';
    return;
  }
  // tank shell: a long, fading tracer trail (red for Soviet rounds, white-yellow for German), a hot
  // glowing core and the projectile itself at the head
  const ca = Math.cos(b.a), sa = Math.sin(b.a), len = 70 + b.r * 9, w = Math.max(2.2, b.r * 0.9);
  const su = b.team === 'su', tx = b.x - ca * len, ty = b.y - sa * len;
  const grad = ctx.createLinearGradient(tx, ty, b.x, b.y);
  grad.addColorStop(0, su ? 'rgba(240,50,25,0)' : 'rgba(255,160,40,0)');
  grad.addColorStop(1, su ? 'rgba(240,60,30,0.7)' : 'rgba(255,165,45,0.7)');
  ctx.lineCap = 'round';
  ctx.strokeStyle = grad; ctx.lineWidth = w * 3;
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
  const core = ctx.createLinearGradient(b.x - ca * len * 0.55, b.y - sa * len * 0.55, b.x, b.y);
  core.addColorStop(0, su ? 'rgba(255,150,120,0)' : 'rgba(255,245,200,0)');
  core.addColorStop(1, su ? '#ffd0bc' : '#fffbe6');
  ctx.strokeStyle = core; ctx.lineWidth = w;
  ctx.beginPath(); ctx.moveTo(b.x - ca * len * 0.55, b.y - sa * len * 0.55); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.a);
  ctx.fillStyle = '#3b3227';
  ctx.beginPath(); ctx.ellipse(0, 0, w * 1.6, w * 0.6, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = su ? '#ff8a5c' : '#ffe9a0';
  ctx.beginPath(); ctx.arc(-w * 1.2, 0, w * 0.55, 0, TAU); ctx.fill();
  ctx.restore();
}

function drawParticles(layer) {
  for (const p of particles) {
    const isTop = p.type === 'smoke' || p.type === 'fire' || p.type === 'flash' || p.type === 'ring';
    if (isTop !== (layer === 'top')) continue;
    if (!inView(p.x, p.y, p.size * 2)) continue;
    const t = p.life / p.max;
    switch (p.type) {
      case 'smoke':
        ctx.globalAlpha = 0.45 * t; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.8 - t), 0, TAU); ctx.fill(); break;
      case 'fire':
        ctx.globalAlpha = Math.min(1, t * 1.5); ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + t * 0.6), 0, TAU); ctx.fill(); break;
      case 'flash':
        ctx.globalAlpha = t; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.2 - t * 0.4), 0, TAU); ctx.fill(); break;
      case 'ring':
        ctx.globalAlpha = t * 0.7; ctx.strokeStyle = p.color; ctx.lineWidth = 4 * t + 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.1 - t), 0, TAU); ctx.stroke(); break;
      case 'spark':
        ctx.globalAlpha = t; ctx.strokeStyle = p.color; ctx.lineWidth = p.size;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04); ctx.stroke(); break;
      case 'debris':
        ctx.globalAlpha = Math.min(1, t * 2); ctx.fillStyle = p.color;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size); ctx.restore(); break;
    }
  }
  ctx.globalAlpha = 1;
}

function drawTankWorld(t) {
  const st = t.st;
  ctx.save();
  ctx.translate(t.x, t.y);
  if (t.inv) ctx.globalAlpha = 0.55 + 0.3 * Math.sin(now * 14);
  drawTankModel(ctx, t.cls, t.team, t.r, t.hullA, t.turA, st ? st.recoil : null, st ? st.phase : 0, st ? st.flash : 0, t.mgRel);
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawLabels(t) {
  const isMe = you && t.id === you.id;
  const ally = you && t.team === you.team;
  const y = t.y - t.r * 1.45 - 6;
  if (!you || ally) {   // enemy crews stay anonymous
    const fs = Math.round(15 + t.r * 0.12);
    ctx.font = `600 ${fs}px Oswald, Impact, sans-serif`;
    const tw = ctx.measureText(t.name).width;
    const tx = t.x + 9;   // shift right to make room for the insignia
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineJoin = 'round';
    ctx.strokeText(t.name, tx, y);
    ctx.fillStyle = isMe ? '#ffffff' : !you ? '#f0ead2' : '#e6f2d8';
    ctx.fillText(t.name, tx, y);
    drawInsignia(ctx, t.team, t.rank, tx - tw / 2 - 10, y - fs * 0.5, fs * 1.05);
  }
  if (t.hp < 0.999 || isMe) hpBar(t.x, t.y + t.r * 1.3 + 8, t.r * 2.2, t.hp, !you || ally ? '#86c25a' : '#d6553f');
}

function updateCamera(dt) {
  let tx = cam.x, ty = cam.y, fov = 1.1, rate = 1.5;
  const me = myTank();
  if (you) {
    fov = you.fov;
    if (me) {
      tx = me.x; ty = me.y; rate = 12;
      if (view2.sight) {
        // push the cursor to the screen edge to pan the sight
        const ex = (mouse.x - W / 2) / (W / 2), ey = (mouse.y - H / 2) / (H / 2);
        const pan = 700 / view2.sightZoom * dt, edge = v => (Math.abs(v) > 0.82 ? Math.sign(v) * (Math.abs(v) - 0.82) / 0.18 : 0);
        view2.offX += edge(ex) * pan; view2.offY += edge(ey) * pan;
        const d = Math.hypot(view2.offX, view2.offY), lim = 1500;
        if (d > lim) { view2.offX *= lim / d; view2.offY *= lim / d; }
        tx += view2.offX; ty += view2.offY; rate = 14;
      }
    } else if (view2.sight) view2.sight = false;
  } else if (sp != null) {
    const f = vTanks.find(t => t.id === sp);
    if (f) { tx = f.x; ty = f.y; }
  }
  const k = 1 - Math.exp(-dt * rate);
  cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
  const zoom = view2.sight ? view2.sightZoom : state === 'play' ? view2.zoom : 1;
  const target = Math.max(W, H * 16 / 9) / (VIEW_W * fov) * zoom;
  cam.scale += (target - cam.scale) * (1 - Math.exp(-dt * (view2.sight ? 9 : 5)));
  cam.shake = Math.max(0, cam.shake - dt * 30);
}

// gunner's sight: dark scope vignette and a German-style triangle reticle at the cursor
function drawSightOverlay() {
  const R = Math.min(W, H) * 0.47, cx = W / 2, cy = H / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(8,8,6,0.82)';
  ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.arc(cx, cy, R, 0, TAU, true); ctx.fill();
  const g = ctx.createRadialGradient(cx, cy, R * 0.75, cx, cy, R);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(20,20,15,0.9)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
  // reticle: big aiming triangle on the cursor, smaller ones either side, fine horizontal bar
  const mx = mouse.x, my = mouse.y, s = 16;
  const tri = (x, y, h) => { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - h * 0.55, y + h); ctx.lineTo(x + h * 0.55, y + h); ctx.closePath(); ctx.fill(); };
  ctx.fillStyle = 'rgba(15,15,12,0.92)';
  tri(mx, my, s * 1.6);
  for (const k of [1, 2, 3]) { tri(mx - k * s * 2.6, my, s * 0.8); tri(mx + k * s * 2.6, my, s * 0.8); }
  ctx.strokeStyle = 'rgba(15,15,12,0.85)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(mx - s * 10, my + s * 0.8); ctx.lineTo(mx - s * 1.3, my + s * 0.8);
  ctx.moveTo(mx + s * 1.3, my + s * 0.8); ctx.lineTo(mx + s * 10, my + s * 0.8); ctx.stroke();
  ctx.restore();
  hudText(`×${view2.sightZoom.toFixed(1)}`, cx + R * 0.62, cy + R * 0.72, 18, '#e8e0c0');
  hudText('SHIFT — leave sight · WHEEL — magnification', cx, cy + R + 22 > H - 120 ? 96 : cy + R + 22, 12, '#b9b195', 'center', 400);
}

function render() {
  const sc = cam.scale;
  const shx = cam.shake ? rand(-cam.shake, cam.shake) * 0.5 : 0, shy = cam.shake ? rand(-cam.shake, cam.shake) * 0.5 : 0;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#857d52';
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(DPR * sc, 0, 0, DPR * sc, DPR * (W / 2 - cam.x * sc + shx), DPR * (H / 2 - cam.y * sc + shy));
  view = { x0: cam.x - W / 2 / sc, x1: cam.x + W / 2 / sc, y0: cam.y - H / 2 / sc, y1: cam.y + H / 2 / sc };

  drawGround();
  drawPoints();
  drawMarks();
  drawWrecks();
  drawBuildings();
  drawParticles('bottom');
  for (const o of vObs) if (inView(o.x, o.y, o.r * 1.5)) drawObstacle(o);
  for (const b of vBullets) if (inView(b.x, b.y, 30)) drawBullet(b);
  for (const t of vTanks) if (inView(t.x, t.y, t.r * 4)) drawTankWorld(t);
  drawBushes();
  drawTrees();
  drawParticles('top');
  for (const t of vTanks) if (inView(t.x, t.y, t.r * 4)) drawLabels(t);

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  for (const tx of texts) {
    const age = now - tx.t;
    ctx.globalAlpha = clamp(1.4 - age, 0, 1);
    ctx.font = `600 ${tx.size}px Oswald, Impact, sans-serif`;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(tx.text, tx.x, tx.y - age * 30);
    ctx.fillStyle = tx.color; ctx.fillText(tx.text, tx.x, tx.y - age * 30);
  }
  ctx.globalAlpha = 1;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (view2.sight && state === 'play') drawSightOverlay();
  drawHUD();
}

// =====================================================================
// HUD
// =====================================================================
// Rank insignia, centred on (x, y), about s pixels tall. German: shoulder straps (Panzer pink piping;
// NCO braid, officers' silver cord, gold pips) and sleeve chevrons for the lowest ranks. Soviet: 1943
// pogony with crimson stripes and gold stars.
function drawInsignia(c, team, rank, x, y, s) {
  if (rank == null || rank < 0) return;
  const w = s * 0.46, h = s, x0 = x - w / 2, y0 = y - h / 2;
  c.save(); c.lineJoin = 'round'; c.lineCap = 'round';
  const pip = (px, py, r, col) => { c.fillStyle = col; c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 1; c.fillRect(px - r, py - r, r * 2, r * 2); c.strokeRect(px - r, py - r, r * 2, r * 2); };
  const star = (px, py, r) => {
    c.fillStyle = '#f2cf4a'; c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = 0.8; c.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; c.lineTo(px + Math.cos(a) * rr, py + Math.sin(a) * rr); }
    c.closePath(); c.fill(); c.stroke();
  };
  const strap = (fill, edge) => {
    c.fillStyle = fill; c.strokeStyle = edge; c.lineWidth = Math.max(1.5, s * 0.1);
    c.beginPath(); c.moveTo(x0, y0 + h); c.lineTo(x0, y0 + w * 0.5); c.lineTo(x, y0); c.lineTo(x0 + w, y0 + w * 0.5); c.lineTo(x0 + w, y0 + h); c.closePath();
    c.fill(); c.stroke();
    c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 1; c.stroke();
  };
  if (team === 'de') {
    if (rank <= 1) {        // Gefreiter / Obergefreiter: silver sleeve chevrons
      c.strokeStyle = 'rgba(0,0,0,0.75)'; c.lineWidth = s * 0.26;
      for (let k = 0; k <= rank; k++) { const yy = y - s * 0.2 + k * s * 0.3; c.beginPath(); c.moveTo(x - s * 0.32, yy - s * 0.2); c.lineTo(x, yy + s * 0.1); c.lineTo(x + s * 0.32, yy - s * 0.2); c.stroke(); }
      c.strokeStyle = '#d6d8d4'; c.lineWidth = s * 0.13;
      for (let k = 0; k <= rank; k++) { const yy = y - s * 0.2 + k * s * 0.3; c.beginPath(); c.moveTo(x - s * 0.32, yy - s * 0.2); c.lineTo(x, yy + s * 0.1); c.lineTo(x + s * 0.32, yy - s * 0.2); c.stroke(); }
    } else if (rank <= 3) { // Unteroffizier / Feldwebel: dark strap, pink piping, silver braid
      strap('#3e464a', '#e48aa6');
      c.strokeStyle = '#cfd2cc'; c.lineWidth = Math.max(1.2, s * 0.09);
      c.beginPath(); c.moveTo(x0 + s * 0.08, y0 + w * 0.55); c.lineTo(x0 + s * 0.08, y0 + h - s * 0.08); c.lineTo(x0 + w - s * 0.08, y0 + h - s * 0.08); c.lineTo(x0 + w - s * 0.08, y0 + w * 0.55); c.stroke();
      if (rank === 3) pip(x, y + s * 0.08, s * 0.07, '#cfd2cc');
    } else {                // officers: silver cord, gold pips
      strap('#b9bdb6', '#e48aa6');
      c.strokeStyle = 'rgba(80,80,80,0.6)'; c.lineWidth = 1; c.beginPath();
      for (let k = 0; k < 4; k++) { const yy = y0 + w * 0.6 + k * h * 0.17; c.moveTo(x0 + 1, yy); c.lineTo(x0 + w - 1, yy + h * 0.08); }
      c.stroke();
      if (rank >= 5) pip(x, y + s * 0.05, s * 0.075, '#e8c34a');
      if (rank >= 6) pip(x, y + s * 0.3, s * 0.075, '#e8c34a');
    }
  } else {
    strap('#8a8455', '#b5282c');
    c.strokeStyle = '#b5282c';
    if (rank <= 1) {        // junior sergeant / sergeant: 2 / 3 narrow transverse stripes
      c.lineWidth = Math.max(1.2, s * 0.08);
      for (let k = 0; k <= rank + 1; k++) { const yy = y + s * 0.05 + k * s * 0.13; c.beginPath(); c.moveTo(x0 + 1, yy); c.lineTo(x0 + w - 1, yy); c.stroke(); }
    } else if (rank <= 3) { // senior sergeant: one wide stripe; starshina: wide stripe + a long one
      c.lineWidth = s * 0.17; c.lineCap = 'butt';
      c.beginPath(); c.moveTo(x0 + 1, y + s * 0.18); c.lineTo(x0 + w - 1, y + s * 0.18); c.stroke();
      if (rank === 3) { c.lineWidth = s * 0.12; c.beginPath(); c.moveTo(x, y0 + w * 0.5); c.lineTo(x, y + s * 0.1); c.stroke(); }
    } else {                // officers: one crimson line, 2 / 3 / 4 stars
      c.lineWidth = Math.max(1, s * 0.06); c.lineCap = 'butt';
      c.beginPath(); c.moveTo(x, y0 + w * 0.45); c.lineTo(x, y0 + h - 1); c.stroke();
      const r = s * 0.1;
      if (rank === 4) { star(x - w * 0.27, y + s * 0.2, r); star(x + w * 0.27, y + s * 0.2, r); }
      else if (rank === 5) { star(x - w * 0.27, y + s * 0.25, r); star(x + w * 0.27, y + s * 0.25, r); star(x, y - s * 0.05, r); }
      else { star(x - w * 0.27, y + s * 0.3, r); star(x + w * 0.27, y + s * 0.3, r); star(x, y + s * 0.03, r); star(x, y - s * 0.22, r); }
    }
  }
  c.restore();
}
function hudText(s, x, y, size, color, align = 'center', weight = 600) {
  ctx.font = `${weight} ${size}px Oswald, Impact, sans-serif`;
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, size * 0.22); ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color; ctx.fillText(s, x, y);
}
function pill(x, y, w, h, f, color) {
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  rrect(ctx, x, y, w, h, h / 2); ctx.fill();
  if (f > 0) {
    ctx.fillStyle = color;
    rrect(ctx, x + 2, y + 2, Math.max(h - 4, (w - 4) * clamp(f, 0, 1)), h - 4, (h - 4) / 2); ctx.fill();
  }
}

function drawPointIcon(i, x, y, R) {
  const [prog, ow, contested, active] = cps[i] || [0, 0, 0, 0];
  const owner = OWNER[ow];
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath(); ctx.arc(x, y, R + 3, 0, TAU); ctx.fill();
  ctx.globalAlpha = active ? 1 : 0.45;
  ctx.fillStyle = owner ? ptColor(owner) : '#59553f';
  ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
  if (Math.abs(prog) > 0.01 && Math.abs(prog) < 0.999) {
    ctx.strokeStyle = ptColor(prog > 0 ? 'de' : 'su'); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, R + 1.5, -Math.PI / 2, -Math.PI / 2 + TAU * Math.abs(prog)); ctx.stroke();
  }
  if (contested) {
    ctx.strokeStyle = `rgba(255,90,60,${0.5 + 0.5 * Math.sin(now * 10)})`; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, R + 5, 0, TAU); ctx.stroke();
  }
  hudText(CAP_POINTS[i].id, x, y + 1, R * 0.95, '#fff');
  ctx.globalAlpha = 1;
  if (active) {
    ctx.strokeStyle = 'rgba(246,226,122,0.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, R + 6, 0, TAU); ctx.stroke();
  }
}

function drawHUD() {
  const cx = W / 2;
  // ---- battle status: both attack lines converging on O1, and both sides' reserves ----
  const myTeam = you ? you.team : null;
  {
    const step = 40, rowY = [24, 62], midY = 43;
    const x0 = cx - (5 * step + 20) / 2;
    const iconX = k => x0 + k * step;
    const ox = x0 + 5 * step + 14;
    LINES.forEach((L, li) => {
      const y = rowY[li], dead = isLineDead(L);
      ctx.strokeStyle = dead ? 'rgba(220,70,50,0.6)' : 'rgba(230,220,190,0.4)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(iconX(0), y); ctx.lineTo(iconX(4), y); ctx.lineTo(ox, midY); ctx.stroke();
      CAP_POINTS.forEach((p, i) => { if (p.line === L) drawPointIcon(i, iconX(p.k), y, 14); });
      if (dead) {
        ctx.strokeStyle = 'rgba(230,70,50,0.9)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(iconX(0) - 18, y); ctx.lineTo(iconX(4) + 18, y); ctx.stroke();
        hudText('DEFEATED', iconX(2), y, 13, '#ff8a6a');
      }
    });
    drawPointIcon(O_IDX, ox, midY, 17);
    // reserves, one row per side, right-aligned against the objective panel
    const rx = x0 - 34;
    ['de', 'su'].forEach((team, ti) => {
      const r = rsv[ti], y = rowY[ti];
      let x = rx;
      ctx.font = '400 13px Oswald, Impact, sans-serif';
      for (let k = CATS.length - 1; k >= 0; k--) {
        if (!RESERVES[team][k]) continue;
        const txt = `${CATS[k].short} ${r[k]}`;
        hudText(txt, x, y, 13, r[k] <= 0 ? '#ff7a5c' : team === myTeam ? '#f6e27a' : '#e8e0c0', 'right', 400);
        x -= ctx.measureText(txt).width + 12;
      }
      hudText(TEAMS[team].label, x - 4, y, 13, TEAMS[team].mini, 'right', 600);
    });
    if (myTeam) hudText(myTeam === ATTACKER ? 'ATTACK' : 'DEFEND', ox + 34, midY, 20, myTeam === ATTACKER ? '#f6e27a' : '#d9e3ea', 'left');
  }

  // ---- kill feed: top right, plain outlined text, newest on top ----
  let fy = 22;
  const fx = W - 16;
  for (let i = feed.length - 1; i >= 0; i--) {
    const f = feed[i], age = now - f.t;
    if (age > 8) continue;
    ctx.globalAlpha = clamp(8 - age, 0, 1);
    ctx.font = '400 15px Oswald, Impact, sans-serif';
    const kText = f.kc ? `${f.kn} (${f.kc})` : f.kn, vText = f.vc ? `${f.vn} (${f.vc})` : f.vn;
    const kIns = f.kt && f.kr >= 0 && f.kr !== undefined ? 16 : 0, vIns = f.vt && f.vr >= 0 && f.vr !== undefined && !f.sym ? 16 : 0;
    const lw = ctx.measureText(kText).width, rw = ctx.measureText(vText).width;
    const x0 = fx - (kIns + lw + 34 + vIns + rw);
    if (kIns) drawInsignia(ctx, f.kt, f.kr, x0 + 5, fy, 15);
    hudText(kText, x0 + kIns, fy, 15, f.kt ? TEAMS[f.kt].mini : '#d9b46b', 'left', 400);
    hudText(f.sym || '✕', x0 + kIns + lw + 17, fy, 14, '#e0d6b0', 'center', 400);
    if (vIns) drawInsignia(ctx, f.vt, f.vr, fx - rw - 11, fy, 15);
    hudText(vText, fx, fy, 15, f.vt ? TEAMS[f.vt].mini : '#bbb', 'right', 400);
    fy += 24;
  }
  ctx.globalAlpha = 1;

  if (msg.text && now - msg.t < msg.dur) {
    const age = now - msg.t;
    ctx.globalAlpha = clamp(msg.dur - age, 0, 1) * clamp(age * 6, 0, 1);
    hudText(msg.text, cx, H * 0.24, 30, '#f3ead0');
    ctx.globalAlpha = 1;
  }

  // ---- end-of-battle banner ----
  if (phase) {
    const [w, secs] = phase, wt = OWNER[w];
    const title = !myTeam ? `${TEAMS[wt].name.toUpperCase()} VICTORIOUS` : wt === myTeam ? 'VICTORY' : 'DEFEAT';
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, H * 0.36, W, 120);
    hudText(title, cx, H * 0.36 + 46, 58, !myTeam ? '#f3ead0' : wt === myTeam ? '#f6e27a' : '#e0573f');
    hudText(`${wt === ATTACKER ? `${TEAMS[wt].name} breaks through to ${CAP_POINTS[CAP_POINTS.length - 1].name}` : `${TEAMS[wt].name} holds the line`} · next battle in ${secs}s · press T to switch sides`,
      cx, H * 0.36 + 94, 17, '#e8e0c0', 'center', 400);
  }

  drawMinimap();
  if (connected) hudText(`${Math.round(ping)} ms`, W - 14, H - Math.min(170, W * 0.22) - 32, 12, '#e8e0c0', 'right', 400);

  if (you && state === 'play') {
    const cls = clsByIdx(you.c);
    const bw = Math.min(420, W - 340), bx = cx - bw / 2, by = H - 64;
    {
      ctx.font = '600 30px Oswald, Impact, sans-serif';
      const nw = ctx.measureText(playerName).width;
      hudText(playerName, cx + 12, by - 34, 30, '#ffffff');
      drawInsignia(ctx, you.team, you.rank, cx + 12 - nw / 2 - 16, by - 34, 28);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; rrect(ctx, bx, by - 8, bw, 42, 8); ctx.fill();
    hudText(`${Z.RANKS[you.team][you.rank || 0][1]}  ·  ${cls.name}  ·  ${cls.role}`, cx, by + 5, 16, '#fff');
    hudText(`Score ${fmt(you.score || 0)}   ·   Kills ${you.kills}   ·   Deaths ${you.deaths || 0}`, cx, by + 23, 12, '#e8e0c0', 'center', 400);
    if (autofire) hudText('AUTOFIRE', cx + bw / 2 - 8, by - 34, 13, '#f6e27a', 'right');

    const me = myTank();
    // ---- capture status while standing in a zone ----
    if (me) {
      const i = CAP_POINTS.findIndex(p => Math.hypot(me.x - p.x, me.y - p.y) < CAP_R);
      if (i >= 0) {
        const p = CAP_POINTS[i], [prog, ow, contested, active] = cps[i], owner = OWNER[ow];
        const mine = you.team === 'de' ? prog : -prog;       // -1 enemy .. +1 ours
        let text, col = '#f3ead0';
        const canMe = you.team === ATTACKER ? cps[i][6] : cps[i][7];
        const need = you.team === ATTACKER ? CAP_POINTS[i].prev.map(j => CAP_POINTS[j].id).join(' or ') : CAP_POINTS[CAP_POINTS[i].next] ? CAP_POINTS[CAP_POINTS[i].next].id : '';
        if (p.line && isLineDead(p.line)) { text = `LINE ${p.line} DEFEATED`; col = '#ff8a6a'; }
        else if (!active || (!canMe && owner !== you.team)) {
          text = owner === you.team ? `${p.id} SECURE` : `${p.id} LOCKED — hold ${need} first`;
          col = '#b9b195';
        } else if (contested) { text = `CONTESTED — ${p.id} · even numbers`; col = '#ff8a6a'; }
        else if (((you.team === 'de' ? cps[i][4] : cps[i][5]) || 0) < ((you.team === 'de' ? cps[i][5] : cps[i][4]) || 0)) {
          text = `OUTNUMBERED — ${p.id}`; col = '#ff8a6a';
        }
        else if (owner === you.team && mine >= 0.999) text = `HOLDING ${p.id} · ${p.name}`;
        else if (owner === you.team) text = `SECURING ${p.id}`;
        else if (owner) text = `NEUTRALIZING ${p.id}`;
        else text = `CAPTURING ${p.id} · ${p.name}`;
        const sw = 260, sy = by - 92;
        hudText(text, cx, sy, 17, col);
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; rrect(ctx, cx - sw / 2, sy + 12, sw, 10, 5); ctx.fill();
        ctx.fillStyle = ptColor(mine >= 0 ? you.team : (you.team === 'de' ? 'su' : 'de'));
        if (mine >= 0) ctx.fillRect(cx, sy + 14, (sw / 2 - 2) * mine, 6);
        else ctx.fillRect(cx + (sw / 2 - 2) * mine, sy + 14, -(sw / 2 - 2) * mine, 6);
        ctx.fillStyle = '#fff'; ctx.fillRect(cx - 1, sy + 11, 2, 12);
      }
    }

    const mx = mouse.x, my = mouse.y;
    ctx.strokeStyle = view2.sight ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(mx, my, 10, 0, TAU);
    ctx.moveTo(mx - 18, my); ctx.lineTo(mx - 6, my); ctx.moveTo(mx + 6, my); ctx.lineTo(mx + 18, my);
    ctx.moveTo(mx, my - 18); ctx.lineTo(mx, my - 6); ctx.moveTo(mx, my + 6); ctx.lineTo(mx, my + 18);
    ctx.stroke();
    // ---- reload ring ----
    if (cls.guns[0].kind !== 'mg') {
      const rl = you.rl || 0;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath(); ctx.arc(mx, my, 24, 0, TAU); ctx.stroke();
      ctx.strokeStyle = rl > 0 ? '#e6a03c' : '#7fd46a';
      ctx.beginPath(); ctx.arc(mx, my, 24, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - rl)); ctx.stroke();
      if (rl > 0) hudText('LOADING', mx, my + 38, 11, '#e6a03c', 'center', 400);
    }
    if (me) {
      // ---- aim line: from the main gun's muzzle to the cursor ----
      const ga = me.turA, c0 = me.cls, g0 = c0.guns[0], sc = cam.scale;
      const pv = (c0.style === 'casemate' ? c0.caseX : c0.turretX) * me.r;
      const wx = me.x + Math.cos(me.hullA) * pv + Math.cos(ga) * g0.len * me.r;
      const wy = me.y + Math.sin(me.hullA) * pv + Math.sin(ga) * g0.len * me.r;
      const bx = W / 2 + (wx - cam.x) * sc, by2 = H / 2 + (wy - cam.y) * sc;
      const dx = mx - bx, dy = my - by2, dist = Math.hypot(dx, dy);
      const off = Math.abs(angDiff(Math.atan2(dy, dx), ga));
      const onTarget = off < 0.035;
      if (dist > 30) {
        // only the line the barrel is actually laid on, out to the cursor's range
        const wd = dist / sc, ex = wx + Math.cos(ga) * wd, ey = wy + Math.sin(ga) * wd;
        // stopped by a house, or a crate/drum/depot in the way?
        let f = Z.bldRay(wx, wy, ex, ey);
        for (const o of vObs) {
          const ox = o.x - wx, oy = o.y - wy, along = ox * Math.cos(ga) + oy * Math.sin(ga);
          if (along < 0 || along > wd * f) continue;
          const perp = ox * Math.sin(ga) - oy * Math.cos(ga);
          if (Math.abs(perp) < o.r) f = Math.min(f, (along - Math.sqrt(o.r * o.r - perp * perp)) / wd);
        }
        const blocked = f < 0.999, ld = dist * Math.max(0, f);
        const gx = bx + Math.cos(ga) * ld, gy = by2 + Math.sin(ga) * ld;
        // plain grey line; amber while the turret is still traversing; red and cut short when blocked
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = blocked ? 'rgba(235,60,45,0.9)' : onTarget ? 'rgba(200,200,200,0.6)' : 'rgba(255,190,90,0.8)';
        ctx.beginPath(); ctx.moveTo(bx, by2); ctx.lineTo(gx, gy); ctx.stroke();
        if (blocked) {
          ctx.lineWidth = 2.5; ctx.beginPath();
          ctx.moveTo(gx - 6, gy - 6); ctx.lineTo(gx + 6, gy + 6); ctx.moveTo(gx + 6, gy - 6); ctx.lineTo(gx - 6, gy + 6);
          ctx.stroke();
        }
      }
      if (c0.mgs) {
        // which MGs can bear on the cursor right now (bright) vs. out of their arc (dim)
        const parts = c0.mgs.map((m, i) => ({ text: `${m.pos} ${m.name}`, on: (you.mb >> i) & 1 }));
        ctx.font = '400 11px Oswald, Impact, sans-serif';
        const widths = parts.map(p => ctx.measureText(p.text).width), gap = 10;
        let x = mx - (widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1)) / 2;
        parts.forEach((p, i) => {
          hudText(p.text, x + widths[i] / 2, my - 36, 11, p.on ? (mouse.rdown ? '#ffe9a8' : '#e8e0c0') : 'rgba(170,165,150,0.45)', 'center', 400);
          x += widths[i] + gap;
        });
      }
    }
  }
}

function drawMinimap() {
  const s = Math.min(170, W * 0.22), x = W - s - 12, y = H - s - 12, k = s / WORLD;
  ctx.fillStyle = 'rgba(40,36,22,0.7)'; ctx.fillRect(x - 3, y - 3, s + 6, s + 6);
  ctx.fillStyle = 'rgba(184,174,121,0.85)'; ctx.fillRect(x, y, s, s);
  ctx.fillStyle = 'rgba(70,58,38,0.6)';
  for (const b of BUILDINGS) ctx.fillRect(x + b.x * k - 1, y + b.y * k - 1, 2, 2);
  for (const r of REARS) {
    ctx.fillStyle = r.line && isLineDead(r.line) ? 'rgba(60,40,30,0.35)' : r.team === 'de' ? 'rgba(80,95,108,0.6)' : 'rgba(160,50,35,0.5)';
    ctx.beginPath(); ctx.arc(x + r.x * k, y + r.y * k, 380 * k, 0, TAU); ctx.fill();
  }
  drawRoute(ctx, k, x, y, 2);
  CAP_POINTS.forEach((p, i) => {
    const owner = OWNER[(cps[i] || [])[1]];
    ctx.globalAlpha = cps[i] && cps[i][3] ? 0.95 : 0.45;
    ctx.fillStyle = owner ? ptColor(owner) : '#6d6a55';
    ctx.beginPath(); ctx.arc(x + p.x * k, y + p.y * k, Math.max(6, CAP_R * k), 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    if (cps[i] && cps[i][2]) {
      ctx.strokeStyle = `rgba(255,90,60,${0.5 + 0.5 * Math.sin(now * 10)})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x + p.x * k, y + p.y * k, Math.max(6, CAP_R * k) + 2, 0, TAU); ctx.stroke();
    }
    hudText(p.id, x + p.x * k, y + p.y * k + 0.5, 10, '#fff', 'center', 600);
  });
  if (you) {
    for (const t of vTanks) {
      if (t.id === you.id || t.team !== you.team) continue;
      ctx.fillStyle = TEAMS[t.team].mini;
      ctx.beginPath(); ctx.arc(x + t.x * k, y + t.y * k, 2.5, 0, TAU); ctx.fill();
    }
    const me = myTank();
    if (me) {
      ctx.save(); ctx.translate(x + me.x * k, y + me.y * k); ctx.rotate(me.hullA);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
      polyPath(ctx, [6, 0, -4, -4, -2, 0, -4, 4]); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
  ctx.strokeRect(x + view.x0 * k, y + view.y0 * k, (view.x1 - view.x0) * k, (view.y1 - view.y0) * k);
}

// =====================================================================
// Player actions
// =====================================================================
let playerName = 'Commander', playerTeam = 'de';
let inputT = 0;
// chosen vehicle per side, remembered between sessions
const selCls = { de: START_CLASS.de, su: START_CLASS.su };
function sendInput(dt) {
  inputT -= dt;
  if (inputT > 0 || state !== 'play' || !you || !you.alive) return;
  inputT = INPUT_RATE;
  // hull-relative: W/S throttle, A/D (or ←/→) steer the hull
  const k = c => (keys.has(c) ? 1 : 0);
  const th = (k('w') || k('arrowup')) - (k('s') || k('arrowdown'));
  const rot = (k('d') || k('arrowright')) - (k('a') || k('arrowleft'));
  const ax = cam.x + (mouse.x - W / 2) / cam.scale, ay = cam.y + (mouse.y - H / 2) / cam.scale;
  send({ t: 'in', th, rot, ax: Math.round(ax), ay: Math.round(ay), f: mouse.down || autofire ? 1 : 0, m: mouse.rdown ? 1 : 0, cx: Math.round(cam.x), cy: Math.round(cam.y) });
}

// switch sides: only allowed in the break between battles
function switchSides() {
  if (!you || !phase) { if (you) bigMessage('You can only switch sides between battles', 2); return; }
  playerTeam = playerTeam === 'de' ? 'su' : 'de';
  send({ t: 'switch', c: selCls[playerTeam] });
  try { localStorage.setItem('zitadelle.team', playerTeam); } catch (e) { /* ignore */ }
  ui.spSig = '';
  if (state === 'dead') buildPicker(ui.deathPicker, playerTeam);
}
function deploy(team) {
  if (!connected) return;
  playerTeam = team;
  saveSel();
  if (state === 'dead' && you) send({ t: 'respawn', team, sp: spawnSel == null ? undefined : spawnSel, c: selCls[team] });
  else {
    send({ t: 'join', name: playerName, team, c: selCls[team] });
    // first spawn into a battle already under way: play your side's intro (during the break it waits for the next battle)
    if (!phase) Music.play('intro', team);
  }
  state = 'play';
  autofire = false;
  document.body.classList.add('playing');
  ui.menu.classList.add('hidden'); ui.death.classList.add('hidden');
  Sound.init();
}
function backToMenu() {
  state = 'menu';
  document.body.classList.remove('playing');
  ui.death.classList.add('hidden');
  ui.menu.classList.remove('hidden');
  buildPicker(ui.menuPicker, playerTeam);
}
function onPlayerDeath(e) {
  state = 'dead';
  document.body.classList.remove('playing');
  mouse.down = false;
  document.getElementById('dkiller').innerHTML =
    `Knocked out by <b style="color:${e.kt ? TEAMS[e.kt].mini : '#d9b46b'}">${escapeHtml(e.kn)}</b>${e.kc ? ' &middot; ' + escapeHtml(e.kc) : ''}`;
  document.getElementById('dscore').textContent = fmt(e.score);
  document.getElementById('ddeaths').textContent = e.deaths;
  document.getElementById('dkills').textContent = e.kills;
  document.getElementById('dtime').textContent = `${Math.floor(e.secs / 60)}:${String(e.secs % 60).padStart(2, '0')}`;
  ui.spSig = '';
  buildPicker(ui.deathPicker, playerTeam);
  setTimeout(() => { if (state === 'dead') ui.death.classList.remove('hidden'); }, 1300);
}

// =====================================================================
// DOM UI
// =====================================================================
const ui = {
  menu: document.getElementById('menu'),
  death: document.getElementById('death'),
  menuPicker: document.getElementById('menupick'),
  deathPicker: document.getElementById('deathpick'),
  status: document.getElementById('status'),
  deployBtn: document.getElementById('deploy'),
  spawns: document.getElementById('spawns'),
  spSig: '',
};
function setStatus(text) {
  ui.status.textContent = text;
  ui.deployBtn.disabled = !!text;
}

// Vehicle picker: every vehicle of the chosen side, grouped by role. Used on the menu and the death screen.
function sideClasses(team) {
  return CLASS_IDS.filter(id => CLASSES[id].faction === team && CLASSES[id].enabled)
    .sort((a, b) => CLASSES[a].cat - CLASSES[b].cat || CLASSES[a].idx - CLASSES[b].idx);
}
function pickerDetail(el, id) {
  const c = CLASSES[id];
  const left = rsv[c.faction === 'de' ? 0 : 1][c.cat];
  el.querySelector('.vdetail').innerHTML = `<b>${escapeHtml(c.name)}</b> <span class="vrole">${CATS[c.cat].name} · ${left} in reserve</span><br>${escapeHtml(c.desc)}<br>` +
    `<span class="vsub">${Z.STEER_INFO[c.steer]}${c.mgs ? ' ' + Z.mgSummary(c) : ''}</span>`;
}
function buildPicker(el, team) {
  if (!el) return;
  if (!CLASSES[selCls[team]] || CLASSES[selCls[team]].faction !== team || !CLASSES[selCls[team]].enabled) selCls[team] = START_CLASS[team];
  el.innerHTML = '<div class="vgrid"></div><div class="vdetail"></div>';
  const grid = el.querySelector('.vgrid');
  for (const id of sideClasses(team)) {
    const b = document.createElement('button');
    b.className = 'veh' + (id === selCls[team] ? ' sel' : '');
    b.dataset.id = id;
    b.innerHTML = `<canvas width="160" height="120"></canvas><span>${escapeHtml(CLASSES[id].name)}</span><em class="vcat"></em>`;
    b.title = CATS[CLASSES[id].cat].name;
    b.addEventListener('click', () => {
      if (b.classList.contains('empty')) return;
      selCls[team] = id; saveSel();
      grid.querySelectorAll('.veh').forEach(v => v.classList.toggle('sel', v.dataset.id === id));
      pickerDetail(el, id);
      updateFactionLabels();
    });
    b.addEventListener('mouseenter', () => pickerDetail(el, id));
    b.addEventListener('mouseleave', () => pickerDetail(el, selCls[team]));
    grid.appendChild(b);
    drawPreview(b.querySelector('canvas'), id, team, 0);
  }
  pickerDetail(el, selCls[team]);
  el.dataset.team = team; el.dataset.sig = '';
  refreshPicker(el);
}
// keep the reserve badges current; an empty category can't be picked
function refreshPicker(el) {
  if (!el || !el.dataset.team) return;
  const team = el.dataset.team, r = rsv[team === 'de' ? 0 : 1];
  const sig = r.join(',');
  if (sig === el.dataset.sig) return;
  el.dataset.sig = sig;
  el.querySelectorAll('.veh').forEach(b => {
    const c = CLASSES[b.dataset.id], n = r[c.cat];
    b.querySelector('.vcat').textContent = `${CATS[c.cat].short} · ${n}`;
    b.classList.toggle('empty', n <= 0);
  });
  const cur = CLASSES[selCls[team]];
  if (cur && r[cur.cat] <= 0) {
    const alt = sideClasses(team).find(id => r[CLASSES[id].cat] > 0);
    if (alt) { selCls[team] = alt; el.querySelectorAll('.veh').forEach(v => v.classList.toggle('sel', v.dataset.id === alt)); updateFactionLabels(); }
  }
  pickerDetail(el, selCls[team]);
}
function saveSel() {
  try { localStorage.setItem('zitadelle.cls', JSON.stringify(selCls)); } catch (e) { /* ignore */ }
}
function updateFactionLabels() {
  factionBtns.forEach(b => { b.querySelector('small').textContent = CLASSES[selCls[b.dataset.team]].name; });
}
// redeploy picker: a rear assembly area (spawn code -1-k), or any held objective that's safe
let spawnSel = null;
function updateSpawnUI() {
  // mirrors the server's spawnOk (enemy proximity is only checked there)
  const owned = i => {
    const p = CAP_POINTS[i], c = cps[i];
    if (OWNER[c[1]] !== playerTeam || c[2] || (p.line && isLineDead(p.line))) return false;
    if (playerTeam === DEFENDER && (c[3] || p.prev.some(j => cps[j][3]))) return false;
    return true;
  };
  const rears = REARS.map((r, k) => ({ r, k })).filter(o => o.r.team === playerTeam);
  const rearOk = o => !(o.r.line && isLineDead(o.r.line));
  if (spawnSel != null && spawnSel >= 0 && !owned(spawnSel)) spawnSel = null;
  if (spawnSel != null && spawnSel < 0 && !rearOk(rears.find(o => -1 - o.k === spawnSel) || { r: { line: 'A' } })) spawnSel = null;
  if (spawnSel == null) { const o = rears.find(rearOk); spawnSel = o ? -1 - o.k : null; }
  const sig = playerTeam + spawnSel + lineDead.join('') + cps.map(c => c[1] + '' + c[2] + c[3]).join('');
  if (sig === ui.spSig) return;
  ui.spSig = sig;
  let html = '';
  for (const o of rears) {
    const code = -1 - o.k;
    html += `<button data-i="${code}" class="${spawnSel === code ? 'sel' : ''}" ${rearOk(o) ? '' : 'disabled'}>${escapeHtml(o.r.name)}<small>${rearOk(o) ? 'assembly area' : 'lost'}</small></button>`;
  }
  CAP_POINTS.forEach((p, i) => {
    html += `<button data-i="${i}" class="${spawnSel === i ? 'sel' : ''}" ${owned(i) ? '' : 'disabled'}>${p.id}<small>${escapeHtml(p.name)}</small></button>`;
  });
  ui.spawns.innerHTML = html;
  ui.spawns.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { spawnSel = +b.dataset.i; ui.spSig = ''; }));
}

function updateUI() {
  if (state === 'dead') {
    updateSpawnUI(); refreshPicker(ui.deathPicker);
    const b = document.getElementById('tohq');
    b.disabled = !phase; b.title = phase ? 'Switch sides (T)' : 'You can only switch sides between battles';
  }
  if (state === 'menu') refreshPicker(ui.menuPicker);
}

// menu
const nameInput = document.getElementById('name');
try {
  nameInput.value = localStorage.getItem('zitadelle.name') || '';
  playerTeam = localStorage.getItem('zitadelle.team') || 'de';
  Object.assign(selCls, JSON.parse(localStorage.getItem('zitadelle.cls') || '{}'));
} catch (e) { /* storage unavailable */ }
const factionBtns = [...document.querySelectorAll('.faction')];
function selectFaction(team) {
  playerTeam = team;
  factionBtns.forEach(b => b.classList.toggle('sel', b.dataset.team === team));
  buildPicker(ui.menuPicker, team);
}
factionBtns.forEach(b => b.addEventListener('click', () => selectFaction(b.dataset.team)));
selectFaction(playerTeam === 'su' ? 'su' : 'de');
updateFactionLabels();
function startGame() {
  if (!connected) return;
  playerName = (nameInput.value.trim() || 'Commander').slice(0, 16);
  try { localStorage.setItem('zitadelle.name', nameInput.value.trim()); localStorage.setItem('zitadelle.team', playerTeam); } catch (e) { /* ignore */ }
  deploy(playerTeam);
}
ui.deployBtn.addEventListener('click', startGame);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') startGame(); });
document.getElementById('respawn').addEventListener('click', () => deploy(playerTeam));
document.getElementById('tohq').addEventListener('click', () => { if (phase) switchSides(); });
addEventListener('keydown', e => {
  if (state === 'dead' && e.key === 'Enter' && !ui.death.classList.contains('hidden')) deploy(playerTeam);
  if (state === 'dead' && e.key.toLowerCase() === 't') switchSides();
});

// =====================================================================
// Main loop
// =====================================================================
// engine note follows our own tank's ground speed
let engSpd = 0, engT = 0, engPrev = null;
function updateEngine(dt) {
  const me = state === 'play' ? myTank() : null;
  if (me && engPrev) engSpd += (clamp(Math.hypot(me.x - engPrev.x, me.y - engPrev.y) / Math.max(dt, 1e-3) / 170, 0, 1) - engSpd) * (1 - Math.exp(-dt * 3));
  engPrev = me ? { x: me.x, y: me.y } : null;
  if ((engT -= dt) > 0) return;
  engT = 0.1;
  Sound.engine(!!me, engSpd);
}

resize();
connect();
let last = performance.now();
function frame(ms) {
  const dt = Math.min(0.05, (ms - last) / 1000);
  last = ms;
  now = ms / 1000;
  Sound.tick();
  interpolate();
  updateLocal(dt);
  updateCamera(dt);
  sendInput(dt);
  updateUI();
  updateEngine(dt);
  render();
  if (state === 'menu') factionBtns.forEach(b => drawPreview(b.querySelector('canvas'), selCls[b.dataset.team], b.dataset.team, now * 1.5));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
})();
