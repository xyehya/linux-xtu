"""R-A1: ``tools/helperctl.py`` against a real socket service (simulator). No root, no hardware, no systemd."""
from __future__ import annotations

import importlib.util
import io
import json
import os
import unittest
from pathlib import Path

from linux_xtu.client import connect_helper

from tests.helper.test_service import POSIX, ServiceCase

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("helperctl", ROOT / "tools" / "helperctl.py")
helperctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helperctl)


@unittest.skipUnless(POSIX, "Unix sockets")
class HelperCtl(ServiceCase):
    def run_ctl(self, *argv: str, stdin: str = ""):
        out, err = io.StringIO(), io.StringIO()
        connect = lambda path, **kw: connect_helper(path, owner_uid=os.geteuid(), **kw)  # noqa: E731  (the test socket is ours, not root's)
        rc = helperctl.main([*argv, "--socket", str(self.path)], connect=connect, stdin=io.StringIO(stdin), out=out, err=err)
        return rc, out.getvalue(), err.getvalue()

    def test_an_op_prints_the_response_json(self) -> None:
        self.serve()
        rc, out, _ = self.run_ctl("audit.tail", '{"n": 5}', "--compact")
        self.assertEqual(rc, 0)
        self.assertTrue(json.loads(out)["ok"])

    def test_args_from_stdin_and_a_helper_error_exits_1(self) -> None:
        self.serve()
        rc, out, _ = self.run_ctl("audit.tail", "-", stdin='{"n": 0}')
        self.assertEqual(rc, 1)
        self.assertFalse(json.loads(out)["ok"])

    def test_an_unlisted_op_is_the_helpers_refusal_not_ours(self) -> None:
        self.serve()
        rc, out, _ = self.run_ctl("no.such.op")
        self.assertEqual(rc, 1)
        self.assertFalse(json.loads(out)["ok"])

    def test_bad_json_and_missing_socket_exit_2(self) -> None:
        rc, _, err = self.run_ctl("audit.tail", "[1]")
        self.assertEqual(rc, 2)
        self.assertIn("JSON object", err)
        rc, _, err = self.run_ctl("preflight")  # nothing is serving
        self.assertEqual(rc, 2)
        self.assertIn("install.sh", err)


if __name__ == "__main__":
    unittest.main()
