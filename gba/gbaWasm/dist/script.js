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

const AUDIO_BLOCK_SIZE  = 2048;
const AUDIO_FIFO_MAXLEN = 4900;
const WASM_SAVE_LEN     = 0x22000; // libretro_save_buf size (0x20000 + 0x2000)

// GBA key bitmask — order matches 44vba keyList: ["a","b","select","start","right","left","up","down","r","l"]
const GBA_KEY = { A:1, B:2, SELECT:4, START:8, RIGHT:16, LEFT:32, UP:64, DOWN:128, R:256, L:512 };

class MyClass {
    constructor() {
        this.rom_name   = '';
        this.mobileMode = false;
        this.iosMode    = false;
        this.dblist     = [];

        // 44vba runtime state
        this.romBufferPtr  = -1;
        this.wasmSaveBuf   = null;
        this.idata         = null;
        this.drawContext   = null;
        this.isRunning     = false;
        this.isWasmReady   = false;
        this.frameCnt      = 0;
        this.lastSaveFlag  = 0;
        this.wasmAudioBuf  = null;

        // Audio FIFO (stereo interleaved, Int16)
        this.audioContext  = null;
        this.audioFifo0    = new Int16Array(AUDIO_FIFO_MAXLEN);
        this.audioFifo1    = new Int16Array(AUDIO_FIFO_MAXLEN);
        this.audioFifoHead = 0;
        this.audioFifoCnt  = 0;

        // Expose the two callbacks the WASM binary calls into
        window['wasmReady']  = this.onWasmReady.bind(this);
        window['writeAudio'] = this.writeAudio.bind(this);

        // Tell Emscripten where to find the .wasm file
        // (needed because 44gba.js is dynamically inserted into <head>)
        window['Module'] = {
            locateFile: (path) => 'gba/gbaWasm/dist/' + path
        };

        this.rivetsData = {
            beforeEmulatorStarted: true,
            moduleInitializing: true,
            hasRoms: false,
            romList: [],
            noLocalSave: true,
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

        rivets.formatters.ev        = (v, a) => eval(v + a);
        rivets.formatters.ev_string = (v, a) => eval("'" + v + "'" + a);

        rivets.bind(document.getElementById('topPanel'),          { data: this.rivetsData });
        rivets.bind(document.getElementById('bottomPanel'),       { data: this.rivetsData });
        rivets.bind(document.getElementById('buttonsModal'),      { data: this.rivetsData });
        rivets.bind(document.getElementById('lblError'),          { data: this.rivetsData });

        document.getElementById('file-upload').addEventListener('change', this.uploadRom.bind(this));

        this.setupDragDropRom();
        this.detectMobile();
        this.createDB();

        // rAF loop runs even before a ROM is loaded; frames only execute once isRunning=true
        this._boundLoop = this._emuLoop.bind(this);
        window.requestAnimationFrame(this._boundLoop);

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
        canvas.width  = 240;
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
        // Called by WASM systemOnWriteDataToSoundBuffer with a pointer into HEAPU8
        if (!this.wasmAudioBuf) {
            this.wasmAudioBuf = new Int16Array(Module.HEAPU8.buffer).subarray(ptr >> 1, (ptr >> 1) + 2048);
        }
        if (this.audioFifoCnt + frames >= AUDIO_FIFO_MAXLEN) return;
        let tail = (this.audioFifoHead + this.audioFifoCnt) % AUDIO_FIFO_MAXLEN;
        for (let i = 0; i < frames; i++) {
            this.audioFifo0[tail] = this.wasmAudioBuf[i * 2];
            this.audioFifo1[tail] = this.wasmAudioBuf[i * 2 + 1];
            tail = (tail + 1) % AUDIO_FIFO_MAXLEN;
        }
        this.audioFifoCnt += frames;
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
            const sp = this.audioContext.createScriptProcessor(AUDIO_BLOCK_SIZE, 0, 2);
            sp.onaudioprocess = (ev) => {
                const o0 = ev.outputBuffer.getChannelData(0);
                const o1 = ev.outputBuffer.getChannelData(1);
                if (!this.isRunning) { o0.fill(0); o1.fill(0); return; }
                // Drain the FIFO. If it runs dry, output silence — rAF is the sole
                // frame driver; running catch-up frames here caused double-speed
                // emulation on mobile whenever a touch event delayed rAF.
                const n = Math.min(AUDIO_BLOCK_SIZE, this.audioFifoCnt);
                for (let i = 0; i < n; i++) {
                    o0[i] = this.audioFifo0[this.audioFifoHead] / 32768;
                    o1[i] = this.audioFifo1[this.audioFifoHead] / 32768;
                    this.audioFifoHead = (this.audioFifoHead + 1) % AUDIO_FIFO_MAXLEN;
                    this.audioFifoCnt--;
                }
                // Fill any remainder with silence
                for (let i = n; i < AUDIO_BLOCK_SIZE; i++) { o0[i] = 0; o1[i] = 0; }
            };
            sp.connect(this.audioContext.destination);
            this.audioContext.resume();
        } catch(e) { console.log('Audio init failed:', e); }
    }

    // ── GAME LOOP ─────────────────────────────────────────────────────────────

    _emuLoop() {
        window.requestAnimationFrame(this._boundLoop);
        if (!this.isRunning) return;

        const now = performance.now();
        const GBA_FRAME_MS = 1000 / 59.7275; // exact GBA framerate

        if (!this._lastFrameTime) { this._lastFrameTime = now; return; }

        const elapsed = now - this._lastFrameTime;

        // Only run a frame if enough wall-clock time has passed.
        // This decouples the emulator from rAF frequency so it runs at a
        // constant 59.73fps regardless of whether the device fires rAF at
        // 60Hz, 90Hz, or 120Hz (variable refresh rate on real mobile hardware).
        if (elapsed >= GBA_FRAME_MS) {
            this._lastFrameTime = now - (elapsed % GBA_FRAME_MS); // carry over remainder
            this._runFrame();
        }
    }

    _runFrame() {
        if (!this.isRunning || !this.isWasmReady) return;
        this.frameCnt++;
        if (this.frameCnt % 60 === 0) this._checkAutoSave();
        Module._emuRunFrame(this._getKeyMask());
        this.drawContext.putImageData(this.idata, 0, 0);
    }

    _getKeyMask() {
        const ic = this.rivetsData.inputController;
        if (!ic) return 0;
        let m = 0;
        if (ic.Key_Action_A)      m |= GBA_KEY.A;
        if (ic.Key_Action_B)      m |= GBA_KEY.B;
        if (ic.Key_Action_Select) m |= GBA_KEY.SELECT;
        if (ic.Key_Action_Start)  m |= GBA_KEY.START;
        if (ic.Key_Right)         m |= GBA_KEY.RIGHT;
        if (ic.Key_Left)          m |= GBA_KEY.LEFT;
        if (ic.Key_Up)            m |= GBA_KEY.UP;
        if (ic.Key_Down)          m |= GBA_KEY.DOWN;
        if (ic.Key_Action_R)      m |= GBA_KEY.R;
        if (ic.Key_Action_L)      m |= GBA_KEY.L;
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
        } catch(e) { toastr.error('Failed to load ROM: ' + e); }
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
        ['dragenter','dragover','dragleave','drop'].forEach(ev =>
            d.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); })
        );
        d.addEventListener('dragenter', () => $('#dropArea').css({'background-color':'lightblue'}));
        d.addEventListener('dragleave', () => $('#dropArea').css({'background-color':'inherit'}));
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
            () => {}
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

    async _compressHeap(u8) {
        const cs     = new CompressionStream('gzip');
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

    async _decompressHeap(u8) {
        const ds     = new DecompressionStream('gzip');
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

    async saveStateLocal() {
        if (!this.isRunning) { toastr.error('No game running.'); return; }
        const key = this._getSaveKey();
        if (!key) { toastr.error('No ROM loaded.'); return; }
        toastr.info('Saving state…');
        try {
            // Snapshot full 128 MB heap while the game loop keeps running
            const snap       = new Uint8Array(Module.HEAPU8.byteLength);
            snap.set(Module.HEAPU8);
            const compressed = await this._compressHeap(snap);
            this._putDB(key + '.state', compressed,
                () => {
                    this.rivetsData.noLocalSave = false;
                    toastr.info('State saved (' + (compressed.byteLength / 1024 / 1024).toFixed(1) + ' MB).');
                },
                () => toastr.error('State save failed.')
            );
        } catch(e) { toastr.error('State save error: ' + e.message); }
    }

    async loadStateLocal() {
        const key = this._getSaveKey();
        if (!key) { toastr.error('No ROM loaded.'); return; }
        this._getDB(key + '.state', async (data) => {
            toastr.info('Restoring state…');
            try {
                this.isRunning = false;
                const compressed = data instanceof Uint8Array ? data : new Uint8Array(data);
                const heap       = await this._decompressHeap(compressed);
                // Restore heap in-place — typed-array views stay valid
                Module.HEAPU8.set(heap);
                this.isRunning = true;
                toastr.info('State restored.');
            } catch(e) {
                this.isRunning = true;
                toastr.error('State restore error: ' + e.message);
            }
        }, () => toastr.error('No save state found for this ROM.'));
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
                .transaction('GBAWASMSTATES','readwrite')
                .objectStore('GBAWASMSTATES');
            store.openCursor().onsuccess = (ev) => {
                const c = ev.target.result;
                if (c) { this.dblist.push(c.key.toString()); c.continue(); }
            };
        };
    }

    _findInDatabase() {
        const key = this._getSaveKey();
        if (!key) return;
        this._getDB(key,
            () => { this.rivetsData.noLocalSave = false; },
            () => {}
        );
    }

    _putDB(key, data, onOk, onErr) {
        const req = indexedDB.open('GBAWASMDB');
        req.onsuccess = (ev) => {
            const r = ev.target.result
                .transaction('GBAWASMSTATES','readwrite')
                .objectStore('GBAWASMSTATES')
                .put(data, key);
            r.onsuccess = onOk;
            r.onerror   = onErr;
        };
        req.onerror = onErr;
    }

    _getDB(key, onFound, onMissing) {
        const req = indexedDB.open('GBAWASMDB');
        req.onsuccess = (ev) => {
            const r = ev.target.result
                .transaction('GBAWASMSTATES','readwrite')
                .objectStore('GBAWASMSTATES')
                .get(key);
            r.onsuccess = () => r.result ? onFound(r.result) : onMissing();
            r.onerror   = onMissing;
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
        } catch(e) {}
    }

    _onFullscreenChange() {
        const canvasDiv = document.getElementById('canvasDiv');
        const canvas    = document.getElementById('canvas');
        const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
        if (isFs) {
            const sw = window.screen.width;
            const sh = window.screen.height;
            const w  = Math.min(sw, Math.round(sh * 3 / 2));
            const h  = Math.min(sh, Math.round(sw * 2 / 3));
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
        } catch(e){}
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
        this.rivetsData.remapMode = 'key';
        this.rivetsData.currKey   = n;
        this.rivetsData.remapWait = true;
        this.rivetsData.inputController.Key_Last   = '';
        this.rivetsData.inputController.Remap_Check = true;
    }

    btnRemapJoy(n) {
        this.rivetsData.remapMode = 'joy';
        this.rivetsData.currJoy   = n;
        this.rivetsData.remapWait = true;
        this.rivetsData.inputController.Joy_Last    = null;
        this.rivetsData.inputController.Remap_Check = true;
    }

    remapPressed() {
        const isKey  = this.rivetsData.remapMode === 'key';
        const num    = isKey ? this.rivetsData.currKey  : this.rivetsData.currJoy;
        const val    = isKey ? this.rivetsData.inputController.Key_Last : this.rivetsData.inputController.Joy_Last;
        const prefix = isKey ? 'Mapping_' : 'Joy_Mapping_';
        const map = {
            1:prefix+'Up', 2:prefix+'Down', 3:prefix+'Left', 4:prefix+'Right',
            5:prefix+'Action_A', 6:prefix+'Action_B', 7:prefix+'Action_Start',
            8:prefix+'Action_Select', 9:prefix+'Action_L', 10:prefix+'Action_R',
            11:prefix+'Menu'
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
            { label: 'D-Up',    key: 'Mapping_Up',            cls: 'pill-dpad' },
            { label: 'D-Down',  key: 'Mapping_Down',          cls: 'pill-dpad' },
            { label: 'D-Left',  key: 'Mapping_Left',          cls: 'pill-dpad' },
            { label: 'D-Right', key: 'Mapping_Right',         cls: 'pill-dpad' },
            { label: 'A',       key: 'Mapping_Action_A',      cls: 'gba-a' },
            { label: 'B',       key: 'Mapping_Action_B',      cls: 'gba-b' },
            { label: 'L',       key: 'Mapping_Action_L',      cls: 'gba-shoulder' },
            { label: 'R',       key: 'Mapping_Action_R',      cls: 'gba-shoulder' },
            { label: 'Start',   key: 'Mapping_Action_Start',  cls: 'pill-start-select' },
            { label: 'Select',  key: 'Mapping_Action_Select', cls: 'pill-start-select' },
            { label: 'Menu',    key: 'Mapping_Menu',          cls: 'pill-menu' },
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
var myApp   = myClass;

// Load input controller, which then loads the 44vba WASM binary
var _rando = Math.floor(Math.random() * 100000);
var _ic = document.createElement('script');
_ic.src = 'gba/gbaWasm/dist/input_controller.js?v=' + _rando;
document.getElementsByTagName('head')[0].appendChild(_ic);
