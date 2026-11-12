"""R-B6: what install.sh / uninstall.sh do with the boot restore units, an out-of-repo unit of the same name, the socket mode, the desktop entry and the msr
module, in a DESTDIR fake root (never the live system: no systemctl, groupadd, usermod or arm runs there)."""
from __future__ import annotations

import importlib.util
import os
import stat
from pathlib import Path

from ._support import REPO
from .test_layout import InstallCase, snapshot

UNITS = "/etc/systemd/system"
WANTS = f"{UNITS}/timers.target.wants/linux-xtu-restore.timer"
FOREIGN_SERVICE = (  # the shape of the out-of-repo unit of the reference machine (assessment 06 F1): a checkout script as root through sudo, every boot
    "[Unit]\nDescription=Restore tuning\n\n[Service]\nType=oneshot\n"
    "ExecStart=/bin/sh -c '/usr/bin/sudo -u user bash /home/user/repo/captures/lnx/profiles/restore-good.sh || true'\n"
)
FOREIGN_TIMER = "[Unit]\nDescription=Restore tuning 60 s after boot\n\n[Timer]\nOnBootSec=60\n\n[Install]\nWantedBy=timers.target\n"

spec = importlib.util.spec_from_file_location("linux_xtu_selfcheck_b6", REPO / "packaging" / "selfcheck.py")
selfcheck = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selfcheck)


def quiet(r) -> str:
    return r.stdout + r.stderr


class Fresh(InstallCase):
    def test_the_restore_units_are_installed_disabled_and_the_output_says_how_to_enable(self) -> None:
        r = self.ok_install()
        for name in ("linux-xtu-restore.service", "linux-xtu-restore.timer"):
            self.assertEqual(self.path(f"{UNITS}/{name}").read_bytes(), (REPO / "packaging" / name).read_bytes())
        self.assertFalse(os.path.lexists(self.path(WANTS)))
        self.assertIn("boot restore: installed, DISABLED", r.stdout)
        self.assertIn("install.sh --enable-boot-restore", r.stdout)
        self.assertEqual(self.path("/etc/linux-xtu/restore.toml").read_bytes(), (REPO / "packaging/restore.toml").read_bytes())
        for word in ("systemctl", "groupadd", "usermod"):
            self.assertNotIn(word, quiet(r))

    def test_enable_makes_the_timers_wants_link_and_an_upgrade_keeps_it(self) -> None:
        r = self.ok_install("--enable-boot-restore")
        self.assertIn("boot restore: ENABLED from the next boot", r.stdout)
        self.assertIn("not armed (DESTDIR install)", r.stdout)
        link = self.path(WANTS)
        self.assertTrue(link.is_symlink())
        self.assertEqual(os.readlink(link), "/etc/systemd/system/linux-xtu-restore.timer")
        first = snapshot(self.dest)
        r = self.ok_install()  # an upgrade without a flag
        self.assertIn("boot restore: enabled (kept)", r.stdout)
        self.assertTrue(link.is_symlink())
        self.ok_install("--enable-boot-restore")
        self.assertEqual(snapshot(self.dest), first, "enabling twice changes nothing")
        r = self.ok_install("--disable-boot-restore")
        self.assertFalse(os.path.lexists(link))
        self.assertIn("boot restore: DISABLED", r.stdout)

    def test_enable_and_disable_together_are_refused_before_anything_is_written(self) -> None:
        r = self.install("--enable-boot-restore", "--disable-boot-restore")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("exclude each other", r.stderr)
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_restore_toml_is_operator_owned_after_the_first_install(self) -> None:
        self.ok_install()
        self.path("/etc/linux-xtu/restore.toml").write_text("healthy_uptime_s = 900\n")
        r = self.ok_install()
        self.assertEqual(self.path("/etc/linux-xtu/restore.toml").read_text(), "healthy_uptime_s = 900\n")
        self.assertIn("restore.toml: KEPT", r.stdout)
        self.ok_install("--reseed-config")
        self.assertEqual(self.path("/etc/linux-xtu/restore.toml").read_bytes(), (REPO / "packaging/restore.toml").read_bytes())


class ForeignUnit(InstallCase):
    """The installer detects a linux-xtu-restore unit it did not install, says what it will replace, and replaces it only with --replace-boot-restore."""

    def plant(self) -> None:
        units = self.path(UNITS)
        units.mkdir(parents=True, exist_ok=True)
        (units / "linux-xtu-restore.service").write_text(FOREIGN_SERVICE)
        (units / "linux-xtu-restore.timer").write_text(FOREIGN_TIMER)
        (units / "timers.target.wants").mkdir(exist_ok=True)
        (units / "timers.target.wants" / "linux-xtu-restore.timer").symlink_to("/etc/systemd/system/linux-xtu-restore.timer")

    def test_without_the_flag_it_is_described_and_nothing_is_changed(self) -> None:
        self.ok_install()
        self.plant()
        before = snapshot(self.dest)
        r = self.install()
        self.assertNotEqual(r.returncode, 0)
        out = quiet(r)
        self.assertIn("found a boot restore unit that this script did not install", out)
        self.assertIn("restore-good.sh", out)  # its ExecStart is shown
        self.assertIn("enabled:", out)
        self.assertIn("--replace-boot-restore", out)
        self.assertIn("nothing was changed", out)
        self.assertEqual(snapshot(self.dest), before)

    def test_with_the_flag_it_is_backed_up_disabled_and_replaced_by_the_packaged_disabled_units(self) -> None:
        self.ok_install()
        self.plant()
        r = self.ok_install("--replace-boot-restore")
        backups = list(self.path("/var/lib/linux-xtu/replaced-units").iterdir())
        self.assertEqual(len(backups), 1)
        self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o700)
        self.assertEqual((backups[0] / "linux-xtu-restore.service").read_text(), FOREIGN_SERVICE)
        self.assertEqual((backups[0] / "linux-xtu-restore.timer").read_text(), FOREIGN_TIMER)
        for name in ("linux-xtu-restore.service", "linux-xtu-restore.timer"):
            self.assertEqual(self.path(f"{UNITS}/{name}").read_bytes(), (REPO / "packaging" / name).read_bytes())
        self.assertFalse(os.path.lexists(self.path(WANTS)), "the old enablement does not enable the new unit")
        self.assertIn("removed the old enablement link", r.stdout)
        self.assertIn("boot restore: installed, DISABLED", r.stdout)
        selfcheck.check_restore_service_text(self.path(f"{UNITS}/linux-xtu-restore.service").read_bytes())
        r = self.ok_install()  # the packaged units are ours from now on: no flag needed
        self.assertNotIn("did not install", r.stdout)

    def test_the_flag_together_with_enable_replaces_and_enables(self) -> None:
        self.plant()
        self.ok_install("--replace-boot-restore", "--enable-boot-restore")
        self.assertTrue(self.path(WANTS).is_symlink())
        selfcheck.check_restore_timer_text(self.path(f"{UNITS}/linux-xtu-restore.timer").read_bytes())

    def test_a_linked_unit_is_foreign_too_and_the_link_itself_is_backed_up(self) -> None:
        elsewhere = self.tmp / "checkout-unit.service"
        elsewhere.write_text(FOREIGN_SERVICE)
        self.path(UNITS).mkdir(parents=True)
        self.path(f"{UNITS}/linux-xtu-restore.service").symlink_to(elsewhere)
        r = self.install()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("(a link)", r.stdout)
        self.ok_install("--replace-boot-restore")
        backup = next(self.path("/var/lib/linux-xtu/replaced-units").iterdir()) / "linux-xtu-restore.service"
        self.assertTrue(backup.is_symlink())
        self.assertEqual(elsewhere.read_text(), FOREIGN_SERVICE, "the target of the link is not touched")
        self.assertFalse(self.path(f"{UNITS}/linux-xtu-restore.service").is_symlink())


class SocketMode(InstallCase):
    def test_the_default_is_the_packaged_0660_group_socket(self) -> None:
        r = self.ok_install()
        text = self.path(f"{UNITS}/linux-xtu-helper.socket").read_bytes()
        self.assertIn(b"SocketMode=0660", text)
        self.assertIn(b"SocketGroup=linux-xtu", text)
        self.assertIn("root:linux-xtu 0660", r.stdout)
        selfcheck.check_socket_unit_text(text)

    def test_0666_writes_the_d043_amendment_form_and_an_upgrade_keeps_it(self) -> None:
        r = self.ok_install("--socket-mode", "0666")
        text = self.path(f"{UNITS}/linux-xtu-helper.socket").read_bytes()
        self.assertIn(b"SocketMode=0666", text)
        self.assertNotIn(b"SocketGroup", text)
        self.assertEqual(self.mode(f"{UNITS}/linux-xtu-helper.socket"), 0o644)
        self.assertIn("mode 0666", r.stdout)
        selfcheck.check_socket_unit_text(text)
        self.assertEqual(sorted(p.name for p in self.path(UNITS).iterdir() if p.name.startswith(".")), [], "no staging file is left")
        r = self.ok_install()  # an upgrade without the option never switches the mode silently
        self.assertEqual(self.path(f"{UNITS}/linux-xtu-helper.socket").read_bytes(), text)
        self.assertIn("kept the installed mode 0666", r.stdout)
        self.ok_install("--socket-mode", "0660")
        self.assertEqual(self.path(f"{UNITS}/linux-xtu-helper.socket").read_bytes(), (REPO / "packaging/linux-xtu-helper.socket").read_bytes())
        r = self.ok_install()
        self.assertIn("kept the installed mode 0660", r.stdout)

    def test_an_upgrade_of_the_pre_d053_layout_keeps_0666_and_says_how_to_switch(self) -> None:
        self.ok_install()
        old = ("[Unit]\nDescription=arrowlake-tuner helper socket\n\n[Socket]\nListenStream=/run/linux-xtu/helper.sock\nSocketUser=root\nSocketMode=0666\n"
               "DirectoryMode=0755\nRemoveOnStop=yes\nAccept=no\n\n[Install]\nWantedBy=sockets.target\n")
        self.path(f"{UNITS}/linux-xtu-helper.socket").write_text(old)
        r = self.ok_install()
        self.assertIn(b"SocketMode=0666", self.path(f"{UNITS}/linux-xtu-helper.socket").read_bytes())
        self.assertIn("--socket-mode 0660", r.stdout)

    def test_the_access_tool_lists_the_allowlist_users_and_group(self) -> None:
        self.ok_install(extra_env={"SUDO_USER": "alice"})
        toml = self.path("/etc/linux-xtu/helper.toml")
        toml.write_text('allow_taint_bits = [2]\n[access]\nusers = ["alice", "bob"]\ngroup = "wheel"\n')
        tool = self.path("/usr/lib/linux-xtu/linux-xtu-access")
        import subprocess
        import sys

        users = subprocess.run([sys.executable, "-I", str(tool), str(toml), "--list"], capture_output=True, text=True, cwd="/", timeout=60)
        group = subprocess.run([sys.executable, "-I", str(tool), str(toml), "--list-group"], capture_output=True, text=True, cwd="/", timeout=60)
        self.assertEqual((users.returncode, users.stdout), (0, "alice\nbob\n"))
        self.assertEqual((group.returncode, group.stdout), (0, "wheel\n"))
        self.assertEqual(toml.read_text(), 'allow_taint_bits = [2]\n[access]\nusers = ["alice", "bob"]\ngroup = "wheel"\n', "listing changes nothing")

    def test_other_modes_are_refused(self) -> None:
        for mode in ("0600", "666", "0777", ""):
            r = self.install("--socket-mode", mode)
            self.assertNotEqual(r.returncode, 0, mode)
        self.assertEqual(list(self.dest.iterdir()), [])


class DesktopEntryAndMsr(InstallCase):
    def appimage(self, name: str = "linux-xtu_0.1_amd64.AppImage") -> Path:
        path = self.tmp / "apps" / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(b"\x7fELF")
        path.chmod(0o755)
        return path

    def test_the_desktop_entry_runs_the_given_appimage_and_the_icon_is_installed(self) -> None:
        app = self.appimage()
        r = self.ok_install("--appimage", str(app))
        entry = self.path("/usr/share/applications/linux-xtu.desktop").read_text()
        self.assertIn(f"\nExec={app}\n", entry)
        self.assertIn("\nIcon=linux-xtu\n", entry)
        self.assertIn("X-Linux-XTU-Packaged=true", entry)
        self.assertNotIn("@APPIMAGE@", entry)
        self.assertEqual(self.mode("/usr/share/applications/linux-xtu.desktop"), 0o644)
        icon = self.path("/usr/share/icons/hicolor/128x128/apps/linux-xtu.png")
        self.assertEqual(icon.read_bytes(), (REPO / "packaging/linux-xtu.png").read_bytes())
        self.assertIn("desktop entry:", r.stdout)
        r = self.ok_install()
        self.assertIn("desktop entry: kept", r.stdout)
        self.assertIn(f"Exec={app}", self.path("/usr/share/applications/linux-xtu.desktop").read_text())

    def test_unsafe_or_missing_appimage_paths_are_refused_before_anything_is_written(self) -> None:
        good = self.appimage()
        spaced = self.appimage("my app.AppImage")
        for bad in ("relative/linux-xtu.AppImage", str(spaced), str(good.parent / "missing.AppImage"), f"{good.parent}/../apps/{good.name}", f"{good}%f"):
            with self.subTest(bad=bad):
                r = self.install("--appimage", bad)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("--appimage", r.stderr)
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_without_appimage_there_is_no_desktop_entry_and_a_hint(self) -> None:
        r = self.ok_install()
        self.assertFalse(os.path.lexists(self.path("/usr/share/applications")))
        self.assertIn("install.sh --appimage", r.stdout)

    def test_load_msr_writes_modules_load_d(self) -> None:
        self.ok_install("--load-msr")
        conf = self.path("/etc/modules-load.d/linux-xtu.conf")
        self.assertEqual(conf.read_bytes(), (REPO / "packaging/linux-xtu-modules.conf").read_bytes())
        self.assertIn("msr", [line.strip() for line in conf.read_text().splitlines() if not line.startswith("#")])
        self.assertEqual(self.mode("/etc/modules-load.d/linux-xtu.conf"), 0o644)


class Uninstall(InstallCase):
    def uninstall(self, *args: str):
        return self.install(*args, script=REPO / "uninstall.sh")

    def test_uninstall_removes_what_install_made_and_keeps_the_settings(self) -> None:
        app = self.tmp / "a.AppImage"
        app.write_bytes(b"x")
        self.ok_install("--enable-boot-restore", "--appimage", str(app), "--load-msr")
        r = self.uninstall()
        self.assertEqual(r.returncode, 0, quiet(r))
        for gone in (f"{UNITS}/linux-xtu-restore.service", f"{UNITS}/linux-xtu-restore.timer", WANTS, "/usr/share/applications/linux-xtu.desktop",
                     "/usr/share/icons/hicolor/128x128/apps/linux-xtu.png", "/etc/modules-load.d/linux-xtu.conf", "/usr/lib/linux-xtu"):
            self.assertFalse(os.path.lexists(self.path(gone)), gone)
        self.assertTrue(self.path("/etc/linux-xtu/restore.toml").exists())
        self.assertIn("kept", r.stdout)
        r = self.uninstall()  # idempotent
        self.assertEqual(r.returncode, 0, quiet(r))

    def test_a_foreign_restore_unit_and_a_foreign_desktop_entry_are_left_alone(self) -> None:
        self.ok_install()
        self.path(f"{UNITS}/linux-xtu-restore.service").write_text(FOREIGN_SERVICE)
        apps = self.path("/usr/share/applications")
        apps.mkdir(parents=True)
        (apps / "linux-xtu.desktop").write_text("[Desktop Entry]\nName=mine\n")
        r = self.uninstall()
        self.assertEqual(r.returncode, 0, quiet(r))
        self.assertEqual(self.path(f"{UNITS}/linux-xtu-restore.service").read_text(), FOREIGN_SERVICE)
        self.assertEqual((apps / "linux-xtu.desktop").read_text(), "[Desktop Entry]\nName=mine\n")
        self.assertIn("install.sh did not install it", r.stdout)
        self.assertFalse(os.path.lexists(self.path(f"{UNITS}/linux-xtu-restore.timer")), "the packaged timer is still removed")

    def test_purge_removes_the_boot_restore_state_and_settings_too(self) -> None:
        self.ok_install()
        self.path("/var/lib/linux-xtu/bootrestore.json").write_text('{"schema": 1, "armed": true}\n')
        r = self.uninstall("--purge", "--yes-reset-budget")
        self.assertEqual(r.returncode, 0, quiet(r))
        self.assertFalse(os.path.lexists(self.path("/var/lib/linux-xtu")))
        self.assertFalse(os.path.lexists(self.path("/etc/linux-xtu")))
