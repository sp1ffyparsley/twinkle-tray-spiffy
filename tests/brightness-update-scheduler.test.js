const test = require('node:test')
const assert = require('node:assert/strict')
const { createBrightnessUpdateScheduler } = require('../src/BrightnessUpdateScheduler')

function harness() {
  let time = 0
  let next = 1
  const timers = new Map()
  const writes = []
  const notifications = []
  const schedule = createBrightnessUpdateScheduler({
    now: () => time,
    interval: () => 100,
    setTimer: (fn, delay) => {
      const id = next++
      timers.set(id, { at: time + delay, fn })
      return id
    },
    clearTimer: id => timers.delete(id),
    transmit: (...args) => writes.push({ time, args }),
    notify: () => notifications.push(time),
  })
  function tick(ms) {
    const target = time + ms
    while (true) {
      const nextTimer = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!nextTimer || nextTimer[1].at > target) break
      time = nextTimer[1].at
      timers.delete(nextTimer[0])
      nextTimer[1].fn()
    }
    time = target
  }
  return { schedule, writes, notifications, tick, timers }
}

test('new monitor commands are independent: monitor B does not wait for monitor A', () => {
  const h = harness()
  assert.equal(h.schedule.queue('A', 20), true)
  h.tick(10)
  assert.equal(h.schedule.queue('A', 75), false)
  assert.equal(h.schedule.queue('B', 95), true)
  assert.deepEqual(h.writes.map(w => [w.args[0], w.args[1]]), [['A', 20], ['B', 95]])
  h.tick(90)
  assert.deepEqual(h.writes.map(w => [w.args[0], w.args[1]]), [['A', 20], ['B', 95], ['A', 75]])
})

test('rapid dragging sends first and LAST value without scheduling every intermediate value', () => {
  const h = harness()
  h.schedule.queue('display1', 10)
  for (let i = 11; i <= 100; i++) h.schedule.queue('display1', i)
  assert.equal(h.writes.length, 1)
  assert.equal(h.timers.size, 1)
  h.tick(100)
  assert.deepEqual(h.writes.map(w => w.args[1]), [10, 100])
  assert.equal(h.timers.size, 0)
})

test('DDC feature code and brightness have independent timelines on the same monitor', () => {
  const h = harness()
  h.schedule.queue('A', 10, true, true, 'brightness')
  h.schedule.queue('A', 60, true, true, '0x12')
  h.schedule.queue('A', 80, true, true, 'brightness')
  assert.deepEqual(h.writes.map(w => w.args[3]), ['brightness', '0x12'])
  h.tick(100)
  assert.deepEqual(h.writes.map(w => [w.args[1], w.args[3]]), [[10, 'brightness'], [60, '0x12'], [80, 'brightness']])
})

test('stale intermediate update is superseded without extra monitor-wide state notifications', () => {
  const h = harness()
  h.schedule.queue('A', 12, true, true)
  h.tick(20)
  h.schedule.queue('A', 18, true, false)
  h.schedule.queue('A', 24, true, true)
  h.tick(80)
  assert.deepEqual(h.notifications, [0, 100])
  assert.deepEqual(h.writes.map(w => w.args[1]), [12, 24])
})

test('shutdown cancels pending commands; invalid input does not send hardware commands', () => {
  const h = harness()
  assert.equal(h.schedule.queue('A', NaN), false)
  h.schedule.queue('A', 10)
  h.schedule.queue('A', 20)
  h.schedule.clear()
  h.tick(1000)
  assert.equal(h.writes.length, 1)
  assert.equal(h.schedule.queue('A', 40), false)
})

test('topology reset drops delayed commands but keeps the scheduler reusable', () => {
  const h = harness()
  h.schedule.queue('old-display', 30)
  h.schedule.queue('old-display', 70)
  h.schedule.reset()
  h.tick(200)
  assert.equal(h.writes.length, 1)
  h.schedule.queue('new-display', 80)
  assert.deepEqual(h.writes.map(w => w.args[0]), ['old-display', 'new-display'])
})
