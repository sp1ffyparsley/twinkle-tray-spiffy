import React, { useEffect, useState } from 'react'
const { normalizePresets } = require('../QuickPresets')
const { presetAppearance } = require('../PresetAppearance')

// A persistent five-button hot row, without previews, hover tooltips or
// background data scans. The main process owns all native display operations.
export default function QuickPresetStrip() {
  const [slots, setSlots] = useState(() => normalizePresets())
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    const bridge = window.quickPresets
    if (!bridge) return undefined
    const unsubscribe = bridge.subscribe(value => { if (current) setSlots(value) })
    bridge.list().then(value => { if (current) setSlots(value) })
      .catch(() => { if (current) setError('Presets unavailable') })
    return () => { current = false; unsubscribe() }
  }, [])

  const run = async slot => {
    if (!window.quickPresets || busy) return
    setBusy(slot)
    setError('')
    try {
      const result = await window.quickPresets.apply(slot)
      if (!result?.ok) setError(result?.error || 'Preset could not be confirmed')
    } catch (e) {
      setError(e?.message || 'Preset could not be applied')
    } finally {
      setBusy(0)
    }
  }
  return <div className="quick-presets">
    <div className="quick-preset-buttons" role="group" aria-label="Display presets">
      {slots.map(item => <button
        key={item.slot} className="quick-preset-button" type="button"
        disabled={busy !== 0}
        onClick={() => run(item.slot)}
        style={presetAppearance(item)}
        aria-label={'Apply ' + item.name + ' display preset'}
      ><span className="quick-preset-symbol" aria-hidden="true">{item.icon || item.slot}</span>
        <span className="quick-preset-slot" aria-hidden="true">{item.slot}</span></button>)}
    </div>
    {error ? <div className="quick-preset-error" role="status">{error}</div> : null}
  </div>
}
