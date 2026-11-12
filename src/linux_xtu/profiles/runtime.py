"""R-B1 (D-053 item 7): the runtime sections of a profile (schema 2) -- package power limits, per-unit ratio caps, uncore ratio limits -- from the values in force, and back.

Pure: plain numbers in, :class:`~linux_xtu.profiles.schema.PowerSetting` / ``CapsSetting`` / ``UncoreSetting`` out; the helper reads the files (powercap, cpufreq,
``intel_uncore_frequency``) and passes the numbers. A value the profile format cannot hold exactly (a power limit that is not whole watts, an uncore limit that is not
whole 100 MHz, an E cluster whose CPUs hold different caps) is **not captured**, with a note -- never rounded or invented: absent means "left as it is" when applied.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .schema import CapsSetting, PowerSetting, Profile, ProfileError, UncoreSetting

__all__ = ["caps_of", "power_of", "runtime_differences", "uncore_of"]

_UW_PER_W = 1_000_000
_KHZ_PER_RATIO = 100_000


def power_of(pl1_uw: int | None, pl2_uw: int | None, tau_us: int | None) -> tuple[PowerSetting | None, str | None]:
    """The ``[power]`` of the powercap values in force (uW, us), or ``(None, why)``."""
    if pl1_uw is None and pl2_uw is None and tau_us is None:
        return None, "power limits not captured: the powercap zone was not read"
    values: dict[str, Any] = {}
    for key, uw in (("pl1_w", pl1_uw), ("pl2_w", pl2_uw)):
        if uw is None:
            continue
        if uw % _UW_PER_W:
            return None, f"power limits not captured: {key[:3].upper()} is {uw} uW, not a whole number of watts (a profile records whole watts)"
        values[key] = uw // _UW_PER_W
    if tau_us is not None and tau_us > 0:
        values["tau_s"] = tau_us / _UW_PER_W
    try:
        return PowerSetting(**values), None
    except ProfileError as exc:
        return None, f"power limits not captured: {exc}"


def caps_of(unit_ratios: Mapping[str, Sequence[int | None]]) -> tuple[CapsSetting | None, list[str]]:
    """The ``[caps]`` of the caps in force: ``unit_ratios`` = unit id -> the ratio each of its CPUs' cap holds (``None`` = a CPU without cpufreq files, e.g. offline). A unit
    whose CPUs disagree (an E cluster runs one ratio) or that has a CPU without a cap is left out with a note."""
    out: list[tuple[str, int]] = []
    notes: list[str] = []
    for unit, ratios in unit_ratios.items():
        if not ratios or any(r is None for r in ratios):
            notes.append(f"{unit}: cap not captured (a CPU of it has no cpufreq cap to read)")
            continue
        if len(set(ratios)) != 1:
            notes.append(f"{unit}: cap not captured (its CPUs hold different caps: {sorted(set(ratios))})")  # type: ignore[type-var]
            continue
        out.append((unit, int(ratios[0])))  # type: ignore[arg-type]
    if not out:
        return None, notes or ["ratio caps not captured"]
    return CapsSetting(tuple(out)), notes


def uncore_of(min_khz: int | None, max_khz: int | None) -> tuple[UncoreSetting | None, str | None]:
    """The ``[uncore]`` of the limits in force (kHz), or ``(None, why)``."""
    if min_khz is None or max_khz is None:
        return None, "uncore limits not captured: intel_uncore_frequency was not read"
    if min_khz % _KHZ_PER_RATIO or max_khz % _KHZ_PER_RATIO:
        return None, f"uncore limits not captured: {min_khz} / {max_khz} kHz are not whole ratios (100 MHz)"
    try:
        return UncoreSetting(min_khz // _KHZ_PER_RATIO, max_khz // _KHZ_PER_RATIO), None
    except ProfileError as exc:
        return None, f"uncore limits not captured: {exc}"


def runtime_differences(profile: Profile, power: PowerSetting | None, caps: CapsSetting | None, uncore: UncoreSetting | None) -> dict[str, list[str]]:
    """``{"power": [...], "runtime": [...]}``: each value the profile holds that the values in force (as captured now) do not, as ``"<what>: <now> now, <profile> in the profile"``.
    A section the profile does not hold is not compared (left as it is); a value that could not be captured now differs ("not readable now")."""
    out: dict[str, list[str]] = {"power": [], "runtime": []}
    if profile.power is not None:
        now = {} if power is None else power.intent()
        for key, want in profile.power.intent().items():
            have = now.get(key)
            if have is None or (abs(float(have) - float(want)) > 1e-6):
                out["power"].append(f"{key}: {'not readable' if have is None else have} now, {want} in the profile")
    if profile.caps is not None:
        now_caps = {} if caps is None else caps.as_dict()
        for unit, want in profile.caps.units:
            if now_caps.get(unit) != want:
                out["runtime"].append(f"cap {unit}: {now_caps.get(unit, 'not readable')} now, {want} in the profile")
    if profile.uncore is not None:
        now_u = {} if uncore is None else uncore.intent()
        for key, want in profile.uncore.intent().items():
            if now_u.get(key) != want:
                out["runtime"].append(f"uncore {key}: {now_u.get(key, 'not readable')} now, {want} in the profile")
    return out
