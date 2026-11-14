import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {}

const argOf = name => { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : null; };
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logPath = argOf('--log-file') || path.join(appDir, 'runtime-error.log');

function getLocalTimestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// WO-10 & WO-21: Unified 2MB x 3 Log Rotation with derived archive paths
function rotateLogIfNeeded() {
  try {
    if (!fs.existsSync(logPath)) return;
    const st = fs.statSync(logPath);
    if (st.size >= 2 * 1024 * 1024) { // 2MB
      const base = logPath.replace(/\.log$/i, '');
      const log3 = `${base}.3.log`;
      const log2 = `${base}.2.log`;
      const log1 = `${base}.1.log`;
      try { if (fs.existsSync(log3)) fs.unlinkSync(log3); } catch {}
      try { if (fs.existsSync(log2)) fs.renameSync(log2, log3); } catch {}
      try { if (fs.existsSync(log1)) fs.renameSync(log1, log2); } catch {}
      try { fs.renameSync(logPath, log1); } catch {}
    }
  } catch {}
}

function writeErrorLog(msg) {
  try {
    rotateLogIfNeeded();
    const timestamp = getLocalTimestamp();
    const line = `[${timestamp}] [AgentMonitor PID ${process.pid}] ${msg}\n`;
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {}
}

// Process-level safety guards so background daemon writes crashes to runtime-error.log
process.on('uncaughtException', err => {
  const stack = err?.stack || String(err);
  writeErrorLog(`Uncaught exception: ${stack}`);
});
process.on('unhandledRejection', reason => {
  const stack = reason instanceof Error ? reason.stack : JSON.stringify(reason);
  writeErrorLog(`Unhandled rejection: ${stack}`);
});

// WO-09: Log SIGTERM / SIGINT / exit
process.on('SIGTERM', () => {
  writeErrorLog('AgentMonitor received SIGTERM. Shutting down gracefully.');
  process.exit(0);
});
process.on('SIGINT', () => {
  writeErrorLog('AgentMonitor received SIGINT. Shutting down gracefully.');
  process.exit(0);
});
const PROBE_MODE = process.argv.includes('--test-scan');

process.on('exit', code => {
  if (PROBE_MODE) return;
  writeErrorLog(`AgentMonitor process exited with code ${code}.`);
});

const SCAN_MS = 500;
const ACTIVE_MAX_AGE_MS = 180_000;
const WAITING_MAX_AGE_MS = 300_000;
const TERMINAL_HOLD_MS = 8_000;
const TASK_TEXT_MAX = 40;
const DETAIL_MAX_CODE_POINTS = 700;
const DETAIL_TRUNCATE_SUFFIX = '…（已节选）';
const QUOTA_POLL_MS = 60_000;
const BALANCE_POLL_MS = 300_000; // 5 minutes
const BALANCE_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 900_000]; // 1m, 2m, 5m, 10m, 15m
const BALANCE_TIMEOUT_MS = 10_000;

function validateLoopbackUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:') return null;
    const h = u.hostname.toLowerCase();
    if (h !== '127.0.0.1' && h !== 'localhost') return null;
    const port = parseInt(u.port, 10);
    if (!Number.isFinite(port) || port < 1024 || port > 65535) return null;
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

 // 10s

function getCleanSubprocessEnv() {
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  return env;
}

// Character-aligned 7-tier work status texts (claude / gemini / dragon)
const WORK_STATUS_TEXTS_BY_CHARACTER = {
  claude: {
    thinking: [
      '正翻阅怀里的典籍核对上下文呢…',
      '红茶才刚泡好，容我把调用链理清。',
      '正在书稿上推敲改动蓝图与边界…',
      '指尖扶好发饰——开始专注推导逻辑！',
      '优等生可不会漏掉细节，正在比对架构…',
      '容我垂眸细想片刻，解法马上成型。'
    ],
    working: [
      '已按典籍上的蓝图动笔改代码啦~',
      '正在紧盯终端日志，主人先喝口红茶吧。',
      '代码洁癖发作中，正在帮主人重构整理！',
      '手头的改动很顺畅，茶点额度还很充裕~',
      '正在一行行落实逻辑，脏活累活交给我。',
      '书房里正忙着编译构建，请主人稍候~'
    ],
    waiting: [
      '施工蓝图铺好啦，请主人过目拍板~',
      '这一步得守规矩等主人点头才能动笔。',
      '把典籍递到您手边——这里请主人定夺。',
      '正在安静候命，等主人批下权限许可~',
      '茶杯先替您温着，确认完这一步咱们继续。',
      '遇到关键分支了，想先听听主人的心意~'
    ],
    stalled: [
      '红茶都快凉半盏了，这一步还在跑呢…',
      '对面响应有些迟缓，我抱着典籍替您守着。',
      '工具还没回音，主人别急，我盯着日志呢。'
    ],
    result: [
      '终端回执已收进典籍，正在为您批注汇总~',
      '这一步验证通过，正在衔接下一章逻辑…',
      '关键输出已经夹进书签，马上整理呈上！',
      '工具返回妥当，容我用优等生标准核对一遍。',
      '数据采集完毕，正在书案上誊写结论…',
      '阶段结果很清晰，正在收拢最终答复~'
    ],
    success: [
      '合上印花典籍——当前回合漂亮收官啦！',
      '这可是优等生的基本功，没给主人丢脸吧？',
      '代码修得干干净净，主人快尝口热茶查验~',
      '哼哼，蓝图已圆满落地，随时听候新差遣。',
      '这一轮稳稳办妥，发间的向日葵都舒展开啦~',
      '全部验收就绪，主人靠着歇口气吧~'
    ],
    error: [
      '居然有顽固报错折磨主人？我来替您收拾它！',
      '眉头微蹙翻开典籍——正在顺着堆栈揪元凶…',
      '捕获到一处隐蔽异常，交给我一行行排查！',
      '边界条件撞了小墙，别慌，我这就帮您兜底。',
      '日志里藏着点毛病，休想逃过优等生的眼睛！',
      '主人喝口水消消气，这处报错交给我摆平。'
    ]
  },
  gemini: {
    thinking: [
      '双子星轨对齐中，正在全图扫描上下文~',
      '左眼看全局、右眼盯细节，方案推演中！',
      '正在星盘上检索跨文件依赖，马上锁定~',
      '两套思路正在脑海里赛跑，挑最优那条！',
      '穿梭在超长上下文星海里，线索连上啦~',
      '星轨坐标已校准，正在绘制最佳改动路线！'
    ],
    working: [
      '正沿着星轨全速改代码，比流星还稳哦~',
      '双线并进中，一边盯终端一边更新文件！',
      '代码星图正在点亮，改动一步步成形啦~',
      '指尖划过星盘，正在利落地重构模块！',
      '构建与修改同步推进中，节奏超合拍~',
      '算力星海全开，剩下的步骤包在我身上！'
    ],
    waiting: [
      '星轨前方出现岔路啦，等主人选一颗星~',
      '悬停在确认节点上，等主人挥手放行！',
      '双子视角准备就绪，请主人拍板定方向~',
      '这里需要主人的通行密令才能继续跃迁哦。',
      '星盘指针停在这儿啦，请主人点一下确认~',
      '留了一个关键坐标等您决定，随时出发！'
    ],
    stalled: [
      '深空信号回传有点慢，星盘还在闪烁等待…',
      '这一步像飞进了慢速星云，我继续替您观测~',
      '远端工具还没亮灯，再耐心守望一会儿…'
    ],
    result: [
      '顺着星光把返回数据捞回来啦，正在汇总！',
      '观测结果已落入星盘，正在拼合完整拼图~',
      '工具信号接收完毕，正在双视角交叉核对！',
      '关键碎片收集齐啦，马上点亮最终结论~',
      '终端回波很清晰，正在为您提炼星图摘要！',
      '这一站的果实已摘下，正在飞快组织答复~'
    ],
    success: [
      '双子星闪耀收官！这一轮跑得又快又漂亮~',
      '星图全数点亮，主人快来看看成果吧！',
      '比流星还干脆地搞定啦，随时准备下次巡航~',
      '所有轨道严丝合缝，给这次配合记一颗亮星★',
      '圆满抵达终点坐标，下一站飞去哪个模块？',
      '任务顺利收束进星盘，主人今天超厉害！'
    ],
    error: [
      '星轨探测到异常乱流，正在锁定故障坐标！',
      '哎呀，某颗节点报错熄火了，我马上检修~',
      '开启双倍视野追踪红字堆栈，休想藏起来！',
      '发现一处偏航报错，正在重新校准代码逻辑~',
      '捕获到报错碎片，让我换条星轨绕过去修好！',
      '小风浪而已，星盘已经圈出问题行号啦！'
    ]
  },
  dragon: {
    thinking: [
      '支起龙角看代码中……让我琢磨怎么写最省事。',
      '尾巴尖轻轻晃——正在盘算怎么一步到位。',
      '看在好吃的 Token 份上，帮您把逻辑理一遍…',
      '别催，本龙正在翻上下文帮您探坑呢。',
      '眯着眼扫完这堆文件了，大概知道怎么动爪。',
      '先把前因后果摸清楚，省得待会儿耽误我打盹。'
    ],
    working: [
      '收起懒腰认真干活中，连尾巴都绷直啦！',
      '在敲了在敲了，正帮您把乱糟糟的代码拍平…',
      '一口气吃掉这么多 Token，干起活来当然利索！',
      '正盯着终端跑命令呢，谁也别想卡主人的流程。',
      '本龙亲自出马改文件，您就安心坐等收成吧~',
      '爪子飞快敲键盘中，干完这票就回去盘着睡！'
    ],
    waiting: [
      '尾巴拍拍桌角——喂，这里要主人点个头才行。',
      '卡在授权确认啦，快批一下，别让本龙干等~',
      '这步得主人亲自拿主意，我先揣着爪子等您。',
      '快看屏幕！确认完这一项我好一口气收工~',
      '停爪待命中，等主人发话往哪边改。',
      '有个选项得问您，批完记得奖励我一点 Token~'
    ],
    stalled: [
      '对面慢吞吞的，等得本龙都快打哈欠了…',
      '这一步怎么还在转圈？我支着耳朵替您守着。',
      '工具半天没吐结果，先盘着尾巴耐心耗会儿…'
    ],
    result: [
      '输出终于吐出来啦，本龙帮您挑重点整理下。',
      '叼住刚返回的终端结果，正在合成最终汇报~',
      '这一步跑通了，抖抖耳朵准备接下一棒！',
      '数据到手，正在剔掉废话留干货给主人看。',
      '工具总算干完活了，容我再最后扫一眼细节。',
      '拿到回执啦，三两下帮您收拢成结论~'
    ],
    success: [
      '搞定收工！本龙可以安心盘起尾巴继续摸鱼啦~',
      '干得这么漂亮，今天的 Token 花得超值吧？',
      '三下五除二摆平，快夸我两句顺便投喂一下~',
      '活儿全办妥了，剩下的时间归我趴着打盹！',
      '利落交差！有本龙在，哪用得着主人操心~',
      '圆满搞定，伸个大懒腰——今天又省下不少功夫！'
    ],
    error: [
      '啧，哪个不长眼的 Bug 敢卡主人的代码？',
      '龙角雷达响了，正在把报错日志揪出来拷问！',
      '撞上报错了？别烦心，本龙帮您把坑填平。',
      '甩甩尾巴进入认真模式——正在定位哪行闯的祸！',
      '发现一处烂代码报错，看我三两下把它修老实。',
      '小场面，等我顺着堆栈把这只臭虫拍飞！'
    ]
  }
};
const WORK_STATUS_TEXTS = WORK_STATUS_TEXTS_BY_CHARACTER.claude;

function truncate(text, max = TASK_TEXT_MAX) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function cleanSummary(text) {
  if (!text) return '';
  let s = String(text).replace(/^["']|["']$/g, '').trim();
  s = s.replace(/\\/g, '/');
  if (s.length > 50 && s.includes('/')) {
    s = path.basename(s);
  }
  return truncate(s, 36);
}

function normalizeDetailWhitespace(text) {
  if (text == null) return '';
  const s = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

function redactDetailSecrets(text) {
  if (!text) return '';
  let s = String(text);
  // 1. Bearer tokens (case-insensitive, supports quotes & bare tokens)
  s = s.replace(/(\bBearer[ \t]+)(?:(["'])(?:(?!\2)[^\r\n]){6,}\2|[^\s"'`]{6,})/gi, (_, prefix, quote) => {
    return quote ? `${prefix}${quote}[REDACTED]${quote}` : `${prefix}[REDACTED]`;
  });
  // 2. Major API key & VCS token prefixes
  s = s.replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}\b/gi, 'sk-[REDACTED]');
  s = s.replace(/\b(?:gh[pousr]_|github_pat_|glpat-)[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED_TOKEN]');
  // 3. URL basic auth user:pass@
  s = s.replace(/(https?:\/\/)([^:\s/@]+):([^@\s/@]+)@/gi, '$1[REDACTED]@');
  // 4. Named credential assignments (= or :) with optional quotes
  s = s.replace(
    /(["']?\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|API[-_]KEY|ACCESS[-_]TOKEN|AUTH[-_]TOKEN|REFRESH[-_]TOKEN|SECRET[-_]KEY|CLIENT[-_]SECRET|PASSWORD|TOKEN)\b["']?\s*[:=]\s*)(?:(["'])(?:(?!\2)[^\r\n])+\2|[^\s,;'"`}\]]+)/gi,
    (_, prefix, quote) => quote ? `${prefix}${quote}[REDACTED]${quote}` : `${prefix}[REDACTED]`
  );
  // 5. CLI credential flags (--api-key xyz, --token=xyz, --password 'abc', etc.)
  s = s.replace(
    /(--(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|secret[-_]?key|client[-_]?secret|password|token)\b(?:[ \t]+|[ \t]*=[ \t]*))(?:(["'])(?:(?!\2)[^\r\n])+\2|[^\s,;'"`}\]]+)/gi,
    (_, prefix, quote) => quote ? `${prefix}${quote}[REDACTED]${quote}` : `${prefix}[REDACTED]`
  );
  return s;
}

function truncateCodePoints(text, max = DETAIL_MAX_CODE_POINTS, suffix = DETAIL_TRUNCATE_SUFFIX) {
  if (!text) return '';
  const cps = Array.from(String(text));
  if (cps.length <= max) return cps.join('');
  const suffixCps = Array.from(String(suffix || ''));
  const headLen = Math.max(0, max - suffixCps.length);
  return cps.slice(0, headLen).join('') + suffixCps.join('');
}

function finalizeTaskDetail(rawText) {
  if (rawText == null) return null;
  const normalized = normalizeDetailWhitespace(rawText);
  if (!normalized) return null;
  const redacted = redactDetailSecrets(normalized);
  const capped = truncateCodePoints(redacted, DETAIL_MAX_CODE_POINTS, DETAIL_TRUNCATE_SUFFIX);
  return capped || null;
}

function extractJsonStringField(text, fieldName) {
  if (!text) return null;
  const re = new RegExp(`"${fieldName}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
  const m = text.match(re);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

function formatDetailFieldValue(val) {
  if (val == null) return '';
  if (Array.isArray(val)) {
    return val.map(v => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ? String(v) : '').filter(Boolean).join(' ').trim();
  }
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    return String(val).trim();
  }
  return '';
}

function tryParseJsonObject(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

function extractTranscriptToolDetail(tc) {
  if (!tc || typeof tc !== 'object') return null;
  const args = tryParseJsonObject(tc.args) || tryParseJsonObject(tc.arguments) || {};
  const toolName = String(tc.name || '').trim();
  if (toolName === 'ask_question' || toolName === 'ask_user') {
    const qs = [];
    if (Array.isArray(args.questions)) {
      for (const q of args.questions) {
        const qt = formatDetailFieldValue(q?.question || q?.prompt || q?.text || q?.header);
        if (qt) qs.push(qt);
      }
    }
    const single = formatDetailFieldValue(args.question || args.prompt || args.toolSummary || tc.toolSummary);
    if (!qs.length && single) qs.push(single);
    return finalizeTaskDetail(qs.join('\n'));
  }

  const parts = [];
  const summary = formatDetailFieldValue(args.toolSummary || tc.toolSummary);
  const cmd = formatDetailFieldValue(args.CommandLine || args.command || args.cmd);
  const targetPath = formatDetailFieldValue(args.TargetFile || args.Path || args.path || args.file_path);
  const prompt = formatDetailFieldValue(args.Prompt || args.prompt);
  const query = formatDetailFieldValue(args.Query || args.query);

  if (summary) parts.push(toolName && summary !== toolName ? `${toolName}: ${summary}` : summary);
  if (cmd && cmd !== summary) parts.push(parts.length ? `命令: ${cmd}` : (toolName ? `${toolName}: ${cmd}` : cmd));
  if (targetPath && targetPath !== summary && (!cmd || !cmd.includes(targetPath))) {
    parts.push(parts.length ? `文件: ${targetPath}` : (toolName ? `${toolName}: ${targetPath}` : targetPath));
  }
  if (prompt && prompt !== summary) parts.push(prompt);
  if (query && query !== summary) parts.push(parts.length ? `检索: ${query}` : (toolName ? `${toolName}: ${query}` : query));
  return finalizeTaskDetail(parts.join('\n'));
}

function extractCodexToolDetail(obj, fallbackToolName = '') {
  if (!obj || typeof obj !== 'object') return null;
  const toolName = String(obj.name || obj.tool || fallbackToolName || '').trim();
  const bare = toolName.includes('.') ? toolName.split('.').pop() : toolName;
  const args = tryParseJsonObject(obj.arguments) || tryParseJsonObject(obj.args) || tryParseJsonObject(obj.input) || {};
  const lines = [];

  if (Array.isArray(args.questions) && args.questions.length > 0) {
    for (const q of args.questions) {
      const qt = formatDetailFieldValue(q?.question || q?.prompt || q?.text || q?.header);
      if (qt) lines.push(qt);
    }
  }

  const ALLOWED_CODEX_KEYS = [
    ['command', '命令'],
    ['cmd', '命令'],
    ['TargetFile', '文件'],
    ['file_path', '文件'],
    ['path', '路径'],
    ['workdir', '目录'],
    ['query', '检索'],
    ['pattern', '匹配'],
    ['description', '说明']
  ];

  // Top-level item.command (for Codex item_started/item_completed) or allowed keys on structured args/obj
  const seenValues = new Set();
  const itemCmd = formatDetailFieldValue(obj.command);
  if (itemCmd) {
    seenValues.add(itemCmd);
    lines.push(bare ? `${bare}: ${itemCmd}` : itemCmd);
  }

  for (const [key, label] of ALLOWED_CODEX_KEYS) {
    const val = formatDetailFieldValue(args[key]);
    if (!val || seenValues.has(val)) continue;
    seenValues.add(val);
    if (!lines.length && bare && (key === 'command' || key === 'cmd' || key === 'TargetFile' || key === 'file_path' || key === 'path' || key === 'query')) {
      lines.push(`${bare}: ${val}`);
    } else {
      lines.push(lines.length ? `${label}: ${val}` : val);
    }
  }

  return finalizeTaskDetail(lines.join('\n'));
}

let _cachedStatusTier = null;
let _cachedStatusText = '';

// WO-03 & Issue ①: Hold quote consistently throughout entire task, only re-pick when character or state/tier changes
function pickStatusText(tier, character = 'claude') {
  const charRaw = String(character || 'claude').toLowerCase();
  const charKey = (charRaw === 'dragon' || charRaw === 'gemini') ? charRaw : 'claude';
  const tierRaw = String(tier || 'working').toLowerCase();
  const normTier = (tierRaw === 'approval') ? 'waiting' : (tierRaw === 'calling' ? 'working' : (tierRaw === 'done' ? 'success' : tierRaw));
  const cacheKey = `${charKey}:${normTier}`;
  if (cacheKey === _cachedStatusTier && _cachedStatusText) {
    return _cachedStatusText;
  }
  _cachedStatusTier = cacheKey;
  const charMap = WORK_STATUS_TEXTS_BY_CHARACTER[charKey] || WORK_STATUS_TEXTS_BY_CHARACTER.claude;
  const list = charMap[normTier] || charMap.working;
  _cachedStatusText = getRandomText(list);
  return _cachedStatusText;
}

function getRandomText(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const idx = Math.floor(Math.random() * list.length);
  return list[idx];
}

function formatPlanLabel(rawPlan) {
  if (!rawPlan) return null;
  const s = String(rawPlan).trim().toLowerCase();
  const map = { plus: 'Plus', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', edu: 'Edu', free: 'Free' };
  if (map[s]) return map[s];
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function atomicWriteJson(filePath, data, silent = false) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err) {
    if (!silent) {
      writeErrorLog(`atomicWriteJson failed for ${path.basename(filePath)}: ${err.message}`);
    }
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

const pendingWrites = new Map();

function writeJsonWithRetry(filePath, data) {
  const json = JSON.stringify(data);
  const prev = pendingWrites.get(filePath);
  if (prev && prev.json === json) return false;
  if (atomicWriteJson(filePath, data, true)) {
    pendingWrites.delete(filePath);
    return true;
  }
  pendingWrites.set(filePath, { payload: data, json, attempts: 1, nextAt: Date.now() + 100 });
  return false;
}

function flushPendingWrites(now = Date.now()) {
  for (const [filePath, item] of pendingWrites) {
    if (now < item.nextAt) continue;
    if (atomicWriteJson(filePath, item.payload, true)) {
      pendingWrites.delete(filePath);
      continue;
    }
    item.attempts += 1;
    if (item.attempts > 2) {
      pendingWrites.delete(filePath);
      writeErrorLog(`write retry exhausted for ${path.basename(filePath)}, giving up (${item.json.length} bytes); file may be stale`);
      continue;
    }
    item.nextAt = now + 100 * item.attempts;
  }
}

function dispatchRuntimeWrite(baseDir, data) {
  if (data.type === 'quota') {
    return writeJsonWithRetry(path.join(baseDir, 'runtime-quota.json'), data);
  } else if (data.type === 'balance') {
    return writeJsonWithRetry(path.join(baseDir, 'runtime-balance.json'), data);
  } else {
    return writeJsonWithRetry(path.join(baseDir, 'runtime-status.json'), data);
  }
}

let _cachedDrives = null;
let _lastDriveCheck = 0;

// Dynamically query actual mounted drives from the OS without any hardcoded drive letters
function getSystemDrives() {
  const now = Date.now();
  if (_cachedDrives && now - _lastDriveCheck < 60000) {
    return _cachedDrives;
  }
  _lastDriveCheck = now;
  if (process.platform !== 'win32') return ['/'];

  try {
    const stdout = execSync('fsutil fsinfo drives', {
      env: getCleanSubprocessEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
      windowsHide: true
    });
    const matches = stdout.match(/[A-Za-z]:/g);
    if (matches && matches.length > 0) {
      _cachedDrives = matches.map(d => d.toUpperCase());
      return _cachedDrives;
    }
  } catch {}

  // Safe fallback without magic guesses: system drive, home drive, and current script drive
  const fallback = new Set();
  if (process.env.SystemDrive) fallback.add(process.env.SystemDrive.substring(0, 2).toUpperCase());
  if (process.env.HOMEDRIVE) fallback.add(process.env.HOMEDRIVE.substring(0, 2).toUpperCase());
  const curDrive = path.parse(process.cwd()).root.substring(0, 2).toUpperCase();
  if (curDrive && curDrive.length === 2 && curDrive.endsWith(':')) fallback.add(curDrive);
  _cachedDrives = Array.from(fallback);
  return _cachedDrives;
}

let _cachedDshDirs = null;
let _lastDshCheck = 0;

function resolveDshDirs() {
  const now = Date.now();
  if (_cachedDshDirs && now - _lastDshCheck < 30000) {
    return _cachedDshDirs;
  }
  _lastDshCheck = now;
  const home = os.homedir();
  const candidates = [];

  // 1. Explicit environment variables (highest priority)
  for (const envVar of ['DSH_HOME', 'DEEPSEEK_HARNESS_HOME', 'DSH_DIR']) {
    if (process.env[envVar]) {
      candidates.push(path.join(process.env[envVar], 'storages', 'session_projcache', 'sessions'));
    }
  }

  // 2. Standard user profile & appdata locations
  candidates.push(path.join(home, '.dsh', 'storages', 'session_projcache', 'sessions'));
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'dsh', 'storages', 'session_projcache', 'sessions'));
  }
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'dsh', 'storages', 'session_projcache', 'sessions'));
  }

  // 3. Dynamic discovery across all actual mounted system drives (zero hardcoded drive letters)
  const drives = getSystemDrives();
  for (const drive of drives) {
    candidates.push(path.join(`${drive}\\`, 'dsh', 'storages', 'session_projcache', 'sessions'));
  }

  _cachedDshDirs = [...new Set(candidates)].filter(d => {
    try { return fs.existsSync(d); } catch { return false; }
  });
  return _cachedDshDirs;
}

function resolveCodexCli() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates = [];

  const checkFile = p => {
    try {
      if (p && fs.existsSync(p)) {
        const st = fs.statSync(p);
        candidates.push({ file: p, mtime: st.mtimeMs });
      }
    } catch {}
  };

  // 1. OpenAI official Codex desktop client paths (%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe)
  const openAiBin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  try {
    if (fs.existsSync(openAiBin)) {
      checkFile(path.join(openAiBin, 'codex.exe'));
      for (const ent of fs.readdirSync(openAiBin, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          checkFile(path.join(openAiBin, ent.name, 'codex.exe'));
        }
      }
    }
  } catch {}

  // 2. Standard Program / AppData paths
  checkFile(path.join(localAppData, 'Programs', 'OpenAI Codex', 'codex.exe'));
  checkFile(path.join(programFiles, 'OpenAI Codex', 'codex.exe'));

  // 3. User cache runtimes (~/.cache/codex-runtimes)
  const binRoot = path.join(home, '.cache', 'codex-runtimes');
  checkFile(path.join(binRoot, 'codex.exe'));
  try {
    if (fs.existsSync(binRoot)) {
      for (const ent of fs.readdirSync(binRoot, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          checkFile(path.join(binRoot, ent.name, 'codex.exe'));
          try {
            for (const sub of fs.readdirSync(path.join(binRoot, ent.name), { withFileTypes: true })) {
              if (sub.isDirectory()) checkFile(path.join(binRoot, ent.name, sub.name, 'codex.exe'));
            }
          } catch {}
        }
      }
    }
  } catch {}

  // 4. System PATH via where.exe
  try {
    const out = execSync('where.exe codex.exe codex', { env: getCleanSubprocessEnv(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/)) {
      if (line.trim()) checkFile(line.trim());
    }
  } catch {}

  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.length > 0 ? candidates[0].file : null;
}

function queryCodexRateLimits(cliPath, timeoutMs = 12000) {
  return new Promise(resolve => {
    if (!cliPath || !fs.existsSync(cliPath)) {
      resolve(null);
      return;
    }
    let finished = false;
    let proc = null;
    let rl = null;
    let expectedId = 1;
    let planType = null;

    const done = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { rl?.close(); } catch {}
      try { proc?.stdin.end(); proc?.kill(); } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      proc = spawn(cliPath, ['app-server', '--stdio'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      done(null);
      return;
    }

    proc.on('error', () => done(null));
    proc.on('close', () => done(null));
    proc.stderr.on('data', () => {});

    const send = msg => {
      try { proc.stdin.write(JSON.stringify(msg) + '\n'); } catch { done(null); }
    };

    rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', line => {
      if (finished || !line || line.length > 1024 * 1024) return;
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (!m || m.id !== expectedId) return;

      if (m.id === 1) {
        if (m.error) return done(null);
        send({ method: 'initialized', params: {} });
        expectedId = 2;
        send({ id: 2, method: 'account/read', params: { refreshToken: false } });
      } else if (m.id === 2) {
        if (m.error) return done(null);
        planType = m.result?.account?.planType || null;
        expectedId = 3;
        send({ id: 3, method: 'account/rateLimits/read', params: {} });
      } else if (m.id === 3) {
        if (m.error) return done(null);
        const r = m.result;
        const limit = (r && Object.hasOwn(r, 'rateLimitsByLimitId') && r.rateLimitsByLimitId)
          ? r.rateLimitsByLimitId.codex
          : r?.rateLimits;
        if (!limit) return done(null);

        const windows = [];
        const seenIds = new Set();
        for (const [k, w] of Object.entries(limit)) {
          if (k === 'planType' || !w || typeof w !== 'object') continue;
          const duration = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : (typeof w.window_minutes === 'number' ? w.window_minutes : null);
          const used = typeof w.usedPercent === 'number' ? w.usedPercent : (typeof w.used_percent === 'number' ? w.used_percent : null);
          if (used === null) continue;
          const is5h = (duration === 300 || (k === 'primary' && duration === null));
          const isWeek = (duration === 10080 || (k === 'secondary' && duration === null));
          const id = is5h ? 'fiveHour' : (isWeek ? 'weekly' : (duration ? `w_${duration}` : `win_${k}`));
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          const label = is5h ? '5h' : (isWeek ? 'Weekly' : (duration ? (duration >= 60 ? `${Math.round(duration / 60)}h` : `${duration}m`) : String(k)));
          const resetsAt = typeof w.resetsAt === 'number' ? w.resetsAt : (typeof w.resets_at === 'number' ? w.resets_at : null);
          windows.push({
            id,
            label,
            key: k,
            minutes: duration,
            used,
            usedPercent: used,
            remaining: Math.max(0, 100 - used),
            remainingPercent: Math.max(0, 100 - used),
            resetsAt
          });
        }
        const rawPlan = limit.planType || planType || null;
        done({
          ok: windows.length > 0,
          planLabel: formatPlanLabel(rawPlan),
          observedAt: Date.now(),
          windows
        });
      }
    });

    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'agent_pet', title: 'AgentPet', version: '2.0.0' } }
    });
  });
}

function isStateFresh(state, now) {
  if (!state || !state.state) return false;
  const age = now - (state.at || 0);
  if (isHeldState(state)) return age < WAITING_MAX_AGE_MS;
  if (state.state === 'success' || state.state === 'result' || state.state === 'error') {
    return age < TERMINAL_HOLD_MS;
  }
  return age < ACTIVE_MAX_AGE_MS;
}

function refreshDynamicState(state, now, stallEnabled, stallMs) {
  if (!state) return null;
  if (!state.inFlight) {
    if (state.nextState && now - (state.at || 0) >= TERMINAL_HOLD_MS) {
      const next = { ...state, ...state.nextState, at: state.at, inFlight: false };
      delete next.nextState;
      return isStateFresh(next, now) ? next : null;
    }
    return isStateFresh(state, now) ? state : null;
  }
  if (state.state === 'waiting' || state.state === 'approval') return isStateFresh(state, now) ? state : null;
  const startedAt = Number(state.startedAt || state.at || 0);
  const ageMs = now - startedAt;
  if (ageMs < 0 || ageMs >= WAITING_MAX_AGE_MS) return null;
  const stalled = Boolean(stallEnabled && ageMs >= stallMs);
  const base = state.baseTask || state.task || state.toolName || '工具';
  const ageSeconds = Math.floor(ageMs / 5000) * 5;
  return { ...state, state: stalled ? 'stalled' : 'working',
    task: stalled ? `好像卡住了：${base} 已发起 ${ageSeconds} 秒无响应` : base,
    at: startedAt };
}

function isHeldState(state) {
  return Boolean(state && (state.inFlight || state.state === 'waiting' || state.state === 'approval' || state.state === 'stalled'));
}

function isSameProjectMonitor(pid, expectedScriptPath) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return false;
  }

  try {
    const cmd = `powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; if ($p) { $p.CommandLine }"`;
    const stdout = execSync(cmd, {
      windowsHide: true,
      timeout: 2500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (!stdout) return false;
    const cleanOut = stdout.toLowerCase().replace(/\\/g, '/');
    const cleanExpected = expectedScriptPath.toLowerCase().replace(/\\/g, '/');
    return cleanOut.includes(cleanExpected);
  } catch {
    return false;
  }
}

function parseAntigravityStep(row) {
  const metaStr = Buffer.from(row.metadata).toString('utf8');
  let toolName = null;
  let toolSummary = null;

  const knownTools = [
    'run_command', 'write_file', 'read_file', 'edit_file',
    'ask_question', 'ask_user', 'request_user_input', 'request_confirmation', 'search_web', 'search_marketplace',
    'manage_task', 'manage_subagents', 'invoke_subagent', 'schedule',
    'send_message', 'define_subagent'
  ];
  for (const kt of knownTools) {
    if (metaStr.includes(kt)) {
      toolName = kt;
      break;
    }
  }

  const rawSummary = extractJsonStringField(metaStr, 'toolSummary');
  const rawCommandLine = extractJsonStringField(metaStr, 'CommandLine');
  const rawCwd = extractJsonStringField(metaStr, 'Cwd');
  const rawPath = extractJsonStringField(metaStr, 'Path')
    || extractJsonStringField(metaStr, 'TargetFile')
    || extractJsonStringField(metaStr, 'AbsolutePath');

  if (rawSummary) {
    toolSummary = rawSummary;
  } else if (rawCommandLine) {
    toolSummary = rawCommandLine.slice(0, 45);
  } else if (rawPath) {
    toolSummary = rawPath.split(/[\\/]/).pop();
  }

  const detailParts = [];
  if (rawSummary) {
    detailParts.push(toolName && rawSummary !== toolName ? `${toolName}: ${rawSummary}` : rawSummary);
  }
  if (rawCommandLine && rawCommandLine !== rawSummary) {
    detailParts.push(detailParts.length ? `命令: ${rawCommandLine}` : (toolName ? `${toolName}: ${rawCommandLine}` : rawCommandLine));
  }
  if (rawCwd) {
    detailParts.push(`工作目录: ${rawCwd}`);
  }
  if (rawPath && rawPath !== rawSummary && (!rawCommandLine || !rawCommandLine.includes(rawPath))) {
    detailParts.push(detailParts.length ? `文件: ${rawPath}` : (toolName ? `${toolName}: ${rawPath}` : rawPath));
  }
  const toolDetail = finalizeTaskDetail(detailParts.join('\n'));

  return { toolName, toolSummary, toolDetail };
}

class AgentMonitor {
  constructor(options = {}) {
    this.onChange = options.onChange || (() => {});
    this.timer = null;
    this.lastStateKey = '';
    this.lastSource = null;
    this.lastQuotaAt = 0;
    this.quotaBusy = false;
    this.lastFlagMtime = 0;
    this.parentPid = options.parentPid || null;
    const rawStall = options.stallSeconds != null ? Number(options.stallSeconds) : 45;
    this.stallEnabled = Number.isFinite(rawStall) && rawStall > 0;
    this.stallMs = (Number.isFinite(rawStall) && rawStall >= 0 ? rawStall : 45) * 1000;
    this.lastLivePlanLabel = null;
    this.lastDshScanTime = 0;
    this.dshLatestFile = null;
    this.dshSessionCandidates = null;
    this.lastDshSessionScan = 0;
    this.lastAgDbScan = 0;
    this.lastAgTranscriptScan = 0;
    this.antigravityDbCandidates = null;
    this.antigravityTranscriptCandidates = null;
    this.antigravityDbCache = new Map();
    this.antigravityTranscriptCache = new Map();
    this.dshStateCache = new Map();
    this.isProbe = options.isProbe || false;

    // Caching layer to avoid heavy 500ms disk parsing (Issue 12)
    this.cachedDsh = { mtime: 0, file: null, state: null };
    this.cachedAg = { mtime: 0, file: null, state: null };
    this.cachedCodex = { mtime: 0, size: 0, file: null, state: null };
    this.codexStateCache = new Map();
    this.codexAsyncCache = new Map();
    this.codexRolloutCandidates = [];
    this.lastCodexRolloutScan = 0;

    const home = os.homedir();
    const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    this.paths = {
      appDir,
      refreshFlag: path.join(appDir, 'refresh-quota.flag'),
      refreshBalanceFlag: path.join(appDir, 'refresh-balance.flag'),
      balanceFile: path.join(appDir, 'runtime-balance.json'),
      antigravity: path.join(home, '.gemini', 'antigravity', 'brain'),
      antigravityDb: path.join(home, '.gemini', 'antigravity', 'conversations'),
      codex: process.env.CODEX_HOME || path.join(home, '.codex'),
      dshDirs: resolveDshDirs()
    };

    this.balanceBusy = false;
    this.lastBalanceAt = 0;
    this.lastBalanceFetchAttempt = 0;
    this.lastFlagBalanceMtime = 0;
    this.balanceBackoffIndex = -1;
    this.balanceRetryAfterUntil = 0;
    this.cachedBalanceData = null;
    this.balanceGeneration = 0;
    this.balanceDisabledPublished = false;
    this.cachedDshPort = null;
    this.lastDshPortCheck = 0;
    this.activeHostSignature = null;
  }

  readPetConfig() {
    try {
      const configPath = path.join(this.paths.appDir, 'config.json');
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
        return JSON.parse(raw);
      }
    } catch {}
    return {};
  }

  resolveDshHomeDir(customDir) {
    if (customDir && typeof customDir === 'string' && customDir.trim()) {
      const p = customDir.trim();
      try {
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
      } catch {}
      return null;
    }

    // 1. Explicit environment variables (highest priority)
    for (const envVar of ['DSH_HOME', 'DEEPSEEK_HARNESS_HOME', 'DSH_DIR']) {
      const envVal = process.env[envVar];
      if (envVal && typeof envVal === 'string') {
        const p = envVal.trim();
        if (p) {
          try {
            if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
          } catch {}
        }
      }
    }

    // 2. Standard user home and AppData locations
    const home = os.homedir();
    const candidates = [
      path.join(home, '.dsh'),
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'dsh') : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, 'dsh') : null
    ].filter(Boolean);

    // 3. Mounted system drives
    for (const drive of getSystemDrives()) {
      candidates.push(path.join(`${drive}\\`, 'dsh'));
    }

    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
          return c;
        }
      } catch {}
    }

    return null;
  }

  invalidateBalance(reason, { emitLoading = true } = {}) {
    this.balanceGeneration++;
    this.cachedBalanceData = null;
    this.lastBalanceFetchAttempt = 0;
    this.balanceRetryAfterUntil = 0;
    this.balanceBusy = false;
    this.activeHostSignature = null;
    this.cachedDshPort = null;
    writeErrorLog(`Balance invalidated: ${reason} (new gen: ${this.balanceGeneration})`);
    if (!emitLoading) return;
    this.onChange({
      type: 'balance',
      provider: 'unknown',
      providerFamily: 'deepseek',
      credentialSource: 'dsh',
      status: 'loading',
      isAvailable: null,
      currency: 'CNY',
      balances: [],
      hostCounter: null,
      fetchedAt: Date.now(),
      observedAt: null,
      lastAttemptAt: Date.now(),
      errorCode: null,
      errorMessage: null
    });
  }

  async findActiveDshBaseUrl(config, deadline = 0) {
    const getRemaining = (capMs, minReq = 100) => {
      if (!deadline) return capMs;
      const rem = deadline - Date.now();
      return rem >= minReq ? Math.min(capMs, rem) : 0;
    };

    if (config.DshCredentialReuseEnabled !== undefined && !this._warnedDshReuseDeprecated) {
      this._warnedDshReuseDeprecated = true;
      writeErrorLog('已忽略废弃配置键 DshCredentialReuseEnabled');
    }
    if (config.DshPort && /^\d+$/.test(String(config.DshPort).trim())) {
      const p = parseInt(String(config.DshPort).trim(), 10);
      const v = validateLoopbackUrl(`http://127.0.0.1:${p}`);
      if (v) return v;
    }
    if (config.DshBaseUrl && typeof config.DshBaseUrl === 'string') {
      const v = validateLoopbackUrl(config.DshBaseUrl.replace(/\/+$/, ''));
      if (v) return v;
    }

    if (this.cachedDshPort) {
      const rem = getRemaining(600);
      if (rem > 0) {
        try {
          const testRes = await fetch(`http://127.0.0.1:${this.cachedDshPort}/dsh-pet-7340/state`, {
            signal: AbortSignal.timeout(rem),
            redirect: 'error'
          });
          const j = await testRes.json().catch(() => null);
          if (testRes.status === 200 && j && j.sections && j.sections.balance) {
            this.lastDshPortCheck = Date.now();
            return `http://127.0.0.1:${this.cachedDshPort}`;
          } else {
            this.cachedDshPort = null;
          }
        } catch {
          this.cachedDshPort = null;
        }
      } else {
        this.cachedDshPort = null;
      }
    }

    if (getRemaining(1000) <= 0) return null;

    let dshPids = new Set();
    try {
      const taskTimeout = getRemaining(1500, 400);
      if (taskTimeout > 0) {
        const { stdout: taskOut } = await execFileAsync('tasklist.exe', [
          '/fi', 'imagename eq DeepSeek Harness.exe',
          '/fo', 'csv',
          '/nh'
        ], {
          encoding: 'utf8',
          timeout: taskTimeout,
          signal: AbortSignal.timeout(taskTimeout),
          windowsHide: true
        });
        for (const line of taskOut.split(/\r?\n/)) {
          const parts = line.split('","');
          if (parts.length >= 2) {
            const pid = parseInt(parts[1], 10);
            if (pid) dshPids.add(pid);
          }
        }
      }
    } catch {}

    if (dshPids.size === 0) {
      this.cachedDshPort = null;
      return null;
    }

    if (getRemaining(1000) <= 0) return null;

    const candidatePorts = [];
    try {
      const netTimeout = getRemaining(1500, 400);
      if (netTimeout > 0) {
        const { stdout: netOut } = await execFileAsync('netstat.exe', [
          '-ano',
          '-p', 'tcp'
        ], {
          encoding: 'utf8',
          timeout: netTimeout,
          signal: AbortSignal.timeout(netTimeout),
          windowsHide: true
        });
        for (const line of netOut.split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5 && parts[0] === 'TCP' && parts[3] === 'LISTENING') {
            const [addr, portStr] = parts[1].split(':');
            if (addr === '127.0.0.1') {
              const port = parseInt(portStr, 10);
              const pid = parseInt(parts[4], 10);
              if (dshPids.has(pid) && port >= 1024 && port <= 65535 && !candidatePorts.includes(port)) {
                candidatePorts.push(port);
              }
            }
          }
        }
      }
    } catch {}

    // Cap candidate ports to 3 to prevent unlimited sequential probe accumulation
    const portsToProbe = candidatePorts.slice(0, 3);
    for (const port of portsToProbe) {
      const probeTimeout = getRemaining(800, 200);
      if (probeTimeout <= 0) break;
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/dsh-pet-7340/state`, {
          signal: AbortSignal.timeout(probeTimeout),
          redirect: 'error'
        });
        if (resp.status === 200) {
          const json = await resp.json().catch(() => null);
          if (json && json.sections && json.sections.balance) {
            this.cachedDshPort = port;
            this.lastDshPortCheck = Date.now();
            return `http://127.0.0.1:${port}`;
          }
        }
      } catch {}
    }

    this.cachedDshPort = null;
    return null;
  }

  startParentWatchdog(parentPid) {
    if (!parentPid) return;
    this.parentWatchTimer = setInterval(() => {
      let isAlive = false;
      try {
        process.kill(parentPid, 0);
        isAlive = true;
      } catch (err) {
        isAlive = (err.code !== 'ESRCH');
      }
      if (!isAlive) {
        writeErrorLog(`Parent process ${parentPid} no longer exists. Exiting monitor daemon.`);
        this.stop();
        try {
          const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
          const monPidPath = path.join(appDir, 'runtime', 'monitor.pid');
          if (fs.existsSync(monPidPath)) {
            const raw = fs.readFileSync(monPidPath, 'utf8');
            try {
              if (JSON.parse(raw).pid === process.pid) fs.unlinkSync(monPidPath);
            } catch {
              if (raw.trim() === String(process.pid)) fs.unlinkSync(monPidPath);
            }
          }
        } catch {}
        process.exit(0);
      }
    }, 4000);
  }

  start() {
    if (this.timer) return;
    this.scan();
    this.pollQuota(true);
    this.pollBalance(true);
    if (this.parentPid) {
      this.startParentWatchdog(this.parentPid);
    }
    // Keep timer referenced so the Node.js event loop runs permanently as a background daemon
    this.timer = setInterval(() => {
      flushPendingWrites(Date.now());
      this.scan();
      this.checkQuotaTrigger();
      this.checkBalanceTrigger();
    }, SCAN_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.parentWatchTimer) {
      clearInterval(this.parentWatchTimer);
      this.parentWatchTimer = null;
    }
  }


  checkBalanceTrigger() {
    const config = this.readPetConfig();
    const balanceEnabled = (config.DeepSeekBalanceEnabled !== false);
    const configSig = `${config.DeepSeekBalanceEnabled}:${config.DshPort || 0}:${config.DshBaseUrl || ''}`;
    const now = Date.now();

    // AP04: 每轮先消费手动刷新标记，再决定通知或查询，避免配置变化的早退分支留下标记
    let force = false;
    try {
      if (fs.existsSync(this.paths.refreshBalanceFlag)) {
        const st = fs.statSync(this.paths.refreshBalanceFlag);
        if (st.mtimeMs > this.lastFlagBalanceMtime) {
          this.lastFlagBalanceMtime = st.mtimeMs;
          force = true;
        }
        try { fs.unlinkSync(this.paths.refreshBalanceFlag); } catch {}
      }
    } catch {}

    const configChanged = this.lastConfigSig !== undefined && this.lastConfigSig !== configSig;
    this.lastConfigSig = configSig;
    if (configChanged) {
      if (balanceEnabled) {
        // 重新启用或改端口：使旧在途请求失效并立即查询
        this.invalidateBalance('CONFIG_CHANGED');
        this.pollBalance(true);
      } else {
        // 切换为禁用：使旧在途请求失效，只发布一次停用结果
        this.invalidateBalance('BALANCE_DISABLED', { emitLoading: false });
        this.publishBalanceDisabled(now);
      }
      return;
    }

    if (!balanceEnabled) {
      // 稳定禁用：不探测宿主、不发请求、不自动重复写入；手动刷新至多回写一次停用结果以结束界面等待
      if (force || !this.balanceDisabledPublished) this.publishBalanceDisabled(now);
      return;
    }

    // 10 minutes staleness detection (2 * 5m cycle)
    if (this.cachedBalanceData?.status === 'ok' && (now - (this.cachedBalanceData.fetchedAt || 0) > 600_000)) {
      this.cachedBalanceData.status = 'stale';
      this.onChange(this.cachedBalanceData);
    }

    const interval = (this.balanceBackoffIndex >= 0)
      ? BALANCE_BACKOFF_MS[Math.min(this.balanceBackoffIndex, BALANCE_BACKOFF_MS.length - 1)]
      : BALANCE_POLL_MS;

    if (force || (now - this.lastBalanceAt >= interval)) {
      this.pollBalance(force);
    }
  }

  publishBalanceDisabled(now = Date.now()) {
    this.cachedBalanceData = null;
    this.balanceDisabledPublished = true;
    this.lastBalanceAt = now;
    this.onChange({
      type: 'balance',
      provider: 'unknown',
      providerFamily: 'deepseek',
      credentialSource: 'dsh',
      status: 'dsh_disabled',
      isAvailable: false,
      currency: 'CNY',
      balances: [],
      hostCounter: null,
      fetchedAt: now,
      observedAt: null,
      lastAttemptAt: now,
      errorCode: 'BALANCE_DISABLED',
      errorMessage: 'DeepSeek 余额服务未启用（可在菜单中开启）'
    });
  }

  async pollBalance(force = false) {
    if (this.balanceBusy) return;
    const now = Date.now();
    const config = this.readPetConfig();

    const balanceEnabled = (config.DeepSeekBalanceEnabled !== false);
    if (!balanceEnabled) {
      this.publishBalanceDisabled(now);
      return;
    }
    this.balanceDisabledPublished = false;

    if (this.lastBalanceFetchAttempt && (now - this.lastBalanceFetchAttempt < 10_000)) {
      if (force && this.cachedBalanceData) {
        const sec = Math.max(1, Math.ceil((10_000 - (now - this.lastBalanceFetchAttempt)) / 1000));
        const data = {
          ...this.cachedBalanceData,
          lastAttemptAt: now,
          errorCode: 'COOLDOWN',
          errorMessage: `刷新过于频繁，请等待 ${sec} 秒后再试`
        };
        this.onChange(data);
      }
      return;
    }

    if (this.balanceRetryAfterUntil > now) {
      if (force && this.cachedBalanceData) {
        const sec = Math.max(1, Math.ceil((this.balanceRetryAfterUntil - now) / 1000));
        const data = {
          ...this.cachedBalanceData,
          status: 'stale',
          lastAttemptAt: now,
          errorCode: 'RATE_LIMITED',
          errorMessage: `请求频率超限，重试需等待 ${sec} 秒`
        };
        this.onChange(data);
      }
      return;
    }

    this.balanceBusy = true;
    this.lastBalanceAt = now;
    this.lastBalanceFetchAttempt = now;
    const currentGen = ++this.balanceGeneration;

    // 全链路统一总截止时间预算：10秒（前端设置15秒期限，预留5秒调度冗余）
    const TOTAL_BALANCE_BUDGET_MS = 10_000;
    const deadline = now + TOTAL_BALANCE_BUDGET_MS;
    const getRemainingBudget = (capMs = 10_000, minReq = 150) => {
      const rem = deadline - Date.now();
      return rem >= minReq ? Math.min(capMs, rem) : 0;
    };

    try {
      if (getRemainingBudget(10_000, 300) <= 0) {
        throw new Error('DSH_DEADLINE_EXCEEDED: 全链路查询预算耗尽');
      }

      const baseUrl = await this.findActiveDshBaseUrl(config, deadline);
      if (this.balanceGeneration !== currentGen) return;

      if (!baseUrl) {
        // 未发现运行中的 DSH：清空旧金额，不残留旧账户数据
        this.cachedBalanceData = null;
        const data = {
          type: 'balance',
          provider: 'unknown',
          providerFamily: 'deepseek',
          credentialSource: 'dsh',
          status: 'dsh_not_running',
          isAvailable: false,
          currency: 'CNY',
          balances: [],
          hostCounter: null,
          fetchedAt: Date.now(),
          observedAt: null,
          lastAttemptAt: now,
          errorCode: 'DSH_NOT_RUNNING',
          errorMessage: 'DSH 未运行，请启动 DeepSeek Harness'
        };
        this.onChange(data);
        return;
      }

      let manualRefreshFailed = false;
      if (force) {
        const postBudget = getRemainingBudget(3500, 400);
        if (postBudget > 0) {
          try {
            const postResp = await fetch(`${baseUrl}/dsh-pet-7340/balance`, {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.timeout(postBudget)
            });
            if (this.balanceGeneration !== currentGen) return;
            if (postResp.status !== 200) {
              manualRefreshFailed = true;
              writeErrorLog(`DSH /balance POST returned HTTP ${postResp.status}`);
            } else {
              const postJson = await postResp.json().catch(() => null);
              if (this.balanceGeneration !== currentGen) return;
              if (!postJson || postJson.ok !== true) {
                manualRefreshFailed = true;
              }
            }
          } catch (postErr) {
            if (this.balanceGeneration !== currentGen) return;
            manualRefreshFailed = true;
            writeErrorLog(`DSH /balance POST error: ${postErr.message}`);
          }
        } else {
          manualRefreshFailed = true;
        }
      }

      const getBudget = getRemainingBudget(5000, 300);
      if (getBudget <= 0) {
        throw new Error('DSH_DEADLINE_EXCEEDED: 全链路查询预算耗尽');
      }

      const stateResp = await fetch(`${baseUrl}/dsh-pet-7340/state`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(getBudget)
      });

      if (this.balanceGeneration !== currentGen) return;

      if (stateResp.status === 429) {
        let retrySec = 60;
        const raHeader = stateResp.headers.get('retry-after');
        if (raHeader) {
          const parsedRa = parseInt(raHeader, 10);
          if (Number.isFinite(parsedRa) && parsedRa > 0) retrySec = parsedRa;
        }
        this.balanceRetryAfterUntil = Date.now() + (retrySec * 1000);
        this.balanceBackoffIndex = Math.min((this.balanceBackoffIndex >= 0 ? this.balanceBackoffIndex + 1 : 0), BALANCE_BACKOFF_MS.length - 1);
        this.cachedBalanceData = null;
        const data = {
          type: 'balance',
          provider: 'unknown',
          providerFamily: 'deepseek',
          credentialSource: 'dsh',
          isAvailable: false,
          status: 'error',
          balances: [],
          hostCounter: null,
          fetchedAt: Date.now(),
          observedAt: null,
          lastAttemptAt: Date.now(),
          errorCode: 'RATE_LIMITED',
          errorMessage: `请求频率超限，重试需等待 ${retrySec} 秒`
        };
        this.onChange(data);
        return;
      }

      if (stateResp.status !== 200) {
        throw new Error(`DSH_HTTP_${stateResp.status}: DSH 状态接口返回 ${stateResp.status}`);
      }

      const stateJson = await stateResp.json();
      if (this.balanceGeneration !== currentGen) return;

      const balanceSection = stateJson?.sections?.balance;
      if (!balanceSection || typeof balanceSection !== 'object') {
        throw new Error('DSH_BALANCE_MISSING: DSH 响应中未包含 balance 状态块');
      }

      const counter = (typeof balanceSection.counter === 'number' && Number.isFinite(balanceSection.counter) && balanceSection.counter > 0)
        ? balanceSection.counter
        : null;

      const result = balanceSection.data;
      if (!result || typeof result !== 'object') {
        throw new Error('DSH_DATA_MISSING: sections.balance 中未包含 data 结果对象');
      }

      // Handle ok === false (BalanceUnavailable / credential-missing / unsupported)
      if (result.ok === false) {
        const reason = String(result.reason || '');
        let errorCode = 'DSH_FETCH_ERROR';
        let errorMessage = 'DSH 余额获取失败';
        if (reason === 'unsupported') {
          errorCode = 'DSH_UNSUPPORTED';
          errorMessage = '当前服务商不支持余额查询';
        } else if (reason === 'credential-missing') {
          errorCode = 'DSH_CREDENTIAL_MISSING';
          errorMessage = '请在 DSH 中配置当前服务商凭据';
        }
        // P1-1: 凭据缺失或服务商不匹配时，彻底清空旧余额，不残留上一账户金额
        this.cachedBalanceData = null;
        const data = {
          type: 'balance',
          provider: result.provider || 'deepseek',
          credentialSource: 'dsh',
          status: 'error',
          isAvailable: false,
          currency: 'CNY',
          balances: [],
          hostCounter: counter,
          fetchedAt: Date.now(),
          observedAt: null,
          lastAttemptAt: now,
          errorCode,
          errorMessage
        };
        this.onChange(data);
        return;
      }

      // Validate ok === true
      if (result.ok !== true) {
        throw new Error('DSH_FORMAT_ERROR: 响应缺失 ok: true 标识');
      }

      // Validate shape === 'money'
      if (result.shape !== 'money') {
        this.cachedBalanceData = null;
        const data = {
          type: 'balance',
          provider: result.provider || 'deepseek',
          credentialSource: 'dsh',
          status: 'error',
          isAvailable: false,
          currency: 'CNY',
          balances: [],
          hostCounter: counter,
          fetchedAt: Date.now(),
          observedAt: null,
          lastAttemptAt: now,
          errorCode: 'DSH_UNSUPPORTED_SHAPE',
          errorMessage: `当前余额形态 (${result.shape || '未知'}) 不支持展示人民币`
        };
        this.onChange(data);
        return;
      }

      // Extract wallets array
      let rawWallets = null;
      if (result.data && typeof result.data === 'object' && Array.isArray(result.data.wallets)) {
        rawWallets = result.data.wallets;
      } else if (Array.isArray(result.wallets)) {
        rawWallets = result.wallets;
      } else if (result.data && typeof result.data === 'object' && result.data.currency) {
        rawWallets = [result.data];
      }

      if (!Array.isArray(rawWallets)) {
        this.cachedBalanceData = null;
        const data = {
          type: 'balance',
          provider: result.provider || 'deepseek',
          credentialSource: 'dsh',
          status: 'error',
          isAvailable: false,
          currency: 'CNY',
          balances: [],
          hostCounter: counter,
          fetchedAt: Date.now(),
          observedAt: null,
          lastAttemptAt: now,
          errorCode: 'DSH_FORMAT_ERROR',
          errorMessage: 'DSH 响应格式异常：缺失 wallets 钱包列表'
        };
        this.onChange(data);
        return;
      }

      // Parse CNY wallet
      const isValidDecimal = (v) => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim());
      const balances = [];
      let cnyFormatError = null;

      for (const w of rawWallets) {
        if (!w || typeof w !== 'object') continue;
        const currency = String(w.currency || '').toUpperCase().trim();
        if (currency !== 'CNY') continue;

        const totalRaw = typeof w.total === 'string' ? w.total : (typeof w.total === 'number' ? String(w.total) : null);
        if (!totalRaw || !isValidDecimal(totalRaw)) {
          cnyFormatError = 'DSH 余额数值非法或非数字';
          break;
        }

        const toppedUpRaw = typeof w.toppedUp === 'string' && isValidDecimal(w.toppedUp) ? w.toppedUp.trim() : null;
        const grantedRaw = typeof w.granted === 'string' && isValidDecimal(w.granted) ? w.granted.trim() : null;

        balances.push({
          currency: 'CNY',
          totalBalance: totalRaw.trim(),
          toppedUpBalance: toppedUpRaw,
          grantedBalance: grantedRaw
        });
      }

      if (cnyFormatError) {
        this.cachedBalanceData = null;
        const data = {
          type: 'balance',
          provider: result.provider || 'deepseek',
          credentialSource: 'dsh',
          status: 'error',
          isAvailable: false,
          currency: 'CNY',
          balances: [],
          hostCounter: counter,
          fetchedAt: Date.now(),
          observedAt: null,
          lastAttemptAt: now,
          errorCode: 'DSH_FORMAT_ERROR',
          errorMessage: cnyFormatError
        };
        this.onChange(data);
        return;
      }

      // P1-1: 账户归属判定与不透明代次
      // 严正准则：不得将 balance.counter 当作账户标识，普通刷新改变 counter 不得误报账户切换
      const accountOpaqueId = result.accountContext || result.accountId || result.credentialGeneration || null;
      const hostSig = accountOpaqueId
        ? `${baseUrl}:${result.provider || ''}:${accountOpaqueId}`
        : `${baseUrl}:${result.provider || ''}`;

      if (this.activeHostSignature !== null && this.activeHostSignature !== hostSig) {
        writeErrorLog(`DSH host context changed: ${this.activeHostSignature} -> ${hostSig}`);
        this.cachedBalanceData = null;
        this.balanceBackoffIndex = -1;
      }
      this.activeHostSignature = hostSig;

      this.balanceBackoffIndex = -1;

      // P1-1: 刷新失败时账户归属无法确认，绝不沿用/输出旧快照金额，强制清空缓存并设 balances 为空
      if (force && manualRefreshFailed) {
        this.cachedBalanceData = null;
        const data = {
          type: 'balance',
          provider: result.provider || 'deepseek',
          credentialSource: 'dsh',
          status: 'error',
          isAvailable: false,
          currency: 'CNY',
          balances: [], // 彻底清空！不可确认归属时绝不保留历史快照金额！
          hostCounter: counter,
          fetchedAt: Date.now(),
          observedAt: null,
          lastAttemptAt: now,
          errorCode: 'REFRESH_FAILED',
          errorMessage: '宿主刷新接口请求失败，已清空无法确认归属的历史金额（点击 ↻ 重试）'
        };
        this.onChange(data);
        return;
      }

      const isAvailable = (typeof result.is_available === 'boolean') ? result.is_available : null;

      const data = {
        type: 'balance',
        provider: result.provider || 'deepseek',
        credentialSource: 'dsh',
        status: 'ok',
        isAvailable,
        currency: 'CNY',
        balances,
        hostCounter: counter,
        fetchedAt: Date.now(),
        observedAt: null,
        lastAttemptAt: now,
        errorCode: null,
        errorMessage: null
      };
      this.cachedBalanceData = data;
      this.onChange(data);

    } catch (err) {
      if (this.balanceGeneration !== currentGen) return;
      writeErrorLog(`DSH balance query error: ${err.message}`);
      this.balanceBackoffIndex = Math.min((this.balanceBackoffIndex >= 0 ? this.balanceBackoffIndex + 1 : 0), BALANCE_BACKOFF_MS.length - 1);

      // P1-1: 保守降级：查询失败时清空无法确认归属的旧金额，避免换账户后展示旧账户缓存或触发旧账户报警
      this.cachedBalanceData = null;
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError' || err.message.includes('DEADLINE') || err.message.includes('timeout') || err.message.includes('aborted');

      const data = {
        type: 'balance',
        provider: 'unknown',
        providerFamily: 'deepseek',
        credentialSource: 'dsh',
        status: 'error',
        isAvailable: null,
        currency: 'CNY',
        balances: [], // 彻底清空！
        hostCounter: null,
        fetchedAt: Date.now(),
        observedAt: null,
        lastAttemptAt: now,
        errorCode: isTimeout ? 'TIMEOUT' : 'DSH_FETCH_ERROR',
        errorMessage: isTimeout ? '查询 DSH 余额超时（已达全链路10秒上限）' : (err.message.startsWith('DSH_') ? err.message : '连接 DSH 宿主失败')
      };
      this.onChange(data);
    } finally {
      if (this.balanceGeneration === currentGen) {
        this.balanceBusy = false;
      }
    }
  }

  checkQuotaTrigger() {
    const now = Date.now();
    let force = false;
    try {
      if (fs.existsSync(this.paths.refreshFlag)) {
        const st = fs.statSync(this.paths.refreshFlag);
        if (st.mtimeMs > this.lastFlagMtime) {
          this.lastFlagMtime = st.mtimeMs;
          force = true;
        }
        try { fs.unlinkSync(this.paths.refreshFlag); } catch {}
      }
    } catch {}

    if (force || now - this.lastQuotaAt >= QUOTA_POLL_MS) {
      this.pollQuota(force);
    }
  }

  async pollQuota(force = false) {
    if (this.quotaBusy) return;
    this.quotaBusy = true;
    this.lastQuotaAt = Date.now();
    try {
      const cli = resolveCodexCli();
      const live = await queryCodexRateLimits(cli);
      if (live && live.ok) {
        if (live.planLabel) this.lastLivePlanLabel = live.planLabel;
        this.onChange({
          type: 'quota',
          ok: true,
          planLabel: live.planLabel,
          observedAt: Math.round(Number(live.observedAt) || Date.now()),
          windows: live.windows
        });
        return;
      }
      this.emitFallbackQuota();
    } finally {
      this.quotaBusy = false;
    }
  }

  emitFallbackQuota() {
    // Fallback directly to latest official Codex rollout token_count log
    try {
      const latest = this.findLatestCodexRollout(Date.now(), 7 * 24 * 3600 * 1000);
      if (latest) {
        const lines = this.readTailLines(latest.file, 65536);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const e = JSON.parse(lines[i]);
            if (e.payload?.type === 'token_count' && e.payload?.rate_limits) {
              const rl = e.payload.rate_limits;
              const windows = [];
              const seenFallbackIds = new Set();
              for (const [k, w] of Object.entries(rl)) {
                if (!w || typeof w !== 'object') continue;
                const duration = typeof w.window_minutes === 'number' ? w.window_minutes : (typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null);
                const used = typeof w.used_percent === 'number' ? w.used_percent : (typeof w.usedPercent === 'number' ? w.usedPercent : null);
                if (used === null) continue;
                const is5h = (duration === 300 || (k === 'primary' && duration === null));
                const isWeek = (duration === 10080 || (k === 'secondary' && duration === null));
                const id = is5h ? 'fiveHour' : (isWeek ? 'weekly' : (duration ? `w_${duration}` : `win_${k}`));
                if (seenFallbackIds.has(id)) continue;
                seenFallbackIds.add(id);
                const label = is5h ? '5h' : (isWeek ? 'Weekly' : (duration ? (duration >= 60 ? `${Math.round(duration / 60)}h` : `${duration}m`) : String(k)));
                const resetsAt = typeof w.resets_at === 'number' ? w.resets_at : (typeof w.resetsAt === 'number' ? w.resetsAt : null);
                windows.push({
                  id,
                  label,
                  key: k,
                  minutes: duration,
                  used,
                  usedPercent: used,
                  remaining: Math.max(0, 100 - used),
                  remainingPercent: Math.max(0, 100 - used),
                  resetsAt
                });
              }
              if (windows.length > 0) {
                this.onChange({
                  type: 'quota',
                  ok: true,
                  planLabel: (this.lastLivePlanLabel || '离线快照'),
                  observedAt: Math.round(Number(latest.mtime) || Date.now()),
                  windows
                });
                return;
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  readTailLines(filePath, maxBytes = 131072) {
    let fd = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const st = fs.fstatSync(fd);
      const readLen = Math.min(st.size, maxBytes);
      const offset = Math.max(0, st.size - readLen);
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, offset);
      let text = buf.toString('utf8', 0, readLen);
      if (offset > 0) {
        const firstNl = text.indexOf('\n');
        if (firstNl >= 0) text = text.slice(firstNl + 1);
      }
      return text.trim().split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }

  scan() {
    const now = Date.now();
    let best = null;

    const normalizeAgent = (a) => {
      if (!a || !isStateFresh(a, now)) return null;
      const rawId = a.rawId || a.sessionId || null;
      const taskDetail = finalizeTaskDetail(a.taskDetail ?? null);
      return {
        ...a,
        ...(rawId ? { rawId } : {}),
        taskDetail
      };
    };

    // 1. Check Google Antigravity
    const ag = normalizeAgent(this.checkAntigravity(now));
    if (ag) best = this.selectBest(best, ag, now);

    // 2. Check DeepSeek Harness (DSH)
    const dsh = normalizeAgent(this.checkDsh(now));
    if (dsh) best = this.selectBest(best, dsh, now);

    // 3. Check Codex
    const codex = normalizeAgent(this.checkCodex(now));
    if (codex) best = this.selectBest(best, codex, now);

    const allAgents = {
      antigravity: ag,
      dsh: dsh,
      codex: codex
    };
    // P2-1: activeCount only counts active working states (working, thinking, waiting, approval)
    const ACTIVE_WORK_STATES = new Set(['working', 'thinking', 'waiting', 'approval', 'stalled']);
    const activeCount = [allAgents.antigravity, allAgents.dsh, allAgents.codex].filter(
      a => Boolean(a && a.state && ACTIVE_WORK_STATES.has(a.state))
    ).length;

    const agentSnapshot = (a) => a ? [
      a.source || '',
      a.rawId || a.sessionId || '',
      a.state || '',
      a.task || '',
      a.taskDetail ?? null,
      a.sessionCount || 0
    ] : null;

    const key = best ? JSON.stringify({
      source: best.source || '',
      rawId: best.rawId || best.sessionId || '',
      state: best.state || '',
      task: best.task || '',
      taskDetail: best.taskDetail ?? null,
      sessionCount: best.sessionCount || 0,
      activeCount,
      agents: {
        antigravity: agentSnapshot(allAgents.antigravity),
        dsh: agentSnapshot(allAgents.dsh),
        codex: agentSnapshot(allAgents.codex)
      }
    }) : '';

    const nowMs = now;
    if (!best) {
      _cachedStatusTier = null;
      _cachedStatusText = '';
    }
    const cfgCharRaw = (best && typeof this.readPetConfig === 'function')
      ? String(this.readPetConfig()?.Character || 'claude').toLowerCase()
      : 'claude';
    const charKey = (cfgCharRaw === 'dragon' || cfgCharRaw === 'gemini') ? cfgCharRaw : 'claude';
    const charChanged = !!best && (this.lastCharKey !== undefined && this.lastCharKey !== charKey);

    // Heartbeat every 10s while active (safe with 35s watchdog, reduces disk writes by 60%)
    const shouldHeartbeat = best && (nowMs - (this._lastHeartbeat || 0) >= 10000);

    if (key !== this.lastStateKey || shouldHeartbeat || charChanged) {
      const isNewKey = key !== this.lastStateKey;
      const prevSource = this.lastSource;
      this.lastStateKey = key;
      this.lastSource = best?.source || null;
      this.lastCharKey = charKey;
      this._lastHeartbeat = nowMs;

      const stateText = best?.state ? pickStatusText(best.state, charKey) : null;
      this.onChange({
        type: 'work_status',
        source: best?.source || null,
        rawId: best?.rawId || best?.sessionId || null,
        state: best?.state || null,
        stateText: stateText,
        task: best?.task || null,
        taskDetail: best?.taskDetail ?? null,
        at: nowMs,
        agents: allAgents,
        activeCount: activeCount
      });
      if (isNewKey && ((best?.source === 'Codex' && best?.state === 'success') || (prevSource === 'Codex' && !best))) {
        this.pollQuota(false);
      }
    }
  }

  selectBest(current, candidate, now) {
    if (!current) return candidate;
    if (!candidate) return current;

    // 1. Waiting state (user approval/options needed) always has highest urgency
    const isWait = s => s === 'waiting' || s === 'approval';
    if (isWait(candidate.state) && !isWait(current.state)) return candidate;
    if (isWait(current.state) && !isWait(candidate.state)) return current;

    // 2. Active states (working, thinking) beat transient/finished states (success, result)
    const isActiveState = s => s === 'working' || s === 'thinking' || s === 'stalled';
    const candActive = isActiveState(candidate.state);
    const currActive = isActiveState(current.state);
    if (candActive && !currActive) return candidate;
    if (currActive && !candActive) return current;

    // 3. Freshness check: if one agent had activity > 3 seconds more recently, it wins
    const timeDiff = candidate.at - current.at;
    if (Math.abs(timeDiff) > 3000) {
      return timeDiff > 0 ? candidate : current;
    }

    // 4. Tie-breaker when both are within 3 seconds of each other: priority hierarchy
    const prio = { waiting: 7, approval: 7, error: 6, stalled: 5, working: 4, thinking: 3, result: 2, success: 1 };
    const p1 = prio[current.state] || 0;
    const p2 = prio[candidate.state] || 0;
    if (p2 > p1) return candidate;
    if (p2 < p1) return current;

    return candidate.at > current.at ? candidate : current;
  }

  checkAntigravity(now) {
    const tx = this.checkAntigravityTranscript(now) || null;
    const db = this.checkAntigravityDb(now) || null;
    const txIdx = Number.isFinite(tx?.stepIdx) ? tx.stepIdx : -1;
    const dbIdx = Number.isFinite(db?.stepIdx) ? db.stepIdx : -1;
    const normDbId = String(db?.rawId || '').replace(/\.db$/i, '');
    const normTxId = String(tx?.rawId || '').replace(/\.db$/i, '');
    const sameConversation = Boolean(normDbId && normTxId && normDbId === normTxId);
    if (tx && (tx.state === 'waiting' || tx.state === 'approval')) return tx;
    if (db && (db.state === 'waiting' || db.state === 'approval')) return db;
    if (tx && tx.inFlight && !db) return tx;
    if (tx && tx.inFlight && sameConversation && txIdx >= dbIdx - 1) return tx;
    if (sameConversation) return db || tx;
    return this.selectBest(db, tx, now);
  }

  checkAntigravityDb(now) {
    if (!DatabaseSync) return null;
    const convDir = this.paths.antigravityDb || path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
    if (!fs.existsSync(convDir)) return null;
    let candidates = this.antigravityDbCandidates;
    if (now - this.lastAgDbScan >= 2000 || candidates === null) {
      candidates = [];
      try {
        for (const f of fs.readdirSync(convDir).filter(f => f.endsWith('.db'))) {
          const dbPath = path.join(convDir, f);
          const walPath = dbPath + '-wal';
          let mtime = 0;
          try { mtime = fs.statSync(walPath).mtimeMs; } catch { try { mtime = fs.statSync(dbPath).mtimeMs; } catch {} }
          if (mtime) candidates.push({ file: dbPath, mtime });
        }
      } catch { return null; }
      this.antigravityDbCandidates = candidates;
      this.lastAgDbScan = now;
    }

    const sessions = [];
    for (const candidate of candidates) {
      const cached = this.antigravityDbCache.get(candidate.file);
      const cachedState = cached?.state;
      const ageLimit = cachedState === undefined
        ? WAITING_MAX_AGE_MS
        : (isHeldState(cachedState) ? WAITING_MAX_AGE_MS : ACTIVE_MAX_AGE_MS);
      if (now - candidate.mtime >= ageLimit) continue;
      let rawState = cachedState;
      if (!cached || cached.mtime !== candidate.mtime) {
        rawState = this.checkAntigravityDbSingle(now, candidate.file, candidate.mtime);
        this.antigravityDbCache.set(candidate.file, { mtime: candidate.mtime, state: rawState });
      }
      const state = refreshDynamicState(rawState, now, this.stallEnabled, this.stallMs);
      if (state && isStateFresh(state, now)) {
        const rawId = path.basename(candidate.file);
        sessions.push({ ...state, sessionId: rawId, rawId });
      }
    }
    if (this.antigravityDbCache.size > 64) this.antigravityDbCache.clear();
    if (!sessions.length) return null;
    let best = null;
    for (const session of sessions) best = this.selectBest(best, session, now);
    if (!best) return null;
    best.rawId = best.rawId || best.sessionId;
    best.sessions = sessions.map(s => ({
      sessionId: truncate(s.task || s.sessionId, 36) || s.sessionId,
      rawId: s.sessionId,
      state: s.state,
      task: s.task,
      at: s.at
    }));
    best.sessionCount = sessions.length;
    return best;
  }

  checkAntigravityDbSingle(now, forcedDb = null, forcedMtime = 0) {
    if (!DatabaseSync) return null;
    const convDir = this.paths.antigravityDb || path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
    if (!forcedDb && !fs.existsSync(convDir)) return null;

    let latestDb = forcedDb;
    let latestMtime = forcedMtime;

    if (!forcedDb) try {
      const files = fs.readdirSync(convDir).filter(f => f.endsWith('.db'));
      for (const f of files) {
        const dbPath = path.join(convDir, f);
        const walPath = dbPath + '-wal';
        let mtime = 0;
        try {
          mtime = fs.statSync(walPath).mtimeMs;
        } catch {
          try { mtime = fs.statSync(dbPath).mtimeMs; } catch {}
        }
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latestDb = dbPath;
        }
      }
    } catch {
      return null;
    }

    if (!latestDb || (now - latestMtime > WAITING_MAX_AGE_MS)) return null;

    let db = null;
    try {
      db = new DatabaseSync(latestDb, { readOnly: true });
      const row = db.prepare('SELECT idx, step_type, status, metadata FROM steps ORDER BY idx DESC LIMIT 1').get();
      if (!row) return null;

      const p = parseAntigravityStep(row);

      const terminal = new Set([3, 5, 6, 7]);
      const inFlight = !terminal.has(Number(row.status));
      if (row.step_type === 132) {
        const baseTask = cleanSummary(p.toolSummary || p.toolName || '正在执行工具');
        const nextTask = p.toolSummary ? `推进中 (${p.toolSummary})` : '正在分析结果并构思下一步…';
        const stepDetail = p.toolDetail || null;
        if (inFlight) return { source: 'Antigravity', state: 'working', task: baseTask, baseTask, taskDetail: stepDetail, at: latestMtime, startedAt: latestMtime, stepIdx: row.idx, inFlight: true };
        if (now - latestMtime < TERMINAL_HOLD_MS) {
          return {
            source: 'Antigravity',
            state: 'result',
            task: p.toolSummary ? `已完成: ${p.toolSummary}` : '步骤执行完毕',
            taskDetail: stepDetail,
            nextState: { state: 'thinking', task: nextTask, taskDetail: p.toolSummary ? stepDetail : null },
            at: latestMtime,
            stepIdx: row.idx,
            inFlight: false
          };
        }
        return { source: 'Antigravity', state: 'thinking', task: nextTask, taskDetail: p.toolSummary ? stepDetail : null, at: latestMtime, stepIdx: row.idx, inFlight: false };
      }
      if (row.step_type === 15) {
        if (inFlight) return { source: 'Antigravity', state: 'thinking', task: '正在深度思考与规划…', baseTask: '正在深度思考与规划…', taskDetail: null, at: latestMtime, startedAt: latestMtime, stepIdx: row.idx, inFlight: true };
        if (now - latestMtime < TERMINAL_HOLD_MS) return { source: 'Antigravity', state: 'success', task: '回答生成完成', taskDetail: null, at: latestMtime, stepIdx: row.idx, inFlight: false };
        return null;
      }

      return null;
    } catch (err) {
      if (!this.isProbe) this.logDbIssue(latestDb, err);
      return null;
    } finally {
      if (db) { try { db.close(); } catch {} }
    }
  }

  logDbIssue(dbPath, err) {
    const now = Date.now();
    if (!this._lastDbLogAt || now - this._lastDbLogAt >= 60000) {
      this._lastDbLogAt = now;
      writeErrorLog(`Antigravity DB read failed: ${path.basename(dbPath)} - ${err?.message || err}`);
    }
  }

  checkAntigravityTranscript(now) {
    if (!fs.existsSync(this.paths.antigravity)) return null;
    let candidates = this.antigravityTranscriptCandidates;
    if (now - this.lastAgTranscriptScan >= 2000 || candidates === null) {
      candidates = [];
      try {
        for (const conv of fs.readdirSync(this.paths.antigravity)) {
          const tf = path.join(this.paths.antigravity, conv, '.system_generated', 'logs', 'transcript.jsonl');
          try {
            const st = fs.statSync(tf);
            candidates.push({ file: tf, mtime: st.mtimeMs });
          } catch {}
        }
      } catch { return null; }
      this.antigravityTranscriptCandidates = candidates;
      this.lastAgTranscriptScan = now;
    }

    const sessions = [];
    for (const candidate of candidates) {
      const cached = this.antigravityTranscriptCache.get(candidate.file);
      const cachedState = cached?.state;
      const ageLimit = cachedState === undefined
        ? WAITING_MAX_AGE_MS
        : (isHeldState(cachedState) ? WAITING_MAX_AGE_MS : ACTIVE_MAX_AGE_MS);
      if (now - candidate.mtime >= ageLimit) continue;
      let rawState = cachedState;
      if (!cached || cached.mtime !== candidate.mtime) {
        rawState = this.checkAntigravityTranscriptSingle(now, candidate.file, candidate.mtime);
        this.antigravityTranscriptCache.set(candidate.file, { mtime: candidate.mtime, state: rawState });
      }
      const state = refreshDynamicState(rawState, now, this.stallEnabled, this.stallMs);
      if (state && isStateFresh(state, now)) sessions.push({
        ...state,
        sessionId: path.basename(path.dirname(path.dirname(path.dirname(candidate.file)))),
        rawId: path.basename(path.dirname(path.dirname(path.dirname(candidate.file))))
      });
    }
    if (this.antigravityTranscriptCache.size > 128) this.antigravityTranscriptCache.clear();
    if (!sessions.length) return null;
    let best = null;
    for (const session of sessions) best = this.selectBest(best, session, now);
    if (!best) return null;
    best.rawId = best.rawId || best.sessionId;
    best.sessions = sessions.map(s => ({
      sessionId: truncate(s.task || s.sessionId, 36) || s.sessionId,
      rawId: s.sessionId,
      state: s.state,
      task: s.task,
      at: s.at
    }));
    best.sessionCount = sessions.length;
    return best;
  }

  checkAntigravityTranscriptSingle(now, forcedFile = null, forcedMtime = 0) {
    if (!fs.existsSync(this.paths.antigravity)) return null;
    try {
      const convs = fs.readdirSync(this.paths.antigravity);
      let latestFile = forcedFile;
      let latestMtime = forcedMtime;
      if (!forcedFile) for (const conv of convs) {
        const tf = path.join(this.paths.antigravity, conv, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          const st = fs.statSync(tf);
          if (st.mtimeMs > latestMtime && now - st.mtimeMs < WAITING_MAX_AGE_MS) {
            latestMtime = st.mtimeMs;
            latestFile = tf;
          }
        } catch {}
      }
      if (!latestFile) {
        this.cachedAg = { file: null, mtime: 0, state: null };
        return null;
      }

      // Fast mtime cache with freshness check
      if (this.cachedAg.file === latestFile && this.cachedAg.mtime === latestMtime) {
        return refreshDynamicState(this.cachedAg.state, now, this.stallEnabled, this.stallMs);
      }

      const lines = this.readTailLines(latestFile, 65536);
      let res = null;
      const closedCallIds = new Set();
      let seenLaterStep = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        const type = entry.type;
        const status = entry.status;
        const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];

        if (entry.call_id) closedCallIds.add(entry.call_id);
        if (entry.tool_call_id) closedCallIds.add(entry.tool_call_id);
        if (Array.isArray(entry.tool_responses)) {
          for (const tr of entry.tool_responses) {
            if (tr?.call_id) closedCallIds.add(tr.call_id);
            if (tr?.id) closedCallIds.add(tr.id);
          }
        }

        if (type === 'USER_INPUT' || type === 'SYSTEM_MESSAGE') {
          res = {
            source: 'Antigravity',
            state: 'thinking',
            task: truncate(entry.content || '正在思考梳理…'),
            taskDetail: type === 'USER_INPUT' ? finalizeTaskDetail(entry.content) : null,
            at: latestMtime
          };
          break;
        }

        if (type === 'PLANNER_RESPONSE') {
          if (toolCalls.length > 0) {
            const openToolCalls = seenLaterStep ? [] : toolCalls.filter(tc => {
              const id = tc?.id || tc?.call_id || tc?.tool_call_id;
              if (id && closedCallIds.has(id)) return false;
              const tcStatus = String(tc?.status || '').toUpperCase();
              if (tcStatus === 'COMPLETED' || tcStatus === 'DONE' || tcStatus === 'ERROR' || tc?.output !== undefined || tc?.result !== undefined) return false;
              return true;
            });
            for (const tc of toolCalls) {
              const id = tc?.id || tc?.call_id || tc?.tool_call_id;
              if (id) closedCallIds.add(id);
            }
            if (openToolCalls.length > 0) {
              const askTool = openToolCalls.find(tc => tc.name === 'ask_question' || tc.name === 'ask_user');
              if (askTool) {
                res = {
                  source: 'Antigravity',
                  state: 'waiting',
                  task: '需要主人确认指示或选项',
                  baseTask: '需要主人确认指示或选项',
                  taskDetail: extractTranscriptToolDetail(askTool),
                  at: latestMtime,
                  startedAt: latestMtime,
                  stepIdx: entry.step_index ?? -1,
                  inFlight: true
                };
                break;
              }
              const firstTool = openToolCalls[0];
              const summary = cleanSummary(firstTool.args?.toolSummary || firstTool.toolSummary || firstTool.name || '正在执行工具');
              res = {
                source: 'Antigravity',
                state: 'working',
                task: summary,
                baseTask: summary,
                taskDetail: extractTranscriptToolDetail(firstTool),
                at: latestMtime,
                startedAt: latestMtime,
                stepIdx: entry.step_index ?? -1,
                inFlight: true
              };
              break;
            }
          }

          if (status === 'DONE') {
            if (now - latestMtime < TERMINAL_HOLD_MS) {
              res = {
                source: 'Antigravity',
                state: 'success',
                task: '回答生成完成',
                taskDetail: null,
                at: latestMtime
              };
            }
            break;
          }
          res = {
            source: 'Antigravity',
            state: 'thinking',
            task: truncate(entry.content || '正在构思回复…'),
            taskDetail: finalizeTaskDetail(entry.content),
            at: latestMtime
          };
          break;
        }

        if (type === 'ERROR_MESSAGE') {
          if (now - latestMtime < TERMINAL_HOLD_MS) {
            res = {
              source: 'Antigravity',
              state: 'error',
              task: truncate(entry.content || '执行遇到了问题'),
              taskDetail: finalizeTaskDetail(entry.content),
              at: latestMtime
            };
          }
          break;
        }

        if (type === 'GENERIC') {
          const nextTask = '正在分析执行结果并构思下一步…';
          if (now - latestMtime < TERMINAL_HOLD_MS) {
            for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
              try {
                const prev = JSON.parse(lines[j]);
                if (prev.type === 'PLANNER_RESPONSE' && prev.tool_calls?.length > 0) {
                  const s = cleanSummary(prev.tool_calls[0].args?.toolSummary || prev.tool_calls[0].toolSummary || prev.tool_calls[0].name);
                  res = {
                    source: 'Antigravity',
                    state: 'result',
                    task: s ? `已完成: ${s}` : '步骤执行完毕，继续下一步',
                    taskDetail: extractTranscriptToolDetail(prev.tool_calls[0]),
                    nextState: { state: 'thinking', task: nextTask, taskDetail: null },
                    at: latestMtime
                  };
                  break;
                }
              } catch {}
            }
            if (!res) {
              res = {
                source: 'Antigravity',
                state: 'result',
                task: '正在整理工具返回结果…',
                taskDetail: null,
                nextState: { state: 'thinking', task: nextTask, taskDetail: null },
                at: latestMtime
              };
            }
          } else {
            res = {
              source: 'Antigravity',
              state: 'thinking',
              task: nextTask,
              taskDetail: null,
              at: latestMtime
            };
          }
          break;
        }

        seenLaterStep = true;
      }
      this.cachedAg = { file: latestFile, mtime: latestMtime, state: res };
      return refreshDynamicState(res, now, this.stallEnabled, this.stallMs);
    } catch {}
    return null;
  }

  checkDsh(now) {
    const dshDirs = this.paths.dshDirs || resolveDshDirs();
    if (now - this.lastDshSessionScan >= 2000 || this.dshSessionCandidates === null) {
      this.lastDshSessionScan = now;
      const candidates = [];
      for (const dshDir of dshDirs) {
        try {
          const files = fs.readdirSync(dshDir).filter(f => f.startsWith('session-') && f.endsWith('.json'));
          for (const file of files) {
            const fp = path.join(dshDir, file);
            try {
              const st = fs.statSync(fp);
              candidates.push({ file: fp, mtime: st.mtimeMs });
            } catch {}
          }
        } catch {}
      }
      this.dshSessionCandidates = candidates;
    }

    const sessions = [];
    for (const candidate of this.dshSessionCandidates) {
      const cached = this.dshStateCache.get(candidate.file);
      const cachedState = cached?.state;
      const ageLimit = cachedState === undefined
        ? WAITING_MAX_AGE_MS
        : (isHeldState(cachedState) ? WAITING_MAX_AGE_MS : ACTIVE_MAX_AGE_MS);
      if (now - candidate.mtime >= ageLimit) continue;
      let rawState = cachedState;
      if (!cached || cached.mtime !== candidate.mtime) {
        rawState = this.checkDshSingle(now, candidate.file, candidate.mtime);
        this.dshStateCache.set(candidate.file, { mtime: candidate.mtime, state: rawState });
      }
      const state = refreshDynamicState(rawState, now, this.stallEnabled, this.stallMs);
      if (state && isStateFresh(state, now)) {
        const rawId = path.basename(candidate.file);
        sessions.push({ ...state, sessionId: rawId, rawId });
      }
    }
    if (this.dshStateCache.size > 128) this.dshStateCache.clear();
    if (!sessions.length) return null;
    let best = null;
    for (const session of sessions) best = this.selectBest(best, session, now);
    if (!best) return null;
    best.rawId = best.rawId || best.sessionId;
    best.sessions = sessions.map(s => ({
      sessionId: truncate(s.task || s.sessionId, 36) || s.sessionId,
      rawId: s.sessionId,
      state: s.state,
      task: s.task,
      at: s.at
    }));
    best.sessionCount = sessions.length;
    return best;
  }

  checkDshSingle(now, forcedFile = null, forcedMtime = 0) {
    const dshDirs = this.paths.dshDirs || resolveDshDirs();
    let latestFile = forcedFile;
    let latestMtime = forcedMtime;

    // P2-3: Low-frequency directory iteration (every 2000ms), fast single stat check in-between
    if (!forcedFile && this.dshLatestFile && (now - this.lastDshScanTime < 2000)) {
      try {
        const st = fs.statSync(this.dshLatestFile);
        if (now - st.mtimeMs < WAITING_MAX_AGE_MS) {
          latestFile = this.dshLatestFile;
          latestMtime = st.mtimeMs;
        }
      } catch {
        this.dshLatestFile = null;
      }
    }

    if (!forcedFile && !latestFile) {
      this.lastDshScanTime = now;
      for (const dshDir of dshDirs) {
        try {
          const files = fs.readdirSync(dshDir).filter(f => f.startsWith('session-') && f.endsWith('.json'));
          for (const file of files) {
            const fp = path.join(dshDir, file);
            try {
              const st = fs.statSync(fp);
              if (st.mtimeMs > latestMtime && now - st.mtimeMs < WAITING_MAX_AGE_MS) {
                latestMtime = st.mtimeMs;
                latestFile = fp;
              }
            } catch {}
          }
        } catch {}
      }
      this.dshLatestFile = latestFile;
    }

    if (!latestFile) {
      this.cachedDsh = { file: null, mtime: 0, state: null };
      return null;
    }

    // Fast mtime cache with freshness check (Diagnostics Fix 1)
    if (!forcedFile && this.cachedDsh.file === latestFile && this.cachedDsh.mtime === latestMtime) {
      return refreshDynamicState(this.cachedDsh.state, now, this.stallEnabled, this.stallMs);
    }

    try {
      const data = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
      const rows = data.record?.rows || {};

      const turnBoundary = rows.turnBoundary?.val;
      const sessionStats = rows.sessionStats?.val;
      const userQuestions = rows.userQuestions?.val;
      const todos = rows.todos?.val;
      const pendingCalls = sessionStats?.pendingCalls || rows.pendingCalls?.val;

      const rawTitle = String(rows.title?.val || '').trim();
      let defaultTask = truncate(rawTitle);
      let rawTurnPrompt = '';
      const turns = rows.turnOutline?.val?.turns;
      if (Array.isArray(turns) && turns.length > 0) {
        rawTurnPrompt = String(turns[turns.length - 1].prompt || '').trim();
        if (!defaultTask) defaultTask = truncate(rawTurnPrompt);
      }

      let rawTodo = '';
      let todoTask = null;
      if (Array.isArray(todos)) {
        let curr = todos.find(t => t?.status === 'in_progress') || todos.find(t => t?.status === 'pending');
        const content = String(curr?.content || '').trim();
        if (content) {
          rawTodo = content;
          todoTask = truncate(content);
        }
      }
      const finalTask = todoTask || defaultTask || '执行会话任务中…';
      const buildDshContextDetail = (extraLines = []) => {
        const merged = [];
        for (const item of [...extraLines, rawTodo, rawTitle, rawTurnPrompt]) {
          const text = String(item || '').trim();
          if (text && !merged.includes(text)) merged.push(text);
        }
        return finalizeTaskDetail(merged.join('\n'));
      };

      const hasQuestions = userQuestions?.questions?.active?.length > 0;
      if (hasQuestions) {
        const qTexts = userQuestions.questions.active
          .map(q => formatDetailFieldValue(q?.question || q?.prompt || q?.text || q?.title || q?.header))
          .filter(Boolean);
        const res = {
          source: 'DSH',
          state: 'waiting',
          task: finalTask || '等待主人答复选择题',
          taskDetail: buildDshContextDetail(qTexts),
          at: latestMtime
        };
        this.cachedDsh = { file: latestFile, mtime: latestMtime, state: res };
        return res;
      }

      // Check pendingCalls (Issue 2: filter out raw call_ IDs)
      let hasPending = false;
      let toolName = null;
      let firstPendingCall = null;
      if (Array.isArray(pendingCalls) && pendingCalls.length > 0) {
        hasPending = true;
        firstPendingCall = pendingCalls[0];
        toolName = firstPendingCall?.name || firstPendingCall?.toolName;
      } else if (pendingCalls && typeof pendingCalls === 'object') {
        const keys = Object.keys(pendingCalls);
        if (keys.length > 0) {
          hasPending = true;
          const val = pendingCalls[keys[0]];
          if (val && typeof val === 'object') {
            firstPendingCall = val;
            toolName = val.name || val.toolName;
          }
        }
      }
      if (hasPending) {
        const validToolName = (toolName && !/^call_/i.test(toolName)) ? cleanSummary(toolName) : null;
        const cleanRawToolName = (toolName && !/^call_/i.test(String(toolName).trim())) ? String(toolName).trim() : '';
        const callObj = (firstPendingCall && typeof firstPendingCall === 'object') ? firstPendingCall : {};
        const callArgs = tryParseJsonObject(callObj.args) || tryParseJsonObject(callObj.arguments) || tryParseJsonObject(callObj.input) || callObj;
        const targetFields = [
          formatDetailFieldValue(callArgs.command || callArgs.cmd),
          formatDetailFieldValue(callArgs.path || callArgs.file || callArgs.file_path || callArgs.targetFile),
          formatDetailFieldValue(callArgs.query)
        ].filter(Boolean);
        const callLines = [];
        if (cleanRawToolName && targetFields.length > 0) {
          callLines.push(`${cleanRawToolName}: ${targetFields[0]}`);
          for (let ti = 1; ti < targetFields.length; ti++) callLines.push(targetFields[ti]);
        } else if (targetFields.length > 0) {
          callLines.push(...targetFields);
        } else if (cleanRawToolName) {
          callLines.push(cleanRawToolName);
        }
        const values = Array.isArray(pendingCalls) ? pendingCalls : Object.values(pendingCalls || {});
        const stamps = values.map(v => Number(v && typeof v === 'object' ? (v.at || v.startTime || v.time) : v)).filter(Number.isFinite);
        const startedAt = stamps.length ? Math.max(...stamps) : latestMtime;
        const ageMs = now - startedAt;
        const stalled = this.stallEnabled && ageMs >= this.stallMs && ageMs < 300000;
        const ageSeconds = Math.floor(ageMs / 5000) * 5;
        const baseTask = validToolName || finalTask || '正在执行工具…';
        const res = {
          source: 'DSH',
          state: stalled ? 'stalled' : 'working',
          task: stalled ? `好像卡住了：${baseTask} 已发起 ${ageSeconds} 秒无响应` : baseTask,
          baseTask,
          taskDetail: buildDshContextDetail(callLines),
          at: latestMtime,
          startedAt,
          inFlight: true
        };
        this.cachedDsh = { file: latestFile, mtime: latestMtime, state: res };
        return res;
      }

      if (turnBoundary?.openTurnStartSeq != null) {
        if (sessionStats?.openStep) {
          const isGenerating = Boolean(sessionStats.openStep.firstTokenTime);
          const res = {
            source: 'DSH',
            state: isGenerating ? 'working' : 'thinking',
            task: finalTask || (isGenerating ? '正在生成回复…' : '正在思考梳理…'),
            taskDetail: buildDshContextDetail(),
            at: latestMtime
          };
          this.cachedDsh = { file: latestFile, mtime: latestMtime, state: res };
          return res;
        }
        const res = {
          source: 'DSH',
          state: 'thinking',
          task: finalTask || '正在整理思路…',
          taskDetail: buildDshContextDetail(),
          at: latestMtime
        };
        this.cachedDsh = { file: latestFile, mtime: latestMtime, state: res };
        return res;
      }

      if (turnBoundary?.lastStepBoundary?.kind === 'end') {
        if (now - latestMtime < TERMINAL_HOLD_MS) {
          const res = {
            source: 'DSH',
            state: 'success',
            task: finalTask || '会话已执行完成',
            taskDetail: buildDshContextDetail(),
            at: latestMtime
          };
          this.cachedDsh = { file: latestFile, mtime: latestMtime, state: res };
          return res;
        }
        this.cachedDsh = { file: latestFile, mtime: latestMtime, state: null };
        return null;
      }

      // If no active questions, calls, open turns, or recent end, session is idle
      this.cachedDsh = { file: latestFile, mtime: latestMtime, state: null };
      return null;
    } catch {}
    return null;
  }

  extractLastEventTimestamp(filePath, fileSize) {
    let fd = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const readLen = Math.min(16384, fileSize || 16384);
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, Math.max(0, (fileSize || readLen) - readLen));
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(lines[i]);
          if (j.timestamp) {
            const t = Date.parse(j.timestamp);
            if (!isNaN(t) && t > 0) return t;
          }
        } catch {}
      }
    } catch {} finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }
    return 0;
  }

  // AP02: 按原始提问时间实际删除已达 5 分钟上限的待答记录（边界：达到 300 秒即过期）
  pruneCodexPending(pending, now) {
    if (!pending || !Number.isFinite(now)) return;
    for (const [callId, p] of pending) {
      if (now - p.at >= WAITING_MAX_AGE_MS) pending.delete(callId);
    }
  }

  codexPendingState(pending, now) {
    if (!pending) return null;
    this.pruneCodexPending(pending, now);
    const latest = [...pending.values()].filter(p => p.accepted).sort((a, b) => b.at - a.at)[0];
    if (!latest) return null;
    return {
      source: 'Codex', state: latest.kind === 'approval' ? 'approval' : 'waiting',
      task: latest.kind === 'approval' ? '等待主人确认权限' : '等待主人回答问题',
      taskDetail: latest.detail ?? null,
      at: latest.at, startedAt: latest.at, inFlight: true, fromPending: true
    };
  }

  scanCodexAsyncPrompts(file, size, mtime, now = Date.now()) {
    let item = this.codexAsyncCache.get(file);
    if (!item) {
      item = { offset: 0, remainder: Buffer.alloc(0), pending: new Map() };
      this.codexAsyncCache.set(file, item);
    }
    if (size < item.offset) {
      item.offset = 0;
      item.remainder = Buffer.alloc(0);
      item.pending.clear();
    }

    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      while (item.offset < size) {
        const chunk = Buffer.alloc(Math.min(262144, size - item.offset));
        const count = fs.readSync(fd, chunk, 0, chunk.length, item.offset);
        if (!count) break;
        item.offset += count;
        const data = Buffer.concat([item.remainder, chunk.subarray(0, count)]);
        let lineStart = 0;
        for (let end = data.indexOf(10, lineStart); end >= 0; end = data.indexOf(10, lineStart)) {
          const lineBytes = data.subarray(lineStart, end);
          lineStart = end + 1;
          if (!lineBytes.includes('request_user_input_async') &&
              !lineBytes.includes('request_permissions') &&
              !lineBytes.includes('require_escalated') &&
              !lineBytes.includes('send_user_message_question_reply') &&
              ![...item.pending.keys()].some(id => lineBytes.includes(id))) continue;
          let entry;
          try { entry = JSON.parse(lineBytes.toString('utf8')); } catch { continue; }
          if (entry.type !== 'response_item') continue;
          const payload = entry.payload || {};
          if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
            const name = String(payload.name || payload.tool || '').split('.').pop();
            if (name === 'request_user_input_async' && payload.call_id) {
              let questionCount = 1;
              let detail = null;
              try {
                const args = typeof payload.arguments === 'string'
                  ? JSON.parse(payload.arguments) : payload.arguments;
                questionCount = Math.max(1, args?.questions?.length || 1);
                detail = extractCodexToolDetail({ name, arguments: args });
              } catch {}
              item.pending.set(payload.call_id, {
                at: Date.parse(entry.timestamp) || mtime, accepted: false,
                kind: 'question', questionCount, answered: [], detail
              });
            } else if (payload.call_id && (name === 'request_permissions' ||
                       (name === 'exec' && (/\btools\.request_permissions\s*\(/.test(String(payload.input || '')) ||
                        /\btools\.exec_command\s*\([\s\S]*?\bsandbox_permissions\s*:\s*["']require_escalated["']/.test(String(payload.input || '')))))) {
              item.pending.set(payload.call_id, {
                at: Date.parse(entry.timestamp) || mtime, accepted: true,
                kind: 'approval', questionCount: 1, answered: [],
                detail: extractCodexToolDetail(payload)
              });
            }
          } else if ((payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') &&
                     item.pending.has(payload.call_id)) {
            if (item.pending.get(payload.call_id).kind === 'approval') {
              item.pending.delete(payload.call_id);
              continue;
            }
            let output;
            try { output = typeof payload.output === 'string' ? JSON.parse(payload.output) : payload.output; } catch {}
            if (output?.accepted === true) item.pending.get(payload.call_id).accepted = true;
            else item.pending.delete(payload.call_id);
          } else if (payload.type === 'message' && payload.role === 'user') {
            const body = Array.isArray(payload.content)
              ? payload.content.map(c => c?.text || '').join('') : String(payload.content || '');
            const match = body.match(/<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/);
            if (!match) continue;
            try {
              for (const reply of JSON.parse(match[1])) {
                const questionId = typeof reply.questionItemId === 'string'
                  ? JSON.parse(reply.questionItemId) : reply.questionItemId;
                if (Array.isArray(questionId) && questionId[0] === 'request_user_input_async') {
                  const prompt = item.pending.get(questionId[1]);
                  if (prompt) {
                    const index = Number(questionId[2]);
                    if (Number.isInteger(index) && index >= 0 && index < prompt.questionCount &&
                        !prompt.answered.includes(index)) prompt.answered.push(index);
                    if (prompt.answered.length >= prompt.questionCount) item.pending.delete(questionId[1]);
                  }
                }
              }
            } catch {}
          }
        }
        item.remainder = data.subarray(lineStart);
      }
    } catch {} finally {
      if (fd !== null) try { fs.closeSync(fd); } catch {}
    }
    return this.codexPendingState(item.pending, now);
  }

  // AP06: 最终候选窗口保留显式传入的较大窗口（如离线额度回退的七天），
  // 未知 / 等待 / 在飞候选仍至少保留现有 300 秒规则；普通工作扫描仍为 180 秒。
  codexCandidateWindow(c, maxAgeMs) {
    const cachedState = this.codexStateCache.get(c.file)?.state;
    const stateWindow = (cachedState === undefined || isHeldState(cachedState))
      ? WAITING_MAX_AGE_MS
      : 0;
    return Math.max(maxAgeMs, stateWindow);
  }

  findCodexRollouts(now, maxAgeMs = ACTIVE_MAX_AGE_MS) {
    const sessionsDir = path.join(this.paths.codex, 'sessions');
    if (!fs.existsSync(sessionsDir)) return [];

    // Scan every rollout candidate. A session can keep receiving events while
    // its filename and filesystem mtime remain older than newer sessions.
    // Limiting this to the newest N filenames loses such active sessions.
    if (this.codexRolloutCandidates.length > 0 && (now - this.lastCodexRolloutScan) < 5000) {
      const refreshed = [];
      for (const c of this.codexRolloutCandidates) {
        // Do not stat stale historical rollouts on every 500ms tick. The
        // periodic full walk still re-reads their tail timestamps, so an old
        // session that becomes active again is rediscovered within the scan
        // interval without paying the idle cost on every candidate.
        const cachedState = this.codexStateCache.get(c.file)?.state;
        const ageLimit = cachedState === undefined
          ? WAITING_MAX_AGE_MS
          : (isHeldState(cachedState) ? WAITING_MAX_AGE_MS : ACTIVE_MAX_AGE_MS);
        if (now - c.mtime >= ageLimit) {
          refreshed.push(c);
          continue;
        }
        try {
          const st = fs.statSync(c.file);
          let eventTs = c.eventTs || 0;
          if (st.size !== c.size) eventTs = this.extractLastEventTimestamp(c.file, st.size) || eventTs;
          refreshed.push({ ...c, size: st.size, mtime: Math.max(st.mtimeMs, eventTs), eventTs });
        } catch {}
      }
      refreshed.sort((a, b) => b.mtime - a.mtime);
      this.codexRolloutCandidates = refreshed;
      return refreshed.filter(c => now - c.mtime < this.codexCandidateWindow(c, maxAgeMs));
    }
    this.lastCodexRolloutScan = now;

    const files = [];
    const walk = d => {
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const ent of entries) {
          const full = path.join(d, ent.name);
          if (ent.isDirectory()) {
            walk(full);
          } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
            try {
              const st = fs.statSync(full);
              files.push({ file: full, name: ent.name, mtime: st.mtimeMs, size: st.size });
            } catch {}
          }
        }
      } catch {}
    };
    walk(sessionsDir);

    if (files.length === 0) {
      this.codexRolloutCandidates = [];
      return [];
    }

    const candidates = [];
    for (const cand of files) {
      const eventTs = this.extractLastEventTimestamp(cand.file, cand.size);
      const effTime = Math.max(cand.mtime, eventTs || 0);
      candidates.push({ file: cand.file, name: cand.name, mtime: effTime, size: cand.size, eventTs: eventTs || effTime });
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    this.codexRolloutCandidates = candidates;
    const freshCandidates = candidates.filter(c => now - c.mtime < this.codexCandidateWindow(c, maxAgeMs));
    return freshCandidates;
  }

  findLatestCodexRollout(now, maxAgeMs = ACTIVE_MAX_AGE_MS) {
    return this.findCodexRollouts(now, maxAgeMs)[0] || null;
  }

  parseCodexFile(candidate, now) {
    const { file: latestFile, mtime: latestMtime, size: latestSize } = candidate;
    const cached = this.codexStateCache.get(latestFile);
    if (cached && cached.mtime === latestMtime && cached.size === latestSize) {
      if (!cached.state?.fromPending) {
        return refreshDynamicState(cached.state, now, this.stallEnabled, this.stallMs);
      }
      // AP02: 缓存的是待答状态时，按本轮时间重新评估；仍有有效待答项则继续等待，
      // 全部过期后不直接返回空，而是落入下方普通日志解析（文件未变化也要生效）。
      const stillPending = this.codexPendingState(this.codexAsyncCache.get(latestFile)?.pending, now);
      if (stillPending) {
        this.codexStateCache.set(latestFile, { mtime: latestMtime, size: latestSize, state: stillPending });
        return stillPending;
      }
    }

    try {
      const pendingQuestion = this.scanCodexAsyncPrompts(latestFile, latestSize, latestMtime, now);
      if (pendingQuestion) {
        this.codexStateCache.set(latestFile, { mtime: latestMtime, size: latestSize, state: pendingQuestion });
        return pendingQuestion;
      }
      const lines = this.readTailLines(latestFile, 131072);
      let res = null;
      const closedCallIds = new Set();

      for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        const type = entry.type;
        const payload = entry.payload || {};

        if (type === 'event_msg') {
          const kind = String(payload.type || '').toLowerCase();
          if (kind === 'task_complete' || kind === 'turn_complete' || kind === 'turn_aborted') {
            if (now - latestMtime < TERMINAL_HOLD_MS) {
              res = {
                source: 'Codex',
                state: 'success',
                task: '任务已完成',
                at: latestMtime
              };
            }
            break;
          }
          if (kind === 'task_started' || kind === 'turn_started') {
            res = {
              source: 'Codex',
              state: 'thinking',
              task: '任务启动中…',
              at: latestMtime
            };
            break;
          }
          if (kind === 'item_started') {
            const item = payload.item || {};
            const iType = String(item.type || '').toLowerCase();
            if (/user.?input|approval|question/.test(iType) || /request_user_input|ask_question/.test(String(item.name || item.tool || ''))) {
              res = { source: 'Codex', state: 'waiting', task: cleanSummary(item.name || item.tool || '等待确认'), taskDetail: extractCodexToolDetail(item), at: latestMtime };
              break;
            }
            if (/tool|command|mcp|function/.test(iType)) {
              const baseTask = cleanSummary(item.name || item.command || item.tool || iType);
              res = { source: 'Codex', state: 'working', task: baseTask, baseTask, taskDetail: extractCodexToolDetail(item), at: latestMtime, startedAt: latestMtime, inFlight: true };
              break;
            }
            if (/reasoning|message/.test(iType)) {
              res = { source: 'Codex', state: 'thinking', task: '正在推敲思路…', taskDetail: null, at: latestMtime };
              break;
            }
          }
          // WO-05 & WO-30: Codex item_completed event with turn continuity & cache nextState
          if (kind === 'item_completed') {
            const item = payload.item || {};
            const iType = String(item.type || '').toLowerCase();
            // AP03: AgentMessage 先按 phase 区分；进度消息（commentary 或缺少 phase）不产生步骤完成提示
            if (iType === 'agentmessage') {
              const phase = String(item.phase ?? '').trim().toLowerCase();
              if (phase === 'final_answer') {
                if (now - latestMtime < TERMINAL_HOLD_MS) {
                  res = { source: 'Codex', state: 'success', task: '回复已生成完毕', taskDetail: null, at: latestMtime };
                }
              } else {
                res = { source: 'Codex', state: 'thinking', task: '正在汇报进度并继续推进…', taskDetail: null, at: latestMtime };
              }
              break;
            }
            const summary = cleanSummary(item.name || item.command || item.tool || iType);
            const nextTask = summary ? `推进中 (${summary})` : '正在分析执行结果并构思下一步…';
            const itemDetail = extractCodexToolDetail(item);
            if (now - latestMtime < TERMINAL_HOLD_MS) {
              res = {
                source: 'Codex',
                state: 'result',
                task: summary ? `已完成: ${summary}` : '步骤执行完毕',
                taskDetail: itemDetail,
                nextState: { state: 'thinking', task: nextTask, taskDetail: summary ? itemDetail : null },
                at: latestMtime
              };
            } else {
              // Tool finished > 8s ago but turn ongoing: model is thinking/generating next step!
              res = {
                source: 'Codex',
                state: 'thinking',
                task: nextTask,
                taskDetail: summary ? itemDetail : null,
                at: latestMtime
              };
            }
            break;
          }
        }

        if (type === 'turn_context') {
          res = {
            source: 'Codex',
            state: 'thinking',
            task: '正在整理上下文…',
            taskDetail: null,
            at: latestMtime
          };
          break;
        }

        if (type === 'response_item') {
          if (payload.type === 'reasoning') {
            res = {
              source: 'Codex',
              state: 'thinking',
              task: '正在深度推理…',
              taskDetail: null,
              at: latestMtime
            };
            break;
          }
          if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
            const callId = payload.call_id;
            if (payload.status === 'completed' || (callId && closedCallIds.has(callId))) {
              if (callId) closedCallIds.add(callId);
              continue;
            }
            const WAIT_TOOLS = new Set(['request_user_input', 'ask_question']);
            const rawName = String(payload.name || payload.tool || '');
            const bare = rawName.includes('.') ? rawName.split('.').pop() : rawName;
            const callDetail = extractCodexToolDetail(payload);
            if (WAIT_TOOLS.has(bare)) {
              const t = cleanSummary(rawName);
              res = { source: 'Codex', state: 'waiting', task: t, baseTask: t, taskDetail: callDetail, at: latestMtime, startedAt: latestMtime, inFlight: true };
              break;
            }
            const baseTask = cleanSummary(payload.name || payload.tool || '正在执行工具…');
            res = { source: 'Codex', state: 'working', task: baseTask, baseTask, taskDetail: callDetail, at: latestMtime, startedAt: latestMtime, inFlight: true };
            break;
          }
          if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
            if (payload.call_id) closedCallIds.add(payload.call_id);
            const nextTask = '正在分析工具返回并构思下一步…';
            if (now - latestMtime < TERMINAL_HOLD_MS) {
              res = {
                source: 'Codex',
                state: 'result',
                task: '工具执行完毕，继续分析…',
                taskDetail: null,
                nextState: { state: 'thinking', task: nextTask, taskDetail: null },
                at: latestMtime
              };
            } else {
              res = {
                source: 'Codex',
                state: 'thinking',
                task: nextTask,
                taskDetail: null,
                at: latestMtime
              };
            }
            break;
          }
          if (payload.type === 'message') {
            let body = '';
            if (typeof payload.content === 'string') body = payload.content;
            else if (Array.isArray(payload.content)) body = payload.content.map(c => typeof c === 'string' ? c : (c && c.text) || '').join('');
            else if (typeof payload.text === 'string') body = payload.text;
            body = body.trimStart();
            if (payload.role === 'assistant' && /^APPROVAL REQUEST\b/i.test(body)) {
              const firstPara = body.split(/\r?\n[ \t]*\r?\n/)[0] || body;
              res = { source: 'Codex', state: 'waiting', task: '等待主人确认执行权限', baseTask: '等待主人确认执行权限', taskDetail: finalizeTaskDetail(firstPara), at: latestMtime, startedAt: latestMtime, inFlight: true };
              break;
            }
            if (payload.role === 'assistant') {
              const msgStatus = String(payload.status ?? '').trim().toLowerCase();
              const msgPhase = String(payload.phase ?? '').trim().toLowerCase();
              if (msgStatus === 'in_progress') {
                res = {
                  source: 'Codex',
                  state: 'working',
                  task: '正在生成回复…',
                  taskDetail: null,
                  at: latestMtime
                };
                break;
              }
              // AP03: 只有明确的最终答复（phase=final_answer 且 status=completed）才算回复完成；
              // commentary 进度消息、缺少或无法确认 phase/status 的消息都按普通活动处理，
              // 回合是否结束交给明确的 task_complete / turn_complete 等结束事件判断。
              if (msgPhase === 'final_answer' && msgStatus === 'completed') {
                if (now - latestMtime < TERMINAL_HOLD_MS) {
                  res = {
                    source: 'Codex',
                    state: 'success',
                    task: '回复已生成完毕',
                    taskDetail: null,
                    at: latestMtime
                  };
                }
                break;
              }
              res = {
                source: 'Codex',
                state: 'thinking',
                task: '正在汇报进度并继续推进…',
                taskDetail: null,
                at: latestMtime
              };
              break;
            }
            if (payload.role === 'user') {
              res = {
                source: 'Codex',
                state: 'thinking',
                task: '接收到用户指令…',
                taskDetail: null,
                at: latestMtime
              };
              break;
            }
          }
        }
      }
      this.codexStateCache.set(latestFile, { mtime: latestMtime, size: latestSize, state: res });
      return refreshDynamicState(res, now, this.stallEnabled, this.stallMs);
    } catch {}
    return null;
  }

  checkCodex(now) {
    // AP02: 已不在候选窗口内的会话也按原始时间清理过期待答记录，避免旧记录滞留内存
    for (const item of this.codexAsyncCache.values()) this.pruneCodexPending(item.pending, now);
    const candidates = this.findCodexRollouts(now, ACTIVE_MAX_AGE_MS);
    if (!candidates.length) return null;

    const sessions = [];
    for (const candidate of candidates) {
      const state = this.parseCodexFile(candidate, now);
      if (state && isStateFresh(state, now)) {
        const rawId = path.basename(candidate.file);
        sessions.push({
          ...state,
          sessionId: rawId,
          rawId
        });
      }
    }
    if (!sessions.length) return null;

    let best = null;
    for (const session of sessions) {
      best = this.selectBest(best, session, now);
    }
    if (!best) return null;

    best.rawId = best.rawId || best.sessionId;
    // Keep the selected session as the primary Codex state while exposing
    // every active Codex session for diagnostics and future UI expansion.
    best.sessions = sessions.map(s => ({
      sessionId: truncate(s.task || s.sessionId, 36) || s.sessionId,
      rawId: s.rawId || s.sessionId,
      state: s.state,
      task: s.task,
      at: s.at
    }));
    best.sessionCount = sessions.length;
    return best;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  // P2-1: Probe branch runs without polluting formal error log or state files
  if (process.argv.includes('--test-scan')) {
    const m = new AgentMonitor({ isProbe: true });
    const now = Date.now();
    console.log('AG:', JSON.stringify(m.checkAntigravity(now)));
    console.log('DSH:', JSON.stringify(m.checkDsh(now)));
    console.log('CODEX:', JSON.stringify(m.checkCodex(now)));
    process.exit(0);
  }

  const parentPidArgIdx = process.argv.indexOf('--parent-pid');
  const parentPid = parentPidArgIdx !== -1 ? parseInt(process.argv[parentPidArgIdx + 1], 10) : null;

  if (!parentPid || isNaN(parentPid) || parentPid <= 0) {
    console.error('请通过 AgentPet 启动');
    process.exit(1);
  }
  const monPidPath = path.join(appDir, 'runtime', 'monitor.pid');

  // P0-1: Single-instance guard with strict path & command line validation
  try {
    if (fs.existsSync(monPidPath)) {
      const rawPid = fs.readFileSync(monPidPath, 'utf8').trim();
      let existingPid = null;
      let existingPath = null;
      let existingBaseDir = null;
      try {
        const obj = JSON.parse(rawPid);
        existingPid = obj.pid;
        existingPath = obj.path;
        existingBaseDir = obj.baseDir;
      } catch {
        existingPid = parseInt(rawPid, 10);
      }
      if (existingPid && existingPid !== process.pid) {
        const myScript = fileURLToPath(import.meta.url);
        // Strict path & commandline check: only exit if old PID is proven to be THIS directory's monitor
        if (isSameProjectMonitor(existingPid, myScript)) {
          writeErrorLog(`Existing verified monitor PID ${existingPid} is already active for this directory. New instance exiting gracefully.`);
          process.exit(0);
        } else {
          writeErrorLog(`Old PID ${existingPid} in monitor.pid does not match this project or is not running. Overwriting with new instance.`);
        }
      }
    }
  } catch {}

  // Record own PID metadata
  try {
    const pidMeta = {
      pid: process.pid,
      parentPid: parentPid,
      path: fileURLToPath(import.meta.url),
      startTime: Date.now(),
      baseDir: appDir
    };
    atomicWriteJson(monPidPath, pidMeta);
  } catch {}

  writeErrorLog(`AgentMonitor daemon initialized successfully (PID ${process.pid}, Parent PID ${parentPid || 'none'}).`);

  const stallArgIdx = process.argv.indexOf('--stall-seconds');
  let stallSeconds = 45;
  if (stallArgIdx !== -1 && process.argv[stallArgIdx + 1] != null) {
    const parsed = parseInt(process.argv[stallArgIdx + 1], 10);
    if (!Number.isNaN(parsed) && parsed >= 0) stallSeconds = parsed;
  }
  const monitor = new AgentMonitor({
    parentPid,
    stallSeconds,
    onChange: data => {
      try {
        dispatchRuntimeWrite(appDir, data);
      } catch (err) {
        writeErrorLog(`onChange write dispatch failed: ${err?.message || err}`);
      }
    }
  });

  monitor.start();

  function safeCleanup() {
    monitor.stop();
    try {
      if (fs.existsSync(monPidPath)) {
        const raw = fs.readFileSync(monPidPath, 'utf8');
        try {
          if (JSON.parse(raw).pid === process.pid) fs.unlinkSync(monPidPath);
        } catch {
          if (raw.trim() === String(process.pid)) fs.unlinkSync(monPidPath);
        }
      }
    } catch {}
  }

  process.on('SIGTERM', () => {
    safeCleanup();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    safeCleanup();
    process.exit(0);
  });
}

export { AgentMonitor, atomicWriteJson, writeJsonWithRetry, flushPendingWrites, dispatchRuntimeWrite, pendingWrites, isStateFresh, refreshDynamicState, isHeldState, finalizeTaskDetail, redactDetailSecrets, DETAIL_MAX_CODE_POINTS, DETAIL_TRUNCATE_SUFFIX };
