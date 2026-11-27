/* ZITADELLE — authoritative game simulation (server side). */
'use strict';
const Z = require('../shared/shared.js');
const {
  TAU, rand, pick, clamp, lerp, angDiff, turnToward,
  WORLD, CENTER, REARS, TEAM_SIZE, enemyOf, viewSize, bldCollide, bldHit, bldLine,
  CLASSES, CLASS_IDS, START_CLASS, OB, OB_TYPES, TEAM_IDS, KINDS,
  RANKS, rankForScore, ATTACKER, DEFENDER, CAP_R, CAP_POINTS, O_IDX, LINES, CAP_TIME, ROUND_END, BATTLE_TIME, CATS, RESERVES,
  RELOAD_MULT, DMG_MULT, TRAVERSE_MULT, CASEMATE_ARC,
} = Z;
// armour / penetration data lives in its own file, keyed by vehicle id
const ARMOR = require('../shared/armor.js');
// Armour model. A round that reaches a hull face either:
//   ricochets   impact more than RICOCHET_DEG from the plate's normal (unless it overmatches) -> no damage,
//               it skips off and keeps flying
//   penetrates  penetration (±PEN_SPREAD) >= plate thickness / cos(impact angle)          -> full damage
//   bounces     otherwise                                                                 -> NONPEN_DMG of its damage
// Overmatch: a round more than OVERMATCH times the plate's thickness in calibre never ricochets.
// Rockets (shaped charges) never ricochet.
const RICOCHET_DEG = 70, OVERMATCH = 3, PEN_SPREAD = 0.1, NONPEN_DMG = 0;
// APCR rounds: more penetration (APCR_PEN in armor.js) but this much of AP's damage
const APCR_DMG = 0.75;
{
  const missing = CLASS_IDS.filter(id => CLASSES[id].enabled && !ARMOR.armorOf(id));
  if (missing.length) console.warn('armor.js has no entry for playable vehicles:', missing.join(', '));
}

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
const SCORE = { assist: 50, damage: 60, capture: 150, neutral: 50, raid: 50, defend: 50,
  partHit: 10,                                                      // a hit that damages a component
  partKill: { tracks: 40, engine: 50, ammo: 60, fuel: 40 } };       // destroying one
// a kill is worth more the bigger the vehicle destroyed (by reserve category, see CATS)
const KILL_SCORE = { lt: 70, mt: 100, ht: 150, td: 100, htd: 150 };
const killScore = c => (CATS[c.cat] && KILL_SCORE[CATS[c.cat].key]) || 100;
const ASSIST_SHARE = 0.15, ASSIST_WINDOW = 30, DAMAGE_STEP = 0.1;

function createGame(opts = {}) {
  let nextId = 1;
  let time = 0;
  const tanks = [], obstacles = [], bullets = [];
  const obCount = { crate: 0, drum: 0, depot: 0, bunker: 0 };

  // attack-line state
  // prog runs from -1 (Soviet Union) to +1 (Germany); owner flips at ±1 and is lost when prog crosses 0.
  const points = CAP_POINTS.map((p, i) => ({ i, id: p.id, name: p.name, x: p.x, y: p.y, r: p.r, capScale: p.capScale, line: p.line, k: p.k,
    prev: p.prev, next: p.next, prog: 0, owner: null, contested: false, active: false, canAtt: false, canDef: false, nd: 0, ns: 0 }));
  const sgn = team => (team === 'de' ? 1 : -1);
  const lineDead = { A: false, B: false };
  // Reserve pools. The attacker has one per attack line (its RESERVES split evenly); a defeated line's
  // pool is lost with it. The defender has a single pool.
  let reserves = null;
  function resetReserves() {
    reserves = {};
    for (const team of ['de', 'su']) {
      reserves[team] = team === ATTACKER
        ? Object.fromEntries(LINES.map(L => [L, RESERVES[team].map(n => Math.floor(n / LINES.length))]))
        : { all: RESERVES[team].slice() };
    }
  }
  const poolSum = a => a.reduce((x, y) => x + y, 0);
  const livePools = team => Object.entries(reserves[team]).filter(([L]) => L === 'all' || !lineDead[L]).map(([, a]) => a);
  const reserveTotal = team => CATS.map((_, k) => livePools(team).reduce((n, a) => n + a[k], 0));
  // which pool a deployment at spawn code sp draws from (attacker: the line it's on; O1 or no spawn
  // given: the surviving line with the most left). Null when there's nothing to draw from.
  function poolLine(team, sp) {
    if (reserves[team].all) return 'all';
    let L = sp != null && sp >= 0 ? points[sp].line : sp != null && sp < 0 && REARS[-1 - sp] ? REARS[-1 - sp].line : null;
    if (L && !lineDead[L]) return L;
    const live = LINES.filter(l => !lineDead[l]).sort((a, b) => poolSum(reserves[team][b]) - poolSum(reserves[team][a]));
    return live[0] || null;
  }
  const poolFor = (team, sp) => { const L = poolLine(team, sp); return L ? reserves[team][L] : null; };
  let phase = 'play', phaseEnd = 0, winner = null, winWhy = 0, battleEnd = BATTLE_TIME;   // winWhy 1 = time ran out
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
    resetReserves();
    updateAccess();
  }
  const reserveLeft = team => poolSum(reserveTotal(team));
  const rearOk = (k, team) => { const r = REARS[k]; return !!r && r.team === team && !(r.line && lineDead[r.line]); };
  const rearsOf = team => REARS.map((r, k) => k).filter(k => rearOk(k, team));
  // Logistics load (costs and limit in armor.js), stored as the time it drains to zero. Players keep it on
  // their connection so leaving and rejoining doesn't clear it; bots keep it on the tank.
  const logiHolder = t => t.client || t;
  const logiLoad = t => Math.max(0, (logiHolder(t).logiEnd || 0) - time);
  const logiWait = (t, id) => Math.max(0, logiLoad(t) + ARMOR.logiOf(id) - ARMOR.LOGI_LIMIT);   // seconds until id fits
  // Spotting: light tanks scout, marking enemies they see. Human teammates get the marker; allied bots can
  // engage a marked enemy out to SPOT_REACH times their own sight for SPOT_TIME seconds.
  const SPOT_TIME = 8, SPOT_REACH = 1.3, SCOUT_MARK_EVERY = 2.5;
  const spotted = { de: new Map(), su: new Map() };          // enemy tank -> time the mark runs out
  const isSpotted = (team, e) => (spotted[team].get(e) || 0) > time;
  const isScout = c => !!CATS[c.cat] && CATS[c.cat].key === 'lt';
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
      this.resetParts();
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
    gunReload(i) {
      const g = this.cls.guns[i];
      return this.reloadT * g.reload * RELOAD_MULT[g.kind];
    }
    // components (armor.js COMPONENTS): full health, all working
    resetParts() {
      this.parts = {};
      for (const k of ARMOR.COMPONENT_IDS) { const max = this.maxHp * ARMOR.COMPONENTS[k].hp; this.parts[k] = { hp: max, max, down: 0, side: 1, fxT: 0 }; }
    }
    // what others see of its components: for a few seconds after one goes, 1 fuel tank burning (+4 on the
    // right-hand side) and 2 ammo cooking off (+8 out of the right-hand side); 16 engine smoking, for as long
    // as it's knocked out
    partsFx() {
      const p = this.parts;
      return (p.fuel.fxT > 0 ? 1 | (p.fuel.side > 0 ? 4 : 0) : 0) | (p.ammo.fxT > 0 ? 2 | (p.ammo.side > 0 ? 8 : 0) : 0)
        | (p.engine.down > 0 ? 16 : 0);
    }
    initGuns() {
      this.cds = this.cls.guns.map(() => 0);
      // no ammo limits: AP is always available, APCR whenever the gun had it at all
      this.ammoAP = Infinity; this.ammoAPCR = ARMOR.ammoOf(this.clsId).apcr > 0 ? Infinity : 0;
      if (this.ammoSel !== 'apcr' || !this.ammoAPCR) this.ammoSel = 'ap';
      this.ammoNext = this.ammoSel;
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
      // the hull rectangle used for shell hits (the circle r is still used for movement and collisions)
      this.hl = c.hull[0] * this.r / 2; this.hw = c.hull[1] * this.r / 2; this.rb = Math.hypot(this.hl, this.hw);
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
    damage(amt, src, raw, quiet) {
      if (!this.alive || phase !== 'play' || (this.invuln > 0 && !raw)) return;
      const dealt = Math.min(amt, this.hp);
      this.hp -= amt; this.lastHit = time;
      pev(this, { e: 'sh', a: r1(amt * 0.25) });
      // where it came from, for the player's damage-direction indicator (not for crashes into your own side)
      if (!quiet && this.client && src && src !== this && src.x !== undefined && src.team !== this.team)
        pev(this, { e: 'dh', x: r1(src.x), y: r1(src.y), s: r2(clamp(amt / this.maxHp, 0, 1)) });
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
        pen: m.penMm || 8, cal: m.cal || 7.9, splash: 0, accel: 0, maxSpd: 0, hits: [],
      });
      this.invuln = 0;
      ev({ e: 'f', id: this.id, g: -1 - i, x: r1(mx), y: r1(my), a: r3(fa), k: KINDS.indexOf('mg'), b: 0, r: r1(r) });
    }
    // main gun shells are counted; everything else (MGs, rockets on other guns) is unlimited
    usesAmmo(i) { return i === 0 && this.cls.guns[0].kind === 'shell'; }
    hasAmmo(i) { return !this.usesAmmo(i) || this.ammoAP + this.ammoAPCR > 0; }
    // take a round of the loaded type (the other one if it has run out); returns 'ap' | 'apcr' | null
    takeRound(i) {
      if (!this.usesAmmo(i)) return 'ap';
      const left = s => (s === 'apcr' ? this.ammoAPCR : this.ammoAP);
      const use = left(this.ammoSel) > 0 ? this.ammoSel : left(this.ammoSel === 'ap' ? 'apcr' : 'ap') > 0 ? (this.ammoSel === 'ap' ? 'apcr' : 'ap') : null;
      if (use === 'apcr') this.ammoAPCR--; else if (use === 'ap') this.ammoAP--;
      return use;
    }
    // a reload starts: the queued type goes in (or whatever is left if that type has run out)
    chamberNext() {
      const left = s => (s === 'apcr' ? this.ammoAPCR : this.ammoAP);
      this.ammoSel = left(this.ammoNext) > 0 ? this.ammoNext : left(this.ammoSel) > 0 ? this.ammoSel : this.ammoAP > 0 ? 'ap' : 'apcr';
      if (!left(this.ammoNext)) this.ammoNext = this.ammoSel;
    }
    // second press of a queued type: clear the breech (the round goes back to the rack) and load it now
    forceReload() {
      const g = this.cls.guns[0], left = this.ammoNext === 'apcr' ? this.ammoAPCR : this.ammoAP;
      if (!this.usesAmmo(0) || !left || this.ammoNext === this.ammoSel) return;
      this.ammoSel = this.ammoNext;
      this.cds[0] = this.gunReload(0);
      if (g.clip) { this.ammo[0] = 0; this.magLoad[0] = true; }
    }
    fire(i) {
      const g = this.cls.guns[i], r = this.r;
      const round = this.takeRound(i);
      if (!round) return;
      const apcr = round === 'apcr';
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
        r: Math.max(3, g.w * r * 0.5 * g.size), dmg: this.bDmg * g.dmg * DMG_MULT[g.kind] * (apcr ? APCR_DMG : 1), hp: this.bPen * g.pen,
        team: this.team, owner: this, life: 1.45 * g.range * (rocket ? 1.25 : 1), kind: g.kind,
        pen: (i === 0 && (apcr ? ARMOR.apcrPenOf(this.clsId) : ARMOR.penOf(this.clsId))) || (g.kind === 'mg' ? 8 : 40), cal: g.mm || (g.kind === 'mg' ? 7.9 : 20),
        splash: g.splash * 40 * (r / 24), accel: rocket ? spd * 2.6 : 0, maxSpd: spd * 1.15, hits: [],
      });
      this.invuln = 0;
      // calibre class drives the sound/shake on clients: 0 light, 1 medium, 2 heavy
      const cal = g.w * g.size >= 0.38 || g.dmg >= 2.5 ? 2 : g.w * g.size > 0.27 || g.dmg >= 1.3 ? 1 : 0;
      // du: how much ground dust the blast throws up round the vehicle (gun recoil x vehicle size; none for MGs)
      ev({ e: 'f', id: this.id, g: i, x: r1(m.x), y: r1(m.y), a: r3(fa), k: KINDS.indexOf(g.kind), b: cal, r: r1(r),
        mm: g.mm || 0, v: r2(g.spd), tx: r1(this.x), ty: r1(this.y), du: g.kind === 'mg' ? 0 : r2(g.recoil * this.cls.size) });
    }
    update(dt) {
      const inp = this.input, c = this.cls;
      if (this.invuln > 0) this.invuln -= dt;
      // components: destroyed ones come back after their repair time (twice as fast at a friendly point);
      // damaged ones heal gradually at the same rate as the hull (faster once out of contact)
      const fast = atFriendlyRepair(this) ? 2 : 1, heal = 0.012 * dt * (time - this.lastHit > 9 ? 3.5 : 1);
      for (const k of ARMOR.COMPONENT_IDS) {
        const p = this.parts[k];
        if (p.fxT > 0) p.fxT -= dt;
        if (p.down <= 0 && p.hp < p.max) p.hp = Math.min(p.max, p.hp + p.max * heal);
        if (p.down > 0 && (p.down -= dt * fast) <= 0) {
          p.down = 0; p.hp = p.max;
          pev(this, { e: 't', x: r1(this.x), y: r1(this.y - 30), text: `${ARMOR.COMPONENTS[k].name.toUpperCase()} REPAIRED`, c: '#9fe0a0', s: 14 });
        }
      }
      const tracksDown = this.parts.tracks.down > 0, engineDown = this.parts.engine.down > 0;

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
      // no tracks: the hull can't turn; a dead engine turns it slowly
      const dHull = rot * this.hullTurn * turn * dt * (tracksDown ? 0 : engineDown ? ARMOR.ENGINE_TURN : 1);
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
      if (engineDown) want *= ARMOR.ENGINE_SPEED;
      if (tracksDown) want = 0;                                        // immobilised
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
          if (firing && this.hasAmmo(i)) {
            this.fire(i);
            if (!g.clip) { this.cds[i] = Math.max(0, this.cds[i] + this.gunReload(i)); if (this.usesAmmo(i)) this.chamberNext(); }
            else if (--this.ammo[i] > 0) this.cds[i] = Math.max(0, this.cds[i] + g.cycle);
            else { this.cds[i] = this.gunReload(i); this.magLoad[i] = true; if (this.usesAmmo(i)) this.chamberNext(); }   // empty: change magazines
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
      if (src.team !== t.team) {
        src.award('Armor Destroyed', killScore(t.cls)); src.kills++;
        // where the killer is: inside a point the enemy holds (raiding) or one its own side holds (defending)
        const at = points.find(p => p.owner && inZone(src, p));
        if (at && at.owner === t.team) src.award('Raiding', SCORE.raid);
        if (at && at.owner === src.team) src.award('Defending', SCORE.defend);
      }
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
  // 1, 1.5, 2x for a 1, 2, 3+ strength edge; a point's capScale makes it that many times slower (O1: 2)
  const capRate = (n, p) => (1 + 0.5 * (Math.min(n, 3) - 1)) / CAP_TIME / (p.capScale || 1);

  function rewardZone(p, team, n, text) {
    for (const t of tanks) if (t.alive && t.team === team && inZone(t, p)) t.award(text, n);
  }

  function updatePoints(dt) {
    for (const p of points) {
      // each vehicle counts its capture weight (light tanks 2, see armor.js), not just 1
      let nd = 0, ns = 0;
      for (const t of tanks) if (t.alive && inZone(t, p)) { if (t.team === 'de') nd += t.cls.capture; else ns += t.cls.capture; }
      p.nd = nd; p.ns = ns;
      if (!p.active) {
        // locked: nobody can fight for it until a neighbouring point changes hands
        p.contested = false;
        p.prog = p.owner ? sgn(p.owner) : 0;
        continue;
      }
      // whichever side has more strength in the zone pushes it their way (faster the bigger the margin);
      // equal strength freezes it
      p.contested = nd > 0 && ns > 0 && nd === ns;
      if (p.contested || phase !== 'play') continue;
      // the bigger side pushes, but only if it's allowed to fight for this point (or is defending its own)
      const big = nd > ns ? 'de' : nd < ns ? 'su' : null;
      const may = big && (big === p.owner || (big === ATTACKER ? p.canAtt : p.canDef));
      if (may) {
        p.prog = clamp(p.prog + sgn(big) * capRate(Math.abs(nd - ns), p) * dt, -1, 1);
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
      else if (time >= battleEnd) forceWin(DEFENDER, 1);       // the clock ran out: the defenders held
    } else if (time >= phaseEnd) {
      phase = 'play'; winner = null; winWhy = 0;
      battleEnd = time + BATTLE_TIME;
      resetPoints();
      bullets.length = 0;
      // fresh battle, fresh logistics (before the bots below redeploy)
      for (const c of clients) c.logiEnd = 0;
      for (const t of tanks) t.logiEnd = 0;
      for (const t of tanks) {
        t.score = t.kills = t.deaths = 0;
        if (t.isBot) { if (t.alive) { t.placeAt(null); t.hp = t.maxHp; t.resetParts(); } else respawnBot(t); }
        else if (t.alive) { t.placeAt(null); t.hp = t.maxHp; t.resetParts(); }
      }
      ev({ e: 'rn' });
    }
  }

  function forceWin(w, why = 0) {
    winner = w; winWhy = why;
    phase = 'end'; phaseEnd = time + ROUND_END;
    ev({ e: 're', w: winner, why });
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
    // the chosen line has run dry but the other hasn't: deploy at that line's rear instead
    let r = poolFor(t.team, sp);
    if ((!r || !poolSum(r)) && t.team === ATTACKER) {
      const L = poolLine(t.team, null), k = L && L !== 'all' ? REARS.findIndex(q => q.line === L) : -1;
      if (k >= 0 && poolSum(reserves[t.team][L])) {
        if (t.client && sp != null) pev(t, { e: 'm', text: `That line is out of reserves — deploying at Rear ${L}`, d: 3.5 });
        sp = -1 - k; r = reserves[t.team][L];
      }
    }
    // attackers with no spawn given go to the rear of the line they draw from, so the two match
    if (sp == null && t.team === ATTACKER) { const L = poolLine(t.team, null), k = REARS.findIndex(q => q.line === L); if (k >= 0) sp = -1 - k; }
    r = r || [0, 0, 0, 0, 0];
    const inStock = id => CLASSES[id] && CLASSES[id].faction === t.team && CLASSES[id].enabled && r[CLASSES[id].cat] > 0;
    const ok = id => inStock(id) && logiWait(t, id) <= 0;
    let id = ok(want) ? want : null;
    if (!id) {
      const alt = CLASS_IDS.filter(ok);
      if (!alt.length) {
        // vehicles are in stock, but the logistics load won't allow any of them yet
        const loaded = CLASS_IDS.some(inStock);
        t.alive = false; t.hp = 0; t.deathTime = time;
        if (t.x === undefined) { const rr = REARS.find(q => q.team === t.team); t.x = rr.x; t.y = rr.y; }
        t.deathX = t.x; t.deathY = t.y;
        if (t.client) pev(t, { e: 'die', kn: loaded ? 'Logistics overloaded' : 'No reserves left', kt: null, kc: '', score: t.score, kills: t.kills, deaths: t.deaths, secs: 0 });
        return false;
      }
      id = ok(START_CLASS[t.team]) ? START_CLASS[t.team] : pick(alt);
      if (t.client && inStock(want)) pev(t, { e: 'm', text: `Logistics load too high for the ${CLASSES[want].name} (${Math.ceil(logiWait(t, want))} s) — deploying a ${CLASSES[id].name}`, d: 3.5 });
      else if (t.client && CLASSES[want] && CLASSES[want].faction === t.team && CLASSES[want].enabled) pev(t, { e: 'm', text: `No ${CATS[CLASSES[want].cat].name.toLowerCase()} left in reserve — deploying a ${CLASSES[id].name}`, d: 3.5 });
    }
    r[CLASSES[id].cat]--;
    const lo = logiHolder(t);
    lo.logiEnd = Math.max(lo.logiEnd || 0, time) + ARMOR.logiOf(id);
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
      const m = (e.rb || e.r) + 16;
      const x0 = clamp(((e.x - m) / CELL) | 0, 0, GN - 1), x1 = clamp(((e.x + m) / CELL) | 0, 0, GN - 1);
      const y0 = clamp(((e.y - m) / CELL) | 0, 0, GN - 1), y1 = clamp(((e.y + m) / CELL) | 0, 0, GN - 1);
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) grid[cy * GN + cx].push(e);
    };
    for (const o of obstacles) if (!o.dead) ins(o);
    for (const t of tanks) if (t.alive) ins(t);
  }
  const gridAt = (x, y) => grid[clamp((y / CELL) | 0, 0, GN - 1) * GN + clamp((x / CELL) | 0, 0, GN - 1)];

  // =====================================================================
  // Bots
  // =====================================================================
  function botRange(c) {
    if (c.guns.some(g => g.kind === 'rocket')) return 520;
    if (c.guns[0].kind === 'mg') return 300;
    if (isScout(c)) return 650;                              // scouts keep their distance
    // tank destroyers (not the howitzers, which have splash) hang back and snipe
    const td = CATS[c.cat] && (CATS[c.cat].key === 'td' || CATS[c.cat].key === 'htd');
    if (td && !c.guns[0].splash) return 680;
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
      angleOff: (Math.random() < 0.5 ? 1 : -1) * rand(0.3, 0.55),   // how far off-square it angles its front
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
      .concat(rearsOf(team).map(k => ({ c: -1 - k, x: REARS[k].x, y: REARS[k].y })))
      .filter(o => { const r = poolFor(team, o.c); return r && poolSum(r) > 0; });     // only where there's stock
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
    const a = rand(0, TAU), r = Math.sqrt(Math.random()) * points[best].r * 0.55;
    ai.ox = Math.cos(a) * r; ai.oy = Math.sin(a) * r;
    return best;
  }
  // bots drive whatever their side fields, weighted toward gun tanks
  // bots draw from the reserve roughly in proportion to what's left in each category
  // (only vehicles the bot's logistics load allows right now)
  function botClass(t, sp) {
    const team = t.team, r = poolFor(team, sp);
    if (!r) return null;
    const ids = CLASS_IDS.filter(id => CLASSES[id].faction === team && CLASSES[id].enabled && r[CLASSES[id].cat] > 0 && logiWait(t, id) <= 0);
    if (!ids.length) return null;
    let tot = 0; for (const id of ids) tot += r[CLASSES[id].cat] / ids.filter(j => CLASSES[j].cat === CLASSES[id].cat).length;
    let x = Math.random() * tot;
    for (const id of ids) { x -= r[CLASSES[id].cat] / ids.filter(j => CLASSES[j].cat === CLASSES[id].cat).length; if (x <= 0) return id; }
    return ids[ids.length - 1];
  }
  function respawnBot(t) {
    const sp = botSpawn(t.team), id = botClass(t, sp);
    if (!id || !deploy(t, id, sp)) { t.alive = false; t.respawnAt = time + 5; return; }
    t.ai = newAi();
    t.ai.scout = isScout(t.cls); t.ai.markT = 0;      // light tanks scout and mark enemies
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
    // they mostly leave the MGs alone: every few seconds there's only a small chance they'll use them for a while
    ai.mgMoodT = (ai.mgMoodT || 0) - dt;
    if (ai.mgMoodT <= 0) { ai.mgMoodT = rand(4, 8); ai.mgMood = Math.random() < 0.12; }
    if (!ai.mgMood) return;
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

  // ---- armour sense for bots (same data and rules as the hit code) ----
  function faceArmour(e, face, cosInc) {
    const arm = ARMOR.armorOf(e.clsId) || [50, 30, 20];
    const thick = face === 'front' ? arm[0] : face === 'rear' ? arm[2] : arm[1];
    const slope = face === 'front' ? ARMOR.slopeOf(e.clsId) * Math.PI / 180 : 0;
    const ce = Math.max(0.02, cosInc * Math.cos(slope));
    return { thick, eff: thick / ce, angle: Math.acos(ce) * 180 / Math.PI };
  }
  // The best place for t to put a round into e from where t stands: of the hull faces it can see (front,
  // the side facing it, rear), the one where penetration / effective armour is highest. ratio >= 1: should
  // penetrate; 0: would ricochet.
  function weakSpot(t, e, penMm) {
    const pen = penMm || ARMOR.penOf(t.clsId) || 40, cal = t.cls.guns[0].mm || 20, rocket = t.cls.guns[0].kind === 'rocket';
    const c = Math.cos(e.hullA), s = Math.sin(e.hullA);
    const lx = (t.x - e.x) * c + (t.y - e.y) * s, ly = -(t.x - e.x) * s + (t.y - e.y) * c;   // t in e's frame
    const sd = ly >= 0 ? 1 : -1;
    let best = null;
    for (const [face, px, py, nx, ny] of [['front', e.hl * 0.8, 0, 1, 0], ['rear', -e.hl * 0.8, 0, -1, 0], ['side', -e.hl * 0.15, sd * e.hw * 0.8, 0, sd]]) {
      const dx = lx - px, dy = ly - py, d = Math.hypot(dx, dy) || 1, cosInc = (dx * nx + dy * ny) / d;
      if (cosInc <= 0.08) continue;                                  // turned away from us
      const fa = faceArmour(e, face, cosInc);
      const ric = !rocket && fa.angle > RICOCHET_DEG && cal <= OVERMATCH * fa.thick;
      const ratio = ric ? 0 : pen / fa.eff;
      if (!best || ratio > best.ratio) best = { face, ratio, x: e.x + px * c - py * s, y: e.y + px * s + py * c };
    }
    return best || { face: 'front', ratio: 0, x: e.x, y: e.y };
  }
  // A point on e's tracks for t to shoot at: on the side facing t, opposite t along the hull. Null when t is
  // too far round to the front or rear (the shot would glance off the side or hit the end plate instead).
  function trackSpot(t, e) {
    const c = Math.cos(e.hullA), s = Math.sin(e.hullA);
    const lx = (t.x - e.x) * c + (t.y - e.y) * s, ly = -(t.x - e.x) * s + (t.y - e.y) * c;   // t in e's frame
    const sd = ly >= 0 ? 1 : -1, px = clamp(lx, -e.hl * 0.6, e.hl * 0.6), py = sd * e.hw * 0.85;
    const dx = lx - px, dy = ly - py, d = Math.hypot(dx, dy) || 1;
    if (Math.abs(dy) / d < 0.45) return null;
    return { x: e.x + px * c - py * s, y: e.y + px * s + py * c };
  }
  const isHeavy = c => !!CATS[c.cat] && (CATS[c.cat].key === 'ht' || CATS[c.cat].key === 'htd');
  function botThink(t, dt) {
    const ai = t.ai, c = t.cls;
    const sight = 900 * t.fov;
    ai.timer -= dt;
    if (ai.timer <= 0) {
      ai.timer = rand(0.25, 0.45);
      let best = null, bd = sight;
      for (const e of tanks) {
        if (!e.alive || e.team === t.team) continue;
        // targets behind a house count as further away, so bots prefer ones they can actually hit,
        // and so do ones whose armour they can't get through from here; a scout's mark extends the reach
        const ws = weakSpot(t, e);
        // (a heavy it can't penetrate is still worth engaging: it works round to the side for the tracks, then
        // on toward the rear)
        const tracksTarget = ws.ratio < 1 && isHeavy(e.cls);
        const d = Math.hypot(e.x - t.x, e.y - t.y) * (bldLine(t.x, t.y, e.x, e.y) ? 1.6 : 1)
          * (ws.ratio >= 1 ? 1 : tracksTarget ? 1.3 : ws.ratio >= 0.7 ? 1.6 : 2.6)
          / (isSpotted(t.team, e) ? SPOT_REACH : 1);
        if (d < bd) { bd = d; best = e; }
      }
      ai.tgt = best;
      // scouts mark the nearest enemy they can see that isn't marked already
      if (ai.scout && time >= ai.markT && phase === 'play') {
        let m = null, md = sight;
        for (const e of tanks) {
          if (!e.alive || e.team === t.team || isSpotted(t.team, e)) continue;
          const d = Math.hypot(e.x - t.x, e.y - t.y);
          if (d < md && !bldLine(t.x, t.y, e.x, e.y)) { md = d; m = e; }
        }
        if (m) {
          ai.markT = time + SCOUT_MARK_EVERY;
          spotted[t.team].set(m, time + SPOT_TIME);
          const mk = { e: 'mk', x: r1(m.x), y: r1(m.y), c: m.cls.cat, by: t.name };
          for (const k of tanks) if (k.client && k.team === t.team) pev(k, mk);
        }
      }
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
    if (t.hp < t.maxHp * (ai.scout ? 0.5 : 0.3) && ai.tgt) ai.retreat = true;      // scouts pull out earlier
    const rks = rearsOf(t.team), rear = rks.length ? REARS[rks.reduce((a, b) => (Math.hypot(REARS[a].x - t.x, REARS[a].y - t.y) < Math.hypot(REARS[b].x - t.x, REARS[b].y - t.y) ? a : b))] : null;
    if (t.hp > t.maxHp * 0.75 || !rear || Math.hypot(rear.x - t.x, rear.y - t.y) < 500) ai.retreat = false;
    if (phase !== 'play') { ai.retreat = false; }

    const e = ai.tgt && ai.tgt.alive && tanks.includes(ai.tgt) ? ai.tgt : null;
    const reach = e && isSpotted(t.team, e) ? sight * SPOT_REACH : sight;     // how far out it will engage e
    const gunSpd = t.bSpd * c.guns[0].spd;
    const aimAt = (x, y, vx, vy) => {
      const d = Math.hypot(x - t.x, y - t.y);
      const tt = d / gunSpd;
      const a = Math.atan2(y + vy * tt - t.y, x + vx * tt - t.x) + ai.err;
      ax = t.x + Math.cos(a) * d; ay = t.y + Math.sin(a) * d;
      return Math.abs(angDiff(t.turA, a)) < (c.guns[0].kind === 'mg' ? 0.35 : 0.16);
    };

    let holdFace = false, spot = null;
    if (e) {
      spot = weakSpot(t, e);
      t.ammoNext = 'ap';
      if (spot.ratio < 1 && t.ammoAPCR > 0) {
        const s2 = weakSpot(t, e, ARMOR.apcrPenOf(t.clsId));
        if (s2.ratio >= 1) { spot = s2; t.ammoNext = 'apcr'; }
      }
      // a heavy it can't get through anywhere: shoot its tracks (side hits break them even without
      // penetrating) to pin it down, while still working round toward its side and rear (below)
      if (spot.ratio < 1 && isHeavy(e.cls) && e.parts && !ARMOR.COMPONENTS.tracks.disabled && !(e.parts.tracks.down > 0)) {
        const tr = trackSpot(t, e);
        if (tr) { spot = { face: 'tracks', ratio: spot.ratio, x: tr.x, y: tr.y }; t.ammoNext = 'ap'; }
      }
    }
    if (ai.retreat) {
      const rx = rear.x - t.x, ry = rear.y - t.y, rd = Math.hypot(rx, ry) || 1;
      mx = rx / rd; my = ry / rd;
      if (e) fire = aimAt(spot.x, spot.y, e.vx, e.vy) && Math.hypot(e.x - t.x, e.y - t.y) < reach * 0.8;
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
        // a heavy it can't penetrate: commit to it and work round for the tracks and the rear
        const hunt = c.style !== 'casemate' && spot.ratio < 1 && isHeavy(e.cls);
        // close to (or already holding) the objective: fight properly; otherwise keep pushing toward it
        if (onObj || d < desired || c.style === 'casemate' || hunt) {
          const radial = d > desired + 80 ? 1 : d < desired - 120 ? -1 : 0;
          if (c.style !== 'casemate' && spot.ratio < 0.9 && (d < desired + 250 || hunt)) {
            // can't get through anything it's showing us: work round to its side or rear
            mx = -uy * ai.side + ux * radial * 0.5; my = ux * ai.side + uy * radial * 0.5;
          } else if (onObj && radial > 0) { mx *= 0.3; my *= 0.3; }       // don't abandon the point to chase
          else if (c.style === 'casemate') { mx = ux * radial * 0.6; my = uy * radial * 0.6; }
          else { mx = mx * 0.3 + ux * radial; my = my * 0.3 + uy * radial; }
        }
        // fighting without much driving to do: keep the (angled) front toward the enemy
        holdFace = c.style !== 'casemate' && Math.hypot(mx, my) < 0.4 && d < reach * 0.85;
        fire = aimAt(spot.x, spot.y, e.vx, e.vy) && d < reach * 0.85;
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
    } else if (holdFace && e) {
      // front toward the enemy, angled off-square so the plate is effectively thicker
      rot = clamp(angDiff(Math.atan2(e.y - t.y, e.x - t.x) + ai.angleOff, t.hullA) * 3, -1, 1);
      th = clamp((mx * Math.cos(t.hullA) + my * Math.sin(t.hullA)) * 0.6, -1, 1);
    } else if (ml > 0.1) {
      const mA = Math.atan2(my, mx);
      const wheel = c.steer === 'wheel';
      // wheeled vehicles never back up to turn (their steering inverts); they keep rolling through the turn.
      // retreating from an enemy in front: reverse away, keeping the front armour toward it
      const facingFoe = e && Math.abs(angDiff(Math.atan2(e.y - t.y, e.x - t.x), t.hullA)) < 1.2;
      const rev = !wheel && (Math.abs(angDiff(mA, t.hullA)) > Math.PI * 0.62 || (ai.retreat && facingFoe && Math.abs(angDiff(mA, t.hullA)) > Math.PI * 0.4));
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
              r: 8, dmg: 24, hp: 30, team: 'x', owner: o, life: 1.6, kind: 'shell', pen: 70, cal: 75, splash: 0, accel: 0, maxSpd: 0, hits: [] });
            ev({ e: 'bf', x: r1(mx), y: r1(my) });
          }
        } else o.gunA = angDiff(o.gunA + dt * 0.2, 0);
      }
    }
  }

  // Swept test of a round's path this tick against a tank's hull rectangle. Returns the entry point, the
  // face it came through ('front' | 'rear' | 'side') and that face's outward normal in the hull's frame.
  function hullHit(b, e) {
    const c = Math.cos(e.hullA), s = Math.sin(e.hullA), pad = b.r * 0.6;
    const toLocal = (x, y) => { const dx = x - e.x, dy = y - e.y; return [dx * c + dy * s, -dx * s + dy * c]; };
    const [x0, y0] = toLocal(b.px === undefined ? b.x : b.px, b.py === undefined ? b.y : b.py), [x1, y1] = toLocal(b.x, b.y);
    const hx = e.hl + pad, hy = e.hw + pad, dx = x1 - x0, dy = y1 - y0;
    let tmin = -Infinity, tmax = Infinity, face = null, nx = 0, ny = 0;
    for (const [p0, d, h, ax] of [[x0, dx, hx, 0], [y0, dy, hy, 1]]) {
      if (Math.abs(d) < 1e-9) { if (p0 < -h || p0 > h) return null; continue; }
      let t1 = (-h - p0) / d, t2 = (h - p0) / d, n = -1;          // t1: crosses the negative face
      if (t1 > t2) { [t1, t2] = [t2, t1]; n = 1; }
      if (t1 > tmin) { tmin = t1; face = ax; nx = ax === 0 ? n : 0; ny = ax === 1 ? n : 0; }
      if (t2 < tmax) tmax = t2;
    }
    if (tmin > tmax || tmin > 1 || tmax < 0) return null;
    if (tmin < 0) {      // already inside (point blank): take the face it's nearest to
      const fx = Math.abs(x0) / hx, fy = Math.abs(y0) / hy;
      if (fx >= fy) { face = 0; nx = Math.sign(x0) || 1; ny = 0; } else { face = 1; nx = 0; ny = Math.sign(y0) || 1; }
      tmin = 0;
    }
    const ix = x0 + dx * tmin, iy = y0 + dy * tmin;
    return {
      x: e.x + ix * c - iy * s, y: e.y + ix * s + iy * c,
      face: face === 0 ? (nx > 0 ? 'front' : 'rear') : 'side', nx, ny,
    };
  }
  // Components a shell or rocket reaches (MG fire never does). The tracks run outside the armour along both
  // sides, so any side hit that doesn't ricochet damages them, penetrating or not. A penetration also damages
  // what's behind that part of the hull: through the front, the ammo rack; through the rear, the engine
  // (middle) or a fuel tank (corners); through the side, a fuel tank and the engine (rear third) or the ammo
  // rack (middle).
  function hitParts(e, b, hit, res) {
    if (b.kind === 'mg' || res.out === 'ric' || !e.parts) return;
    const c = Math.cos(e.hullA), s = Math.sin(e.hullA), dx = hit.x - e.x, dy = hit.y - e.y;
    const u = (dx * c + dy * s) / e.hl, v = (-dx * s + dy * c) / e.hw;     // -1..1: rear..front, left..right
    const parts = [];
    if (hit.face === 'side') parts.push('tracks');
    if (res.out === 'pen') {
      if (hit.face === 'front') parts.push('ammo');
      else if (hit.face === 'rear') parts.push(Math.abs(v) < 0.5 ? 'engine' : 'fuel');
      else if (u < -0.35) parts.push('fuel', 'engine');     // the engine bay spans the back of the hull
      else if (u < 0.35) parts.push('ammo');
    }
    for (const k of parts) if (!ARMOR.COMPONENTS[k].disabled) partDamage(e, k, b.dmg, b.owner, hit, v);
  }
  function partDamage(e, k, amt, src, at, v) {
    const p = e.parts[k];
    if (p.down > 0 || !e.alive || phase !== 'play') return;              // already out of action
    p.hp -= amt;
    // "Engine Damaged +10", "Ammo Rack Destroyed +60" (enemy hits only)
    const label = ARMOR.COMPONENTS[k].name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    const scorer = src && src.kind === 'tank' && src.team !== e.team ? src : null;
    if (p.hp > 0) { if (scorer) scorer.award(label + ' Damaged', SCORE.partHit); return; }
    if (scorer) scorer.award(label + ' Destroyed', SCORE.partKill[k] || 40);
    p.hp = 0; p.down = ARMOR.COMPONENTS[k].repair; p.side = v >= 0 ? 1 : -1; p.fxT = ARMOR.COMPONENTS[k].fx || 0;
    const name = ARMOR.COMPONENTS[k].name.toUpperCase() + ' DESTROYED';
    if (src && src.client) pev(src, { e: 't', x: r1(at.x), y: r1(at.y - 24), text: name, c: '#ffb347', s: 15 });
    if (e.client) pev(e, { e: 't', x: r1(e.x), y: r1(e.y - 30), text: name, c: '#ff6a4a', s: 16 });
    // fuel tank / ammo rack: a one-off burst of extra damage (no damage over time)
    const burst = ARMOR.COMPONENTS[k].burst || 0;
    if (burst > 0) e.damage(e.maxHp * burst, src, false, true);
  }
  // inside a capture zone your side holds, or at one of your live rear areas
  function atFriendlyRepair(t) {
    return points.some(p => p.owner === t.team && inZone(t, p))
      || rearsOf(t.team).some(k => Math.hypot(REARS[k].x - t.x, REARS[k].y - t.y) < 380);
  }
  // What a round does to the face it hit: 'ric' (ricochet), 'pen' (penetrates) or 'bounce' (fails to).
  function armourResult(b, e, hit) {
    const arm = ARMOR.armorOf(e.clsId) || [50, 30, 20];
    const thick = hit.face === 'front' ? arm[0] : hit.face === 'rear' ? arm[2] : arm[1];
    const c = Math.cos(e.hullA), s = Math.sin(e.hullA);
    const vlx = b.vx * c + b.vy * s, vly = -b.vx * s + b.vy * c, v = Math.hypot(vlx, vly) || 1;
    const cosH = Math.abs(vlx * hit.nx + vly * hit.ny) / v;                         // angle across the hull
    const slope = hit.face === 'front' ? ARMOR.slopeOf(e.clsId) * Math.PI / 180 : 0;  // plus the plate's tilt
    const cosEff = Math.max(0.02, cosH * Math.cos(slope));
    const angle = Math.acos(cosEff) * 180 / Math.PI;
    const overmatch = (b.cal || 0) > OVERMATCH * thick;
    if (b.kind !== 'rocket' && !overmatch && angle > RICOCHET_DEG) return { out: 'ric', angle, thick, eff: thick / cosEff };
    const eff = thick / cosEff, roll = (b.pen || 0) * (1 + (Math.random() * 2 - 1) * PEN_SPREAD);
    return { out: roll >= eff ? 'pen' : 'bounce', angle, thick, eff };
  }
  function updateBullets(dt) {
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      if (b.accel) {
        const ns = Math.min(b.maxSpd, Math.hypot(b.vx, b.vy) + b.accel * dt);
        b.vx = Math.cos(b.a) * ns; b.vy = Math.sin(b.a) * ns;
      }
      b.px = b.x; b.py = b.y;
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
        if (e.kind === 'tank') {
          if (!e.alive || e.team === b.team || e === b.owner) continue;
          const hit = hullHit(b, e);
          if (!hit) continue;
          b.hits.push(e.id);
          const res = armourResult(b, e, hit);
          b.x = hit.x; b.y = hit.y;
          hitParts(e, b, hit, res);
          if (res.out === 'pen') e.damage(b.dmg, b.owner);
          else if (res.out === 'bounce' && NONPEN_DMG > 0 && b.kind !== 'mg') e.damage(b.dmg * NONPEN_DMG, b.owner, false, true);
          // a shell bounced off a player's tank: a distinct clang for them, and a grey direction marker
          if (res.out !== 'pen' && b.kind !== 'mg' && e.client && b.owner && b.owner.x !== undefined)
            pev(e, { e: 'dh', x: r1(b.owner.x), y: r1(b.owner.y), s: 0.2, g: 1, r: res.out === 'ric' ? 1 : 0 });
          // feedback: shooter and target see what happened (MG rounds only on a penetration of the rear)
          const lbl = res.out === 'ric' ? ['RICOCHET', '#c8c8c8'] : res.out === 'bounce' ? ['NON-PENETRATION', '#c8c8c8']
            : hit.face === 'rear' ? ['REAR HIT', '#ffb347'] : null;
          if (lbl && b.kind !== 'mg' && b.owner && b.owner.client) pev(b.owner, { e: 't', x: r1(b.x), y: r1(b.y - 10), text: lbl[0], c: lbl[1], s: 14 });
          if (res.out !== 'pen' && b.kind !== 'mg' && e.client) pev(e, { e: 't', x: r1(b.x), y: r1(b.y - 10), text: res.out === 'ric' ? 'RICOCHET' : 'NON-PENETRATION', c: '#9fd1ff', s: 14 });
          // (m: an MG round, so clients skip the clank when it glances off)
          if (res.out !== 'ric' || b.kind === 'mg') ev({ e: 'h', x: r1(b.x), y: r1(b.y), z: res.out === 'pen' ? (hit.face === 'rear' ? 2 : 0) : 1, vx: Math.round(b.vx), vy: Math.round(b.vy), m: b.kind === 'mg' ? 1 : undefined });
          if (res.out === 'ric') {
            // skip off the plate and keep going (slower, briefly)
            const c = Math.cos(e.hullA), sn = Math.sin(e.hullA);
            const nx = hit.nx * c - hit.ny * sn, ny = hit.nx * sn + hit.ny * c, dot = b.vx * nx + b.vy * ny;
            b.vx = (b.vx - 2 * dot * nx) * 0.6; b.vy = (b.vy - 2 * dot * ny) * 0.6;
            b.a = Math.atan2(b.vy, b.vx); b.accel = 0;
            b.x += nx * 2; b.y += ny * 2; b.life = Math.min(b.life, 0.35);
            if (b.kind !== 'mg') ev({ e: 'h', x: r1(b.x), y: r1(b.y), z: 4, vx: Math.round(b.vx), vy: Math.round(b.vy) });
            break;
          }
          if (b.splash) explode(b.x, b.y, b.splash, b.dmg * 0.6, b.team, b.owner);
          dead = true;          // penetrated (stopped inside) or bounced off without skipping: round is spent
          break;
        }
        if (e.dead || b.team === 'x') continue;
        const dx = e.x - b.x, dy = e.y - b.y, rr = e.r + b.r;
        if (dx * dx + dy * dy > rr * rr) continue;
        b.hits.push(e.id);
        const zone = 0;
        {
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
      // chat: to everyone, or (tm) only your own side; plain text, short, at most one message every 0.6 s
      case 'chat': {
        if (!t) break;
        const text = String(m.x || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
        if (!text || time - (client.chatT ?? -9) < 0.6) break;
        client.chatT = time;
        const msg = { e: 'chat', n: t.name, t: TEAM_IDS.indexOf(t.team), tm: m.tm ? 1 : 0, x: text };
        for (const c of clients) if (c.tank && (!msg.tm || c.tank.team === t.team)) c.pending.push(msg);
        break;
      }
      case 'mark':
        if (t && t.alive && phase === 'play' && Number.isInteger(m.c) && m.c >= 0 && m.c < CATS.length && time - (client.lastMark ?? -9) >= 1) {
          client.lastMark = time;
          const mk = { e: 'mk', x: r1(num(m.x, 0, WORLD, t.x)), y: r1(num(m.y, 0, WORLD, t.y)), c: m.c, by: t.name };
          for (const k of tanks) if (k.client && k.team === t.team) pev(k, mk);
        }
        break;
      case 'ammo':
        if (t && t.alive && (m.s === 'ap' || m.s === 'apcr')) {
          if (m.s === t.ammoNext && m.s !== t.ammoSel) t.forceReload();
          else t.ammoNext = m.s;
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
        r2(k.hp / k.maxHp), k.invuln > 0 ? 1 : 0, k.name, k.cls.mgs ? k.mgRel.map(r2) : 0, k.rank, k.partsFx()]);
    }
    const B = [];
    // last field: 1 if this client fired it (so it can draw its own rounds differently)
    for (const b of bullets) if (near(b.x, b.y)) B.push([b.id, r1(b.x), r1(b.y), r1(b.r), TEAM_IDS.indexOf(b.team), KINDS.indexOf(b.kind), r3(b.a), t && b.owner === t ? 1 : 0]);
    const O = [];
    for (const o of obstacles) if (!o.dead && near(o.x, o.y, o.r)) O.push([o.id, o.ti, r1(o.x), r1(o.y), r3(o.a), r2(o.hp / o.maxHp), r3(o.gunA), r2(o.grow)]);
    const E = [];
    for (const e of events) if (e.x === undefined || near(e.x, e.y, 400)) E.push(e);
    for (const e of client.pending) E.push(e);
    client.pending.length = 0;

    const snap = { t: 's', tm: r3(time), T, B, O, E };
    // conquest state is tiny, so it goes out every snapshot
    snap.cp = points.map(p => [r2(p.prog), p.owner === 'de' ? 1 : p.owner === 'su' ? 2 : 0, p.contested ? 1 : 0, p.active ? 1 : 0, p.nd, p.ns, p.canAtt ? 1 : 0, p.canDef ? 1 : 0]);
    snap.ln = LINES.map(L => (lineDead[L] ? 1 : 0));
    snap.rs = [reserveTotal('de'), reserveTotal('su')];
    snap.rl = LINES.map(L => (lineDead[L] ? null : reserves[ATTACKER][L]));
    snap.ph = phase === 'play' ? 0 : [winner === 'de' ? 1 : 2, Math.ceil(phaseEnd - time), winWhy];
    if (phase === 'play') snap.bt = Math.max(0, Math.ceil(battleEnd - time));   // battle clock
    snap.lg = r1(Math.max(0, (client.logiEnd || 0) - time));                     // your logistics load (s)
    // leaderboard: [id, team, name, score, kills, deaths, rank, alive, logistics load (allies only, else -1)]
    if (includeBoard) snap.on = clients.size;   // people connected (playing or on the menu)
    // last field: logistics load in seconds, only for your own side's rows (-1 for the enemy's, so it never leaves the server)
    const myTeam = t ? t.team : client.lockTeam;
    if (includeBoard) snap.lb = tanks.map(k => [k.id, TEAM_IDS.indexOf(k.team), k.name, k.score, k.kills, k.deaths, k.rank, k.alive ? 1 : 0,
      k.team === myTeam ? Math.round(logiLoad(k)) : -1]);
    if (t) {
      // per component (armor.js COMPONENT_IDS order): pt seconds until repaired (0 = working), ph health 0..1
      snap.you = { pt: ARMOR.COMPONENT_IDS.map(k => Math.ceil(t.parts[k].down)), ph: ARMOR.COMPONENT_IDS.map(k => r2(t.parts[k].hp / t.parts[k].max)), id: t.id, alive: t.alive ? 1 : 0, score: t.score, rank: t.rank, deaths: t.deaths, c: t.cls.idx, kills: t.kills, fov: r3(t.fov), team: t.team,
        // reload progress; a magazine gun only shows it while changing magazines (am = rounds left)
        rl: !t.alive ? 0 : t.cls.guns[0].clip ? (t.magLoad[0] ? r2(clamp(t.cds[0] / t.gunReload(0), 0, 1)) : 0) : r2(clamp(t.cds[0] / t.gunReload(0), 0, 1)),
        am: t.cls.guns[0].clip ? t.ammo[0] : undefined,
        // main gun ammo: AP left, APCR left, which is loaded (0 AP, 1 APCR)
        ap: t.ammoAP > 0 ? 1 : 0, ar: t.ammoAPCR > 0 ? 1 : 0, as: t.ammoSel === 'apcr' ? 1 : 0, aq: t.ammoNext === 'apcr' ? 1 : 0,
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
  balanceBots();

  return {
    step, handle, addClient, removeClient, snapshotFor, endSnapshotRound,
    get time() { return time; },
    stats: () => ({ tanks: tanks.length, humans: tanks.filter(t => !t.isBot).length, bullets: bullets.length, obstacles: obstacles.length, clients: clients.size }),
  };
}

module.exports = { createGame };
