// Bundled into dolphin_worker.js via emcc --post-js.
// Routes messages from main thread into the Dolphin core.
// Skip entirely in pthread child workers — they have their own onmessage
// handler installed by emscripten's pthread runtime.
if (typeof ENVIRONMENT_IS_PTHREAD === 'undefined' || !ENVIRONMENT_IS_PTHREAD) {

// 4f-6: surface a 'runtime-ready' postMessage when emscripten has
// finished bringing up wasm + memory + exports. Page waits on this
// before routing real MMIO cmds (2..12) — earlier calls hit
// throwing stubs because Module.calledRun isn't reliable under
// PROXY_TO_PTHREAD on the main thread.
if (typeof Module !== 'undefined') {
  var _ppc_origORI = Module.onRuntimeInitialized;
  Module.onRuntimeInitialized = function () {
    if (typeof _ppc_origORI === 'function') {
      try { _ppc_origORI(); } catch (e) {}
    }
    // 2e.4 (UPDATED 2026-05-11): PowerPCState redirect moved to
    // load_iso() in EmscriptenWorker.cpp. Under PROXY_TO_PTHREAD the
    // onRuntimeInitialized callback runs on the worker-main wasm
    // instance, but PowerPCManager is constructed on the proxy-pthread
    // wasm instance — file-static `g_ppc_state_external_storage` is
    // per-instance, so setting it from here never reaches the pthread
    // that needs it. Same bug class as g_jit_wasm (JitWasm.cpp:1525).
    postMessage({ cmd: 'print', txt: '[worker] PowerPCState redirect deferred to load_iso (pthread instance)' });
    postMessage({ cmd: 'runtime-ready' });
    postMessage({ cmd: 'print', txt: '[worker] runtime-ready posted' });
  };
}

var romChunks = [];
var totalSize = 0;
var bootStarted = false;
var tickInterval = null;
var firstFrameSeen = false;
var bootLoopRunning = false;

// During boot (before any frame is produced), run flat-out: drain a large
// batch via _run_iter_batch then yield to the event loop via setTimeout(0)
// so messages still get processed. The 60 Hz setInterval pace is correct
// for a running game (matches GC VBlank) but throttles us 10–16× during
// early OS init when there's no rendering budget to fill. After the first
// frame arrives we switch to the steady-state 60 Hz loop.
async function bootLoop() {
  if (bootLoopRunning) return;
  bootLoopRunning = true;
  while (!firstFrameSeen) {
    if (Module && Module._run_iter_batch) {
      Module._run_iter_batch(100000);
    } else if (Module && Module._run_iter) {
      for (var i = 0; i < 10000; i++) Module._run_iter();
    }
    await new Promise(function (r) { setTimeout(r, 0); });
  }
  bootLoopRunning = false;
}

function startTickLoop() {
  if (tickInterval) return;
  tickInterval = setInterval(function () {
    if (Module && Module._run_iter_batch) {
      Module._run_iter_batch(10000);
    } else if (Module && Module._run_iter) {
      for (var i = 0; i < 10000; i++) Module._run_iter();
    }
  }, 16); // ~60 fps
}

// Called once we know rendering has begun (set by video_cb in
// EmscriptenWorker.cpp). Lets bootLoop fall through to the 60 Hz tick.
function markFirstFrame() {
  if (firstFrameSeen) return;
  firstFrameSeen = true;
  startTickLoop();
}

async function bootIso(name, size) {
  if (bootStarted) return;
  bootStarted = true;
  var total = new Uint8Array(size);
  var off = 0;
  for (var i = 0; i < romChunks.length; i++) {
    var c = romChunks[i];
    total.set(c, off);
    off += c.byteLength;
  }
  romChunks = null;
  try {
    Module.FS.writeFile('/' + name, total);
  } catch (e) {
    postMessage({ cmd: 'print', txt: '[worker] FS.writeFile failed: ' + e });
    return;
  }
  total = null;
  // Force MMU emulation on via Dolphin.ini in MEMFS. Without translation, the
  // WASM JIT trampolines pass raw guest virtual addresses to the memory system,
  // panicking on cached-RAM mirror addresses (0x8xxxxxxx). DolphinLibretro/Boot.cpp
  // also forces MAIN_MMU=true under __EMSCRIPTEN__, so this is belt-and-braces.
  // SkipIPL=False makes Dolphin run the bundled IPL (BS2) before handing control
  // to the disc — without that the boot path leaves hardware uninitialized
  // and the game stalls at 0x80003140 with MSR interrupts disabled.
  try {
    var iniDir = '/home/web_user/retroarch/userdata/system/dolphin-emu/User/Config';
    Module.FS.mkdirTree(iniDir);
    var iniBody = '[Core]\nMMU = True\nSkipIPL = False\n';
    Module.FS.writeFile(iniDir + '/Dolphin.ini', iniBody);
    postMessage({ cmd: 'print', txt: '[worker] wrote Dolphin.ini (MMU=True, SkipIPL=False) at ' + iniDir });
    try {
      var cfg = Module.FS.readFile(iniDir + '/Dolphin.ini', { encoding: 'utf8' });
      postMessage({ cmd: 'print', txt: '[config] Dolphin.ini: ' + cfg.replace(/\n/g, ' \\n ') });
    } catch (re) {
      postMessage({ cmd: 'print', txt: '[worker] Dolphin.ini readback failed: ' + re });
    }
  } catch (e) {
    postMessage({ cmd: 'print', txt: '[worker] Dolphin.ini write failed: ' + e });
  }

  // Stage IPL.bin into every path Dolphin's BS2 loader might check. The
  // emscripten runtime doesn't have a libretro SetUserPath override, so the
  // resolved D_GCUSER_IDX / GetSysDirectory() values aren't grep-able — write
  // to all plausible roots, GetBootROMPath() returns the first hit it finds.
  // Region is GC/USA for SA2B (GSNE8P, NTSC-U); add EUR / JAP if other discs
  // get added later.
  try {
    var iplResp = await fetch('/gamecube/IPL.bin');
    if (!iplResp.ok) {
      postMessage({ cmd: 'print', txt: '[ipl] fetch failed: HTTP ' + iplResp.status });
    } else {
      var iplBuf = await iplResp.arrayBuffer();
      var iplBytes = new Uint8Array(iplBuf);
      // Cover every plausible <UserPath>/GC/USA and <SysDir>/GC/USA combo.
      var iplDirs = [
        '/home/web_user/retroarch/userdata/system/dolphin-emu/User/GC/USA',
        '/home/web_user/.dolphin-emu/GC/USA',
        '/home/web_user/dolphin-emu/User/GC/USA',
        '/dolphin-emu/User/GC/USA',
        '/dolphin-emu/Sys/GC/USA',
        '/User/GC/USA',
        '/Sys/GC/USA',
        '/GC/USA',
      ];
      var written = 0;
      for (var di = 0; di < iplDirs.length; di++) {
        try {
          Module.FS.mkdirTree(iplDirs[di]);
          Module.FS.writeFile(iplDirs[di] + '/IPL.bin', iplBytes);
          written++;
        } catch (we) {
          postMessage({ cmd: 'print', txt: '[ipl] write to ' + iplDirs[di] + ' failed: ' + we });
        }
      }
      postMessage({ cmd: 'print', txt: '[ipl] wrote IPL.bin ' + iplBuf.byteLength + ' bytes to ' + written + '/' + iplDirs.length + ' candidate paths' });
    }
  } catch (e) {
    postMessage({ cmd: 'print', txt: '[ipl] write threw: ' + e });
  }

  postMessage({ cmd: 'print', txt: '[worker] ISO written to /' + name + ' (' + size + ' bytes), calling load_iso' });
  var ret = Module._load_iso ? Module.ccall('load_iso', 'number', ['string'], ['/' + name]) : -99;
  if (ret !== 0) {
    postMessage({ cmd: 'print', txt: '[worker] load_iso returned ' + ret });
    postMessage({ cmd: 'setStatus', txt: 'load_iso failed (' + ret + ')' });
    return;
  }
  // Phase A1: cls-table init runs on the dolphin pthread inside
  // HW::Init (HW.cpp routes through dolphin_mmio_mirror_init C-extern
  // to defeat LTO DCE). Don't call it from JS — under PROXY_TO_PTHREAD
  // the JS-thread call would land in main-thread memory while
  // Core::System lives in the pthread's memory.
  postMessage({ cmd: 'setStatus', txt: 'Running' });
  // Run flat-out during boot. Switch to 60 Hz once first frame fires.
  bootLoop();
}

self.onmessage = function (e) {
  var data = e.data || {};
  switch (data.cmd) {
    case 'romChunk':
      if (data.buf && data.buf.byteLength) {
        romChunks.push(new Uint8Array(data.buf));
        totalSize += data.buf.byteLength;
      }
      break;
    case 'romEnd':
      if (Module && Module.calledRun) {
        bootIso(data.name, data.size);
      } else {
        var prev = Module && Module.onRuntimeInitialized;
        if (!Module) Module = {};
        Module.onRuntimeInitialized = function () {
          if (prev) try { prev(); } catch (_) {}
          bootIso(data.name, data.size);
        };
      }
      break;
    case 'input':
      if (Module && Module.calledRun && Module.HEAPU8 && Module._get_pad_ptr) {
        var ptr = Module._get_pad_ptr();
        if (data.states && data.states.length) {
          Module.HEAPU8.set(data.states, ptr);
        }
      }
      break;
    case 'saveState':
      if (!Module || !Module.calledRun) {
        postMessage({ cmd: 'stateSaved', data: new Uint8Array(0) });
        break;
      }
      try {
        var size = Module._state_size();
        if (size <= 0) {
          postMessage({ cmd: 'stateSaved', data: new Uint8Array(0) });
          break;
        }
        var ptr = Module._malloc(size);
        var ret = Module._save_state(ptr, size);
        if (ret > 0) {
          var buf = new Uint8Array(Module.HEAPU8.subarray(ptr, ptr + ret));
          postMessage({ cmd: 'stateSaved', data: buf });
        } else {
          postMessage({ cmd: 'stateSaved', data: new Uint8Array(0) });
        }
        Module._free(ptr);
      } catch (e) {
        postMessage({ cmd: 'print', txt: '[worker] saveState failed: ' + e });
        postMessage({ cmd: 'stateSaved', data: new Uint8Array(0) });
      }
      break;
    case 'loadState':
      if (!Module || !Module.calledRun) {
        postMessage({ cmd: 'stateLoaded' });
        break;
      }
      try {
        var src = data.data || new Uint8Array(0);
        var ptr = Module._malloc(src.length);
        Module.HEAPU8.set(src, ptr);
        Module._load_state(ptr, src.length);
        Module._free(ptr);
        postMessage({ cmd: 'stateLoaded' });
      } catch (e) {
        postMessage({ cmd: 'print', txt: '[worker] loadState failed: ' + e });
        postMessage({ cmd: 'stateLoaded' });
      }
      break;
    case 'setup-ppc-mailbox':
      // 4f-6 reframe: dolphin no longer polls the SAB mailbox itself
      // (its private wasm memory can't observe page-side req_ready
      // writes). The 4f-6 page-mediated routing replaces that role —
      // page polls the SAB and forwards real MMIO cmds via 'mbx-cmd'
      // postMessage. The C-side dolphin_ppc_mailbox_init/poll remain
      // defined for binary-compat, but the init call is now a no-op
      // signal: we just print so the cascade log lines up.
      postMessage({ cmd: 'print', txt: '[worker] setup-ppc-mailbox legacy ack (4f-6: routing is page-mediated)' });
      break;
    case 'ct-phase-set':
      // Item 7 Phase IV: page-driven gate. Called by gamecube.html when
      // ppc-worker is taking over PPC dispatch (?ppcbootdispatch=1). Bits
      // match gamecube/ppc-worker/sab_layout.h:386 (PHASE4=0x2, PHASE5=0x4).
      if (Module && Module._dolphin_ct_set_phase_flags) {
        var flags = (data.flags | 0) >>> 0;
        Module._dolphin_ct_set_phase_flags(flags);
        postMessage({ cmd: 'print',
          txt: '[worker] ct-phase-set flags=0x' + flags.toString(16) });
      } else {
        postMessage({ cmd: 'print',
          txt: '[worker] ct-phase-set: Module._dolphin_ct_set_phase_flags missing' });
      }
      break;
    case 'pause-for-cutover':
    case 'resume-from-cutover':
      // 2d.9 reverted — see memory:2d9_real_cutover_blocked.md.
      // Acknowledge to keep the page's cascade unstuck if it sent
      // the message anyway.
      postMessage({ cmd: 'cutover-resumed', error: '2d.9 cutover blocked by PROXY_TO_PTHREAD memory isolation' });
      break;
    case 'state-export-test': {
      // 2d.7: stamp the dolphin-side test PowerPCState buffer with a
      // known sentinel + pattern, then ship the buffer bytes to the
      // page via Transferable. Page copies into SAB[0x02400000] and
      // verifies the layout (PC at +0, pattern at +4..). Production
      // PowerPCState mirror will work the same way but read from
      // m_system.GetPPCState() instead of the test buffer.
      try {
        var pcSentinel = (data.pcSentinel | 0) >>> 0;
        Module._dolphin_test_state_set_pc(pcSentinel);
        var addr = Module._dolphin_test_state_buf_addr() >>> 0;
        var size = Module._dolphin_test_state_buf_size() >>> 0;
        var bytes = new Uint8Array(size);
        bytes.set(Module.HEAPU8.subarray(addr, addr + size));
        postMessage({ cmd: 'state-export-test-result', size: size, pcSentinel: pcSentinel, bytes: bytes.buffer }, [bytes.buffer]);
      } catch (err) {
        postMessage({ cmd: 'state-export-test-result', error: 'state-export-test threw: ' + (err && err.message ? err.message : String(err)) });
      }
      break;
    }
    case 'get-ram-info': {
      // 2g: page polls this until non-zero, then forwards to ppc-worker
      // so its self-compile path can read instructions directly from
      // SAB-mapped guest RAM. Returns 0/0 until JitWasm::Init() runs.
      try {
        var addr = (typeof Module._dolphin_get_ram_addr === 'function')
          ? (Module._dolphin_get_ram_addr() >>> 0) : 0;
        var size = (typeof Module._dolphin_get_ram_size === 'function')
          ? (Module._dolphin_get_ram_size() >>> 0) : 0;
        postMessage({ cmd: 'ram-info', addr: addr, size: size });
      } catch (err) {
        postMessage({ cmd: 'ram-info', addr: 0, size: 0, error: String(err && err.message || err) });
      }
      break;
    }
    case 'compile-test': {
      // 2d.2: page asks dolphin to emit a real bementalJIT wasm module
      // for `pc` and ship the bytes back. dolphin_test_compile_block
      // calls bemental::powerpc::build_block for a synthetic 1-nop
      // sequence; bytes live in g_test_compile_buf (in dolphin's heap).
      // We read via Module.HEAPU8 and Transferable-postMessage to page.
      try {
        var pc = (data.pc | 0) >>> 0;
        var tag = data.tag || 'verify';
        var nInsts = (data.nInsts | 0) >>> 0;  // 0 = default 1
        // 2d.6: when realDecode is set, try the post-boot real-decode
        // path first (uses dolphin's MMU to read instructions from
        // emulated RAM at pc). Returns 0 pre-boot or on decode failure;
        // fall through to the synth path so verification still gets
        // valid bytes back.
        var size = 0;
        var decoded = false;
        if (data.realDecode) {
          size = Module._dolphin_compile_block_real(pc) >>> 0;
          decoded = (size !== 0);
        }
        if (size === 0) {
          size = Module._dolphin_test_compile_block(pc, nInsts) >>> 0;
        }
        if (size === 0) {
          postMessage({ cmd: 'compile-test-result', tag: tag, error: 'build_block returned 0 bytes' });
          break;
        }
        var addr = Module._dolphin_test_compile_block_addr() >>> 0;
        // 2f.0: cycle count of this block (raw instruction count).
        // ppc-worker uses this to decrement ppc_state.downcount per
        // dispatch in the continuous run loop (2f.1).
        var cycles = (typeof Module._dolphin_get_last_compile_cycles === 'function')
          ? (Module._dolphin_get_last_compile_cycles() >>> 0) : 0;
        // Copy out of dolphin's heap into a fresh ArrayBuffer so the
        // Transferable transfer doesn't take the heap-backed view.
        var bytes = new Uint8Array(size);
        bytes.set(Module.HEAPU8.subarray(addr, addr + size));
        postMessage({ cmd: 'compile-test-result', tag: tag, pc: pc, size: size, decoded: decoded, cycles: cycles, bytes: bytes.buffer }, [bytes.buffer]);
      } catch (err) {
        postMessage({ cmd: 'compile-test-result', tag: data.tag || 'verify', error: 'compile-test threw: ' + (err && err.message ? err.message : String(err)) });
      }
      break;
    }
    case 'export-jit-pcs': {
      // Phase 2e cache-warmup (Option 1): page asks dolphin to enumerate
      // its bementalJIT BlockCache. We loop over the 9 regions, ask
      // dolphin_jit_region_pcs_addr for each region's PC list base + count,
      // copy the bytes out of dolphin's heap into fresh Uint32Arrays, and
      // postMessage the parallel array back. Page then batches PCs and
      // posts precompile-batch to ppc-worker (which decodes from shared
      // MEM1 and warms its own cache).
      try {
        var perRegion = [];
        for (var r = 0; r < 9; r++) {
          var n = (typeof Module._dolphin_jit_region_n_funcs === 'function')
            ? (Module._dolphin_jit_region_n_funcs(r) >>> 0) : 0;
          if (n === 0) { perRegion.push(new Uint32Array(0)); continue; }
          var addr = (Module._dolphin_jit_region_pcs_addr(r) >>> 0);
          var view = new Uint32Array(Module.HEAPU8.buffer, addr, n);
          perRegion.push(new Uint32Array(view));  // detached copy
        }
        var transferList = [];
        for (var i = 0; i < perRegion.length; i++) transferList.push(perRegion[i].buffer);
        postMessage({ cmd: 'jit-pcs', perRegion: perRegion }, transferList);
      } catch (err) {
        postMessage({ cmd: 'jit-pcs', perRegion: [], error: String(err && err.message || err) });
      }
      break;
    }
    case 'mbx-cmd': {
      // 4f-6: page polls the SAB mailbox; on real MMIO cmds (2..12)
      // it postMessages here. We call the proxied wasm export and
      // post the reply back. Page writes the reply into the SAB
      // mailbox slot. Round-trip cost ~1-2ms wall — acceptable for
      // verification cascades; a perf concern for hot MMIO paths
      // that's solved later by moving PowerPCState into shared SAB.
      //
      // Module.calledRun isn't reliable under PROXY_TO_PTHREAD (main
      // thread's flag may never set). Try/catch the proxied call so a
      // not-yet-initialised export becomes a 0 reply instead of an
      // unhandled exception that wedges the cascade.
      var c = data.mboxCmd >>> 0;
      var a0 = data.arg0 >>> 0;
      var a1 = data.arg1 >>> 0;
      var r = 0;
      try {
        switch (c) {
          case 2:  r = Module._dolphin_read8 (a0) >>> 0; break;
          case 3:  r = Module._dolphin_read16(a0) >>> 0; break;
          case 4:  r = Module._dolphin_read32(a0) >>> 0; break;
          case 5:  Module._dolphin_write8 (a0, a1); break;
          case 6:  Module._dolphin_write16(a0, a1); break;
          case 7:  Module._dolphin_write32(a0, a1); break;
          case 8:  r = Module._dolphin_hle_check(a0) >>> 0; break;
          case 9:  Module._dolphin_interp(a0, a1); break;
          case 10: r = Module._dolphin_check_exc(a0) >>> 0; break;
          case 11: Module._dolphin_break_block(a0); break;
          case 12: r = Module._dolphin_read_tb(a0) >>> 0; break;
          case 14: // Item 5 — HleFire (pc, idx|type<<16) -> next_pc
            r = Module._dolphin_hle_fire(a0, a1) >>> 0; break;
          case 100:
            // 4f-6 routing-live probe. Pure function (no emulator
            // state), so it works pre-boot. The cascade verifies the
            // round-trip: cmd 100 with arg0=0 must reply 0xCAFEBABE.
            r = Module._dolphin_routing_probe(a0) >>> 0;
            break;
          default: r = 0;
        }
      } catch (err) {
        postMessage({ cmd: 'print', txt: '[worker] mbx-cmd ' + c + ' threw: ' + (err && err.message ? err.message : String(err)) });
        r = 0;
      }
      postMessage({ cmd: 'mbx-reply', mboxCmd: c, reply: r });
      break;
    }
    default:
      postMessage({ cmd: 'print', txt: '[worker] unknown cmd: ' + data.cmd });
  }
};

postMessage({ cmd: 'print', txt: '[worker] post-js ready, waiting for runtime init' });

} // end !ENVIRONMENT_IS_PTHREAD guard
