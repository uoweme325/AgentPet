## v1.6.6 合并更新

- 同一 DSH 会话有多条未决审批时，会逐条判断时间戳。超前的请求不会遮住仍有效的审批，处理其中一条后仍会提示其余有效审批。
- 使用说明明确推荐 Node.js 24 LTS。使用 Node.js 22 LTS 读取 DSH 压缩日志时需要 22.15.0 或更新的 22.x。
- 源码包包含新增的并发审批回归，Windows 测试沿用各套件的超时设置。

### 合并版下载

| 用途 | 文件 | 校验 |
| --- | --- | --- |
| Windows 便携版 | [AgentPet_v1.6.6-merged.zip](https://github.com/uoweme325/AgentPet/releases/download/v1.6.6/AgentPet_v1.6.6-merged.zip) | [SHA-256](https://github.com/uoweme325/AgentPet/releases/download/v1.6.6/AgentPet_v1.6.6-merged.zip.sha256) |
| 源码与回归 | [AgentPet-v1.6.6-merged-GitHub.zip](https://github.com/uoweme325/AgentPet/releases/download/v1.6.6/AgentPet-v1.6.6-merged-GitHub.zip) | [SHA-256](https://github.com/uoweme325/AgentPet/releases/download/v1.6.6/AgentPet-v1.6.6-merged-GitHub.zip.sha256) |

[合并版源码标签](https://github.com/uoweme325/AgentPet/tree/v1.6.6-merged)

## v1.6.6 首次发布

- **DSH 权限审批**。原生审批会显示「等待确认」。允许、拒绝或取消后，桌宠按实际进度更新。停止并归档的回合按中止收尾，过期审批会让出气泡。
- **DSH 普通选择题**。原生提问会显示「等待回答」，提交选项后解除等待。
- **DSH 压缩日志**。按 Zstandard 独立帧读取当前回合。连续追加时复用已验证的帧偏移，减少读取及解压量，保留原有扫描周期。
- **审批提醒期限**。没有决定或结束事件时，桌宠提示在 30 分钟后收起。DSH 继续管理审批本身。
- **启动与回归**。统一桌宠的单实例锁名，更新 Codex 额度查询的客户端版本标识。新增 Windows 自动回归，调整测试超时预算，并加入 DSH 专项用例。

首次发布的附件为 `AgentPet_v1.6.6.zip` 和 `AgentPet-v1.6.6-GitHub.zip`，均附 SHA-256 校验文件。
