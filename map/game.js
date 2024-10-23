export function initGameDesktop() {
    const arrow = document.getElementById('arrow')
    const controls = document.getElementById('controls')

    let arrowX = window.innerWidth / 2
    let arrowY = window.innerHeight * 0.4
    let keys = { w: false, a: false, s: false, d: false }
    let angle = 0

    function moveArrowSmooth() {
        let speed = 2
        if (keys.w) arrowY -= speed
        if (keys.s) arrowY += speed
        if (keys.a) arrowX -= speed
        if (keys.d) arrowX += speed

        arrow.style.left = `${arrowX}px`
        arrow.style.top = `${arrowY}px`

        if (keys.w || keys.a || keys.s || keys.d) {
            if (keys.w && keys.a) angle = -45
            else if (keys.w && keys.d) angle = 45
            else if (keys.s && keys.a) angle = -135
            else if (keys.s && keys.d) angle = 135
            else if (keys.w) angle = 0
            else if (keys.s) angle = 180
            else if (keys.a) angle = -90
            else if (keys.d) angle = 90
            arrow.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`
        }

        requestAnimationFrame(moveArrowSmooth)
    }

    moveArrowSmooth()

    window.addEventListener('keydown', e => {
        if (e.key === 'w') keys.w = true
        if (e.key === 'a') keys.a = true
        if (e.key === 's') keys.s = true
        if (e.key === 'd') keys.d = true
    })

    window.addEventListener('keyup', e => {
        if (e.key === 'w') keys.w = false
        if (e.key === 'a') keys.a = false
        if (e.key === 's') keys.s = false
        if (e.key === 'd') keys.d = false
    })
}

export function initGameMobile() {
    const arrow = document.getElementById('arrow')
    const joystick = document.getElementById('joystick') // Joystick element
    const controls = document.getElementById('controls') // Buttons container

    const arrowOffset = 25 // Adjust for the arrow's size
    let joystickCenterX, joystickCenterY // To store joystick's center

    function moveArrowJoystick(event) {
        event.preventDefault()

        // Get touch coordinates relative to joystick's center
        const touchX = event.touches[0].clientX
        const touchY = event.touches[0].clientY

        // Calculate the relative displacement from joystick's center
        const deltaX = touchX - joystickCenterX
        const deltaY = touchY - joystickCenterY

        // Update the joystick handle position (within its limits)
        const distance = Math.min(Math.sqrt(deltaX ** 2 + deltaY ** 2), joystick.offsetWidth / 2)
        const angle = Math.atan2(deltaY, deltaX)

        const arrowX = arrow.offsetLeft + (distance * Math.cos(angle))
        const arrowY = arrow.offsetTop + (distance * Math.sin(angle))

        // Ensure the arrow stays within the boundaries of the window
        arrow.style.left = `${Math.max(arrowOffset, Math.min(window.innerWidth - arrowOffset, arrowX))}px`
        arrow.style.top = `${Math.max(arrowOffset, Math.min(window.innerHeight - arrowOffset, arrowY))}px`

        // Rotate the arrow based on movement direction
        arrow.style.transform = `translate(-50%, -50%) rotate(${angle * (180 / Math.PI)}deg)`

        // Update joystick handle position
        joystick.style.left = `${joystickCenterX + deltaX - joystick.offsetWidth / 2}px`
        joystick.style.top = `${joystickCenterY + deltaY - joystick.offsetHeight / 2}px`
    }

    joystick.addEventListener('touchstart', event => {
        event.preventDefault()
        joystickCenterX = joystick.getBoundingClientRect().left + joystick.offsetWidth / 2
        joystickCenterY = joystick.getBoundingClientRect().top + joystick.offsetHeight / 2
        joystick.addEventListener('touchmove', moveArrowJoystick)
    })

    joystick.addEventListener('touchend', event => {
        event.preventDefault()
        joystick.removeEventListener('touchmove', moveArrowJoystick)

        // Reset joystick position on touch end
        joystick.style.left = 'calc(50% - 40px)'
        joystick.style.top = '85vh' // Positioned near the bottom
    })

    // Show joystick and controls
    joystick.style.display = 'block'
    controls.style.display = 'flex'
}


