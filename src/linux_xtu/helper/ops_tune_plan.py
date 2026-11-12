"""``tune.plan`` (R-D1, split from ``ops_tune``; G-112, G-148, R-B1): pure -- no hardware, no mailbox, not write-gated.

The intent is resolved (``tune_intent``) and pre-flighted against the policy bound to this boot's CPU limits and the per-boot budget (``controls.preflight``), then judged by
the plan-time rules, each refusal naming its field (``detail.key``) and storing nothing: Undervolt Protection known on (``UNDERVOLT_PROTECTION``, G-240), a positive offset
the apply cannot bound (``POSITIVE_OFFSET_UNPROVEN``) or a summed voltage above the CPU's limit (``POLICY_RANGE``; B-01, the guard's own formula), a target without an OC
point (``TARGET_NEEDS_OC_POINT``), a write order the planner refuses, a ring-only plan whose ring is refused (``RING_REFUSED``). The result lists the write steps in the
apply's own order (``build_plan`` on the last read's words), the preview and prediction (``tune_predict``), the warnings, and -- for a profile / restore plan -- the runtime
sections that differ as ``requests`` for ``power.plan`` / ``runtime.plan``. The plan is stored (plan id, single-use nonce, 600 s) with the words, ring words and turbo
tables it assumed: ``tune.apply`` refuses with ``PLAN_STALE`` when one changed.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import re
import secrets
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any

from linux_xtu.controls import (
    READS_PER_CPU,
    REVERT_NOTE,
    SPLIT_EXTRA_WRITES,
    VMAX_EXTRA_READS,
    WRITES_PER_CPU,
    NeedsBootBudget,
    NeedsHigherLimit,
    PlanError,
    PlanRefused,
    PreflightError,
    StepKind,
    count_operations,
    pack_turbo,
    plan_warnings,
    preflight,
    read_steps,
    resolve_point_targets,
    resolve_targets,
    resolve_ring_targets,
)
from linux_xtu.guard import Policy
from linux_xtu.controls import residual
from linux_xtu.controls import ring as ringmod
from linux_xtu.controls.planner import (
    POINT_CAVEAT,
    POSITIVE_OFFSET,
    TURBO_MSR,
    TURBO_ORDER,
    Warn,
    build_plan,
    _same_state,
    _goal_word,
    change_notes,
    current_word,
    needs_vmax,
    oc_cap_reads_of,
    turbo_change_notes,
    turbo_order_bucket,
    walk_reads_of,
)
from linux_xtu.controls.planner import _turbo_tables as _profile_turbo_tables  # G-231: the planner's own (msr, ratios) of a profile's [turbo] tables
from linux_xtu.guard.policy import CPU_LIMIT_UNREAD, fused_top_ratio, v_target_limit
from linux_xtu.guard.policy import summed_voltage_raw  # B-01: the guard's own sum of a unit's voltage contributions (R-B1 plan-time rule; one formula)
from linux_xtu.mailbox import Cmd, VfWord
from linux_xtu.profiles import Profile, ProfileError
from linux_xtu.topology import Topology, UnknownCore

from .ops import OpContext, _only
from .ops_profiles import capture_runtime
from .ops_tune_read import _FUSED_CMD, _FUSED_P1
from .protocol import BAD_REQUEST, MAX_LINE, REFUSED, OpError
from .tune_intent import Resolved, _bad, canonical_hash, canonical_intent, resolve_intent
from .tune_predict import _Known, _before_after, _last_baseline, _planner_goal, _predict
from .tune_state import (
    PLAN_EXPIRES_S,
    StoredPlan,
    UVP_CHECK,
    UVP_MESSAGE,
    UVP_UNKNOWN_NOTE,
    _NONCE_ALPHABET,
    _RESPONSE_SLACK,
    _kind_of,
    _last_ring,
    _last_words,
    _load_policy,
    _state,
    _state_known_at,
    _topology,
    _unit_reference,
    _uvp,
    unit_cpus,
    unit_of_cpu,
)

if TYPE_CHECKING:
    from .core import Helper

__all__ = ["POSITIVE_CHECK", "PlannedPlan", "op_tune_plan", "warning_objects"]


@dataclasses.dataclass
class PlannedPlan(StoredPlan):
    """A ``tune.plan`` the apply can tell more about than the generic :class:`StoredPlan` (G-242, QA-29): ``planned_writes`` is the number of writes the plan certainly sends
    (the conditional per-core enable excluded) and ``nothing_to_do`` is True only when the plan holds no write AND the apply has nothing it could add on its own (no residual OC
    point to rewrite): such an apply sends nothing at all, not even the reads of its baseline pass. ``op`` names the run in the closing audit record."""

    planned_writes: int = -1
    nothing_to_do: bool = False
    op: str = "tune.apply"
    based_on_read_at: str | None = None  # G-248: when the stored read the plan rests on was taken (ISO UTC); None = no stored read of this boot
    residual_writes_max: int = 0  # G-248: the most residual-OC-point rewrites (G-147) the apply may add to ``writes``


#: ``tune.plan`` echoes at most this many predicted write steps (the full count is ``writes``): the response line is capped at 64 KiB.
_MAX_STEPS_LISTED = 300


# --------------------------------------------------------------------------------------------------------------
# Warnings, Undervolt Protection, and the write steps in the apply's own order
# --------------------------------------------------------------------------------------------------------------
_TURBO_RAISE_TEXT = re.compile(r"the ([PE]) turbo table \(0x[0-9A-Fa-f]+\) is RAISED in bucket\(s\) (\d+(?:, \d+)*) \(package-wide\)")


def _plain_warning(code: str, text: str) -> str:
    """G-242 (QA-18): the warning in operator words. ``TURBO_RAISE`` (made in ``tune_intent``) says "is RAISED in bucket(s) 8 (package-wide)"; the page shows
    "Raises the P turbo table at 8 busy cores (applies to all P-cores)." Any other text is left as it is."""
    m = _TURBO_RAISE_TEXT.fullmatch(text) if code == "TURBO_RAISE" else None
    if m is None:
        return text
    kind, buckets = m.group(1), m.group(2).split(", ")
    at = ", ".join(buckets[:-1]) + " and " + buckets[-1] if len(buckets) > 1 else buckets[0]
    return f"Raises the {kind} turbo table at {at} busy {'core' if buckets == ['1'] else 'cores'} (applies to all {kind}-cores)."


def warning_objects(items: Sequence[str]) -> list[dict[str, str]]:
    return [{"code": (code := getattr(w, "code", "NOTE")), "text": _plain_warning(code, str(w))} for w in items]


def _uvp_plan_check(helper: Helper, profile: Profile, topology: Topology, warnings: list[str]) -> None:
    """G-240: with Undervolt Protection known on, a plan with a negative offset (point, whole curve, ring point) is refused before
    any write, located at the unit / point like ``_check_range``; with the state unknown the plan carries a note when it holds a negative offset."""
    state = _uvp(helper)
    if state == "off":
        return

    def refuse(text: str) -> OpError:
        return OpError(REFUSED, f"{text}: {UVP_MESSAGE} Nothing was sent.", {"check": UVP_CHECK})

    negative = False
    # G-240 review f1: a complete profile (accepted restore, saved state) lists words the CPU already holds; only a word it would actually WRITE can be refused
    known = _last_baseline(helper, profile, topology) if profile.complete else None
    base_words, point_words, ring_words = known if known is not None else ({}, {}, None)

    def held_offset(word: int | None, mv: float) -> bool:
        return word is not None and VfWord.from_u32(word).offset_raw == VfWord.mv_to_offset_raw(mv)

    for setting in profile.expand(topology):
        unit = unit_of_cpu(topology, setting.cpu)
        rd = base_words.get(setting.cpu)
        if setting.offset_mv is not None and setting.offset_mv < 0 and not (rd is not None and held_offset(rd.vf.to_u32(), setting.offset_mv)):
            negative = True
            if state == "on":
                raise refuse(f"{unit}: offset {setting.offset_mv:+g} mV")
    for point in profile.expand_points(topology):
        if point.offset_mv < 0 and not held_offset(point_words.get((point.cpu, point.point)), point.offset_mv):
            negative = True
            if state == "on":
                raise refuse(f"{unit_of_cpu(topology, point.cpu)}: offset {point.offset_mv:+g} mV")
    if profile.ring is not None:
        for rp in profile.ring.points:
            if rp.offset_mv < 0 and not held_offset(None if ring_words is None else ring_words.get(rp.point), rp.offset_mv):
                negative = True
                if state == "on":
                    raise refuse(f"ring point {rp.point}: offset {rp.offset_mv:+g} mV")
    if negative and state == "unknown":
        warnings.append(UVP_UNKNOWN_NOTE)


_ORDER_NOTE = "the apply orders the writes so that no ratio's voltage dips (G-151); the order is decided from its own reads"


def _apply_order(
    profile: Profile, topology: Topology, policy: Policy, known: _Known | None, tables: Mapping[str, Sequence[int]] | None = None
) -> tuple[dict[tuple[str, int, int], int] | None, tuple[str, ...]]:
    """G-153: the place of every point / per-core write in the order the apply will send them, from the planner itself (``build_plan`` on the last read's words, so
    ``reorder_writes`` is the one ordering rule) -- ``{(kind, cpu, point): place}``; ``None`` without a read that covers every unit (the static order stays). A unit the order model
    refuses (``write_order``) raises the apply's own refusal. R-B8 (review of R-B2, P3): the profile's turbo tables take part when ``tables`` (this boot's read,
    ``TuneState.tables``) holds each of them -- a table that only lowers goes before the per-core words, one that raises after them, and a lowering E table changes whether
    an E lowering sends its ``0x1D`` first -- keyed ``("write_msr", msr, 0)`` (:func:`_order_key`); without them the tables are left out of the plan and listed last."""
    if known is None:
        return None, ()
    targets = resolve_targets(profile, topology) if profile.entries else ()
    covered = all(t.cpu in known[0] for t in targets) and all((p.cpu, p.point) in known[1] for p in resolve_point_targets(profile, topology))
    profile_tables = _profile_turbo_tables(profile)
    msr_words = {msr: pack_turbo(tables[_TURBO_TABLE_KEY[msr]]) for msr, _ in profile_tables if tables is not None and _TURBO_TABLE_KEY[msr] in tables}
    with_tables = bool(profile_tables) and len(msr_words) == len(profile_tables)
    try:
        plan = build_plan(
            profile if with_tables else dataclasses.replace(profile, turbo=None), topology, known[0], per_core_enabled=None, policy=policy, point_words=known[1],
            only_changed=profile.complete, ring_words=known[2], msr_words=msr_words if with_tables else None,
        )
    except PlanError as exc:
        if covered:  # G-241: the last read holds every word the plan needs, so this is the error the apply would raise from its own reads: Review shows it, nothing is sent
            raise OpError(BAD_REQUEST, str(exc)) from None
        return None, ()  # a word the last read does not hold: the apply decides from its own reads
    except (ProfileError, ValueError):
        return None, ()
    refused = tuple(r for r in plan.refusals if r.reason == "CHECK_FAILED" and r.detail.startswith("write_order"))
    if refused:
        raise _preflight_error(PlanRefused(refused, plan))
    place: dict[tuple[str, int, int], int] = {}
    for st in plan.steps:
        if st.kind is StepKind.WRITE_MSR and st.msr is not None:
            place.setdefault((st.kind.value, st.msr, 0), len(place))  # R-B8: a turbo table, where the planner puts it
        elif st.kind.is_write and st.msr is None and st.kind is not StepKind.WRITE_PERCORE_ENABLE:
            place.setdefault((st.kind.value, st.cpu, st.p2), len(place))
    return place, (plan.ring_refused if known[2] is not None else ())


def _order_key(step: Mapping[str, Any]) -> tuple[str, int, int]:
    """The ``_apply_order`` key of a listed step: ``(kind, cpu, point)``, a turbo table's ``(kind, msr, 0)``."""
    if "table" in step:
        return (step["kind"], TURBO_MSR[step["table"]], 0)
    return (step["kind"], step["cpu"], step.get("point", 0))


_TURBO_TABLE_KEY = {msr: key for key, msr in TURBO_MSR.items()}  # {0x1AD: "p", 0x650: "e"}: the helper's table key of a planner (msr, ratios) table


def _turbo_steps(profile: Profile, tables: Mapping[str, Sequence[int]] | None) -> list[dict[str, Any]]:
    """The ``write_msr`` steps of the profile's ``[turbo]`` tables the CPU does not already hold, in the planner's order (E, P). The comparison is the planner's
    own -- ``build_plan`` skips a table whose ``pack_turbo(ratios)`` equals the word it read (``planner.py``, the ``if new == old: continue`` of the turbo loop) --
    applied to ``tables`` (``TuneState.tables``: the eight ratio bytes of the word this boot's last read returned), so the listed steps and the executor cannot
    disagree. A table the helper has no word for is listed: the apply decides from its own read."""
    out: list[dict[str, Any]] = []
    for msr, ratios in _profile_turbo_tables(profile):
        key = _TURBO_TABLE_KEY[msr]
        old = None if tables is None else tables.get(key)
        if old is not None and pack_turbo(ratios) == pack_turbo(old):
            continue  # the table the CPU holds: no write, no count (G-231)
        # R-F1a: the shell's native dialog names every written value, so the step carries both tables (8 bucket ratios, bucket 0 = 1 active core); ``before`` is
        # null for a table this boot has not read (the shell says "not read")
        out.append({"kind": StepKind.WRITE_MSR.value, "table": key, "before": None if old is None else [int(r) for r in old], "after": [int(r) for r in ratios]})
    return out


def _predicted_steps(
    profile: Profile,
    topology: Topology,
    known: _Known | None = None,
    order: Mapping[tuple[str, int, int], int] | None = None,
    ring_refused: bool = False,
    tables: Mapping[str, Sequence[int]] | None = None,
) -> tuple[list[dict[str, Any]], int, int]:
    """The write steps the plan will contain, in the planner's order (conditional 0x15, point offsets, per-core triples, turbo tables), without data
    words (those need the hardware baselines and are built at apply time). Returns ``(listed steps, total writes, read-only requests)``. G-148: for a complete
    profile with ``known`` (the last read, ``_last_baseline``) a word the CPU already holds is not listed (the apply writes only what differs). G-153: ``order``
    (``_apply_order``) puts the point and per-core steps in the apply's own order. G-231: a ``[turbo]`` table equal to the one ``tables`` (this boot's read) holds
    is not listed either -- the planner and the executor skip it (``_turbo_steps``)."""
    targets = resolve_targets(profile, topology) if profile.entries else ()
    pts = resolve_point_targets(profile, topology)
    rings = resolve_ring_targets(profile, topology)
    reads = (1 if (targets or pts) else 0) + 4 * len(targets) + sum(1 for t in targets if needs_vmax(t)) + len(pts) + (len(rings) + 1 if rings else 0)  # every word is read, also the unchanged ones
    if profile.complete and known is not None:
        baseline, words, ring_known = known

        def unchanged_point(p: Any) -> bool:
            w = words.get((p.cpu, p.point))
            return w is not None and VfWord.from_u32(w).offset_raw == VfWord.mv_to_offset_raw(p.offset_mv) and (p.expect_ratio is None or VfWord.from_u32(w).ratio == p.expect_ratio)

        def unchanged_core(t: Any) -> bool:
            rd = baseline.get(t.cpu)
            if rd is None or (t.fused_top_ratio is not None and fused_top_ratio(rd.fused) != t.fused_top_ratio):
                return False
            top = fused_top_ratio(rd.fused)
            try:
                goal = _goal_word(t, current_word(rd, t.ratio is not None or t.oc_voltage_mv is not None), top)
            except PlanError:
                return False
            return _same_state(t, rd, goal, top)

        pts = tuple(p for p in pts if not unchanged_point(p))
        targets = tuple(t for t in targets if not unchanged_core(t))
        if ring_known is not None:  # G-154: a ring point the CPU already holds is not listed

            def unchanged_ring(r: Any) -> bool:
                w = ring_known.get(r.point)
                return w is not None and VfWord.from_u32(w).offset_raw == VfWord.mv_to_offset_raw(r.offset_mv) and VfWord.from_u32(w).ratio == r.expect_ratio

            rings = tuple(r for r in rings if not unchanged_ring(r))
    if ring_refused:  # G-154: the plan refuses the ring unit alone: no ring step is listed (the reason is a plan warning)
        rings = ()
    steps: list[dict[str, Any]] = [{"kind": StepKind.WRITE_PERCORE_ENABLE.value, "conditional": True}] if (targets or pts) else []  # G-117 / G-148: none without a mailbox write
    for p in pts:
        steps.append({"kind": StepKind.WRITE_VF_POINT.value, "unit": unit_of_cpu(topology, p.cpu), "cpu": p.cpu, "point": p.point, "offset_mv": p.offset_mv})
    for t in targets:
        u = unit_of_cpu(topology, t.cpu)
        # G-124 (as G-122 in the planner): a target that sets no OC ratio sends the 0x11 alone -- no 0x1D (favored) and no 0x27 (granular)
        kinds = (StepKind.WRITE_VF, StepKind.WRITE_FAVORED, StepKind.WRITE_GRANULAR) if t.ratio is not None else (StepKind.WRITE_VF,)
        for kind in kinds:
            steps.append({"kind": kind.value, "unit": u, "cpu": t.cpu, "point": 0})
    for r in rings:  # G-154: one ring-point write each (the ring OC word is never written)
        steps.append({"kind": StepKind.WRITE_RING_POINT.value, "unit": ringmod.UNIT, "cpu": r.cpu, "point": r.point, "offset_mv": r.offset_mv})
    if profile.turbo is not None:
        steps.extend(_turbo_steps(profile, tables))  # G-231: only a table that differs from what the CPU holds
    if order is not None:  # the 0x15 keeps its place (first); the rest follows the apply (R-B8: the tables too; one the order does not know stays last)
        first = 1 if steps and steps[0]["kind"] == StepKind.WRITE_PERCORE_ENABLE.value else 0
        steps[first:] = sorted(steps[first:], key=lambda s: order.get(_order_key(s), len(order)))
    total = len(steps)
    listed = [{"n": i, **s} for i, s in enumerate(steps[:_MAX_STEPS_LISTED], start=1)]
    return listed, total, reads


# --------------------------------------------------------------------------------------------------------------
# tune.plan
# --------------------------------------------------------------------------------------------------------------
def _validate_tune_plan(args: dict[str, Any]) -> dict[str, Any]:
    _only(args, {"intent"})
    if "intent" not in args:
        raise _bad("tune.plan needs an 'intent'")
    return {"intent": canonical_intent(args["intent"])}


_REFUSAL_CHECK = {"CHECK_FAILED": "POLICY_RANGE"}


def _preflight_error(exc: PreflightError) -> OpError:
    if isinstance(exc, NeedsHigherLimit):
        return OpError(REFUSED, f"{exc}. Nothing was sent.", {"check": "SESSION_LIMIT"})
    if isinstance(exc, NeedsBootBudget):
        return OpError(REFUSED, f"{exc}. Nothing was sent.", {"check": "BOOT_LIMIT"})
    if isinstance(exc, PlanRefused):
        first = exc.refusals[0]
        if first.msr in _TURBO_TABLE_KEY and "turbo_order:" in first.detail:  # D-053 item 5: a rising table, refused at plan time; the page points at the bucket
            return OpError(REFUSED, f"{exc}. Nothing was sent.", {"check": TURBO_ORDER, "table": _TURBO_TABLE_KEY[first.msr].upper(), "bucket": turbo_order_bucket(first.detail)})
        if CPU_LIMIT_UNREAD in first.detail:  # D-049: the CPU's own limit was not read; the detail names the read (cmd 0x01 / cmd 0x28)
            return OpError(REFUSED, f"{exc}. Nothing was sent.", {"check": CPU_LIMIT_UNREAD})
        return OpError(REFUSED, f"{exc}. Nothing was sent.", {"check": _REFUSAL_CHECK.get(first.reason, first.reason)})
    return OpError(REFUSED, f"{exc}. Nothing was sent.", {"check": "PREFLIGHT"})


def _no_write(err: OpError) -> OpError:
    """G-241: an apply-side refusal raised before the first write says so (``detail.writes_sent == 0``), so the page shows every unit "not written"."""
    err.detail = {**(err.detail or {}), "writes_sent": 0}
    return err


def _base_ratio(helper: Helper, topology: Topology, kind: str) -> int | None:
    """The base ratio of a core kind from the cpufreq ``base_frequency`` of its first CPU (kHz / 100000), for the ``TURBO_BELOW_BASE`` warning of ``tune.plan``; ``None`` without the
    measurement wiring or when the file is unreadable (no warning then -- it is a warning, never a limit)."""
    w = getattr(helper, "measure_wiring", None)
    cpu = next((c.cpu for c in topology.cores if c.kind == kind), None)
    if w is None or cpu is None:
        return None
    try:
        khz = int(str(w.cpufreq.read(cpu, "base_frequency")).strip())
    except (OSError, ValueError, TypeError):
        return None
    return khz // 100_000 or None


def _turbo_shape_warnings(helper: Helper, profile: Profile, topology: Topology | None = None) -> list[str]:
    """D-049: F5 (bucket ratios should not RISE with the active-core count), a bucket below the base ratio and a bucket moved by more than ``LARGE_RATIO_CHANGE`` are *warnings*
    (``TURBO_NOT_MONOTONIC`` / ``TURBO_BELOW_BASE`` / ``LARGE_CHANGE``) from ``controls.planner.turbo_change_notes``. What the CPU does with a rising table was never measured; D-053
    item 5 makes a rising table a refusal at plan on every path, which the planner owns (task R-B2) -- until then it stays this warning."""
    if profile.turbo is None:
        return []
    st = _state(helper)
    with st.lock:
        tables = st.tables
    out: list[str] = []
    for key, label in (("p", "P turbo table (MSR 0x1AD)"), ("e", "E turbo table (MSR 0x650)")):
        table = getattr(profile.turbo, key)
        if table is None:
            continue
        old = None if tables is None else tables.get(key)
        base = None if topology is None else _base_ratio(helper, topology, key.upper())
        out.extend(Warn(code, text) for code, text in turbo_change_notes(label, table, old, base))
    return out


def _oc_below_table_warnings(helper: Helper, profile: Profile, topology: Topology) -> list[str]:
    """D-050: an OC ratio above the top bucket of its kind's turbo table (the profile's own ``[turbo]`` table, else the one this boot's read returned) is planned as asked
    and **no table is derived or written**; the core runs at most the table's bucket for the active-core count. One ``TURBO_BELOW_OC`` per unit; without a table to compare
    against, one note per kind."""
    if not profile.entries:
        return []
    st = _state(helper)
    with st.lock:
        read, note = st.tables, st.tables_note
    out: list[str] = []
    unread: set[str] = set()
    seen: set[str] = set()
    for t in resolve_targets(profile, topology):
        if t.ratio is None:
            continue
        unit = unit_of_cpu(topology, t.cpu)
        if unit in seen:
            continue
        seen.add(unit)
        key = t.kind.lower()
        table = getattr(profile.turbo, key, None) if profile.turbo is not None else None
        if table is None and read is not None:
            table = read.get(key)
        msr = "0x650" if t.kind == "E" else "0x1AD"
        if table is None:
            if t.kind not in unread:
                unread.add(t.kind)
                out.append(f"{t.kind} turbo table (MSR {msr}) was not read this boot ({note or 'no tune.read yet'}): cannot tell whether an OC ratio is above it; the turbo tables are not changed by an OC ratio")
            continue
        if t.ratio > max(table):
            out.append(Warn("TURBO_BELOW_OC", f"{unit} OC ratio {t.ratio}x is above the {t.kind} turbo table ({', '.join(f'{b}x' for b in table)}): the core runs at most the table's bucket "
                            f"for the active-core count until you raise it on the Turbo ratios tab (MSR {msr})"))
    return out


# G-125: the GUI plan's own caveats, worded from what the hardware showed (docs/knowledge/tuning-results.md); the planner's constants stay as the CLI prints them.
_RAISE_NOTE = (
    "this plan RAISES a ratio, V target or offset; the CPU's own limits were checked; run a stability check before relying on it"
)
_POINT_NOTE = (
    "per-point offsets change one V/F point (0x11 with P2 = the point); the hardware keeps V(n) >= V(n-1): linux-xtu models it (CLAMPED warnings) but cannot read the "
    "lower fused voltages"
)


def _words_assumed(last: Mapping[int, Sequence[int]] | None, topology: Topology, targets: Sequence[Any], points: Sequence[Any]) -> bool:
    """G-125: the plan assumed words only when a unit it writes has no CPU in ``last`` (an E cluster is read on one CPU, the others share its words)."""
    cpus_by_unit: dict[str, list[int]] = {}
    for item in (*targets, *points):
        cpus_by_unit.setdefault(unit_of_cpu(topology, item.cpu), []).append(item.cpu)
    return any(not any(c in (last or {}) for c in unit_cpus(topology, unit)) for unit in cpus_by_unit)


def _residual_found(helper: Helper, profile: Profile, topology: Topology, policy: Policy) -> residual.Neutralisation | None:
    """G-147: the residual OC points that this boot's last read shows against ``profile`` (the accepted profile, D-044), or ``None`` without a read / fused words. The apply
    re-reads every word: this is a preview and the size of the budget it reserves, not the decision."""
    last = _last_words(helper)
    fused = helper.fused_words or {}
    vf = {c: w[0] for c, w in (last or {}).items() if w}
    if not vf or not fused:
        return None
    return residual.neutralise(profile, topology, policy, vf, fused)


def _residual_ops(found: residual.Neutralisation | None) -> int:
    """Worst-case extra operations of the rows ``found`` adds (as ``count_operations`` counts a target that sets a ratio and a voltage)."""
    per_cpu = READS_PER_CPU + VMAX_EXTRA_READS + 2 * (WRITES_PER_CPU + SPLIT_EXTRA_WRITES)  # the planner's own worst case for a row with a ratio and a voltage (preflight counts 0x1D / 0x27 too)
    return 0 if found is None else per_cpu * sum(len(u.cpus) for u in found.units)


def _residual_writes_max(found: residual.Neutralisation | None) -> int:
    """G-248: the most writes the rows ``found`` adds: a row that sets an OC ratio and a voltage sends ``WRITES_PER_CPU`` words, plus the split 0x11, on each CPU of its unit.
    The apply re-reads every word and sends fewer or none; it never sends more than this."""
    return 0 if found is None else (WRITES_PER_CPU + SPLIT_EXTRA_WRITES) * sum(len(u.cpus) for u in found.units)


def _residual_preview(found: residual.Neutralisation | None) -> list[str]:
    notes = [
        "restore also looks for a residual OC point (an OC ratio the accepted state does not have; it cannot be cleared at runtime): the apply reads two words per unit "
        "that has no accepted OC ratio and rewrites such a unit with a V target below its top fused point, so it runs the accepted voltages"
    ]
    if found is None:
        notes.append("no read of this boot to look at: a residual OC point is rewritten only if the session budget has room for it, so read ratios & voltages first (Tune > Read)")
    return [*notes, *(f"{n} (from the last read)" for n in (found.notes if found is not None else ()))]


# --------------------------------------------------------------------------------------------------------------
# R-B1 (WP-2): plan-time rules -- what the guard would refuse midway is refused before a plan exists; every refusal names its field (detail.key)
# --------------------------------------------------------------------------------------------------------------
POSITIVE_CHECK = "POSITIVE_OFFSET_UNPROVEN"
_POSITIVE_TAIL = "Use 0 or a negative offset (D-053 item 5). Nothing was sent."
_WHY_POINT = (
    "the apply cannot read this unit's fused 0x09 voltage (the base of every point; it is read only for a unit the plan also gives a whole-curve, ratio or voltage row) "
    "and its whole V/F point table, so the result cannot be bounded by the CPU's voltage limit and the guard would refuse the write (CPU_LIMIT_UNREAD)"
)
_WHY_CURVE = (
    "the whole-curve offset (P2 = 0) adds to every fused point's own offset, and the apply cannot read the unit's whole V/F point table (the planner's walk), so the sum "
    "cannot be bounded by the CPU's voltage limit and the guard would refuse the write (CPU_LIMIT_UNREAD)"
)
_WHY_RING = "the ring has no readable fused voltage, so a positive ring offset has no base to bound it and the guard refuses it"


def _raises_oc(steps: Sequence[Mapping[str, Any]], before: Mapping[str, Any], targets: Sequence[Any], topology: Topology) -> bool:
    """G-242 (QA-30): True when a PLANNED write of an OC word raises the ratio or the V target the profile sets for that unit (a word never read, or one with the field unset, counts
    as raised: nothing says it is not). The note is about the writes the apply sends, so a plan whose rows equal what the CPU holds (no write listed) never carries it."""
    written = {st_.get("unit") for st_ in steps if st_.get("kind") == StepKind.WRITE_VF.value}
    for t in targets:
        unit = unit_of_cpu(topology, t.cpu)
        if unit not in written:
            continue
        was = (before.get(unit) or {}).get("0")
        if t.ratio is not None and (was is None or was.get("ratio") is None or was["ratio"] < t.ratio):
            return True
        if t.oc_voltage_mv is not None and (was is None or was.get("v_target_v") is None or was["v_target_v"] * 1000 < t.oc_voltage_mv - 0.5):
            return True
    return False


def _apply_reads(profile: Profile, topology: Topology, policy: Policy) -> set[tuple[int, int, int]]:
    """The mailbox reads the apply of ``profile`` makes before its first write, as ``(cpu, P1, P2)`` of every ``0x10`` read (the per-core and point reads and, B-01, the planner's
    point-table walk ``READ_VF_WALK`` of a unit given a positive offset) plus ``(cpu, -1, 0)`` for a ``0x09`` (fused point) read; from the planner's own read phase
    (``read_steps``). Empty when it cannot be built."""
    targets = resolve_targets(profile, topology) if profile.entries else ()
    try:
        steps = read_steps(tuple(targets), policy, profile, topology)
    except (PlanError, ProfileError, ValueError, KeyError):
        return set()
    out: set[tuple[int, int, int]] = set()
    for s in steps:
        if s.kind.is_write or s.msr is not None:
            continue
        if s.cmd == int(Cmd.VOLTAGE_FREQ_READ):
            out.add((s.cpu, s.p1, s.p2))
        elif s.cmd == _FUSED_CMD and s.p1 == _FUSED_P1:
            out.add((s.cpu, -1, 0))
    return out


def _base_provable(reads: set[tuple[int, int, int]], cpu: int, n_points: int) -> bool:
    """B-01 / D-053 item 5: the apply can bound a raise on ``cpu``'s V/F curve only when it reads, in its own session, the fused ``0x09`` voltage, the ``P2 = 0`` word and the whole
    point table up to the first ``P2`` past it (``P2 = n + 1``, rc ``0x11``) -- what the guard's sum needs (``point_table_walked``). The planner walks the table of every unit the
    profile gives a positive offset (``controls.planner.walk_cpus``) and reads ``0x09`` for a unit with a core row, so this is false only when the planner cannot produce them: a
    positive point offset on a unit without a core row (no ``0x09``), a positive offset already in force that the plan does not set (no walk), a policy without the reads."""
    return (cpu, -1, 0) in reads and all((cpu, 0, p2) in reads for p2 in range(0, n_points + 2))


def _positive_raise_check(helper: Helper, profile: Profile, topology: Topology, policy: Policy) -> None:
    """R-13 / D-053 item 5: a positive offset raised above the one in force -- a fused point's, the whole curve's (P2 = 0) or a ring point's -- is ``REFUSED POSITIVE_OFFSET_UNPROVEN`` at
    plan time unless the apply can prove the base voltage it adds to (:func:`_base_provable`: the planner's walk and ``0x09`` read; never for the ring). Then the guard's own B-01
    rule (``guard.policy.summed_voltage_raw``, one formula): a write that lifts a unit's summed voltage above its no-offset base needs that proof too, and with it the sum must stay
    at or under the CPU's voltage limit (``POLICY_RANGE``, the ``0x28`` limit bound from this boot's read). A positive offset the CPU already holds is not a raise."""
    last = _last_words(helper) or {}
    fused = getattr(helper, "fused_words", None) or {}
    reads: set[tuple[int, int, int]] | None = None

    def provable(cpu: int, n_points: int) -> bool:
        nonlocal reads
        if reads is None:
            reads = _apply_reads(profile, topology, policy)
        return _base_provable(reads, cpu, n_points)

    def refuse(text: str, key: str) -> OpError:
        return OpError(REFUSED, f"{text}. {_POSITIVE_TAIL}", {"check": POSITIVE_CHECK, "key": key})

    for p in profile.expand_points(topology):
        unit = unit_of_cpu(topology, p.cpu)
        ref = _unit_reference(last, (p.cpu, *p.cpus))
        now = VfWord.from_u32(ref[1][p.point]).offset_raw if ref is not None and len(ref[1]) > p.point else 0
        new = VfWord.mv_to_offset_raw(p.offset_mv)
        if new > 0 and new > now and not provable(p.cpu, 0 if ref is None else len(ref[1]) - 1):
            where = f"the {p.expect_ratio}x point" if p.expect_ratio else f"point {p.point}"
            raise refuse(f"{unit}: offset {p.offset_mv:+d} mV on {where} raises a voltage the helper cannot bound yet: {_WHY_POINT}", f"{unit}.points.{p.expect_ratio or p.point}")
    for s in profile.expand(topology):
        if s.offset_mv is None:
            continue
        unit = unit_of_cpu(topology, s.cpu)
        ref = _unit_reference(last, (s.cpu, *s.cpus))
        now = VfWord.from_u32(ref[1][0]).offset_raw if ref is not None else 0
        new = VfWord.mv_to_offset_raw(s.offset_mv)
        if new > 0 and new > now and not provable(s.cpu, 0 if ref is None else len(ref[1]) - 1):
            raise refuse(f"{unit}: offset {s.offset_mv:+d} mV (whole curve) raises every point's voltage and the helper cannot bound the sum yet: {_WHY_CURVE}", f"{unit}.curve")
    if profile.ring is not None:
        ring = _last_ring(helper) or []
        for rp in profile.ring.points:
            now = VfWord.from_u32(ring[rp.point]).offset_raw if len(ring) > rp.point else 0
            new = VfWord.mv_to_offset_raw(rp.offset_mv)
            if new > 0 and new > now:
                raise refuse(f"ring point {rp.point}: offset {rp.offset_mv:+d} mV raises a ring voltage the helper cannot bound: {_WHY_RING}", f"ring.points.{rp.point}")
    # B-01 (guard.policy.summed_voltage_raw, the guard's own formula): the layers of a unit ADD; a write that lifts the sum above the no-offset base needs the walked table
    st = _state(helper)
    with st.lock:
        favored = dict(st.favored_words or {})
    points_of = {}
    for p in profile.expand_points(topology):
        points_of.setdefault(unit_of_cpu(topology, p.cpu), {})[p.point] = p
    settings = {unit_of_cpu(topology, s.cpu): s for s in profile.expand(topology)}
    for unit in dict.fromkeys([*settings, *points_of]):
        cpus = unit_cpus(topology, unit)
        ref = _unit_reference(last, cpus)
        fused_word = None if ref is None else fused.get(ref[0])
        if ref is None or fused_word is None:
            continue
        words_now = [int(w) for w in ref[1]]
        words_new = list(words_now)
        s = settings.get(unit)
        goal = None if s is None else _planner_goal(s, ref, fused, favored, profile.complete)
        if goal is not None:
            words_new[0] = goal.to_u32()
        for n, p in points_of.get(unit, {}).items():
            if n < len(words_new):
                words_new[n] = VfWord.from_u32(words_new[n]).with_(offset_raw=VfWord.mv_to_offset_raw(p.offset_mv)).to_u32()
        fused_v = (int(fused_word) >> 8) & 0xFFF
        total, base, how = summed_voltage_raw(fused_v, words_new[0], [w for w in words_new[1:] if w & 0xFF])
        total_now, _, _ = summed_voltage_raw(fused_v, words_now[0], [w for w in words_now[1:] if w & 0xFF])
        was, now_w = VfWord.from_u32(words_now[0]), VfWord.from_u32(words_new[0])
        own = (now_w.offset_raw > 0 and now_w.offset_raw > was.offset_raw) or now_w.v_target_raw > was.v_target_raw
        if not (total > base and (total > total_now or own)):
            continue
        # the field that lifts the sum: the whole curve's own raise, else a raised point of the plan, else the OC target
        raised = [f"{unit}.points.{p.expect_ratio or n}" for n, p in points_of.get(unit, {}).items()
                  if n < len(words_now) and 0 < VfWord.mv_to_offset_raw(p.offset_mv) and VfWord.mv_to_offset_raw(p.offset_mv) > VfWord.from_u32(words_now[n]).offset_raw]
        key = f"{unit}.curve" if now_w.offset_raw > 0 and now_w.offset_raw > was.offset_raw else (raised[0] if raised else (
            f"{unit}.v_target_v" if now_w.v_target_raw > was.v_target_raw else f"{unit}.curve"))
        if not provable(ref[0], len(words_now) - 1):
            raise refuse(
                f"{unit}: the plan lifts the unit's summed voltage ({total / 1024:.4f} V: the whole-curve offset, the largest point offset and the OC target add) above its no-offset "
                f"base ({base / 1024:.4f} V), and the helper cannot bound it: {_WHY_CURVE}", key,
            )
        limit, limit_text = v_target_limit(policy, _kind_of(unit), None)
        if limit is not None and total > limit:  # the guard's sum check, before a plan exists (the limit of this boot's read)
            raise OpError(REFUSED, f"{unit}: offset raises the unit's summed voltage to {total / 1024:.4f} V ({how}), above {limit_text}: the offsets of a unit add (B-01). "
                          "Nothing was sent.", {"check": "POLICY_RANGE", "key": key})


def _target_rules(intent: Mapping[str, Any], profile: Profile, topology: Topology, before: Mapping[str, Any], after: Mapping[str, Any], fused: Mapping[int, int] | None,
                  warnings: list[str]) -> None:
    """R-10 / R-02: an OC-point voltage on a unit whose word ends with no OC point (its ratio is not above the top fused ratio) would not be kept by the CPU (G-124): an editor
    intent (rows) is refused (``TARGET_NEEDS_OC_POINT``, the field named), a profile warns (``TARGET_DROPPED``). An OC ratio set below the ratio in force warns
    (``OC_RATIO_LOWERED``): an OC point cannot be cleared at runtime, and the ``0x1D`` lowers the core's maximum ratio."""
    rows = "rows" in intent
    for s in profile.expand(topology):
        unit = unit_of_cpu(topology, s.cpu)
        now = (after.get(unit) or {}).get("0")
        was = (before.get(unit) or {}).get("0")
        top = fused_top_ratio((fused or {}).get(s.cpu))
        if s.oc_voltage_mv is not None and now is not None and now.get("v_target_v") is None:
            ratio = now.get("ratio")
            at = f"at ratio {ratio}x" if ratio else "with no OC ratio"
            limit = f" (not above the top fused ratio {top}x)" if top is not None else ""
            if rows:
                raise OpError(REFUSED, f"{unit}: OC-point voltage {s.oc_voltage_mv} mV needs an OC point: {at}{limit} the unit has none and the CPU keeps no V target there (G-124), "
                              f"so it would not be written. Set an OC ratio above {top if top is not None else 'the top fused ratio'}x with it, or leave the voltage empty. Nothing was sent.",
                              {"check": "TARGET_NEEDS_OC_POINT", "key": f"{unit}.v_target_v"})
            warnings.append(Warn("TARGET_DROPPED", f"{unit}: the OC-point voltage {s.oc_voltage_mv} mV is not written: {at}{limit} the unit has no OC point and the CPU keeps no V target (G-124)"))
        if s.ratio is not None and was is not None and was.get("ratio") and s.ratio < was["ratio"]:
            oc_now = top is not None and was["ratio"] > top
            warnings.append(Warn(
                "OC_RATIO_LOWERED",
                f"{unit}: the OC ratio is lowered {was['ratio']}x -> {s.ratio}x. "
                + ("An OC point cannot be cleared at runtime (only a cold boot clears it); " if oc_now else "")
                + "the 0x1D of this plan lowers the core's maximum ratio (cpuinfo_max_freq) as well; a reboot restores the BIOS values",
            ))


def op_tune_plan(helper: Helper, ctx: OpContext, args: dict[str, Any]) -> dict[str, Any]:
    intent = args["intent"]
    topology = _topology(helper)
    policy = _load_policy(helper)
    resolved = resolve_intent(helper, intent, policy, topology)
    profile = resolved.profile
    used, budget = helper.budget.snapshot()
    if used is None:  # G-141: an unreadable audit log is not "0 operations used": the apply could not count them either, so the plan is refused here like the apply would be
        raise OpError(REFUSED, "the audit log cannot be read, so the per-boot operation count is unknown and no plan can be checked against it. Nothing was sent.", {"check": "AUDIT_UNAVAILABLE"})
    ops_left = None if budget is None else max(budget - used, 0)
    restore = "restore" in intent or profile.complete  # G-148: a complete profile is applied like the accepted state (residual rule, only what differs)
    scan_ops = len(residual.scan_plan(profile, topology, policy)) if restore else 0  # G-147: the residual-OC-point scan reads of a restore
    try:
        targets = preflight(profile, topology, policy, boot_ops_used=used, extra_ops=scan_ops)
    except PreflightError as exc:
        raise _preflight_error(exc) from None
    except (PlanError, ProfileError) as exc:
        raise OpError(BAD_REQUEST, str(exc)) from None
    uvp_notes: list[str] = []
    _uvp_plan_check(helper, profile, topology, uvp_notes)  # G-240: refused before any write when Undervolt Protection is on
    _positive_raise_check(helper, profile, topology, policy)  # R-B1 / D-053 item 5: a raise the guard would refuse midway is refused here, by field
    points = resolve_point_targets(profile, topology)
    rings = resolve_ring_targets(profile, topology)
    tables = sum(1 for key in ("e", "p") if profile.turbo is not None and getattr(profile.turbo, key) is not None)
    ops_needed = count_operations(targets, None, tables, len(points), oc_cap_reads_of(policy, targets, profile), ring_points=len(rings), walk_reads=walk_reads_of(profile, topology, policy)) if (targets or points or tables or rings) else 0  # G-117: a table-only plan is plain-MSR writes only; B-01: + the point-table walk
    found_residual = _residual_found(helper, profile, topology, policy) if restore else None
    ops_needed = scan_ops + ops_needed + _residual_ops(found_residual)  # one round (D-049: no step limits) plus the residual scan and the rows it may add
    last = _last_words(helper)
    st = _state(helper)
    with st.lock:
        favored_words = dict(st.favored_words or {})
    before, after = _before_after(profile, topology, last, helper.fused_words, st.turbo, _last_ring(helper), favored_words)
    rule_notes: list[str] = []
    _target_rules(intent, profile, topology, before, after, helper.fused_words, rule_notes)  # R-10 / R-02: a dropped target is refused (rows) or warned (profile); a lowered OC ratio warns
    known = _last_baseline(helper, profile, topology)
    st = _state(helper)
    with st.lock:  # G-231: the tables this boot's read returned, for the step list's own comparison (the executor's is made from its reads)
        held_tables = None if st.tables is None else {k: tuple(v) for k, v in st.tables.items()}
    order, ring_refused = _apply_order(profile, topology, policy, known, held_tables)  # G-153: the Review dialog lists the order the apply sends (G-151)
    steps, writes, reads = _predicted_steps(profile, topology, known if profile.complete else None, order, bool(ring_refused), held_tables)
    conditional = sum(1 for st_ in steps if st_.get("conditional"))  # G-242 (QA-05): the per-core enable (0x15) is sent only when the CPU has it off; the count is what is certain
    writes -= conditional
    if ring_refused and rings and writes == 0:  # R-13: a plan whose only writes were the ring, and the ring is refused, writes nothing: say so instead of an empty plan that "applies"
        raise OpError(REFUSED, "the ring (cache) cannot be written, and nothing else in this plan differs from what the CPU holds: " + "; ".join(ring_refused) + ". Nothing was sent.",
                      {"check": "RING_REFUSED", "key": "ring"})
    warnings = [_POINT_NOTE if w == POINT_CAVEAT else w for w in plan_warnings(targets, policy, points)]
    warnings.extend(resolved.warnings)
    warnings.extend(uvp_notes)
    warnings.extend(rule_notes)
    warnings.extend(Warn("RING_NOT_RESTORED", f"the ring (cache) will NOT be written by this plan: {why}") for why in ring_refused)  # G-154 (D-045): the ring unit alone is refused, the rest stands
    if order is None and (targets or points or rings):
        warnings.append(_ORDER_NOTE)
    if restore:
        warnings.extend(_residual_preview(found_residual))
    if _raises_oc(steps, before, targets, topology):  # G-242 (QA-30): only when a planned write raises a ratio or a V target
        warnings.append(_RAISE_NOTE)
    for unit, items in after.items():
        for point, now in items.items():
            was = (before.get(unit) or {}).get(point)
            if now["offset_mv"] is not None and now["offset_mv"] > 0 and (was is None or was["offset_mv"] <= 0):
                warnings.append(Warn("POSITIVE_OFFSET", f"positive offset {now['offset_mv']:+.1f} mV on {unit} {'OC word' if point == '0' else 'point ' + point}"))
            # D-049: a large single change / a deep whole-curve offset are warnings of the Review, never refusals; a unit with no earlier read is judged from the requested offset alone
            where = f"{unit} {'OC word' if point == '0' else 'point ' + point}"
            was = was or {}
            for code, text in change_notes(where, ratio=(was.get("ratio"), now.get("ratio")), offset_mv=(was.get("offset_mv"), now.get("offset_mv")), whole_curve=point == "0"):
                if code != POSITIVE_OFFSET:
                    warnings.append(Warn(code, text))
    warnings.extend(_turbo_shape_warnings(helper, profile, topology))
    warnings.extend(_oc_below_table_warnings(helper, profile, topology))
    prediction = _predict(helper, profile, topology, last, before, after, warnings)
    warnings.append(REVERT_NOTE)
    refs, ring_refs, table_refs = _stale_refs(helper, intent, profile, topology, resolved, held_tables, restore)
    nonce = "".join(secrets.choice(_NONCE_ALPHABET) for _ in range(6))
    canon = json.dumps(
        {"profile": _profile_canon(profile), "refs": sorted(f"{c}:{p}:{w}" for (c, p), w in refs.items()), "nonce": nonce},
        sort_keys=True,
    )
    plan_id = hashlib.sha256(canon.encode()).hexdigest()
    intent_hash = canonical_hash(intent)
    state_hash = canonical_hash({"refs": sorted(f"{c}:{p}:{w}" for (c, p), w in refs.items()), "ring": sorted(ring_refs.items()), "tables": sorted(table_refs.items())})
    # G-242 (QA-29): nothing to send = no listed write and nothing the apply could add from its own reads (a restore's residual OC point, or a restore with no read to look at)
    residual_max = _residual_writes_max(found_residual)  # G-248: the restore's residual-OC-point rewrites are sent at apply time, in neither ``writes`` nor ``steps``
    nothing_to_do = writes == 0 and conditional == 0 and residual_max == 0 and not ring_refused and not (restore and (found_residual is None or bool(found_residual.units)))
    based_on = _state_known_at(helper)
    if nothing_to_do and based_on is None:  # G-248: "nothing to do" rests on the stored read; without one the plan says so instead of claiming the CPU already holds the target
        raise OpError(REFUSED, "Read first: this plan changes nothing only if the CPU holds the target already, and there is no read of this boot to say so. "
                      "Read ratios & voltages (Tune > Read), then plan again. Nothing was sent.", {"check": "READ_FIRST"})
    _state(helper).plans.add(PlannedPlan(plan_id, nonce, helper.cfg.monotonic(), profile, refs, ops_needed, restore=restore, ring_refs=ring_refs,
                                         table_refs=table_refs, intent=dict(intent), intent_hash=intent_hash, state_hash=state_hash,
                                         planned_writes=writes, nothing_to_do=nothing_to_do, based_on_read_at=based_on, residual_writes_max=residual_max, op="restore-accepted" if intent.get("restore") == "accepted" else "tune.apply"))
    result = {
        "plan_id": plan_id,
        "nonce": nonce,
        "name": profile.name,
        "steps": steps,
        "writes": writes,  # G-242 (QA-05, additive meaning): the writes the plan certainly sends; ``conditional_writes`` come on top only when needed
        "conditional_writes": conditional,  # G-242: 1 = the per-core voltage enable (0x15) is listed in steps (``conditional: true``) and is sent only when the CPU has per-core control off
        "residual_writes_max": residual_max,  # G-248: 0 = none; the most extra writes a restore's apply may send when it finds a leftover OC point (not in ``writes`` or ``steps``)
        "based_on_read_at": based_on,  # G-248: ISO UTC time of the stored read (or verified read-back) this plan rests on; None = none
        "nothing_to_do": nothing_to_do,  # G-242 (QA-29): no write and nothing the apply could add: tune.apply sends no mailbox transaction at all
        "reads": reads,
        "ops_needed": ops_needed,
        "ops_left": ops_left,
        "expires_s": int(PLAN_EXPIRES_S),
        "units": resolved.units,
        "before": before,
        "after": after,  # per written point also effective_v / clamped_by (contract 9 addendum, SPEC-v3 F4)
        "predicted": prediction["predicted"],  # G-114 (additive): {unit: {point: {ratio, base_v, offset_mv, effective_v, clamped_by}}} for every point of the touched units
        "vccia": prediction["vccia"],  # contract 9 addendum (F6): {predicted_v, set_by: {unit, ratio}} + label / contributors / before_v / light_load, null without a baseline
        "predicted_oc": prediction["predicted_oc"],  # R-B1 (additive): {unit: {ratio, target_v, effective_v, clamped_by, measured, not_measured, note, bins}} of each touched unit's OC point
        "warnings": warning_objects(warnings),  # [{code, text}]: CLAMPED E40_OFFSET E_TARGET_WHEA POSITIVE_OFFSET NO_BASELINE TURBO_RAISE TURBO_BELOW_OC, everything else NOTE
        "words_assumed": _words_assumed(last, topology, targets, points),  # G-125: true only when a written unit has no word from this boot's read (tune.last)
        "complete": profile.complete,  # G-148 (additive): a complete profile: only the words that differ are written
        "rounds": 1,  # G-148 (additive): guarded rounds of the apply; always 1 since D-049 removed the step limits
        "uvp": _uvp(helper),  # G-240 (additive)
        "intent_hash": intent_hash,  # R-B1 (additive): sha256[:16] of the canonical intent; tune.apply {intent} is compared with it (PLAN_STALE INTENT_CHANGED)
        "state_hash": state_hash,  # R-B1 (additive): sha256[:16] of the words / ring words / turbo tables the plan was built from (the apply compares them one by one)
        "requests": _profile_requests(helper, intent, profile),  # R-B1 (additive): power / runtime sections of a profile, to plan with power.plan / runtime.plan ([] = none)
    }
    while len(json.dumps(result, separators=(",", ":"))) > MAX_LINE - _RESPONSE_SLACK and result["steps"]:
        del result["steps"][len(result["steps"]) // 2 :]
        result["steps_truncated"] = True
    return result


def _profile_requests(helper: Helper, intent: Mapping[str, Any], profile: Profile) -> list[dict[str, Any]]:
    """R-B1 (D-053 item 7): the runtime sections of a profile / restore plan that differ from the values in force, as the requests a client plans next to this one with the
    existing guarded ops (``{kind: "power" | "runtime", intent, label}``, the apply drawer's shape; ``intent`` is the ``power.plan`` / ``runtime.plan`` request). ``[]`` for an
    editor intent and for a profile that holds none (version 1 profiles: not captured, left as they are)."""
    if not profile.runtime_sections or not ({"profile", "restore"} & set(intent)):
        return []
    ref = {"restore": "accepted"} if "restore" in intent else {"profile": intent["profile"]}
    from linux_xtu.profiles.runtime import runtime_differences

    power, caps, uncore, _ = capture_runtime(helper, _topology(helper))
    diff = runtime_differences(profile, power, caps, uncore)
    out: list[dict[str, Any]] = []
    if diff["power"]:
        out.append({"kind": "power", "intent": dict(ref), "label": f"Power limits of {profile.name}", "differences": diff["power"]})
    if diff["runtime"]:
        out.append({"kind": "runtime", "intent": dict(ref), "label": f"Ratio caps & uncore of {profile.name}", "differences": diff["runtime"]})
    return out


def _stale_refs(
    helper: Helper, intent: Mapping[str, Any], profile: Profile, topology: Topology, resolved: Resolved, held_tables: Mapping[str, Sequence[int]] | None, restore: bool,
) -> tuple[dict[tuple[int, int], int], dict[int, int], dict[int, int]]:
    """R-B1 (R-27): what the apply compares with its own reads before the first write (``PLAN_STALE``): the words of the rows (``resolved.refs``), and for a profile / restore / reset
    plan every word this boot's read holds of the units it covers (a restore: every unit, its residual rule may rewrite any) and its ring points; plus the turbo tables the plan
    writes, as this boot's read holds them. A word or table that was not read is not compared (the apply decides from its own read)."""
    refs = dict(resolved.refs)
    ring_refs = dict(resolved.ring_refs)
    if not ({"rows", "turbo", "ring"} & set(intent)):  # profile / restore / reset: the plan was built from the whole read
        last = _last_words(helper) or {}
        units = set(topology.unit_ids()) if restore else {u for u in resolved.units if u != ringmod.UNIT}
        for cpu, ws in last.items():
            try:
                unit = unit_of_cpu(topology, cpu)
            except UnknownCore:
                continue
            if unit in units:
                for n, w in enumerate(ws):
                    refs.setdefault((cpu, n), int(w))
        if profile.ring is not None:
            ring = _last_ring(helper) or []
            for rp in profile.ring.points:
                if rp.point < len(ring):
                    ring_refs.setdefault(rp.point, int(ring[rp.point]))
    table_refs: dict[int, int] = {}
    for msr, _ratios in _profile_turbo_tables(profile):
        old = None if held_tables is None else held_tables.get(_TURBO_TABLE_KEY[msr])
        if old is not None:
            table_refs[msr] = pack_turbo(old)
    return refs, ring_refs, table_refs


def _profile_canon(profile: Profile) -> dict[str, Any]:
    return {
        "name": profile.name,
        "core": [dataclasses.asdict(c) for c in profile.entries],
        "point": [dataclasses.asdict(p) for p in profile.points],
        "turbo": None if profile.turbo is None else dataclasses.asdict(profile.turbo),
        "complete": profile.complete,
        **({} if profile.ring is None else {"ring": dataclasses.asdict(profile.ring)}),
        **{k: dataclasses.asdict(getattr(profile, k)) for k in ("power", "caps", "uncore") if getattr(profile, k) is not None},
    }
