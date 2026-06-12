// Bundled into flycast_worker.{js,wasm} via emcc --post-js (see
// flycast_worker_link.sh). Runs inside the emscripten module factory's
// scope: `Module`, `_malloc`, `HEAPU8`, etc. are all in lexical scope here.
//
// Phase 1 single-worker shape — much simpler than the dolphin worker_funcs.js
// counterpart because there is NO second worker calling in via a SAB
// mailbox yet. The `mbx-cmd` cmd-2..12 routing in dolphin's worker_funcs.js
// exists because ppc-worker drives PowerPC dispatch in a separate thread;
// Flycast's SH4 JIT runs *inside this worker* via the rec_wasm seam, so
// there's nothing to mailbox-route in Phase 1.
//
// What this file lands:
//   - JS-side rec_wasm dispatcher: flycast_install_block, which compiles +
//     instantiates a per-block WebAssembly.Module and installs its `run`
//     export into the shared wasmTable. Returns the table index so the C
//     dispatcher in rec_wasm.cpp can call_indirect with no JS hop.
//     Defined OUTSIDE the pthread guard so it's reachable on whichever
//     pthread ends up running the SH4 dispatch loop (PROXY_TO_PTHREAD=1).
//   - postMessage 'runtime-ready' (the shim in flycast_worker.js waits on
//     Module.onRuntimeInitialized rather than this signal, but emit it for
//     parity with the dolphin pipeline so render-probe heuristics work).
//   - mbx-cmd handler skeleton — currently always 0-replies. Phase 2 fills
//     in the real SH4-side MMIO routes (mirror gamecube cmd 2..12 layout).
//   - 'shutdown' handler that tries to flush state cleanly.

// ===========================================================================
// rec_wasm JS dispatcher — nasomers-table-dispatch shape.
//
// Lives outside the pthread guard so the EM_JS bodies — which the wasm CPU
// loop calls on whatever thread it runs on — can reach this state.
//
// State:
//   flycast_wasm_imports  { env: { memory, sh4_read*, sh4_write*, ... } }
//   flycast_table_slots   Array<WebAssembly.Instance> — keep instance refs
//                         alive (indexed by wasmTable slot) so V8 doesn't GC
//                         compiled code while the table entry is in use.
//
// Imports object is built lazily on the first install call so we can pull
// Module.wasmMemory after the runtime is up. We re-use the same object for
// every Instance — the spec allows it and avoids per-block allocation.
// ===========================================================================

var flycast_wasm_imports = null;

function flycast_build_imports() {
  // The compiled SH4 block imports `env.memory`. We MUST pass the same
  // WebAssembly.Memory the worker itself runs in so ctx_ptr offsets land
  // in the right place. Module.wasmMemory is set by the shim before the
  // emcc factory boots (see flycast_worker.js: self.Module.wasmMemory =
  // sharedMemory).
  var mem = (typeof Module !== 'undefined' && Module.wasmMemory)
    ? Module.wasmMemory : null;
  if (!mem) {
    // Last-ditch: pull from wasmExports if Emscripten exposes it. If both
    // routes fail, instantiation will throw — which surfaces the real bug
    // (worker booted without mem-init) rather than silently miscompile.
    if (typeof wasmMemory !== 'undefined') mem = wasmMemory;
  }

  // Direct Module._sh4_* references rather than cwrap. The C exports are
  // already plain (i32...) -> i32/void wasm functions; cwrap would just
  // wrap them with type-coercion shims we don't need. Skipping cwrap also
  // avoids any runtime-method-availability concerns on pthread workers.
  return {
    env: {
      memory:      mem,
      sh4_read8:   Module._sh4_mem_read8,
      sh4_read16:  Module._sh4_mem_read16,
      sh4_read32:  Module._sh4_mem_read32,
      sh4_write8:  Module._sh4_mem_write8,
      sh4_write16: Module._sh4_mem_write16,
      sh4_write32: Module._sh4_mem_write32,
      sh4_ifb:     Module._sh4_interp_ifb,
      sh4_shil_fb: Module._sh4_interp_shil_fb,
    },
  };
}

// Last register_block error message, retrievable from C side via
// flycast_register_get_last_error(). postMessage from a pthread doesn't
// reach the page (goes to pthread's own message channel) — so we stash
// the error and let the C side log it via MAIN_THREAD_EM_ASM.
var flycast_last_register_error = '';

// nasomers-pattern install: compile block, instantiate, grow shared wasmTable,
// return new table index. C dispatcher in rec_wasm.cpp calls via fn pointer →
// WASM toolchain lowers to call_indirect against this same table, no JS hop.
// Keep instance refs alive so V8 doesn't GC the wasm code while the slot is in
// use. Returns 0 on failure (sentinel — slot 0 is unused/null fn).
var flycast_table_slots = [];   // index → Instance (GC root)

function flycast_install_block(bytesPtr, len, vaddr) {
  bytesPtr = bytesPtr >>> 0;
  len      = len      >>> 0;
  vaddr    = vaddr    >>> 0;
  try {
    var src   = HEAPU8.subarray(bytesPtr, bytesPtr + len);
    var bytes = new Uint8Array(src);
    var mod   = new WebAssembly.Module(bytes);
    if (!flycast_wasm_imports) {
      flycast_wasm_imports = flycast_build_imports();
    }
    var inst  = new WebAssembly.Instance(mod, flycast_wasm_imports);
    var fn    = inst.exports.run;
    if (typeof fn !== 'function') {
      flycast_last_register_error = 'install_block: missing "run" export';
      return 0;
    }
    var idx = wasmTable.length;
    wasmTable.grow(1);
    wasmTable.set(idx, fn);
    flycast_table_slots[idx] = inst;
    return idx;
  } catch (e) {
    flycast_last_register_error = (e && e.message) ? e.message : String(e);
    return 0;
  }
}

// F1 (shard install) — compile + instantiate a multi-block WASM module
// containing N exported run_0..run_<N-1> functions. Grows wasmTable by N
// contiguous slots and populates them from the exports map; returns the
// BASE table index (run_i lives at base+i). The C side casts (base+i) to
// a BlockFn pointer and registers each per its vaddr.
//
// vaddrsPtr is a u32[count] in the C heap (s_pending_shard's vaddrs). We
// don't strictly need it here — the wasmTable lookup is purely positional —
// but logging it on failure helps correlate JS-side errors with the C side.
// One Instance ref serves as GC root for ALL slots in the shard: every
// export comes from the same instance, so a single ref pins the whole
// compiled module's code.
function flycast_install_shard(bytesPtr, len, vaddrsPtr, count) {
  bytesPtr  = bytesPtr  >>> 0;
  len       = len       >>> 0;
  vaddrsPtr = vaddrsPtr >>> 0;
  count     = count     >>> 0;
  if (count === 0) {
    flycast_last_register_error = 'install_shard: count=0';
    return 0;
  }
  try {
    var src   = HEAPU8.subarray(bytesPtr, bytesPtr + len);
    var bytes = new Uint8Array(src);
    var mod   = new WebAssembly.Module(bytes);
    if (!flycast_wasm_imports) {
      flycast_wasm_imports = flycast_build_imports();
    }
    var inst     = new WebAssembly.Instance(mod, flycast_wasm_imports);
    var base_idx = wasmTable.length;
    wasmTable.grow(count);
    for (var i = 0; i < count; i++) {
      var fn = inst.exports['run_' + i];
      if (typeof fn !== 'function') {
        flycast_last_register_error =
          'install_shard: missing run_' + i + ' (count=' + count + ')';
        return 0;
      }
      wasmTable.set(base_idx + i, fn);
      // One Instance ref pins the whole module's code; mirror it across
      // every slot so a future selective-evict of one slot doesn't
      // accidentally let V8 GC the entire shard.
      flycast_table_slots[base_idx + i] = inst;
    }
    return base_idx;
  } catch (e) {
    flycast_last_register_error = (e && e.message) ? e.message : String(e);
    return 0;
  }
}

if (typeof ENVIRONMENT_IS_PTHREAD === 'undefined' || !ENVIRONMENT_IS_PTHREAD) {

if (typeof Module !== 'undefined') {
  var _flycast_origORI = Module.onRuntimeInitialized;
  Module.onRuntimeInitialized = function () {
    if (typeof _flycast_origORI === 'function') {
      try { _flycast_origORI(); } catch (e) {}
    }
    postMessage({ cmd: 'print', txt: '[flycast-funcs] runtime-ready posted' });
    postMessage({ cmd: 'runtime-ready' });
  };
}

// Forward declared so we don't clobber the shim's onmessage if it runs first.
// The shim installs its own dispatcher post runtime-init; if for some reason
// it doesn't (e.g. mem-init never fired), this fallback at least keeps the
// 'shutdown' / 'mbx-cmd' paths reachable.
var _flycast_funcs_prevOnMessage = self.onmessage;
self.onmessage = function (e) {
  var data = (e && e.data) || {};
  switch (data.cmd) {
    case 'shutdown':
      // Phase 2 will call retro_unload_game + retro_deinit here. For now we
      // just acknowledge; the page tears the worker down via worker.terminate().
      postMessage({ cmd: 'print', txt: '[flycast-funcs] shutdown ack (no-op in Phase 1)' });
      try { if (Module && Module._emscripten_load_state) {/* no-op flush hook */} } catch (e) {}
      break;

    case 'mbx-cmd': {
      // Phase 2: route SH4-side MMIO cmds from sh4-worker. Layout mirrors
      // dolphin's cmd 2..12 (8/16/32-bit reads + writes, hle_check,
      // interp, exception check, break_block, read_tb).
      // TODO: wire to flycast SH4 MMIO mirrors once sh4-worker lands.
      var c = (data.mboxCmd | 0) >>> 0;
      var r = 0;
      switch (c) {
        case 100: r = 0xCAFEBABE >>> 0; break;  // routing-live probe
        default:  r = 0;                         // not yet implemented
      }
      postMessage({ cmd: 'mbx-reply', mboxCmd: c, reply: r });
      break;
    }

    default:
      // Defer to whoever owned onmessage before us — typically the shim
      // dispatcher (post runtime-init).
      if (typeof _flycast_funcs_prevOnMessage === 'function' &&
          _flycast_funcs_prevOnMessage !== self.onmessage) {
        try { _flycast_funcs_prevOnMessage(e); } catch (_) {}
      }
  }
};

postMessage({ cmd: 'print', txt: '[flycast-funcs] post-js installed' });

}  // end !ENVIRONMENT_IS_PTHREAD guard
