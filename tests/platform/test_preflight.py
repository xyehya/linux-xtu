"""Preflight tests (G-101): every check, every failure path, against fake roots in a temp dir. No real /proc, /sys or /dev is read."""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from linux_xtu.platform import OPTIONAL_TOOLS, Status, preflight
from linux_xtu.topology import arl_s_285k, synthetic
from tests.fakesys import add_dmi, make_sysfs, reference_like

GOOD_FLAGS = "fpu vme de pse tsc msr pae mce cx8 apic sep"


def cpuinfo(n: int = 24, *, flags: str = GOOD_FLAGS, family: int = 6, model: int = 198, stepping: int = 2,
            vendor: str = "GenuineIntel", name: str = "Intel(R) Core(TM) Ultra 9 285K") -> str:
    blocks = []
    for i in range(n):
        blocks.append(f"processor\t: {i}\nvendor_id\t: {vendor}\ncpu family\t: {family}\nmodel\t\t: {model}\nmodel name\t: {name}\n"
                      f"stepping\t: {stepping}\nflags\t\t: {flags}\n")
    return "\n".join(blocks)


class FakeRoot(unittest.TestCase):
    """setUp builds a root on which every check passes; tests then break one thing."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.write("proc/cpuinfo", cpuinfo())
        self.write("sys/kernel/security/lockdown", "[none] integrity confidentiality\n")
        reference_like(self.root / "sys")  # 8 P + 16 E, favored P0 and P3 by CPPC: the live topology the checks derive (D-036)
        add_dmi(self.root / "sys", "Z890 Steel Legend WiFi", "ASRock")
        for c in range(24):
            self.write(f"dev/cpu/{c}/msr", "")
        self.write("sys/module/msr/parameters/allow_writes", "default\n")
        self.write("proc/1/comm", "systemd\n")
        self.make_socket(0o660)
        self.write("etc/linux-xtu/helper.toml", 'allow_taint_bits = [2]\n[access]\nusers = ["alice"]\ngroup = "linux-xtu"\n')
        for tool in OPTIONAL_TOOLS:
            self.exe(f"usr/bin/{tool}")

    def make_socket(self, mode: int) -> Path:
        """A real socket node at run/linux-xtu/helper.sock of the fake root (D-043)."""
        import socket

        p = self.root / "run/linux-xtu/helper.sock"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.unlink(missing_ok=True)
        s = socket.socket(socket.AF_UNIX)
        s.bind(str(p))
        s.close()  # the node stays
        p.chmod(mode)
        return p

    def write(self, rel: str, text: str) -> Path:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return p

    def exe(self, rel: str) -> Path:
        p = self.write(rel, "#!/bin/sh\n")
        p.chmod(0o755)
        return p

    def run_pf(self, **kw):
        return preflight(self.root, **kw)

    def status(self, name: str, **kw) -> Status:
        return self.run_pf(**kw).get(name).status


class AllGoodTests(FakeRoot):
    def test_everything_passes(self):
        rep = self.run_pf(python_version=(3, 12, 1))
        self.assertEqual([r.name for r in rep.results if r.status is not Status.PASS], [])
        self.assertEqual(rep.mode, "write")
        self.assertTrue(rep.writes_allowed)
        self.assertEqual(rep.problems(), ())

    def test_check_names(self):
        names = [r.name for r in self.run_pf().results]
        self.assertEqual(names[:8], ["cpuid", "hypervisor", "lockdown", "topology", "msr_device", "msr_allow_writes", "helper_service", "python"])
        self.assertEqual(names[8:], [f"tool:{t}" for t in OPTIONAL_TOOLS])

    def test_to_dict_is_json(self):
        d = json.loads(json.dumps(self.run_pf().to_dict()))
        self.assertEqual(d["platform"], "arl-s")
        self.assertEqual(d["mode"], "write")
        self.assertEqual(d["board"], "Z890 Steel Legend WiFi")
        self.assertEqual(d["checks"][0], {"name": "cpuid", "status": "pass", "reason": d["checks"][0]["reason"]})

    def test_the_result_carries_the_live_topology_in_the_g127_shape(self):
        topo = self.run_pf().to_dict()["topology"]
        self.assertEqual(set(topo), {"units", "favored_source"})
        self.assertEqual(topo["favored_source"], "acpi_cppc")
        self.assertEqual([u["id"] for u in topo["units"]], [f"P{i}" for i in range(8)] + [f"EC{i}" for i in range(4)])
        self.assertEqual(topo["units"][0], {"id": "P0", "kind": "P", "cpus": [0], "favored": True, "max_ratio": 57, "perf": 92, "max_khz": 5_700_000, "ratio_model": "measured"})
        self.assertEqual(topo["units"][8], {"id": "EC0", "kind": "E", "cpus": [8, 9, 10, 11], "favored": False, "max_ratio": 48, "perf": 68, "max_khz": 4_900_000, "ratio_model": "measured"})
        self.assertEqual([u["id"] for u in topo["units"] if u["favored"]], ["P0", "P3"])

    def test_a_simulated_topology_is_reported_instead_of_the_real_sysfs(self):
        rep = self.run_pf(topology=synthetic(6, 8, favored_p=(1,)))
        topo = rep.to_dict()["topology"]
        self.assertEqual([u["id"] for u in topo["units"]], [f"P{i}" for i in range(6)] + ["EC0", "EC1"])
        self.assertEqual([u["id"] for u in topo["units"] if u["favored"]], ["P1"])
        self.assertEqual(rep.get("msr_device").status, Status.PASS)  # the device nodes are checked against the simulated CPU list (0..13)


    def test_default_root_argument_is_slash(self):
        import inspect
        self.assertEqual(inspect.signature(preflight).parameters["root"].default, Path("/"))

    def test_get_unknown_raises(self):
        with self.assertRaises(KeyError):
            self.run_pf().get("nope")


class CpuidTests(FakeRoot):
    def test_wrong_model(self):
        self.write("proc/cpuinfo", cpuinfo(model=183))
        r = self.run_pf().get("cpuid")
        self.assertEqual(r.status, Status.READ_ONLY)
        self.assertIn("not an Arrow Lake-S CPU", r.reason)

    def test_an_unknown_stepping_is_a_warning_not_a_refusal(self):
        self.write("proc/cpuinfo", cpuinfo(stepping=1))
        rep = self.run_pf()
        r = rep.get("cpuid")
        self.assertEqual(r.status, Status.WARN)
        self.assertIn("stepping 1", r.reason)
        self.assertEqual(rep.mode, "write")  # a warning never changes the mode
        self.assertTrue(rep.writes_allowed)
        self.assertEqual(rep.problems(), ())
        self.assertEqual(json.loads(json.dumps(rep.to_dict()))["checks"][0]["status"], "warn")

    def test_another_sku_of_the_family_passes(self):
        self.write("proc/cpuinfo", cpuinfo(n=14, name="Intel(R) Core(TM) Ultra 5 245K"))  # the name is not part of the identity
        self.assertEqual(self.status("cpuid"), Status.PASS)

    def test_wrong_vendor(self):
        self.write("proc/cpuinfo", cpuinfo(vendor="AuthenticAMD"))
        self.assertEqual(self.status("cpuid"), Status.READ_ONLY)

    def test_offline_cpus_do_not_fail_cpuid(self):
        self.write("proc/cpuinfo", cpuinfo(n=16))  # the topology check owns the CPU count
        self.assertEqual(self.status("cpuid"), Status.PASS)

    def test_one_odd_cpu_is_caught(self):
        self.write("proc/cpuinfo", cpuinfo(23) + "\n" + cpuinfo(1, model=1).replace("processor\t: 0", "processor\t: 23"))
        self.assertEqual(self.status("cpuid"), Status.READ_ONLY)

    def test_non_numeric_fields(self):
        self.write("proc/cpuinfo", cpuinfo().replace("stepping\t: 2", "stepping\t: x"))
        r = self.run_pf().get("cpuid")
        self.assertEqual(r.status, Status.READ_ONLY)
        self.assertIn("not numeric", r.reason)

    def test_missing_cpuinfo(self):
        (self.root / "proc/cpuinfo").unlink()
        rep = self.run_pf()
        self.assertEqual(rep.get("cpuid").status, Status.READ_ONLY)
        self.assertEqual(rep.get("hypervisor").status, Status.READ_ONLY)
        self.assertEqual(rep.mode, "read-only")

    def test_empty_cpuinfo(self):
        self.write("proc/cpuinfo", "")
        self.assertEqual(self.status("cpuid"), Status.READ_ONLY)


class TopologyTests(FakeRoot):
    """The identity gate is CPUID family/model plus a consistent live topology (D-036)."""

    def rebuild(self, p, e, **kw):
        shutil.rmtree(self.root / "sys/devices")
        make_sysfs(self.root / "sys", p, e, **kw)

    def test_8p_16e_passes_and_names_the_favored_cores(self):
        r = self.run_pf().get("topology")
        self.assertEqual(r.status, Status.PASS)
        self.assertIn("8 P-cores + 16 E-cores in 4 clusters of 4", r.reason)
        self.assertIn("favored by acpi_cppc: P0, P3", r.reason)

    def test_other_shapes_pass(self):
        for p, e in ((8, 12), (6, 8), (4, 8)):
            with self.subTest(p=p, e=e):
                self.rebuild(p, e)
                self.assertEqual(self.status("topology"), Status.PASS)

    def test_no_e_cores_is_read_only(self):
        (self.root / "sys/devices/cpu_atom/cpus").write_text("\n")
        r = self.run_pf().get("topology")
        self.assertEqual(r.status, Status.READ_ONLY)
        self.assertEqual(self.run_pf().mode, "read-only")

    def test_unequal_clusters_are_read_only(self):
        d = self.root / "sys/devices/system/cpu"
        for cpu in (20, 21, 22, 23):
            (d / f"cpu{cpu}/topology/cluster_cpus_list").write_text("20-21\n" if cpu < 22 else "22-23\n")
        r = self.run_pf().get("topology")
        self.assertEqual(r.status, Status.READ_ONLY)
        self.assertIn("unequal", r.reason)

    def test_missing_sysfs_files_are_read_only_with_the_reason(self):
        shutil.rmtree(self.root / "sys/devices")
        rep = self.run_pf()
        self.assertEqual(rep.get("topology").status, Status.READ_ONLY)
        self.assertIn("cpu_core", rep.get("topology").reason)
        self.assertEqual(rep.get("msr_device").status, Status.READ_ONLY)  # without a CPU list there is nothing to check the device nodes against
        self.assertEqual(rep.to_dict()["topology"], {"units": [], "favored_source": None})

    def test_all_p_cores_equal_means_no_favored_core(self):
        make_sysfs(self.root / "sys", 8, 16, perf={c: 88 for c in range(8)})
        topo = self.run_pf().to_dict()["topology"]
        self.assertIsNone(topo["favored_source"])
        self.assertFalse(any(u["favored"] for u in topo["units"]))
        self.assertIn("no favored core", self.run_pf().get("topology").reason)

    def test_the_msr_device_check_follows_the_live_cpu_list(self):
        self.rebuild(6, 8)
        for c in range(14, 24):  # a 6P+8E part only has /dev/cpu/0..13
            shutil.rmtree(self.root / f"dev/cpu/{c}")
        self.assertEqual(self.status("msr_device"), Status.PASS)
        (self.root / "dev/cpu/13/msr").unlink()
        r = self.run_pf().get("msr_device")
        self.assertEqual(r.status, Status.READ_ONLY)
        self.assertIn("/dev/cpu/13/msr", r.reason)


class BoardTests(FakeRoot):
    def test_board_name_is_reported_when_readable(self):
        self.assertEqual(self.run_pf().board, "Z890 Steel Legend WiFi")

    def test_no_dmi_means_no_board(self):
        shutil.rmtree(self.root / "sys/class")
        self.assertIsNone(self.run_pf().board)


class HypervisorTests(FakeRoot):
    def test_flag_set(self):
        self.write("proc/cpuinfo", cpuinfo(flags=GOOD_FLAGS + " hypervisor"))
        r = self.run_pf().get("hypervisor")
        self.assertEqual(r.status, Status.READ_ONLY)
        self.assertEqual(self.run_pf().mode, "read-only")

    def test_substring_does_not_count(self):
        self.write("proc/cpuinfo", cpuinfo(flags=GOOD_FLAGS + " nothypervisorx"))
        self.assertEqual(self.status("hypervisor"), Status.PASS)

    def test_no_flags_line(self):
        self.write("proc/cpuinfo", "\n".join(b.replace("flags\t\t: " + GOOD_FLAGS, "") for b in cpuinfo().split("\n\n")))
        self.assertEqual(self.status("hypervisor"), Status.READ_ONLY)


class LockdownTests(FakeRoot):
    def test_none(self):
        self.assertEqual(self.status("lockdown"), Status.PASS)

    def test_integrity(self):
        self.write("sys/kernel/security/lockdown", "none [integrity] confidentiality\n")
        r = self.run_pf().get("lockdown")
        self.assertEqual(r.status, Status.READ_ONLY)
        self.assertIn("[integrity]", r.reason)

    def test_confidentiality(self):
        self.write("sys/kernel/security/lockdown", "none integrity [confidentiality]\n")
        self.assertEqual(self.status("lockdown"), Status.READ_ONLY)

    def test_unbracketed(self):
        self.write("sys/kernel/security/lockdown", "none integrity confidentiality\n")
        self.assertEqual(self.status("lockdown"), Status.READ_ONLY)

    def test_two_brackets(self):
        self.write("sys/kernel/security/lockdown", "[none] [integrity]\n")
        self.assertEqual(self.status("lockdown"), Status.READ_ONLY)

    def test_file_absent_is_no_lockdown(self):
        (self.root / "sys/kernel/security/lockdown").unlink()
        r = self.run_pf().get("lockdown")
        self.assertEqual(r.status, Status.PASS)
        self.assertIn("without the lockdown LSM", r.reason)

    @unittest.skipIf(os.geteuid() == 0, "root ignores file modes")
    def test_unreadable(self):
        p = self.root / "sys/kernel/security/lockdown"
        p.chmod(0)
        self.addCleanup(p.chmod, 0o644)
        self.assertEqual(self.status("lockdown"), Status.READ_ONLY)


class MsrTests(FakeRoot):
    def test_device_missing_one_cpu(self):
        (self.root / "dev/cpu/5/msr").unlink()
        r = self.run_pf().get("msr_device")
        self.assertEqual(r.status, Status.READ_ONLY)
        self.assertIn("/dev/cpu/5/msr", r.reason)

    def test_device_missing_all_module_not_found(self):
        shutil.rmtree(self.root / "dev")
        shutil.rmtree(self.root / "sys/module")
        r = self.run_pf().get("msr_device")
        self.assertEqual(r.status, Status.READ_ONLY)
        self.assertIn("neither loaded, built in nor found", r.reason)

    def test_device_missing_module_loadable(self):
        shutil.rmtree(self.root / "dev")
        shutil.rmtree(self.root / "sys/module")
        self.write("proc/sys/kernel/osrelease", "7.2.9-200.fc44.x86_64\n")
        self.write("lib/modules/7.2.9-200.fc44.x86_64/kernel/arch/x86/kernel/msr.ko.xz", "")
        r = self.run_pf().get("msr_device")
        self.assertEqual(r.status, Status.READ_ONLY)
        self.assertIn("loadable", r.reason)

    def test_device_missing_module_loaded(self):
        shutil.rmtree(self.root / "dev")  # /sys/module/msr still exists (from setUp)
        self.assertIn("loaded or built in", self.run_pf().get("msr_device").reason)

    def test_osrelease_with_slash_is_not_followed(self):
        shutil.rmtree(self.root / "dev")
        shutil.rmtree(self.root / "sys/module")
        self.write("proc/sys/kernel/osrelease", "../../x\n")
        self.assertIn("neither", self.run_pf().get("msr_device").reason)

    def test_allow_writes_off(self):
        self.write("sys/module/msr/parameters/allow_writes", "off\n")
        r = self.run_pf().get("msr_allow_writes")
        self.assertEqual(r.status, Status.READ_ONLY)
        self.assertIn("off", r.reason)

    def test_allow_writes_on(self):
        self.write("sys/module/msr/parameters/allow_writes", "on\n")
        self.assertEqual(self.status("msr_allow_writes"), Status.PASS)

    def test_allow_writes_garbage(self):
        self.write("sys/module/msr/parameters/allow_writes", "banana\n")
        self.assertEqual(self.status("msr_allow_writes"), Status.READ_ONLY)

    def test_allow_writes_param_absent_but_module_present(self):
        (self.root / "sys/module/msr/parameters/allow_writes").unlink()
        self.assertEqual(self.status("msr_allow_writes"), Status.PASS)

    def test_allow_writes_module_absent(self):
        shutil.rmtree(self.root / "sys/module")
        r = self.run_pf().get("msr_allow_writes")
        self.assertEqual(r.status, Status.READ_ONLY)

    @unittest.skipIf(os.geteuid() == 0, "root ignores file modes")
    def test_allow_writes_unreadable(self):
        p = self.root / "sys/module/msr/parameters/allow_writes"
        p.chmod(0)
        self.addCleanup(p.chmod, 0o644)
        r = self.run_pf().get("msr_allow_writes")
        self.assertEqual(r.status, Status.UNKNOWN)  # 0600 file: an unprivileged run must not call the machine read-only
        self.assertIn("root-only", r.reason)
        self.assertEqual(self.run_pf().mode, "write")


class HelperServiceTests(FakeRoot):
    """D-043: the helper is a service on /run/linux-xtu/helper.sock; no pkexec, no polkit, no agent are looked for."""

    def test_no_polkit_checks_exist(self):
        names = [r.name for r in self.run_pf().results]
        self.assertFalse([n for n in names if "polkit" in n or "pkexec" in n])

    def test_passes_with_a_root_only_socket_and_an_allowlist(self):
        r = self.run_pf().get("helper_service")
        self.assertEqual(r.status, Status.PASS)
        self.assertIn("alice", r.reason)
        self.assertIn("group linux-xtu", r.reason)

    def test_the_socket_is_missing(self):
        (self.root / "run/linux-xtu/helper.sock").unlink()
        r = self.run_pf().get("helper_service")
        self.assertEqual(r.status, Status.READ_ONLY)
        self.assertIn("run install.sh", r.reason)
        self.assertEqual(self.run_pf().mode, "read-only")

    def test_not_a_socket(self):
        p = self.root / "run/linux-xtu/helper.sock"
        p.unlink()
        p.write_text("")
        r = self.run_pf().get("helper_service")
        self.assertEqual((r.status, r.reason), (Status.READ_ONLY, "/run/linux-xtu/helper.sock is not a socket"))

    def test_the_socket_mode_is_not_judged_0666_and_0660_both_pass(self):
        """D-043 amendment: the peer check is the gate; 0666 is the shipped mode, 0660 an operator's choice."""
        for mode in (0o666, 0o660, 0o600):
            with self.subTest(mode=oct(mode)):
                self.make_socket(mode)
                r = self.run_pf().get("helper_service")
                self.assertEqual(r.status, Status.PASS)
                self.assertIn(f"{mode:04o}", r.reason)

    def test_helper_toml_missing_or_without_an_allowlist_or_broken(self):
        cases = {"missing": None, "no access": "allow_taint_bits = [2]\n", "empty": "[access]\nusers = []\n", "broken": "[access\n", "unknown key": "[access]\nusr = [\"a\"]\n"}
        for label, text in cases.items():
            with self.subTest(label):
                p = self.root / "etc/linux-xtu/helper.toml"
                p.unlink()
                if text is not None:
                    self.write("etc/linux-xtu/helper.toml", text)
                r = self.run_pf().get("helper_service")
                self.assertEqual(r.status, Status.READ_ONLY)
                self.assertIn("helper.toml", r.reason)
                self.write("etc/linux-xtu/helper.toml", '[access]\nusers = ["alice"]\n')

    def test_users_only_or_group_only_are_both_fine(self):
        for text in ('[access]\nusers = ["alice"]\n', '[access]\ngroup = "linux-xtu"\n'):
            self.write("etc/linux-xtu/helper.toml", text)
            self.assertEqual(self.status("helper_service"), Status.PASS)

    def test_not_applicable_for_a_simulator_or_stdio_helper(self):
        (self.root / "run/linux-xtu/helper.sock").unlink()
        r = self.run_pf(helper_service=False).get("helper_service")
        self.assertEqual(r.status, Status.PASS)
        self.assertIn("not applicable", r.reason)
        self.assertEqual(self.run_pf(helper_service=False).mode, "write")


class PythonTests(FakeRoot):
    def test_old_python_refuses(self):
        rep = self.run_pf(python_version=(3, 11, 9))
        self.assertEqual(rep.get("python").status, Status.REFUSE)
        self.assertEqual(rep.mode, "refuse")
        self.assertTrue(rep.refused)
        self.assertFalse(rep.writes_allowed)

    def test_exact_minimum_passes(self):
        self.assertEqual(self.status("python", python_version=(3, 12, 0)), Status.PASS)

    def test_newer_passes(self):
        self.assertEqual(self.status("python", python_version=(3, 14, 1)), Status.PASS)

    def test_refuse_outranks_read_only(self):
        self.write("sys/kernel/security/lockdown", "none [integrity] confidentiality\n")
        self.assertEqual(self.run_pf(python_version=(3, 10, 0)).mode, "refuse")

    def test_running_interpreter_default(self):
        self.assertEqual(self.status("python"), Status.PASS)  # the suite itself needs >= 3.12


class ToolTests(FakeRoot):
    def test_missing_tool_reports_package(self):
        (self.root / "usr/bin/stress-ng").unlink()
        rep = self.run_pf()
        r = rep.get("tool:stress-ng")
        self.assertEqual(r.status, Status.MISSING)
        self.assertEqual(r.reason, "missing: install stress-ng")
        self.assertEqual(rep.mode, "write")  # optional tools never change the mode

    def test_every_tool_checked(self):
        for tool in OPTIONAL_TOOLS:
            (self.root / f"usr/bin/{tool}").unlink()
        rep = self.run_pf()
        for tool in OPTIONAL_TOOLS:
            self.assertEqual(rep.get(f"tool:{tool}").status, Status.MISSING)
        self.assertEqual(set(OPTIONAL_TOOLS), {"stress-ng", "stressapptest", "perf", "turbostat", "sensors", "nvidia-smi"})

    def test_custom_tool_list(self):
        rep = self.run_pf(tools={"foo": "foo-pkg"})
        self.assertEqual(rep.get("tool:foo").reason, "missing: install foo-pkg")
        with self.assertRaises(KeyError):
            rep.get("tool:perf")

    def test_sbin_tool_found(self):
        (self.root / "usr/bin/perf").unlink()
        self.exe("usr/sbin/perf")
        self.assertEqual(self.status("tool:perf"), Status.PASS)


class ModeTests(FakeRoot):
    def test_any_read_only_gives_read_only(self):
        self.write("proc/cpuinfo", cpuinfo(flags=GOOD_FLAGS + " hypervisor"))
        rep = self.run_pf()
        self.assertEqual(rep.mode, "read-only")
        self.assertEqual([r.name for r in rep.problems()], ["hypervisor"])

    def test_every_failure_reason_is_nonempty(self):
        shutil.rmtree(self.root / "proc")
        shutil.rmtree(self.root / "dev")
        shutil.rmtree(self.root / "sys")
        rep = self.run_pf(python_version=(3, 8, 0))
        for r in rep.results:
            self.assertTrue(r.reason, r.name)
        self.assertEqual(rep.mode, "refuse")

class BootRestoreTests(FakeRoot):
    """QA-35: the preflight reports the boot restore as not_installed / disarmed / armed (/ unknown), read-only, with a fake systemctl."""

    def unit(self):
        self.write("etc/systemd/system/linux-xtu-restore.timer", "[Timer]\nOnBootSec=30s\n")

    def state(self, armed, **extra):
        self.write("var/lib/linux-xtu/bootrestore.json", json.dumps({"schema": 1, "armed": armed, **extra}))

    @staticmethod
    def sc(word, rc=0):
        calls = []

        def fake(args):
            calls.append(list(args))
            return rc, word + "\n"
        fake.calls = calls
        return fake

    def test_report_always_carries_the_field(self):
        d = self.run_pf().to_dict()
        self.assertEqual(d["boot_restore"]["state"], "not_installed")
        self.assertTrue(d["boot_restore"]["note"])

    def test_not_installed_without_a_unit(self):
        fake = self.sc("enabled")
        self.assertEqual(self.run_pf(systemctl=fake).boot_restore["state"], "not_installed")
        self.assertEqual(fake.calls, [])  # nothing asked when there is no unit

    def test_disarmed_when_the_timer_is_disabled_names_the_enable_command(self):
        self.unit()
        fake = self.sc("disabled", 1)
        br = self.run_pf(systemctl=fake).boot_restore
        self.assertEqual(br["state"], "disarmed")
        self.assertIn("sudo systemctl enable linux-xtu-restore.timer", br["note"])
        self.assertEqual(fake.calls, [["is-enabled", "linux-xtu-restore.timer"]])  # read-only query only

    def test_disarmed_when_enabled_but_state_not_armed(self):
        self.unit()
        self.state(False, disarmed={"reason": "machine check seen"})
        br = self.run_pf(systemctl=self.sc("enabled")).boot_restore
        self.assertEqual(br["state"], "disarmed")
        self.assertIn("machine check seen", br["note"])
        self.assertIn("linux-xtu-restore arm", br["note"])

    def test_disarmed_when_enabled_and_never_armed(self):
        self.unit()
        self.assertEqual(self.run_pf(systemctl=self.sc("enabled")).boot_restore["state"], "disarmed")

    def test_armed_needs_enabled_timer_and_armed_state(self):
        self.unit()
        self.state(True, accepted={"name": "qa-20261112", "sha256": "ab"})
        br = self.run_pf(systemctl=self.sc("enabled")).boot_restore
        self.assertEqual(br["state"], "armed")
        self.assertIn("qa-20261112", br["note"])
        # armed in the state file but the timer is off: not armed
        self.assertEqual(self.run_pf(systemctl=self.sc("disabled", 1)).boot_restore["state"], "disarmed")

    def test_masked_unit_is_disarmed_without_asking(self):
        d = self.root / "etc/systemd/system"
        d.mkdir(parents=True, exist_ok=True)
        os.symlink("/dev/null", d / "linux-xtu-restore.timer")
        fake = self.sc("enabled")
        self.assertEqual(self.run_pf(systemctl=fake).boot_restore["state"], "disarmed")

    def test_unknown_when_systemctl_fails_closed(self):
        self.unit()
        self.state(True)
        self.assertEqual(self.run_pf(systemctl=lambda a: None).boot_restore["state"], "unknown")
        self.assertEqual(self.run_pf(systemctl=self.sc("???", 1)).boot_restore["state"], "unknown")

        def boom(args):
            raise RuntimeError("no dbus")
        self.assertEqual(self.run_pf(systemctl=boom).boot_restore["state"], "unknown")

    def test_wants_link_is_enough_when_systemctl_gives_nothing(self):
        self.unit()
        self.state(True)
        w = self.root / "etc/systemd/system/timers.target.wants"
        w.mkdir(parents=True)
        os.symlink("../linux-xtu-restore.timer", w / "linux-xtu-restore.timer")
        self.assertEqual(self.run_pf(systemctl=lambda a: None).boot_restore["state"], "armed")

    def test_fake_root_without_systemctl_uses_the_files(self):
        self.unit()
        self.state(True)
        self.assertEqual(self.run_pf().boot_restore["state"], "disarmed")  # no wants link = not enabled
        w = self.root / "etc/systemd/system/timers.target.wants"
        w.mkdir(parents=True)
        os.symlink("../linux-xtu-restore.timer", w / "linux-xtu-restore.timer")
        self.assertEqual(self.run_pf().boot_restore["state"], "armed")

    def test_real_systemctl_runner_is_an_argument_list_with_a_timeout(self):
        from unittest import mock

        import importlib

        pf = importlib.import_module("linux_xtu.platform.preflight")

        with mock.patch.object(pf.os, "access", return_value=True), mock.patch.object(pf.subprocess, "run") as run:
            run.return_value = mock.Mock(returncode=0, stdout="enabled\n")
            self.assertEqual(pf._real_systemctl(["is-enabled", "linux-xtu-restore.timer"]), (0, "enabled\n"))
        args, kw = run.call_args
        self.assertEqual(args[0], ["/usr/bin/systemctl", "is-enabled", "linux-xtu-restore.timer"])
        self.assertIn("timeout", kw)
        self.assertFalse(kw.get("shell", False))
        with mock.patch.object(pf.os, "access", return_value=True), mock.patch.object(pf.subprocess, "run", side_effect=pf.subprocess.TimeoutExpired("x", 5)):
            self.assertIsNone(pf._real_systemctl(["is-enabled", "x"]))


if __name__ == "__main__":
    unittest.main()
