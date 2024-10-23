export function initGameMobile() {
  const arrow = document.getElementById('arrow')
  const joystick = document.getElementById('joystick')
  const controls = document.getElementById('controls')

  const arrowOffset = 25
  const joystickSensitivity = 0.2
  let initialTouchX, initialTouchY // Store initial touch coordinates

  function moveArrowJoystick(event) {
      event.preventDefault()

      const touchX = event.touches[0].clientX
      const touchY = event.touches[0].clientY

      const deltaX = touchX - initialTouchX
      const deltaY = touchY - initialTouchY

      const angle = Math.atan2(deltaY, deltaX)

      const distance = Math.min(Math.sqrt(deltaX ** 2 + deltaY ** 2), joystick.offsetWidth / 2) * joystickSensitivity

      // Calculate new position for the arrow based on initial touch point
      const arrowX = Math.max(arrowOffset, Math.min(window.innerWidth - arrowOffset, arrow.offsetLeft + (distance * Math.cos(angle))))
      const arrowY = Math.max(arrowOffset, Math.min(window.innerHeight - arrowOffset, arrow.offsetTop + (distance * Math.sin(angle))))

      // Update the arrow's position
      arrow.style.left = `${arrowX}px`
      arrow.style.top = `${arrowY}px`

      // Rotate the arrow based on joystick movement
      const rotationAngle = angle * (180 / Math.PI) // Convert radians to degrees
      arrow.style.transform = `translate(-50%, -50%) rotate(${rotationAngle}deg)`

      // Update joystick handle position
      joystick.style.left = `${initialTouchX + deltaX}px`
      joystick.style.top = `${initialTouchY + deltaY}px`
  }

  joystick.addEventListener('touchstart', event => {
      event.preventDefault()
      initialTouchX = event.touches[0].clientX // Capture initial touch coordinates
      initialTouchY = event.touches[0].clientY
      joystick.addEventListener('touchmove', moveArrowJoystick)
  })

  joystick.addEventListener('touchend', event => {
      event.preventDefault()
      joystick.removeEventListener('touchmove', moveArrowJoystick)

      // Reset joystick position on touch end
      joystick.style.left = 'calc(50% - 40px)'
      joystick.style.top = '85vh'

      // Reset arrow position and rotation when joystick is released
      arrow.style.left = '50%'
      arrow.style.top = '50%'
      arrow.style.transform = 'translate(-50%, -50%) rotate(0deg)' // Reset rotation
  })

  // Show joystick and controls
  joystick.style.display = 'block'
  controls.style.display = 'flex'
}
