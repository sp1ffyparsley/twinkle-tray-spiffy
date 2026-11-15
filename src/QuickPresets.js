// One five-slot preset contract in the existing Twinkle settings.json.
// Platform adapters may consume this portable JSON, but must match physical
// displays before writing them. No new database, watcher or resident is used.
const { matchMonitorWarmthTarget } = require('./MonitorWarmthMapping')

const SCHEMA = 'spiffy.display.quick_presets.v1'
const COUNT = 5
const DEFAULTS = [
  { slot: 1, name: 'Bright', icon: '☀', mode: 'all', brightness: 100, warmth: 0 },
  { slot: 2, name: 'Work', icon: '◉', mode: 'all', brightness: 75, warmth: 0 },
  { slot: 3, name: 'Balanced', icon: '◐', mode: 'all', brightness: 50, warmth: 0 },
  { slot: 4, name: 'Evening', icon: '☾', mode: 'all', brightness: 30, warmth: 25 },
  { slot: 5, name: 'Dim', icon: '●', mode: 'all', brightness: 15, warmth: 45 },
]

const integer = (value, min, max, label) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw Error(label + ' must be an integer from ' + min + ' to ' + max)
  }
  return value
}
function cleanName(value) {
  if (typeof value !== 'string') throw Error('A preset name must be text')
  const name = value.trim()
  if (!name || Array.from(name).length > 24 || /[\x00-\x1f\x7f]/.test(name)) throw Error('Preset name must be 1–24 visible characters')
  return name
}
function cleanIcon(value) {
  if (typeof value !== 'string') throw Error('Preset icon must be text')
  const icon = value.trim()
  if (Array.from(icon).length > 4 || /[\x00-\x1f\x7f]/.test(icon)) throw Error('Preset icon must be at most four visible characters')
  return icon
}
function displayTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid preset display target')
  const id = String(raw.id || '').trim()
  const key = String(raw.key || '').trim()
  if (!id || id.length > 250 || key.length > 250) throw Error('Invalid preset display identity')
  return {
    id, key,
    brightness: integer(raw.brightness, -100, 200, 'Brightness'),
    warmth: raw.warmth === null ? null : integer(raw.warmth, 0, 100, 'Warmth'),
  }
}
function validatePreset(raw, slot) {
  const index = integer(slot, 1, COUNT, 'Preset slot')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid preset')
  const name = cleanName(raw.name)
  const icon = cleanIcon(raw.icon ?? '')
  const mode = raw.mode
  if (mode !== 'all' && mode !== 'matched') throw Error('Invalid preset scope')
  const result = { slot: index, name, icon, mode }
  if (mode === 'all') {
    result.brightness = integer(raw.brightness, -100, 200, 'Brightness')
    result.warmth = integer(raw.warmth, 0, 100, 'Warmth')
  } else {
    if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > 16) {
      throw Error('Matched preset requires 1–16 explicitly captured displays')
    }
    result.targets = raw.targets.map(displayTarget)
    const ids = result.targets.map(t => t.id.toLowerCase())
    if (new Set(ids).size !== ids.length) throw Error('Duplicate physical display in preset')
  }
  return result
}
function normalizePresets(raw) {
  const entries = Array.isArray(raw) ? raw : []
  return DEFAULTS.map((defaults, index) => {
    const saved = entries.find(item => item && item.slot === index + 1)
    try { return saved ? validatePreset(saved, index + 1) : { ...defaults } }
    catch (_) { return { ...defaults } }
  })
}
function resolvePreset(preset, live) {
  const defined = validatePreset(preset, preset.slot)
  const monitors = (Array.isArray(live) ? live : Object.values(live || {}))
    .filter(m => m && typeof m.id === 'string' && m.id && m.type !== 'none' && m.type !== undefined)
  const planned = []
  const skipped = []
  if (defined.mode === 'all') {
    for (const monitor of monitors) {
      planned.push({ monitor, brightness: defined.brightness, warmth: defined.warmth })
    }
  } else {
    for (const target of defined.targets) {
      let matches = monitors.filter(m => m.id === target.id)
      if (!matches.length && target.key) matches = monitors.filter(m => m.key === target.key)
      if (matches.length !== 1) {
        skipped.push(target.id)
        continue
      }
      if (planned.some(item => item.monitor.id === matches[0].id)) {
        skipped.push(target.id)
        continue
      }
      planned.push({ monitor: matches[0], brightness: target.brightness, warmth: target.warmth })
    }
  }
  return { planned, skipped }
}
function capturePreset(slot, metadata, monitors, displayStatus) {
  const targets = []
  const items = Array.isArray(monitors) ? monitors : Object.values(monitors || {})
  for (const monitor of items) {
    if (!monitor || typeof monitor.id !== 'string' || !monitor.id ||
        typeof monitor.brightness !== 'number' || !Number.isInteger(Math.round(monitor.brightness)) ||
        monitor.type === 'none') continue
    const native = matchMonitorWarmthTarget(monitor, displayStatus?.targets)
    targets.push({
      id: monitor.id,
      key: String(monitor.key || ''),
      brightness: Math.max(-100, Math.min(200, Math.round(monitor.brightness))),
      warmth: native ? (native.enabled ? native.strength : 0) : null,
    })
  }
  return validatePreset({ name: metadata.name, icon: metadata.icon, mode: 'matched', targets }, slot)
}
function exportPresets(presets) {
  return JSON.stringify({ schema: SCHEMA, slots: normalizePresets(presets) }, null, 2) + '\n'
}
function importPresets(contents) {
  if (typeof contents !== 'string' || contents.length > 64 * 1024) throw Error('Preset document is too large')
  const data = JSON.parse(contents)
  if (data.schema !== SCHEMA || !Array.isArray(data.slots) || data.slots.length !== COUNT) {
    throw Error('Unsupported five-slot preset format')
  }
  const seen = new Set()
  const result = data.slots.map(p => {
    const slot = integer(p.slot, 1, COUNT, 'Preset slot')
    if (seen.has(slot)) throw Error('Duplicate preset slot')
    seen.add(slot)
    return validatePreset(p, slot)
  })
  return result.sort((a, b) => a.slot - b.slot)
}

module.exports = { COUNT, DEFAULTS, SCHEMA, validatePreset, normalizePresets, resolvePreset, capturePreset, exportPresets, importPresets }
