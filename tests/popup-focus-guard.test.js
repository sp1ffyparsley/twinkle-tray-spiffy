const test = require('node:test')
const assert = require('node:assert/strict')
const { createPopupFocusGuard } = require('../src/PopupFocusGuard')

function harness() {
  let time = 0
  let seq = 0
  let focused = false
  let hovered = false
  let visible = false
  const timers = new Map()
  const closures = []
  const guard = createPopupFocusGuard({
    clock: () => time,
    schedule: (fn, delay) => {
      const id = ++seq
      timers.set(id, { fn, due: time + delay })
      return id
    },
    cancel: id => timers.delete(id),
    hasFocus: () => focused,
    pointerOverPanel: () => hovered,
    shouldClose: () => visible,
    close: () => { closures.push(time); visible = false },
    openingGraceMs: 550,
    blurDelayMs: 160,
  })
  function advance(ms) {
    const end = time + ms
    while (true) {
      const due = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0]
      if (!due || due[1].due > end) break
      time = due[1].due
      timers.delete(due[0])
      due[1].fn()
    }
    time = end
  }
  return {
    guard, advance, closures, timers,
    open() { visible = true; guard.opened() },
    focus() { focused = true; guard.focused() },
    blur() { focused = false; guard.blurred() },
    hover(value) { hovered = value },
    hide() { visible = false; guard.hidden() },
  }
}

test('a notification steals focus just after opening; flyout does not instantly vanish', () => {
  const h = harness()
  h.open()
  h.advance(30)
  h.blur()
  h.advance(400)
  assert.equal(h.closures.length, 0)
  h.focus()
  h.advance(1000)
  assert.equal(h.closures.length, 0)
})

test('moving the pointer across a blurred flyout keeps controls clickable', () => {
  const h = harness()
  h.open()
  h.advance(600)
  h.hover(true)
  h.blur()
  h.advance(1300)
  assert.equal(h.closures.length, 0)
  h.hover(false)
  h.advance(260)
  assert.equal(h.closures.length, 1)
})

test('intentionally clicking away still closes the panel after a short bounded delay', () => {
  const h = harness()
  h.open()
  h.advance(800)
  h.blur()
  h.advance(159)
  assert.equal(h.closures.length, 0)
  h.advance(1)
  assert.equal(h.closures.length, 1)
})

test('reopening cancels pending hides, and leaving the visible state cancels timers', () => {
  const h = harness()
  h.open()
  h.blur()
  assert.equal(h.timers.size, 1)
  h.open()
  assert.equal(h.timers.size, 0)
  h.blur()
  h.hide()
  h.advance(2000)
  assert.equal(h.closures.length, 0)
})

test('closed popup guards never leave a recurring timer active', () => {
  const h = harness()
  h.open()
  h.hover(true)
  h.blur()
  h.guard.dispose()
  h.advance(3000)
  assert.equal(h.closures.length, 0)
  assert.equal(h.timers.size, 0)
})
