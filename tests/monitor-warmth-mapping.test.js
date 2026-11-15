const test = require('node:test')
const assert = require('node:assert/strict')
const { matchMonitorWarmthTarget } = require('../src/MonitorWarmthMapping')

const monitors = [
  { id: 'DDC-UNKNOWN-A', bounds: { position: { x: 0, y: 0 }, width: 1920, height: 1080 } },
  { id: 'DDC-UNKNOWN-B', bounds: { position: { x: 1920, y: 0 }, width: 2560, height: 1440 } },
]
const targets = [
  { id: 'all', geometry: [] },
  { id: '\\\\.\\DISPLAY1', geometry: [0, 0, 1920, 1080], strength: 25, enabled: true },
  { id: '\\\\.\\DISPLAY2', geometry: [1920, 0, 2560, 1440], strength: 0, enabled: false },
]

test('each actual monitor maps to exactly one native display regardless of DDC identifier', () => {
  assert.equal(matchMonitorWarmthTarget(monitors[0], targets).id, targets[1].id)
  assert.equal(matchMonitorWarmthTarget(monitors[1], targets).id, targets[2].id)
})

test('unknown, stale and duplicated display geometry fail closed', () => {
  assert.equal(matchMonitorWarmthTarget(monitors[0], []), null)
  assert.equal(matchMonitorWarmthTarget({}, targets), null)
  const moved = { ...monitors[0], bounds: { position: { x: 0, y: -25 }, width: 1920, height: 1080 } }
  assert.equal(matchMonitorWarmthTarget(moved, targets), null)
  assert.equal(matchMonitorWarmthTarget(monitors[0], [...targets, { id: 'third', geometry: [0, 0, 1920, 1080] }]), null)
})

test('a global Night Filter target can never be used as a physical monitor target', () => {
  assert.equal(matchMonitorWarmthTarget(monitors[0], [{ id: 'all', geometry: [0, 0, 1920, 1080] }]), null)
})
