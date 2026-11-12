"""G-114: the pure V/F model (SPEC-v3 section 9 F4/F5/F6). No I/O."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from linux_xtu import vfmodel
from linux_xtu.mailbox.vf import VfWord
from linux_xtu.vfmodel import check_turbo_order, complete_baseline, effective_curve, interpolate, predict_vccia, voltage_at

P_RATIOS = (8, 20, 30, 48, 53, 55, 56, 57)
# P0, measured stock [MEASURED lnx 2026-10-11] (examples/reference-285k/notes/platform.md section 6); 57x 1.4288 V (orchestrator single-core samples)
P0 = {8: 0.693, 20: 0.721, 30: 0.811, 48: 1.041, 53: 1.216, 55: 1.299, 56: 1.386, 57: 1.4288}


class ClampTests(unittest.TestCase):
    def test_the_measured_p0_57x_case_is_clamped_to_the_56x_voltage(self) -> None:
        """[MEASURED lnx 2026-10-02] P0 57x with -49.8 mV landed at -42.5 mV, i.e. at V(56x): 1.4288 - 0.0498 = 1.379 < 1.386."""
        curve = effective_curve(P_RATIOS, P0, {57: -49.8})
        top = curve[-1]
        self.assertAlmostEqual(top.effective_v, 1.386, places=6)
        self.assertEqual(top.clamped_by, 7)  # point 7 = 56x
        self.assertAlmostEqual((top.effective_v - top.base_v) * 1000, -42.8, places=1)  # ~ the measured -42.5 mV
        self.assertTrue(all(p.clamped_by is None for p in curve[:-1]))

    def test_no_clamp_when_the_offset_stays_above_the_previous_point(self) -> None:
        curve = effective_curve(P_RATIOS, P0, {57: -20})
        self.assertAlmostEqual(curve[-1].effective_v, 1.4088, places=6)
        self.assertIsNone(curve[-1].clamped_by)

    def test_a_raised_point_clamps_the_ones_above_it_and_the_chain_holds(self) -> None:
        curve = effective_curve(P_RATIOS, P0, {53: +120})  # 53x now 1.336 V: 55x (1.299) and 56x (1.386 -> no) ...
        by = {p.ratio: p for p in curve}
        self.assertAlmostEqual(by[53].effective_v, 1.336, places=6)
        self.assertAlmostEqual(by[55].effective_v, 1.336, places=6)
        self.assertEqual(by[55].clamped_by, 5)
        self.assertAlmostEqual(by[56].effective_v, 1.386, places=6)  # above 1.336 already
        self.assertIsNone(by[56].clamped_by)

    def test_a_point_without_a_baseline_is_left_out_of_the_chain(self) -> None:
        base = dict(P0)
        base[56] = None
        curve = effective_curve(P_RATIOS, base, {})
        self.assertIsNone(curve[6].effective_v)
        self.assertAlmostEqual(curve[7].effective_v, 1.4288, places=6)

    def test_complete_baseline_uses_the_fused_top_and_interpolates(self) -> None:
        base = complete_baseline(P_RATIOS, {8: 0.69, 20: 0.72, 30: 0.81, 48: 1.04, 53: 1.22, 55: 1.31}, fused_top_v=1.3047)
        self.assertAlmostEqual(base[57], 1.3047, places=6)  # not measured: the 0x09 voltage (F7)
        self.assertAlmostEqual(base[56], (1.31 + 1.3047) / 2, places=6)


class InterpolationTests(unittest.TestCase):
    def test_54x_is_the_midpoint_of_53x_and_55x(self) -> None:
        curve = effective_curve(P_RATIOS, P0, {})
        self.assertAlmostEqual(voltage_at(curve, 54), (1.216 + 1.299) / 2, places=6)

    def test_flat_above_the_top_point_follows_the_offset(self) -> None:
        """E 47-48x run on point 6 (46x): an offset at the top point moves the bins above it [MEASURED lnx 2026-10-02]."""
        e = (8, 15, 23, 30, 40, 46)
        base = {8: 0.775, 15: 0.775, 23: 0.775, 30: 0.775, 40: 0.970, 46: 1.157}
        self.assertAlmostEqual(voltage_at(effective_curve(e, base, {46: -35}), 48), 1.122, places=6)

    def test_an_oc_point_interpolates_from_the_top_point(self) -> None:
        curve = effective_curve(P_RATIOS, P0, {})
        self.assertAlmostEqual(voltage_at(curve, 58, oc=(59, 1.5)), (1.4288 + 1.5) / 2, places=6)
        self.assertAlmostEqual(voltage_at(curve, 57, oc=(59, 1.5)), 1.4288, places=6)

    def test_the_oc_point_of_ec1_matches_the_first_write_sittings(self) -> None:
        """G-120 fix 3 [MEASURED lnx 2026-10-11] (examples/reference-285k/notes/tuning-history.md section 5): E point 6 (46x) 1.1375 V."""
        e = (8, 15, 23, 30, 40, 46)
        curve = effective_curve(e, {8: 0.775, 15: 0.775, 23: 0.775, 30: 0.775, 40: 0.970, 46: 1.1375}, {})
        self.assertEqual(vfmodel.oc_point_voltage(curve, 1.117), (1.1375, True))  # 48x target below point 6: held up to it
        self.assertEqual(vfmodel.oc_point_voltage(curve, 1.147), (1.147, False))
        for ratio in (46, 47, 48):  # target 1.117 V: 48x = 47x = 1.1375 V
            self.assertAlmostEqual(voltage_at(curve, ratio, oc=(48, 1.117)), 1.1375, places=6)
        self.assertAlmostEqual(voltage_at(curve, 48, oc=(48, 1.147)), 1.147, places=6)  # measured 1.1475 (the target is quantised to 1/1024 V)
        self.assertAlmostEqual(voltage_at(curve, 47, oc=(48, 1.147)), (1.1375 + 1.147) / 2, places=6)  # 47x = the midpoint of 46x and 48x (measured 1.1425)
        self.assertAlmostEqual(voltage_at(curve, 48, oc=(48, 1.1367)), 1.1375, places=6)  # the neutral first write (1.1367 < 1.1375): unchanged
        self.assertAlmostEqual(voltage_at(curve, 50, oc=(48, 1.147)), 1.147, places=6)  # flat above the OC ratio
        self.assertIsNone(vfmodel.oc_point_voltage(effective_curve(e, {}, {}), 1.2))

    def test_interpolate_with_nothing_known(self) -> None:
        self.assertIsNone(interpolate({8: None}, 10))


class VcciaTests(unittest.TestCase):
    def test_the_highest_requested_vid_among_the_units(self) -> None:
        out = predict_vccia([("P7", 55, 1.376), ("P0", 55, 1.299), ("EC0", 48, 1.157)])
        self.assertEqual(out["set_by"], {"unit": "P7", "ratio": 55})
        self.assertAlmostEqual(out["predicted_v"], 1.376, places=4)  # D-036: no ring floor and no margin are assumed
        self.assertIsNone(out["margin_v"])

    def test_a_low_curve_is_not_lifted_by_an_assumed_ring(self) -> None:
        out = predict_vccia([("P0", 20, 0.8), ("EC0", 30, 0.775)])
        self.assertEqual(out["set_by"], {"unit": "P0", "ratio": 20})
        self.assertAlmostEqual(out["predicted_v"], 0.8, places=4)

    def test_nothing_known_is_none(self) -> None:
        self.assertIsNone(predict_vccia([("P0", 55, None)]))


class DeriveFactoryTests(unittest.TestCase):
    """G-250: factory(n) = measured(n) - (whole-curve + point offset) from the words the curve was measured with; golden cases shared with the UI port
    (desktop/app/ui/tests/factory-golden.json, checked by g250.factory.test.mjs too)."""

    GOLDEN = json.loads((Path(__file__).resolve().parents[1] / "desktop" / "app" / "ui" / "tests" / "factory-golden.json").read_text(encoding="utf-8"))["cases"]

    def _case(self, name):
        return next(c for c in self.GOLDEN if c["name"] == name)

    def _run(self, case, fused="case"):
        measured = {int(k): v for k, v in case["measured"].items()}
        if fused == "case":
            fused = tuple(case["fused"]) if case["fused"] else None
        return vfmodel.derive_factory(case["point_ratios"], measured, [int(w, 16) for w in case["words"]], fused)

    def test_golden_cases_derive_the_expected_values_and_tags(self) -> None:
        for case in self.GOLDEN:
            got = [{"ratio": f.ratio, "v": None if f.v is None else round(f.v, 4), "src": f.src, "clamped": f.clamped, "check_mv": f.check_mv} for f in self._run(case)]
            self.assertEqual(got, case["expect"], case["name"])

    def test_the_golden_words_decode_to_the_offsets_the_notes_say(self) -> None:
        live = self._case("p0_live_offsets")
        offs = {w.ratio: round(w.offset_mv, 1) for w in (VfWord.from_u32(int(x, 16)) for x in live["words"][1:])}
        self.assertEqual({r: offs[r] for r in (53, 55, 56, 57)}, {53: -49.8, 55: -28.3, 56: -14.6, 57: -70.3})
        self.assertEqual(VfWord.from_u32(int(live["words"][0], 16)).offset_raw, 0)

    def test_whole_curve_and_point_offsets_both_come_off(self) -> None:
        by = {f.ratio: f for f in self._run(self._case("p0_whole_curve_and_points"))}
        self.assertAlmostEqual(by[55].offset_mv, -51 * 1000 / 1024, places=4)  # raw -20 whole + raw -31 point, 1/1024 V steps
        self.assertAlmostEqual(by[55].v, 1.299, places=4)
        self.assertAlmostEqual(by[8].offset_mv, -19.53125, places=4)  # a point without its own offset still carries the whole-curve layer
        self.assertAlmostEqual(by[8].v, 0.693, places=4)

    def test_a_point_on_the_clamp_is_not_derived_and_is_interpolated(self) -> None:
        by = {f.ratio: f for f in self._run(self._case("ec_point_offsets_with_clamp"))}
        self.assertTrue(by[42].clamped)
        self.assertEqual(by[42].src, "interpolated")
        self.assertAlmostEqual(by[42].v, 0.93 + (1.0 - 0.93) * (42 - 38) / (46 - 38), places=4)
        self.assertFalse(by[38].clamped)

    def test_the_top_point_prefers_the_fused_voltage_and_reports_the_difference(self) -> None:
        by = {f.ratio: f for f in self._run(self._case("p0_live_offsets"))}
        self.assertEqual(by[57].src, "fused")
        self.assertAlmostEqual(by[57].v, 1.4258, places=4)
        self.assertAlmostEqual(by[57].check_mv, 15.9, places=1)  # derived 1.4417 from the clamped 57x minus -70.3 mV: the clamp's size
        self.assertTrue(by[57].clamped)

    def test_a_clamped_top_without_the_fused_voltage_stays_unknown(self) -> None:
        got = self._run(self._case("p0_live_offsets"), fused=None)
        self.assertIsNone(got[-1].v)  # nothing above 56x is known: no flat copy is invented
        self.assertEqual(got[-1].src, "")

    def test_a_stock_curve_has_no_words_and_no_offsets(self) -> None:
        got = vfmodel.derive_factory(P_RATIOS, P0, None, (57, 1.4258))
        self.assertEqual([f.src for f in got], ["derived"] * 7 + ["fused"])
        self.assertAlmostEqual(got[3].v, 1.041, places=6)
        self.assertEqual({f.offset_mv for f in got}, {0.0})

    def test_a_flat_point_whose_offset_is_not_deeper_is_trusted(self) -> None:
        measured = {8: 0.7, 20: 0.7, 30: 0.8}  # 20x flat with 8x, but its offset is the same: the factory curve itself is flat there
        words = [0] + [VfWord(r, 0, False, 0).to_u32() for r in (8, 20, 30)]
        got = vfmodel.derive_factory((8, 20, 30), measured, words, None)
        self.assertEqual([f.src for f in got], ["derived"] * 3)
        self.assertFalse(any(f.clamped for f in got))

    def test_an_unmeasured_point_between_trusted_ones_is_interpolated_and_one_below_all_is_unknown(self) -> None:
        words = [0] + [VfWord(r, 0, False, 0).to_u32() for r in (8, 20, 30, 48)]
        got = {f.ratio: f for f in vfmodel.derive_factory((8, 20, 30, 48), {20: 0.72, 48: 1.04}, words, None)}
        self.assertEqual((got[8].v, got[8].src), (None, ""))
        self.assertEqual(got[30].src, "interpolated")
        self.assertAlmostEqual(got[30].v, 0.72 + (1.04 - 0.72) * 10 / 28, places=6)

    def test_a_point_with_no_word_cannot_be_derived(self) -> None:
        words = [0] + [VfWord(r, 0, False, 0).to_u32() for r in (8, 30)]
        got = {f.ratio: f for f in vfmodel.derive_factory((8, 20, 30), {8: 0.7, 20: 0.72, 30: 0.8}, words, None)}
        self.assertEqual(got[20].src, "interpolated")  # its offset is unknown, so measured - offset would be a guess; the neighbours bracket it

    def test_the_fused_ratio_must_be_the_top_point(self) -> None:
        got = vfmodel.derive_factory(P_RATIOS, P0, None, (58, 1.5))
        self.assertEqual(got[-1].src, "derived")


class TurboOrderTests(unittest.TestCase):
    def test_non_increasing_is_fine(self) -> None:
        self.assertIsNone(check_turbo_order([57, 57, 55, 55, 55, 55, 55, 55]))
        self.assertIsNone(check_turbo_order([48] * 8))

    def test_a_rise_names_the_bucket(self) -> None:
        self.assertEqual(check_turbo_order([55, 57, 55, 55, 55, 55, 55, 55]), 1)
        self.assertEqual(check_turbo_order([57, 57, 55, 55, 55, 55, 55, 56]), 7)


if __name__ == "__main__":
    unittest.main()
