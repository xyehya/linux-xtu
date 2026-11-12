"""B-01 follow-up (security review of R-A2 commit 8604e1a, two findings): the scope of the point-table walk the unit sum relies on.

1. The sum of an E cluster counts the words of all four CPUs (``unit_peer_words``, C-4 open: a write may reach the whole cluster), so "the table was walked" must hold for every
   CPU of the unit -- each one's ``0x10 P2 = 1, 2, ...`` until rc ``0x11``, and its ``P2 = 0`` word (the whole-curve offset). Before the fix only the request CPU's walk counted, so a
   peer CPU holding an unread positive point offset was missing from the sum. The ring (``P1 = 2``, one package-level curve read through any CPU) keeps the request CPU's walk.
2. A ``P2 = 0`` write that may create an OC point voids the walk of its unit. Whether it creates one was judged against the CORE's top fused ratio (``0x09 P1=0x11 P2=0``) for every
   P1; for another domain (the ring, ``P1 = 2``) that is the wrong table, so a new ring OC point left the walk standing. Now any ``P2 = 0`` write on a domain other than the core
   voids the walk (the domain's own top ratio is not read by this guard).

Words: E cluster 0 (CPUs 8-11), fused ``0x09`` = ``0x4A02E`` (46x, 1184 raw), ``0x28`` = ``0x56D`` (limit 0x56C = 1388 raw) ``[MEASURED win 2026-10-01]``; E point ratios
8/15/23/30/40/46 (P2 7 answers rc 0x11) ``[MEASURED lnx 2026-10-02]``. Ring points 8/14/20/28/34/37/38/39x (P2 9 answers rc 0x11 with no ring OC point) ``[MEASURED lnx 2026-10-02]``.
"""
from __future__ import annotations

import dataclasses
import unittest

from linux_xtu.guard import AllowEntry, Refusal, Request
from linux_xtu.guard.policy import CPU_LIMIT_UNREAD
from linux_xtu.mailbox import Cmd, VfWord

from .fakes import seed_point_table
from .test_guard import GuardCase
from .test_point_offsets import with_points

FUSED_E8 = 0x0004A02E
VMAX_E = 0x56D
FUSED_P0 = 0x0005B439  # 57x, the core's top fused ratio
RING_RATIOS = (8, 14, 20, 28, 34, 37, 38, 39)


def w(ratio: int, v_raw: int = 0, offset_raw: int = 0) -> int:
    return VfWord(ratio, v_raw, False, offset_raw).to_u32()


class EveryCpuOfTheClusterIsWalked(GuardCase):
    def setUp(self) -> None:
        super().setUp()
        self.policy = with_points(dataclasses.replace(self.policy, max_operations_per_session=200, max_operations_per_boot=2000))
        for cpu in (8, 9, 10, 11):
            for key, word in (((cpu, 0x10, 0, 0), w(46)), ((cpu, 0x1C, 0, 0), 0x2E2E), ((cpu, 0x09, 0x11, 0), FUSED_E8), ((cpu, 0x28, 0, 0), VMAX_E)):
                self.transport.state[key] = word
            seed_point_table(self.transport, cpu, "E")

    def read(self, guard, cpu: int, *, oc: bool = True, walk: bool = True) -> None:
        reads = [(0x09, 0x11, 0), (0x28, 0, 0), (0x1C, 0, 0)] + ([(0x10, 0, 0)] if oc else []) + ([(0x10, 0, p) for p in range(1, 8)] if walk else [])
        for cmd, p1, p2 in reads:
            guard.execute(self.read_req(cpu, cmd, p1=p1, p2=p2), self.confirm)

    def test_a_peer_never_read_refuses_the_raise(self) -> None:
        # CPU 9 holds point 6 at +150 mV (raw 154) that nobody read; CPU 8's whole-curve +146 mV (raw 150) adds to it: 1184 + 154 + 150 = 1488 > 1388.
        # The guard has walked CPU 8 only: before the fix it summed 1184 + 150 = 1334 and let the write through.
        self.transport.state[(9, 0x10, 0, 6)] = w(46, 0, 154)
        guard = self.make_guard()
        self.read(guard, 8)
        self.assertFalse(guard._context(Request(8, 0x11, 0, 0, 0, "probe")).point_table_read)
        exc = self.assert_refused(guard, self.write_req(w(46, 0, 150), cpu=8), Refusal.CHECK_FAILED)
        self.assertIn(CPU_LIMIT_UNREAD, exc.detail)
        self.assertIn("not walked", exc.detail)

    def test_a_peer_walked_without_its_p2_0_word_refuses_the_raise(self) -> None:
        # the peer's whole-curve offset (its P2 = 0 word, +154 raw) also adds to the cluster's sum: point 6 +150 on CPU 8 -> 1184 + 150 + 154 = 1488 > 1388
        self.transport.state[(9, 0x10, 0, 0)] = w(46, 0, 154)
        guard = self.make_guard()
        for cpu in (8, 10, 11):
            self.read(guard, cpu)
        self.read(guard, 9, oc=False)
        exc = self.assert_refused(guard, self.write_req(w(46, 0, 150), cpu=8, p2=6), Refusal.CHECK_FAILED)
        self.assertIn(CPU_LIMIT_UNREAD, exc.detail)

    def test_with_all_four_walked_the_sum_judges_it(self) -> None:
        self.transport.state[(9, 0x10, 0, 6)] = w(46, 0, 154)
        guard = self.make_guard()
        for cpu in (8, 9, 10, 11):
            self.read(guard, cpu)
        self.assertTrue(guard._context(Request(8, 0x11, 0, 0, 0, "probe")).point_table_read)
        exc = self.assert_refused(guard, self.write_req(w(46, 0, 150), cpu=8), Refusal.CHECK_FAILED)
        self.assertIn("summed voltage", exc.detail)  # 1184 + 154 (CPU 9 point 6) + 150 (whole curve) = 1488 > 1388
        self.assertIs(guard.execute(self.write_req(w(46, 0, 50), cpu=8), self.confirm).verified, True)  # 1184 + 154 + 50 = 1388: at the limit

    def test_lowerings_need_no_walk_of_the_peers(self) -> None:
        guard = self.make_guard()
        self.read(guard, 8)
        self.assertIs(guard.execute(self.write_req(w(46, 0, -102), cpu=8, p2=6), self.confirm).verified, True)

    def test_a_p_core_is_its_own_unit(self) -> None:
        for key, word in (((0, 0x10, 0, 0), w(57)), ((0, 0x1C, 0, 0), 0x3939), ((0, 0x09, 0x11, 0), FUSED_P0), ((0, 0x28, 0, 0), 0x681)):
            self.transport.state[key] = word
        seed_point_table(self.transport, 0, "P")
        guard = self.make_guard()
        for cmd, p1, p2 in [(0x09, 0x11, 0), (0x28, 0, 0), (0x1C, 0, 0), (0x10, 0, 0)] + [(0x10, 0, p) for p in range(1, 10)]:
            guard.execute(self.read_req(0, cmd, p1=p1, p2=p2), self.confirm)
        self.assertIs(guard.execute(self.write_req(w(57, 0, 10), p2=8), self.confirm).verified, True)


class ARingOcWordVoidsTheRingWalk(GuardCase):
    def setUp(self) -> None:
        super().setUp()
        ring = (
            AllowEntry("ring_point_read", Cmd.VOLTAGE_FREQ_READ, frozenset({2}), frozenset(range(1, 16)), "read"),
            AllowEntry("ring_oc_write_for_test", Cmd.VOLTAGE_FREQ_WRITE, frozenset({2}), frozenset({0}), "write", "vf_bounded"),  # not in any shipped policy (D-045)
        )
        self.policy = dataclasses.replace(self.policy, allow=(*self.policy.allow, *ring), max_operations_per_session=80, max_operations_per_boot=800)
        for key, word in (((0, 0x1C, 0, 0), 0x3939), ((0, 0x09, 0x11, 0), FUSED_P0), ((0, 0x10, 2, 0), w(39))):
            self.transport.state[key] = word
        for p2, ratio in enumerate(RING_RATIOS, start=1):
            self.transport.state[(0, 0x10, 2, p2)] = w(ratio)
        self.transport.read_rc_at[(0, 0x10, 2, len(RING_RATIOS) + 1)] = 0x11

    def test_a_ring_ratio_above_the_ring_table_but_below_the_core_top_voids_the_walk(self) -> None:
        guard = self.make_guard()
        for cmd, p1, p2 in [(0x09, 0x11, 0), (0x1C, 0, 0), (0x10, 2, 0)] + [(0x10, 2, p) for p in range(1, len(RING_RATIOS) + 2)]:
            guard.execute(self.read_req(0, cmd, p1=p1, p2=p2), self.confirm)
        probe = Request(0, 0x11, 2, 3, 0, "probe")
        self.assertTrue(guard._context(probe).point_table_read)
        self.assertIs(guard.execute(self.write_req(w(45), p1=2), self.confirm).verified, True)  # 45x: above the ring's 39x (a new ring OC point), below the core's 57x
        self.assertFalse(guard._context(probe).point_table_read)

    def test_a_core_word_at_or_below_the_core_top_still_keeps_the_core_walk(self) -> None:
        # unchanged for P1 = 0: the core's own top fused ratio decides (57x: no OC point, no new slot)
        for key, word in (((0, 0x10, 0, 0), w(57)), ((0, 0x28, 0, 0), 0x681)):
            self.transport.state[key] = word
        seed_point_table(self.transport, 0, "P")
        self.policy = with_points(self.policy)
        guard = self.make_guard()
        for cmd, p1, p2 in [(0x09, 0x11, 0), (0x28, 0, 0), (0x1C, 0, 0), (0x10, 0, 0)] + [(0x10, 0, p) for p in range(1, 10)]:
            guard.execute(self.read_req(0, cmd, p1=p1, p2=p2), self.confirm)
        self.assertIs(guard.execute(self.write_req(w(56)), self.confirm).verified, True)
        self.assertTrue(guard._context(Request(0, 0x11, 0, 8, 0, "probe")).point_table_read)


if __name__ == "__main__":
    unittest.main()
