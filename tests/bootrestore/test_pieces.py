"""The pure parts of the boot restore (kernel-log classifier, CPU identity, verdict, state file) and its entry point (root, the installed-tree rule), plus a lint
of every shipped unit file: parsed, no path into a home directory, no sudo, only the installed launchers run."""
from __future__ import annotations

import io
import os
import stat
import unittest
from pathlib import Path
from types import SimpleNamespace

from linux_xtu import bootrestore as br

from ._support import BENIGN_KLOG, BootCase, CPUINFO

REPO = Path(__file__).resolve().parents[2]
PACKAGING = REPO / "packaging"


def sections(path: Path) -> dict[str, dict[str, list[str]]]:
    import importlib.util

    spec = importlib.util.spec_from_file_location("linux-xtu_selfcheck_units", PACKAGING / "selfcheck.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.unit_sections(path.read_bytes())


class KernelLogClassifier(unittest.TestCase):
    def test_normal_boot_lines_are_not_hardware_errors(self) -> None:
        self.assertEqual(br.hardware_errors(BENIGN_KLOG + ["mce: CPU0: Core temperature above threshold, cpu clock throttled (total events = 1)",
                                                          "Machine check injector initialized", "msr: Write to unrecognized MSR 0x150 by python3"]), [])

    def test_machine_check_and_hardware_error_lines_are(self) -> None:
        for line in ("mce: [Hardware Error]: Machine check events logged", "mce: [Hardware Error]: CPU 3: Machine Check: 0 Bank 5: be00000000800400",
                     "Kernel panic - not syncing: Fatal machine check on current CPU", "{1}[Hardware Error]: Hardware error from APEI Generic Hardware Error Source: 0",
                     "CMCI storm detected: switching to poll mode", "EDAC MC0: 1 CE memory read error on CPU_SrcID#0_Ha#0_Chan#0_DIMM#0",
                     "thermal thermal_zone5: critical temperature reached, shutting down"):
            with self.subTest(line=line):
                self.assertEqual(br.hardware_errors([line]), [line])


class Pieces(unittest.TestCase):
    def test_cpu_identity(self) -> None:
        got = br.cpu_identity(CPUINFO.format(brand="Intel(R)  Core(TM) Ultra 9 285K", micro="0x00000114"))
        self.assertEqual(got, {"vendor": "GenuineIntel", "family": 6, "model": 198, "stepping": 2, "microcode": "0x114", "brand": "Intel(R) Core(TM) Ultra 9 285K"})
        self.assertIsNone(br.cpu_identity("processor : 0\nvendor_id : GenuineIntel\n"))

    def test_verdict(self) -> None:
        self.assertEqual(br.verdict([{"cpu": 0, "match": True, "diffs": []}])[0], "OK")
        word, lines = br.verdict([{"cpu": 0, "match": True, "diffs": []}, {"cpu": 8, "match": True, "equivalent": True, "equivalents": [{"residual": True}]}])
        self.assertEqual(word, "EQUIVALENT")
        self.assertIn("residual OC point", lines[1])
        word, lines = br.verdict([{"cpu": 0, "match": False, "diffs": [{"point": 6, "expected": "0xfc600037", "actual": "0xfc400037"}]},
                                  {"cpu": "ring", "unit": "ring", "match": False, "diffs": []}])
        self.assertEqual(word, "BAD")
        self.assertIn("point 6: 0xfc400037 (accepted 0xfc600037)", lines[0])
        self.assertTrue(lines[1].startswith("BAD         ring"))
        self.assertEqual(br.verdict(None, "No accepted state yet")[0], "BAD")
        self.assertEqual(br.verdict([])[0], "BAD")

    def test_the_config_defaults_are_the_shipped_file(self) -> None:
        import tomllib

        shipped = tomllib.loads((PACKAGING / "restore.toml").read_text())
        self.assertEqual(shipped, br.CONFIG_DEFAULTS)
        self.assertEqual(br.Config(), br.Config(**{k: (float(v) if k.endswith("_s") else v) for k, v in shipped.items()}))


class StateFile(BootCase):
    def test_the_state_file_is_written_atomically_0644_and_leaves_no_staging_file(self) -> None:
        br.save_state(self.env, {**br._blank_state(), "armed": True})
        self.assertEqual(stat.S_IMODE(self.paths.state.stat().st_mode), 0o644)
        self.assertEqual([p.name for p in self.paths.state.parent.iterdir() if p.name.startswith(".")], [])
        self.assertTrue(br.load_state(self.env)["armed"])

    def test_a_state_of_another_shape_is_unreadable_not_guessed(self) -> None:
        for text in ('{"schema": 2, "armed": true}', '{"schema": 1, "armed": "yes"}', '{"schema": 1, "armed": true, "pending": 5}', "[]"):
            with self.subTest(text=text):
                self.paths.state.write_text(text)
                self.assertRaises(br.StateError, br.load_state, self.env)

    def test_a_symlinked_state_file_is_refused(self) -> None:
        target = self.tmp / "elsewhere.json"
        target.write_text('{"schema": 1, "armed": true}')
        self.paths.state.symlink_to(target)
        self.assertRaises(br.StateError, br.load_state, self.env)


class EntryPoint(BootCase):
    def test_run_arm_and_disarm_need_root_status_does_not(self) -> None:
        self.env.require_root = True
        self.env.euid = lambda: 1000
        for cmd in ("run", "arm", "disarm"):
            self.assertEqual(br.main([cmd], self.env), br.EXIT_ERROR, cmd)
        self.assertIn("must run as root", self.out.getvalue())
        self.assertEqual(br.main(["status"], self.env), br.EXIT_OK)
        self.assertEqual(self.sim.requests, [])

    def test_as_root_the_code_must_be_an_installed_root_owned_tree(self) -> None:
        self.env.require_root = True
        self.env.euid = lambda: 0
        self.env.lstat = lambda p: SimpleNamespace(st_uid=1000, st_mode=stat.S_IFDIR | 0o755, st_nlink=1)  # e.g. a checkout: owned by the user
        self.assertEqual(br.main(["run"], self.env), br.EXIT_ERROR)
        self.assertIn("SPEC 4.4", self.out.getvalue())
        self.assertEqual((self.sim.requests, self.helpers_made), ([], 0))

    def test_usage_errors(self) -> None:
        self.assertEqual(br.main(["bogus"], self.env), br.EXIT_ERROR)
        self.assertEqual(br.main([], self.env), br.EXIT_ERROR)

    def test_journal_lines_carry_syslog_priorities_under_systemd(self) -> None:
        out = io.StringIO()
        env = br.Env(out=out, syslog_prefix=True)
        env.say(3, "a\nb")
        self.assertEqual(out.getvalue(), "<3>a\n<3>b\n")

    def test_the_launcher_runs_only_the_installed_tree(self) -> None:
        text = (PACKAGING / "linux-xtu-restore").read_text()
        self.assertEqual(text.splitlines()[0], "#!/usr/bin/python3 -I")
        self.assertIn('sys.path.insert(0, "/usr/lib/linux-xtu")', text)
        self.assertIn("from linux_xtu.bootrestore import main", text)
        self.assertTrue(os.access(PACKAGING / "linux-xtu-restore", os.X_OK))


class UnitLint(unittest.TestCase):
    UNITS = sorted(p for p in PACKAGING.iterdir() if p.suffix in (".service", ".socket", ".timer"))

    def test_every_unit_parses_and_names_no_home_path_and_no_sudo(self) -> None:
        self.assertEqual([p.name for p in self.UNITS], ["linux-xtu-helper.service", "linux-xtu-helper.socket", "linux-xtu-restore.service", "linux-xtu-restore.timer"])
        for unit in self.UNITS:
            with self.subTest(unit=unit.name):
                sections(unit)  # ValueError on anything that is not [Section] / key=value / comment
                text = unit.read_text()
                for needle in ("/home/", "~/", "$HOME", "/root/", "captures/", "tools/", "sudo"):
                    self.assertNotIn(needle, text, f"{unit.name}: {needle}")

    def test_only_the_installed_launchers_are_executed(self) -> None:
        for unit in self.UNITS:
            svc = sections(unit).get("Service")
            if svc is None:
                continue
            for key in ("ExecStart", "ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost", "ExecReload"):
                for value in svc.get(key, []):
                    self.assertRegex(value, r"^/usr/bin/python3 -I /usr/lib/linux-xtu/linux-xtu-(helper|restore) ", f"{unit.name} {key}")

    def test_the_restore_units(self) -> None:
        svc_all = sections(PACKAGING / "linux-xtu-restore.service")
        svc = svc_all["Service"]
        self.assertNotIn("Install", svc_all, "only the timer starts the restore")
        self.assertEqual(svc["ExecStart"], ["/usr/bin/python3 -I /usr/lib/linux-xtu/linux-xtu-restore run"])
        self.assertEqual(svc["Type"], ["exec"], "it stays until the clean marker")
        self.assertEqual(svc["ReadWritePaths"], ["/var/lib/linux-xtu /run/linux-xtu", "-/run/arltuner"])  # D-054 review F3: the old installed lock file too
        for key in ("PrivateDevices", "ProtectClock", "ProtectKernelTunables", "DeviceAllow", "User", "Environment"):
            self.assertNotIn(key, svc, key)
        for key in ("ProtectSystem", "ProtectHome", "PrivateTmp", "NoNewPrivileges", "ProtectKernelModules", "ProtectKernelLogs", "RestrictNamespaces",
                    "SystemCallArchitectures", "RestrictAddressFamilies", "UMask"):
            self.assertIn(key, svc, key)
        timer = sections(PACKAGING / "linux-xtu-restore.timer")
        self.assertEqual(timer["Timer"]["Unit"], ["linux-xtu-restore.service"])
        self.assertEqual(timer["Timer"]["OnBootSec"], ["30s"])
        self.assertEqual(timer["Install"]["WantedBy"], ["timers.target"])
        for name in ("linux-xtu-restore.service", "linux-xtu-restore.timer"):
            self.assertTrue((PACKAGING / name).read_text().startswith("# linux-xtu: packaged unit"), name)
