import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import Slider from "./Slider";
import NightFilterControl from './NightFilterControl';
import QuickPresetStrip from './QuickPresetStrip';
const { matchMonitorWarmthTarget } = require('../MonitorWarmthMapping')
import DDCCISliders from "./DDCCISliders"
import HDRSliders from "./HDRSliders";
import TranslateReact from "../TranslateReact"
import getMonitorName from "../utils/BrightnessPanel/getMonitorName";
import { clearOwnedInterval, replaceOwnedInterval, sendHeightIfChanged } from "../utils/BrightnessPanel/panelLifecycle";

const BrightnessPanel = memo(function BrightnessPanel() {

  const [state, setState] = useState({
    monitors: [],
    linkedLevelsActive: false,
    names: {},
    update: false,
    sleeping: false,
    updateProgress: 0,
    isRefreshing: window.isRefreshing
  })
  const [doBackgroundEvent, setDoBackgroundEvent] = useState(false)
  const [levelsChanged, setLevelsChanged] = useState(false)
  const [init, setInit] = useState(false)
  const [lastLevels, setLastLevels] = useState([])
  const [brightnessStatus, setBrightnessStatus] = useState(Object.values(window.settings?.extendedBrightnessRecovery || {}).some(Boolean) ? { error: 'An interrupted brightness change needs recovery. Use Reset extra brightness; the change was not replayed.' } : {})
  const [warmthStatus, setWarmthStatus] = useState({ targets: [] })
  const [warmthDraft, setWarmthDraft] = useState({})
  const [warmthError, setWarmthError] = useState('')
  const warmthTimers = useRef(new Map())
  const warmthRevision = useRef(new Map())
  const [T] = useState(new TranslateReact({}, {}))

  const numMonitors = useMemo(() => {
    let localNumMonitors = 0
    for (let key in state.monitors) {
      if ((state.monitors[key].type != "none" || state.monitors[key].hdr === "active") && !(window.settings?.hideDisplays?.[key] === true)) localNumMonitors++;
    }
    return localNumMonitors
  }, [state.monitors])

  const updateInterval = useRef(null)
  const panelHeight = useRef(-1)

  // A single status read/subscription supplies BOTH per-monitor controls,
  // instead of spawning a process or background poll for each slider.
  useEffect(() => {
    let mounted = true
    const control = window.nightFilterDisplays
    if (!control) return undefined
    const refresh = () => {
      control.status().then(status => {
        if (mounted) { setWarmthStatus(status); setWarmthError('') }
      }).catch(error => {
        if (!mounted) return
        const unavailable = /adapter is missing|runtime is unavailable|python runtime|Night Filter helper is missing/i.test(String(error.message))
        if (!unavailable) setWarmthError(error.message || 'Night warmth unavailable')
      })
    }
    const unsubscribe = control.subscribe(status => { if (mounted) setWarmthStatus(status) })
    const onVisibility = () => { if (!document.hidden) refresh() }
    document.addEventListener('visibilitychange', onVisibility)
    refresh()
    return () => {
      mounted = false
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
      for (const timer of warmthTimers.current.values()) clearTimeout(timer)
      warmthTimers.current.clear()
    }
  }, [])

  const changeWarmth = (targetId, strength) => {
    const level = Math.max(0, Math.min(100, Math.round(strength)))
    const version = (warmthRevision.current.get(targetId) || 0) + 1
    warmthRevision.current.set(targetId, version)
    setWarmthDraft(previous => ({ ...previous, [targetId]: level }))
    setWarmthError('')
    clearTimeout(warmthTimers.current.get(targetId))
    warmthTimers.current.set(targetId, setTimeout(() => {
      warmthTimers.current.delete(targetId)
      window.nightFilterDisplays.set({ target_id: targetId, strength: level }).then(status => {
        setWarmthStatus(status)
        if (warmthRevision.current.get(targetId) === version) {
          setWarmthDraft(previous => {
            const next = { ...previous }
            delete next[targetId]
            return next
          })
        }
      }).catch(error => {
        if (warmthRevision.current.get(targetId) === version) {
          setWarmthDraft(previous => {
            const next = { ...previous }
            delete next[targetId]
            return next
          })
          setWarmthError(error.message || 'Warmth could not be confirmed')
        }
      })
    }, 150))
  }

  // Enable/Disable linked levels
  const toggleLinkedLevels = () => {
    const linkedLevelsActive = (state.linkedLevelsActive ? false : true)
    setState(prev => ({ ...prev, linkedLevelsActive }))
    window.sendSettings({
      linkedLevelsActive
    })
  }

  // Handle <Slider> changes
  const handleChange = (level, slider) => {
    const monitors = { ...state.monitors }
    const sliderMonitor = monitors[slider.props.hwid]
    if (numMonitors && state.linkedLevelsActive) {
      // Update all monitors (linked)
      for (let key in monitors) {
        const monitor = monitors[key]
        monitor.brightness = level
      }
      setState(prev => ({ ...prev, monitors }))
      setLevelsChanged(false)
      for (const monitor of Object.values(monitors)) {
        if (monitor.type !== 'none') window.updateBrightness(monitor.id, level)
      }
    } else if (numMonitors > 0) {
      // Update single monitor
      if (sliderMonitor) sliderMonitor.brightness = level;
      setState(prev => ({ ...prev, monitors }))
      setLevelsChanged(false)
      if (sliderMonitor) window.updateBrightness(sliderMonitor.id, level)
    }
    window.pauseMonitorUpdates()
  }

  // Update monitor info
  const recievedMonitors = (e) => {
    let newMonitors = { ...e.detail }
    for (const key in newMonitors) {
      const monitor = newMonitors[key]
      const extended = window.settings.extendedBrightness?.[monitor.id]
      if (Number.isInteger(extended) && !window.settings.extendedBrightnessRecovery?.[monitor.id]) newMonitors[key] = { ...monitor, brightness: extended }
    }
    setLastLevels([])
    // Reset panel height so it's recalculated
    panelHeight.current = -1
    setState(prev => ({
      ...prev,
      monitors: newMonitors
    }))
    // Delay initial adjustments
    if (!init) setTimeout(() => { setInit(true) }, 333)
  }

  const updateMinMax = (inMonitors = false) => {
    if (numMonitors > 0) {
      let newMonitors = Object.assign((inMonitors ? inMonitors : state.monitors), {})
      for (let key in newMonitors) {
        for (let remap in state.remaps) {
          if (newMonitors[key].name == remap) {
            newMonitors[key].min = state.remaps[remap].min
            newMonitors[key].max = state.remaps[remap].max
          }
        }
      }
      setLevelsChanged(true)
      if (inMonitors) {
        return inMonitors
      } else {
        setState(prev => ({
          ...prev,
          monitors: newMonitors
        }))
        setDoBackgroundEvent(true)
      }
    }
  }

  // Update settings
  const recievedSettings = (e) => {
    const settings = e.detail
    const linkedLevelsActive = (settings.linkedLevelsActive ?? false)
    const sleepAction = (settings.sleepAction ?? "none")
    const updateInterval = (settings.updateInterval || 500) * 1
    const remaps = (settings.remaps || {})
    const names = (settings.names || {})
    setLevelsChanged(true)
    setState(prev => ({
      ...prev,
      linkedLevelsActive,
      remaps,
      names,
      updateInterval,
      sleepAction
    }))
    resetBrightnessInterval()
    updateMinMax()
    setDoBackgroundEvent(true)
  }

  const recievedUpdate = (e) => {
    const update = e.detail
    setState(prev => ({ ...prev, update }))
  }

  const recievedSleep = (e) => {
    setState(prev => ({ ...prev, sleeping: e.detail }))
  }



  // Send new brightness to monitors, if changed
  const syncBrightness = () => {
    const monitors = state.monitors
    if (init && levelsChanged && (window.showPanel || doBackgroundEvent) && numMonitors) {
      setDoBackgroundEvent(false)
      setLevelsChanged(false)
      try {
        for (let idx in monitors) {
          if (monitors[idx].type != "none" && monitors[idx].brightness != lastLevels[idx]) {
            window.updateBrightness(monitors[idx].id, monitors[idx].brightness)
          }
        }
      } catch (e) {
        console.error("Could not update brightness")
      }
    }
  }

  const resetBrightnessInterval = () => {
    replaceOwnedInterval(updateInterval, () => syncBrightness(), (state.updateInterval || 500))
  }

  const handleIsRefreshingUpdate = (e) => setState(prev => ({ ...prev, isRefreshing: e.detail }))
  const handleUpdateProgress = (e) => setState(prev => ({ ...prev, updateProgress: e.detail.progress }))

  useEffect(() => {
    const listener = event => {
      const status = event.detail
      setBrightnessStatus(status)
      if (!status.error && Number.isInteger(status.level)) {
        setState(previous => ({ ...previous, monitors: Object.fromEntries(Object.entries(previous.monitors)
          .map(([key, monitor]) => [key, monitor.id === status.id ? { ...monitor, brightness: status.level } : monitor])) }))
      }
    }
    window.addEventListener('extendedBrightnessUpdated', listener)
    return () => window.removeEventListener('extendedBrightnessUpdated', listener)
  }, [])

  useEffect(() => {
    resetBrightnessInterval()
    return () => clearOwnedInterval(updateInterval)
  }, [state.monitors, numMonitors, doBackgroundEvent, levelsChanged, init])


  useEffect(() => {
    const onMonitorsUpdated = e => recievedMonitors(e)
    const onSettingsUpdated = e => recievedSettings(e)
    const onLocalizationUpdated = e => T.setLocalizationData(e.detail.desired, e.detail.default)
    const onUpdateUpdated = e => recievedUpdate(e)
    const onSleepUpdated = e => recievedSleep(e)
    const onIsRefreshing = e => handleIsRefreshingUpdate(e)
    const onUpdateProgress = e => handleUpdateProgress(e)

    window.addEventListener("monitorsUpdated", onMonitorsUpdated)
    window.addEventListener("settingsUpdated", onSettingsUpdated)
    window.addEventListener("localizationUpdated", onLocalizationUpdated)
    window.addEventListener("updateUpdated", onUpdateUpdated)
    window.addEventListener("sleepUpdated", onSleepUpdated)
    window.addEventListener("isRefreshing", onIsRefreshing)

    if (window.isAppX === false) {
      window.addEventListener("updateProgress", onUpdateProgress)
    }

    // Update brightness every interval, if changed
    window.requestSettings()
    window.requestMonitors()
    window.ipc.send('request-localization')
    window.reactReady = true

    return () => {
      window.removeEventListener("monitorsUpdated", onMonitorsUpdated)
      window.removeEventListener("settingsUpdated", onSettingsUpdated)
      window.removeEventListener("localizationUpdated", onLocalizationUpdated)
      window.removeEventListener("updateUpdated", onUpdateUpdated)
      window.removeEventListener("sleepUpdated", onSleepUpdated)
      window.removeEventListener("isRefreshing", onIsRefreshing)
      window.removeEventListener("updateProgress", onUpdateProgress)
    }
  }, [])

  useEffect(() => {
    const panel = window.document.getElementById("panel")
    if (panel) sendHeightIfChanged(panelHeight, panel.offsetHeight, height => window.sendHeight(height))
  })

  const getMonitors = () => {
    if (!state.monitors || numMonitors == 0) {
      if (state.isRefreshing) {
        return (<div className="no-displays-message" style={{ textAlign: "center", paddingBottom: "15px" }}>{T.t("GENERIC_DETECTING_DISPLAYS")}</div>)
      }
      return (<div className="no-displays-message">{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}</div>)
    } else {
      if (state.linkedLevelsActive) {
        // Combine all monitors
        let lastValidMonitor
        for(const key in state.monitors) {
          const monitor = state.monitors[key]
          if(monitor.type == "wmi" || monitor.type == "studio-display" || (monitor.type == "ddcci" && monitor.brightnessType) || monitor.hdr === "active") {
           lastValidMonitor = monitor 
          }
        }
        if (lastValidMonitor) {
          const monitor = lastValidMonitor
          return (
            <div className="monitor-sliders linked" key={monitor.key}>
              <Slider name={T.t("GENERIC_ALL_DISPLAYS")} id={monitor.id} level={monitor.brightness} min={!window.settings?.spiffyAdvancedAvailable || Object.values(state.monitors).some(m => m.hdr === 'active') ? 0 : -100} max={!window.settings?.spiffyAdvancedAvailable || Object.values(state.monitors).some(m => m.hdr === 'active') ? 100 : 200} zeroCentered num={monitor.num} monitortype={monitor.type} hwid={monitor.key} onChange={handleChange} scrollAmount={window.settings?.scrollFlyoutAmount} />
              {Object.values(state.monitors).filter(m =>
                (m.type !== 'none' || m.hdr === 'active') &&
                !window.settings?.hideDisplays?.[m.key] &&
                matchMonitorWarmthTarget(m, warmthStatus?.targets)
              ).map(m => (
                <div className="monitor-warmth-linked" key={m.key}>
                  <div className="monitor-warmth-monitor-name">{getMonitorName(m, state.names)}</div>
                  {!window.settings?.isMac && <NightFilterControl monitor={m} label={getMonitorName(m, state.names)} status={warmthStatus} draft={warmthDraft} onChange={changeWarmth} />}
                </div>
              ))}
            </div>
          )
        }
        return (<div className="no-displays-message">{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}</div>)
      } else {
        // Show all valid monitors individually
        const sorted = Object.values(state.monitors).slice(0).sort((a, b) => {
          const aSort = (a.order === undefined ? 999 : a.order * 1)
          const bSort = (b.order === undefined ? 999 : b.order * 1)
          return aSort - bSort
        })
        let useFeatures = false
        // Check if we should use the extended DDC/CI layout or simple layout
        for (const { hwid } of sorted) {
          const monitorFeatures = window.settings?.monitorFeatures?.[hwid[1]]
          for (const vcp in monitorFeatures) {
            if (vcp == "0x10" || vcp == "0x13" || vcp == "0xD6") {
              continue; // Skip if brightness or power state
            }
            const feature = monitorFeatures[vcp]
            if (feature) {
              // Feature is active
              // Now we check if there are any settings active for the feature
              const featureSettings = window.settings.monitorFeaturesSettings?.[hwid[1]]
              if (!(featureSettings?.[vcp]?.linked)) {
                // Isn't linked
                useFeatures = true
              }
            }
          }
        }

        return sorted.map((monitor) => {
          if ((monitor.type == "none" && monitor.hdr !== "active") || window.settings?.hideDisplays?.[monitor.key] === true) {
            return (<div key={monitor.key}></div>)
          } else {
            if (monitor.type == "wmi" || monitor.type == "studio-display" || (monitor.type == "ddcci" && monitor.brightnessType) || monitor.hdr === "active") {

              let hasFeatures = true
              let featureCount = 0
              const monitorFeatures = window.settings?.monitorFeatures?.[monitor.hwid[1]]
              const features = ["0x12", "0xD6", "0x62"]
              if (monitor.features) {
                features.forEach(f => {
                  // Check monitor features
                  if (monitor.features[f] && monitor.features[f].length > 1) {
                    // Check that user has enabled feature
                    if (monitorFeatures && monitorFeatures[f]) {
                      // Track feature
                      hasFeatures = true
                      featureCount++
                    }
                  }
                })
              }
              let showHDRSliders = false
              if((monitor.hdr === "active" || window.settings?.hdrDisplays?.[monitor.key]) && !(window.settings?.sdrAsMainSliderDisplays?.[monitor.key])) {
                // Has HDR slider enabled
                hasFeatures = true
                useFeatures = true
                showHDRSliders = true
              }
              const powerOff = () => {
                window.ipc.send("sleep-display", monitor.hwid.join("#"))
                monitor.features["0xD6"][0] = (monitor.features["0xD6"][0] >= 4 ? 1 : settings.ddcPowerOffValue)
              }
              const showPowerButton = () => {
                const customFeatureEnabled = window.settings?.monitorFeaturesSettings?.[monitor?.hwid[1]]?.["0xD6"]
                if (monitorFeatures?.["0xD6"] && (monitor.features?.["0xD6"] || customFeatureEnabled)) {
                  return (<div className="feature-power-icon simple" onClick={powerOff}><span className="icon vfix">&#xE7E8;</span><span>{(monitor.features?.["0xD6"][0] >= 4 ? T.t("PANEL_LABEL_TURN_ON") : T.t("PANEL_LABEL_TURN_OFF"))}</span></div>)
                }
              }

              // Check if it's an HDR display and only supports SDR brightness adjustment.
              const isHDROnlySDR = (monitor.hdr === "active" || monitor.hdr === "supported") && monitor.type === "none";
              
              if (!useFeatures || !hasFeatures) {
                // For HDR displays that only support SDR, the HDR slider is displayed directly instead of the regular brightness slider.
                if (isHDROnlySDR) {
                  return (
                    <div className="monitor-sliders extended" key={monitor.key}>
                      <div className="monitor-item" style={{ height: "auto", paddingBottom: "18px" }}>
                        <div className="name-row">
                          <div className="icon"><span>&#xE7F4;</span></div>
                          <div className="title">{getMonitorName(monitor, state.names)}</div>
                          { showPowerButton() }
                        </div>
                      </div>
                      <HDRSliders monitor={monitor} scrollAmount={window.settings?.scrollFlyoutAmount} />
                      {!window.settings?.isMac && <NightFilterControl monitor={monitor} label={getMonitorName(monitor, state.names)} status={warmthStatus} draft={warmthDraft} onChange={changeWarmth} />}
                    </div>
                  )
                }
                return (
                  <div className="monitor-sliders" key={monitor.key}>
                    <Slider name={getMonitorName(monitor, state.names)} id={monitor.id} level={monitor.brightness} min={monitor.hdr === 'active' || !window.settings?.spiffyAdvancedAvailable ? 0 : -100} max={monitor.hdr === 'active' || !window.settings?.spiffyAdvancedAvailable ? 100 : 200} zeroCentered num={monitor.num} monitortype={monitor.type} hwid={monitor.key} key={monitor.key} onChange={handleChange} afterName={showPowerButton()} scrollAmount={window.settings?.scrollFlyoutAmount} />
                    {!window.settings?.isMac && <NightFilterControl monitor={monitor} label={getMonitorName(monitor, state.names)} status={warmthStatus} draft={warmthDraft} onChange={changeWarmth} />}
                  </div>
                )
              } else {
                return (
                  <div className="monitor-sliders extended" key={monitor.key}>
                    <div className="monitor-item" style={{ height: "auto", paddingBottom: "18px" }}>
                      <div className="name-row">
                        <div className="icon">{(monitor.type == "wmi" ? <span>&#xE770;</span> : <span>&#xE7F4;</span>)}</div>
                        <div className="title">{getMonitorName(monitor, state.names)}</div>
                        {showPowerButton()}
                      </div>
                    </div>
                    {/* For HDR displays that only support SDR, hide the regular brightness slider. */}
                    { !isHDROnlySDR && (
                      <div className="feature-row feature-brightness">
                        <div className="feature-icon"><span className="icon vfix">&#xE706;</span></div>
                        <Slider id={monitor.id} level={monitor.brightness} min={monitor.hdr === 'active' || !window.settings?.spiffyAdvancedAvailable ? 0 : -100} max={monitor.hdr === 'active' || !window.settings?.spiffyAdvancedAvailable ? 100 : 200} zeroCentered num={monitor.num} monitortype={monitor.type} hwid={monitor.key} key={monitor.key} onChange={handleChange} scrollAmount={window.settings?.scrollFlyoutAmount} />
                      </div>
                    )}
                    <DDCCISliders monitor={monitor} monitorFeatures={monitorFeatures} scrollAmount={window.settings?.scrollFlyoutAmount} />
                    {showHDRSliders ? <HDRSliders monitor={monitor} scrollAmount={window.settings?.scrollFlyoutAmount} /> : null}
                    {!window.settings?.isMac && <NightFilterControl monitor={monitor} label={getMonitorName(monitor, state.names)} status={warmthStatus} draft={warmthDraft} onChange={changeWarmth} />}
                  </div>
                )
              }
            }
          }
        })
      }
    }
  }

  return (
    <div className="window-base" data-theme={window.settings.theme || "default"} id="panel" data-refreshing={state.isRefreshing}>
      <div className="titlebar">
        <div className="title" aria-label={T.t("PANEL_TITLE")}></div>
        <div className="icons">
          {
            numMonitors > 1 &&
            <div
              aria-label={T.t("PANEL_BUTTON_LINK_LEVELS")}
              data-active={state.linkedLevelsActive}
              onClick={toggleLinkedLevels}
              className="link">
              &#xE71B;
            </div>
          }
          {
            window.settings.sleepAction !== "none" &&
            <div
              aria-label={T.t("PANEL_BUTTON_TURN_OFF_DISPLAYS")}
              className="off"
              onClick={window.turnOffDisplays}>
              &#xF71D;
            </div>
          }
          <div aria-label={T.t("GENERIC_SETTINGS")} className="settings" onClick={window.openSettings}>&#xE713;</div>
          {(!!brightnessStatus.error || !!warmthError) &&
            <button type="button" className="compact-panel-warning"
              aria-label="Display control needs attention; open Settings"
              onClick={window.openSettings}>!</button>}
        </div>
      </div>
      {state.sleeping ? (<div></div>) : getMonitors()}
      {!state.sleeping && <QuickPresetStrip />}
      {!window.settings?.isSpiffy &&
      (
        (state.update && state.update.show)
          ?
          <div className="updateBar">
            <div className="left">
              {T.t("PANEL_UPDATE_AVAILABLE")}
              ({state.update.version})
            </div>
            <div className="right">
              <a onClick={window.installUpdate}>
                {T.t("GENERIC_INSTALL")}
              </a>
              <a className="icon" title={T.t("GENERIC_DISMISS")} onClick={window.dismissUpdate}>
                &#xEF2C;
              </a>
            </div>
          </div>
          :
          (state.update && state.update.downloading)
          &&
          <div className="updateBar">
            <div className="left progress">
              <div className="progress-bar">
                <div style={{ width: `${state.updateProgress}%` }}>
                </div>
              </div>
            </div>
            <div className="right">
              {state.updateProgress}%
            </div>
          </div>
      )}
      <div id="mica">
        <div className="displays" style={{ visibility: window.micaState.visibility }}>
          <div className="blur">
            <img alt="" src={window.micaState.src} width="2560" height="1440" />
          </div>
        </div>
        <div className="noise"></div>
      </div>
    </div>
  )
})

export default BrightnessPanel
