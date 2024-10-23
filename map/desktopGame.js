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