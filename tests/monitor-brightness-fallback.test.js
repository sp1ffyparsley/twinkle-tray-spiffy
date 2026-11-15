const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

const source = fs.readFileSync(require.resolve('../src/Monitors.js'), 'utf8')
const start = source.indexOf('async function setBrightness(')
const end = source.indexOf('\nlet vcpCache = {}', start)
assert.notEqual(start, -1, 'Monitors.js must retain its canonical setBrightness owner')
assert.notEqual(end, -1, 'Monitors.js setBrightness extraction must end before VCP cache state')
const implementation = source.slice(start, end)

function createSetter({ monitors, highLevel, vcp, customCodes = {}, studio = async () => undefined }) {
  const calls = []
  const setBrightness = vm.runInNewContext(`${implementation}\n;setBrightness`, {
    monitors,
    settings: { disableHighLevel: false },
    ddcBrightnessVCPs: customCodes,
    setHighLevelBrightness: async (...args) => { calls.push(['high-level', ...args]); return highLevel(...args) },
    setVCP: async (...args) => { calls.push(['vcp', ...args]); return vcp(...args) },
    setStudioDisplayBrightness: async (...args) => { calls.push(['studio', ...args]); return studio(...args) },
    console: { log: () => {} },
    Object,
    Error,
    parseInt,
  })
  return { setBrightness, calls }
}

function monitor(id, serial, brightnessType = 0x10) {
  return {
    id,
    type: 'ddcci',
    serial,
    hwid: ['DISPLAY', serial, `INSTANCE-${serial}`],
    brightnessType,
    brightness: 25,
    brightnessRaw: 25,
    brightnessMax: 100,
    brightnessValues: [25, 100],
    highLevelSupported: { brightness: true },
  }
}

test('failed high-level brightness falls back only to that monitor’s supported VCP code', async () => {
  const first = monitor('DISPLAY#A#INSTANCE-A', 'A', 0x10)
  const second = monitor('DISPLAY#B#INSTANCE-B', 'B', 0x13)
  const { setBrightness, calls } = createSetter({
    monitors: { first, second },
    highLevel: async id => id === first.id ? false : undefined,
    vcp: async () => undefined,
  })

  assert.equal(await setBrightness(64, first.id), undefined)
  assert.deepEqual(calls, [
    ['high-level', first.hwid.join('#'), 64],
    ['vcp', first.hwid.join('#'), 0x10, 64],
  ])
  assert.equal(first.brightness, 64)
  assert.equal(first.brightnessRaw, 64)
  assert.equal(first.brightnessValues[0], 64)

  calls.length = 0
  assert.equal(await setBrightness(72, second.id), undefined)
  assert.deepEqual(calls, [['high-level', second.hwid.join('#'), 72]],
    'A successful high-level write must not send a duplicate VCP command')
  assert.equal(second.brightness, 72)
})

test('failed high-level and VCP writes preserve the last confirmed per-monitor brightness', async () => {
  const failed = monitor('DISPLAY#FAILED#INSTANCE-FAILED', 'FAILED', 0x13)
  const healthy = monitor('DISPLAY#HEALTHY#INSTANCE-HEALTHY', 'HEALTHY', 0x10)
  const { setBrightness, calls } = createSetter({
    monitors: { failed, healthy },
    highLevel: async id => id === failed.hwid.join('#') ? false : undefined,
    vcp: async id => id === failed.hwid.join('#') ? false : undefined,
  })

  assert.equal(await setBrightness(90, failed.id), false)
  assert.deepEqual(calls, [
    ['high-level', failed.hwid.join('#'), 90],
    ['vcp', failed.hwid.join('#'), 0x13, 90],
  ])
  assert.equal(failed.brightness, 25)
  assert.equal(failed.brightnessRaw, 25)
  assert.equal(failed.brightnessValues[0], 25)

  calls.length = 0
  assert.equal(await setBrightness(35, healthy.id), undefined)
  assert.deepEqual(calls, [['high-level', healthy.hwid.join('#'), 35]])
  assert.equal(healthy.brightness, 35)
})

test('no VCP fallback is attempted when the monitor has no valid brightness code', async () => {
  const display = monitor('DISPLAY#NO-VCP#INSTANCE-NO-VCP', 'NO-VCP', false)
  const { setBrightness, calls } = createSetter({
    monitors: { display },
    highLevel: async () => false,
    vcp: async () => assert.fail('Must not guess a VCP code'),
  })

  assert.equal(await setBrightness(40, display.id), false)
  assert.deepEqual(calls, [['high-level', display.hwid.join('#'), 40]])
  assert.equal(display.brightness, 25)
  assert.equal(display.brightnessRaw, 25)
})
