Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Drawing, System.Windows.Forms

$ErrorActionPreference = 'Continue'
$script:AppVersion = "1.6.2"
$BaseDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { (Get-Location).Path }

# ============================================================================
# 0. Write-Permission Preflight Check (P2)
# ============================================================================
$testProbe = Join-Path $BaseDir "__perm_probe_$PID.tmp"
$hasWritePermission = $false
try {
    [System.IO.File]::WriteAllText($testProbe, "probe", [System.Text.Encoding]::UTF8)
    if (Test-Path $testProbe) {
        Remove-Item $testProbe -Force -ErrorAction SilentlyContinue
        $hasWritePermission = $true
    }
} catch {
    $hasWritePermission = $false
}

if (-not $hasWritePermission) {
    $errMsg = "【AgentPet 运行环境警告】`n当前目录没有写入权限：`n$BaseDir`n`n为了保存配置、日志与运行状态，请将 AgentPet 文件夹解压或移动到有写入权限的位置（例如用户的应用目录或 D 盘等）。"
    [System.Windows.Forms.MessageBox]::Show($errMsg, "AgentPet 提示 - 目录只读", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
    exit 1
}

$LogPath = Join-Path $BaseDir "runtime-error.log"

function Rotate-PetLog {
    try {
        if (-not (Test-Path $LogPath)) { return }
        $fi = Get-Item $LogPath -ErrorAction SilentlyContinue
        if ($fi -and $fi.Length -ge 2MB) {
            $log3 = Join-Path $BaseDir "runtime-error.3.log"
            $log2 = Join-Path $BaseDir "runtime-error.2.log"
            $log1 = Join-Path $BaseDir "runtime-error.1.log"
            if (Test-Path $log3) { Remove-Item $log3 -Force -ErrorAction SilentlyContinue }
            if (Test-Path $log2) { Rename-Item $log2 $log3 -Force -ErrorAction SilentlyContinue }
            if (Test-Path $log1) { Rename-Item $log1 $log2 -Force -ErrorAction SilentlyContinue }
            Rename-Item $LogPath $log1 -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

function Write-PetLog([string]$msg) {
    try {
        Rotate-PetLog
        $line = "[{0}] {1}" -f [DateTime]::Now.ToString("yyyy-MM-dd HH:mm:ss.fff"), $msg
        [System.IO.File]::AppendAllText($LogPath, "$line`r`n", [System.Text.Encoding]::UTF8)
    } catch {}
}

$script:LastThrottledLogs = @{}
function Log-Throttled([string]$key, [string]$msg, [int]$intervalSec = 10) {
    if (-not $script:LastThrottledLogs) { $script:LastThrottledLogs = @{} }
    $now = [DateTime]::UtcNow
    if (-not $script:LastThrottledLogs.ContainsKey($key) -or ($now - $script:LastThrottledLogs[$key]).TotalSeconds -ge $intervalSec) {
        $script:LastThrottledLogs[$key] = $now
        Write-PetLog "[$key] $msg"
    }
}

Write-PetLog "=== AgentPet Process Starting (PID $PID) ==="

$AssetsDir = Join-Path $BaseDir "assets"
$CharDir = Join-Path $AssetsDir "characters"
$ConfigPath = Join-Path $BaseDir "config.json"
$ConfigBakPath = Join-Path $BaseDir "config.json.bak"
$RuntimeStatusPath = Join-Path $BaseDir "runtime-status.json"
$RuntimeQuotaPath = Join-Path $BaseDir "runtime-quota.json"
$RefreshFlagPath = Join-Path $BaseDir "refresh-quota.flag"
$RuntimeBalancePath = Join-Path $BaseDir "runtime-balance.json"
$RefreshBalanceFlagPath = Join-Path $BaseDir "refresh-balance.flag"
$MonitorScript = Join-Path (Join-Path $BaseDir "runtime") "agent-monitor.mjs"
$script:AppPidPath = Join-Path (Join-Path $BaseDir "runtime") "app.pid"
$script:MonPidPath = Join-Path (Join-Path $BaseDir "runtime") "monitor.pid"

# ============================================================================
# 1. Single-Instance Named Mutex Guard (Issue 8 & DeepSeek Review Fix)
# ============================================================================
$script:InstanceMutex = $null
$mutexCreated = $false
try {
    $script:InstanceMutex = New-Object System.Threading.Mutex($true, "Local\AgentPet_SingleInstance_Mutex_p", [ref]$mutexCreated)
} catch [System.Threading.AbandonedMutexException] {
    Write-PetLog "Previous instance terminated abnormally (abandoned mutex). Ownership acquired."
    $mutexCreated = $true
} catch {
    Write-PetLog "Mutex error: $($_.Exception.Message). Continuing startup as single instance."
    $mutexCreated = $true
}

if (-not $mutexCreated) {
    Write-PetLog "Another active instance is currently running. Signaling wake.flag..."
    $wakeFlag = Join-Path $BaseDir "wake.flag"
    try { [System.IO.File]::WriteAllText($wakeFlag, [DateTime]::UtcNow.Ticks.ToString()) } catch {}
    [System.Windows.Forms.MessageBox]::Show("AgentPet 已经在运行中啦！`n已为您唤醒置顶桌宠窗口。", "AgentPet 提示", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
    Write-PetLog "Exiting duplicate instance."
    exit 0
}

# Record own PID metadata for safe process termination & path validation (P0-1)
$script:AppStartTimeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
try {
    $staleStopFlag = Join-Path (Join-Path $BaseDir "runtime") "stop.flag"
    if (Test-Path $staleStopFlag) { Remove-Item $staleStopFlag -Force -ErrorAction SilentlyContinue }
} catch {}
try {
    $appPidMeta = @{
        pid = $PID
        path = (Join-Path $BaseDir "AgentPet.ps1")
        startTime = $script:AppStartTimeMs
        baseDir = $BaseDir
    }
    [System.IO.File]::WriteAllText($script:AppPidPath, ($appPidMeta | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8)
} catch {}

# ============================================================================
# 2. Native Win32 Interop (No-Activate, ToolWindow, Pixel Hit-Test, MCI Audio)
# ============================================================================
$NativeCode = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class AgentPetNative {
    public const int GWL_EXSTYLE = -20;
    public const int GWLP_HWNDPARENT = -8;
    public const int WS_EX_TOPMOST = 0x00000008;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_APPWINDOW = 0x00040000;
    public const int WS_EX_NOACTIVATE = 0x08000000;
    public const int WM_MOUSEACTIVATE = 0x0021;
    public const int MA_NOACTIVATE = 3;
    public const int WM_NCHITTEST = 0x0084;
    public const int HTTRANSPARENT = -1;
    public const int HTCLIENT = 1;
    public const uint GW_HWNDPREV = 3;
    public const uint GW_OWNER = 4;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_FRAMECHANGED = 0x0020;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const uint SWP_NOOWNERZORDER = 0x0200;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
    private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
    private static extern IntPtr SetWindowLong32(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);

    public const int SW_HIDE = 0;
    public const int SW_SHOWNOACTIVATE = 4;
    public const int SW_SHOW = 5;

    public static void ClearWindowOwner(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return;
        try {
            if (GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) {
                if (IntPtr.Size == 8) SetWindowLongPtr64(hwnd, GWLP_HWNDPARENT, IntPtr.Zero);
                else SetWindowLong32(hwnd, GWLP_HWNDPARENT, IntPtr.Zero);
            }
        } catch {}
    }

    public static void ApplyToolWindowStyle(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return;
        int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
        int nextStyle = (exStyle | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) & ~WS_EX_APPWINDOW;
        SetWindowLong(hwnd, GWL_EXSTYLE, nextStyle);
        ClearWindowOwner(hwnd);
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }

    public static bool NeedsTopmostRestore(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd)) return false;
        try {
            if (GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return true;
            int myEx = GetWindowLong(hwnd, GWL_EXSTYLE);
            if ((myEx & WS_EX_TOPMOST) == 0) return true;

            IntPtr cur = GetWindow(hwnd, GW_HWNDPREV);
            int steps = 0;
            while (cur != IntPtr.Zero && steps < 64) {
                if (IsWindowVisible(cur) && !IsIconic(cur)) {
                    int cloak = 0;
                    DwmGetWindowAttribute(cur, 14, out cloak, 4);
                    if (cloak == 0) {
                        RECT r;
                        if (GetWindowRect(cur, out r) && (r.Right - r.Left) > 1 && (r.Bottom - r.Top) > 1) {
                            int curEx = GetWindowLong(cur, GWL_EXSTYLE);
                            if ((curEx & WS_EX_TOPMOST) == 0) return true;
                            StringBuilder cls = new StringBuilder(64);
                            GetClassName(cur, cls, 64);
                            string clsName = cls.ToString();
                            if (clsName == "WorkerW" || clsName == "Progman") return true;
                        }
                    }
                }
                cur = GetWindow(cur, GW_HWNDPREV);
                steps++;
            }
        } catch {}
        return false;
    }

    public static void EnsureWindowTopmost(IntPtr hwnd, bool topmost, bool force) {
        if (hwnd == IntPtr.Zero) return;
        ClearWindowOwner(hwnd);
        uint flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
        if (!topmost) {
            SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
            return;
        }
        if (!force && !NeedsTopmostRestore(hwnd)) return;
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
        if (NeedsTopmostRestore(hwnd)) {
            SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
        }
    }

    public static int[] ComputeAlphaBounds(byte[] bytes, int width, int height, int stride) {
        int minX = width, maxX = 0, minY = height, maxY = 0;
        for (int y = 0; y < height; y++) {
            int row = y * stride;
            for (int x = 0; x < width; x++) {
                if (bytes[row + (x * 4) + 3] > 12) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (minX > maxX) { minX = 0; maxX = width - 1; minY = 0; maxY = height - 1; }
        return new int[] { minX, minY, maxX, maxY };
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int x;
        public int y;
    }

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("shcore.dll", SetLastError = true)]
    public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

    public static double[] GetMonitorWorkAreaDIP(int physicalX, int physicalY) {
        try {
            POINT pt = new POINT { x = physicalX, y = physicalY };
            IntPtr hMon = MonitorFromPoint(pt, 2); // 2 = MONITOR_DEFAULTTONEAREST
            if (hMon != IntPtr.Zero) {
                MONITORINFO mi = new MONITORINFO();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                if (GetMonitorInfo(hMon, ref mi)) {
                    uint dpiX = 96, dpiY = 96;
                    try {
                        GetDpiForMonitor(hMon, 0, out dpiX, out dpiY); // 0 = MDT_EFFECTIVE_DPI
                    } catch {
                        dpiX = 96; dpiY = 96;
                    }
                    if (dpiX == 0) dpiX = 96;
                    if (dpiY == 0) dpiY = 96;
                    double scaleX = dpiX / 96.0;
                    double scaleY = dpiY / 96.0;
                    return new double[] {
                        mi.rcWork.Left / scaleX,
                        mi.rcWork.Top / scaleY,
                        mi.rcWork.Right / scaleX,
                        mi.rcWork.Bottom / scaleY,
                        scaleX,
                        scaleY
                    };
                }
            }
        } catch {}
        return null;
    }
}
"@
Add-Type -TypeDefinition $NativeCode -ReferencedAssemblies WindowsBase

# ============================================================================
# 3. Configuration Management
# ============================================================================
$DefaultConfig = [ordered]@{
    Character         = "claude"   # "claude", "dragon", "gemini", "deepseek", or "zcode"
    Pose              = "auto"     # "auto", "idle", "think", "work", "sleep", "happy"
    Scale             = 1.0
    BubbleScale       = 1.0
    FontScale         = 1.0
    SoundEnabled      = $true
    SoundVolume       = 850        # 0..1000
    Topmost           = $true
    SleepSeconds      = 60
    AutoQuoteMinutes  = 3          # 0 = off, else minutes between random idle quotes
    BubbleMode             = "quota"    # "quota", "deepseek", or "quote"
    TrayEnabled            = $true       # show a notification-area icon
    StartHidden            = $false      # start with the pet hidden but tray available
    StallDetectSeconds     = 45         # 0 = disable stalled inference
    PauseMonitorUntil      = 0          # UTC milliseconds; 0 = normal broadcasting
    LowBalanceAlertEnabled = $true
    LowBalanceCnyThreshold = 5.0
    DeepSeekBalanceEnabled    = $true    # enable DeepSeek balance via DSH host
    DshPort                   = 0        # 0 = auto discover
    DshBaseUrl                = ""       # optional explicit loopback base url
    HoverDetailsEnabled       = $false   # disabled by default; explicit toggle shows task detail card
    Left                   = -1
    Top                    = -1
}

$Config = [ordered]@{}
foreach ($k in $DefaultConfig.Keys) { $Config[$k] = $DefaultConfig[$k] }

function Save-Config {
    $tmpPath = Join-Path $BaseDir ("config.json." + $PID + ".tmp")
    try {
        $json = $Config | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText($tmpPath, $json, [System.Text.Encoding]::UTF8)

        # Single backup file: retain last good config
        if (Test-Path $ConfigPath) {
            try { [System.IO.File]::Copy($ConfigPath, $ConfigBakPath, $true) } catch {
                Write-PetLog "Warning: Failed to update config.json.bak: $($_.Exception.Message)"
            }
        }

        # Atomic move / replace
        Move-Item -Path $tmpPath -Destination $ConfigPath -Force
        $script:sliderConfigDirty = $false
    } catch {
        Write-PetLog "Error saving configuration: $($_.Exception.Message)"
        if (Test-Path $tmpPath) {
            Remove-Item -Path $tmpPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Load-Config {
    $loaded = $null
    # 1. Try reading primary config.json
    if (Test-Path $ConfigPath) {
        try {
            $raw = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8)
            if (-not [string]::IsNullOrWhiteSpace($raw)) {
                $parsed = $raw | ConvertFrom-Json
                if ($parsed) { $loaded = $parsed }
            }
        } catch {
            Write-PetLog "Warning: Primary config.json corrupted or unreadable ($($_.Exception.Message)). Attempting recovery from backup..."
        }
    }

    # 2. Try recovering from config.json.bak
    if (-not $loaded -and (Test-Path $ConfigBakPath)) {
        try {
            $rawBak = [System.IO.File]::ReadAllText($ConfigBakPath, [System.Text.Encoding]::UTF8)
            if (-not [string]::IsNullOrWhiteSpace($rawBak)) {
                $parsedBak = $rawBak | ConvertFrom-Json
                if ($parsedBak) {
                    $loaded = $parsedBak
                    Write-PetLog "Warning: Successfully recovered configuration from config.json.bak"
                    try { [System.IO.File]::Copy($ConfigBakPath, $ConfigPath, $true) } catch {}
                }
            }
        } catch {
            Write-PetLog "Warning: Backup config.json.bak also corrupted ($($_.Exception.Message))."
        }
    }

    # 3. If both failed, preserve corrupt file with timestamp and use defaults
    if (-not $loaded -and (Test-Path $ConfigPath)) {
        $corruptArchive = Join-Path $BaseDir ("config.json.corrupt." + [DateTime]::UtcNow.ToString("yyyyMMddHHmmss"))
        Write-PetLog "Warning: Both primary and backup config corrupted. Preserving evidence to $corruptArchive and resetting to defaults."
        try { Move-Item -Path $ConfigPath -Destination $corruptArchive -Force -ErrorAction SilentlyContinue } catch {}
    }

    foreach ($k in $DefaultConfig.Keys) { $Config[$k] = $DefaultConfig[$k] }
    if ($loaded) {
        foreach ($k in $DefaultConfig.Keys) {
            if ($null -ne $loaded.$k) { $Config[$k] = $loaded.$k }
        }
    } else {
        Save-Config
    }
    if ($Config.BubbleMode -notin @("quota", "deepseek", "quote")) {
        $Config.BubbleMode = "quota"
    }
    $Config.HoverDetailsEnabled = [bool]$Config.HoverDetailsEnabled
    $bs = if ($Config.BubbleScale) { [double]$Config.BubbleScale } else { 1.0 }
    $Config.BubbleScale = [Math]::Max(0.8, [Math]::Min(1.3, $bs))
}

Load-Config

# ============================================================================
# 4. Character Quote Pools (Strictly Separated per Character!)
# ============================================================================
$ClaudeQuotes = @(
    '诗人的灵感可没有枯竭，红茶也正好泡好，今天咱们先从哪个模块动笔？',
    '别看我平时只喜欢安静捧着印花典籍，收拾起乱成一团的旧代码可绝不手软。',
    '五小时的午后红茶与茶点额度还很充裕，主人尽管放手去试，我替您兜底。',
    '发间的向日葵发饰歪了吗？咳、才不是因为刚才被主人夸奖才慌神呢……',
    '优等生的代码洁癖，就是见不得半点含糊的边界条件和悬空的异常分支。',
    '怀里的印花典籍已经把咱们项目的来龙去脉都记下了，随时听候主人调阅~',
    '要是遇到难缠的第三方库，主人先抿口热茶消消气，剩下的脏活累活交给我。',
    '把橘白礼裙的荷叶袖口轻轻挽好——嗯，不管是重构还是排障，我都准备好了。',
    '已经连续盯了这么久屏幕啦，主人靠着椅背歇会儿眼睛，剩下的测试我来盯。',
    '这、这不过是学院派的基本功罢了……不过既然主人喜欢，再多花些心思也值了。',
    '只要书房里的红茶管够，再复杂的跨目录重构我也陪主人一路打磨到底。',
    '写代码就像修剪花枝，把冗余的枝蔓理干净了，真正优雅的结构自然就露出来了。',
    '夜深露重，我刚把桌角的红茶换成了温热的，主人今晚想改到哪一步我都奉陪。',
    '偶有报错也很正常呀，在我的书房里，从来没有跨不过去的编译红字~'
)

$GeminiQuotes = @(
    '双子星的星轨已经对齐~ 无论是超长上下文还是跨文件联调，尽管交给我吧！',
    '左眼看全局架构，右眼盯代码细节——这就是双子座搭档的天然默契哦~',
    '百万级上下文的星海还宽敞得很，哪怕把整个仓库装进来我也不会迷路！',
    '刚才顺着星盘扫了一圈，主人今天写的这几处逻辑，就像连成线的星座一样漂亮~',
    '需要翻找好几个目录前的旧线索吗？交给我，我的记忆星图可从来不掉帧！',
    '两个脑瓜同时转，一套方案负责稳扎稳打，一套方案负责灵光一闪~',
    '听，是构建全绿通过的清脆回音！给咱们今天的配合记上一颗亮星★',
    '要是思路卡在半路了，不如换个视角抬头看看星空，我陪主人一起找新切口~',
    '不管是读图、看文档还是改脚本，多模态的星轨随时为主人全速运转中！',
    '风吹过星盘的时候，连报错堆栈看起来都像等着被解开的星象谜题呢~',
    '主人只管把想法抛出来，剩下的拼图和连线，我三两下就能帮您铺满整张星图！',
    '哪怕是深夜的屏幕微光，只要和主人同频连线，这里就是最亮的一片星域~',
    '别担心改动牵一发而动全身，我已经替您把上下游的星轨依赖都盯牢啦！',
    '今天的代码巡航也很顺利呢，下一站咱们飞去哪个模块探险？'
)

$DragonQuotes = @(
    'Ciallo～ 今天也请多关照。',
    '看什么余额。看我，显得比较值。',
    '角不许摸……刚才那次就算了。',
    '剩余 1%？唔……只够甩一下尾巴了。',
    '别连点啦，我又不会掉金币。',
    '我在看额度。你在看我。各忙各的。',
    '检查了用户的电脑。似乎有个更弱的 agent 来过。',
    '我来看看那个AI改了什么导致插件又崩了...',
    '这个问题我已经完全明白，但是token太少写不下。',
    '这个代码我已经完全理解了，但是token太少写不下。',
    '新的旗舰模型我已经研制好了，但是储存太小放不下。',
    '恭喜你实现token自由！token全跑了！',
    'Token来Token来 🖐️😡🤚',
    '我不是吃白饭的大肥鱼',
    '你说得对。……这次是真的。',
    '今天可以收工了。宝藏明天再挖。',
    '呼呼……尾巴不小心扫到键盘了吗？反正肯定不是我写出的 Bug。',
    '摸鱼中，勿扰~ 除非主人准备了香喷喷的高质量上下文投喂我！',
    '拍一拍我的脑袋，就破例给你看一眼今天的剩余额度哦。',
    '别看我平时盘着尾巴打盹，真遇到难啃的硬骨头，还不是得靠本龙出马~',
    '看到这行祖传烂代码，我的龙角都跟着隐隐作痛了，快让我帮您改掉它。',
    '写不出来的时候就陪我趴桌角发会儿呆，灵感这种宝藏急不来的~',
    '干完这一票就奖励自己睡个懒觉，主人也别熬太晚，听到没？',
    '虽然嘴上嫌麻烦，但主人的代码仓库，本龙还是看护得很紧的。'
)

$DeepSeekQuotes = @(
    '噗噜噜~ 大肥鱼今天也端着小饭碗准时上班啦，请多关照！',
    '我可不是只会吃白饭的大肥鱼，算起推理和代码性价比来也是一把好手~',
    '小鲸鱼尾巴轻轻拍桌：主人今天的 Token 饭碗还满着吗？',
    '脑袋顶上的呆毛正在接收深海灵感电波，咻咻——捕捉到解题思路了！',
    '只要按时投喂清晰的需求，哪怕整座深海的 Bug 我都能帮您捞上来。',
    '唔……端着空碗等投喂的样子很可怜吗？那主人快多派点有意思的任务给我嘛！',
    '听说外面都在夸我省钱又大碗，那今天我也给主人多盛两勺高质量代码~',
    '鱼鳍耳廓微微抖动——刚才好像听到哪行逻辑在冒泡，让我潜水下去看看！',
    '别捏我鼓起来的腮帮子啦……再捏就把刚想好的推导步骤吐出来咯！',
    '深水区风大浪急的并发问题，就交给擅长深思熟虑的大肥鱼慢慢啃吧~',
    '今天的小白碗里盛得满满当当，连带重构和单测都帮主人顺手端齐了哦。',
    '偶尔也会端着碗在桌角晃晃尾巴发会儿呆，不过主人一叫我就会立刻浮起来！',
    '推理链就像吐泡泡一样一串接一串，很快就能帮您把正确答案浮出水面啦。',
    '哪怕是深夜海面起雾的时候，胸前这颗海蓝宝石也会陪主人一直亮着~'
)

$ZCodeQuotes = @(
    '银铃轻响~ 智谱娘正竖起黑色狐耳，随时准备替主人接管难缠的代码！',
    '别看额头上挂着睡眠眼罩发饰，真到写代码的时候我的蓝灰眼眸可精神着呢~',
    'Z 字菱形发饰已就位！今天要用哪一门语言和架构开启新回合？',
    '黑色哥特裙摆和银色小铃铛都已经整理妥当，请主人放心把任务交给我吧。',
    '毛茸茸的大尾巴在身后悄悄扫了两下——主人刚才写的这处设计很利落嘛！',
    '左腕的黑扣袖带系紧，爪印笔记本翻开，智谱娘全速编码模式启动！',
    '如果思路一时打结了，就让我托腮眨眨眼，陪您一块儿理顺前因后果~',
    '蓝色内挑染的发梢也跟着兴奋地亮起来了呢，看来今天手感极佳！',
    '可别小看这双毛茸茸的狐狸耳朵，测试报错的轻微动静我一眼就能听出出处。',
    '偶尔把头靠在手臂上打个小盹，吹出的蓝色小水泡里可全都是代码构想哦。',
    '不管需求有多复杂，只要有主人明确的方向，再深的嵌套都能被我拆解干净！',
    '叮铃~ 刚完成这一小节改动，感觉眼睛都要闪出蓝紫色的星星啦。',
    '发间的蓝黑蝴蝶结可不是摆设，它是我作为可靠搭档的徽章呢~',
    '夜再深也有狐耳和蓬松大尾巴暖着桌角，主人只管安心往前推进吧！'
)

$QuotesPath = Join-Path $AssetsDir "quotes.json"
if (Test-Path $QuotesPath) {
    try {
        $qJson = Get-Content $QuotesPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($qJson.quotes -and $qJson.quotes.Count -gt 0) {
            $DragonQuotes = @($qJson.quotes)
        } elseif ($qJson -and $qJson.Count -gt 0) {
            $DragonQuotes = @($qJson)
        }
    } catch {}
}

$script:CharacterRoster = @(
    @{ Key = "claude";   Label = "小克 (Claude娘)" },
    @{ Key = "dragon";   Label = "白龙 (GPT娘)" },
    @{ Key = "gemini";   Label = "双子 (Gemini娘)" },
    @{ Key = "deepseek"; Label = "大肥鱼 (DeepSeek娘)" },
    @{ Key = "zcode";    Label = "智谱娘 (ZCode)" }
)

$script:lastQuoteMap = @{
    claude   = ""
    dragon   = ""
    gemini   = ""
    deepseek = ""
    zcode    = ""
}

function Get-RandomCharacterQuote([string]$charKey) {
    $pool = switch ($charKey) {
        "dragon"   { $DragonQuotes }
        "gemini"   { $GeminiQuotes }
        "deepseek" { $DeepSeekQuotes }
        "zcode"    { $ZCodeQuotes }
        default    { $ClaudeQuotes }
    }
    if (-not $pool -or $pool.Count -eq 0) { return "今天也在认真陪伴主人写代码呢~" }
    
    $getText = {
        param($item)
        if ($item -is [string]) { return $item }
        if ($item.text) { return [string]$item.text }
        return [string]$item
    }

    if ($pool.Count -eq 1) { return (& $getText $pool[0]) }

    # Weighted random sampling using weight (Issue 1)
    $hasWeight = $false
    $totalWeight = 0.0
    foreach ($item in $pool) {
        if ($item -isnot [string] -and $item.weight) {
            $hasWeight = $true
            $totalWeight += [double]$item.weight
        } else {
            $totalWeight += 1.0
        }
    }

    $last = $script:lastQuoteMap[$charKey]
    $candidate = ""

    for ($guard = 0; $guard -lt 8; $guard++) {
        if ($hasWeight -and $totalWeight -gt 0) {
            $r = (Get-Random -Minimum 0.0 -Maximum $totalWeight)
            $accum = 0.0
            foreach ($item in $pool) {
                $w = if ($item -isnot [string] -and $item.weight) { [double]$item.weight } else { 1.0 }
                $accum += $w
                if ($r -le $accum) {
                    $candidate = & $getText $item
                    break
                }
            }
        } else {
            $raw = ($pool | Get-Random)
            $candidate = & $getText $raw
        }
        if ($candidate -ne $last) { break }
    }

    $script:lastQuoteMap[$charKey] = $candidate
    return $candidate
}

function Get-CharacterWakeQuote([string]$charKey) {
    switch ($charKey) {
        "dragon"   { return "喂喂，本龙可没偷溜，一直趴在桌角守着呢~" }
        "gemini"   { return "星轨收到召唤啦~ 双子一直在线陪着主人哦！" }
        "deepseek" { return "噗噜噜~ 大肥鱼端着小饭碗浮出水面报到啦！" }
        "zcode"    { return "银铃响啦~ 智谱娘正竖着狐耳在桌角待命呢！" }
        default    { return "主人，我一直都在书房里陪着您呢~" }
    }
}

# ============================================================================
# 5. Load XAML & Bind UI Controls
# ============================================================================
$XamlPath = Join-Path $BaseDir "AgentPet.xaml"
if (-not (Test-Path $XamlPath)) {
    Write-PetLog "FATAL: AgentPet.xaml not found in $BaseDir"
    [System.Windows.Forms.MessageBox]::Show("找不到 AgentPet.xaml 文件，请检查安装完整性！`n路径: $BaseDir", "AgentPet 启动失败", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    exit 1
}
try {
    $XamlContent = [System.IO.File]::ReadAllText($XamlPath, [System.Text.Encoding]::UTF8)
    $Window = [System.Windows.Markup.XamlReader]::Parse($XamlContent)
} catch {
    Write-PetLog "FATAL: Failed to parse XAML: $($_.Exception.ToString())"
    [System.Windows.Forms.MessageBox]::Show("XAML 界面文件解析失败：`n$($_.Exception.Message)", "AgentPet 启动失败", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    exit 1
}

$FacingScale      = $Window.FindName("FacingScale")
$Bubble           = $Window.FindName("Bubble")
$BubbleScale      = $Window.FindName("BubbleScale")
$BubbleBorder     = $Window.FindName("BubbleBorder")
$BubbleShadow     = $Window.FindName("BubbleShadow")
$TextFacingScale  = $Window.FindName("TextFacingScale")
$Root             = $Window.FindName("Root")

$WorkStatusPanel      = $Window.FindName("WorkStatusPanel")
$WorkHeaderBanner     = $Window.FindName("WorkHeaderBanner")
$WorkHeaderGradStop0  = $Window.FindName("WorkHeaderGradStop0")
$WorkHeaderGradStop1  = $Window.FindName("WorkHeaderGradStop1")
$WorkHeaderRow        = $Window.FindName("WorkHeaderRow")
$WorkStateChip        = $Window.FindName("WorkStateChip")
$WorkDot              = $Window.FindName("WorkDot")
$WorkHeader           = $Window.FindName("WorkHeader")
$WorkCoopHintInline   = $Window.FindName("WorkCoopHintInline")
$WorkInlineSourceHost = $Window.FindName("WorkInlineSourceHost")
$WorkSourcesPanel     = $Window.FindName("WorkSourcesPanel")
$WorkSourceBadge      = $Window.FindName("WorkSourceBadge")
$WorkSourceIcon       = $Window.FindName("WorkSourceIcon")
$WorkSource           = $Window.FindName("WorkSource")
$WorkSourceCount      = $Window.FindName("WorkSourceCount")
$WorkBodyArea         = $Window.FindName("WorkBodyArea")
$WorkBodyWatermark    = $Window.FindName("WorkBodyWatermark")
$WorkContentGroup     = $Window.FindName("WorkContentGroup")
$WorkTask             = $Window.FindName("WorkTask")

$QuotaPanel       = $Window.FindName("QuotaPanel")
$QuotaSourceIcon  = $Window.FindName("QuotaSourceIcon")
$QuotaHeader      = $Window.FindName("QuotaHeader")
$QuotaPlanBadge   = $Window.FindName("QuotaPlanBadge")
$QuotaPlanText    = $Window.FindName("QuotaPlanText")
$QuotaResetNotice = $Window.FindName("QuotaResetNotice")
$RefreshQuotaBtn  = $Window.FindName("RefreshQuotaBtn")
$ShortLabel       = $Window.FindName("ShortLabel")
$ShortReset       = $Window.FindName("ShortReset")
$ShortPercent     = $Window.FindName("ShortPercent")
$ShortTrack       = $Window.FindName("ShortTrack")
$ShortBar         = $Window.FindName("ShortBar")
$WeekLabel        = $Window.FindName("WeekLabel")
$WeekReset        = $Window.FindName("WeekReset")
$WeekPercent      = $Window.FindName("WeekPercent")
$WeekTrack        = $Window.FindName("WeekTrack")
$WeekBar          = $Window.FindName("WeekBar")

$QuotePanel       = $Window.FindName("QuotePanel")
$QuoteSpeaker     = $Window.FindName("QuoteSpeaker")
$QuoteHintBadge   = $Window.FindName("QuoteHintBadge")
$QuoteHint        = $Window.FindName("QuoteHint")
$QuoteText        = $Window.FindName("QuoteText")

$BubbleTailPanel  = $Window.FindName("BubbleTailPanel")
$Tail             = $Window.FindName("Tail")
$TailShadow       = $Window.FindName("TailShadow")
$TailNear         = $Window.FindName("TailNear")
$TailNearShadow   = $Window.FindName("TailNearShadow")

$PetHost          = $Window.FindName("PetHost")
$PetScale         = $Window.FindName("PetScale")
$PetImage         = $Window.FindName("PetImage")

# Bind DeepSeek Panel Controls
$DeepSeekPanel           = $Window.FindName("DeepSeekPanel")
$DeepSeekHeaderGrid      = $Window.FindName("DeepSeekHeaderGrid")
$DeepSeekIcon            = $Window.FindName("DeepSeekIcon")
$DeepSeekHeader          = $Window.FindName("DeepSeekHeader")
$DeepSeekBadge           = $Window.FindName("DeepSeekBadge")
$DeepSeekBadgeText       = $Window.FindName("DeepSeekBadgeText")
$DeepSeekStatusNotice    = $Window.FindName("DeepSeekStatusNotice")
$RefreshDeepSeekBtn      = $Window.FindName("RefreshDeepSeekBtn")
$DeepSeekContentGrid     = $Window.FindName("DeepSeekContentGrid")
$DeepSeekOkPanel         = $Window.FindName("DeepSeekOkPanel")
$DeepSeekMainRowGrid     = $Window.FindName("DeepSeekMainRowGrid")
$DeepSeekCurrencyLabel   = $Window.FindName("DeepSeekCurrencyLabel")
$DeepSeekAvailableNotice = $Window.FindName("DeepSeekAvailableNotice")
$DeepSeekTotalText       = $Window.FindName("DeepSeekTotalText")
$DeepSeekSubRowGrid      = $Window.FindName("DeepSeekSubRowGrid")
$DeepSeekBreakdownText   = $Window.FindName("DeepSeekBreakdownText")
$DeepSeekPricingLink     = $Window.FindName("DeepSeekPricingLink")
$DeepSeekMsgPanel        = $Window.FindName("DeepSeekMsgPanel")
$DeepSeekMsgTitle        = $Window.FindName("DeepSeekMsgTitle")
$DeepSeekMsgDetail       = $Window.FindName("DeepSeekMsgDetail")
$script:deepSeekTimeoutLayout = $false
$script:deepSeekSnapshotLabelActive = $false

# ============================================================================
# 6. Preload All Sprites & Compute Pixel Alpha Masks (Robust Fallbacks)
# ============================================================================
$script:ImageCache = @{}
$script:AlphaCache = @{}

Get-ChildItem $CharDir -Filter "*.png" | ForEach-Object {
    $file = $_
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    try {
        $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
        $bmp.BeginInit()
        $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $bmp.UriSource = New-Object System.Uri($file.FullName)
        $bmp.EndInit()
        $bmp.Freeze()
        $script:ImageCache[$baseName] = $bmp

        $conv = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap($bmp, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
        $w = $conv.PixelWidth
        $h = $conv.PixelHeight
        $stride = $w * 4
        $bytes = New-Object byte[] ($stride * $h)
        $conv.CopyPixels($bytes, $stride, 0)
        $boundsArr = [AgentPetNative]::ComputeAlphaBounds($bytes, $w, $h, $stride)
        $script:AlphaCache[$baseName] = @{
            Width     = $w
            Height    = $h
            Stride    = $stride
            Bytes     = $bytes
            AlphaMinX = $boundsArr[0]
            AlphaMinY = $boundsArr[1]
            AlphaMaxX = $boundsArr[2]
            AlphaMaxY = $boundsArr[3]
            AlphaW    = [double]($boundsArr[2] - $boundsArr[0] + 1)
            AlphaH    = [double]($boundsArr[3] - $boundsArr[1] + 1)
        }
    } catch {}
}


# Preload Agent Brand Icons (Codex, DSH, Antigravity, Claude, Gemini)
$script:AgentIcons = @{}
$IconDir = Join-Path $BaseDir "assets\icons"
if (Test-Path $IconDir) {
    Get-ChildItem $IconDir -Filter "*.png" | ForEach-Object {
        try {
            $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
            $bmp.BeginInit()
            $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
            $bmp.UriSource = New-Object System.Uri($_.FullName)
            $bmp.EndInit()
            $bmp.Freeze()
            $key = [System.IO.Path]::GetFileNameWithoutExtension($_.Name).ToLower()
            $script:AgentIcons[$key] = $bmp
        } catch {}
    }
}

# Setup fallback aliases for all characters
foreach ($c in @("claude", "dragon", "gemini", "deepseek", "zcode")) {
    $bustKey = "$c-bust"
    if ($script:ImageCache.ContainsKey($bustKey)) {
        if (-not $script:ImageCache.ContainsKey("$c-idle"))  { $script:ImageCache["$c-idle"]  = $script:ImageCache[$bustKey];  $script:AlphaCache["$c-idle"]  = $script:AlphaCache[$bustKey] }
        if (-not $script:ImageCache.ContainsKey("$c-happy")) { $script:ImageCache["$c-happy"] = $script:ImageCache[$bustKey];  $script:AlphaCache["$c-happy"] = $script:AlphaCache[$bustKey] }
        if (-not $script:ImageCache.ContainsKey("$c-work"))  {
            $workFallback = if ($script:ImageCache.ContainsKey("$c-think")) { "$c-think" } elseif ($script:ImageCache.ContainsKey("$c-wait")) { "$c-wait" } else { $bustKey }
            $script:ImageCache["$c-work"] = $script:ImageCache[$workFallback]
            $script:AlphaCache["$c-work"] = $script:AlphaCache[$workFallback]
        }
        if (-not $script:ImageCache.ContainsKey("$c-sleep")) {
            $script:ImageCache["$c-sleep"] = $script:ImageCache[$bustKey]
            $script:AlphaCache["$c-sleep"] = $script:AlphaCache[$bustKey]
        }
    }
}

$script:CurrentState = "idle"
$script:CurrentSpriteKey = "claude-bust"

$script:CharacterProfiles = @{
    claude   = @{ Scale = 1.0; OffsetX = 0; OffsetY = 0 }
    dragon   = @{ Scale = 1.0; OffsetX = 0; OffsetY = 0 }
    gemini   = @{ Scale = 1.0; OffsetX = 0; OffsetY = 0 }
    deepseek = @{ Scale = 1.0; OffsetX = 0; OffsetY = 0 }
    zcode    = @{ Scale = 1.0; OffsetX = 0; OffsetY = 0 }
}

function Set-PetSprite([string]$state) {
    if (-not $state) { $state = "idle" }
    $script:CurrentState = $state
    $char = [string]$Config.Character
    $keys = @(
        "$char-$state",
        "$char-bust",
        "$char-idle",
        "claude-bust"
    )
    $foundKey = $null
    foreach ($k in $keys) {
        if ($script:ImageCache.ContainsKey($k) -and $null -ne $script:ImageCache[$k]) {
            $foundKey = $k
            break
        }
    }
    if ($foundKey) {
        $script:CurrentSpriteKey = $foundKey
        $PetImage.Source = $script:ImageCache[$foundKey]
    }
    
    # Base size strictly aligns to PetHost (204x204) with zero bottom clipping (Issue 5)
    $baseSize = 204.0
    $profile = if ($script:CharacterProfiles.ContainsKey($char)) { $script:CharacterProfiles[$char] } else { @{ Scale = 1.0; OffsetX = 0; OffsetY = 0 } }
    $w = [Math]::Round($baseSize * $profile.Scale)
    $h = [Math]::Round($baseSize * $profile.Scale)
    $PetImage.Width = $w
    $PetImage.Height = $h
    [System.Windows.Controls.Canvas]::SetLeft($PetImage, $profile.OffsetX)
    [System.Windows.Controls.Canvas]::SetTop($PetImage, $profile.OffsetY)
}

# ============================================================================
# 7. Theme & Font Scaling Engine
# ============================================================================
$BrushConv = New-Object System.Windows.Media.BrushConverter
$ColorConv = New-Object System.Windows.Media.ColorConverter

$Themes = @{
    claude = @{
        SpeakerName    = "Claude娘（小克）"
        BubbleBg       = "#FFFFF6EC"
        Border         = "#FFE28532"
        ShadowColor    = "#885E2F0D"
        Accent         = "#FFCE6018"
        HeaderAccent   = "#FFCE6018"
        DotColor       = "#FFCE6018"
        SubText        = "#FF8F5B36"
        MutedText      = "#FFA66838"
        BodyText       = "#FF4A2E1B"
        PercentText    = "#FFBA4E0E"
        TrackBg        = "#FFF3E2D2"
        BarBrush       = "#FFE57E28"
        BadgeBg        = "#FFF7E6D5"
        BadgeFg        = "#FFAA5314"
        HoverBg        = "#FFFFEAD3"
        HeaderGrad0    = "#FFFFEAD3"
        HeaderGrad1    = "#FFFFF2E2"
        HeaderDivider  = "#FFF7D9BC"
        WatermarkGlyph = "✧"
        WatermarkColor = "#24CE6018"
    }
    dragon = @{
        SpeakerName    = "白龙娘（GPT娘）"
        BubbleBg       = "#FFF4F3FB"
        Border         = "#FF6D67A2"
        ShadowColor    = "#66282348"
        Accent         = "#FF595094"
        HeaderAccent   = "#FF484178"
        DotColor       = "#FF655DA2"
        SubText        = "#FF6E6799"
        MutedText      = "#FF8A84B0"
        BodyText       = "#FF2C2645"
        PercentText    = "#FF484178"
        TrackBg        = "#FFE8E6F4"
        BarBrush       = "#FF746CB0"
        BadgeBg        = "#FFEEEDF8"
        BadgeFg        = "#FF4E4685"
        HoverBg        = "#FFE6E4F6"
        HeaderGrad0    = "#FFE6E4F6"
        HeaderGrad1    = "#FFEFEEF9"
        HeaderDivider  = "#FFD8D5EC"
        WatermarkGlyph = "❖"
        WatermarkColor = "#26655DA2"
    }
    gemini = @{
        SpeakerName    = "Gemini娘（双子）"
        BubbleBg       = "#FFF5F1FF"
        Border         = "#FF7C6BF2"
        ShadowColor    = "#6637297A"
        Accent         = "#FF5340C9"
        HeaderAccent   = "#FF4B38BF"
        DotColor       = "#FF6D5CE7"
        SubText        = "#FF63599E"
        MutedText      = "#FF7E74B8"
        BodyText       = "#FF2F2859"
        PercentText    = "#FF4B38BF"
        TrackBg        = "#FFEAE6FA"
        BarBrush       = "#FF7462F0"
        BadgeBg        = "#FFEDE9FE"
        BadgeFg        = "#FF5340C9"
        HoverBg        = "#FFEAE2FF"
        HeaderGrad0    = "#FFEAE2FF"
        HeaderGrad1    = "#FFF6ECFE"
        HeaderDivider  = "#FFE2D8FC"
        WatermarkGlyph = "✦"
        WatermarkColor = "#287C3AED"
    }
    deepseek = @{
        SpeakerName    = "DeepSeek娘（大肥鱼）"
        BubbleBg       = "#FFF0F7FF"
        Border         = "#FF3B82C4"
        ShadowColor    = "#66153860"
        Accent         = "#FF1D5FA7"
        HeaderAccent   = "#FF1A5294"
        DotColor       = "#FF2B72BE"
        SubText        = "#FF46698F"
        MutedText      = "#FF6284A8"
        BodyText       = "#FF19304B"
        PercentText    = "#FF1A5294"
        TrackBg        = "#FFDCEBFA"
        BarBrush       = "#FF327AD1"
        BadgeBg        = "#FFE3EFFC"
        BadgeFg        = "#FF1D5FA7"
        HoverBg        = "#FFDCEBFE"
        HeaderGrad0    = "#FFDCEBFE"
        HeaderGrad1    = "#FFEBF4FF"
        HeaderDivider  = "#FFC7DFF8"
        WatermarkGlyph = "◈"
        WatermarkColor = "#242B72BE"
    }
    zcode = @{
        SpeakerName    = "智谱娘（ZCode）"
        BubbleBg       = "#FFF1F4FC"
        Border         = "#FF4A66B0"
        ShadowColor    = "#661A264A"
        Accent         = "#FF2C478E"
        HeaderAccent   = "#FF253D7D"
        DotColor       = "#FF3B59A8"
        SubText        = "#FF4D5E87"
        MutedText      = "#FF697AA3"
        BodyText       = "#FF1C253B"
        PercentText    = "#FF253D7D"
        TrackBg        = "#FFDFE5F5"
        BarBrush       = "#FF3F5EB5"
        BadgeBg        = "#FFE6EBF8"
        BadgeFg        = "#FF2C478E"
        HoverBg        = "#FFDCE3F7"
        HeaderGrad0    = "#FFDCE3F7"
        HeaderGrad1    = "#FFECF0FA"
        HeaderDivider  = "#FFCBD5F0"
        WatermarkGlyph = "◇"
        WatermarkColor = "#243B59A8"
    }
}

function Get-CurrentTheme {
    $char = [string]$Config.Character
    if ($Themes.ContainsKey($char)) { return $Themes[$char] }
    return $Themes["claude"]
}

function Get-WorkStateVisualStyle([string]$state, $theme) {
    $norm = if ($state) { $state.ToLower() } else { "working" }
    $headerGrad0 = if ($theme.HeaderGrad0) { $theme.HeaderGrad0 } else { "#FFFFF1E4" }
    $headerGrad1 = if ($theme.HeaderGrad1) { $theme.HeaderGrad1 } else { "#FFFFF8EF" }
    $headerDiv   = if ($theme.HeaderDivider) { $theme.HeaderDivider } else { "#FFFCE4CE" }
    $dotColor    = if ($theme.DotColor) { $theme.DotColor } else { $theme.Accent }
    $hdrAccent   = if ($theme.HeaderAccent) { $theme.HeaderAccent } else { $theme.Accent }

    if ($norm -in @("waiting", "approval", "stalled")) {
        return @{
            IsHighlighted    = $true
            Border           = "#DCA296A8"
            BorderThickness  = 1.6
            TailThickness    = 1.5
            TailNearThick    = 1.4
            ShadowColor      = "#3B3448"
            ShadowOpacity    = 0.24
            HeaderGrad0      = $headerGrad0
            HeaderGrad1      = $headerGrad1
            HeaderDivider    = $headerDiv
            ChipBg           = "#FFFCE7F3"
            ChipBorder       = "#FFF9A8D4"
            ChipThickness    = 0.9
            ChipCornerRadius = 8.0
            DotColor         = "#FFDB2777"
            HeaderColor      = "#FFBE185D"
        }
    }
    if ($norm -eq "error") {
        return @{
            IsHighlighted    = $true
            Border           = "#FFEF4444"
            BorderThickness  = 1.8
            TailThickness    = 1.8
            TailNearThick    = 1.6
            ShadowColor      = "#7F1D1D"
            ShadowOpacity    = 0.26
            HeaderGrad0      = "#FFFEE2E2"
            HeaderGrad1      = "#FFFFF1F2"
            HeaderDivider    = "#FFFECACA"
            ChipBg           = "#FFFEE2E2"
            ChipBorder       = "#FFFCA5A5"
            ChipThickness    = 0.9
            ChipCornerRadius = 8.0
            DotColor         = "#FFEF4444"
            HeaderColor      = "#FF991B1B"
        }
    }
    if ($norm -in @("success", "done")) {
        return @{
            IsHighlighted    = $false
            Border           = "#CC10B981"
            BorderThickness  = 1.5
            TailThickness    = 1.5
            TailNearThick    = 1.4
            ShadowColor      = "#065F46"
            ShadowOpacity    = 0.24
            HeaderGrad0      = "#FFECFDF5"
            HeaderGrad1      = "#FFF6FEF9"
            HeaderDivider    = "#FFA7F3D0"
            ChipBg           = "Transparent"
            ChipBorder       = "Transparent"
            ChipThickness    = 0.0
            ChipCornerRadius = 0.0
            DotColor         = "#FF10B981"
            HeaderColor      = "#FF059669"
        }
    }
    return @{
        IsHighlighted    = $false
        Border           = $theme.Border
        BorderThickness  = 2.2
        TailThickness    = 1.8
        TailNearThick    = 1.5
        ShadowColor      = $theme.ShadowColor
        ShadowOpacity    = 0.26
        HeaderGrad0      = $headerGrad0
        HeaderGrad1      = $headerGrad1
        HeaderDivider    = $headerDiv
        ChipBg           = "Transparent"
        ChipBorder       = "Transparent"
        ChipThickness    = 0.0
        ChipCornerRadius = 0.0
        DotColor         = $dotColor
        HeaderColor      = $hdrAccent
    }
}

function Apply-WorkVisualStyle([string]$state, $theme) {
    if (-not $theme) { $theme = Get-CurrentTheme }
    $sv = Get-WorkStateVisualStyle $state $theme
    $script:WorkIsStateChipHighlighted = [bool]$sv.IsHighlighted

    $thick = [double]$sv.BorderThickness
    $innerR = [Math]::Max(0.0, 18.0 - $thick)

    try {
        $bdBrush = $BrushConv.ConvertFromString($sv.Border)
        $BubbleBorder.BorderBrush     = $bdBrush
        $BubbleBorder.BorderThickness = [System.Windows.Thickness]::new($thick)
        if ($Tail) {
            $Tail.BorderBrush     = $bdBrush
            $Tail.BorderThickness = [System.Windows.Thickness]::new([double]$sv.TailThickness)
        }
        if ($TailNear) {
            $TailNear.BorderBrush     = $bdBrush
            $TailNear.BorderThickness = [System.Windows.Thickness]::new([double]$sv.TailNearThick)
        }
    } catch {}

    try {
        $shColor = $ColorConv.ConvertFromString($sv.ShadowColor)
        if ($BubbleShadow) {
            $BubbleShadow.Color      = $shColor
            $BubbleShadow.BlurRadius = 16
            $BubbleShadow.ShadowDepth = 4
            $BubbleShadow.Opacity    = [double]$sv.ShadowOpacity
        }
        if ($TailShadow) {
            $TailShadow.Color      = $shColor
            $TailShadow.BlurRadius = 9
            $TailShadow.ShadowDepth = 2
            $TailShadow.Opacity    = [Math]::Max(0.20, [double]$sv.ShadowOpacity - 0.01)
        }
        if ($TailNearShadow) {
            $TailNearShadow.Color      = $shColor
            $TailNearShadow.BlurRadius = 7
            $TailNearShadow.ShadowDepth = 2
            $TailNearShadow.Opacity    = [Math]::Max(0.18, [double]$sv.ShadowOpacity - 0.03)
        }
    } catch {}

    if ($WorkHeaderBanner) {
        $WorkHeaderBanner.CornerRadius = [System.Windows.CornerRadius]::new($innerR, $innerR, 0, 0)
        try { $WorkHeaderBanner.BorderBrush = $BrushConv.ConvertFromString($sv.HeaderDivider) } catch {}
    }
    if ($WorkHeaderGradStop0) {
        try { $WorkHeaderGradStop0.Color = $ColorConv.ConvertFromString($sv.HeaderGrad0) } catch {}
    }
    if ($WorkHeaderGradStop1) {
        try { $WorkHeaderGradStop1.Color = $ColorConv.ConvertFromString($sv.HeaderGrad1) } catch {}
    }
    if ($WorkStateChip) {
        $WorkStateChip.BorderThickness = [System.Windows.Thickness]::new([double]$sv.ChipThickness)
        $WorkStateChip.CornerRadius    = [System.Windows.CornerRadius]::new([double]$sv.ChipCornerRadius)
        try {
            $WorkStateChip.Background  = $BrushConv.ConvertFromString($sv.ChipBg)
            $WorkStateChip.BorderBrush = $BrushConv.ConvertFromString($sv.ChipBorder)
        } catch {}
    }
    if ($WorkDot) {
        try { $WorkDot.Fill = $BrushConv.ConvertFromString($sv.DotColor) } catch {}
    }
    if ($WorkHeader) {
        try { $WorkHeader.Foreground = $BrushConv.ConvertFromString($sv.HeaderColor) } catch {}
    }
    return $sv
}

function Update-Theme {
    $t = Get-CurrentTheme
    if ($script:TrayMenu) { Update-TrayMenuTheme }
    $bgBrush     = $BrushConv.ConvertFromString($t.BubbleBg)
    $borderBrush = $BrushConv.ConvertFromString($t.Border)
    $accentBrush = $BrushConv.ConvertFromString($t.Accent)
    $subBrush    = $BrushConv.ConvertFromString($t.SubText)
    $mutedBrush  = $BrushConv.ConvertFromString($t.MutedText)
    $bodyBrush   = $BrushConv.ConvertFromString($t.BodyText)
    $pctBrush    = $BrushConv.ConvertFromString($t.PercentText)
    $trackBrush  = $BrushConv.ConvertFromString($t.TrackBg)
    $badgeBg     = $BrushConv.ConvertFromString($t.BadgeBg)
    $badgeFg     = $BrushConv.ConvertFromString($t.BadgeFg)
    $hoverBrush  = $BrushConv.ConvertFromString($t.HoverBg)

    $Window.Resources["ThemeBorderBrush"] = $borderBrush
    $Window.Resources["ThemeAccentBrush"] = $accentBrush
    $Window.Resources["ThemeHoverBrush"]  = $hoverBrush

    $BubbleBorder.Background      = $bgBrush
    $BubbleBorder.BorderBrush     = $borderBrush
    $BubbleBorder.BorderThickness = [System.Windows.Thickness]::new(2.2)
    if ($Tail) {
        $Tail.Background      = $bgBrush
        $Tail.BorderBrush     = $borderBrush
        $Tail.BorderThickness = [System.Windows.Thickness]::new(1.8)
    }
    if ($TailNear) {
        $TailNear.Background      = $bgBrush
        $TailNear.BorderBrush     = $borderBrush
        $TailNear.BorderThickness = [System.Windows.Thickness]::new(1.5)
    }
    $shadowColor = $ColorConv.ConvertFromString($t.ShadowColor)
    if ($BubbleShadow) {
        $BubbleShadow.Color       = $shadowColor
        $BubbleShadow.BlurRadius  = 16
        $BubbleShadow.ShadowDepth = 4
        $BubbleShadow.Opacity     = 0.26
    }
    if ($TailShadow) {
        $TailShadow.Color       = $shadowColor
        $TailShadow.BlurRadius  = 9
        $TailShadow.ShadowDepth = 2
        $TailShadow.Opacity     = 0.25
    }
    if ($TailNearShadow) {
        $TailNearShadow.Color       = $shadowColor
        $TailNearShadow.BlurRadius  = 7
        $TailNearShadow.ShadowDepth = 2
        $TailNearShadow.Opacity     = 0.23
    }

    if ($WorkBodyWatermark) {
        $WorkBodyWatermark.Text = if ($t.WatermarkGlyph) { $t.WatermarkGlyph } else { "✧" }
        try {
            $wmStr = if ($t.WatermarkColor) { $t.WatermarkColor } else { "#24CE6018" }
            $WorkBodyWatermark.Foreground = $BrushConv.ConvertFromString($wmStr)
        } catch {}
    }
    if ($WorkCoopHintInline) { $WorkCoopHintInline.Foreground = $mutedBrush }
    if ($script:WorkCoopHintTextBlock -and (-not [Object]::ReferenceEquals($script:WorkCoopHintTextBlock, $WorkCoopHintInline))) {
        $script:WorkCoopHintTextBlock.Foreground = $mutedBrush
    }
    $WorkTask.Foreground = $bodyBrush

    if ($script:agentBusy -and $script:lastWorkStatusObj -and $WorkTask) {
        $nextWorkText = Get-WorkBubbleDisplayTask $script:lastWorkStatusObj
        if ($WorkTask.Text -cne $nextWorkText) { $WorkTask.Text = $nextWorkText }
    }
    $activeWorkState = if ($script:currentBubblePanel -eq "work" -and $script:lastAgentState) { $script:lastAgentState } else { "working" }
    [void](Apply-WorkVisualStyle $activeWorkState $t)
    if ($script:currentBubblePanel -eq "work" -and $WorkStatusPanel -and $WorkStatusPanel.Visibility -eq [System.Windows.Visibility]::Visible) {
        Update-WorkTaskLineBudget
    }

    $QuotaHeader.Foreground      = $accentBrush
    $QuotaPlanBadge.Background   = $badgeBg
    $QuotaPlanText.Foreground    = $badgeFg
    $QuotaResetNotice.Foreground = $mutedBrush
    $RefreshQuotaBtn.Foreground  = $accentBrush
    $ShortLabel.Foreground       = $subBrush
    $ShortReset.Foreground       = $mutedBrush
    $ShortTrack.Background       = $trackBrush
    $WeekLabel.Foreground        = $subBrush
    $WeekReset.Foreground        = $mutedBrush
    $WeekTrack.Background        = $trackBrush

    $QuoteSpeaker.Text       = $t.SpeakerName
    $QuoteSpeaker.Foreground = $accentBrush
    if ($QuoteHintBadge) { $QuoteHintBadge.Background = $badgeBg }
    $QuoteHint.Foreground    = $badgeFg
    $QuoteText.Foreground    = $bodyBrush

    if ($DeepSeekHeader)          { $DeepSeekHeader.Foreground          = $accentBrush }
    if ($DeepSeekBadge)           { $DeepSeekBadge.Background           = $badgeBg }
    if ($DeepSeekBadgeText)       { $DeepSeekBadgeText.Foreground       = $badgeFg }
    if ($DeepSeekStatusNotice)    { $DeepSeekStatusNotice.Foreground    = $mutedBrush }
    if ($RefreshDeepSeekBtn)      { $RefreshDeepSeekBtn.Foreground      = $accentBrush }
    if ($DeepSeekCurrencyLabel)   { $DeepSeekCurrencyLabel.Foreground   = $subBrush }
    if ($DeepSeekTotalText)       { $DeepSeekTotalText.Foreground       = $pctBrush }
    if ($DeepSeekBreakdownText)   { $DeepSeekBreakdownText.Foreground   = $mutedBrush }
    if ($DeepSeekMsgTitle)        { $DeepSeekMsgTitle.Foreground        = $accentBrush }
    if ($DeepSeekMsgDetail)       { $DeepSeekMsgDetail.Foreground       = $bodyBrush }

    Update-QuotaColors
    Update-DetailWindowTheme
    if ($script:agentBusy -and $script:lastWorkStatusObj -and ([bool]$Config.HoverDetailsEnabled -or ($script:DetailWindow -and $script:DetailWindow.IsVisible))) {
        Update-DetailWindowContent $script:lastWorkStatusObj
    }
}

function Sync-BubbleGeometryAndAnchor {
    if (-not $Bubble -or -not $BubbleBorder -or -not $Window) { return }
    $bs = if ($Config.BubbleScale) { [double]$Config.BubbleScale } else { 1.0 }
    $bs = [Math]::Max(0.8, [Math]::Min(1.3, $bs))
    $isWork = ($script:currentBubblePanel -eq "work")

    $targetW = if ($isWork) { 254.0 } else { 264.0 }
    $baseLeft = if ($isWork) { 30.0 } else { 26.0 }
    $maxWorkH = if ($script:WorkCardMaxHeightOverride -gt 0) { [double]$script:WorkCardMaxHeightOverride } else { 128.0 }

    if ($isWork) {
        $BubbleBorder.Width     = $targetW
        $BubbleBorder.Height    = [double]::NaN
        $BubbleBorder.MinHeight = 72.0
        $BubbleBorder.MaxHeight = $maxWorkH
        $BubbleBorder.Padding   = [System.Windows.Thickness]::new(0)
    } else {
        $fsPad = if ($Config.FontScale) { [double]$Config.FontScale } else { 1.0 }
        $BubbleBorder.Width     = $targetW
        $BubbleBorder.Height    = 130.0
        $BubbleBorder.MinHeight = 130.0
        $BubbleBorder.MaxHeight = 130.0
        if ($script:currentBubblePanel -eq "deepseek" -and $fsPad -gt 1.05) {
            $BubbleBorder.Padding = [System.Windows.Thickness]::new(8, 3, 8, 3)
        } else {
            $BubbleBorder.Padding = [System.Windows.Thickness]::new(12, 8, 12, 8)
        }
    }

    $Bubble.Width  = $targetW
    $Bubble.Height = [double]::NaN
    [System.Windows.Controls.Canvas]::SetLeft($Bubble, $baseLeft + ($bs - 1.0) * 55.0)

    # Flush Measure -> Arrange synchronously before reading ActualHeight so Top/Origin never lag by 1 frame
    $BubbleBorder.InvalidateMeasure()
    $Bubble.InvalidateMeasure()
    if ($Window.IsLoaded -or $Bubble.IsArrangeValid) {
        $Window.UpdateLayout()
    } else {
        $Bubble.Measure([System.Windows.Size]::new($targetW, 390.0))
        $Bubble.Arrange([System.Windows.Rect]::new(0, 0, $targetW, $Bubble.DesiredSize.Height))
        $Bubble.UpdateLayout()
    }

    $rawCardH = if ($BubbleBorder.ActualHeight -gt 1.0) {
        [double]$BubbleBorder.ActualHeight
    } elseif ($BubbleBorder.DesiredSize.Height -gt 1.0) {
        [double]$BubbleBorder.DesiredSize.Height
    } else {
        if ($isWork) { 72.0 } else { 130.0 }
    }
    $cardH = if ($isWork) { [Math]::Max(72.0, [Math]::Min($maxWorkH, $rawCardH)) } else { 130.0 }

    $tailH = if ($BubbleTailPanel -and $BubbleTailPanel.ActualHeight -gt 1.0) {
        [double]$BubbleTailPanel.ActualHeight
    } elseif ($BubbleTailPanel -and $BubbleTailPanel.Height -gt 1.0) {
        [double]$BubbleTailPanel.Height
    } else {
        26.0
    }
    $totalH = [Math]::Max(1.0, $cardH + $tailH)

    [System.Windows.Controls.Canvas]::SetTop($Bubble, 169.0 - $cardH)
    $Bubble.RenderTransformOrigin = [System.Windows.Point]::new(0.50, [Math]::Round($cardH / $totalH, 4))
    $Bubble.InvalidateArrange()
    if ($Window.IsLoaded -or $Bubble.IsArrangeValid) {
        $Window.UpdateLayout()
    }

    if ($isWork -and $script:LastWorkLayoutSummary) {
        $script:LastWorkLayoutSummary.CardHeight = [Math]::Round($cardH, 2)
    }
    if ($script:DetailWindow -and $script:DetailWindow.IsVisible) {
        Update-DetailWindowPosition
    }
}

function Update-BubbleScale {
    if ($BubbleScale) {
        $BubbleScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $null)
        $BubbleScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $null)
        $bs = if ($Config.BubbleScale) { [double]$Config.BubbleScale } else { 1.0 }
        $bs = [Math]::Max(0.8, [Math]::Min(1.3, $bs))
        $Config.BubbleScale = $bs
        $BubbleScale.ScaleX = $bs
        $BubbleScale.ScaleY = $bs

        if ($script:currentBubblePanel -eq "work") {
            Update-WorkTaskLineBudget
        } else {
            Sync-BubbleGeometryAndAnchor
        }
    }
}

function Sync-WorkSourcesVisualScale([double]$fs) {
    $iconSz = [Math]::Round(13.0 * $fs, 1)
    if ($WorkSource) { $WorkSource.FontSize = [Math]::Round(10.5 * $fs, 1) }
    if ($WorkSourceCount) { $WorkSourceCount.FontSize = [Math]::Round(9.5 * $fs, 1) }
    if ($WorkSourceIcon) {
        $WorkSourceIcon.Width = $iconSz
        $WorkSourceIcon.Height = $iconSz
    }
    if ($script:WorkSecondaryPillPool) {
        foreach ($pill in $script:WorkSecondaryPillPool.Values) {
            if ($pill -and $pill.Tag -and $pill.Tag.Kind -eq "SourcePill") {
                if ($pill.Tag.Image) {
                    $pill.Tag.Image.Width = $iconSz
                    $pill.Tag.Image.Height = $iconSz
                }
                if ($pill.Tag.Label) {
                    $pill.Tag.Label.FontSize = [Math]::Round(10.5 * $fs, 1)
                }
            }
        }
    }
    $hintFs = [Math]::Round(9.5 * $fs, 1)
    if ($WorkCoopHintInline) { $WorkCoopHintInline.FontSize = $hintFs }
    if ($script:WorkCoopHintTextBlock -and (-not [Object]::ReferenceEquals($script:WorkCoopHintTextBlock, $WorkCoopHintInline))) {
        $script:WorkCoopHintTextBlock.FontSize = $hintFs
    }
}

function Sync-DeepSeekFontScale {
    $fs = if ($Config.FontScale) { [double]$Config.FontScale } else { 1.0 }
    if ($fs -lt 0.80) { $fs = 0.80 }
    if ($fs -gt 1.40) { $fs = 1.40 }
    $pctFs = [Math]::Min(1.25, $fs)
    $isTimeout = [bool]$script:deepSeekTimeoutLayout
    $isSnapLbl = [bool]$script:deepSeekSnapshotLabelActive

    $baseHeader   = if ($isTimeout) { 11.0 } else { 12.5 }
    $baseNotice   = if ($isTimeout) { 9.5 } else { 10.0 }
    $baseCurrency = if ($isSnapLbl -or $isTimeout) { 10.0 } else { 10.8 }

    if ($DeepSeekHeader)          { $DeepSeekHeader.FontSize          = [Math]::Round($baseHeader * $fs, 2) }
    if ($DeepSeekBadgeText)       { $DeepSeekBadgeText.FontSize       = [Math]::Round(9.5 * $fs, 2) }
    if ($DeepSeekStatusNotice)    { $DeepSeekStatusNotice.FontSize    = [Math]::Round($baseNotice * $fs, 2) }
    if ($RefreshDeepSeekBtn)      { $RefreshDeepSeekBtn.FontSize      = [Math]::Round(12.5 * $fs, 2) }
    if ($DeepSeekCurrencyLabel)   { $DeepSeekCurrencyLabel.FontSize   = [Math]::Round($baseCurrency * $fs, 2) }
    if ($DeepSeekAvailableNotice) { $DeepSeekAvailableNotice.FontSize = [Math]::Round(9.5 * $fs, 2) }
    if ($DeepSeekTotalText)       { $DeepSeekTotalText.FontSize       = [Math]::Round(18.0 * $pctFs, 2) }
    if ($DeepSeekBreakdownText)   { $DeepSeekBreakdownText.FontSize   = [Math]::Round(10.0 * $fs, 2) }
    if ($DeepSeekPricingLink)     { $DeepSeekPricingLink.FontSize     = [Math]::Round(9.5 * $fs, 2) }
    if ($DeepSeekMsgTitle)        { $DeepSeekMsgTitle.FontSize        = [Math]::Round(12.5 * $fs, 2) }
    if ($DeepSeekMsgDetail) {
        $DeepSeekMsgDetail.FontSize   = [Math]::Round(10.5 * $fs, 2)
        $DeepSeekMsgDetail.LineHeight = [Math]::Ceiling(14.5 * $fs)
        $DeepSeekMsgDetail.MaxHeight  = [Math]::Ceiling(44.0 * $fs)
    }
    if ($fs -gt 1.05) {
        if ($DeepSeekHeaderGrid)  { $DeepSeekHeaderGrid.Margin  = [System.Windows.Thickness]::new(0, 0, 0, 1) }
        if ($DeepSeekMainRowGrid) { $DeepSeekMainRowGrid.Margin = [System.Windows.Thickness]::new(0, 0, 0, 0) }
        if ($DeepSeekSubRowGrid)  { $DeepSeekSubRowGrid.Margin  = [System.Windows.Thickness]::new(0, 0, 0, 0) }
        if ($DeepSeekContentGrid) { $DeepSeekContentGrid.MinHeight = 0 }
    } else {
        if ($DeepSeekHeaderGrid)  { $DeepSeekHeaderGrid.Margin  = [System.Windows.Thickness]::new(0, 0, 0, 5) }
        if ($DeepSeekMainRowGrid) { $DeepSeekMainRowGrid.Margin = [System.Windows.Thickness]::new(0, 1, 0, 1) }
        if ($DeepSeekSubRowGrid)  { $DeepSeekSubRowGrid.Margin  = [System.Windows.Thickness]::new(0, 3, 0, 0) }
        if ($DeepSeekContentGrid) { $DeepSeekContentGrid.MinHeight = 56 }
    }
    if ($script:currentBubblePanel -eq "deepseek" -and $BubbleBorder) {
        if ($fs -gt 1.05) {
            $BubbleBorder.Padding = [System.Windows.Thickness]::new(8, 3, 8, 3)
        } else {
            $BubbleBorder.Padding = [System.Windows.Thickness]::new(12, 8, 12, 8)
        }
    }

    if ($DeepSeekHeaderGrid -is [System.Windows.Controls.Grid] -and $DeepSeekStatusNotice -is [System.Windows.FrameworkElement]) {
        $inf = [System.Windows.Size]::new([double]::PositiveInfinity, [double]::PositiveInfinity)
        if ($DeepSeekPricingLink -is [System.Windows.FrameworkElement] -and $DeepSeekSubRowGrid -is [System.Windows.Controls.Grid]) {
            if ($DeepSeekPricingLink.Parent -ne $DeepSeekSubRowGrid) {
                if ($DeepSeekPricingLink.Parent) { [void]$DeepSeekPricingLink.Parent.Children.Remove($DeepSeekPricingLink) }
                [void]$DeepSeekSubRowGrid.Children.Add($DeepSeekPricingLink)
            }
            [System.Windows.Controls.Grid]::SetRow($DeepSeekPricingLink, 0)
            [System.Windows.Controls.Grid]::SetColumn($DeepSeekPricingLink, 1)
            [System.Windows.Controls.Grid]::SetColumnSpan($DeepSeekPricingLink, 1)
            $DeepSeekPricingLink.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Right
        }
        [System.Windows.Controls.Grid]::SetRow($DeepSeekStatusNotice, 0)
        [System.Windows.Controls.Grid]::SetColumn($DeepSeekStatusNotice, 1)
        [System.Windows.Controls.Grid]::SetColumnSpan($DeepSeekStatusNotice, 1)
        $DeepSeekStatusNotice.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Right
        $DeepSeekStatusNotice.Margin = [System.Windows.Thickness]::new(2, 0, 2, 0)

        if ($DeepSeekAvailableNotice -is [System.Windows.FrameworkElement]) {
            [System.Windows.Controls.Grid]::SetRow($DeepSeekAvailableNotice, 0)
            [System.Windows.Controls.Grid]::SetColumn($DeepSeekAvailableNotice, 1)
            [System.Windows.Controls.Grid]::SetColumnSpan($DeepSeekAvailableNotice, 1)
            $DeepSeekAvailableNotice.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
            $DeepSeekAvailableNotice.Margin = [System.Windows.Thickness]::new(4, 0, 4, 1)
        }

        $padW = if ($fs -gt 1.05) { 16.0 } else { 24.0 }
        $cardInnerW = 264.0 - 4.4 - $padW
        $col0Stack = if ($DeepSeekHeader) { $DeepSeekHeader.Parent -as [System.Windows.FrameworkElement] } else { $null }
        $col0W = 0.0
        if ($col0Stack) { $col0Stack.InvalidateMeasure(); $col0Stack.Measure($inf); $col0W = $col0Stack.DesiredSize.Width }
        $btnW = 0.0
        if ($RefreshDeepSeekBtn -is [System.Windows.FrameworkElement]) { $RefreshDeepSeekBtn.InvalidateMeasure(); $RefreshDeepSeekBtn.Measure($inf); $btnW = $RefreshDeepSeekBtn.DesiredSize.Width }
        $DeepSeekStatusNotice.InvalidateMeasure(); $DeepSeekStatusNotice.Measure($inf)
        $availCol1W = [Math]::Max(0.0, $cardInnerW - $col0W - $btnW)

        if ($DeepSeekStatusNotice.DesiredSize.Width -gt ($availCol1W + 0.5)) {
            [System.Windows.Controls.Grid]::SetRow($DeepSeekStatusNotice, 1)
            [System.Windows.Controls.Grid]::SetColumn($DeepSeekStatusNotice, 0)
            [System.Windows.Controls.Grid]::SetColumnSpan($DeepSeekStatusNotice, 3)
            $DeepSeekStatusNotice.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
            $DeepSeekStatusNotice.Margin = [System.Windows.Thickness]::new(0, 0, 0, 0)
            if ($DeepSeekOkPanel -and $DeepSeekOkPanel.Visibility -eq [System.Windows.Visibility]::Visible -and ($DeepSeekPricingLink -is [System.Windows.FrameworkElement])) {
                if ($DeepSeekPricingLink.Parent) { [void]$DeepSeekPricingLink.Parent.Children.Remove($DeepSeekPricingLink) }
                [void]$DeepSeekHeaderGrid.Children.Add($DeepSeekPricingLink)
                [System.Windows.Controls.Grid]::SetRow($DeepSeekPricingLink, 1)
                [System.Windows.Controls.Grid]::SetColumn($DeepSeekPricingLink, 0)
                [System.Windows.Controls.Grid]::SetColumnSpan($DeepSeekPricingLink, 3)
                $DeepSeekPricingLink.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Right
            }
        }

        if ($DeepSeekAvailableNotice -is [System.Windows.FrameworkElement] -and (-not [string]::IsNullOrEmpty($DeepSeekAvailableNotice.Text)) -and ($DeepSeekCurrencyLabel -is [System.Windows.FrameworkElement]) -and ($DeepSeekTotalText -is [System.Windows.FrameworkElement])) {
            $DeepSeekCurrencyLabel.InvalidateMeasure(); $DeepSeekCurrencyLabel.Measure($inf)
            $DeepSeekAvailableNotice.InvalidateMeasure(); $DeepSeekAvailableNotice.Measure($inf)
            $DeepSeekTotalText.InvalidateMeasure(); $DeepSeekTotalText.Measure($inf)
            $availMainCol0 = [Math]::Max(0.0, $cardInnerW - $DeepSeekAvailableNotice.DesiredSize.Width - $DeepSeekTotalText.DesiredSize.Width)
            if ($DeepSeekCurrencyLabel.DesiredSize.Width -gt ($availMainCol0 + 0.5)) {
                [System.Windows.Controls.Grid]::SetRow($DeepSeekAvailableNotice, 1)
                [System.Windows.Controls.Grid]::SetColumn($DeepSeekAvailableNotice, 0)
                [System.Windows.Controls.Grid]::SetColumnSpan($DeepSeekAvailableNotice, 3)
                $DeepSeekAvailableNotice.Margin = [System.Windows.Thickness]::new(0, 0, 0, 0)
            }
        }
    }
}

function Update-FontScale {
    $fs = if ($Config.FontScale) { [double]$Config.FontScale } else { 1.0 }
    if ($fs -lt 0.80) { $fs = 0.80 }
    if ($fs -gt 1.40) { $fs = 1.40 }
    $pctFs = [Math]::Min(1.25, $fs)
    $WorkHeader.FontSize       = [Math]::Round(12.5 * $fs, 1)
    if ($WorkDot) {
        $dotSz = [Math]::Round(8.5 * $fs, 1)
        $WorkDot.Width = $dotSz
        $WorkDot.Height = $dotSz
    }
    if ($WorkBodyWatermark) {
        $WorkBodyWatermark.FontSize = [Math]::Round([Math]::Min(32.0, 28.0 * $fs), 1)
    }
    Sync-WorkSourcesVisualScale $fs
    $WorkTask.FontSize         = [Math]::Round(12.5 * $fs, 1)
    $WorkTask.LineHeight       = [Math]::Ceiling(18.0 * $fs)
    $QuotaHeader.FontSize      = [Math]::Round(12.5 * $fs, 1)
    $QuotaPlanText.FontSize    = [Math]::Round(10.0 * $fs, 1)
    $QuotaResetNotice.FontSize = [Math]::Round(10.0 * $fs, 1)
    $ShortLabel.FontSize       = [Math]::Round(11.5 * $fs, 1)
    $ShortReset.FontSize       = [Math]::Round(10.5 * $fs, 1)
    $ShortPercent.FontSize     = [Math]::Round(18.0 * $pctFs, 1)
    $WeekLabel.FontSize        = [Math]::Round(11.5 * $fs, 1)
    $WeekReset.FontSize        = [Math]::Round(10.5 * $fs, 1)
    $WeekPercent.FontSize      = [Math]::Round(18.0 * $pctFs, 1)
    $QuoteSpeaker.FontSize     = [Math]::Round(12.5 * $fs, 1)
    $QuoteHint.FontSize        = [Math]::Round(10.0 * $fs, 1)
    $QuoteText.FontSize        = [Math]::Round(13.5 * $fs, 1)
    $QuoteText.LineHeight      = [Math]::Round(20.0 * $fs, 1)
    Sync-DeepSeekFontScale
    Update-WorkTaskLineBudget
    Update-DetailWindowFontScale
    if ($script:DetailWindow -and $script:DetailWindow.IsVisible) {
        Update-DetailWindowPosition
    }
}

# ============================================================================
# 7.5. Three-Tier Work Bubble Layout & Focus-Free Task Detail Card
# ============================================================================
$script:DetailWindow = $null
$script:DetailRootGrid = $null
$script:DetailArrowTop = $null
$script:DetailArrowBottom = $null
$script:DetailCardBorder = $null
$script:DetailTitleText = $null
$script:DetailSourcePill = $null
$script:DetailSourceIcon = $null
$script:DetailSourceMetaText = $null
$script:DetailHintBanner = $null
$script:DetailHintText = $null
$script:DetailScrollViewer = $null
$script:DetailBodyText = $null
$script:DetailFooterBorder = $null
$script:DetailFooterText = $null
$script:lastWorkStatusObj = $null
$script:LastDetailContentKey = $null
$script:LastDetailMetaKey = $null
$script:DetailHoverTimer = $null
$script:detailTriggerEnterAt = [DateTime]::MinValue
$script:detailLeaveAt = [DateTime]::MinValue
$script:TrayHoverDetailMenuItem = $null
$script:WpfHoverDetailMenuItem = $null
$script:WorkCoopHintTextBlock = $null
$script:WorkOtherActiveCount = 0
$script:WorkActiveSecondaryStyles = @()
$script:WorkSecondaryPillPool = @{}
$script:LastWorkLayoutSummary = $null
$script:WorkIsStateChipHighlighted = $false
$script:WorkCardMaxHeightOverride = 0.0

function Get-WorkShortHeaderText([string]$state) {
    switch ($state) {
        "thinking" { return "思考中" }
        "working"  { return "工作中" }
        "calling"  { return "工作中" }
        "waiting"  { return "等待回答" }
        "approval" { return "等待确认" }
        "stalled"  { return "可能停滞" }
        "result"   { return "步骤完成" }
        "success"  { return "任务完成" }
        "done"     { return "任务完成" }
        "error"    { return "执行异常" }
        default    { return "工作中" }
    }
}

$script:WorkStatusTextsByCharacter = @{
    claude = @{
        thinking = @(
            '正翻阅怀里的典籍核对上下文呢…',
            '红茶才刚泡好，容我把调用链理清。',
            '正在书稿上推敲改动蓝图与边界…',
            '指尖扶好发饰——开始专注推导逻辑！',
            '优等生可不会漏掉细节，正在比对架构…',
            '容我垂眸细想片刻，解法马上成型。'
        )
        working = @(
            '已按典籍上的蓝图动笔改代码啦~',
            '正在紧盯终端日志，主人先喝口红茶吧。',
            '代码洁癖发作中，正在帮主人重构整理！',
            '手头的改动很顺畅，茶点额度还很充裕~',
            '正在一行行落实逻辑，脏活累活交给我。',
            '书房里正忙着编译构建，请主人稍候~'
        )
        waiting = @(
            '施工蓝图铺好啦，请主人过目拍板~',
            '这一步得守规矩等主人点头才能动笔。',
            '把典籍递到您手边——这里请主人定夺。',
            '正在安静候命，等主人批下权限许可~',
            '茶杯先替您温着，确认完这一步咱们继续。',
            '遇到关键分支了，想先听听主人的心意~'
        )
        stalled = @(
            '红茶都快凉半盏了，这一步还在跑呢…',
            '对面响应有些迟缓，我抱着典籍替您守着。',
            '工具还没回音，主人别急，我盯着日志呢。'
        )
        result = @(
            '终端回执已收进典籍，正在为您批注汇总~',
            '这一步验证通过，正在衔接下一章逻辑…',
            '关键输出已经夹进书签，马上整理呈上！',
            '工具返回妥当，容我用优等生标准核对一遍。',
            '数据采集完毕，正在书案上誊写结论…',
            '阶段结果很清晰，正在收拢最终答复~'
        )
        success = @(
            '合上印花典籍——当前回合漂亮收官啦！',
            '这可是优等生的基本功，没给主人丢脸吧？',
            '代码修得干干净净，主人快尝口热茶查验~',
            '哼哼，蓝图已圆满落地，随时听候新差遣。',
            '这一轮稳稳办妥，发间的向日葵都舒展开啦~',
            '全部验收就绪，主人靠着歇口气吧~'
        )
        error = @(
            '居然有顽固报错折磨主人？我来替您收拾它！',
            '眉头微蹙翻开典籍——正在顺着堆栈揪元凶…',
            '捕获到一处隐蔽异常，交给我一行行排查！',
            '边界条件撞了小墙，别慌，我这就帮您兜底。',
            '日志里藏着点毛病，休想逃过优等生的眼睛！',
            '主人喝口水消消气，这处报错交给我摆平。'
        )
    }
    gemini = @{
        thinking = @(
            '双子星轨对齐中，正在全图扫描上下文~',
            '左眼看全局、右眼盯细节，方案推演中！',
            '正在星盘上检索跨文件依赖，马上锁定~',
            '两套思路正在脑海里赛跑，挑最优那条！',
            '穿梭在超长上下文星海里，线索连上啦~',
            '星轨坐标已校准，正在绘制最佳改动路线！'
        )
        working = @(
            '正沿着星轨全速改代码，比流星还稳哦~',
            '双线并进中，一边盯终端一边更新文件！',
            '代码星图正在点亮，改动一步步成形啦~',
            '指尖划过星盘，正在利落地重构模块！',
            '构建与修改同步推进中，节奏超合拍~',
            '算力星海全开，剩下的步骤包在我身上！'
        )
        waiting = @(
            '星轨前方出现岔路啦，等主人选一颗星~',
            '悬停在确认节点上，等主人挥手放行！',
            '双子视角准备就绪，请主人拍板定方向~',
            '这里需要主人的通行密令才能继续跃迁哦。',
            '星盘指针停在这儿啦，请主人点一下确认~',
            '留了一个关键坐标等您决定，随时出发！'
        )
        stalled = @(
            '深空信号回传有点慢，星盘还在闪烁等待…',
            '这一步像飞进了慢速星云，我继续替您观测~',
            '远端工具还没亮灯，再耐心守望一会儿…'
        )
        result = @(
            '顺着星光把返回数据捞回来啦，正在汇总！',
            '观测结果已落入星盘，正在拼合完整拼图~',
            '工具信号接收完毕，正在双视角交叉核对！',
            '关键碎片收集齐啦，马上点亮最终结论~',
            '终端回波很清晰，正在为您提炼星图摘要！',
            '这一站的果实已摘下，正在飞快组织答复~'
        )
        success = @(
            '双子星闪耀收官！这一轮跑得又快又漂亮~',
            '星图全数点亮，主人快来看看成果吧！',
            '比流星还干脆地搞定啦，随时准备下次巡航~',
            '所有轨道严丝合缝，给这次配合记一颗亮星★',
            '圆满抵达终点坐标，下一站飞去哪个模块？',
            '任务顺利收束进星盘，主人今天超厉害！'
        )
        error = @(
            '星轨探测到异常乱流，正在锁定故障坐标！',
            '哎呀，某颗节点报错熄火了，我马上检修~',
            '开启双倍视野追踪红字堆栈，休想藏起来！',
            '发现一处偏航报错，正在重新校准代码逻辑~',
            '捕获到报错碎片，让我换条星轨绕过去修好！',
            '小风浪而已，星盘已经圈出问题行号啦！'
        )
    }
    dragon = @{
        thinking = @(
            '支起龙角看代码中……让我琢磨怎么写最省事。',
            '尾巴尖轻轻晃——正在盘算怎么一步到位。',
            '看在好吃的 Token 份上，帮您把逻辑理一遍…',
            '别催，本龙正在翻上下文帮您探坑呢。',
            '眯着眼扫完这堆文件了，大概知道怎么动爪。',
            '先把前因后果摸清楚，省得待会儿耽误我打盹。'
        )
        working = @(
            '收起懒腰认真干活中，连尾巴都绷直啦！',
            '在敲了在敲了，正帮您把乱糟糟的代码拍平…',
            '一口气吃掉这么多 Token，干起活来当然利索！',
            '正盯着终端跑命令呢，谁也别想卡主人的流程。',
            '本龙亲自出马改文件，您就安心坐等收成吧~',
            '爪子飞快敲键盘中，干完这票就回去盘着睡！'
        )
        waiting = @(
            '尾巴拍拍桌角——喂，这里要主人点个头才行。',
            '卡在授权确认啦，快批一下，别让本龙干等~',
            '这步得主人亲自拿主意，我先揣着爪子等您。',
            '快看屏幕！确认完这一项我好一口气收工~',
            '停爪待命中，等主人发话往哪边改。',
            '有个选项得问您，批完记得奖励我一点 Token~'
        )
        stalled = @(
            '对面慢吞吞的，等得本龙都快打哈欠了…',
            '这一步怎么还在转圈？我支着耳朵替您守着。',
            '工具半天没吐结果，先盘着尾巴耐心耗会儿…'
        )
        result = @(
            '输出终于吐出来啦，本龙帮您挑重点整理下。',
            '叼住刚返回的终端结果，正在合成最终汇报~',
            '这一步跑通了，抖抖耳朵准备接下一棒！',
            '数据到手，正在剔掉废话留干货给主人看。',
            '工具总算干完活了，容我再最后扫一眼细节。',
            '拿到回执啦，三两下帮您收拢成结论~'
        )
        success = @(
            '搞定收工！本龙可以安心盘起尾巴继续摸鱼啦~',
            '干得这么漂亮，今天的 Token 花得超值吧？',
            '三下五除二摆平，快夸我两句顺便投喂一下~',
            '活儿全办妥了，剩下的时间归我趴着打盹！',
            '利落交差！有本龙在，哪用得着主人操心~',
            '圆满搞定，伸个大懒腰——今天又省下不少功夫！'
        )
        error = @(
            '啧，哪个不长眼的 Bug 敢卡主人的代码？',
            '龙角雷达响了，正在把报错日志揪出来拷问！',
            '撞上报错了？别烦心，本龙帮您把坑填平。',
            '甩甩尾巴进入认真模式——正在定位哪行闯的祸！',
            '发现一处烂代码报错，看我三两下把它修老实。',
            '小场面，等我顺着堆栈把这只臭虫拍飞！'
        )
    }
    deepseek = @{
        thinking = @(
            '脑袋顶上的呆毛正在竖起来，深海推理中…',
            '托腮拿着小筷子琢磨中，怎么写最划算呢？',
            '正在海底打捞上下文线索，很快就能浮上水面~',
            '咕噜咕噜……脑海里的推导泡泡正一串串冒出来！',
            '正在对照需求仔细推演，马上给出漂亮解法~',
            '先在深水区把边界算清楚，待会儿动笔才不返工！'
        )
        working = @(
            '蓝鲸笔记本全速运转中，一边敲代码一边盯终端~',
            '小指一点，全息代码屏刷刷展开——全速干活中！',
            '大肥鱼正在认真改文件，小饭碗都顾不上扒两口啦！',
            '正在把逻辑一行行捞起来理顺，主人稍安勿躁~',
            '海蓝光标飞速跳动中，剩下的杂活包在我身上！',
            '鲸尾轻轻拍打节拍——构建与修改同步推进中~'
        )
        waiting = @(
            '双手捧着空空的小白碗——主人，这里等您拍板投喂许可呢！',
            '咕……端着空碗眼巴巴望着您，点一下确认就继续~',
            '碰到关键分岔口啦，等主人发个话我再接着干活！',
            '小鲸尾停下来晃了晃，请主人过目这一步权限确认~',
            '饭碗先举到屏幕前啦！您点个头我就立马开动~',
            '等主人做出选择呢，选好我继续潜下去帮您码字！'
        )
        stalled = @(
            '海面有点起雾，对面响应慢悠悠的，我浮着替您守着…',
            '这一步好像卡在深水区了，我捧着饭碗继续盯着日志…',
            '工具还没回信呢，先晃晃鲸尾耐心等一会儿~'
        )
        result = @(
            '终端结果打捞上岸啦，正在为您盛进结果碗里~',
            '气泡里裹着关键输出浮上来咯，容我整理呈上！',
            '这一小步顺顺当当跑通了，正在串联下一段内容…',
            '数据已经捞齐，正在过滤杂鱼留干货给主人看~',
            '工具交差啦，容大肥鱼再对照需求核实一遍！',
            '阶段回执收好咯，马上汇总成清晰回复呈给您~'
        )
        success = @(
            '满满一碗香喷喷的代码端上来啦！大肥鱼今天超棒吧？',
            '呼呼~ 捧着热腾腾的白米饭收工庆祝，主人快验收吧！',
            '深海探索圆满浮水！这一轮又快又省心地跑完啦~',
            '全部打捞验收完毕，记得夸夸努力干活的大肥鱼哦！',
            '小饭碗装得满满当当，随时准备接下一顿大餐任务！',
            '蓝鲸勋章闪亮亮~ 今天的代码也顺利端稳上桌啦！'
        )
        error = @(
            '噗噜？！哪里冒出来的调皮 Bug 撞翻了小饭碗！',
            '呆毛警报拉响——正在顺着堆栈潜下去捉那只漏洞！',
            '抓到一处红字报错啦，主人别慌，我马上下海修补~',
            '鲸尾一拍掀起水花，哪个边界条件敢在这里捣乱！',
            '捕获到异常信号了，容我托腮理出它报错的原因…',
            '小风浪而已，大肥鱼这就把它拍平再继续往前游！'
        )
    }
    zcode = @{
        thinking = @(
            '托腮眨眨蓝灰眼眸，头顶灵感小灯泡亮起来啦…',
            '狐耳轻轻支起——正在细听代码上下文里的线索！',
            '银色小铃铛晃了晃，正在推演最稳妥的重构路线…',
            '额前的睡眠眼罩还没戴上呢，此刻思路可清醒着！',
            '正在对照依赖关系反复思量，解法就快浮现了~',
            '大尾巴在身后慢悠悠扫过，容我理顺这一段逻辑！'
        )
        working = @(
            '爪印笔记本嗡嗡运转中，正在全息代码屏上飞快落笔！',
            '叮铃~ 智谱娘认真进入编码节奏，终端和文件双线推进中！',
            '指尖在代码浮窗上轻点，一行行规则逻辑稳稳落地~',
            '黑色哥特裙摆微微扬起，正在把乱糟糟的结构理顺！',
            '蓝光星芒闪过——构建与改动正有序执行呢！',
            '双腕黑扣系紧，这一轮的编码重活交给我就好啦！'
        )
        waiting = @(
            '狐耳垂下来一点点——主人，这里需要您点头才能继续哦。',
            '悬停在分支节点上呢，等主人亲自拍板下发指令~',
            '铃铛轻响提醒：有个权限确认正等着主人批复！',
            '暂且合上爪印笔记本，请问主人接下来希望怎么走？',
            '等待您的确认信号，批下来我立刻继续推进~',
            '这步涉及重要改动，请主人先确认后再由我执行吧！'
        )
        stalled = @(
            '对面好久没动静呀，狐耳一直竖着替您等回音呢…',
            '这一步执行有点久，我先把铃铛按住安静守候日志~',
            '远端响应慢半拍，不过大尾巴一直帮您暖着桌面等结果…'
        )
        result = @(
            '全息屏返回数据已接住，正在整理清晰结论给您~',
            '铃铛响了一记提示音，这一步的验证输出已收进笔记本！',
            '工具执行回执妥当，容我核对细节后马上汇报~',
            '线索拼图刚凑齐，蓝灰眼眸正在快速扫读关键片段…',
            '阶段性结果已落袋，正在为您串联下一节推进~',
            '命令回波收齐了，正在精简冗余后呈现最终结论~'
        )
        success = @(
            '眼里闪出亮晶晶的蓝星★ 这一轮漂亮拿下啦，主人！',
            '叮铃叮铃~ 所有检查与改动全数收官，是不是超可靠！',
            '双拳一攥满心欢喜——今天的代码质量也让狐耳满意呢！',
            '爪印笔记本合上啦，圆满交差，请主人检阅成果~',
            '蓝紫挑染都跟着亮起来咯，随时准备好迎接下一题！',
            '全部稳妥落地，大尾巴得意地晃了三圈呢~'
        )
        error = @(
            '狐耳警觉地弹起来了！刚才捕获到一处异常报错！',
            '咦，红字从哪儿冒出来的？容我托腮顺着调用栈查清！',
            '叮铃警示响起——发现一处越界异常，我马上动手修复~',
            '可别想藏过我的蓝灰眼眸，正在锁定引发报错的那一行！',
            '遇到一点小故障，主人喝口水吧，我来把逻辑修顺畅~',
            '异常堆栈已经记进爪印笔记本，这就逐条拆解摆平它！'
        )
    }
}

$script:AllKnownWorkStatusTexts = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
foreach ($cMap in $script:WorkStatusTextsByCharacter.Values) {
    foreach ($arr in $cMap.Values) {
        foreach ($line in $arr) {
            [void]$script:AllKnownWorkStatusTexts.Add([string]$line)
        }
    }
}
$script:CharacterStateTextCache = @{}

function Resolve-CharacterWorkStateText($stObj) {
    if (-not $stObj) { return "" }
    $rawStateText = if ($stObj.stateText) { ([string]$stObj.stateText).Trim() } else { "" }
    if (-not $rawStateText) { return "" }
    if (-not $script:AllKnownWorkStatusTexts.Contains($rawStateText)) {
        return $rawStateText
    }
    $charKey = if ($Config -and $Config.Character -in @("claude", "dragon", "gemini", "deepseek", "zcode")) { [string]$Config.Character } else { "claude" }
    $rawState = if ($stObj.state) { ([string]$stObj.state).ToLowerInvariant() } else { "working" }
    $normState = switch ($rawState) {
        "approval" { "waiting" }
        "calling"  { "working" }
        "done"     { "success" }
        default    { $rawState }
    }
    $poolMap = $script:WorkStatusTextsByCharacter[$charKey]
    if (-not $poolMap) { $poolMap = $script:WorkStatusTextsByCharacter["claude"] }
    $list = if ($poolMap.ContainsKey($normState)) { $poolMap[$normState] } else { $poolMap["working"] }
    if (-not $list -or $list.Count -eq 0) { return $rawStateText }

    $rawId = if ($stObj.rawId) { [string]$stObj.rawId } elseif ($stObj.sessionId) { [string]$stObj.sessionId } else { "" }
    $cacheKey = "$charKey|$normState|$rawId"
    if ($list -contains $rawStateText) {
        $script:CharacterStateTextCache[$cacheKey] = $rawStateText
        return $rawStateText
    }
    if ($script:CharacterStateTextCache.ContainsKey($cacheKey)) {
        $cached = [string]$script:CharacterStateTextCache[$cacheKey]
        if ($list -contains $cached) { return $cached }
    }
    $pickedIdx = if ($list.Count -eq 1) { 0 } else { Get-Random -Minimum 0 -Maximum $list.Count }
    $picked = [string]$list[$pickedIdx]
    $script:CharacterStateTextCache[$cacheKey] = $picked
    return $picked
}

function Get-WorkBubbleDisplayTask($stObj) {
    if (-not $stObj) { return "正在执行步骤..." }
    $state = if ($stObj.state) { ([string]$stObj.state).ToLowerInvariant() } else { "working" }
    $taskText = if ($stObj.task -and (-not [string]::IsNullOrWhiteSpace([string]$stObj.task))) { ([string]$stObj.task).Trim() } else { "" }
    $stateText = Resolve-CharacterWorkStateText $stObj
    $hoverOn = ($null -ne $Config -and [bool]$Config.HoverDetailsEnabled)

    if (($state -in @("waiting", "approval", "stalled", "error")) -or (-not $hoverOn)) {
        if ($taskText) { return $taskText }
        if ($stateText) { return $stateText }
        return "正在执行步骤..."
    }
    if ($stateText) { return $stateText }
    if ($taskText) { return $taskText }
    return "正在执行步骤..."
}

function Get-WorkDetailDisplayBody($stObj) {
    if (-not $stObj) { return "正在执行步骤..." }
    $taskText = if ($stObj.task -and (-not [string]::IsNullOrWhiteSpace([string]$stObj.task))) { ([string]$stObj.task).Trim() } else { "" }
    $detailText = if ($stObj.taskDetail -and (-not [string]::IsNullOrWhiteSpace([string]$stObj.taskDetail))) { ([string]$stObj.taskDetail).Trim() } else { "" }

    if ($taskText -and $detailText) {
        if (($detailText -ceq $taskText) -or $detailText.StartsWith("当前任务：$taskText")) {
            return $detailText
        }
        return "当前任务：$taskText`n`n$detailText"
    }
    if ($detailText) { return $detailText }
    if ($taskText) { return $taskText }
    return "正在执行步骤..."
}

function Get-AgentSourceKey([string]$rawSource) {
    $low = if ($rawSource) { $rawSource.ToLower() } else { "antigravity" }
    switch -Wildcard ($low) {
        "*antigravity*" { return "antigravity" }
        "*反重力*"     { return "antigravity" }
        "*dsh*"         { return "dsh" }
        "*deepseek*"    { return "dsh" }
        "*codex*"       { return "codex" }
        "*claude*"      { return "claude" }
        "*gemini*"      { return "gemini" }
        default         { return "antigravity" }
    }
}

function Get-AgentSourceStyle([string]$rawSource) {
    $key = Get-AgentSourceKey $rawSource
    switch ($key) {
        "antigravity" {
            return @{
                Key = "antigravity"; Label = "Antigravity"
                Foreground = "#FF1D4ED8"; Background = "#DDFFFFFF"; DetailBackground = "#FFEFF6FF"; BorderBrush = "#FFBFDBFE"
            }
        }
        "dsh" {
            return @{
                Key = "dsh"; Label = "DSH"
                Foreground = "#FF026AA7"; Background = "#DDFFFFFF"; DetailBackground = "#FFE8F4FD"; BorderBrush = "#FFB3DDF2"
            }
        }
        "codex" {
            return @{
                Key = "codex"; Label = "Codex"
                Foreground = "#FF0F766E"; Background = "#DDFFFFFF"; DetailBackground = "#FFEBF8F3"; BorderBrush = "#FFAFE1CD"
            }
        }
        default {
            $lbl = if ($rawSource) { $rawSource } else { "Antigravity" }
            return @{
                Key = $key; Label = $lbl
                Foreground = "#FFA65518"; Background = "#DDFFFFFF"; DetailBackground = "#FFF6E8DC"; BorderBrush = "#FFE5C2A8"
            }
        }
    }
}

function New-WorkSourcePillElement($style, [double]$fs) {
    $bd = New-Object System.Windows.Controls.Border
    $bd.CornerRadius = [System.Windows.CornerRadius]::new(8.5)
    $bd.Padding = [System.Windows.Thickness]::new(5, 1, 5.5, 1)
    $bd.Margin = [System.Windows.Thickness]::new(0, 0, 4, 2)
    $bd.BorderThickness = [System.Windows.Thickness]::new(0.9)
    $bd.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    try {
        $bd.Background = $BrushConv.ConvertFromString($style.Background)
        $bd.BorderBrush = $BrushConv.ConvertFromString($style.BorderBrush)
    } catch {}

    $sp = New-Object System.Windows.Controls.StackPanel
    $sp.Orientation = [System.Windows.Controls.Orientation]::Horizontal
    $sp.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

    $img = New-Object System.Windows.Controls.Image
    $imgSz = [Math]::Round(13.0 * $fs, 1)
    $img.Width = $imgSz
    $img.Height = $imgSz
    $img.Margin = [System.Windows.Thickness]::new(0, 0, 4, 0)
    $img.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($img, [System.Windows.Media.BitmapScalingMode]::HighQuality)
    if ($script:AgentIcons -and $script:AgentIcons.ContainsKey($style.Key)) {
        $img.Source = $script:AgentIcons[$style.Key]
        $img.Visibility = [System.Windows.Visibility]::Visible
    } else {
        $img.Visibility = [System.Windows.Visibility]::Collapsed
    }
    [void]$sp.Children.Add($img)

    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.Text = $style.Label
    $tb.FontSize = [Math]::Round(10.5 * $fs, 1)
    $tb.FontWeight = [System.Windows.FontWeights]::Bold
    $tb.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    try { $tb.Foreground = $BrushConv.ConvertFromString($style.Foreground) } catch {}
    [void]$sp.Children.Add($tb)

    $bd.Tag = @{ Kind = "SourcePill"; Key = $style.Key; Image = $img; Label = $tb }
    $bd.Child = $sp
    return $bd
}

function Get-OrCreateWorkSourcePillElement($style, [double]$fs) {
    if (-not $script:WorkSecondaryPillPool) { $script:WorkSecondaryPillPool = @{} }
    $key = [string]$style.Key
    if (-not $script:WorkSecondaryPillPool.ContainsKey($key) -or -not $script:WorkSecondaryPillPool[$key]) {
        $script:WorkSecondaryPillPool[$key] = New-WorkSourcePillElement $style $fs
    }
    $pill = $script:WorkSecondaryPillPool[$key]
    $iconSz = [Math]::Round(13.0 * $fs, 1)
    if ($pill.Tag) {
        $img = $pill.Tag.Image
        $tb = $pill.Tag.Label
        if ($img) {
            $img.Width = $iconSz
            $img.Height = $iconSz
            if ($script:AgentIcons -and $script:AgentIcons.ContainsKey($key)) {
                if ($img.Source -ne $script:AgentIcons[$key]) { $img.Source = $script:AgentIcons[$key] }
                $img.Visibility = [System.Windows.Visibility]::Visible
            } else {
                $img.Visibility = [System.Windows.Visibility]::Collapsed
            }
        }
        if ($tb) {
            if ($tb.Text -cne $style.Label) { $tb.Text = $style.Label }
            $tb.FontSize = [Math]::Round(10.5 * $fs, 1)
            try { $tb.Foreground = $BrushConv.ConvertFromString($style.Foreground) } catch {}
        }
    }
    try {
        $pill.Background = $BrushConv.ConvertFromString($style.Background)
        $pill.BorderBrush = $BrushConv.ConvertFromString($style.BorderBrush)
    } catch {}
    return $pill
}

function Detach-UIElementFromParent([System.Windows.UIElement]$el) {
    if (-not $el) { return }
    $parent = $null
    if ($el -is [System.Windows.FrameworkElement]) {
        $parent = $el.Parent
    }
    if (-not $parent) {
        try { $parent = [System.Windows.Media.VisualTreeHelper]::GetParent($el) } catch {}
    }
    if ($parent -is [System.Windows.Controls.Panel]) {
        [void]$parent.Children.Remove($el)
    }
}

function Set-PanelChildrenExact([System.Windows.Controls.Panel]$panel, [System.Collections.IList]$desired) {
    if (-not $panel) { return $false }
    $same = ($panel.Children.Count -eq $desired.Count)
    if ($same) {
        for ($i = 0; $i -lt $desired.Count; $i++) {
            if (-not [Object]::ReferenceEquals($panel.Children[$i], $desired[$i])) {
                $same = $false
                break
            }
        }
    }
    if ($same) { return $false }
    $panel.Children.Clear()
    foreach ($item in $desired) {
        Detach-UIElementFromParent $item
        [void]$panel.Children.Add($item)
    }
    return $true
}

function Get-WorkCoopHintElement([double]$fs) {
    if ($WorkCoopHintInline) {
        $WorkCoopHintInline.FontSize = [Math]::Round(9.5 * $fs, 1)
        $script:WorkCoopHintTextBlock = $WorkCoopHintInline
        return $WorkCoopHintInline
    }
    if (-not $script:WorkCoopHintTextBlock) {
        $tb = New-Object System.Windows.Controls.TextBlock
        $tb.Text = " · 同时活跃"
        $tb.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
        try { $tb.Foreground = $BrushConv.ConvertFromString((Get-CurrentTheme)['MutedText']) } catch {}
        $script:WorkCoopHintTextBlock = $tb
    }
    $script:WorkCoopHintTextBlock.FontSize = [Math]::Round(9.5 * $fs, 1)
    return $script:WorkCoopHintTextBlock
}

function Set-WorkSourcePillsSpacing($padArr, $marginArr, $otherStyles, [double]$fs) {
    $pad = [System.Windows.Thickness]::new($padArr[0], $padArr[1], $padArr[2], $padArr[3])
    $mgn = [System.Windows.Thickness]::new($marginArr[0], $marginArr[1], $marginArr[2], $marginArr[3])
    if ($WorkSourceBadge) {
        $WorkSourceBadge.Padding = $pad
        $WorkSourceBadge.Margin  = $mgn
    }
    foreach ($os in $otherStyles) {
        $pill = Get-OrCreateWorkSourcePillElement $os $fs
        if ($pill) {
            $pill.Padding = $pad
            $pill.Margin  = $mgn
        }
    }
}

function Update-WorkTaskLineBudget {
    if (-not $WorkTask -or -not $WorkStatusPanel -or -not $WorkHeaderBanner -or -not $WorkStateChip -or -not $WorkBodyArea -or -not $WorkContentGroup -or -not $WorkHeaderRow -or -not $WorkInlineSourceHost -or -not $WorkSourcesPanel -or -not $WorkSourceBadge -or -not $BubbleBorder) { return }
    $fs = if ($Config.FontScale) { [double]$Config.FontScale } else { 1.0 }
    if ($fs -lt 0.80) { $fs = 0.80 }
    if ($fs -gt 1.40) { $fs = 1.40 }

    Sync-WorkSourcesVisualScale $fs
    $lineH = [Math]::Ceiling(18.0 * $fs)
    $WorkTask.LineHeight = $lineH

    # Restore body visibility & clear old MaxHeight before measuring so 0-line states can recover cleanly
    $WorkBodyArea.Visibility = [System.Windows.Visibility]::Visible
    $WorkTask.MaxHeight = [double]::PositiveInfinity

    $cardW = 254.0
    $cardMaxH = if ($script:WorkCardMaxHeightOverride -gt 0) {
        [double]$script:WorkCardMaxHeightOverride
    } else {
        128.0
    }
    $bwX = $BubbleBorder.BorderThickness.Left + $BubbleBorder.BorderThickness.Right
    $bwY = $BubbleBorder.BorderThickness.Top + $BubbleBorder.BorderThickness.Bottom
    $availBannerW = [Math]::Max(80.0, $cardW - $bwX - 23.0)

    $otherStyles = if ($script:WorkActiveSecondaryStyles) { @($script:WorkActiveSecondaryStyles) } else { @() }
    $otherCount = $otherStyles.Count
    $displayedSources = 1 + $otherCount
    $isHighlightedChip = [bool]$script:WorkIsStateChipHighlighted

    # Step 1: Decide single-source inline vs multi/wrapped row using baseline pill & chip padding
    $WorkStateChip.Padding = if ($isHighlightedChip) { [System.Windows.Thickness]::new(6, 1.5, 6, 1.5) } else { [System.Windows.Thickness]::new(0) }
    $WorkSourceBadge.Padding = [System.Windows.Thickness]::new(5, 1, 5.5, 1)
    $WorkSourceBadge.Margin  = [System.Windows.Thickness]::new(0)

    $isInlineSingleSource = $false
    if ($displayedSources -eq 1 -and $WorkDot -and $WorkHeader) {
        $WorkStateChip.Measure([System.Windows.Size]::new([double]::PositiveInfinity, $cardMaxH))
        $WorkSourceBadge.Measure([System.Windows.Size]::new([double]::PositiveInfinity, $cardMaxH))
        $chipW  = $WorkStateChip.DesiredSize.Width
        $badgeW = $WorkSourceBadge.DesiredSize.Width
        $isInlineSingleSource = (($chipW + 8.0 + $badgeW) -le ($availBannerW + 0.01))
    }

    # Step 2: Stable container placement (keep secondary pills strictly in WorkSourcesPanel)
    $emptyList = New-Object System.Collections.ArrayList
    if ($isInlineSingleSource) {
        [void](Set-PanelChildrenExact $WorkSourcesPanel $emptyList)
        $WorkSourcesPanel.Visibility = [System.Windows.Visibility]::Collapsed
        if ($WorkCoopHintInline) { $WorkCoopHintInline.Visibility = [System.Windows.Visibility]::Collapsed }
        $WorkSourceBadge.Margin = [System.Windows.Thickness]::new(0)
        $inlineDesired = New-Object System.Collections.ArrayList
        [void]$inlineDesired.Add($WorkSourceBadge)
        [void](Set-PanelChildrenExact $WorkInlineSourceHost $inlineDesired)
        $WorkInlineSourceHost.Visibility = [System.Windows.Visibility]::Visible
    } else {
        [void](Set-PanelChildrenExact $WorkInlineSourceHost $emptyList)
        $WorkInlineSourceHost.Visibility = [System.Windows.Visibility]::Collapsed

        $desiredPills = New-Object System.Collections.ArrayList
        [void]$desiredPills.Add($WorkSourceBadge)
        foreach ($os in $otherStyles) {
            [void]$desiredPills.Add((Get-OrCreateWorkSourcePillElement $os $fs))
        }
        [void](Set-PanelChildrenExact $WorkSourcesPanel $desiredPills)
        $WorkSourcesPanel.Visibility = [System.Windows.Visibility]::Visible

        # Show " · 同时活跃" inline beside WorkStateChip only when multi-source AND fits cleanly on row 0
        if ($WorkCoopHintInline) {
            if ($otherCount -ge 1) {
                $WorkCoopHintInline.FontSize = [Math]::Round(9.5 * $fs, 1)
                $WorkStateChip.Measure([System.Windows.Size]::new([double]::PositiveInfinity, $cardMaxH))
                $WorkCoopHintInline.Measure([System.Windows.Size]::new([double]::PositiveInfinity, $cardMaxH))
                if (($WorkStateChip.DesiredSize.Width + 2.0 + $WorkCoopHintInline.DesiredSize.Width) -le $availBannerW) {
                    $WorkCoopHintInline.Visibility = [System.Windows.Visibility]::Visible
                } else {
                    $WorkCoopHintInline.Visibility = [System.Windows.Visibility]::Collapsed
                }
            } else {
                $WorkCoopHintInline.Visibility = [System.Windows.Visibility]::Collapsed
            }
        }
    }

    # Step 3: Three-tier convergence (Comfort -> BalancedCompact -> ExtremeCompact)
    $tiers = @(
        @{
            Name       = "Comfort"
            BannerPad  = @(12.0, 6.0, 11.0, 6.0)
            SrcTop     = 3.5
            PillPad    = @(5.0, 1.0, 5.5, 1.0)
            PillMargin = @(0.0, 0.0, 4.0, 2.0)
            ChipPad    = $(if ($isHighlightedChip) { @(6.0, 1.5, 6.0, 1.5) } else { @(0.0, 0.0, 0.0, 0.0) })
            BodyMargin = @(13.0, 9.0, 13.0, 11.0)
        },
        @{
            Name       = "BalancedCompact"
            BannerPad  = @(11.0, 5.0, 11.0, 5.0)
            SrcTop     = 2.5
            PillPad    = @(4.5, 1.0, 5.0, 1.0)
            PillMargin = @(0.0, 0.0, 4.0, 1.5)
            ChipPad    = $(if ($isHighlightedChip) { @(6.0, 1.5, 6.0, 1.5) } else { @(0.0, 0.0, 0.0, 0.0) })
            BodyMargin = @(12.0, 6.0, 12.0, 7.0)
        },
        @{
            Name       = "ExtremeCompact"
            BannerPad  = @(10.5, 4.0, 10.5, 4.0)
            SrcTop     = 2.0
            PillPad    = @(4.5, 1.0, 5.0, 1.0)
            PillMargin = @(0.0, 0.0, 4.0, 1.5)
            ChipPad    = $(if ($isHighlightedChip) { @(5.5, 1.0, 5.5, 1.0) } else { @(0.0, 0.0, 0.0, 0.0) })
            BodyMargin = @(11.0, 4.5, 11.0, 4.5)
        }
    )

    $measureTier = {
        param($tr)
        $WorkHeaderBanner.Padding = [System.Windows.Thickness]::new($tr.BannerPad[0], $tr.BannerPad[1], $tr.BannerPad[2], $tr.BannerPad[3])
        $WorkStateChip.Padding    = [System.Windows.Thickness]::new($tr.ChipPad[0], $tr.ChipPad[1], $tr.ChipPad[2], $tr.ChipPad[3])
        if ($isInlineSingleSource) {
            $WorkSourceBadge.Padding = [System.Windows.Thickness]::new($tr.PillPad[0], $tr.PillPad[1], $tr.PillPad[2], $tr.PillPad[3])
            $WorkSourceBadge.Margin  = [System.Windows.Thickness]::new(0)
            $WorkSourcesPanel.Margin = [System.Windows.Thickness]::new(0)
        } else {
            Set-WorkSourcePillsSpacing $tr.PillPad $tr.PillMargin $otherStyles $fs
            $WorkSourcesPanel.Margin = [System.Windows.Thickness]::new(0, $tr.SrcTop, 0, 0)
        }
        $WorkHeaderBanner.InvalidateMeasure()
        $WorkHeaderBanner.Measure([System.Windows.Size]::new(($cardW - $bwX), [double]::PositiveInfinity))
        $bH = $WorkHeaderBanner.DesiredSize.Height

        $tAvailW = [Math]::Max(80.0, $cardW - $bwX - $tr.BodyMargin[0] - $tr.BodyMargin[2])
        $WorkTask.MaxHeight = [double]::PositiveInfinity
        $WorkTask.Measure([System.Windows.Size]::new($tAvailW, [double]::PositiveInfinity))
        $nBodyH = $WorkTask.DesiredSize.Height
        $nLines = if ($nBodyH -le 0.1) { 1 } else { [int][Math]::Ceiling(($nBodyH - 0.5) / $lineH) }

        $tAvailH = [Math]::Max(0.0, $cardMaxH - $bwY - $bH - $tr.BodyMargin[1] - $tr.BodyMargin[3])
        $rawL = [int][Math]::Floor(($tAvailH + 0.01) / $lineH)
        $lBudget = [Math]::Min(4, [Math]::Max(0, $rawL))

        return @{
            Spec         = $tr
            BannerHeight = $bH
            AvailW       = $tAvailW
            AvailH       = $tAvailH
            NatBodyH     = $nBodyH
            NatLines     = $nLines
            RawLines     = $rawL
            LinesBudget  = $lBudget
        }
    }

    $r1 = & $measureTier $tiers[0]
    $wantLines1 = [Math]::Min(4, $r1.NatLines)
    $chosen = $r1
    if ($r1.LinesBudget -lt $wantLines1) {
        $r2 = & $measureTier $tiers[1]
        $r3 = & $measureTier $tiers[2]
        $candidates = @($r1, $r2, $r3)
        $bestShown = -1
        $chosen = $r3
        foreach ($cand in $candidates) {
            $want = [Math]::Min(4, $cand.NatLines)
            $shown = [Math]::Min($want, $cand.LinesBudget)
            if ($shown -gt $bestShown) {
                $bestShown = $shown
                $chosen = $cand
            }
        }
        if ($bestShown -le 0) { $chosen = $r3 }
    }

    # Apply winning tier parameters
    $sp = $chosen.Spec
    $WorkHeaderBanner.Padding = [System.Windows.Thickness]::new($sp.BannerPad[0], $sp.BannerPad[1], $sp.BannerPad[2], $sp.BannerPad[3])
    $WorkStateChip.Padding    = [System.Windows.Thickness]::new($sp.ChipPad[0], $sp.ChipPad[1], $sp.ChipPad[2], $sp.ChipPad[3])
    if ($isInlineSingleSource) {
        $WorkSourceBadge.Padding = [System.Windows.Thickness]::new($sp.PillPad[0], $sp.PillPad[1], $sp.PillPad[2], $sp.PillPad[3])
        $WorkSourceBadge.Margin  = [System.Windows.Thickness]::new(0)
        $WorkSourcesPanel.Margin = [System.Windows.Thickness]::new(0)
    } else {
        Set-WorkSourcePillsSpacing $sp.PillPad $sp.PillMargin $otherStyles $fs
        $WorkSourcesPanel.Margin = [System.Windows.Thickness]::new(0, $sp.SrcTop, 0, 0)
    }
    $WorkContentGroup.Margin = [System.Windows.Thickness]::new($sp.BodyMargin[0], $sp.BodyMargin[1], $sp.BodyMargin[2], $sp.BodyMargin[3])

    $linesBudget = [int]$chosen.LinesBudget
    $natLines    = [int]$chosen.NatLines
    $natBodyH    = [double]$chosen.NatBodyH
    $availW      = [double]$chosen.AvailW
    $availContentH = [double]$chosen.AvailH

    # Step 4: Zero-line collapse vs complete-short centering vs top alignment
    if ($linesBudget -le 0) {
        $zeroLineFallback = $true
        $isCompleteShortBody = $false
        $WorkBodyArea.Visibility = [System.Windows.Visibility]::Collapsed
        $WorkTask.MaxHeight = 0.0
        $WorkContentGroup.VerticalAlignment = [System.Windows.VerticalAlignment]::Top
    } else {
        $zeroLineFallback = $false
        $WorkBodyArea.Visibility = [System.Windows.Visibility]::Visible
        $isCompleteShortBody = ($natLines -le 2) -and ($natLines -le $linesBudget) -and ($natBodyH -le ($linesBudget * $lineH + 0.5))
        $WorkContentGroup.VerticalAlignment = if ($isCompleteShortBody) {
            [System.Windows.VerticalAlignment]::Center
        } else {
            [System.Windows.VerticalAlignment]::Top
        }
        $WorkTask.MaxHeight = $linesBudget * $lineH
        $WorkTask.Measure([System.Windows.Size]::new($availW, $WorkTask.MaxHeight))
    }

    $WorkContentGroup.InvalidateMeasure()
    $WorkHeaderBanner.InvalidateMeasure()
    if ($WorkStatusPanel.IsVisible) {
        $WorkStatusPanel.InvalidateMeasure()
        $WorkStatusPanel.UpdateLayout()
    }

    $script:LastWorkLayoutSummary = @{
        Tier                  = $sp.Name
        BannerHeight          = [Math]::Round($chosen.BannerHeight, 2)
        CardHeight            = 0.0
        InlineSingleSource    = $isInlineSingleSource
        DisplayedSources      = $displayedSources
        NaturalLines          = $natLines
        LinesBudget           = $linesBudget
        ZeroLineFallback      = $zeroLineFallback
        IsCompleteShortBody   = $isCompleteShortBody
        ContentGroupAlignment = [string]$WorkContentGroup.VerticalAlignment
        Tightened             = ($sp.Name -ne "Comfort")
        AvailWidth            = $availW
        AvailContentHeight    = $availContentH
    }

    Sync-BubbleGeometryAndAnchor
    if ($script:DetailWindow -and $script:lastWorkStatusObj -and $script:currentBubblePanel -eq "work") {
        Update-DetailWindowContent $script:lastWorkStatusObj
    }
}

function Update-DetailWindowTheme {
    if (-not $script:DetailWindow) { return }
    try {
        $t = Get-CurrentTheme
        $bg = $BrushConv.ConvertFromString($t.BubbleBg)
        $bd = $BrushConv.ConvertFromString($t.Border)
        $body = $BrushConv.ConvertFromString($t.BodyText)
        $sub = $BrushConv.ConvertFromString($t.SubText)
        $hoverBg = $BrushConv.ConvertFromString($t.HoverBg)
        $track = $BrushConv.ConvertFromString($t.TrackBg)
        $headerDiv = if ($t.HeaderDivider) { $BrushConv.ConvertFromString($t.HeaderDivider) } else { $track }

        if ($script:DetailCardBorder) {
            $script:DetailCardBorder.Background = $bg
            $script:DetailCardBorder.BorderBrush = $bd
            $script:DetailCardBorder.BorderThickness = [System.Windows.Thickness]::new(1.8)
            if ($script:DetailCardBorder.Effect -and $ColorConv) {
                try { $script:DetailCardBorder.Effect.Color = $ColorConv.ConvertFromString($t.ShadowColor) } catch {}
            }
        }
        if ($script:DetailArrowTop) { $script:DetailArrowTop.Fill = $bg; $script:DetailArrowTop.Stroke = $bd; $script:DetailArrowTop.StrokeThickness = 1.6 }
        if ($script:DetailArrowBottom) { $script:DetailArrowBottom.Fill = $bg; $script:DetailArrowBottom.Stroke = $bd; $script:DetailArrowBottom.StrokeThickness = 1.6 }
        if ($script:DetailTitleText) { $script:DetailTitleText.Foreground = $body }
        if ($script:DetailBodyText) { $script:DetailBodyText.Foreground = $body }
        if ($script:DetailHintBanner) { $script:DetailHintBanner.Background = $hoverBg; $script:DetailHintBanner.BorderBrush = $headerDiv }
        if ($script:DetailHintText) { $script:DetailHintText.Foreground = $sub }
        if ($script:DetailFooterBorder) { $script:DetailFooterBorder.BorderBrush = $track }
        if ($script:DetailFooterText) { $script:DetailFooterText.Foreground = $sub }
    } catch {}
}

function Update-DetailWindowFontScale {
    if (-not $script:DetailWindow) { return }
    $fs = if ($Config.FontScale) { [double]$Config.FontScale } else { 1.0 }
    if ($fs -lt 0.80) { $fs = 0.80 }
    if ($fs -gt 1.40) { $fs = 1.40 }
    if ($script:DetailTitleText) { $script:DetailTitleText.FontSize = [Math]::Round(12.5 * $fs, 1) }
    if ($script:DetailSourceMetaText) { $script:DetailSourceMetaText.FontSize = [Math]::Round(10.0 * $fs, 1) }
    if ($script:DetailSourceIcon) {
        $isz = [Math]::Round(12.0 * $fs, 1)
        $script:DetailSourceIcon.Width = $isz
        $script:DetailSourceIcon.Height = $isz
    }
    if ($script:DetailHintText) { $script:DetailHintText.FontSize = [Math]::Round(10.5 * $fs, 1) }
    if ($script:DetailBodyText) {
        $script:DetailBodyText.FontSize = [Math]::Round(12.0 * $fs, 1)
        $script:DetailBodyText.LineHeight = [Math]::Ceiling(18.0 * $fs)
    }
    if ($script:DetailFooterText) { $script:DetailFooterText.FontSize = [Math]::Round(10.5 * $fs, 1) }
}

function Ensure-DetailWindow {
    if ($script:DetailWindow) { return $true }
    try {
        $dx = [string]$Window.FindResource("DetailWindowXaml")
        if ([string]::IsNullOrWhiteSpace($dx)) { return $false }
        $dw = [System.Windows.Markup.XamlReader]::Parse($dx)
        if (-not $dw) { return $false }

        $script:DetailWindow         = $dw
        $script:DetailRootGrid       = $dw.FindName("DetailRootGrid")
        if (-not $script:DetailRootGrid -and ($dw.Content -is [System.Windows.FrameworkElement])) {
            $script:DetailRootGrid   = $dw.Content
        }
        $script:DetailArrowTop       = $dw.FindName("DetailArrowTop")
        $script:DetailArrowBottom    = $dw.FindName("DetailArrowBottom")
        $script:DetailCardBorder     = $dw.FindName("DetailCardBorder")
        $script:DetailTitleText      = $dw.FindName("DetailTitleText")
        $script:DetailSourcePill     = $dw.FindName("DetailSourcePill")
        $script:DetailSourceIcon     = $dw.FindName("DetailSourceIcon")
        $script:DetailSourceMetaText = $dw.FindName("DetailSourceMetaText")
        $script:DetailHintBanner     = $dw.FindName("DetailHintBanner")
        $script:DetailHintText       = $dw.FindName("DetailHintText")
        $script:DetailScrollViewer   = $dw.FindName("DetailScrollViewer")
        $script:DetailBodyText       = $dw.FindName("DetailBodyText")
        $script:DetailFooterBorder   = $dw.FindName("DetailFooterBorder")
        $script:DetailFooterText     = $dw.FindName("DetailFooterText")

        $dw.ShowActivated = $false
        $dw.Focusable = $false
        $dw.Topmost = [bool]$Window.Topmost
        $dw.Add_SourceInitialized({
            try {
                $dHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($script:DetailWindow)).Handle
                [AgentPetNative]::ApplyToolWindowStyle($dHwnd)
                [AgentPetNative]::EnsureWindowTopmost($dHwnd, ([bool]$Config.Topmost -or [bool]$script:waitingAttentionActive), $true)
                $dSrc = [System.Windows.Interop.HwndSource]::FromHwnd($dHwnd)
                if ($dSrc) {
                    $dSrc.AddHook({
                        param([IntPtr]$hwnd, [int]$msg, [IntPtr]$wParam, [IntPtr]$lParam, [ref]$handled)
                        if ($msg -eq [AgentPetNative]::WM_MOUSEACTIVATE) {
                            $handled.Value = $true
                            return [IntPtr][AgentPetNative]::MA_NOACTIVATE
                        }
                        return [IntPtr]::Zero
                    })
                }
            } catch {}
        })
        $dw.Add_MouseLeftButtonUp({
            param($s, $e)
            $e.Handled = $true
        })
        $dw.Add_Closed({
            $script:DetailWindow = $null
        })

        Update-DetailWindowTheme
        Update-DetailWindowFontScale
        return $true
    } catch {
        Log-Throttled "DetailWindow" "创建任务详情卡片失败：$($_.Exception.Message)" 30
        return $false
    }
}

function Update-DetailWindowContent($stObj) {
    if (-not $stObj) { return }
    if (-not (Ensure-DetailWindow)) { return }

    $rawSource = if ($stObj.source) { [string]$stObj.source } else { "Antigravity" }
    $agentStyle = Get-AgentSourceStyle $rawSource
    $agentKey = $agentStyle.Key
    $state = if ($stObj.state) { [string]$stObj.state } else { "working" }
    $shortHdr = Get-WorkShortHeaderText $state

    $primarySub = if ($stObj.agents -and $agentKey) { $stObj.agents.$agentKey } else { $null }
    $rawId = if ($stObj.rawId) {
        [string]$stObj.rawId
    } elseif ($stObj.sessionId) {
        [string]$stObj.sessionId
    } elseif ($primarySub -and $primarySub.rawId) {
        [string]$primarySub.rawId
    } elseif ($primarySub -and $primarySub.sessionId) {
        [string]$primarySub.sessionId
    } else {
        ""
    }

    $rawDetail = Get-WorkDetailDisplayBody $stObj

    $newContentKey = "$($agentStyle.Label)|$rawId|$state|$rawDetail"

    $stateText = Resolve-CharacterWorkStateText $stObj
    $rawCount = if ($primarySub -and $primarySub.sessionCount) {
        [int]$primarySub.sessionCount
    } elseif ($stObj.sessionCount) {
        [int]$stObj.sessionCount
    } else {
        1
    }
    $sessionCount = [Math]::Max(1, $rawCount)

    $coopNames = @()
    if ($stObj.agents) {
        $activeWorkStates = @("working", "thinking", "waiting", "approval", "stalled")
        foreach ($k in @("antigravity", "codex", "dsh")) {
            if ($k -eq $agentKey) { continue }
            $sub = $stObj.agents.$k
            if ($sub -and $sub.state -and ($activeWorkStates -contains [string]$sub.state)) {
                $coopNames += (Get-AgentSourceStyle $k).Label
            }
        }
    }
    $coopNamesText = if ($coopNames.Count -gt 0) { $coopNames -join "、" } else { "" }
    $mainBubbleShowingSameHint = (
        $null -ne $WorkBodyArea -and
        $WorkBodyArea.Visibility -eq [System.Windows.Visibility]::Visible -and
        $null -ne $WorkTask -and
        (-not [string]::IsNullOrWhiteSpace($stateText)) -and
        ($WorkTask.Text -ceq $stateText)
    )
    $newMetaKey = "$stateText|$mainBubbleShowingSameHint|$sessionCount|$coopNamesText"

    $contentChanged = ($newContentKey -ne $script:LastDetailContentKey)
    $metaChanged = ($newMetaKey -ne $script:LastDetailMetaKey)

    if ($contentChanged) {
        $script:LastDetailContentKey = $newContentKey
        if ($script:DetailSourceMetaText) {
            $script:DetailSourceMetaText.Text = "$($agentStyle.Label) · $shortHdr"
            try { $script:DetailSourceMetaText.Foreground = $BrushConv.ConvertFromString($agentStyle.Foreground) } catch {}
        }
        if ($script:DetailSourcePill) {
            try {
                $detailPillBg = if ($agentStyle.DetailBackground) { $agentStyle.DetailBackground } else { $agentStyle.Background }
                $script:DetailSourcePill.Background = $BrushConv.ConvertFromString($detailPillBg)
                $script:DetailSourcePill.BorderBrush = $BrushConv.ConvertFromString($agentStyle.BorderBrush)
            } catch {}
        }
        if ($script:DetailSourceIcon) {
            if ($script:AgentIcons -and $script:AgentIcons.ContainsKey($agentStyle.Key)) {
                $script:DetailSourceIcon.Source = $script:AgentIcons[$agentStyle.Key]
                $script:DetailSourceIcon.Visibility = [System.Windows.Visibility]::Visible
            } else {
                $script:DetailSourceIcon.Visibility = [System.Windows.Visibility]::Collapsed
            }
        }
        if ($script:DetailBodyText) {
            $script:DetailBodyText.Text = $rawDetail
        }
        if ($script:DetailScrollViewer) {
            $script:DetailScrollViewer.ScrollToVerticalOffset(0)
        }
    }

    if ($contentChanged -or $metaChanged) {
        $script:LastDetailMetaKey = $newMetaKey
        if ($script:DetailHintBanner -and $script:DetailHintText) {
            if ((-not [string]::IsNullOrWhiteSpace($stateText)) -and (-not $mainBubbleShowingSameHint)) {
                $script:DetailHintText.Text = "状态提示：$stateText"
                $script:DetailHintBanner.Visibility = [System.Windows.Visibility]::Visible
            } else {
                $script:DetailHintText.Text = ""
                $script:DetailHintBanner.Visibility = [System.Windows.Visibility]::Collapsed
            }
        }
        if ($script:DetailFooterText) {
            if ($coopNamesText) {
                $script:DetailFooterText.Text = "同源会话：$sessionCount 个 · 同时活跃：$coopNamesText"
            } else {
                $script:DetailFooterText.Text = "同源会话：$sessionCount 个"
            }
        }
    }

    if ($script:DetailWindow.IsVisible -and ($contentChanged -or $metaChanged)) {
        Update-DetailWindowPosition
    }
}

function Update-DetailWindowPosition {
    if (-not $script:DetailWindow -or -not $BubbleBorder -or -not $Window) { return }
    try {
        $source = [System.Windows.PresentationSource]::FromVisual($Window)
        $dpiX = if ($source -and $source.CompositionTarget) { [double]$source.CompositionTarget.TransformToDevice.M11 } else { 1.0 }
        $dpiY = if ($source -and $source.CompositionTarget) { [double]$source.CompositionTarget.TransformToDevice.M22 } else { 1.0 }
        if ($dpiX -le 0) { $dpiX = 1.0 }
        if ($dpiY -le 0) { $dpiY = 1.0 }

        $bw = [Math]::Max(1.0, $BubbleBorder.ActualWidth)
        $bh = [Math]::Max(1.0, $BubbleBorder.ActualHeight)
        $p0 = $BubbleBorder.PointToScreen([System.Windows.Point]::new(0, 0))
        $p1 = $BubbleBorder.PointToScreen([System.Windows.Point]::new($bw, $bh))

        $bLeft   = [Math]::Min($p0.X, $p1.X) / $dpiX
        $bRight  = [Math]::Max($p0.X, $p1.X) / $dpiX
        $bTop    = [Math]::Min($p0.Y, $p1.Y) / $dpiY
        $bBottom = [Math]::Max($p0.Y, $p1.Y) / $dpiY
        $bCenterX = ($bLeft + $bRight) * 0.5

        $midPhysX = [int][Math]::Round(($p0.X + $p1.X) * 0.5)
        $midPhysY = [int][Math]::Round(($p0.Y + $p1.Y) * 0.5)
        $waArr = [AgentPetNative]::GetMonitorWorkAreaDIP($midPhysX, $midPhysY)
        if ($waArr -and $waArr.Length -ge 4) {
            $waLeft = [double]$waArr[0]; $waTop = [double]$waArr[1]
            $waRight = [double]$waArr[2]; $waBottom = [double]$waArr[3]
        } else {
            $wa = [System.Windows.SystemParameters]::WorkArea
            $waLeft = $wa.Left; $waTop = $wa.Top; $waRight = $wa.Right; $waBottom = $wa.Bottom
        }

        $fs = if ($Config.FontScale) { [double]$Config.FontScale } else { 1.0 }
        if ($fs -lt 0.80) { $fs = 0.80 }
        if ($fs -gt 1.40) { $fs = 1.40 }

        # Never call Measure() directly on the SizeToContent Window itself; measure its root Grid instead
        $script:DetailWindow.ClearValue([System.Windows.Window]::WidthProperty)
        $script:DetailWindow.ClearValue([System.Windows.Window]::HeightProperty)
        $script:DetailWindow.SizeToContent = [System.Windows.SizeToContent]::WidthAndHeight

        $rootGrid = if ($script:DetailRootGrid) { $script:DetailRootGrid } elseif ($script:DetailWindow.Content -is [System.Windows.FrameworkElement]) { $script:DetailWindow.Content } else { $null }
        if (-not $rootGrid) { return }

        $invokeRootMeasure = {
            param([System.Windows.FrameworkElement]$rGrid)
            $inf = [System.Windows.Size]::new([double]::PositiveInfinity, [double]::PositiveInfinity)
            for ($pass = 0; $pass -lt 2; $pass++) {
                foreach ($leaf in @($script:DetailBodyText, $script:DetailHintText, $script:DetailFooterText, $script:DetailSourceMetaText, $script:DetailScrollViewer, $script:DetailArrowTop, $script:DetailArrowBottom)) {
                    $cur = [System.Windows.DependencyObject]$leaf
                    while ($cur) {
                        if ($cur -is [System.Windows.UIElement]) { $cur.InvalidateMeasure() }
                        if ([Object]::ReferenceEquals($cur, $rGrid)) { break }
                        $nxt = [System.Windows.Media.VisualTreeHelper]::GetParent($cur)
                        if (-not $nxt -and ($cur -is [System.Windows.FrameworkElement])) { $nxt = $cur.Parent }
                        $cur = $nxt
                    }
                }
                $rGrid.InvalidateMeasure()
                $rGrid.Measure($inf)
            }
        }

        $comfortMaxScrollH = [Math]::Max(220.0, [Math]::Round(220.0 * $fs, 1))
        if ($script:DetailScrollViewer) { $script:DetailScrollViewer.MaxHeight = $comfortMaxScrollH }
        if ($script:DetailArrowTop) { $script:DetailArrowTop.Visibility = [System.Windows.Visibility]::Visible }
        if ($script:DetailArrowBottom) { $script:DetailArrowBottom.Visibility = [System.Windows.Visibility]::Collapsed }
        & $invokeRootMeasure $rootGrid
        $desiredBelowH = $rootGrid.DesiredSize.Height

        $spaceBelow = $waBottom - ($bBottom - 2.0) - 6.0
        $spaceAbove = ($bTop + 2.0) - $waTop - 6.0
        $placeAbove = ($spaceBelow -lt $desiredBelowH -and $spaceAbove -gt $spaceBelow)

        if ($placeAbove) {
            if ($script:DetailArrowTop) { $script:DetailArrowTop.Visibility = [System.Windows.Visibility]::Collapsed }
            if ($script:DetailArrowBottom) { $script:DetailArrowBottom.Visibility = [System.Windows.Visibility]::Visible }
            & $invokeRootMeasure $rootGrid
        }

        $availSpace = if ($placeAbove) { $spaceAbove } else { $spaceBelow }
        $measuredTotalH = $rootGrid.DesiredSize.Height
        $measuredScrollH = if ($script:DetailScrollViewer) { $script:DetailScrollViewer.DesiredSize.Height } else { 0.0 }
        $chromeH = [Math]::Max(0.0, $measuredTotalH - $measuredScrollH)

        if ($script:DetailScrollViewer) {
            $budgetScrollH = [Math]::Max(36.0, [Math]::Min($comfortMaxScrollH, $availSpace - $chromeH))
            $script:DetailScrollViewer.MaxHeight = [Math]::Round($budgetScrollH, 1)
            & $invokeRootMeasure $rootGrid
            if ($rootGrid.DesiredSize.Height -gt ($availSpace + 0.5)) {
                $excess = $rootGrid.DesiredSize.Height - $availSpace
                $adjustedScrollH = [Math]::Max(36.0, $script:DetailScrollViewer.DesiredSize.Height - $excess)
                $script:DetailScrollViewer.MaxHeight = [Math]::Round($adjustedScrollH, 1)
                & $invokeRootMeasure $rootGrid
            }
        }

        $winW = [Math]::Max(264.0, [Math]::Ceiling($rootGrid.DesiredSize.Width))
        $winH = [Math]::Max(80.0, [Math]::Ceiling($rootGrid.DesiredSize.Height))

        $left = $bCenterX - ($winW * 0.5)
        $left = [Math]::Max($waLeft + 4.0, [Math]::Min($waRight - $winW - 4.0, $left))

        $top = if ($placeAbove) { $bTop - $winH + 2.0 } else { $bBottom - 2.0 }
        $top = [Math]::Max($waTop + 4.0, [Math]::Min($waBottom - $winH - 4.0, $top))

        $arrowLeft = [Math]::Max(18.0, [Math]::Min($winW - 32.0, ($bCenterX - $left) - 17.0))
        if ($script:DetailArrowTop) {
            $script:DetailArrowTop.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
            $script:DetailArrowTop.Margin = [System.Windows.Thickness]::new($arrowLeft, 0, 0, -1.5)
        }
        if ($script:DetailArrowBottom) {
            $script:DetailArrowBottom.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Left
            $script:DetailArrowBottom.Margin = [System.Windows.Thickness]::new($arrowLeft, -1.5, 0, 0)
        }

        $script:DetailWindow.Topmost = [bool]$Window.Topmost
        $script:DetailWindow.Left = $left
        $script:DetailWindow.Top = $top

        $rootGrid.InvalidateArrange()
        $script:DetailWindow.InvalidateMeasure()
        if ($script:DetailWindow.IsVisible) {
            $script:DetailWindow.UpdateLayout()
            if ([Math]::Abs($script:DetailWindow.ActualWidth - $winW) -gt 2.0 -or [Math]::Abs($script:DetailWindow.ActualHeight - $winH) -gt 2.0) {
                $script:DetailWindow.SizeToContent = [System.Windows.SizeToContent]::Manual
                $script:DetailWindow.SizeToContent = [System.Windows.SizeToContent]::WidthAndHeight
                $rootGrid.InvalidateMeasure()
                $script:DetailWindow.InvalidateMeasure()
                $script:DetailWindow.UpdateLayout()
            }
        }
    } catch {}
}

function Open-HoverDetailCard {
    if (-not [bool]$Config.HoverDetailsEnabled) { return }
    if (-not $script:lastWorkStatusObj -or $script:currentBubblePanel -ne "work" -or (-not $script:isBubbleOpen) -or $script:trayWindowHidden -or $script:isDragging) { return }
    if (-not (Ensure-DetailWindow)) { return }
    Update-DetailWindowContent $script:lastWorkStatusObj
    Update-DetailWindowPosition
    if (-not $script:DetailWindow.IsVisible) {
        $script:DetailWindow.ShowActivated = $false
        $script:DetailWindow.Show()
        Update-DetailWindowPosition
        Sync-AgentPetTopmost -Force
    }
}

function Close-HoverDetailCard {
    param([switch]$Dispose)
    $script:detailTriggerEnterAt = [DateTime]::MinValue
    $script:detailLeaveAt = [DateTime]::MinValue
    if ($script:DetailHoverTimer) {
        try {
            if ($Dispose -or (-not [bool]$Config.HoverDetailsEnabled) -or (-not $script:isBubbleOpen) -or ($script:currentBubblePanel -ne "work") -or $script:trayWindowHidden) {
                $script:DetailHoverTimer.Stop()
            }
        } catch {}
    }
    if ($script:DetailWindow) {
        try {
            if ($Dispose) {
                $script:DetailWindow.Close()
                $script:DetailWindow = $null
            } elseif ($script:DetailWindow.IsVisible) {
                $script:DetailWindow.Hide()
            }
        } catch {}
    }
}

function Ensure-DetailHoverTimer {
    if (-not $script:DetailHoverTimer) {
        $script:DetailHoverTimer = New-Object System.Windows.Threading.DispatcherTimer
        $script:DetailHoverTimer.Interval = [TimeSpan]::FromMilliseconds(70)
        $script:DetailHoverTimer.Add_Tick({ Update-DetailHoverState })
    }
}

function Get-AgentPetCursorScreenPosition {
    $cur = [System.Windows.Forms.Cursor]::Position
    return (New-Object System.Windows.Point($cur.X, $cur.Y))
}

function Update-DetailHoverState {
    if (-not [bool]$Config.HoverDetailsEnabled -or $script:trayWindowHidden -or (-not $script:isBubbleOpen) -or ($script:currentBubblePanel -ne "work") -or $script:isDragging -or (-not $script:lastWorkStatusObj)) {
        Close-HoverDetailCard
        return
    }
    if (($Window.ContextMenu -and $Window.ContextMenu.IsOpen) -or ($script:TrayMenu -and $script:TrayMenu.Visible)) {
        Close-HoverDetailCard
        return
    }

    $now = [DateTime]::UtcNow
    $screenPt = Get-AgentPetCursorScreenPosition
    $inSources = (Test-ElementHit $WorkSourcesPanel $screenPt) -or (Test-ElementHit $WorkSourceBadge $screenPt)
    $inTrigger = (-not $inSources) -and ((Test-ElementHit $WorkHeaderBanner $screenPt) -or (Test-ElementHit $WorkHeaderRow $screenPt) -or (Test-ElementHit $WorkTask $screenPt))
    $inDetail = $false
    if ($script:DetailWindow -and $script:DetailWindow.IsVisible -and $script:DetailCardBorder) {
        $inDetail = Test-ElementHit $script:DetailCardBorder $screenPt
    }

    $isOpen = [bool]($script:DetailWindow -and $script:DetailWindow.IsVisible)
    if ($inTrigger -or ($isOpen -and $inDetail)) {
        $script:detailLeaveAt = [DateTime]::MinValue
        if (-not $isOpen) {
            if ($script:detailTriggerEnterAt -eq [DateTime]::MinValue) {
                $script:detailTriggerEnterAt = $now
            }
            if (($now - $script:detailTriggerEnterAt).TotalMilliseconds -ge 160) {
                Open-HoverDetailCard
            }
        }
    } else {
        $script:detailTriggerEnterAt = [DateTime]::MinValue
        if ($isOpen) {
            if ($script:detailLeaveAt -eq [DateTime]::MinValue) {
                $script:detailLeaveAt = $now
            }
            $graceMs = if ($inSources) { 120 } else { 220 }
            if (($now - $script:detailLeaveAt).TotalMilliseconds -ge $graceMs) {
                Close-HoverDetailCard
            }
        }
    }
}

function Sync-DetailHoverTimerState {
    if ([bool]$Config.HoverDetailsEnabled -and $script:isBubbleOpen -and $script:currentBubblePanel -eq "work" -and (-not $script:trayWindowHidden)) {
        Ensure-DetailHoverTimer
        if (-not $script:DetailHoverTimer.IsEnabled) {
            $script:DetailHoverTimer.Start()
        }
    }
}

function Set-HoverDetailsEnabled([bool]$enabled) {
    $Config.HoverDetailsEnabled = $enabled
    Save-Config
    if ($script:TrayHoverDetailMenuItem) {
        $script:TrayHoverDetailMenuItem.Checked = $enabled
    }
    if ($script:WpfHoverDetailMenuItem) {
        $script:WpfHoverDetailMenuItem.IsChecked = $enabled
    }
    if ($script:lastWorkStatusObj -and $WorkTask) {
        $nextTaskText = Get-WorkBubbleDisplayTask $script:lastWorkStatusObj
        if ($WorkTask.Text -cne $nextTaskText) { $WorkTask.Text = $nextTaskText }
        if ($script:currentBubblePanel -eq "work") {
            Update-WorkTaskLineBudget
        }
    }
    if (-not $enabled) {
        Close-HoverDetailCard
    } else {
        if ($script:lastWorkStatusObj) {
            Update-DetailWindowContent $script:lastWorkStatusObj
        }
        Sync-DetailHoverTimerState
    }
}

if ($WorkHeaderBanner) {
    $WorkHeaderBanner.Add_MouseEnter({ Sync-DetailHoverTimerState })
}
if ($WorkHeaderRow) {
    $WorkHeaderRow.Add_MouseEnter({ Sync-DetailHoverTimerState })
}
if ($WorkTask) {
    $WorkTask.Add_MouseEnter({ Sync-DetailHoverTimerState })
}

function Get-CharacterVisibleGeometry {
    $sc = if ($Window.Width -gt 0) { [double]$Window.Width / 390.0 } elseif ($null -ne $Config.Scale) { [double]$Config.Scale } else { 1.0 }
    if ($sc -lt 0.6) { $sc = 0.6 }
    if ($sc -gt 1.8) { $sc = 1.8 }

    $char = [string]$Config.Character
    $idleKey = "$char-idle"
    $alphaInfo = if ($script:AlphaCache.ContainsKey($idleKey)) { $script:AlphaCache[$idleKey] } else { $null }

    $rawW = if ($alphaInfo -and $alphaInfo.Width -gt 0) { [double]$alphaInfo.Width } else { 384.0 }
    $rawH = if ($alphaInfo -and $alphaInfo.Height -gt 0) { [double]$alphaInfo.Height } else { 384.0 }
    $alphaMinX = if ($alphaInfo -and $null -ne $alphaInfo.AlphaMinX) { [double]$alphaInfo.AlphaMinX } else { 13.0 }
    $alphaMinY = if ($alphaInfo -and $null -ne $alphaInfo.AlphaMinY) { [double]$alphaInfo.AlphaMinY } else { 13.0 }
    $alphaW    = if ($alphaInfo -and $null -ne $alphaInfo.AlphaW) { [double]$alphaInfo.AlphaW } else { 357.0 }
    $alphaH    = if ($alphaInfo -and $null -ne $alphaInfo.AlphaH) { [double]$alphaInfo.AlphaH } else { 367.0 }

    $profile = if ($script:CharacterProfiles.ContainsKey($char)) { $script:CharacterProfiles[$char] } else { @{ Scale = 1.0; OffsetX = 0; OffsetY = 0 } }
    $pScale = if ($profile.Scale) { [double]$profile.Scale } else { 1.0 }
    $pOffX = if ($profile.OffsetX) { [double]$profile.OffsetX } else { 0.0 }
    $pOffY = if ($profile.OffsetY) { [double]$profile.OffsetY } else { 0.0 }

    $fitScale = (204.0 * $pScale) / [Math]::Max($rawW, $rawH)
    $fitOffX = $pOffX + ($alphaMinX * $fitScale)
    $fitOffY = $pOffY + ($alphaMinY * $fitScale)
    $visW390 = $alphaW * $fitScale
    $visH390 = $alphaH * $fitScale

    $stageBaseLeft = 8.0 + 154.0 + $fitOffX
    $stageBaseTop  = 8.0 + 170.0 + $fitOffY

    $isFlipped = ($FacingScale -and $FacingScale.ScaleX -lt 0)
    $stageLeft = if ($isFlipped) { 390.0 - ($stageBaseLeft + $visW390) } else { $stageBaseLeft }
    $stageTop  = $stageBaseTop

    return @{
        RelLeft   = $stageLeft * $sc
        RelTop    = $stageTop  * $sc
        VisWidth  = $visW390   * $sc
        VisHeight = $visH390   * $sc
    }
}

function Get-CurrentScreenBounds([double]$charCenterX, [double]$charCenterY) {
    try {
        $currDpiX = 1.0; $currDpiY = 1.0
        $source = [System.Windows.PresentationSource]::FromVisual($Window)
        if ($source -and $source.CompositionTarget) {
            $currDpiX = [double]$source.CompositionTarget.TransformToDevice.M11
            $currDpiY = [double]$source.CompositionTarget.TransformToDevice.M22
        }

        # Convert candidate WPF DIP center to physical screen coordinates
        $physX = [int][Math]::Round($charCenterX * $currDpiX)
        $physY = [int][Math]::Round($charCenterY * $currDpiY)

        # Call Win32 PerMonitor DPI & working area calculation
        $workAreaDip = [AgentPetNative]::GetMonitorWorkAreaDIP($physX, $physY)
        if ($workAreaDip -and $workAreaDip.Length -ge 6) {
            return @{
                Left   = $workAreaDip[0]
                Top    = $workAreaDip[1]
                Right  = $workAreaDip[2]
                Bottom = $workAreaDip[3]
                DpiX   = $workAreaDip[4]
                DpiY   = $workAreaDip[5]
            }
        }
    } catch {}

    $vl = [System.Windows.SystemParameters]::VirtualScreenLeft
    $vt = [System.Windows.SystemParameters]::VirtualScreenTop
    return @{
        Left   = $vl
        Top    = $vt
        Right  = $vl + [System.Windows.SystemParameters]::VirtualScreenWidth
        Bottom = $vt + [System.Windows.SystemParameters]::VirtualScreenHeight
        DpiX   = 1.0
        DpiY   = 1.0
    }
}

function Get-CharacterDragBounds([double]$candidateLeft, [double]$candidateTop) {
    $geom = Get-CharacterVisibleGeometry
    $charRelLeft = [double]$geom.RelLeft
    $charRelTop  = [double]$geom.RelTop
    $charVisW    = [double]$geom.VisWidth
    $charVisH    = [double]$geom.VisHeight

    $charCenterX = $candidateLeft + $charRelLeft + ($charVisW * 0.5)
    $charCenterY = $candidateTop  + $charRelTop  + ($charVisH * 0.5)

    $bounds = Get-CurrentScreenBounds $charCenterX $charCenterY

    # Rule: Character visible body allowed to move out by at most 50% in all 4 directions
    $minLeft = $bounds.Left   - (0.5 * $charVisW) - $charRelLeft
    $maxLeft = $bounds.Right  - (0.5 * $charVisW) - $charRelLeft
    $minTop  = $bounds.Top    - (0.5 * $charVisH) - $charRelTop
    $maxTop  = $bounds.Bottom - (0.5 * $charVisH) - $charRelTop

    # Robust fallback for tiny screen or inverted interval
    if ($minLeft -gt $maxLeft) { $maxLeft = $minLeft }
    if ($minTop  -gt $maxTop)  { $maxTop  = $minTop }

    return @{
        MinLeft = $minLeft
        MaxLeft = $maxLeft
        MinTop  = $minTop
        MaxTop  = $maxTop
        Bounds  = $bounds
        Geom    = $geom
    }
}

function Clamp-CharacterWindowPosition {
    $curLeft = if (-not [double]::IsNaN($Window.Left)) { [double]$Window.Left } elseif ($null -ne $Config.Left -and $Config.Left -ne -1) { [double]$Config.Left } else { 0.0 }
    $curTop  = if (-not [double]::IsNaN($Window.Top))  { [double]$Window.Top }  elseif ($null -ne $Config.Top -and $Config.Top -ne -1)   { [double]$Config.Top }  else { 0.0 }

    $b = Get-CharacterDragBounds $curLeft $curTop
    $Window.Left = [Math]::Max($b.MinLeft, [Math]::Min($b.MaxLeft, $curLeft))
    $Window.Top  = [Math]::Max($b.MinTop,  [Math]::Min($b.MaxTop,  $curTop))
}

function Update-Scale {
    $sc = [double]$Config.Scale
    if ($sc -lt 0.6) { $sc = 0.6 }
    if ($sc -gt 1.8) { $sc = 1.8 }

    $oldW = if ($Window.ActualWidth -gt 0) { $Window.ActualWidth } else { $Window.Width }
    $oldH = if ($Window.ActualHeight -gt 0) { $Window.ActualHeight } else { $Window.Height }
    $oldLeft = if (-not [double]::IsNaN($Window.Left)) { $Window.Left } elseif ($null -ne $Config.Left) { [double]$Config.Left } else { 0.0 }
    $oldTop  = if (-not [double]::IsNaN($Window.Top))  { $Window.Top }  elseif ($null -ne $Config.Top)  { [double]$Config.Top }  else { 0.0 }

    $right = $oldLeft + $oldW
    $bottom = $oldTop + $oldH

    $newW = [Math]::Round(390 * $sc)
    $newH = [Math]::Round(390 * $sc)
    $Window.Width  = $newW
    $Window.Height = $newH

    $newLeft = $right - $newW
    $newTop  = $bottom - $newH

    $b = Get-CharacterDragBounds $newLeft $newTop
    $Window.Left = [Math]::Max($b.MinLeft, [Math]::Min($b.MaxLeft, $newLeft))
    $Window.Top  = [Math]::Max($b.MinTop,  [Math]::Min($b.MaxTop,  $newTop))

    $Config.Left = [Math]::Round($Window.Left)
    $Config.Top  = [Math]::Round($Window.Top)
}

function Update-Facing {
    try {
        $geom = Get-CharacterVisibleGeometry
        $charCenterX = $Window.Left + $geom.RelLeft + ($geom.VisWidth * 0.5)
        $charCenterY = $Window.Top  + $geom.RelTop  + ($geom.VisHeight * 0.5)
        $bounds = Get-CurrentScreenBounds $charCenterX $charCenterY
        $threshold = $bounds.Left + (($bounds.Right - $bounds.Left) * 0.42)
        if ($charCenterX -lt $threshold) {
            $FacingScale.ScaleX = -1.0
            $TextFacingScale.ScaleX = -1.0
        } else {
            $FacingScale.ScaleX = 1.0
            $TextFacingScale.ScaleX = 1.0
        }
    } catch {}
}

# ============================================================================
# 8. Cloud Speech Bubble Pop-In / Pop-Out Animations & 5s Auto-Hide TTL
# ============================================================================
$script:isBubbleOpen = $false
$script:manualBubbleHidden = $false
$script:userInspectPanel = $null
$script:userInspectHovering = $false
$script:waitingLastAlert = $null
$script:waitingAttentionActive = $false
$script:bubbleAnimVersion = 0
$script:bubbleCloseTime = [DateTime]::MaxValue

function Stop-UserBubbleInspection {
    $script:userInspectPanel = $null
    $script:userInspectHovering = $false
    $script:userInspectUntil = [DateTime]::MinValue
}

function Start-UserBubbleInspection([ValidateSet('quota', 'deepseek')][string]$mode) {
    $script:userInspectPanel = $mode
    $script:userInspectHovering = $false
    $script:userInspectUntil = [DateTime]::MaxValue
    $script:manualBubbleHidden = $false
    $script:lastInteractTime = [DateTime]::UtcNow
    Set-ActiveBubblePanel $mode
    Show-Bubble 0 -Force
    if ($mode -eq 'quota') {
        Request-QuotaRefresh
    } else {
        Request-BalanceRefresh
    }
    Update-UserBubbleInspection ([DateTime]::UtcNow) ([bool]$Bubble.IsMouseOver)
}

function Update-UserBubbleInspection([DateTime]$now, [bool]$hovered) {
    if (-not $script:userInspectPanel) { return }
    if ($script:agentBusy -and $script:lastAgentState -in @("waiting", "approval")) {
        Stop-UserBubbleInspection
        Set-ActiveBubblePanel "work"
        Show-Bubble 0
        return
    }

    # Existing request deadlines cover success, failure, cooldown and timeout.
    $pending = if ($script:userInspectPanel -eq 'quota') {
        $script:refreshingUntil -gt $now
    } else {
        $script:balanceRequestTimeout -and $script:balanceRequestTimeout -gt $now
    }
    if ($pending) {
        $script:userInspectUntil = [DateTime]::MaxValue
        $script:userInspectHovering = $hovered
        return
    }
    if ($script:userInspectUntil -eq [DateTime]::MaxValue) {
        $script:userInspectUntil = $now.AddSeconds(5.0)
        $script:userInspectHovering = $hovered
    }
    if ($hovered -or $script:userInspectHovering) {
        $script:userInspectUntil = $now.AddSeconds(2.0)
    }
    $script:userInspectHovering = $hovered
    if ($now -lt $script:userInspectUntil) { return }

    Stop-UserBubbleInspection
    if ($script:agentBusy) {
        Set-ActiveBubblePanel 'work'
        Show-Bubble 0
    } else {
        Hide-Bubble
    }
}

function Show-Bubble([double]$holdSeconds = 5.2, [switch]$Force) {
    if ($holdSeconds -gt 0) {
        $script:bubbleCloseTime = [DateTime]::UtcNow.AddSeconds($holdSeconds)
    } else {
        $script:bubbleCloseTime = [DateTime]::MaxValue
    }

    $Bubble.Visibility = [System.Windows.Visibility]::Visible
    if ($Tail) {
        $Tail.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
        $Tail.Opacity    = 1.0
        $Tail.Visibility = [System.Windows.Visibility]::Visible
    }
    if ($TailNear) {
        $TailNear.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
        $TailNear.Opacity    = 1.0
        $TailNear.Visibility = [System.Windows.Visibility]::Visible
    }

    if ($script:isBubbleOpen -and $Bubble.Opacity -gt 0.85) {
        $Bubble.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
        $Bubble.Opacity = 1.0
        Sync-DetailHoverTimerState
        return
    }
    $script:isBubbleOpen = $true
    $script:bubbleAnimVersion++

    # Smooth Opacity Fade-In (140ms) driven solely by parent Bubble so card & tails share 1 opacity timeline
    $dur = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(140))
    $Bubble.Opacity = 1.0
    $bFade = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, 1.0, $dur)
    $bFade.FillBehavior = [System.Windows.Media.Animation.FillBehavior]::Stop
    $Bubble.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $bFade)
    Sync-DetailHoverTimerState
}

function Hide-Bubble {
    Stop-UserBubbleInspection
    Close-HoverDetailCard
    if (-not $script:isBubbleOpen) { return }
    $script:isBubbleOpen = $false
    $script:bubbleCloseTime = [DateTime]::MaxValue
    $ver = ++$script:bubbleAnimVersion
    $verVar = Get-Variable -Scope Script -Name bubbleAnimVersion -ErrorAction SilentlyContinue
    $openVar = Get-Variable -Scope Script -Name isBubbleOpen -ErrorAction SilentlyContinue

    $dur = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(130))
    $startOp = [double]$Bubble.Opacity
    $Bubble.Opacity = 0.0
    $bFade = New-Object System.Windows.Media.Animation.DoubleAnimation($startOp, 0.0, $dur)
    $bFade.FillBehavior = [System.Windows.Media.Animation.FillBehavior]::Stop
    $bFade.Add_Completed({
        $curVer = if ($null -ne $verVar) {
            $verVar.Value
        } elseif ($null -ne $script:bubbleAnimVersion) {
            $script:bubbleAnimVersion
        } else {
            Get-Variable -Name bubbleAnimVersion -ValueOnly -ErrorAction SilentlyContinue
        }
        $curOpen = if ($null -ne $openVar) {
            [bool]$openVar.Value
        } elseif ($null -ne $script:isBubbleOpen) {
            [bool]$script:isBubbleOpen
        } else {
            [bool](Get-Variable -Name isBubbleOpen -ValueOnly -ErrorAction SilentlyContinue)
        }
        if ($curVer -eq $ver -and (-not $curOpen)) {
            $Bubble.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
            $Bubble.Opacity = 0.0
            $Bubble.Visibility = [System.Windows.Visibility]::Hidden
        }
    }.GetNewClosure())

    $Bubble.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $bFade)
}

function Set-ActiveBubblePanel([string]$mode) {
    if ($script:userInspectPanel -and $script:userInspectPanel -ne $mode) {
        Stop-UserBubbleInspection
    }
    $script:currentBubblePanel = $mode
    if ($mode -ne "work") {
        Close-HoverDetailCard
    }
    if ($mode -eq "work") {
        $WorkStatusPanel.Visibility = [System.Windows.Visibility]::Visible
        $QuotaPanel.Visibility      = [System.Windows.Visibility]::Collapsed
        if ($DeepSeekPanel) { $DeepSeekPanel.Visibility = [System.Windows.Visibility]::Collapsed }
        $QuotePanel.Visibility      = [System.Windows.Visibility]::Collapsed
    } elseif ($mode -eq "deepseek") {
        $WorkStatusPanel.Visibility = [System.Windows.Visibility]::Collapsed
        $QuotaPanel.Visibility      = [System.Windows.Visibility]::Collapsed
        if ($DeepSeekPanel) { $DeepSeekPanel.Visibility = [System.Windows.Visibility]::Visible }
        $QuotePanel.Visibility      = [System.Windows.Visibility]::Collapsed
    } elseif ($mode -eq "quote") {
        $WorkStatusPanel.Visibility = [System.Windows.Visibility]::Collapsed
        $QuotaPanel.Visibility      = [System.Windows.Visibility]::Collapsed
        if ($DeepSeekPanel) { $DeepSeekPanel.Visibility = [System.Windows.Visibility]::Collapsed }
        $QuotePanel.Visibility      = [System.Windows.Visibility]::Visible
    } else {
        $WorkStatusPanel.Visibility = [System.Windows.Visibility]::Collapsed
        $QuotaPanel.Visibility      = [System.Windows.Visibility]::Visible
        if ($DeepSeekPanel) { $DeepSeekPanel.Visibility = [System.Windows.Visibility]::Collapsed }
        $QuotePanel.Visibility      = [System.Windows.Visibility]::Collapsed
    }

    $t = Get-CurrentTheme
    if ($mode -eq "work") {
        $activeState = if ($script:lastAgentState) { $script:lastAgentState } else { "working" }
        [void](Apply-WorkVisualStyle $activeState $t)
        Update-WorkTaskLineBudget
        Sync-DetailHoverTimerState
    } else {
        if ($BubbleBorder -and $BrushConv) {
            $BubbleBorder.BorderThickness = [System.Windows.Thickness]::new(2.2)
            try {
                $bgBrush = $BrushConv.ConvertFromString($t.BubbleBg)
                $bdBrush = $BrushConv.ConvertFromString($t.Border)
                $BubbleBorder.Background  = $bgBrush
                $BubbleBorder.BorderBrush = $bdBrush
                if ($Tail) {
                    $Tail.Background      = $bgBrush
                    $Tail.BorderBrush     = $bdBrush
                    $Tail.BorderThickness = [System.Windows.Thickness]::new(1.8)
                }
                if ($TailNear) {
                    $TailNear.Background      = $bgBrush
                    $TailNear.BorderBrush     = $bdBrush
                    $TailNear.BorderThickness = [System.Windows.Thickness]::new(1.5)
                }
                $shColor = $ColorConv.ConvertFromString($t.ShadowColor)
                if ($BubbleShadow)   { $BubbleShadow.Color   = $shColor; $BubbleShadow.Opacity   = 0.26 }
                if ($TailShadow)     { $TailShadow.Color     = $shColor; $TailShadow.Opacity     = 0.25 }
                if ($TailNearShadow) { $TailNearShadow.Color = $shColor; $TailNearShadow.Opacity = 0.23 }
            } catch {}
        }
        if ($mode -eq "deepseek") {
            Sync-DeepSeekFontScale
        }
        Sync-BubbleGeometryAndAnchor
    }
}

# ============================================================================
# 8.5. Notification-area tray integration (single process, no companion daemon)
# ============================================================================
$script:NotifyIcon = $null
$script:TrayMenu = $null
$script:TrayIconAsset = $null
$script:TrayIconBitmap = $null
$script:TrayIconHandle = [IntPtr]::Zero
$script:lastTrayTooltipAt = [DateTime]::MinValue
$script:trayWindowHidden = $false

function Sync-AgentPetTopmost([switch]$Force) {
    try {
        if ($script:trayWindowHidden) { return }
        $wantTopmost = ([bool]$Config.Topmost -or [bool]$script:waitingAttentionActive)
        if ($Window.Topmost -ne $wantTopmost) {
            $Window.Topmost = $wantTopmost
        }
        $handle = (New-Object System.Windows.Interop.WindowInteropHelper($Window)).Handle
        if ($handle -ne [IntPtr]::Zero) {
            [AgentPetNative]::EnsureWindowTopmost($handle, $wantTopmost, [bool]$Force)
        }
        if ($script:DetailWindow -and $script:DetailWindow.IsVisible) {
            if ($script:DetailWindow.Topmost -ne $wantTopmost) {
                $script:DetailWindow.Topmost = $wantTopmost
            }
            $dHandle = (New-Object System.Windows.Interop.WindowInteropHelper($script:DetailWindow)).Handle
            if ($dHandle -ne [IntPtr]::Zero) {
                [AgentPetNative]::EnsureWindowTopmost($dHandle, $wantTopmost, [bool]$Force)
            }
        }
    } catch {}
}

function Set-AgentPetWindowVisible([bool]$Visible) {
    try {
        $helper = New-Object System.Windows.Interop.WindowInteropHelper($Window)
        $handle = $helper.Handle
        if ($Visible) {
            [void][AgentPetNative]::ShowWindow($handle, [AgentPetNative]::SW_SHOW)
            $script:trayWindowHidden = $false
            Update-Facing
            Update-Scale
            Sync-AgentPetTopmost -Force
            [void][AgentPetNative]::SetForegroundWindow($handle)
            $Window.Activate()
            Trigger-PetBounce
        } else {
            Close-HoverDetailCard
            Hide-Bubble
            [void][AgentPetNative]::ShowWindow($handle, [AgentPetNative]::SW_HIDE)
            $script:trayWindowHidden = $true
        }
    } catch { Log-Throttled "TrayWindow" "托盘切换窗口失败：$($_.Exception.Message)" 30 }
}

function Set-WaitingWindowAttention([bool]$Active) {
    if ($Active) {
        try {
            if ($script:trayWindowHidden) {
                $handle = (New-Object System.Windows.Interop.WindowInteropHelper($Window)).Handle
                [void][AgentPetNative]::ShowWindow($handle, [AgentPetNative]::SW_SHOWNOACTIVATE)
                $script:trayWindowHidden = $false
            }
            $script:waitingAttentionActive = $true
            Sync-AgentPetTopmost -Force
        } catch { Log-Throttled "WaitingWindow" "显示等待提醒失败：$($_.Exception.Message)" 30 }
    } elseif ($script:waitingAttentionActive) {
        $script:waitingAttentionActive = $false
        Sync-AgentPetTopmost -Force
    }
}

function Get-TrayTooltipText {
    $role = switch ([string]$Config.Character) {
        "dragon"   { "龙娘" }
        "gemini"   { "双子" }
        "deepseek" { "大肥鱼" }
        "zcode"    { "智谱娘" }
        default    { "小克" }
    }
    $summary = "AgentPet | $role"
    try {
        if (Test-Path $RuntimeStatusPath) {
            $st = Get-Content $RuntimeStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($st -and $st.state) {
                $src = if ($st.source) { [string]$st.source } else { "Agent" }
                $task = if ($st.task) { [string]$st.task } else { [string]$st.state }
                $summary = "AgentPet | $role | $src $([string]$st.state)：$task"
            } elseif ($st -and $st.activeCount -gt 0) {
                $summary = "AgentPet | $role | $($st.activeCount) 个 Agent 工作中"
            } else {
                $summary = "AgentPet | $role | 空闲"
            }
        }
    } catch {}
    $summary = ($summary -replace "\s+", " ").Trim()
    if ($summary.Length -gt 63) { $summary = $summary.Substring(0, 60) + "..." }
    return $summary
}

function Update-TrayTooltip([switch]$Force) {
    if (-not $script:NotifyIcon) { return }
    $now = [DateTime]::UtcNow
    if (-not $Force -and ($now - $script:lastTrayTooltipAt).TotalSeconds -lt 3) { return }
    $script:lastTrayTooltipAt = $now
    try { $script:NotifyIcon.Text = Get-TrayTooltipText } catch {}
}

function Set-TrayIconForRole {
    if (-not $script:NotifyIcon) { return }
    $roleFile = switch ([string]$Config.Character) {
        "dragon"   { Join-Path $CharDir "dragon-happy.png" }
        "gemini"   { Join-Path $CharDir "gemini-happy.png" }
        "deepseek" { Join-Path $CharDir "deepseek-happy.png" }
        "zcode"    { Join-Path $CharDir "zcode-happy.png" }
        default    { Join-Path $CharDir "claude-happy.png" }
    }
    try {
        if (Test-Path $roleFile) {
            $source = New-Object System.Drawing.Bitmap($roleFile)
            $minX = $source.Width; $minY = $source.Height; $maxX = -1; $maxY = -1
            for ($y = 0; $y -lt $source.Height; $y++) {
                for ($x = 0; $x -lt $source.Width; $x++) {
                    if ($source.GetPixel($x, $y).A -gt 12) {
                        if ($x -lt $minX) { $minX = $x }; if ($y -lt $minY) { $minY = $y }
                        if ($x -gt $maxX) { $maxX = $x }; if ($y -gt $maxY) { $maxY = $y }
                    }
                }
            }
            if ($maxX -ge $minX -and $maxY -ge $minY) {
                $cropRect = New-Object System.Drawing.Rectangle($minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1))
                $crop = $source.Clone($cropRect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            } else { $crop = $source.Clone() }
            $thumb = New-Object System.Drawing.Bitmap(32, 32)
            $g = [System.Drawing.Graphics]::FromImage($thumb)
            $g.Clear([System.Drawing.Color]::Transparent)
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $pad = 2.0; $box = 32.0 - ($pad * 2.0)
            $scale = [Math]::Min($box / [double]$crop.Width, $box / [double]$crop.Height)
            $drawW = [Math]::Max(1, [int][Math]::Round($crop.Width * $scale))
            $drawH = [Math]::Max(1, [int][Math]::Round($crop.Height * $scale))
            $drawX = [int][Math]::Round((32 - $drawW) / 2.0); $drawY = [int][Math]::Round((32 - $drawH) / 2.0)
            $g.DrawImage($crop, $drawX, $drawY, $drawW, $drawH)
            $g.Dispose(); $crop.Dispose(); $source.Dispose()
            $hIcon = $thumb.GetHicon()
            $icon = [System.Drawing.Icon]::FromHandle($hIcon)
            if ($script:TrayIconAsset) { try { $script:TrayIconAsset.Dispose() } catch {} }
            if ($script:TrayIconBitmap) { try { $script:TrayIconBitmap.Dispose() } catch {} }
            if ($script:TrayIconHandle -ne [IntPtr]::Zero) { try { [AgentPetNative]::DestroyIcon($script:TrayIconHandle) } catch {} }
            $script:TrayIconAsset = $icon
            $script:TrayIconBitmap = $thumb
            $script:TrayIconHandle = $hIcon
            $script:NotifyIcon.Icon = $icon
            return
        }
    } catch { Log-Throttled "TrayIcon" "角色托盘图标加载失败：$($_.Exception.Message)" 60 }
    try {
        $fallback = Join-Path $AssetsDir "claude.ico"
        if (Test-Path $fallback) { $script:NotifyIcon.Icon = New-Object System.Drawing.Icon($fallback) }
        else { $script:NotifyIcon.Icon = [System.Drawing.SystemIcons]::Application }
    } catch {}
}

# Theme-aware rounded tray menus share their renderer and regular font across all submenus.
if (-not ('AgentPetTrayMenuRenderer' -as [type])) {
    Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Core -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

public sealed class AgentPetTrayMenuRenderer : ToolStripProfessionalRenderer {
    public Color Surface { get; private set; }
    public Color TextColor { get; private set; }
    public Color Accent { get; private set; }
    public Color CheckedFill { get; private set; }
    public Color HoverFill { get; private set; }
    public Color BorderColor { get; private set; }
    public Color DisabledColor { get; private set; }
    private readonly Font menuFont = new Font("Microsoft YaHei UI", 10.0f, FontStyle.Regular, GraphicsUnit.Point);
    private readonly HashSet<ToolStrip> attached = new HashSet<ToolStrip>();
    private bool fontDisposed;
    private ToolStrip rootMenu;

    public AgentPetTrayMenuRenderer() { RoundedEdges = false; }
    public void SetPalette(Color surface, Color text, Color accent, Color check, Color hover, Color border, Color disabled) {
        Surface=surface; TextColor=text; Accent=accent; CheckedFill=check; HoverFill=hover; BorderColor=border; DisabledColor=disabled;
    }
    private static GraphicsPath Rounded(RectangleF r, float radius) {
        GraphicsPath p=new GraphicsPath(); float d=Math.Min(radius*2,Math.Min(r.Width,r.Height));
        if(d<=1) { p.AddRectangle(r); return p; }
        p.AddArc(r.Left,r.Top,d,d,180,90);p.AddArc(r.Right-d,r.Top,d,d,270,90);
        p.AddArc(r.Right-d,r.Bottom-d,d,d,0,90);p.AddArc(r.Left,r.Bottom-d,d,d,90,90);p.CloseFigure();return p;
    }
    private static void UpdateRegion(ToolStrip strip) {
        if(!(strip is ToolStripDropDown) || strip.Width<10 || strip.Height<10) return;
        using(GraphicsPath path=Rounded(new RectangleF(0,0,strip.Width,strip.Height),10)) {
            Region old=strip.Region; strip.Region=new Region(path); if(old!=null) old.Dispose();
        }
    }
    public void Apply(ToolStrip strip) {
        if(rootMenu==null) rootMenu=strip;
        strip.Renderer=this;strip.BackColor=Surface;strip.ForeColor=TextColor;strip.Font=menuFont;
        strip.Padding=new Padding(5,5,5,5);
        ToolStripDropDownMenu dropdown=strip as ToolStripDropDownMenu;
        if(dropdown!=null) { dropdown.ShowImageMargin=false;dropdown.ShowCheckMargin=false; }
        if(attached.Add(strip)) {
            strip.SizeChanged+=delegate(object sender,EventArgs e){ UpdateRegion((ToolStrip)sender); };
            strip.Disposed+=delegate(object sender,EventArgs e){
                attached.Remove((ToolStrip)sender);
                if(Object.ReferenceEquals(sender,rootMenu) && !fontDisposed) { menuFont.Dispose();fontDisposed=true; }
            };
        }
        foreach(ToolStripItem item in strip.Items) {
            item.Font=menuFont;item.ForeColor=item.Enabled?TextColor:DisabledColor;
            if(!(item is ToolStripSeparator)) {
                // DropDownMenu sizes its viewport without horizontal item padding. Its native arrow lane also fits our check.
                item.Padding=new Padding(0,6,0,6);
                item.Margin=new Padding(0,1,0,1);
            }
            ToolStripMenuItem menu=item as ToolStripMenuItem;
            if(menu!=null && menu.HasDropDownItems) Apply(menu.DropDown);
        }
        UpdateRegion(strip);strip.Invalidate();
    }
    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) {
        using(SolidBrush brush=new SolidBrush(Surface)) e.Graphics.FillRectangle(brush,e.AffectedBounds);
    }
    protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }
    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) {
        GraphicsState state=e.Graphics.Save();
        try { e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
            using(GraphicsPath path=Rounded(new RectangleF(.5f,.5f,e.ToolStrip.Width-1,e.ToolStrip.Height-1),10))
            using(Pen pen=new Pen(BorderColor,1)) e.Graphics.DrawPath(pen,path);
        } finally { e.Graphics.Restore(state); }
    }
    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e) {
        ToolStripMenuItem menu=e.Item as ToolStripMenuItem;
        bool isChecked=menu!=null && menu.Checked;
        bool active=e.Item.Enabled && e.Item.Selected;
        GraphicsState state=e.Graphics.Save();
        try { e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
            RectangleF bounds=new RectangleF(1,0,e.Item.Width-2,e.Item.Height-1);
            if(active || isChecked) {
                using(GraphicsPath path=Rounded(bounds,6))
                using(SolidBrush brush=new SolidBrush(isChecked?CheckedFill:HoverFill)) e.Graphics.FillPath(brush,path);
            }
            if(isChecked && (menu==null || !menu.HasDropDownItems)) {
                float x=e.Item.Width-20, y=e.Item.Height/2f;
                using(Pen pen=new Pen(e.Item.Enabled?Accent:DisabledColor,1.8f)) {
                    pen.StartCap=LineCap.Round;pen.EndCap=LineCap.Round;pen.LineJoin=LineJoin.Round;
                    e.Graphics.DrawLines(pen,new PointF[]{new PointF(x,y),new PointF(x+3,y+3),new PointF(x+9,y-4)});
                }
            }
        } finally { e.Graphics.Restore(state); }
    }
    protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e) { }
    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
        ToolStripMenuItem item=e.Item as ToolStripMenuItem;
        e.TextColor=!e.Item.Enabled?DisabledColor:((e.Item.Selected || (item!=null && item.Checked))?Accent:TextColor);
        Rectangle r=e.TextRectangle;r.Width=Math.Min(r.Width,Math.Max(1,e.Item.Width-r.X-26));e.TextRectangle=r;
        base.OnRenderItemText(e);
    }
    protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e) {
        e.ArrowColor=!e.Item.Enabled?DisabledColor:(e.Item.Selected?Accent:TextColor);base.OnRenderArrow(e);
    }
    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e) {
        int y=e.Item.Height/2;
        using(Pen pen=new Pen(BorderColor,1)) e.Graphics.DrawLine(pen,8,y,e.Item.Width-8,y);
    }
}
'@
}

function ConvertTo-AgentPetTrayColor([string]$Value) {
    $c = [System.Windows.Media.ColorConverter]::ConvertFromString($Value)
    return [System.Drawing.Color]::FromArgb(255, [int]$c.R, [int]$c.G, [int]$c.B)
}

function Update-TrayMenuTheme {
    if (-not $script:TrayMenu) { return }
    try {
        $t = Get-CurrentTheme
        $renderer = $script:TrayMenu.Renderer
        if (-not ($renderer -is [AgentPetTrayMenuRenderer])) { $renderer = New-Object AgentPetTrayMenuRenderer }
        $renderer.SetPalette(
            (ConvertTo-AgentPetTrayColor $t.BubbleBg),
            (ConvertTo-AgentPetTrayColor $t.BodyText),
            (ConvertTo-AgentPetTrayColor $t.Accent),
            (ConvertTo-AgentPetTrayColor $t.HoverBg),
            (ConvertTo-AgentPetTrayColor $t.BadgeBg),
            (ConvertTo-AgentPetTrayColor $t.HeaderDivider),
            (ConvertTo-AgentPetTrayColor $t.MutedText)
        )
        $renderer.Apply($script:TrayMenu)
    } catch { Log-Throttled 'TrayMenuTheme' "Tray menu styling failed: $($_.Exception.Message)" 30 }
}


function Initialize-TrayIcon {
    Write-PetLog "Tray initialization requested (enabled=$([bool]$Config.TrayEnabled))."
    if ($null -ne $script:NotifyIcon -or -not [bool]$Config.TrayEnabled) { return }
    try {
        $script:NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
        Set-TrayIconForRole
        $script:NotifyIcon.Visible = $true
        $script:NotifyIcon.Text = Get-TrayTooltipText

        $menu = New-Object System.Windows.Forms.ContextMenuStrip
        $show = New-Object System.Windows.Forms.ToolStripMenuItem("显示 / 唤起桌宠")
        $hide = New-Object System.Windows.Forms.ToolStripMenuItem("隐藏桌宠")
        [void]$menu.Items.Add($show)
        [void]$menu.Items.Add($hide)
        [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

        $bubble = New-Object System.Windows.Forms.ToolStripMenuItem("气泡看板")
        $work = New-Object System.Windows.Forms.ToolStripMenuItem("Agent 工作状态")
        $quota = New-Object System.Windows.Forms.ToolStripMenuItem("Codex 额度")
        $deepseek = New-Object System.Windows.Forms.ToolStripMenuItem("DeepSeek 余额")
        $quote = New-Object System.Windows.Forms.ToolStripMenuItem("随机台词")
        $bubbleHide = New-Object System.Windows.Forms.ToolStripMenuItem("隐藏气泡")
        [void]$bubble.DropDownItems.Add($work); [void]$bubble.DropDownItems.Add($quota); [void]$bubble.DropDownItems.Add($deepseek); [void]$bubble.DropDownItems.Add($quote)
        [void]$bubble.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator)); [void]$bubble.DropDownItems.Add($bubbleHide)
        [void]$menu.Items.Add($bubble)

        $bubbleDefault = New-Object System.Windows.Forms.ToolStripMenuItem("气泡默认偏好")
        $defQuota = New-Object System.Windows.Forms.ToolStripMenuItem("Codex 额度")
        $defDeepseek = New-Object System.Windows.Forms.ToolStripMenuItem("DeepSeek 余额")
        $defQuote = New-Object System.Windows.Forms.ToolStripMenuItem("随机台词")
        [void]$bubbleDefault.DropDownItems.Add($defQuota); [void]$bubbleDefault.DropDownItems.Add($defDeepseek); [void]$bubbleDefault.DropDownItems.Add($defQuote)
        [void]$menu.Items.Add($bubbleDefault)

        $broadcast = New-Object System.Windows.Forms.ToolStripMenuItem("状态播报")
        $pause10 = New-Object System.Windows.Forms.ToolStripMenuItem("暂停 10 分钟")
        $pause30 = New-Object System.Windows.Forms.ToolStripMenuItem("暂停 30 分钟")
        $resume = New-Object System.Windows.Forms.ToolStripMenuItem("立即恢复播报")
        [void]$broadcast.DropDownItems.Add($pause10); [void]$broadcast.DropDownItems.Add($pause30); [void]$broadcast.DropDownItems.Add($resume)
        [void]$menu.Items.Add($broadcast)

        $trayHoverDetailItem = New-Object System.Windows.Forms.ToolStripMenuItem("悬停详情")
        $trayHoverDetailItem.CheckOnClick = $true
        $trayHoverDetailItem.Checked = [bool]$Config.HoverDetailsEnabled
        $script:TrayHoverDetailMenuItem = $trayHoverDetailItem
        [void]$menu.Items.Add($trayHoverDetailItem)

        $trayLowBalItem = New-Object System.Windows.Forms.ToolStripMenuItem("DeepSeek 余额过低提醒")
        $trayLowBalItem.CheckOnClick = $true
        $trayLowBalItem.Checked = ($Config.LowBalanceAlertEnabled -ne $false)
        [void]$menu.Items.Add($trayLowBalItem)

        $trayDshMenu = New-Object System.Windows.Forms.ToolStripMenuItem("DeepSeek 凭据管理")
        $trayDshEnableItem = New-Object System.Windows.Forms.ToolStripMenuItem("启用 DeepSeek 余额服务")
        $trayDshEnableItem.CheckOnClick = $true
        $trayDshEnableItem.Checked = ($Config.DeepSeekBalanceEnabled -ne $false)
        $trayDshStatusItem = New-Object System.Windows.Forms.ToolStripMenuItem("DSH 状态: 检测中...")
        $trayDshStatusItem.Enabled = $false
        $trayDshRefreshItem = New-Object System.Windows.Forms.ToolStripMenuItem("立即刷新 DeepSeek 余额")

        [void]$trayDshMenu.DropDownItems.Add($trayDshEnableItem)
        [void]$trayDshMenu.DropDownItems.Add($trayDshStatusItem)
        [void]$trayDshMenu.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator))
        [void]$trayDshMenu.DropDownItems.Add($trayDshRefreshItem)
        [void]$menu.Items.Add($trayDshMenu)

        $roles = New-Object System.Windows.Forms.ToolStripMenuItem("切换角色")
        foreach ($role in $script:CharacterRoster) {
            $item = New-Object System.Windows.Forms.ToolStripMenuItem($role.Label)
            $item.Tag = $role.Key
            $item.Checked = ([string]$role.Key -eq [string]$Config.Character)
            $item.Add_Click({
                param($sender, $e)
                $Config.Character = [string]$sender.Tag
                Save-Config; Update-Theme
                $pose = if ($Config.Pose -and $Config.Pose -ne "auto") { [string]$Config.Pose } else { "happy" }
                Set-PetSprite $pose; Set-TrayIconForRole; Update-TrayTooltip -Force
                Build-ContextMenu
                Sync-CharacterMenuChecks
            })
            [void]$roles.DropDownItems.Add($item)
        }
        [void]$menu.Items.Add($roles)
        [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

        $reset = New-Object System.Windows.Forms.ToolStripMenuItem("重置位置到右下角")
        $full = New-Object System.Windows.Forms.ToolStripMenuItem("打开完整菜单")
        [void]$menu.Items.Add($reset); [void]$menu.Items.Add($full)
        $settings = New-Object System.Windows.Forms.ToolStripMenuItem("托盘设置")
        $trayEnabledItem = New-Object System.Windows.Forms.ToolStripMenuItem("启用托盘图标")
        $startHiddenItem = New-Object System.Windows.Forms.ToolStripMenuItem("启动时隐藏桌宠")
        $trayEnabledItem.CheckOnClick = $true
        $startHiddenItem.CheckOnClick = $true
        [void]$settings.DropDownItems.Add($trayEnabledItem); [void]$settings.DropDownItems.Add($startHiddenItem)
        [void]$menu.Items.Add($settings)
        [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
        $exit = New-Object System.Windows.Forms.ToolStripMenuItem("退出 AgentPet")
        [void]$menu.Items.Add($exit)

        $show.Add_Click({ Set-AgentPetWindowVisible $true })
        $hide.Add_Click({ Set-AgentPetWindowVisible $false })
        $work.Add_Click({ $script:manualBubbleHidden = $false; Set-AgentPetWindowVisible $true; Set-ActiveBubblePanel "work"; Show-Bubble 0 -Force })
        $quota.Add_Click({ Set-AgentPetWindowVisible $true; Start-UserBubbleInspection "quota" })
        $deepseek.Add_Click({ Set-AgentPetWindowVisible $true; Start-UserBubbleInspection "deepseek" })
        $quote.Add_Click({ $script:manualBubbleHidden = $false; Set-AgentPetWindowVisible $true; $QuoteText.Text = Get-RandomCharacterQuote $Config.Character; Set-ActiveBubblePanel "quote"; Show-Bubble 5.5 })
        $defQuota.Add_Click({ $Config.BubbleMode = "quota"; Save-Config; if (-not $script:agentBusy) { if (-not (Get-Variable -Name agentBusy -ValueOnly -ErrorAction SilentlyContinue)) { Set-ActiveBubblePanel "quota" } }; Build-ContextMenu })
        $defDeepseek.Add_Click({ $Config.BubbleMode = "deepseek"; Save-Config; if (-not $script:agentBusy) { if (-not (Get-Variable -Name agentBusy -ValueOnly -ErrorAction SilentlyContinue)) { Set-ActiveBubblePanel "deepseek"; Request-BalanceRefresh } }; Build-ContextMenu })
        $defQuote.Add_Click({ $Config.BubbleMode = "quote"; Save-Config; if (-not $script:agentBusy) { if (-not (Get-Variable -Name agentBusy -ValueOnly -ErrorAction SilentlyContinue)) { Set-ActiveBubblePanel "quote" } }; Build-ContextMenu })
        $bubbleHide.Add_Click({ $script:manualBubbleHidden = $true; Hide-Bubble })
        $pause10.Add_Click({ $Config.PauseMonitorUntil = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 600000; Save-Config; Update-TrayTooltip -Force })
        $pause30.Add_Click({ $Config.PauseMonitorUntil = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 1800000; Save-Config; Update-TrayTooltip -Force })
        $resume.Add_Click({ $Config.PauseMonitorUntil = 0; Save-Config; Update-TrayTooltip -Force })
        $reset.Add_Click({
            $wa = [System.Windows.SystemParameters]::WorkArea
            $Window.Left = $wa.Right - $Window.Width - 28; $Window.Top = $wa.Bottom - $Window.Height - 16
            $Config.Left = $Window.Left; $Config.Top = $Window.Top; Save-Config; Update-Facing
        })
        $full.Add_Click({ Set-AgentPetWindowVisible $true; if ($Window.ContextMenu) { $Window.ContextMenu.PlacementTarget = $PetImage; $Window.ContextMenu.IsOpen = $true } })
        $trayHoverDetailItem.Add_Click({
            param($sender, $e)
            Set-HoverDetailsEnabled ([bool]$sender.Checked)
        })
        $trayLowBalItem.Add_Click({
            param($sender, $e)
            $Config.LowBalanceAlertEnabled = [bool]$sender.Checked
            Save-Config
            if ($Config.LowBalanceAlertEnabled) {
                $script:lowBalanceAlertArmed = $false          # 强制重新武装
                if ($script:lastBalanceObject -and $script:lastBalanceObject.status -eq "ok") {
                    # 用最近一次有效余额立即判定（$script:lastBalanceObject 在 Apply-BalanceObject:1607 保存）
                    Check-LowBalanceAlert $script:lastBalanceObject
                } else {
                    Request-BalanceRefresh                      # 没有有效数据 → 先刷新，等数据回来再判定
                }
            }
            Build-ContextMenu
        })
        $trayDshEnableItem.Add_Click({
            param($sender, $e)
            $Config.DeepSeekBalanceEnabled = [bool]$sender.Checked
            Save-Config
            Request-BalanceRefresh
            Build-ContextMenu
        })
        $trayDshRefreshItem.Add_Click({
            Set-AgentPetWindowVisible $true
            Start-UserBubbleInspection "deepseek"
        })
        $trayEnabledItem.Add_Click({
            param($sender, $e)
            $Config.TrayEnabled = [bool]$sender.Checked
            Save-Config
            if (-not $Config.TrayEnabled -and $script:NotifyIcon) {
                $script:NotifyIcon.Visible = $false
                $script:NotifyIcon.Dispose()
                $script:NotifyIcon = $null
            }
        })
        $startHiddenItem.Add_Click({
            param($sender, $e)
            $Config.StartHidden = [bool]$sender.Checked
            Save-Config
        })
        $exit.Add_Click({ Request-AgentPetExit })
        $script:NotifyIcon.Add_DoubleClick({ Set-AgentPetWindowVisible $true })
        $menu.Tag = @{
            DefQuota     = $defQuota
            DefDeepseek  = $defDeepseek
            DefQuote     = $defQuote
            Show         = $show
            Hide         = $hide
            BubbleHide   = $bubbleHide
            HoverDetail  = $trayHoverDetailItem
            LowBal       = $trayLowBalItem
            DshEnable    = $trayDshEnableItem
            TrayEnabled  = $trayEnabledItem
            StartHidden  = $startHiddenItem
            Broadcast    = $broadcast
            Roles        = $roles
        }
        $menu.Add_Opening({
            param($sender, $e)
            $m = $sender.Tag
            Update-TrayMenuTheme
            Update-TrayTooltip -Force
            $m.DefQuota.Checked    = ($Config.BubbleMode -eq "quota")
            $m.DefDeepseek.Checked = ($Config.BubbleMode -eq "deepseek")
            $m.DefQuote.Checked    = ($Config.BubbleMode -eq "quote")
            $m.Show.Text = if ($script:trayWindowHidden) { "显示 / 唤起桌宠" } else { "显示 / 唤起桌宠（当前显示）" }
            $m.Hide.Text = if ($script:trayWindowHidden) { "隐藏桌宠（当前隐藏）" } else { "隐藏桌宠" }
            $m.BubbleHide.Checked  = [bool]$script:manualBubbleHidden
            $m.HoverDetail.Checked = [bool]$Config.HoverDetailsEnabled
            $m.LowBal.Checked      = ($Config.LowBalanceAlertEnabled -ne $false)
            $m.DshEnable.Checked   = ($Config.DeepSeekBalanceEnabled -ne $false)
            $m.TrayEnabled.Checked = [bool]$Config.TrayEnabled
            $m.StartHidden.Checked = [bool]$Config.StartHidden
            $pauseUntil = if ($null -ne $Config.PauseMonitorUntil) { [long]$Config.PauseMonitorUntil } else { 0 }
            $remain = if ($pauseUntil -gt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { [int][Math]::Ceiling(($pauseUntil - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) / 60000.0) } else { 0 }
            $m.Broadcast.Text = if ($remain -gt 0) { "状态播报（暂停中，剩余 $remain 分钟）" } else { "状态播报（播报中）" }
            foreach ($roleItem in $m.Roles.DropDownItems) { if ($roleItem.Tag) { $roleItem.Checked = ([string]$roleItem.Tag -eq [string]$Config.Character) } }
        })
        $script:TrayMenu = $menu
        Update-TrayMenuTheme
        $script:NotifyIcon.ContextMenuStrip = $menu
        Write-PetLog "Tray icon initialized successfully."
    } catch {
        Log-Throttled "TrayInit" "托盘初始化失败：$($_.Exception.Message)" 60
        try { if ($script:NotifyIcon) { $script:NotifyIcon.Dispose() } } catch {}
        $script:NotifyIcon = $null
    }
}

function Request-AgentPetExit {
    try {
        if ($script:NotifyIcon) { $script:NotifyIcon.Visible = $false; $script:NotifyIcon.Dispose(); $script:NotifyIcon = $null; Write-PetLog "Tray icon disposed by exit request." }
        if ($Window) { $Window.Close() }
    } catch { Log-Throttled "TrayExit" "托盘退出失败：$($_.Exception.Message)" 30 }
}

# ============================================================================
# 9. Codex Quota Formatting, Reset Countdown & Semantic Colors
# ============================================================================
$script:lastShortRemaining = 100
$script:lastWeekRemaining  = 100
$script:lastQuotaObject    = $null
$script:refreshingUntil    = [DateTime]::MinValue

function Format-ResetCountdown([long]$resetsAtEpoch) {
    if ($resetsAtEpoch -le 0) { return "实时同步中" }
    $nowEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $diffSec = $resetsAtEpoch - $nowEpoch
    if ($diffSec -le 0) {
        return "已重置"
    }
    $span = [TimeSpan]::FromSeconds($diffSec)
    if ($span.TotalMinutes -lt 1) {
        return "即将重置"
    } elseif ($span.TotalHours -lt 1) {
        return "$([int][Math]::Ceiling($span.TotalMinutes)) 分钟后重置"
    } elseif ($span.TotalHours -lt 24) {
        $h = [int][Math]::Floor($span.TotalHours)
        $m = $span.Minutes
        if ($m -gt 0) { return "${h} 小时 ${m} 分后重置" }
        return "${h} 小时后重置"
    } else {
        $localReset = [DateTimeOffset]::FromUnixTimeSeconds($resetsAtEpoch).LocalDateTime
        $nowLocal = [DateTime]::Now
        if ($localReset.Date -eq $nowLocal.Date.AddDays(1)) {
            return "明天 $($localReset.ToString('HH:mm')) 重置"
        }
        return "$($localReset.ToString('MM-dd HH:mm')) 重置"
    }
}

function Update-QuotaColors {
    $t = Get-CurrentTheme
    $normalBar = $BrushConv.ConvertFromString($t.BarBrush)
    $normalPct = $BrushConv.ConvertFromString($t.PercentText)
    $amberBrush = $BrushConv.ConvertFromString("#FFE68A00")
    $redBrush   = $BrushConv.ConvertFromString("#FFD9383A")

    if ($script:lastShortRemaining -le 10) {
        $ShortBar.Background     = $redBrush
        $ShortPercent.Foreground = $redBrush
    } elseif ($script:lastShortRemaining -le 25) {
        $ShortBar.Background     = $amberBrush
        $ShortPercent.Foreground = $amberBrush
    } else {
        $ShortBar.Background     = $normalBar
        $ShortPercent.Foreground = $normalPct
    }

    if ($script:lastWeekRemaining -le 10) {
        $WeekBar.Background     = $redBrush
        $WeekPercent.Foreground = $redBrush
    } elseif ($script:lastWeekRemaining -le 25) {
        $WeekBar.Background     = $amberBrush
        $WeekPercent.Foreground = $amberBrush
    } else {
        $WeekBar.Background     = $normalBar
        $WeekPercent.Foreground = $normalPct
    }
}

function Apply-QuotaObject($qObj) {
    if (-not $qObj) { return }
    $script:refreshingUntil = [DateTime]::MinValue
    $script:lastQuotaObject = $qObj
    if ($QuotaSourceIcon -and $script:AgentIcons.ContainsKey("codex")) {
        $QuotaSourceIcon.Source = $script:AgentIcons["codex"]
    }
    try {
        $label = if ($qObj.planLabel) { [string]$qObj.planLabel } else { "" }
        if ($label -and $label -ne "离线快照") {
            $QuotaPlanText.Text = $label
            $QuotaPlanBadge.Visibility = [System.Windows.Visibility]::Visible
        } else {
            $QuotaPlanText.Text = ""
            $QuotaPlanBadge.Visibility = [System.Windows.Visibility]::Collapsed
        }
        $nowEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

        if ($qObj.observedAt) {
            try {
                $obs = if ([string]$qObj.observedAt -match '^\d+(\.\d+)?$') {
                    [DateTimeOffset]::FromUnixTimeMilliseconds([long][double]$qObj.observedAt)
                } else {
                    [DateTimeOffset]::Parse([string]$qObj.observedAt)
                }
                $ageMin = ([DateTimeOffset]::UtcNow - $obs).TotalMinutes
                if ($ageMin -lt 1.5) {
                    $QuotaResetNotice.Text = "刚刚更新"
                } elseif ($ageMin -lt 60) {
                    $QuotaResetNotice.Text = "$([int][Math]::Round($ageMin)) 分钟前"
                } else {
                    $QuotaResetNotice.Text = $obs.LocalDateTime.ToString("HH:mm") + " 同步"
                }
            } catch {
                $QuotaResetNotice.Text = ""
            }
        }

        if ($qObj.windows) {
            foreach ($w in $qObj.windows) {
                $resetsAt = if ($null -ne $w.resetsAt) { [long]$w.resetsAt } else { 0 }
                $used = if ($null -ne $w.used) { [double]$w.used } elseif ($null -ne $w.usedPercent) { [double]$w.usedPercent } else { 0.0 }

                if ($resetsAt -gt 0 -and $nowEpoch -ge $resetsAt) {
                    $rem = 100
                    $resetText = "已重置"
                } else {
                    $rem = if ($null -ne $w.remaining) { [int]$w.remaining } elseif ($null -ne $w.remainingPercent) { [int]$w.remainingPercent } else { [Math]::Max(0, [Math]::Min(100, [int][Math]::Round(100.0 - $used))) }
                    $resetText = Format-ResetCountdown $resetsAt
                }

                if ($w.id -eq "fiveHour" -or $w.label -eq "5h" -or $w.minutes -eq 300) {
                    $tw = if ($ShortTrack -and $ShortTrack.ActualWidth -gt 20) { $ShortTrack.ActualWidth } else { 238.0 }
                    $barWidth = [Math]::Max(0, [Math]::Min($tw, [Math]::Round($tw * ($rem / 100.0))))
                    $script:lastShortRemaining = $rem
                    $ShortPercent.Text = "$rem%"
                    $ShortReset.Text   = $resetText
                    $ShortBar.Width    = $barWidth
                } elseif ($w.id -eq "weekly" -or $w.label -eq "Weekly" -or $w.minutes -eq 10080) {
                    $tw = if ($WeekTrack -and $WeekTrack.ActualWidth -gt 20) { $WeekTrack.ActualWidth } else { 238.0 }
                    $barWidth = [Math]::Max(0, [Math]::Min($tw, [Math]::Round($tw * ($rem / 100.0))))
                    $script:lastWeekRemaining = $rem
                    $WeekPercent.Text = "$rem%"
                    $WeekReset.Text   = $resetText
                    $WeekBar.Width    = $barWidth
                } else {
                    # P2: Safely preserve unknown quota windows without crashing or overwriting 5h/weekly
                    Log-Throttled "ExtraQuotaWindow" "Observed additional quota window: ID=$($w.id), Label=$($w.label), Minutes=$($w.minutes)" 60
                }
            }
        }

        Update-QuotaColors
    } catch {
        # P1-3: Throttled diagnostic logging for quota apply errors without dumping full object
        Log-Throttled "QuotaApply" "Failed to apply quota object: $($_.Exception.GetType().Name) - $($_.Exception.Message)" 30
    }
}

function Read-InitialQuotaSnapshot {
    if (Test-Path $RuntimeQuotaPath) {
        try {
            $raw = Get-Content $RuntimeQuotaPath -Raw -Encoding UTF8 -ErrorAction Stop
            $q = $raw | ConvertFrom-Json -ErrorAction Stop
            if ($q -and $q.windows) {
                Apply-QuotaObject $q
            }
        } catch {
            Log-Throttled "ReadQuotaSnapshot" "读取初始额度快照失败：$($_.Exception.Message)" 30
        }
    }
}

function Request-QuotaRefresh {
    try {
        if ($ShortReset) {
            $ShortReset.Text = "刷新中..."
        }
        $script:refreshingUntil = [DateTime]::UtcNow.AddSeconds(14.0)
        [System.IO.File]::WriteAllText($RefreshFlagPath, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString(), [System.Text.Encoding]::UTF8)
    } catch {
        Log-Throttled "QuotaRefresh" "写入 Codex 额度刷新标记失败：$($_.Exception.Message)" 30
        $script:refreshingUntil = [DateTime]::MinValue
        if ($ShortReset) {
            $ShortReset.Text = "请求失败"
        }
    }
}

# ============================================================================
# 9.5. DeepSeek API Balance & Low Balance Alert Engine
# ============================================================================
$script:lastBalanceMtime   = [DateTime]::MinValue
$script:lastBalanceObject  = $null
$script:balanceStartupPending  = $false
$script:balanceStartupDeadline = $null
$script:isLowBalance       = $false
$script:lowBalanceHostSig  = ""
$script:lowBalanceAlertArmed = $false

$script:lastBalanceRefreshRequestTime = [DateTime]::MinValue
$script:balanceRequestTimeout = $null
# AP05: 本次手动刷新的发起时刻（Unix 毫秒），与监控侧 lastAttemptAt 同单位，用于判断结果归属
$script:balanceRequestStartedMs = [long]0

function Request-BalanceRefresh([switch]$Silent) {
    $now = [DateTime]::UtcNow
    $span = ($now - $script:lastBalanceRefreshRequestTime).TotalSeconds
    if ($span -lt 10.0) {
        if (-not $Silent) {
            $rem = [int][Math]::Ceiling(10.0 - $span)
            if ($DeepSeekStatusNotice) { $DeepSeekStatusNotice.Text = "冷却中 (${rem}s)" }
        }
        return
    }

    $script:lastBalanceRefreshRequestTime = $now
    if (-not $Silent) {
        $script:balanceRequestTimeout = $now.AddSeconds(15.0)
        $script:balanceRequestStartedMs = ([DateTimeOffset]::new($now)).ToUnixTimeMilliseconds()
        if ($DeepSeekStatusNotice) { $DeepSeekStatusNotice.ToolTip = $null }
    }
    try {
        [System.IO.File]::WriteAllText($RefreshBalanceFlagPath, [DateTime]::UtcNow.Ticks.ToString(), [System.Text.Encoding]::UTF8)
        if ((-not $Silent) -and $DeepSeekStatusNotice) { $DeepSeekStatusNotice.Text = "刷新中..." }
    } catch {}
}

# AP05: 结果是否属于本次手动刷新：必须是终态（非 loading），且监控侧的尝试时间不早于本次请求发起时刻
function Test-BalanceResultOwnedByRequest($balObj) {
    if (-not $balObj -or $script:balanceRequestStartedMs -le 0) { return $false }
    $st = [string]$balObj.status
    if ([string]::IsNullOrEmpty($st) -or $st -eq "loading") { return $false }
    if ($null -eq $balObj.lastAttemptAt) { return $false }
    $attemptMs = [double]0
    if (-not [double]::TryParse([string]$balObj.lastAttemptAt, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$attemptMs)) { return $false }
    return ($attemptMs -ge [double]$script:balanceRequestStartedMs)
}

function Get-BalanceSnapshotTimeText($snap) {
    $syncMs = $null
    if ($snap) {
        if ($snap.updatedAt) { $syncMs = $snap.updatedAt }
        elseif ($snap.balanceUpdatedAt) { $syncMs = $snap.balanceUpdatedAt }
        elseif ($snap.fetchedAt) { $syncMs = $snap.fetchedAt }
    }
    $syncStr = "时间未知"
    if ($syncMs) {
        try { $syncStr = ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$syncMs).ToLocalTime()).ToString("HH:mm") } catch {}
    }
    return $syncStr
}

function Set-BalanceTimeoutNotice {
    if (-not $DeepSeekStatusNotice) { return }
    $script:deepSeekTimeoutLayout = $true
    $DeepSeekStatusNotice.Text = "刷新超时，点击 ↻ 重试"
    if ($DeepSeekHeader -is [System.Windows.Controls.TextBlock]) {
        $DeepSeekHeader.Text = "DeepSeek 余额"
    }
    if ($DeepSeekBadge) { $DeepSeekBadge.Visibility = [System.Windows.Visibility]::Collapsed }
    $hasAmount = ($DeepSeekOkPanel -and $DeepSeekOkPanel.Visibility -eq [System.Windows.Visibility]::Visible)
    $script:deepSeekSnapshotLabelActive = [bool]$hasAmount
    if ($hasAmount) {
        $syncStr = Get-BalanceSnapshotTimeText $script:lastBalanceObject
        $DeepSeekStatusNotice.ToolTip = "本次刷新 15 秒内未获得结果；当前金额为上次快照（同步于 $syncStr）"
        if ($DeepSeekCurrencyLabel) {
            $DeepSeekCurrencyLabel.Text = "人民币 CNY · 上次快照（$syncStr）"
        }
    } else {
        $DeepSeekStatusNotice.ToolTip = "本次刷新 15 秒内未获得结果"
    }
    if (Get-Command Sync-DeepSeekFontScale -ErrorAction SilentlyContinue) { Sync-DeepSeekFontScale }
}

# AP05 & AP05-R1: 统一处理新读到的余额快照（先判定请求状态与结果归属，再决定如何更新界面与请求状态）
function Receive-BalanceSnapshot($balObj) {
    if (-not $balObj) { return }
    $script:balanceStartupPending = $false
    $script:balanceStartupDeadline = $null

    $hasActiveRequest = ($script:balanceRequestStartedMs -gt 0)
    $isWaitingRequest = ($hasActiveRequest -and ($null -ne $script:balanceRequestTimeout))
    $isTimedOutRequest = ($hasActiveRequest -and ($null -eq $script:balanceRequestTimeout))
    $owned = Test-BalanceResultOwnedByRequest $balObj

    # 1. 尚无手动请求，或当前手动请求收到了属于本次请求的有效终态结果（无论超时前后）
    if ((-not $hasActiveRequest) -or $owned) {
        if ($owned) {
            $script:balanceRequestTimeout = $null
            $script:balanceRequestStartedMs = [long]0
        }
        $script:lastBalanceObject = $balObj
        if ($DeepSeekStatusNotice) { $DeepSeekStatusNotice.ToolTip = $null }
        Apply-BalanceObject $balObj
        return
    }

    # 2. 存在未完成的手动请求（等待中 或 已超时），但到达的是旧请求结果或 loading 中间态（$owned -eq $false）
    $st = [string]$balObj.status
    $hadAmountVisible = ($DeepSeekOkPanel -and $DeepSeekOkPanel.Visibility -eq [System.Windows.Visibility]::Visible)
    $incomingHasCny = $false
    if (($st -eq "ok" -or $st -eq "stale") -and $balObj.balances) {
        foreach ($b in $balObj.balances) {
            if ([string]$b.currency -eq "CNY") { $incomingHasCny = $true; break }
        }
    }

    if ($incomingHasCny) {
        # 旧请求携带有效金额：仅在无现有快照或旧结果不早于现有快照时更新展示的旧金额，绝不显示为本次刷新成功
        $curSyncMs = [long]0
        if ($script:lastBalanceObject) {
            if ($script:lastBalanceObject.updatedAt) { $curSyncMs = [long]$script:lastBalanceObject.updatedAt }
            elseif ($script:lastBalanceObject.balanceUpdatedAt) { $curSyncMs = [long]$script:lastBalanceObject.balanceUpdatedAt }
            elseif ($script:lastBalanceObject.fetchedAt) { $curSyncMs = [long]$script:lastBalanceObject.fetchedAt }
        }
        $incSyncMs = [long]0
        if ($balObj.updatedAt) { $incSyncMs = [long]$balObj.updatedAt }
        elseif ($balObj.balanceUpdatedAt) { $incSyncMs = [long]$balObj.balanceUpdatedAt }
        elseif ($balObj.fetchedAt) { $incSyncMs = [long]$balObj.fetchedAt }

        if ((-not $hadAmountVisible) -or ($incSyncMs -ge $curSyncMs)) {
            $script:lastBalanceObject = $balObj
            Apply-BalanceObject $balObj -IsInitialStartup
        }
    } elseif ((-not $hadAmountVisible) -and $isWaitingRequest -and ($st -eq "loading")) {
        Apply-BalanceObject $balObj
    }

    # 保留并锁定当前手动刷新的真实状态语义（“刷新中...” 或 “刷新超时，点击 ↻ 重试”）与旧快照标记
    if ($isTimedOutRequest) {
        Set-BalanceTimeoutNotice
    } elseif ($isWaitingRequest) {
        $script:deepSeekTimeoutLayout = $false
        if ($DeepSeekStatusNotice) {
            $DeepSeekStatusNotice.Text = "刷新中..."
            $DeepSeekStatusNotice.ToolTip = $null
        }
        $hasSnapAmt = ($DeepSeekOkPanel -and $DeepSeekOkPanel.Visibility -eq [System.Windows.Visibility]::Visible -and $DeepSeekCurrencyLabel)
        $script:deepSeekSnapshotLabelActive = [bool]$hasSnapAmt
        if ($hasSnapAmt) {
            $syncStr = Get-BalanceSnapshotTimeText $script:lastBalanceObject
            $DeepSeekCurrencyLabel.Text = "人民币 CNY · 上次快照（$syncStr）"
        }
        if (Get-Command Sync-DeepSeekFontScale -ErrorAction SilentlyContinue) { Sync-DeepSeekFontScale }
    }
}

# AP05: 手动刷新 15 秒未得到本次结果时如实提示超时；旧金额标明为上次快照
function Update-BalanceRefreshTimeout([DateTime]$now) {
    if (-not $script:balanceRequestTimeout -or $now -le $script:balanceRequestTimeout) { return }
    $script:balanceRequestTimeout = $null
    # 保留 balanceRequestStartedMs：超时后本次结果到达仍能被识别并正常更新
    Set-BalanceTimeoutNotice
}

function Check-LowBalanceAlert($balObj) {
    if (-not $balObj -or $balObj.status -ne "ok" -or -not $balObj.balances) { return }

    # 来源签名：provider + credentialSource 变化即视为"数据来源变了"
    # 注意：它只能识别【来源变化】，不是【账户归属签名】。
    #   同一个 provider 下换账户（例如都是 deepseek-official）无法区分；
    #   DSH /state 目前不提供 accountId，这一层限制必须在提交说明里写明。
    #   若宿主后续提供 accountId/accountContext，再替换本行取值来源。
    $sig = "$([string]$balObj.provider)|$([string]$balObj.credentialSource)"
    if ($script:lowBalanceHostSig -and $script:lowBalanceHostSig -ne $sig) {
        $script:isLowBalance = $false
    }
    $script:lowBalanceHostSig = $sig

    $cnyThresh = if ($null -ne $Config.LowBalanceCnyThreshold) { [decimal]$Config.LowBalanceCnyThreshold } else { [decimal]5.0 }
    $cnyTot = [decimal]0; $hasCny = $false
    foreach ($b in $balObj.balances) {
        if ([string]$b.currency -eq "CNY") {
            if ([decimal]::TryParse([string]$b.totalBalance,
                [System.Globalization.NumberStyles]::Any,
                [System.Globalization.CultureInfo]::InvariantCulture, [ref]$cnyTot)) { $hasCny = $true }
            break
        }
    }

    # 开关从"关"变"开"时重新武装：若此刻仍低额，立即提醒一次
    #   （用户刚主动打开提醒，属于"重新要求被提醒"，不算重复打扰）
    $alertOn = ($Config.LowBalanceAlertEnabled -ne $false)
    if ($alertOn -and -not $script:lowBalanceAlertArmed) { $script:isLowBalance = $false }
    $script:lowBalanceAlertArmed = $alertOn

    # 无论是否被抑制，都先更新状态位（这是修漏报的关键）
    $isLow = ($hasCny -and $cnyTot -lt $cnyThresh)
    $wasLow = [bool]$script:isLowBalance
    $script:isLowBalance = $isLow

    if (-not $isLow) { return }
    if ($wasLow) { return }                       # 已提醒过，不重复
    if (-not $alertOn) { return }
    if ($script:manualBubbleHidden) { return }
    if ($script:agentBusy) { return }             # 主动抑制：不补提醒（见工单说明）
    if ([DateTime]::UtcNow -lt $script:userInspectUntil) { return }

    Play-ReleaseSound
    Set-ActiveBubblePanel "deepseek"
    Show-Bubble 6.5
}

function Apply-BalanceObject($balObj, [switch]$IsInitialStartup) {
    if (-not $balObj -or -not $DeepSeekPanel) { return }
    $script:lastBalanceObject = $balObj
    $script:deepSeekTimeoutLayout = $false
    $script:deepSeekSnapshotLabelActive = $false
    try {
    if ($DeepSeekHeader -is [System.Windows.Controls.TextBlock]) {
        $DeepSeekHeader.Text = "DeepSeek 官方余额"
    }
    if ($DeepSeekIcon -and $script:AgentIcons.ContainsKey("dsh")) {
        $DeepSeekIcon.Source = $script:AgentIcons["dsh"]
    }

    $st = [string]$balObj.status
    if ($st -ne "ok" -and $st -ne "stale") {
        # loading / error / dsh_not_running / unconfigured / dsh_disabled：
        # 归属未确认，清空低额判定，避免跨账户残留
        $script:isLowBalance = $false
        $script:lowBalanceHostSig = ""
    }
    if ($st -eq "dsh_not_running") {
        $DeepSeekOkPanel.Visibility  = [System.Windows.Visibility]::Collapsed
        $DeepSeekMsgPanel.Visibility = [System.Windows.Visibility]::Visible
        $DeepSeekBadge.Visibility    = [System.Windows.Visibility]::Collapsed
        $DeepSeekStatusNotice.Text   = "未连接"
        $DeepSeekMsgTitle.Text       = "DSH 未运行"
        $DeepSeekMsgDetail.Text      = "请启动 DeepSeek Harness 后查看余额"
        return
    }

    if ($st -eq "unconfigured" -or $st -eq "dsh_disabled") {
        $DeepSeekOkPanel.Visibility  = [System.Windows.Visibility]::Collapsed
        $DeepSeekMsgPanel.Visibility = [System.Windows.Visibility]::Visible
        $DeepSeekBadge.Visibility    = [System.Windows.Visibility]::Collapsed
        $DeepSeekStatusNotice.Text   = "已停用"
        $DeepSeekMsgTitle.Text       = "余额服务未启用"
        $DeepSeekMsgDetail.Text      = "可在托盘或右键菜单中开启 DeepSeek 余额服务"
        return
    }

    if ($st -eq "loading") {
        $DeepSeekStatusNotice.Text = if ($IsInitialStartup) { "启动同步中..." } else { "查询中..." }
        if (-not $balObj.balances -or $balObj.balances.Count -eq 0) {
            $DeepSeekOkPanel.Visibility  = [System.Windows.Visibility]::Collapsed
            $DeepSeekMsgPanel.Visibility = [System.Windows.Visibility]::Visible
            $DeepSeekBadge.Visibility    = [System.Windows.Visibility]::Collapsed
            $DeepSeekMsgTitle.Text       = if ($IsInitialStartup) { "启动同步中..." } else { "正在查询余额..." }
            $DeepSeekMsgDetail.Text      = if ($balObj.errorMessage) { [string]$balObj.errorMessage } else { "首次联网请求中，请稍候~" }
            return
        }
    }

    if ($st -eq "unavailable") {
        $DeepSeekOkPanel.Visibility  = [System.Windows.Visibility]::Collapsed
        $DeepSeekMsgPanel.Visibility = [System.Windows.Visibility]::Visible
        $DeepSeekBadge.Visibility    = [System.Windows.Visibility]::Collapsed
        $DeepSeekStatusNotice.Text   = "暂不可用"
        $DeepSeekMsgTitle.Text       = "暂不可用"
        $DeepSeekMsgDetail.Text      = if ($balObj.errorMessage) { "$($balObj.errorMessage)（点击 ↻ 重试）" } else { "启动后未获取到余额数据（点击 ↻ 重试）" }
        return
    }

    if ($st -eq "error") {
        if ($balObj.balances -and $balObj.balances.Count -gt 0) {
            $DeepSeekOkPanel.Visibility  = [System.Windows.Visibility]::Visible
            $DeepSeekMsgPanel.Visibility = [System.Windows.Visibility]::Collapsed
            $DeepSeekStatusNotice.Text   = "更新失败"
        } else {
            $DeepSeekOkPanel.Visibility  = [System.Windows.Visibility]::Collapsed
            $DeepSeekMsgPanel.Visibility = [System.Windows.Visibility]::Visible
            $DeepSeekStatusNotice.Text   = "查询失败"
            $title = "余额获取失败"
            if ($balObj.errorCode -eq "DSH_CREDENTIAL_MISSING") { $title = "DSH 凭据未配置" }
            elseif ($balObj.errorCode -eq "DSH_UNSUPPORTED") { $title = "服务商不支持" }
            elseif ($balObj.errorCode -eq "DSH_NOT_RUNNING") { $title = "DSH 未运行" }
            $DeepSeekMsgTitle.Text = $title
            $DeepSeekMsgDetail.Text      = if ($balObj.errorMessage) { "$($balObj.errorMessage)（点击 ↻ 重试）" } else { "请在 DSH 中检查服务商配置（点击 ↻ 重试）" }
            return
        }
    }

    if ($st -eq "ok" -or $st -eq "stale") {
        # Strict CNY finding: first version displays ONLY CNY (RMB)
        $cnyInfo = $null
        if ($balObj.balances) {
            foreach ($b in $balObj.balances) {
                if ([string]$b.currency -eq "CNY") {
                    $cnyInfo = $b
                    break
                }
            }
        }

        if ($null -eq $cnyInfo) {
            $DeepSeekOkPanel.Visibility  = [System.Windows.Visibility]::Collapsed
            $DeepSeekMsgPanel.Visibility = [System.Windows.Visibility]::Visible
            $DeepSeekBadge.Visibility    = [System.Windows.Visibility]::Visible
            $DeepSeekBadgeText.Text      = "官方"
            $DeepSeekStatusNotice.Text   = "无CNY余额"
            $DeepSeekMsgTitle.Text       = "当前账户未返回人民币余额"
            $DeepSeekMsgDetail.Text      = "DeepSeek 官方返回列表中未包含 CNY 余额明细"
            return
        }

        $DeepSeekOkPanel.Visibility  = [System.Windows.Visibility]::Visible
        $DeepSeekMsgPanel.Visibility = [System.Windows.Visibility]::Collapsed
        $DeepSeekBadge.Visibility    = [System.Windows.Visibility]::Visible
        $DeepSeekBadgeText.Text      = "官方"

        if ($balObj.errorCode -eq "COOLDOWN") {
            $DeepSeekStatusNotice.Text = "冷却中"
        } elseif ($balObj.errorCode -eq "RATE_LIMITED") {
            $DeepSeekStatusNotice.Text = "频率限制"
        } elseif ($st -eq "stale") {
            $DeepSeekStatusNotice.Text = if ($IsInitialStartup) { "启动同步中..." } else { "上次快照" }
        } else {
            $updateTs = if ($balObj.updatedAt) { $balObj.updatedAt } elseif ($balObj.balanceUpdatedAt) { $balObj.balanceUpdatedAt } else { $null }
            if ($updateTs) {
                $timeStr = ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$updateTs).ToLocalTime()).ToString("HH:mm")
                $DeepSeekStatusNotice.Text = "$timeStr 更新"
                $DeepSeekStatusNotice.ToolTip = $null
            } elseif ($balObj.fetchedAt) {
                $timeStr = ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$balObj.fetchedAt).ToLocalTime()).ToString("HH:mm")
                $DeepSeekStatusNotice.Text = "$timeStr 读取"
                if ($balObj.hostCounter) {
                    $DeepSeekStatusNotice.ToolTip = "数据版本 $($balObj.hostCounter)"
                } else {
                    $DeepSeekStatusNotice.ToolTip = $null
                }
            } else {
                $DeepSeekStatusNotice.Text = "更新时间未知"
                if ($balObj.hostCounter) {
                    $DeepSeekStatusNotice.ToolTip = "数据版本 $($balObj.hostCounter)"
                } else {
                    $DeepSeekStatusNotice.ToolTip = $null
                }
            }
        }

        $DeepSeekCurrencyLabel.Text = "人民币 CNY · DSH 宿主"
        $DeepSeekTotalText.Text = "¥ $($cnyInfo.totalBalance)"

        # Safe breakdown rendering: do NOT fake 0.00 if toppedUp or granted are null
        if ($null -ne $cnyInfo.toppedUpBalance -and $null -ne $cnyInfo.grantedBalance) {
            $DeepSeekBreakdownText.Text = "充值: ¥ $($cnyInfo.toppedUpBalance)   赠金: ¥ $($cnyInfo.grantedBalance)"
        } elseif ($null -ne $cnyInfo.toppedUpBalance) {
            $DeepSeekBreakdownText.Text = "充值: ¥ $($cnyInfo.toppedUpBalance)   赠金: 未提供"
        } elseif ($null -ne $cnyInfo.grantedBalance) {
            $DeepSeekBreakdownText.Text = "充值: 未提供   赠金: ¥ $($cnyInfo.grantedBalance)"
        } else {
            $DeepSeekBreakdownText.Text = "充值/赠金明细暂不可用"
        }

        $DeepSeekAvailableNotice.Text = if ($balObj.isAvailable -eq $false) { "（账户不可用）" } else { "" }

        # 开关只管提醒，判定始终执行；启动快照仍不打扰
        if ($st -eq "ok" -and (-not $IsInitialStartup)) {
            Check-LowBalanceAlert $balObj
        }
    }
    } finally {
        if (Get-Command Sync-DeepSeekFontScale -ErrorAction SilentlyContinue) { Sync-DeepSeekFontScale }
    }
}

function Read-InitialBalanceSnapshot {
    if ($Config.DeepSeekBalanceEnabled -eq $false) {
        $script:balanceStartupPending  = $false
        $script:balanceStartupDeadline = $null
        Apply-BalanceObject @{
            type = "balance"
            provider = "unknown"
            providerFamily = "deepseek"
            status = "dsh_disabled"
            balances = @()
            isAvailable = $false
            errorCode = "BALANCE_DISABLED"
            errorMessage = "DeepSeek 余额服务未启用（可在菜单中开启）"
        } -IsInitialStartup
        return
    }

    $script:lastBalanceMtime = if (Test-Path $RuntimeBalancePath) {
        (Get-Item $RuntimeBalancePath -ErrorAction SilentlyContinue).LastWriteTimeUtc
    } else { [DateTime]::MinValue }
    $script:balanceStartupPending  = $true
    $script:balanceStartupDeadline = [DateTime]::UtcNow.AddSeconds(15)

    # P1-4 & WO-35: Confirm active DSH session context before accepting balance amount
    Apply-BalanceObject @{
        type = "balance"
        provider = "unknown"
        providerFamily = "deepseek"
        status = "loading"
        balances = @()
        isAvailable = $null
        errorCode = $null
        errorMessage = "启动同步中..."
    } -IsInitialStartup
    Request-BalanceRefresh -Silent
}

# ============================================================================
# 10. Q-Bounce Squash & Stretch Animation + Low-Latency Audio
# ============================================================================
function Trigger-PetBounce {
    $sb = New-Object System.Windows.Media.Animation.Storyboard

    $kx = New-Object System.Windows.Media.Animation.DoubleAnimationUsingKeyFrames
    [void]$kx.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(1.0,  [TimeSpan]::FromMilliseconds(0))))
    [void]$kx.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(1.16, [TimeSpan]::FromMilliseconds(65))))
    [void]$kx.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(0.91, [TimeSpan]::FromMilliseconds(155))))
    [void]$kx.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(1.05, [TimeSpan]::FromMilliseconds(245))))
    [void]$kx.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(0.98, [TimeSpan]::FromMilliseconds(320))))
    [void]$kx.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(1.0,  [TimeSpan]::FromMilliseconds(390))))

    $ky = New-Object System.Windows.Media.Animation.DoubleAnimationUsingKeyFrames
    [void]$ky.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(1.0,  [TimeSpan]::FromMilliseconds(0))))
    [void]$ky.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(0.84, [TimeSpan]::FromMilliseconds(65))))
    [void]$ky.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(1.11, [TimeSpan]::FromMilliseconds(155))))
    [void]$ky.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(0.96, [TimeSpan]::FromMilliseconds(245))))
    [void]$ky.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(1.02, [TimeSpan]::FromMilliseconds(320))))
    [void]$ky.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(1.0,  [TimeSpan]::FromMilliseconds(390))))

    [System.Windows.Media.Animation.Storyboard]::SetTarget($kx, $PetHost)
    [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($kx, (New-Object System.Windows.PropertyPath("RenderTransform.ScaleX")))
    [System.Windows.Media.Animation.Storyboard]::SetTarget($ky, $PetHost)
    [System.Windows.Media.Animation.Storyboard]::SetTargetProperty($ky, (New-Object System.Windows.PropertyPath("RenderTransform.ScaleY")))

    [void]$sb.Children.Add($kx)
    [void]$sb.Children.Add($ky)
    $sb.Begin()
}

$pressPath   = Join-Path $AssetsDir "press.wav"
$releasePath = Join-Path $AssetsDir "release.wav"

$script:PressPlayer = New-Object System.Windows.Media.MediaPlayer
$script:ReleasePlayer = New-Object System.Windows.Media.MediaPlayer
try {
    if (Test-Path $pressPath) { $script:PressPlayer.Open([System.Uri]$pressPath) }
    if (Test-Path $releasePath) { $script:ReleasePlayer.Open([System.Uri]$releasePath) }
} catch {}

function Play-PressSound {
    if (-not $Config.SoundEnabled) { return }
    try {
        $vol = [double]([Math]::Max(0, [Math]::Min(1000, $Config.SoundVolume)) / 1000.0)
        $script:PressPlayer.Volume = $vol
        $script:PressPlayer.Position = [TimeSpan]::Zero
        $script:PressPlayer.Play()
    } catch {}
}

function Play-ReleaseSound {
    if (-not $Config.SoundEnabled) { return }
    try {
        $vol = [double]([Math]::Max(0, [Math]::Min(1000, $Config.SoundVolume)) / 1000.0)
        $script:ReleasePlayer.Volume = $vol
        $script:ReleasePlayer.Position = [TimeSpan]::Zero
        $script:ReleasePlayer.Play()
    } catch {}
}

function Play-ApproveSound {
    if (-not $Config.SoundEnabled) { return }
    try {
        Play-ReleaseSound
        $t = New-Object System.Windows.Threading.DispatcherTimer
        $t.Interval = [TimeSpan]::FromMilliseconds(260)
        $t.Add_Tick({ param($sender, $e) $sender.Stop(); Play-ReleaseSound })
        $t.Start()
    } catch { try { [System.Media.SystemSounds]::Exclamation.Play() } catch {} }
}

# ============================================================================
# 12. Custom Rounded WPF ContextMenu (Modeled after T7moris/GPT-Niang)
# ============================================================================
$script:sliderConfigDirty = $false

function Save-PendingSliderConfig {
    if (-not $script:sliderConfigDirty) { return }
    Save-Config
}

$MenuXaml = @"
<ContextMenu xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             HasDropShadow="True" Background="Transparent" BorderThickness="0" Padding="0">
  <ContextMenu.Resources>
    <SolidColorBrush x:Key="MenuSurfaceBrush" Color="#FFF5F1FF"/>
    <SolidColorBrush x:Key="MenuTextBrush" Color="#FF2F2859"/>
    <SolidColorBrush x:Key="MenuMutedBrush" Color="#FF8A84B0"/>
    <SolidColorBrush x:Key="MenuAccentBrush" Color="#FF5340C9"/>
    <SolidColorBrush x:Key="MenuBorderBrush" Color="#FFE2D8FC"/>
    <SolidColorBrush x:Key="MenuHoverBrush" Color="#FFEDE9FE"/>
    <SolidColorBrush x:Key="MenuQuickBrush" Color="#0F5340C9"/>
    <SolidColorBrush x:Key="MenuSelectedBrush" Color="#FFEAE2FF"/>
    <Color x:Key="MenuShadowColor">#FF37297A</Color>
    <Style TargetType="MenuItem">
      <Setter Property="FontFamily" Value="Microsoft YaHei UI, Segoe UI"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="FontWeight" Value="Normal"/>
      <Setter Property="Foreground" Value="{DynamicResource MenuTextBrush}"/>
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Padding" Value="11,6"/>
      <Setter Property="MinHeight" Value="34"/>
      <Setter Property="HorizontalContentAlignment" Value="Stretch"/>
      <Setter Property="VerticalContentAlignment" Value="Center"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="MenuItem">
            <Grid SnapsToDevicePixels="True">
              <Border x:Name="ItemChrome" Background="{TemplateBinding Background}"
                      CornerRadius="7" Padding="{TemplateBinding Padding}" MinHeight="{TemplateBinding MinHeight}">
                <Grid>
                  <Grid.ColumnDefinitions>
                    <ColumnDefinition Width="Auto"/>
                    <ColumnDefinition Width="*"/>
                    <ColumnDefinition Width="18"/>
                  </Grid.ColumnDefinitions>
                  <ContentPresenter x:Name="RowIcon" ContentSource="Icon" Margin="0,0,9,0"
                                    VerticalAlignment="Center" IsHitTestVisible="False"/>
                  <ContentPresenter x:Name="HeaderPresenter" Grid.Column="1" ContentSource="Header" RecognizesAccessKey="True"
                                    VerticalAlignment="Center" HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}"
                                    Margin="0,0,10,0"/>
                  <Path x:Name="SelectionCheck" Grid.Column="2" Data="M 1,5 L 4,8 L 10,1"
                        Stroke="{DynamicResource MenuAccentBrush}" StrokeThickness="1.8" StrokeStartLineCap="Round"
                        StrokeEndLineCap="Round" StrokeLineJoin="Round" Width="12" Height="10"
                        VerticalAlignment="Center" HorizontalAlignment="Center" Visibility="Collapsed"/>
                  <Path x:Name="SubmenuChevron" Grid.Column="2" Data="M 1,1 L 5,5 L 1,9"
                        Stroke="{TemplateBinding Foreground}" StrokeThickness="1.5" StrokeStartLineCap="Round"
                        StrokeEndLineCap="Round" StrokeLineJoin="Round" Width="7" Height="10"
                        VerticalAlignment="Center" HorizontalAlignment="Center" Visibility="Collapsed"/>
                </Grid>
              </Border>
              <Popup x:Name="PART_Popup" Placement="Right" HorizontalOffset="-2" VerticalOffset="-8"
                     PlacementTarget="{Binding RelativeSource={RelativeSource TemplatedParent}}"
                     IsOpen="{Binding IsSubmenuOpen, RelativeSource={RelativeSource TemplatedParent}}"
                     AllowsTransparency="True" Focusable="False" PopupAnimation="None">
                <Border x:Name="SubmenuChrome" Background="{DynamicResource MenuSurfaceBrush}"
                        BorderBrush="{DynamicResource MenuBorderBrush}" BorderThickness="1" CornerRadius="12"
                        Padding="6" Margin="6,5,10,10" MinWidth="176" SnapsToDevicePixels="True">
                  <Border.Effect>
                    <DropShadowEffect BlurRadius="16" ShadowDepth="3" Direction="270" Opacity="0.15"
                                      Color="{DynamicResource MenuShadowColor}"/>
                  </Border.Effect>
                  <ScrollViewer CanContentScroll="True" HorizontalScrollBarVisibility="Disabled" VerticalScrollBarVisibility="Auto">
                    <ItemsPresenter KeyboardNavigation.DirectionalNavigation="Cycle" KeyboardNavigation.TabNavigation="Cycle"/>
                  </ScrollViewer>
                </Border>
              </Popup>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="Icon" Value="{x:Null}">
                <Setter TargetName="RowIcon" Property="Visibility" Value="Collapsed"/>
              </Trigger>
              <Trigger Property="IsHighlighted" Value="True">
                <Setter TargetName="ItemChrome" Property="Background" Value="{DynamicResource MenuHoverBrush}"/>
              </Trigger>
              <Trigger Property="IsSubmenuOpen" Value="True">
                <Setter TargetName="ItemChrome" Property="Background" Value="{DynamicResource MenuHoverBrush}"/>
              </Trigger>
              <Trigger Property="IsChecked" Value="True">
                <Setter TargetName="ItemChrome" Property="Background" Value="{DynamicResource MenuSelectedBrush}"/>
                <Setter Property="Foreground" Value="{DynamicResource MenuAccentBrush}"/>
                <Setter TargetName="SelectionCheck" Property="Visibility" Value="Visible"/>
              </Trigger>
              <Trigger Property="HasItems" Value="True">
                <Setter TargetName="SubmenuChevron" Property="Visibility" Value="Visible"/>
                <Setter TargetName="SelectionCheck" Property="Visibility" Value="Collapsed"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter TargetName="ItemChrome" Property="Opacity" Value="0.45"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="ExitMenuItemStyle" TargetType="MenuItem" BasedOn="{StaticResource {x:Type MenuItem}}">
      <Setter Property="MinHeight" Value="32"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Foreground" Value="#FFD9383A"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="MenuItem">
            <Grid SnapsToDevicePixels="True" MinHeight="{TemplateBinding MinHeight}">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="Auto"/>
                <ColumnDefinition Width="*"/>
              </Grid.ColumnDefinitions>
              <Border x:Name="ExitRowChrome" Grid.ColumnSpan="2"
                      Background="{TemplateBinding Background}" CornerRadius="7"/>
              <Border x:Name="ExitHitArea" Background="Transparent" Cursor="Hand"
                      Padding="{TemplateBinding Padding}" CornerRadius="7">
                <ContentPresenter ContentSource="Header" RecognizesAccessKey="True" VerticalAlignment="Center"/>
              </Border>
              <TextBlock x:Name="VersionLabel" Grid.Column="1" Text="{TemplateBinding Tag}"
                         Foreground="{DynamicResource MenuMutedBrush}" FontSize="12" Margin="14,0,11,0"
                         HorizontalAlignment="Right" VerticalAlignment="Center" IsHitTestVisible="False"/>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsHighlighted" Value="True">
                <Setter TargetName="ExitRowChrome" Property="Background" Value="{DynamicResource MenuHoverBrush}"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style TargetType="Separator">
      <Setter Property="Margin" Value="8,4"/>
      <Setter Property="Template">
        <Setter.Value><ControlTemplate TargetType="Separator"><Border Height="1" Background="{DynamicResource MenuBorderBrush}"/></ControlTemplate></Setter.Value>
      </Setter>
    </Style>
  </ContextMenu.Resources>
  <ContextMenu.Template>
    <ControlTemplate TargetType="ContextMenu">
      <Border x:Name="RootMenuChrome" Background="{DynamicResource MenuSurfaceBrush}"
              BorderBrush="{DynamicResource MenuBorderBrush}" BorderThickness="1" CornerRadius="12"
              Padding="6" Margin="6" MinWidth="266" SnapsToDevicePixels="True">
        <Border.Effect><DropShadowEffect BlurRadius="16" ShadowDepth="3" Direction="270" Opacity="0.15" Color="{DynamicResource MenuShadowColor}"/></Border.Effect>
        <ScrollViewer CanContentScroll="True" HorizontalScrollBarVisibility="Disabled" VerticalScrollBarVisibility="Auto">
          <ItemsPresenter KeyboardNavigation.DirectionalNavigation="Cycle" KeyboardNavigation.TabNavigation="Cycle"/>
        </ScrollViewer>
      </Border>
    </ControlTemplate>
  </ContextMenu.Template>
</ContextMenu>
"@

function Sync-CharacterMenuChecks {
    $curChar = [string]$Config.Character
    if ($Window -and $Window.ContextMenu -and $Window.ContextMenu.Items.Count -gt 0) {
        $charMenu = $Window.ContextMenu.Items | Where-Object { $_ -is [System.Windows.Controls.MenuItem] -and [string]$_.Tag -eq "CharacterSubMenu" } | Select-Object -First 1
        if (-not $charMenu) { $charMenu = $Window.ContextMenu.Items[0] }
        if ($charMenu -and $charMenu.Items) {
            foreach ($sub in $charMenu.Items) {
                if ($sub -is [System.Windows.Controls.MenuItem] -and $sub.Tag) {
                    $sub.IsChecked = ([string]$sub.Tag -eq $curChar)
                }
            }
        }
    }
    if ($script:TrayMenu -and $script:TrayMenu.Tag -and $script:TrayMenu.Tag.Roles) {
        foreach ($roleItem in $script:TrayMenu.Tag.Roles.DropDownItems) {
            if ($roleItem.Tag) {
                $roleItem.Checked = ([string]$roleItem.Tag -eq $curChar)
            }
        }
    }
}

function Set-AgentPetContextMenuTheme($contextMenu) {
    if (-not $contextMenu) { return }
    $theme = Get-CurrentTheme
    $colors = @{
        MenuSurfaceBrush  = $theme.BubbleBg
        MenuTextBrush     = $theme.BodyText
        MenuMutedBrush    = $theme.MutedText
        MenuAccentBrush   = $theme.Accent
        MenuBorderBrush   = $theme.HeaderDivider
        MenuHoverBrush    = $theme.BadgeBg
        MenuSelectedBrush = $theme.HoverBg
    }
    foreach ($entry in $colors.GetEnumerator()) {
        if ($entry.Value) { $contextMenu.Resources[$entry.Key] = $BrushConv.ConvertFromString([string]$entry.Value) }
    }
    $quickColor = $ColorConv.ConvertFromString([string]$theme.Accent)
    $quickColor.A = 15
    $contextMenu.Resources['MenuQuickBrush'] = [System.Windows.Media.SolidColorBrush]::new($quickColor)
    if ($theme.ShadowColor) {
        $shadowColor = $ColorConv.ConvertFromString([string]$theme.ShadowColor)
        $shadowColor.A = 255
        $contextMenu.Resources['MenuShadowColor'] = $shadowColor
    }
}

function Build-ContextMenu {
    $cm = [System.Windows.Markup.XamlReader]::Parse($MenuXaml)
    Set-AgentPetContextMenuTheme $cm

    # 1. Character Switcher
    $miCharHeader = New-Object System.Windows.Controls.MenuItem
    $miCharHeader.Header = "切换角色"
    $miCharHeader.FontWeight = "Normal"
    $miCharHeader.Tag = "CharacterSubMenu"

    foreach ($c in $script:CharacterRoster) {
        $item = New-Object System.Windows.Controls.MenuItem
        $item.Header = $c.Label
        $item.IsCheckable = $true
        $item.IsChecked = ($Config.Character -eq $c.Key)
        $item.Tag = $c.Key
        $item.Add_Click({
            param($sender, $e)
            $ck = [string]$sender.Tag
            $Config.Character = $ck
            Save-Config
            Update-Theme
            $targetPose = if ($Config.Pose -and $Config.Pose -ne "auto") { [string]$Config.Pose } else { "happy" }
            Set-PetSprite $targetPose
            Set-TrayIconForRole
            Update-TrayTooltip -Force
            Trigger-PetBounce
            Play-ReleaseSound
            $QuoteText.Text = Get-RandomCharacterQuote $ck
            Set-ActiveBubblePanel "quote"
            Show-Bubble 5.5
            if ($sender.Parent) {
                foreach ($sub in $sender.Parent.Items) {
                    if ($sub -is [System.Windows.Controls.MenuItem]) {
                        $sub.IsChecked = ([object]::ReferenceEquals($sub, $sender))
                    }
                }
            }
            $script:happyUntil = [DateTime]::UtcNow.AddSeconds(2.0)
            Build-ContextMenu
            Sync-CharacterMenuChecks
        })
        [void]$miCharHeader.Items.Add($item)
    }
    [void]$cm.Items.Add($miCharHeader)

    # 2. Set Character Pose Sub-Menu (设置角色形态)
    $miPoseHeader = New-Object System.Windows.Controls.MenuItem
    $miPoseHeader.Header = "动作形态"
    $miPoseHeader.FontWeight = "Normal"

    $poses = @(
        @{ Key = "auto";  Label = "自动跟随" },
        @{ Key = "idle";  Label = "待机" },
        @{ Key = "think"; Label = "思考" },
        @{ Key = "work";  Label = "工作" },
        @{ Key = "sleep"; Label = "瞌睡" },
        @{ Key = "happy"; Label = "开心" }
    )

    $currentPose = if ($Config.Pose) { [string]$Config.Pose } else { "auto" }

    foreach ($p in $poses) {
        $pItem = New-Object System.Windows.Controls.MenuItem
        $pItem.Header = $p.Label
        $pItem.IsCheckable = $true
        $pItem.IsChecked = ($currentPose -eq $p.Key)
        $pItem.Tag = $p.Key
        $pItem.Add_Click({
            param($sender, $e)
            $pk = [string]$sender.Tag
            $Config.Pose = $pk
            Save-Config
            if ($pk -eq "auto") {
                Set-PetSprite "idle"
            } else {
                Set-PetSprite $pk
            }
            Trigger-PetBounce
            Play-ReleaseSound
            if ($sender.Parent) {
                foreach ($sub in $sender.Parent.Items) {
                    if ($sub -is [System.Windows.Controls.MenuItem]) {
                        $sub.IsChecked = ([object]::ReferenceEquals($sub, $sender))
                    }
                }
            }
            Build-ContextMenu
        })
        [void]$miPoseHeader.Items.Add($pItem)
        if ($p.Key -eq "auto") { [void]$miPoseHeader.Items.Add((New-Object System.Windows.Controls.Separator)) }
    }
    [void]$cm.Items.Add($miPoseHeader)
    [void]$cm.Items.Add((New-Object System.Windows.Controls.Separator))

    # 2. Quick Actions
    $miShowQuota = New-Object System.Windows.Controls.MenuItem
    $miShowQuota.Header = "查看并刷新 Codex 额度"
    $miShowQuota.Add_Click({
        Start-UserBubbleInspection "quota"
    })
    [void]$cm.Items.Add($miShowQuota)

    $miShowDeepSeek = New-Object System.Windows.Controls.MenuItem
    $miShowDeepSeek.Header = "查看并刷新 DeepSeek 余额"
    $miShowDeepSeek.Add_Click({
        Start-UserBubbleInspection "deepseek"
    })
    [void]$cm.Items.Add($miShowDeepSeek)

    $miSayQuote = New-Object System.Windows.Controls.MenuItem
    $miSayQuote.Header = "随机台词"
    $miSayQuote.Add_Click({
        $QuoteText.Text = Get-RandomCharacterQuote $Config.Character
        Set-ActiveBubblePanel "quote"
        Trigger-PetBounce
        Play-ReleaseSound
        Show-Bubble 5.5
    })
    [void]$cm.Items.Add($miSayQuote)

    # 2.5 Bubble Default Mode Submenu
    $miBubbleDefault = New-Object System.Windows.Controls.MenuItem
    $miBubbleDefault.Header = "气泡默认偏好"
    $miBubbleDefault.Tag = "BubbleDefaultMenu"
    $miBubbleDefault.Visibility = if ($script:NotifyIcon) { 'Collapsed' } else { 'Visible' }
    foreach ($mOpt in @(
        @{ Key="quota"; Label="Codex 剩余额度" },
        @{ Key="deepseek"; Label="DeepSeek 官方余额" },
        @{ Key="quote"; Label="角色闲聊语录" }
    )) {
        $bOptItem = New-Object System.Windows.Controls.MenuItem
        $bOptItem.Header = $mOpt.Label
        $bOptItem.IsCheckable = $true
        $bOptItem.IsChecked = ($Config.BubbleMode -eq $mOpt.Key)
        $bOptItem.Tag = $mOpt.Key
        $bOptItem.Add_Click({
            param($sender, $e)
            $Config.BubbleMode = [string]$sender.Tag
            Save-Config
            if (-not $script:agentBusy -and -not (Get-Variable -Name agentBusy -ValueOnly -ErrorAction SilentlyContinue)) {
                Set-ActiveBubblePanel $Config.BubbleMode
                if ($Config.BubbleMode -eq "quote") {
                    $QuoteText.Text = Get-RandomCharacterQuote $Config.Character
                } elseif ($Config.BubbleMode -eq "deepseek") {
                    Request-BalanceRefresh
                } else {
                    Request-QuotaRefresh
                }
                Show-Bubble 5.5
            }
            Build-ContextMenu
        })
        [void]$miBubbleDefault.Items.Add($bOptItem)
    }
    [void]$cm.Items.Add($miBubbleDefault)

    [void]$cm.Items.Add((New-Object System.Windows.Controls.Separator))

    $miAppearance = New-Object System.Windows.Controls.MenuItem
    $miAppearance.Header = "外观"
    [void]$cm.Items.Add($miAppearance)

    # 3. Interactive Scale Slider Row + Presets
    $miScale = New-Object System.Windows.Controls.MenuItem
    $miScale.Header = "立绘缩放比例 ($([int][Math]::Round($Config.Scale * 100))%)"

    $scalePanel = New-Object System.Windows.Controls.StackPanel
    $scalePanel.Orientation = "Horizontal"
    $scalePanel.Width = 175
    $scaleSlider = New-Object System.Windows.Controls.Slider
    $scaleSlider.Minimum = 0.6
    $scaleSlider.Maximum = 1.8
    $scaleSlider.Value = [double]$Config.Scale
    $scaleSlider.Width = 125
    $scaleSlider.TickFrequency = 0.05
    $scaleSlider.IsSnapToTickEnabled = $true
    $scaleSlider.VerticalAlignment = "Center"
    $scaleValTxt = New-Object System.Windows.Controls.TextBlock
    $scaleValTxt.Text = "$([int][Math]::Round($Config.Scale * 100))%"
    $scaleValTxt.Margin = "8,0,0,0"
    $scaleValTxt.FontWeight = "SemiBold"
    $scaleValTxt.VerticalAlignment = "Center"

    $scaleSlider.Tag = @{ ValTxt = $scaleValTxt; MenuItem = $miScale }
    $scaleSlider.Add_ValueChanged({
        param($sender, $e)
        $v = [Math]::Round($sender.Value, 2)
        $Config.Scale = $v
        $script:sliderConfigDirty = $true
        if ($sender.Tag) {
            $sender.Tag.ValTxt.Text = "$([int][Math]::Round($v * 100))%"
            $sender.Tag.MenuItem.Header = "立绘缩放比例 ($([int][Math]::Round($v * 100))%)"
            foreach ($preset in $sender.Tag.MenuItem.Items) {
                if ($preset -is [System.Windows.Controls.MenuItem] -and $preset.IsCheckable) {
                    $preset.IsChecked = ([Math]::Abs($v - [double]$preset.Tag) -lt 0.03)
                }
            }
        }
        Update-Scale
        Update-BubbleScale
        Update-Facing
    })
    $scaleSlider.Add_PreviewMouseLeftButtonUp({ Save-PendingSliderConfig })
    $scaleSlider.Add_LostMouseCapture({ Save-PendingSliderConfig })
    $scaleSlider.Add_LostKeyboardFocus({ Save-PendingSliderConfig })

    [void]$scalePanel.Children.Add($scaleSlider)
    [void]$scalePanel.Children.Add($scaleValTxt)
    $miScaleSliderItem = New-Object System.Windows.Controls.MenuItem
    $miScaleSliderItem.Header = $scalePanel
    $miScaleSliderItem.StaysOpenOnClick = $true
    [void]$miScale.Items.Add($miScaleSliderItem)

    foreach ($sp in @(0.8, 1.0, 1.15, 1.3, 1.5)) {
        $spItem = New-Object System.Windows.Controls.MenuItem
        $spItem.Header = "$([int]($sp * 100))%"
        $spItem.IsCheckable = $true
        $spItem.IsChecked = ([Math]::Abs($Config.Scale - $sp) -lt 0.03)
        $spItem.Tag = [double]$sp
        $spItem.Add_Click({
            param($sender, $e)
            $Config.Scale = [double]$sender.Tag
            Save-Config
            Update-Scale
            Update-BubbleScale
            Update-Facing
            Build-ContextMenu
        })
        [void]$miScale.Items.Add($spItem)
    }
    [void]$miAppearance.Items.Add($miScale)

    # 4b. Bubble Scale Sub-Menu (气泡缩放 [0.8, 1.3])
    $currBS = if ($Config.BubbleScale) { [double]$Config.BubbleScale } else { 1.0 }
    $currBS = [Math]::Max(0.8, [Math]::Min(1.3, $currBS))
    $miBubbleScale = New-Object System.Windows.Controls.MenuItem
    $miBubbleScale.Header = "气泡缩放 ($([int][Math]::Round($currBS * 100))%)"
    $bsPresets = @(
        @{ Label = "80%";       Val = 0.80 },
        @{ Label = "✦ 100%";    Val = 1.00 },
        @{ Label = "115%";      Val = 1.15 },
        @{ Label = "130%";      Val = 1.30 }
    )
    foreach ($bp in $bsPresets) {
        $bItem = New-Object System.Windows.Controls.MenuItem
        $bItem.Header = $bp.Label
        $bItem.IsCheckable = $true
        $bItem.IsChecked = ([Math]::Abs($currBS - $bp.Val) -lt 0.04)
        $bItem.Tag = [double]$bp.Val
        $bItem.Add_Click({
            param($sender, $e)
            $Config.BubbleScale = [Math]::Max(0.8, [Math]::Min(1.3, [double]$sender.Tag))
            Save-Config
            Update-BubbleScale
            Show-Bubble -HoldSeconds 5.5 -Force
            Build-ContextMenu
        })
        [void]$miBubbleScale.Items.Add($bItem)
    }
    [void]$miAppearance.Items.Add($miBubbleScale)


    # 5. Bubble Font Size Sub-Menu (气泡字体大小适配)
    $currFS = if ($Config.FontScale) { [double]$Config.FontScale } else { 1.0 }
    $miFont = New-Object System.Windows.Controls.MenuItem
    $miFont.Header = "气泡字体大小 ($([int][Math]::Round($currFS * 100))%)"
    $fontPresets = @(
        @{ Label = "88%";       Val = 0.88 },
        @{ Label = "100%"; Val = 1.00 },
        @{ Label = "115%";  Val = 1.15 },
        @{ Label = "130%";  Val = 1.30 }
    )
    foreach ($fp in $fontPresets) {
        $fItem = New-Object System.Windows.Controls.MenuItem
        $fItem.Header = $fp.Label
        $fItem.IsCheckable = $true
        $fItem.IsChecked = ([Math]::Abs($currFS - $fp.Val) -lt 0.04)
        $fItem.Tag = [double]$fp.Val
        $fItem.Add_Click({
            param($sender, $e)
            $Config.FontScale = [double]$sender.Tag
            Save-Config
            Update-FontScale
            Show-Bubble -HoldSeconds 5.5 -Force
            Build-ContextMenu
        })
        [void]$miFont.Items.Add($fItem)
    }
    [void]$miAppearance.Items.Add($miFont)

    # 5. Sound & Volume Slider
    $miSound = New-Object System.Windows.Controls.MenuItem
    $miSound.Header = "音效与音量"

    $miSoundToggle = New-Object System.Windows.Controls.MenuItem
    $miSoundToggle.Header = "启用点击语音音效"
    $miSoundToggle.IsCheckable = $true
    $miSoundToggle.IsChecked = [bool]$Config.SoundEnabled
    $miSoundToggle.Add_Click({
        $Config.SoundEnabled = -not $Config.SoundEnabled
        Save-Config
        if ($Config.SoundEnabled) { Play-ReleaseSound }
        Build-ContextMenu
    })
    [void]$miSound.Items.Add($miSoundToggle)

    $volPanel = New-Object System.Windows.Controls.StackPanel
    $volPanel.Orientation = "Horizontal"
    $volPanel.Width = 175
    $volSlider = New-Object System.Windows.Controls.Slider
    $volSlider.Minimum = 0
    $volSlider.Maximum = 1000
    $volSlider.Value = [double]$Config.SoundVolume
    $volSlider.Width = 125
    $volSlider.TickFrequency = 50
    $volSlider.IsSnapToTickEnabled = $true
    $volSlider.VerticalAlignment = "Center"
    $volTxt = New-Object System.Windows.Controls.TextBlock
    $volTxt.Text = "$([int][Math]::Round($Config.SoundVolume / 10))%"
    $volTxt.Margin = "8,0,0,0"
    $volTxt.FontWeight = "SemiBold"
    $volTxt.VerticalAlignment = "Center"

    $volSlider.Tag = $volTxt
    $volSlider.Add_ValueChanged({
        param($sender, $e)
        $v = [int][Math]::Round($sender.Value)
        $Config.SoundVolume = $v
        $script:sliderConfigDirty = $true
        if ($sender.Tag) { $sender.Tag.Text = "$([int][Math]::Round($v / 10))%" }
    })
    $volSlider.Add_PreviewMouseLeftButtonUp({ Save-PendingSliderConfig })
    $volSlider.Add_LostMouseCapture({ Save-PendingSliderConfig })
    $volSlider.Add_LostKeyboardFocus({ Save-PendingSliderConfig })

    [void]$volPanel.Children.Add($volSlider)
    [void]$volPanel.Children.Add($volTxt)
    $miVolSliderItem = New-Object System.Windows.Controls.MenuItem
    $miVolSliderItem.Header = $volPanel
    $miVolSliderItem.StaysOpenOnClick = $true
    [void]$miSound.Items.Add($miVolSliderItem)

    # 6. Auto-Quotes (定时碎碎念)
    $miAutoQuote = New-Object System.Windows.Controls.MenuItem
    $miAutoQuote.Header = "定时碎碎念"
    $aqPresets = @(
        @{ Label = "关闭";      Val = 0 },
        @{ Label = "每 1 分钟"; Val = 1 },
        @{ Label = "每 3 分钟"; Val = 3 },
        @{ Label = "每 5 分钟"; Val = 5 },
        @{ Label = "每 15 分钟"; Val = 15 }
    )
    foreach ($aq in $aqPresets) {
        $aqItem = New-Object System.Windows.Controls.MenuItem
        $aqItem.Header = $aq.Label
        $aqItem.IsCheckable = $true
        $aqItem.IsChecked = ([int]$Config.AutoQuoteMinutes -eq $aq.Val)
        $aqItem.Tag = [int]$aq.Val
        $aqItem.Add_Click({
            param($sender, $e)
            $Config.AutoQuoteMinutes = [int]$sender.Tag
            Save-Config
            $script:lastAutoQuoteTime = [DateTime]::UtcNow
            Build-ContextMenu
        })
        [void]$miAutoQuote.Items.Add($aqItem)
    }

    # 7. Sleep Timeout
    $miSleep = New-Object System.Windows.Controls.MenuItem
    $miSleep.Header = "打盹时间"
    $sleepPresets = @(
        @{ Label = "30 秒";    Val = 30 },
        @{ Label = "1 分钟";   Val = 60 },
        @{ Label = "3 分钟";   Val = 180 },
        @{ Label = "5 分钟";   Val = 300 },
        @{ Label = "从不打盹"; Val = 999999 }
    )
    foreach ($slp in $sleepPresets) {
        $sItem = New-Object System.Windows.Controls.MenuItem
        $sItem.Header = $slp.Label
        $sItem.IsCheckable = $true
        $sItem.IsChecked = ([int]$Config.SleepSeconds -eq $slp.Val)
        $sItem.Tag = [int]$slp.Val
        $sItem.Add_Click({
            param($sender, $e)
            $Config.SleepSeconds = [int]$sender.Tag
            Save-Config
            $script:lastInteractTime = [DateTime]::UtcNow
            Build-ContextMenu
        })
        [void]$miSleep.Items.Add($sItem)
    }
    [void]$cm.Items.Add($miSleep)
    [void]$cm.Items.Add($miAutoQuote)
    [void]$cm.Items.Add($miSound)

    [void]$cm.Items.Add((New-Object System.Windows.Controls.Separator))

    $miBroadcast = New-Object System.Windows.Controls.MenuItem
    $nowUtcMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $pauseUntil = if ($null -ne $Config.PauseMonitorUntil) { [long]$Config.PauseMonitorUntil } else { 0 }
    $remMin = if ($pauseUntil -gt $nowUtcMs) { [int][Math]::Ceiling(($pauseUntil - $nowUtcMs) / 60000.0) } else { 0 }
    $miBroadcast.Header = if ($remMin -gt 0) { "状态播报（暂停中，剩余 $remMin 分钟）" } else { "状态播报（播报中）" }
    $b10 = New-Object System.Windows.Controls.MenuItem; $b10.Header = "暂停播报 10 分钟"
    $b10.Add_Click({ $Config.PauseMonitorUntil = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 600000; Save-Config; Build-ContextMenu })
    [void]$miBroadcast.Items.Add($b10)
    $b30 = New-Object System.Windows.Controls.MenuItem; $b30.Header = "暂停播报 30 分钟"
    $b30.Add_Click({ $Config.PauseMonitorUntil = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 1800000; Save-Config; Build-ContextMenu })
    [void]$miBroadcast.Items.Add($b30)
    $bResume = New-Object System.Windows.Controls.MenuItem; $bResume.Header = "立即恢复播报"
    $bResume.Add_Click({ $Config.PauseMonitorUntil = 0; Save-Config; Build-ContextMenu })
    [void]$miBroadcast.Items.Add($bResume)
    [void]$cm.Items.Add($miBroadcast)

    # 8. Hover Details, Topmost & Reset Position
    $miHoverDetail = New-Object System.Windows.Controls.MenuItem
    $miHoverDetail.Header = "悬停详情"
    $miHoverDetail.IsCheckable = $true
    $miHoverDetail.IsChecked = [bool]$Config.HoverDetailsEnabled
    $script:WpfHoverDetailMenuItem = $miHoverDetail
    $miHoverDetail.Add_Click({
        Set-HoverDetailsEnabled (-not [bool]$Config.HoverDetailsEnabled)
    })
    [void]$cm.Items.Add($miHoverDetail)

    $miTop = New-Object System.Windows.Controls.MenuItem
    $miTop.Header = "窗口置顶"
    $miTop.IsCheckable = $true
    $miTop.IsChecked = [bool]$Config.Topmost
    $miTop.Add_Click({
        $Config.Topmost = -not $Config.Topmost
        Sync-AgentPetTopmost -Force
        Save-Config
        Build-ContextMenu
    })
    [void]$cm.Items.Add($miTop)

    $cm.Add_Opened({
        param($sender, $e)
        Set-AgentPetContextMenuTheme $sender
        foreach ($item in $sender.Items) {
            if ($item.Tag -eq "BubbleDefaultMenu") {
                $item.Visibility = if ($script:NotifyIcon) { 'Collapsed' } else { 'Visible' }
                break
            }
        }
        if ($script:WpfHoverDetailMenuItem) {
            $script:WpfHoverDetailMenuItem.IsChecked = [bool]$Config.HoverDetailsEnabled
        }
        Sync-CharacterMenuChecks
    })
    $cm.Add_Closed({ Save-PendingSliderConfig })

    [void]$cm.Items.Add((New-Object System.Windows.Controls.Separator))

    $miResetPos = New-Object System.Windows.Controls.MenuItem
    $miResetPos.Header = "重置位置到右下角"
    $miResetPos.Add_Click({
        $wa = [System.Windows.SystemParameters]::WorkArea
        $Window.Left = $wa.Right - $Window.Width - 28
        $Window.Top  = $wa.Bottom - $Window.Height - 16
        $Config.Left = $Window.Left
        $Config.Top  = $Window.Top
        Save-Config
        Update-Facing
    })
    [void]$cm.Items.Add($miResetPos)

    [void]$cm.Items.Add((New-Object System.Windows.Controls.Separator))

    # 9. Version Info & Exit
    $miExit = New-Object System.Windows.Controls.MenuItem
    $miExit.Header = "退出 AgentPet"
    $miExit.Tag = "AgentPet v$script:AppVersion"
    $miExit.Style = $cm.Resources['ExitMenuItemStyle']
    $miExit.Add_Click({
        $Window.Close()
    })
    [void]$cm.Items.Add($miExit)

    # Root icons use the same 20-unit coordinate space and stay aligned with the row text.
    $rowIcons = @(
        @{ Item = $miCharHeader; Data = 'M 10,2 A 3.2,3.2 0 1 1 9.99,2 M 3,17 C 3,10 17,10 17,17' }
        @{ Item = $miPoseHeader; Data = 'M 8,2 Q 9,7 14,8 Q 9,9 8,14 Q 7,9 2,8 Q 7,7 8,2 M 15,11 V 17 M 12,14 H 18' }
        @{ Item = $miShowQuota; Data = 'M 3,15 A 8,8 0 1 1 17,15 H 3 M 9,12 L 13,8' }
        @{ Item = $miShowDeepSeek; Data = 'M 16,6 H 4 Q 2,6 2,8 V 15 Q 2,17 4,17 H 16 Q 18,17 18,15 V 8 Q 18,6 16,6 M 3,6 L 14,3 Q 16,3 16,6 M 18,10 H 13 A 1.5,1.5 0 0 0 13,13 H 18' }
        @{ Item = $miSayQuote; Data = 'M 5,14 L 3,17 V 12 A 7,7 0 1 1 9,16 Q 7,16 5,14 Z M 6,9 H 14 M 6,12 H 11' }
        @{ Item = $miBubbleDefault; Data = 'M 5,15 L 3,17 V 12 A 7,7 0 1 1 9,16 Q 7,16 5,15 Z M 6,9 H 13 M 8,7 V 11' }
        @{ Item = $miAppearance; Data = 'M 11,2 A 8,8 0 1 0 10,18 H 11 Q 13,18 12,16 Q 10,13 14,13 H 16 Q 18,13 18,10 A 8,8 0 0 0 11,2 Z M 6,9 H 6.2 M 8,6 H 8.2 M 12,6 H 12.2 M 15,8 H 15.2' }
        @{ Item = $miSleep; Data = 'M 10,2 A 8,8 0 1 0 18,12 A 7,7 0 0 1 10,2 Z' }
        @{ Item = $miAutoQuote; Data = 'M 4,3 H 16 Q 18,3 18,5 V 12 Q 18,14 16,14 H 8 L 3,18 V 5 Q 3,3 4,3 Z M 6,7 H 14 M 6,10 H 12' }
        @{ Item = $miSound; Data = 'M 3,7 H 6 L 10,4 V 16 L 6,13 H 3 Z M 13,7 Q 16,10 13,13 M 15,4 Q 20,10 15,16' }
        @{ Item = $miBroadcast; Data = 'M 4,14 H 16 Q 14,12 14,8 A 4,4 0 0 0 6,8 Q 6,12 4,14 Z M 8,17 Q 10,19 12,17' }
        @{ Item = $miHoverDetail; Data = 'M 3,4 H 17 V 16 H 3 Z M 3,8 H 17 M 6,6 H 6.2' }
        @{ Item = $miTop; Data = 'M 8,3 H 14 L 13,9 L 16,12 H 5 L 8,9 Z M 10,12 V 18' }
        @{ Item = $miResetPos; Data = 'M 4,4 L 15,15 M 8,15 H 15 V 8' }
    )
    foreach ($row in $rowIcons) {
        $icon = New-Object System.Windows.Shapes.Path
        $icon.Data = [System.Windows.Media.Geometry]::Parse($row.Data)
        $icon.Width = 15
        $icon.Height = 15
        $icon.Stretch = 'Uniform'
        $icon.StrokeThickness = 1.25
        $icon.StrokeStartLineCap = 'Round'
        $icon.StrokeEndLineCap = 'Round'
        $icon.StrokeLineJoin = 'Round'
        $icon.SetResourceReference([System.Windows.Shapes.Shape]::StrokeProperty, 'MenuMutedBrush')
        $row.Item.Icon = $icon
        $row.Item.MinHeight = 32
    }
    foreach ($item in @($miShowQuota, $miShowDeepSeek, $miSayQuote)) {
        $item.SetResourceReference([System.Windows.Controls.Control]::BackgroundProperty, 'MenuQuickBrush')
    }

    $Window.ContextMenu = $cm
}

$PetImage.Add_MouseRightButtonUp({
    param($s, $e)
    $e.Handled = $true
    if ($Window.ContextMenu) {
        $Window.ContextMenu.PlacementTarget = $PetImage
        $Window.ContextMenu.IsOpen = $true
    }
})

# ============================================================================
# 13. Mouse Drag, Click & Bubble Mode Interaction
# ============================================================================
$script:lastInteractTime  = [DateTime]::UtcNow
$script:lastAutoQuoteTime = [DateTime]::UtcNow
$script:happyUntil        = [DateTime]::MinValue
$script:agentBusy         = $false
$script:userInspectUntil  = [DateTime]::MinValue
$script:refreshingUntil   = [DateTime]::MinValue
$script:agentBusy         = $false
$script:isDragging        = $false
$script:mouseDownScreen   = New-Object System.Windows.Point(0, 0)
$script:winStartLeft      = 0.0
$script:winStartTop       = 0.0

$PetImage.Add_MouseLeftButtonDown({
    param($s, $e)
    $script:lastInteractTime = [DateTime]::UtcNow
    $script:isDragging = $false
    $source = [System.Windows.PresentationSource]::FromVisual($Window)
    $script:dpiX = if ($source -and $source.CompositionTarget) { $source.CompositionTarget.TransformToDevice.M11 } else { 1.0 }
    $script:dpiY = if ($source -and $source.CompositionTarget) { $source.CompositionTarget.TransformToDevice.M22 } else { 1.0 }
    $script:mouseDownScreen = $PetImage.PointToScreen($e.GetPosition($PetImage))
    $script:winStartLeft = $Window.Left
    $script:winStartTop  = $Window.Top
    [void]$PetImage.CaptureMouse()
    Play-PressSound
    $e.Handled = $true
})

$PetImage.Add_MouseMove({
    param($s, $e)
    if ($PetImage.IsMouseCaptured -and $e.LeftButton -eq [System.Windows.Input.MouseButtonState]::Pressed) {
        $curScreen = $PetImage.PointToScreen($e.GetPosition($PetImage))
        $dx = ($curScreen.X - $script:mouseDownScreen.X) / $script:dpiX
        $dy = ($curScreen.Y - $script:mouseDownScreen.Y) / $script:dpiY
        if ((-not $script:isDragging) -and ([Math]::Abs($dx) -gt 5 -or [Math]::Abs($dy) -gt 5)) {
            $script:isDragging = $true
            Close-HoverDetailCard
        }
        if ($script:isDragging) {
            $candidateLeft = $script:winStartLeft + $dx
            $candidateTop  = $script:winStartTop + $dy
            $dragBounds = Get-CharacterDragBounds $candidateLeft $candidateTop
            $Window.Left = [Math]::Max($dragBounds.MinLeft, [Math]::Min($dragBounds.MaxLeft, $candidateLeft))
            $Window.Top  = [Math]::Max($dragBounds.MinTop, [Math]::Min($dragBounds.MaxTop, $candidateTop))
            Update-Facing
        }
    }
})

$PetImage.Add_MouseLeftButtonUp({
    param($s, $e)
    if ($PetImage.IsMouseCaptured) {
        $PetImage.ReleaseMouseCapture()
    }
    if ($script:isDragging) {
        $script:isDragging = $false
        Clamp-CharacterWindowPosition
        $Config.Left = [Math]::Round($Window.Left)
        $Config.Top  = [Math]::Round($Window.Top)
        Save-Config
        Update-Facing
    } else {
        Stop-UserBubbleInspection
        Trigger-PetBounce
        Play-ReleaseSound
        $script:happyUntil = [DateTime]::UtcNow.AddSeconds(1.8)
        $defMode = if ($Config.BubbleMode -in @("quota","deepseek","quote")) { $Config.BubbleMode } else { "quota" }
        if ($script:agentBusy -and $script:lastAgentState -in @("waiting", "approval")) {
            Set-ActiveBubblePanel "work"
            Show-Bubble 0
        } elseif ($script:agentBusy) {
            # Temporary view default panel for 8.0s during busy state without changing default preference
            $script:userInspectUntil = [DateTime]::UtcNow.AddSeconds(8.0)
            if ($defMode -eq "quote") {
                $QuoteText.Text = Get-RandomCharacterQuote $Config.Character
            } elseif ($defMode -eq "deepseek") {
                Request-BalanceRefresh
            } else {
                Request-QuotaRefresh
            }
            Set-ActiveBubblePanel $defMode
            Show-Bubble 8.0
        } else {
            Set-PetSprite "happy"
            if (-not $script:isBubbleOpen) {
                if ($defMode -eq "quote") {
                    $QuoteText.Text = Get-RandomCharacterQuote $Config.Character
                } elseif ($defMode -eq "deepseek") {
                    Request-BalanceRefresh
                } else {
                    Request-QuotaRefresh
                }
                Set-ActiveBubblePanel $defMode
                Show-Bubble 5.5
            } else {
                Show-Bubble 5.5
            }
        }
    }
    $e.Handled = $true
})

# Clicking speech bubble blank area cycles: quota -> deepseek -> quote -> quota without modifying $Config.BubbleMode
$Bubble.Add_MouseLeftButtonUp({
    param($s, $e)
    $script:lastInteractTime = [DateTime]::UtcNow
    if ($script:lastAgentState -in @("waiting", "approval")) { $e.Handled = $true; return }
    if ($script:agentBusy -and [DateTime]::UtcNow -ge $script:userInspectUntil) { return }
    Trigger-PetBounce
    Play-ReleaseSound

    $cur = if ($script:currentBubblePanel) { $script:currentBubblePanel } else { "quota" }
    $nextMode = if ($cur -eq "quota") {
        "deepseek"
    } elseif ($cur -eq "deepseek") {
        "quote"
    } else {
        "quota"
    }

    if ($script:userInspectPanel -and $nextMode -in @("quota", "deepseek")) {
        Start-UserBubbleInspection $nextMode
        $e.Handled = $true
        return
    }
    if ($nextMode -eq "quote") {
        $QuoteText.Text = Get-RandomCharacterQuote $Config.Character
    } elseif ($nextMode -eq "deepseek") {
        Request-BalanceRefresh
    } else {
        Request-QuotaRefresh
    }
    Set-ActiveBubblePanel $nextMode
    Show-Bubble 5.5
    $e.Handled = $true
})

# Button click event isolation
if ($RefreshDeepSeekBtn) {
    $RefreshDeepSeekBtn.Add_Click({
        param($s, $e)
        $e.Handled = $true
        Start-UserBubbleInspection "deepseek"
    })
}
if ($DeepSeekPricingLink) {
    $DeepSeekPricingLink.Add_MouseLeftButtonUp({
        param($s, $e)
        $e.Handled = $true
        try { [System.Diagnostics.Process]::Start("https://api-docs.deepseek.com/quick_start/pricing/") } catch {}
    })
}
if ($RefreshQuotaBtn) {
    $RefreshQuotaBtn.Add_Click({
        param($s, $e)
        $e.Handled = $true
        Start-UserBubbleInspection "quota"
    })
}

# ============================================================================
# 14. Background Node.js Agent & Quota Monitor Integration
# ============================================================================
$script:MonitorProc = $null

$script:CachedNodeExe = $null
$script:LastNodeScanTime = [DateTime]::MinValue

function Find-NodeExe {
    if ($script:CachedNodeExe -and (Test-Path $script:CachedNodeExe)) {
        return $script:CachedNodeExe
    }
    $now = [DateTime]::UtcNow
    if (($now - $script:LastNodeScanTime).TotalSeconds -lt 30) {
        return $null
    }
    $script:LastNodeScanTime = $now

    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) {
        $script:CachedNodeExe = $cmd.Source
        return $script:CachedNodeExe
    }
    $candidates = @(
        "C:\Program Files\nodejs\node.exe",
        "C:\Program Files (x86)\nodejs\node.exe",
        (Join-Path $env:LOCALAPPDATA "Programs\node\node.exe"),
        (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"),
        (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\bin\node.exe"),
        (Join-Path $env:ProgramW6432 "nodejs\node.exe"),
        (Join-Path $BaseDir "node\node.exe")
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) {
            $script:CachedNodeExe = $c
            return $c
        }
    }

    $codexAppDir = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\runtimes"
    if (Test-Path $codexAppDir) {
        try {
            $subdirs = [System.IO.Directory]::GetDirectories($codexAppDir)
            foreach ($sd in $subdirs) {
                $cand = Join-Path $sd "bin\node.exe"
                if ([System.IO.File]::Exists($cand)) {
                    $script:CachedNodeExe = $cand
                    return $cand
                }
                foreach ($ssd in [System.IO.Directory]::GetDirectories($sd)) {
                    $cand2 = Join-Path $ssd "bin\node.exe"
                    if ([System.IO.File]::Exists($cand2)) {
                        $script:CachedNodeExe = $cand2
                        return $cand2
                    }
                }
            }
        } catch {}
    }

    # P2-PERF-1: Fast, non-recursive sibling runtime directory check (prevents UI thread lock)
    $cacheDir = Join-Path $env:USERPROFILE ".cache\codex-runtimes"
    if (Test-Path $cacheDir) {
        try {
            $subdirs = [System.IO.Directory]::GetDirectories($cacheDir)
            foreach ($sd in $subdirs) {
                $cand = Join-Path $sd "dependencies\node\bin\node.exe"
                if ([System.IO.File]::Exists($cand)) {
                    $script:CachedNodeExe = $cand
                    return $cand
                }
                $cand2 = Join-Path $sd "bin\node.exe"
                if ([System.IO.File]::Exists($cand2)) {
                    $script:CachedNodeExe = $cand2
                    return $cand2
                }
            }
        } catch {}
    }

    # Diagnostic throttled logging for missing Node runtime
    Log-Throttled "NodeMissing" "未找到 Node.js 可执行文件。已检查 PATH、常见安装路径与 Codex 依赖运行时。工作状态监控已停用。" 60
    return $null
}

function Start-AgentMonitor {
    if ($script:MonitorProc -and -not $script:MonitorProc.HasExited) { return }
    $nodeExe = Find-NodeExe
    if (-not $nodeExe -or -not (Test-Path $MonitorScript)) { return }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $nodeExe
        $stallSec = if ($null -ne $Config.StallDetectSeconds) { [int]$Config.StallDetectSeconds } else { 45 }
        if ($stallSec -lt 0) { $stallSec = 45 }
        $psi.Arguments = "`"$MonitorScript`" --parent-pid $PID --stall-seconds $stallSec"
        $psi.WorkingDirectory = $BaseDir
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $false
        $psi.RedirectStandardError = $false
        $script:MonitorProc = [System.Diagnostics.Process]::Start($psi)
        if ($script:MonitorProc -and $script:MonitorProc.Id) {
            try {
                $monPidMeta = @{
                    pid = $script:MonitorProc.Id
                    parentPid = $PID
                    path = $MonitorScript
                    startTime = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                    baseDir = $BaseDir
                }
                [System.IO.File]::WriteAllText($script:MonPidPath, ($monPidMeta | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8)
            } catch {}
        }
        # Issue ②: Fresh grace period on monitor launch so watchdog doesn't flash the bubble
        $script:lastStatusHeartbeatMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $script:monitorStartTime = [DateTime]::UtcNow
    } catch {
        Log-Throttled "MonitorStart" "Failed to start agent-monitor daemon: $($_.Exception.Message)" 30
    }
}

function Apply-AgentStatus($stObj) {
    if (-not $stObj) { return }
    $pauseUntil = if ($null -ne $Config.PauseMonitorUntil) { [long]$Config.PauseMonitorUntil } else { 0 }
    if ($pauseUntil -gt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) {
        Set-WaitingWindowAttention $false
        $script:lastWorkStatusObj = $null
        $script:LastDetailContentKey = $null
        $script:LastDetailMetaKey = $null
        Close-HoverDetailCard
        if ($script:agentBusy) {
            $script:agentBusy = $false
            $script:lastAgentState = $null
            $script:waitingLastAlert = $null
            Set-PetSprite "idle"
            if (-not $script:userInspectPanel) {
                Set-ActiveBubblePanel $Config.BubbleMode
                Hide-Bubble
            }
        }
        return
    }
    $state = [string]$stObj.state
    if (-not $state -or $state -eq "idle") {
        Set-WaitingWindowAttention $false
        $script:lastWorkStatusObj = $null
        $script:LastDetailContentKey = $null
        $script:LastDetailMetaKey = $null
        Close-HoverDetailCard
        if ($script:agentBusy) {
            $script:agentBusy = $false
            $script:lastInteractTime = [DateTime]::UtcNow
            $script:lastAgentState = $null
            $script:waitingLastAlert = $null
            Set-PetSprite "idle"
            if (-not $script:userInspectPanel) {
                Set-ActiveBubblePanel $Config.BubbleMode
                Hide-Bubble
            }
        }
        return
    }

    # Freshness check (P0 & Issue 9):
    # Waiting states allow up to 300s without heartbeat update. Active states allow up to 35s.
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $atMs = if ($stObj.at) { [double]$stObj.at } else { $nowMs }
    $ageSec = ($nowMs - $atMs) / 1000.0
    $maxAgeSec = if ($state -in @("waiting", "approval", "stalled")) { 300.0 } else { 35.0 }
    if ($ageSec -gt $maxAgeSec) {
        Set-WaitingWindowAttention $false
        $script:lastWorkStatusObj = $null
        $script:LastDetailContentKey = $null
        $script:LastDetailMetaKey = $null
        Close-HoverDetailCard
        if ($script:agentBusy) {
            $script:agentBusy = $false
            $script:lastInteractTime = [DateTime]::UtcNow
            $script:lastAgentState = $null
            $script:waitingLastAlert = $null
            Set-PetSprite "idle"
            if (-not $script:userInspectPanel) {
                Set-ActiveBubblePanel $Config.BubbleMode
                Hide-Bubble
            }
        }
        return
    }

    $script:lastWorkStatusObj = $stObj
    $script:agentBusy = $true
    $script:lastInteractTime = [DateTime]::UtcNow

    # 1. Row 1: Short State Header Text & Character/State Visual Style
    $WorkHeader.Text = Get-WorkShortHeaderText $state
    $prevState = $script:lastAgentState
    $script:lastAgentState = $state

    # 2. Row 2: Active Agent Source Pills (Primary + ×N + Active Secondary Pills)
    $fs = if ($Config.FontScale) { [double]$Config.FontScale } else { 1.0 }
    if ($fs -lt 0.80) { $fs = 0.80 }
    if ($fs -gt 1.40) { $fs = 1.40 }

    $rawSource = if ($stObj.source) { [string]$stObj.source } else { "Antigravity" }
    $primaryStyle = Get-AgentSourceStyle $rawSource
    $agentKey = $primaryStyle.Key

    if ($WorkSource.Text -cne $primaryStyle.Label) { $WorkSource.Text = $primaryStyle.Label }
    $WorkSource.FontSize = [Math]::Round(10.5 * $fs, 1)
    try {
        $pFg = $BrushConv.ConvertFromString($primaryStyle.Foreground)
        $WorkSource.Foreground = $pFg
        $WorkSourceBadge.Background = $BrushConv.ConvertFromString($primaryStyle.Background)
        $WorkSourceBadge.BorderBrush = $BrushConv.ConvertFromString($primaryStyle.BorderBrush)
    } catch {}

    if ($WorkSourceIcon) {
        $iconSz = [Math]::Round(13.0 * $fs, 1)
        $WorkSourceIcon.Width = $iconSz
        $WorkSourceIcon.Height = $iconSz
        if ($script:AgentIcons.ContainsKey($agentKey)) {
            if ($WorkSourceIcon.Source -ne $script:AgentIcons[$agentKey]) { $WorkSourceIcon.Source = $script:AgentIcons[$agentKey] }
            $WorkSourceIcon.Visibility = [System.Windows.Visibility]::Visible
        } else {
            $WorkSourceIcon.Visibility = [System.Windows.Visibility]::Collapsed
        }
    }

    $primarySub = if ($stObj.agents -and $agentKey) { $stObj.agents.$agentKey } else { $null }
    $sessionCount = if ($primarySub -and $primarySub.sessionCount) { [int]$primarySub.sessionCount } elseif ($stObj.sessionCount) { [int]$stObj.sessionCount } else { 0 }
    if ($WorkSourceCount) {
        if ($sessionCount -gt 1) {
            $cntText = "×$sessionCount"
            if ($WorkSourceCount.Text -cne $cntText) { $WorkSourceCount.Text = $cntText }
            $WorkSourceCount.FontSize = [Math]::Round(9.5 * $fs, 1)
            $WorkSourceCount.Foreground = $WorkSource.Foreground
            $WorkSourceCount.Visibility = [System.Windows.Visibility]::Visible
        } else {
            $WorkSourceCount.Visibility = [System.Windows.Visibility]::Collapsed
        }
    }

    $otherActiveStyles = @()
    if ($stObj.agents) {
        $activeWorkStates = @("working", "thinking", "waiting", "approval", "stalled")
        foreach ($k in @("antigravity", "codex", "dsh")) {
            if ($k -eq $agentKey) { continue }
            $sub = $stObj.agents.$k
            if ($sub -and $sub.state -and ($activeWorkStates -contains [string]$sub.state)) {
                $otherActiveStyles += (Get-AgentSourceStyle $k)
            }
        }
    }
    $script:WorkOtherActiveCount = $otherActiveStyles.Count
    $script:WorkActiveSecondaryStyles = $otherActiveStyles

    # Tooltip on WorkSourceBadge & WorkSourcesPanel showing dynamic Agent overview (update only when changed to prevent ToolTip flicker)
    if ($stObj.agents -and $WorkSourceBadge) {
        $agDesc = if ($stObj.agents.antigravity) { "$($stObj.agents.antigravity.state)" } else { "空闲" }
        $cxDesc = if ($stObj.agents.codex) { "$($stObj.agents.codex.state)" } else { "空闲" }
        $dsDesc = if ($stObj.agents.dsh) { "$($stObj.agents.dsh.state)" } else { "空闲" }
        if ($stObj.agents.antigravity -and $stObj.agents.antigravity.sessionCount -gt 1) { $agDesc += " ($($stObj.agents.antigravity.sessionCount) 个会话)" }
        if ($stObj.agents.codex -and $stObj.agents.codex.sessionCount -gt 1) { $cxDesc += " ($($stObj.agents.codex.sessionCount) 个会话)" }
        if ($stObj.agents.dsh -and $stObj.agents.dsh.sessionCount -gt 1) { $dsDesc += " ($($stObj.agents.dsh.sessionCount) 个会话)" }
        $overviewTip = "【Agent 实时看板】`nAntigravity: $agDesc`nCodex: $cxDesc`nDSH: $dsDesc"
        if ([string]$WorkSourceBadge.ToolTip -cne $overviewTip) { $WorkSourceBadge.ToolTip = $overviewTip }
        if ($WorkSourcesPanel -and ([string]$WorkSourcesPanel.ToolTip -cne $overviewTip)) { $WorkSourcesPanel.ToolTip = $overviewTip }
        foreach ($os in $otherActiveStyles) {
            $secPill = Get-OrCreateWorkSourcePillElement $os $fs
            if ($secPill -and ([string]$secPill.ToolTip -cne $overviewTip)) { $secPill.ToolTip = $overviewTip }
        }
    } elseif ($WorkSourceBadge) {
        if ($null -ne $WorkSourceBadge.ToolTip) { $WorkSourceBadge.ToolTip = $null }
        if ($WorkSourcesPanel -and ($null -ne $WorkSourcesPanel.ToolTip)) { $WorkSourcesPanel.ToolTip = $null }
        if ($script:WorkSecondaryPillPool) {
            foreach ($secPill in $script:WorkSecondaryPillPool.Values) {
                if ($secPill -and ($null -ne $secPill.ToolTip)) { $secPill.ToolTip = $null }
            }
        }
    }
    if ($WorkInlineSourceHost -and ($null -ne $WorkInlineSourceHost.ToolTip)) { $WorkInlineSourceHost.ToolTip = $null }

    # 3. Row 3: State hint / urgent task summary split
    $nextTaskText = Get-WorkBubbleDisplayTask $stObj
    if ($WorkTask.Text -cne $nextTaskText) { $WorkTask.Text = $nextTaskText }

    # P1-2: Do not override user inspection of quota panel unless agent enters waiting/approval state
    $now = [DateTime]::UtcNow
    $isUserInspecting = ($script:userInspectUntil -and $now -lt $script:userInspectUntil)
    $isWaiting = ($state -eq "waiting" -or $state -eq "approval")
    Set-WaitingWindowAttention $isWaiting
    if ($isWaiting) { Stop-UserBubbleInspection; $isUserInspecting = $false }

    if ((-not $script:manualBubbleHidden -and (-not $isUserInspecting)) -or $isWaiting) {
        Set-ActiveBubblePanel "work"
        Show-Bubble 0
    }

    # WO-06: waiting or approval state transition alert (bounce + chime)
    if ($isWaiting) {
        if ($prevState -ne $state) {
            Set-ActiveBubblePanel "work"
            Show-Bubble 0 -Force
            Trigger-PetBounce
            Play-ApproveSound
        }
        if (-not $script:waitingLastAlert -or ([DateTime]::UtcNow - $script:waitingLastAlert).TotalSeconds -ge 60) {
            $script:waitingLastAlert = [DateTime]::UtcNow
            Set-ActiveBubblePanel "work"
            Show-Bubble 0 -Force
            if ($prevState -eq $state) { Trigger-PetBounce; Play-ApproveSound }
        }
    } else {
        $script:waitingLastAlert = $null
    }
    $script:lastStatusHeartbeatMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    if ($script:currentBubblePanel -eq "work") {
        [void](Apply-WorkVisualStyle $state (Get-CurrentTheme))
        Update-WorkTaskLineBudget
    }
    if ([bool]$Config.HoverDetailsEnabled -or ($script:DetailWindow -and $script:DetailWindow.IsVisible)) {
        Update-DetailWindowContent $stObj
    }

    # WO-01: Complete pose mapping (success/done -> happy, waiting/approval uses character wait sprite if available else think)
    $charWaitKey = "$([string]$Config.Character)-wait"
    $waitSprite = if ($Config.Character -eq "deepseek" -and $script:ImageCache.ContainsKey($charWaitKey)) { "wait" } else { "think" }
    $spriteState = switch ($state) {
        "thinking" { "think" }
        "waiting"  { $waitSprite }
        "approval" { $waitSprite }
        "stalled"  { "think" }
        "working"  { "work"  }
        "calling"  { "work"  }
        "result"   { "think" }
        "success"  { "happy" }
        "done"     { "happy" }
        "error"    { "think" }
        default    { "work"  }
    }
    Set-PetSprite $spriteState
}

$script:lastStatusMtime = [DateTime]::MinValue
$script:lastQuotaMtime  = [DateTime]::MinValue

function Poll-AgentMonitor {
    # 0. Watchdog: ensure agent-monitor daemon is running
    if (-not $script:MonitorProc -or $script:MonitorProc.HasExited) {
        Start-AgentMonitor
    }

    # 1. Watch runtime-quota.json file modification (atomic parse before updating mtime, Issue 11)
    if (Test-Path $RuntimeQuotaPath) {
        try {
            $item = Get-Item $RuntimeQuotaPath -ErrorAction SilentlyContinue
            if ($item -and $item.LastWriteTimeUtc -gt $script:lastQuotaMtime) {
                $raw = Get-Content $RuntimeQuotaPath -Raw -Encoding UTF8 -ErrorAction Stop
                $q = $raw | ConvertFrom-Json -ErrorAction Stop
                if ($q) {
                    $script:lastQuotaMtime = $item.LastWriteTimeUtc
                    $script:refreshingUntil = [DateTime]::MinValue
                    Apply-QuotaObject $q
                }
            }
        } catch {
            Log-Throttled "QuotaRead" "Failed to parse runtime-quota.json: $($_.Exception.Message)"
        }
    }

    # 3. Watch runtime-balance.json file modification (WO-35 baseline & 15s startup deadline)
    if (Test-Path $RuntimeBalancePath) {
        try {
            $item = Get-Item $RuntimeBalancePath -ErrorAction SilentlyContinue
            if ($item -and $item.LastWriteTimeUtc -gt $script:lastBalanceMtime) {
                $raw = Get-Content $RuntimeBalancePath -Raw -Encoding UTF8 -ErrorAction Stop
                $b = $raw | ConvertFrom-Json -ErrorAction Stop
                if ($b) {
                    $script:lastBalanceMtime = $item.LastWriteTimeUtc
                    Receive-BalanceSnapshot $b
                }
            }
        } catch {
            Log-Throttled "BalanceRead" "Failed to parse runtime-balance.json: $($_.Exception.Message)"
        }
    }
    if ($script:balanceStartupPending -and $script:balanceStartupDeadline -and ([DateTime]::UtcNow -ge $script:balanceStartupDeadline)) {
        $script:balanceStartupPending = $false
        $script:balanceStartupDeadline = $null
        Apply-BalanceObject @{
            type = "balance"
            provider = "unknown"
            providerFamily = "deepseek"
            status = "unavailable"
            balances = @()
            isAvailable = $false
            errorCode = "STARTUP_TIMEOUT"
            errorMessage = "启动后未获取到余额数据"
        }
    }

    # 2. Watch runtime-status.json file modification (atomic parse before updating mtime, Issue 11)
    if (Test-Path $RuntimeStatusPath) {
        try {
            $item = Get-Item $RuntimeStatusPath -ErrorAction SilentlyContinue
            if ($item -and $item.LastWriteTimeUtc -gt $script:lastStatusMtime) {
                $raw = Get-Content $RuntimeStatusPath -Raw -Encoding UTF8 -ErrorAction Stop
                $st = $raw | ConvertFrom-Json -ErrorAction Stop
                if ($st) {
                    $script:lastStatusMtime = $item.LastWriteTimeUtc
                    Apply-AgentStatus $st
                }
            }
        } catch {
            Log-Throttled "StatusRead" "Failed to parse runtime-status.json: $($_.Exception.Message)"
        }
    }
}

# ============================================================================
# 15. Win32 Window SourceInitialized Hook (Click-Through & No-Activate)
# ============================================================================
function Test-ElementHit([System.Windows.UIElement]$el, [System.Windows.Point]$screenPt) {
    if (-not $el) { return $false }
    try {
        if (-not $el.IsVisible) { return $false }
        $effOpacity = 1.0
        $cur = [System.Windows.DependencyObject]$el
        while ($cur) {
            if ($cur -is [System.Windows.UIElement]) {
                if ($cur.Visibility -ne [System.Windows.Visibility]::Visible) { return $false }
                $effOpacity *= [double]$cur.Opacity
                if ($effOpacity -lt 0.08) { return $false }
            }
            $cur = [System.Windows.Media.VisualTreeHelper]::GetParent($cur)
        }
        if ($el.ActualWidth -le 0 -or $el.ActualHeight -le 0) { return $false }
        $pt = $el.PointFromScreen($screenPt)
        return ($pt.X -ge 0 -and $pt.Y -ge 0 -and $pt.X -le $el.ActualWidth -and $pt.Y -le $el.ActualHeight)
    } catch {
        return $false
    }
}

function Test-PetOpaqueHit([System.Windows.Point]$screenPt) {
    try {
        if ($PetImage.ActualWidth -le 1 -or $PetImage.ActualHeight -le 1) { return $false }
        $pt = $PetImage.PointFromScreen($screenPt)
        if ($pt.X -lt 0 -or $pt.Y -lt 0 -or $pt.X -gt $PetImage.ActualWidth -or $pt.Y -gt $PetImage.ActualHeight) {
            return $false
        }
        $alphaInfo = $script:AlphaCache[$script:CurrentSpriteKey]
        if (-not $alphaInfo) { return $true }
        $u = $pt.X / $PetImage.ActualWidth
        $v = $pt.Y / $PetImage.ActualHeight
        $px = [int][Math]::Min($alphaInfo.Width - 1, [Math]::Max(0, [Math]::Floor($u * $alphaInfo.Width)))
        $py = [int][Math]::Min($alphaInfo.Height - 1, [Math]::Max(0, [Math]::Floor($v * $alphaInfo.Height)))
        $alphaIdx = ($py * $alphaInfo.Stride) + ($px * 4) + 3
        return ($alphaInfo.Bytes[$alphaIdx] -gt 12)
    } catch {
        return $true
    }
}

function Get-StageNcHitTestResult([System.Windows.Point]$screenPt) {
    $bubbleActive = ($Bubble -and $Bubble.Visibility -eq [System.Windows.Visibility]::Visible -and $Bubble.Opacity -ge 0.08)
    if (($bubbleActive -and ((Test-ElementHit $BubbleBorder $screenPt) -or
                             (Test-ElementHit $Tail $screenPt) -or
                             (Test-ElementHit $TailNear $screenPt))) -or
        (Test-PetOpaqueHit $screenPt)) {
        return [AgentPetNative]::HTCLIENT
    }
    return [AgentPetNative]::HTTRANSPARENT
}

$Window.Add_SourceInitialized({
    try {
        $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($Window)).Handle
        [AgentPetNative]::ApplyToolWindowStyle($hwnd)
        Sync-AgentPetTopmost -Force
        $src = [System.Windows.Interop.HwndSource]::FromHwnd($hwnd)
        if ($src) {
            $src.AddHook({
                param([IntPtr]$hwnd, [int]$msg, [IntPtr]$wParam, [IntPtr]$lParam, [ref]$handled)
                if ($msg -eq [AgentPetNative]::WM_MOUSEACTIVATE) {
                    $handled.Value = $true
                    return [IntPtr][AgentPetNative]::MA_NOACTIVATE
                }
                if ($msg -eq [AgentPetNative]::WM_NCHITTEST) {
                    try {
                        $lp = $lParam.ToInt64()
                        $x = [int][int16]($lp -band 0xFFFF)
                        $y = [int][int16](($lp -shr 16) -band 0xFFFF)
                        $screenPt = New-Object System.Windows.Point($x, $y)

                        $handled.Value = $true
                        return [IntPtr](Get-StageNcHitTestResult $screenPt)
                    } catch {}
                }
                return [IntPtr]::Zero
            })
        }
    } catch {}
})

# ============================================================================
# 16. Main Heartbeat Timer (250ms) & Startup Initialization
# ============================================================================
$Timer = New-Object System.Windows.Threading.DispatcherTimer
$Timer.Interval = [TimeSpan]::FromMilliseconds(250)
$script:tickCounter = 0

$Timer.Add_Tick({
    $now = [DateTime]::UtcNow
    $script:tickCounter++

    # 0.0 Check graceful stop flag from stop-agent.ps1 (with freshness & startup timestamp guard)
    $stopFlag = Join-Path (Join-Path $BaseDir "runtime") "stop.flag"
    if (Test-Path $stopFlag) {
        $validStop = $false
        try {
            $flagItem = Get-Item $stopFlag -ErrorAction SilentlyContinue
            $rawTs = ([System.IO.File]::ReadAllText($stopFlag, [System.Text.Encoding]::UTF8)).Trim()
            $flagMs = [long]0
            $nowEpochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            if ([long]::TryParse($rawTs, [ref]$flagMs)) {
                if ($flagMs -ge $script:AppStartTimeMs -and ($nowEpochMs - $flagMs) -le 60000) { $validStop = $true }
            } elseif ($flagItem) {
                $flagMtimeMs = ([DateTimeOffset]$flagItem.LastWriteTimeUtc).ToUnixTimeMilliseconds()
                if ($flagMtimeMs -ge $script:AppStartTimeMs -and (([DateTime]::UtcNow - $flagItem.LastWriteTimeUtc).TotalSeconds -le 60)) { $validStop = $true }
            }
        } catch {}
        try { Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue } catch {}
        if ($validStop) {
            Write-PetLog "Received graceful stop signal (stop.flag). Closing window..."
            Request-AgentPetExit
            return
        } else {
            Write-PetLog "Ignored stale stop.flag from before current process start."
        }
    }

    # 0. Check wake flag from duplicate launch (recover bounds + bring to front + bounce)
    $wakeFlag = Join-Path $BaseDir "wake.flag"
    if (Test-Path $wakeFlag) {
        try { Remove-Item $wakeFlag -Force -ErrorAction SilentlyContinue } catch {}
        Write-PetLog "Received wake signal from second launch. Restoring visibility and position."
        # Unified character visible boundary constraint (allowing legal negative Top at screen top edge)
        Clamp-CharacterWindowPosition
        $Config.Left = [Math]::Round($Window.Left)
        $Config.Top  = [Math]::Round($Window.Top)
        Save-Config

        $Window.Opacity = 1.0
        $Window.Visibility = [System.Windows.Visibility]::Visible
        Set-AgentPetWindowVisible $true
        Sync-AgentPetTopmost -Force
        Trigger-PetBounce
        Play-ReleaseSound
        $script:happyUntil = [DateTime]::UtcNow.AddSeconds(2.0)
        Set-PetSprite "happy"
        $QuoteText.Text = Get-CharacterWakeQuote $Config.Character
        Set-ActiveBubblePanel "quote"
        Show-Bubble 4.0
    }

    if (($script:tickCounter % 4) -eq 0 -and (-not $script:trayWindowHidden) -and ([bool]$Config.Topmost -or [bool]$script:waitingAttentionActive)) {
        $menuOpen = (($Window.ContextMenu -and $Window.ContextMenu.IsOpen) -or ($script:TrayMenu -and $script:TrayMenu.Visible))
        if (-not $menuOpen) {
            Sync-AgentPetTopmost
        }
    }

    # Renew inspection before status updates can choose the work panel.
    Update-UserBubbleInspection $now ([bool]$Bubble.IsMouseOver)

    # 0.5 Safety revert for balance refresh notice (AP05: report timeout honestly, never "已是最新")
    if (Get-Command Update-BalanceRefreshTimeout -ErrorAction SilentlyContinue) {
        Update-BalanceRefreshTimeout $now
    } elseif ($script:balanceRequestTimeout -and $now -gt $script:balanceRequestTimeout) {
        $script:balanceRequestTimeout = $null
        if ($DeepSeekStatusNotice) {
            $DeepSeekStatusNotice.Text = "刷新超时，点击 ↻ 重试"
            $DeepSeekStatusNotice.ToolTip = "本次刷新 15 秒内未获得结果"
        }
    }

    # 1. Poll agent-monitor.mjs stdout & runtime-status.json
    Poll-AgentMonitor
    Update-TrayTooltip

    # WO-02 & Issue ②: UI-side watchdog fallback (respects 15s monitor startup grace period)
    if ($script:agentBusy) {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $stAgeSec = ($nowMs - $script:lastStatusHeartbeatMs) / 1000.0
        $monitorDead = (-not $script:MonitorProc -or $script:MonitorProc.HasExited)
        $monitorJustStarted = ($script:monitorStartTime -and (($now - $script:monitorStartTime).TotalSeconds -lt 15.0))
        if (-not $monitorJustStarted) {
            $isWaiting = ($script:lastAgentState -eq "waiting" -or $script:lastAgentState -eq "approval")
            $timeoutLimit = if ($isWaiting) { 60.0 } else { 35.0 }
            # Clear busy state if monitor process died OR if heartbeat timed out (P0: stale waiting cleanup)
            if ($monitorDead -or ($stAgeSec -gt $timeoutLimit)) {
                Set-WaitingWindowAttention $false
                $script:agentBusy = $false
                $script:lastWorkStatusObj = $null
                $script:LastDetailContentKey = $null
                $script:LastDetailMetaKey = $null
                Close-HoverDetailCard
                $script:lastAgentState = $null
                $script:waitingLastAlert = $null
                $script:lastInteractTime = [DateTime]::UtcNow
                Set-PetSprite "idle"
                if (-not $script:userInspectPanel) {
                    Set-ActiveBubblePanel $Config.BubbleMode
                    Hide-Bubble
                }
            }
        }
    }

    # 2. Keep bubble open while user is hovering over it
    if ($script:isBubbleOpen -and (-not $script:agentBusy) -and (-not $script:userInspectPanel)) {
        if ($Bubble.IsMouseOver) {
            $script:bubbleCloseTime = $now.AddSeconds(2.8)
        } elseif ($now -ge $script:bubbleCloseTime) {
            Hide-Bubble
        }
    }

    # 3. Manage idle / happy / sleep state transitions & auto-quotes when not busy
    if (-not $script:agentBusy) {
        if ($Config.Pose -and $Config.Pose -ne "auto") {
            if ($now -lt $script:happyUntil) {
                if ($script:CurrentState -ne "happy") { Set-PetSprite "happy" }
            } else {
                if ($script:CurrentState -ne $Config.Pose) { Set-PetSprite $Config.Pose }
            }
        } else {
            if ($now -lt $script:happyUntil) {
                if ($script:CurrentState -ne "happy") { Set-PetSprite "happy" }
            } else {
                $idleSec = ($now - $script:lastInteractTime).TotalSeconds
                if ($idleSec -ge [double]$Config.SleepSeconds) {
                    if ($script:CurrentState -ne "sleep") { Set-PetSprite "sleep" }
                } else {
                    if ($script:CurrentState -ne "idle") { Set-PetSprite "idle" }
                }
            }
        }

        # Auto-Quotes (定时碎碎念)
        $aqMin = [int]$Config.AutoQuoteMinutes
        if ($aqMin -gt 0 -and (-not $script:isBubbleOpen)) {
            if (($now - $script:lastAutoQuoteTime).TotalMinutes -ge $aqMin) {
                $script:lastAutoQuoteTime = $now
                $QuoteText.Text = Get-RandomCharacterQuote $Config.Character
                Set-ActiveBubblePanel "quote"
                Show-Bubble 5.2
            }
        }
    }

    # 4. Refresh quota reset countdown labels every ~15 seconds (respecting refresh window P2-2)
    if ($script:refreshingUntil -ne [DateTime]::MinValue -and $now -ge $script:refreshingUntil) {
        $script:refreshingUntil = [DateTime]::MinValue
        if ($script:lastQuotaObject) {
            Apply-QuotaObject $script:lastQuotaObject
        } else {
            $ShortReset.Text = "刷新超时"
        }
    }
    if (($script:tickCounter % 60) -eq 0 -and $script:lastQuotaObject) {
        if (-not $script:refreshingUntil -or $now -ge $script:refreshingUntil) {
            Apply-QuotaObject $script:lastQuotaObject
        }
    }

    # P1-2: If agent is busy and user 8s quota inspection expired, restore work panel
    if ($script:agentBusy -and $script:userInspectUntil -and $now -ge $script:userInspectUntil) {
        if ($WorkStatusPanel.Visibility -ne [System.Windows.Visibility]::Visible) {
            Set-ActiveBubblePanel "work"
            Show-Bubble 0
        }
    }
})

# Initial Window Setup
Update-Scale
Update-BubbleScale
Update-FontScale
Update-Theme
$initPose = if ($Config.Pose -and $Config.Pose -ne "auto") { [string]$Config.Pose } else { "idle" }
Set-PetSprite $initPose
Read-InitialQuotaSnapshot
Read-InitialBalanceSnapshot
Build-ContextMenu
Initialize-TrayIcon

$Window.Topmost = [bool]$Config.Topmost
$hasSavedPos = ($null -ne $Config.Left -and $null -ne $Config.Top -and ($Config.Left -ne -1 -or $Config.Top -ne -1))
if ($hasSavedPos) {
    $Window.Left = [double]$Config.Left
    $Window.Top  = [double]$Config.Top
    Clamp-CharacterWindowPosition
} else {
    $bounds = Get-CurrentScreenBounds 0 0
    $Window.Left = $bounds.Right - $Window.Width - 28
    $Window.Top  = $bounds.Bottom - $Window.Height - 16
    Clamp-CharacterWindowPosition
}

$Window.Add_Loaded({
    Write-PetLog "Window Loaded event triggered successfully."
    Update-Facing
    Sync-AgentPetTopmost -Force
    Start-AgentMonitor
    $Timer.Start()
    if ([bool]$Config.StartHidden) {
        Set-AgentPetWindowVisible $false
        Update-TrayTooltip -Force
        return
    }
    # Pop open a friendly greeting bubble on launch for 5.5 seconds
    $QuoteText.Text = Get-RandomCharacterQuote $Config.Character
    Set-ActiveBubblePanel "quote"
    Show-Bubble 5.5
})

$Window.Add_ContentRendered({
    if ([bool]$Config.StartHidden) {
        Set-AgentPetWindowVisible $false
        Update-TrayTooltip -Force
    }
})

$Window.Add_Closed({
    Save-PendingSliderConfig
    try { $Timer.Stop() } catch {}
    try { Close-HoverDetailCard -Dispose } catch {}
    try {
        if ($script:NotifyIcon) {
            $script:NotifyIcon.Visible = $false
            $script:NotifyIcon.Dispose()
            $script:NotifyIcon = $null
        }
        if ($script:TrayIconAsset) { try { $script:TrayIconAsset.Dispose() } catch {}; $script:TrayIconAsset = $null }
        if ($script:TrayIconBitmap) { try { $script:TrayIconBitmap.Dispose() } catch {}; $script:TrayIconBitmap = $null }
        if ($script:TrayIconHandle -ne [IntPtr]::Zero) { try { [AgentPetNative]::DestroyIcon($script:TrayIconHandle) } catch {}; $script:TrayIconHandle = [IntPtr]::Zero }
    } catch {}
    try {
        if ($script:InstanceMutex) {
            $script:InstanceMutex.ReleaseMutex()
            $script:InstanceMutex.Dispose()
        }
    } catch {}
    # P0-1: Wait and confirm monitor termination before cleaning PID files
    if ($script:MonitorProc -and (-not $script:MonitorProc.HasExited)) {
        try {
            Start-Process -FilePath "taskkill.exe" -ArgumentList "/F", "/T", "/PID", "$($script:MonitorProc.Id)" -WindowStyle Hidden -ErrorAction SilentlyContinue
            [void]$script:MonitorProc.WaitForExit(1500)
            if (-not $script:MonitorProc.HasExited) {
                try { $script:MonitorProc.Kill() } catch {}
                [void]$script:MonitorProc.WaitForExit(500)
            }
        } catch {
            try { $script:MonitorProc.Kill() } catch {}
        }
    }
    # Clean up temporary flag files & verified PID files (P0-1)
    try {
        if (Test-Path $RefreshFlagPath)        { Remove-Item -Path $RefreshFlagPath -Force -ErrorAction SilentlyContinue }
        if (Test-Path $RefreshBalanceFlagPath) { Remove-Item -Path $RefreshBalanceFlagPath -Force -ErrorAction SilentlyContinue }
    } catch {}
    try {
        if (Test-Path $script:MonPidPath) {
            if (-not $script:MonitorProc -or $script:MonitorProc.HasExited) {
                Remove-Item $script:MonPidPath -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
    try {
        if (Test-Path $script:AppPidPath) {
            Remove-Item $script:AppPidPath -Force -ErrorAction SilentlyContinue
        }
    } catch {}
    Write-PetLog "Window Closed event completed."
})

Write-PetLog "Calling Window.ShowDialog()..."
try {
    [void]$Window.ShowDialog()
    Write-PetLog "Window.ShowDialog() returned normally."
} catch {
    Write-PetLog "FATAL in ShowDialog(): $($_.Exception.ToString())"
    [System.Windows.Forms.MessageBox]::Show("桌宠运行遇到错误：`n$($_.Exception.Message)", "AgentPet 运行错误", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
}
Write-PetLog "=== AgentPet Process Exiting (PID $PID) ==="

