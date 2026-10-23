# SM64 Daily Parkour

`/sm64daily/` — a new Super Mario 64 obstacle course every day, built over a
different SM64 world from the game's own pieces, with a saved best run, a
Wordle-style share line and a ghost link to race.

## Build

The game is the [sm64-port](https://github.com/sm64-port/sm64-port) decomp
(commit `2b17d08`) plus `sm64-port-daily.patch` (web build fixes + `src/game/daily.c`):

```bash
git clone https://github.com/sm64-port/sm64-port && cd sm64-port && git checkout 2b17d08
git apply <repo>/sm64daily/sm64-port-daily.patch
cp <your US ROM> baserom.us.z64
source <repo>/emsdk/emsdk_env.sh
gmake TARGET_WEB=1 VERSION=us AS=x86_64-elf-as OBJCOPY=x86_64-elf-objcopy -j8
cp build/us_web/sm64.us.js build/us_web/sm64.us.wasm <repo>/sm64daily/
```

`sm64.us.js` / `sm64.us.wasm` are gitignored: the decomp links the game's
assets into the module, the same reason `n64/sm64-native/` is ignored.

## Tests (need the devserver)

- `node sm64daily/test_page.mjs` — boots, warps through every station, checks the finish card, share line and stored best.
- `node sm64daily/test_walk.mjs` — Mario must stand on every station and stay on it while running (caught the collision-overwrite bug).
- `node sm64daily/test_ghost.mjs` — saved run -> ghost link -> friend's page announces the ghost.

Query params: `?date=YYYY-MM-DD` (another day's course), `?host=N` (force a world).
