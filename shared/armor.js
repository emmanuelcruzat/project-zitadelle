/* ZITADELLE — armour and penetration data, loaded by both the Node server and the browser client.
 *
 * Pure data keyed by vehicle id (the ids in shared.js). Nothing here depends on the rest of the game, and
 * the vehicle definitions don't depend on it: systems that need armour read it from here.
 *
 *   armor: [front, side, rear]   hull plate thickness in mm
 *   slope: degrees               angle of the upper front plate from vertical (0 = flat, 60 = steeply sloped)
 *   pen:   mm                    main gun penetration with its standard armour-piercing (AP) round at ~500 m
 *   ammo:  rounds                main gun rounds carried
 *   apcr:  rounds                how many of those are APCR (tungsten-cored, faster: more penetration, less
 *                                damage); 0 if the gun had none. Optional apcrPen overrides pen x APCR_PEN.
 *
 * Values are approximate historical figures rounded for the game, not a reference.
 */
(function (root) {
'use strict';

const VEHICLES = {
  // ---- Germany ----
  pz2c:        { armor: [30, 15, 15],    slope: 10, pen: 23, ammo: 180, apcr: 30 },    // 20mm KwK 30
  pz38t:       { armor: [50, 30, 15],    slope: 15, pen: 41, ammo: 90, apcr: 12 },    // 37mm KwK 38(t)
  luchs:       { armor: [30, 20, 20],    slope: 15, pen: 25, ammo: 330, apcr: 40 },    // 20mm KwK 38
  pz3:         { armor: [70, 30, 50],    slope: 10, pen: 61, ammo: 92, apcr: 12 },    // 50mm KwK 39 L/60 (spaced front)
  pz4:         { armor: [80, 30, 20],    slope: 10, pen: 91, ammo: 87, apcr: 8 },    // 75mm KwK 40 L/48
  hetzer:      { armor: [60, 20, 8],     slope: 60, pen: 91, ammo: 41, apcr: 6 },    // 75mm PaK 39 L/48
  stug:        { armor: [80, 30, 50],    slope: 10, pen: 91, ammo: 54, apcr: 6 },    // 75mm StuK 40 L/48
  jgpz4:       { armor: [80, 40, 20],    slope: 50, pen: 124, ammo: 55, apcr: 8 },   // 75mm PaK 42 L/70
  tiger:       { armor: [100, 80, 80],   slope: 10, pen: 110, ammo: 92, apcr: 8 },   // 88mm KwK 36 L/56
  panther:     { armor: [80, 40, 40],    slope: 55, pen: 124, ammo: 79, apcr: 6 },   // 75mm KwK 42 L/70
  jagdpanther: { armor: [80, 50, 40],    slope: 55, pen: 185, ammo: 57, apcr: 6 },   // 88mm PaK 43 L/71
  ferdinand:   { armor: [200, 80, 80],   slope: 10, pen: 185, ammo: 50, apcr: 6 },   // 88mm PaK 43 L/71
  brummbaer:   { armor: [100, 50, 20],   slope: 30, pen: 120, ammo: 38, apcr: 0 },   // 150mm StuH 43 (shaped charge)
  tiger2:      { armor: [150, 80, 80],   slope: 50, pen: 185, ammo: 86, apcr: 6 },   // 88mm KwK 43 L/71
  jagdtiger:   { armor: [150, 80, 80],   slope: 50, pen: 212, ammo: 40, apcr: 4 },   // 128mm PaK 44 L/55

  // ---- Soviet Union ----
  t26:         { armor: [15, 15, 15],    slope: 15, pen: 43, ammo: 165, apcr: 20 },    // 45mm 20-K
  bt7:         { armor: [22, 13, 13],    slope: 20, pen: 43, ammo: 132, apcr: 16 },    // 45mm 20-K
  t70:         { armor: [45, 15, 25],    slope: 30, pen: 43, ammo: 90, apcr: 12 },    // 45mm 20-K
  t28:         { armor: [30, 20, 20],    slope: 15, pen: 35, ammo: 70, apcr: 0 },    // 76mm KT-28 (short)
  t34:         { armor: [45, 40, 40],    slope: 60, pen: 61, ammo: 77, apcr: 8 },    // 76mm F-34
  t3485:       { armor: [45, 45, 45],    slope: 60, pen: 102, ammo: 56, apcr: 6 },   // 85mm ZiS-S-53
  kv1s:        { armor: [75, 60, 60],    slope: 25, pen: 61, ammo: 114, apcr: 10 },    // 76mm ZiS-5
  kv85:        { armor: [75, 60, 60],    slope: 25, pen: 102, ammo: 70, apcr: 6 },   // 85mm D-5T
  is2:         { armor: [120, 90, 60],   slope: 60, pen: 142, ammo: 28, apcr: 0 },   // 122mm D-25T
  su76:        { armor: [25, 15, 15],    slope: 30, pen: 61, ammo: 60, apcr: 6 },    // 76mm ZiS-3
  su85:        { armor: [45, 45, 40],    slope: 50, pen: 102, ammo: 48, apcr: 6 },   // 85mm D-5S
  su100:       { armor: [75, 45, 45],    slope: 50, pen: 162, ammo: 33, apcr: 4 },   // 100mm D-10S
  su122:       { armor: [45, 45, 40],    slope: 50, pen: 100, ammo: 40, apcr: 0 },   // 122mm M-30S (shaped charge)
  su152:       { armor: [75, 60, 60],    slope: 25, pen: 125, ammo: 20, apcr: 0 },   // 152mm ML-20S
  isu152:      { armor: [90, 90, 60],    slope: 30, pen: 125, ammo: 21, apcr: 0 },   // 152mm ML-20S

  // ---- Italy (not playable yet) ----
  l640:        { armor: [30, 15, 15],    slope: 10, pen: 24, ammo: 296, apcr: 30 },    // 20mm Breda 35
  m1340:       { armor: [30, 25, 25],    slope: 15, pen: 43, ammo: 104, apcr: 10 },    // 47mm 47/32
  p2640:       { armor: [50, 45, 40],    slope: 40, pen: 70, ammo: 65, apcr: 6 },    // 75mm 75/34
  sem7518:     { armor: [50, 25, 25],    slope: 20, pen: 70, ammo: 44, apcr: 0 },    // 75mm 75/18 (shaped charge)

  // ---- United States (not playable yet) ----
  m3stuart:    { armor: [38, 25, 25],    slope: 20, pen: 46, ammo: 103, apcr: 10 },    // 37mm M6
  m4sherman:   { armor: [51, 38, 38],    slope: 56, pen: 76, ammo: 97, apcr: 6 },    // 75mm M3
  m26:         { armor: [102, 76, 51],   slope: 46, pen: 147, ammo: 70, apcr: 6 },   // 90mm M3
  m10:         { armor: [51, 19, 19],    slope: 55, pen: 99, ammo: 54, apcr: 6 },    // 3-inch M7

  // ---- United Kingdom (not playable yet) ----
  tetrarch:    { armor: [16, 14, 14],    slope: 10, pen: 52, ammo: 50, apcr: 8 },    // 2-pounder
  cromwell:    { armor: [76, 32, 32],    slope: 0,  pen: 68, ammo: 64, apcr: 6 },    // 75mm OQF
  churchill:   { armor: [152, 95, 50],   slope: 0,  pen: 68, ammo: 84, apcr: 6 },    // 75mm OQF
  achilles:    { armor: [51, 19, 19],    slope: 55, pen: 171, ammo: 50, apcr: 8 },   // 17-pounder
};

// [front, side, rear] armour in mm for a vehicle id (null if it has no entry)
const armorOf = id => (VEHICLES[id] ? VEHICLES[id].armor : null);
// main gun penetration in mm for a vehicle id (null if it has no entry)
const penOf = id => (VEHICLES[id] ? VEHICLES[id].pen : null);
// front plate slope in degrees (0 if unknown)
const slopeOf = id => (VEHICLES[id] ? VEHICLES[id].slope || 0 : 0);
// APCR: how much more it penetrates than the gun's AP round (unless a vehicle gives its own apcrPen)
const APCR_PEN = 1.4;
const apcrPenOf = id => (VEHICLES[id] ? VEHICLES[id].apcrPen || Math.round(VEHICLES[id].pen * APCR_PEN) : null);
// main gun load: { total, apcr } (AP = total - apcr)
const ammoOf = id => (VEHICLES[id] ? { total: VEHICLES[id].ammo || 60, apcr: VEHICLES[id].apcr || 0 } : { total: 60, apcr: 0 });

const ARMOR = { VEHICLES, armorOf, penOf, slopeOf, APCR_PEN, apcrPenOf, ammoOf };
if (typeof module !== 'undefined' && module.exports) module.exports = ARMOR;
else root.ZARMOR = ARMOR;
})(typeof self !== 'undefined' ? self : this);
