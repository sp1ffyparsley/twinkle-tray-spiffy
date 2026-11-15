import React from 'react'
const { matchMonitorWarmthTarget } = require('../MonitorWarmthMapping')

// Each normal-panel monitor gets its own compact warmth control directly
// below brightness. Only a positively matched Win32 display is writable.
// The existing Command Palette Night Filter owner handles native effects.
export default function NightFilterControl({ monitor, label, status, draft, onChange }) {
  const target = matchMonitorWarmthTarget(monitor, status?.targets)
  // Plain upstream installations do not ship the optional per-display Spiffy
  // owner. Do not render an inert, text-heavy dummy slider on those machines.
  if (!target) return null
  const strength = target
    ? Number.isInteger(draft?.[target.id])
      ? draft[target.id]
      : target.enabled ? target.strength : 0
    : 0
  const disabled = !target || monitor?.hdr === 'active'
  return (
    <div className="monitor-warmth" role="group" aria-label={label + ' night warmth'}>
      <input
        className="monitor-warmth-range"
        type="range"
        min={0} max={100} step={1}
        value={strength}
        disabled={disabled}
        aria-label={label + ' night warmth'}
        aria-valuetext={strength === 0 ? 'Off' : strength + ' percent'}
        onChange={event => {
          if (target && !disabled) onChange(target.id, Number(event.currentTarget.value))
        }}
      />
      <output className="monitor-warmth-value" aria-live="off">
        {target ? (disabled ? '—' : strength + '%') : '—'}
      </output>
    </div>
  )
}
