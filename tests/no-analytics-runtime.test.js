const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = name => fs.readFileSync(path.join(root, name), 'utf8')

test('Spiffy ships no Google Analytics runtime dependency or telemetry sender', () => {
  const pkg = JSON.parse(read('package.json'))
  const main = read('src/electron.js')
  assert.equal(Object.hasOwn(pkg.dependencies, 'ga4-mp'), false)
  assert.doesNotMatch(main, /require\s*\(\s*['"]ga4-mp['"]\s*\)/)
  assert.doesNotMatch(main, /pingAnalytics\s*\(/)
  assert.doesNotMatch(main, /analyticsInterval|analyticsFrequency|lastAnalyticsPing/)
  // Preserve legacy settings compatibility while permanently disabling any
  // old user analytics preference.
  assert.match(main, /if\s*\(isSpiffy\)\s*settings\.analytics\s*=\s*false/)
})

test('users cannot accidentally reenable a removed analytics sender in Settings', () => {
  const settings = read('src/components/SettingsWindow.jsx')
  assert.doesNotMatch(settings, /renderToggle\(\s*['"]analytics['"]\s*\)/)
  assert.doesNotMatch(settings, /SETTINGS_GENERAL_ANALYTICS_TITLE/)
})
