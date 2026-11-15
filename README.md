# Twinkle Tray Spiffy

A community fork of [Twinkle Tray by Xander Frangos](https://github.com/xanderfrangos/twinkle-tray). The original source is MIT licensed; the upstream author and license are preserved in LICENSE. **This fork is not the official Twinkle Tray release.**

## What it does

A compact Windows tray and experimental Mac menu-bar brightness controller, sharing the same React panel and five presets. Windows retains the original DDC/CI and WMI backends, monitor detection, schedules, hotkeys and profiles.

Spiffy additions:

- Quick-opening flyout with compact per-display sliders and numeric values.
- Five configurable presets (name, icon, brightness, optional warmth) in the existing settings file. The native right-click menu shares the same slots. Settings can capture physical monitors and import/export portable JSON.
- Independent per-monitor warmth when the optional Spiffy Night Filter/Command Palette owner is already installed. Missing integrations fail closed.
- Experimental extended brightness from -100 through +200 on compatible non-HDR DDC displays. Negative values use hardware minimum plus software darkening. Positive values beyond 100 use software gain and may clip highlights.
- Negative-range safety: before repeating a hardware-minimum command, the app reads the current hardware brightness and never repeats a blind 0% write after a failed read. The resident software-filter path replies after submitting its native effect update, but this is not a physical luminance measurement. Real monitor testing remains required.
- A coalescing brightness scheduler which preserves the final requested level.
- A notification-resistant popup: Windows focus changes during opening no longer instantly dismiss the controls, and the flyout stays usable while the cursor remains over it.
- Adaptive quick-preset icons: saved brightness changes icon luminance and saved warmth adds a subtle amber tint without replacing the chosen symbol.
- Preset clicks remain responsive during slow monitor operations: at most one in-flight command plus the latest requested preset is retained. Duplicate selections do not cause redundant hardware writes, and preset slot numbers remain legible at low icon brightness.
- On machines without the separate Spiffy filter runtime, optional extended sliders are restricted to standard 0–100%. Per-monitor warmth is not exposed until the canonical filter owner reports safely matched displays.

No analytics, mandatory accounts or automatic upstream update installs.

## Supported platforms

**Windows 10/11 x64:** this Electron application. DDC/CI support, physical response time and minimum usable backlight depend on the monitor, GPU, cable and dock.

**macOS experimental source:** `src/MacMain.js` boots the **same** React brightness panel and quick-preset components as Windows. Built-in Apple displays can use the BSD-2-Clause `brightness` command when the display is positively identified and supports readback. Compatible Apple Silicon external displays use MIT-licensed `m1ddc`. Install only the supported command(s) on your own Mac with `brew install brightness` and/or `brew install m1ddc`; neither is silently installed or run as a background daemon. Intel Mac external DDC/CI, unsupported adapters, software overbright/negative dimming and independent warmth are currently unavailable. Native monitor names are read at runtime; imported Windows-specific monitor IDs are not reused as Mac identities.

**Optional advanced effects:** the Windows software dimming/warmth renderer is owned by the separately installed Spiffy Workspace. Standard 0–100% hardware brightness remains available without it. Negative brightness, per-screen warmth and software gain cannot be represented as universally available until the helper is bundled and qualified for independent machines.

## Build and run

Install Node 22 or newer and Visual Studio C++ Build Tools on Windows.

Commands: npm ci ; npm test ; npm run parcel-build ; npx electron-builder --x64 --win nsis --publish never.

Mac source build command: `npm run mac-build` on an Apple Silicon Mac with its local Node/Electron build toolchain; `electron-builder.mac.json` packages the Mac host and shared React panel without rebuilding Windows native add-ons. CI tests the unsigned bundle structure separately from source compilation. Until those checks pass and real displays, signing and notarization have been verified, do not advertise a certified Mac release.

Run only verified locally built installers. Avoid two brightness-control apps driving the same DDC devices. Build, cache and debug files are excluded from Git.

Normal preferences and presets live at %APPDATA%\twinkle-tray-spiffy\settings.json. Before an update, gracefully quit the app and make a verified backup of settings, monitor data and the old installed binary. Do not delete active software filter state or recovery records.

## Quick presets

Five defaults: Bright, Work, Balanced, Evening and Dim. Set each name/icon and brightness/warmth under Settings > Quick presets. Capture monitors to store per-display values from unambiguous live display identities. Portable JSON transfers generic settings. On another computer, monitor-specific values require recapture or safe identity remapping.

## Verification

Source tests cover negative-brightness monotonicity, topology changes, stale commands, recovery paths, last-input-wins behavior, and preset validation. Browser tests do not prove physical DDC or screenshot appearance. Real packaged Windows 10/11 dual-monitor tests, power-resume tests and failure injection are required for production certification.

**Release QA:** Run `npm test`, `npm run parcel-build`, and the Windows package checks. Mac source and UI mock tests do not substitute for physical Mac display verification. A physical negative-range drag from −70 to −80 and a native-renderer restart must still be checked after installation. Do not claim source-only tests prove the actual luminance response.

Electron uses local packaged pages, disables unsafe mixed content and direct renderer Node integration, and restricts external settings navigation. A complete context-isolation/preload audit and independent clean-machine acceptance are still needed before promoting a public binary.

## Before public GitHub publication

1. Create a NEW fork-owned repository and review every Git diff and native dependency license. Never push to the official upstream project.
2. Exclude personal prompts, settings, API keys, logs, test data, screenshots, installer archives and local rollback copies.
3. Pass CI tests and an unsigned installer build, then perform live dual-monitor calibration/reconnect, negative-brightness, quick-preset and recovery tests on supported Windows versions.
4. Sign a public Windows installer with a publisher certificate; the local installer is unsigned.
5. Either distribute and qualify the optional advanced-filter owner or document that extended/warmth controls are unavailable on other machines.
6. Verify a genuine macOS bundle, signed/notarized distribution, built-in and external physical displays, reconnect/power-resume, host resource usage and refusal of unsupported warmth/extended levels before advertising a Mac release.

**Publishing policy:** Public source must exclude private user settings, API keys, prompt history, logs, old installers, and unrelated backups. Only publish unsigned release binaries with explicit development/preview warnings. Mac support remains experimental pending real hardware testing and signing/notarization.

Upstream documentation: https://github.com/xanderfrangos/twinkle-tray.
