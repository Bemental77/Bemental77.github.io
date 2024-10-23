export function initGame() {
  const arrow = document.getElementById('arrow')
  const controls = document.getElementById('controls')
  const joystick = document.getElementById('joystick')

  let arrowX = window.innerWidth / 2
  let arrowY = window.innerHeight * 0.4
  let keys = { w: false, a: false, s: false, d: false }
  let angle = 0

  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints

  function moveArrowSmooth() {
      let speed = 2
      if (keys.w) arrowY -= speed
      if (keys.s) arrowY += speed
      if (keys.a) arrowX -= speed
      if (keys.d) arrowX += speed

      // Adjust boundaries to prevent moving outside the walls of the square
      const square = document.getElementById('square')
      const squareRect = square.getBoundingClientRect()

      arrowX = Math.max(squareRect.left + 25, Math.min(arrowX, squareRect.right - 25))
      arrowY = Math.max(squareRect.top + 30, Math.min(arrowY, squareRect.bottom - 30))

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

  window.addEventListener('keydown', e => keys[e.key] = true)
  window.addEventListener('keyup', e => keys[e.key] = false)

  function moveArrowJoystick(event) {
      event.preventDefault()
      const controlRect = controls.getBoundingClientRect()

      let x = event.touches[0].clientX - controlRect.left
      let y = event.touches[0].clientY - controlRect.top

      arrowX += (x - controlRect.width / 2) * 0.01
      arrowY += (y - controlRect.height / 2) * 0.01

      // Adjust boundaries to prevent moving outside the walls of the square
      const squareRect = document.getElementById('square').getBoundingClientRect()

      arrowX = Math.max(squareRect.left + 25, Math.min(arrowX, squareRect.right - 25))
      arrowY = Math.max(squareRect.top + 30, Math.min(arrowY, squareRect.bottom - 30))

      arrow.style.left = `${arrowX}px`
      arrow.style.top = `${arrowY}px`
  }

  if (isMobile) {
      controls.style.display = 'block'
      controls.addEventListener('touchmove', moveArrowJoystick, { passive: false })
  }
}
