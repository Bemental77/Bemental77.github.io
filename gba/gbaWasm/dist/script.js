// ─── GBA Emulator — 44vba WASM Integration ───────────────────────────────────
// Source: github.com/44670/44vba
//
// Exported C functions (called as Module._<name>):
//   emuGetSymbol(id)          1=ROM buf ptr, 2=SRAM ptr, 3=framebuffer ptr, 4=general buf
//   emuLoadROM(romSize)       init emulator with ROM already written into HEAPU8
//   emuRunFrame(keyMask)      advance one frame; key bits: A,B,Sel,Start,Rt,Lt,Up,Dn,R,L
//   emuResetCpu()             reset CPU (call after loading SRAM)
//   emuUpdateSavChangeFlag()  returns 1 if SRAM changed since last call, 0 otherwise
//   emuAddCheat(ptr)          add GameShark/CodeBreaker cheat line from string in HEAPU8
//
// WASM → JS callbacks (must be on window):
//   window.wasmReady()        called by WASM main() once init is complete
//   window.writeAudio(ptr,n)  called by WASM each time new audio samples are ready

// THE GUEST'S AUDIO RATE, MEASURED, NOT ASSUMED. 44vba hands writeAudio()
// 801.6 stereo frames per emulated frame on average (Sonic Advance 3, 596
// frames, 2026-10-01), i.e. 47,878 per GUEST second at 59.7275 Hz — not the
// 48,000 the old ScriptProcessor consumed. Playing 47,878/s at 48,000/s ran
// the sink 0.25% faster than the guest could ever feed it, so even a perfect
// 1.000x guest drained the FIFO and underran on a schedule. lib/cart_audio.js
// resamples by this one fixed ratio: exact pitch, no rate steering.
const GBA_HZ = 59.7275;
const GBA_SRC_RATE = 801.6 * GBA_HZ;
const WASM_SAVE_LEN = 0x22000; // libretro_save_buf size (0x20000 + 0x2000)

// GBA key bitmask — order matches 44vba keyList: ["a","b","select","start","right","left","up","down","r","l"]
const GBA_KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };

class MyClass {
    constructor() {
        this.rom_name = '';
        this.mobileMode = false;
        this.iosMode = false;
        this.dblist = [];

        // 44vba runtime state
        this.romBufferPtr = -1;
        this.wasmSaveBuf = null;
        this.idata = null;
        this.drawContext = null;
        this.isRunning = false;
        this.isWasmReady = false;
        this.gameSpeed = 1;
        this.frameCnt = 0;
        this.lastSaveFlag = 0;
        this.wasmAudioBuf = null;

        // Audio: an AudioWorklet sink (lib/cart_audio.js). The samples are
        // PUSHED from writeAudio(), off the main thread's critical path.
        this.audioContext = null;
        this.audioSink = null;

        // Expose the two callbacks the WASM binary calls into
        window['wasmReady'] = this.onWasmReady.bind(this);
        window['writeAudio'] = this.writeAudio.bind(this);

        // Tell Emscripten where to find the .wasm file
        // (needed because 44gba.js is dynamically inserted into <head>)
        window['Module'] = {
            locateFile: (path) => '/gba/gbaWasm/dist/' + path
        };

        this.rivetsData = {
            beforeEmulatorStarted: true,
            moduleInitializing: true,
            hasRoms: false,
            romList: [],
            noLocalSave: true,
            // Separate from noLocalSave on purpose: noLocalSave tracks the SRAM
            // battery file, this tracks a SAVE STATE. They are different keys and
            // the Load State button must gate on THIS one — see _findInDatabase.
            noLocalState: true,
            lblError: '',
            remappings: null,
            remapMode: '',
            currKey: 0,
            currJoy: 0,
            remapPlayer1: true,
            remapOptions: false,
            remapWait: false,
            inputController: null,
            hadNipple: false,
            canvasSize: 480,
            settings: { CLOUDSAVEURL: '', SHOWADVANCED: false }
        };

        this.rivetsData.settings = window['GBAWASMETTINGS'];

        if (window['ROMLIST'] && window['ROMLIST'].length > 0) {
            this.rivetsData.hasRoms = true;
            window['ROMLIST'].forEach(r => this.rivetsData.romList.push(r));
        }

        rivets.formatters.ev = (v, a) => eval(v + a);
        rivets.formatters.ev_string = (v, a) => eval("'" + v + "'" + a);

        rivets.bind(document.getElementById('topPanel'), { data: this.rivetsData });
        rivets.bind(document.getElementById('bottomPanel'), { data: this.rivetsData });
        rivets.bind(document.getElementById('buttonsModal'), { data: this.rivetsData });
        rivets.bind(document.getElementById('lblError'), { data: this.rivetsData });

        document.getElementById('file-upload').addEventListener('change', this.uploadRom.bind(this));

        this.setupDragDropRom();
        this.detectMobile();
        this.createDB();

        // rAF loop runs even before a ROM is loaded; frames only execute once isRunning=true
        this._boundLoop = this._emuLoop.bind(this);
        window.requestAnimationFrame(this._boundLoop);
        this._boundTimer = this._timerLoop.bind(this);
        setTimeout(this._boundTimer, 16);

        const _fsChange = this._onFullscreenChange.bind(this);
        document.addEventListener('fullscreenchange', _fsChange);
        document.addEventListener('webkitfullscreenchange', _fsChange);
        document.addEventListener('mozfullscreenchange', _fsChange);

        $('#topPanel').show();
        $('#lblErrorOuter').show();
    }

    // ── WASM CALLBACKS ────────────────────────────────────────────────────────

    onWasmReady() {
        // 44gba WASM main() calls window.wasmReady() once the module is fully initialised
        this.romBufferPtr = Module._emuGetSymbol(1);

        this.savPtr = Module._emuGetSymbol(2);

        const fbPtr = Module._emuGetSymbol(3);
        const canvas = document.getElementById('canvas');
        canvas.width = 240;
        canvas.height = 160;
        this.drawContext = canvas.getContext('2d');
        // ImageData views WASM memory directly — safe because TOTAL_MEMORY is fixed at 128 MB
        this.idata = new ImageData(
            new Uint8ClampedArray(Module.HEAPU8.buffer).subarray(fbPtr, fbPtr + 240 * 160 * 4),
            240, 160
        );

        this.isWasmReady = true;
        this.rivetsData.moduleInitializing = false;
        console.log('44vba WASM ready');
        if (typeof spScaleCanvas === 'function') spScaleCanvas();
    }

    writeAudio(ptr, frames) {
        // Called by WASM systemOnWriteDataToSoundBuffer with a pointer into HEAPU8.
        const d = window.__audioDiag;
        if (this.gameSpeed > 1) return; // mute audio during fast-forward (deliberate)

        // HEAP VIEW: re-derive whenever the pointer moves OR the backing buffer
        // is replaced. The old code cached this view exactly once, forever, with
        // a hardcoded 2048-entry length. Two ways that goes wrong, and both are
        // silent:
        //   * Emscripten memory growth ALLOCATES A NEW ArrayBuffer and detaches
        //     the old one. A cached Int16Array over the detached buffer reads as
        //     length 0, so every subsequent batch would copy nothing — audio just
        //     stops, with no error anywhere.
        //   * The view was 2048 int16 entries = 1024 STEREO FRAMES, but the loop
        //     below indexes up to `frames*2`. Any batch above 1024 frames read
        //     past the end of the view and yielded `undefined`, which stores as 0
        //     — i.e. a burst of silence in the middle of the batch.
        // Re-deriving costs one subarray() per batch (~a few dozen per second).
        const need = frames * 2;
        if (!this.wasmAudioBuf
            || this.wasmAudioBuf.buffer !== Module.HEAPU8.buffer
            || this.wasmAudioPtr !== ptr
            || this.wasmAudioBuf.length < need) {
            this.wasmAudioBuf = new Int16Array(Module.HEAPU8.buffer).subarray(ptr >> 1, (ptr >> 1) + need);
            this.wasmAudioPtr = ptr;
        }

        // PUSH, don't buffer here. The old path copied into a 4,900-frame
        // (~100 ms) main-thread FIFO drained by a ScriptProcessor whose
        // onaudioprocess also ran on the main thread, so any emulation frame,
        // paint or touch handler longer than the slack starved the device —
        // and the FIFO dropped whole batches when it filled. The worklet holds
        // the cushion on the audio thread and counts every gap it plays.
        // Gate #9: nothing here feeds back into _emuLoop's timing.
        if (this.audioSink) this.audioSink.pushInt16(this.wasmAudioBuf, frames);
        else if (d) { d.framesProduced += frames; d.droppedFrames = (d.droppedFrames || 0) + frames; d.batchesDropped++; }
    }

    // ── AUDIO ─────────────────────────────────────────────────────────────────

    tryInitSound() {
        if (this.audioContext) {
            if (this.audioContext.state !== 'running') this.audioContext.resume();
            return;
        }
        try {
            // 'playback' tells the browser to prefer glitch-free output over low latency.
            // This is better for games than the near-zero latencyHint which caused
            // the ScriptProcessor to compete with touch events on mobile.
            this.audioContext = new AudioContext({ latencyHint: 'playback', sampleRate: 48000 });
            if (window.AudioDiag) {
                window.AudioDiag.install('gba', { ctxRate: this.audioContext.sampleRate, srcRate: GBA_SRC_RATE });
                window.AudioDiag.observeContext(this.audioContext);
            }
            this.audioSink = window.CartAudio
                ? window.CartAudio.create(this.audioContext, { srcRate: GBA_SRC_RATE, targetMs: 80, maxMs: 400, page: 'gba' })
                : null;
            this.audioContext.resume();
        } catch (e) { console.log('Audio init failed:', e); }
    }

    // ── GAME LOOP ─────────────────────────────────────────────────────────────

    // THE GUEST CLOCK IS NOT THE DISPLAY'S. This loop used to run frames only
    // from requestAnimationFrame, so the guest could advance only when the
    // compositor produced a frame — and a phone's compositor does not promise
    // 60 Hz: low-power mode runs rAF at 30, a busy GPU or a throttled tab
    // delivers ticks 60-100 ms apart, and every tick past the 50 ms clamp
    // silently dropped the rest of its time. Measured on the mobile profile
    // (tools/netplay_device_matrix.mjs, 2026-10-01): rAF at 10-38/s, guest
    // 0.79x. Now a timer, woken when the next frame is due, keeps the guest on
    // the wall clock whenever the CPU has room, and rAF still drives it when
    // rAF is the faster of the two. Both feed ONE accumulator against
    // performance.now(), so the second caller in a frame period finds no
    // credit and does nothing: the guest still runs at exactly 1.000x and
    // never faster (gate #9) — a late tick's debt is dropped, never repaid.
    _emuLoop() {
        window.requestAnimationFrame(this._boundLoop)
        this._tick(performance.now())
    }

    _timerLoop() {
        this._tick(performance.now())
        const FRAME_MS = 1000 / GBA_HZ
        const wait = this.isRunning ? Math.max(1, FRAME_MS - (this._accum || 0)) : 50
        setTimeout(this._boundTimer, wait)
    }

    _tick(now) {
        if (!this.isRunning) { this._lastFrameTime = 0; return }

        const GBA_FRAME_MS = 1000 / GBA_HZ

        if (!this._lastFrameTime) {
            this._lastFrameTime = now
            this._accum = 0
            return
        }

        let delta = now - this._lastFrameTime
        this._lastFrameTime = now
        if (delta < 0) delta = 0

        // Same policy as snes.html / genesis.html: a long stall must not
        // fast-forward the guest, and no debt survives the tick.
        if (delta > 100) delta = 100

        this._accum += delta

        // At most three frames in one task. Four (snes/genesis's cap) measured
        // 90.8 long tasks/min here on the mobile profile against 0 for three,
        // because one GBA frame there costs ~15 ms: a fourth frame pushes the
        // task past 50 ms, and a touch that lands behind it waits.
        const MAX_FRAMES = 3

        let frames = 0

        while (this._accum >= GBA_FRAME_MS && frames < MAX_FRAMES) {
            for (let i = 0; i < this.gameSpeed; i++) {
                this._runFrame(false)
            }
            this._accum -= GBA_FRAME_MS
            frames++
        }
        if (this._accum > GBA_FRAME_MS) this._accum = GBA_FRAME_MS

        // One present per tick, however many frames ran (the old loop also
        // drew inside every _runFrame: up to four putImageData per tick).
        if (frames) {
            this.drawContext.putImageData(this.idata, 0, 0)
        }
    }

    _runFrame(draw = true) {
        if (!this.isRunning || !this.isWasmReady) return;
        this.frameCnt++;
        if (this.frameCnt % 60 === 0) this._checkAutoSave();
        Module._emuRunFrame(this._getKeyMask());
        if (draw) this.drawContext.putImageData(this.idata, 0, 0);
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
        this.tryInitSound();
        document.getElementById('file-upload').click();
    }

    uploadRom(event) {
        const file = event.currentTarget.files[0];
        myClass.rom_name = file.name;
        const r = new FileReader();
        r.onload = (e) => myClass._loadRomArrayBuffer(e.target.result);
        r.readAsArrayBuffer(file);
    }

    async loadRom() {
        const url = document.getElementById('romselect')['value'];
        this.rom_name = this._extractRomName(url);
        this.tryInitSound();
        try {
            const resp = await fetch(url);
            const ab = await resp.arrayBuffer();
            this._loadRomArrayBuffer(ab);
        } catch (e) { toastr.error('Failed to load ROM: ' + e); }
    }

    _loadRomArrayBuffer(arrayBuffer) {
        if (!this.isWasmReady) { toastr.error('Emulator not ready yet.'); return; }
        const u8 = new Uint8Array(arrayBuffer);

        // Validate GBA logo checksum byte
        if (u8[0xB2] !== 0x96) { toastr.error('Not a valid GBA ROM.'); return; }

        this.isRunning = false;

        // Copy ROM bytes directly into WASM memory at the ROM buffer address
        Module.HEAPU8.set(u8, this.romBufferPtr);
        this.romSize = u8.length;
        Module._emuLoadROM(this.romSize);

        // Override save type based on ROM game code (bytes 0xAC–0xAF).
        // emuLoadROM hard-resets flashSize to 64K; re-apply the correct size now.
        const gameCode = String.fromCharCode(u8[0xAC], u8[0xAD], u8[0xAE], u8[0xAF]);
        const flash128kGames = ['BPRE', 'BPGE', 'BPEE', 'PUVV']; // FireRed, LeafGreen, Emerald, Ultra Violet
        if (flash128kGames.indexOf(gameCode) !== -1) {
            Module._emuSetSaveType(3, 0x20000); // Flash 128K
            console.log('Save type: Flash 128K for game code', gameCode);
        }

        // Restore saved SRAM, then start
        this._loadSave((found) => {
            if (found) console.log('SRAM restored for', this.rom_name);
            Module._emuResetCpu();
            this._clearSaveBufState();
            this._findInDatabase();
            this._configureEmulator();
            $('#canvasDiv').show();
            this.rivetsData.beforeEmulatorStarted = false;
            this._lastFrameTime = null; // reset fixed-timestep clock for new ROM
            this.isRunning = true;
        });
    }

    _extractRomName(name) {
        return name.includes('/') ? name.substr(name.lastIndexOf('/') + 1) : name;
    }

    setupDragDropRom() {
        const d = document.getElementById('dropArea');
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev =>
            d.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); })
        );
        d.addEventListener('dragenter', () => $('#dropArea').css({ 'background-color': 'lightblue' }));
        d.addEventListener('dragleave', () => $('#dropArea').css({ 'background-color': 'inherit' }));
        d.addEventListener('drop', (e) => {
            const file = e.dataTransfer.files[0];
            myClass.rom_name = file.name;
            const r = new FileReader();
            r.onload = (ev) => myClass._loadRomArrayBuffer(ev.target.result);
            r.readAsArrayBuffer(file);
        });
    }

    // ── SAVE / LOAD (SRAM-based) ───────────────────────────────────────────────

    // Always re-derive the save buffer view — guards against stale subarray if
    // Emscripten ever reallocates HEAPU8 (fixed-size build, but still safer).
    _getSaveBuf() {
        return Module.HEAPU8.subarray(this.savPtr, this.savPtr + WASM_SAVE_LEN);
    }

    // Guards against empty rom_name writing to the '.sav' catch-all slot.
    _getSaveKey() {
        return this.rom_name ? this.rom_name + '.sav' : null;
    }

    _persistSave() {
        const key = this._getSaveKey();
        if (!key) return;
        const snap = new Uint8Array(WASM_SAVE_LEN);
        snap.set(this._getSaveBuf());
        this._putDB(key, snap,
            () => { this.rivetsData.noLocalSave = false; },
            () => { }
        );
    }

    _checkAutoSave() {
        if (!this.isRunning) return;
        const changed = Module._emuUpdateSavChangeFlag();

        // Primary trigger: SRAM stopped changing after a write (falling edge)
        if (this.lastSaveFlag === 1 && changed === 0) {
            this._persistSave();
        }
        this.lastSaveFlag = changed;

        // Fallback: periodic save every ~60 s so short sessions aren't lost
        this._periodicSaveCnt = (this._periodicSaveCnt || 0) + 1;
        if (this._periodicSaveCnt >= 3600) {
            this._periodicSaveCnt = 0;
            if (changed === 0) this._persistSave();
        }
    }

    // ── HEAP SNAPSHOT SAVE STATES ─────────────────────────────────────────────
    // 44vba exposes no serialize/deserialize API. Instead we snapshot the full
    // 128 MB WASM heap (fixed size, no growth). Most pages are zero so gzip
    // compresses it to ~3-8 MB. Because HEAPU8 is a view of a fixed ArrayBuffer,
    // Module.HEAPU8.set() restores state in-place and all existing typed-array
    // views (idata, saveBuf, etc.) remain valid — no re-init needed.

    // ── STREAMING HEAP <-> GZIP ───────────────────────────────────────────────
    // These stream in SLICES so a save/restore never materialises a second copy
    // of the 128 MB heap. Measured on desktop Chrome (tools/gba_state_persist_test.mjs),
    // renderer RSS with a ROM running is already ~450 MB, and the old whole-buffer
    // versions added a peak of +133 MB on save and +305 MB on restore — restore
    // accumulated every decompressed chunk AND then copied the lot again through
    // `new Blob(chunks).arrayBuffer()` before touching the heap. On a console-class
    // memory budget that is the difference between working and dying.
    //
    // The reader is started BEFORE the writes and drained concurrently: writing a
    // whole stream before reading it just moves the accumulation into the stream's
    // internal queue, which is the same allocation with a different owner.
    static get _SLICE() { return 4 << 20; }   // 4 MB

    // The ROM's byte range inside the heap, or an empty range when no ROM is loaded.
    //
    // WHY THE ROM IS EXCLUDED FROM A SAVE STATE: it dominated the file. Measured on
    // Kirby (8 MB ROM), the whole 128 MB heap gzipped to 4,972,418 B while the ROM
    // ALONE gzips to 4,728,261 B — 95.1% of the state was a second copy of a file the
    // page re-fetches on every load. The 16 MB ROMs in the list would have paid ~10 MB
    // per state. On a console-class storage budget that is what gets refused or evicted.
    //
    // Skipping the range on restore (rather than re-injecting the ROM) is what makes
    // this compatible in BOTH directions: a state written before this change still
    // holds the real ROM bytes there, and those are by definition the same bytes the
    // page has already loaded, so declining to write them changes nothing.
    _romWindow() {
        const base = this.romBufferPtr, size = this.romSize;
        if (!(base >= 0) || !(size > 0)) return [0, 0];
        return [base, Math.min(base + size, Module.HEAPU8.byteLength)];
    }

    // Compress Module.HEAPU8 straight out of the wasm heap. The caller must have
    // PAUSED the emulator loop: slices are read over time, so a running game would
    // tear the snapshot across them.
    async _compressHeapLive() {
        const cs = new CompressionStream('gzip');
        const chunks = [];
        let total = 0;
        const drain = (async () => {
            const reader = cs.readable.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value); total += value.length;
            }
        })();
        const writer = cs.writable.getWriter();
        const len = Module.HEAPU8.byteLength;
        const [rs, re] = this._romWindow();
        let scratch = null;
        for (let off = 0; off < len; off += MyClass._SLICE) {
            await writer.ready;
            const end = Math.min(off + MyClass._SLICE, len);
            // Re-derive the view each slice: cheap, and correct even if the heap
            // is ever reallocated under us.
            if (re <= off || rs >= end) {
                await writer.write(Module.HEAPU8.subarray(off, end));   // no ROM here: zero-copy
            } else {
                // This slice overlaps the ROM. Write zeros there instead of the ROM
                // bytes — gzip collapses a zero run to almost nothing, and the ROM is
                // re-supplied from the page on restore. Only the 2-4 slices that
                // actually straddle the ROM pay for this copy.
                if (!scratch) scratch = new Uint8Array(MyClass._SLICE);
                const n = end - off;
                const view = scratch.subarray(0, n);
                view.set(Module.HEAPU8.subarray(off, end));
                view.fill(0, Math.max(rs, off) - off, Math.min(re, end) - off);
                await writer.write(view);
            }
        }
        await writer.close();
        await drain;
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        return out;
    }

    // Decompress straight INTO the wasm heap. Peak extra memory is one gzip output
    // chunk, not another 128 MB.
    // ⚠ Deliberate trade: this writes as it decodes, so a stream that fails PART WAY
    // leaves the heap half-overwritten. The old whole-buffer version could not corrupt
    // the heap that way — but it is also the version that could not run at all on a
    // memory-constrained device. gzip's CRC is checked at close(), so a truncated or
    // corrupt state throws after the writes; the caller must treat a throw here as
    // "this session is gone, reload the ROM", which is what restoreFailed does.
    async _decompressIntoHeap(compressed) {
        const ds = new DecompressionStream('gzip');
        const heap = Module.HEAPU8;
        let off = 0;
        const drain = (async () => {
            const reader = ds.readable.getReader();
            const [rs, re] = this._romWindow();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                const end = off + value.length;
                if (end > heap.length)
                    throw new Error('save state is larger than the heap (' + end + ' > ' + heap.length + ')');
                if (re <= off || rs >= end) {
                    heap.set(value, off);
                } else {
                    // Do not overwrite the ROM. Whatever the state holds there is either
                    // zeros (states written by this build) or an identical copy of the ROM
                    // (states written before it) — in both cases the ROM the page just
                    // loaded is the correct bytes, so skipping the range is right for old
                    // and new states alike.
                    if (rs > off) heap.set(value.subarray(0, rs - off), off);
                    if (re < end) heap.set(value.subarray(re - off), re);
                }
                off = end;
            }
        })();
        const writer = ds.writable.getWriter();
        await writer.write(compressed);
        await writer.close();
        await drain;
        if (off !== heap.length)
            throw new Error('save state size mismatch (' + off + ' != ' + heap.length + ')');
        return off;
    }

    // Ask for storage that the browser will not evict under pressure. Without this
    // the origin is "best-effort" and a multi-MB state is exactly what gets reclaimed
    // first on a device with a small storage budget — which reads to the visitor as
    // "my save state vanished after a refresh". Chromium grants this on engagement
    // without prompting; a refusal is not fatal, so this never blocks a save.
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

    async saveStateLocal() {
        if (!this.isRunning) { toastr.error('No game running.'); return; }
        const key = this._getSaveKey();
        if (!key) { toastr.error('No ROM loaded.'); return; }
        toastr.info('Saving state…');
        // PAUSE while the heap is walked. The old code copied all 128 MB in one
        // synchronous set() so it could snapshot under a running loop; streaming
        // reads the heap over several turns instead, so the loop has to hold still
        // or the state tears across slices. A save is a moment of pause anyway.
        const wasRunning = this.isRunning;
        this.isRunning = false;
        let compressed;
        try {
            compressed = await this._compressHeapLive();
        } catch (e) {
            this.isRunning = wasRunning;
            toastr.error('State save error: ' + e.message);
            return;
        }
        this.isRunning = wasRunning;
        await this._requestPersistentStorage();
        this._putDB(key + '.state', compressed,
            () => {
                this.rivetsData.noLocalSave = false;
                this.rivetsData.noLocalState = false;
                toastr.info('State saved (' + (compressed.byteLength / 1024 / 1024).toFixed(1) + ' MB).');
            },
            // A put can fail for a reason the visitor can act on (out of storage),
            // so say which rather than a bare 'failed'.
            (ev) => {
                const err = ev && ev.target && ev.target.error;
                const nm = err && err.name ? err.name : 'unknown error';
                toastr.error(nm === 'QuotaExceededError'
                    ? 'State save failed — out of browser storage on this device.'
                    : 'State save failed (' + nm + ').');
            }
        );
    }

    async loadStateLocal() {
        const key = this._getSaveKey();
        if (!key) { toastr.error('No ROM loaded.'); return; }
        this._getDB(key + '.state', async (data) => {
            toastr.info('Restoring state…');
            try {
                this.isRunning = false;
                const compressed = data instanceof Uint8Array ? data : new Uint8Array(data);
                // Decompresses IN PLACE into the heap — typed-array views stay valid.
                await this._decompressIntoHeap(compressed);
                this.isRunning = true;
                toastr.info('State restored.');
            } catch (e) {
                // The heap may be partially overwritten — see _decompressIntoHeap.
                // Stay stopped and say so plainly rather than run a corrupt machine.
                this.isRunning = false;
                toastr.error('State restore failed — load the ROM again. (' + e.message + ')');
            }
        }, () => toastr.error('No save state found for this ROM.'));
    }

    // ── EXPORT / IMPORT A SAVE STATE ──────────────────────────────────────────
    // A state that only exists inside one browser's IndexedDB is one cleared
    // site-data away from gone, and cannot move to another device. gamecube.html
    // and dreamcast.html have had Export/Import for a while; this is the same
    // capability for the GBA. The exported file is EXACTLY the bytes stored —
    // the gzip stream written by _compressHeapLive — so an export re-imports
    // byte-for-byte with no re-encoding step to get wrong.
    async exportStateLocal() {
        const key = this._getSaveKey();
        if (!key) { toastr.error('No ROM loaded.'); return; }
        this._getDB(key + '.state', (data) => {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            if (!bytes.byteLength) { toastr.error('Saved state is empty.'); return; }
            const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
            const a = document.createElement('a');
            // Name it after the ROM so a folder of exports stays sortable, and keep
            // the .gz so the file's own type is honest about its contents.
            a.href = url; a.download = key + '.state.gz';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            toastr.info('Exported ' + (bytes.byteLength / 1048576).toFixed(2) + ' MB.');
        }, () => toastr.error('No save state to export — press Save State first.'));
    }

    importStateLocal() {
        const key = this._getSaveKey();
        if (!key) { toastr.error('Load a ROM first, then import.'); return; }
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.gz,.state,application/octet-stream';
        inp.addEventListener('change', async () => {
            const f = inp.files && inp.files[0];
            if (!f) return;
            try {
                const buf = new Uint8Array(await f.arrayBuffer());
                // Validate before storing: a gzip stream starts 1f 8b. Writing an
                // unreadable blob over a good state would destroy the thing the
                // visitor was trying to protect.
                if (buf.length < 3 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
                    toastr.error('That file is not a GBA save state (no gzip header).');
                    return;
                }
                this._putDB(key + '.state', buf,
                    () => {
                        this.rivetsData.noLocalState = false;
                        toastr.info('Imported ' + (buf.byteLength / 1048576).toFixed(2) +
                                    ' MB — press Load State to apply it.');
                    },
                    (ev) => {
                        const err = ev && ev.target && ev.target.error;
                        const nm = err && err.name ? err.name : 'unknown error';
                        toastr.error(nm === 'QuotaExceededError'
                            ? 'Import failed — out of browser storage on this device.'
                            : 'Import failed (' + nm + ').');
                    });
            } catch (e) { toastr.error('Import failed: ' + e.message); }
        });
        inp.click();
    }

    _loadSave(cb) {
        const key = this._getSaveKey();
        if (!key) { cb(false); return; }
        this._getDB(key, (data) => {
            const src = data instanceof Uint8Array ? data : new Uint8Array(data);
            this._getSaveBuf().set(src.subarray(0, WASM_SAVE_LEN));
            this._clearSaveBufState();
            cb(true);
        }, () => cb(false));
    }

    _clearSaveBufState() {
        this.lastSaveFlag = 0;
        this._periodicSaveCnt = 0;
        if (this.isWasmReady) Module._emuUpdateSavChangeFlag();
    }

    // ── INDEXED DB ────────────────────────────────────────────────────────────

    createDB() {
        if (!window['indexedDB']) return;
        const req = indexedDB.open('GBAWASMDB');
        req.onupgradeneeded = (ev) =>
            ev.target.result.createObjectStore('GBAWASMSTATES', { autoIncrement: true });
        req.onsuccess = (ev) => {
            const store = ev.target.result
                .transaction('GBAWASMSTATES', 'readwrite')
                .objectStore('GBAWASMSTATES');
            store.openCursor().onsuccess = (ev) => {
                const c = ev.target.result;
                if (c) { this.dblist.push(c.key.toString()); c.continue(); }
            };
        };
    }

    // Probe BOTH keys after a ROM load. This used to look up only the SRAM key
    // (`<rom>.sav`) and use the answer to enable the LOAD STATE button, which reads
    // the wrong thing: a save state lives at `<rom>.sav.state`. A visitor who saved
    // a state and refreshed could find Load State greyed out because the game had
    // not happened to write SRAM yet — the state was on disk the whole time.
    _findInDatabase() {
        const key = this._getSaveKey();
        if (!key) return;
        this._getDB(key,
            () => { this.rivetsData.noLocalSave = false; },
            () => { }
        );
        this._getDB(key + '.state',
            () => { this.rivetsData.noLocalState = false; },
            () => { this.rivetsData.noLocalState = true; }
        );
    }

    _putDB(key, data, onOk, onErr) {
        const req = indexedDB.open('GBAWASMDB');
        req.onsuccess = (ev) => {
            const r = ev.target.result
                .transaction('GBAWASMSTATES', 'readwrite')
                .objectStore('GBAWASMSTATES')
                .put(data, key);
            r.onsuccess = onOk;
            r.onerror = onErr;
        };
        req.onerror = onErr;
    }

    _getDB(key, onFound, onMissing) {
        const req = indexedDB.open('GBAWASMDB');
        req.onsuccess = (ev) => {
            const r = ev.target.result
                .transaction('GBAWASMSTATES', 'readwrite')
                .objectStore('GBAWASMSTATES')
                .get(key);
            r.onsuccess = () => r.result ? onFound(r.result) : onMissing();
            r.onerror = onMissing;
        };
        req.onerror = onMissing;
    }

    // ── CANVAS / DISPLAY ──────────────────────────────────────────────────────

    resizeCanvas() {
        const w = this.rivetsData.canvasSize;
        $('#canvas').css({ width: w + 'px', height: Math.round(w * 160 / 240) + 'px' });
    }

    zoomOut() {
        this.rivetsData.canvasSize = Math.max(240, this.rivetsData.canvasSize - 40);
        localStorage.setItem('gbawasm-size', this.rivetsData.canvasSize);
        this.resizeCanvas();
    }

    zoomIn() {
        this.rivetsData.canvasSize += 40;
        localStorage.setItem('gbawasm-size', this.rivetsData.canvasSize);
        this.resizeCanvas();
    }

    fullscreen() {
        try {
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document);
            } else {
                const el = document.getElementById('canvas');
                (el.requestFullscreen || el.webkitRequestFullScreen || el.mozRequestFullScreen).call(el);
            }
        } catch (e) { }
    }

    _onFullscreenChange() {
        // MOBILE OWNS ITS OWN GEOMETRY. On the SP shell the canvas lives inside
        // #spScreen and spScaleCanvas() sets its position/transform; the desktop
        // branch below rewrites canvasDiv's cssText and the canvas width/height,
        // which would fight it and leave the picture mis-sized. gba.html's own
        // fullscreenchange listener re-fits the mobile canvas instead.
        if (this.mobileMode) {
            if (typeof spScaleCanvas === 'function') spScaleCanvas();
            return;
        }
        const canvasDiv = document.getElementById('canvasDiv');
        const canvas = document.getElementById('canvas');
        const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
        if (isFs) {
            const sw = window.screen.width;
            const sh = window.screen.height;
            const w = Math.min(sw, Math.round(sh * 3 / 2));
            const h = Math.min(sh, Math.round(sw * 2 / 3));
            canvasDiv.style.cssText = 'display:flex !important; align-items:center; justify-content:center; background:black; width:100vw; height:100vh;';
            canvas.style.width = w + 'px';
            canvas.style.height = h + 'px';
        } else {
            canvasDiv.style.cssText = '';
            canvas.style.width = this.rivetsData.canvasSize + 'px';
            canvas.style.height = '';
        }
    }

    cancelRemap() {
        this.rivetsData.remapWait = false;
        if (this.rivetsData.inputController)
            this.rivetsData.inputController.Remap_Check = false;
    }

    newRom() { location.reload(); }

    _configureEmulator() {
        const size = localStorage.getItem('gbawasm-size');
        if (size) this.rivetsData.canvasSize = parseInt(size);
        if (this.mobileMode) this._setupMobileMode();
        this.resizeCanvas();
        this.refreshKeyRefGrid();
    }

    _setupMobileMode() {
        // Hand off to the GBA SP shell
        document.getElementById('canvasDiv').style.display = 'block';
        if (typeof spActivate === 'function') spActivate();
    }

    setGameSpeed(speed) {
        this.gameSpeed = speed;
    }

    hideMobileMenu() {
        if (this.mobileMode) spCloseMenu();
    }

    // ── INPUT CONTROLLER ──────────────────────────────────────────────────────

    setupInputController() {
        this.rivetsData.inputController = new InputController();
        try {
            const saved = localStorage.getItem('gbawasm_mappings_v1');
            if (saved) {
                const obj = JSON.parse(saved);
                for (const [k, v] of Object.entries(obj)) {
                    if (k in this.rivetsData.inputController.KeyMappings)
                        this.rivetsData.inputController.KeyMappings[k] = v;
                }
            }
        } catch (e) { }
        this._pollInput();
    }

    _pollInput() {
        if (this.rivetsData.inputController) this.rivetsData.inputController.update();
        if (this.rivetsData.beforeEmulatorStarted) setTimeout(() => this._pollInput(), 100);
    }

    // ── DETECT MOBILE ─────────────────────────────────────────────────────────

    detectMobile() {
        const ua = navigator.userAgent.toLowerCase();
        this.iosMode = ua.includes('iphone') || ua.includes('ipad');
        // Was: `window.innerWidth < 600 || ua.includes('iphone')`.
        // MEASURED 2026-09-01 with a Pixel 8 UA: portrait (412x915) gave
        // mobileMode=true, but LANDSCAPE (915x412) gave mobileMode=false,
        // spShell display:none, the canvas left in #canvasDiv and #mobileA with
        // a zero-width rect — i.e. an Android visitor who turns the phone
        // sideways (the natural way to hold a GBA) got the desktop UI with no
        // touch controls and no keyboard. Only iPhone survived, and only
        // because of the UA substring.
        // Fix: decide from the SHORT edge, which does not change on rotation,
        // and from a real touch capability rather than a width guess — so this
        // is evaluated once and stays correct through every orientation change.
        const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
        const uaMobile = /iphone|ipad|ipod|android|mobile/.test(ua);
        this.mobileMode = uaMobile || (touch && Math.min(window.innerWidth, window.innerHeight) < 600);
    }

    // ── REMAP MODAL ───────────────────────────────────────────────────────────

    showRemapModal() {
        this.rivetsData.remapPlayer1 = true;
        this.rivetsData.remapOptions = false;
        this.rivetsData.remappings = Object.assign({}, this.rivetsData.inputController.KeyMappings);
        this.rivetsData.remapWait = false;
        $('#buttonsModal').modal('show');
    }

    swapRemap(tab) {
        this.rivetsData.remapPlayer1 = (tab === 'player1');
        this.rivetsData.remapOptions = (tab === 'options');
    }

    btnRemapKey(n) {
        this.rivetsData.remapMode = 'key';
        this.rivetsData.currKey = n;
        this.rivetsData.remapWait = true;
        this.rivetsData.inputController.Key_Last = '';
        this.rivetsData.inputController.Remap_Check = true;
    }

    btnRemapJoy(n) {
        this.rivetsData.remapMode = 'joy';
        this.rivetsData.currJoy = n;
        this.rivetsData.remapWait = true;
        this.rivetsData.inputController.Joy_Last = null;
        this.rivetsData.inputController.Remap_Check = true;
    }

    remapPressed() {
        const isKey = this.rivetsData.remapMode === 'key';
        const num = isKey ? this.rivetsData.currKey : this.rivetsData.currJoy;
        const val = isKey ? this.rivetsData.inputController.Key_Last : this.rivetsData.inputController.Joy_Last;
        const prefix = isKey ? 'Mapping_' : 'Joy_Mapping_';
        const map = {
            1: prefix + 'Up', 2: prefix + 'Down', 3: prefix + 'Left', 4: prefix + 'Right',
            5: prefix + 'Action_A', 6: prefix + 'Action_B', 7: prefix + 'Action_Start',
            8: prefix + 'Action_Select', 9: prefix + 'Action_L', 10: prefix + 'Action_R',
            11: prefix + 'Menu'
        };
        if (map[num]) {
            this.rivetsData.inputController.KeyMappings[map[num]] = val;
            this.rivetsData.remappings = Object.assign({}, this.rivetsData.inputController.KeyMappings);
        }
        this.rivetsData.remapWait = false;
    }

    saveRemaps() {
        localStorage.setItem('gbawasm_mappings_v1', JSON.stringify(this.rivetsData.inputController.KeyMappings));
        $('#buttonsModal').modal('hide');
        this.refreshKeyRefGrid();
    }

    refreshKeyRefGrid() {
        const grid = document.getElementById('keyRefGrid');
        if (!grid || !this.rivetsData.inputController) return;
        document.getElementById('keyReference').style.display = 'block';
        const km = this.rivetsData.inputController.KeyMappings;
        const buttons = [
            { label: 'D-Up', key: 'Mapping_Up', cls: 'pill-dpad' },
            { label: 'D-Down', key: 'Mapping_Down', cls: 'pill-dpad' },
            { label: 'D-Left', key: 'Mapping_Left', cls: 'pill-dpad' },
            { label: 'D-Right', key: 'Mapping_Right', cls: 'pill-dpad' },
            { label: 'A', key: 'Mapping_Action_A', cls: 'gba-a' },
            { label: 'B', key: 'Mapping_Action_B', cls: 'gba-b' },
            { label: 'L', key: 'Mapping_Action_L', cls: 'gba-shoulder' },
            { label: 'R', key: 'Mapping_Action_R', cls: 'gba-shoulder' },
            { label: 'Start', key: 'Mapping_Action_Start', cls: 'pill-start-select' },
            { label: 'Select', key: 'Mapping_Action_Select', cls: 'pill-start-select' },
            { label: 'Menu', key: 'Mapping_Menu', cls: 'pill-menu' },
        ];
        grid.innerHTML = buttons.map(b =>
            `<div class="key-ref-item">` +
            `<span class="btn-pill ${b.cls}">${b.label}</span>` +
            `<span class="keycap">${km[b.key] || '—'}</span>` +
            `</div>`
        ).join('');
    }

    resetRemaps() {
        this.rivetsData.inputController.KeyMappings = this.rivetsData.inputController.defaultKeymappings();
        this.rivetsData.remappings = Object.assign({}, this.rivetsData.inputController.KeyMappings);
        localStorage.removeItem('gbawasm_mappings_v1');
    }
}

var myClass = new MyClass();
var myApp = myClass;

// Load input controller, which then loads the 44vba WASM binary
var _rando = Math.floor(Math.random() * 100000);
var _ic = document.createElement('script');
_ic.src = '/gba/gbaWasm/dist/input_controller.js?v=' + _rando;
document.getElementsByTagName('head')[0].appendChild(_ic);
