"""Pure V/F model of an Arrow Lake-S part (SPEC-v3 section 9, F4/F5/F6): offset layers, monotonic clamp, interpolation, OC point, VccIA prediction.

No I/O, no hardware. Every function takes plain numbers; ``helper/tune_predict.py`` (preview and prediction, fed by ``tune_state`` and ``ops_tune_read``) feeds it the measured baseline curve (a ``vf.measure`` record flagged
``baseline``), the words of the last ``tune.read`` and the turbo tables. The results are PREDICTIONS (they carry no more certainty than their inputs); a
prediction that rests on a rule nobody measured says so (``not_measured`` codes, :data:`CURVE_WITH_OC` / :data:`INTERP_NOT_MEASURED`) instead of standing as a bare number.

Facts (``docs/knowledge/platform-arl-s.md`` sections 3 and 5):
  * Two offset layers per unit (B-03): the whole-curve offset (the offset field ``[31:21]`` of the ``P2 = 0`` word) shifts every fused point **in addition to** the
    point's own offset ``[MEASURED lnx 2026-10-11/12]``: effective offset = whole-curve + point. :func:`effective_curve` takes both and keeps them apart
    (``CurvePoint.curve_offset_mv`` inside ``offset_mv``).
  * F4 monotonic rule: hardware enforces V(n) >= V(n-1); a deeper offset is silently clamped up (P0 BIOS 57x -49.8 mV landed at -42.5 mV, i.e. clamped to
    the 56x voltage) ``[MEASURED lnx 2026-10-02]``. Between two points the VID interpolates linearly (54x = midpoint of 53x/55x, +-2 mV
    ``[MEASURED lnx 2026-10-03]``; E 45x -7.4 of -10 mV ``[MEASURED lnx 2026-10-02]``). Above the top point the bins follow the top point (E 47-48x run on
    point 6) ``[MEASURED lnx 2026-10-02]``.
  * OC point (G-120, ``[MEASURED lnx 2026-10-11/13]``, ``docs/knowledge/tuning-results.md``): an OC ratio above the top fused ratio adds a point whose adaptive target is
    held up to the top fused point's EFFECTIVE (offset) voltage (EC1 48x target 1.117 V < point 6 1.1375 V read back 1.1375 V; a 1.100 V target ran at point 6 with its
    offset); a target above it is the voltage (1.147 V gave 48x 1.1475 V). With no voltage given the helper writes the un-offset fused top voltage (``0x09 [19:8]``) as the
    target, so the top point's offset is not inherited. The bins between the top fused point and the OC ratio interpolate linearly (47x = midpoint of 46x and 48x = 1.1425 V),
    measured only with the top point at offset 0. NOT measured: whether a whole-curve offset moves an OC target (:data:`CURVE_WITH_OC`), and whether that line starts at the
    top point's offset voltage or its fused voltage when the top point carries an offset (:data:`INTERP_NOT_MEASURED`); the model keeps the target as written and starts
    the line at the effective top point, and flags both.
  * Factory curve from any measured curve (G-250, :func:`derive_factory`): factory(n) = measured(n) - (whole-curve + point offset) with the offsets decoded from the words the
    curve was measured under; a point on the F4 clamp (flat, deeper offset than the level-setting point) is interpolated instead, the top point is the fused 0x09 voltage.
    The UI twin is ``desktop/app/ui/lib/factory.js``; both are tested on ``desktop/app/ui/tests/factory-golden.json``.
  * F6 VccIA follows the highest VID ALLOWED for the active-core count (D-036: reported as that VID, no margin and no ring figure are assumed; callers label the
    result a prediction).
  * F5 turbo tables: stock bucket ratios do not rise with the active-core count ``[MEASURED lnx 2026-10-01]``; what the CPU does with a rising table was never measured.
    D-049 / D-053 item 5 make a rising table a refusal on every write path (the guard's plain-MSR checks and the planner at plan time); :func:`check_turbo_order` is the same
    rule over a plain list, for callers that have no MSR word.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from linux_xtu.mailbox.vf import VfWord

__all__ = [
    "CURVE_WITH_OC",
    "E_HINT_POINT",
    "E_NO_OFFSET_RATIO",
    "E_WHEA_V",
    "CLAMP_FLAT_V",
    "INTERP_NOT_MEASURED",
    "CurvePoint",
    "FactoryPoint",
    "OcPrediction",
    "check_turbo_order",
    "complete_baseline",
    "derive_factory",
    "effective_curve",
    "interpolate",
    "oc_point_voltage",
    "oc_prediction",
    "predict_vccia",
    "voltage_at",
    "voltage_detail",
]

#: A hint from ONE chip, not an architectural limit: on the reference chip a -20 mV offset on E point 5 (40x) gave OCCT errors that a bisect pinned to that offset
#: ``[MEASURED lnx 2026-10-02, one chip; platform-arl-s.md section 3 "E 40x point"]``. Warning code ``E40_OFFSET`` only; nothing is blocked. The point is named by its index
#: (P2 = 5 of an E cluster, B-19); ``E_NO_OFFSET_RATIO`` is that point's ratio on the chip it was seen on (kept for the text and older callers).
E_HINT_POINT = 5
E_NO_OFFSET_RATIO = 40
#: ``[COMMUNITY skatterbencher.com/2025/02/14/285k-whea-when-e-core-voltage-over-1-2v/]`` E-core WHEA reports above ~1.2 V (F8). A warning threshold only, never a limit.
E_WHEA_V = 1.2

#: ``not_measured`` code: a whole-curve offset on a unit with an OC point -- the fused points move by it ``[MEASURED]``, whether the OC target does is not measured.
CURVE_WITH_OC = "CURVE_WITH_OC"
#: ``not_measured`` code: a bin between the top fused point and the OC point while the top point carries an offset -- the line's start (offset or fused voltage) is not measured.
INTERP_NOT_MEASURED = "INTERP_NOT_MEASURED"

_EPS = 1e-9


@dataclass(frozen=True)
class CurvePoint:
    """One fused point after applying offsets. ``base_v`` None = no baseline voltage for this point (``effective_v`` is None too). ``offset_mv`` is the EFFECTIVE offset
    (whole-curve + the point's own, B-03); ``curve_offset_mv`` is the whole-curve layer inside it (``point_offset_mv`` the point's own).
    ``clamped_by`` = 1-based index (P2) of the point whose voltage held this one up (F4), else None."""

    index: int
    ratio: int
    base_v: float | None
    offset_mv: float
    effective_v: float | None
    clamped_by: int | None
    curve_offset_mv: float = 0.0

    @property
    def point_offset_mv(self) -> float:
        return self.offset_mv - self.curve_offset_mv


@dataclass(frozen=True)
class OcPrediction:
    """The OC point of a unit: its ``ratio``, the adaptive ``target_v`` written, the voltage it runs (``v`` = max(target, effective top point), F4), ``clamped_by`` = the index of
    the top point when it held the target up, and the rules nobody measured that the number rests on (``not_measured`` codes; empty = the measured model)."""

    ratio: int
    target_v: float
    v: float
    clamped_by: int | None
    clamped_ratio: int | None
    not_measured: tuple[str, ...] = ()

    @property
    def measured(self) -> bool:
        return not self.not_measured


def interpolate(known: Mapping[int, float | None], ratio: float) -> float | None:
    """Linear interpolation of ``ratio`` between the known ``{ratio: volts}`` entries; flat outside the known range (below the first, above the last).
    ``None`` if nothing is known."""
    pts = sorted((r, v) for r, v in known.items() if v is not None)
    if not pts:
        return None
    if ratio <= pts[0][0]:
        return pts[0][1]
    if ratio >= pts[-1][0]:
        return pts[-1][1]
    for (r0, v0), (r1, v1) in zip(pts, pts[1:]):
        if r0 <= ratio <= r1:
            return v0 + (v1 - v0) * (ratio - r0) / (r1 - r0)
    return None  # unreachable


def complete_baseline(
    point_ratios: Sequence[int], measured: Mapping[int, float | None], fused_top_v: float | None = None
) -> dict[int, float | None]:
    """The stock voltage of every fused point: the measured one where there is one; the top point from the fused ``0x09`` voltage when it was not measured
    (F7: favored 57x often "mismatch"); a point between two known ones interpolated linearly (measured, F4). A point below the lowest known one stays None (R-B1: a stock
    curve rises with the ratio, so copying the lowest known voltage down would invent a voltage above the real one and clamp the points above it; nothing is assumed)."""
    known: dict[int, float | None] = {r: measured.get(r) for r in point_ratios}
    top = max(point_ratios)
    if known[top] is None and fused_top_v is not None:
        known[top] = fused_top_v
    have = {r: v for r, v in known.items() if v is not None}
    low = min(have) if have else None
    return {r: (v if v is not None else (interpolate(have, r) if low is not None and r > low else None)) for r, v in known.items()}


def effective_curve(
    point_ratios: Sequence[int], baseline: Mapping[int, float | None], offsets_mv: Mapping[int, float], curve_offset_mv: float = 0.0
) -> list[CurvePoint]:
    """Baseline voltage + whole-curve offset + point offset per point (B-03: the two layers ADD), then the F4 clamp: V_eff(n) = max(V_eff(n-1), base(n) + offsets(n)) (a point
    without a known baseline is left out of the chain and stays None). ``offsets_mv`` is the point layer keyed by ratio; ``curve_offset_mv`` the unit's whole-curve offset
    (``P2 = 0`` ``[31:21]``). ``clamped_by`` names the point whose (effective) voltage was used."""
    out: list[CurvePoint] = []
    prev_v: float | None = None
    prev_idx: int | None = None
    curve = float(curve_offset_mv)
    for n, ratio in enumerate(point_ratios, start=1):
        base = baseline.get(ratio)
        off = float(offsets_mv.get(ratio, 0.0)) + curve
        if base is None:
            out.append(CurvePoint(n, ratio, None, off, None, None, curve))
            continue
        want = base + off / 1000.0
        if prev_v is not None and want < prev_v - _EPS:
            out.append(CurvePoint(n, ratio, base, off, prev_v, prev_idx, curve))
            continue  # prev stays the reference: the clamped value equals it
        out.append(CurvePoint(n, ratio, base, off, want, None, curve))
        prev_v, prev_idx = want, n
    return out


#: G-250: a measured point whose voltage is not above its lower neighbour's by more than this is "flat" (the measurement step: ``vid_v`` is a median of VID samples; the 54x
#: midpoint check was +-2 mV ``[MEASURED lnx 2026-10-03]``). ``[UNVERIFIED]`` as a limit; it only decides when a point is treated as possibly lifted by the F4 clamp.
CLAMP_FLAT_V = 0.004
#: Offsets are 1/1024 V steps (~0.98 mV): "more negative" means at least this much (mV) below the point that set the level.
_OFFSET_EPS_MV = 0.4


@dataclass(frozen=True)
class FactoryPoint:
    """One fused point's factory voltage derived from a measured curve (G-250). ``src``: ``fused`` (the CPU's 0x09 top-point voltage, exact), ``derived`` (measured V minus the
    effective offset the point was measured with), ``interpolated`` (between trusted neighbours: the point was clamped, unmeasured or its offset unknown), ``""`` (nothing known).
    ``measured_v`` / ``offset_mv`` (effective = whole-curve + point) are what it was derived from; ``clamped`` = the F4 clamp probably lifted it (measured - offset not trusted);
    ``check_mv`` (top point only, when both exist) = derived - fused, in mV."""

    ratio: int
    v: float | None
    src: str
    measured_v: float | None = None
    offset_mv: float | None = None
    clamped: bool = False
    check_mv: float | None = None


def derive_factory(
    point_ratios: Sequence[int],
    measured: Mapping[int, float | None],
    words: Sequence[int] | None,
    fused_top: tuple[int, float] | None = None,
    flat_v: float = CLAMP_FLAT_V,
) -> list[FactoryPoint]:
    """G-250: the factory (offset-free) voltage of every fused point of ONE unit from ANY complete measured curve:

        factory(n) = measured(n) - (whole-curve offset + point n's offset) / 1000          (both read from the words in force while the curve was measured)

    ``point_ratios`` = the unit's fused points (no OC point: a ratio above the fused top is not a fused point), ``measured`` = ``{ratio: vid_v}`` of the ``ok`` points only
    (an interpolated record point is not a measurement), ``words`` = the unit's first CPU's words while measuring (``[P2 = 0 word, point 1, point 2, ...]``; the whole-curve
    offset is ``[31:21]`` of the first, each point's own offset is ``[31:21]`` of the word whose ``[7:0]`` ratio is the point's; the same decoder as every other V/F word,
    1/1024 V steps); ``None`` = a stock curve (every offset 0). ``fused_top`` = ``(ratio, volts)`` of the CPU's 0x09 word.

    Clamp rule (F4, ``V(n) >= V(n-1)`` in hardware ``[MEASURED lnx 2026-10-02]``): where a point is not above the last trusted measured point by more than ``flat_v`` AND carries a
    more negative effective offset than the point that set that level, it was probably lifted by the clamp -- measured minus offset would then be too high -- so it is NOT derived:
    it is filled by linear interpolation between its trusted neighbours (``src interpolated``, ``clamped``). The top point takes the fused 0x09 voltage when given (it also anchors the
    interpolation); the difference to its derived value is reported in ``check_mv``. A point with no trusted neighbour on one side stays ``None``."""
    ratios = sorted({int(r) for r in point_ratios})
    if not ratios:
        return []
    top = ratios[-1]
    curve_mv: float | None = 0.0
    own: dict[int, float] = {}
    if words is not None:
        decoded = [VfWord.from_u32(int(w) & 0xFFFFFFFF) for w in words]
        curve_mv = decoded[0].offset_mv if decoded else None
        for w in decoded[1:]:
            if w.ratio:
                own[w.ratio] = w.offset_mv
    eff: dict[int, float | None] = {}
    for r in ratios:
        if curve_mv is None:
            eff[r] = None
        elif words is None:
            eff[r] = 0.0
        else:
            eff[r] = None if r not in own else curve_mv + own[r]
    trusted: dict[int, float] = {}
    clamped: set[int] = set()
    level_v: float | None = None
    level_off = 0.0
    for r in ratios:
        m, off = measured.get(r), eff[r]
        if m is None or off is None:
            continue
        if level_v is not None and m <= level_v + flat_v and off < level_off - _OFFSET_EPS_MV:
            clamped.add(r)  # flat while its offset is deeper than the level-setting point's: the clamp's signature; the level stays
            continue
        trusted[r] = m - off / 1000.0
        level_v, level_off = m, off
    derived_top = (measured[top] - eff[top] / 1000.0) if measured.get(top) is not None and eff[top] is not None else None
    fused_v: float | None = None
    if fused_top is not None and int(fused_top[0]) == top and fused_top[1] is not None:
        fused_v = float(fused_top[1])
    known = dict(trusted)
    if fused_v is not None:
        known[top] = fused_v
    out: list[FactoryPoint] = []
    for r in ratios:
        m, off = measured.get(r), eff[r]
        if r in known:
            is_fused = r == top and fused_v is not None
            out.append(FactoryPoint(r, known[r], "fused" if is_fused else "derived", m, off, r in clamped,
                                    None if not is_fused or derived_top is None else round((derived_top - fused_v) * 1000.0, 1)))
            continue
        lo = [k for k in known if k < r]
        hi = [k for k in known if k > r]
        v = interpolate(known, r) if lo and hi else None
        out.append(FactoryPoint(r, v, "interpolated" if v is not None else "", m, off, r in clamped))
    return out


def _top(curve: Sequence[CurvePoint]) -> CurvePoint | None:
    known = [p for p in curve if p.effective_v is not None]
    return known[-1] if known else None


def oc_prediction(curve: Sequence[CurvePoint], ratio: int, target_v: float, curve_offset_mv: float = 0.0) -> OcPrediction | None:
    """G-120 / B-03: the OC point at ``ratio`` with adaptive ``target_v`` on a unit whose fused points are ``curve`` and whose whole-curve offset is ``curve_offset_mv``:
    ``v = max(target, V_eff(top fused point))`` (the clamp to the EFFECTIVE top point is measured). A non-zero whole-curve offset adds :data:`CURVE_WITH_OC` -- the model keeps
    the target as written, which nobody measured. ``None`` when the curve has no known voltage."""
    top = _top(curve)
    if top is None or top.effective_v is None:
        return None
    nm = (CURVE_WITH_OC,) if abs(curve_offset_mv) > _EPS else ()
    if target_v < top.effective_v - _EPS:
        return OcPrediction(ratio, target_v, top.effective_v, top.index, top.ratio, nm)
    return OcPrediction(ratio, target_v, target_v, None, None, nm)


def oc_point_voltage(curve: Sequence[CurvePoint], target_v: float) -> tuple[float, bool] | None:
    """G-120: the effective voltage of an OC point with adaptive ``target_v``: ``max(target, V(top fused point))`` (F4 holds for the OC point too). Returns
    ``(volts, clamped)`` (``clamped`` = the target was below the top fused point and was held up to it), or None when the curve has no known voltage. See
    :func:`oc_prediction` for the form that says what is not measured."""
    pred = oc_prediction(curve, 0, target_v)
    return None if pred is None else (pred.v, pred.clamped_by is not None)


def voltage_detail(curve: Sequence[CurvePoint], ratio: float, oc: OcPrediction | None = None) -> tuple[float | None, tuple[str, ...]]:
    """``(volts, not_measured codes)`` at any ratio: interpolated between the clamped points, flat above the top point unless the unit has an OC point ``oc`` (then linear from the
    effective top point to ``oc.v`` at ``oc.ratio``, flat above it). A bin strictly between the top point and the OC ratio while the top point carries an offset (or is clamped)
    adds :data:`INTERP_NOT_MEASURED`; every bin at or above the top point inherits ``oc.not_measured``."""
    known = {p.ratio: p.effective_v for p in curve if p.effective_v is not None}
    if not known:
        return None, ()
    top = _top(curve)
    assert top is not None and top.effective_v is not None
    if oc is not None and oc.ratio > top.ratio and ratio > top.ratio:
        nm = list(oc.not_measured)
        if ratio < oc.ratio and top.base_v is not None and abs(top.effective_v - top.base_v) > _EPS:
            nm.append(INTERP_NOT_MEASURED)
        return interpolate({top.ratio: top.effective_v, oc.ratio: oc.v}, min(ratio, oc.ratio)), tuple(dict.fromkeys(nm))
    return interpolate(known, ratio), ()


def voltage_at(curve: Sequence[CurvePoint], ratio: float, oc: tuple[int, float] | None = None) -> float | None:
    """The effective voltage at any ratio (:func:`voltage_detail` without the flags): ``oc`` = ``(OC ratio, adaptive target V)`` or None."""
    pred = None if oc is None else oc_prediction(curve, oc[0], oc[1])
    return voltage_detail(curve, ratio, pred)[0]


def predict_vccia(contributors: Sequence[tuple[str, int, float | None]]) -> dict[str, object] | None:
    """F6: the highest requested VID among the units. ``contributors`` = ``(unit, allowed_ratio, volts)``; a unit without a voltage is skipped. Returns
    ``{"predicted_v", "set_by": {"unit", "ratio"}, "margin_v": None}`` or None if no unit has a voltage."""
    rows = [(u, r, v) for u, r, v in contributors if v is not None]
    if not rows:
        return None
    unit, ratio, volts = max(rows, key=lambda row: row[2])
    return {"predicted_v": round(volts, 4), "set_by": {"unit": unit, "ratio": ratio}, "margin_v": None}


def check_turbo_order(buckets: Sequence[int]) -> int | None:
    """F5: index (0-based bucket) of the first bucket whose ratio is HIGHER than the bucket before it (more active cores must never raise the ratio), or
    None if the table is non-increasing."""
    for k in range(1, len(buckets)):
        if buckets[k] > buckets[k - 1]:
            return k
    return None
