"""Everything the helper needs from the outside world, injectable: tests pass fakes, ``linux_xtu.helper.main`` passes the real ones."""
from __future__ import annotations

import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from linux_xtu.guard import read_boot_id
from linux_xtu.msr import MsrPort
from linux_xtu.platform.preflight import PreflightReport
from linux_xtu.topology import Topology

__all__ = [
    "HEARTBEAT_S", "HelperConfig", "INSTALLED_ACCEPTED_DIR", "INSTALLED_AUDIT", "INSTALLED_CODE_DIR", "INSTALLED_HELPER", "INSTALLED_HELPER_TOML",
    "INSTALLED_LOCK", "INSTALLED_LOCK_DIR", "INSTALLED_PLATFORMS_DIR", "INSTALLED_POLICY", "INSTALLED_SOCKET", "INSTALLED_STATE_DIR",
]

from linux_xtu.paths import (  # the installed layout (SPEC 4.4 / 11, D-030), defined once in linux_xtu.paths
    INSTALLED_ACCEPTED_DIR,
    INSTALLED_AUDIT,
    INSTALLED_CODE_DIR,
    INSTALLED_HELPER,
    INSTALLED_HELPER_TOML,
    INSTALLED_LOCK,
    INSTALLED_LOCK_DIR,
    INSTALLED_PLATFORMS_DIR,
    INSTALLED_POLICY,
    INSTALLED_SOCKET,
    INSTALLED_STATE_DIR,
)

HEARTBEAT_S = 2.0  # contract 8
HealthGate = Callable[[str], tuple[bool, str]]


@dataclass
class HelperConfig:
    """``lock_path`` has no default on purpose: the launcher chooses it (``linux_xtu.paths.default_lock_path()``, which returns ``INSTALLED_LOCK`` on an installed machine), tests use a temp file.

    ``simulator``: the port is the simulator (no hardware), so the preflight write gate is not applied and ``vf.dump`` runs on a virtual clock
    (dwell is honoured in virtual time, as the CLI's ``--sim`` does). With ``simulator=False`` every op marked ``write`` first needs a fresh
    preflight in mode ``write`` with no ``UNKNOWN`` check (D-027 c), a health gate, and the dwell is real.
    """

    lock_path: Path
    audit_path: Path
    policy_path: Path | None  # None: the built-in conservative M1 policy (simulator and tests only; the launcher requires a file for hardware)
    port_factory: Callable[[], MsrPort]
    topology_fn: Callable[[], Topology]
    preflight_fn: Callable[[], PreflightReport]
    sampler_factory: Callable[[float], Any]  # interval_s -> object with start() / stop() / snapshot() (linux_xtu.telemetry.Sampler)
    simulator: bool = True
    accepted_dir: Path | None = None  # root-owned accepted state (``EXPECTED-words.txt`` inside); None = no accepted-state compare (simulator, tests)
    cpuinfo_path: Path | None = None  # G-138: where profiles.accept reads the CPU's family / model / brand for fingerprint.json (``/proc/cpuinfo`` on hardware; None = not recorded)
    enforce_trust: bool = False  # SPEC 4.4 path checks on policy and audit paths; the launcher turns it on for hardware
    lstat_fn: Callable[[str], Any] = os.lstat
    euid_fn: Callable[[], int] = getattr(os, "geteuid", lambda: 0)  # who must own every file the helper opens for writing (root on hardware)
    health_gate_factory: Callable[[], HealthGate | None] = lambda: None
    boot_id_fn: Callable[[], str | None] = read_boot_id
    wall_clock: Callable[[], float] = time.time
    monotonic: Callable[[], float] = time.monotonic
    sleep: Callable[[float], object] = time.sleep  # the mailbox transport's poll sleep on hardware (never the cancel-aware one)
    heartbeat_s: float = HEARTBEAT_S
    operator: str = "helper"  # recorded in the audit log; "gui:uid<N>" of the connected socket peer per connection (D-043)
    extra_ops: Mapping[str, Any] = field(default_factory=dict)  # tests: stub ops (OpSpec) registered next to the built-in ones
    log: Callable[[str], None] = lambda text: None  # stderr in production
