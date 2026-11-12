# Windows: apply a saved profile with one PowerShell command

Windows support is deliberately small. It does one thing: re-apply a profile you saved earlier and prove, by reading every word back, that the CPU now holds it. There is
no tuning, monitoring or editing on Windows.

## What you need

| Item | Notes |
|---|---|
| Windows 11 on the Core Ultra 9 285K, native (no hypervisor) | See "Limits". |
| An **elevated** PowerShell | Run as administrator. |
| Python 3 (`py -3` or `python`), standard library only | Nothing to install with pip. |
| This repository, in a folder only administrators can write to | The script runs elevated and executes code from the checkout. |
| A saved-profile folder | The accepted-state folder: `CURRENT`, `profiles\<name>.toml`, `EXPECTED-words.txt`, `fingerprint.json` (copy of `/etc/linux-xtu/accepted/`), plus `policy.toml` (copy of `/etc/linux-xtu/policy.toml`, which is not inside `accepted/`). Commands: README section 9. |
| **Your own `ThrottleStop.exe`, version 9.7.3** | The only low-level access to the CPU's mailbox on Windows is ThrottleStop's signed driver. It is **not shipped or downloaded** by this project: you download ThrottleStop yourself (the pinned SHA-256 of the exe is in `tools\win\ts_driver.py`) and the tool cuts the driver out of your copy, verifying both hashes. |
| Memory integrity (HVCI) off, Microsoft Vulnerable Driver Blocklist off | Windows Security > Device security > Core isolation; reboot after each change. Re-enable both afterwards. Otherwise Windows refuses to load the driver (errors 1275 / 577 / "blocked"). |
| Intel XTU service stopped (`Stop-Service XtuService`), and OCCT, XTU, HWiNFO, ThrottleStop closed | They are mailbox clients too; the script refuses while they run. |

## One-time setup (elevated PowerShell, in the repository folder)

```
py -3 tools\win\ts_driver.py init-dir
py -3 tools\win\ts_driver.py carve --exe <path to your ThrottleStop.exe>
robocopy <your saved-profile folder> "$env:ProgramData\linux-xtu\accepted" /E /PURGE
```

`init-dir` creates `%ProgramData%\linux-xtu`, readable and writable by administrators and SYSTEM only. Everything the script trusts lives there: the carved driver, the saved
profile, the audit log, the read-back file and the logs. `carve` refuses unless the exe and the cut driver match their pinned hashes.

## The command

```
powershell -ExecutionPolicy Bypass -File tools\win\Apply-Profile.ps1
```

`tools\win\restore_tuning.ps1` is the same script under its older name; both take the same options:

| Option | Meaning |
|---|---|
| `-From DIR` | The saved-profile folder (default `%ProgramData%\linux-xtu\accepted`; on a machine set up before the rename, D-054, `%ProgramData%\arltuner\accepted` while `%ProgramData%\linux-xtu` does not exist, with a one-line note). It must be admin-only; the script checks. |
| `-Policy FILE` | Policy for the guarded writes (default `DIR\policy.toml`). |
| `-Yes` | Skip the typed prompt. You still start the script yourself; do not schedule it. |

## What it does and prints

1. Checks: elevated, XTU service stopped, no other mailbox client running, `-From` and the policy in an admin-only directory, `fingerprint.json` present, `CURRENT` naming exactly one profile.
2. Asks once: `Type CONFIRM to proceed` (unless `-Yes`).
3. Loads the ThrottleStop driver for this run only, with the hash and ACL checks repeated immediately before loading.
4. Identity check: reads the fused V/F word of every P-core and of each E-cluster and matches them with `fingerprint.json`, so the profile lands on the right cores. Any mismatch stops the run before a write.
5. Applies the profile in one guarded run that writes only the words that differ, one mailbox transaction at a time, each write read back and judged against the CPU's own limits; the Windows Hardware Error (WHEA) log is checked before and after.
6. Reads every V/F word back and compares it with `EXPECTED-words.txt`.
7. Stops the driver and deletes its service (also when something failed).

The last line says what happened:

```
RESULT: OK - <profile>.toml applied and verified word for word (<n> cores/clusters). Offsets stay until a cold boot.
RESULT: FAILED - the profile was NOT verified; a cold boot returns the BIOS state.
```

A failure stops at the first problem, prints `STOP: <reason>` and retries nothing. Per-step logs are in `%ProgramData%\linux-xtu\logs\`, the audit trail in `%ProgramData%\linux-xtu\audit.jsonl`.

## Undo

Nothing is permanent. The values live in the CPU until power is removed: **a cold boot (full shutdown, then power on) restores the BIOS values.** A warm restart can leave some offsets in
place; the script copes with that and rewrites only what differs. Re-apply after every cold boot you want the profile for.

## Limits

- **WSL2 / Hyper-V / virtualization-based security block the mailbox.** With the hypervisor running, the driver still loads but the first identity read returns a fused word of `0x0`, the guard
  refuses, and nothing is written. Turn those features off (and reboot) for the sitting.
- The ThrottleStop driver has been abused by malware and may be blocked by Windows policy now or later. If it will not load, there is no fallback on Windows.
- The driver can read and write any model-specific register while loaded. The script loads it only for the run, only administrators and SYSTEM can open it, and it is removed afterwards.
  Do not leave it loaded by hand.
- Only the saved profile's words are written; values outside the CPU's own reported limits are refused. The script is never a substitute for stability testing.
