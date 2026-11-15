const test = require('node:test')
const assert = require('node:assert/strict')
const { ExtendedBrightness, mapBrightness, effectiveLightTransmission } = require('../src/ExtendedBrightness')
const fs = require('node:fs')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

test('confirmed brightness surfaces monitor-worker dispatch refusal immediately and releases its listener', async () => {
  const source = fs.readFileSync(require.resolve('../src/electron.js'), 'utf8')
  const body = source.slice(source.indexOf('function sendConfirmedBrightness('), source.indexOf('function getExtendedBrightness('))
  const events = new EventEmitter(); const scheduled = []; let cancelled = 0
  const context = { vcpRequestSequence: 0, monitorsEventEmitter: events,
    monitorsThread: { once: (event, cb) => events.once(event, cb), send: async () => { throw Error('Worker unavailable') } },
    setTimeout: cb => { scheduled.push(cb); return 1 }, clearTimeout: () => { cancelled++ }, Date }
  const send = vm.runInNewContext(body + ';sendConfirmedBrightness', context)
  await assert.rejects(send({ id: 'test' }, 20), /Worker unavailable/)
  assert.equal(events.listenerCount('brightness-confirmed::1'), 0)
  assert.equal(cancelled, 1)
  assert.equal(scheduled.length, 1)
})

test('confirmed brightness dispatch fails closed when the monitor worker is not available', async () => {
  const source = fs.readFileSync(require.resolve('../src/electron.js'), 'utf8')
  const body = source.slice(source.indexOf('let monitorsThread = {'), source.indexOf('let monitorsThreadReal'))
  const errors = []
  const context = { monitorsThreadReal: null, monitorsThreadReady: false, isWindowsUserIdle: true,
    startMonitorThread: () => false, Date, Utils: { wait: async () => assert.fail('Do not wait while idle') },
    debug: { error: message => errors.push(message) }, console, Error }
  const thread = vm.runInNewContext(body + ';monitorsThread', context)
  await assert.rejects(thread.send({ type: 'brightness', id: 'test', brightness: 20 }, { requireDispatch: true }), /unavailable/)
  assert.equal(errors.length, 1)
})

test('automatic known-hardware restoration preserves extended intent and pending recovery', () => {
  const source = fs.readFileSync(require.resolve('../src/electron.js'), 'utf8')
  const body = source.slice(source.indexOf('function setKnownBrightness('), source.indexOf('function applyProfile('))
  const requested = []; let applied
  const known = { normal: { id: 'normal', brightness: 31 }, extended: { id: 'extended', brightness: 7 }, uncertain: { id: 'uncertain', brightness: 9 } }
  const context = { console: { log: () => {} }, debug: { error: assert.fail },
    settings: { extendedBrightness: { extended: -20, uncertain: 200 }, extendedBrightnessRecovery: { uncertain: true } },
    getKnownDisplays: () => known, getExtendedBrightness: () => ({ set: (id, level) => requested.push([id, level]) }),
    applyProfile: profile => { applied = profile } }
  vm.runInNewContext(body + ';setKnownBrightness()', context)
  assert.deepEqual(Object.keys(applied), ['normal'])
  assert.deepEqual(requested, [['extended', -20]])
  assert.equal(Object.keys(known).length, 3, 'Do not mutate the incumbent known-display cache')
})

test('fresh hardware baseline retries only reads, remains bounded, and never accepts cache on failure', async () => {
  const source = fs.readFileSync(require.resolve('../src/electron.js'), 'utf8')
  const body = source.slice(source.indexOf('async function readExtendedHardware('), source.indexOf('function sendConfirmedBrightness('))
  const readings = [-1, undefined, 7]; let calls = 0
  const context = { getVCP: async (_monitor, _code, fresh) => { assert.equal(fresh, true); calls++; return readings.shift() },
    Utils: { wait: async () => {} }, minMax: value => value, normalizeBrightness: value => value }
  const read = vm.runInNewContext(body + ';readExtendedHardware', context)
  assert.equal(await read({ type: 'ddcci', brightnessMax: 100 }), 7)
  assert.equal(calls, 3)
  calls = 0
  await assert.rejects(read({ type: 'ddcci', brightnessMax: 100, brightness: 50 }), /fresh brightness/)
  assert.equal(calls, 3)
})

test('extended range has honest hardware and bounded software endpoints', () => {
  assert.deepEqual(mapBrightness(-100), { level: -100, hardware: 0, dimness: 80, gain: 1 })
  assert.deepEqual(mapBrightness(200), { level: 200, hardware: 100, dimness: 0, gain: 2 })
  assert.equal(mapBrightness(55).hardware, 55)
  for (const value of [-101, 201, NaN, '200', null]) assert.throws(() => mapBrightness(value))
})

test('rapid extended input stays bounded and emits only the latest hardware intent', async () => {
  const writes = []; const hardware = []; let saved; let release; let finish
  const done = new Promise(resolve => { finish = resolve })
  const bridge = new ExtendedBrightness({ scriptsRoot: '.', getMonitor: id => ({ id, hdr: 'unsupported' }),
    hardware: (_id, value) => hardware.push(value), filter: () => ({ ensure: async () => ({ running: true }) }),
    saved: () => saved, save: (_id, value) => { saved = value },
    publish: state => { if (!state.pending) finish(state) }, logger: () => {} })
  bridge.writeEffect = async (_monitor, value) => {
    writes.push(value)
    if (writes.length === 1) await new Promise(resolve => { release = resolve })
  }
  bridge.set('one', 200)
  while (!release) await new Promise(resolve => setTimeout(resolve, 5))
  for (let i = 0; i < 3000; i++) bridge.set('one', -100)
  bridge.set('one', 50); release()
  assert.equal((await done).error, '')
  assert.deepEqual(writes, [200, 50])
  assert.deepEqual(hardware, [50])
  assert.equal(saved, undefined)
})

test('HDR and renderer failure cannot emit an extended hardware request', async () => {
  let finish; const done = new Promise(resolve => { finish = resolve })
  const bridge = new ExtendedBrightness({ scriptsRoot: '.', getMonitor: id => ({ id, hdr: id === 'hdr' ? 'active' : 'unsupported' }),
    hardware: () => assert.fail('No hardware write'), filter: () => ({ ensure: async () => ({ running: false }) }),
    saved: () => undefined, save: () => {}, publish: state => { if (!state.pending) finish(state) }, logger: () => {} })
  bridge.writeEffect = async () => ({ ok: true })
  assert.throws(() => bridge.set('hdr', 200), /HDR/)
  bridge.set('one', 200)
  assert.match((await done).error, /did not start/)
})

test('orderly quit clears software, restores only owned hardware, and keeps restart intent', async () => {
  const hardware = []; const software = []
  const bridge = new ExtendedBrightness({ scriptsRoot: '.', getMonitor: id => ({ id, brightness: 100 }),
    readHardware: async monitor => monitor.id === 'own' ? 100 : 31,
    hardware: (id, value) => hardware.push([id, value]), filter: () => assert.fail('No renderer restart on quit'),
    saved: () => 200, baseline: () => 7, save: () => assert.fail('Keep restart intent'), publish: () => {}, logger: () => {} })
  bridge.writeEffect = async (monitor, value) => software.push([monitor.id, value])
  await bridge.close(['own', 'external'])
  assert.deepEqual(software, [['own', 7], ['external', 7]])
  assert.deepEqual(hardware, [['own', 7]])
  assert.throws(() => bridge.set('own', 200), /quitting/)
})

test('failed durable intent commit cannot start software or hardware effects', async () => {
  let finish; const done = new Promise(resolve => { finish = resolve })
  const bridge = new ExtendedBrightness({ scriptsRoot: '.', getMonitor: id => ({ id }),
    hardware: () => assert.fail('No hardware before commit'), filter: () => assert.fail('No renderer before commit'),
    saved: () => undefined, save: async () => { throw Error('disk full') },
    publish: state => { if (!state.pending) finish(state) }, logger: () => {} })
  bridge.writeEffect = () => assert.fail('No software before commit')
  bridge.set('one', 200)
  assert.match((await done).error, /disk full/)
})

test('unconfirmed hardware keeps recovery intent instead of declaring success', async () => {
  let finish; const done = new Promise(resolve => { finish = resolve })
  let writes = 0
  const bridge = new ExtendedBrightness({ scriptsRoot: '.', getMonitor: id => ({ id }),
    hardware: async () => { writes++; throw Error('fresh readback mismatch') },
    filter: () => ({ ensure: async () => ({ running: true }) }), saved: () => undefined,
    save: async () => {}, complete: () => assert.fail('Keep recovery intent until hardware confirms'),
    publish: state => { if (!state.pending) finish(state) }, logger: () => {} })
  bridge.writeEffect = async () => ({ ok: true })
  bridge.set('one', 200)
  assert.match((await done).error, /readback mismatch/)
  assert.equal(writes, 1)
})

test('failed older adjustment preserves a newer pending slider request', async () => {
  const completed = []; const hardware = []; let failFirst
  const firstEntered = new Promise(resolve => { failFirst = resolve })
  let rejectFirst
  const bridge = new ExtendedBrightness({ scriptsRoot: '.', getMonitor: id => ({ id }),
    hardware: async (_id, value) => { hardware.push(value); return true },
    filter: () => ({ ensure: async () => ({ running: true }) }),
    saved: () => undefined, save: async () => {}, complete: async () => {},
    publish: status => { if (!status.pending) completed.push(status) }, logger: () => {} })
  bridge.writeEffect = async (_monitor, level) => {
    if (level === 200) {
      failFirst()
      await new Promise((_resolve, reject) => { rejectFirst = reject })
    }
  }
  bridge.set('one', 200)
  await firstEntered
  bridge.set('one', 50)
  rejectFirst(Error('old effect failed'))
  const deadline = Date.now() + 1500
  while (completed.length < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(hardware, [50])
  assert.equal(completed.length, 1, 'Obsolete failure must not replace pending new status')
  assert.equal(completed.at(-1)?.level, 50)
  assert.equal(completed.at(-1)?.error, '')
})

test('continuous negative slider edits reuse the confirmed hardware endpoint, and reset writes normally', async () => {
  const writes = []; let saved; let done
  const bridge = new ExtendedBrightness({ scriptsRoot: '.', getMonitor: id => ({ id }),
    hardware: async (_id, value) => { writes.push(value); return true },
    filter: () => ({ ensure: async () => ({ running: true }) }), saved: () => saved,
    save: async (_id, value) => { saved = value }, complete: async (_id, value) => { if (value >= 0) saved = undefined },
    publish: state => { if (!state.pending) done(state) }, logger: () => {} })
  bridge.writeEffect = async () => ({ ok: true })
  const set = level => new Promise(resolve => { done = resolve; bridge.set('one', level) })
  for (const value of [-10, -20, -30, -40]) assert.equal((await set(value)).error, '')
  assert.deepEqual(writes, [0])
  await set(7)
  assert.deepEqual(writes, [0, 7])
  assert.equal(saved, undefined)
})

test('all negative brightness levels darken monotonically: -80 is never brighter than -70', () => {
  assert.equal(mapBrightness(-70).hardware, 0)
  assert.equal(mapBrightness(-80).hardware, 0)
  assert.ok(effectiveLightTransmission(-80) < effectiveLightTransmission(-70))
  let previous = effectiveLightTransmission(0)
  for (let level = -1; level >= -100; level--) {
    const actual = effectiveLightTransmission(level)
    assert.ok(actual < previous, `level ${level}: transmission ${actual} did not darken from ${previous}`)
    previous = actual
  }
  assert.ok(effectiveLightTransmission(-100) >= 0.2)
})

test('quick negative dragging never re-sends a recently confirmed hardware zero', async () => {
  const writes = []
  const reads = []
  let observed = 0
  let saved
  let done
  const bridge = new ExtendedBrightness({
    scriptsRoot: '.', getMonitor: id => ({ id, type: 'ddcci' }),
    hardware: async (_, value) => { writes.push(value); return true },
    readHardware: async () => { reads.push(observed); return observed },
    filter: () => ({ ensure: async () => ({ running: true, brightnessDisplays: 1 }) }),
    saved: () => saved,
    save: async (_, value) => { saved = value },
    complete: async () => {},
    publish: status => { if (!status.pending) done?.(status) },
    logger: () => {},
  })
  bridge.writeEffect = async () => ({ ok: true })
  const edit = value => new Promise(resolve => { done = resolve; bridge.set('LG', value) })
  assert.equal((await edit(-70)).error, '')
  bridge.confirmedHardware.get('LG').at -= 1900
  assert.equal((await edit(-80)).error, '')
  assert.deepEqual(writes, [0], 'Software dimming must not repeatedly reset DDC to zero')
  bridge.confirmedHardware.get('LG').at -= 11000
  assert.equal((await edit(-90)).error, '')
  assert.deepEqual(writes, [0], 'Expired hardware confirmation should read instead of resend a harmless-looking but flickery 0% write')
  assert.deepEqual(reads, [0])
  bridge.confirmedHardware.get('LG').at -= 11000
  observed = 17
  assert.equal((await edit(-95)).error, '')
  assert.deepEqual(writes, [0, 0], 'If physical backlight really drifted, restore minimum exactly once')
})

test('failed or ambiguous negative-range readback does not blindly resend a brightness command', async () => {
  const writes = []; let done
  let observed = 0
  const bridge = new ExtendedBrightness({
    scriptsRoot: '.', getMonitor: id => ({ id, type: 'ddcci' }),
    hardware: async (_, value) => { writes.push(value); return true },
    readHardware: async () => observed,
    filter: () => ({ ensure: async () => ({ running: true, brightnessDisplays: 1 }) }),
    saved: () => -70, save: async () => {}, complete: async () => {},
    publish: status => { if (!status.pending) done?.(status) }, logger: () => {},
  })
  bridge.writeEffect = async () => ({ ok: true })
  const edit = level => new Promise(resolve => { done = resolve; bridge.set('LG', level) })
  assert.equal((await edit(-70)).error, '')
  bridge.confirmedHardware.get('LG').at -= 15000
  observed = NaN
  const failure = await edit(-80)
  assert.match(failure.error, /physical brightness could not be confirmed/i)
  assert.deepEqual(writes, [0])
})

test('missing native filter effect count fails closed for negative levels', async () => {
  const reports = []
  const bridge = new ExtendedBrightness({
    scriptsRoot: '.', getMonitor: id => ({ id, type: 'ddcci' }),
    hardware: async () => { throw Error('A missing overlay must not trigger DDC') },
    filter: () => ({ ensure: async () => ({ running: true, brightnessDisplays: 0 }) }),
    saved: () => undefined, save: async () => {}, complete: async () => {},
    publish: status => { if (!status.pending) reports.push(status) },
    logger: () => {},
  })
  bridge.writeEffect = async () => ({ ok: true })
  bridge.set('LG', -80)
  const deadline = Date.now() + 1500
  while (!reports.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 4))
  assert.match(reports[0]?.error || '', /confirm any active brightness effect/)
})

test('monitor topology change invalidates confirmed DDC endpoint even for the same stable ID', async () => {
  const hardware = []; let done
  const bridge = new ExtendedBrightness({ scriptsRoot: '.', getMonitor: id => ({ id, type: 'ddcci',
    bounds: { position: { x: 0, y: 0 }, width: 1920, height: 1080 } }),
    hardware: async (id, value) => { hardware.push([id, value]); return true },
    filter: () => ({ ensure: async () => ({ running: true }) }),
    saved: () => undefined, save: async () => {}, complete: async () => {},
    publish: status => { if (!status.pending) done?.(status) }, logger: () => {} })
  bridge.writeEffect = async () => ({ ok: true })
  const set = value => new Promise(resolve => { done = resolve; bridge.set('one', value) })
  assert.equal((await set(-10)).error, '')
  bridge.writeRequest = async () => ({ removed: 0 })
  bridge.reconcile([{ id: 'one', hdr: 'unsupported', bounds: { position: { x: 50, y: 0 }, width: 1920, height: 1080 } }])
  assert.equal((await set(-20)).error, '')
  assert.deepEqual(hardware, [['one', 0], ['one', 0]], 'A re-enumerated endpoint needs fresh readback')
})

test('topology change during a slow software effect cancels the stale hardware write', async () => {
  const hardware = []; const reports = []; let effectStarted; let releaseEffect
  const entered = new Promise(resolve => { effectStarted = resolve })
  const bridge = new ExtendedBrightness({ scriptsRoot: '.', getMonitor: id => ({ id, type: 'ddcci',
    bounds: { position: { x: 0, y: 0 }, width: 1920, height: 1080 } }),
    hardware: async (id, value) => { hardware.push([id, value]); return true },
    filter: () => ({ ensure: async () => ({ running: true }) }),
    saved: () => undefined, save: async () => {}, complete: async () => {},
    publish: status => { if (!status.pending) reports.push(status) }, logger: () => {} })
  bridge.writeEffect = async () => { effectStarted(); await new Promise(resolve => { releaseEffect = resolve }) }
  bridge.writeRequest = async () => ({ removed: 1 })
  bridge.set('one', 200)
  await entered
  bridge.reconcile([{ id: 'one', hdr: 'unsupported', bounds: { position: { x: 1920, y: 0 }, width: 1920, height: 1080 } }])
  releaseEffect()
  const deadline = Date.now() + 1500
  while ((bridge.busy || bridge.timer || reports.length === 0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(hardware, [], 'Never write to a possibly remapped DDC endpoint')
  assert.equal(reports.length, 1)
  assert.match(reports[0].error, /topology|display.*changed/i)
  assert.equal(reports[0].pending, false)
})

test('topology change during an already dispatched hardware write never reports stale success', async () => {
  const reports = []; let hardwareStarted; let releaseHardware
  const entered = new Promise(resolve => { hardwareStarted = resolve })
  const bridge = new ExtendedBrightness({ scriptsRoot: '.', getMonitor: id => ({ id, type: 'ddcci' }),
    hardware: async () => { hardwareStarted(); await new Promise(resolve => { releaseHardware = resolve }); return true },
    filter: () => ({ ensure: async () => ({ running: true }) }),
    saved: () => undefined, save: async () => {}, complete: async () => {},
    publish: status => { if (!status.pending) reports.push(status) }, logger: () => {} })
  bridge.writeEffect = async () => ({ ok: true })
  bridge.writeRequest = async () => ({ removed: 0 })
  bridge.set('one', 200)
  await entered
  bridge.reconcile([{ id: 'one', hdr: 'unsupported', bounds: { position: { x: 0, y: 0 }, width: 1920, height: 1080 } }])
  releaseHardware()
  const deadline = Date.now() + 1500
  while ((bridge.busy || bridge.timer || reports.length === 0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(reports.length, 1)
  assert.match(reports[0].error, /topology|display.*changed/i)
  assert.equal(bridge.confirmedHardware.size, 0, 'Do not cache a success from a replaced display topology')
})

test('topology change while durable recovery intent is saved refuses a stale software effect', async () => {
  let saveStarted; let releaseSave; let effects = 0; const reports = []
  const entered = new Promise(resolve => { saveStarted = resolve })
  const bridge = new ExtendedBrightness({ scriptsRoot: '.', getMonitor: id => ({ id, type: 'ddcci',
    bounds: { position: { x: 0, y: 0 }, width: 1920, height: 1080 } }),
    hardware: async () => assert.fail('No hardware write after topology changed'),
    filter: () => ({ ensure: () => assert.fail('Do not start an obsolete filter effect') }),
    saved: () => undefined, save: async () => { saveStarted(); await new Promise(resolve => { releaseSave = resolve }) },
    complete: async () => {}, publish: status => { if (!status.pending) reports.push(status) }, logger: () => {} })
  bridge.writeEffect = async () => { effects++ }
  bridge.writeRequest = async () => ({ removed: 0 })
  bridge.set('one', -50)
  await entered
  bridge.reconcile([{ id: 'one', hdr: 'unsupported', bounds: { position: { x: 1920, y: 0 }, width: 1920, height: 1080 } }])
  releaseSave()
  const deadline = Date.now() + 1500
  while ((bridge.busy || bridge.timer || !reports.length) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(effects, 0)
  assert.equal(reports.length, 1)
  assert.match(reports[0].error, /topology|display.*changed/i)
})
