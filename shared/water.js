/* ZITADELLE — rivers: where the water is, keeping vehicles out of it, and finding a bridge across.
   Pure geometry on the river that mapgen.js lays out ({ pts: centreline, hw: half width, bridges: [{ x, y, i, hw }] },
   where a bridge's i is the centreline segment it sits on and hw its half width along the river).
   Shells fly over water; only vehicles care. Works on any map; a map without a river gets a no-op version. */
(function (root) {
'use strict';

function makeWater(river) {
  if (!river || !river.pts || river.pts.length < 2) {
    return { river: null, hit: () => false, collide: () => {}, route: () => null };
  }
  const { pts, hw, bridges } = river;
  // nearest point on the centreline: segment index, along-segment unit tangent, signed distance across
  function nearest(x, y) {
    let best = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      const qx = ax + dx * t, qy = ay + dy * t, d = Math.hypot(x - qx, y - qy);
      if (!best || d < best.d) {
        const l = Math.sqrt(l2), tx = dx / l, ty = dy / l;
        best = { i, d, qx, qy, tx, ty, side: (x - qx) * -ty + (y - qy) * tx >= 0 ? 1 : -1 };
      }
    }
    return best;
  }
  // the bridge whose deck covers (x, y), if any (with a margin r for the vehicle's width)
  function bridgeAt(x, y, r = 0) {
    for (const b of bridges) {
      const [ax, ay] = pts[b.i], [bx, by] = pts[b.i + 1], l = Math.hypot(bx - ax, by - ay) || 1, tx = (bx - ax) / l, ty = (by - ay) / l;
      const along = (x - b.x) * tx + (y - b.y) * ty, across = (x - b.x) * -ty + (y - b.y) * tx;
      if (Math.abs(along) < b.hw - r && Math.abs(across) < hw + 60) return b;
    }
    return null;
  }
  // is a circle of radius r at (x, y) in the water (and not on a bridge)?
  const hit = (x, y, r = 0) => { const n = nearest(x, y); return n.d < hw + r && !bridgeAt(x, y, r * 0.5); };
  // push a vehicle {x, y} of radius r back onto the bank it came from (or onto the bridge it's on)
  function collide(o, r) {
    const n = nearest(o.x, o.y);
    if (n.d >= hw + r) return;
    const b = bridgeAt(o.x, o.y);
    if (b) {   // on a bridge: keep the tracks on the deck
      const [ax, ay] = pts[b.i], [bx, by] = pts[b.i + 1], l = Math.hypot(bx - ax, by - ay) || 1, tx = (bx - ax) / l, ty = (by - ay) / l;
      const along = (o.x - b.x) * tx + (o.y - b.y) * ty, lim = Math.max(4, b.hw - r);
      if (Math.abs(along) > lim) { const k = Math.sign(along) * lim - along; o.x += tx * k; o.y += ty * k; }
      return;
    }
    const nx = -n.ty * n.side, ny = n.tx * n.side, k = hw + r - n.d;
    o.x += nx * k; o.y += ny * k;
  }
  // does the straight drive from p to q cross open water? Returns the crossing point or null
  function crossing(px, py, qx, qy) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const d = (qx - px) * (by - ay) - (qy - py) * (bx - ax);
      if (!d) continue;
      const u = ((ax - px) * (by - ay) - (ay - py) * (bx - ax)) / d, v = ((ax - px) * (qy - py) - (ay - py) * (qx - px)) / d;
      if (u > 0 && u < 1 && v >= 0 && v <= 1) {
        const x = px + (qx - px) * u, y = py + (qy - py) * u;
        if (!bridgeAt(x, y, 20)) return { x, y };
      }
    }
    return null;
  }
  // Where to drive to get from p to q: null if the way is dry, otherwise the near end of the best bridge,
  // then (once there) its far end.
  function route(px, py, qx, qy) {
    if (!crossing(px, py, qx, qy) || !bridges.length) return null;
    let best = null, bd = Infinity;
    for (const b of bridges) { const d = Math.hypot(b.x - px, b.y - py) + Math.hypot(qx - b.x, qy - b.y); if (d < bd) { bd = d; best = b; } }
    const [ax, ay] = pts[best.i], [bx, by] = pts[best.i + 1], l = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / l, ny = (bx - ax) / l, s = (px - best.x) * nx + (py - best.y) * ny >= 0 ? 1 : -1, off = hw + 160;
    const near = { x: best.x + nx * s * off, y: best.y + ny * s * off }, far = { x: best.x - nx * s * off, y: best.y - ny * s * off };
    const onDeck = bridgeAt(px, py) || Math.hypot(px - best.x, py - best.y) < hw + 40;
    return onDeck || Math.hypot(px - near.x, py - near.y) < 140 ? far : near;
  }
  return { river, hit, collide, route };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { makeWater };
else root.ZWATER = { makeWater };
})(typeof self !== 'undefined' ? self : this);
