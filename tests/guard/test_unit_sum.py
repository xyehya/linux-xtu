"""B-01 (assessment 2026-11-11, 05-backend-correctness.md): the guard judges a voltage raise by the SUM of a unit's contributions, not word by word, and fails closed.

Fact: the whole-curve offset (``P2 = 0`` ``[31:21]``) adds to every point's own offset ``[MEASURED lnx 2026-10-11/12, docs/knowledge/platform-arl-s.md §3]``; an offset on the OC
point's slot moved the OC point (ring, ``[MEASURED lnx 2026-10-15]``). Before B-01 each ``0x11`` was checked alone, so two writes that each pass could request more than the
CPU's ``0x28`` limit. Reference words (the assessment's demonstration): P CPU 0 fused ``0x09`` = ``0x0005B439`` (57x, 0x5B4 = 1460 raw = 1.4258 V), ``0x28`` = ``0x681``
(limit raw - 1 = 0x680 = 1664 raw = 1.625 V) ``[MEASURED win 2026-10-01]``; +190 mV = raw 195: 1460 + 195 = 1655 passes alone, 1460 + 195 + 195 = 1850 (1.807 V) does not.

Fail closed: a write that raises the unit's sum above its no-offset base needs the unit's whole V/F point table read this session (``0x10 P2 = 1, 2, ...`` until rc ``0x11``),
because an unread point offset would add to it. The sum covers the CPUs of an E cluster together (a write may reach the whole cluster, C-4 open).
Every refusal sends nothing (``assert_refused`` checks the recording transport and the audit log).
"""
from __future__ import annotations

import dataclasses
import unittest

from linux_xtu.guard import Policy, Refusal, Request, default_m1_policy, load_policy
from linux_xtu.guard.policy import (
    CPU_LIMIT_UNREAD,
    _check_vf_bounded,
    _check_vf_point_offset_bounded,
    build_context,
    curve_units_of,
    point_table_walked,
    summed_voltage_raw,
)
from linux_xtu.mailbox import VfWord
from linux_xtu.topology import arl_s_285k

from .fakes import seed_point_table
from .test_guard import GuardCase
from .test_point_offsets import with_points

POLICY = default_m1_policy(arl_s_285k())
OC_120 = 0x778  # cmd 0x01: 120x, ratio OC ok [MEASURED win 2026-10-01]
FUSED_P0 = 0x0005B439  # cmd 0x09 P1=0x11 of CPU 0: 57x, V 0x5B4 [MEASURED win 2026-10-01]
VMAX_P = 0x681  # cmd 0x28 of a P CPU [MEASURED win 2026-10-01]
LIMIT_P = 0x680  # XTU's raw - 1
V_P0 = 0x5B4
PLUS_190 = VfWord.mv_to_offset_raw(190)  # 195 raw
FUSED_E8 = 0x0004A02E  # E CPU 8: 46x, V 0x4A0 = 1184 raw [MEASURED win 2026-10-01]
VMAX_E = 0x56D  # limit 0x56C = 1388 raw
LIMIT_E = 0x56C
V_E = 0x4A0


def w(ratio: int, v_raw: int = 0, offset_raw: int = 0) -> int:
    return VfWord(ratio, v_raw, False, offset_raw).to_u32()


def ctx(unit_words=None, *, cpu: int = 0, fused: int | None = FUSED_P0, vmax: int | None = VMAX_P, favored: int = 0x3939, ring_vmax: int | None = None, walked: bool = True, peers=()):
    """A bound context with the unit facts; ``walked``: the unit's point table was read to its end this session."""
    return build_context(
        POLICY, cpu, favored_word=favored, fused_word=fused, vf_word_sent=None, max_voltage_word=vmax, oc_cap_words_of_kind=(OC_120,),
        ring_max_voltage_word=ring_vmax, unit_words=unit_words, point_table_read=walked, unit_peer_words=peers,
    )


def curve(new: int, baseline: int, c, cpu: int = 0):
    return _check_vf_bounded(Request(cpu, 0x11, 0, 0, new, "b01"), baseline, {}, c)


def point(new: int, baseline: int, c, p2: int = 8, p1: int = 0, cpu: int = 0):
    return _check_vf_point_offset_bounded(Request(cpu, 0x11, p1, p2, new, "b01"), baseline, {}, c)


class TheAssessmentScenario(unittest.TestCase):
    """The two writes of B-01: whole-curve +190 mV and point 8 (57x) +190 mV on P CPU 0."""

    def test_each_write_passes_alone_which_is_the_gap(self) -> None:
        # a caller with no unit facts (unit_words None: the planner's mirror today) gets the per-word checks only -- both pass, the sum is 1.807 V
        self.assertEqual(curve(w(57, 0, PLUS_190), w(57), ctx()), (True, "ok"))
        self.assertEqual(point(w(57, 0, PLUS_190), w(57), ctx()), (True, "ok"))
        self.assertGreater(V_P0 + 2 * PLUS_190, LIMIT_P)
        self.assertLessEqual(V_P0 + PLUS_190, LIMIT_P)

    def test_whole_curve_first_then_the_point_is_refused(self) -> None:
        ok, detail = curve(w(57, 0, PLUS_190), w(57), ctx({0: w(57), 8: w(57)}))
        self.assertTrue(ok, detail)
        ok, detail = point(w(57, 0, PLUS_190), w(57), ctx({0: w(57, 0, PLUS_190), 8: w(57)}))
        self.assertFalse(ok)
        self.assertIn("summed voltage 0x73a", detail)  # 1460 + 195 + 195 = 1850
        self.assertIn("cmd 0x28", detail)

    def test_point_first_then_the_whole_curve_is_refused(self) -> None:
        ok, detail = point(w(57, 0, PLUS_190), w(57), ctx({0: w(57), 8: w(57)}))
        self.assertTrue(ok, detail)
        ok, detail = curve(w(57, 0, PLUS_190), w(57), ctx({0: w(57), 8: w(57, 0, PLUS_190)}))
        self.assertFalse(ok)
        self.assertIn("summed voltage 0x73a", detail)

    def test_the_sum_is_allowed_up_to_the_limit_exactly(self) -> None:
        rest = LIMIT_P - V_P0 - PLUS_190  # 9 raw left above 1460 + 195
        ok, detail = point(w(57, 0, rest), w(57), ctx({0: w(57, 0, PLUS_190), 8: w(57)}))
        self.assertTrue(ok, detail)
        ok, detail = point(w(57, 0, rest + 1), w(57), ctx({0: w(57, 0, PLUS_190), 8: w(57)}))
        self.assertFalse(ok)


class AnUnreadPointTableFailsClosed(unittest.TestCase):
    def test_a_raise_of_the_sum_without_the_walk_is_cpu_limit_unread(self) -> None:
        for label, verdict in (
            ("whole curve", curve(w(57, 0, 10), w(57), ctx({0: w(57)}, walked=False))),
            ("point", point(w(57, 0, 10), w(57), ctx({0: w(57), 8: w(57)}, walked=False))),
        ):
            ok, detail = verdict
            self.assertFalse(ok, label)
            self.assertIn(CPU_LIMIT_UNREAD, detail)
            self.assertIn("0x10 P1=0 P2=1, 2, ... until one answers rc 0x11", detail)

    def test_what_does_not_raise_the_sum_needs_no_walk(self) -> None:
        unread = dict(walked=False, vmax=None)
        self.assertEqual(curve(w(57, 0, -50), w(57), ctx({0: w(57)}, **unread)), (True, "ok"))  # a negative whole-curve offset
        self.assertEqual(point(w(57, 0, -75), w(57), ctx({0: w(57), 8: w(57)}, **unread)), (True, "ok"))  # a negative point offset (the accepted state's P points)
        self.assertEqual(curve(w(55), w(57), ctx({0: w(57)}, **unread)), (True, "ok"))  # a lower ratio
        # an OC point whose target sits below the fused top voltage (the accepted state's E 47x at 1.077 / 1.097 V): no raise of the sum above its base
        for mv in (1077, 1097):
            c = build_context(POLICY, 8, favored_word=0x2E2E, fused_word=FUSED_E8, vf_word_sent=None, max_voltage_word=None, oc_cap_words_of_kind=(OC_120,), unit_words={0: 0x0, 6: w(46, 0, -102)})
            self.assertEqual(_check_vf_bounded(Request(8, 0x11, 0, 0, w(47, round(mv * 1.024)), "b01"), 0x0, {}, c), (True, "ok"), mv)

    def test_the_walk_rule(self) -> None:
        self.assertTrue(point_table_walked([1, 2, 3, 4, 5, 6], 7))
        self.assertTrue(point_table_walked([], 1))
        self.assertFalse(point_table_walked([1, 2, 3, 5, 6], 7))  # a gap
        self.assertFalse(point_table_walked([1, 2, 3, 4, 5, 6], None))  # the end was never seen


class EndToEndThroughTheGuard(GuardCase):
    """Through ``WriteGuard`` with the recording transport: the guard builds the unit facts from what it read and wrote, and walks are real reads (rc 0x11 at P2 9)."""

    def setUp(self) -> None:
        super().setUp()
        self.policy = with_points(dataclasses.replace(self.policy, max_operations_per_session=80, max_operations_per_boot=800))
        for key, word in (((0, 0x10, 0, 0), w(57)), ((0, 0x1C, 0, 0), 0x3939), ((0, 0x09, 0x11, 0), FUSED_P0), ((0, 0x28, 0, 0), VMAX_P)):
            self.transport.state[key] = word
        self.end = seed_point_table(self.transport, 0, "P")  # points 1..8, P2 9 answers rc 0x11

    def session(self, *, walk: bool = True, points=(8,), oc: bool = True):
        guard = self.make_guard()
        reads = [(0x09, 0x11, 0), (0x28, 0, 0), (0x1C, 0, 0)] + ([(0x10, 0, 0)] if oc else [])
        reads += [(0x10, 0, p) for p in (range(1, self.end + 1) if walk else points)]
        for cmd, p1, p2 in reads:
            guard.execute(self.read_req(0, cmd, p1=p1, p2=p2), self.confirm)
        return guard

    def write(self, guard, data: int, p2: int = 0):
        return guard.execute(self.write_req(data, p2=p2), self.confirm)

    def test_whole_curve_then_point_8(self) -> None:
        guard = self.session()
        self.assertIs(self.write(guard, w(57, 0, PLUS_190)).verified, True)
        exc = self.assert_refused(guard, self.write_req(w(57, 0, PLUS_190), p2=8), Refusal.CHECK_FAILED)
        self.assertIn("summed voltage", exc.detail)
        self.assertFalse(guard.tripped)

    def test_point_8_then_whole_curve(self) -> None:
        guard = self.session()
        self.assertIs(self.write(guard, w(57, 0, PLUS_190), 8).verified, True)
        exc = self.assert_refused(guard, self.write_req(w(57, 0, PLUS_190)), Refusal.CHECK_FAILED)
        self.assertIn("summed voltage", exc.detail)

    def test_review_sequence_a_point_raised_back_to_its_read_offset_is_summed(self) -> None:
        # review finding 1: point 8 read at +100, whole curve 0. 8 -> -50 (allowed), curve -> +150 (allowed), 8 -> +100 must be refused: 1460 + 150 + 100 = 1710 > 1664.
        # The old check compared +100 with the offset first READ (+100), not the one in force (-50), and skipped the sum.
        self.transport.state[(0, 0x10, 0, 8)] = w(57, 0, 100)
        guard = self.session()
        self.assertIs(self.write(guard, w(57, 0, -50), 8).verified, True)
        self.assertIs(self.write(guard, w(57, 0, 150)).verified, True)
        exc = self.assert_refused(guard, self.write_req(w(57, 0, 100), p2=8), Refusal.CHECK_FAILED)
        self.assertIn("summed voltage 0x6ae", exc.detail)  # 1710

    def test_two_sessions_that_read_only_what_they_write_are_refused(self) -> None:
        # review finding 2: two Apply clicks, each its own session, each reading only the words its profile names: point 8 +190, then whole curve +190
        first = self.session()
        self.assertIs(self.write(first, w(57, 0, PLUS_190), 8).verified, True)
        second = self.session(walk=False, points=())
        exc = self.assert_refused(second, self.write_req(w(57, 0, PLUS_190)), Refusal.CHECK_FAILED)
        self.assertIn(CPU_LIMIT_UNREAD, exc.detail)
        self.assertIn("not walked", exc.detail)
        third = self.session()  # the same write after a walk: the +190 on point 8 is seen and summed
        exc = self.assert_refused(third, self.write_req(w(57, 0, PLUS_190)), Refusal.CHECK_FAILED)
        self.assertIn("summed voltage", exc.detail)

    def test_a_positive_point_offset_without_the_p2_0_word_is_cpu_limit_unread(self) -> None:
        guard = self.session(oc=False)
        exc = self.assert_refused(guard, self.write_req(w(57, 0, 10), p2=8), Refusal.CHECK_FAILED)
        self.assertIn(CPU_LIMIT_UNREAD, exc.detail)
        self.assertIn("0x10 P1=0 P2=0", exc.detail)
        self.assertIs(self.write(guard, w(57, 0, -10), 8).verified, True)  # a negative offset needs no sum
        guard.execute(self.read_req(0, 0x10, p2=0), self.confirm)
        self.assertIs(self.write(guard, w(57, 0, 10), 8).verified, True)

    def test_an_oc_point_creating_word_voids_the_walk(self) -> None:
        # a P2 = 0 ratio above the top fused ratio adds a slot to the table (platform-arl-s.md §3): the walk must be read again before the next raise of the sum
        guard = self.session()
        self.assertIs(self.write(guard, w(58, V_P0)).verified, True)  # creates the 58x OC point (G-241: one word, ratio + target)
        exc = self.assert_refused(guard, self.write_req(w(53, 0, 10), p2=5), Refusal.CHECK_FAILED)
        self.assertIn("not walked", exc.detail)
        self.transport.state[(0, 0x10, 0, 9)] = w(58)  # the new slot
        self.transport.read_rc_at[(0, 0x10, 0, 9)] = 0
        self.transport.read_rc_at[(0, 0x10, 0, 10)] = 0x11
        for p2 in range(1, 11):
            guard.execute(self.read_req(0, 0x10, p2=p2), self.confirm)
        self.assertIs(self.write(guard, w(53, 0, 10), 5).verified, True)

    def test_a_point_found_past_the_recorded_end_drops_the_walk(self) -> None:
        guard = self.session()
        self.transport.read_rc_at[(0, 0x10, 0, 9)] = 0  # P2 9 now answers: the table grew
        self.transport.state[(0, 0x10, 0, 9)] = w(58)
        guard.execute(self.read_req(0, 0x10, p2=9), self.confirm)
        exc = self.assert_refused(guard, self.write_req(w(57, 0, 10)), Refusal.CHECK_FAILED)
        self.assertIn("not walked", exc.detail)

    def test_the_unit_facts_are_the_reads_overridden_by_the_writes_since(self) -> None:
        guard = self.session()
        self.write(guard, w(57, 0, -20), 8)
        facts = guard._context(Request(0, 0x11, 0, 8, 0, "probe"))
        self.assertEqual(facts.unit_words[8], w(57, 0, -20))
        self.assertEqual(facts.unit_words[0], w(57))
        self.assertTrue(facts.point_table_read)
        self.transport.state[(0, 0x10, 0, 8)] = w(57, 0, -30)  # something else moved it; a new read is the newer fact
        guard.execute(self.read_req(0, 0x10, p2=8), self.confirm)
        self.assertEqual(guard._context(Request(0, 0x11, 0, 8, 0, "probe")).unit_words[8], w(57, 0, -30))
        self.assertEqual(dict(guard._context(Request(0, 0x11, 2, 3, 0, "probe")).unit_words), {})  # another P1 is another unit


class TheECluster(GuardCase):
    """Review finding 5: the four CPUs of an E cluster are summed together -- a write on one may reach the whole cluster (C-4 open; one DLVR per cluster [COMMUNITY])."""

    def setUp(self) -> None:
        super().setUp()
        self.policy = with_points(dataclasses.replace(self.policy, max_operations_per_session=80, max_operations_per_boot=800))
        for cpu in range(8, 16):
            for key, word in (((cpu, 0x10, 0, 0), w(46)), ((cpu, 0x1C, 0, 0), 0x2E2E), ((cpu, 0x09, 0x11, 0), FUSED_E8), ((cpu, 0x28, 0, 0), VMAX_E)):
                self.transport.state[key] = word
            seed_point_table(self.transport, cpu, "E")

    def read(self, guard, cpu: int) -> None:
        """``cpu``'s facts and walk, plus (security review of 8604e1a, finding 1) the P2 = 0 word and walk of every other CPU of its cluster: their words count in the sum."""
        for cmd, p1, p2 in [(0x09, 0x11, 0), (0x28, 0, 0), (0x1C, 0, 0), (0x10, 0, 0)] + [(0x10, 0, p) for p in range(1, 8)]:
            guard.execute(self.read_req(cpu, cmd, p1=p1, p2=p2), self.confirm)
        for peer in sorted(self.policy.curve_cpus(cpu) - {cpu}):
            for p2 in range(0, 8):
                guard.execute(self.read_req(peer, 0x10, p2=p2), self.confirm)

    def test_a_point_on_one_cpu_and_the_whole_curve_on_another_are_summed(self) -> None:
        guard = self.make_guard()
        self.read(guard, 8)
        self.read(guard, 9)
        self.assertIs(guard.execute(self.write_req(w(46, 0, 150), cpu=8, p2=6), self.confirm).verified, True)  # 1184 + 150 = 1334 <= 1388
        exc = self.assert_refused(guard, self.write_req(w(46, 0, 150), cpu=9), Refusal.CHECK_FAILED)  # 1184 + 150 + 150 = 1484 on the cluster's curve
        self.assertIn("summed voltage", exc.detail)

    def test_another_cluster_is_another_unit(self) -> None:
        guard = self.make_guard()
        self.read(guard, 8)
        self.read(guard, 12)  # CPU 12 is cluster 1
        self.assertIs(guard.execute(self.write_req(w(46, 0, 150), cpu=8, p2=6), self.confirm).verified, True)
        self.assertIs(guard.execute(self.write_req(w(46, 0, 150), cpu=12), self.confirm).verified, True)

    def test_the_planner_shaped_cluster_write_passes_once_checked(self) -> None:
        # the planner writes the same word on the four CPUs: the first raises the cluster's sum (checked), the others restate it (no further raise)
        guard = self.make_guard()
        for cpu in (8, 9):
            self.read(guard, cpu)
        for cpu in (8, 9):
            self.assertIs(guard.execute(self.write_req(w(46, 0, 100), cpu=cpu), self.confirm).verified, True)

    def test_the_policy_knows_the_clusters_of_its_topology(self) -> None:
        topo = arl_s_285k()
        self.assertEqual(POLICY.curve_cpus(9), frozenset({8, 9, 10, 11}))
        self.assertEqual(POLICY.curve_cpus(3), frozenset({3}))
        self.assertEqual(load_policy('cpus = "auto"\n', topo).curve_cpus(13), frozenset({12, 13, 14, 15}))
        self.assertEqual(dict(curve_units_of(topo))[20], frozenset({20, 21, 22, 23}))
        self.assertEqual(POLICY.with_topology(topo).curve_cpus(9), frozenset({8, 9, 10, 11}))
        bare = Policy(cpus=frozenset(range(24)), e_cpus=frozenset(range(8, 24)))
        self.assertEqual(bare.curve_cpus(9), frozenset({9}))  # no topology bound: each CPU alone (every hardware path binds one)
        self.assertEqual(load_policy('cpus = "auto"\ne_cpus = [8, 9]\n', topo).curve_cpus(9), frozenset({9}))  # a file's own E set: the topology's clusters do not apply


class NegativeOffsetsAndLowerings(unittest.TestCase):
    def test_a_negative_whole_curve_alone_needs_no_limit(self) -> None:
        c = ctx({0: w(57, 0, -102), 8: w(57, 0, -20)}, vmax=None, walked=False)
        for raw in (-50, -1, 0):
            ok, detail = curve(w(57, 0, raw), w(57, 0, -102), c)
            self.assertTrue(ok, (raw, detail))

    def test_raising_a_negative_whole_curve_under_a_positive_point_offset_is_summed(self) -> None:
        c = ctx({0: w(57, 0, -102), 8: w(57, 0, PLUS_190)})
        self.assertEqual(curve(w(57, 0, 0), w(57, 0, -102), c), (True, "ok"))  # 1460 + 195 + 0 = 1655
        rest = LIMIT_P - V_P0 - PLUS_190
        self.assertEqual(curve(w(57, 0, rest), w(57, 0, -102), c), (True, "ok"))
        ok, detail = curve(w(57, 0, rest + 1), w(57, 0, -102), c)
        self.assertFalse(ok)
        self.assertIn("summed voltage", detail)
        # still negative, but it raises the sum above the no-offset base: the limit is needed (fail closed)
        ok, detail = curve(w(57, 0, -50), w(57, 0, -102), ctx({0: w(57, 0, -102), 8: w(57, 0, PLUS_190)}, vmax=None))
        self.assertFalse(ok)
        self.assertIn(CPU_LIMIT_UNREAD, detail)

    def test_a_negative_whole_curve_never_widens_a_points_own_bound(self) -> None:
        c = ctx({0: w(57, 0, -102), 8: w(57)})
        self.assertEqual(point(w(57, 0, LIMIT_P - V_P0), w(57), c), (True, "ok"))
        ok, detail = point(w(57, 0, LIMIT_P - V_P0 + 1), w(57), c)  # the whole-curve -100 mV would make room; the per-word bound still stands
        self.assertFalse(ok)
        self.assertIn("predicted voltage", detail)

    def test_a_lowering_is_never_blocked_by_a_sum_already_over_the_limit(self) -> None:
        over = {0: w(57, 0, 100), 8: w(57, 0, 300), 5: w(53, 0, 50)}  # 1460 + 300 + 100: set outside this session, above the limit
        for label, new in (("lower the whole curve", w(57, 0, 50)), ("whole curve to 0", w(57)), ("lower the ratio", w(55, 0, 100))):
            ok, detail = curve(new, w(57, 0, 100), ctx(over, walked=False))
            self.assertTrue(ok, (label, detail))
        ok, detail = point(w(57, 0, 200), w(57, 0, 300), ctx(over, walked=False))  # lowers point 8
        self.assertTrue(ok, detail)

    def test_a_raise_on_a_unit_already_over_the_limit_is_refused(self) -> None:
        # point 5 +50 -> +60 does not move the bound (point 8 holds it at +300) but it is a raise on a unit already over the limit: refused
        over = {0: w(57, 0, 100), 8: w(57, 0, 300)}
        ok, detail = point(w(53, 0, 60), w(53, 0, 50), ctx({**over, 5: w(53, 0, 50)}), p2=5)
        self.assertFalse(ok)
        self.assertIn("summed voltage", detail)
        ok, detail = curve(w(57, 0, 100), w(57, 0, 100), ctx({**over, 5: w(53, 0, 50)}))  # restating the whole-curve word raises nothing: allowed
        self.assertTrue(ok, detail)


class OcTargetAndItsSlot(unittest.TestCase):
    def test_an_oc_target_near_the_limit_plus_a_positive_point_offset_is_refused(self) -> None:
        # conservative (B-08 open): a positive point offset is counted on top of the OC target; the CPU clamps a target up to the offset top point (a max) [MEASURED lnx 2026-10-13]
        target = LIMIT_P - 26  # P0 58x OC point at 1.600 V
        ok, detail = curve(w(58, target), w(57), ctx({0: w(57), 8: w(57)}))
        self.assertTrue(ok, detail)
        ok, detail = curve(w(58, target), w(57), ctx({0: w(57), 8: w(57, 0, 31)}))  # +30 mV on point 8
        self.assertFalse(ok)
        self.assertIn("summed voltage", detail)

    def test_a_positive_offset_on_the_oc_slot_counts_from_the_oc_target(self) -> None:
        oc = w(47, 1350)  # E CPU 8: OC 47x at 1350 raw (1.318 V), its slot P2 = 7
        units = {0: oc, 6: w(46), 7: w(47)}
        c = ctx(units, cpu=8, fused=FUSED_E8, vmax=VMAX_E, favored=0x2E30)
        ok, detail = point(w(47, 0, LIMIT_E - 1350), w(47), c, p2=7, cpu=8)
        self.assertTrue(ok, detail)
        ok, detail = point(w(47, 0, LIMIT_E - 1350 + 1), w(47), c, p2=7, cpu=8)  # alone: fused 1184 + 39 = 1223 passes; on the 1350 target it does not
        self.assertFalse(ok)
        self.assertIn("summed voltage", detail)
        self.assertEqual(point(w(47, 0, LIMIT_E - 1350 + 1), w(47), ctx(None, cpu=8, fused=FUSED_E8, vmax=VMAX_E, favored=0x2E30), p2=7, cpu=8), (True, "ok"))  # the old per-word gap


class TheRing(unittest.TestCase):
    """Review finding 6, stated honestly: every ring point word read so far carries V target 0 [MEASURED lnx 2026-10-02/15] and the ring has no readable fused voltage, so a
    positive ring offset is refused BEFORE the sum (no base). The ring sum runs only for a point word that carries its own V target -- covered here with such a synthetic word."""

    RING_VMAX = 0x600  # limit 0x5FF

    def test_a_measured_shape_ring_point_is_refused_before_any_sum(self) -> None:
        ok, detail = point(w(28, 0, 5), w(28), ctx({0: w(40), 3: w(28)}, ring_vmax=self.RING_VMAX), p1=2, p2=3)
        self.assertFalse(ok)
        self.assertIn("the ring has no readable fused voltage", detail)

    def test_a_synthetic_ring_point_with_a_target_needs_the_ring_oc_word_and_adds_its_offset(self) -> None:
        base = w(28, 0x5F0)
        ok, detail = point(w(28, 0x5F0, 0xF), base, ctx({3: base}, ring_vmax=self.RING_VMAX), p1=2, p2=3)
        self.assertFalse(ok)
        self.assertIn(CPU_LIMIT_UNREAD, detail)
        self.assertIn("0x10 P1=2 P2=0", detail)
        ok, detail = point(w(28, 0x5F0, 0xF), base, ctx({0: w(40), 3: base}, ring_vmax=self.RING_VMAX), p1=2, p2=3)
        self.assertTrue(ok, detail)
        ok, detail = point(w(28, 0x5F0, 0xF), base, ctx({0: w(40, 0, 5), 3: base}, ring_vmax=self.RING_VMAX), p1=2, p2=3)  # BIOS ring offset +5 raw
        self.assertFalse(ok)
        self.assertIn("summed voltage", detail)
        ok, detail = point(w(28, 0x5F0, 0xF), base, ctx({0: w(40), 3: base}, ring_vmax=self.RING_VMAX, walked=False), p1=2, p2=3)
        self.assertFalse(ok)
        self.assertIn("0x10 P1=2 P2=1, 2, ...", detail)


class TheSumFunction(unittest.TestCase):
    def test_terms(self) -> None:
        total, base, _ = summed_voltage_raw(V_P0, w(57, 0, 10), [w(57, 0, 20), w(53, 0, -50)])
        self.assertEqual((total, base), (V_P0 + 20 + 10, V_P0))
        total, base, _ = summed_voltage_raw(V_P0, w(57, 0, -100), [w(57, 0, 20)])
        self.assertEqual(total, V_P0 + 20 - 100)  # the fused points move with the signed whole-curve offset [MEASURED]
        total, base, _ = summed_voltage_raw(V_P0, w(58, 1600, -100), [w(57, 0, 20)])
        self.assertEqual((total, base), (1600 + 20, 1600))  # a negative whole-curve offset is not credited to an OC target (unmeasured)
        self.assertEqual(summed_voltage_raw(V_P0, None, [])[:2], (V_P0, V_P0))

    def test_several_oc_words_count_their_largest_offset_and_target(self) -> None:
        total, base, _ = summed_voltage_raw(V_E, [w(46, 0, -20), w(46, 0, 30), w(47, 1100, 0)], [w(46, 0, 10)])
        self.assertEqual((total, base), (max(V_E + 10 + 30, 1100 + 30 + 10), V_E))


if __name__ == "__main__":
    unittest.main()
