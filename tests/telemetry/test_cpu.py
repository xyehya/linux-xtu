import errno
import unittest

from linux_xtu.msr.port import MsrError
from linux_xtu.telemetry import cpu, limits, msrio
from linux_xtu.telemetry.msrio import TelemetryMsr
from linux_xtu.telemetry.rapl import MsrPackagePower

from ._support import Clock, FakeMsrPort


class TelemetryMsrGuard(unittest.TestCase):
    def test_mailbox_and_unlisted_refused_and_no_write(self):
        port = FakeMsrPort(default={0x150: 1, 0x1AD: 2})
        t = TelemetryMsr(port)
        for bad in (0x150, 0x1AD, 0x620):
            with self.assertRaises(MsrError) as cm:
                t.rdmsr(0, bad)
            self.assertEqual(cm.exception.errno, errno.EPERM)
        self.assertEqual(port.reads, [])
        self.assertFalse(hasattr(t, "wrmsr"))
        self.assertNotIn(0x150, msrio.TELEMETRY_MSRS)


class Freq(unittest.TestCase):
    def setUp(self):
        self.port, self.clk = FakeMsrPort(), Clock()
        self.fs = cpu.FreqSampler(TelemetryMsr(self.port), 3700, self.clk)

    def set(self, c, a, m):
        self.port.values[(c, msrio.MSR_APERF)] = a
        self.port.values[(c, msrio.MSR_MPERF)] = m

    def test_first_sample_unavailable_then_values(self):
        self.set(0, 0, 0)
        mhz, busy = self.fs.sample([0])[0]
        self.assertFalse(mhz.available)
        self.clk.t += 1.0
        self.set(0, 5_000_000_000, 3_700_000_000 // 2)  # busy 50%
        mhz, busy = self.fs.sample([0])[0]
        self.assertAlmostEqual(mhz.value, 3700 * 5_000_000_000 / 1_850_000_000, places=3)
        self.assertAlmostEqual(busy.value, 50.0, places=3)

    def test_idle_and_wrap_and_missing(self):
        self.set(1, 10, 10)
        self.fs.sample([1])
        self.clk.t += 1
        mhz, busy = self.fs.sample([1])[1]
        self.assertIsNone(mhz.value)
        self.assertEqual(busy.value, 0.0)
        self.set(2, (1 << 64) - 10, (1 << 64) - 10)
        self.fs.sample([2])
        self.clk.t += 1
        self.set(2, 90, 90)  # wrapped: delta 100
        mhz, _ = self.fs.sample([2])[2]
        self.assertAlmostEqual(mhz.value, 3700.0)
        mhz, busy = self.fs.sample([5])[5]  # no values for cpu 5 -> EIO
        self.assertFalse(mhz.available)
        self.assertFalse(busy.available)
        self.assertIn("unimplemented", mhz.reason)


class Vid(unittest.TestCase):
    def test_decode_and_missing(self):
        port = FakeMsrPort({(3, 0x198): (0x2AAA << 32) | (0x2F << 8)})
        vid, ratio = cpu.read_vid(TelemetryMsr(port), 3)
        self.assertAlmostEqual(vid.value, 0x2AAA / 8192)
        self.assertEqual(ratio.value, 0x2F)
        vid, ratio = cpu.read_vid(TelemetryMsr(port), 4)
        self.assertIsNone(vid.value)
        self.assertIsNone(ratio.value)


class Temps(unittest.TestCase):
    def test_msr_temps(self):
        port = FakeMsrPort({(0, 0x1A2): 0x80691400, (2, 0x19C): (1 << 31) | (30 << 16), (3, 0x19C): 30 << 16,
                            (0, 0x1B1): (1 << 31) | (45 << 16)})
        m = TelemetryMsr(port)
        tj = cpu.read_tjmax(m)
        self.assertEqual(tj.value, 105)
        self.assertEqual(cpu.read_core_temp_msr(m, 2, tj).value, 75)
        self.assertIn("valid", cpu.read_core_temp_msr(m, 3, tj).reason)  # valid bit clear -> no number
        self.assertEqual(cpu.read_package_temp_msr(m, 0, tj).value, 60)
        nj = cpu.read_tjmax(TelemetryMsr(FakeMsrPort()))
        self.assertFalse(nj.available)
        self.assertFalse(cpu.read_core_temp_msr(m, 2, nj).available)

    def test_tsc(self):
        self.assertEqual(cpu.tsc_mhz(TelemetryMsr(FakeMsrPort({(0, 0xCE): 0x08040838F1812500}))).value, 3700)
        self.assertFalse(cpu.tsc_mhz(TelemetryMsr(FakeMsrPort())).available)

    def test_limit_reasons_raw(self):
        self.assertEqual(cpu.read_limit_reasons_raw(TelemetryMsr(FakeMsrPort({(0, 0x6B0): 0x1234}))).value, 0x1234)
        self.assertFalse(cpu.read_limit_reasons_raw(TelemetryMsr(FakeMsrPort())).available)

    def test_limit_reasons_decoded(self):
        # [MEASURED lnx 2026-10-13] 0x64F = 0x1DC21000 on this CPU; decode comes from limits.py, not from here
        port = FakeMsrPort({(0, 0x64F): 0x1DC21000, (0, 0x6B0): 0x10001000})
        r = cpu.read_limit_reasons(TelemetryMsr(port))
        self.assertTrue(r.available)
        self.assertEqual(r.value, limits.decode_core_64f(0x1DC21000).to_json())
        self.assertEqual(r.value["raw"], 0x1DC21000)
        self.assertEqual(r.value["status"], ["max_turbo_limit"])
        self.assertEqual(r.value["unknown_bits"], [])
        self.assertEqual(port.reads, [(0, 0x64F)])  # CPU 0 only, allowlisted MSR only
        g = cpu.read_limit_reasons_gfx(TelemetryMsr(port))
        self.assertEqual(port.reads, [(0, 0x64F), (0, 0x6B0)])
        self.assertEqual(g.value, limits.decode_graphics_6b0(0x10001000).to_json())
        self.assertEqual(g.value["log"], ["inefficient_operation"])

    def test_limit_reasons_unavailable_never_guessed(self):
        m = TelemetryMsr(FakeMsrPort())
        for r in (cpu.read_limit_reasons(m), cpu.read_limit_reasons_gfx(m), cpu.read_limit_reasons_raw(m)):
            self.assertFalse(r.available)
            self.assertIsNone(r.value)
            self.assertIn("unimplemented", r.reason)
        self.assertEqual(cpu.read_limit_reasons(m).to_json()["status"], "unavailable")
        self.assertIn("reason", cpu.read_limit_reasons_gfx(m).to_json())


class MsrRapl(unittest.TestCase):
    def test_power_and_wrap(self):
        port, clk = FakeMsrPort({(0, 0x606): 0x000E0E03}), Clock()  # ESU = 14
        p = MsrPackagePower(TelemetryMsr(port), 0, clk)
        port.values[(0, 0x611)] = 0xFFFFFF00
        self.assertFalse(p.sample().available)
        clk.t += 2.0
        port.values[(0, 0x611)] = (1 << 14) * 10  # wrapped: 0x100 + 10 J worth of counts
        r = p.sample()
        self.assertAlmostEqual(r.value, ((0x100 + (1 << 14) * 10) / 16384) / 2.0, places=6)
        self.assertFalse(MsrPackagePower(TelemetryMsr(FakeMsrPort()), 0, clk).sample().available)


class Pl4Test(unittest.TestCase):
    """G-244: MSR 0x601 PL4, read-only [MEASURED lnx 2026-11-11, throttling.md section G]."""

    def test_decode_measured(self):
        self.assertEqual(cpu.decode_pl4(0xD48, 3), {"watts": 425.0, "locked": False, "raw": 0xD48})

    def test_lock_bit(self):
        r = cpu.decode_pl4(0x80000D48, 3)
        self.assertEqual((r["watts"], r["locked"]), (425.0, True))

    def test_zero_is_none(self):
        self.assertIsNone(cpu.decode_pl4(0, 3))

    def test_allowlist_and_read(self):
        from linux_xtu.msr import measured_baseline as mb
        self.assertIn(0x601, msrio.TELEMETRY_MSRS)
        r = cpu.read_pl4(TelemetryMsr(FakeMsrPort(default={0x601: mb.PL4_RAW, 0x606: mb.RAPL_POWER_UNIT_RAW})))
        self.assertEqual((r.value["watts"], r.value["locked"], r.unit), (425.0, False, "W"))

    def test_unreadable_is_unavailable(self):
        from linux_xtu.msr.sim import SimConfig, SimMsrPort
        self.assertFalse(cpu.read_pl4(TelemetryMsr(SimMsrPort(SimConfig(plain_msrs=False)))).available)
        sim = TelemetryMsr(SimMsrPort(SimConfig()))
        self.assertEqual(sim.rdmsr(0, 0x601), 0xD48)  # the simulator answers 0x601

    def test_relabel(self):
        from linux_xtu.telemetry import throttle
        self.assertEqual(limits.CORE_64F[8][0], "other")
        self.assertEqual(limits.CORE_64F[8][1], "Other (electrical) \u2014 PL4 predicted-peak trip on ARL-S")
        self.assertEqual(limits.GFX_6B0[8], ("other", "Other"))
        self.assertEqual(throttle.GROUPS["current"][0], "Current / PL4 (electrical)")


if __name__ == "__main__":
    unittest.main()
