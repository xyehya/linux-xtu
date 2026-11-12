"""One apply at a time on the machine, across processes (R-B3, assessment 05 B-07).

The guard's lock (``mailbox.lock``) covers one transaction. An apply is reads -> plan -> checks -> N writes -> read-backs, so two appliers (the helper's
``tune.apply`` and a CLI restore, say) could interleave: the second's baselines would predate the first's writes. Every apply therefore also holds
``<mailbox lock>.apply`` (:func:`apply_lock_path`) from before its first read to after its last read-back. The per-transaction lock stays inside it.

Holders: the helper's ``tune.apply`` / ``power.apply`` / ``runtime.apply`` (taken by the dispatcher, :mod:`linux_xtu.helper.core`), the CLI's ``apply``,
and any future boot-restore entry point (it calls :func:`apply_scope` the same way). A second apply is refused :class:`ApplyBusy` naming the holder,
never queued. The file is a :mod:`linux_xtu.guard.lockfile` lock: an abandoned one (its owner provably dead) is taken over, with the caller's audit
record first.
"""
from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

from linux_xtu.paths import legacy_lock_companions

from . import lockfile

__all__ = ["APPLY_SUFFIX", "ApplyBusy", "ApplyLockError", "apply_lock_path", "apply_scope"]

APPLY_SUFFIX = ".apply"


class ApplyBusy(Exception):
    """Another apply holds the machine. ``holder`` describes it (pid, what, since); ``owner`` is its record when it could be read."""

    check = "APPLY_BUSY"

    def __init__(self, path: Path | str, holder: str, owner: lockfile.Owner | None) -> None:
        super().__init__(f"another apply is in progress ({holder}; lock {path}); nothing was started")
        self.path, self.holder, self.owner = str(path), holder, owner


class ApplyLockError(Exception):
    """The apply lock cannot be taken at all (its directory is missing, permissions): the apply does not start."""

    check = "APPLY_LOCK"


def apply_lock_path(mailbox_lock: Path | str) -> Path:
    """``/run/linux-xtu/mailbox.lock`` -> ``/run/linux-xtu/mailbox.lock.apply`` (same directory, same trust)."""
    p = Path(mailbox_lock)
    return p.with_name(p.name + APPLY_SUFFIX)


@contextmanager
def apply_scope(
    mailbox_lock: Path | str,
    what: str,
    *,
    since: float | None,
    euid: int | None = None,
    on_takeover: Callable[[lockfile.Stale], None] | None = None,
    on_release_error: Callable[[Exception], None] | None = None,
    probe: lockfile.Probe = lockfile.PROC,
    legacy_locks: Sequence[Path | str] | None = None,
) -> Iterator[lockfile.Held]:
    """Hold the apply lock for the ``with`` body. :class:`ApplyBusy` / :class:`ApplyLockError` before the body runs. A release that fails is passed to
    ``on_release_error`` (the apply itself has already happened; the file then names a dead owner once this process exits and is taken over then).
    D-054, review F3: the ``.apply`` siblings of the lock files of the earlier name are held too (``legacy_locks``: the companions of ``mailbox_lock``,
    ``linux_xtu.paths.legacy_lock_companions``; ``None`` = computed, tests pass ``[]``), so an apply of old code and one of this code exclude each other."""
    path = apply_lock_path(mailbox_lock)
    owner = lockfile.self_owner(what, since=since, probe=probe)
    try:
        held = lockfile.acquire(path, owner, euid=euid, on_takeover=on_takeover, probe=probe)
    except lockfile.LockBusy as exc:
        raise ApplyBusy(path, exc.text, exc.owner) from None
    except lockfile.LockError as exc:
        raise ApplyLockError(str(exc)) from None
    companions = [apply_lock_path(p) for p in (legacy_lock_companions(mailbox_lock) if legacy_locks is None else legacy_locks)]
    try:
        legacy = lockfile.acquire_companions(companions, owner, euid=euid, on_takeover=on_takeover, probe=probe)
    except BaseException as exc:
        try:
            lockfile.release(held)
        except OSError:
            pass
        if isinstance(exc, lockfile.LockBusy):
            raise ApplyBusy(exc.path, f"{exc.text}; a lock of the project's earlier name (arltuner): an apply of that code is running", exc.owner) from None
        if isinstance(exc, lockfile.LockError):
            raise ApplyLockError(str(exc)) from None
        raise
    try:
        yield held
    finally:
        for h in (*reversed(legacy), held):
            try:
                lockfile.release(h)
            except OSError as exc:
                if on_release_error is not None:
                    on_release_error(exc)
