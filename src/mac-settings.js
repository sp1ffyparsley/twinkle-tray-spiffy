import React from 'react'
import { createRoot } from 'react-dom/client'
import QuickPresetSettings from './components/QuickPresetSettings'

createRoot(document.getElementById('mac-preset-settings')).render(
  <main>
    <h1 style={{ fontSize: 17, margin: '0 0 12px' }}>Spiffy Presets</h1>
    <QuickPresetSettings />
  </main>,
)
