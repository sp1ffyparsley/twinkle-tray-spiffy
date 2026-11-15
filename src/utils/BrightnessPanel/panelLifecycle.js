function replaceOwnedInterval(owner, callback, delay, timers = {}) {
  const clear = timers.clearInterval || clearInterval
  const schedule = timers.setInterval || setInterval
  if (owner.current !== null) clear(owner.current)
  owner.current = schedule(callback, delay)
  return owner.current
}

function clearOwnedInterval(owner, timers = {}) {
  if (owner.current === null) return false
  const handle = owner.current
  owner.current = null
  const clear = timers.clearInterval || clearInterval
  clear(handle)
  return true
}

function sendHeightIfChanged(owner, height, send) {
  if (owner.current === height) return false
  owner.current = height
  send(height)
  return true
}

module.exports = { replaceOwnedInterval, clearOwnedInterval, sendHeightIfChanged }
