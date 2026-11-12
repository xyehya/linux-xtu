"""The ``tune.plan`` intent and what it resolves to (R-D1, split from ``ops_tune``; contract 9, G-148, G-212, R-B1).

* Shape: :func:`canonical_intent` validates and canonicalises ``{scope, rows[, turbo][, ring]}``, ``{turbo}``, ``{ring}``, ``{profile}``, ``{reset: "stock"}`` and
  ``{restore: "accepted"}`` (``BAD_REQUEST`` naming the field; checks ``CURVE_AND_POINTS``, ``NOTHING_TO_DO``). :func:`canonical_hash` / :func:`intent_changed` are a
  plan's ``intent_hash`` and every apply's ``PLAN_STALE INTENT_CHANGED`` check (R-26).
* Sources: the accepted state (``accepted/CURRENT``: one profile since D-044; an older chain is refused, ``CHAIN_HINT``) and the saved-profile store, read through the trust
  checks (``NO_ACCEPTED_STATE``, ``ACCEPTED_CHAIN``, ``PROFILE_*``).
* :func:`resolve_intent`: the intent as a ``Profile`` for the controls planner, resolving "the point at ratio 53" from the words of the last read, with each row's plan-time
  range checks (``POLICY_RANGE``: the offset field and the CPU's own limits of this boot's read, D-049; ``OC_MODE_NOT_OFFERED``; ``NO_SUCH_POINT``; ``NO_READ``) and the
  words it assumed (``refs`` / ``ring_refs``, compared at apply). A complete profile is refused on another CPU (``PROFILE_TOPOLOGY``).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from linux_xtu.controls import resolve_point_targets, resolve_targets, resolve_ring_targets
from linux_xtu.guard import Policy
from linux_xtu.controls import ring as ringmod
from linux_xtu.controls.planner import Warn
from linux_xtu.guard.policy import ENCODING_OFFSET_CEILING_MV, ENCODING_OFFSET_FLOOR_MV, fused_top_ratio, ratio_limit, v_target_limit
from linux_xtu.mailbox import Cmd, VfWord
from linux_xtu.mailbox.encoding import RATIO_RANGE, RATIO_SOURCE, TURBO_RATIO_RANGE, V_TARGET_RANGE_MV, V_TARGET_SOURCE
from linux_xtu.curves import is_unit_id
from linux_xtu.profiles import POINT_RANGE, CoreSetting, PointSetting, Profile, ProfileError, RingPoint, RingSetting, TurboTables, load_profile
from linux_xtu.profiles.migrate import current_profile_lines
from linux_xtu.profiles.store import NAME_RE, ProfileStore, ProfileStoreError
from linux_xtu.topology import Topology, UnknownCore

from .ops import _is_int, NO_ACCEPTED_NOTE
from .protocol import BAD_REQUEST, PLAN_STALE, REFUSED, OpError
from .trust import TrustError, check_trusted_path, open_checked
from .tune_state import _kind_of, _last_ring, _last_words, _state, _unit_reference, unit_cpus, unit_of_cpu

if TYPE_CHECKING:
    from .core import Helper

__all__ = ["CHAIN_HINT", "INTENT_FEATURES", "Resolved", "canonical_hash", "canonical_intent", "groups_of", "intent_changed", "intent_diff", "resolve_intent"]


_MAX_INTENT_BYTES = 16 * 1024
_ACCEPTED_FILE_MAX = 256 * 1024
_ACCEPTED_PATH_RE = re.compile(r"profiles/[A-Za-z0-9._-]{1,80}\Z")
_RATIO_RANGE = RATIO_RANGE  # G-141 (D-039): the field encodings of linux_xtu.mailbox.encoding, shared with the profile schema; the policy and the CPU's limits are the bounds


def groups_of(topology: Topology) -> dict[str, tuple[str, ...]]:
    """The ``P`` / ``E`` groups of a topology's units (a ``simple`` row addresses a whole group)."""
    ids = topology.unit_ids()
    return {"P": tuple(u for u in ids if u.startswith("P")), "E": tuple(u for u in ids if u.startswith("EC"))}


# --------------------------------------------------------------------------------------------------------------
# Intent: validation (shape only), canonical form
# --------------------------------------------------------------------------------------------------------------
def _bad(text: str) -> OpError:
    return OpError(BAD_REQUEST, text)


def _int_mv(value: object, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or float(value) != int(value):
        raise _bad(f"{what} must be a whole number of millivolts")
    mv = int(value)
    if not -1000 <= mv <= 999:
        raise _bad(f"{what} {mv} mV is outside the V/F word's -1000..999 mV")
    return mv


def _canonical_row(raw: object, scope: str) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        raise _bad("each row must be an object")
    extra = sorted(set(raw) - {"target", "offset", "v_target_v", "ratio"})
    if extra:
        raise _bad(f"unknown row key(s): {', '.join(map(repr, extra))}")
    target = raw.get("target")
    if not isinstance(target, str) or not (target in ("P", "E") if scope == "simple" else is_unit_id(target)):
        raise _bad(f"row target {target!r} is not {'P or E' if scope == 'simple' else 'a unit (P<n> / EC<n>)'} (scope {scope!r})")
    offset = raw.get("offset")
    canon_offset: dict[str, Any] | None = None
    if offset is not None:
        if not isinstance(offset, dict) or set(offset) != {"kind", "mv"}:
            raise _bad("offset must be null or {kind: 'curve', mv: int} or {kind: 'points', mv: {ratio: int}}")
        if offset["kind"] == "curve":
            canon_offset = {"kind": "curve", "mv": _int_mv(offset["mv"], "offset.mv")}
        elif offset["kind"] == "points":
            mvs = offset["mv"]
            if not isinstance(mvs, dict) or not mvs or len(mvs) > 12:
                raise _bad("offset.mv of kind 'points' must be a non-empty object {ratio: mV}")
            canon: dict[str, int] = {}
            for key, value in mvs.items():
                if not isinstance(key, str) or not key.isdigit() or not _RATIO_RANGE[0] <= int(key) <= _RATIO_RANGE[1]:
                    raise _bad(f"offset.mv key {key!r} is not a ratio ({_RATIO_RANGE[0]}..{_RATIO_RANGE[1]}, {RATIO_SOURCE})")
                canon[str(int(key))] = _int_mv(value, f"offset.mv[{key}]")
            canon_offset = {"kind": "points", "mv": canon}
        else:
            raise _bad(f"offset.kind {offset['kind']!r} is not 'curve' or 'points'")
    v = raw.get("v_target_v")
    if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not V_TARGET_RANGE_MV[0] <= round(v * 1000) <= V_TARGET_RANGE_MV[1]):
        raise _bad(f"v_target_v must be null or a voltage in volts ({V_TARGET_RANGE_MV[0] / 1000:g}..{V_TARGET_RANGE_MV[1] / 1000:g}, {V_TARGET_SOURCE})")
    ratio = raw.get("ratio")
    if ratio is not None and (not _is_int(ratio) or not _RATIO_RANGE[0] <= ratio <= _RATIO_RANGE[1]):
        raise _bad(f"ratio must be null or an integer {_RATIO_RANGE[0]}..{_RATIO_RANGE[1]} ({RATIO_SOURCE})")
    if canon_offset is None and v is None and ratio is None:
        return None  # a row that changes nothing is dropped, like an unchanged row of the UI
    return {"target": target, "offset": canon_offset, "v_target_v": None if v is None else float(v), "ratio": ratio}


def _canonical_turbo(raw: object) -> dict[str, list[int]]:
    """``{P: [8 ints], E: [8 ints]}`` (either key may be absent, not both): the bucket ratios of ``0x1AD`` / ``0x650``, bucket 0 = 1 active core."""
    if not isinstance(raw, dict) or not raw or not set(raw) <= {"P", "E"}:
        raise _bad("turbo must be {P: [8 ratios], E: [8 ratios]} (either key may be absent)")
    out: dict[str, list[int]] = {}
    for key, table in raw.items():
        if not isinstance(table, list) or len(table) != 8 or not all(_is_int(r) and TURBO_RATIO_RANGE[0] <= r <= TURBO_RATIO_RANGE[1] for r in table):
            raise _bad(f"turbo.{key} must be a list of 8 integer ratios {TURBO_RATIO_RANGE[0]}..{TURBO_RATIO_RANGE[1]} ({RATIO_SOURCE}, one byte per bucket)")
        out[key] = list(table)
    return out


#: G-212: the intent features this helper understands beyond ``{scope, rows[, turbo]}``; ``tune.read`` / ``tune.last`` carry it as ``intent_features`` so a front-end can detect support.
INTENT_FEATURES = ("ring",)


def _canonical_ring(raw: object) -> dict[str, Any]:
    """G-212 (D-045, D-046): ``{points: {"<P2>": mV}}`` -- the ring (cache, P1 = 2) points to move, keyed by the **P2 point number** (1..15; ``0`` is the BIOS-owned ring OC word and is
    never written), offset-only. Nothing else is accepted: the ring has no OC ratio, V target or whole-curve offset to set here."""
    if not isinstance(raw, dict) or set(raw) != {"points"}:
        raise _bad("ring must be {points: {P2: mV}}")
    points = raw["points"]
    if not isinstance(points, dict) or not points or len(points) > POINT_RANGE[1]:
        raise _bad("ring.points must be a non-empty object {P2 point number: mV}")
    out: dict[str, int] = {}
    for key, value in points.items():
        if not isinstance(key, str) or not re.fullmatch(r"[0-9]{1,2}", key) or not POINT_RANGE[0] <= int(key) <= POINT_RANGE[1]:
            raise _bad(f"ring.points key {key[:20]!r} is not a ring point number ({POINT_RANGE[0]}..{POINT_RANGE[1]}; P2 = 0 is the ring OC word, which is never written)" if isinstance(key, str) else "ring.points key is not a string")
        if str(int(key)) in out:
            raise _bad(f"ring.points names point {int(key)} more than once")
        out[str(int(key))] = _int_mv(value, f"ring.points[{key}]")
    return {"points": dict(sorted(out.items(), key=lambda kv: int(kv[0])))}


def canonical_intent(raw: object, *, rows_only: bool = False) -> dict[str, Any]:
    """The intent in its canonical form, or ``BAD_REQUEST``. ``rows_only`` (profiles.save): a ``{scope, rows}`` intent is the only savable shape."""
    if not isinstance(raw, dict):
        raise _bad("intent must be an object")
    try:
        if len(json.dumps(raw)) > _MAX_INTENT_BYTES:
            raise _bad(f"intent is larger than {_MAX_INTENT_BYTES} bytes")
    except (TypeError, ValueError):
        raise _bad("intent is not JSON") from None
    keys = set(raw)
    if keys and keys <= {"scope", "rows", "turbo", "ring"} and keys & {"rows", "turbo", "ring"} and ("rows" in keys) == ("scope" in keys):
        if rows_only and keys & {"turbo", "ring"}:
            raise _bad("only a {scope, rows} intent can be saved as a profile")
        out: dict[str, Any] = {}
        turbo = _canonical_turbo(raw["turbo"]) if "turbo" in keys else None
        ring = _canonical_ring(raw["ring"]) if "ring" in keys else None
        if "rows" in keys:
            scope, rows = raw["scope"], raw["rows"]
            if scope not in ("simple", "unit"):
                raise _bad("scope must be 'simple' or 'unit'")
            if not isinstance(rows, list) or len(rows) > 32:
                raise _bad("rows must be a list of at most 32 rows")
            canon_rows = [r for r in (_canonical_row(row, scope) for row in rows) if r is not None]
            targets = [r["target"] for r in canon_rows]
            if len(set(targets)) != len(targets):
                twice = sorted({t for t in targets if targets.count(t) > 1})
                kinds = {(r["offset"] or {}).get("kind") for r in canon_rows if r["target"] in twice}
                if {"curve", "points"} <= kinds:  # golden R09-curve-and-points-one-review: the two layers are two plans, never folded into one
                    raise OpError(BAD_REQUEST, f"a target appears in two rows ({', '.join(twice)}: a whole-curve change and a point change on one unit go in two plans, one after the "
                                  "other; the CPU adds the two layers)", {"check": "CURVE_AND_POINTS", "key": twice[0]})
                raise _bad("a target appears in two rows")
            if not canon_rows and turbo is None and ring is None:
                raise OpError(BAD_REQUEST, "the intent changes nothing (every row is empty)", {"check": "NOTHING_TO_DO"})
            if canon_rows:
                out = {"scope": scope, "rows": canon_rows}
        if turbo is not None:
            out["turbo"] = turbo
        if ring is not None:
            out["ring"] = ring
        return out
    if rows_only:
        raise _bad("only a {scope, rows} intent can be saved as a profile")
    if keys == {"profile"}:
        name = raw["profile"]
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise _bad("profile must be a name of 1..64 characters of a-z 0-9 . _ -")
        return {"profile": name}
    if keys == {"reset"}:
        if raw["reset"] != "stock":
            raise _bad("reset must be 'stock'")
        return {"reset": "stock"}
    if keys == {"restore"}:
        if raw["restore"] != "accepted":
            raise _bad("restore must be 'accepted'")
        return {"restore": "accepted"}
    raise _bad("intent must be {scope, rows[, turbo][, ring]}, {turbo}, {ring}, {profile}, {reset: 'stock'} or {restore: 'accepted'}")


# --------------------------------------------------------------------------------------------------------------
# Accepted state (/etc/linux-xtu/accepted/CURRENT: one profile since D-044) and saved profiles
# --------------------------------------------------------------------------------------------------------------
def _read_accepted_text(helper: Helper, relative: str, limit: int = _ACCEPTED_FILE_MAX) -> str:
    cfg = helper.cfg
    directory = getattr(cfg, "accepted_dir", None)
    if directory is None:
        raise OpError(REFUSED, "no accepted state directory is configured. Nothing was sent.", {"check": "NO_ACCEPTED_STATE"})
    path = Path(directory) / relative
    if cfg.enforce_trust:
        try:
            check_trusted_path(path, want="file", must_exist=True, lstat_fn=cfg.lstat_fn)
        except TrustError as exc:
            if exc.reason == "does not exist" and exc.path in (str(path), str(directory)):
                raise OpError(REFUSED, f"{NO_ACCEPTED_NOTE}. Nothing was sent.", {"check": "NO_ACCEPTED_STATE"}) from None
            raise OpError(REFUSED, f"accepted state untrusted: {exc}. Nothing was sent.", {"check": "NO_ACCEPTED_STATE"}) from None
    try:
        fd = open_checked(path, write=False, create=False, euid=cfg.euid_fn(), what="accepted state")
    except FileNotFoundError:
        raise OpError(REFUSED, f"{NO_ACCEPTED_NOTE}. Nothing was sent.", {"check": "NO_ACCEPTED_STATE"}) from None
    except TrustError as exc:
        raise OpError(REFUSED, f"accepted state untrusted: {exc}. Nothing was sent.", {"check": "NO_ACCEPTED_STATE"}) from None
    try:
        with os.fdopen(fd, "rb") as handle:
            data = handle.read(limit + 1)
    except OSError as exc:
        raise OpError(REFUSED, f"accepted state unreadable: {exc.strerror or exc}. Nothing was sent.", {"check": "NO_ACCEPTED_STATE"}) from None
    if len(data) > limit:
        raise OpError(REFUSED, f"accepted state untrusted: {path} is larger than {limit} bytes. Nothing was sent.", {"check": "NO_ACCEPTED_STATE"})
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise OpError(REFUSED, f"accepted state invalid: {path} is not UTF-8. Nothing was sent.", {"check": "NO_ACCEPTED_STATE"}) from None


#: G-148 (D-044): what to do with an accepted state that is still a chain (several ``profile =`` lines, applied in order before D-044).
CHAIN_HINT = (
    "run 'sudo python3 -I tools/linux-xtu.py accepted-migrate' once: it builds one complete profile from EXPECTED-words.txt (never from a read) and keeps a backup"
)


def _accepted_paths(helper: Helper) -> list[str]:
    """The ``profile =`` paths of ``accepted/CURRENT`` (validated; ``NO_ACCEPTED_STATE`` when there is none or a path is unacceptable). D-044: one is the accepted
    state; several are an older chain that only ``accepted-migrate`` reads."""
    text = _read_accepted_text(helper, "CURRENT")
    out: list[str] = []
    for rel in current_profile_lines(text):
        if not _ACCEPTED_PATH_RE.fullmatch(rel) or ".." in rel or not rel.endswith(".toml"):
            raise OpError(REFUSED, f"accepted CURRENT names an unacceptable profile path {rel!r}. Nothing was sent.", {"check": "NO_ACCEPTED_STATE"})
        out.append(rel)
    if not out:
        raise OpError(REFUSED, "accepted CURRENT lists no profile. Nothing was sent.", {"check": "NO_ACCEPTED_STATE"})
    return out


def _accepted_profile(helper: Helper) -> tuple[str, Profile]:
    """``(name, profile)`` of the one accepted profile (the name is the file stem). An older chain is refused (``ACCEPTED_CHAIN``): D-044 never replays a chain."""
    paths = _accepted_paths(helper)
    if len(paths) > 1:
        names = ", ".join(Path(p).stem for p in paths)
        raise OpError(
            REFUSED,
            f"the accepted state is an older chain of {len(paths)} profiles ({names}); the accepted state is now one complete profile (D-044): {CHAIN_HINT}. Nothing was sent.",
            {"check": "ACCEPTED_CHAIN"},
        )
    rel = paths[0]
    try:
        return Path(rel).stem, load_profile(_read_accepted_text(helper, rel))
    except ProfileError as exc:
        raise OpError(REFUSED, f"accepted profile {rel} is invalid: {exc}. Nothing was sent.", {"check": "NO_ACCEPTED_STATE"}) from None


def _accepted_names(helper: Helper) -> list[str]:
    """The names ``CURRENT`` lists (one, or the members of an older chain); empty when there is no accepted state."""
    try:
        return [Path(p).stem for p in _accepted_paths(helper)]
    except OpError:
        return []


def _check_complete(helper: Helper, profile: Profile, topology: Topology) -> None:
    """G-148: a complete profile is refused on another CPU (``PROFILE_TOPOLOGY``): every unit of the live topology must be in it, and each unit's recorded top fused ratio
    must be the one this boot's read found (``0x09``; units not read are judged by the planner from the apply's own read)."""
    if not profile.complete:
        return
    try:
        profile.check_complete(topology)
    except ProfileError as exc:
        raise OpError(REFUSED, f"{exc}. Nothing was sent.", {"check": "PROFILE_TOPOLOGY"}) from None
    fused = getattr(helper, "fused_words", None) or {}
    for e in profile.entries:
        cpu = topology.resolve(e.kind, e.index).cpu
        unit = topology.unit_of_cpu(cpu)
        word = next((fused[c] for c in topology.unit_cpus(unit) if c in fused), None)
        top = fused_top_ratio(word)
        if top is not None and e.fused_top_ratio is not None and top != e.fused_top_ratio:
            raise OpError(
                REFUSED,
                f"{unit} reads top fused ratio {top} (0x09) but the complete profile was made where it was {e.fused_top_ratio}: it belongs to another CPU. Nothing was sent.",
                {"check": "PROFILE_TOPOLOGY"},
            )


def _profile_store(helper: Helper) -> ProfileStore:
    cfg = helper.cfg
    return ProfileStore(Path(cfg.audit_path).parent / "profiles", euid=cfg.euid_fn(), wall_clock=cfg.wall_clock)


# --------------------------------------------------------------------------------------------------------------
# Intent -> Profile
# --------------------------------------------------------------------------------------------------------------
@dataclass
class Resolved:
    profile: Profile
    refs: dict[tuple[int, int], int]
    warnings: list[str]
    units: list[str]
    ring_refs: dict[int, int] = field(default_factory=dict)  # G-212: ring point (P2) -> the word of the last ring read the intent was built from (PLAN_STALE at apply)


def _no_read(unit: str, why: str) -> OpError:
    return OpError(REFUSED, f"{unit}: {why}; run 'Read tuning words' (tune.read) first. Nothing was sent.", {"check": "NO_READ"})


def _ratio_cap(helper: Helper, policy: Policy, kind: str) -> tuple[int | None, str]:
    """The CPU's own ratio limit of a kind at plan time and where it comes from (G-137, D-039, D-049): ``0x01 [7:0]`` of the ``tune.read`` of this boot that ``policy`` is bound to.
    ``None`` = not known (the text names the read): the apply reads it itself and its guard judges the word."""
    return ratio_limit(policy, kind)


def _check_range(policy: Policy, unit: str, cpus: Sequence[int], row: Mapping[str, Any], ratio_cap: tuple[int | None, str] | None = None) -> None:
    """``REFUSED POLICY_RANGE`` naming the field, the limit and where the limit comes from (the CPU's own register, or the field encoding), before anything else is computed. D-049: the
    only bounds are the 11-bit offset field, the CPU's voltage limit (``0x28``) and ratio limit (``0x01``) when this boot's ``tune.read`` got them; an unread limit is the apply's to
    read (and its guard refuses a raise without it: ``CPU_LIMIT_UNREAD``)."""
    kind = _kind_of(unit)

    def refuse(text: str) -> OpError:
        return OpError(REFUSED, f"{text}. Nothing was sent.", {"check": "POLICY_RANGE"})

    offset = row["offset"]
    if offset is not None:
        values = [offset["mv"]] if offset["kind"] == "curve" else list(offset["mv"].values())
        for mv in values:
            try:
                VfWord.mv_to_offset_raw(mv)
            except ValueError:
                raise refuse(
                    f"{unit}: offset {mv:+d} mV does not fit the 11-bit offset field (registers.md V/F data word: {ENCODING_OFFSET_FLOOR_MV}..{ENCODING_OFFSET_CEILING_MV} mV)"
                ) from None
    v = row["v_target_v"]
    if v is not None:
        mv = round(v * 1000)
        cap_raw, text = v_target_limit(policy, kind, None)  # the 0x28 limit comes from the policy binding (tune.read); the guard judges the word of the session when applied
        if cap_raw is not None and VfWord.v_to_raw(mv / 1000) > cap_raw:
            raise refuse(f"{unit}: OC-point voltage {mv} mV is above {text}")
    ratio = row["ratio"]
    if ratio is not None and ratio_cap is not None:
        cap, text = ratio_cap
        if cap is not None and ratio > cap:
            raise refuse(f"{unit}: ratio {ratio} is above {text}")


def _rows_to_profile(helper: Helper, intent: Mapping[str, Any], policy: Policy, topology: Topology, name: str) -> Resolved:
    last = _last_words(helper)
    warnings: list[str] = []
    cores: dict[tuple[str, int], dict[str, int | None]] = {}
    points: dict[tuple[str, int, int], PointSetting] = {}
    refs: dict[tuple[int, int], int] = {}
    units: list[str] = []
    groups = groups_of(topology)
    for row in intent.get("rows", ()):
        targets = groups[row["target"]] if row["target"] in groups else (row["target"],)
        for unit in targets:
            try:
                cpus = unit_cpus(topology, unit)
            except UnknownCore:
                raise OpError(BAD_REQUEST, f"{unit} is not a unit of this system (units: {', '.join(topology.unit_ids())})") from None
            _check_range(policy, unit, cpus, row, _ratio_cap(helper, policy, _kind_of(unit)))
            if row["v_target_v"] is not None and row["offset"] is not None and row["offset"]["kind"] == "curve" and row["offset"]["mv"] != 0:
                # D-053 item 6 / R-06: an OC target and a whole-curve offset in one word is the "target + offset" OC-voltage mode; only the adaptive target is offered
                # until it is measured (assessment 05 section 3.6: whether the offset moves the target is not known)
                raise OpError(REFUSED, f"{unit}: an OC-point voltage together with a whole-curve offset ({row['offset']['mv']:+d} mV) in one row is the 'target + offset' OC-voltage "
                              "mode, which is not offered (D-053 item 6: what the offset does to the target is not measured). Plan the voltage and the offset separately. Nothing was sent.",
                              {"check": "OC_MODE_NOT_OFFERED", "key": f"{unit}.v_target_v"})
            core = topology.by_cpu(cpus[0])
            known = {c: last[c] for c in cpus if last and c in last and last[c]}
            vals: dict[str, int | None] = {"ratio": row["ratio"], "oc_voltage_mv": None if row["v_target_v"] is None else round(row["v_target_v"] * 1000), "offset_mv": None}
            offset = row["offset"]
            if offset is not None and offset["kind"] == "curve":
                vals["offset_mv"] = offset["mv"]
            touched = False
            if any(v is not None for v in vals.values()):
                cores[(core.kind, core.index)] = vals
                touched = True
                for c, ws in known.items():
                    refs[(c, 0)] = ws[0]
            if offset is not None and offset["kind"] == "points":
                if not known:
                    raise _no_read(unit, "per-point offsets are addressed by ratio and no words of this unit were read")
                first = next(iter(known))
                words = known[first]
                top = fused_top_ratio(helper.fused_words.get(first))
                by_ratio = {
                    VfWord.from_u32(w).ratio: n for n, w in enumerate(words[1:], start=1) if top is None or VfWord.from_u32(w).ratio <= top
                }  # the OC point (a ratio above the top fused ratio) is not a fused point
                missing = [r for r in offset["mv"] if int(r) not in by_ratio]
                for r, mv in offset["mv"].items():
                    n = by_ratio.get(int(r))
                    if n is None:
                        continue
                    points[(core.kind, core.index, n)] = PointSetting(core.kind, core.index, n, mv, int(r))
                    touched = True
                    for c, ws in known.items():
                        if len(ws) > n:
                            refs[(c, n)] = ws[n]
                if missing:
                    have = ", ".join(str(r) for r in sorted(by_ratio))
                    text = f"{unit} has no V/F point at ratio {', '.join(missing)} (points of the last read: {have})"
                    if intent["scope"] == "unit":
                        raise OpError(BAD_REQUEST, text, {"check": "NO_SUCH_POINT", "key": f"{unit}.points.{missing[0]}"})
                    warnings.append(text + "; skipped")
            if touched and unit not in units:
                units.append(unit)
    turbo = _explicit_turbo(helper, intent["turbo"], policy, warnings) if "turbo" in intent else None  # D-050: a table is written only when the intent names it
    ring = _ring_setting(helper, intent["ring"], policy, topology) if "ring" in intent else None  # G-212
    ring_refs: dict[int, int] = {}
    if ring is not None:
        units.append(ringmod.UNIT)
        last_ring = _last_ring(helper) or ()
        ring_refs = {rp.point: int(last_ring[rp.point]) for rp in ring.points}
    try:
        entries = tuple(CoreSetting(k, i, **v) for (k, i), v in cores.items())  # type: ignore[arg-type]
        profile = Profile(name, entries, turbo, tuple(points.values()), ring=ring)  # G-119: a turbo-only plan has no entries and no points; G-212: a ring-only plan has neither
    except ProfileError as exc:
        raise OpError(BAD_REQUEST, f"intent is not a valid profile: {exc}") from None
    return Resolved(profile, refs, warnings, units, ring_refs)


def _check_ring_range(policy: Policy, topology: Topology, points: Mapping[str, int]) -> None:
    """``REFUSED POLICY_RANGE`` before anything else is computed (G-212): every ring point must have a policy ``0x11 P1=2`` write entry (an access list), and its offset must fit the
    11-bit field and the entry's optional ``offset_raw_min`` / ``_max`` (what the guard evaluates in ``_check_vf_point_offset_bounded``; D-049: no policy window on top)."""

    def refuse(text: str) -> OpError:
        return OpError(REFUSED, f"{text}. Nothing was sent.", {"check": "POLICY_RANGE"})

    for key, mv in points.items():
        p2 = int(key)
        entry = policy.match(int(Cmd.VOLTAGE_FREQ_WRITE), ringmod.RING_P1, p2)
        if entry is None or entry.kind != "write":
            raise refuse(f"ring point {p2}: the helper's mailbox command allowlist has no write entry for cmd 0x11 P1=2 P2={p2} ({policy.where})")
        try:
            raw = VfWord.mv_to_offset_raw(mv)
        except ValueError:
            raise refuse(f"ring point {p2}: offset {mv:+d} mV does not fit the 11-bit offset field ({ENCODING_OFFSET_FLOOR_MV}..{ENCODING_OFFSET_CEILING_MV} mV)") from None
        low, high = entry.params.get("offset_raw_min", -1024), entry.params.get("offset_raw_max", 1023)
        if not low <= raw <= high:
            raise refuse(f"ring point {p2}: offset {mv:+d} mV (raw {raw}) is outside the mailbox allowlist entry {entry.name!r} window {low * 1000 / 1024:+.1f}..{high * 1000 / 1024:+.1f} mV ({policy.where})")


def _ring_setting(helper: Helper, asked: Mapping[str, Any], policy: Policy, topology: Topology) -> RingSetting:
    """G-212 (D-045): the ``[ring]`` of an intent's ``ring: {points: {P2: mV}}``, from this boot's last ring read: the ring OC word as read (compared by the planner with the live
    word and **never written**: a changed word refuses the ring unit alone) and, for every asked point, its offset with ``expect_ratio`` = the ratio the read found there. Offset-only; keyed
    by the P2 point number (not by ratio like a core's points)."""
    points: Mapping[str, int] = asked["points"]
    _check_ring_range(policy, topology, points)
    last = _last_ring(helper)
    if not last:
        raise _no_read(ringmod.UNIT, "the ring points are addressed by number and the ring was not read this boot")
    missing = [k for k in points if int(k) >= len(last)]
    if missing:
        raise OpError(BAD_REQUEST, f"the ring has no point {', '.join(missing)} (ring points of the last read: 1..{len(last) - 1})",
                      {"check": "NO_SUCH_POINT", "key": f"ring.points.{missing[0]}"})
    try:
        return RingSetting(last[0], tuple(RingPoint(int(k), mv, VfWord.from_u32(last[int(k)]).ratio) for k, mv in points.items()))
    except ProfileError as exc:
        raise OpError(BAD_REQUEST, f"intent is not a valid profile: {exc}") from None


def _explicit_turbo(helper: Helper, asked: Mapping[str, Sequence[int]], policy: Policy, warnings: list[str]) -> TurboTables:
    """The tables the intent names (``turbo: {P, E}``) and only those (D-050: an OC ratio never derives a table). Range-checked against the policy
    (``REFUSED POLICY_RANGE``); the order rule F5 is a plan warning (:func:`_turbo_shape_warnings`) on the finished profile, no longer a refusal (D-049)."""
    st = _state(helper)
    with st.lock:
        tables = st.tables
    out: dict[str, tuple[int, ...] | None] = {"e": None, "p": None}
    for kind, ratios in asked.items():
        cap, text = _ratio_cap(helper, policy, kind)
        if cap is not None and max(ratios) > cap:
            raise OpError(REFUSED, f"turbo.{kind}: ratio {max(ratios)} is above {text}. Nothing was sent.", {"check": "POLICY_RANGE"})
        msr = "0x650" if kind == "E" else "0x1AD"
        current = None if tables is None else tables.get(kind.lower())
        out[kind.lower()] = tuple(ratios)
        if current is None:
            warnings.append(f"the {kind} turbo table (MSR {msr}) was not read this boot: run 'Read tuning words' so the apply can compare it")
        elif any(n > o for n, o in zip(ratios, current)):
            raised = ", ".join(str(k + 1) for k, (n, o) in enumerate(zip(ratios, current)) if n > o)
            warnings.append(Warn("TURBO_RAISE", f"the {kind} turbo table ({msr}) is RAISED in bucket(s) {raised} (package-wide)"))
    return TurboTables(e=out["e"], p=out["p"])


def _reset_profile(helper: Helper, topology: Topology) -> Resolved:
    last = _last_words(helper)
    cores: dict[tuple[str, int], dict[str, int | None]] = {}
    points: dict[tuple[str, int, int], PointSetting] = {}
    refs: dict[tuple[int, int], int] = {}
    units: list[str] = []
    warnings: list[str] = []
    for unit in topology.unit_ids():
        cpus = unit_cpus(topology, unit)
        ref = _unit_reference(last, cpus)
        if ref is None:
            raise _no_read(unit, "reset needs the words in force and none of this unit's CPUs were read")
        _, words = ref
        core = topology.by_cpu(cpus[0])
        changed = False
        if VfWord.from_u32(words[0]).offset_raw != 0:
            cores[(core.kind, core.index)] = {"ratio": None, "oc_voltage_mv": None, "offset_mv": 0}
            changed = True
        for n, w in enumerate(words[1:], start=1):
            vf = VfWord.from_u32(w)
            if vf.offset_raw != 0:
                points[(core.kind, core.index, n)] = PointSetting(core.kind, core.index, n, 0, vf.ratio)
                changed = True
        if changed:
            units.append(unit)
            for c in cpus:
                if last and c in last:
                    for n, w in enumerate(last[c]):
                        refs[(c, n)] = w
    if not cores and not points:
        raise OpError(BAD_REQUEST, "every offset of the last read is already 0: nothing to reset", {"check": "NOTHING_TO_DO"})
    warnings.append(
        "reset zeroes the OC-word offset and every V/F point offset; the OC ratio, the OC-point V target and the turbo tables are not changed "
        "(a zero field cannot be written back; a cold boot restores them)"
    )
    return Resolved(Profile("reset-stock", tuple(CoreSetting(k, i, **v) for (k, i), v in cores.items()), None, tuple(points.values())), refs, warnings, units)  # type: ignore[arg-type]


def _profile_resolved(helper: Helper, profile: Profile, topology: Topology, warnings: list[str]) -> Resolved:
    """A ready-made Profile (accepted state): no words are assumed, ``expect_ratio`` of every point guards the write."""
    units: list[str] = []
    for t in resolve_targets(profile, topology) if profile.entries else ():
        u = unit_of_cpu(topology, t.cpu)
        if u not in units:
            units.append(u)
    for p in resolve_point_targets(profile, topology):
        u = unit_of_cpu(topology, p.cpu)
        if u not in units:
            units.append(u)
    if resolve_ring_targets(profile, topology):  # G-154
        units.append(ringmod.UNIT)
    if _last_words(helper) is None:
        warnings.append("no tune.read this boot: 'before' is unknown; the apply re-reads every word and the points' expect_ratio guards the writes")
    return Resolved(profile, {}, warnings, units)


def resolve_intent(helper: Helper, intent: dict[str, Any], policy: Policy, topology: Topology) -> Resolved:
    if "rows" in intent or "turbo" in intent or "ring" in intent:
        digest = hashlib.sha256(json.dumps(intent, sort_keys=True).encode()).hexdigest()[:8]
        return _rows_to_profile(helper, intent, policy, topology, f"tune-{digest}")
    if "reset" in intent:
        return _reset_profile(helper, topology)
    if "restore" in intent:
        name, prof = _accepted_profile(helper)
        _check_complete(helper, prof, topology)
        how = "complete: only the words that differ from what the CPU holds are written" if prof.complete else "partial (accepted before G-148): its own entries only"
        return _profile_resolved(helper, prof, topology, [f"restore applies the accepted profile {name} ({how})"])
    name = intent["profile"]
    try:
        acc_name, acc = _accepted_profile(helper)
    except OpError:
        acc_name, acc = None, None
    if acc is not None and acc_name == name:
        _check_complete(helper, acc, topology)
        return _profile_resolved(helper, acc, topology, [f"accepted profile {name}"])
    try:
        record = _profile_store(helper).load(name)
    except ProfileStoreError as exc:
        raise OpError(BAD_REQUEST if exc.code == "NOT_FOUND" else REFUSED, exc.message, {"check": "PROFILE_" + exc.code}) from None
    prof = _saved_profile(record)
    if prof is not None:
        _check_complete(helper, prof, topology)
        return _profile_resolved(helper, prof, topology, [f"saved profile {name} (complete: only the words that differ from what the CPU holds are written)"])
    saved = canonical_intent(record["intent"], rows_only=True)
    resolved = _rows_to_profile(helper, saved, policy, topology, name)
    resolved.warnings.insert(0, f"saved profile {name} (partial, saved before G-148: its rows are applied over what the CPU holds; since D-050 an OC ratio in it no longer raises the turbo tables)")
    return resolved


def _saved_profile(record: Mapping[str, Any]) -> Profile | None:
    """The complete profile of a saved record (G-148), or ``None`` for a legacy ``{intent}`` record; ``REFUSED PROFILE_INVALID`` when the stored text does not load."""
    text = record.get("profile")
    if not isinstance(text, str):
        return None
    try:
        return load_profile(text if "\n" in text else text + "\n")
    except ProfileError as exc:
        raise OpError(REFUSED, f"saved profile {record.get('name')!r} is invalid: {exc}. Nothing was sent.", {"check": "PROFILE_INVALID"}) from None


def canonical_hash(value: Any) -> str:
    """R-B1: sha256[:16] of the canonical JSON of ``value`` (sorted keys, no spaces): the ``intent_hash`` / ``state_hash`` of a plan."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()[:16]


def intent_diff(planned: Any, now: Any, path: str = "", limit: int = 3) -> list[str]:
    """R-B1 (R-26): where two intents differ, as ``"path: planned X, now Y"`` lines (at most ``limit``): the text of ``PLAN_STALE INTENT_CHANGED``."""
    out: list[str] = []
    if isinstance(planned, Mapping) and isinstance(now, Mapping):
        for key in sorted(set(planned) | set(now), key=str):
            out += intent_diff(planned.get(key), now.get(key), f"{path}.{key}" if path else str(key), limit - len(out))
            if len(out) >= limit:
                break
        return out
    if isinstance(planned, list) and isinstance(now, list) and len(planned) == len(now):
        for i, (a, b) in enumerate(zip(planned, now)):
            out += intent_diff(a, b, f"{path}[{i}]", limit - len(out))
            if len(out) >= limit:
                break
        return out
    if planned != now and limit > 0:
        return [f"{path or 'intent'}: planned {json.dumps(planned)}, now {json.dumps(now)}"]
    return []


def intent_changed(planned: Mapping[str, Any] | None, now: Mapping[str, Any]) -> OpError | None:
    """R-B1 (R-26 / F-05): ``PLAN_STALE`` (check ``INTENT_CHANGED``) when the intent an apply was given is not the one the plan was made from: the edits changed after the
    Review, so the plan would write values that are no longer on screen. ``None`` when they are equal (canonical form)."""
    if planned is None or dict(planned) == dict(now):
        return None
    diffs = intent_diff(dict(planned), dict(now))
    return OpError(PLAN_STALE, "the edits changed since the plan was made (" + "; ".join(diffs or ["the intent differs"]) + "); nothing was written. Review again.",
                   {"check": "INTENT_CHANGED", "writes_sent": 0})
