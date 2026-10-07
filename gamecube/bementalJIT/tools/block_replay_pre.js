// block_replay_pre.js — --pre-js for tools/block_replay.cpp.
//
// THE EXECUTED-OP COUNTER. Every op number this tree published before this tool
// was a STATIC count of emitted ops (op_census) with conditional arms reported as
// an upper bound. This rewrites each emitted block module so that, when it RUNS,
// it adds the exact number of wasm ops it executed to counters in linear memory.
//
// How: a wasm function body has structured control flow with no byte offsets in
// its branches, so stack-neutral code can be inserted at ANY instruction boundary
// without fixing up anything. The body is cut into straight-line SEGMENTS — a new
// segment starts at the function entry, after every block/loop/if/else/end/br_if,
// after every unconditional transfer (br/br_table/return/return_call*/
// unreachable), and at every emit-phase mark — and each segment gets ONE counter
// increment at its head carrying that segment's static op counts. A segment runs
// to completion or not at all (calls return normally; a trap aborts the whole
// replay), so the sum is exact.
//
// An "op" is one wasm instruction as wasm-objdump prints it, `end` and `else`
// included (the same unit op_census_report.py counts), so the two instruments are
// directly comparable. Counter writes are i64 RMWs into cells the guest never
// reads; they change no guest-visible state. The DIFFERENTIAL mode of the
// driver never instruments, so exactness checks run on the unmodified bytes.
//
// Counter layout (u64 index into the cell array the driver passes):
//   0 prologue ops   1 body-head ops   2 guest-op ops   3 terminal ops   4 other
//   5 loads          6 stores          7 import calls   8 indirect/tail calls
//   9 consts        10 local get/set/tee  11 control (block..br_table)
//  12 guest instrs entered (one per BEM_MARK_OP head)   13 block entries
//  14 terminal loads
(function () {
  'use strict';
  const NCNT = 16;

  function leb(u8, p) {           // unsigned LEB -> [value, next]
    let r = 0, s = 0, b;
    do { b = u8[p++]; r += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80);
    return [r, p];
  }
  function sleb(u8, p) {          // signed LEB, skip only
    let b; do { b = u8[p++]; } while (b & 0x80); return p;
  }
  function encLeb(v, out) {
    do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v);
  }
  function encSleb(v, out) {      // v is a JS number in int64-safe range
    let more = true;
    while (more) {
      let b = v & 0x7f;
      v = Math.floor(v / 128);
      if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) more = false;
      else b |= 0x80;
      out.push(b);
    }
  }

  // Decode ONE instruction at p. Returns {next, op, cls} where cls is one of
  // 'load' 'store' 'call' 'icall' 'const' 'local' 'ctrl' 'other', plus flags.
  function decode(u8, p) {
    const op = u8[p++];
    let cls = 'other', split = 0;   // split: 1 = segment ends AFTER this op
    switch (op) {
      case 0x02: case 0x03: case 0x04: p = sleb(u8, p); cls = 'ctrl'; split = 1; break;
      case 0x05: case 0x0B: cls = 'ctrl'; split = 1; break;
      case 0x00: case 0x0F: split = 1; cls = 'ctrl'; break;
      case 0x01: case 0x1A: case 0x1B: break;
      case 0x0C: case 0x0D: p = leb(u8, p)[1]; cls = 'ctrl'; split = 1; break;
      case 0x0E: { let n; [n, p] = leb(u8, p); for (let i = 0; i <= n; i++) p = leb(u8, p)[1];
                   cls = 'ctrl'; split = 1; break; }
      case 0x10: p = leb(u8, p)[1]; cls = 'call'; break;
      case 0x11: p = leb(u8, p)[1]; p = leb(u8, p)[1]; cls = 'icall'; break;
      case 0x12: p = leb(u8, p)[1]; cls = 'icall'; split = 1; break;
      case 0x13: p = leb(u8, p)[1]; p = leb(u8, p)[1]; cls = 'icall'; split = 1; break;
      case 0x1C: { let n; [n, p] = leb(u8, p); p += n; break; }
      case 0x20: case 0x21: case 0x22: p = leb(u8, p)[1]; cls = 'local'; break;
      case 0x23: case 0x24: p = leb(u8, p)[1]; break;
      case 0x3F: case 0x40: p += 1; break;
      case 0x41: case 0x42: p = sleb(u8, p); cls = 'const'; break;
      case 0x43: p += 4; cls = 'const'; break;
      case 0x44: p += 8; cls = 'const'; break;
      case 0xFC: { let s; [s, p] = leb(u8, p);
        if (s === 8) { p = leb(u8, p)[1]; p += 1; }
        else if (s === 9) p = leb(u8, p)[1];
        else if (s === 10) p += 2;
        else if (s === 11) { p += 1; cls = 'store'; }
        break; }
      case 0xFD: { let s; [s, p] = leb(u8, p);
        if (s <= 11 || s === 92 || s === 93) {            // v128 loads/stores
          p = leb(u8, p)[1]; p = leb(u8, p)[1];
          cls = (s === 11) ? 'store' : 'load';
        } else if (s >= 84 && s <= 91) {                  // load/store lane
          p = leb(u8, p)[1]; p = leb(u8, p)[1]; p += 1;
          cls = (s >= 88) ? 'store' : 'load';
        } else if (s === 12 || s === 13) { p += 16; if (s === 12) cls = 'const'; }
        else if (s >= 21 && s <= 34) p += 1;
        break; }
      case 0xFE: { let s; [s, p] = leb(u8, p);
        if (s === 3) p += 1; else { p = leb(u8, p)[1]; p = leb(u8, p)[1]; cls = 'load'; }
        break; }
      default:
        if (op >= 0x28 && op <= 0x35) { p = leb(u8, p)[1]; p = leb(u8, p)[1]; cls = 'load'; }
        else if (op >= 0x36 && op <= 0x3E) { p = leb(u8, p)[1]; p = leb(u8, p)[1]; cls = 'store'; }
        else if (op >= 0x45 && op <= 0xC4) { /* numeric, no immediate */ }
        else if (op === 0xD0) p += 1;
        else if (op === 0xD1) { }
        else if (op === 0xD2) p = leb(u8, p)[1];
        else throw new Error('block_replay: unknown opcode 0x' + op.toString(16) + ' at ' + (p - 1));
    }
    return { next: p, op, cls, split };
  }

  // Emit `cell[idx] += k` (i64) — stack-neutral.
  function emitAdd(out, base, idx, k) {
    const a = base + idx * 8;
    out.push(0x41); encSleb(a | 0, out);
    out.push(0x41); encSleb(a | 0, out);
    out.push(0x29, 0x03, 0x00);           // i64.load align=3 off=0
    out.push(0x42); encSleb(k, out);      // i64.const k
    out.push(0x7C);                       // i64.add
    out.push(0x37, 0x03, 0x00);           // i64.store align=3 off=0
  }

  // Guest mnemonic (subset of op_census_report.py's table; unknown -> opN[.xo]).
  const P = {3:'twi',7:'mulli',8:'subfic',10:'cmpli',11:'cmpi',12:'addic',13:'addic.',14:'addi',
    15:'addis',16:'bc',17:'sc',18:'b',20:'rlwimi',21:'rlwinm',23:'rlwnm',24:'ori',25:'oris',
    26:'xori',27:'xoris',28:'andi.',29:'andis.',32:'lwz',33:'lwzu',34:'lbz',35:'lbzu',36:'stw',
    37:'stwu',38:'stb',39:'stbu',40:'lhz',41:'lhzu',42:'lha',43:'lhau',44:'sth',45:'sthu',
    46:'lmw',47:'stmw',48:'lfs',49:'lfsu',50:'lfd',51:'lfdu',52:'stfs',53:'stfsu',54:'stfd',
    55:'stfdu',56:'psq_l',57:'psq_lu',60:'psq_st',61:'psq_stu'};
  const X31 = {0:'cmp',8:'subfc',10:'addc',11:'mulhwu',19:'mfcr',23:'lwzx',24:'slw',26:'cntlzw',
    28:'and',32:'cmpl',40:'subf',60:'andc',75:'mulhw',83:'mfmsr',86:'dcbf',87:'lbzx',104:'neg',
    124:'nor',136:'subfe',138:'adde',144:'mtcrf',146:'mtmsr',151:'stwx',200:'subfze',202:'addze',
    215:'stbx',235:'mullw',266:'add',279:'lhzx',316:'xor',339:'mfspr',343:'lhax',371:'mftb',
    407:'sthx',444:'or',459:'divwu',467:'mtspr',470:'dcbi',476:'nand',491:'divw',535:'lfsx',
    536:'srw',599:'lfdx',663:'stfsx',727:'stfdx',792:'sraw',824:'srawi',922:'extsh',954:'extsb',
    982:'icbi',983:'stfiwx',1014:'dcbz',598:'sync',854:'eieio'};
  const X19 = {0:'mcrf',16:'bclr',33:'crnor',50:'rfi',129:'crandc',150:'isync',193:'crxor',
    225:'crnand',257:'crand',289:'creqv',417:'crorc',449:'cror',528:'bcctr'};
  const X63 = {0:'fcmpu',12:'frsp',14:'fctiw',15:'fctiwz',32:'fcmpo',38:'mtfsb1',40:'fneg',
    70:'mtfsb0',72:'fmr',134:'mtfsfi',136:'fnabs',264:'fabs',583:'mffs',711:'mtfsf'};
  const A5 = {18:'fdiv',20:'fsub',21:'fadd',22:'fsqrt',23:'fsel',24:'fres',25:'fmul',
    26:'frsqrte',28:'fmsub',29:'fmadd',30:'fnmsub',31:'fnmadd'};
  const PS5 = {10:'ps_sum0',11:'ps_sum1',12:'ps_muls0',13:'ps_muls1',14:'ps_madds0',
    15:'ps_madds1',18:'ps_div',20:'ps_sub',21:'ps_add',23:'ps_sel',24:'ps_res',25:'ps_mul',
    26:'ps_rsqrte',28:'ps_msub',29:'ps_madd',30:'ps_nmsub',31:'ps_nmadd'};
  const PS10 = {0:'ps_cmpu0',32:'ps_cmpo0',40:'ps_neg',64:'ps_cmpu1',72:'ps_mr',96:'ps_cmpo1',
    136:'ps_nabs',264:'ps_abs',528:'ps_merge00',560:'ps_merge01',592:'ps_merge10',
    624:'ps_merge11',1014:'dcbz_l'};
  function mnem(w) {
    const op = w >>> 26, x10 = (w >>> 1) & 0x3FF, x5 = (w >>> 1) & 0x1F;
    if (P[op]) {
      if (op === 16) { const bo = (w >>> 21) & 31; return bo === 20 ? 'bc(al)' : (bo & 4) ? 'bc' : 'bdnz/bc-ctr'; }
      return P[op];
    }
    if (op === 31) return X31[x10] || ('op31.' + x10);
    if (op === 19) {
      const n = X19[x10] || ('op19.' + x10);
      if (x10 === 16) return (((w >>> 21) & 31) === 20) ? 'blr' : 'bclr(cond)';
      return n;
    }
    if (op === 63) return (A5[x5] && !X63[x10]) ? A5[x5] : (X63[x10] || A5[x5] || ('op63.' + x10));
    if (op === 59) return (A5[x5] || ('op59.' + x5)) + 's';
    if (op === 4) return PS10[x10] || PS5[x5] || ('op4.' + x10);
    return 'op' + op;
  }
  const classIdx = new Map();
  const classNames = [];
  function classOf(name) {
    let i = classIdx.get(name);
    if (i === undefined) {
      if (classNames.length >= 255) return 255;
      i = classNames.length; classNames.push(name); classIdx.set(name, i);
    }
    return i;
  }
  const PCT = { base: 0, cap: 0, ids: new Map(), pcs: [] };
  Module.bemReplaySetPcTable = function (base, cap) { PCT.base = base >>> 0; PCT.cap = cap; };
  // Top-N guest PCs by executed ops: pc, mnemonic, occurrences, ops, ops/occ.
  Module.bemReplayPrintPcs = function (topn, mem1) {
    const b32 = PCT.base >> 2;
    const U = (i) => HEAPU32[b32 + 2 * i] + 4294967296 * HEAPU32[b32 + 2 * i + 1];
    const rows = [];
    let tot = 0;
    for (let id = 0; id < PCT.pcs.length; id++) {
      const ops = U(2 * id), occ = U(2 * id + 1);
      tot += ops;
      rows.push([PCT.pcs[id], occ, ops]);
    }
    rows.sort((a, b) => b[2] - a[2]);
    // BR_PC_DUMP=<file>: every row (pc occ ops), for offline edge/terminator analysis.
    if (typeof process !== 'undefined' && process.env && process.env.BR_PC_DUMP) {
      require('fs').writeFileSync(process.env.BR_PC_DUMP,
        rows.map((r) => r[0].toString(16).padStart(8, '0') + ' ' + r[1] + ' ' + r[2]).join('\n') + '\n');
    }
    let out = '[replay] top guest PCs by executed ops (op spans only; ' + PCT.pcs.length + ' pcs, ' + tot + ' ops)\n';
    out += '  pc        word      mnem          occ        ops   ops%  ops/occ\n';
    for (const [pc, occ, ops] of rows.slice(0, topn)) {
      const a = mem1 + (pc & 0x01FFFFFF);
      const w = ((HEAPU8[a] << 24) | (HEAPU8[a + 1] << 16) | (HEAPU8[a + 2] << 8) | HEAPU8[a + 3]) >>> 0;
      out += '  ' + pc.toString(16).padStart(8, '0') + '  ' + w.toString(16).padStart(8, '0') + '  ' +
             mnem(w).padEnd(10) + String(occ).padStart(9) + String(ops).padStart(11) +
             (100 * ops / tot).toFixed(2).padStart(7) + (occ ? (ops / occ).toFixed(1) : '-').padStart(9) + '\n';
    }
    console.error(out);
  };
  Module.bemReplayClasses = () => classNames.slice();
  Module.bemReplayPrintClasses = function (cellPtr, topn) {
    const b32 = cellPtr >> 2;
    const U = (i) => HEAPU32[b32 + 2 * i] + 4294967296 * HEAPU32[b32 + 2 * i + 1];
    const rows = [];
    let tot = 0, totOcc = 0;
    for (let k = 0; k < classNames.length; k++) {
      const ops = U(16 + k), occ = U(272 + k);
      tot += ops; totOcc += occ;
      rows.push([classNames[k], occ, ops]);
    }
    rows.sort((a, b) => b[2] - a[2]);
    let out = '[replay] guest-op classes (ops inside each op span; epilogue/terminal excluded)\n';
    out += '  class           occ     occ%        ops    ops%  ops/occ\n';
    for (const [n, occ, ops] of rows.slice(0, topn)) {
      out += '  ' + n.padEnd(12) + String(occ).padStart(9) + (100 * occ / totOcc).toFixed(2).padStart(9) +
             String(ops).padStart(11) + (100 * ops / tot).toFixed(2).padStart(8) +
             (occ ? (ops / occ).toFixed(1) : '-').padStart(9) + '\n';
    }
    console.error(out);
  };

  // marks: flat array [tag, off, pc, ...] (module byte offsets, emit order).
  // memBase: linear address of guest MEM1 (to name OP marks).
  function instrument(u8, marks, cellBase, memBase) {
    // ---- section walk ----
    let p = 8;
    const secs = [];
    while (p < u8.length) {
      const id = u8[p];
      const [sz, q] = leb(u8, p + 1);
      secs.push({ id, start: p, payload: q, end: q + sz });
      p = q + sz;
    }
    const code = secs.find(s => s.id === 10);
    if (!code) throw new Error('no code section');
    // mark positions -> phase by offset (sorted as emitted; offsets ascend
    // within an arm and restart from a lower phase on a second arm, which is
    // fine because we look up the LATEST mark at or before an offset in
    // emission order by binary search over a sorted copy).
    const mk = [];
    const opClassAt = new Map();      // off -> class index (OP marks)
    const opPcAt = new Map();         // off -> guest pc (OP marks)
    for (let i = 0; i < marks.length; i += 3) {
      mk.push([marks[i + 1], marks[i]]);
      if (marks[i] === 2 && memBase) {
        const a = memBase + ((marks[i + 2] >>> 0) & 0x01FFFFFF);
        const w = ((HEAPU8[a] << 24) | (HEAPU8[a + 1] << 16) | (HEAPU8[a + 2] << 8) | HEAPU8[a + 3]) >>> 0;
        opClassAt.set(marks[i + 1], classOf(mnem(w)));
        opPcAt.set(marks[i + 1], marks[i + 2] >>> 0);
      }
    }
    mk.sort((a, b) => a[0] - b[0] || 0);
    const markAt = new Map();          // off -> tag (OP marks matter for guest count)
    for (const [off, tag] of mk) {
      if (!markAt.has(off) || tag === 2) markAt.set(off, tag);
    }
    function phaseAt(off) {            // latest mark <= off
      let lo = 0, hi = mk.length - 1, r = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (mk[m][0] <= off) { r = m; lo = m + 1; } else hi = m - 1; }
      if (r < 0) return 4;
      const t = mk[r][1];
      return t === 0 ? 0 : t === 1 ? 1 : t === 2 ? 2 : t === 3 ? 3 : t === 5 ? 15 : 4;
    }
    // [per-PC 2026-10-04] guest PC of the latest mark <= off when that mark is
    // an OP mark (else -1). Each distinct PC gets a stable id; the segment's
    // op count goes to pcCells[2*id] and one occurrence to pcCells[2*id+1] at
    // the op's head. Recompiles of the same PC share the id.
    function opPcFor(off) {
      let lo = 0, hi = mk.length - 1, r = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (mk[m][0] <= off) { r = m; lo = m + 1; } else hi = m - 1; }
      if (r < 0 || mk[r][1] !== 2) return -1;
      const pc = opPcAt.get(mk[r][0]);
      return pc === undefined ? -1 : pc;
    }
    function opClassFor(off) {         // class of the latest OP mark <= off, if the
      let lo = 0, hi = mk.length - 1, r = -1;   // latest mark IS an OP mark
      while (lo <= hi) { const m = (lo + hi) >> 1; if (mk[m][0] <= off) { r = m; lo = m + 1; } else hi = m - 1; }
      if (r < 0 || mk[r][1] !== 2) return -1;
      const c = opClassAt.get(mk[r][0]);
      return c === undefined ? -1 : c;
    }

    let [nfun, fp] = leb(u8, code.payload);
    const bodiesOut = [];
    for (let f = 0; f < nfun; f++) {
      const [bsz, bstart] = leb(u8, fp);
      const bend = bstart + bsz;
      // locals
      let [nl, lp] = leb(u8, bstart);
      for (let i = 0; i < nl; i++) { lp = leb(u8, lp)[1]; lp += 1; }
      const localsBytes = u8.subarray(bstart, lp);
      // decode all instructions
      const ins = [];
      for (let q = lp; q < bend;) { const d = decode(u8, q); ins.push({ at: q, ...d }); q = d.next; }
      // segments
      const out = [];
      let segStart = 0;
      const flush = (from, to) => {            // ins[from..to) is one segment
        if (from >= to) return;
        const head = ins[from].at;
        const ph = phaseAt(head);
        const c = new Array(NCNT).fill(0);
        const oc = opClassFor(head);
        for (let i = from; i < to; i++) {
          const x = ins[i];
          c[phaseAt(x.at)] += 1;
          if (x.cls === 'load') { c[5]++; if (phaseAt(x.at) === 3) c[14]++; }
          else if (x.cls === 'store') c[6]++;
          else if (x.cls === 'call') c[7]++;
          else if (x.cls === 'icall') c[8]++;
          else if (x.cls === 'const') c[9]++;
          else if (x.cls === 'local') c[10]++;
          else if (x.cls === 'ctrl') c[11]++;
        }
        if (markAt.get(head) === 2) c[12] = 1;
        if (from === 0 && f === 0) c[13] = 1;   // function entry = one block entry
        void ph;
        for (let k = 0; k < NCNT; k++) if (c[k]) emitAdd(out, cellBase, k, c[k]);
        const opc = PCT.base ? opPcFor(head) : -1;
        if (opc >= 0) {
          let id = PCT.ids.get(opc);
          if (id === undefined && PCT.pcs.length < PCT.cap) { id = PCT.pcs.length; PCT.pcs.push(opc); PCT.ids.set(opc, id); }
          if (id !== undefined) {
            emitAdd(out, PCT.base, 2 * id, to - from);
            if (c[12]) emitAdd(out, PCT.base, 2 * id + 1, 1);
          }
        }
        if (oc >= 0) {
          emitAdd(out, cellBase, 16 + oc, to - from);
          if (c[12]) emitAdd(out, cellBase, 272 + oc, 1);
        }
        for (let i = from; i < to; i++) for (let b = ins[i].at; b < ins[i].next; b++) out.push(u8[b]);
      };
      for (let i = 0; i < ins.length; i++) {
        // a mark at this instruction starts a new segment
        if (i > segStart && markAt.has(ins[i].at)) { flush(segStart, i); segStart = i; }
        if (ins[i].split) { flush(segStart, i + 1); segStart = i + 1; }
      }
      flush(segStart, ins.length);
      const body = [];
      for (const b of localsBytes) body.push(b);
      for (const b of out) body.push(b);
      bodiesOut.push(body);
      fp = bend;
    }
    // ---- reassemble ----
    const payload = [];
    encLeb(nfun, payload);
    for (const b of bodiesOut) { encLeb(b.length, payload); for (const x of b) payload.push(x); }
    const parts = [u8.subarray(0, code.start)];
    const hdr = [10]; encLeb(payload.length, hdr);
    parts.push(Uint8Array.from(hdr), Uint8Array.from(payload), u8.subarray(code.end));
    let n = 0; for (const x of parts) n += x.length;
    const res = new Uint8Array(n); let o = 0;
    for (const x of parts) { res.set(x, o); o += x.length; }
    return res;
  }

  // Host imports for the replay (see block_replay.cpp install_imports).
  Module.bemReplayInstallImports = function (mem1, ctx, gpbuf, gpdirty) {
        
        if (!Module.bemental_imports) Module.bemental_imports = { env: {} };
        const env = Module.bemental_imports.env;
        const st = Module.__replay = {
            mmioR: 0, mmioW: 0, otherR: 0, otherW: 0, ramR: 0, ramW: 0,
            interp: 0, interpPc: 0, interpInst: 0, drains: 0, wpar: 0,
            checkExc: 0, hle: 0, mmioAddrs: {}, gpHash: 0x811C9DC5 | 0, gpBytes: 0
        };
        function phys(a) { return ((a >>> 0) & 0x3E000000) === 0 ? ((a >>> 0) & 0x01FFFFFF) : -1; }
        function noteMmio(a, w) {
            a >>>= 0;
            if ((a & 0xFF000000) === 0xCC000000) {
                if (w) st.mmioW++; else st.mmioR++;
                const k = (w ? 'W' : 'R') + (a & 0xFFFFFFF0).toString(16);
                st.mmioAddrs[k] = (st.mmioAddrs[k] | 0) + 1;
            } else { if (w) st.otherW++; else st.otherR++; }
        }
        env.ppc_read8 = function (a) { const p = phys(a); if (p < 0) { noteMmio(a, 0); return 0; }
            st.ramR++; return HEAPU8[mem1 + p]; };
        env.ppc_read16 = function (a) { const p = phys(a); if (p < 0) { noteMmio(a, 0); return 0; }
            st.ramR++; return (HEAPU8[mem1 + p] << 8) | HEAPU8[mem1 + p + 1]; };
        env.ppc_read32 = function (a) { const p = phys(a); if (p < 0) { noteMmio(a, 0); return 0; }
            st.ramR++; return ((HEAPU8[mem1 + p] << 24) | (HEAPU8[mem1 + p + 1] << 16) |
                               (HEAPU8[mem1 + p + 2] << 8) | HEAPU8[mem1 + p + 3]) | 0; };
        env.ppc_write8 = function (a, v) { const p = phys(a); if (p < 0) { if (((a >>> 0) & 0x0FFFFFFF) === 0x0C008000) st.wpar++; else noteMmio(a, 1); return; }
            st.ramW++; HEAPU8[mem1 + p] = v & 0xFF; };
        env.ppc_write16 = function (a, v) { const p = phys(a); if (p < 0) { if (((a >>> 0) & 0x0FFFFFFF) === 0x0C008000) st.wpar++; else noteMmio(a, 1); return; }
            st.ramW++; HEAPU8[mem1 + p] = (v >>> 8) & 0xFF; HEAPU8[mem1 + p + 1] = v & 0xFF; };
        env.ppc_write32 = function (a, v) { const p = phys(a); if (p < 0) { if (((a >>> 0) & 0x0FFFFFFF) === 0x0C008000) st.wpar++; else noteMmio(a, 1); return; }
            st.ramW++; HEAPU8[mem1 + p] = (v >>> 24) & 0xFF; HEAPU8[mem1 + p + 1] = (v >>> 16) & 0xFF;
            HEAPU8[mem1 + p + 2] = (v >>> 8) & 0xFF; HEAPU8[mem1 + p + 3] = v & 0xFF; };
        // No interpreter here: record the first fallback and end the slice
        // (downcount = 0) so the driver stops right after this block.
        // A MINIMAL interpreter for the fallback encodings whose Dolphin
        // Interpreter semantics are a plain register move (cited per case);
        // anything else is recorded and ENDS the replay (downcount = 0, so the
        // driver stops right after this block). Contract (emit_fallback,
        // ppc_emit.cpp): the host executes the op and advances pc/npc to pc+4;
        // GPRs/FPRs were flushed to ctx before the call and are reloaded after.
        const G = (r) => (ctx + 0x14 + 4 * r) >> 2;
        const SPR = (n) => (ctx + 0x340 + 4 * n) >> 2;
        st.fallbackOps = {};
        st.tb = 0;
        function advance(pc) { HEAP32[ctx >> 2] = (pc + 4) | 0; HEAP32[(ctx + 4) >> 2] = (pc + 4) | 0; }
        env.ppc_interp = function (inst, pc) {
            inst >>>= 0; pc >>>= 0;
            const op = inst >>> 26, xo = (inst >>> 1) & 0x3FF;
            const r = (inst >>> 21) & 31;
            const spr = ((inst >>> 16) & 31) | (((inst >>> 11) & 31) << 5);
            const key = op === 31 ? ('31.' + xo + (xo === 467 || xo === 339 ? ':' + spr : '')) : ('' + op);
            st.fallbackOps[key] = (st.fallbackOps[key] | 0) + 1;
            // mtspr GQR0-7 (912..919) / HID2 (920): Interpreter_SystemRegisters.cpp
            // mtspr does spr[index] = gpr[RD]; the GQR cases are a bare `break`,
            // and HID2 only re-derives cache-lock flags that the JIT reads at
            // emit time (none of which this replay models).
            // HID0 (1008): the same store, then Interpreter clears ICFI (0x800)
            // after "flushing" the icache. Everything that is NOT a plain move
            // in Interpreter::mtspr (DEC, TB writes, WPAR, DMA) falls through
            // to the halt below.
            if (op === 31 && xo === 467 && ((spr >= 912 && spr <= 920) || spr === 1008 ||
                                            spr === 1009 || spr === 1011)) {
                HEAP32[SPR(spr)] = HEAP32[G(r)];
                if (spr === 1008) HEAP32[SPR(spr)] &= ~0x800;
                advance(pc); return;
            }
            // mfspr of a plain SPR: Interpreter mfspr default = gpr[RD] = spr[index].
            if (op === 31 && xo === 339 && spr !== 22 && spr !== 268 && spr !== 269) {
                HEAP32[G(r)] = HEAP32[SPR(spr)]; advance(pc); return;
            }
            // mfcr (31/19): gpr[RD] = cr.Get() — ConditionRegister::Get packs each
            // u64 field via GetField (LT/GT/EQ/SO as decoded above).
            if (op === 31 && xo === 19) {
                let v = 0;
                for (let f = 0; f < 8; f++) {
                    const lo = HEAP32[(ctx + 0x2A0 + 8 * f) >> 2] >>> 0;
                    const hi = HEAP32[(ctx + 0x2A0 + 8 * f + 4) >> 2] | 0;
                    const lt = (hi & (1 << 30)) ? 8 : 0;
                    const gt = (hi > 0 || (hi === 0 && lo !== 0)) ? 4 : 0;
                    const eq = (lo === 0) ? 2 : 0;
                    const so = (hi & (1 << 27)) ? 1 : 0;
                    v |= (lt | gt | eq | so) << (4 * (7 - f));
                }
                HEAP32[G(r)] = v | 0; advance(pc); return;
            }
            // mtcrf (31/144): for each CRM bit, cr.SetField(i, (rS >> 4*(7-i)) & 0xF)
            // via PPCToInternal.
            if (op === 31 && xo === 144) {
                const crm = (inst >>> 12) & 0xFF, v = HEAP32[G(r)] >>> 0;
                for (let f = 0; f < 8; f++) {
                    if (!(crm & (0x80 >>> f))) continue;
                    const cc = (v >>> (4 * (7 - f))) & 0xF;
                    let hi = 1;
                    if (cc & 1) hi |= (1 << 27);
                    if (!(cc & 4)) hi |= (1 << 31);
                    if (cc & 8) hi |= (1 << 30);
                    HEAP32[(ctx + 0x2A0 + 8 * f) >> 2] = (cc & 2) ? 0 : 1;
                    HEAP32[(ctx + 0x2A0 + 8 * f + 4) >> 2] = hi | 0;
                }
                advance(pc); return;
            }
            // sc: Interpreter::sc raises EXCEPTION_SYSCALL and CheckExceptions
            // delivers it at once (PowerPC.cpp, EXCEPTION_SYSCALL arm, incl. the
            // port's [me-preserve] ME re-set).
            if (op === 17) {
                const MSR = (ctx + 0x2E0) >> 2;
                let msr = HEAP32[MSR] >>> 0;
                HEAP32[SPR(26)] = (pc + 4) | 0;
                HEAP32[SPR(27)] = (msr & 0x87C0FFFF) | 0;
                msr = (msr & ~1) | ((msr >>> 16) & 1);
                msr = (msr & ~0x04EF36) | 0x1000;
                HEAP32[MSR] = msr | 0;
                HEAP32[ctx >> 2] = 0xC00; HEAP32[(ctx + 4) >> 2] = 0xC00;
                return;
            }
            // rfi: Interpreter_Branch.cpp rfi — MSR from SRR1 under 0x87C0FFFF,
            // MSR[13] cleared, resume at SRR0.
            if (op === 19 && xo === 50) {
                const MSR = (ctx + 0x2E0) >> 2;
                const mask = 0x87C0FFFF;
                let msr = ((HEAP32[MSR] & ~mask) | (HEAP32[SPR(27)] & mask)) & 0xFFFBFFFF;
                HEAP32[MSR] = msr | 0;
                const t = HEAP32[SPR(26)] | 0;
                HEAP32[ctx >> 2] = t; HEAP32[(ctx + 4) >> 2] = t;
                return;
            }
            // mftb / mfspr TBL,TBU: no CoreTiming here. A deterministic fake that
            // advances per read keeps both arms of a differential identical.
            if (op === 31 && (xo === 371 || (xo === 339 && (spr === 268 || spr === 269)))) {
                const tbr = xo === 371 ? spr : spr;
                st.tb += 64;
                HEAP32[G(r)] = (tbr === 269) ? 0 : (st.tb | 0); advance(pc); return;
            }
            // bclr / bcctr (any BO, any LK) and bc with LK: Interpreter_Branch.cpp
            // bclrx/bcctrx/bcx, decoded exactly. CR bits from Dolphin's u64
            // field encoding (ConditionRegister.h): LT = hi&(1<<30),
            // GT = (s64)field > 0, EQ = lo == 0, SO = hi&(1<<27).
            if ((op === 19 && (xo === 16 || xo === 528)) || op === 16) {
                const bo = (inst >>> 21) & 31, bi = (inst >>> 16) & 31, lk = inst & 1;
                const f = bi >>> 2, b = bi & 3;
                const lo = HEAP32[(ctx + 0x2A0 + 8 * f) >> 2] >>> 0;
                const hi = HEAP32[(ctx + 0x2A0 + 8 * f + 4) >> 2] | 0;
                const crbit = b === 0 ? ((hi & (1 << 30)) !== 0) :
                              b === 1 ? (hi > 0 || (hi === 0 && lo !== 0)) :
                              b === 2 ? (lo === 0) : ((hi & (1 << 27)) !== 0);
                const LR = SPR(8), CTR = SPR(9);
                const isctr = (op === 19 && xo === 528);
                if (!(bo & 4) && !isctr) HEAP32[CTR] = (HEAP32[CTR] - 1) | 0;
                const ctr_ok = (bo & 4) || ((HEAP32[CTR] !== 0) !== ((bo & 2) !== 0));
                const cond_ok = (bo & 16) || (crbit === ((bo & 8) !== 0));
                let npc = (pc + 4) >>> 0;
                if (ctr_ok && cond_ok) {
                    if (op === 16) {
                        let bd = inst & 0xFFFC; if (bd & 0x8000) bd |= 0xFFFF0000;
                        npc = (inst & 2) ? (bd >>> 0) : ((pc + bd) >>> 0);
                    } else {
                        npc = ((isctr ? HEAP32[CTR] : HEAP32[LR]) & ~3) >>> 0;
                    }
                }
                if (lk) HEAP32[LR] = (pc + 4) | 0;
                HEAP32[ctx >> 2] = npc | 0; HEAP32[(ctx + 4) >> 2] = npc | 0;
                return;
            }
            // ps_cmpu0/ps_cmpo0/ps_cmpu1/ps_cmpo1 (op4 xo 0/32/64/96) and
            // fcmpu/fcmpo (op63 xo 0/32): Interpreter_FloatingPoint.cpp
            // Helper_FloatCompare{Ordered,Unordered} + SetFPException +
            // UpdateFPExceptionSummary (Interpreter_FPUtils.h), CR via
            // ConditionRegister::PPCToInternal.
            if ((op === 4 && (xo === 0 || xo === 32 || xo === 64 || xo === 96)) ||
                (op === 63 && (xo === 0 || xo === 32))) {
                const lane = (op === 4 && xo >= 64) ? 8 : 0;
                const ordered = (xo === 32 || xo === 96);
                const fa = (inst >>> 16) & 31, fb = (inst >>> 11) & 31, crf = (inst >>> 23) & 7;
                const dv = new DataView(HEAPU8.buffer);
                const a = dv.getFloat64(ctx + 0xA0 + 16 * fa + lane, true);
                const b = dv.getFloat64(ctx + 0xA0 + 16 * fb + lane, true);
                const snan = (off) => {
                    const hi = dv.getUint32(off + 4, true), lo = dv.getUint32(off, true);
                    return ((hi >>> 20) & 0x7FF) === 0x7FF && ((hi & 0xFFFFF) | lo) !== 0 && (hi & 0x80000) === 0;
                };
                const FPSCR = (ctx + 0x2E4) >> 2;
                let fpscr = HEAP32[FPSCR] >>> 0;
                const setExc = (mask) => {
                    if (((fpscr & mask) >>> 0) !== mask) fpscr |= 0x80000000;
                    fpscr |= mask;
                };
                let cc;
                if (a !== a || b !== b) {
                    cc = 1;
                    const sn = snan(ctx + 0xA0 + 16 * fa + lane) || snan(ctx + 0xA0 + 16 * fb + lane);
                    if (ordered) {
                        if (sn) { setExc(0x01000000); if (!(fpscr & 0x80)) setExc(0x00080000); }
                        else setExc(0x00080000);
                    } else if (sn) setExc(0x01000000);
                } else cc = a < b ? 8 : a > b ? 4 : 2;
                // UpdateFPExceptionSummary: VX = OR of the VX* bits; FEX = enabled & set.
                const vx = (fpscr & 0x01F80700) !== 0;
                fpscr = vx ? (fpscr | 0x20000000) : (fpscr & ~0x20000000);
                const fex = ((fpscr >>> 25) & (fpscr >>> 3) & 0x1F) !== 0;
                fpscr = fex ? (fpscr | 0x40000000) : (fpscr & ~0x40000000);
                fpscr = (fpscr & ~0xF000) | (cc << 12);
                HEAP32[FPSCR] = fpscr | 0;
                // PPCToInternal(cc): 0x1_0000_0000 | SO<<59 | !EQ | !GT<<63 | LT<<62
                const lo = (cc & 2) ? 0 : 1;
                let hi = 1;
                if (cc & 1) hi |= (1 << 27);
                if (!(cc & 4)) hi |= (1 << 31);
                if (cc & 8) hi |= (1 << 30);
                HEAP32[(ctx + 0x2A0 + 8 * crf) >> 2] = lo;
                HEAP32[(ctx + 0x2A0 + 8 * crf + 4) >> 2] = hi | 0;
                advance(pc); return;
            }
            st.interp++;
            if (st.interp === 1) { st.interpPc = pc; st.interpInst = inst; }
            HEAP32[(ctx + 0x2F0) >> 2] = 0;
        };
        env.ppc_check_exc = function (pc) { st.checkExc++; return 0; };
        env.ppc_break_block = function (pc, x) { };
        env.ppc_hle_check = function (pc) { st.hle++; return 0; };
        env.ppc_hle_fire = function (pc, idx) { return 0; };
        env.ppc_msr_updated = function (msr) { };
        // GPFifo::UpdateGatherPipe stand-in: consume whole 32-byte chunks.
        // Every byte the guest pushed through the gather pipe is folded into
        // st.gpHash (FNV-1a) as it is drained, so a trace differential also
        // covers the GX command stream (MEM1/ctx hashes never see it).
        function gpFold() {
            const end = HEAP32[(ctx + 0x0C) >> 2] >>> 0;
            let h = st.gpHash | 0;
            for (let a = gpbuf >>> 0; a < end; a++) h = Math.imul(h ^ HEAPU8[a], 16777619);
            st.gpHash = h; st.gpBytes += end - (gpbuf >>> 0);
            HEAP32[(ctx + 0x0C) >> 2] = gpbuf;
        }
        Module.bemReplayGpHash = function () { gpFold(); return st.gpHash | 0; };
        env.ppc_gather_drain = function () {
            st.drains++;
            gpFold();
            HEAP32[gpdirty >> 2] = 0;
        };
      };

  Module.bemReplayInstrument = instrument;
})();
