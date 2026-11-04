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
  const { monitor, dir, sessions } = createMonitor('accepted');
  const file = path.join(sessions, 'rollout-question.jsonl');
  add(file, call('call_one'));
  add(file, output('call_one', true));
  add(file, { type: 'response_item', payload: { type: 'reasoning', summary: [] } });
  add(file, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'other_tool', output: 'done' } });
  assert.equal(monitor.checkCodex(t0)?.state, 'waiting', 'accepted async prompt must outrank later work');

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

  const expiry = createMonitor('expiry');
  const expiryFile = path.join(expiry.sessions, 'rollout-expiry.jsonl');
  add(expiryFile, call('call_expiry'));
  add(expiryFile, output('call_expiry', true));
  assert.equal(expiry.monitor.checkCodex(t0)?.state, 'waiting');
  assert.equal(expiry.monitor.checkCodex(t0 + 310_000), null, 'waiting uses the existing five-minute cap');

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
