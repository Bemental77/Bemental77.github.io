// ─── PS1 Input Controller ─────────────────────────────────────────────────────
// DualShock layout: D-pad, ✕ ○ □ △, L1 L2 R1 R2, Start, Select, L3, R3,
// left analog stick, right analog stick.
//
// PS1_KEY bitmask matches standard PSX digital controller word (active-high).
// The actual bits expected by the WASM emulator must match its input API —
// adjust PS1_KEY values to match the compiled module's expected format.

const PS1_KEY = {
    SELECT:   0x0001,
    L3:       0x0002,
    R3:       0x0004,
    START:    0x0008,
    UP:       0x0010,
    RIGHT:    0x0020,
    DOWN:     0x0040,
    LEFT:     0x0080,
    L2:       0x0100,
    R2:       0x0200,
    L1:       0x0400,
    R1:       0x0800,
    TRIANGLE: 0x1000,
    CIRCLE:   0x2000,
    CROSS:    0x4000,
    SQUARE:   0x8000,
};

class InputController {

    constructor() {

        this.DebugKeycodes = false

        this.Key_Last = ''
        this.Joy_Last = null
        this.Remap_Check = false

        this.Key_Up = false
        this.Key_Down = false
        this.Key_Left = false
        this.Key_Right = false

        // PS1 face buttons
        this.Key_Action_Cross    = false
        this.Key_Action_Circle   = false
        this.Key_Action_Square   = false
        this.Key_Action_Triangle = false

        // Shoulder buttons
        this.Key_Action_L1 = false
        this.Key_Action_R1 = false
        this.Key_Action_L2 = false
        this.Key_Action_R2 = false

        this.Key_Action_Start  = false
        this.Key_Action_Select = false

        // Stick clicks (L3/R3)
        this.Key_Action_L3 = false
        this.Key_Action_R3 = false

        this.Key_Menu = false

        // Mobile touch flags (mirrored from Key_Action_* for held-button visuals)
        this.MobileCross    = false
        this.MobileCircle   = false
        this.MobileSquare   = false
        this.MobileTriangle = false
        this.MobileL1       = false
        this.MobileR1       = false
        this.MobileL2       = false
        this.MobileR2       = false
        this.MobileStart    = false
        this.MobileSelect   = false

        // Left analog stick vector (from gamepad axes 0/1)
        this.VectorX = 0
        this.VectorY = 0
        // Right analog stick (axes 2/3) — available for games that poll it
        this.RightVectorX = 0
        this.RightVectorY = 0

        this.nippleDirection = 'none'

        this.KeyMappings = this.defaultKeymappings()

        document.onkeydown = this.keyDown.bind(this)
        document.onkeyup   = this.keyUp.bind(this)

        this.setGamePadButtons()
        this.setupGamePad()
        this.startGamepadLoop()
    }

    defaultKeymappings() {
        return {
            Mapping_Left:             'ArrowLeft',
            Mapping_Right:            'ArrowRight',
            Mapping_Up:               'ArrowUp',
            Mapping_Down:             'ArrowDown',

            // Face buttons: Cross=confirm, Circle=back (PlayStation convention)
            Mapping_Action_Cross:     'm',
            Mapping_Action_Circle:    'n',
            Mapping_Action_Square:    'v',
            Mapping_Action_Triangle:  'b',

            Mapping_Action_L1:        'q',
            Mapping_Action_R1:        'e',
            Mapping_Action_L2:        '1',
            Mapping_Action_R2:        '3',

            Mapping_Action_Start:     'Enter',
            Mapping_Action_Select:    'Backspace',

            Mapping_Action_L3:        'z',
            Mapping_Action_R3:        'x',

            Mapping_Menu:             '`',

            // Standard Gamepad API button indices (DualShock / DualSense via browser)
            Joy_Mapping_Left:              14,
            Joy_Mapping_Right:             15,
            Joy_Mapping_Down:              13,
            Joy_Mapping_Up:                12,

            Joy_Mapping_Action_Cross:      0,
            Joy_Mapping_Action_Circle:     1,
            Joy_Mapping_Action_Square:     2,
            Joy_Mapping_Action_Triangle:   3,

            Joy_Mapping_Action_L1:         4,
            Joy_Mapping_Action_R1:         5,
            Joy_Mapping_Action_L2:         6,
            Joy_Mapping_Action_R2:         7,

            Joy_Mapping_Action_Select:     8,
            Joy_Mapping_Action_Start:      9,

            Joy_Mapping_Action_L3:         10,
            Joy_Mapping_Action_R3:         11,

            Joy_Mapping_Menu:              16
        }
    }

    setupGamePad() {
        window.addEventListener('gamepadconnected', e => {
            console.log('Gamepad connected:', e.gamepad.id)
        })
    }

    setGamePadButtons() {
        this.gamepadButtons = []
    }

    startGamepadLoop() {
        const loop = () => {
            this.processGamepad()
            this.frameId = requestAnimationFrame(loop)
        }
        this.frameId = requestAnimationFrame(loop)
    }

    stopGamepadLoop() {
        if (this.frameId) cancelAnimationFrame(this.frameId)
    }

    processGamepad() {
        try {
            const gamepads = navigator.getGamepads ? navigator.getGamepads() : []
            if (!gamepads) return

            let gp = null
            for (let i = 0; i < gamepads.length; i++) {
                if (gamepads[i] && gamepads[i].buttons.length > 0) { gp = gamepads[i]; break; }
            }
            if (!gp) return

            for (let i = 0; i < gp.buttons.length; i++) {
                if (this.DebugKeycodes && gp.buttons[i].pressed) console.log('joy:', i)
                if (gp.buttons[i].pressed) this.Joy_Last = i
            }

            const btn = n => n >= 0 && gp.buttons[n] && gp.buttons[n].pressed

            const set = (flag, joyBtn, keyMapping) => {
                if (btn(joyBtn)) {
                    if (!this[flag]) this.sendKeyDownEvent(this.KeyMappings[keyMapping])
                } else {
                    if (this[flag]) this.sendKeyUpEvent(this.KeyMappings[keyMapping])
                }
            }

            set('Key_Up',               this.KeyMappings.Joy_Mapping_Up,               'Mapping_Up')
            set('Key_Down',             this.KeyMappings.Joy_Mapping_Down,             'Mapping_Down')
            set('Key_Left',             this.KeyMappings.Joy_Mapping_Left,             'Mapping_Left')
            set('Key_Right',            this.KeyMappings.Joy_Mapping_Right,            'Mapping_Right')
            set('Key_Action_Cross',     this.KeyMappings.Joy_Mapping_Action_Cross,     'Mapping_Action_Cross')
            set('Key_Action_Circle',    this.KeyMappings.Joy_Mapping_Action_Circle,    'Mapping_Action_Circle')
            set('Key_Action_Square',    this.KeyMappings.Joy_Mapping_Action_Square,    'Mapping_Action_Square')
            set('Key_Action_Triangle',  this.KeyMappings.Joy_Mapping_Action_Triangle,  'Mapping_Action_Triangle')
            set('Key_Action_L1',        this.KeyMappings.Joy_Mapping_Action_L1,        'Mapping_Action_L1')
            set('Key_Action_R1',        this.KeyMappings.Joy_Mapping_Action_R1,        'Mapping_Action_R1')
            set('Key_Action_L2',        this.KeyMappings.Joy_Mapping_Action_L2,        'Mapping_Action_L2')
            set('Key_Action_R2',        this.KeyMappings.Joy_Mapping_Action_R2,        'Mapping_Action_R2')
            set('Key_Action_Start',     this.KeyMappings.Joy_Mapping_Action_Start,     'Mapping_Action_Start')
            set('Key_Action_Select',    this.KeyMappings.Joy_Mapping_Action_Select,    'Mapping_Action_Select')
            set('Key_Action_L3',        this.KeyMappings.Joy_Mapping_Action_L3,        'Mapping_Action_L3')
            set('Key_Action_R3',        this.KeyMappings.Joy_Mapping_Action_R3,        'Mapping_Action_R3')

            // Left analog stick — axes 0/1
            try {
                const hx = gp.axes[0] || 0
                const vy = gp.axes[1] || 0

                if (hx < -0.35) {
                    if (!this.Key_Left)  this.sendKeyDownEvent(this.KeyMappings.Mapping_Left)
                } else {
                    if (this.Key_Left)   this.sendKeyUpEvent(this.KeyMappings.Mapping_Left)
                }
                if (hx > 0.35) {
                    if (!this.Key_Right) this.sendKeyDownEvent(this.KeyMappings.Mapping_Right)
                } else {
                    if (this.Key_Right)  this.sendKeyUpEvent(this.KeyMappings.Mapping_Right)
                }
                if (vy > 0.35) {
                    if (!this.Key_Down)  this.sendKeyDownEvent(this.KeyMappings.Mapping_Down)
                } else {
                    if (this.Key_Down)   this.sendKeyUpEvent(this.KeyMappings.Mapping_Down)
                }
                if (vy < -0.35) {
                    if (!this.Key_Up)    this.sendKeyDownEvent(this.KeyMappings.Mapping_Up)
                } else {
                    if (this.Key_Up)     this.sendKeyUpEvent(this.KeyMappings.Mapping_Up)
                }

                this.VectorX = hx
                this.VectorY = vy

                // Right analog stick — axes 2/3 (stored for emulator use)
                this.RightVectorX = gp.axes[2] || 0
                this.RightVectorY = gp.axes[3] || 0
            } catch (e) { }

        } catch (e) { }
    }

    setupMobileControls(touch_element_id) {
        if (!touch_element_id) return

        this.manager = nipplejs.create({
            zone: document.getElementById(touch_element_id),
            color: 'darkgray',
            mode: 'dynamic'
        })

        this.manager.on('move', (evt, data) => {
            window['myApp'].rivetsData.hadNipple = true
            this.VectorX = data.vector.x
            this.VectorY = data.vector.y
        })

        this.manager.on('end', () => {
            this.Key_Left = false
            this.Key_Right = false
            this.Key_Up = false
            this.Key_Down = false
            this.VectorX = 0
            this.VectorY = 0
        })

        const el = document.getElementById(touch_element_id)
        el.addEventListener('touchstart', e => e.preventDefault(), false)
        el.addEventListener('touchend',   e => e.preventDefault(), false)
        el.addEventListener('touchmove',  e => e.preventDefault(), false)

        const bind = (id, press, release) => {
            const node = document.getElementById(id)
            if (!node) return
            node.addEventListener('touchstart', press.bind(this),   false)
            node.addEventListener('touchend',   release.bind(this), false)
            node.addEventListener('touchmove',  e => e.preventDefault(), false)
        }

        bind('mobileCross',    this.mobilePressCross,    this.mobileReleaseCross)
        bind('mobileCircle',   this.mobilePressCircle,   this.mobileReleaseCircle)
        bind('mobileSquare',   this.mobilePressSquare,   this.mobileReleaseSquare)
        bind('mobileTriangle', this.mobilePressTriangle, this.mobileReleaseTriangle)
        bind('mobileL1',       this.mobilePressL1,       this.mobileReleaseL1)
        bind('mobileR1',       this.mobilePressR1,       this.mobileReleaseR1)
        bind('mobileL2',       this.mobilePressL2,       this.mobileReleaseL2)
        bind('mobileR2',       this.mobilePressR2,       this.mobileReleaseR2)
        bind('mobileStart',    this.mobilePressStart,    this.mobileReleaseStart)
        bind('mobileSelect',   this.mobilePressSelect,   this.mobileReleaseSelect)

        const menu = document.getElementById('menuDiv')
        if (menu) menu.addEventListener('touchstart', this.menuTouch.bind(this), false)
    }

    menuTouch() {
        $('#mobileButtons').show()
        $('#menuDiv').hide()
    }

    mobilePressStart(e)    { e.preventDefault(); this.Key_Action_Start    = true;  this.MobileStart    = true  }
    mobilePressSelect(e)   { e.preventDefault(); this.Key_Action_Select   = true;  this.MobileSelect   = true  }
    mobilePressCross(e)    { e.preventDefault(); this.Key_Action_Cross    = true;  this.MobileCross    = true  }
    mobilePressCircle(e)   { e.preventDefault(); this.Key_Action_Circle   = true;  this.MobileCircle   = true  }
    mobilePressSquare(e)   { e.preventDefault(); this.Key_Action_Square   = true;  this.MobileSquare   = true  }
    mobilePressTriangle(e) { e.preventDefault(); this.Key_Action_Triangle = true;  this.MobileTriangle = true  }
    mobilePressL1(e)       { e.preventDefault(); this.Key_Action_L1       = true;  this.MobileL1       = true  }
    mobilePressR1(e)       { e.preventDefault(); this.Key_Action_R1       = true;  this.MobileR1       = true  }
    mobilePressL2(e)       { e.preventDefault(); this.Key_Action_L2       = true;  this.MobileL2       = true  }
    mobilePressR2(e)       { e.preventDefault(); this.Key_Action_R2       = true;  this.MobileR2       = true  }

    mobileReleaseStart(e)    { e.preventDefault(); this.Key_Action_Start    = false; this.MobileStart    = false }
    mobileReleaseSelect(e)   { e.preventDefault(); this.Key_Action_Select   = false; this.MobileSelect   = false }
    mobileReleaseCross(e)    { e.preventDefault(); this.Key_Action_Cross    = false; this.MobileCross    = false }
    mobileReleaseCircle(e)   { e.preventDefault(); this.Key_Action_Circle   = false; this.MobileCircle   = false }
    mobileReleaseSquare(e)   { e.preventDefault(); this.Key_Action_Square   = false; this.MobileSquare   = false }
    mobileReleaseTriangle(e) { e.preventDefault(); this.Key_Action_Triangle = false; this.MobileTriangle = false }
    mobileReleaseL1(e)       { e.preventDefault(); this.Key_Action_L1       = false; this.MobileL1       = false }
    mobileReleaseR1(e)       { e.preventDefault(); this.Key_Action_R1       = false; this.MobileR1       = false }
    mobileReleaseL2(e)       { e.preventDefault(); this.Key_Action_L2       = false; this.MobileL2       = false }
    mobileReleaseR2(e)       { e.preventDefault(); this.Key_Action_R2       = false; this.MobileR2       = false }

    sendKeyDownEvent(key) {
        const ev = new KeyboardEvent('Gamepad Event Down', { key })
        this.keyDown(ev)
    }

    sendKeyUpEvent(key) {
        const ev = new KeyboardEvent('Gamepad Event Up', { key })
        this.keyUp(ev)
    }

    _normalizeArrow(event) {
        let key = event.key
        if (key === 'Left'  && this.KeyMappings.Mapping_Left  === 'ArrowLeft')  key = 'ArrowLeft'
        if (key === 'Right' && this.KeyMappings.Mapping_Right === 'ArrowRight') key = 'ArrowRight'
        if (key === 'Up'    && this.KeyMappings.Mapping_Up    === 'ArrowUp')    key = 'ArrowUp'
        if (key === 'Down'  && this.KeyMappings.Mapping_Down  === 'ArrowDown')  key = 'ArrowDown'
        return key
    }

    keyDown(event) {
        const key = this._normalizeArrow(event)
        this.Key_Last = key

        if (key === this.KeyMappings.Mapping_Up)               this.Key_Up               = true
        if (key === this.KeyMappings.Mapping_Down)             this.Key_Down             = true
        if (key === this.KeyMappings.Mapping_Left)             this.Key_Left             = true
        if (key === this.KeyMappings.Mapping_Right)            this.Key_Right            = true
        if (key === this.KeyMappings.Mapping_Action_Cross)     this.Key_Action_Cross     = true
        if (key === this.KeyMappings.Mapping_Action_Circle)    this.Key_Action_Circle    = true
        if (key === this.KeyMappings.Mapping_Action_Square)    this.Key_Action_Square    = true
        if (key === this.KeyMappings.Mapping_Action_Triangle)  this.Key_Action_Triangle  = true
        if (key === this.KeyMappings.Mapping_Action_L1)        this.Key_Action_L1        = true
        if (key === this.KeyMappings.Mapping_Action_R1)        this.Key_Action_R1        = true
        if (key === this.KeyMappings.Mapping_Action_L2)        this.Key_Action_L2        = true
        if (key === this.KeyMappings.Mapping_Action_R2)        this.Key_Action_R2        = true
        if (key === this.KeyMappings.Mapping_Action_Start)     this.Key_Action_Start     = true
        if (key === this.KeyMappings.Mapping_Action_Select)    this.Key_Action_Select    = true
        if (key === this.KeyMappings.Mapping_Action_L3)        this.Key_Action_L3        = true
        if (key === this.KeyMappings.Mapping_Action_R3)        this.Key_Action_R3        = true
        if (key === this.KeyMappings.Mapping_Menu)             this.Key_Menu             = true
    }

    keyUp(event) {
        const key = this._normalizeArrow(event)

        if (key === this.KeyMappings.Mapping_Up)               this.Key_Up               = false
        if (key === this.KeyMappings.Mapping_Down)             this.Key_Down             = false
        if (key === this.KeyMappings.Mapping_Left)             this.Key_Left             = false
        if (key === this.KeyMappings.Mapping_Right)            this.Key_Right            = false
        if (key === this.KeyMappings.Mapping_Action_Cross)     this.Key_Action_Cross     = false
        if (key === this.KeyMappings.Mapping_Action_Circle)    this.Key_Action_Circle    = false
        if (key === this.KeyMappings.Mapping_Action_Square)    this.Key_Action_Square    = false
        if (key === this.KeyMappings.Mapping_Action_Triangle)  this.Key_Action_Triangle  = false
        if (key === this.KeyMappings.Mapping_Action_L1)        this.Key_Action_L1        = false
        if (key === this.KeyMappings.Mapping_Action_R1)        this.Key_Action_R1        = false
        if (key === this.KeyMappings.Mapping_Action_L2)        this.Key_Action_L2        = false
        if (key === this.KeyMappings.Mapping_Action_R2)        this.Key_Action_R2        = false
        if (key === this.KeyMappings.Mapping_Action_Start)     this.Key_Action_Start     = false
        if (key === this.KeyMappings.Mapping_Action_Select)    this.Key_Action_Select    = false
        if (key === this.KeyMappings.Mapping_Action_L3)        this.Key_Action_L3        = false
        if (key === this.KeyMappings.Mapping_Action_R3)        this.Key_Action_R3        = false
        if (key === this.KeyMappings.Mapping_Menu)             this.Key_Menu             = false
    }

    update() {
        this.processGamepad()

        if (this.Remap_Check) {
            if (this.Key_Last !== '' || this.Joy_Last !== null) {
                window['myApp'].remapPressed()
                this.Remap_Check = false
            }
        }
    }
}

window['myApp'].setupInputController()

// Dynamically load the PS1 WASM binary after the input controller is ready
var _ps1Rando = Math.floor(Math.random() * 100000)
var _ps1WasmScript = document.createElement('script')
_ps1WasmScript.src = 'ps1/ps1Wasm/dist/ps1wasm.js?v=' + _ps1Rando
document.getElementsByTagName('head')[0].appendChild(_ps1WasmScript)
