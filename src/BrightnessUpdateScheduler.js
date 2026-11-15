// Per-monitor, per-control leading/trailing brightness updates. A single global
// timeout used to delay unrelated monitors when one display was being dragged.
// No background polling or additional process is created.
function createBrightnessUpdateScheduler({
  transmit,
  notify = () => {},
  onError = () => {},
  interval = () => 100,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (typeof transmit !== 'function') throw new TypeError('Brightness transmitter is required')
  const channels = new Map()
  let closed = false
  const delayMs = () => {
    const value = Number(interval())
    return Number.isFinite(value) ? Math.max(16, Math.min(2000, Math.round(value))) : 100
  }
  function dispatch(channel, item) {
    channel.lastSent = now()
    // Existing updateBrightness handles topology, sleep and hardware failure.
    // Never retain a stale command or retry an uncertain hardware result here.
    try {
      transmit(item.id, item.level, item.useCap, item.vcp)
      if (item.sendUpdate) notify()
    } catch (error) {
      // Native transport may be unavailable while a monitor disconnects.
      // A failure is terminal for this request; never replay uncertain writes.
      onError(error)
    }
  }
  function queue(id, level, useCap = true, sendUpdate = true, vcp = 'brightness') {
    if (closed || !Number.isFinite(Number(level))) return false
    const key = String(id) + '::' + String(vcp)
    let channel = channels.get(key)
    if (!channel) {
      channel = { lastSent: -Infinity, latest: null, timer: null }
      channels.set(key, channel)
    }
    const item = { id, level, useCap, sendUpdate, vcp }
    const elapsed = now() - channel.lastSent
    if (!channel.timer && elapsed >= delayMs()) {
      dispatch(channel, item)
      return true
    }
    // Replace intermediate positions; always send the last requested value.
    channel.latest = item
    if (!channel.timer) {
      const wait = Math.max(1, delayMs() - Math.max(0, elapsed))
      channel.timer = setTimer(() => {
        channel.timer = null
        const latest = channel.latest
        channel.latest = null
        if (!closed && latest) dispatch(channel, latest)
      }, wait)
    }
    return false
  }
  function reset() {
    for (const channel of channels.values()) if (channel.timer) clearTimer(channel.timer)
    channels.clear()
  }
  function clear() {
    closed = true
    reset()
  }
  return { queue, reset, clear }
}

module.exports = { createBrightnessUpdateScheduler }
