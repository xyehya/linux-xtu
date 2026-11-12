"""R-B3 (assessment 06 F4) through the guard: a transaction lock left by a process killed mid-write no longer refuses every later request.

The holder is a real child process (``kill -9``); the guard is the real ``WriteGuard`` over the recording fake transport. POSIX only.
"""
from __future__ import annotations

import json
import unittest

from linux_xtu.guard import GuardRefused, Refusal

from . import test_guard as tg
from .test_lockfile import POSIX, Holder


@unittest.skipUnless(POSIX, "flock and /proc")
class GuardLockTakeover(tg.GuardCase):
    def test_a_holder_killed_mid_write_is_taken_over_audited_first(self) -> None:
        holder = Holder(self.lock_path)
        holder.kill()
        guard = self.make_guard()
        guard.execute(self.read_req(), self.confirm)
        events = [(r["event"], r.get("reason")) for r in self.records()]
        self.assertEqual(events[0], ("error", "LOCK_TAKEOVER"))  # before the attempt it made possible
        self.assertIn(("attempt", None), events)
        rec = self.records()[0]
        self.assertEqual((rec["stage"], rec["lock"], rec["stale_owner"]["pid"]), ("lock", str(self.lock_path), holder.pid))
        self.assertIn("no longer exists", rec["detail"])
        self.assertFalse(self.lock_path.exists())  # released after the transaction like any lock
        self.assertFalse(guard.tripped)

    def test_a_live_holder_is_locked_and_its_file_untouched(self) -> None:
        with Holder(self.lock_path) as holder:
            before = self.lock_path.read_bytes()
            exc = self.assert_refused(self.make_guard(), self.read_req(), Refusal.LOCKED)
            self.assertIn(f"held by pid {holder.pid}", exc.detail)
            self.assertEqual(self.lock_path.read_bytes(), before)
            self.assertEqual(self.transport.calls, [])
            self.assertNotIn("LOCK_TAKEOVER", [r.get("reason") for r in self.records()])

    def test_an_audit_log_that_cannot_take_the_record_leaves_the_stale_lock(self) -> None:
        holder = Holder(self.lock_path)
        holder.kill()
        before = self.lock_path.read_bytes()

        class Broken:
            path = self.audit_path

            def append(self, *a: object, **kw: object) -> None:
                raise OSError("disk full")

        guard = self.make_guard(audit=Broken())
        with self.assertRaises(GuardRefused) as ctx:
            guard.execute(self.read_req(), self.confirm)
        self.assertIs(ctx.exception.reason, Refusal.LOCKED)
        self.assertIn("takeover could not be audited", ctx.exception.detail)
        self.assertEqual(self.lock_path.read_bytes(), before)
        self.assertEqual(json.loads(before)["pid"], holder.pid)
        self.assertEqual(self.transport.calls, [])


if __name__ == "__main__":
    unittest.main()
