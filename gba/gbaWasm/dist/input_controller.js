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
        this.Key_Action_A = false
        this.Key_Action_B = false
        this.Key_Action_Start = false
        this.Key_Action_Select = false
        this.Key_Action_L = false
        this.Key_Action_R = false
        this.Key_Menu = false

        this.MobileA = false
        this.MobileB = false
        this.MobileStart = false
        this.MobileSelect = false
        this.MobileL = false
        this.MobileR = false

        this.nippleDirection = 'none'
        this.VectorX = 0
        this.VectorY = 0

        this.KeyMappings = this.defaultKeymappings()

        document.onkeydown = this.keyDown.bind(this)
        document.onkeyup = this.keyUp.bind(this)

        this.setGamePadButtons()
        this.setupGamePad()
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

            Joy_Mapping_Menu: 16
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

    processGamepad() {
        try {
            const gamepads = navigator.getGamepads ? navigator.getGamepads() : []
            if (!gamepads) return

            let gp = null
            for (let i = 0; i < gamepads.length; i++) {
                if (gamepads[i] && gamepads[i].buttons.length > 0) {
                    gp = gamepads[i]
                    break
                }
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

            set('Key_Action_A', this.KeyMappings.Joy_Mapping_Action_A, 'Mapping_Action_A')
            set('Key_Action_B', this.KeyMappings.Joy_Mapping_Action_B, 'Mapping_Action_B')
            set('Key_Action_Start', this.KeyMappings.Joy_Mapping_Action_Start, 'Mapping_Action_Start')
            set('Key_Action_Select', this.KeyMappings.Joy_Mapping_Action_Select, 'Mapping_Action_Select')
            set('Key_Action_L', this.KeyMappings.Joy_Mapping_Action_L, 'Mapping_Action_L')
            set('Key_Action_R', this.KeyMappings.Joy_Mapping_Action_R, 'Mapping_Action_R')

            let up = btn(this.KeyMappings.Joy_Mapping_Up)
            let down = btn(this.KeyMappings.Joy_Mapping_Down)
            let left = btn(this.KeyMappings.Joy_Mapping_Left)
            let right = btn(this.KeyMappings.Joy_Mapping_Right)

            const ax0 = gp.axes[0] || 0
            const ax1 = gp.axes[1] || 0

            if (ax0 < -0.35) left = true
            if (ax0 > 0.35) right = true
            if (ax1 < -0.35) up = true
            if (ax1 > 0.35) down = true

            if (up) {
                if (!this.Key_Up) this.sendKeyDownEvent(this.KeyMappings.Mapping_Up)
            } else {
                if (this.Key_Up) this.sendKeyUpEvent(this.KeyMappings.Mapping_Up)
            }

            if (down) {
                if (!this.Key_Down) this.sendKeyDownEvent(this.KeyMappings.Mapping_Down)
            } else {
                if (this.Key_Down) this.sendKeyUpEvent(this.KeyMappings.Mapping_Down)
            }

            if (left) {
                if (!this.Key_Left) this.sendKeyDownEvent(this.KeyMappings.Mapping_Left)
            } else {
                if (this.Key_Left) this.sendKeyUpEvent(this.KeyMappings.Mapping_Left)
            }

            if (right) {
                if (!this.Key_Right) this.sendKeyDownEvent(this.KeyMappings.Mapping_Right)
            } else {
                if (this.Key_Right) this.sendKeyUpEvent(this.KeyMappings.Mapping_Right)
            }

        } catch (e) {}
    }

    sendKeyDownEvent(key) {
        let ev = new KeyboardEvent('Gamepad Event Down', { key })
        this.keyDown(ev)
    }

    sendKeyUpEvent(key) {
        let ev = new KeyboardEvent('Gamepad Event Up', { key })
        this.keyUp(ev)
    }

    _normalizeArrow(event) {
        let key = event.key
        if (key === 'Left' && this.KeyMappings.Mapping_Left === 'ArrowLeft') key = 'ArrowLeft'
        if (key === 'Right' && this.KeyMappings.Mapping_Right === 'ArrowRight') key = 'ArrowRight'
        if (key === 'Up' && this.KeyMappings.Mapping_Up === 'ArrowUp') key = 'ArrowUp'
        if (key === 'Down' && this.KeyMappings.Mapping_Down === 'ArrowDown') key = 'ArrowDown'
        return key
    }

    keyDown(event) {
        const key = this._normalizeArrow(event)
        this.Key_Last = key

        if (key === this.KeyMappings.Mapping_Up) this.Key_Up = true
        if (key === this.KeyMappings.Mapping_Down) this.Key_Down = true
        if (key === this.KeyMappings.Mapping_Left) this.Key_Left = true
        if (key === this.KeyMappings.Mapping_Right) this.Key_Right = true
        if (key === this.KeyMappings.Mapping_Action_A) this.Key_Action_A = true
        if (key === this.KeyMappings.Mapping_Action_B) this.Key_Action_B = true
        if (key === this.KeyMappings.Mapping_Action_Start) this.Key_Action_Start = true
        if (key === this.KeyMappings.Mapping_Action_Select) this.Key_Action_Select = true
        if (key === this.KeyMappings.Mapping_Action_L) this.Key_Action_L = true
        if (key === this.KeyMappings.Mapping_Action_R) this.Key_Action_R = true
        if (key === this.KeyMappings.Mapping_Menu) this.Key_Menu = true
    }

    keyUp(event) {
        const key = this._normalizeArrow(event)

        if (key === this.KeyMappings.Mapping_Up) this.Key_Up = false
        if (key === this.KeyMappings.Mapping_Down) this.Key_Down = false
        if (key === this.KeyMappings.Mapping_Left) this.Key_Left = false
        if (key === this.KeyMappings.Mapping_Right) this.Key_Right = false
        if (key === this.KeyMappings.Mapping_Action_A) this.Key_Action_A = false
        if (key === this.KeyMappings.Mapping_Action_B) this.Key_Action_B = false
        if (key === this.KeyMappings.Mapping_Action_Start) this.Key_Action_Start = false
        if (key === this.KeyMappings.Mapping_Action_Select) this.Key_Action_Select = false
        if (key === this.KeyMappings.Mapping_Action_L) this.Key_Action_L = false
        if (key === this.KeyMappings.Mapping_Action_R) this.Key_Action_R = false
        if (key === this.KeyMappings.Mapping_Menu) this.Key_Menu = false
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

    updateMobileControls() {
        let s = ''
        s += this.Key_Up ? '1' : '0'
        s += this.Key_Down ? '1' : '0'
        s += this.Key_Left ? '1' : '0'
        s += this.Key_Right ? '1' : '0'
        s += this.Key_Action_A ? '1' : '0'
        s += this.Key_Action_B ? '1' : '0'
        s += this.Key_Action_Start ? '1' : '0'
        s += this.Key_Action_Select ? '1' : '0'
        s += this.Key_Action_L ? '1' : '0'
        s += this.Key_Action_R ? '1' : '0'
        window['myApp'].sendMobileControls(s, this.VectorX.toString(), this.VectorY.toString())
    }
}

window['myApp'].setupInputController()

var rando3 = Math.floor(Math.random() * 100000)
var wasmScript = document.createElement('script')
wasmScript.src = 'gba/gbaWasm/dist/44gba.js?v=' + rando3
document.getElementsByTagName('head')[0].appendChild(wasmScript)