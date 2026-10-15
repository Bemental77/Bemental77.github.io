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

  // Lever-5F: bind the RAW wasm exports, not the Module._ JS wrappers. The
  // CPU profile showed ~13% of heavy-phase wall in wasm->JS->wasm glue:
  // Module._X is emscripten's createExportWrapper (a JS function), so every
  // import call from a runtime block paid a double boundary with a JS frame
  // in the middle. A WebAssembly exported function passed directly as an
  // import lets V8 make the call wasm->wasm with no JS hop. All of these are
  // ASYNCIFY_REMOVE'd (cannot suspend), so the wrapper added nothing but
  // cost. Fallbacks keep older layouts working.
  var raw = (typeof wasmExports !== 'undefined' && wasmExports)
         || (Module && Module['wasmExports'])
         || (Module && Module['asm'])
         || Module;
  var pick = function (name) { return (raw && raw[name]) || Module['_' + name]; };
  // Lever-5F v2: RELEASE minifies wasmExports keys (dg/eg/...), so name-based
  // raw lookup silently fell back to the JS wrappers. Instead the C side
  // hands us the wasmTable INDEXES of the 9 import targets and we bind the
  // table-resolved raw wasm function objects — wasm->wasm calls, no JS hop.
  var viaTable = null;
  try {
    if (Module._sh4_import_fnptrs && typeof wasmTable !== 'undefined' && wasmTable) {
      var NIMP = 10;   // == WIMPORT_COUNT (bementalJIT/guests/sh4/wasm_emit.h)
      var buf = Module._malloc(4 * NIMP);
      Module._sh4_import_fnptrs(buf);
      var idx = [];
      for (var i = 0; i < NIMP; i++) idx.push(Module.HEAPU32[(buf >> 2) + i]);
      Module._free(buf);
      var fns = [];
      for (var j = 0; j < NIMP; j++) fns.push(wasmTable.get(idx[j]));
      var allFns = true;
      for (var k = 0; k < NIMP; k++) if (typeof fns[k] !== 'function') { allFns = false; break; }
      if (allFns) {
        viaTable = { r8: fns[0], r16: fns[1], r32: fns[2],
                     w8: fns[3], w16: fns[4], w32: fns[5],
                     ifb: fns[6], shil: fns[7], lk: fns[8], se: fns[9] };
      }
    }
  } catch (e) { viaTable = null; }
  // One-shot binding audit (lever-5F verification): which source actually won?
  if (!flycast_worker_funcs_bind_logged) {
    flycast_worker_funcs_bind_logged = true;
    try {
      var probe = raw && raw['sh4_mem_write32'];
      var keys = [];
      try { keys = Object.keys(raw).filter(function (k) { return k.indexOf('sh4') >= 0 || k.indexOf('write32') >= 0; }).slice(0, 6); } catch (_) {}
      var all = [];
      try { all = Object.keys(raw).slice(0, 12); } catch (_) {}
      postMessage({ cmd: 'print', txt: '[5f-bind] viaTable=' + (viaTable ? 'YES(wasm-direct)' : 'no') + ' raw=' +
        (raw === Module ? 'Module(!)' : (typeof wasmExports !== 'undefined' && raw === wasmExports) ? 'wasmExports' : 'Module-prop') +
        ' write32=' + (probe ? 'raw-export' : 'JS-wrapper-fallback') +
        ' sh4keys=[' + keys.join(',') + '] first12=[' + all.join(',') + ']' });
    } catch (e) { postMessage({ cmd: 'print', txt: '[5f-bind] audit threw: ' + e.message }); }
  }
  return {
    env: {
      memory:      mem,
      sh4_read8:   (viaTable && viaTable.r8)  || pick('sh4_mem_read8'),
      sh4_read16:  (viaTable && viaTable.r16) || pick('sh4_mem_read16'),
      sh4_read32:  (viaTable && viaTable.r32) || pick('sh4_mem_read32'),
      sh4_write8:  (viaTable && viaTable.w8)  || pick('sh4_mem_write8'),
      sh4_write16: (viaTable && viaTable.w16) || pick('sh4_mem_write16'),
      sh4_write32: (viaTable && viaTable.w32) || pick('sh4_mem_write32'),
      sh4_ifb:     (viaTable && viaTable.ifb)  || pick('sh4_interp_ifb'),
      sh4_shil_fb: (viaTable && viaTable.shil) || pick('sh4_interp_shil_fb'),
      // ORDER 21b Lever 1/2: global tail-link resolver + the shared table it
      // chains through. __indirect_function_table IS the wasmTable that
      // flycast_install_block grows/populates, so an emitted block's
      // return_call_indirect targets sibling blocks' slots directly.
      sh4_lookup_idx: (viaTable && viaTable.lk) || pick('sh4_jit_lookup_idx'),
      sh4_slice_end:  (viaTable && viaTable.se) || pick('sh4_slice_end'),
      __indirect_function_table: wasmTable,
    },
  };
}

// Last register_block error message, retrievable from C side via
// flycast_register_get_last_error(). postMessage from a pthread doesn't
// reach the page (goes to pthread's own message channel) — so we stash
// the error and let the C side log it via MAIN_THREAD_EM_ASM.
var flycast_last_register_error = '';
var flycast_worker_funcs_bind_logged = false;   // lever-5F binding audit one-shot

// nasomers-pattern install: compile block, instantiate, grow shared wasmTable,
// return new table index. C dispatcher in rec_wasm.cpp calls via fn pointer →
// WASM toolchain lowers to call_indirect against this same table, no JS hop.
// Keep instance refs alive so V8 doesn't GC the wasm code while the slot is in
// use. Returns 0 on failure (sentinel — slot 0 is unused/null fn).
var flycast_table_slots = [];   // index → Instance (GC root)
// Count of live WebAssembly.Instances this worker has created and pinned. Only
// read when an install throws — the per-block path (flycast_install_block)
// creates one Module+Instance per block and never releases them, so this is
// the number that identifies an engine module/instance-cap failure (the mobile
// arm) versus a codegen failure. Shard installs add ONE instance for N blocks.
var flycast_live_instances = 0;

// ?jitnames=1 (DIAG, page -> worker URL -> self.__dcJitNames): append a wasm
// "name" section so a CPU profile names every emitted block function by its
// guest PC ("pc_8c0123ab") instead of "wasm-function[N]". Export run_i is the
// block vaddrs[i]. Costs a parse of the export section per install; off by default.
function flycast_name_module(bytes, vaddrOf) {
  try {
    var p = 8, n = bytes.length, exportsMap = [];
    function leb() { var r = 0, sh = 0, b; do { b = bytes[p++]; r |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); return r >>> 0; }
    while (p < n) {
      var id = bytes[p++], size = leb(), end = p + size;
      if (id === 7) {
        var cnt = leb();
        for (var i = 0; i < cnt; i++) {
          var nl = leb(), nm = ''; for (var k = 0; k < nl; k++) nm += String.fromCharCode(bytes[p + k]); p += nl;
          var kind = bytes[p++], idx = leb();
          if (kind === 0 && /^run(_\d+)?$/.test(nm)) exportsMap.push([idx, nm === 'run' ? 0 : +nm.slice(4)]);
        }
      }
      p = end;
    }
    if (!exportsMap.length) return bytes;
    exportsMap.sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    function wl(v, arr) { do { var b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; arr.push(b); } while (v); }
    function ws(str, arr) { wl(str.length, arr); for (var i = 0; i < str.length; i++) arr.push(str.charCodeAt(i)); }
    var sub = []; wl(exportsMap.length, sub);
    for (var j = 0; j < exportsMap.length; j++) { wl(exportsMap[j][0], sub); ws('pc_' + (vaddrOf(exportsMap[j][1]) >>> 0).toString(16), sub); }
    var body = []; ws('name', body); body.push(1); wl(sub.length, body); for (var q = 0; q < sub.length; q++) body.push(sub[q]);
    out.push(0); wl(body.length, out); for (var r = 0; r < body.length; r++) out.push(body[r]);
    var res = new Uint8Array(bytes.length + out.length); res.set(bytes, 0); res.set(out, bytes.length);
    // ?jitdump=<hex pc> (DIAG): post the whole named module that holds that block, base64 in chunks
    if (self.__dcJitDump && !self.__dcJitDumped) {
      for (var z = 0; z < exportsMap.length; z++) {
        if (self.__dcJitDump === 'all' || (vaddrOf(exportsMap[z][1]) >>> 0).toString(16) === self.__dcJitDump) {
          if (self.__dcJitDump !== 'all') self.__dcJitDumped = true;
          var bin = ''; for (var y = 0; y < res.length; y++) bin += String.fromCharCode(res[y]);
          var b64 = btoa(bin), CH = 6000;
          postMessage({ cmd: 'print', txt: '[jitdump] begin pc=' + self.__dcJitDump + ' bytes=' + res.length + ' chunks=' + Math.ceil(b64.length / CH) });
          for (var c = 0; c < b64.length; c += CH) postMessage({ cmd: 'print', txt: '[jitdump] ' + (c / CH) + ' ' + b64.slice(c, c + CH) });
          postMessage({ cmd: 'print', txt: '[jitdump] end' });
          break;
        }
      }
    }
    return res;
  } catch (e) { return bytes; }
}

// ?jitcensus=1 (DIAG): the executed-op census. Every installed module's code
// section is parsed here; each function's ops are counted by class, split into
// d0 (not inside any if/else arm) and cond (inside one). The function's entry
// counter (wasm_emit.cpp emitCensusEntry: i32.const A; i32.const A; i32.load;
// i32.const 1; i32.add; i32.store) names its census id, (A - base) / 4.
// self.__dcCensusReport() weights each function's counts by its executions
// since the previous call. Memory/stack classes come from a small abstract
// stack: an address that is local 0 is ctx (guest registers, pc, cycles), one
// built from local 1 is guest RAM, an i32.const is a host global.
var flycast_census = { fn: Object.create(null), prev: null };
function flycast_census_parse(bytes) {
  try {
    var M = self.Module || Module; var base = M._flycast_census_info(1) >>> 0; if (!base) return;
    var p = 8, n = bytes.length, types = [], ftype = [], nimp = 0;
    function u() { var r = 0, sh = 0, b; do { b = bytes[p++]; r += (b & 0x7f) * Math.pow(2, sh); sh += 7; } while (b & 0x80); return r; }
    function s32() { var r = 0, sh = 0, b; do { b = bytes[p++]; r |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); if (sh < 32 && (b & 0x40)) r |= (-1 << sh); return r | 0; }
    function skipLeb() { while (bytes[p++] & 0x80) {} }
    while (p < n) {
      var id = bytes[p++], size = u(), end = p + size;
      if (id === 1) { var c = u(); for (var i = 0; i < c; i++) { p++; var np = u(); p += np; var nr = u(); p += nr; types.push([np, nr]); } }
      else if (id === 2) { var c2 = u(); for (var i2 = 0; i2 < c2; i2++) { var l1 = u(); p += l1; var l2 = u(); p += l2; var k = bytes[p++];
          if (k === 0) { ftype.push(u()); nimp++; } else if (k === 1) { p++; var fl = u(); u(); if (fl & 1) u(); } else if (k === 2) { var f2 = u(); u(); if (f2 & 1) u(); } else { p += 2; } } }
      else if (id === 3) { var c3 = u(); for (var i3 = 0; i3 < c3; i3++) ftype.push(u()); }
      else if (id === 10) {
        var nf = u();
        for (var fi = 0; fi < nf; fi++) {
          var bsz = u(), bend = p + bsz;
          var ng = u(); for (var g = 0; g < ng; g++) { u(); p++; }
          var H = Object.create(null), cid = -1, ctl = [], st = [], unr = false, ifd = 0, ops = [];
          var add = function (k) { var e = H[k] || (H[k] = [0, 0]); e[ifd > 0 ? 1 : 0]++; };
          var pop = function () { return unr ? 'x' : (st.length ? st.pop() : 'x'); };
          var push = function (t) { if (!unr) st.push(t); };
          var memk = function (t) { return t === 'ctx' ? 'ctx' : (t === 'ram' ? 'ram' : (t === 'c' ? 'abs' : 'oth')); };
          while (p < bend) {
            var o = bytes[p++], pos = ops.length; ops.push(o);
            if (o === 0x02 || o === 0x03 || o === 0x04) {
              var bt = bytes[p]; var nres = 0; if (bt === 0x40) p++; else if (bt >= 0x6f && bt <= 0x7f) { p++; nres = 1; } else { var ti = s32(); nres = types[ti] ? types[ti][1] : 0; }
              if (o === 0x04) { pop(); add('ctl.if'); } else add(o === 0x03 ? 'ctl.loop' : 'ctl.block');
              ctl.push({ k: o, h: st.length, r: nres, u: unr }); if (o === 0x04) ifd++;
              continue;
            }
            if (o === 0x05) { var fr = ctl[ctl.length - 1]; st.length = fr.h; unr = fr.u; add('ctl.else'); fr.k = 0x05; continue; }
            if (o === 0x0b) { var f3 = ctl.pop(); if (!f3) { add('ctl.end'); break; } if (f3.k === 0x04 || f3.k === 0x05) ifd--; st.length = f3.h; unr = f3.u; for (var r1 = 0; r1 < f3.r; r1++) push('v'); add('ctl.end'); continue; }
            if (o === 0x0c) { u(); add('ctl.br'); unr = true; st.length = 0; continue; }
            if (o === 0x0d) { u(); pop(); add('ctl.br_if'); continue; }
            if (o === 0x0e) { var cnt = u(); for (var q = 0; q <= cnt; q++) u(); pop(); add('ctl.br_table'); unr = true; st.length = 0; continue; }
            if (o === 0x0f) { add('ctl.return'); unr = true; st.length = 0; continue; }
            if (o === 0x00 || o === 0x01) { add('ctl.nop'); if (o === 0) { unr = true; st.length = 0; } continue; }
            if (o === 0x10 || o === 0x12) { var f = u(); var ty = types[ftype[f]] || [0, 0]; for (var a1 = 0; a1 < ty[0]; a1++) pop();
              add((o === 0x12 ? 'tail.return_call' : (f < nimp ? 'call.import' + f : 'call.local')));
              if (o === 0x12) { unr = true; st.length = 0; } else for (var r2 = 0; r2 < ty[1]; r2++) push('v'); continue; }
            if (o === 0x11 || o === 0x13) { var t2 = u(); u(); var ty2 = types[t2] || [0, 0]; pop(); for (var a2 = 0; a2 < ty2[0]; a2++) pop();
              add(o === 0x13 ? 'tail.return_call_indirect' : 'call.indirect'); if (o === 0x13) { unr = true; st.length = 0; } else for (var r3 = 0; r3 < ty2[1]; r3++) push('v'); continue; }
            if (o === 0x1a) { pop(); add('stk.drop'); continue; }
            if (o === 0x1b) { pop(); pop(); pop(); push('v'); add('alu.select'); continue; }
            if (o === 0x20) { var li = u(); push(li === 0 ? 'ctx' : (li === 1 ? 'rb' : 'v')); add('loc.get'); continue; }
            if (o === 0x21) { u(); pop(); add('loc.set'); continue; }
            if (o === 0x22) { u(); var tv = pop(); push(tv === 'c' ? 'v' : tv); add('loc.tee'); continue; }
            if (o === 0x23) { u(); push('v'); add('glb.get'); continue; }
            if (o === 0x24) { u(); pop(); add('glb.set'); continue; }
            if (o >= 0x28 && o <= 0x35) { u(); var off = u(); var at = pop(); var mk = memk(at); add(mk + '.load');
              if (mk === 'ctx') add('ctxoff.' + (off === 372 ? 'cycles' : off === 328 ? 'pc' : off === 340 ? 'T' : off === 332 ? 'jdyn' : off < 0x40 ? 'sq' : off < 0x80 ? 'xf' : off < 0xc0 ? 'fr' : off < 0x100 ? 'r' : 'sys') + '.load');
              push('v'); continue; }
            if (o >= 0x36 && o <= 0x3e) { u(); var off2 = u(); pop(); var at2 = pop(); var mk2 = memk(at2); add(mk2 + '.store');
              if (mk2 === 'ctx') add('ctxoff.' + (off2 === 372 ? 'cycles' : off2 === 328 ? 'pc' : off2 === 340 ? 'T' : off2 === 332 ? 'jdyn' : off2 < 0x40 ? 'sq' : off2 < 0x80 ? 'xf' : off2 < 0xc0 ? 'fr' : off2 < 0x100 ? 'r' : 'sys') + '.store');
              continue; }
            if (o === 0x3f || o === 0x40) { p++; if (o === 0x40) pop(); push('v'); add('mem.size'); continue; }
            if (o === 0x41) { var cv = s32(); push('c'); add('const.i32');
              if (cid < 0 && bytes[p] === 0x41) { var sp = p; p++; var cv2 = s32(); if (cv2 === cv && bytes[p] === 0x28) { var idx = ((cv >>> 0) - base) / 4; if (idx >= 0 && idx === Math.floor(idx) && idx < (M._flycast_census_info(0) >>> 0) + 1) { cid = idx; } } p = sp; }
              continue; }
            if (o === 0x42) { skipLeb(); push('v'); add('const.i64'); continue; }
            if (o === 0x43) { p += 4; push('v'); add('const.f'); continue; }
            if (o === 0x44) { p += 8; push('v'); add('const.f'); continue; }
            if (o === 0xfc) { var so = u(); if (so === 10) { p += 2; pop(); pop(); pop(); } else if (so === 11) { p += 1; pop(); pop(); pop(); } else if (so === 8) { u(); p++; pop(); pop(); pop(); } else if (so === 9) { u(); } else { pop(); push('v'); } add('bulk.' + so); continue; }
            if (o === 0x45 || o === 0x50 || (o >= 0x67 && o <= 0x69) || (o >= 0x79 && o <= 0x7b) || (o >= 0x8b && o <= 0x91) || (o >= 0x99 && o <= 0x9f) || (o >= 0xa7 && o <= 0xc4)) {
              pop(); push('v'); add(o === 0x45 ? 'alu.eqz' : (o >= 0xa7 ? 'cvt' : (o >= 0x8b ? 'fpu.un' : 'alu.un'))); continue; }
            if ((o >= 0x46 && o <= 0x4f) || (o >= 0x51 && o <= 0x5a)) { pop(); pop(); push('v'); add('alu.cmp'); continue; }
            if ((o >= 0x5b && o <= 0x66)) { pop(); pop(); push('v'); add('fpu.cmp'); continue; }
            if ((o >= 0x6a && o <= 0x78) || (o >= 0x7c && o <= 0x8a)) { var b2 = pop(), b1 = pop();
              push(o === 0x6a && (b1 === 'rb' || b2 === 'rb') ? 'ram' : 'v'); add(o === 0x6a || o === 0x7c ? 'alu.add' : (o === 0x71 || o === 0x83) ? 'alu.and' : 'alu.bin'); continue; }
            if ((o >= 0x92 && o <= 0x98) || (o >= 0xa0 && o <= 0xa6)) { pop(); pop(); push('v'); add('fpu.bin'); continue; }
            add('unk.' + o.toString(16)); p = bend; break;
          }
          p = bend;
          if (cid >= 0) { H['const.i32'][0] -= 3; H['abs.load'][0] -= 1; H['abs.store'][0] -= 1; H['alu.add'][0] -= 1; flycast_census.fn[cid] = H; }
        }
      }
      p = end;
    }
  } catch (e) { flycast_census.err = String(e); }
}
self.__dcCensusReport = function (top) {
  var M = self.Module || Module; top = top || 40;
  var N = M._flycast_census_info(0) >>> 0, C = M._flycast_census_info(1) >>> 2, V = M._flycast_census_info(2) >>> 2, G = M._flycast_census_info(3) >>> 2, Y = M._flycast_census_info(4) >>> 2;
  var cur = new Uint32Array(N); for (var i = 0; i < N; i++) cur[i] = HEAPU32[C + i];
  var prev = flycast_census.prev; flycast_census.prev = cur;
  var tot = Object.create(null), W = 0, GO = 0, CY = 0, missing = 0, blocks = [];
  for (var j = 0; j < N; j++) {
    var w = (cur[j] - (prev && j < prev.length ? prev[j] : 0)) >>> 0; if (!w) continue;
    var H = flycast_census.fn[j]; if (!H) { missing += w; continue; }
    W += w; GO += w * HEAPU32[G + j]; CY += w * HEAPU32[Y + j];
    var d0 = 0; for (var k in H) { var e = tot[k] || (tot[k] = [0, 0]); e[0] += w * H[k][0]; e[1] += w * H[k][1]; if (k.indexOf('ctxoff.') !== 0) d0 += H[k][0]; }
    blocks.push([j, w, d0]);
  }
  var D0 = 0, CO = 0; for (var k2 in tot) if (k2.indexOf('ctxoff.') !== 0) { D0 += tot[k2][0]; CO += tot[k2][1]; }
  blocks.sort(function (a, b) { return b[1] * b[2] - a[1] * a[2]; });
  return { trace: [5, 6, 7, 8, 9].map(function (i) { return M._flycast_census_info(i) >>> 0; }), entries: W, entriesMissing: missing, guestOps: GO, guestCycles: CY, d0: D0, cond: CO, d0PerGuestOp: GO ? D0 / GO : 0, condPerGuestOp: GO ? CO / GO : 0,
    guestOpsPerEntry: W ? GO / W : 0, parseErr: flycast_census.err || '',
    classes: Object.keys(tot).sort(function (a, b) { return tot[b][0] - tot[a][0]; }).map(function (k) { return [k, tot[k][0], tot[k][1]]; }),
    top: blocks.slice(0, top).map(function (x) { return [(HEAPU32[V + x[0]] >>> 0).toString(16), x[1], HEAPU32[G + x[0]], x[2]]; }) };
};

function flycast_install_block(bytesPtr, len, vaddr) {
  bytesPtr = bytesPtr >>> 0;
  len      = len      >>> 0;
  vaddr    = vaddr    >>> 0;
  try {
    var src   = HEAPU8.subarray(bytesPtr, bytesPtr + len);
    var bytes = new Uint8Array(src);
    if (self.__dcJitCensus) flycast_census_parse(bytes);
    if (self.__dcJitNames) bytes = flycast_name_module(bytes, function () { return vaddr; });
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
    flycast_live_instances++;
    return idx;
  } catch (e) {
    // This path is one Module + one Instance PER COMPILED BLOCK, every one
    // pinned in flycast_table_slots for the life of the worker (~12K live at
    // PSO boot scale). A mobile engine's per-agent module/instance cap is the
    // first thing that bites here, and the throw is indistinguishable from a
    // codegen error in the log without the count — so record it. The C caller
    // PARKS this vaddr for span-interp on a 0 return (rec_wasm.cpp compile(),
    // the `idx <= 0` arm): FPCA is already claimed by then, so it must never
    // be recompiled.
    flycast_last_register_error =
      ((e && e.message) ? e.message : String(e)) +
      ' [live_instances=' + flycast_live_instances +
      ' table_len=' + ((typeof wasmTable !== 'undefined' && wasmTable) ? wasmTable.length : -1) + ']';
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
    if (self.__dcJitCensus) flycast_census_parse(bytes);
    if (self.__dcJitNames) bytes = flycast_name_module(bytes, function (i) { return HEAPU32[(vaddrsPtr >>> 2) + i]; });
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
    flycast_live_instances++;
    return base_idx;
  } catch (e) {
    flycast_last_register_error =
      ((e && e.message) ? e.message : String(e)) +
      ' [live_instances=' + flycast_live_instances +
      ' table_len=' + ((typeof wasmTable !== 'undefined' && wasmTable) ? wasmTable.length : -1) + ']';
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
