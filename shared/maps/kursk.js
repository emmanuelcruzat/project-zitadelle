/* Map: Kursk. Operation Citadel, July 1943: two lines across the steppe converging on Prokhorovka.
   Data only; shared/mapgen.js turns it into a battlefield. Format: see the top of mapgen.js. */
(function (root) {
'use strict';
const MAP = {
  id: 'kursk', name: 'Kursk', terrain: 'steppe', seed: 1943,
  attacker: 'de', defender: 'su',
  lineT: [0, 0.2, 0.4, 0.6, 0.78], bow: 650,
  goals: [{ id: 'O1', name: 'Prokhorovka', x: 6300, y: 1700, r: 600, capScale: 2, church: true }],
  lines: [
    { id: 'A', from: { x: 900, y: 4400 }, goal: 'O1', bow: -1, names: ['Bykovka', 'Yakovlevo', 'Pokrovka', 'Teterevino', 'Oktyabrsky'] },
    { id: 'B', from: { x: 3600, y: 7100 }, goal: 'O1', bow: 1, names: ['Belenikhino', 'Leski', 'Shakhovo', 'Vinogradovka', 'Storozhevoye'] },
  ],
  defRears: [{ x: 6950, y: 1050 }],
  farmsteads: 24,
  // a few woods in the gullies of the steppe
  forests: { count: 7, size: [350, 650] },
  // shell craters cluster along the front: the bottom-left / top-right diagonal
  craters: { along: [[0, 8000], [8000, 0]], spread: 1800 },
  attackerWins: 'breaks through to Prokhorovka',
};
if (typeof module !== 'undefined' && module.exports) module.exports = MAP;
else (root.ZMAPS = root.ZMAPS || {})[MAP.id] = MAP;
})(typeof self !== 'undefined' ? self : this);
