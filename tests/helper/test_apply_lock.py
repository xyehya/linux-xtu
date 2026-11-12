"""R-B3 (assessment 05 B-07, 06 F4): the apply-scope lock and the stale-lock takeover through the real helper loop, the simulator and the real guard.

* two applies on the machine never interleave: a second one is BUSY naming the holder, audited, and its plan is not consumed;
* a helper killed mid-write (``kill -9`` of a real child holding both the apply lock and the transaction lock) does not wedge the next apply: the next
  ``tune.apply`` / ``power.apply`` takes both over, audited before anything is sent;
* a live holder is never stolen from.
No hardware: ``SimMsrPort`` / ``SimPowerFiles``, temp paths.
"""
from __future__ import annotations

import io
import json
import os
import time
import unittest
from pathlib import Path
from typing import Any

from linux_xtu import cli
from linux_xtu.guard import ENV_FLAG
from linux_xtu.guard.applylock import apply_lock_path, apply_scope
from linux_xtu.helper.ops import APPLY_SCOPED_OPS, builtin_ops
from linux_xtu.msr import SimConfig
from linux_xtu.topology import arl_s_285k

from tests.controls._support import p4, profile_text
from tests.guard.test_lockfile import POSIX, Holder

from ._support import TIMEOUT, BlockingSim
from .test_power import PowerCase
from .test_stress import START, StressCase
from .test_tune import ADVANCED, TuneCase, row, rows


def audit(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []


class Scope(unittest.TestCase):
    def test_every_apply_op_and_only_the_applies_hold_the_apply_lock(self) -> None:
        ops = builtin_ops()
        # R-B8 (H1): the measurement and the stress screen pin cpufreq caps / EPP for their run, so they hold the apply lock too
        self.assertEqual(APPLY_SCOPED_OPS, {"tune.apply", "power.apply", "runtime.apply", "vf.measure", "stress.start"})
        self.assertEqual({n for n, s in ops.items() if s.apply_scope}, APPLY_SCOPED_OPS)
        self.assertEqual({n for n, s in ops.items() if s.state is not None and s.state.value == "applying"}, {"tune.apply", "power.apply", "runtime.apply"})


class TuneApplyLock(TuneCase):
    def ready(self) -> tuple[Any, dict[str, Any]]:
        h = self.boot()
        self.read(h)
        return h, self.plan(h, rows(row("P2", curve=-30)))

    def test_an_apply_elsewhere_makes_tune_apply_busy_naming_it_and_the_plan_survives(self) -> None:
        h, plan = self.ready()
        writes = len(self.sim.writes)
        with apply_scope(self.lock, "cli apply (operator)", since=1.0):
            r = self.apply(h, plan)
        self.assertFalse(r["ok"], r)
        self.assertEqual((r["error"]["code"], r["error"]["detail"]["check"]), ("BUSY", "APPLY_BUSY"))
        self.assertEqual(r["error"]["detail"]["holder"]["pid"], os.getpid())
        self.assertIn("cli apply (operator)", r["error"]["message"])
        self.assertEqual(len(self.sim.writes), writes)  # nothing sent
        busy = [x for x in audit(self.audit) if x.get("reason") == "APPLY_BUSY"]
        self.assertEqual([(x["event"], x["op"], x["kind"]) for x in busy], [("refused", "tune.apply", "helper")])
        self.apply_ok(h, plan)  # the nonce was not burned: once the other apply is over, the same plan applies
        self.assertFalse(apply_lock_path(self.lock).exists())

    @unittest.skipUnless(POSIX, "flock and /proc")
    def test_a_live_holder_is_never_stolen_from(self) -> None:
        h, plan = self.ready()
        with Holder(apply_lock_path(self.lock)) as holder:
            before = apply_lock_path(self.lock).read_bytes()
            r = self.apply(h, plan)
            self.assertEqual(r["error"]["detail"]["check"], "APPLY_BUSY", r)
            self.assertEqual(r["error"]["detail"]["holder"]["pid"], holder.pid)
            self.assertEqual(apply_lock_path(self.lock).read_bytes(), before)
        self.assertNotIn("LOCK_TAKEOVER", [x.get("reason") for x in audit(self.audit)])

    @unittest.skipUnless(POSIX, "flock and /proc")
    def test_a_helper_killed_mid_write_does_not_wedge_the_next_apply(self) -> None:
        h, plan = self.ready()
        holder = Holder(apply_lock_path(self.lock), self.lock)  # a helper inside an apply and inside one transaction, then SIGKILL
        holder.kill()
        before = len(audit(self.audit))
        res = self.apply_ok(h, plan)
        self.assertTrue(all(rb["match"] for rb in res["readback"]), res)
        records = audit(self.audit)[before:]
        takeovers = [(x["stage"], x["stale_owner"]["pid"]) for x in records if x.get("reason") == "LOCK_TAKEOVER"]
        self.assertEqual(takeovers, [("apply", holder.pid), ("lock", holder.pid)])
        first_attempt = next(i for i, x in enumerate(records) if x["event"] == "attempt")
        self.assertLess(max(i for i, x in enumerate(records) if x.get("reason") == "LOCK_TAKEOVER"), first_attempt)
        self.assertFalse(apply_lock_path(self.lock).exists())
        self.assertFalse(self.lock.exists())

    def test_two_concurrent_applies_one_busy(self) -> None:
        """The helper's tune.apply parked inside a transaction; a CLI apply on the same machine meanwhile is BUSY, naming the helper; the helper's completes."""
        self.sim = BlockingSim(SimConfig.measured(per_point=True, reject_zero_fields=True))
        h = self.start(self.config())
        self.read(h)
        plan = self.plan(h, rows(row("P2", curve=-30)))
        self.sim.park_at = len(self.sim.requests) + 3
        h.send({"id": "ap", "op": "tune.apply", "args": {"plan_id": plan["plan_id"], "typed": "CONFIRM " + plan["nonce"]}})
        self.assertTrue(self.sim.parked.wait(TIMEOUT))
        profile = self.tmp / "p4.toml"
        profile.write_text(profile_text(p4(offset_mv=-30, ratio=55)), encoding="utf-8")
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(
            ["apply", str(profile), "--sim", "--policy", str(self.policy), "--audit", str(self.tmp / "cli-audit.jsonl"), "--lock", str(self.lock)],
            env={ENV_FLAG: "1", "USER": "tester"}, stdin=io.StringIO("CONFIRM tok\n"), stdout=out, stderr=err, token_fn=lambda: "tok",
            boot_id_fn=lambda: "test-boot", detect_fn=arl_s_285k, cpu_root=self.tmp,
        )
        self.assertEqual(code, 2, (out.getvalue(), err.getvalue()))
        self.assertIn("BUSY: another apply is in progress", err.getvalue())
        self.assertIn(f"held by pid {os.getpid()}: tune.apply (helper", err.getvalue())
        self.sim.release.set()
        r = h.response("ap", timeout=60)
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["result"]["complete"], r)
        self.assertFalse(apply_lock_path(self.lock).exists())


class MeasureAndStressHoldTheMachine(StressCase):
    """R-B8 (review of R-B3, H1): ``vf.measure`` and ``stress.start`` pin ``scaling_min/max_freq`` and EPP and restore them at the end, so they hold the apply lock for the
    whole run: an apply elsewhere meanwhile is BUSY naming them (never caps overwritten or offsets landing mid-measurement), and they are BUSY while an apply runs."""

    def cli_apply(self) -> tuple[int, str]:
        profile = self.tmp / "p4.toml"
        profile.write_text(profile_text(p4(offset_mv=-30)), encoding="utf-8")
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(
            ["apply", str(profile), "--sim", "--policy", str(ADVANCED), "--audit", str(self.tmp / "cli-audit.jsonl"), "--lock", str(self.lock)],
            env={ENV_FLAG: "1", "USER": "tester"}, stdin=io.StringIO("CONFIRM tok\n"), stdout=out, stderr=err, token_fn=lambda: "tok",
            boot_id_fn=lambda: "test-boot", detect_fn=arl_s_285k, cpu_root=self.tmp,
        )
        return code, err.getvalue()

    def test_a_cli_apply_during_a_measure_is_busy_naming_it(self) -> None:
        seen: list[tuple[int, str]] = []

        def mid_run(_s: float) -> None:
            if not seen:  # once, inside the measurement (the caps are pinned now)
                seen.append(self.cli_apply())

        self.sleep_hook = mid_run
        h = self.start_measure()
        reply = h.call("m", "vf.measure", {"mode": "quick", "units": ["P1"]}, timeout=60)
        self.assertTrue(reply["ok"], reply)
        code, err = seen[0]
        self.assertEqual(code, 2, err)
        self.assertIn("BUSY: another apply is in progress", err)
        self.assertIn("vf.measure (helper", err)
        self.assert_cpufreq_pristine()
        self.assertFalse(apply_lock_path(self.lock).exists())

    def test_vf_measure_is_busy_while_an_apply_holds_the_machine(self) -> None:
        h = self.start_measure()
        with apply_scope(self.lock, "cli apply (operator)", since=1.0):
            reply = h.call("m", "vf.measure", {"mode": "quick", "units": ["P1"]}, timeout=60)
        self.assertFalse(reply["ok"], reply)
        self.assertEqual((reply["error"]["code"], reply["error"]["detail"]["check"]), ("BUSY", "APPLY_BUSY"))
        self.assertIn("cli apply (operator)", reply["error"]["message"])
        self.assert_cpufreq_pristine()
        self.assertEqual(self.closed, 0)  # no run was started

    def test_stress_start_is_busy_while_an_apply_holds_the_machine_and_holds_it_while_it_runs(self) -> None:
        tool = self.fake("stress-ng", "stress-ng-ok", delay=0.5)
        h = self.start_stress(self.swiring(stress_ng=tool))
        with apply_scope(self.lock, "cli apply (operator)", since=1.0):
            busy = self.run_stress(h, {"units": ["P0"], "method": "integer"}, rid="s0")
        self.assertEqual((busy["error"]["code"], busy["error"]["detail"]["check"]), ("BUSY", "APPLY_BUSY"), busy)
        self.assertEqual(self.popen.calls, [])
        self.begin(h, {**START, "units": ["P0"], "method": "integer"})
        deadline = time.monotonic() + TIMEOUT
        while not apply_lock_path(self.lock).exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertIn(b"stress.start (helper", apply_lock_path(self.lock).read_bytes())
        reply = h.response("s", timeout=30)
        self.assertTrue(reply["ok"], reply)
        self.assertFalse(apply_lock_path(self.lock).exists())


class PowerApplyLock(PowerCase):
    def test_an_apply_elsewhere_makes_power_apply_busy(self) -> None:
        h = self.boot()
        plan = self.plan(h, {"pl2_w": 275})
        with apply_scope(self.lock, "cli apply (operator)", since=1.0):
            msg = self.call(h, "power.apply", {"plan_id": plan["plan_id"], "typed": "CONFIRM " + plan["nonce"]})
        self.assertEqual((msg["error"]["code"], msg["error"]["detail"]["check"]), ("BUSY", "APPLY_BUSY"), msg)
        self.assertEqual(self.zone.writes, [])
        self.assertTrue(self.apply(h, plan)["complete"])

    @unittest.skipUnless(POSIX, "flock and /proc")
    def test_a_transaction_lock_left_by_a_killed_process_is_taken_over_by_power_apply(self) -> None:
        h = self.boot()
        plan = self.plan(h, {"pl2_w": 275})
        holder = Holder(self.lock)
        holder.kill()
        before = len(self.audit_records())
        res = self.apply(h, plan)
        self.assertTrue(res["complete"], res)
        self.assertEqual(self.zone.writes, [("constraint_1_power_limit_uw", 275_000_000)])
        records = self.audit_records()[before:]
        takeover = [x for x in records if x.get("reason") == "LOCK_TAKEOVER"]
        self.assertEqual([(x["event"], x["stale_owner"]["pid"]) for x in takeover], [("error", holder.pid)])
        self.assertLess(records.index(takeover[0]), next(i for i, x in enumerate(records) if x["event"] in ("powercap_attempt", "msr_read")))
        self.assertFalse(self.lock.exists())

    @unittest.skipUnless(POSIX, "flock and /proc")
    def test_a_live_transaction_holder_still_refuses_locked(self) -> None:
        h = self.boot()
        plan = self.plan(h, {"pl2_w": 275})
        with Holder(self.lock) as holder:
            before = self.lock.read_bytes()
            msg = self.call(h, "power.apply", {"plan_id": plan["plan_id"], "typed": "CONFIRM " + plan["nonce"]})
            self.assertEqual(self.lock.read_bytes(), before)
        self.assertEqual(msg["error"]["code"], "REFUSED", msg)  # its guarded re-read of MSR 0x610 meets the live lock first
        self.assertIn(f"held by pid {holder.pid}", json.dumps(msg))
        self.assertEqual(self.zone.writes, [])
        self.assertNotIn("LOCK_TAKEOVER", [x.get("reason") for x in self.audit_records()])


if __name__ == "__main__":
    unittest.main()
