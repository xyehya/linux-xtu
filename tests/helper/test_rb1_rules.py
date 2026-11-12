"""R-B1 (assessment 2026-11-11 WP-2 / WP-5 / WP-9, D-053): one regression test per item, through the real helper loop and the simulator behind the real guard.

1. the voltage model (B-03 / R-09): the whole-curve and the point layers ADD, the OC point in force counts in the current VccIA, an unmeasured rule is flagged;
2. plan-time refusals by field (re-plannable), the ring "applied with nothing written", the warnings for a dropped target and a lowered OC ratio;
3. PLAN_STALE for a changed intent (tune / power / runtime), a changed turbo table and a changed word under a restore plan;
4. profiles: turbo + ring in profiles.save, schema 2 runtime sections (captured, loaded into Tune, restored through power.plan / runtime.plan), the accept nonce;
5. favored cores from the fused 0x1C[15:8] ratios (the A3 follow-up).
"""
from __future__ import annotations

import dataclasses
from typing import Any

from linux_xtu.helper import ops_tune_read, tune_state
from linux_xtu.helper.ops_power import PowerWiring
from linux_xtu.controls import power as pw
from linux_xtu.mailbox import Domain, VfWord
from linux_xtu.profiles import PowerSetting, Profile, ProfileError, load_profile
from linux_xtu.profiles.serialize import dump_profile
from linux_xtu.topology import Core, Topology, arl_s_285k

from ._support import error_code
from .test_accept import AcceptCase
from .test_complete_profiles import COLD
from .test_cpu_facts import FactsCase, STOCK
from .test_ring_accepted import ring_requests
from .test_runtime import RuntimeCase
from .test_tune import ALL_P_53, TuneCase, row, rows, texts

EC1 = (12, 13, 14, 15)


def ec1_oc(h_sim: Any, word: int) -> None:
    for cpu in EC1:
        h_sim._vf[(0, cpu, 0)] = VfWord.from_u32(word)


class VoltageModel(FactsCase):
    def test_a_whole_curve_plan_adds_to_the_point_offsets_held(self) -> None:
        """R-09: P0 53x holds -20 mV; a whole-curve -30 mV runs 53x at -50 mV (not -30: the old 'replace' model)."""
        h = self.boot_with()
        self.sim._vf[(0, 0, 5)] = VfWord(53, 0, False, VfWord.mv_to_offset_raw(-20))
        self.read(h)
        p = self.plan(h, rows(row("P0", curve=-30)))
        pt = p["predicted"]["P0"]["5"]
        self.assertAlmostEqual(pt["offset_mv"], -49.8, delta=0.5)
        self.assertEqual((round(pt["point_offset_mv"], 1), round(pt["curve_offset_mv"], 1)), (-19.5, -30.3))
        self.assertEqual(p["predicted"]["P0"]["4"]["curve_offset_mv"], p["predicted"]["P0"]["4"]["offset_mv"])  # 48x: the whole curve only

    def test_the_current_vccia_counts_the_oc_point_in_force_and_a_curve_on_it_is_flagged(self) -> None:
        """B-03: EC1 holds an OC point 48x at 1.185 V: the all-core E contributor runs it (not the flat 46x point); a whole-curve offset on that unit is predicted with
        ``measured: false`` and a note, and warned (CURVE_WITH_OC)."""
        h = self.boot_with()
        ec1_oc(self.sim, VfWord(48, round(1.185 * 1024), False, 0).to_u32())
        self.read(h)
        p = self.plan(h, rows(row("P0", points={"53": -10})))
        e = p["vccia"]["contributors"]["E"]
        self.assertEqual((e["unit"], e["ratio"]), ("EC1", 48))
        self.assertAlmostEqual(e["v"], 1.185, delta=0.001)
        p = self.plan(h, rows(row("EC1", curve=-20)))
        oc = p["after"]["EC1"]["0"]
        self.assertFalse(oc["measured"])
        self.assertIn("not measured", oc["note"])
        self.assertEqual(p["predicted_oc"]["EC1"]["not_measured"], ["CURVE_WITH_OC"])
        self.assertIn("CURVE_WITH_OC", [w["code"] for w in p["warnings"]])
        self.assertFalse(p["vccia"]["measured"])


class PlanRefusals(TuneCase):
    def refusal(self, h: Any, intent: dict[str, Any]) -> dict[str, Any]:
        sent = len(self.sim.requests)
        r = h.call(f"p{len(h.messages)}", "tune.plan", {"intent": intent})
        self.assertFalse(r["ok"], r)
        self.assertEqual(len(self.sim.requests), sent, "a plan sends nothing")
        return r["error"]

    def test_each_refusal_names_its_field_and_a_new_plan_works_after_it(self) -> None:
        h = self.boot()
        self.read(h)
        cases = [
            (rows(row("P0", curve=-30), row("P0", points={"53": -20})), "BAD_REQUEST", "CURVE_AND_POINTS", "P0"),
            (rows(row("P0", ratio=58, v=1.45, curve=-10)), "REFUSED", "OC_MODE_NOT_OFFERED", "P0.v_target_v"),
            (rows(row("P0", points={"54": -10})), "BAD_REQUEST", "NO_SUCH_POINT", "P0.points.54"),
            ({"ring": {"points": {"12": -5}}}, None, None, None),  # past the read ring: NO_SUCH_POINT or the policy's P2 window, by field either way
            (rows(row("P1", v=1.3)), "REFUSED", "TARGET_NEEDS_OC_POINT", "P1.v_target_v"),
            (rows(row("P2", points={"53": 5})), "REFUSED", "POSITIVE_OFFSET_UNPROVEN", "P2.points.53"),
            (rows(row("EC1", curve=500)), "REFUSED", "POLICY_RANGE", "EC1.curve"),  # B-01: the guard's sum, above the CPU's voltage limit
            (rows(row("P0", points={"53": 500}, ratio=57)), "REFUSED", "POLICY_RANGE", "P0.points.53"),  # the point that lifts the sum is named
            ({"ring": {"points": {"4": 5}}}, "REFUSED", "POSITIVE_OFFSET_UNPROVEN", "ring.points.4"),
        ]
        for intent, code, check, key in cases:
            with self.subTest(intent=intent):
                err = self.refusal(h, intent)
                if code is not None:
                    self.assertEqual((err["code"], err["detail"]["check"], err["detail"]["key"]), (code, check, key), err)
                self.assertEqual(self.plan(h, rows(row("P3", points={"53": -10})))["units"], ["P3"])  # every refusal is re-plannable: nothing was stored

    def test_a_target_with_an_oc_point_is_planned(self) -> None:
        h = self.boot()
        self.read(h)
        self.assertEqual(self.plan(h, rows(row("P1", ratio=58, v=1.31)))["after"]["P1"]["0"]["ratio"], 58)

    def test_a_positive_whole_curve_offset_plans_with_the_walk_and_applies(self) -> None:
        """B-01 (R-B2 walk): a positive whole-curve offset within the CPU's limit is planned -- the apply walks the unit's whole point table and reads 0x09, so the guard can bound
        the sum -- and applied; POSITIVE_OFFSET_UNPROVEN stays for what the walk cannot prove (a point-only row, the ring)."""
        h = self.boot()
        self.read(h)
        p = self.plan(h, rows(row("P2", curve=5)))
        self.assertIn("POSITIVE_OFFSET", [w["code"] for w in p["warnings"]])
        self.assertTrue(self.apply(h, p)["result"]["complete"])
        r = h.call("pt", "tune.plan", {"intent": rows(row("P3", points={"53": 5}))})
        self.assertEqual((error_code(r), r["error"]["detail"]), ("REFUSED", {"check": "POSITIVE_OFFSET_UNPROVEN", "key": "P3.points.53"}))

    def test_a_lowered_oc_ratio_warns(self) -> None:
        h = self.boot()
        ec1_oc(self.sim, VfWord(48, round(1.185 * 1024), False, 0).to_u32())
        self.read(h)
        p = self.plan(h, rows(row("EC1", ratio=47, v=1.1)))
        warn = [w["text"] for w in p["warnings"] if w["code"] == "OC_RATIO_LOWERED"]
        self.assertEqual(len(warn), 1, p["warnings"])
        self.assertIn("48x -> 47x", warn[0])
        self.assertIn("cold boot", warn[0])

    def test_a_profile_target_without_an_oc_point_is_warned_not_refused(self) -> None:
        acc = self.tmp / "accepted"
        (acc / "profiles").mkdir(parents=True)
        (acc / "CURRENT").write_text("profile = profiles/t.toml\n")
        (acc / "profiles/t.toml").write_text('[meta]\nname = "t"\nplatform = "arl-s"\n[[core]]\nkind = "P"\nindex = 4\noc_voltage_mv = 1300\n')
        h = self.boot(accepted_dir=acc)
        self.read(h)
        p = self.plan(h, {"restore": "accepted"})
        self.assertTrue(any(w["code"] == "TARGET_DROPPED" and "P4" in w["text"] for w in p["warnings"]), p["warnings"])


class RingNothingWritten(TuneCase):
    def test_a_ring_only_apply_the_ring_refuses_is_a_refusal_not_applied(self) -> None:
        """R-13: the ring OC word changed between the plan and the apply: the ring unit is refused from the apply's own reads; with nothing else in the plan that is REFUSED
        RING_REFUSED with writes_sent 0, not ``complete: true`` with nothing written."""
        h = self.boot(COLD)
        self.read(h)
        plan = self.plan(h, {"ring": {"points": {"4": -25}}})
        self.sim._vf[(int(Domain.RING), -1, 0)] = VfWord.from_u32(0x27)  # the BIOS ring ratio changed after the plan (test double; no mailbox write)
        r = self.apply(h, plan)
        self.assertEqual((error_code(r), r["error"]["detail"]["check"], r["error"]["detail"]["writes_sent"]), ("REFUSED", "RING_REFUSED", 0), r)
        self.assertIn("ring_oc_differs", r["error"]["message"])
        self.assertEqual(ring_requests(self.sim, 0x11), [])

    def test_a_profile_plan_that_would_only_write_the_ring_and_the_ring_is_refused_is_refused_at_plan(self) -> None:
        h = self.boot(COLD)
        self.read(h)
        self.assertTrue(h.call("s", "profiles.save", {"name": "r", "intent": {"ring": {"points": {"4": -25}}}})["ok"])
        self.sim._vf[(int(Domain.RING), -1, 0)] = VfWord.from_u32(0x27)
        self.read(h)  # the read sees the new ring OC word; the profile still records 0x28
        r = h.call("p", "tune.plan", {"intent": {"profile": "r"}})
        self.assertEqual((error_code(r), r["error"]["detail"]["check"]), ("REFUSED", "RING_REFUSED"), r)


class StalePlans(TuneCase):
    def test_tune_apply_with_another_intent_is_plan_stale_and_writes_nothing(self) -> None:
        h = self.boot()
        self.read(h)
        intent = rows(row("P1", curve=-20))
        plan = self.plan(h, intent)
        self.assertEqual(len(plan["intent_hash"]), 16)
        before = self.word(1)
        r = h.call("a", "tune.apply", {"plan_id": plan["plan_id"], "typed": "CONFIRM " + plan["nonce"], "intent": rows(row("P1", curve=-10))})
        self.assertEqual((error_code(r), r["error"]["detail"]["check"]), ("PLAN_STALE", "INTENT_CHANGED"), r)
        self.assertIn("rows[0].offset.mv: planned -20, now -10", r["error"]["message"])
        self.assertEqual(self.word(1), before)
        plan = self.plan(h, intent)
        r = h.call("b", "tune.apply", {"plan_id": plan["plan_id"], "typed": "CONFIRM " + plan["nonce"], "intent": intent})
        self.assertTrue(r["ok"] and r["result"]["complete"], r)

    def test_a_turbo_table_changed_since_the_plan_is_plan_stale(self) -> None:
        """R-27: the P table changed between the plan and the apply (another tool): nothing is written over it."""
        h = self.boot()
        self.read(h)
        plan = self.plan(h, {"turbo": {"P": [57, 57, 56, 55, 55, 55, 55, 55]}})
        self.sim._pkg_msrs[0x1AD] = 0x3636363636363939  # test double: the table moved under the plan
        r = self.apply(h, plan)
        self.assertEqual((error_code(r), r["error"]["detail"]["check"]), ("PLAN_STALE", "STATE_CHANGED"), r)
        self.assertIn("P turbo table", r["error"]["message"])
        self.assertEqual(self.sim.rdmsr(0, 0x1AD), 0x3636363636363939)

    def test_a_word_changed_under_a_restore_plan_is_plan_stale(self) -> None:
        """R-27: a restore / profile plan compares every word of the read it was built from (the refs used to be empty)."""
        h = self.boot(ALL_P_53)
        self.read(h)
        self.apply_ok(h, self.plan(h, rows(row("P3", points={"53": -30}))))
        self.read(h)
        self.assertTrue(h.call("s", "profiles.save", {"name": "m", "intent": rows(row("P3", points={"53": -40}))})["ok"])
        plan = self.plan(h, {"profile": "m"})
        self.sim._vf[(0, 3, 5)] = VfWord(53, 0, False, VfWord.mv_to_offset_raw(-35))  # another tool moved the word after the plan
        r = self.apply(h, plan)
        self.assertEqual((error_code(r), r["error"]["detail"]["check"]), ("PLAN_STALE", "STATE_CHANGED"), r)
        self.assertEqual(self.word(3, 5).offset_raw, VfWord.mv_to_offset_raw(-35))


class PowerAndRuntimeStale(AcceptCase):
    def power(self, h: Any) -> pw.SimPowerFiles:
        zone = pw.SimPowerFiles()
        h.helper.power_wiring = PowerWiring(zone, self.tmp / "power-journal.json")
        return zone

    def test_power_plan_200_edit_180_apply_writes_nothing(self) -> None:
        """R-26 / F-05: plan PL1 200 W, the field is edited to 180 W, Apply sends what the editor holds: PLAN_STALE, the 200 W are never written."""
        h = self.boot_accepting()
        zone = self.power(h)
        r = h.call("pp", "power.plan", {"power": {"pl1_w": 200}})
        self.assertTrue(r["ok"], r)
        plan = r["result"]
        a = h.call("pa", "power.apply", {"plan_id": plan["plan_id"], "typed": "CONFIRM " + plan["nonce"], "intent": {"power": {"pl1_w": 180}}})
        self.assertEqual((error_code(a), a["error"]["detail"]["check"]), ("PLAN_STALE", "INTENT_CHANGED"), a)
        self.assertEqual(zone.pl1_uw, 250_000_000)
        self.assertEqual(zone.writes, [])

    def test_a_restore_plan_lists_the_power_section_and_power_plan_restores_it(self) -> None:
        """D-053 item 7: the accepted state records PL1/PL2/tau; after PL1 moved, the restore plan lists a power request, and power.plan {restore} plans it back."""
        h = self.boot_accepting()
        zone = self.power(h)
        acc = self.accept(h, **{"from": "read"})
        self.assertTrue(acc["ok"], acc)
        self.assertTrue(acc["result"]["power"])
        prof = load_profile(next((self.acc / "profiles").iterdir()))
        self.assertEqual((prof.version, prof.power.pl1_w, prof.power.pl2_w), (2, 250, 295))
        zone.pl1_uw = 200_000_000  # PL1 changed after the accept (test double)
        plan = self.plan(h, {"restore": "accepted"})
        req = [r for r in plan["requests"] if r["kind"] == "power"]
        self.assertEqual(req[0]["intent"], {"restore": "accepted"})
        self.assertIn("pl1_w: 200 now, 250 in the profile", req[0]["differences"][0])
        pplan = h.call("pr", "power.plan", {"restore": "accepted"})
        self.assertTrue(pplan["ok"], pplan)
        self.assertEqual([(s["key"], s["value"]) for s in pplan["result"]["steps"]], [("pl1_w", 250_000_000)])
        self.assertEqual(pplan["result"]["intent"], {"power": {"pl1_w": 250, "pl2_w": 295, "tau_s": prof.power.tau_s}})


class AcceptNonce(AcceptCase):
    def test_step_one_writes_nothing_and_a_wrong_nonce_or_a_changed_state_is_refused(self) -> None:
        """D-053 item 4: profiles.accept asks first (nothing written), then needs CONFIRM <nonce>; what it would record must not have changed in between."""
        h = self.boot_accepting()
        first = h.call("a1", "profiles.accept", {"from": "read"})
        self.assertTrue(first["ok"] and first["result"]["confirm_required"], first)
        self.assertFalse(self.acc.exists())
        r = h.call("a2", "profiles.accept", {"plan_id": first["result"]["plan_id"], "typed": "CONFIRM ZZZZZZ"})
        self.assertEqual(error_code(r), "CONFIRM_MISMATCH")
        self.sim._vf[(0, 3, 5)] = VfWord(53, 0, False, VfWord.mv_to_offset_raw(-10))
        self.read(h)  # a new read with other words: the confirmation asked for another state
        r = h.call("a3", "profiles.accept", {"plan_id": first["result"]["plan_id"], "typed": "CONFIRM " + first["result"]["nonce"]})
        self.assertEqual((error_code(r), r["error"]["detail"]["check"]), ("PLAN_STALE", "STATE_CHANGED"), r)
        self.assertFalse(self.acc.exists())
        self.assertTrue(self.accept(h, **{"from": "read"})["ok"])


class ProfilesCarryEverything(AcceptCase):
    def test_save_carries_turbo_and_ring_edits_and_get_loads_the_ring(self) -> None:
        """U-30 / R-33 (D-044, D-045): "Save Tune edits as" keeps turbo and ring edits; Load into Tune gets the ring and both offset layers."""
        h = self.boot_accepting(COLD)
        intent = {**rows(row("P2", curve=-15)), "turbo": {"P": [57, 57, 55, 55, 55, 55, 55, 54]}, "ring": {"points": {"4": -25}}}
        r = h.call("s", "profiles.save", {"name": "all", "intent": intent, "power": {"pl1_w": 240}})
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["result"]["turbo"], r["result"]["power"], r["result"]["version"]), (True, True, 2))
        got = h.call("g", "profiles.get", {"name": "all"})["result"]["contents"]
        self.assertEqual(got["turbo"]["P"], [57, 57, 55, 55, 55, 55, 55, 54])
        self.assertEqual(got["ring"]["points"]["4"], -25)
        self.assertEqual(got["power"]["pl1_w"], 240)
        p2 = next(row_ for row_ in got["rows"] if row_["target"] == "P2")
        self.assertEqual((p2["offset"], p2["layers"]["curve_mv"]), ({"kind": "curve", "mv": -15}, -15))

    def test_a_version_1_profile_loads_unchanged_and_runtime_tables_need_version_2(self) -> None:
        text = '[meta]\nname = "old"\nplatform = "arl-s-285k"\n[[core]]\nkind = "P"\nindex = 0\noffset_mv = -10\n'
        old = load_profile(text)
        self.assertEqual((old.version, old.power, old.caps, old.uncore), (1, None, None, None))  # absent = not captured, left as it is
        with self.assertRaisesRegex(ProfileError, "version = 2"):
            load_profile(text + "[power]\npl1_w = 200\n")
        new = dataclasses.replace(old, power=PowerSetting(pl1_w=200, tau_s=28.0), version=2)  # a v1 profile upgraded in memory: the tables it lacked stay "not captured"
        again = load_profile(dump_profile(new))
        self.assertEqual((again.version, again.power), (2, PowerSetting(pl1_w=200, tau_s=28.0)))
        self.assertEqual(again, new)


class RuntimeStale(RuntimeCase):
    def test_uncore_and_caps_edited_after_the_plan_write_nothing(self) -> None:
        """R-26: an uncore / caps plan applied with the intent the tabs hold now; another intent is PLAN_STALE INTENT_CHANGED and no file is written."""
        h = self.boot()
        before = self.ok(h, "runtime.read")["uncore"]
        for planned, now in (({"uncore": {"max_ratio": 30}}, {"uncore": {"max_ratio": 28}}), ({"caps": {"1": 50}}, {"caps": {"1": 48}})):
            with self.subTest(planned=planned):
                plan = self.ok(h, "runtime.plan", planned)
                r = self.call(h, "runtime.apply", {"plan_id": plan["plan_id"], "typed": "CONFIRM " + plan["nonce"], "intent": now})
                self.assertEqual((r["error"]["code"], r["error"]["detail"]["check"]), ("PLAN_STALE", "INTENT_CHANGED"), r)
        self.assertEqual(self.ok(h, "runtime.read")["uncore"], before)
        plan = self.ok(h, "runtime.plan", {"uncore": {"max_ratio": 30}})
        done = self.ok(h, "runtime.apply", {"plan_id": plan["plan_id"], "typed": "CONFIRM " + plan["nonce"], "intent": {"uncore": {"max_ratio": 30}}})
        self.assertTrue(done["complete"], done)


class FavoredFromTheFuse(TuneCase):
    def test_the_fused_ratios_decide_favored_when_sysfs_names_too_many(self) -> None:
        """B-10 / A3: after a 0x1D raise sysfs names P0, P1 and P3; the fused 0x1C[15:8] ratios name P0 and P3 (the fuse does not move)."""
        topo = arl_s_285k()
        drifted = Topology(tuple(dataclasses.replace(c, favored=c.cpu in (0, 1, 3)) if c.kind == "P" else c for c in topo.cores), favored_source="acpi_cppc")
        fused = {c.cpu: (57 if c.cpu in (0, 3) else 55) for c in topo.cores if c.kind == "P"}
        fixed = tune_state.with_fused_favored(drifted, fused)
        self.assertEqual(sorted(c.cpu for c in fixed.cores if c.favored), [0, 3])
        self.assertEqual(fixed.favored_source, "mailbox 0x1C[15:8]")
        self.assertIs(tune_state.with_fused_favored(drifted, None), drifted)
        self.assertIn("P1", ops_tune_read._favored_crosscheck(drifted, fused))

    def test_the_helper_topology_follows_the_read(self) -> None:
        h = self.boot()
        self.read(h)
        self.assertEqual(sorted(c.cpu for c in tune_state._topology(h.helper).cores if c.favored), [0, 3])
        self.assertEqual(tune_state.fused_favored_ratios(h.helper, arl_s_285k()), {0: 57, 1: 55, 2: 55, 3: 57, 4: 55, 5: 55, 6: 55, 7: 55})
