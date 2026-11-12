"""G-106 path rules: the CLI's installed-detection (D-030: absent => per-user, trusted => installed paths, present-but-untrusted => named refusal,
never a fallback), the platform-file path order, the GUI launcher defaults, and the packaging files."""
from __future__ import annotations

import importlib.util
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from linux_xtu import cli
from linux_xtu.helper import config
from linux_xtu.helper import main as helper_main
from linux_xtu.platform.schema import PLATFORM_FILE, default_platform_path
from tests import test_cli

from ._support import DIR, FILE, REPO, SYMLINK, fake_lstat, no_install_lstat

USER_HOME = {"HOME": "/home/x"}
USER_AUDIT = Path("/home/x/.local/state/linux-xtu/audit.jsonl")
USER_LOCK = Path("/run/lock/linux-xtu-mailbox.lock")
NO_RUN_DIR = {"/": (0, DIR), "/etc": (0, DIR), "/etc/linux-xtu": (0, DIR), "/etc/linux-xtu/policy.toml": (0, FILE)}  # installed, but tmpfiles.d never made /run/linux-xtu
ROOTED = NO_RUN_DIR | {"/run": (0, DIR), "/run/linux-xtu": (0, DIR)}


def absent(path: str):
    raise FileNotFoundError(path)


class Constants(unittest.TestCase):
    def test_installed_constants(self) -> None:
        self.assertEqual(config.INSTALLED_LOCK, Path("/run/linux-xtu/mailbox.lock"))
        self.assertEqual(config.INSTALLED_LOCK_DIR, Path("/run/linux-xtu"))
        self.assertEqual(config.INSTALLED_AUDIT, Path("/var/lib/linux-xtu/audit.jsonl"))
        self.assertEqual(config.INSTALLED_POLICY, Path("/etc/linux-xtu/policy.toml"))
        self.assertEqual(config.INSTALLED_HELPER, Path("/usr/lib/linux-xtu/linux-xtu-helper"))
        self.assertEqual(config.INSTALLED_PLATFORMS_DIR, Path("/usr/lib/linux-xtu/platforms"))

    def test_the_root_config_carries_the_accepted_state_directory(self) -> None:
        import argparse

        ns = argparse.Namespace(sim=False, device=True, policy="/tmp/evil", audit="/tmp/evil", lock="/tmp/evil", allow_taint_bit=[])
        cfg = helper_main.build_config(ns, log=lambda t: None, root=True, lstat_fn=no_install_lstat)
        self.assertEqual(cfg.accepted_dir, Path("/etc/linux-xtu/accepted"))
        self.assertEqual(cfg.accepted_dir, config.INSTALLED_ACCEPTED_DIR)
        sim = argparse.Namespace(sim=True, device=False, policy=None, audit="/tmp/a", lock="/tmp/l", allow_taint_bit=[])
        self.assertIsNone(helper_main.build_config(sim, log=lambda t: None).accepted_dir)
        self.assertIsNone(config.HelperConfig.__dataclass_fields__["accepted_dir"].default)

    def test_the_helper_launcher_module_agrees_with_config(self) -> None:
        for name in ("INSTALLED_POLICY", "INSTALLED_AUDIT", "INSTALLED_HELPER_TOML", "INSTALLED_ACCEPTED_DIR"):
            self.assertEqual(getattr(helper_main, name), getattr(config, name), name)


class CliInstalledRule(unittest.TestCase):
    def test_absent_policy_keeps_the_per_user_paths(self) -> None:
        self.assertFalse(cli.installed_state(absent))
        self.assertEqual(cli.default_audit_path(USER_HOME, lstat_fn=absent), USER_AUDIT)
        self.assertEqual(cli.default_lock_path(isdir=lambda p: p == "/run/lock", lstat_fn=absent), USER_LOCK)

    def test_a_missing_parent_directory_is_also_absent(self) -> None:
        def not_a_dir(path: str):
            raise NotADirectoryError(path)

        self.assertFalse(cli.installed_state(not_a_dir))
        self.assertFalse(cli.installed_state(fake_lstat({"/": (0, DIR)})))  # /etc does not exist at all

    def test_a_trusted_policy_switches_both_paths(self) -> None:
        lstat = fake_lstat(ROOTED)
        self.assertTrue(cli.installed_state(lstat))
        self.assertEqual(cli.default_audit_path(USER_HOME, lstat_fn=lstat), config.INSTALLED_AUDIT)
        self.assertEqual(cli.default_lock_path(isdir=lambda p: True, lstat_fn=lstat), config.INSTALLED_LOCK)

    def test_windows_never_uses_the_installed_paths(self) -> None:
        lstat = fake_lstat(ROOTED)
        env = {"LOCALAPPDATA": r"C:\L", "HOME": "/home/x"}
        self.assertEqual(cli.default_audit_path(env, windows=True, lstat_fn=lstat), Path(r"C:\L") / "linux-xtu" / "audit.jsonl")
        self.assertEqual(cli.default_audit_path({"HOME": "/home/x"}, windows=True, lstat_fn=lstat), USER_AUDIT)
        self.assertNotEqual(cli.default_lock_path(isdir=lambda p: False, lstat_fn=lstat, windows=True), config.INSTALLED_LOCK)

    def test_present_but_untrusted_is_a_named_refusal_for_both_paths(self) -> None:
        cases = {
            "owner": ROOTED | {"/etc/linux-xtu/policy.toml": (1000, FILE)},
            "group-writable file": ROOTED | {"/etc/linux-xtu/policy.toml": (0, stat.S_IFREG | 0o664)},
            "world-writable file": ROOTED | {"/etc/linux-xtu/policy.toml": (0, stat.S_IFREG | 0o666)},
            "symlink": ROOTED | {"/etc/linux-xtu/policy.toml": (0, SYMLINK)},
            "directory": ROOTED | {"/etc/linux-xtu/policy.toml": (0, DIR)},
            "user-owned directory": ROOTED | {"/etc/linux-xtu": (1000, DIR)},
            "world-writable directory": ROOTED | {"/etc/linux-xtu": (0, stat.S_IFDIR | 0o777)},
            "world-writable /etc": ROOTED | {"/etc": (0, stat.S_IFDIR | 0o777)},
        }
        for name, tree in cases.items():
            lstat = fake_lstat(tree)
            with self.subTest(name):
                with self.assertRaises(cli.InstalledStateRefused) as ctx:
                    cli.default_audit_path(USER_HOME, lstat_fn=lstat)
                self.assertIn("/etc/linux-xtu/policy.toml", str(ctx.exception))
                self.assertIn("not trusted", str(ctx.exception))
                self.assertIn("per-user", str(ctx.exception))
                with self.assertRaises(cli.InstalledStateRefused):
                    cli.default_lock_path(lstat_fn=lstat)

    def test_an_unreadable_policy_is_refused_not_ignored(self) -> None:
        def denied(path: str):
            raise PermissionError(13, "Permission denied", path)

        with self.assertRaises(cli.InstalledStateRefused):
            cli.installed_state(denied)


class CliEndToEnd(test_cli.CliCase):
    """The rule through ``cli.main`` (hardware runs only): untrusted => exit 2 before any port is built; explicit --audit/--lock bypass the
    defaults; ``--sim`` never applies D-030 (per-user defaults even on an installed machine)."""

    def setUp(self) -> None:
        super().setUp()
        patcher = mock.patch("linux_xtu.cli.DevCpuMsrPort")
        self.dev = patcher.start()
        self.addCleanup(patcher.stop)

    def args(self, *extra: object, device: bool = True) -> list[object]:
        return ["read-vf", "--device" if device else "--sim", "--cpu", 4, *extra]

    def run_hw(self, *argv: object, **kw):
        return self.run_cli(*argv, health_gate=lambda token: (True, "ok"), env={**test_cli.ENV_OK, "HOME": "/home/x"}, **kw)

    def test_untrusted_install_refuses_before_any_request(self) -> None:
        lstat = fake_lstat(ROOTED | {"/etc/linux-xtu/policy.toml": (1000, FILE)})
        code, out, err = self.run_hw(*self.args(), stdin=self.confirmed(), lstat_fn=lstat)
        self.assertEqual(code, 2, err)
        self.assertIn("refused:", err)
        self.assertIn("/etc/linux-xtu/policy.toml", err)
        self.assertIn("not trusted", err)
        self.dev.assert_not_called()
        self.nothing_sent()

    def test_untrusted_install_also_refuses_when_only_the_lock_is_defaulted(self) -> None:
        lstat = fake_lstat(ROOTED | {"/etc/linux-xtu/policy.toml": (0, stat.S_IFREG | 0o666)})
        code, _, err = self.run_hw(*self.args("--audit", self.audit), stdin=self.confirmed(), lstat_fn=lstat)
        self.assertEqual(code, 2, err)
        self.assertIn("not trusted", err)
        self.nothing_sent()

    def test_explicit_audit_and_lock_do_not_consult_the_installed_state(self) -> None:
        lstat = fake_lstat(ROOTED | {"/etc/linux-xtu/policy.toml": (1000, FILE)})
        code, out, err = self.run_hw(*self.args("--audit", self.audit, "--lock", self.lock), stdin=self.confirmed(), lstat_fn=lstat, device_port_factory=lambda: self.sim)
        self.assertEqual((code, err), (0, ""), out)

    def test_a_missing_installed_lock_directory_is_a_named_refusal_and_never_the_per_user_lock(self) -> None:
        for argv in (["read-vf", "--cpu", 4, "--audit", self.audit], ["read", "--cpu", 4, "--cmd", "0x10", "--audit", self.audit]):
            with self.subTest(argv=argv), mock.patch("linux_xtu.helper.session.WriteGuard") as guard:
                code, out, err = self.run_hw(*argv, "--device", stdin=self.confirmed(), lstat_fn=fake_lstat(NO_RUN_DIR), device_port_factory=lambda: self.sim)
                self.assertEqual(code, 2, err)
                self.assertIn("refused:", err)
                self.assertIn("/run/linux-xtu", err)
                self.assertIn("sudo systemd-tmpfiles --create /usr/lib/tmpfiles.d/linux-xtu.conf", err)
                self.assertNotIn("Traceback", err)
                self.assertNotIn("linux-xtu-mailbox", err)
                guard.assert_not_called()
                self.nothing_sent()

    def test_with_the_lock_directory_present_the_guard_gets_the_installed_lock(self) -> None:
        with mock.patch("linux_xtu.helper.session.WriteGuard", side_effect=RuntimeError("stop")) as guard:
            self.run_hw(*self.args("--audit", self.audit), stdin=self.confirmed(), lstat_fn=fake_lstat(ROOTED), device_port_factory=lambda: self.sim)
        self.assertEqual(guard.call_args.kwargs["lock_path"], config.INSTALLED_LOCK)

    def test_an_explicit_lock_does_not_need_the_installed_lock_directory(self) -> None:
        code, out, err = self.run_hw(*self.args("--audit", self.audit, "--lock", self.lock), stdin=self.confirmed(), lstat_fn=fake_lstat(NO_RUN_DIR), device_port_factory=lambda: self.sim)
        self.assertEqual((code, err), (0, ""), out)

    def test_sim_never_needs_the_installed_lock_directory(self) -> None:
        with mock.patch("linux_xtu.helper.session.WriteGuard", side_effect=RuntimeError("stop")) as guard:
            self.run_hw(*self.args("--audit", self.audit, device=False), stdin=self.confirmed(), lstat_fn=fake_lstat(NO_RUN_DIR))
        self.assertEqual(guard.call_args.kwargs["lock_path"], cli.sim_lock_path({}))  # R-B8 (H4): the simulator's own lock, never the device one

    def capture_audit_path(self, argv, **kw) -> list[Path]:
        opened: list[Path] = []

        def fake_audit(path):
            opened.append(Path(path))
            raise OSError("stop here: this test must not create /var/lib/linux-xtu")

        with mock.patch.object(cli, "AuditLog", side_effect=fake_audit), mock.patch.object(Path, "mkdir"):
            self.run_hw(*argv, stdin=self.confirmed(), **kw)
        return opened

    def test_a_trusted_install_routes_the_defaults_to_the_installed_paths(self) -> None:
        self.assertEqual(self.capture_audit_path(self.args(), lstat_fn=fake_lstat(ROOTED)), [config.INSTALLED_AUDIT])

    def test_absent_install_uses_the_per_user_default_audit_path(self) -> None:
        self.assertEqual(self.capture_audit_path(self.args(), lstat_fn=absent), [USER_AUDIT])

    def test_sim_never_applies_the_installed_paths_even_when_installed(self) -> None:
        self.assertEqual(self.capture_audit_path(self.args(device=False), lstat_fn=fake_lstat(ROOTED)), [USER_AUDIT])

    def test_sim_ignores_even_an_untrusted_install(self) -> None:
        bad = fake_lstat(ROOTED | {"/etc/linux-xtu/policy.toml": (1000, FILE)})
        self.assertEqual(self.capture_audit_path(self.args(device=False), lstat_fn=bad), [USER_AUDIT])

    def test_sim_lock_default_is_the_per_user_lock(self) -> None:
        with mock.patch("linux_xtu.helper.session.WriteGuard", side_effect=RuntimeError("stop")) as guard:
            self.run_hw(*self.args("--audit", self.audit, device=False), stdin=self.confirmed(), lstat_fn=fake_lstat(ROOTED))
        self.assertNotEqual(guard.call_args.kwargs["lock_path"], config.INSTALLED_LOCK)
        self.assertNotEqual(guard.call_args.kwargs["lock_path"], USER_LOCK)  # R-B8 (H4): not the device runs' lock either
        self.assertEqual(guard.call_args.kwargs["lock_path"], cli.sim_lock_path({}))

    def test_r_b8_the_sim_lock_is_per_user_and_apart_from_the_device_lock(self) -> None:
        # R-B8 (review of R-B3, H4): a crashed user simulator apply must never leave a lock on the path root's dev --device runs use (root never takes it over)
        runtime = "/run/user/1000"
        self.assertEqual(cli.sim_lock_path({"XDG_RUNTIME_DIR": runtime}, isdir=lambda p: p == runtime), Path(runtime) / "linux-xtu-sim-mailbox.lock")
        for env in ({}, {"XDG_RUNTIME_DIR": "relative"}, {"XDG_RUNTIME_DIR": "/nonexistent-runtime"}):
            with self.subTest(env=env):
                fallback = cli.sim_lock_path(env, isdir=lambda p: False, uid_fn=lambda: 1234)
                self.assertEqual(fallback, Path(tempfile.gettempdir()) / "linux-xtu-sim-mailbox-1234.lock")
                self.assertNotEqual(fallback.name, USER_LOCK.name)

    def test_r_b8_the_sim_cli_uses_xdg_runtime_dir(self) -> None:
        runtime = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: runtime.rmdir() if runtime.exists() else None)
        with mock.patch("linux_xtu.helper.session.WriteGuard", side_effect=RuntimeError("stop")) as guard:
            self.run_cli(*self.args("--audit", self.audit, device=False), stdin=self.confirmed(), lstat_fn=absent, health_gate=lambda token: (True, "ok"),
                         env={**test_cli.ENV_OK, "HOME": "/home/x", "XDG_RUNTIME_DIR": str(runtime)})
        self.assertEqual(guard.call_args.kwargs["lock_path"], runtime / "linux-xtu-sim-mailbox.lock")

    def test_the_guard_gets_the_installed_lock_when_installed_on_hardware(self) -> None:
        with mock.patch("linux_xtu.helper.session.WriteGuard", side_effect=RuntimeError("stop")) as guard:
            code, _, err = self.run_hw(*self.args("--audit", self.audit), stdin=self.confirmed(), lstat_fn=fake_lstat(ROOTED), device_port_factory=lambda: self.sim)
        self.assertEqual(guard.call_args.kwargs["lock_path"], config.INSTALLED_LOCK)
        self.assertEqual(code, 3)

    def test_default_functions_accept_consider_install_false(self) -> None:
        lstat = fake_lstat(ROOTED)
        self.assertEqual(cli.default_audit_path(USER_HOME, lstat_fn=lstat, consider_install=False), USER_AUDIT)
        self.assertEqual(cli.default_lock_path(isdir=lambda p: True, lstat_fn=lstat, consider_install=False), USER_LOCK)


class HelperLauncherPaths(unittest.TestCase):
    """helper/main.py: root + present-but-untrusted policy.toml => named REFUSED, exit 77, no traceback; --sim keeps the per-user defaults."""

    def run_main(self, argv, *, euid, lstat_fn):
        import io

        out, err = io.BytesIO(), io.StringIO()
        with mock.patch.object(helper_main, "_startup_refusal", return_value=None):
            code = helper_main.main(argv, stdin=io.BytesIO(), stdout=out, stderr=err, euid_fn=lambda: euid, lstat_fn=lstat_fn)
        return code, out.getvalue().decode(), err.getvalue()

    def test_root_with_an_untrusted_policy_is_refused_77_by_name(self) -> None:
        import json

        lstat = fake_lstat(ROOTED | {"/etc/linux-xtu/policy.toml": (1000, FILE)})
        code, out, err = self.run_main(["--device", "--socket"], euid=0, lstat_fn=lstat)  # R-B3 F14: the only root argv
        self.assertEqual(code, 77)
        msg = json.loads(out.splitlines()[0])
        self.assertEqual(msg["error"]["detail"]["check"], "TRUST_PATH")
        self.assertIn("/etc/linux-xtu/policy.toml", msg["error"]["message"])
        self.assertIn("refused to start", err)
        self.assertNotIn("Traceback", err)

    def test_root_lock_is_the_installed_lock_when_installed(self) -> None:
        import argparse

        ns = argparse.Namespace(sim=False, device=True, policy=None, audit=None, lock=None, allow_taint_bit=[])
        cfg = helper_main.build_config(ns, log=lambda t: None, root=True, lstat_fn=fake_lstat(ROOTED))
        self.assertEqual(cfg.lock_path, Path("/run/linux-xtu/mailbox.lock"))

    def test_sim_defaults_stay_per_user_on_an_installed_machine(self) -> None:
        import argparse

        ns = argparse.Namespace(sim=True, device=False, policy=None, audit=None, lock=None, allow_taint_bit=[])
        cfg = helper_main.build_config(ns, log=lambda t: None, lstat_fn=fake_lstat(ROOTED))
        self.assertNotEqual(cfg.lock_path, config.INSTALLED_LOCK)
        self.assertNotEqual(cfg.lock_path, USER_LOCK)  # R-B8 (H4): the simulator's own lock
        self.assertEqual(cfg.lock_path, cli.sim_lock_path())
        self.assertNotEqual(cfg.audit_path, config.INSTALLED_AUDIT)
        self.assertEqual(cfg.audit_path.name, "audit.jsonl")
        self.assertIn("linux-xtu", str(cfg.audit_path))

    def test_sim_with_an_untrusted_install_is_not_refused(self) -> None:
        import argparse

        ns = argparse.Namespace(sim=True, device=False, policy=None, audit=None, lock=None, allow_taint_bit=[])
        helper_main.build_config(ns, log=lambda t: None, lstat_fn=fake_lstat(ROOTED | {"/etc/linux-xtu/policy.toml": (1000, FILE)}))


class RestoreScripts(unittest.TestCase):
    def test_restore_scripts_name_no_audit_or_lock_so_the_cli_rule_decides(self) -> None:
        for rel in ("tools/lnx/restore_tuning.sh", "tools/lnx/reapply_current.sh"):
            text = (REPO / rel).read_text()
            for flag in ("--audit", "--lock"):
                self.assertNotIn(flag, text, f"{rel} must not pass {flag}: D-030's rule picks the lock/audit paths")

    def test_root_runs_the_installed_cli_only_so_d030_decides_from_the_installed_policy(self) -> None:
        """R-B6 (F3): the old ``sudo env ... HOME=$HOME python3 -I tools/linux-xtu.py`` (checkout code as root) is gone; root runs /usr/lib/linux-xtu/linux-xtu-cli,
        which exists only on an installed machine, where D-030 picks /var/lib/linux-xtu/audit.jsonl and /run/linux-xtu/mailbox.lock."""
        for rel in ("tools/lnx/restore_tuning.sh", "tools/lnx/reapply_current.sh"):
            for line in (REPO / rel).read_text().splitlines():
                if line.lstrip().startswith("#"):
                    continue
                self.assertNotIn("linux-xtu.py", line, rel)
                if "sudo env" in line:
                    self.assertIn('"$cli"', line, rel)


class PlatformPathOrder(unittest.TestCase):
    def make(self, root: Path, *, installed: bool, with_file: bool = True) -> Path:
        here = root / ("linux_xtu" if installed else "src/linux_xtu") / "platform" / "schema.py"
        here.parent.mkdir(parents=True)
        here.touch()
        if with_file:
            (root / "platforms").mkdir()
            (root / "platforms" / PLATFORM_FILE).touch()
        return here

    def test_installed_tree_uses_only_its_own_platforms_directory(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "usr" / "lib" / "linux-xtu"
            here = self.make(root, installed=True)
            self.assertEqual(default_platform_path(here), root / "platforms" / PLATFORM_FILE)

    def test_installed_tree_never_falls_back_to_a_checkout_or_elsewhere(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "usr" / "lib" / "linux-xtu"
            here = self.make(root, installed=True, with_file=False)
            self.assertEqual(default_platform_path(here), root / "platforms" / PLATFORM_FILE)  # missing: the error message names it

    def test_a_checkout_uses_its_own_platforms_directory(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d) / "repo"
            here = self.make(repo, installed=False)
            self.assertEqual(default_platform_path(here), repo / "platforms" / PLATFORM_FILE)

    def test_the_real_checkout_resolves_to_this_repo(self) -> None:
        self.assertEqual(default_platform_path(), REPO / "platforms" / PLATFORM_FILE)

    def test_the_installed_fallback_constant_matches_config(self) -> None:
        self.assertEqual(Path("/usr/lib/linux-xtu/platforms"), config.INSTALLED_PLATFORMS_DIR)


class ClientDefaults(unittest.TestCase):
    def test_the_client_socket_constant_matches_config(self) -> None:
        from linux_xtu import client

        self.assertEqual(client.HELPER_SOCKET, str(config.INSTALLED_SOCKET))

    def test_the_checkout_has_no_web_gui_any_more(self) -> None:
        for rel in ("web", "src/linux_xtu/web", "tools/linux-xtu-gui.py"):
            self.assertFalse((REPO / rel).exists(), rel)
        self.assertFalse(hasattr(config, "INSTALLED_WEB_DIR"))


class PackagingFiles(unittest.TestCase):
    def test_tmpfiles_creates_the_run_dir_0755_root(self) -> None:
        lines = [l for l in (REPO / "packaging" / "linux-xtu.tmpfiles.conf").read_text().splitlines() if l and not l.startswith("#")]
        self.assertEqual([l.split() for l in lines], [["d", "/run/linux-xtu", "0755", "root", "root", "-"]])

    def test_the_launcher_is_isolated_python_and_takes_no_argv_itself(self) -> None:
        text = (REPO / "packaging" / "linux-xtu-helper").read_text()
        self.assertEqual(text.splitlines()[0], "#!/usr/bin/python3 -I")
        code = "\n".join(l for l in text.splitlines() if not l.startswith("#"))
        self.assertNotIn("argv", code)  # nothing is parsed or forwarded here: the helper itself refuses any argv as root
        self.assertIn(str(config.INSTALLED_CODE_DIR), text)

    def test_the_scripts_are_lf_and_executable_in_the_repo(self) -> None:
        for rel in ("install.sh", "uninstall.sh", "packaging/linux-xtu-helper", "packaging/selfcheck.py", "packaging/linux-xtu.tmpfiles.conf", "packaging/linux-xtu-restore",
                    "packaging/linux-xtu-cli", "packaging/linux-xtu-restore.service", "packaging/linux-xtu-restore.timer", "packaging/restore.toml",
                    "packaging/linux-xtu.desktop", "packaging/linux-xtu-modules.conf", "tools/lnx/restore_tuning.sh", "tools/lnx/restore_accepted.py"):
            data = (REPO / rel).read_bytes()
            self.assertNotIn(b"\r", data, rel)
        for rel in ("install.sh", "uninstall.sh", "packaging/linux-xtu-helper", "packaging/linux-xtu-restore", "packaging/linux-xtu-cli"):
            self.assertTrue((REPO / rel).stat().st_mode & stat.S_IXUSR, rel)

    def test_install_scripts_never_use_dangerous_constructs(self) -> None:
        for rel in ("install.sh", "uninstall.sh"):
            text = (REPO / rel).read_text()
            self.assertIn("set -euo pipefail", text)
            self.assertNotIn("sudo ", text.replace("sudo bash", ""))
            self.assertNotIn("curl", text)
            self.assertNotIn("wget", text)
            self.assertNotIn("pip ", text)


if __name__ == "__main__":
    unittest.main()
