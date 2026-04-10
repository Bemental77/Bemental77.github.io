class MyClass {
    constructor() {
        this.rom_name = '';
        this.mobileMode = false;
        this.iosMode = false;
        this.dblist = [];

        var Module = {};
        Module['canvas'] = document.getElementById('canvas');
        window['Module'] = Module;

        document.getElementById('file-upload').addEventListener('change', this.uploadRom.bind(this));

        this.rivetsData = {
            message: '',
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
            hadFullscreen: false,
            canvasSize: 480,
            settings: {
                CLOUDSAVEURL: '',
                SHOWADVANCED: false
            }
        };

        // from settings.js
        this.rivetsData.settings = window['GBAWASMETTINGS'];

        if (window['ROMLIST'].length > 0) {
            this.rivetsData.hasRoms = true;
            window['ROMLIST'].forEach(rom => this.rivetsData.romList.push(rom));
        }

        rivets.formatters.ev = function (value, arg) {
            return eval(value + arg);
        };
        rivets.formatters.ev_string = function (value, arg) {
            return eval("'" + value + "'" + arg);
        };

        rivets.bind(document.getElementById('topPanel'),       { data: this.rivetsData });
        rivets.bind(document.getElementById('bottomPanel'),    { data: this.rivetsData });
        rivets.bind(document.getElementById('buttonsModal'),   { data: this.rivetsData });
        rivets.bind(document.getElementById('lblError'),       { data: this.rivetsData });
        rivets.bind(document.getElementById('mobileBottomPanel'), { data: this.rivetsData });
        rivets.bind(document.getElementById('mobileButtons'),  { data: this.rivetsData });

        this.setupDragDropRom();
        this.detectMobile();
        this.createDB();
        this.retrieveSettings();

        $('#topPanel').show();
        $('#lblErrorOuter').show();
    }

    setupInputController() {
        this.rivetsData.inputController = new InputController();
        try {
            let saved = localStorage.getItem('gbawasm_mappings_v1');
            if (saved) {
                let obj = JSON.parse(saved);
                for (let [k, v] of Object.entries(obj)) {
                    if (k in this.rivetsData.inputController.KeyMappings) {
                        this.rivetsData.inputController.KeyMappings[k] = v;
                    }
                }
            }
        } catch (e) {}
    }

    inputLoop() {
        myClass.rivetsData.inputController.update();
        if (myClass.rivetsData.beforeEmulatorStarted) {
            setTimeout(() => myClass.inputLoop(), 100);
        }
    }

    detectMobile() {
        let isIphone = navigator.userAgent.toLowerCase().includes('iphone');
        let isIpad   = navigator.userAgent.toLowerCase().includes('ipad');
        if (isIphone || isIpad) this.iosMode = true;
        this.mobileMode = window.innerWidth < 600 || isIphone;
    }

    // ── ROM LOADING ──────────────────────────────────────────────────────────

    async LoadEmulator(byteArray) {
        if (this.rom_name.toLowerCase().endsWith('.zip')) {
            this.rivetsData.lblError = 'Zip format not supported. Please uncompress first.';
            return;
        }

        // Write the ROM into the Emscripten virtual filesystem
        FS.writeFile('custom.gba', byteArray);

        this.beforeRun();

        // Load battery save if one exists
        await this.LoadBatterySave();

        // Start the emulator
        // NOTE: adjust Module.callMain args to match your GBA WASM build
        Module.callMain(['custom.gba']);

        this.findInDatabase();
        this.configureEmulator();

        $('#canvasDiv').show();
        this.rivetsData.beforeEmulatorStarted = false;

        // Wrap exported C functions — adjust names to match your GBA WASM build
        if (typeof Module.cwrap === 'function') {
            try { this.sendMobileControls = Module.cwrap('neil_send_mobile_controls', null, ['string','string','string']); } catch(e){}
            try { this.showToastFn        = Module.cwrap('neil_toast_message',        null, ['string']); } catch(e){}
        }

        this.afterRun();
    }

    beforeRun() {}
    afterRun()  {}

    showToast(msg) {
        toastr.info(msg);
        if (this.showToastFn) this.showToastFn(msg);
    }

    // Called by WASM when a save state has been serialized to /savestate.gz
    SaveStateEvent() {
        this.hideMobileMenu();
        let compressed = FS.readFile('/savestate.gz');
        this.saveToDatabase(compressed);
    }

    // Triggered by the WASM module each frame to sync battery SRAM to DB
    SaveBatterySaveEvent() {
        let data = FS.readFile('/game.sav');
        this._putDB(this.rom_name + '.sav', data, () => {}, () => {});
    }

    // ── SAVE STATES ──────────────────────────────────────────────────────────

    saveStateLocal() {
        this.rivetsData.noLocalSave = false;
        // Trigger serialization in the WASM module — it will call back SaveStateEvent()
        Module._neil_serialize();
    }

    loadStateLocal() {
        this.loadFromDatabase();
    }

    saveToDatabase(data) {
        if (!window['indexedDB']) return;
        this._putDB(this.rom_name, data,
            () => { toastr.info('State Saved'); this.rivetsData.noLocalSave = false; },
            () => toastr.error('Error saving state'));
    }

    loadFromDatabase() {
        this._getDB(this.rom_name, (byteArray) => {
            FS.writeFile('/savestate.gz', byteArray);
            Module._neil_unserialize();
        }, () => toastr.error('No save state found'));
    }

    // ── BATTERY SAVE ─────────────────────────────────────────────────────────

    async LoadBatterySave() {
        return new Promise((resolve) => {
            this._getDB(this.rom_name + '.sav', (data) => {
                try { FS.writeFile('/game.sav', data); } catch(e){}
                resolve();
            }, resolve);
        });
    }

    // ── INDEXED DB ───────────────────────────────────────────────────────────

    createDB() {
        if (!window['indexedDB']) { console.log('indexedDB not available'); return; }
        var req = indexedDB.open('GBAWASMDB');
        req.onupgradeneeded = (ev) => {
            let db = ev.target.result;
            db.createObjectStore('GBAWASMSTATES', { autoIncrement: true });
        };
        req.onsuccess = (ev) => {
            var db = ev.target.result;
            var store = db.transaction('GBAWASMSTATES', 'readwrite').objectStore('GBAWASMSTATES');
            store.openCursor().onsuccess = (ev) => {
                var cursor = ev.target.result;
                if (cursor) {
                    this.dblist.push(cursor.key.toString());
                    cursor.continue();
                }
            };
        };
    }

    findInDatabase() {
        this._getDB(this.rom_name, () => {
            this.rivetsData.noLocalSave = false;
        }, () => {});
    }

    _putDB(key, data, onSuccess, onError) {
        var req = indexedDB.open('GBAWASMDB');
        req.onsuccess = (ev) => {
            var db = ev.target.result;
            var store = db.transaction('GBAWASMSTATES', 'readwrite').objectStore('GBAWASMSTATES');
            var r = store.put(data, key);
            r.onsuccess = onSuccess;
            r.onerror = onError;
        };
        req.onerror = onError;
    }

    _getDB(key, onFound, onMissing) {
        var req = indexedDB.open('GBAWASMDB');
        req.onsuccess = (ev) => {
            var db = ev.target.result;
            var store = db.transaction('GBAWASMSTATES', 'readwrite').objectStore('GBAWASMSTATES');
            var r = store.get(key);
            r.onsuccess = (ev) => {
                if (r.result) onFound(r.result);
                else onMissing();
            };
            r.onerror = onMissing;
        };
        req.onerror = onMissing;
    }

    // ── ROM FILE HANDLING ─────────────────────────────────────────────────────

    uploadBrowse() {
        document.getElementById('file-upload').click();
    }

    uploadRom(event) {
        var file = event.currentTarget.files[0];
        myClass.rom_name = file.name;
        var reader = new FileReader();
        reader.onload = (e) => {
            myClass.LoadEmulator(new Uint8Array(e.target.result));
        };
        reader.readAsArrayBuffer(file);
    }

    async loadRom() {
        let romurl = document.getElementById('romselect')['value'];
        this.rom_name = this.extractRomName(romurl);
        this.load_url(romurl);
    }

    load_url(path) {
        var req = new XMLHttpRequest();
        req.open('GET', path);
        req.responseType = 'arraybuffer';
        req.onerror = () => console.log('Error loading', path);
        req.onload = () => {
            if (req.response) {
                myClass.LoadEmulator(new Uint8Array(req.response));
            }
        };
        req.send();
    }

    extractRomName(name) {
        if (name.includes('/')) name = name.substr(name.lastIndexOf('/') + 1);
        return name;
    }

    setupDragDropRom() {
        let dropArea = document.getElementById('dropArea');
        ['dragenter','dragover','dragleave','drop'].forEach(evt =>
            dropArea.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); }, false)
        );
        dropArea.addEventListener('dragenter', () => $('#dropArea').css({'background-color':'lightblue'}), false);
        dropArea.addEventListener('dragleave', () => $('#dropArea').css({'background-color':'inherit'}), false);
        dropArea.addEventListener('drop', (e) => {
            let file = e.dataTransfer.files[0];
            myClass.rom_name = file.name;
            var reader = new FileReader();
            reader.onload = (ev) => myClass.LoadEmulator(new Uint8Array(ev.target.result));
            reader.readAsArrayBuffer(file);
        }, false);
    }

    // ── CANVAS ────────────────────────────────────────────────────────────────

    resizeCanvas() {
        $('#canvas').width(this.rivetsData.canvasSize);
    }

    zoomOut() {
        this.rivetsData.canvasSize = Math.max(160, this.rivetsData.canvasSize - 40);
        localStorage.setItem('gbawasm-size', this.rivetsData.canvasSize.toString());
        this.resizeCanvas();
    }

    zoomIn() {
        this.rivetsData.canvasSize += 40;
        localStorage.setItem('gbawasm-size', this.rivetsData.canvasSize.toString());
        this.resizeCanvas();
    }

    fullscreen() {
        try {
            let el = document.getElementById('canvas');
            this.rivetsData.hadFullscreen = true;
            (el.webkitRequestFullScreen || el.mozRequestFullScreen || el.requestFullscreen).call(el);
        } catch(e) { console.log('fullscreen failed'); }
    }

    newRom() { location.reload(); }

    configureEmulator() {
        let size = localStorage.getItem('gbawasm-size');
        if (size) this.rivetsData.canvasSize = parseInt(size);
        if (this.mobileMode) this.setupMobileMode();
        this.resizeCanvas();
    }

    setupMobileMode() {
        this.rivetsData.canvasSize = window.innerWidth;
        $('#btnHideMenu').show();
        let halfWidth = (window.innerWidth / 2) - 35;
        document.getElementById('menuDiv').style.left = halfWidth + 'px';
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
        if (this.mobileMode) {
            $('#mobileButtons').hide();
            $('#menuDiv').show();
        }
    }

    // ── MODULE INIT ───────────────────────────────────────────────────────────

    async initModule() {
        console.log('GBA module initialized');
        myClass.rivetsData.moduleInitializing = false;
    }

    retrieveSettings() {
        let size = localStorage.getItem('gbawasm-size');
        if (size) this.rivetsData.canvasSize = parseInt(size);
    }

    // ── REMAP ─────────────────────────────────────────────────────────────────

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

    btnRemapKey(buttonNum) {
        this.rivetsData.remapMode = 'key';
        this.rivetsData.currKey = buttonNum;
        this.rivetsData.remapWait = true;
        this.rivetsData.inputController.Key_Last = '';
        this.rivetsData.inputController.Remap_Check = true;
    }

    btnRemapJoy(buttonNum) {
        this.rivetsData.remapMode = 'joy';
        this.rivetsData.currJoy = buttonNum;
        this.rivetsData.remapWait = true;
        this.rivetsData.inputController.Joy_Last = null;
        this.rivetsData.inputController.Remap_Check = true;
    }

    remapPressed() {
        const m = this.rivetsData.remapMode;
        const num = m === 'key' ? this.rivetsData.currKey : this.rivetsData.currJoy;
        const val = m === 'key' ? this.rivetsData.inputController.Key_Last : this.rivetsData.inputController.Joy_Last;
        const prefix = m === 'key' ? 'Mapping_' : 'Joy_Mapping_';

        const map = {
            1: prefix + 'Up',
            2: prefix + 'Down',
            3: prefix + 'Left',
            4: prefix + 'Right',
            5: prefix + 'Action_A',
            6: prefix + 'Action_B',
            7: prefix + 'Action_Start',
            8: prefix + 'Action_Select',
            9: prefix + 'Action_L',
            10: prefix + 'Action_R',
            11: prefix + 'Menu',
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

window['Module'] = {
    onRuntimeInitialized: myClass.initModule.bind(myClass),
    canvas: document.getElementById('canvas'),
    print: (text) => console.log('[GBA]', text),
};

// Load input controller (which then loads gbawasm.js)
var rando2 = Math.floor(Math.random() * 100000);
var icScript = document.createElement('script');
icScript.src = 'gba/gbaWasm/dist/input_controller.js?v=' + rando2;
document.getElementsByTagName('head')[0].appendChild(icScript);
