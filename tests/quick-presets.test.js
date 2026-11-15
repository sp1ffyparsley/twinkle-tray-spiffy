const test = require('node:test')
const assert = require('node:assert/strict')
const {
  SCHEMA, COUNT, DEFAULTS, normalizePresets, validatePreset,
  resolvePreset, capturePreset, exportPresets, importPresets,
} = require('../src/QuickPresets')

const screens = {
  one: { id: 'DDC-one', key: 'key-one', type: 'ddcci', brightness: 66, bounds: { position: { x: 0, y: 0 }, width: 1920, height: 1080 } },
  two: { id: 'DDC-two', key: 'key-two', type: 'ddcci', brightness: 34, bounds: { position: { x: 1920, y: 0 }, width: 2560, height: 1440 } },
}
const warmth = {
  targets: [
    { id: 'all', enabled: false, geometry: [] },
    { id: 'native-one', enabled: true, strength: 44, geometry: [0, 0, 1920, 1080] },
    { id: 'native-two', enabled: false, strength: 0, geometry: [1920, 0, 2560, 1440] },
  ],
}

test('five presets have useful defaults and a portable named schema', () => {
  const defaults = normalizePresets()
  assert.equal(COUNT, 5)
  assert.equal(defaults.length, 5)
  assert.equal(defaults[0].name, 'Bright')
  assert.equal(defaults[4].warmth, 45)
  const encoded = JSON.parse(exportPresets(defaults))
  assert.equal(encoded.schema, SCHEMA)
  assert.deepEqual(importPresets(JSON.stringify(encoded)), defaults)
})

test('all-displays preset targets both displays without silently changing input objects', () => {
  const input = normalizePresets()[1]
  const result = resolvePreset(input, screens)
  assert.equal(result.planned.length, 2)
  assert.equal(result.skipped.length, 0)
  assert.deepEqual(result.planned.map(item => [item.monitor.id, item.brightness, item.warmth]),
    [['DDC-one', 75, 0], ['DDC-two', 75, 0]])
})

test('capturing physical monitors includes independent brightness and warmth', () => {
  const captured = capturePreset(2, { name: 'Editing', icon: '🎬' }, screens, warmth)
  assert.equal(captured.mode, 'matched')
  assert.equal(captured.targets.length, 2)
  assert.deepEqual(captured.targets.map(m => [m.brightness, m.warmth]), [[66, 44], [34, 0]])
  const resolved = resolvePreset(captured, screens)
  assert.equal(resolved.planned[0].warmth, 44)
  assert.equal(resolved.planned[1].warmth, 0)
})

test('stale or ambiguous monitor identities do not apply captured presets to random displays', () => {
  const saved = capturePreset(3, { name: 'Personal', icon: '' }, screens, warmth)
  const unseen = resolvePreset(saved, [{
    id: 'completely-other', key: 'unmatched', type: 'ddcci', brightness: 30,
  }])
  assert.equal(unseen.planned.length, 0)
  assert.equal(unseen.skipped.length, 2)
  const duplicateKey = resolvePreset(saved, [
    { id: 'replacement-A', key: 'key-one', type: 'ddcci' },
    { id: 'replacement-B', key: 'key-one', type: 'ddcci' },
  ])
  assert.equal(duplicateKey.planned.length, 0)
})

test('capture leaves unsupported monitor warmth unknown, never inventing zero', () => {
  const captured = capturePreset(1, { name: 'Unknown warmth', icon: '' }, screens, { targets: [] })
  assert.equal(captured.targets[0].warmth, null)
  assert.equal(captured.targets[1].warmth, null)
})

test('input guards reject invalid icon, scripts, duplicates, excessive brightness and bad imports', () => {
  const baseline = { ...DEFAULTS[0] }
  assert.throws(() => validatePreset({ ...baseline, icon: 'abcde' }, 1), /icon/)
  assert.throws(() => validatePreset({ ...baseline, name: 'Bad\nname' }, 1), /name/)
  assert.throws(() => validatePreset({ ...baseline, warmth: 101 }, 1), /Warmth/)
  assert.throws(() => validatePreset({ ...baseline, brightness: 201 }, 1), /Brightness/)
  assert.throws(() => validatePreset({
    slot: 1, name: 'dup', icon: '', mode: 'matched',
    targets: [
      { id: 'same', key: 'a', brightness: 50, warmth: 0 },
      { id: 'same', key: 'a', brightness: 60, warmth: 0 },
    ],
  }, 1), /Duplicate/)
  assert.throws(() => importPresets('{}'), /Unsupported/)
  assert.throws(() => importPresets('a'.repeat(70000)), /too large/)
})
