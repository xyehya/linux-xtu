<#
  restore_tuning.ps1 (alias: Apply-Profile.ps1) - apply YOUR saved profile with one command and prove it by read-back.
    powershell -ExecutionPolicy Bypass -File tools\win\Apply-Profile.ps1 [-From DIR] [-Policy FILE] [-Yes]
    -From DIR     the saved profile folder, as the Linux app exports it: CURRENT (names ONE profile), profiles\<name>.toml, EXPECTED-words.txt, fingerprint.json, policy.toml.
                  Default %ProgramData%\linux-xtu\accepted. Nothing in this repository is one (D-036): absent = stop.
                  A machine set up before the rename (D-054) has %ProgramData%\arltuner instead: while %ProgramData%\linux-xtu does not exist, that
                  folder is used for everything below, with a one-line note (rename it to linux-xtu when convenient).
    -Policy FILE  the policy for the guarded writes (default DIR\policy.toml).
    -Yes          skip the typed CONFIRM prompt (you start the script yourself; it is never scheduled or run unattended).
  Runs elevated, so everything that decides what it does (saved profile, policy, driver, audit log, read-back file, logs) must sit in an admin-only directory
  (%ProgramData%\linux-xtu, locked down by 'py -3 tools\win\ts_driver.py init-dir'); the script refuses a -From / -Policy directory that is not.
  Steps: checks (admin, XtuService stopped, no OCCT/XTU/ThrottleStop running, admin-only directories) -> one CONFIRM -> driver started for this run -> apply the profile
  (one guarded run that writes only the words that differ; the planner orders the writes, G-151) -> vf-dump read-back -> compare every V/F word with EXPECTED-words.txt
  -> driver stopped and its service deleted. The WHEA health gate runs inside the apply. Stops at the first failure; nothing is retried. Revert = cold boot.
  The ring (cache) is restored and compared like the cores when the saved profile has a [ring] section and EXPECTED-words.txt a "ring" line (G-154).
  The profile is applied with --neutralize-residual; the verdict is 'linux-xtu compare-accepted' (EQUIVALENT counts as success, only a real difference is BAD).
  Logs: %ProgramData%\linux-xtu\logs\. Audit: %ProgramData%\linux-xtu\audit.jsonl.
#>
param([switch]$Yes, [string]$From = '', [string]$Policy = '')
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repo
$lm = Join-Path $env:ProgramData 'linux-xtu'   # the admin-only directory (created and locked down by ts_driver.py init-dir)
$legacyLm = Join-Path $env:ProgramData 'arltuner'   # the same folder under the project's earlier name (D-054); ts_driver.py data_dir() makes the same choice
if (-not (Test-Path -LiteralPath $lm) -and (Test-Path -LiteralPath $legacyLm)) {
    $lm = $legacyLm
    Write-Host "NOTE: using $legacyLm (the folder of the project's earlier name); rename it once from an Administrator terminal: Rename-Item '$legacyLm' linux-xtu" -ForegroundColor Yellow
}
if (-not $From) { $From = Join-Path $lm 'accepted' }
$audit = Join-Path $lm 'audit.jsonl'
$ts = Get-Date -Format 'yyyyMMddTHHmmss'

function Fail([string]$msg) { Write-Host "STOP: $msg" -ForegroundColor Red; Write-Host 'RESULT: FAILED - the profile was NOT verified; a cold boot returns the BIOS state.' -ForegroundColor Red; exit 1 }

# --- checks
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'not elevated' }
$xtu = Get-Service XtuService -ErrorAction SilentlyContinue
if ($xtu -and $xtu.Status -ne 'Stopped') { Fail 'XtuService is running (Stop-Service XtuService)' }
$busy = Get-Process OCCT, XtuUiLauncher, PerfTune, ThrottleStop -ErrorAction SilentlyContinue
if ($busy) { Fail "close first: $(($busy.Name | Sort-Object -Unique) -join ', ')" }

# --- the saved profile (D-036): absent = stop
$wordsFile = Join-Path $From 'EXPECTED-words.txt'
if (-not (Test-Path (Join-Path $From 'CURRENT')) -or -not (Test-Path $wordsFile)) {
    Fail "no saved profile in $From (CURRENT and EXPECTED-words.txt are needed). Copy the app's accepted-state folder there, or pass -From DIR"
}
$fingerprint = Join-Path $From 'fingerprint.json'
if (-not (Test-Path $fingerprint)) { Fail "no fingerprint.json in $From. Re-accept on Linux to record the fingerprint and copy the folder here again, or pass -From DIR" }
$policy = if ($Policy) { $Policy } else { Join-Path $From 'policy.toml' }
if (-not (Test-Path $policy)) { Fail "policy $policy not found: copy policy.toml next to the saved profile or pass -Policy FILE" }
$profiles = @()
foreach ($l in Get-Content (Join-Path $From 'CURRENT')) {   # a legacy 'policy =' line is ignored: the policy is -Policy / DIR\policy.toml
    if ($l -match '^\s*profile\s*=\s*"?([^"#]+?)"?\s*$') {
        $rel = $Matches[1]
        if ($rel -notmatch '^profiles/[A-Za-z0-9._-]+\.toml$' -or $rel.Contains('..') -or -not (Test-Path (Join-Path $From ($rel -replace '/', '\')))) { Fail "CURRENT names an unusable profile '$rel'" }
        $profiles += (Join-Path $From ($rel -replace '/', '\'))
    }
}
if ($profiles.Count -eq 0) { Fail "$From\CURRENT lists no profile" }
if ($profiles.Count -gt 1) {   # D-044: never replay a chain
    Fail "$From\CURRENT lists $($profiles.Count) profiles (a chain from before complete profiles). The saved state is ONE complete profile: run 'accepted-migrate' once on the machine that exported it, then copy the folder here again"
}
$prof = $profiles[0]
$Expected = [ordered]@{}
# EXPECTED-words.txt: one line per core / E-cluster "<cpu> <OC word P2=0> <point 1> ... <point n>" (hex, no 0x), plus optionally "ring <OC word> <point 1> ... <point n>" (G-154).
# String keys: an [ordered] dictionary indexed with an int is positional, so the first token is kept a string ('ring' is a key like '0' or '8').
foreach ($l in Get-Content $wordsFile) {
    if ($l -match '^\s*(#|$)') { continue }
    $parts = $l.Trim() -split '\s+'
    $Expected[$parts[0]] = (($parts[1..($parts.Count - 1)] | ForEach-Object { [Convert]::ToUInt32($_, 16).ToString('X') }) -join ' ')
}
if ($Expected.Count -eq 0) { Fail "$wordsFile holds no words" }

# -I: isolated Python (no PYTHON* variables, no user site, no script directory or cwd on sys.path); tools\linux-xtu.py adds .\src from its own path
if (Get-Command py -ErrorAction SilentlyContinue) { $py = @('py', '-3', '-I') } else { $py = @('python', '-I') }
function Ts-Driver { & $py[0] @($py[1..9] | Where-Object { $_ }) 'tools\win\ts_driver.py' @args }

# --- admin-only directories: create/lock down the data directory, then refuse any input directory a non-admin could write
if (-not (Test-Path $lm)) { Ts-Driver init-dir; if ($LASTEXITCODE -ne 0) { Fail 'could not create the admin-only directory' } }
foreach ($d in @($lm, $From, (Split-Path -Parent (Resolve-Path $policy)))) {
    Ts-Driver check-dir $d | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "$d is not an admin-only directory (ts_driver.py check-dir). Copy the saved profile / policy into $lm from an Administrator terminal, or pass -From / -Policy pointing there" }
}
$logDir = Join-Path $lm 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$env:LINUX_XTU_ALLOW_MAILBOX = '1'
$env:PYTHONUNBUFFERED = '1'

# --- the one confirmation for the whole run
if (-not $Yes) {
    Write-Host "Apply the saved profile: $(Split-Path $prof -Leaf)  (from $From, policy $policy; one run, only the words that differ)"
    Write-Host 'Writes V/F point offsets via the ThrottleStop driver; every write is read back; revert = cold boot.'
    if ((Read-Host 'Type CONFIRM to proceed') -cne 'CONFIRM') { Fail 'not confirmed - nothing was sent' }
}

# One linux-xtu command. confirm_relay.py forwards the CLI's own per-command token: the confirmation above (or -Yes) is the operator's decision for this whole run.
function Run-Lm([string]$tag, [string[]]$LmArgs) {
    $f = Join-Path $logDir "apply-$ts-$tag.txt"
    $cmd = @($py[1..9] | Where-Object { $_ }) + @('tools\linux-xtu.py') + $LmArgs + @('--device-win', '--fingerprint', $fingerprint, '--policy', $policy, '--audit', $audit)
    & $py[0] @($py[1..9] | Where-Object { $_ }) 'tools\win\confirm_relay.py' $py[0] @cmd *> $f
    $rc = $LASTEXITCODE
    Get-Content $f | Select-String 'identity check passed|Result:|refus|REFUS|mismatch|WHEA|RING NOT RESTORED' | ForEach-Object { '  ' + $_.Line.Trim() }
    if ($rc -ne 0) { Fail "$tag failed (exit $rc), see $f" }
}

# --- driver: a service for this run only, created from the SHA-256-verified copy in the admin-only directory, deleted again in the finally block below
Ts-Driver start
if ($LASTEXITCODE -ne 0) { Fail 'ThrottleStop driver not started (run once: py -3 tools\win\ts_driver.py carve --exe <your ThrottleStop.exe>, then re-run)' }
Ts-Driver status
if ($LASTEXITCODE -ne 0) { Fail 'driver status not OK' }

try {
    Write-Host "=== 1/2 apply $prof"
    Run-Lm ([IO.Path]::GetFileNameWithoutExtension($prof)) @('apply', $prof, '--neutralize-residual')
    Write-Host "=== 2/2 read-back"
    # The verdict comes from THIS run's live read-back: vf-dump writes its own JSON into the admin-only directory - not from the audit file.
    $readback = Join-Path $lm "readback-$ts.json"
    Remove-Item -LiteralPath $readback -ErrorAction SilentlyContinue
    Run-Lm 'after' @('vf-dump', '--json', $readback)
    if (-not (Test-Path -LiteralPath $readback)) { Fail "vf-dump wrote no read-back file ($readback)" }
    # The verdict is the CLI's compare-accepted; the OC point's slot rule and the write order are the shared Python's (G-151), not this script's.
    $cmp = & $py[0] @($py[1..9] | Where-Object { $_ }) 'tools\linux-xtu.py' 'compare-accepted' '--readback' $readback '--expected' $wordsFile '--fingerprint' $fingerprint
    $cmpRc = $LASTEXITCODE
    $cmp | ForEach-Object { Write-Host "$_" }
    if ($cmpRc -ne 0) { Fail 'the read-back differs from the saved profile (or the compare could not run); cold boot = BIOS state' }
    $ringWord = if ($Expected.Contains('ring')) { ' + the ring' } else { '' }
    $unitCount = if ($Expected.Contains('ring')) { $Expected.Count - 1 } else { $Expected.Count }
    Write-Host "RESULT: OK - $(Split-Path $prof -Leaf) applied and verified word for word ($unitCount cores/clusters$ringWord). Offsets stay until a cold boot." -ForegroundColor Green
}
finally {
    Ts-Driver remove | Out-Null   # stop + delete the per-run service
    Write-Host 'driver stopped and its service deleted.'
}
