# ROLLBACK — dsh-instruction-memory verification (step 1 deliverable)
#
# Restores the state captured before the verification run. Every command uses
# environment variables, so nothing here is machine-specific.
#
#   pwsh -File rollback-instruction-memory.ps1
#
# Two independent levels:
#   A. data rollback  - restore the memory store from the step-1 backup
#   B. plugin removal - take the plugin out of the web profile entirely

$ErrorActionPreference = 'Stop'
$DSH  = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$STORE = Join-Path $DSH 'instruction-memory'
$PROF  = Join-Path $DSH 'profiles\web'
$BK    = Join-Path $PSScriptRoot 'backup'

Write-Host '=== A. data rollback ==='
$src = Join-Path $BK 'prod-store\memory.json'
if (-not (Test-Path $src)) { throw "backup missing: $src" }

Write-Host ("before : " + (Get-FileHash (Join-Path $STORE 'memory.json') -Algorithm SHA256).Hash)
Copy-Item $src (Join-Path $STORE 'memory.json') -Force
Remove-Item (Join-Path $STORE 'memory.json.bak') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $STORE 'memory.json.tmp') -Force -ErrorAction SilentlyContinue
$after = (Get-FileHash (Join-Path $STORE 'memory.json') -Algorithm SHA256).Hash
Write-Host "after  : $after"

# Expected value for the original store on this machine:
#   06013E41FA12E0F2F963405A6AA794F73DCC161AE5CFB6B66D9BB818F7B57C43
Write-Host 'Expected sha256 of the original store: 06013E41FA12E0F2F963405A6AA794F73DCC161AE5CFB6B66D9BB818F7B57C43'

Write-Host ''
Write-Host 'The running host holds memory in RAM and does not watch the file.'
Write-Host 'Reload it without a restart (the same route the settings page uses):'
Write-Host '  node .\scripts\im-api.mjs reload'
Write-Host 'Or simply restart DSH, which re-reads the store at boot.'

Write-Host ''
Write-Host '=== B. profile config rollback (only if you also changed the profile) ==='
Write-Host "  Copy-Item (Join-Path '$BK' 'profile\package.json') (Join-Path '$PROF' 'package.json') -Force"
Write-Host '  # then restart DSH'

Write-Host ''
Write-Host '=== C. full plugin removal ==='
Write-Host '  node install.mjs --remove     # drops the profile junction + bundle entry'
Write-Host '  dsh plugin --profile web remove dsh-instruction-memory'
