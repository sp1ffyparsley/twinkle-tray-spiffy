const test = require('node:test')
const assert = require('node:assert/strict')
const { NightFilter, validatePatch, parseResult } = require('../src/NightFilter')
const path = require('node:path')
const fs = require('node:fs')
const scriptsRoot = path.resolve(__dirname, '../..')
// Simulated child/IPC tests do not need the private optional Spiffy Workspace.
// The real helper is checked only in the separately marked integration case.
const simulatedFilter = options => new NightFilter({ scriptsRoot, fileExists: () => true, ...options })
const nativeHelperExists = fs.existsSync(path.join(scriptsRoot, 'utilities', 'powershell', 'Set-NightLight.ps1'))
const result = overrides => JSON.stringify({ kind: 'custom_filter', enabled: 0, worker_running: 0,
  strength: 40, dimness: 0, tint: 0, dim_duration_minutes: 180, error: false, ...overrides })
const settled = bridge => new Promise(resolve => {
  const listener = status => { if (!status.pending) { bridge.off('status', listener); resolve(status) } }
  bridge.on('status', listener)
})

test('strict IPC validation rejects injections, malformed fields and out-of-range values', () => {
  for (const patch of [null, [], {}, { enabled: 1 }, { strength: '5;exit' }, { strength: 101 },
    { dimness: 100 }, { dim_duration_minutes: -1 }, { path: 'bad' }, { tint: NaN }]) {
    assert.throws(() => validatePatch(patch))
  }
  assert.deepEqual(validatePatch({ enabled: false, strength: 0, tint: -100 }), { enabled: false, strength: 0, tint: -100 })
  assert.throws(() => parseResult('{}'))
  assert.throws(() => parseResult(result({ strength: 101 })))
})

test('3000 slider requests merge into one final child command without enabling a disabled filter', async () => {
  const calls = []
  const bridge = simulatedFilter({ debounceMs: 0, run: (_exe, args, options, callback) => {
    calls.push({ args, options })
    setImmediate(() => callback(null, result()))
  } })
  const done = settled(bridge)
  for (let i = 0; i < 3000; i++) bridge.set({ strength: i % 101 })
  const state = await done
  assert.equal(calls.length, 2) // Initial status then one final write.
  assert.equal(calls[1].args[calls[1].args.indexOf('-Mode') + 1], 'FilterOff')
  assert.equal(calls[1].args[calls[1].args.indexOf('-Strength') + 1], String(2999 % 101))
  assert.equal(calls[1].options.windowsHide, true)
  assert.equal(calls[1].options.maxBuffer, 65536)
  assert.equal(state.enabled, false)
})

test('off queued during startup runs after startup, with at most one live child', async () => {
  const calls = []; let active = 0; let peak = 0; let release
  const bridge = simulatedFilter({ debounceMs: 0, run: (_exe, args, _options, callback) => {
    const mode = args[args.indexOf('-Mode') + 1]
    calls.push(mode); peak = Math.max(peak, ++active)
    const complete = () => { active--; callback(null, result({ enabled: mode === 'FilterOn' ? 1 : 0, worker_running: mode === 'FilterOn' ? 1 : 0 })) }
    if (mode === 'FilterOn') release = complete
    else setImmediate(complete)
  } })
  const done = settled(bridge)
  bridge.set({ enabled: true })
  while (!release) await new Promise(resolve => setTimeout(resolve, 2))
  bridge.set({ enabled: false }); release()
  assert.equal((await done).enabled, false)
  assert.deepEqual(calls, ['FilterStatus', 'FilterOn', 'FilterOff'])
  assert.equal(peak, 1)
})

test('uncertain failure discards queued mutations; explicit refresh reconciles without replay', async () => {
  const calls = []; let release
  const bridge = simulatedFilter({ debounceMs: 0, run: (_exe, args, _options, callback) => {
    const mode = args[args.indexOf('-Mode') + 1]; calls.push(mode)
    if (mode === 'FilterOn') release = () => callback({ killed: true }, '')
    else setImmediate(() => callback(null, result()))
  } })
  let done = settled(bridge); bridge.set({ enabled: true })
  while (!release) await new Promise(resolve => setTimeout(resolve, 2))
  bridge.set({ strength: 60 }); release()
  assert.match((await done).error, /outcome is unconfirmed/)
  done = settled(bridge); bridge.refresh()
  assert.equal((await done).available, true)
  assert.deepEqual(calls, ['FilterStatus', 'FilterOn', 'FilterStatus'])
})

test('missing owner fails visibly without starting a process', async () => {
  const bridge = new NightFilter({ scriptsRoot: path.join(__dirname, 'absent'), run: () => assert.fail('must not start') })
  const done = settled(bridge); bridge.refresh()
  assert.match((await done).error, /helper is missing/)
})

test('toggle reads external state and explicit off supersedes queued toggle', async () => {
  const calls = []
  const bridge = simulatedFilter({ debounceMs: 0, run: (_exe, args, _options, callback) => {
    const mode = args[args.indexOf('-Mode') + 1]; calls.push(mode)
    setImmediate(() => callback(null, result({ enabled: mode === 'FilterStatus' ? 1 : 0 })))
  } })
  let done = settled(bridge); bridge.toggle()
  assert.equal((await done).enabled, false)
  assert.deepEqual(calls, ['FilterStatus', 'FilterOff'])
  calls.length = 0
  done = settled(bridge); bridge.toggle(); bridge.set({ enabled: false })
  await done
  assert.deepEqual(calls, ['FilterOff'])
})

test('actual installed PowerShell helper returns authoritative status without display mutation',
  { skip: process.platform !== 'win32' || !nativeHelperExists, timeout: 20000 }, async () => {
    const bridge = new NightFilter({ scriptsRoot })
    const done = settled(bridge); bridge.refresh()
    const state = await done
    assert.equal(state.error, '')
    assert.equal(state.available, true)
    assert.equal(typeof state.running, 'boolean')
  })

test('On cannot reactivate the old hidden 80 percent global dimming', async () => {
  const calls = []
  const bridge = simulatedFilter({ debounceMs: 0, run: (_exe, args, _options, callback) => {
    const mode = args[args.indexOf('-Mode') + 1]
    calls.push(args)
    setImmediate(() => callback(null, result({ strength: 99, dimness: mode === 'FilterStatus' ? 80 : 0, enabled: mode === 'FilterOn' ? 1 : 0 })))
  } })
  const done = settled(bridge); bridge.set({ enabled: true })
  assert.equal((await done).dimness, 0)
  assert.equal(calls[1][calls[1].indexOf('-Dimness') + 1], '0')
  assert.equal(calls[1][calls[1].indexOf('-Tint') + 1], '0')
})

test('live slider edits use the existing renderer and uncertain replies never fall back to mutation', async () => {
  let fail = false; const calls = []
  const bridge = simulatedFilter({ debounceMs: 0,
    run: () => assert.fail('No PowerShell launch while renderer is connected'),
    resident: async (mode, patch) => {
      calls.push([mode, patch])
      if (fail) throw Error('outcome is unconfirmed')
      return JSON.parse(JSON.stringify({ available: true, enabled: mode === 'FilterOn', running: true, strength: patch.strength || 0, dimness: 0, tint: 0, dim_duration_minutes: 0 }))
    } })
  let done = settled(bridge); bridge.set({ enabled: true, strength: 20 }); await done
  assert.equal(calls.at(-1)[0], 'FilterOn')
  assert.equal(calls.at(-1)[1].dimness, 0)
  fail = true; done = settled(bridge); bridge.set({ enabled: true, strength: 30 })
  assert.match((await done).error, /unconfirmed/)
})

test('renderer exit during final effect removal reconciles Ensure, but never repeats an uncertain On', async () => {
  const calls = []
  const bridge = simulatedFilter({ debounceMs: 0,
    resident: async () => { throw Error('Resident filter closed before confirming the change') },
    run: (_exe, args, _options, callback) => { calls.push(args[args.indexOf('-Mode') + 1]); setImmediate(() => callback(null, result())) } })
  assert.equal((await bridge.ensure()).running, false)
  assert.deepEqual(calls, ['FilterEnsure'])
  const done = settled(bridge); bridge.set({ enabled: true, strength: 20 })
  assert.match((await done).error, /closed before confirming/)
  assert.deepEqual(calls, ['FilterEnsure'])
})
