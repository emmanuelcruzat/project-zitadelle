/* ZITADELLE — HTTP + WebSocket server. Run with: npm start */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { TICK_RATE, SNAP_RATE, CLASS_IDS } = require('../shared/shared.js');
const { createGame } = require('./game.js');

const PORT = Number(process.env.PORT) || 3000;
const DEV = process.env.ZITADELLE_DEV === '1';
const ROOT = path.join(__dirname, '..');

// Only these files are served — no directory traversal possible.
const FILES = {
  '/':           ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/style.css':  ['public/style.css', 'text/css; charset=utf-8'],
  '/client.js':  ['public/client.js', 'application/javascript; charset=utf-8'],
  '/shared.js':  ['shared/shared.js', 'application/javascript; charset=utf-8'],
};

// Music in public/music/. Map each slot to a file name there; only these files are ever served.
const MUSIC = {
  'intro-de':   'haselnuss.mp3',
  'victory-de': 'erika.mp3',
  'intro-su':   'lets_go.mp3',
  'victory-su': 'invincible_and_legendary.mp3',
};
const MUSIC_TYPES = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4' };
// /music/<slot> -> [file, content type]
function musicFile(url) {
  const m = /^\/music\/([a-z]+-(?:de|su))$/.exec(url);
  const name = m && MUSIC[m[1]];
  if (!name) return null;
  const ext = name.split('.').pop().toLowerCase();
  return MUSIC_TYPES[ext] ? ['public/music/' + name, MUSIC_TYPES[ext]] : null;
}
// which slots have a file present, e.g. { 'victory-de': 'music/victory-de', ... } (the client asks once)
function musicList() {
  const out = {};
  for (const key in MUSIC) if (musicFile('/music/' + key) && fs.existsSync(path.join(ROOT, 'public/music', MUSIC[key]))) out[key] = 'music/' + key;
  return out;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/music.json' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(musicList()));
    return;
  }
  const f = FILES[url] || musicFile(url);
  if (!f || req.method !== 'GET') { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
  fs.readFile(path.join(ROOT, f[0]), (err, data) => {
    if (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500); res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error'); return; }
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const game = createGame({ dev: DEV });
const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 });
const clientOf = new WeakMap(); // ws -> client record

wss.on('connection', ws => {
  const client = { ws, msgs: 0 };
  clientOf.set(ws, client);
  game.addClient(client);
  // roster: vehicles go over the wire by index, so the client checks it has the same list in the same order
  ws.send(JSON.stringify({ t: 'welcome', dev: DEV, tickRate: TICK_RATE, snapRate: SNAP_RATE, roster: CLASS_IDS.join(',') }));

  ws.on('message', data => {
    if (++client.msgs > 120) return; // crude flood guard: max ~120 msgs per second
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m && m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', c: m.c })); return; }
    game.handle(client, m);
  });
  ws.on('close', () => game.removeClient(client));
  ws.on('error', () => {});
});

// ---------- fixed-timestep loop ----------
const DT = 1 / TICK_RATE;
const TICKS_PER_SNAP = Math.round(TICK_RATE / SNAP_RATE);
const BOARD_EVERY = 15; // leaderboard every 15 snapshots (~0.5 s)
let last = process.hrtime.bigint();
let acc = 0, tick = 0, snaps = 0;

setInterval(() => {
  const now = process.hrtime.bigint();
  acc = Math.min(acc + Number(now - last) / 1e9, 0.25);
  last = now;
  while (acc >= DT) {
    game.step(DT);
    acc -= DT;
    if (++tick % TICKS_PER_SNAP === 0) broadcast();
  }
}, 4);

function broadcast() {
  const board = ++snaps % BOARD_EVERY === 1;
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const client = clientOf.get(ws);
    if (!client) continue;
    if (ws.bufferedAmount > 512 * 1024) continue; // slow connection: skip a frame rather than queue forever
    ws.send(JSON.stringify(game.snapshotFor(client, board)));
  }
  game.endSnapshotRound();
}

setInterval(() => { for (const ws of wss.clients) { const c = clientOf.get(ws); if (c) c.msgs = 0; } }, 1000);

server.listen(PORT, () => {
  console.log(`Zitadelle server running — open http://localhost:${PORT}${DEV ? '  (dev mode)' : ''}`);
});
