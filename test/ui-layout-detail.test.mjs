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

  let ps1Source = fs.readFileSync(ps1Path, 'utf8').replace(/^\uFEFF/, '');
  assert.ok(ps1Source.includes('"Local\\AgentPet_SingleInstance_Mutex_'), 'expected mutex declaration in AgentPet.ps1');
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
    ps1Source = ps1Source.replace(/Local\\AgentPet_SingleInstance_Mutex_[^"']+/g, uniqueMutex);

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
        return [ordered]@{
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
            watermarkGlyph  = [string]$WorkBodyWatermark.Text
        }
    }

    # --- Case 8 (CH-01~03): Theme & State matrix (claude/dragon/gemini x working/waiting/error/success + panel reset) ---
    $themeMatrix = @()
    foreach ($ch in @('claude', 'dragon', 'gemini')) {
        $Config.Character = $ch
        Update-Theme
        foreach ($st in @('working', 'waiting', 'error', 'success')) {
            Set-WorkPayload -source 'Codex' -task '多角色配色与状态边框核验' -state $st -workingCount 2 -sources @('Codex', 'Antigravity')
            $snap = Get-BubbleStageSnapshot "$ch/$st"
            $snap.borderBrush = [string]$BubbleBorder.BorderBrush
            $snap.bannerCornerTL = Safe-Round $WorkHeaderBanner.CornerRadius.TopLeft 1
            $snap.cardCornerTL = Safe-Round $BubbleBorder.CornerRadius.TopLeft 1
            $snap.codexFg = [string](Get-AgentSourceStyle 'codex').Foreground
            $snap.codexPillBg = [string](Get-AgentSourceStyle 'codex').Background
            $snap.codexDetailBg = [string](Get-AgentSourceStyle 'codex').DetailBackground
            $themeMatrix += $snap
        }
    }
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
        return [ordered]@{
            tag          = $tag
            fs           = [double]$Config.FontScale
            panelH       = $panelH
            innerH       = $innerH
            noticeRow    = $noticeRow
            availNoticeW = $availNoticeW
            noticeDesW   = $noticeDesW
            hdrFs        = Safe-Round $DeepSeekHeader.FontSize
            noticeFs     = Safe-Round $DeepSeekStatusNotice.FontSize
            curFs        = Safe-Round $DeepSeekCurrencyLabel.FontSize
            totalFs      = Safe-Round $DeepSeekTotalText.FontSize
            bdFs         = Safe-Round $DeepSeekBreakdownText.FontSize
            msgDetailFs  = Safe-Round $DeepSeekMsgDetail.FontSize
            hdrText      = [string]$DeepSeekHeader.Text
            noticeText   = [string]$DeepSeekStatusNotice.Text
            okVis        = [string]$DeepSeekOkPanel.Visibility
            msgVis       = [string]$DeepSeekMsgPanel.Visibility
            padLeft      = Safe-Round $BubbleBorder.Padding.Left 1
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
    $errBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; status = 'timeout'
        message = '15 秒内未从 DSH 或 DeepSeek 官方 API 获取到余额，可点击右上角 ↻ 手动重试。'
    }
    $unavailBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; status = 'unavailable'
        errorMessage = '启动后未获取到余额数据'
    }
    $dshOffBal = [PSCustomObject]@{
        type = 'balance'; provider = 'deepseek-official'; status = 'dsh_not_running'
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
    $dsPadAt14 = Safe-Round $BubbleBorder.Padding.Left 1
    $Config.FontScale = 1.0
    Update-FontScale
    $dsPadAt10 = Safe-Round $BubbleBorder.Padding.Left 1

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

    # --- Case 17: Role-aligned quote counts + live character work status translation on theme switch ---
    $Config.HoverDetailsEnabled = $true
    $Config.Character = 'claude'
    Update-Theme
    Set-WorkPayload -source 'Codex' -state 'working' -stateText '已按典籍上的蓝图动笔改代码啦~' -task '编辑核心文件' -taskDetail '多角色工作状态同步切换校验'
    Open-HoverDetailCard
    Pump-Wpf
    $roleWorkResults = [ordered]@{}
    foreach ($ch in @('claude', 'gemini', 'dragon')) {
        $Config.Character = $ch
        Update-Theme
        Pump-Wpf
        $wt = [string]$WorkTask.Text
        $roleWorkResults[$ch] = [ordered]@{
            workTask     = $wt
            inOwnPool    = ($script:WorkStatusTextsByCharacter[$ch]['working'] -contains $wt)
            detailHintVs = [string]$script:DetailHintBanner.Visibility
            speakerText  = [string]$QuoteSpeaker.Text
            wakeQuote    = [string](Get-CharacterWakeQuote $ch)
        }
    }
    Close-HoverDetailCard
    $roleQuotesCheck = [ordered]@{
        claudeCount = $ClaudeQuotes.Count
        geminiCount = $GeminiQuotes.Count
        dragonCount = $DragonQuotes.Count
        workSwitch  = $roleWorkResults
    }

    $Window.Close()

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
        }
        deepSeekScaleCases  = $deepSeekScaleCases
        dsPadAt14           = $dsPadAt14
        dsPadAt10           = $dsPadAt10
        hoverConfigCases    = $hoverConfigCases
        roleQuotesCheck     = $roleQuotesCheck
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
      { encoding: 'utf8', timeout: 35000 }
    );
    assert.equal(
      res.status,
      0,
      `PowerShell UI driver exited with ${res.status}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`
    );

    const jsonLine = (res.stdout || '')
      .split(/\r?\n/)
      .find((line) => line.startsWith('RESULT_JSON:'));
    assert.ok(jsonLine, `Missing RESULT_JSON line in stdout:\n${res.stdout}`);
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
    assert.equal(data.themeMatrix.length, 12, 'must cover 3 characters x 4 work states');
    const expectedBgMap = { claude: '#FFFFF6EC', dragon: '#FFF4F3FB', gemini: '#FFF5F1FF' };
    for (const item of data.themeMatrix) {
      const [ch, st] = item.tag.split('/');
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
      } else if (st === 'success') {
        assert.equal(item.borderThick, 1.5, `${item.tag} success border thickness`);
        assert.equal(item.borderBrush, '#CC10B981', `${item.tag} success mint border`);
      } else {
        assert.equal(item.borderThick, 2.2, `${item.tag} working Option B solid border thickness`);
        assert.equal(item.chipBg, '#00FFFFFF', `${item.tag} working transparent chip`);
        if (ch === 'dragon') {
          assert.equal(item.borderBrush, '#FF6D67A2');
          assert.equal(item.watermarkGlyph, '❖');
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
      const expW = isWork ? 254 : 264;
      const expBaseLeft = isWork ? 30 : 26;
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

    // Assertions: Case 15 DeepSeekPanel FontScale (0.8 / 1.0 / 1.15 / 1.3 / 1.4) x states & both update orders
    assert.equal(data.deepSeekScaleCases.length, 27, 'must cover 5x4 fsFirst + 2 error states + 5 stateFirst cases');
    const dsByTag = Object.fromEntries(data.deepSeekScaleCases.map((c) => [c.tag, c]));
    for (const c of data.deepSeekScaleCases) {
      assert.ok(c.panelH <= c.innerH + 0.5, `${c.tag} DeepSeekPanel overflow (${c.panelH} > ${c.innerH})`);
      assert.ok(c.noticeDesW <= c.availNoticeW + 0.5, `${c.tag} DeepSeekStatusNotice clipped (${c.noticeDesW} > ${c.availNoticeW} at row ${c.noticeRow})`);
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
      dsByTag['fsFirst/1.3/ok'].totalFs === 22.5 &&
      dsByTag['fsFirst/1.4/ok'].totalFs === 22.5,
      'DeepSeekTotalText.FontSize must follow min(1.25, FontScale) cap cleanly'
    );
    for (const targetFs of ['1.15', '1.3', '1.4']) {
      assert.equal(dsByTag[`stateFirst/ok->${targetFs}`].hdrFs, dsByTag[`fsFirst/${targetFs}/ok`].hdrFs, `ok->${targetFs} hdrFs order must match`);
      assert.equal(dsByTag[`stateFirst/ok->${targetFs}`].curFs, dsByTag[`fsFirst/${targetFs}/ok`].curFs, `ok->${targetFs} curFs order must match`);
      assert.equal(dsByTag[`stateFirst/ok->${targetFs}`].totalFs, dsByTag[`fsFirst/${targetFs}/ok`].totalFs, `ok->${targetFs} totalFs order must match`);
      assert.equal(dsByTag[`stateFirst/ok->${targetFs}`].panelH, dsByTag[`fsFirst/${targetFs}/ok`].panelH, `ok->${targetFs} panelH order must match`);
    }
    assert.equal(dsByTag['stateFirst/to->1.4'].hdrText, 'DeepSeek 余额', 'timeout compact title must survive FontScale toggle');
    assert.equal(dsByTag['stateFirst/to->1.4'].hdrFs, dsByTag['fsFirst/1.4/to'].hdrFs, 'to update order must match');
    assert.equal(data.dsPadAt14, 8, 'DeepSeek BubbleBorder left padding at 1.4x must compact to 8');
    assert.equal(data.dsPadAt10, 12, 'DeepSeek BubbleBorder left padding at 1.0x must restore to 12');

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
    for (const ch of ['claude', 'gemini', 'dragon']) {
      assert.equal(data.roleQuotesCheck.workSwitch[ch].inOwnPool, true, `${ch}: Update-Theme must map active work stateText to ${ch}'s own pool (got ${data.roleQuotesCheck.workSwitch[ch].workTask})`);
      assert.equal(data.roleQuotesCheck.workSwitch[ch].detailHintVs, 'Collapsed', `${ch}: matching main bubble stateText must dedup DetailHintBanner`);
    }
    assert.notEqual(data.roleQuotesCheck.workSwitch.claude.workTask, data.roleQuotesCheck.workSwitch.gemini.workTask);
    assert.notEqual(data.roleQuotesCheck.workSwitch.gemini.workTask, data.roleQuotesCheck.workSwitch.dragon.workTask);
    assert.equal(data.roleQuotesCheck.workSwitch.claude.speakerText, 'Claude娘（小克）');
    assert.equal(data.roleQuotesCheck.workSwitch.gemini.speakerText, 'Gemini娘（双子）');
    assert.equal(data.roleQuotesCheck.workSwitch.dragon.speakerText, '白龙娘（GPT娘）');
    for (const ch of ['claude', 'gemini', 'dragon']) {
      assert.ok(data.roleQuotesCheck.workSwitch[ch].wakeQuote && data.roleQuotesCheck.workSwitch[ch].wakeQuote.length > 0, `${ch}: wakeQuote must be non-empty`);
    }
    assert.notEqual(data.roleQuotesCheck.workSwitch.claude.wakeQuote, data.roleQuotesCheck.workSwitch.gemini.wakeQuote);
    assert.notEqual(data.roleQuotesCheck.workSwitch.gemini.wakeQuote, data.roleQuotesCheck.workSwitch.dragon.wakeQuote);
    assert.notEqual(data.roleQuotesCheck.workSwitch.claude.wakeQuote, data.roleQuotesCheck.workSwitch.dragon.wakeQuote);
    for (const rel of ['AgentPet.ps1', 'runtime/agent-monitor.mjs', 'assets/quotes.json']) {
      const txt = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assert.equal(txt.includes('摔跤'), false, `${rel} must not contain removed '摔跤' phrase`);
    }
    assert.equal(fs.readFileSync(path.join(repoRoot, 'AgentPet.ps1'), 'utf8').includes('星喵'), false, 'AgentPet.ps1 must use 双子 instead of 星喵');

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
