// Avoid hiding a just-opened tray flyout when a toast, taskbar animation or
// temporary foreground-window transition steals focus. No new timers run
// while the panel is closed; the user can still dismiss it by clicking away.
function createPopupFocusGuard({
  shouldClose,
  close,
  hasFocus,
  pointerOverPanel,
  clock = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  openingGraceMs = 550,
  blurDelayMs = 160,
}) {
  if (![shouldClose, close, hasFocus, pointerOverPanel].every(fn => typeof fn === 'function')) {
    throw TypeError('Popup focus guard requires its owner callbacks')
  }
  let shownAt = -Infinity
  let token = null
  let closed = false
  function clear() {
    if (token !== null) cancel(token)
    token = null
  }
  function scheduleCheck(ms) {
    clear()
    token = schedule(() => {
      token = null
      if (closed || !shouldClose() || hasFocus()) return
      // Keep a popup usable while the pointer is over its controls; Windows
      // notification toasts may temporarily take focus from Electron.
      if (pointerOverPanel()) {
        scheduleCheck(240)
        return
      }
      const remaining = openingGraceMs - (clock() - shownAt)
      if (remaining > 0) {
        scheduleCheck(Math.max(blurDelayMs, remaining))
        return
      }
      close()
    }, Math.max(1, ms))
  }
  return {
    opened() { if (closed) return; shownAt = clock(); clear() },
    focused() { clear() },
    blurred() {
      if (closed || !shouldClose()) return
      scheduleCheck(Math.max(blurDelayMs, openingGraceMs - (clock() - shownAt)))
    },
    hidden() { clear(); shownAt = -Infinity },
    dispose() { closed = true; clear() },
  }
}

module.exports = { createPopupFocusGuard }
