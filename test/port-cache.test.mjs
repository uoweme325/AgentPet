// test/port-cache.test.mjs —— 独立进程单测（全路径清理与自隔离，覆盖 WO-23）
import http from 'node:http';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 1. 初始化外层资源引用与自隔离日志路径
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpet-port-'));
const tmpLog = path.join(tmp, 'test.log');

if (!process.argv.includes('--log-file')) {
  process.argv.push('--log-file', tmpLog);
}

let srvInvalid = null;
let srvValid = null;

const safeClose = async (srv) => {
  if (!srv) return;
  try {
    if (srv.listening) {
      await new Promise(r => srv.close(r));
    } else {
      srv.close();
    }
  } catch {}
};

try {
  // 2. 动态导入，确保 argv 中的 --log-file 生效
  const { AgentMonitor } = await import('../runtime/agent-monitor.mjs');

  const m = new AgentMonitor({ onChange: () => {}, isProbe: true });
  m.paths = {
    ...m.paths,
    appDir: tmp,
    balanceFile: path.join(tmp, 'runtime-balance.json'),
    refreshBalanceFlag: path.join(tmp, 'refresh-balance.flag'),
    refreshFlag: path.join(tmp, 'refresh-quota.flag')
  };

  // 3. 假服务 1：返回 200 但缺 sections.balance
  srvInvalid = http.createServer((q, s) => {
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end('{"ok":true}');
  });

  await new Promise(r => srvInvalid.listen(0, '127.0.0.1', r));
  const portInvalid = srvInvalid.address().port;

  m.cachedDshPort = portInvalid; // 落缓存测试校验分支

  const urlInvalid = await m.findActiveDshBaseUrl(
    { DshPort: 0, DshBaseUrl: '' },
    Date.now() + 5000
  );
  assert.notStrictEqual(urlInvalid, `http://127.0.0.1:${portInvalid}`, '缺 sections.balance 的端口不应被采纳');

  // 关闭第一组服务
  await safeClose(srvInvalid);
  srvInvalid = null;

  // 4. 假服务 2（对照组）：返回合法 sections.balance 结构
  srvValid = http.createServer((q, s) => {
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end('{"sections":{"balance":{"data":{"ok":true}}}}');
  });

  await new Promise(r => srvValid.listen(0, '127.0.0.1', r));
  const portValid = srvValid.address().port;

  m.cachedDshPort = portValid;

  const urlValid = await m.findActiveDshBaseUrl(
    { DshPort: 0, DshBaseUrl: '' },
    Date.now() + 5000
  );
  assert.strictEqual(urlValid, `http://127.0.0.1:${portValid}`, '含 sections.balance 的端口应被采纳');

  console.log('port-cache.test.mjs: All assertions passed.');
} catch (err) {
  process.exitCode = 1;
  console.error('[port-cache.test.mjs FAILURE]:', err.message || err);
  if (err.stack) console.error(err.stack);
} finally {
  // 全路径兜底清理：安全关闭服务并清理临时目录
  try {
    await safeClose(srvInvalid);
    await safeClose(srvValid);
  } catch (srvErr) {
    process.exitCode = 1;
    console.error('[port-cache.test.mjs SERVER CLOSE ERROR]:', srvErr.message || srvErr);
  }
  try {
    if (fs.existsSync(tmp)) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (cleanErr) {
    process.exitCode = 1;
    console.error('[port-cache.test.mjs CLEANUP ERROR]:', cleanErr.message || cleanErr);
  }
}
