const test = require('node:test')
const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { handleProcessedArgs, processArgs } = require('../src/Utils')

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.bind(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  })
}

function close(server) {
  return new Promise(resolve => {
    if (!server) return resolve()
    try { server.close(resolve) } catch (_) { resolve() }
  })
}

function settingsFile(port) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twinkle-udp-command-'))
  const file = path.join(root, 'settings.json')
  fs.writeFileSync(file, JSON.stringify({ udpPortActive: port, udpKey: 'loopback-test-key' }))
  return { root, file }
}

function trackClientClose(originalCreateSocket) {
  const state = { socket: null, closeCount: 0 }
  dgram.createSocket = (...args) => {
    const socket = originalCreateSocket(...args)
    state.socket = socket
    const closeSocket = socket.close.bind(socket)
    socket.close = (...closeArgs) => {
      state.closeCount += 1
      return closeSocket(...closeArgs)
    }
    return socket
  }
  return state
}

test('UDP list request sends the key, receives a reply, and closes its one-shot socket', async () => {
  const server = dgram.createSocket('udp4')
  const port = await listen(server)
  const settings = settingsFile(port)
  const originalCreateSocket = dgram.createSocket
  const client = trackClientClose(originalCreateSocket)
  let request
  server.on('message', (message, remote) => {
    request = JSON.parse(message.toString())
    server.send(JSON.stringify({ display: { num: 0, key: 'loopback-display', name: 'Test display', brightness: 50, type: 'DDC' } }), remote.port, remote.address)
  })
  try {
    const result = await handleProcessedArgs({ List: true, UseUDP: true }, null, settings.file)
    assert.equal(result, true)
    assert.deepEqual(request, { type: 'list', data: false, key: 'loopback-test-key' })
    assert.equal(client.closeCount, 1)
  } finally {
    dgram.createSocket = originalCreateSocket
    if (client.socket && client.closeCount === 0) {
      try { client.socket.close() } catch (_) {}
    }
    await close(server)
    fs.rmSync(settings.root, { recursive: true, force: true })
  }
})

test('UDP timeout rejects and closes the unresponsive one-shot socket', async () => {
  const reservation = dgram.createSocket('udp4')
  const unusedPort = await listen(reservation)
  await close(reservation)
  const settings = settingsFile(unusedPort)
  const originalCreateSocket = dgram.createSocket
  const client = trackClientClose(originalCreateSocket)
  try {
    await assert.rejects(
      handleProcessedArgs({ List: true, UseUDP: true }, null, settings.file),
      error => error === 'No response',
    )
    assert.equal(client.closeCount, 1)
  } finally {
    dgram.createSocket = originalCreateSocket
    if (client.socket && client.closeCount === 0) {
      try { client.socket.close() } catch (_) {}
    }
    fs.rmSync(settings.root, { recursive: true, force: true })
  }
})

test('secondary-instance --Set dispatches an authenticated brightness command over UDP', async () => {
  const server = dgram.createSocket('udp4')
  const port = await listen(server)
  const settings = settingsFile(port)
  const originalCreateSocket = dgram.createSocket
  const client = trackClientClose(originalCreateSocket)
  let request
  server.on('message', (message, remote) => {
    request = JSON.parse(message.toString())
    server.send(JSON.stringify({ accepted: true, pending: true, level: 55 }), remote.port, remote.address)
  })
  try {
    const args = processArgs(['--udp', '--monitorid=uid2353', '--set=55'])
    assert.deepEqual(args, { UseUDP: true, MonitorID: 'uid2353', Brightness: 55, BrightnessType: 'set' })
    assert.equal(await handleProcessedArgs(args, null, settings.file), true)
    assert.deepEqual(request, {
      type: 'set',
      data: { monitor: 'uid2353', vcp: 'brightness', value: 55, mode: 'set' },
      key: 'loopback-test-key',
    })
    assert.equal(client.closeCount, 1)
  } finally {
    dgram.createSocket = originalCreateSocket
    if (client.socket && client.closeCount === 0) {
      try { client.socket.close() } catch (_) {}
    }
    await close(server)
    fs.rmSync(settings.root, { recursive: true, force: true })
  }
})

test('secondary-instance --MonitorNum resolves the 1-based display before --Offset dispatch', async () => {
  const server = dgram.createSocket('udp4')
  const port = await listen(server)
  const settings = settingsFile(port)
  const originalCreateSocket = dgram.createSocket
  const client = trackClientClose(originalCreateSocket)
  const requests = []
  server.on('message', (message, remote) => {
    const request = JSON.parse(message.toString())
    requests.push(request)
    const response = request.type === 'list'
      // Deliberately return insertion order opposite to the primary monitor numbers.
      ? JSON.stringify({ second: { num: 1 }, first: { num: 0 } })
      : JSON.stringify({ accepted: true, pending: true, level: 40 })
    server.send(response, remote.port, remote.address)
  })
  try {
    const args = processArgs(['--udp', '--monitornum=2', '--offset=-10'])
    assert.equal(await handleProcessedArgs(args, null, settings.file), true)
    assert.deepEqual(requests.map(request => request.type), ['list', 'set'])
    assert.deepEqual(requests[1], {
      type: 'set',
      data: { monitor: 'second', vcp: 'brightness', value: -10, mode: 'offset' },
      key: 'loopback-test-key',
    })
    assert.equal(client.closeCount, 2)
  } finally {
    dgram.createSocket = originalCreateSocket
    if (client.socket && client.closeCount === 0) {
      try { client.socket.close() } catch (_) {}
    }
    await close(server)
    fs.rmSync(settings.root, { recursive: true, force: true })
  }
})

test('secondary-instance --All with hexadecimal VCP dispatches to each monitor', async () => {
  const server = dgram.createSocket('udp4')
  const port = await listen(server)
  const settings = settingsFile(port)
  const originalCreateSocket = dgram.createSocket
  const client = trackClientClose(originalCreateSocket)
  const requests = []
  server.on('message', (message, remote) => {
    const request = JSON.parse(message.toString())
    requests.push(request)
    const response = request.type === 'list'
      ? JSON.stringify({ first: { num: 0 }, second: { num: 1 } })
      : JSON.stringify({ accepted: true, pending: true, code: request.data.vcp, value: request.data.value })
    server.send(response, remote.port, remote.address)
  })
  try {
    const args = processArgs(['--udp', '--all', '--vcp=0xD6:5'])
    assert.deepEqual(args.VCP, { code: 0xD6, value: 5 })
    assert.equal(await handleProcessedArgs(args, null, settings.file), true)
    assert.deepEqual(requests.map(request => [request.type, request.type === 'list' ? false : request.data.monitor]), [
      ['list', false], ['setvcp', 'first'], ['setvcp', 'second'],
    ])
    assert.deepEqual(requests.slice(1).map(request => request.data), [
      { monitor: 'first', vcp: 0xD6, value: 5 },
      { monitor: 'second', vcp: 0xD6, value: 5 },
    ])
    assert.ok(requests.every(request => request.key === 'loopback-test-key'))
    assert.equal(client.closeCount, 3)
  } finally {
    dgram.createSocket = originalCreateSocket
    if (client.socket && client.closeCount === 0) {
      try { client.socket.close() } catch (_) {}
    }
    await close(server)
    fs.rmSync(settings.root, { recursive: true, force: true })
  }
})

test('secondary-instance VCP waits for a delayed worker acknowledgement over loopback', async () => {
  const server = dgram.createSocket('udp4')
  const port = await listen(server)
  const settings = settingsFile(port)
  const originalCreateSocket = dgram.createSocket
  const client = trackClientClose(originalCreateSocket)
  let request
  server.on('message', (message, remote) => {
    request = JSON.parse(message.toString())
    setTimeout(() => {
      server.send(JSON.stringify({ accepted: true, pending: true, code: request.data.vcp, value: request.data.value }), remote.port, remote.address)
    }, 1100)
  })
  const started = Date.now()
  try {
    const args = processArgs(['--udp', '--monitorid=uid2353', '--vcp=0xD6:5'])
    assert.equal(await handleProcessedArgs(args, null, settings.file), true)
    assert.ok(Date.now() - started >= 1000, 'the CLI returned before the delayed worker acknowledgement')
    assert.equal(request.type, 'setvcp')
    assert.deepEqual(request.data, { monitor: 'uid2353', vcp: 0xD6, value: 5 })
    assert.equal(request.key, 'loopback-test-key')
    assert.equal(client.closeCount, 1)
  } finally {
    dgram.createSocket = originalCreateSocket
    if (client.socket && client.closeCount === 0) {
      try { client.socket.close() } catch (_) {}
    }
    await close(server)
    fs.rmSync(settings.root, { recursive: true, force: true })
  }
})

test('malformed VCP arguments fail closed without sending a UDP command', async () => {
  const settings = settingsFile(14715)
  const originalCreateSocket = dgram.createSocket
  let socketCreated = false
  dgram.createSocket = (...args) => {
    socketCreated = true
    return originalCreateSocket(...args)
  }
  try {
    for (const value of ['not-a-code', '0x100:5', '0x10:65536']) {
      const args = processArgs(['--udp', '--monitorid=uid2353', `--vcp=${value}`])
      await assert.rejects(handleProcessedArgs(args, null, settings.file), /Invalid command-line arguments/)
    }
    assert.equal(socketCreated, false)
  } finally {
    dgram.createSocket = originalCreateSocket
    fs.rmSync(settings.root, { recursive: true, force: true })
  }
})

test('UDP authentication rejection is surfaced as failure and closes the socket', async () => {
  const server = dgram.createSocket('udp4')
  const port = await listen(server)
  const settings = settingsFile(port)
  const originalCreateSocket = dgram.createSocket
  const client = trackClientClose(originalCreateSocket)
  let request
  server.on('message', (message, remote) => {
    request = JSON.parse(message.toString())
    server.send(JSON.stringify({ accepted: false, error: 'Missing or invalid key' }), remote.port, remote.address)
  })
  try {
    await assert.rejects(
      handleProcessedArgs(processArgs(['--udp', '--list']), null, settings.file),
      /Missing or invalid key/,
    )
    assert.equal(request.key, 'loopback-test-key')
    assert.equal(client.closeCount, 1)
  } finally {
    dgram.createSocket = originalCreateSocket
    if (client.socket && client.closeCount === 0) {
      try { client.socket.close() } catch (_) {}
    }
    await close(server)
    fs.rmSync(settings.root, { recursive: true, force: true })
  }
})

test('missing monitor rejection is surfaced instead of returning CLI success', async () => {
  const server = dgram.createSocket('udp4')
  const port = await listen(server)
  const settings = settingsFile(port)
  const originalCreateSocket = dgram.createSocket
  const client = trackClientClose(originalCreateSocket)
  let request
  server.on('message', (message, remote) => {
    request = JSON.parse(message.toString())
    server.send(JSON.stringify({ accepted: false, error: "Couldn't find monitor!" }), remote.port, remote.address)
  })
  try {
    await assert.rejects(
      handleProcessedArgs(processArgs(['--udp', '--monitorid=missing-display', '--set=55']), null, settings.file),
      /Couldn't find monitor/,
    )
    assert.equal(request.type, 'set')
    assert.equal(request.data.monitor, 'missing-display')
    assert.equal(client.closeCount, 1)
  } finally {
    dgram.createSocket = originalCreateSocket
    if (client.socket && client.closeCount === 0) {
      try { client.socket.close() } catch (_) {}
    }
    await close(server)
    fs.rmSync(settings.root, { recursive: true, force: true })
  }
})

test('an unacknowledged mutation response fails closed and releases its socket', async () => {
  const server = dgram.createSocket('udp4')
  const port = await listen(server)
  const settings = settingsFile(port)
  const originalCreateSocket = dgram.createSocket
  const client = trackClientClose(originalCreateSocket)
  server.on('message', (message, remote) => {
    server.send('undefined', remote.port, remote.address)
  })
  try {
    await assert.rejects(
      handleProcessedArgs(processArgs(['--udp', '--monitorid=uid2353', '--set=55']), null, settings.file),
      /was not acknowledged/,
    )
    assert.equal(client.closeCount, 1)
  } finally {
    dgram.createSocket = originalCreateSocket
    if (client.socket && client.closeCount === 0) {
      try { client.socket.close() } catch (_) {}
    }
    await close(server)
    fs.rmSync(settings.root, { recursive: true, force: true })
  }
})

test('a valid VCP command reports a structured server rejection as failure', async () => {
  const server = dgram.createSocket('udp4')
  const port = await listen(server)
  const settings = settingsFile(port)
  const originalCreateSocket = dgram.createSocket
  const client = trackClientClose(originalCreateSocket)
  server.on('message', (message, remote) => {
    server.send(JSON.stringify({ accepted: false, error: 'Invalid VCP code!' }), remote.port, remote.address)
  })
  try {
    await assert.rejects(
      handleProcessedArgs(processArgs(['--udp', '--monitorid=uid2353', '--vcp=0xD6:5']), null, settings.file),
      /Invalid VCP code/,
    )
    assert.equal(client.closeCount, 1)
  } finally {
    dgram.createSocket = originalCreateSocket
    if (client.socket && client.closeCount === 0) {
      try { client.socket.close() } catch (_) {}
    }
    await close(server)
    fs.rmSync(settings.root, { recursive: true, force: true })
  }
})

test('monitor number lookup uses the primary inventory number and rejects an absent number', async () => {
  const server = dgram.createSocket('udp4')
  const port = await listen(server)
  const settings = settingsFile(port)
  const originalCreateSocket = dgram.createSocket
  const client = trackClientClose(originalCreateSocket)
  const requests = []
  server.on('message', (message, remote) => {
    const request = JSON.parse(message.toString())
    requests.push(request)
    server.send(JSON.stringify({ only: { num: 0 } }), remote.port, remote.address)
  })
  try {
    await assert.rejects(
      handleProcessedArgs(processArgs(['--udp', '--monitornum=2', '--set=55']), null, settings.file),
      /Monitor number 2 was not found/,
    )
    assert.deepEqual(requests.map(request => request.type), ['list'])
    assert.equal(client.closeCount, 1)
  } finally {
    dgram.createSocket = originalCreateSocket
    if (client.socket && client.closeCount === 0) {
      try { client.socket.close() } catch (_) {}
    }
    await close(server)
    fs.rmSync(settings.root, { recursive: true, force: true })
  }
})
