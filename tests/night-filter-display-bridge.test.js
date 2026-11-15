const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { NightFilterDisplayBridge } = require('../src/NightFilterDisplayBridge')

const root = path.resolve(__dirname, '..', '..')
const targets = [
  { id: 'all', enabled: false, strength: 33, geometry: [] },
  { id: 'DISPLAY1', enabled: true, strength: 40, geometry: [0, 0, 1920, 1080] },
  { id: 'DISPLAY2', enabled: false, strength: 0, geometry: [1920, 0, 2560, 1440] },
]

function harness() {
  const requests = []
  const children = []
  const mockSpawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => { child.killed = true; child.emit('exit') }
    child.stdin = {
      end: () => child.emit('exit'),
      write: (text, cb) => {
        const request = JSON.parse(text)
        requests.push(request)
        const result = {
          targets: request.action === 'night_filter_set' ? targets.map(t => t.id === request.payload.target_id
            ? { ...t, enabled: request.payload.enabled, strength: request.payload.strength } : t) : targets,
        }
        queueMicrotask(() => child.stdout.emit('data', JSON.stringify({
          request_id: request.request_id,
          ok: true,
          result,
        }) + '\n'))
        if (cb) cb()
      },
    }
    children.push(child)
    return child
  }
  const bridge = new NightFilterDisplayBridge({
    scriptsRoot: root,
    pythonPath: process.execPath,
    spawnProcess: mockSpawn,
    idleMs: 500,
  })
  return { bridge, requests, children }
}

test('read-only status establishes a canonical display identity before any write', async () => {
  const h = harness()
  const status = await h.bridge.status()
  assert.equal(status.targets.length, 3)
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].action, 'night_filter_status')
  h.bridge.close()
})

test('warmth changes target one explicitly identified display, never all displays', async () => {
  const h = harness()
  await assert.rejects(() => h.bridge.set({ target_id: 'DISPLAY1', strength: 80 }), /Refresh monitor identities/)
  await h.bridge.status()
  const result = await h.bridge.set({ target_id: 'DISPLAY1', strength: 80 })
  assert.equal(result.targets[1].strength, 80)
  const write = h.requests.at(-1)
  assert.equal(write.action, 'night_filter_set')
  assert.deepEqual(write.payload, {
    target_id: 'DISPLAY1', enabled: true, strength: 80, dimness: 0, dim_duration_minutes: 0,
  })
  assert.equal(result.targets[2].strength, 0)
  await assert.rejects(() => h.bridge.set({ target_id: 'all', strength: 60 }), /Refresh monitor identities/)
  await assert.rejects(() => h.bridge.set({ target_id: 'DISPLAY1', strength: 200 }), /Warmth must be/)
  h.bridge.close()
})

test('strength zero produces a local OFF without global/all-displays commands', async () => {
  const h = harness()
  await h.bridge.status()
  await h.bridge.set({ target_id: 'DISPLAY2', strength: 0 })
  assert.deepEqual(h.requests.at(-1).payload, {
    target_id: 'DISPLAY2', enabled: false, strength: 0, dimness: 0, dim_duration_minutes: 0,
  })
  assert.equal(h.requests.filter(r => r.payload.target_id === 'all').length, 0)
  h.bridge.close()
})
