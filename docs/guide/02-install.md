# 02 Install, update, reset, remove

This page covers getting the code onto the machine and what the installer puts where. It is for anyone who has met the
[requirements](01-requirements.md). Every command here is read from `install.sh` / `uninstall.sh`.

## 1. Get the code
```
git clone https://github.com/xyehya/linux-xtu
cd linux-xtu
```
The checkout is only ever **copied** by the installer. The installed copy is what the root helper runs; the helper refuses to run from a
user-writable path (SPEC §4.4). The restore script `tools/lnx/restore_tuning.sh` is the exception: it runs the checkout's Python with `sudo`, in isolated mode (`python3 -I`, G-142), as the
command-line path (D-031), so keep your checkout writable only by you.

## 2. Optional: run the offline test suite
```
python3 tools/run_tests.py
```
This uses a hardware simulator and fake files; it touches no hardware, needs no root and takes a few minutes. The README estimates about 3 minutes
and about 2250 tests. A green run proves the code works as designed, not that your CPU will accept a given tuning.

## 3. Install
```
sudo bash install.sh
```
Run it from the checkout, as root, through `sudo` (so the installer knows which user to allow, see below). Close the desktop app first. A running helper is stopped by the installer itself
(the socket and service units, or SIGTERM to a helper you started by hand, waiting for an operation in flight to finish); it refuses only if a helper cannot be stopped.

What it does, in order:

| Step | Result |
|---|---|
| Copies and precompiles the Python package | `/usr/lib/linux-xtu/linux_xtu/`, platform files in `/usr/lib/linux-xtu/platforms/`, launcher `/usr/lib/linux-xtu/linux-xtu-helper` (0755, the service's `ExecStart`), self-check `/usr/lib/linux-xtu/linux-xtu-selfcheck`, allowlist editor `/usr/lib/linux-xtu/linux-xtu-access` |
| Removes the web GUI files of an older install (D-053) | `/usr/share/arltuner/web/` |
| Installs the helper units | `/etc/systemd/system/linux-xtu-helper.socket` and `linux-xtu-helper.service`. With systemd as PID 1 the **socket** is enabled and started (`systemctl enable --now linux-xtu-helper.socket`): systemd listens on `/run/linux-xtu/helper.sock` and starts the root helper on the first connection. An old polkit action file from an earlier install is removed. There is no polkit and no password prompt anywhere |
| Installs the boot restore units | `/etc/systemd/system/linux-xtu-restore.service` and `.timer`, **disabled** (README section 8; `--enable-boot-restore` enables and arms) |
| Creates the socket group | group `linux-xtu`; the socket node is `root:linux-xtu 0660` and every allowlisted user is added to the group (`--socket-mode 0666`: no group) |
| Optional: menu entry | `--appimage /ABS/PATH` writes `/usr/share/applications/linux-xtu.desktop` (running that AppImage) and `/usr/share/icons/hicolor/128x128/apps/linux-xtu.png` |
| Optional: `msr` at boot | `--load-msr` writes `/etc/modules-load.d/linux-xtu.conf` (Debian/Ubuntu; the driver is built into Fedora's kernel) |
| Installs `tmpfiles.d` | `/usr/lib/tmpfiles.d/linux-xtu.conf`, creating `/run/linux-xtu` (mailbox lock directory, root, 0755) |
| Seeds the configuration **only if absent** | `/etc/linux-xtu/policy.toml` from `policies/default.toml`; `/etc/linux-xtu/helper.toml` with `allow_taint_bits = [2]` and the **allowlist** `[access] users = ["you"]`: the user who ran `sudo bash install.sh` (`SUDO_USER`), only if the allowlist is empty. Root is never added |
| Leaves your accepted state alone | `/etc/linux-xtu/accepted/` is never created, changed or removed by the installer. A fresh install has none: you create it in the app ([09](09-profiles-and-restore.md)) |
| Creates the state directory | `/var/lib/linux-xtu/` with the audit log `audit.jsonl` (0600) and root-only (0700) directories `curves/`, `stress/`, `profiles/`, `state/` |
| Seeds the audit log once | from the invoking user's own `~/.local/state/linux-xtu/audit.jsonl` if it exists (so the per-boot operation count survives a mid-boot install; this is the log the command line writes before the install); otherwise an empty log. An existing log is never overwritten |
| Runs a self-check | prints one `ok` line per check and `linux-xtu self-check: all N checks passed.` The helper refuses to start if any check fails |

The installer **never applies any tuning and sends no mailbox traffic.** Everything installed is root-owned; the installer only runs Python from the
installed copy, in isolated mode with working directory `/`.

If the policy file already exists the installer prints `policy.toml: KEPT` when it differs from `policies/default.toml`, or `policy.toml: unchanged`.
Your edited policy is never overwritten (except with `--reseed-config`, below).

If the self-check fails, run `sudo bash uninstall.sh` or repair the files it names; do not start the app.

### Who may use the helper: the allowlist
The helper socket is `root:linux-xtu 0660` (D-053): only members of the group `linux-xtu` can open it. The installer creates the group and adds every allowlisted user; a newly added member
**logs out and back in once** (a group takes effect in a new login; `id -nG` shows it). `--socket-mode 0666` is the older open form (any local user can connect, no re-login). Either way the helper checks the connecting process's user id (`SO_PEERCRED`) against the list in `/etc/linux-xtu/helper.toml`
at **every connection** and closes anything else with `ACCESS_DENIED`. Root is admitted only if listed by name (the installer never adds it). Only one client is served at a time.

```toml
# /etc/linux-xtu/helper.toml (root-owned)
allow_taint_bits = [2]
idle_exit_s = 600          # socket-activated service exits after this many idle seconds (0 = never)
[access]
users = ["alice", "bob"]   # user names; optional: group = "somegroup" admits that group's members
```
Add another user with `sudo bash install.sh --add-user NAME` (repeatable); with the default socket mode that user logs out and in once (group `linux-xtu`). The allowlist change itself is picked up at the next connection. An existing
allowlist is never dropped, not even by `--reseed-config`. If nobody is allowed (for example you installed from a plain root login) the installer warns, the preflight check `helper_service` reports it, and
the app's Setup screen says how to fix it ([11](11-troubleshooting-faq.md)). What this means for security: [12 §7](12-safety-and-internals.md).

### Without systemd
The code does not depend on systemd. If systemd is not PID 1, the installer enables nothing and prints the command to run the helper yourself, as root, in a terminal or from your init system:
```
sudo /usr/bin/python3 -I /usr/lib/linux-xtu/linux-xtu-helper --device --socket
```
It creates `/run/linux-xtu/helper.sock` itself (it refuses to remove a node something still listens on) and serves until SIGTERM or until it has been idle for `idle_exit_s`.

### Limits: what the program refuses (D-049)
The helper refuses only what **your CPU** or the kernel cannot take, read live: the OC ratio limit (mailbox command `0x01`), the maximum voltage (`0x28`), the
offset field (-1000 ... +999 mV), the power-limit register's lock and field (MSR `0x610`), the cpufreq and uncore windows. There are no operator value limits
any more: an older `policy.toml` with `offset_ceiling_mv`, step limits, `[ratio_max]`, `[v_target_max_mv]`, `[power]` or `[runtime]` still loads, those keys are
ignored and one warning line names them. Large single changes and deep offsets are **warnings in the Review**, not refusals. D-053 item 5 added rules of the app:
positive point offsets are refused in place and a rising turbo table is refused. What `policy.toml` still decides: which mailbox requests and MSRs are
allowed at all (`[[allow]]`, `[[msr_allow]]`, default deny) and the operation counters (indicators, 100000 per boot). Always on: one mailbox transaction at
a time, health check, audit log, plan nonce, read-back. Details: the header of `policies/default.toml`, [12 §4](12-safety-and-internals.md).

## 4. Update
```
# close the desktop app first
git pull
sudo bash install.sh
```
Rebuild the AppImage from the same checkout (README section 4: the app and the helper must be from one release). The installer replaces code, the unit files and the tmpfiles file, and keeps `policy.toml`, the `helper.toml` allowlist, the accepted state, curves,
profiles, stress results and the audit log.

**An install from before the rename** (the project was called `arltuner`; names in `docs/NAMING.md`): the same `sudo bash install.sh` migrates it once. It
copies `/etc/arltuner` and `/var/lib/arltuner` (policy, allowlist, accepted state with its fingerprint, audit log, boot restore state, curves, profiles) to
`/etc/linux-xtu` and `/var/lib/linux-xtu` with their modes and owners, installs the new units, enables what the old install had enabled, and renames the old
directories `*.migrated-<UTC>` (nothing is deleted; the old units go to `/var/lib/linux-xtu/migrated-from-arltuner-<UTC>/`). It prints what moved. A boot
restore unit of the old name that the installer did not make needs `--replace-boot-restore`. Use a `linux-xtu` AppImage afterwards: an older one cannot
reach the new socket. `sudo bash uninstall.sh --remove-migrated` deletes the leftovers (and uninstalls).

## 5. Reset the policy to the shipped default
```
sudo bash install.sh --reseed-config
```
This replaces `/etc/linux-xtu/policy.toml` with the shipped version and puts the other `helper.toml` settings (`allow_taint_bits`) back to their defaults. Anything you added (for example a fixed E-core
ratio ceiling) is lost; keep a copy first. The `[access]` allowlist always stays. It does not touch the accepted state or the audit log. `install.sh -h` prints the header comment.

## 6. Remove
| Command | Removes | Keeps |
|---|---|---|
| `sudo bash uninstall.sh` | stops and disables the helper units and removes them; removes `/usr/lib/linux-xtu`, the menu entry and icon and `/etc/modules-load.d/linux-xtu.conf` if `install.sh` made them (and the web GUI files and polkit action of an old install, if any) | `/etc/linux-xtu` (policy, `helper.toml` with its allowlist, accepted state), `/var/lib/linux-xtu` (audit log, curves, profiles), the tmpfiles file, `/run/linux-xtu` |
| `sudo bash uninstall.sh --purge --yes-reset-budget` | everything above, plus config, audit log, curves, profiles, the tmpfiles file and `/run/linux-xtu` | nothing |

`--purge` deletes the audit log, which **resets the per-boot operation count**. The script therefore insists on the second flag, and
`--yes-reset-budget` alone is refused. Purge right before a reboot. A plain uninstall keeps the policy on purpose: while `/etc/linux-xtu/policy.toml`
exists the command line still counts as "installed" and keeps using the shared audit log and lock (D-030).

## 7. Packaging and test installs
`DESTDIR=/some/dir sudo bash install.sh` installs into that tree instead of `/` (used by the tests and for packaging). It skips ownership changes,
`systemd-tmpfiles` and the live self-check. It is not a way to run the app without root.

## 8. Troubleshooting the install
| Message | Meaning |
|---|---|
| `must run as root (sudo bash install.sh)` | run with sudo |
| `a linux-xtu-helper process is running (pid N): stop the GUI / helper first` | a helper the installer could not stop (a DESTDIR install never stops one); stop it (`sudo systemctl stop linux-xtu-helper.socket linux-xtu-helper.service`, or SIGTERM), then re-run |
| `--add-user: root is never added to the allowlist` / `has uid 0` | root cannot be put in the allowlist; add the ordinary account instead |
| `WARNING: nobody is allowed to use the helper yet` | no invoking user was found (plain root login); run `sudo bash install.sh --add-user NAME` |
| `could not enable and start linux-xtu-helper.socket` | systemd refused the unit; `systemctl status linux-xtu-helper.socket` and `journalctl -u linux-xtu-helper` say why |
| `... must be Python >= 3.12` | the system `/usr/bin/python3` is too old |
| `incomplete checkout` / `is a symlink; refusing` | the checkout is damaged or contains symlinks where the installer expects files |
| `post-install self-check FAILED` | the installed tree does not satisfy the helper's trust rules; uninstall and re-install |
| `WARNING: no invoking user ... so no per-user audit log was seeded` | you ran `install.sh` as a plain root login, not via `sudo`; only matters if you already used the command line this boot (the per-boot operation count restarts from zero) |

Next: [03 First run](03-first-run.md) · Previous: [01 Requirements](01-requirements.md)
