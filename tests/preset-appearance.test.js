const test = require('node:test')
const assert = require('node:assert/strict')
const { presetAppearance } = require('../src/PresetAppearance')

test('preset icon brightness increases with saved brightness level', () => {
  const dim = presetAppearance({ brightness: -80, warmth: 0 })
  const balanced = presetAppearance({ brightness: 50, warmth: 0 })
  const bright = presetAppearance({ brightness: 100, warmth: 0 })
  assert.ok(dim.opacity < balanced.opacity)
  assert.ok(balanced.opacity < bright.opacity)
  assert.equal(presetAppearance({ brightness: 200 }).brightness, 200)
})

test('saved warmth changes the subtle amber tint but does not alter brightness', () => {
  const cool = presetAppearance({ brightness: 50, warmth: 0 })
  const warm = presetAppearance({ brightness: 50, warmth: 75 })
  assert.equal(cool.opacity, warm.opacity)
  assert.notEqual(cool.background, warm.background)
  assert.equal(cool.borderColor, undefined)
  assert.match(warm.borderColor, /^rgba\(242,169,94,/)
})

test('per-monitor profiles preview average real values, ignoring unknown warmth', () => {
  const appearance = presetAppearance({
    mode: 'matched',
    targets: [
      { brightness: 20, warmth: 60 },
      { brightness: 80, warmth: null },
    ],
  })
  assert.equal(appearance.brightness, 50)
  assert.equal(appearance.warmth, 60)
})

test('corrupt or empty preset fields fail to neutral icon presentation', () => {
  const missing = presetAppearance({ mode: 'matched', targets: [] })
  assert.equal(missing.brightness, 50)
  assert.equal(missing.warmth, 0)
  assert.ok(Number.isFinite(missing.opacity))
  assert.ok(missing.opacity > 0 && missing.opacity <= 1)
})
