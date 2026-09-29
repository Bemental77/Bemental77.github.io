// sr_guest.js — THE SAB IMAGE AS A PACED GUEST: boot it on its own pthread and stream its frames.
//
// [2026-09-29] Shared by sr_render_worker.js (browser, ?srimage=1&srrender=1&srmode=main with
// a guest-capable image under ?srbase=) and gamecube/recomp/sr/run_image_stream.mjs (node), so
// the path the page runs is the path the node harness measures.
//
// WHAT IS DIFFERENT FROM THE OLD RENDER ARM.  sr_render_worker.js's 'gx' mode CALLS SAB's GX
// entry points from the host; nothing here does.  The guest boots from __start with every
// device model on (README §10.6-10.6d: DI reading the disc, PE answering DrawDone, the
// overlay linked in), runs its own frame loop, and the ONLY things this file does are
// (1) stage what the apploader would have staged, (2) start the guest, (3) read whole frames
// out of the shared wasm memory (sr_gx.c's frame ring, capture arm 2) and hand them on in the
// {cmd:'frame', n, fifo, mem1, regions} shape the recomp consumer already takes.
//
// GATE #9.  The guest's clock is its retired work (gk_retire); nothing here paces it.  The
// posting rate is the HOST's (a timer) and says nothing about the guest.  Every report
// carries the guest-time frame counters (XFB copies, PE finishes, guest kcycles) separately
// from `posted`, and a post that carries several guest frames says how many.

// The apploader's writes, transcribed from the disc's own apploader — identical to
// run_image_node.mjs's SRN_APPLOADER block, which cites the PCs.  `disc` is the ISO bytes.
export function stageApploader(mod, api, disc) {
  const be = (o) => ((disc[o] << 24) | (disc[o + 1] << 16) | (disc[o + 2] << 8) | disc[o + 3]) >>> 0;
  const fstOff = be(0x424), fstSize = be(0x428), fstMax = be(0x42C);
  const physSize = 0x01800000;
  const e8 = be(0x440);
  let f0 = be(0x444);
  const ec = ((0x80000000 + physSize - e8) & ~31) >>> 0;
  if (f0 === 0) f0 = physSize;
  if (f0 !== physSize) throw new Error('apploader: simulated memsize != physical — branch not transcribed');
  const fstAddr = ((ec - fstMax) & ~31) >>> 0, bi2Addr = (fstAddr - 0x2000) >>> 0;
  const len = (fstSize + 31) & ~31;
  const ram = api.ram();
  mod.HEAPU8.set(disc.subarray(fstOff, fstOff + len), ram + (fstAddr & 0x01FFFFFF));
  mod.HEAPU8.set(disc.subarray(0x440, 0x440 + 0x2000), ram + (bi2Addr & 0x01FFFFFF));
  api.setGlobal(0x800000E8, e8); api.setGlobal(0x800000EC, ec); api.setGlobal(0x800000F0, f0);
  api.setGlobal(0x800000F4, bi2Addr);
  api.setGlobal(0x80000020, 0x0D15EA5E); api.setGlobal(0x80000024, 1);
  api.setGlobal(0x80000030, 0); api.setGlobal(0x80000034, fstAddr);
  api.setGlobal(0x80000038, fstAddr); api.setGlobal(0x8000003C, fstMax >>> 0);
  return { fstAddr: '0x' + fstAddr.toString(16), bi2Addr: '0x' + bi2Addr.toString(16), fstLen: len };
}

// Guest-time counters, read from the image while it runs (plain loads of C globals).
export function guestCounters(mod) {
  const k = (i) => mod._sr_image_frame_kcyc(i) >>> 0;
  const kc = mod._sr_image_kcycles() >>> 0;
  const xfb = mod._sr_image_xfb_copies() >>> 0, fin = mod._sr_image_pe_finishes() >>> 0;
  const rate = (n, a, b) => (n > 1 && b > a) ? +((n - 1) / ((b - a) * 1000 / 486e6)).toFixed(3) : null;
  return {
    guestKcycles: kc, guestSeconds: +(kc * 1000 / 486e6).toFixed(3),
    xfbCopies: xfb, peFinishes: fin, drawDonePerGuestSecond: rate(fin, k(2), k(3)),
    viTfblChanges: mod._sr_image_vi_flips() >>> 0,
    gpCmds: mod._sr_gp_cmds() >>> 0, gpPrims: mod._sr_gp_prims() >>> 0, gpUnknown: mod._sr_gp_unknown() >>> 0,
    diCmds: mod._sr_image_di_cmds() >>> 0, ovEntries: mod._sr_image_ov_entries() >>> 0,
    fault: '0x' + (mod._sr_image_fault() >>> 0).toString(16),
    bootThread: mod._sr_image_boot_thread_state() >>> 0,
  };
}

// Put the ISO into wasm memory (the DI model's memory backend).  `parts` is an async iterator
// of Uint8Array pieces in disc order; the total must be the disc size.
export async function loadDisc(mod, size, parts) {
  const p = mod._malloc(size);
  if (!p) throw new Error('malloc(' + size + ') for the disc failed — build with SR_MEM large enough');
  let o = 0;
  for await (const piece of parts) {
    if (o + piece.length > size) throw new Error('disc pieces exceed the declared size');
    mod.HEAPU8.set(piece, p + o); o += piece.length;
  }
  if (o !== size) throw new Error('disc: got ' + o + ' of ' + size + ' bytes');
  if (!mod._sr_image_set_disc_mem(p, size)) throw new Error('sr_image_set_disc_mem refused');
  return { ptr: p, size };
}

// Start the guest.  Everything the node runner sets, in the same order.
export async function startGuest(mod, api, opts = {}) {
  const { hle = 12, strict = 0, parkMs = 3600000 } = opts;
  api.setExiModel(1);
  mod._sr_image_set_dsp_model(1);
  for (let id = 1; id <= 11; id++) mod._sr_image_set_model(id, 1);
  api.setWatchdog(0);                              // device-read watchdog off: the guest runs until stopped
  mod._sr_image_set_budget_mcycles(0);             // no guest-time budget either
  mod._sr_os_set_timeout(parkMs);
  api.setStrict(strict);
  mod._sr_gx_set_capture(2);                       // the frame ring
  // idleLoop: the busy-wait skip (sr.py --idle-skip builds), default on; 0 = the control arm
  if (opts.idleLoop !== undefined && mod._sr_image_set_idle_loop) mod._sr_image_set_idle_loop(opts.idleLoop ? 1 : 0);
  // snapMem: the verification-only MEM1 hash per context switch (sr_host_os.c) — the matched-pair
  // control arm; sr_image_init_hle (run on the boot thread) turns it off, so arm it after.
  const rc = mod._sr_image_boot_thread(hle);
  if (opts.snapMem) {
    const t = Date.now();   // async wait: the thread's start needs this event loop to turn
    while (!(mod._sr_image_boot_thread_state() >>> 0)) {
      if (Date.now() - t > 10000) throw new Error('boot thread did not start');
      await new Promise((r) => setTimeout(r, 1));
    }
    mod._sr_os_set_snap_mem(1);
  }
  if (rc !== 0) throw new Error('sr_image_boot_thread: pthread_create returned ' + rc);
}

// The frame pump.  Call it on a host timer; it posts ONE message carrying every whole guest
// frame published since the last call (so no GP command is ever skipped: the consumer keeps
// CP/XF/BP state across calls), plus a MEM1 snapshot taken now.  Returns null when there was
// nothing new.
export function makePump(mod, api) {
  const base = mod._sr_gx_ring_base() >>> 0, cap = mod._sr_gx_ring_cap() >>> 0;
  let r = 0, framesSeen = 0, posts = 0, lost = 0;
  return function pump() {
    const pub = mod._sr_gx_ring_pub() >>> 0, frames = mod._sr_gx_ring_frames() >>> 0;
    if (pub === r) return null;
    const n = (pub - r) >>> 0;
    if (n > cap) {                                 // overwritten before it was read: say so, never render it
      lost += n; r = pub; framesSeen = frames;
      return { lost, framesInPost: 0, fifo: null };
    }
    const fifo = new Uint8Array(n);
    const H = mod.HEAPU8, a = r % cap;
    if (a + n <= cap) fifo.set(H.subarray(base + a, base + a + n));
    else { fifo.set(H.subarray(base + a, base + cap)); fifo.set(H.subarray(base, base + (n - (cap - a))), cap - a); }
    const ram = api.ram();
    const mem1 = H.slice(ram, ram + 0x01800000);   // live RAM at post time (see README §10.6e)
    const framesInPost = frames - framesSeen;
    r = pub; framesSeen = frames; posts++;
    return { n: posts, fifo, mem1, framesInPost, guestFrames: frames, lost };
  };
}
