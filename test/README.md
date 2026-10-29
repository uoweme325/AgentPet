# AgentPet 自动化测试套件

本目录包含 AgentPet 运行时的单元测试、故障退出码回归套件及统一执行入口。

## 文件结构
- `run-all.mjs`：统一测试执行入口，依次拉起各项单元测试并汇总结算退出码。
- `balance-stale.test.mjs`：WO-22 余额过期判定与自动刷新调度单测。
- `port-cache.test.mjs`：WO-23 端口缓存合法性校验与全路径清理单测。
- `exit-code.test.mjs`：CLOSE-03 故障注入与退出码/清理回归套件（覆盖 5 种场景）。

## 运行准则
- **自隔离执行**：所有测试脚本均在内部动态注入 `--log-file` 并使用系统临时目录，测试过程中的日志随临时目录彻底销毁，绝不污染生产环境日志与状态。
- **全路径清理与非零退出**：测试脚本具备顶层错误捕获机制，发生断言失败时显式设置 `process.exitCode = 1`，向 stderr 输出失败堆栈，并在 `finally` 块中安全释放网络端口与清理临时资源。

## 执行方法
在项目根目录下直接运行：
```bash
# 1. 统一运行全部测试
node test/run-all.mjs

# 2. 单独运行指定测试
node test/balance-stale.test.mjs
node test/port-cache.test.mjs

# 3. 运行故障注入与退出码回归套件
node test/exit-code.test.mjs
```
