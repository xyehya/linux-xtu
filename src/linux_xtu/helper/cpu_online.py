"""G-216 / D-048: the offline-CPU guard, shared by the helper and the CLI (R-B3, assessment 05 B-15). Core parking is held out of this app, but an operator
(or a power daemon) can still take a CPU offline: ``cpu<N>/online`` reads 0 and the live topology (``cpu_core/cpus``, ``cpu_atom/cpus``) loses it, which
renumbers the P indices and can leave the E clusters unequal. Every op that numbers things by that topology (``tune.apply``, ``vf.measure``, ``stress.start``,
``runtime.plan`` / ``runtime.apply`` -- a runtime *revert* excepted: it restores per-CPU files by number, skips an offline CPU and says so) and the CLI's
``apply --device`` refuse, naming the CPUs, while one reads 0.

**Fail closed** (B-15): "cannot tell" is a refusal too (``CPU_ONLINE_UNKNOWN``): an unreadable or malformed ``online`` file, no ``cpu<N>`` directory at all,
a hardware helper without its runtime sysfs. A missing ``online`` file is not "cannot tell": the kernel has none for a CPU it cannot take offline (cpu0 on
x86), so that CPU is online. A simulator without a runtime model has no offline CPU by construction. Reads only.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .protocol import REFUSED, OpError

__all__ = ["CPU_ROOT", "CpuOnlineUnknown", "offline_cpus", "offline_cpus_in", "offline_problem", "refuse_if_cpu_offline", "unknown_problem"]

CPU_ROOT = Path("/sys/devices/system/cpu")
_CPU_DIR = re.compile(r"cpu(\d+)")


class CpuOnlineUnknown(Exception):
    """Whether every CPU is online cannot be told; the caller refuses (fail closed)."""


def offline_cpus_in(listdir: Callable[[str], list[str]], read_int: Callable[[str], int | None]) -> list[int]:
    """The CPUs whose ``cpu<N>/online`` reads 0 (sorted), from a runtime-files view (``controls.caps.RuntimeFiles`` or the simulator's: names relative to
    ``/sys/devices/system/cpu``, ``read_int`` ``None`` for an absent file). :class:`CpuOnlineUnknown` when it cannot be told."""
    try:
        names = listdir("")
    except Exception as exc:
        raise CpuOnlineUnknown(f"the CPU directory cannot be listed ({exc})") from None
    cpus = sorted(int(m.group(1)) for name in names if (m := _CPU_DIR.fullmatch(name)))
    if not cpus:
        raise CpuOnlineUnknown("the CPU directory lists no cpu<N> entry")
    offline = []
    for cpu in cpus:
        try:
            value = read_int(f"cpu{cpu}/online")
        except Exception as exc:
            raise CpuOnlineUnknown(f"cpu{cpu}/online cannot be read ({exc})") from None
        if value is None:
            continue  # no such file: the kernel cannot take this CPU offline
        if value == 0:
            offline.append(cpu)
        elif value != 1:
            raise CpuOnlineUnknown(f"cpu{cpu}/online reads {value}, neither 0 nor 1")
    return offline


def offline_cpus(helper: Any) -> list[int]:
    """:func:`offline_cpus_in` over the helper's runtime wiring (sysfs on hardware, the simulator's files under ``--sim``). :class:`CpuOnlineUnknown` when it
    cannot be told; a simulator with no runtime model answers ``[]``."""
    from .ops_runtime import _wiring  # lazy: ops_runtime imports ops_tune_apply, which imports this module

    try:
        files = _wiring(helper).files
    except OpError as exc:
        if helper.cfg.simulator:
            return []  # a simulator without a runtime model: every simulated CPU is online by construction
        raise CpuOnlineUnknown(f"the runtime sysfs is not available ({exc.message})") from None
    return offline_cpus_in(files.listdir, files.read_int)


def offline_problem(offline: list[int], what: str) -> str:
    """The refusal text for offline CPUs (helper and CLI say the same)."""
    names = ", ".join(f"cpu {c}" for c in offline)
    one = len(offline) == 1
    return (
        f"{names} {'is' if one else 'are'} offline (cpu<N>/online reads 0), not by this app: the CPU topology the offsets, caps and units are numbered by has changed. "
        f"Bring {'it' if one else 'them'} back online (echo 1 > /sys/devices/system/cpu/cpuN/online) or reboot, then {what} again. Nothing was written."
    )


def unknown_problem(exc: CpuOnlineUnknown, what: str) -> str:
    return (
        f"whether every CPU is online cannot be told: {exc}. An offline CPU would renumber the cores the offsets are written to (D-048), so {what} is refused "
        "until /sys/devices/system/cpu reads cleanly. Nothing was written."
    )


def refuse_if_cpu_offline(helper: Any, op: str) -> None:
    """Raise ``REFUSED`` (``check = CPU_OFFLINE``, or ``CPU_ONLINE_UNKNOWN`` when it cannot be told) when a CPU is offline; nothing has been done by ``op`` yet."""
    try:
        offline = offline_cpus(helper)
    except CpuOnlineUnknown as exc:
        raise OpError(REFUSED, unknown_problem(exc, op), {"check": "CPU_ONLINE_UNKNOWN"}) from None
    if offline:
        raise OpError(REFUSED, offline_problem(offline, op), {"check": "CPU_OFFLINE", "cpus": offline})
