"""Unattended boot restore of the accepted state, with a crash-loop guard (D-053 item 3: signs D-021 for this form only; SPEC 10; assessment 06 F1).

Installed as ``/usr/lib/linux-xtu/linux-xtu-restore`` (``#!/usr/bin/python3 -I``, root-owned, run only from the installed tree) and started by
``linux-xtu-restore.timer`` -> ``linux-xtu-restore.service`` (``ExecStart=... run``). Disabled by default: ``install.sh --enable-boot-restore`` enables the
timer and arms it. Commands::

    linux-xtu-restore run                 the unit's ExecStart: the EXPLICIT UNATTENDED PATH (audit operator "boot-restore:unattended")
    linux-xtu-restore arm                 root: accept the current /etc/linux-xtu/accepted for the boot restore (records its sha256 and the CPU identity)
    linux-xtu-restore disarm [--reason T] root: stop applying at boot until the next arm
    linux-xtu-restore status [--json]     the state (anyone may read it: /var/lib/linux-xtu/bootrestore.json is 0644, it holds no secret)

**How it applies (no second encoder, no MSR code here).** ``run`` starts the root helper's own dispatcher in this process (``Helper.run`` on a pipe pair,
driven through ``linux_xtu.client.HelperLink``): ``preflight`` -> ``tune.plan {"restore": "accepted"}`` -> ``tune.apply`` -> ``tune.read``, exactly the requests the
desktop app's "Restore accepted" sends, through the same validators, state machine, preflight write gate, guard (policy, one transaction at a time, read-back),
audit log and machine-wide instance lock (a running socket helper makes this a skip, never a second mailbox user). There is no interactive prompt to answer:
the plan's nonce is the plan binding of the helper protocol, the unattended consent is the operator's ``arm`` (a root act) plus the enabled timer, and every
guard record of the run carries the operator ``boot-restore:unattended``. The verdict is the helper's word-for-word compare (``accepted_match`` of ``tune.read``).

**Crash-loop guard (fail closed).** The state file ``/var/lib/linux-xtu/bootrestore.json`` (root, 0644, written atomically) holds::

    {"schema": 1, "armed": true, "armed_at": ISO, "armed_by": "...",
     "accepted": {"name": ..., "sha256": ...},                 # what was armed (CURRENT + profile + EXPECTED-words.txt + fingerprint.json)
     "identity": {"vendor", "family", "model", "stepping", "microcode", "brand"},   # /proc/cpuinfo when armed
     "pending": {"boot_id", "started_at", "uptime_s"} | null,   # set BEFORE the first mailbox transaction, cleared by the clean marker
     "disarmed": {"at", "boot_id", "code", "reason"} | null,
     "last": {"boot_id", "at", "outcome", "code", "text", "writes", "clean_at", "clean_how"} | null,
     "history": [the last 10 "last" records]}

Every change of the state is a read-modify-write under ``flock`` on ``/var/lib/linux-xtu/bootrestore.lock`` (:func:`update_state`): the run, ``arm`` and
``disarm`` each re-read the file inside the lock and change only their own fields, so an operator's ``disarm`` while a run watches its boot is never
overwritten (and an ``arm`` then keeps this boot's ``pending``). The clean marker is written by this same process: it stays (``Type=exec``) until the boot
counts as healthy (``healthy_uptime_s`` of RUNNING time, CLOCK_MONOTONIC, so a suspend does not count; at least :data:`MIN_WATCH_S` after the apply), or until
a stop while the system shuts down (``systemctl is-system-running`` = ``stopping``; any other stop leaves ``pending``), and then clears ``pending`` of this
boot only if this boot's kernel log holds no machine-check line and no kernel fault (Oops, ``BUG:``, a kernel GPF, soft / hard lockup, RCU stall) after the
apply. A hang, a panic or a power loss in that window leaves ``pending`` from the old boot id, and the next boot skips. The run does NOT apply and **disarms
itself** (it stays skipped until ``arm``) when: (a) ``pending`` belongs to an earlier boot; (b) this boot's kernel log, or (``previous_boot_log = "require"``)
the previous boot's, has a machine-check / hardware-error line, or cannot be read; (c) the accepted state is missing, not one complete profile, unreadable or
untrusted, has no ``fingerprint.json``, its CPU identity (vendor / family / model / brand, the live layout) does not match, stepping or microcode changed since
``arm``, or (``bind_accepted``) its sha256 is not the armed one; also on ``linux-xtu.norestore`` on the kernel command line, an unreadable config, an unknown
boot id, a refused, partial or mismatching apply (a unit missing from the read-back is a mismatch). (d) The mailbox lock, or another helper holding the
instance lock (the desktop app), is waited for (``busy_wait_s``, retried every 15 s) and then skipped WITHOUT disarming: nothing was sent. Not armed, an
unreadable state, or already run this boot: nothing is done.

Config ``/etc/linux-xtu/restore.toml`` (root-owned, optional; :class:`Config` has the defaults): ``apply_delay_s`` (60: uptime before the apply; the timer starts
the service at 30 s), ``healthy_uptime_s`` (600), ``verify`` (true), ``previous_boot_log`` ("require" | "ignore"), ``bind_accepted`` (true), ``busy_wait_s`` (300).

Exit codes: 0 applied / already in place / nothing to do; 1 usage or internal error; 2 refused or failed (disarmed); 3 skipped (crash-loop guard, not armed).
The unit is then "failed" for 1-3: ``systemctl --failed`` and ``journalctl -u linux-xtu-restore`` show it.

**Hooks for the desktop app** (a future helper op; the helper's ops are not changed here): :func:`status_doc`, :func:`arm` and :func:`disarm` take an
:class:`Env` (installed paths by default) and return the state document; ``arm`` is the act a nonce-confirmed op would wrap.
"""
from __future__ import annotations

import argparse
import contextlib
import dataclasses
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import tomllib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO

from linux_xtu import __version__
from linux_xtu.guard import read_boot_id
from linux_xtu.helper.config import INSTALLED_ACCEPTED_DIR, INSTALLED_AUDIT, INSTALLED_LOCK, INSTALLED_POLICY, INSTALLED_STATE_DIR
from linux_xtu.helper.ops import PROTOCOL
from linux_xtu.helper.trust import TrustError, check_code_tree, check_trusted_path, open_checked
from linux_xtu.profiles import Profile, ProfileError, load_profile
from linux_xtu.profiles.expected import parse_expected
from linux_xtu.profiles.fingerprint import FINGERPRINT_FILE, FingerprintError, cpu_id_from_cpuinfo, parse_fingerprint
from linux_xtu.profiles.migrate import current_profile_lines
from linux_xtu.topology import Topology

__all__ = [
    "CONFIG_PATH", "Config", "ConfigError", "EXIT_ERROR", "EXIT_FAILED", "EXIT_OK", "EXIT_SKIPPED", "Env", "InProcessHelper", "JournalKernelLog", "KERNEL_OPT_OUT", "KERNEL_OPT_OUT_LEGACY",
    "CLIENT", "MIN_WATCH_S", "OPERATOR", "Paths", "STATE_PATH", "Skip", "StateError", "arm", "cpu_identity", "disarm", "hardware_errors", "inspect_accepted", "kernel_faults",
    "load_config", "load_state", "main", "run", "state_lock", "status_doc", "update_state", "verdict",
]

OPERATOR = "boot-restore:unattended"  # every guard record of the boot restore carries this operator: the explicit unattended path, named as such
#: R-B8 (review of R-B3, H3): what the boot restore declares in ``preflight {client}`` (helper/ops.py "Expected client fields"): a protocol mismatch fences its writes.
CLIENT = {"name": "linux-xtu-bootrestore", "version": __version__, "protocol": PROTOCOL}
AUDIT_OP = "boot.restore"
STATE_SCHEMA = 1
STATE_PATH = INSTALLED_STATE_DIR / "bootrestore.json"
CONFIG_PATH = Path("/etc/linux-xtu/restore.toml")
KERNEL_OPT_OUT = "linux-xtu.norestore"  # on the kernel command line: skip (and disarm) without touching anything
KERNEL_OPT_OUT_LEGACY = "arltuner.norestore"  # the same switch under the earlier name (D-054): still honoured during the transition, until the next minor version
JOURNALCTL = "/usr/bin/journalctl"
MIN_WATCH_S = 120.0  # the boot is never called healthy sooner than this after the apply ended, whatever healthy_uptime_s says
HISTORY_MAX = 10

EXIT_OK, EXIT_ERROR, EXIT_FAILED, EXIT_SKIPPED = 0, 1, 2, 3

_FILE_MAX = 256 * 1024
_STATE_MAX = 64 * 1024
_ACCEPTED_PATH_RE = re.compile(r"profiles/[A-Za-z0-9._-]{1,80}\.toml")
_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]{0,31}\$?")
_APPLY_TIMEOUT_S = 24 * 3600.0  # the apply runs at the policy's dwell; a stop request (SIGTERM) cancels it at the next safe point
_READ_TIMEOUT_S = 6 * 3600.0
_PLAN_TIMEOUT_S = 300.0
_JOIN_S = 600.0

# A machine-check / hardware-error line of the kernel log. Narrower than ``linux_xtu.stress.klog.BAD_KLOG`` on purpose: that one judges only the lines a stress
# run added, whereas this one scans a whole boot, whose normal lines include "mce: CPU supports 32 MCE banks" and "MCE: In-kernel MCE decoding enabled.".
HW_ERROR_PATTERNS = (
    re.compile(r"\[Hardware Error\]"),  # x86 mce (HW_ERR) and APEI/GHES decoded errors, e.g. "mce: [Hardware Error]: Machine check events logged"
    re.compile(r"machine check(?! injector)", re.I),  # "Machine check events logged", "Kernel panic - not syncing: Fatal machine check ..."
    re.compile(r"\bCMCI storm\b", re.I),  # corrected machine-check interrupts in a storm
    re.compile(r"\bEDAC\b.*\b(?:CE|UE)\b"),  # memory errors reported through the machine-check banks
    re.compile(r"critical temperature reached", re.I),  # the thermal core's emergency shutdown
)

# Kernel faults that an unstable undervolt shows as (alongside compiler ICEs, which are user-space and too noisy to judge here): judged only on the lines the
# kernel logged AFTER the apply, at the clean point. A user process's "traps: NAME[pid] general protection fault" is user space and does not count.
KERNEL_FAULT_PATTERNS = (
    re.compile(r"\bOops\b"),
    re.compile(r"\bBUG:"),  # "BUG: unable to handle page fault", "BUG: kernel NULL pointer dereference", "watchdog: BUG: soft lockup ..."
    re.compile(r"^(?!traps: ).*general protection fault"),
    re.compile(r"soft lockup"),
    re.compile(r"hard LOCKUP"),
    re.compile(r"rcu.*stall", re.I),  # "rcu: INFO: rcu_preempt detected stalls on CPUs/tasks", "rcu_sched self-detected stall on CPU"
)

CONFIG_DEFAULTS: dict[str, Any] = {"apply_delay_s": 60, "healthy_uptime_s": 600, "verify": True, "previous_boot_log": "require", "bind_accepted": True,
                                   "busy_wait_s": 300}
BUSY_RETRY_S = 15.0
_LOCK_NAME = "bootrestore.lock"
_LOCK_WAIT_S = 30.0


# ------------------------------------------------------------------------------------------------------------------------------------------
# Small pure pieces
# ------------------------------------------------------------------------------------------------------------------------------------------
def hardware_errors(lines: Sequence[str]) -> list[str]:
    """The lines of a kernel log that report a machine-check / hardware error (or a critical-temperature shutdown); the expected MSR-write notices never match."""
    return [line for line in lines if "Write to unrecognized MSR" not in line and any(p.search(line) for p in HW_ERROR_PATTERNS)]


def kernel_faults(lines: Sequence[str]) -> list[str]:
    """Kernel fault lines (Oops, BUG:, a kernel general protection fault, soft / hard lockup, RCU stall); user-space segfault / trap lines never match."""
    return [line for line in lines if any(p.search(line) for p in KERNEL_FAULT_PATTERNS)]


def cpu_identity(cpuinfo_text: str) -> dict[str, Any] | None:
    """Vendor, family, model, stepping, microcode and brand of the first processor of ``/proc/cpuinfo``; ``None`` when vendor / family / model / brand are missing."""
    base = cpu_id_from_cpuinfo(cpuinfo_text)
    if base is None:
        return None
    block: dict[str, str] = {}
    for line in cpuinfo_text.splitlines():
        if not line.strip():
            if block:
                break
            continue
        key, sep, value = line.partition(":")
        if sep:
            block.setdefault(key.strip(), value.strip())
    stepping: int | None
    try:
        stepping = int(block["stepping"])
    except (KeyError, ValueError):
        stepping = None
    micro = block.get("microcode", "").strip().lower() or None
    if micro is not None:
        try:
            micro = hex(int(micro, 16))
        except ValueError:
            pass
    return {"vendor": base.vendor, "family": base.family, "model": base.model, "stepping": stepping, "microcode": micro, "brand": base.brand}


def _layout(topology: Topology) -> list[tuple[int, str, int, int | None]]:
    """The CPU layout to compare (``favored`` is left out: a 0x1D write moves it until a cold boot, assessment 05 B-10)."""
    return sorted((c.cpu, c.kind, c.index, c.cluster) for c in topology.cores)


def verdict(accepted_match: Sequence[Mapping[str, Any]] | None, note: str | None = None, *, expected_cpus: Sequence[int] | None = None,
            ring: bool = False) -> tuple[str, list[str]]:
    """The helper's compare (``tune.read`` -> ``accepted_match``) as ``("OK" | "EQUIVALENT" | "BAD", lines)``: OK = every unit's words are the accepted ones,
    EQUIVALENT = some unit holds a residual OC point that runs the accepted voltages (G-147; a success), BAD = a difference, or no compare at all.
    ``expected_cpus`` (the CPU lines of EXPECTED-words.txt) / ``ring``: a unit the read did not compare is BAD ("not in the read-back"), never skipped."""
    if accepted_match is None:
        return "BAD", [f"no compare with the accepted state: {note or 'the read returned none'}"]
    if not accepted_match:
        return "BAD", ["no compare with the accepted state: no unit of the read has an expected line"]
    lines: list[str] = []
    bad = equivalent = 0
    seen = {entry.get("cpu") for entry in accepted_match}
    for cpu in expected_cpus or ():
        if cpu not in seen:
            bad += 1
            lines.append(f"BAD         cpu {cpu}: not in the read-back (the accepted state has a line for it)")
    if ring and "ring" not in seen:
        bad += 1
        lines.append("BAD         ring: not in the read-back (the accepted state has a ring line)")
    for entry in accepted_match:
        unit = entry.get("unit") or f"cpu {entry.get('cpu')}"
        if not entry.get("match"):
            bad += 1
            diffs = ", ".join(f"point {d.get('point')}: {d.get('actual')} (accepted {d.get('expected')})" for d in (entry.get("diffs") or [])[:4])
            lines.append(f"BAD         {unit}: {diffs or 'differs'}{' ...' if entry.get('truncated') else ''}")
        elif entry.get("equivalent"):
            equivalent += 1
            lines.append(f"EQUIVALENT  {unit}: {'residual OC point (cleared by a cold boot); voltages as accepted' if any(e.get('residual') for e in entry.get('equivalents') or []) else 'same state'}")
        else:
            lines.append(f"OK          {unit}")
    return ("BAD" if bad else "EQUIVALENT" if equivalent else "OK"), lines


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _boottime() -> float:
    """Seconds since boot, suspend included (CLOCK_BOOTTIME, like /proc/uptime)."""
    clock = getattr(time, "CLOCK_BOOTTIME", None)
    if clock is not None:
        return time.clock_gettime(clock)
    with open("/proc/uptime", "rb") as handle:
        return float(handle.read(64).split()[0])


# ------------------------------------------------------------------------------------------------------------------------------------------
# Environment (everything outside, injectable)
# ------------------------------------------------------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Paths:
    state: Path = STATE_PATH
    config: Path = CONFIG_PATH
    accepted: Path = INSTALLED_ACCEPTED_DIR
    audit: Path = INSTALLED_AUDIT
    lock: Path = INSTALLED_LOCK
    policy: Path = INSTALLED_POLICY
    cpuinfo: Path = Path("/proc/cpuinfo")
    cmdline: Path = Path("/proc/cmdline")
    journal_dir: Path = Path("/var/log/journal")  # persistent journal (the previous boot's kernel log is readable only with it)


class JournalKernelLog:
    """``journalctl -k -b BOOT -q -o cat`` (``"0"`` this boot, ``"-1"`` the previous one) from a root-owned absolute path with a fixed environment; ``None`` when it
    cannot be read (no such boot in the journal, a volatile journal for ``-1``, an untrusted binary, a timeout). Never written."""

    def __init__(self, exe: str = JOURNALCTL, *, run: Callable[..., Any] = subprocess.run, trust: bool = True, lstat_fn: Callable[[str], Any] = os.lstat) -> None:
        self._exe, self._run, self._trust, self._lstat = exe, run, trust, lstat_fn

    def __call__(self, boot: str) -> list[str] | None:
        exe = os.path.realpath(self._exe)
        try:
            if self._trust:
                check_trusted_path(exe, want="file", lstat_fn=self._lstat)
            done = self._run(
                [exe, "-k", "-b", boot, "-q", "-o", "cat", "--no-pager"], cwd="/", env={"PATH": "/usr/sbin:/usr/bin", "LC_ALL": "C"}, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=120, check=False, shell=False,
            )
        except (TrustError, OSError, subprocess.SubprocessError):
            return None
        if done.returncode != 0:
            return None
        return bytes(done.stdout[: 64 << 20]).decode("utf-8", "replace").splitlines()


def _systemd_state(exe: str = "/usr/bin/systemctl") -> str | None:
    """``systemctl is-system-running`` ("running", "degraded", "stopping", ...) from a root-owned absolute path with a fixed environment; ``None`` if unknown."""
    try:
        real = os.path.realpath(exe)
        check_trusted_path(real, want="file")
        done = subprocess.run([real, "is-system-running"], cwd="/", env={"PATH": "/usr/sbin:/usr/bin", "LC_ALL": "C", "SYSTEMD_PAGER": "cat"},
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, check=False, shell=False)
    except (TrustError, OSError, subprocess.SubprocessError):
        return None
    return bytes(done.stdout[:200]).decode("ascii", "replace").strip() or None


def _detect() -> Topology:
    from linux_xtu.topology import detect

    return detect()


@dataclass
class Env:
    paths: Paths = field(default_factory=Paths)
    out: TextIO = field(default_factory=lambda: sys.stdout)
    syslog_prefix: bool = False  # stdout is the journal (JOURNAL_STREAM): "<N>" priority prefixes
    euid: Callable[[], int] = getattr(os, "geteuid", lambda: 0)
    require_root: bool = True
    enforce_trust: bool = True  # SPEC 4.4 checks on every file read or written (root-owned, not group/world-writable, no symlink)
    lstat: Callable[[str], Any] = os.lstat
    listdir: Callable[[str], list[str]] = os.listdir
    boot_id: Callable[[], str | None] = read_boot_id
    uptime: Callable[[], float] = _boottime  # since boot, suspend included: the apply delay
    monotonic: Callable[[], float] = time.monotonic  # CLOCK_MONOTONIC: running time, suspend excluded: the healthy window
    wall: Callable[[], float] = time.time
    kernel_log: Callable[[str], list[str] | None] = field(default_factory=JournalKernelLog)
    detect: Callable[[], Topology] = _detect
    system_state: Callable[[], str | None] = field(default_factory=lambda: _systemd_state)  # "stopping" while the system shuts down
    make_helper: Callable[["Env"], Any] | None = None  # None: the installed device helper (``helper.main.build_config(root=True)``)
    stop: threading.Event = field(default_factory=threading.Event)
    wait: Callable[[float], bool] | None = None  # sleep up to N s; True = a stop was requested (default: ``stop.wait``)
    on_stop: list[Callable[[], None]] = field(default_factory=list)

    def sleep(self, seconds: float) -> bool:
        return (self.wait or self.stop.wait)(max(0.0, seconds))

    def say(self, level: int, text: str) -> None:
        """One journal line (syslog priority ``level``: 3 err, 4 warning, 5 notice, 6 info)."""
        for line in text.splitlines() or [""]:
            self.out.write((f"<{level}>" if self.syslog_prefix else "") + line + "\n")
        self.out.flush()

    def request_stop(self) -> None:
        self.stop.set()
        for callback in list(self.on_stop):
            try:
                callback()
            except Exception:
                pass


class Skip(Exception):
    """A reason not to apply (or not to arm): ``code`` + a sentence that says what to do."""

    def __init__(self, code: str, text: str) -> None:
        super().__init__(f"{code}: {text}")
        self.code, self.text = code, text


class StateError(Exception):
    pass


class ConfigError(Exception):
    pass


def _trusted(env: Env, path: Path, want: str | None, *, must_exist: bool = True) -> None:
    if env.enforce_trust:
        check_trusted_path(path, want=want, must_exist=must_exist, lstat_fn=env.lstat)


def _read(env: Env, path: Path, limit: int, what: str) -> bytes:
    """A root-owned file (SPEC 4.4), opened without following links, at most ``limit`` bytes. ``FileNotFoundError`` / ``TrustError`` / ``ValueError``."""
    _trusted(env, path, "file")
    fd = open_checked(path, write=False, create=False, euid=env.euid(), what=what)
    with os.fdopen(fd, "rb") as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"{path} is larger than {limit} bytes")
    return data


def _exists(env: Env, path: Path) -> bool:
    try:
        env.lstat(os.fspath(path))
    except FileNotFoundError:
        return False
    except OSError:
        return True  # there but not examinable: the read reports it
    return True


# ------------------------------------------------------------------------------------------------------------------------------------------
# Config and state
# ------------------------------------------------------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Config:
    apply_delay_s: float = 60.0
    healthy_uptime_s: float = 600.0
    verify: bool = True
    previous_boot_log: str = "require"
    bind_accepted: bool = True
    busy_wait_s: float = 300.0


def load_config(env: Env) -> Config:
    """``/etc/linux-xtu/restore.toml`` (absent = the defaults). ``ConfigError`` for an untrusted or unreadable file, an unknown key or a value out of range."""
    path = env.paths.config
    if not _exists(env, path):
        return Config()
    try:
        doc = tomllib.loads(_read(env, path, _FILE_MAX, "boot restore config").decode("utf-8"))
    except (TrustError, OSError, ValueError, UnicodeDecodeError) as exc:  # tomllib.TOMLDecodeError is a ValueError
        raise ConfigError(f"{path}: {exc}") from None
    unknown = sorted(set(doc) - set(CONFIG_DEFAULTS))
    if unknown:
        raise ConfigError(f"{path}: unknown key(s) {unknown} (known: {sorted(CONFIG_DEFAULTS)})")

    def number(key: str, lo: float, hi: float) -> float:
        value = doc.get(key, CONFIG_DEFAULTS[key])
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi:
            raise ConfigError(f"{path}: {key} must be a number of seconds in {lo:g}..{hi:g}, got {value!r}")
        return float(value)

    def flag(key: str) -> bool:
        value = doc.get(key, CONFIG_DEFAULTS[key])
        if not isinstance(value, bool):
            raise ConfigError(f"{path}: {key} must be true or false, got {value!r}")
        return value

    prev = doc.get("previous_boot_log", CONFIG_DEFAULTS["previous_boot_log"])
    if prev not in ("require", "ignore"):
        raise ConfigError(f"{path}: previous_boot_log must be \"require\" or \"ignore\", got {prev!r}")
    return Config(number("apply_delay_s", 30, 3600), number("healthy_uptime_s", 120, 86400), flag("verify"), prev, flag("bind_accepted"),
                  number("busy_wait_s", 0, 3600))


def _blank_state() -> dict[str, Any]:
    return {"schema": STATE_SCHEMA, "armed": False, "armed_at": None, "armed_by": None, "accepted": None, "identity": None, "pending": None, "disarmed": None,
            "last": None, "history": []}


def load_state(env: Env) -> dict[str, Any] | None:
    """The state document, ``None`` when there is none (never armed). ``StateError`` when it cannot be read or trusted or is not a state document."""
    path = env.paths.state
    if not _exists(env, path):
        return None
    try:
        doc = json.loads(_read(env, path, _STATE_MAX, "boot restore state").decode("utf-8"))
    except FileNotFoundError:
        return None
    except (TrustError, OSError, ValueError, UnicodeDecodeError) as exc:
        raise StateError(f"{path}: {exc}") from None
    if not isinstance(doc, dict) or doc.get("schema") != STATE_SCHEMA or not isinstance(doc.get("armed"), bool):
        raise StateError(f"{path}: not a boot restore state of schema {STATE_SCHEMA}")
    for key in ("pending", "disarmed", "last", "accepted", "identity"):
        if doc.get(key) is not None and not isinstance(doc[key], dict):
            raise StateError(f"{path}: '{key}' must be an object or null")
    if not isinstance(doc.get("history", []), list):
        raise StateError(f"{path}: 'history' must be a list")
    return {**_blank_state(), **doc}


def save_state(env: Env, doc: Mapping[str, Any]) -> None:
    """Atomic replace (temp file ``O_EXCL`` + fsync + rename + directory fsync), mode 0644, in the root-owned state directory."""
    path = env.paths.state
    directory = path.parent
    _trusted(env, directory, "dir")
    _trusted(env, path, "file", must_exist=False)
    tmp = directory / f".bootrestore.new.{os.getpid()}"
    if os.path.lexists(tmp):
        os.unlink(tmp)  # a leftover of this pid (a root-owned directory: nobody else can plant it)
    fd = open_checked(tmp, write=True, create=True, mode=0o644, euid=env.euid(), what="boot restore state")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write((json.dumps(dict(doc), indent=1, sort_keys=True) + "\n").encode("utf-8"))
            handle.flush()
            os.fchmod(handle.fileno(), 0o644)  # readable by the desktop app; the umask (UMask=0077 in the unit) must not decide it
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:
        dfd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


@contextlib.contextmanager
def state_lock(env: Env) -> Any:
    """Exclusive ``flock`` on ``bootrestore.lock`` next to the state file, held only around one read-modify-write of the state (a run, ``arm``, ``disarm``,
    a future helper op): two writers never work from two copies. The lock file is root-owned 0600 and never deleted."""
    import fcntl

    directory = env.paths.state.parent
    _trusted(env, directory, "dir")
    path = directory / _LOCK_NAME
    _trusted(env, path, "file", must_exist=False)
    fd = open_checked(path, write=True, create=True, mode=0o600, euid=env.euid(), what="boot restore state lock")
    try:
        deadline = time.monotonic() + _LOCK_WAIT_S
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise StateError(f"{path} is locked by another linux-xtu-restore for more than {_LOCK_WAIT_S:.0f} s") from None
                time.sleep(0.05)
        yield
    finally:
        os.close(fd)  # drops the lock


def update_state(env: Env, change: Callable[[dict[str, Any]], Any], *, create: bool = False, replace_unreadable: bool = False, keep: bool = False) -> Any:
    """Read the state under :func:`state_lock`, let ``change`` modify it, write it back, all inside the lock. ``change`` returning ``False`` writes nothing.
    No state: ``None`` (``create``: a blank one is changed). An unreadable one raises ``StateError`` (``replace_unreadable``: a blank one replaces it).
    Returns the state, or with ``keep`` the value ``change`` returned."""
    with state_lock(env):
        try:
            state = load_state(env)
        except StateError:
            if not replace_unreadable:
                raise
            state = None
        if state is None:
            if not create:
                return None
            state = _blank_state()
        result = change(state)
        if result is not False:
            save_state(env, state)
        return result if keep else state


def _audit(env: Env, outcome: str, code: str, text: str, *, op: str = AUDIT_OP, **fields: Any) -> None:
    """One ``result`` record in the audit log (the helper's op-result convention: ``op`` + fields). A failure to write it is reported, never fatal for a skip."""
    try:
        from linux_xtu.guard.audit import AuditLog

        _trusted(env, env.paths.audit, "file", must_exist=False)
        AuditLog(env.paths.audit).append("result", ts=env.wall(), operator=OPERATOR, op=op, outcome=outcome, code=code, detail=text[:500], mode="unattended", **fields)
    except (TrustError, OSError, ValueError) as exc:
        env.say(3, f"linux-xtu-restore: could not write the audit record: {exc}")


# ------------------------------------------------------------------------------------------------------------------------------------------
# The accepted state (pre-checks; no hardware)
# ------------------------------------------------------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Accepted:
    name: str
    sha256: str
    profile: Profile
    expected_units: tuple[int, ...]  # the CPU lines of EXPECTED-words.txt: each must be in the read-back compare
    ring: bool


def _cpuinfo_text(env: Env) -> str:
    with open(env.paths.cpuinfo, "rb") as handle:
        return handle.read(1 << 20).decode("utf-8", "replace")


def inspect_accepted(env: Env, topology: Topology, cpuinfo_text: str) -> Accepted:
    """The checks of (c), before any request: ``CURRENT`` names one profile, the profile is complete and fits the live layout, ``EXPECTED-words.txt`` parses,
    ``fingerprint.json`` records this CPU (vendor / family / model / brand) and this layout; every file root-owned (SPEC 4.4). ``Skip`` otherwise."""
    acc = env.paths.accepted
    if not _exists(env, acc):
        raise Skip("ACCEPTED_MISSING", f"no accepted state at {acc}: save one in the app (Profiles > Set as accepted), then arm the boot restore again")
    if env.enforce_trust:
        try:
            check_code_tree(acc, lstat_fn=env.lstat, listdir_fn=env.listdir)
        except TrustError as exc:
            raise Skip("ACCEPTED_UNTRUSTED", f"the accepted state is not root-owned / is writable by others ({exc}): repair it, then arm again") from None
    blobs: dict[str, bytes] = {}

    def read(rel: str, what: str) -> bytes:
        try:
            data = _read(env, acc / rel, _FILE_MAX, what)
        except FileNotFoundError:
            raise Skip("ACCEPTED_MISSING" if rel == "CURRENT" else "ACCEPTED_INVALID", f"{acc / rel} is missing") from None
        except (TrustError, OSError, ValueError) as exc:
            raise Skip("ACCEPTED_INVALID", f"{acc / rel} cannot be read: {exc}") from None
        blobs[rel] = data
        return data

    paths = current_profile_lines(read("CURRENT", "accepted CURRENT").decode("utf-8", "replace"))
    if not paths:
        raise Skip("ACCEPTED_INVALID", f"{acc / 'CURRENT'} names no profile")
    if len(paths) > 1:
        raise Skip("ACCEPTED_CHAIN", f"{acc / 'CURRENT'} is an older chain of {len(paths)} profiles: run 'accepted-migrate' once (D-044), then arm again")
    rel = paths[0]
    if not _ACCEPTED_PATH_RE.fullmatch(rel) or ".." in rel:
        raise Skip("ACCEPTED_INVALID", f"{acc / 'CURRENT'} names an unusable profile path {rel!r}")
    text = read(rel, "accepted profile").decode("utf-8", "replace")
    if "\n" not in text:
        raise Skip("ACCEPTED_INVALID", f"{acc / rel} is not a profile")
    try:
        profile = load_profile(text)
    except ProfileError as exc:
        raise Skip("ACCEPTED_INVALID", f"{acc / rel} is invalid: {exc}") from None
    if not profile.complete:
        raise Skip("ACCEPTED_INCOMPLETE", f"{acc / rel} is a partial (legacy) profile: the boot restore applies only a complete one. Re-accept the state in the app")
    try:
        profile.check_complete(topology)
    except ProfileError as exc:
        raise Skip("IDENTITY_MISMATCH", f"the accepted profile does not fit this CPU: {exc}") from None
    try:
        table, ring = parse_expected(read("EXPECTED-words.txt", "accepted EXPECTED words").decode("utf-8", "replace"))
    except ValueError as exc:
        raise Skip("ACCEPTED_INVALID", f"{acc / 'EXPECTED-words.txt'}: {exc}") from None
    if not _exists(env, acc / FINGERPRINT_FILE):
        raise Skip("ACCEPTED_NO_FINGERPRINT", f"the accepted state has no {FINGERPRINT_FILE}, so the CPU it belongs to cannot be checked: re-accept it in the app "
                                              "(Tune > Read, then Profiles > Set as accepted), then arm again")
    try:
        fingerprint = parse_fingerprint(read(FINGERPRINT_FILE, "accepted fingerprint").decode("utf-8", "replace"))
    except FingerprintError as exc:
        raise Skip("ACCEPTED_INVALID", str(exc)) from None
    if fingerprint.cpu_id is None:
        raise Skip("ACCEPTED_NO_FINGERPRINT", f"{FINGERPRINT_FILE} records no CPU identity: re-accept the state in the app, then arm again")
    live = cpu_id_from_cpuinfo(cpuinfo_text)
    if live is None:
        raise Skip("IDENTITY_UNKNOWN", "/proc/cpuinfo does not say vendor / family / model / brand")
    differs = fingerprint.cpu_id.mismatch(live)
    if differs is not None:
        raise Skip("IDENTITY_MISMATCH", f"this is not the CPU the state was accepted on: {differs}")
    try:
        recorded = _layout(fingerprint.topology())
    except FingerprintError as exc:
        raise Skip("ACCEPTED_INVALID", str(exc)) from None
    if recorded != _layout(topology):
        raise Skip("IDENTITY_MISMATCH", "the CPU layout (P/E CPUs, E clusters) differs from the one the state was accepted on (a CPU offline, or another CPU)")
    digest = hashlib.sha256()
    for name in sorted(blobs):
        digest.update(name.encode() + b"\0" + str(len(blobs[name])).encode() + b"\0" + blobs[name])
    return Accepted(Path(rel).stem, digest.hexdigest(), profile, tuple(sorted(table)), ring is not None)


# ------------------------------------------------------------------------------------------------------------------------------------------
# The helper, in this process
# ------------------------------------------------------------------------------------------------------------------------------------------
def device_helper(env: Env) -> Any:
    """The installed root helper exactly as the socket unit builds it (``build_config(root=True)``: installed policy, audit, lock, accepted state, health gate,
    ``/dev/cpu`` port), without the socket, its operator named :data:`OPERATOR`, with the cpufreq wiring (a raised OC ratio's ``scaling_max_freq`` follows)."""
    from linux_xtu.helper import Helper
    from linux_xtu.helper.main import build_config, measure_wiring

    args = argparse.Namespace(sim=False, device=True, policy=None, audit=None, lock=None, allow_taint_bit=[], state_dir=None, socket=False, socket_path=None,
                              helper_toml=None)
    cfg = build_config(args, log=lambda text: env.say(6, f"helper: {text}"), root=True)
    cfg.operator = OPERATOR
    helper = Helper(cfg)
    helper.measure_wiring = measure_wiring(args)
    return helper


class InProcessHelper:
    """``Helper.run`` on a pipe pair in this process, driven by ``linux_xtu.client.HelperLink``: every request takes a socket client's path (validators, state
    machine, preflight write gate, guard, audit). ``exit_code`` is the helper's (75: another helper holds the instance lock, 77: refused to start)."""

    def __init__(self, helper: Any) -> None:
        self.helper = helper
        self.exit_code: int | None = None
        self.error: BaseException | None = None
        self.link: Any = None
        self._thread: threading.Thread | None = None

    def __enter__(self) -> Any:
        from linux_xtu.client import HelperLink

        in_r, in_w = os.pipe()
        out_r, out_w = os.pipe()
        self._helper_in, self._helper_out = os.fdopen(in_r, "rb"), os.fdopen(out_w, "wb")
        self.link = HelperLink(os.fdopen(out_r, "rb"), os.fdopen(in_w, "wb", buffering=0)).start()
        self._thread = threading.Thread(target=self._main, name="linux-xtu-restore-helper", daemon=True)
        self._thread.start()
        return self.link

    def _main(self) -> None:
        try:
            self.exit_code = self.helper.run(self._helper_in, self._helper_out)
        except BaseException as exc:  # reported by the caller; the pipes still close so no call waits forever
            self.error = exc
        finally:
            for handle in (self._helper_out, self._helper_in):
                try:
                    handle.close()
                except OSError:
                    pass

    def stop(self, reason: str) -> None:
        """An orderly stop (SIGTERM): the op in flight finishes its transaction and answers; nothing new starts."""
        try:
            self.helper.request_shutdown(reason)
        except Exception:
            pass

    def wait_ended(self, timeout: float) -> bool:
        if self._thread is not None:
            self._thread.join(timeout)
            return not self._thread.is_alive()
        return True

    def __exit__(self, *exc: object) -> None:
        if self.link is not None:
            self.link.close()  # EOF to the helper: it shuts down after the op in flight
        self.wait_ended(_JOIN_S)


# ------------------------------------------------------------------------------------------------------------------------------------------
# run
# ------------------------------------------------------------------------------------------------------------------------------------------
@dataclass
class Outcome:
    exit: int
    kind: str  # applied | in_place | nothing | skipped | refused | failed | cancelled
    code: str
    text: str
    writes: int | None = None
    disarm: bool = False
    extra: dict[str, Any] = field(default_factory=dict)  # added to the audit record
    klog_mark: int | None = None  # lines of this boot's kernel log before the apply: the clean point judges kernel faults after it


def _skip(code: str, text: str, *, disarm: bool = True) -> Outcome:
    return Outcome(EXIT_SKIPPED, "skipped", code, text, disarm=disarm)


def _record(env: Env, armed_run: bool, boot: str | None, out: Outcome, accepted: Accepted | None = None) -> None:
    """Journal line + audit record; for a run of an armed state also ``last`` / ``history`` and, when the outcome disarms, ``armed = false`` + ``disarmed`` --
    written into the state as it is NOW (re-read under the state lock), so an operator's arm / disarm made meanwhile is never overwritten by an older copy."""
    level = {"applied": 5, "in_place": 5, "nothing": 6, "cancelled": 4, "skipped": 4}.get(out.kind, 3)
    words = {"applied": f"applied {out.writes} word(s) of the accepted state", "in_place": "the accepted state was already in place (0 words written)",
             "nothing": "nothing to do", "cancelled": "the apply was cancelled by a stop request", "skipped": "SKIPPED", "refused": "REFUSED", "failed": "FAILED"}[out.kind]
    env.say(level, f"linux-xtu-restore: {words}" + (f" [{out.code}]: {out.text}" if out.kind not in ("applied", "in_place") else f": {out.text}"))
    if out.disarm:
        env.say(level, "linux-xtu-restore: the boot restore is now DISARMED; it stays off until the operator re-arms it: sudo /usr/lib/linux-xtu/linux-xtu-restore arm")
    fields: dict[str, Any] = {"boot_id": boot, "writes": out.writes, "disarmed_now": out.disarm}
    if accepted is not None:
        fields.update(accepted=accepted.name, accepted_sha256=accepted.sha256)
    _audit(env, out.kind, out.code, out.text, **fields, **out.extra)
    if not armed_run or out.kind == "nothing":
        return
    now = env.wall()

    def change(state: dict[str, Any]) -> None:
        last = {"boot_id": boot, "at": _iso(now), "outcome": out.kind, "code": out.code, "text": out.text[:500], "writes": out.writes, "clean_at": None, "clean_how": None}
        state["last"] = last
        state["history"] = ([*state.get("history", []), last])[-HISTORY_MAX:]
        if out.disarm:  # only ever towards "off": an operator's disarm stays, a re-arm made during this run is withdrawn by this run's evidence (fail closed)
            state["armed"] = False
            state["disarmed"] = {"at": _iso(now), "boot_id": boot, "code": out.code, "reason": out.text[:500]}

    try:
        update_state(env, change)
    except (StateError, TrustError, OSError) as exc:
        env.say(3, f"linux-xtu-restore: could not write {env.paths.state}: {exc}")


def _error_of(resp: Mapping[str, Any]) -> tuple[str, str, dict[str, Any]]:
    err = resp.get("error") if isinstance(resp.get("error"), dict) else {}
    detail = err.get("detail") if isinstance(err.get("detail"), dict) else {}
    return str(detail.get("check") or err.get("code") or "ERROR"), str(err.get("message") or "no message"), detail


def run(env: Env) -> int:
    """The unattended boot restore (the unit's ExecStart). See the module docstring for the order of the checks."""
    out, armed_run, boot, accepted = _run_checks_and_apply(env)
    _record(env, armed_run, boot, out, accepted)
    if out.kind in ("applied", "in_place") or (out.kind == "cancelled" and out.extra.get("sent")):
        clean = _watch(env, boot, out)
        return clean if clean != EXIT_OK else out.exit
    if out.extra.get("sent") and out.kind != "cancelled":
        env.say(4, "linux-xtu-restore: requests were sent this boot and the run did not succeed: no clean marker is written (the boot restore is disarmed)")
    return out.exit


def _run_checks_and_apply(env: Env) -> tuple[Outcome, bool, str | None, Accepted | None]:
    """``(outcome, the run is of an armed state, boot id, accepted state)``. Every check before the first request; then the apply."""
    try:
        cfg = load_config(env)
    except ConfigError as exc:
        cfg = None
        config_problem = str(exc)
    else:
        config_problem = None
    delay = cfg.apply_delay_s if cfg is not None else CONFIG_DEFAULTS["apply_delay_s"]
    while env.uptime() < delay:  # the apply waits for the configured uptime (the timer starts the service at 30 s)
        if env.sleep(min(delay - env.uptime(), 5.0)):
            return Outcome(EXIT_OK, "nothing", "STOPPED", "stopped before the apply (nothing was sent)"), False, env.boot_id(), None
    boot = env.boot_id()
    try:
        state = load_state(env)
    except StateError as exc:
        return _skip("STATE_UNREADABLE", f"the boot restore state cannot be read ({exc}): nothing is applied; re-arm to rewrite it", disarm=False), False, boot, None
    if state is None or not state.get("armed"):
        why = (state or {}).get("disarmed") or {}
        text = "the boot restore is not armed" + (f" (disarmed {why.get('at')} [{why.get('code')}]: {why.get('reason')})" if why else "") + \
               ": nothing is applied. Arm it with: sudo /usr/lib/linux-xtu/linux-xtu-restore arm"
        return _skip("NOT_ARMED", text, disarm=False), False, boot, None
    if boot is None:
        return _skip("BOOT_ID_UNKNOWN", "the kernel's boot id cannot be read, so a crash loop could not be told apart from a new boot"), True, boot, None
    pending = state.get("pending") or None
    if pending is not None:
        if pending.get("boot_id") != boot:
            return _skip("PREVIOUS_BOOT_UNCLEAN", f"the boot of the apply at {pending.get('started_at')} (boot {pending.get('boot_id')}) ended before it was marked clean "
                                                  f"(a hang, a crash or a power loss within the healthy window, a stop that was not a shutdown, or a fault "
                                                  f"after the apply)"), True, boot, None
        return Outcome(EXIT_OK, "nothing", "ALREADY_RAN", f"an apply already ran this boot at {pending.get('started_at')} (its clean marker is pending)"), True, boot, None
    last = state.get("last") or {}
    if last.get("boot_id") == boot:
        return Outcome(EXIT_OK, "nothing", "ALREADY_RAN", f"the boot restore already ran this boot at {last.get('at')} ({last.get('outcome')})"), True, boot, None
    if config_problem is not None:
        return _skip("CONFIG_INVALID", config_problem), True, boot, None
    assert cfg is not None
    try:
        cmdline = env.paths.cmdline.read_text(encoding="utf-8", errors="replace").split()
    except OSError as exc:
        return _skip("CMDLINE_UNREADABLE", f"{env.paths.cmdline}: {exc}"), True, boot, None
    for word in (KERNEL_OPT_OUT, KERNEL_OPT_OUT_LEGACY):
        if any(tok == word or tok.startswith(word + "=") for tok in cmdline):
            return _skip("KERNEL_OPT_OUT", f"{word} is on the kernel command line"), True, boot, None
    this_boot = env.kernel_log("0")
    if this_boot is None:
        return _skip("KERNEL_LOG_UNAVAILABLE", "this boot's kernel log cannot be read (journalctl -k -b 0), so machine-check errors cannot be ruled out"), True, boot, None
    bad = hardware_errors(this_boot)
    if bad:
        return _skip("MCE_THIS_BOOT", f"this boot's kernel log has {len(bad)} machine-check / hardware-error line(s), first: {bad[0][:200]}"), True, boot, None
    if cfg.previous_boot_log == "require":
        previous = env.kernel_log("-1")
        if previous is None:
            return _skip("PREVIOUS_BOOT_LOG_UNAVAILABLE", "the previous boot's kernel log cannot be read (no persistent journal?): make the journal persistent "
                                                          "(mkdir -p /var/log/journal) or set previous_boot_log = \"ignore\" in /etc/linux-xtu/restore.toml"), True, boot, None
        bad = hardware_errors(previous)
        if bad:
            return _skip("MCE_PREVIOUS_BOOT", f"the previous boot's kernel log has {len(bad)} machine-check / hardware-error line(s), first: {bad[0][:200]}"), True, boot, None
    try:
        topology = env.detect()
        cpuinfo = _cpuinfo_text(env)
    except Exception as exc:
        return _skip("TOPOLOGY_UNKNOWN", f"the live CPU topology / identity cannot be read: {type(exc).__name__}: {exc}"), True, boot, None
    identity = cpu_identity(cpuinfo)
    if identity is None:
        return _skip("IDENTITY_UNKNOWN", "/proc/cpuinfo does not say vendor / family / model / brand"), True, boot, None
    try:
        accepted = inspect_accepted(env, topology, cpuinfo)
    except Skip as exc:
        return _skip(exc.code, exc.text), True, boot, None
    armed_identity = state.get("identity") or {}
    changed = [f"{k} {armed_identity.get(k)!r} -> {identity.get(k)!r}" for k in ("vendor", "family", "model", "stepping", "microcode", "brand") if armed_identity.get(k) != identity.get(k)]
    if changed:
        return _skip("IDENTITY_CHANGED", f"the CPU identity changed since the boot restore was armed ({'; '.join(changed)}; a BIOS update?): check the accepted "
                                         "state on this firmware, then arm again"), True, boot, accepted
    armed_sha = (state.get("accepted") or {}).get("sha256")
    if cfg.bind_accepted and armed_sha != accepted.sha256:
        return _skip("ACCEPTED_CHANGED", f"the accepted state is not the one that was armed (now {accepted.name}, sha256 {accepted.sha256[:12]}; armed "
                                         f"{(state.get('accepted') or {}).get('name')}, {str(armed_sha)[:12]}): arm again to restore it at boot"), True, boot, accepted
    out = _apply_when_free(env, cfg, boot, accepted, topology, cpuinfo)
    out.klog_mark = len(this_boot)
    return out, True, boot, accepted


_BUSY = object()  # the helper's instance lock is held by another helper: try again


def _apply_when_free(env: Env, cfg: Config, boot: str, accepted: Accepted, topology: Topology, cpuinfo: str) -> Outcome:
    """(d) A mailbox lock or another helper (the desktop app, a CLI session) is not a fault: wait up to ``busy_wait_s`` of running time for it to go away,
    trying again every 15 s; then skip WITHOUT disarming (nothing was sent: the next boot tries again)."""
    give_up = env.monotonic() + cfg.busy_wait_s
    while True:
        if _exists(env, env.paths.lock):
            code, text = "MAILBOX_LOCK", f"{env.paths.lock} exists: a mailbox transaction is in flight (or a killed process left it)"
        else:
            out = _apply(env, cfg, boot, accepted, topology, cpuinfo)
            if out is not _BUSY:
                return out  # type: ignore[return-value]
            code, text = "HELPER_BUSY", ("another linux-xtu helper holds the machine-wide instance lock (the desktop app or a CLI session is using it): "
                                         "a mutation may be in flight")
        if env.monotonic() >= give_up:
            return _skip(code, f"{text}; still so after {cfg.busy_wait_s:.0f} s. Nothing was sent; the next boot tries again", disarm=False)
        env.say(6, f"linux-xtu-restore: waiting: {text}; trying again in {BUSY_RETRY_S:.0f} s")
        if env.sleep(BUSY_RETRY_S):
            return Outcome(EXIT_OK, "nothing", "STOPPED", "stopped while waiting for the helper to be free (nothing was sent)")


def _apply(env: Env, cfg: Config, boot: str, accepted: Accepted, topology: Topology, cpuinfo: str) -> Outcome | object:
    from linux_xtu.client import HelperTimeout, HelperUnavailable

    try:
        helper = (env.make_helper or device_helper)(env)
    except Exception as exc:  # e.g. an untrusted installed policy (InstalledStateRefused)
        return Outcome(EXIT_FAILED, "refused", "HELPER_CONFIG", f"the helper cannot be set up: {type(exc).__name__}: {exc}. Nothing was sent", disarm=True)
    helper.cfg.operator = OPERATOR
    runner = InProcessHelper(helper)
    sent = False

    def done(o: Outcome) -> Outcome:
        o.extra.setdefault("sent", sent)
        return o

    stop_cb = lambda: runner.stop("stop requested (SIGTERM)")  # noqa: E731
    env.on_stop.append(stop_cb)
    try:
        with runner as link:
            try:
                pre = link.call("preflight", {"client": dict(CLIENT)}, timeout=120)  # R-B8 (H3): versioned
            except (HelperUnavailable, HelperTimeout):
                runner.wait_ended(30)
                if runner.exit_code == 75:
                    return _BUSY
                return done(Outcome(EXIT_FAILED, "failed", "HELPER_FAILED", f"the helper did not start (exit {runner.exit_code}"
                                    f"{', ' + type(runner.error).__name__ + ': ' + str(runner.error) if runner.error else ''}). Nothing was sent", disarm=True))
            if not pre.get("ok") or not pre["result"].get("writes_allowed"):
                blockers = [] if not pre.get("ok") else [f"{b.get('name')}: {b.get('reason')}" for b in pre["result"].get("checks", []) if b.get("status") in ("read-only", "refuse", "unknown")]
                why = _error_of(pre)[1] if not pre.get("ok") else "; ".join(blockers[:4]) or f"mode {pre['result'].get('mode')!r}"
                return done(Outcome(EXIT_FAILED, "refused", "PREFLIGHT", f"the helper's preflight does not allow writes ({why}). Nothing was sent", disarm=True))
            try:  # under the helper's instance lock now: profiles.accept cannot run, so the state the plan reads is the one checked here
                again = inspect_accepted(env, topology, cpuinfo)
            except Skip as exc:
                return done(_skip(exc.code, exc.text))
            if again.sha256 != accepted.sha256:
                return done(_skip("ACCEPTED_CHANGED", "the accepted state changed while the boot restore started"))
            plan = link.call("tune.plan", {"intent": {"restore": "accepted"}}, timeout=_PLAN_TIMEOUT_S)
            if not plan.get("ok"):
                code, message, _ = _error_of(plan)
                return done(Outcome(EXIT_FAILED, "refused", code, f"the plan was refused: {message}", disarm=True))
            p = plan["result"]
            if not p.get("complete"):
                return done(Outcome(EXIT_FAILED, "refused", "ACCEPTED_INCOMPLETE", "the helper planned a partial profile; the boot restore applies only a complete one. Nothing was sent", disarm=True))
            pending = {"boot_id": boot, "started_at": _iso(env.wall()), "uptime_s": round(env.uptime(), 1), "accepted_sha256": accepted.sha256}

            def set_pending(state: dict[str, Any]) -> bool:
                if not state.get("armed") or (cfg.bind_accepted and (state.get("accepted") or {}).get("sha256") != accepted.sha256):
                    return False  # the operator disarmed (or re-armed for another state) while this run started: nothing is sent
                state["pending"] = pending
                return True

            if not update_state(env, set_pending, keep=True):  # BEFORE the first mailbox transaction: a hang from here on is seen at the next boot
                return done(_skip("DISARMED_MEANWHILE", "the operator disarmed (or re-armed) the boot restore while this run started. Nothing was sent", disarm=False))
            sent = True
            env.say(6, f"linux-xtu-restore: applying accepted profile {accepted.name} (sha256 {accepted.sha256[:12]}): up to {p.get('ops_needed')} mailbox operations, "
                       f"one at a time, each write read back")
            if env.stop.is_set():
                return done(Outcome(EXIT_OK, "cancelled", "CANCELLED", "stopped before the apply (nothing was sent)"))
            applied = link.call("tune.apply", {"plan_id": p["plan_id"], "typed": f"CONFIRM {p['nonce']}"}, timeout=_APPLY_TIMEOUT_S)
            if not applied.get("ok"):
                code, message, detail = _error_of(applied)
                if env.stop.is_set() and applied.get("error", {}).get("code") == "CANCELLED":
                    return done(Outcome(EXIT_OK, "cancelled", "CANCELLED", f"{message} (a stop request)"))
                writes = detail.get("writes_sent")
                return done(Outcome(EXIT_FAILED, "refused" if writes == 0 else "failed", code, message, writes=writes, disarm=True))
            a = applied["result"]
            writes = int(a.get("writes_sent") or 0)
            if not a.get("complete"):
                stop = a.get("stop") or {}
                if env.stop.is_set() and stop.get("kind") == "cancelled":
                    return done(Outcome(EXIT_OK, "cancelled", "CANCELLED", f"cancelled by a stop request after {writes} write(s); the CPU holds a partial state until a cold boot", writes=writes))
                return done(Outcome(EXIT_FAILED, "failed", "APPLY_PARTIAL", f"the apply stopped after {writes} write(s): {stop.get('reason')}. The CPU holds a partial state: "
                                                                            "cold boot (power off) to get back to stock", writes=writes, disarm=True))
            notes = []
            if a.get("ring_refused"):
                notes.append("ring NOT restored: " + "; ".join(map(str, a["ring_refused"])))
            if a.get("residual"):
                notes.append(f"residual OC point rewritten on {', '.join(map(str, a['residual']))} (EQUIVALENT)")
            if cfg.verify:
                read = link.call("tune.read", {}, timeout=_READ_TIMEOUT_S)
                if not read.get("ok"):
                    code, message, _ = _error_of(read)
                    if env.stop.is_set():  # a shutdown during the read-back: the apply itself completed (every write was read back)
                        return done(Outcome(EXIT_OK, "cancelled", "CANCELLED", f"applied {writes} word(s); the full read-back was cancelled by a stop request", writes=writes))
                    return done(Outcome(EXIT_FAILED, "failed", "VERIFY_FAILED", f"applied {writes} word(s) but the read-back failed: {message}", writes=writes, disarm=True))
                verdict_word, lines = verdict(read["result"].get("accepted_match"), read["result"].get("accepted_note"), expected_cpus=accepted.expected_units,
                                              ring=accepted.ring)
                for line in lines:
                    env.say(6 if not line.startswith("BAD") else 3, f"linux-xtu-restore:   {line}")
                if verdict_word == "BAD":
                    return done(Outcome(EXIT_FAILED, "failed", "MISMATCH", f"applied {writes} word(s) but the read-back is not the accepted state "
                                                                          f"({sum(1 for line in lines if line.startswith('BAD'))} unit(s) BAD)", writes=writes, disarm=True))
                notes.insert(0, f"read-back {verdict_word}")
            else:
                notes.insert(0, "read-back of every word skipped (verify = false); each write was read back by the guard")
            if a.get("ring_refused"):
                return done(Outcome(EXIT_FAILED, "failed", "RING_NOT_RESTORED", "; ".join(notes), writes=writes, disarm=True))
            text = f"accepted profile {accepted.name}" + (f"; {'; '.join(notes)}" if notes else "")
            return done(Outcome(EXIT_OK, "applied" if writes else "in_place", "OK", text, writes=writes))
    except (HelperUnavailable, HelperTimeout) as exc:
        return done(Outcome(EXIT_FAILED, "failed", "HELPER_LOST", f"the in-process helper stopped answering ({type(exc).__name__}); the CPU may hold a partial state", disarm=True))
    except (StateError, TrustError, OSError) as exc:
        return done(Outcome(EXIT_FAILED, "failed", "STATE_WRITE", f"{exc}. Nothing more was sent", disarm=True))
    finally:
        if stop_cb in env.on_stop:
            env.on_stop.remove(stop_cb)


def _watch(env: Env, boot: str | None, applied: Outcome) -> int:
    """Stay until the boot counts as healthy, then the clean marker. The window is RUNNING time (CLOCK_MONOTONIC: a suspend does not count): the boot is
    healthy at ``healthy_uptime_s`` of it, and never sooner than :data:`MIN_WATCH_S` after the apply. A stop counts as clean only while the system shuts down
    (``systemctl is-system-running`` = ``stopping``); a ``systemctl stop``, a SysRq REISUB or anything else leaves ``pending``, so the next boot skips. At the
    clean point this boot's kernel log must hold no machine-check line, and no kernel fault (Oops, BUG:, GPF, lockup, RCU stall) after the apply. Only
    ``pending`` of THIS boot (and this boot's ``last``) is changed, on the state as it is now: an operator's arm / disarm in the window stays."""
    cfg_healthy = CONFIG_DEFAULTS["healthy_uptime_s"]
    try:
        cfg_healthy = load_config(env).healthy_uptime_s
    except ConfigError:
        pass
    target = max(float(cfg_healthy), env.monotonic() + MIN_WATCH_S)
    env.say(6, f"linux-xtu-restore: watching this boot; it counts as healthy at {target:.0f} s of running time (clean marker), or at a shutdown before that")
    how = "healthy"
    while True:
        left = target - env.monotonic()
        if left <= 0:
            break
        if env.stop.is_set() or env.sleep(min(left, 30.0)):
            how = "orderly shutdown"
            break
    now = env.wall()
    if how != "healthy":
        system = env.system_state()
        if system != "stopping":
            text = (f"stopped before the boot counted as healthy, and the system is not shutting down (systemctl is-system-running: {system or 'unknown'}): "
                    "no clean marker; the next boot skips and disarms unless the operator re-arms")
            env.say(4, f"linux-xtu-restore: {text}")
            _audit(env, "unclean_stop", "STOPPED_NOT_SHUTDOWN", text, op=AUDIT_OP + ".clean", boot_id=boot)
            return EXIT_FAILED
    lines = env.kernel_log("0")
    if lines is None:
        problem: tuple[str, str] | None = ("KERNEL_LOG_UNAVAILABLE", "this boot's kernel log cannot be read at the clean point")
    else:
        mce = hardware_errors(lines)
        faults = kernel_faults(lines[applied.klog_mark or 0:]) if applied.klog_mark is not None else kernel_faults(lines)
        problem = None
        if mce:
            problem = ("HARDWARE_ERROR_AFTER_APPLY", f"{len(mce)} machine-check / hardware-error line(s) this boot, first: {mce[0][:200]}")
        elif faults:
            problem = ("KERNEL_FAULT_AFTER_APPLY", f"{len(faults)} kernel fault line(s) after the apply, first: {faults[0][:200]}")
    if problem is not None:
        _record(env, True, boot, Outcome(EXIT_FAILED, "failed", problem[0], problem[1] + "; no clean marker", disarm=True))  # pending stays: the next boot sees it too
        return EXIT_FAILED

    def clean(state: dict[str, Any]) -> bool:
        changed = False
        if (state.get("pending") or {}).get("boot_id") == boot:
            state["pending"] = None
            changed = True
        last = state.get("last") or {}
        if last.get("boot_id") == boot:
            last["clean_at"], last["clean_how"] = _iso(now), how
            if state.get("history") and state["history"][-1].get("boot_id") == boot:
                state["history"][-1] = last
            changed = True
        return changed

    try:
        update_state(env, clean)
    except (StateError, TrustError, OSError) as exc:
        env.say(3, f"linux-xtu-restore: could not write the clean marker to {env.paths.state}: {exc}")
        return EXIT_FAILED
    _audit(env, "clean", "CLEAN", f"clean marker ({how}) at {env.monotonic():.0f} s running time; no hardware-error or kernel-fault line", op=AUDIT_OP + ".clean", boot_id=boot)
    env.say(5, f"linux-xtu-restore: boot marked clean ({how}, {env.monotonic():.0f} s running time, no machine-check / kernel-fault line)")
    return EXIT_OK


# ------------------------------------------------------------------------------------------------------------------------------------------
# arm / disarm / status (also the hooks a future helper op can call)
# ------------------------------------------------------------------------------------------------------------------------------------------
def arm(env: Env, *, by: str | None = None) -> dict[str, Any]:
    """Accept the current accepted state for the unattended boot restore: the same checks as a boot's (c), then ``armed``, the sha256 and the CPU identity are
    recorded and ``disarmed`` cleared; ``pending`` is cleared unless it is THIS boot's (a run still watching its apply keeps it). ``Skip`` when the state is
    not restorable (or the config would make every boot skip)."""
    cfg = load_config(env)
    if cfg.previous_boot_log == "require" and not os.path.isdir(env.paths.journal_dir):
        raise Skip("PREVIOUS_BOOT_LOG_UNAVAILABLE", f"the journal is not persistent ({env.paths.journal_dir} is missing), so every boot would skip: "
                                                     "mkdir -p /var/log/journal (then reboot once), or set previous_boot_log = \"ignore\" in /etc/linux-xtu/restore.toml")
    topology = env.detect()
    cpuinfo = _cpuinfo_text(env)
    identity = cpu_identity(cpuinfo)
    if identity is None:
        raise Skip("IDENTITY_UNKNOWN", "/proc/cpuinfo does not say vendor / family / model / brand")
    accepted = inspect_accepted(env, topology, cpuinfo)
    now, boot = env.wall(), env.boot_id()

    def change(state: dict[str, Any]) -> None:
        pending = state.get("pending") or None
        state.update(armed=True, armed_at=_iso(now), armed_by=by, accepted={"name": accepted.name, "sha256": accepted.sha256}, identity=identity, disarmed=None,
                     pending=pending if pending is not None and boot is not None and pending.get("boot_id") == boot else None)

    state = update_state(env, change, create=True, replace_unreadable=True)
    assert state is not None
    _audit(env, "armed", "ARMED", f"armed for accepted profile {accepted.name} (sha256 {accepted.sha256})", op=AUDIT_OP + ".arm", accepted=accepted.name,
           accepted_sha256=accepted.sha256, by=by)
    return state


def disarm(env: Env, reason: str = "disarmed by the operator", *, code: str = "OPERATOR") -> dict[str, Any]:
    now, boot = env.wall(), env.boot_id()

    def change(state: dict[str, Any]) -> None:
        state.update(armed=False, disarmed={"at": _iso(now), "boot_id": boot, "code": code, "reason": reason[:500]})

    state = update_state(env, change, create=True, replace_unreadable=True)
    assert state is not None
    _audit(env, "disarmed", code, reason, op=AUDIT_OP + ".disarm")
    return state


def status_doc(env: Env) -> dict[str, Any]:
    out: dict[str, Any] = {"state_file": str(env.paths.state), "config_file": str(env.paths.config)}
    try:
        out["state"] = load_state(env)
    except StateError as exc:
        out["state"], out["state_error"] = None, str(exc)
    try:
        out["config"] = dataclasses.asdict(load_config(env))
    except ConfigError as exc:
        out["config"], out["config_error"] = None, str(exc)
    out["armed"] = bool(out["state"] and out["state"].get("armed"))
    return out


def _print_status(doc: Mapping[str, Any], out: TextIO) -> None:
    st = doc.get("state")
    w = out.write
    if doc.get("state_error"):
        w(f"state:     UNREADABLE ({doc['state_error']})\n")
    elif st is None:
        w("state:     never armed\n")
    else:
        acc = st.get("accepted") or {}
        w(f"armed:     {'yes' if st.get('armed') else 'NO'}" + (f" (since {st.get('armed_at')}; accepted {acc.get('name')} sha256 {str(acc.get('sha256'))[:12]})" if st.get("armed") else "") + "\n")
        if st.get("disarmed") and not st.get("armed"):
            d = st["disarmed"]
            w(f"disarmed:  {d.get('at')} [{d.get('code')}] {d.get('reason')}\n")
        if st.get("pending"):
            p = st["pending"]
            w(f"pending:   apply of boot {p.get('boot_id')} at {p.get('started_at')} not yet marked clean\n")
        if st.get("last"):
            last = st["last"]
            w(f"last run:  {last.get('at')} {last.get('outcome')} [{last.get('code')}] {last.get('text')}" + (f"; clean {last.get('clean_at')} ({last.get('clean_how')})" if last.get("clean_at") else "") + "\n")
    cfg = doc.get("config")
    w(f"config:    {cfg if cfg is not None else 'INVALID: ' + str(doc.get('config_error'))}\n")
    w("timer:     systemctl is-enabled linux-xtu-restore.timer   (enable: sudo systemctl enable linux-xtu-restore.timer; disable: sudo systemctl disable linux-xtu-restore.timer)\n")
    w("re-arm:    sudo /usr/lib/linux-xtu/linux-xtu-restore arm      disarm: sudo /usr/lib/linux-xtu/linux-xtu-restore disarm\n")


def _who() -> str:
    sudo = os.environ.get("SUDO_USER", "")
    return f"root (sudo {sudo})" if _NAME_RE.fullmatch(sudo) else "root"


# ------------------------------------------------------------------------------------------------------------------------------------------
# main
# ------------------------------------------------------------------------------------------------------------------------------------------
def _install_signal_handlers(env: Env) -> None:
    def handler(signum: int, _frame: object) -> None:
        env.request_stop()

    for name in ("SIGTERM", "SIGHUP", "SIGINT"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), handler)


def main(argv: Sequence[str] | None = None, env: Env | None = None) -> int:
    parser = argparse.ArgumentParser(prog="linux-xtu-restore", description="Unattended boot restore of the accepted state (linux-xtu-restore.service).")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run", help="the unit's ExecStart: apply /etc/linux-xtu/accepted unless the crash-loop guard says no")
    sub.add_parser("arm", help="root: arm the boot restore for the current accepted state")
    p_dis = sub.add_parser("disarm", help="root: stop applying at boot until the next arm")
    p_dis.add_argument("--reason", default="disarmed by the operator")
    p_st = sub.add_parser("status", help="show the boot restore state")
    p_st.add_argument("--json", action="store_true")
    try:
        args = parser.parse_args(list(sys.argv[1:] if argv is None else argv))
    except SystemExit as exc:
        return EXIT_ERROR if exc.code else EXIT_OK
    if env is None:
        env = Env(syslog_prefix=bool(os.environ.get("JOURNAL_STREAM")))
    if args.cmd == "status":
        doc = status_doc(env)
        if args.json:
            env.out.write(json.dumps(doc, indent=1, sort_keys=True) + "\n")
        else:
            _print_status(doc, env.out)
        return EXIT_OK
    if env.require_root:
        if env.euid() != 0:
            env.say(3, f"linux-xtu-restore {args.cmd}: must run as root (sudo); the boot restore unit runs it as root")
            return EXIT_ERROR
        try:  # SPEC 4.4: root never runs code from a user-writable tree (a checkout, ~/.local)
            check_code_tree(Path(os.path.abspath(__file__)).parent, lstat_fn=env.lstat, listdir_fn=env.listdir)
        except TrustError as exc:
            env.say(3, f"linux-xtu-restore: refused: the code is not in a root-owned, non-writable tree (SPEC 4.4): {exc}")
            return EXIT_ERROR
    if args.cmd == "run":
        if threading.current_thread() is threading.main_thread():
            _install_signal_handlers(env)
        try:
            return run(env)
        except Exception as exc:  # an internal error is visible, never a silent success; pending (if set) stays, so the next boot skips
            env.say(3, f"linux-xtu-restore: internal error: {type(exc).__name__}: {exc}")
            return EXIT_ERROR
    try:
        if args.cmd == "arm":
            state = arm(env, by=_who())
            acc = state["accepted"]
            env.say(5, f"linux-xtu-restore: ARMED for accepted profile {acc['name']} (sha256 {acc['sha256'][:12]}); it is applied at the next boot if "
                       "linux-xtu-restore.timer is enabled (systemctl is-enabled linux-xtu-restore.timer). A new 'Set as accepted' needs a new arm.")
        else:
            disarm(env, args.reason)
            env.say(5, "linux-xtu-restore: DISARMED; nothing is applied at boot until: sudo /usr/lib/linux-xtu/linux-xtu-restore arm")
    except Skip as exc:
        env.say(3, f"linux-xtu-restore {args.cmd}: refused [{exc.code}]: {exc.text}")
        return EXIT_FAILED
    except (ConfigError, StateError, TrustError, OSError) as exc:
        env.say(3, f"linux-xtu-restore {args.cmd}: failed: {exc}")
        return EXIT_FAILED
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
