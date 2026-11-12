"""R-D1: the results of ``tune.read`` / ``tune.last`` / ``tune.plan`` / ``tune.apply`` / ``profiles.*`` for one fixed run on the simulator, pinned as golden JSON.

Recorded on main before ``helper/ops_tune.py`` was split into ``tune_state`` / ``ops_tune_read`` / ``tune_intent`` / ``tune_predict`` / ``ops_tune_plan`` / ``ops_tune_apply`` /
``ops_profiles`` and the guarded session moved to ``helper/session.py`` (a behaviour-neutral restructuring): every result and error object, and every mailbox request and
plain MSR write the simulator latched, in order, must stay byte for byte what they were. Only values that are random per run are masked (``plan_id`` / ``nonce``, the
confirmation of ``profiles.accept``) and the temp directory is ``<TMP>``; the wall clock is fixed. Regenerate only on purpose:
``PYTHONPATH=src:. python3 -m tests.helper.test_golden_tune_ops``.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .test_accept import ACCEPT, AcceptCase
from .test_tune import row, rows

GOLDEN = Path(__file__).resolve().parents[1] / "golden" / "tune_ops_results.json"
FIXED = 1_792_324_800.0  # 2026-10-18T12:00:00Z
RANDOM_KEYS = frozenset({"plan_id", "nonce"})
OC_MAILBOX = 0x150


def _mask(value: Any, tmp: str, secrets: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {k: (f"<{k}>" if k in RANDOM_KEYS and isinstance(v, str) else _mask(v, tmp, secrets)) for k, v in value.items()}
    if isinstance(value, list):
        return [_mask(v, tmp, secrets) for v in value]
    if isinstance(value, str):
        out = value.replace(tmp, "<TMP>")
        for secret, label in secrets.items():
            out = out.replace(secret, label)
        return out
    return value


class Recorder(AcceptCase):
    """Runs the fixed sequence and returns ``{"steps": [[label, response]], "requests": [...]}``."""

    def runTest(self) -> None:  # noqa: N802 - unittest's name; lets the module's __main__ build one
        pass

    def record(self) -> dict[str, Any]:
        h = self.boot_accepting(wall_clock=lambda: FIXED)
        steps: list[list[Any]] = []
        secrets: dict[str, str] = {}

        def call(label: str, op: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
            r = h.call(f"g{len(h.messages)}", op, args or {}, timeout=60)
            res = r.get("result") if r.get("ok") else None
            if isinstance(res, dict):
                for key in RANDOM_KEYS:
                    if isinstance(res.get(key), str):
                        secrets.setdefault(res[key], f"<{key}>")
            steps.append([label, {k: v for k, v in r.items() if k != "id"}])
            return r

        def plan_apply(label: str, intent: dict[str, Any]) -> None:
            r = call(f"{label}: tune.plan", "tune.plan", {"intent": intent})
            if r.get("ok"):
                p = r["result"]
                call(f"{label}: tune.apply", "tune.apply", {"plan_id": p["plan_id"], "typed": "CONFIRM " + p["nonce"]})

        call("tune.last before a read of this process", "tune.last")
        call("tune.read", "tune.read")
        edits = rows(row("P3", points={"53": -60}), row("P4", curve=-40), row("EC1", curve=-30))
        plan_apply("rows", edits)
        plan_apply("turbo tables lowered", {"turbo": {"P": [56, 56, 54, 54, 54, 54, 54, 54], "E": [47] * 8}})
        call("tune.read after the applies", "tune.read")
        call("tune.last", "tune.last")
        plan_apply("ring point", {"ring": {"points": {"4": -10}}})
        call("positive point-only offset (refused)", "tune.plan", {"intent": rows(row("P0", points={"53": 20}))})
        call("target without an OC point (refused)", "tune.plan", {"intent": rows(row("P5", v=1.2))})
        call("curve and points on one unit (refused)", "tune.plan", {"intent": rows(row("P6", curve=-10), row("P6", points={"53": -10}))})
        p = call("OC ratio + target", "tune.plan", {"intent": rows(row("P2", ratio=58, v=1.30))})
        if p.get("ok"):
            call("OC ratio + target: wrong confirmation", "tune.apply", {"plan_id": p["result"]["plan_id"], "typed": "CONFIRM AAAAAA"})
            call("OC ratio + target: the edits changed since", "tune.apply", {"plan_id": p["result"]["plan_id"], "typed": "CONFIRM " + p["result"]["nonce"],
                                                                                "intent": rows(row("P2", ratio=57, v=1.30))})
        call("tune.read before saving", "tune.read")
        call("profiles.save from the read", "profiles.save", {"name": "snap", "from": "read"})
        call("profiles.save with edits", "profiles.save", {"name": "mine", "intent": rows(row("P1", curve=-25))})
        call("profiles.save over a name (refused)", "profiles.save", {"name": "snap", "from": "read"})
        call("profiles.list", "profiles.list")
        call("profiles.get mine", "profiles.get", {"name": "mine"})
        call("profiles.get snap", "profiles.get", {"name": "snap"})
        call("profiles.get unknown", "profiles.get", {"name": "nope"})
        call("profiles.diff read vs mine", "profiles.diff", {"a": "read", "b": "mine"})
        call("profiles.accept mine before it is applied (refused)", ACCEPT, {"name": "mine"})
        call("restore without an accepted state (refused)", "tune.plan", {"intent": {"restore": "accepted"}})
        plan_apply("saved profile mine", {"profile": "mine"})
        call("tune.read after applying mine", "tune.read")
        first = call("profiles.accept mine (step 1)", ACCEPT, {"name": "mine"})
        if first.get("ok") and first["result"].get("confirm_required"):
            res = first["result"]
            call("profiles.accept mine (step 2)", ACCEPT, {"plan_id": res["plan_id"], "typed": "CONFIRM " + res["nonce"]})
        call("profiles.list after the accept", "profiles.list")
        call("profiles.get the accepted profile", "profiles.get", {"name": "mine"})
        call("profiles.diff accepted vs snap", "profiles.diff", {"a": "accepted", "b": "snap"})
        call("profiles.fingerprint", "profiles.fingerprint")
        plan_apply("OC ratio + target applied", rows(row("P2", ratio=58, v=1.30), row("EC2", curve=-15)))
        call("tune.read after the OC point", "tune.read")
        plan_apply("restore accepted after an OC point", {"restore": "accepted"})
        call("tune.read after the restore", "tune.read")
        plan_apply("saved profile snap", {"profile": "snap"})
        plan_apply("reset stock", {"reset": "stock"})
        call("tune.last at the end", "tune.last")
        requests = [f"mbox cpu {r.cpu} cmd {r.cmd:#04x} p1 {r.p1} p2 {r.p2} data {r.data:#010x}" for r in self.sim.requests]
        writes = [f"wrmsr cpu {cpu} msr {msr:#x} value {value:#018x}" for cpu, msr, value in self.sim.writes if msr != OC_MAILBOX]
        return _mask({"steps": steps, "requests": requests, "msr_writes": writes}, str(self.tmp), secrets)


def record() -> dict[str, Any]:
    case = Recorder()
    case.setUp()
    try:
        return case.record()
    finally:
        case.doCleanups()


def dumps(value: Any) -> str:
    return json.dumps(value, indent=1, sort_keys=True) + "\n"


class TheTuneOpsResultsAreUnchanged(AcceptCase):
    def test_every_result_and_request_matches_the_golden_run(self) -> None:
        got = record()
        want = json.loads(GOLDEN.read_text())
        self.assertEqual(len(got["steps"]), len(want["steps"]))
        for (label, response), (want_label, want_response) in zip(got["steps"], want["steps"]):
            self.assertEqual(label, want_label)
            self.assertEqual(response, want_response, label)
        self.assertEqual(got["requests"], want["requests"])
        self.assertEqual(got["msr_writes"], want["msr_writes"])
        self.assertEqual(dumps(got), GOLDEN.read_text())

    def test_the_run_covers_applies_refusals_and_profiles(self) -> None:
        want = json.loads(GOLDEN.read_text())
        labels = {label: response for label, response in want["steps"]}
        self.assertTrue(labels["rows: tune.apply"]["result"]["complete"])
        self.assertTrue(labels["restore accepted after an OC point: tune.apply"]["result"]["complete"])
        self.assertTrue(labels["OC ratio + target applied: tune.apply"]["result"]["complete"])
        self.assertEqual(labels["positive point-only offset (refused)"]["error"]["detail"]["check"], "POSITIVE_OFFSET_UNPROVEN")
        self.assertEqual(labels["OC ratio + target: the edits changed since"]["error"]["code"], "PLAN_STALE")
        self.assertTrue(labels["profiles.accept mine (step 2)"]["ok"])
        self.assertTrue(re.search(r"cmd 0x11", "\n".join(want["requests"])))


if __name__ == "__main__":
    GOLDEN.write_text(dumps(record()))
    print(f"wrote {GOLDEN}")
