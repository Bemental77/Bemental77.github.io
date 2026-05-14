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
//   - JS-side rec_wasm dispatcher: per-block WebAssembly.Module / Instance
//     caches and the two functions (flycast_register_block /
//     flycast_run_block) that EM_JS bodies in rec_wasm.cpp call into.
//     Defined OUTSIDE the pthread guard so they're reachable on whichever
//     pthread ends up running the SH4 dispatch loop (PROXY_TO_PTHREAD=1).
//   - postMessage 'runtime-ready' (the shim in flycast_worker.js waits on
//     Module.onRuntimeInitialized rather than this signal, but emit it for
//     parity with the dolphin pipeline so render-probe heuristics work).
//   - mbx-cmd handler skeleton — currently always 0-replies. Phase 2 fills
//     in the real SH4-side MMIO routes (mirror gamecube cmd 2..12 layout).
//   - 'shutdown' handler that tries to flush state cleanly.

// ===========================================================================
// rec_wasm JS dispatcher.
//
// Lives outside the pthread guard so the EM_JS bodies — which the wasm CPU
// loop calls on whatever thread it runs on — can reach this state.
//
// State:
//   flycast_block_modules   Map<vaddr_u32, WebAssembly.Module>
//   flycast_block_instances Map<vaddr_u32, WebAssembly.Instance>
//   flycast_wasm_imports    { env: { memory, sh4_read*, sh4_write*, ... } }
//
// Imports object is built lazily on the first register/run call so we can
// pull Module.wasmMemory after the runtime is up. We re-use the same object
// for every Instance — the spec lets you do that, and it avoids per-block
// allocation.
//
// We keep instance creation lazy (run_block side, not register_block) so the
// register call stays cheap on the compile hot path.
// ===========================================================================

var flycast_block_modules   = new Map();
var flycast_block_instances = new Map();
var flycast_wasm_imports    = null;

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

function flycast_register_block(vaddr, bytesPtr, len) {
  vaddr    = vaddr    >>> 0;
  bytesPtr = bytesPtr >>> 0;
  len      = len      >>> 0;
  try {
    // Snapshot bytes out of the wasm heap into a fresh Uint8Array — the
    // backing memory may move on a future heap-grow, and the WebAssembly
    // spec requires the source buffer to stay alive through compile.
    var src = HEAPU8.subarray(bytesPtr, bytesPtr + len);
    var copy = new Uint8Array(src);
    var mod  = new WebAssembly.Module(copy);
    flycast_block_modules.set(vaddr, mod);
    // Drop any cached Instance for this vaddr — a recompile means new code.
    flycast_block_instances.delete(vaddr);
    return 1;
  } catch (e) {
    if (typeof postMessage === 'function') {
      postMessage({
        cmd: 'print',
        txt: '[flycast-funcs] register_block FAILED vaddr=0x' +
             vaddr.toString(16) + ' len=' + len + ': ' +
             (e && e.message ? e.message : String(e)),
      });
    }
    return 0;
  }
}

function flycast_run_block(vaddr, ctxPtr, ramBase) {
  vaddr   = vaddr   >>> 0;
  ctxPtr  = ctxPtr  >>> 0;
  ramBase = ramBase >>> 0;

  var inst = flycast_block_instances.get(vaddr);
  if (!inst) {
    var mod = flycast_block_modules.get(vaddr);
    if (!mod) {
      // No block compiled for this PC — return PC+2 to advance one SH4
      // instruction so the dispatcher re-enters compilePC on the next
      // iteration. Spinning here would be a dispatcher-bug indicator,
      // not something to silently absorb.
      return (vaddr + 2) >>> 0;
    }
    if (!flycast_wasm_imports) {
      flycast_wasm_imports = flycast_build_imports();
    }
    try {
      inst = new WebAssembly.Instance(mod, flycast_wasm_imports);
    } catch (e) {
      if (typeof postMessage === 'function') {
        postMessage({
          cmd: 'print',
          txt: '[flycast-funcs] instantiate FAILED vaddr=0x' +
               vaddr.toString(16) + ': ' + (e && e.message ? e.message : String(e)),
        });
      }
      return (vaddr + 2) >>> 0;
    }
    flycast_block_instances.set(vaddr, inst);
  }

  // The compiled block exports `run(ctx_ptr, ram_base) -> next_pc`.
  // emitBlockExit also writes ctx->pc directly, so the trampoline could
  // technically ignore the return value — we return it anyway so the
  // C side can mirror it back as a defensive PC sync.
  try {
    return inst.exports.run(ctxPtr, ramBase) >>> 0;
  } catch (e) {
    // SH4ThrownException propagating from inside an IFB import is one
    // legitimate way for run() to unwind. The C++ driver catches it on
    // the outer mainloop. Re-throw so the Emscripten exception path can
    // surface it.
    throw e;
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
