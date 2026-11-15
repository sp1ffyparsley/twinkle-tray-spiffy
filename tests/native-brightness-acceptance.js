// Real packaged-app acceptance. Default is read-only; --apply changes both
// endpoints briefly and restores every monitor/filter baseline in finally.
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const profile = path.join(process.env.APPDATA, 'twinkle-tray-spiffy')
const effectFile = path.join(process.env.LOCALAPPDATA, 'SpiffyBrightness/config.json')
const filterFile = path.join(root, '_state/night_filter/config.json')
const reportFile = process.argv.find(arg => arg.startsWith('--report='))?.slice(9) || path.join(process.env.LOCALAPPDATA, 'SpiffyBrightness/twinkle-recovery-20261023/native-qualification.json')
const installedApp = path.join(process.env.LOCALAPPDATA, 'Programs/Twinkle Tray Spiffy/Twinkle Tray Spiffy.exe')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { started: new Date().toISOString(), status: 'read-only', checks: [], nativeUI: 'unverified' }
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))

function command(request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect('\\\\.\\pipe\\twinkle-tray\\cmds')
    let data = ''
    const timer = setTimeout(() => finish(Error('Native command timed out; outcome unconfirmed. No mutation retry.')), 6000)
    function finish(error, value) {
      clearTimeout(timer); socket.destroy()
      if (error) reject(error); else resolve(value)
    }
    socket.once('error', finish)
    socket.once('connect', () => socket.write(JSON.stringify(request)))
    socket.on('data', chunk => {
      data += chunk
      if (data.length > 65536) return finish(Error('Native response exceeded limit'))
      try { finish(null, JSON.parse(data)) } catch (_) {
        if (data === 'undefined' || data === 'OK') finish(null, data)
      }
    })
  })
}
async function waitFor(probe, description) {
  const deadline = Date.now() + 22000
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await delay(150)
  }
  throw Error('Timed out verifying ' + description + '; mutation was not retried')
}
const rawBrightness = monitor => command({ type: 'get', monitor: monitor.key, property: 'vcp', code: monitor.brightnessType || 16, fresh: true })
const setBrightness = (monitor, value) => command({ type: 'set', monitor: monitor.key, vcp: 'brightness', mode: 'set', value })
const effect = monitor => (read(effectFile).active_filters || []).find(row => row.owner === 'twinkle-tray' && row.monitor_id === monitor.id)
const isAlive = pid => { try { process.kill(pid, 0); return true } catch (_) { return false } }
async function startInstalled() {
  assert(fs.existsSync(installedApp), 'The per-user Twinkle Tray installation is missing')
  const child = spawn(installedApp, [], { detached: true, windowsHide: true, stdio: 'ignore' })
  child.unref()
  await waitFor(async () => {
    try { return Object.keys(await command({ type: 'list' })).length > 0 }
    catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return false; throw error }
  }, 'installed app reopening')
  return child.pid
}
async function completedEffect(monitor, level, owner) {
  return waitFor(() => {
    const record = effect(monitor)
    const saved = read(path.join(profile, 'settings.json'))
    return record && isAlive(record.owner_pid) && (!owner || record.owner_pid === owner) && record.logical_brightness === Math.min(0, level) &&
      record.signal_gain === Math.max(1, level / 100) && !saved.extendedBrightnessRecovery?.[monitor.id]
  }, 'software effect and durable completed intent')
}

async function timerAcceptance() {
  assert(process.argv.includes('--apply'), 'Timer acceptance requires explicit --apply')
  assert(fs.existsSync(reportFile), 'Preserve an existing installed qualification receipt first')
  const prior = read(reportFile)
  assert.equal(prior.status, 'passed-restored', 'Resolve any earlier pending recovery before timer acceptance')
  const baseline = read(filterFile)
  assert.equal(baseline.enabled, false, 'Leave an active user filter alone')
  assert.equal((read(effectFile).active_filters || []).length, 0, 'Leave independent software effects alone')
  Object.assign(report, prior)
  report.timer = { status: 'pending', started: new Date().toISOString(), baseline }
  report.status = 'pending'; save()
  let failure
  try {
    await command({ type: 'filter-set', patch: { enabled: true, strength: 5, dimness: 2, tint: 0, dim_duration_minutes: 1 } })
    await waitFor(async () => { const s = await command({ type: 'filter-status' }); return !s.pending && s.enabled && s.running && s.dimness === 2 && s.dim_duration_minutes === 1 }, 'native one-minute dim timer arming')
    const armed = Date.now()
    console.log('Native one-minute dim timer armed; waiting for actual elapsed expiry.')
    await delay(61000)
    await command({ type: 'filter-status', refresh: true })
    const expired = await waitFor(async () => { const s = await command({ type: 'filter-status' }); return !s.pending && s.enabled && s.strength === 5 && s.dimness === 0 ? s : false }, 'actual dim expiry while warmth remains enabled')
    report.timer.elapsedMs = Date.now() - armed
    report.timer.expired = { enabled: expired.enabled, strength: expired.strength, dimness: expired.dimness }
  } catch (error) { failure = error }
  finally {
    try {
      await command({ type: 'filter-set', patch: { enabled: baseline.enabled, strength: baseline.strength, dimness: baseline.dimness, tint: baseline.tint, dim_duration_minutes: baseline.dim_duration_minutes } })
      await waitFor(async () => { const s = await command({ type: 'filter-status' }); return !s.pending && !s.enabled && !s.running && s.strength === baseline.strength && s.dimness === baseline.dimness }, 'timer-test baseline restoration')
      report.timer.status = failure ? 'failed-restored' : 'passed-restored'
      report.status = 'passed-restored' // Earlier endpoint/lifecycle evidence is unchanged.
    } catch (restoreError) {
      report.timer.recoveryError = restoreError.message
      failure = restoreError
    }
    report.timer.finished = new Date().toISOString()
    report.timer.error = failure?.message || ''
    save()
  }
  if (failure) throw failure
  console.log(JSON.stringify({ timer: report.timer.status, elapsedMs: report.timer.elapsedMs, priorChecks: report.checks.length, reportFile }))
}

async function main() {
  if (process.argv.includes('--timer-only')) return timerAcceptance()
  const discovered = await waitFor(async () => {
    try {
      const found = Object.values(await command({ type: 'list' }))
      return found.length ? found : false
    } catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return false
      throw error
    }
  }, 'native monitor discovery')
  const selection = process.argv.find(arg => arg.startsWith('--monitor='))?.slice(10)
  const monitors = selection ? discovered.filter(m => m.id === selection || m.key === selection) : discovered
  if (selection) assert.equal(monitors.length, 1, 'Select exactly one current full monitor ID or key')
  report.excluded = discovered.filter(m => !monitors.includes(m)).map(m => ({ id: m.id, type: m.type, acceptance: 'not exercised' }))
  assert(monitors.length > 0, 'Native monitor discovery is empty')
  for (const monitor of monitors) {
    assert.equal(monitor.type, 'ddcci', 'This acceptance requires readable DDC brightness')
    assert.notEqual(monitor.hdr, 'active', 'Do not exercise extended effects in HDR')
    monitor.baselineRaw = await rawBrightness(monitor)
    assert(Number.isInteger(monitor.baselineRaw) && monitor.baselineRaw >= 0, 'Native brightness readback failed: ' + String(monitor.baselineRaw))
    assert(Number.isFinite(monitor.min) && Number.isFinite(monitor.max), 'Native display range unavailable')
    assert.equal(monitor.min, 0, 'Qualification requires an unremapped monitor')
    assert.equal(monitor.max, 100, 'Qualification requires an unremapped monitor')
    assert.equal(monitor.calibration?.length || 0, 0, 'Qualification requires no custom brightness curve')
    assert.equal(monitor.brightnessMax, 100, 'Qualification requires a 100-step native range')
    monitor.brightness = monitor.baselineRaw
  }
  report.baselines = monitors.map(m => ({ id: m.id, level: Math.round(m.brightness), raw: m.baselineRaw, min: m.min, max: m.max }))
  console.log(JSON.stringify({ nativeDisplays: report.baselines }))
  if (!process.argv.includes('--apply')) return
  const lifecycle = process.argv.includes('--lifecycle')
  if (lifecycle) {
    assert.equal(monitors.length, 1, 'Lifecycle acceptance requires one explicitly selected monitor')
    assert(fs.existsSync(installedApp), 'Lifecycle acceptance requires the installed app')
  }
  if (fs.existsSync(reportFile) && read(reportFile).status === 'pending') throw Error('Earlier acceptance is unfinished; inspect its saved baselines before another run')
  const initialEffects = read(effectFile).active_filters || []
  assert.equal(initialEffects.length, 0, 'An existing software effect owns displays; do not overwrite it')
  const initialSettings = read(path.join(profile, 'settings.json'))
  assert.equal(Object.keys(initialSettings.extendedBrightness || {}).length, 0, 'Existing extended intent needs its own recovery first')
  const initialFilter = read(filterFile)
  assert.equal(initialFilter.enabled, false, 'Leave an already active global filter alone')
  report.filterBaseline = initialFilter
  report.status = 'pending'; save()
  let failure
  try {
    for (const monitor of monitors) {
      for (const level of [-100, 200]) {
        const accepted = await setBrightness(monitor, level)
        assert.equal(accepted.accepted, true)
        await completedEffect(monitor, level)
        const expected = Math.round(level < 0 ? monitor.min : monitor.max)
        const observed = await waitFor(async () => (await rawBrightness(monitor)) === expected, 'native DDC endpoint')
        assert(observed)
        report.checks.push({ display: monitor.id, level, raw: expected, software: effect(monitor), at: new Date().toISOString() })
        save()
        await setBrightness(monitor, Math.round(monitor.brightness))
        await waitFor(async () => !effect(monitor) && (await rawBrightness(monitor)) === monitor.baselineRaw, 'baseline restoration')
      }
    }
    await command({ type: 'filter-set', patch: { enabled: true, strength: 5, dimness: 2, tint: 0, dim_duration_minutes: 0 } })
    await waitFor(async () => { const s = await command({ type: 'filter-status' }); return !s.pending && s.enabled && s.running && s.strength === 5 && s.dimness === 2 }, 'native filter owner')
    report.checks.push({ filter: 'on', strength: 5, dimness: 2, at: new Date().toISOString() }); save()
    if (lifecycle) {
      await command({ type: 'filter-set', patch: { enabled: false } })
      await waitFor(async () => { const s = await command({ type: 'filter-status' }); return !s.pending && !s.enabled && !s.running }, 'filter off before lifecycle test')
      const monitor = monitors[0]
      await setBrightness(monitor, -20)
      await completedEffect(monitor, -20)
      const owner = effect(monitor).owner_pid
      await command({ type: 'quit' })
      await waitFor(() => !isAlive(owner) && !effect(monitor), 'orderly quit and software removal')
      assert.equal(read(path.join(profile, 'settings.json')).extendedBrightnessBaseline[monitor.id], monitor.brightness)
      const reopened = await startInstalled()
      await completedEffect(monitor, -20, reopened)
      assert.equal(await rawBrightness(monitor), 0)
      report.checks.push({ lifecycle: 'orderly quit and installed reopen', preservedBaseline: monitor.brightness, at: new Date().toISOString() }); save()
      const crashOwner = effect(monitor).owner_pid
      const rendererPid = Number(fs.readFileSync(path.join(root, '_state/night_filter/worker.pid'), 'utf8').trim())
      process.kill(crashOwner)
      await waitFor(() => !isAlive(crashOwner), 'owned process crash')
      // Dead records are intentionally retained for diagnosis but cannot own a
      // renderer: process creation custody must no longer pass.
      await waitFor(() => !isAlive(rendererPid), 'canonical renderer stopping after owner crash')
      const restarted = await startInstalled()
      await completedEffect(monitor, -20, restarted)
      assert.equal(await rawBrightness(monitor), 0)
      report.checks.push({ lifecycle: 'owned process crash and installed restart', deadRendererStopped: rendererPid, newOwner: effect(monitor).owner_pid, at: new Date().toISOString() }); save()
    }
  } catch (error) { failure = error }
  finally {
    const recoveryErrors = []
    if (lifecycle) {
      try { await command({ type: 'list' }) }
      catch (error) {
        if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) {
          try { await startInstalled() } catch (restartError) { recoveryErrors.push(restartError.message) }
        } else recoveryErrors.push(error.message)
      }
    }
    for (const monitor of monitors) {
      try {
        await setBrightness(monitor, Math.round(monitor.brightness))
        await waitFor(async () => !effect(monitor) && (await rawBrightness(monitor)) === monitor.baselineRaw, 'final hardware/software baseline')
      } catch (error) { recoveryErrors.push(error.message) }
    }
    try {
      await command({ type: 'filter-set', patch: { enabled: initialFilter.enabled, strength: initialFilter.strength, dimness: initialFilter.dimness, tint: initialFilter.tint, dim_duration_minutes: initialFilter.dim_duration_minutes } })
      await waitFor(async () => { const s = await command({ type: 'filter-status' }); return !s.pending && !s.enabled && !s.running && s.strength === initialFilter.strength && s.dimness === initialFilter.dimness }, 'original filter state')
    } catch (error) { recoveryErrors.push(error.message) }
    report.finished = new Date().toISOString()
    report.error = failure?.message || ''
    report.recoveryErrors = recoveryErrors
    report.status = recoveryErrors.length ? 'pending' : failure ? 'failed-restored' : 'passed-restored'
    save()
    if (recoveryErrors.length) throw Error('Baseline recovery needs attention: ' + recoveryErrors.join('; '))
  }
  if (failure) throw failure
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, reportFile, nativeUI: report.nativeUI }))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
