param(
    [string]$TargetDir = ""
)

$baseDir = if ($TargetDir) {
    $TargetDir.Trim('"', "'", ' ', "`t").TrimEnd('\', '/')
} else {
    (Split-Path -Parent $PSScriptRoot)
}
$appPidFile = Join-Path (Join-Path $baseDir "runtime") "app.pid"
$monPidFile = Join-Path (Join-Path $baseDir "runtime") "monitor.pid"

$canonicalScript = (Join-Path $baseDir "AgentPet.ps1").ToLower().Replace('/', '\')
$canonicalMonitor = (Join-Path (Join-Path $baseDir "runtime") "agent-monitor.mjs").ToLower().Replace('/', '\')

$stoppedCount = 0
$cannotConfirmCount = 0
$stillRunningCount = 0
$script:wmiFailed = $false

function Parse-PidInfo([string]$filePath) {
    if (-not (Test-Path $filePath)) { return $null }
    try {
        $raw = Get-Content $filePath -Raw -Encoding UTF8 -ErrorAction Stop
        if (-not $raw) { return $null }
        $rawTrim = $raw.Trim()
        # Try JSON first (P0-1 metadata format)
        try {
            $obj = $rawTrim | ConvertFrom-Json -ErrorAction Stop
            if ($obj -and $obj.pid) {
                return @{
                    Pid = [int]$obj.pid
                    Path = [string]$obj.path
                    BaseDir = [string]$obj.baseDir
                }
            }
        } catch {}
        # Fallback to plain int (backward compatibility)
        $v = 0
        if ([int]::TryParse($rawTrim, [ref]$v)) {
            return @{
                Pid = $v
                Path = ""
                BaseDir = ""
            }
        }
    } catch {}
    return $null
}

function Stop-TargetProcessById([int]$procId, [string]$expectedPathMatch, [string]$pidFilePath) {
    if ($procId -le 0 -or $procId -eq $PID) { return "Invalid" }
    
    # 1. Check if process is alive
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc) {
        # Process does not exist -> clean stale PID file
        if ($pidFilePath -and (Test-Path $pidFilePath)) {
            Remove-Item $pidFilePath -Force -ErrorAction SilentlyContinue
        }
        return "NotFound"
    }

    # 2. Verify process command line via WMI / CIM
    $wmiProc = $null
    try {
        $wmiProc = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction Stop
    } catch {
        $script:wmiFailed = $true
        Write-Host ("[Warning] 无法枚举进程 (WMI query failed for PID {0}): {1}" -f $procId, $_.Exception.Message)
        return "CannotConfirm"
    }

    if ($wmiProc -and $wmiProc.CommandLine) {
        $cmd = $wmiProc.CommandLine.ToLower().Replace('/', '\')
        if ($cmd.Contains($expectedPathMatch)) {
            try {
                Stop-Process -Id $procId -Force -ErrorAction Stop
                # Wait up to 3 seconds for exit confirmation
                $exited = $false
                for ($i = 0; $i -lt 15; $i++) {
                    Start-Sleep -Milliseconds 200
                    if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
                        $exited = $true
                        break
                    }
                }
                if ($exited) {
                    if ($pidFilePath -and (Test-Path $pidFilePath)) {
                        Remove-Item $pidFilePath -Force -ErrorAction SilentlyContinue
                    }
                    return "Stopped"
                } else {
                    return "StillRunning"
                }
            } catch {
                return "StillRunning"
            }
        } else {
            # PID exists but path does not match! PID reuse detected. DO NOT KILL, DO NOT DELETE PID FILE.
            Write-Host ("[Warning] PID {0} 正在运行但命令行不属于本项目，保留 PID 文件避免误杀。" -f $procId)
            return "PathMismatch"
        }
    } else {
        return "CannotConfirm"
    }
}

# 1. Check App PID
$appInfo = Parse-PidInfo $appPidFile
if ($appInfo) {
    $res = Stop-TargetProcessById $appInfo.Pid $canonicalScript $appPidFile
    switch ($res) {
        "Stopped"       { $stoppedCount++ }
        "CannotConfirm" { $cannotConfirmCount++ }
        "StillRunning"  { $stillRunningCount++ }
    }
}

# 2. Check Monitor PID
$monInfo = Parse-PidInfo $monPidFile
if ($monInfo) {
    $res = Stop-TargetProcessById $monInfo.Pid $canonicalMonitor $monPidFile
    switch ($res) {
        "Stopped"       { $stoppedCount++ }
        "CannotConfirm" { $cannotConfirmCount++ }
        "StillRunning"  { $stillRunningCount++ }
    }
}

# 3. Fallback scan bounded strictly to this directory (skip if WMI failed)
if (-not $script:wmiFailed) {
    try {
        $curPid = $PID
        $procs = Get-CimInstance Win32_Process | Where-Object {
            $_.ProcessId -ne $curPid -and $_.CommandLine -and (
                $_.CommandLine.ToLower().Replace('/', '\').Contains($canonicalScript) -or
                $_.CommandLine.ToLower().Replace('/', '\').Contains($canonicalMonitor)
            )
        }
        foreach ($p in $procs) {
            try {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
                for ($i = 0; $i -lt 10; $i++) {
                    Start-Sleep -Milliseconds 150
                    if (-not (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue)) { break }
                }
                $stoppedCount++
            } catch {}
        }
    } catch {
        $script:wmiFailed = $true
        Write-Host ("[Warning] 无法枚举进程进行兜底扫描: {0}" -f $_.Exception.Message)
    }
}

# 4. Final summary output (P0-2 distinct state reporting)
if ($stoppedCount -gt 0) {
    if ($stillRunningCount -gt 0) {
        Write-Host ("AgentPet 部分进程已停止 ({0} 个已终止，另有 {1} 个仍在运行)。" -f $stoppedCount, $stillRunningCount)
    } else {
        Write-Host ("AgentPet 已停止 ({0} 个进程已终止)。" -f $stoppedCount)
    }
} elseif ($stillRunningCount -gt 0) {
    Write-Host "AgentPet 仍在运行 (未能终止目标进程)。"
} elseif ($cannotConfirmCount -gt 0 -or $script:wmiFailed) {
    Write-Host "AgentPet 退出状态无法确认 (WMI 查询受限或异常)。"
} else {
    Write-Host ("未找到运行中的 AgentPet 进程 (目录: {0})。" -f $baseDir)
}
