"""Cross-process lock files that a dead owner cannot wedge (R-B3; assessment 06 F4, 05 B-07).

One mechanism for the guard's per-transaction lock (``mailbox.lock``), the helper's powercap / runtime writes (the same file) and the apply-scope
lock (``mailbox.lock.apply``, :mod:`linux_xtu.guard.applylock`). A lock is a file created with ``O_CREAT | O_EXCL`` (portable: "the file exists" is
"locked", which every older version of this code also honours) holding one JSON line, the **owner record**::

    {"lock": "linux-xtu/1", "pid": 4242, "start": 123456, "boot": "<boot id>", "pidns": "pid:[4026531836]", "what": "mailbox transaction", "since": 1762851600.25}

``start`` is field 22 of ``/proc/<pid>/stat`` (clock ticks since boot: a reused pid has another one); ``boot`` the kernel's boot id (always the kernel's,
``/proc/sys/kernel/random/boot_id``, never a caller's injected one: every user of a lock file judges it by the same boot); ``pidns`` the pid namespace the
pid is valid in. On POSIX the owner also keeps the file open with an exclusive ``flock`` for as long as it holds the lock (the kernel
drops it when the process dies, however it dies).

**Takeover.** A process that finds the file present takes it over only when the owner is *provably* gone, all of:

1. the file is a plain regular file with one link (a FIFO, symlink or hard-linked alias is never read, never followed, never removed);
2. this process can ``flock`` it (no live owner of this version holds it);
3. the content is an owner record of this version (a pid-only file of an older version, or anything unparsable, is **not** taken over: fail closed);
4. the record names an earlier boot (both boot ids known and different), **or** -- same pid namespace -- its pid does not exist, or exists with
   another start time;
5. when ``euid`` is given, the file belongs to it.

Everything else is "held": a live owner is never stolen from, and an owner that cannot be judged counts as live. The takeover runs under the
``flock`` of the stale file, so two processes cannot both take over the same file; ``on_takeover`` (the caller's audit record) is called before
anything is removed and may raise to abort. Without ``fcntl`` (Windows) nothing is ever taken over: a stale lock still needs a human, as before.
"""
from __future__ import annotations

import json
import math
import os
import re
import stat
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:  # POSIX only; on Windows a stale lock is never taken over
    import fcntl
except ImportError:  # pragma: no cover - not reachable on Linux
    fcntl = None  # type: ignore[assignment]

__all__ = [
    "FORMAT", "Held", "LEGACY_FORMATS", "LockBusy", "LockError", "LockLost", "Owner", "Probe", "Stale", "acquire", "acquire_companions", "can_take_over",
    "judge", "LEGACY_DIR_OWNER", "release", "release_all",
    "self_owner",
]

FORMAT = "linux-xtu/1"
# The same record as written under the project's earlier name (D-054, docs/NAMING.md): read as this version, never written. A lock that the old code
# left is judged like any other (honoured while its owner may live, taken over only when provably stale), never ignored.
LEGACY_FORMATS = frozenset({"arltuner/1"})
_MAX_RECORD = 512  # an owner record is far shorter; more is not ours
_WHAT_MAX = 120
_HOLDER_TEXT_MAX = 32  # printable bytes of an unrecognised file that ever reach a message
_OPEN_EXCL = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
_BOOT_ID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_OPEN_READ = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)


class LockError(OSError):
    """The lock file cannot be created at all (its directory is missing, permissions, ...). Not "held": nothing was examined."""


class LockBusy(Exception):
    """The lock is held -- by a live owner, by one that cannot be judged, or by something that is not a lock file. ``text`` names the holder."""

    def __init__(self, path: Path | str, text: str, owner: Owner | None = None) -> None:
        super().__init__(f"lock file {path} exists ({text})")
        self.path, self.text, self.owner = str(path), text, owner


class LockLost(OSError):
    """At release the path no longer names the file this process created: the lock was not exclusive. Nothing else was removed."""


@dataclass(frozen=True)
class Owner:
    pid: int
    start: int | None
    boot: str | None
    pidns: str | None
    what: str
    since: float | None

    def line(self) -> bytes:
        doc = {"lock": FORMAT, "pid": self.pid, "start": self.start, "boot": self.boot, "pidns": self.pidns, "what": self.what[:_WHAT_MAX], "since": self.since}
        return (json.dumps(doc, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")

    @classmethod
    def parse(cls, raw: bytes) -> Owner | None:
        """The record, or ``None`` for anything that is not exactly a record of this version (an old pid-only file, garbage, a cut-off write)."""
        try:
            doc = json.loads(raw.decode("ascii"))
        except (UnicodeDecodeError, ValueError):
            return None
        if not isinstance(doc, dict) or (doc.get("lock") != FORMAT and doc.get("lock") not in LEGACY_FORMATS):
            return None
        pid, start, boot, pidns, what, since = (doc.get(k) for k in ("pid", "start", "boot", "pidns", "what", "since"))
        if not _is_int(pid) or pid <= 0 or not (start is None or (_is_int(start) and start >= 0)):
            return None
        if not all(v is None or isinstance(v, str) for v in (boot, pidns)) or not isinstance(what, str):
            return None
        if since is not None and (isinstance(since, bool) or not isinstance(since, (int, float)) or not math.isfinite(since)):
            return None
        return cls(pid, start, boot, pidns, what[:_WHAT_MAX], None if since is None else float(since))

    def describe(self) -> str:
        when = "" if self.since is None else f" since {_iso(self.since)}"
        return f"held by pid {self.pid}: {_printable(self.what, _WHAT_MAX)}{when}"

    def as_json(self) -> dict[str, Any]:
        return {"pid": self.pid, "start": self.start, "boot": self.boot, "what": self.what, "since": None if self.since is None else _iso(self.since)}


@dataclass(frozen=True)
class Stale:
    """A lock file judged abandoned: its owner record and why the owner is provably gone."""

    owner: Owner
    why: str


@dataclass
class Held:
    """A lock this process created. ``fd`` keeps the ``flock`` (``None`` without ``fcntl``); ``takeover`` is the stale lock it replaced, if any."""

    path: Path
    owner: Owner
    dev: int
    ino: int
    fd: int | None
    takeover: Stale | None = None


@dataclass(frozen=True)
class Probe:
    """How the system and a process are looked at (Linux ``/proc``; tests inject their own)."""

    pid_alive: Callable[[int], bool | None]  # True / False / None = cannot tell
    start_of: Callable[[int], int | None]  # field 22 of /proc/<pid>/stat, None = cannot tell
    pidns: Callable[[], str | None]  # this process's pid namespace, None = cannot tell
    boot_id: Callable[[], str | None]  # the kernel's boot id, None = cannot tell


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _iso(ts: float) -> str:
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")
    except (OverflowError, OSError, ValueError):
        return "an unreadable time"


def _printable(text: str, limit: int) -> str:
    return "".join(c for c in text if " " <= c <= "~")[:limit]


# ----------------------------------------------------------------------------------------------------------------------------------------------
# looking at processes (POSIX)
# ----------------------------------------------------------------------------------------------------------------------------------------------
def _pid_alive(pid: int) -> bool | None:
    if os.name != "posix" or pid <= 0:  # never os.kill on Windows (signal 0 there terminates the process); pid <= 0 addresses groups
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, belongs to someone else
    except OSError:
        return None
    return True


def _start_of(pid: int) -> int | None:
    """Field 22 (``starttime``) of ``/proc/<pid>/stat``. The command name (field 2) may hold spaces and parentheses: fields are counted after the last ``)``."""
    try:
        with open(f"/proc/{int(pid)}/stat", "rb") as handle:
            raw = handle.read(4096)
    except OSError:
        return None
    tail = raw[raw.rfind(b")") + 1:].split()
    try:
        return int(tail[19])  # tail[0] is field 3 (state)
    except (IndexError, ValueError):
        return None


def _pidns() -> str | None:
    try:
        return os.readlink("/proc/self/ns/pid")
    except (OSError, AttributeError):
        return None


def _boot_id() -> str | None:
    """The kernel's boot id (the guard's ``read_boot_id`` rule, repeated here: this module is imported by ``guard.py``)."""
    try:
        with open("/proc/sys/kernel/random/boot_id", "rb") as handle:
            text = handle.read(128).decode("ascii", "replace").strip()
    except OSError:
        return None
    return text.lower() if _BOOT_ID_RE.fullmatch(text) else None


PROC = Probe(_pid_alive, _start_of, _pidns, _boot_id)


def self_owner(what: str, *, since: float | None, probe: Probe = PROC) -> Owner:
    """The owner record of this process."""
    pid = os.getpid()
    return Owner(pid, probe.start_of(pid), probe.boot_id(), probe.pidns(), what, since)


def judge(owner: Owner, *, probe: Probe = PROC) -> str | None:
    """Why ``owner`` is provably gone, or ``None`` (alive, or it cannot be told: both are "held")."""
    boot_id = probe.boot_id()
    if owner.boot and boot_id and owner.boot != boot_id:
        return f"it was taken in an earlier boot (boot id {owner.boot[:8]}..., this boot {boot_id[:8]}...)"
    ours = probe.pidns()
    if owner.pidns is None or ours is None or owner.pidns != ours:
        return None  # another (or an unknown) pid namespace: its pid means nothing here
    alive = probe.pid_alive(owner.pid)
    if alive is False:
        return f"pid {owner.pid} no longer exists"
    if alive is None or owner.start is None:
        return None
    now = probe.start_of(owner.pid)
    if now is not None and now != owner.start:
        return f"pid {owner.pid} is now another process (start time {now}, the owner's was {owner.start})"
    return None


def can_take_over() -> bool:
    """Whether this platform can ever take a stale lock over (``fcntl.flock``)."""
    return fcntl is not None


# ----------------------------------------------------------------------------------------------------------------------------------------------
# acquire / release
# ----------------------------------------------------------------------------------------------------------------------------------------------
def _flock_fresh(fd: int) -> bool:
    """``flock`` a file this process has just created. Nobody else can be its owner, but another process may flock it in the window between our ``O_EXCL``
    create and this call, to examine it (``_examine``, which finds no record yet and lets go). R-B8 (review of R-B3, H5): one immediate retry (the guard
    package never waits), never a loop; ``False`` when it is still held -- the caller then answers BUSY, not a lock error."""
    assert fcntl is not None
    for _ in range(2):
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            continue
    return False


def _create(path: Path, owner: Owner) -> Held:
    """``O_EXCL`` create, ``flock``, write the record. ``FileExistsError`` when present; :class:`LockError` when it cannot be made."""
    try:
        fd = os.open(path, _OPEN_EXCL, 0o600)
    except FileExistsError:
        raise
    except FileNotFoundError:
        raise LockError(f"cannot create lock file {path}: its directory {path.parent} does not exist") from None
    except OSError as exc:
        raise LockError(f"cannot create lock file {path}: {exc!r}") from None
    try:
        if fcntl is not None and not _flock_fresh(fd):
            os.close(fd)
            try:
                os.unlink(path)  # ours, still empty: an examiner never removes a file without a record, so nothing else can be at this path yet
            except OSError:
                pass
            raise LockBusy(path, "another process was examining the lock file the moment it was created (it held the new file's flock twice); nothing was "
                                 "taken, try again")
        data = owner.line()
        if os.write(fd, data) != len(data):
            raise OSError("short write")
        st = os.fstat(fd)
    except OSError as exc:
        os.close(fd)
        try:
            os.unlink(path)  # created a moment ago by us: never leave a half-made lock behind
        except OSError:
            pass
        raise LockError(f"cannot write lock file {path}: {exc!r}") from None
    if fcntl is None:  # Windows cannot delete a file that is open: keep no descriptor (the file's existence is the lock)
        os.close(fd)
        return Held(path, owner, st.st_dev, st.st_ino, None)
    return Held(path, owner, st.st_dev, st.st_ino, fd)


def _holder_text(raw: bytes, owner: Owner | None) -> str:
    if owner is not None:
        return owner.describe()
    if not raw.strip():  # R-B8 (H5): created a moment ago, its record not written yet (an empty file is never taken over)
        return "being created by another process (no owner record yet; a file that stays empty was left by a creator that died at that moment: remove it by hand)"
    text = _printable(raw.decode("ascii", "replace").strip(), _HOLDER_TEXT_MAX)
    return "held by pid " + text  # an older version's pid-only file, or unrecognised content: shown, never judged


def _examine(path: Path, *, euid: int | None, probe: Probe, on_takeover: Callable[[Stale], None] | None) -> Stale:
    """Called when ``path`` exists: either removes a provably abandoned lock (and returns why) or raises :class:`LockBusy`. Never follows, never blocks."""
    try:
        fd = os.open(path, _OPEN_READ)
    except FileNotFoundError:
        raise LockBusy(path, "it disappeared while it was examined") from None
    except OSError:
        raise LockBusy(path, "holder unknown: the lock path could not be opened (a symlink?), so it was not read") from None
    try:
        try:
            st = os.fstat(fd)
            plain = stat.S_ISREG(st.st_mode) and st.st_nlink == 1
            raw = os.read(fd, _MAX_RECORD + 1) if plain else b""
        except OSError as exc:
            raise LockBusy(path, f"holder unknown: the lock file could not be read ({exc.strerror or exc})") from None
        if not plain:
            raise LockBusy(path, "holder unknown: the lock path is not a plain regular file, so it was not read")
        owner = Owner.parse(raw) if len(raw) <= _MAX_RECORD else None
        holder = _holder_text(raw, owner)
        if fcntl is None:
            raise LockBusy(path, holder, owner)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LockBusy(path, holder + "; it is running", owner) from None
        except OSError as exc:  # cannot tell: held
            raise LockBusy(path, f"{holder}; its flock cannot be examined ({exc.strerror or exc})", owner) from None
        if owner is None:  # nothing this version can check: never taken over (fail closed)
            raise LockBusy(path, ("not an owner record this version can check, so not taken over; " if raw.strip() and not raw.strip().isdigit() else "") + holder)
        if euid is not None and st.st_uid != euid:
            raise LockBusy(path, f"{holder}; the file belongs to uid {st.st_uid}, not to this process", owner)
        why = judge(owner, probe=probe)
        if why is None:
            raise LockBusy(path, holder, owner)
        try:
            now = os.lstat(path)
        except OSError:
            now = None
        if now is None or (now.st_dev, now.st_ino) != (st.st_dev, st.st_ino):
            raise LockBusy(path, "the lock changed while it was examined", owner)
        stale = Stale(owner, why)
        if on_takeover is not None:
            on_takeover(stale)  # the caller's audit record: may raise (propagates as is), and then nothing is removed
        try:
            os.unlink(path)  # still this inode: only a holder of its flock (we are) or its dead owner would remove it
        except OSError as exc:
            raise LockBusy(path, f"{holder}; abandoned ({why}) but it could not be removed: {exc.strerror or exc}", owner) from None
        return stale
    finally:
        os.close(fd)


def acquire(
    path: Path | str,
    owner: Owner,
    *,
    euid: int | None = None,
    on_takeover: Callable[[Stale], None] | None = None,
    probe: Probe = PROC,
) -> Held:
    """Create the lock for ``owner``; take over a provably abandoned one (module docstring). :class:`LockBusy` when held, :class:`LockError` when it
    cannot be made. One attempt each way: never a wait, never a retry loop."""
    path = Path(path)
    try:
        return _create(path, owner)
    except FileExistsError:
        pass
    stale = _examine(path, euid=euid, probe=probe, on_takeover=on_takeover)
    try:
        held = _create(path, owner)
    except FileExistsError:
        raise LockBusy(path, f"another process took it the moment the stale lock of pid {stale.owner.pid} was removed") from None
    held.takeover = stale
    return held


#: The owner the directory of a legacy companion lock must have (root; tests set their own uid). Read at call time.
LEGACY_DIR_OWNER = 0


def acquire_companions(
    paths: Sequence[Path | str],
    owner: Owner,
    *,
    euid: int | None = None,
    on_takeover: Callable[[Stale], None] | None = None,
    probe: Probe = PROC,
    lstat_fn: Callable[[str], os.stat_result] = os.lstat,
) -> list[Held]:
    """D-054, review F3: hold, besides one's own lock, the installed lock file of the project's earlier name (``linux_xtu.paths.legacy_lock_companions``:
    ``/run/arltuner/mailbox.lock`` only), so old code and this code never interleave. Each is taken with :func:`acquire` exactly like one's own lock
    (O_EXCL, flock, an old version's pid-only file never taken over) or the call fails closed: :class:`LockBusy` when held, :class:`LockError` when it
    cannot be made, and :class:`LockError` before anything is tried when its directory is not a root-owned directory writable by root alone (0755 or
    stricter). Nothing is ever removed here. On any failure the companions already taken are released first; the caller releases the list with
    :func:`release_all`."""
    held: list[Held] = []
    try:
        for p in map(Path, paths):
            try:
                st = lstat_fn(os.fspath(p.parent))
            except OSError as exc:
                raise LockError(f"cannot examine {p.parent}, the directory of the lock file {p}: {exc}") from None
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != LEGACY_DIR_OWNER or st.st_mode & 0o022:
                raise LockError(f"{p.parent} (the directory of the lock file {p}) is not a root-owned directory writable by root only "
                                f"(uid {st.st_uid}, mode {stat.S_IMODE(st.st_mode):04o}); refusing")
            held.append(acquire(p, owner, euid=euid, on_takeover=on_takeover, probe=probe))
    except BaseException:
        release_all(held)
        raise
    return held


def release_all(held: Sequence[Held]) -> None:
    """Release ``held`` in reverse order; every one is attempted, the first error is raised after the rest."""
    first: BaseException | None = None
    for h in reversed(list(held)):
        try:
            release(h)
        except OSError as exc:
            first = first or exc
    if first is not None:
        raise first


def release(held: Held) -> None:
    """Remove the lock file this process created, then drop the ``flock``. :class:`LockLost` (nothing removed) when the path names another file; a
    missing file is not an error; any other ``OSError`` propagates."""
    if held.fd is None:  # no flock on this platform (Windows): the file's existence was the lock, as before
        try:
            os.unlink(held.path)
        except FileNotFoundError:
            pass
        return
    try:
        try:
            st = os.lstat(held.path)
        except FileNotFoundError:
            return
        if (st.st_dev, st.st_ino) != (held.dev, held.ino):
            raise LockLost(f"the lock file {held.path} is no longer the one this process created; it was left alone")
        os.unlink(held.path)
    finally:
        if held.fd is not None:
            fd, held.fd = held.fd, None
            os.close(fd)
