"""The boot restore against the simulator through the real in-process helper (plan -> apply -> read-back -> compare), and its clean marker across simulated boots:
a power loss / hang in the healthy window, an orderly shutdown, a hardware error after the apply, a stop during the apply."""
from __future__ import annotations

import json

from linux_xtu import bootrestore as br
from linux_xtu.msr import SimMsrPort

from ._support import BOOT_A, BOOT_B, BOOT_C, COLD, BootCase, PowerLoss


class HappyPath(BootCase):
    def test_arm_records_the_accepted_state_and_the_cpu_identity(self) -> None:
        st = self.arm()
        self.assertTrue(st["armed"])
        self.assertEqual(st["accepted"]["name"], "accepted-2026-10-04")
        self.assertRegex(st["accepted"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(st["identity"], {"vendor": "GenuineIntel", "family": 6, "model": 198, "stepping": 2, "microcode": "0x114",
                                          "brand": "Intel(R) Core(TM) Ultra 9 285K"})
        self.assertIsNone(st["pending"])
        self.assertEqual(self.paths.state.stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.sim.requests, [], "arming sends nothing")
        self.assertEqual([r["outcome"] for r in self.audit() if r.get("op") == "boot.restore.arm"], ["armed"])

    def test_a_cold_boot_is_restored_read_back_and_marked_clean(self) -> None:
        self.arm()
        rc = self.run_boot()
        out = self.out.getvalue()
        self.assertEqual(rc, br.EXIT_OK, out)
        self.assertGreater(self.writes(), 0)
        self.assertRegex(out, r"applied \d+ word\(s\) of the accepted state: accepted profile accepted-2026-10-04; read-back OK")
        self.assertIn("boot marked clean (healthy", out)
        st = self.state()
        self.assertTrue(st["armed"])
        self.assertIsNone(st["pending"])
        self.assertEqual((st["last"]["boot_id"], st["last"]["outcome"], st["last"]["clean_how"]), (BOOT_A, "applied", "healthy"))
        self.assertGreaterEqual(self.clock.uptime, 600.0, "the clean marker waits for the healthy uptime")
        # the audit: every guard record of the run names the unattended path; one result record says what happened, one the clean marker
        guard = [r for r in self.audit() if r.get("event") in ("attempt", "readback")]
        self.assertTrue(guard)
        self.assertEqual({r.get("operator") for r in guard}, {br.OPERATOR})
        rec = self.boot_records()[-1]
        self.assertEqual((rec["outcome"], rec["code"], rec["mode"], rec["operator"], rec["boot_id"]), ("applied", "OK", "unattended", br.OPERATOR, BOOT_A))
        self.assertEqual(rec["writes"], json.loads(json.dumps(st["last"]["writes"])))
        self.assertEqual([r["outcome"] for r in self.audit() if r.get("op") == "boot.restore.clean"], ["clean"])

    def test_r_b8_the_boot_restore_declares_its_client_version(self) -> None:
        # R-B8 (review of R-B3, H3): the boot restore sends preflight {client: {name, version, protocol}}; a protocol mismatch would fence its writes
        from linux_xtu import __version__
        from linux_xtu.helper.ops import PROTOCOL

        self.assertEqual(br.CLIENT, {"name": "linux-xtu-bootrestore", "version": __version__, "protocol": PROTOCOL})
        self.arm()
        self.assertEqual(self.run_boot(), br.EXIT_OK, self.out.getvalue())
        self.assertNotIn("CLIENT_UNVERSIONED", [r.get("reason") for r in self.audit()])

    def test_the_next_boot_finds_the_words_in_place_and_writes_nothing(self) -> None:
        self.arm()
        self.assertEqual(self.run_boot(), br.EXIT_OK)
        before = self.writes()
        self.new_boot(BOOT_B)  # a warm boot of the simulator: the words survive
        self.assertEqual(self.run_boot(), br.EXIT_OK, self.out.getvalue())
        self.assertEqual(self.writes(), before)
        self.assertIn("already in place (0 words written)", self.out.getvalue())
        self.assertEqual(self.state()["last"]["outcome"], "in_place")

    def test_a_second_start_in_the_same_boot_does_nothing(self) -> None:
        self.arm()
        self.assertEqual(self.run_boot(), br.EXIT_OK)
        made, sent = self.helpers_made, len(self.sim.requests)
        self.new_boot(BOOT_A)  # same boot id: a manual "systemctl start" later in the boot
        self.assertEqual(self.run_boot(), br.EXIT_OK)
        self.assertIn("ALREADY_RAN", self.out.getvalue())
        self.assertEqual((self.helpers_made, len(self.sim.requests)), (made, sent))

    def test_the_apply_waits_for_the_configured_delay(self) -> None:
        at: list[float] = []
        case = self

        class Timed(SimMsrPort):
            def wrmsr(self, cpu: int, msr: int, value: int) -> None:
                if not at:
                    at.append(case.clock.uptime)
                super().wrmsr(cpu, msr, value)

        self.sim = Timed(COLD)
        self.paths.config.write_text("apply_delay_s = 90\n")
        self.arm()
        self.assertEqual(self.run_boot(), br.EXIT_OK)
        self.assertGreaterEqual(at[0], 90.0)
        self.assertEqual(self.state()["history"][0]["boot_id"], BOOT_A)

    def test_pending_is_written_before_the_first_mailbox_transaction(self) -> None:
        seen: list[object] = []
        case = self

        class Watching(SimMsrPort):
            def wrmsr(self, cpu: int, msr: int, value: int) -> None:
                if not seen:
                    seen.append(json.loads(case.paths.state.read_text())["pending"])
                super().wrmsr(cpu, msr, value)

        self.sim = Watching(COLD)
        self.arm()
        self.assertEqual(self.run_boot(), br.EXIT_OK)
        self.assertEqual(seen[0]["boot_id"], BOOT_A)


class CleanMarker(BootCase):
    def test_a_power_loss_in_the_healthy_window_makes_the_next_boot_skip_and_stay_skipped(self) -> None:
        self.arm()
        self.clock.crash_at = 300.0
        with self.assertRaises(PowerLoss):  # the machine goes away 300 s after boot: the process never gets to the clean marker
            self.run_boot()
        self.assertEqual(self.state()["pending"]["boot_id"], BOOT_A)
        sent = len(self.sim.requests)
        self.new_boot(BOOT_B)
        rc = self.run_boot()
        self.assertEqual(rc, br.EXIT_SKIPPED)
        out = self.out.getvalue()
        self.assertIn("SKIPPED [PREVIOUS_BOOT_UNCLEAN]", out)
        self.assertIn("DISARMED", out)
        st = self.state()
        self.assertFalse(st["armed"])
        self.assertEqual(st["disarmed"]["code"], "PREVIOUS_BOOT_UNCLEAN")
        self.assertEqual(len(self.sim.requests), sent, "nothing is sent after an unclean boot")
        self.new_boot(BOOT_C)  # and it stays skipped
        self.assertEqual(self.run_boot(), br.EXIT_SKIPPED)
        self.assertIn("[NOT_ARMED]", self.out.getvalue())
        self.assertIn("PREVIOUS_BOOT_UNCLEAN", self.out.getvalue())  # the reason is repeated every boot
        self.assertEqual(len(self.sim.requests), sent)
        self.assertEqual([r["code"] for r in self.boot_records()][-2:], ["PREVIOUS_BOOT_UNCLEAN", "NOT_ARMED"])

    def test_re_arming_after_a_skip_restores_again(self) -> None:
        self.arm()
        self.clock.crash_at = 100.0
        with self.assertRaises(PowerLoss):
            self.run_boot()
        self.new_boot(BOOT_B)
        self.assertEqual(self.run_boot(), br.EXIT_SKIPPED)
        st = self.arm()  # the operator looked and re-armed: pending and disarmed are cleared
        self.assertIsNone(st["pending"])
        self.assertIsNone(st["disarmed"])
        self.new_boot(BOOT_C)
        self.assertEqual(self.run_boot(), br.EXIT_OK, self.out.getvalue())

    def test_an_orderly_shutdown_in_the_healthy_window_writes_the_clean_marker(self) -> None:
        self.arm()
        self.clock.stop_at = 200.0
        self.system = "stopping"
        self.assertEqual(self.run_boot(), br.EXIT_OK, self.out.getvalue())
        st = self.state()
        self.assertIsNone(st["pending"])
        self.assertEqual(st["last"]["clean_how"], "orderly shutdown")
        self.assertLess(self.clock.uptime, 600.0)
        self.new_boot(BOOT_B)
        self.assertEqual(self.run_boot(), br.EXIT_OK)

    def test_a_hardware_error_after_the_apply_leaves_no_clean_marker_and_disarms(self) -> None:
        self.arm()
        real_wait = self.clock.wait

        def wait(seconds: float) -> bool:  # a machine check is logged while the boot is watched (after the apply at 60 s uptime)
            if self.clock.uptime >= 60:
                self.klog["0"] = [*self.klog["0"], "mce: [Hardware Error]: Machine check events logged"]
            return real_wait(seconds)

        self.env.wait = wait
        self.assertEqual(self.run_boot(), br.EXIT_FAILED)
        st = self.state()
        self.assertEqual(st["pending"]["boot_id"], BOOT_A)
        self.assertFalse(st["armed"])
        self.assertEqual(st["disarmed"]["code"], "HARDWARE_ERROR_AFTER_APPLY")
        self.new_boot(BOOT_B)
        self.assertEqual(self.run_boot(), br.EXIT_SKIPPED)
        self.assertIn("[NOT_ARMED]", self.out.getvalue())

    def test_an_orderly_shutdown_with_a_hardware_error_is_not_clean(self) -> None:
        self.arm()
        self.clock.stop_at = 200.0
        real_wait = self.clock.wait

        def wait(seconds: float) -> bool:
            stopped = real_wait(seconds)
            if stopped:
                self.klog["0"] = [*self.klog["0"], "{1}[Hardware Error]: Hardware error from APEI Generic Hardware Error Source: 0"]
            return stopped

        self.env.wait = wait
        self.assertEqual(self.run_boot(), br.EXIT_FAILED)
        self.assertEqual(self.state()["pending"]["boot_id"], BOOT_A)

    def test_a_kernel_log_that_cannot_be_read_at_the_clean_point_is_not_clean(self) -> None:
        self.arm()
        real_wait = self.clock.wait

        def wait(seconds: float) -> bool:
            if self.clock.uptime >= 60:  # after the apply
                self.klog["0"] = None
            return real_wait(seconds)

        self.env.wait = wait
        self.assertEqual(self.run_boot(), br.EXIT_FAILED)
        self.assertEqual(self.state()["disarmed"]["code"], "KERNEL_LOG_UNAVAILABLE")

    def test_the_clean_marker_is_never_sooner_than_two_minutes_after_the_apply(self) -> None:
        self.paths.config.write_text("apply_delay_s = 590\nhealthy_uptime_s = 600\n")
        self.arm()
        self.assertEqual(self.run_boot(), br.EXIT_OK)
        self.assertGreaterEqual(self.clock.uptime, 590 + br.MIN_WATCH_S)

    def test_a_stop_before_the_delay_sends_nothing_and_changes_nothing(self) -> None:
        self.paths.config.write_text("apply_delay_s = 120\n")
        self.arm()
        before = self.paths.state.read_bytes()
        self.clock.stop_at = 60.0
        self.assertEqual(self.run_boot(), br.EXIT_OK)
        self.assertEqual((self.sim.requests, self.helpers_made), ([], 0))
        self.assertEqual(self.paths.state.read_bytes(), before)

    def test_a_shutdown_during_the_apply_cancels_at_a_safe_point_without_disarming(self) -> None:
        case = self

        class StopMidway(SimMsrPort):
            def wrmsr(self, cpu: int, msr: int, value: int) -> None:
                super().wrmsr(cpu, msr, value)
                if len(self.requests) == 40:
                    case.env.request_stop()  # SIGTERM while the apply runs: the helper finishes this transaction and stops

        self.sim = StopMidway(COLD)
        self.system = "stopping"
        self.arm()
        rc = self.run_boot()
        out = self.out.getvalue()
        self.assertEqual(rc, br.EXIT_OK, out)
        self.assertIn("cancelled", out)
        st = self.state()
        self.assertTrue(st["armed"], "a shutdown is not a crash: the boot restore stays armed")
        self.assertEqual(st["last"]["outcome"], "cancelled")
        self.assertIsNone(st["pending"], "orderly stop with a clean kernel log: clean marker")
        self.assertLess(len(self.sim.requests), 200)

    def test_a_shutdown_during_the_read_back_is_a_cancel_not_a_failure(self) -> None:
        from unittest import mock

        from linux_xtu.client import HelperLink

        real_call = HelperLink.call
        case = self

        def call(link, op, args=None, timeout=30.0):  # type: ignore[no-untyped-def]
            if op == "tune.read":
                case.env.request_stop()  # SIGTERM right after the apply answered
            return real_call(link, op, args, timeout)

        self.arm()
        self.system = "stopping"
        with mock.patch.object(HelperLink, "call", call):
            rc = self.run_boot()
        self.assertEqual(rc, br.EXIT_OK, self.out.getvalue())
        st = self.state()
        self.assertTrue(st["armed"])
        self.assertEqual(st["last"]["outcome"], "cancelled")
        self.assertIsNone(st["pending"])
        self.assertGreater(self.writes(), 0)


class ReviewFixes(BootCase):
    """Review of R-B6: the state is changed under a lock from a fresh read; only a shutdown is an orderly stop; kernel faults after the apply; running time."""

    def other_env(self) -> br.Env:  # a second process (the operator's sudo linux-xtu-restore ...) on the same files
        import io

        return br.Env(paths=self.paths, out=io.StringIO(), require_root=False, enforce_trust=False, boot_id=lambda: self.boot, uptime=lambda: self.clock.uptime,
                      monotonic=lambda: self.clock.monotonic, wall=lambda: self.clock.wall, detect=lambda: self.topo)

    def during_watch(self, at: float, action) -> list[bool]:  # type: ignore[no-untyped-def]
        real_wait, fired = self.clock.wait, []

        def wait(seconds: float) -> bool:
            stopped = real_wait(seconds)
            if self.clock.monotonic >= at and not fired:
                fired.append(True)
                action()
            return stopped

        self.env.wait = wait
        return fired

    def test_a_disarm_during_the_watch_is_not_overwritten(self) -> None:
        self.arm()
        fired = self.during_watch(300, lambda: br.disarm(self.other_env(), "operator saw instability"))
        self.assertEqual(self.run_boot(), br.EXIT_OK)
        self.assertTrue(fired)
        st = self.state()
        self.assertFalse(st["armed"])
        self.assertEqual(st["disarmed"]["reason"], "operator saw instability")
        self.assertIsNone(st["pending"], "the clean marker still clears this boot's pending")
        self.assertEqual(st["last"]["clean_how"], "healthy")
        writes = self.writes()
        self.new_boot(BOOT_B)
        self.assertEqual(self.run_boot(), br.EXIT_SKIPPED)
        self.assertIn("operator saw instability", self.out.getvalue())
        self.assertEqual(self.writes(), writes)

    def test_an_arm_during_the_watch_keeps_this_boots_pending(self) -> None:
        self.arm()
        self.during_watch(200, lambda: br.arm(self.other_env()))
        self.clock.crash_at = 400.0
        with self.assertRaises(PowerLoss):
            self.run_boot()
        self.assertEqual(self.state()["pending"]["boot_id"], BOOT_A)
        self.new_boot(BOOT_B)
        self.assertEqual(self.run_boot(), br.EXIT_SKIPPED)
        self.assertIn("[PREVIOUS_BOOT_UNCLEAN]", self.out.getvalue())

    def test_a_stop_that_is_not_a_shutdown_leaves_pending(self) -> None:
        self.arm()
        self.clock.stop_at = 200.0  # systemctl stop, SysRq REISUB's SIGTERM, ...: the system says "running"
        self.assertEqual(self.run_boot(), br.EXIT_FAILED)
        self.assertIn("is not shutting down", self.out.getvalue())
        st = self.state()
        self.assertEqual(st["pending"]["boot_id"], BOOT_A)
        self.assertTrue(st["armed"])
        self.new_boot(BOOT_B)
        self.assertEqual(self.run_boot(), br.EXIT_SKIPPED)
        self.assertIn("[PREVIOUS_BOOT_UNCLEAN]", self.out.getvalue())

    def test_an_unknown_system_state_is_not_a_shutdown(self) -> None:
        self.arm()
        self.clock.stop_at = 200.0
        self.system = None  # type: ignore[assignment]
        self.assertEqual(self.run_boot(), br.EXIT_FAILED)
        self.assertEqual(self.state()["pending"]["boot_id"], BOOT_A)

    def test_a_kernel_fault_after_the_apply_is_not_clean(self) -> None:
        self.arm()
        self.during_watch(200, lambda: self.klog["0"].append("watchdog: BUG: soft lockup - CPU#3 stuck for 22s! [cc1plus:4242]"))
        self.assertEqual(self.run_boot(), br.EXIT_FAILED)
        st = self.state()
        self.assertEqual(st["disarmed"]["code"], "KERNEL_FAULT_AFTER_APPLY")
        self.assertEqual(st["pending"]["boot_id"], BOOT_A)

    def test_kernel_faults_before_the_apply_and_user_space_faults_do_not_count(self) -> None:
        self.klog["0"].append("BUG: unable to handle page fault for address: ffff (before the apply)")
        self.arm()
        self.during_watch(200, lambda: self.klog["0"].extend([
            "cc1plus[4242]: segfault at 0 ip 00005555 sp 00007fff error 4 in cc1plus[5555+100]",
            "traps: cc1plus[4243] general protection fault ip:7f00 sp:7fff error:0 in libc.so.6[7f00+100]",
        ]))
        self.assertEqual(self.run_boot(), br.EXIT_OK, self.out.getvalue())
        self.assertIsNone(self.state()["pending"])

    def test_a_suspend_does_not_count_as_healthy_running_time(self) -> None:
        self.arm()
        real_wait, slept = self.clock.wait, []

        def wait(seconds: float) -> bool:
            if self.clock.monotonic >= 100 and not slept:
                slept.append(True)
                self.clock.suspend(3600)  # an hour asleep: uptime jumps, running time does not
            return real_wait(seconds)

        self.env.wait = wait
        self.assertEqual(self.run_boot(), br.EXIT_OK)
        self.assertGreaterEqual(self.clock.monotonic, 600.0, "the clean marker waited for 600 s of running time")

    def test_a_partial_apply_fails_disarms_and_leaves_pending(self) -> None:
        class StopsWriting(SimMsrPort):
            def wrmsr(self, cpu: int, msr: int, value: int) -> None:
                super().wrmsr(cpu, msr, value)
                if sum(1 for r in self.requests if r.cmd == 0x11) == 5:
                    self.silent_ignore(0x11)  # from the 6th 0x11 on the CPU answers Pass but keeps the old word: the read-back differs

        self.sim = StopsWriting(COLD)
        self.arm()
        self.assertEqual(self.run_boot(), br.EXIT_FAILED)
        out = self.out.getvalue()
        self.assertIn("[APPLY_PARTIAL]", out)
        self.assertIn("cold boot", out)
        st = self.state()
        self.assertFalse(st["armed"])
        self.assertEqual(st["pending"]["boot_id"], BOOT_A)
        self.assertNotIn("watching", out)

    def test_a_lost_helper_fails_and_disarms(self) -> None:
        from unittest import mock

        from linux_xtu.client import HelperLink, HelperUnavailable

        real_call = HelperLink.call

        def call(link, op, args=None, timeout=30.0):  # type: ignore[no-untyped-def]
            if op == "tune.apply":
                raise HelperUnavailable()
            return real_call(link, op, args, timeout)

        self.arm()
        with mock.patch.object(HelperLink, "call", call):
            self.assertEqual(self.run_boot(), br.EXIT_FAILED)
        self.assertIn("[HELPER_LOST]", self.out.getvalue())
        self.assertFalse(self.state()["armed"])
        self.assertEqual(self.state()["pending"]["boot_id"], BOOT_A)

    def test_verify_false_skips_the_full_read_back(self) -> None:
        from unittest import mock

        from linux_xtu.client import HelperLink

        real_call, ops = HelperLink.call, []

        def call(link, op, args=None, timeout=30.0):  # type: ignore[no-untyped-def]
            ops.append(op)
            return real_call(link, op, args, timeout)

        self.paths.config.write_text("verify = false\n")
        self.arm()
        with mock.patch.object(HelperLink, "call", call):
            self.assertEqual(self.run_boot(), br.EXIT_OK, self.out.getvalue())
        self.assertEqual(ops, ["preflight", "tune.plan", "tune.apply"])
        self.assertIn("verify = false", self.out.getvalue())
        self.assertIsNone(self.state()["pending"])

    def test_a_unit_missing_from_the_read_back_is_a_mismatch(self) -> None:
        from unittest import mock

        from linux_xtu.client import HelperLink

        real_call = HelperLink.call

        def call(link, op, args=None, timeout=30.0):  # type: ignore[no-untyped-def]
            resp = real_call(link, op, args, timeout)
            if op == "tune.read" and resp.get("ok"):
                resp["result"]["accepted_match"] = [e for e in resp["result"]["accepted_match"] if e.get("cpu") != 20]
            return resp

        self.arm()
        with mock.patch.object(HelperLink, "call", call):
            self.assertEqual(self.run_boot(), br.EXIT_FAILED)
        out = self.out.getvalue()
        self.assertIn("[MISMATCH]", out)
        self.assertIn("cpu 20: not in the read-back", out)

