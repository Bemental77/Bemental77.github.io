export function initGameMobile() {
  const arrow = document.getElementById('arrow')
  const joystick = document.getElementById('joystick')
  const controls = document.getElementById('controls')

  const speed = 2
  const arrowOffset = 25
  const joystickSensitivity = 0.2
  const joystickRadius = joystick.offsetWidth / 2
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

    const clickPointX = arrowX + 5 * Math.cos(angle)
    const clickPointY = arrowY + 5 * Math.sin(angle)

    arrowX = Math.max(arrowOffset, Math.min(window.innerWidth - arrowOffset, clickPointX + (distance * Math.cos(angle))))
    arrowY = Math.max(arrowOffset, Math.min(window.innerHeight - arrowOffset, clickPointY + (distance * Math.sin(angle))))

    requestAnimationFrame(() => {
      arrow.style.left = `${arrowX}px`
      arrow.style.top = `${arrowY}px`

      const rotationAngle = angle * (180 / Math.PI) + 90
      arrow.style.transform = `translate(-50%, -50%) rotate(${rotationAngle}deg)`
    })
  }

  joystick.addEventListener('touchstart', event => {
    joystickCenterX = joystick.getBoundingClientRect().left + joystickRadius
    joystickCenterY = joystick.getBoundingClientRect().top + joystickRadius
    joystick.addEventListener('touchmove', moveArrowJoystick, { passive: false })
  }, { passive: true })

  joystick.style.left = '20px'
  joystick.style.top = 'calc(80vh - 80px)'
  joystick.style.display = 'block'
  controls.style.display = 'flex'
}
