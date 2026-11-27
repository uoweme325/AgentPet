import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';

// Import in probe mode so isolated replays never write to the running pet's log.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpet-dsh-approval-'));
const diagnosticLog = path.join(base, 'monitor.log');
process.argv.push('--test-scan', '--log-file', diagnosticLog);
const { AgentMonitor } = await import('../runtime/agent-monitor.mjs');

function replay(format) {
  const root = path.join(base, format);
  const sessions = path.join(root, 'storages', 'session_projcache', 'sessions');
  const journal = path.join(root, 'sessions', 'workspace', 'session-replay');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(journal, { recursive: true });
  const projection = path.join(sessions, 'session-replay.json');
  const log = path.join(journal, 'session.v4.jsonl' + (format === 'zstd' ? '.zstd' : ''));
  const events = [];
  let now = Date.now();
  const start = now;
  let monitor = new AgentMonitor({ isProbe: true });
  monitor.paths.dshDirs = [sessions];
  function writeProjection(turn, calls, openStep = null) {
    const rows = {
      turnBoundary: { val: { lastTurn: turn, openTurnStartSeq: 1 } },
      sessionStats: { val: { pendingCalls: calls, openStep } },
      userQuestions: { val: { questions: { active: [] } } }
    };
    fs.writeFileSync(projection, JSON.stringify({ record: { rows } }));
    fs.utimesSync(projection, now / 1000, now / 1000);
  }
  function append(type, data) {
    events.push({ type, data, seq: events.length + 1, time: now });
    const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n');
    fs.writeFileSync(log, format === 'zstd' ? zlib.zstdCompressSync(bytes) : bytes);
    fs.utimesSync(log, now / 1000, now / 1000);
  }
  function expect(state, label) {
    const actual = monitor.checkDsh(now + 100);
    assert.equal(actual?.state, state, format + ' ' + label);
    assert.equal(actual.sessions[0].state, state);
    now += 2100;
    return actual;
  }
  writeProjection(4, { call_a: start });
  append('turn/start', { turn: 4 });
  append('tool/call', { turn: 4, callId: 'call_a', name: 'shell' });
  expect('working', 'ordinary tool');
  append('approval/asked', { id: 'a', callId: 'call_a', toolName: 'shell', reason: 'need permission to write' });
  assert.match(expect('approval', 'log-only approval').taskDetail, /need permission to write/);
  now += 310000;
  expect('approval', 'open request survives a long user pause');
  const cold = new AgentMonitor({ isProbe: true });
  cold.paths.dshDirs = [sessions];
  assert.equal(cold.checkDsh(now)?.state, 'approval', 'restart during the same open approval');
  append('approval/decided', { id: 'a', outcome: 'allowed-once' });
  expect('working', 'allowed tool resumes after a long pause');
  append('tool/result', { message: { toolCallId: 'call_a' } });
  expect('thinking', 'tool result arrives before projection');

  writeProjection(4, { call_b: now, call_c: now });
  append('approval/asked', { id: 'b', callId: 'call_b', toolName: 'shell' });
  append('approval/asked', { id: 'c', callId: 'call_c', toolName: 'shell' });
  expect('approval', 'parallel approvals');
  append('approval/decided', { id: 'unknown', outcome: 'denied' });
  append('approval/decided', { id: 'c', outcome: 'denied' });
  expect('approval', 'one approval still pending');
  append('approval/decided', { id: 'b', outcome: 'denied' });
  append('tool/result', { message: { toolCallId: 'call_b', isError: true } });
  append('tool/result', { message: { toolCallId: 'call_c', isError: true } });
  expect('thinking', 'denied calls settled but turn continues');
  // DSH Desktop emits "aborted" when stopping and archiving a pending approval.
  append('turn/end', { turn: 4, reason: { kind: 'aborted' } });
  const end = expect('idle', 'interrupted turn despite stale open projection');
  assert.equal(end.completion.outcome, 'aborted');

  writeProjection(5, { call_d: now });
  append('turn/start', { turn: 5 });
  append('approval/asked', { id: 'd', callId: 'call_d', toolName: 'shell' });
  expect('approval', 'fresh turn');
  append('tool/result', { message: { toolCallId: 'call_d' } });
  append('turn/end', { turn: 5, reason: { kind: 'completed' } });
  assert.equal(expect('success', 'completion without decision record').completion.strictTurnEnd, true);
  writeProjection(6, { call_e: now });
  expect('working', 'a previous turn cannot complete or hold a new one');
  writeProjection(7, {});
  append('turn/start', { turn: 7 });
  append('approval/asked', { id: 'late', callId: 'call_late', toolName: 'shell' });
  expect('approval', 'approval arrives before the call enters the projection');
  append('approval/decided', { id: 'late', outcome: 'allowed-once' });
  expect('working', 'allowed call resumes even while the projection lags');
  append('turn/end', { turn: 7, reason: { kind: 'error', error: { message: 'sample error' } } });
  assert.equal(expect('error', 'authoritative turn failure').completion.outcome, 'failed');
  const rows = { userQuestions: { val: { questions: { active: [{ question: 'Choose one' }] } } } };
  fs.writeFileSync(projection, JSON.stringify({ record: { rows } }));
  fs.utimesSync(projection, now / 1000, now / 1000);
  // A legacy projection may have no durable journal.
  fs.unlinkSync(log);
  expect('waiting', 'ordinary question keeps its separate UI state');
  now = Date.now();
  writeProjection(8, { call_ui: now });
  append('turn/start', { turn: 8 });
  append('approval/asked', { id: 'ui', callId: 'call_ui', toolName: 'shell' });
  let payload;
  const live = new AgentMonitor({ isProbe: true, onChange: data => { payload = data; } });
  live.paths.dshDirs = [sessions];
  live.checkAntigravity = () => null;
  live.checkCodex = () => ({ source: 'Codex', state: 'working', task: 'sample', at: now });
  live.scan();
  assert.equal(payload?.source, 'DSH');
  assert.equal(payload?.state, 'approval');
  assert.equal(payload.agents.dsh.state, 'approval');
  assert.equal(payload.sessionSnapshots.find(s => s.source === 'DSH').state, 'approval');
  monitor = live;

  // Nothing after the decision implies execution: deliberately withhold tool/result.
  for (const outcome of ['rejected', 'cancelled', 'denied', 'deny', 'expired', 'unavailable', 'future-value', '', undefined, 'allowed-unknown']) {
    now += 2100;
    writeProjection(9, { call_x: now }, { startTime: now - 2000, firstTokenTime: now - 1000 });
    append('turn/start', { turn: 9 });
    append('approval/asked', { id: 'x', callId: 'call_x', toolName: 'shell' });
    expect('approval', 'before decision ' + outcome);
    append('approval/decided', { id: 'x', outcome });
    expect('thinking', 'unconfirmed execution: ' + outcome);
  }
  writeProjection(9, { call_x: now, call_other: now });
  expect('working', 'independently running tool survives rejection');
  writeProjection(9, {}, { startTime: now - 200, firstTokenTime: now - 100 });
  expect('working', 'fresh generation after rejection');
  writeProjection(10, { call_anon: now });
  append('turn/start', { turn: 10 });
  append('approval/asked', { id: 'anon', toolName: 'shell' });
  expect('approval', 'callId is optional in the DSH protocol');
  append('approval/decided', { id: 'anon', outcome: 'unavailable' });
  expect('thinking', 'unattributed pending call is not evidence of execution');

  writeProjection(11, { call_old: now });
  append('turn/start', { turn: 11 });
  append('approval/asked', { id: 'old', callId: 'call_old' });
  const askedAt = now;
  const peer = path.join(sessions, 'session-peer.json');
  function peerWorking(at) {
    fs.writeFileSync(peer, JSON.stringify({ record: { rows: { sessionStats: { val: { pendingCalls: { peer: at } } } } } }));
    fs.utimesSync(peer, at / 1000, at / 1000);
  }
  const timeout = 30 * 60000;
  const countExpiries = () => (fs.readFileSync(diagnosticLog, 'utf8').match(/approval expired/g) || []).length;
  const beforeExpiry = countExpiries();
  peerWorking(askedAt);
  assert.equal(monitor.checkDsh(askedAt + 100)?.state, 'approval');
  peerWorking(askedAt + timeout - 2000);
  assert.equal(monitor.checkDsh(askedAt + timeout - 1)?.state, 'approval');
  for (const elapsed of [timeout, 2 * 3600000, 24 * 3600000]) {
    const at = askedAt + elapsed;
    if (elapsed > timeout) peerWorking(at);
    const warm = monitor.checkDsh(at);
    assert.equal(warm?.rawId, 'session-peer.json', 'old approval cannot outrank live work at ' + elapsed);
    assert.equal(warm.state, 'working');
    if (elapsed === timeout) {
      monitor.checkDsh(at + 10);
      assert.equal(countExpiries(), beforeExpiry + 1, 'log the expiry once across repeated polls');
    }
    const restarted = new AgentMonitor({ isProbe: true });
    restarted.paths.dshDirs = [sessions];
    assert.equal(restarted.checkDsh(at)?.rawId, 'session-peer.json', 'restart cannot revive old approval');
  }
  const staleCache = monitor.dshStateCache.get(projection);
  const retouchedAt = askedAt + 24 * 3600000 + 2100;
  fs.utimesSync(log, retouchedAt / 1000, retouchedAt / 1000);
  peerWorking(retouchedAt);
  assert.equal(monitor.checkDsh(retouchedAt)?.rawId, 'session-peer.json');
  assert.equal(monitor.dshStateCache.get(projection), staleCache, 'stale approval no longer bypasses the candidate age filter');

  now = askedAt + 24 * 3600000 + 3000;
  fs.utimesSync(projection, now / 1000, now / 1000);
  peerWorking(now);
  assert.equal(monitor.checkDsh(now)?.state, 'working', 'touching an old projection must not renew approval');
  now += 2100;
  append('approval/asked', { id: 'old', callId: 'call_old' });
  assert.equal(monitor.checkDsh(now)?.state, 'approval', 'DSH explicitly confirms the request again');
  append('turn/end', { turn: 11, reason: { kind: 'interrupted' } });
  assert.equal(monitor.checkDsh(now + 2100)?.rawId, 'session-peer.json', 'turn end immediately releases live peer');
  if (format === 'zstd') {
    const decompress = zlib.zstdDecompressSync;
    const plainLog = path.join(journal, 'session.v5.jsonl');
    try {
      zlib.zstdDecompressSync = undefined;
      const legacy = new AgentMonitor({ isProbe: true });
      legacy.paths.dshDirs = [sessions];
      assert.equal(legacy.checkDsh(now + 2300)?.rawId, 'session-peer.json');
      legacy.checkDsh(now + 4400);
      assert.equal(fs.readFileSync(diagnosticLog, 'utf8').split('缺少 zlib.zstdDecompressSync').length - 1, 1);
      now += 6500;
      append('turn/start', { turn: 12 });
      append('approval/asked', { id: 'plain', callId: 'call_plain', toolName: 'shell' });
      fs.writeFileSync(plainLog, events.map(event => JSON.stringify(event)).join('\n') + '\n');
      assert.equal(legacy.checkDsh(now)?.state, 'approval', 'plain journal still works without zstd support');
      fs.unlinkSync(plainLog);
    } finally {
      zlib.zstdDecompressSync = decompress;
    }
  }
  now += 4200;
  fs.unlinkSync(peer);
  writeProjection(13, { call_question: now });
  append('turn/start', { turn: 13 });
  append('step/start', { turn: 13, step: 1 });
  append('tool/call', {
    turn: 13, step: 1, callId: 'call_question', name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ question: 'Pick a shape' }] })
  });
  assert.match(expect('waiting', 'real question despite an empty active-question projection').taskDetail, /Pick a shape/);
  append('tool/result', { turn: 13, step: 1, message: { toolCallId: 'call_other' } });
  expect('waiting', 'an unrelated result cannot resolve the question');
  append('tool/result', { turn: 13, step: 1, message: { toolCallId: 'call_question' } });
  expect('thinking', 'answer clears waiting even while the old call remains in the projection');
  writeProjection(13, { call_question: now, call_next: now });
  append('step/end', { turn: 13, step: 1 });
  append('step/start', { turn: 13, step: 2 });
  expect('working', 'the next ordinary tool can work without reviving the old question');
  append('turn/end', { turn: 13, reason: { kind: 'aborted' } });
  assert.equal(expect('idle', 'an aborted turn without approval also ends').completion.outcome, 'aborted');

  writeProjection(14, { call_skew: now });
  append('turn/start', { turn: 14 });
  now += 5000;
  append('approval/asked', { id: 'skew', callId: 'call_skew' });
  const countClockWarnings = () => (fs.readFileSync(diagnosticLog, 'utf8').match(/DSH approval clock skew/g) || []).length;
  const beforeSkew = countClockWarnings();
  assert.notEqual(monitor.checkDsh(now - 3000)?.state, 'approval');
  assert.notEqual(monitor.checkDsh(now - 2001)?.state, 'approval');
  assert.equal(countClockWarnings(), beforeSkew + 1, 'future-dated approval is diagnosed once');
  assert.equal(monitor.checkDsh(now - 2000)?.state, 'approval', 'clock catch-up releases the cached approval without a new file write');

  now += 2100;
  writeProjection(15, { call_valid: now, call_future: now });
  append('turn/start', { turn: 15 });
  append('step/start', { turn: 15, step: 1 });
  append('approval/asked', { id: 'valid', callId: 'call_valid', toolName: 'read' });
  now += 5000;
  append('approval/asked', { id: 'future', callId: 'call_future', toolName: 'write' });
  assert.match(monitor.checkDsh(now - 2001)?.task ?? '', /read/, 'a future request must not mask a valid approval in the same step');
  assert.match(monitor.checkDsh(now - 2000)?.task ?? '', /write/, 'the selected approval can switch between valid requests without a new file write');
  append('approval/decided', { id: 'future', outcome: 'rejected' });
  assert.match(monitor.checkDsh(now + 2100)?.task ?? '', /read/, 'rejecting one request leaves the other approval visible');
  append('approval/decided', { id: 'valid', outcome: 'rejected' });
  assert.equal(monitor.checkDsh(now + 4200)?.state, 'thinking', 'rejecting both requests ends approval without a false running state');
  now += 2100;
  const oldTime = now;
  writeProjection(16, { call_skew: oldTime }, {});
  append('turn/start', { turn: 16 });
  now += 71000;
  append('approval/asked', { id: 'ahead', callId: 'call_skew', toolName: 'write' });
  fs.utimesSync(log, oldTime / 1000, oldTime / 1000);
  monitor.checkDsh(oldTime + 100);
  peerWorking(oldTime + 11000);
  const coldMonitor = new AgentMonitor({ isProbe: true });
  coldMonitor.paths.dshDirs = [sessions];
  for (const reader of [monitor, coldMonitor]) {
    const current = reader.checkDsh(oldTime + 11100);
    assert.equal(current?.rawId, 'session-peer.json', 'a future approval cannot promote an older thinking session');
    assert.equal(current.state, 'working');
    assert.ok(current.sessions.every(s => s.at <= oldTime + 11100), 'no future activity leaks into the session list');
    assert.equal(reader.checkDsh(now - 2000)?.state, 'approval', 'approval still appears when the clock catches up');
  }
  console.log('[PASS] DSH approval lifecycle (' + format + ')');
}

function replayAppendedFrames() {
  const root = path.join(base, 'zstd-frames');
  const session = 'session-frames';
  const sessions = path.join(root, 'storages', 'session_projcache', 'sessions');
  const journalDir = path.join(root, 'sessions', 'workspace', session);
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  const projection = path.join(sessions, session + '.json');
  const log = path.join(journalDir, 'session.v4.jsonl.zstd');
  const monitor = new AgentMonitor({ isProbe: true });
  monitor.paths.dshDirs = [sessions];
  let now = Math.floor(Date.now() / 1000) * 1000;
  let seq = 0;
  const event = (type, data) => JSON.stringify({ type, data, seq: ++seq, time: now }) + '\n';
  const compress = text => zlib.zstdCompressSync(Buffer.from(text));
  const oldFrame = compress(event('assistant/message', { body: randomBytes(160 * 1024).toString('base64') }));
  const turnStart = event('turn/start', { turn: 2 });
  const toolCall = event('tool/call', { turn: 2, callId: 'call_frames', name: 'write' });
  const rows = {
    turnBoundary: { val: { lastTurn: 2, openTurnStartSeq: 2 } },
    sessionStats: { val: { pendingCalls: { call_frames: now } } }
  };
  fs.writeFileSync(projection, JSON.stringify({ record: { rows } }));
  fs.utimesSync(projection, now / 1000, now / 1000);
  // The start record crosses a frame boundary. Together the two frames still cover the current turn.
  fs.writeFileSync(log, Buffer.concat([oldFrame, compress('\n' + turnStart.slice(0, 12)), compress(turnStart.slice(12) + toolCall)]));
  fs.utimesSync(log, now / 1000, now / 1000);
  const readWhole = fs.readFileSync;
  const decompress = zlib.zstdDecompressSync;
  let wholeReads = 0;
  let decodedBytes = 0;
  fs.readFileSync = (file, ...args) => {
    if (file === log) wholeReads++;
    return readWhole(file, ...args);
  };
  zlib.zstdDecompressSync = (bytes, ...args) => {
    decodedBytes += bytes.length;
    return decompress(bytes, ...args);
  };
  try {
    assert.equal(monitor.checkDsh(now)?.state, 'working');
    assert.equal(wholeReads, 1, 'cold scan walks the compressed frame headers');
    assert(decodedBytes < oldFrame.length, 'cold scan skips decompression of the historical frame');
    assert.equal(monitor.dshStateCache.get(projection).journal.zstdOffset, oldFrame.length);
    const openedAt = now + 1000;
    now = openedAt;
    fs.appendFileSync(log, compress(event('approval/asked', { id: 'frames', callId: 'call_frames', toolName: 'write' })));
    fs.utimesSync(log, now / 1000, now / 1000);
    assert.equal(monitor.checkDsh(openedAt + 999)?.state, 'working');
    assert.equal(monitor.checkDsh(openedAt + 1000)?.state, 'approval', 'first eligible scan shows a newly appended approval');
    assert.equal(wholeReads, 1, 'a growing log is only read from the cached frame boundary');

    now = openedAt + 3000;
    const rejection = compress(event('approval/decided', { id: 'frames', outcome: 'rejected' }));
    fs.appendFileSync(log, rejection.subarray(0, 5));
    fs.utimesSync(log, now / 1000, now / 1000);
    assert.equal(monitor.checkDsh(now)?.state, 'approval', 'an incomplete append preserves the last verified state');
    fs.appendFileSync(log, rejection.subarray(5));
    // Keep the same mtime to prove that size changes still invalidate the cached journal.
    fs.utimesSync(log, now / 1000, now / 1000);
    assert.equal(monitor.checkDsh(now + 2000)?.state, 'thinking', 'the first scan of the completed reject frame clears approval');
    assert.equal(wholeReads, 2, 'only the invalid tail required a full-file fallback');

    now += 4000;
    const replacement = compress(event('turn/start', { turn: 2 })
      + event('approval/asked', { id: 'replacement', callId: 'call_frames', toolName: 'write' }));
    fs.writeFileSync(log, replacement);
    fs.utimesSync(log, now / 1000, now / 1000);
    assert.equal(monitor.checkDsh(now)?.state, 'approval', 'a shorter, single-frame replacement is read from the beginning');
    assert.equal(wholeReads, 3, 'a shorter snapshot discards the old offset');
  } finally {
    fs.readFileSync = readWhole;
    zlib.zstdDecompressSync = decompress;
  }
  console.log('[PASS] DSH concatenated zstd frames and approval latency');
}

try {
  replay('jsonl');
  if (typeof zlib.zstdCompressSync === 'function') {
    replay('zstd');
    replayAppendedFrames();
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
