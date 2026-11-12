"""R-B1: every case of ``tests/golden/voltage_cases.json`` (R-B4, shared with the desktop UI) through the helper -- the read, ``tune.plan``'s preview and prediction, the
words ``tune.apply`` writes and the re-read -- in the simulator behind the real guard. Language-neutral cases, one model on both sides (B-03 / R-09).

Checked per case where it says something about the helper: ``words`` (the ``0x11`` data words, per CPU in order), ``effective_offset_mv`` / ``voltage_v`` / ``clamped_by`` / ``oc`` /
``not_measured`` (the plan's ``predicted`` / ``predicted_oc`` with the case's ``baseline_v``), ``warnings`` (codes), ``helper_refusal`` / ``helper_warning`` and ``read_after`` (the re-read's
``tune[unit].layers``). The UI-only keys (``layers``, ``draft``, ``pending``, ``refusal``, ...) are the UI's. Every case must agree with the helper (no known differences).
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from linux_xtu.curves import CurveStore
from linux_xtu.helper.ops_measure import MeasureWiring, RunEnv, SimCpufreq, SimMeasureIO, sim_memory
from linux_xtu.mailbox import VfWord
from linux_xtu.msr import SimConfig, SimMsrPort

from ._support import error_code
from .test_tune import TuneCase

GOLDEN = Path(__file__).resolve().parents[1] / "golden" / "voltage_cases.json"
STOCK = SimConfig.measured(per_point=True, reject_zero_fields=True, point_offsets={})
#: the golden ``not_measured`` hint keys (desktop/app/ui/lib/hints.js) <-> the helper's codes (vfmodel)
HINT_OF = {"CURVE_WITH_OC": "warn.curve_with_oc", "INTERP_NOT_MEASURED": "warn.interp_not_measured"}


def load_cases() -> dict[str, Any]:
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


class GoldenVoltage(TuneCase):
    maxDiff = None

    def setUp(self) -> None:
        super().setUp()
        self.doc = load_cases()
        self.units = self.doc["units"]

    # ---- setting up a case's state ---------------------------------------------------------------------------------------------------------------------
    def p2_of(self, unit: str, ratio: int) -> int:
        return next(int(p2) for p2, r in self.units[unit]["points"].items() if r == int(ratio))

    def case_words(self, case: dict[str, Any]) -> dict[str, dict[int, int]]:
        """unit -> {P2: word} of the case's ``read`` (``read_words`` when given, else built from ``read`` the way the helper decodes it)."""
        out: dict[str, dict[int, int]] = {}
        if case.get("read_words"):
            for unit, words in case["read_words"].items():
                out[unit] = {int(p2): int(w, 16) for p2, w in words.items()}
            return out
        for unit, state in (case.get("read") or {}).items():
            words: dict[int, int] = {}
            oc = state.get("oc")
            if oc:
                words[0] = VfWord(oc["ratio"] or 0, 0 if oc.get("v_target_v") is None else round(oc["v_target_v"] * 1024), False, VfWord.mv_to_offset_raw(oc.get("offset_mv") or 0)).to_u32()
            for ratio, mv in (state.get("points_mv") or {}).items():
                words[self.p2_of(unit, int(ratio))] = VfWord(int(ratio), 0, False, VfWord.mv_to_offset_raw(mv)).to_u32()
            out[unit] = words
        return out

    def boot_case(self, case: dict[str, Any]):  # type: ignore[no-untyped-def]
        h = self.boot(STOCK)
        for unit, words in self.case_words(case).items():
            for cpu in self.units[unit]["cpus"]:
                for p2, w in words.items():
                    self.sim._vf[(0, cpu, p2)] = VfWord.from_u32(w)
        base = case.get("baseline_v") or {}
        units = {}
        for unit, info in self.units.items():
            vids = base.get(unit) or {str(info["fused"]["ratio"]): info["fused"]["v"]}  # no baseline_v: the fused top stands in at the top ratio (README)
            points = [{"ratio": int(r), "mhz": int(r) * 100, "vid_v": v, "vid_min": v, "vid_max": v, "kept": 10, "total": 10, "status": "ok"} for r, v in vids.items()]
            units[unit] = {"cpus": info["cpus"], "points": points}
        store = CurveStore(self.tmp / "curves")
        store.save({"id": "20261111T000000Z-gold", "name": "golden", "created": "2026-11-11T00:00:00Z", "boot_id": None, "mode": "quick", "complete": True, "kernel": "sim",
                    "tuning_state": {"kind": "unknown"}, "temps": {"min_c": 28, "max_c": 80}, "units": units, "baseline": True})
        cf = SimCpufreq()
        io = SimMeasureIO(cf, cf.model)
        h.helper.measure_wiring = MeasureWiring(cpufreq=cf, make_run=lambda: RunEnv(io, io.read_perf), store=store, journal_path=self.tmp / "j.json", mem_fn=sim_memory)
        self.read(h)
        return h

    # ---- one case --------------------------------------------------------------------------------------------------------------------------------------
    def run_case(self, case: dict[str, Any]) -> list[str]:  # noqa: C901 - one branch per expect key
        exp = case["expect"]
        intent = exp.get("intent") or exp.get("helper_intent")
        if intent is None:
            return []
        h = self.boot_case(case)
        bad: list[str] = []
        r = h.call(f"plan-{case['id']}", "tune.plan", {"intent": intent})
        if "helper_refusal" in exp:
            want = exp["helper_refusal"]
            if r.get("ok"):
                return [f"helper_refusal: expected {want}, the helper planned it"]
            err = r["error"]
            if err["code"] != want["code"] or ("check" in want and (err.get("detail") or {}).get("check") != want["check"]) or not re.search(want["message_re"], err["message"]):
                bad.append(f"helper_refusal: expected {want}, got {err['code']} {(err.get('detail') or {}).get('check')} {err['message']!r}")
            return bad
        if not r.get("ok"):
            return [f"{'helper_warning' if 'helper_warning' in exp else 'plan'}: refused instead: {r['error']}"]
        plan = r["result"]
        codes = [w["code"] for w in plan["warnings"]]
        if "helper_warning" in exp and exp["helper_warning"] not in codes:
            bad.append(f"helper_warning {exp['helper_warning']} not in {codes}")
        for w in exp.get("warnings", []):
            if w["code"] not in codes:
                bad.append(f"warning {w['code']} not in {codes}")
        pred = plan.get("predicted") or {}
        pred_oc = plan.get("predicted_oc") or {}
        for unit, want in exp.get("effective_offset_mv", {}).items():
            got = {pt["ratio"]: pt["offset_mv"] for pt in (pred.get(unit) or {}).values()}
            for ratio, mv in want.items():
                if ratio not in map(str, got) or abs(got[int(ratio)] - mv) > 1.0:
                    bad.append(f"effective_offset_mv {unit} {ratio}x: expected {mv}, got {got.get(int(ratio))}")
        tol = self.doc["tolerance_v"]
        for unit, want in exp.get("voltage_v", {}).items():
            got = {pt["ratio"]: pt["effective_v"] for pt in (pred.get(unit) or {}).values()}
            oc = pred_oc.get(unit)
            if oc:
                got.update({int(k): b["v"] for k, b in oc["bins"].items()})
            for ratio, v in want.items():
                if got.get(int(ratio)) is None or abs(got[int(ratio)] - v) > tol:
                    bad.append(f"voltage_v {unit} {ratio}x: expected {v}, got {got.get(int(ratio))}")
        for unit, want in exp.get("clamped_by", {}).items():
            view = pred.get(unit) or {}
            for ratio, c in want.items():
                pt = next((p for p in view.values() if p["ratio"] == int(ratio)), None)
                if pt is None or pt["clamped_by"] != c["point"]:
                    bad.append(f"clamped_by {unit} {ratio}x: expected point {c['point']}, got {None if pt is None else pt['clamped_by']}")
        for unit, want in exp.get("oc", {}).items():
            oc = pred_oc.get(unit)
            if oc is None:
                bad.append(f"oc {unit}: no predicted_oc")
                continue
            if oc["ratio"] != want["ratio"] or abs(oc["target_v"] - want["target"]) > tol or abs(oc["effective_v"] - want["v"]) > tol:
                bad.append(f"oc {unit}: expected ratio {want['ratio']} target {want['target']} v {want['v']}, got {oc['ratio']} {oc['target_v']} {oc['effective_v']}")
            if (oc["clamped_by"] or None) != (want["clamped_by"] or None):
                bad.append(f"oc {unit} clamped_by: expected {want['clamped_by']}, got {oc['clamped_by']}")
            if sorted(HINT_OF.get(c, c) for c in oc["not_measured"]) != sorted(want["not_measured"]):
                bad.append(f"oc {unit} not_measured: expected {want['not_measured']}, got {oc['not_measured']}")
        for unit, by_ratio in exp.get("not_measured", {}).items():
            bins = (pred_oc.get(unit) or {}).get("bins", {})
            for ratio, keys in by_ratio.items():
                got_keys = sorted(HINT_OF.get(c, c) for c in (bins.get(ratio) or {}).get("not_measured", ["<no bin>"]))
                if got_keys != sorted(keys):
                    bad.append(f"not_measured {unit} {ratio}x: expected {keys}, got {got_keys}")
        if "words" in exp or "read_after" in exp:
            start = len(self.sim.requests)
            a = self.apply(h, plan)
            if not a.get("ok") or not a["result"]["complete"]:
                return [*bad, f"apply did not complete: {a}"]
            sent: dict[int, list[int]] = {}
            for req in self.sim.requests[start:]:
                if req.cmd == 0x11 and req.p1 == 0:
                    sent.setdefault(req.cpu, []).append((req.p2, req.data))  # type: ignore[arg-type]
            want_by_cpu: dict[int, list[tuple[int, int]]] = {}
            for w in exp.get("words", []):
                want_by_cpu.setdefault(w["cpu"], []).append((w["p2"], int(w["word"], 16)))
            for cpu, words in want_by_cpu.items():
                got_words = [(p2, d) for p2, d in sent.get(cpu, [])]
                if got_words != words:
                    bad.append(f"words cpu {cpu}: expected {[(p, f'{w:#010x}') for p, w in words]}, got {[(p, f'{w:#010x}') for p, w in got_words]}")
            if "read_after" in exp:
                tune = self.read(h)["tune"]
                for unit, want in exp["read_after"].items():
                    layers = tune[unit]["layers"]
                    if abs((layers["curve_mv"] or 0) - want["curve_mv"]) > 0.01 or {k: round(v, 3) for k, v in layers["points_mv"].items()} != {k: round(v, 3) for k, v in want["points_mv"].items()}:
                        bad.append(f"read_after {unit}: expected {want}, got {layers}")
                    oc0 = tune[unit]["cpus"][0]["points"][0]
                    if "oc_ratio" in want and (oc0["ratio"], oc0["v_target_v"]) != (want["oc_ratio"], want["v_target_v"]):
                        bad.append(f"read_after {unit} OC word: expected {want['oc_ratio']}x {want['v_target_v']} V, got {oc0['ratio']}x {oc0['v_target_v']} V")
        return bad

    def check_case(self, case_id: str) -> None:
        case = next(c for c in self.doc["cases"] if c["id"] == case_id)
        self.assertEqual(self.run_case(case), [], f"{case_id}: {case['title']}")

    def test_the_positive_point_case_is_refused_by_field(self) -> None:
        """positive-point-refused: the helper's refusal names the field (``detail.key``), the refusal the UI maps to refused.positive_offset. A point-only row gives the apply
        no fused ``0x09`` read, so the planner's walk alone cannot bound the raise."""
        case = next(c for c in self.doc["cases"] if c["id"] == "positive-point-refused")
        h = self.boot_case(case)
        r = h.call("p", "tune.plan", {"intent": case["expect"]["helper_intent"]})
        self.assertEqual((error_code(r), r["error"]["detail"]), ("REFUSED", {"check": "POSITIVE_OFFSET_UNPROVEN", "key": "P0.points.53"}))


def _add_case_tests() -> None:
    """One test per case (a fresh helper, audit log and curve store each)."""
    for case in load_cases()["cases"]:
        name = "test_case_" + re.sub(r"[^0-9a-zA-Z]+", "_", case["id"])

        def test(self: GoldenVoltage, case_id: str = case["id"]) -> None:
            self.check_case(case_id)

        test.__doc__ = f"golden {case['id']}: {case['title']}"
        setattr(GoldenVoltage, name, test)


_add_case_tests()
