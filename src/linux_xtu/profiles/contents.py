"""What a profile holds, in the shape of a Tune intent (G-123, contract 9 ``profiles.get``): per unit ``{target, offset, v_target_v, ratio, layers}``.

Pure: no files, no hardware. A saved profile is already an intent (rows over ``P`` / ``E`` groups or units); an installed accepted profile is a
:class:`~linux_xtu.profiles.schema.Profile` (TOML) whose ``[[point]]`` entries are numbered points, converted here to ``{ratio: mV}`` with the platform's
point ratios of the last read (live; a point without a known ratio falls back to its ``expect_ratio``).

B-03 / R-09 (R-B1): a unit has two offset layers that the CPU ADDS -- the whole-curve offset (the ``P2 = 0`` word, ``[[core]] offset_mv``) and each fused point's own
(``[[point]]``) ``[MEASURED lnx 2026-10-11/12]``. Every row carries both as ``layers: {curve_mv, points_mv}`` (``curve_mv`` ``None`` = the profile does not set it). ``offset`` is
the one Tune-intent offset the row can be planned as: the whole curve when no point is moved, the point layer when the whole curve is 0 or not set, and ``None`` when both
layers hold a value -- one intent row carries one kind (the editor loads ``layers`` and plans the two layers apart). The whole-curve value is never folded into the points
(that replaced the point offsets with the curve value: the CPU would then run the sum twice).

G-148 (D-044): a **complete** profile names every unit and every fused point (offsets of 0 included). Its rows say so (``complete: true`` in the contents):
"Load into Tune" therefore fills every unit. A saved partial profile (older than G-148) is ``complete: false`` ("partial (legacy)"). R-B1: the contents also carry
the ring points (``ring: {oc_word, points: {P2: mV}}``, D-045), the runtime sections of schema 2 (``power`` / ``caps`` / ``uncore``; ``None`` = not captured, left as it is)
and the schema ``version`` the profile was read as.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any

from linux_xtu.curves.record import unit_order

from .schema import Profile

__all__ = ["intent_contents", "profile_contents", "summarize"]


def _row(unit: str, offset: dict[str, Any] | None, v: float | None, ratio: int | None, curve_mv: int | None, points_mv: Mapping[str, int]) -> dict[str, Any]:
    return {"target": unit, "offset": offset, "v_target_v": v, "ratio": ratio, "layers": {"curve_mv": curve_mv, "points_mv": dict(points_mv)}}


def _turbo(profile: Profile) -> dict[str, list[int]] | None:
    if profile.turbo is None:
        return None
    out = {key.upper(): list(getattr(profile.turbo, key)) for key in ("p", "e") if getattr(profile.turbo, key) is not None}
    return out or None


def _runtime(profile: Profile) -> dict[str, Any]:
    return {
        "ring": None if profile.ring is None else {"oc_word": f"0x{profile.ring.oc_word:08X}", "points": {str(p.point): p.offset_mv for p in profile.ring.points}},
        "power": None if profile.power is None else profile.power.intent(),
        "caps": None if profile.caps is None else profile.caps.as_dict(),
        "uncore": None if profile.uncore is None else profile.uncore.intent(),
        "version": profile.version,
    }


def _offset_of(curve: int | None, points: Mapping[str, int], complete: bool) -> dict[str, Any] | None:
    """The one intent offset a unit's two layers can be planned as (module docstring), or ``None`` when both hold a value."""
    moved = any(points.values())
    if not points or (complete and not moved):
        return None if curve is None else {"kind": "curve", "mv": curve}
    if curve is None or (complete and curve == 0):  # a complete profile states every layer: a whole curve of 0 is "untouched"; a partial one sets what it names
        return {"kind": "points", "mv": dict(points)}
    return None


def profile_contents(profile: Profile, topology: Any, unit_of_cpu: Callable[[int], str], point_ratios: Mapping[str, Sequence[int]] | None = None) -> dict[str, Any]:
    """``{rows: [{target: unit, offset, v_target_v, ratio, layers}], turbo: {P?, E?} | None, complete, ring, power, caps, uncore, version}`` in unit order. ``point_ratios``:
    unit id (or core kind) -> its fused point ratios from the last read."""
    point_ratios = point_ratios or {}
    curve: dict[str, int] = {}
    vt: dict[str, float] = {}
    oc: dict[str, int] = {}
    pts: dict[str, dict[int, int]] = {}
    for s in profile.expand(topology):
        unit = unit_of_cpu(s.cpu)
        if s.offset_mv is not None:
            curve[unit] = s.offset_mv
        if s.oc_voltage_mv is not None:
            vt[unit] = round(s.oc_voltage_mv / 1000, 4)
        if s.ratio is not None:
            oc[unit] = s.ratio
    for p in profile.expand_points(topology):
        unit = unit_of_cpu(p.cpu)
        table = point_ratios.get(unit) or point_ratios.get(p.kind) or ()
        ratio = (p.expect_ratio if profile.complete else None) or (table[p.point - 1] if 1 <= p.point <= len(table) else p.expect_ratio)
        if ratio is not None:
            pts.setdefault(unit, {})[int(ratio)] = p.offset_mv
    rows: list[dict[str, Any]] = []
    for unit in sorted({*curve, *vt, *oc, *pts}, key=unit_order):
        points = {str(r): mv for r, mv in sorted(pts.get(unit, {}).items())}
        rows.append(_row(unit, _offset_of(curve.get(unit), points, profile.complete), vt.get(unit), oc.get(unit), curve.get(unit), points))
    return {"rows": rows, "turbo": _turbo(profile), "complete": profile.complete, **_runtime(profile)}


def intent_contents(intent: Mapping[str, Any], unit_ids: Sequence[str]) -> dict[str, Any]:
    """The same shape for a saved ``{scope, rows}`` intent (a partial profile saved before G-148, schema 1): ``P`` / ``E`` rows are spread over the units of ``unit_ids`` (the live
    topology's) of that kind; a row's one offset is its one layer."""
    groups = {"P": [u for u in unit_ids if u.startswith("P")], "E": [u for u in unit_ids if u.startswith("EC")]}
    by_unit: dict[str, dict[str, Any]] = {}
    for r in intent.get("rows", []) if isinstance(intent.get("rows"), list) else []:
        target = r.get("target")
        off = r.get("offset") if isinstance(r.get("offset"), dict) else None
        curve_mv = off["mv"] if off and off.get("kind") == "curve" else None
        points_mv = dict(off["mv"]) if off and off.get("kind") == "points" and isinstance(off.get("mv"), dict) else {}
        for unit in groups.get(target, (target,)):
            if unit in unit_ids:
                by_unit[unit] = _row(unit, off, r.get("v_target_v"), r.get("ratio"), curve_mv, points_mv)
    turbo = intent.get("turbo")
    ring = intent.get("ring")
    return {"rows": [by_unit[u] for u in sorted(by_unit, key=unit_order)], "turbo": turbo if isinstance(turbo, dict) and turbo else None, "complete": False,
            "ring": None if not isinstance(ring, dict) else {"oc_word": None, "points": dict(ring.get("points") or {})}, "power": None, "caps": None, "uncore": None, "version": 1}


def summarize(contents: Mapping[str, Any]) -> dict[str, Any]:
    """``{units, points, deepest_offset_mv, oc_ratios, v_targets, turbo, complete}`` for the list view and the compare header. ``deepest_offset_mv`` is the deepest EFFECTIVE offset
    (whole-curve + point, B-03) of a row whose two layers both hold a value."""
    deepest: int | None = None
    points = oc = vt = 0
    rows = contents.get("rows", [])
    for r in rows:
        off = r.get("offset")
        layers = r.get("layers") or {}
        low: int | None = None
        if off:
            values = [off["mv"]] if off["kind"] == "curve" else list(off["mv"].values())
            points += len(off["mv"]) if off["kind"] == "points" else 0
            low = min(values)
        elif layers.get("curve_mv") is not None or layers.get("points_mv"):
            pts = layers.get("points_mv") or {}
            points += len(pts)
            low = (layers.get("curve_mv") or 0) + (min(pts.values()) if pts else 0)
        if low is not None:
            deepest = low if deepest is None else min(deepest, low)
        oc += r.get("ratio") is not None
        vt += r.get("v_target_v") is not None
    return {"units": len(rows), "points": points, "deepest_offset_mv": deepest, "oc_ratios": oc, "v_targets": vt, "turbo": bool(contents.get("turbo")),
            "complete": contents.get("complete") is True}
