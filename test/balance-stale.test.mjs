// test/balance-stale.test.mjs —— 独立进程单测（自隔离日志，覆盖 WO-22）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 1. 在导入 agent-monitor 前创建临时目录并指定独立日志路径
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpet-bal-'));
const tmpLog = path.join(tmp, 'test.log');

// 在首次模块求值前通过 argv 注入 --log-file 参数，实现自隔离，禁止污染生产日志
if (!process.argv.includes('--log-file')) {
  process.argv.push('--log-file', tmpLog);
}

try {
  // 2. 动态导入，确保模块入口读取到 argv 中的 --log-file
  const { AgentMonitor } = await import('../runtime/agent-monitor.mjs');

  const seen = [];
  let polled = false;
  const m = new AgentMonitor({ onChange: (d) => { seen.push(d.status); }, isProbe: true });

  // 3. 隔离所有状态文件路径至临时目录
  m.paths = {
    ...m.paths,
    appDir: tmp,
    balanceFile: path.join(tmp, 'runtime-balance.json'),
    refreshBalanceFlag: path.join(tmp, 'refresh-balance.flag'),
    refreshFlag: path.join(tmp, 'refresh-quota.flag')
  };

  // 打桩配置读取，不访问正式配置
  m.readPetConfig = () => ({ DeepSeekBalanceEnabled: true, DshPort: 0, DshBaseUrl: '' });

  // lastConfigSig 保持 undefined，由首次调用自然初始化

  // 断言 A：fetchedAt 超期 11 分钟 → 只打 stale 标记、不触发刷新（周期未到）
  m.cachedBalanceData = { type: 'balance', status: 'ok', fetchedAt: Date.now() - 11 * 60_000, hostCounter: 1793221756037, balances: [] };
  m.lastBalanceAt = Date.now();
  m.pollBalance = () => { polled = true; };
  m.checkBalanceTrigger();
  assert.equal(m.cachedBalanceData.status, 'stale', '应标记 stale');
  assert.ok(seen.includes('stale'), '应通知一次 onChange(stale)');
  assert.equal(polled, false, '周期未到，不应触发刷新');

  // 断言 B：lastBalanceAt 超过 5 分钟周期 → 触发刷新
  m.cachedBalanceData = { type: 'balance', status: 'ok', fetchedAt: Date.now(), hostCounter: 1, balances: [] };
  m.lastBalanceAt = Date.now() - 6 * 60_000;
  polled = false;
  m.checkBalanceTrigger();
  assert.equal(polled, true, '周期到了应触发刷新');

  console.log('balance-stale.test.mjs: All assertions passed.');
} catch (err) {
  process.exitCode = 1;
  console.error('[balance-stale.test.mjs FAILURE]:', err.message || err);
  if (err.stack) console.error(err.stack);
} finally {
  // 无论成功还是断言失败，彻底清理临时目录
  try {
    if (fs.existsSync(tmp)) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (cleanErr) {
    process.exitCode = 1;
    console.error('[balance-stale.test.mjs CLEANUP ERROR]:', cleanErr.message || cleanErr);
  }
}
