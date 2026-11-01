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

try {
    if (-not ("AgentPetStopNative" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AgentPetStopNative {
    public delegate bool EnumWndProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWndProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    public const uint WM_CLOSE = 0x0010;
    public static bool PostCloseToProcess(int targetPid) {
        bool posted = false;
        EnumWindows((hWnd, lParam) => {
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == (uint)targetPid) {
                var sb = new System.Text.StringBuilder(256);
                GetWindowTextW(hWnd, sb, 256);
                if (sb.ToString().IndexOf("AgentPet", StringComparison.OrdinalIgnoreCase) >= 0) {
                    PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                    posted = true;
                }
            }
            return true;
        }, IntPtr.Zero);
        return posted;
    }
}
"@ -ErrorAction SilentlyContinue
    }
} catch {}

function Stop-ProcessGracefullyThenForce([int]$targetPid, [bool]$isAppProcess = $false) {
    $stopFlagPath = Join-Path (Join-Path $baseDir "runtime") "stop.flag"
    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($proc) {
        try {
            $sentClose = $false
            if ($isAppProcess) {
                try {
                    [System.IO.File]::WriteAllText($stopFlagPath, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString(), [System.Text.Encoding]::UTF8)
                    $sentClose = $true
                } catch {}
                # Wait 400ms first so the 250ms DispatcherTimer can process stop.flag in both visible and hidden-to-tray states
                Start-Sleep -Milliseconds 400
                if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
                    if (Test-Path $stopFlagPath) { Remove-Item $stopFlagPath -Force -ErrorAction SilentlyContinue }
                    return $true
                }
            }
            if ("AgentPetStopNative" -as [type]) {
                if ([AgentPetStopNative]::PostCloseToProcess($targetPid)) { $sentClose = $true }
            } elseif ((-not $isAppProcess) -and $proc.MainWindowHandle -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
                [void]$proc.CloseMainWindow()
                $sentClose = $true
            }
            if ($sentClose) {
                for ($g = 0; $g -lt 6; $g++) {
                    Start-Sleep -Milliseconds 200
                    if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
                        if (Test-Path $stopFlagPath) { Remove-Item $stopFlagPath -Force -ErrorAction SilentlyContinue }
                        return $true
                    }
                }
            }
        } catch {}
    }
    if (Test-Path $stopFlagPath) { Remove-Item $stopFlagPath -Force -ErrorAction SilentlyContinue }
    if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {
        Stop-Process -Id $targetPid -Force -ErrorAction Stop
    }
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Milliseconds 200
        if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
            return $true
        }
    }
    return (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue))
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
                $isApp = ($expectedPathMatch -eq $canonicalScript)
                $exited = Stop-ProcessGracefullyThenForce $procId $isApp
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
        $procs = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.ProcessId -ne $curPid -and $_.CommandLine -and (
                $_.CommandLine.ToLower().Replace('/', '\').Contains($canonicalScript) -or
                $_.CommandLine.ToLower().Replace('/', '\').Contains($canonicalMonitor)
            )
        }
        foreach ($p in $procs) {
            try {
                $isApp = ($p.CommandLine -and $p.CommandLine.ToLower().Replace('/', '\').Contains($canonicalScript))
                $exited = Stop-ProcessGracefullyThenForce $p.ProcessId $isApp
                if ($exited) {
                    $stoppedCount++
                } else {
                    $stillRunningCount++
                }
            } catch {
                $cannotConfirmCount++
            }
        }
    } catch {
        $script:wmiFailed = $true
        $cannotConfirmCount++
        Write-Host ("[Warning] 无法枚举进程进行兜底扫描: {0}" -f $_.Exception.Message)
    }
}

# 4. Final summary output (P0-2 & WO-36 distinct state reporting)
$unresolvedCount = $stillRunningCount + $cannotConfirmCount
if ($stoppedCount -gt 0) {
    if ($unresolvedCount -gt 0 -or $script:wmiFailed) {
        Write-Host ("AgentPet 部分进程已停止 ({0} 个已终止，仍有 {1} 个在运行或无法确认)。" -f $stoppedCount, [Math]::Max(1, $unresolvedCount))
    } else {
        Write-Host ("AgentPet 已停止 ({0} 个进程已终止)。" -f $stoppedCount)
    }
} elseif ($stillRunningCount -gt 0) {
    Write-Host ("AgentPet 仍在运行 (有 {0} 个进程未能终止)。" -f $stillRunningCount)
} elseif ($cannotConfirmCount -gt 0 -or $script:wmiFailed) {
    Write-Host "AgentPet 退出状态无法确认 (权限受限或 WMI 查询受限)。"
} else {
    Write-Host ("未找到运行中的 AgentPet 进程 (目录: {0})。" -f $baseDir)
}
