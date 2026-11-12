"""G-112 (helper half; the web server half went with D-053): the contract-9 ops of this task are registered with the right long/short flag, and the
helper's own argument validators (the authority) accept and refuse the shapes below."""
from __future__ import annotations

import unittest

from linux_xtu.helper.ops import builtin_ops
from linux_xtu.helper.protocol import OpError

PLAN_ID = "a" * 64
INTENT = {"scope": "unit", "rows": [{"target": "P0", "offset": {"kind": "curve", "mv": -10}, "v_target_v": None, "ratio": None}]}


def accepts(op: str, args: dict) -> bool:
    try:
        builtin_ops()[op].validate(args)
    except OpError:
        return False
    return True


class HelperOpValidators(unittest.TestCase):
    def test_the_ops_are_registered_with_their_long_flags(self) -> None:
        helper_ops = builtin_ops()
        for name in ("tune.read", "tune.plan", "tune.apply", "profiles.list", "profiles.save", "vf.dump"):
            self.assertIn(name, helper_ops, name)
        for name in ("tune.read", "tune.apply", "vf.dump"):
            self.assertTrue(helper_ops[name].long, name)

    def test_tune_read_takes_the_vf_dump_arguments(self) -> None:
        self.assertTrue(accepts("tune.read", {}))
        self.assertTrue(accepts("tune.read", {"cpus": [0, 1], "all_e": False}))
        self.assertFalse(accepts("tune.read", {"x": 1}))

    def test_tune_plan(self) -> None:
        self.assertTrue(accepts("tune.plan", {"intent": INTENT}))
        self.assertTrue(accepts("tune.plan", {"intent": {"reset": "stock"}}))
        for bad in ({}, {"intent": []}, {"intent": INTENT, "x": 1}):
            self.assertFalse(accepts("tune.plan", bad), bad)

    def test_tune_apply(self) -> None:
        self.assertTrue(accepts("tune.apply", {"plan_id": PLAN_ID, "typed": "CONFIRM ABC234"}))
        for bad in ({}, {"plan_id": PLAN_ID}, {"plan_id": "xyz", "typed": "CONFIRM ABC234"}, {"plan_id": PLAN_ID, "typed": "CONFIRM ABC234", "x": 1}):
            self.assertFalse(accepts("tune.apply", bad), bad)

    def test_profiles(self) -> None:
        self.assertTrue(accepts("profiles.list", {}))
        self.assertFalse(accepts("profiles.list", {"x": 1}))
        self.assertTrue(accepts("profiles.save", {"name": "my-p3.v1", "intent": INTENT}))
        for bad in ({}, {"name": "My", "intent": INTENT}, {"name": "ok"}, {"name": "../x", "intent": INTENT}, {"name": "ok", "intent": []}, {"name": "x" * 65, "intent": INTENT}):
            self.assertFalse(accepts("profiles.save", bad), bad)


if __name__ == "__main__":
    unittest.main()
