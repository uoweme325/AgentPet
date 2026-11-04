$dir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$ErrorActionPreference = 'Continue'
$log = Join-Path $dir "runtime-error.log"
"Starting..." | Set-Content $log -Encoding UTF8

$psFile = Join-Path $dir "AgentPet.ps1"
if (-not (Test-Path -LiteralPath $psFile -PathType Leaf)) { Write-Error "AgentPet.ps1 is missing. Please extract the complete AgentPet package again."; exit 1 }

$global:Error.Clear()
try {
    & $psFile
} catch {
    "CATCH: $($_.Exception.ToString())" | Add-Content $log -Encoding UTF8
}

if ($global:Error.Count -gt 0) {
    "ERRORS:" | Add-Content $log -Encoding UTF8
    $global:Error | ForEach-Object { $_.ToString() } | Add-Content $log -Encoding UTF8
}
"End." | Add-Content $log -Encoding UTF8
