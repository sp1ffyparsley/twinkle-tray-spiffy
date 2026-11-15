// Never assume DDC/CI ids, monitor names, ordinal numbers or primary status
// correspond to Win32 Magnification display identities. Resolve by the exact
// current pixel rectangle; ambiguous or stale geometry fails closed.
function matchMonitorWarmthTarget(monitor, targets) {
  const bounds = monitor && monitor.bounds
  const position = bounds && bounds.position
  if (!position || !Number.isInteger(position.x) || !Number.isInteger(position.y) ||
      !Number.isInteger(bounds.width) || !Number.isInteger(bounds.height) ||
      bounds.width <= 0 || bounds.height <= 0) return null
  if (!Array.isArray(targets)) return null
  const rect = [position.x, position.y, bounds.width, bounds.height]
  const matches = targets.filter(target => target &&
    target.id && target.id !== 'all' &&
    Array.isArray(target.geometry) && target.geometry.length === 4 &&
    target.geometry.every((value, index) => value === rect[index]))
  return matches.length === 1 ? matches[0] : null
}

module.exports = { matchMonitorWarmthTarget }
