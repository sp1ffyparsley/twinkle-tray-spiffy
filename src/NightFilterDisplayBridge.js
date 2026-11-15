// Thin, temporary client to the EXISTING Command Palette Night Filter owner.
// The canonical Python adapter validates the physical display mapping, writes
// the approved display_overrides contract, and controls the incumbent renderer.
// This file does not create a second night-filter config, daemon, or writer.
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const SCHEMA = 'spiffy_command_palette_shell_adapter_v1'

class NightFilterDisplayBridge extends EventEmitter {
  constructor({ scriptsRoot, pythonPath, spawnProcess = spawn, fileExists = fs.existsSync, idleMs = 12000, timeoutMs = 10000 }) {
    super()
    if (!scriptsRoot || !path.isAbsolute(scriptsRoot)) throw Error('A known SS Scripts root is required')
    this.scriptsRoot = scriptsRoot
    this.pythonPath = pythonPath || path.join(scriptsRoot, 'Spiffy Workspace', '.venv', 'Scripts', 'python.exe')
    this.spawnProcess = spawnProcess
    this.fileExists = fileExists
    this.idleMs = idleMs
    this.timeoutMs = timeoutMs
    this.child = null
    this.stdout = ''
    this.pending = new Map()
    this.sequence = 0
    this.idleTimer = null
    this.lastStatus = null
    this.closed = false
  }

  start() {
    if (this.closed) throw Error('Night Filter connection is closed')
    if (this.child) return this.child
    if (!this.fileExists(this.pythonPath)) throw Error('Existing Spiffy Python runtime is unavailable')
    const modulesPath = path.join(this.scriptsRoot, 'command_palette', 'workers', 'python', 'src')
    if (!this.fileExists(path.join(modulesPath, 'sscp', 'command_palette_shell_adapter.py'))) {
      throw Error('Existing Command Palette Night Filter adapter is missing')
    }
    const child = this.spawnProcess(this.pythonPath, [
      '-B', '-m', 'sscp.command_palette_shell_adapter',
      '--workspace-root', this.scriptsRoot, '--stdio',
    ], {
      cwd: this.scriptsRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONPATH: modulesPath },
    })
    this.child = child
    this.stdout = ''
    child.stdout.on('data', chunk => this.consume(String(chunk)))
    child.stderr.on('data', () => { /* Do not print paths, model/session state, or credentials. */ })
    child.on('error', err => this.failAll(Error('Night Filter adapter could not start: ' + err.message)))
    child.on('exit', () => {
      // A previous idle child can exit AFTER a new child has been spawned.
      // Never let the retired child's exit terminate a newer valid session.
      if (this.child !== child) return
      this.failAll(Error('Night Filter adapter closed before confirming its last action. Refresh before retrying.'))
    })
    return child
  }

  consume(chunk) {
    this.stdout += chunk
    if (this.stdout.length > 512 * 1024) return this.failAll(Error('Night Filter response exceeded its size limit'))
    while (true) {
      const newline = this.stdout.indexOf('\n')
      if (newline < 0) break
      const line = this.stdout.slice(0, newline)
      this.stdout = this.stdout.slice(newline + 1)
      if (!line.trim()) continue
      let response
      try { response = JSON.parse(line) }
      catch (_) { return this.failAll(Error('Night Filter returned invalid JSON')) }
      const item = this.pending.get(response.request_id)
      if (!item) continue
      clearTimeout(item.timer)
      this.pending.delete(response.request_id)
      if (!response.ok || !response.result) {
        item.reject(Error(String(response.message || response.error || 'Night Filter refused the change')))
      } else if (!Array.isArray(response.result.targets)) {
        item.reject(Error('Night Filter returned no verified display inventory'))
      } else {
        this.lastStatus = response.result
        this.emit('status', response.result)
        item.resolve(response.result)
      }
      this.scheduleIdle()
    }
  }

  failAll(error) {
    const oldChild = this.child
    this.child = null
    this.stdout = ''
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    this.pending.clear()
    if (oldChild && !oldChild.killed) oldChild.kill()
  }

  scheduleIdle() {
    clearTimeout(this.idleTimer)
    if (this.closed || this.pending.size || !this.child) return
    this.idleTimer = setTimeout(() => {
      if (this.pending.size || !this.child) return
      // Graceful stdin EOF lets the canonical one-shot stdio adapter exit.
      this.child.stdin.end()
      this.child = null
    }, this.idleMs)
  }

  request(action, payload = {}) {
    if (!['night_filter_status', 'night_filter_set'].includes(action)) {
      return Promise.reject(Error('Unsupported Night Filter action'))
    }
    if (this.pending.size >= 16) return Promise.reject(Error('Night Filter control queue is busy'))
    clearTimeout(this.idleTimer)
    let child
    try { child = this.start() }
    catch (error) { return Promise.reject(error) }
    const requestId = 'twinkle.' + (++this.sequence)
    const envelope = { schema: SCHEMA, protocol_version: 1, request_id: requestId, action, payload }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failAll(Error('Night Filter did not confirm the change. Refresh before retrying.'))
      }, this.timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      child.stdin.write(JSON.stringify(envelope) + '\n', error => {
        if (error) this.failAll(Error('Night Filter command pipe closed unexpectedly'))
      })
    })
  }

  status() { return this.request('night_filter_status') }

  set(patch) {
    if (!patch || typeof patch !== 'object') return Promise.reject(Error('Invalid display warmth request'))
    const id = String(patch.target_id || '')
    const strength = patch.strength
    // Source identity must come from the last canonical inventory, never a
    // guessed DDC id or an arbitrary target supplied by a WebContent.
    const current = this.lastStatus?.targets?.find(t => t.id === id && t.id !== 'all')
    if (!current || !Array.isArray(current.geometry) || current.geometry.length !== 4) {
      return Promise.reject(Error('Refresh monitor identities before setting warmth'))
    }
    if (!Number.isInteger(strength) || strength < 0 || strength > 100) {
      return Promise.reject(Error('Warmth must be 0–100'))
    }
    return this.request('night_filter_set', {
      target_id: id,
      enabled: strength > 0,
      strength,
      dimness: 0,
      dim_duration_minutes: 0,
    })
  }

  close() {
    this.closed = true
    clearTimeout(this.idleTimer)
    this.failAll(Error('Night Filter connection closed'))
  }
}

module.exports = { NightFilterDisplayBridge }
