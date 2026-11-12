"""The Windows apply path writes the same words as the Linux one for the same saved profile.

``restore_tuning.ps1`` / ``Apply-Profile.ps1`` run the shared ``linux-xtu apply`` (same planner, same encoders) with ``--device-win``; only the port differs
(ThrottleStop driver instead of ``/dev/cpu``). Here the real ``WinThrottleStopMsrPort`` runs over ``FakeWin32`` over the simulator and its mailbox WRMSRs are compared
with those of ``apply --sim`` for the same profile. No hardware, no Windows.
"""
from __future__ import annotations

import dataclasses
import unittest

from linux_xtu.msr import SimMsrPort, WinThrottleStopMsrPort
from linux_xtu.profiles.fingerprint import FINGERPRINT_FILE

from ..controls._support import sim_config
from ..fixtures.win_reference import FUSED_POINT, LP_OF_CPU, FakeWin32, reference_fingerprint
from ..test_cli import POLICY_TOML, CliCase


class WindowsWritesTheLinuxWords(CliCase):
    def setUp(self) -> None:
        super().setUp()
        self.policy_file = self.write("nodwell.toml", POLICY_TOML.replace("min_dwell_s = 60.0", "min_dwell_s = 0.0"))  # the guard's dwell is wall-clock
        self.fingerprint_file = self.write(FINGERPRINT_FILE, reference_fingerprint().to_json("2026-10-12T00:00:00Z"))

    def test_same_profile_same_mailbox_words(self) -> None:
        # Linux-side apply (the simulator stands in for /dev/cpu)
        code, out, err = self.run_cli(*self.apply_args(), stdin=self.confirmed(), sleep=lambda s: None)
        self.assertEqual(code, 0, out + err)
        linux_writes = list(self.sim.writes)
        self.assertTrue(linux_writes)

        # Windows-side apply: the same CLI command with --device-win, the real Windows port over a fake Win32 over a fresh simulator
        self.sim = SimMsrPort(dataclasses.replace(sim_config(), fused_point=dict(FUSED_POINT)))
        api = FakeWin32(sim=self.sim, cpu_of_lp={lp: cpu for cpu, lp in LP_OF_CPU.items()})
        audit, lock = self.tmp / "win-audit.jsonl", self.tmp / "win-mailbox.lock"
        args = ["apply", self.profile_file, "--device-win", "--fingerprint", self.fingerprint_file, "--policy", self.policy_file, "--audit", audit, "--lock", lock]
        code, out, err = self.run_cli(
            *args,
            stdin=self.confirmed(),
            sleep=lambda s: None,
            win_port_factory=lambda fp: WinThrottleStopMsrPort(True, api=api, fingerprint=fp),
            win_health_gate_factory=lambda bits: (lambda phase: (True, "ok")),
            win_detect_fn=lambda fp: fp.topology(),
        )
        self.assertEqual(code, 0, out + err)
        self.assertIn("identity check passed", out)
        identity = 12  # --device-win first reads the fused V/F point (cmd 0x09) of 8 P-cores + 4 E clusters: one mailbox WRMSR each, then the profile's own
        self.assertEqual({r.cmd for r in self.sim.requests[:identity]}, {0x09})
        self.assertEqual(self.sim.writes[identity:], linux_writes)


if __name__ == "__main__":
    unittest.main()
