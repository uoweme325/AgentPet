import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpet-async-question-'));
process.argv.push('--log-file', path.join(root, 'monitor.log'));
const { AgentMonitor } = await import('../runtime/agent-monitor.mjs');
const t0 = Date.now();

function createMonitor(name, probe = false) {
  const dir = path.join(root, name);
  const sessions = path.join(dir, 'codex', 'sessions', '2026', '11', '04');
  fs.mkdirSync(sessions, { recursive: true });
  const monitor = new AgentMonitor({ isProbe: probe, onChange: () => {} });
  monitor.paths.codex = path.join(dir, 'codex');
  monitor.paths.appDir = dir;
  return { monitor, dir, sessions };
}

function add(file, event, at = t0) {
  fs.appendFileSync(file, JSON.stringify({ timestamp: new Date(at).toISOString(), ...event }) + '\n');
  fs.utimesSync(file, at / 1000, at / 1000);
}

function call(id, questionCount = 1) {
  return { type: 'response_item', payload: {
    type: 'function_call', name: 'functions.request_user_input_async',
    call_id: id, status: 'completed',
    arguments: JSON.stringify({ questions: Array.from({ length: questionCount }, () => ({ title: 'Question' })) })
  } };
}

function output(id, accepted) {
  return { type: 'response_item', payload: {
    type: 'function_call_output', call_id: id, output: JSON.stringify({ accepted })
  } };
}

function reply(id, index = 0) {
  const questionItemId = JSON.stringify(['request_user_input_async', id, index]);
  const text = `<send_user_message_question_reply>${JSON.stringify([{ questionItemId, answer: '已回答' }])}</send_user_message_question_reply>`;
  return { type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text }]
  } };
}

try {
  // 1. Accepted prompt outranks subsequent assistant commentary, reasoning, and tool outputs within 3s
  const { monitor, dir, sessions } = createMonitor('accepted');
  const file = path.join(sessions, 'rollout-question.jsonl');
  add(file, call('call_one'), t0);
  add(file, output('call_one', true), t0 + 1);
  add(file, { type: 'response_item', payload: {
    type: 'message', role: 'assistant', phase: 'commentary', status: 'completed',
    content: [{ type: 'output_text', text: 'Continuing independent check 1.' }]
  } }, t0 + 1000);
  add(file, { type: 'response_item', payload: {
    type: 'message', role: 'assistant', phase: 'commentary', status: 'completed',
    content: [{ type: 'output_text', text: 'Continuing independent check 2.' }]
  } }, t0 + 2000);
  add(file, { type: 'response_item', payload: { type: 'reasoning', summary: [] } }, t0 + 2500);
  add(file, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'other_tool', output: 'done' } }, t0 + 3000);
  assert.equal(monitor.checkCodex(t0)?.state, 'waiting', 'accepted async prompt must outrank later work');
  assert.equal(monitor.checkCodex(t0 + 3000)?.state, 'waiting', 'assistant commentary/reasoning/tool must not clear unanswered prompt');
  assert.equal(monitor.codexAsyncCache.get(file)?.pending.size, 1, 'pending record must remain intact');

  // Within the existing five-minute window, the prompt survives a monitor restart.
  const late = t0 + 250_000;
  assert.equal(monitor.checkCodex(late)?.state, 'waiting');
  const restarted = createMonitor('accepted').monitor;
  assert.equal(restarted.checkCodex(late)?.state, 'waiting');

  // The initial call can be farther back than the normal 128 KiB tail.
  add(file, { type: 'response_item', payload: { type: 'reasoning', text: 'x'.repeat(160_000) } }, late);
  assert.equal(restarted.checkCodex(late + 100)?.state, 'waiting');
  add(file, reply('call_one'), late + 200);
  assert.notEqual(restarted.checkCodex(late + 300)?.state, 'waiting', 'matching answer must clear the prompt');
  assert.equal(fs.existsSync(path.join(dir, 'runtime-codex-pending.json')), false);

  // 2. AP02 boundary: 299s vs exact 300s, and idle cleanup when no new activity exists
  const expiry = createMonitor('expiry');
  const expiryFile = path.join(expiry.sessions, 'rollout-expiry.jsonl');
  add(expiryFile, call('call_expiry'), t0);
  add(expiryFile, output('call_expiry', true), t0);
  assert.equal(expiry.monitor.checkCodex(t0)?.state, 'waiting');
  assert.equal(expiry.monitor.checkCodex(t0 + 299_000)?.state, 'waiting', '299s must still wait');
  assert.equal(expiry.monitor.codexAsyncCache.get(expiryFile)?.pending.size, 1, '299s pending record retained');
  assert.equal(expiry.monitor.checkCodex(t0 + 300_000), null, 'exact 300s boundary must expire waiting');
  assert.equal(expiry.monitor.codexAsyncCache.get(expiryFile)?.pending.size, 0, 'expired pending record must be deleted from Map');
  assert.equal(expiry.monitor.checkCodex(t0 + 310_000), null, 'waiting uses the existing five-minute cap');

  // 3. AP02 cache transition: ordinary reasoning at 250s, no file change at 310s -> cache path recovers thinking
  const cachedFallback = createMonitor('cached-fallback');
  const cachedFile = path.join(cachedFallback.sessions, 'rollout-cached.jsonl');
  add(cachedFile, call('call_cached'), t0);
  add(cachedFile, output('call_cached', true), t0 + 1);
  add(cachedFile, { type: 'response_item', payload: { type: 'reasoning', summary: [] } }, t0 + 250_000);
  assert.equal(cachedFallback.monitor.checkCodex(t0 + 250_000)?.state, 'waiting', 'at 250s still waiting');
  // At 310s file size and mtime have NOT changed since 250s; cached pending must expire and fall back to thinking
  const recoveredAt310 = cachedFallback.monitor.checkCodex(t0 + 310_000);
  assert.equal(recoveredAt310?.state, 'thinking', 'at 310s with unchanged file, cache path must recover valid thinking state');
  assert.equal(cachedFallback.monitor.codexAsyncCache.get(cachedFile)?.pending.size, 0, 'expired pending deleted on cache path');

  // 4. AP02 new task at 310s: new task + reasoning visible both in-place and after restart replay
  const newWork = createMonitor('new-work-after-expiry');
  const newWorkFile = path.join(newWork.sessions, 'rollout-newwork.jsonl');
  add(newWorkFile, call('old_unanswered'), t0);
  add(newWorkFile, output('old_unanswered', true), t0 + 1);
  assert.equal(newWork.monitor.checkCodex(t0 + 10)?.state, 'waiting');
  add(newWorkFile, { type: 'event_msg', payload: { type: 'task_started' } }, t0 + 310_000);
  add(newWorkFile, { type: 'response_item', payload: { type: 'reasoning', summary: [] } }, t0 + 310_000);
  assert.equal(newWork.monitor.checkCodex(t0 + 310_000)?.state, 'thinking', 'new task after 310s must not be masked by expired question');
  assert.equal(newWork.monitor.codexAsyncCache.get(newWorkFile)?.pending.size, 0);
  const newWorkRestarted = createMonitor('new-work-after-expiry').monitor;
  assert.equal(newWorkRestarted.checkCodex(t0 + 310_000)?.state, 'thinking', 'restart replay at 310s must also show thinking, not resurrect expired question');
  assert.equal(newWorkRestarted.codexAsyncCache.get(newWorkFile)?.pending.size, 0);

  // 5. AP02 old question expired while new question is active; late reply to old question must not delete new question
  const oldAndNew = createMonitor('old-expired-new-active');
  const oldAndNewFile = path.join(oldAndNew.sessions, 'rollout-oldnew.jsonl');
  add(oldAndNewFile, call('q_old'), t0);
  add(oldAndNewFile, output('q_old', true), t0 + 1);
  add(oldAndNewFile, call('q_new'), t0 + 200_000);
  add(oldAndNewFile, output('q_new', true), t0 + 200_001);
  assert.equal(oldAndNew.monitor.checkCodex(t0 + 310_000)?.state, 'waiting');
  assert.equal(oldAndNew.monitor.codexAsyncCache.get(oldAndNewFile)?.pending.has('q_old'), false, 'old expired question removed');
  assert.equal(oldAndNew.monitor.codexAsyncCache.get(oldAndNewFile)?.pending.has('q_new'), true, 'new valid question retained');
  add(oldAndNewFile, reply('q_old', 0), t0 + 315_000);
  assert.equal(oldAndNew.monitor.checkCodex(t0 + 315_100)?.state, 'waiting', 'late reply to old question must not clear new question');
  assert.equal(oldAndNew.monitor.codexAsyncCache.get(oldAndNewFile)?.pending.has('q_new'), true);
  add(oldAndNewFile, reply('q_new', 0), t0 + 316_000);
  assert.notEqual(oldAndNew.monitor.checkCodex(t0 + 316_100)?.state, 'waiting', 'reply to new question clears waiting');

  const rejected = createMonitor('rejected');
  const rejectedFile = path.join(rejected.sessions, 'rollout-rejected.jsonl');
  add(rejectedFile, call('call_no'));
  add(rejectedFile, output('call_no', false));
  assert.notEqual(rejected.monitor.checkCodex(t0)?.state, 'waiting', 'rejected prompt must not linger');

  const permission = createMonitor('permission');
  const permissionFile = path.join(permission.sessions, 'rollout-permission.jsonl');
  add(permissionFile, { type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: 'approval_one', status: 'completed',
    input: 'const result = await tools.request_permissions({ permissions: { file_system: {} } });'
  } });
  assert.equal(permission.monitor.checkCodex(t0)?.state, 'approval', 'open permission request must show approval');
  add(permissionFile, { type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: 'approval_one', output: '{"permissions":{}}'
  } }, t0 + 100);
  assert.notEqual(permission.monitor.checkCodex(t0 + 200)?.state, 'approval', 'permission result must clear approval');

  const escalated = createMonitor('escalated');
  const escalatedFile = path.join(escalated.sessions, 'rollout-escalated.jsonl');
  add(escalatedFile, { type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: 'approval_two', status: 'completed',
    input: 'await tools.exec_command({ cmd: "check", sandbox_permissions: "require_escalated" });'
  } });
  assert.equal(escalated.monitor.checkCodex(t0)?.state, 'approval');

  const separate = createMonitor('separate');
  const first = path.join(separate.sessions, 'rollout-a.jsonl');
  const second = path.join(separate.sessions, 'rollout-b.jsonl');
  for (const f of [first, second]) {
    add(f, call('shared_id'));
    add(f, output('shared_id', true));
  }
  assert.equal(separate.monitor.checkCodex(t0)?.sessionCount, 2);
  add(first, reply('shared_id'), t0 + 100);
  assert.equal(separate.monitor.checkCodex(t0 + 200)?.state, 'waiting', 'answer in one session must not clear another');
  assert.equal(separate.monitor.checkCodex(t0 + 200)?.sessionCount, 2);

  const multiple = createMonitor('multiple');
  const multipleFile = path.join(multiple.sessions, 'rollout-multiple.jsonl');
  add(multipleFile, call('call_multi', 2));
  add(multipleFile, output('call_multi', true));
  assert.equal(multiple.monitor.checkCodex(t0)?.state, 'waiting');
  add(multipleFile, reply('call_multi', 0), t0 + 100);
  assert.equal(multiple.monitor.checkCodex(t0 + 200)?.state, 'waiting', 'one of two answers must not close the prompt');
  const resumedMultiple = createMonitor('multiple').monitor;
  assert.equal(resumedMultiple.checkCodex(t0 + 200)?.state, 'waiting');
  add(multipleFile, reply('call_multi', 1), t0 + 300);
  assert.notEqual(resumedMultiple.checkCodex(t0 + 400)?.state, 'waiting');

  const probe = createMonitor('probe', true);
  const probeFile = path.join(probe.sessions, 'rollout-probe.jsonl');
  add(probeFile, call('probe_call'));
  add(probeFile, output('probe_call', true));
  assert.equal(probe.monitor.checkCodex(t0)?.state, 'waiting');
  assert.equal(fs.existsSync(path.join(probe.dir, 'runtime-codex-pending.json')), false);

  console.log('PASS: question and permission prompts are recognized, answered, and capped at five minutes');
} catch (err) {
  console.error('[async-question.test.mjs FAILURE]', err);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
