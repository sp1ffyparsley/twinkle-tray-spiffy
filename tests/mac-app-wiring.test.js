const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')

test('the macOS package reuses the existing React panel and presets without Windows binaries', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder.mac.json'), 'utf8'))
  const packageData = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(config.appId, packageData.build.appId)
  assert.equal(config.npmRebuild, false, 'Mac packaging must not compile Windows-only DDC native addons')
  assert.equal(config.extraMetadata.main, 'src/MacMain.js')
  assert.ok(config.files.includes('build/index.html'))
  assert.ok(config.files.includes('build/mac-settings.html'))
  assert.ok(config.files.includes('src/QuickPresets.js'))
  assert.ok(config.files.includes('src/MacBuiltInBackend.js'))
  assert.ok(config.files.includes('src/MacDisplayBackend.js'))
  assert.ok(config.files.includes('src/panel-preload.js'))
  assert.ok(config.files.includes('!node_modules/**'))
  assert.equal(config.mac.target[0].arch[0], 'arm64')
  assert.match(packageData.scripts['mac-build'], /parcel-build.*electron-builder/)
  assert.match(fs.readFileSync(path.join(root, 'src/MacMain.js'), 'utf8'), /build', 'index\.html'/)
})

test('macOS host loads the same flyout and calls only the Mac DDC backend', async () => {
  const code = fs.readFileSync(path.join(root, 'src/MacMain.js'), 'utf8')
  const { EventEmitter } = require('node:events')
  const slots = require('../src/QuickPresets')
  const actions = {}
  let tray
  let panel
  const backend = {
    available: true,
    refresh: async () => ({
      id1: {
        id: 'mac-ddc:00000000-0000-0000-0000-000000000001',
        key: 'id1', type: 'ddcci', brightnessType: 16,
        brightness: 50, hwid: ['mac-ddc', 'uuid1'],
      },
    }),
    snapshot: () => ({}),
    async setBrightness(id, level) {
      actions.lastBrightness = { id, level }
      return { id, level, confirmed: true }
    },
    close() {},
  }
  class WebContents extends EventEmitter {
    constructor() { super(); this.isLoading = () => false }
    send(event, value) { actions[event] = value }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler }
  }
  class Window extends EventEmitter {
    constructor() {
      super()
      this.webContents = new WebContents()
      this.shown = false
      this.width = 340; this.height = 250
      panel ??= this
    }
    isDestroyed() { return false }
    isVisible() { return this.shown }
    show() { this.shown = true }
    hide() { this.shown = false }
    focus() {}
    getSize() { return [this.width, this.height] }
    setSize(w, h) { this.width = w; this.height = h }
    setPosition() {}
    loadFile(file) { actions.loadedFile = file }
  }
  Window.fromWebContents = sender => sender === panel?.webContents ? panel : null
  class Tray extends EventEmitter {
    constructor() { super(); tray = this }
    getBounds() { return { x: 600, y: 25, width: 20, height: 20 } }
    setToolTip() {}
    popUpContextMenu() {}
    setContextMenu() { throw Error('Mac left click would be hijacked by a native menu') }
  }
  const ipcMain = {
    on(name, fn) { actions['event:' + name] = fn },
    handle(name, fn) { actions['invoke:' + name] = fn },
  }
  const app = new EventEmitter()
  app.requestSingleInstanceLock = () => true
  app.whenReady = () => Promise.resolve()
  app.getPath = () => '/fake/mac-user-data'
  app.quit = () => {}
  const mockedRequire = key => {
    if (key === 'electron') return {
      app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: x => x },
      nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
      ipcMain, screen: { getDisplayNearestPoint: () => ({
        workArea: { x: 0, y: 0, width: 1600, height: 900 },
      }) }, dialog: {},
    }
    if (key === 'node:fs') return {
      existsSync: () => false, mkdirSync() {}, writeFileSync() {}, renameSync() {},
    }
    if (key === 'node:path') return require('node:path')
    if (key === './MacDisplayBackend') return { MacDisplayBackend: class { constructor() { return backend } } }
    if (key === './QuickPresets') return slots
    if (key === './localization/en.json') return { GENERIC_ALL_DISPLAYS: 'All Displays' }
    throw Error('Unexpected Mac dependency ' + key)
  }
  const context = vm.createContext({
    require: mockedRequire, process: { platform: 'darwin', arch: 'arm64' },
    __dirname: path.join(root, 'src'), setTimeout,
  })
  vm.runInContext(code, context)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(panel)
  assert.ok(actions.loadedFile.endsWith(path.join('build', 'index.html')))
  assert.equal(typeof actions['invoke:quick-presets-apply'], 'function')
  assert.equal(typeof actions['event:update-brightness'], 'function')
  tray.emit('click')
  assert.ok(panel.shown)
  assert.equal(tray.listenerCount('right-click'), 1)
  const presets = actions['invoke:quick-presets-list']({ sender: panel.webContents })
  assert.equal(presets.length, 5)
  const result = await actions['invoke:quick-presets-apply']({ sender: panel.webContents }, 1)
  assert.equal(result.brightnessAccepted, 1)
  assert.equal(actions.lastBrightness.level, 100)
  assert.equal(typeof actions['invoke:night-filter-display-set'], 'function')
  assert.throws(() => actions['invoke:night-filter-display-set']({ sender: panel.webContents }),
    /qualified native macOS color backend/)
})
