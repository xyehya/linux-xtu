"""Path constants and the default lock / audit paths (D-030, D-041; R-D1): one module for the CLI, the helper launcher and the boot restore.

* The installed layout (``INSTALLED_*``, SPEC 4.4 / 11, created by ``install.sh``): everything the root helper trusts lives under these root-owned paths.
  ``linux_xtu.helper.config`` re-exports them.
* The D-030 rule (:func:`installed_state`): a machine is *installed* when ``/etc/linux-xtu/policy.toml`` exists and passes the helper's trust check; then
  :func:`default_audit_path` / :func:`default_lock_path` are the installed ones, else the per-user ones (D-041). :func:`sim_lock_path` is a simulator run's own lock.

Importing this module imports nothing of ``linux_xtu.helper`` (the trust check is imported when :func:`installed_state` runs): the CLI imports it at load time, and the
helper launcher imports it instead of the CLI.
"""
from __future__ import annotations

import os
import tempfile
from collections.abc import Callable, Mapping
from pathlib import Path

__all__ = [
    "INSTALLED_ACCEPTED_DIR", "INSTALLED_AUDIT", "INSTALLED_CODE_DIR", "INSTALLED_HELPER", "INSTALLED_HELPER_TOML", "INSTALLED_LOCK", "INSTALLED_LOCK_DIR",
    "INSTALLED_PLATFORMS_DIR", "INSTALLED_POLICY", "INSTALLED_SOCKET", "INSTALLED_STATE_DIR", "TMPFILES_CONF", "InstalledStateRefused", "default_audit_path",
    "default_lock_path", "installed_state", "legacy_lock_companions", "sim_lock_path", "LEGACY_INSTALLED_POLICY", "LEGACY_INSTALLED_LOCK",
]

# The installed layout (SPEC 4.4 / 11, D-030; created by ``install.sh``). Everything the root helper trusts lives under these root-owned paths.
INSTALLED_CODE_DIR = Path("/usr/lib/linux-xtu")  # the ``linux_xtu`` package is INSTALLED_CODE_DIR / "linux_xtu", platform files in ../platforms
INSTALLED_PLATFORMS_DIR = INSTALLED_CODE_DIR / "platforms"
INSTALLED_HELPER = INSTALLED_CODE_DIR / "linux-xtu-helper"  # the ExecStart of linux-xtu-helper.service: ``<this> --device --socket`` (D-043)
INSTALLED_POLICY = Path("/etc/linux-xtu/policy.toml")  # its presence + trust is the CLI's "installed" test (D-030)
INSTALLED_HELPER_TOML = Path("/etc/linux-xtu/helper.toml")
INSTALLED_ACCEPTED_DIR = Path("/etc/linux-xtu/accepted")
INSTALLED_STATE_DIR = Path("/var/lib/linux-xtu")
INSTALLED_AUDIT = INSTALLED_STATE_DIR / "audit.jsonl"
INSTALLED_LOCK_DIR = Path("/run/linux-xtu")  # tmpfiles.d: 0755 root (``/run/lock`` is 1777: anyone could pre-create the lock file there)
INSTALLED_LOCK = INSTALLED_LOCK_DIR / "mailbox.lock"
INSTALLED_SOCKET = INSTALLED_LOCK_DIR / "helper.sock"  # the helper service's socket (D-043); ``linux_xtu.helper.service.SOCKET_PATH`` is the same path


class InstalledStateRefused(Exception):
    """``/etc/linux-xtu/policy.toml`` exists but fails the helper's trust check (D-030), or an install of the earlier name was not migrated (D-054): refuse,
    never fall back to the per-user paths."""


TMPFILES_CONF = "/usr/lib/tmpfiles.d/linux-xtu.conf"  # creates INSTALLED_LOCK_DIR at boot

# The project's earlier name (D-054, docs/NAMING.md; review F3). Code of that name uses other lock files than this code, so the two would never block each
# other: while its installed policy exists the install is not migrated and device runs of this code refuse (installed_state); and a device run of this code
# with the installed lock also holds the old installed lock (legacy_lock_companions: /run/arltuner only), so old code cannot interleave with the helper.
LEGACY_INSTALLED_POLICY = Path("/etc/arltuner/policy.toml")
LEGACY_INSTALLED_LOCK = Path("/run/arltuner/mailbox.lock")
DEV_LOCK_NAME = "linux-xtu-mailbox.lock"


def installed_state(lstat_fn: Callable[[str], object] = os.lstat) -> bool:
    """D-030: the machine is *installed* when ``/etc/linux-xtu/policy.toml`` exists and passes the helper's own trust check
    (``linux_xtu.helper.trust``: root-owned, not group/world-writable, no symlink, root-owned parents). Absent => ``False`` (per-user paths
    unchanged). Present but untrusted => :class:`InstalledStateRefused` (no fallback: a planted file must not silently route the
    guard's lock and audit log elsewhere). ``/etc/arltuner/policy.toml`` present (an install of the earlier name, not migrated) =>
    :class:`InstalledStateRefused` too: its helper and scripts take other lock files, so this code must not touch the mailbox until ``install.sh`` migrated it."""
    from linux_xtu.helper.trust import TrustError, check_trusted_path  # lazy: importing this module (the CLI does) must not import the helper package

    try:
        lstat_fn(os.fspath(LEGACY_INSTALLED_POLICY))
    except (FileNotFoundError, NotADirectoryError):
        pass
    except OSError:
        raise InstalledStateRefused(f"{LEGACY_INSTALLED_POLICY} cannot be examined; refusing until it is clear whether an arltuner install is present") from None
    else:
        raise InstalledStateRefused(
            f"{LEGACY_INSTALLED_POLICY} exists: an install of the earlier name (arltuner) is present and was not migrated. Its helper and scripts "
            "take other lock files than this code, so nothing is sent until it is: run sudo bash install.sh from this checkout (it migrates the install and "
            "retires the old one; docs/RUNBOOK-lnx.md section 6). Nothing was sent."
        )
    try:
        lstat_fn(os.fspath(INSTALLED_POLICY))
    except (FileNotFoundError, NotADirectoryError):
        return False
    except OSError:
        pass  # exists but cannot be examined: the trust check below refuses it by name
    try:
        check_trusted_path(INSTALLED_POLICY, want="file", lstat_fn=lstat_fn)
    except TrustError as exc:
        raise InstalledStateRefused(
            f"{INSTALLED_POLICY} is present but not trusted ({exc.path}: {exc.reason}); the CLI will not guess between the installed and the "
            "per-user lock/audit paths. Repair the install (re-run install.sh as root) or pass explicit --audit and --lock. "
        ) from None
    return True


def default_audit_path(
    env: Mapping[str, str], windows: bool = os.name == "nt", lstat_fn: Callable[[str], object] = os.lstat, consider_install: bool = True
) -> Path:
    """Installed machine (D-030, not Windows): ``/var/lib/linux-xtu/audit.jsonl``. Otherwise the per-user path
    ``$XDG_STATE_HOME/linux-xtu/audit.jsonl`` (an absolute ``XDG_STATE_HOME``; default ``~/.local/state/linux-xtu/audit.jsonl``, home from ``env``
    HOME / USERPROFILE, else the OS home); on Windows ``%LOCALAPPDATA%\\linux-xtu\\audit.jsonl`` when LOCALAPPDATA is set (D-041).
    ``consider_install=False`` (simulator runs, which never touch hardware) skips the rule: always the per-user path.
    Raises :class:`InstalledStateRefused` when the installed policy exists but is untrusted."""
    if windows and env.get("LOCALAPPDATA"):
        return Path(env["LOCALAPPDATA"]) / "linux-xtu" / "audit.jsonl"
    if consider_install and not windows and installed_state(lstat_fn):
        return INSTALLED_AUDIT
    xdg = env.get("XDG_STATE_HOME")
    if xdg and os.path.isabs(xdg):
        return Path(xdg) / "linux-xtu" / "audit.jsonl"
    home = env.get("HOME") or env.get("USERPROFILE")
    base = Path(home) if home else Path.home()
    return base / ".local" / "state" / "linux-xtu" / "audit.jsonl"


def default_lock_path(
    isdir: Callable[[str], bool] = os.path.isdir,
    lstat_fn: Callable[[str], object] = os.lstat,
    windows: bool = os.name == "nt",
    consider_install: bool = True,
) -> Path:
    """Installed machine (D-030, not Windows): ``/run/linux-xtu/mailbox.lock``. Otherwise ``/run/lock/linux-xtu-mailbox.lock`` when ``/run/lock``
    exists, else the temp directory (D-041). ``consider_install=False`` (simulator runs): never the installed path. Raises :class:`InstalledStateRefused` when the installed policy exists but is untrusted."""
    if consider_install and not windows and installed_state(lstat_fn):
        return INSTALLED_LOCK
    if isdir("/run/lock"):
        return Path("/run/lock") / DEV_LOCK_NAME
    return Path(tempfile.gettempdir()) / DEV_LOCK_NAME


def legacy_lock_companions(lock_path: os.PathLike[str] | str, isdir: Callable[[str], bool] = os.path.isdir) -> tuple[Path, ...]:
    """D-054, review F3: the lock file of the earlier name that a device run holds besides its own machine-wide ``lock_path`` (the guard's per-transaction
    lock; the apply scope takes its ``.apply`` sibling). Only the installed lock has one: ``/run/arltuner/mailbox.lock``, the old installed lock, in a
    root-owned directory nobody else can write (``linux_xtu.guard.lockfile.acquire_companions`` refuses any other), while that directory exists. Every
    other path - the uninstalled defaults in ``/run/lock`` and the temp directory, a simulator's lock, a test's temp file, an explicit ``--lock`` - has none:
    a file anybody can plant there must have no effect (security review); and while ``/etc/arltuner/policy.toml`` exists :func:`installed_state` refuses."""
    if os.fspath(lock_path) != os.fspath(INSTALLED_LOCK) or not isdir(os.fspath(LEGACY_INSTALLED_LOCK.parent)):
        return ()
    return (LEGACY_INSTALLED_LOCK,)


def sim_lock_path(
    env: Mapping[str, str] | None = None, isdir: Callable[[str], bool] = os.path.isdir, uid_fn: Callable[[], int] | None = None
) -> Path:
    """R-B8 (review of R-B3, H4): the default lock of a simulator run (CLI ``--sim``, ``linux-xtu-helper --sim``), apart from the device runs' lock: a user's
    crashed simulator apply must never leave a lock on the path root's dev ``--device`` runs use (root never takes over a lock another uid owns). Per user:
    ``$XDG_RUNTIME_DIR/linux-xtu-sim-mailbox.lock`` when that is an absolute existing directory, else ``<temp dir>/linux-xtu-sim-mailbox-<uid>.lock``."""
    env = os.environ if env is None else env
    runtime = env.get("XDG_RUNTIME_DIR", "")
    if runtime and os.path.isabs(runtime) and isdir(runtime):
        return Path(runtime) / "linux-xtu-sim-mailbox.lock"
    getuid = uid_fn or getattr(os, "getuid", None)
    who = getuid() if getuid is not None else os.environ.get("USERNAME", "user")
    return Path(tempfile.gettempdir()) / f"linux-xtu-sim-mailbox-{who}.lock"
