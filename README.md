# 🐾 AgentPet

把 Agent 的工作状态带到桌面上，让等待 Agent 工作的时间少一些无聊。

AgentPet 是一款 Windows 桌宠，支持联动 **Antigravity（反重力）、Codex 和 DeepSeek Harness（DSH）**。它会通过气泡展示思考、工作和等待确认等状态，也能帮你查看 Codex 额度与 DeepSeek 余额。

点击桌宠可以查看看板，点击气泡可在额度、余额和随机台词之间切换，还能通过桌宠互动放松一下。

## 🖼️ 角色预览

| 小克（Claude娘） | 白龙（GPT娘） | 双子（Gemini娘） |
| :---: | :---: | :---: |
| ![小克](preview/claude-happy-preview.png) | ![白龙](preview/dragon-happy-preview.png) | ![双子](preview/gemini-happy-preview.png) |

## 🌟 功能介绍

- **Agent 状态联动**：展示三个 Agent 的思考、工作和等待确认等状态。
- **气泡三看板**：切换 Codex 额度、DeepSeek 余额和随机台词，也可以设置默认看板。
- **DeepSeek 余额提醒**：展示人民币余额及可用的充值、赠金明细，低于设定阈值时轻提醒。
- **隐私与数据处理**：工作状态与 Codex 额度从本地读取；DeepSeek 余额由本机 DSH 宿主负责鉴权与查询，AgentPet 不读取或保管登录凭据。
- **免安装便携**：解压后即可启动，无需安装桌宠程序。Agent 状态监控需要 Node.js，DeepSeek 余额功能需要本机 DSH。
- **系统托盘**：显示或隐藏桌宠，切换角色和气泡面板。
- **屏幕边界保护**：按角色可见区域计算拖动边界，气泡不影响位置限制。

## 🚀 下载与使用

前往 [v1.5.2 发布页面](https://github.com/uoweme325/AgentPet/releases/tag/v1.5.2) 下载：

- **日常使用**：`AgentPet_v1.5.2.zip`
- **源码与测试**：`AgentPet-v1.5.2-GitHub.zip`

解压后双击 **`启动 AgentPet.bat`**。需要桌面快捷方式时，运行 **`创建桌面快捷方式.bat`**。

从旧版升级时，请先退出桌宠，备份原目录和个人配置，再解压新版文件进行覆盖。

### 使用前提

- 桌宠运行于 Windows，基于 PowerShell 和 WPF。
- Agent 工作状态监控需要可用的 **Node.js** 运行时。
- DeepSeek 余额功能需要本机运行 **DeepSeek Harness（DSH）**，并在 DSH 中完成账户或服务商配置。

## 📝 v1.5.2 更新日志

### 异步提问与权限请求提醒修复

- **Codex 异步提问跟踪**：识别 `request_user_input_async` 异步提问调用（以 `accepted: true` 为准），按调用 ID 与题目数量持续跟踪待回答状态；后续推理或工具输出不会覆盖尚未回答的问题，直至匹配到全部对应 `<send_user_message_question_reply>` 回答或达到 5 分钟等待上限。
- **权限请求识别与解除**：识别日志中的 `request_permissions` 与 `sandbox_permissions: "require_escalated"` 权限确认请求并进入 `approval`（等待主人确认权限）状态，收到对应工具返回后自动解除。
- **托盘自动显现与防误触保护**：进入等待回答（`waiting`）或等待权限（`approval`）状态时，若桌宠已隐藏到托盘，会以不抢焦点的 `SW_SHOWNOACTIVATE` 方式自动显现并临时置顶；等待期间点击角色或气泡不会切走工作提醒看板，等待结束后自动恢复原有置顶配置。
- **新增异步提问回归测试**：新增 `test/async-question.test.mjs` 覆盖异步提问接收/拒绝、跨重启恢复、超 128 KiB 远距上下文、5 分钟超时、权限请求、多会话隔离与多问题分步作答，并接入 `test/run-all.mjs` 与 `test/exit-code.test.mjs`。

[查看完整 v1.5.2 发布说明与校验文件](https://github.com/uoweme325/AgentPet/releases/tag/v1.5.2)

## ⚠️ 使用说明

- 余额看板目前仅支持人民币（CNY）。余额和额度数据仅供参考，请以官方页面为准。
- 同一服务商下的账户切换识别受 DSH 宿主提供的上下文信息限制。
- 多显示器物理热插拔与混合 DPI 场景尚需更多实机验证。若角色移出屏幕，可使用菜单中的位置复位功能。

## 📚 历史版本

### 📝 v1.5.1 更新日志
- **状态机与推断修复**：工具输出后平滑推进至 `thinking`；支持 Codex 与 Antigravity 提问工具识别与闭合过滤；在飞与等待态窗口统一放宽至 300 秒；完善多会话仲裁。
- **余额启动防误报与安全退出**：启动建立时间戳基线与 15 秒未就绪兜底；状态/额度/余额原子写入失败重试；优雅关闭与 `stop.flag` 时效校验；新增 `test/state-machine.test.mjs` 13 项回归测试。

### 📝 v1.5.0 更新日志
- **DeepSeek 余额看板**：通过本机 DSH 宿主获取人民币余额，展示总余额及充值、赠金明细；默认低于 ¥5.00 轻提醒；区分快照读取时间与余额更新时间。
- **气泡交互**：支持在 Codex 额度、DeepSeek 余额和随机台词看板之间切换；工作期间临时查看默认看板。
- **拖动边界与其他修复**：按角色可见区域计算拖动边界；完善多显示器工作区处理；源码包统一使用正斜杠目录路径并加入测试套件。

### 📝 v1.4.2 更新日志
- **桌面快捷方式与 Claude 娘图标优化**：修复快捷方式参数转义；新增专属 Claude 娘高清桌面图标（`assets/claude-pet.ico`）；同步 384×384 欢喜形态立绘至预览图。

### 📝 v1.4.1 更新日志
- **小型视觉与拖动修正**：托盘图标按透明像素裁切；桌宠拖动边界计算改进；支持负坐标副屏与混合 DPI。

### 📝 v1.4.0 更新日志
- **托盘体验优化**：托盘图标随桌宠形象切换；菜单动态显示状态与面板偏好；支持原生窗口隐藏。

## 🛠️ 开发与测试

<details>
<summary>展开测试方法</summary>

测试套件包含在源码包中。进入项目根目录后执行：

```bash
node test/run-all.mjs
```

单独运行状态机综合测试：

```bash
node test/state-machine.test.mjs
```

运行退出码故障回归：

```bash
node test/exit-code.test.mjs
```

运行包不包含 `test/` 目录；需要复验时请使用源码包。

</details>

## 📜 协议与鸣谢

- 项目代码基于 [MIT License](LICENSE) 开源。
- 第三方项目、素材归属和参考来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 角色形象为社区 AI 萌化同人设计；美术与音频素材仅供个人学习与交流使用，请遵守相关素材的使用要求。
