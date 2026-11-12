"""Regression (review of R-A2, item 7): a profile shaped like the accepted state still plans and applies through the guard, sending exactly the same requests as before B-01 / B-04 /
the turbo-order rule.

Fixture ``fixtures/accepted_shape.toml``: negative per-point P offsets on all eight P-cores, E 47x OC points with adaptive targets 1.077 / 1.097 V and point 6 at -100 mV on every E
cluster, turbo P 57,57,55x6 / E 47x8. It is applied the way the restore applies it (``neutralize_residual``), with the shipped ``policies/default.toml`` bound to the CPU's own
limits the way ``tune.read`` binds them, on the simulator (``SimConfig.measured(per_point=True)``) in two start states: as booted, and with a residual E OC point at 48x / 1.185 V
left by an earlier session. ``fixtures/accepted_shape.requests.txt`` is every mailbox request the simulator latched (read-backs included) and every plain MSR write, in order;
it was produced by main before these guard changes (``7a07d29``), and the guard of this branch reproduces it byte for byte. Regenerate only on purpose: ``PYTHONPATH=src:. python3 -m tests.guard.test_accepted_shape``.
"""
from __future__ import annotations

import dataclasses
import tempfile
import unittest
from pathlib import Path

from linux_xtu.guard import load_policy
from linux_xtu.mailbox import VfWord
from linux_xtu.msr import SimConfig
from linux_xtu.profiles import load_profile
from linux_xtu.topology import arl_s_285k

from tests.controls._support import make_session

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
PROFILE = FIXTURES / "accepted_shape.toml"
EXPECTED = FIXTURES / "accepted_shape.requests.txt"
OC_MAILBOX = 0x150
E_RESIDUAL = VfWord(48, round(1.185 * 1024), False, 0)  # an earlier E 48x at 1.185 V session: an OC point only a cold boot clears


def request_log() -> tuple[list[str], list[bool]]:
    topo = arl_s_285k()
    # the shipped policy, bound to the CPU's own limits as tune.read binds them: ratio 0x01 = 120x, V 0x28 - 1 LSB = P 0x680 / E 0x56C raw [MEASURED win 2026-10-01]
    policy = load_policy(ROOT / "policies/default.toml", topo).with_hw_limits({"P": 120, "E": 120}, None, {"P": 0x680, "E": 0x56C})
    profile = load_profile(PROFILE)
    lines: list[str] = []
    oks: list[bool] = []
    base = SimConfig.measured(per_point=True)
    for label, cfg in (
        ("as booted", base),
        ("residual E OC point 48x 1.185 V", dataclasses.replace(base, initial_vf={**base.initial_vf, **{cpu: E_RESIDUAL for cpu in topo.cpus_of_kind("E")}})),
    ):
        with tempfile.TemporaryDirectory() as tmp:
            s = make_session(Path(tmp), config=cfg, policy=policy)
            report = s.apply(profile, neutralize_residual=True)
            oks.append(report.ok)
            lines.append(f"# {label}")
            lines += [f"mbox cpu {r.cpu} cmd {r.cmd:#04x} p1 {r.p1} p2 {r.p2} data {r.data:#010x}" for r in s.sim.requests]
            lines += [f"wrmsr cpu {cpu} msr {msr:#x} value {value:#018x}" for cpu, msr, value in s.sim.writes if msr != OC_MAILBOX]
    return lines, oks


class TheAcceptedShapeIsUnaffected(unittest.TestCase):
    def test_it_plans_and_applies_with_the_same_requests(self) -> None:
        lines, oks = request_log()
        self.assertEqual(oks, [True, True])
        expected = EXPECTED.read_text().splitlines()
        self.assertEqual(len(lines), len(expected))
        for n, (got, want) in enumerate(zip(lines, expected), start=1):
            self.assertEqual(got, want, f"request {n}")


if __name__ == "__main__":
    print("\n".join(request_log()[0]))
