#!/usr/bin/env python3
"""confirm_relay.py - run ONE linux-xtu CLI command and forward the ``CONFIRM <token>`` it prints back to it (host win, stdlib only).

    py -3 -I tools\\win\\confirm_relay.py py -3 -I tools\\linux-xtu.py vf-dump --device-win ...

The CLI asks for a typed ``CONFIRM <token>`` before every hardware command. ``restore_tuning.ps1`` asks the operator once for the whole run (or takes ``-Yes``)
and uses this relay to answer each command's own token; it is not a way around that confirmation and must not be run on its own, scheduled or unattended.
Exactly one prompt per command is answered: a second one is not. Output is streamed unchanged; the exit code is the CLI's. Python commands get ``-I``.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

_PROMPT = re.compile(r"CONFIRM (\S+)\n> $")


def isolate(argv: list[str]) -> list[str]:
    """``python x.py ...`` -> ``python -I x.py ...`` (unless an ``-I`` option is already given); any other program is left alone."""
    if not argv or not re.fullmatch(r"(?:python|py)[0-9.]*(?:\.exe)?", os.path.basename(argv[0]), re.IGNORECASE):
        return argv
    for a in argv[1:]:
        if not a.startswith("-"):
            break
        if a == "-I" or (not a.startswith("--") and "I" in a[1:] and a[1] not in "cmW"):
            return argv
    return [argv[0], "-I", *argv[1:]]


def main(argv: list[str]) -> int:
    if not argv:
        sys.exit(__doc__)
    proc = subprocess.Popen(isolate(argv), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=0)
    assert proc.stdin is not None and proc.stdout is not None
    tail = ""
    answered = False
    while True:
        ch = proc.stdout.read(1)
        if not ch:
            break
        sys.stdout.write(ch)
        tail = (tail + ch)[-200:]
        match = _PROMPT.search(tail)
        if match and not answered:
            proc.stdin.write(f"CONFIRM {match.group(1)}\n")
            proc.stdin.flush()
            proc.stdin.close()  # one answer per command: a second prompt reads end-of-file and is refused, never answered
            answered = True
    sys.stdout.flush()
    return proc.wait()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
