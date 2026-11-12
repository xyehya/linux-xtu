#!/usr/bin/env python3
"""restore_accepted.py - restore the INSTALLED accepted state through the root helper's socket, as YOU (no sudo, no root code from this checkout). Host lnx.

    python3 -I tools/lnx/restore_accepted.py [--check] [--runs DIR]

Called by ``tools/lnx/restore_tuning.sh`` (the default path). The helper restores only ``/etc/linux-xtu/accepted`` with ``/etc/linux-xtu/policy.toml``
(SPEC 4.4: root reads nothing but root-owned files); this tool is a client like the desktop app (``linux_xtu.client``), allowed by the ``[access]`` allowlist:

1. ``tune.plan {"restore": "accepted"}``: what the helper will do (writes, reads, mailbox operations, its warnings);
2. one typed ``CONFIRM`` (D-020a; anything else = nothing is sent). The client then hands the plan's nonce to ``tune.apply``, as the desktop shell does
   once you confirm there: the nonce binds the apply to the plan you were shown;
3. ``tune.apply`` (one guarded run: only the words that differ, one transaction at a time, each read back), then ``tune.read`` and the helper's word-for-word
   compare: per unit OK / EQUIVALENT (a residual OC point that runs the accepted voltages, G-147) / BAD.

``--check``: no plan and no apply, only the read and the compare (mailbox reads are WRMSRs too: still one CONFIRM). The JSON of the run goes to
``$XDG_STATE_HOME/linux-xtu/runs/`` (default ``~/.local/state/linux-xtu/runs/``), never into the checkout. Exit 0 = OK or EQUIVALENT, 1 = BAD / not confirmed /
refused, 2 = the helper cannot be reached. Only one client may use the helper at a time: close the desktop app first.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable, TextIO

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from linux_xtu.bootrestore import verdict  # noqa: E402
from linux_xtu.client import HelperConnectError, HelperTimeout, HelperUnavailable, connect_helper  # noqa: E402


def runs_dir(env: dict[str, str] | os._Environ[str] = os.environ) -> Path:
    xdg = env.get("XDG_STATE_HOME")
    base = Path(xdg) if xdg and os.path.isabs(xdg) else Path(env.get("HOME") or Path.home()) / ".local" / "state"
    return base / "linux-xtu" / "runs"


def _error(resp: dict[str, Any]) -> str:
    err = resp.get("error") or {}
    detail = err.get("detail") if isinstance(err.get("detail"), dict) else {}
    return f"{err.get('code')}{' / ' + str(detail.get('check')) if detail.get('check') else ''}: {err.get('message')}"


def main(argv: list[str] | None = None, *, connect: Callable[..., Any] = connect_helper, stdin: TextIO | None = None, out: TextIO | None = None,
         err: TextIO | None = None, clock: Callable[[], float] = time.time) -> int:
    stdin, out, err = stdin or sys.stdin, out or sys.stdout, err or sys.stderr
    ap = argparse.ArgumentParser(prog="restore_accepted", description="Restore /etc/linux-xtu/accepted through the root helper (one CONFIRM).")
    ap.add_argument("--check", action="store_true", help="read and compare only (no apply)")
    ap.add_argument("--runs", type=Path, default=None, help="where the run's JSON goes (default $XDG_STATE_HOME/linux-xtu/runs)")
    try:
        a = ap.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    say = lambda text: print(text, file=out, flush=True)  # noqa: E731
    try:
        link = connect()
    except HelperConnectError as exc:
        print(f"STOP: {exc}", file=err)
        return 2
    record: dict[str, Any] = {"at": time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(clock())), "mode": "check" if a.check else "restore"}
    try:
        plan: dict[str, Any] | None = None
        if not a.check:
            resp = link.call("tune.plan", {"intent": {"restore": "accepted"}}, timeout=300)
            if not resp.get("ok"):
                say(f"STOP: the helper refused the plan ({_error(resp)}). Nothing was sent.")
                return 1
            plan = resp["result"]
            record["plan"] = {k: plan.get(k) for k in ("name", "writes", "reads", "ops_needed", "ops_left", "complete", "rounds", "warnings")}
            say("Policy:   /etc/linux-xtu/policy.toml (installed; the helper reads no other)")
            say("Accepted: /etc/linux-xtu/accepted (" + str(plan.get("name")) + (", complete" if plan.get("complete") else ", partial (legacy)") + ")")
            say(f"Plan:     up to {plan.get('writes')} write(s) and {plan.get('reads')} read(s), {plan.get('ops_needed')} mailbox operation(s) at most; only the words that differ are written")
            for w in plan.get("warnings", []):
                say(f"  note: {w.get('text') if isinstance(w, dict) else w}")
            say("Mode: APPLY the accepted state in one guarded run, then read every word back and compare")
        else:
            say("Mode: --check (mailbox reads only, no writes): read every word and compare with /etc/linux-xtu/accepted")
        out.write("Type CONFIRM to proceed: ")
        out.flush()
        if stdin.readline().strip() != "CONFIRM":
            say("not confirmed - nothing was sent")
            return 1
        if plan is not None:
            resp = link.call("tune.apply", {"plan_id": plan["plan_id"], "typed": f"CONFIRM {plan['nonce']}"}, timeout=24 * 3600)
            if not resp.get("ok"):
                record["apply_error"] = resp.get("error")
                say(f"STOP: apply refused ({_error(resp)})")
                return 1
            res = resp["result"]
            record["apply"] = {k: res.get(k) for k in ("writes_sent", "ops_used", "complete", "residual", "ring_refused", "stop", "warnings")}
            say(f"=== apply: {res.get('writes_sent')} word(s) written, {res.get('ops_used')} mailbox operation(s), complete: {res.get('complete')}")
            if res.get("ring_refused"):
                say("RING NOT RESTORED: " + "; ".join(map(str, res["ring_refused"])))
            if not res.get("complete"):
                say(f"STOP: the apply stopped: {(res.get('stop') or {}).get('reason')}. The CPU holds a partial state: cold boot (power off) to get back to stock.")
                return 1
        say("=== read-back")
        resp = link.call("tune.read", {}, timeout=6 * 3600)
        if not resp.get("ok"):
            say(f"STOP: the read-back failed ({_error(resp)})")
            return 1
        word, lines = verdict(resp["result"].get("accepted_match"), resp["result"].get("accepted_note"))
        record["verdict"], record["lines"] = word, lines
        for line in lines:
            say(f"  {line}")
        say(f"Result: {word}")
        return 0 if word in ("OK", "EQUIVALENT") else 1
    except (HelperUnavailable, HelperTimeout) as exc:
        say(f"STOP: the helper stopped answering ({type(exc).__name__}); see: journalctl -u linux-xtu-helper -n 30")
        return 2
    finally:
        link.close()
        try:
            directory = a.runs if a.runs is not None else runs_dir()
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            target = directory / f"restore-{record['at']}.json"
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(record, handle, indent=1)
            print(f"run record: {target}", file=err)
        except OSError as exc:
            print(f"(run record not written: {exc})", file=err)


if __name__ == "__main__":
    sys.exit(main())
