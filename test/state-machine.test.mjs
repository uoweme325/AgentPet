// test/state-machine.test.mjs —— 覆盖 AGENTPET-STATE-FIX-01-R2 (WO-30 ~ WO-37) 13 条回归矩阵
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpet-state-test-'));
const tmpLogFile = path.join(tmpRoot, 'test-monitor.log');

// 导入前注入隔离日志路径（§6 第 5 条：禁止污染生产 runtime-error.log）
process.argv.push('--log-file', tmpLogFile);

function setFileMtime(filePath, mtimeMs) {
  const sec = mtimeMs / 1000;
  fs.utimesSync(filePath, sec, sec);
}

function createIsolatedMonitor(subName, options = {}) {
  const base = path.join(tmpRoot, subName);
  const agBrain = path.join(base, 'ag-brain');
  const agDb = path.join(base, 'ag-db');
  const codexHome = path.join(base, 'codex');
  const dshDir = path.join(base, 'dsh');
  const runtimeDir = path.join(base, 'runtime');
  fs.mkdirSync(agBrain, { recursive: true });
  fs.mkdirSync(agDb, { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'sessions', '2026', '11', '01'), { recursive: true });
  fs.mkdirSync(dshDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const m = new options.AgentMonitor({
    stallSeconds: options.stallSeconds !== undefined ? options.stallSeconds : 45,
    onChange: options.onChange || (() => {})
  });
  m.paths.antigravity = agBrain;
  m.paths.antigravityDb = agDb;
  m.paths.codex = codexHome;
  m.paths.dshDirs = [dshDir];
  m.paths.appDir = runtimeDir;
  m.paths.balanceFile = path.join(runtimeDir, 'runtime-balance.json');
  return { m, base, agBrain, agDb, codexHome, dshDir, runtimeDir };
}

function writeAgDbFixture(dbPath, rows, mtimeMs) {
  if (!DatabaseSync) throw new Error('node:sqlite DatabaseSync is required for AG DB fixture');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata TEXT)');
    const stmt = db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)');
    for (const r of rows) {
      stmt.run(r.idx, r.step_type, r.status, typeof r.metadata === 'string' ? r.metadata : JSON.stringify(r.metadata));
    }
  } finally {
    db.close();
  }
  setFileMtime(dbPath, mtimeMs);
}

function writeAgTranscriptFixture(agBrain, convId, entries, mtimeMs) {
  const logDir = path.join(agBrain, convId, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const tf = path.join(logDir, 'transcript.jsonl');
  fs.writeFileSync(tf, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  setFileMtime(tf, mtimeMs);
  return tf;
}

function writeCodexFixture(codexHome, name, entries, mtimeMs) {
  const dir = path.join(codexHome, 'sessions', '2026', '11', '01');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, name);
  const lines = entries.map(e => JSON.stringify({ ...e, timestamp: new Date(mtimeMs).toISOString() }));
  fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf8');
  setFileMtime(fp, mtimeMs);
  return fp;
}

function writeDshFixture(dshDir, name, recordRows, mtimeMs) {
  const fp = path.join(dshDir, name);
  fs.writeFileSync(fp, JSON.stringify({ record: { rows: recordRows } }), 'utf8');
  setFileMtime(fp, mtimeMs);
  return fp;
}

try {
  const {
    AgentMonitor,
    atomicWriteJson,
    writeJsonWithRetry,
    flushPendingWrites,
    dispatchRuntimeWrite,
    pendingWrites
  } = await import('../runtime/agent-monitor.mjs');

  const t0 = 1_793_540_000_000;

  // =========================================================================
  // 场景 1, 3, 4: 工具输出后无结束事件（AG DB、AG transcript、Codex 各一条）
  // 0s result -> 9s thinking -> 190s 无候选；缓存路径 vs 重解析路径 state & task 逐字一致；
  // AG DB 单步工具完成 9s 后 thinking 不归空；at 时间戳在 0s 与 9s 保持不变
  // =========================================================================
  {
    const envCached = createIsolatedMonitor('s1-cached', { AgentMonitor });
    const envFresh0 = createIsolatedMonitor('s1-fresh0', { AgentMonitor });
    const envFresh9 = createIsolatedMonitor('s1-fresh9', { AgentMonitor });
    const envFresh190 = createIsolatedMonitor('s1-fresh190', { AgentMonitor });

    for (const env of [envCached, envFresh0, envFresh9, envFresh190]) {
      writeAgDbFixture(
        path.join(env.agDb, 'conv-db-1.db'),
        [{ idx: 1, step_type: 132, status: 3, metadata: { toolName: 'read_file', toolSummary: 'Read config' } }],
        t0
      );
      writeAgTranscriptFixture(
        env.agBrain,
        'conv-tx-1',
        [
          { step_index: 1, type: 'PLANNER_RESPONSE', status: 'IN_PROGRESS', tool_calls: [{ name: 'run_command', args: { toolSummary: 'Run unit tests' } }] },
          { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Tool output' }
        ],
        t0
      );
      writeCodexFixture(
        env.codexHome,
        'rollout-1.jsonl',
        [
          { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', status: 'in_progress' } },
          { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } }
        ],
        t0
      );
    }

    // t + 0s
    const dbCached0 = envCached.m.checkAntigravityDb(t0);
    const txCached0 = envCached.m.checkAntigravityTranscript(t0);
    const cxCached0 = envCached.m.checkCodex(t0);

    const dbFresh0 = envFresh0.m.checkAntigravityDb(t0);
    const txFresh0 = envFresh0.m.checkAntigravityTranscript(t0);
    const cxFresh0 = envFresh0.m.checkCodex(t0);

    assert.strictEqual(dbCached0?.state, 'result');
    assert.strictEqual(txCached0?.state, 'result');
    assert.strictEqual(cxCached0?.state, 'result');
    assert.strictEqual(dbCached0.at, t0);
    assert.strictEqual(txCached0.at, t0);
    assert.strictEqual(cxCached0.at, t0);

    assert.strictEqual(dbCached0.state, dbFresh0.state);
    assert.strictEqual(dbCached0.task, dbFresh0.task);
    assert.strictEqual(txCached0.state, txFresh0.state);
    assert.strictEqual(txCached0.task, txFresh0.task);
    assert.strictEqual(cxCached0.state, cxFresh0.state);
    assert.strictEqual(cxCached0.task, cxFresh0.task);

    // t + 9s (9000ms >= TERMINAL_HOLD_MS 8000ms)
    const t9 = t0 + 9_000;
    const dbCached9 = envCached.m.checkAntigravityDb(t9);
    const txCached9 = envCached.m.checkAntigravityTranscript(t9);
    const cxCached9 = envCached.m.checkCodex(t9);

    const dbFresh9 = envFresh9.m.checkAntigravityDb(t9);
    const txFresh9 = envFresh9.m.checkAntigravityTranscript(t9);
    const cxFresh9 = envFresh9.m.checkCodex(t9);

    assert.strictEqual(dbCached9?.state, 'thinking', 'Scenario 4: AG DB single tool completion at 9s must be thinking, not null');
    assert.strictEqual(txCached9?.state, 'thinking');
    assert.strictEqual(cxCached9?.state, 'thinking');

    // at 保持原始事件时间戳 t0 不变
    assert.strictEqual(dbCached9.at, t0);
    assert.strictEqual(txCached9.at, t0);
    assert.strictEqual(cxCached9.at, t0);

    // 场景 3: 缓存路径与重解析路径 state & task 逐字一致
    assert.strictEqual(dbCached9.state, dbFresh9.state);
    assert.strictEqual(dbCached9.task, dbFresh9.task);
    assert.strictEqual(txCached9.state, txFresh9.state);
    assert.strictEqual(txCached9.task, txFresh9.task);
    assert.strictEqual(cxCached9.state, cxFresh9.state);
    assert.strictEqual(cxCached9.task, cxFresh9.task);

    // 还测 Codex item_completed 分支的缓存与重解析逐字一致
    const envItemCached = createIsolatedMonitor('s1-item-cached', { AgentMonitor });
    const envItemFresh9 = createIsolatedMonitor('s1-item-fresh9', { AgentMonitor });
    for (const env of [envItemCached, envItemFresh9]) {
      writeCodexFixture(
        env.codexHome,
        'rollout-item.jsonl',
        [{ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'command', name: 'npm test' } } }],
        t0
      );
    }
    const ic0 = envItemCached.m.checkCodex(t0);
    assert.strictEqual(ic0?.state, 'result');
    const icCached9 = envItemCached.m.checkCodex(t9);
    const icFresh9 = envItemFresh9.m.checkCodex(t9);
    assert.strictEqual(icCached9?.state, 'thinking');
    assert.strictEqual(icCached9.state, icFresh9.state);
    assert.strictEqual(icCached9.task, icFresh9.task);

    // t + 190s (190000ms >= ACTIVE_MAX_AGE_MS 180000ms) -> 全部过期为 null
    const t190 = t0 + 190_000;
    assert.strictEqual(envCached.m.checkAntigravityDb(t190), null);
    assert.strictEqual(envCached.m.checkAntigravityTranscript(t190), null);
    assert.strictEqual(envCached.m.checkCodex(t190), null);
    assert.strictEqual(envFresh190.m.checkAntigravityDb(t190), null);
    assert.strictEqual(envFresh190.m.checkAntigravityTranscript(t190), null);
    assert.strictEqual(envFresh190.m.checkCodex(t190), null);

    console.log('[PASS] Scenario 1: 工具输出后无结束事件 (AG DB / AG transcript / Codex: 0s result -> 9s thinking -> 190s null)');
    console.log('[PASS] Scenario 3: 缓存路径 vs 重解析路径 state 与 task 逐字一致');
    console.log('[PASS] Scenario 4: AG DB 单步工具完成 9s 后进入 thinking 不归空');
  }

  // =========================================================================
  // 场景 2: 工具输出后紧跟 task_complete -> 任何时候都不回 thinking
  // =========================================================================
  {
    const env = createIsolatedMonitor('s2-done', { AgentMonitor });
    writeCodexFixture(
      env.codexHome,
      'rollout-done.jsonl',
      [
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'tool', name: 'build' } } },
        { type: 'event_msg', payload: { type: 'task_complete' } }
      ],
      t0
    );
    const c0 = env.m.checkCodex(t0);
    assert.strictEqual(c0?.state, 'success');
    for (const dt of [1_000, 7_900, 8_100, 9_000, 30_000, 190_000]) {
      const c = env.m.checkCodex(t0 + dt);
      assert.notStrictEqual(c?.state, 'thinking', `At +${dt}ms must never resurrect to thinking`);
      if (dt >= 8_000) assert.strictEqual(c, null);
    }
    console.log('[PASS] Scenario 2: 工具输出后紧跟 task_complete 任何时刻均不回 thinking');
  }

  // =========================================================================
  // 场景 5, 6, 7: WO-31 Codex 提问类工具识别与边界
  // =========================================================================
  {
    // 场景 5a: 未闭合 request_user_input -> waiting
    const env5 = createIsolatedMonitor('s5-wait', { AgentMonitor });
    const fp5 = writeCodexFixture(
      env5.codexHome,
      'rollout-wait.jsonl',
      [{ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'ask-1', name: 'request_user_input' } }],
      t0
    );
    const st5a = env5.m.checkCodex(t0 + 1_000);
    assert.strictEqual(st5a?.state, 'waiting');
    assert.strictEqual(st5a?.inFlight, true);

    // 场景 5b: 对应 *_output 出现后 -> 退出 waiting
    writeCodexFixture(
      env5.codexHome,
      'rollout-wait.jsonl',
      [
        { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'ask-1', name: 'request_user_input' } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'ask-1', output: 'selected option A' } }
      ],
      t0 + 2_000
    );
    env5.m.lastCodexRolloutScan = 0;
    const st5b = env5.m.checkCodex(t0 + 2_500);
    assert.ok(st5b && st5b.state !== 'waiting', `Expected non-waiting after output, got ${st5b?.state}`);

    // 场景 5c: 已结束回合中的旧提问 -> 不复活
    writeCodexFixture(
      env5.codexHome,
      'rollout-wait.jsonl',
      [
        { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'ask-old', name: 'request_user_input' } },
        { type: 'event_msg', payload: { type: 'task_complete' } }
      ],
      t0 + 3_000
    );
    env5.m.lastCodexRolloutScan = 0;
    const st5c = env5.m.checkCodex(t0 + 15_000);
    assert.strictEqual(st5c, null);
    // 场景 5d: AG transcript 的 ask_question 已闭合（带输出或后续步骤）时不报 waiting
    const env5d = createIsolatedMonitor('s5d-ag-ask-closed', { AgentMonitor });
    writeAgTranscriptFixture(
      env5d.agBrain,
      'conv-ask-closed',
      [
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'IN_PROGRESS', tool_calls: [{ id: 'tc-ask-1', name: 'ask_question', status: 'DONE', result: 'Option A' }] }
      ],
      t0
    );
    assert.notStrictEqual(env5d.m.checkAntigravityTranscript(t0 + 1_000)?.state, 'waiting');
    writeAgTranscriptFixture(
      env5d.agBrain,
      'conv-ask-closed-2',
      [
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'IN_PROGRESS', tool_calls: [{ id: 'tc-ask-2', name: 'ask_question' }] },
        { step_index: 2, type: 'TOOL_RESPONSE', call_id: 'tc-ask-2', content: 'User answered' }
      ],
      t0 + 500
    );
    env5d.m.lastAgTranscriptScan = 0;
    assert.notStrictEqual(env5d.m.checkAntigravityTranscript(t0 + 1_000)?.state, 'waiting');
    console.log('[PASS] Scenario 5: 未闭合 request_user_input 识别为 waiting、有 output 后退出等待、已结束回合不复活 (含 AG transcript 闭合检查)');

    // 场景 6: functions.request_user_input / functions.ask_question -> waiting
    const env6 = createIsolatedMonitor('s6-ns-wait', { AgentMonitor });
    for (const [idx, toolName] of ['functions.request_user_input', 'functions.ask_question'].entries()) {
      writeCodexFixture(
        env6.codexHome,
        `rollout-ns-${idx}.jsonl`,
        [{ type: 'response_item', payload: { type: 'function_call', call_id: `ask-ns-${idx}`, name: toolName } }],
        t0 + idx * 100
      );
      env6.m.lastCodexRolloutScan = 0;
      const st6 = env6.m.checkCodex(t0 + 1_000);
      assert.strictEqual(st6?.state, 'waiting', `Expected waiting for ${toolName}`);
    }
    console.log('[PASS] Scenario 6: functions.request_user_input 识别为 waiting');

    // 场景 7: 普通 exec_command / exec (哪怕命令参数含 request_user_input) 及非白名单 confirm -> working
    const env7 = createIsolatedMonitor('s7-exec', { AgentMonitor });
    writeCodexFixture(
      env7.codexHome,
      'rollout-exec.jsonl',
      [{ type: 'response_item', payload: { type: 'function_call', call_id: 'cmd-1', name: 'exec_command', arguments: 'grep request_user_input rm -rf' } }],
      t0
    );
    const st7 = env7.m.checkCodex(t0 + 1_000);
    assert.strictEqual(st7?.state, 'working');
    writeCodexFixture(
      env7.codexHome,
      'rollout-confirm.jsonl',
      [{ type: 'response_item', payload: { type: 'function_call', call_id: 'cmd-2', name: 'confirm' } }],
      t0 + 200
    );
    env7.m.lastCodexRolloutScan = 0;
    const st7b = env7.m.checkCodex(t0 + 1_000);
    assert.strictEqual(st7b?.state, 'working');
    console.log('[PASS] Scenario 7: 普通 exec_command 与非白名单工具保持 working 不误判');
  }

  // =========================================================================
  // 场景 8: WO-32 冷启动 250 秒等待 vs 250 秒普通思考（覆盖四条候选路径）
  // =========================================================================
  {
    const envWait = createIsolatedMonitor('s8-cold-wait', { AgentMonitor });
    writeAgTranscriptFixture(
      envWait.agBrain,
      'conv-wait-250',
      [{ step_index: 1, type: 'PLANNER_RESPONSE', status: 'IN_PROGRESS', tool_calls: [{ name: 'ask_question', args: {} }] }],
      t0
    );
    writeDshFixture(
      envWait.dshDir,
      'session-wait-250.json',
      { userQuestions: { val: { questions: { active: [{ id: 'q1' }] } } } },
      t0
    );
    writeCodexFixture(
      envWait.codexHome,
      'rollout-wait-250.jsonl',
      [{ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'w250', name: 'request_user_input' } }],
      t0
    );

    const t250 = t0 + 250_000;
    assert.strictEqual(envWait.m.checkAntigravityTranscript(t250)?.state, 'waiting');
    assert.strictEqual(envWait.m.checkDsh(t250)?.state, 'waiting');
    assert.strictEqual(envWait.m.checkCodex(t250)?.state, 'waiting');

    const envThink = createIsolatedMonitor('s8-cold-think', { AgentMonitor });
    writeAgDbFixture(
      path.join(envThink.agDb, 'conv-think-250.db'),
      [{ idx: 1, step_type: 132, status: 3, metadata: { toolName: 'read_file', toolSummary: 'Old step' } }],
      t0
    );
    writeAgTranscriptFixture(
      envThink.agBrain,
      'conv-think-250',
      [{ step_index: 1, type: 'USER_INPUT', content: 'hello' }],
      t0
    );
    writeDshFixture(
      envThink.dshDir,
      'session-think-250.json',
      { turnBoundary: { val: { openTurnStartSeq: 1 } } },
      t0
    );
    writeCodexFixture(
      envThink.codexHome,
      'rollout-think-250.jsonl',
      [{ type: 'response_item', payload: { type: 'reasoning' } }],
      t0
    );

    assert.strictEqual(envThink.m.checkAntigravityDb(t250), null);
    assert.strictEqual(envThink.m.checkAntigravityTranscript(t250), null);
    assert.strictEqual(envThink.m.checkDsh(t250), null);
    assert.strictEqual(envThink.m.checkCodex(t250), null);

    console.log('[PASS] Scenario 8: 冷启动 250 秒等待正常识别为 waiting，250 秒普通思考不显示');
  }

  // =========================================================================
  // 场景 9: WO-33 统一在飞保留时间 (190 秒在飞: StallDetectSeconds=0 -> working, 默认 -> stalled, 310s 过期)
  // =========================================================================
  {
    const envNoStall = createIsolatedMonitor('s9-nostall', { AgentMonitor, stallSeconds: 0 });
    const envDefaultStall = createIsolatedMonitor('s9-defstall', { AgentMonitor, stallSeconds: 45 });

    for (const env of [envNoStall, envDefaultStall]) {
      writeAgDbFixture(
        path.join(env.agDb, 'conv-inflight.db'),
        [{ idx: 1, step_type: 132, status: 1, metadata: { toolName: 'run_command', toolSummary: 'Long build' } }],
        t0
      );
      writeCodexFixture(
        env.codexHome,
        'rollout-inflight.jsonl',
        [{ type: 'response_item', payload: { type: 'function_call', call_id: 'c-long', name: 'exec_command' } }],
        t0
      );
    }

    const t60 = t0 + 60_000;
    const t190 = t0 + 190_000;
    const t290 = t0 + 290_000;
    const t310 = t0 + 310_000;

    // 冷启动直读 190s 与持续运行结果一致
    const envColdNoStall = createIsolatedMonitor('s9-cold-nostall', { AgentMonitor, stallSeconds: 0 });
    const envColdDefStall = createIsolatedMonitor('s9-cold-defstall', { AgentMonitor, stallSeconds: 45 });
    for (const env of [envColdNoStall, envColdDefStall]) {
      writeCodexFixture(
        env.codexHome,
        'rollout-inflight.jsonl',
        [{ type: 'response_item', payload: { type: 'function_call', call_id: 'c-long', name: 'exec_command' } }],
        t0
      );
    }
    assert.strictEqual(envColdNoStall.m.checkCodex(t190)?.state, 'working');
    assert.strictEqual(envColdDefStall.m.checkCodex(t190)?.state, 'stalled');

    // 持续运行：60s / 190s / 290s / 310s
    assert.strictEqual(envNoStall.m.checkAntigravityDb(t60)?.state, 'working');
    assert.strictEqual(envNoStall.m.checkAntigravityDb(t190)?.state, 'working');
    assert.strictEqual(envNoStall.m.checkAntigravityDb(t290)?.state, 'working');
    assert.strictEqual(envNoStall.m.checkAntigravityDb(t310), null);

    assert.strictEqual(envNoStall.m.checkCodex(t60)?.state, 'working');
    assert.strictEqual(envNoStall.m.checkCodex(t190)?.state, 'working');
    assert.strictEqual(envNoStall.m.checkCodex(t290)?.state, 'working');
    assert.strictEqual(envNoStall.m.checkCodex(t310), null);

    assert.strictEqual(envDefaultStall.m.checkCodex(t60)?.state, 'stalled');
    assert.strictEqual(envDefaultStall.m.checkCodex(t190)?.state, 'stalled');
    assert.strictEqual(envDefaultStall.m.checkCodex(t290)?.state, 'stalled');
    assert.strictEqual(envDefaultStall.m.checkCodex(t310), null);

    console.log('[PASS] Scenario 9: 190s 在飞 StallDetectSeconds=0 为 working、默认为 stalled，310s 均过期，冷启动与持续运行一致');
  }

  // =========================================================================
  // 场景 10: WO-34 反重力跨会话与同会话仲裁
  // =========================================================================
  {
    const env = createIsolatedMonitor('s10-ag-arb', { AgentMonitor });

    // 10a: A 会话完成(DB) / B 会话工作(Transcript) -> 选 B
    writeAgDbFixture(
      path.join(env.agDb, 'session-A.db'),
      [{ idx: 10, step_type: 15, status: 3, metadata: {} }],
      t0
    );
    writeAgTranscriptFixture(
      env.agBrain,
      'session-B',
      [{ step_index: 5, type: 'PLANNER_RESPONSE', status: 'IN_PROGRESS', tool_calls: [{ name: 'run_command', args: { toolSummary: 'Task B working' } }] }],
      t0 - 1_000
    );
    const res10a = env.m.checkAntigravity(t0 + 1_000);
    assert.strictEqual(res10a?.rawId, 'session-B');
    assert.strictEqual(res10a?.state, 'working');

    // 10b: A 会话工作(DB) / B 会话等待(Transcript) -> 选 B
    env.m.lastAgDbScan = 0;
    env.m.antigravityDbCache.clear();
    env.m.lastAgTranscriptScan = 0;
    env.m.antigravityTranscriptCache.clear();
    writeAgDbFixture(
      path.join(env.agDb, 'session-A.db'),
      [{ idx: 11, step_type: 132, status: 1, metadata: { toolSummary: 'Task A working' } }],
      t0
    );
    writeAgTranscriptFixture(
      env.agBrain,
      'session-B',
      [{ step_index: 6, type: 'PLANNER_RESPONSE', status: 'IN_PROGRESS', tool_calls: [{ name: 'ask_question', args: {} }] }],
      t0 - 2_000
    );
    const res10b = env.m.checkAntigravity(t0 + 1_000);
    assert.strictEqual(res10b?.rawId, 'session-B');
    assert.strictEqual(res10b?.state, 'waiting');

    // 10c: 同会话 txIdx = dbIdx - 1 且 transcript 在飞 -> 取 transcript
    const envSame = createIsolatedMonitor('s10-same', { AgentMonitor });
    writeAgDbFixture(
      path.join(envSame.agDb, 'session-same.db'),
      [{ idx: 10, step_type: 15, status: 3, metadata: {} }],
      t0
    );
    writeAgTranscriptFixture(
      envSame.agBrain,
      'session-same',
      [{ step_index: 9, type: 'PLANNER_RESPONSE', status: 'IN_PROGRESS', tool_calls: [{ name: 'run_command', args: { toolSummary: 'Inflight step 9' } }] }],
      t0
    );
    const res10c = envSame.m.checkAntigravity(t0 + 1_000);
    assert.strictEqual(res10c?.state, 'working');
    assert.strictEqual(res10c?.task, 'Inflight step 9');

    // 10d: 同会话 DB 已结束 (idx=10, success)，transcript 旧在飞步骤落后超过容差 (idx=8 = dbIdx-2) -> 不得重新显示旧工作状态
    const envSameOld = createIsolatedMonitor('s10-same-old', { AgentMonitor });
    writeAgDbFixture(
      path.join(envSameOld.agDb, 'session-same-old.db'),
      [{ idx: 10, step_type: 15, status: 3, metadata: {} }],
      t0
    );
    writeAgTranscriptFixture(
      envSameOld.agBrain,
      'session-same-old',
      [{ step_index: 8, type: 'PLANNER_RESPONSE', status: 'IN_PROGRESS', tool_calls: [{ name: 'run_command', args: { toolSummary: 'Stale step 8' } }] }],
      t0
    );
    const res10d = envSameOld.m.checkAntigravity(t0 + 1_000);
    assert.strictEqual(res10d?.state, 'success', 'Same session with DB finished and txIdx = dbIdx - 2 must NOT resurrect stale working step');

    // 10e: 任一会话标识缺失 -> 不套用 ±1 容差，走 selectBest 分支
    const envMissingId = createIsolatedMonitor('s10-missing-id', { AgentMonitor });
    envMissingId.m.checkAntigravityDb = () => ({ source: 'Antigravity', state: 'success', task: 'DB done', at: t0, stepIdx: 10, rawId: '' });
    envMissingId.m.checkAntigravityTranscript = () => ({ source: 'Antigravity', state: 'working', task: 'TX active', at: t0 - 500, stepIdx: 5, inFlight: true, rawId: 'conv-only-tx' });
    const res10e = envMissingId.m.checkAntigravity(t0 + 1_000);
    assert.strictEqual(res10e?.state, 'working');
    assert.strictEqual(res10e?.task, 'TX active');

    console.log('[PASS] Scenario 10: AG 跨会话与同会话仲裁 (A完成B工作 / A工作B等待 / 同会话±1容差 / 同会话防旧步骤复活 / 标识缺失)');
  }

  // =========================================================================
  // 场景 11: WO-35 启动预置旧低额文件 -> 不显示旧额、不提醒 -> 15s 暂不可用 -> 20s 恢复正常并提醒一次
  // =========================================================================
  {
    const psTestDir = path.join(tmpRoot, 's11-ps-balance');
    fs.mkdirSync(psTestDir, { recursive: true });
    const runnerPs1 = path.join(psTestDir, 'verify-wo35.ps1');

    // 从真实 AgentPet.ps1 中提取 9.5 节函数与 Poll-AgentMonitor 中的余额监控段进行无头验证
    const psScriptContent = `
Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase
$ErrorActionPreference = 'Stop'
$src = Get-Content -LiteralPath '${path.join(repoRoot, 'AgentPet.ps1').replace(/'/g, "''")}' -Raw -Encoding UTF8

# 提取 section 9.5 (从 $script:lastBalanceMtime 到 Read-InitialBalanceSnapshot 结束)
$startIdx = $src.IndexOf('$script:lastBalanceMtime   = [DateTime]::MinValue')
$endMarker = '# ============================================================================' + "\`r\`n" + '# 10. Q-Bounce'
$endIdx = $src.IndexOf($endMarker)
if ($startIdx -lt 0 -or $endIdx -lt 0) { throw "Failed to locate Section 9.5 in AgentPet.ps1" }
$sec95 = $src.Substring($startIdx, $endIdx - $startIdx)

# 提取 Poll-AgentMonitor 中的步骤 3 (runtime-balance.json 监控与超时段)
$pollStart = $src.IndexOf('# 3. Watch runtime-balance.json file modification')
$pollEnd = $src.IndexOf('# 2. Watch runtime-status.json file modification')
if ($pollStart -lt 0 -or $pollEnd -lt 0) { throw "Failed to locate Poll-AgentMonitor balance block in AgentPet.ps1" }
$pollBalanceBlock = $src.Substring($pollStart, $pollEnd - $pollStart)

# Mock 必要的 UI 控件与环境函数
$RuntimeBalancePath = '${path.join(psTestDir, 'runtime-balance.json').replace(/'/g, "''")}'
$RefreshBalanceFlagPath = '${path.join(psTestDir, 'refresh-balance.flag').replace(/'/g, "''")}'
$Config = @{ DeepSeekBalanceEnabled = $true; LowBalanceCnyThreshold = 5.0; LowBalanceAlertEnabled = $true }
$script:AgentIcons = @{}
$script:manualBubbleHidden = $false
$script:agentBusy = $false
$script:userInspectUntil = [DateTime]::MinValue
$script:alertTriggeredCount = 0
$script:activePanel = 'quota'

function Make-MockCtrl { New-Object PSObject -Property @{ Text = ''; Visibility = 'Collapsed'; Source = $null; ToolTip = $null } }
$DeepSeekPanel = Make-MockCtrl
$DeepSeekIcon = Make-MockCtrl
$DeepSeekOkPanel = Make-MockCtrl
$DeepSeekMsgPanel = Make-MockCtrl
$DeepSeekBadge = Make-MockCtrl
$DeepSeekBadgeText = Make-MockCtrl
$DeepSeekStatusNotice = Make-MockCtrl
$DeepSeekMsgTitle = Make-MockCtrl
$DeepSeekMsgDetail = Make-MockCtrl
$DeepSeekCurrencyLabel = Make-MockCtrl
$DeepSeekTotalText = Make-MockCtrl
$DeepSeekBreakdownText = Make-MockCtrl
$DeepSeekAvailableNotice = Make-MockCtrl

function Play-ReleaseSound { $script:alertTriggeredCount++ }
function Set-ActiveBubblePanel([string]$p) { $script:activePanel = $p }
function Show-Bubble([double]$sec) { }
function Log-Throttled([string]$k, [string]$m) { }

Invoke-Expression $sec95
$pollFn = [ScriptBlock]::Create($pollBalanceBlock)

# 1) 预置 6 小时前、余额 1.00 的旧低额快照
$oldSnap = @{
    type = 'balance'; provider = 'deepseek-official'; credentialSource = 'env'; status = 'ok';
    isAvailable = $true; fetchedAt = 1700000000000;
    balances = @(@{ currency = 'CNY'; totalBalance = '1.00'; toppedUpBalance = '1.00'; grantedBalance = '0.00' })
} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($RuntimeBalancePath, $oldSnap, [Text.Encoding]::UTF8)
(Get-Item $RuntimeBalancePath).LastWriteTimeUtc = [DateTime]::UtcNow.AddHours(-6)

# 启动：调用 Read-InitialBalanceSnapshot + 第一个 tick
Read-InitialBalanceSnapshot
& $pollFn

if ($DeepSeekOkPanel.Visibility -ne 'Collapsed') { throw "Old snapshot should NOT show DeepSeekOkPanel" }
if ($DeepSeekTotalText.Text -eq '¥ 1.00') { throw "Old snapshot amount ¥ 1.00 must NOT be displayed" }
if ($DeepSeekStatusNotice.Text -ne '启动同步中...') { throw "Expected 启动同步中..., got $($DeepSeekStatusNotice.Text)" }
if ($script:alertTriggeredCount -ne 0) { throw "Old snapshot must NOT trigger low balance alert" }

# 2) 模拟到达 15 秒超时仍无新结果 -> 落入"暂不可用"
$script:balanceStartupDeadline = [DateTime]::UtcNow.AddSeconds(-1)
& $pollFn
if ($DeepSeekStatusNotice.Text -ne '暂不可用') { throw "Expected 暂不可用 at 15s timeout, got $($DeepSeekStatusNotice.Text)" }
if ($script:balanceStartupPending -ne $false) { throw "balanceStartupPending should be cleared at 15s timeout" }

# 3) 模拟 20 秒后新结果写入（有效低额 ¥ 2.00，且 fetchedAt 为较早时间戳以同时验证 HH:mm 读取）
$newSnap = @{
    type = 'balance'; provider = 'deepseek-official'; credentialSource = 'env'; status = 'ok';
    isAvailable = $true; fetchedAt = 1793500000000;
    balances = @(@{ currency = 'CNY'; totalBalance = '2.00'; toppedUpBalance = '2.00'; grantedBalance = '0.00' })
} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($RuntimeBalancePath, $newSnap, [Text.Encoding]::UTF8)
(Get-Item $RuntimeBalancePath).LastWriteTimeUtc = [DateTime]::UtcNow.AddSeconds(2)

& $pollFn
if ($DeepSeekOkPanel.Visibility -ne 'Visible') { throw "New snapshot should show DeepSeekOkPanel" }
if ($DeepSeekTotalText.Text -ne '¥ 2.00') { throw "Expected ¥ 2.00, got $($DeepSeekTotalText.Text)" }
if ($script:alertTriggeredCount -ne 1) { throw "Expected exactly 1 low balance alert on new low snapshot, got $script:alertTriggeredCount" }
if ($DeepSeekStatusNotice.Text -notmatch '读取$') { throw "Expected HH:mm 读取 for fetchedAt snapshot, got $($DeepSeekStatusNotice.Text)" }

# 4) 验证余额禁用时不进入启动等待
$Config.DeepSeekBalanceEnabled = $false
Read-InitialBalanceSnapshot
if ($script:balanceStartupPending -ne $false) { throw "Disabled balance must not enter startup pending" }
if ($DeepSeekStatusNotice.Text -ne '已停用') { throw "Expected 已停用 when disabled, got $($DeepSeekStatusNotice.Text)" }

Write-Output "WO35_VERIFIED_OK"
`;
    fs.writeFileSync(runnerPs1, '\uFEFF' + psScriptContent.replace(/\r?\n/g, '\r\n'), 'utf8');
    const psRes = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runnerPs1], {
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(psRes.status, 0, `WO-35 PS verification failed: ${psRes.stderr || psRes.stdout}`);
    assert.ok(psRes.stdout.includes('WO35_VERIFIED_OK'), `Missing WO35_VERIFIED_OK in output: ${psRes.stdout}`);
    console.log('[PASS] Scenario 11: WO-35 启动不显示遗留旧余额/不误报低额 -> 15s 暂不可用 -> 新结果到达正常展示并提醒一次');
  }

  // =========================================================================
  // 场景 12: WO-37 写入失败注入（工作状态 / 额度 / 余额 + 空闲态 + 重复提交 + 重试耗尽）
  // =========================================================================
  {
    const writeDir = path.join(tmpRoot, 's12-writes');
    fs.mkdirSync(writeDir, { recursive: true });
    pendingWrites.clear();

    const origRenameSync = fs.renameSync;
    let failNextCount = 0;
    let renameCallCount = 0;

    fs.renameSync = function (oldPath, newPath) {
      renameCallCount++;
      if (failNextCount > 0) {
        failNextCount--;
        const err = new Error('EPERM: simulated transient lock');
        err.code = 'EPERM';
        throw err;
      }
      return origRenameSync.call(fs, oldPath, newPath);
    };

    try {
      // 12a: 工作状态、额度、余额各自首次失败，窗口内通过 flushPendingWrites 恢复
      failNextCount = 1;
      assert.strictEqual(dispatchRuntimeWrite(writeDir, { type: 'work_status', state: 'working', task: 'Busy 1' }), false);
      failNextCount = 1;
      assert.strictEqual(dispatchRuntimeWrite(writeDir, { type: 'quota', plan: 'Pro', windows: [] }), false);
      failNextCount = 1;
      assert.strictEqual(dispatchRuntimeWrite(writeDir, { type: 'balance', status: 'ok', balances: [] }), false);

      assert.strictEqual(pendingWrites.size, 3);
      flushPendingWrites(Date.now() + 250);
      assert.strictEqual(pendingWrites.size, 0, 'All 3 pending writes should succeed on retry');

      const stDisk1 = JSON.parse(fs.readFileSync(path.join(writeDir, 'runtime-status.json'), 'utf8'));
      const qtDisk1 = JSON.parse(fs.readFileSync(path.join(writeDir, 'runtime-quota.json'), 'utf8'));
      const blDisk1 = JSON.parse(fs.readFileSync(path.join(writeDir, 'runtime-balance.json'), 'utf8'));
      assert.strictEqual(stDisk1.state, 'working');
      assert.strictEqual(qtDisk1.plan, 'Pro');
      assert.strictEqual(blDisk1.status, 'ok');

      // 12b: 空闲态写失败恢复（不能残留旧忙碌状态）
      failNextCount = 1;
      const idlePayload = { type: 'work_status', source: null, state: null, stateText: null, task: null, activeCount: 0 };
      assert.strictEqual(dispatchRuntimeWrite(writeDir, idlePayload), false);
      // 此时磁盘上还是旧 working，等待重试窗口后恢复为空闲
      flushPendingWrites(Date.now() + 250);
      const stDiskIdle = JSON.parse(fs.readFileSync(path.join(writeDir, 'runtime-status.json'), 'utf8'));
      assert.strictEqual(stDiskIdle.state, null, 'Idle state write retry must overwrite previous working state');

      // 12c: 同一份数据在重试期间重复提交：不增加实际尝试次数，也不重置计数
      const statusFile = path.join(writeDir, 'runtime-status.json');
      failNextCount = 5;
      const beforeCalls = renameCallCount;
      const dupPayload = { type: 'work_status', state: 'thinking', task: 'Dup test' };
      assert.strictEqual(writeJsonWithRetry(statusFile, dupPayload), false);
      assert.strictEqual(renameCallCount, beforeCalls + 1);
      assert.strictEqual(pendingWrites.get(statusFile)?.attempts, 1);

      // 重复提交完全相同的数据 -> 直接返回 false，不触发 renameSync，不重置 attempts
      assert.strictEqual(writeJsonWithRetry(statusFile, dupPayload), false);
      assert.strictEqual(renameCallCount, beforeCalls + 1, 'Duplicate submission must NOT trigger extra write attempt');
      assert.strictEqual(pendingWrites.get(statusFile)?.attempts, 1);

      // 12d: 重试期间产生新数据，且新数据写入成功 -> 旧待写项立即清除
      failNextCount = 0;
      const newerPayload = { type: 'work_status', state: 'success', task: 'Newer data' };
      assert.strictEqual(writeJsonWithRetry(statusFile, newerPayload), true);
      assert.strictEqual(pendingWrites.has(statusFile), false, 'Successful newer write must delete pending entry');
      assert.strictEqual(JSON.parse(fs.readFileSync(statusFile, 'utf8')).task, 'Newer data');

      // 12e: 重试次数耗尽（初次 + 额外 2 次失败）-> 记日志并停止重试，正式文件保持完整 JSON
      failNextCount = 10;
      const exhaustPayload = { type: 'work_status', state: 'working', task: 'Will exhaust' };
      assert.strictEqual(writeJsonWithRetry(statusFile, exhaustPayload), false);
      assert.strictEqual(pendingWrites.get(statusFile)?.attempts, 1);
      flushPendingWrites(Date.now() + 200); // 第 1 次额外重试失败 -> attempts=2
      assert.strictEqual(pendingWrites.get(statusFile)?.attempts, 2);
      flushPendingWrites(Date.now() + 600); // 第 2 次额外重试失败 -> attempts=3 > 2 -> 放弃并删除
      assert.strictEqual(pendingWrites.has(statusFile), false, 'Exhausted item must be removed from pendingWrites');

      const logContent = fs.readFileSync(tmpLogFile, 'utf8');
      assert.ok(logContent.includes('write retry exhausted for runtime-status.json'), 'Must log write retry exhausted');
      assert.ok(!logContent.includes('atomicWriteJson failed for runtime-status.json'), 'Should not spam per-attempt error log during writeJsonWithRetry');
      // 正式文件依然是此前完整的 JSON
      assert.strictEqual(JSON.parse(fs.readFileSync(statusFile, 'utf8')).task, 'Newer data');
    } finally {
      fs.renameSync = origRenameSync;
      pendingWrites.clear();
    }

    console.log('[PASS] Scenario 12: WO-37 写入失败注入 (工作/额度/余额恢复、空闲态不残留、重复提交不加次数、耗尽记录日志)');
  }

  // =========================================================================
  // 场景 13: WO-36 退出脚本 (stop-agent.ps1) 四种状态精准汇报
  // =========================================================================
  {
    const stopTestDir = path.join(tmpRoot, 's13-stop');
    fs.mkdirSync(path.join(stopTestDir, 'runtime'), { recursive: true });
    const stopRunnerPs1 = path.join(stopTestDir, 'verify-wo36.ps1');

    const stopPsContent = `
$ErrorActionPreference = 'Stop'
$stopScriptPath = '${path.join(repoRoot, 'runtime', 'stop-agent.ps1').replace(/'/g, "''")}'
$emptyDir = '${stopTestDir.replace(/'/g, "''")}'

# 13a: 空目录无目标进程（兼容 WMI 正常与 WMI 受限环境，并用打桩额外严格断言"未找到"分支）
$outNone = (& $stopScriptPath -TargetDir $emptyDir *>&1 | Out-String)
if ($outNone -notmatch '未找到运行中的 AgentPet 进程|退出状态无法确认') { throw "13a real script failed: $outNone" }

# 提取 stop-agent.ps1 的优雅关闭辅助函数、兜底扫描与汇总代码段，用 Mock 函数测试全停 / 部分停 / WMI 失败 / 空目标
$rawStop = Get-Content -LiteralPath $stopScriptPath -Raw -Encoding UTF8
$helperIdx = $rawStop.IndexOf('function Stop-ProcessGracefullyThenForce')
$helperEndIdx = $rawStop.IndexOf('function Stop-TargetProcessById')
if ($helperIdx -lt 0 -or $helperEndIdx -lt 0) { throw "Cannot find Stop-ProcessGracefullyThenForce in stop-agent.ps1" }
$helperCode = $rawStop.Substring($helperIdx, $helperEndIdx - $helperIdx)
$scanIdx = $rawStop.IndexOf('# 3. Fallback scan bounded strictly')
if ($scanIdx -lt 0) { throw "Cannot find section 3 in stop-agent.ps1" }
$scanAndSummaryCode = $helperCode + "\r\n" + $rawStop.Substring($scanIdx)

function Run-StopSim($mockProcs, [bool]$stopThrows, [bool]$staysAlive, [bool]$wmiThrows, [int]$preStopped = 0) {
    $baseDir = $emptyDir
    $canonicalScript = "d:\\mock\\agentpet.ps1"
    $canonicalMonitor = "d:\\mock\\runtime\\agent-monitor.mjs"
    $stoppedCount = $preStopped
    $cannotConfirmCount = 0
    $stillRunningCount = 0
    $script:wmiFailed = $false

    function Get-CimInstance {
        if ($wmiThrows) { throw "WMI service access denied" }
        return $mockProcs
    }
    function Stop-Process {
        param($Id, [switch]$Force, $ErrorAction)
        if ($stopThrows) { throw "Access denied to PID $Id" }
    }
    function Get-Process {
        param($Id, $ErrorAction)
        if ($staysAlive) { return @{ Id = $Id } }
        return $null
    }
    function Start-Sleep { param($Milliseconds) }

    $sb = [ScriptBlock]::Create($scanAndSummaryCode)
    return (& $sb *>&1 | Out-String)
}

$outMockEmpty = Run-StopSim @() $false $false $false 0
if ($outMockEmpty -notmatch '未找到运行中的 AgentPet 进程') { throw "13a mock empty failed: $outMockEmpty" }

$fakeProc = [PSCustomObject]@{ ProcessId = 999991; CommandLine = "node.exe d:\\mock\\runtime\\agent-monitor.mjs" }

# 13b: 全部正常停止 -> "AgentPet 已停止 (1 个进程已终止)"
$outAll = Run-StopSim @($fakeProc) $false $false $false 0
if ($outAll -notmatch 'AgentPet 已停止 \\(1 个进程已终止\\)') { throw "13b failed: $outAll" }

# 13c: 部分停止、部分无权限失败 -> "AgentPet 部分进程已停止"
$outPartial = Run-StopSim @($fakeProc) $true $true $false 1
if ($outPartial -notmatch 'AgentPet 部分进程已停止') { throw "13c failed: $outPartial" }

# 13d: 已停 1 个，随后 WMI 枚举失败 -> 不得宣称全部停止，应报 "AgentPet 部分进程已停止"
$outWmiAfterOne = Run-StopSim @() $false $false $true 1
if ($outWmiAfterOne -notmatch 'AgentPet 部分进程已停止') { throw "13d failed: $outWmiAfterOne" }

# 13e: 0 个停止且 WMI 失败 -> "退出状态无法确认"
$outWmiZero = Run-StopSim @() $false $false $true 0
if ($outWmiZero -notmatch '退出状态无法确认') { throw "13e failed: $outWmiZero" }

# 13f: AgentPet.ps1 的 stop.flag 时效性校验（早于启动时刻或非数字超 60 秒均忽略，晚于启动时刻则触发退出）
$ps1Path = '${path.join(repoRoot, 'AgentPet.ps1').replace(/'/g, "''")}'
$rawPs1 = Get-Content -LiteralPath $ps1Path -Raw -Encoding UTF8
$flagIdx = $rawPs1.IndexOf('# 0.0 Check graceful stop flag from stop-agent.ps1')
$wakeIdx = $rawPs1.IndexOf('# 0. Check wake flag from duplicate launch')
if ($flagIdx -lt 0 -or $wakeIdx -lt 0) { throw "Cannot locate stop.flag block in AgentPet.ps1" }
$flagBlock = $rawPs1.Substring($flagIdx, $wakeIdx - $flagIdx)

function Invoke-StopFlagCheck([string]$content, [DateTime]$lastWriteUtc, [long]$appStartMs) {
    $BaseDir = $emptyDir
    $script:AppStartTimeMs = $appStartMs
    $script:exitCalled = $false
    $script:loggedMsg = ""
    $fPath = Join-Path (Join-Path $BaseDir "runtime") "stop.flag"
    [System.IO.File]::WriteAllText($fPath, $content, [System.Text.Encoding]::UTF8)
    (Get-Item $fPath).LastWriteTimeUtc = $lastWriteUtc
    function Write-PetLog([string]$m) { $script:loggedMsg = $m }
    function Request-AgentPetExit { $script:exitCalled = $true }
    $sb = [ScriptBlock]::Create($flagBlock)
    & $sb
    return @{ Exited = $script:exitCalled; Log = $script:loggedMsg; FileExists = (Test-Path $fPath) }
}

$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
# (1) 早于本次启动时刻的时间戳 -> 忽略并清理文件
$rOld = Invoke-StopFlagCheck (($nowMs - 5000).ToString()) ([DateTime]::UtcNow) $nowMs
if ($rOld.Exited -or $rOld.FileExists) { throw "13f old timestamp should be ignored and deleted" }
# (2) 无法解析数字且文件修改时间超过 60 秒 -> 忽略并清理文件
$rBadOld = Invoke-StopFlagCheck "corrupted" ([DateTime]::UtcNow.AddSeconds(-120)) ($nowMs - 200000)
if ($rBadOld.Exited -or $rBadOld.FileExists) { throw "13f non-numeric >60s should be ignored and deleted" }
# (3) 晚于或等于本次启动时刻的新鲜时间戳 -> 正常触发退出并清理文件
$rFresh = Invoke-StopFlagCheck (($nowMs + 100).ToString()) ([DateTime]::UtcNow) $nowMs
if ((-not $rFresh.Exited) -or $rFresh.FileExists) { throw "13f fresh timestamp should trigger Request-AgentPetExit" }

Write-Output "WO36_VERIFIED_OK"
`;
    fs.writeFileSync(stopRunnerPs1, '\uFEFF' + stopPsContent.replace(/\r?\n/g, '\r\n'), 'utf8');
    const stopRes = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopRunnerPs1], {
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(stopRes.status, 0, `WO-36 PS verification failed: ${stopRes.stderr || stopRes.stdout}`);
    assert.ok(stopRes.stdout.includes('WO36_VERIFIED_OK'), `Missing WO36_VERIFIED_OK: ${stopRes.stdout}`);
    console.log('[PASS] Scenario 13: WO-36 退出脚本全停 / 部分停 / WMI 失败 / 无目标 及 stop.flag 时效校验 (13a~13f) 验证通过');
  }

  // =========================================================================
  // 场景 14: AP03 区分进度消息 (commentary) 与最终答复 (final_answer)
  // =========================================================================
  {
    const ap03Dir = path.join(tmpRoot, 's14-ap03');
    const sessionsDir = path.join(ap03Dir, 'codex', 'sessions', '2026', '11', '12');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const makeMon = () => {
      const m = new AgentMonitor({ isProbe: true, stallSeconds: 45 });
      m.paths = { ...m.paths, appDir: ap03Dir, codex: path.join(ap03Dir, 'codex'), dshDirs: [] };
      return m;
    };
    const writeRollout = (name, events, mtime) => {
      const f = path.join(sessionsDir, name);
      fs.writeFileSync(f, events.map(e => JSON.stringify({ timestamp: new Date(mtime).toISOString(), ...e })).join('\n') + '\n', 'utf8');
      fs.utimesSync(f, mtime / 1000, mtime / 1000);
      return f;
    };
    const clearDir = () => {
      for (const f of fs.readdirSync(sessionsDir)) fs.unlinkSync(path.join(sessionsDir, f));
    };

    const tBase = Date.now();

    // 14a: response_item assistant message (phase: commentary, status: completed)
    // 立即 (0s) 与 10s 后均为活动状态 (thinking)，不产生 success/result；190s 过期归空；解析/缓存/新建重读一致
    clearDir();
    writeRollout('rollout-msg-commentary.jsonl', [
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: '正在检查文件' }] } }
    ], tBase);
    const m1 = makeMon();
    const s1_0 = m1.checkCodex(tBase);
    const s1_0_cached = m1.checkCodex(tBase);
    const s1_10 = m1.checkCodex(tBase + 10_000);
    const s1_re = makeMon().checkCodex(tBase + 10_000);
    const s1_190 = m1.checkCodex(tBase + 190_000);
    assert.strictEqual(s1_0?.state, 'thinking', 'assistant commentary at 0s must be thinking');
    assert.strictEqual(s1_0_cached?.state, 'thinking', 'assistant commentary cached at 0s must match');
    assert.strictEqual(s1_10?.state, 'thinking', 'assistant commentary at 10s must remain thinking');
    assert.strictEqual(s1_re?.state, 'thinking', 'assistant commentary re-read on fresh monitor at 10s must match');
    assert.ok(!String(s1_0?.task || '').includes('已完成'), 'commentary task must not say 已完成');
    assert.strictEqual(s1_190, null, 'assistant commentary must expire after 180s window');

    // 14b: event_msg item_completed (item.type: AgentMessage, item.phase: commentary)
    clearDir();
    writeRollout('rollout-item-commentary.jsonl', [
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: '进度汇报' }] } } }
    ], tBase);
    const m2 = makeMon();
    const s2_0 = m2.checkCodex(tBase);
    const s2_10 = m2.checkCodex(tBase + 10_000);
    const s2_re = makeMon().checkCodex(tBase + 10_000);
    const s2_190 = m2.checkCodex(tBase + 190_000);
    assert.strictEqual(s2_0?.state, 'thinking', 'item_completed AgentMessage commentary at 0s must be thinking, not result');
    assert.strictEqual(s2_10?.state, 'thinking', 'item_completed AgentMessage commentary at 10s must be thinking');
    assert.strictEqual(s2_re?.state, 'thinking', 'item_completed AgentMessage commentary fresh monitor re-read must match');
    assert.ok(!String(s2_0?.task || '').includes('已完成'), 'item_completed commentary must not say 已完成');
    assert.strictEqual(s2_190, null, 'item_completed AgentMessage commentary expires after 180s');

    // 14c: 两种形式的 final_answer (completed) -> 0s 为 success，10s 后按 8s 终态规则归空；缓存与重读一致
    for (const [label, evt] of [
      ['response_item final_answer', { type: 'response_item', payload: { type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: '最终答复' }] } }],
      ['item_completed final_answer', { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: '最终答复' }] } } }]
    ]) {
      clearDir();
      writeRollout('rollout-final.jsonl', [evt], tBase);
      const mf = makeMon();
      assert.strictEqual(mf.checkCodex(tBase)?.state, 'success', `${label} at 0s should be success`);
      assert.strictEqual(mf.checkCodex(tBase + 1000)?.state, 'success', `${label} cached at 1s should be success`);
      assert.strictEqual(makeMon().checkCodex(tBase + 1000)?.state, 'success', `${label} fresh monitor at 1s should be success`);
      assert.strictEqual(mf.checkCodex(tBase + 10_000), null, `${label} at 10s (>8s) should be null`);
      assert.strictEqual(makeMon().checkCodex(tBase + 10_000), null, `${label} fresh monitor at 10s should be null`);
    }

    // 14d: status: in_progress (包括 phase: final_answer 正在生成) -> working
    clearDir();
    writeRollout('rollout-inprog.jsonl', [
      { type: 'response_item', payload: { type: 'message', role: 'assistant', status: 'in_progress', phase: 'final_answer', content: [] } }
    ], tBase);
    assert.strictEqual(makeMon().checkCodex(tBase)?.state, 'working', 'in_progress final_answer must remain working');

    // 14e: 两种消息形式缺少 phase 时均不能单独报完成或步骤完成；另有明确结束事件时正常显示完成
    for (const [label, evt] of [
      ['message without phase', { type: 'response_item', payload: { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '无phase消息' }] } }],
      ['item_completed AgentMessage without phase', { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: '无phase消息' }] } } }]
    ]) {
      clearDir();
      writeRollout('rollout-nophase.jsonl', [evt], tBase);
      const mn = makeMon();
      assert.strictEqual(mn.checkCodex(tBase)?.state, 'thinking', `${label} at 0s must be thinking (not success/result)`);
      assert.strictEqual(mn.checkCodex(tBase + 10_000)?.state, 'thinking', `${label} at 10s must be thinking`);

      clearDir();
      writeRollout('rollout-nophase-done.jsonl', [
        evt,
        { type: 'event_msg', payload: { type: 'task_complete' } }
      ], tBase);
      assert.strictEqual(makeMon().checkCodex(tBase)?.state, 'success', `${label} followed by explicit task_complete must show success`);
    }

    // 14f: 其他非 AgentMessage 的 item_completed (如 command) 仍保留 result -> thinking
    clearDir();
    writeRollout('rollout-tool-item.jsonl', [
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: 'npm test' } } }
    ], tBase);
    const mt = makeMon();
    assert.strictEqual(mt.checkCodex(tBase)?.state, 'result', 'non-AgentMessage item_completed at 0s is result');
    assert.strictEqual(mt.checkCodex(tBase + 10_000)?.state, 'thinking', 'non-AgentMessage item_completed at 10s transitions to thinking');

    console.log('[PASS] Scenario 14: AP03 进度消息 (commentary/缺phase) 与最终答复 (final_answer) 双路径精确区分');
  }

  // =========================================================================
  // 场景 15: AP06 恢复离线额度历史查询七天窗口（不影响普通工作 180s 窗口与快速轮询免 stat）
  // =========================================================================
  {
    const ap06Dir = path.join(tmpRoot, 's15-ap06');
    const now0 = Date.now();

    const testQuotaAtAge = (ageMs, cacheMode = 'none') => {
      const subDir = path.join(ap06Dir, `age-${ageMs}-${cacheMode}`);
      const sessDir = path.join(subDir, 'codex', 'sessions', '2026', '11', '05');
      fs.mkdirSync(sessDir, { recursive: true });
      const f = path.join(sessDir, 'rollout-quota.jsonl');
      const evtTime = now0 - ageMs;
      const line = JSON.stringify({
        timestamp: new Date(evtTime).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 37, window_minutes: 300, resets_at: Math.floor(now0 / 1000) + 3600 }
          }
        }
      }) + '\n';
      fs.writeFileSync(f, line, 'utf8');
      fs.utimesSync(f, evtTime / 1000, evtTime / 1000);

      const emissions = [];
      const m = new AgentMonitor({ isProbe: true, onChange: v => emissions.push(v) });
      m.paths = { ...m.paths, appDir: subDir, codex: path.join(subDir, 'codex'), dshDirs: [] };

      if (cacheMode === 'normal') {
        m.codexStateCache.set(f, { mtime: evtTime, size: Buffer.byteLength(line), state: { source: 'Codex', state: 'thinking', task: 'old', at: evtTime } });
      } else if (cacheMode === 'waiting') {
        m.codexStateCache.set(f, { mtime: evtTime, size: Buffer.byteLength(line), state: { source: 'Codex', state: 'waiting', task: 'wait', at: evtTime, inFlight: true } });
      }

      // 首次全量扫描 + emitFallbackQuota
      m.emitFallbackQuota();
      const firstCount = emissions.length;

      // 5 秒内缓存路径：统计是否对历史文件重复 fs.statSync
      const origStat = fs.statSync;
      let fastStats = 0;
      try {
        fs.statSync = (target, ...rest) => {
          if (String(target) === f) fastStats++;
          return origStat(target, ...rest);
        };
        const fastCands = m.findCodexRollouts(now0 + 100, 7 * 86400_000);
        m.emitFallbackQuota();
        return { firstCount, secondCount: emissions.length - firstCount, fastCands: fastCands.length, fastStats, lastEmission: emissions[emissions.length - 1], m, f, evtTime };
      } finally {
        fs.statSync = origStat;
      }
    };

    // 15a: 1 分钟前、1 小时前（无缓存 / 普通状态缓存 / 等待状态缓存）、6 天前均正常产出；8 天前（超 7 天）不产出
    const r1m = testQuotaAtAge(60_000, 'none');
    assert.strictEqual(r1m.firstCount, 1, '1m old quota should emit on full scan');
    assert.strictEqual(r1m.secondCount, 1, '1m old quota should emit on fast scan');

    for (const mode of ['none', 'normal', 'waiting']) {
      const r1h = testQuotaAtAge(3600_000, mode);
      assert.strictEqual(r1h.firstCount, 1, `1h old quota (${mode} cache) must emit on full scan`);
      assert.strictEqual(r1h.secondCount, 1, `1h old quota (${mode} cache) must emit on 5s cached path`);
      assert.strictEqual(r1h.fastStats, 0, `1h old file (${mode} cache) must NOT be re-stat'd on fast poll`);
      assert.strictEqual(r1h.lastEmission.planLabel, '离线快照');
      assert.strictEqual(r1h.lastEmission.observedAt, Math.round(r1h.evtTime), 'observedAt must match fixture mtime, not current time');
      assert.strictEqual(r1h.lastEmission.windows[0].usedPercent, 37);
      assert.strictEqual(r1h.lastEmission.windows[0].remainingPercent, 63);
      // 1 小时前的普通工作扫描仍为空闲
      assert.strictEqual(r1h.m.checkCodex(now0 + 200), null, '1h old session must remain idle for normal work scan');
    }

    const r6d = testQuotaAtAge(6 * 86400_000, 'none');
    assert.strictEqual(r6d.firstCount, 1, '6d old quota must emit');
    assert.strictEqual(r6d.secondCount, 1, '6d old quota must emit on fast path');
    assert.strictEqual(r6d.fastStats, 0, '6d old file must NOT be re-stat on fast poll');

    const r8d = testQuotaAtAge(8 * 86400_000, 'none');
    assert.strictEqual(r8d.firstCount, 0, '8d old quota (>7d) must NOT emit');
    assert.strictEqual(r8d.secondCount, 0, '8d old quota (>7d) must NOT emit on fast path');

    // 15b: 5 秒全量发现到期后，恢复活动的旧会话可被重新发现
    const reactivated = r1m.m;
    const reactivatedTime = now0 + 6000;
    const workLine = JSON.stringify({
      timestamp: new Date(reactivatedTime).toISOString(),
      type: 'response_item',
      payload: { type: 'reasoning', summary: [] }
    }) + '\n';
    fs.appendFileSync(r1m.f, workLine, 'utf8');
    fs.utimesSync(r1m.f, reactivatedTime / 1000, reactivatedTime / 1000);
    assert.strictEqual(reactivated.checkCodex(reactivatedTime)?.state, 'thinking', '5s full walk must rediscover reactivated session');

    console.log('[PASS] Scenario 15: AP06 离线额度 1m/1h/6d 回退恢复、>7d 过滤、快速轮询免 stat 与 5s 重发现验证通过');
  }

  // =========================================================================
  // 场景 16: AP05 如实显示余额刷新超时（调用真实 AgentPet.ps1 函数与计时器代码块）
  // =========================================================================
  {
    const ap05Dir = path.join(tmpRoot, 's16-ap05');
    fs.mkdirSync(ap05Dir, { recursive: true });
    const runnerAp05 = path.join(ap05Dir, 'verify-ap05.ps1');

    const ap05PsLines = [
      "Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase",
      "$ErrorActionPreference = 'Stop'",
      "$src = Get-Content -LiteralPath '" + path.join(repoRoot, 'AgentPet.ps1').replace(/'/g, "''") + "' -Raw -Encoding UTF8",
      "$startIdx = $src.IndexOf('$script:lastBalanceMtime   = [DateTime]::MinValue')",
      "$endMarker = '# ============================================================================' + [char]13 + [char]10 + '# 10. Q-Bounce'",
      "$endIdx = $src.IndexOf($endMarker)",
      "if ($startIdx -lt 0 -or $endIdx -lt 0) { throw 'Cannot locate Section 9.5' }",
      "$sec95 = $src.Substring($startIdx, $endIdx - $startIdx)",
      "$pollStart = $src.IndexOf('# 3. Watch runtime-balance.json file modification')",
      "$pollEnd = $src.IndexOf('# 2. Watch runtime-status.json file modification')",
      "$pollBlock = $src.Substring($pollStart, $pollEnd - $pollStart)",
      "$tStart = $src.IndexOf('# 0.5 Safety revert for balance refresh notice')",
      "$tEnd = $src.IndexOf('# 1. Poll agent-monitor.mjs stdout', $tStart)",
      "if ($tStart -lt 0 -or $tEnd -lt 0) { throw 'Cannot locate section 0.5 timeout block' }",
      "$timeoutBlock = $src.Substring($tStart, $tEnd - $tStart)",
      "$RuntimeBalancePath = '" + path.join(ap05Dir, 'runtime-balance.json').replace(/'/g, "''") + "'",
      "$RefreshBalanceFlagPath = '" + path.join(ap05Dir, 'refresh-balance.flag').replace(/'/g, "''") + "'",
      "$Config = @{ DeepSeekBalanceEnabled = $true; LowBalanceCnyThreshold = 5.0; LowBalanceAlertEnabled = $true }",
      "$script:AgentIcons = @{}",
      "$script:manualBubbleHidden = $false",
      "$script:agentBusy = $false",
      "$script:userInspectUntil = [DateTime]::MinValue",
      "function Make-MockCtrl { New-Object PSObject -Property @{ Text = ''; Visibility = [System.Windows.Visibility]::Collapsed; Source = $null; ToolTip = $null } }",
      "$DeepSeekPanel = Make-MockCtrl",
      "$DeepSeekIcon = Make-MockCtrl",
      "$DeepSeekOkPanel = Make-MockCtrl",
      "$DeepSeekMsgPanel = Make-MockCtrl",
      "$DeepSeekBadge = Make-MockCtrl",
      "$DeepSeekBadgeText = Make-MockCtrl",
      "$DeepSeekStatusNotice = Make-MockCtrl",
      "$DeepSeekMsgTitle = Make-MockCtrl",
      "$DeepSeekMsgDetail = Make-MockCtrl",
      "$DeepSeekCurrencyLabel = Make-MockCtrl",
      "$DeepSeekTotalText = Make-MockCtrl",
      "$DeepSeekBreakdownText = Make-MockCtrl",
      "$DeepSeekAvailableNotice = Make-MockCtrl",
      "function Play-ReleaseSound {}",
      "function Set-ActiveBubblePanel([string]$p) {}",
      "function Show-Bubble([double]$sec) {}",
      "function Log-Throttled([string]$k, [string]$m) {}",
      "Invoke-Expression $sec95",
      "$pollFn = [ScriptBlock]::Create($pollBlock)",
      "$timeoutFn = [ScriptBlock]::Create($timeoutBlock)",
      "function Write-BalanceSnap($obj, [DateTime]$mtimeUtc) {",
      "    $json = $obj | ConvertTo-Json -Depth 6",
      "    [IO.File]::WriteAllText($RuntimeBalancePath, $json, [Text.Encoding]::UTF8)",
      "    (Get-Item $RuntimeBalancePath).LastWriteTimeUtc = $mtimeUtc",
      "}",
      "$oldSyncMs = 1793500000000",
      "$expectedOldTimeStr = ([DateTimeOffset]::FromUnixTimeMilliseconds($oldSyncMs).ToLocalTime()).ToString('HH:mm')",
      "Write-BalanceSnap @{",
      "    type = 'balance'; provider = 'deepseek'; credentialSource = 'dsh'; status = 'ok';",
      "    isAvailable = $true; updatedAt = $oldSyncMs; fetchedAt = $oldSyncMs; lastAttemptAt = $oldSyncMs;",
      "    balances = @(@{ currency = 'CNY'; totalBalance = '18.50'; toppedUpBalance = '10.00'; grantedBalance = '8.50' })",
      "} ([DateTime]::UtcNow.AddMinutes(-10))",
      "& $pollFn",
      "if ($DeepSeekTotalText.Text -ne '¥ 18.50') { throw ('Initial amount mismatch: ' + $DeepSeekTotalText.Text) }",
      "# (1) 无结果超时 15 秒：显示 刷新超时，点击 ↻ 重试，绝不出现 已是最新，旧金额与上次快照时间可辨认",
      "$script:lastBalanceRefreshRequestTime = [DateTime]::UtcNow.AddSeconds(-20)",
      "Request-BalanceRefresh",
      "$req1Ms = $script:balanceRequestStartedMs",
      "if ($DeepSeekStatusNotice.Text -ne '刷新中...') { throw ('Expected 刷新中..., got ' + $DeepSeekStatusNotice.Text) }",
      "$now = $script:balanceRequestTimeout.AddSeconds(1)",
      "& $timeoutFn",
      "if ($DeepSeekStatusNotice.Text -ne '刷新超时，点击 ↻ 重试') { throw ('Expected 刷新超时，点击 ↻ 重试, got ' + $DeepSeekStatusNotice.Text) }",
      "if ($DeepSeekStatusNotice.Text -match '已是最新') { throw 'Must never display 已是最新 on timeout' }",
      "if ($DeepSeekTotalText.Text -ne '¥ 18.50') { throw 'Old amount must be preserved on timeout' }",
      "if ($DeepSeekCurrencyLabel.Text -notmatch ('上次快照（' + $expectedOldTimeStr + '）')) { throw ('Currency label must mark old snapshot time, got: ' + $DeepSeekCurrencyLabel.Text) }",
      "if ($DeepSeekStatusNotice.ToolTip -notmatch ('上次快照（同步于 ' + $expectedOldTimeStr + '）')) { throw ('Tooltip must mark old snapshot time, got: ' + $DeepSeekStatusNotice.ToolTip) }",
      "# (1b) 超时后到达不属于本次请求的旧成功结果：超时提示和快照语义保留；不能显示本次已更新；本次请求归属标记保留",
      "$unownedOldSyncMs = $req1Ms - 11000",
      "$unownedOldTimeStr = ([DateTimeOffset]::FromUnixTimeMilliseconds($unownedOldSyncMs).ToLocalTime()).ToString('HH:mm')",
      "Write-BalanceSnap @{",
      "    type = 'balance'; provider = 'deepseek'; credentialSource = 'dsh'; status = 'ok';",
      "    isAvailable = $true; updatedAt = $unownedOldSyncMs; fetchedAt = $unownedOldSyncMs; lastAttemptAt = $unownedOldSyncMs;",
      "    balances = @(@{ currency = 'CNY'; totalBalance = '29.00'; toppedUpBalance = '29.00'; grantedBalance = '0.00' })",
      "} ([DateTime]::UtcNow.AddSeconds(1))",
      "& $pollFn",
      "if ($DeepSeekStatusNotice.Text -ne '刷新超时，点击 ↻ 重试') { throw ('After timeout, unowned old result must preserve timeout notice, got: ' + $DeepSeekStatusNotice.Text) }",
      "if ($DeepSeekStatusNotice.Text -match '更新') { throw 'After timeout, unowned old result must NOT display updated notice' }",
      "if ($DeepSeekCurrencyLabel.Text -notmatch ('上次快照（' + $unownedOldTimeStr + '）')) { throw ('After timeout, unowned old result must keep snapshot label, got: ' + $DeepSeekCurrencyLabel.Text) }",
      "if ($DeepSeekStatusNotice.ToolTip -notmatch ('上次快照（同步于 ' + $unownedOldTimeStr + '）')) { throw ('After timeout, unowned old result must keep timeout tooltip, got: ' + $DeepSeekStatusNotice.ToolTip) }",
      "if ($script:balanceRequestStartedMs -ne $req1Ms) { throw ('After timeout, unowned old result must preserve balanceRequestStartedMs, got: ' + $script:balanceRequestStartedMs) }",
      "# (1c) 超时后到达 loading 中间态（含空余额与带旧余额但伪造新时间）：不撤销超时语义，不当作本次完成，保留的旧金额不能冒充新金额",
      "Write-BalanceSnap @{",
      "    type = 'balance'; provider = 'deepseek'; credentialSource = 'dsh'; status = 'loading';",
      "    isAvailable = $null; updatedAt = $req1Ms + 3000; lastAttemptAt = $req1Ms + 100; balances = @()",
      "} ([DateTime]::UtcNow.AddSeconds(1.5))",
      "& $pollFn",
      "if ($DeepSeekStatusNotice.Text -ne '刷新超时，点击 ↻ 重试') { throw ('After timeout, loading state must NOT revoke timeout notice, got: ' + $DeepSeekStatusNotice.Text) }",
      "if ($DeepSeekOkPanel.Visibility -ne [System.Windows.Visibility]::Visible -or $DeepSeekTotalText.Text -ne '¥ 29.00') { throw 'After timeout, empty loading state must NOT hide preserved old amount' }",
      "if ($DeepSeekCurrencyLabel.Text -notmatch ('上次快照（' + $unownedOldTimeStr + '）')) { throw 'After timeout, loading state must NOT alter old snapshot time label' }",
      "if ($script:balanceRequestStartedMs -ne $req1Ms) { throw 'After timeout, loading state must NOT clear balanceRequestStartedMs' }",
      "# (2) 超时后到达属于本次请求的有效成功结果：正常显示新金额和真实时间，解除超时及旧快照标识，清除本次请求标记",
      "$lateSyncMs = $script:balanceRequestStartedMs + 5000",
      "$expectedLateTimeStr = ([DateTimeOffset]::FromUnixTimeMilliseconds($lateSyncMs).ToLocalTime()).ToString('HH:mm')",
      "Write-BalanceSnap @{",
      "    type = 'balance'; provider = 'deepseek'; credentialSource = 'dsh'; status = 'ok';",
      "    isAvailable = $true; updatedAt = $lateSyncMs; fetchedAt = $lateSyncMs; lastAttemptAt = $script:balanceRequestStartedMs + 100;",
      "    balances = @(@{ currency = 'CNY'; totalBalance = '25.00'; toppedUpBalance = '25.00'; grantedBalance = '0.00' })",
      "} ([DateTime]::UtcNow.AddSeconds(2))",
      "& $pollFn",
      "if ($DeepSeekTotalText.Text -ne '¥ 25.00') { throw ('Late valid result after timeout must update amount, got ' + $DeepSeekTotalText.Text) }",
      "if ($DeepSeekStatusNotice.Text -ne ($expectedLateTimeStr + ' 更新')) { throw ('Late valid result must update time notice, got ' + $DeepSeekStatusNotice.Text) }",
      "if ($DeepSeekCurrencyLabel.Text -ne '人民币 CNY · DSH 宿主') { throw 'Late valid result must restore normal currency label' }",
      "if ($null -ne $DeepSeekStatusNotice.ToolTip) { throw 'Late valid result must clear timeout tooltip' }",
      "if ($script:balanceRequestStartedMs -ne 0) { throw 'balanceRequestStartedMs must be cleared after owned result arrives' }",
      "# (3) 期限内得到本次结果：及时显示，经过原截止时间也不被超时提示覆盖",
      "$script:lastBalanceRefreshRequestTime = [DateTime]::UtcNow.AddSeconds(-20)",
      "Request-BalanceRefresh",
      "$origDeadline = $script:balanceRequestTimeout",
      "$inTimeSyncMs = $script:balanceRequestStartedMs + 1000",
      "$expectedInTimeStr = ([DateTimeOffset]::FromUnixTimeMilliseconds($inTimeSyncMs).ToLocalTime()).ToString('HH:mm')",
      "Write-BalanceSnap @{",
      "    type = 'balance'; provider = 'deepseek'; credentialSource = 'dsh'; status = 'ok';",
      "    isAvailable = $true; updatedAt = $inTimeSyncMs; fetchedAt = $inTimeSyncMs; lastAttemptAt = $script:balanceRequestStartedMs + 50;",
      "    balances = @(@{ currency = 'CNY'; totalBalance = '30.00'; toppedUpBalance = '30.00'; grantedBalance = '0.00' })",
      "} ([DateTime]::UtcNow.AddSeconds(4))",
      "& $pollFn",
      "if ($DeepSeekStatusNotice.Text -ne ($expectedInTimeStr + ' 更新')) { throw 'In-time result must show updated time immediately' }",
      "if ($null -ne $script:balanceRequestTimeout) { throw 'balanceRequestTimeout must be cleared on owned result' }",
      "$now = $origDeadline.AddSeconds(5)",
      "& $timeoutFn",
      "if ($DeepSeekStatusNotice.Text -ne ($expectedInTimeStr + ' 更新')) { throw 'Passed original deadline must NOT overwrite in-time result with timeout' }",
      "# (4) 先后两次刷新：第一次旧结果或 loading 中间态在第二次等待期间到达（不取消计时），且第二次超时后收到第一次结果仍保留第二次超时状态",
      "$script:lastBalanceRefreshRequestTime = [DateTime]::UtcNow.AddSeconds(-11)",
      "Request-BalanceRefresh",
      "$secondReqMs = $script:balanceRequestStartedMs",
      "$firstReqMs = $secondReqMs - 11000",
      "Write-BalanceSnap @{",
      "    type = 'balance'; provider = 'deepseek'; credentialSource = 'dsh'; status = 'ok';",
      "    isAvailable = $true; updatedAt = $firstReqMs + 500; fetchedAt = $firstReqMs + 500; lastAttemptAt = $firstReqMs + 200;",
      "    balances = @(@{ currency = 'CNY'; totalBalance = '29.00'; toppedUpBalance = '29.00'; grantedBalance = '0.00' })",
      "} ([DateTime]::UtcNow.AddSeconds(6))",
      "& $pollFn",
      "if ($null -eq $script:balanceRequestTimeout) { throw 'Stale result from 1st request must NOT cancel 2nd request timeout' }",
      "if ($DeepSeekStatusNotice.Text -ne '刷新中...') { throw ('Stale result from 1st request must keep 刷新中... notice, got ' + $DeepSeekStatusNotice.Text) }",
      "Write-BalanceSnap @{",
      "    type = 'balance'; provider = 'deepseek'; credentialSource = 'dsh'; status = 'loading';",
      "    isAvailable = $null; lastAttemptAt = $secondReqMs + 10; balances = @()",
      "} ([DateTime]::UtcNow.AddSeconds(8))",
      "& $pollFn",
      "if ($null -eq $script:balanceRequestTimeout) { throw 'Intermediate loading state must NOT cancel 2nd request timeout' }",
      "if ($DeepSeekStatusNotice.Text -ne '刷新中...') { throw 'Intermediate loading must keep 刷新中...' }",
      "# 第二次请求已超时，随后再次收到第一次请求的结果：保留第二次超时状态，第一次结果不能完成第二次请求",
      "$now = $script:balanceRequestTimeout.AddSeconds(1)",
      "& $timeoutFn",
      "if ($DeepSeekStatusNotice.Text -ne '刷新超时，点击 ↻ 重试') { throw '2nd request should enter timeout state' }",
      "Write-BalanceSnap @{",
      "    type = 'balance'; provider = 'deepseek'; credentialSource = 'dsh'; status = 'ok';",
      "    isAvailable = $true; updatedAt = $firstReqMs + 800; fetchedAt = $firstReqMs + 800; lastAttemptAt = $firstReqMs + 800;",
      "    balances = @(@{ currency = 'CNY'; totalBalance = '28.00'; toppedUpBalance = '28.00'; grantedBalance = '0.00' })",
      "} ([DateTime]::UtcNow.AddSeconds(9))",
      "& $pollFn",
      "if ($DeepSeekStatusNotice.Text -ne '刷新超时，点击 ↻ 重试') { throw 'After 2nd request timeout, 1st request result must NOT clear 2nd timeout notice' }",
      "if ($DeepSeekCurrencyLabel.Text -notmatch '上次快照') { throw 'After 2nd request timeout, 1st request result must keep snapshot label' }",
      "if ($script:balanceRequestStartedMs -ne $secondReqMs) { throw '1st request result must NOT complete 2nd request' }",
      "# (5) 本次有效失败或停用结果到达：显示对应状态并结束等待，不能显示更新成功",
      "Write-BalanceSnap @{",
      "    type = 'balance'; provider = 'deepseek'; credentialSource = 'dsh'; status = 'error';",
      "    isAvailable = $false; lastAttemptAt = $secondReqMs + 50; balances = @(); errorCode = 'DSH_HTTP_500'; errorMessage = '上游服务错误'",
      "} ([DateTime]::UtcNow.AddSeconds(9.5))",
      "& $pollFn",
      "if ($DeepSeekStatusNotice.Text -ne '查询失败') { throw ('Owned error result must show 查询失败, got ' + $DeepSeekStatusNotice.Text) }",
      "if ($DeepSeekStatusNotice.Text -match '更新$') { throw 'Owned error result must NOT show 更新成功' }",
      "if ($script:balanceRequestStartedMs -ne 0) { throw 'Owned error result must end current request' }",
      "$script:lastBalanceRefreshRequestTime = [DateTime]::UtcNow.AddSeconds(-20)",
      "Request-BalanceRefresh",
      "$thirdReqMs = $script:balanceRequestStartedMs",
      "Write-BalanceSnap @{",
      "    type = 'balance'; provider = 'unknown'; credentialSource = 'dsh'; status = 'dsh_disabled';",
      "    isAvailable = $false; lastAttemptAt = $thirdReqMs + 100; balances = @(); errorCode = 'BALANCE_DISABLED'",
      "} ([DateTime]::UtcNow.AddSeconds(10))",
      "& $pollFn",
      "if ($DeepSeekStatusNotice.Text -ne '已停用') { throw ('Disabled result must show 已停用, got ' + $DeepSeekStatusNotice.Text) }",
      "if ($null -ne $script:balanceRequestTimeout -or $script:balanceRequestStartedMs -ne 0) { throw 'Disabled terminal result must clear timeout and request start' }",
      "# (6) 冷却期内重复点击显示冷却中且不开启新超时；没有手动请求时的正常后台更新继续可用",
      "Request-BalanceRefresh",
      "if ($DeepSeekStatusNotice.Text -notmatch '^冷却中 \\(\\d+s\\)$') { throw ('Cooldown click should show 冷却中 (Ns), got ' + $DeepSeekStatusNotice.Text) }",
      "if ($null -ne $script:balanceRequestTimeout -or $script:balanceRequestStartedMs -ne 0) { throw 'Cooldown click must not set balanceRequestTimeout or balanceRequestStartedMs' }",
      "$bgSyncMs = $thirdReqMs + 20000",
      "$expectedBgTimeStr = ([DateTimeOffset]::FromUnixTimeMilliseconds($bgSyncMs).ToLocalTime()).ToString('HH:mm')",
      "Write-BalanceSnap @{",
      "    type = 'balance'; provider = 'deepseek'; credentialSource = 'dsh'; status = 'ok';",
      "    isAvailable = $true; updatedAt = $bgSyncMs; fetchedAt = $bgSyncMs; lastAttemptAt = $bgSyncMs;",
      "    balances = @(@{ currency = 'CNY'; totalBalance = '42.00'; toppedUpBalance = '40.00'; grantedBalance = '2.00' })",
      "} ([DateTime]::UtcNow.AddSeconds(12))",
      "& $pollFn",
      "if ($DeepSeekTotalText.Text -ne '¥ 42.00' -or $DeepSeekStatusNotice.Text -ne ($expectedBgTimeStr + ' 更新') -or $DeepSeekCurrencyLabel.Text -ne '人民币 CNY · DSH 宿主') { throw 'Background balance update without manual request must work normally' }",
      "Write-Output 'AP05_VERIFIED_OK'"
    ];
    fs.writeFileSync(runnerAp05, '\uFEFF' + ap05PsLines.join('\r\n'), 'utf8');
    const ap05Res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runnerAp05], {
      encoding: 'utf8',
      timeout: 15000
    });
    assert.ifError(ap05Res.error);
    assert.strictEqual(ap05Res.signal, null);
    assert.strictEqual(ap05Res.status, 0, `AP05 PS verification failed: ${ap05Res.stderr || ap05Res.stdout}`);
    assert.ok(ap05Res.stdout.includes('AP05_VERIFIED_OK'), `Missing AP05_VERIFIED_OK: ${ap05Res.stdout}`);
    console.log('[PASS] Scenario 16: AP05 余额刷新 15s 超时如实展示、旧金额快照标识、请求归属校验与冷却联动验证通过');
  }

  // =========================================================================
  // 场景 17: AP01 收紧退出进程匹配（全矩阵命令行解析 + 持续存活临时诱饵进程实测）
  // =========================================================================
  {
    const ap01Dir = path.join(tmpRoot, 's17-ap01');
    fs.mkdirSync(path.join(ap01Dir, 'runtime'), { recursive: true });
    const decoyScript = path.join(ap01Dir, 'decoy-hold.mjs');
    fs.writeFileSync(decoyScript, 'setInterval(() => {}, 1000);\n', 'utf8');

    // 启动一个真正持续运行的临时诱饵进程：执行 decoy-hold.mjs，但把目标路径作为附加参数传入
    const targetAppPath = path.join(ap01Dir, 'AgentPet.ps1');
    const targetMonPath = path.join(ap01Dir, 'runtime', 'agent-monitor.mjs');
    const decoyChild = spawn(process.execPath, [decoyScript, targetAppPath, targetMonPath], {
      windowsHide: true,
      stdio: 'ignore'
    });
    await new Promise((resolve, reject) => {
      decoyChild.once('spawn', resolve);
      decoyChild.once('error', reject);
    });

    try {
      const runnerAp01 = path.join(ap01Dir, 'verify-ap01.ps1');
      const ap01PsLines = [
        "$ErrorActionPreference = 'Stop'",
        "$stopScript = '" + path.join(repoRoot, 'runtime', 'stop-agent.ps1').replace(/'/g, "''") + "'",
        "$projDir = '" + ap01Dir.replace(/'/g, "''") + "'",
        "$decoyPid = " + String(decoyChild.pid),
        "$q = [char]34",
        ". $stopScript -TargetDir $projDir -LibraryOnly",
        "$expApp = Join-Path $projDir 'AgentPet.ps1'",
        "$expMon = Join-Path (Join-Path $projDir 'runtime') 'agent-monitor.mjs'",
        "function Test-Identity([string]$cmd, [string]$exe = '', [string]$app = $expApp, [string]$mon = $expMon) {",
        "    $p = [PSCustomObject]@{ CommandLine = $cmd; ExecutablePath = $exe }",
        "    return (Resolve-AgentPetProcessIdentity $p $app $mon)",
        "}",
        "# 1) 正常 PowerShell 主程序与正常 Node 监控器",
        "if ((Test-Identity ('powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File ' + $q + $expApp + $q)) -ne 'App') { throw '1a normal App failed' }",
        "if ((Test-Identity ('node.exe ' + $q + $expMon + $q + ' --parent-pid 1234 --stall-seconds 45')) -ne 'Monitor') { throw '1b normal Monitor failed' }",
        "# 2) 项目目录含空格、中文；大小写及斜杠有合法差异 -> 仍能识别同一实际入口",
        "$cnDir = 'D:\\测试 目录\\AgentPet 项目'",
        "$cnApp = $cnDir + '\\AgentPet.ps1'",
        "$cnMon = $cnDir + '\\runtime\\agent-monitor.mjs'",
        "$cnAppVariant = 'd:/测试 目录/agentpet 项目/./runtime/../AGENTPET.PS1'",
        "$cnMonVariant = 'D:/测试 目录/AgentPet 项目/runtime/./agent-monitor.mjs'",
        "if ((Test-Identity ('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File ' + $q + $cnAppVariant + $q) '' $cnApp $cnMon) -ne 'App') { throw '2a Chinese/space/slash App failed' }",
        "if ((Test-Identity ($q + 'C:\\Program Files\\nodejs\\node.exe' + $q + ' ' + $q + $cnMonVariant + $q + ' --parent-pid 99') '' $cnApp $cnMon) -ne 'Monitor') { throw '2b Chinese/space/slash Monitor failed' }",
        "# 3) PowerShell 用 -Command / -EncodedCommand 读取目标文件 -> Mismatch",
        "if ((Test-Identity ('powershell.exe -NoProfile -Command ' + $q + 'Get-Content ' + $expApp + $q)) -ne 'Mismatch') { throw '3a -Command should be Mismatch' }",
        "if ((Test-Identity ('powershell.exe -EncodedCommand ZABpAHIA ' + $q + $expApp + $q)) -ne 'Mismatch') { throw '3b -EncodedCommand should be Mismatch' }",
        "# 4) 编辑器打开目标文件；其他 Node 脚本把目标路径作为参数 -> Mismatch",
        "if ((Test-Identity ($q + 'C:\\Program Files\\Microsoft VS Code\\Code.exe' + $q + ' ' + $q + $expApp + $q) 'C:\\Program Files\\Microsoft VS Code\\Code.exe') -ne 'Mismatch') { throw '4a editor should be Mismatch' }",
        "if ((Test-Identity ('node.exe ' + $q + 'D:\\other\\runner.mjs' + $q + ' ' + $q + $expMon + $q + ' ' + $q + $expApp + $q)) -ne 'Mismatch') { throw '4b other node script with target arg should be Mismatch' }",
        "# 5) node --title <监控脚本路径> <其他脚本> -> 不把选项值当入口，不选为停止对象",
        "$titleRes = Test-Identity ('node.exe --title ' + $q + $expMon + $q + ' D:\\other\\worker.mjs')",
        "if ($titleRes -eq 'Monitor' -or $titleRes -eq 'App') { throw ('5 --title option value must NOT match Monitor/App, got ' + $titleRes) }",
        "# 6) Node -e 或 --eval 字符串中含目标路径 -> Mismatch",
        "if ((Test-Identity ('node.exe -e ' + $q + 'console.log(1)' + $q + ' ' + $q + $expMon + $q)) -ne 'Mismatch') { throw '6a node -e must be Mismatch' }",
        "if ((Test-Identity ('node.exe --eval ' + $q + $expMon + $q)) -ne 'Mismatch') { throw '6b node --eval must be Mismatch' }",
        "# 7) 相似目录、其他项目、AgentPet.ps1.bak -> Mismatch",
        "if ((Test-Identity ('powershell.exe -File ' + $q + $projDir + '2\\AgentPet.ps1' + $q)) -ne 'Mismatch') { throw '7a similar dir must be Mismatch' }",
        "if ((Test-Identity ('powershell.exe -File ' + $q + 'D:\\other\\AgentPet.ps1' + $q)) -ne 'Mismatch') { throw '7b other project must be Mismatch' }",
        "if ((Test-Identity ('powershell.exe -File ' + $q + $expApp + '.bak' + $q)) -ne 'Mismatch') { throw '7c .bak suffix must be Mismatch' }",
        "# 8) 相对脚本路径且目标进程工作目录未知 -> Unknown（无法确认，不停止）",
        "if ((Test-Identity 'powershell.exe -NoProfile -File .\\AgentPet.ps1') -ne 'Unknown') { throw '8a relative ps1 must be Unknown' }",
        "if ((Test-Identity 'node.exe runtime\\agent-monitor.mjs --parent-pid 1') -ne 'Unknown') { throw '8b relative monitor must be Unknown' }",
        "# 9) 真实持续运行的临时诱饵进程验证（覆盖 PID 路径与真实 stop-agent.ps1 完整执行）",
        "$script:terminatedPids = @()",
        "function Stop-ProcessGracefullyThenForce([int]$targetPid, [bool]$isAppProcess = $false) {",
        "    $script:terminatedPids += $targetPid",
        "    return $true",
        "}",
        "$fakeAppPidFile = Join-Path (Join-Path $projDir 'runtime') 'app.pid'",
        "[IO.File]::WriteAllText($fakeAppPidFile, (@{ pid = $decoyPid; path = $expApp; baseDir = $projDir } | ConvertTo-Json -Compress), [Text.Encoding]::UTF8)",
        "$pidRes = Stop-TargetProcessById $decoyPid 'App' $fakeAppPidFile",
        "if ($pidRes -ne 'PathMismatch') { throw ('9a expected PathMismatch for live decoy PID, got ' + $pidRes) }",
        "if ($script:terminatedPids.Count -ne 0) { throw '9a decoy must NOT be selected for termination' }",
        "if (-not (Test-Path $fakeAppPidFile)) { throw '9a app.pid must be preserved on PathMismatch' }",
        "# 9b: 相对路径进程模拟喂给 Stop-TargetProcessById -> CannotConfirm，保留 PID 文件",
        "function Get-CimInstance {",
        "    param($ClassName, $Filter, $ErrorAction)",
        "    return [PSCustomObject]@{ ProcessId = $decoyPid; CommandLine = 'powershell.exe -NoProfile -File .\\AgentPet.ps1'; ExecutablePath = 'powershell.exe' }",
        "}",
        "$relRes = Stop-TargetProcessById $decoyPid 'App' $fakeAppPidFile",
        "if ($relRes -ne 'CannotConfirm') { throw ('9b relative path in PID check must return CannotConfirm, got ' + $relRes) }",
        "if ($script:terminatedPids.Count -ne 0) { throw '9b CannotConfirm must NOT terminate process' }",
        "if (-not (Test-Path $fakeAppPidFile)) { throw '9b app.pid must be preserved on CannotConfirm' }",
        "Remove-Item Function:\\Get-CimInstance -ErrorAction SilentlyContinue",
        "# 9c: 直接对含诱饵 PID 的目录执行真实完整 stop-agent.ps1 子进程（含 PID 检查与兜底扫描），确认诱饵进程依然存活且 PID 文件保留",
        "$realOut = (& $stopScript -TargetDir $projDir *>&1 | Out-String)",
        "if (-not (Get-Process -Id $decoyPid -ErrorAction SilentlyContinue)) { throw '9c live decoy process was killed by real stop-agent.ps1!' }",
        "if (-not (Test-Path $fakeAppPidFile)) { throw '9c app.pid should still be preserved after real stop-agent.ps1' }",
        "if ($realOut -notmatch '未找到运行中的 AgentPet 进程') { throw ('9c unexpected stop-agent output: ' + $realOut) }",
        "Write-Output 'AP01_VERIFIED_OK'"
      ];
      fs.writeFileSync(runnerAp01, '\uFEFF' + ap01PsLines.join('\r\n'), 'utf8');
      const ap01Res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runnerAp01], {
        encoding: 'utf8',
        timeout: 15000
      });
      assert.ifError(ap01Res.error);
      assert.strictEqual(ap01Res.signal, null);
      assert.strictEqual(ap01Res.status, 0, `AP01 PS verification failed: ${ap01Res.stderr || ap01Res.stdout}`);
      assert.ok(ap01Res.stdout.includes('AP01_VERIFIED_OK'), `Missing AP01_VERIFIED_OK: ${ap01Res.stdout}`);
      assert.strictEqual(decoyChild.exitCode, null, 'Decoy child process must still be alive after stop-agent checks');
      console.log('[PASS] Scenario 17: AP01 退出进程身份匹配收紧 (PID/兜底双路径、引号反斜杠解析、--title/-e/-Command/相对路径排他与存活诱饵验证通过)');
    } finally {
      try { decoyChild.kill(); } catch {}
    }
  }


  console.log('\nAll assertions passed.');
} catch (e) {
  console.error('[state-machine.test.mjs FAILURE]', (e && e.stack) || e);
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) {
    console.error('cleanup failed:', e && e.message);
    process.exitCode = 1;
  }
}
