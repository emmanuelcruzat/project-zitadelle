/* ZITADELLE — browser client: input, interpolation, rendering, UI. The server owns the game state. */
(() => {
'use strict';
const {
  TAU, rand, pick, clamp, lerp, angDiff, lerpAngle,
  WORLD, CENTER, REARS, BUILDINGS, HAMLETS, O_IDX, LINES, CATS, RESERVES,
  CLASSES, CLASS_IDS, START_CLASS, OB, OB_TYPES, TEAM_IDS, KINDS, VIEW_W,
  CAP_POINTS, CAP_R, ATTACKER, DEFENDER, RANKS, RANK_SCORE,
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
  it: { id: 'it', name: 'Italy', body: '#b39f6e', dark: '#6d5f3c', barrel: '#8f8058', top: '#bfae7c',
        bullet: '#ece2c4', mini: '#d8c48a', tint: 'rgba(150,120,60,0.15)', label: 'ITALY' },
  us: { id: 'us', name: 'United States', body: '#59613a', dark: '#353a22', barrel: '#4b5231', top: '#646d42',
        bullet: '#ece8d4', mini: '#a3b06e', tint: 'rgba(70,80,40,0.15)', label: 'UNITED STATES' },
  gb: { id: 'gb', name: 'United Kingdom', body: '#5e6446', dark: '#373b28', barrel: '#4d523a', top: '#696f4f',
        bullet: '#ece8d4', mini: '#b8bc8e', tint: 'rgba(80,80,60,0.15)', label: 'UNITED KINGDOM' },
  x: { id: 'x', bullet: '#e3e1d9', dark: '#555555' },
  wreck: { id: 'wreck', body: '#3d3832', dark: '#211e1a', barrel: '#2f2b27', top: '#46403a' },
};

// =====================================================================
// Music: public/music/victory-{de,su}.mp3 and intro-{de,su}.mp3 (or .ogg/.wav/.m4a), if present
// =====================================================================
// intro songs (set false to switch them off; the files and code stay in)
const INTRO_ENABLED = true;
// Songs fade in when they start and fade out before they end. A new song crossfades with the old one.
const Music = (() => {
  const VOL = { victory: 0.7, intro: 0.35 }, FADE_IN = 2, FADE_END = 3;   // intro sits under the battle sounds
  let files = {}, cur = null, muted = false;
  fetch('music.json').then(r => r.json()).then(j => { files = j || {}; }).catch(() => {});
  // ramp one track's volume to `to` over `secs`, then optionally stop it
  function fade(a, to, secs, stopAfter) {
    clearInterval(a._fadeT);
    const v0 = a.volume, t0 = performance.now();
    a._fadeT = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / (Math.max(0.05, secs) * 1000));
      a.volume = clamp(v0 + (to - v0) * k, 0, 1);
      if (k >= 1) { clearInterval(a._fadeT); if (stopAfter) { a.pause(); if (cur === a) cur = null; } }
    }, 40);
  }
  return {
    // kind = 'victory' | 'intro'; picks one of that side's songs at random
    play(kind, side) {
      if (kind === 'intro' && !INTRO_ENABLED) return false;
      const list = [].concat(files[`${kind}-${side}`] || []);
      if (!list.length) return false;
      if (cur) fade(cur, 0, 1.2, true);                   // crossfade out whatever was playing
      const a = new Audio(list[Math.floor(Math.random() * list.length)]);
      a.volume = 0; a.muted = muted;
      a.addEventListener('timeupdate', () => {            // ease out before the track ends
        if (!a._ending && a.duration && a.duration - a.currentTime <= FADE_END) {
          a._ending = true; fade(a, 0, a.duration - a.currentTime, true);
        }
      });
      a.play().then(() => fade(a, VOL[kind] || 0.6, FADE_IN)).catch(() => {});
      cur = a;
      return true;
    },
    // fade the current song out over a few seconds (e.g. once the next battle starts)
    fadeOut(secs = 4) { if (cur) fade(cur, 0, secs, true); },
    setMuted(m) { muted = m; if (cur) cur.muted = m; },
    get playing() { return cur ? cur.src : null; },
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
let state = 'menu'; // menu | play | dead (on the battle map choosing where to deploy: knocked out, or just joined)
let devMode = false;
let rosterMismatch = false;   // server and page disagree on the vehicle list (see the welcome message)
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
  keys.add(k);                                   // driving keeps working with the leaderboard up
  if (k.startsWith('arrow') || k === ' ') e.preventDefault();
  if (showBoard) return;                         // ...but nothing else does
  if (k === 'f' && !e.repeat) { autofire = !autofire; bigMessage(autofire ? 'Autofire ON' : 'Autofire OFF', 1.2); }
  if (k === 'm' && !e.repeat) { Sound.toggle(); bigMessage(Sound.muted ? 'Sound OFF' : 'Sound ON', 1.2); }
  if (SIGHT_ENABLED && k === 'shift' && !e.repeat) setSight(!view2.sight);
  if (k === 't' && !e.repeat) switchSides();
  if (k === '1' && !e.repeat) setAmmo('ap');
  if (k === '2' && !e.repeat) setAmmo('apcr');
  // minimap size: + / - (main keyboard or numpad)
  if (k === '+' || k === '=') setMinimapScale(minimapScale * 1.15);
  if (k === '-' || k === '_') setMinimapScale(minimapScale / 1.15);
});
addEventListener('keyup', e => {
  keys.delete(e.key.toLowerCase());
  if (e.key.toLowerCase() === 'q' && markWheel) {
    if (markWheel.sel != null) send({ t: 'mark', x: Math.round(markWheel.wx), y: Math.round(markWheel.wy), c: markWheel.sel });
    markWheel = null;
  }
});
addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'q' || e.repeat || state !== 'play' || showBoard || e.target.tagName === 'INPUT' || !myTank()) return;
  markWheel = { sx: mouse.x, sy: mouse.y, wx: cam.x + (mouse.x - W / 2) / cam.scale, wy: cam.y + (mouse.y - H / 2) / cam.scale, sel: null };
});
addEventListener('blur', () => { keys.clear(); mouse.down = mouse.rdown = false; });
canvas.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
canvas.addEventListener('mousedown', e => {
  if (showBoard) return;
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
  if (state !== 'play' || showBoard) return;
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
    // Each calibre band has its own voice, from bright and short to dark and long:
    //   20mm autocannon: dry "pak"         37-50mm: thin, ringing bang       75-100mm: full boom, deeper with calibre
    //   122-152mm: dark, chest-thumping WHUMP with a long echo; little crack (howitzers are slow)
    // x = { mm: calibre, v: muzzle velocity }; long high-velocity guns (v >= 1.45) add a whip-crack double report.
    cannon(o, S, own, x = {}) {
      const mm = x.mm || 75 * Math.pow(S, 1 / 0.55), vel = x.v || 1.2, hv = vel >= 1.45;
      if (mm <= 25) {
        nz(o, 'highpass', 3000, 3000, 0, 0.7, 0.001, 0.02);
        nz(o, 'bandpass', 2400, 1000, 0.04, 1.1, 0.001, 0.05, true);
        osc(o, 'sine', 320, 140, 0.04, 0.6, 0.001, 0.05);
        nz(o, 'lowpass', 1200, 600, 0.1, 0.18, 0.01, 0.18, false, 0.02);
      } else if (mm <= 50) {
        nz(o, 'highpass', 2600, 2600, 0, 1.0, 0.001, 0.03);                      // crack
        nz(o, 'bandpass', 1800, 1100, 0.1, 1.0, 0.001, 0.12, true);               // bark
        osc(o, 'triangle', 620, 560, 0.3, 0.25, 0.001, 0.25);                    // metallic ring
        osc(o, 'sine', 210, 90, 0.15, 0.9, 0.002, 0.18);                         // small thump
        nz(o, 'lowpass', 2500, 300, 0.3, 0.9, 0.002, 0.35, true);                 // blast
        nz(o, 'lowpass', 400, 250, 0.8, 0.35, 0.03, 0.9, false, 0.03);           // short tail
      } else if (mm < 110) {
        const w = clamp((mm - 75) / 35, 0, 1);                                  // 75mm → 0, 100mm+ → ~1
        nz(o, 'highpass', 2400, 2400, 0, 0.8 * (hv ? 1.5 : 1), 0.001, 0.04);   // crack
        if (hv) nz(o, 'highpass', 3600, 3600, 0, 0.75, 0.001, 0.02, false, 0.014); // whip: second report
        nz(o, 'lowpass', 6000 - 2500 * w, 140 - 60 * w, 0.45, 1.5, 0.002, 0.8 + 0.4 * w, true); // muzzle blast
        osc(o, 'sine', 140 - 40 * w, 28, 0.4, 2.1, 0.003, 0.7 + 0.4 * w);       // concussion
        osc(o, 'triangle', 70, 30, 0.5, 0.9, 0.004, 0.6 + 0.3 * w);
        nz(o, 'lowpass', 320, 180, 2, 0.65, 0.08, 2.4 + 1.2 * w, false, 0.04);  // rolling thunder
      } else {
        nz(o, 'highpass', 2200, 2200, 0, hv ? 1.0 : 0.35, 0.001, 0.03);          // (the long 128mm still cracks)
        if (hv) nz(o, 'highpass', 3600, 3600, 0, 0.7, 0.001, 0.02, false, 0.014);
        nz(o, 'lowpass', 1400, 45, 1.0, 2.0, 0.003, 1.4, true);                  // dark muzzle blast
        osc(o, 'sine', 70, 18, 0.9, 2.6, 0.004, 1.4);                            // chest punch
        osc(o, 'sine', 42, 16, 1.2, 1.8, 0.008, 1.8);                            // sub-bass push
        nz(o, 'lowpass', 180, 180, 0, 1.0, 0.01, 0.5);                           // pressure wave
        nz(o, 'lowpass', 260, 120, 3, 0.9, 0.06, 4.5, false, 0.05);             // long rumble
        nz(o, 'lowpass', 300, 140, 1.5, 0.6, 0.05, 2.2, false, 0.35);           // echo off the steppe
        nz(o, 'lowpass', 260, 120, 1.5, 0.35, 0.05, 2.0, false, 0.8);           // and again, further off
      }
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
    // Explosion, built the way a real one sounds: a near-instant shock crack, a saturated blast that darkens
    // as it expands, a ground thump you feel more than hear, fragments and dirt pattering down at random,
    // then a long rumble and a late echo off the steppe. Every layer is randomised a little so no two
    // explosions sound alike. S = size (0.7 small HE shell .. 1.8 ammo dump / depot).
    boom(o, S) {
      const j = (a = 0.15) => 1 + (Math.random() * 2 - 1) * a;       // jitter
      const L = Math.min(1.6, S);                                     // length scale
      nz(o, 'lowpass', 14000, 14000, 0, 1.7, 0.0005, 0.018 * j(), true);              // shock front: a hard crack
      nz(o, 'highpass', 2200 * j(), 2200, 0, 0.7, 0.001, 0.05 * L);                   // its bright edge
      nz(o, 'lowpass', 3800 * j(), 85 / L, 0.28 * L * j(), 2.0, 0.002, 0.55 * L * j(), true); // blast, darkening as it spreads
      nz(o, 'bandpass', 190 * j(), 85, 0.35, 1.3, 0.003, 0.45 * L, true);            // the air "whump"
      osc(o, 'sine', 62 * j(0.2), 21, 0.5 * L, 2.7, 0.002, 0.9 * L * j());            // chest punch
      osc(o, 'sine', 38 * j(0.2), 14, 0.9 * L, 1.7, 0.006, 1.5 * L * j(), 0.02);     // ground heave
      // fragments, dirt and stones landing: short random ticks thinning out over ~1 s
      const n = Math.round(9 + 7 * L);
      for (let k = 0; k < n; k++) {
        const at = 0.04 + Math.pow(Math.random(), 1.6) * (0.9 * L), f = 1200 + Math.random() * 3200;
        nz(o, 'bandpass', f, f * 0.8, 0.03, 0.22 * (1 - at / (1.2 * L)) * j(0.4), 0.001, 0.015 + Math.random() * 0.03, false, at);
      }
      nz(o, 'bandpass', 2400 * j(), 1100, 1.2, 0.12, 0.25, 1.3 * L, false, 0.25);     // fine dust and grit settling
      nz(o, 'lowpass', 220 * j(), 70, 3, 1.0, 0.05, 3.4 * L * j(), false, 0.05);     // rolling rumble
      nz(o, 'lowpass', 320, 120, 1.5, 0.45, 0.06, 2.2 * L, false, 0.45 + Math.random() * 0.35); // echo off the steppe
    },
    hit(o) {                                                                   // penetration: crunch of steel
      nz(o, 'bandpass', 1900, 450, 0.15, 1.0, 0.001, 0.18, true);
      osc(o, 'sine', 220, 70, 0.15, 0.8, 0.002, 0.18);
    },
    ricochet(o) {                                                              // glancing strike, then the round whines away
      nz(o, 'highpass', 3800, 3800, 0, 0.55, 0.001, 0.025);
      osc(o, 'sine', 1900, 1750, 0.2, 0.16, 0.001, 0.25);
      osc(o, 'triangle', 3600, 650, 0.6, 0.22, 0.01, 0.65, 0.02);              // zing
      osc(o, 'sine', 2900, 500, 0.7, 0.08, 0.02, 0.7, 0.03);
    },
    bounce(o, S, own, ric) {                                                   // shell off your own armour: a heavy bell-like clang
      nz(o, 'lowpass', 5000, 900, 0.05, 1.3, 0.001, 0.07, true);
      for (const [f, v, d] of [[190, 0.75, 0.9], [447, 0.4, 0.7], [863, 0.28, 0.55], [1390, 0.16, 0.4]]) osc(o, 'sine', f, f * 0.985, d, v, 0.002, d);
      osc(o, 'sine', 95, 50, 0.2, 1.0, 0.003, 0.25);
      if (ric) osc(o, 'triangle', 3400, 600, 0.6, 0.16, 0.02, 0.6, 0.05);   // and the round singing off
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
  const COST = { ricochet: 0.8, bounce: 1.5, cannon: 2, boom: 4, rocket: 1.5, mg: 0.6, hit: 0.6, clank: 0.6, reload: 0.5 };

  // vol: loudness at the source; dn: 0 (on top of you) .. 1 (edge of hearing)
  api.play = (kind, vol = 1, dn = 0, S = 1, own = false, x1) => {
    if (!ac || api.muted || dn >= 1 || budget > 14) return;
    const v = vol * Math.pow(1 - dn, 1.5);
    if (v < 0.015) return;
    budget += COST[kind] || 1;
    const o = voice(v, dn, dn * 0.6);           // sound travels: far shots arrive late
    R[kind](o, S, own, x1);
  };
  // UI tick: a tiny burst of filtered noise, like a switch or dial click. One tick per entry in `at`
  // (seconds from now), so [0, 0.05] is a quick double tick.
  api.click = (at = [0], freq = 3400, vol = 0.14) => {
    if (!ac || api.muted) return;
    for (const dt0 of at) {
      const t = ac.currentTime + dt0;
      const src = ac.createBufferSource(); src.buffer = noise;
      const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 4;
      const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.001); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.014);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t, Math.random() * 1.5); src.stop(t + 0.03);
    }
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
const HEAR = { ricochet: 2200, bounce: 400, cannon: 3800, boom: 3800, rocket: 3000, mg: 2000, hit: 1500, clank: 1500, reload: 400 };
function soundAt(kind, x, y, vol = 1, S = 1, own = false, x1) {
  // small guns don't carry as far as big ones
  const reach = (HEAR[kind] || 1600) * (kind === 'cannon' ? clamp(S, 0.5, 1.4) : 1);
  const dn = own ? 0 : Math.hypot(x - cam.x, y - cam.y) / reach;
  Sound.play(kind, vol, dn, S, own, x1);
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
let lineDead = [0, 0], rsv = [RESERVES.de.slice(), RESERVES.su.slice()], phase = 0, battleLeft = 0;
let rsvDrops = [];   // recent reserve reductions, for the "-1" animation
let rsvLines = LINES.map(() => RESERVES[ATTACKER].map(n => Math.floor(n / LINES.length)));   // attacker's pool per line
// the reserve pool a deployment at spawn code sp would draw from (attacker: its line's pool)
function poolArr(team, sp) {
  const total = rsv[team === 'de' ? 0 : 1];
  if (team !== ATTACKER) return total;
  let L = sp != null && sp >= 0 ? CAP_POINTS[sp].line : sp != null && sp < 0 && REARS[-1 - sp] ? REARS[-1 - sp].line : null;
  if (!L || !rsvLines[LINES.indexOf(L)]) {       // O1 / unknown: the surviving line with the most left
    const live = LINES.filter((l, i) => rsvLines[i]).sort((a, b) => rsvLines[LINES.indexOf(b)].reduce((x, y) => x + y, 0) - rsvLines[LINES.indexOf(a)].reduce((x, y) => x + y, 0));
    L = live[0];
  }
  return L && rsvLines[LINES.indexOf(L)] ? rsvLines[LINES.indexOf(L)] : total.map(() => 0);
}
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
  if (m.t === 'welcome') {
    devMode = !!m.dev;
    // vehicles are sent by index: if the server is running an older vehicle list than this page,
    // every tank would be drawn as the wrong model. Refuse to play until they match.
    if (m.roster && m.roster !== CLASS_IDS.join(',')) {
      rosterMismatch = true;
      setStatus('The server is running an older version of the game — restart the server, then reload this page.');
      if (state !== 'menu') backToMenu();
    }
    return;
  }
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
  // promotion: rank went up on the same side (it drops back when a new battle resets scores — no popup then)
  if (you && promo.lastRank != null && you.team === promo.lastTeam && you.rank > promo.lastRank) promoted(you.team, you.rank);
  promo.lastRank = you ? you.rank : null; promo.lastTeam = you ? you.team : null;
  // the server has the final say on which side we are on (it refuses switches mid-battle)
  if (you && you.team && you.team !== playerTeam && state !== 'menu') {
    playerTeam = you.team;
    if (state === 'dead') onTeamChanged();
  }
  if (m.lb) board = m.lb;
  if (m.on !== undefined) online = m.on;
  sp = m.sp === undefined ? null : m.sp;
  if (m.cp) cps = m.cp;
  if (m.ln) lineDead = m.ln;
  if (m.rs) {
    // a reserve went down: float a "-1" off that count in the battle bar
    m.rs.forEach((row, ti) => row.forEach((n, k) => {
      const d = (rsv[ti] && rsv[ti][k]) - n;
      if (d > 0) rsvDrops.push({ ti, k, n: d, t: now });
    }));
    rsv = m.rs;
  }
  if (m.ph !== undefined) phase = m.ph;
  if (m.rl) rsvLines = m.rl;
  if (m.bt !== undefined) battleLeft = m.bt;
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
// team: optional side whose emblem is drawn in front of the text
function bigMessage(text, dur = 2.5, team = null) { msg = { text, t: now, dur, team }; }
// ---- damage direction: a red arc around your tank on the side a hit came from ----
const DMG_DIR_LEN = 1.6;
let dmgDirs = [];
function addDamageDir(e) {
  const me = myTank(); if (!me) return;
  if (e.g) Sound.play('bounce', 1, 0, 1, true, e.r);     // it bounced off you: right next to your ear
  const a = Math.atan2(e.y - me.y, e.x - me.x);
  // a hit from (nearly) the same direction refreshes that arc instead of stacking another
  const same = dmgDirs.find(d => !!d.g === !!e.g && Math.abs(angDiff(Math.atan2(d.y - me.y, d.x - me.x), a)) < 0.35);
  if (same) { same.x = e.x; same.y = e.y; same.t = now; same.s = Math.min(1, same.s + e.s); return; }
  dmgDirs.push({ x: e.x, y: e.y, t: now, s: e.s, g: !!e.g });
  if (dmgDirs.length > 6) dmgDirs.shift();
}
function drawDamageDirs() {
  dmgDirs = dmgDirs.filter(d => now - d.t < DMG_DIR_LEN);
  const me = myTank();
  if (!me || state !== 'play' || !dmgDirs.length) return;
  const cx0 = W / 2 + (me.x - cam.x) * cam.scale, cy0 = H / 2 + (me.y - cam.y) * cam.scale;
  const R = Math.min(W, H) * 0.2 + me.r * cam.scale;
  ctx.save(); ctx.lineCap = 'round';
  for (const d of dmgDirs) {
    const age = now - d.t, a = Math.atan2(d.y - me.y, d.x - me.x);
    const alpha = clamp(1 - age / DMG_DIR_LEN, 0, 1) * (0.45 + 0.55 * Math.min(1, d.s * 4));
    const span = 0.32 + 0.18 * Math.min(1, d.s * 4);            // bigger hits draw a wider arc
    const pop = 1 + 0.08 * Math.max(0, 1 - age / 0.15);          // a quick swell when it lands
    // soft outer glow, then the bright core (red: it hurt; grey: it bounced off)
    const [glow, core, tip] = d.g ? ['150,150,150', '215,215,210', '225,225,220'] : ['200,20,10', '255,60,40', '255,80,60'];
    ctx.strokeStyle = `rgba(${glow},${0.35 * alpha})`; ctx.lineWidth = 22;
    ctx.beginPath(); ctx.arc(cx0, cy0, R * pop, a - span, a + span); ctx.stroke();
    ctx.strokeStyle = `rgba(${core},${0.85 * alpha})`; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.arc(cx0, cy0, R * pop, a - span * 0.8, a + span * 0.8); ctx.stroke();
    // small chevron pointing outward at the source
    const tx = cx0 + Math.cos(a) * (R * pop + 16), ty = cy0 + Math.sin(a) * (R * pop + 16);
    ctx.fillStyle = `rgba(${tip},${0.9 * alpha})`; ctx.beginPath();
    ctx.moveTo(tx + Math.cos(a) * 9, ty + Math.sin(a) * 9);
    ctx.lineTo(tx + Math.cos(a + 2.4) * 8, ty + Math.sin(a + 2.4) * 8);
    ctx.lineTo(tx + Math.cos(a - 2.4) * 8, ty + Math.sin(a - 2.4) * 8);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
// ---- spotting: hold Q, flick toward a vehicle type, release to mark that spot for your side ----
const SPOT_LEN = 8;
let spots = [], markWheel = null;
function addSpot(e) {
  spots.push({ x: e.x, y: e.y, c: e.c, by: e.by, t: now });
  if (spots.length > 12) spots.shift();
  Sound.tone([988, 740], 0.06, 0.05);
}
function drawMarkWheel() {
  const mw = markWheel;
  if (!mw) return;
  if (state !== 'play' || !myTank()) { markWheel = null; return; }
  const R = 78, r0 = 24, n = CATS.length, dx = mouse.x - mw.sx, dy = mouse.y - mw.sy;
  // sector under the mouse (first one straight up, going clockwise); dead zone in the middle cancels
  mw.sel = Math.hypot(dx, dy) < r0 ? null : Math.floor(((Math.atan2(dy, dx) + Math.PI / 2 + Math.PI / n + TAU * 2) % TAU) / (TAU / n));
  ctx.save();
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 - Math.PI / n + i * TAU / n, a1 = a0 + TAU / n, on = mw.sel === i;
    ctx.beginPath(); ctx.arc(mw.sx, mw.sy, on ? R + 6 : R, a0 + 0.03, a1 - 0.03); ctx.arc(mw.sx, mw.sy, r0, a1 - 0.03, a0 + 0.03, true); ctx.closePath();
    ctx.fillStyle = on ? 'rgba(150,40,30,0.88)' : 'rgba(20,19,14,0.78)'; ctx.fill();
    ctx.strokeStyle = on ? '#ff8a6a' : 'rgba(231,220,177,0.3)'; ctx.lineWidth = 1.5; ctx.stroke();
    const am = (a0 + a1) / 2, lr = (R + r0) / 2 + (on ? 3 : 0);
    drawCatIcon(ctx, i, mw.sx + Math.cos(am) * lr, mw.sy + Math.sin(am) * lr - 5, on ? 8 : 7, on ? '#fff' : '#e8e0c0');
    hudText(CATS[i].name.replace(' tank destroyers', ' TD').replace(' tanks', '').replace('Tank destroyers', 'TD'), mw.sx + Math.cos(am) * lr, mw.sy + Math.sin(am) * lr + 11, 9, on ? '#ffd9cf' : '#a99f78', 'center', 400);
  }
  ctx.fillStyle = 'rgba(20,19,14,0.85)'; ctx.beginPath(); ctx.arc(mw.sx, mw.sy, r0 - 3, 0, TAU); ctx.fill();
  hudText(mw.sel == null ? 'MARK' : 'ENEMY', mw.sx, mw.sy, 10, '#ff8a6a', 'center', 600);
  ctx.restore();
}
function drawSpots() {
  spots = spots.filter(mk => now - mk.t < SPOT_LEN);
  for (const mk of spots) {
    const age = now - mk.t, a = clamp(age / 0.2, 0, 1) * clamp((SPOT_LEN - age) / 1.5, 0, 1);
    let sx = W / 2 + (mk.x - cam.x) * cam.scale, sy = H / 2 + (mk.y - cam.y) * cam.scale;
    const off = sx < 30 || sx > W - 30 || sy < 30 || sy > H - 30;
    sx = clamp(sx, 30, W - 30); sy = clamp(sy, 30, H - 30);     // off-screen: pinned to the edge
    ctx.save(); ctx.globalAlpha = a;
    if (!off) {   // expanding ping rings on the spot
      const ring = (age * 1.2) % 1;
      ctx.strokeStyle = `rgba(235,60,45,${0.7 * (1 - ring)})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 10 + ring * 40, 0, TAU); ctx.stroke();
    }
    // red disc with the vehicle class symbol
    const s = 12;
    ctx.fillStyle = 'rgba(190,40,30,0.92)'; ctx.strokeStyle = '#ffd9cf'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sx, sy, s, 0, TAU); ctx.fill(); ctx.stroke();
    drawCatIcon(ctx, mk.c, sx, sy + (mk.c >= 3 ? 0.5 : 0), 6.5, '#fff', null);
    if (off) {    // arrow pointing toward it
      const ang = Math.atan2(mk.y - cam.y, mk.x - cam.x);
      ctx.fillStyle = '#ff8a6a'; ctx.beginPath();
      ctx.moveTo(sx + Math.cos(ang) * (s + 9), sy + Math.sin(ang) * (s + 9));
      ctx.lineTo(sx + Math.cos(ang + 2.6) * (s + 2), sy + Math.sin(ang + 2.6) * (s + 2));
      ctx.lineTo(sx + Math.cos(ang - 2.6) * (s + 2), sy + Math.sin(ang - 2.6) * (s + 2)); ctx.closePath(); ctx.fill();
    }
    hudText(mk.by, sx, sy + s + 10, 10, '#ffd9cf', 'center', 400);
    ctx.restore();
  }
}
// ---- combat awards: a short stacked list above the crosshair area ("Armor Destroyed +100") ----
const AWARD_LEN = 2.6;
let awards = [];
function addAward(label, n) {
  const last = awards[0];
  // a stream of small damage awards merges into one line instead of stacking up
  if (last && last.label === label && label === 'Armor Damaged' && now - last.t < 1.2) { last.n += n; last.t = now; last.bump = now; return; }
  awards.unshift({ label, n, t: now, bump: now });
  if (awards.length > 4) awards.length = 4;
  if (label === 'Armor Destroyed' || label === 'Point Captured') Sound.tone([660, 880], 0.07, 0.05);
}
function drawAwards() {
  awards = awards.filter(a => now - a.t < AWARD_LEN);
  awards.forEach((a, i) => {
    const age = now - a.t, big = a.label === 'Armor Destroyed' || a.label === 'Point Captured';
    const alpha = clamp(age / 0.15, 0, 1) * clamp((AWARD_LEN - age) / 0.5, 0, 1) * (1 - i * 0.18);
    const pop = 1 + 0.12 * Math.max(0, 1 - (now - a.bump) / 0.15);
    const y = H * 0.3 + i * 24, size = (big ? 18 : 14) * pop;
    ctx.globalAlpha = alpha;
    ctx.font = `600 ${size}px Oswald, Impact, sans-serif`;
    const label = a.label.toUpperCase(), pts = `+${a.n}`;
    const lw = ctx.measureText(label + '  ').width, pw = ctx.measureText(pts).width, x0 = W / 2 - (lw + pw) / 2;
    hudText(label, x0, y, size, big ? '#f2ead0' : '#d6cca3', 'left', 600);
    hudText(pts, x0 + lw, y, size, a.label.startsWith('Armor Destroyed') ? '#ff5a3c' : '#f6e27a', 'left', 600);
  });
  ctx.globalAlpha = 1;
}
// ---- battle intro: "Die Schlacht beginnt!" / "Бой начинается!" with the side's emblem ----
const INTRO_LEN = 4.6;
const INTRO_TEXT = {
  de: { head: 'Die Schlacht beginnt!', sub: 'DEUTSCHES REICH' },
  su: { head: 'Бой начинается!', sub: 'СОВЕТСКИЙ СОЮЗ' },
};
let intro = null;
// ---- promotion popup: a small card that drops in under the battle status, then slides away ----
const PROMO_LEN = 3.8;
const promo = { lastRank: null, lastTeam: null, show: null };
function promoted(team, rank) {
  promo.show = { team, rank, t: now };
  Sound.tone([523, 659, 784], 0.09, 0.05);       // quiet rising chime
}
function drawPromo() {
  const p = promo.show;
  if (!p) return;
  const a = now - p.t;
  if (a > PROMO_LEN) { promo.show = null; return; }
  const ease = x => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
  const inn = ease(a / 0.35), out = clamp((PROMO_LEN - a) / 0.5, 0, 1);
  const w = 290, h = 58, x = W / 2 - w / 2, y = 92 - 16 * (1 - inn) - 10 * (1 - out);
  const r = RANKS[p.team][p.rank];
  if (!r) return;
  ctx.save();
  ctx.globalAlpha = inn * out;
  ctx.fillStyle = 'rgba(20,19,14,0.88)'; rrect(ctx, x, y, w, h, 4); ctx.fill();
  ctx.strokeStyle = 'rgba(231,220,177,0.35)'; ctx.lineWidth = 1; rrect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4); ctx.stroke();
  ctx.fillStyle = TEAMS[p.team].mini; ctx.fillRect(x, y + 4, 3, h - 8);
  // a light glint sweeps across the card once it has landed
  const sw = clamp((a - 0.3) / 0.6, 0, 1);
  if (sw > 0 && sw < 1) {
    ctx.save(); rrect(ctx, x, y, w, h, 4); ctx.clip();
    const gx = x - 60 + (w + 120) * sw, g = ctx.createLinearGradient(gx - 40, 0, gx + 40, 0);
    g.addColorStop(0, 'rgba(255,245,210,0)'); g.addColorStop(0.5, 'rgba(255,245,210,0.18)'); g.addColorStop(1, 'rgba(255,245,210,0)');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h); ctx.restore();
  }
  // insignia pops slightly as it lands
  const pop = 1 + 0.25 * Math.max(0, 1 - Math.abs(a - 0.3) / 0.2);
  drawInsignia(ctx, p.team, p.rank, x + 32, y + h / 2, 34 * pop);
  hudText(p.team === 'de' ? 'BEFÖRDERT' : 'ПОВЫШЕНИЕ', x + 62, y + 18, 11, '#d9b46b', 'left', 600);
  hudText(r[1], x + 62, y + 38, 19, '#f2ead0', 'left', 600);
  ctx.restore();
}
// ---- end of battle: SIEG / NIEDERLAGE, ПОБЕДА / ПОРАЖЕНИЕ ----
const END_WORDS = {
  de: { win: 'SIEG', lose: 'NIEDERLAGE' },
  su: { win: 'ПОБЕДА', lose: 'ПОРАЖЕНИЕ' },
};
let endScreen = null;   // { w: winning side, t: when it started }
function drawEndScreen(myTeam) {
  const [w, secs] = phase, wt = OWNER[w];
  if (!wt) return;
  // joined during the break: show it already settled, no entrance animation
  if (!endScreen || endScreen.w !== wt) endScreen = { w: wt, t: now - 5 };
  const a = now - endScreen.t, ease = x => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
  const won = myTeam ? wt === myTeam : true, side = myTeam || wt;
  const accent = won ? '#f6e27a' : '#e0573f';
  const cx = W / 2, cy = H * 0.42;
  ctx.save();
  // dim with a tinted vignette, letterbox bars
  const dim = ease(a / 0.6);
  ctx.fillStyle = `rgba(0,0,0,${0.5 * dim})`; ctx.fillRect(0, 0, W, H);
  const vg = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.15, cx, cy, Math.max(W, H) * 0.75);
  vg.addColorStop(0, won ? 'rgba(246,226,122,0.10)' : 'rgba(224,87,63,0.10)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.globalAlpha = dim; ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
  const bar = H * 0.1 * ease(a / 0.5);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar);
  // the winner's emblem drops in with a glow
  const ea = ease((a - 0.2) / 0.7), es = Math.min(W, H) * 0.06 * (1.5 - 0.5 * ea), ey = cy - Math.min(W, H) * 0.16;
  ctx.globalAlpha = ea;
  const g = ctx.createRadialGradient(cx, ey, 0, cx, ey, es * 3);
  g.addColorStop(0, won ? 'rgba(255,236,170,0.4)' : 'rgba(255,120,90,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, ey, es * 3, 0, TAU); ctx.fill();
  ctx.save(); ctx.translate(cx, ey); drawFactionMark(ctx, wt, es); ctx.restore();
  // title in your side's language, settling in from wide letter spacing
  const ta = ease((a - 0.45) / 0.6), fs = Math.min(W * 0.11, 120);
  const word = END_WORDS[side][won ? 'win' : 'lose'];
  ctx.globalAlpha = ta;
  ctx.font = `600 ${fs}px Oswald, Impact, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(1 - ta) * 30 + 6}px`;
  ctx.lineJoin = 'round'; ctx.lineWidth = fs * 0.1; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(word, cx, cy + fs * 0.25);
  ctx.fillStyle = accent; ctx.fillText(word, cx, cy + fs * 0.25);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  // English, then a rule that wipes out from the centre
  const english = !myTeam ? `${TEAMS[wt].name.toUpperCase()} VICTORIOUS` : won ? 'VICTORY' : 'DEFEAT';
  ctx.globalAlpha = ease((a - 0.8) / 0.5);
  hudText(english, cx, cy + fs * 0.85, Math.max(14, fs * 0.17), '#e8e0c0', 'center', 400);
  const lw = Math.min(W * 0.55, 620) * ease((a - 0.9) / 0.6);
  ctx.globalAlpha = 1; ctx.fillStyle = accent; ctx.fillRect(cx - lw / 2, cy + fs * 1.08, lw, 2);
  // how it was won, and your battle
  const by = cy + fs * 1.08 + 28;
  ctx.globalAlpha = ease((a - 1.2) / 0.5);
  hudText(phase[2] === 1 ? `Time runs out — ${TEAMS[wt].name} holds the line`
    : wt === ATTACKER ? `${TEAMS[wt].name} breaks through to ${CAP_POINTS[O_IDX].name}` : `${TEAMS[wt].name} holds the line`,
    cx, by, 17, '#d9cf9f', 'center', 400);
  if (you) {
    ctx.globalAlpha = ease((a - 1.5) / 0.5);
    const stats = [['SCORE', fmt(you.score || 0)], ['KILLS', String(you.kills || 0)], ['DEATHS', String(you.deaths || 0)]];
    stats.forEach(([k, v], i) => {
      const sx = cx + (i - 1) * 120;
      hudText(v, sx, by + 44, 26, '#f2ead0');
      hudText(k, sx, by + 68, 11, '#8d8668', 'center', 400);
    });
  }
  // countdown to the next battle: a draining bar above the bottom letterbox
  ctx.globalAlpha = ease((a - 0.6) / 0.5);
  const total = Z.ROUND_END || 30, f = clamp(secs / total, 0, 1), cw = Math.min(W * 0.4, 420), cy2 = H - bar - 30;
  ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(cx - cw / 2, cy2, cw, 3);
  ctx.fillStyle = accent; ctx.fillRect(cx - cw / 2, cy2, cw * f, 3);
  hudText(`Next battle in ${secs}s  ·  T — switch sides`, cx, cy2 - 14, 13, '#b9b195', 'center', 400);
  ctx.restore();
}
// coalition shields pre-rendered once (drawCoalitionBadge clears the canvas it's given)
const coalBadgeCache = {};
function coalitionBadgeImage(coal) {
  if (!coalBadgeCache[coal]) {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 144;
    drawCoalitionBadge(cv.getContext('2d'), coal, cv.width, cv.height);
    coalBadgeCache[coal] = cv;
  }
  return coalBadgeCache[coal];
}
function battleIntro(team) {
  if (!TEAMS[team] || !INTRO_TEXT[team]) return;
  intro = { team, t: now };
  msg = { text: '', t: 0, dur: 0 };   // clear any pending banner so it doesn't sit under the intro
  Sound.play('boom', 0.55, 0.45, 1.5);          // distant artillery rolling across the steppe
}
function drawIntro() {
  if (!intro) return;
  const a = now - intro.t;
  if (a > INTRO_LEN) { intro = null; return; }
  const ease = x => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
  const out = clamp((INTRO_LEN - a) / 0.8, 0, 1);              // everything fades over the last 0.8 s
  const T = INTRO_TEXT[intro.team], col = TEAMS[intro.team].mini;
  const cx = W / 2, cy = H * 0.44;
  ctx.save();
  // dim the field and slide in letterbox bars
  ctx.fillStyle = `rgba(0,0,0,${0.45 * ease(a / 0.4) * out})`; ctx.fillRect(0, 0, W, H);
  const bar = H * 0.11 * ease(a / 0.45) * out;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar);
  // emblem: scales down into place with a soft glow behind it
  const ea = ease((a - 0.15) / 0.6), es = Math.min(W, H) * 0.075 * (1.6 - 0.6 * ea);
  ctx.globalAlpha = ea * out;
  const g = ctx.createRadialGradient(cx, cy - es * 1.9, 0, cx, cy - es * 1.9, es * 2.6);
  g.addColorStop(0, 'rgba(255,240,200,0.35)'); g.addColorStop(1, 'rgba(255,240,200,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy - es * 1.9, es * 2.6, 0, TAU); ctx.fill();
  ctx.save(); ctx.translate(cx, cy - es * 1.9); drawFactionMark(ctx, intro.team, es); ctx.restore();
  // headline: settles in from wide letter spacing
  const ha = ease((a - 0.45) / 0.55), fs = Math.min(W * 0.072, 92);
  ctx.globalAlpha = ha * out;
  ctx.font = `600 ${fs}px Oswald, Impact, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(1 - ha) * 18 + 2}px`;
  ctx.lineJoin = 'round'; ctx.lineWidth = fs * 0.12; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(T.head, cx, cy + fs * 0.35);
  ctx.fillStyle = '#f2ead0'; ctx.fillText(T.head, cx, cy + fs * 0.35);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  // a rule wipes out from the centre, then the faction name and coalition
  const wa = ease((a - 0.9) / 0.5), lw = Math.min(W * 0.5, 560) * wa;
  ctx.globalAlpha = out;
  ctx.fillStyle = col; ctx.fillRect(cx - lw / 2, cy + fs * 0.95, lw, 3);
  ctx.globalAlpha = ease((a - 1.1) / 0.5) * out;
  // "DEUTSCHES REICH · [shield] AXIS"
  const coal = Z.FACTIONS[intro.team].coalition, ts = Math.max(13, fs * 0.2), ty = cy + fs * 0.95 + 26;
  const lead = `${T.sub}  ·  `, word = coal.toUpperCase();
  ctx.font = `400 ${ts}px Oswald, Impact, sans-serif`;
  const bh = ts * 1.5, bw = bh * 64 / 72, gap = ts * 0.4;
  const ldw = ctx.measureText(lead).width, ww = ctx.measureText(word).width, x0 = cx - (ldw + bw + gap + ww) / 2;
  hudText(lead, x0, ty, ts, '#d9cf9f', 'left', 400);
  ctx.drawImage(coalitionBadgeImage(coal), x0 + ldw, ty - bh / 2, bw, bh);
  hudText(word, x0 + ldw + bw + gap, ty, ts, '#d9cf9f', 'left', 400);
  ctx.restore();
}
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
        // weight from the actual calibre when the server sends it, else the old light/medium/heavy class
        const S = e.mm ? clamp(Math.pow(e.mm / 75, 0.55), 0.45, 1.75) : [0.8, 1, 1.4][cal];
        soundAt('cannon', e.x, e.y, (mine ? 1 : 0.9) * clamp(0.3 + 0.65 * S, 0.6, 1.25), S, mine, { mm: e.mm, v: e.v });
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
      if (e.z === 4) {
        const sp = Math.hypot(e.vx, e.vy) || 1, ux = e.vx / sp, uy = e.vy / sp;
        for (let k = 0; k < 14; k++) {
          const v = rand(120, 420), a = Math.atan2(uy, ux) + rand(-0.5, 0.5);
          addP(e.x, e.y, Math.cos(a) * v, Math.sin(a) * v, rand(0.15, 0.4), rand(1.5, 3), pick(['#fff1b8', '#ffd27a', '#ffb347']), 'spark');
        }
        addP(e.x, e.y, ux * 40, uy * 40, 0.12, 14, '#fff6d8', 'flash');
        addP(e.x, e.y, rand(-10, 10), rand(-10, 10), 0.5, 10, 'rgba(210,205,190,0.5)', 'smoke');
        soundAt('ricochet', e.x, e.y, 0.75);
        break;
      }
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
      const label = `${p.id} (${p.name})`;
      if (you) {
        bigMessage(`${TEAMS[e.t].name} ${e.n ? 'neutralized' : 'captured'} ${label}`, 3, e.t);
        Sound.tone(ours ? [392, 523, 659] : [440, 349, 262], 0.14, 0.07);
      }
      feed.push({ kn: TEAMS[e.t].name, kt: e.t, vn: label, vt: e.n ? null : e.t, sym: e.n ? '⊘' : '⚑', t: now });
      if (feed.length > 6) feed.shift();
      break;
    }
    case 're':
      endScreen = { w: e.w, t: now };
      // the winning side's victory song if one has been supplied, otherwise a short fanfare
      if (!Music.play('victory', e.w) && you) Sound.tone(e.w === you.team ? [392, 523, 659, 784] : [392, 330, 262, 196], 0.22, 0.09);
      break;
    case 'rn':
      battleIntro(you ? you.team : playerTeam);
      if (!(you && Music.play('intro', you.team))) Music.fadeOut();
      break;
    case 'ld':
      bigMessage(`Line ${e.l} defeated — ${TEAMS[DEFENDER].name} retook ${e.l}5 · its reserves are lost`, 4);
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
    case 'aw': addAward(e.l, e.n); break;
    case 'mk': addSpot(e); break;
    case 'chat': addChat(e); break;
    case 'intro': battleIntro(e.t); break;
    case 'sh': cam.shake = Math.min(14, cam.shake + e.a); break;
    case 'dh': addDamageDir(e); break;
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
function drawFactionMark(c, team, s) {   // hull marking: Balkenkreuz or red star, centred on the origin
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
  } else if (team === 'it') {       // red shield with a white cross (arms of Savoy)
    c.beginPath(); c.moveTo(-s * 0.8, -s); c.lineTo(s * 0.8, -s); c.lineTo(s * 0.8, s * 0.2);
    c.quadraticCurveTo(s * 0.8, s * 0.8, 0, s); c.quadraticCurveTo(-s * 0.8, s * 0.8, -s * 0.8, s * 0.2); c.closePath();
    c.fillStyle = '#b82a2a'; c.fill();
    c.lineWidth = Math.max(1, s * 0.1); c.strokeStyle = '#2a6b3c'; c.stroke();
    c.fillStyle = '#f2f2ea'; c.fillRect(-s * 0.16, -s * 0.8, s * 0.32, s * 1.5); c.fillRect(-s * 0.62, -s * 0.28, s * 1.24, s * 0.32);
  } else if (team === 'us') {       // white star in a white ring
    c.beginPath(); c.arc(0, 0, s, 0, TAU); c.lineWidth = Math.max(1, s * 0.14); c.strokeStyle = '#f2f2ea'; c.stroke();
    c.beginPath();
    for (let i = 0; i < 10; i++) { const rr = i % 2 ? s * 0.33 : s * 0.82, a = -Math.PI / 2 + i * Math.PI / 5; c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
    c.closePath(); c.fillStyle = '#f2f2ea'; c.fill();
  } else if (team === 'gb') {       // white-red-white recognition flash
    const w = s * 0.62, h = s * 1.5;
    c.fillStyle = '#f2f2ea'; c.fillRect(-w * 1.5, -h / 2, w, h); c.fillRect(w * 0.5, -h / 2, w, h);
    c.fillStyle = '#b82a2a'; c.fillRect(-w * 0.5, -h / 2, w, h);
    c.lineWidth = 1; c.strokeStyle = 'rgba(0,0,0,0.4)'; c.strokeRect(-w * 1.5, -h / 2, w * 3, h);
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
    if (ix > -L * 0.46) { c.save(); c.translate(ix, 0); drawFactionMark(c, teamId, r * 0.16); c.restore(); }
  } else if (teamId !== 'wreck') {
    c.save(); c.translate(-L * 0.36, 0); drawFactionMark(c, teamId, r * 0.15); c.restore();
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
  const y0 = t.y - t.r * 1.45 - 6;
  if (!you || ally) {   // enemy crews stay anonymous
    const fs = Math.round(15 + t.r * 0.12);
    // you and your allies: the vehicle as a small subtitle under the name (the name moves up to make room)
    const sub = you && ally && t.cls ? t.cls.name : null, ss = Math.round(fs * 0.62);
    const y = sub ? y0 - ss - 1 : y0;
    if (sub) {
      ctx.font = `400 ${ss}px Oswald, Impact, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineJoin = 'round';
      ctx.strokeText(sub, t.x, y0);
      ctx.fillStyle = 'rgba(232,226,200,0.85)'; ctx.fillText(sub, t.x, y0);
    }
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
  if (state === 'dead' && dmap.open) {
    // whole battlefield; or swooping down onto the chosen point (centred in the space left of the
    // vehicle panel on the right)
    let tx = CENTER, ty = CENTER, ts = Math.min(W / WORLD, (H - 170) / WORLD) * 0.94;
    ty -= 20 / ts;
    if (dmap.sel != null) {
      ts = Math.max(W, H * 16 / 9) / (VIEW_W * 1.1) * 0.8;
      tx = dmap.selX + deployPanelW() / 2 / ts; ty = dmap.selY;
    }
    const k = 1 - Math.exp(-dt * 4);
    cam.scale = Math.exp(Math.log(cam.scale) + (Math.log(ts) - Math.log(cam.scale)) * k);
    cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
    cam.shake = 0;
    if (dmap.stage === 'zoom' && Math.abs(Math.log(cam.scale / ts)) < 0.12 && Math.hypot(tx - cam.x, ty - cam.y) * cam.scale < 40) showDeployPanel();
    return;
  }
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
  // battle map: fully drawn when zoomed out, fading away as the camera swoops in on a point
  const mapA = state === 'dead' && dmap.open ? clamp((0.5 - sc) / 0.2, 0, 1) : 0;
  if (mapA < 1) renderWorld();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (mapA > 0) drawDeployMap(mapA);
  if (state === 'dead' && dmap.open && dmap.stage === 'pick') drawDeployButton();
  if (view2.sight && state === 'play') drawSightOverlay();
  // between battles the end screen replaces the whole HUD (minimap, feed, crosshair...), like the intro does
  if (phase) drawEndScreen(you ? you.team : null);
  else { endScreen = null; drawHUD(); }
  drawPromo();
  drawIntro();
  drawBoard();
}
function renderWorld() {
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
  } else if (team === 'it' || team === 'us' || team === 'gb') {
    // chevrons (up for the US, down for the British and Italians) for NCOs; bars, pips or stars for officers
    const chev = (n, up, col, y1) => {
      for (const [lw, cc] of [[s * 0.24, 'rgba(0,0,0,0.75)'], [s * 0.12, col]]) {
        c.strokeStyle = cc; c.lineWidth = lw;
        for (let k = 0; k < n; k++) {
          const yy = y1 + k * s * 0.24, d = up ? -1 : 1;
          c.beginPath(); c.moveTo(x - s * 0.34, yy - d * s * 0.14); c.lineTo(x, yy + d * s * 0.14); c.lineTo(x + s * 0.34, yy - d * s * 0.14); c.stroke();
        }
      }
    };
    if (rank <= 3) {
      if (team === 'us') {
        chev(rank === 0 ? 1 : rank === 1 ? 2 : 3, true, '#c9c08a', y - s * 0.3);
        if (rank === 3) { c.strokeStyle = '#c9c08a'; c.lineWidth = s * 0.12; c.beginPath(); c.arc(x, y + s * 0.05, s * 0.36, 0.25 * Math.PI, 0.75 * Math.PI); c.stroke(); }
      } else if (team === 'gb') {
        chev(rank === 0 ? 1 : rank === 1 ? 2 : 3, false, '#e8e2c8', y - s * 0.18);
        if (rank === 3) { c.fillStyle = '#d9b24a'; c.beginPath(); c.arc(x, y - s * 0.42, s * 0.12, Math.PI, 0); c.lineTo(x + s * 0.12, y - s * 0.34); c.lineTo(x - s * 0.12, y - s * 0.34); c.closePath(); c.fill(); }
      } else {   // Italy: red chevrons for corporals, gold for sergeants
        chev(rank % 2 === 0 ? 1 : 2, false, rank <= 1 ? '#c0392b' : '#d9b24a', y - s * 0.12);
      }
    } else {
      strap(team === 'it' ? '#8a8a6a' : team === 'us' ? '#6b6a4a' : '#7b7650', team === 'it' ? '#5c5c44' : '#3f3e2c');
      const n = rank - 3;
      if (team === 'us') {     // gold bar, silver bar, two silver bars
        const col = rank === 4 ? '#d9b24a' : '#d4d6d2';
        for (let k = 0; k < (rank === 6 ? 2 : 1); k++) { c.fillStyle = col; c.fillRect(x - w * 0.18, y - s * 0.05 + k * s * 0.24, w * 0.36, s * 0.16); }
      } else {                 // British pips / Italian stars, one to three
        for (let k = 0; k < n; k++) {
          const py = y + s * 0.3 - k * s * 0.24;
          if (team === 'gb') { c.fillStyle = '#d9b24a'; c.beginPath(); c.moveTo(x, py - s * 0.09); c.lineTo(x + s * 0.09, py); c.lineTo(x, py + s * 0.09); c.lineTo(x - s * 0.09, py); c.closePath(); c.fill(); }
          else { c.fillStyle = '#d4d6d2'; c.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? s * 0.04 : s * 0.1; c.lineTo(x + Math.cos(a) * rr, py + Math.sin(a) * rr); } c.closePath(); c.fill(); }
        }
      }
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

// Vehicle class symbols: diamonds for tanks (hollow = light, half = medium, solid = heavy), downward
// triangles for tank destroyers (hollow = TD, solid = heavy TD). s = half-height. Dark edge keeps them
// readable on any background.
function drawCatIcon(c, cat, x, y, s, col, edge = 'rgba(0,0,0,0.75)') {
  c.save(); c.translate(x, y); c.lineJoin = 'round';
  const shape = () => {
    c.beginPath();
    if (cat <= 2) { c.moveTo(0, -s); c.lineTo(s * 0.8, 0); c.lineTo(0, s); c.lineTo(-s * 0.8, 0); }
    else { c.moveTo(-s * 0.95, -s * 0.75); c.lineTo(s * 0.95, -s * 0.75); c.lineTo(0, s * 0.85); }
    c.closePath();
  };
  const lw = Math.max(1.2, s * 0.22), solid = cat === 2 || cat === 4;
  if (edge) { shape(); c.strokeStyle = edge; c.lineWidth = lw + 2.2; c.stroke(); }
  shape();
  if (solid) { c.fillStyle = col; c.fill(); }
  if (cat === 1) { c.save(); c.clip(); c.fillStyle = col; c.fillRect(-s, 0, s * 2, s); c.restore(); }
  c.strokeStyle = col; c.lineWidth = lw; c.stroke();
  c.restore();
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
  rsvDrops = rsvDrops.filter(d => now - d.t < 1.2);
  // ---- battle status: both attack lines converging on O1, and both sides' reserves ----
  const myTeam = you ? you.team : null;
  {
    const step = 40, rowY = [24, 62], midY = 43;
    const x0 = cx - (5 * step + 20) / 2;
    const iconX = k => x0 + k * step;
    const ox = x0 + 5 * step + 40;          // O1, with room before it for the elbow
    const ex = x0 + 4 * step + 40;          // where both lines bend toward O1
    LINES.forEach((L, li) => {
      const y = rowY[li], dead = isLineDead(L);
      ctx.strokeStyle = dead ? 'rgba(220,70,50,0.6)' : 'rgba(230,220,190,0.4)'; ctx.lineWidth = 2;
      // elbow connector: along the row, a right angle to O1's height, then straight into O1
      ctx.beginPath(); ctx.moveTo(iconX(0), y); ctx.lineTo(ex, y); ctx.lineTo(ex, midY); ctx.lineTo(ox, midY); ctx.stroke();
      CAP_POINTS.forEach((p, i) => { if (p.line === L) drawPointIcon(i, iconX(p.k), y, 14); });
      if (dead) {
        ctx.strokeStyle = 'rgba(230,70,50,0.9)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(iconX(0) - 18, y); ctx.lineTo(iconX(4) + 18, y); ctx.stroke();
        hudText('DEFEATED', iconX(2), y, 13, '#ff8a6a');
      }
    });
    drawPointIcon(O_IDX, ox, midY, 17);
    // reserves, one row per side, right-aligned against the objective panel: the side's emblem, then a
    // column per vehicle class with its symbol on top and the count underneath
    const colW = 30;
    // deploying as the attacker at a chosen point: its row shows that line's pool (what you'll draw from)
    const deployLine = state === 'dead' && dmap.open && dmap.sel != null && playerTeam === ATTACKER
      ? (dmap.sel >= 0 ? CAP_POINTS[dmap.sel].line : REARS[-1 - dmap.sel] && REARS[-1 - dmap.sel].line) : null;
    ['de', 'su'].forEach((team, ti) => {
      const lineView = team === ATTACKER && deployLine && rsvLines[LINES.indexOf(deployLine)];
      const r = lineView ? rsvLines[LINES.indexOf(deployLine)] : rsv[ti], y = rowY[ti];
      let x = x0 - 34 - colW / 2;
      for (let k = CATS.length - 1; k >= 0; k--) {
        if (!RESERVES[team][k]) continue;
        const col = r[k] <= 0 ? '#ff7a5c' : team === myTeam ? '#f6e27a' : '#e8e0c0';
        drawCatIcon(ctx, k, x, y - 7, 5.5, col);
        hudText(String(r[k]), x, y + 9, 12, col, 'center', 400);
        // "-1" rising off the count and fading
        for (const d of rsvDrops) {
          if (lineView || d.ti !== ti || d.k !== k) continue;
          const a = (now - d.t) / 1.2;
          ctx.globalAlpha = clamp(1 - a, 0, 1) * clamp(a * 8, 0, 1);
          hudText(`-${d.n}`, x + 12, y + 9 - a * 16, 12 + 3 * Math.max(0, 1 - a * 4), '#ff6a4a', 'left', 600);
          ctx.globalAlpha = 1;
        }
        x -= colW;
      }
      // [emblem] NAME, right next to the first class column
      // while deploying on a line, a small "A RESERVES" under the name says which pool is shown
      const lx = x + colW / 2 - 4, label = TEAMS[team].label;
      ctx.font = '600 13px Oswald, Impact, sans-serif';
      const lw = ctx.measureText(label).width;
      hudText(label, lx, lineView ? y - 4 : y, 13, TEAMS[team].mini, 'right', 600);
      if (lineView) hudText(`${deployLine} RESERVES`, lx, y + 9, 9, '#b9b195', 'right', 400);
      ctx.save(); ctx.translate(lx - lw - 15, y); drawFactionMark(ctx, team, 9); ctx.restore();
    });
    // battle clock just right of O1 (red and pulsing in the last two minutes), then ATTACK / DEFEND
    let tx = ox + 34;
    if (!phase && battleLeft > 0) {
      const mm = Math.floor(battleLeft / 60), ss = String(battleLeft % 60).padStart(2, '0'), late = battleLeft <= 120;
      const txt = `${mm}:${ss}`, fs = late ? 30 : 27;
      ctx.globalAlpha = late ? 0.75 + 0.25 * Math.sin(now * 6) : 1;
      hudText(txt, tx, midY + 1, fs, late ? '#ff6a4a' : '#e8e0c0', 'left', 600);
      ctx.globalAlpha = 1;
      ctx.font = `600 ${fs}px Oswald, Impact, sans-serif`;
      tx += ctx.measureText('00:00').width + 22;              // fixed width so ATTACK/DEFEND doesn't jiggle as digits change
    }
    if (myTeam) hudText(myTeam === ATTACKER ? 'ATTACK' : 'DEFEND', tx, midY, 20, myTeam === ATTACKER ? '#f6e27a' : '#d9e3ea', 'left');
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
    if (msg.team && TEAMS[msg.team]) {
      ctx.font = '600 22px Oswald, Impact, sans-serif';
      const tw = ctx.measureText(msg.text).width, es = 11, gap = 10, x0 = cx - (tw + es * 2 + gap) / 2;
      ctx.save(); ctx.translate(x0 + es, H * 0.24); drawFactionMark(ctx, msg.team, es); ctx.restore();
      hudText(msg.text, x0 + es * 2 + gap, H * 0.24, 22, '#f3ead0', 'left');
    } else hudText(msg.text, cx, H * 0.24, 22, '#f3ead0');
    ctx.globalAlpha = 1;
  }
  drawAwards();
  drawDamageDirs();
  drawSpots();
  drawMarkWheel();

  if (!(state === 'dead' && dmap.open)) drawMinimap();
  // connection: players online and ping, top left
  if (connected) {
    const pm = Math.round(ping), pc = pm < 80 ? '#7fd46a' : pm < 150 ? '#e6c84a' : '#e0573f';
    ctx.fillStyle = '#7fd46a'; ctx.beginPath(); ctx.arc(18, 18, 3.5, 0, TAU); ctx.fill();
    hudText(`${online} online`, 28, 18, 12, '#e8e0c0', 'left', 400);
    ctx.font = '400 12px Oswald, Impact, sans-serif';
    const ox = 28 + ctx.measureText(`${online} online`).width + 10;
    hudText(`${pm} ms`, ox, 18, 12, pc, 'left', 400);
  }

  if (you && state === 'play') {
    const cls = clsByIdx(you.c);
    const by = H - 64;   // anchor for the capture-status readout below
    if (autofire) hudText('AUTOFIRE', cx, H - 62, 13, '#f6e27a');

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
        // who's in the circle: your side at the right end of the bar (the way your progress grows), the enemy at the left
        const enemy = you.team === 'de' ? 'su' : 'de', cnt = t => (t === 'de' ? cps[i][4] : cps[i][5]) || 0;
        [[you.team, cx + sw / 2 + 16, 'left'], [enemy, cx - sw / 2 - 16, 'right']].forEach(([t, ex, al]) => {
          const n = cnt(t);
          ctx.globalAlpha = n ? 1 : 0.45;
          ctx.save(); ctx.translate(ex, sy + 17); drawFactionMark(ctx, t, 8); ctx.restore();
          hudText(String(n), ex + (al === 'left' ? 14 : -14), sy + 17, 16, n ? '#f3ead0' : '#8d8668', al, 600);
          ctx.globalAlpha = 1;
        });
      }
    }

    const mx = mouse.x, my = mouse.y;
    // cursor: a small dot
    if (!view2.sight) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.arc(mx, my, 3.5, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.beginPath(); ctx.arc(mx, my, 2.25, 0, TAU); ctx.fill();
    }
    // ---- reload bar, under the cursor ----
    if (cls.guns[0].kind !== 'mg') {
      const rl = you.rl || 0, bw = 40, bh = 5, rx = mx - bw / 2, ry = my + 10, clip = cls.guns[0].clip;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(rx - 1, ry - 1, bw + 2, bh + 2);
      if (clip && rl === 0) {
        // magazine gun: one pip per round left
        const am = you.am == null ? clip : you.am, pw = bw / clip;
        ctx.fillStyle = '#7fd46a';
        for (let k = 0; k < am; k++) ctx.fillRect(rx + k * pw, ry, Math.max(1, pw - 1), bh);
      } else {
        ctx.fillStyle = rl > 0 ? '#e6a03c' : '#7fd46a';
        ctx.fillRect(rx, ry, bw * (1 - rl), bh);
      }
      if (you.ap === 0 && you.ar === 0) hudText('OUT OF AMMO', mx, ry + bh + 11, 11, '#ff7a5c', 'center', 600);
      else if (rl > 0) hudText(clip ? 'RELOADING' : 'LOADING', mx, ry + bh + 11, 11, '#e6a03c', 'center', 400);
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
        // one row per MG under the main-gun reload bar: name (bright when it can bear on the cursor, dim when
        // it's out of its arc) and a belt bar (green = rounds left, orange = changing belts)
        const y0 = my + ((you.rl || 0) > 0 ? 44 : 30), bw = 34, bh = 4;
        c0.mgs.forEach((m, i) => {
          const y = y0 + i * 15, on = (you.mb >> i) & 1;
          const ammo = Array.isArray(you.ma) ? you.ma[i] : m.clip, rl = Array.isArray(you.mr) ? you.mr[i] : 0;
          hudText(m.name, mx - 4, y, 11, rl > 0 ? '#e6a03c' : on ? (mouse.rdown ? '#ffe9a8' : '#e8e0c0') : 'rgba(170,165,150,0.5)', 'right', 400);
          const bx = mx + 2, by = y - bh / 2;
          ctx.globalAlpha = on || rl > 0 ? 1 : 0.5;
          ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
          ctx.fillStyle = rl > 0 ? '#e6a03c' : '#7fd46a';
          ctx.fillRect(bx, by, bw * (rl > 0 ? 1 - rl : ammo / m.clip), bh);
          ctx.globalAlpha = 1;
        });
      }
    }
  }
}

// minimap size multiplier, changed with + / - and remembered between visits
let minimapScale = 1;
try { minimapScale = clamp(+localStorage.getItem('zitadelle.minimap') || 1, 0.6, 2.2); } catch (e) { /* ignore */ }
function setMinimapScale(v) {
  minimapScale = clamp(v, 0.6, 2.2);
  try { localStorage.setItem('zitadelle.minimap', minimapScale.toFixed(2)); } catch (e) { /* ignore */ }
}
const minimapSize = () => Math.min(170 * minimapScale, W * 0.45, H * 0.6);
function drawMinimap() {
  const s = minimapSize(), x = W - s - 12, y = H - s - 12, k = s / WORLD;
  ctx.save();
  const MA = 0.72;   // see the battlefield through it
  ctx.globalAlpha = MA;
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
    ctx.globalAlpha = MA * (cps[i] && cps[i][3] ? 0.95 : 0.45);
    ctx.fillStyle = owner ? ptColor(owner) : '#6d6a55';
    ctx.beginPath(); ctx.arc(x + p.x * k, y + p.y * k, Math.max(6, CAP_R * k), 0, TAU); ctx.fill();
    ctx.globalAlpha = MA;
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
  // spotted enemies
  for (const mk of spots) {
    const pulse = 0.5 + 0.5 * Math.sin((now - mk.t) * 8);
    ctx.fillStyle = `rgba(235,60,45,${0.75 + 0.25 * pulse})`;
    ctx.beginPath(); ctx.arc(x + mk.x * k, y + mk.y * k, 3.5 + pulse * 1.5, 0, TAU); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
  ctx.strokeRect(x + view.x0 * k, y + view.y0 * k, (view.x1 - view.x0) * k, (view.y1 - view.y0) * k);
  ctx.restore();
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
  // while the spotting wheel is open the gun stays laid where it was when Q went down
  const ax = markWheel ? markWheel.wx : cam.x + (mouse.x - W / 2) / cam.scale;
  const ay = markWheel ? markWheel.wy : cam.y + (mouse.y - H / 2) / cam.scale;
  send({ t: 'in', th, rot, ax: Math.round(ax), ay: Math.round(ay), f: (mouse.down || autofire) && !showBoard && !markWheel ? 1 : 0, m: mouse.rdown && !showBoard ? 1 : 0, cx: Math.round(cam.x), cy: Math.round(cam.y) });
}

// switch sides: only allowed in the break between battles
function switchSides() {
  // still choosing where to join: just pick the other side (the server enforces the mid-battle lock)
  if (!you) { playerTeam = playerTeam === 'de' ? 'su' : 'de'; selectFaction(playerTeam); onTeamChanged(); return; }
  if (!phase) { bigMessage('You can only switch sides between battles', 2); return; }
  playerTeam = playerTeam === 'de' ? 'su' : 'de';
  send({ t: 'switch', c: selCls[playerTeam] });
  try { localStorage.setItem('zitadelle.team', playerTeam); } catch (e) { /* ignore */ }
  if (state === 'dead') onTeamChanged();
}
function deploy(team) {
  if (!connected || dmap.sel == null) return;
  playerTeam = team;
  saveSel();
  dmap.last = { code: dmap.sel, team };   // remembered so the next redeploy starts zoomed in here
  if (you) send({ t: 'respawn', team, sp: dmap.sel, c: selCls[team] });
  else {
    send({ t: 'join', name: playerName, team, sp: dmap.sel, c: selCls[team] });
    // first spawn into a battle already under way: play your side's intro (during the break it waits for the next battle)
    if (!phase) Music.play('intro', team);
  }
  state = 'play';
  autofire = false;
  closeDeployMap();
  document.body.classList.add('playing');
  ui.menu.classList.add('hidden');
  Sound.init();
}
function backToMenu() {
  state = 'menu';
  closeDeployMap();
  document.body.classList.remove('playing');
  ui.menu.classList.remove('hidden');
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
  // a moment on the wreck, then pull back to the battle map
  setTimeout(() => { if (state === 'dead' && !dmap.open) { openDeployMap(); ui.death.classList.remove('hidden'); } }, 1300);
}

// =====================================================================
// Battle map: choose where to deploy
// =====================================================================
// stage 'map': the whole battlefield, hover a highlighted point and click it; 'zoom': the camera swoops in;
// 'pick': the vehicle panel is up. Used both when knocked out and when first joining.
const dmap = { open: false, stage: 'map', sel: null, selX: 0, selY: 0, hover: null, opts: [], lookT: 0, last: null };
// every rear area and capture point of your side, and whether you can deploy there right now
// (mirrors the server's spawnOk, including enemies within reach of the point)
function spawnOptions() {
  const out = [];
  REARS.forEach((r, k) => {
    if (r.team !== playerTeam) return;
    const lost = r.line && isLineDead(r.line);
    const empty = !lost && !poolArr(playerTeam, -1 - k).some(n => n > 0);
    out.push({ code: -1 - k, x: r.x, y: r.y, r: 380, id: r.name, name: 'Assembly area', rear: true, ok: !lost && !empty, why: lost ? 'lost' : empty ? 'out of reserves' : '' });
  });
  CAP_POINTS.forEach((p, i) => {
    const c = cps[i] || [], owner = OWNER[c[1]];
    let why = '';
    if (p.line && isLineDead(p.line)) why = 'line defeated';
    else if (owner !== playerTeam) why = owner ? 'enemy held' : 'not held';
    else if (c[2]) why = 'contested';
    else if (vTanks.some(t => t.team !== playerTeam && Math.hypot(t.x - p.x, t.y - p.y) < CAP_R + 300)) why = 'enemies nearby';
    else if (!poolArr(playerTeam, i).some(n => n > 0)) why = 'out of reserves';
    out.push({ code: i, x: p.x, y: p.y, r: CAP_R, id: p.id, name: p.name, owner, ok: !why, why });
  });
  return out;
}
function openDeployMap() {
  state = 'dead';
  dmap.open = true; dmap.stage = 'map'; dmap.sel = null; dmap.hover = null;
  document.body.classList.remove('playing');
  ui.menu.classList.add('hidden');
  ui.panel.classList.add('hidden');
  ui.mapbar.classList.remove('hidden');
  ui.death.classList.add('hidden');
  buildPicker(ui.deathPicker, playerTeam);
  // go straight back to where you last deployed, if that spot is still yours and safe
  if (dmap.last && dmap.last.team === playerTeam) {
    const o = spawnOptions().find(q => q.code === dmap.last.code);
    if (o && o.ok) chooseSpawn(o);
  }
}
function closeDeployMap() {
  armorTipHide();
  dmap.open = false; dmap.sel = null; dmap.hover = null;
  ui.death.classList.add('hidden'); ui.panel.classList.add('hidden'); ui.mapbar.classList.add('hidden');
  canvas.style.cursor = '';
}
function chooseSpawn(o) {
  dmap.sel = o.code; dmap.selX = o.x; dmap.selY = o.y; dmap.stage = 'zoom'; dmap.hover = null; dmap.lookT = 0;
  canvas.style.cursor = '';
  ui.mapbar.classList.add('hidden');
  ui.dpname.textContent = o.rear ? o.id : `${o.id} · ${o.name}`;
}
function showDeployPanel() {
  dmap.stage = 'pick';
  ui.panel.classList.remove('hidden');
}
function backToMap() {
  armorTipHide();
  dmap.stage = 'map'; dmap.sel = null;
  ui.panel.classList.add('hidden');
  ui.mapbar.classList.remove('hidden');
}
// side changed while on the map: the chosen point (if any) belonged to the other side
function onTeamChanged() {
  buildPicker(ui.deathPicker, playerTeam);
  if (dmap.open && dmap.stage !== 'map') backToMap();
}
function updateDeployMap(dt) {
  dmap.opts = spawnOptions();
  if (showBoard) { dmap.hover = null; dmap.btnHover = false; canvas.style.cursor = ''; return; }
  if (dmap.stage === 'map') {
    // hover: the point under the cursor (small ones get a minimum target size)
    let best = null, bd = Infinity;
    for (const o of dmap.opts) {
      const d = Math.hypot(W / 2 + (o.x - cam.x) * cam.scale - mouse.x, H / 2 + (o.y - cam.y) * cam.scale - mouse.y);
      if (d < Math.max(22, o.r * cam.scale) && d < bd) { best = o; bd = d; }
    }
    if (best && best.ok && (!dmap.hover || dmap.hover.code !== best.code)) Sound.click([0], 3600, 0.12);
    dmap.hover = best;
    canvas.style.cursor = best && best.ok ? 'pointer' : '';
  } else {
    // keep the server streaming the area around the chosen point (obstacles, fire)
    if ((dmap.lookT -= dt) <= 0) { dmap.lookT = 0.5; send({ t: 'look', x: Math.round(dmap.selX), y: Math.round(dmap.selY) }); }
    const o = dmap.opts.find(q => q.code === dmap.sel);
    dmap.canDeploy = !!(o && o.ok); dmap.why = o ? o.why : 'unavailable';
    // the point stopped being usable (lost, contested, enemies arrived): after a short grace period so a
    // passing flicker doesn't throw you out, pull back to the map and say why
    dmap.badT = dmap.canDeploy ? 0 : (dmap.badT || 0) + dt;
    if (dmap.badT > 0.4) {
      dmap.badT = 0;
      bigMessage(`${o ? o.id : 'That point'} is no longer available — ${dmap.why}`, 3);
      backToMap();
      return;
    }
    const wasOver = dmap.btnHover;
    dmap.btnHover = dmap.stage === 'pick' && overDeployButton(mouse.x, mouse.y);
    if (dmap.btnHover && !wasOver && dmap.canDeploy) Sound.click([0], 3600, 0.12);
    canvas.style.cursor = dmap.btnHover && dmap.canDeploy ? 'pointer' : '';
  }
}
// width the vehicle panel takes on the right (matches .deploypanel in style.css)
const deployPanelW = () => Math.min(440, W * 0.42) + 32;
const DEPLOY_BTN_R = 30;
function deployButtonPos() {
  return { x: W / 2 + (dmap.selX - cam.x) * cam.scale, y: H / 2 + (dmap.selY - cam.y) * cam.scale };
}
function overDeployButton(mx, my) {
  const b = deployButtonPos();
  return Math.hypot(mx - b.x, my - b.y) < DEPLOY_BTN_R + 6;
}
// round button on the chosen point with your side's emblem: click it to deploy
function drawDeployButton() {
  const { x, y } = deployButtonPos(), ok = dmap.canDeploy, hov = dmap.btnHover && ok;
  const R = DEPLOY_BTN_R * (hov ? 1.08 : 1), pulse = 0.5 + 0.5 * Math.sin(now * 4);
  ctx.save();
  if (ok) {   // inviting ripple
    ctx.strokeStyle = `rgba(246,226,122,${0.5 * (1 - pulse)})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, R + 6 + pulse * 10, 0, TAU); ctx.stroke();
  }
  ctx.fillStyle = ok ? (hov ? 'rgba(48,46,34,0.95)' : 'rgba(24,23,17,0.9)') : 'rgba(40,38,34,0.75)';
  ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
  ctx.strokeStyle = ok ? (hov ? '#fff6c8' : '#f6e27a') : 'rgba(150,145,130,0.6)'; ctx.lineWidth = hov ? 3.5 : 2.5;
  ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.stroke();
  ctx.globalAlpha = ok ? 1 : 0.4;
  ctx.translate(x, y); drawFactionMark(ctx, playerTeam, R * 0.5); ctx.translate(-x, -y);
  ctx.globalAlpha = 1;
  const cls = CLASSES[selCls[playerTeam]];
  if (ok) hudText(`Deploy in ${cls ? cls.name : 'vehicle'}`, x, y + R + 18, 16, hov ? '#fff6c8' : '#f0e8c8');
  else hudText(`Can't deploy — ${dmap.why}`, x, y + R + 18, 14, '#ff8a6a', 'center', 400);
  ctx.restore();
}
function drawDeployMap(a) {
  const sc = cam.scale, X = x => W / 2 + (x - cam.x) * sc, Y = y => H / 2 + (y - cam.y) * sc;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = '#8e865a'; ctx.fillRect(0, 0, W, H);
  // the steppe, villages, the two attack routes
  ctx.fillStyle = '#a39a68'; ctx.fillRect(X(0), Y(0), WORLD * sc, WORLD * sc);
  ctx.strokeStyle = '#5d5639'; ctx.lineWidth = 3; ctx.strokeRect(X(0), Y(0), WORLD * sc, WORLD * sc);
  ctx.fillStyle = 'rgba(70,58,38,0.55)';
  for (const b of BUILDINGS) ctx.fillRect(X(b.x) - 2, Y(b.y) - 2, 4, 4);
  drawRoute(ctx, sc, X(0), Y(0), 3);
  // the other side's rear areas, for orientation
  for (const r of REARS) {
    if (r.team === playerTeam) continue;
    ctx.fillStyle = r.line && isLineDead(r.line) ? 'rgba(60,40,30,0.25)' : r.team === 'de' ? 'rgba(80,95,108,0.35)' : 'rgba(160,50,35,0.3)';
    ctx.beginPath(); ctx.arc(X(r.x), Y(r.y), 380 * sc, 0, TAU); ctx.fill();
  }
  // your side's vehicles
  ctx.fillStyle = TEAMS[playerTeam].mini;
  for (const t of vTanks) if (t.team === playerTeam) { ctx.beginPath(); ctx.arc(X(t.x), Y(t.y), 3, 0, TAU); ctx.fill(); }
  // spawn points: valid ones pulse, the hovered one lifts and names itself
  const pulse = 0.5 + 0.5 * Math.sin(now * 4);
  for (const o of dmap.opts) {
    const hov = dmap.hover === o || dmap.sel === o.code, x = X(o.x), y = Y(o.y);
    const R = Math.max(14, o.r * sc) * (hov && o.ok ? 1.12 : 1);
    const col = o.rear ? TEAMS[playerTeam].mini : o.owner ? ptColor(o.owner) : '#6d6a55';
    ctx.globalAlpha = a * (o.ok ? 0.95 : 0.4);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
    ctx.globalAlpha = a;
    if (o.ok) {
      ctx.strokeStyle = hov ? '#fff6c8' : `rgba(246,226,122,${0.55 + 0.4 * pulse})`;
      ctx.lineWidth = hov ? 4 : 2.5;
      ctx.beginPath(); ctx.arc(x, y, R + 4 + (hov ? 0 : pulse * 3), 0, TAU); ctx.stroke();
    } else if (!o.rear && cps[o.code] && cps[o.code][2]) {
      ctx.strokeStyle = `rgba(255,90,60,${0.5 + 0.5 * Math.sin(now * 10)})`; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(x, y, R + 4, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = a * (o.ok ? 1 : 0.6);
    hudText(o.rear ? o.id.toUpperCase() : o.id, x, y, o.rear ? 12 : Math.max(12, Math.min(22, R * 0.7)), '#fff');
    ctx.globalAlpha = a;
    if (dmap.hover === o) {
      hudText(o.name, x, y + R + 14, 13, '#e8e0c0', 'center', 400);
      hudText(o.ok ? 'Click to deploy here' : `Unavailable — ${o.why}`, x, y + R + 30, 12, o.ok ? '#f6e27a' : '#ff8a6a', 'center', 400);
    }
  }
  if (dmap.stage === 'map') {
    hudText('CHOOSE WHERE TO DEPLOY', W / 2, 104, 24, '#e8e0c0');
    hudText(`${TEAMS[playerTeam].name} · click a highlighted point`, W / 2, 128, 13, '#b9b195', 'center', 400);
  }
  ctx.restore();
}

// =====================================================================
// Leaderboard (hold Tab)
// =====================================================================
let board = null, showBoard = false, online = 0;
function drawBoard() {
  if (!showBoard || !board) return;
  // darken everything behind it
  ctx.fillStyle = 'rgba(8,8,5,0.62)'; ctx.fillRect(0, 0, W, H);
  const teams = ['de', 'su'].map(tm => board.filter(r => TEAM_IDS[r[1]] === tm).sort((p, q) => q[3] - p[3]));
  const n = Math.max(1, ...teams.map(t => t.length));
  // laid out at a base size, then scaled up as far as the screen allows (rows get cut only if it still won't fit)
  const k = clamp(Math.min((W - 48) / (2 * 380 + 16), (H - 60) / (58 + n * 22 + 10)), 0.85, 1.6);
  const colW = 380 * k, rowH = 22 * k, head = 58 * k, gap = 8 * k;
  const maxRows = Math.max(1, Math.floor((H - 60 - head - 10 * k) / rowH));
  const rows = Math.min(maxRows, n);
  const h = head + rows * rowH + 10 * k, y0 = Math.max(30, (H - h) / 2);
  const f = v => v * k;   // font / offset sizes
  teams.forEach((list, ti) => {
    const tm = ti ? 'su' : 'de', x0 = W / 2 + (ti ? gap : -gap - colW);
    ctx.fillStyle = 'rgba(22,21,15,0.94)'; ctx.fillRect(x0, y0, colW, h);
    ctx.strokeStyle = 'rgba(93,86,57,0.9)'; ctx.lineWidth = 2; ctx.strokeRect(x0, y0, colW, h);
    ctx.fillStyle = TEAMS[tm].mini; ctx.fillRect(x0, y0, colW, f(4));
    const kills = list.reduce((m, r) => m + r[4], 0);
    hudText(TEAMS[tm].name.toUpperCase(), x0 + f(12), y0 + f(21), 18, '#f0e8c8', 'left');
    hudText(`${list.length} tanks · ${kills} kills`, x0 + colW - f(12), y0 + f(21), 12, '#a99f78', 'right', 400);
    const cS = x0 + colW - f(92), cK = x0 + colW - f(50), cD = x0 + colW - f(16);
    hudText('COMMANDER', x0 + f(40), y0 + f(45), 10, '#8d8668', 'left', 400);
    hudText('SCORE', cS, y0 + f(45), 10, '#8d8668', 'right', 400);
    hudText('K', cK, y0 + f(45), 10, '#8d8668', 'right', 400);
    hudText('D', cD, y0 + f(45), 10, '#8d8668', 'right', 400);
    list.slice(0, rows).forEach((r, i) => {
      const y = y0 + head + i * rowH + rowH / 2 - f(2), mine = you && r[0] === you.id;
      if (mine) { ctx.fillStyle = 'rgba(231,220,177,0.16)'; ctx.fillRect(x0 + 3, y - rowH / 2, colW - 6, rowH); }
      else if (i % 2) { ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(x0 + 3, y - rowH / 2, colW - 6, rowH); }
      ctx.globalAlpha = r[7] ? 1 : 0.5;     // knocked out: dimmed
      drawInsignia(ctx, tm, r[6], x0 + f(22), y, f(15));
      // clip long names short of the score column
      ctx.save(); ctx.beginPath(); ctx.rect(x0 + f(34), y - rowH / 2, cS - f(50) - (x0 + f(34)), rowH); ctx.clip();
      hudText(r[2], x0 + f(40), y, 13, mine ? '#fff6c8' : '#e8e0c0', 'left', mine ? 600 : 400);
      ctx.restore();
      hudText(fmt(r[3]), cS, y, 13, '#e8e0c0', 'right', 400);
      hudText(String(r[4]), cK, y, 13, '#e8e0c0', 'right', 400);
      hudText(String(r[5]), cD, y, 13, '#e8e0c0', 'right', 400);
      ctx.globalAlpha = 1;
    });
    if (list.length > rows) hudText(`+${list.length - rows} more`, x0 + colW / 2, y0 + h - f(6), 11, '#8d8668', 'center', 400);
  });
}

// =====================================================================
// Faction info: each side's role, ranks and vehicles
// =====================================================================
// each nation's official name in its own language, as of 1943
const NATIVE_NAME = {
  de: 'Deutsches Reich',
  su: 'Союз Советских Социалистических Республик',
  it: "Regno d'Italia",
  us: 'United States of America',
  gb: 'United Kingdom of Great Britain and Northern Ireland',
};
const FACTION_INFO = {
  de: { coalition: 'Axis', desc: 'In July 1943 Germany launched Operation Citadel, a pincer attack on the northern and southern '
    + 'faces of the Kursk salient meant to encircle the Soviet armies inside it. The offensive was delayed for months to bring up '
    + 'new Tiger and Panther tanks and Ferdinand tank destroyers, giving the defenders time to dig in.' },
  su: { coalition: 'Allies', desc: 'Warned of the coming attack, the Red Army turned the Kursk salient into one of the most heavily '
    + 'fortified battlefields in history, with deep belts of minefields, anti-tank guns and dug-in tanks. Once the German '
    + 'assault had been worn down, Soviet counter-offensives seized the initiative on the Eastern Front for the rest of the war.' },
  it: { coalition: 'Axis', desc: 'Germany\'s main European ally. Italian armour had been designed for the deserts of North Africa '
    + 'and was thinly protected and under-gunned by 1943. On 10 July 1943, days into Operation Citadel, the Allies landed in '
    + 'Sicily; the threat helped persuade Hitler to call off the Kursk offensive, and Mussolini was overthrown before the month was out.' },
  us: { coalition: 'Allies', desc: 'American factories built armour on a scale no other nation matched, nearly 50,000 Shermans '
    + 'alone, and Lend-Lease sent thousands of tanks to Britain and the Soviet Union. In July 1943, while the battle of Kursk was '
    + 'being fought, US troops landed in Sicily alongside the British.' },
  gb: { coalition: 'Allies', desc: 'Britain fielded both fast cruiser tanks and slow, heavily armoured infantry tanks, and shipped '
    + 'thousands of tanks to the Soviet Union on the Arctic convoys; British-built Churchills fought with the Red Army at Kursk. '
    + 'In July 1943 British and Commonwealth troops landed in Sicily with the Americans.' },
};
// coalition badge: a shield. Axis: black with a silver rim and a gold X; Allies: olive with an olive branch.
function drawCoalitionBadge(c, coalition, w, h) {
  const axis = coalition === 'Axis';
  c.clearRect(0, 0, w, h);
  const sx = w * 0.1, sw = w * 0.8, sy = h * 0.06, sh = h * 0.88;
  c.beginPath();
  c.moveTo(sx, sy); c.lineTo(sx + sw, sy); c.lineTo(sx + sw, sy + sh * 0.55);
  c.quadraticCurveTo(sx + sw, sy + sh * 0.85, sx + sw / 2, sy + sh);
  c.quadraticCurveTo(sx, sy + sh * 0.85, sx, sy + sh * 0.55); c.closePath();
  c.fillStyle = axis ? '#1c1c1c' : '#4f5a2e'; c.fill();
  c.lineWidth = w * 0.06; c.strokeStyle = axis ? '#bfc3c4' : '#d9cf9f'; c.stroke();
  const cx = w / 2, cy = sy + sh * 0.45;
  if (axis) {
    // a bold gold X
    const r = w * 0.2;
    c.lineCap = 'butt'; c.strokeStyle = '#d4ad47'; c.lineWidth = w * 0.1;
    c.beginPath(); c.moveTo(cx - r, cy - r); c.lineTo(cx + r, cy + r); c.moveTo(cx + r, cy - r); c.lineTo(cx - r, cy + r); c.stroke();
  } else {
    // olive branch: a gently curving stem with paired leaves and two olives, in white
    const u = w * 0.01;
    const P = t => ({ x: cx - 18 * u + 36 * u * t, y: cy + 26 * u - 52 * u * t - Math.sin(t * Math.PI) * 6 * u });   // point along the stem
    c.strokeStyle = '#f2f2ea'; c.lineWidth = 2.6 * u; c.lineCap = 'round';
    c.beginPath(); for (let i = 0; i <= 20; i++) { const q = P(i / 20); if (i) c.lineTo(q.x, q.y); else c.moveTo(q.x, q.y); } c.stroke();
    const leaf = (t, side, len) => {
      const q = P(t), q2 = P(Math.min(1, t + 0.02)), ang = Math.atan2(q2.y - q.y, q2.x - q.x) + side * 0.75;
      c.save(); c.translate(q.x, q.y); c.rotate(ang);
      c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(len * 0.5, -len * 0.28, len, 0); c.quadraticCurveTo(len * 0.5, len * 0.28, 0, 0);
      c.fillStyle = '#f2f2ea'; c.fill(); c.restore();
    };
    for (const [t, side] of [[0.22, 1], [0.32, -1], [0.45, 1], [0.55, -1], [0.68, 1], [0.78, -1]]) leaf(t, side, 15 * u);
    leaf(0.97, 0, 13 * u);
    c.fillStyle = '#f2f2ea';
    for (const [t, side] of [[0.38, -1], [0.62, 1]]) { const q = P(t); c.beginPath(); c.arc(q.x + side * 6 * u, q.y + 4 * u, 2.6 * u, 0, TAU); c.fill(); }
  }
}
// real-life background for each vehicle, shown on hover in the faction info screen
const VEHICLE_HISTORY = {
  pz2c: 'Light tank from 1937, armed with a 20mm KwK 30 autocannon fed by 10-round magazines. Obsolete by 1943 and mostly used for reconnaissance and security duties.',
  pz38t: 'The Czechoslovak LT vz. 38, taken over after the occupation of 1939. A reliable 37mm-armed light tank that made up much of the panzer force in 1940–41; its chassis later carried the Marder III and the Hetzer.',
  luchs: 'The Panzer II Ausf. L "Luchs" (lynx), a purpose-built reconnaissance tank of 1943 with a 20mm KwK 38 and a fast, interleaved-wheel suspension. Only about 100 were built.',
  pz3: 'Intended as Germany\'s main battle tank. By Kursk most carried the long 50mm KwK 39; outclassed by the T-34, it was being withdrawn from the front line and production ended in 1943.',
  pz4: 'Germany\'s most-produced tank of the war, at around 8,500. From 1942 the long 75mm KwK 40 let it fight the T-34 on equal terms, and it was the most numerous German tank at Kursk.',
  hetzer: 'The Jagdpanzer 38(t): a small, low tank destroyer on the Panzer 38(t) chassis with a 75mm PaK 39. Entered service in 1944, after Kursk; cheap to build, with about 2,800 made.',
  stug: 'Sturmgeschütz III: a turretless assault gun on the Panzer III chassis, built for infantry support. With the long 75mm it became Germany\'s most-produced armoured vehicle, around 10,000, and one of its most effective tank killers.',
  jgpz4: 'A low-slung tank destroyer on the Panzer IV chassis, introduced in 1944. Later versions carried the Panther\'s long 75mm L/70 gun.',
  jagdpanther: 'A tank destroyer on the Panther chassis with the 88mm PaK 43, introduced in 1944. Often called the best tank destroyer of the war; only about 415 were built.',
  ferdinand: '91 were built on Porsche\'s rejected Tiger chassis, with the 88mm PaK 43 and 200mm of frontal armour. They made their combat debut at Kursk, destroying many tanks but suffering for having no machine gun against infantry. Later rebuilt as the Elefant.',
  brummbaer: 'Sturmpanzer IV: a Panzer IV chassis with a 150mm StuH 43 howitzer in a heavily armoured superstructure, built for knocking out fortifications. It first saw combat at Kursk.',
  tiger: 'Heavy tank with the 88mm KwK 36 and 100mm of frontal armour, in service from 1942. Feared for its gun and protection, but complex and expensive; about 1,350 were built.',
  panther: 'A medium tank designed in answer to the T-34, with sloped armour and a high-velocity 75mm KwK 42. Rushed into service for Kursk, where mechanical breakdowns crippled its debut.',
  tiger2: 'The King Tiger: the heaviest German tank in series production, with the long 88mm KwK 43 and 150mm of sloped frontal armour. In service from 1944; about 490 were built.',
  jagdtiger: 'At around 72 tonnes, the heaviest armoured vehicle of the war to reach production, armed with a 128mm PaK 44. Only some 80–90 were built, from 1944.',
  t26: 'A Soviet development of the British Vickers 6-ton tank and the world\'s most numerous tank in the late 1930s. A thinly armoured infantry tank with a 45mm gun; a few survivors still served in 1943.',
  bt7: 'A "fast tank" built on American J. Walter Christie\'s suspension, able to run on its road wheels with the tracks removed. Very quick but lightly armoured, and lost in large numbers in 1941.',
  t70: 'A two-man light tank with a 45mm gun, built in large numbers in 1942–43, about 8,200 in all. The commander also had to load and fire the gun.',
  t28: 'A pre-war multi-turreted medium tank with a short 76mm gun in the main turret and two machine-gun turrets at the front. About 500 were built; most were lost in 1941.',
  t34: 'Sloped armour, a 76mm gun, wide tracks and a diesel engine made it a shock to the Germans in 1941. The most numerous tank at Kursk, and with the T-34-85 the most-produced tank of the war.',
  t3485: 'The T-34 upgunned with an 85mm gun in a larger three-man turret, introduced in early 1944 in answer to the Tiger and Panther.',
  kv1s: 'A lightened, faster version of the KV-1 heavy tank; the "S" stands for skorostnoy, "fast". Introduced in 1942 with thinner armour and a 76mm gun.',
  kv85: 'A stop-gap heavy tank of late 1943: the KV-1S hull with a new turret and 85mm gun to counter the Tiger. Only about 150 were made before the IS-2 replaced it.',
  is2: 'A heavy breakthrough tank named after Iosif Stalin, with a 122mm D-25T gun able to knock out Tigers and Panthers, in service from 1944. Slow to reload, and it carried only 28 rounds.',
  su76: 'A light self-propelled gun on a lengthened T-70 chassis, with the 76mm ZiS-3 field gun in an open-topped compartment. Over 14,000 were built, second only to the T-34 among Soviet armoured vehicles.',
  su85: 'A tank destroyer on the T-34 chassis with an 85mm gun, introduced in late 1943 after Kursk showed the need to fight Tigers and Panthers at range.',
  su100: 'Successor to the SU-85 with a 100mm D-10S gun, from late 1944. One of the most powerful Soviet tank destroyers of the war.',
  su122: 'An assault gun on the T-34 chassis with a 122mm M-30 howitzer for infantry support. It fought at Kursk, and production gave way to the SU-85 later in 1943.',
  su152: 'Built in weeks in early 1943 by mounting a 152mm ML-20 gun-howitzer on the KV-1S chassis. Its success against German heavy armour at Kursk earned it the nickname Zveroboy, "beast killer".',
  isu152: 'The 152mm gun-howitzer on the heavier IS chassis, from late 1943. Used as a heavy assault gun, tank destroyer and bunker buster, and kept in service long after the war.',
  l640: 'Italy\'s last light tank, in service from 1941 with a 20mm Breda autocannon. Too lightly armoured for front-line fighting by 1943; about 280 were built.',
  m1340: 'The most numerous Italian tank of the war, with a 47mm gun and riveted armour. Effective in the early desert battles, but cramped, slow and outclassed by 1942.',
  p2640: 'Italy\'s heaviest tank, with a 75mm gun. Only a handful were ready before the armistice of September 1943; most were completed and used by German forces.',
  sem7518: 'A low assault gun with a short 75mm howitzer on the M13/40-family chassis. Built as a stop-gap, it became one of Italy\'s most effective armoured vehicles in North Africa.',
  m3stuart: 'American light tank with a 37mm gun, valued for its speed and reliability; British crews nicknamed it the "Honey". Thousands went to Britain and the Soviet Union under Lend-Lease.',
  m4sherman: 'The main American tank of the war, with nearly 50,000 built. Reliable, easy to maintain and quick to bring its gun to bear, it equipped the US, British, Soviet and many other armies.',
  m26: 'Heavy tank with a 90mm gun, rushed to Europe in early 1945 to counter the Tiger and Panther. Only a few hundred reached the front before the war ended.',
  m10: 'Tank destroyer on the Sherman chassis with a 3-inch gun in an open-topped turret, in service from 1942. It traded armour for speed and a powerful gun.',
  tetrarch: 'Light tank with a 2-pounder gun, later adapted to be carried into battle by glider. Tetrarchs landed with British airborne troops in Normandy in June 1944.',
  cromwell: 'Fast British cruiser tank with a 75mm gun, in service from 1944. Its Meteor engine, derived from the Spitfire\'s Merlin, made it one of the fastest tanks of the war.',
  churchill: 'Heavily armoured infantry tank built to climb rough ground and obstacles; the Mark VII had up to 152mm of frontal armour. Churchills sent to the Soviet Union fought at Kursk.',
  achilles: 'The British conversion of the American M10 with the 17-pounder, one of the few Allied guns that could defeat the Tiger and Panther from the front at range.',
};
function placeInfoTip(x, y) {
  const t = ui.infotip, w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.max(8, Math.min(innerWidth - w - 8, x + 16)) + 'px';
  t.style.top = (y + 18 + h > innerHeight - 8 ? y - h - 12 : y + 18) + 'px';
}
const infoOpen = () => !ui.info.classList.contains('hidden');
// opens on the two coalitions; clicking one shows its nations (your own side's coalition opens on your nation)
const COALITION_ORDER = { Axis: ['de', 'it'], Allies: ['su', 'us', 'gb'] };
const heroOpen = () => !document.getElementById('infohero').classList.contains('hidden');
function openInfo() { ui.info.classList.remove('hidden'); showHero(); }
function closeInfo() { ui.info.classList.add('hidden'); ui.infotip.classList.add('hidden'); }
function showHero() {
  const hero = document.getElementById('infohero');
  hero.classList.remove('hidden');
  document.getElementById('infonation').classList.add('hidden');
  ui.infotip.classList.add('hidden');
  // replay the entrance animation every time
  hero.classList.remove('enter'); void hero.offsetWidth; hero.classList.add('enter');
}
function openCoalition(coal) {
  document.getElementById('infohero').classList.add('hidden');
  document.getElementById('infonation').classList.remove('hidden');
  const cv = document.getElementById('coalbadge');
  drawCoalitionBadge(cv.getContext('2d'), coal, cv.width, cv.height);
  document.getElementById('coalname').textContent = coal;
  const tabs = document.getElementById('nationtabs'), list = COALITION_ORDER[coal];
  tabs.innerHTML = list.map(t => `<button class="${t}" data-team="${t}">${escapeHtml(TEAMS[t].name)}</button>`).join('');
  tabs.querySelectorAll('button').forEach(b => b.addEventListener('click', () => showInfo(b.dataset.team)));
  showInfo(list.includes(playerTeam) ? playerTeam : list[0]);
}
function showInfo(team) {
  document.querySelectorAll('#nationtabs button').forEach(b => b.classList.toggle('sel', b.dataset.team === team));
  const body = document.getElementById('infobody');
  const F = FACTION_INFO[team];
  let html = `<div class="infohead">
    <canvas width="160" height="160" data-mark="${team}"></canvas>
    <div class="infotext">
      <div class="infoname">${escapeHtml(TEAMS[team].name)}${Z.FACTIONS[team].playable ? '' : '<span class="infosoon">Coming soon</span>'}</div>
      <div class="infonative">${escapeHtml(NATIVE_NAME[team] || '')}</div>
      <div class="infocoal"><canvas width="64" height="72" data-coal="${F.coalition}"></canvas>${F.coalition}</div>
      <p>${escapeHtml(F.desc)}</p>
    </div>
  </div>`;
  // ranks: the first two are only held by AI crews; players start at the third and climb with score
  // ranks left to right, lowest first, numbered
  html += '<div class="infosec">Ranks</div><div class="rranks">';
  RANKS[team].forEach((r, i) => {
    const req = i < 2 ? '<span class="rscore muted">AI crews only</span>'
      : i === 2 ? '<span class="rscore">Starting rank</span>'
      : `<span class="rscore">${fmt(RANK_SCORE[i])} score</span>`;
    html += `<div class="rcard"><span class="rnum">${i + 1}</span><canvas width="120" height="120" data-rank="${i}"></canvas>` +
      `<b>${escapeHtml(r[1])}</b><small>${escapeHtml(r[0])}</small>${req}</div>`;
  });
  html += '</div>';
  // vehicles by category; hover one for a little of its real history
  html += '<div class="infosec">Vehicles</div>';
  CATS.forEach((cat, ci) => {
    const ids = Z.FACTIONS[team].playable ? sideClasses(team).filter(id => CLASSES[id].cat === ci)
      : CLASS_IDS.filter(id => CLASSES[id].faction === team && CLASSES[id].cat === ci);
    if (!ids.length) return;
    html += `<div class="infocat">${escapeHtml(cat.name)}</div><div class="infoveh">`;
    for (const id of ids) html += `<div data-id="${id}"><canvas width="320" height="240" data-veh="${id}"></canvas>${escapeHtml(CLASSES[id].name)}</div>`;
    html += '</div>';
  });
  body.innerHTML = html;
  body.querySelectorAll('canvas[data-mark]').forEach(cv => {
    const c = cv.getContext('2d'); c.save(); c.translate(cv.width / 2, cv.height / 2);
    drawFactionMark(c, team, cv.width * 0.36); c.restore();
  });
  body.querySelectorAll('canvas[data-coal]').forEach(cv => drawCoalitionBadge(cv.getContext('2d'), cv.dataset.coal, cv.width, cv.height));
  body.querySelectorAll('canvas[data-rank]').forEach(cv => {
    const c = cv.getContext('2d');
    drawInsignia(c, team, +cv.dataset.rank, cv.width / 2, cv.height / 2, cv.height * 0.7);
  });
  body.querySelectorAll('canvas[data-veh]').forEach(cv => drawPreview(cv, cv.dataset.veh, team, 0));
  // history tooltip that follows the cursor
  body.querySelectorAll('.infoveh > div').forEach(d => {
    const txt = VEHICLE_HISTORY[d.dataset.id];
    if (!txt) return;
    d.addEventListener('mouseenter', () => {
      ui.infotip.innerHTML = `<b>${escapeHtml(CLASSES[d.dataset.id].name)}</b>${escapeHtml(txt)}`;
      ui.infotip.classList.remove('hidden');
    });
    d.addEventListener('mousemove', e => placeInfoTip(e.clientX, e.clientY));
    d.addEventListener('mouseleave', () => ui.infotip.classList.add('hidden'));
  });
}

// =====================================================================
// DOM UI
// =====================================================================
const ui = {
  menu: document.getElementById('menu'),
  death: document.getElementById('death'),
  deathPicker: document.getElementById('deathpick'),
  status: document.getElementById('status'),
  deployBtn: document.getElementById('deploy'),
  panel: document.getElementById('deploypanel'),
  mapbar: document.getElementById('mapbar'),
  info: document.getElementById('info'),
  infotip: document.getElementById('infotip'),
  chat: document.getElementById('chat'),
  chatlog: document.getElementById('chatlog'),
  chatbar: document.getElementById('chatbar'),
  chatmode: document.getElementById('chatmode'),
  chatinput: document.getElementById('chatinput'),
  chathint: document.getElementById('chathint'),
  dpname: document.getElementById('dpname'),
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
  const left = poolArr(c.faction, dmap.sel)[c.cat];
  el.querySelector('.vdetail').innerHTML = `<b>${escapeHtml(c.name)}</b> <span class="vrole">${CATS[c.cat].name} · ${left} in reserve</span>`;
}
// ---- armour card: hold the mouse on a vehicle in the picker for a moment ----
const ARMOR_TIP_DELAY = 1000;
const armorTip = document.getElementById('armortip');
let armorTipT = null;
// colour for an effective thickness: thin red -> orange -> yellow -> thick green
function armorColor(mm) {
  const stops = [[0, [200, 60, 45]], [40, [220, 120, 50]], [80, [225, 195, 70]], [130, [140, 200, 90]], [200, [90, 190, 120]]];
  let i = 1; while (i < stops.length - 1 && mm > stops[i][0]) i++;
  const [m0, c0] = stops[i - 1], [m1, c1] = stops[i], f = clamp((mm - m0) / (m1 - m0), 0, 1);
  return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * f)).join(',')})`;
}
function armorTipSoon(tile, id) {
  armorTipHide();
  armorTipT = setTimeout(() => showArmorTip(tile, id), ARMOR_TIP_DELAY);
}
function armorTipHide() { clearTimeout(armorTipT); armorTipT = null; armorTip.classList.add('hidden'); }
function showArmorTip(tile, id) {
  const A = window.ZARMOR, c = CLASSES[id];
  if (!A || !c || !A.armorOf(id)) return;
  const [front, side, rear] = A.armorOf(id), slope = A.slopeOf(id);
  const effFront = Math.round(front / Math.cos(slope * Math.PI / 180));
  armorTip.querySelector('.atname').textContent = c.name;
  const apcr = A.ammoOf(id).apcr;
  armorTip.querySelector('.atgun').innerHTML = `Gun: <b>${A.penOf(id)} mm</b> AP` + (apcr ? ` · <b>${A.apcrPenOf(id)} mm</b> APCR` : '');
  // top-down hull, front up, each side a plate coloured by its effective armour
  const cv = armorTip.querySelector('canvas'), g = cv.getContext('2d'), S = 2;     // drawn at 2x for crispness
  g.setTransform(S, 0, 0, S, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
  const cx = 110, cy = 92, k = 52 / Math.max(c.hull[0], c.hull[1] * 1.2);
  const L = c.hull[0] * k, Wd = c.hull[1] * k, x0 = cx - Wd / 2, y0 = cy - L / 2, pw = 7;
  g.fillStyle = 'rgba(231,220,177,0.08)'; g.fillRect(x0, y0, Wd, L);
  const plate = (x, y, w, h, mm) => { g.fillStyle = armorColor(mm); g.fillRect(x, y, w, h); };
  plate(x0, y0 - pw, Wd, pw, effFront);                // front
  plate(x0, y0 + L, Wd, pw, rear);                     // rear
  plate(x0 - pw, y0, pw, L, side); plate(x0 + Wd, y0, pw, L, side);   // sides
  // a turret / casemate hint so the front reads at a glance
  g.fillStyle = 'rgba(231,220,177,0.18)';
  g.beginPath(); g.arc(cx, cy - L * 0.05, Wd * 0.28, 0, TAU); g.fill();
  g.fillRect(cx - 1.5, y0 - pw - 10, 3, cy - L * 0.05 - (y0 - pw - 10));
  const label = (txt, x, y, col, size = 13, align = 'center', weight = 600) => {
    g.font = `${weight} ${size}px Oswald, Impact, sans-serif`; g.textAlign = align; g.textBaseline = 'middle';
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.8)'; g.strokeText(txt, x, y); g.fillStyle = col; g.fillText(txt, x, y);
  };
  label(`${effFront} mm`, cx, y0 - pw - 22, armorColor(effFront), 15);
  if (slope) label(`${front} mm @ ${slope}°`, cx, y0 - pw - 37, '#a99f78', 10, 'center', 400);
  label(`${rear} mm`, cx, y0 + L + pw + 14, armorColor(rear));
  label(`${side}`, x0 - pw - 6, cy, armorColor(side), 13, 'right');
  label(`${side}`, x0 + Wd + pw + 6, cy, armorColor(side), 13, 'left');
  label('FRONT', cx, y0 + 9, 'rgba(231,220,177,0.45)', 8, 'center', 400);
  label('REAR', cx, y0 + L - 9, 'rgba(231,220,177,0.45)', 8, 'center', 400);
  // place it beside the tile, on whichever side has room
  armorTip.classList.remove('hidden');
  const r = tile.getBoundingClientRect(), w = armorTip.offsetWidth, h = armorTip.offsetHeight;
  let x = r.left - w - 10; if (x < 8) x = Math.min(innerWidth - w - 8, r.right + 10);
  armorTip.style.left = x + 'px';
  armorTip.style.top = clamp(r.top + r.height / 2 - h / 2, 8, innerHeight - h - 8) + 'px';
}

function buildPicker(el, team) {
  if (!el) return;
  armorTipHide();
  if (!CLASSES[selCls[team]] || CLASSES[selCls[team]].faction !== team || !CLASSES[selCls[team]].enabled) selCls[team] = START_CLASS[team];
  el.innerHTML = '<div class="vgroups"></div><div class="vdetail"></div>';
  const groups = el.querySelector('.vgroups'), grids = {};
  for (const id of sideClasses(team)) {
    const cat = CLASSES[id].cat;
    if (!grids[cat]) {
      const sec = document.createElement('div');
      sec.className = 'vgroup';
      sec.innerHTML = `<div class="vgrouphead" data-cat="${cat}">${escapeHtml(CATS[cat].name)}<span></span></div><div class="vgrid"></div>`;
      groups.appendChild(sec);
      grids[cat] = sec.querySelector('.vgrid');
    }
    const grid = grids[cat];
    const b = document.createElement('button');
    b.className = 'veh' + (id === selCls[team] ? ' sel' : '');
    b.dataset.id = id;
    b.innerHTML = `<canvas width="160" height="120"></canvas><span>${escapeHtml(CLASSES[id].name)}</span><em class="vcat"></em>`;
    b.title = CATS[CLASSES[id].cat].name;
    b.addEventListener('click', () => {
      if (b.classList.contains('empty')) return;
      selCls[team] = id; saveSel();
      el.querySelectorAll('.veh').forEach(v => v.classList.toggle('sel', v.dataset.id === id));
      pickerDetail(el, id);
    });
    b.addEventListener('mouseenter', () => { pickerDetail(el, id); armorTipSoon(b, id); });
    b.addEventListener('mouseleave', () => { pickerDetail(el, selCls[team]); armorTipHide(); });
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
  const team = el.dataset.team, r = poolArr(team, dmap.sel);
  const sig = r.join(',');
  if (sig === el.dataset.sig) return;
  el.dataset.sig = sig;
  el.querySelectorAll('.veh').forEach(b => {
    const c = CLASSES[b.dataset.id], n = r[c.cat];
    b.querySelector('.vcat').textContent = n <= 0 ? 'none left' : '';
    b.classList.toggle('empty', n <= 0);
  });
  el.querySelectorAll('.vgrouphead').forEach(h => { h.querySelector('span').textContent = `${r[+h.dataset.cat]} in reserve`; });
  const cur = CLASSES[selCls[team]];
  if (cur && r[cur.cat] <= 0) {
    const alt = sideClasses(team).find(id => r[CLASSES[id].cat] > 0);
    if (alt) { selCls[team] = alt; el.querySelectorAll('.veh').forEach(v => v.classList.toggle('sel', v.dataset.id === alt)); }
  }
  pickerDetail(el, selCls[team]);
}
function saveSel() {
  try { localStorage.setItem('zitadelle.cls', JSON.stringify(selCls)); } catch (e) { /* ignore */ }
}
// ---- chat ----
const CHAT_LINES = 8;          // messages kept on screen
let chatOpen = false, chatTeam = true;   // team chat by default; Tab switches
const chatMsgs = [];
function openChat() {
  chatOpen = true;
  keys.clear(); mouse.down = mouse.rdown = false;      // stop driving/firing while typing
  ui.chatbar.classList.remove('hidden');
  ui.chatinput.value = '';
  updateChatMode();
  ui.chatinput.focus();
}
function closeChat() {
  if (!chatOpen) return;
  chatOpen = false;
  ui.chatbar.classList.add('hidden');
  ui.chatinput.blur();
}
function updateChatMode() {
  ui.chatmode.textContent = chatTeam ? 'TEAM' : 'ALL';
  ui.chatmode.className = 'chatmode ' + (chatTeam ? 'team' : 'all');
}
function addChat(e) {
  const team = TEAM_IDS[e.t], el = document.createElement('div');
  el.className = 'chatline';
  // team-only messages are written in the team's colour; all-chat text stays plain
  const col = TEAMS[team] ? TEAMS[team].mini : '#ddd';
  el.innerHTML = `<b style="color:${col}">${escapeHtml(e.n)}</b>: <span${e.tm ? ` style="color:${col}"` : ''}>${escapeHtml(e.x)}</span>`;
  ui.chatlog.appendChild(el);
  chatMsgs.push({ el, t: now });
  while (chatMsgs.length > 40) chatMsgs.shift().el.remove();
}
function updateChat() {
  ui.chat.classList.toggle('hidden', state === 'menu');
  ui.chathint.classList.toggle('hidden', chatOpen);
  // the last few messages stay up (no fading); older ones scroll away
  chatMsgs.forEach((m, i) => { m.el.style.display = i >= chatMsgs.length - CHAT_LINES ? '' : 'none'; });
}
ui.chatinput.addEventListener('keydown', e => {
  e.stopPropagation();                                     // typing never reaches the game's key handlers
  if (e.key === 'Tab') { e.preventDefault(); chatTeam = !chatTeam; updateChatMode(); }
  else if (e.key === 'Enter') {
    const x = ui.chatinput.value.trim();
    if (x) send({ t: 'chat', x, tm: chatTeam ? 1 : 0 });
    closeChat();
  } else if (e.key === 'Escape') closeChat();
});
ui.chatinput.addEventListener('blur', closeChat);
// Enter opens the chat while driving or looking at the battle map (on the vehicle panel Enter still deploys)
addEventListener('keydown', e => {
  if (e.key !== 'Enter' || chatOpen || showBoard || e.target.tagName === 'INPUT') return;
  if (state === 'play' || (state === 'dead' && dmap.open && dmap.stage === 'map')) { e.preventDefault(); openChat(); }
});

// ---- main gun ammo bar ----
const ammoBar = document.getElementById('ammobar');
const ammoBtn = { ap: ammoBar.querySelector('[data-a="ap"]'), apcr: ammoBar.querySelector('[data-a="apcr"]') };
let ammoSig = '';
function setAmmo(s) {
  if (state !== 'play' || !you || !you.alive) return;
  if (s === 'apcr' && !you.ar) { bigMessage('No APCR rounds for this gun', 1.2); return; }
  send({ t: 'ammo', s });
}
// (a display only: switched with 1 / 2)
function updateAmmoBar() {
  const cls = you ? clsByIdx(you.c) : null;
  const show = state === 'play' && you && you.alive && cls && cls.guns[0].kind === 'shell' && you.ap !== undefined;
  ammoBar.classList.toggle('hidden', !show);
  if (!show) { ammoSig = ''; return; }
  // reload progress of the round going in (magazine guns: only while changing magazines)
  const prog = you.rl > 0 ? Math.round((1 - you.rl) * 50) / 50 : 0;
  const sig = [cls.id, you.ap, you.ar, you.as, you.aq, prog].join(',');
  if (sig === ammoSig) return;
  ammoSig = sig;
  const A = window.ZARMOR;
  for (const [s, b] of Object.entries(ammoBtn)) {
    const n = s === 'ap' ? you.ap : you.ar, pen = A ? (s === 'ap' ? A.penOf(cls.id) : A.apcrPenOf(cls.id)) : null;
    // (no count shown; an empty type just dims)
    b.querySelector('.apen').innerHTML = pen ? `${pen}<small>mm</small>` : '';
    const loaded = (s === 'apcr') === !!you.as, queued = (s === 'apcr') === !!you.aq && !loaded;
    b.classList.toggle('sel', loaded);
    b.classList.toggle('queued', queued);
    b.classList.toggle('loading', loaded && prog > 0);
    b.style.setProperty('--p', loaded ? prog : 0);
    b.classList.toggle('empty', !n);
  }
  // a gun that never had APCR: hide that button
  ammoBtn.apcr.style.display = A && A.ammoOf(cls.id).apcr ? '' : 'none';
}

function updateUI(dt) {
  updateAmmoBar();
  updateChat();
  document.body.classList.toggle('end-open', !!phase);   // hides the deploy-screen panels behind the end screen
  if (state === 'dead') {
    if (dmap.open) updateDeployMap(dt);
    refreshPicker(ui.deathPicker);
    const b = document.getElementById('tohq');
    const can = !you || phase;
    b.disabled = !can; b.title = can ? 'Switch sides (T)' : 'You can only switch sides between battles';
  }
}

// menu
const nameInput = document.getElementById('name');
try {
  nameInput.value = localStorage.getItem('zitadelle.name') || '';
  playerTeam = localStorage.getItem('zitadelle.team') || 'de';
  Object.assign(selCls, JSON.parse(localStorage.getItem('zitadelle.cls') || '{}'));
} catch (e) { /* storage unavailable */ }
const factionBtns = [...document.querySelectorAll('.faction')];
// each side's button shows its emblem: Balkenkreuz or red star
factionBtns.forEach(b => {
  const cv = b.querySelector('canvas'), c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  c.save(); c.translate(cv.width / 2, cv.height / 2);
  drawFactionMark(c, b.dataset.team, Math.min(cv.width, cv.height) * 0.36);
  c.restore();
});
function selectFaction(team) {
  playerTeam = team;
  factionBtns.forEach(b => b.classList.toggle('sel', b.dataset.team === team));
}
factionBtns.forEach(b => b.addEventListener('click', () => selectFaction(b.dataset.team)));
selectFaction(playerTeam === 'su' ? 'su' : 'de');
function startGame() {
  if (!connected || rosterMismatch) return;
  playerName = (nameInput.value.trim() || 'Commander').slice(0, 16);
  try { localStorage.setItem('zitadelle.name', nameInput.value.trim()); localStorage.setItem('zitadelle.team', playerTeam); } catch (e) { /* ignore */ }
  Sound.init();
  openDeployMap();
}
ui.deployBtn.addEventListener('click', startGame);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') startGame(); });
document.getElementById('tohq').addEventListener('click', switchSides);
document.getElementById('infobtn').addEventListener('click', openInfo);
document.getElementById('mapinfo').addEventListener('click', openInfo);
document.getElementById('infoback').addEventListener('click', showHero);
ui.info.querySelectorAll('.herohalf').forEach(b => b.addEventListener('click', () => openCoalition(b.dataset.coal)));
// member nations' emblems on the hero
ui.info.querySelectorAll('.heronations [data-n] canvas').forEach(cv => {
  const c = cv.getContext('2d'); c.save(); c.translate(cv.width / 2, cv.height / 2);
  drawFactionMark(c, cv.parentElement.dataset.n, cv.width * 0.36); c.restore();
});
document.getElementById('infoclose').addEventListener('click', closeInfo);
ui.info.querySelectorAll('canvas[data-coalhead]').forEach(cv => drawCoalitionBadge(cv.getContext('2d'), cv.dataset.coalhead, cv.width, cv.height));
addEventListener('keydown', e => {
  if (e.key === 'Escape' && infoOpen()) { e.stopImmediatePropagation(); if (heroOpen()) closeInfo(); else showHero(); }
}, true);
document.getElementById('tomenu').addEventListener('click', () => {
  if (you) { send({ t: 'leave' }); you = null; }
  backToMenu();
});
canvas.addEventListener('click', () => {
  if (state !== 'dead' || !dmap.open || showBoard || phase) return;
  if (dmap.stage === 'map') { if (dmap.hover && dmap.hover.ok) chooseSpawn(dmap.hover); }
  else if (dmap.stage === 'pick' && overDeployButton(mouse.x, mouse.y)) { if (dmap.canDeploy) deploy(playerTeam); }
  else backToMap();   // zoomed in on a point: clicking anywhere else off the vehicle panel pulls back out
});
addEventListener('keydown', e => {
  if (e.key === 'Tab' && e.target.tagName !== 'INPUT') {
    // the board takes over the mouse: stop firing until Tab is released (driving carries on)
    e.preventDefault(); showBoard = true; document.body.classList.add('board-open');
    mouse.down = mouse.rdown = false;
  }
  if (showBoard) return;
  if (state !== 'dead' || !dmap.open || e.target.tagName === 'INPUT') return;
  if (e.key === 'Enter' && dmap.stage === 'pick' && dmap.canDeploy) deploy(playerTeam);
  if (e.key === 'Escape') { if (dmap.stage !== 'map') backToMap(); else if (!you) backToMenu(); }
  if (e.key.toLowerCase() === 't' && !e.repeat) switchSides();
});
addEventListener('keydown', e => { if (devMode && e.key === 'F9') { e.preventDefault(); send({ t: 'dev_end', w: you ? you.team : playerTeam }); } });
addEventListener('keyup', e => { if (e.key === 'Tab') { showBoard = false; document.body.classList.remove('board-open'); } });
addEventListener('blur', () => { showBoard = false; document.body.classList.remove('board-open'); });

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
  updateUI(dt);
  updateEngine(dt);
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
})();
