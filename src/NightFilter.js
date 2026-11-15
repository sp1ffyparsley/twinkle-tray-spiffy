// Twinkle Tray integration with the existing Spiffy filter owner. No palette,
// registry mutation, second overlay, or per-slider resident process is involved.
const { EventEmitter } = require('node:events')
const { execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const net = require('node:net')

function residentCommand(mode, patch, scriptsRoot) {
  let pid
  try { pid = fs.readFileSync(path.join(scriptsRoot, '_state', 'night_filter', 'worker.pid'), 'utf8').trim() }
  catch (error) { if (error.code === 'ENOENT') return Promise.resolve(null); throw error }
  if (!/^[1-9][0-9]{0,9}$/.test(pid)) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const socket = net.connect('\\\\.\\pipe\\SpiffyNightFilterControl-' + pid)
    let connected = false, output = '', finished = false
    const finish = (error, value) => {
      if (finished) return
      finished = true; clearTimeout(timer); socket.destroy()
      if (error) reject(error); else resolve(value)
    }
    const timer = setTimeout(() => finish(Error('Resident filter response timed out; outcome is unconfirmed. Refresh before retrying.')), 3500)
    socket.on('connect', () => {
      connected = true
      // Only bounded numeric fields cross this local owner channel.
      const values = Object.fromEntries(Object.entries(patch).filter(([key]) => key in fields))
      socket.write(JSON.stringify({ mode, patch: values }) + '\n')
    })
    socket.on('data', chunk => {
      output += chunk
      if (output.length > 8192) return finish(Error('Resident filter response exceeded its bound.'))
      if (output.includes('\n')) {
        try { finish(null, parseResult(output.trim())) } catch (error) { finish(error) }
      }
    })
    socket.on('error', error => {
      if (!connected && ['ENOENT', 'ECONNREFUSED', 'EBUSY'].includes(error.code)) finish(null, null)
      else finish(Error('Resident filter connection failed; outcome is unconfirmed. Refresh before retrying.'))
    })
    socket.on('end', () => { if (!finished) finish(Error('Resident filter closed before confirming the change. Refresh before retrying.')) })
  })
}

const fields = { strength: [0, 100, 'Strength'], dimness: [0, 80, 'Dimness'],
  tint: [-100, 100, 'Tint'], dim_duration_minutes: [0, 1440, 'DimMinutes'] }

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('Invalid Night Filter request.')
  const result = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'enabled') {
      if (typeof value !== 'boolean') throw Error('Night Filter enabled must be a boolean.')
    } else {
      const rule = fields[key]
      if (!rule || !Number.isInteger(value) || value < rule[0] || value > rule[1]) {
        throw Error(`Invalid Night Filter ${key}.`)
      }
    }
    result[key] = value
  }
  if (!Object.keys(result).length) throw Error('Empty Night Filter request.')
  return result
}

function parseResult(stdout) {
  const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim())
  if (result.kind !== 'custom_filter' || ![0, 1].includes(result.enabled) ||
      ![0, 1].includes(result.worker_running) || typeof result.error !== 'boolean') {
    throw Error('The filter owner returned an invalid status. Refresh before changing it.')
  }
  for (const [key, [min, max]] of Object.entries(fields)) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) {
      throw Error(`The filter owner returned invalid ${key}.`)
    }
  }
  if (result.error) throw Error(String(result.message || 'The filter owner refused the request.'))
  return { enabled: !!result.enabled, running: !!result.worker_running,
    strength: result.strength, dimness: result.dimness, tint: result.tint,
    dim_duration_minutes: result.dim_duration_minutes,
    dim_expires_at: String(result.dim_expires_at || ''),
    independentDisplays: Math.max(0, Number(result.night_display_effect_count) || 0),
    brightnessDisplays: Math.max(0, Number(result.display_effect_count) || 0) }
}

class NightFilter extends EventEmitter {
  constructor({ scriptsRoot, run = execFile, resident = run === execFile ? residentCommand : null, logger = () => {}, debounceMs = 40, timeoutMs = 15000 }) {
    super()
    this.script = path.join(scriptsRoot, 'utilities', 'powershell', 'Set-NightLight.ps1')
    this.executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    this.run = run
    this.resident = resident === residentCommand ? (mode, patch) => residentCommand(mode, patch, scriptsRoot) : resident
    this.logger = logger
    this.debounceMs = debounceMs
    this.timeoutMs = timeoutMs
    this.pending = null
    this.togglePending = false
    this.readPending = false
    this.ensurePending = false
    this.busy = false
    this.timer = null
    this.revision = 0
    this.state = { available: false, enabled: false, running: false, error: '', pending: false }
    logger(`night_filter startup script=${this.script}`)
  }

  snapshot() { return { ...this.state, pending: this.busy || !!this.pending || this.togglePending || this.readPending || this.ensurePending, revision: this.revision } }
  publish() { this.emit('status', this.snapshot()) }

  refresh() {
    this.readPending = true
    this.schedule(0)
    return this.snapshot()
  }

  ensure() {
    this.ensurePending = true
    const result = new Promise((resolve, reject) => {
      const listener = status => {
        if (status.pending) return
        this.off('status', listener)
        if (status.error) reject(Error(status.error))
        else resolve(status)
      }
      this.on('status', listener)
    })
    this.schedule(0)
    return result
  }

  set(patch) {
    this.pending = { ...this.pending, ...validatePatch(patch) }
    if (patch.enabled !== undefined) this.togglePending = false
    this.revision++
    this.state.error = ''
    this.schedule(this.pending.enabled === false ? 0 : this.debounceMs)
    this.publish()
    return this.snapshot() // Admission only; final state arrives via status.
  }

  toggle() {
    if (this.pending?.enabled !== undefined) this.pending.enabled = !this.pending.enabled
    else this.togglePending = !this.togglePending
    this.revision++
    this.schedule(0)
    this.publish()
    return this.snapshot()
  }

  schedule(delay) {
    if (this.busy) return
    if (this.timer && delay > 0) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.drain(), delay)
  }

  async execute(mode, patch = {}) {
    if (!fs.existsSync(this.script)) throw Error(`Night Filter helper is missing: ${this.script}. Restore SS Scripts or correct nightFilterScriptsRoot in settings.`)
    const started = Date.now()
    if (this.resident) {
      let live
      try { live = await this.resident(mode, patch) }
      catch (error) {
        // Removing the last per-display effect can stop the renderer between
        // its state-file poll and this connection. Status/Ensure are idempotent
        // owner reconciliation, so they may fall back to the existing helper.
        // An uncertain On/Off is never replayed.
        if (!['FilterStatus', 'FilterEnsure'].includes(mode)) throw error
        this.logger(`night_filter action=${mode} resident_reconcile reason=${error.message}`)
      }
      if (live) {
        this.logger(`night_filter action=${mode} transport=resident completed elapsed_ms=${Date.now() - started} enabled=${live.enabled} running=${live.running}`)
        return live
      }
    }
    const args = ['-NoProfile', '-NonInteractive', '-File', this.script, '-Mode', mode, '-AsJson']
    for (const [key, rule] of Object.entries(fields)) {
      if (patch[key] !== undefined) args.push(`-${rule[2]}`, String(patch[key]))
    }
    this.logger(`night_filter action=${mode} started`)
    return new Promise((resolve, reject) => {
      this.run(this.executable, args, { windowsHide: true, timeout: this.timeoutMs,
        maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => {
        if (error) {
          this.logger(`night_filter action=${mode} failed code=${error.code} elapsed_ms=${Date.now() - started}`)
          reject(Error(`Night Filter ${mode} did not finish (${error.killed ? 'timeout' : error.code || 'process error'}). Its outcome is unconfirmed. Use Refresh to reconcile; the change was not retried.`))
          return
        }
        try {
          const status = parseResult(stdout)
          this.logger(`night_filter action=${mode} completed elapsed_ms=${Date.now() - started} enabled=${status.enabled} running=${status.running}`)
          resolve(status)
        } catch (e) { reject(e) }
      })
    })
  }

  async drain() {
    if (this.busy) return
    this.timer = null
    this.busy = true
    const patch = this.pending
    const toggle = this.togglePending
    this.togglePending = false
    const ensure = this.ensurePending
    this.ensurePending = false
    this.pending = null
    this.readPending = false
    this.publish()
    try {
      // A first edit still needs authoritative state. An unknown state must never
      // turn a previously disabled filter on merely because a slider moved.
      if (toggle || (!this.state.available && patch)) this.state = { ...this.state, ...await this.execute('FilterStatus'), available: true }
      if (patch || toggle) {
        const requested = patch?.enabled ?? this.state.enabled
        const enabled = toggle ? !requested : requested
        // An On hotkey must not reactivate hidden global dimming left by an old
        // control. Explicit dim/timer API calls remain available to other tools.
        const safePatch = enabled ? { dimness: 0, tint: 0, dim_duration_minutes: 0, ...patch } : patch || {}
        this.state = { ...this.state, ...await this.execute(enabled ? 'FilterOn' : 'FilterOff', safePatch) }
      } else {
        this.state = { ...this.state, ...await this.execute(ensure ? 'FilterEnsure' : 'FilterStatus'), available: true }
      }
      if (ensure && patch) this.state = { ...this.state, ...await this.execute('FilterEnsure') }
      this.state.error = ''
    } catch (e) {
      this.state = { ...this.state, available: false, error: e.message }
      // Never replay pending mutations after an uncertain child result.
      this.pending = null
      this.togglePending = false
      this.readPending = false
      this.ensurePending = false
      this.logger(`night_filter error=${e.message}`)
    } finally {
      this.busy = false
      this.publish()
      if (this.pending || this.togglePending || this.readPending || this.ensurePending) this.schedule(0)
    }
  }
}

module.exports = { NightFilter, validatePatch, parseResult, residentCommand }
