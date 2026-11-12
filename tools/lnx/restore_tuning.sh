#!/usr/bin/env bash
# restore_tuning.sh - after any Fedora boot: bring the CPU back to YOUR accepted tuning and PROVE it word for word. Host lnx.
#   bash tools/lnx/restore_tuning.sh              # the installed accepted state: type CONFIRM once (D-020a)
#   bash tools/lnx/restore_tuning.sh --check      # read-only: read every word back and compare (mailbox reads are WRMSRs: still one CONFIRM)
#   --from DIR     another accepted-state directory (CURRENT naming ONE profile, EXPECTED-words.txt, profiles/<name>.toml), e.g. a candidate state
#   --policy FILE  with --from only: the root policy of the guarded writes (default /etc/linux-xtu/policy.toml; it must be root-owned, not group/world-writable)
# The accepted state is the user's (D-036): the app writes it (Profiles > Set as accepted); nothing in this repo is one. With none, this stops.
#
# Root never runs code from this checkout (SPEC 4.4, assessment 06 F3):
#   * default (/etc/linux-xtu/accepted): the INSTALLED root helper restores it through its socket. tools/lnx/restore_accepted.py runs as YOU (no sudo): it shows
#     the helper's plan, asks "Type CONFIRM" once, then tune.apply (one guarded run, G-148 / D-044: only the words that differ, transition-safe order G-151,
#     a residual OC point rewritten to run the accepted voltages G-147, the ring G-154 / D-045), tune.read and the helper's word-for-word compare. Close the
#     desktop app first (one client at a time).
#   * --from DIR: the INSTALLED CLI /usr/lib/linux-xtu/linux-xtu-cli as root (sudo). The CLI asks for its own "CONFIRM <token>" before each hardware command
#     (apply, vf-dump); nothing answers it for you (the auto-confirm wrapper and --orchestrated are gone). The read-back is judged by compare-accepted
#     (as you, no hardware): OK / EQUIVALENT (G-147) / BAD; "RING NOT RESTORED" means the ring alone was refused (D-045).
# G-154 (D-045): the ring (cache, mailbox domain P1 = 2) is part of the accepted state: EXPECTED-words.txt has one "ring  <OC word> <point 1> ... <point n>" line
# and the profile a [ring] section; the one apply writes the ring points that differ (the ring OC word is BIOS-owned, never written). If the live ring OC word is
# not the accepted one, ONLY the ring is refused ("RING NOT RESTORED"), the P/E units are still restored and the verdict reports the ring BAD.
# An accepted state that is still a chain (CURRENT with several 'profile =' lines, written before G-148) is refused: run 'accepted-migrate' once.
# Run records go to $XDG_STATE_HOME/linux-xtu/runs/ (default ~/.local/state/linux-xtu/runs/), never into the checkout. Stops at the first failure.
# Revert = cold boot. The first MSR write of a boot sets taint bit 2 (CPU_OUT_OF_SPEC): expected.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
installed=/etc/linux-xtu/accepted; cli=/usr/lib/linux-xtu/linux-xtu-cli
check=0; from=$installed; policy=/etc/linux-xtu/policy.toml; policy_given=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check=1;;
    --from) from="${2:?--from needs a directory}"; shift;;
    --policy) policy="${2:?--policy needs a file}"; policy_given=1; shift;;
    *) echo "unknown arg $1"; exit 2;;
  esac
  shift
done
from="${from%/}"
if [ "$from" = "$installed" ] && [ "$policy_given" = 1 ]; then echo "STOP: --policy goes with --from only (the helper always uses the installed /etc/linux-xtu/policy.toml)"; exit 2; fi
[ -f "$from/CURRENT" ] && [ -f "$from/EXPECTED-words.txt" ] \
  || { echo "STOP: no accepted state in $from. Save a profile as accepted in the app first (Profiles > Set as accepted)."; exit 2; }
mapfile -t profiles < <(awk '/^profile *=/{sub(/^profile *= */,""); gsub(/"/,""); print}' "$from/CURRENT")
[ "${#profiles[@]}" -gt 0 ] || { echo "STOP: $from/CURRENT lists no profile"; exit 2; }
if [ "${#profiles[@]}" -gt 1 ]; then  # G-148 (D-044): never replay a chain
  echo "STOP: $from/CURRENT lists ${#profiles[@]} profiles (an accepted chain from before G-148). The accepted state is ONE complete profile now (D-044)."
  echo "      Migrate it once (it builds the profile from EXPECTED-words.txt, never from a read, and keeps a backup):"
  echo "      sudo $cli accepted-migrate --dir $from --dry-run   # look first, then run it without --dry-run"
  exit 2
fi
prof="${profiles[0]}"
printf '%s\n' "$prof" | grep -Eq '^profiles/[A-Za-z0-9._-]+\.toml$' && [[ "$prof" != *..* ]] && [ -f "$from/$prof" ] || { echo "STOP: $from/CURRENT names an unusable profile '$prof'"; exit 2; }
pgrep -x OCCT >/dev/null 2>&1 && pgrep -u root -x OCCT >/dev/null 2>&1 && { echo "STOP: OCCT runs as root (it writes the mailbox) - close it"; exit 2; }
runs="${XDG_STATE_HOME:-$HOME/.local/state}/linux-xtu/runs"
ts="$(date -u +%Y%m%dT%H%M%SZ)"

if [ "$from" = "$installed" ]; then  # the helper's path: as YOU, through its socket; the helper reads the installed policy and accepted state only
  args=(); [ "$check" = 1 ] && args+=(--check)
  exec python3 -I "$here/restore_accepted.py" --runs "$runs" ${args[@]+"${args[@]}"}
fi

# --from DIR: the installed CLI as root; each hardware command asks for its own CONFIRM <token>
[ -f "$policy" ] || { echo "STOP: policy $policy not found (run install.sh, or pass --policy FILE)"; exit 2; }
echo "Policy:   $policy"; echo "Profile:  $from/$prof"; echo "Expected: $from/EXPECTED-words.txt"
[ "$check" = 1 ] && echo "Mode: --check (mailbox reads only, no offset writes)" || echo "Mode: APPLY the profile above in one run (only the words that differ), then read back and compare"
echo "Each hardware command of the installed CLI then asks for its own CONFIRM <token> (apply, vf-dump)."
read -r -p "Type CONFIRM to proceed: " ans
[ "$ans" = "CONFIRM" ] || { echo "not confirmed - nothing was sent"; exit 1; }
# the policy decides what root may send: only a root-owned, not group/world-writable file (never one this user could edit)
[ ! -L "$policy" ] || { echo "STOP: policy $policy is a symlink; pass the file itself; nothing was sent"; exit 2; }
read -r p_uid p_mode < <(stat -c '%u %a' -- "$policy")
read -r d_uid d_mode < <(stat -L -c '%u %a' -- "$(dirname -- "$policy")")
[ "$p_uid" = 0 ] && [ $(( 8#$p_mode & 8#022 )) -eq 0 ] && [ "$d_uid" = 0 ] && [ $(( 8#$d_mode & 8#022 )) -eq 0 ] \
  || { echo "STOP: policy $policy (or its directory) is not root-owned or is writable by others (file uid $p_uid mode $p_mode, dir uid $d_uid mode $d_mode); nothing was sent"; exit 2; }
[ -x "$cli" ] || { echo "STOP: $cli is not installed: run sudo bash install.sh (root never runs this checkout's code)"; exit 2; }
mkdir -p -m 0700 "$runs"
sudo -v
root_tmp="$(sudo mktemp -d)"  # root writes the read-back here (a fresh 0700 root directory), never into a directory this user owns
trap 'sudo rm -rf -- "$root_tmp"' EXIT

cli_run() {  # one guarded command of the INSTALLED CLI as root; the human answers its CONFIRM <token>; the console output is also kept in the run record
  local tag="$1"; shift; local f="$runs/restore-$ts-$tag.txt"
  sudo env LINUX_XTU_ALLOW_MAILBOX=1 USER="$USER" "$cli" "$@" --device --policy "$policy" --allow-taint-bit 2 2>&1 | tee "$f" \
    || { echo "STOP: $tag failed (see $f)"; exit 1; }
}

bash "$here/health_snapshot.sh" "restore-$ts-before" >/dev/null 2>&1 || true
if [ "$check" = 0 ]; then
  # G-147: the apply also looks for a residual OC point (an OC ratio the accepted profile does not have; only a cold boot clears it) and rewrites it with a V target below the
  # accepted top fused point, so the unit runs the accepted voltage. G-148: one run, only the words that differ. G-151: the planner orders the writes (raising voltages first).
  # apply --device also lets scaling_max_freq follow a cpuinfo_max_freq that a 0x1D moved (never raising a cap you lowered).
  echo "=== apply $prof"; cli_run "apply-$(basename "$prof" .toml)" apply "$from/$prof" --neutralize-residual
fi
echo "=== read-back"
cli_run after vf-dump --json "$root_tmp/after.json"
sudo cat -- "$root_tmp/after.json" > "$runs/restore-$ts-after.json"
# the verdict is the CLI's compare-accepted (no hardware: as you): identical words are OK; a residual OC point that runs the accepted voltages (or an OC word that is the same
# state, e.g. 0x5B439 vs the cold 0x39) is EQUIVALENT and counts as success; anything else is BAD. fingerprint.json (written by 'Set as accepted') carries the fused words that
# tell a residual OC point from an OC point the accepted state has; without it only identical words match.
fp=(); [ -f "$from/fingerprint.json" ] && fp=(--fingerprint "$from/fingerprint.json")
"$cli" compare-accepted --readback "$runs/restore-$ts-after.json" --expected "$from/EXPECTED-words.txt" ${fp[@]+"${fp[@]}"}
bash "$here/health_snapshot.sh" "restore-$ts-after" --since "$runs/health-restore-$ts-before.txt" | tail -3 || true
