"""G-248 helper items: 2 (QA-13) the progress events of tune.apply count OC-mailbox transactions only, like the heartbeat; 13 a nothing-to-do plan names the read it rests on;
14 residual OC-point rewrites are counted in the plan; 15 every claimed apply closes with a record. Simulator only."""
from __future__ import annotations

import json
import unittest
from pathlib import Path
import re
from typing import Any
from unittest import mock

from linux_xtu.helper import ops_tune_apply
from linux_xtu.mailbox import VfWord

from ._support import error_code
from .test_complete_profiles import COLD
from .test_cpu_facts import FactsCase
from .test_g242 import G242Case
from .test_tune import row, rows
from .test_tune_residual import RestoreResidualCase


class ProgressCountsMailboxOnly(FactsCase):
    def attempts(self) -> tuple[int, int]:
        """(all attempts, mailbox attempts) of the audit log."""
        total = mbx = 0
        for line in self.audit.read_text().splitlines():
            rec = json.loads(line)
            if rec.get("event") == "attempt":
                total += 1
                mbx += 0 if rec.get("msr_kind") == "write" else 1
        return total, mbx

    def test_a_turbo_table_write_does_not_move_ops_used_of_the_progress_events(self) -> None:
        h = self.boot_with(baseline=False)
        self.read(h)
        intent: dict[str, Any] = {**rows(row("P1", curve=-20)), "turbo": {"P": [57, 57, 56, 55, 55, 55, 55, 55]}}
        p = self.plan(h, intent)
        start = len(h.messages)
        res = self.apply_ok(h, p)
        self.assertEqual(res["msr_writes"], 1)
        progress = [m for m in h.messages[start:] if m.get("event") == "progress"]
        self.assertTrue(progress)
        total, mbx = self.attempts()
        self.assertGreater(total, mbx, "the audit log holds an MSR write besides the mailbox requests")
        self.assertEqual(progress[-1]["ops_used"], mbx, "ops_used is the mailbox count, not the guard's attempts")
        used = [m["ops_used"] for m in progress]
        self.assertEqual(used, sorted(used), "never goes down")


class TurboReadbackRecords(FactsCase):
    def test_a_turbo_write_logs_two_adjacent_readbacks_the_audit_screen_pairs(self) -> None:
        """QA-11: the shape views/audit.js pairReadbacks relies on: adjacent ``readback`` records, same msr / expected / operator, different ``readback_cpu``."""
        h = self.boot_with(baseline=False)
        self.read(h)
        self.apply_ok(h, self.plan(h, {"turbo": {"P": [57, 57, 56, 55, 55, 55, 55, 55]}}))
        recs = [json.loads(line) for line in self.audit.read_text().splitlines()]
        rb = [i for i, r in enumerate(recs) if r.get("event") == "readback" and r.get("msr") is not None]
        self.assertEqual(len(rb), 2, rb)
        a, b = recs[rb[0]], recs[rb[1]]
        self.assertEqual(rb[1], rb[0] + 1)
        self.assertEqual((a["msr"], a["expected"], a["operator"]), (b["msr"], b["expected"], b["operator"]))
        self.assertEqual(a["readback_cpu"], 0)
        self.assertNotEqual(a["readback_cpu"], b["readback_cpu"])


class NothingToDoIsHonest(G242Case):
    ISO = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")

    def test_a_nothing_to_do_plan_and_its_result_name_the_read_they_rest_on(self) -> None:
        h = self.settled_restore_helper()
        plan = self.plan(h, {"restore": "accepted"})
        self.assertTrue(plan["nothing_to_do"])
        self.assertEqual(plan["residual_writes_max"], 0)
        self.assertRegex(plan["based_on_read_at"], self.ISO)
        before = len(self.sim.requests)
        result = self.apply_ok(h, plan)
        self.assertEqual(len(self.sim.requests), before, "still not one mailbox transaction")
        self.assertTrue(result["nothing_to_do"])
        self.assertEqual(result["based_on_read_at"], plan["based_on_read_at"])

    def test_a_restore_without_any_read_is_never_nothing_to_do(self) -> None:
        h = self.boot(COLD, accepted_dir=self.accepted())
        plan = self.plan(h, {"restore": "accepted"})
        self.assertFalse(plan["nothing_to_do"])
        self.assertIsNone(plan["based_on_read_at"])

    def test_an_ordinary_plan_carries_the_read_time_and_the_apply_result_too(self) -> None:
        h = self.boot(COLD, accepted_dir=self.accepted())
        self.read(h)
        plan = self.plan(h, rows(row("P0", curve=-10)))
        self.assertRegex(plan["based_on_read_at"], self.ISO)
        self.assertEqual(self.apply_ok(h, plan)["based_on_read_at"], plan["based_on_read_at"])

    def test_a_nothing_to_do_plan_without_a_stored_read_is_refused_read_first(self) -> None:
        h = self.settled_restore_helper()
        with mock.patch("linux_xtu.helper.ops_tune_plan._state_known_at", return_value=None):
            r = h.call("p", "tune.plan", {"intent": {"restore": "accepted"}})
        self.assertEqual(error_code(r), "REFUSED", r)
        self.assertEqual(r["error"]["detail"]["check"], "READ_FIRST")
        self.assertIn("Read first", r["error"]["message"])


class ResidualWritesAreCounted(RestoreResidualCase):
    def test_a_restore_that_may_rewrite_a_leftover_oc_point_says_how_many_writes_at_most(self) -> None:
        h = self.boot_with_sysfs()
        self.read(h)
        plan = self.plan(h, {"restore": "accepted"})
        self.assertFalse(plan["nothing_to_do"])
        self.assertEqual(plan["residual_writes_max"], 16, "EC1 only: four CPUs, at most 4 writes each")
        self.assertEqual(len(plan["steps"]), plan["writes"] + plan["conditional_writes"], "steps stay writes + conditional; the residual rows are separate")
        before = len(self.sim.requests)
        self.apply_ok(h, plan)
        sent = [r for r in self.sim.requests[before:] if r.cmd in (0x11, 0x1D, 0x27)]
        self.assertTrue(sent)
        self.assertLessEqual(len(sent), plan["writes"] + plan["conditional_writes"] + plan["residual_writes_max"])

    def test_no_leftover_means_zero(self) -> None:
        h = self.boot(COLD, accepted_dir=self.accepted())
        self.read(h)
        self.assertEqual(self.plan(h, {"restore": "accepted"})["residual_writes_max"], 0)


class ClosingRecords(G242Case):
    def setUp(self) -> None:
        super().setUp()
        self.h = self.boot(COLD, accepted_dir=self.accepted())
        self.read(self.h)

    def apply_with(self, plan: dict[str, Any], **extra: Any) -> dict[str, Any]:
        return self.h.call("ap", "tune.apply", {"plan_id": plan["plan_id"], "typed": "CONFIRM " + plan["nonce"], **extra}, timeout=60)

    def test_an_intent_changed_refusal_still_closes_with_a_record(self) -> None:
        intent = rows(row("P0", curve=-10))
        plan = self.plan(self.h, intent)
        before = len(self.closing())
        r = self.apply_with(plan, intent=rows(row("P0", curve=-20)))
        self.assertEqual(error_code(r), "PLAN_STALE", r)
        recs = self.closing()[before:]
        self.assertEqual(len(recs), 1, recs)
        self.assertEqual((recs[0]["outcome"], recs[0]["code"], recs[0]["writes_sent"], recs[0]["check"], recs[0]["plan_id"]), ("refused", "PLAN_STALE", 0, "INTENT_CHANGED", plan["plan_id"]))

    def test_a_run_that_dies_midway_closes_with_the_writes_known_so_far(self) -> None:
        plan = self.plan(self.h, rows(row("P0", curve=-10)))
        before = len(self.closing())

        def dies(profile, **kw):  # type: ignore[no-untyped-def]
            kw["progress"]("step 1: P0 apply: enable per-core voltage")
            kw["progress"]("step 2: P0 apply: write V/F word")
            kw["progress"]("step 3: P0 read-back")
            raise RuntimeError("boom")

        with mock.patch.object(ops_tune_apply, "apply_profile", dies):
            r = self.apply_with(plan)
        self.assertFalse(r["ok"], r)
        recs = self.closing()[before:]
        self.assertEqual(len(recs), 1, recs)
        self.assertEqual((recs[0]["outcome"], recs[0]["code"], recs[0]["writes_sent"]), ("error", "INTERNAL", 2))


class OffsetGoldenFixture(unittest.TestCase):
    """Item 12 (QA-04): the UI's snapOffsetMv is tested against this table; here the table is tested against the helper's encoder, so neither can drift alone."""

    def test_the_fixture_is_the_encoders_rounding_for_every_mv(self) -> None:
        path = Path(__file__).resolve().parents[2] / "desktop" / "app" / "ui" / "tests" / "offset-golden.json"
        golden = json.loads(path.read_text(encoding="utf-8"))["raw"]
        self.assertEqual(sorted(map(int, golden)), list(range(-250, 51)))
        for mv, raw in golden.items():
            self.assertEqual(VfWord.mv_to_offset_raw(int(mv)), raw, mv)
