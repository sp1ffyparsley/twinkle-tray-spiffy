// Native Mac built-in-display brightness through nriley/brightness (BSD-2).
// The tool uses macOS DisplayServices on Apple Silicon and CoreDisplay on
// supported Intel Macs. No shell, helper daemon, gamma override or elevation.
// Restrict candidates to positively identified built-in panels to avoid
// controlling the same external monitor through two independent backends.
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ID = /^0x[0-9a-f]{1,8}$/i
function parseBuiltInBrightness(output) {
  if (typeof output !== 'string' || output.length > 64 * 1024) throw Error('Invalid built-in brightness inventory')
  const lines = output.split(/\r?\n/)
  const pending = new Map()
  const found = []
  for (const line of lines) {
    const display = /^display (\d{1,2}): (.+), ID (0x[0-9a-f]{1,8})\s*$/i.exec(line.trim())
    if (display) {
      const index = Number(display[1])
      const flags = display[2].toLowerCase().split(/,\s*/)
      const id = display[3].toLowerCase()
      if (index >= 16 || !ID.test(id)) throw Error('Invalid Mac display identifier')
      if (flags.includes('built-in') && flags.includes('active') && flags.includes('online')) {
        if ([...pending.values()].some(value => value.id === id)) throw Error('Duplicate built-in display identity')
        pending.set(index, { id, index })
      }
      continue
    }
    const brightness = /^display (\d{1,2}): brightness (0(?:\.\d+)?|1(?:\.0+)?)\s*$/.exec(line.trim())
    if (!brightness) continue
    const entry = pending.get(Number(brightness[1]))
    if (!entry) continue
    const fraction = Number(brightness[2])
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw Error('Invalid built-in brightness level')
    if (found.some(item => item.id === entry.id)) throw Error('Duplicate built-in brightness report')
    found.push({ id: entry.id, level: Math.round(fraction * 100) })
  }
  return found
}

function findBuiltInBrightness({ platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform !== 'darwin') return null
  for (const binary of ['/opt/homebrew/bin/brightness', '/usr/local/bin/brightness']) {
    if (exists(binary)) return binary
  }
  return null
}

class MacBuiltInBackend {
  constructor({
    platform = process.platform, executable = findBuiltInBrightness({ platform }),
    runner = execFile, timeoutMs = 2500,
  } = {}) {
    this.platform = platform
    this.executable = executable
    this.runner = runner
    this.timeoutMs = Math.max(250, Math.min(5000, timeoutMs))
    this.monitors = new Map()
    this.io = Promise.resolve()
    this.pendingWrites = new Map()
    this.closed = false
  }
  get available() {
    return this.platform === 'darwin' && typeof this.executable === 'string' &&
      path.isAbsolute(this.executable)
  }
  run(args) {
    if (this.closed) return Promise.reject(Error('Built-in display backend closed'))
    if (!this.available) return Promise.reject(Error('Mac built-in brightness driver unavailable'))
    return new Promise((resolve, reject) => {
      this.runner(this.executable, args, {
        shell: false, timeout: this.timeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8',
      }, (error, stdout) => {
        if (error) return reject(Error('Built-in brightness driver refused or timed out'))
        resolve(String(stdout || ''))
      })
    })
  }
  serial(job) {
    const next = this.io.then(job)
    this.io = next.catch(() => {})
    return next
  }
  async refresh() {
    return this.serial(async () => {
      // Disconnects and failed native inventory reads must invalidate the old
      // display set before anyone can write to an obsolete CGDisplayID.
      this.monitors.clear()
      const displays = parseBuiltInBrightness(await this.run(['-l']))
      for (const item of displays) {
        const key = 'mac-built-in:' + item.id
        this.monitors.set(key, {
          id: key, key, name: 'Built-in Display', num: item.index,
          type: 'wmi', // shared panel uses this as its native brightness type
          brightnessType: 16, brightness: item.level,
          hwid: ['mac-built-in', item.id], hdr: 'inactive', features: {},
        })
      }
      return this.snapshot()
    })
  }
  snapshot() {
    return Object.fromEntries([...this.monitors.entries()].map(([id, row]) => [id, { ...row }]))
  }
  async writeConfirmed(id, value) {
    const current = this.monitors.get(id)
    const cgId = id.slice('mac-built-in:'.length)
    if (!current || !ID.test(cgId)) throw Error('Invalid built-in display identity')
    await this.run(['-d', cgId, String(value / 100)])
    const matching = parseBuiltInBrightness(await this.run(['-l'])).filter(entry => entry.id === cgId)
    if (matching.length !== 1 || Math.abs(matching[0].level - value) > 1) {
      throw Error('Built-in display readback did not confirm brightness')
    }
    current.brightness = matching[0].level
    return { id, level: current.brightness, confirmed: true }
  }
  setBrightness(id, value) {
    if (!Number.isInteger(value) || value < 0 || value > 100 || typeof id !== 'string' || !this.monitors.has(id)) {
      return Promise.reject(Error('Unknown built-in display or brightness out of range'))
    }
    if (this.closed) return Promise.reject(Error('Built-in display backend closed'))
    const existing = this.pendingWrites.get(id)
    if (existing) {
      if (existing.waiters.length >= 1024) return Promise.reject(Error('Too many pending brightness inputs'))
      existing.latest = value
      return new Promise((resolve, reject) => existing.waiters.push({ resolve, reject }))
    }
    const pending = { latest: value, waiters: [] }
    this.pendingWrites.set(id, pending)
    const result = new Promise((resolve, reject) => pending.waiters.push({ resolve, reject }))
    this.serial(async () => {
      let last
      try {
        do {
          const requested = pending.latest
          pending.latest = null
          last = await this.writeConfirmed(id, requested)
        } while (pending.latest !== null && !this.closed)
        if (this.closed) throw Error('Display backend closed before final readback')
        for (const waiter of pending.waiters) waiter.resolve(last)
      } catch (error) {
        for (const waiter of pending.waiters) waiter.reject(error)
      } finally {
        if (this.pendingWrites.get(id) === pending) this.pendingWrites.delete(id)
      }
    }).catch(() => {})
    return result
  }
  close() { this.closed = true; this.monitors.clear() }
}

module.exports = { MacBuiltInBackend, findBuiltInBrightness, parseBuiltInBrightness }
