/* ZITADELLE — every vehicle's gameplay statistics, loaded by both the Node server and the browser client.
 *
 * Pure data keyed by vehicle id (the ids in shared.js), with no dependencies: load it before shared.js.
 * shared.js defines what each vehicle is and how it looks (name, shape, barrel geometry, weapon kind) and
 * merges these numbers in; armour, penetration and logistics are read from here directly.
 *
 * Armour and main gun (historical, in mm / rounds):
 *   armor: [front, side, rear]   hull plate thickness in mm
 *   slope: degrees               angle of the upper front plate from vertical (0 = flat, 60 = steeply sloped)
 *   pen:   mm                    main gun penetration with its standard armour-piercing (AP) round at ~500 m
 *   ammo:  rounds                main gun rounds carried
 *   apcr:  rounds                how many of those are APCR (tungsten-cored, faster: more penetration, less
 *                                damage); 0 if the gun had none. Optional apcrPen overrides pen x APCR_PEN.
 *   logi:  seconds               logistics cost: deploying the vehicle adds this to the player's logistics
 *                                load, which drains one second per second. A vehicle can't be deployed while
 *                                that would push the load over LOGI_LIMIT. Missing = free. Steep for the big
 *                                German cats, lighter for their Soviet counterparts (a first pass).
 *   cal:   mm                    main gun calibre (shell guns): firing sound and overmatch
 *
 * Handling (multipliers, 1 = baseline; a missing value takes VEHICLE_DEFAULTS):
 *   speed, hp, ram (collision damage), traverse (turret / casemate), fov (view range: you see 1750 x fov
 *   world units across the screen, bots spot at 900 x fov), steer: 'neutral' (pivots in place; otherwise
 *   halftracks and trucks steer by wheel and everything else by clutch-brake)
 *   capture: how many vehicles it counts as in a capture zone (light tanks 2)
 *
 * Main gun (gun: {...}, applied to every barrel; a missing value takes GUN_DEFAULTS):
 *   reload  seconds between shots (x RELOAD_MULT in shared.js); for magazine guns, time to change magazines
 *   clip    rounds per magazine (0 = single-loaded); cycle = seconds between shots while the magazine lasts
 *   dmg     damage multiplier          spd     shell velocity multiplier
 *   pen     shell toughness when shells collide (a multiplier, not mm: armour penetration is pen above)
 *   spread  inaccuracy, radians either side          range   shell travel multiplier
 *   recoil  muzzle blast: how much ground dust a shot kicks up round the vehicle (x vehicle size; firing
 *           doesn't move the vehicle)                splash  blast radius multiplier (0 = none)
 *
 * Values are approximate historical figures rounded for the game, not a reference.
 */
(function (root) {
'use strict';

const VEHICLES = {
  // ---- Germany ----
  pz2c: { // 20mm KwK 30
    armor: [30, 15, 15],    slope: 10, pen: 23, ammo: 180, apcr: 30, logi: 0, cal: 20,
    speed: 1.22, hp: 0.7, traverse: 4.5, fov: 1.5, ram: 1, capture: 2,
    gun: { reload: 2.3, dmg: 0.38, spd: 1.1, pen: 0.6, spread: 0.06, range: 1, recoil: 0.3, clip: 10, cycle: 0.22 },
  },
  pz38t: { // 37mm KwK 38(t)
    armor: [50, 30, 15],    slope: 15, pen: 41, ammo: 90, apcr: 12, logi: 0, cal: 37,
    speed: 1.18, hp: 0.8, traverse: 4, fov: 1.5, ram: 1, capture: 2,
    gun: { reload: 0.5, dmg: 0.6, spd: 1.15, pen: 0.8, spread: 0.05, range: 1, recoil: 0.5 },
  },
  luchs: { // 20mm KwK 38
    armor: [30, 20, 20],    slope: 15, pen: 25, ammo: 330, apcr: 40, logi: 0, cal: 20,
    speed: 1.35, hp: 0.75, traverse: 4.6, fov: 1.5, ram: 1, capture: 2,
    gun: { reload: 2.3, dmg: 0.4, spd: 1.15, pen: 0.62, spread: 0.06, range: 1, recoil: 0.3, clip: 10, cycle: 0.13 },
  },
  pz3: { // 50mm KwK 39 L/60 (spaced front)
    armor: [70, 30, 50],    slope: 10, pen: 61, ammo: 92, apcr: 12, logi: 30, cal: 50,
    speed: 1, hp: 1, traverse: 3.2, fov: 1.2, ram: 1,
    gun: { reload: 1, dmg: 1, spd: 1, pen: 1, spread: 0.03, range: 1, recoil: 1 },
  },
  pz4: { // 75mm KwK 40 L/48
    armor: [80, 30, 20],    slope: 10, pen: 91, ammo: 87, apcr: 8, logi: 60, cal: 75,
    speed: 1, hp: 1, traverse: 2.8, fov: 1.2, ram: 1,
    gun: { reload: 1, dmg: 1.3, spd: 1.2, pen: 1.2, spread: 0.03, range: 1.15, recoil: 1 },
  },
  hetzer: { // 75mm PaK 39 L/48
    armor: [60, 20, 8],     slope: 60, pen: 91, ammo: 41, apcr: 6, logi: 45, cal: 75,
    speed: 1, hp: 1, traverse: 1.9, fov: 1.2, ram: 1,
    gun: { reload: 1.15, dmg: 1.4, spd: 1.25, pen: 1.3, spread: 0.03, range: 1.2, recoil: 1.5 },
  },
  stug: { // 75mm StuK 40 L/48
    armor: [80, 30, 50],    slope: 10, pen: 91, ammo: 54, apcr: 6, logi: 60, cal: 75,
    speed: 1, hp: 1.15, traverse: 2, fov: 1.2, ram: 1,
    gun: { reload: 1.25, dmg: 1.7, spd: 1, pen: 1.3, spread: 0.03, range: 1, recoil: 1.6 },
  },
  jgpz4: { // 75mm PaK 42 L/70
    armor: [80, 40, 20],    slope: 50, pen: 124, ammo: 55, apcr: 8, logi: 90, cal: 75,
    speed: 0.95, hp: 1.2, traverse: 1.9, fov: 1.2, ram: 1,
    gun: { reload: 1.2, dmg: 1.6, spd: 1.55, pen: 1.5, spread: 0.03, range: 1.45, recoil: 1.8 },
  },
  sdkfz: { // (switched off)
    speed: 1.2, hp: 0.85, traverse: 6, fov: 1, ram: 1,
    gun: { reload: 0.3, dmg: 0.36, spd: 1, pen: 0.6, spread: 0.12, range: 1, recoil: 0.2 },
  },
  tiger: { // 88mm KwK 36 L/56
    armor: [100, 80, 80],   slope: 10, pen: 110, ammo: 92, apcr: 8, logi: 300, cal: 88,
    speed: 0.82, hp: 1.6, traverse: 1.6, fov: 1, ram: 1.4, steer: 'neutral',
    gun: { reload: 1.45, dmg: 2.1, spd: 1.15, pen: 1.6, spread: 0.03, range: 1, recoil: 2 },
  },
  panther: { // 75mm KwK 42 L/70
    armor: [80, 40, 40],    slope: 55, pen: 124, ammo: 79, apcr: 6, logi: 180, cal: 75,
    speed: 1.05, hp: 1, traverse: 2.4, fov: 1.2, ram: 1, steer: 'neutral',
    gun: { reload: 1.05, dmg: 1.4, spd: 1.55, pen: 1.45, spread: 0.03, range: 1.4, recoil: 1 },
  },
  jagdpanther: { // 88mm PaK 43 L/71
    armor: [80, 50, 40],    slope: 55, pen: 185, ammo: 57, apcr: 6, logi: 240, cal: 88,
    speed: 1, hp: 1.3, traverse: 1.8, fov: 1.4, ram: 1, steer: 'neutral',
    gun: { reload: 1.3, dmg: 2.3, spd: 1.7, pen: 1.8, spread: 0.03, range: 1.5, recoil: 2 },
  },
  ferdinand: { // 88mm PaK 43 L/71
    armor: [200, 80, 80],   slope: 10, pen: 185, ammo: 50, apcr: 6, logi: 360, cal: 88,
    speed: 0.76, hp: 1.45, traverse: 1.1, fov: 1.4, ram: 1, steer: 'neutral',
    gun: { reload: 1.8, dmg: 2.7, spd: 1.75, pen: 2, spread: 0.03, range: 1.6, recoil: 2.4 },
  },
  brummbaer: { // 150mm StuH 43 (shaped charge)
    armor: [100, 50, 20],   slope: 30, pen: 120, ammo: 38, apcr: 0, logi: 180, cal: 150,
    speed: 0.85, hp: 1.55, traverse: 1.6, fov: 1, ram: 1,
    gun: { reload: 2, dmg: 2.6, spd: 0.62, pen: 2.2, spread: 0.03, range: 0.95, recoil: 3, splash: 1.6 },
  },
  wirbelwind: { // (switched off)
    speed: 1.05, hp: 1, traverse: 4.5, fov: 1, ram: 1,
    gun: { reload: 0.28, dmg: 0.42, spd: 1, pen: 0.7, spread: 0.1, range: 1, recoil: 0.15 },
  },
  stukafuss: { // (switched off)
    speed: 1.12, hp: 0.95, traverse: 2.4, fov: 1, ram: 1,
    gun: { reload: 2.4, dmg: 1.1, spd: 0.75, pen: 1, spread: 0.12, range: 1.2, recoil: 0.3, splash: 0.9 },
  },
  tiger2: { // 88mm KwK 43 L/71
    armor: [150, 80, 80],   slope: 50, pen: 185, ammo: 86, apcr: 6, logi: 420, cal: 88,
    speed: 0.74, hp: 1.95, traverse: 1.4, fov: 1, ram: 1.7, steer: 'neutral',
    gun: { reload: 1.5, dmg: 2.5, spd: 1.35, pen: 1.95, spread: 0.03, range: 1.3, recoil: 2.2 },
  },
  jagdtiger: { // 128mm PaK 44 L/55
    armor: [150, 80, 80],   slope: 50, pen: 212, ammo: 40, apcr: 4, logi: 480, cal: 128,
    speed: 0.66, hp: 1.9, traverse: 0.95, fov: 1, ram: 1, steer: 'neutral',
    gun: { reload: 2.1, dmg: 3.7, spd: 1.75, pen: 2.6, spread: 0.03, range: 1.75, recoil: 3, splash: 1.4 },
  },
  sturmtiger: { // (switched off)
    speed: 0.72, hp: 1.9, traverse: 1.3, fov: 1, ram: 1, steer: 'neutral',
    gun: { reload: 3, dmg: 4.5, spd: 0.55, pen: 3.4, spread: 0.03, range: 1.3, recoil: 2, splash: 2.6 },
  },
  kugelblitz: { // (switched off)
    speed: 1.08, hp: 1, traverse: 6, fov: 1, ram: 1,
    gun: { reload: 0.17, dmg: 0.62, spd: 1, pen: 0.95, spread: 0.07, range: 1, recoil: 0.2 },
  },
  panzerwerfer: { // (switched off)
    speed: 1.08, hp: 1.05, traverse: 2.2, fov: 1, ram: 1,
    gun: { reload: 2.7, dmg: 1.25, spd: 0.8, pen: 1.1, spread: 0.11, range: 1.3, recoil: 0.25, splash: 1 },
  },

  // ---- Soviet Union ----
  t26: { // 45mm 20-K
    armor: [15, 15, 15],    slope: 15, pen: 43, ammo: 165, apcr: 20, logi: 0, cal: 45,
    speed: 1, hp: 0.8, traverse: 3.8, fov: 1.5, ram: 1, capture: 2,
    gun: { reload: 0.48, dmg: 0.55, spd: 1.1, pen: 0.78, spread: 0.05, range: 1, recoil: 0.5 },
  },
  bt7: { // 45mm 20-K
    armor: [22, 13, 13],    slope: 20, pen: 43, ammo: 132, apcr: 16, logi: 0, cal: 45,
    speed: 1.4, hp: 0.75, traverse: 4, fov: 1.5, ram: 1, capture: 2,
    gun: { reload: 0.46, dmg: 0.56, spd: 1.12, pen: 0.8, spread: 0.05, range: 1, recoil: 0.5 },
  },
  t28: { // 76mm KT-28 (short)
    armor: [30, 20, 20],    slope: 15, pen: 35, ammo: 70, apcr: 0, logi: 30, cal: 76,
    speed: 0.88, hp: 1.15, traverse: 2.6, fov: 1.2, ram: 1,
    gun: { reload: 1.1, dmg: 1.1, spd: 0.95, pen: 0.95, spread: 0.03, range: 1, recoil: 1.2 },
  },
  t34: { // 76mm F-34
    armor: [45, 40, 40],    slope: 60, pen: 61, ammo: 77, apcr: 8, logi: 45, cal: 76,
    speed: 1.05, hp: 1, traverse: 2.8, fov: 1.2, ram: 1,
    gun: { reload: 1, dmg: 1, spd: 1, pen: 1, spread: 0.03, range: 1, recoil: 1 },
  },
  kv1s: { // 76mm ZiS-5
    armor: [75, 60, 60],    slope: 25, pen: 61, ammo: 114, apcr: 10, logi: 150, cal: 76,
    speed: 0.92, hp: 1.3, traverse: 2.4, fov: 1, ram: 1.2,
    gun: { reload: 1, dmg: 1.35, spd: 1.1, pen: 1.15, spread: 0.03, range: 1, recoil: 1 },
  },
  su100: { // 100mm D-10S
    armor: [75, 45, 45],    slope: 50, pen: 162, ammo: 33, apcr: 4, logi: 180, cal: 100,
    speed: 0.98, hp: 1.45, traverse: 1.6, fov: 1.4, ram: 1,
    gun: { reload: 1.75, dmg: 3, spd: 1.8, pen: 2.3, spread: 0.03, range: 1.7, recoil: 2.6 },
  },
  su122: { // 122mm M-30S (shaped charge)
    armor: [45, 45, 40],    slope: 50, pen: 100, ammo: 40, apcr: 0, logi: 90, cal: 122,
    speed: 1, hp: 1.12, traverse: 2, fov: 1, ram: 1,
    gun: { reload: 1.55, dmg: 1.9, spd: 0.8, pen: 1.5, spread: 0.03, range: 1, recoil: 2, splash: 1 },
  },
  su76: { // 76mm ZiS-3
    armor: [25, 15, 15],    slope: 30, pen: 61, ammo: 60, apcr: 6, logi: 30, cal: 76,
    speed: 1.12, hp: 0.85, traverse: 2.4, fov: 1.2, ram: 1,
    gun: { reload: 1.05, dmg: 1.3, spd: 1.3, pen: 1.2, spread: 0.03, range: 1.2, recoil: 1.4 },
  },
  t70: { // 45mm 20-K
    armor: [45, 15, 25],    slope: 30, pen: 43, ammo: 90, apcr: 12, logi: 0, cal: 45,
    speed: 1.25, hp: 0.82, traverse: 4.2, fov: 1.5, ram: 1, capture: 2,
    gun: { reload: 0.42, dmg: 0.55, spd: 1.15, pen: 0.8, spread: 0.05, range: 1, recoil: 0.5 },
  },
  kv85: { // 85mm D-5T
    armor: [75, 60, 60],    slope: 25, pen: 102, ammo: 70, apcr: 6, logi: 210, cal: 85,
    speed: 0.84, hp: 1.7, traverse: 1.9, fov: 1, ram: 1.4,
    gun: { reload: 1.4, dmg: 2, spd: 1.2, pen: 1.6, spread: 0.03, range: 1, recoil: 2 },
  },
  t3485: { // 85mm ZiS-S-53
    armor: [45, 45, 45],    slope: 60, pen: 102, ammo: 56, apcr: 6, logi: 90, cal: 85,
    speed: 1.1, hp: 1.1, traverse: 2.6, fov: 1.2, ram: 1,
    gun: { reload: 1.05, dmg: 1.35, spd: 1.45, pen: 1.4, spread: 0.03, range: 1.35, recoil: 1 },
  },
  su152: { // 152mm ML-20S
    armor: [75, 60, 60],    slope: 25, pen: 125, ammo: 20, apcr: 0, logi: 210, cal: 152,
    speed: 0.82, hp: 1.55, traverse: 1.4, fov: 1, ram: 1,
    gun: { reload: 2, dmg: 3, spd: 0.85, pen: 2.3, spread: 0.03, range: 1, recoil: 3, splash: 1.4 },
  },
  su85: { // 85mm D-5S
    armor: [45, 45, 40],    slope: 50, pen: 102, ammo: 48, apcr: 6, logi: 75, cal: 85,
    speed: 1, hp: 1.2, traverse: 1.7, fov: 1.2, ram: 1,
    gun: { reload: 1.45, dmg: 2.2, spd: 1.65, pen: 1.8, spread: 0.03, range: 1.55, recoil: 2 },
  },
  zsu37: { // (switched off)
    speed: 1.18, hp: 0.95, traverse: 5, fov: 1, ram: 1,
    gun: { reload: 0.15, dmg: 0.5, spd: 1, pen: 0.8, spread: 0.09, range: 1, recoil: 0.2 },
  },
  katyusha: { // (switched off)
    speed: 1.1, hp: 0.9, traverse: 2.2, fov: 1, ram: 1,
    gun: { reload: 2.6, dmg: 1.15, spd: 0.78, pen: 1, spread: 0.13, range: 1.25, recoil: 0.2, splash: 1 },
  },
  is2: { // 122mm D-25T
    armor: [120, 90, 60],   slope: 60, pen: 142, ammo: 28, apcr: 0, logi: 300, cal: 122,
    speed: 0.78, hp: 1.95, traverse: 1.5, fov: 1, ram: 1.7,
    gun: { reload: 1.85, dmg: 3, spd: 1.25, pen: 2.1, spread: 0.03, range: 1, recoil: 2.6 },
  },
  isu152: { // 152mm ML-20S
    armor: [90, 90, 60],    slope: 30, pen: 125, ammo: 21, apcr: 0, logi: 270, cal: 152,
    speed: 0.72, hp: 2, traverse: 1.2, fov: 1, ram: 1,
    gun: { reload: 2.6, dmg: 4.4, spd: 0.9, pen: 3, spread: 0.03, range: 1, recoil: 3.4, splash: 1.9 },
  },
  m17: { // (switched off)
    speed: 1.22, hp: 0.95, traverse: 6.5, fov: 1, ram: 1,
    gun: { reload: 0.2, dmg: 0.42, spd: 1, pen: 0.75, spread: 0.09, range: 1, recoil: 0.1 },
  },
  bm31: { // (switched off)
    speed: 1.06, hp: 1, traverse: 2, fov: 1, ram: 1,
    gun: { reload: 3, dmg: 1.6, spd: 0.75, pen: 1.3, spread: 0.13, range: 1.3, recoil: 0.25, splash: 1.3 },
  },

  // ---- Italy (not playable yet) ----
  l640: { // 20mm Breda 35
    armor: [30, 15, 15],    slope: 10, pen: 24, ammo: 296, apcr: 30, cal: 20,
    speed: 1.15, hp: 0.68, traverse: 4.2, fov: 1, ram: 1, capture: 2,
    gun: { reload: 2, dmg: 0.38, spd: 1.1, pen: 0.55, spread: 0.06, range: 1, recoil: 0.3, clip: 8, cycle: 0.3 },
  },
  m1340: { // 47mm 47/32
    armor: [30, 25, 25],    slope: 15, pen: 43, ammo: 104, apcr: 10, cal: 47,
    speed: 0.92, hp: 0.9, traverse: 3, fov: 1, ram: 1,
    gun: { reload: 0.6, dmg: 0.75, spd: 1.1, pen: 0.85, spread: 0.03, range: 1, recoil: 0.7 },
  },
  p2640: { // 75mm 75/34
    armor: [50, 45, 40],    slope: 40, pen: 70, ammo: 65, apcr: 6, cal: 75,
    speed: 0.95, hp: 1.25, traverse: 2.6, fov: 1, ram: 1,
    gun: { reload: 1, dmg: 1.2, spd: 1.1, pen: 1.05, spread: 0.03, range: 1, recoil: 1.2 },
  },
  sem7518: { // 75mm 75/18 (shaped charge)
    armor: [50, 25, 25],    slope: 20, pen: 70, ammo: 44, apcr: 0, cal: 75,
    speed: 0.95, hp: 1, traverse: 2, fov: 1, ram: 1,
    gun: { reload: 1.2, dmg: 1.3, spd: 0.85, pen: 1.2, spread: 0.03, range: 1, recoil: 1.4, splash: 0.6 },
  },

  // ---- United States (not playable yet) ----
  m3stuart: { // 37mm M6
    armor: [38, 25, 25],    slope: 20, pen: 46, ammo: 103, apcr: 10, cal: 37,
    speed: 1.3, hp: 0.8, traverse: 4.4, fov: 1, ram: 1, capture: 2,
    gun: { reload: 0.48, dmg: 0.58, spd: 1.15, pen: 0.8, spread: 0.05, range: 1, recoil: 0.5 },
  },
  m4sherman: { // 75mm M3
    armor: [51, 38, 38],    slope: 56, pen: 76, ammo: 97, apcr: 6, cal: 75,
    speed: 1.05, hp: 1.1, traverse: 3.4, fov: 1, ram: 1,
    gun: { reload: 1, dmg: 1.15, spd: 1.1, pen: 1, spread: 0.03, range: 1, recoil: 1 },
  },
  m26: { // 90mm M3
    armor: [102, 76, 51],   slope: 46, pen: 147, ammo: 70, apcr: 6, cal: 90,
    speed: 0.92, hp: 1.6, traverse: 2.2, fov: 1, ram: 1,
    gun: { reload: 1.35, dmg: 2, spd: 1.45, pen: 1.75, spread: 0.03, range: 1.3, recoil: 2 },
  },
  m10: { // 3-inch M7
    armor: [51, 19, 19],    slope: 55, pen: 99, ammo: 54, apcr: 6, cal: 76,
    speed: 1.02, hp: 1.05, traverse: 1.7, fov: 1.3, ram: 1,
    gun: { reload: 1.2, dmg: 1.6, spd: 1.45, pen: 1.5, spread: 0.03, range: 1.4, recoil: 1.6 },
  },

  // ---- United Kingdom (not playable yet) ----
  tetrarch: { // 2-pounder
    armor: [16, 14, 14],    slope: 10, pen: 52, ammo: 50, apcr: 8, cal: 40,
    speed: 1.28, hp: 0.72, traverse: 4.3, fov: 1, ram: 1, capture: 2,
    gun: { reload: 0.46, dmg: 0.6, spd: 1.2, pen: 0.85, spread: 0.05, range: 1, recoil: 0.5 },
  },
  cromwell: { // 75mm OQF
    armor: [76, 32, 32],    slope: 0,  pen: 68, ammo: 64, apcr: 6, cal: 75,
    speed: 1.3, hp: 1.1, traverse: 3.2, fov: 1, ram: 1, steer: 'neutral',
    gun: { reload: 1, dmg: 1.15, spd: 1.1, pen: 1, spread: 0.03, range: 1, recoil: 1 },
  },
  churchill: { // 75mm OQF
    armor: [152, 95, 50],   slope: 0,  pen: 68, ammo: 84, apcr: 6, cal: 75,
    speed: 0.7, hp: 1.9, traverse: 2.4, fov: 1, ram: 1.5, steer: 'neutral',
    gun: { reload: 1, dmg: 1.15, spd: 1.1, pen: 1, spread: 0.03, range: 1, recoil: 1 },
  },
  achilles: { // 17-pounder
    armor: [51, 19, 19],    slope: 55, pen: 171, ammo: 50, apcr: 8, cal: 76,
    speed: 1.02, hp: 1.05, traverse: 1.7, fov: 1.4, ram: 1,
    gun: { reload: 1.4, dmg: 2.3, spd: 1.75, pen: 1.95, spread: 0.03, range: 1.55, recoil: 2 },
  },
};

// ---- secondary machine guns ----
// reload = time between rounds; clip = rounds per belt/drum/pan; mag = seconds to change it once empty;
// pen = shell toughness multiplier (as for main guns); penMm = armour penetration in mm; cal = calibre in mm
const MGS = {
  mg34:    { name: 'MG 34',    dmg: 0.22, pen: 0.5, reload: 0.09, spread: 0.07, spd: 1.15, range: 0.85, clip: 50, mag: 4,   penMm: 8,  cal: 7.9 },   // 50-round belt drum
  dt:      { name: 'DT',       dmg: 0.2,  pen: 0.5, reload: 0.1,  spread: 0.07, spd: 1.15, range: 0.85, clip: 63, mag: 4.5, penMm: 8,  cal: 7.9 },   // 63-round pan
  dshk:    { name: 'DShK',     dmg: 0.38, pen: 0.9, reload: 0.13, spread: 0.06, spd: 1.2,  range: 0.95, clip: 50, mag: 5,   penMm: 20, cal: 12.7 },  // 50-round belt box
  breda38: { name: 'Breda 38', dmg: 0.2,  pen: 0.5, reload: 0.12, spread: 0.07, spd: 1.1,  range: 0.85, clip: 24, mag: 3.5, penMm: 8,  cal: 7.9 },   // 24-round box
  m1919:   { name: 'M1919',    dmg: 0.2,  pen: 0.5, reload: 0.1,  spread: 0.07, spd: 1.15, range: 0.85, clip: 50, mag: 4,   penMm: 8,  cal: 7.9 },   // .30 cal belt
  m2hb:    { name: 'M2 .50',   dmg: 0.38, pen: 0.9, reload: 0.12, spread: 0.06, spd: 1.2,  range: 0.95, clip: 50, mag: 5,   penMm: 20, cal: 12.7 },  // .50 cal belt
  besa:    { name: 'BESA',     dmg: 0.21, pen: 0.5, reload: 0.09, spread: 0.07, spd: 1.15, range: 0.85, clip: 50, mag: 4,   penMm: 8,  cal: 7.9 },   // 7.92mm belt
};

// ---- handling and main gun stats, for shared.js to merge into the vehicle definitions ----
const VEHICLE_DEFAULTS = { speed: 1, hp: 1, traverse: 3, fov: 1, ram: 1, capture: 1 };
const GUN_DEFAULTS = { reload: 1, dmg: 1, spd: 1, pen: 1, spread: 0.03, range: 1, recoil: 1, splash: 0, clip: 0, cycle: 0 };
// { vehicle: {speed, hp, traverse, fov, ram, capture[, steer]}, gun: {...}, cal } for a vehicle id
function statsOf(id) {
  const v = VEHICLES[id] || {}, vehicle = {};
  for (const k in VEHICLE_DEFAULTS) vehicle[k] = v[k] !== undefined ? v[k] : VEHICLE_DEFAULTS[k];
  if (v.steer) vehicle.steer = v.steer;
  return { vehicle, gun: Object.assign({}, GUN_DEFAULTS, v.gun), cal: v.cal || 0 };
}

// [front, side, rear] armour in mm for a vehicle id (null if it has none)
const armorOf = id => (VEHICLES[id] && VEHICLES[id].armor) || null;
// main gun penetration in mm for a vehicle id (null if it has none)
const penOf = id => (VEHICLES[id] && VEHICLES[id].pen) || null;
// front plate slope in degrees (0 if unknown)
const slopeOf = id => (VEHICLES[id] ? VEHICLES[id].slope || 0 : 0);
// APCR: how much more it penetrates than the gun's AP round (unless a vehicle gives its own apcrPen)
const APCR_PEN = 1.4;
const apcrPenOf = id => (VEHICLES[id] && VEHICLES[id].pen ? VEHICLES[id].apcrPen || Math.round(VEHICLES[id].pen * APCR_PEN) : null);
// main gun load: { total, apcr } (AP = total - apcr)
const ammoOf = id => (VEHICLES[id] ? { total: VEHICLES[id].ammo || 60, apcr: VEHICLES[id].apcr || 0 } : { total: 60, apcr: 0 });

// ---- components: hidden health pools inside every vehicle ----
// hp: share of the vehicle's max hp; repair: seconds until a destroyed one works again (twice as fast inside
// a capture zone your side holds or at your rear area). Where they sit and what hits them is in game.js (hitParts).
const COMPONENTS = {
  tracks: { name: 'Tracks',     hp: 0.25, repair: 10 },   // destroyed: immobilised (the turret still works)
  engine: { name: 'Engine',     hp: 0.25, repair: 20 },   // destroyed: ENGINE_SPEED top speed, ENGINE_TURN hull turning
  ammo:   { name: 'Ammo rack',  hp: 0.25, repair: 20, burst: 0.15, fx: 4 },   // destroyed: guns reload AMMO_RELOAD times slower
  fuel:   { name: 'Fuel tank',  hp: 0.20, repair: 15, burst: 0.12, fx: 4 },
};
const COMPONENT_IDS = Object.keys(COMPONENTS);
const ENGINE_SPEED = 0.3, ENGINE_TURN = 0.5, AMMO_RELOAD = 2;
// burst: share of the vehicle's max hp dealt once, on the hit that destroys the component (no damage over
// time). fx: seconds of effect after it's destroyed: a fuel tank burns on the side that was hit, an ammo rack
// cooks off, throwing sparks out of that side.

// logistics: the most load a player can carry (seconds), and a vehicle's cost (0 if it has none)
const LOGI_LIMIT = 600;
const logiOf = id => (VEHICLES[id] ? VEHICLES[id].logi || 0 : 0);

const ARMOR = { VEHICLES, MGS, COMPONENTS, COMPONENT_IDS, ENGINE_SPEED, ENGINE_TURN, AMMO_RELOAD, VEHICLE_DEFAULTS, GUN_DEFAULTS, statsOf, armorOf, penOf, slopeOf, APCR_PEN, apcrPenOf, ammoOf, LOGI_LIMIT, logiOf };
if (typeof module !== 'undefined' && module.exports) module.exports = ARMOR;
else root.ZARMOR = ARMOR;
})(typeof self !== 'undefined' ? self : this);
