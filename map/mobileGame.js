export function initGameMobile() {
  const arrow = document.getElementById('arrow')
  const joystick = document.getElementById('joystick')
  const controls = document.getElementById('controls')
  const explosion = document.createElement('div')

  explosion.style.position = 'absolute'
  explosion.style.borderRadius = '50%'
  explosion.style.background = 'red'
  explosion.style.opacity = '0'
  explosion.style.pointerEvents = 'none'
  document.body.appendChild(explosion)

  const arrowOffset = 25
  const joystickSensitivity = 0.05
  const joystickRadius = Math.min(window.innerWidth, window.innerHeight) * 0.177 // Joystick radius based on screen size
  let joystickCenterX, joystickCenterY

  let arrowX = window.innerWidth / 2
  let arrowY = window.innerHeight * 0.4
  arrow.style.left = `${arrowX}px`
  arrow.style.top = `${arrowY}px`

  function moveArrowJoystick(event) {
    event.preventDefault()

    const touchX = event.touches[0].clientX
    const touchY = event.touches[0].clientY

    const deltaX = touchX - joystickCenterX
    const deltaY = touchY - joystickCenterY

    const angle = Math.atan2(deltaY, deltaX)
    const distance = Math.min(Math.sqrt(deltaX ** 2 + deltaY ** 2), joystickRadius) * joystickSensitivity

    arrowX = Math.max(arrowOffset, Math.min(window.innerWidth - arrowOffset, arrowX + (distance * Math.cos(angle))))
    arrowY = Math.max(arrowOffset, Math.min(window.innerHeight - arrowOffset, arrowY + (distance * Math.sin(angle))))

    requestAnimationFrame(() => {
      arrow.style.left = `${arrowX}px`
      arrow.style.top = `${arrowY}px`

      const rotationAngle = angle * (180 / Math.PI) + 90
      arrow.style.transform = `translate(-50%, -50%) rotate(${rotationAngle}deg)`
    })
  }

  function triggerExplosion() {
    const explosionSize = 100
    const explosionDuration = 500
    const distanceInPixels = 50 // Adjust this value to represent 5 meters in your scale
  
    // Ensure the arrow has a rotation applied; default to 0 if not set
    const transform = arrow.style.transform || 'rotate(0deg)'
    const match = transform.match(/rotate\((-?\d+(\.\d+)?)deg\)/)
    const rotationAngle = match ? parseFloat(match[1]) * (Math.PI / 180) : 0 // Convert to radians
    
    const explosionX = arrowX + distanceInPixels * Math.cos(rotationAngle) // Position explosion 5 meters in front
    const explosionY = arrowY + distanceInPixels * Math.sin(rotationAngle)
  
    explosion.style.left = `${explosionX - explosionSize / 2}px`
    explosion.style.top = `${explosionY - explosionSize / 2}px`
    explosion.style.width = `${explosionSize}px`
    explosion.style.height = `${explosionSize}px`
    explosion.style.opacity = '1'
    explosion.style.zIndex = '10' // Ensure explosion is in front
  
    setTimeout(() => {
      explosion.style.transition = `width ${explosionDuration}ms, height ${explosionDuration}ms, opacity ${explosionDuration}ms`
      explosion.style.width = '0'
      explosion.style.height = '0'
      explosion.style.opacity = '0'
    }, 10)
  
    setTimeout(() => {
      explosion.style.transition = 'none'
    }, explosionDuration + 10)
  }
  
  

  joystick.addEventListener('touchstart', event => {
    joystickCenterX = joystick.getBoundingClientRect().left + joystickRadius
    joystickCenterY = joystick.getBoundingClientRect().top + joystickRadius
    joystick.addEventListener('touchmove', moveArrowJoystick, { passive: false })
  }, { passive: true })

  // Add event listener for control box with data-index="1"
  const button1 = controls.querySelector('.control-box[data-index="1"]')
  button1.addEventListener('click', () => {
    triggerExplosion() // Trigger explosion when control box 1 is clicked
  })

  joystick.style.width = `${joystickRadius * 2}px` // Set joystick width based on calculated radius
  joystick.style.height = `${joystickRadius * 2}px` // Set joystick height based on calculated radius
  joystick.style.left = `20px`
  joystick.style.top = `calc(80vh - ${joystickRadius * 2}px)` // Adjust position based on joystick size
  joystick.style.display = 'block'
  controls.style.display = 'flex'
}
