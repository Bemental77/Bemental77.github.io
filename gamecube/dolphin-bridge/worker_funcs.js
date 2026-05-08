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
