// Derive one tiny visual indicator from the saved preset, not the monitor's
// current live value. Custom icons are retained; brightness controls their
// apparent luminance and warmth adds a subtle amber background.
const bounded = (value, lower, upper) => Math.max(lower, Math.min(upper, value))

function presetAppearance(preset) {
  const values = preset?.mode === 'matched' && Array.isArray(preset.targets)
    ? preset.targets : [preset]
  const bright = values.map(row => row?.brightness).filter(Number.isFinite)
  const warm = values.map(row => row?.warmth).filter(Number.isFinite)
  const avg = array => array.reduce((sum, value) => sum + value, 0) / array.length
  const brightness = bright.length ? bounded(avg(bright), -100, 200) : 50
  const warmth = warm.length ? bounded(avg(warm), 0, 100) : 0
  const light = brightness < 0
    ? 0.16 + (brightness + 100) / 100 * 0.15
    : 0.31 + bounded(brightness, 0, 100) / 100 * 0.69
  const tint = warmth / 100
  return {
    brightness,
    warmth,
    opacity: Number((0.48 + light * 0.52).toFixed(3)),
    background: `linear-gradient(180deg, rgba(255,185,95,${(tint * 0.36).toFixed(3)}), rgba(255,255,255,${(light * 0.10).toFixed(3)}))`,
    borderColor: tint > 0.02 ? `rgba(242,169,94,${(0.22 + tint * 0.53).toFixed(3)})` : undefined,
    boxShadow: `inset 0 0 0 1px rgba(255,255,255,${(light * 0.07).toFixed(3)})`,
  }
}

module.exports = { presetAppearance }
