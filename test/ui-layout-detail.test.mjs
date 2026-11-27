// test/ui-layout-detail.test.mjs —— 独立隔离的 WPF 气泡自适应排版与反重力详情窗裁切回归测试
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');

function runWpfLayoutAndDetailSuite() {
  const ps1Path = path.join(repoRoot, 'AgentPet.ps1');
  const xamlPath = path.join(repoRoot, 'AgentPet.xaml');
  const assetsSrc = path.join(repoRoot, 'assets');

  const psBytes = fs.readFileSync(ps1Path);
  assert.equal(psBytes.subarray(0, 3).toString('hex'), 'efbbbf', 'Windows PowerShell needs the script BOM');
  let ps1Source = psBytes.subarray(3).toString('utf8');
  assert.ok(ps1Source.includes('"Local\\AgentPet_SingleInstance_Mutex'), 'expected mutex declaration in AgentPet.ps1');
  assert.ok(ps1Source.includes('function Start-AgentMonitor {'), 'expected Start-AgentMonitor in AgentPet.ps1');
  assert.ok(ps1Source.includes('$Window.Add_Loaded({'), 'expected $Window.Add_Loaded in AgentPet.ps1');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpet-ui-layout-'));
  const assetsJunction = path.join(tmpRoot, 'assets');

  try {
    const mk = spawnSync('cmd.exe', ['/c', 'mklink', '/J', assetsJunction, assetsSrc], { encoding: 'utf8' });
    assert.equal(mk.status, 0, `mklink /J failed: ${mk.stderr || mk.stdout}`);

    fs.copyFileSync(xamlPath, path.join(tmpRoot, 'AgentPet.xaml'));
    fs.writeFileSync(
      path.join(tmpRoot, 'config.json'),
      JSON.stringify({
        BubbleMode: 'quota',
        Scale: 1.0,
        BubbleScale: 1.0,
        FontScale: 1.0,
        Facing: 'right',
        Theme: 'light',
        StartHidden: false,
        Topmost: false,
        DeepSeekBalanceEnabled: false,
        AutoQuoteMinutes: 0,
        SleepSeconds: 9999,
        Left: 700,
        Top: 420
      }, null, 2),
      'utf8'
    );

    const uniqueMutex = `Local\\AgentPet_UITest_${process.pid}_${Date.now()}`;
    ps1Source = ps1Source.replaceAll('Local\\AgentPet_SingleInstance_Mutex', uniqueMutex);

    const cutIdx = ps1Source.indexOf('$Window.Add_Loaded({');
    assert.ok(cutIdx > 0, 'failed to locate $Window.Add_Loaded cutoff');
    ps1Source = ps1Source.slice(0, cutIdx);

    const initMarker = '# Initial Window Setup';
    assert.ok(ps1Source.includes(initMarker), 'expected # Initial Window Setup marker');
    ps1Source = ps1Source.replace(
      initMarker,
      [
        'function Read-InitialQuotaSnapshot {}',
        'function Read-InitialBalanceSnapshot {}',
        'function Start-AgentMonitor {}',
        'function Request-QuotaRefresh {}',
        'function Request-BalanceRefresh([switch]$Silent) {}',
        'function Save-Config {}',
        'function Play-ApproveSound {}',
        'function Play-PressSound {}',
        'function Play-ReleaseSound {}',
        'function Set-WaitingWindowAttention([bool]$Active) {}',
        'function Get-AgentPetCursorScreenPosition { return $script:MockCursorScreenPt }',
        initMarker
      ].join('\n')
    );

    const harnessPath = path.join(tmpRoot, 'AgentPetHarness.ps1');
    fs.writeFileSync(harnessPath, '\uFEFF' + ps1Source, 'utf8');

    const driverPath = path.join(tmpRoot, 'run_suite.ps1');
    const driverScript = `
$ErrorActionPreference = 'Stop'

# 1. Static AST & XAML parse check on repository source files
$parseErrors = $null
$tokens = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(ps1Path)}, [ref]$tokens, [ref]$parseErrors)
$astErrorCount = if ($parseErrors) { $parseErrors.Count } else { 0 }

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, System.Drawing

[xml]$mainXamlXml = Get-Content -Path ${JSON.stringify(xamlPath)} -Encoding UTF8
$mainXamlParsed = ($null -ne $mainXamlXml.Window)

$Global:PSScriptRoot = ${JSON.stringify(tmpRoot)}
$script:MockCursorScreenPt = New-Object System.Windows.Point(0, 0)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DetailWin32Probe {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
}
"@

. ${JSON.stringify(harnessPath)}

# Override side-effecting helpers cleanly after dot-sourcing production definitions
function global:Start-AgentMonitor {}
function global:Request-QuotaRefresh {}
function global:Request-BalanceRefresh([switch]$Silent) {}
function global:Save-Config {}
function global:Get-AgentPetCursorScreenPosition { return $script:MockCursorScreenPt }

function Pump-Wpf {
    param([int]$Ms = 0)
    if ($Ms -gt 0) {
        [System.Threading.Thread]::Sleep($Ms)
    }
    $frame = New-Object System.Windows.Threading.DispatcherFrame
    $Window.Dispatcher.BeginInvoke(
        [System.Windows.Threading.DispatcherPriority]::ApplicationIdle,
        [Action]{ $frame.Continue = $false }
    ) | Out-Null
    [System.Windows.Threading.Dispatcher]::PushFrame($frame)
    $Window.UpdateLayout()
    if ($script:DetailWindow -and $script:DetailWindow.IsVisible) {
        $script:DetailWindow.UpdateLayout()
    }
}

function Get-TextLineCount([System.Windows.Controls.TextBlock]$tb) {
    $tb.UpdateLayout()
    $lineProp = [System.Windows.Controls.TextBlock].GetProperty('LineCount', [System.Reflection.BindingFlags]'Instance,NonPublic,Public')
    if ($lineProp) { return [int]$lineProp.GetValue($tb, $null) }
    $lh = if ($tb.LineHeight -gt 0 -and (-not [double]::IsNaN($tb.LineHeight))) { $tb.LineHeight } else { $tb.FontSize * 1.35 }
    return [int][Math]::Max(1, [Math]::Round($tb.ActualHeight / $lh))
}

function Safe-Round([double]$v, [int]$digits = 2) {
    if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { return $null }
    return [Math]::Round($v, $digits)
}

function Get-DetailMetrics {
    $hwnd = [IntPtr]::Zero
    $cW = -1; $cH = -1; $dpiX = 1.0; $dpiY = 1.0
    if ($script:DetailWindow) {
        $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($script:DetailWindow)).Handle
        $src = [System.Windows.PresentationSource]::FromVisual($script:DetailWindow)
        if ($src -and $src.CompositionTarget) {
            $dpiX = [double]$src.CompositionTarget.TransformToDevice.M11
            $dpiY = [double]$src.CompositionTarget.TransformToDevice.M22
        }
        if ($hwnd -ne [IntPtr]::Zero) {
            $rect = New-Object DetailWin32Probe+RECT
            if ([DetailWin32Probe]::GetClientRect($hwnd, [ref]$rect)) {
                $cW = $rect.Right - $rect.Left
                $cH = $rect.Bottom - $rect.Top
            }
        }
    }
    $svH = if ($script:DetailScrollViewer) { [double]$script:DetailScrollViewer.ScrollableHeight } else { 0.0 }
    $svMaxH = if ($script:DetailScrollViewer) { [double]$script:DetailScrollViewer.MaxHeight } else { 0.0 }
    $svOff = if ($script:DetailScrollViewer) { [double]$script:DetailScrollViewer.VerticalOffset } else { 0.0 }
    return [ordered]@{
        visible          = [bool]($script:DetailWindow -and $script:DetailWindow.IsVisible)
        showActivated    = if ($script:DetailWindow) { [bool]$script:DetailWindow.ShowActivated } else { $true }
        winW             = if ($script:DetailWindow) { Safe-Round $script:DetailWindow.ActualWidth } else { 0.0 }
        winH             = if ($script:DetailWindow) { Safe-Round $script:DetailWindow.ActualHeight } else { 0.0 }
        top              = if ($script:DetailWindow) { Safe-Round $script:DetailWindow.Top } else { $null }
        clientPxW        = $cW
        clientPxH        = $cH
        dpiX             = Safe-Round $dpiX 3
        dpiY             = Safe-Round $dpiY 3
        scrollableH      = Safe-Round $svH
        scrollMaxH       = Safe-Round $svMaxH
        scrollOffset     = Safe-Round $svOff
        detailTask       = if ($script:DetailTask) { [string]$script:DetailTask.Text } else { '' }
    }
}

function Get-VisualElementCenterScreenPt([System.Windows.FrameworkElement]$el) {
    $pt = $el.PointToScreen((New-Object System.Windows.Point(($el.ActualWidth * 0.5), ($el.ActualHeight * 0.5))))
    return $pt
}

function Invoke-DeterministicHoverCheck {
    param(
        [System.Windows.FrameworkElement]$targetEl,
        [bool]$expectOpen,
        [int]$maxWaitMs = 1500
    )
    Close-HoverDetailCard
    if ($Bubble.Visibility -ne [System.Windows.Visibility]::Visible) {
        Show-Bubble 0 -Force
    }
    $Bubble.Visibility = [System.Windows.Visibility]::Visible
    $Bubble.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
    $Bubble.Opacity = 1.0
    Pump-Wpf

    $elapsed = 0
    $stepMs = 25
    while ($elapsed -lt $maxWaitMs) {
        $script:MockCursorScreenPt = Get-VisualElementCenterScreenPt $targetEl
        Update-DetailHoverState
        Pump-Wpf $stepMs
        $elapsed += $stepMs
        if ($expectOpen -and $script:DetailWindow -and $script:DetailWindow.IsVisible) {
            Pump-Wpf
            break
        }
        if ((-not $expectOpen) -and $elapsed -ge 260) {
            break
        }
    }

    $metrics = Get-DetailMetrics
    $curPt = $script:MockCursorScreenPt
    $inSrcNow = (Test-ElementHit $WorkSourcesPanel $curPt) -or (Test-ElementHit $WorkSourceBadge $curPt)
    $inTrigNow = (-not $inSrcNow) -and ((Test-ElementHit $WorkHeaderBanner $curPt) -or (Test-ElementHit $WorkHeaderRow $curPt) -or (Test-ElementHit $WorkTask $curPt))
    $metrics['bubbleOpacity'] = Safe-Round $Bubble.Opacity
    $metrics['headerVisible'] = [bool]$WorkHeader.IsVisible
    $metrics['targetHit'] = (Test-ElementHit $targetEl $curPt)
    $metrics['inTrigger'] = $inTrigNow
    $metrics['triggerEnterSet'] = ($script:detailTriggerEnterAt -ne [DateTime]::MinValue)
    $metrics['elapsedMs'] = $elapsed
    return $metrics
}

function Set-WorkPayload([string]$source, [string]$task, [string]$state = 'working', [int]$workingCount = 1, [string[]]$sources = $null, [string]$taskDetail = $null, [string]$stateText = '') {
    $srcList = if ($sources) { $sources } else { @($source) }
    $detail = if ($null -ne $taskDetail) { $taskDetail } else { $task }
    $resolvedStateText = $stateText
    $agObj = $null; $dshObj = $null; $codexObj = $null
    foreach ($s in $srcList) {
        $entry = [PSCustomObject]@{
            source       = $s
            state        = $state
            task         = $task
            taskDetail   = $detail
            sessionCount = if ($s -eq $source) { $workingCount } else { 1 }
        }
        switch ($s.ToLowerInvariant()) {
            'antigravity' { $agObj = $entry }
            'dsh'         { $dshObj = $entry }
            'codex'       { $codexObj = $entry }
        }
    }
    $obj = [PSCustomObject]@{
        type         = 'work_status'
        state        = $state
        stateText    = $resolvedStateText
        source       = $source
        sessionCount = $workingCount
        activeCount  = $srcList.Count
        task         = $task
        taskDetail   = $detail
        agents       = [PSCustomObject]@{
            antigravity = $agObj
            dsh         = $dshObj
            codex       = $codexObj
        }
    }
    Apply-AgentStatus $obj
    Pump-Wpf
}

function Get-BadgeDisplayText {
    $parts = @()
    foreach ($c in $WorkSourceBadge.Child.Children) {
        if ($c -is [System.Windows.Controls.TextBlock] -and $c.Visibility -eq [System.Windows.Visibility]::Visible -and -not [string]::IsNullOrWhiteSpace($c.Text)) {
            $parts += $c.Text.Trim()
        }
    }
    return ($parts -join ' ')
}

try {
    $Window.ShowActivated = $false
    $Window.ShowInTaskbar = $false
    $Window.Show()
    Pump-Wpf

    # Ensure DetailWindow can build lazily and binds its internal layout grids
    $ensured = Ensure-DetailWindow
    Pump-Wpf
    $startupDefaultHoverEnabled = [bool]$Config.HoverDetailsEnabled
    $defaultConfigHoverVal = [bool]$DefaultConfig.HoverDetailsEnabled
    Set-HoverDetailsEnabled $true
    Pump-Wpf

    # --- Case 1: Single Antigravity short (<= 1 line) ---
    Set-WorkPayload -source 'Antigravity' -task '正在检查配置与端口映射' -workingCount 1 -sources @('Antigravity')
    $badgeIconImg = $WorkSourceBadge.Child.Children[0]
    $agShort = [ordered]@{
        headerText      = [string]$WorkHeader.Text
        inlineVis       = [string]$WorkInlineSourceHost.Visibility
        sourcesPanelVis = [string]$WorkSourcesPanel.Visibility
        badgeParentName = if ($WorkSourceBadge.Parent) { [string]$WorkSourceBadge.Parent.Name } else { '' }
        badgeText       = (Get-BadgeDisplayText)
        iconVisible     = ($badgeIconImg.Visibility -eq [System.Windows.Visibility]::Visible -and $null -ne $badgeIconImg.Source -and $badgeIconImg.ActualWidth -gt 0)
        groupVAlign     = [string]$WorkContentGroup.VerticalAlignment
        lineCount       = (Get-TextLineCount $WorkTask)
    }

    # --- Case 2: Single Codex x12 inline ---
    Set-WorkPayload -source 'Codex' -task "第一行短摘要内容\`n第二行短摘要内容" -workingCount 12 -sources @('Codex')
    $codexX12TwoLines = [ordered]@{
        headerText      = [string]$WorkHeader.Text
        inlineVis       = [string]$WorkInlineSourceHost.Visibility
        sourcesPanelVis = [string]$WorkSourcesPanel.Visibility
        badgeText       = (Get-BadgeDisplayText)
        iconVisible     = ($WorkSourceBadge.Child.Children[0].Visibility -eq [System.Windows.Visibility]::Visible -and $null -ne $WorkSourceBadge.Child.Children[0].Source)
        groupVAlign     = [string]$WorkContentGroup.VerticalAlignment
        lineCount       = (Get-TextLineCount $WorkTask)
    }

    # --- Case 3: Single DSH x5 ---
    Set-WorkPayload -source 'DSH' -task '读取余额快照' -workingCount 5 -sources @('DSH')
    $dshInline = [ordered]@{
        inlineVis  = [string]$WorkInlineSourceHost.Visibility
        badgeText  = (Get-BadgeDisplayText)
        iconLoaded = ($WorkSourceBadge.Child.Children[0].Visibility -eq [System.Windows.Visibility]::Visible -and $null -ne $WorkSourceBadge.Child.Children[0].Source)
    }

    # --- Case 4: Single Antigravity x12 (4-char header '等待确认') at FontScale=1.4 wraps cleanly + long body switches to Top ---
    $Config.BubbleScale = 1.0
    Update-BubbleScale
    $Config.FontScale = 1.4
    Update-FontScale
    $veryLongTask = '正在详细核对桌面气泡工作状态的单双来源自适应排版、高缩放换行回落、居中与顶对齐切换逻辑，以及反重力悬停详情窗在不同长度正文切换下的真实 Win32 客户区尺寸同步，确认长文本在触发截断或者超过三行时切回顶部对齐并展示完整省略提示。'
    Set-WorkPayload -source 'Antigravity' -task $veryLongTask -state 'approval' -workingCount 12 -sources @('Antigravity')
    $agFs14WrapLong = [ordered]@{
        headerText      = [string]$WorkHeader.Text
        inlineVis       = [string]$WorkInlineSourceHost.Visibility
        sourcesPanelVis = [string]$WorkSourcesPanel.Visibility
        badgeParentName = if ($WorkSourceBadge.Parent) { [string]$WorkSourceBadge.Parent.Name } else { '' }
        badgeWidth      = Safe-Round $WorkSourceBadge.ActualWidth
        panelWidth      = Safe-Round $WorkSourcesPanel.ActualWidth
        groupVAlign     = [string]$WorkContentGroup.VerticalAlignment
        lineCount       = (Get-TextLineCount $WorkTask)
        taskMaxHeight   = Safe-Round $WorkTask.MaxHeight
        taskActualH     = Safe-Round $WorkTask.ActualHeight
    }

    # --- Case 5: Restore BubbleScale=1.0 & shrink FontScale 1.4 -> 0.8 recovery + multi-source pill reference reuse ---
    $Config.BubbleScale = 1.0
    Update-BubbleScale
    $Config.FontScale = 0.8
    Update-FontScale
    Set-WorkPayload -source 'Antigravity' -task '恢复小字号两来源联排校验' -workingCount 2 -sources @('Antigravity', 'Codex')
    $pillBefore = $WorkSourcesPanel.Children[1]
    $multiFs08 = [ordered]@{
        inlineVis      = [string]$WorkInlineSourceHost.Visibility
        sourcesPanelVis= [string]$WorkSourcesPanel.Visibility
        childCount     = $WorkSourcesPanel.Children.Count
        groupVAlign    = [string]$WorkContentGroup.VerticalAlignment
        recoveredCap   = Safe-Round $WorkTask.MaxHeight
    }
    # Identical heartbeat must reuse secondary pill instance cleanly
    Set-WorkPayload -source 'Antigravity' -task '恢复小字号两来源联排校验' -workingCount 2 -sources @('Antigravity', 'Codex')
    $pillAfter = $WorkSourcesPanel.Children[1]
    $pillRefReused = [object]::ReferenceEquals($pillBefore, $pillAfter)

    # Restore default FontScale=1.0 for Scheme 3 & DetailWindow checks
    $Config.FontScale = 1.0
    Update-FontScale
    $animStage = $Window.FindName('AnimationStage')

    function Get-BubbleStageSnapshot([string]$tag) {
        Pump-Wpf
        $cb = $BubbleBorder.TransformToAncestor($animStage).TransformBounds([System.Windows.Rect]::new(0, 0, [Math]::Max(1, $BubbleBorder.ActualWidth), [Math]::Max(1, $BubbleBorder.ActualHeight)))
        $tb = $Tail.TransformToAncestor($animStage).TransformBounds([System.Windows.Rect]::new(0, 0, [Math]::Max(1, $Tail.ActualWidth), [Math]::Max(1, $Tail.ActualHeight)))
        $nb = $TailNear.TransformToAncestor($animStage).TransformBounds([System.Windows.Rect]::new(0, 0, [Math]::Max(1, $TailNear.ActualWidth), [Math]::Max(1, $TailNear.ActualHeight)))
        $punched = $false
        $clip = $BubbleBorder.Clip
        if ($clip -and $script:currentBubblePanel -eq 'quota') {
            $line = $Window.FindName('QuotaTearLine')
            $seamX = $line.TranslatePoint([System.Windows.Point]::new(0, 0), $BubbleBorder).X
            $height = $BubbleBorder.ActualHeight
            $punched = (-not $clip.FillContains([System.Windows.Point]::new($seamX, 2))) -and
                       (-not $clip.FillContains([System.Windows.Point]::new($seamX, $height - 2))) -and
                       $clip.FillContains([System.Windows.Point]::new($seamX + 6, 2))
        }
        return [ordered]@{
            hasTicketClip   = ($null -ne $clip)
            punchedAtSeam   = $punched
            tag             = $tag
            panel           = [string]$script:currentBubblePanel
            bs              = [double]$Config.BubbleScale
            facing          = [double]$FacingScale.ScaleX
            declaredW       = Safe-Round $Bubble.Width
            borderDeclaredW = Safe-Round $BubbleBorder.Width
            bubbleW         = Safe-Round $Bubble.ActualWidth
            borderW         = Safe-Round $BubbleBorder.ActualWidth
            borderH         = Safe-Round $BubbleBorder.ActualHeight
            canvasLeft      = Safe-Round ([System.Windows.Controls.Canvas]::GetLeft($Bubble))
            canvasTop       = Safe-Round ([System.Windows.Controls.Canvas]::GetTop($Bubble))
            stageLeft       = Safe-Round $cb.Left
            stageTop        = Safe-Round $cb.Top
            stageRight      = Safe-Round $cb.Right
            stageBottom     = Safe-Round $cb.Bottom
            tailBottom      = Safe-Round ([Math]::Max($tb.Bottom, $nb.Bottom))
            tailRight       = Safe-Round ([Math]::Max($tb.Right, $nb.Right))
            borderThick     = Safe-Round $BubbleBorder.BorderThickness.Left
            bubbleBg        = [string]$BubbleBorder.Background
            headerGrad0     = [string]$WorkHeaderGradStop0.Color
            chipBg          = [string]$WorkStateChip.Background
            headerColor     = [string]$WorkHeader.Foreground
            dotFill         = [string]$WorkDot.Fill
            watermarkPath   = [string]$WorkBodyWatermark.Source.UriSource.LocalPath
            watermarkHit    = [bool]$WorkBodyWatermark.IsHitTestVisible
        }
    }

    # --- Case 8 (CH-01~03): Five character themes across work states, then panel reset ---
    $themeMatrix = @()
    foreach ($ch in @('claude', 'dragon', 'deepseek', 'zcode', 'gemini')) {
        $Config.Character = $ch
        Update-Theme
        foreach ($st in @('working', 'waiting', 'error', 'success', 'done')) {
            Set-WorkPayload -source 'Codex' -task '多角色配色与状态边框核验' -state $st -workingCount 2 -sources @('Codex', 'Antigravity')
            $snap = Get-BubbleStageSnapshot "$ch/$st"
            $snap.borderBrush = [string]$BubbleBorder.BorderBrush
            $snap.tailBrush = [string]$Tail.BorderBrush
            $snap.tailNearBrush = [string]$TailNear.BorderBrush
            $snap.shadowColor = [string]$BubbleShadow.Color
            $snap.headerGrad1 = [string]$WorkHeaderGradStop1.Color
            $snap.headerDivider = [string]$WorkHeaderBanner.BorderBrush
            $snap.headerText = $WorkHeader.Text
            $snap.spriteKey = $script:CurrentSpriteKey
            $snap.bannerCornerTL = Safe-Round $WorkHeaderBanner.CornerRadius.TopLeft 1
            $snap.cardCornerTL = Safe-Round $BubbleBorder.CornerRadius.TopLeft 1
            $snap.codexFg = [string](Get-AgentSourceStyle 'codex').Foreground
            $snap.codexPillBg = [string](Get-AgentSourceStyle 'codex').Background
            $snap.codexDetailBg = [string](Get-AgentSourceStyle 'codex').DetailBackground
            $themeMatrix += $snap
        }
    }
    Set-WorkPayload -source 'Codex' -task '错误气泡切换余额面板' -state 'error'
    Set-ActiveBubblePanel 'deepseek'
    $dsAfterError = Get-BubbleStageSnapshot 'deepseek-after-work'
    $dsAfterError.borderBrush = [string]$BubbleBorder.BorderBrush
    $dsAfterError.deepSeekTotalFg = [string]$DeepSeekTotalText.Foreground

    # Restore Claude right-facing baseline before geometry transition matrix
    $Config.Character = 'claude'
    Update-Theme
    $FacingScale.ScaleX = 1.0
    $TextFacingScale.ScaleX = 1.0

    # --- Case 9 (CH-04 / R2): 254<->264 width, Canvas.Left, StageBottom=177.0 across work<->quota/deepseek/quote x BubbleScale x FacingScale ---
    $geomTransitions = @()
    foreach ($fc in @(1.0, -1.0)) {
        $FacingScale.ScaleX = $fc
        $TextFacingScale.ScaleX = $fc
        foreach ($bs in @(0.8, 1.0, 1.3)) {
            $Config.BubbleScale = $bs
            Update-BubbleScale
            Set-WorkPayload -source 'Antigravity' -task '短工作气泡锚点校验' -state 'working' -workingCount 1 -sources @('Antigravity')
            $geomTransitions += Get-BubbleStageSnapshot "work-short@$bs/f$fc"

            Set-WorkPayload -source 'Antigravity' -task $veryLongTask -state 'waiting' -workingCount 2 -sources @('Antigravity', 'Codex')
            $geomTransitions += Get-BubbleStageSnapshot "work-long@$bs/f$fc"

            foreach ($np in @('quota', 'deepseek', 'quote')) {
                Set-ActiveBubblePanel $np
                $geomTransitions += Get-BubbleStageSnapshot "$np@$bs/f$fc"
            }
        }
    }
    $FacingScale.ScaleX = 1.0
    $TextFacingScale.ScaleX = 1.0
    $Config.BubbleScale = 1.0
    Update-BubbleScale

    # --- Case 10 (CH-05 & CH-06 / R3): Tier 3 stress at 1.4x (3 sources + waiting) & Zero-line 1 -> 0 -> 1 recovery + 0-line hover ---
    $Config.FontScale = 1.4
    Update-FontScale
    Set-WorkPayload -source 'Antigravity' -task $veryLongTask -state 'waiting' -workingCount 12 -sources @('Antigravity', 'Codex', 'DSH')
    $tier3Stress = [ordered]@{
        summary       = $script:LastWorkLayoutSummary
        bodyVis       = [string]$WorkBodyArea.Visibility
        borderH       = Safe-Round $BubbleBorder.ActualHeight
        taskMaxHeight = Safe-Round $WorkTask.MaxHeight
    }

    # Force zero-line collapse via MaxHeight override -> verify 0-line hover opens DetailWindow -> recover back to 128 DIP
    $script:WorkCardMaxHeightOverride = 88.0
    Update-WorkTaskLineBudget
    Pump-Wpf
    $zeroLineState = [ordered]@{
        summary       = $script:LastWorkLayoutSummary
        bodyVis       = [string]$WorkBodyArea.Visibility
        taskMaxHeight = Safe-Round $WorkTask.MaxHeight
    }
    $zeroLineHoverDetail = Invoke-DeterministicHoverCheck $WorkHeader $true 1500
    Close-HoverDetailCard

    $script:WorkCardMaxHeightOverride = 0.0
    Update-WorkTaskLineBudget
    $recoveredOneLine = Get-BubbleStageSnapshot 'recovered-1line'
    $recoveredSummary = $script:LastWorkLayoutSummary

    $Config.FontScale = 1.0
    Update-FontScale

    # --- Case 11 (CH-07 / CH-08): Single-parent opacity sync & Test-ElementHit / WM_NCHITTEST tail gap pass-through ---
    Set-WorkPayload -source 'Antigravity' -task '命中测试与透明度同期校验' -state 'working' -workingCount 1 -sources @('Antigravity')
    Show-Bubble 0 -Force
    $Bubble.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
    $Bubble.Opacity = 1.0
    Pump-Wpf
    $tailCenterPt = Get-VisualElementCenterScreenPt $Tail
    $tailNearCenterPt = Get-VisualElementCenterScreenPt $TailNear
    $cardCenterPt = Get-VisualElementCenterScreenPt $BubbleBorder
    $cbRect = $BubbleBorder.TransformToAncestor($Window).TransformBounds([System.Windows.Rect]::new(0, 0, $BubbleBorder.ActualWidth, $BubbleBorder.ActualHeight))
    $gapScreenPt = $Window.PointToScreen([System.Windows.Point]::new($cbRect.Left + 8.0, $cbRect.Bottom + 10.0))

    $Bubble.Opacity = 0.04
    $hitMidFade = [ordered]@{
        tailHit       = (Test-ElementHit $Tail $tailCenterPt)
        cardHit       = (Test-ElementHit $BubbleBorder $cardCenterPt)
        ncAtTail      = [int](Get-StageNcHitTestResult $tailCenterPt)
    }
    $Bubble.Opacity = 1.0
    $hitVisible = [ordered]@{
        tailParentName = if ($Tail.Parent) { [string]$Tail.Parent.Name } else { '' }
        ncAtCard       = [int](Get-StageNcHitTestResult $cardCenterPt)
        ncAtTail       = [int](Get-StageNcHitTestResult $tailCenterPt)
        ncAtTailNear   = [int](Get-StageNcHitTestResult $tailNearCenterPt)
        ncAtTailGap    = [int](Get-StageNcHitTestResult $gapScreenPt)
    }
    $Bubble.Visibility = [System.Windows.Visibility]::Hidden
    $hitHidden = [ordered]@{
        tailIsVisible  = [bool]$Tail.IsVisible
        tailHit        = (Test-ElementHit $Tail $tailCenterPt)
        ncAtTail       = [int](Get-StageNcHitTestResult $tailCenterPt)
    }
    $Bubble.Visibility = [System.Windows.Visibility]::Visible

    # --- Case 6: AC06 Inline WorkSourceBadge hover excluded vs WorkHeader trigger opens ---
    Set-WorkPayload -source 'Antigravity' -task '测试内联来源徽章与标题悬停触发边界' -workingCount 1 -sources @('Antigravity')
    Close-HoverDetailCard
    Pump-Wpf

    $badgeTooltipPresent = -not [string]::IsNullOrWhiteSpace([string]$WorkSourceBadge.ToolTip)
    $detailOnBadgeHover = Invoke-DeterministicHoverCheck $WorkSourceBadge $false 260
    $detailOnHeaderHover = Invoke-DeterministicHoverCheck $WorkHeader $true 1500

    # Keep cursor away before manual DetailWindow sizing tests
    Close-HoverDetailCard
    Pump-Wpf

    # --- Case 7: P1 DetailWindow short -> hide -> background long reopen & open short<->long sync ---
    Set-WorkPayload -source 'Antigravity' -task '短任务' -workingCount 1 -sources @('Antigravity')
    Open-HoverDetailCard
    Pump-Wpf
    $shortOpen = Get-DetailMetrics

    Close-HoverDetailCard
    Pump-Wpf
    $longDetailText = @(
        '第一段：正在模拟反重力长任务详情同步。此前在 DetailWindow 首次以短文本打开后隐藏，后台切换为长文本并再次显示时，Top-level SizeToContent Window 偶发沿用旧 DesiredSize，导致 Win32 ClientRect 停留在 355x188 px 从而将右侧与底部文本裁切掉。',
        '第二段：本次修复在 Update-DetailWindowPosition 中对 DetailRootGrid 执行自底向上的测量失效重算与双轮 Measure(Infinity)，并在 Show 后校正 Window 与 HWND ClientRect 尺寸一致性，确保长短切换与字体缩放时不再发生半截窗口与文字裁切问题。',
        '第三段：同时补充滚动上限检查，动态扣除标题栏和上下边框等真实非滚动区高度，避免 1.4 倍字体下 ScrollViewer 溢出可视工作区。'
    ) -join "\`n\`n"
    Set-WorkPayload -source 'Antigravity' -task $longDetailText -workingCount 1 -sources @('Antigravity')
    Open-HoverDetailCard
    Pump-Wpf
    $reopenLong = Get-DetailMetrics

    # While open: long -> short shrink
    Set-WorkPayload -source 'Antigravity' -task '短任务' -workingCount 1 -sources @('Antigravity')
    Pump-Wpf
    $shrinkShort = Get-DetailMetrics

    # While open: short -> long expand
    Set-WorkPayload -source 'Antigravity' -task $longDetailText -workingCount 1 -sources @('Antigravity')
    Pump-Wpf
    $openLong = Get-DetailMetrics

    # Scroll to bottom check at FontScale = 1.4
    $Config.FontScale = 1.4
    Update-FontScale
    Pump-Wpf
    $script:DetailScrollViewer.ScrollToEnd()
    Pump-Wpf
    $fs14LongScrolled = Get-DetailMetrics

    Close-HoverDetailCard -Dispose
    $Config.FontScale = 1.0
    Update-FontScale
    $Config.Character = 'claude'
    Update-Theme
    $Config.BubbleScale = 1.0
    Update-BubbleScale
    Pump-Wpf

    # --- Case 12: Option B work status split (stateText vs task/taskDetail) & smart DetailHintBanner dedup ---
    Set-WorkPayload -source 'Antigravity' -state 'working' -stateText '正在敲代码改文件...' -task '正在编辑 AgentPet.ps1' -taskDetail '正在编辑 AgentPet.ps1（补全状态提示与边框主题）'
    Open-HoverDetailCard
    Pump-Wpf
    $workSplitDistinct = [ordered]@{
        workTaskText    = [string]$WorkTask.Text
        detailHintVis   = [string]$script:DetailHintBanner.Visibility
        detailHintText  = [string]$script:DetailHintText.Text
        detailBodyText  = [string]$script:DetailBodyText.Text
        hoverOffTask    = ''
        hoverOnTask     = ''
    }
    Set-HoverDetailsEnabled $false
    Pump-Wpf
    $workSplitDistinct.hoverOffTask = [string]$WorkTask.Text
    Set-HoverDetailsEnabled $true
    Pump-Wpf
    $workSplitDistinct.hoverOnTask = [string]$WorkTask.Text
    Open-HoverDetailCard
    Pump-Wpf
    Set-WorkPayload -source 'Antigravity' -state 'waiting' -stateText '等待主人确认终端命令...' -task '请确认是否执行测试' -taskDetail '完整终端命令：run_command --check'
    Pump-Wpf
    $workSplitFallback = [ordered]@{
        workTaskText    = [string]$WorkTask.Text
        detailHintVis   = [string]$script:DetailHintBanner.Visibility
        detailHintText  = [string]$script:DetailHintText.Text
        detailBodyText  = [string]$script:DetailBodyText.Text
    }
    Set-WorkPayload -source 'Codex' -state 'waiting' -stateText '等待审批中...' -task '等待审批中...' -taskDetail '请批准执行单元测试'
    Pump-Wpf
    $workSplitSameDedup = [ordered]@{
        workTaskText    = [string]$WorkTask.Text
        detailHintVis   = [string]$script:DetailHintBanner.Visibility
        detailBodyText  = [string]$script:DetailBodyText.Text
    }
    Close-HoverDetailCard -Dispose
    Pump-Wpf

    # --- Case 13: P2 Hide-Bubble fade-out closure scope & version guard ---
    $script:isBubbleOpen = $false
    Show-Bubble 0 -Force
    Pump-Wpf
    $Bubble.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
    $Bubble.Opacity = 1.0
    Pump-Wpf
    Hide-Bubble
    Pump-Wpf 20
    Pump-Wpf 190
    Pump-Wpf 30
    $fadeOutDeadline = [DateTime]::UtcNow.AddSeconds(1.5)
    while ($Bubble.Visibility -ne [System.Windows.Visibility]::Hidden -and [DateTime]::UtcNow -lt $fadeOutDeadline) {
        Pump-Wpf 20
    }
    $fadeAfterComplete = [ordered]@{
        vis      = [string]$Bubble.Visibility
        opacity  = Safe-Round $Bubble.Opacity
        openFlag = [bool]$script:isBubbleOpen
    }
    Show-Bubble 0 -Force
    Pump-Wpf 30
    $Bubble.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
    $Bubble.Opacity = 1.0
    Pump-Wpf
    Hide-Bubble
    Pump-Wpf 20
    Pump-Wpf 25
    Show-Bubble 0 -Force
    Pump-Wpf 20
    Pump-Wpf 190
    Pump-Wpf 30
    $fadeInDeadline = [DateTime]::UtcNow.AddSeconds(1.5)
    while ($Bubble.Opacity -lt 0.99 -and [DateTime]::UtcNow -lt $fadeInDeadline) {
        Pump-Wpf 20
    }
    $fadeReopenGuard = [ordered]@{
        vis      = [string]$Bubble.Visibility
        opacity  = Safe-Round $Bubble.Opacity
        openFlag = [bool]$script:isBubbleOpen
    }

    # --- Case 14: P2 Default panel tray & context menu scope (no .GetNewClosure leaks) ---
    $Config.TrayEnabled = $true
    if (-not $script:NotifyIcon) { Initialize-TrayIcon }
    Build-ContextMenu
    Pump-Wpf
    $trayMenuStrip = $script:NotifyIcon.ContextMenuStrip
    $trayTag = $trayMenuStrip.Tag

    $script:agentBusy = $true
    $Config.BubbleMode = 'quota'
    Set-ActiveBubblePanel 'work'
    Pump-Wpf
    $trayTag.DefDeepseek.PerformClick()
    Pump-Wpf
    $menuTrayBusyMode = [string]$Config.BubbleMode
    $menuTrayBusyPanel = [string]$script:currentBubblePanel

    $script:agentBusy = $false
    $Config.BubbleMode = 'work'
    Set-ActiveBubblePanel 'work'
    Pump-Wpf
    $trayTag.DefQuote.PerformClick()
    Pump-Wpf
    $menuTrayIdleMode = [string]$Config.BubbleMode
    $menuTrayIdlePanel = [string]$script:currentBubblePanel

    $miDefault = $null
    foreach ($it in $Window.ContextMenu.Items) {
        if ($it -is [System.Windows.Controls.MenuItem] -and [string]$it.Header -eq '气泡默认偏好') {
            $miDefault = $it
            break
        }
    }
    $ctxDeepseek = $null; $ctxQuota = $null
    if ($miDefault) {
        foreach ($sub in $miDefault.Items) {
            if ([string]$sub.Tag -eq 'deepseek') { $ctxDeepseek = $sub }
            elseif ([string]$sub.Tag -eq 'quota') { $ctxQuota = $sub }
        }
    }
    $script:agentBusy = $true
    $Config.BubbleMode = 'quote'
    Set-ActiveBubblePanel 'work'
    Pump-Wpf
    if ($ctxDeepseek) {
        $ctxDeepseek.RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
    }
    Pump-Wpf
    $menuCtxBusyMode = [string]$Config.BubbleMode
    $menuCtxBusyPanel = [string]$script:currentBubblePanel

    $script:agentBusy = $false
    if ($ctxQuota) {
        $ctxQuota.RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
    }
    Pump-Wpf
    $menuCtxIdleMode = [string]$Config.BubbleMode
    $menuCtxIdlePanel = [string]$script:currentBubblePanel

    # Task completion sound tray & WPF menu bidirectional sync checks
    $tcDefaultOk = ([bool]$DefaultConfig.TaskCompleteSoundEnabled -and [bool]$DefaultConfig.MuteTaskSoundWhenHidden -and (-not [bool]$DefaultConfig.QuietHoursEnabled) -and ([string]$DefaultConfig.QuietHoursStart -eq '23:00') -and ([string]$DefaultConfig.QuietHoursEnd -eq '08:00') -and [bool]$DefaultConfig.AntigravityTranscriptCompleteEnabled)
    $trayTag.TaskSound.PerformClick()
    Pump-Wpf
    $tcTrayOffCfg = [bool]$Config.TaskCompleteSoundEnabled
    $tcTrayOffWpf = [bool]$script:WpfTaskSoundMenuItem.IsChecked
    $trayTag.TaskSound.PerformClick()
    Pump-Wpf
    $trayTag.AgComplete.PerformClick()
    Pump-Wpf
    $tcAgOffCfg = [bool]$Config.AntigravityTranscriptCompleteEnabled
    $tcAgOffWpf = [bool]$script:WpfAgCompleteMenuItem.IsChecked
    if ($script:WpfAgCompleteMenuItem) {
        $script:WpfAgCompleteMenuItem.RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
        Pump-Wpf
    }
    $tcAgOnCfg = [bool]$Config.AntigravityTranscriptCompleteEnabled
    $trayTag.MuteHidden.PerformClick()
    Pump-Wpf
    $tcMuteHiddenOffCfg = [bool]$Config.MuteTaskSoundWhenHidden
    $tcMuteHiddenOffWpf = [bool]$script:WpfMuteHiddenMenuItem.IsChecked
    $trayTag.MuteHidden.PerformClick()
    Pump-Wpf
    $qp1230 = $null
    foreach ($qp in $trayTag.QuietPresets.DropDownItems) {
        if ([string]$qp.Tag -eq '12:30-14:00') { $qp1230 = $qp; break }
    }
    if ($qp1230) { $qp1230.PerformClick(); Pump-Wpf }
    $tcPresetStart = [string]$Config.QuietHoursStart
    $tcPresetEnd = [string]$Config.QuietHoursEnd
    $tcPresetQuietOn = [bool]$Config.QuietHoursEnabled
    $tcPresetWpfQuiet = [bool]$script:WpfQuietToggleMenuItem.IsChecked
    if ($script:WpfQuietToggleMenuItem) {
        $script:WpfQuietToggleMenuItem.RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
        Pump-Wpf
    }
    $tcAfterWpfQuiet = [bool]$Config.QuietHoursEnabled
    Set-QuietHoursPreset '23:00-08:00'
    $Config.QuietHoursEnabled = $false
    Build-ContextMenu
    Pump-Wpf
    $tcRootTaskMenus = @($trayMenuStrip.Items | Where-Object { $_ -is [System.Windows.Forms.ToolStripMenuItem] -and [string]$_.Text -like '*任务完成*' })
    $tcInSingleSubmenu = (
        $tcRootTaskMenus.Count -eq 1 -and
        $trayTag.TaskCompleteMenu -eq $tcRootTaskMenus[0] -and
        $trayTag.TaskCompleteMenu.DropDownItems.Contains($trayTag.TaskSound) -and
        $trayTag.TaskCompleteMenu.DropDownItems.Contains($trayTag.AgComplete) -and
        $trayTag.TaskCompleteMenu.DropDownItems.Contains($trayTag.MuteHidden) -and
        $trayTag.TaskCompleteMenu.DropDownItems.Contains($trayTag.QuietEnable) -and
        $trayTag.TaskCompleteMenu.DropDownItems.Contains($trayTag.QuietPresets)
    )
    $trayAllLabels = New-Object System.Collections.ArrayList
    $trayWalkQueue = New-Object System.Collections.Queue
    foreach ($it in $trayMenuStrip.Items) { $trayWalkQueue.Enqueue($it) }
    while ($trayWalkQueue.Count -gt 0) {
        $curIt = $trayWalkQueue.Dequeue()
        if ($curIt -is [System.Windows.Forms.ToolStripMenuItem]) {
            [void]$trayAllLabels.Add([string]$curIt.Text)
            foreach ($subIt in $curIt.DropDownItems) { $trayWalkQueue.Enqueue($subIt) }
        }
    }
    $trayHasDisableOption = ($trayAllLabels -contains '启用托盘图标') -or ($null -ne $trayTag.TrayEnabled)

    $taskSoundMenuSync = [ordered]@{
        defaultsOk      = $tcDefaultOk
        inSingleSubmenu = $tcInSingleSubmenu
        noTrayHideOpt   = (-not $trayHasDisableOption)
        trayOffCfg      = $tcTrayOffCfg
        trayOffWpf      = $tcTrayOffWpf
        trayRestoredCfg = [bool]$Config.TaskCompleteSoundEnabled
        agOffCfg        = $tcAgOffCfg
        agOffWpf        = $tcAgOffWpf
        agOnCfg         = $tcAgOnCfg
        muteHiddenOffCfg = $tcMuteHiddenOffCfg
        muteHiddenOffWpf = $tcMuteHiddenOffWpf
        muteRestoredCfg = [bool]$Config.MuteTaskSoundWhenHidden
        presetStart     = $tcPresetStart
        presetEnd       = $tcPresetEnd
        presetQuietOn   = $tcPresetQuietOn
        presetWpfQuiet  = $tcPresetWpfQuiet
        afterWpfQuiet   = $tcAfterWpfQuiet
        hasSoundPlayer  = ($null -ne $script:TaskCompletePlayer -and $null -ne $script:TaskCompletePlayer.Source)
    }

    if ($script:NotifyIcon) {
        $script:NotifyIcon.Visible = $false
        $script:NotifyIcon.Dispose()
        $script:NotifyIcon = $null
    }

    $srcForClosureCheck = Get-Content -LiteralPath ${JSON.stringify(ps1Path)} -Raw -Encoding UTF8
    $closureMatchCount = ([regex]::Matches($srcForClosureCheck, 'GetNewClosure')).Count

    # --- Case 15: P3 DeepSeekPanel FontScale (0.8 / 1.0 / 1.15 / 1.3 / 1.4) x states & both update orders ---
    Set-ActiveBubblePanel 'deepseek'
    Pump-Wpf
    $dsInf = [System.Windows.Size]::new([double]::PositiveInfinity, [double]::PositiveInfinity)
    function Get-DsRect($el, $ancestor) {
        if (-not $el -or -not $ancestor -or -not $el.IsVisible) { return $null }
        if ($el.ActualWidth -le 0.1 -and $el.ActualHeight -le 0.1) { return $null }
        $tl = $el.TranslatePoint([System.Windows.Point]::new(0, 0), $ancestor)
        return [ordered]@{
            Left   = Safe-Round $tl.X 2
            Top    = Safe-Round $tl.Y 2
            Right  = Safe-Round ($tl.X + $el.ActualWidth) 2
            Bottom = Safe-Round ($tl.Y + $el.ActualHeight) 2
        }
    }
    function Test-RectsOverlap($a, $b) {
        if (-not $a -or -not $b) { return $false }
        $disjointX = ($a.Right -le ($b.Left + 0.5)) -or ($b.Right -le ($a.Left + 0.5))
        $disjointY = ($a.Bottom -le ($b.Top + 0.5)) -or ($b.Bottom -le ($a.Top + 0.5))
        return (-not ($disjointX -or $disjointY))
    }
    function Measure-DeepSeekState([string]$tag) {
        Pump-Wpf
        $innerH = Safe-Round ($BubbleBorder.ActualHeight - $BubbleBorder.BorderThickness.Top - $BubbleBorder.BorderThickness.Bottom - $BubbleBorder.Padding.Top - $BubbleBorder.Padding.Bottom)
        $panelH = Safe-Round $DeepSeekPanel.ActualHeight
        $noticeRow = [int][System.Windows.Controls.Grid]::GetRow($DeepSeekStatusNotice)
        $availNoticeW = if ($noticeRow -eq 0) {
            Safe-Round $DeepSeekHeaderGrid.ColumnDefinitions[1].ActualWidth
        } else {
            Safe-Round $DeepSeekHeaderGrid.ActualWidth
        }
        $DeepSeekStatusNotice.Measure($dsInf)
        $noticeDesW = Safe-Round $DeepSeekStatusNotice.DesiredSize.Width

        $bdRect    = Get-DsRect $DeepSeekBreakdownText $DeepSeekContentGrid
        $grantRect = Get-DsRect $DeepSeekGrantLegend $DeepSeekContentGrid
        $DeepSeekBreakdownText.Measure($dsInf)
        $bdDesW   = Safe-Round $DeepSeekBreakdownText.DesiredSize.Width
        $bdActW   = Safe-Round $DeepSeekBreakdownText.ActualWidth
        $subOverlap = Test-RectsOverlap $bdRect $grantRect

        $msgTitleRect = Get-DsRect $DeepSeekMsgTitle $DeepSeekContentGrid
        $msgPillRect  = Get-DsRect $DeepSeekMsgStatusPill $DeepSeekContentGrid
        $msgHdrOverlap = Test-RectsOverlap $msgTitleRect $msgPillRect
        $msgDetailRect = Get-DsRect $DeepSeekMsgDetail $DeepSeekContentGrid
        $msgDetailDesW = 0.0
        if ($DeepSeekMsgPanel.Visibility -eq [System.Windows.Visibility]::Visible) {
            $DeepSeekMsgDetail.Measure($dsInf)
            $msgDetailDesW = Safe-Round $DeepSeekMsgDetail.DesiredSize.Width
        }
        $availPillRect  = Get-DsRect $DeepSeekAvailPill $DeepSeekContentGrid
        $availTextRect  = Get-DsRect $DeepSeekAvailPillText $DeepSeekContentGrid
        $subMetaRect    = Get-DsRect $DeepSeekSubMetaText $DeepSeekContentGrid
        $ratioRect      = Get-DsRect $DeepSeekRatioTrack $DeepSeekContentGrid
        $mainRowRect    = Get-DsRect $DeepSeekMainRowGrid $DeepSeekContentGrid
        $subRowRect     = Get-DsRect $DeepSeekSubRowGrid $DeepSeekContentGrid
        $totalRect      = Get-DsRect $DeepSeekTotalText $DeepSeekContentGrid
        $availVsRatio   = Test-RectsOverlap $availPillRect $ratioRect
        $subMetaVsRatio = Test-RectsOverlap $subMetaRect $ratioRect
        $mainVsRatio    = Test-RectsOverlap $mainRowRect $ratioRect
        $ratioVsSub     = Test-RectsOverlap $ratioRect $subRowRect
        $cardW = $DeepSeekFrostedCard.ActualWidth
        $cardH = $DeepSeekFrostedCard.ActualHeight
        $outsideFrosted = @()
        foreach ($elName in @('DeepSeekTotalText','DeepSeekAvailPill','DeepSeekMsgTitle','DeepSeekMsgStatusPill','DeepSeekMsgDetail','DeepSeekMsgSubHint','DeepSeekMsgRightHint','DeepSeekRatioTrack','DeepSeekSubRowGrid')) {
            $el = $Window.FindName($elName)
            if ($el -and $el.IsVisible) {
                $ep = $el.TranslatePoint([System.Windows.Point]::new(0, 0), $DeepSeekFrostedCard)
                if ($ep.X -lt -0.5 -or $ep.Y -lt -0.5 -or ($ep.X + $el.ActualWidth) -gt ($cardW + 0.5) -or ($ep.Y + $el.ActualHeight) -gt ($cardH + 0.5)) {
                    $outsideFrosted += $elName
                }
            }
        }
        $availMidDiff  = if ($availPillRect -and $subMetaRect) {
            Safe-Round ([Math]::Abs((($availPillRect.Top + $availPillRect.Bottom) / 2.0) - (($subMetaRect.Top + $subMetaRect.Bottom) / 2.0))) 2
        } else { 0.0 }
        $availTextMidDiff = if ($availTextRect -and $subMetaRect) {
            Safe-Round ([Math]::Abs((($availTextRect.Top + $availTextRect.Bottom) / 2.0) - (($subMetaRect.Top + $subMetaRect.Bottom) / 2.0))) 2
        } else { 0.0 }
        $subRowCnt = if ($DeepSeekGrantLegend.Visibility -eq [System.Windows.Visibility]::Visible -and [System.Windows.Controls.Grid]::GetRow($DeepSeekGrantLegend) -eq 1) { 2 } else { 1 }
        return [ordered]@{
            tag           = $tag
            fs            = [double]$Config.FontScale
            panelH        = $panelH
            innerH        = $innerH
            noticeRow     = $noticeRow
            availNoticeW  = $availNoticeW
            noticeDesW    = $noticeDesW
            hdrFs         = Safe-Round $DeepSeekHeader.FontSize
            noticeFs      = Safe-Round $DeepSeekStatusNotice.FontSize
            curFs         = Safe-Round $DeepSeekCurrencyLabel.FontSize
            totalFs       = Safe-Round $DeepSeekTotalText.FontSize
            bdFs          = Safe-Round $DeepSeekBreakdownText.FontSize
            msgDetailFs   = Safe-Round $DeepSeekMsgDetail.FontSize
            hdrText       = [string]$DeepSeekHeader.Text
            curText       = [string]$DeepSeekCurrencyLabel.Text
            badgeVis      = [string]$DeepSeekBadge.Visibility
            noticeText    = [string]$DeepSeekStatusNotice.Text
            okVis         = [string]$DeepSeekOkPanel.Visibility
            msgVis        = [string]$DeepSeekMsgPanel.Visibility
            fillBarVis    = [string]$DeepSeekFillBar.Visibility
            grantBarVis   = [string]$DeepSeekGrantBar.Visibility
            bdText        = [string]$DeepSeekBreakdownText.Text
            grantText     = [string]$DeepSeekGrantText.Text
            availPillText = [string]$DeepSeekAvailPillText.Text
            msgTitleText  = [string]$DeepSeekMsgTitle.Text
            msgStatusText = [string]$DeepSeekMsgStatusText.Text
            borderPadLeft = Safe-Round $BubbleBorder.Padding.Left 1
            padLeft       = Safe-Round $DeepSeekBodyHost.Padding.Left 1
            hasPricing    = ($null -ne $Window.FindName('DeepSeekPricingLink'))
            subRowCnt     = $subRowCnt
            subOverlap    = $subOverlap
            bdDesW        = $bdDesW
            bdActW        = $bdActW
            msgHdrOverlap = $msgHdrOverlap
            availVsRatio  = $availVsRatio
            subMetaVsRatio = $subMetaVsRatio
            mainVsRatio   = $mainVsRatio
            ratioVsSub    = $ratioVsSub
            outsideFrosted = $outsideFrosted
            availMidDiff     = $availMidDiff
            availTextMidDiff = $availTextMidDiff
            msgDetailH    = if ($msgDetailRect) { Safe-Round ($msgDetailRect.Bottom - $msgDetailRect.Top) } else { 0 }
            msgDetailMaxH = Safe-Round $DeepSeekMsgDetail.MaxHeight
            msgDetailDesW = $msgDetailDesW
        }
    }
    $okBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; credentialSource = 'env'; status = 'ok'
        isAvailable = $true; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        balances = @([PSCustomObject]@{ currency = 'CNY'; totalBalance = '88.88'; toppedUpBalance = '80.00'; grantedBalance = '8.88' })
    }
    $unkBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; credentialSource = 'env'; status = 'ok'
        isAvailable = $false
        balances = @([PSCustomObject]@{ currency = 'CNY'; totalBalance = '1234.56'; toppedUpBalance = '1000.00'; grantedBalance = '234.56' })
    }
    $zeroGrantBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; credentialSource = 'env'; status = 'ok'
        isAvailable = $true; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        balances = @([PSCustomObject]@{ currency = 'CNY'; totalBalance = '40.41'; toppedUpBalance = '40.41'; grantedBalance = '0.00' })
    }
    $pureGrantBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; credentialSource = 'env'; status = 'ok'
        isAvailable = $true; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        balances = @([PSCustomObject]@{ currency = 'CNY'; totalBalance = '25.00'; toppedUpBalance = '0.00'; grantedBalance = '25.00' })
    }
    $errBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; status = 'error'; errorCode = 'TIMEOUT'
        errorMessage = '15 秒内未从 DSH 或 DeepSeek API 获取到余额'
    }
    $unavailBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; status = 'unavailable'
        errorMessage = '启动后未获取到余额数据'
    }
    $dshOffBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; status = 'dsh_not_running'
    }
    $noCnyBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; status = 'ok'; isAvailable = $true; balances = @()
    }
    $credMissingBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; status = 'error'; errorCode = 'DSH_CREDENTIAL_MISSING'; errorMessage = '未配置有效 API 凭据'
    }
    $unsupportedBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; status = 'error'; errorCode = 'DSH_UNSUPPORTED'; errorMessage = '当前服务商不支持余额查询'
    }
    $cooldownBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; status = 'error'; errorCode = 'COOLDOWN'; balances = @(); errorMessage = '刷新过于频繁，请稍后再试'
    }
    $rateLimitBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; status = 'error'; errorCode = 'RATE_LIMITED'; balances = @(); errorMessage = '请求频率超限，请稍后再试'
    }
    $deepSeekScaleCases = @()
    # Order A: FontScale -> State
    foreach ($fs in @(0.8, 1.0, 1.15, 1.3, 1.4)) {
        $Config.FontScale = $fs
        Update-FontScale
        $script:lastBalanceObject = $okBal
        Apply-BalanceObject $okBal
        $deepSeekScaleCases += (Measure-DeepSeekState "fsFirst/$fs/ok")

        $script:lastBalanceObject = $unkBal
        Apply-BalanceObject $unkBal
        $deepSeekScaleCases += (Measure-DeepSeekState "fsFirst/$fs/unk")

        Set-BalanceTimeoutNotice
        $deepSeekScaleCases += (Measure-DeepSeekState "fsFirst/$fs/to")

        Apply-BalanceObject $errBal
        $deepSeekScaleCases += (Measure-DeepSeekState "fsFirst/$fs/err")
    }
    foreach ($fs in @(1.0, 1.15, 1.3, 1.4)) {
        $Config.FontScale = $fs
        Update-FontScale
        Apply-BalanceObject $zeroGrantBal; $deepSeekScaleCases += (Measure-DeepSeekState "extra/$fs/zeroGrant")
        Apply-BalanceObject $pureGrantBal; $deepSeekScaleCases += (Measure-DeepSeekState "extra/$fs/pureGrant")
        Apply-BalanceObject $noCnyBal;     $deepSeekScaleCases += (Measure-DeepSeekState "extra/$fs/noCny")
        Apply-BalanceObject $credMissingBal; $deepSeekScaleCases += (Measure-DeepSeekState "extra/$fs/credMissing")
        Apply-BalanceObject $unsupportedBal; $deepSeekScaleCases += (Measure-DeepSeekState "extra/$fs/unsupported")
        Apply-BalanceObject $cooldownBal;  $deepSeekScaleCases += (Measure-DeepSeekState "extra/$fs/cooldown")
        Apply-BalanceObject $rateLimitBal; $deepSeekScaleCases += (Measure-DeepSeekState "extra/$fs/rateLimited")
    }
    $Config.FontScale = 1.4
    Update-FontScale
    Apply-BalanceObject $unavailBal
    $deepSeekScaleCases += (Measure-DeepSeekState "fsFirst/1.4/unavail")
    Apply-BalanceObject $dshOffBal
    $deepSeekScaleCases += (Measure-DeepSeekState "fsFirst/1.4/dshOff")

    # Order B: State -> FontScale
    foreach ($targetFs in @(1.15, 1.3, 1.4)) {
        $Config.FontScale = 0.8
        Update-FontScale
        $script:lastBalanceObject = $okBal
        Apply-BalanceObject $okBal
        $Config.FontScale = $targetFs
        Update-FontScale
        $deepSeekScaleCases += (Measure-DeepSeekState "stateFirst/ok->$targetFs")
    }

    Set-BalanceTimeoutNotice
    $Config.FontScale = 0.8
    Update-FontScale
    $deepSeekScaleCases += (Measure-DeepSeekState "stateFirst/to->0.8")
    $Config.FontScale = 1.4
    Update-FontScale
    $deepSeekScaleCases += (Measure-DeepSeekState "stateFirst/to->1.4")

    # Panel roundtrip padding restore check
    Set-ActiveBubblePanel 'quota'
    Set-ActiveBubblePanel 'deepseek'
    $dsPadAt14 = Safe-Round $DeepSeekBodyHost.Padding.Left 1
    $Config.FontScale = 1.0
    Update-FontScale
    $dsPadAt10 = Safe-Round $DeepSeekBodyHost.Padding.Left 1

    # --- Case 16: HoverDetailsEnabled 4-way Load-Config + Menu + Bubble fallback + Hover matrix ---
    $hoverConfigCases = @()
    $hoverSpecs = @(
        @{ Mode = 'no_file';        PreMem = $true;  Expect = $false; Json = $null },
        @{ Mode = 'missing_field';  PreMem = $true;  Expect = $false; Json = (@{ Character = 'claude'; BubbleMode = 'quota'; Scale = 1.0; BubbleScale = 1.0; FontScale = 1.0; TrayEnabled = $true; AutoQuoteMinutes = 0; SleepSeconds = 9999; Left = 700; Top = 420 } | ConvertTo-Json -Depth 4) },
        @{ Mode = 'explicit_true';  PreMem = $false; Expect = $true;  Json = (@{ Character = 'claude'; BubbleMode = 'quota'; Scale = 1.0; BubbleScale = 1.0; FontScale = 1.0; TrayEnabled = $true; HoverDetailsEnabled = $true; AutoQuoteMinutes = 0; SleepSeconds = 9999; Left = 700; Top = 420 } | ConvertTo-Json -Depth 4) },
        @{ Mode = 'explicit_false'; PreMem = $true;  Expect = $false; Json = (@{ Character = 'claude'; BubbleMode = 'quota'; Scale = 1.0; BubbleScale = 1.0; FontScale = 1.0; TrayEnabled = $true; HoverDetailsEnabled = $false; AutoQuoteMinutes = 0; SleepSeconds = 9999; Left = 700; Top = 420 } | ConvertTo-Json -Depth 4) }
    )
    foreach ($hs in $hoverSpecs) {
        if ($script:NotifyIcon) {
            $script:NotifyIcon.Visible = $false
            $script:NotifyIcon.Dispose()
            $script:NotifyIcon = $null
        }
        $script:TrayHoverDetailMenuItem = $null
        $script:WpfHoverDetailMenuItem = $null
        if (Test-Path $ConfigBakPath) { Remove-Item -LiteralPath $ConfigBakPath -Force -ErrorAction SilentlyContinue }
        if ($null -eq $hs.Json) {
            if (Test-Path $ConfigPath) { Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue }
        } else {
            [System.IO.File]::WriteAllText($ConfigPath, $hs.Json, [System.Text.Encoding]::UTF8)
        }
        $Config.HoverDetailsEnabled = [bool]$hs.PreMem
        Load-Config
        Initialize-TrayIcon
        Build-ContextMenu
        Pump-Wpf
        Set-WorkPayload -source 'Antigravity' -state 'working' -stateText '正在敲代码改文件...' -task '正在编辑 AgentPet.ps1' -taskDetail '补全详情开关与默认回落校验'
        $workTxt = [string]$WorkTask.Text
        $hoverRes = Invoke-DeterministicHoverCheck $WorkHeader ([bool]$hs.Expect) 1500
        Close-HoverDetailCard
        $hoverConfigCases += [ordered]@{
            mode           = [string]$hs.Mode
            configVal      = [bool]$Config.HoverDetailsEnabled
            trayChecked    = if ($script:TrayHoverDetailMenuItem) { [bool]$script:TrayHoverDetailMenuItem.Checked } else { $null }
            trayTagChecked = if ($script:NotifyIcon -and $script:NotifyIcon.ContextMenuStrip -and $script:NotifyIcon.ContextMenuStrip.Tag.HoverDetail) { [bool]$script:NotifyIcon.ContextMenuStrip.Tag.HoverDetail.Checked } else { $null }
            ctxChecked     = if ($script:WpfHoverDetailMenuItem) { [bool]$script:WpfHoverDetailMenuItem.IsChecked } else { $null }
            workTaskText   = $workTxt
            hoverVisible   = [bool]$hoverRes.visible
            targetHit      = [bool]$hoverRes.targetHit
            elapsedMs      = [int]$hoverRes.elapsedMs
        }
    }
    if ($script:NotifyIcon) {
        $script:NotifyIcon.Visible = $false
        $script:NotifyIcon.Dispose()
        $script:NotifyIcon = $null
    }

    # --- Case 17: Role-aligned quote counts + live character work status translation & sprites on theme switch ---
    $Config.HoverDetailsEnabled = $true
    $Config.Character = 'claude'
    Update-Theme
    Set-WorkPayload -source 'Codex' -state 'working' -stateText '已按典籍上的蓝图动笔改代码啦~' -task '编辑核心文件' -taskDetail '多角色工作状态同步切换校验'
    Open-HoverDetailCard
    Pump-Wpf
    $roleWorkResults = [ordered]@{}
    foreach ($ch in @('claude', 'gemini', 'dragon', 'deepseek', 'zcode')) {
        $Config.Character = $ch
        Update-Theme
        Pump-Wpf
        $wt = [string]$WorkTask.Text
        $roleWorkResults[$ch] = [ordered]@{
            workTask      = $wt
            inOwnPool     = ($script:WorkStatusTextsByCharacter[$ch]['working'] -contains $wt)
            detailHintVs  = [string]$script:DetailHintBanner.Visibility
            speakerText   = [string]$QuoteSpeaker.Text
            bubbleBg      = [string]$BubbleBorder.Background
            wakeQuote     = [string](Get-CharacterWakeQuote $ch)
            waitSpriteKey = ''
            hasIdleSprite = $script:ImageCache.ContainsKey("$ch-idle")
            hasWorkSprite = $script:ImageCache.ContainsKey("$ch-work")
            hasThinkSprite= $script:ImageCache.ContainsKey("$ch-think")
            hasHappySprite= $script:ImageCache.ContainsKey("$ch-happy")
            hasSleepSprite= $script:ImageCache.ContainsKey("$ch-sleep")
        }
    }
    foreach ($ch in @('claude', 'gemini', 'dragon', 'deepseek', 'zcode')) {
        $Config.Character = $ch
        Update-Theme
        Set-WorkPayload -source 'Codex' -state 'waiting' -stateText '等待确认' -task '等待审批' -taskDetail '等待确认测试'
        Pump-Wpf
        $roleWorkResults[$ch].waitSpriteKey = [string]$script:CurrentSpriteKey
    }
    Close-HoverDetailCard
    $roleQuotesCheck = [ordered]@{
        claudeCount   = $ClaudeQuotes.Count
        geminiCount   = $GeminiQuotes.Count
        dragonCount   = $DragonQuotes.Count
        deepseekCount = $DeepSeekQuotes.Count
        zcodeCount    = $ZCodeQuotes.Count
        rosterKeys    = @($script:CharacterRoster | ForEach-Object { [string]$_.Key })
        workSwitch    = $roleWorkResults
    }

    # --- Case 18 (AP-REV-03): Dual-menu character check sync across Tray <-> WPF ContextMenu ---
    $menuCharSync = @()
    $Config.Character = 'claude'
    Build-ContextMenu
    foreach ($targetRole in @('deepseek', 'zcode', 'dragon', 'gemini', 'claude')) {
        $trayRoleItem = $script:TrayMenu.Tag.Roles.DropDownItems | Where-Object { [string]$_.Tag -eq $targetRole } | Select-Object -First 1
        if ($trayRoleItem) { $trayRoleItem.PerformClick() }
        Pump-Wpf
        $wpfCheckedAfterTray = @($Window.ContextMenu.Items[0].Items | Where-Object { $_.IsChecked } | ForEach-Object { [string]$_.Tag })
        $trayCheckedAfterTray = @($script:TrayMenu.Tag.Roles.DropDownItems | Where-Object { $_.Checked } | ForEach-Object { [string]$_.Tag })
        $menuCharSync += [ordered]@{
            step       = "tray->$targetRole"
            cfgChar    = [string]$Config.Character
            wpfChecked = $wpfCheckedAfterTray
            trayChecked= $trayCheckedAfterTray
        }
    }
    $wpfZcodeItem = $Window.ContextMenu.Items[0].Items | Where-Object { [string]$_.Tag -eq 'zcode' } | Select-Object -First 1
    if ($wpfZcodeItem) {
        $wpfZcodeItem.RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
    }
    Pump-Wpf
    $menuCharSync += [ordered]@{
        step       = 'wpf->zcode'
        cfgChar    = [string]$Config.Character
        wpfChecked = @($Window.ContextMenu.Items[0].Items | Where-Object { $_.IsChecked } | ForEach-Object { [string]$_.Tag })
        trayChecked= @($script:TrayMenu.Tag.Roles.DropDownItems | Where-Object { $_.Checked } | ForEach-Object { [string]$_.Tag })
    }

    # --- Case 19: Topmost / Owner=0 / WaitingAttention temp-topmost / Hidden guard ---
    $mainHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($Window)).Handle
    $Config.HoverDetailsEnabled = $true
    Set-WorkPayload -source 'Codex' -state 'working' -stateText '编码中' -task '编辑模块' -taskDetail '置顶生命周期验证详情内容'
    Open-HoverDetailCard
    Pump-Wpf
    $dHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($script:DetailWindow)).Handle
    $mainOwnerOnOpen = [int64][AgentPetNative]::GetWindow($mainHwnd, 4)
    $detailOwnerOnOpen = [int64][AgentPetNative]::GetWindow($dHwnd, 4)
    $Config.Topmost = $false
    $script:waitingAttentionActive = $false
    Sync-AgentPetTopmost -Force
    Pump-Wpf
    $mainTopOff = [bool]$Window.Topmost
    $detailTopOff = [bool]$script:DetailWindow.Topmost
    $script:waitingAttentionActive = $true
    Sync-AgentPetTopmost -Force
    Pump-Wpf
    $mainTopWait = [bool]$Window.Topmost
    $detailTopWait = [bool]$script:DetailWindow.Topmost
    $script:waitingAttentionActive = $false
    Sync-AgentPetTopmost -Force
    Pump-Wpf
    $mainTopRestoredOff = [bool]$Window.Topmost
    $detailTopRestoredOff = [bool]$script:DetailWindow.Topmost
    Close-HoverDetailCard
    $Config.Topmost = $true
    Sync-AgentPetTopmost -Force
    Set-AgentPetWindowVisible $false
    Sync-AgentPetTopmost -Force
    $hiddenAfterSync = ([bool]$script:trayWindowHidden -and (-not [AgentPetNative]::IsWindowVisible($mainHwnd)))
    $topmostLifecycle = [ordered]@{
        mainOwnerOnOpen       = $mainOwnerOnOpen
        detailOwnerOnOpen     = $detailOwnerOnOpen
        mainTopOff            = $mainTopOff
        detailTopOff          = $detailTopOff
        mainTopWait           = $mainTopWait
        detailTopWait         = $detailTopWait
        mainTopRestoredOff    = $mainTopRestoredOff
        detailTopRestoredOff  = $detailTopRestoredOff
        hiddenAfterSync       = $hiddenAfterSync
    }

    # Case 20: open the real rounded templates, including a submenu with a live slider.
    [void][AgentPetNative]::ShowWindow($mainHwnd, [AgentPetNative]::SW_SHOWNOACTIVATE)
    $script:trayWindowHidden = $false
    $Config.Pose = 'happy'
    Initialize-TrayIcon
    if (-not $script:NotifyIcon) { throw 'Case 20 requires the real tray icon to be initialized' }
    $menuThemes = @()
    foreach ($ch in @('claude','dragon','gemini','deepseek','zcode')) {
        $Config.Character = $ch
        Update-Theme
        Build-ContextMenu
        $theme = Get-CurrentTheme
        $trayRenderer = $script:TrayMenu.Renderer
        $menuThemes += [ordered]@{
            character = $ch
            expected = [string]$theme.BubbleBg
            wpf = [string]$Window.ContextMenu.Resources['MenuSurfaceBrush']
            tray = ('#{0:X8}' -f $trayRenderer.Surface.ToArgb())
            expectedHover = [string]$theme.BadgeBg
            expectedChecked = [string]$theme.HoverBg
            wpfHover = [string]$Window.ContextMenu.Resources['MenuHoverBrush']
            wpfChecked = [string]$Window.ContextMenu.Resources['MenuSelectedBrush']
            trayHover = ('#{0:X8}' -f $trayRenderer.HoverFill.ToArgb())
            trayChecked = ('#{0:X8}' -f $trayRenderer.CheckedFill.ToArgb())
        }
    }

    # Sample the real tray renderer away from the text and checkmark without opening a popup.
    $sampleMenu = [System.Windows.Forms.ContextMenuStrip]::new()
    try {
        $sampleItem = [System.Windows.Forms.ToolStripMenuItem]::new('sample')
        [void]$sampleMenu.Items.Add($sampleItem)
        $sampleMenu.Size = $sampleMenu.GetPreferredSize([System.Drawing.Size]::Empty)
        $sampleMenu.PerformLayout()
        $sampleItem.Select()
        if (-not $sampleItem.Selected) { throw 'The tray rendering sample must be selected to test hover fill' }
        $bitmap = [System.Drawing.Bitmap]::new($sampleItem.Width, $sampleItem.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $renderArgs = [System.Windows.Forms.ToolStripItemRenderEventArgs]::new($graphics, $sampleItem)
            $trayHoverPixels = @(foreach ($checked in @($false, $true)) {
                $sampleItem.Checked = $checked
                $graphics.Clear([System.Drawing.Color]::Transparent)
                $trayRenderer.DrawMenuItemBackground($renderArgs)
                '#{0:X8}' -f $bitmap.GetPixel(10, [int]($sampleItem.Height / 2)).ToArgb()
            })
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    } finally {
        $sampleMenu.Dispose()
    }
    $menu = $Window.ContextMenu
    $menu.PlacementTarget = $Window
    $menuChrome = $null
    $visibleMenuRows = @()
    $exitRow = $null
    $exitHitArea = $null
    $versionLabel = $null
    $menuLayoutDeadline = [DateTime]::UtcNow.AddSeconds(2.0)
    do {
        if (-not $menu.IsOpen) { $menu.IsOpen = $true }
        Pump-Wpf 20
        $menu.ApplyTemplate() | Out-Null
        $menu.UpdateLayout()
        $menuChrome = $menu.Template.FindName('RootMenuChrome', $menu)
        $visibleMenuRows = @($menu.Items | Where-Object { $_ -is [System.Windows.Controls.MenuItem] -and $_.Visibility -eq 'Visible' })
        $exitRow = $visibleMenuRows[-1]
        if ($exitRow) { $exitRow.ApplyTemplate() | Out-Null }
        $exitHitArea = if ($exitRow) { $exitRow.Template.FindName('ExitHitArea', $exitRow) } else { $null }
        $versionLabel = if ($exitRow) { $exitRow.Template.FindName('VersionLabel', $exitRow) } else { $null }
    } while ((-not $menu.IsOpen -or -not $menu.IsVisible -or -not $menuChrome -or $menuChrome.ActualWidth -le 0 -or -not $exitHitArea -or $exitHitArea.ActualWidth -le 0 -or -not $versionLabel -or $versionLabel.ActualWidth -le 0) -and [DateTime]::UtcNow -lt $menuLayoutDeadline)
    $exitStart = $exitHitArea.TranslatePoint([System.Windows.Point]::new(0, $exitHitArea.ActualHeight / 2), $menuChrome)
    $exitHeader = $exitRow.Template.FindName('ExitHeaderPresenter', $exitRow)
    $rootHeader = $visibleMenuRows[0].Template.FindName('HeaderPresenter', $visibleMenuRows[0])
    $exitLabelX = $exitHeader.TranslatePoint([System.Windows.Point]::new(0,0), $menuChrome).X
    $rootLabelX = $rootHeader.TranslatePoint([System.Windows.Point]::new(0,0), $menuChrome).X
    $exitEnd = $exitHitArea.TranslatePoint([System.Windows.Point]::new($exitHitArea.ActualWidth, $exitHitArea.ActualHeight / 2), $menuChrome)
    $versionStart = $versionLabel.TranslatePoint([System.Windows.Point]::new(0, $versionLabel.ActualHeight / 2), $menuChrome)
    $versionEnd = $versionLabel.TranslatePoint([System.Windows.Point]::new($versionLabel.ActualWidth, $versionLabel.ActualHeight / 2), $menuChrome)
    $exitPoint = $exitHitArea.TranslatePoint([System.Windows.Point]::new(4, $exitHitArea.ActualHeight / 2), $menu)
    $versionPoint = $versionLabel.TranslatePoint([System.Windows.Point]::new($versionLabel.ActualWidth / 2, $versionLabel.ActualHeight / 2), $menu)
    $gapPoint = $menuChrome.TranslatePoint([System.Windows.Point]::new(($exitEnd.X + $versionStart.X) / 2, $exitStart.Y), $menu)
    $rightPaddingPoint = $exitRow.TranslatePoint([System.Windows.Point]::new($exitRow.ActualWidth - 3, $exitRow.ActualHeight / 2), $menu)
    $footerHitDetails = @()
    $footerHits = @(
        foreach ($point in @($exitPoint, $versionPoint, $gapPoint, $rightPaddingPoint)) {
            $rawHit = $menu.InputHitTest($point)
            $footerHitDetails += if ($rawHit) { $rawHit.GetType().Name + ':' + ([string]$rawHit.Name) } else { '<null>' }
            $hit = $rawHit
            while ($hit -is [System.Windows.Media.Visual] -and $hit -ne $exitRow) {
                $hit = [System.Windows.Media.VisualTreeHelper]::GetParent($hit)
            }
            $hit -eq $exitRow
        }
    )
    $footer = [ordered]@{
        exitLabel = [string]$exitRow.Header
        versionText = [string]$versionLabel.Text
        expectedVersion = "AgentPet v$script:AppVersion"
        labelOffset = Safe-Round ($exitLabelX - $rootLabelX) 2
        menuOpen = [bool]$menu.IsOpen
        menuVisible = [bool]$menu.IsVisible
        exitRowVisible = [bool]$exitRow.IsVisible
        menuWidth = Safe-Round $menuChrome.ActualWidth
        exitWidth = Safe-Round $exitHitArea.ActualWidth
        hitTypes = $footerHitDetails
        aligned = ($menuChrome.ActualWidth -gt 0 -and $exitHitArea.ActualWidth -gt 0 -and $versionLabel.ActualWidth -gt 0 -and
            $exitStart.X -ge 0 -and $exitStart.X -le 16 -and $exitEnd.X -le $versionStart.X -and
            [Math]::Abs($exitStart.Y - $versionStart.Y) -le 1 -and
            ($menuChrome.ActualWidth - $versionEnd.X) -ge 0 -and ($menuChrome.ActualWidth - $versionEnd.X) -le 24)
        hits = $footerHits
    }
    $poseMenu = $menu.Items[1]
    $poseMenu.ApplyTemplate() | Out-Null
    $poseMenu.IsSubmenuOpen = $true
    Pump-Wpf
    $poseRows = @($poseMenu.Items | Where-Object { $_ -is [System.Windows.Controls.MenuItem] })
    foreach ($row in $poseRows) { $row.ApplyTemplate() | Out-Null }
    $popup = $poseMenu.Template.FindName('PART_Popup', $poseMenu)
    $submenuChrome = $poseMenu.Template.FindName('SubmenuChrome', $poseMenu)
    $checkedRows = @($poseRows | Where-Object {$_.Template.FindName('SelectionCheck', $_).Visibility -eq 'Visible'} | ForEach-Object {[string]$_.Tag})
    $selectedChrome = $poseRows[-1].Template.FindName('ItemChrome', $poseRows[-1])
    $roundedMenu = [ordered]@{
        themes = $menuThemes
        trayHoverPixels = $trayHoverPixels
        rootRadius = $menuChrome.CornerRadius.TopLeft
        subRadius = $submenuChrome.CornerRadius.TopLeft
        submenuVisible = ($popup.IsOpen -and $submenuChrome.IsVisible)
        submenuAnimation = [string]$popup.PopupAnimation
        subSurface = [string]$submenuChrome.Background
        labels = @($poseRows | ForEach-Object {[string]$_.Header})
        checks = $checkedRows
        separatorAfterAuto = ($poseMenu.Items[1] -is [System.Windows.Controls.Separator])
        selectedFill = [string]$selectedChrome.Background
        expectedSelectedFill = [string]$menu.Resources['MenuSelectedBrush']
        defaultRowHeight = $poseRows[1].MinHeight
        rowFont = [string]$poseRows[1].FontWeight
        arrow = [string]$poseMenu.Template.FindName('SubmenuChevron', $poseMenu).Visibility
        traySubmenuThemed = [object]::ReferenceEquals($script:TrayMenu.Renderer, $script:TrayMenu.Tag.Roles.DropDown.Renderer)
        trayHasNativeGutter = ($script:TrayMenu.ShowCheckMargin -or $script:TrayMenu.ShowImageMargin)
        rootLabels = @($visibleMenuRows | Select-Object -SkipLast 1 | ForEach-Object { [string]$_.Header })
        rootRowHeight = $visibleMenuRows[0].MinHeight
        footer = $footer
    }
    $poseMenu.IsSubmenuOpen = $false
    $appearanceMenu = $visibleMenuRows | Where-Object { $_.Header -eq '外观' }
    $roundedMenu.appearanceLabels = @($appearanceMenu.Items | ForEach-Object { [string]$_.Header })
    $appearanceMenu.IsSubmenuOpen = $true
    Pump-Wpf
    $scaleMenu = $appearanceMenu.Items | Where-Object { $_.Header -like '立绘缩放比例*' } | Select-Object -First 1
    $scaleMenu.IsSubmenuOpen = $true
    Pump-Wpf
    $sliderRow = $scaleMenu.Items[0]
    $sliderRow.ApplyTemplate() | Out-Null
    $slider = $sliderRow.Header.Children[0]
    $roundedMenu.sliderVisible = [bool]$slider.IsVisible
    $roundedMenu.sliderStaysOpen = [bool]$sliderRow.StaysOpenOnClick
    $slider.Value = 1.15
    $roundedMenu.sliderChanged = ([Math]::Abs([double]$Config.Scale - 1.15) -lt 0.001)
    $scaleMenu.IsSubmenuOpen = $false
    $appearanceMenu.IsSubmenuOpen = $false
    $menu.IsOpen = $false
    $poseBeforeChoice = $poseRows | Where-Object { $_.IsChecked } | Select-Object -First 1
    $nextPoseChoice = $poseRows | Where-Object { $_ -ne $poseBeforeChoice } | Select-Object -First 1
    $menuClick = [System.Windows.Controls.MenuItem]::ClickEvent
    $nextPoseChoice.RaiseEvent([System.Windows.RoutedEventArgs]::new($menuClick))
    $roundedMenu.poseChangedInPlace = ([object]::ReferenceEquals($Window.ContextMenu, $menu) -and $Config.Pose -eq $nextPoseChoice.Tag -and $nextPoseChoice.IsChecked -and -not $poseBeforeChoice.IsChecked)
    $poseBeforeChoice.RaiseEvent([System.Windows.RoutedEventArgs]::new($menuClick))
    $taskSoundBefore = ($Config.TaskCompleteSoundEnabled -ne $false)
    $script:WpfTaskSoundMenuItem.RaiseEvent([System.Windows.RoutedEventArgs]::new($menuClick))
    $roundedMenu.taskSoundChangedInPlace = ([object]::ReferenceEquals($Window.ContextMenu, $menu) -and [bool]$script:WpfTaskSoundMenuItem.IsChecked -eq (-not $taskSoundBefore))
    $script:WpfTaskSoundMenuItem.RaiseEvent([System.Windows.RoutedEventArgs]::new($menuClick))

    # WinForms preferred popup width must contain item rows and the custom right-side check.
    $trayMenus = @($script:TrayMenu)
    for ($index = 0; $index -lt $trayMenus.Count; $index++) {
        $strip = $trayMenus[$index]
        $size = $strip.GetPreferredSize([System.Drawing.Size]::Empty)
        $strip.Size = $size
        $strip.PerformLayout()
        foreach ($item in $strip.Items) {
            if ($item -isnot [System.Windows.Forms.ToolStripMenuItem]) { continue }
            if ($item.Bounds.Right -gt $strip.ClientSize.Width) {
                throw "Tray menu item outside viewport: $($item.Text)"
            }
            if ($item.HasDropDownItems) { $trayMenus += $item.DropDown }
        }
    }
    $roundedMenu.trayMenuCount = $trayMenus.Count

    $roundedMenu.trayToggleRemoved = ($null -eq $script:TrayMenu.Tag.TrayEnabled)
    if ($script:NotifyIcon) {
        $script:NotifyIcon.Visible = $false
        $script:NotifyIcon.Dispose()
        $script:NotifyIcon = $null
    }
    $Window.ContextMenu.PlacementTarget = $Window
    $Window.ContextMenu.IsOpen = $true
    Pump-Wpf
    $fallback = $Window.ContextMenu.Items | Where-Object { $_.Header -eq '气泡默认偏好' }
    $roundedMenu.bubbleDefaultWithoutTray = [string]$fallback.Visibility
    $Window.ContextMenu.IsOpen = $false

    # Case 21: manual quota requests keep their panel through updates and expire after reading.
    Set-HoverDetailsEnabled $false
    $Config.TrayEnabled = $true
    Initialize-TrayIcon
    Build-ContextMenu
    function global:Request-QuotaRefresh {
        $script:refreshingUntil = [DateTime]::UtcNow.AddSeconds(14)
    }
    function global:Request-BalanceRefresh([switch]$Silent) {
        $script:balanceRequestTimeout = [DateTime]::UtcNow.AddSeconds(15)
        $script:balanceRequestStartedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $manualInspection = [ordered]@{ entries = @(); lifecycle = @(); transitions = @() }
    $defaultModeBeforeInspection = [string]$Config.BubbleMode
    $trayBubble = $script:TrayMenu.Items | Where-Object { $_.Text -eq '气泡看板' }
    $trayCredentials = $script:TrayMenu.Items | Where-Object { $_.Text -eq 'DeepSeek 凭据管理' }
    $entryCases = @(
        @{ Name = 'wpf-quota'; Mode = 'quota'; Item = ($Window.ContextMenu.Items | Where-Object { $_.Header -eq '查看并刷新 Codex 额度' }) },
        @{ Name = 'wpf-deepseek'; Mode = 'deepseek'; Item = ($Window.ContextMenu.Items | Where-Object { $_.Header -eq '查看并刷新 DeepSeek 余额' }) },
        @{ Name = 'tray-quota'; Mode = 'quota'; Item = ($trayBubble.DropDownItems | Where-Object { $_.Text -eq 'Codex 额度' }) },
        @{ Name = 'tray-deepseek'; Mode = 'deepseek'; Item = ($trayBubble.DropDownItems | Where-Object { $_.Text -eq 'DeepSeek 余额' }) },
        @{ Name = 'tray-refresh'; Mode = 'deepseek'; Item = ($trayCredentials.DropDownItems | Where-Object { $_.Text -eq '立即刷新 DeepSeek 余额' }) },
        @{ Name = 'button-quota'; Mode = 'quota'; Item = $RefreshQuotaBtn },
        @{ Name = 'button-deepseek'; Mode = 'deepseek'; Item = $RefreshDeepSeekBtn }
    )
    foreach ($entry in $entryCases) {
        Stop-UserBubbleInspection
        Set-WorkPayload -source 'Codex' -task 'checking a manual query'
        $script:manualBubbleHidden = $true
        if ($entry.Item -is [System.Windows.Forms.ToolStripMenuItem]) {
            $entry.Item.PerformClick()
        } elseif ($entry.Item -is [System.Windows.Controls.MenuItem]) {
            $entry.Item.RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
        } else {
            $entry.Item.RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.Primitives.ButtonBase]::ClickEvent))
        }
        $afterClick = [string]$script:currentBubblePanel
        Set-WorkPayload -source 'Codex' -task 'working update during query'
        $manualInspection.entries += [ordered]@{
            name = $entry.Name; expected = $entry.Mode; afterClick = $afterClick
            afterStatus = [string]$script:currentBubblePanel
            active = [string]$script:userInspectPanel
            hidden = [bool]$script:manualBubbleHidden
        }
    }
    foreach ($mode in @('quota', 'deepseek')) {
        Stop-UserBubbleInspection
        Set-WorkPayload -source 'Codex' -task 'reading a manual query'
        Start-UserBubbleInspection $mode
        $inspectionNow = [DateTime]::UtcNow
        Update-UserBubbleInspection $inspectionNow $false
        $pendingProtected = ($script:currentBubblePanel -eq $mode)
        if ($mode -eq 'quota') {
            $script:refreshingUntil = [DateTime]::MinValue
        } else {
            $attemptMs = $script:balanceRequestStartedMs
            Receive-BalanceSnapshot ([pscustomobject]@{ status = 'loading'; lastAttemptAt = $attemptMs })
            Update-UserBubbleInspection $inspectionNow $false
            if (-not $script:balanceRequestTimeout) { throw 'loading ended the active balance request' }
            Receive-BalanceSnapshot ([pscustomobject]@{
                status = 'ok'; lastAttemptAt = ($attemptMs - 1000); updatedAt = ($attemptMs - 1000)
                balances = @([pscustomobject]@{currency = 'CNY'; totalBalance = '12.00'})
            })
            if (-not $script:balanceRequestTimeout) { throw 'old balance result ended the active request' }
            Receive-BalanceSnapshot ([pscustomobject]@{
                status = 'ok'; lastAttemptAt = $attemptMs; updatedAt = $attemptMs
                balances = @([pscustomobject]@{currency = 'CNY'; totalBalance = '12.00'})
            })
        }
        Update-UserBubbleInspection $inspectionNow $false
        $readingSeconds = ($script:userInspectUntil - $inspectionNow).TotalSeconds
        Update-UserBubbleInspection $inspectionNow.AddSeconds(20) $true
        $hoverProtected = ($script:currentBubblePanel -eq $mode)
        Update-UserBubbleInspection $inspectionNow.AddSeconds(21) $false
        $leaveSeconds = ($script:userInspectUntil - $inspectionNow.AddSeconds(21)).TotalSeconds
        Update-UserBubbleInspection $inspectionNow.AddSeconds(24) $false
        $manualInspection.lifecycle += [ordered]@{
            mode = $mode; pendingProtected = $pendingProtected; readingSeconds = $readingSeconds
            hoverProtected = $hoverProtected; leaveSeconds = $leaveSeconds
            afterExpiry = [string]$script:currentBubblePanel
        }
    }
    foreach ($transition in @('idle', 'stale', 'pause', 'waiting', 'approval')) {
        Stop-UserBubbleInspection
        Set-WorkPayload -source 'Codex' -task 'starting a transition check'
        Start-UserBubbleInspection 'quota'
        switch ($transition) {
            'idle' { Apply-AgentStatus ([pscustomobject]@{state = 'idle'}) }
            'stale' { Apply-AgentStatus ([pscustomobject]@{state = 'working'; at = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 60000)}) }
            'pause' {
                $Config.PauseMonitorUntil = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 60000
                Apply-AgentStatus ([pscustomobject]@{state = 'working'})
                $Config.PauseMonitorUntil = 0
            }
            default { Set-WorkPayload -source 'Codex' -state $transition -task 'attention required' }
        }
        $manualInspection.transitions += [ordered]@{
            state = $transition; panel = [string]$script:currentBubblePanel
            active = [string]$script:userInspectPanel; open = [bool]$script:isBubbleOpen
            busy = [bool]$script:agentBusy
        }
    }
    $manualInspection.defaultUnchanged = ([string]$Config.BubbleMode -eq $defaultModeBeforeInspection)
    Set-WorkPayload -source 'Codex' -task 'checking idle expiry'
    Start-UserBubbleInspection 'quota'
    $script:refreshingUntil = [DateTime]::MinValue
    $idleReadingNow = [DateTime]::UtcNow
    Update-UserBubbleInspection $idleReadingNow $false
    Apply-AgentStatus ([pscustomobject]@{state = 'idle'})
    Update-UserBubbleInspection $idleReadingNow.AddSeconds(6) $false
    $manualInspection.idleExpired = (-not $script:isBubbleOpen -and -not $script:userInspectPanel)
    Set-WorkPayload -source 'Codex' -task 'checking explicit choices'
    Start-UserBubbleInspection 'quota'
    Set-ActiveBubblePanel 'quote'
    $manualInspection.panelChangeCancels = (-not $script:userInspectPanel)
    Start-UserBubbleInspection 'quota'
    Hide-Bubble
    $manualInspection.hideCancels = (-not $script:userInspectPanel)
    Set-WorkPayload -source 'Codex' -state 'waiting' -task 'waiting already active'
    Start-UserBubbleInspection 'quota'
    $manualInspection.existingWaitingWins = ($script:currentBubblePanel -eq 'work' -and -not $script:userInspectPanel)
    Stop-UserBubbleInspection

    # Case 22: secondary refreshes renew protection, and sliders commit keyboard changes.
    $repositoryAst = [System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(ps1Path)}, [ref]$tokens, [ref]$parseErrors)
    $realBalanceRefresh = $repositoryAst.Find({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Request-BalanceRefresh'
    }, $true)
    Set-Item Function:global:Request-BalanceRefresh -Value $realBalanceRefresh.Body.GetScriptBlock()
    Set-WorkPayload -source 'Codex' -task 'checking a second request'
    $script:userInspectPanel = 'deepseek'
    $script:userInspectUntil = [DateTime]::UtcNow.AddSeconds(5)
    Set-ActiveBubblePanel 'deepseek'
    $previousReadingDeadline = $script:userInspectUntil
    $script:lastBalanceRefreshRequestTime = [DateTime]::UtcNow.AddSeconds(-11)
    $script:TrayMenu.Tag.DshEnable.Checked = $false
    $script:TrayMenu.Tag.DshEnable.PerformClick()
    $secondRequestTime = $previousReadingDeadline.AddSeconds(1)
    Update-UserBubbleInspection $secondRequestTime $false
    $renewedInspection = [ordered]@{
        requestWritten = (Test-Path -LiteralPath $RefreshBalanceFlagPath)
        requestStillPending = ($script:balanceRequestTimeout -gt $secondRequestTime)
        deadlineSuspended = ($script:userInspectUntil -eq [DateTime]::MaxValue)
    }
    if ($script:agentBusy -and $secondRequestTime -ge $script:userInspectUntil) {
        Set-ActiveBubblePanel 'work'
    }
    $renewedInspection.panelDuringRequest = [string]$script:currentBubblePanel
    Receive-BalanceSnapshot ([pscustomobject]@{
        status = 'ok'; lastAttemptAt = $script:balanceRequestStartedMs
        balances = @([pscustomobject]@{currency = 'CNY'; totalBalance = '12.00'})
    })
    Update-UserBubbleInspection $secondRequestTime $false
    $renewedInspection.readingSeconds = ($script:userInspectUntil - $secondRequestTime).TotalSeconds
    Stop-UserBubbleInspection

    $realSaveConfig = $repositoryAst.Find({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Save-Config'
    }, $true)
    if ($BaseDir -eq 'D:\AgentPet') { throw 'Slider persistence must use the isolated configuration' }
    Set-Item Function:global:Save-Config -Value $realSaveConfig.Body.GetScriptBlock()
    function Send-AttachedMenuKey($target, [System.Windows.Input.Key]$key) {
        $inputSource = [System.Windows.PresentationSource]::FromVisual($target)
        if (-not $inputSource) { throw 'Keyboard event target is detached from its popup' }
        $keyEventArgs = [System.Windows.Input.KeyEventArgs]::new([System.Windows.Input.Keyboard]::PrimaryDevice,
            $inputSource, 0, $key)
        $keyEventArgs.RoutedEvent = [System.Windows.Input.Keyboard]::KeyDownEvent
        $target.RaiseEvent($keyEventArgs)
        Pump-Wpf
    }
    $sliderPersistence = @()
    foreach ($scenario in @('keyboard-event', 'unfocused-value')) {
      foreach ($kind in @('scale', 'volume')) {
        $Config.Scale = 1.0
        $Config.SoundVolume = 500
        Save-Config
        Build-ContextMenu
        $cm = $Window.ContextMenu
        $cm.PlacementTarget = $Window
        $cm.IsOpen = $true
        Pump-Wpf
        if ($kind -eq 'scale') {
            $category = $cm.Items | Where-Object { $_.Header -eq '外观' }
            $category.IsSubmenuOpen = $true
            Pump-Wpf
            $sliderMenu = $category.Items[0]
            $sliderIndex = 0
        } else {
            $sliderMenu = $cm.Items | Where-Object { $_.Header -eq '音效与音量' }
            $sliderIndex = 1
        }
        $sliderMenu.IsSubmenuOpen = $true
        Pump-Wpf
        $keyboardSlider = $sliderMenu.Items[$sliderIndex].Header.Children[0]
        $beforeKey = $keyboardSlider.Value
        if ($scenario -eq 'keyboard-event') {
            # Exercise the real key handler using the visible popup's input source.
            # Desktop activation and physical keyboard focus are separate acceptance checks.
            Send-AttachedMenuKey $keyboardSlider ([System.Windows.Input.Key]::Right)
        } else {
            if ($keyboardSlider.IsKeyboardFocusWithin) { throw 'Unfocused save scenario requires an unfocused slider' }
            $keyboardSlider.Value += $keyboardSlider.TickFrequency
            Pump-Wpf
        }
        $afterKey = $keyboardSlider.Value
        $closeSignal = @{ Observed = $false }
        $closedHandler = [System.Windows.RoutedEventHandler]({ $closeSignal.Observed = $true }.GetNewClosure())
        $cm.Add_Closed($closedHandler)
        try {
            $cm.IsOpen = $false
            # Popup animations may defer Closed beyond the next dispatcher frame.
            $closeDeadline = [DateTime]::UtcNow.AddSeconds(2)
            while (-not $closeSignal.Observed -and [DateTime]::UtcNow -lt $closeDeadline) {
                Pump-Wpf 20
            }
            if (-not $closeSignal.Observed) { throw 'Context menu did not raise Closed within two seconds' }
        } finally {
            $cm.Remove_Closed($closedHandler)
        }
        $diskConfig = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $sliderPersistence += [ordered]@{
            kind = $kind; scenario = $scenario; changed = ($afterKey -gt $beforeKey); closed = (-not $cm.IsOpen)
            expected = $afterKey
            actual = if ($kind -eq 'scale') { $diskConfig.Scale } else { $diskConfig.SoundVolume }
        }
      }
    }
    Build-ContextMenu
    $scalePresets = $Window.ContextMenu.Items | Where-Object { $_.Header -eq '外观' }
    $scalePresets = $scalePresets.Items[0]
    $presetSlider = $scalePresets.Items[0].Header.Children[0]
    $presetSlider.Value = 1.15
    $checksAt115 = @($scalePresets.Items | Where-Object { $_.IsCheckable -and $_.IsChecked } | ForEach-Object { [string]$_.Header })
    $presetSlider.Value = 1.10
    $checksAt110 = @($scalePresets.Items | Where-Object { $_.IsCheckable -and $_.IsChecked } | ForEach-Object { [string]$_.Header })
    Save-PendingSliderConfig

    # Case 23: v1.6.2 fix verification (FIX-01 busy hide, FIX-02 busy quote/hover/cycle/idle, FIX-03 manualBubbleHidden, FIX-04 balance write/display)
    $tickHook = $repositoryAst.Find({ param($node)
        $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
        $node.Member.Value -eq 'Add_Tick' -and $node.Expression.Extent.Text -eq '$Timer'
    }, $true)
    if (-not $tickHook) { throw 'Production timer tick hook was not found' }
    $tickSb = [scriptblock]::Create($tickHook.Arguments[0].ScriptBlock.Extent.Text.Trim('{}'))
    function Invoke-ProdTimerTick {
        $script:monitorStartTime = [DateTime]::UtcNow
        $script:lastStatusHeartbeatMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        & $tickSb
        Pump-Wpf
    }
    function Invoke-LeftClickUp($el) {
        $ev = [System.Windows.Input.MouseButtonEventArgs]::new([System.Windows.Input.Mouse]::PrimaryDevice, 0, [System.Windows.Input.MouseButton]::Left)
        $ev.RoutedEvent = [System.Windows.UIElement]::MouseLeftButtonUpEvent
        $el.RaiseEvent($ev)
        Pump-Wpf
    }
    function global:Request-QuotaRefresh {}
    $case23BackupFlag = $RefreshBalanceFlagPath
    $case23TempBalanceFlag = Join-Path $BaseDir 'case23-refresh-balance.flag'
    $RefreshBalanceFlagPath = $case23TempBalanceFlag
    $Config.Pose = 'auto'
    $Config.BubbleMode = 'quota'
    $Config.AutoQuoteMinutes = 0
    $script:manualBubbleHidden = $false
    Stop-UserBubbleInspection
    $trayHideBubble = $script:TrayMenu.Tag.BubbleHide
    $trayQuoteItem = ($script:TrayMenu.Items | Where-Object { $_.Text -eq '气泡看板' }).DropDownItems | Where-Object { $_.Text -eq '随机台词' } | Select-Object -First 1

    # FIX-01: busy + quota/deepseek -> tray Hide Bubble stays hidden across timer ticks & working updates, but approval still opens
    Set-WorkPayload -source 'Codex' -task 'busy hide regression check'
    Start-UserBubbleInspection 'quota'
    Pump-Wpf
    $trayHideBubble.PerformClick()
    Pump-Wpf
    $busyHideOpenAfterClick = [bool]$script:isBubbleOpen
    $busyHideFlagAfterClick = [bool]$script:manualBubbleHidden
    Invoke-ProdTimerTick
    Invoke-ProdTimerTick
    Set-WorkPayload -source 'Codex' -task 'working pulse after manual hide'
    Invoke-ProdTimerTick
    $busyHideOpenAfterTick = [bool]$script:isBubbleOpen
    $busyHideFlagAfterTick = [bool]$script:manualBubbleHidden
    $busyHideWorkVisAfterTick = [string]$WorkStatusPanel.Visibility
    Set-WorkPayload -source 'Codex' -state 'approval' -task 'approval must wake work'
    Pump-Wpf
    $busyHideApprovalOpen = [bool]$script:isBubbleOpen
    $busyHideApprovalPanel = [string]$script:currentBubblePanel

    # FIX-02: busy quote across 4 entry paths, tick/status retention, hover +2s, quote->quota->deepseek click cycle, busy->idle preserve, approval guard
    $script:manualBubbleHidden = $false
    Set-WorkPayload -source 'Codex' -task 'busy quote survival check'
    $quoteEntries = @()
    foreach ($qEntry in @('tray-quote', 'wpf-quote', 'wpf-char-switch', 'bubble-cycle')) {
        Set-WorkPayload -source 'Codex' -task ("entry " + $qEntry)
        if ($qEntry -eq 'tray-quote') {
            $trayQuoteItem.PerformClick()
        } elseif ($qEntry -eq 'wpf-quote') {
            $wpfQuote = $Window.ContextMenu.Items | Where-Object { $_.Header -eq '随机台词' } | Select-Object -First 1
            $wpfQuote.RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
        } elseif ($qEntry -eq 'wpf-char-switch') {
            $wpfRoles = $Window.ContextMenu.Items | Where-Object { $_.Header -eq '切换角色' } | Select-Object -First 1
            $altRole = $wpfRoles.Items | Where-Object { [string]$_.Tag -ne [string]$Config.Character } | Select-Object -First 1
            $altRole.RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
        } else {
            Start-UserBubbleInspection 'deepseek'
            Pump-Wpf
            Invoke-LeftClickUp $Bubble
        }
        Pump-Wpf
        $panelInit = [string]$script:currentBubblePanel
        Invoke-ProdTimerTick
        Set-WorkPayload -source 'Codex' -task ("pulse " + $qEntry)
        Invoke-ProdTimerTick
        $quoteEntries += [ordered]@{
            entry = $qEntry
            panelInit = $panelInit
            panelAfterTick = [string]$script:currentBubblePanel
            openAfterTick = [bool]$script:isBubbleOpen
            hiddenAfterTick = [bool]$script:manualBubbleHidden
        }
    }
    # From active busy 'quote', clicking Bubble blank cycles quote -> quota -> deepseek with Start-UserBubbleInspection
    Show-TemporaryQuoteBubble 'claude' 5.5
    Pump-Wpf
    Invoke-LeftClickUp $Bubble
    $cycleQuoteToQuota = [ordered]@{ panel = [string]$script:currentBubblePanel; active = [string]$script:userInspectPanel }
    Invoke-LeftClickUp $Bubble
    $cycleQuotaToDeepSeek = [ordered]@{ panel = [string]$script:currentBubblePanel; active = [string]$script:userInspectPanel }

    # Hover extension (+2s) on temporary quote, 2s grace after leave, & clean expiration back to work
    Show-TemporaryQuoteBubble 'claude' 5.5
    $quoteStartDeadline = $script:userInspectUntil
    $quoteHoverAt = $quoteStartDeadline.AddSeconds(-0.3)
    Update-TemporaryQuoteInspection $quoteHoverAt $true
    $quoteExtendedSeconds = ($script:userInspectUntil - $quoteStartDeadline).TotalSeconds
    $quoteLeaveAt = $quoteHoverAt.AddSeconds(1.0)
    Update-TemporaryQuoteInspection $quoteLeaveAt $false
    $quoteLeaveSeconds = ($script:userInspectUntil - $quoteLeaveAt).TotalSeconds
    $quoteDuringLeavePanel = [string]$script:currentBubblePanel
    Update-TemporaryQuoteInspection ($quoteLeaveAt.AddSeconds(2.1)) $false
    $quoteExpiredPanel = [string]$script:currentBubblePanel

    # Busy -> Idle/Pause/Stale/Watchdog -> Re-enter Working preserves full 5.5s temporary quote protection (R-01)
    $quoteReenterChecks = @()
    foreach ($endReason in @('idle', 'pause', 'stale', 'watchdog')) {
        Set-WorkPayload -source 'Codex' -task ('pre-' + $endReason)
        Show-TemporaryQuoteBubble 'claude' 5.5
        if ($endReason -eq 'idle') {
            Apply-AgentStatus ([pscustomobject]@{ state = 'idle' })
            Invoke-ProdTimerTick
        } elseif ($endReason -eq 'pause') {
            $Config.PauseMonitorUntil = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 60000
            Apply-AgentStatus ([pscustomobject]@{ state = 'working'; task = 'paused' })
            $Config.PauseMonitorUntil = 0
            Invoke-ProdTimerTick
        } elseif ($endReason -eq 'stale') {
            Apply-AgentStatus ([pscustomobject]@{ state = 'working'; at = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 60000) })
            Invoke-ProdTimerTick
        } else {
            $script:monitorStartTime = [DateTime]::UtcNow.AddSeconds(-20)
            $script:MonitorProc = $null
            & $tickSb
            Pump-Wpf
            $script:monitorStartTime = [DateTime]::UtcNow
        }
        $panelAfterEnd = [string]$script:currentBubblePanel
        $openAfterEnd = [bool]$script:isBubbleOpen
        # Resume working well before 5.5s expires -> must NOT be overwritten by work
        Set-WorkPayload -source 'Codex' -task ('resume-' + $endReason)
        Invoke-ProdTimerTick
        $quoteReenterChecks += [ordered]@{
            reason = $endReason
            panelAfterEnd = $panelAfterEnd
            openAfterEnd = $openAfterEnd
            panelAfterResume = [string]$script:currentBubblePanel
            openAfterResume = [bool]$script:isBubbleOpen
        }
    }
    $quoteIdlePreservedPanel = $quoteReenterChecks[0].panelAfterEnd
    $quoteIdlePreservedOpen = $quoteReenterChecks[0].openAfterEnd

    # R-01 idleHoverMinimumHold: hovering at t+1s and leaving at t+1.5s while idle MUST NOT shorten 5.5s hold to 3.8s
    Set-WorkPayload -source 'Codex' -task 'hover min hold'
    Show-TemporaryQuoteBubble 'claude' 5.5
    $qT0 = $script:userInspectUntil.AddSeconds(-5.5)
    Apply-AgentStatus ([pscustomobject]@{ state = 'idle' })
    Invoke-ProdTimerTick
    Update-TemporaryQuoteInspection ($qT0.AddSeconds(1.0)) $true
    Update-TemporaryQuoteInspection ($qT0.AddSeconds(1.5)) $false
    Update-TemporaryQuoteInspection ($qT0.AddSeconds(4.0)) $false
    $quoteIdleAt4sPanel = [string]$script:currentBubblePanel
    $quoteIdleAt4sOpen = [bool]$script:isBubbleOpen
    Update-TemporaryQuoteInspection ($qT0.AddSeconds(5.6)) $false
    $quoteIdleEventuallyClosed = (-not $script:isBubbleOpen -and -not $script:quoteInspectActive)

    # Waiting/approval refuses to be overwritten by quote or character-switch greeting
    Set-WorkPayload -source 'Codex' -state 'approval' -task 'approval must block quote'
    $trayQuoteItem.PerformClick()
    Pump-Wpf
    $quoteBlockedByApprovalPanel = [string]$script:currentBubblePanel
    $wpfRoles2 = $Window.ContextMenu.Items | Where-Object { $_.Header -eq '切换角色' } | Select-Object -First 1
    ($wpfRoles2.Items | Where-Object { [string]$_.Tag -ne [string]$Config.Character } | Select-Object -First 1).RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
    Pump-Wpf
    $charBlockedByApprovalPanel = [string]$script:currentBubblePanel

    # FIX-03: idle Auto-Quotes suppressed when hidden; all explicit reopen actions clear manualBubbleHidden
    Apply-AgentStatus ([pscustomobject]@{ state = 'idle' })
    Stop-UserBubbleInspection
    $trayHideBubble.PerformClick()
    Pump-Wpf
    $Config.AutoQuoteMinutes = 3
    $script:lastAutoQuoteTime = [DateTime]::UtcNow.AddMinutes(-5)
    Invoke-ProdTimerTick
    $idleAutoQuoteBlocked = (-not $script:isBubbleOpen -and [bool]$script:manualBubbleHidden)
    $Config.AutoQuoteMinutes = 0

    $reopenClearsHide = @()
    foreach ($reopenKind in @('wpf-quote', 'wpf-char-switch', 'pet-click', 'bubble-scale-preset', 'font-scale-preset')) {
        Apply-AgentStatus ([pscustomobject]@{ state = 'idle' })
        Stop-UserBubbleInspection
        $trayHideBubble.PerformClick()
        Pump-Wpf
        if (-not $script:manualBubbleHidden) { throw ("Precondition manualBubbleHidden failed for " + $reopenKind) }
        if ($reopenKind -eq 'wpf-quote') {
            ($Window.ContextMenu.Items | Where-Object { $_.Header -eq '随机台词' } | Select-Object -First 1).RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
        } elseif ($reopenKind -eq 'wpf-char-switch') {
            $rolesMenu = $Window.ContextMenu.Items | Where-Object { $_.Header -eq '切换角色' } | Select-Object -First 1
            ($rolesMenu.Items | Where-Object { [string]$_.Tag -ne [string]$Config.Character } | Select-Object -First 1).RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
        } elseif ($reopenKind -eq 'pet-click') {
            $script:isDragging = $false
            Invoke-LeftClickUp $PetImage
        } elseif ($reopenKind -eq 'bubble-scale-preset') {
            $appMenu = $Window.ContextMenu.Items | Where-Object { $_.Header -eq '外观' } | Select-Object -First 1
            $bsMenu = $appMenu.Items[1]
            $bsMenu.Items[2].RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
        } else {
            $appMenu = $Window.ContextMenu.Items | Where-Object { $_.Header -eq '外观' } | Select-Object -First 1
            $fsMenu = $appMenu.Items[2]
            $fsMenu.Items[2].RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
        }
        Pump-Wpf
        $reopenClearsHide += [ordered]@{
            kind = $reopenKind
            hidden = [bool]$script:manualBubbleHidden
            open = [bool]$script:isBubbleOpen
        }
    }

    # FIX-04 frontend: Request-BalanceRefresh write error does not consume cooldown or lock 15s timeout; Apply-BalanceObject empty COOLDOWN/RATE_LIMITED
    $balanceUiCases = [ordered]@{}
    try {
        $unwritableDir = Join-Path $BaseDir 'case23-flag-dir'
        New-Item -ItemType Directory -Path $unwritableDir -Force | Out-Null
        $RefreshBalanceFlagPath = $unwritableDir
        $script:lastBalanceRefreshRequestTime = [DateTime]::MinValue
        $script:balanceRequestTimeout = $null
        $script:balanceRequestStartedMs = [long]0
        Request-BalanceRefresh
        $balanceUiCases.failNotice = [string]$DeepSeekStatusNotice.Text
        $balanceUiCases.failTimeoutNull = ($null -eq $script:balanceRequestTimeout)
        $balanceUiCases.failStartZero = ($script:balanceRequestStartedMs -eq 0)
        $balanceUiCases.failDidNotConsumeCooldown = ($script:lastBalanceRefreshRequestTime -eq [DateTime]::MinValue)
        # Immediate retry after write succeeds must NOT hit cooldown
        $RefreshBalanceFlagPath = $case23TempBalanceFlag
        Request-BalanceRefresh
        $balanceUiCases.retryNotice = [string]$DeepSeekStatusNotice.Text
        $balanceUiCases.retryFlagWritten = (Test-Path -LiteralPath $case23TempBalanceFlag)
        $balanceUiCases.retryTimeoutArmed = ($null -ne $script:balanceRequestTimeout -and $script:balanceRequestStartedMs -gt 0)
    } finally {
        $RefreshBalanceFlagPath = $case23BackupFlag
        $script:balanceRequestTimeout = $null
        $script:balanceRequestStartedMs = [long]0
    }
    Apply-BalanceObject ([pscustomobject]@{
        type = 'balance'; status = 'error'; balances = @()
        errorCode = 'COOLDOWN'; errorMessage = '刷新过于频繁，请等待 7 秒后再试'
    })
    $balanceUiCases.emptyCooldownNotice = [string]$DeepSeekStatusNotice.Text
    $balanceUiCases.emptyCooldownTitle = [string]$DeepSeekMsgTitle.Text
    $balanceUiCases.emptyCooldownDetail = [string]$DeepSeekMsgDetail.Text
    Apply-BalanceObject ([pscustomobject]@{
        type = 'balance'; status = 'stale'; balances = @()
        errorCode = 'RATE_LIMITED'; errorMessage = '请求频率超限，重试需等待 12 秒'
    })
    $balanceUiCases.emptyRateNotice = [string]$DeepSeekStatusNotice.Text
    $balanceUiCases.emptyRateTitle = [string]$DeepSeekMsgTitle.Text
    $balanceUiCases.emptyRateDetail = [string]$DeepSeekMsgDetail.Text

    $case23Regression = [ordered]@{
        busyHide = [ordered]@{
            openAfterClick = $busyHideOpenAfterClick
            flagAfterClick = $busyHideFlagAfterClick
            openAfterTick = $busyHideOpenAfterTick
            flagAfterTick = $busyHideFlagAfterTick
            workVisAfterTick = $busyHideWorkVisAfterTick
            approvalOpen = $busyHideApprovalOpen
            approvalPanel = $busyHideApprovalPanel
        }
        busyQuote = [ordered]@{
            entries = $quoteEntries
            cycleQuoteToQuota = $cycleQuoteToQuota
            cycleQuotaToDeepSeek = $cycleQuotaToDeepSeek
            extendedSeconds = [Math]::Round($quoteExtendedSeconds, 2)
            leaveSeconds = [Math]::Round($quoteLeaveSeconds, 2)
            duringLeavePanel = $quoteDuringLeavePanel
            expiredPanel = $quoteExpiredPanel
            idlePreservedPanel = $quoteIdlePreservedPanel
            idlePreservedOpen = $quoteIdlePreservedOpen
            reenterChecks = $quoteReenterChecks
            idleAt4sPanel = $quoteIdleAt4sPanel
            idleAt4sOpen = $quoteIdleAt4sOpen
            idleEventuallyClosed = $quoteIdleEventuallyClosed
            quoteBlockedByApproval = $quoteBlockedByApprovalPanel
            charBlockedByApproval = $charBlockedByApprovalPanel
        }
        hiddenRules = [ordered]@{
            idleAutoQuoteBlocked = $idleAutoQuoteBlocked
            reopenEntries = $reopenClearsHide
        }
        balanceUi = $balanceUiCases
    }

    # Case 24: the quote action, large text budgets, and rendered refresh targets.
    $Config.Character = 'claude'
    $Config.Scale = 1.0
    $Config.FontScale = 1.0
    $Config.BubbleScale = 1.0
    Update-Theme
    Update-Scale
    Update-FontScale
    Update-BubbleScale
    Set-WorkPayload -source 'Codex' -task 'quote action during work'
    Show-TemporaryQuoteBubble
    Pump-Wpf
    $QuoteText.Text = '用于确认换句后的旧语录'
    $previousQuote = [string]$QuoteText.Text
    $previousDeadline = [DateTime]::UtcNow.AddSeconds(0.75)
    $script:userInspectUntil = $previousDeadline
    $script:bubbleCloseTime = $previousDeadline
    $quoteClick = [System.Windows.RoutedEventArgs]::new([System.Windows.Controls.Primitives.ButtonBase]::ClickEvent)
    $QuoteHintBadge.RaiseEvent($quoteClick)
    Pump-Wpf
    $batchOne = [ordered]@{
        quoteButton = ($QuoteHintBadge -is [System.Windows.Controls.Button])
        quoteClickHandled = $quoteClick.Handled
        quoteChanged = (-not [string]::IsNullOrWhiteSpace($QuoteText.Text) -and $QuoteText.Text -cne $previousQuote)
        quotePanelAfterClick = [string]$script:currentBubblePanel
        quoteRenewal = ($script:userInspectUntil - $previousDeadline).TotalSeconds
        closeRenewal = ($script:bubbleCloseTime - $previousDeadline).TotalSeconds
        liveFontSwitches = @()
        fontLayouts = @()
        refreshTargets = @()
    }
    # Raise the underlying mouse event from the text so WPF routes LeftButtonUp to ancestors.
    $quoteTextMouseUp = [System.Windows.Input.MouseButtonEventArgs]::new([System.Windows.Input.Mouse]::PrimaryDevice, 0, [System.Windows.Input.MouseButton]::Left)
    $quoteTextMouseUp.RoutedEvent = [System.Windows.Input.Mouse]::MouseUpEvent
    $QuoteText.RaiseEvent($quoteTextMouseUp)
    Pump-Wpf
    $batchOne.quotePanelAfterTextClick = [string]$script:currentBubblePanel
    Set-WorkPayload -source 'Codex' -task 'work update while reading replacement quote'
    $batchOne.quotePanelAfterWork = [string]$script:currentBubblePanel
    $blankMouseUp = [System.Windows.Input.MouseButtonEventArgs]::new([System.Windows.Input.Mouse]::PrimaryDevice, 0, [System.Windows.Input.MouseButton]::Left)
    $blankMouseUp.RoutedEvent = [System.Windows.Input.Mouse]::MouseUpEvent
    $BubbleBorder.RaiseEvent($blankMouseUp)
    Pump-Wpf
    $batchOne.panelAfterBlankClick = [string]$script:currentBubblePanel

    function Get-RenderedBounds($element, $ancestor) {
        return $element.TransformToAncestor($ancestor).TransformBounds(
            [System.Windows.Rect]::new(0, 0, $element.ActualWidth, $element.ActualHeight)
        )
    }
    function Test-RefreshTargetAt($button, [System.Windows.Point]$point) {
        $hit = $Window.InputHitTest($point)
        while ($hit) {
            if ($hit -eq $button) { return $true }
            $hit = if ($hit -is [System.Windows.Media.Visual]) {
                [System.Windows.Media.VisualTreeHelper]::GetParent($hit)
            } else {
                [System.Windows.LogicalTreeHelper]::GetParent($hit)
            }
        }
        return $false
    }
    $sceneText = $Window.FindName('SceneText')
    $longQuote = '先把前因后果摸清楚，省得待会儿耽误我打盹。等看板里的进度都对上了，我就回来继续和你聊今天发生的趣事。'
    Stop-UserBubbleInspection
    Apply-AgentStatus ([pscustomobject]@{ state = 'idle' })
    foreach ($fontPanel in @('quote', 'quota')) {
        $Config.FontScale = 1.0
        Update-FontScale
        Set-ActiveBubblePanel $fontPanel
        Show-Bubble 0 -Force
        $originalBottom = [System.Windows.Controls.Canvas]::GetTop($Bubble) + $BubbleBorder.ActualHeight
        foreach ($fontPreset in @(1.15, 1.3, 1.4, 1.0)) {
            $Config.FontScale = $fontPreset
            Update-FontScale
            Show-ScalePreviewBubble
            Pump-Wpf
            $batchOne.liveFontSwitches += [ordered]@{
                panel = $fontPanel; activePanel = $script:currentBubblePanel; font = $fontPreset
                padding = $BubbleBorder.Padding.Top
                moved = ([Math]::Abs([System.Windows.Controls.Canvas]::GetTop($Bubble) + $BubbleBorder.ActualHeight - $originalBottom) -gt 0.8)
            }
        }
    }
    foreach ($fontScale in @(1.3, 1.4)) {
        $Config.FontScale = $fontScale
        Set-ActiveBubblePanel 'quote'
        Show-Bubble 0 -Force
        $QuoteText.Text = $longQuote
        Update-FontScale
        Pump-Wpf
        $quoteBounds = Get-RenderedBounds $QuoteText $sceneText
        $layout = [ordered]@{
            fontScale = $fontScale
            quoteLineHeight = [double]$QuoteText.LineHeight
            quoteHeight = $quoteBounds.Height
            quoteTop = $quoteBounds.Top
            quoteBottomGap = ($sceneText.ActualHeight - $quoteBounds.Bottom)
        }
        Set-ActiveBubblePanel 'quota'
        Pump-Wpf
        $weekBounds = Get-RenderedBounds $WeekTrack $sceneText
        $layout.weekTrackHeight = $weekBounds.Height
        $layout.weekTrackBottomGap = $sceneText.ActualHeight - $weekBounds.Bottom
        $layout.cardHeight = [double]$BubbleBorder.ActualHeight
        $batchOne.fontLayouts += $layout
    }
    foreach ($testBubbleScale in @(0.8, 1.0, 1.3)) {
        $Config.BubbleScale = $testBubbleScale
        Update-BubbleScale
        foreach ($fontScale in @(1.0, 1.4)) {
            $Config.FontScale = $fontScale
            Update-FontScale
            foreach ($mode in @('quota', 'deepseek')) {
                $button = if ($mode -eq 'quota') { $RefreshQuotaBtn } else { $RefreshDeepSeekBtn }
                Set-ActiveBubblePanel $mode
                Show-Bubble 0 -Force
                Pump-Wpf
                $bounds = Get-RenderedBounds $button $Window
                $centerX = ($bounds.Left + $bounds.Right) / 2.0
                $centerY = ($bounds.Top + $bounds.Bottom) / 2.0
                $cornersHit = $true
                foreach ($dx in @(-11.5, 11.5)) {
                    foreach ($dy in @(-11.5, 11.5)) {
                        $point = [System.Windows.Point]::new(($centerX + $dx), ($centerY + $dy))
                        if (-not (Test-RefreshTargetAt $button $point)) { $cornersHit = $false }
                    }
                }
                $batchOne.refreshTargets += [ordered]@{
                    mode = $mode; bubbleScale = $testBubbleScale; fontScale = $fontScale
                    width = $bounds.Width; height = $bounds.Height; cornersHit = $cornersHit
                }
            }
        }
    }

    # Case 25: colors as applied to WPF controls, text equivalents, and quota row geometry.
    $batchTwoReadability = [ordered]@{ colors = @(); alerts = @(); fullText = @(); stamps = @(); lineartStamps = @(); stampMenuSync = $null; progress = @() }
    $statusDeadline = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 7400
    function Set-TestQuotaRemaining([int]$shortLeft, [int]$weekLeft) {
        Apply-QuotaObject ([pscustomobject]@{
            planLabel = 'Enterprise'
            observedAt = [DateTimeOffset]::UtcNow.AddHours(-2).ToUnixTimeMilliseconds()
            windows = @(
                [pscustomobject]@{ id = 'fiveHour'; remaining = $shortLeft; resetsAt = $statusDeadline }
                [pscustomobject]@{ id = 'weekly'; remaining = $weekLeft; resetsAt = $statusDeadline }
            )
        })
    }
    function Measure-AppliedContrast($name, $foregroundColor, $backgroundColor, $baseColor, $threshold) {
        $batchTwoReadability.colors += [ordered]@{
            role = $Config.Character
            name = $name
            fg = [string]$foregroundColor
            bg = [string]$backgroundColor
            base = [string]$baseColor
            minimum = $threshold
        }
    }
    $Config.BubbleScale = 1.0
    Update-BubbleScale
    $Config.FontScale = 1.0
    Update-FontScale
    foreach ($testRole in @('claude','dragon','gemini','deepseek','zcode')) {
        $Config.Character = $testRole
        Update-Theme
        Set-ActiveBubblePanel 'quota'
        Set-TestQuotaRemaining 80 80
        Pump-Wpf
        $shortStamp = $Window.FindName('ShortQuotaStamp')
        $weekStamp = $Window.FindName('WeekQuotaStamp')
        $batchTwoReadability.stamps += [ordered]@{
            role = $testRole
            artwork = [System.IO.Path]::GetFileName($shortStamp.Source.UriSource.LocalPath)
            shared = [Object]::ReferenceEquals($shortStamp.Source, $weekStamp.Source)
            visible = $shortStamp.IsVisible -and $weekStamp.IsVisible
        }
        $testCardColor = $BubbleBorder.Background.Color
        foreach ($textItem in @($QuotaHeader,$ShortReset,$WeekReset)) {
            Measure-AppliedContrast $textItem.Name $textItem.Foreground.Color $testCardColor $testCardColor 4.5
        }
        Measure-AppliedContrast 'ShortBar' $ShortBar.Background.Color $ShortTrack.Background.Color $testCardColor 3
        Measure-AppliedContrast 'WeekBar' $WeekBar.Background.Color $WeekTrack.Background.Color $testCardColor 3
        Set-ActiveBubblePanel 'quote'
        Measure-AppliedContrast 'QuoteSpeaker' $QuoteSpeaker.Foreground.Color $testCardColor $testCardColor 4.5
        Set-ActiveBubblePanel 'deepseek'
        Apply-BalanceObject $okBal
        Pump-Wpf
        foreach ($testGradientStop in @($DeepSeekHeaderGradStop0,$DeepSeekHeaderGradStop1)) {
            Measure-AppliedContrast 'DeepSeekHeader' $DeepSeekHeader.Foreground.Color $testGradientStop.Color $testCardColor 4.5
            Measure-AppliedContrast 'DeepSeekStatusNotice' $DeepSeekStatusNotice.Foreground.Color $testGradientStop.Color $testCardColor 4.5
        }
        Measure-AppliedContrast 'DeepSeekFillBar' $DeepSeekFillBar.Background.Color $DeepSeekRatioTrack.Background.Color $testCardColor 3
        $hatch = $DeepSeekGrantBar.Background
        $paper = $hatch.Drawing.Children[0].Brush
        $ink = $hatch.Drawing.Children[1].Pen.Brush
        $theme = Get-CurrentTheme
        if ($hatch.TileMode -ne 'Tile' -or $ink.Color -ne $ColorConv.ConvertFromString($theme.GrantInk) -or
            $paper.Color -ne $ColorConv.ConvertFromString($theme.GrantPaper) -or $DeepSeekGrantDot.Stroke.Color -ne $ink.Color -or
            $DeepSeekGrantDot.Fill.Color.A -ne 0 -or $DeepSeekGrantText.Foreground.Color -ne $DeepSeekBreakdownText.Foreground.Color) {
            throw "Grant texture or legend mismatch for $testRole"
        }
        Measure-AppliedContrast 'DeepSeekGrantBar' $ink.Color $DeepSeekRatioTrack.Background.Color $testCardColor 3
        Measure-AppliedContrast 'DeepSeekGrantHatch' $ink.Color $paper.Color $testCardColor 3
    }

    # The same WPF window must handle sign-in changes without keeping values from the previous account.
    Set-ActiveBubblePanel 'quota'
    $next = [DateTimeOffset]::UtcNow.AddHours(3).ToUnixTimeSeconds()
    $weekly = [pscustomobject]@{ id='weekly'; remaining=42; resetsAt=$next }
    $plusWeek = [pscustomobject]@{ id='weekly'; remaining=71; resetsAt=($next + 86400) }
    $short = [pscustomobject]@{ id='fiveHour'; remaining=19; resetsAt=$next }
    foreach ($fs in @(1.0, 1.4)) {
        $Config.FontScale = $fs
        Update-FontScale
        foreach ($style in @('lineart','embossed')) {
            $Config.QuotaStampStyle = $style
            Update-Theme
            $size = [System.Windows.Size]::new($BubbleBorder.Width, $BubbleBorder.Height)
            foreach ($count in @(2,0)) {
                Apply-QuotaObject ([pscustomobject]@{ok=$true;planLabel='Pro';windows=@($weekly);resetCardCount=$count})
                Update-Theme
                Pump-Wpf
                if ($ShortLabel.Text -ne '重置卡' -or $QuotaShortCaption.Text -ne '可用张数' -or
                    $ShortPercentValue.Text -ne [string]$count -or $ShortPercentValue.NextInline.Text.Trim() -ne '张' -or
                    $ShortQuotaAlert.IsVisible -or $ShortTrack.IsVisible -or $ShortReset.IsVisible -or $WeekPercentValue.Text -ne '42' -or
                    -not $shortStamp.IsVisible -or -not $weekStamp.IsVisible) { throw "Pro row did not restore after account switch: $count" }
                $topX = $shortStamp.TranslatePoint([System.Windows.Point]::new($shortStamp.ActualWidth/2,0),$QuotaPanel).X
                $weekX = $weekStamp.TranslatePoint([System.Windows.Point]::new($weekStamp.ActualWidth/2,0),$QuotaPanel).X
                if ([Math]::Abs($topX - $weekX) -gt 0.1 -or $BubbleBorder.Width -ne $size.Width -or $BubbleBorder.Height -ne $size.Height) {
                    throw "Pro stamp alignment or dimensions changed at $fs"
                }
                Apply-QuotaObject ([pscustomobject]@{ok=$true;planLabel='Plus';windows=@($short,$plusWeek)})
                Pump-Wpf
                if ($QuotaPlanText.Text -ne 'Plus' -or $ShortLabel.Text -ne '5 小时' -or $ShortPercentValue.Text -ne '19' -or
                    $ShortPercentValue.NextInline.Text -ne '%' -or $WeekPercentValue.Text -ne '71' -or $WeekReset.Text -ne (Format-ResetCountdown $plusWeek.resetsAt) -or
                    -not $ShortTrack.IsVisible -or $ShortBar.ActualWidth -le 0 -or
                    -not $ShortReset.IsVisible -or $ShortReset.Text -notmatch '重置' -or -not $ShortQuotaAlert.IsVisible -or
                    $QuotaShortCaption.IsVisible -or $QuotaResetClock.IsVisible -or $ShortStubValueColumn.SharedSizeGroup) { throw "Stale Pro row after switching to Plus" }
            }
        }
        Apply-QuotaObject ([pscustomobject]@{ok=$true;planLabel='Pro';windows=@($weekly)})
        Pump-Wpf
        if (-not $QuotaResetClock.IsVisible -or $QuotaClockTime.Text -notmatch '^[0-9]{2}:[0-9]{2}$' -or $ShortLabel.Text -ne '下次重置') { throw 'Unknown count must use weekly reset time' }
        Apply-QuotaObject ([pscustomobject]@{ok=$true;planLabel='Pro';windows=@($short,$weekly);resetCardCount=2})
        Pump-Wpf
        if ($QuotaResetClock.IsVisible -or -not $ShortTrack.IsVisible -or $ShortLabel.Text -ne '5 小时') { throw 'A real five-hour limit takes precedence' }
        Apply-QuotaObject ([pscustomobject]@{ok=$true;planLabel='Plus';windows=@($weekly)})
        if ($ShortPercentValue.Text -ne '—' -or $ShortReset.Text -ne '未提供') { throw 'Missing Plus window retained a previous account value' }
        Apply-QuotaObject ([pscustomobject]@{ok=$true;planLabel='Plus';windows=@($short)})
        if ($WeekPercentValue.Text -ne '—' -or $WeekReset.Text -ne '未提供') { throw 'Missing weekly window retained a previous account value' }
    }
    $Config.FontScale = 1.0
    Update-FontScale
    Set-TestQuotaRemaining 80 80

    $Config.FontScale = 1.4
    Update-FontScale
    foreach ($plan in @('Pro Lite','Pro Max')) {
        foreach ($win in @(
            [pscustomobject]@{id='unspecified';remaining=42;resetsAt=$next}
            [pscustomobject]@{key='primary';id='fiveHour';label='5h';minutes=$null;remaining=42;resetsAt=$next}
        )) {
            Apply-QuotaObject ([pscustomobject]@{planLabel=$plan;observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();windows=@($win);resetCardCount=2})
            Pump-Wpf
            $natural = [System.Windows.Controls.TextBlock]::new()
            foreach ($prop in @('Text','FontSize','FontFamily','FontWeight')) { $natural.$prop = $QuotaPlanText.$prop }
            $natural.Measure([System.Windows.Size]::new(999,999))
            if ($QuotaPlanText.ActualWidth + 0.5 -lt $natural.DesiredSize.Width -or $QuotaPlanText.Text -ne $plan -or
                $ShortLabel.Text -ne '重置卡' -or $ShortPercentValue.Text -ne '2' -or $WeekLabel.Text -ne '当前额度' -or $WeekPercentValue.Text -ne '42') { throw "Clipped plan badge or incorrect unknown-cycle ticket: $plan" }
        }
    }
    Set-TestQuotaRemaining 25 10
    if ($WeekLabel.Text -ne '每周' -or $ShortLabel.Text -ne '5 小时') { throw 'Period labels must recover after an incomplete Pro snapshot' }
    foreach ($role in @('claude','dragon','gemini','deepseek','zcode')) {
        $Config.Character = $role
        Update-Theme
        $theme = Get-CurrentTheme
        foreach ($row in @(@($ShortPercent,$ShortQuotaAlert,$ShortBar,$theme.QuotaLow),@($WeekPercent,$WeekQuotaAlert,$WeekBar,$theme.QuotaCritical))) {
            $expected = $ColorConv.ConvertFromString($row[3])
            if ($row[0].Foreground.Color -ne $expected -or $row[1].Foreground.Color -ne $expected -or $row[2].Background.Color -ne $expected) { throw "Quota warning theme mismatch: $role" }
            Measure-AppliedContrast $row[0].Name $expected $Window.Resources['QuotaStubBrush'].Color $BubbleBorder.Background.Color 4.5
        }
    }
    Set-ActiveBubblePanel 'deepseek'
    $tiny = [pscustomobject]@{currency='CNY';totalBalance='1000.00';toppedUpBalance='999.99';grantedBalance='0.01'}
    Update-DeepSeekBalanceRatioAndLegend $tiny 'ok' $false
    Pump-Wpf
    if ($DeepSeekGrantBar.ActualWidth -lt 4 -or $DeepSeekGrantText.Text -notlike '*<1%*' -or $DeepSeekBreakdownText.Text -notlike '*>99%*') { throw 'Positive sub-percent grant disappeared' }
    Update-DeepSeekBalanceRatioAndLegend $zeroGrantBal.balances[0] 'ok' $false
    if ($DeepSeekGrantCol.MinWidth -ne 0 -or $DeepSeekGrantBar.IsVisible) { throw 'Zero grant retained a minimum segment' }
    $Config.FontScale = 1
    Update-FontScale
    Set-ActiveBubblePanel 'quota'
    Set-TestQuotaRemaining 80 80

    # Case 25b: QuotaStampStyle lineart stamps & Tray <-> WPF 2-option menu sync
    $Config.TrayEnabled = $true
    if (-not $script:NotifyIcon) { Initialize-TrayIcon }
    Build-ContextMenu
    $Config.QuotaStampStyle = 'embossed'
    Sync-QuotaStampStyleMenuChecks
    $script:agentBusy = $false
    Apply-AgentStatus ([pscustomobject]@{ state = 'idle' })
    $script:TrayMenu.Tag.StampLineart.PerformClick()
    Pump-Wpf
    $syncLineart = [ordered]@{
        cfg        = [string]$Config.QuotaStampStyle
        defaultCfg = [string]$DefaultConfig.QuotaStampStyle
        trayEmb    = [bool]$script:TrayMenu.Tag.StampEmbossed.Checked
        trayLin    = [bool]$script:TrayMenu.Tag.StampLineart.Checked
        wpfEmb     = [bool]$script:WpfStampStyleMenu.Items[0].IsChecked
        wpfLin     = [bool]$script:WpfStampStyleMenu.Items[1].IsChecked
    }
    foreach ($testRole in @('claude','dragon','gemini','deepseek','zcode')) {
        $Config.Character = $testRole
        Update-Theme
        Set-ActiveBubblePanel 'quota'
        Set-TestQuotaRemaining 80 80
        Pump-Wpf
        $shortStamp = $Window.FindName('ShortQuotaStamp')
        $weekStamp = $Window.FindName('WeekQuotaStamp')
        $srcLocal = $shortStamp.Source.UriSource.LocalPath
        $batchTwoReadability.lineartStamps += [ordered]@{
            role    = $testRole
            folder  = [System.IO.Path]::GetFileName([System.IO.Path]::GetDirectoryName($srcLocal))
            artwork = [System.IO.Path]::GetFileName($srcLocal)
            shared  = [Object]::ReferenceEquals($shortStamp.Source, $weekStamp.Source)
            visible = $shortStamp.IsVisible -and $weekStamp.IsVisible
        }
    }
    # Select a stamp while a different agent is working; neither choice may steal the work panel.
    Set-WorkPayload -source 'Codex' -state 'result' -task '正在核对工作气泡的印章'
    Set-QuotaStampStyle 'embossed'
    Set-TestQuotaRemaining 10 25
    $script:TrayMenu.Tag.StampLineart.PerformClick()
    Pump-Wpf
    $workStyleCheck = [ordered]@{
        lineart = [string]$WorkBodyWatermark.Source.UriSource.LocalPath
        shown = $WorkBodyWatermark.IsVisible -and $WorkBodyWatermark.ActualHeight -gt 0
        panel = $script:currentBubblePanel
    }
    $script:WpfStampStyleMenu.Items[0].RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
    Pump-Wpf
    $workStyleCheck.embossed = [string]$WorkBodyWatermark.Source.UriSource.LocalPath
    $workStyleCheck.panelAfter = $script:currentBubblePanel
    $batchTwoReadability.workStyle = $workStyleCheck

    # Simulate one omitted role in the style pack without modifying any installed assets.
    $testMap = $script:QuotaStampSets.lineart.Clone()
    $testMap.Remove('gemini')
    $fullMap = $script:QuotaStampSets.lineart
    try {
        $script:QuotaStampSets.lineart = $testMap
        $Config.QuotaStampStyle = 'lineart'
        $Config.Character = 'gemini'
        Update-Theme
        $batchTwoReadability.fallback = [string]$WorkBodyWatermark.Source.UriSource.LocalPath
        $batchTwoReadability.sharedFallback = [object]::ReferenceEquals($WorkBodyWatermark.Source, $ShortQuotaStamp.Source)
        $Config.Character = 'claude'
        Update-Theme
        $batchTwoReadability.unaffected = [string]$WorkBodyWatermark.Source.UriSource.LocalPath
    } finally {
        $script:QuotaStampSets.lineart = $fullMap
        $Config.Character = 'zcode'
        $Config.QuotaStampStyle = 'embossed'
        Update-Theme
    }
    Apply-AgentStatus ([pscustomobject]@{ state = 'idle' })
    Set-ActiveBubblePanel 'quota'
    Show-Bubble 5.5
    Pump-Wpf
    $syncRestored = [ordered]@{
        cfg     = [string]$Config.QuotaStampStyle
        folder  = [System.IO.Path]::GetFileName([System.IO.Path]::GetDirectoryName($Window.FindName('ShortQuotaStamp').Source.UriSource.LocalPath))
        trayEmb = [bool]$script:TrayMenu.Tag.StampEmbossed.Checked
        trayLin = [bool]$script:TrayMenu.Tag.StampLineart.Checked
        wpfEmb  = [bool]$script:WpfStampStyleMenu.Items[0].IsChecked
        wpfLin  = [bool]$script:WpfStampStyleMenu.Items[1].IsChecked
    }
    $batchTwoReadability.stampMenuSync = [ordered]@{
        toLineart  = $syncLineart
        toEmbossed = $syncRestored
    }

    $Config.Character = 'claude'
    Update-Theme
    $testCardColor = $BubbleBorder.Background.Color
    foreach ($testFontScale in @(1.3, 1.4)) {
        $Config.FontScale = $testFontScale
        Update-FontScale
        Set-ActiveBubblePanel 'quota'
        foreach ($level in @(@{ short = 26; week = 25 }, @{ short = 25; week = 10 }, @{ short = 10; week = 26 })) {
            Set-TestQuotaRemaining $level.short $level.week
            Pump-Wpf
            $quotaContentBounds = [System.Windows.Rect]::new(0,0,$sceneText.ActualWidth,$sceneText.ActualHeight)
            $weeklyTrackBounds = Get-RenderedBounds $WeekTrack $sceneText
            $quotaRowBounds = @(
                Get-RenderedBounds $ShortReset $sceneText
                Get-RenderedBounds $WeekReset $sceneText
            )
            $quotaRowIndex = 0
            foreach ($quotaTestRow in @(
                @{ name = 'fiveHour'; remaining = $level.short; alert = $ShortQuotaAlert; percent = $ShortPercent; track=$ShortTrack; fill=$ShortBar }
                @{ name = 'weekly'; remaining = $level.week; alert = $WeekQuotaAlert; percent = $WeekPercent; track=$WeekTrack; fill=$WeekBar }
            )) {
                $testAlertVisible = $quotaTestRow.alert.IsVisible
                $testPercentBounds = Get-RenderedBounds $quotaTestRow.percent $sceneText
                $testResetBounds = $quotaRowBounds[$quotaRowIndex]
                $quotaRowIndex++
                $alertFits = $true
                if ($testAlertVisible) {
                    $testAlertBounds = Get-RenderedBounds $quotaTestRow.alert $sceneText
                    $alertFits = ($testAlertBounds.Left -ge $testResetBounds.Right - 0.8) -and ($testAlertBounds.Right -le $testPercentBounds.Left + 0.8)
                }
                $batchTwoReadability.alerts += [ordered]@{
                    scale = $testFontScale
                    row = $quotaTestRow.name
                    remaining = $quotaTestRow.remaining
                    visible = $testAlertVisible
                    text = [string]$quotaTestRow.alert.Text
                    percent = [string]$quotaTestRow.percent.Text
                    automationName = [System.Windows.Automation.AutomationProperties]::GetName($quotaTestRow.percent)
                    fits = $alertFits -and ($testPercentBounds.Right -le $quotaContentBounds.Right + 0.8) -and ($weeklyTrackBounds.Bottom -le $quotaContentBounds.Bottom + 0.8)
                }
                if ($testAlertVisible) {
                    Measure-AppliedContrast $quotaTestRow.alert.Name $quotaTestRow.alert.Foreground.Color $testCardColor $testCardColor 4.5
                    Measure-AppliedContrast $quotaTestRow.percent.Name $quotaTestRow.percent.Foreground.Color $testCardColor $testCardColor 4.5
                    Measure-AppliedContrast $quotaTestRow.fill.Name $quotaTestRow.fill.Background.Color $quotaTestRow.track.Background.Color $testCardColor 3
                }
            }
        }
    }
    # Feed a snapshot while hidden, then resize without another refresh. Widths follow the track.
    $statusDeadline = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 86370
    foreach ($pair in @(@(0,100), @(76,27))) {
        Set-ActiveBubblePanel 'quote'
        Set-TestQuotaRemaining $pair[0] $pair[1]
        Set-ActiveBubblePanel 'quota'
        foreach ($fs in @(1.0,1.4)) {
            $Config.FontScale = $fs
            Update-FontScale
            Pump-Wpf
            if ($fs -ge 1.3) {
                foreach ($reset in @($ShortReset, $WeekReset)) {
                    $natural = [System.Windows.Controls.TextBlock]::new()
                    $natural.Text = $reset.Text
                    $natural.FontFamily = $reset.FontFamily
                    $natural.FontSize = $reset.FontSize
                    $natural.Measure([System.Windows.Size]::new(1000, 1000))
                    if ($natural.DesiredSize.Width -gt $reset.ActualWidth + 1) {
                        throw "Large-font countdown clipped: $($reset.Text)"
                    }
                }
            }
            foreach ($measure in @(
                @{ rem=$pair[0]; fill=$ShortBar; track=$ShortTrack; stamp=$shortStamp; alert=$ShortQuotaAlert },
                @{ rem=$pair[1]; fill=$WeekBar; track=$WeekTrack; stamp=$weekStamp; alert=$WeekQuotaAlert }
            )) {
                $batchTwoReadability.progress += [ordered]@{
                    remaining=$measure.rem; width=$measure.fill.ActualWidth; track=$measure.track.ActualWidth
                    stamp=$measure.stamp.IsVisible; alert=$measure.alert.IsVisible
                }
            }
        }
    }
    foreach ($textItem in @($ShortReset,$WeekReset)) {
        $batchTwoReadability.fullText += [ordered]@{ name = $textItem.Name; text = [string]$textItem.Text; hint = [string]$textItem.ToolTip }
    }
    Set-ActiveBubblePanel 'deepseek'
    Apply-BalanceObject $okBal
    Pump-Wpf
    foreach ($textItem in @($DeepSeekCurrencyLabel,$DeepSeekBreakdownText,$DeepSeekGrantText)) {
        $batchTwoReadability.fullText += [ordered]@{ name = $textItem.Name; text = [string]$textItem.Text; hint = [string]$textItem.ToolTip }
    }
    Set-TestQuotaRemaining 80 80

    # Case 26: manual detail entry and real hover continuity across the arrow.
    $Config.FontScale = 1.4
    Update-FontScale
    Set-HoverDetailsEnabled $false
    $longManualDetail = ((1..25 | ForEach-Object { "任务详情第 $_ 行，需要滚动查看后续信息。" }) -join [Environment]::NewLine)
    Set-WorkPayload -source 'Codex' -task '查看完整详情' -taskDetail $longManualDetail
    Show-Bubble 0 -Force
    Pump-Wpf
    $detailButton = $Window.FindName('WorkDetailButton')
    $batchTwoDetail = [ordered]@{
        buttonVisible = ($detailButton -is [System.Windows.Controls.Button] -and $detailButton.IsVisible)
        disabledHoverOpen = (Invoke-DeterministicHoverCheck $WorkHeader $false).visible
        arrows = @()
    }
    $script:MockCursorScreenPt = [System.Windows.Point]::new(-9000, -9000)
    function Invoke-TestDetailButton {
        $click = [System.Windows.RoutedEventArgs]::new([System.Windows.Controls.Primitives.ButtonBase]::ClickEvent)
        $detailButton.RaiseEvent($click)
        Pump-Wpf
        return $click.Handled
    }
    $batchTwoDetail.buttonHandlesClick = Invoke-TestDetailButton
    $batchTwoDetail.manualPinned = [bool]$script:detailPinned
    $batchTwoDetail.mouseActivation = [bool]($script:DetailWindow.ShowActivated -or $script:DetailWindow.Focusable)
    $script:detailLeaveAt = [DateTime]::UtcNow.AddSeconds(-1)
    Update-DetailHoverState
    $batchTwoDetail.manualSurvivesPointerLeave = [bool]$script:DetailWindow.IsVisible
    [void](Invoke-TestDetailButton)
    $batchTwoDetail.secondClickCloses = -not $script:DetailWindow.IsVisible -and -not $script:detailPinned

    [void](Invoke-TestDetailButton)
    Set-ActiveBubblePanel 'quota'
    Pump-Wpf
    $batchTwoDetail.panelChangeCloses = -not $script:DetailWindow.IsVisible -and -not $script:detailPinned -and -not $detailButton.IsVisible

    Set-WorkPayload -source 'Codex' -task '查看完整详情' -taskDetail $longManualDetail
    Show-Bubble 0 -Force
    [void](Invoke-TestDetailButton)
    Apply-AgentStatus ([pscustomobject]@{ state = 'idle' })
    Pump-Wpf
    $batchTwoDetail.idleCloses = -not $script:DetailWindow.IsVisible -and -not $script:detailPinned

    Set-HoverDetailsEnabled $true
    $savedWindowTop = $Window.Top
    $savedWindowLeft = $Window.Left
    $detailWorkArea = [System.Windows.SystemParameters]::WorkArea
    $Window.Left = $detailWorkArea.Left + 30
    foreach ($testPlacement in @('below','above')) {
        Close-HoverDetailCard
        $Window.Top = if ($testPlacement -eq 'below') { $detailWorkArea.Top + 5 } else { $detailWorkArea.Bottom - 210 }
        Set-WorkPayload -source 'Codex' -task '详情箭头命中' -taskDetail $longManualDetail
        Show-Bubble 0 -Force
        Pump-Wpf
        Open-HoverDetailCard
        Pump-Wpf
        $testedArrow = if ($testPlacement -eq 'below') { $script:DetailArrowTop } else { $script:DetailArrowBottom }
        $probeArrowVisible = [bool]$testedArrow.IsVisible
        $probeArrowHit = $false
        $probeBodyHit = $true
        $probeOtherTrigger = $true
        if ($probeArrowVisible) {
            $script:MockCursorScreenPt = Get-VisualElementCenterScreenPt $testedArrow
            $probeArrowHit = Test-ElementHit $testedArrow $script:MockCursorScreenPt
            $probeBodyHit = Test-ElementHit $script:DetailCardBorder $script:MockCursorScreenPt
            $probeOtherTrigger = (Test-ElementHit $WorkHeaderBanner $script:MockCursorScreenPt) -or (Test-ElementHit $WorkTask $script:MockCursorScreenPt)
            $script:detailLeaveAt = [DateTime]::UtcNow.AddSeconds(-1)
            Update-DetailHoverState
        }
        $batchTwoDetail.arrows += [ordered]@{
            placement = $testPlacement
            visible = $probeArrowVisible
            arrowHit = $probeArrowHit
            otherHit = $probeBodyHit -or $probeOtherTrigger
            remainsOpen = ($script:DetailWindow.IsVisible -and $script:detailLeaveAt -eq [DateTime]::MinValue)
        }
    }
    $Window.Top = $savedWindowTop
    $Window.Left = $savedWindowLeft
    Close-HoverDetailCard
    Set-HoverDetailsEnabled $false
    Set-WorkPayload -source 'Codex' -task '查看完整详情' -taskDetail $longManualDetail
    Show-Bubble 0 -Force
    Build-ContextMenu
    Pump-Wpf
    $Window.ContextMenu.IsOpen = $true
    Pump-Wpf
    $taskDetailMenuItem = $script:WpfViewTaskDetailMenuItem
    $batchTwoDetail.menuVisible = ($taskDetailMenuItem -and $taskDetailMenuItem.Visibility -eq [System.Windows.Visibility]::Visible -and $taskDetailMenuItem.IsEnabled)
    $Window.ContextMenu.IsOpen = $false
    Pump-Wpf
    $taskDetailMenuItem.RaiseEvent([System.Windows.RoutedEventArgs]::new([System.Windows.Controls.MenuItem]::ClickEvent))
    Pump-Wpf
    $batchTwoDetail.menuOpens = [bool]$script:DetailWindow.IsVisible
    $viewer = $script:DetailScrollViewer
    $batchTwoDetail.menuEnablesKeyboard = [bool]($script:DetailWindow.Focusable -and $viewer.Focusable)
    $batchTwoDetail.scrollable = [double]$viewer.ScrollableHeight
    $beforeScroll = [double]$viewer.VerticalOffset
    function Send-TestDetailKey($target, [System.Windows.Input.Key]$key) {
        $source = [System.Windows.PresentationSource]::FromVisual($target)
        $keyEvent = [System.Windows.Input.KeyEventArgs]::new([System.Windows.Input.Keyboard]::PrimaryDevice, $source, 0, $key)
        $keyEvent.RoutedEvent = [System.Windows.Input.Keyboard]::PreviewKeyDownEvent
        $target.RaiseEvent($keyEvent)
        if (-not $keyEvent.Handled) {
            $keyEvent.RoutedEvent = [System.Windows.Input.Keyboard]::KeyDownEvent
            $target.RaiseEvent($keyEvent)
        }
        Pump-Wpf
    }
    Send-TestDetailKey $viewer ([System.Windows.Input.Key]::Down)
    $batchTwoDetail.keyboardScrolls = ([double]$viewer.VerticalOffset -gt $beforeScroll)
    Send-TestDetailKey $viewer ([System.Windows.Input.Key]::Escape)
    $batchTwoDetail.escapeCloses = -not $script:DetailWindow.IsVisible -and -not $script:detailPinned
    Set-HoverDetailsEnabled $false

    # Case 27: real refresh button routes and request lifecycles use isolated flag files.
    $quotaRequestAst = $repositoryAst.Find({param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Request-QuotaRefresh'
    }, $true)
    Set-Item Function:global:Request-QuotaRefresh -Value $quotaRequestAst.Body.GetScriptBlock()
    Set-Item Function:global:Request-BalanceRefresh -Value $realBalanceRefresh.Body.GetScriptBlock()
    $Config.FontScale = 1.4
    $Config.BubbleScale = 0.8
    Update-FontScale
    Update-BubbleScale
    Apply-AgentStatus ([pscustomobject]@{ state = 'idle' })
    $script:refreshingUntil = [DateTime]::MinValue
    $script:balanceRequestTimeout = $null
    $script:balanceRequestStartedMs = [long]0
    $script:lastBalanceRefreshRequestTime = [DateTime]::MinValue
    $existingQuotaPath = $RefreshFlagPath
    $existingBalancePath = $RefreshBalanceFlagPath
    try {
        $RefreshFlagPath = Join-Path $BaseDir 'case27-quota.flag'
        $RefreshBalanceFlagPath = Join-Path $BaseDir 'case27-balance.flag'
        foreach ($refreshRow in @(
            @{ mode = 'quota'; button = $RefreshQuotaBtn; flag = $RefreshFlagPath }
            @{ mode = 'deepseek'; button = $RefreshDeepSeekBtn; flag = $RefreshBalanceFlagPath }
        )) {
            Set-ActiveBubblePanel $refreshRow.mode
            Show-Bubble 0 -Force
            Pump-Wpf
            $refreshControl = $refreshRow.button
            $idleBounds = Get-RenderedBounds $refreshControl $Window
            $firstClick = [System.Windows.RoutedEventArgs]::new([System.Windows.Controls.Primitives.ButtonBase]::ClickEvent)
            $refreshControl.RaiseEvent($firstClick)
            Pump-Wpf
            $pendingPath = $refreshControl.Template.FindName('PendingGlyph', $refreshControl)
            $pendingBounds = Get-RenderedBounds $refreshControl $Window
            if (-not $firstClick.Handled -or -not $pendingPath.IsVisible -or
                [System.Windows.Automation.AutomationProperties]::GetItemStatus($refreshControl) -ne '刷新中，请稍候' -or
                -not (Test-Path -LiteralPath $refreshRow.flag)) { throw ('Case 27: missing busy feedback: ' + $refreshRow.mode) }
            if ($pendingBounds.Width -ne $idleBounds.Width -or $pendingBounds.Height -ne $idleBounds.Height -or
                $pendingBounds.Width -lt 24 -or $pendingBounds.Height -lt 24) { throw ('Case 27: busy hot area shrank: ' + $refreshRow.mode) }
            $corner = [System.Windows.Point]::new(($pendingBounds.Left + 0.5), ($pendingBounds.Top + 0.5))
            if (-not (Test-RefreshTargetAt $refreshControl $corner)) { throw 'Case 27: busy corner no longer hit-tests to the refresh button' }
            $deadline = if ($refreshRow.mode -eq 'quota') { $script:refreshingUntil } else { $script:balanceRequestTimeout }
            $sentinel = 'case27-duplicate-must-not-overwrite'
            [IO.File]::WriteAllText($refreshRow.flag, $sentinel)
            if ($refreshRow.mode -eq 'deepseek') { $script:lastBalanceRefreshRequestTime = [DateTime]::UtcNow.AddSeconds(-11) }
            $duplicateClick = [System.Windows.RoutedEventArgs]::new([System.Windows.Controls.Primitives.ButtonBase]::ClickEvent)
            $refreshControl.RaiseEvent($duplicateClick)
            if (-not $duplicateClick.Handled -or $script:currentBubblePanel -ne $refreshRow.mode -or
                [IO.File]::ReadAllText($refreshRow.flag) -ne $sentinel) { throw ('Case 27: pending click repeated or bubbled: ' + $refreshRow.mode) }
            if ($refreshRow.mode -eq 'quota') {
                if ($script:refreshingUntil -ne $deadline) { throw 'Case 27: quota duplicate extended timeout' }
                Apply-QuotaObject ([pscustomobject]@{ok = $true; windows = @()})
                if ($refreshControl.Tag -or $script:refreshingUntil -ne [DateTime]::MinValue) { throw 'Case 27: quota result did not restore button' }
                Request-QuotaRefresh
                Update-QuotaRefreshTimeout ($script:refreshingUntil.AddMilliseconds(1))
            } else {
                if ($script:balanceRequestTimeout -ne $deadline) { throw 'Case 27: balance duplicate extended timeout' }
                $requestMs = $script:balanceRequestStartedMs
                Receive-BalanceSnapshot ([pscustomobject]@{status = 'loading'; lastAttemptAt = $requestMs})
                if ($refreshControl.Tag -ne 'Refreshing') { throw 'Case 27: loading cleared the active balance indicator' }
                Receive-BalanceSnapshot ([pscustomobject]@{status = 'error'; lastAttemptAt = $requestMs; errorCode = 'DSH_HTTP_500'})
                if ($refreshControl.Tag -or $script:balanceRequestTimeout) { throw 'Case 27: owned error did not restore balance button' }
                Request-BalanceRefresh
                Update-BalanceRefreshTimeout ($script:balanceRequestTimeout.AddMilliseconds(1))
            }
            Pump-Wpf
            if ($refreshControl.Tag -or $pendingPath.IsVisible -or
                -not [string]::IsNullOrEmpty([System.Windows.Automation.AutomationProperties]::GetItemStatus($refreshControl))) {
                throw ('Case 27: timeout did not restore the original icon: ' + $refreshRow.mode)
            }
        }
        $RefreshFlagPath = $BaseDir
        $RefreshBalanceFlagPath = $BaseDir
        $script:lastBalanceRefreshRequestTime = [DateTime]::MinValue
        Request-QuotaRefresh
        Request-BalanceRefresh
        if ($RefreshQuotaBtn.Tag -or $RefreshDeepSeekBtn.Tag -or
            $ShortReset.Text -ne '请求失败' -or $DeepSeekStatusNotice.Text -ne '请求失败') { throw 'Case 27: file write error kept a button busy' }
        Write-Output 'PASS: Case 27 refresh buttons preserve their busy hot areas and recover on result, timeout, or failed request write'
    } finally {
        $RefreshFlagPath = $existingQuotaPath
        $RefreshBalanceFlagPath = $existingBalancePath
    }

    # Restore clean idle state and Config values, then verify Case 28 drag-release & LostMouseCapture isolation
    $Config.Character = 'claude'
    $Config.BubbleScale = 1.0
    $Config.FontScale = 1.0
    Update-Theme
    Update-BubbleScale
    Update-FontScale
    Apply-AgentStatus ([pscustomobject]@{ state = 'idle' })
    $script:manualBubbleHidden = $false
    Stop-UserBubbleInspection

    $dragTestCheck = [ordered]@{
        dragBounceCount = 0
        lostBounceCount = 0
        syncLostFired   = $false
        dragBubbleOpen  = $true
        dragQuotaFlag   = $true
        savedLeft       = 0
        savedTop        = 0
        lostIsDragging  = $true
    }
    Hide-Bubble
    Pump-Wpf
    $origSaveCfgFn        = (Get-Item function:Save-Config).ScriptBlock
    $origBounceFn         = (Get-Item function:Trigger-PetBounce).ScriptBlock
    $origReleaseCaptureFn = (Get-Item function:Release-PetMouseCapture).ScriptBlock
    $origRefreshQPath = $RefreshFlagPath
    $dragQuotaProbeFlag = Join-Path $BaseDir 'drag-probe-quota.flag'
    $RefreshFlagPath = $dragQuotaProbeFlag
    if (Test-Path -LiteralPath $dragQuotaProbeFlag) { Remove-Item -LiteralPath $dragQuotaProbeFlag -Force }
    $script:testBounceCalls = 0
    $script:case28SyncLost = $false
    $case28MouseDev = [System.Windows.Input.Mouse]::PrimaryDevice
    $case28LostSpy = [System.Windows.Input.MouseEventHandler]{
        param($ls, $le)
        if ($script:releasingPetMouseUp) {
            $script:case28SyncLost = $true
        }
    }
    $PetImage.Add_LostMouseCapture($case28LostSpy)
    function global:Save-Config {
        $json = $Config | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText($ConfigPath, $json, [System.Text.Encoding]::UTF8)
    }
    function global:Trigger-PetBounce {
        $script:testBounceCalls++
        & $origBounceFn
    }
    function global:Release-PetMouseCapture {
        $hadNativeCapture = [bool]($PetImage -and $PetImage.IsMouseCaptured)
        & $origReleaseCaptureFn
        if (-not $hadNativeCapture -and $PetImage) {
            $syncLostArgs = [System.Windows.Input.MouseEventArgs]::new([System.Windows.Input.Mouse]::PrimaryDevice, 0)
            $syncLostArgs.RoutedEvent = [System.Windows.UIElement]::LostMouseCaptureEvent
            $PetImage.RaiseEvent($syncLostArgs)
        }
    }
    try {
        $prevL = $Window.Left; $prevT = $Window.Top
        [void]$PetImage.CaptureMouse()
        Start-PetPressSquash
        for ($pf = 0; $pf -lt 15 -and (-not ($PetScale.ScaleY -lt 0.96 -and $PetScale.ScaleX -gt 1.04)); $pf++) { Pump-Wpf 15 }
        $script:isDragging = $true
        $Window.Left = 220
        $Window.Top = 310
        $upArgs = [System.Windows.Input.MouseButtonEventArgs]::new($case28MouseDev, 0, [System.Windows.Input.MouseButton]::Left)
        $upArgs.RoutedEvent = [System.Windows.UIElement]::MouseLeftButtonUpEvent
        $PetImage.RaiseEvent($upArgs)
        Pump-Wpf
        $dragTestCheck.syncLostFired   = [bool]$script:case28SyncLost
        $dragTestCheck.dragBounceCount = $script:testBounceCalls
        $dragTestCheck.dragBubbleOpen  = [bool]$script:isBubbleOpen
        $dragTestCheck.dragQuotaFlag   = (Test-Path -LiteralPath $dragQuotaProbeFlag)
        $savedCfgAfterDrag = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $dragTestCheck.savedLeft = [double]$savedCfgAfterDrag.Left
        $dragTestCheck.savedTop  = [double]$savedCfgAfterDrag.Top

        # Let bounce finish, then test unexpected LostMouseCapture during pressed state (without MouseLeftButtonUp)
        for ($pf = 0; $pf -lt 22; $pf++) { Pump-Wpf 20 }
        $script:testBounceCalls = 0
        $script:isDragging = $true
        Start-PetPressSquash
        for ($pf = 0; $pf -lt 15 -and (-not ($PetScale.ScaleY -lt 0.96 -or $PetScale.ScaleX -gt 1.04)); $pf++) { Pump-Wpf 15 }
        $lostArgs = [System.Windows.Input.MouseEventArgs]::new($case28MouseDev, 0)
        $lostArgs.RoutedEvent = [System.Windows.UIElement]::LostMouseCaptureEvent
        $PetImage.RaiseEvent($lostArgs)
        Pump-Wpf
        $dragTestCheck.lostBounceCount = $script:testBounceCalls
        $dragTestCheck.lostIsDragging  = [bool]$script:isDragging

        $Window.Left = $prevL; $Window.Top = $prevT
    } finally {
        $PetImage.Remove_LostMouseCapture($case28LostSpy)
        $RefreshFlagPath = $origRefreshQPath
        Set-Item -Path function:global:Save-Config -Value $origSaveCfgFn
        Set-Item -Path function:global:Trigger-PetBounce -Value $origBounceFn
        Set-Item -Path function:global:Release-PetMouseCapture -Value $origReleaseCaptureFn
    }

    Build-ContextMenu

    # The main harness omits startup/exit handlers. Register the production exit hook
    # and change a slider in a closed menu to isolate the window-exit save fallback.
    $closedHook = $repositoryAst.Find({ param($node)
        $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
        $node.Member.Value -eq 'Add_Closed' -and $node.Expression.Extent.Text -eq '$Window'
    }, $true)
    if (-not $closedHook) { throw 'Production window exit hook was not found' }
    . ([scriptblock]::Create($closedHook.Extent.Text))
    $exitSoundMenu = $Window.ContextMenu.Items | Where-Object { $_.Header -eq '音效与音量' }
    $exitVolumeSlider = $exitSoundMenu.Items[1].Header.Children[0]
    $exitVolumeSlider.Value += $exitVolumeSlider.TickFrequency
    $windowExitPersistence = [ordered]@{
        menuClosed = (-not $Window.ContextMenu.IsOpen)
        dirtyBeforeExit = [bool]$script:sliderConfigDirty
        expected = $exitVolumeSlider.Value
    }
    $Window.Close()
    $windowExitConfig = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $windowExitPersistence.actual = $windowExitConfig.SoundVolume
    $windowExitPersistence.dirtyAfterExit = [bool]$script:sliderConfigDirty

    $out = [ordered]@{
        astErrorCount              = $astErrorCount
        mainXamlParsed             = $mainXamlParsed
        detailWindowEnsured        = $ensured
        detailRootGridBound        = ($null -ne $script:DetailRootGrid)
        startupDefaultHoverEnabled = $startupDefaultHoverEnabled
        defaultConfigHoverVal      = $defaultConfigHoverVal
        agShort             = $agShort
        codexX12TwoLines    = $codexX12TwoLines
        dshInline           = $dshInline
        agFs14WrapLong      = $agFs14WrapLong
        multiFs08           = $multiFs08
        pillRefReused       = $pillRefReused
        badgeTooltipPresent = $badgeTooltipPresent
        detailOnBadgeHover  = $detailOnBadgeHover
        detailOnHeaderHover = $detailOnHeaderHover
        shortOpen           = $shortOpen
        reopenLong          = $reopenLong
        shrinkShort         = $shrinkShort
        openLong            = $openLong
        fs14LongScrolled    = $fs14LongScrolled
        themeMatrix         = $themeMatrix
        dsAfterError        = $dsAfterError
        geomTransitions     = $geomTransitions
        tier3Stress         = $tier3Stress
        zeroLineState       = $zeroLineState
        zeroLineHoverDetail = $zeroLineHoverDetail
        recoveredOneLine    = $recoveredOneLine
        recoveredSummary    = $recoveredSummary
        hitMidFade          = $hitMidFade
        hitVisible          = $hitVisible
        hitHidden           = $hitHidden
        workSplitDistinct   = $workSplitDistinct
        workSplitFallback   = $workSplitFallback
        workSplitSameDedup  = $workSplitSameDedup
        fadeAfterComplete   = $fadeAfterComplete
        fadeReopenGuard     = $fadeReopenGuard
        menuScope           = [ordered]@{
            trayBusyMode    = $menuTrayBusyMode
            trayBusyPanel   = $menuTrayBusyPanel
            trayIdleMode    = $menuTrayIdleMode
            trayIdlePanel   = $menuTrayIdlePanel
            ctxBusyMode     = $menuCtxBusyMode
            ctxBusyPanel    = $menuCtxBusyPanel
            ctxIdleMode     = $menuCtxIdleMode
            ctxIdlePanel    = $menuCtxIdlePanel
            closureCount    = $closureMatchCount
            taskSoundSync   = $taskSoundMenuSync
        }
        deepSeekScaleCases  = $deepSeekScaleCases
        dsPadAt14           = $dsPadAt14
        dsPadAt10           = $dsPadAt10
        hoverConfigCases    = $hoverConfigCases
        roleQuotesCheck     = $roleQuotesCheck
        menuCharSync        = $menuCharSync
        topmostLifecycle    = $topmostLifecycle
        roundedMenu         = $roundedMenu
        manualInspection    = $manualInspection
        renewedInspection   = $renewedInspection
        sliderPersistence   = $sliderPersistence
        windowExitPersistence = $windowExitPersistence
        checksAt115         = $checksAt115
        checksAt110         = $checksAt110
        case23Regression    = $case23Regression
        batchTwoReadability = $batchTwoReadability
        batchTwoDetail = $batchTwoDetail
        batchOne            = $batchOne
        dragReleaseCase     = $dragTestCheck
    }
    Write-Output ('RESULT_JSON:' + ($out | ConvertTo-Json -Depth 6 -Compress))
} finally {
    try { if ($script:NotifyIcon) { $script:NotifyIcon.Visible = $false; $script:NotifyIcon.Dispose(); $script:NotifyIcon = $null } } catch {}
    try { Close-HoverDetailCard -Dispose } catch {}
    try { if ($Window -and $Window.IsVisible) { $Window.Close() } } catch {}
}
`;

    fs.writeFileSync(driverPath, '\uFEFF' + driverScript, 'utf8');

    const res = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', driverPath],
      { encoding: 'utf8', timeout: 75000 }
    );
    assert.ifError(res.error);
    assert.equal(
      res.status,
      0,
      `PowerShell UI driver exited with ${res.status}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`
    );

    const jsonLine = (res.stdout || '')
      .split(/\r?\n/)
      .find((line) => line.startsWith('RESULT_JSON:'));
    assert.ok(jsonLine, `Missing RESULT_JSON line\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
    const data = JSON.parse(jsonLine.slice('RESULT_JSON:'.length));

    // Assertions: static + bindings
    assert.equal(data.astErrorCount, 0, 'AgentPet.ps1 must parse with 0 AST errors');
    assert.equal(data.mainXamlParsed, true, 'AgentPet.xaml must parse');
    assert.equal(data.detailWindowEnsured, true, 'DetailWindow must initialize');
    assert.equal(data.detailRootGridBound, true, 'DetailRootGrid must be bound');
    assert.equal(data.defaultConfigHoverVal, false, '$DefaultConfig.HoverDetailsEnabled must default to false');
    assert.equal(data.startupDefaultHoverEnabled, false, 'startup missing-field config must default HoverDetailsEnabled to false');
    const exampleCfg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config.example.json'), 'utf8'));
    assert.equal(exampleCfg.HoverDetailsEnabled, false, 'config.example.json HoverDetailsEnabled must match false default');

    // Assertions: P2 single-source inline & wrap + real icons
    assert.equal(data.agShort.headerText, '工作中', 'short header must stay un-truncated');
    assert.equal(data.agShort.inlineVis, 'Visible', 'single Antigravity must render inline at 1.0');
    assert.equal(data.agShort.sourcesPanelVis, 'Collapsed');
    assert.equal(data.agShort.badgeParentName, 'WorkInlineSourceHost');
    assert.equal(data.agShort.badgeText, 'Antigravity');
    assert.equal(data.agShort.iconVisible, true, 'Antigravity icon must be visible');
    assert.equal(data.agShort.groupVAlign, 'Center', '1-line complete work body must vertically center group');

    assert.equal(data.codexX12TwoLines.headerText, '工作中');
    assert.equal(data.codexX12TwoLines.inlineVis, 'Visible', 'Codex x12 must fit inline at 1.0');
    assert.equal(data.codexX12TwoLines.badgeText, 'Codex ×12');
    assert.equal(data.codexX12TwoLines.iconVisible, true, 'Codex icon must be visible');
    assert.equal(data.codexX12TwoLines.lineCount, 2, '2-line body test case should render 2 lines');
    assert.equal(data.codexX12TwoLines.groupVAlign, 'Center', '2-line complete work body must vertically center group');

    assert.equal(data.dshInline.inlineVis, 'Visible');
    assert.equal(data.dshInline.badgeText, 'DSH ×5');
    assert.equal(data.dshInline.iconLoaded, true, 'DSH icon must load and render');

    assert.equal(data.agFs14WrapLong.headerText, '等待确认', 'wrapped single-source header must remain intact');
    assert.equal(data.agFs14WrapLong.inlineVis, 'Collapsed', 'Antigravity x12 at FontScale 1.4 must wrap to row 2');
    assert.equal(data.agFs14WrapLong.sourcesPanelVis, 'Visible');
    assert.equal(data.agFs14WrapLong.badgeParentName, 'WorkSourcesPanel');
    assert.ok(data.agFs14WrapLong.badgeWidth <= data.agFs14WrapLong.panelWidth + 0.5, 'wrapped badge must fit inside WorkSourcesPanel');
    assert.equal(data.agFs14WrapLong.groupVAlign, 'Top', 'long / >=3-line / truncated body must switch to Top alignment');
    assert.ok(data.agFs14WrapLong.taskActualH <= data.agFs14WrapLong.taskMaxHeight + 0.5, 'WorkTask height must stay within whole-line MaxHeight');

    // Assertions: shrink recovery + pill reference reuse
    assert.equal(data.multiFs08.inlineVis, 'Collapsed', 'multi-source title must own row 1');
    assert.equal(data.multiFs08.sourcesPanelVis, 'Visible');
    assert.ok(data.multiFs08.childCount >= 2, 'multi-source row must display primary + secondary badges');
    assert.equal(data.pillRefReused, true, 'unchanged heartbeat must reuse pooled secondary pill instance');

    // Assertions: AC06 header trigger vs inline pill exclusion
    assert.equal(data.badgeTooltipPresent, true, 'WorkSourceBadge overview ToolTip must remain active');
    assert.equal(data.detailOnBadgeHover.visible, false, 'hovering inline WorkSourceBadge must NOT open DetailWindow');
    assert.equal(data.detailOnHeaderHover.visible, true, 'hovering WorkHeader must open DetailWindow');
    assert.equal(data.detailOnHeaderHover.showActivated, false, 'DetailWindow must never steal focus');

    // Assertions: P1 DetailWindow WPF + Win32 ClientRect sync across reopen, expand, shrink & scroll
    assert.equal(data.shortOpen.visible, true);
    assert.equal(data.reopenLong.visible, true);
    assert.ok(
      data.reopenLong.winW > data.shortOpen.winW + 40 && data.reopenLong.winH > data.shortOpen.winH + 60,
      `hide->long->reopen must expand DetailWindow (short=${data.shortOpen.winW}x${data.shortOpen.winH}, reopenLong=${data.reopenLong.winW}x${data.reopenLong.winH})`
    );
    assert.ok(
      data.reopenLong.clientPxW > data.shortOpen.clientPxW + 40 && data.reopenLong.clientPxH > data.shortOpen.clientPxH + 60,
      `hide->long->reopen Win32 ClientRect must expand instead of clipping at ${data.shortOpen.clientPxW}x${data.shortOpen.clientPxH}`
    );
    assert.ok(
      Math.abs(data.reopenLong.clientPxW - Math.round(data.reopenLong.winW * data.reopenLong.dpiX)) <= 2 &&
      Math.abs(data.reopenLong.clientPxH - Math.round(data.reopenLong.winH * data.reopenLong.dpiY)) <= 2,
      `Win32 ClientRect (${data.reopenLong.clientPxW}x${data.reopenLong.clientPxH}) must match WPF ActualSize (${data.reopenLong.winW}x${data.reopenLong.winH} @ ${data.reopenLong.dpiX}x)`
    );

    assert.ok(
      data.shrinkShort.winW <= data.shortOpen.winW + 2 &&
      data.shrinkShort.winH <= data.shortOpen.winH + 2 &&
      data.shrinkShort.clientPxH <= data.shortOpen.clientPxH + 2,
      `open long->short must shrink back cleanly (short=${data.shortOpen.winW}x${data.shortOpen.winH}, shrink=${data.shrinkShort.winW}x${data.shrinkShort.winH})`
    );
    assert.ok(
      data.openLong.winW > data.shrinkShort.winW + 40 &&
      data.openLong.winH > data.shrinkShort.winH + 60 &&
      data.openLong.clientPxH > data.shrinkShort.clientPxH + 60,
      'open short->long must expand immediately without clipping'
    );

    assert.ok(data.fs14LongScrolled.scrollableH > 0, 'long text at FontScale=1.4 should engage DetailScrollViewer');
    assert.ok(
      data.fs14LongScrolled.scrollMaxH > 0 && data.fs14LongScrolled.scrollMaxH < data.fs14LongScrolled.winH,
      'DetailScrollViewer.MaxHeight must dynamically deduct non-scroll header/chrome height'
    );
    assert.ok(
      Math.abs(data.fs14LongScrolled.scrollOffset - data.fs14LongScrolled.scrollableH) <= 1.0,
      'DetailScrollViewer must scroll to the real bottom without clipping'
    );
    assert.ok(
      Math.abs(data.fs14LongScrolled.clientPxH - Math.round(data.fs14LongScrolled.winH * data.fs14LongScrolled.dpiY)) <= 2,
      'Win32 ClientRect height at FontScale=1.4 must match DetailWindow ActualHeight'
    );

    // Assertions: Scheme 3 & Option B
    assert.equal(data.themeMatrix.length, 25, 'must cover 5 characters x 5 work states');
    const expectedBgMap = {
      claude: '#FFFFFCFA', dragon: '#FFF4F3FB', deepseek: '#FFF0F7FF', zcode: '#FFF1F4FC', gemini: '#FFF5F1FF'
    };
    const themesByTag = new Map(data.themeMatrix.map(item => [item.tag, item]));
    for (const item of data.themeMatrix) {
      const [ch, st] = item.tag.split('/');
      assert.equal(path.basename(item.watermarkPath), ch + '.png', item.tag + ': status watermark must follow the pet');
      assert.equal(path.basename(path.dirname(item.watermarkPath)), 'embossed');
      assert.equal(item.watermarkHit, false, item.tag + ': decoration must not intercept input');
      assert.equal(item.cardCornerTL, 18, `${item.tag} card corner must be 18`);
      assert.equal(item.bubbleBg, expectedBgMap[ch], `${item.tag} bubble background must use character pastel tint`);
      assert.equal(item.codexFg, '#FF0F766E', 'codex pill foreground must use high-contrast teal');
      assert.equal(item.codexPillBg, '#DDFFFFFF', 'header pill must use frosted white fill');
      assert.equal(item.codexDetailBg, '#FFEBF8F3', 'DetailSourcePill must keep tinted DetailBackground');
      if (st === 'waiting') {
        assert.equal(item.borderThick, 1.6, `${item.tag} waiting border thickness`);
        assert.equal(item.borderBrush, '#DCA296A8', `${item.tag} waiting muted slate-lavender border`);
        assert.equal(item.chipBg, '#FFFCE7F3', `${item.tag} waiting cherry-pink chip bg`);
        assert.equal(item.headerColor, '#FFBE185D', `${item.tag} waiting header fg`);
        assert.equal(item.dotFill, '#FFDB2777', `${item.tag} waiting dot fill`);
        if (ch === 'dragon') assert.equal(item.headerGrad0, '#FFE6E4F6', 'dragon waiting keeps Option B moon-frost banner');
      } else if (st === 'error') {
        assert.equal(item.borderThick, 1.8, `${item.tag} error border thickness`);
        assert.equal(item.borderBrush, '#FFEF4444', `${item.tag} error red border`);
      } else if (st === 'success' || st === 'done') {
        const working = themesByTag.get(`${ch}/working`);
        assert.equal(item.headerText, '任务完成', `${item.tag} completion status must remain visible`);
        assert.equal(item.spriteKey, `${ch}-happy`, `${item.tag} completion must use the character's happy sprite`);
        for (const key of ['borderBrush', 'tailBrush', 'tailNearBrush', 'shadowColor', 'headerGrad0', 'headerGrad1', 'headerDivider', 'headerColor', 'dotFill']) {
          assert.equal(item[key], working[key], `${item.tag} ${key} must keep the character theme`);
        }
      } else {
        assert.equal(item.borderThick, 2.2, `${item.tag} working Option B solid border thickness`);
        assert.equal(item.chipBg, '#00FFFFFF', `${item.tag} working transparent chip`);
        if (ch === 'dragon') {
          assert.equal(item.borderBrush, '#FF6D67A2');
        }
      }
      assert.ok(Math.abs((item.cardCornerTL - item.borderThick) - item.bannerCornerTL) <= 0.2, `${item.tag} banner inner corner radius = 18 - thick`);
    }
    assert.equal(data.dsAfterError.borderThick, 2.2, 'switching to deepseek must set Option B BorderThickness to 2.2');
    assert.equal(data.dsAfterError.bubbleBg, '#FFF5F1FF', 'gemini deepseek panel must keep gemini pastel background');
    assert.notEqual(data.dsAfterError.borderBrush, '#FFEF4444', 'switching out of error work must restore theme border');
    assert.equal(data.dsAfterError.deepSeekTotalFg, '#FF4B38BF', 'gemini theme must tint DeepSeek panel');

    assert.equal(data.geomTransitions.length, 30, '2 facings x 3 scales x 5 panels');
    for (const g of data.geomTransitions) {
      const isWork = g.panel === 'work';
      const isTicket = g.panel === 'quota';
      const expW = isWork || isTicket ? 254 : 264;
      const expBaseLeft = isWork ? 30 : isTicket ? 31 : 26;
      assert.equal(g.hasTicketClip, isTicket, g.tag + ' punches are quota-only');
      if (isTicket) {
        assert.equal(g.punchedAtSeam, true, g.tag + ' both holes must follow the printed seam on either facing');
        assert.ok(Math.abs(g.borderH - 104) <= 1, g.tag + ' default ticket height');
      }
      const expLeft = Math.round((expBaseLeft + (g.bs - 1.0) * 55.0) * 100) / 100;
      assert.equal(g.declaredW, expW, `${g.tag} Bubble.Width`);
      assert.equal(g.borderDeclaredW, expW, `${g.tag} BubbleBorder.Width`);
      assert.ok(Math.abs(g.bubbleW - expW) <= 1.0 && Math.abs(g.borderW - expW) <= 1.0 && Math.abs(g.bubbleW - g.borderW) <= 0.2, `${g.tag} ActualWidth synced (${g.bubbleW}/${g.borderW} vs ${expW})`);
      assert.ok(Math.abs(g.canvasLeft - expLeft) <= 0.1, `${g.tag} Canvas.Left=${g.canvasLeft} vs ${expLeft}`);
      assert.ok(Math.abs(g.stageBottom - 177.0) <= 1.0, `${g.tag} card bottom must lock near 177.0, got ${g.stageBottom}`);
      assert.ok(g.stageLeft >= -0.5 && g.stageRight <= 390.5 && g.stageTop >= -0.5 && g.tailBottom <= 390.5, `${g.tag} entity must remain inside 390x390 stage`);
    }

    assert.equal(data.tier3Stress.summary.Tier, 'ExtremeCompact', '1.4x 3-source waiting must engage Tier 3 ExtremeCompact');
    assert.ok(data.tier3Stress.summary.LinesBudget >= 1, '1.4x 3-source waiting must retain >= 1 whole body line');
    assert.equal(data.tier3Stress.bodyVis, 'Visible');
    assert.ok(data.tier3Stress.borderH <= 128.5, `1.4x stress card height <= 128, got ${data.tier3Stress.borderH}`);

    assert.equal(data.zeroLineState.summary.ZeroLineFallback, true, 'synthetic extreme narrow height must enter 0-line fallback');
    assert.equal(data.zeroLineState.summary.LinesBudget, 0);
    assert.equal(data.zeroLineState.bodyVis, 'Collapsed');
    assert.equal(data.zeroLineState.taskMaxHeight, 0);
    assert.equal(
      data.zeroLineHoverDetail.visible,
      true,
      `0-line header hover must still open DetailWindow (diag=${JSON.stringify({
        bubbleOpacity: data.zeroLineHoverDetail.bubbleOpacity,
        headerVisible: data.zeroLineHoverDetail.headerVisible,
        targetHit: data.zeroLineHoverDetail.targetHit,
        inTrigger: data.zeroLineHoverDetail.inTrigger,
        triggerEnterSet: data.zeroLineHoverDetail.triggerEnterSet,
        elapsedMs: data.zeroLineHoverDetail.elapsedMs
      })})`
    );

    assert.equal(data.recoveredSummary.ZeroLineFallback, false, 'restoring height must recover from 0-line fallback');
    assert.ok(data.recoveredSummary.LinesBudget >= 1, 'restored space must recover >= 1 whole line');
    assert.equal(data.recoveredSummary.ZeroLineFallback, false);
    assert.ok(Math.abs(data.recoveredOneLine.stageBottom - 177.0) <= 1.0, 'recovered bubble must stay anchored at 177.0');

    assert.equal(data.hitMidFade.tailHit, false, 'mid-fade cumulative opacity < 0.08 must reject tail hit');
    assert.equal(data.hitMidFade.cardHit, false, 'mid-fade cumulative opacity < 0.08 must reject card hit');
    assert.equal(data.hitMidFade.ncAtTail, -1, 'mid-fade must return HTTRANSPARENT (-1)');
    assert.equal(data.hitVisible.tailParentName, 'BubbleTailPanel', 'Tail must live inside BubbleTailPanel');
    assert.equal(data.hitVisible.ncAtCard, 1, 'visible card returns HTCLIENT (1)');
    assert.equal(data.hitVisible.ncAtTail, 1, 'visible tail returns HTCLIENT (1)');
    assert.equal(data.hitVisible.ncAtTailNear, 1, 'visible tailNear returns HTCLIENT (1)');
    assert.equal(data.hitVisible.ncAtTailGap, -1, 'transparent tail row gap must pass through (HTTRANSPARENT = -1)');
    assert.equal(data.hitHidden.tailIsVisible, false, 'Hidden Bubble hides Tail via ancestor tree');
    assert.equal(data.hitHidden.tailHit, false);
    assert.equal(data.hitHidden.ncAtTail, -1, 'Hidden Bubble returns HTTRANSPARENT (-1)');

    // Assertions: Case 12 Option B work split, HoverDetailsEnabled fallback & smart DetailHintBanner dedup
    assert.equal(data.workSplitDistinct.workTaskText, '正在敲代码改文件...');
    assert.equal(data.workSplitDistinct.hoverOffTask, '正在编辑 AgentPet.ps1', 'disabling HoverDetailsEnabled must fall back to task in main bubble');
    assert.equal(data.workSplitDistinct.hoverOnTask, '正在敲代码改文件...', 're-enabling HoverDetailsEnabled must restore stateText in main bubble');
    assert.equal(data.workSplitDistinct.detailHintVis, 'Collapsed', 'working state showing stateText in main bubble must dedup DetailHintBanner');
    assert.ok(data.workSplitDistinct.detailBodyText.includes('正在编辑 AgentPet.ps1'), 'DetailBody must preserve task summary');
    assert.ok(data.workSplitDistinct.detailBodyText.includes('补全状态提示与边框主题'), 'DetailBody must show taskDetail');
    assert.equal(data.workSplitFallback.workTaskText, '请确认是否执行测试');
    assert.equal(data.workSplitFallback.detailHintVis, 'Visible', 'waiting state with distinct task and stateText must display DetailHintBanner');
    assert.equal(data.workSplitFallback.detailHintText, '状态提示：等待主人确认终端命令...');
    assert.ok(data.workSplitFallback.detailBodyText.includes('完整终端命令：run_command --check'), 'DetailBody must show full taskDetail');
    assert.equal(data.workSplitSameDedup.workTaskText, '等待审批中...');
    assert.equal(data.workSplitSameDedup.detailHintVis, 'Collapsed', 'identical task and stateText must dedup DetailHintBanner');
    assert.ok(data.workSplitSameDedup.detailBodyText.includes('请批准执行单元测试'));

    // Assertions: Case 13 Hide-Bubble fade-out closure & version guard
    assert.equal(data.fadeAfterComplete.vis, 'Hidden', 'completed fade-out must hide Bubble via live script scope');
    assert.equal(data.fadeAfterComplete.opacity, 0, 'completed fade-out must zero Bubble opacity');
    assert.equal(data.fadeAfterComplete.openFlag, false, 'completed fade-out must reset $script:bubbleOpen');
    assert.equal(data.fadeReopenGuard.vis, 'Visible', 'reopening mid-fade must cancel stale fade-out completion');
    assert.equal(data.fadeReopenGuard.opacity, 1, 'reopened bubble must remain opaque');
    assert.equal(data.fadeReopenGuard.openFlag, true, 'reopened bubble must keep $script:bubbleOpen = true');

    // Assertions: Case 14 Tray & ContextMenu $script: scope (no GetNewClosure leaks)
    assert.equal(data.menuScope.trayBusyMode, 'deepseek', 'tray default click while busy must still persist Config.BubbleMode');
    assert.equal(data.menuScope.trayBusyPanel, 'work', 'tray default click while $script:agentBusy must NOT switch panel away from work');
    assert.equal(data.menuScope.trayIdleMode, 'quote', 'tray default click while idle must persist Config.BubbleMode');
    assert.equal(data.menuScope.trayIdlePanel, 'quote', 'tray default click while idle must switch active panel');
    assert.equal(data.menuScope.ctxBusyMode, 'deepseek', 'context menu click while busy must persist Config.BubbleMode');
    assert.equal(data.menuScope.ctxBusyPanel, 'work', 'context menu click while $script:agentBusy must NOT switch panel away from work');
    assert.equal(data.menuScope.ctxIdleMode, 'quota', 'context menu click while idle must persist Config.BubbleMode');
    assert.equal(data.menuScope.ctxIdlePanel, 'quota', 'context menu click while idle must switch active panel');
    assert.equal(data.menuScope.closureCount, 1, 'AgentPet.ps1 must only use GetNewClosure in Hide-Bubble');
    assert.equal(data.menuScope.taskSoundSync.defaultsOk, true, '$DefaultConfig task completion defaults must match spec');
    assert.equal(data.menuScope.taskSoundSync.inSingleSubmenu, true, 'task sound toggle and mute/quiet items must live inside ONE submenu');
    assert.equal(data.menuScope.taskSoundSync.noTrayHideOpt, true, 'tray menu must not expose hide/disable tray icon toggle');
    assert.equal(data.menuScope.taskSoundSync.trayOffCfg, false, 'tray task sound toggle must flip TaskCompleteSoundEnabled to false');
    assert.equal(data.menuScope.taskSoundSync.trayOffWpf, false, 'tray task sound toggle must sync WPF menu item');
    assert.equal(data.menuScope.taskSoundSync.trayRestoredCfg, true, 'tray task sound second click must restore true');
    assert.equal(data.menuScope.taskSoundSync.agOffCfg, false, 'tray Antigravity complete toggle must flip AntigravityTranscriptCompleteEnabled to false');
    assert.equal(data.menuScope.taskSoundSync.agOffWpf, false, 'tray Antigravity complete toggle must sync WPF menu item');
    assert.equal(data.menuScope.taskSoundSync.agOnCfg, true, 'WPF Antigravity complete toggle must restore AntigravityTranscriptCompleteEnabled to true');
    assert.equal(data.menuScope.taskSoundSync.muteHiddenOffCfg, false, 'tray secondary mute-when-hidden toggle must flip false');
    assert.equal(data.menuScope.taskSoundSync.muteHiddenOffWpf, false, 'tray secondary mute-when-hidden toggle must sync WPF menu item');
    assert.equal(data.menuScope.taskSoundSync.muteRestoredCfg, true, 'tray mute-when-hidden second click must restore true');
    assert.equal(data.menuScope.taskSoundSync.presetStart, '12:30', 'preset click must set QuietHoursStart=12:30');
    assert.equal(data.menuScope.taskSoundSync.presetEnd, '14:00', 'preset click must set QuietHoursEnd=14:00');
    assert.equal(data.menuScope.taskSoundSync.presetQuietOn, true, 'preset click must enable QuietHoursEnabled');
    assert.equal(data.menuScope.taskSoundSync.presetWpfQuiet, true, 'preset click must check WPF quiet hours toggle');
    assert.equal(data.menuScope.taskSoundSync.afterWpfQuiet, false, 'WPF quiet hours toggle click must turn off QuietHoursEnabled');
    assert.equal(data.menuScope.taskSoundSync.hasSoundPlayer, true, 'TaskCompletePlayer must load assets/task_complete.wav');
    assert.equal(exampleCfg.TaskCompleteSoundEnabled, true, 'config.example.json TaskCompleteSoundEnabled');
    assert.equal(exampleCfg.MuteTaskSoundWhenHidden, true, 'config.example.json MuteTaskSoundWhenHidden');
    assert.equal(exampleCfg.QuietHoursEnabled, false, 'config.example.json QuietHoursEnabled');
    assert.equal(exampleCfg.QuietHoursStart, '23:00', 'config.example.json QuietHoursStart');
    assert.equal(exampleCfg.QuietHoursEnd, '08:00', 'config.example.json QuietHoursEnd');

    // Assertions: Case 15 DeepSeekPanel FontScale (0.8 / 1.0 / 1.15 / 1.3 / 1.4) x states & internal boundary checks
    assert.equal(data.deepSeekScaleCases.length, 55, 'must cover 5x4 fsFirst + 7x4 extra P2 matrix + 2 error states + 5 stateFirst cases');
    const dsByTag = Object.fromEntries(data.deepSeekScaleCases.map((c) => [c.tag, c]));
    for (const c of data.deepSeekScaleCases) {
      assert.ok(c.panelH <= c.innerH + 0.5, `${c.tag} DeepSeekPanel overflow (${c.panelH} > ${c.innerH})`);
      assert.ok(c.noticeDesW <= c.availNoticeW + 0.5, `${c.tag} DeepSeekStatusNotice clipped (${c.noticeDesW} > ${c.availNoticeW} at row ${c.noticeRow})`);
      assert.equal(c.subOverlap, false, `${c.tag} P2-01 legend overlap between Recharge & Grant (rows=${c.subRowCnt})`);
      assert.equal(c.availVsRatio, false, `${c.tag} AC-04 DeepSeekAvailPill overlaps DeepSeekRatioTrack`);
      assert.equal(c.subMetaVsRatio, false, `${c.tag} AC-04 DeepSeekSubMetaText overlaps DeepSeekRatioTrack`);
      assert.equal(c.mainVsRatio, false, `${c.tag} AC-04 DeepSeekMainRowGrid overlaps DeepSeekRatioTrack`);
      assert.equal(c.ratioVsSub, false, `${c.tag} AC-04 DeepSeekRatioTrack overlaps DeepSeekSubRowGrid`);
      assert.deepEqual(c.outsideFrosted, [], `${c.tag} AC-04 controls spilled outside DeepSeekFrostedCard`);
      if (c.okVis === 'Visible') {
        assert.ok(c.bdDesW <= c.bdActW + 0.5, `${c.tag} P2-01 recharge breakdown clipped (${c.bdDesW} > ${c.bdActW})`);
      }
      assert.equal(c.msgHdrOverlap, false, `${c.tag} P2-02 msg title & status pill overlap (${c.msgTitleText} vs ${c.msgStatusText})`);
    }
    const dsScales = ['0.8', '1', '1.15', '1.3', '1.4'];
    for (let i = 1; i < dsScales.length; i++) {
      const prev = dsByTag[`fsFirst/${dsScales[i - 1]}/ok`];
      const curr = dsByTag[`fsFirst/${dsScales[i]}/ok`];
      const prevErr = dsByTag[`fsFirst/${dsScales[i - 1]}/err`];
      const currErr = dsByTag[`fsFirst/${dsScales[i]}/err`];
      assert.ok(prev.hdrFs < curr.hdrFs, `DeepSeekHeader.FontSize must increase ${dsScales[i - 1]} -> ${dsScales[i]} (${prev.hdrFs} vs ${curr.hdrFs})`);
      assert.ok(prev.noticeFs < curr.noticeFs, `DeepSeekStatusNotice.FontSize must increase ${dsScales[i - 1]} -> ${dsScales[i]} (${prev.noticeFs} vs ${curr.noticeFs})`);
      assert.ok(prev.curFs < curr.curFs, `DeepSeekCurrencyLabel.FontSize must increase ${dsScales[i - 1]} -> ${dsScales[i]} (${prev.curFs} vs ${curr.curFs})`);
      assert.ok(prev.bdFs < curr.bdFs, `DeepSeekBreakdownText.FontSize must increase ${dsScales[i - 1]} -> ${dsScales[i]} (${prev.bdFs} vs ${curr.bdFs})`);
      assert.ok(prevErr.msgDetailFs < currErr.msgDetailFs, `DeepSeekMsgDetail.FontSize must increase ${dsScales[i - 1]} -> ${dsScales[i]} (${prevErr.msgDetailFs} vs ${currErr.msgDetailFs})`);
    }
      assert.ok(
        dsByTag['fsFirst/0.8/ok'].totalFs < dsByTag['fsFirst/1/ok'].totalFs &&
        dsByTag['fsFirst/1/ok'].totalFs < dsByTag['fsFirst/1.15/ok'].totalFs &&
        dsByTag['fsFirst/1.15/ok'].totalFs < dsByTag['fsFirst/1.3/ok'].totalFs &&
        dsByTag['fsFirst/1.3/ok'].totalFs === 25.62 &&
        dsByTag['fsFirst/1.4/ok'].totalFs === 25.62,
        `DeepSeekTotalText.FontSize must follow min(1.25, FontScale) cap cleanly (got ${dsByTag['fsFirst/1.3/ok'].totalFs})`
      );
    for (const targetFs of ['1.15', '1.3', '1.4']) {
      assert.equal(dsByTag[`stateFirst/ok->${targetFs}`].hdrFs, dsByTag[`fsFirst/${targetFs}/ok`].hdrFs, `ok->${targetFs} hdrFs order must match`);
      assert.equal(dsByTag[`stateFirst/ok->${targetFs}`].curFs, dsByTag[`fsFirst/${targetFs}/ok`].curFs, `ok->${targetFs} curFs order must match`);
      assert.equal(dsByTag[`stateFirst/ok->${targetFs}`].totalFs, dsByTag[`fsFirst/${targetFs}/ok`].totalFs, `ok->${targetFs} totalFs order must match`);
      assert.equal(dsByTag[`stateFirst/ok->${targetFs}`].panelH, dsByTag[`fsFirst/${targetFs}/ok`].panelH, `ok->${targetFs} panelH order must match`);
    }
    assert.equal(dsByTag['stateFirst/to->1.4'].hdrText, 'DeepSeek 余额', 'timeout compact title must survive FontScale toggle');
    assert.equal(dsByTag['stateFirst/to->1.4'].hdrFs, dsByTag['fsFirst/1.4/to'].hdrFs, 'to update order must match');
    assert.equal(dsByTag['fsFirst/1/ok'].hdrText, 'DeepSeek 余额', 'v1.6.4 header must omit 官方 wording');
    assert.equal(dsByTag['fsFirst/1/ok'].curText, '人民币 CNY · DSH', 'currency label must remove 宿主 wording');
    assert.ok(dsByTag['fsFirst/1/ok'].availMidDiff <= 1.0, `可用 pill and 预警线 must align vertically (diff=${dsByTag['fsFirst/1/ok'].availMidDiff})`);
    assert.ok(dsByTag['fsFirst/1/ok'].availTextMidDiff <= 1.0, `可用 text and 预警线 text must align vertically (diff=${dsByTag['fsFirst/1/ok'].availTextMidDiff})`);
    assert.ok(dsByTag['fsFirst/1.4/ok'].availTextMidDiff <= 1.0, `可用 text and 预警线 text must align at 1.4x (diff=${dsByTag['fsFirst/1.4/ok'].availTextMidDiff})`);
    assert.equal(dsByTag['fsFirst/1/ok'].badgeVis, 'Collapsed', 'v1.6.4 header badge 官方 must stay collapsed');
    assert.equal(dsByTag['fsFirst/1/ok'].hasPricing, false, 'v1.6.4 must remove DeepSeekPricingLink');
    assert.equal(dsByTag['fsFirst/1/ok'].borderPadLeft, 0, 'v1.6.4 DeepSeek BubbleBorder padding must stay 0 for full-bleed header banner');
    assert.equal(dsByTag['fsFirst/1/ok'].fillBarVis, 'Visible', 'v1.6.4 ok balance must show recharge segment');
    assert.equal(dsByTag['fsFirst/1/ok'].grantBarVis, 'Visible', 'v1.6.4 granted > 0 must show dual-tone grant segment');
    assert.equal(dsByTag['fsFirst/1/ok'].bdText, '充值 ¥80.00 (90%)');
    assert.equal(dsByTag['fsFirst/1/ok'].grantText, '赠金 ¥8.88 (10%)');
    assert.equal(dsByTag['fsFirst/1/unk'].availPillText, '不可用', 'isAvailable=false must show rose pill');
    assert.equal(dsByTag['fsFirst/1.4/dshOff'].msgStatusText, '宿主离线', 'dsh_not_running must show 宿主离线 pill');
    assert.equal(dsByTag['extra/1.4/zeroGrant'].fillBarVis, 'Visible');
    assert.equal(dsByTag['extra/1.4/zeroGrant'].grantBarVis, 'Collapsed');
    assert.equal(dsByTag['extra/1.4/pureGrant'].fillBarVis, 'Collapsed');
    assert.equal(dsByTag['extra/1.4/pureGrant'].grantBarVis, 'Visible');
    assert.equal(dsByTag['extra/1.4/noCny'].msgTitleText, '未返回人民币余额');
    assert.ok(dsByTag['extra/1.4/noCny'].msgDetailH >= 24, `extra/1.4/noCny must provide 2-line room for MsgDetail (got ${dsByTag['extra/1.4/noCny'].msgDetailH})`);
    assert.equal(dsByTag['extra/1.4/credMissing'].msgStatusText, '缺少凭据');
    assert.equal(dsByTag['extra/1.4/unsupported'].msgStatusText, '不适用');
    assert.equal(dsByTag['extra/1.4/cooldown'].msgStatusText, '冷却保护');
    assert.equal(dsByTag['extra/1.4/rateLimited'].msgStatusText, '频率受限');
    assert.equal(data.dsPadAt14, 6.5, 'DeepSeekBodyHost left padding at 1.4x must compact to 6.5');
    assert.equal(data.dsPadAt10, 8.5, 'DeepSeekBodyHost left padding at 1.0x must restore to 8.5');

    // Assertions: Case 16 HoverDetailsEnabled 4-way config inputs + menu init + fallback + actual hover
    assert.equal(data.hoverConfigCases.length, 4, 'must test no_file, missing_field, explicit_true, explicit_false');
    const hoverByMode = Object.fromEntries(data.hoverConfigCases.map((c) => [c.mode, c]));
    for (const [mode, expBool, expTask] of [
      ['no_file', false, '正在编辑 AgentPet.ps1'],
      ['missing_field', false, '正在编辑 AgentPet.ps1'],
      ['explicit_true', true, '正在敲代码改文件...'],
      ['explicit_false', false, '正在编辑 AgentPet.ps1']
    ]) {
      const c = hoverByMode[mode];
      assert.ok(c, `missing hoverConfigCases[${mode}]`);
      assert.equal(c.configVal, expBool, `${mode}: Config.HoverDetailsEnabled`);
      assert.equal(c.trayChecked, expBool, `${mode}: Tray HoverDetail initial Checked`);
      assert.equal(c.trayTagChecked, expBool, `${mode}: Tray Tag.HoverDetail initial Checked`);
      assert.equal(c.ctxChecked, expBool, `${mode}: WPF ContextMenu initial IsChecked`);
      assert.equal(c.workTaskText, expTask, `${mode}: working bubble WorkTask.Text`);
      assert.equal(c.hoverVisible, expBool, `${mode}: actual header hover DetailWindow visibility`);
    }

    // Assertions: Case 17 Role-aligned idle quote counts, character work status switching & legacy cleanup
    assert.equal(data.roleQuotesCheck.claudeCount, 14, '$ClaudeQuotes must have 14 quotes');
    assert.equal(data.roleQuotesCheck.geminiCount, 14, '$GeminiQuotes must have 14 quotes');
    assert.equal(data.roleQuotesCheck.dragonCount, 24, '$DragonQuotes (quotes.json) must have 24 quotes');
    assert.equal(data.roleQuotesCheck.deepseekCount, 14, '$DeepSeekQuotes must have 14 quotes');
    assert.equal(data.roleQuotesCheck.zcodeCount, 14, '$ZCodeQuotes must have 14 quotes');
    assert.deepEqual(data.roleQuotesCheck.rosterKeys, ['claude', 'dragon', 'gemini', 'deepseek', 'zcode'], 'CharacterRoster must include all 5 characters');
    const allFiveChars = ['claude', 'gemini', 'dragon', 'deepseek', 'zcode'];
    for (const ch of allFiveChars) {
      const entry = data.roleQuotesCheck.workSwitch[ch];
      assert.equal(entry.inOwnPool, true, `${ch}: Update-Theme must map active work stateText to ${ch}'s own pool (got ${entry.workTask})`);
      assert.equal(entry.detailHintVs, 'Collapsed', `${ch}: matching main bubble stateText must dedup DetailHintBanner`);
      assert.ok(entry.hasIdleSprite && entry.hasWorkSprite && entry.hasThinkSprite && entry.hasHappySprite && entry.hasSleepSprite, `${ch}: all 5 core state sprites must be loaded`);
    }
    assert.equal(data.roleQuotesCheck.workSwitch.deepseek.waitSpriteKey, 'deepseek-wait', 'deepseek waiting state must select deepseek-wait sprite');
    assert.equal(data.roleQuotesCheck.workSwitch.zcode.waitSpriteKey, 'zcode-think', 'zcode waiting state must select zcode-think sprite');
    assert.notEqual(data.roleQuotesCheck.workSwitch.claude.workTask, data.roleQuotesCheck.workSwitch.gemini.workTask);
    assert.notEqual(data.roleQuotesCheck.workSwitch.gemini.workTask, data.roleQuotesCheck.workSwitch.dragon.workTask);
    assert.notEqual(data.roleQuotesCheck.workSwitch.dragon.workTask, data.roleQuotesCheck.workSwitch.deepseek.workTask);
    assert.notEqual(data.roleQuotesCheck.workSwitch.deepseek.workTask, data.roleQuotesCheck.workSwitch.zcode.workTask);
    assert.equal(data.roleQuotesCheck.workSwitch.claude.speakerText, 'Claude娘（小克）');
    assert.equal(data.roleQuotesCheck.workSwitch.gemini.speakerText, 'Gemini娘（双子）');
    assert.equal(data.roleQuotesCheck.workSwitch.dragon.speakerText, '白龙娘（GPT娘）');
    assert.equal(data.roleQuotesCheck.workSwitch.deepseek.speakerText, 'DeepSeek娘（大肥鱼）');
    assert.equal(data.roleQuotesCheck.workSwitch.zcode.speakerText, '智谱娘（GLM 娘）');
    assert.equal(data.roleQuotesCheck.workSwitch.deepseek.bubbleBg, '#FFF0F7FF');
    assert.equal(data.roleQuotesCheck.workSwitch.zcode.bubbleBg, '#FFF1F4FC');
    const wakeQuotesSeen = new Set();
    for (const ch of allFiveChars) {
      const wq = data.roleQuotesCheck.workSwitch[ch].wakeQuote;
      assert.ok(wq && wq.length > 0, `${ch}: wakeQuote must be non-empty`);
      assert.equal(wakeQuotesSeen.has(wq), false, `${ch}: wakeQuote must be distinct from other characters`);
      wakeQuotesSeen.add(wq);
    }
    for (const rel of ['AgentPet.ps1', 'runtime/agent-monitor.mjs', 'assets/quotes.json']) {
      const txt = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assert.equal(txt.includes('摔跤'), false, `${rel} must not contain removed '摔跤' phrase`);
    }
    assert.equal(fs.readFileSync(path.join(repoRoot, 'AgentPet.ps1'), 'utf8').includes('星喵'), false, 'AgentPet.ps1 must use 双子 instead of 星喵');

    // Assertions: Case 18 Dual-menu character check sync (AP-REV-03)
    assert.equal(data.menuCharSync.length, 6, 'Case 18 must record 5 tray clicks + 1 WPF click');
    for (const step of data.menuCharSync) {
      assert.deepEqual(step.wpfChecked, [step.cfgChar], `${step.step}: WPF character menu check must match ${step.cfgChar}`);
      assert.deepEqual(step.trayChecked, [step.cfgChar], `${step.step}: Tray character menu check must match ${step.cfgChar}`);
    }

    // Assertions: Case 19 Topmost / Owner=0 / WaitingAttention / Hidden guard
    const tl = data.topmostLifecycle;
    assert.equal(tl.mainOwnerOnOpen, 0, 'Main window GW_OWNER must be 0');
    assert.equal(tl.detailOwnerOnOpen, 0, 'DetailWindow GW_OWNER must be 0');
    assert.equal(tl.mainTopOff, false, 'Topmost=false must lower main window topmost');
    assert.equal(tl.detailTopOff, false, 'Topmost=false must lower DetailWindow topmost');
    assert.equal(tl.mainTopWait, true, 'Waiting attention must temporarily raise main window topmost');
    assert.equal(tl.detailTopWait, true, 'Waiting attention must temporarily raise DetailWindow topmost');
    assert.equal(tl.mainTopRestoredOff, false, 'Clearing waiting attention must restore main Topmost=false');
    assert.equal(tl.detailTopRestoredOff, false, 'Clearing waiting attention must restore DetailWindow Topmost=false');
    assert.equal(tl.hiddenAfterSync, true, 'Hidden window must stay hidden when Sync-AgentPetTopmost runs');

    // Case 20: validate template rendering and behavior on the real menu controls.
    const rm = data.roundedMenu;
    assert.equal(rm.themes.length, 5);
    assert.equal(new Set(rm.themes.map(theme => theme.expected)).size, 5);
    for (const theme of rm.themes) {
      assert.equal(theme.wpf, theme.expected, theme.character + ': WPF menu theme');
      assert.equal(theme.tray, theme.expected, theme.character + ': tray menu theme');
      assert.equal(theme.wpfHover, theme.expectedHover, theme.character + ': WPF hover fill');
      assert.equal(theme.wpfChecked, theme.expectedChecked, theme.character + ': WPF checked fill');
      assert.equal(theme.trayHover, theme.expectedHover, theme.character + ': tray hover fill');
      assert.equal(theme.trayChecked, theme.expectedChecked, theme.character + ': tray checked fill');
    }
    assert.deepEqual(rm.trayHoverPixels, [rm.themes.at(-1).expectedHover, rm.themes.at(-1).expectedChecked],
      'tray hover uses the checked fill only when the hovered row is checked');
    assert.deepEqual(rm.labels, ['自动跟随', '待机', '思考', '工作', '瞌睡', '开心']);
    assert.deepEqual(rm.checks, ['happy']);
    assert.equal(rm.separatorAfterAuto, true);
    assert.equal(rm.rootRadius, 12);
    assert.equal(rm.subRadius, 12);
    assert.equal(rm.submenuVisible, true);
    assert.equal(rm.subSurface, rm.themes.at(-1).expected);
    assert.equal(rm.selectedFill, rm.expectedSelectedFill);
    assert.equal(rm.defaultRowHeight, 34);
    assert.equal(rm.rowFont, 'Normal');
    assert.equal(rm.arrow, 'Visible');
    assert.equal(rm.traySubmenuThemed, true);
    assert.equal(rm.trayHasNativeGutter, false);
    assert.ok(rm.trayMenuCount > 1);
    assert.deepEqual(rm.rootLabels, [
      '切换角色', '动作形态', '查看并刷新 Codex 额度', '查看并刷新 DeepSeek 余额', '随机台词', '外观',
      '打盹时间', '定时碎碎念', '音效与音量', '状态播报（播报中）', '悬停详情', '查看任务详情', '窗口置顶', '重置位置到右下角'
    ]);
    assert.equal(rm.rootRowHeight, 32);
    assert.deepEqual(rm.appearanceLabels.map(label => label.split(' (')[0]), ['立绘缩放比例', '气泡缩放', '气泡字体大小', '气泡印章风格']);
    assert.equal(rm.trayToggleRemoved, true, 'TrayEnabled toggle must be removed from tray menu tag');
    assert.equal(rm.bubbleDefaultWithoutTray, 'Visible', '气泡默认偏好 needs a desktop menu entry when the tray is disabled');
    assert.equal(rm.footer.exitLabel, '退出 AgentPet');
    assert.equal(rm.footer.versionText, rm.footer.expectedVersion);
    assert.equal(rm.footer.aligned, true, `exit and version aligned (${JSON.stringify(rm.footer)})`);
    assert.ok(Math.abs(rm.footer.labelOffset) <= 1, `exit label starts at the same column as root labels (${rm.footer.labelOffset})`);
    assert.equal(rm.submenuAnimation, 'Fade', 'submenu uses AgentPet fade');
    assert.equal(rm.poseChangedInPlace, true, 'pose choice should update existing menu rows');
    assert.equal(rm.taskSoundChangedInPlace, true, 'task-completion sound toggle should keep and update the existing menu');
    assert.deepEqual(rm.footer.hits, [true, true, true, true], `exit footer hit-test failed: ${JSON.stringify(rm.footer)}`);
    assert.equal(rm.sliderVisible, true);
    assert.equal(rm.sliderStaysOpen, true);
    assert.equal(rm.sliderChanged, true);

    // Case 21 covers real manual entry points, request ownership and reading lifetime.
    const inspection = data.manualInspection;
    assert.equal(inspection.entries.length, 7);
    for (const entry of inspection.entries) {
      assert.equal(entry.afterClick, entry.expected, entry.name + ': opens requested panel');
      assert.equal(entry.afterStatus, entry.expected, entry.name + ': survives a work update');
      assert.equal(entry.active, entry.expected, entry.name + ': activates reading protection');
      assert.equal(entry.hidden, false, entry.name + ': clears manual hiding');
    }
    for (const reading of inspection.lifecycle) {
      assert.equal(reading.pendingProtected, true, reading.mode + ': remains visible while pending');
      assert.equal(reading.readingSeconds, 5, reading.mode + ': starts five seconds after completion');
      assert.equal(reading.hoverProtected, true, reading.mode + ': remains visible while hovered');
      assert.equal(reading.leaveSeconds, 2, reading.mode + ': restores two seconds after leaving');
      assert.equal(reading.afterExpiry, 'work', reading.mode + ': restores live work after reading');
    }
    for (const transition of inspection.transitions) {
      const urgent = ['waiting', 'approval'].includes(transition.state);
      assert.equal(transition.panel, urgent ? 'work' : 'quota', transition.state + ': panel priority');
      assert.equal(transition.active, urgent ? '' : 'quota', transition.state + ': reading protection');
      assert.equal(transition.open, true, transition.state + ': keeps the chosen bubble visible');
      assert.equal(transition.busy, urgent, transition.state + ': still updates actual busy state');
    }
    assert.equal(inspection.defaultUnchanged, true, 'manual reading preserves the default panel preference');
    assert.equal(inspection.idleExpired, true, 'a completed agent leaves the query visible until the reading period expires');
    assert.equal(inspection.panelChangeCancels, true, 'choosing another panel cancels manual reading');
    assert.equal(inspection.hideCancels, true, 'explicit hiding cancels manual reading');
    assert.equal(inspection.existingWaitingWins, true, 'an existing waiting state retains priority over a query');

    assert.equal(data.renewedInspection.requestWritten, true, 'secondary refresh writes a real isolated request flag');
    assert.equal(data.renewedInspection.requestStillPending, true, 'the secondary request outlives the old reading deadline');
    assert.equal(data.renewedInspection.deadlineSuspended, true, 'a secondary request suspends the previous reading deadline');
    assert.equal(data.renewedInspection.panelDuringRequest, 'deepseek', 'secondary refresh survives the expired old deadline');
    assert.equal(data.renewedInspection.readingSeconds, 5, 'the secondary result starts a new five-second reading period');
    assert.equal(data.sliderPersistence.length, 4);
    for (const slider of data.sliderPersistence) {
      const label = slider.kind + ' ' + slider.scenario;
      assert.equal(slider.changed, true, label + ': changes the live value');
      assert.equal(slider.closed, true, label + ': closes the menu');
      assert.equal(slider.actual, slider.expected, label + ': menu closure persists the value');
    }
    assert.equal(data.windowExitPersistence.menuClosed, true, 'window exit is tested independently of menu closure');
    assert.equal(data.windowExitPersistence.dirtyBeforeExit, true, 'window exit begins with unsaved slider changes');
    assert.equal(data.windowExitPersistence.actual, data.windowExitPersistence.expected, 'window exit persists unsaved slider changes');
    assert.equal(data.windowExitPersistence.dirtyAfterExit, false, 'window exit clears committed slider changes');
    assert.deepEqual(data.checksAt115, ['115%'], 'the preset selection follows the slider');
    assert.deepEqual(data.checksAt110, [], 'a slider value without a preset clears the old selection');

    // Case 23 assertions: FIX-01..FIX-04 UI & timer interaction regressions
    const c23 = data.case23Regression;
    assert.equal(c23.busyHide.openAfterClick, false, 'FIX-01: tray hide must close bubble immediately');
    assert.equal(c23.busyHide.flagAfterClick, true, 'FIX-01: tray hide must set manualBubbleHidden');
    assert.equal(c23.busyHide.openAfterTick, false, 'FIX-01: busy non-work hide must stay closed after timer tick & status pulse');
    assert.equal(c23.busyHide.flagAfterTick, true, 'FIX-01: manualBubbleHidden must stay true');
    assert.equal(c23.busyHide.workVisAfterTick, 'Collapsed', 'FIX-01: WorkStatusPanel must not pop back to Visible');
    assert.equal(c23.busyHide.approvalOpen, true, 'FIX-01: approval state must still wake bubble');
    assert.equal(c23.busyHide.approvalPanel, 'work', 'FIX-01: approval wake must target work panel');

    assert.equal(c23.busyQuote.entries.length, 4);
    for (const q of c23.busyQuote.entries) {
      assert.equal(q.panelInit, 'quote', `FIX-02 ${q.entry}: must open quote`);
      assert.equal(q.panelAfterTick, 'quote', `FIX-02 ${q.entry}: must stay quote across timer tick and working pulse`);
      assert.equal(q.openAfterTick, true, `FIX-02 ${q.entry}: must keep bubble open`);
      assert.equal(q.hiddenAfterTick, false, `FIX-02 ${q.entry}: must clear manualBubbleHidden`);
    }
    assert.equal(c23.busyQuote.cycleQuoteToQuota.panel, 'quota', 'FIX-02: clicking busy quote must cycle to quota');
    assert.equal(c23.busyQuote.cycleQuoteToQuota.active, 'quota', 'FIX-02: cycling quote -> quota while busy must activate inspection');
    assert.equal(c23.busyQuote.cycleQuotaToDeepSeek.panel, 'deepseek', 'FIX-02: clicking quota must cycle to deepseek');
    assert.equal(c23.busyQuote.cycleQuotaToDeepSeek.active, 'deepseek', 'FIX-02: cycling quota -> deepseek while busy must activate inspection');
    assert.ok(c23.busyQuote.extendedSeconds >= 1.4, `FIX-02: hover must extend temporary quote (~+1.7s expected, got ${c23.busyQuote.extendedSeconds})`);
    assert.ok(Math.abs(c23.busyQuote.leaveSeconds - 2) < 0.05, `FIX-02: leaving quote must start 2s grace (got ${c23.busyQuote.leaveSeconds})`);
    assert.equal(c23.busyQuote.duringLeavePanel, 'quote', 'FIX-02: must stay quote during 2s leave grace');
    assert.equal(c23.busyQuote.expiredPanel, 'work', 'FIX-02: expired temporary quote must restore work');
    assert.equal(c23.busyQuote.idlePreservedPanel, 'quote', 'FIX-02: busy -> idle transition must preserve temporary quote');
    assert.equal(c23.busyQuote.idlePreservedOpen, true, 'FIX-02: busy -> idle transition must keep temporary quote open');
    assert.equal(c23.busyQuote.reenterChecks.length, 4);
    for (const rc of c23.busyQuote.reenterChecks) {
      assert.equal(rc.panelAfterEnd, 'quote', `R-01 ${rc.reason}: ending busy must preserve quote`);
      assert.equal(rc.openAfterEnd, true, `R-01 ${rc.reason}: ending busy must keep bubble open`);
      assert.equal(rc.panelAfterResume, 'quote', `R-01 ${rc.reason}: re-entering working within 5.5s must not overwrite quote`);
      assert.equal(rc.openAfterResume, true, `R-01 ${rc.reason}: re-entering working must keep bubble open`);
    }
    assert.equal(c23.busyQuote.idleAt4sPanel, 'quote', 'R-01: early idle hover+leave must NOT shorten 5.5s quote to 3.8s');
    assert.equal(c23.busyQuote.idleAt4sOpen, true, 'R-01: bubble must remain open at t=4s after t=1s hover + t=1.5s leave');
    assert.equal(c23.busyQuote.idleEventuallyClosed, true, 'FIX-02: preserved quote must close cleanly after hold expires');
    assert.equal(c23.busyQuote.quoteBlockedByApproval, 'work', 'FIX-02: quote trigger during approval must stay on work');
    assert.equal(c23.busyQuote.charBlockedByApproval, 'work', 'FIX-02: role switch during approval must not replace work');

    assert.equal(c23.hiddenRules.idleAutoQuoteBlocked, true, 'FIX-03: manual hide must suppress idle auto-quotes');
    assert.equal(c23.hiddenRules.reopenEntries.length, 5);
    for (const r of c23.hiddenRules.reopenEntries) {
      assert.equal(r.hidden, false, `FIX-03 ${r.kind}: explicit reopen must clear manualBubbleHidden`);
      assert.equal(r.open, true, `FIX-03 ${r.kind}: explicit reopen must open bubble`);
    }

    assert.equal(c23.balanceUi.failNotice, '请求失败', 'FIX-04: flag write failure must report 请求失败');
    assert.equal(c23.balanceUi.failTimeoutNull, true, 'FIX-04: write failure must not arm 15s timeout');
    assert.equal(c23.balanceUi.failStartZero, true, 'FIX-04: write failure must clear request start');
    assert.equal(c23.balanceUi.failDidNotConsumeCooldown, true, 'FIX-04: write failure must not consume 10s cooldown');
    assert.equal(c23.balanceUi.retryNotice, '刷新中...', 'FIX-04: immediate retry after write failure must proceed');
    assert.equal(c23.balanceUi.retryFlagWritten, true);
    assert.equal(c23.balanceUi.retryTimeoutArmed, true);
    assert.equal(c23.balanceUi.emptyCooldownNotice, '冷却中');
    assert.equal(c23.balanceUi.emptyCooldownTitle, '刷新冷却中');
    assert.ok(c23.balanceUi.emptyCooldownDetail.includes('7 秒'));
    assert.equal(c23.balanceUi.emptyRateNotice, '频率限制');
    assert.equal(c23.balanceUi.emptyRateTitle, '请求频率受限');
    assert.ok(c23.balanceUi.emptyRateDetail.includes('12 秒'));

    const batchOne = data.batchOne;
    assert.ok(batchOne.quoteButton, 'Case 24: 换一句 must be a WPF button');
    assert.ok(batchOne.quoteClickHandled, 'Case 24: 换一句 must handle its click');
    assert.ok(batchOne.quoteChanged, 'Case 24: 换一句 must update the quote text');
    assert.equal(batchOne.quotePanelAfterClick, 'quote', 'Case 24: 换一句 must remain in the same panel');
    assert.ok(batchOne.quoteRenewal > 3.5 && batchOne.closeRenewal > 3.5, 'Case 24: 换一句 must restart the quote reading window');
    assert.equal(batchOne.quotePanelAfterTextClick, 'quote', 'Case 24: clicking the quote text must not cycle');
    assert.equal(batchOne.quotePanelAfterWork, 'quote', 'Case 24: a working update must preserve the replacement quote');
    assert.equal(batchOne.panelAfterBlankClick, 'quota', 'Case 24: clicking the bubble background must still cycle');
    assert.equal(batchOne.liveFontSwitches.length, 8);
    for (const c of batchOne.liveFontSwitches) {
      const padding = c.panel === 'quota' ? 0 : c.font >= 1.3 ? 4 : 8;
      assert.equal(c.padding, padding, `Case 24: same-panel padding must sync at once (${JSON.stringify(c)})`);
      assert.equal(c.activePanel, c.panel, 'Case 24: font preview must stay on the current panel');
      assert.equal(c.moved, false, 'Case 24: font preview must keep the same anchor');
    }
    assert.deepEqual(batchOne.fontLayouts.map((c) => c.fontScale), [1.3, 1.4]);
    for (const c of batchOne.fontLayouts) {
      assert.ok(Math.abs(c.quoteHeight - 3 * c.quoteLineHeight) <= 0.8, `Case 24 ${c.fontScale}: quote needs three lines (${JSON.stringify(c)})`);
      assert.ok(c.quoteTop >= -0.8 && c.quoteBottomGap >= -0.8, `Case 24 ${c.fontScale}: 3-line quote must fit the visible card body (${JSON.stringify(c)})`);
      assert.ok(c.weekTrackHeight >= 3.5 && c.weekTrackBottomGap >= -0.8, `Case 24 ${c.fontScale}: weekly progress track must fit (${JSON.stringify(c)})`);
      assert.ok(Math.abs(c.cardHeight - (c.fontScale === 1.3 ? 122 : 128)) <= 0.8, 'Case 24: quota ticket must allocate height for scaled text');
    }
    assert.equal(batchOne.refreshTargets.length, 12);
    for (const c of batchOne.refreshTargets) {
      assert.ok(c.width >= 24 - 0.01 && c.height >= 24 - 0.01, `Case 24: refresh needs 24 × 24 rendered DIPs (${JSON.stringify(c)})`);
      assert.ok(c.cornersHit, `Case 24: refresh transparent corners must be clickable (${JSON.stringify(c)})`);
    }

    // Cases 25 and 26 check the applied WPF brushes and user interaction paths.
    function parseWpfColor(value) {
      assert.match(value, /^#[0-9a-f]{8}$/i, 'WPF color must be ARGB');
      return (value.slice(1).match(/../g) || []).map((channel) => parseInt(channel, 16) / 255);
    }
    function paintWpfColor(value, underlying) {
      const [alpha, ...rgb] = parseWpfColor(value);
      return rgb.map((channel, i) => alpha * channel + (1 - alpha) * underlying[i]);
    }
    function relativeLuminance(rgb) {
      const linear = rgb.map((ch) => ch <= 0.04045 ? ch / 12.92 : ((ch + 0.055) / 1.055) ** 2.4);
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    }
    const readability = data.batchTwoReadability;
    assert.deepEqual([...new Set(readability.colors.map((row) => row.role))], ['claude', 'dragon', 'gemini', 'deepseek', 'zcode']);
    assert.ok(readability.colors.length >= 60);
    for (const row of readability.colors) {
      const underlying = paintWpfColor(row.base, [1, 1, 1]);
      const background = paintWpfColor(row.bg, underlying);
      const foreground = paintWpfColor(row.fg, background);
      const lum = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
      const ratio = (lum[0] + 0.05) / (lum[1] + 0.05);
      assert.ok(ratio >= row.minimum, `Case 25 ${row.role}/${row.name}: contrast ${ratio.toFixed(2)} below ${row.minimum} (${JSON.stringify(row)})`);
    }
    assert.deepEqual(readability.stamps.map(s => s.role), ['claude','dragon','gemini','deepseek','zcode']);
    for (const s of readability.stamps) {
      assert.equal(s.artwork, s.role + '.png');
      assert.ok(s.shared && s.visible, s.role + ' requires the same printed artwork on both rows');
    }
    assert.deepEqual(readability.lineartStamps.map(s => s.role), ['claude','dragon','gemini','deepseek','zcode']);
    for (const s of readability.lineartStamps) {
      assert.equal(s.folder, 'lineart', s.role + ': lineart stamp must come from quota-stamps/lineart');
      assert.equal(s.artwork, s.role + '.png');
      assert.ok(s.shared && s.visible, s.role + ': lineart stamp must share source and be visible');
    }
    const workStamp = readability.workStyle;
    assert.equal(path.basename(path.dirname(workStamp.lineart)), 'lineart');
    assert.equal(path.basename(path.dirname(workStamp.embossed)), 'embossed');
    assert.equal(path.basename(workStamp.lineart), 'zcode.png');
    assert.ok(workStamp.shown && workStamp.panel === 'work' && workStamp.panelAfter === 'work', 'both menus must restyle the visible work bubble in place');
    assert.equal(path.basename(path.dirname(readability.fallback)), 'embossed');
    assert.equal(path.basename(readability.fallback), 'gemini.png');
    assert.equal(readability.sharedFallback, true);
    assert.equal(path.basename(path.dirname(readability.unaffected)), 'lineart');
    const sms = readability.stampMenuSync;
    assert.equal(sms.toLineart.defaultCfg, 'embossed', 'Default QuotaStampStyle must remain embossed');
    assert.equal(sms.toLineart.cfg, 'lineart', 'Tray click must switch QuotaStampStyle to lineart');
    assert.equal(sms.toLineart.trayEmb, false);
    assert.equal(sms.toLineart.trayLin, true);
    assert.equal(sms.toLineart.wpfEmb, false);
    assert.equal(sms.toLineart.wpfLin, true);
    assert.equal(sms.toEmbossed.cfg, 'embossed', 'WPF click must restore QuotaStampStyle to embossed');
    assert.equal(sms.toEmbossed.folder, 'embossed');
    assert.equal(sms.toEmbossed.trayEmb, true);
    assert.equal(sms.toEmbossed.trayLin, false);
    assert.equal(sms.toEmbossed.wpfEmb, true);
    assert.equal(sms.toEmbossed.wpfLin, false);
    assert.equal(readability.progress.length, 8);
    for (const row of readability.progress) {
      assert.ok(row.track > 0 && Math.abs(row.width - row.track * row.remaining / 100) <= 1, 'hidden snapshot or resized track: ' + JSON.stringify(row));
      assert.equal(row.stamp, row.remaining > 25);
      assert.equal(row.alert, row.remaining <= 25);
    }
    assert.equal(readability.alerts.length, 12);
    for (const row of readability.alerts) {
      const state = row.remaining <= 10 ? '紧张' : row.remaining <= 25 ? '偏低' : '';
      const context = `Case 25 ${row.scale}/${row.row}/${row.remaining}%`;
      assert.equal(row.visible, Boolean(state), context);
      assert.equal(row.percent, `${row.remaining}%`, context);
      if (state) {
        assert.ok(row.text.includes(state), `${context}: warning must have a visible text equivalent`);
        assert.ok(row.automationName.includes(state) && row.automationName.includes(row.percent), `${context}: accessible text must announce state and remaining quota`);
      }
      assert.ok(row.fits, `${context}: warning and percent must fit the fixed card, including the weekly track`);
    }
    for (const row of readability.fullText) {
      assert.ok(row.text && row.hint === row.text, `Case 25 ${row.name}: tooltip must preserve current full text`);
    }
    const detailEntry = data.batchTwoDetail;
    assert.equal(detailEntry.disabledHoverOpen, false, 'Case 26: turning off automatic hover should not auto-open task detail');
    assert.equal(detailEntry.mouseActivation, false, 'Case 26: clicking the bubble details affordance must preserve focus');
    for (const check of ['buttonVisible', 'buttonHandlesClick', 'manualPinned', 'manualSurvivesPointerLeave', 'secondClickCloses', 'panelChangeCloses', 'idleCloses', 'menuVisible', 'menuOpens', 'menuEnablesKeyboard', 'keyboardScrolls', 'escapeCloses']) {
      assert.equal(detailEntry[check], true, `Case 26 failed: ${check}`);
    }
    assert.ok(detailEntry.scrollable > 0, 'Case 26: long details must contain real scrollable content');
    assert.equal(detailEntry.arrows.length, 2);
    for (const row of detailEntry.arrows) {
      assert.ok(row.visible && row.arrowHit && !row.otherHit, `Case 26 ${row.placement}: hover probe must be exclusively on the visible arrow (${JSON.stringify(row)})`);
      assert.ok(row.remainsOpen, `Case 26 ${row.placement}: hovering the connecting arrow must keep the details open`);
    }

    const drc = data.dragReleaseCase;
    assert.ok(drc, 'Case 28: dragReleaseCase output must exist');
    assert.equal(drc.syncLostFired, true, 'Case 28: synchronous LostMouseCapture must fire during MouseLeftButtonUp release');
    assert.equal(drc.dragBounceCount, 1, 'Case 28: drag-release must bounce exactly once despite synchronous LostMouseCapture');
    assert.equal(drc.dragBubbleOpen, false, 'Case 28: drag-release must not enter single-click branch or open bubble');
    assert.equal(drc.dragQuotaFlag, false, 'Case 28: drag-release must not trigger quota refresh');
    assert.equal(drc.savedLeft, 220, 'Case 28: drag-release must persist updated Window.Left');
    assert.equal(drc.savedTop, 310, 'Case 28: drag-release must persist updated Window.Top');
    assert.equal(drc.lostBounceCount, 1, 'Case 28: unexpected LostMouseCapture must recover pressed pose once');
    assert.equal(drc.lostIsDragging, false, 'Case 28: unexpected LostMouseCapture must clear isDragging');

    console.log('PASS: ui-layout-detail (Option B themes/split, fade closure, menu scope, DeepSeek FontScale & DetailWindow HWND sync)');
  } finally {
    if (fs.existsSync(assetsJunction)) {
      spawnSync('cmd.exe', ['/c', 'rmdir', assetsJunction], { encoding: 'utf8' });
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

try {
  runWpfLayoutAndDetailSuite();
} catch (err) {
  console.error('[ui-layout-detail.test.mjs FAILURE]', (err && err.stack) || err);
  process.exitCode = 1;
}
