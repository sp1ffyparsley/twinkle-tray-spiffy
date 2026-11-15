// The brightness effect range is asymmetric.  Keep zero at the physical
// midpoint of the slider while retaining the original integer values.
const POSITION_STEPS = 1000

function positionFromLevel(level, min, max, zeroCentered = false) {
  const value = Math.max(min, Math.min(max, Number(level)))
  if (zeroCentered && min < 0 && max > 0) {
    return Math.round(POSITION_STEPS * (value <= 0
      ? (value - min) / (0 - min) / 2
      : 0.5 + value / max / 2))
  }
  return Math.round(POSITION_STEPS * (value - min) / (max - min))
}

function levelFromPosition(position, min, max, zeroCentered = false) {
  const fraction = Math.max(0, Math.min(1, Number(position) / POSITION_STEPS))
  if (zeroCentered && min < 0 && max > 0) {
    return Math.round(fraction <= 0.5
      ? min + fraction * 2 * (0 - min)
      : (fraction - 0.5) * 2 * max)
  }
  return Math.round(min + fraction * (max - min))
}

function keyboardLevel(level, key, min, max) {
  const steps = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1,
    PageDown: -10, PageUp: 10 }
  let requested
  if (key === 'Home') requested = min
  else if (key === 'End') requested = max
  else if (Object.hasOwn(steps, key)) requested = level + steps[key]
  else return undefined
  return Math.max(min, Math.min(max, requested))
}

module.exports = { POSITION_STEPS, positionFromLevel, levelFromPosition, keyboardLevel }
