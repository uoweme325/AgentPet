# AgentPet 自动化测试套件

本目录包含 AgentPet 运行时的单元测试、状态机与退出链路回归矩阵、故障退出码回归套件及统一执行入口。

## 文件结构
- `run-all.mjs`：统一测试执行入口，依次拉起全部单元测试与退出码回归套件并汇总结算退出码。
- `balance-stale.test.mjs`：WO-22 余额过期判定与自动刷新调度单测。
- `port-cache.test.mjs`：WO-23 端口缓存合法性校验与全路径清理单测。
- `state-machine.test.mjs`：WO-30 ~ WO-37 状态机、工具接续、提问识别、冷启动长窗口、跨会话仲裁、启动余额隔离、写入重试与退出脚本 13 项回归矩阵。
- `exit-code.test.mjs`：CLOSE-03 故障注入与退出码/清理回归套件（使用 `os.tmpdir()` 隔离注入，覆盖全部测试文件的正常与断言失败非零退出场景）。

## 运行准则
- **自隔离执行**：所有测试脚本（含 `exit-code.test.mjs` 故障注入生成脚本）均在内部动态注入 `--log-file` 并完全使用系统临时目录（`os.tmpdir()`），绝不向仓库目录写入临时文件，亦不污染生产环境日志与状态。
- **全路径清理与非零退出**：测试脚本具备顶层错误捕获机制，发生断言失败或清理异常时显式设置 `process.exitCode = 1`，向 stderr 输出失败堆栈，并在 `finally` 块中安全释放网络端口与清理临时资源。

## 执行方法
在项目根目录下直接运行：
```bash
# 1. 统一运行全部测试（含单元测试、状态机回归与退出码故障回归）
node test/run-all.mjs

# 2. 单独运行指定测试
node test/balance-stale.test.mjs
node test/port-cache.test.mjs
node test/state-machine.test.mjs
node test/exit-code.test.mjs
```
