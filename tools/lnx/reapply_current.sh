#!/usr/bin/env bash
# reapply_current.sh - kept as a name only (G-148, D-044): the accepted state is ONE complete profile now, so re-applying it IS the restore.
#   bash tools/lnx/reapply_current.sh [--check] [--from DIR] [--policy FILE]
# runs tools/lnx/restore_tuning.sh with the same arguments: by default the installed root helper restores /etc/linux-xtu/accepted through its socket (you
# type CONFIRM once; no sudo, no root code from this checkout); --from DIR uses the installed CLI as root. See restore_tuning.sh.
set -euo pipefail
exec bash "$(cd "$(dirname "$0")" && pwd)/restore_tuning.sh" "$@"
