"""One-shot Twinkle adapter to the incumbent locked state writer; no new daemon."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys


def reconcile_effects(store, displays, inventory):
    if not isinstance(displays, list) or len(displays) > 16:
        raise ValueError('Invalid display topology')
    eligible = {}
    for row in displays:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str):
            raise ValueError('Invalid display identity in topology')
        geometry = row.get('geometry')
        if row.get('hdr') == 'active' or not isinstance(geometry, list) or len(geometry) != 4:
            continue
        matches = [native for native in inventory if [native['x'], native['y'], native['width'], native['height']] == geometry]
        if len(matches) == 1:
            eligible[row['id']] = (matches[0]['device'], geometry)
    removed = 0
    def mutate(document):
        nonlocal removed
        before = document.get('active_filters') or []
        after = [row for row in before if row.get('owner') != 'twinkle-tray' or
                 eligible.get(row.get('monitor_id')) == (row.get('device'), row.get('geometry'))]
        removed = len(before) - len(after)
        document['active_filters'] = after
    store.update(mutate, require_recognized=True)
    return {'ok': True, 'removed': removed}


def update_effect(store, request, inventory, owner_pid=None):
    from sscp.night_filter_state import windows_process_start_filetime
    owner_pid = request.get('owner_pid', os.getppid()) if owner_pid is None else owner_pid
    owner_started = windows_process_start_filetime(owner_pid)
    identity = request.get("id")
    level = request.get("level")
    geometry = request.get("geometry")
    if not isinstance(identity, str) or not 1 <= len(identity) <= 240:
        raise ValueError("Missing exact Twinkle display identity")
    if type(level) is not int or not -100 <= level <= 200:
        raise ValueError("Brightness must be an integer from -100 through 200")
    if not isinstance(geometry, list) or len(geometry) != 4 or any(type(x) is not int for x in geometry):
        raise ValueError("Missing current physical display bounds")
    matches = [row for row in inventory if [row['x'], row['y'], row['width'], row['height']] == geometry]
    if len(matches) != 1:
        raise ValueError("Display mapping changed or is ambiguous; refresh displays before adjusting")
    device = matches[0]['device']
    active = level < 0 or level > 100
    changed = False

    def mutate(document):
        nonlocal changed
        if document.get('transaction_journal'):
            raise ValueError('A Spiffy Brightness recovery transaction is pending; resolve it first')
        before = list(document.get('active_filters') or [])
        if active and any(row.get('device') == device and row.get('owner') != 'twinkle-tray' for row in before):
            raise ValueError('Spiffy Brightness already owns software effects on this display; clear them there first')
        after = [row for row in before if not (row.get('owner') == 'twinkle-tray' and row.get('monitor_id') == identity)]
        if active:
            if any(row.get('device') == device for row in after):
                raise ValueError('A different display effect is mapped here; refresh or restore it first')
            after.append({'owner': 'twinkle-tray', 'monitor_id': identity, 'device': device,
                          'owner_pid': owner_pid, 'owner_started': owner_started,
                          'geometry': geometry, 'logical_brightness': min(0, level),
                          'temperature_k': 6500, 'tint': 0,
                          'signal_gain': max(1.0, level / 100.0)})
        changed = before != after
        document['active_filters'] = after
    store.update(mutate, require_recognized=True)
    return {'ok': True, 'changed': changed, 'active': active, 'device': device,
            'hardware': max(0, min(100, level)), 'level': level}


def main():
    if len(sys.argv) != 2:
        raise ValueError('Expected the existing SS Scripts root')
    root = Path(sys.argv[1]).resolve(strict=True)
    sys.path.insert(0, str(root / 'Spiffy Workspace'))
    sys.path.insert(0, str(root / 'command_palette/workers/python/src'))
    from monitor_brightness.state import StateStore, _recognized_config_document
    from sscp.night_filter_state import windows_display_inventory
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise ValueError('Brightness request exceeds 8192 bytes')
    request = json.loads(raw)
    store = StateStore()
    # Refuse unknown state instead of replacing it with defaults during a control action.
    if store.path.exists() and not _recognized_config_document(json.loads(store.path.read_text(encoding='utf-8'))):
        raise ValueError('Existing brightness state is unrecognized; preserve it and repair before adjusting')
    if not isinstance(request, dict):
        raise ValueError('Expected a brightness request object')
    if request.get('action') != 'reconcile' and (type(request.get('owner_pid')) is not int or request['owner_pid'] <= 0):
        raise ValueError('Expected the live Twinkle Tray owner process, not the temporary Python launcher')
    inventory = windows_display_inventory()
    result = (reconcile_effects(store, request.get('displays'), inventory)
              if request.get('action') == 'reconcile' else update_effect(store, request, inventory))
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        raise SystemExit(1)
