"""The post-install self-check (``packaging/selfcheck.py``, installed as ``/usr/lib/linux-xtu/linux-xtu-selfcheck``), driven with fake stat results:
one good tree passes every item; each kind of damage fails the item that names it."""
from __future__ import annotations

import importlib.util
import stat
import unittest
from pathlib import Path

from ._support import DIR, FILE, REPO, SYMLINK, fake_listdir, fake_lstat

spec = importlib.util.spec_from_file_location("linux-xtu_selfcheck", REPO / "packaging" / "selfcheck.py")
selfcheck = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selfcheck)

EXE = stat.S_IFREG | 0o755
PRIVATE = stat.S_IFREG | 0o600
SOCKET_UNIT = (REPO / "packaging" / "linux-xtu-helper.socket").read_bytes()
SERVICE_UNIT = (REPO / "packaging" / "linux-xtu-helper.service").read_bytes()
HELPER_TOML = b'allow_taint_bits = [2]\n[access]\nusers = ["alice"]\ngroup = "linux-xtu"\n'
LAUNCHER = (REPO / "packaging" / "linux-xtu-helper").read_bytes()
RESTORE_LAUNCHER = (REPO / "packaging" / "linux-xtu-restore").read_bytes()
CLI_LAUNCHER = (REPO / "packaging" / "linux-xtu-cli").read_bytes()
RESTORE_SERVICE = (REPO / "packaging" / "linux-xtu-restore.service").read_bytes()
RESTORE_TIMER = (REPO / "packaging" / "linux-xtu-restore.timer").read_bytes()
GROUPS = {"linux-xtu"}  # the groups that "exist" in these tests (the real machine's groups are never consulted)
CODE_TREE = "code tree /usr/lib/linux-xtu (top level, linux-xtu/, platforms/, every dir and file, __pycache__ included)"

GOOD: dict[str, tuple[int, int]] = {
    "/": (0, DIR), "/usr": (0, DIR), "/usr/lib": (0, DIR), "/usr/share": (0, DIR), "/usr/share/polkit-1": (0, DIR), "/usr/share/polkit-1/actions": (0, DIR),
    "/usr/lib/tmpfiles.d": (0, DIR), "/usr/lib/tmpfiles.d/linux-xtu.conf": (0, FILE),
    "/etc/systemd": (0, DIR), "/etc/systemd/system": (0, DIR), "/etc/systemd/system/linux-xtu-helper.socket": (0, FILE),
    "/etc/systemd/system/linux-xtu-helper.service": (0, FILE),
    "/usr/lib/linux-xtu": (0, DIR), "/usr/lib/linux-xtu/linux-xtu-helper": (0, EXE), "/usr/lib/linux-xtu/linux-xtu-selfcheck": (0, EXE),
    "/usr/lib/linux-xtu/linux-xtu-restore": (0, EXE), "/usr/lib/linux-xtu/linux-xtu-cli": (0, EXE),
    "/usr/lib/linux-xtu/linux_xtu": (0, DIR), "/usr/lib/linux-xtu/linux_xtu/__init__.py": (0, FILE),
    "/usr/lib/linux-xtu/linux_xtu/__pycache__": (0, DIR), "/usr/lib/linux-xtu/linux_xtu/__pycache__/__init__.cpython-314.pyc": (0, FILE),
    "/usr/lib/linux-xtu/platforms": (0, DIR), "/usr/lib/linux-xtu/platforms/arl-s.toml": (0, FILE),
    "/etc": (0, DIR), "/etc/linux-xtu": (0, DIR), "/etc/linux-xtu/policy.toml": (0, FILE), "/etc/linux-xtu/helper.toml": (0, FILE),
    "/etc/linux-xtu/accepted": (0, DIR), "/etc/linux-xtu/accepted/CURRENT": (0, FILE),
    "/var": (0, DIR), "/var/lib": (0, DIR), "/var/lib/linux-xtu": (0, DIR), "/var/lib/linux-xtu/audit.jsonl": (0, PRIVATE),
    "/run": (0, DIR), "/run/linux-xtu": (0, DIR),
}


def run(tree, launcher: bytes = LAUNCHER, files: dict[str, bytes] | None = None, groups: set[str] | None = None) -> dict[str, str | None]:
    contents = {
        str(selfcheck.HELPER): launcher,
        str(selfcheck.RESTORE): RESTORE_LAUNCHER,
        str(selfcheck.CLI): CLI_LAUNCHER,
        "/etc/systemd/system/linux-xtu-helper.socket": SOCKET_UNIT,
        "/etc/systemd/system/linux-xtu-helper.service": SERVICE_UNIT,
        "/etc/systemd/system/linux-xtu-restore.service": RESTORE_SERVICE,
        "/etc/systemd/system/linux-xtu-restore.timer": RESTORE_TIMER,
        "/etc/linux-xtu/helper.toml": HELPER_TOML,
    } | (files or {})

    def read(p) -> bytes:
        return contents[str(p)]

    def grnam(name: str) -> object:
        if name not in (GROUPS if groups is None else groups):
            raise KeyError(name)
        return object()

    results = selfcheck.selfcheck(lstat_fn=fake_lstat(tree), listdir_fn=fake_listdir(tree), read_fn=read, getgrnam_fn=grnam)
    return dict(results)


def failures(tree, **kw) -> dict[str, str]:
    return {k: v for k, v in run(tree, **kw).items() if v is not None}


# 21 checks before R-B6; + boot restore launcher (3), CLI launcher (3), socket group, restore.toml, bootrestore.json
CHECKS_WITHOUT_RESTORE_UNITS = 30
CHECKS_WITH_RESTORE_UNITS = CHECKS_WITHOUT_RESTORE_UNITS + 4  # each restore unit: trusted path + content
RESTORE_UNITS_TREE = {"/etc/systemd/system/linux-xtu-restore.service": (0, FILE), "/etc/systemd/system/linux-xtu-restore.timer": (0, FILE)}


class Good(unittest.TestCase):
    def test_a_correct_install_passes_every_check(self) -> None:
        results = run(GOOD)
        self.assertEqual({k: v for k, v in results.items() if v}, {})
        self.assertEqual(len(results), CHECKS_WITHOUT_RESTORE_UNITS)
        self.assertFalse([k for k in results if "polkit" in k and "old" not in k])  # no polkit action/rules checks any more, only "no old polkit action file"

    def test_the_audit_log_may_be_absent(self) -> None:
        tree = {k: v for k, v in GOOD.items() if k != "/var/lib/linux-xtu/audit.jsonl"}
        self.assertEqual(failures(tree), {})

    def test_the_accepted_state_is_optional(self) -> None:
        """D-036: a fresh install has no /etc/linux-xtu/accepted (it is the user's, written by the app)."""
        tree = {k: v for k, v in GOOD.items() if not k.startswith("/etc/linux-xtu/accepted")}
        self.assertEqual(failures(tree), {})
        self.assertTrue([k for k in run(tree) if "accepted state" in k])

    def test_an_accepted_directory_that_is_there_is_still_checked(self) -> None:
        tree = {k: v for k, v in GOOD.items() if k != "/etc/linux-xtu/accepted/CURRENT"} | {"/etc/linux-xtu/accepted/EXPECTED-words.txt": (1000, FILE)}
        self.assertTrue([k for k in failures(tree) if "accepted" in k])


class Damage(unittest.TestCase):
    def only(self, tree, **kw) -> tuple[str, str]:
        bad = failures(tree, **kw)
        self.assertEqual(len(bad), 1, bad)
        return next(iter(bad.items()))

    def test_a_user_owned_source_file_in_the_code_tree(self) -> None:
        label, why = self.only(GOOD | {"/usr/lib/linux-xtu/linux_xtu/__init__.py": (1000, FILE)})
        self.assertIn("code tree", label)
        self.assertIn("not root", why)

    def test_a_group_writable_pyc(self) -> None:
        label, why = self.only(GOOD | {"/usr/lib/linux-xtu/linux_xtu/__pycache__/__init__.cpython-314.pyc": (0, stat.S_IFREG | 0o664)})
        self.assertIn("code tree", label)
        self.assertIn("writable", why)

    def test_a_user_owned_platform_file(self) -> None:
        label, why = self.only(GOOD | {"/usr/lib/linux-xtu/platforms/arl-s.toml": (1000, FILE)})
        self.assertIn("code tree", label)
        self.assertIn("arl-s.toml", why)

    def test_a_symlinked_code_directory(self) -> None:
        label, why = self.only(GOOD | {"/usr/lib/linux-xtu/linux_xtu": (0, SYMLINK)})
        self.assertIn("code tree", label)
        self.assertIn("symlink", why)

    def test_a_user_owned_file_at_the_top_level_of_the_code_directory(self) -> None:
        label, why = self.only(GOOD | {"/usr/lib/linux-xtu/stray.py": (1000, FILE)})
        self.assertEqual(label, CODE_TREE)
        self.assertIn("stray.py", why)

    def test_a_launcher_with_other_content_is_refused(self) -> None:
        label, why = self.only(GOOD, launcher=LAUNCHER + b"# extra\n")
        self.assertIn("launcher content", label)
        self.assertIn("sha256", why)

    def test_a_launcher_with_another_shebang_is_refused(self) -> None:
        label, why = self.only(GOOD, launcher=b"#!/usr/bin/python3\n" + LAUNCHER.split(b"\n", 1)[1])
        self.assertIn("shebang", why)

    def test_the_pinned_launcher_hash_matches_the_packaged_launcher(self) -> None:
        import hashlib

        self.assertEqual(selfcheck.LAUNCHER_SHA256, hashlib.sha256(LAUNCHER).hexdigest())
        self.assertEqual(selfcheck.LAUNCHER_SHEBANG, LAUNCHER.split(b"\n", 1)[0])

    def test_leftover_staging_paths_are_flagged(self) -> None:
        for extra in (
            "/usr/lib/linux-xtu.old.123", "/usr/lib/.linux-xtu.new.9",
            "/etc/linux-xtu/.accepted.new.7", "/etc/linux-xtu/accepted.old.2", "/var/lib/linux-xtu/.audit.new.1",
        ):
            tree = GOOD | {extra: (0, DIR)}
            label, why = self.only(tree)
            self.assertIn("leftover", label, extra)
            self.assertIn(extra, why)

    def test_other_packages_in_usr_lib_are_not_leftovers(self) -> None:
        tree = GOOD | {"/usr/lib/python3.old.1": (0, DIR), "/usr/lib/foo.new.2": (0, DIR)}
        self.assertEqual(failures(tree), {})

    def test_the_old_polkit_action_file_must_be_gone(self) -> None:
        tree = GOOD | {"/usr/share/polkit-1/actions/io.github.arrowlake-tuner.helper.policy": (0, FILE)}
        label, why = self.only(tree)
        self.assertEqual(label, "no old polkit action file")
        self.assertIn("must be removed", why)

    def test_unit_files_are_required(self) -> None:
        for name in ("socket", "service"):
            tree = {k: v for k, v in GOOD.items() if not k.endswith("." + name)}
            label, why = self.only(tree)
            self.assertIn(f"linux-xtu-helper.{name}", label)
            self.assertIn("none of", why)

    def test_a_unit_in_usr_lib_systemd_is_found_too(self) -> None:
        tree = {k: v for k, v in GOOD.items() if not k.endswith(".socket")} | {
            "/usr/lib/systemd": (0, DIR), "/usr/lib/systemd/system": (0, DIR), "/usr/lib/systemd/system/linux-xtu-helper.socket": (0, FILE)}
        self.assertEqual(failures(tree, files={"/usr/lib/systemd/system/linux-xtu-helper.socket": SOCKET_UNIT}), {})

    def test_a_user_owned_or_group_writable_unit_is_refused_and_not_read(self) -> None:
        for change in ((1000, FILE), (0, stat.S_IFREG | 0o664)):
            tree = GOOD | {"/etc/systemd/system/linux-xtu-helper.service": change}
            bad = failures(tree)
            self.assertEqual(list(bad), ["systemd service unit linux-xtu-helper.service"])
            self.assertNotIn("systemd service unit linux-xtu-helper.service: content", run(tree))

    def test_socket_mode_0666_without_a_group_is_accepted_like_preflight_does(self) -> None:
        selfcheck.check_socket_unit_text(SOCKET_UNIT.replace(b"SocketMode=0660", b"SocketMode=0666").replace(b"SocketGroup=linux-xtu\n", b""))
        selfcheck.check_socket_unit_text(SOCKET_UNIT.replace(b"SocketMode=0660", b"SocketMode=0666"))  # a group with 0666 is harmless

    def test_0660_needs_a_plain_non_root_group(self) -> None:
        for new in (b"", b"SocketGroup=root\n", b"SocketGroup=bad group\n", b"SocketGroup=a\nSocketGroup=b\n"):
            with self.subTest(new=new):
                with self.assertRaises(ValueError):
                    selfcheck.check_socket_unit_text(SOCKET_UNIT.replace(b"SocketGroup=linux-xtu\n", new))

    def test_the_sockets_group_must_exist(self) -> None:
        label, why = self.only(GOOD, groups=set())
        self.assertEqual(label, "the helper socket's group exists")
        self.assertIn("groupadd --system linux-xtu", why)
        tree_0666 = SOCKET_UNIT.replace(b"SocketMode=0660", b"SocketMode=0666").replace(b"SocketGroup=linux-xtu\n", b"")
        self.assertEqual(failures(GOOD, files={"/etc/systemd/system/linux-xtu-helper.socket": tree_0666}, groups=set()), {})

    def test_systemd_drop_ins_are_refused_unless_empty_or_absent(self) -> None:
        for base in ("/etc/systemd/system", "/run/systemd/system", "/usr/lib/systemd/system", "/etc/systemd/system.control"):
            for unit in ("linux-xtu-helper.service", "linux-xtu-helper.socket", "linux-xtu-restore.service", "linux-xtu-restore.timer"):
                d = f"{base}/{unit}.d"
                tree = GOOD | {d: (0, DIR), f"{d}/override.conf": (0, FILE), base: (0, DIR)}
                label, why = self.only(tree)
                self.assertEqual(label, "no systemd drop-ins for the helper units", d)
                self.assertIn("override.conf", why)
                empty = GOOD | {d: (0, DIR), base: (0, DIR)}
                self.assertEqual(failures(empty), {}, d)  # an empty drop-in directory overrides nothing

    def test_a_group_only_appears_as_the_sockets_group(self) -> None:
        self.assertEqual([k for k in run(GOOD) if "group" in k], ["the helper socket's group exists"])

    def test_helper_toml_is_required_and_must_admit_somebody(self) -> None:
        label, _ = self.only({k: v for k, v in GOOD.items() if k != "/etc/linux-xtu/helper.toml"})
        self.assertEqual(label, "helper.toml")
        for text in (b"allow_taint_bits = [2]\n", b"[access]\nusers = []\n", b"[access\n", b'[access]\nusr = ["a"]\n'):
            with self.subTest(text=text):
                label, why = self.only(GOOD, files={"/etc/linux-xtu/helper.toml": text})
                self.assertIn("[access]", label)
        label, why = self.only(GOOD, files={"/etc/linux-xtu/helper.toml": b"allow_taint_bits = [2]\n"})
        self.assertIn("--add-user", why)

    def test_users_only_or_group_only_access_is_fine(self) -> None:
        for text in (b'[access]\nusers = ["a"]\n', b'[access]\ngroup = "linux-xtu"\n'):
            self.assertEqual(failures(GOOD, files={"/etc/linux-xtu/helper.toml": text}), {})

    def test_a_missing_launcher(self) -> None:
        bad = failures({k: v for k, v in GOOD.items() if k != "/usr/lib/linux-xtu/linux-xtu-helper"})
        self.assertEqual(set(bad), {"helper launcher", "helper launcher is executable"})
        self.assertNotIn("helper launcher content = packaged launcher, isolated-python shebang", bad)

    def test_a_non_executable_launcher(self) -> None:
        label, why = self.only(GOOD | {"/usr/lib/linux-xtu/linux-xtu-helper": (0, FILE)})
        self.assertEqual(label, "helper launcher is executable")
        self.assertIn("not executable", why)

    def test_a_world_writable_parent_directory(self) -> None:
        bad = failures(GOOD | {"/usr/lib": (0, stat.S_IFDIR | 0o777)})
        self.assertTrue(bad)
        self.assertIn("helper launcher", bad)

    def test_a_missing_policy(self) -> None:
        label, why = self.only({k: v for k, v in GOOD.items() if k != "/etc/linux-xtu/policy.toml"})
        self.assertIn("policy", label)
        self.assertIn("does not exist", why)

    def test_a_user_owned_helper_toml(self) -> None:
        label, _ = self.only(GOOD | {"/etc/linux-xtu/helper.toml": (1000, FILE)})
        self.assertIn("helper.toml", label)

    def test_a_tampered_accepted_state(self) -> None:
        label, _ = self.only(GOOD | {"/etc/linux-xtu/accepted/CURRENT": (1000, FILE)})
        self.assertIn("accepted", label)

    def test_an_audit_log_readable_by_others(self) -> None:
        label, why = self.only(GOOD | {"/var/lib/linux-xtu/audit.jsonl": (0, FILE)})
        self.assertEqual(label, "audit log mode 0600")
        self.assertIn("0644", why)

    def test_a_user_owned_audit_log(self) -> None:
        bad = failures(GOOD | {"/var/lib/linux-xtu/audit.jsonl": (1000, PRIVATE)})
        self.assertIn("audit log (may be absent)", bad)

    def test_a_missing_run_directory(self) -> None:
        label, _ = self.only({k: v for k, v in GOOD.items() if k != "/run/linux-xtu"})
        self.assertIn("run dir", label)

    def test_a_user_owned_run_directory(self) -> None:
        label, _ = self.only(GOOD | {"/run/linux-xtu": (1000, DIR)})
        self.assertIn("run dir", label)


class UnitContent(unittest.TestCase):
    def bad(self, fn, text: bytes) -> str:
        with self.assertRaises(ValueError) as ctx:
            fn(text)
        return str(ctx.exception)

    def test_the_shipped_units_pass(self) -> None:
        selfcheck.check_socket_unit_text(SOCKET_UNIT)
        selfcheck.check_service_unit_text(SERVICE_UNIT)

    def test_the_shipped_units_say_what_the_task_says(self) -> None:
        sock = selfcheck.unit_sections(SOCKET_UNIT)["Socket"]
        self.assertEqual((sock["ListenStream"], sock["SocketMode"], sock["SocketUser"], sock["SocketGroup"], sock["RemoveOnStop"]),
                         (["/run/linux-xtu/helper.sock"], ["0660"], ["root"], ["linux-xtu"], ["yes"]))  # D-053 item 4; the peer check stays the gate
        svc = selfcheck.unit_sections(SERVICE_UNIT)["Service"]
        self.assertEqual(svc["ExecStart"], ["/usr/bin/python3 -I /usr/lib/linux-xtu/linux-xtu-helper --device --socket"])
        self.assertEqual((svc["Type"], svc["NoNewPrivileges"]), (["simple"], ["yes"]))
        self.assertNotIn("Install", selfcheck.unit_sections(SERVICE_UNIT))  # started by the socket, never enabled by itself

    def test_socket_mode_owner_group_and_path_are_pinned(self) -> None:
        for old, new in ((b"SocketMode=0660", b"SocketMode=0664"), (b"SocketMode=0660", b"SocketMode=0777"), (b"SocketMode=0660", b"SocketMode=0600"),
                         (b"SocketUser=root", b"SocketUser=alice"), (b"ListenStream=/run/linux-xtu/helper.sock", b"ListenStream=/run/user/1000/helper.sock"),
                         (b"Accept=no", b"Accept=yes")):
            with self.subTest(new=new):
                self.assertTrue(self.bad(selfcheck.check_socket_unit_text, SOCKET_UNIT.replace(old, new)))

    def test_a_second_listener_or_an_unknown_setting_is_refused(self) -> None:
        self.assertIn("ListenStream", self.bad(selfcheck.check_socket_unit_text, SOCKET_UNIT.replace(b"Accept=no", b"Accept=no\nListenStream=0.0.0.0:80")))
        self.assertIn("unexpected", self.bad(selfcheck.check_socket_unit_text, SOCKET_UNIT.replace(b"Accept=no", b"Accept=no\nFreeBind=yes")))

    def test_the_exec_start_is_pinned(self) -> None:
        pinned = b"ExecStart=/usr/bin/python3 -I /usr/lib/linux-xtu/linux-xtu-helper --device --socket"
        for new in (b"ExecStart=/usr/bin/python3 -I /usr/lib/linux-xtu/linux-xtu-helper --device", b"ExecStart=/usr/bin/python3 /usr/lib/linux-xtu/linux-xtu-helper --device --socket",
                    b"ExecStart=/home/dev/checkout/tools/linux-xtu-helper.py --device --socket",
                    b"ExecStart=/usr/bin/python3 -I /usr/lib/linux-xtu/linux-xtu-helper --device --socket --sim"):
            with self.subTest(new=new):
                self.assertIn("ExecStart", self.bad(selfcheck.check_service_unit_text, SERVICE_UNIT.replace(pinned, new)))

    def test_a_second_exec_start_is_refused(self) -> None:
        self.assertIn("ExecStart", self.bad(selfcheck.check_service_unit_text, SERVICE_UNIT + b"ExecStart=/bin/sh\n"))

    def test_settings_that_break_the_helper_or_change_who_runs_it_are_refused(self) -> None:
        for extra in (b"User=nobody", b"DynamicUser=yes", b"PrivateDevices=yes", b"ProtectKernelTunables=yes", b"ProtectClock=yes", b"ExecStartPre=/bin/true",
                      b"Environment=PYTHONPATH=/tmp", b"Group=users", b"InaccessiblePaths=/dev/cpu", b"DeviceAllow=char-rtc r", b"DevicePolicy=closed"):
            with self.subTest(extra=extra):
                self.assertIn("must not be set", self.bad(selfcheck.check_service_unit_text, SERVICE_UNIT + extra + b"\n"))

    def test_garbage_is_refused(self) -> None:
        self.assertIn("unparsable", self.bad(selfcheck.check_service_unit_text, b"[Service]\nnot a setting\n"))
        self.assertIn("[Service]", self.bad(selfcheck.check_service_unit_text, b"[Unit]\nDescription=x\n"))
        self.assertIn("[Socket]", self.bad(selfcheck.check_socket_unit_text, b"[Unit]\nDescription=x\n"))
        self.assertIn("UTF-8", self.bad(selfcheck.check_socket_unit_text, b"\xff\xfe"))

    def test_content_is_not_read_when_the_file_fails_the_trust_check(self) -> None:
        tree = GOOD | {"/etc/systemd/system/linux-xtu-helper.socket": (1000, FILE)}
        results = run(tree)
        self.assertNotIn("systemd socket unit linux-xtu-helper.socket: content", results)
        self.assertIsNotNone(results["systemd socket unit linux-xtu-helper.socket"])

    def test_the_unit_constants_match_the_helpers_service(self) -> None:
        from linux_xtu.helper import config, service

        self.assertEqual(selfcheck.SOCKET_PATH, service.SOCKET_PATH)
        self.assertEqual(selfcheck.SOCKET_PATH, config.INSTALLED_SOCKET)

    def test_the_constants_match_the_helpers_config(self) -> None:
        from linux_xtu.helper import config

        self.assertEqual(selfcheck.CODE_DIR, config.INSTALLED_CODE_DIR)
        self.assertEqual(selfcheck.HELPER, config.INSTALLED_HELPER)
        self.assertEqual(selfcheck.STATE_DIR, config.INSTALLED_STATE_DIR)
        self.assertEqual(selfcheck.STATE_DIR / "audit.jsonl", config.INSTALLED_AUDIT)
        self.assertEqual(selfcheck.RUN_DIR, config.INSTALLED_LOCK_DIR)
        self.assertEqual(selfcheck.ETC_DIR / "policy.toml", config.INSTALLED_POLICY)
        self.assertEqual(selfcheck.ETC_DIR / "helper.toml", config.INSTALLED_HELPER_TOML)
        self.assertEqual(selfcheck.ETC_DIR / "accepted", config.INSTALLED_ACCEPTED_DIR)
        self.assertEqual(Path(selfcheck.CODE_DIR) / "platforms", config.INSTALLED_PLATFORMS_DIR)


class BootRestoreAndLaunchers(unittest.TestCase):
    """R-B6: the boot restore units (optional; when present the packaged ones), the CLI / restore launchers, the helper service's hardening rules."""

    def bad(self, fn, text: bytes) -> str:
        with self.assertRaises(ValueError) as ctx:
            fn(text)
        return str(ctx.exception)

    def test_the_packaged_restore_units_pass_and_are_counted(self) -> None:
        results = run(GOOD | RESTORE_UNITS_TREE)
        self.assertEqual({k: v for k, v in results.items() if v}, {})
        self.assertEqual(len(results), CHECKS_WITH_RESTORE_UNITS)
        self.assertIn("boot restore unit linux-xtu-restore.service: content", results)

    def test_a_foreign_restore_unit_fails_with_the_flag_that_replaces_it(self) -> None:
        old = b"[Unit]\nDescription=restore\n[Service]\nType=oneshot\nExecStart=/usr/bin/sudo -u user bash /home/user/repo/captures/lnx/profiles/restore-good.sh\n"
        bad = failures(GOOD | RESTORE_UNITS_TREE, files={"/etc/systemd/system/linux-xtu-restore.service": old})
        self.assertEqual(list(bad), ["boot restore unit linux-xtu-restore.service: content"])
        self.assertIn("--replace-boot-restore", bad["boot restore unit linux-xtu-restore.service: content"])

    def test_the_restore_service_is_pinned(self) -> None:
        pinned = b"ExecStart=/usr/bin/python3 -I /usr/lib/linux-xtu/linux-xtu-restore run"
        for old, new in ((pinned, b"ExecStart=/usr/bin/python3 /usr/lib/linux-xtu/linux-xtu-restore run"),
                         (pinned, b"ExecStart=/usr/bin/python3 -I /home/user/repo/tools/linux-xtu.py apply x --device"),
                         (b"Type=exec", b"Type=oneshot"), (b"UMask=0077", b"UMask=0077\nUser=op"), (b"UMask=0077", b"UMask=0077\nProtectClock=yes"),
                         (b"UMask=0077", b"UMask=0077\n[Install]\nWantedBy=multi-user.target"),
                         (b"ReadWritePaths=/var/lib/linux-xtu /run/linux-xtu", b"ReadWritePaths=/var/lib/linux-xtu")):
            with self.subTest(new=new):
                self.assertTrue(self.bad(selfcheck.check_restore_service_text, RESTORE_SERVICE.replace(old, new)))
        selfcheck.check_restore_service_text(RESTORE_SERVICE)
        selfcheck.check_restore_timer_text(RESTORE_TIMER)

    def test_the_restore_timer_starts_only_the_restore_once_per_boot(self) -> None:
        for old, new in ((b"Unit=linux-xtu-restore.service", b"Unit=other.service"), (b"OnBootSec=30s", b"OnCalendar=hourly"),
                         (b"OnBootSec=30s", b"OnBootSec=30s\nOnUnitActiveSec=1min")):
            with self.subTest(new=new):
                self.assertTrue(self.bad(selfcheck.check_restore_timer_text, RESTORE_TIMER.replace(old, new)))
        self.assertIn("packaged", self.bad(selfcheck.check_restore_timer_text, RESTORE_TIMER.split(b"\n", 1)[1]))

    def test_the_helper_hardening_keeps_its_state_directories_writable(self) -> None:
        selfcheck.check_service_unit_text(SERVICE_UNIT)
        rw = b"ReadWritePaths=/etc/linux-xtu /var/lib/linux-xtu /run/linux-xtu"
        for old, new in ((rw, b"ReadWritePaths=/var/lib/linux-xtu /run/linux-xtu"), (rw, b""), (b"ProtectSystem=strict", b"ProtectSystem=bogus"),
                         (b"ProtectHome=yes", b"ProtectHome=read-only")):
            with self.subTest(new=new):
                self.assertTrue(self.bad(selfcheck.check_service_unit_text, SERVICE_UNIT.replace(old, new)))
        selfcheck.check_service_unit_text(SERVICE_UNIT.replace(b"ProtectSystem=strict", b"ProtectSystem=full").replace(rw, b"ReadWritePaths=/etc/linux-xtu"))
        selfcheck.check_service_unit_text(SERVICE_UNIT.replace(b"ProtectSystem=strict", b"ProtectSystem=no").replace(rw, b""))

    def test_the_shipped_helper_service_never_sets_what_would_close_the_msr_devices(self) -> None:
        svc = selfcheck.unit_sections(SERVICE_UNIT)["Service"]
        for key in ("PrivateDevices", "ProtectClock", "ProtectKernelTunables", "DeviceAllow", "CapabilityBoundingSet", "PrivateNetwork"):
            self.assertNotIn(key, svc)
        for key, want in (("ProtectSystem", ["strict"]), ("ProtectHome", ["yes"]), ("PrivateTmp", ["yes"]), ("NoNewPrivileges", ["yes"]), ("UMask", ["0077"])):
            self.assertEqual(svc.get(key), want, key)

    def test_the_launcher_pins_match_the_packaged_files(self) -> None:
        import hashlib

        self.assertEqual(selfcheck.RESTORE_SHA256, hashlib.sha256(RESTORE_LAUNCHER).hexdigest())
        self.assertEqual(selfcheck.CLI_SHA256, hashlib.sha256(CLI_LAUNCHER).hexdigest())
        for data in (RESTORE_LAUNCHER, CLI_LAUNCHER):
            self.assertEqual(data.split(b"\n", 1)[0], selfcheck.LAUNCHER_SHEBANG)
            self.assertIn(b'sys.path.insert(0, "/usr/lib/linux-xtu")', data)

    def test_a_tampered_or_missing_restore_or_cli_launcher_fails_by_name(self) -> None:
        bad = failures(GOOD, files={str(selfcheck.RESTORE): RESTORE_LAUNCHER + b"# x\n"})
        self.assertEqual(list(bad), ["boot restore launcher content = packaged launcher, isolated-python shebang"])
        bad = failures({k: v for k, v in GOOD.items() if k != "/usr/lib/linux-xtu/linux-xtu-cli"})
        self.assertEqual(list(bad), ["CLI launcher"])
        bad = failures(GOOD | {"/usr/lib/linux-xtu/linux-xtu-cli": (0, FILE)})
        self.assertEqual(list(bad), ["CLI launcher is executable"])

    def test_the_boot_restore_state_and_config_must_be_root_owned_when_present(self) -> None:
        for path in ("/var/lib/linux-xtu/bootrestore.json", "/etc/linux-xtu/restore.toml"):
            with self.subTest(path=path):
                self.assertEqual(failures(GOOD | {path: (0, FILE)}), {})
                self.assertTrue(failures(GOOD | {path: (1000, FILE)}))

    def test_a_staging_leftover_of_the_state_file_is_flagged(self) -> None:
        bad = failures(GOOD | {"/var/lib/linux-xtu/.bootrestore.new.42": (0, FILE)})
        self.assertEqual(list(bad), ["no leftover .old.*/.new.* staging paths"])


if __name__ == "__main__":
    unittest.main()
