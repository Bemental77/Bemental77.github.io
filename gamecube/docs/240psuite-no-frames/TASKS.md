# "gamecube.html renders nothing" is WRONG — it is 240pSuite specifically

## The correction

An agent reported gamecube.html producing no picture at all, from a control run
with no netplay: 120 s of `published=0 shown=0`, 0 lit pixels, status reaching
`render: NO FIRST FRAME ⚠`. That was measured on **240pSuite** (`ROM_IDX=3`).

Re-measured on a REAL GAME, same page, same build, same flags
(`PROBE_VANILLA_WEBGPU=1`, canonical probe):

| ROM_IDX | title | published/s | non-black |
|---|---|---|---|
| 3 | 240pSuite | **0.00/s** | **0 / 337,920** |
| 1 | Sonic Adventure 2 Battle | **13.76/s** | **306,453 / 307,200 (99.8%)** |

So the page, the WebGPU path and the present seqlock all work. The fault is
title-specific.

⚠ This matters beyond the bug itself: `gamecube_multiplayer.html` was built while
the belief "gamecube.html renders nothing" was live, and its test VOIDs its
picture claims because of it. Those claims can be made against a real game.

## What the failing case actually says

The page's own diagnosis on the 240pSuite arm, verbatim:

    render: WebGPU ✓ -> render: NO FIRST FRAME ⚠ — WebGPU was acquired and the
    emulator was started 60s ago, but not one frame has ever reached the canvas.
    The WGPU backend is not publishing to the shared-heap present seqlock
    (0x026B3518). This is an emulator fault, not a GPU-capability one — the
    browser CAN do WebGPU here.

That is correct as far as it goes; the missing qualifier is "for this title".

⚠ Do NOT read the SAB number as a performance result. 13.76 published/s is
consistent with the known execution deficit recorded in CLAUDE.md (the JIT runs
~0.34x of a 486 MHz Gekko), not with anything about the renderer.

## Next

240pSuite is a homebrew test-pattern suite, so it exercises a very different path
from a retail title (no standard boot sequence, direct GX writes). Whether it is
worth fixing is a product call — nothing a visitor plays depends on it — but
"GameCube does not render" should not be repeated, because it is not true.
