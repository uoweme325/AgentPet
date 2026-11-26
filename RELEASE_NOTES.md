## v1.6.6 更新

- **DSH 权限审批**。原生审批会显示「等待确认」。允许、拒绝或取消后，桌宠按实际进度更新。停止并归档的回合按中止收尾，过期审批会让出气泡。并发审批分别校验时间戳，异常请求不会盖住仍有效的审批。
- **DSH 普通选择题**。原生提问会显示「等待回答」，提交选项后解除等待。
- **DSH 压缩日志**。按 Zstandard 独立帧读取当前回合。连续追加时复用已验证的帧偏移，减少读取及解压量，保留原有扫描周期。
- **审批提醒期限**。没有决定或结束事件时，桌宠提示在 30 分钟后收起。DSH 继续管理审批本身。
- **启动与回归**。统一桌宠的单实例锁名，更新 Codex 额度查询的客户端版本标识。新增 Windows 自动回归，调整测试超时预算，并加入 DSH 专项用例，覆盖并发审批的时间偏差与状态切换。
- **运行环境**。推荐 Node.js 24 LTS。使用 Node.js 22 LTS 读取 DSH 的 `.zstd` 压缩会话日志时，须为 22.15.0 或更新的 22.x。

### 下载

| 用途 | 文件 | 校验 |
| --- | --- | --- |
| Windows 便携版 | [AgentPet_v1.6.6.zip](https://github.com/uoweme325/AgentPet/releases/download/v1.6.6/AgentPet_v1.6.6.zip) | [SHA-256](https://github.com/uoweme325/AgentPet/releases/download/v1.6.6/AgentPet_v1.6.6.zip.sha256) |
| 源码与测试 | [AgentPet-v1.6.6-GitHub.zip](https://github.com/uoweme325/AgentPet/releases/download/v1.6.6/AgentPet-v1.6.6-GitHub.zip) | [SHA-256](https://github.com/uoweme325/AgentPet/releases/download/v1.6.6/AgentPet-v1.6.6-GitHub.zip.sha256) |
