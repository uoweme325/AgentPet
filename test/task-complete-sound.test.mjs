// test/task-complete-sound.test.mjs —— 任务完成声音提醒全量单元测试与 PS1 无头状态机回归
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpet-task-sound-'));
const tmpLogFile = path.join(tmpRoot, 'test-monitor.log');

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
  fs.mkdirSync(path.join(codexHome, 'sessions', '2026', '11', '18'), { recursive: true });
  fs.mkdirSync(dshDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const events = [];
  const m = new options.AgentMonitor({
    stallSeconds: options.stallSeconds !== undefined ? options.stallSeconds : 45,
    isProbe: true,
    onChange: (data) => {
      events.push(data);
      if (options.onChange) options.onChange(data);
    }
  });
  m.paths.antigravity = agBrain;
  m.paths.antigravityDb = agDb;
  m.paths.codex = codexHome;
  m.paths.dshDirs = [dshDir];
  m.paths.appDir = runtimeDir;
  m.paths.balanceFile = path.join(runtimeDir, 'runtime-balance.json');
  return { m, events, base, agBrain, agDb, codexHome, dshDir, runtimeDir };
}

function writeCodexFixture(codexHome, name, entries, mtimeMs) {
  const dir = path.join(codexHome, 'sessions', '2026', '11', '18');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, name);
  const lines = entries.map((e, idx) => JSON.stringify({
    timestamp: e.timestamp || new Date(mtimeMs + idx * 10).toISOString(),
    ...e
  }));
  fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf8');
  setFileMtime(fp, mtimeMs);
  return fp;
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

function writeDshFixture(dshDir, name, recordRows, mtimeMs) {
  const fp = path.join(dshDir, name);
  fs.writeFileSync(fp, JSON.stringify({ record: { rows: recordRows } }), 'utf8');
  setFileMtime(fp, mtimeMs);
  return fp;
}

try {
  const { AgentMonitor } = await import('../runtime/agent-monitor.mjs');
  const nowBase = Date.now();

  // =========================================================================
  // T1: Codex 连续步骤 -> final_answer(completed) -> task_complete
  // 只有显式 task_complete 产出 strictTurnEnd:true，且与同轮 final_answer 共享 turnId
  // =========================================================================
  {
    const env = createIsolatedMonitor('t1-codex-turn', { AgentMonitor });
    const tStart = nowBase - 2000;
    const tFinal = nowBase - 1200;
    const tComplete = nowBase - 800;

    writeCodexFixture(env.codexHome, 'rollout-t1.jsonl', [
      { type: 'event_msg', payload: { type: 'task_started' }, timestamp: new Date(tStart).toISOString() },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell' }, timestamp: new Date(tStart + 100).toISOString() },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' }, timestamp: new Date(tStart + 300).toISOString() },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: 'done' }, timestamp: new Date(tFinal).toISOString() }
    ], tFinal);

    const atFinal = env.m.checkCodex(tFinal + 100);
    assert.equal(atFinal?.state, 'success', 'T1: final_answer keeps visual state success');
    assert.equal(atFinal?.completion?.strictTurnEnd, false, 'T1: final_answer alone must NOT mark strictTurnEnd=true');
    assert.equal(atFinal?.completion?.outcome, 'step_only');
    assert.equal(atFinal?.completion?.kind, 'final_answer');
    const finalTurnId = atFinal?.completion?.turnId;
    assert.ok(finalTurnId, 'T1: final_answer must have deterministic turnId');

    env.m.lastCodexRolloutScan = 0;
    writeCodexFixture(env.codexHome, 'rollout-t1.jsonl', [
      { type: 'event_msg', payload: { type: 'task_started' }, timestamp: new Date(tStart).toISOString() },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell' }, timestamp: new Date(tStart + 100).toISOString() },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' }, timestamp: new Date(tStart + 300).toISOString() },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: 'done' }, timestamp: new Date(tFinal).toISOString() },
      { type: 'event_msg', payload: { type: 'task_complete' }, timestamp: new Date(tComplete).toISOString() }
    ], tComplete);

    const atComplete = env.m.checkCodex(tComplete + 200);
    assert.equal(atComplete?.state, 'success');
    assert.equal(atComplete?.completion?.strictTurnEnd, true, 'T1: task_complete must mark strictTurnEnd=true');
    assert.equal(atComplete?.completion?.outcome, 'completed');
    assert.equal(atComplete?.completion?.turnId, finalTurnId, 'T1: task_complete and final_answer in same turn must share turnId');
    assert.equal(atComplete?.completion?.eventAt, tComplete, 'T1: completion.eventAt must track source event timestamp');
    assert.equal(atComplete?.completion?.turnStartedAtMs, tStart, 'T1: completion must carry turnStartedAtMs');

    console.log('[PASS] T1: Codex final_answer -> task_complete strictTurnEnd 与共享 turnId 验证通过');
  }

  // =========================================================================
  // T2: Codex turn_aborted 及异常状态 task_complete 绝不映射为 completed
  // =========================================================================
  {
    const env = createIsolatedMonitor('t2-codex-abort', { AgentMonitor });
    const tAb = nowBase - 1000;
    writeCodexFixture(env.codexHome, 'rollout-abort.jsonl', [
      { type: 'event_msg', payload: { type: 'task_started' }, timestamp: new Date(tAb - 500).toISOString() },
      { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' }, timestamp: new Date(tAb).toISOString() }
    ], tAb);

    const resAbort = env.m.checkCodex(tAb + 500);
    assert.equal(resAbort?.completion?.strictTurnEnd, true);
    assert.equal(resAbort?.completion?.outcome, 'aborted', 'T2: turn_aborted must report outcome=aborted');
    assert.notEqual(resAbort?.state, 'success', 'T2: turn_aborted must not report UI success');
    assert.equal(env.m.checkCodex(tAb + 8500), null, 'T2: aborted expires after TERMINAL_HOLD_MS');

    const envFail = createIsolatedMonitor('t2-codex-failed', { AgentMonitor });
    writeCodexFixture(envFail.codexHome, 'rollout-fail.jsonl', [
      { type: 'event_msg', payload: { type: 'task_started' }, timestamp: new Date(tAb - 500).toISOString() },
      { type: 'event_msg', payload: { type: 'task_complete', status: 'failed', error: 'tool crashed' }, timestamp: new Date(tAb).toISOString() }
    ], tAb);
    const resFail = envFail.m.checkCodex(tAb + 500);
    assert.equal(resFail?.completion?.strictTurnEnd, true);
    assert.equal(resFail?.completion?.outcome, 'failed', 'T2: failed task_complete must map outcome=failed');
    assert.equal(resFail?.state, 'error');

    console.log('[PASS] T2: Codex turn_aborted / failed outcome 严禁归为 completed 验证通过');
  }

  // =========================================================================
  // T3: Antigravity DB step_type=15 与 Transcript 带闭合 tool_calls -> strictTurnEnd:false
  // 且 DB 在飞或领先时屏蔽 Transcript 最终回复候选
  // =========================================================================
  {
    if (DatabaseSync) {
      const envDb = createIsolatedMonitor('t3-ag-db', { AgentMonitor });
      const tStep15 = nowBase - 1500;
      const dbPath = path.join(envDb.agDb, 'conv-step15.db');
      writeAgDbFixture(dbPath, [{ idx: 1, step_type: 15, status: 3, metadata: {} }], tStep15);

      // Simulate 2.6s gap after step_type=15 terminal before next step_type=132
      const at26 = envDb.m.checkAntigravity(tStep15 + 2600);
      assert.equal(at26?.state, 'success', 'T3: AG DB step_type=15 retains visual success');
      assert.equal(at26?.completion?.strictTurnEnd, false, 'T3: AG DB step_type=15 must have strictTurnEnd=false');
      assert.equal(at26?.completion?.outcome, 'step_only');

      writeAgDbFixture(dbPath, [
        { idx: 1, step_type: 15, status: 3, metadata: {} },
        { idx: 2, step_type: 132, status: 1, metadata: { toolName: 'run_command', toolSummary: 'Next tool step' } }
      ], tStep15 + 2700);
      envDb.m.lastAgDbScan = 0;
      const atNext = envDb.m.checkAntigravity(tStep15 + 2800);
      assert.equal(atNext?.state, 'working');
    }

    const envTxTools = createIsolatedMonitor('t3-ag-tx-tools', { AgentMonitor });
    const tTx = nowBase - 1000;
    writeAgTranscriptFixture(envTxTools.agBrain, 'conv-tx-tools', [
      { step_index: 1, type: 'USER_INPUT', content: 'run tests' },
      { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ id: 'tc1', name: 'run_command', status: 'DONE', result: 'ok' }] }
    ], tTx);
    const txToolRes = envTxTools.m.checkAntigravity(tTx + 500);
    assert.equal(txToolRes?.state, 'success');
    assert.equal(txToolRes?.completion?.strictTurnEnd, false, 'T3: AG Transcript with tool_calls must have strictTurnEnd=false');
    assert.equal(txToolRes?.completion?.outcome, 'step_only');

    if (DatabaseSync) {
      const envLag = createIsolatedMonitor('t3-ag-db-ahead', { AgentMonitor });
      writeAgTranscriptFixture(envLag.agBrain, 'conv-lag', [
        { step_index: 1, type: 'USER_INPUT', content: 'hi' },
        { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'partial' }
      ], tTx);
      writeAgDbFixture(path.join(envLag.agDb, 'conv-lag.db'), [
        { idx: 3, step_type: 132, status: 1, metadata: { toolName: 'read_file' } }
      ], tTx + 100);
      const lagRes = envLag.m.checkAntigravity(tTx + 500);
      assert.notEqual(lagRes?.completion?.eligibleForAntigravityFinalReply, true, 'T3: DB inFlight must block AG final reply completion candidate');
    }

    console.log('[PASS] T3: Antigravity DB step_type=15 / Transcript 工具步 / DB在飞防误报验证通过');
  }

  // =========================================================================
  // T4: DSH lastStepBoundary=end 仅标记 step_only (strictTurnEnd:false)
  // =========================================================================
  {
    const envDsh = createIsolatedMonitor('t4-dsh-end', { AgentMonitor });
    const tD = nowBase - 1000;
    writeDshFixture(envDsh.dshDir, 'session-t4.json', {
      title: { val: 'DSH Task' },
      turnBoundary: { val: { openTurnStartSeq: null, lastStepBoundary: { kind: 'end' } } }
    }, tD);
    const dshRes = envDsh.m.checkDsh(tD + 500);
    assert.equal(dshRes?.state, 'success');
    assert.equal(dshRes?.completion?.strictTurnEnd, false, 'T4: DSH lastStepBoundary end must keep strictTurnEnd=false');
    assert.equal(dshRes?.completion?.outcome, 'step_only');

    console.log('[PASS] T4: DSH lastStepBoundary 保守仅标 step_only 验证通过');
  }

  // =========================================================================
  // T4b: DSH 持久化日志 turn/end (completed / interrupted / error / zstd / 防旧轮泄露)
  // =========================================================================
  {
    const envDshLog = createIsolatedMonitor('t4b-dsh-log', { AgentMonitor });
    const dshHome = path.join(envDshLog.base, 'dsh-home');
    const projSessDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
    const wsSessRoot = path.join(dshHome, 'sessions', '--D-ws--');
    fs.mkdirSync(projSessDir, { recursive: true });
    envDshLog.m.paths.dshDirs = [projSessDir];

    const writeDshPair = (sid, rowsObj, logLines, mtimeMs, useZstd = false) => {
      const logDir = path.join(wsSessRoot, sid);
      fs.mkdirSync(logDir, { recursive: true });
      const rawText = logLines.map(x => JSON.stringify(x)).join('\n') + '\n';
      const logFile = path.join(logDir, useZstd ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl');
      if (useZstd) {
        fs.writeFileSync(logFile, zlib.zstdCompressSync(Buffer.from(rawText, 'utf8')));
      } else {
        fs.writeFileSync(logFile, rawText, 'utf8');
      }
      setFileMtime(logFile, mtimeMs - 5);
      return writeDshFixture(projSessDir, `${sid}.json`, rowsObj, mtimeMs);
    };

    const tA = nowBase - 2000;
    writeDshPair('session-comp', {
      title: { val: 'DSH Real Turn' },
      turnBoundary: { val: { openTurnStartSeq: 10, lastStepStartSeq: 11, lastStepBoundary: { kind: 'start', seq: 11 }, lastTurn: 3 } }
    }, [
      { type: 'turn/start', seq: 10, time: tA, data: { turn: 3 } },
      { type: 'step/start', seq: 11, time: tA + 10, data: { turn: 3, step: 1 } }
    ], tA + 20);
    const dshActive = envDshLog.m.checkDsh(tA + 100);
    assert.equal(dshActive?.state, 'thinking');
    assert.equal(dshActive?.turnId, 'dsh-turn:3');

    envDshLog.m.lastDshSessionScan = 0;
    writeDshPair('session-comp', {
      title: { val: 'DSH Real Turn' },
      turnBoundary: { val: { openTurnStartSeq: null, lastStepStartSeq: 11, lastStepBoundary: { kind: 'end', seq: 12 }, lastTurn: 3 } }
    }, [
      { type: 'turn/start', seq: 10, time: tA, data: { turn: 3 } },
      { type: 'step/start', seq: 11, time: tA + 10, data: { turn: 3, step: 1 } },
      { type: 'step/end', seq: 12, time: tA + 500, data: { turn: 3, step: 1 } },
      { type: 'turn/end', seq: 13, time: tA + 500, data: { turn: 3, reason: { kind: 'completed' } } }
    ], tA + 520, typeof zlib.zstdCompressSync === 'function');
    const dshDone = envDshLog.m.checkDsh(tA + 600);
    assert.equal(dshDone?.state, 'success');
    assert.equal(dshDone?.completion?.strictTurnEnd, true, 'T4b: DSH completed turn/end must set strictTurnEnd=true');
    assert.equal(dshDone?.completion?.outcome, 'completed');
    assert.equal(dshDone?.completion?.kind, 'dsh_turn_end');
    assert.equal(dshDone?.completion?.turnId, dshActive.turnId, 'T4b: active and completed DSH snapshots must share turnId');
    assert.equal(dshDone?.completion?.turnStartedAtMs, tA);

    envDshLog.m.lastDshSessionScan = 0;
    const tInt = nowBase - 1200;
    writeDshPair('session-int', {
      title: { val: 'DSH Int' },
      turnBoundary: { val: { openTurnStartSeq: null, lastStepStartSeq: 21, lastStepBoundary: { kind: 'end', seq: 22 }, lastTurn: 1 } }
    }, [
      { type: 'turn/start', seq: 20, time: tInt, data: { turn: 1 } },
      { type: 'step/end', seq: 22, time: tInt + 200, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 23, time: tInt + 200, data: { turn: 1, reason: { kind: 'interrupted' } } }
    ], tInt + 220);
    const dshInt = envDshLog.m.checkDsh(tInt + 300);
    const intSnap = dshInt?.sessions?.find(s => s.rawId === 'session-int.json');
    assert.equal(intSnap?.state, 'idle', 'T4b: DSH interrupted turn must map state=idle');
    assert.equal(intSnap?.completion?.outcome, 'aborted');
    assert.equal(intSnap?.completion?.strictTurnEnd, true);

    envDshLog.m.lastDshSessionScan = 0;
    const tErr = nowBase - 900;
    writeDshPair('session-err', {
      title: { val: 'DSH Err' },
      turnBoundary: { val: { openTurnStartSeq: null, lastStepStartSeq: 31, lastStepBoundary: { kind: 'end', seq: 32 }, lastTurn: 2 } }
    }, [
      { type: 'turn/start', seq: 30, time: tErr, data: { turn: 2 } },
      { type: 'step/end', seq: 32, time: tErr + 200, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: 33, time: tErr + 200, data: { turn: 2, reason: { kind: 'error', error: { message: 'DeepSeek 503 timeout' } } } }
    ], tErr + 220);
    const dshErr = envDshLog.m.checkDsh(tErr + 300);
    const errSnap = dshErr?.sessions?.find(s => s.rawId === 'session-err.json');
    assert.equal(errSnap?.state, 'error', 'T4b: DSH error turn must map state=error');
    assert.equal(errSnap?.completion?.outcome, 'failed');
    assert.equal(errSnap?.completion?.strictTurnEnd, true);

    // Newer open turn/start in log while projcache lagged -> stay conservative step_only
    envDshLog.m.lastDshSessionScan = 0;
    const tLag = nowBase - 600;
    writeDshPair('session-lag', {
      title: { val: 'DSH Lag' },
      turnBoundary: { val: { openTurnStartSeq: null, lastStepStartSeq: 41, lastStepBoundary: { kind: 'end', seq: 42 }, lastTurn: 1 } }
    }, [
      { type: 'turn/start', seq: 40, time: tLag - 500, data: { turn: 1 } },
      { type: 'turn/end', seq: 43, time: tLag - 200, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 44, time: tLag, data: { turn: 2 } }
    ], tLag + 50);
    const dshLag = envDshLog.m.checkDsh(tLag + 100);
    const lagSnap = dshLag?.sessions?.find(s => s.rawId === 'session-lag.json');
    assert.equal(lagSnap?.completion?.strictTurnEnd, false, 'T4b: newer open turn/start in log must block stale completion');
    assert.equal(lagSnap?.completion?.outcome, 'step_only');

    // Late-arriving durable log turn/end while projcache content & mtime stay completely unchanged
    const verifyLateDshLogArrival = (sid, turnNum, endReason, expectedState, expectedOutcome) => {
      envDshLog.m.lastDshSessionScan = 0;
      const tLate = nowBase - 500;
      const pjPath = writeDshPair(sid, {
        title: { val: `Late ${sid}` },
        turnBoundary: { val: { openTurnStartSeq: null, lastStepStartSeq: 51, lastStepBoundary: { kind: 'end', seq: 52 }, lastTurn: turnNum } }
      }, [
        { type: 'turn/start', seq: 50, time: tLate - 400, data: { turn: turnNum } },
        { type: 'step/start', seq: 51, time: tLate - 200, data: { turn: turnNum, step: 1 } },
        { type: 'step/end', seq: 52, time: tLate - 10, data: { turn: turnNum, step: 1 } }
      ], tLate);
      const pjMtimeBefore = fs.statSync(pjPath).mtimeMs;

      const firstPoll = envDshLog.m.checkDsh(tLate + 200);
      const firstSnap = firstPoll?.sessions?.find(s => s.rawId === `${sid}.json`);
      assert.equal(firstSnap?.completion?.outcome, 'step_only', `${sid}: initial poll without turn/end must stay step_only`);
      assert.equal(firstSnap?.completion?.strictTurnEnd, false);

      // Append turn/end strictly to durable log WITHOUT modifying projcache JSON or its mtime
      const logDir = path.join(wsSessRoot, sid);
      const logFile = path.join(logDir, 'session.v4.jsonl');
      fs.appendFileSync(logFile, JSON.stringify({
        type: 'turn/end',
        seq: 53,
        time: tLate + 2000,
        data: { turn: turnNum, reason: endReason }
      }) + '\n', 'utf8');
      setFileMtime(logFile, tLate + 2000);
      assert.equal(fs.statSync(pjPath).mtimeMs, pjMtimeBefore, `${sid}: test precondition requires projcache mtime unchanged`);

      // Normal poll ~2.1s later inside 8s TERMINAL_HOLD_MS must re-check log & upgrade to strict terminal
      const secondPoll = envDshLog.m.checkDsh(tLate + 2300);
      const secondSnap = secondPoll?.sessions?.find(s => s.rawId === `${sid}.json`);
      assert.equal(secondSnap?.state, expectedState, `${sid}: late durable turn/end must update state on normal poll`);
      assert.equal(secondSnap?.completion?.outcome, expectedOutcome);
      assert.equal(secondSnap?.completion?.strictTurnEnd, true);
      assert.equal(secondSnap?.completion?.turnId, `dsh-turn:${turnNum}`);

      // Subsequent poll reuses resolved strict terminal state stably
      const thirdPoll = envDshLog.m.checkDsh(tLate + 2800);
      const thirdSnap = thirdPoll?.sessions?.find(s => s.rawId === `${sid}.json`);
      assert.equal(thirdSnap?.completion?.outcome, expectedOutcome);
      assert.equal(thirdSnap?.completion?.strictTurnEnd, true);
    };

    verifyLateDshLogArrival('session-late-comp', 4, { kind: 'completed' }, 'success', 'completed');
    verifyLateDshLogArrival('session-late-int', 5, { kind: 'interrupted' }, 'idle', 'aborted');
    verifyLateDshLogArrival('session-late-err', 6, { kind: 'error', error: { message: '503 error' } }, 'error', 'failed');

    console.log('[PASS] T4b: DSH 日志 turn/end (completed/interrupted/error/zstd/防旧轮/日志晚到补验) 验证通过');
  }

  // =========================================================================
  // T5: 同源双并行会话（A 持续 working，B 从 working -> task_complete）必须触发 scan 推送并完整保留明细
  // =========================================================================
  {
    const envMulti = createIsolatedMonitor('t5-parallel-sessions', { AgentMonitor });
    const originalNow = Date.now;
    let fakeNow = nowBase;
    Date.now = () => fakeNow;
    try {
      writeCodexFixture(envMulti.codexHome, 'rollout-a.jsonl', [
        { type: 'event_msg', payload: { type: 'task_started' }, timestamp: new Date(fakeNow - 2000).toISOString() },
        { type: 'response_item', payload: { type: 'function_call', call_id: 'ca', name: 'exec_command' }, timestamp: new Date(fakeNow - 500).toISOString() }
      ], fakeNow - 500);
      writeCodexFixture(envMulti.codexHome, 'rollout-b.jsonl', [
        { type: 'event_msg', payload: { type: 'task_started' }, timestamp: new Date(fakeNow - 2000).toISOString() },
        { type: 'response_item', payload: { type: 'function_call', call_id: 'cb', name: 'exec_command' }, timestamp: new Date(fakeNow - 700).toISOString() }
      ], fakeNow - 700);

      envMulti.m.scan();
      assert.equal(envMulti.events.length, 1);
      assert.equal(envMulti.events[0].totalActiveSessions, 2, 'T5: initial parallel scan sees 2 active Codex sessions');

      // Secondary session B completes while primary session A remains working (within 10s heartbeat threshold!)
      fakeNow += 1500;
      envMulti.m.lastCodexRolloutScan = 0;
      writeCodexFixture(envMulti.codexHome, 'rollout-b.jsonl', [
        { type: 'event_msg', payload: { type: 'task_started' }, timestamp: new Date(fakeNow - 3500).toISOString() },
        { type: 'response_item', payload: { type: 'function_call', call_id: 'cb', name: 'exec_command' }, timestamp: new Date(fakeNow - 2200).toISOString() },
        { type: 'event_msg', payload: { type: 'task_complete' }, timestamp: new Date(fakeNow).toISOString() }
      ], fakeNow);

      envMulti.m.scan();
      assert.equal(envMulti.events.length, 2, 'T5: secondary session completing while primary stays working must emit onChange immediately');
      const snapEv = envMulti.events[1];
      assert.equal(snapEv.totalActiveSessions, 1, 'T5: active session count must drop to 1');
      const sessA = snapEv.sessionSnapshots.find(s => s.rawId === 'rollout-a.jsonl');
      const sessB = snapEv.sessionSnapshots.find(s => s.rawId === 'rollout-b.jsonl');
      assert.equal(sessA?.state, 'working');
      assert.equal(sessB?.state, 'success');
      assert.equal(sessB?.completion?.strictTurnEnd, true);
      assert.equal(sessB?.completion?.outcome, 'completed');
    } finally {
      Date.now = originalNow;
    }

    console.log('[PASS] T5: 同源双并行会话次会话完工即时推送与明细保留验证通过');
  }

  // =========================================================================
  // T6: AC-02 & AC-03 后端轮次匹配防旧终态泄露 + 同批并行结束快照真实产出
  // =========================================================================
  const backendPacketsForPsPath = path.join(tmpRoot, 'backend-ac-packets.json');
  {
    const envLate = createIsolatedMonitor('t6-codex-late-old-turn', { AgentMonitor });
    const originalNow = Date.now;
    let fakeNow = nowBase;
    Date.now = () => fakeNow;
    const lateOldTurnPackets = [];
    const envLate2 = createIsolatedMonitor('t6-codex-parallel-order', { AgentMonitor });
    const envRapid = createIsolatedMonitor('t6-codex-rapid-sequential', { AgentMonitor });
    try {
      const oldStart = { type: 'event_msg', timestamp: new Date(nowBase + 100).toISOString(), payload: { type: 'task_started', turn_id: 'old-turn' } };
      const oldEnd = { type: 'event_msg', timestamp: new Date(nowBase + 2000).toISOString(), payload: { type: 'task_complete', turn_id: 'old-turn' } };
      const newStart = { type: 'event_msg', timestamp: new Date(nowBase + 3000).toISOString(), payload: { type: 'task_started', turn_id: 'new-turn' } };
      const newEnd = { type: 'event_msg', timestamp: new Date(nowBase + 4200).toISOString(), payload: { type: 'task_complete', turn_id: 'new-turn' } };

      fakeNow = nowBase + 3100;
      writeCodexFixture(envLate.codexHome, 'rollout-late.jsonl', [oldStart, oldEnd, newStart], nowBase + 3000);
      envLate.m.scan();

      // Replay delayed old-turn task_complete at log tail while new-turn is still active
      fakeNow = nowBase + 3500;
      envLate.m.lastCodexRolloutScan = 0;
      writeCodexFixture(envLate.codexHome, 'rollout-late.jsonl', [oldStart, oldEnd, newStart, oldEnd], nowBase + 3500);
      envLate.m.scan();

      assert.ok(envLate.events.length >= 1);
      const afterReplay = envLate.events[envLate.events.length - 1];
      assert.equal(afterReplay.state, 'thinking', 'T6: delayed old-turn task_complete must NOT override active new-turn');
      assert.equal(afterReplay.completion || null, null, 'T6: stale old-turn completion must NOT be emitted');

      // Also verify final_answer(old-turn) delayed at tail cannot hijack active new-turn
      fakeNow = nowBase + 3800;
      envLate.m.lastCodexRolloutScan = 0;
      const oldFinalMsg = {
        type: 'response_item',
        timestamp: new Date(nowBase + 1900).toISOString(),
        payload: { type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: 'old' }
      };
      writeCodexFixture(envLate.codexHome, 'rollout-late.jsonl', [oldStart, oldEnd, newStart, oldEnd, oldFinalMsg], nowBase + 3800);
      envLate.m.scan();
      assert.equal(envLate.events[envLate.events.length - 1].state, 'thinking');
      assert.equal(envLate.events[envLate.events.length - 1].completion || null, null);

      // Now genuine new-turn completes -> must report id:new-turn with new-turn's own start time
      fakeNow = nowBase + 4300;
      envLate.m.lastCodexRolloutScan = 0;
      writeCodexFixture(envLate.codexHome, 'rollout-late.jsonl', [oldStart, oldEnd, newStart, oldEnd, newEnd], nowBase + 4200);
      envLate.m.scan();
      const afterNewEnd = envLate.events[envLate.events.length - 1];
      assert.equal(afterNewEnd.state, 'success', 'T6: genuine new-turn completion must report success');
      assert.equal(afterNewEnd.completion?.turnId, 'id:new-turn');
      assert.equal(afterNewEnd.completion?.turnStartedAtMs, nowBase + 3000, 'T6: new-turn anchor must match 3000ms start');
      assert.equal(afterNewEnd.completion?.eventAt, nowBase + 4200);
      assert.equal(afterNewEnd.completion?.strictTurnEnd, true);

      lateOldTurnPackets.push(...envLate.events);

      // Parallel sessions A (completed 2000) & B (aborted 2100) scanned together (filesystem order often puts newer aborted B first)
      fakeNow = nowBase + 1200;
      writeCodexFixture(envLate2.codexHome, 'rollout-a.jsonl', [{ type: 'event_msg', timestamp: new Date(nowBase + 100).toISOString(), payload: { type: 'task_started', turn_id: 'turn-A' } }], nowBase + 1000);
      writeCodexFixture(envLate2.codexHome, 'rollout-b.jsonl', [{ type: 'event_msg', timestamp: new Date(nowBase + 200).toISOString(), payload: { type: 'task_started', turn_id: 'turn-B' } }], nowBase + 1100);
      envLate2.m.scan();

      fakeNow = nowBase + 2200;
      envLate2.m.lastCodexRolloutScan = 0;
      writeCodexFixture(envLate2.codexHome, 'rollout-a.jsonl', [
        { type: 'event_msg', timestamp: new Date(nowBase + 100).toISOString(), payload: { type: 'task_started', turn_id: 'turn-A' } },
        { type: 'event_msg', timestamp: new Date(nowBase + 2000).toISOString(), payload: { type: 'task_complete', turn_id: 'turn-A' } }
      ], nowBase + 2000);
      writeCodexFixture(envLate2.codexHome, 'rollout-b.jsonl', [
        { type: 'event_msg', timestamp: new Date(nowBase + 200).toISOString(), payload: { type: 'task_started', turn_id: 'turn-B' } },
        { type: 'event_msg', timestamp: new Date(nowBase + 2100).toISOString(), payload: { type: 'turn_aborted', turn_id: 'turn-B' } }
      ], nowBase + 2100);
      envLate2.m.scan();
      assert.equal(envLate2.events.length, 2);

      // Rapid sequential turns in the same session between two polls: A active -> A completes + B starts + B completes
      const rStartA = { type: 'event_msg', timestamp: new Date(nowBase + 100).toISOString(), payload: { type: 'task_started', turn_id: 'A' } };
      const rEndA = { type: 'event_msg', timestamp: new Date(nowBase + 1500).toISOString(), payload: { type: 'task_complete', turn_id: 'A' } };
      const rStartB = { type: 'event_msg', timestamp: new Date(nowBase + 1600).toISOString(), payload: { type: 'task_started', turn_id: 'B' } };
      const rEndB = { type: 'event_msg', timestamp: new Date(nowBase + 2000).toISOString(), payload: { type: 'task_complete', turn_id: 'B' } };

      fakeNow = nowBase + 1200;
      writeCodexFixture(envRapid.codexHome, 'rollout-rapid.jsonl', [rStartA], nowBase + 1000);
      envRapid.m.scan();
      assert.equal(envRapid.events.length, 1);
      assert.equal(envRapid.events[0].state, 'thinking');
      assert.equal(envRapid.events[0].sessionSnapshots[0]?.turnId, 'id:A');
      assert.equal(envRapid.events[0].sessionSnapshots[0]?.turnStartedAtMs, nowBase + 100);

      fakeNow = nowBase + 2200;
      envRapid.m.lastCodexRolloutScan = 0;
      writeCodexFixture(envRapid.codexHome, 'rollout-rapid.jsonl', [rStartA, rEndA, rStartB, rEndB], nowBase + 2000);
      envRapid.m.scan();
      assert.equal(envRapid.events.length, 2);
      const afterRapidB = envRapid.events[1];
      assert.equal(afterRapidB.state, 'success', 'T6 rapid sequential: B completion must report success');
      assert.equal(afterRapidB.completion?.turnId, 'id:B');
      assert.equal(afterRapidB.completion?.turnStartedAtMs, nowBase + 1600);
      assert.equal(afterRapidB.completion?.eventAt, nowBase + 2000);
      assert.equal(afterRapidB.completion?.strictTurnEnd, true);

      fs.writeFileSync(backendPacketsForPsPath, JSON.stringify({
        baseMs: nowBase,
        latePackets: lateOldTurnPackets,
        parallelAbortTailPackets: envLate2.events,
        rapidPackets: envRapid.events
      }), 'utf8');
    } finally {
      Date.now = originalNow;
    }

    console.log('[PASS] T6: AC-02 旧轮次延迟/重放防串轮与同会话快切双轮完成验证通过');
  }

  // =========================================================================
  // P0~P7: PowerShell 真实生产代码（Helpers + StateMachine + Config + Tray/WPF 菜单）无头端到端集成测试
  // =========================================================================
  {
    const psRunner = path.join(tmpRoot, 'verify-task-complete-sound.ps1');
    const ps1Path = path.join(repoRoot, 'AgentPet.ps1').replace(/'/g, "''");
    const wavPath = path.join(repoRoot, 'assets', 'task_complete.wav').replace(/'/g, "''");
    const psTestDir = path.join(tmpRoot, 'ps-ui-env').replace(/'/g, "''");
    const backendJsonEsc = backendPacketsForPsPath.replace(/'/g, "''");

    const psScript = `
Add-Type -AssemblyName System, PresentationCore, PresentationFramework, WindowsBase, System.Windows.Forms, System.Drawing
$ErrorActionPreference = 'Stop'

# P0: Asset & AST / GetNewClosure check
if (-not (Test-Path -LiteralPath '${wavPath}')) { throw 'Missing assets/task_complete.wav' }
$sp = New-Object System.Media.SoundPlayer('${wavPath}')
$sp.Load()

$src = Get-Content -LiteralPath '${ps1Path}' -Raw -Encoding UTF8
$errs = $null; $toks = $null
$parsedAst = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$toks, [ref]$errs)
if ($errs -and $errs.Count -gt 0) { throw "PS1 parse error: $($errs[0].ToString())" }
$closureCount = ([regex]::Matches($src, 'GetNewClosure')).Count
if ($closureCount -ne 1) { throw "Expected GetNewClosure count === 1, got $closureCount" }

function Extract-FunctionDef([string]$fnName) {
    $fnAst = $parsedAst.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $fnName }, $true)
    if (-not $fnAst) { throw "Missing function definition: $fnName" }
    return $fnAst.Extent.Text
}

function Extract-MarkedSection([string]$text, [string]$startMark, [string]$endMark) {
    $s = $text.IndexOf($startMark)
    $e = $text.IndexOf($endMark)
    if ($s -lt 0 -or $e -le $s) { throw "Missing section markers: $startMark .. $endMark" }
    return $text.Substring($s, $e - $s + $endMark.Length)
}

$helpersCode = Extract-MarkedSection $src '# --- BEGIN TASK COMPLETE SOUND HELPERS ---' '# --- END TASK COMPLETE SOUND HELPERS ---'
$trackerCode = Extract-MarkedSection $src '# --- BEGIN TASK COMPLETE TRACKER STATE MACHINE ---' '# --- END TASK COMPLETE TRACKER STATE MACHINE ---'

# Mock environment & controls before evaluating extracted production code
New-Item -ItemType Directory -Force -Path '${psTestDir}' | Out-Null
$BaseDir = '${psTestDir}'
$AssetsDir = Join-Path '${repoRoot.replace(/'/g, "''")}' 'assets'
$CharDir = Join-Path $AssetsDir 'chars'
$ConfigPath = Join-Path $BaseDir 'config.json'
$ConfigBakPath = Join-Path $BaseDir 'config.json.bak'
$script:logs = New-Object System.Collections.ArrayList
$script:playedCalls = New-Object System.Collections.ArrayList
function Write-PetLog([string]$m) { [void]$script:logs.Add($m) }
function Log-Throttled([string]$k, [string]$m, [int]$s = 30) { [void]$script:logs.Add(($k + ':' + $m)) }
function Build-ContextMenu { }
function Save-Config { }
function Set-WaitingWindowAttention([bool]$a) { }
function Close-HoverDetailCard { }
function Set-PetSprite([string]$s) { }
function Test-HasProtectedUserBubble { return $false }
function Set-ActiveBubblePanel([string]$p) { }
function Show-Bubble([double]$sec = 0, [switch]$Force) { }
function Hide-Bubble { }

$Config = [ordered]@{
    Character                            = 'claude'
    BubbleMode                           = 'quota'
    SoundEnabled                         = $true
    SoundVolume                          = 850
    PauseMonitorUntil                    = 0
    TaskCompleteSoundEnabled             = $true
    MuteTaskSoundWhenHidden              = $true
    QuietHoursEnabled                    = $false
    QuietHoursStart                      = '23:00'
    QuietHoursEnd                        = '08:00'
    AntigravityTranscriptCompleteEnabled = $false
}

$script:manualBubbleHidden = $false
$script:trayWindowHidden = $false
$script:agentBusy = $false
$script:lastAgentState = $null
$script:lastWorkStatusObj = $null
$script:LastDetailContentKey = $null
$script:LastDetailMetaKey = $null
$script:waitingLastAlert = $null
$script:lastInteractTime = [DateTime]::UtcNow
$script:TaskCompletePlayer = New-Object PSObject

# Evaluate production helper block then wrap Play-TaskCompleteSound with count spy (delegating actual mute guard!)
Invoke-Expression $helpersCode
function Play-TaskCompleteSound {
    param([switch]$Preview, [datetime]$LocalNow = [datetime]::Now)
    if (-not $Preview -and (Test-ShouldMuteTaskCompleteSound $LocalNow)) { return $false }
    [void]$script:playedCalls.Add([ordered]@{ Preview = [bool]$Preview; LocalNow = $LocalNow })
    return $true
}
Invoke-Expression $trackerCode

function Reset-TestClock([DateTime]$baseUtc) {
    $script:startupCutoffMs = ([DateTimeOffset]$baseUtc).ToUnixTimeMilliseconds()
    $script:lastStatusHeartbeatMs = $script:startupCutoffMs
    $script:monitorStartTime = $baseUtc.AddSeconds(-30)
    $script:MonitorProc = New-Object PSObject -Property @{ HasExited = $false }
    $script:agentBusy = $false
    $script:lastAgentState = $null
    $script:consumedCompletionIds.Clear()
    [void]$script:consumedCompletionIdSet.Clear()
    $script:playedCalls.Clear()
    $script:manualBubbleHidden = $false
    $script:trayWindowHidden = $false
    $Config.PauseMonitorUntil = 0
    $Config.TaskCompleteSoundEnabled = $true
    $Config.SoundEnabled = $true
    $Config.MuteTaskSoundWhenHidden = $true
    $Config.QuietHoursEnabled = $false
    $Config.QuietHoursStart = '23:00'
    $Config.QuietHoursEnd = '08:00'
    Reset-TaskCompletionTracker 'TestInit'
}

function Make-Snap([string]$src, [string]$rawId, [string]$state, [long]$atMs, $comp = $null, [string]$turnId = '', [long]$turnStartedAtMs = 0) {
    $obj = [ordered]@{
        source     = $src
        rawId      = $rawId
        sessionKey = "$src|$rawId"
        state      = $state
        at         = $atMs
        completion = $comp
    }
    if ($turnId) { $obj['turnId'] = $turnId }
    if ($turnStartedAtMs -gt 0) { $obj['turnStartedAtMs'] = $turnStartedAtMs }
    return [pscustomobject]$obj
}

function Make-Comp([string]$src, [string]$rawId, [string]$turnId, [string]$outcome, [bool]$strict, [long]$eventAt, [long]$turnStart = 0, [bool]$eligAg = $false) {
    return [pscustomobject]@{
        source                            = $src
        sessionKey                        = "$src|$rawId"
        turnId                            = $turnId
        kind                              = if ($outcome -eq 'aborted') { 'turn_aborted' } elseif ($strict) { 'task_complete' } else { 'step' }
        outcome                           = $outcome
        strictTurnEnd                     = $strict
        eventId                           = "$src|$rawId|$turnId|$outcome"
        eventAt                           = $eventAt
        turnStartedAtMs                   = $turnStart
        eligibleForAntigravityFinalReply  = $eligAg
    }
}

$t0 = [DateTime]::SpecifyKind([DateTime]::Parse('2026-11-18T10:00:00Z'), [DateTimeKind]::Utc)
$dayLocal = [DateTime]::new(2026, 11, 18, 12, 0, 0)

# --- P1: Single session 2.0s debounce, cancellation on stalled/working, single play & 8s/heartbeat idempotency ---
Reset-TestClock $t0
$t0Ms = ([DateTimeOffset]$t0).ToUnixTimeMilliseconds()
$stWork = [pscustomobject]@{ state = 'working'; at = $t0Ms + 500; sessionSnapshots = @(Make-Snap 'Codex' 'r1.jsonl' 'working' ($t0Ms + 500)) }
Update-TaskCompletionTracker $stWork ($t0Ms + 500) ($t0.AddMilliseconds(500))
$script:agentBusy = $true; $script:lastStatusHeartbeatMs = $t0Ms + 500

# Mid-turn final_answer(step_only) must NOT arm chime
$stFinal = [pscustomobject]@{ state = 'success'; at = $t0Ms + 1000; sessionSnapshots = @(Make-Snap 'Codex' 'r1.jsonl' 'success' ($t0Ms + 1000) (Make-Comp 'Codex' 'r1.jsonl' 'turn1' 'step_only' $false ($t0Ms + 1000))) }
Update-TaskCompletionTracker $stFinal ($t0Ms + 1000) ($t0.AddMilliseconds(1000))
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(4)) $dayLocal)
if ($script:playedCalls.Count -ne 0) { throw "P1 failed: final_answer(step_only) must produce 0 chimes" }

# Re-enter active then complete -> debounce cancels on resume to stalled within <2s
$stComp1 = [pscustomobject]@{ state = 'success'; at = $t0Ms + 5000; sessionSnapshots = @(Make-Snap 'Codex' 'r1.jsonl' 'success' ($t0Ms + 5000) (Make-Comp 'Codex' 'r1.jsonl' 'turn1' 'completed' $true ($t0Ms + 5000) ($t0Ms + 200))) }
Update-TaskCompletionTracker $stComp1 ($t0Ms + 5000) ($t0.AddSeconds(5))
if ($null -eq $script:pendingTaskCompleteDueUtc) { throw "P1 failed: strict completion should arm pending due" }
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(6.2)) $dayLocal)
if ($script:playedCalls.Count -ne 0) { throw "P1 failed: must NOT chime before 2.0s settle" }
# Resume to stalled inside 2.0s window -> cancels pending chime!
$stStalled = [pscustomobject]@{ state = 'stalled'; at = $t0Ms + 6500; sessionSnapshots = @(Make-Snap 'Codex' 'r1.jsonl' 'stalled' ($t0Ms + 6500)) }
Update-TaskCompletionTracker $stStalled ($t0Ms + 6500) ($t0.AddSeconds(6.5))
$script:lastStatusHeartbeatMs = $t0Ms + 6500
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(9.0)) $dayLocal)
if ($script:playedCalls.Count -ne 0) { throw "P1 failed: stalled inside debounce window must cancel chime" }

# Final turn 2 complete -> stable past 2.0s -> chime ONCE; repeated snapshots in 8s hold window must NOT replay
$stComp2 = [pscustomobject]@{ state = 'success'; at = $t0Ms + 10000; sessionSnapshots = @(Make-Snap 'Codex' 'r1.jsonl' 'success' ($t0Ms + 10000) (Make-Comp 'Codex' 'r1.jsonl' 'turn2' 'completed' $true ($t0Ms + 10000) ($t0Ms + 6600))) }
Update-TaskCompletionTracker $stComp2 ($t0Ms + 10000) ($t0.AddSeconds(10))
$script:lastStatusHeartbeatMs = $t0Ms + 10000
# Poll again at +11.0s with identical eventId -> must preserve original deadline, not postpone!
Update-TaskCompletionTracker $stComp2 ($t0Ms + 11000) ($t0.AddSeconds(11))
$script:lastStatusHeartbeatMs = $t0Ms + 11000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(12.05)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P1 failed: expected exactly 1 chime after 2.0s settle, got $($script:playedCalls.Count)" }
# Repeat snapshot inside 8s hold & 10s heartbeat & natural idle -> still 1
Update-TaskCompletionTracker $stComp2 ($t0Ms + 13000) ($t0.AddSeconds(13))
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(16)) $dayLocal)
$stIdle = [pscustomobject]@{ state = $null; at = $t0Ms + 18500; sessionSnapshots = @() }
Update-TaskCompletionTracker $stIdle ($t0Ms + 18500) ($t0.AddSeconds(18.5))
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(21)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P1 failed: repeated snapshot / idle expiry must stay at 1 chime, got $($script:playedCalls.Count)" }

# --- P2: Parallel sessions (clean batch settle + later abort suppresses earlier completion) ---
Reset-TestClock $t0
$t0Ms = ([DateTimeOffset]$t0).ToUnixTimeMilliseconds()
# Both r1 and r2 working
$sBoth = [pscustomobject]@{
    state = 'working'; at = $t0Ms + 500;
    sessionSnapshots = @(
        (Make-Snap 'Codex' 'r1.jsonl' 'working' ($t0Ms + 500)),
        (Make-Snap 'Codex' 'r2.jsonl' 'working' ($t0Ms + 500))
    )
}
Update-TaskCompletionTracker $sBoth ($t0Ms + 500) ($t0.AddMilliseconds(500))
# r1 completes, r2 still working -> MUST NOT chime
$sHalf = [pscustomobject]@{
    state = 'working'; at = $t0Ms + 2000;
    sessionSnapshots = @(
        (Make-Snap 'Codex' 'r1.jsonl' 'success' ($t0Ms + 2000) (Make-Comp 'Codex' 'r1.jsonl' 'tA' 'completed' $true ($t0Ms + 2000) ($t0Ms + 100))),
        (Make-Snap 'Codex' 'r2.jsonl' 'working' ($t0Ms + 2000))
    )
}
Update-TaskCompletionTracker $sHalf ($t0Ms + 2000) ($t0.AddSeconds(2))
$script:lastStatusHeartbeatMs = $t0Ms + 2000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(6)) $dayLocal)
if ($script:playedCalls.Count -ne 0) { throw "P2 failed: must wait until second parallel session finishes" }
# r2 also completes (even if r1 aged >8s out of snapshots) -> settles ONCE
$sSecondDone = [pscustomobject]@{
    state = 'success'; at = $t0Ms + 12000;
    sessionSnapshots = @(
        (Make-Snap 'Codex' 'r2.jsonl' 'success' ($t0Ms + 12000) (Make-Comp 'Codex' 'r2.jsonl' 'tB' 'completed' $true ($t0Ms + 12000) ($t0Ms + 100)))
    )
}
Update-TaskCompletionTracker $sSecondDone ($t0Ms + 12000) ($t0.AddSeconds(12))
$script:lastStatusHeartbeatMs = $t0Ms + 12000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(14.1)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P2 failed: parallel batch settle expected 1 chime, got $($script:playedCalls.Count)" }

# Parallel case B: r1 finishes cleanly, r2 continues then hits turn_aborted -> 0 chimes (no delayed chime on abort!)
Reset-TestClock $t0
Update-TaskCompletionTracker $sBoth ($t0Ms + 500) ($t0.AddMilliseconds(500))
Update-TaskCompletionTracker $sHalf ($t0Ms + 2000) ($t0.AddSeconds(2))
$sAbortTail = [pscustomobject]@{
    state = 'idle'; at = $t0Ms + 5000;
    sessionSnapshots = @(
        (Make-Snap 'Codex' 'r2.jsonl' 'idle' ($t0Ms + 5000) (Make-Comp 'Codex' 'r2.jsonl' 'tB' 'aborted' $true ($t0Ms + 5000) ($t0Ms + 100)))
    )
}
Update-TaskCompletionTracker $sAbortTail ($t0Ms + 5000) ($t0.AddSeconds(5))
$script:lastStatusHeartbeatMs = $t0Ms + 5000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(9)) $dayLocal)
if ($script:playedCalls.Count -ne 0) { throw "P2 failed: aborting second parallel session must suppress stale completion chime" }

# --- P3: Cold-start pre-startup terminal snapshot -> 0 chimes; quick post-startup turn -> 1 chime ---
Reset-TestClock $t0
$stOldCold = [pscustomobject]@{
    state = 'success'; at = $t0Ms + 200;
    sessionSnapshots = @(
        (Make-Snap 'Codex' 'old.jsonl' 'success' ($t0Ms - 1000) (Make-Comp 'Codex' 'old.jsonl' 'tOld' 'completed' $true ($t0Ms - 1000) ($t0Ms - 5000)))
    )
}
Update-TaskCompletionTracker $stOldCold ($t0Ms + 200) ($t0.AddMilliseconds(200))
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(3)) $dayLocal)
if ($script:playedCalls.Count -ne 0) { throw "P3 failed: cold-start leftover completion must produce 0 chimes" }

$stQuickPost = [pscustomobject]@{
    state = 'success'; at = $t0Ms + 4000;
    sessionSnapshots = @(
        (Make-Snap 'Codex' 'fast.jsonl' 'success' ($t0Ms + 4000) (Make-Comp 'Codex' 'fast.jsonl' 'tFast' 'completed' $true ($t0Ms + 4000) ($t0Ms + 3600)))
    )
}
Update-TaskCompletionTracker $stQuickPost ($t0Ms + 4000) ($t0.AddSeconds(4))
$script:lastStatusHeartbeatMs = $t0Ms + 4000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(6.2)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P3 failed: quick turn started after startupCutoffMs should chime once, got $($script:playedCalls.Count)" }

# --- P4: PauseMonitorUntil / MonitorProc.HasExited / Watchdog timeout cancel pending completion ---
foreach ($abortMode in @('Pause', 'MonitorDead', 'WatchdogTimeout')) {
    Reset-TestClock $t0
    Update-TaskCompletionTracker $stWork ($t0Ms + 500) ($t0.AddMilliseconds(500))
    $script:agentBusy = $true
    Update-TaskCompletionTracker $stComp1 ($t0Ms + 5000) ($t0.AddSeconds(5))
    $script:lastStatusHeartbeatMs = $t0Ms + 5000
    if ($abortMode -eq 'Pause') {
        $Config.PauseMonitorUntil = $t0Ms + 600000
        [void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(8)) $dayLocal)
    } elseif ($abortMode -eq 'MonitorDead') {
        $script:MonitorProc.HasExited = $true
        [void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(8)) $dayLocal)
    } else {
        [void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(42)) $dayLocal)
    }
    if ($script:playedCalls.Count -ne 0) { throw "P4 failed ($abortMode): must cancel pending chime" }
}

# --- P5: MuteTaskSoundWhenHidden + Decoupling from SoundEnabled + No replay after unhide ---
Reset-TestClock $t0
$Config.SoundEnabled = $false # Decoupled: click voice OFF, task completion ON
Update-TaskCompletionTracker $stWork ($t0Ms + 500) ($t0.AddMilliseconds(500))
Update-TaskCompletionTracker $stComp1 ($t0Ms + 5000) ($t0.AddSeconds(5))
$script:lastStatusHeartbeatMs = $t0Ms + 5000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(7.2)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P5 failed: SoundEnabled=false must not mute TaskCompleteSoundEnabled" }

# Hidden bubble during settlement -> 0 chimes & consumed -> unhiding must NOT retroactively chime
$script:manualBubbleHidden = $true
Update-TaskCompletionTracker $stWork ($t0Ms + 10000) ($t0.AddSeconds(10))
$stCompHide = [pscustomobject]@{ state = 'success'; at = $t0Ms + 12000; sessionSnapshots = @(Make-Snap 'Codex' 'r1.jsonl' 'success' ($t0Ms + 12000) (Make-Comp 'Codex' 'r1.jsonl' 'tHide' 'completed' $true ($t0Ms + 12000) ($t0Ms + 10000))) }
Update-TaskCompletionTracker $stCompHide ($t0Ms + 12000) ($t0.AddSeconds(12))
$script:lastStatusHeartbeatMs = $t0Ms + 12000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(14.2)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P5 failed: hidden bubble with default MuteTaskSoundWhenHidden=true must suppress chime" }
$script:manualBubbleHidden = $false
Update-TaskCompletionTracker $stCompHide ($t0Ms + 15000) ($t0.AddSeconds(15))
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(18)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P5 failed: un-hiding must NOT replay already-consumed completion" }

# Tray window hidden also mutes by default, then setting MuteTaskSoundWhenHidden=$false allows chime
$script:trayWindowHidden = $true
$Config.MuteTaskSoundWhenHidden = $false
Update-TaskCompletionTracker $stWork ($t0Ms + 20000) ($t0.AddSeconds(20))
$stCompTrayUnhide = [pscustomobject]@{ state = 'success'; at = $t0Ms + 22000; sessionSnapshots = @(Make-Snap 'Codex' 'r1.jsonl' 'success' ($t0Ms + 22000) (Make-Comp 'Codex' 'r1.jsonl' 'tNoMute' 'completed' $true ($t0Ms + 22000) ($t0Ms + 20000))) }
Update-TaskCompletionTracker $stCompTrayUnhide ($t0Ms + 22000) ($t0.AddSeconds(22))
$script:lastStatusHeartbeatMs = $t0Ms + 22000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(24.2)) $dayLocal)
if ($script:playedCalls.Count -ne 2) { throw "P5 failed: MuteTaskSoundWhenHidden=false should allow chime while hidden" }

# --- P6: QuietHours strict HH:mm & [start, end) half-open bounds + malformed fallback ---
Reset-TestClock $t0
$Config.QuietHoursEnabled = $true
$Config.QuietHoursStart = '23:00'; $Config.QuietHoursEnd = '08:00'
if (Test-ShouldMuteTaskCompleteSound ([DateTime]::new(2026, 11, 18, 22, 59, 0))) { throw 'P6: 22:59 should NOT mute' }
if (-not (Test-ShouldMuteTaskCompleteSound ([DateTime]::new(2026, 11, 18, 23, 0, 0)))) { throw 'P6: 23:00 MUST mute (start inclusive)' }
if (-not (Test-ShouldMuteTaskCompleteSound ([DateTime]::new(2026, 11, 19, 7, 59, 0)))) { throw 'P6: 07:59 MUST mute' }
if (Test-ShouldMuteTaskCompleteSound ([DateTime]::new(2026, 11, 19, 8, 0, 0))) { throw 'P6: 08:00 should NOT mute (end exclusive)' }

$Config.QuietHoursStart = '12:30'; $Config.QuietHoursEnd = '14:00'
if (Test-ShouldMuteTaskCompleteSound ([DateTime]::new(2026, 11, 18, 12, 29, 0))) { throw 'P6: 12:29 should NOT mute' }
if (-not (Test-ShouldMuteTaskCompleteSound ([DateTime]::new(2026, 11, 18, 12, 30, 0)))) { throw 'P6: 12:30 MUST mute' }
if (Test-ShouldMuteTaskCompleteSound ([DateTime]::new(2026, 11, 18, 14, 0, 0))) { throw 'P6: 14:00 should NOT mute' }

# Same start==end & malformed inputs -> empty/disabled fallback (do not throw, do not mute)
foreach ($pair in @(@('23:00','23:00'), @('25:99','08:00'), @('abc','24:00'))) {
    $Config.QuietHoursStart = $pair[0]; $Config.QuietHoursEnd = $pair[1]
    if (Test-ShouldMuteTaskCompleteSound ([DateTime]::new(2026, 11, 18, 23, 30, 0))) {
        throw "P6 failed: invalid/empty range $($pair[0])-$($pair[1]) must not mute"
    }
}

# --- P7: AC-01, AC-02, AC-03 回归边界 (取消重放、旧轮延迟串轮、同批排列无关 + 真实后端链路) ---
# 7a. AC-01: cancelled on stalled/working consumes eventId so replaying exact snapshot never re-arms; new turn still rings
Reset-TestClock $t0
$t0Ms = ([DateTimeOffset]$t0).ToUnixTimeMilliseconds()
$ac1Comp = Make-Comp 'Codex' 'ac1.jsonl' 'turn1' 'completed' $true ($t0Ms + 2200) ($t0Ms + 100)
$stAc1Work = [pscustomobject]@{ state = 'working'; at = $t0Ms + 1000; sessionSnapshots = @(Make-Snap 'Codex' 'ac1.jsonl' 'working' ($t0Ms + 1000)) }
$stAc1Done = [pscustomobject]@{ state = 'success'; at = $t0Ms + 2200; sessionSnapshots = @(Make-Snap 'Codex' 'ac1.jsonl' 'success' ($t0Ms + 2200) $ac1Comp) }
$stAc1Stall = [pscustomobject]@{ state = 'stalled'; at = $t0Ms + 2800; sessionSnapshots = @(Make-Snap 'Codex' 'ac1.jsonl' 'stalled' ($t0Ms + 2800)) }
Update-TaskCompletionTracker $stAc1Work ($t0Ms + 1000) ($t0.AddMilliseconds(1000))
Update-TaskCompletionTracker $stAc1Done ($t0Ms + 2200) ($t0.AddMilliseconds(2200))
Update-TaskCompletionTracker $stAc1Stall ($t0Ms + 2800) ($t0.AddMilliseconds(2800))
if (-not (Test-IsCompletionConsumed $ac1Comp.eventId)) { throw 'P7 AC-01 failed: stalled cancellation must consume cancelled eventId' }
Update-TaskCompletionTracker $stAc1Done ($t0Ms + 3200) ($t0.AddMilliseconds(3200))
if ($null -ne $script:pendingTaskCompleteDueUtc) { throw 'P7 AC-01 failed: replaying cancelled completion must NOT re-arm pending due' }
$script:lastStatusHeartbeatMs = $t0Ms + 3200
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(6)) $dayLocal)
if ($script:playedCalls.Count -ne 0) { throw "P7 AC-01 failed: replayed cancelled completion expected 0 chimes, got $($script:playedCalls.Count)" }
# Subsequent real new turn still rings once
$ac1Comp2 = Make-Comp 'Codex' 'ac1.jsonl' 'turn2' 'completed' $true ($t0Ms + 8000) ($t0Ms + 2800)
$stAc1Done2 = [pscustomobject]@{ state = 'success'; at = $t0Ms + 8000; sessionSnapshots = @(Make-Snap 'Codex' 'ac1.jsonl' 'success' ($t0Ms + 8000) $ac1Comp2) }
Update-TaskCompletionTracker $stAc1Done2 ($t0Ms + 8000) ($t0.AddMilliseconds(8000))
$script:lastStatusHeartbeatMs = $t0Ms + 8000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(10.5)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P7 AC-01 failed: subsequent real turn2 expected 1 chime, got $($script:playedCalls.Count)" }

# 7b. AC-01: PauseMonitorUntil consumes pending completion so unpause + replay yields 0; also peer session preservation check
Reset-TestClock $t0
Update-TaskCompletionTracker $stAc1Work ($t0Ms + 1000) ($t0.AddMilliseconds(1000))
Update-TaskCompletionTracker $stAc1Done ($t0Ms + 2200) ($t0.AddMilliseconds(2200))
$Config.PauseMonitorUntil = $t0Ms + 600000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(2.6)) $dayLocal)
if (-not (Test-IsCompletionConsumed $ac1Comp.eventId)) { throw 'P7 AC-01 failed: Pause cancellation must consume pending eventId' }
$Config.PauseMonitorUntil = 0
Update-TaskCompletionTracker $stAc1Done ($t0Ms + 3200) ($t0.AddMilliseconds(3200))
$script:lastStatusHeartbeatMs = $t0Ms + 3200
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(6)) $dayLocal)
if ($script:playedCalls.Count -ne 0) { throw "P7 AC-01 failed: pause replay expected 0 chimes, got $($script:playedCalls.Count)" }

# Peer preservation: A completes, B enters working during A's debounce window -> A stays unconsumed until B finishes cleanly!
Reset-TestClock $t0
$compPeerA = Make-Comp 'Codex' 'pa.jsonl' 'tA' 'completed' $true ($t0Ms + 2200) ($t0Ms + 100)
$compPeerB = Make-Comp 'Codex' 'pb.jsonl' 'tB' 'completed' $true ($t0Ms + 5000) ($t0Ms + 2600)
Update-TaskCompletionTracker ([pscustomobject]@{ state='working'; at=$t0Ms+1000; sessionSnapshots=@((Make-Snap 'Codex' 'pa.jsonl' 'working' ($t0Ms+1000))) }) ($t0Ms+1000) ($t0.AddMilliseconds(1000))
Update-TaskCompletionTracker ([pscustomobject]@{ state='success'; at=$t0Ms+2200; sessionSnapshots=@((Make-Snap 'Codex' 'pa.jsonl' 'success' ($t0Ms+2200) $compPeerA)) }) ($t0Ms+2200) ($t0.AddMilliseconds(2200))
Update-TaskCompletionTracker ([pscustomobject]@{ state='working'; at=$t0Ms+2600; sessionSnapshots=@((Make-Snap 'Codex' 'pa.jsonl' 'success' ($t0Ms+2200) $compPeerA), (Make-Snap 'Codex' 'pb.jsonl' 'working' ($t0Ms+2600))) }) ($t0Ms+2600) ($t0.AddMilliseconds(2600))
if (Test-IsCompletionConsumed $compPeerA.eventId) { throw 'P7 AC-01 failed: peer A must NOT be consumed when peer B becomes active' }
Update-TaskCompletionTracker ([pscustomobject]@{ state='success'; at=$t0Ms+5000; sessionSnapshots=@((Make-Snap 'Codex' 'pb.jsonl' 'success' ($t0Ms+5000) $compPeerB)) }) ($t0Ms+5000) ($t0.AddMilliseconds(5000))
$script:lastStatusHeartbeatMs = $t0Ms + 5000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(7.2)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P7 AC-01 peer batch expected 1 chime, got $($script:playedCalls.Count)" }

# 7c. AC-02: unobserved old-turn completion arriving after newer active work is rejected & keeps active state
Reset-TestClock $t0
Update-TaskCompletionTracker ([pscustomobject]@{ state='working'; at=$t0Ms+3000; sessionSnapshots=@((Make-Snap 'Codex' 'ac2.jsonl' 'working' ($t0Ms+3000))) }) ($t0Ms+3000) ($t0.AddMilliseconds(3000))
$staleOldComp = Make-Comp 'Codex' 'ac2.jsonl' 'old-turn' 'completed' $true ($t0Ms+2000) ($t0Ms+100)
Update-TaskCompletionTracker ([pscustomobject]@{ state='success'; at=$t0Ms+3500; sessionSnapshots=@((Make-Snap 'Codex' 'ac2.jsonl' 'success' ($t0Ms+2000) $staleOldComp)) }) ($t0Ms+3500) ($t0.AddMilliseconds(3500))
$script:lastStatusHeartbeatMs = $t0Ms + 3500
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(6)) $dayLocal)
if ($script:playedCalls.Count -ne 0) { throw "P7 AC-02 failed: stale old-turn completion must produce 0 chimes, got $($script:playedCalls.Count)" }
if (-not ($script:activeWorkCohort.ContainsKey('Codex|ac2.jsonl') -and $script:activeWorkCohort['Codex|ac2.jsonl'].Status -eq 'active')) {
    throw 'P7 AC-02 failed: rejected stale old-turn completion must NOT clear active turn status'
}
$realNewComp = Make-Comp 'Codex' 'ac2.jsonl' 'new-turn' 'completed' $true ($t0Ms+6500) ($t0Ms+3000)
Update-TaskCompletionTracker ([pscustomobject]@{ state='success'; at=$t0Ms+6500; sessionSnapshots=@((Make-Snap 'Codex' 'ac2.jsonl' 'success' ($t0Ms+6500) $realNewComp)) }) ($t0Ms+6500) ($t0.AddMilliseconds(6500))
$script:lastStatusHeartbeatMs = $t0Ms + 6500
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(8.7)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P7 AC-02 failed: subsequent real new-turn completion expected 1 chime, got $($script:playedCalls.Count)" }

# 7d. AC-03: same-batch terminal snapshots must produce identical results under all array orderings + reversed timestamps + ties
foreach ($spec in @(
    @{ Name = 'A2000_Babort2100'; GoodAt = 2000; BadAt = 2100; Expected = 0 },
    @{ Name = 'Babort2000_A2100'; GoodAt = 2100; BadAt = 2000; Expected = 1 },
    @{ Name = 'SameTimeTie2000';  GoodAt = 2000; BadAt = 2000; Expected = 0 }
)) {
    foreach ($rev in @($false, $true)) {
        Reset-TestClock $t0
        $wBoth = [pscustomobject]@{ state='working'; at=$t0Ms+1000; sessionSnapshots=@((Make-Snap 'Codex' 'oa.jsonl' 'working' ($t0Ms+1000)), (Make-Snap 'Codex' 'ob.jsonl' 'working' ($t0Ms+1000))) }
        Update-TaskCompletionTracker $wBoth ($t0Ms+1000) ($t0.AddMilliseconds(1000))
        $gSnap = Make-Snap 'Codex' 'oa.jsonl' 'success' ($t0Ms + $spec.GoodAt) (Make-Comp 'Codex' 'oa.jsonl' 'tA' 'completed' $true ($t0Ms + $spec.GoodAt) ($t0Ms + 100))
        $bSnap = Make-Snap 'Codex' 'ob.jsonl' 'idle' ($t0Ms + $spec.BadAt) (Make-Comp 'Codex' 'ob.jsonl' 'tB' 'aborted' $true ($t0Ms + $spec.BadAt) ($t0Ms + 200))
        $arr = if ($rev) { @($bSnap, $gSnap) } else { @($gSnap, $bSnap) }
        Update-TaskCompletionTracker ([pscustomobject]@{ state='idle'; at=$t0Ms+2200; sessionSnapshots=$arr }) ($t0Ms+2200) ($t0.AddMilliseconds(2200))
        $script:lastStatusHeartbeatMs = $t0Ms + 2200
        [void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(4.5)) $dayLocal)
        if ($script:playedCalls.Count -ne $spec.Expected) {
            throw "P7 AC-03 failed ($($spec.Name) reverse=$rev): expected $($spec.Expected) chimes, got $($script:playedCalls.Count)"
        }
    }
}

# 7e. End-to-end Node backend packets -> PS1 state machine (T6 parallel aborted & delayed old-turn -> new-turn)
$bPkts = Get-Content -LiteralPath '${backendJsonEsc}' -Raw -Encoding UTF8 | ConvertFrom-Json
Reset-TestClock ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$bPkts.baseMs).UtcDateTime)
foreach ($p in $bPkts.parallelAbortTailPackets) {
    $utc = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$p.at).UtcDateTime
    Update-TaskCompletionTracker $p ([long]$p.at) $utc
    $script:lastStatusHeartbeatMs = [long]$p.at
}
[void](Invoke-AgentMonitorTickTail ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$bPkts.baseMs + 4500).UtcDateTime) $dayLocal)
if ($script:playedCalls.Count -ne 0) { throw "P7 backend->PS1 parallel abort tail expected 0 chimes, got $($script:playedCalls.Count)" }

Reset-TestClock ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$bPkts.baseMs).UtcDateTime)
$replayCount = 0
foreach ($p in $bPkts.latePackets) {
    $utc = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$p.at).UtcDateTime
    Update-TaskCompletionTracker $p ([long]$p.at) $utc
    $script:lastStatusHeartbeatMs = [long]$p.at
    if ($p.state -eq 'thinking' -and $null -eq $p.completion) {
        [void](Invoke-AgentMonitorTickTail ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$p.at + 2200).UtcDateTime) $dayLocal)
        if ($script:playedCalls.Count -ne 0) { throw 'P7 backend->PS1 old-turn replay must stay at 0 chimes' }
    }
}
$lastLateMs = [long]($bPkts.latePackets[-1].at)
[void](Invoke-AgentMonitorTickTail ([DateTimeOffset]::FromUnixTimeMilliseconds($lastLateMs + 2200).UtcDateTime) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P7 backend->PS1 real new-turn completion expected 1 chime, got $($script:playedCalls.Count)" }

# Rapid sequential turns (A active -> B started & completed between polls) backend -> PS1 end-to-end
Reset-TestClock ([DateTimeOffset]::FromUnixTimeMilliseconds([long]$bPkts.baseMs).UtcDateTime)
foreach ($p in $bPkts.rapidPackets) {
    $utc = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$p.at).UtcDateTime
    Update-TaskCompletionTracker $p ([long]$p.at) $utc
    $script:lastStatusHeartbeatMs = [long]$p.at
}
if (-not ($script:activeWorkCohort.ContainsKey('Codex|rollout-rapid.jsonl') -and $script:activeWorkCohort['Codex|rollout-rapid.jsonl'].Status -eq 'completed' -and $script:activeWorkCohort['Codex|rollout-rapid.jsonl'].ActiveTurnId -eq 'id:B')) {
    throw 'P7 backend->PS1 rapid sequential: expected cohort accepted B as completed'
}
$lastRapidMs = [long]($bPkts.rapidPackets[-1].at)
[void](Invoke-AgentMonitorTickTail ([DateTimeOffset]::FromUnixTimeMilliseconds($lastRapidMs + 2200).UtcDateTime) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P7 backend->PS1 rapid sequential expected 1 chime, got $($script:playedCalls.Count)" }

# 7f. Direct PS1 boundary matrix: delayed old turn vs rapid subsequent turn (completed + aborted + during settle window)
# (1) Delayed old turn with explicit newer eventAt (3500 > 3100) still rejected because compTurnStart (100) < ActiveTurnStartedAtMs (3000)
Reset-TestClock $t0
Update-TaskCompletionTracker ([pscustomobject]@{ state='thinking'; at=$t0Ms+3100; sessionSnapshots=@((Make-Snap 'Codex' 'seq.jsonl' 'thinking' ($t0Ms+3100) $null 'id:new' ($t0Ms+3000))) }) ($t0Ms+3100) ($t0.AddMilliseconds(3100))
$oldTurnLateStamp = Make-Comp 'Codex' 'seq.jsonl' 'id:old' 'completed' $true ($t0Ms+3500) ($t0Ms+100)
Update-TaskCompletionTracker ([pscustomobject]@{ state='success'; at=$t0Ms+3500; sessionSnapshots=@((Make-Snap 'Codex' 'seq.jsonl' 'success' ($t0Ms+3500) $oldTurnLateStamp)) }) ($t0Ms+3500) ($t0.AddMilliseconds(3500))
$script:lastStatusHeartbeatMs = $t0Ms + 3500
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(6)) $dayLocal)
if ($script:playedCalls.Count -ne 0 -or $script:activeWorkCohort['Codex|seq.jsonl'].Status -ne 'active') {
    throw "P7 rapid-vs-late failed (1): older compTurnStart must stay rejected and keep active status"
}

# (2) Rapid subsequent turn B completing inside turn A's settle window (completed A -> rapid completed B without active poll)
Reset-TestClock $t0
$cSeqA = Make-Comp 'Codex' 'seq2.jsonl' 'id:A' 'completed' $true ($t0Ms+1500) ($t0Ms+100)
$cSeqB = Make-Comp 'Codex' 'seq2.jsonl' 'id:B' 'completed' $true ($t0Ms+2100) ($t0Ms+1700)
Update-TaskCompletionTracker ([pscustomobject]@{ state='thinking'; at=$t0Ms+1000; sessionSnapshots=@((Make-Snap 'Codex' 'seq2.jsonl' 'thinking' ($t0Ms+1000) $null 'id:A' ($t0Ms+100))) }) ($t0Ms+1000) ($t0.AddMilliseconds(1000))
Update-TaskCompletionTracker ([pscustomobject]@{ state='success'; at=$t0Ms+1500; sessionSnapshots=@((Make-Snap 'Codex' 'seq2.jsonl' 'success' ($t0Ms+1500) $cSeqA)) }) ($t0Ms+1500) ($t0.AddMilliseconds(1500))
Update-TaskCompletionTracker ([pscustomobject]@{ state='success'; at=$t0Ms+2100; sessionSnapshots=@((Make-Snap 'Codex' 'seq2.jsonl' 'success' ($t0Ms+2100) $cSeqB)) }) ($t0Ms+2100) ($t0.AddMilliseconds(2100))
if (-not (Test-IsCompletionConsumed $cSeqA.eventId)) { throw 'P7 rapid-vs-late failed (2): superseded A eventId must be consumed' }
$script:lastStatusHeartbeatMs = $t0Ms + 2100
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(4.3)) $dayLocal)
if ($script:playedCalls.Count -ne 1 -or -not (Test-IsCompletionConsumed $cSeqB.eventId)) {
    throw "P7 rapid-vs-late failed (2): rapid B replacing pending A expected 1 chime, got $($script:playedCalls.Count)"
}

# (3) Delayed old abort must NOT abort active/pending new turn; rapid subsequent turn abort MUST clear without chiming
Reset-TestClock $t0
$oldAbort = Make-Comp 'Codex' 'seq3.jsonl' 'id:old' 'aborted' $true ($t0Ms+3200) ($t0Ms+50)
$newDone = Make-Comp 'Codex' 'seq3.jsonl' 'id:new' 'completed' $true ($t0Ms+3800) ($t0Ms+3000)
Update-TaskCompletionTracker ([pscustomobject]@{ state='thinking'; at=$t0Ms+3100; sessionSnapshots=@((Make-Snap 'Codex' 'seq3.jsonl' 'thinking' ($t0Ms+3100) $null 'id:new' ($t0Ms+3000))) }) ($t0Ms+3100) ($t0.AddMilliseconds(3100))
Update-TaskCompletionTracker ([pscustomobject]@{ state='idle'; at=$t0Ms+3200; sessionSnapshots=@((Make-Snap 'Codex' 'seq3.jsonl' 'idle' ($t0Ms+3200) $oldAbort)) }) ($t0Ms+3200) ($t0.AddMilliseconds(3200))
if ($script:activeWorkCohort['Codex|seq3.jsonl'].Status -ne 'active') { throw 'P7 rapid-vs-late failed (3): delayed old abort must not kill active new turn' }
Update-TaskCompletionTracker ([pscustomobject]@{ state='success'; at=$t0Ms+3800; sessionSnapshots=@((Make-Snap 'Codex' 'seq3.jsonl' 'success' ($t0Ms+3800) $newDone)) }) ($t0Ms+3800) ($t0.AddMilliseconds(3800))
Update-TaskCompletionTracker ([pscustomobject]@{ state='idle'; at=$t0Ms+3900; sessionSnapshots=@((Make-Snap 'Codex' 'seq3.jsonl' 'idle' ($t0Ms+3900) $oldAbort)) }) ($t0Ms+3900) ($t0.AddMilliseconds(3900))
$script:lastStatusHeartbeatMs = $t0Ms + 3900
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(6.1)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P7 rapid-vs-late failed (3): delayed old abort during settle window expected 1 chime, got $($script:playedCalls.Count)" }

Reset-TestClock $t0
$rapidAbortB = Make-Comp 'Codex' 'seq4.jsonl' 'id:B' 'aborted' $true ($t0Ms+2000) ($t0Ms+1600)
Update-TaskCompletionTracker ([pscustomobject]@{ state='thinking'; at=$t0Ms+1000; sessionSnapshots=@((Make-Snap 'Codex' 'seq4.jsonl' 'thinking' ($t0Ms+1000) $null 'id:A' ($t0Ms+100))) }) ($t0Ms+1000) ($t0.AddMilliseconds(1000))
Update-TaskCompletionTracker ([pscustomobject]@{ state='idle'; at=$t0Ms+2000; sessionSnapshots=@((Make-Snap 'Codex' 'seq4.jsonl' 'idle' ($t0Ms+2000) $rapidAbortB)) }) ($t0Ms+2000) ($t0.AddMilliseconds(2000))
$script:lastStatusHeartbeatMs = $t0Ms + 2000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(4.3)) $dayLocal)
if ($script:playedCalls.Count -ne 0 -or $script:activeWorkCohort.Count -ne 0) {
    throw "P7 rapid-vs-late failed (3b): rapid subsequent abort B must clear cohort with 0 chimes"
}

# --- P8: AntigravityTranscriptCompleteEnabled=$false suppresses AG chime; =$true chimes after 3.5s settle ---
Reset-TestClock $t0
$Config.AntigravityTranscriptCompleteEnabled = $false
$agCompOff = Make-Comp 'Antigravity' 'ag1.db' 'tx-turn:1' 'completed' $false ($t0Ms + 2000) ($t0Ms + 100) $true
Update-TaskCompletionTracker ([pscustomobject]@{ state='working'; at=$t0Ms+1000; sessionSnapshots=@((Make-Snap 'Antigravity' 'ag1.db' 'working' ($t0Ms+1000))) }) ($t0Ms+1000) ($t0.AddSeconds(1))
Update-TaskCompletionTracker ([pscustomobject]@{ state='success'; at=$t0Ms+2000; sessionSnapshots=@((Make-Snap 'Antigravity' 'ag1.db' 'success' ($t0Ms+2000) $agCompOff)) }) ($t0Ms+2000) ($t0.AddSeconds(2))
$script:lastStatusHeartbeatMs = $t0Ms + 2000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(7.0)) $dayLocal)
if ($script:playedCalls.Count -ne 0) { throw "P8 failed: AG toggle false must stay silent, got $($script:playedCalls.Count)" }

Reset-TestClock $t0
$Config.AntigravityTranscriptCompleteEnabled = $true
$agCompOn = Make-Comp 'Antigravity' 'ag2.db' 'tx-turn:2' 'completed' $false ($t0Ms + 2000) ($t0Ms + 100) $true
Update-TaskCompletionTracker ([pscustomobject]@{ state='working'; at=$t0Ms+1000; sessionSnapshots=@((Make-Snap 'Antigravity' 'ag2.db' 'working' ($t0Ms+1000))) }) ($t0Ms+1000) ($t0.AddSeconds(1))
Update-TaskCompletionTracker ([pscustomobject]@{ state='success'; at=$t0Ms+2000; sessionSnapshots=@((Make-Snap 'Antigravity' 'ag2.db' 'success' ($t0Ms+2000) $agCompOn)) }) ($t0Ms+2000) ($t0.AddSeconds(2))
$script:lastStatusHeartbeatMs = $t0Ms + 2000
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(5.0)) $dayLocal)
if ($script:playedCalls.Count -ne 0) { throw "P8 failed: AG completion must wait full 3.5s settle before chiming" }
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(5.7)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P8 failed: AG toggle true expected 1 chime after 3.5s settle, got $($script:playedCalls.Count)" }

# --- P8b: DSH late turn/end transition (step_only -> completed) chimes cleanly once without replay ---
Reset-TestClock $t0
Update-TaskCompletionTracker ([pscustomobject]@{ state='working'; at=$t0Ms+100; sessionSnapshots=@((Make-Snap 'DSH' 'late-dsh.json' 'working' ($t0Ms+100) $null 'dsh-turn:4' ($t0Ms+50))) }) ($t0Ms+100) ($t0.AddMilliseconds(100))
$dshStepOnly = Make-Comp 'DSH' 'late-dsh.json' 'dsh-turn:4' 'step_only' $false ($t0Ms+200) ($t0Ms+50)
Update-TaskCompletionTracker ([pscustomobject]@{ state='success'; at=$t0Ms+200; sessionSnapshots=@((Make-Snap 'DSH' 'late-dsh.json' 'success' ($t0Ms+200) $dshStepOnly 'dsh-turn:4' ($t0Ms+50))) }) ($t0Ms+200) ($t0.AddMilliseconds(200))
$script:lastStatusHeartbeatMs = $t0Ms + 200
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(2.3)) $dayLocal)
if ($script:playedCalls.Count -ne 0) { throw "P8b failed: step_only alone must remain silent" }
$dshStrictDone = Make-Comp 'DSH' 'late-dsh.json' 'dsh-turn:4' 'completed' $true ($t0Ms+2300) ($t0Ms+50)
Update-TaskCompletionTracker ([pscustomobject]@{ state='success'; at=$t0Ms+2300; sessionSnapshots=@((Make-Snap 'DSH' 'late-dsh.json' 'success' ($t0Ms+2300) $dshStrictDone 'dsh-turn:4' ($t0Ms+50))) }) ($t0Ms+2300) ($t0.AddMilliseconds(2300))
$script:lastStatusHeartbeatMs = $t0Ms + 2300
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(4.5)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P8b failed: late strict completed must chime once, got $($script:playedCalls.Count)" }
Update-TaskCompletionTracker ([pscustomobject]@{ state='success'; at=$t0Ms+5200; sessionSnapshots=@((Make-Snap 'DSH' 'late-dsh.json' 'success' ($t0Ms+5200) $dshStrictDone 'dsh-turn:4' ($t0Ms+50))) }) ($t0Ms+5200) ($t0.AddMilliseconds(5200))
[void](Invoke-AgentMonitorTickTail ($t0.AddSeconds(7.5)) $dayLocal)
if ($script:playedCalls.Count -ne 1) { throw "P8b failed: repeat poll must not replay chime, got $($script:playedCalls.Count)" }

# --- P9: Play-PressSound / Play-ReleaseSound mutually stop each other on rapid double-click ---
Invoke-Expression (Extract-FunctionDef 'Play-PressSound')
Invoke-Expression (Extract-FunctionDef 'Play-ReleaseSound')
$script:audioTrace = New-Object System.Collections.ArrayList
$script:maxConcurrentPlayers = 0
function New-SpyPlayer([string]$tag) {
    $p = New-Object PSObject -Property @{ Tag = $tag; Playing = $false; Volume = 1.0; Position = [TimeSpan]::Zero }
    $p | Add-Member -MemberType ScriptMethod -Name Stop -Value {
        $this.Playing = $false
        [void]$script:audioTrace.Add("$($this.Tag).Stop")
    }
    $p | Add-Member -MemberType ScriptMethod -Name Play -Value {
        $this.Playing = $true
        $activeCount = 0
        if ($script:PressPlayer.Playing) { $activeCount++ }
        if ($script:ReleasePlayer.Playing) { $activeCount++ }
        if ($activeCount -gt $script:maxConcurrentPlayers) { $script:maxConcurrentPlayers = $activeCount }
        [void]$script:audioTrace.Add("$($this.Tag).Play(active=$activeCount)")
    }
    return $p
}
$script:PressPlayer = New-SpyPlayer 'Press'
$script:ReleasePlayer = New-SpyPlayer 'Release'
$Config.SoundEnabled = $true
Play-PressSound
Play-ReleaseSound
Play-PressSound
Play-ReleaseSound
if ($script:maxConcurrentPlayers -ne 1) {
    throw "P9 failed: rapid double-click expected maxConcurrentPlayers=1, got $($script:maxConcurrentPlayers) trace=$($script:audioTrace -join ',')"
}
if (($script:audioTrace -join '|') -ne 'Release.Stop|Press.Stop|Press.Play(active=1)|Press.Stop|Release.Stop|Release.Play(active=1)|Release.Stop|Press.Stop|Press.Play(active=1)|Press.Stop|Release.Stop|Release.Play(active=1)') {
    throw "P9 failed: unexpected click player sequence: $($script:audioTrace -join '|')"
}
$script:audioTrace.Clear()
$Config.SoundEnabled = $false
Play-PressSound
Play-ReleaseSound
if ($script:audioTrace.Count -ne 0) { throw "P9 failed: SoundEnabled=false must produce 0 calls" }

Write-Output 'PASS: PS1 task-complete state machine, mute/DND & audio checks'
`;

    fs.writeFileSync(psRunner, psScript, 'utf8');
    const psRes = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psRunner],
      { encoding: 'utf8', timeout: 30000 }
    );
    if (psRes.status !== 0) {
      throw new Error(`PS1 headless verification failed (status=${psRes.status}):\nSTDOUT:\n${psRes.stdout}\nSTDERR:\n${psRes.stderr}`);
    }
    assert.ok(psRes.stdout.includes('PASS: PS1 task-complete state machine'));
    console.log('[PASS] P0~P9: PS1 无头真实状态机 + 二级静音 + 免打扰边界 + DSH晚到/连击防重叠全链路回归验证通过');
  }

  console.log('\nAll task-complete-sound assertions passed.');
} catch (err) {
  console.error('[task-complete-sound.test.mjs FAILURE]:', err?.stack || err);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}
