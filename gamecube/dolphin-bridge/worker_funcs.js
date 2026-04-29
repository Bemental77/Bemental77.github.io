// Bundled into dolphin_worker.js via emcc --post-js.
// Routes messages from main thread into the Dolphin core.
// Skip entirely in pthread child workers — they have their own onmessage
// handler installed by emscripten's pthread runtime.
if (typeof ENVIRONMENT_IS_PTHREAD === 'undefined' || !ENVIRONMENT_IS_PTHREAD) {

var romChunks = [];
var totalSize = 0;
var bootStarted = false;
var tickInterval = null;

function startTickLoop() {
  if (tickInterval) return;
  tickInterval = setInterval(function () {
    if (Module && Module._run_iter) {
      for (var i = 0; i < 10000; i++) Module._run_iter();
    }
  }, 16); // ~60 fps
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
  startTickLoop();
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
    default:
      postMessage({ cmd: 'print', txt: '[worker] unknown cmd: ' + data.cmd });
  }
};

postMessage({ cmd: 'print', txt: '[worker] post-js ready, waiting for runtime init' });

} // end !ENVIRONMENT_IS_PTHREAD guard
