param([string]$Project = (Split-Path $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('agentpet-mutex-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$prefix = "Local\AgentPet_Test_$([guid]::NewGuid().ToString('N'))"
$ps = Join-Path $PSHOME 'powershell.exe'
$source = [IO.File]::ReadAllText((Join-Path $Project 'AgentPet.ps1'))
$start = $source.IndexOf('# 1. Single-Instance')
$end = $source.IndexOf('# Record own PID metadata', $start)
if ($start -lt 0 -or $end -lt $start) { throw 'Missing startup guard' }
$guard = $source.Substring($start, $end-$start).Replace('Local\AgentPet_SingleInstance_Mutex', $prefix)
# Keep the entire real startup decision. Only suppress its modal notification in the child.
$guard = [regex]::Replace($guard, '(?m)^ *\[System.Windows.Forms.MessageBox\]::Show\([^\r\n]+', '    Write-PetLog "dialog suppressed"')
$probe = Join-Path $root 'probe.ps1'
$marker = Join-Path $root 'entered'
[IO.File]::WriteAllText($probe, ('$BaseDir=$PSScriptRoot' + [Environment]::NewLine + 'function Write-PetLog($text) {}' + [Environment]::NewLine + $guard + @'

[IO.File]::WriteAllText((Join-Path $BaseDir 'entered'), '1')
if ($args -contains 'hold') {
    for ($i=0; $i -lt 200 -and !(Test-Path (Join-Path $BaseDir 'release')); $i++) { Start-Sleep -Milliseconds 50 }
}
'@), [Text.Encoding]::UTF8)
$holder=$null
try {
    foreach ($name in @($prefix, ($prefix+'_p'))) {
        $legacy = [Threading.Mutex]::new($false, $name)
        try {
            & $ps -NoProfile -ExecutionPolicy Bypass -File $probe
            if ($LASTEXITCODE -ne 0 -or (Test-Path $marker) -or !(Test-Path (Join-Path $root 'wake.flag'))) {
                throw 'Running legacy instance was not recognized'
            }
            [IO.File]::Delete((Join-Path $root 'wake.flag'))
        } finally { $legacy.Dispose() }
    }
    $holder=Start-Process -FilePath $ps -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$probe+'" hold') -WindowStyle Hidden -PassThru
    for ($i=0; $i -lt 100 -and !(Test-Path $marker) -and !$holder.HasExited; $i++) { Start-Sleep -Milliseconds 50 }
    if (!(Test-Path $marker)) { throw 'New instance failed to start' }
    foreach ($name in @($prefix, ($prefix+'_p'))) {
        $created=$false
        $legacy=[Threading.Mutex]::new($true,$name,[ref]$created)
        try { if ($created) { $legacy.ReleaseMutex(); throw 'Legacy start passed while new pet was running' } }
        finally { $legacy.Dispose() }
    }
    [IO.File]::Delete($marker)
    & $ps -NoProfile -ExecutionPolicy Bypass -File $probe
    if ($LASTEXITCODE -ne 0 -or (Test-Path $marker) -or !(Test-Path (Join-Path $root 'wake.flag'))) { throw 'Duplicate new start passed' }
    [IO.File]::WriteAllText((Join-Path $root 'release'),'1')
    if (!$holder.WaitForExit(5000)) { throw 'Holder failed to exit' }
    & $ps -NoProfile -ExecutionPolicy Bypass -File $probe
    if ($LASTEXITCODE -ne 0 -or !(Test-Path $marker)) { throw 'Restart blocked after exit' }
    Write-Output 'PASS: cross-version single instance, duplicate wake and clean restart'
} finally {
    [IO.File]::WriteAllText((Join-Path $root 'release'),'1')
    if ($holder) { [void]$holder.WaitForExit(12000); $holder.Dispose() }
    foreach ($name in @('release','entered','wake.flag','probe.ps1')) { [IO.File]::Delete((Join-Path $root $name)) }
    [IO.Directory]::Delete($root)
}
