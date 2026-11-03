// ─── GBA input: keyboard + gamepad → the held-button flags script.js reads once per emulated frame ─────────────────────────────
// This file only SETS FLAGS (Key_Up … Key_Action_R). script.js _getKeyMask() turns them into the 10-bit mask handed to
// core.setKeys() before each core.runFrame(); the on-screen SP controls in gba.html set the same flags.
//
// 2026-11-01 (stage GP, gba.html brought to the site's page standard): this file used to end by calling
// `window.myApp.setupInputController()` and was loaded by script.js with a random ?v= (so it was never cached). It is now a plain
// <script> in gba.html, content-versioned like the core files, and MyClass.setupInputController() constructs it. Also gone:
//   * setupMobileControls / menuTouch / mobilePress* / updateMobileControls — dead since the SP shell wires touch directly (they
//     needed nipplejs and jQuery, neither of which this page loads, and called a myApp.sendMobileControls that does not exist);
//   * the Remap_Check / Key_Last / Joy_Last hand-shake with the rivets remap modal — the remap panel in script.js captures its own
//     keystrokes and gamepad presses now (the n64 page's design), so the controller never has to know a remap is in progress.
class InputController {

    constructor() {

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

        this.KeyMappings = this.defaultKeymappings()

        document.onkeydown = this.keyDown.bind(this)
        document.onkeyup = this.keyUp.bind(this)

        this.setupGamePad()
        this.startGamepadLoop()
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
            // Nothing reads Key_Menu (script.js has no menu hotkey); the mapping is kept so a visitor's saved mappings still load.
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

    // A pad only ever RELEASES what a pad pressed. The flags are shared with the keyboard and the on-screen controls, and an idle
    // pad that is merely plugged in must not cancel them: this used to send a key-up for every flag that was set while the pad's
    // button was up, so a connected-but-untouched gamepad silently swallowed the keyboard (and the touch controls) every frame.
    // `_padHeld["flag|mapping"]` records the flags this pad set; only those are released. (tools/gba_page_standard_test.mjs 'browser E'.)
    processGamepad() {
        const held = this._padHeld || (this._padHeld = {})
        const release = () => {
            for (const name of Object.keys(held)) {
                if (!held[name]) continue
                held[name] = false
                const [flag, mapping] = name.split('|')
                if (this[flag]) this.sendKeyUpEvent(this.KeyMappings[mapping])
            }
        }
        try {
            const gamepads = navigator.getGamepads ? navigator.getGamepads() : []
            let gp = null
            if (gamepads) {
                for (let i = 0; i < gamepads.length; i++) {
                    if (gamepads[i] && gamepads[i].buttons.length > 0) {
                        gp = gamepads[i]
                    }
                }
            }

            if (!gp) { release(); return }       // unplugged mid-press: let go of what it held

            // read every source first, then decide per flag: a flag is held by the pad while ANY of its sources is on
            const on = {}
            const want = (flag, mapping, isOn) => { const k = flag + '|' + mapping; on[k] = on[k] || !!isOn }
            const btn = n => n >= 0 && gp.buttons[n] && gp.buttons[n].pressed
            const km = this.KeyMappings

            want('Key_Up', 'Mapping_Up', btn(km.Joy_Mapping_Up))
            want('Key_Down', 'Mapping_Down', btn(km.Joy_Mapping_Down))
            want('Key_Left', 'Mapping_Left', btn(km.Joy_Mapping_Left))
            want('Key_Right', 'Mapping_Right', btn(km.Joy_Mapping_Right))
            want('Key_Action_A', 'Mapping_Action_A', btn(km.Joy_Mapping_Action_A))
            want('Key_Action_B', 'Mapping_Action_B', btn(km.Joy_Mapping_Action_B))
            want('Key_Action_Start', 'Mapping_Action_Start', btn(km.Joy_Mapping_Action_Start))
            want('Key_Action_Select', 'Mapping_Action_Select', btn(km.Joy_Mapping_Action_Select))
            want('Key_Action_L', 'Mapping_Action_L', btn(km.Joy_Mapping_Action_L))
            want('Key_Action_R', 'Mapping_Action_R', btn(km.Joy_Mapping_Action_R))

            const hx = gp.axes ? (gp.axes[0] || 0) : 0
            const vy = gp.axes ? (gp.axes[1] || 0) : 0
            want('Key_Left', 'Mapping_Left', hx < -0.35)
            want('Key_Right', 'Mapping_Right', hx > 0.35)
            want('Key_Down', 'Mapping_Down', vy > 0.35)
            want('Key_Up', 'Mapping_Up', vy < -0.35)

            for (const k of Object.keys(on)) {
                const [flag, mapping] = k.split('|')
                if (on[k]) {
                    held[k] = true
                    if (!this[flag]) this.sendKeyDownEvent(this.KeyMappings[mapping])
                } else if (held[k]) {
                    held[k] = false
                    if (this[flag]) this.sendKeyUpEvent(this.KeyMappings[mapping])
                }
            }
        } catch (e) { }
    }

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
        if (key === 'Left' && this.KeyMappings.Mapping_Left === 'ArrowLeft') key = 'ArrowLeft'
        if (key === 'Right' && this.KeyMappings.Mapping_Right === 'ArrowRight') key = 'ArrowRight'
        if (key === 'Up' && this.KeyMappings.Mapping_Up === 'ArrowUp') key = 'ArrowUp'
        if (key === 'Down' && this.KeyMappings.Mapping_Down === 'ArrowDown') key = 'ArrowDown'
        return key
    }

    // A letter compares case-insensitively: with Shift or Caps Lock down `e.key` is 'M', and a game key that stops answering because
    // a modifier is held is not what anyone wants. Named keys ('Enter', 'ArrowUp') are left exactly as they are.
    _same(key, mapping) {
        if (typeof key === 'string' && key.length === 1 && typeof mapping === 'string' && mapping.length === 1) {
            return key.toLowerCase() === mapping.toLowerCase()
        }
        return key === mapping
    }

    // A key typed into the ROM picker, a file input or any text field is the visitor operating the PAGE, not the game: arrow keys
    // move a <select> and must not also move the character. (The synthetic events the gamepad path builds have no target.)
    _typingInPageControl(event) {
        const t = event && event.target
        const tag = t && t.tagName
        return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !!(t && t.isContentEditable)
    }

    keyDown(event) {
        if (this._typingInPageControl(event)) return
        const key = this._normalizeArrow(event)
        const km = this.KeyMappings

        if (this._same(key, km.Mapping_Up)) this.Key_Up = true
        if (this._same(key, km.Mapping_Down)) this.Key_Down = true
        if (this._same(key, km.Mapping_Left)) this.Key_Left = true
        if (this._same(key, km.Mapping_Right)) this.Key_Right = true
        if (this._same(key, km.Mapping_Action_A)) this.Key_Action_A = true
        if (this._same(key, km.Mapping_Action_B)) this.Key_Action_B = true
        if (this._same(key, km.Mapping_Action_Start)) this.Key_Action_Start = true
        if (this._same(key, km.Mapping_Action_Select)) this.Key_Action_Select = true
        if (this._same(key, km.Mapping_Action_L)) this.Key_Action_L = true
        if (this._same(key, km.Mapping_Action_R)) this.Key_Action_R = true
        if (this._same(key, km.Mapping_Menu)) this.Key_Menu = true
    }

    // keyUp is NOT guarded: a key released while a form control has focus must still clear the flag it set before the focus moved.
    keyUp(event) {
        const key = this._normalizeArrow(event)
        const km = this.KeyMappings

        if (this._same(key, km.Mapping_Up)) this.Key_Up = false
        if (this._same(key, km.Mapping_Down)) this.Key_Down = false
        if (this._same(key, km.Mapping_Left)) this.Key_Left = false
        if (this._same(key, km.Mapping_Right)) this.Key_Right = false
        if (this._same(key, km.Mapping_Action_A)) this.Key_Action_A = false
        if (this._same(key, km.Mapping_Action_B)) this.Key_Action_B = false
        if (this._same(key, km.Mapping_Action_Start)) this.Key_Action_Start = false
        if (this._same(key, km.Mapping_Action_Select)) this.Key_Action_Select = false
        if (this._same(key, km.Mapping_Action_L)) this.Key_Action_L = false
        if (this._same(key, km.Mapping_Action_R)) this.Key_Action_R = false
        if (this._same(key, km.Mapping_Menu)) this.Key_Menu = false
    }
}
