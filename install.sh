#!/bin/bash
# Linux XTU system install (G-106, G-144, R-B6, R-R1; SPEC 4.4 / 11, D-024, D-030, D-043, D-053, D-054). Run as root:
#   sudo bash install.sh [--reseed-config] [--add-user NAME]... [--socket-mode 0660|0666] [--enable-boot-restore | --disable-boot-restore]
#                        [--replace-boot-restore] [--appimage /ABS/PATH/linux-xtu.AppImage] [--load-msr]
#
# The helper is a root service on a Unix socket (/run/linux-xtu/helper.sock, systemd socket activation): no polkit, no password. Who may use it is the
# [access] allowlist in /etc/linux-xtu/helper.toml, checked by the helper (SO_PEERCRED) at every connection. The invoking user (SUDO_USER) is put there on
# the first install; --add-user NAME appends more. An existing allowlist is never dropped.
#   --socket-mode 0660 (default of a fresh install, D-053 item 4): the socket node is root:linux-xtu 0660; the group is created here and every allowlisted
#                      user, and every member of an [access] group, is added to it (a newly added member logs out and in once). --socket-mode 0666: the
#                      D-043 amendment form (no group, no re-login). Without the option an upgrade keeps the mode of the installed socket unit.
#   --enable-boot-restore   enable linux-xtu-restore.timer (the unattended boot restore of /etc/linux-xtu/accepted, D-053 item 3) and arm it for the
#                           accepted state that is there now; effective from the next boot. The timer is installed DISABLED otherwise.
#   --disable-boot-restore  disable the timer and disarm. An already enabled timer stays enabled on an upgrade without either flag.
#   --replace-boot-restore  a linux-xtu-restore.service / .timer (or arltuner-restore.*, the earlier name) in /etc/systemd/system that this script did not
#                           install (no "# linux-xtu: packaged unit" / "# arltuner: packaged unit" first line) is refused by default; with this flag it is
#                           disabled, backed up to /var/lib/linux-xtu/replaced-units/<UTC>/ and replaced by the packaged (disabled) units.
#   --appimage PATH         desktop entry /usr/share/applications/linux-xtu.desktop running PATH (an existing file; letters, digits and ._/+- only) + icon
#   --load-msr              /etc/modules-load.d/linux-xtu.conf: load the msr driver at every boot (Debian/Ubuntu/Arch; built in on Fedora)
#
# Layout (root:root; dirs 0755, files 0644 unless noted):
#   /usr/lib/linux-xtu/linux_xtu/           the Python package, precompiled here (root-owned __pycache__)
#   /usr/lib/linux-xtu/platforms/*.toml     platform files
#   /usr/lib/linux-xtu/linux-xtu-helper     0755 launcher: ExecStart of linux-xtu-helper.service (--device --socket)
#   /usr/lib/linux-xtu/linux-xtu-restore    0755 launcher: ExecStart of linux-xtu-restore.service (run); also arm / disarm / status
#   /usr/lib/linux-xtu/linux-xtu-cli        0755 launcher of the CLI from the installed tree (tools/lnx/restore_tuning.sh --from runs it as root)
#   /usr/lib/linux-xtu/linux-xtu-selfcheck  0755 post-install trust check
#   /usr/lib/linux-xtu/linux-xtu-access     0755 helper.toml [access] editor (used by this script)
#   /etc/systemd/system/linux-xtu-helper.{socket,service}      the socket and the service it starts; enabled here (socket only)
#   /etc/systemd/system/linux-xtu-restore.{service,timer}      the boot restore; the timer only with --enable-boot-restore
#   /usr/lib/tmpfiles.d/linux-xtu.conf      /run/linux-xtu 0755 root (mailbox lock directory, the socket)
#   /etc/linux-xtu/{policy.toml,helper.toml,restore.toml}   operator-owned settings: seeded from the checkout ONLY when absent
#                                          (--reseed-config replaces them; the [access] allowlist always stays)
#   /etc/linux-xtu/accepted/               the USER's accepted state (D-036): never created, changed or removed by this script. The app writes it
#                                          (Profiles > Set as accepted); a fresh install has none ("No accepted state yet")
#   /var/lib/linux-xtu/audit.jsonl         0600; seeded once from the invoking user's per-user ~/.local/state/linux-xtu/audit.jsonl
#                                          (or ~/.local/state/arltuner/audit.jsonl, the earlier name, when only that one exists)
#   /var/lib/linux-xtu/bootrestore.json    the boot restore's state (written by linux-xtu-restore, never by this script)
#   /usr/share/applications/linux-xtu.desktop, /usr/share/icons/hicolor/128x128/apps/linux-xtu.png   with --appimage
#   /etc/modules-load.d/linux-xtu.conf     with --load-msr
#
# Migration from the earlier name `arltuner` (D-054, docs/NAMING.md; run once, idempotent): when an arltuner install is found (/etc/arltuner,
# /var/lib/arltuner, /usr/lib/arltuner, arltuner-* units or /usr/lib/tmpfiles.d/arltuner.conf), this script stops its helper, COPIES /etc/arltuner/** and
# /var/lib/arltuner/** to /etc/linux-xtu and /var/lib/linux-xtu (cp -a: modes, owners and times kept; the policy, the accepted state with its fingerprint, the
# audit log and the boot restore state with its armed / disarmed setting, which is never armed here; a file already there that differs is first kept as
# <file>.bak-migration-<UTC>), installs the new layout, and only after the self-check passed: disables the old units and moves them (with the old tmpfiles.d /
# modules-load.d files and desktop entry) to /var/lib/linux-xtu/migrated-from-arltuner-<UTC>/root/<their path>, renames /etc/arltuner, /var/lib/arltuner and
# /usr/lib/arltuner to <dir>.migrated-<UTC> (nothing is deleted), creates the group linux-xtu with the members of the group arltuner, and enables the same
# set the old install had enabled (socket; the boot restore timer only if the packaged one was enabled). The old socket's mode is kept. A boot restore unit
# of the old name that this script did not install needs --replace-boot-restore, as above. It prints what moved. Roll back: docs/RUNBOOK-lnx.md §6.
# Into an existing /etc/linux-xtu or /var/lib/linux-xtu (a half-done earlier run) it merges, but never replaces policy.toml, bootrestore.json or audit.jsonl
# (an armed new boot restore state over a disarmed / pending old one is refused; the longer audit log is kept, the other one's extra records appended).
# A re-run after a failure in the last phase finishes it with the enabled set recorded in .../migrated-from-arltuner-<UTC>/enabled.txt. Nothing runs while
# a boot restore service of either name is active, activating or deactivating.
#
# The checkout is only ever COPIED. After the copy, the only Python that runs (compileall, the self-check, linux-xtu-access, linux-xtu-restore arm) is the
# installed, root-owned tree, in isolated mode, with cwd /. Idempotent: a second run replaces code/units/tmpfiles and leaves policy.toml, restore.toml,
# helper.toml's allowlist, the audit log, the boot restore's state and its enabled/disabled setting alone. The old polkit action file of the G-106 install is
# removed. A running helper is stopped first (the socket unit, or SIGTERM to an old pkexec-started one).
# DESTDIR=/some/dir installs into that tree instead (tests, packaging): no chown unless root, no systemd-tmpfiles / systemctl / group changes / arm, no live
# self-check (--enable-boot-restore only makes the timer's timers.target.wants link there; a migration makes the .wants links the old install had).
set -euo pipefail
umask 022
export LC_ALL=C
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

die() { echo "install.sh: $*" >&2; exit 1; }

RESEED=0
ADD_USERS=()
SOCKET_MODE=""  # set by --socket-mode; otherwise the installed unit's mode, or 0660 on a fresh install
SOCKET_GROUP=linux-xtu
BOOT_RESTORE=""   # enable | disable | "" (leave the timer as it is)
REPLACE_RESTORE=0
APPIMAGE=""
LOAD_MSR=0
NAME_RE='^[A-Za-z_][A-Za-z0-9_.-]{0,31}\$?$'
USAGE="usage: install.sh [--reseed-config] [--add-user NAME]... [--socket-mode 0660|0666] [--enable-boot-restore | --disable-boot-restore] [--replace-boot-restore] [--appimage PATH] [--load-msr]"
while [ $# -gt 0 ]; do
    case $1 in
        --reseed-config) RESEED=1 ;;
        --add-user)
            [ $# -ge 2 ] || die "--add-user needs a user name"
            shift
            [[ $1 =~ $NAME_RE ]] || die "--add-user: '$1' is not a valid user name"
            [ "$1" != root ] || die "--add-user: root is never added to the allowlist"
            ADD_USERS+=("$1")
            ;;
        --socket-mode)
            [ $# -ge 2 ] || die "--socket-mode needs 0660 or 0666"
            shift
            case $1 in 0660|0666) SOCKET_MODE=$1 ;; *) die "--socket-mode: '$1' is not 0660 or 0666" ;; esac
            ;;
        --enable-boot-restore) [ "$BOOT_RESTORE" != disable ] || die "--enable-boot-restore and --disable-boot-restore exclude each other"; BOOT_RESTORE=enable ;;
        --disable-boot-restore) [ "$BOOT_RESTORE" != enable ] || die "--enable-boot-restore and --disable-boot-restore exclude each other"; BOOT_RESTORE=disable ;;
        --replace-boot-restore) REPLACE_RESTORE=1 ;;
        --appimage)
            [ $# -ge 2 ] || die "--appimage needs the AppImage's absolute path"
            shift
            [[ $1 =~ ^/[A-Za-z0-9._/+-]+$ ]] || die "--appimage: '$1' must be an absolute path of letters, digits and ._/+- (it becomes the desktop entry's Exec line)"
            case /$1/ in */../*|*/./*) die "--appimage: '$1' must not contain . or .. components" ;; esac
            [ -f "$1" ] && [ ! -L "$1" ] || die "--appimage: $1 is not a regular file"
            APPIMAGE=$1
            ;;
        --load-msr) LOAD_MSR=1 ;;
        -h|--help) sed -n '2,61p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown argument: $1 ($USAGE)" ;;
    esac
    shift
done

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
DESTDIR=${DESTDIR:-}
DESTDIR=${DESTDIR%/}
if [ -n "$DESTDIR" ]; then
    case $DESTDIR in /*) ;; *) die "DESTDIR must be an absolute path" ;; esac
    PYTHON=${LINUX_XTU_PYTHON:-/usr/bin/python3}  # test hooks are honoured only for a DESTDIR install, never for a real one
    USER_AUDIT_OVERRIDE=${LINUX_XTU_USER_AUDIT:-}
    PROC_ROOT=${LINUX_XTU_PROC:-/proc}
else
    [ "$(id -u)" -eq 0 ] || die "must run as root (sudo bash install.sh)"
    PYTHON=/usr/bin/python3  # the interpreter named in the launcher's shebang
    USER_AUDIT_OVERRIDE=
    PROC_ROOT=/proc
fi

LIB=$DESTDIR/usr/lib/linux-xtu
OLD_POLKIT=$DESTDIR/usr/share/polkit-1/actions/io.github.arrowlake-tuner.helper.policy  # the G-106 action: removed (D-043)
UNITS=$DESTDIR/etc/systemd/system
TMPF=$DESTDIR/usr/lib/tmpfiles.d/linux-xtu.conf
ETC=$DESTDIR/etc/linux-xtu
STATE=$DESTDIR/var/lib/linux-xtu
AUDIT=$STATE/audit.jsonl
FINAL_PKG=/usr/lib/linux-xtu/linux_xtu  # recorded in the .pyc files (compileall -d): the path the code will run from
PACKAGED_MARK='# linux-xtu: packaged unit'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# The project's earlier name (D-054, docs/NAMING.md). Everything below that names `arltuner` exists only to migrate an install made under that name.
OLD_LIB=$DESTDIR/usr/lib/arltuner
OLD_ETC=$DESTDIR/etc/arltuner
OLD_STATE=$DESTDIR/var/lib/arltuner
OLD_WEB_DIR=$DESTDIR/usr/share/arltuner  # the browser GUI's static files of an install before D-053: removed (the AppImage is the only front-end)
OLD_TMPF=$DESTDIR/usr/lib/tmpfiles.d/arltuner.conf
OLD_MODLOAD=$DESTDIR/etc/modules-load.d/arltuner.conf
OLD_DESKTOP=$DESTDIR/usr/share/applications/arltuner.desktop
OLD_ICON=$DESTDIR/usr/share/icons/hicolor/128x128/apps/arltuner.png
OLD_MARK='# arltuner: packaged unit'
OLD_FILE_MARK='# arltuner: packaged file'
OLD_GROUP=arltuner
OLD_HELPER_UNITS=(arltuner-helper.socket arltuner-helper.service)
OLD_RESTORE_UNITS=(arltuner-restore.service arltuner-restore.timer)

if [ "$(id -u)" -eq 0 ]; then OWN=(-o root -g root); else OWN=(); fi

SYSTEMD=0  # systemd is PID 1 (sd_booted): units are enabled and the socket started; DESTDIR installs never touch the live system
if [ -z "$DESTDIR" ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then SYSTEMD=1; fi
if [ "$BOOT_RESTORE" = enable ] && [ -z "$DESTDIR" ] && [ "$SYSTEMD" -eq 0 ]; then
    die "--enable-boot-restore needs systemd as PID 1 (the boot restore is a systemd timer); nothing was changed"
fi

unit_enabled() {  # unit_enabled UNIT TARGET: systemd's answer on a live system; the TARGET.wants link otherwise (a DESTDIR tree, another init)
    if [ "$SYSTEMD" -eq 1 ]; then systemctl is-enabled --quiet "$1" 2>/dev/null; else [ -L "$UNITS/$2.wants/$1" ]; fi
}
first_line() { { [ -f "$1" ] && [ ! -L "$1" ] && head -n 1 -- "$1"; } 2>/dev/null || true; }

restore_busy() {  # restore_busy: prints "UNIT (STATE)" of a boot restore service of either name that is running now, else nothing (status 1). A oneshot one
    # mid-run is "activating", a stopping one "deactivating": none of them is ever disabled, stopped or replaced under its feet (review F2).
    local u s
    for u in linux-xtu-restore.service arltuner-restore.service; do
        s=$(systemctl show -p ActiveState --value "$u" 2>/dev/null || true)
        case $s in active|activating|deactivating|reloading) echo "$u ($s)"; return 0 ;; esac
    done
    return 1
}
refuse_if_restore_busy() {  # refuse_if_restore_busy WHEN: dies while a boot restore runs (live systemd only)
    local busy
    [ "$SYSTEMD" -eq 1 ] || return 0
    if busy=$(restore_busy); then
        die "the boot restore $busy is running now ($1): it is never stopped or replaced mid-apply (it watches a boot until it counts as healthy, ~10 min after boot). Re-run after it has finished: systemctl show -p ActiveState linux-xtu-restore.service arltuner-restore.service"
    fi
}

br_state() {  # br_state FILE: the boot restore state file as "armed" (armed and no pending boot), "safe" (not armed, or a pending boot that makes the next run
    # disarm) or "unreadable"; read by the system python in isolated mode (it only parses JSON)
    (cd / && "$PYTHON" -I -c 'import json, sys
try:
    d = json.load(open(sys.argv[1], "rb"))
except Exception:
    print("unreadable")
else:
    print("armed" if isinstance(d, dict) and d.get("armed") is True and not d.get("pending") else "safe")' "$1") 2>/dev/null || echo unreadable
}
is_prefix() {  # is_prefix A B: file A is a byte prefix of file B (equal counts)
    local n
    n=$(stat -c %s -- "$1") || return 1
    [ "$n" -le "$(stat -c %s -- "$2")" ] && cmp -s -n "$n" -- "$1" "$2"
}
merge_conflict() {  # merge_conflict OLD NEW: for a merge into an existing NEW (review F1), the reason the kept files cannot be reconciled safely, or nothing.
    # audit.jsonl: fine when one log is a prefix of the other (the longer one's records are kept); bootrestore.json: fine unless the new one is armed and
    # the old one is not (disarmed, a pending boot, unreadable): keeping the armed side would silently undo a disarm.
    local old=$1 new=$2
    if [ -f "$old/audit.jsonl" ] && [ -f "$new/audit.jsonl" ] && ! is_prefix "$old/audit.jsonl" "$new/audit.jsonl" && ! is_prefix "$new/audit.jsonl" "$old/audit.jsonl"; then
        echo "${old#"$DESTDIR"}/audit.jsonl and ${new#"$DESTDIR"}/audit.jsonl both hold records the other lacks: merge them by hand (keep every line, oldest first; the per-boot count is read from it), then re-run"
        return 0
    fi
    if [ -f "$old/bootrestore.json" ] && [ -f "$new/bootrestore.json" ] && ! cmp -s -- "$old/bootrestore.json" "$new/bootrestore.json" \
       && [ "$(br_state "$new/bootrestore.json")" = armed ] && [ "$(br_state "$old/bootrestore.json")" != armed ]; then
        echo "${new#"$DESTDIR"}/bootrestore.json is armed but ${old#"$DESTDIR"}/bootrestore.json is disarmed or records a boot that did not end cleanly: disarm first (as root: /usr/lib/linux-xtu/linux-xtu-restore disarm --reason migration), then re-run"
        return 0
    fi
    return 1
}

# --- an install under the earlier name (D-054): found, described, checked here; nothing is changed before every step that can refuse has run ---------
refuse_if_restore_busy "before the install"
MIGRATE=0
for p in "$OLD_ETC" "$OLD_STATE" "$OLD_LIB" "$OLD_TMPF" "$UNITS/arltuner-helper.socket" "$UNITS/arltuner-helper.service" "$UNITS/arltuner-restore.service" \
         "$UNITS/arltuner-restore.timer"; do
    if [ -e "$p" ] || [ -L "$p" ]; then MIGRATE=1; fi
done
OLD_SOCKET_PRESENT=0; OLD_SOCKET_ENABLED=0; OLD_RESTORE_ENABLED=0; OLD_PACKAGED_RESTORE=()
if [ "$MIGRATE" -eq 1 ]; then
    for d in "$OLD_ETC" "$OLD_STATE" "$OLD_LIB"; do
        if [ -L "$d" ]; then die "$d is a symbolic link; refusing to migrate from it (nothing was changed)"; fi
        if [ -e "$d" ] && [ ! -d "$d" ]; then die "$d is not a directory; refusing to migrate from it (nothing was changed)"; fi
    done
    for d in "$ETC" "$STATE"; do
        if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then die "$d exists and is not a directory; refusing to migrate into it (nothing was changed)"; fi
    done
    if [ -d "$OLD_STATE" ] && [ -d "$STATE" ] && why=$(merge_conflict "$OLD_STATE" "$STATE"); then die "migration: $why (nothing was changed)"; fi
    if [ -f "$UNITS/arltuner-helper.socket" ]; then
        OLD_SOCKET_PRESENT=1
        if unit_enabled arltuner-helper.socket sockets.target; then OLD_SOCKET_ENABLED=1; fi
    fi
    for u in "${OLD_RESTORE_UNITS[@]}"; do  # the boot restore units the old install.sh made (its mark on the first line); any other is foreign (below)
        l=$(first_line "$UNITS/$u")
        if [ -n "$l" ] && [ "${l#"$OLD_MARK"}" != "$l" ]; then OLD_PACKAGED_RESTORE+=("$u"); fi
    done
    if [ "${#OLD_PACKAGED_RESTORE[@]}" -gt 0 ] && unit_enabled arltuner-restore.timer timers.target; then OLD_RESTORE_ENABLED=1; fi
fi
# A migration that stopped after it began retiring the old install (review F5): its record of what the old install had enabled is the truth now (the live
# units were already disabled or moved by that run), and its directory and time stamp are reused. "complete" is its last line once a migration ended.
RESUME=""
for d in "$STATE"/migrated-from-arltuner-*; do
    if [ -d "$d" ] && [ ! -L "$d" ] && [ -f "$d/enabled.txt" ] && ! grep -qx complete "$d/enabled.txt"; then RESUME=$d; fi
done
if [ -n "$RESUME" ]; then
    STAMP=${RESUME##*/migrated-from-arltuner-}
    OLD_SOCKET_PRESENT=1
    if grep -qx 'arltuner-helper.socket enabled' "$RESUME/enabled.txt"; then OLD_SOCKET_ENABLED=1; else OLD_SOCKET_ENABLED=0; fi
    if grep -qx 'arltuner-restore.timer enabled' "$RESUME/enabled.txt"; then OLD_RESTORE_ENABLED=1; else OLD_RESTORE_ENABLED=0; fi
    echo "resuming the migration of $STAMP that stopped before its end: the enabled set is the one it recorded in ${RESUME#"$DESTDIR"}/enabled.txt" \
         "(arltuner-helper.socket $([ "$OLD_SOCKET_ENABLED" -eq 1 ] && echo enabled || echo disabled), arltuner-restore.timer $([ "$OLD_RESTORE_ENABLED" -eq 1 ] && echo enabled || echo disabled))"
fi
MIGRATION=0  # this run migrates (or finishes migrating) an arltuner install
if [ "$MIGRATE" -eq 1 ] || [ -n "$RESUME" ]; then MIGRATION=1; fi
if [ "$MIGRATE" -eq 1 ]; then
    echo "found an install under the earlier name arltuner: it is migrated to linux-xtu (copied, then the old paths are renamed *.migrated-$STAMP; nothing is deleted)"
fi

# the socket mode: the option, else the one the installed unit has (an upgrade never switches it silently; a migration keeps the arltuner socket's), else the
# D-053 default
KEPT_MODE=0
if [ -z "$SOCKET_MODE" ]; then
    for f in "$UNITS/linux-xtu-helper.socket" "$UNITS/arltuner-helper.socket"; do
        INSTALLED_MODE=$(sed -n 's/^SocketMode=\(06[0-9][0-9]\)$/\1/p' -- "$f" 2>/dev/null | tail -n 1 || true)
        case $INSTALLED_MODE in 0660|0666) SOCKET_MODE=$INSTALLED_MODE; KEPT_MODE=1; break ;; esac
    done
    [ -n "$SOCKET_MODE" ] || SOCKET_MODE=0660
fi
# the msr module at boot: kept on when the arltuner install had its packaged modules-load.d file
if [ "$MIGRATE" -eq 1 ]; then
    l=$(first_line "$OLD_MODLOAD")
    if [ -n "$l" ] && [ "${l#"$OLD_FILE_MARK"}" != "$l" ]; then LOAD_MSR=1; fi
fi

# --- a running helper keeps lazily importing from the tree we are about to replace: refuse until it is stopped ---------------------------
helper_pids() {  # PIDs running the helper (either name): argv[0] is the helper itself, or a wrapper (python*, pkexec, sudo, env) whose first non-option argument is it
    local c pid i base a skip
    local -a argv
    for c in "$PROC_ROOT"/[0-9]*/cmdline; do
        [ -r "$c" ] || continue
        pid=${c%/cmdline}; pid=${pid##*/}
        [ "$pid" != "$$" ] || continue
        argv=()
        while IFS= read -r -d '' a || [ -n "$a" ]; do argv+=("$a"); done < "$c" 2>/dev/null || true
        [ "${#argv[@]}" -gt 0 ] || continue
        base=${argv[0]##*/}
        case $base in
            linux-xtu-helper|linux-xtu-helper.py|arltuner-helper|arltuner-helper.py) echo "$pid"; continue ;;
            python|python3|python3.*|pkexec|sudo|env) ;;
            *) continue ;;   # vim/grep/less ... with the helper's name as an argument is not the helper
        esac
        skip=0
        for ((i = 1; i < ${#argv[@]}; i++)); do
            a=${argv[i]}
            if [ "$skip" = 1 ]; then skip=0; continue; fi
            case $a in
                -u|--user|-g|--group) skip=1; continue ;;   # an option value (pkexec --user root PATH) is not the program
                -*) continue ;;
            esac
            case ${a##*/} in
                linux-xtu-helper|linux-xtu-helper.py|arltuner-helper|arltuner-helper.py) echo "$pid"; break ;;
                python|python3|python3.*|pkexec|sudo|env) continue ;;   # a wrapper around a wrapper (e.g. env then python3 PATH): keep looking for the program
            esac
            break   # any other first non-option argument is the program; later ones are its data
        done
    done
}

HELPER_PY=$(readlink -f /usr/bin/python3 2>/dev/null || true)  # what /proc/<pid>/exe of the real helper resolves to
HELPER_UID=0
strict_helper_pids() {  # PIDs of the REAL helper only: uid 0, exe = the system python3, argv exactly  /usr/bin/python3 -I <installed launcher> --device [--socket]
    local c pid a
    local -a argv
    for c in "$PROC_ROOT"/[0-9]*/cmdline; do
        [ -r "$c" ] || continue
        pid=${c%/cmdline}; pid=${pid##*/}
        [ "$pid" != "$$" ] || continue
        argv=()
        while IFS= read -r -d '' a || [ -n "$a" ]; do argv+=("$a"); done < "$c" 2>/dev/null || true
        case ${#argv[@]} in 4|5) ;; *) continue ;; esac
        [ "${argv[0]}" = /usr/bin/python3 ] && [ "${argv[1]}" = -I ] && [ "${argv[3]}" = --device ] || continue
        case ${argv[2]} in /usr/lib/linux-xtu/linux-xtu-helper|/usr/lib/arltuner/arltuner-helper) ;; *) continue ;; esac
        [ "${#argv[@]}" -eq 4 ] || [ "${argv[4]}" = --socket ] || continue
        [ -n "$HELPER_PY" ] && [ "$(readlink -f "$PROC_ROOT/$pid/exe" 2>/dev/null || true)" = "$HELPER_PY" ] || continue
        [ "$(stat -c %u "$PROC_ROOT/$pid" 2>/dev/null || true)" = "$HELPER_UID" ] || continue
        echo "$pid"
    done
}

# --- sanity: sources and interpreter -------------------------------------------------------------------------------------------------
# Every directory we copy from, and every file we need, must be a real entry of THIS checkout: no symlink, and its realpath stays under $SRC.
for f in src platforms packaging policies; do
    [ -d "$SRC/$f" ] || die "incomplete checkout: $SRC/$f is missing"
done
for f in src src/linux_xtu src/linux_xtu/__init__.py platforms packaging policies policies/default.toml packaging/linux-xtu-helper packaging/selfcheck.py \
         packaging/linux-xtu-access packaging/linux-xtu-helper.socket packaging/linux-xtu-helper.service packaging/linux-xtu.tmpfiles.conf \
         packaging/linux-xtu-restore packaging/linux-xtu-cli packaging/linux-xtu-restore.service packaging/linux-xtu-restore.timer packaging/restore.toml \
         packaging/linux-xtu.desktop packaging/linux-xtu.png packaging/linux-xtu-modules.conf; do
    [ -e "$SRC/$f" ] || die "incomplete checkout: $SRC/$f is missing"
    [ ! -L "$SRC/$f" ] || die "$SRC/$f is a symlink; refusing"
    real=$(realpath -e -- "$SRC/$f") || die "cannot resolve $SRC/$f"
    case $real in "$SRC"/*) ;; *) die "$SRC/$f resolves to $real, outside the checkout; refusing" ;; esac
done
(cd / && "$PYTHON" -I -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)') || die "$PYTHON must be Python >= 3.12 (D-024)"

# --- who is installing: the per-user audit log is read as that user, never as root; the same user is seeded into the allowlist --------------
INVOKER=""
if [ -n "${PKEXEC_UID:-}" ]; then
    case $PKEXEC_UID in *[!0-9]*) die "PKEXEC_UID is not a number" ;; esac
    FROM_PK=$(getent passwd "$PKEXEC_UID" | cut -d: -f1 || true)
    [ -n "$FROM_PK" ] || die "PKEXEC_UID=$PKEXEC_UID is not a known user"
    INVOKER=$FROM_PK
fi
if [ -n "${SUDO_USER:-}" ]; then
    if [ -n "$INVOKER" ] && [ "$INVOKER" != "$SUDO_USER" ]; then
        die "PKEXEC_UID ($INVOKER) and SUDO_USER ($SUDO_USER) disagree; refusing to guess whose per-user audit log to seed"
    fi
    INVOKER=$SUDO_USER
fi
[ "$INVOKER" != root ] || INVOKER=""  # never root

uid_of() {  # uid_of NAME: the uid of an existing user, or nothing (the name was validated against NAME_RE first, so it is never an option)
    getent passwd "$1" 2>/dev/null | cut -d: -f3 || true
}
if [ -n "$INVOKER" ]; then  # the name ends up in a TOML file, a runuser call and the allowlist: a plain name, an existing user in a real install, never uid 0
    [[ $INVOKER =~ $NAME_RE ]] || die "the invoking user name '$INVOKER' is not a plain user name; refusing"
    INVOKER_UID=$(uid_of "$INVOKER")
    if [ -z "$INVOKER_UID" ] && [ -z "$DESTDIR" ]; then die "the invoking user '$INVOKER' is not known to the system (getent passwd)"; fi
    [ "$INVOKER_UID" != 0 ] || die "the invoking user '$INVOKER' has uid 0: root is never put in the allowlist"
fi
for u in ${ADD_USERS[@]+"${ADD_USERS[@]}"}; do
    [ "$(uid_of "$u")" != 0 ] || die "--add-user: '$u' has uid 0: root is never put in the allowlist"
done

# --- a running helper: a DESTDIR install just refuses; a real one stops it later (right before the code is replaced), after every step that can still refuse ---
RUNNING=$(helper_pids | tr '\n' ' ')
if [ -n "$DESTDIR" ]; then
    [ -z "$RUNNING" ] || die "a linux-xtu-helper / arltuner-helper process is running (pid ${RUNNING% }): stop the GUI / helper first, then re-run the install"
fi

# --- a boot restore unit this script did not install (assessment 06 F1: e.g. one that runs a script of a checkout as root at every boot), under either
# name: described, and replaced only with --replace-boot-restore. Decided here, before anything is changed. -----------------------------------------------
FOREIGN_RESTORE=()
for u in linux-xtu-restore.service linux-xtu-restore.timer "${OLD_RESTORE_UNITS[@]}"; do
    f=$UNITS/$u
    case $u in arltuner-*) mark=$OLD_MARK ;; *) mark=$PACKAGED_MARK ;; esac
    first=$(first_line "$f")
    if [ -L "$f" ] || { [ -e "$f" ] && [ "${first#"$mark"}" = "$first" ]; }; then FOREIGN_RESTORE+=("$u"); fi
done
if [ "${#FOREIGN_RESTORE[@]}" -gt 0 ]; then
    echo "found a boot restore unit that this script did not install:"
    for u in ${FOREIGN_RESTORE[@]+"${FOREIGN_RESTORE[@]}"}; do
        f=$UNITS/$u
        if [ -L "$f" ]; then echo "  $f -> $(readlink -- "$f") (a link)"; else echo "  $f"; grep -E '^[[:space:]]*(ExecStart|ExecStartPre|User|OnBootSec|OnCalendar)=' -- "$f" 2>/dev/null | sed 's/^/      /' || true; fi
        for w in "$UNITS"/*.wants/"$u"; do [ -L "$w" ] && echo "      enabled: $w"; done
    done
    echo "  it will be disabled, backed up to $STATE/replaced-units/<UTC>/ and replaced by the packaged linux-xtu-restore.{service,timer} (installed disabled;"
    echo "  the packaged unit runs only the installed code and applies only /etc/linux-xtu/accepted, with a crash-loop guard)."
    [ "$REPLACE_RESTORE" -eq 1 ] || die "re-run with --replace-boot-restore to replace it (nothing was changed)"
fi

copy_one() {  # copy_one SRC DST MODE: copy WITHOUT dereferencing, then insist the result is a regular file (a source swapped for a link is not followed)
    local from=$1 to=$2 mode=$3
    mkdir -p -- "$(dirname -- "$to")"
    rm -f -- "$to"
    cp --no-dereference --no-preserve=all -- "$from" "$to" || die "cannot copy $from"
    if [ -L "$to" ] || [ ! -f "$to" ]; then rm -f -- "$to"; die "$from changed while it was being copied (not a regular file); refusing"; fi
    chmod "$mode" "$to"
    if [ "$(id -u)" -eq 0 ]; then chown root:root "$to"; fi
}

copy_files() {  # copy_files SRCDIR DSTDIR [find-args...]: regular files only, never symlinks, no __pycache__, mode 0644
    local from=$1 to=$2 rel
    shift 2
    (cd "$from" && find . -name __pycache__ -prune -o -type f "$@" -print0) | while IFS= read -r -d '' rel; do
        rel=${rel#./}
        copy_one "$from/$rel" "$to/$rel" 0644
    done
}

swap_dir() {  # swap_dir NEW FINAL: FINAL is never missing afterwards - the old tree moves aside, the new one moves in, a failure moves the old one back
    local new=$1 final=$2 old=$2.old.$$
    if [ -e "$final" ] || [ -L "$final" ]; then
        rm -rf -- "$old"
        mv -T -- "$final" "$old" || die "cannot move $final aside; nothing was changed"
        if ! mv -T -- "$new" "$final"; then
            mv -T -- "$old" "$final" || echo "CRITICAL: could not restore $final from $old" >&2
            die "could not move the new tree to $final; rolled back to the old one"
        fi
        rm -rf -- "$old"
    else
        mv -T -- "$new" "$final" || die "could not move the new tree to $final"
    fi
}

normalize() {  # normalize DIR: dirs 0755, files 0644, root-owned when we can be
    find "$1" -type d -exec chmod 0755 {} +
    find "$1" -type f -exec chmod 0644 {} +
    if [ "$(id -u)" -eq 0 ]; then chown -R root:root "$1"; fi
}

MIGRATED=()  # the summary lines of a migration
migrate_tree() {  # migrate_tree OLD NEW: OLD's entries copied with cp -a (modes, owners, times). A NEW that does not exist yet is created in one step (copy
    # beside it, then rename); into an existing NEW (an earlier run that stopped half-way, or an install made since) every entry of OLD is merged: equal files
    # are left, a file of NEW that differs is first kept as <file>.bak-migration-<UTC>, then OLD's copy replaces it. Never replaced in a merge (review F1):
    # policy.toml and bootrestore.json (NEW's is kept; merge_conflict refused an armed NEW over a disarmed / pending OLD before anything changed) and
    # audit.jsonl (NEW's is kept; when it is a prefix of OLD's, OLD's further records are appended, so no record of either is lost). Nothing of OLD is changed.
    local from=$1 to=$2 rel tmp n=0 kept=0 why size
    [ -d "$from" ] || return 0
    if [ ! -e "$to" ] && [ ! -L "$to" ]; then
        tmp=$(dirname -- "$to")/.$(basename -- "$to").migrate.$$
        rm -rf -- "$tmp"
        cp -a --no-dereference -- "$from" "$tmp" || { rm -rf -- "$tmp"; die "could not copy $from to $tmp (the copy was removed again; $from is unchanged)"; }
        mv -T -- "$tmp" "$to" || { rm -rf -- "$tmp"; die "could not rename $tmp to $to ($from is unchanged)"; }
        n=$(find "$to" \( -type f -o -type l \) | wc -l)
        MIGRATED+=("${from#"$DESTDIR"} -> ${to#"$DESTDIR"}: copied ($n files, modes and owners kept)")
        return 0
    fi
    if why=$(merge_conflict "$from" "$to"); then die "migration: $why"; fi
    while IFS= read -r -d '' rel; do
        rel=${rel#./}
        if [ ! -e "$to/$rel" ] && [ ! -L "$to/$rel" ]; then
            mkdir -- "$to/$rel" || die "could not create $to/$rel"
            chmod --reference="$from/$rel" -- "$to/$rel"
            if [ "$(id -u)" -eq 0 ]; then chown --reference="$from/$rel" -- "$to/$rel"; fi
        fi
    done < <(cd "$from" && find . -mindepth 1 -type d -print0)
    while IFS= read -r -d '' rel; do
        rel=${rel#./}
        if [ -e "$to/$rel" ] || [ -L "$to/$rel" ]; then
            if [ ! -L "$from/$rel" ] && [ ! -L "$to/$rel" ] && [ -f "$to/$rel" ] && cmp -s -- "$from/$rel" "$to/$rel"; then continue; fi
            case $rel in
                policy.toml|bootrestore.json)
                    echo "migration: kept ${to#"$DESTDIR"}/$rel (it differs from ${from#"$DESTDIR"}/$rel, which stays in the renamed old directory; a merge never replaces it)"
                    MIGRATED+=("${to#"$DESTDIR"}/$rel: kept (the arltuner one differs; this script never arms the boot restore)")
                    continue ;;
                audit.jsonl)
                    if is_prefix "$to/$rel" "$from/$rel"; then
                        size=$(stat -c %s -- "$to/$rel")
                        tail -c +$((size + 1)) -- "$from/$rel" >> "$to/$rel" || die "could not append the newer records of $from/$rel to $to/$rel"
                        MIGRATED+=("${to#"$DESTDIR"}/$rel: kept, with the records the arltuner log has beyond it appended")
                    else
                        MIGRATED+=("${to#"$DESTDIR"}/$rel: kept (it already holds every record of the arltuner log)")
                    fi
                    continue ;;
            esac
            mv -T -- "$to/$rel" "$to/$rel.bak-migration-$STAMP" || die "could not keep a backup of $to/$rel"
            echo "migration: ${to#"$DESTDIR"}/$rel differed from ${from#"$DESTDIR"}/$rel: kept as $rel.bak-migration-$STAMP"
            kept=$((kept + 1))
        fi
        cp -a --no-dereference -- "$from/$rel" "$to/$rel" || die "could not copy $from/$rel"
        n=$((n + 1))
    done < <(cd "$from" && find . -mindepth 1 \( -type f -o -type l \) -print0)
    MIGRATED+=("${from#"$DESTDIR"} -> ${to#"$DESTDIR"}: merged into the existing directory ($n files copied, $kept differing ones kept as *.bak-migration-$STAMP)")
}

# --- 1. code: copy, precompile in place, then swap in -----------------------------------------------------------------------------------
mkdir -p "$DESTDIR/usr/lib/tmpfiles.d"  # system directory: created if missing, never re-moded
NEW=$DESTDIR/usr/lib/.linux-xtu.new.$$
STOPPED_SOCKET=0
STOPPED_OLD_SOCKET=0
FINISHING=0  # the migration's last phase (old units retired, old directories renamed) has started: a failure then is reported, not rolled back
RETIRED_DONE=0  # the old install was retired by this run (or an earlier one): nothing of it is started again on a failure (review F4)
[ -z "$RESUME" ] || RETIRED_DONE=1  # an earlier run already disabled the old units (it wrote enabled.txt first)
cleanup() {
    local rc=$?
    rm -rf "$NEW" "$ETC/.tmp.$$" "$STATE/.audit.new.$$" "$DESTDIR/etc/.linux-xtu.migrate.$$" "$DESTDIR/var/lib/.linux-xtu.migrate.$$"
    if [ "$rc" -ne 0 ] && [ "$FINISHING" -eq 1 ]; then
        echo "install.sh: CRITICAL: the migration stopped in its last phase. The old units and files moved so far are in $STATE/migrated-from-arltuner-$STAMP/root/;" >&2
        echo "install.sh: fix the error named above and run install.sh again (it continues with the enabled set recorded in its enabled.txt), or roll back as docs/RUNBOOK-lnx.md says." >&2
    elif [ "$rc" -ne 0 ]; then  # a failed install does not leave the machine without the helper it had
        if [ "$RETIRED_DONE" -eq 1 ]; then  # review F4/F5: the old install is retired already; its units are not started again
            echo "install.sh: the arltuner install was already retired (its units are in $STATE/migrated-from-arltuner-$STAMP/root/). Fix the error named above and run install.sh again: it finishes the migration with the enabled set recorded in that directory's enabled.txt." >&2
        fi
        if [ "$STOPPED_SOCKET" -eq 1 ]; then
            echo "install.sh: the install failed; starting the previous linux-xtu-helper.socket again" >&2
            systemctl start linux-xtu-helper.socket 2>/dev/null || true
        fi
        if [ "$STOPPED_OLD_SOCKET" -eq 1 ] && [ "$RETIRED_DONE" -eq 0 ]; then
            echo "install.sh: the install failed; starting the arltuner-helper.socket of the old install again (it was not migrated)" >&2
            systemctl start arltuner-helper.socket 2>/dev/null || true
        fi
    fi
}
trap cleanup EXIT
rm -rf "$NEW"
install -d -m 0755 ${OWN[@]+"${OWN[@]}"} "$NEW" "$NEW/linux_xtu" "$NEW/platforms"
copy_files "$SRC/src/linux_xtu" "$NEW/linux_xtu" -name '*.py'
copy_files "$SRC/platforms" "$NEW/platforms" -name '*.toml'
copy_one "$SRC/packaging/linux-xtu-helper" "$NEW/linux-xtu-helper" 0755
copy_one "$SRC/packaging/selfcheck.py" "$NEW/linux-xtu-selfcheck" 0755
copy_one "$SRC/packaging/linux-xtu-access" "$NEW/linux-xtu-access" 0755
copy_one "$SRC/packaging/linux-xtu-restore" "$NEW/linux-xtu-restore" 0755
copy_one "$SRC/packaging/linux-xtu-cli" "$NEW/linux-xtu-cli" 0755
# From here on only the installed copy is executed (isolated mode, cwd /): a planted compileall.py / sitecustomize in the checkout cannot run as root.
(cd / && "$PYTHON" -I -m compileall -q -f -d "$FINAL_PKG" "$NEW/linux_xtu") || die "compileall failed"
normalize "$NEW"
chmod 0755 "$NEW/linux-xtu-helper" "$NEW/linux-xtu-selfcheck" "$NEW/linux-xtu-access" "$NEW/linux-xtu-restore" "$NEW/linux-xtu-cli"

# --- stop the running helper (and the old install's): as late as possible (everything that can refuse has run; the code tree is replaced next) -----------
if [ "$SYSTEMD" -eq 1 ]; then  # the socket first (no new activation), then the service (an operation in flight completes; TimeoutStopSec)
    if systemctl is-active --quiet linux-xtu-helper.socket 2>/dev/null; then STOPPED_SOCKET=1; fi
    systemctl stop linux-xtu-helper.socket linux-xtu-helper.service 2>/dev/null || true
    if [ "$MIGRATE" -eq 1 ]; then
        if systemctl is-active --quiet arltuner-helper.socket 2>/dev/null; then STOPPED_OLD_SOCKET=1; fi
        systemctl stop arltuner-helper.socket arltuner-helper.service 2>/dev/null || true
    fi
fi
if [ -z "$DESTDIR" ]; then
    STRICT=$(strict_helper_pids | tr '\n' ' ')
    if [ -n "$STRICT" ]; then  # an old pkexec-started helper (G-106) or a manual one: SIGTERM is its orderly stop. Only the real helper is signalled.
        echo "stopping the running helper (pid ${STRICT% }) ..."
        # shellcheck disable=SC2086
        kill -TERM $STRICT 2>/dev/null || true
        for _ in $(seq 1 120); do
            sleep 0.5
            [ -n "$(strict_helper_pids)" ] || break
        done
    fi
    RUNNING=$(helper_pids | tr '\n' ' ')
    [ -z "$RUNNING" ] || die "a linux-xtu-helper / arltuner-helper process is running (pid ${RUNNING% }): stop the GUI / helper first, then re-run the install"
fi
swap_dir "$NEW" "$LIB"

# --- 1b. migration (D-054): the old install's settings and state are COPIED (the old directories stay as they are until the last phase) ---------------
if [ "$MIGRATE" -eq 1 ]; then
    mkdir -p "$DESTDIR/etc" "$DESTDIR/var/lib"
    migrate_tree "$OLD_ETC" "$ETC"
    migrate_tree "$OLD_STATE" "$STATE"
fi

# --- 2. remove the browser GUI's files left by an older install (D-053) ------------------------------------------------------------
if [ -e "$OLD_WEB_DIR/web" ] || [ -L "$OLD_WEB_DIR/web" ]; then rm -rf -- "$OLD_WEB_DIR/web"; echo "removed the old web GUI files $OLD_WEB_DIR/web (the desktop app replaces them)"; fi
rm -rf -- "$OLD_WEB_DIR"/web.new.* "$OLD_WEB_DIR"/web.old.* 2>/dev/null || true
rmdir "$OLD_WEB_DIR" 2>/dev/null || true  # only when empty

# --- 3. systemd units, the old polkit action, tmpfiles.d --------------------------------------------------------------------
mkdir -p "$UNITS"  # system directory: created if missing, never re-moded
if [ "$SOCKET_MODE" = 0660 ]; then
    copy_one "$SRC/packaging/linux-xtu-helper.socket" "$UNITS/linux-xtu-helper.socket" 0644
else  # --socket-mode 0666: the packaged unit with mode 0666 and no group (D-043 amendment form)
    SOCKTMP=$UNITS/.linux-xtu-helper.socket.new.$$
    sed -e 's/^SocketMode=0660$/SocketMode=0666/' -e '/^SocketGroup=/d' -- "$SRC/packaging/linux-xtu-helper.socket" > "$SOCKTMP"
    grep -q '^SocketMode=0666$' "$SOCKTMP" || { rm -f -- "$SOCKTMP"; die "could not write the 0666 socket unit"; }
    chmod 0644 "$SOCKTMP"
    if [ "$(id -u)" -eq 0 ]; then chown root:root "$SOCKTMP"; fi
    mv -T -- "$SOCKTMP" "$UNITS/linux-xtu-helper.socket"
fi
copy_one "$SRC/packaging/linux-xtu-helper.service" "$UNITS/linux-xtu-helper.service" 0644
if [ -e "$OLD_POLKIT" ] || [ -L "$OLD_POLKIT" ]; then rm -f -- "$OLD_POLKIT"; echo "removed the old polkit action $OLD_POLKIT (no polkit any more)"; fi
copy_one "$SRC/packaging/linux-xtu.tmpfiles.conf" "$TMPF" 0644
if [ -z "$DESTDIR" ]; then
    if command -v systemd-tmpfiles >/dev/null 2>&1; then
        systemd-tmpfiles --create "$TMPF" || die "systemd-tmpfiles --create failed"
    else
        install -d -m 0755 -o root -g root /run/linux-xtu
    fi
fi

# --- 4. /etc/linux-xtu: seeded from the repo only when absent ------------------------------------------------------------------------
install -d -m 0755 ${OWN[@]+"${OWN[@]}"} "$ETC"

# D-032 (operator yes, 2026-10-11) / D-036: the root policy that /etc/linux-xtu/policy.toml is seeded from is the generic advanced-user policy
# (offsets +-200 mV; ratio, V-target ceilings and the CPU sets are "auto": derived from the CPU in the session). No machine-specific numbers.
POLICY_SRC=policies/default.toml
[ -f "$SRC/$POLICY_SRC" ] && [ ! -L "$SRC/$POLICY_SRC" ] || die "incomplete checkout: $SRC/$POLICY_SRC is not a regular file"

if [ -e "$ETC/policy.toml" ] && [ "$RESEED" -eq 0 ]; then
    if cmp -s "$SRC/$POLICY_SRC" "$ETC/policy.toml"; then
        echo "policy.toml: unchanged"
    else
        echo "policy.toml: KEPT (it differs from $POLICY_SRC; operator-owned limits are never overwritten; --reseed-config replaces it)"
    fi
else
    copy_one "$SRC/$POLICY_SRC" "$ETC/policy.toml" 0644
    echo "policy.toml: installed from $POLICY_SRC"
fi

# helper.toml: allow_taint_bits (seeded [2]) and the [access] allowlist (D-043). linux-xtu-access (the installed copy, isolated python, cwd /) writes it:
# the invoking user is seeded only into an EMPTY allowlist, --add-user appends, an existing allowlist is never dropped (also by --reseed-config).
ACCESS_ARGS=()
[ -z "$INVOKER" ] || ACCESS_ARGS+=(--seed-user "$INVOKER")
for u in ${ADD_USERS[@]+"${ADD_USERS[@]}"}; do ACCESS_ARGS+=(--add-user "$u"); done
[ "$RESEED" -eq 0 ] || ACCESS_ARGS+=(--reseed)
(cd / && "$PYTHON" -I "$LIB/linux-xtu-access" "$ETC/helper.toml" ${ACCESS_ARGS[@]+"${ACCESS_ARGS[@]}"}) || die "could not write $ETC/helper.toml"
if ! grep -q '^users = \[.\+\]' "$ETC/helper.toml" && ! grep -q '^group = ' "$ETC/helper.toml"; then
    echo "WARNING: nobody is allowed to use the helper yet (no invoking user found). Run: sudo bash install.sh --add-user NAME" >&2
fi

# The accepted state (/etc/linux-xtu/accepted) is user data (D-036): it is not seeded, replaced or removed here. An existing one (this machine's earlier
# installs, or one saved in the app) is left exactly as it is; a fresh install has none until the user saves a profile as accepted.
# restore.toml: the boot restore's settings (delay, healthy window, ...): seeded only when absent, like policy.toml
if [ -e "$ETC/restore.toml" ] && [ "$RESEED" -eq 0 ]; then
    if cmp -s "$SRC/packaging/restore.toml" "$ETC/restore.toml"; then echo "restore.toml: unchanged"; else echo "restore.toml: KEPT (operator-owned; --reseed-config replaces it)"; fi
else
    copy_one "$SRC/packaging/restore.toml" "$ETC/restore.toml" 0644
    echo "restore.toml: installed (boot restore settings: apply 60 s after boot, healthy at 10 min uptime)"
fi

if [ -d "$ETC/accepted" ]; then echo "accepted/: kept (the user's accepted state is never touched)"; else echo "accepted/: none yet (created by Profiles > Set as accepted)"; fi
# G-148 (D-044): an accepted state from before G-148 may still be a chain (several 'profile =' lines); Restore accepted refuses it until it is migrated (a hint only)
if [ -f "$ETC/accepted/CURRENT" ] && [ "$(grep -c '^profile *=' "$ETC/accepted/CURRENT" || true)" -gt 1 ]; then echo "accepted/: an older chain of profiles - run once as root: python3 -I tools/linux-xtu.py accepted-migrate --dry-run, then without --dry-run (keeps a backup)"; fi

# --- 5. /var/lib/linux-xtu: audit log, seeded once from the per-user dev log (D-030) ------------------------------------------------
mkdir -p "$DESTDIR/var/lib"
install -d -m 0755 ${OWN[@]+"${OWN[@]}"} "$STATE"
install -d -m 0700 ${OWN[@]+"${OWN[@]}"} "$STATE/curves"  # G-111: measured V/F curves (root-only, kept across upgrades); the helper refuses anything looser
install -d -m 0700 ${OWN[@]+"${OWN[@]}"} "$STATE/stress"  # G-116: stress run results (root-only, kept across upgrades; the helper refuses anything looser)
install -d -m 0700 ${OWN[@]+"${OWN[@]}"} "$STATE/profiles"  # G-112: saved tuning intents (root-only, kept across upgrades; never overwritten by the helper)
install -d -m 0700 ${OWN[@]+"${OWN[@]}"} "$STATE/state"  # G-123: last-read.json (this boot's tune.read, root-only; stale boots are ignored by the helper)

as_user() {  # run a command as the invoking user (root only reads the per-user log THROUGH that user's permissions)
    if [ "$(id -u)" -eq 0 ]; then runuser -u "$INVOKER" -- "$@"; else "$@"; fi
}

user_audit_source() {  # prints the per-user log path of the invoking user (the one of the earlier name when only that one exists, D-054), or nothing
    local home=""
    if [ -n "$USER_AUDIT_OVERRIDE" ]; then printf '%s\n' "$USER_AUDIT_OVERRIDE"; return 0; fi
    if [ -n "$INVOKER" ]; then
        home=$(getent passwd "$INVOKER" | cut -d: -f6 || true)
    elif [ "$(id -u)" -ne 0 ]; then
        home=$HOME  # a non-root DESTDIR test run
    fi
    [ -n "$home" ] || return 0
    if ! as_user test -e "$home/.local/state/linux-xtu/audit.jsonl" 2>/dev/null && as_user test -f "$home/.local/state/arltuner/audit.jsonl" 2>/dev/null; then
        printf '%s/.local/state/arltuner/audit.jsonl\n' "$home"
    else
        printf '%s/.local/state/linux-xtu/audit.jsonl\n' "$home"
    fi
}

if [ -e "$AUDIT" ] || [ -L "$AUDIT" ]; then
    echo "audit.jsonl: kept (never overwritten)"
else
    USER_LOG=""
    if [ "$(id -u)" -eq 0 ] && [ -n "$INVOKER" ]; then
        command -v runuser >/dev/null 2>&1 || die "runuser is needed to read the per-user audit log safely; install util-linux"
    fi
    if [ "$(id -u)" -ne 0 ] || [ -n "$INVOKER" ]; then USER_LOG=$(user_audit_source || true); fi
    TMPAUDIT=$STATE/.audit.new.$$
    ( umask 077; : > "$TMPAUDIT" )
    if [ -n "$USER_LOG" ] && as_user test -f "$USER_LOG" && as_user test ! -L "$USER_LOG"; then
        # Read AS THE USER (a symlinked parent directory must not let root copy some other file into a log the GUI can tail), at most 64 MiB + 1 byte.
        as_user head -c 67108865 -- "$USER_LOG" > "$TMPAUDIT" || { rm -f "$TMPAUDIT"; die "could not read the per-user audit log $USER_LOG${INVOKER:+ as $INVOKER}"; }
        size=$(stat -c %s "$TMPAUDIT")
        [ "$size" -le 67108864 ] || { rm -f "$TMPAUDIT"; die "per-user audit log $USER_LOG is larger than 64 MiB; seed it by hand (the per-boot count must survive)"; }
        echo "audit.jsonl: seeded from $USER_LOG ($size bytes)"
    else
        echo "audit.jsonl: created empty (no per-user log found${USER_LOG:+ at $USER_LOG})"
        if [ -z "$USER_LOG" ] && [ -z "$DESTDIR" ]; then
            echo "WARNING: no invoking user (PKEXEC_UID / SUDO_USER, not root) found, so no per-user audit log was seeded. If ~/.local/state/linux-xtu/audit.jsonl exists" >&2
            echo "         and this boot already spent mailbox operations, stop here: the per-boot operation count (an indicator, default cap 100000) restarts from zero (D-030)." >&2
        fi
    fi
    chmod 0600 "$TMPAUDIT"
    if [ "$(id -u)" -eq 0 ]; then chown root:root "$TMPAUDIT"; fi
    mv -T -- "$TMPAUDIT" "$AUDIT"
fi

# --- 5b. the boot restore units (D-053 item 3): packaged, installed DISABLED; a foreign one was described above and is replaced only with the flag ------
if [ "${#FOREIGN_RESTORE[@]}" -gt 0 ]; then
    refuse_if_restore_busy "before the foreign boot restore unit is replaced"
    if [ "$SYSTEMD" -eq 1 ]; then systemctl disable --now ${FOREIGN_RESTORE[@]+"${FOREIGN_RESTORE[@]}"} 2>/dev/null || true; fi
    BACKUP=$STATE/replaced-units/$STAMP
    install -d -m 0700 ${OWN[@]+"${OWN[@]}"} "$STATE/replaced-units" "$BACKUP"
    for u in ${FOREIGN_RESTORE[@]+"${FOREIGN_RESTORE[@]}"}; do
        cp --no-dereference --preserve=mode,timestamps -- "$UNITS/$u" "$BACKUP/$u" || die "could not back up $UNITS/$u (nothing of it was removed)"
        rm -f -- "$UNITS/$u"
        echo "replaced $UNITS/$u (the old file is in $BACKUP/$u)"
    done
    for u in ${FOREIGN_RESTORE[@]+"${FOREIGN_RESTORE[@]}"}; do  # the old enablement must not enable the new unit
        for w in "$UNITS"/*.wants/"$u"; do
            if [ -L "$w" ]; then rm -f -- "$w"; echo "removed the old enablement link $w"; fi
        done
    done
fi
copy_one "$SRC/packaging/linux-xtu-restore.service" "$UNITS/linux-xtu-restore.service" 0644
copy_one "$SRC/packaging/linux-xtu-restore.timer" "$UNITS/linux-xtu-restore.timer" 0644

# --- 5c. the socket's group (D-053 item 4): created, and every user of the allowlist in it --------------------------------------------------------
NEW_MEMBERS=()
if [ "$SOCKET_MODE" = 0660 ] && [ -z "$DESTDIR" ]; then
    if ! getent group "$SOCKET_GROUP" >/dev/null 2>&1; then
        groupadd --system "$SOCKET_GROUP" || die "could not create the group $SOCKET_GROUP (the socket is root:$SOCKET_GROUP 0660; or install with --socket-mode 0666)"
        echo "group $SOCKET_GROUP: created (the helper socket's group)"
    fi
    MEMBERS=$(cd / && "$PYTHON" -I "$LIB/linux-xtu-access" "$ETC/helper.toml" --list) || die "could not read the allowlist of $ETC/helper.toml"
    ACCESS_GROUP=$(cd / && "$PYTHON" -I "$LIB/linux-xtu-access" "$ETC/helper.toml" --list-group) || die "could not read the allowlist of $ETC/helper.toml"
    if [ -n "$ACCESS_GROUP" ] && [ "$ACCESS_GROUP" != "$SOCKET_GROUP" ]; then
        # [access] group = G admits G's members; the 0660 node must let them connect too: its members now (listed, and by primary group) join the socket's group
        if G_LINE=$(getent group "$ACCESS_GROUP"); then
            G_GID=$(printf '%s\n' "$G_LINE" | cut -d: -f3)
            MEMBERS="$MEMBERS"$'\n'"$(printf '%s\n' "$G_LINE" | cut -d: -f4 | tr ',' '\n')"$'\n'"$(getent passwd | awk -F: -v g="$G_GID" '$4 == g {print $1}')"
            echo "group $SOCKET_GROUP: the members of [access] group $ACCESS_GROUP join it too; someone who joins $ACCESS_GROUP later needs: sudo bash install.sh (again), or --socket-mode 0666"
        else
            echo "group $SOCKET_GROUP: [access] group $ACCESS_GROUP does not exist here; nobody is added for it" >&2
        fi
    fi
    while IFS= read -r u; do
        [ -n "$u" ] || continue
        [[ $u =~ $NAME_RE ]] || continue
        if ! getent passwd "$u" >/dev/null 2>&1; then echo "group $SOCKET_GROUP: $u is in the allowlist but not a user here; not added" >&2; continue; fi
        [ "$(id -u "$u" 2>/dev/null || echo 0)" != 0 ] || continue  # root needs no group
        if id -nG "$u" 2>/dev/null | tr ' ' '\n' | grep -qx "$SOCKET_GROUP"; then continue; fi
        usermod -a -G "$SOCKET_GROUP" "$u" || die "could not add $u to the group $SOCKET_GROUP"
        NEW_MEMBERS+=("$u")
    done < <(printf '%s\n' "$MEMBERS" | sort -u)
fi

# --- 5d. optional: the desktop entry of the AppImage, the msr module at boot ----------------------------------------------------------------------
if [ -n "$APPIMAGE" ]; then
    APPS=$DESTDIR/usr/share/applications
    ICONDIR=$DESTDIR/usr/share/icons/hicolor/128x128/apps
    mkdir -p "$APPS" "$ICONDIR"
    DTMP=$APPS/.linux-xtu.desktop.new.$$
    sed -e "s|@APPIMAGE@|$APPIMAGE|" -- "$SRC/packaging/linux-xtu.desktop" > "$DTMP"
    chmod 0644 "$DTMP"
    if [ "$(id -u)" -eq 0 ]; then chown root:root "$DTMP"; fi
    mv -T -- "$DTMP" "$APPS/linux-xtu.desktop"
    copy_one "$SRC/packaging/linux-xtu.png" "$ICONDIR/linux-xtu.png" 0644
    echo "desktop entry: $APPS/linux-xtu.desktop runs $APPIMAGE"
    if [ -z "$DESTDIR" ]; then
        if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications 2>/dev/null || true; fi
        if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t /usr/share/icons/hicolor 2>/dev/null || true; fi
    fi
elif [ -e "$DESTDIR/usr/share/applications/linux-xtu.desktop" ]; then
    echo "desktop entry: kept ($DESTDIR/usr/share/applications/linux-xtu.desktop; --appimage PATH points it at another AppImage)"
else
    echo "desktop entry: none (install.sh --appimage /ABSOLUTE/PATH/linux-xtu.AppImage adds one to the application menu)"
fi
if [ "$LOAD_MSR" -eq 1 ]; then
    mkdir -p "$DESTDIR/etc/modules-load.d"
    copy_one "$SRC/packaging/linux-xtu-modules.conf" "$DESTDIR/etc/modules-load.d/linux-xtu.conf" 0644
    echo "modules-load.d: msr is loaded at every boot from now on ($DESTDIR/etc/modules-load.d/linux-xtu.conf; this boot: modprobe msr, as a step of your own)"
fi

# --- 6. self-check: the installed tree, as the helper will see it --------------------------------------------------------------------
if [ -z "$DESTDIR" ]; then
    (cd / && "$PYTHON" -I /usr/lib/linux-xtu/linux-xtu-selfcheck) || die "post-install self-check FAILED: the helper would refuse to start. Run uninstall.sh or repair the files named above."
else
    echo "self-check: skipped (DESTDIR install: ownership cannot be verified)"
fi

# --- 6b. migration, last phase (D-054): the old install is retired - its units disabled and moved aside, its directories renamed; nothing is deleted -------
RETIRED=$STATE/migrated-from-arltuner-$STAMP
retire() {  # retire PATH: move PATH (a file or link of the old install) to $RETIRED/root/<PATH>, keeping it for a roll back
    local p=$1 rel
    [ -e "$p" ] || [ -L "$p" ] || return 0
    rel=${p#"$DESTDIR"}
    mkdir -p -- "$RETIRED/root$(dirname -- "$rel")"
    mv -T -- "$p" "$RETIRED/root$rel" || die "could not move $p to $RETIRED/root$rel"
    MIGRATED+=("$rel: moved to ${RETIRED#"$DESTDIR"}/root$rel")
}
group_line() {  # group_line NAME: the /etc/group line of NAME (the DESTDIR tree's own etc/group in a DESTDIR install), or nothing
    if [ -n "$DESTDIR" ]; then
        [ -f "$DESTDIR/etc/group" ] && awk -F: -v g="$1" '$1 == g' "$DESTDIR/etc/group" || true
    else
        getent group "$1" 2>/dev/null || true
    fi
}
if [ "$MIGRATION" -eq 1 ]; then
    refuse_if_restore_busy "before the old install is retired"
    FINISHING=1
    install -d -m 0700 ${OWN[@]+"${OWN[@]}"} "$RETIRED"
    if [ -z "$RESUME" ]; then  # written once, BEFORE anything is disabled: a re-run after a failure from here on reads it (review F5)
        {
            echo "# what the arltuner install had enabled when install.sh migrated it ($STAMP); the units themselves are under root/. A last line"
            echo "# 'complete' means the migration ended; without it, install.sh resumes it with this enabled set."
            echo "arltuner-helper.socket $([ "$OLD_SOCKET_ENABLED" -eq 1 ] && echo enabled || echo disabled)"
            echo "arltuner-restore.timer $([ "$OLD_RESTORE_ENABLED" -eq 1 ] && echo enabled || echo disabled)"
        } > "$RETIRED/enabled.txt"
    fi
    OLD_PRESENT=()
    for u in "${OLD_HELPER_UNITS[@]}" "${OLD_RESTORE_UNITS[@]}"; do
        if [ -e "$UNITS/$u" ] || [ -L "$UNITS/$u" ]; then OLD_PRESENT+=("$u"); fi
    done
    if [ "$SYSTEMD" -eq 1 ] && [ "${#OLD_PRESENT[@]}" -gt 0 ]; then
        systemctl disable --now ${OLD_PRESENT[@]+"${OLD_PRESENT[@]}"} 2>/dev/null || true
    fi
    for u in ${OLD_PRESENT[@]+"${OLD_PRESENT[@]}"}; do retire "$UNITS/$u"; done
    for w in "$UNITS"/*.wants/arltuner-*; do
        if [ -L "$w" ]; then rm -f -- "$w"; echo "removed the old enablement link ${w#"$DESTDIR"}"; fi
    done
    STOPPED_OLD_SOCKET=0  # review F4: its unit is retired; a later failure must not say "not migrated" nor start it
    RETIRED_DONE=1
    retire "$OLD_TMPF"
    l=$(first_line "$OLD_MODLOAD")
    if [ -n "$l" ] && [ "${l#"$OLD_FILE_MARK"}" != "$l" ]; then retire "$OLD_MODLOAD"; fi
    if [ -f "$OLD_DESKTOP" ] && [ ! -L "$OLD_DESKTOP" ] && grep -qx 'X-Arltuner-Packaged=true' "$OLD_DESKTOP"; then
        retire "$OLD_DESKTOP"
        retire "$OLD_ICON"
        if [ -z "$APPIMAGE" ]; then
            echo "NOTE: the arltuner desktop entry was moved aside: its AppImage talks to the old socket path. Add the new app: sudo bash install.sh --appimage /ABS/PATH/linux-xtu-<version>-x86_64.AppImage"
        fi
    fi
    for d in "$OLD_ETC" "$OLD_STATE" "$OLD_LIB" "$OLD_WEB_DIR"; do
        if [ -d "$d" ] && [ ! -L "$d" ]; then
            mv -T -- "$d" "$d.migrated-$STAMP" || die "could not rename $d to $d.migrated-$STAMP"
            MIGRATED+=("${d#"$DESTDIR"}: renamed ${d#"$DESTDIR"}.migrated-$STAMP (kept; delete it by hand once happy, docs/RUNBOOK-lnx.md §6; uninstall.sh --remove-migrated deletes it but uninstalls Linux XTU too)")
        fi
    done
    if [ -d "$DESTDIR/run/arltuner" ]; then MIGRATED+=("/run/arltuner: left as it is (a run-time directory: gone at the next boot)"); fi
    OLD_GROUP_LINE=$(group_line "$OLD_GROUP")
    if [ -n "$OLD_GROUP_LINE" ]; then
        OLD_MEMBERS=$(printf '%s\n' "$OLD_GROUP_LINE" | cut -d: -f4)
        if [ -n "$DESTDIR" ]; then
            MIGRATED+=("group $OLD_GROUP (members: ${OLD_MEMBERS:-none}): DESTDIR install, so group $SOCKET_GROUP was not created; on the real system it gets the same members")
        else
            if ! getent group "$SOCKET_GROUP" >/dev/null 2>&1; then
                groupadd --system "$SOCKET_GROUP" || die "could not create the group $SOCKET_GROUP"
            fi
            while IFS= read -r u; do
                [ -n "$u" ] && [[ $u =~ $NAME_RE ]] || continue
                if id -nG "$u" 2>/dev/null | tr ' ' '\n' | grep -qx "$SOCKET_GROUP"; then continue; fi
                usermod -a -G "$SOCKET_GROUP" "$u" || die "could not add $u to the group $SOCKET_GROUP"
                NEW_MEMBERS+=("$u")
            done < <(printf '%s\n' "$OLD_MEMBERS" | tr ',' '\n')
            MIGRATED+=("group $OLD_GROUP (members: ${OLD_MEMBERS:-none}): group $SOCKET_GROUP has the same members now; $OLD_GROUP is kept (groupdel $OLD_GROUP; uninstall.sh --remove-migrated deletes it but uninstalls Linux XTU too)")
        fi
    fi
    FINISHING=0
fi

# --- 6c. enable: the socket (a migration: only if the old install had its socket enabled) -----------------------------------------------------------
ENABLE_SOCKET=1
if [ "$MIGRATION" -eq 1 ] && [ "$OLD_SOCKET_PRESENT" -eq 1 ] && [ "$OLD_SOCKET_ENABLED" -eq 0 ]; then ENABLE_SOCKET=0; fi
if [ "$SYSTEMD" -eq 1 ]; then
    systemctl daemon-reload || die "systemctl daemon-reload failed"
    if [ "$ENABLE_SOCKET" -eq 1 ]; then
        systemctl enable --now linux-xtu-helper.socket || die "could not enable and start linux-xtu-helper.socket"
        echo "linux-xtu-helper.socket: enabled and listening on /run/linux-xtu/helper.sock (the helper starts on the first connect)"
    else
        echo "linux-xtu-helper.socket: installed, NOT enabled (the arltuner install had its socket disabled). Enable it (as root): systemctl enable --now linux-xtu-helper.socket"
    fi
elif [ -z "$DESTDIR" ]; then
    echo "systemd is not PID 1 here, so nothing was enabled. Start the helper yourself (as root):"
    echo "    /usr/bin/python3 -I /usr/lib/linux-xtu/linux-xtu-helper --device --socket"
elif [ "$MIGRATION" -eq 1 ] && [ "$OLD_SOCKET_ENABLED" -eq 1 ]; then  # DESTDIR: the link the old install had
    mkdir -p "$UNITS/sockets.target.wants"
    ln -sfn /etc/systemd/system/linux-xtu-helper.socket "$UNITS/sockets.target.wants/linux-xtu-helper.socket"
fi
if [ "$KEPT_MODE" -eq 1 ]; then echo "socket: kept the installed mode $SOCKET_MODE (--socket-mode 0660|0666 changes it)"; fi
if [ "$SOCKET_MODE" = 0660 ]; then
    echo "socket: /run/linux-xtu/helper.sock is root:$SOCKET_GROUP 0660 (D-053); the [access] allowlist in /etc/linux-xtu/helper.toml still decides who is admitted"
    if [ "${#NEW_MEMBERS[@]}" -gt 0 ]; then
        echo "NOTE: ${NEW_MEMBERS[*]+${NEW_MEMBERS[*]}} joined the group $SOCKET_GROUP: log out and back in (or reboot) before the desktop app can connect. (--socket-mode 0666 needs no re-login.)"
    fi
else
    echo "socket: /run/linux-xtu/helper.sock is mode 0666: any local user can connect; the [access] allowlist decides who is admitted (D-053 default: --socket-mode 0660)"
fi

# --- 7. the boot restore: enabled / disabled only on request; an upgrade keeps what was chosen; a migration keeps what the old install had --------------
WANTS=$UNITS/timers.target.wants/linux-xtu-restore.timer
if [ -z "$BOOT_RESTORE" ] && [ "$MIGRATION" -eq 1 ] && [ "$OLD_RESTORE_ENABLED" -eq 1 ]; then
    if [ "$SYSTEMD" -eq 1 ]; then
        systemctl enable linux-xtu-restore.timer || die "could not enable linux-xtu-restore.timer"  # never --now: a boot timer that is late fires at once
    else
        mkdir -p "$UNITS/timers.target.wants"
        ln -sfn /etc/systemd/system/linux-xtu-restore.timer "$WANTS"
    fi
    echo "boot restore: ENABLED from the next boot, as the arltuner install had it (it applies only while /var/lib/linux-xtu/bootrestore.json is armed; this script never arms; state below)"
else
case $BOOT_RESTORE in
    enable)
        if [ "$SYSTEMD" -eq 1 ]; then
            systemctl enable linux-xtu-restore.timer || die "could not enable linux-xtu-restore.timer"  # never --now: a boot timer that is late fires at once
        elif [ -n "$DESTDIR" ]; then
            mkdir -p "$UNITS/timers.target.wants"
            ln -sfn /etc/systemd/system/linux-xtu-restore.timer "$WANTS"
        fi
        echo "boot restore: ENABLED from the next boot (linux-xtu-restore.timer: apply /etc/linux-xtu/accepted 60 s after boot, with the crash-loop guard)"
        if [ -z "$DESTDIR" ]; then
            if (cd / && "$PYTHON" -I /usr/lib/linux-xtu/linux-xtu-restore arm); then :; else
                echo "WARNING: the boot restore is enabled but NOT armed (see the reason above): every boot will skip it, visibly, until root runs: /usr/lib/linux-xtu/linux-xtu-restore arm" >&2
            fi
        else
            echo "boot restore: not armed (DESTDIR install): arm it on the target with /usr/lib/linux-xtu/linux-xtu-restore arm"
        fi
        ;;
    disable)
        if [ "$SYSTEMD" -eq 1 ]; then systemctl disable linux-xtu-restore.timer 2>/dev/null || true; fi
        if [ -L "$WANTS" ]; then rm -f -- "$WANTS"; fi
        if [ -z "$DESTDIR" ]; then (cd / && "$PYTHON" -I /usr/lib/linux-xtu/linux-xtu-restore disarm --reason "disabled by install.sh --disable-boot-restore") || true; fi
        if [ -z "$DESTDIR" ]; then echo "boot restore: DISABLED (the timer is off and the state disarmed)"; else echo "boot restore: DISABLED (the timer is off)"; fi
        ;;
    *)
        ENABLED=0
        if [ "$SYSTEMD" -eq 1 ]; then systemctl is-enabled --quiet linux-xtu-restore.timer 2>/dev/null && ENABLED=1; elif [ -L "$WANTS" ]; then ENABLED=1; fi
        if [ "$ENABLED" -eq 1 ]; then
            echo "boot restore: enabled (kept). Turn it off: sudo bash install.sh --disable-boot-restore; its state: /usr/lib/linux-xtu/linux-xtu-restore status"
        else
            echo "boot restore: installed, DISABLED. Turn it on (applies the accepted state at every boot, crash-loop guarded): sudo bash install.sh --enable-boot-restore"
        fi
        ;;
esac
fi

if [ "$MIGRATION" -eq 1 ]; then
    BR_STATE=none
    if [ -e "$STATE/bootrestore.json" ]; then BR_STATE=$(br_state "$STATE/bootrestore.json"); fi
    echo "== migrated the arltuner install to linux-xtu ($STAMP) =="
    for line in ${MIGRATED[@]+"${MIGRATED[@]}"}; do echo "  $line"; done
    echo "  units: arltuner-helper.socket was $([ "$OLD_SOCKET_ENABLED" -eq 1 ] && echo enabled || echo "not enabled") -> linux-xtu-helper.socket $([ "$ENABLE_SOCKET" -eq 1 ] && echo enabled || echo "not enabled");" \
         "the packaged arltuner-restore.timer was $([ "$OLD_RESTORE_ENABLED" -eq 1 ] && echo enabled || echo "not enabled (or not packaged)")${RESUME:+ (as recorded in ${RESUME#"$DESTDIR"}/enabled.txt by the earlier run)}"
    echo "  boot restore state /var/lib/linux-xtu/bootrestore.json: $BR_STATE (armed = applied at the next boot if the timer is enabled; this script never arms or re-arms)"
    echo "  the old AppImage cannot reach the new socket: use a linux-xtu AppImage (desktop/tools/build-appimage.sh). Roll back: docs/RUNBOOK-lnx.md §6"
    echo complete >> "$RETIRED/enabled.txt"
fi
echo "Linux XTU installed. Start the desktop app (the AppImage; build: desktop/tools/build-appimage.sh). No password: the helper admits the users in /etc/linux-xtu/helper.toml [access]. Scriptable access: python3 tools/helperctl.py preflight"
