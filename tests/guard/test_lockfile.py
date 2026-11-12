"""R-B3 (assessment 06 F4): ``linux_xtu.guard.lockfile`` -- lock files a dead owner cannot wedge, and a live owner never loses.

A real second process holds the lock (``Holder``: ``lockfile.acquire`` in a child, then it sleeps); ``kill -9`` makes it a dead owner. Other cases
write an owner record by hand and judge it with an injected :class:`~linux_xtu.guard.lockfile.Probe`. POSIX only (flock, /proc). Temp files only.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from linux_xtu.guard import lockfile
from linux_xtu.guard.lockfile import LockBusy, LockLost, Owner, Probe

SRC = Path(__file__).resolve().parents[2] / "src"
POSIX = os.name == "posix" and lockfile.can_take_over() and Path("/proc/self/stat").exists()
BOOT = "11111111-2222-3333-4444-555555555555"
OTHER_BOOT = "99999999-8888-7777-6666-555555555555"

_HOLDER = """
import sys, time
sys.path.insert(0, sys.argv[1])
from linux_xtu.guard import lockfile
for path in sys.argv[2:]:
    lockfile.acquire(path, lockfile.self_owner("test holder (simulated helper mid-write)", since=time.time()))
print("held", flush=True)
time.sleep(600)
"""


class Holder:
    """A child process holding ``paths`` (lockfile.acquire, exactly as the guard / helper / CLI take them). ``kill()`` is ``kill -9``: no cleanup runs."""

    def __init__(self, *paths: Path) -> None:
        self.proc = subprocess.Popen([sys.executable, "-I", "-c", _HOLDER, str(SRC), *map(str, paths)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = self.proc.stdout.readline() if self.proc.stdout else ""
        if line.strip() != "held":
            self.proc.kill()
            raise AssertionError(f"the holder did not take the lock: {line!r} {self.proc.stderr.read() if self.proc.stderr else ''}")
        self.pid = self.proc.pid

    def kill(self) -> None:
        self.proc.kill()  # SIGKILL: the lock files stay behind with this pid in them
        self.proc.wait(10)
        for stream in (self.proc.stdout, self.proc.stderr):
            if stream is not None:
                stream.close()

    def __enter__(self) -> Holder:
        return self

    def __exit__(self, *exc: object) -> None:
        if self.proc.poll() is None:
            self.kill()


def probe(*, alive: bool | None = True, start: int | None = 100, ns: str | None = "pid:[1]", boot: str | None = BOOT) -> Probe:
    return Probe(lambda pid: alive, lambda pid: start, lambda: ns, lambda: boot)


def record(pid: int = 4242, start: int | None = 100, boot: str | None = BOOT, ns: str | None = "pid:[1]", what: str = "x", since: float | None = 1.0) -> bytes:
    return Owner(pid, start, boot, ns, what, since).line()


@unittest.skipUnless(POSIX, "flock and /proc")
class LockfileCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.path = self.dir / "mailbox.lock"

    def me(self, what: str = "test") -> Owner:
        return lockfile.self_owner(what, since=time.time())


class AcquireRelease(LockfileCase):
    def test_the_record_names_pid_start_boot_and_namespace_and_release_removes_it(self) -> None:
        held = lockfile.acquire(self.path, self.me("mailbox transaction"))
        doc = json.loads(self.path.read_text())
        self.assertEqual((doc["lock"], doc["pid"], doc["what"]), ("linux-xtu/1", os.getpid(), "mailbox transaction"))
        self.assertIsInstance(doc["start"], int)
        self.assertEqual(doc["start"], lockfile.PROC.start_of(os.getpid()))
        self.assertEqual(doc["boot"], lockfile.PROC.boot_id())
        self.assertTrue(doc["pidns"].startswith("pid:["))
        self.assertIsNone(held.takeover)
        lockfile.release(held)
        self.assertFalse(self.path.exists())
        self.assertIsNone(held.fd)

    def test_a_second_acquire_in_the_same_process_is_busy_never_reentrant(self) -> None:
        held = lockfile.acquire(self.path, self.me())
        with self.assertRaises(LockBusy) as ctx:
            lockfile.acquire(self.path, self.me())
        self.assertIn(f"held by pid {os.getpid()}", str(ctx.exception))
        lockfile.release(held)

    def test_a_missing_directory_is_a_lock_error(self) -> None:
        with self.assertRaises(lockfile.LockError) as ctx:
            lockfile.acquire(self.dir / "nope" / "x.lock", self.me())
        self.assertIn("does not exist", str(ctx.exception))

    def test_release_never_removes_a_file_that_is_not_ours(self) -> None:
        held = lockfile.acquire(self.path, self.me())
        os.unlink(self.path)
        self.path.write_bytes(record())  # someone else's lock now sits at the path
        with self.assertRaises(LockLost):
            lockfile.release(held)
        self.assertEqual(self.path.read_bytes(), record())
        self.assertIsNone(held.fd)

    @unittest.skipUnless(POSIX, "flock")
    def test_r_b8_an_examiner_holding_the_fresh_files_flock_once_is_waited_out(self) -> None:
        # R-B8 (review of R-B3, H5): between our O_EXCL create and our flock another process may flock the new (still empty) file to examine it
        real, calls = lockfile.fcntl.flock, []

        def examiner_first(fd: int, op: int) -> None:
            calls.append(fd)
            if len(calls) == 1:
                raise BlockingIOError(11, "Resource temporarily unavailable")
            real(fd, op)

        with mock.patch.object(lockfile.fcntl, "flock", side_effect=examiner_first):
            held = lockfile.acquire(self.path, self.me())
        self.assertEqual(len(calls), 2)  # one retry, no loop
        self.assertEqual(json.loads(self.path.read_text())["pid"], os.getpid())
        lockfile.release(held)

    @unittest.skipUnless(POSIX, "flock")
    def test_r_b8_an_examiner_holding_it_twice_is_busy_not_a_lock_error_and_leaves_nothing(self) -> None:
        def held_elsewhere(fd: int, op: int) -> None:
            raise BlockingIOError(11, "Resource temporarily unavailable")

        with mock.patch.object(lockfile.fcntl, "flock", side_effect=held_elsewhere) as flock:
            with self.assertRaises(LockBusy) as ctx:
                lockfile.acquire(self.path, self.me())
        self.assertEqual(flock.call_count, 2)
        self.assertIn("examining", str(ctx.exception))
        self.assertFalse(self.path.exists())  # our half-made file is gone; the examiner never removes an empty file

    @unittest.skipUnless(POSIX, "flock")
    def test_r_b8_the_examiner_names_a_file_still_being_created(self) -> None:
        self.path.write_bytes(b"")  # created a moment ago, record not written yet
        with self.assertRaises(LockBusy) as ctx:
            lockfile.acquire(self.path, self.me())
        self.assertIn("being created by another process", str(ctx.exception))
        self.assertTrue(self.path.exists())

    def test_release_of_an_already_removed_file_is_quiet(self) -> None:
        held = lockfile.acquire(self.path, self.me())
        os.unlink(self.path)
        lockfile.release(held)


class LiveOwner(LockfileCase):
    def test_a_live_holder_is_never_stolen_from_even_when_the_probe_says_dead(self) -> None:
        with Holder(self.path) as holder:
            before = self.path.read_bytes()
            for p in (lockfile.PROC, probe(alive=False), probe(boot=OTHER_BOOT)):  # its flock is the proof of life, whatever the record says
                with self.subTest(probe=p), self.assertRaises(LockBusy) as ctx:
                    lockfile.acquire(self.path, self.me(), probe=p, on_takeover=lambda s: self.fail("a live owner was judged stale"))
                self.assertIn(f"held by pid {holder.pid}", str(ctx.exception))
                self.assertIn("it is running", str(ctx.exception))
            self.assertEqual(self.path.read_bytes(), before)

    def test_kill_9_then_the_next_acquire_takes_over_with_the_reason_first(self) -> None:
        holder = Holder(self.path)
        holder.kill()
        seen: list[lockfile.Stale] = []

        def audit(stale: lockfile.Stale) -> None:
            self.assertTrue(self.path.exists(), "the record is written before anything is removed")
            seen.append(stale)

        held = lockfile.acquire(self.path, self.me("after the crash"), on_takeover=audit)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].owner.pid, holder.pid)
        self.assertIn(f"pid {holder.pid} no longer exists", seen[0].why)
        self.assertIs(held.takeover, seen[0])
        self.assertEqual(json.loads(self.path.read_text())["pid"], os.getpid())
        lockfile.release(held)


class Judgement(LockfileCase):
    def take(self, content: bytes, p: Probe, **kw: object) -> lockfile.Held:
        self.path.write_bytes(content)
        return lockfile.acquire(self.path, self.me(), probe=p, **kw)  # type: ignore[arg-type]

    def busy(self, content: bytes, p: Probe, **kw: object) -> str:
        self.path.write_bytes(content)
        with self.assertRaises(LockBusy) as ctx:
            lockfile.acquire(self.path, self.me(), probe=p, on_takeover=lambda s: self.fail(f"taken over: {s.why}"), **kw)  # type: ignore[arg-type]
        self.assertEqual(self.path.read_bytes(), content, "a lock that is not provably abandoned is never touched")
        return str(ctx.exception)

    def test_a_reused_pid_is_a_dead_owner(self) -> None:
        held = self.take(record(start=100), probe(alive=True, start=555))
        self.assertIn("now another process", held.takeover.why)  # type: ignore[union-attr]

    def test_an_earlier_boot_is_a_dead_owner(self) -> None:
        held = self.take(record(boot=OTHER_BOOT), probe(alive=True, boot=BOOT))
        self.assertIn("earlier boot", held.takeover.why)  # type: ignore[union-attr]

    def test_a_live_pid_with_the_same_start_time_is_held(self) -> None:
        self.assertIn("held by pid 4242", self.busy(record(), probe(alive=True, start=100)))

    def test_a_record_under_the_old_name_is_judged_like_ours(self) -> None:
        """D-054: a lock the code wrote as ``arltuner/1`` is the same format: held while its owner may live, taken over only when provably dead."""
        legacy = record().replace(b'"lock":"linux-xtu/1"', b'"lock":"arltuner/1"')
        self.assertIn(b'"arltuner/1"', legacy)
        self.assertIn("held by pid 4242", self.busy(legacy, probe(alive=True, start=100)))
        held = self.take(record(boot=OTHER_BOOT).replace(b'"lock":"linux-xtu/1"', b'"lock":"arltuner/1"'), probe(alive=True, boot=BOOT))
        self.assertIn("earlier boot", held.takeover.why)  # type: ignore[union-attr]
        lockfile.release(held)
        self.assertEqual(json.loads(record())["lock"], lockfile.FORMAT)  # never written

    def test_cannot_tell_is_held(self) -> None:
        for p in (probe(alive=None), probe(alive=True, start=None), probe(ns=None), probe(ns="pid:[2]")):
            with self.subTest(probe=p):
                self.busy(record(), p)
        self.busy(record(start=None), probe(alive=True))  # a record without a start time cannot rule out a reused pid
        self.busy(record(ns=None), probe(alive=False))  # nor a record without a pid namespace

    def test_an_older_versions_pid_only_file_is_never_taken_over(self) -> None:
        message = self.busy(b"4242\n", probe(alive=False, boot=OTHER_BOOT))
        self.assertIn("held by pid 4242", message)

    def test_unrecognised_content_fails_closed(self) -> None:
        for content in (b"", b"garbage\n", b'{"lock":"linux-xtu/2","pid":1}\n', record()[:-20], b'{"lock":"linux-xtu/1","pid":0,"what":"x"}\n',
                        b'{"lock":"linux-xtu/1","pid":true,"what":"x"}\n', b"{" + b" " * 600 + b"}"):
            with self.subTest(content=content[:40]):
                self.busy(content, probe(alive=False))

    def test_a_file_of_another_user_is_never_taken_over(self) -> None:
        message = self.busy(record(), probe(alive=False), euid=os.geteuid() + 1)
        self.assertIn("belongs to uid", message)

    def test_an_audit_failure_leaves_the_stale_lock_alone(self) -> None:
        content = record()
        self.path.write_bytes(content)

        def broken(stale: lockfile.Stale) -> None:
            raise OSError("disk full")

        with self.assertRaises(OSError):
            lockfile.acquire(self.path, self.me(), probe=probe(alive=False), on_takeover=broken)
        self.assertEqual(self.path.read_bytes(), content)

    @unittest.skipIf(os.geteuid() == 0, "root may unlink in a read-only directory")
    def test_an_abandoned_lock_that_cannot_be_removed_is_still_held(self) -> None:
        self.path.write_bytes(record())
        self.dir.chmod(0o500)
        self.addCleanup(self.dir.chmod, 0o700)
        with self.assertRaises(LockBusy) as ctx:
            lockfile.acquire(self.path, self.me(), probe=probe(alive=False))
        self.assertIn("could not be removed", str(ctx.exception))
        self.assertEqual(self.path.read_bytes(), record())

    def test_two_takers_cannot_both_take_over_the_same_stale_file(self) -> None:
        self.path.write_bytes(record())
        inner: list[BaseException] = []

        def second_taker(stale: lockfile.Stale) -> None:  # runs while the first taker holds the stale file's flock
            try:
                lockfile.acquire(self.path, self.me("second"), probe=probe(alive=False))
            except LockBusy as exc:
                inner.append(exc)

        held = lockfile.acquire(self.path, self.me("first"), probe=probe(alive=False), on_takeover=second_taker)
        self.assertEqual(len(inner), 1)
        self.assertEqual(json.loads(self.path.read_text())["what"], "first")
        lockfile.release(held)

    def test_a_symlink_fifo_or_alias_is_never_read_or_removed(self) -> None:
        target = self.dir / "target"
        target.write_bytes(record())
        self.path.symlink_to(target)
        with self.assertRaises(LockBusy):
            lockfile.acquire(self.path, self.me(), probe=probe(alive=False))
        self.assertTrue(self.path.is_symlink())
        self.path.unlink()
        os.link(target, self.path)
        with self.assertRaises(LockBusy) as ctx:
            lockfile.acquire(self.path, self.me(), probe=probe(alive=False))
        self.assertIn("not a plain regular file", str(ctx.exception))
        self.path.unlink()
        os.mkfifo(self.path)
        with self.assertRaises(LockBusy):
            lockfile.acquire(self.path, self.me(), probe=probe(alive=False))
        self.assertEqual(target.read_bytes(), record())


class OwnerRecord(unittest.TestCase):
    def test_round_trip_and_description(self) -> None:
        owner = Owner(7, 9, BOOT, "pid:[1]", "tune.apply (helper, gui:uid1000)", 1762851600.0)
        self.assertEqual(Owner.parse(owner.line()), owner)
        self.assertEqual(owner.describe(), "held by pid 7: tune.apply (helper, gui:uid1000) since 2025-11-11T09:00:00+00:00")
        self.assertEqual(owner.as_json()["pid"], 7)

    def test_a_judge_never_signals_a_process_group(self) -> None:
        self.assertIsNone(lockfile._pid_alive(0))  # noqa: SLF001 -- os.kill(0, 0) would address our own process group
        self.assertIsNone(lockfile._pid_alive(-1))  # noqa: SLF001


if __name__ == "__main__":
    unittest.main()
