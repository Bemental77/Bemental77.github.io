// ─── GBA Emulator — mGBA (WebAssembly) ───────────────────────────────────────
// Solo play on this page runs on mGBA (MPL-2.0) compiled to WebAssembly, through gba/mgba/mgba_core.js
// (window.MgbaCore) and gba/mgba/dist/mgba_core.{js,wasm}. It is SINGLE-THREADED: no SharedArrayBuffer, no Worker, no
// pthreads, so this page needs no cross-origin isolation. The previous core, 44vba (gba/gbaWasm/dist/44gba.*), is still
// in the repo but nothing on this page loads it — see "THE OLD CORE" below.
//
// The one core call the loop makes per emulated frame:
//   core.setKeys(0, mask10bit)   held buttons for the NEXT frame (A B Select Start Right Left Up Down R L)
//   core.runFrame()              advances the guest by EXACTLY one frame (280,896 cycles) and never more
//   core.video(0)                240x160 RGBA view into wasm memory (drawn with putImageData)
//   core.audio(0)                { samples: Int16 stereo, frames, rate } — the rate is whatever the GAME programmed
// Saves: core.exportSave(0) / core.setSave(0, raw)  (battery, raw .sav bytes)
//        core.saveState(0) / core.loadState(0, b)    (0x61000-byte mGBA state)
//
// ─── THE PAGE (stage GP, 2026-11-01) ─────────────────────────────────────────
// gba.html now follows the page standard the other five emulators share (ps1, n64, dreamcast, genesis, snes): a #controlBar with
// the standard ids, a #canvasWrap stage, a #statusBar, a mobile splash in front of the touch shell. This file used to drive a
// Bootstrap page through jQuery, rivets bindings and toastr; ALL FOUR ARE GONE. What replaced them is plain DOM:
//   * the toast is #toast (the genesis/snes/n64 element), through notify.info/.error/.warning below;
//   * a control's enabled state is computed in ONE place, MyClass._syncUi(), from the state bag below;
//   * the remap dialog is the n64 page's #remapPanel, built here without a template engine.
// `this.rivetsData` KEEPS ITS NAME although rivets is gone: tools/legacy_emu_page_test.mjs and the G3 tests read
// myApp.rivetsData.inputController / .noLocalState / .legacyState, and renaming it would break them for nothing. It is a plain
// state bag wrapped in a Proxy whose only job is to call _syncUi() whenever a field is assigned, which is what rivets did.
//
// ─── THE GUEST CLOCK ─────────────────────────────────────────────────────────
// Guest simulation runs at exactly 1.000x hardware: GBA_HZ = 16,777,216 Hz / 280,896 cycles = 59.7275 frames per second,
// taken from MgbaCore.FPS. The speed control (touch menu) is a solo convenience / measurement arm; it can never apply in a
// room — see `roomLocked` below (CLAUDE.md gate 9: guest rate and presented rate are two independent knobs and the guest
// is never sped up to reach a number).
//
// ─── AUDIO ───────────────────────────────────────────────────────────────────
// 44vba produced a constant ~47,878 frames per guest second; mGBA produces whatever rate the GAME programmed (SOUNDBIAS).
// MEASURED on all seven shipped ROMs (1800 frames each, 10 warm-up frames dropped, tools/gba_mgba_solo_test.mjs 'audio rate'):
//   65,536 Hz = 1097.25 frames per video frame (65,536.1 per guest second) for Kirby, Pokemon SoulGold, Ultra Violet, Sonic
//   Advance 3, Super Bust-A-Move and Monster Rancher Advance 2;  32,768 Hz = 548.63 per video frame for Sim City 2000.
// A game can switch rate: Kirby, Sonic Advance 3, Super Bust-A-Move and Monster Rancher Advance 2 report 32,768 for their first
// 1-3 frames and then settle at 65,536. lib/cart_audio.js resamples by ONE fixed ratio chosen at creation, so
// MgbaCore.AudioPipe converts every batch to a fixed 48,000 Hz here, in integer arithmetic (exact per guest second, no rate
// steering: 48,000.1 out per guest second measured on every ROM), and the sink is created with srcRate 48,000. The pipe never
// reads a clock and never asks for frames.
//
// ─── SAVES ───────────────────────────────────────────────────────────────────
// IndexedDB 'GBAWASMDB' / store 'GBAWASMSTATES' (unchanged name, so the old data is still there):
//   '<rom>.sav'              LEGACY, written by the old core: ONE 0x22000-byte buffer. NEVER written or deleted by this page.
//   '<rom>.sav.state'        LEGACY state of the old core (a gzip of its 128 MB heap). NEVER written or deleted; it cannot be
//                            loaded by mGBA, and the page says so.
//   '<rom>.mgba.sav'         the battery in mGBA's RAW format (flash 128K / flash 64K / SRAM 32K / EEPROM 512 B or 8 KB)
//   '<rom>.mgba.state.gz'    gzip of core.saveState(0) (0x61000 bytes)
// First time a ROM is opened with no '<rom>.mgba.sav' but a legacy '<rom>.sav', it is converted (MgbaCore.battery.fromLegacy,
// layout verified against real runs) and written to the NEW key; the legacy copy stays where it is.
//
// ─── ROOMS (stage GR2, 2026-11-01) ───────────────────────────────────────────
// A link-cable room is driven by the inline script in gba.html ("THE ROOM"); THIS file only offers it a seam. beginRoom(handle)
// swaps the solo core for the room's machine (one wasm instance hosting ALL N linked cores, built by gba/mgba/room.js), after which:
//   * roomLocked is true: setGameSpeed() refuses and _roomTick() never reads gameSpeed (gate 9: guest rate and presented rate are
//     independent knobs, and a room's guest runs at EXACTLY 1.000x - the engine can only ever make it slower, by stalling);
//   * _roomTick() takes the place of _tick(): it credits wall time against ONE accumulator exactly as the solo loop does, but a frame
//     runs only when handle.frame() says the lockstep engine has every seat's input for it (a stall never spends its credit, and the
//     debt is clamped to one frame so the guest can never sprint to repay a wait);
//   * nothing in a room is persisted by the solo path: _checkBattery/_flushBattery return at once (the room's own commit plan,
//     room.js planCommit/commitSteps, is the only writer, and only for the LOCAL seat after a clean end every peer reached);
//   * Save State, Load State, Reset, Import/Export .sav and the speed control are disabled (_syncUi) and refuse (roomLocked).
// The solo core (192 MiB of fixed heap) is CLOSED while a room runs and re-created by endRoomToSolo().
//
// ─── THE OLD CORE ────────────────────────────────────────────────────────────
// A ?core=44vba escape hatch was NOT kept: it would have meant two save formats, two state formats, a 128 MB heap-snapshot
// path and a fixed-rate audio path alive side by side in one class, and every one of them is untested together. The
// 44vba files remain in gba/gbaWasm/dist/ untouched.

const GBA_HZ = (window.MgbaCore && window.MgbaCore.FPS) || 59.7275;
const AUDIO_OUT_RATE = 48000;                 // what the cart_audio sink is created with (see AUDIO above)
const STATE_BYTES = 0x61000;                  // GBASerializedState
// Content tokens for the served core files. The glue and the wasm are a PAIR: a stale cached one next to a fresh other is a
// torn core (WebAssembly.instantiate "Import #0 env"), so both are versioned by content. tools/gba_mgba_solo_test.mjs fails
// when these (and the <script> tags in gba.html) differ from md5(file)[0:8].
const MGBA_WASM_V = '13474b38';

// A ROOM tick: at most this much wall time is credited per tick and at most this many frames run in one task (a 4-seat room is up to
// ~8 ms a frame on a desktop, so four frames is ~32 ms; a stall's debt is dropped, never repaid - gate 9). Starting values; the device
// budget stage (GR3) owns tuning them from measurements.
const ROOM_MAX_TICK_MS = 100;
// What the status bar says while a Party room forms and nothing of it has started yet (a solo ROM still arriving, or the idle "Pick a game and press Start", would contradict it).
const ROOM_FORMING_STATUS = 'Party room — the game loads and starts by itself.';
const ROOM_MAX_FRAMES = 4;
// GR3 (device budget): ROOM_MAX_FRAMES stays the CEILING. The room handle's maxFrames() may only LOWER it (gba/mgba/room.js framesPerTick: as many
// frames as fit under the browser's 50 ms long-task line at this device's measured cost), so a slow device does not hold the main thread for
// 100 ms at a time. It can never raise the cap, so it cannot make the guest run faster (gate 9); the credit a shortened tick leaves behind is
// dropped and counted as time this device LOST (this._roomLostMs, published to the room as ls.selfLostMs), never repaid.

const KEY_SUFFIX = { battery: '.mgba.sav', state: '.mgba.state.gz', legacyBattery: '.sav', legacyState: '.sav.state' };

// GBA key bitmask — the same bit order mGBA's KEYINPUT uses (MgbaCore.KEY)
const GBA_KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };

function fnv1a(b) {
    let h = 0x811C9DC5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
    return h >>> 0;
}
function asU8(v) {
    if (v instanceof Uint8Array) return v;
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return new Uint8Array(v);
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const $g = (id) => document.getElementById(id);

// ── THE TOAST — the same #toast element and .show/.err classes genesis.html, snes.html and n64/index.html use ─────────────────
// `kind` is 'info' | 'error' | 'warning'. Every message is also appended to window.__gbaToasts as "<kind>: <text>", the same
// shape toastr's tap produced, because a toast is the only place several of this page's refusals are visible and a test (or a
// debug report) needs to read them back after the fact — a 2.4 s element cannot be asserted on.
window.__gbaToasts = [];
function gbaToast(msg, kind, ms) {
    kind = kind || 'info';
    const line = kind + ': ' + msg;
    window.__gbaToasts.push(line);
    if (window.__gbaToasts.length > 200) window.__gbaToasts.shift();
    try { console.log('[gba] ' + line); } catch (e) { }
    const el = $g('toast');
    if (!el) return;
    // A fullscreen element paints only its own subtree, so a toast parented to <body> is invisible while #canvasWrap or
    // #mobileShell is fullscreen — the same trap lib/xboxinput.js documents for its hint. Re-host it on every show.
    const host = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if (el.parentNode !== host && !/^(CANVAS|VIDEO|IMG)$/.test(host.tagName)) host.appendChild(el);
    el.textContent = msg;
    el.classList.toggle('err', kind === 'error');
    el.classList.toggle('warn', kind === 'warning');
    el.classList.add('show');
    clearTimeout(gbaToast._t);
    gbaToast._t = setTimeout(() => el.classList.remove('show'), ms || (kind === 'info' ? 2400 : 4200));
}
const notify = {
    info: (m, ms) => gbaToast(m, 'info', ms),
    error: (m, ms) => gbaToast(m, 'error', ms),
    warning: (m, ms) => gbaToast(m, 'warning', ms)
};

// ── REMAP DIALOG DATA (the n64 page's #remapPanel, same shape) ──────────────────────────────────────────────────────────────
// Each row: a keyboard binding (KeyMappings.<key>) and a gamepad-button binding (KeyMappings.<joy>). The old Bootstrap dialog also
// listed a "Menu" row; nothing in this page ever read the Menu flag (grep Key_Menu: only input_controller.js sets it), so a
// binding that does nothing is no longer offered. The stored default is kept so saved mappings still load.
const REMAP_ACTIONS = [
    { label: 'D-pad Up', key: 'Mapping_Up', joy: 'Joy_Mapping_Up' }, { label: 'D-pad Down', key: 'Mapping_Down', joy: 'Joy_Mapping_Down' },
    { label: 'D-pad Left', key: 'Mapping_Left', joy: 'Joy_Mapping_Left' }, { label: 'D-pad Right', key: 'Mapping_Right', joy: 'Joy_Mapping_Right' },
    { label: 'A', key: 'Mapping_Action_A', joy: 'Joy_Mapping_Action_A' }, { label: 'B', key: 'Mapping_Action_B', joy: 'Joy_Mapping_Action_B' },
    { label: 'Start', key: 'Mapping_Action_Start', joy: 'Joy_Mapping_Action_Start' }, { label: 'Select', key: 'Mapping_Action_Select', joy: 'Joy_Mapping_Action_Select' },
    { label: 'L', key: 'Mapping_Action_L', joy: 'Joy_Mapping_Action_L' }, { label: 'R', key: 'Mapping_Action_R', joy: 'Joy_Mapping_Action_R' }
];
const MAPPINGS_LS_KEY = 'gbawasm_mappings_v1';
const REMAP_HINT = 'Click a binding, then press the new key or controller button.';

class MyClass {
    constructor() {
        this.rom_name = '';
        this.mobileMode = false;
        this.iosMode = false;

        // mGBA runtime state
        this.core = null;            // MgbaCore.Core, 1 seat
        this.romInfo = null;         // core.loadRom() result: { title, code, saveType, saveTag, crc32, ... }
        this.romSize = 0;
        this.idata = null;
        this.drawContext = null;
        this.isRunning = false;
        this.isWasmReady = false;
        this.gameSpeed = 1;
        // ⚠ GATE 9. A room sets this true (beginRoom) BEFORE its first frame: setGameSpeed() then refuses, and _roomTick runs
        // one guest frame per 1/59.7275 s at most, whatever gameSpeed says. Guest rate and presented rate are independent knobs and
        // the guest is never sped up.
        this.roomLocked = false;
        // The live room's seam (see ROOMS in the header): { frame(hidden, keepAudio) -> bool, video() -> RGBA view, catchUp(held) -> n,
        // rejoining() -> bool, romName }. null in solo play.
        this.roomHandle = null;
        // true from the moment a Party room starts FORMING (the page has a session) until it is over: the solo controls (Start, Browse, Load,
        // Import, Reset...) are down for all of it, because a room will take the console over (the solo core is closed when the room boots).
        this.roomForming = false;
        this.frameCnt = 0;
        this.incidents = 0;
        this.lastRestore = null;     // { hashGame, frames } captured in the same turn a state is restored (test seam)
        this.lastSavedState = null;  // { hashGame, frames, bytes } captured in the same turn a state is saved (test seam)

        // battery persistence bookkeeping
        this._batPersisted = null;   // fnv1a of the last battery image we know is in IndexedDB
        this._batLast = null;        // fnv1a seen at the previous 60-frame check
        this._batDirtyFrames = 0;
        this._batBlocked = false;    // the stored save was refused by this cartridge: do not overwrite it

        // Audio: an AudioWorklet sink (lib/cart_audio.js). The samples are PUSHED, off the main thread's critical path.
        this.audioContext = null;
        this.audioSink = null;
        this.muted = false;
        this.audioPipe = window.MgbaCore ? new window.MgbaCore.AudioPipe(AUDIO_OUT_RATE) : null;

        // The state bag (see the header: the NAME is kept, the template engine is gone). Assigning any field re-runs _syncUi().
        const state = {
            beforeEmulatorStarted: true,
            moduleInitializing: true,
            hasRoms: false,
            romList: [],
            noLocalSave: true,
            // Separate from noLocalSave on purpose: noLocalSave tracks the BATTERY file, this tracks a SAVE STATE. They are
            // different keys and the Load State button must gate on THIS one — see _findInDatabase.
            noLocalState: true,
            // Non-empty when the old core left a state for this ROM that mGBA cannot load (shown, never deleted).
            legacyStateNote: '',
            legacyState: false,
            // Shown in #banner. A core that would not start, or a ROM that would not download.
            lblError: '',
            inputController: null
        };
        this.rivetsData = new Proxy(state, { set: (t, k, v) => { t[k] = v; this._syncUi(); return true; } });

        if (window['ROMLIST'] && window['ROMLIST'].length > 0) {
            this.rivetsData.hasRoms = true;
            window['ROMLIST'].forEach(r => state.romList.push(r));
        }
        this._populateRomSelects();

        this.detectMobile();
        this._wireUi();
        this.setupInputController();
        this.setupDragDropRom();
        this._renderKeyHelp();
        this.setStatus('Loading core…');
        this._syncUi();
        if (this.mobileMode) this._setupMobileMode();

        // rAF loop runs even before a ROM is loaded; frames only execute once isRunning=true
        this._boundLoop = this._emuLoop.bind(this);
        window.requestAnimationFrame(this._boundLoop);
        this._boundTimer = this._timerLoop.bind(this);
        setTimeout(this._boundTimer, 16);

        // A battery save is written when the game STOPS changing it, so closing the tab right after a save point must not lose it.
        document.addEventListener('visibilitychange', () => { if (document.hidden) this._flushBattery(); });
        window.addEventListener('pagehide', () => this._flushBattery());

        // A suspended AudioContext (the browser's autoplay policy) is resumed by the next gesture, as on the genesis page.
        ['click', 'keydown'].forEach(ev => document.addEventListener(ev, () => {
            if (!this.muted && this.audioContext && this.audioContext.state === 'suspended') this.audioContext.resume().catch(() => { });
        }));

        this._bootCore();
    }

    // ── PAGE PLUMBING (plain DOM) ─────────────────────────────────────────────

    setStatus(t) {
        const a = $g('status'), b = $g('mobileStatus');
        if (a) a.textContent = t;
        if (b) b.textContent = t;
    }

    _populateRomSelects() {
        ['romSelect', 'mobileRomSelect'].forEach((id) => {
            const sel = $g(id);
            if (!sel) return;
            sel.textContent = '';
            this.rivetsData.romList.forEach((r) => {
                const o = document.createElement('option');
                o.value = r.url; o.textContent = r.title;
                sel.appendChild(o);
            });
            // Both pickers show the same game: the desktop one is hidden on a phone and the splash one on a desktop, so a visitor
            // never sees them disagree, but a rig that sets one and then reads the other should not be surprised either.
            sel.addEventListener('change', () => {
                ['romSelect', 'mobileRomSelect'].forEach((o) => { const other = $g(o); if (other && other !== sel) other.value = sel.value; });
            });
        });
    }

    // One place decides what is enabled. Called whenever a field of the state bag is assigned, and by the few places that change
    // something the bag does not hold (the core becoming ready, the capability layer taking Start down).
    _syncUi() {
        const d = this.rivetsData;
        const started = !d.beforeEmulatorStarted;
        const inRoom = !!(this.roomLocked || this.roomForming);
        const setDis = (ids, dis) => ids.forEach((id) => { const e = $g(id); if (e) e.disabled = dis; });
        // These exist only once a game is running (Mute and Fullscreen work in a room too).
        setDis(['btnMute', 'btnFull', 'mMute', 'mFull'], !started);
        // ...and these are SOLO things: a state, a reset, a replaced battery or a faster guest would move THIS console away from the
        // other machines of a room.
        setDis(['btnSave', 'btnImport', 'btnExportSav', 'btnImportSav', 'btnReset',
            'mSave', 'mImport', 'mExportSav', 'mImportSav', 'mReset', 'mSpeed'], !started || inRoom);
        // Load/Export State need a state to exist for THIS game (the G3 behaviour; the old-core-state refusal depends on it).
        const hasState = started && !inRoom && !d.noLocalState;
        setDis(['btnLoad', 'btnExport', 'mLoad', 'mExport'], !hasState);
        ['btnLoad', 'btnExport', 'mLoad', 'mExport'].forEach((id) => {
            const e = $g(id);
            if (e) e.title = hasState ? '' : (started ? (d.legacyState ? 'The old emulator core left a state for this game that mGBA cannot load' : 'Press Save State first') : 'Start a game first');
        });
        // Start / Browse / the splash Start follow the core being ready. NEVER re-enable a control the capability layer is holding
        // down: aria-disabled="true" means lib/capability.js owns it (CLAUDE.md "Ownership protocol for the Start button"). A held
        // Start also holds Browse: a ROM picked from disk would otherwise start the page behind the gate.
        const held = this._gateHeld();
        ['btnStart', 'btnBrowse', 'mobileSplashStart'].forEach((id) => {
            const e = $g(id);
            if (!e || e.getAttribute('aria-disabled') === 'true') return;
            e.disabled = !this.isWasmReady || held || inRoom;
        });
        // The game pickers show the ROOM's game for as long as a room forms or runs (gba.html "THE ROOM" syncRomPicker), so they are not
        // for choosing a game then; the solo choice comes back when the room is left.
        setDis(['romSelect', 'mobileRomSelect'], inRoom);
        // Messages
        const banner = $g('banner');
        if (banner) { banner.textContent = d.lblError || ''; banner.style.display = d.lblError ? 'block' : 'none'; }
        const note = d.legacyState ? d.legacyStateNote : '';
        ['legacyStateNote', 'mLegacyNote'].forEach((id) => {
            const e = $g(id);
            if (e) { e.textContent = note; e.style.display = note ? 'block' : 'none'; }
        });
        const sp = $g('mSpeed');
        if (sp) sp.textContent = 'Speed: ' + this.gameSpeed + 'x';
    }

    _gateHeld() {
        return ['btnStart', 'mobileSplashStart'].some((id) => { const e = $g(id); return !!e && e.getAttribute('aria-disabled') === 'true'; });
    }

    _wireUi() {
        const on = (id, ev, fn) => { const e = $g(id); if (e) e.addEventListener(ev, fn); };
        on('btnStart', 'click', () => this.startFromList());
        on('btnBrowse', 'click', () => this.uploadBrowse());
        on('fileInput', 'change', (e) => this.uploadRom(e));
        on('savInput', 'change', (e) => this._onSavFileChosen(e));
        on('btnSave', 'click', () => this.saveStateLocal());
        on('btnLoad', 'click', () => this.loadStateLocal());
        on('btnExport', 'click', () => this.exportStateLocal());
        on('btnImport', 'click', () => this.importStateLocal());
        on('btnExportSav', 'click', () => this.exportSavLocal());
        on('btnImportSav', 'click', () => this.importSavLocal());
        on('btnReset', 'click', () => this.resetGame());
        on('btnMute', 'click', () => this.toggleMute());
        on('btnFull', 'click', () => this.fullscreen());
        on('btnRemap', 'click', () => this.openRemap());

        // The touch menu (#mobileMenu). Each entry acts, then closes the menu.
        const item = (id, fn) => on(id, 'click', () => { fn(); this.hideMobileMenu(); });
        item('mSave', () => this.saveStateLocal());
        item('mLoad', () => this.loadStateLocal());
        item('mExport', () => this.exportStateLocal());
        item('mImport', () => this.importStateLocal());
        item('mExportSav', () => this.exportSavLocal());
        item('mImportSav', () => this.importSavLocal());
        item('mReset', () => this.resetGame());
        item('mMute', () => this.toggleMute());
        item('mFull', () => this.fullscreen());
        item('mNewRom', () => this.newRom());
        on('mSpeed', 'click', () => this.cycleSpeed());        // stays open: pressing it again steps the speed

        // The splash Start is bound to pointerdown, like the other pages: a tap that lands as the splash is removed must not fall
        // through to whatever is behind it. A disabled/held button still receives pointerdown in Chrome, so check.
        const ss = $g('mobileSplashStart');
        if (ss) ss.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            if (ss.disabled || ss.getAttribute('aria-disabled') === 'true') return;
            this.startFromList();
        });

        // KEEP KEYBOARD FOCUS ON THE GAME. A button that keeps focus after a click re-fires on Enter / Space, and Enter is Start:
        // click Save State, press Start in the game, and the state would be saved again. (lib/debugreport.js blurs its own button
        // for the same reason.)
        const bar = $g('controlBar');
        if (bar) bar.addEventListener('click', (e) => { const b = e.target && e.target.closest && e.target.closest('button'); if (b) b.blur(); });

        // The capability layer takes Start down by setting aria-disabled on it; the controls that follow Start must follow too.
        if (window.MutationObserver) {
            const mo = new MutationObserver(() => this._syncUi());
            ['btnStart', 'mobileSplashStart'].forEach((id) => { const e = $g(id); if (e) mo.observe(e, { attributes: true, attributeFilter: ['aria-disabled'] }); });
        }

        // The remap dialog
        on('remapClose', 'click', () => this.closeRemap());
        on('remapSave', 'click', () => this.saveRemap());
        on('remapDefaults', 'click', () => { this._remapState = Object.assign({}, this.rivetsData.inputController.defaultKeymappings()); this._renderRemapRows(); });
        on('remapPanel', 'click', (e) => { if (e.target === $g('remapPanel')) this.closeRemap(); });
    }

    // ── CORE BOOT ─────────────────────────────────────────────────────────────

    _failBoot(msg) {
        console.error('[gba] ' + msg);
        // Emscripten's abort text ends with "Build with -sASSERTIONS for more info": a note to a developer, not to a player. The fixed
        // 192 MB heap is the real requirement (the same for solo and for a room of any size).
        // The glue wraps a failure that was already an abort ("Aborted(Error: Aborted(RangeError: ...). Build with ...). Build with ..."), so
        // unwrap until nothing is left to unwrap.
        let why = String(msg).trim();
        for (let i = 0; i < 4; i++) {
            const m = /^(?:Error:\s*)?Aborted\(([\s\S]*)\)\.?(?:\s*Build with -sASSERTIONS[^.]*\.?)?$/.exec(why);
            if (!m) break;
            why = m[1].trim();
        }
        why = why.replace(/\s*Build with -sASSERTIONS.*$/s, '').trim();
        const mem = /memory|allocate|RangeError/i.test(why) ? ' The emulator needs one fixed 192 MB block of memory; closing other tabs and reloading the page may help.' : ' Reloading the page may help.';
        this.rivetsData.lblError = 'Could not start the emulator core: ' + why + (/[.!]$/.test(why) ? '' : '.') + mem;
        this.setStatus('Core failed to load.');
    }

    _bootCore() {
        if (!window.MgbaCore || typeof window.createMgbaCore !== 'function') {
            this._failBoot('the mGBA scripts did not load (/gba/mgba/dist/mgba_core.js, /gba/mgba/mgba_core.js).');
            return Promise.resolve();
        }
        // The literal '/gba/mgba/dist/mgba_core.wasm' is here on purpose: tools/verify_deploy_assets.mjs can only see literal URLs.
        return window.MgbaCore.create({
            seats: 1,
            locateFile: (p) => (p === 'mgba_core.wasm' ? '/gba/mgba/dist/mgba_core.wasm?v=' + MGBA_WASM_V : '/gba/mgba/dist/' + p),
            printErr: (s) => { try { console.log('[mgba] ' + s); } catch (e) { } }
        }).then((core) => {
            this.core = core;
            this.onWasmReady();
        }).catch((e) => this._failBoot((e && e.message) || String(e)));
    }

    onWasmReady() {
        const canvas = $g('canvas');
        canvas.width = 240;
        canvas.height = 160;
        this.drawContext = canvas.getContext('2d');
        this.isWasmReady = true;
        this.rivetsData.moduleInitializing = false;     // → _syncUi(): Start / Browse / the splash Start light up (unless gated)
        this.setStatus('Core ready. Pick a game and press Start.');
        console.log('mGBA WASM ready (ABI ' + this.core.abi + ', ' + this.core.memory().heapBytes + ' B heap)');
        if (typeof spScaleCanvas === 'function') spScaleCanvas();
    }

    // ── AUDIO ─────────────────────────────────────────────────────────────────

    tryInitSound() {
        if (this.audioContext) {
            if (!this.muted && this.audioContext.state !== 'running') this.audioContext.resume();
            return;
        }
        try {
            // 'interactive', NOT 'playback': 'playback' asks the OS for a deep output buffer (measured outputLatency 216 ms on
            // a phone, sound ~0.2 s behind the picture). The AudioWorklet sink (lib/cart_audio.js) holds the cushion off the
            // main thread and counts every gap it plays.
            this.audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: AUDIO_OUT_RATE });
            if (window.AudioDiag) {
                window.AudioDiag.install('gba', { ctxRate: this.audioContext.sampleRate, srcRate: AUDIO_OUT_RATE });
                window.AudioDiag.observeContext(this.audioContext);
            }
            this.audioSink = window.CartAudio
                ? window.CartAudio.create(this.audioContext, { srcRate: AUDIO_OUT_RATE, targetMs: 80, maxMs: 400, page: 'gba' })
                : null;
            this.audioContext.resume();
        } catch (e) { console.log('Audio init failed:', e); }
    }

    // One emulated frame's audio, converted to the sink's fixed rate and PUSHED. Gate #9: nothing here feeds back into the
    // loop's timing. At gameSpeed > 1 the audio is dropped on purpose (a fast-forward arm; the core drains its own buffer).
    // While muted the core's buffer is still drained and converted (so it never backs up and the pipe's phase keeps moving);
    // only the push to the sink is skipped.
    _pumpAudio(audio) {
        if (this.gameSpeed > 1) return;
        const a = audio || this.core.audio(0);
        if (!a.frames) return;
        const out = this.audioPipe.process(a.samples, a.frames, a.rate);
        if (!out.frames) return;
        if (this.muted) return;
        if (this.audioSink) this.audioSink.push(out.samples, out.frames);
        else {
            const d = window.__audioDiag;
            if (d) { d.framesProduced += out.frames; d.droppedFrames = (d.droppedFrames || 0) + out.frames; d.batchesDropped++; }
        }
    }

    toggleMute() {
        this.muted = !this.muted;
        const ctx = this.audioContext;
        if (ctx) { this.muted ? ctx.suspend().catch(() => { }) : ctx.resume().catch(() => { }); }
        if (!this.muted && this.audioSink) this.audioSink.clear();     // nothing was pushed while muted; start the cushion afresh
        const b = $g('btnMute'); if (b) b.textContent = this.muted ? '🔇 Unmute' : '🔊 Mute';
        const m = $g('mMute'); if (m) m.textContent = this.muted ? 'Unmute' : 'Mute';
    }

    // ── GAME LOOP ─────────────────────────────────────────────────────────────

    // THE GUEST CLOCK IS NOT THE DISPLAY'S. This loop used to run frames only from requestAnimationFrame, so the guest could
    // advance only when the compositor produced a frame — and a phone's compositor does not promise 60 Hz: low-power mode runs
    // rAF at 30, a busy GPU or a throttled tab delivers ticks 60-100 ms apart, and every tick past the 50 ms clamp silently
    // dropped the rest of its time. Measured on the mobile profile (tools/netplay_device_matrix.mjs, 2026-10-01): rAF at
    // 10-38/s, guest 0.79x. Now a timer, woken when the next frame is due, keeps the guest on the wall clock whenever the CPU
    // has room, and rAF still drives it when rAF is the faster of the two. Both feed ONE accumulator against performance.now(),
    // so the second caller in a frame period finds no credit and does nothing: the guest still runs at exactly 1.000x and
    // never faster (gate #9) — a late tick's debt is dropped, never repaid.
    _emuLoop() {
        window.requestAnimationFrame(this._boundLoop)
        this._tick(performance.now())
    }

    _timerLoop() {
        // IN A ROOM the timer stands down and rAF alone drives the clock (genesis.html does the same): the lockstep pacing was built
        // and measured on rAF timestamps, and two callers per frame period would only make the engine's own-clock bookkeeping noisier.
        if (!this.roomHandle) this._tick(performance.now())
        const FRAME_MS = 1000 / GBA_HZ
        const wait = this.isRunning && !this.roomHandle ? Math.max(1, FRAME_MS - (this._accum || 0)) : 50
        setTimeout(this._boundTimer, wait)
    }

    _tick(now) {
        if (!this.isRunning) { this._lastFrameTime = 0; return }
        if (this.roomHandle) { this._roomTick(now); return }

        const GBA_FRAME_MS = 1000 / GBA_HZ

        if (!this._lastFrameTime) {
            this._lastFrameTime = now
            this._accum = 0
            return
        }

        let delta = now - this._lastFrameTime
        this._lastFrameTime = now
        if (delta < 0) delta = 0

        // Same policy as snes.html / genesis.html: a long stall must not fast-forward the guest, and no debt survives the tick.
        if (delta > 100) delta = 100

        this._accum += delta

        // At most three frames in one task. Four (snes/genesis's cap) measured 90.8 long tasks/min on the mobile profile
        // against 0 for three, because one GBA frame there costs ~15 ms: a fourth frame pushes the task past 50 ms, and a touch
        // that lands behind it waits.
        const MAX_FRAMES = 3
        // gate 9: a room never fast-forwards.
        const speed = this.roomLocked ? 1 : this.gameSpeed

        let frames = 0

        while (this._accum >= GBA_FRAME_MS && frames < MAX_FRAMES) {
            for (let i = 0; i < speed; i++) {
                this._runFrame()
            }
            this._accum -= GBA_FRAME_MS
            frames++
        }
        if (this._accum > GBA_FRAME_MS) this._accum = GBA_FRAME_MS

        // One present per tick, however many frames ran.
        if (frames) this._present()
        this._fpsTick(now)
    }

    // The status bar's rate readout, in the words genesis.html and snes.html use. "guest" is frames the core actually ran,
    // "presented" is images drawn; they are separate knobs (CLAUDE.md gate 9) and both are shown.
    _fpsTick(now) {
        const f = this._fps || (this._fps = { at: 0, guest: 0, presented: 0, hist: [] });
        if (!f.at) { f.at = now; return; }
        if (now - f.at < 1000) return;
        const secs = (now - f.at) / 1000;
        // The readout is a rate over the last TEN seconds of one-second windows, not over the last one: a one-second window counts whole
        // frames, so it quantises to +-1 frame and routinely prints 1.004x for a guest that is at 1.0000x - which reads like a sped-up guest.
        (f.hist || (f.hist = [])).push({ secs, guest: f.guest, presented: f.presented });
        while (f.hist.length > 12) f.hist.shift();
        let T = 0, G = 0, P = 0;
        for (let i = f.hist.length - 1; i >= 0 && T < 10; i--) { T += f.hist[i].secs; G += f.hist[i].guest; P += f.hist[i].presented; }
        const el = $g('fps');
        if (el) el.textContent = 'guest ' + (G / T).toFixed(2) + '/s (' + ((G / T) / GBA_HZ).toFixed(3) + 'x hardware) · presented ' + (P / T).toFixed(1) + '/s';
        if (el) el.title = 'a rate over the last ' + Math.round(T) + ' s (one-second windows count whole frames and read +-0.004x)';
        f.guest = 0; f.presented = 0; f.at = now;
    }

    _present() {
        const v = this.roomHandle ? this.roomHandle.video() : this.core.video(0)
        // The heap is fixed (ALLOW_MEMORY_GROWTH=0) so this view is stable; re-derive anyway if it ever is not.
        if (!this.idata || this.idata.data.buffer !== v.buffer || this.idata.data.byteOffset !== v.byteOffset) {
            this.idata = new ImageData(v, 240, 160)
        }
        this.drawContext.putImageData(this.idata, 0, 0)
        if (this._fps) this._fps.presented++
    }

    _runFrame() {
        if (!this.isRunning || !this.isWasmReady) return;
        this.frameCnt++;
        if (this._fps) this._fps.guest++;
        if (this.frameCnt % 60 === 0) this._checkBattery();
        const core = this.core;
        core.setKeys(0, this._getKeyMask());
        const st = core.runFrame();
        // A solo core has no link layer, so a non-zero status would be a bridge fault: count it, never ignore it silently.
        if (st) { this.incidents++; if (this.incidents <= 3) console.warn('[gba] runFrame status 0x' + st.toString(16), core.incidents()); }
        this._pumpAudio();
    }

    _getKeyMask() {
        const ic = this.rivetsData.inputController;
        if (!ic) return 0;
        let m = 0;
        if (ic.Key_Action_A) m |= GBA_KEY.A;
        if (ic.Key_Action_B) m |= GBA_KEY.B;
        if (ic.Key_Action_Select) m |= GBA_KEY.SELECT;
        if (ic.Key_Action_Start) m |= GBA_KEY.START;
        if (ic.Key_Right) m |= GBA_KEY.RIGHT;
        if (ic.Key_Left) m |= GBA_KEY.LEFT;
        if (ic.Key_Up) m |= GBA_KEY.UP;
        if (ic.Key_Down) m |= GBA_KEY.DOWN;
        if (ic.Key_Action_R) m |= GBA_KEY.R;
        if (ic.Key_Action_L) m |= GBA_KEY.L;
        return m;
    }

    // ── ROM LOADING ───────────────────────────────────────────────────────────

    uploadBrowse() {
        if (this._gateHeld()) return;
        this.tryInitSound();
        const f = $g('fileInput');
        if (f) { f.value = ''; f.click(); }       // '' so choosing the SAME file twice still fires `change`
    }

    uploadRom(event) {
        const file = event.currentTarget.files[0];
        if (!file) return;
        this._readAndLoad(file);
    }

    _readAndLoad(file) {
        if (this._gateHeld() || this.roomLocked || this.roomForming) return;
        this.tryInitSound();
        const r = new FileReader();
        r.onload = (e) => this._loadRomArrayBuffer(e.target.result, file.name);
        r.onerror = () => notify.error('Could not read ' + file.name);
        r.readAsArrayBuffer(file);
    }

    // The Start button (and the splash Start): load whatever the picker shows.
    async startFromList() {
        if (!this.isWasmReady || this._gateHeld() || this._starting || this.roomLocked || this.roomForming) return;
        this._starting = true;
        try { await this.loadRom(); } finally { this._starting = false; }
    }

    async loadRom() {
        // The visible picker: the splash's on a phone, the toolbar's on a desktop.
        const sel = $g(this.mobileMode ? 'mobileRomSelect' : 'romSelect');
        const url = sel && sel['value'];
        if (!url) { notify.error('No game is selected.'); return; }
        const title = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : this._extractRomName(url);
        this.tryInitSound();
        // A room that forms while this ROM is still arriving takes the console over (setRoomForming bumps the token): the late solo load is dropped,
        // its progress no longer writes the status bar, and its failure is not reported - the room is unaffected.
        const token = this._soloLoadToken = (this._soloLoadToken | 0) + 1;
        const stale = () => token !== this._soloLoadToken || this.roomLocked || this.roomForming;
        this.setStatus('Fetching ' + title + '…');
        try {
            const ab = await this._fetchRom(url, (pct) => { if (!stale()) this.setStatus('Fetching ' + title + '… ' + pct + '%'); });
            if (stale()) return;
            await this._loadRomArrayBuffer(ab, this._extractRomName(url));
        } catch (e) {
            if (stale()) return;
            this.setStatus('ROM fetch failed.');
            this.rivetsData.lblError = 'Could not load ' + title + '. ' + String((e && e.message) || e) + ' — you can still use Browse… to open a .gba from this device.';
            notify.error('Failed to load ROM: ' + e);
        }
    }

    // The cartridge, with progress. Without a content-length (or a body stream) it falls back to one read.
    async _fetchRom(url, onPct) {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const total = +r.headers.get('content-length') || 0;
        if (!total || !r.body || !r.body.getReader) return await r.arrayBuffer();
        const reader = r.body.getReader(), parts = []; let got = 0;
        for (;;) {
            const c = await reader.read();
            if (c.done) break;
            parts.push(c.value); got += c.value.length;
            if (onPct) onPct(Math.min(99, Math.floor(got * 100 / total)));
        }
        const out = new Uint8Array(got); let off = 0;
        parts.forEach((p) => { out.set(p, off); off += p.length; });
        return out.buffer;
    }

    // `name` becomes this.rom_name ONLY once the core has accepted the ROM. Every IndexedDB key is built from rom_name, so a file that is
    // refused (not a GBA ROM, wrong size) while a game is running must not re-key that game's battery and state under the refused
    // file's name. Resolves true when the game is running, false when it was refused.
    async _loadRomArrayBuffer(arrayBuffer, name) {
        if (!this.isWasmReady) { notify.error('Emulator not ready yet.'); return false; }
        if (this._gateHeld()) { notify.error('This device cannot run the emulator (see the notice above).'); return false; }
        const u8 = new Uint8Array(arrayBuffer);

        // Validate the GBA header fixed byte (the core also validates the logo / size)
        const settle = () => this.setStatus(this.isRunning ? 'Running — ' + this.rom_name : 'Core ready. Pick a game and press Start.');
        if (u8[0xB2] !== 0x96) { notify.error('Not a valid GBA ROM.'); settle(); return false; }

        // A ROM dropped while another game is running replaces it: that game's battery is written under ITS key first (rom_name is
        // still the running game's), because the core is about to discard it.
        const wasRunning = this.isRunning;
        await this._flushBattery();
        this.isRunning = false;
        let info;
        try {
            info = this.core.loadRom(u8);
        } catch (e) {
            notify.error('Could not load this ROM: ' + ((e && e.message) || e));
            // ROM_SIZE and NOT_A_GBA_ROM are refused by the bridge BEFORE it touches the running game (bridge/bemental_gba.c
            // load_rom_common); anything later has already replaced it.
            if (wasRunning && e && (e.rc === -1 || e.rc === -2)) { this.isRunning = true; this._lastFrameTime = null; settle(); }
            else this.setStatus('The core refused this ROM.');
            return false;
        }
        this.rom_name = name || this.rom_name || 'game.gba';
        this.romInfo = info;
        this.romSize = u8.length;
        this.frameCnt = 0;
        this.incidents = 0;
        this.idata = null;
        this._batPersisted = null; this._batLast = null; this._batDirtyFrames = 0; this._batBlocked = false;
        if (this.audioPipe) this.audioPipe.reset();
        if (this.audioSink) this.audioSink.clear();

        // Restore the battery BEFORE the first frame: mGBA decides the chip lazily, setSave() is only reliable until then.
        const restored = await this._restoreBattery(info);
        if (restored !== 'none') console.log('Battery restored (' + restored + ') for', this.rom_name);
        await this._findInDatabase();
        this.rivetsData.lblError = '';
        this.rivetsData.beforeEmulatorStarted = false;      // → _syncUi(): Save / Import / Reset / Mute / Fullscreen light up
        this._lastFrameTime = null; // reset fixed-timestep clock for new ROM
        this.isRunning = true;
        this._onStarted();
        return true;
    }

    // Everything that happens once, the moment a game is actually running.
    _onStarted() {
        this.setStatus('Running — ' + this.rom_name);
        const shell = $g('mobileShell'); if (shell) shell.classList.add('running');
        if (this.mobileMode) {
            const sp = $g('mobileSplash'); if (sp) sp.style.display = 'none';
            if (typeof spScaleCanvas === 'function') spScaleCanvas();
            this._checkOrientation();
        }
        // XBOX: the stick drives the GAME from here, not Edge's cursor (lib/xboxinput.js).
        try { window.XboxInput && window.XboxInput.offerGameControls('gba running'); } catch (e) { }
        // Hand the keyboard back to the game: a picker or button that still has focus would swallow the arrow keys / Enter.
        const a = document.activeElement;
        if (a && a !== document.body && /^(BUTTON|SELECT)$/.test(a.tagName) && a.blur) a.blur();
        this._renderKeyHelp();
    }

    _extractRomName(name) {
        return name.includes('/') ? name.substr(name.lastIndexOf('/') + 1) : name;
    }

    // Drop a .gba anywhere on the page. The whole window listens (a file dropped just outside the picture must not navigate the
    // tab to the ROM), the stage shows where it will land.
    setupDragDropRom() {
        let depth = 0;
        const hasFiles = (e) => !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0);
        const mark = (on) => ['canvasWrap', 'mobileScreen'].forEach((id) => { const z = $g(id); if (z) z.classList.toggle('dropping', on); });
        window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; mark(true); });
        window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (_) { } });
        window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) mark(false); });
        window.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault(); depth = 0; mark(false);
            const file = e.dataTransfer.files[0];
            if (file) this._readAndLoad(file);
        });
    }

    // ── KEYS ──────────────────────────────────────────────────────────────────

    _key(kind) {
        return this.rom_name ? this.rom_name + KEY_SUFFIX[kind] : null;
    }
    _romBase() {
        return (this.rom_name || 'game').replace(/\.(gba|agb|bin)$/i, '');
    }

    // ── INDEXED DB ────────────────────────────────────────────────────────────

    // The database's name. ⚠ TEST SEAM ONLY (?roomtest=1&gbadb=NAME): two simulated players in two windows of ONE test profile share one
    // origin and therefore one IndexedDB, so both would read and write the same battery key; two real players have two browsers. The
    // seam gives each simulated player its own database. Without roomtest=1 the name is always the shipped one.
    _dbName() {
        try {
            const q = new URLSearchParams(location.search), n = q.get('gbadb');
            // loopback only, like the rest of the ?roomtest=1 seam (gba.html "THE ROOM"): inert on the public site
            if (q.get('roomtest') === '1' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && n && /^[A-Za-z0-9_-]{1,32}$/.test(n)) return 'GBAWASMDB-test-' + n;
        } catch (e) { }
        return 'GBAWASMDB';
    }

    _db() {
        if (!this._dbp) {
            this._dbp = new Promise((resolve, reject) => {
                if (!window['indexedDB']) { reject(new Error('IndexedDB is not available')); return; }
                const req = indexedDB.open(this._dbName());
                // Same name/store/version the old core used (no version argument), so a visitor's existing data is untouched.
                req.onupgradeneeded = (ev) => {
                    const db = ev.target.result;
                    if (!db.objectStoreNames.contains('GBAWASMSTATES')) db.createObjectStore('GBAWASMSTATES', { autoIncrement: true });
                };
                req.onsuccess = (ev) => resolve(ev.target.result);
                req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
            });
            this._dbp.catch(() => { this._dbp = null; });
        }
        return this._dbp;
    }

    // Resolves undefined when the key is absent OR the database cannot be used (a missing save must never stop a game starting).
    async _dbGet(key) {
        try {
            const db = await this._db();
            return await new Promise((resolve) => {
                const r = db.transaction('GBAWASMSTATES', 'readonly').objectStore('GBAWASMSTATES').get(key);
                r.onsuccess = () => resolve(r.result || undefined);
                r.onerror = () => resolve(undefined);
            });
        } catch (e) { return undefined; }
    }

    // Rejects with the DOMException so a caller can say WHY (QuotaExceededError is something a visitor can act on).
    async _dbPut(key, data) {
        const db = await this._db();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('GBAWASMSTATES', 'readwrite');
            tx.objectStore('GBAWASMSTATES').put(data, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
        });
    }

    _putErrorText(e, what) {
        const nm = e && e.name ? e.name : 'unknown error';
        return nm === 'QuotaExceededError' ? what + ' failed — out of browser storage on this device.' : what + ' failed (' + nm + ').';
    }

    // ── BATTERY (the cartridge's save memory) ─────────────────────────────────

    // Returns 'mgba' | 'legacy' | 'none' | 'rejected'.
    async _restoreBattery(info) {
        const core = this.core, bk = this._key('battery');
        if (!bk) return 'none';
        let raw = null, src = 'none';
        const have = await this._dbGet(bk);
        if (have) { raw = asU8(have); src = 'mgba'; }
        else {
            const old = await this._dbGet(this._key('legacyBattery'));
            if (old) {
                const conv = window.MgbaCore.battery.fromLegacy(asU8(old), info.saveTag);
                if (conv) { raw = conv.bytes; src = 'legacy'; }
            }
        }
        if (!raw) return 'none';
        if (!core.setSave(0, raw)) {
            // The cartridge's battery will not take this image (wrong chip size for this ROM, or the file is damaged). The stored
            // copy is left exactly as it is: overwriting it with this session's blank battery would destroy it.
            this._batBlocked = true;
            notify.error('The stored save for this game (' + raw.length + ' bytes) does not fit this cartridge (' + info.saveTag +
                '). It was left untouched and this session will not overwrite it — use Export .sav to keep a copy.');
            return 'rejected';
        }
        const live = core.exportSave(0);
        this._batPersisted = fnv1a(live || raw);
        this.rivetsData.noLocalSave = false;
        if (src === 'legacy') {
            // Carry the old core's save across ONCE, to the new key. The legacy buffer stays where it is.
            try {
                await this._dbPut(bk, raw);
                notify.info('Your save from the old emulator core was converted (' + raw.length + ' bytes, ' + info.saveTag + ') and loaded. The old copy was left in place.');
            } catch (e) { notify.warning(this._putErrorText(e, 'Saving the converted battery')); this._batPersisted = null; }
        }
        return src;
    }

    // Every 60 frames: the game "saves" by writing flash/SRAM/EEPROM in bursts. Persist on the falling edge (the image stopped
    // changing between two checks), and at least every 10 s of continuous change so a long burst is never unbounded loss.
    _checkBattery() {
        if (!this.isRunning || this._batBlocked || this.roomHandle) return;
        const b = this.core.exportSave(0);
        if (!b || window.MgbaCore.battery.isBlank(b)) return;   // the game has not written its save memory yet (a chip nobody wrote is all 0xFF)
        const h = fnv1a(b);
        const dirty = h !== this._batPersisted;
        if (dirty) this._batDirtyFrames += 60; else this._batDirtyFrames = 0;
        if (dirty && (h === this._batLast || this._batDirtyFrames >= 600)) this._persistBattery(b, h);
        this._batLast = h;
    }

    _persistBattery(bytes, hash) {
        const key = this._key('battery');
        if (!key) return Promise.resolve();
        this._batPersisted = hash === undefined ? fnv1a(bytes) : hash;
        this._batDirtyFrames = 0;
        return this._dbPut(key, bytes).then(
            () => { this.rivetsData.noLocalSave = false; },
            (e) => { this._batPersisted = null; console.warn('[gba] battery write failed:', e && e.name); }
        );
    }

    // Best-effort write of whatever the battery holds right now (tab hidden / closing / New Rom).
    _flushBattery() {
        try {
            if (this.roomHandle || !this.core || !this.core.loaded || this._batBlocked || !this._key('battery')) return Promise.resolve();
            const b = this.core.exportSave(0);
            if (!b || window.MgbaCore.battery.isBlank(b)) return Promise.resolve();
            const h = fnv1a(b);
            if (h === this._batPersisted) return Promise.resolve();
            return this._persistBattery(b, h);
        } catch (e) { return Promise.resolve(); }
    }

    // ── EXPORT / IMPORT A BATTERY SAVE (.sav) ─────────────────────────────────
    // The file is the raw chip image mGBA, other emulators and flash carts all use (flash 128 KB / 64 KB, SRAM 32 KB,
    // EEPROM 512 B / 8 KB): pokemonarena's save importer reads exactly this.

    _download(name, bytes) {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    async exportSavLocal() {
        if (this.roomLocked) { notify.error('Not while you are in a room'); return; }
        if (!this.core || !this.core.loaded) { notify.error('Load a ROM first, then export its save.'); return; }
        // The LIVE battery, not the last persisted copy: what the game holds right now is what the visitor wants.
        let bytes = this.core.exportSave(0);
        if (!bytes || window.MgbaCore.battery.isBlank(bytes)) {
            const stored = await this._dbGet(this._key('battery'));
            bytes = stored ? asU8(stored) : null;
        }
        if (!bytes || !bytes.length) { notify.error('No battery save yet — this game has not written one. Save in the game first.'); return; }
        this._download(this._romBase() + '.sav', bytes);
        notify.info('Exported ' + bytes.length + ' bytes (' + this.romInfo.saveTag + ').');
        return bytes.length;
    }

    importSavLocal() {
        if (!this._key('battery')) { notify.error('Load a ROM first, then import its save.'); return; }
        if (this.roomLocked) { notify.error('Not while you are in a room'); return; }
        const inp = $g('savInput');
        if (!inp) { notify.error('Import is unavailable on this page.'); return; }
        inp.value = '';
        inp.click();
    }

    async _onSavFileChosen(ev) {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;
        try { await this.importSavBytes(new Uint8Array(await f.arrayBuffer()), f.name); }
        catch (e) { notify.error('Import failed: ' + ((e && e.message) || e)); }
    }

    // Also the seam tools/gba_mgba_solo_test.mjs drives. Applies the save and POWER-CYCLES the game: a cartridge reads its save at
    // start-up, so replacing it under a running game would leave the game's own copy in RAM stale.
    async importSavBytes(bytes, label) {
        if (!this.core || !this.core.loaded || !this._key('battery')) { notify.error('Load a ROM first, then import its save.'); return false; }
        const bat = window.MgbaCore.battery;
        let raw = asU8(bytes);
        if (bat.isLegacy(raw)) {                      // a dump from the old core's buffer
            const conv = bat.fromLegacy(raw, this.romInfo.saveTag);
            if (!conv) { notify.error('That file is an empty save from the old core (every byte is 0xFF).'); return false; }
            raw = conv.bytes;
        }
        if (!bat.isRawSize(raw.length)) {
            notify.error('That file is ' + raw.length + ' bytes. A GBA battery save is 512 B, 8 KB, 32 KB, 64 KB or 128 KB.');
            return false;
        }
        if (!this.core.setSave(0, raw)) {
            notify.error('This game\'s battery (' + this.romInfo.saveTag + ') does not take a ' + raw.length + '-byte save, so it was not imported.');
            return false;
        }
        this._batBlocked = false;
        try { await this._dbPut(this._key('battery'), raw); }
        catch (e) { notify.error(this._putErrorText(e, 'Import')); return false; }
        this.core.reset();
        this._batPersisted = fnv1a(this.core.exportSave(0) || raw);
        this._batLast = null; this._batDirtyFrames = 0;
        this.rivetsData.noLocalSave = false;
        if (this.audioPipe) this.audioPipe.reset();
        if (this.audioSink) this.audioSink.clear();
        this._lastFrameTime = null;
        this.lastImport = { bytes: raw.length, label: label || '', at: performance.now() };
        notify.info('Imported ' + raw.length + ' bytes' + (label ? ' from ' + label : '') + '. The game was restarted from power-on with it.');
        return true;
    }

    // ── SAVE STATES ───────────────────────────────────────────────────────────
    // An mGBA state is the core's own 0x61000-byte serialisation (CPU, RAM, video, audio, timers, the cartridge hardware): ~400 KB
    // raw, tens of KB gzipped. The old core snapshotted a 128 MB heap and needed streaming, slicing and a ROM-exclusion window to
    // be survivable on a console; none of that exists here. The ROM is not in the state.

    async _gzip(bytes) {
        const cs = new CompressionStream('gzip');
        const w = cs.writable.getWriter();
        w.write(bytes); w.close();
        return new Uint8Array(await new Response(cs.readable).arrayBuffer());
    }

    // Inflate at most `cap` bytes; a stream that would exceed it throws RangeError('TOO_LARGE') without ever holding more than
    // `cap` + one chunk — so importing a 128 MB old-core state cannot balloon memory.
    async _gunzip(bytes, cap) {
        const ds = new DecompressionStream('gzip');
        const w = ds.writable.getWriter();
        w.write(bytes).catch(() => { }); w.close().catch(() => { });
        const reader = ds.readable.getReader();
        const parts = []; let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > cap) { try { reader.cancel(); } catch (e) { } throw new RangeError('TOO_LARGE'); }
            parts.push(value);
        }
        const out = new Uint8Array(total); let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }

    async saveStateLocal() {
        if (this.roomLocked) { notify.error('Not while you are in a room'); return; }
        if (!this.isRunning) { notify.error('No game running.'); return; }
        const key = this._key('state');
        if (!key) { notify.error('No ROM loaded.'); return; }
        // The snapshot itself is synchronous, so the game does not need to pause: what is compressed is exactly this frame.
        let raw;
        try {
            raw = this.core.saveState(0);
            this.lastSavedState = { hashGame: this.core.hashGame(0), hash: this.core.hash(0), frames: this.core.frames(0), bytes: raw.length };
        } catch (e) { notify.error('State save error: ' + e.message); return; }
        notify.info('Saving state…');
        let compressed;
        try { compressed = await this._gzip(raw); }
        catch (e) { notify.error('State save error: ' + e.message); return; }
        await this._requestPersistentStorage();
        try {
            await this._dbPut(key, compressed);
            this.rivetsData.noLocalState = false;
            this.lastSavedState.storedBytes = compressed.byteLength;
            notify.info('State saved (' + (compressed.byteLength / 1024).toFixed(0) + ' KB).');
        } catch (e) {
            notify.error(this._putErrorText(e, 'State save'));
        }
    }

    // Ask for storage that the browser will not evict under pressure. Chromium grants this on engagement without prompting; a
    // refusal is not fatal, so this never blocks a save.
    async _requestPersistentStorage() {
        if (this._persistAsked) return this._persistGranted;
        this._persistAsked = true;
        try {
            if (navigator.storage && navigator.storage.persist) {
                this._persistGranted = await navigator.storage.persisted() || await navigator.storage.persist();
                console.log('Persistent storage:', this._persistGranted ? 'granted' : 'DENIED (state may be evicted)');
            }
        } catch (e) { console.log('Persistent storage request failed:', e.message); }
        return this._persistGranted;
    }

    async loadStateLocal() {
        const key = this._key('state');
        if (!key || !this.core || !this.core.loaded) { notify.error('No ROM loaded.'); return; }
        // Restoring a state moves THIS console to another point in the game while a room's other machines stay where they are.
        if (this.roomLocked) { notify.error('Not while you are in a room'); return; }
        const data = await this._dbGet(key);
        if (!data) {
            notify.error(this.rivetsData.legacyStateNote || 'No save state found for this ROM.');
            return;
        }
        notify.info('Restoring state…');
        let raw;
        try { raw = await this._gunzip(asU8(data), STATE_BYTES); }
        catch (e) { notify.error('State restore failed — the stored state is unreadable. (' + e.message + ')'); return; }
        if (raw.length !== STATE_BYTES) { notify.error('State restore failed — the stored state is ' + raw.length + ' bytes, not ' + STATE_BYTES + '.'); return; }
        // restore + witness in ONE turn: no emulated frame can run between them.
        const ok = this.core.loadState(0, raw);
        if (!ok) { notify.error('The core did not accept this state (is it from a different game?). Nothing was changed.'); return; }
        this.lastRestore = { hashGame: this.core.hashGame(0), hash: this.core.hash(0), frames: this.core.frames(0) };
        this._lastFrameTime = null;
        if (this.audioPipe) this.audioPipe.reset();
        if (this.audioSink) this.audioSink.clear();
        notify.info('State restored.');
    }

    // ── EXPORT / IMPORT A SAVE STATE ──────────────────────────────────────────
    // The exported file is EXACTLY the bytes stored — the gzip written by saveStateLocal — so an export re-imports byte for byte.
    async exportStateLocal() {
        const key = this._key('state');
        if (!key) { notify.error('No ROM loaded.'); return; }
        const data = await this._dbGet(key);
        if (!data) { notify.error(this.rivetsData.legacyStateNote || 'No save state to export — press Save State first.'); return; }
        const bytes = asU8(data);
        if (!bytes.byteLength) { notify.error('Saved state is empty.'); return; }
        this._download(key, bytes);
        notify.info('Exported ' + (bytes.byteLength / 1024).toFixed(0) + ' KB.');
    }

    importStateLocal() {
        const key = this._key('state');
        if (!key) { notify.error('Load a ROM first, then import.'); return; }
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.gz,.state,application/octet-stream';
        inp.addEventListener('change', async () => {
            const f = inp.files && inp.files[0];
            if (!f) return;
            try { await this.importStateBytes(new Uint8Array(await f.arrayBuffer())); }
            catch (e) { notify.error('Import failed: ' + e.message); }
        });
        inp.click();
    }

    // Also a test seam. Validates BEFORE storing: writing an unreadable blob over a good state would destroy the thing the
    // visitor was trying to protect.
    async importStateBytes(buf) {
        const key = this._key('state');
        if (!key) { notify.error('Load a ROM first, then import.'); return false; }
        if (buf.length < 3 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
            notify.error('That file is not a GBA save state (no gzip header).');
            return false;
        }
        let raw;
        try { raw = await this._gunzip(buf, STATE_BYTES); }
        catch (e) {
            notify.error(e && e.message === 'TOO_LARGE'
                ? 'That state is from the OLD emulator core (it holds a 128 MB memory image) and the new core (mGBA) cannot load it.'
                : 'That file is not a readable GBA save state. (' + (e && e.message) + ')');
            return false;
        }
        if (raw.length !== STATE_BYTES) {
            notify.error('That file inflates to ' + raw.length + ' bytes; an mGBA state is ' + STATE_BYTES + '. It was not imported.');
            return false;
        }
        try { await this._dbPut(key, buf); }
        catch (e) { notify.error(this._putErrorText(e, 'Import')); return false; }
        this.rivetsData.noLocalState = false;
        notify.info('Imported ' + (buf.byteLength / 1024).toFixed(0) + ' KB — press Load State to apply it.');
        return true;
    }

    // Probe the keys after a ROM load. noLocalSave tracks the battery, noLocalState the mGBA state, and a state the OLD core left
    // behind is reported rather than silently offered (it cannot be loaded: it is a gzip of a 128 MB heap, not an mGBA state).
    async _findInDatabase() {
        const sv = this._key('battery');
        if (!sv) return;
        const [bat, oldBat, st, oldSt] = await Promise.all([
            this._dbGet(sv), this._dbGet(this._key('legacyBattery')), this._dbGet(this._key('state')), this._dbGet(this._key('legacyState'))
        ]);
        this.rivetsData.noLocalSave = !(bat || (oldBat && window.MgbaCore.battery.fromLegacy(asU8(oldBat), this.romInfo && this.romInfo.saveTag)));
        this.rivetsData.noLocalState = !st;
        if (oldSt && !st) {
            const note = 'A saved state from the old emulator core exists for this game, but it cannot be loaded by the new core (mGBA). It was left untouched. Your battery save was carried over; make a new state with Save State.';
            this.rivetsData.legacyStateNote = note;
            this.rivetsData.legacyState = true;
            try { notify.warning(note, 15000); } catch (e) { }
        } else {
            this.rivetsData.legacyStateNote = '';
            this.rivetsData.legacyState = false;
        }
    }

    // ── RESET ─────────────────────────────────────────────────────────────────
    // A power-cycle: the cartridge's battery is untouched (it is saved memory), everything else starts over. Refused in a room for
    // the reason the other pages give: two machines that reset at different moments are no longer on the same frame.
    resetGame() {
        if (!this.core || !this.core.loaded || this.rivetsData.beforeEmulatorStarted) return;
        if (this.roomLocked) { notify.error('Not while you are in a room'); return; }
        this.core.reset();
        this._batLast = null; this._batDirtyFrames = 0;
        if (this.audioPipe) this.audioPipe.reset();
        if (this.audioSink) this.audioSink.clear();
        this._lastFrameTime = null;
        notify.info('Reset');
    }

    // ── DISPLAY ───────────────────────────────────────────────────────────────

    // Desktop: the stage (#canvasWrap) goes fullscreen and the canvas fits it. Phone: the whole #mobileShell does, because a
    // fullscreen element paints only its own subtree and every touch control would vanish with the canvas alone (gba.html's
    // spToggleFullscreen carries that history).
    fullscreen() {
        if (this.mobileMode && typeof spToggleFullscreen === 'function') { spToggleFullscreen(); return; }
        try {
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                return;
            }
            const el = $g('canvasWrap');
            const fn = el.requestFullscreen || el.webkitRequestFullscreen;
            if (!fn) { notify.error('Fullscreen is not available in this browser'); return; }
            const r = fn.call(el);
            if (r && r.catch) r.catch(() => notify.error('Fullscreen was refused'));
        } catch (e) { notify.error('Fullscreen is not available in this browser'); }
    }

    // A fresh page is the cleanest way to a fresh core; the battery is flushed first (bounded wait) so a save made a second ago
    // is not lost to the reload.
    newRom() {
        Promise.race([this._flushBattery(), new Promise((r) => setTimeout(r, 800))]).then(() => location.reload());
    }

    // The solo speed control (touch menu) is a convenience and a measurement arm, NEVER a way to a frame-rate number: it moves the
    // GUEST (CLAUDE.md gate 9). A room sets roomLocked and this refuses.
    setGameSpeed(speed) {
        const accepted = this._applySpeed(speed);
        this._syncUi();                                   // the menu's "Speed: Nx" label
        return accepted;
    }

    _applySpeed(speed) {
        if (this.roomLocked) { this.gameSpeed = 1; return false; }
        this.gameSpeed = speed;
        return true;
    }

    cycleSpeed() {
        const steps = [1, 2, 5];
        this.setGameSpeed(steps[(steps.indexOf(this.gameSpeed) + 1) % steps.length]);
    }

    hideMobileMenu() {
        if (this.mobileMode && typeof spCloseMenu === 'function') spCloseMenu();
    }

    // ── ROOMS: the seam gba.html's inline script drives (see ROOMS in the header) ─────────────────────────────────────────────

    // The solo core is closed while a room runs: it holds 192 MiB of fixed wasm heap and the room's machine needs its own. Anything the
    // solo game wrote to its battery is flushed FIRST (under that game's own key) - a player who opens a room mid-game keeps their
    // progress.
    async _closeSoloCore() {
        await this._flushBattery();
        this.isRunning = false;
        if (this.core) { try { this.core.close(); } catch (e) { } }
        this.core = null;
        this.isWasmReady = false;
        this.romInfo = null; this.idata = null;
        this._batPersisted = null; this._batLast = null; this._batDirtyFrames = 0; this._batBlocked = false;
        this._syncUi();
    }

    setRoomForming(on) {
        on = !!on;
        const el = $g('status'), cur = el ? el.textContent : '';
        if (on && !this.roomForming) {
            // cancel a solo ROM that is still arriving, and take its progress (or the stale "Pick a game and press Start") off the status bar
            this._soloLoadToken = (this._soloLoadToken | 0) + 1;
            if (/^Fetching /.test(cur) || /^Core ready\./.test(cur)) this.setStatus(ROOM_FORMING_STATUS);
        } else if (!on && this.roomForming && cur === ROOM_FORMING_STATUS) {
            // the room ended before any machine existed (endRoomToSolo, which restores the line itself, never ran)
            this.setStatus(this.isRunning ? 'Running — ' + this.rom_name : (this.isWasmReady ? 'Core ready. Pick a game and press Start.' : cur));
        }
        this.roomForming = on; this._syncUi();
    }

    // The room's machine exists and the lockstep barrier is (about to be) waiting on it: from here the room owns the loop.
    beginRoom(handle) {
        this.roomLocked = true;
        this.gameSpeed = 1;
        this.roomHandle = handle;
        this.rom_name = handle.romName || this.rom_name;
        this.frameCnt = 0; this.incidents = 0; this.idata = null; this._roomLostMs = 0;
        this._lastFrameTime = null; this._accum = 0; this._fps = null;
        if (this.audioPipe) this.audioPipe.reset();
        if (this.audioSink) this.audioSink.clear();
        this.rivetsData.noLocalState = true;
        this.rivetsData.legacyState = false;
        this.isRunning = true;
        this.rivetsData.beforeEmulatorStarted = false;      // → _syncUi(): Mute / Fullscreen light up, the solo-only controls stay down
        this._onStarted();
        this.setStatus('Room — ' + (handle.title || this.rom_name));
        this._syncUi();
    }

    // The room is over (clean end, leave, or the session closed): hand the page back to solo play. The Start button comes back when the
    // solo core has been re-created; nothing from the room's cores is kept.
    async endRoomToSolo() {
        this.roomHandle = null;
        this.roomLocked = false;
        this.gameSpeed = 1;
        this.isRunning = false;
        this._lastFrameTime = 0; this._accum = 0;
        this._fps = null; { const fp = $g('fps'); if (fp) fp.textContent = ''; }      // the room's last rate (a slow room's 0.36x) must not sit under "Core ready"
        this.rom_name = '';
        this.rivetsData.beforeEmulatorStarted = true;
        this.rivetsData.noLocalState = true;
        const shell = $g('mobileShell'); if (shell) shell.classList.remove('running');
        if (this.mobileMode) { const sp = $g('mobileSplash'); if (sp) sp.style.display = 'flex'; }
        this.setStatus('Loading core…');
        this._syncUi();
        if (!this.core) await this._bootCore();
    }

    // The room's clock. ONE accumulator against the wall, like _tick - but a frame runs only when the lockstep engine has every seat's
    // input for it. A refusal STALLS: it never spends its credit, and the credit is clamped to one frame afterwards, so the guest
    // resumes at 1.000x and can never sprint through a backlog (CLAUDE.md gate 9: slower is allowed, faster never).
    _roomTick(now) {
        const rh = this.roomHandle;
        const FRAME_MS = 1000 / GBA_HZ;
        if (!this._lastFrameTime) { this._lastFrameTime = now; this._accum = 0; return; }
        let delta = now - this._lastFrameTime;
        this._lastFrameTime = now;
        if (delta < 0) delta = 0;
        // Wall time past the credit cap is time this device's main thread was busy elsewhere (a long task, a collection): lost, without waiting.
        if (delta > ROOM_MAX_TICK_MS) { this._roomLostMs = (this._roomLostMs || 0) + (delta - ROOM_MAX_TICK_MS); delta = ROOM_MAX_TICK_MS; }
        this._accum += delta;
        const tick0 = performance.now();
        // Hidden catch-up frames the ENGINE grants (a returning page replaying the room it did not play, or one frame of phase). Each is
        // an ordinary frame - same step, same hashes - drawn to nobody. The engine bars them past this console's own wall clock.
        const rejoining = !!rh.rejoining();
        const owed = rh.catchUp(Math.floor(this._accum / FRAME_MS)) | 0;
        for (let i = 0; i < owed; i++) if (!rh.frame(true, !rejoining)) break;
        // The frames this tick may run: ROOM_MAX_FRAMES, or fewer when the room handle (gba.html) says this device's measured cost would hold the
        // main thread past the long-task line. It is clamped HERE to 1..ROOM_MAX_FRAMES, so no handle can raise the cap.
        let cap = ROOM_MAX_FRAMES;
        if (typeof rh.maxFrames === 'function' && this.roomTickPolicy !== 'fixed') { const c = rh.maxFrames() | 0; if (c >= 1 && c < cap) cap = c; }
        let ran = 0, waited = false;
        while (this._accum >= FRAME_MS && ran < cap) {
            if (!rh.frame(false, true)) { waited = true; break; }
            this._accum -= FRAME_MS;
            ran++;
        }
        // A wait (or a late tick) is time that did not happen for the guest: it is not banked. Credit left over because the loop stopped at its
        // cap (not because a seat or the journal held the frame) is time this device could not spend: counted as lost, never repaid.
        if (this._accum > FRAME_MS) { if (!waited) this._roomLostMs = (this._roomLostMs || 0) + (this._accum - FRAME_MS); this._accum = FRAME_MS; }
        let presentMs = 0;
        if (ran && !rejoining) { const p0 = performance.now(); this._present(); presentMs = performance.now() - p0; }
        if (typeof rh.tickDone === 'function') rh.tickDone({ ran: rejoining ? 0 : ran, presentMs, waited, cap, tickMs: performance.now() - tick0, lostMs: this._roomLostMs || 0 });
        this._fpsTick(now);
    }

    // ── MOBILE ────────────────────────────────────────────────────────────────

    _setupMobileMode() {
        // Hand the page to the GBA SP shell, behind the splash. The splash is removed when a game starts (see _onStarted).
        if (typeof spActivate === 'function') spActivate();
        const sp = $g('mobileSplash'); if (sp) sp.style.display = 'flex';
        window.addEventListener('resize', () => this._checkOrientation());
        window.addEventListener('orientationchange', () => this._checkOrientation());
        this._checkOrientation();
    }

    // [portrait-gate FIX 2026-09-08, as on every other page] The hint is a NON-BLOCKING pill (pointer-events: none) that retires
    // itself after a few seconds; rotating back to landscape re-arms it for the next portrait.
    _checkOrientation() {
        if (!this.mobileMode) return;
        const landscape = window.innerWidth > window.innerHeight;
        if (landscape) this._rotRetired = false;
        const show = this.isRunning && !landscape && !this._rotRetired;
        const h = $g('rotateHint');
        if (h) h.style.display = show ? 'flex' : 'none';
        if (show && !this._rotTimer) {
            this._rotTimer = setTimeout(() => { this._rotTimer = 0; this._rotRetired = true; this._checkOrientation(); }, 5000);
        } else if (!show && this._rotTimer) { clearTimeout(this._rotTimer); this._rotTimer = 0; }
    }

    detectMobile() {
        const ua = navigator.userAgent.toLowerCase();
        this.iosMode = ua.includes('iphone') || ua.includes('ipad');
        const force = new URLSearchParams(location.search).has('mobile');
        // Was: `window.innerWidth < 600 || ua.includes('iphone')`.
        // MEASURED 2026-09-01 with a Pixel 8 UA: portrait (412x915) gave mobileMode=true, but LANDSCAPE (915x412) gave
        // mobileMode=false, spShell display:none, the canvas left in #canvasDiv and #mobileA with a zero-width rect — i.e. an
        // Android visitor who turns the phone sideways (the natural way to hold a GBA) got the desktop UI with no touch controls
        // and no keyboard. Only iPhone survived, and only because of the UA substring.
        // Fix: decide from the SHORT edge, which does not change on rotation, and from a real touch capability rather than a
        // width guess — so this is evaluated once and stays correct through every orientation change.
        const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
        // A CONSOLE IS NOT A TOUCH DEVICE (genesis.html's isMobile, snes.html:255): a gamepad-only Xbox must get the desktop page.
        if (/\bxbox\b|\bplaystation\b|\bnintendo\b/.test(ua) && !touch) { this.mobileMode = force; return; }
        const uaMobile = /iphone|ipad|ipod|android|mobile/.test(ua);
        this.mobileMode = uaMobile || (touch && Math.min(window.innerWidth, window.innerHeight) < 600) || force;
    }

    // ── INPUT CONTROLLER ──────────────────────────────────────────────────────

    setupInputController() {
        this.rivetsData.inputController = new InputController();
        try {
            const saved = localStorage.getItem(MAPPINGS_LS_KEY);
            if (saved) {
                const obj = JSON.parse(saved);
                for (const [k, v] of Object.entries(obj)) {
                    if (k in this.rivetsData.inputController.KeyMappings)
                        this.rivetsData.inputController.KeyMappings[k] = v;
                }
            }
        } catch (e) { }
    }

    // ── REMAP (the n64 page's dialog: #remapPanel > #remapBox) ────────────────

    _fmtKey(v) { return v === ' ' ? 'Space' : String(v); }
    _fmtJoy(v) { return v === -1 || v === '-1' || v == null ? '—' : 'Btn ' + v; }

    _renderRemapRows() {
        const box = $g('remapRows'); if (!box) return;
        box.textContent = '';
        REMAP_ACTIONS.forEach((a) => {
            const row = document.createElement('div'); row.className = 'remapRow';
            const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = a.label; row.appendChild(lbl);
            const kb = document.createElement('button'); kb.type = 'button'; kb.textContent = this._fmtKey(this._remapState[a.key]);
            kb.setAttribute('data-remap', a.key);
            kb.addEventListener('click', () => this._captureKey(a.key, kb));
            row.appendChild(kb);
            const jb = document.createElement('button'); jb.type = 'button'; jb.textContent = this._fmtJoy(this._remapState[a.joy]);
            jb.setAttribute('data-remap', a.joy);
            jb.addEventListener('click', () => this._captureJoy(a.joy, jb));
            row.appendChild(jb);
            box.appendChild(row);
        });
    }

    _stopCapture() {
        if (this._captureCancel) { this._captureCancel(); this._captureCancel = null; }
        const h = $g('remapHint'); if (h) h.textContent = REMAP_HINT;
    }

    _captureKey(field, btn) {
        this._stopCapture();
        btn.classList.add('capturing'); btn.textContent = '…';
        $g('remapHint').textContent = 'Press a key (Esc cancels).';
        const state = this._remapState;
        // Window + capture phase + stopImmediatePropagation: the keystroke belongs to the dialog, and InputController's document-level
        // handler must not also see it and press a game button.
        const onKey = (e) => {
            e.preventDefault(); e.stopImmediatePropagation();
            if (e.key !== 'Escape') state[field] = (e.key.length === 1 ? e.key.toLowerCase() : e.key);
            cleanup();
        };
        const cleanup = () => {
            window.removeEventListener('keydown', onKey, true);
            btn.classList.remove('capturing'); btn.textContent = this._fmtKey(state[field]);
            $g('remapHint').textContent = REMAP_HINT; this._captureCancel = null;
        };
        window.addEventListener('keydown', onKey, true);
        this._captureCancel = cleanup;
    }

    _captureJoy(field, btn) {
        this._stopCapture();
        btn.classList.add('capturing'); btn.textContent = '…';
        $g('remapHint').textContent = 'Press a controller button (or wait to cancel).';
        const state = this._remapState;
        const baseline = {};
        Array.from((navigator.getGamepads && navigator.getGamepads()) || []).forEach((gp) => { if (gp) (gp.buttons || []).forEach((b, i) => { if (b && b.pressed) baseline[gp.index + ':' + i] = true; }); });
        const deadline = Date.now() + 10000;
        const cleanup = () => { clearInterval(iv); btn.classList.remove('capturing'); btn.textContent = this._fmtJoy(state[field]); $g('remapHint').textContent = REMAP_HINT; this._captureCancel = null; };
        const iv = setInterval(() => {
            if (Date.now() > deadline) { cleanup(); return; }
            const pads = Array.from((navigator.getGamepads && navigator.getGamepads()) || []);
            for (let p = 0; p < pads.length; p++) {
                const gp = pads[p]; if (!gp) continue;
                const btns = gp.buttons || [];
                for (let i = 0; i < btns.length; i++) {
                    if (btns[i] && btns[i].pressed && !baseline[gp.index + ':' + i]) { state[field] = i; cleanup(); return; }
                }
            }
        }, 50);
        this._captureCancel = cleanup;
    }

    openRemap() {
        if (!this.rivetsData.inputController) return;
        this._remapState = Object.assign({}, this.rivetsData.inputController.KeyMappings);
        this._renderRemapRows();
        $g('remapPanel').classList.add('open');
        this.hideMobileMenu();
    }

    closeRemap() { this._stopCapture(); $g('remapPanel').classList.remove('open'); }

    saveRemap() {
        this._stopCapture();
        const ic = this.rivetsData.inputController;
        for (const k in this._remapState) { if (k in ic.KeyMappings) ic.KeyMappings[k] = this._remapState[k]; }
        try { localStorage.setItem(MAPPINGS_LS_KEY, JSON.stringify(ic.KeyMappings)); } catch (e) { }
        this._renderKeyHelp();
        notify.info('Mappings saved');                   // the controller reads KeyMappings live: no restart needed
        this.closeRemap();
    }

    // The keyboard line under the picture, built from the mappings in force (so it follows a remap).
    _renderKeyHelp() {
        const el = $g('keyHelp'), ic = this.rivetsData && this.rivetsData.inputController;
        if (!el || !ic) return;
        const km = ic.KeyMappings, k = (n) => '<b>' + escapeHtml(this._fmtKey(km[n])) + '</b>';
        const arrows = km.Mapping_Up === 'ArrowUp' && km.Mapping_Down === 'ArrowDown' && km.Mapping_Left === 'ArrowLeft' && km.Mapping_Right === 'ArrowRight';
        const dpad = arrows ? '<b>arrows</b>' : [km.Mapping_Up, km.Mapping_Down, km.Mapping_Left, km.Mapping_Right].map((v) => '<b>' + escapeHtml(this._fmtKey(v)) + '</b>').join(' ');
        el.innerHTML = 'Keyboard — D-pad ' + dpad + ' · ' + k('Mapping_Action_A') + ' A · ' + k('Mapping_Action_B') + ' B · ' + k('Mapping_Action_L') + ' L · '
            + k('Mapping_Action_R') + ' R · ' + k('Mapping_Action_Start') + ' Start · ' + k('Mapping_Action_Select') + ' Select. A gamepad works too. '
            + 'Drop a <b>.gba</b> file on the picture to play your own.';
    }
}

var myClass = new MyClass();
var myApp = myClass;
