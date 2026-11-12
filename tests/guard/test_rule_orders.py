"""Orderings the guard enforces (assessment 2026-11-11, 05-backend-correctness.md B-04 / B-05; D-049, D-053 item 5).

* B-04: on a LOWERING of a core's ratio the ``0x1D`` may come before the ``0x11`` words (frequency first), so the core never runs its old ratio on the new, lower voltage. ``0x1D``
  sets the CPU's maximum ratio ``0x1C[7:0]`` ``[MEASURED lnx 2026-10-13]``. Allowed only as a lowering of that maximum and of the ratio in force, and only before any ``0x11`` of the
  CPU this session; it binds the next ``0x11 P2=0`` to its ratio. Nothing else is loosened.
* B-05: a turbo ratio table may not rise with the active-core count (P ``0x1AD`` and E ``0x650``): refused by the guard on every plain write. PL1 <= PL2: the policy predicate the power
  planner refuses with (powercap writes do not pass through ``WriteGuard``).

E cluster 0 words (CPU 8, ``[MEASURED win 2026-10-01]`` unless noted): ``0x1C`` = ``0x2E30`` (48), fused ``0x09`` = ``0x4A02E`` (46x, 1184 raw), ``0x28`` = ``0x56D``, ``0x26`` = 3;
the OC word is the assessment's B-04 example, 48x at 1.175 V lowered to 47x at 1.097 V.
"""
from __future__ import annotations

import unittest

from linux_xtu.guard import CHECKS, Refusal, Request, default_m1_policy
from linux_xtu.guard.policy import _check_turbo_ratio_bounded, build_context, pl_order_problem, turbo_order_problem
from linux_xtu.mailbox import VfWord
from linux_xtu.topology import arl_s_285k

from .test_measured_checks import MeasuredCase
from .test_msr_plain import E_TABLE, P_TABLE, PlainCase, table

OC_48 = VfWord(48, 1203, False, 0).to_u32()  # 48x at 1.175 V (round(1.175 * 1024) = 1203)
CPU8 = dict(cpu=8, vf=OC_48, favored=0x2E30, fused=0x4A02E, granular=0x3)
V_LOW = 1123  # 1.097 V


def vf(ratio: int, v_raw: int) -> int:
    return VfWord(ratio, v_raw, False, 0).to_u32()


class FrequencyFirstLowering(MeasuredCase):
    def setUp(self) -> None:
        super().setUp()
        self.transport.state[(8, 0x28, 0, 0)] = 0x56D

    def open(self, which=("10", "1C", "09", "26")):
        guard = self.session(CPU8, which)
        guard.execute(self.read_req(8, 0x28), self.confirm)
        return guard

    def test_0x1d_first_then_the_two_words_then_0x27(self) -> None:
        guard = self.open()
        start = len(self.transport.calls)
        self.assertIs(guard.execute(self.fav_write(8, 47), self.confirm).verified, True)
        self.assertIs(self.vf_write(guard, 8, vf(47, 1203)).verified, True)  # frequency first: the new ratio on the old target
        self.assertIs(self.vf_write(guard, 8, vf(47, V_LOW)).verified, True)  # then the lower target
        self.assertIs(guard.execute(self.gran_write(8, 3), self.confirm).verified, True)
        sent = [(cmd, data) for _, cmd, _, _, data in self.transport.calls[start:] if cmd in (0x11, 0x1D, 0x27)]
        self.assertEqual(sent, [(0x1D, 47), (0x11, vf(47, 1203)), (0x11, vf(47, V_LOW)), (0x27, 3)])
        self.assertFalse(guard.tripped)

    def test_the_next_0x11_must_carry_the_0x1d_ratio(self) -> None:
        guard = self.open()
        guard.execute(self.fav_write(8, 47), self.confirm)
        for word in (vf(46, 1203), vf(48, 1203), vf(48, V_LOW)):
            exc = self.assert_refused(guard, self.write_req(word, cpu=8), Refusal.CHECK_FAILED)
            self.assertIn("must carry ratio 47", exc.detail)
        self.assertIs(self.vf_write(guard, 8, vf(47, 1203)).verified, True)
        self.assertIs(self.vf_write(guard, 8, vf(47, V_LOW)).verified, True)  # the binding ends with the first 0x11

    def test_a_0x1d_first_must_lower_the_maximum_and_the_ratio_in_force(self) -> None:
        guard = self.open()
        for data in (48, 49, 0x3030, 0):
            exc = self.assert_refused(guard, self.fav_write(8, data), Refusal.CHECK_FAILED)
            self.assertIn("no 0x11 word was executed", exc.detail)

    def test_without_the_oc_word_read_there_is_no_0x1d_first(self) -> None:
        guard = self.open(which=("1C", "09", "26"))
        self.assert_refused(guard, self.fav_write(8, 47), Refusal.CHECK_FAILED)

    def test_after_a_0x11_the_0x1d_still_follows_it(self) -> None:
        guard = self.open()
        self.vf_write(guard, 8, vf(47, 1203))
        self.assert_refused(guard, self.fav_write(8, 46), Refusal.CHECK_FAILED)  # lowers, but a 0x11 was sent: the 0x1D is that word's ratio
        self.assertIs(guard.execute(self.fav_write(8, 47), self.confirm).verified, True)

    def test_the_revert_plan_runs_voltage_first(self) -> None:
        guard = self.open()
        for req in (self.fav_write(8, 47), self.write_req(vf(47, 1203), cpu=8), self.write_req(vf(47, V_LOW), cpu=8), self.gran_write(8, 3)):
            guard.execute(req, self.confirm)
        undo = guard.revert_plan()
        self.assertEqual([(r.cmd, r.data) for r in undo], [(0x11, vf(47, 1203)), (0x11, OC_48), (0x1D, 48), (0x27, 3)])
        for req in undo:
            self.assertIs(guard.execute(req, self.confirm).verified, True, req)
        self.assertEqual(self.transport.state[(8, 0x10, 0, 0)], OC_48)
        self.assertEqual(self.transport.state[(8, 0x1C, 0, 0)] & 0xFF, 48)

    def test_a_0x1d_first_whose_0x11_never_followed_is_taken_back_by_its_revert(self) -> None:
        # review finding 3: 0x1D = 47 (max 48) and then nothing (or a 0x11 that pcode refuses): the revert's 0x1D = 48 restores the 0x1C[7:0] read this session and ends the binding
        guard = self.open()
        guard.execute(self.fav_write(8, 47), self.confirm)
        self.transport.rc_on_call[len(self.transport.calls) + 1] = 0x3  # pcode refuses the 0x11 (RatioExceedsLimits): nothing was written
        self.assertEqual(self.vf_write(guard, 8, vf(47, 1203)).response.rc, 3)
        undo = guard.revert_plan()
        self.assertEqual([(r.cmd, r.data) for r in undo], [(0x1D, 48)])
        self.assertIs(guard.execute(undo[0], self.confirm).verified, True)
        self.assertEqual(self.transport.state[(8, 0x1C, 0, 0)] & 0xFF, 48)
        self.assertIs(self.vf_write(guard, 8, vf(48, 1203)).verified, True)  # no binding any more: the next 0x11 may carry the ratio in force
        self.assert_refused(guard, self.fav_write(8, 49), Refusal.CHECK_FAILED)  # the undo branch takes exactly the read value back, nothing above it

    def test_the_undo_branch_needs_a_pending_binding(self) -> None:
        guard = self.open()
        exc = self.assert_refused(guard, self.fav_write(8, 48), Refusal.CHECK_FAILED)  # 48 = 0x1C[7:0] read, but no 0x1D was sent ahead: not an undo
        self.assertIn("no 0x11 word was executed", exc.detail)

    def test_a_0x1d_with_an_unknown_outcome_still_binds(self) -> None:
        guard = self.open()
        self.transport.raise_on_call[len(self.transport.calls) + 1] = TimeoutError("mailbox busy")
        with self.assertRaises(TimeoutError):
            guard.execute(self.fav_write(8, 47), self.confirm)
        self.assertTrue(guard.tripped)
        self.assertEqual(guard._context(Request(8, 0x11, 0, 0, 0, "probe")).favored_pending, 47)
        self.assertEqual([(r.cmd, r.data) for r in guard.revert_plan()], [(0x1D, 48)])

    def test_a_caller_without_unit_facts_still_gets_the_old_rule(self) -> None:
        # the planner's mirror passes no unit facts today: a 0x1D before any 0x11 is refused there, exactly as before B-04
        c = build_context(default_m1_policy(arl_s_285k()), 8, favored_word=0x2E30, fused_word=0x4A02E, vf_word_sent=None)
        ok, detail = CHECKS["favored_ratio_follows_vf"](Request(8, 0x1D, 0, 0, 47, "b04"), 0x2E30, {}, c)
        self.assertFalse(ok)
        self.assertIn("no 0x11 word was executed", detail)
        c = build_context(default_m1_policy(arl_s_285k()), 8, favored_word=0x2E30, fused_word=0x4A02E, vf_word_sent=None, unit_words={0: OC_48})
        self.assertEqual(CHECKS["favored_ratio_follows_vf"](Request(8, 0x1D, 0, 0, 47, "b04"), 0x2E30, {}, c), (True, "ok"))


class TurboTablesMayNotRise(PlainCase):
    def test_the_rule(self) -> None:
        for buckets in ((57, 57, 55, 55, 55, 55, 55, 55), (48,) * 8, (60, 58, 56, 54, 52, 50, 48, 46)):
            self.assertIsNone(turbo_order_problem(table(*buckets)), buckets)
        for buckets, bucket in (
            ((55, 57, 55, 55, 55, 55, 55, 55), 1),  # assessment 03 R-16, P
            ((48, 48, 49, 48, 48, 48, 48, 48), 2),  # E
            ((57, 57, 55, 55, 55, 56, 55, 55), 5),  # 5 active at 55x, 6 active at 56x
            ((47, 47, 47, 47, 47, 47, 46, 47), 7),
        ):
            problem = turbo_order_problem(table(*buckets))
            self.assertIsNotNone(problem, buckets)
            self.assertIn(f"bucket {bucket} ", problem)
            self.assertIn("D-049", problem)

    def test_the_cpu_limit_check_does_not_judge_the_shape(self) -> None:
        # turbo_ratio_bounded stays the CPU-limit check; the ordering is a separate guard rule (so a planner can call either)
        from linux_xtu.guard.policy import MsrCheckContext
        from linux_xtu.guard import MsrRequest

        ok, _ = _check_turbo_ratio_bounded(MsrRequest(0, 0x650, table(48, 48, 49, 48, 48, 48, 48, 48), "t", "write", 8), E_TABLE, {}, MsrCheckContext("E", 120, ""))
        self.assertTrue(ok)

    def test_the_guard_refuses_a_rising_table_and_sends_nothing(self) -> None:
        guard = self.guard()
        for msr, base, rising in ((0x650, E_TABLE, table(48, 48, 49, 48, 48, 48, 48, 48)), (0x1AD, P_TABLE, table(55, 57, 55, 55, 55, 55, 55, 55))):
            with self.subTest(msr=hex(msr)):
                self.baseline(guard, msr)
                exc = self.refused(guard, self.wr(rising, msr), Refusal.CHECK_FAILED)
                self.assertIn("turbo_order", exc.detail)
                self.assertEqual(self.sim.rdmsr(0, msr), base)

    def test_a_lowering_that_leaves_a_rise_is_refused_too(self) -> None:
        guard = self.guard()
        self.baseline(guard, 0x650)
        self.refused(guard, self.wr(table(47, 48, 48, 48, 48, 48, 48, 48)), Refusal.CHECK_FAILED)  # lowers bucket 0 only: 1 active core below 2

    def test_non_increasing_tables_are_written(self) -> None:
        guard = self.guard()
        self.baseline(guard, 0x650)
        self.assertTrue(guard.execute(self.wr(table(47, 47, 47, 47, 47, 47, 47, 47)), self.confirm).verified)  # the accepted state's E 47x8
        self.baseline(guard, 0x1AD)
        self.assertTrue(guard.execute(self.wr(table(57, 57, 55, 55, 55, 55, 55, 55), 0x1AD, verify=8), self.confirm).verified)  # the accepted state's P table


class PowerLimitsKeepPl1AtOrBelowPl2(unittest.TestCase):
    def test_the_rule(self) -> None:
        self.assertIsNone(pl_order_problem(250, 253))
        self.assertIsNone(pl_order_problem(253, 253))
        problem = pl_order_problem(254, 253)
        self.assertIsNotNone(problem)
        self.assertIn("POWER_ORDER", problem)
        self.assertIn("PL1 (254 W)", problem)

    def test_an_unknown_side_has_no_order_to_keep(self) -> None:
        self.assertIsNone(pl_order_problem(None, 100))
        self.assertIsNone(pl_order_problem(300, None))


if __name__ == "__main__":
    unittest.main()
