"""R-B3 (assessment 06 F5): the version handshake of ``preflight`` -- one version source, a protocol integer, the op-set hash -- and what a protocol
mismatch does (audited; the connection's write and mutating ops refused). Simulator, temp paths."""
from __future__ import annotations

import hashlib
import json
import re
import unittest
from typing import Any

import linux_xtu
from linux_xtu.helper import OpSpec
from linux_xtu.helper.ops import PROTOCOL, builtin_ops, ops_hash

from ._support import HelperCase


class VersionCase(HelperCase):
    def records(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.audit.read_text().splitlines() if line.strip()] if self.audit.exists() else []


class Handshake(VersionCase):
    def test_preflight_reports_version_protocol_and_the_op_set(self) -> None:
        r = self.start().call("1", "preflight")
        self.assertTrue(r["ok"], r)
        info = r["result"]["helper"]
        self.assertEqual(info["version"], linux_xtu.__version__)
        self.assertEqual(info["version"], "0.2.0-dev")
        self.assertEqual(info["protocol"], PROTOCOL)
        self.assertIsInstance(PROTOCOL, int)
        names = sorted(builtin_ops())
        self.assertEqual(info["ops"], len(names))
        self.assertEqual(info["ops_hash"], hashlib.sha256("\n".join(names).encode()).hexdigest())  # the documented definition, recomputable by any client
        self.assertNotIn("client", r["result"])

    def test_the_hash_moves_with_the_op_set_and_not_with_order(self) -> None:
        self.assertEqual(ops_hash(["b", "a"]), ops_hash(["a", "b"]))
        self.assertNotEqual(ops_hash(["a", "b"]), ops_hash(["a", "b", "c"]))
        self.assertRegex(ops_hash(builtin_ops()), r"^[0-9a-f]{64}$")
        stub = OpSpec("stub.extra", lambda h, c, a: {}, lambda a: a)
        r = self.start(self.config(extra_ops={"stub.extra": stub})).call("1", "preflight")
        self.assertNotEqual(r["result"]["helper"]["ops_hash"], ops_hash(builtin_ops()))  # what this helper serves, extras included

    def test_the_version_is_semver_with_a_prerelease_tag(self) -> None:
        self.assertRegex(linux_xtu.__version__, r"^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$")

    def test_a_matching_client_is_echoed_and_may_write(self) -> None:
        h = self.start()
        r = h.call("1", "preflight", {"client": {"name": "linux-xtu-desktop", "version": "0.2.0-dev", "protocol": PROTOCOL}})
        self.assertEqual(r["result"]["client"], {"name": "linux-xtu-desktop", "version": "0.2.0-dev", "protocol": PROTOCOL, "protocol_ok": True})
        self.assertTrue(h.call("2", "vf.dump", {"cpus": "0"})["ok"])
        self.assertNotIn("VERSION_MISMATCH", [x.get("reason") for x in self.records()])

    def test_bad_client_shapes_are_bad_requests(self) -> None:
        h = self.start()
        for i, client in enumerate(({"protocol": "1"}, {"protocol": -1}, {"protocol": True}, {"name": ""}, {"name": "x" * 65}, {"name": "a\nb"}, {"extra": 1}, "x", [1])):
            with self.subTest(client=client):
                r = h.call(f"b{i}", "preflight", {"client": client})
                self.assertEqual(r["error"]["code"], "BAD_REQUEST", r)
        self.assertEqual(h.call("u", "preflight", {"nope": 1})["error"]["code"], "BAD_REQUEST")


class Unversioned(VersionCase):
    """R-B8 (H3): a client that declares no protocol is accepted for now (the desktop shell starts sending ``client`` in a later package), and noted: logged and
    audited once per connection as ``CLIENT_UNVERSIONED``."""

    def unversioned(self) -> list[dict[str, Any]]:
        return [x for x in self.records() if x.get("reason") == "CLIENT_UNVERSIONED"]

    def test_no_client_field_is_accepted_and_audited_once_per_connection(self) -> None:
        h = self.start()
        self.assertTrue(h.call("1", "preflight")["ok"])
        self.assertTrue(h.call("2", "preflight", {"client": {"name": "old-shell", "version": "0.1.0"}})["ok"])  # a client block without a protocol: the same
        self.assertTrue(h.call("3", "vf.dump", {"cpus": "0"})["ok"])  # still allowed to write
        recs = self.unversioned()
        self.assertEqual([(x["event"], x["stage"], x["kind"]) for x in recs], [("result", "preflight", "helper")])
        self.assertIn("declared no helper protocol", recs[0]["detail"])
        self.assertTrue(any("CLIENT_UNVERSIONED" in line or "declared no helper protocol" in line for line in self.logs), self.logs)
        h.helper._reset_connection()  # noqa: SLF001 -- a new client
        h.call("4", "preflight")
        self.assertEqual(len(self.unversioned()), 2)

    def test_a_versioned_client_is_not_noted(self) -> None:
        h = self.start()
        h.call("1", "preflight", {"client": {"name": "linux-xtu-desktop", "protocol": PROTOCOL}})
        self.assertEqual(self.unversioned(), [])


class Mismatch(VersionCase):
    def test_a_mismatch_is_audited_answered_and_fences_the_connections_writes(self) -> None:
        h = self.start()
        r = h.call("1", "preflight", {"client": {"name": "linux-xtu-desktop", "version": "9.9.9", "protocol": PROTOCOL + 1}})
        self.assertTrue(r["ok"], r)  # the client still learns both versions
        self.assertEqual(r["result"]["helper"]["protocol"], PROTOCOL)
        self.assertFalse(r["result"]["client"]["protocol_ok"])
        mismatch = [x for x in self.records() if x.get("reason") == "VERSION_MISMATCH"]
        self.assertEqual([(x["event"], x["stage"], x["client"]["protocol"], x["helper_protocol"]) for x in mismatch], [("error", "preflight", PROTOCOL + 1, PROTOCOL)])
        self.assertIn("9.9.9", mismatch[0]["detail"])
        writes = len(self.sim.writes)
        for i, (op, args) in enumerate((("vf.dump", {"cpus": "0"}), ("tune.apply", {"plan_id": "0" * 64, "typed": "CONFIRM ABCDEF"}), ("profiles.save", {"name": "x", "from": "read"}))):
            with self.subTest(op=op):
                e = h.call(f"w{i}", op, args)
                self.assertEqual((e["error"]["code"], e["error"]["detail"]["check"]), ("REFUSED", "VERSION_MISMATCH"), e)
        self.assertEqual(len(self.sim.writes), writes)
        self.assertTrue(h.call("r", "audit.tail", {"n": 1})["ok"])  # reads stay available
        refused = [x for x in self.records() if x.get("reason") == "VERSION_MISMATCH" and x["event"] == "refused"]
        self.assertEqual([x["op"] for x in refused], ["vf.dump", "tune.apply", "profiles.save"])

    def test_a_mismatch_is_sticky_for_the_connection(self) -> None:
        # R-B8 (review of R-B3, H3): a later preflight declaring the right protocol (or none) does not clear it; only a new connection does
        h = self.start()
        h.call("1", "preflight", {"client": {"protocol": PROTOCOL + 1}})
        self.assertEqual(h.call("2", "vf.dump", {"cpus": "0"})["error"]["detail"]["check"], "VERSION_MISMATCH")
        again = h.call("3", "preflight", {"client": {"protocol": PROTOCOL}})
        self.assertFalse(again["result"]["client"]["protocol_ok"], again)
        self.assertEqual(h.call("4", "vf.dump", {"cpus": "0"})["error"]["detail"]["check"], "VERSION_MISMATCH")
        h.call("5", "preflight")
        self.assertEqual(h.call("6", "vf.dump", {"cpus": "0"})["error"]["detail"]["check"], "VERSION_MISMATCH")

    def test_the_fence_is_per_connection(self) -> None:
        h = self.start()
        h.call("1", "preflight", {"client": {"protocol": PROTOCOL + 1}})
        h.helper._reset_connection()  # noqa: SLF001 -- what Helper.serve does when a socket client leaves
        self.assertTrue(h.helper.client_protocol_ok)

    def test_a_failing_preflight_still_carries_the_versions(self) -> None:
        def boom() -> Any:
            raise RuntimeError("no /proc")

        r = self.start(self.config(preflight_fn=boom)).call("1", "preflight", {"client": {"protocol": PROTOCOL}})
        self.assertEqual(r["error"]["code"], "PREFLIGHT_FAILED")
        self.assertEqual(r["error"]["detail"]["helper"]["protocol"], PROTOCOL)
        self.assertTrue(r["error"]["detail"]["client"]["protocol_ok"])
        self.assertTrue(re.match(r"\d", r["error"]["detail"]["helper"]["version"]))


class VersionFiles(unittest.TestCase):
    """R-B8: ``linux_xtu.__version__`` is the one source; the package metadata and the desktop shell's manifests say the same."""

    def test_pyproject_tauri_and_cargo_agree_with_the_package(self) -> None:
        import tomllib
        from pathlib import Path

        root = Path(__file__).resolve().parents[2]
        tauri_dir = root / "desktop" / "app" / "src-tauri"
        cargo = tomllib.loads((tauri_dir / "Cargo.toml").read_text(encoding="utf-8"))
        lock = tomllib.loads((tauri_dir / "Cargo.lock").read_text(encoding="utf-8"))
        found = {
            "pyproject.toml": tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"],
            "tauri.conf.json": json.loads((tauri_dir / "tauri.conf.json").read_text(encoding="utf-8"))["version"],
            "Cargo.toml": cargo["package"]["version"],
            "Cargo.lock": next(p["version"] for p in lock["package"] if p["name"] == cargo["package"]["name"]),
        }
        self.assertEqual(found, dict.fromkeys(found, linux_xtu.__version__))


if __name__ == "__main__":
    unittest.main()
