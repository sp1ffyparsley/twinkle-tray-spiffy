import React, { useEffect, useRef, useState } from 'react'
const { normalizePresets } = require('../QuickPresets')
const { presetAppearance } = require('../PresetAppearance')
const { createPresetIntentQueue } = require('../PresetIntentQueue')

// A persistent five-button hot row, without previews, hover tooltips or
// background data scans. The main process owns all native display operations.
export default function QuickPresetStrip() {
  const [slots, setSlots] = useState(() => normalizePresets())
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState('')
  const queue = useRef(null)

  useEffect(() => {
    let current = true
    const bridge = window.quickPresets
    if (!bridge) return undefined
    queue.current = createPresetIntentQueue({
      apply: slot => bridge.apply(slot),
      onBusy: slot => setBusy(slot),
      onResult: result => setError(result?.ok ? '' : (result?.error || 'Preset could not be confirmed')),
      onError: issue => setError(issue?.message || 'Preset could not be applied'),
    })
    const unsubscribe = bridge.subscribe(value => { if (current) setSlots(value) })
    bridge.list().then(value => { if (current) setSlots(value) })
      .catch(() => { if (current) setError('Presets unavailable') })
    return () => {
      current = false
      queue.current?.dispose()
      queue.current = null
      unsubscribe()
    }
  }, [])

  const run = slot => {
    setError('')
    queue.current?.press(slot)
  }
  return <div className="quick-presets">
    <div className="quick-preset-buttons" role="group" aria-label="Display presets">
      {slots.map(item => {
        const { opacity: iconOpacity, ...surface } = presetAppearance(item)
        return <button
        key={item.slot} className="quick-preset-button" type="button"
        onClick={() => run(item.slot)}
        aria-busy={busy === item.slot}
        style={surface}
        aria-label={'Apply ' + item.name + ' display preset'}
      ><span className="quick-preset-symbol" style={{ opacity: iconOpacity }} aria-hidden="true">{item.icon || item.slot}</span>
        <span className="quick-preset-slot" aria-hidden="true">{item.slot}</span></button>})}
    </div>
    {error ? <div className="quick-preset-error" role="status">{error}</div> : null}
  </div>
}
