"""G-248 items 3 and 16: the simulator's preflight never reads the host's boot restore; the real answer is cached for a minute; bootrestore.json is read through the
trust-checked open with a 4 KiB cap. Temp directories and fakes only."""
from __future__ import annotations

import argparse
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from linux_xtu.helper import main as helper_main
import importlib

pf = importlib.import_module("linux_xtu.platform.preflight")


class SimulatorPreflight(unittest.TestCase):
    def test_a_simulator_helper_reports_a_fixed_boot_restore_and_never_looks_at_the_host(self) -> None:
        ns = argparse.Namespace(sim=True, device=False, policy=None, audit=None, lock=None, allow_taint_bit=[], sim_topology=None, topology=None)
        with mock.patch.object(pf, "_real_systemctl", side_effect=AssertionError("systemctl must not run")), \
                mock.patch.object(pf, "check_boot_restore", side_effect=AssertionError("the host must not be read")):
            cfg = helper_main.build_config(ns, log=lambda t: None, root=False)
            report = cfg.preflight_fn()
        self.assertEqual(dict(report.boot_restore), helper_main.SIM_BOOT_RESTORE)
        self.assertEqual(report.to_dict()["boot_restore"]["state"], "not_installed")

    def test_the_override_wins_over_root_and_systemctl(self) -> None:
        fixed = {"state": "armed", "note": "fixed"}
        with tempfile.TemporaryDirectory() as d:
            report = pf.preflight(Path(d), boot_restore=fixed, systemctl=lambda a: (_ for _ in ()).throw(AssertionError("asked")))
        self.assertEqual(dict(report.boot_restore), fixed)


class Cache(unittest.TestCase):
    def setUp(self) -> None:
        pf.clear_boot_restore_cache()
        self.now = 1000.0
        patch = mock.patch.object(pf, "_clock", lambda: self.now)
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(pf.clear_boot_restore_cache)
        self.calls = 0

        def fake(root, systemctl):
            self.calls += 1
            return {"state": "disarmed", "note": f"call {self.calls}"}

        patch2 = mock.patch.object(pf, "_boot_restore_uncached", fake)
        patch2.start()
        self.addCleanup(patch2.stop)

    def test_the_real_root_is_asked_once_a_minute(self) -> None:
        first = pf._boot_restore_safe(Path("/"), None)
        self.now += 59.0
        again = pf._boot_restore_safe(Path("/"), None)
        self.assertEqual((self.calls, again), (1, first))
        again["state"] = "armed"  # a caller cannot poison the cache
        self.assertEqual(pf._boot_restore_safe(Path("/"), None)["state"], "disarmed")
        self.now += 2.0
        self.assertEqual(pf._boot_restore_safe(Path("/"), None)["note"], "call 2")
        self.assertEqual(self.calls, 2)

    def test_a_fake_systemctl_or_a_fake_root_is_never_cached(self) -> None:
        pf._boot_restore_safe(Path("/"), lambda a: None)
        pf._boot_restore_safe(Path("/"), lambda a: None)
        pf._boot_restore_safe(Path("/nonexistent-fake-root"), None)
        pf._boot_restore_safe(Path("/nonexistent-fake-root"), None)
        self.assertEqual(self.calls, 4)


class StateFile(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        unit = self.root / "etc/systemd/system/linux-xtu-restore.timer"
        unit.parent.mkdir(parents=True)
        unit.write_text("[Timer]\nOnBootSec=30s\n")
        self.state = self.root / pf.BOOT_STATE_FILE
        self.state.parent.mkdir(parents=True)

    def check(self) -> dict[str, str]:
        return pf.check_boot_restore(self.root, systemctl=lambda a: (0, "enabled\n"))

    def test_a_normal_state_file_is_read(self) -> None:
        self.state.write_text(json.dumps({"schema": 1, "armed": True, "accepted": {"name": "good"}}))
        self.assertEqual(self.check()["state"], "armed")

    def test_an_oversized_file_is_unknown(self) -> None:
        self.state.write_text(json.dumps({"schema": 1, "armed": True, "pad": "x" * pf.BOOT_STATE_MAX_BYTES}))
        got = self.check()
        self.assertEqual(got["state"], "unknown")
        self.assertIn("larger than", got["note"])

    def test_a_symlink_is_not_followed(self) -> None:
        real = self.root / "elsewhere.json"
        real.write_text(json.dumps({"schema": 1, "armed": True}))
        self.state.symlink_to(real)
        self.assertEqual(self.check()["state"], "unknown")

    def test_a_group_writable_file_is_unknown(self) -> None:
        self.state.write_text(json.dumps({"schema": 1, "armed": True}))
        os.chmod(self.state, 0o664)
        self.assertEqual(self.check()["state"], "unknown")

    def test_a_missing_file_is_still_disarmed(self) -> None:
        self.assertEqual(self.check()["state"], "disarmed")


class HalvesTold(unittest.TestCase):
    """G-249 (R2-07): the timer and the arm state are two switches; ``timer`` / ``armed`` tell them apart and the note names the command that is still needed."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        unit = self.root / "etc/systemd/system/linux-xtu-restore.timer"
        unit.parent.mkdir(parents=True)
        unit.write_text("[Timer]\nOnBootSec=30s\n")
        self.state = self.root / pf.BOOT_STATE_FILE
        self.state.parent.mkdir(parents=True)

    def check(self, word: str) -> dict[str, str]:
        return pf.check_boot_restore(self.root, systemctl=lambda a: (0, word + "\n"))

    def test_neither_switch_on_names_one_command_that_does_both(self) -> None:
        got = self.check("disabled")
        self.assertEqual((got["state"], got["timer"], got["armed"]), ("disarmed", "disabled", "no"))
        self.assertIn(pf.ENABLE_AND_ARM_CMD, got["note"])
        self.assertIn("&&", pf.ENABLE_AND_ARM_CMD)
        self.assertTrue(pf.ENABLE_AND_ARM_CMD.startswith("sudo systemctl enable linux-xtu-restore.timer"))
        self.assertTrue(pf.ENABLE_AND_ARM_CMD.endswith("linux-xtu-restore arm"))

    def test_armed_but_the_timer_is_off_needs_only_the_enable(self) -> None:
        self.state.write_text(json.dumps({"schema": 1, "armed": True, "accepted": {"name": "good"}}))
        got = self.check("disabled")
        self.assertEqual((got["state"], got["timer"], got["armed"]), ("disarmed", "disabled", "yes"))
        self.assertIn("armed, but", got["note"])
        self.assertTrue(got["note"].endswith("Run: sudo systemctl enable linux-xtu-restore.timer"))

    def test_enabled_but_disarmed_needs_only_the_arm(self) -> None:
        self.state.write_text(json.dumps({"schema": 1, "armed": False, "disarmed": {"reason": "a clean marker is missing"}}))
        got = self.check("enabled")
        self.assertEqual((got["state"], got["timer"], got["armed"]), ("disarmed", "enabled", "no"))
        self.assertTrue(got["note"].endswith("run: sudo /usr/lib/linux-xtu/linux-xtu-restore arm"))

    def test_both_on_is_armed(self) -> None:
        self.state.write_text(json.dumps({"schema": 1, "armed": True}))
        got = self.check("enabled")
        self.assertEqual((got["state"], got["timer"], got["armed"]), ("armed", "enabled", "yes"))


if __name__ == "__main__":
    unittest.main()
