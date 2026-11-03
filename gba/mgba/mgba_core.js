/* gba/mgba/mgba_core.js - JS API over the site's multi-core mGBA bridge (dist/mgba_core.wasm).
 *
 * Classic-script friendly (no import/export): in a page it attaches `window.MgbaCore`; in Node it is `require()`-able
 * and `import()`-able (module.exports). Load dist/mgba_core.js (the Emscripten glue, global `createMgbaCore`) first when
 * running in a page; in Node it is required for you.
 *
 *   const core = await MgbaCore.create({ seats: 2 });         // one wasm instance, N linked GBA cores
 *   core.loadRom(romBytes);                                   // the SAME ROM in every seat (one shared mapping)
 *   core.setSave(0, saveBytes);                               // optional, before the first frame
 *   core.setKeys(0, mask10bit); core.setKeys(1, mask10bit);
 *   core.runFrame();                                          // EVERY seat advances exactly one emulated frame
 *   ctx.putImageData(new ImageData(core.video(0), 240, 160), 0, 0);
 *
 * Full contract, units and caveats: gba/mgba/README.md. Nothing here runs faster than hardware: runFrame() is one frame of
 * guest time per call and the caller owns the clock (G6 paces it at 59.7275 Hz). Nothing here fast-forwards.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MgbaCore = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // ---- constants. The bridge header (bridge/bemental_gba.h) carries the same numbers; tools/gba_mgba_core_test.mjs diffs them.
  var ABI_VERSION = 1;
  var W = 240, H = 160;
  var FRAME_CYCLES = 280896;            // VIDEO_TOTAL_LENGTH: 228 lines x 1232 cycles
  var CPU_HZ = 16777216;
  var FPS = CPU_HZ / FRAME_CYCLES;      // 59.7275...
  var STATE_BYTES = 0x61000;
  var PSG_MASK = [0x130, 0x18C];        // [from, to) state bytes excluded by hashGame()
  var KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };
  var ST = { STALL: 1, RECOVERED: 2, STEP_CAP: 4, MULTI_NODATA: 8, NOT_LOADED: 0x80 };
  var INC = { 1: 'loop-stall', 2: 'recover', 3: 'step-cap', 4: 'multi-no-data' };
  var STAT = {
    VERSION: 0, SEATS: 1, CALLS: 2, TRANSFERS: 3, MULTI_NODATA: 4, RECOVERS: 5, LOOP_STALLS: 6, STEP_CAPS: 7, INCIDENTS: 8,
    TRANSFERS_WIN: 9, STALL_RUN: 10, ATTACHED: 11, WAITING: 12, TRANSFER_ACTIVE: 13, ASLEEP_MASK: 14,
    MULTI_OK: 15, SIO_IRQS: 16, SIO_LAST: 20, SIO_WIN: 24, FRAMES: 28, MULTI_OK_WIN: 32, MULTI_LAST: 33, AHEAD_STEPS: 37, SLEEPS: 38, WAKES: 39, YIELDS: 40, WORDS: 44
  };
  var SAVE_TYPES = { auto: -1, none: 0, sram: 1, flash512: 2, flash1m: 3, eeprom8k: 4, eeprom512: 5, sram512: 6 };
  var SAVE_TYPE_NAMES = { '-1': 'auto', 0: 'none', 1: 'sram', 2: 'flash512', 3: 'flash1m', 4: 'eeprom8k', 5: 'eeprom512', 6: 'sram512' };
  var SIOMULTI1 = 0x04000122, SIOCNT = 0x04000128, RCNT = 0x04000134;
  var LOAD_ERRORS = {
    '-1': 'ROM_SIZE', '-2': 'NOT_A_GBA_ROM', '-3': 'CORE_CREATE', '-4': 'CORE_INIT', '-5': 'ROM_LOAD', '-6': 'VIDEO_SIZE', '-7': 'NOT_INITIALISED'
  };

  function toU8(b) {
    if (b instanceof Uint8Array) return b;
    if (b && b.buffer instanceof ArrayBuffer) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    throw new TypeError('expected a Uint8Array or ArrayBuffer');
  }
  function cstr(bytes) { var s = ''; for (var i = 0; i < bytes.length && bytes[i]; i++) s += String.fromCharCode(bytes[i]); return s; }

  function Core(M, seats, opts) {
    this.M = M;
    this.seats = seats;
    this.abi = ABI_VERSION;
    this.loaded = false;
    this.info = null;
    this._scratch = M._malloc(512);
    this._views = {};
    this._logNext = 0;
    this._opts = opts || {};
    var rc = M._bgb_init(seats);
    if (rc !== 0) throw new Error('bgb_init(' + seats + ') failed: ' + rc);
    var probe = this._stats();
    if (probe[STAT.VERSION] !== ABI_VERSION) throw new Error('wasm ABI version ' + probe[STAT.VERSION] + ' != wrapper ' + ABI_VERSION + ' (dist and mgba_core.js are out of step)');
  }

  var P = Core.prototype;

  P._need = function () { if (!this.loaded) throw new Error('loadRom() first'); };
  P._seat = function (s) { if (!(s >= 0 && s < this.seats && (s | 0) === s)) throw new RangeError('seat ' + s + ' out of range 0..' + (this.seats - 1)); return s | 0; };
  P._stats = function () { this.M._bgb_stats(this._scratch); return new Uint32Array(this.M.HEAPU8.buffer, this._scratch, STAT.WORDS).slice(); };

  /** Load the SAME ROM into every seat. `saveType` forces the battery type (default 'auto' = mGBA's own detection). */
  P.loadRom = function (bytes, opts) {
    var M = this.M, rom = toU8(bytes), o = opts || {};
    var st = o.saveType === undefined ? 'auto' : o.saveType;
    var code = typeof st === 'number' ? st : SAVE_TYPES[st];
    if (code === undefined) throw new RangeError('unknown saveType ' + st + '; one of ' + Object.keys(SAVE_TYPES).join(', '));
    var p = M._bgb_rom_alloc(rom.length);
    if (!p) { var e0 = new Error('ROM size ' + rom.length + ' is outside 192 B .. 32 MiB'); e0.code = 'ROM_SIZE'; throw e0; }
    M.HEAPU8.set(rom, p);                         // the bridge ADOPTS this allocation; do not free it
    var rc = M._bgb_load_rom(p, rom.length, code);
    if (rc !== 0) { var e = new Error('loadRom failed: ' + (LOAD_ERRORS[rc] || rc)); e.code = LOAD_ERRORS[rc] || String(rc); e.rc = rc; throw e; }
    this.loaded = true;
    this._views = {};
    var inf = new Uint8Array(40), q = this._scratch;
    M._bgb_game_info(0, q);
    inf.set(new Uint8Array(M.HEAPU8.buffer, q, 40));
    this.info = {
      title: cstr(inf.subarray(0, 17)), system: cstr(inf.subarray(17, 21)), code: cstr(inf.subarray(21, 26)), maker: cstr(inf.subarray(26, 29)), version: inf[29],
      romSize: rom.length, crc32: M._bgb_rom_crc32(0) >>> 0, saveType: SAVE_TYPE_NAMES[M._bgb_savedata_type(0)] || String(M._bgb_savedata_type(0)),
      romPristine: M._bgb_rom_pristine(0) === 1, saveTag: ['none', 'sram', 'flash512', 'flash1m', 'eeprom'][M._bgb_rom_save_tag()] || 'none', seats: this.seats
    };
    return this.info;
  };

  /** Power-cycle every seat (same ROM, battery save kept). */
  P.reset = function () { this._need(); if (this.M._bgb_reset() !== 0) throw new Error('reset failed'); this._views = {}; };

  /** Restore a raw .sav into a seat. Call between loadRom() and the first runFrame(). Returns true when mGBA accepted it. */
  P.setSave = function (seat, bytes) {
    this._need(); seat = this._seat(seat);
    var b = toU8(bytes), M = this.M, p = M._bgb_save_alloc(b.length);
    if (!p) return false;
    M.HEAPU8.set(b, p);
    return M._bgb_save_import(seat) === 1;
  };
  /** The seat's battery save (a copy), or null when the cartridge has not touched / has no save memory. */
  P.exportSave = function (seat) {
    this._need(); seat = this._seat(seat);
    var M = this.M, n = M._bgb_save_export(seat);
    if (!n) return null;
    return new Uint8Array(M.HEAPU8.buffer, M._bgb_save_ptr(), n).slice();
  };

  /** Held buttons for the NEXT frame. Only the low 10 bits count (A B Select Start Right Left Up Down R L; 1 = pressed). */
  P.setKeys = function (seat, mask) { this._need(); this.M._bgb_set_keys(this._seat(seat), mask & 0x3FF); };

  /**
   * Advance EVERY seat by exactly one emulated frame (280,896 cycles of guest time each; 59.7275 Hz when called at that
   * rate). Never fast-forwards: one call is one frame, whatever the caller does with the clock. Returns a bitmask of
   * MgbaCore.ST.* (0 = clean). A non-zero value is an INCIDENT - read core.incidents() and surface it; do not ignore it.
   */
  P.runFrame = function () { return this.M._bgb_run_frame(); };

  /** The seat's last completed frame as a 240x160 RGBA Uint8ClampedArray VIEW into wasm memory (no copy). It is rewritten
   *  in place whenever the seat completes a frame, so draw it (putImageData) before the next runFrame(), or .slice() it. */
  P.video = function (seat) {
    this._need(); seat = this._seat(seat);
    var v = this._views['v' + seat];
    if (!v || v.buffer.byteLength === 0) {
      v = this._views['v' + seat] = new Uint8ClampedArray(this.M.HEAPU8.buffer, this.M._bgb_video(seat), W * H * 4);
    }
    return v;
  };
  /** Stereo interleaved int16 samples the seat produced during the last runFrame() (a view; ~548 frames at 32768 Hz). */
  P.audio = function (seat) {
    this._need(); seat = this._seat(seat);
    var M = this.M, n = M._bgb_audio_frames(seat);
    return { samples: new Int16Array(M.HEAPU8.buffer, M._bgb_audio(seat), n * 2), frames: n, rate: M._bgb_audio_rate(seat) };
  };

  /** Full core savestate of one seat: GBASerializedState, 0x61000 bytes (a copy). Link-coordinator state is NOT in it. */
  P.saveState = function (seat) {
    this._need(); seat = this._seat(seat);
    var M = this.M;
    if (!M._bgb_state_save(seat)) throw new Error('saveState failed');
    return new Uint8Array(M.HEAPU8.buffer, M._bgb_state_buf(), STATE_BYTES).slice();
  };
  /** Restore one seat. On a linked instance restore EVERY seat, then call linkReset() once (or use loadStates()). */
  P.loadState = function (seat, bytes, opts) {
    this._need(); seat = this._seat(seat);
    var b = toU8(bytes), M = this.M;
    if (b.length !== STATE_BYTES) throw new RangeError('savestate must be ' + STATE_BYTES + ' bytes, got ' + b.length);
    M.HEAPU8.set(b, M._bgb_state_buf());
    var ok = M._bgb_state_load(seat) === 1;
    if (ok && this.seats > 1 && !(opts && opts.noLinkReset)) M._bgb_link_reset();
    return ok;
  };
  /** Restore all seats from an array of states, then reset the link layer once. */
  P.loadStates = function (arr) {
    if (arr.length !== this.seats) throw new RangeError('need ' + this.seats + ' states');
    var ok = true;
    for (var i = 0; i < arr.length; i++) ok = this.loadState(i, arr[i], { noLinkReset: true }) && ok;
    this.linkReset();
    return ok;
  };
  P.linkReset = function () { this._need(); this.M._bgb_link_reset(); };

  /** FNV-1a 32 over the seat's FULL 0x61000-byte core savestate (CPU, video RAM/OAM/palette, IO, EWRAM, IWRAM, audio, timers,
   *  DMA, cartridge GPIO/RTC, event queue, frame counter). NOT over the ROM, the battery save or the link layer. */
  P.hash = function (seat) { this._need(); return this.M._bgb_hash(this._seat(seat)) >>> 0; };
  /** hash() with the PSG sequencer block (state bytes 0x130-0x18B) zeroed: mGBA's savestate does not round-trip those audio-channel
   *  fields bit-exactly. ⚠ IT DOES NOT MAKE A RESTORED INSTANCE COMPARABLE WITH ONE THAT KEPT RUNNING: other bytes differ too (0x2c4-0x2c8,
   *  plus 0x534-0x535 on SoulGold) and the audio output diverges (G2 side finding). Measured with the RTC pinned and identical keys after the
   *  restore: GR1, 2 linked seats, 600 frames, 30 samples - Sonic Advance 3 hashGame differed 30/30, Kirby 14/30 (hash() 30/30 on both, video
   *  identical); V3 (the G2/G3 verifier) - SoulGold and Sonic Advance 3 30/30, Kirby and Super Bust-A-Move 0/30. So: compare hash() between
   *  machines that ran the same sequence FROM FRAME 0 (a room, a replay); never use hash() or hashGame() to prove a restored instance equals a
   *  continuing one. Rooms therefore have no checkpoints (gba/mgba/README.md "Rooms"). */
  P.hashGame = function (seat) { this._need(); return this.M._bgb_hash_game(this._seat(seat)) >>> 0; };
  /** FNV-1a 32 over the link coordinator + per-player queues (0 for a solo instance). */
  P.hashLink = function () { this._need(); return this.M._bgb_hash_link() >>> 0; };
  /** One number for the whole instance: FNV-1a 32 over every seat hash and the link hash. */
  P.hashAll = function () {
    var h = 0x811C9DC5, parts = [];
    for (var i = 0; i < this.seats; i++) parts.push(this.hash(i));
    parts.push(this.hashLink());
    for (var k = 0; k < parts.length; k++) for (var j = 0; j < 4; j++) { h ^= (parts[k] >>> (8 * j)) & 0xFF; h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  };

  /**
   * Pin the cartridge clock (the G2 determinism pin; a room's config carries the pair). fixedEpochMs: unix time in ms the guest sees at its first frame; it then advances
   * only with emulated frames, never with the host clock. tzOffsetMin: minutes EAST of UTC that the guest's calendar uses
   * (-300 = UTC-5; default 0); the host's own time zone is never consulted. setRtc(null) hands the clock back to the host.
   *
   * ORDER DOES NOT MATTER: create -> setRtc -> loadRom and create -> loadRom -> setRtc give the guest the same clock. The bridge
   * REMEMBERS the pin and applies it to every core as that core is created (mGBA's core init resets a core's clock to the host
   * clock, so a pin written into a core before loadRom() would be wiped silently - that was a real defect, now closed; do not
   * "fix" it by writing the pin into a core directly). The pin is sticky across loadRom(), reset() and a second loadRom() until
   * setRtc() is called again. Savestates do not carry the clock source, so loadState() cannot change it. Throws on a missing,
   * non-finite or out-of-range fixedEpochMs (|ms| <= 9e15) and on a tzOffsetMin outside +-1440.
   *
   * WHAT THE PIN COVERS (measured by tools/gba_room_determinism_probe.mjs): a pinned core hands the guest the same clock and the same
   * wall-clock calendar whatever the host's time zone, DST position or Date.now() - the calendar is gmtime(epoch + offset), never localtime,
   * and the wasm's __localtime_js / __mktime_js / Date.now imports are never reached. The zone is a FIXED offset: no DST rules, so every
   * peer of a room must be handed the same {fixedEpochMs, tzOffsetMin}. Solo play may leave the clock unpinned (host clock, host zone).
   */
  P.setRtc = function (cfg) {
    if (!this.M || !this.M._bgb_set_rtc) throw new Error('no RTC hook in this build (or the core is closed)');
    var rc;
    if (cfg) {
      var ms = cfg.fixedEpochMs, tz = cfg.tzOffsetMin === undefined ? 0 : cfg.tzOffsetMin;
      if (typeof ms !== 'number' || !isFinite(ms) || Math.abs(ms) > 9e15) throw new RangeError('setRtc: fixedEpochMs must be a finite number of milliseconds (|ms| <= 9e15), got ' + ms);
      if (typeof tz !== 'number' || !isFinite(tz) || Math.abs(tz) > 1440) throw new RangeError('setRtc: tzOffsetMin must be a finite number of minutes east of UTC (|min| <= 1440), got ' + tz);
      rc = this.M._bgb_set_rtc(1, ms, tz | 0);
    } else {
      rc = this.M._bgb_set_rtc(0, 0, 0);
    }
    if (rc === -2) throw new RangeError('setRtc: the bridge refused fixedEpochMs ' + (cfg && cfg.fixedEpochMs));
    if (rc !== 0) throw new Error('setRtc failed: the core was not initialised (rc ' + rc + ')');
  };

  /** Bus-neutral 16/32-bit reads of a seat's address space (IO registers, RAM, ROM). For witnesses. */
  P.read16 = function (seat, addr) { this._need(); return this.M._bgb_read16(this._seat(seat), addr >>> 0); };
  P.read32 = function (seat, addr) { this._need(); return this.M._bgb_read32(this._seat(seat), addr >>> 0) >>> 0; };

  /** Emulated cycles seat `s` has run since reset (exact integer in a double). */
  P.cycles = function (seat) { this._need(); return this.M._bgb_cycles(this._seat(seat)); };
  /** Frames seat `s` has completed since reset (the core's own video frame counter). */
  P.frames = function (seat) { this._need(); return this.M._bgb_frame_counter(this._seat(seat)) >>> 0; };

  /**
   * Link witnesses. `linked` is the structural signature of a working cable (every seat attached to the coordinator, transfers
   * in the last 60 frames, and the master's SIOMULTI1 is not the FFFF "no slave answered" pattern). It says nothing about
   * whether the GAME is in a link screen; combine it with a screenshot. `clean` is "zero incidents so far".
   */
  P.witnesses = function () {
    this._need();
    var s = this._stats(), n = this.seats, i, irq = [], per = [], last = [], fr = [];
    var window = Math.max(1, Math.min(60, s[STAT.CALLS]));
    for (i = 0; i < n; i++) {
      irq.push(s[STAT.SIO_IRQS + i]); last.push(s[STAT.SIO_LAST + i]); per.push(s[STAT.SIO_WIN + i] / window); fr.push(s[STAT.FRAMES + i]);
    }
    var multi1 = n >= 2 ? s[STAT.MULTI_LAST + 1] : null;           // word the master was handed from seat 1 at the end of its last COMPLETED round
    var linked = n >= 2 && s[STAT.ATTACHED] === n && s[STAT.TRANSFERS_WIN] > 0 && s[STAT.MULTI_OK_WIN] > 0 && multi1 !== 0xFFFF;
    return {
      seats: n, calls: s[STAT.CALLS], frames: fr,
      linked: linked, clean: s[STAT.INCIDENTS] === 0,
      transfers: s[STAT.TRANSFERS], transfersLast60: s[STAT.TRANSFERS_WIN],
      serialIrqs: irq, serialIrqsLastFrame: last, serialIrqsPerFrame: per,
      stalls: s[STAT.LOOP_STALLS] + s[STAT.MULTI_NODATA],
      stallDetail: { loopStalls: s[STAT.LOOP_STALLS], multiNoData: s[STAT.MULTI_NODATA], stepCaps: s[STAT.STEP_CAPS] },
      recoverCount: s[STAT.RECOVERS], incidents: s[STAT.INCIDENTS],
      aheadSteps: s[STAT.AHEAD_STEPS], linkSleeps: s[STAT.SLEEPS], linkWakes: s[STAT.WAKES], yields: s[STAT.YIELDS],
      attached: s[STAT.ATTACHED], waitingMask: s[STAT.WAITING], transferActive: s[STAT.TRANSFER_ACTIVE] === 1, asleepMask: s[STAT.ASLEEP_MASK],
      multiRounds: s[STAT.MULTI_OK], multiRoundsLast60: s[STAT.MULTI_OK_WIN],
      masterSioMulti1: multi1, masterSioMulti1Live: n >= 2 ? this.read16(0, SIOMULTI1) : null,
      masterWords: n >= 2 ? [s[STAT.MULTI_LAST], s[STAT.MULTI_LAST + 1], s[STAT.MULTI_LAST + 2], s[STAT.MULTI_LAST + 3]] : null,
      masterSioCnt: n >= 2 ? this.read16(0, SIOCNT) : null, masterRcnt: n >= 2 ? this.read16(0, RCNT) : null
    };
  };
  /** Every retained incident, oldest first: { n, call, kind, asleepMask, doneMask, waiting, transferActive, multiNoData, recovers }. */
  P.incidents = function () {
    var M = this.M, total = M._bgb_incident_total(), out = [];
    for (var i = Math.max(0, total - 64); i < total; i++) {
      if (!M._bgb_incident_read(i, this._scratch)) continue;
      var w = new Uint32Array(M.HEAPU8.buffer, this._scratch, 8);
      out.push({ n: i, call: w[0], kind: INC[w[1]] || String(w[1]), asleepMask: w[2], doneMask: w[3], waiting: w[4], transferActive: w[5] === 1, multiNoData: w[6], recovers: w[7] });
    }
    return out;
  };
  /** DEBUG ONLY: pretend the seats in `mask` are asleep waiting on the link, to exercise the stall/incident path. 0 clears. */
  P.debugForceAsleep = function (mask) { this.M._bgb_debug_force_asleep(mask >>> 0); };
  /** Unix seconds the seat's cartridge clock reports right now (pinned: epoch + emulated time; unpinned: the host clock). */
  P.rtcUnix = function (seat) { this._need(); return this.M._bgb_rtc_unix(this._seat(seat)); };
  /**
   * What the GAME did with the cartridge clock (determinism evidence, G2). `latches` counts how many times the guest latched the
   * date/time (the RTC_DATETIME / RTC_TIME commands over the GPIO port at ROM 0x080000C4-C8) since the last loadRom()/reset(); `firstUnix` /
   * `lastUnix` are the first and last unix seconds the guest was handed; `digest` is an FNV-1a 32 over every value handed out (equal digests
   * = the guest saw the same sequence of clock values); `calendar` is the BCD date the game last latched, decoded (year is 2000 + yy). It reads
   * the cartridge's own state and does not count as the guest asking. A cartridge without an RTC reports `present: false, latches: 0`.
   * `pinned` / `utcOffsetSec` echo the pin in force (`utcOffsetSec` is null while the host zone is in force: not deterministic across peers).
   */
  P.rtcWitness = function (seat) {
    this._need(); seat = this._seat(seat);
    var M = this.M;
    if (!M._bgb_rtc_witness) throw new Error('no RTC witness in this build (dist is older than mgba_core.js)');
    var q = this._scratch;
    if (!M._bgb_rtc_witness(seat, q)) throw new Error('rtcWitness: seat ' + seat + ' has no core');
    var w = new Uint32Array(M.HEAPU8.buffer, q, 16).slice();
    var i64 = function (lo, hi) { return (hi | 0) * 4294967296 + lo; };
    var bcd = function (b) { return (b >> 4) * 10 + (b & 15); };
    var cal = [w[6] & 255, (w[6] >>> 8) & 255, (w[6] >>> 16) & 255, w[6] >>> 24, w[7] & 255, (w[7] >>> 8) & 255, (w[7] >>> 16) & 255];
    return {
      present: (w[9] & 1) === 1, latches: w[0], firstUnix: w[0] ? i64(w[1], w[2]) : null, lastUnix: w[0] ? i64(w[3], w[4]) : null, digest: w[5] >>> 0,
      calendarBcd: cal,
      calendar: { year: 2000 + bcd(cal[0]), month: bcd(cal[1]), day: bcd(cal[2]), weekday: cal[3], hour: bcd(cal[4]), minute: bcd(cal[5]), second: bcd(cal[6]) },
      control: w[7] >>> 24, lastCommand: w[8] & 255, devices: w[9], pinned: w[10] === 1, utcOffsetSec: w[11] === 0x7FFFFFFF ? null : (w[11] | 0)
    };
  };
  /** Frames of consecutive stall before the watchdog wakes the seats (default 60). 0 = never heal; a stall then stays a stall. */
  P.setRecoverAfter = function (n) { this.M._bgb_set_recover_after(n | 0); };
  /** mGBA log lines (WARN and above) since the last call. */
  P.drainLog = function () {
    var M = this.M, total = M._bgb_log_total(), out = [], from = Math.max(this._logNext, total - 512);
    for (var i = from; i < total; i++) { var p = M._bgb_log_line(i); if (p) { var b = M.HEAPU8, e = p; while (b[e]) e++; out.push(String.fromCharCode.apply(null, b.subarray(p, e))); } }
    this._logNext = total;
    return out;
  };
  P.setDebugLog = function (on) { this.M._bgb_log_set_debug(on ? 1 : 0); };

  /** { heapBytes, highWater }: the wasm heap (fixed) and the allocator's high-water mark (sbrk). */
  P.memory = function () { return { heapBytes: this.M.HEAPU8.length, highWater: this.M._sbrk(0) }; };

  P.close = function () { if (this.M) { this.M._bgb_quit(); this.M._free(this._scratch); this.M = null; this.loaded = false; } };

  function resolveFactory(opts) {
    if (opts && opts.factory) return opts.factory;
    if (typeof root.createMgbaCore === 'function') return root.createMgbaCore;
    if (typeof require === 'function') { try { return require('./dist/mgba_core.js'); } catch (e) { /* fall through */ } }
    throw new Error('createMgbaCore not found: load gba/mgba/dist/mgba_core.js before this script');
  }

  /** Instantiate the wasm and create `seats` (1..4) GBA cores in it. Resolves to a Core. */
  function create(opts) {
    var o = opts || {}, seats = o.seats === undefined ? 1 : o.seats;
    if (!(seats >= 1 && seats <= 4 && (seats | 0) === seats)) return Promise.reject(new RangeError('seats must be 1..4'));
    return new Promise(function (resolve, reject) {
      var args = {};
      if (o.locateFile) args.locateFile = o.locateFile;
      if (o.wasmBinary) {
        args.wasmBinary = o.wasmBinary;
        // THE BYTES THAT WERE CHECKED ARE THE BYTES THAT RUN (stage GR2 fix M2). The shipped glue never reads `wasmBinary` (it only fetches
        // the file named by locateFile, a SECOND request), so a caller that md5s the bytes it fetched - gba.html does, to bind a room's
        // "core build" - was checking bytes that were not the ones instantiated. Emscripten's own hook `instantiateWasm(imports, success)`
        // closes that: when wasmBinary is given, THESE bytes are compiled, and no second request is made.
        args.instantiateWasm = function (imports, success) {
          WebAssembly.instantiate(o.wasmBinary, imports).then(function (r) { success(r.instance, r.module); }).catch(reject);
          return {};
        };
      }
      args.print = o.print || function () {};
      args.printErr = o.printErr || function () {};
      // a throw inside `new Core` (an allocation that fails, a module without its exports) must REJECT create(), as it did before this
      // hunk (the old form returned the chained promise); settling `resolve` from inside a two-argument then() left it pending forever
      // and turned the throw into an unhandled rejection.
      Promise.resolve(resolveFactory(o)(args)).then(function (M) { return new Core(M, seats, o); }).then(resolve, reject);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Page-side adapters (G3). Pure JS, no wasm: `require()`-able in Node so tools/gba_mgba_solo_test.mjs can pin them.
  // ---------------------------------------------------------------------------------------------------------------------

  /**
   * BATTERY SAVES: the 44vba buffer <-> mGBA's raw `.sav` formats.
   *
   * The vendored 44vba core (gba/gbaWasm/dist/44gba.*) kept a game's battery in ONE 0x22000-byte buffer, which the old page stored
   * in IndexedDB GBAWASMDB under '<rom>.sav'. Its layout (44670/44vba src/memory.cpp: `flashSaveMemory = libretro_save_buf` and
   * `eepromData = libretro_save_buf + 0x20000`, then CONFIRMED against real runs, see tools/gba_mgba_solo_test.mjs 'layout oracle'):
   *
   *     0x00000 .. 0x20000   SRAM (first 0x8000) or Flash (first 0x10000 = 512 Kbit, all 0x20000 = 1 Mbit, bank 1 in the upper half)
   *     0x20000 .. 0x22000   EEPROM (first 0x200 = 4 Kbit part, all 0x2000 = 64 Kbit part)
   *     every byte starts at 0xFF
   *
   * mGBA's raw `.sav` is just the chip image: sram 0x8000, flash512 0x10000, flash1m 0x20000, eeprom 0x200 or 0x2000 - the same
   * bytes any other emulator or a flash cart writes, which is what pokemonarena's save importer expects.
   * 'kind' is one of 'sram' | 'flash512' | 'flash1m' | 'eeprom' - exactly core.info.saveTag (the ROM's own save-library tag).
   */
  var LEGACY_LEN = 0x22000, LEGACY_EEPROM_AT = 0x20000;
  var RAW_SIZE = { sram: 0x8000, flash512: 0x10000, flash1m: 0x20000 };
  var RAW_SIZES = [0x200, 0x2000, 0x8000, 0x10000, 0x20000];   // the only raw lengths the bridge's setSave() accepts for any tag

  function allFF(b, from, to) { for (var i = from; i < to; i++) if (b[i] !== 0xFF) return false; return true; }
  var battery = {
    LEGACY_LEN: LEGACY_LEN, LEGACY_EEPROM_AT: LEGACY_EEPROM_AT, RAW_SIZES: RAW_SIZES,
    /** true for a buffer shaped like the old core's (exactly 0x22000 bytes; no mGBA raw save has that length). */
    isLegacy: function (b) { return !!b && b.byteLength === LEGACY_LEN; },
    /** true when every byte is 0xFF (a chip nobody ever wrote: not a save). */
    isBlank: function (b) { b = toU8(b); return allFF(b, 0, b.length); },
    /** raw mGBA battery lengths that can ever be valid. */
    isRawSize: function (n) { return RAW_SIZES.indexOf(n) >= 0; },
    /**
     * Which chip a legacy buffer holds when the ROM carries no save-library tag: judged from where the bytes are. Only a fallback:
     * with a tag the ROM says what it is. 'eeprom' wins over the flash area because the two never coexist on one cartridge.
     */
    guessKind: function (legacy) {
      var b = toU8(legacy);
      if (!allFF(b, LEGACY_EEPROM_AT, LEGACY_LEN)) return 'eeprom';
      if (!allFF(b, 0x10000, 0x20000)) return 'flash1m';
      if (!allFF(b, 0x8000, 0x10000)) return 'flash512';
      return 'sram';
    },
    /**
     * Legacy 0x22000 buffer -> { kind, bytes } (mGBA raw), or null when it is not legacy-shaped or holds nothing (all 0xFF).
     * EEPROM size: the old buffer does not record 512 B vs 8 KiB, so it is 512 B unless something sits above 0x200 in the EEPROM area.
     */
    fromLegacy: function (legacy, kind) {
      var b = toU8(legacy);
      if (b.length !== LEGACY_LEN || allFF(b, 0, b.length)) return null;
      var k = kind && kind !== 'none' ? kind : battery.guessKind(b);
      if (k === 'eeprom') {
        var n = allFF(b, LEGACY_EEPROM_AT + 0x200, LEGACY_LEN) ? 0x200 : 0x2000;
        return { kind: k, bytes: b.slice(LEGACY_EEPROM_AT, LEGACY_EEPROM_AT + n) };
      }
      if (!RAW_SIZE[k]) return null;
      return { kind: k, bytes: b.slice(0, RAW_SIZE[k]) };
    },
    /** mGBA raw save -> the old core's 0x22000 buffer (0xFF elsewhere), or null for a length no chip has. Lets a visitor go back. */
    toLegacy: function (raw, kind) {
      var b = toU8(raw), out = new Uint8Array(LEGACY_LEN).fill(0xFF);
      var isEeprom = kind === 'eeprom' || (!kind && (b.length === 0x200 || b.length === 0x2000));
      if (isEeprom) {
        if (b.length !== 0x200 && b.length !== 0x2000) return null;
        out.set(b, LEGACY_EEPROM_AT);
        return out;
      }
      if (b.length !== 0x8000 && b.length !== 0x10000 && b.length !== 0x20000) return null;
      out.set(b, 0);
      return out;
    }
  };

  /**
   * AUDIO: the rate the guest produces is whatever the GAME programmed (SOUNDBIAS), not a constant - measured on the shipped ROMs:
   * 65536 Hz for six of seven (Kirby, Pokemon, Sonic Advance 3, ...), 32768 Hz for Sim City 2000, and a game may switch scenes.
   * lib/cart_audio.js resamples by ONE fixed ratio chosen when the sink is created, so the page converts every batch to a fixed
   * `outRate` here, in exact integer arithmetic: the long-run output count per guest second is outRate to the sample, no drift.
   * Down-conversion is an area average (a box low-pass: no aliasing from the 24-32 kHz band); up-conversion is linear.
   * It never reads a clock and never asks for frames: the emulator's pace is untouched (CLAUDE.md gate 9).
   */
  function AudioPipe(outRate) {
    if (!(outRate > 0 && (outRate | 0) === outRate)) throw new RangeError('outRate must be a positive integer');
    this.outRate = outRate; this.reset();
    this.buf = new Float32Array(4096 * 2);
  }
  AudioPipe.prototype.reset = function () {
    this.inRate = 0; this.cover = 0; this.accL = 0; this.accR = 0; this.ph = 0; this.x0l = 0; this.x0r = 0; this.have = false;
    this.totalIn = 0; this.totalOut = 0;
  };
  /**
   * Convert `frames` stereo-interleaved int16 frames produced at `inRate` Hz. Returns { samples: Float32Array (interleaved, a REUSED
   * scratch - copy it before the next call), frames }. A change of inRate restarts the filter (one batch, at a scene change).
   */
  AudioPipe.prototype.process = function (i16, frames, inRate) {
    inRate = inRate | 0;
    if (!(inRate > 0)) return { samples: this.buf, frames: 0 };
    var out = this.outRate;
    if (inRate !== this.inRate) { var keepIn = this.totalIn, keepOut = this.totalOut; this.reset(); this.totalIn = keepIn; this.totalOut = keepOut; this.inRate = inRate; }
    var need = Math.ceil(frames * out / inRate) + 4;
    if (this.buf.length < need * 2) this.buf = new Float32Array(need * 2);
    var o = this.buf, n = 0, i, l, r;
    if (inRate >= out) {
      // box filter. Unit = 1/(inRate*outRate) s: an input sample is `out` units long, an output window is `inRate` units long.
      var cover = this.cover, aL = this.accL, aR = this.accR, win = inRate, div = win * 32768;
      for (i = 0; i < frames; i++) {
        l = i16[2 * i]; r = i16[2 * i + 1];
        var rem = out;
        while (rem > 0) {
          var room = win - cover, take = room < rem ? room : rem;
          aL += l * take; aR += r * take; cover += take; rem -= take;
          if (cover === win) { o[2 * n] = aL / div; o[2 * n + 1] = aR / div; n++; aL = 0; aR = 0; cover = 0; }
        }
      }
      this.cover = cover; this.accL = aL; this.accR = aR;
    } else {
      // linear interpolation: `ph` is the next output's position after the previous input sample, in 1/outRate input-sample units.
      var ph = this.ph, x0l = this.x0l, x0r = this.x0r, have = this.have;
      for (i = 0; i < frames; i++) {
        l = i16[2 * i]; r = i16[2 * i + 1];
        if (have) {
          while (ph < out) { o[2 * n] = (x0l + (l - x0l) * ph / out) / 32768; o[2 * n + 1] = (x0r + (r - x0r) * ph / out) / 32768; n++; ph += inRate; }
          ph -= out;
        }
        x0l = l; x0r = r; have = true;
      }
      this.ph = ph; this.x0l = x0l; this.x0r = x0r; this.have = have;
    }
    this.totalIn += frames; this.totalOut += n;
    return { samples: o, frames: n };
  };

  return { create: create, KEY: KEY, ST: ST, STAT: STAT, SAVE_TYPES: SAVE_TYPES, ABI_VERSION: ABI_VERSION, W: W, H: H, FRAME_CYCLES: FRAME_CYCLES, CPU_HZ: CPU_HZ, FPS: FPS, STATE_BYTES: STATE_BYTES, PSG_MASK: PSG_MASK, Core: Core, battery: battery, AudioPipe: AudioPipe };
});
