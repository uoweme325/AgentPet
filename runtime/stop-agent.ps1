param(
    [string]$TargetDir = "",
    # 仅加载身份判断与停止辅助函数（供测试点源加载），不执行任何停止动作
    [switch]$LibraryOnly
)

$baseDir = if ($TargetDir) {
    $TargetDir.Trim('"', "'", ' ', "`t").TrimEnd('\', '/')
} else {
    (Split-Path -Parent $PSScriptRoot)
}
try {
    $baseDir = [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($baseDir)).TrimEnd('\')
} catch {}
$appPidFile = Join-Path (Join-Path $baseDir "runtime") "app.pid"
$monPidFile = Join-Path (Join-Path $baseDir "runtime") "monitor.pid"

$canonicalScript = [System.IO.Path]::GetFullPath((Join-Path $baseDir "AgentPet.ps1")).ToLowerInvariant().Replace('/', '\')
$canonicalMonitor = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $baseDir "runtime") "agent-monitor.mjs")).ToLowerInvariant().Replace('/', '\')
$expectedAppPath = $canonicalScript
$expectedMonitorPath = $canonicalMonitor

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
    if (-not ("AgentPetStopNativeV2" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AgentPetStopNativeV2 {
    public delegate bool EnumWndProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWndProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CommandLineToArgvW(string lpCmdLine, out int pNumArgs);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr hMem);
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
    public static string[] SplitCommandLine(string commandLine) {
        if (string.IsNullOrWhiteSpace(commandLine)) return new string[0];
        int argc;
        IntPtr argv = CommandLineToArgvW(commandLine.TrimStart(), out argc);
        if (argv == IntPtr.Zero) return null;
        try {
            var result = new string[argc];
            for (int i = 0; i < argc; i++) {
                IntPtr p = Marshal.ReadIntPtr(argv, i * IntPtr.Size);
                result[i] = Marshal.PtrToStringUni(p);
            }
            return result;
        } finally {
            LocalFree(argv);
        }
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
            if ("AgentPetStopNativeV2" -as [type]) {
                if ([AgentPetStopNativeV2]::PostCloseToProcess($targetPid)) { $sentClose = $true }
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

# ============================================================================
# AP01: 统一进程身份判断（PID 校验与兜底扫描共用）
# 返回值：App（本项目主程序）/ Monitor（本项目监控器）/ Mismatch（明确不匹配）/ Unknown（无法确认）
# ============================================================================
function Split-AgentPetCommandLine([string]$CommandLine) {
    if (-not ("AgentPetStopNativeV2" -as [type])) { return $null }
    try {
        $parts = [AgentPetStopNativeV2]::SplitCommandLine($CommandLine)
        if ($null -eq $parts) { return $null }
        return ,([string[]]$parts)
    } catch {
        return $null
    }
}

function ConvertTo-AgentPetAbsolutePath([string]$PathText) {
    if ([string]::IsNullOrWhiteSpace($PathText)) { return $null }
    $p = $PathText.Trim()
    # 只接受带盘符的绝对路径或 UNC 路径；相对路径缺少目标进程可靠工作目录，返回 $null（无法确认）
    if ($p -notmatch '^(?:[A-Za-z]:[\\/]|\\\\|//)') { return $null }
    if ($p -match '[\\/]$') { return $null }
    try { return [System.IO.Path]::GetFullPath($p) } catch { return $null }
}

function Get-AgentPetPowerShellScriptArg([string[]]$Argv) {
    # 项目实际启动形式：powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File <绝对脚本路径>
    $switchOpts = @('nologo', 'noprofile', 'nop', 'noninteractive', 'noni', 'noexit', 'sta', 'mta')
    $valueOpts  = @('executionpolicy', 'ep', 'ex', 'exec', 'windowstyle', 'w', 'inputformat', 'outputformat', 'version', 'configurationname', 'psconsolefile')
    $fileOpts   = @('file', 'f')
    $commandOpts = @('command', 'c', 'encodedcommand', 'enc', 'ec', 'e', 'encodedarguments', 'ea', 'commandwithargs', 'cwa')
    $i = 1
    while ($i -lt $Argv.Count) {
        $tok = [string]$Argv[$i]
        if (-not $tok.StartsWith('-')) { return @{ Kind = 'Mismatch' } }
        $name = $tok.Substring(1).ToLowerInvariant()
        if ($name -eq '' -or $name.StartsWith('-') -or $name.Contains(':')) { return @{ Kind = 'Unknown' } }
        if ($switchOpts -contains $name) { $i++; continue }
        if ($valueOpts -contains $name) {
            if ($i + 1 -ge $Argv.Count) { return @{ Kind = 'Unknown' } }
            $i += 2
            continue
        }
        if ($fileOpts -contains $name) {
            if ($i + 1 -ge $Argv.Count) { return @{ Kind = 'Unknown' } }
            return @{ Kind = 'File'; Path = [string]$Argv[$i + 1] }
        }
        if ($commandOpts -contains $name) { return @{ Kind = 'Mismatch' } }
        return @{ Kind = 'Unknown' }
    }
    return @{ Kind = 'Mismatch' }
}

function Get-AgentPetNodeScriptArg([string[]]$Argv) {
    # 项目实际启动形式：node.exe <绝对监控脚本路径> --parent-pid ... --stall-seconds ...
    if ($Argv.Count -lt 2) { return @{ Kind = 'Mismatch' } }
    $first = [string]$Argv[1]
    if ($first.StartsWith('-')) {
        $optName = $first.ToLowerInvariant()
        $eqIdx = $optName.IndexOf('=')
        if ($eqIdx -gt 0) { $optName = $optName.Substring(0, $eqIdx) }
        if (@('-e', '--eval', '-p', '--print', '-pe', '-i', '--interactive', '-c', '--check', '-v', '--version', '-h', '--help', '-') -contains $optName) {
            return @{ Kind = 'Mismatch' }
        }
        # 脚本前带其他 Node 选项（如 --title）时，不猜第一个非横线参数，返回 Unknown（无法确认）
        return @{ Kind = 'Unknown' }
    }
    return @{ Kind = 'File'; Path = $first }
}

function Resolve-AgentPetProcessIdentity($ProcessInfo, [string]$ExpectedAppPath = "", [string]$ExpectedMonitorPath = "") {
    if (-not $ProcessInfo) { return 'Unknown' }
    $cmd = [string]$ProcessInfo.CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd)) { return 'Unknown' }
    $argv = Split-AgentPetCommandLine $cmd
    if ($null -eq $argv -or $argv.Count -lt 1) { return 'Unknown' }

    if (-not $ExpectedAppPath -and $canonicalScript) { $ExpectedAppPath = $canonicalScript }
    if (-not $ExpectedMonitorPath -and $canonicalMonitor) { $ExpectedMonitorPath = $canonicalMonitor }

    $exeText = if ($ProcessInfo.ExecutablePath) { [string]$ProcessInfo.ExecutablePath } else { [string]$argv[0] }
    $exeName = ''
    try { $exeName = [System.IO.Path]::GetFileName($exeText.Trim()).ToLowerInvariant() } catch { return 'Unknown' }

    if ($exeName -in @('powershell', 'powershell.exe', 'pwsh', 'pwsh.exe')) {
        $entry = Get-AgentPetPowerShellScriptArg $argv
        $role = 'App'
        $expected = ConvertTo-AgentPetAbsolutePath $ExpectedAppPath
    } elseif ($exeName -in @('node', 'node.exe')) {
        $entry = Get-AgentPetNodeScriptArg $argv
        $role = 'Monitor'
        $expected = ConvertTo-AgentPetAbsolutePath $ExpectedMonitorPath
    } else {
        return 'Mismatch'
    }
    if ($entry.Kind -ne 'File') { return $entry.Kind }

    $full = ConvertTo-AgentPetAbsolutePath $entry.Path
    if (-not $full) { return 'Unknown' }
    if ($expected -and [string]::Equals($full, $expected, [System.StringComparison]::OrdinalIgnoreCase)) { return $role }
    return 'Mismatch'
}

function Stop-TargetProcessById([int]$procId, [string]$expectedRoleOrPath, [string]$pidFilePath) {
    if ($procId -le 0 -or $procId -eq $PID) { return "Invalid" }

    $expectedRole = $expectedRoleOrPath
    $localAppPath = if ($expectedAppPath) { $expectedAppPath } else { $canonicalScript }
    $localMonPath = if ($expectedMonitorPath) { $expectedMonitorPath } else { $canonicalMonitor }
    if ($expectedRoleOrPath -and $expectedRoleOrPath -notin @('App', 'Monitor')) {
        $norm = $expectedRoleOrPath.Trim().ToLowerInvariant().Replace('/', '\')
        if ($norm.EndsWith('agent-monitor.mjs')) {
            $expectedRole = 'Monitor'
            $localMonPath = $expectedRoleOrPath
        } else {
            $expectedRole = 'App'
            $localAppPath = $expectedRoleOrPath
        }
    }

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
    if (-not $wmiProc) { return "CannotConfirm" }

    $identity = Resolve-AgentPetProcessIdentity $wmiProc $localAppPath $localMonPath
    if ($identity -eq $expectedRole) {
        try {
            $exited = Stop-ProcessGracefullyThenForce $procId ($expectedRole -eq 'App')
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
    }
    if ($identity -eq 'Unknown') {
        Write-Host ("[Warning] PID {0} 的启动形式无法确认是否为本项目进程，未停止并保留 PID 文件。" -f $procId)
        return "CannotConfirm"
    }
    # PID exists but identity does not match! PID reuse detected. DO NOT KILL, DO NOT DELETE PID FILE.
    Write-Host ("[Warning] PID {0} 正在运行但命令行不属于本项目，保留 PID 文件避免误杀。" -f $procId)
    return "PathMismatch"
}

if ($LibraryOnly) { return }

# 1. Check App PID
$appInfo = Parse-PidInfo $appPidFile
if ($appInfo) {
    $res = Stop-TargetProcessById $appInfo.Pid 'App' $appPidFile
    switch ($res) {
        "Stopped"       { $stoppedCount++ }
        "CannotConfirm" { $cannotConfirmCount++ }
        "StillRunning"  { $stillRunningCount++ }
    }
}

# 2. Check Monitor PID
$monInfo = Parse-PidInfo $monPidFile
if ($monInfo) {
    $res = Stop-TargetProcessById $monInfo.Pid 'Monitor' $monPidFile
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
        $scanAppPath = if ($expectedAppPath) { $expectedAppPath } else { $canonicalScript }
        $scanMonPath = if ($expectedMonitorPath) { $expectedMonitorPath } else { $canonicalMonitor }
        $dirNeedle = if ($baseDir) { $baseDir.ToLowerInvariant().Replace('/', '\') } else { "" }
        $procs = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            if ($_.ProcessId -eq $curPid -or -not $_.CommandLine) { return $false }
            $c = ([string]$_.CommandLine).ToLowerInvariant().Replace('/', '\')
            ($dirNeedle -and $c.Contains($dirNeedle)) -or $c.Contains('agentpet.ps1') -or $c.Contains('agent-monitor.mjs')
        })
        foreach ($p in $procs) {
            $identity = Resolve-AgentPetProcessIdentity $p $scanAppPath $scanMonPath
            if ($identity -eq 'App' -or $identity -eq 'Monitor') {
                try {
                    $exited = Stop-ProcessGracefullyThenForce $p.ProcessId ($identity -eq 'App')
                    if ($exited) {
                        $stoppedCount++
                    } else {
                        $stillRunningCount++
                    }
                } catch {
                    $cannotConfirmCount++
                }
            } elseif ($identity -eq 'Unknown') {
                $cannotConfirmCount++
                Write-Host ("[Warning] PID {0} 引用了 AgentPet 路径，但启动形式无法确认，未停止。" -f $p.ProcessId)
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
