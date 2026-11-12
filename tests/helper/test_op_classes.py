"""R-B3 (assessment 06 F10, 05 B-14): every built-in op is classified -- which ones change state (``OpSpec.mutates``), which ones hold the apply lock --
and a new op cannot slip in unclassified; file-changing slow ops run one at a time; the stale-read check knows every mailbox write command."""
from __future__ import annotations

import threading
import unittest
from unittest import mock

from linux_xtu.helper import OpSpec, core
from linux_xtu.helper.ops import APPLY_SCOPED_OPS, MUTATING_OPS, builtin_ops
from linux_xtu.helper.tune_state import _MAILBOX_WRITE_CMDS
from linux_xtu.mailbox import WRITE_COMMANDS

from ._support import TIMEOUT, HelperCase

#: The expected class of every built-in op. A new op fails this test until it is added here, on purpose: decide whether it mutates.
#: mutates = changes CPU / OS tuning (mailbox, MSR, sysfs; temporary ones restored at the end included) or saved data (profiles, accepted state, curves).
EXPECTED = {
    # read-only: hardware reads (a mailbox read is a WRMSR but changes nothing), files read, logs and caches written
    "preflight": False, "audit.tail": False, "throttle.tail": False, "telemetry.start": False, "telemetry.stop": False, "cancel": False,
    "vf.dump": False, "tune.read": False, "tune.plan": False, "tune.last": False, "profiles.list": False, "profiles.get": False, "profiles.diff": False,
    "curves.list": False, "curves.get": False, "mem.read": False, "stress.list": False, "stress.stop": False,
    "power.read": False, "power.plan": False, "runtime.read": False, "runtime.plan": False,
    # mutating
    "tune.apply": True, "power.apply": True, "runtime.apply": True, "vf.measure": True, "stress.start": True,
    "profiles.save": True, "profiles.accept": True, "profiles.fingerprint": True, "curves.update": True, "curves.delete": True,
}


class Classification(unittest.TestCase):
    def test_every_builtin_op_is_classified(self) -> None:
        ops = builtin_ops()
        self.assertEqual(set(ops), set(EXPECTED), "an op was added or removed: classify it in EXPECTED (and MUTATING_OPS in helper/ops.py)")
        self.assertEqual({n for n, s in ops.items() if s.mutates}, {n for n, m in EXPECTED.items() if m})
        self.assertEqual(MUTATING_OPS, {n for n, m in EXPECTED.items() if m})

    def test_every_hardware_write_op_mutates_and_every_apply_holds_the_apply_lock(self) -> None:
        ops = builtin_ops()
        self.assertTrue(APPLY_SCOPED_OPS <= MUTATING_OPS)
        for name in APPLY_SCOPED_OPS:
            self.assertTrue(ops[name].apply_scope and ops[name].long, name)
        # R-B8 (H1): the three applies write through the preflight gate; vf.measure / stress.start hold the lock for their cpufreq / EPP pinning, no mailbox write
        self.assertEqual({n for n in APPLY_SCOPED_OPS if ops[n].write}, {"tune.apply", "power.apply", "runtime.apply"})
        for name, spec in ops.items():
            if spec.mutates and not spec.long:
                self.assertTrue(spec.slow, f"{name}: a quick op on the dispatch thread may not change state")

    def test_the_stale_read_check_knows_every_mailbox_write_command(self) -> None:
        self.assertEqual(_MAILBOX_WRITE_CMDS, frozenset(int(c) for c in WRITE_COMMANDS))
        self.assertTrue({0x1F, 0x21, 0x23, 0x25} <= _MAILBOX_WRITE_CMDS)  # B-14: the four the hand-kept copy had missed
        self.assertTrue(all(type(c) is int for c in _MAILBOX_WRITE_CMDS))


class FilesLock(HelperCase):
    def test_file_changing_slow_ops_run_one_at_a_time_and_reads_do_not_wait(self) -> None:
        entered, release = threading.Event(), threading.Event()
        calls: list[str] = []

        def slow_save(helper, ctx, args):  # type: ignore[no-untyped-def]
            calls.append(args["tag"])
            entered.set()
            release.wait(TIMEOUT)
            return {"tag": args["tag"]}

        ops = {
            "stub.save": OpSpec("stub.save", slow_save, lambda a: a, slow=True, mutates=True),
            "stub.read": OpSpec("stub.read", lambda h, c, a: {"read": True}, lambda a: a, slow=True),
        }
        with mock.patch.object(core, "FILES_WAIT_S", 0.3):
            h = self.start(self.config(extra_ops=ops))
            h.send({"id": "a", "op": "stub.save", "args": {"tag": "a"}})
            self.assertTrue(entered.wait(TIMEOUT))
            self.assertTrue(h.call("r", "stub.read")["ok"])  # a read-only slow op is not held up
            busy = h.call("b", "stub.save", {"tag": "b"})
            self.assertEqual((busy["error"]["code"], busy["error"]["detail"]["check"]), ("BUSY", "FILES_BUSY"), busy)
            release.set()
            self.assertEqual(h.response("a")["result"], {"tag": "a"})
            self.assertEqual(h.call("c", "stub.save", {"tag": "c"})["result"], {"tag": "c"})
        self.assertEqual(calls, ["a", "c"])


if __name__ == "__main__":
    unittest.main()
