"""R-B3 (assessment 05 B-15): the D-048 offline-CPU check fails CLOSED -- "cannot tell" is a refusal -- and is the one check the helper and the CLI share.
Fake sysfs trees under a temp directory; the real /sys is never read."""
from __future__ import annotations

import types
import unittest
from pathlib import Path
from unittest import mock

from linux_xtu.controls.caps import RuntimeFiles
from linux_xtu.helper import ops_runtime
from linux_xtu.helper.cpu_online import CpuOnlineUnknown, offline_cpus, offline_cpus_in, refuse_if_cpu_offline
from linux_xtu.helper.ops_runtime import RuntimeWiring
from linux_xtu.helper.protocol import INTERNAL, OpError

from ._support import HelperCase


def tree(root: Path, cpus: range, online: dict[int, str] | None = None) -> RuntimeFiles:
    for cpu in cpus:
        (root / f"cpu{cpu}").mkdir(parents=True, exist_ok=True)
        text = (online or {}).get(cpu, "1\n" if cpu else None)
        if text is not None:
            (root / f"cpu{cpu}" / "online").write_text(text)
    return RuntimeFiles(root)


class OfflineIn(HelperCase):
    def check(self, files: RuntimeFiles) -> list[int]:
        return offline_cpus_in(files.listdir, files.read_int)

    def test_all_online_and_cpu0_without_a_file(self) -> None:
        self.assertEqual(self.check(tree(self.tmp / "a", range(24))), [])

    def test_offline_cpus_are_named(self) -> None:
        self.assertEqual(self.check(tree(self.tmp / "b", range(24), {12: "0\n", 3: "0"})), [3, 12])

    def test_cannot_tell_raises(self) -> None:
        cases = {
            "garbled": tree(self.tmp / "c", range(4), {2: "maybe\n"}),
            "two": tree(self.tmp / "d", range(4), {2: "2\n"}),
            "empty": RuntimeFiles(self.tmp / "e-missing"),
        }
        unreadable = tree(self.tmp / "f", range(4))
        (unreadable.root / "cpu3" / "online").unlink()
        (unreadable.root / "cpu3" / "online").mkdir()
        cases["unreadable"] = unreadable
        for name, files in cases.items():
            with self.subTest(name), self.assertRaises(CpuOnlineUnknown):
                self.check(files)
        with self.assertRaises(CpuOnlineUnknown):
            offline_cpus_in(lambda d: (_ for _ in ()).throw(OSError("EIO")), lambda n: 1)


class HelperFailsClosed(HelperCase):
    def test_an_unreadable_online_file_refuses_tune_apply_before_anything(self) -> None:
        h = self.start()
        files = tree(self.tmp / "sys", range(24))
        (files.root / "cpu9" / "online").write_text("x\n")
        h.helper.runtime_wiring = RuntimeWiring(files, self.tmp / "runtime-journal.json")
        r = h.call("1", "tune.apply", {"plan_id": "0" * 64, "typed": "CONFIRM ABCDEF"})
        self.assertEqual((r["error"]["code"], r["error"]["detail"]["check"]), ("REFUSED", "CPU_ONLINE_UNKNOWN"), r)
        self.assertIn("cpu9/online", r["error"]["message"])
        self.assertEqual(self.sim.requests, [])

    def test_hardware_without_its_runtime_sysfs_cannot_tell(self) -> None:
        helper = types.SimpleNamespace(cfg=types.SimpleNamespace(simulator=False))
        with mock.patch.object(ops_runtime, "_wiring", side_effect=OpError(INTERNAL, "no runtime sysfs")):
            with self.assertRaises(CpuOnlineUnknown):
                offline_cpus(helper)
            with self.assertRaises(OpError) as ctx:
                refuse_if_cpu_offline(helper, "tune.apply")
        self.assertEqual(ctx.exception.detail["check"], "CPU_ONLINE_UNKNOWN")

    def test_a_simulator_without_a_runtime_model_has_every_cpu_online(self) -> None:
        h = self.start()  # no measure wiring: no simulated runtime files
        self.assertEqual(offline_cpus(h.helper), [])


if __name__ == "__main__":
    unittest.main()
