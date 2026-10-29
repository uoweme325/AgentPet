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

// dsh-pet 6-tier workStatusTexts mapping (Index 0..5)
const WORK_STATUS_TEXTS = {
  thinking: [
    '正在整理思路，稍等一下喔...',
    '代码逻辑推敲中，红茶还没凉呢~',
    '正在分析上下文与架构关系...',
    '推导边界条件中，马上就好！',
    '梳理思路中，也是略懂一些摔跤技巧的~',
    '沉思推敲中，精彩马上呈现！'
  ],
  working: [
    '大改代码中，荷叶袖口都挽起来啦~',
    '修改文件与构建中，交给我吧！',
    '正在执行终端指令，紧盯日志中...',
    '重构优化中，保证代码干净规范！',
    '正在处理关键流程，绝不敷衍~',
    '忙碌工作中，请主人喝口茶歇歇！'
  ],
  stalled: [
    '好像卡住了，我再等等…',
    '这一步暂时没有回应，我盯着呢…',
    '工具还没回来，先保持安静等待…'
  ],
  waiting: [
    '正在等待主人的确认指示呢~',
    '需要主人来做个决策，等您喔！',
    '停步等待授权，请主人过目！',
    '待命确认中，主人请点头~',
    '等待交互输入中，随时接活！',
    '请主人指示下一步方向~'
  ],
  success: [
    '任务执行完成啦！',
    '构建与测试全部跑通，哼哼~',
    '搞定！没有给主人丢脸吧？',
    '顺利收工，代码干净利落！',
    '大功告成，值得庆祝一番~',
    '顺顺利利，蓝图已经落地啦！'
  ],
  error: [
    '遇到一点小麻烦，让我翻书排查一下...',
    '报错了？别慌，交给我挽起袖子解决！',
    '发现一个顽固异常，正在抓日志！',
    '调试进行中，这点波折难不倒我！',
    '边界条件撞墙了，我这就修补！',
    '正在摔跤式排除异常，马上恢复！'
  ],
  result: [
    '工具调用已返回结果，正在汇总！',
    '步骤执行成功，正在处理下一步...',
    '关键输出已捕获，正在推敲分析~',
    '终端返回完毕，正在组织答复...',
    '验证通过，稍候汇总~',
    '数据已提取，马上给主人呈现！'
  ]
};

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

let _cachedStatusTier = null;
let _cachedStatusText = '';

// WO-03 & Issue ①: Hold quote consistently throughout entire task, only re-pick when state/tier changes
function pickStatusText(tier) {
  if (tier === _cachedStatusTier && _cachedStatusText) {
    return _cachedStatusText;
  }
  _cachedStatusTier = tier;
  const list = WORK_STATUS_TEXTS[tier] || WORK_STATUS_TEXTS.working;
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

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    writeErrorLog(`atomicWriteJson failed for ${path.basename(filePath)}: ${err.message}`);
    try { fs.unlinkSync(tmpPath); } catch {}
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
  if (state.state === 'success' || state.state === 'result' || state.state === 'error') {
    return age < TERMINAL_HOLD_MS;
  }
  if (state.state === 'waiting' || state.state === 'approval' || state.state === 'stalled') {
    return age < 300000;
  }
  return age < ACTIVE_MAX_AGE_MS;
}

function refreshDynamicState(state, now, stallEnabled, stallMs) {
  if (!state) return null;
  if (!state.inFlight) return isStateFresh(state, now) ? state : null;
  if (state.state === 'waiting' || state.state === 'approval') return isStateFresh(state, now) ? state : null;
  const startedAt = Number(state.startedAt || state.at || 0);
  const ageMs = now - startedAt;
  if (ageMs < 0 || ageMs >= 300000) return null;
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

  const sumMatch = metaStr.match(/"toolSummary"\s*:\s*"([^"]+)"/);
  if (sumMatch) {
    toolSummary = sumMatch[1];
  } else {
    const cmdMatch = metaStr.match(/"CommandLine"\s*:\s*"([^"]+)"/);
    if (cmdMatch) {
      toolSummary = cmdMatch[1].slice(0, 45);
    } else {
      const pathMatch = metaStr.match(/"Path"\s*:\s*"([^"]+)"/);
      if (pathMatch) toolSummary = pathMatch[1].split(/[\\/]/).pop();
    }
  }

  return { toolName, toolSummary };
}

class AgentMonitor {
  constructor(options = {}) {
    this.onChange = options.onChange || (() => {});
    this.timer = null;
    this.lastStateKey = '';
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

  invalidateBalance(reason) {
    this.balanceGeneration++;
    this.cachedBalanceData = null;
    this.lastBalanceFetchAttempt = 0;
    this.balanceRetryAfterUntil = 0;
    this.balanceBusy = false;
    this.activeHostSignature = null;
    this.cachedDshPort = null;
    writeErrorLog(`Balance invalidated: ${reason} (new gen: ${this.balanceGeneration})`);
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
    const configSig = `${config.DeepSeekBalanceEnabled}:${config.DshPort || 0}:${config.DshBaseUrl || ''}`;
    if (this.lastConfigSig !== undefined && this.lastConfigSig !== configSig) {
      this.lastConfigSig = configSig;
      this.invalidateBalance('CONFIG_CHANGED');
      this.pollBalance(true);
      return;
    }
    this.lastConfigSig = configSig;
    const now = Date.now();
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

  async pollBalance(force = false) {
    if (this.balanceBusy) return;
    const now = Date.now();
    const config = this.readPetConfig();

    const balanceEnabled = (config.DeepSeekBalanceEnabled !== false);
    if (!balanceEnabled) {
      this.cachedBalanceData = null;
      const data = {
        type: 'balance',
        provider: 'unknown',
        providerFamily: 'deepseek',
        credentialSource: 'dsh',
        status: 'dsh_disabled',
        isAvailable: false,
        currency: 'CNY',
        balances: [],
        hostCounter: null,
        fetchedAt: Date.now(),
        observedAt: null,
        lastAttemptAt: now,
        errorCode: 'BALANCE_DISABLED',
        errorMessage: 'DeepSeek 余额服务未启用（可在菜单中开启）'
      };
      this.onChange(data);
      return;
    }

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

    // 1. Check Google Antigravity
    const ag = this.checkAntigravity(now);
    if (ag && isStateFresh(ag, now)) best = this.selectBest(best, ag, now);

    // 2. Check DeepSeek Harness (DSH)
    const dsh = this.checkDsh(now);
    if (dsh && isStateFresh(dsh, now)) best = this.selectBest(best, dsh, now);

    // 3. Check Codex
    const codex = this.checkCodex(now);
    if (codex && isStateFresh(codex, now)) best = this.selectBest(best, codex, now);

    const allAgents = {
      antigravity: (ag && isStateFresh(ag, now)) ? ag : null,
      dsh: (dsh && isStateFresh(dsh, now)) ? dsh : null,
      codex: (codex && isStateFresh(codex, now)) ? codex : null
    };
    // P2-1: activeCount only counts active working states (working, thinking, waiting, approval)
    const ACTIVE_WORK_STATES = new Set(['working', 'thinking', 'waiting', 'approval', 'stalled']);
    const activeCount = [allAgents.antigravity, allAgents.dsh, allAgents.codex].filter(
      a => Boolean(a && a.state && ACTIVE_WORK_STATES.has(a.state))
    ).length;

    const key = best ? `${best.source}|${best.state}|${best.task || ''}|${activeCount}` : '';
    const nowMs = now;
    if (!best) {
      _cachedStatusTier = null;
      _cachedStatusText = '';
    }
    // Heartbeat every 10s while active (safe with 35s watchdog, reduces disk writes by 60%)
    const shouldHeartbeat = best && (nowMs - (this._lastHeartbeat || 0) >= 10000);

    if (key !== this.lastStateKey || shouldHeartbeat) {
      const isNewKey = key !== this.lastStateKey;
      const prevSource = this.lastStateKey.split('|')[0];
      this.lastStateKey = key;
      this._lastHeartbeat = nowMs;

      const stateText = best?.state ? pickStatusText(best.state) : null;
      this.onChange({
        type: 'work_status',
        source: best?.source || null,
        state: best?.state || null,
        stateText: stateText,
        task: best?.task || null,
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
    return db || tx;
  }

  checkAntigravityDb(now) {
    if (!DatabaseSync) return null;
    const convDir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
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
      const ageLimit = isHeldState(cached?.state) ? WAITING_MAX_AGE_MS : ACTIVE_MAX_AGE_MS;
      if (now - candidate.mtime >= ageLimit) continue;
      const state = cached && cached.mtime === candidate.mtime
        ? refreshDynamicState(cached.state, now, this.stallEnabled, this.stallMs)
        : this.checkAntigravityDbSingle(now, candidate.file, candidate.mtime);
      if (!cached || cached.mtime !== candidate.mtime) this.antigravityDbCache.set(candidate.file, { mtime: candidate.mtime, state });
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
    const convDir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
    if (!fs.existsSync(convDir)) return null;

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
        if (inFlight) return { source: 'Antigravity', state: 'working', task: baseTask, baseTask, at: latestMtime, startedAt: latestMtime, stepIdx: row.idx, inFlight: true };
        if (now - latestMtime < TERMINAL_HOLD_MS) return { source: 'Antigravity', state: 'result', task: p.toolSummary ? `已完成: ${p.toolSummary}` : '步骤执行完毕', at: latestMtime, stepIdx: row.idx, inFlight: false };
        return { source: 'Antigravity', state: 'thinking', task: p.toolSummary ? `推进中 (${p.toolSummary})` : '正在分析结果并构思下一步…', at: latestMtime, stepIdx: row.idx, inFlight: false };
      }
      if (row.step_type === 15) {
        if (inFlight) return { source: 'Antigravity', state: 'thinking', task: '正在深度思考与规划…', baseTask: '正在深度思考与规划…', at: latestMtime, startedAt: latestMtime, stepIdx: row.idx, inFlight: true };
        if (now - latestMtime < TERMINAL_HOLD_MS) return { source: 'Antigravity', state: 'success', task: '回答生成完成', at: latestMtime, stepIdx: row.idx, inFlight: false };
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
      const ageLimit = isHeldState(cached?.state) ? WAITING_MAX_AGE_MS : ACTIVE_MAX_AGE_MS;
      if (now - candidate.mtime >= ageLimit) continue;
      const state = cached && cached.mtime === candidate.mtime
        ? refreshDynamicState(cached.state, now, this.stallEnabled, this.stallMs)
        : this.checkAntigravityTranscriptSingle(now, candidate.file, candidate.mtime);
      if (!cached || cached.mtime !== candidate.mtime) this.antigravityTranscriptCache.set(candidate.file, { mtime: candidate.mtime, state });
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
      for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        const type = entry.type;
        const status = entry.status;
        const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];

        if (type === 'USER_INPUT' || type === 'SYSTEM_MESSAGE') {
          res = {
            source: 'Antigravity',
            state: 'thinking',
            task: truncate(entry.content || '正在思考梳理…'),
            at: latestMtime
          };
          break;
        }

        if (type === 'PLANNER_RESPONSE') {
          if (toolCalls.length > 0) {
            const hasAsk = toolCalls.some(tc => ['ask_question', 'ask_user', 'request_user_input', 'request_confirmation'].includes(String(tc.name || '').toLowerCase()));
            if (hasAsk) {
              res = {
                source: 'Antigravity',
                state: 'waiting',
                task: '需要主人确认指示或选项',
                baseTask: '需要主人确认指示或选项',
                at: latestMtime,
                startedAt: latestMtime,
                stepIdx: entry.step_index ?? -1,
                inFlight: true
              };
              break;
            }
            const firstTool = toolCalls[0];
            const summary = cleanSummary(firstTool.args?.toolSummary || firstTool.toolSummary || firstTool.name || '正在执行工具');
            res = {
              source: 'Antigravity',
              state: 'working',
              task: summary,
              baseTask: summary,
              at: latestMtime,
              startedAt: latestMtime,
              stepIdx: entry.step_index ?? -1,
              inFlight: true
            };
            break;
          }

          if (status === 'DONE') {
            if (now - latestMtime < TERMINAL_HOLD_MS) {
              res = {
                source: 'Antigravity',
                state: 'success',
                task: '回答生成完成',
                at: latestMtime
              };
            }
            break;
          }
          res = {
            source: 'Antigravity',
            state: 'thinking',
            task: truncate(entry.content || '正在构思回复…'),
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
              at: latestMtime
            };
          }
          break;
        }

        if (type === 'GENERIC') {
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
                at: latestMtime
              };
            }
          } else {
            res = {
              source: 'Antigravity',
              state: 'thinking',
              task: '正在分析执行结果并构思下一步…',
              at: latestMtime
            };
          }
          break;
        }
      }
      this.cachedAg = { file: latestFile, mtime: latestMtime, state: res };
      return (res && isStateFresh(res, now)) ? res : null;
    } catch {}
    return null;
  }

  checkDsh(now) {
    const dshDirs = resolveDshDirs();
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
      const ageLimit = isHeldState(cached?.state) ? WAITING_MAX_AGE_MS : ACTIVE_MAX_AGE_MS;
      if (now - candidate.mtime >= ageLimit) continue;
      const state = cached && cached.mtime === candidate.mtime
        ? refreshDynamicState(cached.state, now, this.stallEnabled, this.stallMs)
        : this.checkDshSingle(now, candidate.file, candidate.mtime);
      if (!cached || cached.mtime !== candidate.mtime) this.dshStateCache.set(candidate.file, { mtime: candidate.mtime, state });
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
    const dshDirs = resolveDshDirs();
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

      let defaultTask = truncate(rows.title?.val || '');
      if (!defaultTask) {
        const turns = rows.turnOutline?.val?.turns;
        if (Array.isArray(turns) && turns.length > 0) {
          defaultTask = truncate(turns[turns.length - 1].prompt || '');
        }
      }

      let todoTask = null;
      if (Array.isArray(todos)) {
        let curr = todos.find(t => t?.status === 'in_progress') || todos.find(t => t?.status === 'pending');
        const content = String(curr?.content || '').trim();
        if (content) todoTask = truncate(content);
      }
      const finalTask = todoTask || defaultTask || '执行会话任务中…';

      const hasQuestions = userQuestions?.questions?.active?.length > 0;
      if (hasQuestions) {
        const res = {
          source: 'DSH',
          state: 'waiting',
          task: finalTask || '等待主人答复选择题',
          at: latestMtime
        };
        this.cachedDsh = { file: latestFile, mtime: latestMtime, state: res };
        return res;
      }

      // Check pendingCalls (Issue 2: filter out raw call_ IDs)
      let hasPending = false;
      let toolName = null;
      if (Array.isArray(pendingCalls) && pendingCalls.length > 0) {
        hasPending = true;
        toolName = pendingCalls[0]?.name || pendingCalls[0]?.toolName;
      } else if (pendingCalls && typeof pendingCalls === 'object') {
        const keys = Object.keys(pendingCalls);
        if (keys.length > 0) {
          hasPending = true;
          const val = pendingCalls[keys[0]];
          if (val && typeof val === 'object') {
            toolName = val.name || val.toolName;
          }
        }
      }
      if (hasPending) {
        const validToolName = (toolName && !/^call_/i.test(toolName)) ? cleanSummary(toolName) : null;
        const values = Array.isArray(pendingCalls) ? pendingCalls : Object.values(pendingCalls || {});
        const stamps = values.map(v => Number(v && typeof v === 'object' ? (v.at || v.startTime || v.time) : v)).filter(Number.isFinite);
        const startedAt = stamps.length ? Math.max(...stamps) : latestMtime;
        const ageMs = now - startedAt;
        const stalled = this.stallEnabled && ageMs >= this.stallMs && ageMs < 300000;
        const ageSeconds = Math.floor(ageMs / 5000) * 5;
        const baseTask = validToolName || finalTask || '正在执行工具…';
        const res = { source: 'DSH', state: stalled ? 'stalled' : 'working', task: stalled ? `好像卡住了：${baseTask} 已发起 ${ageSeconds} 秒无响应` : baseTask, baseTask, at: latestMtime, startedAt, inFlight: true };
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
            at: latestMtime
          };
          this.cachedDsh = { file: latestFile, mtime: latestMtime, state: res };
          return res;
        }
        const res = {
          source: 'DSH',
          state: 'thinking',
          task: finalTask || '正在整理思路…',
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
        const ageLimit = isHeldState(cachedState) ? WAITING_MAX_AGE_MS : ACTIVE_MAX_AGE_MS;
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
      return refreshed.filter(c => {
        const state = this.codexStateCache.get(c.file)?.state;
        const limit = isHeldState(state) ? WAITING_MAX_AGE_MS : maxAgeMs;
        return now - c.mtime < limit;
      });
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
    const freshCandidates = candidates.filter(c => {
      const state = this.codexStateCache.get(c.file)?.state;
      const limit = isHeldState(state) ? WAITING_MAX_AGE_MS : maxAgeMs;
      return now - c.mtime < limit;
    });
    return freshCandidates;
  }

  findLatestCodexRollout(now, maxAgeMs = ACTIVE_MAX_AGE_MS) {
    return this.findCodexRollouts(now, maxAgeMs)[0] || null;
  }

  parseCodexFile(candidate, now) {
    const { file: latestFile, mtime: latestMtime, size: latestSize } = candidate;
    const cached = this.codexStateCache.get(latestFile);
    if (cached && cached.mtime === latestMtime && cached.size === latestSize) {
      return refreshDynamicState(cached.state, now, this.stallEnabled, this.stallMs);
    }

    try {
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
              res = { source: 'Codex', state: 'waiting', task: cleanSummary(item.name || item.tool || '等待确认'), at: latestMtime };
              break;
            }
            if (/tool|command|mcp|function/.test(iType)) {
              const baseTask = cleanSummary(item.name || item.command || item.tool || iType);
              res = { source: 'Codex', state: 'working', task: baseTask, baseTask, at: latestMtime, startedAt: latestMtime, inFlight: true };
              break;
            }
            if (/reasoning|message/.test(iType)) {
              res = { source: 'Codex', state: 'thinking', task: '正在推敲思路…', at: latestMtime };
              break;
            }
          }
          // WO-05: Codex item_completed event with turn continuity
          if (kind === 'item_completed') {
            const item = payload.item || {};
            const iType = String(item.type || '').toLowerCase();
            const summary = cleanSummary(item.name || item.command || item.tool || iType);
            if (now - latestMtime < TERMINAL_HOLD_MS) {
              res = {
                source: 'Codex',
                state: 'result',
                task: summary ? `已完成: ${summary}` : '步骤执行完毕',
                at: latestMtime
              };
            } else {
              // Tool finished > 8s ago but turn ongoing: model is thinking/generating next step!
              res = {
                source: 'Codex',
                state: 'thinking',
                task: summary ? `推进中 (${summary})` : '正在分析执行结果并构思下一步…',
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
            const baseTask = cleanSummary(payload.name || payload.tool || '正在执行工具…');
            res = { source: 'Codex', state: 'working', task: baseTask, baseTask, at: latestMtime, startedAt: latestMtime, inFlight: true };
            break;
          }
          if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
            if (payload.call_id) closedCallIds.add(payload.call_id);
            if (now - latestMtime < TERMINAL_HOLD_MS) {
              res = {
                source: 'Codex',
                state: 'result',
                task: '工具执行完毕，继续分析…',
                at: latestMtime
              };
            } else {
              res = {
                source: 'Codex',
                state: 'thinking',
                task: '正在分析工具返回并构思下一步…',
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
              res = { source: 'Codex', state: 'waiting', task: '等待主人确认执行权限', baseTask: '等待主人确认执行权限', at: latestMtime, startedAt: latestMtime, inFlight: true };
              break;
            }
            if (payload.role === 'assistant') {
              if (payload.status === 'in_progress') {
                res = {
                  source: 'Codex',
                  state: 'working',
                  task: '正在生成回复…',
                  at: latestMtime
                };
                break;
              }
              if (now - latestMtime < TERMINAL_HOLD_MS) {
                res = {
                  source: 'Codex',
                  state: 'success',
                  task: '回复已生成完毕',
                  at: latestMtime
                };
              }
              break;
            }
            if (payload.role === 'user') {
              res = {
                source: 'Codex',
                state: 'thinking',
                task: '接收到用户指令…',
                at: latestMtime
              };
              break;
            }
          }
        }
      }
      this.codexStateCache.set(latestFile, { mtime: latestMtime, size: latestSize, state: res });
      return (res && isStateFresh(res, now)) ? res : null;
    } catch {}
    return null;
  }

  checkCodex(now) {
    const candidates = this.findCodexRollouts(now, ACTIVE_MAX_AGE_MS);
    if (!candidates.length) return null;

    const sessions = [];
    for (const candidate of candidates) {
      const state = this.parseCodexFile(candidate, now);
      if (state && isStateFresh(state, now)) {
        sessions.push({
          ...state,
          sessionId: path.basename(candidate.file)
        });
      }
    }
    if (!sessions.length) return null;

    let best = null;
    for (const session of sessions) {
      best = this.selectBest(best, session, now);
    }
    if (!best) return null;

    // Keep the selected session as the primary Codex state while exposing
    // every active Codex session for diagnostics and future UI expansion.
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
        if (data.type === 'quota') {
          atomicWriteJson(path.join(appDir, 'runtime-quota.json'), data);
        } else if (data.type === 'balance') {
          atomicWriteJson(path.join(appDir, 'runtime-balance.json'), data);
        } else {
          atomicWriteJson(path.join(appDir, 'runtime-status.json'), data);
        }
      } catch {}
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

export { AgentMonitor };
