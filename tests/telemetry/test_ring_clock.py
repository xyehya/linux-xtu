"""QA-20: the sampler reports the ring clock the CPU runs now: sysfs current_freq_khz first, else MSR 0x621 [6:0]. Fake sysfs / fake MSR only."""
import tempfile
import unittest
from pathlib import Path

from linux_xtu.telemetry import Sampler, TelemetryMsr, msrio
from linux_xtu.topology import arl_s_285k

from ._support import FakeMsrPort


def sampler(td: Path, port=None) -> Sampler:
    return Sampler(None if port is None else TelemetryMsr(port), hwmon_root=td / "h", powercap_root=td / "p", cpu_root=td / "cpu", topology=arl_s_285k())


class RingClock(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.td = Path(self._td.name)

    def sysfs(self, khz: str, die: str = "package_00_die_00") -> None:
        p = self.td / "cpu" / "intel_uncore_frequency" / die / "current_freq_khz"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(khz + "\n", encoding="ascii")

    def test_sysfs_current_freq_is_the_ring_clock_without_any_msr(self):
        self.sysfs("4100000")
        ring = sampler(self.td).collect()["ring"]
        self.assertEqual((ring["mhz"]["value"], ring["mhz"]["status"]), (4100.0, "ok"))
        self.assertEqual(ring["ratio"]["value"], 41)
        self.assertIn("current_freq_khz", ring["mhz"]["source"])

    def test_it_follows_the_file(self):
        s = sampler(self.td)
        self.sysfs("800000")
        self.assertEqual(s.collect()["ring"]["ratio"]["value"], 8)
        self.sysfs("4200000")
        self.assertEqual(s.collect()["ring"]["ratio"]["value"], 42)

    def test_msr_0x621_is_the_fallback_and_reads_only_the_ratio_field(self):
        port = FakeMsrPort(default={0x621: 0x280A002A})  # [31:16] UncVID is not the ratio: 42x [MEASURED lnx 2026-10-15]
        ring = sampler(self.td, port).collect()["ring"]
        self.assertEqual((ring["mhz"]["value"], ring["ratio"]["value"]), (4200.0, 42))
        self.assertEqual(ring["mhz"]["source"], "msr 0x621[6:0]")
        self.assertIn(0x621, msrio.TELEMETRY_MSRS)
        self.assertEqual([m for _, m in port.reads if m in (0x150, 0x620)], [])

    def test_sysfs_wins_over_the_msr(self):
        self.sysfs("3900000")
        port = FakeMsrPort(default={0x621: 0x2A})
        ring = sampler(self.td, port).collect()["ring"]
        self.assertEqual(ring["ratio"]["value"], 39)
        self.assertNotIn(0x621, [m for _, m in port.reads])

    def test_unreadable_everywhere_is_unavailable_with_a_reason_not_a_guess(self):
        for snap in (sampler(self.td).collect(), ):
            ring = snap["ring"]
            self.assertEqual((ring["mhz"]["status"], ring["ratio"]["status"]), ("unavailable", "unavailable"))
            self.assertIsNone(ring["mhz"]["value"])
            self.assertTrue(ring["mhz"]["reason"])
        self.sysfs("garbage")
        self.assertEqual(sampler(self.td).collect()["ring"]["mhz"]["status"], "unavailable")
        self.sysfs("0")
        self.assertEqual(sampler(self.td, FakeMsrPort(default={0x621: 0})).collect()["ring"]["mhz"]["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
