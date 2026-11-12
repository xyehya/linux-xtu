"""Preview and prediction of a plan (R-D1, split from ``ops_tune``; SPEC-v3 section 9, B-03, R-03). Pure: no hardware.

* :func:`_before_after`: per point the plan writes, the word as read and after the plan (point ``"0"`` = the OC word, whose ``after`` is the planner's own word,
  :func:`_planner_goal`; the ring's points under ``"ring"``).
* :func:`_predict`: from the newest curve flagged ``baseline`` (``vf.measure``), the effective voltage of every point of the touched units (baseline VID + whole-curve
  offset + point offset: the layers add; then the F4 clamp up to V(n-1)), the OC point with ``measured`` / ``not_measured`` where a rule was never measured, the
  ``CLAMPED`` / ``CURVE_WITH_OC`` / ``E40_OFFSET`` / ``E_TARGET_WHEA`` warnings, and the F6 VccIA prediction (highest requested VID among the units).
* :func:`_last_baseline`: the planner's inputs as this boot's last read gives them (the plan's step list, order and checks are built from it).
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from linux_xtu import vfmodel
from linux_xtu.controls import PlanError, Target, resolve_point_targets, resolve_targets, CoreReadings
from linux_xtu.controls import ring as ringmod
from linux_xtu.controls.planner import Warn, _same_state, _goal_word, current_word, kept_word
from linux_xtu.guard.policy import fused_top_ratio
from linux_xtu.mailbox import VfWord
from linux_xtu.profiles import Profile
from linux_xtu.topology import Topology
from linux_xtu.vfmodel import CurvePoint, complete_baseline, effective_curve, predict_vccia

from .protocol import OpError
from .tune_state import _decode, _kind_of, _last_ring, _last_words, _ring_word_map, _state, _unit_reference, unit_cpus, unit_of_cpu

if TYPE_CHECKING:
    from .core import Helper


# --------------------------------------------------------------------------------------------------------------
# before / after
# --------------------------------------------------------------------------------------------------------------
def _fill_ratio(turbo: Mapping[str, Any] | None, kind: str, cpu: int) -> int | None:
    """The ratio the planner's XTU fill takes for a cold OC word (``0x1C[7:0]``): a P-core's own favored ratio; an E core follows the first bucket of the E table."""
    if not turbo:
        return None
    if kind == "P":
        return (turbo.get("favored") or {}).get(cpu) or None
    ratios = (turbo.get("E") or {}).get("ratios")
    return ratios[0] if ratios else None


def _planner_goal(setting: Any, ref: tuple[int, Sequence[int]] | None, fused: Mapping[int, int], favored: Mapping[int, int], complete: bool) -> VfWord | None:
    """B-03 / R-03: the ``P2 = 0`` word the apply will write for ``setting`` (a ``CpuSetting``), built by the planner's own rules from this boot's read (``current_word``: the XTU fill --
    ratio = the word's own else ``0x1C[7:0]``, V target = the word's own else the un-offset fused ``0x09`` voltage; ``_goal_word`` + ``kept_word``; a complete profile leaves a word
    the core already holds as it is, ``_same_state``). ``None`` when the read lacks the word, the ``0x09`` word or the ``0x1C`` word of the unit (the caller falls back)."""
    if ref is None:
        return None
    ref_cpu, words = ref
    fused_word = fused.get(setting.cpu, fused.get(ref_cpu))
    favored_word = favored.get(setting.cpu, favored.get(ref_cpu))
    if fused_word is None or favored_word is None or not words:
        return None
    rd = CoreReadings(vf=VfWord.from_u32(words[0]), favored=int(favored_word), fused=int(fused_word), granular=0)
    top = fused_top_ratio(int(fused_word))
    target = Target(setting.cpu, f"{setting.kind}-Core {setting.index}", setting.kind, setting.index, setting.cluster, setting.ratio, setting.oc_voltage_mv, setting.offset_mv,
                    setting.fused_top_ratio)
    try:
        goal = _goal_word(target, current_word(rd, setting.ratio is not None or setting.oc_voltage_mv is not None), top)
    except PlanError:
        return None
    if complete and _same_state(target, rd, goal, top):
        return rd.vf  # the apply sends nothing for a word the core already holds
    return goal


def _before_after(
    profile: Profile,
    topology: Topology,
    last: Mapping[int, Sequence[int]] | None,
    fused: Mapping[int, int] | None = None,
    turbo: Mapping[str, Any] | None = None,
    last_ring: Sequence[int] | None = None,
    favored: Mapping[int, int] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """``{unit: {point: {ratio, offset_mv, v_target_v}}}`` for the words the plan writes; point ``"0"`` is the OC word. ``before`` is ``null`` for a
    word that was not read; a field that reads 0 (unset) is ``null``. G-154: the ring points of the profile are the unit ``"ring"`` (its OC word is compared, never written: no
    entry for point ``"0"``), ``last_ring`` = ``[OC word, point 1, ...]`` of the last read. With ``favored`` (the ``0x1C`` words of the read) the OC word's ``after`` is the planner's
    own word (:func:`_planner_goal`): an OC ratio with no voltage given shows the un-offset fused top voltage the apply writes as its target (R-03)."""
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}

    def show(vf: VfWord) -> dict[str, Any]:
        d = _decode(vf)
        return {"ratio": d["ratio"], "offset_mv": d["offset_mv"], "v_target_v": d["v_target_v"]}

    for setting in profile.expand(topology):
        unit = unit_of_cpu(topology, setting.cpu)
        ref = _unit_reference(last, setting.cpus)
        cur = VfWord.from_u32(ref[1][0]) if ref else None
        planned = _planner_goal(setting, ref, fused or {}, favored or {}, profile.complete) if favored is not None else None
        if planned is not None:
            before.setdefault(unit, {})["0"] = None if cur is None else show(cur)
            after.setdefault(unit, {})["0"] = show(planned)
            continue
        changes: dict[str, int] = {}
        if setting.ratio is not None:
            changes["ratio"] = setting.ratio
        if setting.oc_voltage_mv is not None:
            changes["v_target_raw"] = VfWord.v_to_raw(setting.oc_voltage_mv / 1000)
        if setting.offset_mv is not None:
            changes["offset_raw"] = VfWord.mv_to_offset_raw(setting.offset_mv)
        goal = (cur or VfWord(0, 0, False, 0)).with_(**changes)
        kind = _kind_of(unit)
        top = fused_top_ratio((fused or {}).get(setting.cpu))  # the core's own top fused ratio, from this boot's 0x09 read (None = not read: nothing is dropped)
        if goal.ratio:
            goal = kept_word(top, goal)  # G-124: no OC point (ratio <= the top fused ratio) = the hardware keeps no V target, whatever the offset
        elif goal.v_target_raw:
            # a cold word (ratio field 0): the planner fills the ratio from 0x1C[7:0] (the plan sets an OC voltage, so the fill is not capped) -- decide the target on
            # that filled ratio, show the field as read (0 = unset). The fill comes from this boot's read (P: 0x1C of the core; E: the first bucket of the E table).
            fill = _fill_ratio(turbo, kind, setting.cpu)
            if fill is not None:
                goal = kept_word(top, goal.with_(ratio=fill)).with_(ratio=0)
        before.setdefault(unit, {})["0"] = None if cur is None else show(cur)
        after.setdefault(unit, {})["0"] = show(goal)
    for setting in profile.expand_points(topology):
        unit = unit_of_cpu(topology, setting.cpu)
        ref = _unit_reference(last, setting.cpus)
        cur = VfWord.from_u32(ref[1][setting.point]) if ref and len(ref[1]) > setting.point else None
        goal = (cur or VfWord(setting.expect_ratio or 0, 0, False, 0)).with_(offset_raw=VfWord.mv_to_offset_raw(setting.offset_mv))
        before.setdefault(unit, {})[str(setting.point)] = None if cur is None else show(cur)
        after.setdefault(unit, {})[str(setting.point)] = show(goal)
    if profile.ring is not None:
        for rp in profile.ring.points:
            cur = VfWord.from_u32(last_ring[rp.point]) if last_ring and len(last_ring) > rp.point else None
            goal = (cur or VfWord(rp.expect_ratio, 0, False, 0)).with_(offset_raw=VfWord.mv_to_offset_raw(rp.offset_mv))
            before.setdefault(ringmod.UNIT, {})[str(rp.point)] = None if cur is None else show(cur)
            after.setdefault(ringmod.UNIT, {})[str(rp.point)] = show(goal)
    return before, after


# --------------------------------------------------------------------------------------------------------------
# SPEC-v3 section 9: predictions (F4 clamp, F6 VccIA, F8 warnings) from the newest baseline curve
# --------------------------------------------------------------------------------------------------------------
def _fused_ratios(words: Sequence[int], top: int | None) -> tuple[int, ...]:
    """The fused V/F point ratios of a core from its words (``words[0]`` = the OC word, ``words[n]`` = point ``n``): every point, without the one that sits above the
    core's top fused ratio ``top`` (live ``0x09`` ``[7:0]``) -- that one is the OC point. With ``top`` unknown (``0x09`` not read) every point counts."""
    ratios = [VfWord.from_u32(w).ratio for w in words[1:]]
    return tuple(r for r in ratios if r and (top is None or r <= top))


def _unit_point_ratios(helper: Helper, topology: Topology) -> dict[str, tuple[int, ...]]:
    """unit -> its fused point ratios from this boot's kept read (units not read are absent)."""
    last = _last_words(helper) or {}
    out: dict[str, tuple[int, ...]] = {}
    for unit in topology.unit_ids():
        ref = _unit_reference(last, topology.unit_cpus(unit))
        if ref is not None:
            out[unit] = _fused_ratios(ref[1], fused_top_ratio(helper.fused_words.get(ref[0])))
    return out



def _baseline_record(helper: Helper) -> tuple[dict[str, Any] | None, str | None]:
    """The newest curve record flagged ``baseline`` of the measurement store, or ``(None, why)``."""
    from .ops_measure import _wiring  # imported lazily: both modules import .ops, neither imports the other at module level

    try:
        store = _wiring(helper).store
        for row in store.summaries():
            if row.get("baseline"):
                return store.get(row["id"]), None
    except OpError as exc:
        return None, exc.message
    except Exception as exc:  # StoreError and friends: a prediction is optional
        return None, f"{type(exc).__name__}: {exc}"
    return None, None


@dataclass
class _UnitModel:
    """B-03: one unit's two offset layers (the whole-curve offset of its ``P2 = 0`` word and each fused point's own offset; the CPU adds them) and its OC point, as read and as
    planned. ``*_points`` are the point layer by ratio, ``*_curve`` the whole-curve layer, ``*_oc`` = ``(OC ratio, adaptive target V)`` of an OC point (a ``P2 = 0`` ratio above the
    top fused ratio with a target), ``None`` = no OC point."""

    unit: str
    kind: str
    cpus: tuple[int, ...]
    ratios: tuple[int, ...]  # the fused point ratios (index n-1 = point n); empty = the unit was not read, nothing can be predicted
    cur_points: dict[int, float]  # ratio -> mV of the point words last read (0 where nothing was read)
    new_points: dict[int, float]  # ... after the plan
    baseline: dict[int, float | None] | None
    top: int | None = None  # the top fused ratio (0x09 [7:0]); None = not read
    cur_curve: float = 0.0  # the whole-curve offset of the P2 = 0 word last read
    new_curve: float = 0.0  # ... after the plan
    cur_oc: tuple[int, float] | None = None
    new_oc: tuple[int, float] | None = None
    oc_ratio: int | None = None  # the plan's OC ratio for this unit (as asked)
    oc_v: float | None = None  # the plan's OC-point voltage target (V, as asked)
    cur_oc_ratio: int | None = None  # the ratio of the OC word of the last read (None = not read / 0)
    touched: bool = False

    @property
    def cur_offsets(self) -> dict[int, float]:
        """The effective offset of every fused point as read: point + whole-curve."""
        return {r: self.cur_points.get(r, 0.0) + self.cur_curve for r in self.ratios}

    @property
    def new_offsets(self) -> dict[int, float]:
        return {r: self.new_points.get(r, 0.0) + self.new_curve for r in self.ratios}


def _oc_of(ratio: int | None, v_target: float | None, top: int | None) -> tuple[int, float] | None:
    """``(ratio, target V)`` when a ``P2 = 0`` word with these fields is an OC point: a ratio above the top fused ratio carrying a target (G-120/G-124: without an OC point the hardware
    keeps no target). ``top`` unknown: a word with a target is taken as one."""
    if not ratio or not v_target or (top is not None and ratio <= top):
        return None
    return int(ratio), float(v_target)


def _unit_models(
    profile: Profile,
    topology: Topology,
    last: Mapping[int, Sequence[int]] | None,
    record: dict[str, Any] | None,
    fused: Mapping[int, Mapping[str, Any]] | None,
    fused_words: Mapping[int, int] | None = None,
    after: Mapping[str, Any] | None = None,
) -> dict[str, _UnitModel]:
    """Every unit's model (B-03, additive): the point layer and the whole-curve layer as read and after the plan. The plan's ``P2 = 0`` word is ``after[unit]["0"]`` (the preview's own
    word, :func:`_before_after`): its offset is the new whole-curve layer and its ratio / target the new OC point; a unit the plan does not set keeps what it holds."""
    settings = {unit_of_cpu(topology, s.cpu): s for s in profile.expand(topology)}
    point_settings: dict[str, dict[int, Any]] = {}
    for ps in profile.expand_points(topology):
        point_settings.setdefault(unit_of_cpu(topology, ps.cpu), {})[ps.point] = ps
    models: dict[str, _UnitModel] = {}
    for unit in topology.unit_ids():
        kind = _kind_of(unit)
        cpus = unit_cpus(topology, unit)
        ref = _unit_reference(last, cpus)
        top: int | None = None
        cur_curve, cur_oc, cur_oc_ratio = 0.0, None, None
        if ref is not None:
            top = fused_top_ratio((fused_words or {}).get(ref[0]))
            words = [VfWord.from_u32(w) for w in ref[1][1:] if VfWord.from_u32(w).ratio and (top is None or VfWord.from_u32(w).ratio <= top)]  # past the table = the OC point
            ratios = tuple(w.ratio for w in words)
            cur = {w.ratio: w.offset_mv for w in words}
            oc_word = VfWord.from_u32(ref[1][0])
            cur_curve = oc_word.offset_mv
            cur_oc_ratio = oc_word.ratio or None
            cur_oc = _oc_of(oc_word.ratio, oc_word.v_target_v if oc_word.v_target_raw else None, top)
        else:
            ratios, cur = (), {}
        new = dict(cur)
        st = settings.get(unit)
        explicit = point_settings.get(unit, {})
        for n, ps in explicit.items():
            if 1 <= n <= len(ratios):
                new[ratios[n - 1]] = float(ps.offset_mv)
        new_curve, new_oc = cur_curve, cur_oc
        planned = ((after or {}).get(unit) or {}).get("0") if st is not None else None
        if planned is not None:
            new_curve = float(planned.get("offset_mv") or 0.0)
            new_oc = _oc_of(planned.get("ratio"), planned.get("v_target_v"), top)
        elif st is not None:  # no preview word (nothing read): the profile's own fields
            if st.offset_mv is not None:
                new_curve = float(st.offset_mv)
            if st.ratio is not None or st.oc_voltage_mv is not None:
                new_oc = _oc_of(st.ratio or (cur_oc[0] if cur_oc else None), st.oc_voltage_mv / 1000 if st.oc_voltage_mv is not None else (cur_oc[1] if cur_oc else None), top)
        baseline = None
        if record is not None:
            pts = ((record.get("units") or {}).get(unit) or {}).get("points") or []
            measured = {p["ratio"]: p["vid_v"] for p in pts if p.get("status") == "ok" and p.get("vid_v") is not None}
            fused_v = ((fused or {}).get(cpus[0]) or {}).get("v")
            if measured and ratios:
                baseline = complete_baseline(ratios, measured, fused_v)
        m = _UnitModel(unit, kind, cpus, ratios, cur, new, baseline, top, cur_curve, new_curve, cur_oc, new_oc, touched=st is not None or bool(explicit))
        m.cur_oc_ratio = cur_oc_ratio
        if st is not None:
            m.oc_ratio = st.ratio
            m.oc_v = None if st.oc_voltage_mv is None else st.oc_voltage_mv / 1000
        models[unit] = m
    return models


def _allowed_ratios(m: _UnitModel, turbo: Mapping[str, Any] | None) -> tuple[int, int] | None:
    """(1-2 active cores, all cores): the highest ratio the unit is allowed at, from the live turbo tables (``0x1AD`` / ``0x650``) and the favored word (``0x1C``);
    D-050: an OC ratio never raises a table, so the table (the plan's own ``[turbo]`` one when it names one) is the ceiling. ``None`` when the tables were not read this boot
    (nothing is assumed)."""
    ratios = ((turbo or {}).get(m.kind) or {}).get("ratios")
    if not ratios:
        return None
    light, full = ratios[0], ratios[-1]
    if m.kind == "P":
        fav = ((turbo or {}).get("favored") or {}).get(m.cpus[0])
        if fav:
            light = min(light, fav)
    return light, full


def _point_view(curve: Sequence[CurvePoint]) -> dict[str, Any]:
    """B-03: ``offset_mv`` is the effective offset (whole-curve + the point's own); ``point_offset_mv`` / ``curve_offset_mv`` are the two layers inside it."""
    return {
        str(p.index): {
            "ratio": p.ratio, "base_v": None if p.base_v is None else round(p.base_v, 4), "offset_mv": round(p.offset_mv, 3),
            "point_offset_mv": round(p.point_offset_mv, 3), "curve_offset_mv": round(p.curve_offset_mv, 3),
            "effective_v": None if p.effective_v is None else round(p.effective_v, 4), "clamped_by": p.clamped_by,
        }
        for p in curve
    }


#: B-03: the text a prediction carries when it rests on a rule nobody measured (``measured: false``), per ``not_measured`` code.
_NOT_MEASURED_TEXT = {
    vfmodel.CURVE_WITH_OC: "whether a whole-curve offset moves the OC-point target is not measured: the number keeps the target as written",
    vfmodel.INTERP_NOT_MEASURED: "the line from the top fused point to the OC point is measured only with the top point at offset 0; with an offset, where it starts is not measured",
}


def _not_measured_note(codes: Sequence[str]) -> str | None:
    return "; ".join(_NOT_MEASURED_TEXT.get(c, c) for c in codes) or None


def _oc_view(oc: vfmodel.OcPrediction, curve: Sequence[CurvePoint], top: int | None) -> dict[str, Any]:
    """``predicted_oc[unit]`` (additive): the OC point the plan leaves and the bins between the top fused point and it, each with ``measured`` / ``not_measured`` codes."""
    top_ratio = max((p.ratio for p in curve if p.effective_v is not None), default=top or oc.ratio)
    bins: dict[str, Any] = {}
    for r in range(top_ratio + 1, oc.ratio + 1):
        v, nm = vfmodel.voltage_detail(curve, r, oc)
        bins[str(r)] = {"v": None if v is None else round(v, 5), "measured": not nm, "not_measured": list(nm)}
    return {
        "ratio": oc.ratio, "target_v": round(oc.target_v, 4), "effective_v": round(oc.v, 5),
        "clamped_by": None if oc.clamped_by is None else {"point": oc.clamped_by, "ratio": oc.clamped_ratio},
        "measured": oc.measured, "not_measured": list(oc.not_measured), "note": _not_measured_note(oc.not_measured), "bins": bins,
    }


def _predict(
    helper: Helper, profile: Profile, topology: Topology, last: Mapping[int, Sequence[int]] | None, before: dict[str, Any], after: dict[str, Any], warnings: list[str]
) -> dict[str, Any]:
    """Fill ``effective_v`` / ``clamped_by`` into the ``before`` / ``after`` points the plan writes and return ``{predicted, predicted_oc, vccia}`` (contract 9 addendum).
    ``effective_v`` = baseline VID + whole-curve offset + point offset (B-03: the layers add), then the F4 clamp up to V(n-1); the OC word's entry gets the OC point's voltage
    with ``measured`` (and a ``note`` when false). Without a baseline curve the numbers are null and one warning says so."""
    st = _state(helper)
    with st.lock:
        fused, turbo = st.fused, st.turbo
    record, why = _baseline_record(helper)
    models = _unit_models(profile, topology, last, record, fused, helper.fused_words, after)
    if record is None:
        warnings.append(Warn("NO_BASELINE", "measure a stock baseline for predictions" + (f" (the baseline curve could not be loaded: {why})" if why else " (no curve is flagged baseline)")))
    elif last is None:
        warnings.append("no tune.read this boot: the current offsets of every point are assumed to be 0 in the predictions")
    predicted: dict[str, Any] = {}
    predicted_oc: dict[str, Any] = {}
    curves_new: dict[str, list[CurvePoint]] = {}
    curves_cur: dict[str, list[CurvePoint]] = {}
    ocs_new: dict[str, vfmodel.OcPrediction] = {}
    ocs_cur: dict[str, vfmodel.OcPrediction] = {}
    for unit, m in models.items():
        if m.baseline is None:
            continue
        curves_cur[unit] = effective_curve(m.ratios, m.baseline, m.cur_points, m.cur_curve)
        curves_new[unit] = effective_curve(m.ratios, m.baseline, m.new_points, m.new_curve)
        for oc, curve, curve_mv, into in ((m.cur_oc, curves_cur[unit], m.cur_curve, ocs_cur), (m.new_oc, curves_new[unit], m.new_curve, ocs_new)):
            if oc is not None:
                pred = vfmodel.oc_prediction(curve, oc[0], oc[1], curve_mv)
                if pred is not None:
                    into[unit] = pred
        if m.touched:
            predicted[unit] = _point_view(curves_new[unit])
            if unit in ocs_new:
                predicted_oc[unit] = _oc_view(ocs_new[unit], curves_new[unit], m.top)
    # ---- the written points get their numbers ----
    for side, curves, ocs in ((before, curves_cur, ocs_cur), (after, curves_new, ocs_new)):
        for unit, items in side.items():
            curve = curves.get(unit)
            for point, entry in items.items():
                if entry is None:
                    continue
                n = int(point)
                if n == 0:
                    entry["effective_v"], entry["clamped_by"] = entry.get("v_target_v"), None
                    oc = ocs.get(unit)
                    if oc is not None and curve is not None:
                        entry["effective_v"], entry["clamped_by"] = round(oc.v, 4), oc.clamped_by  # G-120: max(target, V(top fused point))
                        entry["measured"] = oc.measured
                        if not oc.measured:
                            entry["note"] = _not_measured_note(oc.not_measured)
                elif curve is not None and 1 <= n <= len(curve):
                    ev = curve[n - 1].effective_v
                    entry["effective_v"], entry["clamped_by"] = (None if ev is None else round(ev, 4)), curve[n - 1].clamped_by
                else:
                    entry["effective_v"], entry["clamped_by"] = None, None
    # ---- warnings F4 / F8 / B-03 ----
    for unit, m in models.items():
        if not m.touched:
            continue
        new, cur = curves_new.get(unit), curves_cur.get(unit)
        if new is not None and cur is not None:
            for p, c in zip(new, cur):
                # G-120 fix 2: only a point the plan newly clamps is worth a warning. A point clamped at stock already (the 56/57x of a core that cannot reach them sit at the
                # voltage of the point below) follows that point when the plan moves it: no new fact, and for a point the plan does not set an "offset +0.0 clamped" line.
                newly = c.clamped_by is None
                if newly and p.clamped_by is not None and p.effective_v is not None and p.base_v is not None:
                    landed = (p.effective_v - p.base_v) * 1000
                    warnings.append(Warn(
                        "CLAMPED",
                        f"{unit} point {p.index} ({p.ratio}x): offset {p.offset_mv:+.1f} mV is clamped up to the voltage of point {p.clamped_by} "
                        f"(the hardware keeps V(n) >= V(n-1)): effective {landed:+.1f} mV = {p.effective_v:.3f} V",
                    ))
        oc_new = ocs_new.get(unit)
        if oc_new is not None and oc_new.clamped_by is not None and (m.oc_v is not None or m.oc_ratio is not None) and new is not None:  # G-120 fix 2: a target below the top point is held up to it
            top = new[oc_new.clamped_by - 1]
            warnings.append(Warn(
                "CLAMPED",
                f"{unit} OC point ({oc_new.ratio}x): the adaptive target {oc_new.target_v:.4f} V is below the voltage of the top fused point ({top.ratio}x, point {top.index}) "
                f"{oc_new.v:.4f} V and is held up to it (the hardware keeps V(n) >= V(n-1)): effective {oc_new.v:.4f} V",
            ))
        if m.new_oc is not None and abs(m.new_curve) > 1e-9 and (abs(m.new_curve - m.cur_curve) > 1e-9 or m.new_oc != m.cur_oc):
            warnings.append(Warn(
                vfmodel.CURVE_WITH_OC,
                f"{unit}: a whole-curve offset of {m.new_curve:+.1f} mV with an OC point ({m.new_oc[0]}x): every fused point moves by it (measured); whether the OC-point target "
                "moves is not measured, so the OC point's voltage is shown as written and flagged",
            ))
        if m.kind == "E":
            if len(m.ratios) >= vfmodel.E_HINT_POINT:  # B-19: the hint is about E point 5 (its ratio is read live)
                r5 = m.ratios[vfmodel.E_HINT_POINT - 1]
                at5, was5 = m.new_offsets.get(r5, 0.0), m.cur_offsets.get(r5, 0.0)
                if at5 != 0.0 and at5 != was5:
                    warnings.append(Warn(
                        "E40_OFFSET",
                        f"{unit}: an effective offset of {at5:+.1f} mV on E point {vfmodel.E_HINT_POINT} ({r5}x). One-chip report: a -20 mV offset on that point (40x on the chip it was seen on) "
                        "caused OCCT errors; take a stability check",
                    ))
            if m.oc_v is not None and m.oc_v > vfmodel.E_WHEA_V:
                warnings.append(Warn("E_TARGET_WHEA", f"{unit}: E-core voltage target {m.oc_v:.3f} V is above ~1.2 V. Community report: WHEA errors have been seen above it"))
            elif new is not None:
                hi = max((p.effective_v for p in new if p.effective_v is not None), default=None)
                if hi is not None and hi > vfmodel.E_WHEA_V:
                    warnings.append(Warn("E_TARGET_WHEA", f"{unit}: the predicted E-core voltage {hi:.3f} V is above ~1.2 V. Community report: WHEA errors have been seen above it"))
    # ---- F6: VccIA ----
    turbo_new = dict(turbo or {})  # D-050: the plan's own [turbo] tables (an explicit edit), never a table derived from an OC ratio
    for key, kind in (("p", "P"), ("e", "E")):
        ratios = None if profile.turbo is None else getattr(profile.turbo, key)
        if ratios is not None:
            turbo_new[kind] = {**(turbo_new.get(kind) or {}), "ratios": list(ratios)}
    vccia = _predict_vccia(models, curves_new, curves_cur, turbo, turbo_new, ocs_new, ocs_cur)
    if vccia is not None:
        warnings.append(
            "VccIA is a prediction: the highest requested VID among the units. Lowering a unit that does not set the maximum does not lower Vcore"
        )
    return {"predicted": predicted if record is not None else None, "predicted_oc": predicted_oc if record is not None else None, "vccia": vccia}


def _vccia_scenario(
    models: Mapping[str, _UnitModel], curves: Mapping[str, list[CurvePoint]], turbo: Mapping[str, Any] | None, which: int, ocs: Mapping[str, vfmodel.OcPrediction] | None = None,
) -> dict[str, Any] | None:
    """One F6 scenario: per unit the voltage at its allowed ratio (``which`` 0 = 1-2 active cores, 1 = all cores) on its curve and OC point (``ocs``: the OC points in force for the
    current state, the planned ones for the plan, B-03); ``not_measured`` lists the units whose number rests on an unmeasured rule."""
    rows: list[tuple[str, int, float | None]] = []
    unmeasured: dict[str, list[str]] = {}
    for unit, m in models.items():
        curve = curves.get(unit)
        allowed = _allowed_ratios(m, turbo)
        if curve is None or allowed is None:
            continue
        ratio = allowed[which]
        v, nm = vfmodel.voltage_detail(curve, ratio, (ocs or {}).get(unit))
        rows.append((unit, ratio, v))
        if nm and v is not None:
            unmeasured[unit] = list(nm)
    out = predict_vccia(rows)
    if out is None:
        return None
    best = {k: max((r for r in rows if r[0].startswith(k) and r[2] is not None), key=lambda r: r[2], default=None) for k in ("P", "E")}  # type: ignore[arg-type,return-value]
    out["contributors"] = {  # the unit of each group with the highest allowed VID, and the ring floor
        **{k: (None if r is None else {"unit": r[0], "ratio": r[1], "v": round(r[2], 4)}) for k, r in best.items()},
        "ring": None,  # the ring ratio is not read by tune.read: no number is shown for it
    }
    out["not_measured"] = unmeasured
    return out


def _predict_vccia(
    models: Mapping[str, _UnitModel],
    new: Mapping[str, list[CurvePoint]],
    cur: Mapping[str, list[CurvePoint]],
    turbo: Mapping[str, Any] | None,
    turbo_new: Mapping[str, Any] | None = None,
    ocs_new: Mapping[str, vfmodel.OcPrediction] | None = None,
    ocs_cur: Mapping[str, vfmodel.OcPrediction] | None = None,
) -> dict[str, Any] | None:
    """F6 for the all-core bucket (the one that matters for sustained load: the top points of the favored cores only count for 1-2 active cores), plus the
    1-2 core case as ``light_load`` and the current state as ``before_v`` (with the OC points in force, B-03). The value is the highest requested VID among the units (no ring, no
    margin). ``measured`` is false (with ``not_measured: {unit: [codes]}`` and a ``note``) when a unit's number rests on a rule nobody measured."""
    turbo_new = turbo if turbo_new is None else turbo_new
    full = _vccia_scenario(models, new, turbo_new, 1, ocs_new)
    if full is None:
        return None
    light = _vccia_scenario(models, new, turbo_new, 0, ocs_new)
    was = _vccia_scenario(models, cur, turbo, 1, ocs_cur)
    unmeasured: dict[str, list[str]] = {}
    for scenario in (full, light):
        for unit, codes in (scenario or {}).get("not_measured", {}).items():
            unmeasured[unit] = list(dict.fromkeys([*unmeasured.get(unit, []), *codes]))
    out = {
        "predicted_v": full["predicted_v"], "set_by": full["set_by"], "label": "highest requested VID among units", "active_cores": "all", "margin_v": None,
        "contributors": full["contributors"], "before_v": None if was is None else was["predicted_v"],
        "light_load": None if light is None else {"predicted_v": light["predicted_v"], "set_by": light["set_by"], "active_cores": "1-2"},
        "measured": not unmeasured,
    }
    if unmeasured:
        out["not_measured"] = unmeasured
        out["note"] = _not_measured_note(list(dict.fromkeys(c for codes in unmeasured.values() for c in codes)))
    return out


_Known = tuple[dict[int, CoreReadings], dict[tuple[int, int], int], "dict[int, int] | None"]


def _last_baseline(helper: Helper, profile: Profile, topology: Topology) -> _Known | None:
    """G-148: the planner's inputs as this boot's last read gives them (an E cluster read on one CPU stands for all four; ``0x26`` / ``0x28`` are not kept: 0 / unknown),
    for the round estimate and the preview of a complete profile. ``None`` without a read. G-154: the third item is the ring channel (``{0: OC word, k: point k}``, ``None`` when
    the ring was not read)."""
    last = _last_words(helper)
    if not last:
        return None
    fused = getattr(helper, "fused_words", None) or {}
    st = _state(helper)
    with st.lock:
        favored = dict(st.favored_words or {})
    baseline: dict[int, CoreReadings] = {}
    point_words: dict[tuple[int, int], int] = {}
    cpus = {t.cpu for t in (resolve_targets(profile, topology) if profile.entries else ())} | {p.cpu for p in resolve_point_targets(profile, topology)}
    for cpu in cpus:
        unit = unit_of_cpu(topology, cpu)
        ref = _unit_reference(last, (cpu, *unit_cpus(topology, unit)))
        if ref is None:
            continue
        ref_cpu, words = ref
        fused_word = fused.get(cpu, fused.get(ref_cpu))
        if fused_word is None:
            continue
        baseline[cpu] = CoreReadings(vf=VfWord.from_u32(words[0]), favored=favored.get(cpu, favored.get(ref_cpu, 0)), fused=fused_word, granular=0, vmax=None)
        for n, w in enumerate(words[1:], start=1):
            point_words[(cpu, n)] = w
    return baseline, point_words, _ring_word_map(_last_ring(helper))
