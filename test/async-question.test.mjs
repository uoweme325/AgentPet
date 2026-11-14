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

  // Case A: mcp__cua_repl js elicitation (setFiles / downloadMedia / waitForEvent) triggers approval & cuaDetailText
  const cuaElicit = createMonitor('case-a-cua-elicit');
  const cuaElicitFile = path.join(cuaElicit.sessions, 'rollout-cua-elicit.jsonl');
  add(cuaElicitFile, { type: 'response_item', payload: {
    type: 'function_call', name: 'js', namespace: 'mcp__cua_repl', call_id: 'cua_elicit_1', status: 'completed',
    arguments: JSON.stringify({ code: "const p = 1;\nawait iconChooser.setFiles(['a.png']);" })
  } }, t0);
  const cuaElicitState = cuaElicit.monitor.checkCodex(t0);
  assert.equal(cuaElicitState?.state, 'approval', 'Case A: cua_repl setFiles must enter approval');
  assert.equal(cuaElicitState?.task, '等待浏览器权限确认（推断）');
  assert.ok(cuaElicitState?.taskDetail?.includes('setFiles'), 'Case A: taskDetail must extract matching API line from code');
  add(cuaElicitFile, { type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'cua_elicit_1', output: '{"ok":true}'
  } }, t0 + 100);
  assert.notEqual(cuaElicit.monitor.checkCodex(t0 + 200)?.state, 'approval', 'Case A: output must clear approval');

  // Case B: markHandoff survives final_answer + task_complete, keeps 15m TTL, ignores developer/env user msgs, clears on real user reply
  const handoffTtl = createMonitor('case-b-ttl');
  const handoffTtlFile = path.join(handoffTtl.sessions, 'rollout-handoff-ttl.jsonl');
  add(handoffTtlFile, { type: 'response_item', payload: {
    type: 'function_call', name: 'js', namespace: 'mcp__cua_repl', call_id: 'cua_handoff_1', status: 'completed',
    arguments: JSON.stringify({ code: 'await tab.markHandoff();' })
  } }, t0);
  add(handoffTtlFile, { type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'cua_handoff_1', output: '{"ok":true}'
  } }, t0 + 50);
  add(handoffTtlFile, { type: 'response_item', payload: {
    type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed',
    content: [{ type: 'output_text', text: '请在 TuneBlade 搜索页手动完成验证，再告诉我。\n\n附加说明' }]
  } }, t0 + 100);
  add(handoffTtlFile, { type: 'event_msg', payload: { type: 'task_complete' } }, t0 + 150);
  const handoffAt10s = handoffTtl.monitor.checkCodex(t0 + 10_000);
  assert.equal(handoffAt10s?.state, 'waiting', 'Case B: handoff must stay waiting past 8s TERMINAL_HOLD_MS');
  assert.equal(handoffAt10s?.task, '等待主人接管浏览器验证');
  assert.equal(handoffAt10s?.taskDetail, '请在 TuneBlade 搜索页手动完成验证，再告诉我。');
  assert.equal(handoffTtl.monitor.checkCodex(t0 + 10 * 60_000)?.state, 'waiting', 'Case B: handoff must stay active at 10 minutes');
  add(handoffTtlFile, { type: 'response_item', payload: {
    type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer instruction' }]
  } }, t0 + 10 * 60_000 + 100);
  add(handoffTtlFile, { type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>D:\\AgentPet</cwd></environment_context>' }]
  } }, t0 + 10 * 60_000 + 100);
  assert.equal(handoffTtl.monitor.checkCodex(t0 + 10 * 60_000 + 200)?.state, 'waiting', 'Case B: developer and <environment_context> must not clear handoff');
  assert.equal(handoffTtl.monitor.checkCodex(t0 + 16 * 60_000), null, 'Case B: handoff must expire after 15 minutes');

  const handoffReply = createMonitor('case-b-reply');
  const handoffReplyFile = path.join(handoffReply.sessions, 'rollout-handoff-reply.jsonl');
  add(handoffReplyFile, { type: 'response_item', payload: {
    type: 'function_call', name: 'js', namespace: 'mcp__cua_repl', call_id: 'cua_handoff_2', status: 'completed',
    arguments: JSON.stringify({ code: 'await tab.markHandoff();' })
  } }, t0);
  add(handoffReplyFile, { type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'cua_handoff_2', output: '{"ok":true}'
  } }, t0 + 50);
  add(handoffReplyFile, { type: 'response_item', payload: {
    type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed',
    content: [{ type: 'output_text', text: '请手动登录并完成验证' }]
  } }, t0 + 100);
  add(handoffReplyFile, { type: 'event_msg', payload: { type: 'task_complete' } }, t0 + 150);
  assert.equal(handoffReply.monitor.checkCodex(t0 + 10_000)?.state, 'waiting');
  add(handoffReplyFile, { type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: '我已手动过完验证' }]
  } }, t0 + 20_000);
  assert.notEqual(handoffReply.monitor.checkCodex(t0 + 20_100)?.state, 'waiting', 'Case B: real user reply must clear handoff');

  // Case C: guardian filtered from checkCodex, preserved in findLatestCodexRollout, thread_spawn preserved
  const guardianEnv = createMonitor('case-c-guardian');
  const mainRollout = path.join(guardianEnv.sessions, 'rollout-main.jsonl');
  const guardianRollout = path.join(guardianEnv.sessions, 'rollout-guardian.jsonl');
  add(mainRollout, { type: 'session_meta', payload: { id: 'main-1', source: 'vscode' } }, t0);
  add(mainRollout, { type: 'response_item', payload: { type: 'reasoning', summary: [] } }, t0);
  add(guardianRollout, { type: 'session_meta', payload: { id: 'g-1', source: { subagent: { other: 'guardian' } } } }, t0 + 1000);
  add(guardianRollout, { type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { window_minutes: 300, used_percent: 12 } } } }, t0 + 1000);
  add(guardianRollout, { type: 'event_msg', payload: { type: 'task_complete' } }, t0 + 1000);
  const checkWithGuardian = guardianEnv.monitor.checkCodex(t0 + 1000);
  assert.equal(checkWithGuardian?.sessionCount, 1, 'Case C: checkCodex must exclude guardian rollout');
  assert.equal(checkWithGuardian?.state, 'thinking');
  assert.equal(guardianEnv.monitor.findLatestCodexRollout(t0 + 1000, 7 * 86400_000)?.file, guardianRollout, 'Case C: findLatestCodexRollout must still return guardian rollout');
  const spawnRollout = path.join(guardianEnv.sessions, 'rollout-thread-spawn.jsonl');
  add(spawnRollout, { type: 'session_meta', payload: { id: 'sp-1', source: { subagent: { thread_spawn: { nickname: 'Plato' } } } } }, t0 + 6000);
  add(spawnRollout, { type: 'response_item', payload: { type: 'reasoning', summary: [] } }, t0 + 6000);
  assert.equal(guardianEnv.monitor.checkCodex(t0 + 6000)?.sessionCount, 2, 'Case C: thread_spawn subagent must be preserved');

  // Case D: name="js" under non-cua namespace must NOT enter approval (RV-1)
  const otherJs = createMonitor('case-d-other-ns');
  const otherJsFile = path.join(otherJs.sessions, 'rollout-other-js.jsonl');
  add(otherJsFile, { type: 'response_item', payload: {
    type: 'function_call', name: 'js', namespace: 'mcp__other', call_id: 'other_js_1', status: 'in_progress',
    arguments: JSON.stringify({ code: "await chooser.setFiles(['a.png'])" })
  } }, t0);
  const otherJsState = otherJs.monitor.checkCodex(t0);
  assert.equal(otherJsState?.state, 'working', 'Case D: mcp__other js must stay working');
  assert.notEqual(otherJsState?.state, 'approval', 'Case D: mcp__other js must never enter approval');

  // Case E: guardian rollout with >20KB session_meta first line is still filtered (RV-3)
  const bigGuardian = createMonitor('case-e-big-guardian');
  const bigMainFile = path.join(bigGuardian.sessions, 'rollout-big-main.jsonl');
  const bigGuardianFile = path.join(bigGuardian.sessions, 'rollout-big-guardian.jsonl');
  add(bigMainFile, { type: 'session_meta', payload: { id: 'big-main', source: 'vscode' } }, t0);
  add(bigMainFile, { type: 'response_item', payload: { type: 'reasoning', summary: [] } }, t0);
  add(bigGuardianFile, {
    type: 'session_meta',
    payload: { id: 'big-g', instructions: 'x'.repeat(22_000), source: { subagent: { other: 'guardian' } } }
  }, t0 + 1000);
  add(bigGuardianFile, { type: 'event_msg', payload: { type: 'task_complete' } }, t0 + 1000);
  const bigStat = fs.statSync(bigGuardianFile);
  assert.equal(bigGuardian.monitor.isGuardianRollout(bigGuardianFile, bigStat.size, bigStat.mtimeMs), true, 'Case E: 22KB guardian first line must be detected');
  assert.equal(bigGuardian.monitor.checkCodex(t0 + 1000)?.sessionCount, 1, 'Case E: 22KB guardian must be excluded');

  // Case F: markHandoff followed immediately by its function_call_output retains handoff, and subsequent tool in same turn clears it (RV-4 & RV-5)
  const handoffImm = createMonitor('case-f-immediate-output');
  const handoffImmFile = path.join(handoffImm.sessions, 'rollout-handoff-imm.jsonl');
  add(handoffImmFile, { type: 'response_item', payload: {
    type: 'function_call', name: 'js', namespace: 'mcp__cua_repl', call_id: 'hf_imm', status: 'completed',
    arguments: JSON.stringify({ code: 'await tab.markHandoff();' })
  } }, t0);
  add(handoffImmFile, { type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'hf_imm', output: '{"ok":true}'
  } }, t0 + 10);
  const immState = handoffImm.monitor.checkCodex(t0 + 20);
  assert.equal(handoffImm.monitor.codexAsyncCache.get(handoffImmFile)?.pending.has('handoff'), true, 'Case F: immediate output must keep handoff pending');
  assert.equal(immState?.state, 'waiting', 'Case F: accepted handoff enters waiting');
  add(handoffImmFile, { type: 'response_item', payload: {
    type: 'function_call', name: 'shell', call_id: 'next_work', status: 'in_progress',
    arguments: JSON.stringify({ command: 'echo continue' })
  } }, t0 + 30);
  assert.equal(handoffImm.monitor.checkCodex(t0 + 40)?.state, 'working', 'Case F / RV-5: next tool call in same turn must restore working');
  assert.equal(handoffImm.monitor.codexAsyncCache.get(handoffImmFile)?.pending.has('handoff'), false, 'Case F / RV-5: next tool call clears handoff');

  // Case G: guardian_subagent approvals_reviewer 8s label transition (RV-8)
  const guardianRev = createMonitor('case-g-guardian-reviewer');
  const guardianRevFile = path.join(guardianRev.sessions, 'rollout-guardian-rev.jsonl');
  add(guardianRevFile, { type: 'turn_context', payload: { approvals_reviewer: 'guardian_subagent' } }, t0);
  add(guardianRevFile, { type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: 'g_exec_1', status: 'completed',
    input: 'await tools.exec_command({ cmd: "check", sandbox_permissions: "require_escalated" });'
  } }, t0);
  assert.equal(guardianRev.monitor.checkCodex(t0 + 1000)?.task, '自动审查中（等待确认）', 'Case G: <8s under guardian_subagent shows auto-review task');
  assert.equal(guardianRev.monitor.checkCodex(t0 + 9000)?.task, '等待主人确认权限', 'Case G: >=8s under guardian_subagent escalates to user approval task');

  // Case H (AP-REV-01): Failed markHandoff output (error string / JSON error / is_error) must never enter or reactivate handoff waiting
  const failErrText = createMonitor('case-h-err-text');
  const failErrTextFile = path.join(failErrText.sessions, 'rollout-fail-text.jsonl');
  add(failErrTextFile, { type: 'response_item', payload: {
    type: 'function_call', name: 'js', namespace: 'mcp__cua_repl', call_id: 'hf_err_1', status: 'completed',
    arguments: JSON.stringify({ code: 'await tab.markHandoff();' })
  } }, t0);
  add(failErrTextFile, { type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'hf_err_1', output: 'Error: tab has been closed; markHandoff failed.'
  } }, t0 + 50);
  add(failErrTextFile, { type: 'response_item', payload: {
    type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed',
    content: [{ type: 'output_text', text: '浏览器标签已关闭，交接未成功。' }]
  } }, t0 + 100);
  add(failErrTextFile, { type: 'event_msg', payload: { type: 'task_complete' } }, t0 + 150);
  assert.notEqual(failErrText.monitor.checkCodex(t0 + 10_000)?.kind, 'handoff', 'Case H: text error handoff must not stay waiting');
  assert.equal(failErrText.monitor.checkCodex(t0 + 10_000), null, 'Case H: failed handoff + task_complete >8s clears to idle');

  const failJsonObj = createMonitor('case-h-err-json');
  const failJsonFile = path.join(failJsonObj.sessions, 'rollout-fail-json.jsonl');
  add(failJsonFile, { type: 'response_item', payload: {
    type: 'function_call', name: 'js', namespace: 'mcp__cua_repl', call_id: 'hf_err_2', status: 'completed',
    arguments: JSON.stringify({ code: 'await tab.markHandoff();' })
  } }, t0);
  add(failJsonFile, { type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'hf_err_2', output: JSON.stringify({ ok: false, error: 'tab closed' })
  } }, t0 + 50);
  add(failJsonFile, { type: 'event_msg', payload: { type: 'task_complete' } }, t0 + 100);
  assert.notEqual(failJsonObj.monitor.checkCodex(t0 + 10_000)?.state, 'waiting', 'Case H: JSON ok:false handoff must not wait');

  const failIsErrFlag = createMonitor('case-h-is-error');
  const failIsErrFile = path.join(failIsErrFlag.sessions, 'rollout-fail-flag.jsonl');
  add(failIsErrFile, { type: 'response_item', payload: {
    type: 'function_call', name: 'js', namespace: 'mcp__cua_repl', call_id: 'hf_err_3', status: 'completed',
    arguments: JSON.stringify({ code: 'await tab.markHandoff();' })
  } }, t0);
  add(failIsErrFile, { type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'hf_err_3', is_error: true, output: 'aborted'
  } }, t0 + 50);
  add(failIsErrFile, { type: 'event_msg', payload: { type: 'task_complete' } }, t0 + 100);
  assert.notEqual(failIsErrFlag.monitor.checkCodex(t0 + 10_000)?.state, 'waiting', 'Case H: is_error handoff must not enter waiting');
  assert.equal(failIsErrFlag.monitor.codexAsyncCache.get(failIsErrFile)?.pending.has('handoff'), false, 'Case H: is_error output must delete handoff pending');

  // Case I (AP-REV-02): turn_aborted clears active handoff waiting across incremental & cold-start scans, while ignoring older timestamps
  const abortEnv = createMonitor('case-i-turn-aborted');
  const abortFile = path.join(abortEnv.sessions, 'rollout-handoff-abort.jsonl');
  add(abortFile, { type: 'response_item', payload: {
    type: 'function_call', name: 'js', namespace: 'mcp__cua_repl', call_id: 'hf_ab_1', status: 'completed',
    arguments: JSON.stringify({ code: 'await tab.markHandoff();' })
  } }, t0);
  add(abortFile, { type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'hf_ab_1', output: '{"ok":true}'
  } }, t0 + 50);
  assert.equal(abortEnv.monitor.checkCodex(t0 + 100)?.state, 'waiting', 'Case I: handoff waiting initially active');
  // Stale timestamp turn_aborted must NOT clear newer handoff
  add(abortFile, { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'stale' } }, t0 + 10);
  assert.equal(abortEnv.monitor.checkCodex(t0 + 200)?.state, 'waiting', 'Case I: older turn_aborted must not clear newer handoff');
  // Current turn_aborted must clear active handoff incrementally & after TERMINAL_HOLD_MS without extra logs
  add(abortFile, { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }, t0 + 1000);
  assert.notEqual(abortEnv.monitor.checkCodex(t0 + 11_000)?.kind, 'handoff', 'Case I: turn_aborted must clear handoff incrementally');
  assert.equal(abortEnv.monitor.checkCodex(t0 + 11_000), null, 'Case I: after 8s hold aborted turn clears to idle');
  // Fresh monitor cold-start full-log scan must behave identically
  const abortCold = new AgentMonitor({ isProbe: true, onChange: () => {} });
  abortCold.paths.codex = abortEnv.monitor.paths.codex;
  abortCold.paths.appDir = abortEnv.dir;
  assert.equal(abortCold.checkCodex(t0 + 11_000), null, 'Case I: cold-start full-log scan must also clear aborted handoff');

  // Case J: Guardian >64KB session_meta line & main session config.subagent non-false-positive boundary
  const big70Guardian = createMonitor('case-j-70kb-guardian');
  const big70Main = path.join(big70Guardian.sessions, 'rollout-70k-main.jsonl');
  const big70Guard = path.join(big70Guardian.sessions, 'rollout-70k-guardian.jsonl');
  add(big70Main, { type: 'session_meta', payload: { id: 'm70', source: 'vscode', config: { subagent: 'guardian' } } }, t0);
  add(big70Main, { type: 'response_item', payload: { type: 'reasoning', summary: [] } }, t0);
  add(big70Guard, { type: 'session_meta', payload: { id: 'g70', instructions: 'x'.repeat(70_000), source: { subagent: { other: 'guardian' } } } }, t0 + 1000);
  add(big70Guard, { type: 'event_msg', payload: { type: 'task_complete' } }, t0 + 1000);
  const big70MainSt = fs.statSync(big70Main);
  const big70GuardSt = fs.statSync(big70Guard);
  assert.equal(big70Guardian.monitor.isGuardianRollout(big70Main, big70MainSt.size, big70MainSt.mtimeMs), false, 'Case J: config.subagent in main session must NOT be misclassified');
  assert.equal(big70Guardian.monitor.isGuardianRollout(big70Guard, big70GuardSt.size, big70GuardSt.mtimeMs), true, 'Case J: >70KB guardian first line must be detected');
  assert.equal(big70Guardian.monitor.checkCodex(t0 + 1000)?.sessionCount, 1, 'Case J: >70KB guardian excluded while main retained');

  // Case K (AP-REV-04): thread_spawn subagents with 'guardian' in path/nickname/role stay visible (waiting), only exact guardian source excluded
  for (const [kLabel, kSource, kExpectGuardian] of [
    ['normal-thread-spawn', { subagent: { thread_spawn: { parent_thread_id: 'main', depth: 1, agent_path: '/root/detail_review', agent_nickname: 'Darwin' } } }, false],
    ['guardian-path-thread-spawn', { subagent: { thread_spawn: { parent_thread_id: 'main', depth: 1, agent_path: '/root/guardian_review', agent_nickname: 'Darwin' } } }, false],
    ['guardian-nick-thread-spawn', { subagent: { thread_spawn: { parent_thread_id: 'main', depth: 1, agent_path: '/root/review', agent_nickname: 'guardian-helper', agent_role: 'guardian' } } }, false],
    ['real-guardian', { subagent: { other: 'guardian' } }, true]
  ]) {
    const kEnv = createMonitor(`case-k-${kLabel}`);
    const kMain = path.join(kEnv.sessions, 'rollout-main.jsonl');
    const kWorker = path.join(kEnv.sessions, 'rollout-worker.jsonl');
    add(kMain, { type: 'session_meta', payload: { id: 'main', source: 'vscode' } }, t0);
    add(kMain, { type: 'response_item', payload: { type: 'reasoning', summary: [] } }, t0 + 1);
    add(kWorker, { type: 'session_meta', payload: { id: 'worker', source: kSource } }, t0 + 50);
    add(kWorker, { type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { window_minutes: 300, used_percent: 15 } } } }, t0 + 60);
    add(kWorker, call('q_k_1', 1), t0 + 100);
    add(kWorker, output('q_k_1', true), t0 + 150);
    const kSt = fs.statSync(kWorker);
    assert.equal(kEnv.monitor.isGuardianRollout(kWorker, kSt.size, kSt.mtimeMs), kExpectGuardian, `Case K (${kLabel}): isGuardianRollout mismatch`);
    const kRes = kEnv.monitor.checkCodex(t0 + 200);
    assert.equal(kRes?.sessionCount, kExpectGuardian ? 1 : 2, `Case K (${kLabel}): sessionCount mismatch`);
    assert.equal(kRes?.state, kExpectGuardian ? 'thinking' : 'waiting', `Case K (${kLabel}): state mismatch`);
    assert.equal(kEnv.monitor.findLatestCodexRollout(t0 + 200, 7 * 86400_000)?.file, kWorker, `Case K (${kLabel}): quota fallback must keep latest rollout`);
  }
  // Unparseable truncated first-line fallback must fail open on ambiguous thread_spawn/subagent words
  const truncEnv = createMonitor('case-k-truncated');
  const truncFile = path.join(truncEnv.sessions, 'rollout-trunc.jsonl');
  fs.writeFileSync(truncFile, '{"type":"session_meta","payload":{"source":{"subagent":{"thread_spawn":{"agent_nickname":"guardian"}}},"broken":\n');
  const truncSt = fs.statSync(truncFile);
  assert.equal(truncEnv.monitor.isGuardianRollout(truncFile, truncSt.size, truncSt.mtimeMs), false, 'Case K: malformed line mentioning guardian+subagent must not misclassify thread_spawn');

  console.log('PASS: question and permission prompts are recognized, answered, and capped at five minutes');
} catch (err) {
  console.error('[async-question.test.mjs FAILURE]', err);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
