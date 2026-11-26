# Zitadelle

A top-down multiplayer tank game set during Operation Citadel (Kursk, July 1943).

## Run

```
npm install
npm start
```

Open http://localhost:3000. Other people on your network can join at `http://<your-ip>:3000`.

- `PORT=4000 npm start` uses a different port.

## Gameplay

Two attack lines. Germany attacks and the Soviet Union defends on an 8000×8000 map. Line **A** (A5 Bykovka → A4 → A3 → A2 → A1 Oktyabrsky) runs along the north-west, line **B** (B5 Belenikhino → … → B1 Storozhevoye) along the south-east, and both meet at **O1** (Prokhorovka). Each side has to split its forces between them.
- There are no crates, fuel drums or supply depots any more; the villages are the only cover.
- Every objective sits in a village, and about two dozen smaller farmsteads are scattered along the front. Houses, barns, ruins and Prokhorovka's church are solid: they block vehicles and stop shells and MG fire, so use them as cover. Gardens, orchards and bushes are only decoration. The villages are generated from a fixed seed in `shared/shared.js`, so the server and every client build the same map.

- At the start the attacker holds A5 and B5, the defender holds O1, and every other point is neutral. A side can only fight for a point next to one it holds: the attacker works up each line from X5, the defender works down from O1 (O1 can be attacked once A1 or B1 is German). Other points are locked (shown with a padlock). Each side can always retake its own starting points.
- If the defenders take **X5**, that line is **defeated**: it locks for the rest of the battle and its rear assembly area is lost. The attacker wins by taking O1. The defender wins when both lines are defeated.
- Zones have a 400-unit radius. Whichever side has more vehicles in a zone pushes its progress their way, as long as it may fight for that point or already owns it. A one-vehicle edge takes ~12 s from neutral; a two- or three-vehicle edge is faster. A held point must be neutralized first. Equal numbers freeze it.
- Only your own side's names are shown over vehicles; enemy crews are anonymous. Names carry a rank insignia (German shoulder straps and chevrons, Soviet 1943 pogony). Bots have fixed ranks. Players start as Unteroffizier / Starshiy Serzhant and are promoted as their score in the current battle grows (300 / 800 / 1600 / 3000). Ranks are purely cosmetic.
- The kill feed (top right) shows each crew's insignia and their vehicle in brackets.
- **Reserves.** Each side has a limited pool per category: light tanks, medium tanks, heavy tanks, tank destroyers and heavy tank destroyers (Germany 0 / 200 / 60 / 100 / 40, Soviet Union 60 / 200 / 50 / 70 / 30, see `RESERVES` and `CAT` in `shared/shared.js`). Every deployment uses one vehicle of its category; empty categories can't be picked. A side that has used up its reserves and has nothing left on the field loses. Both sides' remaining reserves are shown at the top. A new battle starts 30 s after one ends. That break is the only time you can switch sides: press **T**, or use *Switch sides* on the knocked-out screen.
- Pick any vehicle of your side before deploying (and again after each knock-out). For now only gun vehicles are available; MG/autocannon and rocket vehicles are switched off by `GUNS_ONLY` in `shared/shared.js`. There are no levels or upgrades: every vehicle uses fixed stats from its definition. Score (kills 100, captures 150, neutralizations 50) and kills/deaths reset each battle.
- There are no HQ zones. When knocked out you can redeploy at a rear assembly area or at any held objective with no enemies nearby. Rear areas offer no protection or extra repairs, and the attacker has one behind each line. Defenders can't deploy on a point being fought over or one right behind it. If the point you picked is under attack when you deploy, you go to the next safe point back along your own line (toward X5 for the attacker, toward O1 for the defender), and only to the rear area if there is none.
- Controls are hull-relative: **A/D** steer the hull, **W/S** drive forward/reverse along it, mouse aims the turret, **F** toggles autofire, the **scroll wheel** zooms in (up to ×2.5; never out past the normal view; a Shift gunner's sight exists but is switched off by `SIGHT_ENABLED` in `public/client.js`), **right mouse** fires every secondary MG that can bear on the cursor. Mounts (see `MG_FIT` in `shared/shared.js`): **bow** ball mounts in the hull front (~±25°, aim by steering; the T-44's is fixed), **rear turret** ball mounts on the KV-1S, KV-85 and IS-2 (~±20° facing backward), and free-swinging **roof** pintles (MG 34 on German tanks, DShK on IS-2 / ISU-152). Each mount rides with whatever it's bolted to. A thin grey aim line runs out from the muzzle along where the gun is actually laid (to the cursor's range); it's amber while the turret is still traversing, and turns red and stops with an ✕ where a building blocks the shot. Shells and MG rounds are drawn as tracers (red for Soviet, orange-yellow for German). Casemate tank destroyers have only a ±11° gun arc, so you aim them by rotating the hull.
- Steering depends on the transmission (`steer` in `shared/shared.js`): **neutral** (Tiger, Tiger II, Panther, Jagdpanther, Jagdtiger, Sturmtiger, Ferdinand) pivot in place at full rate; **clutch** (all other tracked vehicles) only swing slowly around a braked track when stopped, creeping forward, and turn properly once moving; **wheel** (halftracks, trucks) can't turn while stationary and steer inverted in reverse.
- Vehicles are heavy: accelerate slowly, reverse at half speed, and are less accurate on the move. Main guns reload ~3× slower than the arcade original but hit harder. Damaged vehicles slowly patch themselves up, faster once out of combat for a while.

Music lives in `public/music/` (the songs themselves are not in the repository; add your own files), and the `MUSIC` table at the top of `server/server.js` says which file plays where (mp3, ogg, wav or m4a). Germany: intro *Haselnuss* (`haselnuss.mp3`), victory *Erika* (`erika.mp3`). Soviet Union: intro *Let's Go* (`lets_go.mp3`), victory *Invincible and Legendary* (`invincible_and_legendary.mp3`). When a battle ends everyone hears the winning side's victory song. Your own side's intro plays when each new battle starts, taking over from the victory song, and on your first deployment if you join a battle that is already under way. (Intro songs are currently switched off by `INTRO_ENABLED` in `public/client.js`.) **M** mutes all of it. A missing file is simply skipped.

All tuning constants (attacker/defender, objectives, reserves, capture time, reload/damage multipliers, traverse) live at the top of `shared/shared.js`.

## Layout

| Path | Role |
|---|---|
| `shared/shared.js` | Constants, objectives, all vehicle (with roles) and obstacle definitions. Loaded by both server and browser. |
| `server/game.js` | Authoritative simulation: movement, firing, collisions, armour, the attack chain, score, bots, per-client snapshots. |
| `server/server.js` | HTTP static server and WebSocket server, 60 Hz tick loop, 30 Hz snapshots. |
| `public/client.js` | Browser: input, snapshot interpolation, effects, rendering, HUD, menus. |

## Protocol (JSON over WebSocket)

Client → server: `join {name, team, c, sp}`, `in {th, rot, ax, ay, f, m}`, `respawn {team, sp, c}` (`c` = vehicle id, `sp` = point index, or -1-k for rear assembly area k), `leave`, `view {w, h}`, `ping {c}`.

Server → client: `welcome`, `pong`, and `s` snapshots containing tanks (all), bullets and obstacles (near the player only), events (shots, hits, explosions, kills, captures `cp`, battle end/start `re`/`rn`, reload-ready `rd`, personal messages), objective state `cp` (`[prog, owner, contested, active, de count, su count, attacker may take, defender may take]` per point), defeated lines `ln`, both sides' reserves `rs` and battle phase `ph` (every snapshot), the player's own state including score, rank, kills, deaths and reload progress `rl`.

The client renders 100 ms behind the newest snapshot and interpolates between snapshots. Effects such as particles, sounds and track marks are generated locally from server events.
