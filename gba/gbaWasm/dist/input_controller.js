
class InputController {

    constructor() {

        this.DebugKeycodes = false;

        // for remapping
        this.Key_Last = '';
        this.Joy_Last = null;
        this.Remap_Check = false;

        // GBA buttons
        this.Key_Up = false;
        this.Key_Down = false;
        this.Key_Left = false;
        this.Key_Right = false;
        this.Key_Action_A = false;
        this.Key_Action_B = false;
        this.Key_Action_Start = false;
        this.Key_Action_Select = false;
        this.Key_Action_L = false;
        this.Key_Action_R = false;
        this.Key_Menu = false;

        // mobile touch
        this.MobileA = false;
        this.MobileB = false;
        this.MobileStart = false;
        this.MobileSelect = false;
        this.MobileL = false;
        this.MobileR = false;

        this.nippleDirection = 'none';
        this.VectorX = 0;
        this.VectorY = 0;

        this.KeyMappings = this.defaultKeymappings();
        document.onkeydown = this.keyDown.bind(this);
        document.onkeyup = this.keyUp.bind(this);

        this.setGamePadButtons();
    }

    defaultKeymappings() {
        return {
            Mapping_Left: 'ArrowLeft',
            Mapping_Right: 'ArrowRight',
            Mapping_Up: 'ArrowUp',
            Mapping_Down: 'ArrowDown',
            Mapping_Action_A: 'm',
            Mapping_Action_B: 'n',
            Mapping_Action_Start: 'Enter',
            Mapping_Action_Select: 'v',
            Mapping_Action_L: 'q',
            Mapping_Action_R: 'e',
            Mapping_Menu: '`',
            Joy_Mapping_Left: 14,
            Joy_Mapping_Right: 15,
            Joy_Mapping_Down: 13,
            Joy_Mapping_Up: 12,
            Joy_Mapping_Action_A: 0,
            Joy_Mapping_Action_B: 1,
            Joy_Mapping_Action_Start: 9,
            Joy_Mapping_Action_Select: 8,
            Joy_Mapping_Action_L: 4,
            Joy_Mapping_Action_R: 5,
            Joy_Mapping_Menu: 11,
        };
    }

    setupMobileControls(touch_element_id) {
        if (touch_element_id) {
            this.manager = nipplejs.create({
                zone: document.getElementById(touch_element_id),
                color: 'darkgray',
                mode: 'dynamic',
            });

            this.manager.on('move', (evt, data) => {
                window['myApp'].rivetsData.hadNipple = true;
                this.VectorX = data.vector.x;
                this.VectorY = data.vector.y;
            });

            this.manager.on('end', () => {
                this.Key_Left = false;
                this.Key_Right = false;
                this.Key_Up = false;
                this.Key_Down = false;
                this.VectorX = 0;
                this.VectorY = 0;
            });

            document.getElementById(touch_element_id).addEventListener('touchstart', e => e.preventDefault(), false);
            document.getElementById(touch_element_id).addEventListener('touchend', e => e.preventDefault(), false);
            document.getElementById(touch_element_id).addEventListener('touchmove', e => e.preventDefault(), false);

            const bind = (id, press, release) => {
                document.getElementById(id).addEventListener('touchstart', press.bind(this), false);
                document.getElementById(id).addEventListener('touchend', release.bind(this), false);
                document.getElementById(id).addEventListener('touchmove', e => e.preventDefault(), false);
            };

            bind('mobileA',      this.mobilePressA,      this.mobileReleaseA);
            bind('mobileB',      this.mobilePressB,      this.mobileReleaseB);
            bind('mobileStart',  this.mobilePressStart,  this.mobileReleaseStart);
            bind('mobileSelect', this.mobilePressSelect, this.mobileReleaseSelect);
            bind('mobileL',      this.mobilePressL,      this.mobileReleaseL);
            bind('mobileR',      this.mobilePressR,      this.mobileReleaseR);

            document.getElementById('menuDiv').addEventListener('touchstart', this.menuTouch.bind(this), false);
        }
    }

    menuTouch() {
        $('#mobileButtons').show();
        $('#menuDiv').hide();
    }

    mobilePressA(e)      { e.preventDefault(); this.Key_Action_A = true;      this.MobileA = true; }
    mobilePressB(e)      { e.preventDefault(); this.Key_Action_B = true;      this.MobileB = true; }
    mobilePressStart(e)  { e.preventDefault(); this.Key_Action_Start = true;  this.MobileStart = true; }
    mobilePressSelect(e) { e.preventDefault(); this.Key_Action_Select = true; this.MobileSelect = true; }
    mobilePressL(e)      { e.preventDefault(); this.Key_Action_L = true;      this.MobileL = true; }
    mobilePressR(e)      { e.preventDefault(); this.Key_Action_R = true;      this.MobileR = true; }

    mobileReleaseA(e)      { e.preventDefault(); this.Key_Action_A = false;      this.MobileA = false; }
    mobileReleaseB(e)      { e.preventDefault(); this.Key_Action_B = false;      this.MobileB = false; }
    mobileReleaseStart(e)  { e.preventDefault(); this.Key_Action_Start = false;  this.MobileStart = false; }
    mobileReleaseSelect(e) { e.preventDefault(); this.Key_Action_Select = false; this.MobileSelect = false; }
    mobileReleaseL(e)      { e.preventDefault(); this.Key_Action_L = false;      this.MobileL = false; }
    mobileReleaseR(e)      { e.preventDefault(); this.Key_Action_R = false;      this.MobileR = false; }

    setGamePadButtons() {
        this.gamepadButtons = [];
    }

    setupGamePad() {
        window.addEventListener('gamepadconnected', e => {
            console.log('Gamepad connected:', e.gamepad.id);
        });
    }

    processGamepad() {
        try {
            var gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
            if (!gamepads) return;
            var gp = null;
            for (let i = 0; i < gamepads.length; i++) {
                if (gamepads[i] && gamepads[i].buttons.length > 0)
                    gp = gamepads[i];
            }
            if (gp) {
                for (let i = 0; i < gp.buttons.length; i++) {
                    if (this.DebugKeycodes && gp.buttons[i].pressed) console.log('joy:', i);
                    if (gp.buttons[i].pressed) this.Joy_Last = i;
                }

                const btn = (n) => n >= 0 && gp.buttons[n] && gp.buttons[n].pressed;

                const set = (flag, joyBtn, keyMapping) => {
                    if (btn(joyBtn)) {
                        if (!this[flag]) this.sendKeyDownEvent(this.KeyMappings[keyMapping]);
                    } else {
                        if (this[flag]) this.sendKeyUpEvent(this.KeyMappings[keyMapping]);
                    }
                };

                set('Key_Up',           this.KeyMappings.Joy_Mapping_Up,            'Mapping_Up');
                set('Key_Down',         this.KeyMappings.Joy_Mapping_Down,          'Mapping_Down');
                set('Key_Left',         this.KeyMappings.Joy_Mapping_Left,          'Mapping_Left');
                set('Key_Right',        this.KeyMappings.Joy_Mapping_Right,         'Mapping_Right');
                set('Key_Action_A',     this.KeyMappings.Joy_Mapping_Action_A,      'Mapping_Action_A');
                set('Key_Action_B',     this.KeyMappings.Joy_Mapping_Action_B,      'Mapping_Action_B');
                set('Key_Action_Start', this.KeyMappings.Joy_Mapping_Action_Start,  'Mapping_Action_Start');
                set('Key_Action_Select',this.KeyMappings.Joy_Mapping_Action_Select, 'Mapping_Action_Select');
                set('Key_Action_L',     this.KeyMappings.Joy_Mapping_Action_L,      'Mapping_Action_L');
                set('Key_Action_R',     this.KeyMappings.Joy_Mapping_Action_R,      'Mapping_Action_R');

                // Axes for D-pad analog fallback
                try {
                    let hx = gp.axes[0], vy = gp.axes[1];
                    if (hx < -.5) { if (!this.Key_Left)  this.sendKeyDownEvent(this.KeyMappings.Mapping_Left); }
                    else           { if (this.Key_Left)   this.sendKeyUpEvent(this.KeyMappings.Mapping_Left); }
                    if (hx >  .5) { if (!this.Key_Right) this.sendKeyDownEvent(this.KeyMappings.Mapping_Right); }
                    else           { if (this.Key_Right)  this.sendKeyUpEvent(this.KeyMappings.Mapping_Right); }
                    if (vy >  .5) { if (!this.Key_Down)  this.sendKeyDownEvent(this.KeyMappings.Mapping_Down); }
                    else           { if (this.Key_Down)   this.sendKeyUpEvent(this.KeyMappings.Mapping_Down); }
                    if (vy < -.5) { if (!this.Key_Up)    this.sendKeyDownEvent(this.KeyMappings.Mapping_Up); }
                    else           { if (this.Key_Up)     this.sendKeyUpEvent(this.KeyMappings.Mapping_Up); }
                } catch (e) {}
            }
        } catch (e) {}
    }

    sendKeyDownEvent(key) {
        let ev = new KeyboardEvent('Gamepad Event Down', { key });
        this.keyDown(ev);
    }

    sendKeyUpEvent(key) {
        let ev = new KeyboardEvent('Gamepad Event Up', { key });
        this.keyUp(ev);
    }

    _normalizeArrow(event) {
        let key = event.key;
        if (key === 'Left'  && this.KeyMappings.Mapping_Left  === 'ArrowLeft')  key = 'ArrowLeft';
        if (key === 'Right' && this.KeyMappings.Mapping_Right === 'ArrowRight') key = 'ArrowRight';
        if (key === 'Up'    && this.KeyMappings.Mapping_Up    === 'ArrowUp')    key = 'ArrowUp';
        if (key === 'Down'  && this.KeyMappings.Mapping_Down  === 'ArrowDown')  key = 'ArrowDown';
        return key;
    }

    keyDown(event) {
        let ic = this;
        const key = ic._normalizeArrow(event);
        ic.Key_Last = key;
        if (ic.DebugKeycodes) console.log('key:', key);

        if (key === ic.KeyMappings.Mapping_Up)            ic.Key_Up = true;
        if (key === ic.KeyMappings.Mapping_Down)          ic.Key_Down = true;
        if (key === ic.KeyMappings.Mapping_Left)          ic.Key_Left = true;
        if (key === ic.KeyMappings.Mapping_Right)         ic.Key_Right = true;
        if (key === ic.KeyMappings.Mapping_Action_A)      ic.Key_Action_A = true;
        if (key === ic.KeyMappings.Mapping_Action_B)      ic.Key_Action_B = true;
        if (key === ic.KeyMappings.Mapping_Action_Start)  ic.Key_Action_Start = true;
        if (key === ic.KeyMappings.Mapping_Action_Select) ic.Key_Action_Select = true;
        if (key === ic.KeyMappings.Mapping_Action_L)      ic.Key_Action_L = true;
        if (key === ic.KeyMappings.Mapping_Action_R)      ic.Key_Action_R = true;
        if (key === ic.KeyMappings.Mapping_Menu)          ic.Key_Menu = true;
    }

    keyUp(event) {
        let ic = this;
        const key = ic._normalizeArrow(event);

        if (key === ic.KeyMappings.Mapping_Up)            ic.Key_Up = false;
        if (key === ic.KeyMappings.Mapping_Down)          ic.Key_Down = false;
        if (key === ic.KeyMappings.Mapping_Left)          ic.Key_Left = false;
        if (key === ic.KeyMappings.Mapping_Right)         ic.Key_Right = false;
        if (key === ic.KeyMappings.Mapping_Action_A)      ic.Key_Action_A = false;
        if (key === ic.KeyMappings.Mapping_Action_B)      ic.Key_Action_B = false;
        if (key === ic.KeyMappings.Mapping_Action_Start)  ic.Key_Action_Start = false;
        if (key === ic.KeyMappings.Mapping_Action_Select) ic.Key_Action_Select = false;
        if (key === ic.KeyMappings.Mapping_Action_L)      ic.Key_Action_L = false;
        if (key === ic.KeyMappings.Mapping_Action_R)      ic.Key_Action_R = false;
        if (key === ic.KeyMappings.Mapping_Menu)          ic.Key_Menu = false;
    }

    update() {
        this.processGamepad();
        if (this.Remap_Check) {
            if (this.Key_Last !== '' || this.Joy_Last !== null) {
                window['myApp'].remapPressed();
                this.Remap_Check = false;
            }
        }
    }

    // Called each emulator frame — maps current state into a string for the WASM module.
    // Bit order matches what the GBA emulator expects (adapt if needed).
    updateMobileControls() {
        let s = '';
        s += this.Key_Up            ? '1' : '0'; // UP
        s += this.Key_Down          ? '1' : '0'; // DOWN
        s += this.Key_Left          ? '1' : '0'; // LEFT
        s += this.Key_Right         ? '1' : '0'; // RIGHT
        s += this.Key_Action_A      ? '1' : '0'; // A
        s += this.Key_Action_B      ? '1' : '0'; // B
        s += this.Key_Action_Start  ? '1' : '0'; // START
        s += this.Key_Action_Select ? '1' : '0'; // SELECT
        s += this.Key_Action_L      ? '1' : '0'; // L
        s += this.Key_Action_R      ? '1' : '0'; // R
        window['myApp'].sendMobileControls(s, this.VectorX.toString(), this.VectorY.toString());
    }
}

window['myApp'].setupInputController();

// Load the GBA WASM emulator binary (place gbawasm.js + gbawasm.wasm in gba/gbaWasm/dist/)
var rando3 = Math.floor(Math.random() * 100000);
var wasmScript = document.createElement('script');
wasmScript.src = 'gba/gbaWasm/dist/44gba.js?v=' + rando3;
document.getElementsByTagName('head')[0].appendChild(wasmScript);
