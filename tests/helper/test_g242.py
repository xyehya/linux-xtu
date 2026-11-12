"""G-242 (QA 2026-11-12): the apply / plan path of the helper.

QA-29 an apply of a plan with no write sends no mailbox transaction and ends with one closing audit record (``event result``, ``op``, ``outcome``); every other apply
run ends with one too. QA-30 the raise note belongs to a plan whose written OC word raises a ratio or a V target. QA-05 ``writes`` counts what the plan certainly
sends (the conditional per-core enable is ``conditional_writes``). QA-18 the turbo raise warning is in operator words. Simulator only.
"""
from __future__ import annotations

import json
from typing import Any

from ._support import error_code
from .test_complete_profiles import COLD, CompleteCase
from .test_tune import row, rows, texts


class G242Case(CompleteCase):
    def closing(self) -> list[dict[str, Any]]:
        """The closing records of apply runs in the audit log (``event result`` carrying an ``op`` of tune.apply / restore-accepted)."""
        out = []
        for line in self.audit.read_text().splitlines():
            rec = json.loads(line)
            if rec.get("event") == "result" and rec.get("op") in ("tune.apply", "restore-accepted"):
                out.append(rec)
        return out

    def settled_restore_helper(self) -> Any:
        h = self.boot(COLD, accepted_dir=self.accepted())
        self.read(h)
        self.restore(h)
        self.read(h)
        return h


class NothingToApply(G242Case):
    def test_an_empty_plan_sends_nothing_and_closes_with_one_record(self) -> None:
        h = self.settled_restore_helper()
        before = len(self.sim.requests)
        audit_before = len(self.closing())
        plan = self.plan(h, {"restore": "accepted"})
        self.assertEqual((plan["writes"], plan["conditional_writes"], plan["steps"], plan["nothing_to_do"]), (0, 0, [], True))
        result = self.apply_ok(h, plan)
        self.assertEqual(len(self.sim.requests), before, "not one mailbox transaction: no baseline read pass for an empty plan")
        self.assertEqual((result["writes_sent"], result["readback"], result["steps"], result["ops_used"], result["nothing_to_do"]), (0, [], [], 0, True))
        recs = self.closing()[audit_before:]
        self.assertEqual(len(recs), 1, recs)
        rec = recs[0]
        self.assertEqual((rec["op"], rec["outcome"], rec["writes_planned"], rec["writes_sent"], rec["complete"], rec["plan_id"]), ("restore-accepted", "nothing-to-do", 0, 0, True, plan["plan_id"]))

    def test_a_plan_with_writes_is_not_empty_and_its_apply_is_closed_too(self) -> None:
        h = self.boot(COLD, accepted_dir=self.accepted())
        self.read(h)
        plan = self.plan(h, rows(row("P0", curve=-10)))
        self.assertFalse(plan["nothing_to_do"])
        self.assertEqual((plan["writes"], plan["conditional_writes"]), (1, 1))
        result = self.apply_ok(h, plan)
        self.assertGreater(result["ops_used"], 0)
        rec = self.closing()[-1]
        self.assertEqual((rec["op"], rec["outcome"], rec["writes_planned"], rec["complete"], rec["readback_mismatches"]), ("tune.apply", "ok", 1, True, 0))
        self.assertGreaterEqual(rec["writes_sent"], 1)
        self.assertEqual(rec["readback_total"], 1)

    def test_a_refused_apply_is_closed_with_its_reason(self) -> None:
        from linux_xtu.mailbox import Cmd, VfWord
        from linux_xtu.msr import MailboxTransport
        from linux_xtu.msr.sim import POINT_RATIOS_ARL_S, SimConfig

        h = self.boot(SimConfig.measured(per_point=True, reject_zero_fields=True, point_ratios=dict(POINT_RATIOS_ARL_S)))
        self.read(h)
        plan = self.plan(h, rows(row("P3", points={"53": -60})))
        word = self.sim.vf(3, 0, 5).with_(offset_raw=-3)  # somebody else writes the point behind the helper's back
        MailboxTransport(self.sim, sleep=lambda s: None).transact(3, int(Cmd.VOLTAGE_FREQ_WRITE), 0, 5, word.to_u32())
        r = self.apply(h, plan)
        self.assertEqual(error_code(r), "PLAN_STALE")
        rec = self.closing()[-1]
        self.assertEqual((rec["op"], rec["outcome"], rec["code"], rec["writes_sent"]), ("tune.apply", "refused", "PLAN_STALE", 0))
        self.assertEqual(rec["check"], "STATE_CHANGED")


class RaiseNote(G242Case):
    RAISE = "this plan RAISES a ratio, V target or offset"

    def test_a_plan_whose_rows_equal_what_the_cpu_holds_has_no_raise_note(self) -> None:
        h = self.boot(COLD)
        self.read(h)
        up = self.plan(h, rows(row("P2", ratio=58, v=1.25)))
        self.assertTrue(any(t.startswith(self.RAISE) for t in texts(up)), "a planned write that raises a ratio carries the note")
        self.apply_ok(h, up)
        self.read(h)
        saved = h.call("save", "profiles.save", {"name": "as-is", "from": "read"})
        self.assertTrue(saved["ok"], saved)
        same = self.plan(h, {"profile": "as-is"})
        self.assertEqual(same["writes"], 0, same["steps"])
        self.assertFalse(any(t.startswith(self.RAISE) for t in texts(same)), texts(same))

    def test_a_lowering_write_is_no_raise(self) -> None:
        h = self.boot(COLD)
        self.read(h)
        self.apply_ok(h, self.plan(h, rows(row("P2", ratio=58, v=1.25))))
        self.read(h)
        down = self.plan(h, rows(row("P2", ratio=58, v=1.2)))
        self.assertGreater(down["writes"], 0)
        self.assertFalse(any(t.startswith(self.RAISE) for t in texts(down)), texts(down))


class PlainWords(G242Case):
    def test_the_turbo_raise_warning_has_no_capitals_and_no_plural_marker(self) -> None:
        h = self.boot(COLD)
        self.read(h)
        p = self.plan(h, {"turbo": {"P": [57, 57, 56, 55, 55, 55, 55, 55]}})
        raise_text = [w["text"] for w in p["warnings"] if w["code"] == "TURBO_RAISE"]
        self.assertEqual(raise_text, ["Raises the P turbo table at 3 busy cores (applies to all P-cores)."])
        self.assertNotIn("(s)", raise_text[0])
        self.assertFalse(any(c.isupper() for c in raise_text[0][1:].replace("P turbo", "").replace("P-cores", "")))


class TurboReadBack(G242Case):
    def test_a_turbo_write_has_one_read_back_record_per_cpu_read_and_each_names_its_cpu(self) -> None:
        """QA-11: the audit shows two ``readback`` records for one ``0x1AD`` write. They are the two reads the guard makes on purpose (the writing CPU and a verify CPU,
        T-023) and each carries ``readback_cpu``; nothing logs the same read twice."""
        h = self.boot(COLD)
        self.read(h)
        plan = self.plan(h, {"turbo": {"P": [56, 56, 55, 55, 55, 55, 55, 55]}})
        self.apply_ok(h, plan)
        records = [json.loads(line) for line in self.audit.read_text().splitlines()]
        reads = [r for r in records if r.get("event") == "readback" and r.get("msr") in ("0x000001AD", "0x1AD")]
        self.assertEqual(len(reads), 2, reads)
        self.assertEqual(len({r["readback_cpu"] for r in reads}), 2, "two different CPUs: not a duplicate")
        self.assertTrue(all(r["verified"] is True for r in reads))


class ClosingSummary(G242Case):
    def test_the_closing_record_says_what_was_written_in_words(self) -> None:
        """G-249 (R2-04): the Audit row is named from this, not from the internal plan name."""
        h = self.boot(COLD, accepted_dir=self.accepted())
        self.read(h)
        self.apply_ok(h, self.plan(h, rows(row("P0", curve=-10))))
        rec = self.closing()[-1]
        self.assertEqual(rec["summary"], "P0 whole curve")
        self.assertTrue(rec["name"].startswith("tune-"), "the plan's internal name stays in the record; the UI does not show it")
