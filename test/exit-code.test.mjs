// test/exit-code.test.mjs —— 故障注入与退出码回归测试（交付件，覆盖 CLOSE-03 §2）
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const nodeExe = process.execPath;

console.log('=== Running Exit Code & Failure Cleanup Regression ===\n');

// 辅助函数：在 test 目录下写入临时注入脚本并验证退出码与输出
function runInjectedScenario({ label, baseFile, targetPattern, replacePattern, expectedStatus, expectStderr, forbidStdout }) {
  console.log(`>> [SCENARIO] ${label}`);
  const baseSrc = fs.readFileSync(path.join(testDir, baseFile), 'utf8');

  let modifiedSrc = baseSrc;
  if (targetPattern) {
    if (!baseSrc.includes(targetPattern)) {
      throw new Error(`[FAULT INJECTION ERROR] Target pattern not found in ${baseFile}: ${targetPattern}`);
    }
    modifiedSrc = baseSrc.replace(targetPattern, replacePattern);
  }

  // 写入 testDir 下临时测试文件，确保相对路径 ../runtime 结构一致
  const tmpScript = path.join(testDir, `.inject-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmpScript, modifiedSrc, 'utf8');

  let res = null;
  try {
    // 先 node --check 确保注入后的代码语法有效（排除语法错误导致的非零退出）
    const checkRes = spawnSync(nodeExe, ['--check', tmpScript], { encoding: 'utf8' });
    if (checkRes.status !== 0) {
      throw new Error(`[SYNTAX CHECK FAILED] Injected script syntax is invalid: ${checkRes.stderr}`);
    }

    // 运行故障子进程，限时 5000ms，捕获输出
    res = spawnSync(nodeExe, [tmpScript], {
      encoding: 'utf8',
      timeout: 5000
    });
  } finally {
    try { if (fs.existsSync(tmpScript)) fs.unlinkSync(tmpScript); } catch {}
  }

  console.log(`   Exit Code: ${res.status} (expected: ${expectedStatus})`);
  if (res.stdout) console.log(`   Stdout: ${res.stdout.trim().split('\n')[0]}`);
  if (res.stderr) console.log(`   Stderr: ${res.stderr.trim().split('\n')[0]}`);

  // 断言退出码
  if (expectedStatus === 0) {
    assert.equal(res.status, 0, `Scenario '${label}' should exit with 0`);
  } else {
    assert.notEqual(res.status, 0, `Scenario '${label}' should exit with non-zero (got ${res.status})`);
  }

  // 断言 stderr
  if (expectStderr) {
    assert.ok(res.stderr && res.stderr.includes(expectStderr), `Scenario '${label}' stderr must contain '${expectStderr}'`);
  }

  // 断言禁止 stdout 出现成功字样
  if (forbidStdout) {
    assert.ok(!res.stdout.includes(forbidStdout), `Scenario '${label}' stdout must NOT contain '${forbidStdout}'`);
  }

  console.log(`   [PASS] ${label}\n`);
}

// 场景 1: 两个测试原样运行 → exit 0, 有成功输出
runInjectedScenario({
  label: '1. balance-stale.test.mjs 原样运行',
  baseFile: 'balance-stale.test.mjs',
  expectedStatus: 0,
  forbidStdout: 'FAILURE'
});

runInjectedScenario({
  label: '1. port-cache.test.mjs 原样运行',
  baseFile: 'port-cache.test.mjs',
  expectedStatus: 0,
  forbidStdout: 'FAILURE'
});

// 场景 2: 端口第一组断言失败（第二组未创建）
runInjectedScenario({
  label: '2. 端口第一组断言失败（第二组未创建）',
  baseFile: 'port-cache.test.mjs',
  targetPattern: "assert.notStrictEqual(urlInvalid, `http://127.0.0.1:${portInvalid}`",
  replacePattern: "assert.strictEqual(urlInvalid, `http://127.0.0.1:${portInvalid}`",
  expectedStatus: 1,
  expectStderr: '[port-cache.test.mjs FAILURE]',
  forbidStdout: 'All assertions passed'
});

// 场景 3: 端口第二组断言失败
runInjectedScenario({
  label: '3. 端口第二组断言失败',
  baseFile: 'port-cache.test.mjs',
  targetPattern: "assert.strictEqual(urlValid, `http://127.0.0.1:${portValid}`",
  replacePattern: "assert.notStrictEqual(urlValid, `http://127.0.0.1:${portValid}`",
  expectedStatus: 1,
  expectStderr: '[port-cache.test.mjs FAILURE]',
  forbidStdout: 'All assertions passed'
});

// 场景 4: 余额断言失败
runInjectedScenario({
  label: '4. 余额断言失败',
  baseFile: 'balance-stale.test.mjs',
  targetPattern: "assert.equal(m.cachedBalanceData.status, 'stale'",
  replacePattern: "assert.equal(m.cachedBalanceData.status, 'INVALID_STATUS'",
  expectedStatus: 1,
  expectStderr: '[balance-stale.test.mjs FAILURE]',
  forbidStdout: 'All assertions passed'
});

// 场景 5: 动态 import 之前抛错对照组
runInjectedScenario({
  label: '5. 动态 import 之前抛错对照组',
  baseFile: 'balance-stale.test.mjs',
  targetPattern: "const { AgentMonitor } = await import",
  replacePattern: "throw new Error('PRE_IMPORT_CONTROL_ERROR'); const { AgentMonitor } = await import",
  expectedStatus: 1,
  expectStderr: 'PRE_IMPORT_CONTROL_ERROR',
  forbidStdout: 'All assertions passed'
});

console.log('=== ALL 5 EXIT-CODE REGRESSION SCENARIOS VERIFIED SUCCESSFULLY ===');
