/* ZITADELLE — woods: which ground is forest, and what that does to vehicles.
   Pure geometry on the forests mapgen.js lays out ([{ x, y, r, pts: outline }]). Inside a wood vehicles go
   slower and are hard to spot; shells still pass through. A map without forests gets a no-op version. */
(function (root) {
'use strict';

const SPEED = 0.6;   // top speed in the woods, as a fraction
const HIDE = 2.5;    // bots spot a vehicle in the woods only within 1/HIDE of their usual range

function inRing(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function makeForests(forests) {
  const list = forests || [];
  // the wood containing (x, y), or null
  const at = (x, y) => {
    for (const f of list) if (Math.hypot(x - f.x, y - f.y) < f.r * 1.25 && inRing(f.pts, x, y)) return f;
    return null;
  };
  const inside = (x, y) => !!at(x, y);
  return { list, at, inside, speed: (x, y) => (inside(x, y) ? SPEED : 1), HIDE };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { makeForests, SPEED, HIDE };
else root.ZFOREST = { makeForests, SPEED, HIDE };
})(typeof self !== 'undefined' ? self : this);
