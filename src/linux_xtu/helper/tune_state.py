"""The state the tune ops share (R-D1, split from ``ops_tune``): what this helper process knows about the CPU and its plans, and where it comes from.

* ``TuneState`` on the helper (``helper._tune_state``, built once under ``_STATE_LOCK``): the turbo tables, fused / favored words, the CPU's own limits (``hw_limits``,
  D-039 / D-049) and the turbo facts of the last ``tune.read``; the audit-log position the words held are valid from (``audit_mark``, G-141); Undervolt Protection as this
  boot has shown it (G-240); the stored plans (``PlanStore``: in memory, single-use, 600 s, at most 16).
* The words in force: ``helper.last_words`` (cpu -> [OC word, point 1, ...]) and ``helper.last_ring`` (G-154). The first tune op of a helper process restores them, and the
  facts above, from this boot's stored read (G-123: ``LastReadStore`` next to the audit log); an apply that wrote updates the stored record.
* :func:`stale_since_read`: why the words held may no longer be what the CPU holds (a write in the audit log after the read, or an unknown position), else ``None``.
* The policy bound to this boot's CPU limits (``_load_policy``), the live topology with *favored* decided by the fused ``0x1C[15:8]`` ratios (``_topology``, B-10), and the
  ``limits`` / ``cpu_limits`` documents of ``tune.read`` / ``tune.last`` (:func:`cpu_limits_doc` also for ``power.read`` / ``runtime.read``).
"""
from __future__ import annotations

import dataclasses
import json
import os
import secrets
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from linux_xtu.guard import Policy, PolicyError, default_m1_policy, load_policy
from linux_xtu.controls import ring as ringmod
from linux_xtu.guard.policy import ENCODING_OFFSET_CEILING_MV, ENCODING_OFFSET_FLOOR_MV
from linux_xtu.mailbox import WRITE_COMMANDS, VfWord
from linux_xtu.profiles import Profile
from linux_xtu.profiles.lastread import LastReadError, LastReadStore
from linux_xtu.topology import Topology, UnknownCore

from .ops import _refuse, _trust, helper_topology
from .protocol import CONFIRM_MISMATCH, PLAN_STALE, OpError
from .trust import TrustError, open_checked

if TYPE_CHECKING:
    from .core import Helper

__all__ = [
    "PLAN_EXPIRES_S", "PlanStore", "StoredPlan", "TuneState", "UVP_CHECK", "UVP_MESSAGE", "UVP_UNKNOWN_NOTE", "audit_mark", "cpu_limits_doc", "fused_favored_ratios",
    "stale_since_read", "unit_cpus", "unit_of_cpu", "with_fused_favored",
]


PLAN_EXPIRES_S = 600.0  # contract 8: a plan older than this is stale
_MAX_PLANS = 16
_MAX_CONFIRM_MISMATCHES = 3
_RESPONSE_SLACK = 4096  # envelope of the response line around the result (the 64 KiB cap includes it)
_NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789"  # contract 8: [A-Z2-9]


# --------------------------------------------------------------------------------------------------------------
# Units (contract 9): P<n> = the n-th P CPU, EC<n> = the CPUs of the n-th E-cluster (live topology)
# --------------------------------------------------------------------------------------------------------------
def unit_cpus(topology: Topology, unit: str) -> tuple[int, ...]:
    return topology.unit_cpus(unit)


def unit_of_cpu(topology: Topology, cpu: int) -> str:
    return topology.unit_of_cpu(cpu)


def _kind_of(unit: str) -> str:
    return "P" if unit.startswith("P") else "E"


# --------------------------------------------------------------------------------------------------------------
# State kept on the helper: the words in force, the turbo tables, the stored plans
# --------------------------------------------------------------------------------------------------------------
@dataclass
class StoredPlan:
    plan_id: str
    nonce: str
    created: float
    profile: Profile
    refs: dict[tuple[int, int], int]  # (cpu, point) -> the word the plan assumed (point 0 = the OC word); empty = nothing to compare
    expected_ops: int
    used: bool = False
    mismatches: int = 0
    restore: bool = False  # G-147: the restore of the accepted state (G-148: or any complete profile): the apply scans for a residual OC point and neutralises it
    ring_refs: dict[int, int] = field(default_factory=dict)  # G-212: ring point (P2) -> the word the plan assumed; kept apart from ``refs`` (the ring is read through CPU 0 but is not P-core 0)
    table_refs: dict[int, int] = field(default_factory=dict)  # R-B1 (R-27): turbo MSR (0x1AD / 0x650) -> the packed table the plan assumed; a table changed since is PLAN_STALE
    intent: dict[str, Any] | None = None  # R-B1 (R-26): the canonical intent the plan was made from; tune.apply {intent} must equal it
    intent_hash: str = ""
    state_hash: str = ""


class PlanStore:
    """Plans waiting for ``tune.apply``: in memory only (a helper restart forgets them: ``PLAN_STALE``). Single-use, 600 s, bounded."""

    def __init__(self, clock: Any = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._plans: dict[str, StoredPlan] = {}

    def add(self, plan: StoredPlan) -> None:
        with self._lock:
            self._prune()
            while len(self._plans) >= _MAX_PLANS:
                self._plans.pop(next(iter(self._plans)))
            self._plans[plan.plan_id] = plan

    def claim(self, plan_id: str, typed: str) -> StoredPlan:
        """The plan if ``typed`` is ``CONFIRM <nonce>``; marks it used (a replay is ``CONFIRM_MISMATCH``). ``PLAN_STALE`` if unknown or older than 600 s."""
        with self._lock:
            plan = self._plans.get(plan_id)
            if plan is None:
                raise OpError(PLAN_STALE, "no such plan: it was never made, it expired, or the helper restarted; plan again")
            if self._clock() - plan.created > PLAN_EXPIRES_S:
                del self._plans[plan_id]
                raise OpError(PLAN_STALE, f"the plan is older than {int(PLAN_EXPIRES_S)} s; plan again")
            if plan.used:
                raise OpError(CONFIRM_MISMATCH, "this plan was already applied; a nonce is single-use")
            expected = "CONFIRM " + plan.nonce
            if not secrets.compare_digest(typed.encode("utf-8"), expected.encode("utf-8")):
                plan.mismatches += 1
                if plan.mismatches >= _MAX_CONFIRM_MISMATCHES:
                    del self._plans[plan_id]
                raise OpError(CONFIRM_MISMATCH, "the confirmation does not match this plan's nonce")
            plan.used = True
            return plan

    def _prune(self) -> None:
        now = self._clock()
        for key in [k for k, p in self._plans.items() if now - p.created > PLAN_EXPIRES_S]:
            del self._plans[key]


@dataclass
class TuneState:
    plans: PlanStore
    tables: dict[str, tuple[int, ...]] | None = None  # {"e": 8 buckets, "p": 8 buckets} from the last tune.read (plain rdmsr), or None
    tables_note: str | None = None
    favored_words: dict[int, int] | None = None  # cpu -> the whole 0x1C word of the last tune.read (P-cores): the data an "auto" ratio ceiling is derived from
    fused: dict[int, dict[str, Any]] | None = None  # G-114 F7: cpu -> {word, ratio, v} of the last tune.read (cmd 0x09 P1=0x11 P2=0)
    turbo: dict[str, Any] | None = None  # G-114 F5: {"P": {ratios, counts}, "E": {...}, "favored": {cpu: ratio}} of the last tune.read
    hw_limits: dict[str, dict[str, Any]] | None = None  # G-137 (D-039): the CPU's own limits per kind from the last tune.read (0x01 ratio, 0x28 V target); see _hw_limits_doc
    audit_mark: int | None = None  # G-141: byte size of the audit log when the words held were read (or last verified by an apply); a write after it makes them stale; None = unknown
    uvp: str = "unknown"  # G-240: Undervolt Protection this boot: "on" (a 0x11 write answered rc 0x13), "off" (a negative offset was written and verified), else "unknown"
    uvp_loaded: bool = False  # the stored value of this boot's record has been looked at (lazily, by _uvp)
    lock: threading.Lock = field(default_factory=threading.Lock)


_STATE_LOCK = threading.RLock()  # re-entrant: the lazy restore of the last read (G-123) builds the state while holding it


def _state(helper: Helper) -> TuneState:
    with _STATE_LOCK:  # tune.plan runs on up to four slow threads: two first callers must not each build a state (one's plan would be lost)
        st = getattr(helper, "_tune_state", None)
        if st is None:
            st = TuneState(PlanStore(helper.cfg.monotonic))
            helper._tune_state = st  # type: ignore[attr-defined]
        return st


def _last_words(helper: Helper) -> dict[int, list[int]] | None:
    if not getattr(helper, "_last_restored", False):
        _restore_last(helper)  # G-123: the first tune.* call of a helper process picks up this boot's stored read
    words = getattr(helper, "last_words", None)
    return words if isinstance(words, dict) and words else None


def _set_last_words(helper: Helper, words: Mapping[int, Sequence[int]]) -> None:
    helper.last_words = {int(cpu): [int(w) for w in ws] for cpu, ws in words.items()}  # a new dict each time: readers never see a half-built one


def _last_ring(helper: Helper) -> list[int] | None:
    """G-154: ``[OC word, point 1, ...]`` of the ring as this boot's last read (and the verified read-backs of the applies since) found it, or ``None`` (not read)."""
    if not getattr(helper, "_last_restored", False):
        _restore_last(helper)
    words = getattr(helper, "last_ring", None)
    return list(words) if isinstance(words, list) and len(words) >= 2 else None


def _set_last_ring(helper: Helper, words: Sequence[int] | None) -> None:
    helper.last_ring = None if not words else [int(w) for w in words]  # type: ignore[attr-defined]


def _ring_word_map(ring: Sequence[int] | None) -> dict[int, int] | None:
    """The ring channel of the planner: ``{0: OC word, k: point k}``; ``None`` without a read."""
    return None if not ring else {n: int(w) for n, w in enumerate(ring)}


def _unit_reference(last: Mapping[int, Sequence[int]] | None, cpus: Sequence[int]) -> tuple[int, Sequence[int]] | None:
    """``(cpu, its words)`` of the first CPU of ``cpus`` the last read holds words for (an E cluster is read on one CPU), else ``None``."""
    if last:
        for cpu in cpus:
            if cpu in last and last[cpu]:
                return cpu, last[cpu]
    return None


# --------------------------------------------------------------------------------------------------------------
# G-240: Undervolt Protection as this boot has shown it
# --------------------------------------------------------------------------------------------------------------
UVP_MESSAGE = (
    "The CPU refused a negative voltage offset: Undervolt Protection is enabled in the BIOS (Intel's default). "
    "Disable 'Undervolt Protection' in the BIOS and reboot to undervolt. Only negative offsets are refused; OC ratios and turbo ratios are not affected."
)
UVP_UNKNOWN_NOTE = "Undervolt Protection state unknown this boot; if the BIOS default is on, negative offsets will be refused at the first write"
UVP_CHECK = "UNDERVOLT_PROTECTION"


def _uvp(helper: Helper) -> str:
    """G-240: ``"on"`` / ``"off"`` / ``"unknown"`` for this boot. The first call of a process picks up the value stored with this boot's last-read record (a helper restart keeps it)."""
    st = _state(helper)
    with st.lock:
        if st.uvp_loaded:
            return st.uvp
    record = _boot_record(helper)
    stored = record.get("uvp") if record is not None else None
    with st.lock:
        if not st.uvp_loaded:
            st.uvp_loaded = True
            if st.uvp == "unknown" and stored in ("on", "off"):
                st.uvp = stored
        return st.uvp


def _set_uvp(helper: Helper, value: str) -> None:
    """Remember what this boot showed (in memory, and in this boot's stored record when there is one: best effort like the record itself)."""
    _uvp(helper)  # the stored value is read first, so a later load cannot override this one
    st = _state(helper)
    with st.lock:
        if st.uvp == value:
            return
        st.uvp = value
    try:
        record = _boot_record(helper)
        if record is not None:
            record["uvp"] = value
            _last_store(helper).save(record)
    except (LastReadError, OSError, ValueError, TypeError) as exc:
        _log(helper, f"undervolt-protection state not stored: {exc}")


# --------------------------------------------------------------------------------------------------------------
# Policy and topology (trusted inputs only, SPEC 4.4)
# --------------------------------------------------------------------------------------------------------------
def _load_policy(helper: Helper) -> Policy:
    """The root policy, bound to the live topology (``cpus`` / ``e_cpus`` / ``"auto"`` ceilings are derived from it, D-036)."""
    cfg = helper.cfg
    topology = helper_topology(helper)
    if cfg.policy_path is not None:
        _trust(helper, cfg.policy_path, want="file", must_exist=True)
    try:
        policy = default_m1_policy(topology) if cfg.policy_path is None else load_policy(cfg.policy_path, topology)
    except (PolicyError, OSError) as exc:
        raise _refuse(f"policy error: {exc}.", "POLICY_INVALID") from None
    return _bind_hw_limits(helper, policy)


def _bind_hw_limits(helper: Helper, policy: Policy) -> Policy:
    """G-137 (D-039, D-049): the policy bound to the CPU's own limits of this boot's ``tune.read`` (ratio ``0x01``, V target ``0x28``; P and E -- the ring's are for ``cpu_limits`` only).
    They are the only value limits (planner, guard and plan-time checks alike); none read = a raise is refused (``CPU_LIMIT_UNREAD``)."""
    _last_words(helper)  # the lazy restore of this boot's stored read brings the limits back after a helper restart
    st = _state(helper)
    with st.lock:
        limits = {kind: dict(v) for kind, v in (st.hw_limits or {}).items()}
    return policy.with_hw_limits(
        {kind: v.get("ratio_max_oc") for kind, v in limits.items()},
        {kind: v.get("v_target_max_mv") for kind, v in limits.items()},
        {kind: v.get("v_target_max_raw") for kind, v in limits.items()},
    )


def _topology(helper: Helper) -> Topology:
    """The live topology with *favored* decided by this boot's fused ``0x1C[15:8]`` ratios when a ``tune.read`` has them (B-10, :func:`with_fused_favored`), else as sysfs says."""
    topo = helper_topology(helper)
    return with_fused_favored(topo, fused_favored_ratios(helper, topo))


def _limits(policy: Policy, topology: Topology, favored_words: Mapping[int, int] | None) -> dict[str, Any]:
    """The ``limits`` of ``tune.read`` / ``tune.last`` (G-133, kept for the page): D-049 removed every operator value limit, so the *policy* part is empty -- ``ratio_max`` and
    ``v_target_max_v`` are ``null`` with source ``"none"`` (the CPU's own limits are in ``hw_limits`` / ``cpu_limits``) and ``offset_mv`` is the 11-bit field's window (the only offset bound)."""
    out: dict[str, Any] = {"offset_mv": {}, "v_target_max_v": {}, "ratio_max": {}, "source": {"ratio_max": {}, "v_target_max": {}}}
    for kind in ("P", "E"):
        out["offset_mv"][kind] = {"min": ENCODING_OFFSET_FLOOR_MV, "max": ENCODING_OFFSET_CEILING_MV}
        out["v_target_max_v"][kind] = None
        out["ratio_max"][kind] = None
        out["source"]["ratio_max"][kind] = "none"
        out["source"]["v_target_max"][kind] = "none"
    return out


def _add_limits(helper: Helper, result: dict[str, Any], topology: Topology, favored_words: Mapping[int, int] | None) -> None:
    """``result["limits"]`` (see :func:`_limits`); ``None`` plus ``limits_note`` when the policy cannot be loaded (never an error of a read)."""
    try:
        result["limits"] = _limits(_load_policy(helper), topology, favored_words)
        result.pop("limits_note", None)
    except OpError as exc:
        result["limits"], result["limits_note"] = None, f"policy limits not available: {exc.message}"


def _cpu_limit_entry(entry: Mapping[str, Any] | None, read_at: str | None) -> dict[str, Any]:
    """One domain of ``cpu_limits``: ``{max_mv, max_ratio, source}``; a limit that was not read is ``null``."""
    entry = entry or {}
    max_mv, max_ratio = entry.get("v_target_max_mv"), entry.get("ratio_max_oc")
    known = max_mv is not None or max_ratio is not None
    source = ("0x28/0x01 read" + (f" {read_at}" if read_at else "")) if known else "not read yet (0x28 / 0x01)"
    return {"max_mv": max_mv, "max_ratio": max_ratio, "source": source}


def cpu_limits_doc(
    helper: Helper,
    result: Mapping[str, Any] | None = None,
    *,
    power: Mapping[str, Any] | None = None,
    caps: Mapping[str, Any] | None = None,
    uncore: Sequence[int] | None = None,
) -> dict[str, Any]:
    """D-049 ``cpu_limits`` (tune.read / tune.last; ``power.read`` / ``runtime.read`` pass ``power`` = ``power.limits_json(...)``, ``caps`` = ``caps.limits_json(...)``, ``uncore`` =
    ``uncore.limits_json(...)``): everything the helper enforces, read at runtime::

        {"P": {"max_mv": 1625|null, "max_ratio": 120|null, "source": "0x28/0x01 read <iso>"}, "E": {...}, "ring": {...},
         "offset_mv": [-1000, 999], "power": {"locked": bool|null, "pl_max_w": number|null, "source": text}, "caps_khz": {"<cpu>": [min, max]}|null, "uncore_khz": [min, max]|null}

    ``null`` = not read yet: the write that needs it is refused with ``CPU_LIMIT_UNREAD`` naming the read. ``max_mv`` is ``0x28 [11:0] - 1 LSB`` in whole mV (XTU's rule; field 0 = 2.0 V),
    ``max_ratio`` ``0x01 [7:0]`` (``registers.md``); the P / E / ring values are the ones of this boot's ``tune.read`` (kept across a helper restart with the stored read; the timestamp of
    ``source`` is that read's), ``offset_mv`` is the 11-bit offset field (``-1024..1023`` raw = XTU's ``-1000..+999`` mV)."""
    st = _state(helper)
    with st.lock:
        limits = {kind: dict(v) for kind, v in (st.hw_limits or {}).items()}
    read_at = (result or {}).get("read_at") if isinstance((result or {}).get("read_at"), str) else None
    out: dict[str, Any] = {kind: _cpu_limit_entry(limits.get(kind), read_at) for kind in ("P", "E", "ring")}
    out["offset_mv"] = [ENCODING_OFFSET_FLOOR_MV, ENCODING_OFFSET_CEILING_MV]
    out["power"] = dict(power) if power is not None else {"locked": None, "pl_max_w": None, "source": "not read here (power.read reads MSR 0x610 / 0x606)"}
    out["caps_khz"] = None if caps is None else dict(caps)
    out["uncore_khz"] = None if uncore is None else list(uncore)
    return out


def _add_cpu_limits(helper: Helper, result: dict[str, Any]) -> None:
    result["cpu_limits"] = cpu_limits_doc(helper, result)


# --------------------------------------------------------------------------------------------------------------
# Words: decode
# --------------------------------------------------------------------------------------------------------------
def _decode(vf: VfWord) -> dict[str, Any]:
    """Contract 9 ``{ratio, offset_mv, v_target_v|null, mode}``. A ratio / V target field that reads 0 is *unset* (the OC word of 23 of 24 cores): null."""
    return {
        "ratio": vf.ratio or None,
        "offset_mv": round(vf.offset_mv, 3),
        "v_target_v": round(vf.v_target_v, 4) if vf.v_target_raw else None,
        "mode": "static" if vf.static else "adaptive",
    }


# --------------------------------------------------------------------------------------------------------------
# G-141: the audit-log position the words held are valid from
# --------------------------------------------------------------------------------------------------------------
def audit_mark(helper: Helper) -> int | None:
    """G-141: the byte size of the audit log now (0 = no log yet), a position every later record lies after; ``None`` when the log cannot be read or trusted."""
    cfg = helper.cfg
    try:
        _trust(helper, cfg.audit_path, want="file", must_exist=False)
        fd = open_checked(cfg.audit_path, write=False, create=False, euid=cfg.euid_fn(), what="audit log")
    except FileNotFoundError:
        return 0
    except (OpError, TrustError, OSError):
        return None
    try:
        with os.fdopen(fd, "rb") as handle:
            return os.fstat(handle.fileno()).st_size
    except OSError:
        return None


_AUDIT_LINE_MAX = 1 << 20
_MAILBOX_WRITE_CMDS = frozenset(int(c) for c in WRITE_COMMANDS)  # B-14: every write command as a plain int (a record's cmd is "0x11"), never a hand-kept copy


def stale_since_read(helper: Helper) -> str | None:
    """G-141: ``None`` when no hardware write happened since the words held (``helper.last_words``) were read or last verified by an apply, else why they may be stale.
    Judged from the audit log: a mailbox write command (``0x11`` ...) or a plain MSR write ``attempt`` after the byte position ``audit_mark`` taken when the read began
    (or when the last complete apply ended). Unknown = stale: an unreadable log, a log shorter than the mark, or a read that has no mark (stored by an older version)."""
    _last_words(helper)  # the lazy restore brings the stored mark back after a helper restart
    st = _state(helper)
    with st.lock:
        mark = st.audit_mark
    if mark is None:
        return "when the words in force were read is not known (an unreadable audit log, or a read stored by an older version)"
    cfg = helper.cfg
    try:
        _trust(helper, cfg.audit_path, want="file", must_exist=False)
        fd = open_checked(cfg.audit_path, write=False, create=False, euid=cfg.euid_fn(), what="audit log")
    except FileNotFoundError:
        return None if mark == 0 else "the audit log is gone since the read"
    except (OpError, TrustError, OSError) as exc:
        return f"the audit log cannot be read to prove nothing was written since the read ({getattr(exc, 'message', None) or exc})"
    try:
        with os.fdopen(fd, "rb") as handle:
            if os.fstat(handle.fileno()).st_size < mark:
                return "the audit log is shorter than when the words were read"
            if mark > 0:
                handle.seek(mark - 1)
                if handle.read(1) != b"\n":
                    handle.readline(_AUDIT_LINE_MAX + 1)  # the mark landed inside a record another process was still writing: start at the next line
            else:
                handle.seek(0)
            while True:
                raw = handle.readline(_AUDIT_LINE_MAX + 1)
                if not raw:
                    return None
                text = raw.strip()
                if not text:
                    continue
                try:
                    record = json.loads(text.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    if not raw.endswith(b"\n"):
                        continue  # a record cut short at the end of the file: ignored, as the guard's read_state does
                    return "an audit record after the read cannot be parsed"
                if not isinstance(record, dict) or record.get("event") != "attempt":
                    continue
                cmd = record.get("cmd")
                try:
                    wrote = record.get("msr_kind") == "write" or (isinstance(cmd, str) and int(cmd, 16) in _MAILBOX_WRITE_CMDS)
                except ValueError:
                    wrote = True
                if wrote:
                    what = f"MSR {record.get('msr')}" if record.get("msr_kind") == "write" else f"mailbox command {cmd}"
                    return f"the audit log shows a write ({what} on cpu {record.get('cpu')}, {record.get('ts')}) after the words were read"
    except OSError as exc:
        return f"the audit log cannot be read to prove nothing was written since the read ({exc.strerror or exc})"


def _advance_mark(helper: Helper) -> None:
    """After an apply that completed and whose verified read-backs were folded into the words held: they are current as of now."""
    mark = audit_mark(helper)
    st = _state(helper)
    with st.lock:
        st.audit_mark = mark


def _fused_map(topology: Topology, fused: Mapping[int, Mapping[str, Any]] | None) -> dict[int, int]:
    """cpu -> live ``0x09`` word for every CPU of every unit read (an E cluster is read on its first CPU; the other CPUs share its word)."""
    out: dict[int, int] = {}
    for cpu, entry in (fused or {}).items():
        try:
            word = int(entry["word"], 16)
            cpus = topology.unit_cpus(topology.unit_of_cpu(int(cpu)))
        except (KeyError, TypeError, ValueError, UnknownCore):
            continue
        for c in cpus:
            out[c] = word
    return out


def fused_favored_ratios(helper: Helper, topology: Topology) -> dict[int, int] | None:
    """B-10 / R-A3 follow-up: P CPU -> ``0x1C[15:8]`` (the fused maximum ratio, which a ``0x1D`` write does not move) from this boot's ``tune.read``; ``None`` unless every P CPU has a
    non-zero one. What ``topology.live.read_live(root, fused_ratios=...)`` decides *favored* from (favored-cores.md section 2)."""
    st = _state(helper)
    with st.lock:
        words = dict(st.favored_words or {})
    p_cpus = [c.cpu for c in topology.cores if c.kind == "P"]
    ratios = {cpu: (int(words[cpu]) >> 8) & 0xFF for cpu in p_cpus if cpu in words}
    return ratios if p_cpus and len(ratios) == len(p_cpus) and all(ratios.values()) else None


def with_fused_favored(topology: Topology, fused_ratios: Mapping[int, int] | None) -> Topology:
    """``topology`` with *favored* decided by ``fused_ratios`` (``0x1C[15:8]`` of every P CPU) -- the rule of ``topology.live.read_live``'s ``fused_ratios``: the P units with the
    highest fused ratio, none when all are equal; unchanged without them. sysfs (``acpi_cppc`` / ``cpuinfo_max_freq``) names the favored cores only at a clean boot: after a ``0x1D``
    raise on a non-favored core it names too many (B-10 [MEASURED lnx 2026-10-12, 2026-11-11]). Display and identity only (the fingerprint, the favored stars): no write reads it."""
    from linux_xtu.topology.live import FUSED_SOURCE

    p_cpus = [c.cpu for c in topology.cores if c.kind == "P"]
    if not fused_ratios or not p_cpus or not all(fused_ratios.get(cpu) for cpu in p_cpus):
        return topology
    values = {cpu: int(fused_ratios[cpu]) for cpu in p_cpus}
    favored = {cpu for cpu, v in values.items() if v == max(values.values())} if len(set(values.values())) > 1 else set()
    if favored == {c.cpu for c in topology.cores if c.kind == "P" and c.favored}:
        return topology  # the fuse and sysfs agree: nothing to re-decide
    cores = tuple(dataclasses.replace(c, favored=c.cpu in favored) if c.kind == "P" else c for c in topology.cores)
    return Topology(cores, favored_source=FUSED_SOURCE if favored else None)


# --------------------------------------------------------------------------------------------------------------
# G-123: the last complete read of this boot, kept root-owned next to the audit log; restored once per helper process
# --------------------------------------------------------------------------------------------------------------
def _last_store(helper: Helper) -> LastReadStore:
    cfg = helper.cfg
    return LastReadStore(Path(cfg.audit_path).parent / "state", euid=cfg.euid_fn())


def _current_boot(helper: Helper) -> str | None:
    boot = helper.cfg.boot_id_fn()
    return (boot.strip() or None) if isinstance(boot, str) else None


def _log(helper: Helper, text: str) -> None:
    try:
        helper.cfg.log(text)
    except Exception:  # noqa: BLE001 - logging must never fail an op
        pass


def _boot_record(helper: Helper) -> dict[str, Any] | None:
    """The stored record when it belongs to the current boot (both boot ids known and equal), else ``None``."""
    boot = _current_boot(helper)
    if boot is None:
        return None
    try:
        record = _last_store(helper).load()
    except LastReadError as exc:
        _log(helper, f"last-read not used: {exc}")
        return None
    return record if record is not None and record.get("boot_id") == boot else None


def _state_known_at(helper: Helper) -> str | None:
    """G-248: when the words the planner rests on were last seen on the CPU, ISO-8601 UTC at second resolution (``2026-11-12T08:30:01Z``): the time of this boot's last
    read, or of the last apply's verified read-back when that is later. ``None`` = no stored read of this boot (an unsaved or incomplete read is not one)."""
    record = _boot_record(helper)
    if record is None:
        return None
    stamps = [record.get(k) for k in ("at", "applied_at")]
    best = max((float(t) for t in stamps if isinstance(t, (int, float)) and not isinstance(t, bool)), default=None)
    return None if best is None else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(best))


def _record_words(record: Mapping[str, Any]) -> dict[int, list[int]]:
    out: dict[int, list[int]] = {}
    try:
        for cpu, ws in record["words"].items():
            if isinstance(ws, list) and ws:
                out[int(cpu)] = [int(w, 16) for w in ws]
    except (AttributeError, KeyError, TypeError, ValueError):
        return {}
    return out


def _restore_last(helper: Helper) -> None:
    """Once per helper process (lazily, on the first tune.* call): this boot's stored read becomes ``helper.last_words`` and the turbo / fused facts of
    the tune state, so ``tune.plan`` works after a helper restart without a new read. A read made in this process wins (nothing is overwritten)."""
    with _STATE_LOCK:
        if getattr(helper, "_last_restored", False) or getattr(helper, "_restoring", False):
            return  # done, or this very thread is inside the restore already (it holds the lock; another thread waits here until the restore has finished)
        helper._restoring = True  # type: ignore[attr-defined]
        try:
            _restore_last_locked(helper)
        finally:
            helper._restoring = False  # type: ignore[attr-defined]
            helper._last_restored = True  # type: ignore[attr-defined]  # G-141: set when the restore is DONE, so a concurrent tune.plan never sees "restored" before the words are there


def _restore_last_locked(helper: Helper) -> None:
    try:
        if getattr(helper, "last_words", None):
            return
        record = _boot_record(helper)
        words = _record_words(record) if record is not None else {}
        if record is None or not words:
            return
        result = record["result"]
        st = _state(helper)
        with st.lock:
            tables = result.get("tables")
            if st.tables is None and isinstance(tables, dict) and all(isinstance(tables.get(k), list) for k in ("e", "p")):
                st.tables = {k: tuple(int(x) for x in tables[k]) for k in ("e", "p")}
                st.tables_note = None
            fused = result.get("fused")
            if st.fused is None and isinstance(fused, dict):
                st.fused = {int(c): dict(v) for c, v in fused.items() if isinstance(v, dict)}
                helper.fused_words = _fused_map(helper_topology(helper), st.fused)  # under st.lock: not _topology (it reads the state too); units do not depend on favored
            limits = result.get("hw_limits")
            if st.hw_limits is None and isinstance(limits, dict):
                st.hw_limits = {str(k): dict(v) for k, v in limits.items() if isinstance(v, dict)}
                ring = (result.get("cpu_limits") or {}).get("ring")  # D-049: the ring's limits are kept in cpu_limits only
                if "ring" not in st.hw_limits and isinstance(ring, dict) and (ring.get("max_mv") is not None or ring.get("max_ratio") is not None):
                    st.hw_limits["ring"] = {"ratio_max_oc": ring.get("max_ratio"), "v_target_max_mv": ring.get("max_mv"), "offset_mv": [ENCODING_OFFSET_FLOOR_MV, ENCODING_OFFSET_CEILING_MV]}
            turbo = result.get("turbo")
            if st.turbo is None and isinstance(turbo, dict):
                st.turbo = {**turbo, "favored": {int(c): int(r) for c, r in (turbo.get("favored") or {}).items()}}
            favored = record.get("favored_words")  # G-141: the 0x1C words of the read: plan-time checks and the apply session's seed match the ones before the restart
            if st.favored_words is None and isinstance(favored, dict) and favored:
                st.favored_words = {int(c): int(w, 16) for c, w in favored.items()}
            mark = record.get("audit_mark")
            if st.audit_mark is None and isinstance(mark, int) and not isinstance(mark, bool) and mark >= 0:
                st.audit_mark = mark
        _set_last_words(helper, words)
        stored = record.get("ring_words")  # G-154
        try:
            ring_words = [int(w, 16) for w in stored] if isinstance(stored, list) and stored else ringmod.from_json(result.get("ring"))
        except (TypeError, ValueError):
            ring_words = None
        if getattr(helper, "last_ring", None) is None:
            _set_last_ring(helper, ring_words)
    except Exception as exc:  # noqa: BLE001 - a bad stored record must never break a tune op
        _log(helper, f"last-read not restored: {type(exc).__name__}: {exc}")


def _persist_applied_words(helper: Helper) -> None:
    """After an apply that wrote: the stored record's authoritative ``words`` follow ``helper.last_words`` (the verified read-backs)."""
    try:
        record = _boot_record(helper)
        last = _last_words(helper)
        if record is None or not last:
            return
        for cpu in list(record["words"]):
            if int(cpu) in last:
                record["words"][cpu] = [f"{w:#010x}" for w in last[int(cpu)]]
        ring = _last_ring(helper)
        if ring:  # G-154
            record["ring_words"] = [f"{w:#010x}" for w in ring]
        st = _state(helper)
        with st.lock:
            tables = None if st.tables is None else {k: list(v) for k, v in st.tables.items()}
            turbo = None if st.turbo is None else {**st.turbo, "favored": {str(c): r for c, r in (st.turbo.get("favored") or {}).items()}}
            record["audit_mark"] = st.audit_mark
        result = record.get("result")
        if isinstance(result, dict):  # G-141: tune.last and a restart must show the turbo tables the apply wrote
            if tables is not None:
                result["tables"] = tables
            if turbo is not None:
                result["turbo"] = turbo
        record["applied_at"] = helper.cfg.wall_clock()
        _last_store(helper).save(record)
    except (LastReadError, OSError, ValueError, TypeError, KeyError) as exc:
        _log(helper, f"last-read not updated after the apply: {exc}")
