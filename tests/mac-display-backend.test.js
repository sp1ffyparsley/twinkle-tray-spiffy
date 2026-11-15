const test = require('node:test')
const assert = require('node:assert/strict')
const {
  MacDisplayBackend, parseMacDisplayList, parseMacBrightness, findMacDDC,
} = require('../src/MacDisplayBackend')

const A = '10ACB8A0-0000-0000-1419-0104A2435078'
const B = 'B6C4D2A8-1000-2345-8765-AB12CD34EF56'
const listing = `[1] Dell U2723QE (${A})\n[2] LG 27UP850 (${B})\n - Product name: LG 27UP850\n`

function fixture() {
  const calls = []
  const levels = new Map([[A, 20], [B, 70]])
  let failRead = false
  let active = 0
  let maxConcurrent = 0
  const runner = (_binary, args, _opts, callback) => {
    calls.push(args)
    active++
    maxConcurrent = Math.max(maxConcurrent, active)
    setImmediate(() => {
      active--
      if (args[0] === 'display' && args[1] === 'list') return callback(null, listing)
      const uuid = String(args[1]).slice(5)
      if (!levels.has(uuid)) return callback(Error('No display'), '')
      if (args[2] === 'max') return callback(null, '100\n')
      if (args[2] === 'get') return failRead ? callback(Error('DDC unavailable'), '') : callback(null, String(levels.get(uuid)) + '\n')
      if (args[2] === 'set') {
        levels.set(uuid, Number(args[4]))
        return callback(null, 'Writing ' + args[4] + '\n')
      }
      callback(Error('Unknown command'), '')
    })
  }
  const backend = new MacDisplayBackend({
    platform: 'darwin', arch: 'arm64', executable: '/opt/homebrew/bin/m1ddc', runner,
  })
  return { backend, calls, levels, setFailRead: value => { failRead = value }, maxConcurrent: () => maxConcurrent }
}

test('m1ddc parser accepts only distinct stable UUIDs, never shifting display numbers', () => {
  const found = parseMacDisplayList(listing)
  assert.deepEqual(found.map(m => m.uuid), [A, B])
  assert.equal(found[1].name, 'LG 27UP850')
  assert.throws(() => parseMacDisplayList('[1] Broken (garbage)'), /identity/)
  assert.throws(() => parseMacDisplayList(`[1] Monitor (${A})\n[2] Another (${A})\n`), /Duplicate/)
  assert.throws(() => parseMacBrightness('42\nSomething else'), /numeric/)
  assert.equal(parseMacBrightness('42\n'), 42)
})

test('Mac DDC driver is only offered on Apple Silicon macOS with a known binary', () => {
  const exists = filename => filename === '/opt/homebrew/bin/m1ddc'
  assert.equal(findMacDDC({ platform: 'darwin', arch: 'arm64', exists }), '/opt/homebrew/bin/m1ddc')
  assert.equal(findMacDDC({ platform: 'win32', arch: 'x64', exists }), null)
  assert.equal(findMacDDC({ platform: 'darwin', arch: 'x64', exists }), null)
})

test('two displays report separate confirmed values and preserve human-readable names', async () => {
  const f = fixture()
  const found = await f.backend.refresh()
  assert.equal(Object.keys(found).length, 2)
  assert.equal(found['mac-ddc:' + A].name, 'Dell U2723QE')
  assert.equal(found['mac-ddc:' + B].brightness, 70)
  const updated = await f.backend.setBrightness('mac-ddc:' + A, 34)
  assert.equal(updated.confirmed, true)
  assert.equal(f.backend.snapshot()['mac-ddc:' + A].brightness, 34)
  assert.equal(f.backend.snapshot()['mac-ddc:' + B].brightness, 70)
  f.backend.close()
})

test('DDC bus access is serialized; disconnected and out-of-range requests fail closed', async () => {
  const f = fixture()
  await f.backend.refresh()
  await Promise.all([
    f.backend.setBrightness('mac-ddc:' + A, 23),
    f.backend.setBrightness('mac-ddc:' + B, 54),
  ])
  assert.equal(f.maxConcurrent(), 1)
  assert.deepEqual([f.levels.get(A), f.levels.get(B)], [23, 54])
  await assert.rejects(f.backend.setBrightness('mac-ddc:UNKNOWN', 50), /unknown/)
  await assert.rejects(f.backend.setBrightness('mac-ddc:' + A, -80), /0 to 100/)
  await assert.rejects(f.backend.setBrightness('mac-ddc:' + A, 120), /0 to 100/)
})

test('readback errors leave the last confirmed brightness and never retry a blind write', async () => {
  const f = fixture()
  await f.backend.refresh()
  f.setFailRead(true)
  await assert.rejects(f.backend.setBrightness('mac-ddc:' + A, 36), /rejected or timed out/)
  assert.equal(f.backend.snapshot()['mac-ddc:' + A].brightness, 20)
  assert.equal(f.calls.filter(args => args[2] === 'set').length, 1)
})

test('rapid Mac slider dragging coalesces intermediate inputs while retaining the final target', async () => {
  const f = fixture()
  await f.backend.refresh()
  const promises = []
  for (let level = 1; level <= 100; level++) {
    promises.push(f.backend.setBrightness('mac-ddc:' + A, level))
  }
  const settled = await Promise.all(promises)
  assert.equal(f.levels.get(A), 100)
  assert.ok(settled.every(result => result.confirmed && result.level === 100))
  assert.equal(f.calls.filter(args => args[2] === 'set').length, 1)
  assert.equal(f.maxConcurrent(), 1)
})
