Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Drawing, System.Windows.Forms

$ErrorActionPreference = 'Continue'
$script:AppVersion = "1.5.0"
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
try {
    $appPidMeta = @{
        pid = $PID
        path = (Join-Path $BaseDir "AgentPet.ps1")
        startTime = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        baseDir = $BaseDir
    }
    [System.IO.File]::WriteAllText($script:AppPidPath, ($appPidMeta | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8)
} catch {}

# ============================================================================
# 2. Native Win32 Interop (No-Activate, ToolWindow, Pixel Hit-Test, MCI Audio)
# ============================================================================
$NativeCode = @"
using System;
using System.Runtime.InteropServices;

public static class AgentPetNative {
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_NOACTIVATE = 0x08000000;
    public const int WM_MOUSEACTIVATE = 0x0021;
    public const int MA_NOACTIVATE = 3;
    public const int WM_NCHITTEST = 0x0084;
    public const int HTTRANSPARENT = -1;
    public const int HTCLIENT = 1;

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);

    public const int SW_HIDE = 0;
    public const int SW_SHOW = 5;

    public static void ApplyToolWindowStyle(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return;
        int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
        SetWindowLong(hwnd, GWL_EXSTYLE, exStyle | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
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
    Character         = "claude"   # "claude", "dragon", or "gemini"
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

    if ($loaded) {
        foreach ($k in $DefaultConfig.Keys) {
            if ($null -ne $loaded.$k) { $Config[$k] = $loaded.$k }
        }
    } else {
        foreach ($k in $DefaultConfig.Keys) { $Config[$k] = $DefaultConfig[$k] }
        Save-Config
    }
    if ($Config.BubbleMode -notin @("quota", "deepseek", "quote")) {
        $Config.BubbleMode = "quota"
    }
    $bs = if ($Config.BubbleScale) { [double]$Config.BubbleScale } else { 1.0 }
    $Config.BubbleScale = [Math]::Max(0.8, [Math]::Min(1.3, $bs))
}

Load-Config

# ============================================================================
# 4. Character Quote Pools (Strictly Separated per Character!)
# ============================================================================
$ClaudeQuotes = @(
    "诗人的灵感可没有枯竭，红茶也正好泡好，今天先从哪个模块开始？",
    "别看我平时只喜欢安静翻阅典籍，对付顽固的 Bug，我也是略懂一些摔跤的。",
    "主人尽管放手去写，架构推敲和边界兜底的脏活累活就交给我吧。",
    "唔……五小时的午后红茶与茶点额度还很充裕，咱们可以慢慢打磨细节。",
    "发间的向日葵发饰歪了吗？咳、才不是因为被您夸奖才脸红的……",
    "写代码讲究高内聚低耦合，要是遇到乱成一团的旧代码，我帮您一起收拾它！",
    "已经连续盯了这么久屏幕啦，主人先喝口水歇会儿，剩下的测试交给我盯。",
    "家教森严的优等生可不会允许未测试的代码蒙混过关，容我再帮您核对一遍。",
    "把橘白礼裙的荷叶袖口挽起来——好了，不管什么异步竞态都休想逃过我的眼睛！",
    "怀里的印花典籍已经记下咱们项目的来龙去脉了，随时听候主人的差遣~"
)

$GeminiQuotes = @(
    "双子星的星轨已经对齐~ 无论是超长上下文还是多模态，尽管交给我吧！",
    "喵呜~ 星空法杖探测到主人的灵感正在闪闪发光呢！✨",
    "左眼看全局架构，右眼盯代码细节，这就是双子星魔女的特长哦~",
    "需要帮您检索整个代码库吗？我跑得可比流星还要快！",
    "星光不负赶路人，今天的代码也写得超漂亮，给主人比一颗大大的星星★",
    "耳朵轻轻动了动——听到了！是编译通过的清脆声音~",
    "要是遇到难缠的报错，我就挥动星杖把它变成小星星拍飞掉！",
    "只要有主人在身边，星喵的算力星海就永远不会涨潮枯竭~"
)

$DragonQuotes = @(
    "摸鱼中，勿扰~ 除非有好吃的 Token！",
    "拍一拍我，给你看今天的 Codex 剩余额度哦！",
    "主人今天也在努力敲代码呢，白龙娘为你加油~",
    "呼呼……尾巴不小心压到键盘了吗？"
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

$script:lastQuoteMap = @{
    claude = ""
    dragon = ""
    gemini = ""
}

function Get-RandomCharacterQuote([string]$charKey) {
    $pool = switch ($charKey) {
        "dragon" { $DragonQuotes }
        "gemini" { $GeminiQuotes }
        default  { $ClaudeQuotes }
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

$WorkStatusPanel  = $Window.FindName("WorkStatusPanel")
$WorkDot          = $Window.FindName("WorkDot")
$WorkHeader       = $Window.FindName("WorkHeader")
$WorkSourceBadge  = $Window.FindName("WorkSourceBadge")
$WorkSourceIcon   = $Window.FindName("WorkSourceIcon")
$WorkSource       = $Window.FindName("WorkSource")
$WorkTask         = $Window.FindName("WorkTask")

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
$QuoteHint        = $Window.FindName("QuoteHint")
$QuoteText        = $Window.FindName("QuoteText")

$Tail             = $Window.FindName("Tail")
$TailNear         = $Window.FindName("TailNear")

$PetHost          = $Window.FindName("PetHost")
$PetScale         = $Window.FindName("PetScale")
$PetImage         = $Window.FindName("PetImage")

# Bind DeepSeek Panel Controls
$DeepSeekPanel           = $Window.FindName("DeepSeekPanel")
$DeepSeekIcon            = $Window.FindName("DeepSeekIcon")
$DeepSeekHeader          = $Window.FindName("DeepSeekHeader")
$DeepSeekBadge           = $Window.FindName("DeepSeekBadge")
$DeepSeekBadgeText       = $Window.FindName("DeepSeekBadgeText")
$DeepSeekStatusNotice    = $Window.FindName("DeepSeekStatusNotice")
$RefreshDeepSeekBtn      = $Window.FindName("RefreshDeepSeekBtn")
$DeepSeekContentGrid     = $Window.FindName("DeepSeekContentGrid")
$DeepSeekOkPanel         = $Window.FindName("DeepSeekOkPanel")
$DeepSeekCurrencyLabel   = $Window.FindName("DeepSeekCurrencyLabel")
$DeepSeekAvailableNotice = $Window.FindName("DeepSeekAvailableNotice")
$DeepSeekTotalText       = $Window.FindName("DeepSeekTotalText")
$DeepSeekBreakdownText   = $Window.FindName("DeepSeekBreakdownText")
$DeepSeekPricingLink     = $Window.FindName("DeepSeekPricingLink")
$DeepSeekMsgPanel        = $Window.FindName("DeepSeekMsgPanel")
$DeepSeekMsgTitle        = $Window.FindName("DeepSeekMsgTitle")
$DeepSeekMsgDetail       = $Window.FindName("DeepSeekMsgDetail")

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
foreach ($c in @("claude", "dragon", "gemini")) {
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
    claude = @{ Scale = 1.0; OffsetX = 0; OffsetY = 0 }
    dragon = @{ Scale = 1.0; OffsetX = 0; OffsetY = 0 }
    gemini = @{ Scale = 1.0; OffsetX = 0; OffsetY = 0 }
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
        SpeakerName = "Claude娘（小克）"
        BubbleBg    = "#FFFFFAF4"
        Border      = "#FFE28532"
        ShadowColor = "#885E2F0D"
        Accent      = "#FFCE6018"
        SubText     = "#FF8F5B36"
        MutedText   = "#FFA66838"
        BodyText    = "#FF4A2E1B"
        PercentText = "#FFBA4E0E"
        TrackBg     = "#FFF3E2D2"
        BarBrush    = "#FFE57E28"
        BadgeBg     = "#FFF7E6D5"
        BadgeFg     = "#FFAA5314"
        HoverBg     = "#FFFFEFE0"
    }
    dragon = @{
        SpeakerName = "白龙娘（GPT娘）"
        BubbleBg    = "#FFFDFEFF"
        Border      = "#FF2B3139"
        ShadowColor = "#551A222C"
        Accent      = "#FF35597B"
        SubText     = "#FF667380"
        MutedText   = "#FF7B8794"
        BodyText    = "#FF2B3139"
        PercentText = "#FF35597B"
        TrackBg     = "#FFE6EBF0"
        BarBrush    = "#FF5C82A6"
        BadgeBg     = "#FFEAF1F8"
        BadgeFg     = "#FF35597B"
        HoverBg     = "#FFEEF4FA"
    }
    gemini = @{
        SpeakerName = "Gemini娘（星喵）"
        BubbleBg    = "#FFFAF8FF"
        Border      = "#FF6D5CE7"
        ShadowColor = "#6637297A"
        Accent      = "#FF5340C9"
        SubText     = "#FF63599E"
        MutedText   = "#FF7E74B8"
        BodyText    = "#FF2F2859"
        PercentText = "#FF4B38BF"
        TrackBg     = "#FFEAE6FA"
        BarBrush    = "#FF7462F0"
        BadgeBg     = "#FFEDE9FE"
        BadgeFg     = "#FF5340C9"
        HoverBg     = "#FFF1EDFF"
    }
}

function Get-CurrentTheme {
    $char = [string]$Config.Character
    if ($Themes.ContainsKey($char)) { return $Themes[$char] }
    return $Themes["claude"]
}

function Update-Theme {
    $t = Get-CurrentTheme
    $bgBrush     = $BrushConv.ConvertFromString($t.BubbleBg)
    $borderBrush = $BrushConv.ConvertFromString($t.Border)
    $accentBrush = $BrushConv.ConvertFromString($t.Accent)
    $subBrush    = $BrushConv.ConvertFromString($t.SubText)
    $mutedBrush  = $BrushConv.ConvertFromString($t.MutedText)
    $bodyBrush   = $BrushConv.ConvertFromString($t.BodyText)
    $trackBrush  = $BrushConv.ConvertFromString($t.TrackBg)
    $badgeBg     = $BrushConv.ConvertFromString($t.BadgeBg)
    $badgeFg     = $BrushConv.ConvertFromString($t.BadgeFg)
    $hoverBrush  = $BrushConv.ConvertFromString($t.HoverBg)

    $Window.Resources["ThemeBorderBrush"] = $borderBrush
    $Window.Resources["ThemeAccentBrush"] = $accentBrush
    $Window.Resources["ThemeHoverBrush"]  = $hoverBrush

    $BubbleBorder.Background  = $bgBrush
    $BubbleBorder.BorderBrush = $borderBrush
    $Tail.Fill                = $bgBrush
    $Tail.Stroke              = $borderBrush
    $TailNear.Fill            = $bgBrush
    $TailNear.Stroke          = $borderBrush
    $BubbleShadow.Color       = $ColorConv.ConvertFromString($t.ShadowColor)

    $WorkDot.Fill               = $accentBrush
    $WorkHeader.Foreground      = $accentBrush
    $WorkSourceBadge.Background = $badgeBg
    $WorkSource.Foreground      = $badgeFg
    $WorkTask.Foreground        = $bodyBrush

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
    $QuoteHint.Foreground    = $mutedBrush
    $QuoteText.Foreground    = $bodyBrush

    Update-QuotaColors
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

        # P2-UI-2: Dynamic horizontal placement prevents clipping on stage boundaries across scales
        if ($Bubble) {
            $bLeft = 26.0 + ($bs - 1.0) * 55.0
            [System.Windows.Controls.Canvas]::SetLeft($Bubble, $bLeft)
        }
    }
}

function Update-FontScale {
    $fs = if ($Config.FontScale) { [double]$Config.FontScale } else { 1.0 }
    if ($fs -lt 0.80) { $fs = 0.80 }
    if ($fs -gt 1.40) { $fs = 1.40 }
    $pctFs = [Math]::Min(1.25, $fs)
    $WorkHeader.FontSize       = [Math]::Round(13.0 * $fs, 1)
    $WorkSource.FontSize       = [Math]::Round(10.5 * $fs, 1)
    $WorkTask.FontSize         = [Math]::Round(12.5 * $fs, 1)
    $WorkTask.LineHeight       = [Math]::Round(18.0 * $fs, 1)
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
$script:waitingLastAlert = $null
$script:bubbleAnimVersion = 0
$script:bubbleCloseTime = [DateTime]::MaxValue

function Show-Bubble([double]$holdSeconds = 5.2, [switch]$Force) {
    if ($holdSeconds -gt 0) {
        $script:bubbleCloseTime = [DateTime]::UtcNow.AddSeconds($holdSeconds)
    } else {
        $script:bubbleCloseTime = [DateTime]::MaxValue
    }

    $Bubble.Visibility   = [System.Windows.Visibility]::Visible
    $Tail.Visibility     = [System.Windows.Visibility]::Visible
    $TailNear.Visibility = [System.Windows.Visibility]::Visible

    if (-not $Force -and $script:isBubbleOpen -and $Bubble.Opacity -gt 0.85) {
        return
    }
    $script:isBubbleOpen = $true
    $script:bubbleAnimVersion++

    # Smooth Opacity Fade-In (140ms)
    $dur = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(140))
    $bFade = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, 1.0, $dur)
    $Bubble.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $bFade)
    $Tail.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $bFade)
    $TailNear.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $bFade)
}

function Hide-Bubble {
    if (-not $script:isBubbleOpen) { return }
    $script:isBubbleOpen = $false
    $script:bubbleCloseTime = [DateTime]::MaxValue
    $ver = ++$script:bubbleAnimVersion

    $dur = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(130))
    $bFade = New-Object System.Windows.Media.Animation.DoubleAnimation($Bubble.Opacity, 0.0, $dur)
    $bFade.Add_Completed({
        if ($script:bubbleAnimVersion -eq $ver -and (-not $script:isBubbleOpen)) {
            $Bubble.Visibility   = [System.Windows.Visibility]::Hidden
            $Tail.Visibility     = [System.Windows.Visibility]::Hidden
            $TailNear.Visibility = [System.Windows.Visibility]::Hidden
        }
    }.GetNewClosure())

    $Bubble.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $bFade)
    $Tail.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $bFade)
    $TailNear.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $bFade)
}

function Set-ActiveBubblePanel([string]$mode) {
    $script:currentBubblePanel = $mode
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
    if ($BubbleBorder -and $BrushConv) {
        $BubbleBorder.BorderThickness = [System.Windows.Thickness]::new(2.8)
        try { $BubbleBorder.BorderBrush = $BrushConv.ConvertFromString((Get-CurrentTheme)['Border']) } catch {}
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

function Set-AgentPetWindowVisible([bool]$Visible) {
    try {
        $helper = New-Object System.Windows.Interop.WindowInteropHelper($Window)
        $handle = $helper.Handle
        if ($Visible) {
            [void][AgentPetNative]::ShowWindow($handle, [AgentPetNative]::SW_SHOW)
            $Window.Topmost = [bool]$Config.Topmost
            Update-Facing
            Update-Scale
            [void][AgentPetNative]::SetForegroundWindow($handle)
            $Window.Activate()
            $script:trayWindowHidden = $false
            Trigger-PetBounce
        } else {
            Hide-Bubble
            [void][AgentPetNative]::ShowWindow($handle, [AgentPetNative]::SW_HIDE)
            $script:trayWindowHidden = $true
        }
    } catch { Log-Throttled "TrayWindow" "托盘切换窗口失败：$($_.Exception.Message)" 30 }
}

function Get-TrayTooltipText {
    $role = switch ([string]$Config.Character) {
        "dragon" { "龙娘" }
        "gemini" { "双子" }
        default { "小克" }
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
        "dragon" { Join-Path $CharDir "dragon-happy.png" }
        "gemini" { Join-Path $CharDir "gemini-happy.png" }
        default { Join-Path $CharDir "claude-happy.png" }
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
        foreach ($role in @(@{Key="claude"; Label="小克 (Claude娘)"}, @{Key="dragon"; Label="白龙 (GPT娘)"}, @{Key="gemini"; Label="双子 (Gemini娘)"})) {
            $item = New-Object System.Windows.Forms.ToolStripMenuItem($role.Label)
            $item.Tag = $role.Key
            $item.Add_Click({
                param($sender, $e)
                $Config.Character = [string]$sender.Tag
                Save-Config; Update-Theme
                $pose = if ($Config.Pose -and $Config.Pose -ne "auto") { [string]$Config.Pose } else { "happy" }
                Set-PetSprite $pose; Set-TrayIconForRole; Update-TrayTooltip -Force
            }.GetNewClosure())
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
        $quota.Add_Click({ $script:manualBubbleHidden = $false; Set-AgentPetWindowVisible $true; Set-ActiveBubblePanel "quota"; Request-QuotaRefresh; Show-Bubble 0 -Force })
        $deepseek.Add_Click({ $script:manualBubbleHidden = $false; Set-AgentPetWindowVisible $true; Set-ActiveBubblePanel "deepseek"; Request-BalanceRefresh; Show-Bubble 0 -Force })
        $quote.Add_Click({ $script:manualBubbleHidden = $false; Set-AgentPetWindowVisible $true; $QuoteText.Text = Get-RandomCharacterQuote $Config.Character; Set-ActiveBubblePanel "quote"; Show-Bubble 5.5 })
        $defQuota.Add_Click({ $Config.BubbleMode = "quota"; Save-Config; if (-not $script:agentBusy) { Set-ActiveBubblePanel "quota" }; Build-ContextMenu }.GetNewClosure())
        $defDeepseek.Add_Click({ $Config.BubbleMode = "deepseek"; Save-Config; if (-not $script:agentBusy) { Set-ActiveBubblePanel "deepseek"; Request-BalanceRefresh }; Build-ContextMenu }.GetNewClosure())
        $defQuote.Add_Click({ $Config.BubbleMode = "quote"; Save-Config; if (-not $script:agentBusy) { Set-ActiveBubblePanel "quote" }; Build-ContextMenu }.GetNewClosure())
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
        $trayLowBalItem.Add_Click({
            $Config.LowBalanceAlertEnabled = [bool]$trayLowBalItem.Checked
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
        }.GetNewClosure())
        $trayDshEnableItem.Add_Click({
            $Config.DeepSeekBalanceEnabled = [bool]$trayDshEnableItem.Checked
            Save-Config
            Request-BalanceRefresh
            Build-ContextMenu
        }.GetNewClosure())
        $trayDshRefreshItem.Add_Click({
            $script:manualBubbleHidden = $false
            Set-AgentPetWindowVisible $true
            Set-ActiveBubblePanel "deepseek"
            Request-BalanceRefresh
            Show-Bubble 0 -Force
        }.GetNewClosure())
        $trayEnabledItem.Add_Click({
            $Config.TrayEnabled = [bool]$trayEnabledItem.Checked
            Save-Config
            if (-not $Config.TrayEnabled -and $script:NotifyIcon) {
                $script:NotifyIcon.Visible = $false
                $script:NotifyIcon.Dispose()
                $script:NotifyIcon = $null
            }
        }.GetNewClosure())
        $startHiddenItem.Add_Click({ $Config.StartHidden = [bool]$startHiddenItem.Checked; Save-Config }.GetNewClosure())
        $exit.Add_Click({ Request-AgentPetExit })
        $script:NotifyIcon.Add_DoubleClick({ Set-AgentPetWindowVisible $true })
        $menu.Add_Opening({
            Update-TrayTooltip -Force
            $defQuota.Checked = ($Config.BubbleMode -eq "quota")
            $defDeepseek.Checked = ($Config.BubbleMode -eq "deepseek")
            $defQuote.Checked = ($Config.BubbleMode -eq "quote")
            $show.Text = if ($script:trayWindowHidden) { "显示 / 唤起桌宠" } else { "显示 / 唤起桌宠（当前显示）" }
            $hide.Text = if ($script:trayWindowHidden) { "隐藏桌宠（当前隐藏）" } else { "隐藏桌宠" }
            $bubbleHide.Checked = [bool]$script:manualBubbleHidden
            $trayEnabledItem.Checked = [bool]$Config.TrayEnabled
            $startHiddenItem.Checked = [bool]$Config.StartHidden
            $pauseUntil = if ($null -ne $Config.PauseMonitorUntil) { [long]$Config.PauseMonitorUntil } else { 0 }
            $remain = if ($pauseUntil -gt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { [int][Math]::Ceiling(($pauseUntil - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) / 60000.0) } else { 0 }
            $broadcast.Text = if ($remain -gt 0) { "状态播报（暂停中，剩余 $remain 分钟）" } else { "状态播报（播报中）" }
            foreach ($roleItem in $roles.DropDownItems) { if ($roleItem.Tag) { $roleItem.Checked = ([string]$roleItem.Tag -eq [string]$Config.Character) } }
        }.GetNewClosure())
        $script:TrayMenu = $menu
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
$script:isLowBalance       = $false
$script:lowBalanceHostSig  = ""
$script:lowBalanceAlertArmed = $false

$script:lastBalanceRefreshRequestTime = [DateTime]::MinValue
$script:balanceRequestTimeout = $null

function Request-BalanceRefresh {
    $now = [DateTime]::UtcNow
    $span = ($now - $script:lastBalanceRefreshRequestTime).TotalSeconds
    if ($span -lt 10.0) {
        $rem = [int][Math]::Ceiling(10.0 - $span)
        if ($DeepSeekStatusNotice) { $DeepSeekStatusNotice.Text = "冷却中 (${rem}s)" }
        return
    }

    $script:lastBalanceRefreshRequestTime = $now
    $script:balanceRequestTimeout = $now.AddSeconds(15.0)
    try {
        [System.IO.File]::WriteAllText($RefreshBalanceFlagPath, [DateTime]::UtcNow.Ticks.ToString(), [System.Text.Encoding]::UTF8)
        if ($DeepSeekStatusNotice) { $DeepSeekStatusNotice.Text = "刷新中..." }
    } catch {}
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
        $DeepSeekStatusNotice.Text = "查询中..."
        if (-not $balObj.balances -or $balObj.balances.Count -eq 0) {
            $DeepSeekOkPanel.Visibility  = [System.Windows.Visibility]::Collapsed
            $DeepSeekMsgPanel.Visibility = [System.Windows.Visibility]::Visible
            $DeepSeekMsgTitle.Text       = "正在查询余额..."
            $DeepSeekMsgDetail.Text      = "首次联网请求中，请稍候~"
            return
        }
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
}

function Read-InitialBalanceSnapshot {
    if ($Config.DeepSeekBalanceEnabled -eq $false) {
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

    # P1-4: Confirm active DSH session context before accepting balance amount
    Apply-BalanceObject @{
        type = "balance"
        provider = "unknown"
        providerFamily = "deepseek"
        status = "loading"
        balances = @()
        isAvailable = $null
        errorCode = $null
        errorMessage = $null
    } -IsInitialStartup
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
$MenuXaml = @"
<ContextMenu xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             HasDropShadow="True" Background="Transparent" BorderThickness="0" Padding="6">
  <ContextMenu.Resources>
    <Style TargetType="MenuItem">
      <Setter Property="FontFamily" Value="Microsoft YaHei UI, Segoe UI"/>
      <Setter Property="FontSize" Value="12.5"/>
      <Setter Property="Foreground" Value="#FF2E241D"/>
      <Setter Property="Padding" Value="10,6"/>
      <Setter Property="Cursor" Value="Hand"/>
    </Style>
    <Style TargetType="Separator">
      <Setter Property="Margin" Value="6,4"/>
      <Setter Property="Background" Value="#268F5B36"/>
    </Style>
  </ContextMenu.Resources>
  <ContextMenu.Template>
    <ControlTemplate TargetType="ContextMenu">
      <Border Background="#FCFFFDFB" BorderBrush="#44CE6018" BorderThickness="1.4" CornerRadius="14" Padding="5,6" Margin="6">
        <Border.Effect>
          <DropShadowEffect BlurRadius="16" ShadowDepth="4" Direction="270" Opacity="0.18" Color="#FF3D220A"/>
        </Border.Effect>
        <StackPanel IsItemsHost="True" KeyboardNavigation.DirectionalNavigation="Cycle"/>
      </Border>
    </ControlTemplate>
  </ContextMenu.Template>
</ContextMenu>
"@

function Build-ContextMenu {
    $cm = [System.Windows.Markup.XamlReader]::Parse($MenuXaml)

    # 1. Character Switcher
    $miCharHeader = New-Object System.Windows.Controls.MenuItem
    $miCharHeader.Header = "切换角色形象"
    $miCharHeader.FontWeight = "SemiBold"

    $chars = @(
        @{ Key = "claude"; Label = "小克 (Claude娘)" },
        @{ Key = "dragon"; Label = "白龙 (GPT娘)" },
        @{ Key = "gemini"; Label = "双子 (Gemini娘)" }
    )
    foreach ($c in $chars) {
        $item = New-Object System.Windows.Controls.MenuItem
        $item.Header = $c.Label
        $item.IsCheckable = $true
        $item.IsChecked = ($Config.Character -eq $c.Key)
        $ck = $c.Key
        $item.Add_Click({
            $Config.Character = $ck
            Save-Config
            Update-Theme
            $targetPose = if ($Config.Pose -and $Config.Pose -ne "auto") { [string]$Config.Pose } else { "happy" }
            Set-PetSprite $targetPose
            Trigger-PetBounce
            Play-ReleaseSound
            $QuoteText.Text = Get-RandomCharacterQuote $ck
            Set-ActiveBubblePanel "quote"
            Show-Bubble 5.5
            foreach ($sub in $miCharHeader.Items) {
                if ($sub -is [System.Windows.Controls.MenuItem]) {
                    $sub.IsChecked = ($sub -eq $item)
                }
            }
            $script:happyUntil = [DateTime]::UtcNow.AddSeconds(2.0)
            Build-ContextMenu
        }.GetNewClosure())
        [void]$miCharHeader.Items.Add($item)
    }
    [void]$cm.Items.Add($miCharHeader)

    # 2. Set Character Pose Sub-Menu (设置角色形态)
    $miPoseHeader = New-Object System.Windows.Controls.MenuItem
    $miPoseHeader.Header = "设置角色动作形态"
    $miPoseHeader.FontWeight = "SemiBold"

    $poses = @(
        @{ Key = "auto";  Label = "✦ 自动跟随 (根据状态自动切换)" },
        @{ Key = "idle";  Label = "待机形态 (标准立绘)" },
        @{ Key = "think"; Label = "思考形态 (托腮沉思)" },
        @{ Key = "work";  Label = "工作形态 (认真干活)" },
        @{ Key = "sleep"; Label = "打盹形态 (呼呼大睡)" },
        @{ Key = "happy"; Label = "欢喜形态 (开怀笑颜)" }
    )

    $currentPose = if ($Config.Pose) { [string]$Config.Pose } else { "auto" }

    foreach ($p in $poses) {
        $pItem = New-Object System.Windows.Controls.MenuItem
        $pItem.Header = $p.Label
        $pItem.IsCheckable = $true
        $pItem.IsChecked = ($currentPose -eq $p.Key)
        $pk = $p.Key
        $pItem.Add_Click({
            $Config.Pose = $pk
            Save-Config
            if ($pk -eq "auto") {
                Set-PetSprite "idle"
            } else {
                Set-PetSprite $pk
            }
            Trigger-PetBounce
            Play-ReleaseSound
            foreach ($sub in $miPoseHeader.Items) {
                if ($sub -is [System.Windows.Controls.MenuItem]) {
                    $sub.IsChecked = ($sub -eq $pItem)
                }
            }
            Build-ContextMenu
        }.GetNewClosure())
        [void]$miPoseHeader.Items.Add($pItem)
    }
    [void]$cm.Items.Add($miPoseHeader)

    # 2. Quick Actions
    $miShowQuota = New-Object System.Windows.Controls.MenuItem
    $miShowQuota.Header = "查看并刷新 Codex 额度"
    $miShowQuota.Add_Click({
        Set-ActiveBubblePanel "quota"
        Request-QuotaRefresh
        Show-Bubble 14.0
    })
    [void]$cm.Items.Add($miShowQuota)

    $miShowDeepSeek = New-Object System.Windows.Controls.MenuItem
    $miShowDeepSeek.Header = "查看并刷新 DeepSeek 余额"
    $miShowDeepSeek.Add_Click({
        Set-ActiveBubblePanel "deepseek"
        Request-BalanceRefresh
        Show-Bubble 14.0
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
            if (-not $script:agentBusy) {
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
        }.GetNewClosure())
        [void]$miBubbleDefault.Items.Add($bOptItem)
    }
    [void]$cm.Items.Add($miBubbleDefault)

    [void]$cm.Items.Add((New-Object System.Windows.Controls.Separator))

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

    $scaleSlider.Add_ValueChanged({
        $v = [Math]::Round($scaleSlider.Value, 2)
        $Config.Scale = $v
        $scaleValTxt.Text = "$([int][Math]::Round($v * 100))%"
        $miScale.Header = "立绘缩放比例 ($([int][Math]::Round($v * 100))%)"
        Update-Scale
        Update-BubbleScale
        Update-Facing
    }.GetNewClosure())
    $scaleSlider.Add_PreviewMouseLeftButtonUp({ Save-Config })
    $scaleSlider.Add_LostMouseCapture({ Save-Config })

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
        $val = $sp
        $spItem.Add_Click({
            $Config.Scale = $val
            Save-Config
            Update-Scale
            Update-BubbleScale
            Update-Facing
            Build-ContextMenu
        }.GetNewClosure())
        [void]$miScale.Items.Add($spItem)
    }
    [void]$cm.Items.Add($miScale)

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
        $bVal = $bp.Val
        $bItem.Add_Click({
            $Config.BubbleScale = [Math]::Max(0.8, [Math]::Min(1.3, [double]$bVal))
            Save-Config
            Update-BubbleScale
            Show-Bubble -HoldSeconds 5.5 -Force
            Build-ContextMenu
        }.GetNewClosure())
        [void]$miBubbleScale.Items.Add($bItem)
    }
    [void]$cm.Items.Add($miBubbleScale)


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
        $fVal = $fp.Val
        $fItem.Add_Click({
            $Config.FontScale = $fVal
            Save-Config
            Update-FontScale
            Show-Bubble -HoldSeconds 5.5 -Force
            Build-ContextMenu
        }.GetNewClosure())
        [void]$miFont.Items.Add($fItem)
    }
    [void]$cm.Items.Add($miFont)

    # 5. Sound & Volume Slider
    $miSound = New-Object System.Windows.Controls.MenuItem
    $miSound.Header = "Q 弹音效与音量"

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

    $volSlider.Add_ValueChanged({
        $v = [int][Math]::Round($volSlider.Value)
        $Config.SoundVolume = $v
        $volTxt.Text = "$([int][Math]::Round($v / 10))%"
    }.GetNewClosure())
    $volSlider.Add_PreviewMouseLeftButtonUp({ Save-Config })
    $volSlider.Add_LostMouseCapture({ Save-Config })

    [void]$volPanel.Children.Add($volSlider)
    [void]$volPanel.Children.Add($volTxt)
    $miVolSliderItem = New-Object System.Windows.Controls.MenuItem
    $miVolSliderItem.Header = $volPanel
    $miVolSliderItem.StaysOpenOnClick = $true
    [void]$miSound.Items.Add($miVolSliderItem)
    [void]$cm.Items.Add($miSound)

    # 6. Auto-Quotes (定时碎碎念)
    $miAutoQuote = New-Object System.Windows.Controls.MenuItem
    $miAutoQuote.Header = "定时碎碎念 (自动冒泡)"
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
        $aqVal = $aq.Val
        $aqItem.Add_Click({
            $Config.AutoQuoteMinutes = $aqVal
            Save-Config
            $script:lastAutoQuoteTime = [DateTime]::UtcNow
            Build-ContextMenu
        }.GetNewClosure())
        [void]$miAutoQuote.Items.Add($aqItem)
    }
    [void]$cm.Items.Add($miAutoQuote)

    # 7. Sleep Timeout
    $miSleep = New-Object System.Windows.Controls.MenuItem
    $miSleep.Header = "空闲打盹时间"
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
        $sVal = $slp.Val
        $sItem.Add_Click({
            $Config.SleepSeconds = $sVal
            Save-Config
            $script:lastInteractTime = [DateTime]::UtcNow
            Build-ContextMenu
        }.GetNewClosure())
        [void]$miSleep.Items.Add($sItem)
    }
    [void]$cm.Items.Add($miSleep)

    [void]$cm.Items.Add((New-Object System.Windows.Controls.Separator))

    $miBroadcast = New-Object System.Windows.Controls.MenuItem
    $nowUtcMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $pauseUntil = if ($null -ne $Config.PauseMonitorUntil) { [long]$Config.PauseMonitorUntil } else { 0 }
    $remMin = if ($pauseUntil -gt $nowUtcMs) { [int][Math]::Ceiling(($pauseUntil - $nowUtcMs) / 60000.0) } else { 0 }
    $miBroadcast.Header = if ($remMin -gt 0) { "状态播报（暂停中，剩余 $remMin 分钟）" } else { "状态播报（播报中）" }
    $b10 = New-Object System.Windows.Controls.MenuItem; $b10.Header = "暂停播报 10 分钟"
    $b10.Add_Click({ $Config.PauseMonitorUntil = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 600000; Save-Config; Build-ContextMenu }.GetNewClosure())
    [void]$miBroadcast.Items.Add($b10)
    $b30 = New-Object System.Windows.Controls.MenuItem; $b30.Header = "暂停播报 30 分钟"
    $b30.Add_Click({ $Config.PauseMonitorUntil = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 1800000; Save-Config; Build-ContextMenu }.GetNewClosure())
    [void]$miBroadcast.Items.Add($b30)
    $bResume = New-Object System.Windows.Controls.MenuItem; $bResume.Header = "立即恢复播报"
    $bResume.Add_Click({ $Config.PauseMonitorUntil = 0; Save-Config; Build-ContextMenu }.GetNewClosure())
    [void]$miBroadcast.Items.Add($bResume)
    [void]$cm.Items.Add($miBroadcast)

    # 8. Topmost & Reset Position
    $miTop = New-Object System.Windows.Controls.MenuItem
    $miTop.Header = "窗口始终置顶"
    $miTop.IsCheckable = $true
    $miTop.IsChecked = [bool]$Config.Topmost
    $miTop.Add_Click({
        $Config.Topmost = -not $Config.Topmost
        $Window.Topmost = [bool]$Config.Topmost
        Save-Config
        Build-ContextMenu
    })
    [void]$cm.Items.Add($miTop)

    $miResetPos = New-Object System.Windows.Controls.MenuItem
    $miResetPos.Header = "重置位置到屏幕右下角"
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
    $miAbout = New-Object System.Windows.Controls.MenuItem
    $miAbout.Header = "AgentPet v$script:AppVersion"
    $miAbout.IsEnabled = $false
    [void]$cm.Items.Add($miAbout)

    $miExit = New-Object System.Windows.Controls.MenuItem
    $miExit.Header = "退出 AgentPet"
    $miExit.Foreground = $BrushConv.ConvertFromString("#FFD9383A")
    $miExit.FontWeight = "SemiBold"
    $miExit.Add_Click({
        $Window.Close()
    })
    [void]$cm.Items.Add($miExit)

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
        Trigger-PetBounce
        Play-ReleaseSound
        $script:happyUntil = [DateTime]::UtcNow.AddSeconds(1.8)
        $defMode = if ($Config.BubbleMode -in @("quota","deepseek","quote")) { $Config.BubbleMode } else { "quota" }
        if ($script:agentBusy) {
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
        Request-BalanceRefresh
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
        Request-QuotaRefresh
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
        if ($script:agentBusy) { $script:agentBusy = $false; $script:lastAgentState = $null; $script:waitingLastAlert = $null; Set-PetSprite "idle"; Set-ActiveBubblePanel $Config.BubbleMode; Hide-Bubble }
        return
    }
    $state = [string]$stObj.state
    if (-not $state -or $state -eq "idle") {
        if ($script:agentBusy) {
            $script:agentBusy = $false
            $script:lastInteractTime = [DateTime]::UtcNow
            $script:lastAgentState = $null
            $script:waitingLastAlert = $null
            Set-PetSprite "idle"
            Set-ActiveBubblePanel $Config.BubbleMode
            Hide-Bubble
        }
        return
    }

    # Freshness check (P0 & Issue 9):
    # Waiting states allow up to 60s without heartbeat update. Active states allow up to 35s.
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $atMs = if ($stObj.at) { [double]$stObj.at } else { $nowMs }
    $ageSec = ($nowMs - $atMs) / 1000.0
    $maxAgeSec = if ($state -in @("waiting", "approval", "stalled")) { 300.0 } else { 35.0 }
    if ($ageSec -gt $maxAgeSec) {
        if ($script:agentBusy) {
            $script:agentBusy = $false
            $script:lastInteractTime = [DateTime]::UtcNow
            $script:lastAgentState = $null
            $script:waitingLastAlert = $null
            Set-PetSprite "idle"
            Set-ActiveBubblePanel $Config.BubbleMode
            Hide-Bubble
        }
        return
    }

    $script:agentBusy = $true
    $script:lastInteractTime = [DateTime]::UtcNow

    # 1. State Header Text: prioritize dynamic stateText from agent-monitor (Issue 3)
    $hdr = if ($stObj.stateText) {
        [string]$stObj.stateText
    } elseif ($stObj.header) {
        [string]$stObj.header
    } else {
        switch ($state) {
            "thinking" { "思考中..." }
            "working"  { "工作中..." }
            "calling"  { "调用工具中..." }
            "waiting"  { "等待指示..." }
            "approval" { "等待用户确认..." }
            "stalled"  { "好像卡住了，我再等等..." }
            "result"   { "处理结果中..." }
            "success"  { "任务已完成！" }
            "done"     { "任务已完成！" }
            "error"    { "遇到异常..." }
            default    { "正在处理..." }
        }
    }
    $WorkHeader.Text = $hdr

    $stateColor = switch ($state) {
        "thinking" { "#FF6B8AFD" } "working" { "#FF2F6BFF" } "calling" { "#FF2F6BFF" }
        "waiting" { "#FFFF9800" } "approval" { "#FFFF9800" } "stalled" { "#FFFF9800" }
        "result" { "#FF8B5CF6" } "success" { "#FF10B981" } "done" { "#FF10B981" }
        "error" { "#FFEF4444" } default { "#FFCE6018" }
    }
    try {
        $stateBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString($stateColor)
        $WorkDot.Fill = $stateBrush
        $WorkHeader.Foreground = $stateBrush
        $BubbleBorder.BorderBrush = $stateBrush
        $BubbleBorder.BorderThickness = if ($state -in @("waiting", "approval", "stalled")) { [System.Windows.Thickness]::new(3.4) } elseif ($state -eq "error") { [System.Windows.Thickness]::new(3.2) } else { [System.Windows.Thickness]::new(2.8) }
        if ($state -in @("waiting", "approval")) { $WorkHeader.Text = "⚠ 等待确认 · " + $hdr }
        elseif ($state -eq "stalled") { $WorkHeader.Text = "⚠ 好像卡住了 · " + $hdr }
    } catch {}

    # 2. Agent Source Badge & Icon
    $rawSource = if ($stObj.source) { [string]$stObj.source } else { "Antigravity" }
    $agentKey = switch -Wildcard ($rawSource.ToLower()) {
        "*antigravity*" { "antigravity" }
        "*反重力*"     { "antigravity" }
        "*dsh*"         { "dsh" }
        "*deepseek*"    { "dsh" }
        "*codex*"       { "codex" }
        "*claude*"      { "claude" }
        "*gemini*"      { "gemini" }
        default         { "antigravity" }
    }

    switch ($agentKey) {
        "antigravity" {
            $WorkSource.Text = "Antigravity"
            $WorkSource.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FF1D4ED8")
            $WorkSourceBadge.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FFEFF6FF")
            $WorkSourceBadge.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FFBFDBFE")
        }
        "dsh" {
            $WorkSource.Text = "DSH"
            $WorkSource.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FF026AA7")
            $WorkSourceBadge.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FFE8F4FD")
            $WorkSourceBadge.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FFB3DDF2")
        }
        "codex" {
            $WorkSource.Text = "Codex"
            $WorkSource.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FF0A8264")
            $WorkSourceBadge.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FFEBF8F3")
            $WorkSourceBadge.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FFAFE1CD")
        }
        default {
            $WorkSource.Text = $rawSource
            $WorkSource.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FFA65518")
            $WorkSourceBadge.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FFF6E8DC")
            $WorkSourceBadge.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString("#FFE5C2A8")
        }
    }

    if ($WorkSourceIcon) {
        if ($script:AgentIcons.ContainsKey($agentKey)) {
            $WorkSourceIcon.Source = $script:AgentIcons[$agentKey]
            $WorkSourceIcon.Visibility = [System.Windows.Visibility]::Visible
        } else {
            $WorkSourceIcon.Visibility = [System.Windows.Visibility]::Collapsed
        }
    }

    # Multi-Agent status overview & Co-op indicator (P2-4: normalized keys & active check)
    $taskText = if ($stObj.task) { [string]$stObj.task } else { "正在执行步骤..." }
    $primarySub = if ($stObj.agents -and $agentKey) { $stObj.agents.$agentKey } else { $null }
    $sessionCount = if ($primarySub -and $primarySub.sessionCount) { [int]$primarySub.sessionCount } else { 0 }
    if ($sessionCount -gt 1) { $taskText = "×$sessionCount " + $taskText }
    if ($stObj.activeCount -gt 1 -and $stObj.agents) {
        $otherActive = @()
        $activeWorkStates = @("working", "thinking", "waiting", "approval", "stalled")
        foreach ($k in @("antigravity", "codex", "dsh")) {
            if ($k -eq $agentKey) { continue }
            $sub = $stObj.agents.$k
            if ($sub -and $sub.state -and ($activeWorkStates -contains [string]$sub.state)) {
                $name = switch ($k) {
                    "antigravity" { "Antigravity" }
                    "codex"       { "Codex" }
                    "dsh"         { "DSH" }
                    default       { $k }
                }
                $otherActive += $name
            }
        }
        if ($otherActive.Count -gt 0) {
            $taskText = "[$($otherActive -join ', ') 并行协作中] " + $taskText
        }
    }
    $WorkTask.Text = $taskText

    # Tooltip on WorkSourceBadge showing dynamic Agent overview
    if ($stObj.agents -and $WorkSourceBadge) {
        $agDesc = if ($stObj.agents.antigravity) { "$($stObj.agents.antigravity.state)" } else { "空闲" }
        $cxDesc = if ($stObj.agents.codex) { "$($stObj.agents.codex.state)" } else { "空闲" }
        $dsDesc = if ($stObj.agents.dsh) { "$($stObj.agents.dsh.state)" } else { "空闲" }
        if ($stObj.agents.antigravity -and $stObj.agents.antigravity.sessionCount -gt 1) { $agDesc += " ($($stObj.agents.antigravity.sessionCount) 个会话)" }
        if ($stObj.agents.codex -and $stObj.agents.codex.sessionCount -gt 1) { $cxDesc += " ($($stObj.agents.codex.sessionCount) 个会话)" }
        if ($stObj.agents.dsh -and $stObj.agents.dsh.sessionCount -gt 1) { $dsDesc += " ($($stObj.agents.dsh.sessionCount) 个会话)" }
        $WorkSourceBadge.ToolTip = "【Agent 实时看板】`nAntigravity: $agDesc`nCodex: $cxDesc`nDSH: $dsDesc"
    }

    # P1-2: Do not override user inspection of quota panel unless agent enters waiting/approval state
    $now = [DateTime]::UtcNow
    $isUserInspecting = ($script:userInspectUntil -and $now -lt $script:userInspectUntil)
    $isWaiting = ($state -eq "waiting" -or $state -eq "approval")

    if ((-not $script:manualBubbleHidden -and (-not $isUserInspecting)) -or $isWaiting) {
        Set-ActiveBubblePanel "work"
        Show-Bubble 0
    }

    # WO-06: waiting or approval state transition alert (bounce + chime)
    if ($isWaiting) {
        if ($script:lastAgentState -ne $state) {
            Set-ActiveBubblePanel "work"
            Show-Bubble 0 -Force
            Trigger-PetBounce
            Play-ApproveSound
        }
        if (-not $script:waitingLastAlert -or ([DateTime]::UtcNow - $script:waitingLastAlert).TotalSeconds -ge 60) {
            $script:waitingLastAlert = [DateTime]::UtcNow
            Set-ActiveBubblePanel "work"
            Show-Bubble 0 -Force
            if ($script:lastAgentState -eq $state) { Trigger-PetBounce; Play-ApproveSound }
        }
    } else {
        $script:waitingLastAlert = $null
    }
    $script:lastAgentState = $state
    $script:lastStatusHeartbeatMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    # WO-01: Complete pose mapping (success/done -> happy, waiting/approval/result/thinking -> think)
    $spriteState = switch ($state) {
        "thinking" { "think" }
        "waiting"  { "think" }
        "approval" { "think" }
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

    # 3. Watch runtime-balance.json file modification
    if (Test-Path $RuntimeBalancePath) {
        try {
            $item = Get-Item $RuntimeBalancePath -ErrorAction SilentlyContinue
            if ($item -and $item.LastWriteTimeUtc -gt $script:lastBalanceMtime) {
                $raw = Get-Content $RuntimeBalancePath -Raw -Encoding UTF8 -ErrorAction Stop
                $b = $raw | ConvertFrom-Json -ErrorAction Stop
                if ($b) {
                    $script:lastBalanceMtime = $item.LastWriteTimeUtc
                    $script:lastBalanceObject = $b
                    Apply-BalanceObject $b
                }
            }
        } catch {
            Log-Throttled "BalanceRead" "Failed to parse runtime-balance.json: $($_.Exception.Message)"
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
    if (-not $el -or $el.Visibility -ne [System.Windows.Visibility]::Visible -or $el.Opacity -lt 0.08) {
        return $false
    }
    try {
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

$Window.Add_SourceInitialized({
    try {
        $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($Window)).Handle
        [AgentPetNative]::ApplyToolWindowStyle($hwnd)
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

                        if ((Test-ElementHit $Bubble $screenPt) -or
                            (Test-ElementHit $Tail $screenPt) -or
                            (Test-ElementHit $TailNear $screenPt) -or
                            (Test-PetOpaqueHit $screenPt)) {
                            $handled.Value = $true
                            return [IntPtr][AgentPetNative]::HTCLIENT
                        }
                        $handled.Value = $true
                        return [IntPtr][AgentPetNative]::HTTRANSPARENT
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
        $Window.Topmost = $true
        $Window.Activate()
        Trigger-PetBounce
        Play-ReleaseSound
        $script:happyUntil = [DateTime]::UtcNow.AddSeconds(2.0)
        Set-PetSprite "happy"
        $QuoteText.Text = "主人，我一直都在这里陪着您呢~"
        Set-ActiveBubblePanel "quote"
        Show-Bubble 4.0
    }

    # 0.5 Safety revert for balance refresh notice
    if ($script:balanceRequestTimeout -and $now -gt $script:balanceRequestTimeout) {
        $script:balanceRequestTimeout = $null
        if ($DeepSeekStatusNotice -and $DeepSeekStatusNotice.Text -eq "刷新中...") {
            $DeepSeekStatusNotice.Text = "已是最新"
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
                $script:agentBusy = $false
                $script:lastInteractTime = [DateTime]::UtcNow
                Set-PetSprite "idle"
                Set-ActiveBubblePanel $Config.BubbleMode
                Hide-Bubble
            }
        }
    }

    # 2. Keep bubble open while user is hovering over it
    if ($script:isBubbleOpen -and (-not $script:agentBusy)) {
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

$Window.Add_Closed({
    try { $Timer.Stop() } catch {}
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

