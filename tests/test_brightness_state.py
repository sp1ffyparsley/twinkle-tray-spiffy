import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'Spiffy Workspace'))
sys.path.insert(0, str(ROOT / 'command_palette/workers/python/src'))
from monitor_brightness.state import StateStore
from sscp.night_filter_state import brightness_software_effect_count

spec = importlib.util.spec_from_file_location('twinkle_brightness_state', Path(__file__).parents[1] / 'src/brightness-state.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class BrightnessStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='twinkle-state-')
        self.addCleanup(self.temp.cleanup)
        self.store = StateStore(Path(self.temp.name) / 'config.json')
        self.inventory = [{'device': r'\\.\DISPLAY1', 'x': 0, 'y': 0, 'width': 800, 'height': 600}]
        self.request = {'id': 'hardware-A', 'level': 200, 'geometry': [0, 0, 800, 600]}

    def test_gain_persists_and_existing_renderer_counts_it(self):
        result = adapter.update_effect(self.store, self.request, self.inventory)
        self.assertEqual(result['hardware'], 100)
        record = StateStore(self.store.path).load()['active_filters'][0]
        self.assertEqual(record['signal_gain'], 2)
        self.assertEqual(record['logical_brightness'], 0)
        self.assertEqual(brightness_software_effect_count(self.store.path), 1)

    def test_real_venv_helper_custody_outlives_launcher(self):
        # Exercise the actual Windows venv launcher without production state or
        # hardware writes. The test process remains the explicitly named owner.
        source = '''import importlib.util,json,sys
from pathlib import Path
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from monitor_brightness.state import StateStore
spec=importlib.util.spec_from_file_location('adapter',sys.argv[3])
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
r=json.loads(sys.stdin.read())
a.update_effect(StateStore(Path(sys.argv[4])),r,[{'device':r'\\\\.\\DISPLAY1','x':0,'y':0,'width':800,'height':600}])
'''
        subprocess.run([str(ROOT / 'Spiffy Workspace/.venv/Scripts/python.exe'), '-B', '-c', source,
                        str(ROOT / 'Spiffy Workspace'), str(ROOT / 'command_palette/workers/python/src'),
                        str(Path(__file__).parents[1] / 'src/brightness-state.py'), str(self.store.path)],
                       input=json.dumps({**self.request, 'owner_pid': os.getpid()}), text=True, check=True,
                       capture_output=True, timeout=5)
        self.assertEqual(self.store.load()['active_filters'][0]['owner_pid'], os.getpid())
        self.assertEqual(brightness_software_effect_count(self.store.path), 1)

    def test_negative_endpoint_then_reset_preserves_preferences(self):
        self.store.update_fields(startup=True, profile_presets={'test': 'day'})
        result = adapter.update_effect(self.store, {**self.request, 'level': -100}, self.inventory)
        self.assertEqual(result['hardware'], 0)
        self.assertEqual(self.store.load()['active_filters'][0]['logical_brightness'], -100)
        adapter.update_effect(self.store, {**self.request, 'level': 50}, self.inventory)
        self.assertEqual(self.store.load()['active_filters'], [])
        self.assertTrue(self.store.load()['startup'])
        self.assertEqual(self.store.load()['profile_presets'], {'test': 'day'})

    def test_conflicting_owner_refuses_without_losing_state(self):
        self.store.update_fields(active_filters=[{'device': r'\\.\DISPLAY1', 'logical_brightness': -20}])
        before = self.store.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'already owns'):
            adapter.update_effect(self.store, self.request, self.inventory)
        self.assertEqual(self.store.path.read_bytes(), before)

    def test_missing_or_mirrored_geometry_refuses_before_write(self):
        for inventory in ([], self.inventory * 2):
            with self.assertRaisesRegex(ValueError, 'ambiguous'):
                adapter.update_effect(self.store, self.request, inventory)
        self.assertFalse(self.store.path.exists())

    def test_pending_recovery_and_invalid_request_refuse(self):
        self.store.update_fields(transaction_journal={'pending': True})
        before = self.store.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'recovery'):
            adapter.update_effect(self.store, self.request, self.inventory)
        for level in (True, 201, -101, 50.5, '50'):
            with self.assertRaises(ValueError):
                adapter.update_effect(self.store, {**self.request, 'level': level}, self.inventory)
        self.assertEqual(self.store.path.read_bytes(), before)

    def test_actual_powershell_reader_and_matrix(self):
        adapter.update_effect(self.store, self.request, self.inventory)
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-File',
                                 str(Path(__file__).with_name('renderer-contract.ps1')),
                                 '-ScriptsRoot', str(ROOT), '-ConfigPath', str(self.store.path)],
                                capture_output=True, text=True, timeout=15,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout.strip())
        self.assertEqual(value['gain'], 2)
        self.assertEqual(value['red'], 2)
        self.assertAlmostEqual(value['warmGreen'], .96, places=5)
        self.assertAlmostEqual(value['dimRed'], .2, places=5)

    def test_local_lifecycle_preserves_twinkle_and_refuses_malformed_state(self):
        adapter.update_effect(self.store, self.request, self.inventory)
        own = self.store.load()['active_filters'][0]
        local = {'device': r'\\.\DISPLAY2', 'logical_brightness': -20}
        conflicting = {'device': r'\\.\DISPLAY1', 'logical_brightness': -80}
        self.store.replace_local_software_filters([local, conflicting])
        self.assertEqual(self.store.load()['active_filters'], [own, local])
        self.store.replace_local_software_filters([])
        self.assertEqual(self.store.load()['active_filters'], [own])
        self.store.path.write_text('{"schema":999}', encoding='utf-8')
        before = self.store.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'unrecognized'):
            adapter.update_effect(self.store, self.request, self.inventory)
        self.assertEqual(self.store.path.read_bytes(), before)

    def test_disconnect_hdr_and_process_reuse_reject_stale_effects(self):
        adapter.update_effect(self.store, self.request, self.inventory)
        records = self.store.load()['active_filters']
        records[0]['owner_started'] = '1'
        self.store.update_fields(active_filters=records)
        self.assertEqual(brightness_software_effect_count(self.store.path), 0)
        self.store.replace_local_software_filters([])
        self.assertEqual(self.store.load()['active_filters'], [])
        adapter.update_effect(self.store, self.request, self.inventory)
        adapter.reconcile_effects(self.store, [], self.inventory)
        self.assertEqual(self.store.load()['active_filters'], [])
        adapter.update_effect(self.store, self.request, self.inventory)
        adapter.reconcile_effects(self.store, [{**self.request, 'hdr': 'active'}], self.inventory)
        self.assertEqual(self.store.load()['active_filters'], [])


if __name__ == '__main__':
    unittest.main()
