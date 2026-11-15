// macOS hardware-brightness adapter for the shared Spiffy display contract.
// Uses MIT-licensed m1ddc for Apple Silicon external displays, plus the
// BSD-2-Clause nriley/brightness backend for supported built-in displays.
// No shell, injected JavaScript, polling daemon, startup brightness writes,
// unrelated app or private macOS framework is required.
//
// A Mac that lacks a supported DDC/CI endpoint gets an explicit unavailable
// result. This deliberately does not pretend m1ddc controls Intel Macs,
// built-in Apple panels, or every HDMI/USB adapter.
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { MacBuiltInBackend } = require('./MacBuiltInBackend')

const UUID = /^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/
const DISPLAY = /^\[(\d{1,2})\]\s+(.+?)\s+\(([A-Fa-f0-9-]{36})\)\s*$/
const MAX_DISPLAYS = 16

function parseMacDisplayList(output) {
  if (typeof output !== 'string' || output.length > 64 * 1024) throw Error('Invalid m1ddc display inventory')
  const rows = []
  const used = new Set()
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('[')) continue
    const matched = DISPLAY.exec(line.trim())
    if (!matched || !UUID.test(matched[3])) throw Error('Unrecognized m1ddc display identity; refusing numbered fallback')
    const num = Number(matched[1])
    const uuid = matched[3].toUpperCase()
    const name = matched[2].trim()
    if (!num || num > MAX_DISPLAYS || used.has(uuid) || !name) {
      throw Error('Duplicate or ambiguous macOS display identity')
    }
    used.add(uuid)
    rows.push({ uuid, num, name: name.slice(0, 120) })
  }
  if (rows.length > MAX_DISPLAYS) throw Error('Unexpected display inventory size')
  return rows
}

function parseMacBrightness(output, max = 65535) {
  if (typeof output !== 'string' || !/^\d{1,5}\s*$/.test(output)) {
    throw Error('DDC brightness readback was not numeric')
  }
  const value = Number(output.trim())
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw Error('DDC brightness value is outside the supported hardware range')
  }
  return value
}

function findMacDDC({ platform = process.platform, arch = process.arch, exists = fs.existsSync } = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') return null
  for (const executable of ['/opt/homebrew/bin/m1ddc', '/usr/local/bin/m1ddc']) {
    if (exists(executable)) return executable
  }
  return null
}

class MacDisplayBackend {
  constructor({
    platform = process.platform, arch = process.arch,
    executable = findMacDDC({ platform, arch }),
    builtInBackend = new MacBuiltInBackend({ platform }),
    runner = execFile, timeoutMs = 2500,
  } = {}) {
    this.platform = platform
    this.arch = arch
    this.executable = executable
    this.runner = runner
    this.builtIn = builtInBackend
    this.timeoutMs = Math.max(250, Math.min(5000, timeoutMs))
    this.monitors = new Map()
    this.io = Promise.resolve()
    this.pendingWrites = new Map()
    this.closed = false
  }

  get available() {
    return this.externalAvailable || Boolean(this.builtIn?.available)
  }

  get externalAvailable() {
    return this.platform === 'darwin' && this.arch === 'arm64' &&
      typeof this.executable === 'string' && path.isAbsolute(this.executable)
  }

  run(args) {
    if (this.closed) return Promise.reject(Error('Display backend is closed'))
    if (!this.externalAvailable) return Promise.reject(Error('m1ddc is not available on this Mac'))
    if (!Array.isArray(args) || args.some(v => typeof v !== 'string' || !v.length || v.length > 160)) {
      return Promise.reject(Error('Invalid DDC command arguments'))
    }
    return new Promise((resolve, reject) => {
      this.runner(this.executable, args, {
        windowsHide: true, shell: false, timeout: this.timeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8',
      }, (error, stdout) => {
        if (error) return reject(Error('Mac display driver rejected or timed out on the DDC request'))
        resolve(String(stdout || ''))
      })
    })
  }

  // One command at a time over the shared I2C/DDC bus; two Electron slider
  // inputs must not race each other or corrupt an external display's firmware.
  serial(job) {
    const current = this.io.then(job)
    this.io = current.catch(() => {})
    return current
  }

  async refresh() {
    return this.serial(async () => {
      const next = new Map()
      if (this.externalAvailable) {
        try {
          const listing = parseMacDisplayList(await this.run(['display', 'list', 'detailed']))
          for (const found of listing) {
            const address = 'uuid:' + found.uuid
            try {
              const maximum = parseMacBrightness(await this.run(['display', address, 'max', 'luminance']))
              if (maximum < 1) continue
              const value = parseMacBrightness(await this.run(['display', address, 'get', 'luminance']), maximum)
              next.set(found.uuid, {
                id: 'mac-ddc:' + found.uuid,
                key: 'mac-ddc:' + found.uuid,
                name: found.name,
                num: found.num,
                type: 'ddcci',
                brightnessType: 16,
                brightness: Math.round(value / maximum * 100),
                maximum,
                uuid: found.uuid,
                hwid: ['mac-ddc', found.uuid],
                hdr: 'inactive',
                features: {},
              })
            } catch (_) {
              // An endpoint whose DDC reads fail must be unavailable, not a
              // fake working slider with arbitrary 50% brightness.
            }
          }
        } catch (_) {
          // External DDC failure must not hide an otherwise valid built-in
          // Mac display from the shared React panel.
        }
      }
      this.monitors = next
      if (this.builtIn?.available) {
        try { await this.builtIn.refresh() }
        catch (_) { /* Built-in failure must not hide valid DDC monitors. */ }
      }
      return this.snapshot()
    })
  }

  snapshot() {
    return {
      ...Object.fromEntries([...this.monitors.values()].map(m => [m.key, { ...m }])),
      ...(this.builtIn ? this.builtIn.snapshot() : {}),
    }
  }

  async writeConfirmed(id, level) {
    const uuid = id.slice(8)
    const monitor = this.monitors.get(uuid)
    if (!monitor || monitor.id !== id || !UUID.test(uuid)) {
      throw Error('The Mac display identity is unknown or was disconnected')
    }
    const address = 'uuid:' + uuid
    const raw = Math.round(level / 100 * monitor.maximum)
    await this.run(['display', address, 'set', 'luminance', String(raw)])
    const observed = parseMacBrightness(
      await this.run(['display', address, 'get', 'luminance']), monitor.maximum,
    )
    if (Math.abs(observed - raw) > Math.max(1, Math.ceil(monitor.maximum / 100))) {
      throw Error('Mac DDC readback did not confirm the requested brightness')
    }
    monitor.brightness = Math.round(observed / monitor.maximum * 100)
    return { id, level: monitor.brightness, confirmed: true }
  }

  setBrightness(id, level) {
    if (typeof id === 'string' && id.startsWith('mac-built-in:')) {
      if (!this.builtIn?.available) return Promise.reject(Error('Built-in Mac brightness backend unavailable'))
      return this.builtIn.setBrightness(id, level)
    }
    if (typeof id !== 'string' || !Number.isInteger(level) || level < 0 || level > 100) {
      return Promise.reject(Error('Mac hardware brightness must be an integer from 0 to 100'))
    }
    if (this.closed) return Promise.reject(Error('Display backend is closed'))
    if (!this.monitors.has(id.slice(8)) || this.monitors.get(id.slice(8)).id !== id) {
      return Promise.reject(Error('The Mac display identity is unknown or was disconnected'))
    }
    const existing = this.pendingWrites.get(id)
    if (existing) {
      if (existing.waiters.length >= 1024) return Promise.reject(Error('Too many pending brightness inputs'))
      // One most-recent target, not one DDC transaction per pointer event.
      existing.latest = level
      return new Promise((resolve, reject) => existing.waiters.push({ resolve, reject }))
    }
    const pending = { latest: level, waiters: [] }
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
        // A failed DDC write might already have reached the monitor; do not
        // replay a newer request automatically after an uncertain failure.
        for (const waiter of pending.waiters) waiter.reject(error)
      } finally {
        if (this.pendingWrites.get(id) === pending) this.pendingWrites.delete(id)
      }
    }).catch(() => {
      // Errors are already delivered to every request above.
    })
    return result
  }

  close() {
    this.closed = true
    this.monitors.clear()
    this.builtIn?.close()
  }
}

module.exports = { MacDisplayBackend, parseMacDisplayList, parseMacBrightness, findMacDDC }
