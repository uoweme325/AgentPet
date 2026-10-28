@echo off
chcp 936 >nul
setlocal

set "TARGET_DIR=%~dp0"
if "%TARGET_DIR:~-1%"=="\" set "TARGET_DIR=%TARGET_DIR:~0,-1%"
set "VBS_PATH=%TARGET_DIR%\launch.vbs"
set "ICON_PATH=%TARGET_DIR%\assets\claude-pet.ico"

if not exist "%VBS_PATH%" (
    echo [错误] 未在当前目录下找到启动脚本: "%VBS_PATH%"
    echo 请确保在 AgentPet 项目根目录运行此脚本。
    pause
    exit /b 1
)

if not exist "%ICON_PATH%" (
    echo [提示] 未找到 Claude 娘图标: "%ICON_PATH%"，将使用默认图标。
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $vbs = $env:VBS_PATH; $workDir = $env:TARGET_DIR; $icon = $env:ICON_PATH; $desktop = [Environment]::GetFolderPath('Desktop'); $lnkPath = Join-Path $desktop 'AgentPet.lnk'; $ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($lnkPath); $s.TargetPath = 'wscript.exe'; $s.Arguments = [char]34 + $vbs + [char]34; $s.WorkingDirectory = $workDir; if (Test-Path $icon) { $s.IconLocation = $icon }; $s.Description = 'AgentPet'; $s.Save(); if (-not (Test-Path $lnkPath)) { throw ('快捷方式未成功生成: ' + $lnkPath) }; $chk = $ws.CreateShortcut($lnkPath); Write-Host ('[验证] 快捷方式: ' + $chk.FullName); Write-Host ('[验证] TargetPath: ' + $chk.TargetPath); Write-Host ('[验证] Arguments: ' + $chk.Arguments); Write-Host ('[验证] WorkDir: ' + $chk.WorkingDirectory); Write-Host ('[验证] IconLocation: ' + $chk.IconLocation);"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [错误] 创建桌面快捷方式失败，退出码: %ERRORLEVEL%
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [成功] AgentPet 桌面快捷方式已成功创建并验证！
pause
exit /b 0
