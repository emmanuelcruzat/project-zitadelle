/* Map: Town. A town attacked from every side: six lines come in through farmland and suburbs, two into each of
   three objectives in the town centre. The closer to the centre, the denser the buildings. A river runs in from
   the west through the north of town, bends east, then turns north out of the map; both lines into the Town Hall
   have to cross it, one in the streets and one out in the fields.
   Each battle only some of the lines are open.
   Data only; shared/mapgen.js turns it into a battlefield. Format: see the top of mapgen.js. */
(function (root) {
'use strict';
const WORLD = 12000, C = WORLD / 2;
const at = (ang, r) => ({ x: Math.round(C + Math.cos(ang * Math.PI / 180) * r), y: Math.round(C + Math.sin(ang * Math.PI / 180) * r) });

// the three objectives around the centre, each at its own bearing and distance (degrees: 0 = east, 90 = south)
const goals = [
  { id: 'O1', name: 'Town Hall', ang: -97, r: 850, landmark: { kind: 'block', w: 230, h: 150 } },
  { id: 'O2', name: 'Railway Station', ang: 18, r: 880, landmark: { kind: 'barn', w: 300, h: 95 } },
  { id: 'O3', name: 'Cathedral', ang: 158, r: 1060, church: true },
].map(g => Object.assign({ id: g.id, name: g.name, r: 450, capScale: 1.5, church: g.church, landmark: g.landmark }, at(g.ang, g.r)));

// six lines, two per objective, each with its own bearing, start distance and bend, so no two approaches look alike.
// [id, bearing of the start, start distance, goal, bend side, bend amount, names: farm -> suburbs -> edge of the centre]
const lines = [
  ['A', -137, 4700, 'O1', -1, 520, ['Hillside Farm', 'Old Mill', 'Water Tower']],
  ['B', -52, 5300, 'O1', 1, 220, ['Orchard Farm', 'Brickworks', 'Cemetery']],
  ['C', -8, 4400, 'O2', -1, 460, ['River Farm', 'Sawmill', 'Freight Yard']],
  ['D', 74, 5200, 'O2', 1, 180, ['Poplar Farm', 'Sugar Factory', 'Tram Depot']],
  ['E', 112, 4600, 'O3', -1, 420, ['Windmill Farm', 'Tannery', 'Barracks']],
  ['F', 197, 5000, 'O3', 1, 300, ['Dairy Farm', 'Gasworks', 'Hospital']],
].map(([id, ang, dist, goal, bow, bowAmp, names]) => ({ id, goal, bow, bowAmp, names, from: at(ang, dist) }));

const MAP = {
  id: 'town', name: 'Town', terrain: 'town', seed: 1942, world: WORLD,
  attacker: 'de', defender: 'su',
  lineT: [0, 0.34, 0.63], bow: 380, goals, lines,
  openLines: [2, 4],
  defRears: [{ x: C, y: C }],
  // in from the west, through the northern edge of town between the Water Tower (A1) and the Town Hall, on under
  // the Cemetery (B1), then north through open country between the Brickworks and Orchard Farm and out the north edge
  river: { width: 230, pts: [[0, 3450], [1300, 3700], [2600, 3550], [3800, 4050], [4700, 4500], [5470, 4540], [6356, 4500], [7400, 4350],
    [8450, 3750], [8950, 3000], [8585, 2325], [8100, 1500], [7750, 650], [7850, 0]] },
  // the town: avenues, rings and side streets out to r, built up solid inside core
  city: { x: C, y: C, r: 3300, core: 1900 },
  farmsteads: 26,
  forests: { count: 16, size: [420, 950] },
  // shell craters in a ring through the suburbs, where the fighting meets the town
  craters: { ring: { x: C, y: C, r0: 1600, r1: 4000 }, count: 700 },
  attackerWins: 'takes the town centre',
};
if (typeof module !== 'undefined' && module.exports) module.exports = MAP;
else (root.ZMAPS = root.ZMAPS || {})[MAP.id] = MAP;
})(typeof self !== 'undefined' ? self : this);
