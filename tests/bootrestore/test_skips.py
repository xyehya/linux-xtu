"""Every reason the boot restore does NOT apply (fail closed): nothing is sent, the run says why (journal line + audit record), and it disarms itself so the
next boot skips too until the operator re-arms. (a) an unclean previous boot is in test_happy_and_marker; here (b) machine-check lines / unreadable logs,
(c) the accepted state and the CPU identity, (d) locks, and the rest (kernel opt-out, config, state, boot id, preflight, a mismatching read-back)."""
from __future__ import annotations

import json
import shutil

from linux_xtu import bootrestore as br
from linux_xtu.helper import InstanceLock
from linux_xtu.topology import synthetic

from ._support import BOOT_B, EXAMPLE, READ_ONLY_REPORT, BootCase


class SkipCase(BootCase):
    def assert_skip(self, code: str, *, rc: int = br.EXIT_SKIPPED, disarmed: bool = True, helper: bool = False) -> str:
        """The run skipped with ``code``: exit code, no mailbox traffic, the reason in the journal and the audit, disarmed (or not), and skipped again next boot."""
        made = self.helpers_made
        got = self.run_boot()
        out = self.out.getvalue()
        self.assertEqual(got, rc, out)
        self.assertIn(f"[{code}]", out)
        self.assertEqual(self.sim.requests, [], f"{code}: nothing may be sent")
        if not helper:
            self.assertEqual(self.helpers_made, made, f"{code}: decided before the helper starts")
        rec = self.boot_records()[-1]
        self.assertEqual((rec["code"], rec["operator"], rec["mode"]), (code, br.OPERATOR, "unattended"))
        if self.paths.state.exists():
            st = self.state()
            if disarmed:
                self.assertFalse(st["armed"], code)
                self.assertEqual(st["disarmed"]["code"], code)
                self.assertIn("DISARMED", out)
                self.new_boot(BOOT_B)
                self.assertEqual(self.run_boot(), br.EXIT_SKIPPED)
                self.assertIn("[NOT_ARMED]", self.out.getvalue())
                self.assertEqual(self.sim.requests, [])
        return out


class KernelLog(SkipCase):
    def test_a_machine_check_this_boot(self) -> None:
        self.arm()
        self.klog["0"].append("mce: [Hardware Error]: Machine check events logged")
        self.assertIn("Machine check events logged", self.assert_skip("MCE_THIS_BOOT"))

    def test_a_machine_check_in_the_previous_boot(self) -> None:
        self.arm()
        self.klog["-1"].append("Kernel panic - not syncing: Fatal machine check on current CPU")
        self.assert_skip("MCE_PREVIOUS_BOOT")

    def test_this_boots_log_cannot_be_read(self) -> None:
        self.arm()
        self.klog["0"] = None
        self.assert_skip("KERNEL_LOG_UNAVAILABLE")

    def test_the_previous_boots_log_cannot_be_read(self) -> None:
        self.arm()
        self.klog["-1"] = None
        self.assertIn("persistent", self.assert_skip("PREVIOUS_BOOT_LOG_UNAVAILABLE"))

    def test_previous_boot_log_ignore_checks_this_boot_only(self) -> None:
        self.paths.config.write_text('previous_boot_log = "ignore"\n')
        self.arm()
        self.klog["-1"] = None
        self.assertEqual(self.run_boot(), br.EXIT_OK, self.out.getvalue())

    def test_arm_refuses_when_every_boot_would_skip_for_a_volatile_journal(self) -> None:
        shutil.rmtree(self.paths.journal_dir)
        self.assertEqual(br.main(["arm"], self.env), br.EXIT_FAILED)
        self.assertIn("PREVIOUS_BOOT_LOG_UNAVAILABLE", self.out.getvalue())
        self.assertFalse(self.paths.state.exists())


class AcceptedState(SkipCase):
    def test_no_accepted_state(self) -> None:
        self.arm()
        shutil.rmtree(self.acc)
        self.assertIn("Set as accepted", self.assert_skip("ACCEPTED_MISSING"))

    def test_an_older_chain(self) -> None:
        self.arm()
        (self.acc / "CURRENT").write_text("profile = profiles/accepted-2026-10-04.toml\nprofile = profiles/accepted-2026-10-04.toml\n")
        self.assert_skip("ACCEPTED_CHAIN")

    def test_a_partial_legacy_profile(self) -> None:
        self.arm()
        shutil.copy(EXAMPLE / "p-step7.toml", self.acc / "profiles" / "p-step7.toml")
        (self.acc / "CURRENT").write_text("profile = profiles/p-step7.toml\n")
        self.assert_skip("ACCEPTED_INCOMPLETE")

    def test_an_unreadable_profile(self) -> None:
        self.arm()
        (self.acc / "profiles" / "accepted-2026-10-04.toml").write_text("[meta\nname = \n")
        self.assert_skip("ACCEPTED_INVALID")

    def test_a_missing_profile_file_or_expected_words(self) -> None:
        self.arm()
        (self.acc / "EXPECTED-words.txt").unlink()
        self.assert_skip("ACCEPTED_INVALID")

    def test_no_fingerprint(self) -> None:
        self.arm()
        (self.acc / "fingerprint.json").unlink()
        self.assert_skip("ACCEPTED_NO_FINGERPRINT")

    def test_arm_refuses_an_accepted_state_it_could_not_restore(self) -> None:
        (self.acc / "fingerprint.json").unlink()
        self.assertEqual(br.main(["arm"], self.env), br.EXIT_FAILED)
        self.assertIn("refused [ACCEPTED_NO_FINGERPRINT]", self.out.getvalue())
        self.assertFalse(self.paths.state.exists())

    def test_another_cpu_model(self) -> None:
        self.arm()
        self.write_cpuinfo(brand="Intel(R) Core(TM) Ultra 7 265K")
        self.assertIn("not the CPU the state was accepted on", self.assert_skip("IDENTITY_MISMATCH"))

    def test_another_layout(self) -> None:
        self.arm()
        self.topo = synthetic(6, 8, favored_p=(0, 3))
        self.assert_skip("IDENTITY_MISMATCH")

    def test_a_microcode_update_since_arming(self) -> None:
        self.arm()
        self.micro = "0x119"
        self.write_cpuinfo()
        self.assertIn("microcode '0x114' -> '0x119'", self.assert_skip("IDENTITY_CHANGED"))

    def test_a_new_accepted_state_needs_a_new_arm(self) -> None:
        self.arm()
        with (self.acc / "profiles" / "accepted-2026-10-04.toml").open("a") as fh:
            fh.write("# edited after arming\n")
        self.assertIn("arm again", self.assert_skip("ACCEPTED_CHANGED"))

    def test_bind_accepted_false_applies_the_current_accepted_state(self) -> None:
        self.paths.config.write_text("bind_accepted = false\n")
        self.arm()
        with (self.acc / "profiles" / "accepted-2026-10-04.toml").open("a") as fh:
            fh.write("# edited after arming\n")
        self.assertEqual(self.run_boot(), br.EXIT_OK, self.out.getvalue())


class Locks(SkipCase):
    """(d) A busy helper or a mailbox lock is waited for (busy_wait_s, retried every 15 s); then the boot is skipped WITHOUT disarming: nothing was sent."""

    def setUp(self) -> None:
        super().setUp()
        self.paths.config.write_text("busy_wait_s = 60\n")

    def test_the_mailbox_lock_exists(self) -> None:
        self.arm()
        self.paths.lock.write_text("4242\n")
        out = self.assert_skip("MAILBOX_LOCK", disarmed=False)
        self.assertIn("still so after 60 s", out)
        self.assertIn("trying again in 15 s", out)
        self.assertTrue(self.state()["armed"])
        self.assertNotIn("DISARMED", out)

    def test_another_helper_holds_the_instance_lock(self) -> None:
        self.arm()
        held = InstanceLock(self.paths.lock)
        held.acquire()  # the socket helper serving the desktop app
        self.addCleanup(held.release)
        out = self.assert_skip("HELPER_BUSY", helper=True, disarmed=False)
        self.assertIn("instance lock", out)
        self.assertGreaterEqual(self.helpers_made, 4, "it tried again")
        self.assertTrue(self.state()["armed"])
        self.new_boot(BOOT_B)  # the next boot tries again
        held.release()
        self.assertEqual(self.run_boot(), br.EXIT_OK, self.out.getvalue())

    def test_a_helper_that_closes_within_the_wait_is_used(self) -> None:
        self.arm()
        held = InstanceLock(self.paths.lock)
        held.acquire()
        real_wait = self.clock.wait

        def wait(seconds: float) -> bool:
            held.release()  # the desktop app is closed while the restore waits
            return real_wait(seconds)

        self.env.wait = wait
        self.assertEqual(self.run_boot(), br.EXIT_OK, self.out.getvalue())
        self.assertGreater(self.writes(), 0)

    def test_a_disarm_while_the_run_starts_sends_nothing(self) -> None:
        self.arm()
        self.paths.lock.write_text("4242\n")
        real_wait = self.clock.wait

        def wait(seconds: float) -> bool:
            if self.clock.uptime >= 60 and self.paths.lock.exists():  # the busy wait after the checks (not the apply delay before them)
                self.paths.lock.unlink()
                br.disarm(self.env, "changed my mind")  # the operator, while the run waits
            return real_wait(seconds)

        self.env.wait = wait
        self.assertEqual(self.run_boot(), br.EXIT_SKIPPED)
        self.assertIn("[DISARMED_MEANWHILE]", self.out.getvalue())
        self.assertEqual(self.sim.requests, [])
        self.assertEqual(self.state()["disarmed"]["reason"], "changed my mind")


class Other(SkipCase):
    def test_never_armed(self) -> None:
        self.assertEqual(self.run_boot(), br.EXIT_SKIPPED)
        self.assertIn("[NOT_ARMED]", self.out.getvalue())
        self.assertEqual((self.sim.requests, self.helpers_made), ([], 0))
        self.assertFalse(self.paths.state.exists(), "not armed: nothing is written but the audit record")
        self.assertEqual(self.boot_records()[-1]["code"], "NOT_ARMED")

    def test_disarmed_by_the_operator(self) -> None:
        self.arm()
        self.assertEqual(br.main(["disarm", "--reason", "testing a new BIOS"], self.env), br.EXIT_OK)
        self.assertEqual(self.run_boot(), br.EXIT_SKIPPED)
        self.assertIn("testing a new BIOS", self.out.getvalue())
        self.assertEqual(self.sim.requests, [])

    def test_the_kernel_command_line_opt_out(self) -> None:
        self.arm()
        (self.tmp / "cmdline").write_text("BOOT_IMAGE=/vmlinuz root=UUID=x ro linux-xtu.norestore quiet\n")
        self.assert_skip("KERNEL_OPT_OUT")

    def test_the_old_kernel_command_line_opt_out_still_works(self) -> None:
        """D-054: the switch under the earlier name (``arltuner.norestore``) is honoured during the transition."""
        self.arm()
        (self.tmp / "cmdline").write_text("BOOT_IMAGE=/vmlinuz root=UUID=x ro arltuner.norestore=1 quiet\n")
        self.assertIn(br.KERNEL_OPT_OUT_LEGACY, self.assert_skip("KERNEL_OPT_OUT"))

    def test_an_invalid_config(self) -> None:
        self.arm()
        for text in ("apply_delay_s = 5\n", "verify = 1\n", "colour = 3\n", 'previous_boot_log = "maybe"\n', "healthy_uptime_s = [\n"):
            with self.subTest(text=text):
                self.paths.config.write_text(text)
                self.assertRaises(br.ConfigError, br.load_config, self.env)
        self.paths.config.write_text("colour = 3\n")
        self.assert_skip("CONFIG_INVALID")

    def test_an_unreadable_state_is_a_skip_that_changes_nothing(self) -> None:
        self.arm()
        self.paths.state.write_text("{not json")
        self.assertEqual(self.run_boot(), br.EXIT_SKIPPED)
        self.assertIn("[STATE_UNREADABLE]", self.out.getvalue())
        self.assertEqual(self.paths.state.read_text(), "{not json")
        self.assertEqual(self.sim.requests, [])

    def test_an_unknown_boot_id(self) -> None:
        self.arm()
        self.env.boot_id = lambda: None
        self.assert_skip("BOOT_ID_UNKNOWN")

    def test_a_preflight_that_forbids_writes_is_refused_and_disarms(self) -> None:
        self.arm()
        self.report = READ_ONLY_REPORT
        out = self.assert_skip("PREFLIGHT", rc=br.EXIT_FAILED, helper=True)
        self.assertIn("lockdown", out)

    def test_a_read_back_that_is_not_the_accepted_state_fails_and_disarms(self) -> None:
        self.paths.config.write_text("bind_accepted = false\n")
        self.arm()
        text = (self.acc / "EXPECTED-words.txt").read_text().replace("F9A00035 FC600037", "F9A00035 FC400037", 1)  # P0 point 6 expected otherwise
        (self.acc / "EXPECTED-words.txt").write_text(text)
        rc = self.run_boot()
        out = self.out.getvalue()
        self.assertEqual(rc, br.EXIT_FAILED, out)
        self.assertIn("[MISMATCH]", out)
        self.assertIn("BAD         cpu 0", out)
        st = self.state()
        self.assertFalse(st["armed"])
        self.assertEqual(st["pending"]["boot_id"], st["last"]["boot_id"], "a failed run after writes leaves no clean marker")

    def test_status_says_why_it_is_disarmed(self) -> None:
        self.arm()
        self.klog["0"].append("mce: [Hardware Error]: CPU 3: Machine Check: 0 Bank 5: be00000000800400")
        self.run_boot()
        self.out.seek(0)
        self.out.truncate()
        self.assertEqual(br.main(["status"], self.env), br.EXIT_OK)
        text = self.out.getvalue()
        self.assertIn("armed:     NO", text)
        self.assertIn("[MCE_THIS_BOOT]", text)
        self.out.seek(0)
        self.out.truncate()
        br.main(["status", "--json"], self.env)
        doc = json.loads(self.out.getvalue())
        self.assertFalse(doc["armed"])
        self.assertEqual(doc["state"]["disarmed"]["code"], "MCE_THIS_BOOT")
