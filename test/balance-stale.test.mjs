// test/balance-stale.test.mjs —— 独立进程单测（自隔离日志，覆盖 WO-22 与 AP04）
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
  const { dispatchRuntimeWrite } = await import('../runtime/agent-monitor.mjs');

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

  // =========================================================================
  // AP04：禁用余额后停止重复写入、消费手动刷新标记、拦截旧在途请求
  // =========================================================================
  {
    const ap04Dir = path.join(tmp, 'ap04');
    fs.mkdirSync(ap04Dir, { recursive: true });
    const balFile = path.join(ap04Dir, 'runtime-balance.json');
    const flagFile = path.join(ap04Dir, 'refresh-balance.flag');

    let diskWrites = 0;
    let hostProbes = 0;
    let enabledCfg = false;
    const baseNow = Date.now();
    const origDateNow = Date.now;
    let simNow = baseNow;

    const m2 = new AgentMonitor({
      isProbe: true,
      onChange: (data) => {
        if (data.type === 'balance') {
          if (dispatchRuntimeWrite(ap04Dir, data)) diskWrites++;
        }
      }
    });
    m2.paths = {
      ...m2.paths,
      appDir: ap04Dir,
      balanceFile: balFile,
      refreshBalanceFlag: flagFile,
      refreshFlag: path.join(ap04Dir, 'refresh-quota.flag')
    };
    m2.readPetConfig = () => ({ DeepSeekBalanceEnabled: enabledCfg, DshPort: 0, DshBaseUrl: '' });
    m2.findActiveDshBaseUrl = async () => {
      hostProbes++;
      return null;
    };

    try {
      Date.now = () => simNow;

      // (1) 禁用状态下启动 + 连续 20 次 500ms 扫描 + 模拟经过 6 分钟：仅写入 1 次 dsh_disabled
      await m2.pollBalance(true);
      assert.equal(diskWrites, 1, '禁用启动应写入 1 次停用快照');
      assert.equal(JSON.parse(fs.readFileSync(balFile, 'utf8')).status, 'dsh_disabled');
      const mtimeAfterInit = fs.statSync(balFile).mtimeMs;

      for (let i = 0; i < 20; i++) {
        simNow += 500;
        m2.checkBalanceTrigger();
      }
      assert.equal(diskWrites, 1, '连续 20 次 500ms 扫描不得产生新增自动余额写入');
      assert.equal(fs.statSync(balFile).mtimeMs, mtimeAfterInit, '余额文件修改时间应保持不变');

      simNow += 6 * 60_000;
      m2.checkBalanceTrigger();
      assert.equal(diskWrites, 1, '经过 6 分钟后仍无重复自动写入');
      assert.equal(hostProbes, 0, '禁用期间不得探测宿主或发起请求');

      // (2) 禁用期间手动刷新一次：标记被消费，至多回写 1 次停用结果，随后保持稳定
      fs.writeFileSync(flagFile, String(simNow), 'utf8');
      const mtimeBeforeManual = simNow + 1000;
      fs.utimesSync(flagFile, mtimeBeforeManual / 1000, mtimeBeforeManual / 1000);
      simNow += 500;
      m2.checkBalanceTrigger();
      assert.equal(fs.existsSync(flagFile), false, '手动刷新标记必须被消费删除');
      assert.equal(diskWrites, 2, '禁用期间手动刷新一次至多回写 1 次停用结果');
      for (let i = 0; i < 5; i++) {
        simNow += 500;
        m2.checkBalanceTrigger();
      }
      assert.equal(diskWrites, 2, '手动刷新后继续扫描不得重复写入');
      assert.equal(hostProbes, 0, '禁用期间手动刷新也不得探测宿主');

      // (3) 重新启用立即查询；在途请求尚未返回时切换为禁用（且同时带刷新标记），旧请求迟到不得覆盖
      let resolveInFlight;
      m2.findActiveDshBaseUrl = () => {
        hostProbes++;
        return new Promise((res) => { resolveInFlight = res; });
      };
      enabledCfg = true;
      simNow += 15_000;
      m2.checkBalanceTrigger();
      assert.equal(hostProbes, 1, '重新启用后应立即发起查询');
      assert.equal(JSON.parse(fs.readFileSync(balFile, 'utf8')).status, 'loading', '重新启用先发布 loading');
      const writesAfterEnable = diskWrites;

      // 在途请求未返回时，同时写入刷新标记并将配置切换为禁用
      fs.writeFileSync(flagFile, String(simNow + 2000), 'utf8');
      fs.utimesSync(flagFile, (simNow + 2000) / 1000, (simNow + 2000) / 1000);
      enabledCfg = false;
      simNow += 500;
      m2.checkBalanceTrigger();
      assert.equal(fs.existsSync(flagFile), false, '配置切换与手动刷新同时发生时，刷新标记也必须被消费不残留');
      assert.equal(JSON.parse(fs.readFileSync(balFile, 'utf8')).status, 'dsh_disabled', '切换为禁用后应发布停用结果');
      const writesAfterDisable = diskWrites;
      assert.equal(writesAfterDisable, writesAfterEnable + 1, '启用切禁用只发布一次 dsh_disabled（不額外写 loading）');

      // 让关闭前的旧在途请求迟到返回
      resolveInFlight(null);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(JSON.parse(fs.readFileSync(balFile, 'utf8')).status, 'dsh_disabled', '关闭前的迟到结果绝不能覆盖禁用状态');
      assert.equal(diskWrites, writesAfterDisable, '迟到旧请求不得触发任何写盘');

      // 再次扫描确认无残留标记触发额外写入
      simNow += 500;
      m2.checkBalanceTrigger();
      assert.equal(diskWrites, writesAfterDisable, '后续扫描保持稳定');
    } finally {
      Date.now = origDateNow;
    }
  }

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
