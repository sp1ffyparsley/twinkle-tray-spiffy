const { execFile } = require('node:child_process')
const path = require('node:path')

function mapBrightness(level) {
  if (!Number.isInteger(level) || level < -100 || level > 200) throw Error('Brightness must be -100 through 200.')
  return { level, hardware: Math.max(0, Math.min(100, level)),
    dimness: level < 0 ? -level * .8 : 0, gain: Math.max(1, level / 100) }
}

// Relative light transmission of the same pure matrix used by the shared
// Windows renderer. At negative levels hardware stays at its minimum, so
// -80 must ALWAYS transmit less light than -70, regardless of monitor type.
function effectiveLightTransmission(level) {
  const effect = mapBrightness(level)
  return Math.max(0.2, 1 - effect.dimness / 100) * effect.gain
}

class ExtendedBrightness {
  constructor({ scriptsRoot, getMonitor, hardware, filter, saved, baseline = () => undefined, readHardware, save, complete, publish, logger, run = execFile }) {
    Object.assign(this, { scriptsRoot, getMonitor, hardware, filter, saved, baseline, readHardware, save, publish, logger, run })
    this.complete = complete || ((id, level) => save(id, level < 0 || level > 100 ? level : undefined))
    this.pending = new Map()
    this.busy = false
    this.timer = null
    this.topologyPending = null
    this.closing = false
    this.confirmedHardware = new Map()
    this.topologyEpoch = 0
    logger(`extended_brightness startup root=${scriptsRoot}`)
  }

  set(id, level) {
    if (this.closing) throw Error('Twinkle Tray is restoring brightness before quitting.')
    mapBrightness(level)
    const monitor = this.getMonitor(id)
    if (!monitor) throw Error('Display disconnected; refresh displays.')
    if ((level < 0 || level > 100) && monitor.type && monitor.type !== 'ddcci') {
      throw Error('This display does not currently expose readable DDC brightness. Refresh displays before using extended brightness.')
    }
    if ((level < 0 || level > 100) && monitor.hdr === 'active') {
      throw Error('Extended software brightness is unavailable in HDR. Use the native SDR control.')
    }
    if (!this.pending.has(id) && this.pending.size >= 16) throw Error('Too many pending displays; finish the current adjustment.')
    this.pending.set(id, level)
    if (!this.busy && !this.timer) {
      // Throttle from the first input: continuous dragging must still apply.
      this.timer = setTimeout(() => this.drain(), 30)
    }
    this.publish({ id, level, pending: true, error: '' })
  }

  writeEffect(monitor, level) {
    const bounds = monitor.bounds
    if (!bounds || !bounds.position) return Promise.reject(Error('Current monitor geometry is unavailable; refresh displays.'))
    const request = { id: monitor.id, level,
      geometry: [bounds.position.x, bounds.position.y, bounds.width, bounds.height] }
    return this.writeRequest(request)
  }

  reconcile(monitors) {
    if (this.closing) return
    // A DDC ID can survive a hotplug while its physical endpoint changes.
    // Invalidate even same-level confirmations before accepting new writes.
    this.topologyEpoch++
    this.confirmedHardware.clear()
    this.topologyPending = monitors.map(m => ({ id: m.id, hdr: m.hdr,
      geometry: m.bounds?.position ? [m.bounds.position.x, m.bounds.position.y, m.bounds.width, m.bounds.height] : null }))
    if (!this.busy) {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.drain(), 0)
    }
  }

  writeRequest(request) {
    const python = path.join(this.scriptsRoot, 'Spiffy Workspace', '.venv', 'Scripts', 'python.exe')
    return new Promise((resolve, reject) => {
      // Read only this installed source script outside ASAR; no shell command,
      // arbitrary request path, hardware mutation or persistent Python process.
      const script = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'brightness-state.py')
      const child = this.run(python, ['-B', script, this.scriptsRoot],
        { windowsHide: true, timeout: 5000, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => {
          let result
          try { result = JSON.parse(stdout) } catch (_) { /* Error below includes no private child output. */ }
          if (error || !result?.ok) reject(Error(result?.error || 'Brightness state update did not finish. Refresh and reset extra brightness before retrying.'))
          else resolve(result)
        })
      child.stdin.on('error', () => {}) // callback reports early child failure
      // Windows venv python.exe is a short-lived launcher. Bind custody to the
      // resident Electron owner, never the helper's immediate parent process.
      child.stdin.end(JSON.stringify({ ...request, owner_pid: process.pid }))
    })
  }

  async drain() {
    if (this.busy) return
    this.busy = true
    this.timer = null
    while (this.pending.size || this.topologyPending) {
      if (this.topologyPending) {
        const displays = this.topologyPending
        this.topologyPending = null
        try {
          const result = await this.writeRequest({ action: 'reconcile', displays })
          this.logger(`extended_brightness topology reconciled displays=${displays.length} removed=${result.removed}`)
        } catch (error) {
          this.pending.clear()
          this.publish({ pending: false, error: `Display reconciliation failed: ${error.message}` })
          this.logger(`extended_brightness topology failed error=${error.message}`)
          break
        }
        continue
      }
      const [id, level] = this.pending.entries().next().value
      this.pending.delete(id)
      const started = Date.now()
      const topologyEpoch = this.topologyEpoch
      const staleTopology = () => {
        if (this.topologyEpoch === topologyEpoch) return false
        // A prior effect may already be committed; preserve the recovery
        // intent and let the explicit refresh/reset path reconcile it.
        if (!this.pending.has(id)) this.publish({ id, level, pending: false,
          error: 'Display topology changed during brightness adjustment; refresh displays and reset extra brightness if needed.' })
        this.logger(`extended_brightness topology changed before confirmation id=${id}`)
        return true
      }
      try {
        const monitor = this.getMonitor(id)
        if (!monitor) throw Error('Display disconnected before adjustment; refresh displays.')
        const mapped = mapBrightness(level)
        if ((level < 0 || level > 100) && monitor.type && monitor.type !== 'ddcci') throw Error('DDC support became unavailable; extended brightness was refused.')
        if ((level < 0 || level > 100) && monitor.hdr === 'active') throw Error('HDR became active; extended brightness was refused.')
        // Existing native 0..100 requests stay on their fast path unless a prior
        // extended intent needs removing. Persist intent before any side effect.
        const needsEffect = level < 0 || level > 100 || this.saved(id) !== undefined
        if (needsEffect) {
          await this.save(id, level)
          if (staleTopology() || this.pending.has(id) || this.closing) continue
          await this.writeEffect(monitor, level)
          if (staleTopology() || this.pending.has(id) || this.closing) continue
          const status = await this.filter().ensure()
          if ((level < 0 || level > 100) && !status.running) throw Error('The filter renderer did not start. Hardware brightness was not changed.')
          if ((level < 0 || level > 100) && status.brightnessDisplays === 0) {
            throw Error('The filter owner could not confirm any active brightness effect; the change was not reported as successful.')
          }
        }
        // A newer value supersedes this hardware request after a slow software
        // start, including an immediate reset. Never emit the obsolete value.
        if (staleTopology() || this.pending.has(id) || this.closing) continue
        // During a continuous drag below zero or above 100, only the software
        // effect changes. Reuse the briefly owned, confirmed endpoint rather
        // than repeatedly sending the same slow DDC write/readback sequence.
        const confirmed = this.confirmedHardware.get(id)
        // Rewriting a DDC brightness endpoint during negative-range dragging
        // can produce a transient brighter hardware frame on some LG monitors.
        // Keep a recently confirmed hardware minimum for a few seconds while
        // only the software matrix changes. Any topology refresh clears it.
        const hardwareConfirmationTTL = level < 0 && mapped.hardware === 0 ? 10000 : 1500
        let hardwareNeedsWrite = !confirmed || confirmed.level !== mapped.hardware
        if (!hardwareNeedsWrite && Date.now() - confirmed.at > hardwareConfirmationTTL) {
          if (level < 0 && mapped.hardware === 0 && this.readHardware) {
            // The prior unconditional 0% re-write could briefly brighten LG
            // monitors even while the software matrix was getting darker.
            // Read the endpoint first and re-write ONLY if it actually drifted.
            const observed = await this.readHardware(monitor)
            if (!Number.isFinite(observed) || observed < 0 || observed > 100) {
              throw Error('The physical brightness could not be confirmed; no repeated hardware write was sent.')
            }
            hardwareNeedsWrite = Math.abs(observed - mapped.hardware) >= 1
            if (!hardwareNeedsWrite && this.topologyEpoch === topologyEpoch) {
              this.confirmedHardware.set(id, { level: mapped.hardware, at: Date.now() })
            }
          } else {
            hardwareNeedsWrite = true
          }
        }
        if (hardwareNeedsWrite) {
          if (staleTopology() || this.pending.has(id) || this.closing) continue
          if (await this.hardware(id, mapped.hardware) === false) throw Error('The native brightness request was refused.')
          if (this.topologyEpoch === topologyEpoch) this.confirmedHardware.set(id, { level: mapped.hardware, at: Date.now() })
        }
        if (staleTopology() || this.pending.has(id) || this.closing) continue
        if (needsEffect) await this.complete(id, level)
        if (staleTopology()) continue
        this.publish({ id, level, pending: false, error: '', hardwareRequested: mapped.hardware })
        this.logger(`extended_brightness completed level=${level} hardware_requested=${mapped.hardware} elapsed_ms=${Date.now() - started}`)
      } catch (error) {
        // An uncertain effect is never replayed. Recovery is explicit and local.
        this.confirmedHardware.delete(id)
        // A newer request may have arrived while the failed write was in flight.
        // Preserve that request for the next drain; it is a fresh user action.
        if (!this.pending.has(id)) this.publish({ id, level, pending: false, error: error.message })
        this.logger(`extended_brightness failed error=${error.message}`)
      }
    }
    this.busy = false
  }

  async close(ids) {
    this.closing = true
    clearTimeout(this.timer)
    this.pending.clear()
    this.topologyPending = null
    const deadline = Date.now() + 25000
    while (this.busy) {
      if (Date.now() > deadline) throw Error('Pending brightness request did not settle before quit; baseline remains saved for recovery.')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    for (const id of ids) {
      const level = this.saved(id)
      const monitor = this.getMonitor(id)
      if (level === undefined || !monitor) continue
      const baseline = this.baseline(id)
      const normal = Number.isInteger(baseline) ? baseline : Math.round(Math.max(0, Math.min(100, monitor.brightness)))
      await this.writeEffect(monitor, normal)
      // Respect a subsequently observed external hardware adjustment. Keep the
      // saved user intent/baseline for an explicit reopen, rather than erasing it.
      const observed = this.readHardware ? await this.readHardware(monitor) : monitor.brightness
      if (Math.abs(observed - mapBrightness(level).hardware) < 1) {
        if (await this.hardware(id, normal) === false) throw Error('Quit removed software effects but hardware baseline request was refused; baseline remains saved.')
      }
      this.logger(`extended_brightness quit software_cleared baseline=${normal} saved_intent=${level}`)
    }
  }
}

module.exports = { ExtendedBrightness, mapBrightness, effectiveLightTransmission }
