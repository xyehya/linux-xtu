"""D-054, review F3 (+ security review): code of the earlier name (arltuner) takes other lock files than this code, so the two would never block each other.

* ``paths.installed_state`` refuses while ``/etc/arltuner/policy.toml`` exists (an install that was not migrated);
* ``paths.legacy_lock_companions``: only the installed lock has a companion, ``/run/arltuner/mailbox.lock`` (root-owned directory); nothing in ``/run/lock``
  or the temp directory, where anybody can plant a file;
* the guard holds it for the transaction and the apply scope holds its ``.apply`` sibling, with the normal O_EXCL / flock code; its directory must be
  root-owned and writable by root only, else the run refuses. Nothing is ever removed.
Temp files only (the companions are injected; ``lockfile.LEGACY_DIR_OWNER`` is set to the test's uid); POSIX.
"""
from __future__ import annotations

import os
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from linux_xtu import paths
from linux_xtu.guard import Refusal, lockfile
from linux_xtu.guard.applylock import ApplyBusy, ApplyLockError, apply_lock_path, apply_scope

from . import test_guard as tg
from .test_lockfile import POSIX


def fake_lstat(existing: set[str]):
    def lstat(path: str) -> SimpleNamespace:
        if os.fspath(path) not in existing:
            raise FileNotFoundError(path)
        return SimpleNamespace(st_uid=0, st_mode=0o100644, st_nlink=1)

    return lstat


def own_dirs():
    """The companions' directories in these tests are the test user's temp dirs, not root's."""
    return mock.patch.object(lockfile, "LEGACY_DIR_OWNER", os.geteuid())


class UnmigratedInstall(unittest.TestCase):
    def test_an_old_policy_file_refuses_every_device_path_until_migrated(self) -> None:
        lstat = fake_lstat({"/etc/arltuner/policy.toml"})
        for call in (lambda: paths.installed_state(lstat), lambda: paths.default_lock_path(lstat_fn=lstat, windows=False),
                     lambda: paths.default_audit_path({"HOME": "/home/u"}, windows=False, lstat_fn=lstat)):
            with self.assertRaises(paths.InstalledStateRefused) as ctx:
                call()
            self.assertIn("/etc/arltuner/policy.toml exists", str(ctx.exception))
            self.assertIn("sudo bash install.sh", str(ctx.exception))
        # simulator runs never consult the install
        self.assertEqual(paths.default_lock_path(isdir=lambda p: True, lstat_fn=lstat, windows=False, consider_install=False), Path("/run/lock/linux-xtu-mailbox.lock"))

    def test_without_the_old_policy_the_d030_rule_is_unchanged(self) -> None:
        self.assertFalse(paths.installed_state(fake_lstat(set())))


class Companions(unittest.TestCase):
    def test_only_the_installed_lock_has_a_companion_in_the_root_only_directory(self) -> None:
        every_dir = lambda p: True  # noqa: E731
        self.assertEqual(paths.legacy_lock_companions(paths.INSTALLED_LOCK, isdir=every_dir), (Path("/run/arltuner/mailbox.lock"),))
        tmp = tempfile.gettempdir()
        for other in ("/run/lock/linux-xtu-mailbox.lock", os.path.join(tmp, "linux-xtu-mailbox.lock"), "/tmp/x/guard.lock", paths.sim_lock_path(env={}),
                      "/run/linux-xtu/other.lock"):
            self.assertEqual(paths.legacy_lock_companions(other, isdir=every_dir), (), other)

    def test_no_companion_once_the_old_directory_is_gone(self) -> None:
        self.assertEqual(paths.legacy_lock_companions(paths.INSTALLED_LOCK, isdir=lambda p: False), ())


@unittest.skipUnless(POSIX, "flock and /proc")
class AcquireCompanions(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        os.chmod(self.dir, 0o755)

    def test_held_while_held_and_gone_after(self) -> None:
        a = self.dir / "mailbox.lock"
        with own_dirs():
            held = lockfile.acquire_companions([a], lockfile.self_owner("t", since=None))
        self.assertTrue(a.exists())
        lockfile.release_all(held)
        self.assertFalse(a.exists())

    def test_a_genuine_old_holder_blocks_and_is_never_touched(self) -> None:
        a, b = self.dir / "a.lock", self.dir / "b.lock"
        b.write_text("4242\n")  # the old code's lock: O_EXCL, its pid only
        with own_dirs(), self.assertRaises(lockfile.LockBusy):
            lockfile.acquire_companions([a, b], lockfile.self_owner("t", since=None))
        self.assertFalse(a.exists(), "the companion taken first is released again")
        self.assertEqual(b.read_text(), "4242\n", "never taken over, never removed")

    def test_a_directory_that_is_not_root_owned_or_is_writable_by_others_fails_closed(self) -> None:
        a = self.dir / "mailbox.lock"
        with self.assertRaises(lockfile.LockError) as ctx:  # LEGACY_DIR_OWNER is root: the test user's directory is refused
            lockfile.acquire_companions([a], lockfile.self_owner("t", since=None))
        self.assertIn("not a root-owned directory", str(ctx.exception))
        for mode in (0o775, 0o757, 0o1777):
            os.chmod(self.dir, mode)
            with self.subTest(mode=oct(mode)), own_dirs(), self.assertRaises(lockfile.LockError):
                lockfile.acquire_companions([a], lockfile.self_owner("t", since=None))
        os.chmod(self.dir, 0o755)
        self.assertFalse(a.exists())
        with self.assertRaises(lockfile.LockError):
            lockfile.acquire_companions([self.dir / "missing" / "x.lock"], lockfile.self_owner("t", since=None))


@unittest.skipUnless(POSIX, "flock and /proc")
class GuardHoldsTheOldLock(tg.GuardCase):
    def test_the_old_lock_is_held_for_the_transaction_and_released_after(self) -> None:
        old = self.dir / "arltuner-mailbox.lock"
        seen: list[bool] = []
        self.transport.before_return = lambda call: seen.append(old.exists())
        with own_dirs():
            self.make_guard(legacy_locks=[old]).execute(self.read_req(), self.confirm)
        self.assertEqual(seen, [True])
        self.assertFalse(old.exists())
        self.assertFalse(self.lock_path.exists())

    def test_old_code_mid_transaction_blocks_the_guard_and_nothing_is_sent(self) -> None:
        old = self.dir / "arltuner-mailbox.lock"
        old.write_text("4242\n")
        with own_dirs():
            exc = self.assert_refused(self.make_guard(legacy_locks=[old]), self.read_req(), Refusal.LOCKED)
        self.assertIn("earlier name (arltuner)", exc.detail)
        self.assertEqual(old.read_text(), "4242\n")
        self.assertFalse(self.lock_path.exists(), "our own lock is released again")

    def test_security_a_file_planted_under_the_legacy_name_in_lock_or_temp_dirs_has_no_effect(self) -> None:
        """Anybody can create /run/lock/arltuner-mailbox.lock or <tmp>/arltuner-mailbox.lock: a run on the uninstalled default lock takes no companion
        there, so such a file neither blocks it nor is ever touched."""
        planted = self.dir / "arltuner-mailbox.lock"
        planted.write_text("planted by someone else\n")
        with mock.patch.object(tempfile, "tempdir", str(self.dir)):
            dev_lock = Path(tempfile.gettempdir()) / "linux-xtu-mailbox.lock"
            self.assertEqual(paths.legacy_lock_companions(dev_lock, isdir=lambda p: True), ())
            self.assertEqual(paths.legacy_lock_companions("/run/lock/linux-xtu-mailbox.lock", isdir=lambda p: True), ())
            self.lock_path = dev_lock
            self.make_guard().execute(self.read_req(), self.confirm)  # legacy_locks computed from the lock path: none
        self.assertEqual(planted.read_text(), "planted by someone else\n")
        self.assertFalse(dev_lock.exists())


@unittest.skipUnless(POSIX, "flock and /proc")
class ApplyScopeHoldsTheOldApplyLock(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.mine, self.old = self.dir / "mailbox.lock", self.dir / "arltuner-mailbox.lock"

    def test_held_for_the_body(self) -> None:
        with own_dirs(), apply_scope(self.mine, "test apply", since=None, legacy_locks=[self.old]):
            self.assertTrue(apply_lock_path(self.mine).exists())
            self.assertTrue(apply_lock_path(self.old).exists())
        self.assertFalse(apply_lock_path(self.old).exists())
        self.assertFalse(apply_lock_path(self.mine).exists())

    def test_an_old_apply_in_progress_refuses_and_releases_ours(self) -> None:
        apply_lock_path(self.old).write_text("4242\n")
        with own_dirs(), self.assertRaises(ApplyBusy) as ctx:
            with apply_scope(self.mine, "test apply", since=None, legacy_locks=[self.old]):
                self.fail("the body must not run")
        self.assertIn("earlier name", str(ctx.exception.holder))
        self.assertFalse(apply_lock_path(self.mine).exists())

    def test_an_untrusted_directory_refuses_the_apply(self) -> None:
        with self.assertRaises(ApplyLockError):  # LEGACY_DIR_OWNER is root; the temp dir is the test user's
            with apply_scope(self.mine, "test apply", since=None, legacy_locks=[self.old]):
                self.fail("the body must not run")
        self.assertFalse(apply_lock_path(self.mine).exists())
        self.assertEqual(stat.S_IMODE(self.dir.stat().st_mode) & 0o022, 0)


if __name__ == "__main__":
    unittest.main()
