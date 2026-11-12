"""``vf.dump`` (tracked), ``tune.read`` and ``tune.last`` (R-D1, split from ``ops_tune``; G-112, G-114, G-123, G-154).

``vf.dump`` is ``ops.op_vf_dump`` plus: a complete dump becomes the words in force (``helper.last_words``), with the audit position it began at (G-141). ``tune.read`` is that
dump plus the decoded words (``tune``: per unit, point 0 = the OC word, and the unit's two offset layers), then two more guarded sessions (``session.guarded_session``), one
transaction at a time: the extras (fused ``0x09`` points, ``0x1C`` favored words, the CPU's limits ``0x01`` / ``0x28`` of P, E and the ring, the four turbo-table MSRs by plain
``rdmsr``; each group degrades alone into a note) and the ring (``0x10 P1=2`` until rc ``0x11``; a ring that cannot be read leaves a note, the cores' read stands). A complete
read is stored for ``tune.last``, which returns it with the verified read-backs of later applies overlaid and the accepted comparison redone (:func:`accepted_match`: the
cores as ``ops.accepted_match`` compares them, plus the ring line of the accepted state). Results are kept under the 64 KiB response line (``_fit``).
"""
from __future__ import annotations

import json
import time
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any

from linux_xtu import vfdump
from linux_xtu.guard import GuardRefused, MsrRequest, Policy, Refusal, Request, WriteGuard
from linux_xtu.controls import ring as ringmod
from linux_xtu.guard.policy import ENCODING_OFFSET_CEILING_MV, ENCODING_OFFSET_FLOOR_MV, fused_top_ratio, hw_ratio_max, hw_v_max_mv, hw_v_max_raw, turbo_bytes
from linux_xtu.mailbox import Cmd, VfWord, rc_name
from linux_xtu.profiles.expected import parse_expected
from linux_xtu.profiles.lastread import LastReadError
from linux_xtu.topology import Topology

from .ops import OpContext, accepted_match as _core_accepted_match, helper_topology, op_vf_dump
from .protocol import CANCELLED, MAX_LINE, REFUSED, OpError
from .session import guarded_session
from .tune_intent import INTENT_FEATURES, _read_accepted_text
from .tune_state import (
    _RESPONSE_SLACK,
    _add_cpu_limits,
    _add_limits,
    _boot_record,
    _current_boot,
    _decode,
    _fused_map,
    _last_store,
    _last_words,
    _load_policy,
    _log,
    _record_words,
    _restore_last,
    _set_last_ring,
    _set_last_words,
    _state,
    _topology,
    _uvp,
    audit_mark,
    fused_favored_ratios,
    unit_of_cpu,
)

if TYPE_CHECKING:
    from .core import Helper

__all__ = ["accepted_match", "op_tune_last", "op_tune_read", "vf_dump_tracked"]


def _accepted_ring(helper: Helper) -> list[int] | None:
    """The ``ring`` line of the accepted ``EXPECTED-words.txt`` (G-154), or ``None`` when the accepted state has none (or cannot be read: the compare then has its own note)."""
    try:
        return parse_expected(_read_accepted_text(helper, "EXPECTED-words.txt"))[1]
    except (OpError, ValueError):
        return None


def _hexw(word: int | None) -> str | None:
    return None if word is None else f"{word:#010x}"


def accepted_match(
    helper: Helper, document: dict[str, Any], fused: Mapping[int, int] | None = None
) -> tuple[list[dict[str, Any]] | None, str | None]:
    """``helper.ops.accepted_match`` plus (G-154) the ring: when the accepted state has a ``ring`` line, one more entry ``{cpu: "ring", unit: "ring", match, diffs}`` compares the
    ring of ``document["ring"]`` (a ``tune.read`` result; a ``vf.dump`` has none, so the ring then differs as "not read") word for word -- the OC word as point 0 -- with no
    equivalence rules: a ring that differs is a difference. An accepted state without a ``ring`` line gets no entry (nothing about the ring is compared)."""
    matched, note = _core_accepted_match(helper, document, fused)
    if matched is None:
        return matched, note
    want = _accepted_ring(helper)
    if want is None:
        return matched, note
    got = ringmod.from_json(document.get("ring"))
    diffs = [
        {"point": n, "expected": _hexw(want[n] if n < len(want) else None), "actual": _hexw(got[n] if got is not None and n < len(got) else None)}
        for n in range(max(len(want), len(got or [])))
        if (want[n] if n < len(want) else None) != (got[n] if got is not None and n < len(got) else None)
    ]
    return [*matched, {"cpu": ringmod.UNIT, "unit": ringmod.UNIT, "match": not diffs, "diffs": diffs}], note


def _words_of_document(doc: Mapping[str, Any]) -> dict[int, list[int]]:
    out: dict[int, list[int]] = {}
    for unit in doc.get("units", []):
        for cpu in unit.get("cpus", []):
            oc = cpu.get("oc")
            if oc is None:
                continue
            out[int(cpu["cpu"])] = [int(oc["word"], 16)] + [int(p["word"], 16) for p in cpu.get("points", [])]
    return out


def _decode_document(doc: dict[str, Any], topology: Topology, fused: Mapping[int, int] | None = None) -> dict[str, Any]:
    """Add ``units[*].id`` and ``tune`` (``{unit: {cpus: [{cpu, points: [{point, ratio, offset_mv, v_target_v, mode}]}]}}``; point 0 = the OC word). ``fused``: cpu ->
    its live ``0x09`` word; a point whose ratio is above the core's top fused ratio ``[7:0]`` IS the OC point (the OC ratio is above the top fused ratio)."""
    fused = fused or {}
    tune: dict[str, Any] = {}
    for unit in doc.get("units", []):
        first = unit["cpus"][0]["cpu"] if unit.get("cpus") else None
        if first is None:
            continue
        uid = unit_of_cpu(topology, first)
        unit["id"] = uid
        rows = []
        for cpu in unit["cpus"]:
            top = fused_top_ratio(fused.get(cpu["cpu"]))
            ratios = [VfWord.from_u32(int(p["word"], 16)).ratio for p in cpu.get("points", [])]
            fused_n = sum(1 for r in ratios if top is None or r <= top)  # fused points of this core; with no 0x09 read nothing is called the OC point
            oc_n = fused_n + 1  # community naming: the OC point follows the last fused point
            pts = []
            if cpu.get("oc") is not None:
                pts.append({"point": 0, "point_label": f"OC (point {oc_n})", **_decode(VfWord.from_u32(int(cpu["oc"]["word"], 16)))})
            for p in cpu.get("points", []):
                is_oc = top is not None and ratios[p["point"] - 1] > top  # the OC ratio is above the top fused ratio, so this point IS the OC point
                label = f"OC (point {oc_n})" if is_oc else f"point {p['point']}"
                pts.append({"point": p["point"], "point_label": label, **({"oc_point": True} if is_oc else {}), **_decode(VfWord.from_u32(int(p["word"], 16)))})
            rows.append({"cpu": cpu["cpu"], "points": pts})
        tune[uid] = {"cpus": rows, "layers": _layers_of(rows[0]["points"]) if rows else None}
    return tune


def _layers_of(points: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """R-B1 (B-03 / R-09, additive): a unit's two offset layers as read -- ``curve_mv`` = the whole-curve offset of its ``P2 = 0`` word, ``points_mv`` = ``{ratio: mV}`` of every fused
    point whose own offset is not 0 (the OC point excluded). The CPU adds them; they are reported apart so a re-read after an apply keeps the whole-curve layer its own."""
    curve = next((p.get("offset_mv") for p in points if p.get("point") == 0), None)
    pts = {str(p["ratio"]): p["offset_mv"] for p in points if p.get("point") and p.get("ratio") and not p.get("oc_point") and p.get("offset_mv")}
    return {"curve_mv": curve, "points_mv": pts}


def _fit(result: dict[str, Any]) -> dict[str, Any]:
    """Keep the result under the 64 KiB line (the Writer would otherwise replace it by an INTERNAL error): drop the decoded duplicates of the extra E
    CPUs, then the differences list, then the decoded copy altogether, re-measuring each time."""
    def size() -> int:
        return len(json.dumps(result, separators=(",", ":")))

    limit = MAX_LINE - _RESPONSE_SLACK
    if size() <= limit:
        return result
    tune = result.get("tune")
    if isinstance(tune, dict):
        for unit in tune.values():
            unit["cpus"] = unit["cpus"][:1]
        result["tune_truncated"] = True
    if size() > limit:
        result["differences"] = []
        result["differences_truncated"] = True
    if size() > limit:
        result["tune"] = None
    return result


def _covers_all_units(topology: Topology, words: Mapping[int, Sequence[int]]) -> bool:
    return all(any(c in words for c in topology.unit_cpus(u)) for u in topology.unit_ids())


def vf_dump_tracked(helper: Helper, ctx: OpContext, args: dict[str, Any]) -> dict[str, Any]:
    """``vf.dump`` unchanged, plus: after a *complete* dump the words are kept in ``helper.last_words`` (cpu -> [OC word, point 1, ...]) together with the audit position
    the dump began at (``TuneState.audit_mark``, G-141): a dump of every unit replaces it, a dump of some CPUs keeps the older of the two (the rest of the words are as old)."""
    _last_words(helper)  # restore first: the mark below must not be overwritten by a later lazy restore
    before = audit_mark(helper)
    doc = op_vf_dump(helper, ctx, args)  # raises on a stop: a partial dump never becomes "the words in force"
    words = _words_of_document(doc)
    if words:
        prior = _last_words(helper)
        merged = {cpu: list(ws) for cpu, ws in (prior or {}).items()}
        merged.update(words)
        _set_last_words(helper, merged)
        st = _state(helper)
        with st.lock:
            if prior is None or _covers_all_units(helper_topology(helper), words):
                st.audit_mark = before
            elif st.audit_mark is None or before is None:
                st.audit_mark = None
            else:
                st.audit_mark = min(st.audit_mark, before)
    return doc


_LABEL = {"fused": "fused points", "favored": "favored ratios", "limits": "CPU limits", "turbo": "turbo tables"}
_FUSED_CMD, _FUSED_P1 = 0x09, 0x11  # VoltageFloorRead P1 = 0x11 (domain floors), P2 = 0 (core): the fused V/F point per core, registers.md 0x09 [MEASURED win 2026-10-01]


def _fused_entry(word: int) -> dict[str, Any]:
    """Contract 9 addendum ``{word, ratio, v}``: ratio ``[7:0]``, voltage ``[19:8]`` S2.10 (registers.md 0x09)."""
    return {"word": f"0x{word & 0xFFFFFFFF:08x}", "ratio": word & 0xFF, "v": round(((word >> 8) & 0xFFF) / 1024 + 1e-9, 4)}  # half up: 0x4A0 = 1.15625 V -> 1.1563


def _read_extras(helper: Helper, ctx: OpContext, policy: Policy, topology: Topology) -> dict[str, Any]:
    """G-114: the guarded reads that make ``tune.read`` respect SPEC-v3 section 9, in ONE session of exactly ``units + P-cores + E-clusters + 4 + 6`` guard-counted requests (four
    are plain rdmsr, the rest mailbox reads = WRMSR to 0x150), one at a time:

    * ``fused`` (F7): cmd ``0x09 P1=0x11 P2=0`` on every P-core and on the first CPU of every E-cluster (one per unit),
    * ``favored`` (F5): cmd ``0x1C`` on every P-core (low byte = the favored ratio; E clusters follow ``0x650``) and (G-137) on the first CPU of every E-cluster (word kept for an "auto" ceiling only),
    * ``limits`` (G-137, D-039, D-049): cmd ``0x01 P1=0`` (fused max OC ratio) and ``0x28 P1=0`` (max voltage) on the first P CPU and the first CPU of the first E cluster (4), and the same two
      with ``P1=2`` (the ring, addressed through the first P CPU) for ``cpu_limits.ring`` (2): 6,
    * ``turbo`` (F5): plain ``rdmsr`` ``0x1AD`` / ``0x1AE`` / ``0x650`` / ``0x651`` on the first P CPU (4).

    Each group degrades alone (a refusal leaves that group ``None`` with a note); a guard trip or a cancel ends the session. The mailbox requests are paced like
    ``vf.dump`` / the executor (G-141): the first waits out the dwell since the dump that just ended, every later one the dwell since the previous one (a policy with
    ``min_dwell_s > 0`` would otherwise refuse every group with DWELL). Returns ``{fused, turbo, tables, hw_limits, notes, ops}``; ``ops`` = the operations this session
    executed (the guard's own count: the mailbox requests, not the plain ``rdmsr`` reads)."""
    p_cpus = sorted(c.cpu for c in topology.cores if c.kind == "P")
    e_cpus = [topology.cluster_cpus(k)[0] for k in sorted({c.cluster for c in topology.cores if c.cluster is not None})]
    out: dict[str, Any] = {"fused": None, "turbo": None, "tables": None, "hw_limits": None, "notes": {}, "ops": 0}
    notes: dict[str, str] = out["notes"]
    limit_cpus = {kind: cpus[0] for kind, cpus in (("P", p_cpus), ("E", e_cpus), ("ring", p_cpus)) if cpus}  # one CPU per kind answers for its kind; the ring (P1=2) is package-level, any CPU answers
    guards: list[WriteGuard] = []
    try:
        with guarded_session(
            helper, ctx, policy, len(p_cpus) * 2 + len(e_cpus) * 2 + 4 + 2 * len(limit_cpus), "the fused-point / CPU-limit / turbo-table read",
            favored_words=lambda: _state(helper).favored_words,
        ) as session:
            guards.append(session.guard)
            pacer = vfdump.Pacer(policy.min_dwell_s, session.clock, session.sleep)
            if not helper.cfg.simulator:
                pacer.mark()  # the dump that just ended was a mailbox session too; the simulator's session already waited the dwell out (virtual clock)

            def mailbox(cpu: int, cmd: int, p1: int, what: str) -> int:
                if ctx.cancel.is_set():
                    raise OpError(CANCELLED, "tune.read was cancelled between transactions")
                pacer.wait()
                if ctx.cancel.is_set():  # the dwell wait is woken by the cancel flag
                    raise OpError(CANCELLED, "tune.read was cancelled between transactions")
                try:
                    res = session.guard.execute(Request(cpu, cmd, p1, 0, 0, f"tune.read: {what} of cpu {cpu}"), session.confirm)
                finally:
                    pacer.mark()
                if res.response.rc != 0:
                    raise OpError(REFUSED, f"cpu {cpu}: mailbox completion code {res.response.rc} ({rc_name(res.response.rc)})")
                return res.response.data

            def plain(msr: int) -> int:
                if ctx.cancel.is_set():
                    raise OpError(CANCELLED, "tune.read was cancelled between transactions")
                pacer.wait()  # a plain rdmsr starts no dwell of its own (not a WRMSR) but meets the guard's dwell check since the last mailbox request
                if ctx.cancel.is_set():
                    raise OpError(CANCELLED, "tune.read was cancelled between transactions")
                return session.guard.execute(MsrRequest(p_cpus[0], msr, 0, f"tune.read: read {msr:#x} (plain rdmsr)", "read"), session.confirm).value

            def do_fused() -> None:
                out["fused"] = {cpu: _fused_entry(mailbox(cpu, _FUSED_CMD, _FUSED_P1, "read the fused V/F point (0x09)")) for cpu in p_cpus + e_cpus}

            favored: dict[int, int] = {}
            favored_full: dict[int, int] = {}

            def do_favored() -> None:
                for cpu in p_cpus:
                    word = mailbox(cpu, int(Cmd.FAVORED_CORE_READ), 0, "read the favored ratio (0x1C)")
                    favored[cpu], favored_full[cpu] = word & 0xFF, word
                for cpu in e_cpus:  # G-137: the E fused word ([15:8]) and E ratio ([7:0]) of each cluster: the data of an "auto" E ratio ceiling; not a favored ratio (E clusters follow 0x650)
                    favored_full[cpu] = mailbox(cpu, int(Cmd.FAVORED_CORE_READ), 0, "read the fused/E ratio word (0x1C)")

            def do_limits() -> None:
                limits: dict[str, dict[str, Any]] = {}
                out["hw_limits"] = limits  # filled kind by kind: a read that fails later leaves the earlier ones
                for kind, cpu in limit_cpus.items():
                    entry: dict[str, Any] = {"ratio_max_oc": None, "v_target_max_mv": None, "v_target_max_raw": None, "offset_mv": [ENCODING_OFFSET_FLOOR_MV, ENCODING_OFFSET_CEILING_MV]}
                    limits[kind] = entry
                    for what, cmd, fill in (
                        ("the CPU's ratio limit (0x01)", int(Cmd.OC_CAPABILITY_READ), _fill_oc_cap),
                        ("the CPU's maximum voltage (0x28)", int(Cmd.MAXIMUM_VOLTAGE_LIMIT_READ), _fill_v_max),
                    ):
                        try:
                            fill(entry, mailbox(cpu, cmd, 2 if kind == "ring" else 0, f"read {what}" + (" of the ring (P1=2)" if kind == "ring" else "")))
                        except (OpError, GuardRefused) as exc:  # each read degrades alone: a refused 0x01 leaves the 0x28 limit readable
                            if isinstance(exc, OpError) and exc.code == CANCELLED or isinstance(exc, GuardRefused) and exc.reason is Refusal.TRIPPED:
                                raise
                            why = exc.message if isinstance(exc, OpError) else _refused_text(exc)
                            notes["limits"] = (notes.get("limits", "") + f" {kind}: {what} not read: {why}.").strip()

            def do_turbo() -> None:
                ratios = {msr: plain(msr) for msr in (0x1AD, 0x650)}
                out["tables"] = {"e": turbo_bytes(ratios[0x650]), "p": turbo_bytes(ratios[0x1AD])}
                counts: dict[int, list[int] | None] = {}
                for msr in (0x1AE, 0x651):  # an installed policy older than 2026-10-11 has no allow entry for the bucket counts: the ratios stand alone then
                    try:
                        counts[msr] = list(turbo_bytes(plain(msr)))
                    except GuardRefused as exc:
                        if exc.reason is Refusal.TRIPPED:
                            raise
                        counts[msr] = None
                        notes["counts"] = f"bucket counts not read: {_refused_text(exc, f'the policy has no msr_allow read entry for {msr:#x}')}"
                out["turbo"] = {
                    "P": {"ratios": list(turbo_bytes(ratios[0x1AD])), "counts": counts[0x1AE]},
                    "E": {"ratios": list(turbo_bytes(ratios[0x650])), "counts": counts[0x651]},
                    "favored": {},
                }

            for key, fn in (("fused", do_fused), ("favored", do_favored), ("limits", do_limits), ("turbo", do_turbo)):
                try:
                    fn()
                except OpError as exc:
                    if exc.code == CANCELLED:
                        raise
                    notes[key] = f"{_LABEL[key]} not read: {exc.message}"
                except GuardRefused as exc:
                    if exc.reason is Refusal.TRIPPED:
                        raise
                    notes[key] = f"{_LABEL[key]} not read: {_refused_text(exc)}"
            if out["turbo"] is not None:
                out["turbo"]["favored"] = {cpu: r for cpu, r in favored.items()}
            elif favored:
                out["turbo"] = {"P": None, "E": None, "favored": dict(favored)}
            out["favored_words"] = favored_full
    except OpError as exc:
        if exc.code == CANCELLED:
            raise
        for key in _LABEL:
            notes.setdefault(key, f"{_LABEL[key]} not read: {exc.message}")
    except GuardRefused as exc:
        for key in _LABEL:
            notes.setdefault(key, f"{_LABEL[key]} not read: {_refused_text(exc)}")
    except Exception as exc:  # best effort: these reads must never fail the tuning-word read that already succeeded
        for key in _LABEL:
            notes.setdefault(key, f"{_LABEL[key]} not read: {type(exc).__name__}: {exc}")
    finally:
        if guards:
            out["ops"] = guards[0].operations  # whatever ended the session, the operations it executed were counted by the guard
    return out


def _read_ring(helper: Helper, ctx: OpContext, policy: Policy, topology: Topology) -> tuple[dict[str, Any] | None, str | None, int]:
    """G-154 (D-045): the ring unit of ``tune.read``, in ITS OWN guarded session of at most ``RING_WALK_CAP + 1`` mailbox reads (``cmd 0x10 P1=2``, ``P2 = 0`` then the points until the first
    rc ``0x11``; one at a time, paced like the other reads). ``(ring document, note, operations executed)``: a ring the policy cannot read, a refusal or a stop leaves ``None`` and a note --
    the cores' read stands. A cancel raises ``CANCELLED``. The ring is package-level: it is read through the first CPU."""
    cap = ringmod.walk_cap(policy)
    if cap is None:
        return None, "ring not read: the policy has no read entry for cmd 0x10 P1=2 (the ring is left out; the cores' read stands)", 0
    cpu = ringmod.ring_cpu(topology)
    needed = ringmod.requests_worst(cap)
    ops = 0
    try:
        with guarded_session(helper, ctx, policy, needed, "the ring read", favored_words=lambda: _state(helper).favored_words) as session:
            pacer = vfdump.Pacer(policy.min_dwell_s, session.clock, session.sleep)
            if not helper.cfg.simulator:
                pacer.mark()  # the reads that just ended were mailbox traffic too; the simulator's session already waited the dwell out (virtual clock)

            def execute(req: Any) -> Any:
                if ctx.cancel.is_set():
                    raise KeyboardInterrupt  # ringmod.walk turns it into a Stop; the cancel is raised below
                return session.guard.execute(req, session.confirm)

            curve, stop = ringmod.walk(cpu, execute, pacer, lambda exc: _refused_text(exc), cap)
            ops = session.guard.operations
    except OpError as exc:
        if exc.code == CANCELLED:
            raise
        return None, f"ring not read: {exc.message}", ops
    if ctx.cancel.is_set():
        raise OpError(CANCELLED, "tune.read was cancelled between transactions")
    if stop is not None:
        return None, f"ring not read: {stop.text}", ops
    if curve.oc is None:
        return None, "ring not read: the OC word was not read", ops
    return ringmod.to_json(curve), None, ops


def _refused_text(exc: GuardRefused, no_entry: str = "the policy has no allow entry for it") -> str:
    """What a guard refusal of a ``tune.read`` extra says, by its reason (G-141): only ``NOT_ALLOWLISTED`` is "no allow entry"; a ``DWELL``, a ``CHECK_FAILED`` ... says itself."""
    head = f"the guard refused ({exc.reason.value})"
    return f"{head}; {no_entry}" if exc.reason is Refusal.NOT_ALLOWLISTED else f"{head}: {exc.detail}"


def _fill_oc_cap(entry: dict[str, Any], word: int) -> None:
    """``0x01 P1=0`` word -> ``ratio_max_oc`` (``[7:0]`` fused max OC ratio); ratio overclocking not ok (``[8]`` clear) or 0 is no limit (``None`` = no raise)."""
    entry["ratio_max_oc"] = hw_ratio_max([word])


def _fill_v_max(entry: dict[str, Any], word: int) -> None:
    """``0x28`` word -> ``v_target_max_raw`` (``[11:0] - 1 LSB``, raw S2.10, XTU's rule: the exact limit the checks use) and ``v_target_max_mv`` (the same in whole mV, for display)."""
    entry["v_target_max_raw"] = hw_v_max_raw(word)
    entry["v_target_max_mv"] = hw_v_max_mv(word)


def _merge_hw_limits(old: Mapping[str, Mapping[str, Any]] | None, new: Mapping[str, Mapping[str, Any]] | None) -> dict[str, dict[str, Any]] | None:
    """A new read replaces the fields it read; a field it could not read keeps the value of the earlier read of this boot (the fused limits do not change at runtime)."""
    if not new:
        return None if old is None else {k: dict(v) for k, v in old.items()}
    out = {k: dict(v) for k, v in (old or {}).items()}
    for kind, entry in new.items():
        merged = out.setdefault(kind, {})
        for key, value in entry.items():
            if value is not None or key not in merged:
                merged[key] = value
    return out


def _read_at(epoch: float) -> str:
    """ISO-8601 UTC, second resolution (``2026-10-12T09:49:05Z``): the time a read was taken, as the page shows it."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _favored_crosscheck(topology: Topology, fused_ratios: Mapping[int, int] | None) -> str | None:
    """After a read: the P-cores whose fused ``0x1C[15:8]`` ratio is the highest (none when all are equal; B-10: ``[7:0]`` follows a ``0x1D`` write, ``[15:8]`` does not) against
    the favored set sysfs reported (``topology`` as sysfs derived it). A note when they differ; nothing when ``0x1C`` was not read."""
    if not fused_ratios:
        return None
    ratios = {int(c): int(r) for c, r in fused_ratios.items()}
    by_1c = {c for c, r in ratios.items() if r == max(ratios.values())} if len(set(ratios.values())) > 1 else set()
    by_sysfs = {c.cpu for c in topology.cores if c.favored}
    if by_1c == by_sysfs:
        return None

    def names(cpus: set[int]) -> str:
        return ", ".join(sorted((topology.unit_of_cpu(c) for c in cpus), key=lambda u: int(u[1:]))) or "none"

    return (
        f"favored cores differ: sysfs ({topology.favored_source or 'no source'}) says {names(by_sysfs)}; the fused 0x1C[15:8] ratios say {names(by_1c)}. "
        "Both are shown as read; nothing was changed."
    )


def op_tune_read(helper: Helper, ctx: OpContext, args: dict[str, Any]) -> dict[str, Any]:
    doc = vf_dump_tracked(helper, ctx, args)
    topology = _topology(helper)
    result = dict(doc)
    result["units"] = [dict(u) for u in doc.get("units", [])]
    st = _state(helper)
    policy: Policy | None = None
    try:
        policy = _load_policy(helper)
        extras = _read_extras(helper, ctx, policy, topology)
    except OpError as exc:
        if exc.code == CANCELLED:
            raise
        extras = {"fused": None, "turbo": None, "tables": None, "hw_limits": None, "ops": 0, "notes": {k: f"{_LABEL[k]} not read: {exc.message}" for k in _LABEL}}
    notes = extras["notes"]
    partial = args.get("cpus") is not None  # a read of some CPUs only is not a read of the tuning state: it leaves the ring (and its kept words) alone
    if partial:
        ring_doc, ring_note, ring_ops = None, "ring not read: this read named CPUs", 0
    elif policy is not None:  # G-154: the ring, in its own session after the cores' extras
        ring_doc, ring_note, ring_ops = _read_ring(helper, ctx, policy, topology)
    else:
        ring_doc, ring_note, ring_ops = None, "ring not read: the policy could not be loaded", 0
    if ring_note:
        notes["ring"] = ring_note
    if not partial:
        _set_last_ring(helper, ringmod.from_json(ring_doc))
    tables = extras["tables"]
    note = notes.get("turbo")
    with st.lock:
        st.tables, st.tables_note = tables, note
        st.fused, st.turbo = extras["fused"], extras["turbo"]
        st.favored_words = extras.get("favored_words") or None
        st.hw_limits = _merge_hw_limits(st.hw_limits, extras.get("hw_limits"))
        hw_limits = None if st.hw_limits is None else {k: dict(v) for k, v in st.hw_limits.items() if k != "ring"}  # P and E; the ring's limits are in cpu_limits
    fused_words = _fused_map(topology, extras["fused"])
    if fused_words:
        helper.fused_words = fused_words
    result["tune"] = _decode_document(result, topology, helper.fused_words)
    result["intent_features"] = list(INTENT_FEATURES)  # G-212 (additive): the optional intent keys tune.plan understands ("ring" = ring points by P2 number); a front-end gates its editor on it
    result["ring"] = ring_doc  # G-154: {unit, cpu, oc, points, end} in the shape of a cpus[] entry; None = not read (see extras_notes.ring); before the compare, which judges it
    matched, accepted_note = accepted_match(helper, result, helper.fused_words)  # redone with the fused words just read (the dump's own compare ran before them)
    result["accepted_match"], result["accepted_note"] = matched, accepted_note
    result["tables"] = None if tables is None else {k: list(v) for k, v in tables.items()}
    result["tables_note"] = None if tables is not None else (note or "turbo tables not read")
    fused, turbo = extras["fused"], extras["turbo"]
    result["fused"] = None if fused is None else {str(c): v for c, v in fused.items()}  # contract 9 addendum: {first cpu of the unit (string): {word, ratio, v}}
    result["turbo"] = None if turbo is None else {**turbo, "favored": {str(c): r for c, r in turbo["favored"].items()}}  # {P: {ratios, counts}, E: {...}, favored: {cpu (string): ratio}}
    result["hw_limits"] = hw_limits  # G-137 (D-039): {P|E: {ratio_max_oc, v_target_max_mv, offset_mv: [-1000, 999]}}, the CPU's own limits; None = not read
    result["extras_notes"] = notes
    # G-141: ops_done = every mailbox operation of this read (the page shows "N mailbox operations used"): the vf.dump words plus the guarded extras (0x09 / 0x1C / 0x01 / 0x28).
    result["ops_words"], result["ops_extras"], result["ops_ring"] = int(doc.get("ops_done", 0)), int(extras.get("ops", 0)), int(ring_ops)
    result["ops_done"] = result["ops_words"] + result["ops_extras"] + result["ops_ring"]
    sysfs_topology = helper_topology(helper)  # favored as sysfs says it, against the fused 0x1C[15:8] ratios just read (B-10)
    cross = _favored_crosscheck(sysfs_topology, fused_favored_ratios(helper, sysfs_topology))
    if cross:
        result["problems"] = [*result.get("problems", []), cross]
    result["read_at"] = _read_at(helper.cfg.wall_clock())
    _add_limits(helper, result, topology, extras.get("favored_words"))
    _add_cpu_limits(helper, result)  # D-049
    result["uvp"] = _uvp(helper)  # G-240 (additive): "on" | "off" | "unknown", Undervolt Protection as this boot has shown it
    result = _fit(result)
    _save_last_read(helper, result, topology)
    return result


# --------------------------------------------------------------------------------------------------------------
# G-123: tune.last, the last complete read of this boot
# --------------------------------------------------------------------------------------------------------------
def _word_json(w: int) -> dict[str, Any]:
    """The ``vfdump.to_json`` shape of one word (the stored result is patched with it after an apply)."""
    vf = VfWord.from_u32(w)
    return {"word": f"{w:#010x}", "ratio": vf.ratio, "v_target_raw": vf.v_target_raw, "v_target_v": vf.v_target_v, "static": vf.static,
            "offset_raw": vf.offset_raw, "offset_mv": round(vf.offset_mv, 3)}


def _save_last_read(helper: Helper, result: dict[str, Any], topology: Topology) -> None:
    """Store a *complete* read (every unit of the topology) with the boot id. Best effort: a store problem is logged, never an error of the read that succeeded."""
    try:
        boot = _current_boot(helper)
        ids = {u.get("id") for u in result.get("units", []) if isinstance(u, dict)}
        if boot is None or result.get("complete") is False or not set(topology.unit_ids()) <= ids:
            return
        words = _words_of_document(result)
        if not words:
            return
        record = {
            "version": 1, "boot_id": boot, "at": helper.cfg.wall_clock(), "applied_at": None,
            "words": {str(cpu): [f"{w:#010x}" for w in ws] for cpu, ws in words.items()}, "result": result,
        }
        ring_words = ringmod.from_json(result.get("ring"))
        if ring_words:
            record["ring_words"] = [f"{w:#010x}" for w in ring_words]  # G-154: authoritative like "words"; an apply updates it
        st = _state(helper)
        with st.lock:
            favored = dict(st.favored_words or {})
        if favored:
            record["favored_words"] = {str(cpu): f"{w:#010x}" for cpu, w in favored.items()}  # G-133: the "auto" ratio ceiling after a helper restart
        with st.lock:
            record["audit_mark"] = st.audit_mark  # G-141: where in the audit log these words are valid from (profiles.accept refuses a stale read)
        state = _uvp(helper)
        if state != "unknown":
            record["uvp"] = state  # G-240: this boot's Undervolt Protection state survives a new read and a helper restart
        _last_store(helper).save(record)
    except (LastReadError, OSError, ValueError, TypeError) as exc:
        _log(helper, f"last-read not stored: {exc}")


def op_tune_last(helper: Helper, ctx: OpContext, args: dict[str, Any]) -> dict[str, Any]:
    """``{available: false}``, or ``{available: true, boot_id, at, applied_at, result}`` with ``result`` shaped like ``tune.read``'s. After an apply the
    stored words (the verified read-backs) are overlaid and the decoded copy rebuilt; the accepted comparison is always redone against the accepted state as it is now."""
    _restore_last(helper)
    record = _boot_record(helper)
    if record is None:
        return {"available": False}
    topology = _topology(helper)
    result = record["result"]
    applied_at = record.get("applied_at")
    if applied_at is not None:
        words = _record_words(record)
        for unit in result.get("units", []):
            for cpu in unit.get("cpus", []):
                ws = words.get(cpu.get("cpu"))
                if not ws:
                    continue
                if cpu.get("oc") is not None:
                    cpu["oc"] = _word_json(ws[0])
                for p in cpu.get("points", []):
                    if isinstance(p.get("point"), int) and 0 < p["point"] < len(ws):
                        p.update(_word_json(ws[p["point"]]))
        result["differences"] = []
        result["differences_stale"] = True
        stored = record.get("ring_words")  # G-154: the ring follows the verified read-backs too
        if isinstance(result.get("ring"), dict) and isinstance(stored, list) and stored:
            try:
                ring_words = [int(w, 16) for w in stored]
                result["ring"] = {**result["ring"], "oc": ringmod.word_json(ring_words[0]), "points": [{"point": n, **ringmod.word_json(w)} for n, w in enumerate(ring_words[1:], start=1)]}
            except (TypeError, ValueError):
                pass
    result["intent_features"] = list(INTENT_FEATURES)  # G-212: set at response time, so a record stored by an older helper still advertises it
    matched, note = accepted_match(helper, result, helper.fused_words)  # G-129: always redone (a file read, no hardware): the accepted state can change after the read (profiles.accept)
    result["accepted_match"], result["accepted_note"] = matched, note
    result["tune"] = _decode_document(result, topology, helper.fused_words)
    st = _state(helper)
    with st.lock:
        favored = dict(st.favored_words or {})
    if not favored:  # a helper restarted since the read: the 0x1C words stored with it
        try:
            favored = {int(c): int(w, 16) for c, w in (record.get("favored_words") or {}).items()}
        except (AttributeError, TypeError, ValueError):
            favored = {}
    _add_limits(helper, result, topology, favored)  # G-133: the policy as it is now, not as it was at the read
    if not isinstance(result.get("read_at"), str) and isinstance(record.get("at"), (int, float)):
        result["read_at"] = _read_at(float(record["at"]))  # a record stored before read_at existed: the time it was stored
    _add_cpu_limits(helper, result)  # D-049: from this boot's kept limits (they survive a helper restart with the stored read)
    result["uvp"] = _uvp(helper)  # G-240: as it is now (an apply since the read may have shown it)
    return {"available": True, "boot_id": record["boot_id"], "at": record.get("at"), "applied_at": applied_at, "result": _fit(result)}
