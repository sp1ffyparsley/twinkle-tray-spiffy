const path = require('path');
const fs = require('fs')

function udpSendCommand(type, data, port = 14715, key) {
    return new Promise((resolve, reject) => {
        const client = require('dgram').createSocket('udp4')
        let settled = false
        let udpTimeout
        const finish = (error, value) => {
            if (settled) return
            settled = true
            if (udpTimeout) clearTimeout(udpTimeout)
            try { client.close() } catch (_) { /* The socket may already be closed. */ }
            if (error) reject(error)
            else resolve(value)
        }
        // VCP requests wait for the primary monitor worker to acknowledge dispatch.
        // Keep list/brightness requests fast, but allow a bounded cold-worker start.
        const timeoutMs = type === 'setvcp' ? 30000 : 1000
        udpTimeout = setTimeout(() => finish("No response"), timeoutMs)

        client.once('message', message => finish(null, message?.toString()))
        client.once('error', error => finish(error))

        try {
            client.send(JSON.stringify({ type, data, key }), port, "localhost", err => {
                if (err) finish('Failed to send command')
            })
        } catch (error) {
            finish(error)
        }
    })
}

function pipeSendCommand(type, data, port = 14715, key) {
    return new Promise((resolve, reject) => {
        const client = require('net').connect('\\\\.\\pipe\\twinkle-tray\\cmds')
        const finish = (error, value) => {
            clearTimeout(cmdTimeout)
            client.destroy()
            if (error) reject(error)
            else resolve(value)
        }
        const cmdTimeout = setTimeout(() => finish(Error('No response from Twinkle Tray; command outcome is unconfirmed.')), 3000)
        client.once('error', error => finish(error))
        client.once('data', message => finish(null, message.toString()))
        client.once('connect', () => client.write(JSON.stringify({ type, data, key })))
    })
}

module.exports = {
    unloadModule: (name) => {
        try {
            if (require.cache[require.resolve(name)]) {
                delete require.cache[require.resolve(name)]
                console.log(`Unloaded module: ${name}`)
            }
        } catch (e) {
            console.log(`Couldn't unload module: ${name}`)
        }
    },
    wait(ms = 2000) {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve(true);
            }, ms);
        });
    },
    processArgs: (commandLine) => {

        let validArgs = {}

        commandLine.forEach(argRaw => {

            const arg = argRaw.toLowerCase();

            // Use UDP
            if (arg.indexOf("--udp") === 0) {
                validArgs.UseUDP = true
            }

            // Get display by index
            if (arg.indexOf("--list") === 0) {
                validArgs.List = true
            }

            // Get display by index
            if (arg.indexOf("--monitornum=") === 0) {
                validArgs.MonitorNum = Number(arg.substring(13))
            }

            // Get display by ID (partial or whole)
            if (arg.indexOf("--monitorid=") === 0) {
                validArgs.MonitorID = arg.substring(12)
            }

            // Run on all displays
            if (arg.indexOf("--all") === 0 && arg.length === 5) {
                validArgs.All = true
            }

            // Use absolute brightness
            if (arg.indexOf("--set=") === 0) {
                validArgs.Brightness = Number(arg.substring(6))
                validArgs.BrightnessType = "set"
            }

            // Use relative brightness
            if (arg.indexOf("--offset=") === 0) {
                validArgs.Brightness = Number(arg.substring(9))
                validArgs.BrightnessType = "offset"
            }

            // Use time adjustments
            if (arg.indexOf("--usetime") === 0) {
                validArgs.UseTime = true
            }

            // DDC/CI command
            if (arg.indexOf("--vcp=") === 0) {
                const match = arg.substring(6).match(/^(0x[0-9a-f]+|[0-9]+):([0-9]+)$/i)
                validArgs.VCP = match
                    ? { code: Number.parseInt(match[1], 0), value: Number.parseInt(match[2], 10) }
                    : { code: NaN, value: NaN }
            }

            // Show overlay
            if (arg.indexOf("--overlay") === 0) {
                validArgs.ShowOverlay = true
            }

            // Show panel
            if (arg.indexOf("--panel") === 0) {
                validArgs.ShowPanel = true
            }
            if (arg === '--settings') validArgs.ShowSettings = true
            if (arg === '--quit') validArgs.Quit = true

        })

        return validArgs
    },

    async handleProcessedArgs(args = {}, knownDisplaysPath, settingsPath) {

        let failed
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
        const useUDP = args.UseUDP === true
        if (useUDP && (typeof settings.udpKey !== 'string' || settings.udpKey.length === 0)) {
            throw new Error('UDP command refused: no authentication key is configured.')
        }
        const sendCommand = (type, data) => (useUDP ? udpSendCommand : pipeSendCommand)(
            type, data, settings.udpPortActive, settings.udpKey,
        )
        let displaysPromise
        const listDisplays = async () => {
            if (!displaysPromise) {
                displaysPromise = sendCommand('list', false).then(response => {
                    let displays
                    try {
                        displays = JSON.parse(response || '')
                    } catch (_) {
                        throw new Error('Could not parse the monitor list returned by Twinkle Tray.')
                    }
                    if (displays && typeof displays === 'object' && displays.accepted === false) {
                        throw new Error(`Twinkle Tray rejected the monitor-list request: ${String(displays.error || 'unknown error')}`)
                    }
                    if (!displays || typeof displays !== 'object' || Array.isArray(displays)) {
                        throw new Error('Twinkle Tray returned an invalid monitor list.')
                    }
                    return displays
                })
            }
            return displaysPromise
        }
        const resolveMonitorTargets = async ({ allVCP = false } = {}) => {
            if (args.All) {
                if (!allVCP) return ['all']
                const ids = Object.keys(await listDisplays())
                if (ids.length === 0) throw new Error('No monitors are currently available.')
                return ids
            }
            if (args.MonitorID !== undefined) {
                if (typeof args.MonitorID !== 'string' || args.MonitorID.trim() === '') {
                    throw new Error('Monitor ID must not be empty.')
                }
                return [args.MonitorID]
            }
            if (args.MonitorNum !== undefined) {
                if (!Number.isInteger(args.MonitorNum) || args.MonitorNum < 1) {
                    throw new Error('Monitor number must be a positive integer starting at 1.')
                }
                const entry = Object.entries(await listDisplays()).find(([, display]) => Number(display?.num) === args.MonitorNum - 1)
                if (!entry) throw new Error(`Monitor number ${args.MonitorNum} was not found.`)
                return [entry[0]]
            }
            return []
        }
        const reportDispatch = (label, response) => {
            let parsed = response
            if (typeof response === 'string') {
                try { parsed = JSON.parse(response) } catch (_) { /* Keep the literal response. */ }
            }
            if (parsed && typeof parsed === 'object' && parsed.accepted === false) {
                throw new Error(`${label} rejected by Twinkle Tray: ${String(parsed.error || 'unknown error')}`)
            }
            if (parsed && typeof parsed === 'object' && parsed.accepted === true && parsed.pending === true) {
                const detail = parsed.level === undefined ? '' : ` at ${parsed.level}`
                console.log(`${label} accepted; hardware update pending${detail}.`)
            } else if (parsed === true || response === 'OK') {
                console.log(`${label} accepted by Twinkle Tray.`)
            } else {
                throw new Error(`${label} was not acknowledged by Twinkle Tray; hardware completion is unconfirmed (response: ${String(response)}).`)
            }
        }

        if (args.ShowSettings) {
            await pipeSendCommand('settings', false)
            return true
        } else if (args.Quit) {
            await pipeSendCommand('quit', false)
            return true
        } else if (args.ShowPanel) {
            console.log(`Showing panel`)
            await pipeSendCommand('panel', false)
            return true
        } else if (args.List) {
            const displays = await listDisplays()

            Object.values(displays).forEach(display => {
                console.log(`
\x1b[36mMonitorNum:\x1b[0m ${display.num}
\x1b[36mMonitorID:\x1b[0m ${display.key}
\x1b[36mName:\x1b[0m ${display.name}
\x1b[36mBrightness:\x1b[0m ${display.brightness}
\x1b[36mType:\x1b[0m ${display.type}`)
            })

            return true;
        } else {
            if (!(args.MonitorID !== undefined || args.MonitorNum !== undefined || args.All || args.UseTime)) {
                console.log("\x1b[41mMissing monitor argument.\x1b[0m")
                failed = true
            }
            if (args.Brightness === undefined && !args.VCP && !args.UseTime) {
                console.log("\x1b[41mMissing brightness argument.\x1b[0m")
                failed = true
            }
            if ((args.Brightness !== undefined || args.VCP) && !(args.MonitorID !== undefined || args.MonitorNum !== undefined || args.All)) {
                console.log("\x1b[41mA monitor must be selected for brightness or VCP commands.\x1b[0m")
                failed = true
            }
            if (args.MonitorID !== undefined && args.MonitorNum !== undefined) failed = true
            if (args.Brightness !== undefined && !Number.isFinite(args.Brightness)) failed = true
            if (args.MonitorNum !== undefined && (!Number.isInteger(args.MonitorNum) || args.MonitorNum < 1)) failed = true
            if (args.VCP !== undefined && (!args.VCP || typeof args.VCP !== 'object'
                || !Number.isInteger(args.VCP.code) || args.VCP.code < 1 || args.VCP.code > 0xFF
                || !Number.isInteger(args.VCP.value) || args.VCP.value < 0 || args.VCP.value > 0xFFFF)) failed = true
            if (args.All && (args.MonitorID !== undefined || args.MonitorNum !== undefined)) failed = true
        }

        if (failed) {
            console.log(`
Supported args:

\x1b[36m--List\x1b[0m
List all displays.

\x1b[36m--MonitorNum\x1b[0m
Select monitor by number. Starts at 1.
\x1b[2mExample: --MonitorNum=2\x1b[0m

\x1b[36m--MonitorID\x1b[0m
Select monitor by internal ID. Partial or whole matches accepted.
\x1b[2mExample: --MonitorID="UID2353"\x1b[0m

\x1b[36m--All\x1b[0m
Flag to update all monitors.
\x1b[2mExample: --All\x1b[0m

\x1b[36m--Set\x1b[0m
Set brightness percentage.
\x1b[2mExample: --Set=95\x1b[0m

\x1b[36m--Offset\x1b[0m
Adjust brightness percentage.
\x1b[2mExample: --Offset=-20\x1b[0m

\x1b[36m--UseTime\x1b[0m
Adjust brightness using Time of Day Adjustments. 
\x1b[2mExample: --UseTime\x1b[0m

\x1b[36m--VCP\x1b[0m
Send a specific DDC/CI VCP code and value instead of brightness. The first part is the VCP code (decimal or hexadecimal), and the second is the value.
\x1b[2mExample: --VCP="0xD6:5"\x1b[0m

\x1b[36m--Overlay\x1b[0m
Flag to show brightness levels in the overlay
\x1b[2mExample: --Overlay\x1b[0m

\x1b[36m--Panel\x1b[0m
Flag to show brightness levels in the panel
\x1b[2mExample: --Panel\x1b[0m
`)
        } else {
            // Validated above; perform the requested command(s) below.
        }

        if (failed) throw new Error('Invalid command-line arguments.')

        const hasBrightness = args.Brightness !== undefined
        const hasVCP = args.VCP !== undefined
        if (hasBrightness || hasVCP) {
            const targets = await resolveMonitorTargets({ allVCP: args.All && hasVCP })
            if (targets.length === 0) throw new Error('No monitor target was resolved.')
            if (hasBrightness) {
                const response = await sendCommand('set', {
                    monitor: args.All ? 'all' : targets[0],
                    vcp: 'brightness',
                    value: args.Brightness,
                    mode: args.BrightnessType || 'set',
                })
                reportDispatch('Brightness command', response)
            }
            if (hasVCP) {
                for (const monitor of targets) {
                    const response = await sendCommand('setvcp', {
                        monitor,
                        vcp: args.VCP.code,
                        value: args.VCP.value,
                    })
                    reportDispatch(`VCP ${args.VCP.code} for ${monitor}`, response)
                }
            }
        }
        if (args.UseTime) {
            const response = await sendCommand('checktime', false)
            reportDispatch('Time-adjustment command', response)
        }
        return true
    },
    vcpMap: {
        0x10: "luminance",
        0x13: "brightness",
        0x12: "contrast",
        0xD6: "powerState",
        0x62: "volume"
    },
    upgradeAdjustmentTimes,
    getVersionValue,
    lerp,
    parseTime,
    getCalibratedValue
}


function upgradeAdjustmentTimes(times = []) {
    const newTimes = []

    times.forEach(time => {
        if (time.time) {
            newTimes.push(time)
            return
        }

        const newTime = {
            brightness: (time.brightness ? time.brightness : 50),
            monitors: (time.monitors ? time.monitors : 50),
            time: "00:00"
        }

        // Convert to 24H
        const hourInt = parseInt(time.hour)
        const fixedHour = hourInt + (hourInt == 12 ? (time.am.toLowerCase() == "pm" ? 0 : -12) : (time.am.toLowerCase() == "pm" ? 12 : 0))
        newTime.time = (fixedHour < 10 ? "0" + fixedHour : fixedHour) + ":" + (time.minute < 10 ? "0" + time.minute : time.minute)

        newTimes.push(newTime)
    })

    return newTimes
}

// Convert version to a numeric value (v1.2.3 = 10020003)
function getVersionValue(version = 'v1.0.0') {
    let out = version.split('-')[0].replace("v", "").split(".")
    out = (out[0] * 10000 * 10000) + (out[1] * 10000) + (out[2] * 1)
    return parseInt(out)
}

function lerp(start, finish, perc) {
    return start * (1 - perc) + finish * perc
}

function parseTime(time) {
    return parseInt((time.split(":")[0] * 60) + (time.split(":")[1] * 1))
}

// Get known displays from file, along with current displays
function getKnownDisplays(knownDisplaysPath) {
    let known
    try {
        // Load known displays DB
        known = fs.readFileSync(knownDisplaysPath)
        known = JSON.parse(known)
    } catch (e) {
        known = {}
    }

    return known
}

/**
 * Maps a value (0–100) using calibration points.
 * By default, maps input to output. Can also reverse map output back to input.
 *
 * @param {number} value - The value to map (expected range: 0–100).
 * @param {Array<{input: number, output: number}>} calibrationPoints - 
 *        An array of calibration points.
 *        Example: [{input: 15, output: 30}, {input: 50, output: 60}]
 * @param {boolean} reverse - If true, maps output to input. Default is false (input to output).
 * @returns {number} - The mapped value.
 */
function getCalibratedValue(value, calibrationPoints = [], reverse = false) {
    // Ensure value is within 0–100
    value = Math.max(0, Math.min(100, value));

    // Add default start and end points if not provided
    const points = calibrationPoints.slice();

    // Handle min/max values if those points haven't been provided
    let hasMin = false;
    let hasMax = false;
    for (const point of points) {
        point.input = Math.max(0, Math.min(100, point.input));
        if (point.input === 0) hasMin = true;
        if (point.input === 100) hasMax = true;
    }

    if (!hasMin) {
        points.unshift({ input: 0, output: 0 });
    }
    if (!hasMax) {
        points.push({ input: 100, output: 100 });
    }

    // Sort points by input value
    points.sort((a, b) => a.input - b.input);

    if (reverse) {
        // Reverse mapping: output -> input
        // Find the two points between which the output falls
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];

            // Check if output falls between these two points
            const minOutput = Math.min(p1.output, p2.output);
            const maxOutput = Math.max(p1.output, p2.output);

            if (value >= minOutput && value <= maxOutput) {
                // Linear interpolation in reverse
                if (p2.output === p1.output) {
                    // If outputs are the same, return the midpoint input
                    return (p1.input + p2.input) / 2;
                }
                const ratio = (value - p1.output) / (p2.output - p1.output);
                return p1.input + ratio * (p2.input - p1.input);
            }
        }
        // Fallback
        return value;
    } else {
        // Forward mapping: input -> output
        if (value === 0 && points.length > 0 && points[0].input === 0) {
            return points[0].output;
        }

        // Find the two points between which the input falls
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];

            if (value >= p1.input && value <= p2.input) {
                // Linear interpolation
                const ratio = (value - p1.input) / (p2.input - p1.input);
                return p1.output + ratio * (p2.output - p1.output);
            }
        }
        // Fallback
        return value;
    }
}
