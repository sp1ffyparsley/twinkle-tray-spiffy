const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const source = name => fs.readFileSync(path.join(root, name), 'utf8')

test('brightness slider always renders the full configured monitor name', () => {
  const slider = source('src/components/Slider.jsx')
  const panel = source('src/components/BrightnessPanel.jsx')
  assert.match(slider, /className="title">\{this\.props\.name\}/)
  assert.doesNotMatch(slider, /this\.props\.compactName/)
  assert.doesNotMatch(panel, /compactName=/)
  assert.match(panel, /name=\{getMonitorName\(monitor, state\.names\)\}/)
  assert.match(panel, /name=\{T\.t\("GENERIC_ALL_DISPLAYS"\)\}/)
  assert.equal((panel.match(/className="title">\{getMonitorName\(monitor, state\.names\)\}/g) || []).length, 2)
})

test('five small preset buttons stay below monitor sliders, retaining icon and number', () => {
  const panel = source('src/components/BrightnessPanel.jsx')
  const presets = source('src/components/QuickPresetStrip.jsx')
  const styles = source('src/css/panel.scss')
  assert.ok(panel.indexOf('getMonitors()}') < panel.indexOf('<QuickPresetStrip />'))
  assert.match(presets, /className="quick-preset-symbol"/)
  assert.match(presets, /className="quick-preset-slot"/)
  assert.match(styles, /\.quick-preset-button\s*\{[^}]*width:\s*32px;/s)
  assert.match(styles, /\.quick-preset-button\s*\{[^}]*height:\s*30px;/s)
})
