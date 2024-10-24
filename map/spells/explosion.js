export function triggerExplosion(explosion, perpendicularLine) {
  const explosionSize = 100
  const explosionDuration = 500

  const transform = perpendicularLine.style.transform || 'rotate(0deg)'
  const match = transform.match(/rotate\((-?\d+(\.\d+)?)deg\)/)
  const rotationAngle = match ? parseFloat(match[1]) * (Math.PI / 180) : 0

  const lineTipX = parseFloat(perpendicularLine.style.left) + 50 * Math.cos(rotationAngle)
  const lineTipY = parseFloat(perpendicularLine.style.top) + 50 * Math.sin(rotationAngle)

  explosion.style.left = `${lineTipX - explosionSize / 2}px`
  explosion.style.top = `${lineTipY - explosionSize / 2}px`
  explosion.style.width = '0'  // Start from small
  explosion.style.height = '0'  // Start from small
  explosion.style.opacity = '1'
  explosion.style.zIndex = '0'

  // Trigger the transition to grow the explosion
  setTimeout(() => {
    explosion.style.transition = `width ${explosionDuration}ms, height ${explosionDuration}ms, opacity ${explosionDuration}ms`
    explosion.style.width = `${explosionSize}px`  // Grow to full size
    explosion.style.height = `${explosionSize}px` // Grow to full size
  }, 0)

  // Fade out after the explosion size is reached
  setTimeout(() => {
    explosion.style.transition = `width ${explosionDuration}ms, height ${explosionDuration}ms, opacity ${explosionDuration}ms`
    explosion.style.width = '0' // Shrink back to small
    explosion.style.height = '0' // Shrink back to small
    explosion.style.opacity = '0' // Fade out
  }, explosionDuration + 10)

  setTimeout(() => {
    explosion.style.transition = 'none' // Reset transition
  }, explosionDuration * 2 + 20) // Adjusted timing to match the new flow
}
