// test/run-all.mjs —— 统一测试入口，基于自身路径相对解析
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const tests = [
  path.join(testDir, 'balance-stale.test.mjs'),
  path.join(testDir, 'port-cache.test.mjs'),
  path.join(testDir, 'state-machine.test.mjs'),
  path.join(testDir, 'dsh-approval.test.mjs'),
  path.join(testDir, 'async-question.test.mjs'),
  path.join(testDir, 'hover-detail.test.mjs'),
  path.join(testDir, 'ui-layout-detail.test.mjs'),
  path.join(testDir, 'task-complete-sound.test.mjs'),
  path.join(testDir, 'exit-code.test.mjs')
];

// Windows suites can launch several PowerShell/Node children sequentially.
const suiteTimeoutsMs = {
  'state-machine.test.mjs': 150_000,
  'ui-layout-detail.test.mjs': 90_000,
  'exit-code.test.mjs': 720_000
};

console.log('=== Running AgentPet Test Suite ===');
let hasFailure = false;

for (const testFile of tests) {
  const relName = path.relative(path.join(testDir, '..'), testFile);
  console.log(`\n>> [RUN] ${relName}`);

  const timeout = suiteTimeoutsMs[path.basename(testFile)] ?? 60_000;
  const res = spawnSync(process.execPath, [testFile], {
    stdio: 'inherit',
    timeout
  });

  if (res.error?.code === 'ETIMEDOUT') {
    console.error(`>> [TIMEOUT] ${relName} exceeded ${timeout}ms`);
    hasFailure = true;
  } else if (res.error) {
    console.error(`>> [ERROR] ${relName} execution failed:`, res.error.message);
    hasFailure = true;
  } else if (res.signal) {
    console.error(`>> [KILLED] ${relName} terminated with signal:`, res.signal);
    hasFailure = true;
  } else if (res.status === null || res.status !== 0) {
    console.error(`>> [FAILED] ${relName} exited with code:`, res.status);
    hasFailure = true;
  } else {
    console.log(`>> [PASSED] ${relName}`);
  }
}

if (hasFailure) {
  console.error('\n=== TEST SUITE FAILED ===');
  process.exitCode = 1;
} else {
  console.log('\n=== ALL TESTS PASSED SUCCESSFULLY ===');
}
