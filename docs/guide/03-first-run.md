# 03 First run

This page covers starting the desktop app for the first time, how it connects to the root helper (no password), the Setup screen, the parts of the
window, and the System screen's preflight. It is for someone who has built the AppImage and run `install.sh` ([02](02-install.md), README sections 4
and 5). The step-by-step first session is in the [README](../../README.md) sections 6 and 7; this page is the reference behind it.

## 1. Start the app
From the application menu (**Linux XTU**, if you installed with `--appimage`), or:
```
~/Applications/linux-xtu-<version>-x86_64.AppImage
```
`--version` prints the version and the "not affiliated with Intel" line and exits without opening a window.

What happens:

1. The app (a Rust shell with a WebKitGTK web view; the UI files are inside the AppImage, nothing is loaded from the network) connects to the root helper
   on `/run/linux-xtu/helper.sock`. There is **no password prompt** and no polkit: systemd starts the helper on the first connection (socket activation).
2. Before it sends anything, the app checks that the socket node is owned by root and that the process listening on it is root.
3. The helper admits you if your user name is in the allowlist of `/etc/linux-xtu/helper.toml` (the installer put the user who ran `sudo bash install.sh`
   there). To reach the socket at all you need the group `linux-xtu` (socket mode 0660, D-053): log out and in once after the install.
4. The app declares its protocol version; a helper of another release is shown on the Setup screen (writes off, reading allowed).

The helper serves **one client at a time**: one app window, or `tools/helperctl.py`, or the terminal restore, or the boot restore. It exits by itself after
about 10 idle minutes; systemd starts it again at the next connection. Closing the app changes nothing on the CPU: whatever was applied stays until a cold
boot. Settings (refresh rate, hints, notifications) are kept in `~/.config/org.linuxxtu.desktop/settings.json`.

## 2. The Setup screen
While the app cannot use the helper it shows **Setup** in place of the other screens: a band naming the case, a title, the exact command (with **Copy
command**) and **Retry**. The app never runs `sudo` itself. The cases and their fixes are in [11 §2](11-troubleshooting-faq.md) and the README section 6.1.
The one you are most likely to meet right after installing is `socket not readable` ("The helper socket cannot be opened"): you have not logged out and
in since the installer added you to the group `linux-xtu`.

## 3. The window
| Part | What it shows |
|---|---|
| Top bar | `HELPER` link · `WRITES` (lit `READ-ONLY` when tuning is off; click for the reason) · `UVP` (`?`, `OFF`, `ON`) · `ACCEPTED` (`none` / `matches` / `differs · n`, with **Restore accepted…** when it differs) · `READ` time and the **Read** button with its cost in mailbox requests · `MBX` (requests this boot) |
| Left rail | **Overview** (Alt+1), **Tune** (2: Cores, Frequency, Power, Ring & uncore), **Stress** (3), **Curves** (4), **Profiles** (5), **Audit** (6), **System** (7), **Tips** at the foot (F1 / Alt+8) |
| Context line | one line about the control you are on; **F1 Tips** and **Hints on / Quiet** at its right |
| Pending row | only while you have edits: the count, the first edits, **Discard all** and **Review n edits…** (Ctrl+Enter) |
| Readout bar | PKG, CLK, HOT, VCORE, CORE, DRAM live values (click to expand to 60 s sparklines) and the limit indicators PL1, PL2, PL4, THERM, VR, TURBO |

Colours mean the same everywhere: white = measured or read back, grey = factory, cyan = your edit the CPU does not hold yet, orange = the one button that
writes. **Tips** is the in-app reading path for newcomers (nine sections, about ten minutes); F1 on a control opens the tip about it. **Hints: Quiet** hides
the context line; reasons, refusals and Tips stay.

The VID shown per core is the voltage the core *requests* (MSR `0x198` bits 47:32 divided by 8192), not a measurement of the delivered voltage; no such
telemetry exists on this platform [MEASURED lnx 2026-10-01, platform-arl-s.md §5].

## 4. Preflight (System screen)
**System** › **Preflight** lists one line per check with a result glyph (✓ pass, ✕ fail, ? unknown) and the detail; **Re-run** checks again (no
mailbox request). The top bar's `WRITES` / `READ-ONLY` summarises it.

| Mode | Meaning |
|---|---|
| `write` | every check passed; tuning is possible |
| `read-only` | at least one check failed that blocks writes; Overview and Curves measurement still work, but Tune cannot read or apply (a mailbox read is a write) |
| `refuse` | the app cannot run (Python older than 3.12) |

| Check | Passes when | Typical fix |
|---|---|---|
| `cpuid` | family 6, model 198 and a known stepping on every CPU | none: another CPU is not supported |
| `hypervisor` | no `hypervisor` flag in `/proc/cpuinfo` | run on bare metal |
| `lockdown` | `/sys/kernel/security/lockdown` is `[none]` (or absent) | disable Secure Boot or boot a kernel without lockdown |
| `topology` | P and E CPU sets read from sysfs, E clusters of equal size | none: the CPU is not an Arrow Lake-S layout |
| `msr_device` | `/dev/cpu/N/msr` for every CPU | `sudo modprobe msr` (`install.sh --load-msr` for every boot) |
| `msr_allow_writes` | not `off` (`?` when the file could not be read; the root helper decides before every write) | boot with `msr.allow_writes=on` |
| `helper_service` | the socket exists, is a root-owned socket, and the allowlist admits somebody | `sudo bash install.sh`; `sudo bash install.sh --add-user NAME` |
| `python` | 3.12 or newer | update Python |
| `tool:*` | optional tools found; `missing: install <pkg>` otherwise (never changes the mode) | install the package ([01](01-requirements.md)) |

The root helper re-runs the checks before every write and refuses unless the mode is `write` (D-027). **System** also shows **Limits from this CPU**
(the CPU's own ratio and voltage limits, read live), the helper and link, the topology, the settings, and the boot restore state when the boot restore is
installed.

## 5. A safe first look (no writes)
1. **System**: the mode should be `write`; fix anything listed above first.
2. **Tips**: read 01 and 03.
3. **Overview**: every P-core and E-cluster shows a clock, load and VID; favored P-cores are marked ★.
4. **Read** (top bar): the CPU's V/F points, ratios and tables. A series of mailbox reads, each one a WRMSR; allowed in `write` mode only. It changes no
   tuning value.
5. **Curves** › **Measure** (Quick) right after a cold boot, then **Set as baseline** in the Library ([05](05-measuring-curves.md)). It writes only cpufreq
   limits (restored afterwards) and sends no mailbox traffic.
6. Read [04 Arrow Lake V/F primer](04-arrow-lake-vf-primer.md) before your first Apply.

Next: [04 Arrow Lake V/F primer](04-arrow-lake-vf-primer.md) · Previous: [02 Install](02-install.md)
