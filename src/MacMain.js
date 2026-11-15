// Spiffy Mac menu-bar host. This loads the SAME React brightness panel and
// five-slot preset component as Windows; only the hardware backend differs.
// No extra app/daemon, private display framework, system-wide gamma mutation,
// startup brightness replay, or Windows-only native module is loaded.
//
// Hardware brightness is supported for positively identified built-in
// displays with nriley/brightness and external Apple Silicon DDC/CI displays
// with m1ddc. Intel external DDC, unsupported cables, below-minimum dimming
// and per-display warmth remain unavailable until a qualified native owner
// exists. No unsupported capability is simulated or silently replayed.
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { MacDisplayBackend } = require('./MacDisplayBackend')
const QuickPresets = require('./QuickPresets')

if (process.platform !== 'darwin') throw Error('MacMain must only be used on macOS')

const defaults = Object.freeze({
  isDev: false, isSpiffy: true, isMac: true, isWin11: false, spiffyAdvancedAvailable: false,
  useNativeAnimation: false, useAcrylic: false, enableSunValley: false,
  theme: 'dark', sleepAction: 'none', openAtLogin: false, scrollFlyoutAmount: 3,
  updateInterval: 100, linkedLevelsActive: false,
  names: {}, hideDisplays: {}, monitorFeatures: {}, monitorFeaturesSettings: {},
  extendedBrightness: {}, extendedBrightnessRecovery: {},
  quickPresets: QuickPresets.normalizePresets(),
})

let panel = null
let preferences = null
let tray = null
let settings = null
let backend = null
let monitors = {}
let lastRefresh = 0
let refreshPromise = null
let requestedHeight = 0

function configPath() { return path.join(app.getPath('userData'), 'settings.json') }
function loadSettings() {
  let stored = {}
  try {
    const file = configPath()
    if (fs.existsSync(file) && fs.statSync(file).size <= 256 * 1024) {
      const read = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (read && typeof read === 'object' && !Array.isArray(read)) stored = read
    }
  } catch (_) { /* Corrupt config is never replayed into hardware. */ }
  return { ...defaults, ...stored,
    isSpiffy: true, isMac: true, isWin11: false, spiffyAdvancedAvailable: false,
    quickPresets: QuickPresets.normalizePresets(stored.quickPresets),
  }
}
function persistSettings() {
  const target = configPath()
  const temporary = target + '.new'
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8', flag: 'w' })
  fs.renameSync(temporary, target)
}
function send(event, value, to = null) {
  for (const window of (to ? [to] : [panel, preferences])) {
    if (window && !window.isDestroyed() && !window.webContents.isLoading()) {
      window.webContents.send(event, value)
    }
  }
}
function localization() {
  const en = require('./localization/en.json')
  return { desired: en, default: en }
}
function sendState(window) {
  send('settings-updated', settings, window)
  send('monitors-updated', monitors, window)
  send('localization-updated', localization(), window)
  send('isRefreshing', Boolean(refreshPromise), window)
  send('display-mode', 'normal', window)
  send('theme-settings', {
    SystemUsesLightTheme: 0, EnableTransparency: 0, UseAcrylic: 0,
    ColorPrevalence: 0,
  }, window)
  send('update-colors', {
    accent: { hex: '#E45F35' }, lighter: '#FFD3BC', light: '#FCA47A',
    medium: '#EA7B51', mediumDark: '#B74A26', transparent: '#E45F3530',
    dark: '#94351D', accentDark1: { hex: '#94351D' },
    accentDark2: { hex: '#662311' }, accentDark3: { hex: '#46170C' },
    accentLight1: { hex: '#FFD3BC' }, accentLight2: { hex: '#FCA47A' },
    accentLight3: { hex: '#EA7B51' },
  }, window)
}
function refreshMonitors(force = false) {
  if (refreshPromise) return refreshPromise
  if (!force && Date.now() - lastRefresh < 8000) return Promise.resolve(monitors)
  refreshPromise = (async () => {
    if (!backend.available) {
      monitors = {}
      return monitors
    }
    try {
      monitors = await backend.refresh()
      lastRefresh = Date.now()
      return monitors
    } catch (_) {
      // Do not keep old DDC identities after a failed topology update.
      monitors = {}
      return monitors
    } finally {
      refreshPromise = null
      send('monitors-updated', monitors)
      send('isRefreshing', false)
    }
  })()
  return refreshPromise
}

function positionPanel() {
  if (!panel || !tray) return
  const icon = tray.getBounds()
  const nearest = screen.getDisplayNearestPoint({ x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 })
  const bounds = nearest.workArea
  const [width, height] = panel.getSize()
  const x = Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, Math.round(icon.x + icon.width / 2 - width / 2)))
  const y = Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, Math.round(icon.y + icon.height + 5)))
  panel.setPosition(x, y, false)
}
function showPanel() {
  if (!panel) return
  if (panel.isVisible()) { panel.hide(); return }
  positionPanel()
  panel.show()
  sendState(panel)
  send('tray-clicked', null, panel)
  refreshMonitors().catch(() => {})
}
function showPreferences() {
  if (!preferences) {
    preferences = new BrowserWindow({
      width: 530, height: 650, minWidth: 450, minHeight: 410,
      show: false, title: 'Spiffy Presets',
      webPreferences: {
        preload: path.join(__dirname, 'settings-preload.js'),
        nodeIntegration: false, contextIsolation: false, sandbox: false,
        webSecurity: true,
      },
    })
    preferences.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    preferences.webContents.on('will-navigate', event => event.preventDefault())
    preferences.loadFile(path.join(__dirname, '..', 'build', 'mac-settings.html'))
    preferences.webContents.once('did-finish-load', () => sendState(preferences))
    preferences.on('closed', () => { preferences = null })
  }
  preferences.show()
  preferences.focus()
}
function trayMenu() {
  return Menu.buildFromTemplate([
    ...QuickPresets.normalizePresets(settings.quickPresets).map(preset => ({
      label: (preset.icon ? preset.icon + ' ' : '') + preset.name,
      click: () => applyPreset(preset.slot).catch(() => {}),
    })),
    { type: 'separator' },
    { label: 'Presets & Settings', click: showPreferences },
    { label: 'Refresh Displays', click: () => refreshMonitors(true).catch(() => {}) },
    { type: 'separator' },
    { label: 'Quit Spiffy', click: () => app.quit() },
  ])
}
async function applyPreset(slot) {
  if (!Number.isInteger(slot) || slot < 1 || slot > 5) throw Error('Invalid quick preset')
  const preset = QuickPresets.normalizePresets(settings.quickPresets)[slot - 1]
  const result = QuickPresets.resolvePreset(preset, monitors)
  let changed = 0
  const skipped = [...result.skipped]
  for (const item of result.planned) {
    if (item.brightness < 0 || item.brightness > 100) {
      skipped.push(item.monitor.id)
      continue
    }
    try {
      await backend.setBrightness(item.monitor.id, item.brightness)
      changed++
    } catch (_) {
      skipped.push(item.monitor.id)
    }
  }
  monitors = backend.snapshot()
  send('monitors-updated', monitors)
  const warmthUnsupported = result.planned.some(item => (item.warmth ?? 0) > 0)
  return {
    ok: changed > 0 && !skipped.length,
    status: changed > 0
      ? (warmthUnsupported ? 'brightness_only_warmth_unsupported' : 'brightness_confirmed')
      : 'unavailable',
    brightnessAccepted: changed,
    warmthApplied: 0,
    // No Mac color-temperature backend is present. Do not claim to have
    // adjusted individual monitor warmth by accepting a brightness preset.
    warmthUnsupported,
    skipped,
  }
}
function savePresets(slots) {
  settings.quickPresets = QuickPresets.normalizePresets(slots)
  persistSettings()
  send('quick-presets-updated', settings.quickPresets)
  return settings.quickPresets
}
function requireWindow(event) {
  if (!panel || (event.sender !== panel.webContents && event.sender !== preferences?.webContents)) {
    throw Error('Only a Spiffy application window may control displays')
  }
}

function registerIPC() {
  ipcMain.on('request-monitors', event => {
    requireWindow(event)
    send('monitors-updated', monitors, BrowserWindow.fromWebContents(event.sender))
    refreshMonitors().catch(() => {})
  })
  ipcMain.on('full-refresh', event => {
    requireWindow(event)
    refreshMonitors(true).catch(() => {})
  })
  ipcMain.on('request-settings', event => {
    requireWindow(event)
    send('settings-updated', settings, BrowserWindow.fromWebContents(event.sender))
  })
  ipcMain.on('request-localization', event => {
    requireWindow(event)
    send('localization-updated', localization(), BrowserWindow.fromWebContents(event.sender))
  })
  ipcMain.on('request-colors', event => {
    requireWindow(event)
    sendState(BrowserWindow.fromWebContents(event.sender))
  })
  ipcMain.on('get-refreshing', event => { requireWindow(event); send('isRefreshing', Boolean(refreshPromise), panel) })
  ipcMain.on('get-mica-wallpaper', event => { requireWindow(event); send('mica-wallpaper', null, panel) })
  ipcMain.on('pause-updates', event => { requireWindow(event) })
  ipcMain.on('blur-panel', event => { requireWindow(event); panel.hide() })
  ipcMain.on('panel-hidden', event => { requireWindow(event); panel.hide() })
  ipcMain.on('open-settings', event => { requireWindow(event); showPreferences() })
  ipcMain.on('panel-height', (event, height) => {
    requireWindow(event)
    if (!Number.isFinite(height) || height < 80 || height > 850 || Math.abs(requestedHeight - height) < 4) return
    requestedHeight = Math.round(height)
    panel.setSize(panel.getSize()[0], requestedHeight, false)
    positionPanel()
  })
  ipcMain.on('send-settings', (event, info) => {
    requireWindow(event)
    const patch = info && info.newSettings
    if (!patch || typeof patch !== 'object') return
    if (typeof patch.linkedLevelsActive === 'boolean') settings.linkedLevelsActive = patch.linkedLevelsActive
    if (patch.names && typeof patch.names === 'object' && !Array.isArray(patch.names)) {
      settings.names = Object.fromEntries(Object.entries(patch.names)
        .filter(([id, name]) => id.length < 130 && typeof name === 'string' && name.length <= 120))
    }
    persistSettings()
    send('settings-updated', settings)
  })
  ipcMain.on('update-brightness', (event, request) => {
    requireWindow(event)
    const id = request && request.index
    const level = request && request.level
    backend.setBrightness(id, level).then(() => {
      monitors = backend.snapshot()
      send('monitors-updated', monitors)
    }).catch(error => send('extended-brightness-status', {
      id, pending: false, error: error.message,
    }, panel))
  })
  ipcMain.handle('quick-presets-list', event => {
    requireWindow(event)
    return QuickPresets.normalizePresets(settings.quickPresets)
  })
  ipcMain.handle('quick-presets-save', (event, slot, value) => {
    requireWindow(event)
    const items = QuickPresets.normalizePresets(settings.quickPresets)
    items[slot - 1] = QuickPresets.validatePreset(value, slot)
    return savePresets(items)
  })
  ipcMain.handle('quick-presets-capture', async (event, slot) => {
    requireWindow(event)
    const current = QuickPresets.normalizePresets(settings.quickPresets)[slot - 1]
    const preset = QuickPresets.capturePreset(slot, current, monitors, { targets: [] })
    const items = QuickPresets.normalizePresets(settings.quickPresets)
    items[slot - 1] = preset
    return { preset, slots: savePresets(items) }
  })
  ipcMain.handle('quick-presets-apply', (event, slot) => {
    requireWindow(event)
    return applyPreset(slot)
  })
  ipcMain.handle('quick-presets-export', async event => {
    requireWindow(event)
    const options = await dialog.showSaveDialog(preferences || panel, {
      defaultPath: 'Spiffy-Display-Presets.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (options.canceled || !options.filePath) return { saved: false }
    fs.writeFileSync(options.filePath, QuickPresets.exportPresets(settings.quickPresets), { flag: 'wx' })
    return { saved: true }
  })
  ipcMain.handle('quick-presets-import', async event => {
    requireWindow(event)
    const options = await dialog.showOpenDialog(preferences || panel, {
      properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (options.canceled || options.filePaths.length !== 1) return { imported: false }
    const file = options.filePaths[0]
    if (fs.statSync(file).size > 64 * 1024) throw Error('Preset file is too large')
    return { imported: true, slots: savePresets(QuickPresets.importPresets(fs.readFileSync(file, 'utf8'))) }
  })
  ipcMain.handle('night-filter-display-status', event => {
    requireWindow(event)
    return { available: false, targets: [] }
  })
  ipcMain.handle('night-filter-display-set', event => {
    requireWindow(event)
    throw Error('Independent monitor warmth needs a qualified native macOS color backend')
  })
  ipcMain.handle('night-filter-status', event => {
    requireWindow(event)
    return { available: false, enabled: false }
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(() => {
    settings = loadSettings()
    backend = new MacDisplayBackend()
    registerIPC()
    panel = new BrowserWindow({
      width: 340, height: 250, show: false,
      frame: false, resizable: false, skipTaskbar: true,
      alwaysOnTop: true, backgroundColor: '#1d1f24',
      webPreferences: {
        preload: path.join(__dirname, 'panel-preload.js'),
        nodeIntegration: false, contextIsolation: false, sandbox: false,
        webSecurity: true,
      },
    })
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    panel.webContents.on('will-navigate', event => event.preventDefault())
    panel.on('blur', () => panel.hide())
    panel.loadFile(path.join(__dirname, '..', 'build', 'index.html'))
    panel.webContents.once('did-finish-load', () => sendState(panel))
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'logo.png'))
    tray = new Tray(icon.resize({ width: 17, height: 17 }))
    tray.setToolTip('Spiffy')
    tray.on('click', showPanel)
    tray.on('right-click', () => tray.popUpContextMenu(trayMenu()))
    // Setting an attached menu on macOS makes left-click open the menu rather
    // than our shared React brightness flyout. Right-click owns the menu.
    refreshMonitors(true).catch(() => {})
  })
  app.on('second-instance', () => { if (panel) showPanel() })
  app.on('before-quit', () => { if (backend) backend.close() })
  app.on('window-all-closed', () => { /* Menu-bar app stays running. */ })
}
