#!/usr/bin/env python3
"""Run the linux-xtu CLI without installing it:  python3 tools/linux-xtu.py <command> ...

Puts ./src on sys.path and calls ``linux_xtu.cli.main``. Commands: ``--help``; the version: ``--version`` (the same ``linux_xtu.__version__`` the helper reports).
Anything that talks to real hardware needs ``--device``, ``LINUX_XTU_ALLOW_MAILBOX=1`` exported by YOU, and an interactive confirmation.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from linux_xtu.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
