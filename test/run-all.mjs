// test/run-all.mjs —— 统一测试入口，基于自身路径相对解析
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const tests = [
  path.join(testDir, 'balance-stale.test.mjs'),
  path.join(testDir, 'port-cache.test.mjs')
];

console.log('=== Running AgentPet Test Suite ===');
let hasFailure = false;

for (const testFile of tests) {
  const relName = path.relative(path.join(testDir, '..'), testFile);
  console.log(`\n>> [RUN] ${relName}`);

  const res = spawnSync(process.execPath, [testFile], {
    stdio: 'inherit',
    timeout: 10000
  });

  if (res.error) {
    console.error(`>> [ERROR] ${relName} execution failed:`, res.error.message);
    hasFailure = true;
  } else if (res.signal) {
    console.error(`>> [KILLED] ${relName} terminated with signal:`, res.signal);
    hasFailure = true;
  } else if (res.status !== 0) {
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
