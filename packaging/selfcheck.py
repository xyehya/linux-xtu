"""Post-install trust self-check (G-106, D-043). Installed as ``/usr/lib/linux-xtu/linux-xtu-selfcheck`` and run by ``install.sh`` as
``python3 -I /usr/lib/linux-xtu/linux-xtu-selfcheck`` - i.e. from the installed, root-owned tree, never from the checkout.

It asks the question the root helper will ask at start-up (SPEC 4.4): is everything it will load or open root-owned, not group/world-writable,
free of symlinks, with root-owned parents? It reuses ``linux_xtu.helper.trust`` (the helper's own checks) and adds what only the install can know:
the launchers (helper, boot restore, CLI) are executable and are the packaged ones, the systemd socket + service units are present and pin the launcher and the
socket's owner / mode (0660 with a group that exists, D-053 item 4, or 0666; the peer check is the gate), the service's hardening leaves the helper its
devices, sysfs and state directories, the boot restore units (when installed) are the packaged ones, no drop-in overrides any of them, no polkit action file is
left over from the old install, ``helper.toml`` has an ``[access]`` that admits somebody, the audit log is 0600.
Pure over injectable ``lstat_fn`` / ``listdir_fn`` / ``read_fn`` / ``root_uid`` / ``getgrnam_fn``: tests feed fake stat results. Exit 0: all checks passed;
1: at least one failed (each is named); the install is then NOT usable and ``uninstall.sh`` removes it.
"""
from __future__ import annotations

import grp
import hashlib
import os
import re
import stat
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

CODE_DIR = Path("/usr/lib/linux-xtu")
HELPER = CODE_DIR / "linux-xtu-helper"
SELFCHECK = CODE_DIR / "linux-xtu-selfcheck"
OLD_POLKIT_FILE = Path("/usr/share/polkit-1/actions/io.github.arrowlake-tuner.helper.policy")  # the G-106 install's action: must be gone (D-043)
UNIT_DIRS = (Path("/etc/systemd/system"), Path("/usr/lib/systemd/system"))  # install.sh uses the first; a distribution package may use the second
SOCKET_UNIT, SERVICE_UNIT = "linux-xtu-helper.socket", "linux-xtu-helper.service"
RESTORE_SERVICE, RESTORE_TIMER = "linux-xtu-restore.service", "linux-xtu-restore.timer"  # the boot restore (D-053 item 3): optional, but if present the packaged ones
RESTORE = CODE_DIR / "linux-xtu-restore"
CLI = CODE_DIR / "linux-xtu-cli"
RESTORE_EXEC_START = f"/usr/bin/python3 -I {RESTORE} run"
PACKAGED_MARK = b"# linux-xtu: packaged unit"  # the first line of every unit file install.sh owns
SOCKET_GROUP_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_-]{0,31}")
# Where systemd looks for overrides of a unit: <dir>/<unit>.d/*.conf. Any file there could change ExecStart or the socket's mode, so none is accepted.
DROPIN_BASES = tuple(Path(p) for p in ("/etc/systemd/system", "/etc/systemd/system.control", "/run/systemd/system", "/run/systemd/system.control", "/usr/lib/systemd/system"))
SOCKET_PATH = Path("/run/linux-xtu/helper.sock")
EXEC_START = f"/usr/bin/python3 -I {HELPER} --device --socket"
TMPFILES_FILE = Path("/usr/lib/tmpfiles.d/linux-xtu.conf")
ETC_DIR = Path("/etc/linux-xtu")
STATE_DIR = Path("/var/lib/linux-xtu")
RUN_DIR = Path("/run/linux-xtu")
LAUNCHER_SHA256 = "7f7eeccda208e44e96e66a864af301e4d4815f81895d80b7d508ee0fc6de9b1c"  # sha256 of packaging/linux-xtu-helper (a test keeps the two in step)
RESTORE_SHA256 = "92ef8e4935449623b211cdcce381d3d164f2e54c0cd5762e76f5f975cd517387"  # sha256 of packaging/linux-xtu-restore (a test keeps the two in step)
CLI_SHA256 = "92e5b4fa2e40506f32d96cd109706575dfa18e2768c2e5f9915feca51a572546"  # sha256 of packaging/linux-xtu-cli (a test keeps the two in step)
LAUNCHER_SHEBANG = b"#!/usr/bin/python3 -I"
# Staging leftovers of an interrupted install (swap_dir / seeding): "<name>.old.<pid>", "<name>.new.<pid>", ".accepted.new.<pid>", ".tmp.<pid>", ".audit.new.<pid>"
LEFTOVER = re.compile(r"(^|.*\.)(old|new)\.\d+$|^\.(tmp|audit\.new|accepted\.new)\.\d+$")
# [Service] settings that would break the helper's MSR / cpufreq / state access (or change who it runs as / what it runs): none may appear.
# ProtectClock implies DeviceAllow=char-rtc, which closes every other device node (/dev/cpu/*/msr, /dev/mem) [DOC systemd.exec(5), systemd.resource-control(5)].
FORBIDDEN_SERVICE_KEYS = (
    "User", "Group", "DynamicUser", "ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost", "ExecReload", "Environment", "EnvironmentFile",
    "PrivateDevices", "ProtectKernelTunables", "ProtectClock", "ReadOnlyPaths", "InaccessiblePaths", "BindPaths", "BindReadOnlyPaths", "DeviceAllow", "DevicePolicy",
    "TemporaryFileSystem", "RootDirectory", "RootImage", "PrivateUsers",
)
# ProtectSystem=strict makes everything read-only but these (the helper writes the accepted state, the audit log / stores, the lock / journals).
HELPER_RW_PATHS = ("/etc/linux-xtu", "/var/lib/linux-xtu", "/run/linux-xtu")
RESTORE_RW_PATHS = ("/var/lib/linux-xtu", "/run/linux-xtu")
SOCKET_KEYS_ALLOWED = {"ListenStream", "SocketUser", "SocketGroup", "SocketMode", "DirectoryMode", "RemoveOnStop", "Accept", "Service", "Backlog"}

Result = tuple[str, str | None]  # (what was checked, None = ok / the reason it failed)


def _read(path: Path) -> bytes:
    with open(path, "rb") as fh:
        return fh.read(1 << 20)


def unit_sections(data: bytes) -> dict[str, dict[str, list[str]]]:
    """A systemd unit file as ``{section: {key: [values...]}}`` (comments and blank lines dropped; a repeated key keeps every value, in order).
    ``ValueError`` for a line that is neither a section header, a comment nor ``key=value``."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"not valid UTF-8: {exc}") from None
    out: dict[str, dict[str, list[str]]] = {}
    section: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line[0] in "#;":
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            out.setdefault(section, {})
        elif section is not None and "=" in line:
            key, _, value = line.partition("=")
            out[section].setdefault(key.strip(), []).append(value.strip())
        else:
            raise ValueError(f"unparsable line {raw!r}")
    return out


def socket_group(data: bytes) -> str | None:
    """The ``SocketGroup=`` of a socket unit (``None``: none)."""
    values = (unit_sections(data).get("Socket") or {}).get("SocketGroup")
    return values[-1] if values else None


def check_socket_unit_text(data: bytes) -> None:
    """``ValueError`` unless the socket unit listens on exactly ``/run/linux-xtu/helper.sock``, owned by root, mode 0660 with one non-root ``SocketGroup`` (D-053
    item 4, the default) or 0666 (D-043 amendment; a group is then optional), and does not hand each connection to its own service instance (``Accept=no``).
    The helper's peer check is the gate either way; preflight accepts the same two modes."""
    sock = unit_sections(data).get("Socket")
    if sock is None:
        raise ValueError("no [Socket] section")
    for key, want in (("ListenStream", [str(SOCKET_PATH)]), ("SocketUser", ["root"])):
        if sock.get(key) != want:
            raise ValueError(f"{key} is {sock.get(key)}, must be exactly {want}")
    if sock.get("SocketMode") not in (["0666"], ["0660"]):
        raise ValueError(f"SocketMode is {sock.get('SocketMode')}, must be exactly ['0660'] (with a SocketGroup) or ['0666']")
    group = sock.get("SocketGroup")
    if group is not None and (len(group) != 1 or not SOCKET_GROUP_RE.fullmatch(group[0]) or group[0] == "root"):
        raise ValueError(f"SocketGroup is {group}, must be one plain group name other than root")
    if sock.get("SocketMode") == ["0660"] and group is None:
        raise ValueError("SocketMode 0660 needs a SocketGroup (without one only root could connect)")
    if sock.get("Accept", ["no"]) != ["no"]:
        raise ValueError(f"Accept is {sock.get('Accept')}, must be no (the helper serves its one client itself)")
    extra = sorted(set(sock) - SOCKET_KEYS_ALLOWED)
    if extra:
        raise ValueError(f"unexpected [Socket] setting(s) {extra}")


def check_service_unit_text(data: bytes) -> None:
    """``ValueError`` unless the service runs exactly the pinned command as root, and none of the settings that would break MSR / sysfs access (or change the
    command or the user) is present."""
    svc = unit_sections(data).get("Service")
    if svc is None:
        raise ValueError("no [Service] section")
    if svc.get("ExecStart") != [EXEC_START]:
        raise ValueError(f"ExecStart is {svc.get('ExecStart')}, must be exactly [{EXEC_START!r}]")
    if svc.get("Type", ["simple"]) != ["simple"]:
        raise ValueError(f"Type is {svc.get('Type')}, must be simple")
    present = [k for k in FORBIDDEN_SERVICE_KEYS if k in svc]
    if present:
        raise ValueError(f"{present} must not be set in [Service]: the helper runs exactly the pinned command, as root, with access to MSRs / sysfs / its state")
    _check_hardening(svc, HELPER_RW_PATHS)


def _check_hardening(svc: dict[str, list[str]], rw_paths: tuple[str, ...]) -> None:
    """``ProtectSystem`` keeps the state directories writable (``strict``: all of ``rw_paths`` in ``ReadWritePaths``; ``full`` / ``yes``: the ``/etc`` one), and
    ``ProtectHome`` is not ``read-only`` (a read-only ``/run/user/<uid>`` would be handed to a stress child as its workdir)."""
    mode = svc.get("ProtectSystem", ["no"])[-1]
    writable = {path.lstrip("-") for value in svc.get("ReadWritePaths", []) for path in value.split()}
    if mode == "strict":
        need = rw_paths
    elif mode in ("full", "yes", "true"):
        need = tuple(p for p in rw_paths if p.startswith("/etc/"))
    elif mode in ("no", "false"):
        need = ()
    else:
        raise ValueError(f"ProtectSystem={mode!r} is not one of strict / full / yes / no")
    missing = [p for p in need if p not in writable]
    if missing:
        raise ValueError(f"ProtectSystem={mode} without ReadWritePaths for {missing}: the state there could not be written")
    if svc.get("ProtectHome", ["no"])[-1] == "read-only":
        raise ValueError("ProtectHome=read-only would hand a stress child an unwritable /run/user/<uid>; use yes (the workdir then comes from /tmp)")


def check_restore_service_text(data: bytes) -> None:
    """``ValueError`` unless ``linux-xtu-restore.service`` is the packaged unit: our mark on the first line, exactly ``python3 -I /usr/lib/linux-xtu/linux-xtu-restore run``
    as root, ``Type=exec``, no [Install] (only the timer starts it), nothing that changes the command or the user or closes the MSR devices / sysfs."""
    if not data.startswith(PACKAGED_MARK):
        raise ValueError(f"not the packaged unit (its first line does not start with {PACKAGED_MARK.decode()!r}): an out-of-repo boot restore runs other code as root at every boot "
                         "(assessment 06 F1); replace it: sudo bash install.sh --replace-boot-restore")
    sections = unit_sections(data)
    svc = sections.get("Service")
    if svc is None:
        raise ValueError("no [Service] section")
    if svc.get("ExecStart") != [RESTORE_EXEC_START]:
        raise ValueError(f"ExecStart is {svc.get('ExecStart')}, must be exactly [{RESTORE_EXEC_START!r}]")
    if svc.get("Type") != ["exec"]:
        raise ValueError(f"Type is {svc.get('Type')}, must be exec (it stays until the clean marker)")
    present = [k for k in FORBIDDEN_SERVICE_KEYS if k in svc]
    if present:
        raise ValueError(f"{present} must not be set in [Service] of the boot restore")
    if "Install" in sections:
        raise ValueError("the boot restore service has an [Install] section: only linux-xtu-restore.timer may start it")
    _check_hardening(svc, RESTORE_RW_PATHS)


def check_restore_timer_text(data: bytes) -> None:
    """``ValueError`` unless ``linux-xtu-restore.timer`` is the packaged one: our mark, it starts only ``linux-xtu-restore.service``, once per boot (``OnBootSec``)."""
    if not data.startswith(PACKAGED_MARK):
        raise ValueError(f"not the packaged unit (its first line does not start with {PACKAGED_MARK.decode()!r}): replace it: sudo bash install.sh --replace-boot-restore")
    timer = unit_sections(data).get("Timer")
    if timer is None:
        raise ValueError("no [Timer] section")
    if timer.get("Unit", [RESTORE_SERVICE]) != [RESTORE_SERVICE]:
        raise ValueError(f"Unit is {timer.get('Unit')}, must be {RESTORE_SERVICE}")
    extra = sorted(set(timer) - {"OnBootSec", "AccuracySec", "Unit", "RandomizedDelaySec"})
    if extra or "OnBootSec" not in timer:
        raise ValueError(f"the boot restore timer must fire once per boot (OnBootSec only); found {sorted(timer)}")


def check_no_dropins(listdir_fn: Callable[[str], list[str]]) -> None:
    """``ValueError`` if a drop-in directory of a helper or boot restore unit exists and is not empty (an empty or absent one overrides nothing)."""
    found = []
    for base in DROPIN_BASES:
        for unit in (SOCKET_UNIT, SERVICE_UNIT, RESTORE_SERVICE, RESTORE_TIMER):
            directory = base / f"{unit}.d"
            try:
                names = listdir_fn(str(directory))
            except FileNotFoundError:
                continue
            except NotADirectoryError:
                found.append(f"{directory} (not a directory)")
                continue
            except OSError as exc:
                found.append(f"{directory} (unreadable: {exc.strerror or exc})")
                continue
            if names:
                found.append(f"{directory}: {sorted(names)}")
    if found:
        raise ValueError(f"systemd drop-ins override the helper / boot restore units (they could change ExecStart or the socket's mode): {found}")


def _present(lstat_fn: Callable[[str], Any], p: Path) -> bool:
    try:
        lstat_fn(str(p))
    except OSError:
        return False
    return True


def check_old_polkit_gone(lstat_fn: Callable[[str], Any]) -> None:
    try:
        lstat_fn(str(OLD_POLKIT_FILE))
    except FileNotFoundError:
        return
    raise ValueError(f"{OLD_POLKIT_FILE} is still installed: the old polkit action must be removed (the helper is a socket service now)")


def selfcheck(
    *,
    lstat_fn: Callable[[str], Any] = os.lstat,
    listdir_fn: Callable[[str], list[str]] = os.listdir,
    read_fn: Callable[[Path], bytes] = _read,
    root_uid: int = 0,
    getgrnam_fn: Callable[[str], Any] = grp.getgrnam,
) -> list[Result]:
    from linux_xtu.helper.trust import TrustError, check_code_tree, check_trusted_path

    results: list[Result] = []

    def run(label: str, fn: Callable[[], None]) -> None:
        try:
            fn()
        except (TrustError, ValueError, OSError) as exc:
            results.append((label, str(exc)))
        else:
            results.append((label, None))

    def path(label: str, p: Path, *, want: str = "file", must_exist: bool = True) -> None:
        run(label, lambda: check_trusted_path(p, want=want, must_exist=must_exist, lstat_fn=lstat_fn, root_uid=root_uid))

    def tree(label: str, p: Path) -> None:
        run(label, lambda: check_code_tree(p, lstat_fn=lstat_fn, listdir_fn=listdir_fn, root_uid=root_uid))

    def tree_if_present(label: str, p: Path) -> None:
        """D-036: the accepted state is the user's and a fresh install has none; when it is there it is checked like any trusted tree."""
        try:
            lstat_fn(str(p))
        except FileNotFoundError:
            results.append((label, None))
            return
        except OSError:
            pass  # unreadable parent or the like: let the tree check report it
        tree(label, p)

    def mode_check(label: str, p: Path, *, executable: bool = False, private: bool = False) -> None:
        def go() -> None:
            st = lstat_fn(str(p))
            if executable and not st.st_mode & stat.S_IXUSR:
                raise ValueError(f"{p} is not executable")
            if private and st.st_mode & 0o077:
                raise ValueError(f"{p} mode {stat.S_IMODE(st.st_mode):04o} must be 0600")

        run(label, go)

    tree("code tree /usr/lib/linux-xtu (top level, linux-xtu/, platforms/, every dir and file, __pycache__ included)", CODE_DIR)
    path("helper launcher", HELPER)
    mode_check("helper launcher is executable", HELPER, executable=True)

    def launcher_content() -> None:
        data = read_fn(HELPER)
        if data.split(b"\n", 1)[0] != LAUNCHER_SHEBANG:
            raise ValueError(f"shebang must be exactly {LAUNCHER_SHEBANG.decode()!r}")
        if hashlib.sha256(data).hexdigest() != LAUNCHER_SHA256:
            raise ValueError("content differs from the packaged launcher (sha256 mismatch)")

    if results[-2][1] is None:  # read only after the launcher passed the trust check
        run("helper launcher content = packaged launcher, isolated-python shebang", launcher_content)
    path("self-check script", SELFCHECK)

    def pinned(label: str, p: Path, sha: str) -> None:
        """Another root launcher of the installed tree (boot restore, CLI): trusted, executable, exactly the packaged file."""
        path(label, p)
        if results[-1][1] is not None:
            return
        mode_check(f"{label} is executable", p, executable=True)

        def content() -> None:
            data = read_fn(p)
            if data.split(b"\n", 1)[0] != LAUNCHER_SHEBANG:
                raise ValueError(f"shebang must be exactly {LAUNCHER_SHEBANG.decode()!r}")
            if hashlib.sha256(data).hexdigest() != sha:
                raise ValueError("content differs from the packaged launcher (sha256 mismatch)")

        run(f"{label} content = packaged launcher, isolated-python shebang", content)

    pinned("boot restore launcher", RESTORE, RESTORE_SHA256)
    pinned("CLI launcher", CLI, CLI_SHA256)

    def unit(label: str, name: str, content_check: Callable[[bytes], None]) -> None:
        """The first unit directory that has the file: trusted path, then (only then) pinned content."""
        found = None
        for directory in UNIT_DIRS:
            try:
                lstat_fn(str(directory / name))
            except OSError:
                continue
            found = directory / name
            break
        if found is None:
            results.append((label, f"{name} is in none of {[str(d) for d in UNIT_DIRS]}"))
            return
        path(label, found)
        if results[-1][1] is None:
            run(f"{label}: content", lambda: content_check(read_fn(found)))

    before = len(results)
    unit("systemd socket unit linux-xtu-helper.socket", SOCKET_UNIT, check_socket_unit_text)
    socket_ok = all(why is None for _, why in results[before:])
    unit("systemd service unit linux-xtu-helper.service", SERVICE_UNIT, check_service_unit_text)
    socket_file = next((d / SOCKET_UNIT for d in UNIT_DIRS if _present(lstat_fn, d / SOCKET_UNIT)), None)
    if socket_file is not None and socket_ok:  # the socket unit passed: its group must exist, or systemd cannot create the node

        def group_exists() -> None:
            group = socket_group(read_fn(socket_file))
            if group is None:
                return
            try:
                getgrnam_fn(group)
            except KeyError:
                raise ValueError(f"the socket's group {group!r} does not exist (install.sh creates it: groupadd --system {group})") from None

        run("the helper socket's group exists", group_exists)
    for name, check in ((RESTORE_SERVICE, check_restore_service_text), (RESTORE_TIMER, check_restore_timer_text)):
        if any(_present(lstat_fn, d / name) for d in UNIT_DIRS):  # optional: a helper-only install has none
            unit(f"boot restore unit {name}", name, check)

    run("no systemd drop-ins for the helper units", lambda: check_no_dropins(listdir_fn))
    run("no old polkit action file", lambda: check_old_polkit_gone(lstat_fn))
    path("tmpfiles.d file", TMPFILES_FILE)
    path("policy /etc/linux-xtu/policy.toml", ETC_DIR / "policy.toml")
    path("helper.toml", ETC_DIR / "helper.toml")
    if results[-1][1] is None:  # content is parsed only after the file itself passed the trust check

        def access_nonempty() -> None:
            from linux_xtu.helper.settings import parse_helper_toml

            where = str(ETC_DIR / "helper.toml")
            if parse_helper_toml(read_fn(ETC_DIR / "helper.toml").decode("utf-8", "replace"), where).access.empty:
                raise ValueError("no [access] users or group: nobody may use the helper (sudo bash install.sh --add-user NAME)")

        run("helper.toml is valid and its [access] admits somebody", access_nonempty)
    tree_if_present("accepted state /etc/linux-xtu/accepted (optional: absent until the user saves one)", ETC_DIR / "accepted")
    path("boot restore config /etc/linux-xtu/restore.toml (may be absent)", ETC_DIR / "restore.toml", must_exist=False)
    path("state dir /var/lib/linux-xtu", STATE_DIR, want="dir")
    path("audit log (may be absent)", STATE_DIR / "audit.jsonl", must_exist=False)
    path("boot restore state (may be absent)", STATE_DIR / "bootrestore.json", must_exist=False)

    def audit_mode() -> None:
        try:
            st = lstat_fn(str(STATE_DIR / "audit.jsonl"))
        except FileNotFoundError:
            return
        if st.st_mode & 0o077:
            raise ValueError(f"{STATE_DIR / 'audit.jsonl'} mode {stat.S_IMODE(st.st_mode):04o} must be 0600")

    run("audit log mode 0600", audit_mode)
    path("run dir /run/linux-xtu (tmpfiles.d)", RUN_DIR, want="dir")

    def leftovers() -> None:
        found = []
        for directory, only_prefixed in ((CODE_DIR.parent, True), (ETC_DIR, False), (STATE_DIR, False)):  # nothing is installed under /usr/share/<name> any more (D-053)
            try:
                names = listdir_fn(str(directory))
            except OSError:
                continue
            for name in names:
                if LEFTOVER.match(name) and (not only_prefixed or name.lstrip(".").startswith("linux-xtu")):
                    found.append(str(directory / name))
        if found:
            raise ValueError(f"leftover staging paths of an interrupted install: {sorted(found)}")

    run("no leftover .old.*/.new.* staging paths", leftovers)
    return results


def main() -> int:
    results = selfcheck()
    failed = [(label, why) for label, why in results if why is not None]
    for label, why in results:
        print(f"{'FAIL' if why else 'ok  '}  {label}" + (f": {why}" if why else ""))
    if failed:
        print(f"linux-xtu self-check: {len(failed)} of {len(results)} checks FAILED; the helper will refuse to start. Run uninstall.sh or repair.", file=sys.stderr)
        return 1
    print(f"linux-xtu self-check: all {len(results)} checks passed.")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(os.path.abspath(__file__)).parent))  # -I removes the script directory: the installed tree is the only source
    sys.exit(main())
