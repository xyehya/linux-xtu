<#
  Apply-Profile.ps1 - apply your saved profile with one command (alias of restore_tuning.ps1; both names work and take the same options).
    powershell -ExecutionPolicy Bypass -File tools\win\Apply-Profile.ps1 [-From DIR] [-Policy FILE] [-Yes]
  Options and behaviour: see the header of restore_tuning.ps1 and docs\RUNBOOK-win.md.
#>
param([switch]$Yes, [string]$From, [string]$Policy)
& (Join-Path $PSScriptRoot 'restore_tuning.ps1') @PSBoundParameters
exit $LASTEXITCODE
