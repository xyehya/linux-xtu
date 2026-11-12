"""R-B2 (assessment 2026-11-11, 05-backend-correctness.md B-01 / B-04 / B-05 / B-08 groundwork): the plan agrees with the guard, so an apply is refused at PLAN time --
before its first write -- for everything the guard would refuse part-way. Simulator + the REAL ``WriteGuard`` (``tests/controls/_support.make_session``); no hardware.

Words (``SimConfig.measured``, ``[MEASURED win 2026-10-01]`` / ``[MEASURED lnx 2026-10-02]``): P0 fused ``0x09`` = ``0x0005B439`` (57x, 1460 raw = 1.4258 V), ``0x28`` = ``0x681``
(limit 0x680 = 1664 raw); P points 8/20/30/48/53/55/56/57x (P2 9 answers rc 0x11); E cluster 0 = CPUs 8-11, fused ``0x0004A02E`` (46x, 1184 raw), ``0x1C`` = ``0x2E30`` (48),
``0x28`` = ``0x56D``. +190 mV = raw 195: 1460 + 195 = 1655 passes alone, 1460 + 195 + 195 = 1850 (1.807 V) is the assessment's B-01 sum.
"""
from __future__ import annotations

import dataclasses
import tempfile
import unittest
from pathlib import Path

from linux_xtu.controls import CoreReadings, PlanRefused, StepKind, StopKind, build_plan, read_steps, resolve_point_targets, resolve_targets
from linux_xtu.controls.order import level
from linux_xtu.controls.planner import UnitReads, walk_cpus, walk_reads_of
from linux_xtu.controls.voltage import MODE_ADAPTIVE, MODE_FUSED_FILL, UnmeasuredVoltageMode, oc_point_request
from linux_xtu.guard import ENV_FLAG, AuditLog, WriteGuard, load_policy
from linux_xtu.mailbox import VfWord
from linux_xtu.msr import SimConfig
from linux_xtu.profiles import load_profile
from linux_xtu.topology import arl_s_285k

from ._support import TOKEN, CountingTransport, Session, e_core, make_session, point_entry, point_text, policy_with, profile, profile_text, with_point_entries
from .test_turbo import turbo_policy

ROOT = Path(__file__).resolve().parents[2]
TOPO = arl_s_285k()
E_CPUS = (8, 9, 10, 11)
PLUS_190 = VfWord.mv_to_offset_raw(190)
OC_48 = VfWord(48, 1203, False, 0)  # E 48x at 1.175 V (round(1.175 * 1024) = 1203): the assessment's B-04 start word
V_1097 = round(1.097 * 1024)  # 1123
BOUND = {"P": 0x680, "E": 0x56C}  # the CPU's own 0x28 limits, raw - 1, bound the way tune.read binds them


def p0(*, offset_mv: int | None = None, ratio: int | None = None, oc_voltage_mv: int | None = None) -> str:
    lines = ['kind = "P"', "index = 0"]
    lines += [f"ratio = {ratio}"] if ratio is not None else []
    lines += [f"oc_voltage_mv = {oc_voltage_mv}"] if oc_voltage_mv is not None else []
    lines += [f"offset_mv = {offset_mv}"] if offset_mv is not None else []
    return "\n".join(lines)


class Case(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self._n = 0

    def session(self, config: SimConfig | None = None, *, points: bool = True, **policy_changes) -> Session:
        self._n += 1
        sub = self.tmp / f"s{self._n}"
        sub.mkdir()
        policy_changes.setdefault("hw_v_target_max_raw", BOUND)
        policy = policy_with(max_ops=2000, dwell=0.0, boot_ops=20000, **policy_changes)
        return make_session(sub, config=config or SimConfig.measured(per_point=True), policy=with_point_entries(policy) if points else policy)

    @staticmethod
    def next_session(s: Session) -> Session:
        """A second Apply click: a new guard session (it knows nothing the first one read) on the same CPU, audit log and lock."""
        transport = CountingTransport(s.port, sleep=s.fake.sleep, clock=s.fake.clock)
        guard = WriteGuard(
            transport, s.policy, AuditLog(s.audit_path, fsync=False), session_token=TOKEN, boot_id_fn=lambda: "test-boot", env={ENV_FLAG: "1"},
            lock_path=s.lock_path, clock=s.fake.clock, msr_port=s.port,
        )
        return dataclasses.replace(s, guard=guard, transport=transport)

    @staticmethod
    def writes(s: Session) -> list[tuple[int, int, int, int]]:
        return [(r.cpu, r.cmd, r.p2, r.data) for r in s.sim.requests if r.cmd in (0x11, 0x15, 0x1D, 0x27)]


class TheWalk(Case):
    """B-01: a plan whose resulting sum can rise above the unit's no-offset level reads the unit's whole point table first; a plan of pure lowerings reads nothing extra."""

    def test_a_positive_point_offset_shows_the_walk_and_applies(self) -> None:
        s = self.session()
        report = s.apply(load_profile(point_text(point_entry("P", 0, 8, 10, expect_ratio=57), entries=(p0(offset_mv=0),))))
        self.assertTrue(report.ok, report.format_report())
        walk = [st for st in report.plan.steps if st.kind is StepKind.READ_VF_WALK]
        self.assertEqual([(st.cpu, st.p2) for st in walk], [(0, p2) for p2 in (1, 2, 3, 4, 5, 6, 7, 9)])  # point 8 is the profile's own read; P2 9 answered rc 0x11
        ran = [r for r in report.steps if r.step.kind is StepKind.READ_VF_WALK]
        self.assertEqual(ran[-1].rc, 0x11)
        self.assertIn("walk is complete", ran[-1].detail)
        self.assertEqual(s.sim.vf(0, 0, 8).offset_raw, 10)
        first_write = next(i for i, r in enumerate(s.sim.requests) if r.cmd in (0x11, 0x15))
        self.assertTrue(all(r.cmd == 0x10 for r in s.sim.requests[first_write - 8 : first_write]))  # every walk read went out before the first write

    def test_an_e_cluster_walks_its_four_cpus_with_their_oc_words(self) -> None:
        prof = load_profile(point_text(point_entry("E", 0, 6, 10, expect_ratio=46)))  # point-only: no OC word is read otherwise
        cpus = walk_cpus((), resolve_point_targets(prof, TOPO), TOPO)
        self.assertEqual(cpus, E_CPUS)
        steps = [st for st in read_steps((), with_point_entries(policy_with()), prof, TOPO) if st.kind is StepKind.READ_VF_WALK]
        self.assertEqual({st.cpu for st in steps if st.p2 == 0}, set(E_CPUS))

    def test_pure_lowerings_walk_nothing(self) -> None:
        prof = load_profile(point_text(point_entry("P", 0, 8, -30), entries=(e_core(0, ratio=47, oc_voltage_mv=1097), p0(offset_mv=-20))))
        self.assertEqual(walk_reads_of(prof, TOPO, with_point_entries(policy_with())), 0)
        self.assertFalse(any(st.kind is StepKind.READ_VF_WALK for st in read_steps(resolve_targets(prof, TOPO), policy_with(), prof, TOPO)))

    def test_the_walk_stops_where_the_shipped_policy_stops(self) -> None:
        shipped = load_policy(ROOT / "policies/default.toml", TOPO)  # 0x10 P1=0 P2 1..10: the P table, its OC slot and the rc 0x11 answer past it
        prof = load_profile(profile_text(p0(offset_mv=5)))
        steps = [st for st in read_steps(resolve_targets(prof, TOPO), shipped, prof, TOPO) if st.kind is StepKind.READ_VF_WALK]
        self.assertEqual([st.p2 for st in steps], list(range(1, 11)))
        self.assertTrue(all(st.verdict.allowed for st in steps))
        self.assertEqual(walk_reads_of(prof, TOPO, shipped), 10)

    def test_a_live_positive_offset_under_a_raise_is_refused_at_plan_time(self) -> None:
        # the CPU holds a whole-curve +10 mV the profile does not set; raising the OC target above the fused voltage lifts the sum above its base: the guard needs the walk,
        # which this plan (no positive offset of its own) does not read -> refused before any write, naming the walk
        config = SimConfig.measured(per_point=True, initial_vf={0: VfWord(57, 0, False, 10)})
        s = self.session(config)
        with self.assertRaises(PlanRefused) as cm:
            s.apply(profile(p0(ratio=58, oc_voltage_mv=1450)))
        self.assertIn("CPU_LIMIT_UNREAD", str(cm.exception))
        self.assertIn("until one answers rc 0x11", str(cm.exception))
        self.assertEqual(self.writes(s), [])


class TheReviewersTwoApplies(Case):
    """Review of R-A2 (finding 2): two Apply clicks, each its own guard session, together request 1.807 V on a P-core whose limit is 1.625 V. The second is now refused at PLAN
    time with the guard's own reason -- before, it was planned as allowed and only the guard stopped it, after the session's first writes could have landed."""

    def test_the_second_apply_is_refused_before_any_write(self) -> None:
        s = self.session()
        first = s.apply(load_profile(point_text(point_entry("P", 0, 8, 190, expect_ratio=57), entries=(p0(offset_mv=0),))))
        self.assertTrue(first.ok, first.format_report())
        self.assertEqual(s.sim.vf(0, 0, 8).offset_raw, PLUS_190)
        sent = len(self.writes(s))
        second = self.next_session(s)
        with self.assertRaises(PlanRefused) as cm:
            second.apply(profile(p0(offset_mv=190)))
        text = str(cm.exception)
        self.assertIn("summed voltage 0x73a", text)  # 1460 + 195 + 195 = 1850 raw
        self.assertIn("above the CPU limit", text)
        self.assertIn("the offsets of a unit add (B-01)", text)
        self.assertEqual(len(self.writes(second)), sent)  # the second session wrote nothing
        self.assertEqual(s.sim.vf(0).offset_raw, 0)
        self.assertIsNotNone(cm.exception.report)
        self.assertTrue(any(r.step.kind is StepKind.READ_VF_WALK for r in cm.exception.report.steps))  # it read the walk that found point 8's +190

    def test_both_in_one_profile_are_refused_at_plan_time(self) -> None:
        s = self.session()
        with self.assertRaises(PlanRefused) as cm:
            s.apply(load_profile(point_text(point_entry("P", 0, 8, 190, expect_ratio=57), entries=(p0(offset_mv=190),))))
        self.assertIn("summed voltage", str(cm.exception))
        self.assertEqual(self.writes(s), [])


class LoweringSends0x1DFirst(Case):
    """B-04: a lowered OC ratio sends its 0x1D first, so no core runs the old ratio on the new, lower voltage between the words; raises keep voltage first, then ratio, then 0x1D."""

    def config(self, word: VfWord = OC_48, **extra) -> SimConfig:
        return SimConfig.measured(per_point=True, initial_vf={c: word for c in E_CPUS}, favored_word={c: 0x2E30 for c in E_CPUS}, **extra)

    def test_e_48_to_47_sends_0x1d_first_and_reverts_cleanly(self) -> None:
        s = self.session(self.config(), points=False)
        report = s.apply(profile(e_core(0, ratio=47, oc_voltage_mv=1097)))
        self.assertTrue(report.ok, report.format_report())
        for cpu in E_CPUS:
            sent = [(cmd, data) for c, cmd, _, data in self.writes(s) if c == cpu]
            self.assertEqual(sent, [(0x1D, 47), (0x11, VfWord(47, 1203, False, 0).to_u32()), (0x11, VfWord(47, V_1097, False, 0).to_u32()), (0x27, 3)], cpu)
            self.assertEqual(s.sim.vf(cpu), VfWord(47, V_1097, False, 0))
            self.assertEqual(s.sim.favored_word(cpu) & 0xFF, 47)
        undo = report.revert_plan
        for req in undo:  # the revert runs voltage first, then the ratio, then 0x1D = 48
            self.assertIs(s.guard.execute(req, s.confirm).verified, True, req)
        for cpu in E_CPUS:
            self.assertEqual(s.sim.vf(cpu), OC_48, cpu)
            self.assertEqual(s.sim.favored_word(cpu) & 0xFF, 48, cpu)

    def test_a_0x1d_whose_0x11_is_refused_is_taken_back_by_the_revert(self) -> None:
        # the guard's "0x1D equal to the 0x1C[7:0] read ends the binding" undo: UVP refuses the first 0x11 (negative offset), so only the 0x1D landed
        s = self.session(self.config(OC_48.with_(offset_raw=-10), uvp=True), points=False)
        report = s.apply(profile(e_core(0, ratio=47, oc_voltage_mv=1097, offset_mv=-10)))
        self.assertEqual(report.stop_kind, StopKind.RC)
        # R-B8 (P1): the cluster's four 0x1Ds go before its first 0x11, so all four landed and all four are taken back
        self.assertEqual([(c, cmd) for c, cmd, _, _ in self.writes(s)], [*((c, 0x1D) for c in E_CPUS), (8, 0x11)])
        undo = report.revert_plan
        self.assertEqual(sorted((r.cpu, r.cmd, r.data) for r in undo), [(c, 0x1D, 48) for c in E_CPUS])
        for req in undo:
            self.assertIs(s.guard.execute(req, s.confirm).verified, True, req)
        for cpu in E_CPUS:
            self.assertEqual(s.sim.favored_word(cpu) & 0xFF, 48, cpu)

    def test_a_lowering_table_written_first_already_caps_it(self) -> None:
        # the turbo table in force while the words land caps the core at 47 (written before them): no window, the XTU order stays (the accepted state's shape)
        text = profile_text(e_core(0, ratio=47, oc_voltage_mv=1097)) + "\n[turbo]\ne = [47, 47, 47, 47, 47, 47, 47, 47]\n"
        (self.tmp / "t").mkdir()
        s = make_session(self.tmp / "t", config=self.config(), policy=turbo_policy(max_ops=2000, dwell=0.0, boot_ops=20000))
        report = s.apply(load_profile(text))
        self.assertTrue(report.ok, report.format_report())
        self.assertEqual([cmd for c, cmd, _, _ in self.writes(s) if c == 8], [0x11, 0x11, 0x1D, 0x27])

    def test_a_raise_keeps_voltage_first_then_ratio_then_0x1d(self) -> None:
        s = self.session(self.config(), points=False)
        report = s.apply(profile(e_core(0, ratio=49, oc_voltage_mv=1200)))
        self.assertTrue(report.ok, report.format_report())
        self.assertEqual([cmd for c, cmd, _, _ in self.writes(s) if c == 8], [0x11, 0x11, 0x1D, 0x27])
        self.assertEqual([VfWord.from_u32(d).ratio for c, cmd, _, d in self.writes(s) if c == 8 and cmd == 0x11], [48, 49])

    def test_the_plan_alone_says_so(self) -> None:
        readings = {c: CoreReadings(vf=OC_48, favored=0x2E30, fused=0x4A02E, granular=3, vmax=0x56D) for c in E_CPUS}
        plan = build_plan(profile(e_core(0, ratio=47, oc_voltage_mv=1097)), TOPO, readings, per_core_enabled=True, policy=policy_with(), unit_reads=UnitReads())
        self.assertTrue(plan.allowed, plan.refusals)
        mine = [st for st in plan.steps if st.cpu == 8 and st.kind.is_write]
        self.assertEqual([st.kind for st in mine], [StepKind.WRITE_FAVORED, StepKind.WRITE_VF, StepKind.WRITE_VF, StepKind.WRITE_GRANULAR])
        self.assertEqual(mine[0].stage, "frequency first")


class FrequencyFirstScope(Case):
    """R-B8 (review of R-B2): the 0x1D-first lowering is per UNIT (an E cluster's four cores run one ratio, platform-arl-s.md [MEASURED lnx 2026-10-14]), only for a word that
    lowers the OC point's voltage, and the turbo-table exception only where the cap is measured (E, 0x650)."""

    def config(self, word: VfWord = OC_48, **extra) -> SimConfig:
        return SimConfig.measured(per_point=True, initial_vf={c: word for c in E_CPUS}, favored_word={c: 0x2E30 for c in E_CPUS}, **extra)

    @staticmethod
    def cluster(s: Session) -> list[tuple[int, int]]:
        return [(c, cmd) for c, cmd, _, _ in Case.writes(s) if c in E_CPUS]

    def test_p1_every_0x1d_of_the_cluster_goes_before_its_first_0x11(self) -> None:
        s = self.session(self.config(), points=False)
        report = s.apply(profile(e_core(0, ratio=47, oc_voltage_mv=1097)))
        self.assertTrue(report.ok, report.format_report())
        sent = self.cluster(s)
        self.assertEqual(sent[:4], [(c, 0x1D) for c in E_CPUS], sent)
        self.assertEqual(sorted(c for c, cmd in sent if cmd == 0x1D), list(E_CPUS))  # no second 0x1D after the words
        for cpu in E_CPUS:
            self.assertEqual(s.sim.vf(cpu), VfWord(47, V_1097, False, 0))
            self.assertEqual(s.sim.favored_word(cpu) & 0xFF, 47)
        for req in report.revert_plan:
            self.assertIs(s.guard.execute(req, s.confirm).verified, True, req)
        for cpu in E_CPUS:
            self.assertEqual((s.sim.vf(cpu), s.sim.favored_word(cpu) & 0xFF), (OC_48, 48), cpu)

    def test_p1_point_writes_of_the_unit_come_after_its_0x1ds_too(self) -> None:
        s = self.session(self.config())
        report = s.apply(load_profile(point_text(point_entry("E", 0, 6, 5, expect_ratio=46), entries=(e_core(0, ratio=47, oc_voltage_mv=1097),))))
        self.assertTrue(report.ok, report.format_report())
        sent = [(c, cmd, p2) for c, cmd, p2, _ in self.writes(s) if c in E_CPUS]
        self.assertEqual(sent[:4], [(c, 0x1D, 0) for c in E_CPUS], sent)
        self.assertTrue(any(p2 == 6 for _, cmd, p2 in sent if cmd == 0x11), sent)

    def test_p2_a_ratio_only_drop_keeps_the_normal_order(self) -> None:
        s = self.session(self.config(), points=False)
        report = s.apply(profile(e_core(0, ratio=47)))
        self.assertTrue(report.ok, report.format_report())
        for cpu in E_CPUS:
            self.assertEqual([cmd for c, cmd in self.cluster(s) if c == cpu], [0x11, 0x1D, 0x27], cpu)
            self.assertEqual(s.sim.vf(cpu), VfWord(47, 1203, False, 0))
        self.assertFalse(any(st.stage == "frequency first" for st in report.plan.steps))

    def test_p2_a_drop_below_the_fused_top_from_a_word_without_an_oc_point_keeps_the_normal_order(self) -> None:
        readings = {c: CoreReadings(vf=VfWord(0, 0, False, 0), favored=0x2E30, fused=0x4A02E, granular=3, vmax=0x56D) for c in E_CPUS}
        plan = build_plan(profile(e_core(0, ratio=45)), TOPO, readings, per_core_enabled=True, policy=policy_with(), unit_reads=UnitReads())
        self.assertTrue(plan.allowed, plan.refusals)
        self.assertEqual([st.kind for st in plan.steps if st.cpu == 8 and st.kind.is_write], [StepKind.WRITE_VF, StepKind.WRITE_FAVORED, StepKind.WRITE_GRANULAR])

    def test_p2_an_offset_lowering_with_the_ratio_still_goes_frequency_first(self) -> None:
        s = self.session(self.config(), points=False)
        report = s.apply(profile(e_core(0, ratio=47, offset_mv=-10)))
        self.assertTrue(report.ok, report.format_report())
        self.assertEqual(self.cluster(s)[:4], [(c, 0x1D) for c in E_CPUS])

    def test_p2_removing_the_oc_point_goes_frequency_first(self) -> None:
        config = SimConfig.measured(per_point=True, initial_vf={0: VfWord(58, 1460, False, 0)}, favored_word={0: 0x393A})
        s = self.session(config, points=False)
        report = s.apply(profile(p0(ratio=57)))
        self.assertTrue(report.ok, report.format_report())
        self.assertEqual([cmd for c, cmd, _, _ in self.writes(s) if c == 0], [0x1D, 0x11, 0x27])

    def test_p3_a_lowering_p_table_does_not_waive_0x1d_first(self) -> None:
        # the table cap is MEASURED for E (0x650) only: a P lowering keeps its 0x1D first even under a lowering P table written before the words
        text = profile_text(p0(ratio=57)) + "\n[turbo]\np = [57, 57, 55, 55, 55, 55, 55, 54]\n"
        (self.tmp / "p").mkdir()
        config = SimConfig.measured(per_point=True, initial_vf={0: VfWord(58, 1460, False, 0)}, favored_word={0: 0x393A})
        s = make_session(self.tmp / "p", config=config, policy=turbo_policy(max_ops=2000, dwell=0.0, boot_ops=20000))
        report = s.apply(load_profile(text))
        self.assertTrue(report.ok, report.format_report())
        self.assertEqual([cmd for c, cmd, _, _ in self.writes(s) if c == 0], [0x1D, 0x11, 0x27])


class TheMirror(unittest.TestCase):
    """The plan's verdicts are the guard's checks with the guard's session facts at each step (``_GuardMirror``)."""

    def test_without_unit_reads_the_walk_is_assumed_with_them_it_is_required(self) -> None:
        readings = {0: CoreReadings(vf=VfWord(57, 0, False, 0), favored=0x3939, fused=0x5B439, granular=3, vmax=0x681)}
        prof = profile(p0(offset_mv=20))
        pol = with_point_entries(policy_with())
        self.assertTrue(build_plan(prof, TOPO, readings, per_core_enabled=True, policy=pol).allowed)  # a preview: the walk is assumed
        refused = build_plan(prof, TOPO, readings, per_core_enabled=True, policy=pol, unit_reads=UnitReads()).refusals  # the apply's own reads: nothing walked
        self.assertEqual([(r.cmd, r.reason) for r in refused], [(0x11, "CHECK_FAILED")])
        self.assertIn("was not walked this session", refused[0].detail)
        walked = UnitReads({(0, p2): VfWord(r, 0, False, 0).to_u32() for p2, r in enumerate((8, 20, 30, 48, 53, 55, 56, 57), start=1)}, {0: 9})
        self.assertTrue(build_plan(prof, TOPO, readings, per_core_enabled=True, policy=pol, unit_reads=walked).allowed)


class OcPointRequest(unittest.TestCase):
    """B-08 groundwork (``controls.voltage``): the measured modes only."""

    FUSED_E = 0x0004A02E  # 46x, 1184 raw

    def test_the_two_measured_modes(self) -> None:
        self.assertEqual(oc_point_request(VfWord(47, 1184, False, 0), self.FUSED_E).mode, MODE_FUSED_FILL)  # no voltage given: the un-offset fused top voltage
        req = oc_point_request(VfWord(47, V_1097, False, 0), self.FUSED_E)
        self.assertEqual((req.raw, req.mode), (V_1097, MODE_ADAPTIVE))  # an adaptive target, as given (the clamp up to the top point is the curve's business)
        self.assertAlmostEqual(req.volts, 1.0967, places=3)

    def test_no_oc_point_requests_nothing(self) -> None:
        self.assertIsNone(oc_point_request(VfWord(46, 0, False, -20), self.FUSED_E))  # at the top fused ratio: the hardware keeps no target (G-124)
        self.assertIsNone(oc_point_request(VfWord(46, 1184, False, 0), self.FUSED_E))
        self.assertIsNone(oc_point_request(VfWord(47, 0, False, 0), self.FUSED_E))  # no target: an auto target is never sent

    def test_unmeasured_modes_are_not_modelled(self) -> None:
        for word in (VfWord(47, 1184, False, -20), VfWord(47, 1184, False, 10), VfWord(47, 1184, True, 0)):
            with self.assertRaises(UnmeasuredVoltageMode):
                oc_point_request(word, self.FUSED_E)
        self.assertEqual(oc_point_request(VfWord(47, 1100, False, 0), None).mode, MODE_ADAPTIVE)  # fused unread: the word is taken to create an OC point

    def test_the_order_model_uses_it_and_states_its_assumption_for_c_d(self) -> None:
        points = {46: -102}
        self.assertEqual(level(points, VfWord(48, 1203, False, 0), 48, 46, 1184), 1203 - 1184)  # above the clamp: the target
        self.assertEqual(level(points, VfWord(48, 1050, False, 0), 48, 46, 1184), -102)  # below the offset top point (1082 raw): clamped up to it [MEASURED lnx 2026-10-13]
        self.assertEqual(level(points, VfWord(48, 1203, False, -20), 48, 46, 1184), 1203 - 1184)  # c/d: the target as written, the offset not applied to it [UNVERIFIED]


if __name__ == "__main__":
    unittest.main()
