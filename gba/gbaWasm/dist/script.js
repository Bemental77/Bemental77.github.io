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

const AUDIO_BLOCK_SIZE  = 1024;
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
        rivets.bind(document.getElementById('mobileBottomPanel'), { data: this.rivetsData });
        rivets.bind(document.getElementById('mobileButtons'),     { data: this.rivetsData });

        document.getElementById('file-upload').addEventListener('change', this.uploadRom.bind(this));

        this.setupDragDropRom();
        this.detectMobile();
        this.createDB();

        // rAF loop runs even before a ROM is loaded; frames only execute once isRunning=true
        this._boundLoop = this._emuLoop.bind(this);
        window.requestAnimationFrame(this._boundLoop);

        $('#topPanel').show();
        $('#lblErrorOuter').show();
    }

    // ── WASM CALLBACKS ────────────────────────────────────────────────────────

    onWasmReady() {
        // 44gba WASM main() calls window.wasmReady() once the module is fully initialised
        this.romBufferPtr = Module._emuGetSymbol(1);

        const savPtr = Module._emuGetSymbol(2);
        this.wasmSaveBuf = Module.HEAPU8.subarray(savPtr, savPtr + WASM_SAVE_LEN);

        const fbPtr = Module._emuGetSymbol(3);
        const canvas = document.getElementById('canvas');
        this.drawContext = canvas.getContext('2d');
        // ImageData views WASM memory directly — safe because TOTAL_MEMORY is fixed at 128 MB
        this.idata = new ImageData(
            new Uint8ClampedArray(Module.HEAPU8.buffer).subarray(fbPtr, fbPtr + 240 * 160 * 4),
            240, 160
        );

        this.isWasmReady = true;
        this.rivetsData.moduleInitializing = false;
        console.log('44vba WASM ready');
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
            this.audioContext = new AudioContext({ latencyHint: 0.0001, sampleRate: 48000 });
            const sp = this.audioContext.createScriptProcessor(AUDIO_BLOCK_SIZE, 0, 2);
            sp.onaudioprocess = (ev) => {
                const o0 = ev.outputBuffer.getChannelData(0);
                const o1 = ev.outputBuffer.getChannelData(1);
                if (!this.isRunning) { o0.fill(0); o1.fill(0); return; }
                // Run extra frames when audio buffer is starved (keeps A/V in sync)
                let safety = 0;
                while (this.audioFifoCnt < AUDIO_BLOCK_SIZE && safety++ < 10) this._runFrame();
                const n = Math.min(AUDIO_BLOCK_SIZE, this.audioFifoCnt);
                for (let i = 0; i < n; i++) {
                    o0[i] = this.audioFifo0[this.audioFifoHead] / 32768;
                    o1[i] = this.audioFifo1[this.audioFifoHead] / 32768;
                    this.audioFifoHead = (this.audioFifoHead + 1) % AUDIO_FIFO_MAXLEN;
                    this.audioFifoCnt--;
                }
            };
            sp.connect(this.audioContext.destination);
            this.audioContext.resume();
        } catch(e) { console.log('Audio init failed:', e); }
    }

    // ── GAME LOOP ─────────────────────────────────────────────────────────────

    _emuLoop() {
        window.requestAnimationFrame(this._boundLoop);
        if (this.isRunning) this._runFrame();
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
        Module._emuLoadROM(u8.length);

        // Restore saved SRAM, then start
        this._loadSave((found) => {
            if (found) console.log('SRAM restored for', this.rom_name);
            Module._emuResetCpu();
            this._clearSaveBufState();
            this._findInDatabase();
            this._configureEmulator();
            $('#canvasDiv').show();
            this.rivetsData.beforeEmulatorStarted = false;
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

    _checkAutoSave() {
        if (!this.isRunning) return;
        const changed = Module._emuUpdateSavChangeFlag();
        // When SRAM changes then stabilises → auto-save
        if (this.lastSaveFlag === 1 && changed === 0) {
            const snap = new Uint8Array(WASM_SAVE_LEN);
            snap.set(this.wasmSaveBuf);
            this._putDB(this.rom_name + '.sav', snap,
                () => { this.rivetsData.noLocalSave = false; },
                () => {}
            );
        }
        this.lastSaveFlag = changed;
    }

    saveStateLocal() {
        if (!this.isRunning) { toastr.error('No game running.'); return; }
        const snap = new Uint8Array(WASM_SAVE_LEN);
        snap.set(this.wasmSaveBuf);
        this._putDB(this.rom_name + '.sav', snap,
            () => { this.rivetsData.noLocalSave = false; toastr.info('Saved.'); },
            () => toastr.error('Save failed.')
        );
    }

    loadStateLocal() {
        this._loadSave((found) => {
            if (found) { Module._emuResetCpu(); toastr.info('Save loaded.'); }
            else toastr.error('No save found for this ROM.');
        });
    }

    _loadSave(cb) {
        this._getDB(this.rom_name + '.sav', (data) => {
            const src = data instanceof Uint8Array ? data : new Uint8Array(data);
            this.wasmSaveBuf.set(src.subarray(0, WASM_SAVE_LEN));
            this._clearSaveBufState();
            cb(true);
        }, () => cb(false));
    }

    _clearSaveBufState() {
        this.lastSaveFlag = 0;
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
        this._getDB(this.rom_name + '.sav',
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
            const el = document.getElementById('canvas');
            (el.requestFullscreen || el.webkitRequestFullScreen || el.mozRequestFullScreen).call(el);
        } catch(e) {}
    }

    newRom() { location.reload(); }

    _configureEmulator() {
        const size = localStorage.getItem('gbawasm-size');
        if (size) this.rivetsData.canvasSize = parseInt(size);
        if (this.mobileMode) this._setupMobileMode();
        this.resizeCanvas();
    }

    _setupMobileMode() {
        this.rivetsData.canvasSize = window.innerWidth;
        const half = (window.innerWidth / 2) - 35;
        document.getElementById('menuDiv').style.left = half + 'px';
        this.rivetsData.inputController.setupMobileControls('divTouchSurface');
        $('#mobileDiv').show();
        $('#maindiv').hide();
        $('#middleDiv').hide();
        $('#canvas').appendTo('#mobileCanvas');
        document.getElementById('maindiv').classList.remove('container');
        document.getElementById('canvas').style.display = 'block';
        try { document.body.scrollTop = 0; document.documentElement.scrollTop = 0; } catch(e){}
    }

    hideMobileMenu() {
        if (this.mobileMode) { $('#mobileButtons').hide(); $('#menuDiv').show(); }
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
