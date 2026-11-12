"""R-R1 (D-054): install.sh migrates an install made under the earlier name `arltuner` to `linux-xtu`, in a DESTDIR fake root (never the live system:
no systemctl, groupadd, usermod or arm runs there). Fresh install, migration with and without the packaged boot restore enabled, a foreign boot restore unit
of the old name, a half-done earlier run, re-run idempotence, uninstall --remove-migrated, and no old-name path in what is installed."""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

from ._support import REPO, run_script
from .test_layout import InstallCase, snapshot

UNITS = "/etc/systemd/system"
OLD_PACKAGED_SERVICE = "# arltuner: packaged unit (install.sh replaces it on upgrade)\n[Unit]\nDescription=old boot restore\n\n[Service]\nType=exec\nExecStart=/usr/bin/python3 -I /usr/lib/arltuner/arltuner-restore run\n"
OLD_PACKAGED_TIMER = "# arltuner: packaged unit (install.sh replaces it on upgrade)\n[Unit]\nDescription=old timer\n\n[Timer]\nOnBootSec=30s\nUnit=arltuner-restore.service\n\n[Install]\nWantedBy=timers.target\n"
FOREIGN_SERVICE = (  # the shape of the reference machine's out-of-repo unit: a checkout script, every boot
    "[Unit]\nDescription=Re-apply the tuning\n\n[Service]\nType=oneshot\nUser=user\nExecStart=/usr/bin/bash /home/user/repo/captures/lnx/profiles/restore-good.sh good\n"
)
FOREIGN_TIMER = "[Unit]\nDescription=Re-apply 60 s after boot\n\n[Timer]\nOnBootSec=60s\n\n[Install]\nWantedBy=timers.target\n"
OLD_SOCKET = "[Unit]\nDescription=arrowlake-tuner helper socket\n\n[Socket]\nListenStream=/run/arltuner/helper.sock\nSocketUser=root\nSocketMode=0666\nDirectoryMode=0755\n\n[Install]\nWantedBy=sockets.target\n"
OLD_SERVICE = "[Unit]\nDescription=arrowlake-tuner root helper\n\n[Service]\nExecStart=/usr/bin/python3 -I /usr/lib/arltuner/arltuner-helper --device --socket\n"
BOOTRESTORE = {"schema": 1, "armed": True, "armed_at": "2026-11-01T00:00:00Z", "armed_by": "root", "accepted": {"name": "good", "sha256": "ab" * 32},
               "identity": {"vendor": "GenuineIntel", "family": 6, "model": 198}, "pending": None, "disarmed": None, "last": None, "history": []}


def out(r) -> str:
    return r.stdout + r.stderr


class Migration(InstallCase):
    def plant_old(self, *, socket_enabled: bool = True, restore: str | None = None, restore_enabled: bool = False, armed: bool = True) -> dict[str, bytes]:
        """An arltuner install as the reference machine has it: settings, accepted state with its fingerprint, audit log, stores, code, units, tmpfiles."""
        files = {
            "/etc/arltuner/policy.toml": b"# the operator's own limits\n[limits]\nx = 1\n",
            "/etc/arltuner/policy.toml.bak-2026-10-12": b"# an older policy\n",
            "/etc/arltuner/helper.toml": b'allow_taint_bits = [2]\nidle_exit_s = 600\n[access]\nusers = ["alice"]\n',
            "/etc/arltuner/restore.toml": b"healthy_uptime_s = 900\n",
            "/etc/arltuner/accepted/CURRENT": b'profile = "profiles/good-p57-e47.toml"\n',
            "/etc/arltuner/accepted/EXPECTED-words.txt": b"0 F9A00035 0 0\n",
            "/etc/arltuner/accepted/fingerprint.json": b'{"cpu_id": {"vendor": "GenuineIntel"}}\n',
            "/etc/arltuner/accepted/profiles/good-p57-e47.toml": b"[meta]\ncomplete = true\n",
            "/var/lib/arltuner/audit.jsonl": b'{"event":"attempt"}\n{"event":"result"}\n' * 50,
            "/var/lib/arltuner/bootrestore.json": json.dumps(dict(BOOTRESTORE, armed=armed)).encode(),
            "/var/lib/arltuner/curves/p0.json": b"{}\n",
            "/var/lib/arltuner/profiles/mine.json": b"{}\n",
            "/var/lib/arltuner/throttle.jsonl": b"{}\n",
            "/usr/lib/arltuner/arltuner/__init__.py": b"# old code\n",
            "/usr/lib/arltuner/arltuner-helper": b"#!/usr/bin/python3 -I\n",
            f"{UNITS}/arltuner-helper.socket": OLD_SOCKET.encode(),
            f"{UNITS}/arltuner-helper.service": OLD_SERVICE.encode(),
            "/usr/lib/tmpfiles.d/arltuner.conf": b"d /run/arltuner 0755 root root -\n",
            "/etc/group": b"root:x:0:\narltuner:x:977:alice,bob\n",
        }
        if restore == "packaged":
            files[f"{UNITS}/arltuner-restore.service"] = OLD_PACKAGED_SERVICE.encode()
            files[f"{UNITS}/arltuner-restore.timer"] = OLD_PACKAGED_TIMER.encode()
        elif restore == "foreign":
            files[f"{UNITS}/arltuner-restore.service"] = FOREIGN_SERVICE.encode()
            files[f"{UNITS}/arltuner-restore.timer"] = FOREIGN_TIMER.encode()
        for path, data in files.items():
            p = self.path(path)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        for d in ("/var/lib/arltuner/curves", "/var/lib/arltuner/profiles"):
            os.chmod(self.path(d), 0o700)
        os.chmod(self.path("/var/lib/arltuner/audit.jsonl"), 0o600)
        os.chmod(self.path("/usr/lib/arltuner/arltuner-helper"), 0o755)
        if socket_enabled:
            self.link("sockets.target", "arltuner-helper.socket")
        if restore_enabled:
            self.link("timers.target", "arltuner-restore.timer")
        self.path("/run/arltuner").mkdir(parents=True)
        return {k: v for k, v in files.items() if k.startswith(("/etc/arltuner/", "/var/lib/arltuner/"))}

    def link(self, target: str, unit: str) -> None:
        wants = self.path(f"{UNITS}/{target}.wants")
        wants.mkdir(parents=True, exist_ok=True)
        (wants / unit).symlink_to(f"/etc/systemd/system/{unit}")

    def one(self, pattern: str) -> Path:
        found = sorted(self.dest.glob(pattern.lstrip("/")))
        self.assertEqual(len(found), 1, f"{pattern}: {found}")
        return found[0]

    def assert_migrated(self, planted: dict[str, bytes]) -> None:
        for path, data in planted.items():
            new = path.replace("/etc/arltuner/", "/etc/linux-xtu/").replace("/var/lib/arltuner/", "/var/lib/linux-xtu/")
            self.assertEqual(self.path(new).read_bytes(), data, new)
        self.assertEqual(self.mode("/var/lib/linux-xtu/audit.jsonl"), 0o600)
        self.assertEqual(self.mode("/var/lib/linux-xtu/curves"), 0o700)
        for old in ("/etc/arltuner", "/var/lib/arltuner", "/usr/lib/arltuner", "/usr/lib/tmpfiles.d/arltuner.conf", f"{UNITS}/arltuner-helper.socket",
                    f"{UNITS}/arltuner-helper.service", f"{UNITS}/sockets.target.wants/arltuner-helper.socket"):
            self.assertFalse(os.path.lexists(self.path(old)), f"{old} is retired")
        # nothing deleted: the old directories are renamed, the old units and tmpfiles file moved under the new state directory
        self.assertEqual(self.one("/etc/arltuner.migrated-*").joinpath("policy.toml").read_bytes(), planted["/etc/arltuner/policy.toml"])
        self.assertEqual(self.one("/var/lib/arltuner.migrated-*").joinpath("audit.jsonl").read_bytes(), planted["/var/lib/arltuner/audit.jsonl"])
        self.assertTrue(self.one("/usr/lib/arltuner.migrated-*").joinpath("arltuner-helper").is_file())
        retired = self.one("/var/lib/linux-xtu/migrated-from-arltuner-*")
        self.assertEqual(stat.S_IMODE(retired.stat().st_mode), 0o700)
        self.assertEqual((retired / f"root{UNITS}/arltuner-helper.socket").read_text(), OLD_SOCKET)
        self.assertEqual((retired / "root/usr/lib/tmpfiles.d/arltuner.conf").read_bytes(), b"d /run/arltuner 0755 root root -\n")

    def test_migration_without_the_boot_restore(self) -> None:
        planted = self.plant_old()
        r = self.ok_install()
        self.assert_migrated(planted)
        o = out(r)
        self.assertIn("found an install under the earlier name arltuner", o)
        self.assertIn("== migrated the arltuner install to linux-xtu", o)
        self.assertIn("/etc/arltuner -> /etc/linux-xtu: copied", o)
        self.assertIn("group arltuner (members: alice,bob)", o)
        self.assertIn("policy.toml: KEPT", o)  # the operator's policy came over and is not reseeded
        self.assertIn("audit.jsonl: kept", o)
        self.assertIn("accepted/: kept", o)
        # the same set enabled as before: the socket (its 0666 mode kept), not the boot restore
        self.assertTrue(self.path(f"{UNITS}/sockets.target.wants/linux-xtu-helper.socket").is_symlink())
        self.assertIn("SocketMode=0666", self.path(f"{UNITS}/linux-xtu-helper.socket").read_text())
        self.assertFalse(os.path.lexists(self.path(f"{UNITS}/timers.target.wants/linux-xtu-restore.timer")))
        self.assertIn("boot restore: installed, DISABLED", o)
        retired = self.one("/var/lib/linux-xtu/migrated-from-arltuner-*")
        self.assertIn("arltuner-helper.socket enabled", (retired / "enabled.txt").read_text())
        self.assertIn("arltuner-restore.timer disabled", (retired / "enabled.txt").read_text())
        self.assertTrue(self.path("/run/arltuner").is_dir(), "a run-time directory is left alone (gone at the next boot)")
        for word in ("systemctl", "groupadd", "usermod"):
            self.assertNotIn(word, o)

    def test_migration_with_the_packaged_boot_restore_enabled_keeps_it_enabled_and_its_arm_state(self) -> None:
        for armed in (True, False):
            with self.subTest(armed=armed):
                self.setUp()
                planted = self.plant_old(restore="packaged", restore_enabled=True, armed=armed)
                r = self.ok_install()
                self.assert_migrated(planted)
                link = self.path(f"{UNITS}/timers.target.wants/linux-xtu-restore.timer")
                self.assertTrue(link.is_symlink())
                self.assertEqual(os.readlink(link), "/etc/systemd/system/linux-xtu-restore.timer")
                self.assertFalse(os.path.lexists(self.path(f"{UNITS}/timers.target.wants/arltuner-restore.timer")))
                self.assertEqual(json.loads(self.path("/var/lib/linux-xtu/bootrestore.json").read_text())["armed"], armed, "never armed (or disarmed) here")
                self.assertIn("boot restore: ENABLED from the next boot, as the arltuner install had it", r.stdout)
                self.assertIn("this script never arms", r.stdout)
                self.assertIn(f"bootrestore.json: {'armed' if armed else 'safe'} (", r.stdout)
                retired = self.one("/var/lib/linux-xtu/migrated-from-arltuner-*")
                self.assertEqual((retired / f"root{UNITS}/arltuner-restore.timer").read_text(), OLD_PACKAGED_TIMER)
                self.assertIn("arltuner-restore.timer enabled", (retired / "enabled.txt").read_text())

    def test_a_packaged_but_disabled_old_boot_restore_stays_disabled(self) -> None:
        self.plant_old(restore="packaged", restore_enabled=False)
        r = self.ok_install()
        self.assertFalse(os.path.lexists(self.path(f"{UNITS}/timers.target.wants/linux-xtu-restore.timer")))
        self.assertIn("boot restore: installed, DISABLED", r.stdout)

    def test_a_disabled_old_socket_is_not_enabled(self) -> None:
        self.plant_old(socket_enabled=False)
        self.ok_install()
        self.assertFalse(os.path.lexists(self.path(f"{UNITS}/sockets.target.wants/linux-xtu-helper.socket")))

    def test_a_foreign_old_boot_restore_unit_needs_the_flag_and_nothing_changes_without_it(self) -> None:
        self.plant_old(restore="foreign", restore_enabled=True)
        before = snapshot(self.dest)
        r = self.install()
        self.assertNotEqual(r.returncode, 0)
        o = out(r)
        self.assertIn("found a boot restore unit that this script did not install", o)
        self.assertIn("arltuner-restore.service", o)
        self.assertIn("restore-good.sh", o)
        self.assertIn("--replace-boot-restore", o)
        self.assertEqual(snapshot(self.dest), before, "refused before anything was changed")
        r = self.ok_install("--replace-boot-restore")
        backup = self.one("/var/lib/linux-xtu/replaced-units/*")
        self.assertEqual((backup / "arltuner-restore.service").read_text(), FOREIGN_SERVICE)
        self.assertEqual((backup / "arltuner-restore.timer").read_text(), FOREIGN_TIMER)
        for gone in ("arltuner-restore.service", "arltuner-restore.timer", "timers.target.wants/arltuner-restore.timer", "timers.target.wants/linux-xtu-restore.timer"):
            self.assertFalse(os.path.lexists(self.path(f"{UNITS}/{gone}")), gone)
        self.assertIn("boot restore: installed, DISABLED", r.stdout)

    def test_a_rerun_after_the_migration_changes_nothing(self) -> None:
        self.plant_old(restore="packaged", restore_enabled=True)
        self.ok_install()
        first = snapshot(self.dest)
        r = self.ok_install()
        self.assertNotIn("migrated the arltuner install", r.stdout)
        self.assertNotIn("found an install under the earlier name", r.stdout)
        self.assertEqual(snapshot(self.dest), first, "idempotent")

    def test_a_half_done_earlier_run_is_merged_and_a_differing_new_file_is_backed_up(self) -> None:
        planted = self.plant_old()
        newer = self.path("/etc/linux-xtu/accepted/CURRENT")
        newer.parent.mkdir(parents=True)
        newer.write_bytes(b"# seeded by an interrupted run\n")
        same = self.path("/etc/linux-xtu/restore.toml")
        same.write_bytes(planted["/etc/arltuner/restore.toml"])
        extra = self.path("/etc/linux-xtu/only-here.txt")
        extra.write_text("x")
        r = self.ok_install()
        self.assert_migrated(planted)
        backup = self.one("/etc/linux-xtu/accepted/CURRENT.bak-migration-*")
        self.assertEqual(backup.read_bytes(), b"# seeded by an interrupted run\n")
        self.assertEqual(list(self.dest.glob("etc/linux-xtu/restore.toml.bak-migration-*")), [], "an equal file is left alone")
        self.assertEqual(extra.read_text(), "x", "nothing of the new directory is dropped")
        self.assertIn("merged into the existing directory", r.stdout)

    # ---- review F1: a merge never replaces bootrestore.json, audit.jsonl or policy.toml ----------------------------------------------------------
    def new_state(self, name: str, data: bytes) -> Path:
        p = self.path(f"/var/lib/linux-xtu/{name}")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return p

    def test_a_disarmed_new_boot_restore_state_with_a_pending_boot_is_kept_over_an_armed_old_one(self) -> None:
        """The reviewer's case: the old copy must not re-arm what the new install disarmed (or what a crashed boot will disarm)."""
        self.plant_old(restore="packaged", restore_enabled=True, armed=True)
        disarmed = json.dumps(dict(BOOTRESTORE, armed=False, pending={"boot_id": "b1"}, disarmed={"code": "PENDING"})).encode()
        self.new_state("bootrestore.json", disarmed)
        r = self.ok_install()
        self.assertEqual(self.path("/var/lib/linux-xtu/bootrestore.json").read_bytes(), disarmed)
        self.assertEqual(list(self.dest.glob("var/lib/linux-xtu/bootrestore.json.bak-migration-*")), [])
        self.assertIn("/var/lib/linux-xtu/bootrestore.json: kept", r.stdout)
        self.assertIn("bootrestore.json: safe", r.stdout, "the summary names the real state")
        self.assertNotIn("bootrestore.json: armed", r.stdout)

    def test_an_armed_new_state_over_a_disarmed_old_one_is_refused_before_anything_changes(self) -> None:
        self.plant_old(armed=False)
        self.new_state("bootrestore.json", json.dumps(dict(BOOTRESTORE, armed=True)).encode())
        before = snapshot(self.dest)
        r = self.install()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("bootrestore.json is armed but", r.stderr)
        self.assertIn("linux-xtu-restore disarm", r.stderr)
        self.assertEqual(snapshot(self.dest), before)

    def test_the_audit_logs_merge_without_losing_a_record_or_are_refused(self) -> None:
        planted = self.plant_old()
        old = planted["/var/lib/arltuner/audit.jsonl"]
        newer = self.new_state("audit.jsonl", old + b'{"event":"new"}\n')  # the new log already has every old record, and more
        self.ok_install()
        self.assertEqual(newer.read_bytes(), old + b'{"event":"new"}\n')
        self.setUp()
        planted = self.plant_old()
        old = planted["/var/lib/arltuner/audit.jsonl"]
        shorter = self.new_state("audit.jsonl", old[:40])  # the old log went on after an earlier copy: its extra records are appended
        r = self.ok_install()
        self.assertEqual(shorter.read_bytes(), old)
        self.assertIn("appended", r.stdout)
        self.setUp()
        self.plant_old()
        self.new_state("audit.jsonl", b'{"event":"elsewhere"}\n')
        before = snapshot(self.dest)
        r = self.install()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("both hold records the other lacks", r.stderr)
        self.assertEqual(snapshot(self.dest), before)

    def test_a_differing_new_policy_is_kept(self) -> None:
        self.plant_old()
        mine = self.path("/etc/linux-xtu/policy.toml")
        mine.parent.mkdir(parents=True)
        mine.write_text("# edited after an earlier run\n")
        r = self.ok_install()
        self.assertEqual(mine.read_text(), "# edited after an earlier run\n")
        self.assertEqual(list(self.dest.glob("etc/linux-xtu/policy.toml.bak-migration-*")), [])
        self.assertIn("kept /etc/linux-xtu/policy.toml", r.stdout)

    # ---- review F5: a re-run after a failure in the last phase restores exactly the recorded enabled set ------------------------------------------
    def test_a_rerun_after_a_last_phase_failure_restores_the_recorded_enabled_set(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("a read-only directory does not stop root")
        self.plant_old(restore="packaged", restore_enabled=True)
        stuck = self.path("/usr/share/arltuner")  # a non-web file keeps it; a read-only /usr/share makes its rename (the last step) fail
        stuck.mkdir(parents=True)
        (stuck / "notes.txt").write_text("x")
        os.chmod(self.path("/usr/share"), 0o555)
        try:
            r = self.install()
        finally:
            os.chmod(self.path("/usr/share"), 0o755)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("CRITICAL: the migration stopped in its last phase", r.stderr)
        retired = self.one("/var/lib/linux-xtu/migrated-from-arltuner-*")
        self.assertNotIn("complete", (retired / "enabled.txt").read_text().splitlines())
        for link in ("sockets.target.wants/linux-xtu-helper.socket", "timers.target.wants/linux-xtu-restore.timer", "sockets.target.wants/arltuner-helper.socket"):
            self.assertFalse(os.path.lexists(self.path(f"{UNITS}/{link}")), link)  # the old links are gone, the new ones not made yet
        r = self.ok_install()
        stamp = retired.name.rsplit("-", 1)[1]
        self.assertIn(f"resuming the migration of {stamp}", r.stdout)
        self.assertIn("(arltuner-helper.socket enabled, arltuner-restore.timer enabled)", r.stdout)
        self.assertTrue(self.path(f"{UNITS}/sockets.target.wants/linux-xtu-helper.socket").is_symlink())
        self.assertTrue(self.path(f"{UNITS}/timers.target.wants/linux-xtu-restore.timer").is_symlink())
        self.assertTrue(self.path(f"/usr/share/arltuner.migrated-{stamp}").is_dir(), "the resumed run uses the first run's stamp")
        self.assertEqual((retired / "enabled.txt").read_text().splitlines()[-1], "complete")
        self.assertEqual(len(list(self.dest.glob("var/lib/linux-xtu/migrated-from-arltuner-*"))), 1)
        r = self.ok_install()
        self.assertNotIn("resuming", r.stdout)

    def test_the_old_desktop_entry_and_msr_file_are_carried_over(self) -> None:
        self.plant_old()
        self.path("/usr/share/applications").mkdir(parents=True)
        self.path("/usr/share/applications/arltuner.desktop").write_text("[Desktop Entry]\nExec=/opt/arltuner.AppImage\nX-Arltuner-Packaged=true\n")
        self.path("/etc/modules-load.d").mkdir(parents=True)
        self.path("/etc/modules-load.d/arltuner.conf").write_text("# arltuner: packaged file (install.sh --load-msr)\nmsr\n")
        r = self.ok_install()
        self.assertFalse(os.path.lexists(self.path("/usr/share/applications/arltuner.desktop")))
        self.assertIn("NOTE: the arltuner desktop entry was moved aside", r.stdout)
        self.assertFalse(os.path.lexists(self.path("/etc/modules-load.d/arltuner.conf")))
        self.assertEqual(self.path("/etc/modules-load.d/linux-xtu.conf").read_bytes(), (REPO / "packaging/linux-xtu-modules.conf").read_bytes())
        retired = self.one("/var/lib/linux-xtu/migrated-from-arltuner-*")
        self.assertTrue((retired / "root/usr/share/applications/arltuner.desktop").is_file())

    def test_a_symlinked_old_directory_is_refused_before_anything_changes(self) -> None:
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "policy.toml").write_text("planted\n")
        self.path("/etc").mkdir(parents=True)
        self.path("/etc/arltuner").symlink_to(elsewhere)
        r = self.install()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("is a symbolic link; refusing to migrate", r.stderr)
        self.assertFalse(os.path.lexists(self.path("/etc/linux-xtu")))
        self.assertFalse(os.path.lexists(self.path("/usr/lib/linux-xtu")))

    def test_uninstall_keeps_the_leftovers_unless_asked_and_then_removes_only_them(self) -> None:
        self.plant_old()
        newer = self.path("/etc/linux-xtu/accepted/CURRENT")  # differs: kept as CURRENT.bak-migration-<UTC>, a leftover
        newer.parent.mkdir(parents=True)
        newer.write_text("differs\n")
        self.ok_install()
        self.one("/etc/linux-xtu/accepted/CURRENT.bak-migration-*")
        r = run_script(REPO / "uninstall.sh", destdir=self.dest)
        self.assertEqual(r.returncode, 0, out(r))
        self.assertIn("leftover(s) of the migrated arltuner install", r.stdout)
        self.one("/etc/arltuner.migrated-*")
        self.assertFalse(os.path.lexists(self.path("/usr/lib/linux-xtu")))
        self.assertFalse(os.path.lexists(self.path(f"{UNITS}/sockets.target.wants/linux-xtu-helper.socket")))
        r = run_script(REPO / "uninstall.sh", "--remove-migrated", destdir=self.dest)
        self.assertEqual(r.returncode, 0, out(r))
        for pattern in ("etc/arltuner.migrated-*", "var/lib/arltuner.migrated-*", "usr/lib/arltuner.migrated-*", "var/lib/linux-xtu/migrated-from-arltuner-*",
                        "etc/linux-xtu/accepted/*.bak-migration-*"):
            self.assertEqual(list(self.dest.glob(pattern)), [], pattern)
        self.assertTrue(self.path("/etc/linux-xtu/accepted/fingerprint.json").is_file(), "the new install's data stays (no --purge)")
        self.assertTrue(self.path("/var/lib/linux-xtu/audit.jsonl").is_file())


class FreshInstall(InstallCase):
    def test_no_old_name_in_anything_installed_except_the_package_s_legacy_readers(self) -> None:
        """A fresh install migrates nothing, and no unit, launcher, tmpfiles / modules-load file or desktop entry names arltuner."""
        app = self.tmp / "linux-xtu.AppImage"
        app.write_text("x")
        r = self.ok_install("--appimage", str(app), "--load-msr", "--enable-boot-restore")
        self.assertNotIn("arltuner", r.stdout.replace("/usr/share/arltuner", ""))
        self.assertEqual([p for p in self.dest.rglob("*") if "arltuner" in p.name], [])
        for rel in ("etc/systemd/system/linux-xtu-helper.socket", "etc/systemd/system/linux-xtu-helper.service", "etc/systemd/system/linux-xtu-restore.service",
                    "etc/systemd/system/linux-xtu-restore.timer", "usr/lib/tmpfiles.d/linux-xtu.conf", "etc/modules-load.d/linux-xtu.conf",
                    "usr/share/applications/linux-xtu.desktop", "usr/lib/linux-xtu/linux-xtu-helper", "usr/lib/linux-xtu/linux-xtu-restore",
                    "usr/lib/linux-xtu/linux-xtu-cli", "usr/lib/linux-xtu/linux-xtu-access", "usr/lib/linux-xtu/linux-xtu-selfcheck",
                    "etc/linux-xtu/restore.toml", "etc/linux-xtu/helper.toml"):
            data = self.path("/" + rel).read_bytes()
            if rel.endswith(".service"):  # review F3: the services may write the old lock directories (the guard holds the old lock files too)
                self.assertIn(b"\nReadWritePaths=-/run/arltuner\n", data, rel)
                data = b"\n".join(line for line in data.split(b"\n") if not line.startswith(b"ReadWritePaths=-/run/arltuner") and b"D-054" not in line)
            self.assertNotIn(b"arltuner", data, rel)
        # the package keeps exactly its documented legacy readers (docs/NAMING.md): the old kernel opt-out word and the old lock-file format id
        holders = sorted(p.relative_to(self.path("/usr/lib/linux-xtu/linux_xtu")).as_posix()
                         for p in self.path("/usr/lib/linux-xtu/linux_xtu").rglob("*.py") if b"arltuner" in p.read_bytes())
        self.assertEqual(holders, ["bootrestore.py", "guard/applylock.py", "guard/guard.py", "guard/lockfile.py", "paths.py"])
