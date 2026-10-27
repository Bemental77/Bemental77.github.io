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

The README used to say `sm64.us.js` / `sm64.us.wasm` are gitignored. They are
tracked (the site serves them from here), and the wasm links the game's assets
from the ROM, which is the reason `n64/sm64-native/` is ignored.

### The shipped binary is not a clean build

The `.wasm` in this folder carries one **binary patch** (below), and the `.js` glue carries one
**hand edit**. A rebuild from `sm64-port-daily.patch` replaces both with the proper source fix, and
`patch_wiggler_orphans.mjs` is then unnecessary.

| What | Where | Why |
|---|---|---|
| Orphan guard in `bhv_wiggler_body_part_update` | `sm64.us.wasm` (applied by `patch_wiggler_orphans.mjs`); same guard in the source patch, `src/game/behaviors/wiggler.inc.c` | The freeze on the Wiggler boss day, below |
| Stack-canary repair instead of abort | `sm64.us.js`, `checkStackCookie()` (marked `SM64 DAILY PARKOUR`) | Defence in depth: the build checks a canary at address 4..11 after every frame and aborted on a harmless write into the unused bottom of the 64 KB stack. Now it repairs the canary, counts in `Module.strayWrites` and warns |
| Crash card | `index.html`, `Module.onAbort` | A wasm abort used to leave the last frame on screen with no message |
| `?v=2` on the script and wasm | `index.html` | Pages caches both; bump it when either changes |

### The Wiggler freeze (fixed 2026-10-26)

Symptom: on a Wiggler day the page froze mid-fight. In the console: `Aborted(Stack overflow! Stack cookie has been overwritten at 0x00000004 ... received 0x00bacdfe 0x02135467)`.

Cause: `daily.c` replaces every enemy on a respawn (Mario dies, the run restarts, a boss thrown off the arena), but the Wiggler head's three `bhvWigglerBody` objects are separate objects and survive. They keep running
`bhv_wiggler_body_part_update`, which reads `o->parentObj->oWigglerSegments`. When the dead head's slot is handed to another object (the new head's own first body part gets it), that field is 0, and the orphans write floats and angles through NULL over addresses `0 .. 79`, on top of the canary.
The write was never a real stack overflow: sampled stack depth stays under ~37 KB of 64 KB.

Fix: a body part whose parent is NULL, deactivated or no longer a `bhvWigglerHead` deletes itself.
Observed with the repair switched off: across 10 cycles and 6 head replacements the orphans all deactivate, the dead stack stays zero and the canary stays intact. Other enemies with child objects (the chain chomp's chain parts, the Pokey's body parts) are built the same way and are **not** checked.

## Tests (need the devserver)

- `node sm64daily/test_page.mjs` — boots, warps through every station, checks the finish card, share line and stored best.
- `node sm64daily/test_walk.mjs` — Mario must stand on every station and stay on it while running (caught the collision-overwrite bug).
- `node sm64daily/test_ghost.mjs` — saved run -> ghost link -> friend's page announces the ghost.
- `node sm64daily/test_wiggler_respawn.mjs` — the Wiggler freeze: stomp, die and respawn 12 times, then assert the dead stack is all zero, the canary is intact and the module has not aborted. It needs no puppeteer (bare CDP, `CHROME=...` to point at a browser). On the pre-fix wasm it fails (20 stray bytes, 220 repairs); on the shipped one it passes.

Query params: `?date=YYYY-MM-DD` (another day's course), `?host=N` (force a world).
