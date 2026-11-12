"""confirm_relay.py forwards a CLI's own ``CONFIRM <token>`` once per command, streams its output and keeps its exit code (a fake CLI stands in; nothing real runs)."""
import importlib.util
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RELAY = ROOT / "tools" / "win" / "confirm_relay.py"
spec = importlib.util.spec_from_file_location("confirm_relay", RELAY)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)

FAKE_CLI = textwrap.dedent(
    """
    import sys
    sys.stdout.write("plan above\\nTo proceed type exactly:  CONFIRM tok123\\n> "); sys.stdout.flush()
    first = sys.stdin.readline().strip()
    print("got:", first)
    if first == "CONFIRM tok123":
        sys.stdout.write("again\\nTo proceed type exactly:  CONFIRM tok456\\n> "); sys.stdout.flush()
        print("second:", repr(sys.stdin.readline()))
        sys.exit(3)
    sys.exit(2)
    """
)


class Relay(unittest.TestCase):
    def run_relay(self, *argv):
        return subprocess.run([sys.executable, "-I", str(RELAY), *argv], capture_output=True, text=True, timeout=60)

    def test_answers_the_printed_token_once_and_keeps_the_exit_code(self):
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / "fake_cli.py"
            script.write_text(FAKE_CLI)
            r = self.run_relay(sys.executable, str(script))
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("got: CONFIRM tok123", r.stdout)
        self.assertIn("second: ''", r.stdout)      # the second prompt is never answered (stdin is closed)

    def test_no_command_is_an_error(self):
        self.assertNotEqual(self.run_relay().returncode, 0)

    def test_isolate_adds_the_isolated_flag_to_python_only(self):
        self.assertEqual(relay.isolate(["python", "x.py", "a"]), ["python", "-I", "x.py", "a"])
        self.assertEqual(relay.isolate(["py", "-3", "x.py"]), ["py", "-I", "-3", "x.py"])
        self.assertEqual(relay.isolate(["py", "-3", "-I", "x.py"]), ["py", "-3", "-I", "x.py"])
        self.assertEqual(relay.isolate(["python.exe", "-I", "x.py"]), ["python.exe", "-I", "x.py"])
        self.assertEqual(relay.isolate(["cmd", "/c", "x"]), ["cmd", "/c", "x"])


if __name__ == "__main__":
    unittest.main()
