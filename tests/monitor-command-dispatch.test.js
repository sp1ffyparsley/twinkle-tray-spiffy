const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createMonitorCommandDispatcher } = require('../src/monitor-command-dispatch')

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve))
}

test('VCP dispatch waits for the request-correlated monitor-worker acknowledgement', async () => {
  const events = new EventEmitter()
  let sent
  let options
  const dispatch = createMonitorCommandDispatcher({
    events,
    nextRequestId: () => 41,
    send: async (data, sendOptions) => { sent = data; options = sendOptions },
  })

  let settled = false
  const pending = dispatch('DISPLAY#SERIAL', 0xD6, 5).then(value => {
    settled = true
    return value
  })
  await nextTurn()
  assert.deepEqual(sent, {
    type: 'vcp', monitor: 'DISPLAY#SERIAL', code: 0xD6, value: 5, requestId: 41,
  })
  assert.deepEqual(options, { requireDispatch: true })
  assert.equal(settled, false)

  events.emit('vcp-dispatched::41', { ok: true })
  assert.equal(await pending, true)
  assert.equal(settled, true)
})

test('VCP dispatch rejects a monitor-worker failure', async () => {
  const events = new EventEmitter()
  const dispatch = createMonitorCommandDispatcher({
    events,
    nextRequestId: () => 42,
    send: async () => true,
  })
  const pending = dispatch('DISPLAY#SERIAL', 0xD6, 5)
  await nextTurn()
  events.emit('vcp-dispatched::42', { ok: false, error: 'The monitor driver refused the VCP request.' })
  await assert.rejects(pending, /driver refused/)
  assert.equal(events.listenerCount('vcp-dispatched::42'), 0)
})

test('VCP dispatch rejects a failed IPC handoff without retrying', async () => {
  const events = new EventEmitter()
  let sendCount = 0
  const dispatch = createMonitorCommandDispatcher({
    events,
    nextRequestId: () => 43,
    send: async () => { sendCount++; throw Error('worker offline') },
  })
  await assert.rejects(dispatch('DISPLAY#SERIAL', 0xD6, 5), /worker offline/)
  assert.equal(sendCount, 1)
  assert.equal(events.listenerCount('vcp-dispatched::43'), 0)
})

test('VCP dispatch times out with an unconfirmed outcome and never replays', async () => {
  const events = new EventEmitter()
  let sendCount = 0
  const dispatch = createMonitorCommandDispatcher({
    events,
    nextRequestId: () => 44,
    timeoutMs: 15,
    send: async () => { sendCount++ },
  })
  await assert.rejects(dispatch('DISPLAY#SERIAL', 0xD6, 5), /outcome is unconfirmed/)
  assert.equal(sendCount, 1)
  assert.equal(events.listenerCount('vcp-dispatched::44'), 0)
})
