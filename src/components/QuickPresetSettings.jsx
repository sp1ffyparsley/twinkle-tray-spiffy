import React, { useEffect, useState } from 'react'
const { normalizePresets, DEFAULTS } = require('../QuickPresets')

// The same five presets used by the taskbar flyout and tray menu. All editing
// goes through the installed Electron IPC validator; no duplicate config file.
export default function QuickPresetSettings() {
  const [slots, setSlots] = useState(() => normalizePresets())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    if (!window.quickPresets) return undefined
    const unsubscribe = window.quickPresets.subscribe(next => {
      if (active) setSlots(next)
    })
    window.quickPresets.list().then(next => {
      if (active) setSlots(next)
    }).catch(error => { if (active) setMessage(error.message) })
    return () => { active = false; unsubscribe() }
  }, [])

  const update = (index, patch) => setSlots(previous => previous.map((item, at) =>
    at === index ? { ...item, ...patch } : item))
  const updateTarget = (index, targetIndex, field, value) =>
    setSlots(previous => previous.map((item, at) => at !== index ? item : {
      ...item, targets: item.targets.map((target, atTarget) =>
        atTarget === targetIndex ? { ...target, [field]: value } : target),
    }))
  const run = async action => {
    if (busy || !window.quickPresets) return
    setBusy(true)
    setMessage('')
    try { await action(); setMessage('Saved') }
    catch (error) { setMessage(error.message || 'Could not save this preset') }
    finally { setBusy(false) }
  }
  const save = item => run(async () => { setSlots(await window.quickPresets.save(item.slot, item)) })
  const capture = item => run(async () => {
    await window.quickPresets.save(item.slot, item)
    const result = await window.quickPresets.capture(item.slot)
    setSlots(result.slots)
  })
  const reset = item => run(async () => {
    setSlots(await window.quickPresets.save(item.slot, DEFAULTS[item.slot - 1]))
  })
  return <div className="quick-preset-settings">
    <p>Five one-click display presets. Edit the name, symbol and brightness or capture each connected monitor individually.</p>
    {slots.map((item, index) => <div className="quick-preset-setting" key={item.slot}>
      <div className="quick-preset-setting-header">
        <strong>{item.slot}</strong>
        <label>Icon <input type="text" maxLength={6} aria-label={'Preset ' + item.slot + ' icon'}
          value={item.icon} onChange={e => update(index, { icon: e.target.value })}/></label>
        <label>Name <input type="text" maxLength={24} aria-label={'Preset ' + item.slot + ' name'}
          value={item.name} onChange={e => update(index, { name: e.target.value })}/></label>
      </div>
      {item.mode === 'all' ? <div className="quick-preset-setting-values">
        <label>Brightness <input type="number" min={-100} max={200} step={1}
          aria-label={'Preset ' + item.slot + ' brightness'}
          value={item.brightness} onChange={e => update(index, { brightness: Number(e.target.value) })}/></label>
        <label>Warmth <input type="number" min={0} max={100} step={1}
          aria-label={'Preset ' + item.slot + ' warmth'}
          disabled={window.settings?.isMac === true}
          value={item.warmth} onChange={e => update(index, { warmth: Number(e.target.value) })}/></label>
        <span>All displays</span>
      </div> : <div className="quick-preset-target-list">
        {item.targets.map((target, at) => <div className="quick-preset-setting-values" key={target.id}>
          <span>Monitor {at + 1}</span>
          <label>Brightness <input type="number" min={-100} max={200} step={1}
            aria-label={'Preset ' + item.slot + ' monitor ' + (at + 1) + ' brightness'}
            value={target.brightness}
            onChange={e => updateTarget(index, at, 'brightness', Number(e.target.value))}/></label>
          <label>Warmth <input type="number" min={0} max={100} step={1}
            disabled={target.warmth === null || window.settings?.isMac === true} value={target.warmth ?? ''}
            aria-label={'Preset ' + item.slot + ' monitor ' + (at + 1) + ' warmth'}
            onChange={e => updateTarget(index, at, 'warmth', Number(e.target.value))}/></label>
        </div>)}
      </div>}
      <div className="quick-preset-setting-actions">
        <button type="button" disabled={busy} onClick={() => save(item)}>Save</button>
        <button type="button" disabled={busy} onClick={() => capture(item)}>Capture monitors</button>
        <button type="button" disabled={busy} onClick={() => reset(item)}>Default</button>
      </div>
    </div>)}
    <div className="quick-preset-setting-actions">
      <button type="button" disabled={busy} onClick={() => run(() => window.quickPresets.export())}>Export JSON</button>
      <button type="button" disabled={busy} onClick={() => run(async () => {
        const imported = await window.quickPresets.import()
        if (imported?.imported) setSlots(imported.slots)
      })}>Import JSON</button>
    </div>
    {message ? <div role="status" className="quick-preset-setting-message">{message}</div> : null}
  </div>
}
