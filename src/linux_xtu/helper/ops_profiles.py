"""``profiles.list`` / ``profiles.save`` / ``profiles.get`` (R-D1, split from ``ops_tune``; G-123, G-148, G-228, D-044): files only, no hardware.

``profiles.save`` stores this boot's read of every unit as a complete profile with the editor's edits (rows, turbo tables, ring points, power limits, ratio caps, uncore
limits) laid over it, or the read as it is (``{from: "read"}``); refused without a read of this boot (``NO_READ``), after a write since it (``STALE_READ``), over an existing
name (``EXISTS``) and without a writable audit log (``AUDIT_UNAVAILABLE``), and recorded in the audit log. :func:`capture_runtime` reads the power limits, caps and uncore
limits in force for it (absent = not captured); :func:`profile_of_intent` is the profile ``power.plan`` / ``runtime.plan`` read those sections from.
``profiles.accept`` / ``profiles.diff`` / ``profiles.fingerprint`` are in ``ops_accept``.
"""
from __future__ import annotations

import dataclasses
import os
import time
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from linux_xtu.guard import AuditLog
from linux_xtu.guard.policy import fused_top_ratio
from linux_xtu.profiles import SCHEMA_VERSION, BuildError, CapsSetting, PowerSetting, Profile, ProfileError, UncoreSetting, complete_from_words, load_profile, overlay
from linux_xtu.profiles.contents import intent_contents, profile_contents, summarize
from linux_xtu.profiles.serialize import dump_profile
from linux_xtu.profiles.store import NAME_RE, ProfileStoreError
from linux_xtu.topology import Topology, UnknownCore

from .ops import OpContext, _only, _trust, NO_ACCEPTED_NOTE
from .protocol import BAD_REQUEST, INTERNAL, REFUSED, OpError
from .trust import TrustError, open_checked
from .tune_intent import (
    CHAIN_HINT,
    _accepted_names,
    _accepted_paths,
    _accepted_profile,
    _bad,
    _profile_store,
    _read_accepted_text,
    _rows_to_profile,
    _saved_profile,
    canonical_intent,
)
from .tune_predict import _unit_point_ratios
from .tune_state import _last_ring, _last_words, _load_policy, _state, _topology, stale_since_read, unit_of_cpu

if TYPE_CHECKING:
    from .core import Helper

__all__ = ["capture_runtime", "op_profiles_get", "op_profiles_list", "op_profiles_save", "profile_of_intent"]


# --------------------------------------------------------------------------------------------------------------
# R-B1 (D-053 item 7): the runtime sections in force, and the profile a {restore} / {profile} request names
# --------------------------------------------------------------------------------------------------------------
def capture_runtime(helper: Helper, topology: Topology) -> tuple[Any, Any, Any, list[str]]:
    """R-B1 (D-053 item 7): ``(PowerSetting | None, CapsSetting | None, UncoreSetting | None, notes)`` -- the package power limits, the per-unit ratio caps and the uncore limits in
    force, read from their files (powercap, cpufreq, ``intel_uncore_frequency``; no MSR, no mailbox). Best effort: what cannot be read, or held exactly by the profile format, is
    ``None`` with a note ("not captured": left as it is when the profile is applied). Caps are not captured while a stress / measure run owns them (its caps are temporary)."""
    from linux_xtu.controls import caps as cp
    from linux_xtu.controls import power as pw
    from linux_xtu.controls import uncore as un
    from linux_xtu.profiles.runtime import caps_of, power_of, uncore_of

    from . import ops_power, ops_runtime

    notes: list[str] = []
    power = caps = uncore = None
    try:
        state = pw.read_state(ops_power._wiring(helper).files)
        power, note = power_of(state.pl1_uw, state.pl2_uw, state.tau_us)
        if note:
            notes.append(note)
    except (pw.PowerError, OpError, OSError) as exc:
        notes.append(f"power limits not captured: {getattr(exc, 'message', None) or exc}")
    try:
        w = ops_runtime._wiring(helper)
    except OpError as exc:
        notes.append(f"ratio caps and uncore limits not captured: {exc.message}")
        return power, None, None, notes
    held = ops_runtime._held(helper)
    if held is not None:
        notes.append(f"ratio caps not captured: {held} holds them")
    else:
        try:
            freq = cp.read_state(w.files, [c.cpu for c in topology.cores])
            per_unit: dict[str, list[int | None]] = {}
            for unit in topology.unit_ids():
                for cpu in topology.unit_cpus(unit):
                    f = freq.get(cpu)
                    per_unit.setdefault(unit, []).append(None if f is None else cp.effective_ratio(topology.by_cpu(cpu).kind, f.max_khz, f.cap_khz)[0])
            caps, cap_notes = caps_of(per_unit)
            notes.extend(cap_notes)
        except (cp.SysfsError, OSError) as exc:
            notes.append(f"ratio caps not captured: {exc}")
    try:
        u = un.read_state(w.files)
        uncore, note = uncore_of(u.min_khz, u.max_khz)
        if note:
            notes.append(note)
    except (cp.SysfsError, OSError) as exc:
        notes.append(f"uncore limits not captured: {exc}")
    return power, caps, uncore, notes


def profile_of_intent(helper: Helper, intent: Mapping[str, Any]) -> tuple[str, Profile]:
    """``(name, Profile)`` of ``{restore: "accepted"}`` (the accepted profile) or ``{profile: name}`` (the accepted one by its name, else a saved one): what ``power.plan`` /
    ``runtime.plan`` read a profile's runtime sections from. Refusals as ``tune.plan``'s; a legacy partial (intent) record has no runtime sections (``NOTHING_TO_DO``)."""
    if intent.get("restore") == "accepted":
        return _accepted_profile(helper)
    name = intent["profile"]
    try:
        acc_name, acc = _accepted_profile(helper)
    except OpError:
        acc_name, acc = None, None
    if acc is not None and acc_name == name:
        return name, acc
    try:
        record = _profile_store(helper).load(name)
    except ProfileStoreError as exc:
        raise OpError(BAD_REQUEST if exc.code == "NOT_FOUND" else REFUSED, exc.message, {"check": "PROFILE_" + exc.code}) from None
    prof = _saved_profile(record)
    if prof is None:
        raise OpError(REFUSED, f"saved profile {name} is partial (saved before G-148): it holds no power limits, caps or uncore limits; they are left as they are. Nothing was sent.",
                      {"check": "NOTHING_TO_DO"})
    return name, prof


# --------------------------------------------------------------------------------------------------------------
# profiles.list / profiles.save / profiles.get
# --------------------------------------------------------------------------------------------------------------
def _validate_profiles_save(args: dict[str, Any]) -> dict[str, Any]:
    """``{name, intent}`` or (G-228) ``{name, from: "read"}``; G-148: ``intent`` is the Tune editor's rows laid over this boot's read (rows that change nothing, or none,
    save the read as it is). ``from: "read"`` saves this boot's last read as it is (the state the CPU holds), with no editor rows."""
    _only(args, {"name", "intent", "from", "power", "runtime"})
    name = args.get("name")
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise _bad("'name' must be 1..64 characters of a-z 0-9 . _ -")
    if "from" in args:
        if {"intent", "power", "runtime"} & set(args):
            raise _bad("give the editor's edits ('intent', 'power', 'runtime') or 'from': 'read' (the state of the last read), not both")
        if args["from"] != "read":
            raise _bad("'from' must be 'read'")
        return {"name": name, "intent": None, "from": "read"}
    if not {"intent", "power", "runtime"} & set(args):
        raise _bad("profiles.save needs the editor's edits ('intent', and / or 'power', 'runtime'; an empty intent saves the read as it is) or 'from': 'read'")
    intent: dict[str, Any] | None = None
    if "intent" in args:
        try:
            intent = canonical_intent(args["intent"])  # R-B1 (U-30, D-044 / D-045): rows, turbo tables and ring points are all savable edits
        except OpError as exc:
            if (exc.detail or {}).get("check") != "NOTHING_TO_DO":
                raise
            intent = None
        if intent is not None and {"profile", "reset", "restore"} & set(intent):
            raise _bad("'intent' of profiles.save is the editor's edits: {scope, rows[, turbo][, ring]} (not a profile, reset or restore)")
    out: dict[str, Any] = {"name": name, "intent": intent}
    if args.get("power") is not None:  # R-B1 (D-053 item 7): edits of the power limits, laid over the values captured with the profile
        from .ops_power import _validate_power_plan

        out["power"] = _validate_power_plan({"power": args["power"]})["power"]
    if args.get("runtime") is not None:
        from .ops_runtime import _validate_runtime_plan

        if not isinstance(args["runtime"], dict) or "revert" in args["runtime"]:
            raise _bad("'runtime' must be {caps?: {cpu: ratio}, uncore?: {min_ratio?, max_ratio?}}")
        out["runtime"] = _validate_runtime_plan(dict(args["runtime"]))
    return out


def _save_edits(helper: Helper, args: Mapping[str, Any], topology: Topology, name: str) -> Profile | None:
    """The editor's edits of ``profiles.save`` as a partial profile to lay over the read (R-B1): the tune intent (rows, turbo tables, ring points; the same range checks as a
    plan) plus ``power`` and ``runtime`` (caps by CPU -> by unit: an E cluster runs one ratio). ``None`` when there is none."""
    edits: Profile | None = None
    if args.get("intent") is not None:
        edits = _rows_to_profile(helper, args["intent"], _load_policy(helper), topology, name).profile
    extra: dict[str, Any] = {}
    runtime = args.get("runtime") or {}
    by_unit: dict[str, int] = {}
    for cpu, ratio in (runtime.get("caps") or {}).items():
        try:
            unit = unit_of_cpu(topology, int(cpu))
        except UnknownCore:
            raise OpError(BAD_REQUEST, f"runtime.caps names cpu {cpu}, which this system does not have", {"check": "CAPS_UNKNOWN_CPU", "key": f"cpu{cpu}"}) from None
        if by_unit.setdefault(unit, ratio) != ratio:
            raise OpError(BAD_REQUEST, f"runtime.caps asks {unit} for two ratios ({by_unit[unit]} and {ratio}); its CPUs run one ratio", {"check": "CAPS_CLUSTER_CONFLICT", "key": f"cpu{cpu}"})
    try:
        if args.get("power"):  # whole watts as power.plan takes them; a fraction is refused by the schema, never truncated
            extra["power"] = PowerSetting(**{k: (int(v) if k != "tau_s" and float(v).is_integer() else v) for k, v in args["power"].items()})
        if by_unit:
            extra["caps"] = CapsSetting(tuple(by_unit.items()))
        if runtime.get("uncore"):
            extra["uncore"] = UncoreSetting(**runtime["uncore"])
        if not extra:
            return edits
        return Profile(name, (), points=(), power=extra.get("power"), caps=extra.get("caps"), uncore=extra.get("uncore")) if edits is None else dataclasses.replace(edits, **extra)
    except ProfileError as exc:
        raise OpError(BAD_REQUEST, f"the edits are not a valid profile: {exc}. Nothing was saved.") from None


def op_profiles_list(helper: Helper, ctx: OpContext, args: dict[str, Any]) -> dict[str, Any]:
    """``{profiles: [{name, source, created, complete}], accepted, note?}``. G-148: ``complete`` false = "partial (legacy)"; an accepted state that is still a chain lists
    its members with a note pointing at ``accepted-migrate`` (Restore accepted refuses it)."""
    out: list[dict[str, Any]] = []
    note: str | None = None
    try:
        paths = _accepted_paths(helper)
        if len(paths) > 1:
            note = f"the accepted state is an older chain of {len(paths)} profiles; Restore accepted refuses it until it is one profile: {CHAIN_HINT}"
            out.extend({"name": Path(p).stem, "source": "accepted", "created": None, "complete": False, "chain": True} for p in paths)
        else:
            name, prof = _accepted_profile(helper)
            out.append({"name": name, "source": "accepted", "created": None, "complete": prof.complete})  # an accepted profile has no creation time of its own
    except OpError as exc:
        note = NO_ACCEPTED_NOTE if exc.message.startswith(NO_ACCEPTED_NOTE) else exc.message
    try:
        out.extend(_profile_store(helper).list())
    except ProfileStoreError as exc:
        note = (note + "; " if note else "") + exc.message
    result: dict[str, Any] = {"profiles": out, "accepted": any(p["source"] == "accepted" for p in out)}  # G-129: false = "No accepted state yet"
    if note:
        result["note"] = note
    return result


def op_profiles_save(helper: Helper, ctx: OpContext, args: dict[str, Any]) -> dict[str, Any]:
    """G-148 (D-044): save a **complete** profile (G-228: ``{name, from: "read"}`` = the read as it is, no rows; never accepts it): this boot's last read of every unit (OC word fields, every fused point's offset, both turbo tables when read) with the
    editor's rows laid over it (``profiles.complete.overlay``). Refused without a read of this boot (``NO_READ``, "read first"), when a write came after it
    (``STALE_READ``), or when a word cannot be recorded exactly (``NOT_REPRESENTABLE``). The rows pass the same policy range checks as a plan. No hardware."""
    name = args["name"]
    if name in _accepted_names(helper):
        raise OpError(REFUSED, f"{name!r} is the name of an accepted profile; profiles are never overwritten", {"check": "EXISTS"})
    topology = _topology(helper)
    last = _last_words(helper)
    if not last:
        raise OpError(REFUSED, "no tune.read this boot: a saved profile is the complete state of the CPU (this boot's read with your edits over it), so read first (Tune > Read). "
                      "Nothing was saved.", {"check": "NO_READ"})
    why = stale_since_read(helper)
    if why is not None:
        raise OpError(REFUSED, f"the words of the last read may no longer be what the CPU holds: {why}. Read again first (Tune > Read), then save. Nothing was saved.", {"check": "STALE_READ"})
    fused = getattr(helper, "fused_words", None) or {}
    st = _state(helper)
    with st.lock:
        tables = None if st.tables is None else {k: list(v) for k, v in st.tables.items()}
    try:
        base = complete_from_words(topology, name, last, {c: fused_top_ratio(w) for c, w in fused.items()}, tables, _last_ring(helper))
    except BuildError as exc:
        raise OpError(REFUSED, f"{exc.message} Nothing was saved.", {"check": exc.code}) from None
    power, caps, uncore, not_captured = capture_runtime(helper, topology)  # R-B1 (D-053 item 7): absent = not captured, left as it is when applied
    base = dataclasses.replace(base, power=power, caps=caps, uncore=uncore)
    profile = base
    edits = _save_edits(helper, args, topology, name)
    if edits is not None:
        try:
            profile = overlay(base, edits, topology, name)
        except ProfileError as exc:
            raise OpError(BAD_REQUEST, f"the edits do not fit the read: {exc}. Nothing was saved.") from None
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(helper.cfg.wall_clock()))
    if args.get("from") == "read":
        header = f"Saved {stamp} by linux-xtu (profiles.save, G-228): the state of this boot's last read of every unit, as it is (not made the accepted state). A complete profile."
    else:
        header = f"Saved {stamp} by linux-xtu (profiles.save, G-148): this boot's read of every unit with the Tune editor's rows laid over it. A complete profile."
    cfg = helper.cfg
    _trust(helper, cfg.audit_path, want="file", must_exist=False)
    try:
        os.close(open_checked(cfg.audit_path, write=True, create=True, mode=0o600, euid=cfg.euid_fn(), what="audit log"))
        audit = AuditLog(cfg.audit_path)
    except (TrustError, OSError) as exc:  # G-235: proven writable before the profile file is written; nothing is saved without a record
        raise OpError(REFUSED, f"the audit log {cfg.audit_path} cannot be written ({exc}); nothing was saved", {"check": "AUDIT_UNAVAILABLE"}) from None
    try:
        record = _profile_store(helper).save(name, profile=dump_profile(profile, header))
    except ProfileError as exc:
        raise OpError(BAD_REQUEST, f"the profile cannot be written: {exc}") from None
    except ProfileStoreError as exc:
        raise OpError(REFUSED if exc.code in ("EXISTS", "UNTRUSTED") else BAD_REQUEST if exc.code in ("BAD_NAME", "TOO_BIG") else INTERNAL, exc.message, {"check": exc.code}) from None
    result = {"name": record["name"], "source": "saved", "created": record["created"], "complete": True, "units": len(profile.entries), "points": len(profile.points),
              "turbo": profile.turbo is not None, "ring_points": 0 if profile.ring is None else len(profile.ring.points),
              # R-B1 (additive, D-053 item 7): which runtime sections the profile holds; not_captured says why one is absent (it is then left as it is when applied)
              "power": profile.power is not None, "caps": profile.caps is not None, "uncore": profile.uncore is not None, "not_captured": not_captured, "version": SCHEMA_VERSION}
    if args.get("from") == "read":
        result["from"] = "read"  # G-228: saved from the state of the last read, not accepted
    try:
        audit.append("result", ts=cfg.wall_clock(), operator=cfg.operator, op="profiles.save", profile=record["name"], source="read" if args.get("from") == "read" else "edits",
                     units=result["units"], points=result["points"], turbo=result["turbo"], ring_points=result["ring_points"])
    except (OSError, ValueError) as exc:
        raise OpError(INTERNAL, f"profile {record['name']} was saved, but it could not be recorded in the audit log: {exc}", {"check": "AUDIT_UNAVAILABLE", "saved": record["name"]}) from None
    return result


def _validate_profiles_get(args: dict[str, Any]) -> dict[str, Any]:
    _only(args, {"name"})
    name = args.get("name")
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise _bad("'name' must be 1..64 characters of a-z 0-9 . _ -")
    return {"name": name}


def op_profiles_get(helper: Helper, ctx: OpContext, args: dict[str, Any]) -> dict[str, Any]:
    """Contract 9 (G-123): ``{name, source, created, complete, contents: {rows, turbo, complete}, summary}``. G-148: no chain any more -- a profile stands for
    itself; ``complete`` false = a partial profile saved before G-148 (its rows are what it changes)."""
    name = args["name"]
    topology = _topology(helper)

    def contents_of(profile: Profile) -> dict[str, Any]:
        return profile_contents(profile, topology, lambda cpu: unit_of_cpu(topology, cpu), _unit_point_ratios(helper, topology))

    try:
        acc_name, acc = _accepted_profile(helper)
    except OpError:
        acc_name, acc = None, None
    if acc is not None and acc_name == name:
        own = contents_of(acc)
        return {"name": name, "source": "accepted", "created": None, "complete": acc.complete, "contents": own, "summary": summarize(own)}
    if acc is None:  # an older chain: its members stand for their own file only (Restore accepted refuses the chain until accepted-migrate)
        try:
            for rel in _accepted_paths(helper):
                if Path(rel).stem == name:
                    member = load_profile(_read_accepted_text(helper, rel))
                    own = contents_of(member)
                    return {"name": name, "source": "accepted", "created": None, "complete": member.complete, "chain": True, "contents": own, "summary": summarize(own)}
        except (OpError, ProfileError):
            pass
    try:
        record = _profile_store(helper).load(name)
    except ProfileStoreError as exc:
        raise OpError(BAD_REQUEST if exc.code == "NOT_FOUND" else REFUSED, exc.message, {"check": "PROFILE_" + exc.code}) from None
    created = record.get("created")
    prof = _saved_profile(record)
    if prof is not None:
        own = contents_of(prof)
    else:
        own = intent_contents(canonical_intent(record["intent"], rows_only=True), topology.unit_ids())
    return {"name": name, "source": "saved", "created": created if isinstance(created, str) else None, "complete": prof is not None, "contents": own, "summary": summarize(own)}
