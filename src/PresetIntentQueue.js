// One quick-preset operation at a time, with a single last-intent slot.
// Repeated clicks under heavy CPU/DDC load replace old queued choices
// instead of creating an unbounded chain of native brightness writes.
function createPresetIntentQueue({ apply, onBusy = () => {}, onResult = () => {}, onError = () => {} }) {
  if (typeof apply !== 'function') throw TypeError('A preset apply callback is required')
  let disposed = false
  let active = false
  let activeSlot = null
  let next = null

  async function drain() {
    if (active || disposed) return
    active = true
    try {
      while (!disposed && next !== null) {
        const slot = next
        next = null
        activeSlot = slot
        try {
          const result = await apply(slot)
          if (!disposed && next === null) onResult(result, slot)
        } catch (error) {
          // A newer pending choice supersedes a stale result or error.
          if (!disposed && next === null) onError(error, slot)
        }
      }
    } finally {
      active = false
      activeSlot = null
      if (!disposed) onBusy(0)
    }
  }

  function press(slot) {
    if (disposed || !Number.isInteger(slot) || slot < 1 || slot > 5) return false
    if (active && slot === activeSlot) {
      // Clicking the already-executing preset cancels any intervening queued
      // choice; one hardware write is sufficient for the newest intent.
      next = null
      onBusy(slot)
      return true
    }
    if (active && next === slot) return true
    next = slot
    onBusy(slot)
    if (!active) void drain()
    return true
  }

  function dispose() {
    disposed = true
    next = null
  }

  return { press, dispose }
}

module.exports = { createPresetIntentQueue }
