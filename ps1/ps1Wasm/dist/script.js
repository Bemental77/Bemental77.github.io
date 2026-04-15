// ─── PS1 Emulator — WASM Integration ─────────────────────────────────────────
// Target emulator: compiled PS1 core (e.g. DuckStation or PCSX-Redux) via
// Emscripten. The exported C function names below are placeholders — replace
// them with the actual symbols produced by your build.
//
// Expected exported C functions (Module._<name>):
//   ps1Init()                     one-time init after WASM module loads
//   ps1LoadBIOS(ptr, size)        write BIOS bytes already in HEAPU8 into the core
//   ps1LoadDisc(ptr, size)        load a disc image (raw .bin sector data)
//   ps1RunFrame(buttons)          advance one frame; buttons = PS1_KEY bitmask
//   ps1GetFramebuffer()           → ptr to 16bpp RGB555 framebuffer in HEAPU8
//   ps1GetFrameWidth()            → current frame width  (varies per video mode)
//   ps1GetFrameHeight()           → current frame height
//   ps1SaveState(ptr, maxBytes)   → bytes written (serialize state into HEAPU8)
//   ps1LoadState(ptr, size)       restore state from HEAPU8
//   ps1GetMemcard(slot, ptr)      → bytes written (128 KB memory card image)
//   ps1SetMemcard(slot, ptr, size) load memory card image
//   ps1MemcardDirty(slot)         → 1 if card was written since last check
//   ps1ClearMemcardDirty(slot)
//   ps1GetAudioBuffer()           → ptr to interleaved stereo Int16 PCM (44100 Hz)
//   ps1GetAudioSampleCount()      → number of stereo sample pairs ready
//   ps1ClearAudio()               reset audio read pointer
//
// WASM → JS callbacks (set on window before ps1wasm.js is injected):
//   window.wasmReady()            called by WASM main() once init is complete
//   window.writeAudio(ptr, n)     called each frame with new stereo PCM samples
//   (adjust names to match the compiled module's actual callback expectations)

const PS1_AUDIO_BLOCK_SIZE  = 2048;
const PS1_AUDIO_FIFO_MAXLEN = 8820;    // ~200 ms at 44100 Hz stereo
const WASM_MEMCARD_LEN      = 131072;  // 128 KB — standard PS1 memory card
const PS1_STATE_MAX_BYTES   = 8 * 1024 * 1024; // 8 MB save-state buffer
const PS1_MAX_DISC_WARN_MB  = 700;     // warn (not block) above this size
const PS1_NTSC_FPS          = 59.9403; // NTSC PS1 framerate
const PS1_PAL_FPS           = 50.0;    // PAL fallback (set via settings if needed)

class MyClass {
    constructor() {
        this.rom_name      = '';
        this.mobileMode    = false;
        this.iosMode       = false;
        this.dblist        = [];
        // BIOS is preloaded into the Emscripten virtual FS via ps1wasm.data
        // (--preload-file bios/ at build time). No user upload needed.
        // The upload path below remains available as an override fallback.
        this.biosLoaded    = true;
        this.biosPtr       = -1;

        // Emulator runtime state
        this.fbPtr         = -1;
        this.fbWidth       = 0;
        this.fbHeight      = 0;
        this.statePtr      = -1;   // reusable malloc'd save-state buffer
        this.memcardPtr    = -1;   // reusable malloc'd memcard buffer

        this.idata         = null;
        this.drawContext   = null;
        this.isRunning     = false;
        this.isWasmReady   = true; // TODO: set false once ps1wasm.js is built
        this.gameSpeed     = 1;
        this.frameCnt      = 0;
        this.lastMemcardDirty = 0;
        this.targetFps     = PS1_NTSC_FPS;

        // Audio FIFO (stereo interleaved, Int16)
        this.audioContext   = null;
        this.audioFifo0     = new Int16Array(PS1_AUDIO_FIFO_MAXLEN);
        this.audioFifo1     = new Int16Array(PS1_AUDIO_FIFO_MAXLEN);
        this.audioFifoHead  = 0;
        this.audioFifoCnt   = 0;
        this.wasmAudioBuf   = null;

        // Expose WASM callbacks before ps1wasm.js loads
        // window['wasmReady'] intentionally omitted — WASMpsx never fires this callback
        window['writeAudio'] = this.writeAudio.bind(this);

        // Note: window.Module is owned by wasmpsx.min.js — do not overwrite it here.
        // wasmpsx.min.js hardcodes locateFile and all Module callbacks internally.

        this.rivetsData = {
            beforeEmulatorStarted: true,
            moduleInitializing:    false,
            hasRoms:               false,
            romList:               [],
            noLocalSave:           true,
            biosLoaded:            true,
            lblError:              '',
            remappings:            null,
            remapMode:             '',
            currKey:               0,
            currJoy:               0,
            remapPlayer1:          true,
            remapOptions:          false,
            remapWait:             false,
            inputController:       null,
            hadNipple:             false,
            canvasSize:            640,
            settings:              { CLOUDSAVEURL: '', SHOWADVANCED: false }
        };

        this.rivetsData.settings = window['PS1WASMETTINGS'];

        if (window['PS1ROMLIST'] && window['PS1ROMLIST'].length > 0) {
            this.rivetsData.hasRoms = true;
            window['PS1ROMLIST'].forEach(r => this.rivetsData.romList.push(r));
        }

        rivets.formatters.ev        = (v, a) => eval(v + a);
        rivets.formatters.ev_string = (v, a) => eval("'" + v + "'" + a);

        rivets.bind(document.getElementById('topPanel'),    { data: this.rivetsData });
        rivets.bind(document.getElementById('bottomPanel'), { data: this.rivetsData });
        rivets.bind(document.getElementById('buttonsModal'),{ data: this.rivetsData });
        rivets.bind(document.getElementById('lblError'),    { data: this.rivetsData });

        document.getElementById('file-upload').addEventListener('change', this.uploadRom.bind(this));
        document.getElementById('bios-upload').addEventListener('change', this.uploadBios.bind(this));

        this.setupDragDropRom();
        this.detectMobile();
        this.createDB();

        this._boundLoop = this._emuLoop.bind(this);
        window.requestAnimationFrame(this._boundLoop);

        const _fsChange = this._onFullscreenChange.bind(this);
        document.addEventListener('fullscreenchange',        _fsChange);
        document.addEventListener('webkitfullscreenchange',  _fsChange);
        document.addEventListener('mozfullscreenchange',     _fsChange);

        $('#topPanel').show();
        $('#lblErrorOuter').show();
    }

    // ── WASM CALLBACKS ────────────────────────────────────────────────────────

    onWasmReady() {
        // Called by the WASM module once it has initialised.
        // Allocate persistent buffers and call the core's one-time init.
        Module._ps1Init();

        // Allocate a reusable save-state buffer
        this.statePtr   = Module._malloc(PS1_STATE_MAX_BYTES);
        // Allocate a reusable memory-card buffer (128 KB)
        this.memcardPtr = Module._malloc(WASM_MEMCARD_LEN);

        this.isWasmReady = true;
        this.rivetsData.moduleInitializing = false;

        if (typeof spScaleCanvas === 'function') spScaleCanvas();
    }

    writeAudio(ptr, frames) {
        if (this.gameSpeed > 1) return;
        if (!this.wasmAudioBuf) {
            this.wasmAudioBuf = new Int16Array(Module.HEAPU8.buffer).subarray(ptr >> 1, (ptr >> 1) + PS1_AUDIO_BLOCK_SIZE * 2);
        }
        if (this.audioFifoCnt + frames >= PS1_AUDIO_FIFO_MAXLEN) return;
        let tail = (this.audioFifoHead + this.audioFifoCnt) % PS1_AUDIO_FIFO_MAXLEN;
        for (let i = 0; i < frames; i++) {
            this.audioFifo0[tail] = this.wasmAudioBuf[i * 2];
            this.audioFifo1[tail] = this.wasmAudioBuf[i * 2 + 1];
            tail = (tail + 1) % PS1_AUDIO_FIFO_MAXLEN;
        }
        this.audioFifoCnt += frames;
    }

    // ── AUDIO ─────────────────────────────────────────────────────────────────

    tryInitSound() {
        // Resume SDL's AudioContext — the one actually used for output.
        // A separate AudioContext here would be unused; SDL creates its own.
        try {
            if (typeof SDL !== 'undefined' && SDL.audioContext && SDL.audioContext.state !== 'running') {
                SDL.audioContext.resume();
            }
        } catch (e) { console.log('Audio resume failed:', e); }
    }

    // ── GAME LOOP ─────────────────────────────────────────────────────────────

    _emuLoop(timestamp) {
        window.requestAnimationFrame(this._boundLoop);
        if (!this.isRunning) return;

        const FRAME_MS = 1000 / this.targetFps;

        if (!this._lastFrameTime) {
            this._lastFrameTime = timestamp;
            this._accum = 0;
            return;
        }

        let delta = timestamp - this._lastFrameTime;
        this._lastFrameTime = timestamp;
        if (delta > 50) delta = 50;
        this._accum += delta;

        const MAX_FRAMES = 3;
        let ranFrame = false;
        let frames = 0;

        while (this._accum >= FRAME_MS && frames < MAX_FRAMES) {
            for (let i = 0; i < this.gameSpeed; i++) {
                this._runFrame(i === this.gameSpeed - 1);
            }
            this._accum -= FRAME_MS;
            frames++;
            ranFrame = true;
        }

        if (ranFrame) {
            this._convertAndDraw();
        }
    }

    _runFrame(draw = true) {
        // wasmpsx runs its own game loop in the worker — no-op here
    }

    // ── FRAMEBUFFER — RGB555 → RGBA conversion ────────────────────────────────
    // PS1 native output is 16bpp RGB555. Each pixel: bits 0-4=R, 5-9=G, 10-14=B.
    // ImageData always requires 8bpp RGBA so we expand with a 5→8 bit scale.
    // The emulator can change resolution per-frame (e.g. 320×240 ↔ 640×480).

    _convertAndDraw() {
        // wasmpsx renders via its own canvas through the worker render message — no-op here
        return;

        if (!this.isWasmReady || this.fbPtr < 0) return;

        const w = Module._ps1GetFrameWidth();
        const h = Module._ps1GetFrameHeight();
        if (w <= 0 || h <= 0) return;

        const canvas = document.getElementById('canvas');

        if (canvas.width !== w || canvas.height !== h) {
            canvas.width  = w;
            canvas.height = h;
            this.fbWidth  = w;
            this.fbHeight = h;
            this.idata    = new ImageData(w, h);
            if (this.drawContext) {
                this.drawContext = canvas.getContext('2d');
            }
            if (typeof spScaleCanvas === 'function') spScaleCanvas();
        }

        if (!this.idata) return;

        // Refresh fbPtr each draw — guards against HEAPU8 reallocation
        const fbPtr = Module._ps1GetFramebuffer();
        const src = new Uint16Array(Module.HEAPU8.buffer, fbPtr, w * h);
        const dst = this.idata.data;
        for (let i = 0, j = 0; i < w * h; i++, j += 4) {
            const px = src[i];
            const r5 = px & 0x1F;
            const g5 = (px >> 5)  & 0x1F;
            const b5 = (px >> 10) & 0x1F;
            // 5-bit to 8-bit: replicate upper bits into lower to fill the range
            dst[j]   = (r5 << 3) | (r5 >> 2);
            dst[j+1] = (g5 << 3) | (g5 >> 2);
            dst[j+2] = (b5 << 3) | (b5 >> 2);
            dst[j+3] = 255;
        }
        this.drawContext.putImageData(this.idata, 0, 0);
    }

    _getKeyMask() {
        const ic = this.rivetsData.inputController;
        if (!ic) return 0;
        let m = 0;
        if (ic.Key_Up)               m |= PS1_KEY.UP;
        if (ic.Key_Down)             m |= PS1_KEY.DOWN;
        if (ic.Key_Left)             m |= PS1_KEY.LEFT;
        if (ic.Key_Right)            m |= PS1_KEY.RIGHT;
        if (ic.Key_Action_Cross)     m |= PS1_KEY.CROSS;
        if (ic.Key_Action_Circle)    m |= PS1_KEY.CIRCLE;
        if (ic.Key_Action_Square)    m |= PS1_KEY.SQUARE;
        if (ic.Key_Action_Triangle)  m |= PS1_KEY.TRIANGLE;
        if (ic.Key_Action_L1)        m |= PS1_KEY.L1;
        if (ic.Key_Action_R1)        m |= PS1_KEY.R1;
        if (ic.Key_Action_L2)        m |= PS1_KEY.L2;
        if (ic.Key_Action_R2)        m |= PS1_KEY.R2;
        if (ic.Key_Action_Start)     m |= PS1_KEY.START;
        if (ic.Key_Action_Select)    m |= PS1_KEY.SELECT;
        if (ic.Key_Action_L3)        m |= PS1_KEY.L3;
        if (ic.Key_Action_R3)        m |= PS1_KEY.R3;
        return m;
    }

    // ── BIOS ──────────────────────────────────────────────────────────────────

    uploadBiosBrowse() {
        document.getElementById('bios-upload').click();
    }

    uploadBios(event) {
        const file = event.currentTarget.files[0];
        const r = new FileReader();
        r.onload = (e) => this._loadBiosArrayBuffer(e.target.result);
        r.readAsArrayBuffer(file);
    }

    _loadBiosArrayBuffer(arrayBuffer) {
        const u8 = new Uint8Array(arrayBuffer);
        // PS1 BIOS images are 512 KB or 1 MB
        if (u8.length !== 524288 && u8.length !== 1048576) {
            toastr.warning('Unexpected BIOS size (' + (u8.length / 1024) + ' KB). Attempting to load anyway.');
        }

        // Allocate or reuse the BIOS buffer
        if (this.biosPtr >= 0) Module._free(this.biosPtr);
        this.biosPtr = Module._malloc(u8.length);
        Module.HEAPU8.set(u8, this.biosPtr);
        Module._ps1LoadBIOS(this.biosPtr, u8.length);

        this.biosLoaded = true;
        this.rivetsData.biosLoaded = true;

        // Persist BIOS in IndexedDB so next session loads it automatically
        this._putDB('ps1bios', u8,
            () => { toastr.success('BIOS loaded and saved for future sessions.'); },
            () => { toastr.success('BIOS loaded (could not persist to IndexedDB).'); }
        );
    }

    _loadBiosFromDB() {
        this._getDB('ps1bios', (data) => {
            const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            this._loadBiosArrayBuffer(u8.buffer);
            toastr.info('BIOS restored from previous session.');
        }, () => { /* no BIOS saved — user must upload */ });
    }

    // ── ROM LOADING ───────────────────────────────────────────────────────────

    uploadBrowse() {
        this.tryInitSound();
        document.getElementById('file-upload').click();
    }

    uploadRom(event) {
        const file = event.currentTarget.files[0];
        this.rom_name = file.name;
        this.tryInitSound();
        this._whenReady(() => {
            $('#canvasDiv').css('display', 'flex');
            this.rivetsData.beforeEmulatorStarted = false;
            console.log('[ps1] calling readFile:', file.name);
            document.getElementById('ps1player').readFile(file);
        });
    }

    async loadRom() {
        const title = document.getElementById('romselect').value;
        const rom = this.rivetsData.romList.find(r => r.title === title);
        if (!rom) { toastr.error('ROM not found.'); return; }
        this.rom_name = rom.title;
        this.tryInitSound();
        this._whenReady(async () => {
            try {
                const u8 = await this._fetchChunked(rom.chunks);
                const file = new File([u8], rom.title + '.iso', { type: 'application/octet-stream' });
                document.getElementById('ps1player').readFile(file);
                this.isRunning = true;
                $('#canvasDiv').css('display', 'flex');
                this.rivetsData.beforeEmulatorStarted = false;
            } catch (e) {
                toastr.error('Failed to load ROM: ' + e.message);
            }
        });
    }

    async _fetchChunked(chunks) {
        const buffers = [];
        let totalLoaded = 0;

        for (let i = 0; i < chunks.length; i++) {
            const resp = await fetch(chunks[i]);
            if (!resp.ok) throw new Error('Failed to fetch chunk ' + (i + 1) + ': HTTP ' + resp.status);

            const reader = resp.body.getReader();
            const chunkPieces = [];

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunkPieces.push(value);
                totalLoaded += value.length;
                this._showLoadProgress(totalLoaded, 0);
            }

            const chunkSize = chunkPieces.reduce((s, b) => s + b.length, 0);
            const chunkArr = new Uint8Array(chunkSize);
            let off = 0;
            for (const piece of chunkPieces) { chunkArr.set(piece, off); off += piece.length; }
            buffers.push(chunkArr);
        }

        this._hideLoadProgress();

        const totalSize = buffers.reduce((s, b) => s + b.length, 0);
        const result = new Uint8Array(totalSize);
        let off = 0;
        for (const buf of buffers) { result.set(buf, off); off += buf.length; }
        return result;
    }

    _whenReady(fn) {
        if (window.wasmpsxReady) { fn(); return; }
        const id = setInterval(() => {
            if (window.wasmpsxReady) { clearInterval(id); fn(); }
        }, 100);
    }

    _showLoadProgress(received, total) {
        const div = document.getElementById('loadProgressDiv');
        const bar = document.getElementById('loadProgressBar');
        const lbl = document.getElementById('loadProgressLabel');
        if (!div) return;
        div.style.display = 'block';
        const pct = total ? Math.min(100, Math.round(received / total * 100)) : 0;
        bar.style.width = pct + '%';
        bar.setAttribute('aria-valuenow', pct);
        const mbRecv = (received / 1048576).toFixed(1);
        const mbTotal = total ? (total / 1048576).toFixed(1) + ' MB' : '? MB';
        lbl.textContent = mbRecv + ' MB / ' + mbTotal;
    }

    _hideLoadProgress() {
        const div = document.getElementById('loadProgressDiv');
        if (div) div.style.display = 'none';
    }

    _loadRomArrayBuffer(arrayBuffer) {

        const u8 = new Uint8Array(arrayBuffer);

        // Warn for unusually large images (> 700 MB) but don't block
        const sizeMB = u8.length / 1048576;
        if (sizeMB > PS1_MAX_DISC_WARN_MB) {
            toastr.warning('Large disc image (' + sizeMB.toFixed(0) + ' MB). Loading may be slow and may exceed browser memory limits.');
        }

        this.isRunning = false;

        // Copy disc image into WASM heap and hand off to emulator
        const discPtr = Module._malloc(u8.length);
        Module.HEAPU8.set(u8, discPtr);
        Module._ps1LoadDisc(discPtr, u8.length);
        Module._free(discPtr); // emulator took its own copy

        // Initialise canvas before starting
        const canvas = document.getElementById('canvas');
        this.drawContext = canvas.getContext('2d');
        this.fbPtr = Module._ps1GetFramebuffer();

        // Restore memory card slot 0, then start
        this._loadMemcard(() => {
            this._findInDatabase();
            this._configureEmulator();
            $('#canvasDiv').show();
            this.rivetsData.beforeEmulatorStarted = false;
            this._lastFrameTime = null;
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

    // ── MEMORY CARD SAVE / LOAD ───────────────────────────────────────────────
    // PS1 memory card slot 0 is a 128 KB block in a fixed Sony format.
    // Stored in IndexedDB under rom_name + '.mcr'.

    _getMemcardKey() {
        return this.rom_name ? this.rom_name + '.mcr' : null;
    }

    _persistMemcard() {
        const key = this._getMemcardKey();
        if (!key) return;
        // Read card from emulator into our pre-allocated buffer
        const written = Module._ps1GetMemcard(0, this.memcardPtr);
        if (written <= 0) return;
        const snap = new Uint8Array(written);
        snap.set(Module.HEAPU8.subarray(this.memcardPtr, this.memcardPtr + written));
        this._putDB(key, snap,
            () => { this.rivetsData.noLocalSave = false; },
            () => { }
        );
    }

    _checkAutoSave() {
        // Memory card API not available in wasmpsx build
        return;
        if (!this.isRunning) return;
        const dirty = Module._ps1MemcardDirty(0);

        // Save on falling edge (card was written, now idle)
        if (this.lastMemcardDirty === 1 && dirty === 0) {
            this._persistMemcard();
        }
        this.lastMemcardDirty = dirty;

        // Periodic fallback every ~60 s
        this._periodicSaveCnt = (this._periodicSaveCnt || 0) + 1;
        if (this._periodicSaveCnt >= 3600) {
            this._periodicSaveCnt = 0;
            if (dirty === 0) this._persistMemcard();
        }
    }

    _loadMemcard(cb) {
        const key = this._getMemcardKey();
        if (!key) { cb(); return; }
        this._getDB(key, (data) => {
            const src = data instanceof Uint8Array ? data : new Uint8Array(data);
            const len = Math.min(src.length, WASM_MEMCARD_LEN);
            Module.HEAPU8.set(src.subarray(0, len), this.memcardPtr);
            Module._ps1SetMemcard(0, this.memcardPtr, len);
            Module._ps1ClearMemcardDirty(0);
            this.rivetsData.noLocalSave = false;
            cb();
        }, () => cb());
    }

    // ── SAVE STATES ───────────────────────────────────────────────────────────
    // Uses the emulator's built-in serialization API (not a heap snapshot)
    // because the PS1 heap may be very large. Stored compressed in IndexedDB.

    async saveStateLocal() {
        if (!this.isRunning) { toastr.error('No game running.'); return; }
        const key = this._getSaveKey();
        if (!key) { toastr.error('No disc loaded.'); return; }
        if (!window.saveStateWasm) { toastr.error('Emulator not ready.'); return; }
        toastr.info('Saving state…');
        window.saveStateWasm(async (heap) => {
            try {
                const compressed = await this._compressData(new Uint8Array(heap));
                this._putDB(key + '.ps1state', compressed,
                    () => {
                        this.rivetsData.noLocalSave = false;
                        toastr.success('State saved (' + (compressed.byteLength / 1024 / 1024).toFixed(1) + ' MB).');
                    },
                    () => toastr.error('State save failed.')
                );
            } catch (e) { toastr.error('State save error: ' + e.message); }
        });
    }

    async loadStateLocal() {
        const key = this._getSaveKey();
        if (!key) { toastr.error('No disc loaded.'); return; }
        if (!window.loadStateWasm) { toastr.error('Emulator not ready.'); return; }
        this._getDB(key + '.ps1state', async (data) => {
            toastr.info('Restoring state…');
            try {
                const compressed = data instanceof Uint8Array ? data : new Uint8Array(data);
                const heap = await this._decompressData(compressed);
                window.loadStateWasm(heap, () => {
                    toastr.success('State restored.');
                });
            } catch (e) { toastr.error('State restore error: ' + (e && e.message ? e.message : String(e))); }
        }, () => toastr.error('No save state found for this disc.'));
    }

    _getSaveKey() {
        return this.rom_name || null;
    }

    async _compressData(u8) {
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        writer.write(u8);
        writer.close();
        const chunks = [];
        const reader = cs.readable.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        return new Uint8Array(await new Blob(chunks).arrayBuffer());
    }

    async _decompressData(u8) {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(u8);
        writer.close();
        const chunks = [];
        const reader = ds.readable.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        return new Uint8Array(await new Blob(chunks).arrayBuffer());
    }

    // ── INDEXED DB ────────────────────────────────────────────────────────────

    createDB() {
        if (!window['indexedDB']) return;
        const req = indexedDB.open('PS1WASMDB');
        req.onupgradeneeded = (ev) =>
            ev.target.result.createObjectStore('PS1WASMSTATES', { autoIncrement: true });
        req.onsuccess = (ev) => {
            const store = ev.target.result
                .transaction('PS1WASMSTATES', 'readwrite')
                .objectStore('PS1WASMSTATES');
            store.openCursor().onsuccess = (ev) => {
                const c = ev.target.result;
                if (c) { this.dblist.push(c.key.toString()); c.continue(); }
            };
        };
    }

    _findInDatabase() {
        const key = this._getMemcardKey();
        if (!key) return;
        this._getDB(key,
            () => { this.rivetsData.noLocalSave = false; },
            () => { }
        );
    }

    _putDB(key, data, onOk, onErr) {
        const req = indexedDB.open('PS1WASMDB');
        req.onsuccess = (ev) => {
            const r = ev.target.result
                .transaction('PS1WASMSTATES', 'readwrite')
                .objectStore('PS1WASMSTATES')
                .put(data, key);
            r.onsuccess = onOk;
            r.onerror   = onErr;
        };
        req.onerror = onErr;
    }

    _getDB(key, onFound, onMissing) {
        const req = indexedDB.open('PS1WASMDB');
        req.onsuccess = (ev) => {
            const r = ev.target.result
                .transaction('PS1WASMSTATES', 'readwrite')
                .objectStore('PS1WASMSTATES')
                .get(key);
            r.onsuccess = () => r.result ? onFound(r.result) : onMissing();
            r.onerror   = onMissing;
        };
        req.onerror = onMissing;
    }

    // ── CANVAS / DISPLAY ──────────────────────────────────────────────────────

    resizeCanvas() {
        const w = this.rivetsData.canvasSize;
        // Maintain a 4:3 aspect ratio for the desktop view (PS1 standard output)
        $('#canvas').css({ width: w + 'px', height: Math.round(w * 3 / 4) + 'px' });
    }

    zoomOut() {
        this.rivetsData.canvasSize = Math.max(320, this.rivetsData.canvasSize - 40);
        localStorage.setItem('ps1wasm-size', this.rivetsData.canvasSize);
        this.resizeCanvas();
    }

    zoomIn() {
        this.rivetsData.canvasSize += 40;
        localStorage.setItem('ps1wasm-size', this.rivetsData.canvasSize);
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
        const canvasDiv = document.getElementById('canvasDiv');
        const canvas    = document.getElementById('canvas');
        const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
        if (isFs) {
            const sw = window.screen.width;
            const sh = window.screen.height;
            const w = Math.min(sw, Math.round(sh * 4 / 3));
            const h = Math.min(sh, Math.round(sw * 3 / 4));
            canvasDiv.style.cssText = 'display:flex !important; align-items:center; justify-content:center; background:black; width:100vw; height:100vh;';
            canvas.style.width  = w + 'px';
            canvas.style.height = h + 'px';
        } else {
            canvasDiv.style.cssText = '';
            canvas.style.width  = this.rivetsData.canvasSize + 'px';
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
        const size = localStorage.getItem('ps1wasm-size');
        if (size) this.rivetsData.canvasSize = parseInt(size);
        if (this.mobileMode) this._setupMobileMode();
        this.resizeCanvas();
        this.refreshKeyRefGrid();
    }

    _setupMobileMode() {
        document.getElementById('canvasDiv').style.display = 'block';
        if (typeof spActivate === 'function') spActivate();
    }

    setGameSpeed(speed) { this.gameSpeed = speed; }

    hideMobileMenu() {
        if (this.mobileMode) spCloseMenu();
    }

    // ── INPUT CONTROLLER ──────────────────────────────────────────────────────

    setupInputController() {
        this.rivetsData.inputController = new InputController();
        try {
            const saved = localStorage.getItem('ps1wasm_mappings_v1');
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
        this.iosMode    = ua.includes('iphone') || ua.includes('ipad');
        this.mobileMode = window.innerWidth < 600 || ua.includes('iphone');
    }

    // ── REMAP MODAL ───────────────────────────────────────────────────────────

    showRemapModal() {
        this.rivetsData.remapPlayer1 = true;
        this.rivetsData.remapOptions = false;
        this.rivetsData.remappings   = Object.assign({}, this.rivetsData.inputController.KeyMappings);
        this.rivetsData.remapWait    = false;
        $('#buttonsModal').modal('show');
    }

    swapRemap(tab) {
        this.rivetsData.remapPlayer1 = (tab === 'player1');
        this.rivetsData.remapOptions = (tab === 'options');
    }

    btnRemapKey(n) {
        this.rivetsData.remapMode  = 'key';
        this.rivetsData.currKey    = n;
        this.rivetsData.remapWait  = true;
        this.rivetsData.inputController.Key_Last  = '';
        this.rivetsData.inputController.Remap_Check = true;
    }

    btnRemapJoy(n) {
        this.rivetsData.remapMode  = 'joy';
        this.rivetsData.currJoy    = n;
        this.rivetsData.remapWait  = true;
        this.rivetsData.inputController.Joy_Last  = null;
        this.rivetsData.inputController.Remap_Check = true;
    }

    remapPressed() {
        const isKey  = this.rivetsData.remapMode === 'key';
        const num    = isKey ? this.rivetsData.currKey  : this.rivetsData.currJoy;
        const val    = isKey ? this.rivetsData.inputController.Key_Last : this.rivetsData.inputController.Joy_Last;
        const prefix = isKey ? 'Mapping_' : 'Joy_Mapping_';
        const map = {
            1:  prefix + 'Up',
            2:  prefix + 'Down',
            3:  prefix + 'Left',
            4:  prefix + 'Right',
            5:  prefix + 'Action_Cross',
            6:  prefix + 'Action_Circle',
            7:  prefix + 'Action_Square',
            8:  prefix + 'Action_Triangle',
            9:  prefix + 'Action_L1',
            10: prefix + 'Action_R1',
            11: prefix + 'Action_L2',
            12: prefix + 'Action_R2',
            13: prefix + 'Action_Start',
            14: prefix + 'Action_Select',
            15: prefix + 'Menu'
        };
        if (map[num]) {
            this.rivetsData.inputController.KeyMappings[map[num]] = val;
            this.rivetsData.remappings = Object.assign({}, this.rivetsData.inputController.KeyMappings);
        }
        this.rivetsData.remapWait = false;
    }

    saveRemaps() {
        localStorage.setItem('ps1wasm_mappings_v1', JSON.stringify(this.rivetsData.inputController.KeyMappings));
        $('#buttonsModal').modal('hide');
        this.refreshKeyRefGrid();
    }

    refreshKeyRefGrid() {
        const grid = document.getElementById('keyRefGrid');
        if (!grid || !this.rivetsData.inputController) return;
        document.getElementById('keyReference').style.display = 'block';
        const km = this.rivetsData.inputController.KeyMappings;
        const buttons = [
            { label: 'D-Up',    key: 'Mapping_Up',             cls: 'pill-dpad' },
            { label: 'D-Down',  key: 'Mapping_Down',           cls: 'pill-dpad' },
            { label: 'D-Left',  key: 'Mapping_Left',           cls: 'pill-dpad' },
            { label: 'D-Right', key: 'Mapping_Right',          cls: 'pill-dpad' },
            { label: '✕',       key: 'Mapping_Action_Cross',   cls: 'ps1-cross' },
            { label: '○',       key: 'Mapping_Action_Circle',  cls: 'ps1-circle' },
            { label: '□',       key: 'Mapping_Action_Square',  cls: 'ps1-square' },
            { label: '△',       key: 'Mapping_Action_Triangle',cls: 'ps1-triangle' },
            { label: 'L1',      key: 'Mapping_Action_L1',      cls: 'ps1-shoulder' },
            { label: 'R1',      key: 'Mapping_Action_R1',      cls: 'ps1-shoulder' },
            { label: 'L2',      key: 'Mapping_Action_L2',      cls: 'ps1-shoulder' },
            { label: 'R2',      key: 'Mapping_Action_R2',      cls: 'ps1-shoulder' },
            { label: 'Start',   key: 'Mapping_Action_Start',   cls: 'pill-start-select' },
            { label: 'Select',  key: 'Mapping_Action_Select',  cls: 'pill-start-select' },
            { label: 'Menu',    key: 'Mapping_Menu',           cls: 'pill-menu' },
        ];
        grid.innerHTML = buttons.map(b =>
            `<div class="key-ref-item">` +
            `<span class="btn-pill ${b.cls}">${b.label}</span>` +
            `<span class="keycap">${km[b.key] !== undefined ? km[b.key] : '—'}</span>` +
            `</div>`
        ).join('');
    }

    resetRemaps() {
        this.rivetsData.inputController.KeyMappings = this.rivetsData.inputController.defaultKeymappings();
        this.rivetsData.remappings = Object.assign({}, this.rivetsData.inputController.KeyMappings);
        localStorage.removeItem('ps1wasm_mappings_v1');
    }
}

var myClass = new MyClass();
var myApp   = myClass;

// Load input controller, which then loads ps1wasm.js
var _rando = Math.floor(Math.random() * 100000);
var _ic = document.createElement('script');
_ic.src = 'ps1/ps1Wasm/dist/input_controller.js?v=' + _rando;
document.getElementsByTagName('head')[0].appendChild(_ic);
