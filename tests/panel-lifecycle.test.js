const test = require('node:test')
const assert = require('node:assert/strict')
const { replaceOwnedInterval, clearOwnedInterval, sendHeightIfChanged } = require('../src/utils/BrightnessPanel/panelLifecycle')

test('replacing the panel sync interval clears the previous owned timer', () => {
  const owner = { current: null }
  const scheduled = []
  const cleared = []
  const timers = {
    setInterval(callback, delay) {
      const handle = { callback, delay, id: scheduled.length + 1 }
      scheduled.push(handle)
      return handle
    },
    clearInterval(handle) { cleared.push(handle) },
  }
  const first = replaceOwnedInterval(owner, () => {}, 500, timers)
  const second = replaceOwnedInterval(owner, () => {}, 250, timers)
  assert.equal(first.id, 1)
  assert.equal(second.id, 2)
  assert.deepEqual(cleared, [first])
  assert.equal(owner.current, second)
  assert.equal(scheduled.length, 2)
})

test('panel unmount clears its current timer exactly once', () => {
  const owner = { current: { id: 7 } }
  const cleared = []
  const timers = { clearInterval(handle) { cleared.push(handle) } }
  assert.equal(clearOwnedInterval(owner, timers), true)
  assert.equal(owner.current, null)
  assert.equal(clearOwnedInterval(owner, timers), false)
  assert.deepEqual(cleared, [{ id: 7 }])
})

test('panel height IPC is sent only when the measured height changes', () => {
  const owner = { current: -1 }
  const sent = []
  const send = height => sent.push(height)
  assert.equal(sendHeightIfChanged(owner, 480, send), true)
  assert.equal(sendHeightIfChanged(owner, 480, send), false)
  assert.equal(sendHeightIfChanged(owner, 481, send), true)
  owner.current = -1 // A monitor topology change invalidates the cached layout.
  assert.equal(sendHeightIfChanged(owner, 480, send), true)
  assert.deepEqual(sent, [480, 481, 480])
})
