/* Server-side registry of every map in this folder: { id: definition }. Browsers never load this; the server
   sends them only the map in play (see /map.js in server/server.js). To add a map, drop a file next to this one. */
'use strict';
const fs = require('fs');
const path = require('path');

const MAPS = {};
for (const f of fs.readdirSync(__dirname)) {
  if (f === 'index.js' || !f.endsWith('.js')) continue;
  const def = require(path.join(__dirname, f));
  MAPS[def.id] = Object.assign({ file: f }, def);
}
module.exports = MAPS;
