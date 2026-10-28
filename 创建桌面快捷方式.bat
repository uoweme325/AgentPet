@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
set "TARGET_DIR=%~dp0"
set "VBS_PATH=%TARGET_DIR%launch.vbs"
set "ICON_PATH=%TARGET_DIR%assets\claude.ico"
set "SHORTCUT_PATH=%USERPROFILE%\Desktop\AgentPet.lnk"

powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"%VBS_PATH%\"'; $s.WorkingDirectory = '%TARGET_DIR%'; $s.IconLocation = '%ICON_PATH%'; $s.Description = 'AgentPet 智能体桌宠'; $s.Save()"

echo 桌面快捷方式 [AgentPet] 已成功创建！
pause
exit
