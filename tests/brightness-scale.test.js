const test = require('node:test')
const assert = require('node:assert/strict')
const { POSITION_STEPS, positionFromLevel, levelFromPosition, keyboardLevel } = require('../src/BrightnessScale')

test('asymmetric brightness has physical endpoints and zero at the center', () => {
  assert.equal(positionFromLevel(-100, -100, 200, true), 0)
  assert.equal(positionFromLevel(0, -100, 200, true), POSITION_STEPS / 2)
  assert.equal(positionFromLevel(200, -100, 200, true), POSITION_STEPS)
  assert.equal(levelFromPosition(0, -100, 200, true), -100)
  assert.equal(levelFromPosition(POSITION_STEPS / 2, -100, 200, true), 0)
  assert.equal(levelFromPosition(POSITION_STEPS, -100, 200, true), 200)
})

test('asymmetric brightness preserves actual values across the control', () => {
  for (const level of [-100, -75, -50, -25, 0, 25, 50, 75, 100, 150, 200]) {
    assert.equal(levelFromPosition(positionFromLevel(level, -100, 200, true), -100, 200, true), level)
  }
  assert.equal(positionFromLevel(-50, -100, 200, true), 250)
  assert.equal(positionFromLevel(100, -100, 200, true), 750)
})

test('ordinary 0-100 controls retain linear behavior', () => {
  assert.equal(positionFromLevel(50, 0, 100, true), POSITION_STEPS / 2)
  assert.equal(levelFromPosition(POSITION_STEPS / 4, 0, 100, true), 25)
  assert.equal(positionFromLevel(50, -100, 200, false), 500)
  assert.equal(levelFromPosition(500, -100, 200, false), 50)
})

test('keyboard brightness changes one logical unit, even near zero', () => {
  assert.equal(keyboardLevel(0, 'ArrowLeft', -100, 200), -1)
  assert.equal(keyboardLevel(0, 'ArrowRight', -100, 200), 1)
  assert.equal(keyboardLevel(0, 'ArrowUp', -100, 200), 1)
  assert.equal(keyboardLevel(0, 'PageDown', -100, 200), -10)
  assert.equal(keyboardLevel(0, 'PageUp', -100, 200), 10)
  assert.equal(keyboardLevel(0, 'Home', -100, 200), -100)
  assert.equal(keyboardLevel(0, 'End', -100, 200), 200)
  assert.equal(keyboardLevel(200, 'ArrowRight', -100, 200), 200)
  assert.equal(keyboardLevel(0, 'Tab', -100, 200), undefined)
})
