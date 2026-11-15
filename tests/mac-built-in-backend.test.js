const test = require('node:test')
const assert = require('node:assert/strict')
const { MacBuiltInBackend, parseBuiltInBrightness, findBuiltInBrightness } =
  require('../src/MacBuiltInBackend')

const builtIn = 'display 0: main, active, awake, online, built-in, ID 0x1'
const external = 'display 1: active, awake, online, external, ID 0x3'
const sample = `${builtIn}\ndisplay 0: brightness 0.650000\n${external}\ndisplay 1: brightness 0.400000\n`

function fixture() {
  let value = 65
  let unreadable = false
  let writes = 0
  const runner = (_, args, options, cb) => {
    queueMicrotask(() => {
      if (args[0] === '-l') {
        if (unreadable) return cb(new Error('Readback failed'), '')
        return cb(null, `${builtIn}\ndisplay 0: brightness ${(value / 100).toFixed(6)}\n${external}\n`)
      }
      if (args[0] === '-d' && args[1] === '0x1') {
        writes++
        value = Math.round(Number(args[2]) * 100)
        return cb(null, '')
      }
      return cb(new Error('Unqualified display'), '')
    })
  }
  const backend = new MacBuiltInBackend({ platform: 'darwin', executable: '/opt/homebrew/bin/brightness', runner })
  return { backend, get writes() { return writes }, get value() { return value },
    setUnreadable(x) { unreadable = x } }
}

test('built-in inventory accepts only read-confirmed native displays, excluding externals', () => {
  assert.deepEqual(parseBuiltInBrightness(sample), [{ id: '0x1', level: 65 }])
  assert.deepEqual(parseBuiltInBrightness(`${builtIn}\nbrightness: unable to get brightness of display 0x1\n`), [])
  assert.deepEqual(parseBuiltInBrightness(`${external}\ndisplay 1: brightness 0.500000\n`), [])
  assert.equal(findBuiltInBrightness({ platform: 'win32', exists: () => true }), null)
  assert.equal(findBuiltInBrightness({ platform: 'darwin', exists: p => p.endsWith('/brightness') }), '/opt/homebrew/bin/brightness')
})

test('built-in writes use an exact positive ID and require matching readback', async () => {
  const f = fixture()
  const monitors = await f.backend.refresh()
  assert.equal(monitors['mac-built-in:0x1'].name, 'Built-in Display')
  const result = await f.backend.setBrightness('mac-built-in:0x1', 43)
  assert.deepEqual(result, { id: 'mac-built-in:0x1', level: 43, confirmed: true })
  assert.equal(f.writes, 1)
  await assert.rejects(f.backend.setBrightness('mac-built-in:0x3', 45))
  await assert.rejects(f.backend.setBrightness('mac-built-in:0x1', -80))
  f.backend.close()
})

test('100 rapid slider edits collapse into the last confirmed physical brightness', async () => {
  const f = fixture()
  await f.backend.refresh()
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) =>
    f.backend.setBrightness('mac-built-in:0x1', i + 1)))
  assert.equal(f.writes, 1)
  assert.equal(f.value, 100)
  assert.ok(results.every(r => r.confirmed && r.level === 100))
})

test('failed readback does not retry a command or invent a new cached level', async () => {
  const f = fixture()
  await f.backend.refresh()
  f.setUnreadable(true)
  await assert.rejects(f.backend.setBrightness('mac-built-in:0x1', 22), /refused/)
  assert.equal(f.writes, 1)
  assert.equal(f.backend.snapshot()['mac-built-in:0x1'].brightness, 65)
})

test('failed Mac topology refresh invalidates obsolete display identities', async () => {
  const f = fixture()
  await f.backend.refresh()
  f.setUnreadable(true)
  await assert.rejects(f.backend.refresh(), /refused/)
  assert.deepEqual(f.backend.snapshot(), {})
  await assert.rejects(f.backend.setBrightness('mac-built-in:0x1', 60), /Unknown/)
  assert.equal(f.writes, 0)
})
