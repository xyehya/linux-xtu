"""R-B6 (F3): ``tools/lnx/restore_accepted.py``, the default path of ``restore_tuning.sh``: a client of the installed helper, run as the user (no sudo). One typed
CONFIRM, then the plan's nonce goes to ``tune.apply``; the verdict is the helper's compare. Fake links for every branch, plus one run against the simulator
behind a real in-process helper (``linux_xtu.bootrestore.InProcessHelper``). No socket, no hardware."""
from __future__ import annotations

import importlib.util
import io
import json
import stat
import tempfile
import unittest
from pathlib import Path
from typing import Any

from linux_xtu.bootrestore import InProcessHelper
from linux_xtu.client import HelperConnectError

from ._support import REPO

spec = importlib.util.spec_from_file_location("restore_accepted", REPO / "tools/lnx/restore_accepted.py")
ra = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ra)

PLAN = {"plan_id": "a" * 64, "nonce": "ABC234", "name": "good", "writes": 3, "reads": 9, "ops_needed": 20, "complete": True,
        "warnings": [{"code": "NOTE", "text": "revert = cold boot"}]}
APPLIED = {"writes_sent": 3, "ops_used": 15, "complete": True, "residual": [], "ring_refused": [], "warnings": []}
READ_OK = {"accepted_match": [{"cpu": 0, "match": True, "diffs": []}, {"cpu": 8, "match": True, "diffs": []}], "accepted_note": None}
READ_BAD = {"accepted_match": [{"cpu": 0, "match": False, "diffs": [{"point": 6, "expected": "0xfc600037", "actual": "0x00000037"}]}], "accepted_note": None}


class FakeLink:
    def __init__(self, answers: dict[str, dict[str, Any]]) -> None:
        self.answers, self.calls, self.closed = answers, [], False

    def call(self, op: str, args: dict[str, Any] | None = None, timeout: float = 30.0) -> dict[str, Any]:
        self.calls.append((op, args))
        return self.answers[op]

    def close(self) -> None:
        self.closed = True


def ok(result: dict[str, Any]) -> dict[str, Any]:
    return {"id": "c1", "ok": True, "result": result}


class Client(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.runs = Path(tmp.name) / "runs"

    def go(self, link: FakeLink, *args: str, typed: str = "CONFIRM\n") -> tuple[int, str]:
        out, err = io.StringIO(), io.StringIO()
        rc = ra.main([*args, "--runs", str(self.runs)], connect=lambda: link, stdin=io.StringIO(typed), out=out, err=err)
        return rc, out.getvalue()

    def test_one_confirm_then_apply_with_the_plans_nonce_then_the_helpers_verdict(self) -> None:
        link = FakeLink({"tune.plan": ok(PLAN), "tune.apply": ok(APPLIED), "tune.read": ok(READ_OK)})
        rc, out = self.go(link)
        self.assertEqual(rc, 0, out)
        self.assertEqual([c[0] for c in link.calls], ["tune.plan", "tune.apply", "tune.read"])
        self.assertEqual(link.calls[0][1], {"intent": {"restore": "accepted"}})
        self.assertEqual(link.calls[1][1], {"plan_id": "a" * 64, "typed": "CONFIRM ABC234"})
        self.assertLess(out.index("Type CONFIRM to proceed"), out.index("=== apply"))
        self.assertIn("Result: OK", out)
        self.assertTrue(link.closed)
        record = next(self.runs.glob("restore-*.json"))
        self.assertEqual(stat.S_IMODE(record.stat().st_mode), 0o600)
        self.assertEqual(json.loads(record.read_text())["verdict"], "OK")

    def test_anything_but_confirm_sends_nothing(self) -> None:
        link = FakeLink({"tune.plan": ok(PLAN)})
        rc, out = self.go(link, typed="yes\n")
        self.assertEqual(rc, 1)
        self.assertIn("not confirmed - nothing was sent", out)
        self.assertEqual([c[0] for c in link.calls], ["tune.plan"])

    def test_check_reads_and_compares_only(self) -> None:
        link = FakeLink({"tune.read": ok(READ_OK)})
        rc, out = self.go(link, "--check")
        self.assertEqual(rc, 0)
        self.assertEqual([c[0] for c in link.calls], ["tune.read"])
        self.assertIn("Mode: --check", out)

    def test_a_bad_read_back_fails(self) -> None:
        link = FakeLink({"tune.plan": ok(PLAN), "tune.apply": ok(APPLIED), "tune.read": ok(READ_BAD)})
        rc, out = self.go(link)
        self.assertEqual(rc, 1)
        self.assertIn("BAD         cpu 0: point 6", out)
        self.assertIn("Result: BAD", out)

    def test_a_refused_plan_stops_before_the_confirmation(self) -> None:
        link = FakeLink({"tune.plan": {"id": "c1", "ok": False, "error": {"code": "REFUSED", "message": "No accepted state yet", "detail": {"check": "NO_ACCEPTED_STATE"}}}})
        rc, out = self.go(link)
        self.assertEqual(rc, 1)
        self.assertIn("NO_ACCEPTED_STATE", out)
        self.assertNotIn("Type CONFIRM", out)

    def test_a_partial_apply_and_a_refused_ring_are_said(self) -> None:
        partial = {**APPLIED, "complete": False, "ring_refused": ["the live ring OC word is not the accepted one"], "stop": {"reason": "read-back mismatch"}}
        link = FakeLink({"tune.plan": ok(PLAN), "tune.apply": ok(partial)})
        rc, out = self.go(link)
        self.assertEqual(rc, 1)
        self.assertIn("RING NOT RESTORED", out)
        self.assertIn("cold boot", out)

    def test_no_helper_is_exit_2_with_the_fix(self) -> None:
        def refuse():
            raise HelperConnectError("missing", "the helper is not installed or not started: /run/linux-xtu/helper.sock does not exist. Run: sudo bash install.sh")

        err = io.StringIO()
        self.assertEqual(ra.main(["--runs", str(self.runs)], connect=refuse, stdin=io.StringIO(""), out=io.StringIO(), err=err), 2)
        self.assertIn("install.sh", err.getvalue())

    def test_the_runs_directory_follows_xdg_state_home(self) -> None:
        self.assertEqual(ra.runs_dir({"XDG_STATE_HOME": "/x/state", "HOME": "/h"}), Path("/x/state/linux-xtu/runs"))
        self.assertEqual(ra.runs_dir({"XDG_STATE_HOME": "relative", "HOME": "/h"}), Path("/h/.local/state/linux-xtu/runs"))


class AgainstTheSimulator(unittest.TestCase):
    """The same client against the real helper dispatcher (in process, simulator): the restore the script does on the reference machine, minus the socket."""

    def test_a_cold_simulator_is_restored_and_read_back_ok(self) -> None:
        from tests.bootrestore._support import BootCase

        case = BootCase()
        case.setUp()
        self.addCleanup(case.doCleanups)
        runner = InProcessHelper(case.make_helper(case.env))
        link = runner.__enter__()
        self.addCleanup(runner.__exit__, None, None, None)
        out = io.StringIO()
        rc = ra.main(["--runs", str(case.tmp / "runs")], connect=lambda: link, stdin=io.StringIO("CONFIRM\n"), out=out, err=io.StringIO())
        self.assertEqual(rc, 0, out.getvalue())
        self.assertIn("Result: OK", out.getvalue())
        self.assertGreater(case.writes(), 0)
