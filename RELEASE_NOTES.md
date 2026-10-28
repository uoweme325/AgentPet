# AgentPet v1.4.1 GitHub 发布包

这是 AgentPet v1.4.1 的源码发布包，适合上传到 GitHub Release 或作为仓库初始内容使用。

## 包含内容

- `AgentPet.ps1`、`AgentPet.xaml`：桌宠主程序
- `runtime/agent-monitor.mjs`、`runtime/stop-agent.ps1`：状态监控与安全退出脚本
- `assets/`、`preview/`：角色立绘、托盘图标、音效和预览图
- Windows 启动、退出、快捷方式和开机自启脚本
- `config.example.json`：通用配置示例
- `README.md`、`LICENSE`：使用说明与许可证

## 发布包处理规则

发布包没有包含本机的 `config.json`、运行日志、PID 文件、额度快照、状态快照、备份文件和临时文件。这些文件可能记录窗口坐标、会话状态或本机运行信息。首次启动时，程序会在本地自动生成配置文件。

## 使用要求

- Windows PowerShell 5.1、WPF 和 .NET Framework（Windows 系统自带）
- 如果需要完整读取 Antigravity、Codex、DSH 的工作状态，请准备可用的现代 Node.js 运行时；本版本已在 Node.js v24.22.1 环境中完成验证
- 双击 `启动 AgentPet.bat` 启动；双击 `退出 AgentPet.bat` 退出

## v1.4.1 重点

- 托盘角色图标按透明像素裁切后统一为 32px，避免不同角色显示大小不齐
- 拖动边界按当前显示器工作区、DPI 和多屏负坐标计算，角色最多移出屏幕一半，气泡不参与限制
- 保留托盘隐藏、唤起、角色切换、额度与工作状态入口

## 发布前检查

上传前请确认仓库中没有把 `config.json`、`*.log`、`*.pid`、`runtime-status.json`、`runtime-quota.json` 或本机截图一并提交。项目根目录的 `.gitignore` 已覆盖主要运行时文件。

## 致谢与声明

发布包包含 THIRD_PARTY_NOTICES.md，并在 README 中声明参考了 [T7moris/GPT-Niang](https://github.com/T7moris/GPT-Niang)、[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，以及 AI 生成素材和 AI 辅助开发情况。
