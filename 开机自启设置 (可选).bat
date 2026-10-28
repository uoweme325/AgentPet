@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
set "VBS_PATH=%~dp0launch.vbs"
set "REG_KEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Run"

echo ==============================================
echo       AgentPet 开机自启设置
echo ==============================================
echo [1] 开启开机自启
echo [2] 关闭开机自启
echo [3] 退出
echo.
set /p opt="请选择操作 (1/2/3): "

if "%opt%"=="1" (
    reg add "%REG_KEY%" /v "AgentPet" /t REG_SZ /d "wscript.exe \"%VBS_PATH%\"" /f >nul
    echo.
    echo 已成功设置 AgentPet 开机自动启动！
) else if "%opt%"=="2" (
    reg delete "%REG_KEY%" /v "AgentPet" /f >nul 2>&1
    echo.
    echo 已取消 AgentPet 开机自启。
) else (
    echo 操作已取消。
)
pause
exit
