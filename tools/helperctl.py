#!/usr/bin/env python3
"""Call one op of the installed root helper over its socket and print the JSON answer (the scriptable counterpart of the desktop app).

    python3 tools/helperctl.py OP [JSON-ARGS] [--timeout SECONDS] [--socket PATH] [--compact]

JSON-ARGS is a JSON object, ``@FILE`` (read it from a file) or ``-`` (read it from stdin); default ``{}``. The whole response line
(``{"id", "ok", "result" | "error"}``) is printed. Exit codes: 0 answered ok, 1 answered with an error, 2 could not connect / bad usage, 3 no answer in time.

It speaks only the helper's socket protocol (``linux_xtu.client``): the helper's allowlist, policy and guard decide everything, this tool has no hardware
code. Mutating ops need the helper's own two-step flow (``*.plan`` then ``*.apply`` with the typed confirmation), exactly as for any other client. Only one
client may be connected to the helper at a time: close the desktop app first."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from linux_xtu.client import HELPER_SOCKET, HelperConnectError, HelperTimeout, HelperUnavailable, RequestTooLarge, connect_helper  # noqa: E402


def _parse_args_text(text: str) -> dict[str, Any]:
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("the arguments must be a JSON object")
    return value


def main(argv: list[str] | None = None, *, connect: Callable[..., Any] = connect_helper, stdin: Any = None, out: Any = None, err: Any = None) -> int:
    out, err = out or sys.stdout, err or sys.stderr
    ap = argparse.ArgumentParser(prog="helperctl", description="Call one op of the linux-xtu root helper over its socket.")
    ap.add_argument("op", help="op name, e.g. preflight, tune.read, audit.tail")
    ap.add_argument("args", nargs="?", default="{}", help="JSON object, @FILE or - (stdin); default {}")
    ap.add_argument("--timeout", type=float, default=600.0, help="seconds to wait for the answer (default 600; reads of the whole V/F table take a while)")
    ap.add_argument("--socket", default=HELPER_SOCKET, help=f"helper socket (default {HELPER_SOCKET})")
    ap.add_argument("--compact", action="store_true", help="one-line JSON instead of indented")
    try:
        a = ap.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    try:
        if a.args == "-":
            text = (stdin or sys.stdin).read()
        elif a.args.startswith("@"):
            text = Path(a.args[1:]).read_text(encoding="utf-8")
        else:
            text = a.args
        args = _parse_args_text(text)
    except (OSError, ValueError) as exc:  # json.JSONDecodeError is a ValueError
        print(f"helperctl: bad arguments: {exc}", file=err)
        return 2
    try:
        link = connect(a.socket)
    except HelperConnectError as exc:
        print(f"helperctl: {exc}", file=err)
        return 2
    try:
        resp = link.call(a.op, args, timeout=a.timeout)
    except HelperTimeout:
        print(f"helperctl: no answer within {a.timeout:g} s (the helper may still be working; see audit.tail)", file=err)
        return 3
    except (HelperUnavailable, RequestTooLarge, ValueError) as exc:
        print(f"helperctl: {type(exc).__name__}: {exc}", file=err)
        return 2
    finally:
        link.close()
    print(json.dumps(resp, separators=(",", ":")) if a.compact else json.dumps(resp, indent=2, sort_keys=True), file=out)
    return 0 if resp.get("ok") is True else 1


if __name__ == "__main__":
    sys.exit(main())
