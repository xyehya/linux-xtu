"""``tune.apply`` (R-D1, split from ``ops_tune``; G-112, G-126, G-240, R-B1): a stored plan run through ``controls.apply_profile`` in one guarded session.

The plan is claimed with ``CONFIRM <nonce>`` (single use; an ``intent`` given must be the planned one, R-26) and pre-flighted again against the policy as it is now; the
executor re-reads every baseline in its own session, and ``_stale_check`` refuses with ``PLAN_STALE`` before any write when a word, ring word or turbo table differs from what
the plan assumed. No mailbox logic lives here: the guard is the only path to the mailbox and ``controls`` builds every request. Afterwards the verified read-backs become the
words in force (and the stored read), ``scaling_max_freq`` follows a changed OC ratio (``controls.cpufreq``), Undervolt Protection is remembered when the CPU showed it, and
the result lists the write steps and the read-back of every V/F word and turbo table (a partial apply is a result with ``stop``, not an error).
:func:`validate_apply_args` is shared with ``power.apply`` / ``runtime.apply`` and the accept confirmation.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

from linux_xtu.controls import (
    ApplyPlan,
    PlanError,
    PreflightError,
    StepKind,
    StepStatus,
    StopKind,
    apply_profile,
    count_operations,
    preflight,
    resolve_point_targets,
    resolve_ring_targets,
)
from linux_xtu.controls import cpufreq as cpufreq_rules
from linux_xtu.controls import residual
from linux_xtu.controls import ring as ringmod
from linux_xtu.controls.order import FREQUENCY_FIRST  # R-B8: the stage of a 0x1D sent ahead of its 0x11 (the UVP note names it)
from linux_xtu.controls.planner import oc_cap_reads_of, walk_reads_of
from linux_xtu.guard.policy import turbo_bytes
from linux_xtu.mailbox import VfWord
from linux_xtu.profiles import ProfileError
from linux_xtu.topology import Topology

from .cpu_online import refuse_if_cpu_offline
from .ops import OpContext, _only, audit_quiet
from .ops_tune_plan import _TURBO_TABLE_KEY, _no_write, _preflight_error, _residual_found, _residual_ops
from .protocol import BAD_REQUEST, CANCELLED, INTERNAL, PLAN_STALE, REFUSED, OpError
from .session import guarded_session
from .tune_intent import _bad, canonical_intent, intent_changed
from .tune_state import (
    StoredPlan,
    UVP_CHECK,
    UVP_MESSAGE,
    _advance_mark,
    _last_ring,
    _last_words,
    _load_policy,
    _persist_applied_words,
    _set_last_ring,
    _set_last_words,
    _set_uvp,
    _state,
    _topology,
    _uvp,
    unit_of_cpu,
)

if TYPE_CHECKING:
    from .core import Helper

__all__ = ["CPUINFO_POLL", "op_tune_apply", "validate_apply_args"]


_RING_STEP_KINDS = (StepKind.READ_RING_OC, StepKind.READ_RING_POINT, StepKind.WRITE_RING_POINT)
_UVP_RC = 0x13  # Rc.UndervoltProtection: registers.md "Undervolt Protection (UVP) refuses negative offsets with rc 0x13" [MEASURED lnx 2026-10-19 13:12Z]
_VF_WRITE_KINDS = (StepKind.WRITE_VF, StepKind.WRITE_VF_POINT, StepKind.WRITE_RING_POINT)


def _uvp_refusal(report: Any) -> bool:
    """True when the apply stopped on a 0x11 write (core word, point or ring point) that the CPU answered with rc 0x13."""
    if report.stop_kind is not StopKind.RC or not report.steps:
        return False
    last = report.steps[-1]
    # G-240 review f4: only a word with a negative offset is Undervolt Protection's business (the measured case); any other 0x13 stays a plain mailbox refusal
    return last.step.kind in _VF_WRITE_KINDS and last.rc == _UVP_RC and last.step.data is not None and VfWord.from_u32(last.step.data).offset_raw < 0


def _uvp_frequency_first_note(report: Any) -> str:
    """R-B8 (review of R-B2, P2): a lowering sends its ``0x1D`` FIRST (B-04, ``controls/order.py``), so when Undervolt Protection refuses the ``0x11`` after it, that ``0x1D``
    has landed: the unit's maximum ratio is already the new, lower one (on its old voltage: safe, but not the state the message's "OC ratios are not affected" implies).
    The note names it and its undo (the revert plan sends ``0x1D`` = the ``0x1C[7:0]`` read before; a reboot restores it too). ``""`` when no such ``0x1D`` landed."""
    landed = [r.step for r in report.steps if r.step.kind is StepKind.WRITE_FAVORED and r.step.stage == FREQUENCY_FIRST and r.status is StepStatus.OK]
    if not landed:
        return ""
    what = ", ".join(f"{st.label} (CPU {st.cpu}) = {st.data}" for st in landed)
    return (
        f" Before the refused word, the frequency-first 0x1D (maximum ratio) of {what} landed: those cores are capped at the new ratio on their old voltage. "
        "The revert (the revert plan, or a reboot) puts the maximum ratio back."
    )


def _uvp_negative_landed(report: Any) -> bool:
    """True when this apply wrote a word with a negative offset and it read back as written (Undervolt Protection is therefore off)."""
    for r in report.steps:
        if r.step.kind in _VF_WRITE_KINDS and r.status is StepStatus.OK and r.verified is True and r.step.data is not None and VfWord.from_u32(r.step.data).offset_raw < 0:
            return True
    return False


# --------------------------------------------------------------------------------------------------------------
# tune.apply
# --------------------------------------------------------------------------------------------------------------
def validate_apply_args(args: dict[str, Any], intent_validator: Callable[[Any], dict[str, Any]] | None = None) -> dict[str, Any]:
    """``{plan_id, typed[, intent]}`` of ``tune.apply`` / ``power.apply`` / ``runtime.apply``. R-B1 (R-26): the optional ``intent`` is what the client's editor holds NOW, in the shape of
    the matching plan op's request (``intent_validator`` validates and canonicalises it); the apply refuses (``PLAN_STALE`` ``INTENT_CHANGED``) when it is not the planned one."""
    _only(args, {"plan_id", "typed", "intent"} if intent_validator is not None else {"plan_id", "typed"})
    plan_id, typed = args.get("plan_id"), args.get("typed")
    if not isinstance(plan_id, str) or not re.fullmatch(r"[0-9a-f]{64}", plan_id):
        raise _bad("'plan_id' must be the 64-hex plan id")
    if not isinstance(typed, str) or not re.fullmatch(r"CONFIRM [A-Z2-9]{6}", typed):
        raise _bad("'typed' must be \"CONFIRM \" followed by the plan's nonce")
    out: dict[str, Any] = {"plan_id": plan_id, "typed": typed}
    if intent_validator is not None and "intent" in args:
        try:
            out["intent"] = intent_validator(args["intent"])
        except OpError as exc:
            if (exc.detail or {}).get("check") != "NOTHING_TO_DO":
                raise
            out["intent"] = {}  # the editor holds no edit any more: certainly not what was planned
    return out


def _validate_tune_apply(args: dict[str, Any]) -> dict[str, Any]:
    return validate_apply_args(args, canonical_intent)


def _stale_check(plan: StoredPlan, topology: Topology):  # type: ignore[no-untyped-def]
    """The ``plan_check`` hook of the executor: the baselines it just read must be the words the plan assumed, and (R-B1, R-27) the turbo tables it is about to overwrite the ones
    the plan was made from (``PLAN_STALE`` before any write)."""

    def check(applied: ApplyPlan) -> None:
        if not plan.refs and not plan.ring_refs and not plan.table_refs:
            return
        seen: dict[tuple[int, int], int] = {}
        ring_seen: dict[int, int] = {}
        tables: list[str] = []
        for step in applied.steps:
            if step.kind is StepKind.WRITE_VF and step.before is not None:
                seen[(step.cpu, 0)] = step.before.to_u32()
            elif step.kind is StepKind.WRITE_VF_POINT and step.before is not None:
                seen[(step.cpu, step.p2)] = step.before.to_u32()
            elif step.kind is StepKind.WRITE_RING_POINT and step.before is not None:
                ring_seen[step.p2] = step.before.to_u32()
            elif step.kind is StepKind.WRITE_MSR and step.msr in plan.table_refs and step.msr_before is not None and step.msr_before != plan.table_refs[step.msr]:
                key = _TURBO_TABLE_KEY.get(step.msr, "?").upper()
                tables.append(f"the {key} turbo table (MSR {step.msr:#x}): planned from {list(turbo_bytes(plan.table_refs[step.msr]))}, now {list(turbo_bytes(step.msr_before))}")
        diffs = [
            f"{unit_of_cpu(topology, cpu)} cpu {cpu} {'OC word' if point == 0 else 'point ' + str(point)}: planned from {plan.refs[(cpu, point)]:#010x}, now {word:#010x}"
            for (cpu, point), word in sorted(seen.items())
            if (cpu, point) in plan.refs and plan.refs[(cpu, point)] != word
        ]
        diffs += [
            f"ring point {point}: planned from {plan.ring_refs[point]:#010x}, now {word:#010x}"
            for point, word in sorted(ring_seen.items())
            if point in plan.ring_refs and plan.ring_refs[point] != word
        ]
        diffs += tables
        if diffs:
            more = f" (+{len(diffs) - 3} more)" if len(diffs) > 3 else ""
            raise OpError(PLAN_STALE, "a word changed since the plan was made; nothing was written. " + "; ".join(diffs[:3]) + more + ". Read the tuning words again and re-plan.",
                          {"check": "STATE_CHANGED", "writes_sent": 0})

    return check


def _step_unit(topology: Topology, step: Any) -> str:
    if step.kind in _RING_STEP_KINDS:  # G-154: the ring is read and written through CPU 0 but is not P-core 0
        return ringmod.UNIT
    return unit_of_cpu(topology, step.cpu)


def _report_rows(report: Any, topology: Topology) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """``(steps, readback)`` of an ApplyReport: the write steps only (compact), and the read-back comparison of the V/F words and turbo tables."""
    steps: list[dict[str, Any]] = []
    readback: list[dict[str, Any]] = []
    done = {r.step.number: r for r in report.steps}
    plan = report.plan
    planned = [s for s in plan.steps if s.kind.is_write] if plan is not None else [r.step for r in report.steps if r.step.kind.is_write]
    for s in planned:
        r = done.get(s.number)
        status = "not_sent" if r is None else r.status.value
        entry: dict[str, Any] = {"n": s.number, "kind": s.kind.value, "cpu": s.cpu, "status": status}
        if s.kind in (StepKind.WRITE_VF, StepKind.WRITE_VF_POINT, StepKind.WRITE_RING_POINT):
            entry["unit"] = _step_unit(topology, s)
            entry["point"] = s.p2
            expected = s.data
            actual = None if r is None else r.readback_data
            match = r is not None and r.verified is True and actual == expected
            readback.append(
                {
                    "unit": entry["unit"], "point": s.p2, "cpu": s.cpu,
                    "expected": None if expected is None else f"{expected:#010x}", "actual": None if actual is None else f"{actual:#010x}", "match": match,
                }
            )
            if r is not None and r.polls > 0:  # G-237 (additive): the V target landed late; the page notes "settled after N re-reads"
                readback[-1]["polls"] = r.polls
                readback[-1]["settle_ms"] = r.settle_ms
        elif s.kind is StepKind.WRITE_MSR:
            entry["table"] = "e" if s.msr == 0x650 else "p"
            actual = None if r is None else r.readback_data
            readback.append(
                {
                    "unit": entry["table"].upper(), "point": "turbo", "cpu": s.cpu,
                    "expected": f"{s.data:#018x}", "actual": None if actual is None else f"{actual:#018x}",
                    "match": r is not None and r.verified is True and actual == s.data,
                }
            )
        steps.append(entry)
    return steps, readback


_TABLE_OF_MSR = {0x650: "e", 0x1AD: "p"}


def _fold_applied_tables(helper: Helper, report: Any) -> None:
    """G-141: the read-backs of the turbo-table writes (``WRITE_MSR``) become the tables the helper knows (``TuneState.tables`` / ``turbo``), so ``tune.last``, the next plan's
    raise / lower decision and the predictions see the applied table. A table that was never read stays unknown (nothing is invented)."""
    applied: dict[str, tuple[int, ...]] = {}
    for r in report.steps:
        s = r.step
        if s.kind is StepKind.WRITE_MSR and r.readback_data is not None and s.msr in _TABLE_OF_MSR:
            applied[_TABLE_OF_MSR[s.msr]] = turbo_bytes(r.readback_data)
    if not applied:
        return
    st = _state(helper)
    with st.lock:
        if st.tables is not None:
            st.tables = {**st.tables, **applied}
        if st.turbo is not None:
            turbo = dict(st.turbo)
            for key, ratios in applied.items():
                cur = turbo.get(key.upper())
                if isinstance(cur, dict):
                    turbo[key.upper()] = {**cur, "ratios": list(ratios)}
            st.turbo = turbo


def _merge_applied_words(helper: Helper, report: Any) -> None:
    """The words verified (or seen differing) by the read-backs of this apply update ``helper.last_words`` if there was a complete read; the OC word is
    index 0, point n index n. Nothing is invented for a CPU that was not read."""
    _fold_applied_tables(helper, report)
    ring = _last_ring(helper)
    if ring:  # G-154: the ring channel follows its own verified read-backs (never the CPU-keyed words: the ring is read through CPU 0 but is not P-core 0)
        for r in report.steps:
            s = r.step
            if s.kind is StepKind.WRITE_RING_POINT and r.readback_data is not None and s.p2 < len(ring):
                ring[s.p2] = r.readback_data
        _set_last_ring(helper, ring)
    last = _last_words(helper)
    if last is None:
        return
    merged = {cpu: list(ws) for cpu, ws in last.items()}
    for r in report.steps:
        s = r.step
        if s.kind in (StepKind.WRITE_VF, StepKind.WRITE_VF_POINT) and r.readback_data is not None and s.cpu in merged and s.p2 < len(merged[s.cpu]):
            merged[s.cpu][s.p2] = r.readback_data
    _set_last_words(helper, merged)


# --------------------------------------------------------------------------------------------------------------
# G-126: an OC ratio raise must lift the OS frequency ceiling
# --------------------------------------------------------------------------------------------------------------
#: ``cpuinfo_max_freq`` follows HWP highest a moment after the 0x1D: re-read all unmoved CPUs this many rounds, this far apart (hardware only).
#: ``[UNVERIFIED]``: nobody has measured the kernel's lag; check on the next write sitting by reading ``cpuinfo_max_freq`` right after a 0x1D.
CPUINFO_POLL = cpufreq_rules.POLL


def _cpufreq_before(helper: Helper, cpus: Sequence[int]) -> dict[int, tuple[int | None, int | None]]:
    """``{cpu: (cpuinfo_max_freq, scaling_max_freq)}`` in kHz, read before the first write of an apply. Nothing without the measurement wiring."""
    w = getattr(helper, "measure_wiring", None)
    return {} if w is None else cpufreq_rules.snapshot(w.cpufreq, cpus)


_oc_ratio_cpus = cpufreq_rules.oc_ratio_cpus  # G-147: one implementation for the helper and the CLI


def _lift_cpufreq(
    helper: Helper, ctx: OpContext, before: Mapping[int, tuple[int | None, int | None]], favored: Sequence[int], checked: Sequence[int], warnings: list[str],
) -> list[dict[str, Any]]:
    """G-126: after an apply that changed an OC ratio, ``cpuinfo_max_freq`` follows HWP highest but ``scaling_max_freq`` keeps the old value, so the new ratio is never
    used (``[MEASURED lnx 2026-10-12]``). The rule is ``controls.cpufreq`` (shared with the CLI's apply, G-147): a cap that sat AT the old cpuinfo max follows the new
    max; a cap the user set below the old max is never touched; a cap above a lowered max is lowered to it. Writes go through the measurement wiring's cpufreq IO to
    ``scaling_max_freq`` only, never while a measure/stress journal exists (those own the caps). Never raises. Returns ``[{cpu, before_khz, after_khz}]``."""
    w = getattr(helper, "measure_wiring", None)
    if w is None or not sorted({*favored, *checked}):
        return []
    return cpufreq_rules.lift(
        w.cpufreq, before, favored, checked, warnings,
        owned=Path(w.journal_path).exists(), poll=(1, 0.0) if helper.cfg.simulator else CPUINFO_POLL, wait=ctx.cancel.wait,
    )


def _outcome_of(result: Mapping[str, Any]) -> str:
    """The word of a finished apply for its closing audit record."""
    if result.get("nothing_to_do"):
        return "nothing-to-do"
    if result.get("complete") is not True:
        return "partial"
    if any(row.get("match") is not True for row in result.get("readback", ())):
        return "mismatch"
    return "ok" if result.get("writes_sent") else "no-change"


def _steps_summary(steps: Sequence[Mapping[str, Any]]) -> str:
    """G-249 (R2-04): the words of what an apply wrote, for its closing record and the Audit row ("P0 point 8", "turbo P", "P0 points 5, 8 + turbo E"): the write steps that were sent."""
    points: dict[str, list[int]] = {}
    other: list[str] = []
    for e in steps:
        if not isinstance(e, Mapping) or e.get("status") in (None, "not_sent", "refused", "cancelled"):
            continue
        kind = e.get("kind")
        unit = str(e.get("unit") or "")
        if kind in (StepKind.WRITE_VF_POINT.value, StepKind.WRITE_RING_POINT.value) and unit and isinstance(e.get("point"), int):
            points.setdefault(unit, []).append(e["point"])
        elif kind == StepKind.WRITE_VF.value and unit:
            other.append(f"{unit} whole curve")
        elif kind == StepKind.WRITE_MSR.value and e.get("table"):
            other.append(f"turbo {str(e['table']).upper()}")
    parts = [f"{u} point{'s' if len(p) > 1 else ''} {', '.join(str(n) for n in sorted(set(p)))}" for u, p in points.items()]
    parts += [x for x in dict.fromkeys(other)]
    if len(parts) > 3:
        return ", ".join(parts[:3]) + f" and {len(parts) - 3} more"
    return ", ".join(parts)


def _close_record(helper: Helper, plan: StoredPlan, result: Mapping[str, Any] | None, error: OpError | None, writes_known: int | None = None) -> None:
    """G-242 (QA-29): every ``tune.apply`` run that claimed a plan ends with ONE audit record, so the Audit screen can say what the run did instead of reading the last mailbox
    record: ``event result``, ``op`` (``restore-accepted`` for the accepted-state restore, else ``tune.apply``), ``outcome`` (``ok`` | ``no-change`` | ``nothing-to-do`` |
    ``mismatch`` | ``partial`` | ``refused`` | ``cancelled`` | ``error``), ``plan_id``, ``writes_planned``, ``writes_sent`` and, for a run that finished, ``complete``,
    ``readback_total``, ``readback_mismatches``, ``ops_used``; a run that ended in an error has ``code`` and ``detail``. Never raises (a log that cannot be written is noted).
    G-248: ``writes_known`` is the number of write steps the run had reported when it ended; an error that carries no ``writes_sent`` of its own is closed with it (never ``null``)."""
    fields: dict[str, Any] = {"op": getattr(plan, "op", "tune.apply"), "plan_id": plan.plan_id, "name": plan.profile.name, "writes_planned": getattr(plan, "planned_writes", -1)}
    if result is not None:
        fields["summary"] = _steps_summary(result.get("steps", ()))  # G-249 (R2-04): "P0 point 8" / "turbo P": the Audit row's name, not the internal plan name
        rb = [row for row in result.get("readback", ()) if isinstance(row, Mapping)]
        fields.update(
            outcome=_outcome_of(result), complete=result.get("complete") is True, writes_sent=result.get("writes_sent", 0), readback_total=len(rb),
            readback_mismatches=sum(1 for row in rb if row.get("match") is not True), ops_used=result.get("ops_used", 0),
        )
        stop = result.get("stop")
        if isinstance(stop, Mapping):
            fields.update(code=stop.get("kind"), detail=str(stop.get("reason") or "")[:500])
    else:
        assert error is not None
        detail = error.detail or {}
        fields.update(
            outcome="cancelled" if error.code == CANCELLED else "refused" if error.code in (REFUSED, PLAN_STALE) else "error", code=error.code,
            detail=str(error.message)[:500], writes_sent=detail.get("writes_sent") if isinstance(detail.get("writes_sent"), int) else (writes_known or 0), check=detail.get("check"),
        )
    note = audit_quiet(helper, "result", **fields)
    if note is not None:
        helper.cfg.log(note)


def op_tune_apply(helper: Helper, ctx: OpContext, args: dict[str, Any]) -> dict[str, Any]:
    refuse_if_cpu_offline(helper, "tune.apply")
    st = _state(helper)
    plan = st.plans.claim(args["plan_id"], args["typed"])
    if "intent" in args:  # R-B1 (R-26): the client says what its editor holds now; a plan of other edits is not applied
        changed = intent_changed(plan.intent, args["intent"])
        if changed is not None:
            _close_record(helper, plan, None, changed, 0)  # G-248: the plan is claimed (burnt): the run ends with its record like every other refusal; nothing was sent
            raise changed
    known = {"writes": 0}  # write steps reported so far (filled by _apply_plan's progress), for the record of a run that dies midway
    try:
        result = _apply_plan(helper, ctx, plan, known)
    except OpError as exc:
        _close_record(helper, plan, None, exc, known["writes"])
        raise
    except BaseException as exc:
        _close_record(helper, plan, None, OpError(INTERNAL, f"{type(exc).__name__}: {exc}"), known["writes"])
        raise
    _close_record(helper, plan, result, None)
    return result


def _nothing_to_do(helper: Helper, based_on_read_at: str | None = None) -> dict[str, Any]:
    """The result of an apply whose plan holds no write (G-242, QA-29): no guarded session, no mailbox request, no MSR access -- the plan said the CPU already holds the target."""
    return {
        "plan_id": "", "steps": [], "readback": [], "ops_used": 0, "msr_writes": 0, "complete": True, "writes_sent": 0, "warnings": [], "cpufreq": [], "revert_plan": 0,
        "residual": [], "ring_refused": [], "uvp": _uvp(helper), "nothing_to_do": True,
        "based_on_read_at": based_on_read_at,  # G-248: the stored read this rests on; the CPU was NOT read by this apply
    }


def _apply_plan(helper: Helper, ctx: OpContext, plan: StoredPlan, known: dict[str, int] | None = None) -> dict[str, Any]:
    known = {"writes": 0} if known is None else known
    if getattr(plan, "nothing_to_do", False):
        return {**_nothing_to_do(helper, getattr(plan, "based_on_read_at", None)), "plan_id": plan.plan_id}
    topology = _topology(helper)
    policy = _load_policy(helper)
    profile = plan.profile
    scan_ops = len(residual.scan_plan(profile, topology, policy)) if plan.restore else 0  # G-147
    try:
        targets = preflight(profile, topology, policy, extra_ops=scan_ops)  # nothing sent: the numbers against the policy as it is NOW
    except PreflightError as exc:
        raise _no_write(_preflight_error(exc)) from None
    except (PlanError, ProfileError) as exc:
        raise OpError(BAD_REQUEST, str(exc)) from None
    points = resolve_point_targets(profile, topology)
    tables = sum(1 for key in ("e", "p") if profile.turbo is not None and getattr(profile.turbo, key) is not None)
    per_round = count_operations(
        targets, None, tables, len(points), oc_cap_reads_of(policy, targets, profile), ring_points=len(resolve_ring_targets(profile, topology)),
        walk_reads=walk_reads_of(profile, topology, policy),  # B-01: the point-table walk a positive offset needs is part of the guard's session cap
    )
    needed = per_round + scan_ops
    if plan.restore:  # the guard's session cap is exactly `needed`: reserve the rows the last read says the scan will add (an unforeseen one is dropped by the executor, with a warning)
        needed = min(scan_ops + per_round + _residual_ops(_residual_found(helper, profile, topology, policy)), policy.max_operations_per_session)
    progress_steps = 0
    write_started = False  # G-241: set when a "step N: ... apply: write|enable ..." line is reported (every write step's purpose starts so); a PlanError before it sent nothing
    freq_cpus = sorted({t.cpu for t in targets} | ({c.cpu for c in topology.cores} if plan.restore else set()))  # a restore may rewrite a unit the profile has no row for
    freq_before = _cpufreq_before(helper, freq_cpus)  # G-126: the old cpuinfo / cap, before any write

    def progress(line: str) -> None:
        nonlocal progress_steps, write_started
        if line.startswith("step "):
            progress_steps += 1
            is_write = "apply: write" in line or "apply: enable" in line
            write_started = write_started or is_write
            known["writes"] += 1 if is_write else 0
            # QA-13 (G-248): ops_used is the OC-mailbox requests of this boot, like the heartbeat (a plain MSR write of a turbo table is no mailbox transaction); None = unknown boot id
            mbx = None if session.used is None else helper.budget.snapshot3()[1]
            ctx.progress(progress_steps, needed, mbx, session.policy.max_operations_per_boot)

    with guarded_session(helper, ctx, policy, needed, "this apply", favored_words=lambda: _state(helper).favored_words) as session:
        try:
            report = apply_profile(
                profile,
                guard=session.guard,
                topology=topology,
                confirm=session.confirm,
                policy=session.policy,
                sleep=session.sleep,
                clock=session.clock,
                progress=progress,
                plan_check=_stale_check(plan, topology),
                cancelled=ctx.cancel.is_set,
                neutralize_residual=plan.restore,
                boot_ops_used=session.used or 0,
            )
        except PreflightError as exc:  # round 1 only (a later round's refusal becomes a report): nothing was written
            raise _no_write(_preflight_error(exc)) from None
        except PlanError as exc:
            if write_started:
                helper.tuned_this_boot = True  # type: ignore[attr-defined]
                raise
            # G-241: the plan the apply builds from its own reads is refused before any write: say so (the page shows every unit "not written")
            raise OpError(REFUSED, f"{exc}. Nothing was written.", {"check": "PLAN_ERROR", "writes_sent": 0, "ops_done": progress_steps}) from None
        except BaseException:
            helper.tuned_this_boot = True  # type: ignore[attr-defined]  # G-120: an apply that died midway may have written; "stock" is never claimed after it
            raise
    _merge_applied_words(helper, report)
    if report.ok:
        _advance_mark(helper)  # G-141: a complete apply's verified read-backs keep the words in force current; a partial one leaves the older mark (the writes then show as "after the read")
    steps, readback = _report_rows(report, topology)
    cpufreq_warnings: list[str] = []
    favored_cpus, vf_cpus = _oc_ratio_cpus(report)
    cpufreq: list[dict[str, Any]] = []
    if report.ok:
        cpufreq = _lift_cpufreq(helper, ctx, freq_before, favored_cpus, vf_cpus, cpufreq_warnings)
    elif favored_cpus:  # a partial apply: the page says "do not rely on this state"; the OS caps are left exactly as they are
        cpufreq_warnings.append("the apply did not complete, so scaling_max_freq was not adjusted to the OC ratios that did land")
    sent_writes = sum(1 for r in report.steps if r.step.kind.is_write and r.status is not StepStatus.REFUSED and r.status is not StepStatus.CANCELLED)
    if sent_writes:
        helper.tuned_this_boot = True  # type: ignore[attr-defined]  # G-120 fix 4: any tune.apply that wrote ends "stock" for this boot (ops_measure._tuning_state)
        _persist_applied_words(helper)  # G-123: the stored last read follows the verified read-backs
    uvp_refused = _uvp_refusal(report)
    if uvp_refused:
        _set_uvp(helper, "on")  # G-240: rc 0x13 on a 0x11 write; this boot's planner now refuses negative offsets
    elif _uvp_negative_landed(report):
        _set_uvp(helper, "off")  # a negative offset was written and read back
    result: dict[str, Any] = {
        "plan_id": plan.plan_id,
        "steps": steps,
        "readback": readback,
        "ops_used": report.operations + sum(1 for r in report.steps if r.step.kind.is_write and not r.step.kind.is_msr and r.status is StepStatus.OK) + report.msr_writes,
        "msr_writes": report.msr_writes,   # G-119: the plain wrmsr (turbo tables) inside ops_used, so a page can show them apart from the mailbox ones
        "complete": report.ok,
        "writes_sent": sent_writes,
        "warnings": [*report.warnings, *cpufreq_warnings],
        "cpufreq": cpufreq,  # G-126: [{cpu, before_khz, after_khz}] of scaling_max_freq for the CPUs whose OC ratio changed
        "revert_plan": len(report.revert_plan),
        "residual": list(report.residual),  # G-147: the units whose residual OC point this restore rewrote (additive)
        "ring_refused": list(report.ring_refused),  # G-154 (additive): why the ring unit alone was not written (the P/E units were); [] = written or no ring
        "uvp": _uvp(helper),  # G-240 (additive)
        "based_on_read_at": getattr(plan, "based_on_read_at", None),  # G-248: the stored read the plan was made from (the apply itself reads and reads back the words it writes)
    }
    if report.ok and not sent_writes and report.ring_refused and resolve_ring_targets(profile, topology):
        # R-13: the plan's only writes were the ring and the ring was refused from the apply's own reads: that is not "Applied"
        raise OpError(REFUSED, "the ring (cache) was not written: " + "; ".join(report.ring_refused) + ". Nothing was written.",
                      {"check": "RING_REFUSED", "key": "ring", "ops_done": result["ops_used"], "writes_sent": 0})
    if report.ok:
        return result
    stop = {"kind": report.stop_kind.value, "reason": report.stopped_reason, "tripped": report.tripped}
    if uvp_refused:
        stop["reason"], stop["check"] = UVP_MESSAGE + _uvp_frequency_first_note(report), UVP_CHECK  # the CPU's own refusal in words, not the raw completion code
        landed = any(r.step.kind.is_write and r.step.kind is not StepKind.WRITE_PERCORE_ENABLE and r.status is StepStatus.OK for r in report.steps)
        if not landed:  # only the per-core enable (0x15) went out: harmless, and the next apply needs it; no word, no table changed
            raise OpError(REFUSED, UVP_MESSAGE, {"check": UVP_CHECK, "ops_done": result["ops_used"]})
    if sent_writes:
        # the hardware is partly changed: the read-back table must reach the page, so this is a result (complete: false), not an error
        result["stop"] = stop
        return result
    if report.stop_kind is StopKind.CANCELLED:
        raise OpError(CANCELLED, "tune.apply was cancelled before the first write; nothing was changed", {"ops_done": result["ops_used"], "writes_sent": 0})
    last_detail = report.steps[-1].detail if report.steps else ""
    if report.stop_kind is StopKind.REFUSED:
        check = last_detail.split(":", 1)[0] if ":" in last_detail else "REFUSED"
        raise OpError(REFUSED, f"{report.stopped_reason}. Nothing was written.", {"check": check, "ops_done": result["ops_used"], "writes_sent": 0})
    raise OpError(INTERNAL, f"{report.stopped_reason}", {"ops_done": result["ops_used"], "tripped": report.tripped, "writes_sent": 0})
