/* ZITADELLE — authoritative game simulation (server side). */
'use strict';
const Z = require('../shared/shared.js');
const {
  TAU, rand, pick, clamp, lerp, angDiff, turnToward,
  WORLD, CENTER, REARS, TEAM_SIZE, enemyOf, viewSize, bldCollide, bldHit, bldLine,
  CLASSES, CLASS_IDS, START_CLASS, OB, OB_TYPES, TEAM_IDS, KINDS,
  RANKS, rankForScore, ATTACKER, DEFENDER, CAP_R, CAP_POINTS, O_IDX, LINES, CAP_TIME, ROUND_END, CATS, RESERVES,
  RELOAD_MULT, DMG_MULT, TRAVERSE_MULT, CASEMATE_ARC,
} = Z;

const BOT_NAMES = {
  de: ['Lt. Brandt', 'Fw. Kraus', 'Uffz. Vogel', 'Hptm. Lange', 'Ogfr. Becker', 'Lt. Hartmann', 'Fw. Seidel',
       'Uffz. Roth', 'Oblt. Keller', 'Gfr. Winter', 'Fw. Engel', 'Lt. Kuhn', 'Uffz. Busch', 'Fw. Albrecht'],
  su: ['Lt. Petrov', 'Sgt. Ivanova', 'Kpt. Sokolov', 'Lt. Orlov', 'Sgt. Morozov', 'Lt. Volkova', 'Sgt. Pavlov',
       'Kpt. Belov', 'Sgt. Kuznetsov', 'Lt. Lebedev', 'Sgt. Popova', 'Kpt. Egorov', 'Lt. Fedorov', 'Sgt. Gromov'],
};
// The old diep-style pickups (crates, fuel drums, supply depots, pillbox) are switched off: the villages are the only cover.
const OB_CAP = { crate: 0, drum: 0, depot: 0, bunker: 0 };

const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
// a requested vehicle is only valid for its own side
const validClass = (id, team) => (CLASSES[id] && CLASSES[id].faction === team && CLASSES[id].enabled ? id : START_CLASS[team]);
// score awards
// kill: Armor Destroyed; assist: Armor Destroyed Assist (dealt >= ASSIST_SHARE of the tank's health in the
// last ASSIST_WINDOW s); damage: Armor Damaged, paid in DAMAGE_STEP chunks, worth this much per whole tank's health
const SCORE = { kill: 100, assist: 50, damage: 60, capture: 150, neutral: 50, infantry: 10 };
const ASSIST_SHARE = 0.15, ASSIST_WINDOW = 30, DAMAGE_STEP = 0.1;

function createGame(opts = {}) {
  let nextId = 1;
  let time = 0;
  const tanks = [], obstacles = [], bullets = [];
  const obCount = { crate: 0, drum: 0, depot: 0, bunker: 0 };

  // attack-line state
  // prog runs from -1 (Soviet Union) to +1 (Germany); owner flips at ±1 and is lost when prog crosses 0.
  const points = CAP_POINTS.map((p, i) => ({ i, id: p.id, name: p.name, x: p.x, y: p.y, r: CAP_R, line: p.line, k: p.k,
    prev: p.prev, next: p.next, prog: 0, owner: null, contested: false, active: false, canAtt: false, canDef: false, nd: 0, ns: 0 }));
  const sgn = team => (team === 'de' ? 1 : -1);
  const lineDead = { A: false, B: false };
  const reserves = { de: RESERVES.de.slice(), su: RESERVES.su.slice() };
  let phase = 'play', phaseEnd = 0, winner = null;
  // Who may fight for each point: the attacker next to a point it holds (working up from X5), the defender
  // next to one it holds (working down from O1). Each side can always retake its own starting points.
  function updateAccess() {
    for (const p of points) {
      if (p.line && lineDead[p.line]) { p.canAtt = p.canDef = false; }
      else {
        p.canAtt = p.owner !== ATTACKER && (p.prev.length === 0 ||
          p.prev.some(j => points[j].owner === ATTACKER && !(points[j].line && lineDead[points[j].line])));
        p.canDef = p.owner !== DEFENDER && (p.next < 0 || points[p.next].owner === DEFENDER);
      }
      p.active = p.canAtt || p.canDef;
    }
  }
  function resetPoints() {
    lineDead.A = lineDead.B = false;
    for (const p of points) {
      p.owner = p.line && p.k === 0 ? ATTACKER : !p.line ? DEFENDER : null;
      p.prog = p.owner ? sgn(p.owner) : 0; p.contested = false;
    }
    reserves.de = RESERVES.de.slice(); reserves.su = RESERVES.su.slice();
    updateAccess();
  }
  const reserveLeft = team => reserves[team].reduce((a, b) => a + b, 0);
  const rearOk = (k, team) => { const r = REARS[k]; return !!r && r.team === team && !(r.line && lineDead[r.line]); };
  const rearsOf = team => REARS.map((r, k) => k).filter(k => rearOk(k, team));
  resetPoints();
  let bunkerRespawn = 0;
  let events = [];        // positional/global events since the last snapshot
  const clients = new Set();

  // ---------- events ----------
  const ev = e => { events.push(e); };
  const pev = (t, e) => { if (t && t.client) t.client.pending.push(e); };

  // =====================================================================
  // Tank
  // =====================================================================
  class Tank {
    constructor(team, name, client) {
      this.id = nextId++; this.kind = 'tank';
      this.team = team; this.name = name;
      this.client = client || null; this.isBot = !client;
      this.input = { th: 0, rot: 0, ax: 0, ay: 0, fire: false, mg: false };
      this.clsId = START_CLASS[team];
      this.score = 0; this.kills = 0; this.deaths = 0;
      this.reset();
    }
    reset(spawn) {
      this.clsId = validClass(this.clsId, this.team);
      this.cls = CLASSES[this.clsId];
      this.alive = true;
      this.spawnTime = time; this.hp = undefined; this.maxHp = 0;
      this.recalc();
      this.hp = this.maxHp;
      this.placeAt(spawn);
      this.input.fire = this.input.mg = false; this.input.th = this.input.rot = 0;
      this.initGuns();
      this.lastHit = -99; this.ai = null;
      this.dmgBy = new Map();   // enemy tank -> { amt: damage dealt this life, pend: not yet paid out, t: last hit }
    }
    // spawn code: >= 0 = inside that held capture point, -1-k = rear assembly area k, null = any live rear
    placeAt(spawn) {
      const p = spawn != null && spawn >= 0 ? points[spawn] : null;
      let rk = spawn != null && spawn < 0 ? -1 - spawn : -1;
      if (!p && !rearOk(rk, this.team)) { const ok = rearsOf(this.team); rk = ok.length ? pick(ok) : REARS.findIndex(r => r.team === this.team); }
      const c = p || REARS[rk], spread = p ? p.r * 0.6 : 320;
      for (let i = 0; i < 30; i++) {
        const a = rand(0, TAU), d = Math.sqrt(Math.random()) * spread;
        this.x = clamp(c.x + Math.cos(a) * d, 60, WORLD - 60); this.y = clamp(c.y + Math.sin(a) * d, 60, WORLD - 60);
        if (!bldHit(this.x, this.y, this.r + 12)) break;
      }
      this.vx = this.vy = 0; this.invuln = 3;
      this.hullA = Math.atan2(CENTER - this.y, CENTER - this.x); this.turA = this.hullA; this.gunRel = 0;
    }
    gunReload(i) { const g = this.cls.guns[i]; return this.reloadT * g.reload * RELOAD_MULT[g.kind]; }
    initGuns() {
      this.cds = this.cls.guns.map(() => 0);
      this.ammo = this.cls.guns.map(g => g.clip);          // rounds left in the magazine (magazine guns)
      this.magLoad = this.cls.guns.map(() => false);       // true while changing magazines
      this.wasFiring = false;
      // secondary MGs: angle relative to their frame (so they ride with hull/turret), cooldown, can-bear flag
      const mgs = this.cls.mgs || [];
      this.mgRel = mgs.map(m => m.b); this.mgCd = mgs.map(() => 0); this.mgBear = mgs.map(() => false);
      this.mgAmmo = mgs.map(m => m.clip); this.mgMag = mgs.map(() => 0);   // rounds left; seconds left changing belts
    }
    // Every vehicle fights with fixed stats; the differences come purely from its class definition.
    recalc() {
      const c = this.cls;
      const ratio = this.maxHp ? this.hp / this.maxHp : 1;
      this.r = 24 * c.size;
      this.maxHp = 100 * c.hp;
      if (this.hp !== undefined) this.hp = ratio * this.maxHp;
      this.regen = this.maxHp * 0.012;
      this.bodyDps = 60 * c.ram;
      // Heavy, sluggish drivetrains: lower top speed, slow acceleration, slow pivot.
      this.speed = 150 * c.speed;
      const wheeled = c.style === 'halftrack' || c.style === 'truck';
      this.accel = 1.15 * (wheeled ? 1.3 : 1) / Math.pow(c.size, 1.5);
      this.hullTurn = (wheeled ? 1.6 : 1.3) / Math.sqrt(c.size);
      this.reloadT = 0.5;
      this.bSpd = 620;
      this.bDmg = 13;
      this.bPen = 13;
      this.fov = c.fov;
      this.mass = 3 * c.size * c.hp;
      this.resist = 9 * c.hp;
    }
    get rank() { return this.isBot ? this.botRank : rankForScore(this.score); }
    // combat award: score plus a line in the player's award list ("Armor Destroyed +100")
    award(label, n) {
      if (n <= 0) return;
      this.score += n;
      if (this.client) pev(this, { e: 'aw', l: label, n });
    }
    damage(amt, src, raw) {
      if (!this.alive || phase !== 'play' || (this.invuln > 0 && !raw)) return;
      const dealt = Math.min(amt, this.hp);
      this.hp -= amt; this.lastHit = time;
      pev(this, { e: 'sh', a: r1(amt * 0.25) });
      // remember who did what to us, for damage and assist awards
      if (src && src.kind === 'tank' && src !== this && src.team !== this.team && dealt > 0) {
        let d = this.dmgBy.get(src);
        if (!d) { d = { amt: 0, pend: 0, t: 0 }; this.dmgBy.set(src, d); }
        d.amt += dealt; d.pend += dealt; d.t = time;
        if (this.hp > 0 && d.pend >= DAMAGE_STEP * this.maxHp) {
          src.award('Armor Damaged', Math.round(d.pend / this.maxHp * SCORE.damage));
          d.pend = 0;
        }
      }
      if (this.hp <= 0) killTank(this, src);
    }
    muzzle(i) {
      const c = this.cls, g = c.guns[i], r = this.r;
      const cas = c.style === 'casemate';
      const px = (cas ? c.caseX : c.turretX) * r;
      const ox = this.x + Math.cos(this.hullA) * px, oy = this.y + Math.sin(this.hullA) * px;
      const a = this.turA + g.ang;
      const ca = Math.cos(a), sa = Math.sin(a);
      return { x: ox - sa * g.off * r + ca * g.len * r, y: oy + ca * g.off * r + sa * g.len * r, a };
    }
    // world position + frame angle of MG mount i (hull, turret, or casemate superstructure)
    mgMount(i) {
      const c = this.cls, m = c.mgs[i], r = this.r, cas = c.style === 'casemate';
      const onHull = m.f === 'hull';
      const px = onHull ? 0 : (cas ? c.caseX : c.turretX) * r;
      const fa = onHull || cas ? this.hullA : this.turA, ca = Math.cos(fa), sa = Math.sin(fa);
      return {
        x: this.x + Math.cos(this.hullA) * px + ca * m.x * r - sa * m.y * r,
        y: this.y + Math.sin(this.hullA) * px + sa * m.x * r + ca * m.y * r,
        fa,
      };
    }
    fireMg(i) {
      const m = this.cls.mgs[i], r = this.r, o = this.mgMount(i);
      const a = o.fa + this.mgRel[i], len = m.len * r;
      const mx = o.x + Math.cos(a) * len, my = o.y + Math.sin(a) * len;
      const moving = clamp(Math.hypot(this.vx, this.vy) / this.speed, 0, 1);
      const fa = a + (Math.random() - 0.5) * 2 * (m.spread + moving * 0.04);
      const spd = this.bSpd * m.spd;
      bullets.push({
        id: nextId++, x: mx, y: my, a: fa,
        vx: Math.cos(fa) * spd + this.vx * 0.2, vy: Math.sin(fa) * spd + this.vy * 0.2,
        r: 3, dmg: this.bDmg * m.dmg, hp: 8 * m.pen,
        team: this.team, owner: this, life: 1.45 * m.range, kind: 'mg',
        front: 0.4, splash: 0, accel: 0, maxSpd: 0, hits: [],
      });
      this.invuln = 0;
      ev({ e: 'f', id: this.id, g: -1 - i, x: r1(mx), y: r1(my), a: r3(fa), k: KINDS.indexOf('mg'), b: 0, r: r1(r) });
    }
    fire(i) {
      const g = this.cls.guns[i], r = this.r;
      const m = this.muzzle(i);
      // firing on the move costs accuracy
      const moving = clamp(Math.hypot(this.vx, this.vy) / this.speed, 0, 1);
      const fa = m.a + (Math.random() - 0.5) * 2 * (g.spread + moving * (g.kind === 'mg' ? 0.03 : 0.05));
      const spd = this.bSpd * g.spd;
      const rocket = g.kind === 'rocket';
      const v0 = rocket ? spd * 0.35 : spd;
      bullets.push({
        id: nextId++, x: m.x, y: m.y, a: fa,
        vx: Math.cos(fa) * v0 + this.vx * 0.2, vy: Math.sin(fa) * v0 + this.vy * 0.2,
        r: Math.max(3, g.w * r * 0.5 * g.size), dmg: this.bDmg * g.dmg * DMG_MULT[g.kind], hp: this.bPen * g.pen,
        team: this.team, owner: this, life: 1.45 * g.range * (rocket ? 1.25 : 1), kind: g.kind,
        front: clamp(0.59 + 0.12 * (g.pen - 1), 0.48, 0.95),
        splash: g.splash * 40 * (r / 24), accel: rocket ? spd * 2.6 : 0, maxSpd: spd * 1.15, hits: [],
      });
      const imp = g.recoil * (g.kind === 'mg' ? 8 : 30) / this.cls.size;
      this.vx -= Math.cos(m.a) * imp; this.vy -= Math.sin(m.a) * imp;
      this.invuln = 0;
      // calibre class drives the sound/shake on clients: 0 light, 1 medium, 2 heavy
      const cal = g.w * g.size >= 0.38 || g.dmg >= 2.5 ? 2 : g.w * g.size > 0.27 || g.dmg >= 1.3 ? 1 : 0;
      ev({ e: 'f', id: this.id, g: i, x: r1(m.x), y: r1(m.y), a: r3(fa), k: KINDS.indexOf(g.kind), b: cal, r: r1(r),
        mm: g.mm || 0, v: r2(g.spd) });
    }
    update(dt) {
      const inp = this.input, c = this.cls;
      if (this.invuln > 0) this.invuln -= dt;

      // Hull-relative controls: A/D steer the hull, W/S throttle along it. No sideways movement.
      const th = inp.th, rot = inp.rot;
      const aimA = Math.atan2(inp.ay - this.y, inp.ax - this.x);
      const trav = c.traverse * TRAVERSE_MULT * dt;
      const fwd0 = this.vx * Math.cos(this.hullA) + this.vy * Math.sin(this.hullA);
      const sf = clamp(fwd0 / this.speed, -1, 1);                   // signed speed fraction
      let turn;
      if (c.steer === 'neutral') turn = 1;                           // tracks counter-rotate: full pivot
      else if (c.steer === 'clutch') turn = 0.4 + 0.6 * Math.min(1, Math.abs(sf) * 2.5); // swing on a braked track
      else turn = clamp(sf * 3, -1, 1);                              // wheels: no roll, no turn; reverse flips it
      const dHull = rot * this.hullTurn * turn * dt;
      this.hullA += dHull;
      const turBefore = this.turA;
      if (c.style === 'casemate') {
        // fixed superstructure: the gun only has a small traverse arc; point the hull to aim further
        const want = clamp(angDiff(aimA, this.hullA), -CASEMATE_ARC, CASEMATE_ARC);
        this.gunRel = turnToward(this.gunRel, want, trav);
        this.turA = this.hullA + this.gunRel;
      } else {
        // The turret sits on the hull: a pivoting hull carries it round, then the traverse motor works
        // on top of that. Traversing with the hull's turn is fast; against it is slow (or loses ground).
        this.turA += dHull;
        this.turA = turnToward(this.turA, aimA, trav);
      }
      this.hullA = angDiff(this.hullA, 0); this.turA = angDiff(this.turA, 0); // keep in [-PI, PI]
      if (c.mgs) {
        // Each MG rides on its frame (angles are frame-relative) and swings toward the cursor within its arc.
        // It only fires when the cursor lies inside that arc and the barrel has come onto it.
        for (let i = 0; i < c.mgs.length; i++) {
          const m = c.mgs[i], o = this.mgMount(i);
          // MGs aim at the cursor, or (bots) at their own MG target
          const tx = inp.mgx ?? inp.ax, ty = inp.mgy ?? inp.ay;
          const want = angDiff(Math.atan2(ty - o.y, tx - o.x), o.fa);   // bearing relative to the frame
          const off = angDiff(want, m.b);
          const free = m.arc >= Math.PI;
          const tgt = free ? want : m.b + clamp(off, -m.arc, m.arc);
          this.mgRel[i] = angDiff(turnToward(this.mgRel[i], tgt, (free ? 4.5 : 3) * dt), 0);
          this.mgBear[i] = (free || Math.abs(off) <= m.arc + 0.06) && Math.abs(angDiff(want, this.mgRel[i])) < 0.12;
        }
      }

      const hx = Math.cos(this.hullA), hy = Math.sin(this.hullA);
      const fwd = this.vx * hx + this.vy * hy, lat = -this.vx * hy + this.vy * hx;
      let want = th * this.speed * (th < 0 ? 0.5 : 1);              // reverse gear is slow
      // a clutch-brake pivot drives one track while the other is locked, so the hull creeps forward
      if (c.steer === 'clutch' && rot && !th) want = this.speed * 0.12;
      const speeding = Math.abs(want) > Math.abs(fwd) && (fwd === 0 || Math.sign(want) === Math.sign(fwd));
      const rate = speeding ? this.accel : 1.8;                     // engines build up slowly, brakes bite harder
      const nf = fwd + (want - fwd) * (1 - Math.exp(-dt * rate));
      const nl = lat * Math.exp(-dt * 7);                            // tracks don't slide sideways
      this.vx = hx * nf - hy * nl; this.vy = hy * nf + hx * nl;
      this.x = clamp(this.x + this.vx * dt, this.r, WORLD - this.r);
      this.y = clamp(this.y + this.vy * dt, this.r, WORLD - this.r);
      bldCollide(this, this.r);                                       // houses and barns are solid

      if (this.hp < this.maxHp) {
        const boost = time - this.lastHit > 9 ? 3.5 : 1;               // crews patch up once out of contact
        this.hp = Math.min(this.maxHp, this.hp + this.regen * dt * boost);
      }

      const firing = inp.fire && phase === 'play';
      if (firing && !this.wasFiring) {
        for (let i = 0; i < c.guns.length; i++) this.cds[i] = Math.max(this.cds[i], c.guns[i].delay * this.gunReload(i));
      }
      this.wasFiring = firing;
      for (let i = 0; i < c.guns.length; i++) {
        const g = c.guns[i], loading = this.cds[i] > 0;
        this.cds[i] -= dt;
        if (this.cds[i] <= 0) {
          // breech closes / fresh magazine seated (not between rounds of a magazine)
          if (i === 0 && loading && g.kind !== 'mg' && (!g.clip || this.magLoad[i])) pev(this, { e: 'rd' });
          if (g.clip && this.magLoad[i]) { this.ammo[i] = g.clip; this.magLoad[i] = false; }
          if (firing) {
            this.fire(i);
            if (!g.clip) this.cds[i] = Math.max(0, this.cds[i] + this.gunReload(i));
            else if (--this.ammo[i] > 0) this.cds[i] = Math.max(0, this.cds[i] + g.cycle);
            else { this.cds[i] = this.gunReload(i); this.magLoad[i] = true; }      // empty: change magazines
          } else this.cds[i] = 0;
        }
      }
      if (c.mgs) {
        for (let i = 0; i < c.mgs.length; i++) {
          const m = c.mgs[i];
          if (this.mgMag[i] > 0) {                                  // changing belts: can't fire until it's done
            this.mgMag[i] -= dt;
            if (this.mgMag[i] <= 0) { this.mgMag[i] = 0; this.mgAmmo[i] = m.clip; }
            continue;
          }
          this.mgCd[i] -= dt;
          if (this.mgCd[i] <= 0) {
            if (inp.mg && phase === 'play' && this.mgBear[i]) {
              this.fireMg(i); this.mgCd[i] = Math.max(0, this.mgCd[i] + m.reload);
              if (--this.mgAmmo[i] <= 0) { this.mgMag[i] = m.mag; this.mgCd[i] = 0; }
            } else this.mgCd[i] = 0;
          }
        }
      }
    }
  }

  function killTank(t, src) {
    t.alive = false; t.hp = 0; t.deathTime = time;
    t.deathX = t.x; t.deathY = t.y;
    t.deaths++;
    ev({ e: 'x', x: r1(t.x), y: r1(t.y), s: r1(t.r * 1.6) });
    ev({ e: 'w', x: r1(t.x), y: r1(t.y), c: t.cls.idx, r: r1(t.r), h: r3(t.hullA), u: r3(t.turA) });
    let kn = 'Defensive line', kt = null, kc = '';
    if (src && src.kind === 'tank') {
      kn = src.name; kt = src.team; kc = src.cls.name;
      if (src.team !== t.team) { src.award('Armor Destroyed', SCORE.kill); src.kills++; }
    } else if (src && src.kind === 'inf') {
      kn = 'Infantry'; kt = src.team; kc = 'Anti-tank weapon';
    } else if (src && src.kind === 'ob') {
      kn = src.type === 'bunker' ? 'Pillbox' : 'Fuel drum';
    }
    // everyone else who did real damage recently gets an assist
    for (const [a, d] of t.dmgBy) {
      if (a !== src && a.team !== t.team && d.amt >= ASSIST_SHARE * t.maxHp && time - d.t <= ASSIST_WINDOW) a.award('Armor Destroyed Assist', SCORE.assist);
    }
    t.dmgBy.clear();
    ev({ e: 'k', kn, kt, kc, kr: src && src.kind === 'tank' ? src.rank : -1, vn: t.name, vt: t.team, vc: t.cls.name, vr: t.rank });
    if (t.client) {
      pev(t, { e: 'die', kn, kt, kc, score: t.score, kills: t.kills, deaths: t.deaths, secs: Math.floor(time - t.spawnTime) });
    }
    if (t.isBot) t.respawnAt = time + rand(3, 7);
  }

  // =====================================================================
  // Attack lines: capture points, line defeat, battles
  // =====================================================================
  const inZone = (t, p) => (t.x - p.x) ** 2 + (t.y - p.y) ** 2 < p.r * p.r;
  const capRate = n => (1 + 0.5 * (Math.min(n, 3) - 1)) / CAP_TIME;   // 1, 1.5, 2x for 1, 2, 3+ tanks

  function rewardZone(p, team, n, text) {
    for (const t of tanks) if (t.alive && t.team === team && inZone(t, p)) t.award(text, n);
  }

  function updatePoints(dt) {
    for (const p of points) {
      let nd = 0, ns = 0, id = 0, is = 0;
      for (const t of tanks) if (t.alive && inZone(t, p)) { if (t.team === 'de') nd++; else ns++; }
      for (const m of infantry) if (!m.dead && inZone(m, p)) { if (m.team === 'de') id++; else is++; }
      p.nd = nd; p.ns = ns; p.nid = id; p.nis = is;
      // infantry count for a fraction of a tank each
      const ed = nd + id * INF.capWeight, es = ns + is * INF.capWeight;
      if (!p.active) {
        // locked: nobody can fight for it until a neighbouring point changes hands
        p.contested = false;
        p.prog = p.owner ? sgn(p.owner) : 0;
        continue;
      }
      // whoever has more vehicles in the zone pushes it their way (faster the bigger the margin);
      // equal numbers freeze it
      p.contested = ed > 0 && es > 0 && ed === es;
      if (p.contested || phase !== 'play') continue;
      // the bigger side pushes, but only if it's allowed to fight for this point (or is defending its own)
      const big = ed > es ? 'de' : ed < es ? 'su' : null;
      const may = big && (big === p.owner || (big === ATTACKER ? p.canAtt : p.canDef));
      if (may) {
        p.prog = clamp(p.prog + sgn(big) * capRate(Math.abs(ed - es)) * dt, -1, 1);
      } else {
        // an abandoned half-taken point drifts back to whoever holds it
        const home = p.owner ? sgn(p.owner) : 0;
        p.prog += clamp(home - p.prog, -0.04 * dt, 0.04 * dt);
      }
      if (p.owner && Math.sign(p.prog) !== sgn(p.owner)) {
        const by = enemyOf(p.owner);
        p.owner = null;
        ev({ e: 'cp', i: p.i, t: by, n: 1 });
        rewardZone(p, by, SCORE.neutral, 'Point Neutralized');
        updateAccess();
      }
      if (!p.owner && Math.abs(p.prog) >= 1) {
        p.owner = p.prog > 0 ? 'de' : 'su';
        ev({ e: 'cp', i: p.i, t: p.owner, n: 0 });
        rewardZone(p, p.owner, SCORE.capture, 'Point Captured');
        // the defender reaching an attack line's start point defeats that line
        if (p.line && p.k === 0 && p.owner === DEFENDER && !lineDead[p.line]) {
          lineDead[p.line] = true;
          ev({ e: 'ld', l: p.line });
        }
        updateAccess();
      }
    }
  }

  function updateBattle(dt) {
    if (phase === 'play') {
      // O1 taken, both lines defeated, or one side out of reserves with nothing left on the field
      const spent = team => reserveLeft(team) <= 0 && !tanks.some(k => k.alive && k.team === team);
      let w = null;
      if (points[O_IDX].owner === ATTACKER) w = ATTACKER;
      else if (LINES.every(L => lineDead[L])) w = DEFENDER;
      else if (spent(ATTACKER)) w = DEFENDER;
      else if (spent(DEFENDER)) w = ATTACKER;
      if (w) forceWin(w);
    } else if (time >= phaseEnd) {
      phase = 'play'; winner = null;
      resetPoints();
      resetInfantry();
      bullets.length = 0;
      for (const t of tanks) {
        t.score = t.kills = t.deaths = 0;
        if (t.isBot) { if (t.alive) { t.placeAt(null); t.hp = t.maxHp; } else respawnBot(t); }
        else if (t.alive) { t.placeAt(null); t.hp = t.maxHp; }
      }
      ev({ e: 'rn' });
    }
  }

  function forceWin(w) {
    winner = w;
    phase = 'end'; phaseEnd = time + ROUND_END;
    ev({ e: 're', w: winner });
  }

  // The chosen point is under attack: walk back along the line toward your own side (attackers toward
  // X5, defenders toward O1) to the first safe point; failing that, the nearest live rear area.
  function fallbackSpawn(i, team) {
    let p = points[i];
    const seen = new Set();
    while (p && !seen.has(p.i)) {
      seen.add(p.i);
      if (spawnOk(p.i, team)) return p.i;
      if (team === ATTACKER) p = p.prev.length ? points[p.prev.find(j => spawnOk(j, team)) ?? p.prev[0]] : null;
      else p = p.next >= 0 ? points[p.next] : null;
    }
    const L = points[i].line;
    const own = REARS.findIndex((r, k) => rearOk(k, team) && (team !== ATTACKER || r.line === L));
    if (own >= 0) return -1 - own;
    const any = rearsOf(team);
    return any.length ? -1 - any[0] : null;
  }
  // Validate a player's chosen spawn code (joining or redeploying); falls back and tells them if it's no good.
  function checkSpawn(t, raw, team) {
    let sp = Number.isInteger(raw) && raw < points.length && raw >= -REARS.length ? raw : null;
    if (sp != null && sp >= 0 && !spawnOk(sp, team)) {
      const was = points[sp];
      sp = fallbackSpawn(sp, team);
      pev(t, { e: 'm', text: `${was.id} is not safe — deploying at ${sp != null && sp >= 0 ? points[sp].id + ' · ' + points[sp].name : 'the rear'}`, d: 3 });
    } else if (sp != null && sp < 0 && !rearOk(-1 - sp, team)) {
      sp = null;
      pev(t, { e: 'm', text: 'That assembly area is lost — deploying elsewhere', d: 3 });
    }
    return sp;
  }
  // Deploy a vehicle from the side's reserves. Falls back to another available vehicle if that category
  // has run dry; returns false (and leaves the tank knocked out) when the side has nothing left.
  function deploy(t, want, sp) {
    const r = reserves[t.team];
    const ok = id => CLASSES[id] && CLASSES[id].faction === t.team && CLASSES[id].enabled && r[CLASSES[id].cat] > 0;
    let id = ok(want) ? want : null;
    if (!id) {
      const alt = CLASS_IDS.filter(ok);
      if (!alt.length) {
        t.alive = false; t.hp = 0; t.deathTime = time;
        if (t.x === undefined) { const rr = REARS.find(q => q.team === t.team); t.x = rr.x; t.y = rr.y; }
        t.deathX = t.x; t.deathY = t.y;
        if (t.client) pev(t, { e: 'die', kn: 'No reserves left', kt: null, kc: '', score: t.score, kills: t.kills, deaths: t.deaths, secs: 0 });
        return false;
      }
      id = ok(START_CLASS[t.team]) ? START_CLASS[t.team] : pick(alt);
      if (t.client && CLASSES[want] && CLASSES[want].faction === t.team && CLASSES[want].enabled) pev(t, { e: 'm', text: `No ${CATS[CLASSES[want].cat].name.toLowerCase()} left in reserve — deploying a ${CLASSES[id].name}`, d: 3.5 });
    }
    r[CLASSES[id].cat]--;
    t.clsId = id;
    t.reset(sp);
    return true;
  }

  function spawnOk(i, team) {
    const p = points[i];
    if (!p || p.owner !== team || p.contested || (p.line && lineDead[p.line])) return false;
    return !tanks.some(e => e.alive && e.team !== team && Math.hypot(e.x - p.x, e.y - p.y) < p.r + 300);
  }

  // =====================================================================
  // Obstacles
  // =====================================================================
  function spawnObstacle(type) {
    const T = OB[type];
    let x, y, tries = 0;
    do {
      if (type === 'bunker') { x = CENTER + rand(-150, 150); y = CENTER + rand(-150, 150); }
      else { x = rand(120, WORLD - 120); y = rand(120, WORLD - 120); }
      tries++;
    } while (tries < 20 && (bldHit(x, y, T.r + 20) || tanks.some(t => t.alive && Math.hypot(t.x - x, t.y - y) < 320)));
    obstacles.push({ id: nextId++, kind: 'ob', type, ti: OB_TYPES.indexOf(type), T, x, y, vx: 0, vy: 0, r: T.r,
      hp: T.hp, maxHp: T.hp, a: type === 'drum' ? 0 : rand(0, TAU), grow: 0, cd: 2, gunA: rand(0, TAU), dead: false });
    obCount[type]++;
  }

  function damageOb(o, amt, src) {
    if (o.dead) return;
    o.hp -= amt;
    if (o.hp <= 0) {
      o.dead = true; obCount[o.type]--;
      ev({ e: 'd', x: r1(o.x), y: r1(o.y), o: o.ti, r: o.r });
      if (o.T.explosive) explode(o.x, o.y, 100, 42, null, src, o);
      if (o.type === 'bunker') {
        bunkerRespawn = time + 60;
        ev({ e: 'x', x: r1(o.x), y: r1(o.y), s: 120 });
        if (src && src.kind === 'tank') ev({ e: 'k', kn: src.name, kt: src.team, kc: src.cls.name, vn: 'Pillbox', vt: null, vc: '' });
      }
    }
  }

  function explode(x, y, rad, dmg, team, src, self) {
    ev({ e: 'x', x: r1(x), y: r1(y), s: r1(rad * 0.55) });
    for (const m of infantry) {
      if (m.dead || (team && m.team === team)) continue;
      const d = Math.hypot(m.x - x, m.y - y) - m.r;
      if (d < rad) hurtSoldier(m, dmg * (1 - Math.max(0, d) / rad * 0.6), src);
    }
    for (const t of tanks) {
      if (!t.alive || (team && t.team === team)) continue;
      const d = Math.hypot(t.x - x, t.y - y) - t.r;
      if (d < rad) t.damage(dmg * (1 - Math.max(0, d) / rad * 0.6), src);
    }
    for (const o of obstacles) {
      if (o.dead || o === self) continue;
      const dx = o.x - x, dy = o.y - y, d = Math.hypot(dx, dy) - o.r;
      if (d < rad) {
        damageOb(o, dmg * (1 - Math.max(0, d) / rad * 0.6), src);
        if (o.T.mass < Infinity) { const k = 260 / o.T.mass / (Math.hypot(dx, dy) || 1); o.vx += dx * k; o.vy += dy * k; }
      }
    }
  }

  // =====================================================================
  // Spatial grid
  // =====================================================================
  const CELL = 160, GN = Math.ceil(WORLD / CELL);
  const grid = Array.from({ length: GN * GN }, () => []);
  let stamp = 0;
  function gridBuild() {
    for (let i = 0; i < grid.length; i++) grid[i].length = 0;
    const ins = e => {
      const m = e.r + 16;
      const x0 = clamp(((e.x - m) / CELL) | 0, 0, GN - 1), x1 = clamp(((e.x + m) / CELL) | 0, 0, GN - 1);
      const y0 = clamp(((e.y - m) / CELL) | 0, 0, GN - 1), y1 = clamp(((e.y + m) / CELL) | 0, 0, GN - 1);
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) grid[cy * GN + cx].push(e);
    };
    for (const o of obstacles) if (!o.dead) ins(o);
    for (const t of tanks) if (t.alive) ins(t);
    for (const m of infantry) if (!m.dead) ins(m);
  }
  const gridAt = (x, y) => grid[clamp((y / CELL) | 0, 0, GN - 1) * GN + clamp((x / CELL) | 0, 0, GN - 1)];

  // =====================================================================
  // Bots
  // =====================================================================
  function botRange(c) {
    if (c.guns.some(g => g.kind === 'rocket')) return 520;
    if (c.guns[0].kind === 'mg') return 300;
    if (c.fov >= 1.3) return 680;
    if (c.guns[0].splash) return 430;
    return 420;
  }
  function newAi() {
    return {
      tgt: null, ob: null, timer: 0, strafe: Math.random() < 0.5 ? 1 : -1, strafeT: 0,
      wx: rand(300, WORLD - 300), wy: rand(300, WORLD - 300), wanderT: 0, side: Math.random() < 0.5 ? 1 : -1, stuckT: 0, unstick: 0,
      retreat: false, err: 0, errT: 0, skill: rand(0.35, 1),
      obj: -1, objT: 0, ox: 0, oy: 0, defender: Math.random() < 0.3,
      mgTgt: null, burst: 0, burstOn: false,
    };
  }
  // points a side has business at: ones it may take, and its own ones the enemy may take
  function wantedPoints(team) {
    const att = team === ATTACKER;
    return points.filter(p => (att ? p.canAtt : p.canDef) || (p.owner === team && (att ? p.canDef : p.canAtt)));
  }
  // bots spawn as close as safely possible to somewhere their side needs them
  function botSpawn(team) {
    const opts = points.filter(p => spawnOk(p.i, team)).map(p => ({ c: p.i, x: p.x, y: p.y }))
      .concat(rearsOf(team).map(k => ({ c: -1 - k, x: REARS[k].x, y: REARS[k].y })));
    if (!opts.length) return null;
    const want = wantedPoints(team);
    if (!want.length || Math.random() < 0.2) return pick(opts).c;
    const g = pick(want);
    opts.sort((a, b) => Math.hypot(a.x - g.x, a.y - g.y) - Math.hypot(b.x - g.x, b.y - g.y));
    return opts[0].c;
  }
  // Pick a point to fight for: weigh distance, what's at stake there and how many allies are already
  // going, so each side spreads itself across both lines.
  function pickObjective(t) {
    const ai = t.ai, me = t.team, att = me === ATTACKER;
    let best = -1, bs = -Infinity;
    for (const p of wantedPoints(me)) {
      const d = Math.hypot(p.x - t.x, p.y - t.y);
      const mine = p.owner === me;
      const enemies = att ? p.ns : p.nd;
      const allies = tanks.filter(o => o !== t && o.alive && o.team === me && o.ai && o.ai.obj === p.i).length;
      const lineAllies = p.line ? tanks.filter(o => o !== t && o.alive && o.team === me && o.ai && points[o.ai.obj] && points[o.ai.obj].line === p.line).length : 0;
      let sc = -d / 1600 + rand(0, 1.2) - allies * 0.4 - lineAllies * 0.12;
      if (mine) sc += enemies > 0 || Math.abs(p.prog) < 0.999 ? 2.4 : ai.defender ? 0.8 : -0.2;   // under threat
      else sc += p.owner ? 1.4 : 2;                                                              // neutral first
      if (!p.line) sc += att ? 1.5 : 1;                                                          // O1 matters most
      if (sc > bs) { bs = sc; best = p.i; }
    }
    if (best < 0) best = att ? O_IDX : points.find(p => p.k === 0 && !lineDead[p.line]) ? points.find(p => p.k === 0 && !lineDead[p.line]).i : O_IDX;
    const a = rand(0, TAU), r = Math.sqrt(Math.random()) * CAP_R * 0.55;
    ai.ox = Math.cos(a) * r; ai.oy = Math.sin(a) * r;
    return best;
  }
  // bots drive whatever their side fields, weighted toward gun tanks
  // bots draw from the reserve roughly in proportion to what's left in each category
  function botClass(team) {
    const r = reserves[team];
    const ids = CLASS_IDS.filter(id => CLASSES[id].faction === team && CLASSES[id].enabled && r[CLASSES[id].cat] > 0);
    if (!ids.length) return null;
    let tot = 0; for (const id of ids) tot += r[CLASSES[id].cat] / ids.filter(j => CLASSES[j].cat === CLASSES[id].cat).length;
    let x = Math.random() * tot;
    for (const id of ids) { x -= r[CLASSES[id].cat] / ids.filter(j => CLASSES[j].cat === CLASSES[id].cat).length; if (x <= 0) return id; }
    return ids[ids.length - 1];
  }
  function respawnBot(t) {
    const id = botClass(t.team);
    if (!id || !deploy(t, id, botSpawn(t.team))) { t.alive = false; t.respawnAt = time + 5; return; }
    t.ai = newAi();
  }
  function spawnBot(team) {
    const used = new Set(tanks.map(t => t.fullName));
    const full = BOT_NAMES[team].find(n => !used.has(n)) || pick(BOT_NAMES[team]);
    // "Lt. Brandt" -> name "Brandt", rank Leutnant (shown as an insignia instead of text)
    const m = full.match(/^(.*\.)\s+(\S+)$/);
    const ri = m ? RANKS[team].findIndex(r => r[0] === m[1]) : -1;
    const t = new Tank(team, m && ri >= 0 ? m[2] : full, null);
    t.fullName = full; t.botRank = ri >= 0 ? ri : 2;
    respawnBot(t);
    tanks.push(t);
    return t;
  }
  // keep each side at TEAM_SIZE vehicles by adding/removing bots around the humans
  function balanceBots() {
    for (const team of ['de', 'su']) {
      const humans = tanks.filter(t => !t.isBot && t.team === team).length;
      const bots = tanks.filter(t => t.isBot && t.team === team);
      const want = Math.max(0, TEAM_SIZE - humans);
      for (let i = bots.length; i < want; i++) spawnBot(team);
      if (bots.length > want) {
        bots.sort((a, b) => (a.alive - b.alive) || (a.score - b.score));
        for (const b of bots.slice(0, bots.length - want)) tanks.splice(tanks.indexOf(b), 1);
      }
    }
  }

  // Bots work their secondary MGs independently of the main gun: nearest enemy in MG range (anywhere
  // around them, so rear/bow mounts get used), soft-skinned vehicles first, in short bursts.
  const MG_RANGE = 650;
  function botMgs(t, dt) {
    const ai = t.ai, c = t.cls;
    t.input.mg = false; t.input.mgx = t.input.mgy = undefined;
    if (!c.mgs || phase !== 'play') return;
    ai.mgT = (ai.mgT || 0) - dt;
    if (ai.mgT <= 0) {
      ai.mgT = rand(0.2, 0.35);
      let best = null, bs = Infinity;
      for (const e of tanks) {
        if (!e.alive || e.team === t.team || e.invuln > 0) continue;
        const d = Math.hypot(e.x - t.x, e.y - t.y);
        if (d > MG_RANGE) continue;
        const soft = e.cls.style === 'halftrack' || e.cls.style === 'truck';
        const s = d * (soft ? 0.5 : 1);
        if (s < bs) { bs = s; best = e; }
      }
      for (const e of infantry) {
        if (e.dead || e.team === t.team) continue;
        const d = Math.hypot(e.x - t.x, e.y - t.y);
        if (d < MG_RANGE && d * 0.8 < bs) { bs = d * 0.8; best = e; }
      }
      // nothing to shoot at: rake nearby supplies
      if (!best && ai.ob && !ai.ob.dead && Math.hypot(ai.ob.x - t.x, ai.ob.y - t.y) < 420) best = ai.ob;
      ai.mgTgt = best;
    }
    const m = ai.mgTgt;
    if (!m || (m.kind === 'tank' ? !m.alive : m.dead)) return;
    // gunner's bursts: ~0.6–1.4 s on, ~0.3–0.8 s off
    ai.burst -= dt;
    if (ai.burst <= 0) { ai.burstOn = !ai.burstOn; ai.burst = ai.burstOn ? rand(0.6, 1.4) : rand(0.3, 0.8); }
    const d = Math.hypot(m.x - t.x, m.y - t.y), tt = d / (t.bSpd * 1.15);
    const err = (1 - ai.skill) * 18;
    t.input.mgx = m.x + (m.vx || 0) * tt + rand(-err, err);
    t.input.mgy = m.y + (m.vy || 0) * tt + rand(-err, err);
    t.input.mg = ai.burstOn && !bldLine(t.x, t.y, m.x, m.y);
  }

  // Look ahead along the wanted direction and swing round buildings instead of driving into them.
  function steerAround(t, mx, my) {
    const ai = t.ai, a0 = Math.atan2(my, mx), ml = Math.hypot(mx, my);
    const clear = a => {
      for (const d of [t.r + 25, t.r + 80, t.r + 150]) if (bldHit(t.x + Math.cos(a) * d, t.y + Math.sin(a) * d, t.r * 0.95)) return false;
      return true;
    };
    if (clear(a0)) return [mx, my];
    for (const k of [0.4, 0.8, 1.2, 1.6, 2.1]) for (const sd of [ai.side, -ai.side]) {
      const a = a0 + sd * k;
      if (clear(a)) { ai.side = sd; return [Math.cos(a) * ml, Math.sin(a) * ml]; }
    }
    return [mx, my];
  }

  function botThink(t, dt) {
    const ai = t.ai, c = t.cls;
    const sight = 900 * t.fov;
    ai.timer -= dt;
    if (ai.timer <= 0) {
      ai.timer = rand(0.25, 0.45);
      let best = null, bd = sight;
      for (const e of tanks) {
        if (!e.alive || e.team === t.team) continue;
        // targets behind a house count as further away, so bots prefer ones they can actually hit
        const d = Math.hypot(e.x - t.x, e.y - t.y) * (bldLine(t.x, t.y, e.x, e.y) ? 1.6 : 1);
        if (d < bd) { bd = d; best = e; }
      }
      ai.tgt = best;
      // only plink at nearby obstacles; bots no longer drive off to farm them
      let bo = null, bs = 0;
      for (const o of obstacles) {
        if (o.dead) continue;
        const d = Math.hypot(o.x - t.x, o.y - t.y);
        if (d > 480) continue;
        const s = (o.T.explosive ? 2 : 1) / (d + 150);
        if (s > bs) { bs = s; bo = o; }
      }
      ai.ob = bo;
    }
    ai.objT -= dt;
    const curObj = points[ai.obj];
    // re-plan periodically, or at once if our objective was just secured and is quiet
    if (ai.objT <= 0 || !curObj || !curObj.active || (curObj.owner === t.team && !curObj.contested && Math.abs(curObj.prog) >= 0.999 && !ai.defender && ai.objT < 8)) {
      ai.objT = rand(9, 16);
      ai.obj = pickObjective(t);
    }
    ai.errT -= dt;
    if (ai.errT <= 0) { ai.errT = rand(0.3, 0.8); ai.err = rand(-1, 1) * (1 - ai.skill) * 0.22; }
    ai.strafeT -= dt;
    if (ai.strafeT <= 0) { ai.strafeT = rand(1, 3); ai.strafe *= -1; }

    let mx = 0, my = 0, ax = t.x + Math.cos(t.turA) * 200, ay = t.y + Math.sin(t.turA) * 200, fire = false;
    if (t.hp < t.maxHp * 0.3 && ai.tgt) ai.retreat = true;
    const rks = rearsOf(t.team), rear = rks.length ? REARS[rks.reduce((a, b) => (Math.hypot(REARS[a].x - t.x, REARS[a].y - t.y) < Math.hypot(REARS[b].x - t.x, REARS[b].y - t.y) ? a : b))] : null;
    if (t.hp > t.maxHp * 0.75 || !rear || Math.hypot(rear.x - t.x, rear.y - t.y) < 500) ai.retreat = false;
    if (phase !== 'play') { ai.retreat = false; }

    const e = ai.tgt && ai.tgt.alive && tanks.includes(ai.tgt) ? ai.tgt : null;
    const gunSpd = t.bSpd * c.guns[0].spd;
    const aimAt = (x, y, vx, vy) => {
      const d = Math.hypot(x - t.x, y - t.y);
      const tt = d / gunSpd;
      const a = Math.atan2(y + vy * tt - t.y, x + vx * tt - t.x) + ai.err;
      ax = t.x + Math.cos(a) * d; ay = t.y + Math.sin(a) * d;
      return Math.abs(angDiff(t.turA, a)) < (c.guns[0].kind === 'mg' ? 0.35 : 0.16);
    };

    if (ai.retreat) {
      const rx = rear.x - t.x, ry = rear.y - t.y, rd = Math.hypot(rx, ry) || 1;
      mx = rx / rd; my = ry / rd;
      if (e) fire = aimAt(e.x, e.y, e.vx, e.vy) && Math.hypot(e.x - t.x, e.y - t.y) < sight * 0.8;
    } else {
      // drive to the objective; turrets keep shooting on the way
      const p = points[ai.obj];
      let onObj = false;
      if (p) {
        const gx = p.x + ai.ox, gy = p.y + ai.oy;
        const dx = gx - t.x, dy = gy - t.y, d = Math.hypot(dx, dy);
        onObj = Math.hypot(p.x - t.x, p.y - t.y) < p.r * 0.8;
        if (d > 60) { mx = dx / d; my = dy / d; }
      }
      if (e) {
        const dx = e.x - t.x, dy = e.y - t.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
        const desired = botRange(c);
        // close to (or already holding) the objective: fight properly; otherwise keep pushing toward it
        if (onObj || d < desired || c.style === 'casemate') {
          const radial = d > desired + 80 ? 1 : d < desired - 120 ? -1 : 0;
          if (onObj && radial > 0) { mx *= 0.3; my *= 0.3; }       // don't abandon the point to chase
          else if (c.style === 'casemate') { mx = ux * radial * 0.6; my = uy * radial * 0.6; }
          else { mx = mx * 0.3 + ux * radial; my = my * 0.3 + uy * radial; }
        }
        fire = aimAt(e.x, e.y, e.vx, e.vy) && d < sight * 0.85;
      } else if (ai.ob && !ai.ob.dead) {
        const o = ai.ob;
        fire = aimAt(o.x, o.y, o.vx, o.vy) && Math.hypot(o.x - t.x, o.y - t.y) < 480;
      }
    }
    if (phase !== 'play') { mx = my = 0; fire = false; }
    // don't waste rounds into a wall
    if (fire && bldLine(t.x, t.y, ax, ay)) fire = false;
    if (mx || my) [mx, my] = steerAround(t, mx, my);
    // Bots think in "drive toward this world direction"; translate that into hull-relative controls.
    let th = 0, rot = 0;
    const ml = Math.min(1, Math.hypot(mx, my));
    const aimHull = c.style === 'casemate' && e && !ai.retreat;
    if (aimHull) {
      // casemates pivot the whole vehicle onto the target, then creep forward/back along it
      rot = clamp(angDiff(Math.atan2(ay - t.y, ax - t.x), t.hullA) * 3, -1, 1);
      th = clamp(mx * Math.cos(t.hullA) + my * Math.sin(t.hullA), -1, 1);
    } else if (ml > 0.1) {
      const mA = Math.atan2(my, mx);
      const wheel = c.steer === 'wheel';
      // wheeled vehicles never back up to turn (their steering inverts); they keep rolling through the turn
      const rev = !wheel && Math.abs(angDiff(mA, t.hullA)) > Math.PI * 0.62;
      const d = angDiff(rev ? mA + Math.PI : mA, t.hullA);
      rot = clamp(d * 3, -1, 1);
      const al = Math.max(0, Math.cos(d));
      th = (rev ? -1 : 1) * (wheel ? Math.max(0.55, al * al) : c.steer === 'clutch' ? Math.max(0.25, al * al) : al * al) * ml;
    }
    // stuck against something: back off and swing the other way for a moment
    if (Math.abs(th) > 0.3 && Math.hypot(t.vx, t.vy) < 12) ai.stuckT += dt; else ai.stuckT = Math.max(0, ai.stuckT - dt * 2);
    if (ai.stuckT > 1.2) { ai.stuckT = 0; ai.unstick = rand(0.8, 1.4); ai.unTh = -Math.sign(th); ai.side = -ai.side; }
    if (ai.unstick > 0) { ai.unstick -= dt; th = ai.unTh; rot = ai.side; }
    t.input.th = th; t.input.rot = rot;
    // bots hose close targets with the roof MG
    botMgs(t, dt);
    t.input.ax = ax; t.input.ay = ay; t.input.fire = fire;
  }

  // =====================================================================
  // Step
  // =====================================================================
  function step(dt) {
    time += dt;
    gridBuild();
    for (const t of tanks) if (t.alive && t.isBot) botThink(t, dt);
    for (const t of tanks) if (t.alive) t.update(dt);
    updateInfantry(dt);

    // tank <-> tank
    for (let i = 0; i < tanks.length; i++) {
      const a = tanks[i]; if (!a.alive) continue;
      for (let j = i + 1; j < tanks.length; j++) {
        const b = tanks[j]; if (!b.alive) continue;
        const dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r;
        if (dx * dx + dy * dy >= rr * rr) continue;
        const d = Math.hypot(dx, dy) || 1, ov = rr - d, nx = dx / d, ny = dy / d;
        const sa = b.mass / (a.mass + b.mass), sb = 1 - sa;
        a.x -= nx * ov * sa; a.y -= ny * ov * sa; b.x += nx * ov * sb; b.y += ny * ov * sb;
        a.vx -= nx * ov * 3 * sa; a.vy -= ny * ov * 3 * sa; b.vx += nx * ov * 3 * sb; b.vy += ny * ov * 3 * sb;
        if (a.team !== b.team) {
          a.damage(b.bodyDps * dt, b); b.damage(a.bodyDps * dt, a);
          if (Math.random() < dt * 20) ev({ e: 'sp', x: r1(a.x + nx * a.r), y: r1(a.y + ny * a.r) });
        }
      }
    }
    // tank <-> obstacle
    for (const t of tanks) {
      if (!t.alive) continue;
      stamp++;
      const m = t.r + 4;
      const x0 = clamp(((t.x - m) / CELL) | 0, 0, GN - 1), x1 = clamp(((t.x + m) / CELL) | 0, 0, GN - 1);
      const y0 = clamp(((t.y - m) / CELL) | 0, 0, GN - 1), y1 = clamp(((t.y + m) / CELL) | 0, 0, GN - 1);
      outer:
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        for (const o of grid[cy * GN + cx]) {
          if (o.kind !== 'ob' || o.dead || o._st === stamp) continue;
          o._st = stamp;
          const dx = o.x - t.x, dy = o.y - t.y, rr = t.r + o.r;
          if (dx * dx + dy * dy >= rr * rr) continue;
          const d = Math.hypot(dx, dy) || 1, ov = rr - d, nx = dx / d, ny = dy / d;
          const om = o.T.mass, st = om === Infinity ? 1 : om / (om + t.mass), so = 1 - st;
          t.x -= nx * ov * st; t.y -= ny * ov * st; o.x += nx * ov * so; o.y += ny * ov * so;
          t.vx -= nx * ov * 2 * st; t.vy -= ny * ov * 2 * st;
          o.vx += nx * ov * 3 * so; o.vy += ny * ov * 3 * so;
          t.damage(o.T.body * dt, o);
          damageOb(o, t.bodyDps * dt, t);
          if (!t.alive) break outer;
        }
      }
    }

    updateObstacles(dt);
    updateBullets(dt);
    updatePoints(dt);
    updateBattle(dt);

    for (const t of tanks) if (t.isBot && !t.alive && time >= t.respawnAt) respawnBot(t);
    for (const type of ['crate', 'drum', 'depot']) if (obCount[type] < OB_CAP[type] && Math.random() < dt * 6) spawnObstacle(type);
    if (obCount.bunker < OB_CAP.bunker && time >= bunkerRespawn) spawnObstacle('bunker');
    for (let i = obstacles.length - 1; i >= 0; i--) if (obstacles[i].dead) obstacles.splice(i, 1);
  }

  function updateObstacles(dt) {
    for (const o of obstacles) {
      if (o.dead) continue;
      o.grow = Math.min(1, o.grow + dt * 3);
      if (o.T.mass < Infinity) {
        const f = Math.exp(-dt * 3);
        o.vx *= f; o.vy *= f;
        o.x = clamp(o.x + o.vx * dt, o.r, WORLD - o.r); o.y = clamp(o.y + o.vy * dt, o.r, WORLD - o.r);
        bldCollide(o, o.r);
        o.a += (Math.abs(o.vx) + Math.abs(o.vy)) * 0.0015 * dt * (o.id % 2 ? 1 : -1);
      }
      if (o.T.gun) {
        let best = null, bd = 600;
        for (const t of tanks) {
          if (!t.alive || t.invuln > 0) continue;
          const d = Math.hypot(t.x - o.x, t.y - o.y);
          if (d < bd) { bd = d; best = t; }
        }
        o.cd -= dt;
        if (best) {
          const tt = bd / 480;
          const ta = Math.atan2(best.y + best.vy * tt - o.y, best.x + best.vx * tt - o.x);
          o.gunA = angDiff(turnToward(o.gunA, ta, 1.6 * dt), 0);
          if (o.cd <= 0 && Math.abs(angDiff(o.gunA, ta)) < 0.1) {
            o.cd = 1.5;
            const mx = o.x + Math.cos(o.gunA) * o.r * 1.15, my = o.y + Math.sin(o.gunA) * o.r * 1.15;
            bullets.push({ id: nextId++, x: mx, y: my, a: o.gunA, vx: Math.cos(o.gunA) * 480, vy: Math.sin(o.gunA) * 480,
              r: 8, dmg: 24, hp: 30, team: 'x', owner: o, life: 1.6, kind: 'shell', front: 0.7, splash: 0, accel: 0, maxSpd: 0, hits: [] });
            ev({ e: 'bf', x: r1(mx), y: r1(my) });
          }
        } else o.gunA = angDiff(o.gunA + dt * 0.2, 0);
      }
    }
  }

  function updateBullets(dt) {
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      if (b.accel) {
        const ns = Math.min(b.maxSpd, Math.hypot(b.vx, b.vy) + b.accel * dt);
        b.vx = Math.cos(b.a) * ns; b.vy = Math.sin(b.a) * ns;
      }
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      if (b.life <= 0 || b.x < -50 || b.y < -50 || b.x > WORLD + 50 || b.y > WORLD + 50) {
        if (b.splash) explode(b.x, b.y, b.splash, b.dmg * 0.6, b.team, b.owner);
        bullets.splice(i, 1);
        continue;
      }
      if (bldHit(b.x, b.y, b.r * 0.5)) {
        ev({ e: 'h', x: r1(b.x), y: r1(b.y), z: 3, vx: Math.round(b.vx), vy: Math.round(b.vy) });
        if (b.splash) explode(b.x, b.y, b.splash, b.dmg * 0.6, b.team, b.owner);
        bullets.splice(i, 1);
        continue;
      }
      let dead = false;
      for (const e of gridAt(b.x, b.y)) {
        if (b.hits.includes(e.id)) continue;
        if (e.kind === 'inf') {      // soldiers: any round kills or wounds, MG rounds can go through one
          if (e.dead || e.team === b.team) continue;
          const dx = e.x - b.x, dy = e.y - b.y, rr = e.r + b.r;
          if (dx * dx + dy * dy > rr * rr) continue;
          b.hits.push(e.id);
          hurtSoldier(e, b.dmg, b.owner);
          if (b.splash) { explode(b.x, b.y, b.splash, b.dmg * 0.6, b.team, b.owner); dead = true; break; }
          b.hp -= 3;
          if (b.hp <= 0) { dead = true; break; }
          continue;
        }
        if (e.kind === 'tank') { if (!e.alive || e.team === b.team || e === b.owner) continue; }
        else if (e.dead || b.team === 'x') continue;
        const dx = e.x - b.x, dy = e.y - b.y, rr = e.r + b.r;
        if (dx * dx + dy * dy > rr * rr) continue;
        b.hits.push(e.id);
        let zone = 0;
        if (e.kind === 'tank') {
          // armour facing: front deflects, rear is soft
          const rel = Math.abs(angDiff(Math.atan2(b.y - e.y, b.x - e.x), e.hullA));
          let mult = 1;
          if (rel < Math.PI * 0.27) { mult = b.front; zone = mult < 0.7 ? 1 : 0; }
          else if (rel > Math.PI * 0.73) { mult = 1.45; zone = 2; }
          e.damage(b.dmg * mult, b.owner);
          if (b.kind !== 'mg') {
            if (b.owner && b.owner.client && Math.random() < 0.7) {
              if (zone === 2) pev(b.owner, { e: 't', x: r1(b.x), y: r1(b.y - 10), text: 'REAR HIT', c: '#ffb347', s: 15 });
              else if (zone === 1) pev(b.owner, { e: 't', x: r1(b.x), y: r1(b.y - 10), text: 'GLANCING', c: '#c8c8c8', s: 13 });
            }
            if (zone === 1 && e.client && Math.random() < 0.5) pev(e, { e: 't', x: r1(b.x), y: r1(b.y - 10), text: 'BOUNCED', c: '#9fd1ff', s: 14 });
          }
          b.hp -= e.resist;
        } else {
          damageOb(e, b.dmg, b.owner);
          b.hp -= e.T.resist;
          if (e.T.mass < Infinity) { e.vx += b.vx * 0.05 / e.T.mass; e.vy += b.vy * 0.05 / e.T.mass; }
        }
        ev({ e: 'h', x: r1(b.x), y: r1(b.y), z: zone, vx: Math.round(b.vx), vy: Math.round(b.vy) });
        if (b.splash) { explode(b.x, b.y, b.splash, b.dmg * 0.6, b.team, b.owner); dead = true; break; }
        if (b.hp <= 0) { dead = true; break; }
      }
      if (dead) bullets.splice(i, 1);
    }
    // shell vs shell
    for (let i = 0; i < bullets.length; i++) {
      const a = bullets[i];
      if (a.hp <= 0) continue;
      for (let j = i + 1; j < bullets.length; j++) {
        const b = bullets[j];
        if (a.team === b.team || b.hp <= 0) continue;
        const dx = a.x - b.x, dy = a.y - b.y, rr = a.r + b.r;
        if (dx * dx + dy * dy > rr * rr) continue;
        const ad = a.dmg, bd = b.dmg;
        a.hp -= bd; b.hp -= ad;
        ev({ e: 'bb', x: r1((a.x + b.x) / 2), y: r1((a.y + b.y) / 2), s: r1((a.r + b.r) * 1.2) });
        if (a.hp <= 0) break;
      }
    }
    for (let i = bullets.length - 1; i >= 0; i--) if (bullets[i].hp <= 0) bullets.splice(i, 1);
  }

  // =====================================================================
  // Infantry (prototype): AI rifle squads, each with one anti-tank soldier
  // =====================================================================
  // Squads walk to the points their side is fighting for and spread out there. Riflemen shoot enemy
  // infantry (hit chance falls with range) and scatter from tanks that get close; the anti-tank soldier
  // closes on enemy tanks and fires a short-range rocket that uses the normal armour rules, then reloads.
  // Soldiers die to shells, splash, MGs and being run over. Each one counts as a quarter of a tank when
  // capturing. A wiped-out squad comes back after a while; every squad resets when a new battle starts.
  const INF = {
    squads: 4, size: 6, speed: 44, hp: 6, r: 6,
    rifleRange: 520, rifleDmg: 3.5, rifleCd: [1.4, 2.4],
    atRange: 260, atSeek: 460, atCd: 14, atDmg: 55, atSpd: 380,
    fearR: 170, capWeight: 0.25, respawn: 25,
  };
  const infantry = [], squads = [];
  function spawnSquad(sq) {
    for (const m of sq.members) { const i = infantry.indexOf(m); if (i >= 0) infantry.splice(i, 1); }
    const code = botSpawn(sq.team);
    let cx, cy, spread;
    if (code == null) { const rr = REARS.find(q => q.team === sq.team); cx = rr.x; cy = rr.y; spread = 220; }
    else if (code >= 0) { cx = points[code].x; cy = points[code].y; spread = points[code].r * 0.5; }
    else { cx = REARS[-1 - code].x; cy = REARS[-1 - code].y; spread = 220; }
    sq.members = [];
    for (let i = 0; i < INF.size; i++) {
      let x, y, tries = 0;
      do {
        const a = rand(0, TAU), d = Math.sqrt(Math.random()) * spread;
        x = clamp(cx + Math.cos(a) * d, 40, WORLD - 40); y = clamp(cy + Math.sin(a) * d, 40, WORLD - 40);
      } while (bldHit(x, y, INF.r + 6) && ++tries < 15);
      const m = {
        id: nextId++, kind: 'inf', team: sq.team, squad: sq, role: i === 0 ? 'at' : 'rifle',
        x, y, vx: 0, vy: 0, a: rand(0, TAU), r: INF.r, hp: INF.hp, dead: false,
        cd: rand(0, 1.5), atCd: rand(0, 3), thinkT: rand(0, 0.3), tgt: null, atTgt: null, threat: null,
        fx: rand(-80, 80), fy: rand(-80, 80),
      };
      sq.members.push(m); infantry.push(m);
    }
    sq.obj = -1; sq.objT = 0; sq.respawnAt = 0; sq.ox = 0; sq.oy = 0;
  }
  function resetInfantry() {
    infantry.length = 0; squads.length = 0;
    for (const team of ['de', 'su']) for (let k = 0; k < INF.squads; k++) {
      const sq = { team, members: [] };
      squads.push(sq); spawnSquad(sq);
    }
  }
  function killSoldier(m, src) {
    if (m.dead) return;
    m.dead = true; m.hp = 0;
    ev({ e: 'id', x: r1(m.x), y: r1(m.y), a: r2(m.a), t: TEAM_IDS.indexOf(m.team) });
    if (src && src.kind === 'tank' && src.team !== m.team) src.award('Infantry Killed', SCORE.infantry);
  }
  function hurtSoldier(m, dmg, src) {
    if (m.dead || phase !== 'play') return;
    m.hp -= dmg;
    if (m.hp <= 0) killSoldier(m, src);
  }
  // where a squad goes: somewhere its side has business, spread across points, nearer is better
  function squadObjective(sq, lx, ly) {
    let best = -1, bs = -Infinity;
    for (const p of wantedPoints(sq.team)) {
      const others = squads.filter(o => o !== sq && o.team === sq.team && o.obj === p.i).length;
      const sc = -Math.hypot(p.x - lx, p.y - ly) / 1400 + rand(0, 1) - others * 0.6 + (p.owner === sq.team ? 0.4 : 1);
      if (sc > bs) { bs = sc; best = p.i; }
    }
    if (best < 0) {   // nothing to fight for: hold the nearest point we own
      let bd = Infinity;
      for (const p of points) if (p.owner === sq.team) { const d = Math.hypot(p.x - lx, p.y - ly); if (d < bd) { bd = d; best = p.i; } }
    }
    return best;
  }
  function fireAT(m, t) {
    const d = Math.hypot(t.x - m.x, t.y - m.y), tt = d / INF.atSpd;
    const a = Math.atan2(t.y + t.vy * tt - m.y, t.x + t.vx * tt - m.x) + rand(-0.05, 0.05);
    const x = m.x + Math.cos(a) * 10, y = m.y + Math.sin(a) * 10;
    bullets.push({
      id: nextId++, x, y, a, vx: Math.cos(a) * INF.atSpd, vy: Math.sin(a) * INF.atSpd,
      r: 5, dmg: INF.atDmg, hp: 40, team: m.team, owner: m, life: (INF.atRange + 80) / INF.atSpd, kind: 'rocket',
      front: 0.85, splash: 22, accel: 0, maxSpd: 0, hits: [],
    });
    ev({ e: 'f', id: m.id, g: 0, x: r1(x), y: r1(y), a: r3(a), k: KINDS.indexOf('rocket'), b: 0, r: 8 });
  }
  function fireRifle(m, e) {
    const d = Math.hypot(e.x - m.x, e.y - m.y);
    const moving = Math.hypot(e.vx, e.vy) > 5 ? 0.75 : 1;
    const hit = Math.random() < clamp(0.5 - d / 1500, 0.12, 0.45) * moving;
    const mx = hit ? e.x : e.x + rand(-28, 28), my = hit ? e.y : e.y + rand(-28, 28);
    ev({ e: 'rf', x: r1(m.x), y: r1(m.y), x2: r1(mx), y2: r1(my) });
    if (hit) hurtSoldier(e, INF.rifleDmg, m);
  }
  function updateInfantry(dt) {
    const play = phase === 'play';
    const wanted = { de: new Set(wantedPoints('de').map(p => p.i)), su: new Set(wantedPoints('su').map(p => p.i)) };
    for (const sq of squads) {
      const alive = sq.members.filter(m => !m.dead);
      if (!alive.length) {
        if (!sq.respawnAt) sq.respawnAt = time + INF.respawn;
        else if (time >= sq.respawnAt && play) spawnSquad(sq);
        continue;
      }
      sq.objT -= dt;
      if (sq.obj < 0 || sq.objT <= 0 || (!wanted[sq.team].has(sq.obj) && points[sq.obj].owner !== sq.team)) {
        sq.obj = squadObjective(sq, alive[0].x, alive[0].y);
        sq.objT = rand(25, 40);
        const a = rand(0, TAU), rr = Math.sqrt(Math.random()) * CAP_R * 0.45;
        sq.ox = Math.cos(a) * rr; sq.oy = Math.sin(a) * rr;
      }
    }
    for (const m of infantry) {
      if (m.dead) continue;
      // look around a few times a second
      m.thinkT -= dt;
      if (m.thinkT <= 0) {
        m.thinkT = rand(0.25, 0.4);
        m.tgt = null; m.atTgt = null; m.threat = null;
        let bd = INF.rifleRange;
        for (const e of infantry) {
          if (e.dead || e.team === m.team) continue;
          const d = Math.hypot(e.x - m.x, e.y - m.y);
          if (d < bd && !bldLine(m.x, m.y, e.x, e.y)) { bd = d; m.tgt = e; }
        }
        let td = Infinity, tn = null;
        for (const t of tanks) {
          if (!t.alive || t.team === m.team) continue;
          const d = Math.hypot(t.x - m.x, t.y - m.y);
          if (d < td) { td = d; tn = t; }
        }
        if (tn && m.role === 'at' && td < INF.atSeek && m.atCd <= 4) m.atTgt = tn;      // go hunting with a round (nearly) ready
        else if (tn && td < INF.fearR + tn.r) m.threat = tn;                              // everyone else gets out of the way
      }
      // where to walk
      const sq = m.squad, p = points[sq.obj];
      let gx = m.x, gy = m.y, spd = INF.speed;
      if (!play) { /* hold still between battles */ }
      else if (m.threat && m.threat.alive) {
        const a = Math.atan2(m.y - m.threat.y, m.x - m.threat.x) + (m.fx > 0 ? 0.6 : -0.6);
        gx = m.x + Math.cos(a) * 100; gy = m.y + Math.sin(a) * 100; spd *= 1.3;
      } else if (m.atTgt && m.atTgt.alive) {
        if (Math.hypot(m.atTgt.x - m.x, m.atTgt.y - m.y) > INF.atRange * 0.8) { gx = m.atTgt.x; gy = m.atTgt.y; spd *= 1.15; }
      } else if (m.tgt && !m.tgt.dead) {
        // hold position and shoot
      } else if (p) { gx = p.x + sq.ox + m.fx; gy = p.y + sq.oy + m.fy; }
      const dx = gx - m.x, dy = gy - m.y, d = Math.hypot(dx, dy);
      if (d > 12) {
        let a = Math.atan2(dy, dx);
        for (const off of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.6, -2.6]) {        // feel round houses
          if (!bldHit(m.x + Math.cos(a + off) * 18, m.y + Math.sin(a + off) * 18, m.r)) { a += off; break; }
        }
        const v = Math.min(spd, d / dt);
        m.vx = Math.cos(a) * v; m.vy = Math.sin(a) * v;
        m.a = turnToward(m.a, a, 8 * dt);
      } else { m.vx = m.vy = 0; }
      m.x = clamp(m.x + m.vx * dt, 20, WORLD - 20); m.y = clamp(m.y + m.vy * dt, 20, WORLD - 20);
      bldCollide(m, m.r);
      if (!play) continue;
      // shoot
      m.cd -= dt; m.atCd -= dt;
      const at = m.atTgt && m.atTgt.alive ? m.atTgt : null;
      const atD = at ? Math.hypot(at.x - m.x, at.y - m.y) : Infinity;
      if (at && atD <= INF.atRange + at.r) {
        m.a = Math.atan2(at.y - m.y, at.x - m.x);
        if (m.atCd <= 0 && !bldLine(m.x, m.y, at.x, at.y)) { fireAT(m, at); m.atCd = INF.atCd; }
      } else if (m.tgt && !m.tgt.dead) {
        m.a = Math.atan2(m.tgt.y - m.y, m.tgt.x - m.x);
        if (m.cd <= 0) { fireRifle(m, m.tgt); m.cd = rand(INF.rifleCd[0], INF.rifleCd[1]); }
      }
    }
    // tanks run soldiers over (enemies) or shove them aside (friends)
    for (const t of tanks) {
      if (!t.alive) continue;
      const fast = Math.hypot(t.vx, t.vy) > 30;
      for (const m of infantry) {
        if (m.dead) continue;
        const dx = m.x - t.x, dy = m.y - t.y, rr = t.r + m.r;
        if (dx * dx + dy * dy >= rr * rr) continue;
        if (m.team !== t.team && fast && phase === 'play') { killSoldier(m, t); continue; }
        const dd = Math.hypot(dx, dy) || 1;
        m.x = t.x + dx / dd * rr; m.y = t.y + dy / dd * rr;
      }
    }
  }

  // =====================================================================
  // Client-facing API
  // =====================================================================
  function cleanName(s) {
    s = String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
    return s || 'Commander';
  }
  const num = (v, lo, hi, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);

  function addClient(client) {
    client.pending = [];
    client.tank = null;
    client.viewW = 1600; client.viewH = 900;
    client.spec = { id: null, t: 0 };
    clients.add(client);
  }
  function removeTank(client) {
    if (!client.tank) return;
    const i = tanks.indexOf(client.tank);
    if (i >= 0) tanks.splice(i, 1);
    client.tank = null;
    balanceBots();
  }
  function removeClient(client) {
    removeTank(client);
    clients.delete(client);
  }

  function handle(client, m) {
    if (!m || typeof m !== 'object') return;
    const t = client.tank;
    switch (m.t) {
      case 'join': {
        removeTank(client);
        let team = m.team === 'su' ? 'su' : 'de';
        const locked = phase === 'play' && client.lockTeam && team !== client.lockTeam;
        if (locked) team = client.lockTeam;
        client.lockTeam = team;
        client.lookX = client.lookY = undefined;
        client.tank = new Tank(team, cleanName(m.name), client);
        tanks.push(client.tank);
        deploy(client.tank, m.c, checkSpawn(client.tank, m.sp, team));
        balanceBots();
        if (locked) pev(client.tank, { e: 'm', text: 'You can only switch sides between battles', d: 4 });
        // joining a battle in progress: the client plays its side's intro (during the break it waits for the next battle)
        if (phase === 'play') pev(client.tank, { e: 'intro', t: team });
        break;
      }
      case 'respawn':
        if (t && !t.alive) {
          let team = m.team === 'su' ? 'su' : 'de';
          if (team !== t.team && phase === 'play') {
            team = t.team;
            pev(t, { e: 'm', text: 'You can only switch sides between battles', d: 3 });
          }
          const switched = team !== t.team;
          if (switched) client.lockTeam = team;
          const sp = checkSpawn(t, m.sp, team);
          client.lookX = client.lookY = undefined;
          if (switched) { t.team = team; t.score = t.kills = t.deaths = 0; }
          deploy(t, m.c, sp);
          if (switched) balanceBots();
        }
        break;
      case 'leave':
        removeTank(client);
        break;
      // switch sides: only during the break between battles
      case 'switch':
        if (!t) break;
        if (phase === 'play') { pev(t, { e: 'm', text: 'You can only switch sides between battles', d: 3 }); break; }
        t.team = enemyOf(t.team); client.lockTeam = t.team;
        t.score = t.kills = t.deaths = 0;
        if (t.alive) { t.clsId = validClass(m.c, t.team); t.reset(null); }
        balanceBots();
        pev(t, { e: 'm', text: `Now fighting for ${t.team === 'de' ? 'Germany' : 'the Soviet Union'}`, d: 3 });
        break;
      case 'in':
        if (t && t.alive) {
          t.input.th = num(m.th, -1, 1); t.input.rot = num(m.rot, -1, 1);
          t.input.ax = num(m.ax, -1000, WORLD + 1000, t.x); t.input.ay = num(m.ay, -1000, WORLD + 1000, t.y);
          t.input.fire = !!m.f;
          t.input.mg = !!m.m;
          // camera centre (zoomed gunner's sight can look well ahead of the tank); used for snapshot culling
          if (typeof m.cx === 'number' && typeof m.cy === 'number' && Math.hypot(m.cx - t.x, m.cy - t.y) < 1800) { client.camX = m.cx; client.camY = m.cy; }
          else client.camX = client.camY = undefined;
        }
        break;
      // choosing where to deploy: stream the area around the point being looked at
      // spot an enemy: tell everyone on your side (at most one mark a second per player)
      case 'mark':
        if (t && t.alive && phase === 'play' && Number.isInteger(m.c) && m.c >= 0 && m.c < CATS.length && time - (client.lastMark ?? -9) >= 1) {
          client.lastMark = time;
          const mk = { e: 'mk', x: r1(num(m.x, 0, WORLD, t.x)), y: r1(num(m.y, 0, WORLD, t.y)), c: m.c, by: t.name };
          for (const k of tanks) if (k.client && k.team === t.team) pev(k, mk);
        }
        break;
      case 'look':
        client.lookX = num(m.x, 0, WORLD, CENTER); client.lookY = num(m.y, 0, WORLD, CENTER);
        break;
      // dev only: end the battle now with the given side winning (for testing the end-of-battle flow and music)
      case 'dev_end':
        if (opts.dev && phase === 'play') forceWin(m.w === 'su' ? 'su' : 'de');
        break;
      case 'view':
        client.viewW = num(m.w, 320, 4000, 1600); client.viewH = num(m.h, 240, 3000, 900);
        break;
    }
  }

  // build the per-client snapshot: everything near their camera + global state
  function snapshotFor(client, includeBoard) {
    const t = client.tank;
    let cx, cy, fov = 1.1, sp = null;
    if (t) {
      cx = t.alive ? t.x : t.deathX; cy = t.alive ? t.y : t.deathY; fov = t.fov;
      if (t.alive && client.camX !== undefined && Math.hypot(client.camX - t.x, client.camY - t.y) < 1800) { cx = client.camX; cy = client.camY; }
    } else {
      // spectator: follow one of the top tanks, switching every 12 s
      let f = tanks.find(x => x.id === client.spec.id);
      if (!f || !f.alive || time > client.spec.t) {
        const alive = tanks.filter(x => x.alive).sort((a, b) => b.score - a.score);
        f = alive[Math.floor(Math.random() * Math.min(4, alive.length))];
        client.spec.id = f ? f.id : null; client.spec.t = time + 12;
      }
      sp = client.spec.id;
      cx = f ? f.x : CENTER; cy = f ? f.y : CENTER;
    }
    if ((!t || !t.alive) && client.lookX !== undefined) { cx = client.lookX; cy = client.lookY; }
    const vs = viewSize(fov, client.viewW, client.viewH);
    const hw = vs.w / 2 + 250, hh = vs.h / 2 + 250;
    const near = (x, y, m = 0) => Math.abs(x - cx) < hw + m && Math.abs(y - cy) < hh + m;

    const T = [];
    for (const k of tanks) {
      if (!k.alive) continue;
      T.push([k.id, TEAM_IDS.indexOf(k.team), k.cls.idx, r1(k.x), r1(k.y), r3(k.hullA), r3(k.turA), r1(k.r),
        r2(k.hp / k.maxHp), k.invuln > 0 ? 1 : 0, k.name, k.cls.mgs ? k.mgRel.map(r2) : 0, k.rank]);
    }
    const B = [];
    for (const b of bullets) if (near(b.x, b.y)) B.push([b.id, r1(b.x), r1(b.y), r1(b.r), TEAM_IDS.indexOf(b.team), KINDS.indexOf(b.kind), r3(b.a)]);
    const O = [];
    for (const o of obstacles) if (!o.dead && near(o.x, o.y, o.r)) O.push([o.id, o.ti, r1(o.x), r1(o.y), r3(o.a), r2(o.hp / o.maxHp), r3(o.gunA), r2(o.grow)]);
    const E = [];
    for (const e of events) if (e.x === undefined || near(e.x, e.y, 400)) E.push(e);
    for (const e of client.pending) E.push(e);
    client.pending.length = 0;

    // infantry near the camera: [id, team, x, y, facing, anti-tank?, moving?]
    const I = [];
    for (const m of infantry) if (!m.dead && near(m.x, m.y)) I.push([m.id, TEAM_IDS.indexOf(m.team), r1(m.x), r1(m.y), r2(m.a), m.role === 'at' ? 1 : 0, m.vx || m.vy ? 1 : 0]);
    const snap = { t: 's', tm: r3(time), T, B, O, E, I };
    // conquest state is tiny, so it goes out every snapshot
    snap.cp = points.map(p => [r2(p.prog), p.owner === 'de' ? 1 : p.owner === 'su' ? 2 : 0, p.contested ? 1 : 0, p.active ? 1 : 0, p.nd, p.ns, p.canAtt ? 1 : 0, p.canDef ? 1 : 0]);
    snap.ln = LINES.map(L => (lineDead[L] ? 1 : 0));
    snap.rs = [reserves.de, reserves.su];
    snap.ph = phase === 'play' ? 0 : [winner === 'de' ? 1 : 2, Math.ceil(phaseEnd - time)];
    // leaderboard: [id, team, name, score, kills, deaths, rank, alive]
    if (includeBoard) snap.on = clients.size;   // people connected (playing or on the menu)
    if (includeBoard) snap.lb = tanks.map(k => [k.id, TEAM_IDS.indexOf(k.team), k.name, k.score, k.kills, k.deaths, k.rank, k.alive ? 1 : 0]);
    if (t) {
      snap.you = { id: t.id, alive: t.alive ? 1 : 0, score: t.score, rank: t.rank, deaths: t.deaths, c: t.cls.idx, kills: t.kills, fov: r3(t.fov), team: t.team,
        // reload progress; a magazine gun only shows it while changing magazines (am = rounds left)
        rl: !t.alive ? 0 : t.cls.guns[0].clip ? (t.magLoad[0] ? r2(clamp(t.cds[0] / t.gunReload(0), 0, 1)) : 0) : r2(clamp(t.cds[0] / t.gunReload(0), 0, 1)),
        am: t.cls.guns[0].clip ? t.ammo[0] : undefined,
        mb: t.cls.mgs ? t.mgBear.reduce((m, b, i) => m | (b ? 1 << i : 0), 0) : 0,
        // MG rounds left, and belt-change progress (1 = just started, 0 = ready)
        ma: t.cls.mgs ? t.mgAmmo : 0,
        mr: t.cls.mgs ? t.mgMag.map((v, i) => r2(v / t.cls.mgs[i].mag)) : 0 };
    } else snap.sp = sp;
    return snap;
  }
  // events are shared by all snapshots built in one round, then cleared
  function endSnapshotRound() { events = []; }

  // ---------- init ----------
  for (const type in OB_CAP) for (let i = 0; i < OB_CAP[type]; i++) spawnObstacle(type);
  resetInfantry();
  balanceBots();

  return {
    step, handle, addClient, removeClient, snapshotFor, endSnapshotRound,
    get time() { return time; },
    stats: () => ({ tanks: tanks.length, humans: tanks.filter(t => !t.isBot).length, bullets: bullets.length, obstacles: obstacles.length, clients: clients.size }),
  };
}

module.exports = { createGame };
