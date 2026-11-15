function createMonitorCommandDispatcher({ send, events, nextRequestId, timeoutMs = 15000 }) {
  if (typeof send !== 'function' || typeof nextRequestId !== 'function' ||
      !events || typeof events.once !== 'function' || typeof events.removeListener !== 'function') {
    throw new TypeError('A monitor worker sender, event emitter, and request ID factory are required.')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('Monitor worker acknowledgement timeout must be a positive integer.')
  }

  return function sendConfirmedVCP(monitor, code, value) {
    const requestId = nextRequestId()
    const eventName = `vcp-dispatched::${requestId}`
    return new Promise((resolve, reject) => {
      let settled = false
      let timeout
      const finish = error => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        events.removeListener(eventName, receive)
        if (error) reject(error)
        else resolve(true)
      }
      const receive = result => {
        if (result?.ok === true) return finish()
        finish(Error(result?.error || 'Monitor worker refused the VCP request; hardware completion is unconfirmed.'))
      }

      events.once(eventName, receive)
      timeout = setTimeout(() => finish(Error(
        'Monitor worker did not acknowledge VCP dispatch; the outcome is unconfirmed and the command was not retried.'
      )), timeoutMs)

      Promise.resolve().then(() => send({
        type: 'vcp', monitor, code, value, requestId,
      }, { requireDispatch: true })).catch(error => finish(Error(
        `Monitor worker dispatch failed: ${String(error?.message || error)}. The command was not retried.`
      )))
    })
  }
}

module.exports = { createMonitorCommandDispatcher }
