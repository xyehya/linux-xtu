"""Shared harness for the boot restore tests: temp paths for every installed file, the simulator behind a real in-process ``Helper``, an injected boot id,
uptime clock and kernel log. No hardware, no /etc, /var, /run or systemd; the trust checks are off (the temp files belong to the test user)."""
from __future__ import annotations

import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from linux_xtu import bootrestore as br
from linux_xtu.helper import Helper, HelperConfig
from linux_xtu.msr import SimConfig, SimMsrPort
from linux_xtu.platform.preflight import CheckResult, PreflightReport, Status
from linux_xtu.profiles.fingerprint import CpuId, build_fingerprint
from linux_xtu.topology import arl_s_285k

REPO = Path(__file__).resolve().parents[2]
EXAMPLE = REPO / "examples/reference-285k/profiles"
POLICY = REPO / "policies" / "default.toml"
BOOT_A = "11111111-2222-3333-4444-555555555555"
BOOT_B = "22222222-2222-3333-4444-555555555555"
BOOT_C = "33333333-2222-3333-4444-555555555555"
BRAND = "Intel(R) Core(TM) Ultra 9 285K"
CPUINFO = (
    "processor\t: 0\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel\t\t: 198\nmodel name\t: {brand}\nstepping\t: 2\nmicrocode\t: {micro}\n\n"
    "processor\t: 1\nvendor_id\t: GenuineIntel\n"
)
BENIGN_KLOG = [  # normal lines of every boot: none of them is a hardware error
    "mce: CPU supports 32 MCE banks", "MCE: In-kernel MCE decoding enabled.", "mce: CPU0: Thermal monitoring enabled (TM1)",
    "RAS: Correctable Errors collector initialized.", "msr: Write to unrecognized MSR 0x150 by python3 (pid: 4242).",
]
COLD = SimConfig.measured(per_point=True, reject_zero_fields=True, sticky_oc_ratio=True)
GOOD_REPORT = PreflightReport("arl-s-285k", (CheckResult("cpuid", Status.PASS, "ok"), CheckResult("msr_allow_writes", Status.PASS, "on")))
READ_ONLY_REPORT = PreflightReport("arl-s-285k", (CheckResult("cpuid", Status.PASS, "ok"), CheckResult("lockdown", Status.READ_ONLY, "integrity")))


class Clock:
    """Uptime that advances only when the code under test waits (``env.wait``); ``stop_at`` requests a stop (SIGTERM) once uptime reaches it."""

    def __init__(self, uptime: float = 31.0) -> None:
        self.uptime = uptime  # CLOCK_BOOTTIME (suspend included)
        self.monotonic = uptime  # CLOCK_MONOTONIC (running time)
        self.wall = 1_800_000_000.0
        self.stop_at: float | None = None
        self.env: br.Env | None = None
        self.crash_at: float | None = None  # raise PowerLoss once uptime reaches it (a hang / power cut: the process just ends)

    def suspend(self, seconds: float) -> None:
        self.uptime += seconds
        self.wall += seconds

    def wait(self, seconds: float) -> bool:
        self.uptime += seconds
        self.monotonic += seconds
        self.wall += seconds
        if self.crash_at is not None and self.uptime >= self.crash_at:
            raise PowerLoss()
        if self.stop_at is not None and self.uptime >= self.stop_at and self.env is not None:
            self.env.request_stop()
        return self.env is not None and self.env.stop.is_set()


class PowerLoss(BaseException):
    """The machine went away mid-run: nothing after this point of the process happens (not an Exception: no handler of the code sees it)."""


class BootCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.sim = SimMsrPort(COLD)
        self.topo = arl_s_285k()
        self.acc = self.tmp / "etc/linux-xtu/accepted"
        (self.acc / "profiles").mkdir(parents=True)
        shutil.copy(EXAMPLE / "CURRENT", self.acc / "CURRENT")
        shutil.copy(EXAMPLE / "EXPECTED-words.txt", self.acc / "EXPECTED-words.txt")
        shutil.copy(EXAMPLE / "accepted-2026-10-04.toml", self.acc / "profiles" / "accepted-2026-10-04.toml")
        self.write_fingerprint()
        (self.tmp / "var/lib/linux-xtu").mkdir(parents=True)
        (self.tmp / "run/linux-xtu").mkdir(parents=True)
        (self.tmp / "var/log/journal").mkdir(parents=True)
        self.policy = self.tmp / "etc/linux-xtu/policy.toml"
        shutil.copy(POLICY, self.policy)
        self.micro = "0x114"
        self.write_cpuinfo()
        (self.tmp / "cmdline").write_text("BOOT_IMAGE=/vmlinuz-7 root=UUID=x ro rhgb quiet\n")
        self.paths = br.Paths(
            state=self.tmp / "var/lib/linux-xtu/bootrestore.json", config=self.tmp / "etc/linux-xtu/restore.toml", accepted=self.acc,
            audit=self.tmp / "var/lib/linux-xtu/audit.jsonl", lock=self.tmp / "run/linux-xtu/mailbox.lock", policy=self.policy,
            cpuinfo=self.tmp / "cpuinfo", cmdline=self.tmp / "cmdline", journal_dir=self.tmp / "var/log/journal",
        )
        self.boot = BOOT_A
        self.klog: dict[str, list[str] | None] = {"0": list(BENIGN_KLOG), "-1": list(BENIGN_KLOG)}
        self.report = GOOD_REPORT
        self.system = "running"  # systemctl is-system-running: "stopping" while the machine shuts down
        self.helpers_made = 0
        self.clock = Clock()
        self.out = io.StringIO()
        self.env = self.make_env()

    # ---- fixtures
    def write_fingerprint(self, brand: str = BRAND, model: int = 198) -> None:
        fp = build_fingerprint(self.topo, {c.cpu: self.sim.fused_word(c.cpu) for c in self.topo.cores}, CpuId("GenuineIntel", 6, model, brand))
        (self.acc / "fingerprint.json").write_text(fp.to_json("2026-11-11T00:00:00Z"))

    def write_cpuinfo(self, brand: str = BRAND) -> None:
        (self.tmp / "cpuinfo").write_text(CPUINFO.format(brand=brand, micro=self.micro))

    def make_helper(self, env: br.Env) -> Helper:
        self.helpers_made += 1
        cfg = HelperConfig(
            lock_path=self.paths.lock, audit_path=self.paths.audit, policy_path=self.policy, port_factory=lambda: self.sim, topology_fn=arl_s_285k,
            preflight_fn=lambda: self.report, sampler_factory=lambda interval: None, simulator=True, accepted_dir=self.acc, boot_id_fn=lambda: self.boot,
            log=lambda text: None,
        )
        return Helper(cfg)

    def make_env(self) -> br.Env:
        env = br.Env(
            paths=self.paths, out=self.out, require_root=False, enforce_trust=False, boot_id=lambda: self.boot, uptime=lambda: self.clock.uptime,
            monotonic=lambda: self.clock.monotonic, wall=lambda: self.clock.wall, system_state=lambda: self.system, kernel_log=lambda boot: None if self.klog.get(boot) is None else list(self.klog[boot] or []), detect=lambda: self.topo,
            make_helper=self.make_helper, wait=self.clock.wait,
        )
        self.clock.env = env
        return env

    # ---- actions
    def new_boot(self, boot_id: str) -> None:
        """A reboot: new boot id, uptime back to the timer's 31 s, no stop request, a fresh kernel log (the CPU keeps its words: a warm boot of the simulator)."""
        self.boot = boot_id
        self.clock.uptime = self.clock.monotonic = 31.0
        self.clock.stop_at = None
        self.system = "running"
        self.clock.crash_at = None
        self.klog = {"0": list(BENIGN_KLOG), "-1": list(BENIGN_KLOG)}
        self.out.seek(0)
        self.out.truncate()
        self.env = self.make_env()

    def arm(self) -> dict[str, Any]:
        rc = br.main(["arm"], self.env)
        self.assertEqual(rc, br.EXIT_OK, self.out.getvalue())
        return self.state()

    def run_boot(self) -> int:
        return br.main(["run"], self.env)

    def state(self) -> dict[str, Any]:
        return json.loads(self.paths.state.read_text())

    def audit(self) -> list[dict[str, Any]]:
        if not self.paths.audit.exists():
            return []
        return [json.loads(line) for line in self.paths.audit.read_text().splitlines() if line.strip()]

    def boot_records(self) -> list[dict[str, Any]]:
        return [r for r in self.audit() if r.get("op") == "boot.restore"]

    def writes(self) -> int:
        return sum(1 for r in self.sim.requests if r.cmd == 0x11)
