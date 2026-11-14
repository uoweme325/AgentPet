import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const testLogRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpet-hover-log-'));
if (!process.argv.includes('--log-file')) {
  process.argv.push('--log-file', path.join(testLogRoot, 'monitor.log'));
}

const {
  AgentMonitor,
  finalizeTaskDetail,
  redactDetailSecrets,
  DETAIL_MAX_CODE_POINTS,
  DETAIL_TRUNCATE_SUFFIX
} = await import('../runtime/agent-monitor.mjs');

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {}

function hasUnpairedSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function makeTempWorkspace(prefix = 'agentpet-hover-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const paths = {
    antigravity: path.join(root, 'ag-brain'),
    antigravityDb: path.join(root, 'ag-db'),
    codex: path.join(root, 'codex-home'),
    dshDirs: [path.join(root, 'dsh-sessions')]
  };
  fs.mkdirSync(paths.antigravity, { recursive: true });
  fs.mkdirSync(paths.antigravityDb, { recursive: true });
  fs.mkdirSync(path.join(paths.codex, 'sessions'), { recursive: true });
  fs.mkdirSync(paths.dshDirs[0], { recursive: true });
  return { root, paths };
}

function createMonitor(paths, events) {
  const m = new AgentMonitor({
    isProbe: true,
    onChange: (ev) => events.push(ev)
  });
  m.paths.antigravity = paths.antigravity;
  m.paths.antigravityDb = paths.antigravityDb;
  m.paths.codex = paths.codex;
  m.paths.dshDirs = paths.dshDirs;
  m.pollQuota = () => {};
  return m;
}

try {
// 1. 700 Unicode code-point truncation & surrogate-pair emoji safety
{
  const suffixCps = Array.from(DETAIL_TRUNCATE_SUFFIX);
  assert.equal(DETAIL_MAX_CODE_POINTS, 700, 'DETAIL_MAX_CODE_POINTS must be 700');
  assert.equal(suffixCps.length, 6, 'Suffix …（已节选） must be 6 Unicode code points');

  const s699 = '中'.repeat(698) + '🧩';
  assert.equal(Array.from(s699).length, 699);
  assert.equal(finalizeTaskDetail(s699), s699, '699 code points preserved verbatim');

  const s700 = 'a'.repeat(699) + '🚀';
  assert.equal(Array.from(s700).length, 700);
  assert.equal(finalizeTaskDetail(s700), s700, '700 code points preserved verbatim');

  const s701 = '字'.repeat(693) + '🧩' + 'B'.repeat(7);
  assert.equal(Array.from(s701).length, 701);
  const out701 = finalizeTaskDetail(s701);
  assert.equal(Array.from(out701).length, 700, '701 code points capped at exactly 700 code points');
  assert.ok(out701.endsWith(DETAIL_TRUNCATE_SUFFIX), 'Capped detail ends with suffix');
  assert.equal(hasUnpairedSurrogate(out701), false, 'Emoji at boundary must not leave unpaired surrogate');

  const emojiKeptEdge = 'x'.repeat(693) + '🧩'.repeat(8);
  const outKeptEdge = finalizeTaskDetail(emojiKeptEdge);
  assert.equal(Array.from(outKeptEdge).length, 700);
  assert.ok(outKeptEdge.endsWith(DETAIL_TRUNCATE_SUFFIX));
  assert.ok(outKeptEdge.includes('🧩'), 'Emoji at index 693 stays intact before suffix');
  assert.equal(hasUnpairedSurrogate(outKeptEdge), false, 'Emoji right before suffix stays intact');

  const emojiSplitEdge = 'x'.repeat(694) + '🧩'.repeat(7);
  const outEdge = finalizeTaskDetail(emojiSplitEdge);
  assert.equal(Array.from(outEdge).length, 700);
  assert.ok(outEdge.endsWith(DETAIL_TRUNCATE_SUFFIX));
  assert.equal(hasUnpairedSurrogate(outEdge), false, 'Emoji right at cut index 694 stays intact');
  console.log('[PASS] Scenario 1: 699/700/701 Unicode code points & emoji boundary');
}

// 2. Redaction variants & secret crossing code point 700
{
  const rawSecrets = [
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc',
    'header2: bearer "quoted_bearer_token_99"',
    'openai=sk-proj-SecretKeyValue123456',
    'claude="sk-ant-api03-SecretValue99999"',
    'vcs=ghp_AbCdEfGh12345678 github_pat_12345678_xyz glpat-AbCd123456',
    'DEEPSEEK_API_KEY="ds_live_secret_123"',
    "api_key: 'single_quoted_api_9'",
    'cli --api-key myFlagSecret --token=eqFlagSecret --password "pw space 1"',
    'endpoint=https://alice:hunter2@api.internal.local/v1/chat'
  ].join(' | ');

  const redacted = redactDetailSecrets(rawSecrets);
  assert.ok(!redacted.includes('eyJhbGciOi'));
  assert.ok(!redacted.includes('quoted_bearer_token_99'));
  assert.ok(!redacted.includes('SecretKeyValue123456'));
  assert.ok(!redacted.includes('SecretValue99999'));
  assert.ok(!redacted.includes('ghp_AbCdEfGh12345678'));
  assert.ok(!redacted.includes('github_pat_12345678'));
  assert.ok(!redacted.includes('glpat-AbCd123456'));
  assert.ok(!redacted.includes('ds_live_secret_123'));
  assert.ok(!redacted.includes('single_quoted_api_9'));
  assert.ok(!redacted.includes('myFlagSecret'));
  assert.ok(!redacted.includes('eqFlagSecret'));
  assert.ok(!redacted.includes('pw space 1'));
  assert.ok(!redacted.includes('hunter2'));
  assert.ok(redacted.includes('https://[REDACTED]@api.internal.local'));
  assert.ok(redacted.includes('DEEPSEEK_API_KEY="[REDACTED]"'));

  // Secret crossing code-point 694/700 boundary: if truncated first, only 7 suffix chars remain and regex would miss it
  const crossPrefix = '前缀'.repeat(339); // 678 chars
  const crossText = `${crossPrefix} sk-ant-123456_CROSSING_700 ${'z'.repeat(20)}`;
  const finalizedCross = finalizeTaskDetail(crossText);
  assert.equal(Array.from(finalizedCross).length, 700);
  assert.ok(!finalizedCross.includes('CROSSING_700'), 'Secret crossing index 700 must be redacted before truncation');
  assert.ok(!finalizedCross.includes('123456'), 'Partial secret prefix before cut boundary must not survive');
  assert.ok(finalizedCross.includes('sk-[REDACTED]'), 'Redacted marker must remain intact');
  console.log('[PASS] Scenario 2: Credential redaction variants & 700-cp boundary');
}

// 3. All 4 sources extraction + allowed-field boundaries (no SYSTEM_MESSAGE or unknown JSON dump)
{
  const { root, paths } = makeTempWorkspace('agentpet-hover-sources-');
  try {
    const events = [];
    const monitor = createMonitor(paths, events);

    // 3a. Antigravity Transcript: USER_INPUT vs SYSTEM_MESSAGE vs openToolCalls vs ERROR_MESSAGE
    const convDir = path.join(paths.antigravity, 'conv-alpha', '.system_generated', 'logs');
    fs.mkdirSync(convDir, { recursive: true });
    const txFile = path.join(convDir, 'transcript.jsonl');

    const agBase = Date.now() - 8000;

    // SYSTEM_MESSAGE must NOT leak system instructions into taskDetail
    fs.writeFileSync(txFile, JSON.stringify({
      type: 'SYSTEM_MESSAGE',
      content: 'TOP SECRET SYSTEM INSTRUCTION BLOCK SHOULD NEVER APPEAR IN DETAIL'
    }) + '\n');
    fs.utimesSync(txFile, new Date(agBase), new Date(agBase));
    monitor.lastAgTranscriptScan = 0;
    monitor.scan();
    assert.equal(events.at(-1).source, 'Antigravity');
    assert.equal(events.at(-1).taskDetail, null, 'SYSTEM_MESSAGE must yield taskDetail: null');

    // USER_INPUT extracts full content & redacts
    fs.writeFileSync(txFile, JSON.stringify({
      type: 'USER_INPUT',
      content: '请帮我排查 D:\\AgentPet\\AgentPet.ps1 的崩溃问题，token=super_secret_abc'
    }) + '\n');
    const nowPlus = new Date(agBase + 2000);
    fs.utimesSync(txFile, nowPlus, nowPlus);
    monitor.lastAgTranscriptScan = 0;
    monitor.scan();
    assert.ok(events.at(-1).taskDetail.includes('D:\\AgentPet\\AgentPet.ps1'));
    assert.ok(!events.at(-1).taskDetail.includes('super_secret_abc'));
    assert.ok(events.at(-1).taskDetail.includes('token=[REDACTED]'));

    // PLANNER_RESPONSE open tool call (allowed fields only)
    fs.writeFileSync(txFile, JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{
        id: 'tc-1',
        name: 'run_command',
        args: {
          toolSummary: 'Run test suite',
          CommandLine: 'powershell -Command "Write-Host DEEPSEEK_API_KEY=ds_xyz123"'
        }
      }]
    }) + '\n');
    fs.utimesSync(txFile, new Date(agBase + 4000), new Date(agBase + 4000));
    monitor.lastAgTranscriptScan = 0;
    monitor.scan();
    assert.ok(events.at(-1).taskDetail.includes('Run test suite'));
    assert.ok(!events.at(-1).taskDetail.includes('ds_xyz123'));

    // Reset AG transcript to clean out before testing DB/DSH/Codex independently
    fs.rmSync(paths.antigravity, { recursive: true, force: true });
    fs.mkdirSync(paths.antigravity, { recursive: true });
    monitor.antigravityTranscriptCandidates = [];
    monitor.antigravityTranscriptCache.clear();

    // 3b. Antigravity DB (when DatabaseSync available)
    if (DatabaseSync) {
      const dbPath = path.join(paths.antigravityDb, 'conv-db-1.db');
      const dbBase = Date.now() - 4000;
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata TEXT)');
      const longCmd = 'powershell -NoProfile -Command "Get-Content D:\\AgentPet\\very-long-subpath\\details.log -Tail 50"';
      db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(
        1, 132, 1, JSON.stringify({ CommandLine: longCmd, Cwd: 'D:\\AgentPet', Path: 'D:\\AgentPet\\details.log' })
      );
      db.close();
      fs.utimesSync(dbPath, new Date(dbBase), new Date(dbBase));
      monitor.lastAgDbScan = 0;
      const dbState = monitor.checkAntigravityDb(dbBase + 500);
      assert.equal(dbState.rawId, 'conv-db-1.db');
      assert.ok(dbState.taskDetail.includes(longCmd), 'AG DB must include full un-sliced CommandLine');
      assert.ok(dbState.taskDetail.includes('D:\\AgentPet'), 'AG DB includes Cwd');

      // step_type 15 in-flight passes through refreshDynamicState (state='working', task='正在深度思考与规划…') -> null detail
      const db2 = new DatabaseSync(dbPath);
      db2.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(2, 15, 1, '{}');
      db2.close();
      const t2 = new Date(dbBase + 2000);
      fs.utimesSync(dbPath, t2, t2);
      monitor.lastAgDbScan = 0;
      const dbThinking = monitor.checkAntigravityDb(dbBase + 2500);
      assert.equal(dbThinking.state, 'working');
      assert.equal(dbThinking.task, '正在深度思考与规划…');
      assert.equal(dbThinking.taskDetail, null, 'AG DB step_type 15 must have taskDetail: null');

      fs.rmSync(dbPath, { force: true });
      monitor.antigravityDbCandidates = [];
      monitor.antigravityDbCache.clear();
    }

    // 3c. DSH: allowed fields vs bare call_xxx ID
    const dshBase = Date.now() - 4000;
    const dshRawOnly = path.join(paths.dshDirs[0], 'session-rawcall.json');
    fs.writeFileSync(dshRawOnly, JSON.stringify({
      record: { rows: { sessionStats: { val: { pendingCalls: { call_abc123: { at: dshBase } } } } } }
    }));
    fs.utimesSync(dshRawOnly, new Date(dshBase), new Date(dshBase));
    monitor.lastDshSessionScan = 0;
    const dshRawState = monitor.checkDsh(dshBase + 500);
    assert.equal(dshRawState.source, 'DSH');
    assert.equal(dshRawState.taskDetail, null, 'DSH with only raw call_ ID must return taskDetail: null');

    const dshRich = path.join(paths.dshDirs[0], 'session-rich.json');
    fs.writeFileSync(dshRich, JSON.stringify({
      record: {
        rows: {
          title: { val: '重构悬浮卡片组件' },
          todos: { val: [{ status: 'in_progress', content: '补充完整单元测试与截图验收' }] },
          userQuestions: { val: { questions: { active: [{ question: '确认是否默认关闭悬停详情？' }] } } }
        }
      }
    }));
    const tf2 = new Date(dshBase + 2000);
    fs.utimesSync(dshRich, tf2, tf2);
    monitor.lastDshSessionScan = 0;
    const dshRichState = monitor.checkDsh(dshBase + 2500);
    assert.equal(dshRichState.state, 'waiting');
    assert.equal(dshRichState.rawId, 'session-rich.json');
    assert.ok(dshRichState.taskDetail.includes('确认是否默认关闭悬停详情？'));
    assert.ok(dshRichState.taskDetail.includes('补充完整单元测试与截图验收'));

    // Clean DSH
    fs.rmSync(paths.dshDirs[0], { recursive: true, force: true });
    fs.mkdirSync(paths.dshDirs[0], { recursive: true });
    monitor.dshSessionCandidates = [];
    monitor.dshStateCache.clear();

    // 3d. Codex: unknown JSON payload vs allowed keys + APPROVAL REQUEST + async questions + top-level rawId
    const codexBase = Date.now() - 10000;
    const codexDir = path.join(paths.codex, 'sessions', '2026', '11', '13');
    fs.mkdirSync(codexDir, { recursive: true });
    const rolloutUnknown = path.join(codexDir, 'rollout-001.jsonl');
    fs.writeFileSync(rolloutUnknown, JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'c_unknown',
        name: 'custom_mystery_tool',
        arguments: JSON.stringify({ hugeOpaqueBlob: 'DO_NOT_DUMP_UNKNOWN_JSON', secretMeta: 42 })
      }
    }) + '\n');
    fs.utimesSync(rolloutUnknown, new Date(codexBase), new Date(codexBase));
    monitor.lastCodexRolloutScan = 0;
    const codexUnknown = monitor.checkCodex(codexBase + 500);
    assert.equal(codexUnknown.source, 'Codex');
    assert.equal(codexUnknown.rawId, 'rollout-001.jsonl', 'checkCodex must expose top-level rawId');
    assert.equal(codexUnknown.taskDetail, null, 'Unknown JSON arguments without allowed keys must return taskDetail: null');

    // Allowed keys on Codex function_call
    fs.writeFileSync(rolloutUnknown, JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'c_ok',
        name: 'shell',
        arguments: JSON.stringify({ cmd: 'node test/run-all.mjs', workdir: 'D:\\AgentPet', extraJunk: 'IGNORE_ME' })
      }
    }) + '\n');
    const tc2 = new Date(codexBase + 1000);
    fs.utimesSync(rolloutUnknown, tc2, tc2);
    monitor.lastCodexRolloutScan = 0;
    const codexAllowed = monitor.checkCodex(codexBase + 1500);
    assert.ok(codexAllowed.taskDetail.includes('node test/run-all.mjs'));
    assert.ok(codexAllowed.taskDetail.includes('D:\\AgentPet'));
    assert.ok(!codexAllowed.taskDetail.includes('IGNORE_ME'));

    // Codex APPROVAL REQUEST first paragraph
    fs.writeFileSync(rolloutUnknown, JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: 'APPROVAL REQUEST: Run powershell script with elevated permissions.\n\nSecond paragraph details omitted.'
      }
    }) + '\n');
    const tc3 = new Date(codexBase + 2000);
    fs.utimesSync(rolloutUnknown, tc3, tc3);
    monitor.lastCodexRolloutScan = 0;
    const codexApproval = monitor.checkCodex(codexBase + 2500);
    assert.equal(codexApproval.state, 'waiting');
    assert.ok(codexApproval.taskDetail.includes('APPROVAL REQUEST: Run powershell script'));
    assert.ok(!codexApproval.taskDetail.includes('Second paragraph details omitted'));

    // Codex turn_context -> null
    fs.writeFileSync(rolloutUnknown, JSON.stringify({
      type: 'turn_context',
      payload: { model: 'gpt-5' }
    }) + '\n');
    const tc4 = new Date(codexBase + 3000);
    fs.utimesSync(rolloutUnknown, tc4, tc4);
    monitor.lastCodexRolloutScan = 0;
    const codexTurnCtx = monitor.checkCodex(codexBase + 3500);
    assert.equal(codexTurnCtx.taskDetail, null);

    // Codex async question (use a dedicated append-only rollout file so incremental byte-offset cache starts at 0)
    const codexAsyncBase = codexBase + 4000;
    const rolloutAsync = path.join(codexDir, 'rollout-002-async.jsonl');
    fs.writeFileSync(rolloutAsync, [
      JSON.stringify({
        type: 'response_item',
        timestamp: new Date(codexAsyncBase).toISOString(),
        payload: {
          type: 'function_call',
          call_id: 'q_async_1',
          name: 'request_user_input_async',
          arguments: JSON.stringify({ questions: [{ question: '选择布局方案 A 还是 B？' }] })
        }
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: new Date(codexAsyncBase + 100).toISOString(),
        payload: {
          type: 'function_call_output',
          call_id: 'q_async_1',
          output: JSON.stringify({ accepted: true })
        }
      })
    ].join('\n') + '\n');
    const tc5 = new Date(codexAsyncBase + 200);
    fs.utimesSync(rolloutAsync, tc5, tc5);
    monitor.codexRolloutCandidates = [];
    monitor.lastCodexRolloutScan = 0;
    monitor.scan();
    assert.equal(events.at(-1).state, 'waiting');
    assert.equal(events.at(-1).rawId, 'rollout-002-async.jsonl');
    assert.ok(events.at(-1).taskDetail.includes('选择布局方案 A 还是 B？'));

    console.log('[PASS] Scenario 3: Allowed-field extraction & strict boundary across AG/DSH/Codex');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 4. Structured Publish Key, Heartbeat (10s), and Codex -> idle pollQuota regression
{
  const { root, paths } = makeTempWorkspace('agentpet-hover-publish-');
  try {
    const events = [];
    let pollQuotaCalls = 0;
    let fakeAg = null;
    let fakeDsh = null;
    let fakeCodex = null;

    const monitor = createMonitor(paths, events);
    monitor.pollQuota = () => { pollQuotaCalls++; };
    monitor.checkAntigravity = () => fakeAg;
    monitor.checkDsh = () => fakeDsh;
    monitor.checkCodex = () => fakeCodex;

    const realDateNow = Date.now;
    let clock = 1_760_000_000_000;
    Date.now = () => clock;

    try {
      // Initial Codex active
      fakeCodex = {
        source: 'Codex',
        rawId: 'session-A.jsonl',
        sessionId: 'session-A.jsonl',
        state: 'working',
        task: '运行检查脚本',
        taskDetail: 'node test/run-all.mjs --pass-1 Bearer secretA_123456',
        sessionCount: 2,
        at: clock
      };
      monitor.scan();
      assert.equal(events.length, 1);
      assert.equal(events[0].rawId, 'session-A.jsonl');
      assert.ok(events[0].taskDetail.includes('Bearer [REDACTED]'));
      assert.equal(pollQuotaCalls, 0);

      // Identical state at +1s -> must NOT publish or pollQuota
      clock += 1000;
      monitor.scan();
      assert.equal(events.length, 1, 'No change within 10s must not publish');
      assert.equal(pollQuotaCalls, 0);

      // Only taskDetail changed (same source/state/task/rawId) -> MUST publish immediately
      fakeCodex = { ...fakeCodex, taskDetail: 'node test/run-all.mjs --pass-2', at: clock };
      monitor.scan();
      assert.equal(events.length, 2, 'taskDetail change must publish immediately');
      assert.equal(events[1].taskDetail, 'node test/run-all.mjs --pass-2');
      assert.equal(pollQuotaCalls, 0);

      // Same source/state/task/taskDetail, ONLY rawId switches session A -> session B -> MUST publish immediately
      clock += 500;
      fakeCodex = { ...fakeCodex, rawId: 'session-B.jsonl', sessionId: 'session-B.jsonl', at: clock };
      monitor.scan();
      assert.equal(events.length, 3, 'rawId switch A -> B must publish immediately');
      assert.equal(events[2].rawId, 'session-B.jsonl');

      // Only sessionCount switches 2 -> 3 -> MUST publish immediately
      clock += 500;
      fakeCodex = { ...fakeCodex, sessionCount: 3, at: clock };
      monitor.scan();
      assert.equal(events.length, 4, 'sessionCount 2 -> 3 must publish immediately');
      assert.equal(events[3].agents.codex.sessionCount, 3);

      // Same key at +10_000ms -> MUST emit 10s heartbeat, must NOT trigger pollQuota
      clock += 10_000;
      fakeCodex = { ...fakeCodex, at: clock };
      monitor.scan();
      assert.equal(events.length, 5, '10s heartbeat must still emit');
      assert.equal(pollQuotaCalls, 0, 'Routine 10s heartbeat must NOT trigger pollQuota');

      // Sub-agent top-level & agents.* both redacted/capped while Codex remains primary source
      const crossSecret = 'x'.repeat(694) + 'DEEPSEEK_API_KEY=CROSS_AGENT_SUB_SECRET';
      fakeDsh = {
        source: 'DSH',
        rawId: 'dsh-1.json',
        state: 'working',
        task: '并行分析',
        taskDetail: crossSecret,
        sessionCount: 1,
        at: clock - 500
      };
      monitor.scan();
      assert.equal(events.length, 6);
      assert.equal(events[5].source, 'Codex');
      assert.ok(!events[5].agents.dsh.taskDetail.includes('CROSS_AGENT_SUB_SECRET'), 'agents.dsh.taskDetail must also be redacted & capped');
      assert.ok(Array.from(events[5].agents.dsh.taskDetail).length <= 700);

      // Critical regression: Codex -> idle (!best) MUST still trigger pollQuota(false) ONCE!
      fakeDsh = null;
      fakeCodex = null;
      clock += 1000;
      monitor.scan();
      assert.equal(events.length, 7);
      assert.equal(events[6].source, null);
      assert.equal(pollQuotaCalls, 1, 'Codex -> idle must trigger pollQuota(false) ONCE even with structured JSON lastStateKey');

      // Staying idle must NOT re-trigger pollQuota
      clock += 1000;
      monitor.scan();
      assert.equal(events.length, 7);
      assert.equal(pollQuotaCalls, 1, 'Staying idle must not re-trigger pollQuota');
    } finally {
      Date.now = realDateNow;
    }

    console.log('[PASS] Scenario 4: Structured publish key, 10s heartbeat & Codex -> idle pollQuota regression');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('\nAll hover-detail assertions passed.');
} catch (err) {
  console.error('[hover-detail.test.mjs FAILURE]', err);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(testLogRoot, { recursive: true, force: true }); } catch {}
}
