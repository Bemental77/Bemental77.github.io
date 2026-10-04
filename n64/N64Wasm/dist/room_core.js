// room_core.js — THE N64 ROOM DRIVER, shared by the page and the core worker.
//
// Moved out of n64/index.html (where the design comments of the room as a whole
// still sit, above the call sites) so that a room runs ONE implementation whether
// the core lives on the page (?worker=0, and the automatic fallback) or in
// core_worker.js: the lockstep feed, the 1.000x governor, rollback (snapshots,
// re-simulation, GLSKIP, run-ahead), the exact in-memory savestates, the
// fingerprints handed to the engine, the pre-roll and the arm/disarm order. Every
// one of those decides which inputs a guest frame runs with or which bytes a
// snapshot holds, so two copies that drifted apart would be two different consoles.
//
// The text is the page's, with exactly these edits:
//   * `window.` and bare `Module.` -> `G.` / `G.Module.` (the realm it is installed
//     in: the page's window or the worker's self);
//   * everything only the page can know comes through `env` — the query string,
//     the log, the engine, whether this console is in a room and is its host, the
//     local pads (env.packLocal(k): the k-th local seat's 4 wire bytes), the audio
//     delivery (pump / read position / drop), the canvas, the ring budget (decided
//     by the page: a worker's navigator differs), and the two page-only arming
//     hooks (key listeners, the context-lost listener);
//   * env.oneFramePerTask: where the canvas is committed per task (the worker's
//     OffscreenCanvas) the feed presents at most one frame per task and env.kick()s
//     the next — task boundaries only, every frame runs with the input it had;
//   * a (frame, fingerprint) ring of the presented frames, for rigs.
//
//   __n64InstallRoomCore(G, env) -> R   (once per realm; installs G.__n64State)
(function (root) {
  'use strict';
  root.__n64InstallRoomCore = function (G, env) {
    if (G.__n64RoomCore) return G.__n64RoomCore;
    var FPR_N = 128, FPR = { f: new Int32Array(FPR_N), v: new Uint32Array(FPR_N), n: 0 };
    var LS = {
      armed: false,       // the core has been put into lockstep mode
      running: false,     // ...and the barrier released, so this page is feeding
      frame: 0,           // frames this core has actually run under the gate
      fed: 0,             // frames handed to the core (== frame; the core is synchronous)
      hashes: 0,          // fingerprints handed to the engine
      hashSink: null,     // null = untested, true = submitHash/endFrame took it
      stalling: false, waitingOn: [], stallReason: null,
      stalls: 0, stallMs: 0, stallSince: 0,
      fault: null,        // why this machine is NOT frame-gated, in words
      armedAtFrame: null, // the engine frame when the gate closed — latched, never sampled
      startedAt: null,    // the frame everyone started together at — latched as the gate engages
      baseWall: 0, baseFrame: 0,   // the 1.000x governor's anchor
      reanchors: 0,       // times debt was DISCARDED rather than sprinted through
      viHz: 0,            // from the ROM header; 0 = unknown, and then we do not pace
      lastFp: 0,
    };

    // ---- this machine's OWN pad, in the room's wire format --------------------
    // ⚠ THE WIRE FORMAT IS SHARED WITH n64_multiplayer.html — do not drift.
    // 4 bytes per port:
    //   byte 0   buttons  0..7   (0 UP 1 DOWN 2 LEFT 3 RIGHT 4 A 5 B 6 START 7 Z)
    //   byte 1   buttons  8..13  (8 L 9 R 10 C-UP 11 C-DOWN 12 C-LEFT 13 C-RIGHT)
    //   byte 2   stick X, signed  (+ = right)
    //   byte 3   stick Y, signed  (+ = UP, the page's own stickVec convention;
    //                              the core negates it, exactly as
    //                              neil_send_mobile_controls does)
    // The button order is neil_send_mobile_controls' 14-character control string
    // order, so the page, the lobby and the core all agree by construction.
    //
    // ⚠ 8 BITS PER AXIS IS NOT A ROUNDING SHORTCUT. Almost nothing on this console
    // walks on the d-pad — Mario, Banjo, Zelda and every kart are on the stick —
    // so a digital-only pad would look connected and be unable to take a step.
    var LS_PAD_BYTES = 4;
    var LSN = { up: 0, down: 1, left: 2, right: 3, a: 4, b: 5, start: 6, z: 7,
                l: 8, r: 9, cup: 10, cdown: 11, cleft: 12, cright: 13 };

    // ⚠ THE KEYBOARD IS NOT PORT 0 ANY MORE. It is whichever port the ROOM gave
    // this player: somebody told they are Player 3 has to drive Player 3's kart.
    // The engine places these at port*padBytes in the image it builds, so the
    // re-mapping happens in exactly one place.
    function lsLocalPads() {
      var ls = env.engine();
      // ⚠ NEVER FALL BACK TO PORT 0 INSIDE A ROOM. A console whose seat is not
      // known yet would write its pad into PORT 0 — ANOTHER PLAYER'S controller.
      // This shipped on Dreamcast and the user hit it immediately: "player 2 took
      // over as player 1! wtf, it def should not do that." The same line was
      // present here, on N64, unchanged.
      //
      // It is a reachable state, not a theoretical one — lib/netplay.js documents
      // a path where `localPorts` stays EMPTY. Defaulting that to port 0 makes the
      // failure mode of "I do not know which player I am" into "act as Player 1",
      // which is the worst available guess: it fights the real Player 1 for their
      // own character, on their own screen.
      //
      // In a room, no seat means NO PAD. A solo console (no session) still uses
      // port 0, because there it is not a guess — it is the only port.
      var inRoom = !!env.inRoom();
      var known = (ls && ls.localPorts && ls.localPorts.length) ? ls.localPorts : null;
      // ⚠ A HOST WITH AN UNKNOWN SEAT IS NOT GUESSING — a GUEST is.
      // Suppressing the pad for BOTH broke the host's own input: the auditor
      // caught `the-press-reaches-the-pressers-own-core — host core was handed
      // 0x0 at its own port 0`. The host seats ITSELF first, lowest-free-first
      // (lib/netplay.js _ensureLockstep -> seat), so its port is 0 by
      // construction and port 0 is the right answer for it even in the window
      // before localPorts has populated. A JOINER has no such guarantee, and a
      // joiner assuming port 0 is exactly what made Player 2 take over Player 1's
      // character. So the rule is asymmetric on purpose: no seat means no pad for
      // a guest, and port 0 for a host.
      var isHostSide = !!env.isHost();
      if (!known && inRoom && !isHostSide) return {};
      var ports = known || [0];
      var out = {};
      // TEST SEAM (n64/tools/n64_rollback_probe.mjs): a scripted pad that is a
      // pure function of the engine frame, so a straight reference run can be
      // given exactly the input this console played. Absent unless a rig sets it.
      if (G.__n64PadOverride && ls) {
        ports.forEach(function (port) { out[port] = G.__n64PadOverride(ls.frame | 0, port); });
        return out;
      }
      ports.forEach(function (port, k) { out[port] = env.packLocal(k); });
      return out;
    }

    // ---- running exactly one agreed frame --------------------------------------
    function lsApplyImage(img) {
      var M = G.Module;
      if (!M || !M._neil_ls_set_pad) return false;
      var n = Math.floor(img.length / LS_PAD_BYTES);
      for (var p = 0; p < n && p < 4; p++) {
        var o = p * LS_PAD_BYTES;
        var mask = img[o] | (img[o + 1] << 8);
        // Signed bytes back out, then scaled into the core's own +/-32000 units —
        // the same scale neil_send_mobile_controls uses, so the two input paths
        // cannot disagree about deflection.
        var sx = (img[o + 2] << 24) >> 24;
        var sy = (img[o + 3] << 24) >> 24;
        M._neil_ls_set_pad(p, mask, Math.round(sx / 127 * 32000), Math.round(sy / 127 * 32000));
      }
      return true;
    }
    // THE 1.000x GOVERNOR. See the gate #9 note in this block's header: lifting the
    // core's own wall-clock frame gate for a lockstep frame removed the only thing
    // pacing this guest, so the pacing lives here instead. viHz comes from the ROM
    // header and is never defaulted — with an unreadable header this returns true
    // and the room runs at whatever rate the feed achieves, which is stated in the
    // report rather than hidden behind a guessed 60.
    // ?lsrepay=MS — A MEASUREMENT ARM, OFF BY DEFAULT. How much debt a console may
    // run back to its 1.000x schedule (never ahead of it) after a stall or a late
    // frame. The shipped value is two field periods (below); gate #9 governs any
    // change to the default. Exists so the cost of NOT repaying can be measured
    // on the real page (n64/tools/party_ghost_probe.mjs --query lsrepay=400).
    var LS_REPAY_MS = Math.max(0, +(new URLSearchParams(env.search).get('lsrepay') || 0) || 0);
    // ?lsdrive=raf|timer|all — WHICH DRIVERS may run a lockstep frame. A
    // measurement arm; 'all' (rAF + 4 ms timer + input-arrival kick) is the
    // shipped default.
    var LS_DRIVE = (new URLSearchParams(env.search).get('lsdrive') || 'all');
    function lsDriveOk(src) { return LS_DRIVE === 'all' || LS_DRIVE === src; }
    function lsDueNow() {
      if (!(LS.viHz > 0)) return true;
      var now = performance.now();
      if (!LS.baseWall) { LS.baseWall = now; LS.baseFrame = LS.frame; return true; }
      // rbPace() (adaptive rollback room): a multiplier just under 1 while this
      // console leads a peer that cannot close the gap — a SLOWER period, the
      // one direction gate 9 allows. 1 everywhere else.
      var period = 1000 / LS.viHz / ((LS.pace > 0 && LS.pace <= 1) ? LS.pace : 1);
      var due = LS.baseWall + ((LS.frame - LS.baseFrame) * period);
      if (now < due) return false;
      // ⚠ TIME LOST IS NEVER REPAID, AND THIS IS THE LINE THAT ENFORCES IT.
      // Without it, a machine that fell behind (a stall, a slow frame, a
      // backgrounded tab) would find `due` far in the past and this function
      // would keep returning true, so the feed loop would run frame after frame
      // back-to-back until it caught up — a CATCH-UP SPRINT, i.e. the guest
      // running FASTER than 1.000x. That is precisely what CLAUDE.md gate #9
      // forbids, and it is how a "120 fps" claim once got manufactured out of a
      // 2x fast-forward. Debt older than a couple of frames is DISCARDED by
      // re-anchoring: the guest resumes at exactly 1.000x from here, and the
      // seconds lost stay lost — which is correct, because every machine in the
      // room lost them.
      // ONLY THE PART OLDER THAN THE ALLOWANCE IS DISCARDED (2026-10-04). Lateness up to
      // two periods has always been run off back to back (the loop below runs every frame
      // due); it re-anchored at `now` and dropped the allowance too, so a frame 34 ms late
      // lost 34 ms where 33 ms lost nothing — two periods more per stall than this rule,
      // invisible as a slow frame. Now the schedule keeps exactly the allowance: the burst
      // after any stall is the burst after a 2-period one (3 frames), never more.
      var keep = Math.max(period * 2, LS_REPAY_MS);
      if (now - due > keep) {
        // The debt being discarded is time this console LOST WITHOUT WAITING — a
        // frame that ran late on this device. Counted, and published to the room
        // (ls.selfLostMs), so a late-running device is named as such.
        LS.lostMs = (LS.lostMs || 0) + (now - due - keep);
        LS.baseWall = now - keep; LS.baseFrame = LS.frame; LS.reanchors++;
      }
      return true;
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // EXACT SAVESTATES IN MEMORY — what rollback and run-ahead stand on.
    //
    // The core exports one savestate pair, _neil_serialize / _neil_unserialize
    // (libretronew.c neil_serialize/neil_unserialize): savestates_save_m64p into
    // the static 16.8 MB `savestate_buffer`, then gzip it to MEMFS
    // /savestate.gz; the load gunzips that file back into the buffer and runs
    // savestates_load_m64p on it. The gzip is the whole cost (a full-state
    // deflate, per save) and nothing about exactness depends on it, so for the
    // raw path '/savestate.gz' is made a DIRECTORY for the duration of one call:
    // gzopen() then fails (EISDIR), gzwrite/gzread/gzclose on a NULL or failed
    // stream return without touching the buffer (zlib checks), and what is left
    // is exactly savestates_save_m64p / savestates_load_m64p on
    // `savestate_buffer` — whose address is found once, by its own header
    // ("M64+SAVE", version 0x00010000, the ROM's 32-hex-digit MD5), right after
    // the first save. The load's return value is savestates_load_m64p's, so a
    // corrupt or foreign buffer is refused (magic / version / MD5), not loaded.
    // myApp.SaveStateEvent (the IndexedDB upload of /savestate.gz) and the core's
    // printf("save state") are silenced for these calls only; a player's own
    // Save State button is untouched (the directory exists only inside a call,
    // and a player's /savestate.gz is moved aside and back around it).
    //
    // ⚠ This is the SAME exact state the Save State button writes — nothing is
    // added or left out — so whatever it does not capture (the video plugin's
    // own caches) is not captured here either; n64/tools/n64_rollback_probe.mjs
    // measures whether a loaded state re-runs bit-for-bit (full-state hash, RDRAM
    // included) before this is trusted with a room.
    //
    // ⚠ Swap to neil_state_save_raw / neil_state_load_raw (or whatever the core
    // track lands in n64/N64Wasm/dist) when they exist: n64sCall() is the one
    // place that would change.
    // ═══════════════════════════════════════════════════════════════════════════
    // Rollback / run-ahead audio: everything real frames produced goes to the
    // output first; what the re-run frames then produce is skipped. The fallback
    // ScriptProcessor path (no AudioWorklet) has no pump to drain, so a re-run
    // there skips from wherever it had read to — a short gap, never a repeat.
    // REALM HOOKS: env.audioPump() delivers everything the core has produced so far to the
    // output; env.audioReadPos() is where that delivery has read to; env.audioDrop() moves the
    // read position to the core's write position, discarding what is in between unplayed.
    function audioFlushNow() { try { env.audioPump(); } catch (e) {} }
    // Samples dropped this way, in ring entries: the rate meter's audio witness
    // reads the core's write position, and re-simulated / hidden frames move it
    // without one sample of them being played — so they are subtracted
    // (MEASURED before this: a rollback room at 0.935x read "speed 1.276x").
    var AUDX = { dropped: 0 };
    function audioDropNow() {
      try {
        var rp = env.audioReadPos();
        if (rp === null) return;
        if (G.Module && G.Module._neilGetAudioWritePosition && typeof rp === 'number')
          AUDX.dropped = (AUDX.dropped + ((G.Module._neilGetAudioWritePosition() - rp + 64000) % 64000)) % 64000;
        env.audioDrop();
      } catch (e) {}
    }
    var N64S = { ptr: 0, size: 16788288 + 1024, located: false, fault: null, quiet: false, smPtr: 0,
                 saves: 0, loads: 0, saveMs: 0, loadMs: 0, maxSaveMs: 0, maxLoadMs: 0,
                 codeKept: 0, codeDropped: 0, keepLoads: 0 };
    // ?keepcode=0: every load pays the full recompile (the control arm for n64sCodeKeep).
    var N64S_KEEP_CODE = new URLSearchParams(env.search).get('keepcode') !== '0';
    // savestates.c savestates_save_m64p's layout: 448 B of registers, 8 MB RDRAM,
    // then SP mem + PIF + flashram, 2 x 4 MB tlb_LUT, then CPU/TLB/PC/queue.
    var N64S_RDRAM = 0x800000, N64S_HDR = 448, N64S_SPPIF = 8192 + 64 + 24, N64S_LUT = 0x800000;
    function n64sGz(off) {
      var FS = G.Module && G.Module.FS; if (!FS) return false;
      if (off) {
        var st = null; try { st = FS.stat('/savestate.gz'); } catch (e) {}
        if (st && FS.isDir(st.mode)) return true;
        if (st) FS.rename('/savestate.gz', '/savestate.gz.user');
        FS.mkdir('/savestate.gz');
      } else {
        try { FS.rmdir('/savestate.gz'); } catch (e) {}
        try { FS.stat('/savestate.gz.user'); FS.rename('/savestate.gz.user', '/savestate.gz'); } catch (e) {}
      }
      return true;
    }
    function n64sLocate() {
      var H = G.Module.HEAPU8, n = (H.length >>> 2) - 16, u32 = new Uint32Array(H.buffer, 0, n);
      for (var i = 0; i < n; i++) {
        if (u32[i] !== 0x2B34364D) continue;                                       // "M64+"
        var o = i << 2;
        if (H[o + 4] !== 0x53 || H[o + 5] !== 0x41 || H[o + 6] !== 0x56 || H[o + 7] !== 0x45) continue;   // "SAVE"
        if (H[o + 8] !== 0 || H[o + 9] !== 1 || H[o + 10] !== 0 || H[o + 11] !== 0) continue;             // 0x00010000
        var hex = true;
        for (var k = 12; k < 44 && hex; k++) { var c = H[o + k]; hex = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }
        if (hex && o + N64S.size <= H.length) return o;
      }
      return 0;
    }
    // ⚠ NOTHING HERE ALLOCATES PER CALL (it runs on every snapshot): no closure
    // per call, and the heap views below are made once and re-made only when
    // the heap's buffer changes (memory growth).
    function n64sNop() {}
    function n64sCall(load) {
      var app = G.myApp, ev = app && app.SaveStateEvent, r = 0, M = G.Module;
      if (app) app.SaveStateEvent = n64sNop;
      N64S.quiet = true;
      try { n64sGz(true); r = (load ? M._neil_unserialize() : M._neil_serialize()) | 0; }
      finally { n64sGz(false); N64S.quiet = false; if (app) app.SaveStateEvent = ev; }
      return r;
    }
    function n64sView() {
      var H = G.Module.HEAPU8, v = N64S.view;
      if (!v || v.buffer !== H.buffer) v = N64S.view = H.subarray(N64S.ptr, N64S.ptr + N64S.size);
      return v;
    }
    function n64sSmView() {
      var H = G.Module.HEAPU8, v = N64S.smView;
      if (!v || v.buffer !== H.buffer) v = N64S.smView = H.subarray(N64S.smPtr, N64S.smPtr + N64S_SM);
      return v;
    }
    // The bytes after the event queue's 0xFFFFFFFF terminator are never written
    // by a save (the queue is variable-length), so they are zeroed before each
    // one: a slot is then a pure function of the guest state, on every console.
    function n64sZeroTail() { G.Module.HEAPU8.fill(0, N64S.ptr + N64S.size - 2048, N64S.ptr + N64S.size); }
    // ⚠ THE SAVESTATE LEAVES OUT THE CARTRIDGE'S SAVE MEMORY — and a game writes
    // it while it plays. savestates_save_m64p captures RDRAM, RSP, CPU, TLB and
    // the event queue, but not `saved_memory` (EEPROM, the four controller paks,
    // SRAM, FlashRAM: libretro_memory.h). MEASURED: Mario Kart 64 rewrites its
    // EEPROM every few frames from frame 80 to 206 of a fresh boot (it formats
    // it), and a rollback across those writes left the re-simulated console
    // reading the FUTURE's EEPROM — n64_rollback_probe diverged from a straight
    // run at exactly frame 210, rollback on or adaptive, every time. So each slot
    // carries those 290 KB too (eeprom 2 KB + paks 128 KB + SRAM 32 KB + flash
    // 128 KB, one contiguous struct), restored with the state. The struct is
    // found by its own layout: the core formats each controller pak with the
    // fixed header format_mempak writes (si/mempak.c: 81 01 02 03 04 05 06 07
    // ...), four of them 32 KB apart, the EEPROM 2 KB before the first; the
    // EEPROM is cross-checked against the core's own export (neil_export_eep).
    // A room boots with fresh save memory (LoadSram is neutered in a room), so
    // the headers are there to be found.
    var N64S_SM = 0x800 + 4 * 0x8000 + 0x8000 + 0x20000;
    function n64sLocateSaveMem() {
      var M = G.Module, H = M.HEAPU8, n = H.length - N64S_SM - 8;
      var sig = [0x81, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07];
      var ok = function (o) { for (var i = 0; i < 8; i++) if (H[o + i] !== sig[i]) return false; return true; };
      var eep = null;
      try {
        var app = G.myApp, ev = app && app.ExportEepEvent;
        if (app) app.ExportEepEvent = function () {};
        N64S.quiet = true;
        try { M._neil_export_eep(); eep = M.FS.readFile('/game.eep'); } finally { N64S.quiet = false; if (app) app.ExportEepEvent = ev; }
      } catch (e) { eep = null; }
      var found = [];
      for (var o = H.indexOf(0x81, 0x800); o >= 0 && o < n; o = H.indexOf(0x81, o + 1)) {
        if (!ok(o) || !ok(o + 0x8000) || !ok(o + 0x10000) || !ok(o + 0x18000)) continue;
        var x = o - 0x800, same = true;
        if (eep && eep.length === 0x800) for (var k = 0; k < 0x800 && same; k++) same = H[x + k] === eep[k];
        if (same) found.push(x);
        if (found.length > 1) break;
      }
      return found.length === 1 ? found[0] : 0;
    }
    function n64sSaveMem(dst) {
      var H = G.Module.HEAPU8;
      if (!N64S.smPtr) {
        N64S.smPtr = n64sLocateSaveMem();
        if (!N64S.smPtr) { N64S.fault = 'the core\'s save memory (EEPROM/paks/SRAM/flash) was not found in its heap, so a rollback could not restore it'; return false; }
        env.log('[state] save memory (EEPROM, paks, SRAM, flash) at heap 0x' + N64S.smPtr.toString(16) + ': carried in every rollback slot');
      }
      dst.set(n64sSmView(), N64S.size);
      return true;
    }
    // ═══ THE RAW STATE API (core b4004b8: neil_state_*) ═══════════════════════
    // When the core exports it, every save and load goes through it instead of
    // neil_serialize + the /savestate.gz directory trick: one call each way, the
    // cartridge save memory, the LLE RSP, the RDP and the interpreter state the
    // m64p format drops are IN the state (no 512 MB heap scans), and the loader
    // invalidates only the code pages whose bytes changed (load mode 1). States
    // live IN THE WASM HEAP (_malloc), which is a fixed 512 MB shared with the
    // ROM: a slot that would leave the core less than N64S_RAW_RESERVE is never
    // taken (rbPick then thins), so the ring is sized to the ROM by construction.
    // Feature-detected; ?rawstate=0 keeps the legacy path (the control arm).
    // ⚠ A FAILED _malloc DOES NOT RETURN 0 IN THIS BUILD — it ABORTS the runtime
    // (TOTAL_MEMORY fixed, no growth: emscripten_resize_heap -> abort("OOM")).
    // MEASURED: allocating until refusal threw Aborted(OOM). So the page never
    // asks the heap for memory it may not have: it tracks the top of what it
    // allocated (dlmalloc carves a fresh large block from the top), takes a
    // slot only while the space above that top keeps N64S_RAW_RESERVE free for
    // the core's own allocations, and never hands a state buffer back to the
    // allocator — a freed one goes to a page-side pool and is reused.
    // ⚠ THE RESERVE IS COUNTED ON THE HEAP THE ALLOCATOR SEES, AND IT IS THE CORE'S GROWTH (2026-10-04).
    // It was counted from the top of the page's OWN buffers, which misses everything the core carves
    // above them, and 64 MB was less than the core goes on to allocate: MEASURED (n64_state_exact_probe,
    // a straight run, neil_heap_brk every 100 frames) Donkey Kong 64 starts at a break of 257-269 MB and
    // grows to 337 MB by frame ~1800, then holds (+80 MB, jit=off alike: the core, not the JIT). A
    // rollback room's ring took the heap down to the old reserve, the core's next malloc found nothing
    // — Aborted(OOM) inside frame ~1247 (the build has no heap growth; malloc aborts, never NULL) — and
    // the room ran that frame again from a half-run machine: the DK64 rollback-room desync at
    // 1247-1252, in every arm, with or without a single rollback. Now a slot is taken only while the
    // heap the allocator can still give (neil_heap_brk / neil_heap_free_below) keeps N64S_RAW_RESERVE
    // for the core, and a frame the core aborts in ends the room instead of being run again (rbStep).
    var N64S_RAW_RESERVE = 128 * 1048576;
    // What the core can still allocate: above the break, plus the free chunks below it. null: a core
    // without the exports (the old accounting then applies).
    function n64sHeapFree() {
      var M = G.Module;
      if (!M || typeof M._neil_heap_brk !== 'function' || typeof M._neil_heap_free_below !== 'function') return null;
      var above = M.HEAPU8.length - (M._neil_heap_brk() >>> 0);
      return { above: above, total: above + (M._neil_heap_free_below() >>> 0) };
    }
    function n64sRawOk() {
      if (N64S.raw != null) return N64S.raw;
      var M = G.Module;
      N64S.raw = !!(M && typeof M._neil_state_save_raw_fast === 'function' && typeof M._neil_state_load_raw === 'function'
                    && typeof M._neil_state_size === 'function' && typeof M._malloc === 'function' && typeof M._free === 'function')
                 && new URLSearchParams(env.search).get('rawstate') !== '0';
      if (N64S.raw) {
        N64S.size = M._neil_state_size() >>> 0;
        N64S.region = typeof M._neil_state_m64p_region === 'function' ? M._neil_state_m64p_region() >>> 0 : 16789504;
        env.log('[state] raw savestate API: ' + (N64S.size / 1048576).toFixed(1) + ' MB per state, in the wasm heap');
      }
      return N64S.raw;
    }
    // A state buffer in the wasm heap, or null when it would starve the core.
    function n64sRawRoom() {
      var hf = n64sHeapFree();
      // a new slot comes from above the break (dlmalloc carves a block that large from the top), and
      // what is left must keep the reserve: free chunks below the break count for the core, not for us
      if (hf) return Math.max(0, Math.min(hf.above, hf.total - N64S_RAW_RESERVE));
      var len = G.Module.HEAPU8.length, top = N64S.top || 0;
      return top ? Math.max(0, len - top - N64S_RAW_RESERVE) : len;
    }
    // How many more state buffers this heap can give without risking the core:
    // the pool, plus what fits above the top while keeping the reserve.
    function n64sRawCapacity() {
      return (N64S.pool ? N64S.pool.length : 0) + Math.floor(n64sRawRoom() / N64S.size);
    }
    function n64sRawAlloc() {
      var M = G.Module, v = N64S.pool && N64S.pool.length ? N64S.pool.pop() : null;
      if (v) { if (v.buffer !== M.HEAPU8.buffer) { var q = v.__ptr; v = M.HEAPU8.subarray(q, q + N64S.size); v.__ptr = q; } N64S.heapBufs++; return v; }
      if ((N64S.top || n64sHeapFree()) && n64sRawRoom() < N64S.size) return null;
      var p = M._malloc(N64S.size);
      if (!p) return null;
      N64S.top = Math.max(N64S.top || 0, p + N64S.size);
      v = M.HEAPU8.subarray(p, p + N64S.size);
      v.__ptr = p; N64S.heapBufs = (N64S.heapBufs | 0) + 1;
      return v;
    }
    function n64sFree(buf) {
      if (buf && buf.__ptr) { (N64S.pool || (N64S.pool = [])).push(buf); N64S.heapBufs--; }
    }
    function n64sRawSave(dst) {
      var M = G.Module, t0 = performance.now(), d = dst && dst.__ptr ? dst : null;
      if (!d) { d = N64S.scratch || (N64S.scratch = n64sRawAlloc()); if (!d) { N64S.fault = 'no wasm heap left for a savestate'; return false; } }
      if (!(M._neil_state_save_raw_fast(d.__ptr) | 0)) { N64S.fault = 'neil_state_save_raw refused'; return false; }
      if (dst && d !== dst) dst.set(d);
      N64S.located = true;
      var dt = performance.now() - t0;
      N64S.saves++; N64S.saveMs += dt; if (dt > N64S.maxSaveMs) N64S.maxSaveMs = dt;
      return true;
    }
    function n64sRawLoad(src) {
      var M = G.Module, t0 = performance.now(), s = src;
      if (!src.__ptr) {
        // A buffer the core did not write (a rig's copy): staged in a heap buffer
        // of its own — never one the fast save reuses.
        s = N64S.stage || (N64S.stage = n64sRawAlloc());
        if (!s) { N64S.fault = 'no wasm heap left to stage a load'; return false; }
        s.set(src.subarray(0, N64S.size));
      }
      if (!(M._neil_state_load_raw(s.__ptr) | 0)) { N64S.fault = 'neil_state_load_raw rejected the state (the machine is untouched)'; return false; }
      if (typeof M._neil_state_last_load_mode === 'function' && M._neil_state_last_load_mode() === 1) N64S.keepLoads++;
      var dt = performance.now() - t0;
      N64S.loads++; N64S.loadMs += dt; if (dt > N64S.maxLoadMs) N64S.maxLoadMs = dt;
      return true;
    }
    function n64sSave(dst) {
      if (n64sRawOk()) return n64sRawSave(dst);
      var M = G.Module, t0 = performance.now();
      if (N64S.located) n64sZeroTail();
      if (!n64sCall(false)) { N64S.fault = 'neil_serialize refused (savestates_save_m64p returned 0)'; return false; }
      if (!N64S.located) {
        var p = n64sLocate();
        if (!p) { N64S.fault = 'the core\'s savestate buffer was not found in its heap'; return false; }
        N64S.ptr = p; N64S.located = true;
        env.log('[state] exact savestate buffer at heap 0x' + p.toString(16) + ' (' + N64S.size + ' B): raw save/load, no gzip');
        n64sZeroTail();
        if (!n64sCall(false)) { N64S.fault = 'neil_serialize refused'; return false; }
      }
      if (dst) {
        dst.set(n64sView());
        if (!n64sSaveMem(dst)) return false;
      }
      var dt = performance.now() - t0;
      N64S.saves++; N64S.saveMs += dt; if (dt > N64S.maxSaveMs) N64S.maxSaveMs = dt;
      return true;
    }
    // ⚠ A LOAD THROWS AWAY EVERY COMPILED BLOCK, AND MOST OF THEM ARE STILL RIGHT.
    // savestates_load_set_pc ends in invalidate_r4300_cached_code(0,0), which
    // sets invalid_code[] for all 1 M pages (cached_interp.c:603-607), so every
    // block the game touches next is re-decoded and — with the JIT on — re-emitted
    // as a fresh WebAssembly module, synchronously. MEASURED (n64_state_exact_probe,
    // this box): the first frame after a load cost 47.8 ms p50 / 124 ms max against
    // ~1 ms for an ordinary frame, so a rollback cost ~150 ms and a room ran at
    // 0.54x. But a block compiled from a page is a pure function of that page's
    // bytes, and a rollback goes back a handful of frames: the code pages are
    // almost always the SAME bytes in the state being loaded. So, for the
    // directly mapped segments (KSEG0 0x80000000 and KSEG1 0xA0000000, where
    // this is exactly true — TLB-mapped pages are left invalidated, since their
    // mapping is part of the state), every page that held valid compiled code
    // before the load and whose 4 KB of RDRAM are byte-identical in the loaded
    // state gets its invalid_code[] entry put back to 0 after the load. A page
    // whose bytes differ (an overlay DMA'd in between) stays invalid and is
    // recompiled, exactly as before. The two addresses come from the core itself:
    // the JIT's parameter block carries &invalid_code[0] and the RDRAM base
    // (recomp.c jit_params[31] and [24]); with the JIT off (?jit=off) they are
    // unknown and every load pays the full recompile, as it always did.
    var N64S_KSEG = [0x80000, 0xA0000];
    function n64sCodeKeep(src) {
      var P = G.__n64CorePtrs;
      if (!P || !P.invalidCode || !P.dramBase || (P.dramBase & 3)) return null;
      var H8 = G.Module.HEAPU8, H32 = G.Module.HEAPU32, ic = P.invalidCode, dw = P.dramBase >>> 2;
      var S32 = src.__n64sRd || (src.__n64sRd = new Uint32Array(src.buffer, src.byteOffset + N64S_HDR, N64S_RDRAM >>> 2));
      var keep = N64S.keep || (N64S.keep = []), same = N64S.same || (N64S.same = new Int8Array(N64S_RDRAM >>> 12)), bases = N64S_KSEG;
      keep.length = 0; same.fill(0);
      for (var r = 0; r < 2; r++) {
        for (var j = 0; j < same.length; j++) {
          var idx = bases[r] + j;
          if (H8[ic + idx] !== 0) continue;
          if (!same[j]) {
            var a = dw + (j << 10), b = j << 10, eq = 1;
            for (var w = 0; w < 1024; w++) if (H32[a + w] !== S32[b + w]) { eq = -1; break; }
            same[j] = eq;
          }
          if (same[j] === 1) keep.push(idx);
          else N64S.codeDropped++;
        }
      }
      return keep;
    }
    function n64sLoad(src) {
      var M = G.Module, t0 = performance.now();
      if (!N64S.located) { N64S.fault = 'a load before any save'; return false; }
      if (N64S.raw) return n64sRawLoad(src);
      var keep = N64S_KEEP_CODE ? n64sCodeKeep(src) : null;
      // A slot's buffer is exactly state + save memory (alloc), so each half is
      // one subarray view; the copies themselves are memcpy.
      var sv = src.length === N64S.size ? src : (src.__n64sHead || (src.__n64sHead = src.subarray(0, N64S.size)));
      n64sView().set(sv);
      if (!n64sCall(true)) { N64S.fault = 'neil_unserialize refused the state (savestates_load_m64p returned 0)'; return false; }
      // The cartridge/controller save memory, which the savestate leaves out.
      if (N64S.smPtr && src.length >= N64S.size + N64S_SM) n64sSmView().set(src.__n64sTail || (src.__n64sTail = src.subarray(N64S.size, N64S.size + N64S_SM)));
      if (keep) {
        var H8 = M.HEAPU8, ic = G.__n64CorePtrs.invalidCode;
        for (var i = 0; i < keep.length; i++) H8[ic + keep[i]] = 0;
        N64S.codeKept += keep.length; N64S.keepLoads++;
      }
      var dt = performance.now() - t0;
      N64S.loads++; N64S.loadMs += dt; if (dt > N64S.maxLoadMs) N64S.maxLoadMs = dt;
      return true;
    }
    // FNV-1a over u32 words [from, to) of a byte buffer (4-aligned offsets).
    function n64sFnv(h, u8, from, to) {
      var w = new Uint32Array(u8.buffer, u8.byteOffset + from, (to - from) >>> 2);
      for (var i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 16777619) >>> 0;
      return h >>> 0;
    }
    // The FULL state, every byte (RDRAM, RSP memory, the TLB tables, the CPU):
    // for rigs that compare a console against itself (n64_rollback_probe). ⚠ Not
    // for a room: under read_always glide copies the RENDERED frame into RDRAM,
    // and two different GPUs rasterise a few pixels differently — the room would
    // "desync" on pixels no guest instruction ever read.
    // Raw layout: the trailer header's words 4-6 (instance nonce, TLB generation,
    // hidden-plane epoch) are fast-save bookkeeping, not machine state, and differ
    // between two instances — left out, everything else hashed.
    function n64sHashFull(u8) {
      if (!N64S.raw) return n64sFnv(2166136261, u8, 0, u8.length & ~3);
      var R = N64S.region, h = n64sFnv(2166136261, u8, 0, R + 16);
      return n64sFnv(h, u8, R + 28, u8.length & ~3);
    }
    // The ROOM fingerprint of a saved state: the CPU fingerprint the lockstep path
    // already compares (_neil_last_fp: GPRs, CP0, FPRs, FCR31, PC — kept with the
    // slot), plus every device register, the RSP's 4 KB+4 KB, the PIF RAM, the
    // TLB and the interrupt event queue — every byte of the state that is not
    // RDRAM or the derived TLB lookup tables. The layout is savestates.c
    // savestates_save_m64p's: 448 B of registers, 8 MB RDRAM, then SP mem +
    // PIF + flashram, 2 x 4 MB tlb_LUT, then CPU/TLB/PC/queue to the end.
    // Each region hashed on its own, so a mismatch NAMES the region (the engine's
    // _diagnose compares these words field by field); the room hash folds them.
    var N64S_FIELDS = ['cpu-fp', 'regs-hdr', 'sp-dmem', 'sp-imem', 'pif+flashregs', 'cpu-gpr-cp0-cp1', 'tlb+pc+queue',
                       'eeprom', 'controller-paks', 'sram', 'flashram'];
    function n64sRoomWords(u8, fp) {
      // Raw layout: the m64p region ends where the legacy buffer did, and the
      // save memory is the LAST section of the trailer (same struct layout).
      var M64 = 16788288 + 1024;
      var a = N64S_HDR + N64S_RDRAM, tail = a + N64S_SPPIF + N64S_LUT, S = 2166136261, sm = N64S.raw ? M64 : N64S.size;
      var w = [fp >>> 0, n64sFnv(S, u8, 0, N64S_HDR), n64sFnv(S, u8, a, a + 4096), n64sFnv(S, u8, a + 4096, a + 8192),
               n64sFnv(S, u8, a + 8192, a + (N64S_SPPIF & ~3)), n64sFnv(S, u8, tail & ~3, (tail + 4 + 256 + 128 + 16 + 256 + 8) & ~3),
               n64sFnv(S, u8, (tail + 4 + 256 + 128 + 16 + 256 + 8) & ~3, sm & ~3)];
      var so = N64S.raw ? u8.length - N64S_SM : sm;
      if (N64S.raw ? (new DataView(u8.buffer, u8.byteOffset + N64S.region + 63 * 4, 4).getUint32(0, true) === N64S_SM)
                   : u8.length >= sm + N64S_SM) {
        w.push(n64sFnv(S, u8, so, so + 0x800), n64sFnv(S, u8, so + 0x800, so + 0x20800),
               n64sFnv(S, u8, so + 0x20800, so + 0x28800), n64sFnv(S, u8, so + 0x28800, so + N64S_SM));
      }
      return w;
    }
    function n64sHashRoom(u8, fp) {
      var w = n64sRoomWords(u8, fp), h = 2166136261;
      for (var i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 16777619) >>> 0;
      return h >>> 0;
    }
    // TEST SEAM (n64/tools/n64_rollback_probe.mjs): the raw state API as shipped.
    G.__n64State = {
      info: function () { return { ptr: N64S.ptr, size: N64S.size, located: N64S.located, fault: N64S.fault, saves: N64S.saves, loads: N64S.loads,
                                   saveMs: N64S.saves ? +(N64S.saveMs / N64S.saves).toFixed(2) : null, loadMs: N64S.loads ? +(N64S.loadMs / N64S.loads).toFixed(2) : null,
                                   maxSaveMs: +N64S.maxSaveMs.toFixed(2), maxLoadMs: +N64S.maxLoadMs.toFixed(2),
                                   keepCode: N64S_KEEP_CODE && !!G.__n64CorePtrs, codeKeptPerLoad: N64S.keepLoads ? +(N64S.codeKept / N64S.keepLoads).toFixed(1) : null,
                                   codeDroppedPerLoad: N64S.keepLoads ? +(N64S.codeDropped / N64S.keepLoads).toFixed(1) : null,
                                   raw: !!N64S.raw, heapBufs: N64S.heapBufs | 0,
                                   selectiveLoads: N64S.raw ? N64S.keepLoads : null }; },
      alloc: function () { return n64sRawOk() ? n64sRawAlloc() : new Uint8Array(N64S.size + N64S_SM); },
      free: function (buf) { n64sFree(buf); },
      raw: function () { return n64sRawOk(); },
      save: function (dst) { return n64sSave(dst); },
      load: function (src) { return n64sLoad(src); },
      hashFull: function (u8) { return n64sHashFull(u8); },
      hashRoom: function (u8, fp) { return n64sHashRoom(u8, fp); },
      roomWords: function (u8, fp) { return n64sRoomWords(u8, fp); },
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // ROLLBACK — ZERO LOCAL INPUT LAG (THE DEFAULT, CAPACITY-GATED; ?rb=0 opts out — see RB_DEFAULT below).
    //
    // The engine half (prediction, the window, the re-simulation plan, confirmed
    // fingerprints) is lib/netplay.js _beginFrameRb; genesis.html rbRunFrame is
    // the reference integration. This is the core half:
    //   * frame STARTS are kept, every K frames (SPARSE SNAPSHOTS, below): after
    //     frame k runs, the exact state may be saved as the start of k+1, with
    //     the framebuffer-readback pin (fbasync) and the CPU fingerprint taken
    //     at the same instant, and the input every frame ran with is kept;
    //   * the local pad is applied to the frame it was sampled for (delay 0);
    //   * a remote port with no input yet is PREDICTED as its last real input
    //     (the engine's repeat-last);
    //   * when a late input contradicts a prediction, beginFrame hands back a
    //     plan: load the newest snapshot at or before the earliest wrong frame,
    //     re-run every frame up to the present WITHOUT PRESENTING (nothing yields to the browser in
    //     between, so only the last frame drawn in this task reaches the screen)
    //     and WITHOUT AUDIO (the re-simulated frames' samples are dropped: they
    //     were heard once, on the guess), then run the present frame.
    //
    // UNLIKE genesis.html, a frame is NOT loaded-then-run every time: an N64
    // state is 16.8 MB, and the load invalidates every compiled block
    // (savestates_load_set_pc -> invalidate_r4300_cached_code(0,0)), so the
    // straight path runs on without a load and only a rollback loads. That is
    // correct only if a loaded state re-runs exactly as the original did;
    // n64/tools/n64_rollback_probe.mjs is the measurement that decides it.
    //
    // FRAME 0 IS NOT A ROLLBACK TARGET UNTIL IT IS ONE. The core initialises its
    // CPU and plugins inside its FIRST retro_run (libretronew.c first_time ->
    // emu_step_initialize), so a state saved before any frame ran is a
    // pre-boot image that cannot be loaded into a running core. Every console
    // therefore runs ONE neutral pre-roll frame when the room starts, before its
    // frame 0 (lsPreroll) — the same frame on every machine — and the
    // room's frame 0 starts from an initialised core. The disc tag carries the
    // protocol ('r1') so a console without the pre-roll is refused at the barrier.
    //
    // ⚠ GATE 9. A re-simulation re-runs frames the guest already lived through
    // once on a guess; it spends no governor credit. Exactly one NEW frame runs
    // per lsDueNow() credit, as in lockstep, so the guest clock never passes wall
    // time. The engine's advantage wait (one skipped frame, at most one per 8)
    // is a slowdown, and the governor's schedule is moved by that one period
    // rather than repaid (lsFeed).
    // ═══════════════════════════════════════════════════════════════════════════
    var RB_Q = new URLSearchParams(env.search);
    // ROLLBACK IS THE DEFAULT (since 2026-10-02), CAPACITY-GATED. History: until the
    // engine's capacity gate landed it was opt-in — measured 2026-10-01 (MK64, 4x-CPU
    // mobile arm, 2 players) rollback rooms ran at 0.06-0.26x where delay lockstep
    // holds its rate. With the gate (lib/netplay.js _capDecide) a console that cannot
    // afford rollback drops the room to delay lockstep at EXACTLY the delay a lockstep
    // room on the link starts at (the host's RTT pings, rttDelay), after a warm-up,
    // and returns when it can afford it again (rbResume, rbRearm here). Measured in
    // interleaved matched pairs against delay lockstep: never slower, never more input
    // lag, 0 desyncs — n64/docs/rollback-default/RESULTS.md. ?rb=0 is the lockstep arm.
    var RB_DEFAULT = true;
    var RB_WANT = RB_Q.get('rb') === '1' || (RB_DEFAULT && RB_Q.get('rb') !== '0');  // ?rb=1 / ?rb=0 override either way
    var RB_WINDOW = Math.max(2, Math.min(12, +(RB_Q.get('rbw') || 8) | 0));
    // ---- RE-SIMULATED FRAMES DRAW NOTHING (GLSKIP) -----------------------------
    // A re-simulated frame is never seen (only the present frame, drawn last in
    // the same task, reaches the screen) and its audio is dropped, so its GL
    // draw calls are pure cost. While GLSKIP.on, the draw and clear calls are
    // swallowed; every other GL call (textures, buffers, state) still runs, so
    // the video plugin's GL objects stay exactly as they would have been.
    // ⚠ UNLESS THE PIXELS CAN REACH THE GUEST. A title that reads the frame back
    // (glide read_always: Mario Kart 64, Pokémon Snap, DK64, ... — fbasync's
    // list) copies the RENDERED frame into RDRAM, so its hidden frames must draw
    // exactly as the first run did: they are never skipped. Any other title is
    // skipped only until the core reads the framebuffer back ONCE (any
    // glReadPixels the page did not issue itself): from then on nothing is
    // skipped again, and a re-simulation during which such a read happened is
    // thrown away and re-run drawing (rbRunFrame), so the guest never reads a
    // pixel a skipped draw left out. ?rbgl=1 draws every hidden frame (the
    // control arm). Run-ahead's hidden frames (all but the last, whose picture
    // is shown) skip too: their state is discarded whatever they read.
    var GLSKIP = { on: false, disabled: RB_Q.get('rbgl') === '1' ? 'pinned off (?rbgl=1)' : null,
                   taint: false, reads: 0, calls: 0, frames: 0, redo: 0 };
    if (G.WebGL2RenderingContext) (function () {
      var P = WebGL2RenderingContext.prototype;
      ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements',
       'clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi', 'blitFramebuffer'].forEach(function (n) {
        var f = P[n];
        if (typeof f !== 'function') return;
        P[n] = function () { if (GLSKIP.on) { GLSKIP.calls++; return; } return f.apply(this, arguments); };
      });
      var rp = P.readPixels;
      P.readPixels = function () {
        var st = G.__fbAsync;
        if (!(st && st.bypass)) {
          GLSKIP.reads++;
          if (GLSKIP.on) GLSKIP.taint = true;
          if (!GLSKIP.disabled) {
            GLSKIP.disabled = 'the core read the framebuffer back (glReadPixels): its pixels can reach guest state';
            env.log('[rollback] re-simulated frames draw from now on — ' + GLSKIP.disabled);
          }
        }
        return rp.apply(this, arguments);
      };
    })();
    function glSkipOk() {
      var st = G.__fbAsync || {};
      return !GLSKIP.disabled && !st.on && !st.readAlways;
    }

    // ---- THE RENDER-LEVEL FRAME SKIP, IN A ROOM (core worker only: env.fs) ------
    // Solo, a field that starts while the GPU still holds FSK.depth pictures runs with its draws
    // into the WINDOW swallowed (core_worker.js THE RENDER-LEVEL FRAME SKIP) instead of the guard
    // holding the guest. A room held the guest instead (the depth guard), so a room on a slow GPU
    // ran slow — and every console of it with it. Here a room's frames skip the same way:
    //   * WHICH FRAMES. The PRESENTED frame skips when the GPU is behind and the frame is expected
    //     to draw (the solo rule, env.fs.behind/expect). A frame that is never shown — a rollback's
    //     re-simulated frame, a hidden catch-up frame — skips whenever the GPU is behind. (Re-sims
    //     of a title without framebuffer readback already draw nothing: GLSKIP, above; this covers
    //     the read_always titles GLSKIP must leave drawing — Mario Kart 64, Pokemon Snap, DK64.)
    //   * THE GUEST IS BIT-IDENTICAL, so the room's determinism is untouched. A skipped frame
    //     changes guest state only if its pixels are read back: glide's lazy copy marks a capture
    //     taken in a skipped frame BLANK and counts a TAINT when one is materialised (lazy_fb.c
    //     FRAME SKIP; neil_fs_set gets the ENGINE FRAME as the serial), and a core glReadPixels
    //     while the window holds a skipped frame's picture counts one too (core_worker.js
    //     fsInstallRead). On a taint, right after the frame that read and BEFORE anything is
    //     saved, fingerprinted or presented from it, the room's own snapshot ring re-runs:
    //     the newest snapshot at or before the oldest frame whose blank capture was live
    //     (RFS.need: neil_fs_oldest() sampled after every frame and every load — a load can
    //     bring back a capture the replaced timeline had superseded), every frame since re-run
    //     drawing with the input it ran with (RB.img), exactly as a rollback re-simulates.
    //     A re-run replays the same guest, so it materialises the same captures at the same
    //     points — drawn, this time.
    //   * A re-run always has a snapshot: the ring never frees the one at or before the oldest frame
    //     a re-run may start at (rbPick, rfsHold), and a blank capture older than 16 frames
    //     (?fskipage=N, solo's FS_MAXAGE) is resolved by a re-run at once (rfsSettle), while it is
    //     short. A re-run caused by a read-back suspends skipping for a while (doubling), as solo.
    //   * DELAY LOCKSTEP has no ring: its frames run through the worker's solo machinery
    //     (env.fs.linear = fsField: its own snapshots, one per 8 frames, and every frame's pads),
    //     which is exact for a guest that never rewinds. Switching mode settles the old machinery
    //     first (rfsSettle / env.fs.settleLinear), so no blank capture crosses into the other.
    //   * Run-ahead (opt-in, ?ra) presents its last hidden frame: no skipping while it runs.
    // ?rfskip=0 is the arm (the room guard as it was); the worker's ?fskip=0 turns both off and
    // ?fskip=force:K forces it (all but 1 of K presented frames, every re-sim / hidden frame).
    // MEASURED (this box: 4 vCPU, SwiftShader; hermetic snapshots, probe lock held, interleaved,
    // load 0.8-5.2). n64_rollback_probe, MK64, a 2-player room with a ghost player, 30 s, two runs
    // each; rate = engine frames / wall / 50 Hz; latency = a presented picture's tick -> its fence
    // signalled / committed, p50 / p99 ms:
    //                          rate            lost in 30 s     latency p50 / p99
    //   rollback  HEAD guard    0.876-0.899x    13.9-14.5 s      (no witness)
    //             ?rfskip=0     0.879x, 0.880x  13.6-14.4 s      414-454 / 973-980
    //             frame skip    0.977-0.985x    2.5-2.6 s        213-236 / 710-980
    //   delay     HEAD guard    0.888-0.890x    2.4 s            (no witness)
    //             ?rfskip=0     0.877-0.898x    2.5-2.8 s        196-199 / 381-394
    //             frame skip    0.953-0.970x    0.6-0.8 s        93-104 / 331-374
    // lib/bench.js room (SM64, the loopback room: both consoles on this one box), 30 s:
    // HEAD 0.808x, 0.868x -> frame skip 0.990x, 0.991x. What is left is not the GPU: it is the
    // re-runs (8-12 in 30 s in the rollback room, ~1 s together; a blank capture that outlives 16
    // frames on a GPU this far behind) and the CPU two consoles share.
    var RFS = { on: !!env.fs && RB_Q.get('rfskip') !== '0', why: null, skipped: 0, hiddenSkipped: 0, resimSkipped: 0,
                reruns: 0, rerunFrames: 0, rerunMs: 0, maxRerunMs: 0, repairs: 0, readbacks: 0, lost: 0,
                suspendUntil: -1, backoff: 64, need: Infinity, stale: false, staleS: -1, inRerun: false, inResim: false,
                head: -1, cur: -1, curSkip: false, linear: 0 };
    if (!RFS.on) RFS.why = env.fs ? 'off (?rfskip=0)' : 'not in this realm (main-thread core)';
    function rfsLive() { return RFS.on && !!env.fs && env.fs.ok(); }
    function rfsOldest() { var M = G.Module; return (M && M._neil_fs_oldest) ? (M._neil_fs_oldest() | 0) : -1; }
    function rfsNote() { var o = rfsOldest(); if (o >= 0 && o < RFS.need) RFS.need = o; }
    // the most a blank capture may age, in frames, before it is resolved (solo's FS_MAXAGE). The
    // ring keeps the snapshot a re-run would start from however far back that is (rbPick: rfsHold).
    var RFS_MAXAGE = Math.max(2, +(RB_Q.get('fskipage') || 16) | 0);
    function rfsMaxAge() { return RFS_MAXAGE; }
    // the oldest frame a re-run may have to start at, or Infinity
    function rfsHold() { return (RFS.on && RB.ready) ? Math.min(RFS.need, RFS.stale ? RFS.staleS : Infinity) : Infinity; }
    // kind: 'present' | 'hidden' | 'resim'. May frame k skip at all (a snapshot to re-run from,
    // not suspended)? And should it (the GPU is behind)?
    function rfsAble(kind, k) {
      if (!rfsLive() || RFS.inRerun || RA.frames > 0 || !RB.ready || RB.stale || k < RFS.suspendUntil) return false;
      if (kind === 'resim' && glSkipOk()) return false;           // GLSKIP covers it
      return !!rbAtOrBelow(k);                                    // a re-run needs a snapshot at or before k
    }
    function rfsWant(kind, k) {
      if (!rfsAble(kind, k)) return false;
      var f = env.fs.force();
      if (kind === 'present') return f ? (k % f) !== 0 : (env.fs.behind() && env.fs.expect());
      return f ? true : env.fs.behind();
    }
    // Around one neil_ls_run_frame of the ring (rbStep).
    function rfsBegin(kind, k) {
      var skip = rfsWant(kind, k);
      RFS.cur = k; RFS.curSkip = skip;
      if (env.fs && RFS.on) env.fs.begin(skip, k);
      return skip;
    }
    function rfsEnd(kind, k, skip, present) {
      if (!env.fs || !RFS.on) return;
      var r = env.fs.end(present);
      if (skip) {
        if (kind === 'present') RFS.skipped++; else if (kind === 'hidden') RFS.hiddenSkipped++; else RFS.resimSkipped++;
        // (as solo: the newest skipped frame — a re-run redraws it over the last picture drawn)
        if (r.sw) { RFS.stale = true; RFS.staleS = k; }
      } else if (r.drew) RFS.stale = false;
      env.fs.stale(RFS.stale);
      rfsNote();
      if (k > RFS.head) RFS.head = k;
    }
    // A taint right after frame k ran: re-run from the snapshot the oldest reachable blank
    // capture needs, through k, drawing. Returns false when it could not (the room fails then:
    // this console's guest is no longer the room's).
    function rfsTaintCheck(ls, k) {
      if (!env.fs || !RFS.on) return true;
      var t = env.fs.taint();
      if (!t) return true;
      if (RFS.inRerun) { RFS.lost++; return 'a read-back reached a skipped frame DURING a frame-skip re-run (frame ' + k + ')'; }
      if (t === 'read') RFS.readbacks++;
      return rfsRerun(ls, k, t === 'read' ? 'read-back' : 'blank capture');
    }
    // resave: the start of k+1 was saved already (rfsSettle runs after the frame's own save).
    // (TRIED AND REJECTED: an age repair that draws only up to its oldest frame + 4 and re-runs the
    // rest skipping again. MEASURED, MK64 rollback rooms, forced: re-runs 9 -> 14 and 8 -> 13, their
    // total time 1037 -> 1253 ms and 447 -> 829 ms — the frames it skipped again left a stale window
    // that needed its own repair a few frames later.)
    function rfsRerun(ls, k, why, resave) {
      var from = Math.min(RFS.need, RFS.stale ? RFS.staleS : Infinity, RFS.curSkip ? RFS.cur : Infinity, k);
      var s = rbAtOrBelow(from), j, t0 = performance.now(), M = G.Module;
      RFS.dbgNeed = RFS.need; RFS.dbgStale = RFS.stale ? RFS.staleS : -1;
      if (!s) { RFS.lost++; return 'a frame-skip re-run to frame ' + from + ' found no snapshot at or before it'; }
      for (j = s.frame; j <= k; j++) if (RB.imgF[j % RB_IMG] !== j) { RFS.lost++; return 'a frame-skip re-run: the input frame ' + j + ' ran with is no longer held'; }
      RFS.inRerun = true;
      // the re-run redraws: the window holds no skipped picture from here (as solo's fsRedo)
      RFS.stale = false; env.fs.stale(false);
      try {
        // what real frames made goes out first (not inside a re-simulation: its audio is dropped anyway)
        if (!RFS.inResim) audioFlushNow();
        rbDropAbove(s.frame);
        if (!rbLoadSlot(s)) return 'frame-skip re-run load failed: ' + N64S.fault;
        for (j = s.frame; j < k; j++) if (!rbStep(ls, j, RB.img[j % RB_IMG], false, false)) return 'frame-skip re-run save failed: ' + N64S.fault;
        lsApplyImage(RB.img[k % RB_IMG]);
        env.fs.begin(false, k);
        try { M._neil_ls_run_frame(); } finally { env.fs.end(false); }
        if (!RFS.inResim) audioDropNow();
        if (env.fs.taint()) { RFS.lost++; return 'a read-back reached a skipped frame DURING a frame-skip re-run (frame ' + k + ')'; }
        if (resave && !rbSaveAt(ls, k + 1)) return 'frame-skip re-run save failed: ' + N64S.fault;
      } finally { RFS.inRerun = false; }
      RFS.stale = false; env.fs.stale(false); RFS.curSkip = false;
      RFS.need = Infinity; rfsNote();
      var ms = performance.now() - t0;
      RFS.reruns++; RFS.rerunFrames += k - s.frame + 1; RFS.rerunMs += ms; if (ms > RFS.maxRerunMs) RFS.maxRerunMs = ms;
      if (G.__n64RbLog) G.__n64RbLog.push(['fsrerun', k, s.frame, why, from, RFS.dbgNeed, RFS.dbgStale]);
      if (why === 'read-back') {
        RFS.suspendUntil = k + RFS.backoff; RFS.backoff = Math.min(RFS.backoff * 2, 1 << 24);
        env.log('[fskip] room: a read-back reached a skipped frame: re-ran frames ' + s.frame + '..' + k + ' drawing ('
              + ms.toFixed(1) + ' ms); skipping resumes in ' + (RFS.suspendUntil - k) + ' frames');
      }
      return true;
    }
    // After a frame the room presents (or hides): what can still be reached is recomputed, and a
    // blank capture about to outlive the ring is resolved now. Also before the ring goes away
    // (a switch to delay lockstep, leaving the room) — `all` resolves whatever is left.
    function rfsSettle(ls, all) {
      if (!env.fs || !RFS.on || !RB.ready || RB.stale || RFS.head < 0) return true;
      RFS.need = Infinity; rfsNote();
      var from = Math.min(RFS.need, RFS.stale ? RFS.staleS : Infinity);
      if (from === Infinity || (!all && RFS.head - from <= rfsMaxAge())) return true;
      RFS.repairs++; RFS.curSkip = false;
      return rfsRerun(ls, RFS.head, all ? 'settle' : 'age', true);
    }
    function rfsReport() {
      return { on: RFS.on, live: rfsLive(), why: RFS.why, skipped: RFS.skipped, hiddenSkipped: RFS.hiddenSkipped, resimSkipped: RFS.resimSkipped,
               reruns: RFS.reruns, rerunFrames: RFS.rerunFrames, rerunMs: Math.round(RFS.rerunMs), maxRerunMs: +RFS.maxRerunMs.toFixed(1),
               repairs: RFS.repairs, readbacks: RFS.readbacks, lost: RFS.lost, linear: RFS.linear, suspendedUntil: RFS.suspendUntil,
               linearFs: env.fs && env.fs.report ? env.fs.report() : null };
    }

    // ---- SPARSE SNAPSHOTS ------------------------------------------------------
    // A save is a 16.8 MB savestates_save_m64p into the core's buffer plus a
    // 16.8 MB copy out of the heap (n64sSave) — the largest fixed cost of a
    // rollback step, paid on EVERY frame while the room runs, whether or not a
    // prediction is ever wrong. So a frame's start is saved only every K frames
    // (and where something else needs it, below); a rollback to frame f loads
    // the NEWEST snapshot at or before f and re-runs the frames between it and
    // f with the very inputs they ran with the first time (RB.img — they were
    // right: f is the EARLIEST wrong frame), then the corrected frames as before.
    // Exactness is unchanged: those bridge frames re-run a confirmed-equal
    // history from an exact state, the same thing a re-simulation already is.
    //   * K ADAPTS (rbAdaptK, once a second): it minimises the expected cost per
    //     presented frame, (1 + p·D)·save/K + p·(load + (K-1)/2·run) — p the
    //     measured rollbacks per frame, D their mean depth, the rest the
    //     measured EMAs — among the K whose WORST rollback (window-deep, K-1
    //     bridge frames, its saves) still fits two fields; if none does, the K
    //     with the smallest worst case. ?rbk=N pins it (?rbk=1 = every frame,
    //     the old ring), ?rbk=auto (default) adapts from 1 up to RB_K_MAX.
    //   * ALWAYS SAVED, whatever K is: the state after every frame the engine
    //     fingerprints (k % hashEvery === 0 — so every console of a room holds
    //     the same frames to compare, whatever K each one chose), and the
    //     present frame's while run-ahead is on (raRun restores it).
    //   * THE RING IS A SET OF SLOTS, NOT k % n. Snapshots are kept back to the
    //     newest one at or before (frame − RB.n) — the deepest rollback the room
    //     can ask for (rbRingFrames) — and anything older is reused first. Under
    //     the device's memory budget (RB_RING_BUDGET_MB) slots are added; past it
    //     the snapshot whose removal leaves the smallest gap is dropped, so a
    //     window that outgrows the budget costs a longer bridge, never a failure.
    // ═══════════════════════════════════════════════════════════════════════════
    var RB_K_Q = RB_Q.get('rbk');
    var RB_K_FIXED = (RB_K_Q != null && RB_K_Q !== 'auto') ? Math.max(1, Math.min(16, +RB_K_Q | 0)) : null;
    var RB_K_MAX = 8, RB_IMG = 1024;
    var RB = { ready: false, fault: null, slots: [], n: 0, cap: 0, k: RB_K_FIXED || 1, kFixed: RB_K_FIXED, kChanges: 0, kAt: 0, kWhy: null,
               img: new Array(RB_IMG), imgF: new Int32Array(RB_IMG).fill(-1),
               hidden: 0, stepMs: 0, runEma: 0, saveEma: 0, loadEma: 0, pEma: 0, depthEma: 0,
               rollbacks: 0, resimFrames: 0, bridgeFrames: 0, maxDepth: 0, depthHist: {}, resimMs: 0, maxResimMs: 0, depthSum: 0,
               hashes: 0, missingSlot: 0, saveMs: 0, saves: 0, skippedSaves: 0, frames: 0, loads: 0, evictions: 0, glRedo: 0,
               stale: false, rearms: 0 };
    // ⚠ THE PRICE OF A STEP IS A TRIMMED MEAN, NOT AN EMA SEEDED BY ITS FIRST SAMPLE.
    // MEASURED (n64_room_mode_probe, the bench's loopback room, SM64, 3/3 runs on 1923e52): every
    // run left rollback for delay at frame ~460 with ZERO rollbacks. The first load the console ever
    // made was a frame-skip age repair (rfsRerun) from a snapshot taken before the guest rewrote its
    // TLB, so the loader wiped the whole code cache (neil_state_last_load_mode 2): 49.5 ms inside
    // the load, 187 ms for the re-run. loadEma took that ONE sample as its value, the published step
    // went 4.1 -> 13.4-19.0 ms (load / W of it), the host read 83-99% and switched — and in delay the
    // estimate kept the same load, so the room never came back. The run price had the same flaw at
    // the start: the first frames (JIT compiling) cost 10-15 ms and seeded runEma, which decays /32.
    // So each part of the step is the mean of its last N samples with the top eighth dropped: a
    // spike the room pays in either mode (a compile, a GC) is not a rollback cost, while a device
    // that is slow on most frames is priced as slow within N samples. And what is not a step at all
    // is not sampled: a load that wiped the code cache (counted in RB.wipes — a guest TLB rewrite
    // between the snapshot and now, rare), the frames re-run after one, and frame-skip re-runs.
    function rbEst(n) { return { a: new Float64Array(n), n: 0, i: 0, v: 0, dirty: false }; }
    function rbEstPush(e, x) { if (!(x >= 0) || !isFinite(x)) return; e.a[e.i] = x; e.i = (e.i + 1) % e.a.length; if (e.n < e.a.length) e.n++; e.dirty = true; }
    function rbEstGet(e) {
      if (!e.dirty) return e.v;
      e.dirty = false;
      if (!e.n) return (e.v = 0);
      var b = Array.prototype.slice.call(e.a, 0, e.n).sort(function (x, y) { return x - y; });
      var m = e.n - Math.floor(e.n / 8), t = 0;
      for (var i = 0; i < m; i++) t += b[i];
      return (e.v = t / m);
    }
    function rbEstSeed(e, x) { e.n = 0; e.i = 0; e.dirty = true; if (x > 0) rbEstPush(e, x); }
    // resave: the saves rbRemeasure times in a delay stretch, one every RB_REMEASURE_MS — few, so a
    // short ring of their own (a 32-deep one would keep a slow period's saves for 96 s)
    var RBE = { run: rbEst(64), save: rbEst(32), load: rbEst(16), resave: rbEst(4) };
    function rbSpan(ls) {
      return Math.max((ls.rollback | 0) + 3, typeof ls.rbRingFrames === 'function' ? ls.rbRingFrames() | 0 : 0);
    }
    function rbInit(ls) {
      RB.n = rbSpan(ls);
      n64sRawOk();
      RB.cap = Math.max(2, Math.floor(RB_RING_BUDGET_MB * 1048576 / rbSlotBytes()));
      if (RB.preCap > 0 && RB.preCap < RB.cap) RB.cap = RB.preCap;
      rbPublishCap('the ring armed');
      RB.slots = [];
      if (!rbSaveAt(ls, ls.frame | 0)) { RB.fault = N64S.fault || 'the first savestate failed'; return false; }
      RB.ready = true;
      env.log('[rollback] ARMED: window ' + (ls.rollback | 0) + ' frames, snapshots reach back ' + RB.n + ' frames, at most '
            + RB.cap + ' exact states x ' + (rbSlotBytes() / 1048576).toFixed(1) + ' MB (budget ' + RB_RING_BUDGET_MB
            + ' MB, allocated as used; past it snapshots are thinned, never refused), one every '
            + (RB.kFixed ? RB.k + ' frames (?rbk)' : 'K frames, K adapted to the measured cost'
            ) + '; local input applied with 0 frames of delay');
      return true;
    }
    // ⚠ BACK TO ROLLBACK AFTER INPUT DELAY (lib/netplay.js _capDecide: a
    // capacity-gated room returns to zero-lag mode when every console can afford
    // it again; this page declares opts.rbResume). The delay frames ran outside
    // the ring (lsRunOneFrame), so nothing in it reaches the frames the room can
    // now roll back to: its snapshots are of frames before the switch to delay,
    // and RB.img holds none of the inputs the delay frames ran with. The ring is
    // RE-ARMED at the first rollback frame R, before it runs: the live machine IS
    // the start of R (every frame before it ran, in order, on its final input —
    // lockstep runs only on real inputs), and the engine never names a correction
    // reaching back across R (every input before R is held: _rbResumeAt). The
    // engine's contract (opts.rbResume): the page keeps the start of that first
    // rollback frame itself. One save, once per return.
    function rbRelease() {
      for (var i = 0; i < RB.slots.length; i++) { rbDrop(RB.slots[i]); try { n64sFree(RB.slots[i].buf); } catch (e) {} }
      RB.slots = []; RB.released = (RB.released | 0) + 1;
    }
    function rbRearm(ls, k) {
      for (var i = 0; i < RB.slots.length; i++) rbDrop(RB.slots[i]);
      RB.n = rbSpan(ls);
      if (!rbSaveAt(ls, k)) { RB.fault = N64S.fault || 'the savestate at the return to rollback failed'; return false; }
      RB.stale = false; RB.rearms++;
      // the ring's prices restart from what the delay stretch measured (rbRemeasure), not from the
      // samples taken before the switch — the very ones that said this console could not afford it
      if (RBE.resave.n) {
        rbEstSeed(RBE.save, rbEstGet(RBE.resave)); RB.saveEma = rbEstGet(RBE.save);
        rbEstSeed(RBE.load, RB.loadEma); RB.loadEma = rbEstGet(RBE.load);
        rbEstSeed(RBE.resave, 0);
      }
      env.log('[rollback] zero-lag mode again: the savestate ring is re-armed at frame ' + k + ' (window ' + (ls.rollback | 0)
            + ' frames, snapshots reach back ' + RB.n + ')');
      if (G.__n64RbLog) G.__n64RbLog.push(['rearm', k]);
      return true;
    }
    // THE REACH FOLLOWS THE WINDOW (lib/netplay.js rbRingFrames): the snapshots
    // must reach back as far as the largest window this room has run, BEFORE the
    // frame that could roll back that deep. Nothing is allocated here: slots are
    // added as saves need them, up to the budget, and thinned past it.
    // THE BUDGET. navigator.deviceMemory is Chromium-only (and capped at 8):
    // Safari — every iOS browser — reports nothing, and a 600 MB ring on top of
    // the core's own heap is exactly what iOS kills a tab for. So with no
    // deviceMemory the budget comes from what else the browser says: an iOS /
    // iPadOS device (touch Mac UA included) or any mobile UA gets the phone
    // budget, a desktop with a reported JS heap limit a quarter of it, and the
    // rest a middle figure. Thinning (rbPick) keeps a room inside any budget.
    // Decided by the PAGE (navigator.deviceMemory, the UA, performance.memory — a worker
    // sees a different, smaller navigator) and handed in, so both realms size the ring alike.
    var RB_RING_BUDGET_MB = env.ringBudgetMB;
    // What ONE slot really costs: the state, the 290 KB of cartridge save memory
    // it carries (N64S_SM), and — when framebuffer readback is async — the GPU
    // pack buffer its fbasync pin can keep alive (one RGBA copy of the frame).
    function rbSlotBytes() {
      var st = G.__fbAsync || {}, fb = 0;
      if (st.on) { var c = env.slotCanvas(); fb = Math.max(640 * 480, c ? (c.width | 0) * (c.height | 0) : 0) * 4; }
      return (N64S.raw ? N64S.size : N64S.size + N64S_SM) + fb;
    }
    // THE WINDOW THIS CONSOLE CAN HOLD, told to the engine (lib/netplay.js
    // rbMaxWindow, carried in lsready and every 'lsrb'): the host never decides
    // a window deeper than the smallest console's. `slots` snapshots, one every
    // K frames, reach back slots*K frames; 4 frames of margin for the snapshot
    // the next save replaces and the frames between the newest one and now.
    // Re-published whenever K or the slot capacity changes — a heap that
    // fragments (fewer slots fit) LOWERS it.
    function rbPublishCap(why, slots) {
      var ls = env.engine(), n = slots != null ? slots : RB.cap;
      if (!ls || !(n > 0)) return;
      var c = Math.max(4, n * Math.max(1, RB.k) - 4);
      if (ls.rbMaxWindow === c) return;
      ls.rbMaxWindow = c; RB.maxWindow = c;
      env.log('[rollback] this console can hold a window of ' + c + ' frames (' + n + ' snapshots x one every ' + RB.k
            + ' frames) — ' + why);
    }
    function rbGrow(want) {
      var nn = want | 0;
      if (!RB.ready || nn <= RB.n) return true;
      env.log('[rollback] snapshots reach back ' + RB.n + ' -> ' + nn + ' frames (the room\'s window grew)');
      RB.n = nn;
      if (G.__n64RbLog) G.__n64RbLog.push(['grow', nn]);
      return true;
    }
    // The snapshot of the start of frame k exactly (fingerprints, run-ahead).
    function rbSlot(k) {
      for (var i = 0; i < RB.slots.length; i++) if (RB.slots[i].frame === k) return RB.slots[i];
      return null;
    }
    // The newest snapshot at or before the start of frame k (a rollback's base).
    function rbAtOrBelow(k) {
      var b = null;
      for (var i = 0; i < RB.slots.length; i++) { var s = RB.slots[i]; if (s.frame >= 0 && s.frame <= k && (!b || s.frame > b.frame)) b = s; }
      return b;
    }
    function rbDrop(s) {
      var st = G.__fbAsync;
      if (s.fb && st && st.release) st.release(s.fb);
      s.fb = null; s.frame = -1; s.pin = -1;
    }
    // Snapshots of a timeline that is being replaced: everything after frame k.
    function rbDropAbove(k) {
      for (var i = 0; i < RB.slots.length; i++) if (RB.slots[i].frame > k) rbDrop(RB.slots[i]);
    }
    // Which slot the start of frame k is written to (see SPARSE SNAPSHOTS).
    function rbPick(k) {
      // the anchor is also never newer than the frame a frame-skip re-run may start at (RFS)
      var S = RB.slots, i, s, anchor = null, H = Math.min(k - RB.n, rfsHold()), free = [];
      for (i = 0; i < S.length; i++) if (S[i].frame === k) return S[i];
      for (i = 0; i < S.length; i++) { s = S[i]; if (s.frame >= 0 && s.frame <= H && (!anchor || s.frame > anchor.frame)) anchor = s; }
      for (i = 0; i < S.length; i++) { s = S[i]; if (s.frame < 0 || (anchor && s.frame < anchor.frame)) free.push(s); }
      if (free.length) {
        // A K that grew leaves states nothing needs: keep one spare, hand the
        // rest back to the browser (16.8 MB each — a phone's memory).
        for (i = 2; i < free.length; i++) { rbDrop(free[i]); n64sFree(free[i].buf); S.splice(S.indexOf(free[i]), 1); RB.freed = (RB.freed | 0) + 1; }
        return free[0];
      }
      if (S.length < RB.cap) {
        var nb = null;
        try { nb = N64S.raw ? n64sRawAlloc() : new Uint8Array(N64S.size + N64S_SM); } catch (e) { nb = null; }
        if (nb) { s = { frame: -1, buf: nb, fb: null, fp: 0, pin: -1 }; S.push(s); return s; }
        RB.cap = Math.max(S.length, 2);
        rbPublishCap('the ' + (N64S.raw ? 'wasm heap' : 'browser') + ' held only ' + RB.cap + ' snapshots');
        env.log('[rollback] the ' + (N64S.raw ? 'wasm heap (shared with the ROM)' : 'browser') + ' holds ' + S.length
              + ' snapshots — past that they are thinned, never refused');
      }
      // Thin: never the anchor (or the oldest, standing in for it), never a
      // snapshot a fingerprint still needs unless nothing else is left.
      var ord = S.slice().sort(function (a, b) { return a.frame - b.frame; }), best = null, bestGap = Infinity;
      for (i = 0; i < ord.length; i++) {
        s = ord[i];
        if (s === anchor || (!anchor && i === 0)) continue;
        var gap = (i + 1 < ord.length ? ord[i + 1].frame : k) - (i > 0 ? ord[i - 1].frame : s.frame);
        if (s.pin >= 0 && s.frame > H) gap += 1e6;
        if (gap < bestGap) { bestGap = gap; best = s; }
      }
      if (best) { rbDrop(best); RB.evictions++; }
      return best;
    }
    // ---- GLIDE'S HOST STATE TRAVELS WITH EVERY SNAPSHOT (RBGL) --------------------
    // The raw state is the MACHINE; what a frame DRAWS also depends on state glide keeps on the
    // host and carries from one display list to the next: its RDP (g_gdp: tiles, TMEM, modes;
    // gDP: the palette CRCs; gSP; `rdp` up to its first pointer — tiles, palette, the TMEM address
    // map, colours, combiner modes, lights, matrices), the frontend's toast (counted in swaps), and
    // the libc rand() glide draws its noise and a combiner colour from (lazy_fb.c, the same image
    // the solo frame-skip re-run restores: core_worker.js fsSnap/fsRedo). A load put the MACHINE
    // back and left all of that where the replaced timeline had taken it, which a frame that draws
    // with RDP state an earlier display list set up would see. ⚠ NOT OBSERVED: the "6 of 6 titles'
    // pictures differ" that motivated this was the rig (the straight reference showed the frontend's
    // toast on frames the room no longer did); with the rig fixed, ?rbgls=0 kept every picture of
    // Snap, Star Fox, Banjo-Tooie and MK64 identical too (2026-10-04, 212-479 frames each). Kept
    // because it is cheap (27 KB, ~0.035 ms a save or load) and the toast's timing follows it.
    // (The DK64 rollback-room desync at 1247-1252 was the heap — see N64S_RAW_RESERVE.)
    // So each snapshot keeps that image too (neil_gl_state_save, ~KBs: a memcpy beside the 9 MB
    // fast save) and every load puts it back. ?rbgls=0 is the arm (the machine only, as before).
    var RBGL = { on: RB_Q.get('rbgls') !== '0', size: -1, ptr: 0, saves: 0, loads: 0, ms: 0 };
    function rbglOk() {
      if (RBGL.size >= 0) return RBGL.size > 0;
      var M = G.Module;
      RBGL.size = 0;
      if (RBGL.on && M && typeof M._neil_gl_state_size === 'function' && typeof M._neil_gl_state_save === 'function'
          && typeof M._neil_gl_state_load === 'function' && typeof M._malloc === 'function') {
        var n = M._neil_gl_state_size() | 0, p = n > 0 ? M._malloc(n) : 0;
        if (p) { RBGL.size = n; RBGL.ptr = p; }
      }
      return RBGL.size > 0;
    }
    function rbglSave(s) {
      if (!rbglOk()) { s.gl = null; return; }
      var M = G.Module, t0 = performance.now();
      M._neil_gl_state_save(RBGL.ptr);
      if (!s.gl || s.gl.length !== RBGL.size) s.gl = new Uint8Array(RBGL.size);
      s.gl.set(M.HEAPU8.subarray(RBGL.ptr, RBGL.ptr + RBGL.size));
      s.rlo = M._neil_rand_lo ? M._neil_rand_lo() >>> 0 : 0; s.rhi = M._neil_rand_hi ? M._neil_rand_hi() >>> 0 : 0;
      s.glOk = true;
      RBGL.saves++; RBGL.ms += performance.now() - t0;
    }
    function rbglLoad(s) {
      if (!s.glOk || !rbglOk()) return;
      var M = G.Module, t0 = performance.now();
      M.HEAPU8.set(s.gl, RBGL.ptr);
      M._neil_gl_state_load(RBGL.ptr);
      if (M._neil_rand_set) M._neil_rand_set(s.rlo, s.rhi);
      RBGL.loads++; RBGL.ms += performance.now() - t0;
    }
    // Save the state at the START of frame k (i.e. after frame k-1 ran).
    function rbSaveAt(ls, k) {
      var s = rbPick(k);
      if (!s) { N64S.fault = 'out of memory for the rollback snapshots'; return false; }
      rbDrop(s);
      var t0 = performance.now();
      s.glOk = false;
      if (!n64sSave(s.buf)) return false;
      rbglSave(s);
      var dt = performance.now() - t0;
      RB.saveMs += dt; RB.saves++;
      rbEstPush(RBE.save, dt); RB.saveEma = rbEstGet(RBE.save);
      var st = G.__fbAsync;
      if (st && st.on && st.snapshot) s.fb = st.snapshot();
      try { s.fp = G.Module._neil_last_fp() >>> 0; } catch (e) { s.fp = 0; }
      s.frame = k;
      var he = ls.hashEvery | 0;
      s.pin = (he > 0 && k >= 1 && ((k - 1) % he) === 0) ? k - 1 : -1;
      return true;
    }
    function rbWantSave(ls, k, present) {
      if (RB.k <= 1) return true;
      if (present && RA.frames > 0) return true;                 // raRun restores the present state
      var he = ls.hashEvery | 0;
      if (he > 0 && k >= 1 && ((k - 1) % he) === 0) return true;  // a fingerprinted frame's after-state
      var b = rbAtOrBelow(k - 1);
      return !b || k - b.frame >= RB.k;
    }
    function rbLoadSlot(s) {
      var t0 = performance.now();
      if (!n64sLoad(s.buf)) return false;
      rbglLoad(s);
      var st = G.__fbAsync;
      if (st && st.on && st.restore) st.restore(s.fb);
      if (RFS.on) rfsNote();     // a load can bring back a blank capture the replaced timeline superseded
      var dt = performance.now() - t0, M = G.Module;
      // a load that had to wipe the code cache (the guest rewrote its TLB since the snapshot) is not
      // what a rollback costs; nor are the frames re-run after it (they recompile): RB.cold
      if (M && typeof M._neil_state_last_load_mode === 'function' && M._neil_state_last_load_mode() === 2) {
        RB.wipes = (RB.wipes | 0) + 1; RB.wipeMs = (RB.wipeMs || 0) + dt; RB.cold = true;
      } else {
        // ...and one sample is at most 4 saves: a load is the same state copy plus an 8 MB compare of
        // the code pages (measured 2.3-2.7x a save); past that it is a transient (a first touch, a GPU
        // wait), which the trimmed mean would take as the price until 8 loads exist — and a room that
        // rarely corrects may never make 8
        rbEstPush(RBE.load, RB.saveEma > 0 ? Math.min(dt, 4 * RB.saveEma) : dt); RB.loadEma = rbEstGet(RBE.load);
      }
      RB.loads++;
      return true;
    }
    // One frame on the core: the image (kept, for a later bridge), one
    // neil_ls_run_frame, and — when the schedule wants it — the start of the
    // next frame saved. `present` frames also carry the page's own bookkeeping
    // (capacity, the test seams); a re-simulated or hidden one carries none.
    // `kind` ('present' | 'hidden' | 'resim', default by `present`) decides the FRAME SKIP (RFS).
    function rbStep(ls, k, image, present, skipGl, kind) {
      var M = G.Module, j = k % RB_IMG, h = RB.img[j];
      if (!h || h.length !== image.length) h = RB.img[j] = new Uint8Array(image.length);
      if (h !== image) h.set(image);
      RB.imgF[j] = k;
      lsApplyImage(h);
      var t0 = performance.now();
      kind = kind || (present ? 'present' : 'resim');
      var fsk = rfsBegin(kind, k);
      if (skipGl && !fsk) { GLSKIP.on = true; GLSKIP.frames++; }
      try { M._neil_ls_run_frame(); }
      catch (e) {
        // THE CORE ABORTED INSIDE THE FRAME (Aborted(OOM), a trap): the machine is half-run and no
        // snapshot holds it. Running the frame again — what the next tick did — runs it on top of
        // the half: never. The room ends, saying why.
        N64S.fault = 'the core aborted inside frame ' + k + ': ' + ((e && e.message) || e);
        return false;
      }
      finally { GLSKIP.on = false; rfsEnd(kind, k, fsk, present); }
      // TEST SEAM (n64/tools/n64_rollback_probe.mjs --ranlog): frame k has just run (again). Absent unless a rig sets it.
      if (G.__n64RanTap) { try { G.__n64RanTap(k, kind); } catch (e) {} }
      // a skipped frame's pixels reached the guest: re-run before anything is saved or shown
      var tc = rfsTaintCheck(ls, k);
      if (tc !== true) { N64S.fault = tc; return false; }
      var dt = performance.now() - t0;
      if (!present && !RFS.inRerun && !RB.cold) { rbEstPush(RBE.run, dt); RB.runEma = rbEstGet(RBE.run); }
      if (present) { RB.cold = false; lsFrameDone(image, dt); }
      if (!rbWantSave(ls, k + 1, present)) { RB.skippedSaves++; return true; }
      return rbSaveAt(ls, k + 1);
    }
    // A rollback: the newest snapshot at or before plan.from, the bridge to
    // plan.from on the inputs those frames already ran with, then the plan.
    function rbResim(ls, plan, skipGl) {
      var from = plan.from, s = rbAtOrBelow(from), k;
      if (!s) { RB.missingSlot++; return 'rollback to frame ' + from + ' found no savestate at or before it'; }
      for (k = s.frame; k < from; k++) {
        if (RB.imgF[k % RB_IMG] !== k) return 'rollback to frame ' + from + ': the input frame ' + k + ' ran with is no longer held';
      }
      rbDropAbove(s.frame);
      if (!rbLoadSlot(s)) return 'rollback load failed: ' + N64S.fault;
      GLSKIP.taint = false;
      for (k = s.frame; k < from; k++) {
        if (!rbStep(ls, k, RB.img[k % RB_IMG], false, skipGl)) return 're-simulation save failed: ' + N64S.fault;
        RB.bridgeFrames++;
      }
      for (var i = 0; i < plan.frames.length; i++) {
        var fr = plan.frames[i];
        if (!rbStep(ls, fr.frame, fr.image, false, skipGl)) return 're-simulation save failed: ' + N64S.fault;
      }
      // A frame skipped its draws and the core then read pixels: re-run it all.
      if (skipGl && GLSKIP.taint) { GLSKIP.redo++; return 'redo'; }
      return true;
    }
    // K, re-decided once a second from what this console measures (see SPARSE
    // SNAPSHOTS). F is the field period, W the room's current G.
    function rbCostK(k, W, F) {
      var run = RB.runEma, save = RB.saveEma, load = RB.loadEma || save, p = RB.pEma, D = Math.max(1, RB.depthEma || 1);
      return { exp: (1 + p * D) * save / k + p * (load + (k - 1) / 2 * run),
               worst: load + (W + k - 1) * run + Math.ceil((W + k) / k) * save };
    }
    function rbAdaptK(ls) {
      if (RB.kFixed || RB.frames - RB.kAt < 50) return;
      RB.kAt = RB.frames;
      if (!(RB.runEma > 0) || !(RB.saveEma > 0)) return;
      var F = LS.viHz > 0 ? 1000 / LS.viHz : 1000 / 60, W = Math.max(1, ls.rollback | 0);
      var best = 0, bestExp = Infinity, safe = 0, safeWorst = Infinity;
      for (var k = 1; k <= RB_K_MAX; k++) {
        var c = rbCostK(k, W, F);
        if (c.worst <= 2 * F && c.exp < bestExp - 1e-6) { bestExp = c.exp; best = k; }
        if (c.worst < safeWorst - 1e-6) { safeWorst = c.worst; safe = k; }
      }
      var nk = best || safe || 1;
      // HYSTERESIS. A real desktop host (MK64, run 12.7 ms, no K fitting two fields) flipped
      // K 1 <-> 8 every few seconds: with nothing fitting, `safe` is decided by run vs save,
      // and EMAs that wander across that line flip it. Every flip frees or allocates 16.8 MB
      // states and re-publishes the window this console can hold. So K moves only when the
      // move is worth it: into a K that fits when the current one does not; otherwise when
      // it cuts the expected cost (or, with nothing fitting, the worst case) by 15%.
      if (nk !== RB.k && RB.k >= 1) {
        var cur = rbCostK(RB.k, W, F), nxt = rbCostK(nk, W, F), curFits = cur.worst <= 2 * F;
        if (best && curFits && nxt.exp > cur.exp * 0.85) nk = RB.k;
        else if (!best && nxt.worst > cur.worst * 0.85) nk = RB.k;
        if (nk === RB.k) RB.kHeld = (RB.kHeld | 0) + 1;
      }
      if (nk !== RB.k) {
        var c1 = rbCostK(nk, W, F);
        RB.kWhy = 'p=' + RB.pEma.toFixed(3) + '/frame depth=' + (RB.depthEma || 0).toFixed(1) + ' run=' + RB.runEma.toFixed(2)
                + ' save=' + RB.saveEma.toFixed(2) + ' load=' + (RB.loadEma || 0).toFixed(2) + ' ms -> ' + c1.exp.toFixed(2)
                + ' ms/frame expected, worst rollback ' + c1.worst.toFixed(1) + ' ms' + (best ? '' : ' (no K fits two fields)');
        env.log('[rollback] snapshot every ' + RB.k + ' -> ' + nk + ' frames: ' + RB.kWhy);
        RB.k = nk; RB.kChanges++;
        rbPublishCap('snapshot every ' + nk + ' frames');
        if (G.__n64RbLog) G.__n64RbLog.push(['k', RB.frames, nk]);
      }
    }
    // ls.selfStepMs — what ONE frame of a window-deep rollback costs this
    // console, every part of it measured here: the load (once per rollback),
    // the run, the K-1 bridge frames a sparse snapshot can add, and the saves
    // the re-simulation makes. The host sizes the window's slack by it and
    // rbCatchUp() spends at most half a field of it per tick; under-reporting it
    // is how a room gets a window this console cannot re-simulate in time.
    function rbStepMs(ls) {
      var W = Math.max(2, ls.rollback | 0), k = RB.k;
      var ms = ((RB.loadEma || 0) + (W + k - 1) * RB.runEma + Math.ceil(W / k) * RB.saveEma) / W;
      return ms > 0 ? ms : 0;
    }
    // ls.selfPresentMs — what a PRESENTED rollback frame costs this console: the frame and its share
    // of the snapshots (one every K frames, plus the after-state of every fingerprinted frame, which
    // every console saves whatever its K: rbWantSave). lib/netplay.js prices presented frames at this
    // and re-simulated ones at selfStepMs (_capMean). Measured parts only; the run is 0 before Ready.
    function rbPresentMs(ls) {
      var save = RB.saveEma || LS_RB.saveMs || 0, run = RB.runEma || LS.costAvg || 0, k = RB.k || 1, he = ls.hashEvery | 0;
      var ms = run + save * Math.min(1, 1 / k + (he > 0 ? 1 / he : 0));
      return ms > 0 ? ms : 0;
    }
    // The same step, ESTIMATED where no rollback frame is running: in a gated
    // room's delay stretch (lsFeed) and before Ready (lsRbProve). The run is the
    // frame cost this console measures on every frame it runs (LS.costAvg — the
    // same _neil_ls_run_frame wall time rbStep measures), the save and load are
    // the last ones measured (RB.*Ema; before any: the save timed in
    // lsRbProve, and a load taken to cost what a save does — both are one
    // 16.8 MB state copy), K the last one chosen, the window the one the room
    // returns to. 0 = nothing measured yet.
    function rbStepEstimate(ls) {
      var save = RB.saveEma || LS_RB.saveMs || 0;
      if (!(save > 0)) return 0;
      var load = RB.loadEma || save, run = RB.runEma || LS.costAvg || 0, k = RB.k || 1;
      var W = Math.max(2, (ls.rollback | 0) || (ls._capW | 0) || RB_WINDOW);
      return (load + (W + k - 1) * run + Math.ceil(W / k) * save) / W;
    }
    // ⚠ THE SAVE COST GOES STALE IN A DELAY STRETCH, AND THE ROOM NEVER CAME BACK. No
    // snapshot is taken in delay lockstep, so RB.saveEma / RB.loadEma stayed whatever they
    // were when rollback was last unaffordable — MEASURED (n64_rollback_probe, SM64, the
    // worker core slowed 6x for 20 s then given its speed back): the frame cost fell to
    // 3.8 ms, but the published step stayed 22.7 ms on the slow period's saves and loads
    // and the room sat in delay for the remaining 55 s. So every RB_REMEASURE_MS of a
    // capacity-gated delay stretch this console times ONE real save into the state scratch
    // buffer the save path already owns (raw API only: no allocation, no gzip, nothing the
    // guest can see — a rollback console saves every frame). The load moves with it: a load
    // is the same 16.8 MB state copy, so the last measured load:save ratio is kept.
    var RB_REMEASURE_MS = 3000;
    function rbRemeasure() {
      var now = performance.now();
      if (now - (RB.remeasAt || 0) < RB_REMEASURE_MS) return;
      RB.remeasAt = now;
      if (!n64sRawOk()) return;
      var old = RB.saveEma || LS_RB.saveMs || 0, t0 = performance.now();
      if (!n64sSave(null)) return;
      var dt = performance.now() - t0;
      rbEstPush(RBE.resave, dt); RB.saveEma = rbEstGet(RBE.resave);
      if (RB.loadEma && old > 0) RB.loadEma *= RB.saveEma / old;
      RB.remeasures = (RB.remeasures | 0) + 1;
    }
    function rbFail(ls, why) {
      LS.fault = why;
      env.log('[rollback] ⚠ ' + why);
      try { ls.fail(why); } catch (e) {}
      return false;
    }
    function rbRunFrame(ls, r, hidden) {
      if (!RB.ready && !rbInit(ls)) return rbFail(ls, 'rollback could not start: ' + (RB.fault || N64S.fault));
      if (RB.stale) {
        // (see rbRearm) A correction across the return would need a state this
        // console never kept — the engine promises none; refuse rather than guess.
        if (r.rollback) return rbFail(ls, 'a correction reached back across the switch to rollback (frame ' + r.rollback.from + ' < ' + r.frame + ')');
        // delay frames ran through the worker's own frame-skip machinery: settle it first, so no
        // blank capture is live in the state the ring re-arms at (RFS)
        if (env.fs && RFS.on) env.fs.settleLinear();
        if (!rbRearm(ls, r.frame | 0)) return rbFail(ls, 'rollback could not resume: ' + RB.fault);
      }
      if (r.rollback) {
        var ta = performance.now();
        audioFlushNow();
        RFS.inResim = true;
        var rr;
        try {
          rr = rbResim(ls, r.rollback, glSkipOk());
          if (rr === 'redo') rr = rbResim(ls, r.rollback, false);
        } finally { RFS.inResim = false; }
        if (rr !== true) return rbFail(ls, rr);
        audioDropNow();
        var d = r.rollback.depth | 0, ms = performance.now() - ta;
        RB.rollbacks++; RB.resimFrames += r.rollback.frames.length; RB.resimMs += ms; RB.depthSum += d;
        RB.depthEma = RB.depthEma ? RB.depthEma + (d - RB.depthEma) / 16 : d;
        if (d > RB.maxDepth) RB.maxDepth = d;
        if (ms > RB.maxResimMs) RB.maxResimMs = ms;
        RB.depthHist[d] = (RB.depthHist[d] || 0) + 1;
        if (G.__n64RbLog) G.__n64RbLog.push(['rb', r.frame, r.rollback.from, d]);
      }
      if (hidden) {
        // A HIDDEN catch-up frame (ls.rbCatchUp): a frame of the room this console
        // is behind on. Run like a re-simulation — its audio dropped, no page
        // bookkeeping — so the speakers stay at 1.000x (gate 9). The governor's
        // schedule moves with it (baseFrame), so it is never repaid as a sprint.
        audioFlushNow();
        RFS.inResim = true;
        var okh;
        try { okh = rbStep(ls, r.frame, r.image, false, false, 'hidden'); } finally { RFS.inResim = false; }
        audioDropNow();
        if (!okh) return rbFail(ls, 'frame failed: ' + N64S.fault);
        RB.hidden++; LS.frame++; LS.baseFrame++;
        if (G.__n64RbLog) G.__n64RbLog.push(['hidden', r.frame]);
      } else {
        if (!rbStep(ls, r.frame, r.image, true, false)) return rbFail(ls, 'frame failed: ' + N64S.fault);
        RB.frames++;
        RB.pEma += ((r.rollback ? 1 : 0) - RB.pEma) / 128;
        rbAdaptK(ls);
      }
      // FRAME SKIP: a blank capture about to outlive the ring is resolved now (RFS)
      var fsr = rfsSettle(ls, false);
      if (fsr !== true) return rbFail(ls, fsr);
      RB.stepMs = rbStepMs(ls);
      if (RB.stepMs) { ls.selfStepMs = RB.stepMs; ls.selfPresentMs = rbPresentMs(ls); }
      ls.endFrame(null);
      // FINGERPRINTS OF CONFIRMED FRAMES ONLY: the state after k is the snapshot
      // of k+1, which every console saves whatever its K (rbWantSave).
      var due = ls.takeHashDue ? ls.takeHashDue() : [];
      for (var j = 0; j < due.length; j++) {
        var after = rbSlot(due[j] + 1);
        if (!after) { RB.missingSlot++; continue; }
        after.pin = -1;
        if (!ls.fieldNames) ls.fieldNames = N64S_FIELDS;
        ls.submitHash(due[j], n64sHashRoom(after.buf, after.fp), n64sRoomWords(after.buf, after.fp));
        LS.hashes++; RB.hashes++;
        // TEST SEAM (n64/tools/n64_rollback_probe.mjs): the confirmed state, for a
        // rig to hash in full against a straight run. Absent unless a rig sets it.
        if (G.__n64RbTap) { try { G.__n64RbTap(due[j], after.buf, after.fp); } catch (e) {} }
      }
      return true;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RUN-AHEAD — the game's OWN lag frames, taken out of what the player sees.
    //
    // After the newest real frame (whose start-of-next state is already in the
    // ring), run RA hidden frames with this console's LATEST pad (remote ports:
    // their last input, as the engine predicts), leave the last one's picture
    // in the canvas, and load the real state back. A game that shows a press
    // two frames after it reads the pad shows it RA frames sooner — sooner than
    // on the hardware. The hidden frames make no sound (their samples are
    // dropped) and move nothing in the room: the real state is restored, with
    // its framebuffer-readback pin, before the next real frame, so whatever RA
    // this console chooses, its guest is the room's guest.
    //
    // ⚠ IT IS PAID FROM SPARE CAPACITY ONLY, AND ADAPTS. Each hidden frame costs a
    // frame of emulation plus one state load per real frame. RA starts at 0,
    // rises one frame at a time while the measured cost of a whole real tick
    // (frame + save + re-simulation + run-ahead) stays under RA_BUDGET of the
    // field period for RA_UP_MS, and falls to 0 the moment a tick overruns the
    // period — so run-ahead can never be the reason this console falls below
    // 1.000x. ?ra=N pins it (0 = off); ?ra=auto (default) adapts up to RA_MAX.
    // ═══════════════════════════════════════════════════════════════════════════
    var RA_Q = RB_Q.get('ra');
    // Run-ahead is off unless asked for (?ra=auto|N): GPU framebuffer state is not in
    // the savestate, so hidden frames are only proven exact on MK64.
    var RA_FIXED = RA_Q == null ? 0 : (RA_Q !== 'auto' ? Math.max(0, Math.min(4, +RA_Q | 0)) : null);
    var RA_MAX = 2, RA_BUDGET = 0.75, RA_UP_MS = 2000;
    var RA = { frames: RA_FIXED != null ? RA_FIXED : 0, fixed: RA_FIXED, runs: 0, hiddenFrames: 0, ms: 0,
               tickEma: 0, frameEma: 0, calmSince: 0, ups: 0, downs: 0, fault: null, lastImage: null };
    function raRun(ls) {
      var n = RA.frames;
      if (n <= 0 || !RB.ready || !RA.lastImage) return;
      var base = rbSlot(ls.frame | 0);
      if (!base) return;
      var t0 = performance.now(), M = G.Module;
      audioFlushNow();
      // The next frame's image as this console would build it now: the latest
      // local pad at this console's ports, every other port as last presented.
      var img = RA.lastImage.slice(0), mine = lsLocalPads();
      for (var p in mine) { var o = (+p) * LS_PAD_BYTES; if (o + LS_PAD_BYTES <= img.length) img.set(mine[p], o); }
      var skip = glSkipOk();
      for (var j = 0; j < n; j++) {
        lsApplyImage(img);
        if (skip && j < n - 1) { GLSKIP.on = true; GLSKIP.frames++; }
        try { M._neil_ls_run_frame(); } finally { GLSKIP.on = false; }
      }
      var ok = rbLoadSlot(base);
      if (env.fs && RFS.on) env.fs.taint();     // what hidden frames read is undone with them
      audioDropNow();
      if (!ok) { RA.fault = N64S.fault; RA.frames = 0; RA.fixed = 0; env.log('[runahead] ⚠ restore failed, run-ahead OFF: ' + N64S.fault); return; }
      RA.runs++; RA.hiddenFrames += n; RA.ms += performance.now() - t0;
    }
    // Called with the wall time of one whole real tick (every frame this lsFeed
    // pass ran, re-simulation and run-ahead included) and how many real frames it
    // advanced. The budget is the field period per real frame, judged on a
    // smoothed cost (a single rollback burst is not "no headroom"), and ANY time
    // the governor had to write off (LS.lostMs grew: this console ran late)
    // takes a hidden frame away at once.
    function raAdapt(tickMs, frames) {
      if (!(LS.viHz > 0) || frames <= 0) return;
      var period = 1000 / LS.viHz, per = tickMs / frames, now = performance.now();
      RA.tickEma = RA.tickEma ? RA.tickEma + 0.1 * (per - RA.tickEma) : per;
      var lost = LS.lostMs || 0, lostGrew = lost > (RA.lostSeen || 0);
      RA.lostSeen = lost;
      if (RA.fixed != null) return;
      if (RA.frames > 0 && (lostGrew || RA.tickEma > period * 0.9 || per > period * 3)) {
        // Give a hidden frame back at once: the guest rate is the product; the
        // head start is not.
        RA.frames--; RA.downs++; RA.calmSince = now; return;
      }
      if (!RA.calmSince || lostGrew || RA.tickEma > period * RA_BUDGET) { RA.calmSince = now; return; }
      // What one more hidden frame would add: one frame of emulation — and, for
      // the FIRST one, the state load raRun pays per tick and the present-frame
      // saves sparse snapshots otherwise skip (rbWantSave).
      var next = RA.tickEma + (LS.costAvg || per)
               + (RA.frames === 0 ? (RB.loadEma || 0) + (RB.k > 1 ? RB.saveEma * (1 - 1 / RB.k) : 0) : 0);
      if (RA.frames < RA_MAX && next < period * RA_BUDGET && now - RA.calmSince > RA_UP_MS) {
        RA.frames++; RA.ups++; RA.calmSince = now;
      }
    }

    // The page's own bookkeeping for a frame that is PRESENTED (lockstep, or the
    // newest frame under rollback) — never for a re-simulated or hidden one.
    function lsFrameDone(img, dt) {
      var M = G.Module;
      // ⚠ TEST SEAM — THE BYTES THE CORE WAS ACTUALLY HANDED, recorded AFTER
      // lsApplyImage so it is the same array that reached _neil_ls_set_pad and
      // not an intention. genesis.html publishes the identical thing as
      // G.__genLsImage; this is the N64 half, and without it there is no way
      // to prove from outside that a press on one machine reached the OTHER
      // machine's core rather than merely reaching its network layer. A roster
      // entry or a `running` flag cannot tell those two apart.
      // ⚠ WRITTEN IN PLACE, NOT ALLOCATED: this runs on every presented frame.
      try {
        var _im = G.__n64LsImage;
        if (!_im || _im.length !== img.length) _im = G.__n64LsImage = new Array(img.length);
        for (var _i = 0; _i < img.length; _i++) _im[_i] = img[_i];
      } catch (e) {}
      // Run-ahead builds its hidden frames' image from the last presented one.
      if (!RA.lastImage || RA.lastImage.length !== img.length) RA.lastImage = new Uint8Array(img.length);
      RA.lastImage.set(img);
      // THIS CONSOLE'S CAPACITY, measured on the frames it actually runs: wall ms
      // inside one frame (the whole mainLoopInner — emulation AND the GL it
      // issues). cap = field period / mean cost; published to the room.
      LS.costAvg = LS.costAvg ? LS.costAvg + 0.02 * (dt - LS.costAvg) : dt;
      rbEstPush(RBE.run, dt); RB.runEma = rbEstGet(RBE.run);
      // Frames that alone cost more than a field period — a burst this device
      // cannot absorb inside the governor's two-period allowance if it repeats.
      if (LS.viHz > 0 && dt > 1000 / LS.viHz) { LS.costOver = (LS.costOver || 0) + 1; if (dt > (LS.costMax || 0)) LS.costMax = dt; }
      LS.frame++;
      try { lsGlWitness(); } catch (e) {}
      try { LS.lastFp = M._neil_last_fp ? (M._neil_last_fp() >>> 0) : 0; } catch (e) { LS.lastFp = 0; }
      // TEST SEAM: (frame, fingerprint) of the last FPR_N presented frames, so a rig comparing
      // two consoles compares EVERY frame, not the frames two independent polls happened to hit.
      FPR.f[FPR.n % FPR_N] = LS.frame; FPR.v[FPR.n % FPR_N] = LS.lastFp; FPR.n++;
      latWitness();
      // TEST SEAM (n64/tools/n64_rollback_probe.mjs --pics): the engine frame this picture is of,
      // for a rig to hash the window. Absent unless a rig sets it.
      if (G.__n64PicTap) { try { G.__n64PicTap(LS.lastPresentFrame | 0); } catch (e) {} }
    }
    function lsRunOneFrame(img) {
      var M = G.Module;
      if (!M || !M._neil_ls_run_frame) return false;
      lsApplyImage(img);
      var _t0 = performance.now();
      // FRAME SKIP (RFS): delay lockstep never rewinds, so its frames go through the worker's own
      // machinery (fsField: skip, snapshot, re-run on a read-back) — exact before lsFrameDone
      // fingerprints the frame
      try {
        if (env.fs && RFS.on && env.fs.linear) { RFS.linear++; env.fs.linear(); }
        else M._neil_ls_run_frame();
      } catch (e) {
        // the core aborted inside the frame (see rbStep): the room ends rather than run it again
        LS.abort = 'the core aborted inside a frame: ' + ((e && e.message) || e);
        return false;
      }
      lsFrameDone(img, performance.now() - _t0);
      return true;
    }

    // ---- LOCAL INPUT LATENCY, AS THE ENGINE APPLIES IT (test witness) --------
    // When this console's own pad changes, note the engine frame that is NEXT to
    // run; when a presented frame carries the new pad at this console's port,
    // the difference is the input lag the ROOM adds, in frames: `delay` under
    // lockstep (+1 when the change landed after that frame's first attempt), 0
    // under rollback. The game's own lag frames come on top of it and are
    // measured separately (n64/tools/n64_lag_probe.mjs); run-ahead subtracts them.
    var LAT = { pending: null, last: null, samples: [], overlapped: 0 };
    function latNote(pads) {
      var ls = env.engine(); if (!ls || !LS.running) return;
      var port = ls.localPorts && ls.localPorts.length ? ls.localPorts[0] : 0;
      var b = pads && pads[port]; if (!b) return;
      var key = b[0] + ',' + b[1] + ',' + b[2] + ',' + b[3];
      if (key === LAT.last) return;
      LAT.last = key;
      if (LAT.pending) LAT.overlapped++;
      LAT.pending = { key: key, port: port, frame: ls.frame | 0, t: performance.now() };
    }
    function latWitness() {
      var P = LAT.pending, im = G.__n64LsImage; if (!P || !im) return;
      var o = P.port * LS_PAD_BYTES;
      if ((im[o] + ',' + im[o + 1] + ',' + im[o + 2] + ',' + im[o + 3]) !== P.key) return;
      // LS.lastPresentFrame is the engine frame this image was run as; P.frame
      // the frame that was next when the change was sampled.
      LAT.samples.push({ frames: Math.max(0, (LS.lastPresentFrame | 0) - P.frame), ms: Math.round(performance.now() - P.t) });
      if (LAT.samples.length > 200) LAT.samples.shift();
      LAT.pending = null;
    }

    function lsFeed() {
      var ls = env.engine();
      if (!LS.armed || !ls) return;
      // The BARRIER decides when frame 0 runs, not this page. Until the engine
      // says running/stalled nothing is fed and this core sits at frame 0 — which
      // is precisely what "everyone starts together" means.
      if (ls.state !== 'running' && ls.state !== 'stalled') {
        if (LS.running) { LS.running = false; env.log('[lockstep] frame gate DISENGAGED — engine state ' + ls.state); }
        return;
      }
      if (!LS.running) {
        // The pre-roll runs HERE, when the room starts — not when main() returns.
        // MEASURED: run right after callMain, it was the core's FIRST retro_run
        // (plugin + option initialisation) and it then happened BEFORE the rest of
        // dist/script.js's start-up on one console and not the other, and a
        // two-tab room (mobile host, desktop joiner) diverged at frame 0 in every
        // region of the state; the HEAD page, whose first retro_run is the room's
        // frame 0, did not. Here every console has finished booting.
        try { lsPreroll(); } catch (e) { env.log('[lockstep] pre-roll threw: ' + ((e && e.message) || e)); }
        LS.running = true;
        LS.startedAt = ls.frame | 0;        // "everyone started together at frame N"
        LS.baseWall = 0;                    // anchor the governor at the real start
        LS.hashSink = (typeof ls.endFrame === 'function');
        // The engine's pace window compares frames run against this: a slow
        // MACHINE loses frames without waiting, a slow LINK loses them waiting.
        if (LS.viHz > 0) ls.frameHz = LS.viHz;
        env.log('[lockstep] FRAME GATE ENGAGED at frame ' + ls.frame + ' — ' + (ls.rollback
                ? 'ROLLBACK, window ' + ls.rollback + ' frames: this console applies its own input with 0 frames '
                  + 'of delay, predicts the others and re-simulates when a prediction was wrong'
                : 'this core advances only when every seated port has an input for the frame. delay=' + ls.delay + ' frames')
              + ', ports=' + JSON.stringify(ls.roster) + ', mine=' + JSON.stringify(ls.localPorts)
              + ', pacing to ' + (LS.viHz > 0 ? LS.viHz + ' Hz from the ROM header' : 'UNPACED (ROM header unreadable)'));
      }
      // ⚠ BOUNDED, AND THE BOUND IS THE GOVERNOR. The engine can never cover more
      // than `delay` frames ahead anyway, but the real limiter here is lsDueNow():
      // this loop stops the moment the guest would get ahead of wall time, which
      // is what keeps the guest at 1.000x rather than sprinting through a backlog.
      var guard = 0, ran = 0, tick0 = performance.now();
      if (ls.rollback) {
        // ADAPTIVE ROOM (lib/netplay.js, the block above rbCatchUp): the ring
        // follows the window, the credit follows rbPace(), and a console behind
        // the room clock runs the hidden catch-up frames it is granted, first.
        if (RB.ready && typeof ls.rbRingFrames === 'function' && RB.n < ls.rbRingFrames() && !rbGrow(ls.rbRingFrames())) {
          rbFail(ls, 'rollback could not grow its ring: ' + RB.fault); return;
        }
        if (typeof ls.rbPace === 'function') {
          var pace = ls.rbPace();
          if (pace !== LS.pace) { LS.pace = pace; LS.baseWall = 0; }   // re-anchor at the new period
        }
        if (RB.ready && typeof ls.rbCatchUp === 'function') {
          var cu = ls.rbCatchUp();
          for (var ci = 0; ci < cu; ci++) {
            var rh = ls.beginFrame(lsLocalPads(), { hidden: true });
            if (!rh || !rh.ready || !rbRunFrame(ls, rh, true)) break;
            ran++;
          }
        }
      }
      while (lsDueNow()) {
        var pads = lsLocalPads();
        latNote(pads);
        if (ls.rollback && RB.ready && typeof ls.rbRingFrames === 'function' && RB.n < ls.rbRingFrames() && !rbGrow(ls.rbRingFrames())) {
          rbFail(ls, 'rollback could not grow its ring: ' + RB.fault); break;
        }
        var r = ls.beginFrame(pads);
        if (!r || !r.ready) {
          if (!LS.stalling && r && r.reason === 'stall') { LS.stalls++; LS.stallSince = performance.now(); }
          LS.stalling = !!(r && r.reason === 'stall');
          LS.stallReason = r ? r.reason : 'the engine returned nothing';
          LS.waitingOn = (r && r.waitingOn) ? r.waitingOn.slice() : [];
          if (r && r.reason === 'advantage') {
            // ROLLBACK TIME SYNC: this console is ahead of the room and the engine
            // withholds ONE frame. That is a slowdown (the direction gate 9
            // allows), so the governor's schedule moves by one period instead of
            // re-running the frame on the next tick, which would undo it.
            if (LS.baseWall && LS.viHz > 0) LS.baseWall += 1000 / LS.viHz;
            LS.advWaits = (LS.advWaits | 0) + 1;
            break;
          }
          // A stall must not be repaid. Re-anchoring the governor here is what
          // stops the core sprinting to "catch up" when the input finally lands —
          // time lost to a stall stays lost, which is correct: everybody lost it.
          if (!LS_REPAY_MS) LS.baseWall = 0;
          break;
        }
        if (LS.stalling) {
          LS.stallMs += performance.now() - LS.stallSince;
          LS.stalling = false; LS.waitingOn = []; LS.stallReason = null;
        }
        LS.lastPresentFrame = r.frame | 0;
        // The HOST decided lockstep or rollback ('lsgo' carries it) — never this
        // page's own query string, which only says what THIS console proposes.
        if (ls.rollback) {
          if (!rbRunFrame(ls, r)) break;
          LS.fed++; ran++;
          if (++guard > 240) { env.log('[lockstep] ⚠ feed loop hit its 240-frame bound — not sprinting the guest'); break; }
          // ⚠ ONE TASK NEVER HOLDS THE PAGE FOR MORE THAN ABOUT A FIELD. On a
          // device without the capacity for the re-simulation the room asks of it,
          // every pass of this loop is slower than a field, the governor keeps
          // finding a frame due, and the loop ran on for minutes inside one task —
          // MEASURED: a CPU-throttled two-tab room whose joiner froze its tab until
          // the rig's 240 s protocol timeout. Yield; the next tick continues.
          if (LS.viHz > 0 && performance.now() - tick0 > 1000 / LS.viHz) break;
          // ONE PRESENTED FRAME PER TASK where the canvas is committed per task (the core
          // worker's OffscreenCanvas): the rest of what is due runs in the next task, queued at
          // once, so every frame's picture is committed instead of overwritten unseen. Only
          // the task boundaries move; every frame runs with exactly the input it ran with.
          if (env.oneFramePerTask) { env.kick(); break; }
          continue;
        }
        // the ring goes away below: no blank capture may need it afterwards (RFS)
        if (RB.ready && !RB.stale) { var fss = rfsSettle(ls, true); if (fss !== true) { rbFail(ls, fss); break; } }
        if (!lsRunOneFrame(r.image)) {
          LS.fault = LS.abort || 'this build of the core has no _neil_ls_run_frame — rebuild n64/N64Wasm/code';
          env.log('[lockstep] ⚠ ' + LS.fault);
          if (LS.abort) { try { ls.fail(LS.fault); } catch (e) {} }
          break;
        }
        LS.fed++; ran++;
        // A frame the ring did not see: the next rollback frame re-arms it (rbRearm).
        // Nothing in the ring can be loaded again, so its states (16.8 MB each, and
        // the framebuffer pins they hold) go back now — a phone's memory — rather
        // than sitting through the delay stretch; rbRearm allocates afresh.
        if (RB.ready && !RB.stale) { rbRelease(); RB.stale = true; }
        // A CAPACITY-GATED ROOM IN DELAY keeps telling the host what rollback
        // would cost this console now (lib/netplay.js _capDecide reads `st` to
        // decide a return to zero-lag mode): without this the step stays what it
        // was at the switch — the very measurement that said it could not afford
        // it — and the room never comes back.
        if (ls._capGate) { rbRemeasure(); var se = rbStepEstimate(ls); if (se > 0) { ls.selfStepMs = se; ls.selfPresentMs = rbPresentMs(ls); } }
        // ⚠ THE CORE IS IN THIS PAGE AND IS SYNCHRONOUS, so unlike dreamcast.html
        // the fingerprint for the frame just run is available RIGHT NOW and goes
        // straight into endFrame(). That is the shape lib/netplay.js's endFrame
        // was written for; the submitHash() late-delivery path exists for cores in
        // a worker and is not needed here.
        //
        // Frame-gated cores with NOTHING comparing them is worse than not gating
        // at all, because it looks right — so the hash is fed on every frame the
        // engine wants one for, and LS.hashSink records whether it was taken.
        var wantHash = (typeof ls.wantsHash === 'function') ? ls.wantsHash() : true;
        if (wantHash && LS.lastFp) { ls.endFrame(LS.lastFp, [LS.lastFp]); LS.hashes++; }
        else ls.endFrame(null);
        // TEST SEAM (n64/tools/n64_rollback_probe.mjs, a delay-lockstep room): the state after
        // every 10th frame, for a rig to hash in full against a straight run — the check a
        // rollback room gets from its confirmed snapshots. Absent unless a rig sets it.
        if (G.__n64RbTap && ((r.frame | 0) % 10) === 0) {
          var tb = N64S.tapBuf || (N64S.tapBuf = n64sRawOk() ? n64sRawAlloc() : new Uint8Array(N64S.size + N64S_SM));
          if (tb && n64sSave(tb)) { try { G.__n64RbTap(r.frame | 0, tb, LS.lastFp); } catch (e) {} }
        }
        if (++guard > 240) { env.log('[lockstep] ⚠ feed loop hit its 240-frame bound — not sprinting the guest'); break; }
        if (env.oneFramePerTask) { env.kick(); break; }     // see the rollback branch above
      }
      // RUN-AHEAD: once per tick, after the newest real frame, and only when a
      // real frame ran (a tick that ran none leaves the last picture up).
      if (ran && ls.rollback && RB.ready) {
        try { raRun(ls); } catch (e) { RA.fault = (e && e.message) || String(e); RA.frames = 0; RA.fixed = 0; }
        raAdapt(performance.now() - tick0, ran);
      }
      // THE AUDIO FEED RIDES THE FRAMES, NOT A CLOCK OF ITS OWN: what this tick's
      // real frames produced goes to the worklet now, in the same task, instead of
      // waiting up to 8 ms for the pump's timer — so a burst of frames (a tick
      // that ran two, a rollback tick that took long) reaches the cushion as one
      // delivery and a tick that ran none leaves it to the timer.
      if (ran) audioFlushNow();
    }

    // THE PRE-ROLL: one frame, neutral pads on all four ports, run by EVERY
    // console when the room starts, just before the room's frame 0 (lsFeed). The core
    // initialises its CPU and video plugin inside its first retro_run
    // (libretronew.c first_time -> emu_step_initialize), so without this the
    // state at the room's frame 0 would be a pre-boot image a rollback could not
    // load. It is the same frame on every machine (same ROM, same neutral input,
    // fresh boot), so the room still starts from one guest state; the disc tag's
    // 'r1' keeps a console that does not pre-roll out of the room.
    // ROLLBACK-CAPABLE IS PROVEN, NOT ASSUMED. The engine reads rbCapable when
    // this console declares (declareReady 'rb'), and a room rolls back only if
    // every console said it can (lib/netplay.js). So, between main() returning
    // and the declare, this page does what a rollback will need: one raw save
    // (which also runs the one-time 512 MB heap scans for the state buffer and
    // the save memory — here, while the room is still loading, not on frame 0).
    // Nothing is LOADED here: before the pre-roll the
    // core is pre-boot (lsPreroll) and a load would change the frame everyone
    // starts from. Any failure declares this console NOT rollback-capable, so
    // the room runs delay lockstep instead of failing on its first save.
    // Likewise a read_always title with SYNCHRONOUS framebuffer readback
    // (?fbasync=0): the GPU frame a re-simulated frame reads is not in any
    // savestate and no fbasync pin restores it.
    var LS_RB = { proven: null, why: null, ms: 0, saveMs: 0 };
    function lsRbRefuse(why) {
      LS_RB.proven = false; LS_RB.why = why;
      var ls = env.engine();
      if (ls) ls.rbCapable = false;
      env.log('[rollback] this console declares itself NOT rollback-capable — ' + why + '; the room runs delay lockstep');
    }
    function lsRbProve() {
      if (LS_RB.proven != null) return LS_RB.proven;
      var ls = env.engine();
      if (!ls || !ls.rbCapable) { LS_RB.proven = false; LS_RB.why = 'not offered'; return false; }
      var st = G.__fbAsync || {};
      if (st.readAlways && !st.on) { lsRbRefuse('this title reads the framebuffer back every frame and readback is synchronous here (?fbasync=0)'); return false; }
      // ⚠ ONE SAVE, NOT TWO COMPARED. Two back-to-back saves of this pre-boot
      // core were measured to differ (raw API, MK64: byte 381640, inside RDRAM),
      // so equality is not a property of a core that has not run its first frame
      // — it refused rollback on every console. Exactness is the rollback
      // probe's job (n64_rollback_probe, full-state hash against a straight run);
      // this check proves only that the path EXISTS on this console: the state
      // and save memory are found and a save succeeds.
      var t0 = performance.now(), a = null;
      try { a = G.__n64State.alloc(); } catch (e) { a = null; }
      if (!a) { lsRbRefuse('no memory for a savestate'); return false; }
      var ok = n64sSave(a);
      // THE STEP, AS FAR AS IT CAN BE MEASURED BEFORE READY (lib/netplay.js reads
      // `st` at the barrier: a console that cannot afford rollback STARTS the
      // room in delay lockstep, at the delay the RTT pings chose, with no
      // start-up transient). A second save, timed on its own: the first one ran
      // the one-time heap scans. No frame can run here (lsPreroll: the core is
      // pre-boot until the room starts) and nothing is loaded (it would change
      // the frame everyone starts from), so the run is not in it and the load is
      // taken to cost what the save does: what is published is the part of the
      // step this console can already prove — never more than it will measure.
      if (ok) {
        var ts = performance.now();
        if (n64sSave(a)) LS_RB.saveMs = performance.now() - ts;
      }
      try { G.__n64State.free(a); } catch (e) {}
      if (!ok) { lsRbRefuse(N64S.fault || 'the savestate failed'); return false; }
      if (LS_RB.saveMs > 0 && ls) {
        var est = rbStepEstimate(ls);
        if (est > 0) {
          ls.selfStepMs = est; ls.selfPresentMs = rbPresentMs(ls);
          env.log('[rollback] step before Ready: ' + est.toFixed(2) + ' ms (save ' + LS_RB.saveMs.toFixed(2)
                + ' ms, the load taken as one more; the frame itself is measured once the room runs)');
        }
      }
      // How many snapshots this console can hold, known now so the engine has
      // it before Ready (lsready mw).
      var budget = Math.max(2, Math.floor(RB_RING_BUDGET_MB * 1048576 / rbSlotBytes())), held = budget;
      // (Raw: the buffer just saved into is back in the pool; nothing is
      // allocated to find the answer — see N64S_RAW_RESERVE.)
      if (N64S.raw) held = Math.max(2, Math.min(budget, n64sRawCapacity()));
      RB.preCap = held;
      // THE RING'S FIRST SLOTS ARE WRITTEN NOW, BEFORE READY, NOT BY THE ROOM'S FIRST FRAMES. A
      // slot is fresh heap and the first save into it page-faults all of it: MEASURED (this box,
      // SM64, 21.4 MB raw state) 18.2-19.2 ms into a fresh buffer against 2.6-3.0 ms into the same
      // one again. The ring starts one snapshot a frame (K=1) across its whole reach, so the first
      // ~13 frames of every room each cost 17-31 ms of saving (core_worker tick timing: save
      // 17.0-31.5 ms a frame) and the 1.000x governor, which never repays a late frame, dropped
      // 170-370 ms per console. Written here, unpaced, they go back to the pool rbPick takes from:
      // the slots the first frames would allocate anyway (never more than `held`), nothing more.
      if (N64S.raw) {
        var tw = performance.now(), warm = [], wb;
        for (var wi = Math.min(held, RB_WINDOW + 6); wi > 0 && (wb = n64sRawAlloc()); wi--) { wb.fill(0); warm.push(wb); }
        for (wi = 0; wi < warm.length; wi++) n64sFree(warm[wi]);
        env.log('[rollback] ' + warm.length + ' ring slots written ahead (' + Math.round(performance.now() - tw) + ' ms, before Ready)');
      }
      rbPublishCap('measured before Ready', held);
      LS_RB.proven = true; LS_RB.ms = performance.now() - t0;
      env.log('[rollback] savestate path proven before declaring (' + Math.round(LS_RB.ms) + ' ms' + (N64S.raw ? ', raw API' : ', heap scans included')
            + '): this console is rollback-capable');
      return true;
    }

    function lsPreroll() {
      var M = G.Module;
      if (LS.prerolled || !LS.armed || !M || !M._neil_ls_run_frame) return;
      LS.prerolled = true;
      lsApplyImage(new Uint8Array(4 * LS_PAD_BYTES));
      var t0 = performance.now();
      M._neil_ls_run_frame();
      env.log('[lockstep] pre-roll frame run (' + Math.round(performance.now() - t0) + ' ms): the core is initialised '
            + 'before the room\'s frame 0, so every frame of the room is a state that can be saved and loaded');
    }

    // ---- arming, and the ONE place the order matters --------------------------
    // Called from myApp.beforeRun, which dist/script.js:233 runs BEFORE
    // G.Module.callMain — so this core is put into lockstep mode before main() has
    // armed emscripten_set_main_loop and before a single frame could run.
    // ⚠ SOLO IS NOT TOUCHED: with no room this returns immediately and the core
    // boots exactly as it always did.
    function lsArmBeforeBoot() {
      if (!env.inRoom() || LS.armed) return false;
      var ls = env.engine();
      if (!ls) {
        LS.fault = 'the room published no lockstep engine, so this core cannot be frame-gated';
        env.log('[lockstep] ⚠ ' + LS.fault);
        return false;
      }
      var M = G.Module;
      if (!M || !M._neil_ls_arm) {
        LS.fault = 'this build of the core does not export _neil_ls_arm — it predates lockstep. '
                 + 'Rebuild n64/N64Wasm/code (make) so online play is deterministic instead of '
                 + 'silently running free.';
        env.log('[lockstep] ⚠ REFUSING TO GATE — ' + LS.fault);
        return false;
      }
      M._neil_ls_arm(1);
      try { env.onArmGl(); } catch (e) {}
      // Fingerprint every frame from here. This is the ONLY thing comparing the
      // two simulations; without it the cores would be gated and silently
      // diverging, which looks correct and is the failure the whole engine exists
      // to catch.
      try { if (M._neil_fp_always) M._neil_fp_always(1); } catch (e) {}
      LS.armed = true; LS.running = false; LS.frame = 0; LS.fed = 0; LS.hashes = 0;
      LS.baseWall = 0; LS.baseFrame = 0; LS.fault = null;
      // Latched here, not sampled by a rig later: the joiner arms second, and if
      // the barrier releases before its next poll the sampled frame has moved.
      LS.armedAtFrame = (typeof ls.frame === 'number') ? (ls.frame | 0) : 0;
      try { env.onArmKeys(); } catch (e) {}
      env.log('[lockstep] ARMED before the core ever ran a frame — mainLoop() is now inert and '
            + 'neil_ls_run_frame() is the only thing that advances this guest, so this core\'s '
            + 'frame 0 IS the room\'s frame 0');
      return true;
    }
    // ⚠ A GATED CORE WHOSE ROOM IS GONE IS A FROZEN CONSOLE. If the session ends
    // while the gate is armed, nothing ever feeds it again and the player is left
    // staring at a still picture with no room and no explanation. Leaving hands
    // the console back: the core's own loop resumes and the game carries on
    // single-player from exactly the frame it was holding.
    function lsDisarm(why) {
      if (!LS.armed) return;
      // the solo frame skip takes over from here and has no snapshot of the room's frames (RFS)
      try { if (RB.ready && !RB.stale) rfsSettle(env.engine() || {}, true); } catch (e) {}
      LS.armed = false; LS.running = false;
      LS.stalling = false; LS.waitingOn = []; LS.stallReason = null;
      try { if (G.Module && G.Module._neil_ls_arm) G.Module._neil_ls_arm(0); } catch (e) {}
      env.log('[lockstep] frame gate RELEASED — ' + why + '. This console free-runs from here and is '
            + 'no longer sharing frames with anybody.');
    }

    function lsSelfCap() { return (LS.viHz > 0 && LS.costAvg > 0) ? (1000 / LS.viHz) / LS.costAvg : 0; }

    // ---- IS THIS CONSOLE ACTUALLY DRAWING? --------------------------------------
    // Reported live: an Android host in a party showed its touch controls and
    // "Running." over a BLACK game area, while the joiner rendered the race. The
    // mobile-emulated Chrome here draws the host fine (composited screenshot,
    // n64/tools/party_pace_probe.mjs), so what differs on the real phone is not
    // reproducible on this box. What the page CAN do is witness it: every few
    // seconds it reads a few pixels of the default framebuffer in the SAME task
    // as a frame, before the browser presents and clears it, and it listens for
    // the one event that turns a running core into a black canvas silently —
    // webglcontextlost. The result goes to the log (Diagnostics) and, when it is
    // conclusive, to the status line, so the next report says which one it was.
    // ⚠ ON DEMAND ONLY. Each read is a readPixels of the default framebuffer,
    // which on a tile-based phone GPU (Mali, Adreno, PowerVR) resolves and
    // flushes the whole pipeline — the user's own phone report put a 439 ms
    // FrameRequestCallback and a 552 ms timer on the main thread. So it no longer
    // runs every second of every room: opening 🩺 Diagnostics (openDiag) asks for
    // a burst of reads (LS_GL.want), ?glwitness=1 keeps the old always-on
    // behaviour for a rig, and the context-lost listener (free) stays armed.
    var LS_GL = { armedAt: 0, reads: 0, lit: 0, lastAt: 0, lost: false, restored: false, said: '',
                  want: new URLSearchParams(env.search).get('glwitness') === '1' ? Infinity : 0 };
    function lsGlWitness() {
      if (!(LS_GL.want > 0)) return;
      var now = performance.now();
      if (now - LS_GL.lastAt < 1000) return;          // one read a second: each one is a GPU sync
      LS_GL.want--;
      LS_GL.lastAt = now;
      // G.Module.ctx when emscripten set it; otherwise the canvas hands back the
      // context the core already created (getContext returns the existing one —
      // safe here because a frame has just run, so it exists).
      var M = G.Module, gl = M && M.ctx;
      if (!gl) { try { gl = env.canvas().getContext('webgl2'); } catch (e) { gl = null; } }
      if (!gl || typeof gl.readPixels !== 'function') return;
      if (gl.isContextLost && gl.isContextLost()) { LS_GL.lost = true; return; }
      try {
        var W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        if (!(W > 8 && H > 8)) return;
        var rfb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        var ppb = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        if (ppb) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        var px = new Uint8Array(4 * 16), lit = false;
        // One 16-pixel row through the middle third of the picture.
        if (G.__fbAsync) G.__fbAsync.bypass = true;
        try { gl.readPixels((W >> 1) - 8, H >> 1, 16, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
        finally { if (G.__fbAsync) G.__fbAsync.bypass = false; }
        for (var i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 24) { lit = true; break; }
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rfb);
        if (ppb) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, ppb);
        LS_GL.reads++; if (lit) LS_GL.lit++;
      } catch (e) { LS_GL.err = (e && e.message) || String(e); }
    }

    // ---- what this console tells the room about itself (lsPace's first half) ----
    function publishSelf(rttMs) {
      var ls = env.engine();
      if (ls) { try { ls.selfCap = lsSelfCap(); ls.selfLostMs = LS.lostMs || 0; if (rttMs) ls.rttMs = rttMs; } catch (e) {} }
    }
    // ---- the core half of window.__n64Net() (the page adds the room's own fields) ----
    function netReport() {
      var ls = env.engine();
      var rep = null;
      try { rep = ls && typeof ls.report === 'function' ? ls.report() : null; } catch (e) {}
      var fps = [], k0 = Math.max(0, FPR.n - 64);
      for (var k = k0; k < FPR.n; k++) fps.push([FPR.f[k % FPR_N], FPR.v[k % FPR_N]]);
      return {
        mode: ls ? (ls.rollback ? 'rollback' : 'lockstep') : null,
        rollback: (ls && ls.rollback) ? {
          engine: (function () { try { return ls.rollbackReport(); } catch (e) { return null; } })(),
          page: { ready: RB.ready, slots: RB.n, reach: RB.n, cap: RB.cap, allocated: RB.slots.length, rollbacks: RB.rollbacks,
                  hidden: RB.hidden, stepMs: +(RB.stepMs || 0).toFixed(2), pace: LS.pace || 1,
                  k: RB.k, kFixed: RB.kFixed, maxWindow: RB.maxWindow || 0, kChanges: RB.kChanges, kWhy: RB.kWhy,
                  runMs: +RB.runEma.toFixed(2), saveMs: +RB.saveEma.toFixed(2), loadMs: +RB.loadEma.toFixed(2),
                  rollbacksPerFrame: +RB.pEma.toFixed(4), depthAvg: RB.rollbacks ? +(RB.depthSum / RB.rollbacks).toFixed(2) : 0,
                  resimFrames: RB.resimFrames, bridgeFrames: RB.bridgeFrames, maxDepth: RB.maxDepth, depthHist: RB.depthHist, loads: RB.loads, wipes: RB.wipes | 0, wipeMs: Math.round(RB.wipeMs || 0),
                  tlbSameByContent: (function () { try { return G.Module._neil_state_tlb_same_by_content ? G.Module._neil_state_tlb_same_by_content() : null; } catch (e) { return null; } })(),
                  resimMsTotal: Math.round(RB.resimMs), resimMsPerRollback: RB.rollbacks ? +(RB.resimMs / RB.rollbacks).toFixed(2) : 0,
                  resimMsPerDepthFrame: RB.depthSum ? +(RB.resimMs / RB.depthSum).toFixed(2) : 0,
                  maxResimMs: +RB.maxResimMs.toFixed(1), saves: RB.saves, skippedSaves: RB.skippedSaves, evictions: RB.evictions, freed: RB.freed | 0,
                  saveMsPerFrame: RB.frames ? +(RB.saveMs / (RB.frames + RB.resimFrames + RB.bridgeFrames + RB.hidden)).toFixed(2) : null,
                  hashes: RB.hashes, missingSlot: RB.missingSlot, frames: RB.frames, fault: RB.fault, rearms: RB.rearms,
                  glSkip: { ok: glSkipOk(), disabled: GLSKIP.disabled, frames: GLSKIP.frames, callsSkipped: GLSKIP.calls,
                            coreReads: GLSKIP.reads, redo: GLSKIP.redo },
                  glState: { on: RBGL.on, bytes: RBGL.size, saves: RBGL.saves, loads: RBGL.loads,
                             msPerOp: (RBGL.saves + RBGL.loads) ? +(RBGL.ms / (RBGL.saves + RBGL.loads)).toFixed(4) : null } },
          state: G.__n64State.info(),
        } : null,
        runahead: { frames: RA.frames, fixed: RA.fixed, runs: RA.runs, hiddenFrames: RA.hiddenFrames,
                    msPerRun: RA.runs ? +(RA.ms / RA.runs).toFixed(2) : null, tickMs: +RA.tickEma.toFixed(2),
                    ups: RA.ups, downs: RA.downs, fault: RA.fault },
        advWaits: LS.advWaits | 0,
        // what the capacity gate reads from this console, in either mode
        step: { selfStepMs: ls ? +(+ls.selfStepMs || 0).toFixed(2) : null, selfPresentMs: ls ? +(+ls.selfPresentMs || 0).toFixed(2) : null, preReadySaveMs: +(LS_RB.saveMs || 0).toFixed(2),
                saveEmaMs: +(RB.saveEma || 0).toFixed(2), loadEmaMs: +(RB.loadEma || 0).toFixed(2), remeasures: RB.remeasures | 0,
                rearms: RB.rearms, stale: RB.stale },
        lat: { samples: LAT.samples.slice(-60), overlapped: LAT.overlapped },
        fskip: rfsReport(),
        prerolled: !!LS.prerolled,
        fb: (function () { var st = G.__fbAsync || {}; return { on: !!st.on, decided: st.decided || null, rom: st.romName || null,
               calls: st.calls, async: st.async, sync: st.sync, blocked: st.blocked, pinned: st.pinned, restores: st.restores | 0 }; })(),
        armed: LS.armed,
        armedAtFrame: (LS.armedAtFrame == null ? null : LS.armedAtFrame | 0),
        running: LS.running,
        coreArmed: (function () {
          try { return !!(G.Module && G.Module._neil_ls_armed && G.Module._neil_ls_armed()); }
          catch (e) { return null; }
        })(),
        frame: LS.frame,
        fed: LS.fed,
        image: (G.__n64LsImage || null),
        padBytes: LS_PAD_BYTES,
        hashes: LS.hashes,
        hashSink: LS.hashSink,
        lastFp: LS.lastFp,
        fps: fps,
        viHz: LS.viHz,
        selfCap: lsSelfCap(), costAvgMs: LS.costAvg || null, lostMs: Math.round(LS.lostMs || 0),
        costOver: LS.costOver || 0, costMaxMs: LS.costMax ? Math.round(LS.costMax) : null,
        paceReport: (function () { try { return ls && ls.paceReport ? ls.paceReport() : null; } catch (x) { return null; } })(),
        gl: { reads: LS_GL.reads, lit: LS_GL.lit, lost: LS_GL.lost, restored: LS_GL.restored, verdict: LS_GL.said || null, err: LS_GL.err || null },
        stalling: LS.stalling,
        waitingOn: LS.waitingOn.slice(),
        stalls: LS.stalls,
        stallMs: Math.round(LS.stallMs),
        reanchors: LS.reanchors,
        fault: LS.fault,
        engine: rep,
        viTotal: (function () {
          try { return G.Module && G.Module._neil_vi_total ? G.Module._neil_vi_total() : null; }
          catch (e) { return null; }
        })(),
      };
    }

    var R = G.__n64RoomCore = {
      LS: LS, RB: RB, RA: RA, LAT: LAT, N64S: N64S, GLSKIP: GLSKIP, LS_GL: LS_GL, LS_RB: LS_RB, AUDX: AUDX,
      LS_PAD_BYTES: LS_PAD_BYTES, LSN: LSN, N64S_FIELDS: N64S_FIELDS,
      RB_DEFAULT: RB_DEFAULT, RB_WANT: RB_WANT, RB_WINDOW: RB_WINDOW, RB_RING_BUDGET_MB: RB_RING_BUDGET_MB,
      lsFeed: lsFeed, lsDriveOk: lsDriveOk, lsDueNow: lsDueNow, lsLocalPads: lsLocalPads, lsApplyImage: lsApplyImage,
      lsArmBeforeBoot: lsArmBeforeBoot, lsDisarm: lsDisarm, lsPreroll: lsPreroll,
      lsRbProve: lsRbProve, lsRbRefuse: lsRbRefuse, lsSelfCap: lsSelfCap, lsGlWitness: lsGlWitness,
      glSkipOk: glSkipOk, audioFlushNow: audioFlushNow, RFS: RFS, rfsReport: rfsReport,
      rfsCanSkip: function () { var ls = env.engine(); return !!(ls && LS.running && (ls.rollback ? rfsAble('present', (LS.lastPresentFrame | 0) + 1) : (env.fs && env.fs.linearCanSkip && env.fs.linearCanSkip()))); }, audioDropNow: audioDropNow,
      publishSelf: publishSelf, netReport: netReport
    };
    return R;
  };
})(typeof window !== 'undefined' ? window : self);
