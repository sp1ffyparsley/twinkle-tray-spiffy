const test = require('node:test')
const assert = require('node:assert/strict')
const { createPresetIntentQueue } = require('../src/PresetIntentQueue')

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush() {
  await new Promise(resolve => setImmediate(resolve))
}

test('100 rapid preset clicks retain the first in-flight and final requested preset only', async () => {
  const first = deferred()
  const final = deferred()
  const started = []
  const busy = []
  const results = []
  const queue = createPresetIntentQueue({
    apply(slot) {
      started.push(slot)
      return started.length === 1 ? first.promise : final.promise
    },
    onBusy: slot => busy.push(slot),
    onResult: (result, slot) => results.push([result, slot]),
  })
  assert.equal(queue.press(1), true)
  for (let index = 2; index <= 100; index++) queue.press(((index - 1) % 5) + 1)
  assert.deepEqual(started, [1])
  first.resolve({ ok: true })
  await flush()
  assert.deepEqual(started, [1, 5])
  assert.deepEqual(results, [])
  final.resolve({ ok: true })
  await flush()
  assert.deepEqual(results, [[{ ok: true }, 5]])
  assert.equal(busy.at(-1), 0)
  queue.dispose()
})

test('a stale error is ignored when the user selects another preset', async () => {
  const first = deferred()
  const errors = []
  const results = []
  const queue = createPresetIntentQueue({
    apply(slot) { return slot === 1 ? first.promise : Promise.resolve({ ok: true }) },
    onError: (error, slot) => errors.push([error.message, slot]),
    onResult: (_, slot) => results.push(slot),
  })
  queue.press(1)
  queue.press(3)
  first.reject(Error('Superseded hardware timeout'))
  await flush()
  assert.deepEqual(errors, [])
  assert.deepEqual(results, [3])
})

test('repeatedly pressing the same preset never repeats its in-flight hardware command', async () => {
  const first = deferred()
  const applied = []
  const results = []
  const queue = createPresetIntentQueue({
    apply(slot) { applied.push(slot); return first.promise },
    onResult: (_, slot) => results.push(slot),
  })
  queue.press(2)
  for (let i = 0; i < 100; i++) queue.press(2)
  first.resolve({ ok: true })
  await flush()
  assert.deepEqual(applied, [2])
  assert.deepEqual(results, [2])
})

test('switching back to the already-running preset cancels a queued intermediate choice', async () => {
  const first = deferred()
  const applied = []
  const queue = createPresetIntentQueue({
    apply(slot) { applied.push(slot); return first.promise },
  })
  queue.press(1)
  queue.press(4)
  queue.press(1)
  first.resolve({ ok: true })
  await flush()
  assert.deepEqual(applied, [1])
})

test('invalid slots and post-disposal commands never call native hardware', async () => {
  const applied = []
  const queue = createPresetIntentQueue({
    apply(slot) { applied.push(slot); return Promise.resolve({ ok: true }) },
  })
  for (const value of [-1, 0, 6, '3', NaN, null]) {
    assert.equal(queue.press(value), false)
  }
  queue.dispose()
  assert.equal(queue.press(1), false)
  await flush()
  assert.deepEqual(applied, [])
})

test('a disposed component drops pending requests rather than leaking callbacks', async () => {
  const first = deferred()
  const applied = []
  const busy = []
  const queue = createPresetIntentQueue({
    apply(slot) { applied.push(slot); return first.promise },
    onBusy: slot => busy.push(slot),
  })
  queue.press(1)
  queue.press(5)
  queue.dispose()
  first.resolve({ ok: true })
  await flush()
  assert.deepEqual(applied, [1])
  assert.equal(busy.at(-1), 5)
})
