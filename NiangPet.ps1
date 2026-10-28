# ============================================================================
# NiangPet.ps1 - Backward Compatibility Forwarder
# Forwards execution to AgentPet.ps1 with single canonical codebase
# ============================================================================
$target = Join-Path $PSScriptRoot "AgentPet.ps1"
if (Test-Path $target) {
    & $target @args
} else {
    Write-Error "AgentPet.ps1 not found in $PSScriptRoot"
}
