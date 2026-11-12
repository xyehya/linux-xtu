#!/bin/bash
# Linux XTU uninstall (G-106, R-R1). Run as root:   sudo bash uninstall.sh [--purge --yes-reset-budget] [--remove-migrated]
#
# Usage: uninstall.sh [--purge --yes-reset-budget] [--remove-migrated]   (--purge deletes the audit log, which RESETS the per-boot operation cap: it needs
#        the second flag)
#
# Stops and disables the helper units (linux-xtu-helper.socket / .service) and the boot restore (linux-xtu-restore.timer / .service) and removes them (a boot
# restore unit that install.sh did not install - no "# linux-xtu: packaged unit" first line - is left alone and named), then removes the code
# (/usr/lib/linux-xtu, the launchers with it), the desktop entry + icon and /etc/modules-load.d/linux-xtu.conf if install.sh made them, the web GUI files of an
# install before D-053 (/usr/share/arltuner/web) and the polkit action file of an old install, if any. Idempotent. The socket's group (linux-xtu) is kept
# (groupdel linux-xtu removes it).
# KEEPS /etc/linux-xtu (policy, restore.toml, helper.toml with its [access] allowlist, accepted state), /var/lib/linux-xtu (audit log, boot restore state), the
# tmpfiles.d file (/usr/lib/tmpfiles.d/linux-xtu.conf), /run/linux-xtu unless --purge: while /etc/linux-xtu/policy.toml stays, the CLI counts as installed
# (D-030), keeps the per-boot budget in /var/lib/linux-xtu/audit.jsonl and takes its lock in /run/linux-xtu/mailbox.lock, so a reinstall continues the same
# budget and history. --purge removes all of them; the CLI then returns to the per-user lock / audit paths and the per-boot operation count (an indicator,
# default cap 100000) restarts from zero, so purge only right before a reboot.
# --remove-migrated also deletes what install.sh left of a migrated arltuner install (D-054): /etc/arltuner.migrated-*, /var/lib/arltuner.migrated-*,
# /usr/lib/arltuner.migrated-*, /usr/share/arltuner.migrated-*, /var/lib/linux-xtu/migrated-from-arltuner-* (the old units), the *.bak-migration-* files in
# /etc/linux-xtu and /var/lib/linux-xtu, and the group arltuner unless /etc/linux-xtu/helper.toml still names it. An arltuner install that was never migrated
# is not touched (install.sh migrates it).
# DESTDIR=/some/dir removes from that tree instead (tests).
set -euo pipefail
export LC_ALL=C
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

die() { echo "uninstall.sh: $*" >&2; exit 1; }

PURGE=0
RESET_OK=0
REMOVE_MIGRATED=0
for arg in "$@"; do
    case $arg in
        --purge) PURGE=1 ;;
        --yes-reset-budget) RESET_OK=1 ;;
        --remove-migrated) REMOVE_MIGRATED=1 ;;
        -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown argument: $arg (usage: uninstall.sh [--purge --yes-reset-budget] [--remove-migrated])" ;;
    esac
done

[ "$PURGE" -eq 0 ] || [ "$RESET_OK" -eq 1 ] || die "--purge deletes /var/lib/linux-xtu/audit.jsonl, which RESETS the per-boot operation count (an indicator, default cap 100000) and the budget safety net; add --yes-reset-budget to confirm (nothing was removed)"
[ "$PURGE" -eq 1 ] || [ "$RESET_OK" -eq 0 ] || die "--yes-reset-budget only goes with --purge"

DESTDIR=${DESTDIR:-}
DESTDIR=${DESTDIR%/}
if [ -n "$DESTDIR" ]; then
    case $DESTDIR in /*) ;; *) die "DESTDIR must be an absolute path" ;; esac
else
    [ "$(id -u)" -eq 0 ] || die "must run as root (sudo bash uninstall.sh)"
fi

SYSTEMD=0  # real run on a systemd system: stop and disable the units; a DESTDIR run never touches the live system
if [ -z "$DESTDIR" ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then SYSTEMD=1; fi
UNITS=$DESTDIR/etc/systemd/system
PACKAGED_MARK='# linux-xtu: packaged unit'
ours() {  # ours FILE: a regular file whose first line starts with install.sh's mark
    local first
    [ -f "$1" ] && [ ! -L "$1" ] || return 1
    first=$(head -n 1 -- "$1" 2>/dev/null || true)
    [ "${first#"$PACKAGED_MARK"}" != "$first" ]
}
RESTORE_UNITS=()
for u in linux-xtu-restore.timer linux-xtu-restore.service; do
    if ours "$UNITS/$u"; then RESTORE_UNITS+=("$u"); elif [ -e "$UNITS/$u" ] || [ -L "$UNITS/$u" ]; then echo "kept $UNITS/$u: install.sh did not install it (no '$PACKAGED_MARK' line); remove it yourself if it is yours to remove"; fi
done
if [ "$SYSTEMD" -eq 1 ]; then
    systemctl disable --now linux-xtu-helper.socket linux-xtu-helper.service 2>/dev/null || true
    systemctl stop linux-xtu-helper.service 2>/dev/null || true  # a connected client's operation completes (TimeoutStopSec)
    # the boot restore: a run in flight stops at a safe point (TimeoutStopSec); only units install.sh made are touched
    if [ "${#RESTORE_UNITS[@]}" -gt 0 ]; then systemctl disable --now ${RESTORE_UNITS[@]+"${RESTORE_UNITS[@]}"} 2>/dev/null || true; fi
fi
for u in ${RESTORE_UNITS[@]+"${RESTORE_UNITS[@]}"}; do
    for w in "$UNITS"/*.wants/"$u"; do
        if [ -L "$w" ]; then rm -f -- "$w"; echo "removed $w"; fi
    done
done
for w in "$UNITS"/*.wants/linux-xtu-helper.socket; do  # a DESTDIR migration's link (a live system: systemctl disable above)
    if [ -L "$w" ]; then rm -f -- "$w"; echo "removed $w"; fi
done

remove() {  # remove PATH...: each path is a fixed suffix under DESTDIR, never empty
    local p
    for p in "$@"; do
        if [ -e "$p" ] || [ -L "$p" ]; then rm -rf -- "$p"; echo "removed $p"; fi
    done
}

remove "$DESTDIR/etc/systemd/system/linux-xtu-helper.socket" \
       "$DESTDIR/etc/systemd/system/linux-xtu-helper.service" \
       "$DESTDIR/usr/lib/linux-xtu" \
       "$DESTDIR/usr/share/arltuner/web" \
       "$DESTDIR/usr/share/polkit-1/actions/io.github.arrowlake-tuner.helper.policy"
for u in ${RESTORE_UNITS[@]+"${RESTORE_UNITS[@]}"}; do remove "$UNITS/$u"; done
DESKTOP=$DESTDIR/usr/share/applications/linux-xtu.desktop
if [ -f "$DESKTOP" ] && [ ! -L "$DESKTOP" ] && grep -qx 'X-Linux-XTU-Packaged=true' "$DESKTOP"; then
    remove "$DESKTOP" "$DESTDIR/usr/share/icons/hicolor/128x128/apps/linux-xtu.png"
elif [ -e "$DESKTOP" ] || [ -L "$DESKTOP" ]; then
    echo "kept $DESKTOP: install.sh did not write it"
fi
MODLOAD=$DESTDIR/etc/modules-load.d/linux-xtu.conf
MODLOAD_HEAD=$( { [ -f "$MODLOAD" ] && [ ! -L "$MODLOAD" ] && head -n 1 -- "$MODLOAD"; } 2>/dev/null || true)
if [ "${MODLOAD_HEAD#'# linux-xtu: packaged file'}" != "$MODLOAD_HEAD" ]; then
    remove "$MODLOAD"
elif [ -e "$MODLOAD" ] || [ -L "$MODLOAD" ]; then
    echo "kept $MODLOAD: install.sh did not write it"
fi
if [ "$SYSTEMD" -eq 1 ]; then systemctl daemon-reload 2>/dev/null || true; fi
rmdir "$DESTDIR/usr/share/arltuner" 2>/dev/null && echo "removed $DESTDIR/usr/share/arltuner" || true

# --- what a migration from the earlier name left (D-054): only with --remove-migrated -----------------------------------------------------------
LEFTOVERS=()
for p in "$DESTDIR"/etc/arltuner.migrated-* "$DESTDIR"/var/lib/arltuner.migrated-* "$DESTDIR"/usr/lib/arltuner.migrated-* "$DESTDIR"/usr/share/arltuner.migrated-* \
         "$DESTDIR"/var/lib/linux-xtu/migrated-from-arltuner-*; do
    if [ -e "$p" ] || [ -L "$p" ]; then LEFTOVERS+=("$p"); fi
done
for d in "$DESTDIR/etc/linux-xtu" "$DESTDIR/var/lib/linux-xtu"; do
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    while IFS= read -r -d '' p; do LEFTOVERS+=("$p"); done < <(find "$d" -xdev -name '*.bak-migration-*' -print0)
done
OLD_GROUP_LINE=""
if [ -z "$DESTDIR" ]; then OLD_GROUP_LINE=$(getent group arltuner 2>/dev/null || true); fi
if [ "$REMOVE_MIGRATED" -eq 1 ]; then
    for p in ${LEFTOVERS[@]+"${LEFTOVERS[@]}"}; do remove "$p"; done
    if [ -n "$OLD_GROUP_LINE" ]; then
        if grep -qE '^[[:space:]]*group[[:space:]]*=[[:space:]]*"arltuner"' "$DESTDIR/etc/linux-xtu/helper.toml" 2>/dev/null; then
            echo "kept the group arltuner: /etc/linux-xtu/helper.toml [access] still names it"
        else
            groupdel arltuner && echo "removed the group arltuner" || echo "could not remove the group arltuner (groupdel arltuner)" >&2
        fi
    fi
    [ "${#LEFTOVERS[@]}" -gt 0 ] || [ -n "$OLD_GROUP_LINE" ] || echo "no leftovers of a migrated arltuner install"
elif [ "${#LEFTOVERS[@]}" -gt 0 ] || [ -n "$OLD_GROUP_LINE" ]; then
    echo "kept ${#LEFTOVERS[@]} leftover(s) of the migrated arltuner install${OLD_GROUP_LINE:+ and the group arltuner} (--remove-migrated deletes them)"
fi
for p in "$DESTDIR/etc/arltuner" "$DESTDIR/var/lib/arltuner" "$DESTDIR/usr/lib/arltuner"; do
    if [ -e "$p" ]; then echo "note: $p belongs to an arltuner install that was never migrated: not touched (install.sh migrates it)"; fi
done

if [ "$PURGE" -eq 1 ]; then
    remove "$DESTDIR/usr/lib/tmpfiles.d/linux-xtu.conf" "$DESTDIR/run/linux-xtu" "$DESTDIR/etc/linux-xtu" "$DESTDIR/var/lib/linux-xtu"
    echo "purged config (the allowlist with it), audit log, tmpfiles.d file and lock directory. The CLI is back on the per-user lock/audit paths; its per-boot operation count restarts from zero: reboot before the next hardware write."
else
    for keep in "$DESTDIR/etc/linux-xtu" "$DESTDIR/var/lib/linux-xtu" "$DESTDIR/usr/lib/tmpfiles.d/linux-xtu.conf" "$DESTDIR/run/linux-xtu"; do
        if [ -e "$keep" ]; then echo "kept $keep (--purge removes it)"; fi
    done
fi
