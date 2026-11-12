"""Preflight (SPEC section 3): pure checks over an injectable filesystem root. Read-only, no hardware access; the only subprocess is the boot restore timer's ``systemctl is-enabled`` (root "/" only).

``preflight(root)`` reads a handful of small files under ``root`` (``/proc/cpuinfo``, ``/sys/kernel/security/lockdown``, ``/dev/cpu/*/msr``,
``/sys/module/msr/parameters/allow_writes``, the helper socket node and ``/etc/linux-xtu/helper.toml``, executables in the usual bin directories) and returns one named ``CheckResult``
per check. A failed check is a named refusal, never a workaround. "Recognised platform" is CPUID (vendor, family, model on every CPU; an unknown stepping is a
WARN) plus a live topology check (P and E CPU sets non-empty, E clusters of equal size, derived from sysfs, D-036). The result also carries the live
``topology`` (units, favored cores) for the GUI. It also reports ``boot_restore`` (QA-35): whether the packaged ``linux-xtu-restore.timer`` will bring the
accepted state back after a boot (``not_installed`` | ``disarmed`` | ``armed`` | ``unknown``), from unit files, the timer's ``systemctl is-enabled`` answer
(read-only, argument list, absolute path, timeout; any failure is ``unknown``) and ``/var/lib/linux-xtu/bootrestore.json``.
"""
from __future__ import annotations

import os
import json
import re
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from linux_xtu.topology import Topology, TopologyError, contract_dict, read_live, topology_problems

from .schema import Platform, default_platform

__all__ = [
    "MIN_PYTHON",
    "OPTIONAL_TOOLS",
    "CheckResult",
    "PreflightReport",
    "Status",
    "check_boot_restore",
    "preflight",
]

MIN_PYTHON = (3, 12)
DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"

#: optional tool -> package hint for "missing: install <pkg>" (SPEC section 3).
OPTIONAL_TOOLS: dict[str, str] = {
    "stress-ng": "stress-ng",
    "stressapptest": "stressapptest",
    "perf": "perf (Fedora) / linux-tools (Debian, Ubuntu)",
    "turbostat": "kernel-tools (Fedora) / linux-tools (Debian, Ubuntu)",
    "sensors": "lm_sensors (Fedora) / lm-sensors (Debian, Ubuntu)",
    "nvidia-smi": "the NVIDIA driver utilities (nvidia-utils / nvidia-smi)",
}

class Status(Enum):
    PASS = "pass"
    READ_ONLY = "read-only"  # the machine can be read but writes are not possible / not allowed
    REFUSE = "refuse"  # the app cannot run at all
    UNKNOWN = "unknown"  # not determinable from here (unprivileged); the root helper's re-run is authoritative; never changes the mode
    MISSING = "missing"  # an optional feature's tool is absent (the feature shows "missing: install <pkg>")
    WARN = "warn"  # worth knowing, never blocks (e.g. an unknown stepping of the recognised family); does not change the mode


@dataclass(frozen=True)
class CheckResult:
    name: str
    status: Status
    reason: str  # human explanation, also for PASS (what was seen)

    @property
    def ok(self) -> bool:
        return self.status is Status.PASS


@dataclass(frozen=True)
class PreflightReport:
    platform_id: str
    results: tuple[CheckResult, ...]
    topology: Mapping[str, Any] | None = None  # contract: {units: [{id, kind, cpus, favored, max_ratio, perf}], favored_source}; None = not derived
    board: str | None = None  # DMI board_name, if readable
    boot_restore: Mapping[str, str] | None = None  # contract: {state: not_installed|disarmed|armed|unknown, note, timer?: enabled|disabled|masked|unknown|absent, armed?: yes|no|unknown (G-249, additive)}; None = not asked (old callers)

    def get(self, name: str) -> CheckResult:
        for r in self.results:
            if r.name == name:
                return r
        raise KeyError(name)

    @property
    def refused(self) -> bool:
        return any(r.status is Status.REFUSE for r in self.results)

    @property
    def mode(self) -> str:
        """``"refuse"`` | ``"read-only"`` | ``"write"``. MISSING optional tools never change the mode."""
        if self.refused:
            return "refuse"
        return "read-only" if any(r.status is Status.READ_ONLY for r in self.results) else "write"

    @property
    def writes_allowed(self) -> bool:
        return self.mode == "write"

    def problems(self) -> tuple[CheckResult, ...]:
        return tuple(r for r in self.results if r.status in (Status.READ_ONLY, Status.REFUSE))

    def to_dict(self) -> dict[str, object]:
        """JSON-able form for the helper protocol (op ``preflight``)."""
        return {
            "platform": self.platform_id,
            "mode": self.mode,
            "checks": [{"name": r.name, "status": r.status.value, "reason": r.reason} for r in self.results],
            "topology": dict(self.topology) if self.topology is not None else {"units": [], "favored_source": None},
            "board": self.board,
            **({"boot_restore": dict(self.boot_restore)} if self.boot_restore is not None else {}),
        }


# --- individual checks (each pure: root-relative reads only) -------------------------------------------------------------------------------

def _read(root: Path, rel: str) -> str:
    return (root / rel).read_text(encoding="utf-8", errors="replace")


def _cpuinfo_blocks(text: str) -> list[dict[str, str]]:
    blocks: list[dict[str, str]] = []
    cur: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            if cur:
                blocks.append(cur)
                cur = {}
            continue
        key, sep, value = line.partition(":")
        if sep:
            cur.setdefault(key.strip(), value.strip())
    if cur:
        blocks.append(cur)
    return [b for b in blocks if "processor" in b]


def check_cpuid(blocks: Sequence[dict[str, str]] | None, plat: Platform) -> CheckResult:
    """Vendor, family and model must match the platform on every CPU (else READ_ONLY); a stepping the platform file does not list is a WARN, not a refusal."""
    name = "cpuid"
    if not blocks:
        return CheckResult(name, Status.READ_ONLY, "/proc/cpuinfo is unreadable or has no processor entries: CPU not recognised")
    want = plat.cpuid
    seen_steppings: set[int] = set()
    for b in blocks:
        try:
            got = (b.get("vendor_id", ""), int(b.get("cpu family", "")), int(b.get("model", "")), int(b.get("stepping", "")))
        except ValueError:
            return CheckResult(name, Status.READ_ONLY, f"processor {b.get('processor', '?')}: cpu family/model/stepping missing or not numeric")
        if got[:3] != (want.vendor, want.family, want.model):
            return CheckResult(
                name,
                Status.READ_ONLY,
                f"processor {b.get('processor', '?')}: {got[0]!r} family {got[1]} model {got[2]} stepping {got[3]} is not an Arrow Lake-S CPU "
                f"(platform {plat.id}: {want.vendor!r} family {want.family} model {want.model})",
            )
        seen_steppings.add(got[3])
    unknown = sorted(seen_steppings - set(want.steppings))
    steppings = ", ".join(map(str, sorted(seen_steppings)))
    if unknown:
        return CheckResult(
            name,
            Status.WARN,
            f"stepping {steppings} of this Arrow Lake-S CPU is not among the platform file's known steppings {list(want.steppings)}: the family and model match, "
            "so nothing is blocked",
        )
    return CheckResult(name, Status.PASS, f"family {want.family} model {want.model} stepping {steppings} matches platform {plat.id} on all {len(blocks)} CPUs")


def check_hypervisor(blocks: Sequence[dict[str, str]] | None) -> CheckResult:
    name = "hypervisor"
    if not blocks:
        return CheckResult(name, Status.READ_ONLY, "cannot read /proc/cpuinfo flags: cannot rule out a hypervisor")
    if any("hypervisor" in b.get("flags", "").split() for b in blocks):
        return CheckResult(name, Status.READ_ONLY, "the 'hypervisor' cpuinfo flag is set: running under a hypervisor, MSR writes do not reach the hardware")
    if not any("flags" in b for b in blocks):
        return CheckResult(name, Status.READ_ONLY, "/proc/cpuinfo has no flags line: cannot rule out a hypervisor")
    return CheckResult(name, Status.PASS, "no 'hypervisor' cpuinfo flag")


_LOCKDOWN_WORD = re.compile(r"\[([a-z-]+)\]")


def check_lockdown(root: Path) -> CheckResult:
    name = "lockdown"
    try:
        text = _read(root, "sys/kernel/security/lockdown")
    except FileNotFoundError:
        return CheckResult(name, Status.PASS, "no /sys/kernel/security/lockdown (kernel without the lockdown LSM): nothing blocks MSR writes")
    except OSError as exc:
        return CheckResult(name, Status.READ_ONLY, f"cannot read /sys/kernel/security/lockdown ({exc.strerror or exc}): lockdown state unknown")
    m = _LOCKDOWN_WORD.findall(text)
    if len(m) != 1:
        return CheckResult(name, Status.READ_ONLY, f"unparsable lockdown file {text.strip()!r}: expected exactly one bracketed word")
    if m[0] != "none":
        return CheckResult(name, Status.READ_ONLY, f"kernel lockdown is [{m[0]}] (Secure Boot lockdown blocks MSR writes); needs [none]")
    return CheckResult(name, Status.PASS, "lockdown [none]")


def _msr_loadable(root: Path) -> bool:
    try:
        release = _read(root, "proc/sys/kernel/osrelease").strip()
    except OSError:
        return False
    if not release or "/" in release:
        return False
    base = root / "lib" / "modules" / release
    for sub in ("kernel/arch/x86/kernel", "kernel/drivers"):
        d = base / sub
        try:
            if d.is_dir() and any(p.name.startswith("msr.ko") for p in d.iterdir()):
                return True
        except OSError:
            continue
    return False


def check_msr_device(root: Path, cpus: Sequence[int] | None) -> CheckResult:
    """``/dev/cpu/<n>/msr`` must exist for every CPU of the live topology (``cpus``); without a topology the CPUs are not known."""
    name = "msr_device"
    if not cpus:
        return CheckResult(name, Status.READ_ONLY, "the CPU list is not known (see the topology check): /dev/cpu/*/msr cannot be checked")
    missing = [c for c in cpus if not (root / "dev" / "cpu" / str(c) / "msr").exists()]
    if not missing:
        return CheckResult(name, Status.PASS, f"/dev/cpu/<n>/msr present for all {len(cpus)} CPUs ({min(cpus)}..{max(cpus)})")
    where = f"/dev/cpu/{missing[0]}/msr" if len(missing) == 1 else f"/dev/cpu/*/msr for {len(missing)} of {len(cpus)} CPUs (first: {missing[0]})"
    if (root / "sys" / "module" / "msr").exists():
        hint = "the msr module is loaded or built in but the device nodes are absent (devtmpfs/udev problem)"
    elif _msr_loadable(root):
        hint = "the msr module is loadable: load it (modprobe msr) as an explicit operator step"
    else:
        hint = "the msr module is neither loaded, built in nor found under /lib/modules"
    return CheckResult(name, Status.READ_ONLY, f"{where} missing: {hint}")


def check_topology(topology: Topology | None, why: str | None) -> CheckResult:
    """The live topology is usable: P and E CPU sets non-empty, E clusters of equal size (the Arrow Lake-S layout)."""
    name = "topology"
    if topology is None:
        return CheckResult(name, Status.READ_ONLY, f"the CPU topology could not be derived from sysfs: {why}")
    problems = topology_problems(topology)
    if problems:
        return CheckResult(name, Status.READ_ONLY, "the CPU topology is not an Arrow Lake-S layout: " + "; ".join(problems))
    p, e = len(topology.cpus_of_kind("P")), len(topology.cpus_of_kind("E"))
    clusters = len({c.cluster for c in topology.cores if c.cluster is not None})
    favored = [f"P{c.index}" for c in topology.cores if c.favored]
    fav = f"; favored by {topology.favored_source}: {', '.join(favored)}" if favored else "; no favored core (all P-cores report the same performance)"
    return CheckResult(name, Status.PASS, f"{p} P-cores + {e} E-cores in {clusters} clusters of {e // clusters}{fav}")


def read_board_name(root: Path) -> str | None:
    """DMI ``board_name`` (``/sys/class/dmi/id/board_name``), or None."""
    try:
        text = _read(root, "sys/class/dmi/id/board_name").strip()
    except OSError:
        return None
    return text or None


def check_msr_allow_writes(root: Path) -> CheckResult:
    name = "msr_allow_writes"
    path = root / "sys" / "module" / "msr" / "parameters" / "allow_writes"
    try:
        value = path.read_text(encoding="utf-8", errors="replace").strip()
    except FileNotFoundError:
        if (root / "sys" / "module" / "msr").exists():
            return CheckResult(name, Status.PASS, "msr has no allow_writes parameter (kernel predating it): writes not gated by it")
        return CheckResult(name, Status.READ_ONLY, "msr module not present (see msr_device): allow_writes cannot be read")
    except OSError as exc:
        # /sys/module/msr/parameters/allow_writes is mode 0600 (arch/x86/kernel/msr.c): an unprivileged run cannot read it. That is not evidence
        # of "off", so it must not downgrade the mode; the helper (root) re-runs preflight before every apply.
        return CheckResult(name, Status.UNKNOWN, f"cannot read msr allow_writes ({exc.strerror or exc}; root-only file): the root helper's preflight decides")
    if value == "off":
        return CheckResult(name, Status.READ_ONLY, "msr.allow_writes=off: the kernel refuses MSR writes (boot without msr.allow_writes=off, or set it to on/default)")
    if value not in ("on", "default", ""):
        return CheckResult(name, Status.READ_ONLY, f"msr.allow_writes={value!r} is not one of on/default/off")
    return CheckResult(name, Status.PASS, f"msr.allow_writes={value or 'default'}")


def _find_exe(root: Path, name: str, path_dirs: Iterable[str]) -> Path | None:
    for d in path_dirs:
        cand = root / d.lstrip("/") / name
        try:
            if cand.is_file() and os.access(cand, os.X_OK):
                return cand
        except OSError:
            continue
    return None


#: The helper's socket, relative to the preflight root (D-043); ``linux_xtu.helper.service.SOCKET_PATH`` is the same path.
HELPER_SOCKET = "run/linux-xtu/helper.sock"
HELPER_TOML = "etc/linux-xtu/helper.toml"


def check_helper_service(root: Path, *, applies: bool = True) -> CheckResult:
    """The root helper is a service on ``/run/linux-xtu/helper.sock`` (D-043): the node is a socket owned by root (its mode, 0666 or 0660, is not judged:
    the peer check is the gate), and
    ``/etc/linux-xtu/helper.toml`` admits somebody (``[access]`` non-empty and valid). It does not connect (the socket serves one client, and the one that
    asks is usually that client). ``applies=False``: the helper is not serving a socket (simulator, stdio dev path) and the check passes as not applicable."""
    name = "helper_service"
    if not applies:
        return CheckResult(name, Status.PASS, "not applicable: this helper does not serve the socket (simulator or stdio)")
    import stat

    node = root / HELPER_SOCKET
    try:
        st = os.lstat(node)
    except OSError:
        return CheckResult(name, Status.READ_ONLY, "the helper socket /run/linux-xtu/helper.sock is missing: run install.sh (it enables linux-xtu-helper.socket)")
    if not stat.S_ISSOCK(st.st_mode):
        return CheckResult(name, Status.READ_ONLY, "/run/linux-xtu/helper.sock is not a socket")
    if st.st_uid != 0 and root == Path("/"):
        return CheckResult(name, Status.READ_ONLY, f"/run/linux-xtu/helper.sock belongs to uid {st.st_uid}, not root")
    from linux_xtu.helper.settings import parse_helper_toml  # lazy: linux_xtu.helper imports this module

    try:
        access = parse_helper_toml(_read(root, HELPER_TOML), "/etc/linux-xtu/helper.toml").access
    except FileNotFoundError:
        return CheckResult(name, Status.READ_ONLY, "/etc/linux-xtu/helper.toml is missing: nobody is allowed to use the helper (run install.sh)")
    except (OSError, ValueError) as exc:
        return CheckResult(name, Status.READ_ONLY, f"/etc/linux-xtu/helper.toml cannot be used: {exc}")
    if access.empty:
        return CheckResult(name, Status.READ_ONLY, "/etc/linux-xtu/helper.toml has no [access] users or group: nobody is allowed to use the helper (sudo bash install.sh --add-user NAME)")
    who = ", ".join([*access.users, *([f"group {access.group}"] if access.group else [])])
    return CheckResult(name, Status.PASS, f"helper socket present (root-owned, mode {stat.S_IMODE(st.st_mode):04o}); allowed: {who}")


def check_python(version: Sequence[int]) -> CheckResult:
    v = tuple(version[:3])
    text = ".".join(str(x) for x in v)
    if v < MIN_PYTHON:
        return CheckResult("python", Status.REFUSE, f"Python {text} is older than the required {MIN_PYTHON[0]}.{MIN_PYTHON[1]}")
    return CheckResult("python", Status.PASS, f"Python {text}")


def check_tools(root: Path, path_dirs: Sequence[str], tools: dict[str, str]) -> list[CheckResult]:
    out = []
    for tool, pkg in tools.items():
        where = _find_exe(root, tool, path_dirs)
        if where is None:
            out.append(CheckResult(f"tool:{tool}", Status.MISSING, f"missing: install {pkg}"))
        else:
            out.append(CheckResult(f"tool:{tool}", Status.PASS, f"{tool} found"))
    return out


# --- boot restore (QA-35) ---------------------------------------------------------------------------------------------------------------

BOOT_TIMER = "linux-xtu-restore.timer"
SYSTEMCTL = "/usr/bin/systemctl"
SYSTEMCTL_TIMEOUT_S = 5.0
BOOT_STATE_FILE = "var/lib/linux-xtu/bootrestore.json"
_UNIT_DIRS = ("etc/systemd/system", "usr/lib/systemd/system", "lib/systemd/system", "usr/local/lib/systemd/system")
_ENABLE_CMD = f"sudo systemctl enable {BOOT_TIMER}"
_ARM_CMD = "sudo /usr/lib/linux-xtu/linux-xtu-restore arm"
#: R2-07: the one command that turns the boot restore fully on (the page shows the same text; ``install.sh --enable-boot-restore`` does both too).
ENABLE_AND_ARM_CMD = f"{_ENABLE_CMD} && {_ARM_CMD}"
_ENABLED_WORDS = frozenset({"enabled", "enabled-runtime", "alias", "linked", "linked-runtime"})
_DISABLED_WORDS = frozenset({"disabled", "masked", "masked-runtime", "static", "indirect", "generated", "transient", "bad", "not-found"})

#: ``(args) -> (returncode, stdout)``; None return = the call could not be made / timed out.
SystemctlFn = Callable[[Sequence[str]], "tuple[int, str] | None"]


def _real_systemctl(args: Sequence[str]) -> tuple[int, str] | None:
    """Run ``/usr/bin/systemctl <args>`` read-only: argument list (no shell), absolute path, timeout. None when it cannot run or does not finish."""
    if not os.access(SYSTEMCTL, os.X_OK):
        return None
    try:
        cp = subprocess.run([SYSTEMCTL, *args], capture_output=True, text=True, timeout=SYSTEMCTL_TIMEOUT_S, check=False, stdin=subprocess.DEVNULL,
                            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
    except (OSError, subprocess.SubprocessError):
        return None
    return cp.returncode, cp.stdout


def _timer_unit(root: Path) -> tuple[Path | None, bool]:
    """``(unit file, masked)``: the first packaged/installed ``linux-xtu-restore.timer`` under ``root``; a link to /dev/null is a mask."""
    for d in _UNIT_DIRS:
        cand = root / d / BOOT_TIMER
        try:
            if os.path.islink(cand) and os.readlink(cand) == "/dev/null":
                return cand, True
            if cand.is_file():
                return cand, False
        except OSError:
            continue
    return None, False


def _timer_wanted_by_link(root: Path) -> bool:
    """File evidence of ``systemctl enable``: a ``*.wants/linux-xtu-restore.timer`` link in /etc/systemd/system."""
    base = root / "etc" / "systemd" / "system"
    try:
        return any((w / BOOT_TIMER).exists() or os.path.islink(w / BOOT_TIMER) for w in base.glob("*.wants"))
    except OSError:
        return False


def _timer_enabled(root: Path, systemctl: SystemctlFn | None) -> bool | None:
    """True / False, or None when it cannot be told (fail closed)."""
    if systemctl is None and root == Path("/"):
        systemctl = _real_systemctl
    if systemctl is not None:
        try:
            got = systemctl(["is-enabled", BOOT_TIMER])
        except Exception:
            got = None
        if got is not None:
            lines = (got[1] or "").strip().splitlines()
            word = lines[0].strip() if lines else ""
            if word in _ENABLED_WORDS:
                return True
            if word in _DISABLED_WORDS:
                return False
        # systemctl gave no usable answer: the wants link is positive evidence of "enabled"; its absence proves nothing
        return True if _timer_wanted_by_link(root) else None
    return _timer_wanted_by_link(root)  # no systemctl at all (a fake root): the files are the state


BOOT_STATE_MAX_BYTES = 4096


def _read_state_file(path: Path) -> str:
    """G-248: ``bootrestore.json`` through the repo's trust-checked open (O_NOFOLLOW, regular file, one link, no group/other write bit, owned by root or by us),
    at most ``BOOT_STATE_MAX_BYTES``. A refusal or an oversized file is a ``ValueError`` (the caller says ``unknown``); a missing file is ``FileNotFoundError``."""
    from linux_xtu.helper.trust import TrustError, open_checked  # late: linux_xtu.helper imports this module

    fd = -1
    for euid in dict.fromkeys((0, os.geteuid())):  # the restore tool writes it as root; a fake root in a test is ours
        try:
            fd = open_checked(path, write=False, create=False, euid=euid, what="boot restore state")
            break
        except TrustError as exc:
            last = exc
    if fd < 0:
        raise ValueError(str(last))
    with os.fdopen(fd, "rb") as handle:
        data = handle.read(BOOT_STATE_MAX_BYTES + 1)
    if len(data) > BOOT_STATE_MAX_BYTES:
        raise ValueError(f"larger than {BOOT_STATE_MAX_BYTES} bytes")
    return data.decode("utf-8")


def _arm_state(root: Path) -> tuple[bool | None, dict[str, Any]]:
    """R2-07: ``(armed, doc)`` from the restore state file: True / False, or None when it cannot be read. A missing file is "never armed" (False, empty doc)."""
    try:
        doc = json.loads(_read_state_file(root / BOOT_STATE_FILE))
        if not isinstance(doc, dict) or not isinstance(doc.get("armed"), bool):
            raise ValueError("not a boot restore state")
    except FileNotFoundError:
        return False, {}
    except (OSError, ValueError) as exc:
        return None, {"error": str(exc)}
    return doc["armed"], doc


def check_boot_restore(root: Path = Path("/"), *, systemctl: SystemctlFn | None = None) -> dict[str, str]:
    """QA-35: ``{state, note, timer, armed}`` for the boot restore. ``not_installed`` (no timer unit), ``armed`` (timer enabled AND the restore state file says armed),
    ``disarmed`` (installed but off: timer disabled/masked, or the state file not armed), ``unknown`` (installed but the state cannot be read). Read-only.
    G-249 (R2-07): ``timer`` (``enabled`` | ``disabled`` | ``masked`` | ``unknown`` | ``absent``) and ``armed`` (``yes`` | ``no`` | ``unknown``) are additive: the two halves told apart, so a
    page can show ONE command that finishes the job (enabling the timer alone leaves it disarmed; arming alone leaves it never started). ``note`` names the command that is still needed.
    ``systemctl``: a fake for tests; for the real root ``/usr/bin/systemctl is-enabled`` is asked (timeout, no shell)."""
    root = Path(root)
    unit, masked = _timer_unit(root)
    if unit is None:
        return {"state": "not_installed", "timer": "absent", "armed": "unknown",
                "note": f"{BOOT_TIMER} is not installed: nothing restores the accepted state after a boot (run install.sh --enable-boot-restore)."}
    enabled = False if masked else _timer_enabled(root, systemctl)
    timer = "masked" if masked else "unknown" if enabled is None else "enabled" if enabled else "disabled"
    armed, doc = _arm_state(root)
    arm_word = "unknown" if armed is None else "yes" if armed else "no"
    tail = {"timer": timer, "armed": arm_word}
    if enabled is None:
        return {"state": "unknown", "note": f"The state of {BOOT_TIMER} could not be read (systemctl is-enabled gave no answer). Check: systemctl is-enabled {BOOT_TIMER}", **tail}
    if not enabled:
        what = "masked" if masked else "installed but disabled"
        if masked:
            return {"state": "disarmed", "note": f"Boot restore is off: {BOOT_TIMER} is masked. Unmask it, then run: {_ENABLE_CMD}", **tail}
        if armed:
            return {"state": "disarmed", "note": f"The restore is armed, but {BOOT_TIMER} is {what}, so a boot applies nothing. Run: {_ENABLE_CMD}", **tail}
        return {"state": "disarmed", "note": f"Boot restore is off: {BOOT_TIMER} is {what} and the restore is not armed. To bring the accepted state back after a boot, run: {ENABLE_AND_ARM_CMD}", **tail}
    if armed is None:
        return {"state": "unknown", "note": f"{BOOT_TIMER} is enabled but the restore state file cannot be read ({doc.get('error')}); re-arm: {_ARM_CMD}", **tail}
    if not armed and not doc:
        return {"state": "disarmed", "note": f"{BOOT_TIMER} is enabled but the restore was never armed, so a boot applies nothing. Run: {_ARM_CMD}", **tail}
    if armed:
        acc = doc.get("accepted") if isinstance(doc.get("accepted"), dict) else {}
        name = acc.get("name")
        return {"state": "armed", "note": f"{BOOT_TIMER} is enabled and armed" + (f" for the accepted state {name}." if isinstance(name, str) and name else "."), **tail}
    why = doc.get("disarmed") if isinstance(doc.get("disarmed"), dict) else {}
    reason = why.get("reason")
    return {"state": "disarmed", "note": f"{BOOT_TIMER} is enabled but the restore is disarmed" + (f" ({reason[:200]})" if isinstance(reason, str) and reason else "")
            + f". To arm it again, run: {_ARM_CMD}", **tail}


def _boot_restore_uncached(root: Path, systemctl: SystemctlFn | None) -> dict[str, str]:
    try:
        return check_boot_restore(root, systemctl=systemctl)
    except Exception as exc:  # fail closed: preflight never fails because of this panel
        return {"state": "unknown", "note": f"The boot restore state could not be read: {type(exc).__name__}: {exc}"}


#: G-248: the real machine's answer is cached for BOOT_RESTORE_TTL_S, so the helper's write gate (a fresh preflight before every write) does not spawn systemctl each time.
BOOT_RESTORE_TTL_S = 60.0
_clock: Callable[[], float] = time.monotonic  # tests replace it
_cache_lock = threading.Lock()
_cache: tuple[float, dict[str, str]] | None = None


def clear_boot_restore_cache() -> None:
    global _cache
    with _cache_lock:
        _cache = None


def _boot_restore_safe(root: Path, systemctl: SystemctlFn | None) -> dict[str, str]:
    if systemctl is not None or root != Path("/"):
        return _boot_restore_uncached(root, systemctl)  # a fake systemctl / a fake root: always fresh
    global _cache
    with _cache_lock:
        now = _clock()
        if _cache is not None and 0 <= now - _cache[0] < BOOT_RESTORE_TTL_S:
            return dict(_cache[1])
        got = _boot_restore_uncached(root, None)
        _cache = (now, dict(got))
        return got


# --- entry point -------------------------------------------------------------------------------------------------------------------------

def preflight(
    root: Path = Path("/"),
    *,
    platform: Platform | None = None,
    topology: Topology | None = None,
    python_version: Sequence[int] | None = None,
    path_dirs: Sequence[str] | None = None,
    tools: dict[str, str] | None = None,
    helper_service: bool = True,
    systemctl: SystemctlFn | None = None,
    boot_restore: Mapping[str, str] | None = None,
) -> PreflightReport:
    """Run every SPEC section 3 check against the filesystem under ``root`` and return the named results (never raises on a missing file).
    ``topology``: the topology to report instead of deriving it from ``root/sys`` (the simulator's). ``helper_service=False``: the helper
    that runs this does not serve the socket (simulator, stdio dev path), so that check is not applicable.
    ``systemctl``: a fake answering ``is-enabled`` for the boot restore timer (tests); the real root asks ``/usr/bin/systemctl`` (read-only, timeout).
    ``boot_restore``: the answer to report instead of looking at ``root`` / systemctl (the simulator's fixed one: it must not read the host)."""
    root = Path(root)
    plat = platform if platform is not None else default_platform()
    topo, topo_why = topology, None
    if topo is None:
        try:
            topo = read_live(root / "sys").topology
        except (TopologyError, OSError) as exc:
            topo, topo_why = None, str(exc)
    cpus = None if topo is None else sorted(c.cpu for c in topo.cores)
    dirs = tuple(path_dirs) if path_dirs is not None else tuple(DEFAULT_PATH.split(":"))
    version = tuple(python_version) if python_version is not None else tuple(sys.version_info[:3])

    try:
        blocks: list[dict[str, str]] | None = _cpuinfo_blocks(_read(root, "proc/cpuinfo")) or None
    except OSError:
        blocks = None

    checks: list[Callable[[], CheckResult | list[CheckResult]]] = [
        lambda: check_cpuid(blocks, plat),
        lambda: check_hypervisor(blocks),
        lambda: check_lockdown(root),
        lambda: check_topology(topo, topo_why),
        lambda: check_msr_device(root, cpus),
        lambda: check_msr_allow_writes(root),
        lambda: check_helper_service(root, applies=helper_service),
        lambda: check_python(version),
        lambda: check_tools(root, dirs, OPTIONAL_TOOLS if tools is None else tools),
    ]
    results: list[CheckResult] = []
    for run in checks:
        r = run()
        results.extend(r if isinstance(r, list) else [r])
    return PreflightReport(plat.id, tuple(results), None if topo is None else contract_dict(topo), read_board_name(root),
                           dict(boot_restore) if boot_restore is not None else _boot_restore_safe(root, systemctl))
