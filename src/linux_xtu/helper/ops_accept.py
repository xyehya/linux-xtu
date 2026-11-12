"""G-129 helper op ``profiles.accept`` (D-036): the **user** makes a profile the accepted state, in the app. Nothing is shipped as one.

``profiles.accept {name}`` takes a saved profile, ``profiles.accept {from: "read"}`` the state this boot's last ``tune.read`` found, and replaces
``/etc/linux-xtu/accepted/`` (``CURRENT`` + ``profiles/<name>.toml`` + ``EXPECTED-words.txt`` + ``fingerprint.json``, see :mod:`linux_xtu.profiles.accepted`) as a whole.

Contract (what "accepted" means, so the restore and the comparison stay honest):

* **Accepted = what the CPU holds now.** ``EXPECTED-words.txt`` is the V/F words of this boot's last read (the verified read-backs after an apply), so a
  saved profile must already be applied: when its resolved words differ from the read the op refuses (``NOT_APPLIED``, "apply it first"). A profile that
  was never applied cannot be recorded as the state the chip was verified to hold.
* G-148 (D-044): the accepted profile and ``EXPECTED-words.txt`` come from **one source**: the words of this boot's last read (the verified read-backs after
  an apply) and the turbo tables of that read. The profile is the **complete** profile of those words (:func:`linux_xtu.profiles.complete_from_words`: every
  unit's OC word fields, every fused point's offset, both tables when read), whichever way it is accepted -- ``{from: "read"}``, a saved complete profile,
  or a saved partial (legacy) one: the partial file is never recorded, only the state it was verified to have left. ``CURRENT`` names that one profile.
  A word that millivolts cannot represent exactly (the profile format has whole millivolts) is refused (``NOT_REPRESENTABLE``) rather than rounded, because
  the restore would then write a different word than the one recorded.
* Needs a read this boot (``NO_READ``); the policy still judges a saved profile (its range check runs as for a plan); writes nothing to the hardware.
* The op appends one audit record before the swap (and refuses if it cannot): ``event result``, ``op profiles.accept``, the name, what was replaced.

* G-138: ``fingerprint.json`` records, per Linux CPU, its kind / cluster / favored flag and the fused 0x09 word of this boot's last read, plus the CPU's
  family / model / brand (``/proc/cpuinfo``; none under the simulator): what the Windows restore needs to find the same cores again. A read that did not
  cover the 0x09 words writes the file with ``null`` words, which the Windows restore refuses (the reply says ``fingerprint: incomplete``).

* G-141: the op refuses (``STALE_READ``, "read again first") when the audit log shows a mailbox write (``0x11`` ...) or a plain MSR write after the read the words come
  from began (:func:`linux_xtu.helper.tune_state.stale_since_read`); an apply that completed in this process keeps them current. ``{from: "read"}`` records the turbo tables of
  the read too. It runs only while nothing else holds the device (``BUSY`` while a ``tune.apply`` / read / measure runs, and it holds the state machine while it works, so
  none can start in between): the words it records can not change under it.
* G-141 ``profiles.fingerprint``: writes ``fingerprint.json`` alone into the existing accepted directory from this boot's fused ``0x09`` words (the same file ``accept``
  records), for an accepted state made before G-138; ``CURRENT``, the profiles and ``EXPECTED-words.txt`` are not touched. See :func:`op_profiles_fingerprint`.

* G-154 (D-045): the ring (cache, mailbox domain P1 = 2) is one more unit of the accepted state: ``{from: "read"}`` / a saved profile records the ring of this boot's last
  ``tune.read`` -- ``EXPECTED-words.txt`` gets one ``ring  <OC word> <point 1> ... <point n>`` line and the profile a ``[ring]`` section (the OC word as read: compared by the
  restore, never written; every ring point's offset with ``expect_ratio``). A read without a ring (the policy cannot read it, an older helper) records none, and an accepted state
  without a ring line compares and restores nothing about the ring.

* G-228: an accept never destroys the state it replaces (operator incident 2026-10-18: an accidental "Set as accepted" overwrote a known-good state with no copy). Before the swap
  the accepted profile being replaced is saved, as it is, into the profile store as ``accepted-before-<UTC yyyymmdd-HHMMSS>`` (``-2``, ``-3`` ... when that name exists; these do not
  count toward the store's profile limit); when that save fails the accept is refused (``PREVIOUS_NOT_SAVED``, nothing changed). The reply carries ``previous_saved_as`` (a name, or
  ``None`` when there was no accepted state) and ``previous_saved_names`` (a list); the audit record ``previous_saved_names`` only. An accepted state that is still an older chain
  is refused (``ACCEPTED_CHAIN``: run accepted-migrate first). An accepted state that cannot be read (an empty or garbled ``CURRENT``, an untrusted file, a directory without
  ``CURRENT``) cannot be kept: the accept is refused (``ACCEPTED_UNREADABLE``) unless the request carries ``"set_aside_unreadable": true``, which moves the WHOLE directory to
  ``<accepted>.unreadable-<UTC stamp>`` (nothing is deleted, nothing is parsed) and then accepts; the reply says where (``set_aside_as``). ``profiles.diff {a, b}`` (read only)
  lists what differs between two states: the confirm step's per-unit diff.

No mailbox traffic, no MSR. A root file write under the helper's trust rules, like ``profiles.save``.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Mapping, Sequence

from linux_xtu.guard import AuditLog
from linux_xtu.curves.record import unit_order
from linux_xtu.guard.policy import fused_top_ratio
from linux_xtu.profiles import BuildError, Profile, ProfileError, complete_from_words
from linux_xtu.profiles.accepted import SAFE_PROFILE_NAME, AcceptedError, AcceptedStore
from linux_xtu.profiles.expected import format_ring_line
from linux_xtu.profiles.fingerprint import CpuId, FingerprintError, build_fingerprint, cpu_id_from_cpuinfo
from linux_xtu.profiles.runtime import runtime_differences
from linux_xtu.profiles.serialize import dump_profile
from linux_xtu.profiles.store import NAME_RE, PREVIOUS_PREFIX, ProfileStoreError
from linux_xtu.topology import Topology

from .ops import NO_ACCEPTED_NOTE, OpContext, _only, _trust
from .ops_profiles import capture_runtime
from .ops_tune_apply import validate_apply_args
from .protocol import BAD_REQUEST, BUSY, PLAN_STALE, REFUSED, OpError
from .state import Busy, State
from .trust import TrustError, check_trusted_path
from .tune_intent import CHAIN_HINT, _accepted_names, _accepted_paths, _accepted_profile, _profile_store, _read_accepted_text, _rows_to_profile, _saved_profile, canonical_hash, canonical_intent
from .tune_predict import _before_after
from .tune_state import PLAN_EXPIRES_S, PlanStore, _NONCE_ALPHABET, _STATE_LOCK, _last_ring, _last_words, _load_policy, _state, _topology, stale_since_read

if TYPE_CHECKING:
    from .core import Helper

__all__ = ["diff_profiles", "op_profiles_accept", "op_profiles_diff", "op_profiles_fingerprint", "validate_profiles_accept", "validate_profiles_diff"]

_VOLT_EPS = 0.002  # V: two decoded targets this close are the same word (the decode is raw / 1024)
_MV_EPS = 0.6  # mV: one offset raw step is 0.977 mV


def validate_profiles_accept(args: dict[str, Any]) -> dict[str, Any]:
    """Step 1 ``{name | from: "read"[, set_aside_unreadable]}`` (checks everything, writes nothing, answers ``{confirm_required, plan_id, nonce, expires_s, ...}``) or step 2
    ``{plan_id, typed: "CONFIRM <nonce>"}`` (D-053 item 4: the plan-style confirmation of ``*.apply``; the accept is done with the arguments of step 1)."""
    if "plan_id" in args or "typed" in args:
        return validate_apply_args(args)
    _only(args, {"name", "from", "set_aside_unreadable"})
    if ("name" in args) == ("from" in args):
        raise OpError(BAD_REQUEST, "give exactly one of 'name' (a saved profile) or 'from': 'read' (the state of the last read)")
    out: dict[str, Any]
    if "from" in args:
        if args["from"] != "read":
            raise OpError(BAD_REQUEST, "'from' must be 'read'")
        out = {"from": "read"}
    else:
        name = args["name"]
        if not isinstance(name, str) or not NAME_RE.match(name) or not SAFE_PROFILE_NAME.match(name) or ".." in name:
            raise OpError(BAD_REQUEST, "'name' must be a saved profile name: 1..64 characters of a-z 0-9 . _ - (no '..', not starting with '.' or '-')")
        out = {"name": name}
    if "set_aside_unreadable" in args:
        if args["set_aside_unreadable"] is not True:
            raise OpError(BAD_REQUEST, "'set_aside_unreadable' must be true when given")
        out["set_aside_unreadable"] = True
    return out


def _refused(text: str, check: str) -> OpError:
    return OpError(REFUSED, f"{text} Nothing was changed.", {"check": check})


def _held_difference(
    profile: Profile, topology: Topology, last: Mapping[int, Sequence[int]], fused: Mapping[int, int] | None, turbo: Mapping[str, Any] | None, ring: Sequence[int] | None = None,
    favored: Mapping[int, int] | None = None,
) -> str | None:
    """``None`` when every word the profile writes already reads as the profile resolves it (the plan's ``before`` equals its ``after``), else a short text. ``favored`` (the ``0x1C``
    words of the read): the OC word is resolved by the planner's own rules (``tune_predict._planner_goal``)."""
    before, after = _before_after(profile, topology, last, fused, turbo, ring, favored)
    for unit, items in after.items():
        for point, now in items.items():
            was = (before.get(unit) or {}).get(point)
            label = f"{unit} {'OC word' if point == '0' else 'point ' + point}"
            if was is None:
                return f"{label} was not read"
            if (now["offset_mv"] is None) != (was["offset_mv"] is None) or (now["offset_mv"] is not None and abs(now["offset_mv"] - was["offset_mv"]) > _MV_EPS):
                return f"{label}: offset {was['offset_mv']} mV now, {now['offset_mv']} mV in the profile"
            if now["ratio"] != was["ratio"]:
                return f"{label}: ratio {was['ratio']}x now, {now['ratio']}x in the profile"
            if (now["v_target_v"] is None) != (was["v_target_v"] is None) or (now["v_target_v"] is not None and abs(now["v_target_v"] - was["v_target_v"]) > _VOLT_EPS):
                return f"{label}: V target {was['v_target_v']} V now, {now['v_target_v']} V in the profile"
    return None


def _profile_from_words(
    topology: Topology,
    name: str,
    last: Mapping[int, Sequence[int]],
    fused: Mapping[int, int] | None,
    tables: Mapping[str, Sequence[int]] | None = None,
    ring: Sequence[int] | None = None,
) -> Profile:
    """G-148: the complete profile of the words of ``last`` (cpu -> words) with the top fused ratio of each unit from ``fused`` (cpu -> live ``0x09`` word) and, when the
    read had both, the turbo tables ``tables`` (``{"e": 8 buckets, "p": 8 buckets}``)."""
    tops = {cpu: fused_top_ratio(word) for cpu, word in (fused or {}).items()}
    try:
        return complete_from_words(topology, name, last, tops, tables, ring)
    except BuildError as exc:
        raise _refused(exc.message, exc.code) from None


def _expected_text(last: Mapping[int, Sequence[int]], header: str, ring: Sequence[int] | None = None) -> str:
    lines = [f"# {line}".rstrip() for line in header.splitlines()]
    lines.append("# <linux cpu> <OC word P2=0> <point 1> ... <point n>   (hex, no 0x), one line per core / E-cluster that the last read covered.")
    for cpu in sorted(last):
        lines.append(f"{cpu}  " + " ".join(f"{int(w):X}" for w in last[cpu]))
    if ring:  # G-154 (D-045): the ring (cache) line, same shape; absent = no ring in the accepted state
        lines.append("# ring: the ring (cache, mailbox domain P1=2) as the last read found it: <OC word (BIOS-owned, compared, never written)> <point 1> ... <point n>")
        lines.append(format_ring_line(ring))
    return "\n".join(lines) + "\n"


def _cpu_id(cfg: Any) -> CpuId | None:
    """The CPU's identity from ``cfg.cpuinfo_path`` (``/proc/cpuinfo`` on hardware; None under the simulator and when unreadable)."""
    path = getattr(cfg, "cpuinfo_path", None)
    if path is None:
        return None
    try:
        return cpu_id_from_cpuinfo(Path(path).read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return None


def _hold_device(helper: Helper, ctx: OpContext, op: str) -> None:
    """Take the helper's state machine for the duration of ``op`` (G-141): ``BUSY`` while a long op (``tune.apply``, a read, a measurement ...) runs, and none can start
    while this one works -- ``profiles.accept`` / ``profiles.fingerprint`` are quick off-thread ops, so without this a ``tune.apply`` could change the words under them."""
    try:
        helper.machine.begin(ctx.req_id, op, State.PLANNING)
    except Busy as exc:
        r = exc.running
        raise OpError(BUSY, f"the helper is {r.state.value} ({r.op} {r.op_id}); {op} needs the words in force to stand still. Try again when it has finished. Nothing was changed.",
                      {"state": r.state.value, "op_id": r.op_id, "op": r.op}) from None


def _reason(exc: OpError) -> str:
    return exc.message.removesuffix(" Nothing was sent.").rstrip(".")


def _leftovers(directory: Path) -> bool:
    """True when ``directory`` holds something although it names no accepted state (a real directory with files in it, or a plain file): a swap would delete it."""
    try:
        if directory.is_symlink():
            return False
        return directory.is_file() or (directory.is_dir() and any(directory.iterdir()))
    except OSError:
        return True


def _replaced_state(helper: Helper, directory: Path) -> tuple[str, str | None, str]:
    """G-228: what the accept is about to replace: ``("none", None, "")``, ``("one", "<profiles/x.toml>", "")``, ``("chain", None, "")`` (an older chain of several profiles) or
    ``("unreadable", None, "<why>")`` (it exists but cannot be read: it cannot be kept as a profile)."""
    try:
        rels = _accepted_paths(helper)
    except OpError as exc:
        if not exc.message.startswith(NO_ACCEPTED_NOTE):
            return "unreadable", None, _reason(exc)
        if _leftovers(directory):
            return "unreadable", None, f"{directory} has no CURRENT file but is not empty"
        return "none", None, ""
    if len(rels) > 1:
        return "chain", None, ""
    return "one", rels[0], ""


def _save_replaced(helper: Helper, rel: str, stamp: str, new_name: str) -> str:
    """G-228: save the accepted profile about to be replaced into the profile store, text as it is (a comment line first), and return its name. Anything that stops the copy
    refuses the accept (``PREVIOUS_NOT_SAVED``): losing the old state is worse than not accepting."""
    base = PREVIOUS_PREFIX + time.strftime("%Y%m%d-%H%M%S", time.gmtime(helper.cfg.wall_clock()))
    try:
        text = _read_accepted_text(helper, rel)
        note = f"Previous accepted state ({Path(rel).stem}), saved {stamp} because {new_name} replaced it (profiles.accept, G-228). The profile below is the accepted file as it was."
        return _profile_store(helper).save_unique(base, profile="# " + note + "\n" + text)["name"]
    except OpError as exc:
        raise _refused(f"the accepted state that this would replace could not be read, so it cannot be kept ({_reason(exc)}).", "PREVIOUS_NOT_SAVED") from None
    except ProfileStoreError as exc:
        raise _refused(f"the accepted state that this would replace could not be saved as a profile ({exc.message.rstrip('.')}); it is kept as it is.", "PREVIOUS_NOT_SAVED") from None


def _aside_target(directory: Path, wall_clock: float) -> Path:
    """``<accepted>.unreadable-<UTC yyyymmdd-HHMMSS>`` next to the accepted directory (``-2``, ``-3`` ... when taken)."""
    base = f"{directory.name}.unreadable-" + time.strftime("%Y%m%d-%H%M%S", time.gmtime(wall_clock))
    for n in range(1, 100):
        target = directory.parent / (base if n == 1 else f"{base}-{n}")
        if not os.path.lexists(target):
            return target
    raise _refused(f"{directory.parent} already holds {base} and its numbered variants.", "PREVIOUS_NOT_SAVED")


def _outcome(text: str, previous: str | None, check: str) -> OpError:
    """A refusal after the old state was already copied: say so (the copy stays; the accepted state is as it was)."""
    tail = f" The previous accepted state was saved as {previous}; the accepted state is unchanged." if previous else " Nothing was changed."
    return OpError(REFUSED, text.rstrip(".") + "." + tail, {"check": check})


@dataclass
class _AcceptPlan:
    """D-053 item 4: a ``profiles.accept`` waiting for its confirmation (the ``PlanStore`` semantics of ``tune.plan``: single use, 600 s, three wrong nonces drop it)."""

    plan_id: str
    nonce: str
    created: float
    args: dict[str, Any]
    material: str  # what the accept would write (profile, words, replaced state), hashed: step 2 refuses PLAN_STALE when it changed
    used: bool = False
    mismatches: int = 0


def _accept_plans(helper: Helper) -> PlanStore:
    with _STATE_LOCK:
        store = getattr(helper, "_accept_plans", None)
        if store is None:
            store = PlanStore(helper.cfg.monotonic)
            helper._accept_plans = store  # type: ignore[attr-defined]
        return store


def op_profiles_accept(helper: Helper, ctx: OpContext, args: dict[str, Any]) -> dict[str, Any]:
    """D-053 item 4 (human presence): two calls. Step 1 (``{name}`` / ``{from: "read"}``) runs every check and writes nothing: it answers what would be accepted and a
    ``plan_id`` + ``nonce`` (600 s, single use). Step 2 (``{plan_id, typed: "CONFIRM <nonce>"}``) re-checks against the state now (``PLAN_STALE`` when what would be written changed)
    and accepts. Every refusal of step 1 stores nothing (ask again)."""
    if "plan_id" in args:
        plan = _accept_plans(helper).claim(args["plan_id"], args["typed"])
        _hold_device(helper, ctx, "profiles.accept")
        try:
            prepared = _prepare(helper, plan.args)
            if prepared.material != plan.material:
                raise OpError(PLAN_STALE, "what this accept would record changed since it was confirmed (a new read, an apply, or the accepted state changed). Nothing was changed. "
                              "Ask again.", {"check": "STATE_CHANGED"})
            return _commit(helper, plan.args, prepared)
        finally:
            helper.machine.end(ctx.req_id)
    _hold_device(helper, ctx, "profiles.accept")
    try:
        prepared = _prepare(helper, args)
    finally:
        helper.machine.end(ctx.req_id)
    nonce = "".join(secrets.choice(_NONCE_ALPHABET) for _ in range(6))
    plan_id = hashlib.sha256(json.dumps({"args": args, "material": prepared.material, "nonce": nonce}, sort_keys=True).encode()).hexdigest()
    _accept_plans(helper).add(_AcceptPlan(plan_id, nonce, helper.cfg.monotonic(), dict(args), prepared.material))
    return {
        "confirm_required": True, "plan_id": plan_id, "nonce": nonce, "expires_s": int(PLAN_EXPIRES_S),
        "name": prepared.name, "source": prepared.source, "replaced": prepared.replaced, "previous_will_be_saved": prepared.rel is not None,
        "set_aside_as": None if prepared.aside is None else str(prepared.aside), "cpus": len(prepared.last),
        "core_entries": len(prepared.profile.entries), "points": len(prepared.profile.points), "turbo": prepared.profile.turbo is not None,
        "ring_points": 0 if prepared.profile.ring is None else len(prepared.profile.ring.points), "fingerprint": prepared.fingerprint_note,
        **_runtime_fields(prepared),
    }


def _runtime_fields(prepared: _Prepared) -> dict[str, Any]:
    """R-B1 (D-053 item 7, additive): which runtime sections the accepted state records; ``not_captured`` says why one is absent (left as it is by a restore)."""
    p = prepared.profile
    return {"power": p.power is not None, "caps": p.caps is not None, "uncore": p.uncore is not None, "not_captured": list(prepared.not_captured)}


def _stale_refusal(helper: Helper) -> OpError | None:
    why = stale_since_read(helper)
    if why is None:
        return None
    return _refused(f"the words of the last read may no longer be what the CPU holds: {why}. Read again first (Tune > Read), then accept.", "STALE_READ")


@dataclass
class _Prepared:
    """Everything an accept writes, decided before anything is written (step 1 shows it, step 2 re-decides it and compares ``material``)."""

    name: str
    source: str
    stamp: str
    header: str
    last: Mapping[int, Sequence[int]]
    profile: Profile
    profile_toml: str
    words_text: str
    fingerprint: Any
    fingerprint_note: str
    replaced: list[str]
    state: str
    rel: str | None
    why: str
    aside: Path | None
    directory: Path
    not_captured: list[str]
    material: str


def _prepare(helper: Helper, args: dict[str, Any]) -> _Prepared:
    """Every check of an accept and everything it would write; nothing is written. Refusals as before D-053 item 4 (``NO_READ``, ``STALE_READ``, ``NOT_APPLIED``, ...)."""
    cfg = helper.cfg
    directory = getattr(cfg, "accepted_dir", None)
    if directory is None:
        raise _refused("this helper keeps no accepted state (no accepted-state directory is configured).", "NO_ACCEPTED_DIR")
    directory = Path(directory)
    if cfg.enforce_trust:
        try:
            check_trusted_path(directory.parent, want="dir", must_exist=True, lstat_fn=cfg.lstat_fn)
        except TrustError as exc:
            raise _refused(f"the accepted state's location is untrusted: {exc}.", "NO_ACCEPTED_STATE") from None
    topology = _topology(helper)
    last = _last_words(helper)
    if not last:
        raise _refused("no tune.read this boot: the accepted state is what the CPU holds, so read it first (Tune > Read).", "NO_READ")
    stale = _stale_refusal(helper)
    if stale is not None:
        raise stale
    fused = getattr(helper, "fused_words", None) or {}
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(cfg.wall_clock()))
    power, caps, uncore, not_captured = capture_runtime(helper, topology)  # R-B1 (D-053 item 7): the runtime values in force join the accepted state
    if "from" in args:
        name = "read-" + time.strftime("%Y%m%d-%H%M%S", time.gmtime(cfg.wall_clock()))
        source = "the state of the last read"
    else:
        name = args["name"]
        try:
            record = _profile_store(helper).load(name)
        except ProfileStoreError as exc:
            raise OpError(BAD_REQUEST if exc.code == "NOT_FOUND" else REFUSED, exc.message, {"check": "PROFILE_" + exc.code}) from None
        saved = _saved_profile(record)
        if saved is None:  # a partial (legacy) profile: its rows resolved against the read
            policy = _load_policy(helper)
            saved = _rows_to_profile(helper, canonical_intent(record["intent"], rows_only=True), policy, topology, name).profile
            source = f"saved profile {name} (partial, legacy: the state it left on the CPU is recorded, not the file)"
        else:
            source = f"saved profile {name}"
        st = _state(helper)
        difference = _held_difference(saved, topology, last, fused, st.turbo, _last_ring(helper), dict(st.favored_words or {}))
        if difference is None:
            diffs = runtime_differences(saved, power, caps, uncore)
            difference = next(iter(diffs["power"] + diffs["runtime"]), None)
        if difference is not None:
            raise _refused(f"{name!r} is not what the CPU holds now ({difference}). Apply it first (Profiles > Review and apply), then set it as accepted.", "NOT_APPLIED")
    st = _state(helper)
    with st.lock:
        tables = None if st.tables is None else {k: list(v) for k, v in st.tables.items()}
    ring = _last_ring(helper)  # G-154: the ring of this boot's last read, or None (not read: no ring is recorded)
    profile = _profile_from_words(topology, name, last, fused, tables, ring)  # D-044 decision 2: the profile and EXPECTED-words.txt are the same words
    profile = dataclasses.replace(profile, power=power, caps=caps, uncore=uncore)
    replaced = _accepted_names(helper)
    header = f"Accepted {stamp} from {source}. Written by linux-xtu (profiles.accept); replace it the same way, never by hand."
    try:
        profile_toml = dump_profile(profile, header)
        body_toml = dump_profile(dataclasses.replace(profile, name="accepted"), "")
    except ProfileError as exc:
        raise _refused(f"the profile cannot be written: {exc}.", "NOT_REPRESENTABLE") from None
    words_text = _expected_text(last, header, ring if profile.ring is not None else None)
    fingerprint = build_fingerprint(topology, fused, _cpu_id(cfg))
    try:
        fingerprint.require_restorable()
        fingerprint_note = "complete"
    except FingerprintError as exc:
        fingerprint_note = f"incomplete: {exc}"
    _trust(helper, cfg.audit_path, want="file", must_exist=False)
    state, rel, why = _replaced_state(helper, directory)
    aside: Path | None = None
    if state == "chain":
        raise _refused(f"the accepted state is an older chain of {len(replaced)} profiles ({', '.join(replaced)}); accepting over it would delete the files that accepted-migrate rebuilds it from. First, {CHAIN_HINT}.", "ACCEPTED_CHAIN")
    if state == "unreadable":
        aside = _aside_target(directory, cfg.wall_clock())
        if args.get("set_aside_unreadable") is not True:
            raise _refused(f"the accepted state that this would replace cannot be read ({why}), so it cannot be kept as a profile. You can have the whole directory {directory} moved aside to {aside} "
                           "(nothing is deleted) and accept anyway.", "ACCEPTED_UNREADABLE")
    material = canonical_hash({"source": source if "from" not in args else "read", "profile": body_toml, "words": _expected_text(last, "", ring if profile.ring is not None else None),
                                 "replaced": replaced, "state": state, "rel": rel, "fingerprint": sorted((c.cpu, c.word) for c in fingerprint.cpus)})
    return _Prepared(name, source, stamp, header, last, profile, profile_toml, words_text, fingerprint, fingerprint_note, replaced, state, rel, why, aside, directory,
                     not_captured, material)


def _commit(helper: Helper, args: dict[str, Any], p: _Prepared) -> dict[str, Any]:
    """Write what :func:`_prepare` decided: keep the replaced state (G-228), audit, set an unreadable state aside, swap. Refusals here say whether the old state was copied."""
    cfg = helper.cfg
    directory, aside, name = p.directory, p.aside, p.name
    previous = _save_replaced(helper, p.rel, p.stamp, name) if p.rel is not None else None  # G-228: after every refusal that could still come, before the swap; a failure here refuses the accept
    names = [previous] if previous else []
    try:
        AuditLog(cfg.audit_path).append("result", op="profiles.accept", accepted=name, source=p.source, replaced=p.replaced, previous_saved_names=names,
                                        **({"set_aside_as": str(aside), "set_aside_reason": p.why} if aside is not None else {}), cpus=len(p.last),
                                        power=p.profile.power is not None, caps=p.profile.caps is not None, uncore=p.profile.uncore is not None)
    except (OSError, ValueError) as exc:
        raise _outcome(f"cannot record this in the audit log: {exc}", previous, "AUDIT_UNAVAILABLE") from None
    store = AcceptedStore(directory, euid=cfg.euid_fn())
    if aside is not None:
        try:
            store._check_parent()  # the same trust rule as the swap: never rename inside a directory the helper does not own
            os.rename(directory, aside)
        except (AcceptedError, OSError) as exc:
            raise _refused(f"the unreadable accepted state could not be moved aside ({getattr(exc, 'message', None) or getattr(exc, 'strerror', None) or exc}); it is where it was.", "ACCEPTED_UNREADABLE") from None
    try:
        store.replace(name, p.profile_toml, p.words_text, p.header, p.fingerprint.to_json(p.stamp))
    except AcceptedError as exc:
        if aside is not None and not os.path.lexists(directory):
            try:
                os.rename(aside, directory)  # nothing was accepted: the unreadable state goes back where it was
                aside = None
            except OSError:
                pass
        raise _outcome(exc.message, previous, "NO_ACCEPTED_STATE" if exc.code == "UNTRUSTED" else exc.code) from None
    profile = p.profile
    return {"name": name, "source": "accepted", "from": "read" if "from" in args else "saved", "accepted_at": p.stamp, "replaced": p.replaced,
            "previous_saved_as": previous, "previous_saved_names": names, "set_aside_as": None if aside is None else str(aside), "cpus": len(p.last),
            "core_entries": len(profile.entries), "points": len(profile.points), "turbo": profile.turbo is not None, "complete": profile.complete,
            "ring_points": 0 if profile.ring is None else len(profile.ring.points), "fingerprint": p.fingerprint_note, **_runtime_fields(p)}


def op_profiles_fingerprint(helper: Helper, ctx: OpContext, args: dict[str, Any]) -> dict[str, Any]:
    """G-141: ``profiles.fingerprint`` (no args) -- record ``fingerprint.json`` for the accepted state that exists, from this boot's fused ``0x09`` words, without re-accepting.

    For an accepted state made before G-138 (it has no fingerprint, so the Windows restore refuses it). Writes ONLY ``<accepted>/fingerprint.json`` (atomically); ``CURRENT``,
    the profiles and ``EXPECTED-words.txt`` stay byte for byte as they are. The words are the live ``0x09`` words of this boot's last read (``helper.fused_words``); the
    CPU identity comes from ``/proc/cpuinfo`` as in ``profiles.accept``. Refusals (nothing is changed): ``NO_ACCEPTED_DIR`` / ``NO_ACCEPTED_STATE`` (there is no accepted
    state: use ``profiles.accept``), ``NO_READ`` (this boot's read lacks the ``0x09`` word of a unit: read the whole system first), ``BUSY`` (another long op runs), and the
    store's trust refusals. Result: ``{recorded, cpus, accepted: [profile names], fingerprint: "complete" | "incomplete: <why>"}``; ``incomplete`` (for example no CPU
    identity under the simulator) is written all the same, as ``profiles.accept`` does, and says what the Windows restore will refuse. One audit record (``op profiles.fingerprint``)
    is appended before the file is written. No mailbox traffic, no MSR."""
    _hold_device(helper, ctx, "profiles.fingerprint")
    try:
        return _fingerprint(helper)
    finally:
        helper.machine.end(ctx.req_id)


def _fingerprint(helper: Helper) -> dict[str, Any]:
    cfg = helper.cfg
    directory = getattr(cfg, "accepted_dir", None)
    if directory is None:
        raise _refused("this helper keeps no accepted state (no accepted-state directory is configured).", "NO_ACCEPTED_DIR")
    directory = Path(directory)
    if cfg.enforce_trust:
        try:
            check_trusted_path(directory.parent, want="dir", must_exist=True, lstat_fn=cfg.lstat_fn)
        except TrustError as exc:
            raise _refused(f"the accepted state's location is untrusted: {exc}.", "NO_ACCEPTED_STATE") from None
    try:
        chain = [Path(p).stem for p in _accepted_paths(helper)]  # the same trusted read as everything else: no CURRENT / no profile = no accepted state
    except OpError as exc:
        raise _refused(f"there is no accepted state to record a fingerprint for ({exc.message.removesuffix(' Nothing was sent.')}); accept a profile first (Profiles > Set as accepted).", "NO_ACCEPTED_STATE") from None
    topology = _topology(helper)
    _last_words(helper)  # the lazy restore of this boot's stored read brings the fused words back after a helper restart
    fused = dict(getattr(helper, "fused_words", None) or {})
    missing = [u for u in topology.unit_ids() if topology.unit_cpus(u)[0] not in fused]
    if missing:
        raise _refused(
            f"this boot's read has no fused 0x09 word for {', '.join(missing)}; read the whole system first (Tune > Read), then record the fingerprint.", "NO_READ"
        )
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(cfg.wall_clock()))
    fingerprint = build_fingerprint(topology, fused, _cpu_id(cfg))
    try:
        fingerprint.require_restorable()
        note = "complete"
    except FingerprintError as exc:
        note = f"incomplete: {exc}"
    _trust(helper, cfg.audit_path, want="file", must_exist=False)
    try:
        AuditLog(cfg.audit_path).append("result", op="profiles.fingerprint", accepted=chain, recorded=stamp, cpus=len(fused))
    except (OSError, ValueError) as exc:
        raise _refused(f"cannot record this in the audit log: {exc}.", "AUDIT_UNAVAILABLE") from None
    try:
        AcceptedStore(directory, euid=cfg.euid_fn()).write_fingerprint(fingerprint.to_json(stamp))
    except AcceptedError as exc:
        check = "NO_ACCEPTED_STATE" if exc.code in ("UNTRUSTED", "MISSING") else exc.code
        raise OpError(REFUSED, f"{exc.message}. Nothing was changed.", {"check": check}) from None
    return {"recorded": stamp, "cpus": len(fingerprint.cpus), "accepted": chain, "fingerprint": note}


# --------------------------------------------------------------------------------------------------------------
# profiles.diff (G-228): what differs between two states. Compares the Profile objects themselves, so nothing the profile holds is dropped on the way (the OC word's whole-curve
# offset, the ring, the turbo tables), unlike the Profiles list's contents view (profiles/contents.py) which shows a unit's offsets as one row.
# --------------------------------------------------------------------------------------------------------------
DIFF_ROWS_MAX = 400
_RING_UNIT = "ring"
_OTHER = 3  # unit_order puts P units at 0 and E clusters at 1; the ring and the turbo tables come after


def _diff_ref(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    if value in ("accepted", "read"):
        return value
    if isinstance(value, str) and NAME_RE.match(value):
        return value
    raise OpError(BAD_REQUEST, f"'{key}' must be 'accepted', 'read' or a saved profile name (1..64 characters of a-z 0-9 . _ -)")


def validate_profiles_diff(args: dict[str, Any]) -> dict[str, Any]:
    _only(args, {"a", "b"})
    if "a" not in args or "b" not in args:
        raise OpError(BAD_REQUEST, "give 'a' and 'b': 'accepted', 'read' or a saved profile name")
    return {"a": _diff_ref(args, "a"), "b": _diff_ref(args, "b")}


def _read_profile(helper: Helper, topology: Topology) -> Profile:
    """The complete profile of this boot's last read, as ``profiles.save`` / ``profiles.accept`` ``{from: "read"}`` record it (same gates, same builder)."""
    last = _last_words(helper)
    if not last:
        raise OpError(REFUSED, "no tune.read this boot: the state of the CPU is what the last read found, so read it first (Tune > Read).", {"check": "NO_READ"})
    why = stale_since_read(helper)
    if why is not None:
        raise OpError(REFUSED, f"the words of the last read may no longer be what the CPU holds: {why}. Read again first (Tune > Read).", {"check": "STALE_READ"})
    st = _state(helper)
    with st.lock:
        tables = None if st.tables is None else {k: list(v) for k, v in st.tables.items()}
    try:
        return _profile_from_words(topology, "read", last, getattr(helper, "fused_words", None) or {}, tables, _last_ring(helper))
    except OpError as exc:
        raise OpError(REFUSED, exc.message.removesuffix(" Nothing was changed."), exc.detail) from None


def _diff_side(helper: Helper, topology: Topology, ref: str) -> tuple[Profile, dict[str, Any]]:
    if ref == "read":
        return _read_profile(helper, topology), {"ref": ref, "name": None, "source": "read", "partial": False}
    try:
        acc_name, acc = _accepted_profile(helper)
    except OpError:
        if ref == "accepted":
            raise
        acc_name, acc = None, None
    if acc is not None and ref in ("accepted", acc_name):
        return acc, {"ref": ref, "name": acc_name, "source": "accepted", "partial": not acc.complete}
    if ref == "accepted":
        raise OpError(REFUSED, NO_ACCEPTED_NOTE + ".", {"check": "NO_ACCEPTED_STATE"})
    try:
        record = _profile_store(helper).load(ref)
    except ProfileStoreError as exc:
        raise OpError(BAD_REQUEST if exc.code == "NOT_FOUND" else REFUSED, exc.message, {"check": "PROFILE_" + exc.code}) from None
    saved = _saved_profile(record)
    if saved is not None:
        return saved, {"ref": ref, "name": ref, "source": "saved", "partial": False}
    policy = _load_policy(helper)  # a partial (legacy) profile: its rows resolved against the read; only what it sets is compared
    resolved = _rows_to_profile(helper, canonical_intent(record["intent"], rows_only=True), policy, topology, ref).profile
    return resolved, {"ref": ref, "name": ref, "source": "saved", "partial": True}


def _rank(unit: str) -> tuple[int, int]:
    if unit == _RING_UNIT:
        return (_OTHER, 0)
    if unit.endswith(" turbo"):
        return (_OTHER + 1, 0 if unit[0] == "P" else 1)
    return unit_order(unit)


def _facts(profile: Profile, topology: Topology) -> dict[tuple[str, int], tuple[str, str, Any]]:
    """``{(unit, order): (label, kind, value)}`` for everything the profile holds. ``kind``: ``mv`` (offset), ``v`` (volts), ``x`` (a ratio), ``hex`` (a word). ``None`` = not set."""
    out: dict[tuple[str, int], tuple[str, str, Any]] = {}
    for s in profile.expand(topology):
        unit = topology.unit_of_cpu(s.cpu)
        out[(unit, 0)] = ("OC word: whole-curve offset", "mv", s.offset_mv)
        out[(unit, 1)] = ("OC ratio", "x", s.ratio)
        out[(unit, 2)] = ("OC target voltage", "v", None if s.oc_voltage_mv is None else round(s.oc_voltage_mv / 1000, 4))
    for p in profile.expand_points(topology):
        out[(topology.unit_of_cpu(p.cpu), 10 + p.point)] = (f"Offset at {p.expect_ratio}x" if p.expect_ratio else f"Offset, point {p.point}", "mv", p.offset_mv)
    if profile.ring is not None:
        out[(_RING_UNIT, 0)] = ("OC word (BIOS-owned)", "hex", f"0x{profile.ring.oc_word:08X}")
        for rp in profile.ring.points:
            out[(_RING_UNIT, 10 + rp.point)] = (f"Offset at {rp.expect_ratio}x", "mv", rp.offset_mv)
    if profile.turbo is not None:
        for key in ("p", "e"):
            for i, ratio in enumerate(getattr(profile.turbo, key) or ()):
                out[(f"{key.upper()} turbo", i)] = (f"Bucket {i}", "x", ratio)
    return out


def diff_profiles(pa: Profile, pb: Profile, topology: Topology) -> list[dict[str, Any]]:
    """The settings that differ between two profiles, in display order: ``{unit, label, kind, a, b}`` (``None`` = that profile does not hold it)."""
    fa, fb = _facts(pa, topology), _facts(pb, topology)
    rows: list[dict[str, Any]] = []
    for key in sorted(set(fa) | set(fb), key=lambda k: (_rank(k[0]), k[0], k[1])):
        ta, tb = fa.get(key), fb.get(key)
        va = None if ta is None else ta[2]
        vb = None if tb is None else tb[2]
        if va != vb:
            label, kind, _ = ta or tb  # type: ignore[misc]
            rows.append({"unit": key[0], "label": label, "kind": kind, "a": va, "b": vb})
    return rows


def op_profiles_diff(helper: Helper, ctx: OpContext, args: dict[str, Any]) -> dict[str, Any]:
    """``{a, b}`` -> ``{a: side, b: side, rows: [{unit, label, kind, a, b}], units: [{unit, n}], compared: [...], not_compared: [{what, why}], truncated}``. Each side is ``"accepted"``
    (the accepted profile), ``"read"`` (this boot's last read as ``profiles.save`` / ``profiles.accept`` ``{from: "read"}`` record it; ``NO_READ`` / ``STALE_READ`` as there) or a saved
    profile's name. A row is one setting that differs; ``a`` / ``b`` ``None`` = that state does not hold it. Read only: files and the stored read, no hardware."""
    topology = _topology(helper)
    pa, side_a = _diff_side(helper, topology, args["a"])
    pb, side_b = _diff_side(helper, topology, args["b"])
    rows = diff_profiles(pa, pb, topology)
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["unit"]] = counts.get(r["unit"], 0) + 1
    compared = ["each unit's OC word (whole-curve offset, OC ratio, OC target voltage)", "every fused point's offset"]
    not_compared: list[dict[str, str]] = []
    for what, held in (("the ring", pa.ring is not None or pb.ring is not None), ("the turbo tables", pa.turbo is not None or pb.turbo is not None)):
        if held:
            compared.append(what)
        else:
            not_compared.append({"what": what, "why": "neither state records it"})
    if side_a["partial"] or side_b["partial"]:
        not_compared.append({"what": "settings a partial (legacy) profile does not set", "why": "listed with '-' on its side, not as equal"})
    return {"a": side_a, "b": side_b, "rows": rows[:DIFF_ROWS_MAX], "units": [{"unit": u, "n": n} for u, n in counts.items()], "compared": compared, "not_compared": not_compared,
            "truncated": max(0, len(rows) - DIFF_ROWS_MAX)}
