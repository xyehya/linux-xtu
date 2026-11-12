"""R-A1: the desktop app's Rust op allowlist (``ALLOWED_OPS`` in ``desktop/app/src-tauri/src/helper/ops.rs``) and the helper's op table
(``linux_xtu.helper.ops.builtin_ops``) name the same ops. Before D-053 this agreement was checked through ``web/server.py OPS``. The Rust file is only read."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from linux_xtu.helper.ops import builtin_ops

ROOT = Path(__file__).resolve().parents[2]
OPS_RS = ROOT / "desktop" / "app" / "src-tauri" / "src" / "helper" / "ops.rs"

# Helper ops the desktop app deliberately does not expose (name -> why). Empty: the two sets are identical today. Adding an op to the helper without
# adding it to the Rust allowlist fails this test; either add it there (the desktop owner) or list it here with the reason.
NOT_IN_DESKTOP: dict[str, str] = {}
# Ops the Rust allowlist names that the helper does not implement: none may exist (the link would forward a request the helper refuses).
NOT_IN_HELPER: dict[str, str] = {}


def rust_allowed_ops() -> list[str]:
    m = re.search(r"ALLOWED_OPS:\s*&\[&str\]\s*=\s*&\[(.*?)\];", OPS_RS.read_text(encoding="utf-8"), re.S)
    if m is None:
        raise AssertionError(f"ALLOWED_OPS not found in {OPS_RS.relative_to(ROOT)}")
    return re.findall(r'"([^"]+)"', m.group(1))


class DesktopAllowlistParity(unittest.TestCase):
    def test_the_scan_found_the_table(self) -> None:
        ops = rust_allowed_ops()
        self.assertGreaterEqual(len(ops), 20, "the ALLOWED_OPS scan is broken")
        self.assertEqual(len(ops), len(set(ops)), "duplicate entries in ALLOWED_OPS")

    def test_every_helper_op_is_in_the_desktop_allowlist_or_excluded_on_purpose(self) -> None:
        missing = sorted(set(builtin_ops()) - set(rust_allowed_ops()) - set(NOT_IN_DESKTOP))
        self.assertEqual(missing, [], "helper ops missing from ops.rs ALLOWED_OPS (add them there, or to NOT_IN_DESKTOP with a reason)")

    def test_every_desktop_op_exists_in_the_helper(self) -> None:
        extra = sorted(set(rust_allowed_ops()) - set(builtin_ops()) - set(NOT_IN_HELPER))
        self.assertEqual(extra, [], "ops.rs ALLOWED_OPS names ops the helper does not have")

    def test_the_exclusion_lists_are_not_stale(self) -> None:
        self.assertEqual(sorted(set(NOT_IN_DESKTOP) & set(rust_allowed_ops())), [])
        self.assertEqual(sorted(set(NOT_IN_HELPER) & set(builtin_ops())), [])


if __name__ == "__main__":
    unittest.main()
