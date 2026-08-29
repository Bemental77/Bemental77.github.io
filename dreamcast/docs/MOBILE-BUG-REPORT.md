# Capturing a mobile failure on dreamcast.html

The original report — *"the dreamcast does not even render a character on mobile … it then
freezes with this black and green screen after the character"* — has never been reproduced.
Under Puppeteer device emulation the page renders the character-creation model at 30 fps with
`stencil=true`, zero incomplete FBOs, zero swallowed `GL_INVALID_ENUM` and a canvas that is
0.00–0.01 % green. Emulation cannot cover the real GPU driver, the real memory ceiling, iOS
Safari's engine, or thermal behaviour, so the report is **neither reproduced nor disproven.**

Six failure modes that each produce that exact symptom have been removed (see the end of this
file). This document exists because the seventh will only ever be seen on his device, and there
will be **one chance to capture it.**

---

## For the person with the phone — do this, in this order

1. **Open the page normally.** `https://<site>/dreamcast.html` — not from a saved link with
   extra `?` parameters on it, and not in a private window (service workers are blocked there
   and the page needs one).
2. **Before pressing Start, tap the small `🩺 Diagnostics` link under the Start button.**
   Tap **Share report** and send it. This is the *baseline*: it captures the device, the GPU,
   whether WebGL2 exists and whether the **stencil buffer** was granted — all before anything
   can go wrong. Even if the rest of the run goes perfectly, send this one.
3. **Close it, press Start, and let it run** until the failure happens (or for a couple of
   minutes if it does not).
4. **When it fails, tap `🩺 Diagnostics` again** — from the `≡` menu if the game has started,
   or from the red banner if one appeared. Tap **Share report** and send it. If the panel
   opened by itself, it already has the failure in it; just share it.
   - If **Share** is blocked, tap **Copy** and paste into a message.
   - If **Copy** is blocked too, screenshot the panel **starting at the top** — the top block
     is the part that matters.
5. **Say what you saw in your own words**, and at what point: the SEGA logo, the Serial Number
   screen, character creation, in-game. The report knows *how far the code got*; only you know
   *what was on the screen.*

That is the whole protocol. Two shared reports plus one sentence.

### If it never gets that far

- **Nothing loads / the page flashes and reloads.** It gives up after three reloads and
  explains itself. Share whatever page you end up on.
- **Any full-screen error page.** They all have a **Share report** button. Use it.
- **The screen is black but the sound is playing.** That is the interesting one — tap the
  screen once, then get the report.

### Retries worth trying, one at a time, only after step 4

Each of these changes one thing. Send a report for each you try, and say which one it was.

| Add to the end of the address | What it tests |
|---|---|
| `?lazydisc=1` | Streams the 1.13 GB disc instead of loading it into RAM. **Try this first if it dies during loading** — the default path asks the phone for one contiguous 1,131 MB buffer. |
| `?maxmem=512` | Asks for a much smaller emulator heap. |
| `?nomodvol=1` | Turns modifier volumes off. **If this fixes a black picture, the stencil path is the bug.** |
| `?nofog=1` | Turns fog off. |
| `?noglprobe=1` | Skips the page's own GPU probe, in case the probe itself is the problem. |

---

## For whoever reads the report

The report is plain text and starts with a `>>` headline naming the most likely cause. Read the
`--- VERDICT ---` block first; everything below it is supporting evidence.

**Highest-signal fields, in order:**

1. `stencil granted` — **the prime suspect.** Flycast drives modifier volumes entirely through
   the stencil buffer, and the black-out quad at `core/rend/gl4/gldraw.cpp:573-578` paints the
   whole frame if the plane is not doing its job. A frame that goes black *after* geometry has
   been drawn, with telemetry still reading `guest 1.000x / 30 fps`, is what that looks like.
   The field is resolved from the page's own probe if it ran, otherwise from the worker's
   `[glinfo] granted attrs` line, and it is labelled with which.
2. `depth-stencil in use` — which of `GL_DEPTH24_STENCIL8` / `GL_DEPTH32F_STENCIL8` this driver
   will actually be handed, and whether an FBO with it **completes**. `gles.cpp` sets
   `gl.mali = !stricmp(GL_VENDOR, "arm")` and `gl4/gldraw.cpp` picks the format from that flag,
   so only one of the two matters on a given device. Granting the stencil *attribute* does not
   imply the driver will complete a depth-stencil *framebuffer*; both are measured.
3. `WebGL2 (page)` — measured by the page itself, on every load, before anything can fail. If
   the worker never got far enough to emit `[glinfo]`, this is the only GPU evidence there is.
   When the attribute set is refused but a plain context works, it says so.
4. `heap` — which rung of the memory ladder was actually granted. A silently-shrunk heap that
   later aborts on growth is the hardest failure to report from a phone.
5. `boot reached` + `--- BOOT MILESTONES ---` — how far it got, timestamped. A freeze before
   the first frame and a freeze after the character are indistinguishable in a screenshot of a
   log tail; they are not indistinguishable here.
6. `counters` — `incompleteFBO`, `glcompat` (swallowed `GL_INVALID_ENUM`), `ctxLost`,
   `pageError`, `stall`.

**What the page now refuses to fail silently at.** Each of these used to be console-only, and a
phone user cannot open a console:

- any uncaught error or unhandled promise rejection (`window.onerror` /
  `unhandledrejection`, rate-limited so a per-frame throw cannot flood);
- the emulator producing no video, no *distinct* frames, or no telemetry at all once it has
  started — three separately-named stalls, edge-triggered, backgrounding excluded;
- WebGL context loss, which is **permanent** here (Flycast does not rebuild its GL objects on
  restore) — it raises a banner that does not auto-hide, because the emulator keeps running and
  reporting healthy numbers behind a black canvas;
- an incomplete framebuffer reaching the renderer;
- the disc-load acknowledgement never arriving (was an unbounded wait; now 120 s then an error);
- the 1,131 MB contiguous disc allocation being refused, named as such with the `?lazydisc=1`
  escape hatch;
- audio failing to initialise, or an `AudioContext` stuck `suspended` after `resume()`;
- `Element.requestFullscreen` not existing at all — which is the case on iPhone Safari.

---

## Known-stale link script — READ BEFORE RELINKING THE WORKER

Verified 2026-08-29 by reading both files and parsing the memory import out of both shipped
`.wasm` binaries:

| File | `-sINITIAL_MEMORY` | |
|---|---|---|
| `Dev/dreamcastHtml/dreamcast/flycast-bridge/flycast_worker_link.sh:362` | `134217728` (128 MB) | correct |
| `Bemental77.github.io/dreamcast/flycast-bridge/flycast_worker_link.sh:231` | `536870912` (512 MB) | **STALE** |

Both shipped `flycast_worker_emcc.wasm` files declare
`IMPORT memory a.a shared=true initial=2048 pages (128 MB) maximum=65536 pages (4096 MB)`,
which matches `MODULE_MIN_MB = 128` in `dreamcast.html`.

The Bemental77 copy is an older revision of the script entirely (275 lines vs 485; it still
hardcodes `ROOT=/Users/caseybement/...`). **Relinking from that copy raises the module's declared
minimum to 512 MB while `MODULE_MIN_MB` stays 128**, so the memory the page provides fails import
matching and the shim reports `factory rejected` — every boot dies, and on a phone it dies as a
silent hang on *"Waiting for emulator runtime…"*. Link from the Dev copy, or fix the Bemental77
copy first. If the declared minimum ever does change, `MODULE_MIN_MB` must change with it.

---

## Already fixed — do not re-diagnose these

Each of these independently produced the reported symptom, and each is gone:

1. `transferControlToOffscreen()` called unguarded at top level — a `TypeError` there killed the
   whole IIFE **including the mobile shell**, leaving a phone on the dead desktop layout.
2. `DecompressionStream` is Safari 16.4+, so older iOS could not inflate the boot seed and
   cold-booted to the Serial Number screen — **it never reached a character.** There is now an
   embedded DEFLATE decoder, verified against the real 8,595,603 B seed to a matching SHA-256.
3. Touch controls occluding the canvas on every viewport tested.
4. `#mobileLog` (z 2500) covering `#mobileBottom` (z 10), so a force-shown log hid its own
   dismiss button.
5. The 4096 → 2048 MB reduction landing **on** the value iOS is known to refuse
   (emscripten-core/emscripten#19144) — now a ladder.
6. An unbounded COI reload loop. *(Its bound depended on `sessionStorage`, which throws in the
   very configurations that block the service worker; it now falls back to `window.name` and
   then to the URL.)*
7. `#rotateHint` covering a running emulator with no `orientationchange` listener.

## Honest scope

None of the above fixes the original report. Everything in this document is instrumentation:
it does not make the emulator work on his phone, it makes the next failure **reportable**.
The page-side WebGL2 probe, the stencil/FBO verdict, the stall detector and the export path are
verified by reading and by a Node harness driving the real code with stubbed DOM and GL; none of
them has been exercised on a physical iOS device.
