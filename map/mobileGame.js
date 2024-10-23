export function initGameMobile() {
  const arrow = document.getElementById('arrow')
  const joystick = document.getElementById('joystick') // Joystick element
  const controls = document.getElementById('controls') // Buttons container

  const arrowOffset = 25 // Adjust for the arrow's size
  const joystickSensitivity = 0.2 // Adjust sensitivity for smoother movement
  let joystickCenterX, joystickCenterY // To store joystick's center

  function moveArrowJoystick(event) {
      event.preventDefault()

      // Get touch coordinates relative to joystick's center
      const touchX = event.touches[0].clientX
      const touchY = event.touches[0].clientY

      // Calculate the relative displacement from joystick's center
      const deltaX = touchX - joystickCenterX
      const deltaY = touchY - joystickCenterY

      // Calculate the angle for the rotation
      const angle = Math.atan2(deltaY, deltaX)

      // Calculate the distance from the center of the joystick with sensitivity
      const distance = Math.min(Math.sqrt(deltaX ** 2 + deltaY ** 2), joystick.offsetWidth / 2) * joystickSensitivity

      // Calculate the new position for the arrow based on the distance and angle
      const arrowX = Math.max(arrowOffset, Math.min(window.innerWidth - arrowOffset, arrow.offsetLeft + (distance * Math.cos(angle))))
      const arrowY = Math.max(arrowOffset, Math.min(window.innerHeight - arrowOffset, arrow.offsetTop + (distance * Math.sin(angle))))

      // Update the arrow's position
      arrow.style.left = `${arrowX}px`
      arrow.style.top = `${arrowY}px`

      // Rotate the arrow based on joystick movement
      const rotationAngle = angle * (180 / Math.PI) // Convert radians to degrees
      arrow.style.transform = `translate(-50%, -50%) rotate(${rotationAngle}deg)`

      // Update joystick handle position
      joystick.style.left = `${joystickCenterX + deltaX}px` // Adjust joystick position
      joystick.style.top = `${joystickCenterY + deltaY}px` // Adjust joystick position
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

      // Reset arrow position and rotation when joystick is released
      arrow.style.left = '50%'
      arrow.style.top = '50%'
      arrow.style.transform = 'translate(-50%, -50%) rotate(0deg)' // Reset rotation
  })

  // Show joystick and controls
  joystick.style.display = 'block'
  controls.style.display = 'flex'
}