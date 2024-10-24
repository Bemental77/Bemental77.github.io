export function initGameMobile() {
  const arrow = document.getElementById('arrow')
  const joystick = document.getElementById('joystick')
  const controls = document.getElementById('controls')
  const explosion = document.createElement('div')
  const perpendicularLine = document.createElement('div')

  explosion.style.position = 'absolute'
  explosion.style.borderRadius = '50%'
  explosion.style.background = 'red'
  explosion.style.opacity = '0'
  explosion.style.pointerEvents = 'none'
  document.body.appendChild(explosion)

  perpendicularLine.style.position = 'absolute'
  perpendicularLine.style.width = '50px'
  perpendicularLine.style.height = '2px'
  perpendicularLine.style.backgroundColor = 'red'
  document.body.appendChild(perpendicularLine)

  const arrowOffset = 0
  const joystickSensitivity = 0.05
  const joystickRadius = Math.min(window.innerWidth, window.innerHeight) * 0.177
  let joystickCenterX, joystickCenterY

  let arrowX = window.innerWidth / 2
  let arrowY = window.innerHeight * 0.4
  arrow.style.left = `${arrowX}px`
  arrow.style.top = `${arrowY}px`

  function updatePerpendicularLine(rotationAngle) {
    const radians = rotationAngle * (Math.PI / 180)
    const tipX = arrowX + (arrowOffset / 2) * Math.cos(radians)
    const tipY = arrowY + (arrowOffset / 2) * Math.sin(radians)

    perpendicularLine.style.left = `${tipX}px`
    perpendicularLine.style.top = `${tipY}px`
    perpendicularLine.style.transformOrigin = '0 50%'
    perpendicularLine.style.transform = `rotate(${rotationAngle - 90}deg)`
  }

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

      updatePerpendicularLine(rotationAngle)
    })
  }

  joystick.addEventListener('touchstart', event => {
    joystickCenterX = joystick.getBoundingClientRect().left + joystickRadius
    joystickCenterY = joystick.getBoundingClientRect().top + joystickRadius
    joystick.addEventListener('touchmove', moveArrowJoystick, { passive: false })
  }, { passive: true })

  const button1 = controls.querySelector('.control-box[data-index="1"]')
  button1.addEventListener('click', () => {
    triggerExplosion()
  })

  joystick.style.width = `${joystickRadius * 2}px`
  joystick.style.height = `${joystickRadius * 2}px`
  joystick.style.left = `20px`
  joystick.style.top = `calc(80vh - ${joystickRadius * 2}px)`
  joystick.style.display = 'block'
  controls.style.display = 'flex'
}
