import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
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
const DSH_APPROVAL_TIMEOUT_MS = 30 * 60_000;
const DSH_APPROVAL_FUTURE_TOLERANCE_MS = 2000;
const DSH_ZSTD_TAIL_BYTES = 64 * 1024;
const TERMINAL_HOLD_MS = 8_000;
const HANDOFF_MAX_AGE_MS = 15 * 60_000;
const APPROVAL_INFER_DELAY_MS = 8_000;
const CUA_ELICIT_APIS = [
  /\.setFiles\s*\(/,
  /\.downloadMedia\s*\(/,
  /\.waitForEvent\s*\(\s*['"]download['"]\s*\)/
];
const CUA_HANDOFF_API = /\.markHandoff\s*\(/;
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

// Character-aligned 7-tier work status texts (claude / gemini / dragon / deepseek / zcode)
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
  },
  deepseek: {
    thinking: [
      '脑袋顶上的呆毛正在竖起来，深海推理中…',
      '托腮拿着小筷子琢磨中，怎么写最划算呢？',
      '正在海底打捞上下文线索，很快就能浮上水面~',
      '咕噜咕噜……脑海里的推导泡泡正一串串冒出来！',
      '正在对照需求仔细推演，马上给出漂亮解法~',
      '先在深水区把边界算清楚，待会儿动笔才不返工！'
    ],
    working: [
      '蓝鲸笔记本全速运转中，一边敲代码一边盯终端~',
      '小指一点，全息代码屏刷刷展开——全速干活中！',
      '大肥鱼正在认真改文件，小饭碗都顾不上扒两口啦！',
      '正在把逻辑一行行捞起来理顺，主人稍安勿躁~',
      '海蓝光标飞速跳动中，剩下的杂活包在我身上！',
      '鲸尾轻轻拍打节拍——构建与修改同步推进中~'
    ],
    waiting: [
      '双手捧着空空的小白碗——主人，这里等您拍板投喂许可呢！',
      '咕……端着空碗眼巴巴望着您，点一下确认就继续~',
      '碰到关键分岔口啦，等主人发个话我再接着干活！',
      '小鲸尾停下来晃了晃，请主人过目这一步权限确认~',
      '饭碗先举到屏幕前啦！您点个头我就立马开动~',
      '等主人做出选择呢，选好我继续潜下去帮您码字！'
    ],
    stalled: [
      '海面有点起雾，对面响应慢悠悠的，我浮着替您守着…',
      '这一步好像卡在深水区了，我捧着饭碗继续盯着日志…',
      '工具还没回信呢，先晃晃鲸尾耐心等一会儿~'
    ],
    result: [
      '终端结果打捞上岸啦，正在为您盛进结果碗里~',
      '气泡里裹着关键输出浮上来咯，容我整理呈上！',
      '这一小步顺顺当当跑通了，正在串联下一段内容…',
      '数据已经捞齐，正在过滤杂鱼留干货给主人看~',
      '工具交差啦，容大肥鱼再对照需求核实一遍！',
      '阶段回执收好咯，马上汇总成清晰回复呈给您~'
    ],
    success: [
      '满满一碗香喷喷的代码端上来啦！大肥鱼今天超棒吧？',
      '呼呼~ 捧着热腾腾的白米饭收工庆祝，主人快验收吧！',
      '深海探索圆满浮水！这一轮又快又省心地跑完啦~',
      '全部打捞验收完毕，记得夸夸努力干活的大肥鱼哦！',
      '小饭碗装得满满当当，随时准备接下一顿大餐任务！',
      '蓝鲸勋章闪亮亮~ 今天的代码也顺利端稳上桌啦！'
    ],
    error: [
      '噗噜？！哪里冒出来的调皮 Bug 撞翻了小饭碗！',
      '呆毛警报拉响——正在顺着堆栈潜下去捉那只漏洞！',
      '抓到一处红字报错啦，主人别慌，我马上下海修补~',
      '鲸尾一拍掀起水花，哪个边界条件敢在这里捣乱！',
      '捕获到异常信号了，容我托腮理出它报错的原因…',
      '小风浪而已，大肥鱼这就把它拍平再继续往前游！'
    ]
  },
  zcode: {
    thinking: [
      '托腮眨眨蓝灰眼眸，头顶灵感小灯泡亮起来啦…',
      '狐耳轻轻支起——正在细听代码上下文里的线索！',
      '银色小铃铛晃了晃，正在推演最稳妥的重构路线…',
      '额前的睡眠眼罩还没戴上呢，此刻思路可清醒着！',
      '正在对照依赖关系反复思量，解法就快浮现了~',
      '大尾巴在身后慢悠悠扫过，容我理顺这一段逻辑！'
    ],
    working: [
      '爪印笔记本嗡嗡运转中，正在全息代码屏上飞快落笔！',
      '叮铃~ 智谱娘认真进入编码节奏，终端和文件双线推进中！',
      '指尖在代码浮窗上轻点，一行行规则逻辑稳稳落地~',
      '黑色哥特裙摆微微扬起，正在把乱糟糟的结构理顺！',
      '蓝光星芒闪过——构建与改动正有序执行呢！',
      '双腕黑扣系紧，这一轮的编码重活交给我就好啦！'
    ],
    waiting: [
      '狐耳垂下来一点点——主人，这里需要您点头才能继续哦。',
      '悬停在分支节点上呢，等主人亲自拍板下发指令~',
      '铃铛轻响提醒：有个权限确认正等着主人批复！',
      '暂且合上爪印笔记本，请问主人接下来希望怎么走？',
      '等待您的确认信号，批下来我立刻继续推进~',
      '这步涉及重要改动，请主人先确认后再由我执行吧！'
    ],
    stalled: [
      '对面好久没动静呀，狐耳一直竖着替您等回音呢…',
      '这一步执行有点久，我先把铃铛按住安静守候日志~',
      '远端响应慢半拍，不过大尾巴一直帮您暖着桌面等结果…'
    ],
    result: [
      '全息屏返回数据已接住，正在整理清晰结论给您~',
      '铃铛响了一记提示音，这一步的验证输出已收进笔记本！',
      '工具执行回执妥当，容我核对细节后马上汇报~',
      '线索拼图刚凑齐，蓝灰眼眸正在快速扫读关键片段…',
      '阶段性结果已落袋，正在为您串联下一节推进~',
      '命令回波收齐了，正在精简冗余后呈现最终结论~'
    ],
    success: [
      '眼里闪出亮晶晶的蓝星★ 这一轮漂亮拿下啦，主人！',
      '叮铃叮铃~ 所有检查与改动全数收官，是不是超可靠！',
      '双拳一攥满心欢喜——今天的代码质量也让狐耳满意呢！',
      '爪印笔记本合上啦，圆满交差，请主人检阅成果~',
      '蓝紫挑染都跟着亮起来咯，随时准备好迎接下一题！',
      '全部稳妥落地，大尾巴得意地晃了三圈呢~'
    ],
    error: [
      '狐耳警觉地弹起来了！刚才捕获到一处异常报错！',
      '咦，红字从哪儿冒出来的？容我托腮顺着调用栈查清！',
      '叮铃警示响起——发现一处越界异常，我马上动手修复~',
      '可别想藏过我的蓝灰眼眸，正在锁定引发报错的那一行！',
      '遇到一点小故障，主人喝口水吧，我来把逻辑修顺畅~',
      '异常堆栈已经记进爪印笔记本，这就逐条拆解摆平它！'
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

function isCuaReplCall(payload) {
  const ns = String(payload?.namespace || '');
  const name = String(payload?.name || payload?.tool || '');
  return ns.startsWith('mcp__cua_repl') && (name === 'js' || name === '');
}

function codexCuaCode(payload) {
  const raw = payload?.arguments ?? payload?.input ?? payload?.args;
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      if (typeof o?.code === 'string') return o.code;
    } catch {}
    return raw;
  }
  if (raw && typeof raw === 'object' && typeof raw.code === 'string') return raw.code;
  return '';
}

function cuaDetailText(code, patterns = CUA_ELICIT_APIS) {
  if (!code) return null;
  const lines = String(code).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const hit = lines.find(l => patterns.some(re => re.test(l)));
  return finalizeTaskDetail(hit || lines[0] || null);
}

function isRealUserMessageText(rawText) {
  const t = String(rawText || '').trim();
  if (!t) return false;
  if (/^<(?:environment_context|user_instructions|permissions instructions|collaboration_mode|app-context|instructions)\b/i.test(t)) {
    return false;
  }
  return true;
}

function isCuaHandoffErrorOutput(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.is_error === true || payload.isError === true) return true;
  if (typeof payload.status === 'string' && /^(?:error|failed|rejected|cancelled|canceled)$/i.test(payload.status.trim())) {
    return true;
  }
  const hasErrorText = (raw) => {
    const t = String(raw || '').trim();
    if (!t) return false;
    return /^(?:error|failed|exception|typeerror|referenceerror|rangeerror|syntaxerror)\b\s*[:!]/i.test(t) ||
      /^(?:tool\s+call\s+failed|failed\s+to)\b/i.test(t) ||
      /\bmarkHandoff\s+failed\b/i.test(t);
  };
  const hasErrorObj = (obj) => {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.ok === false || obj.success === false || obj.is_error === true || obj.isError === true) return true;
    if (obj.error !== undefined && obj.error !== null && obj.error !== false && obj.error !== '') return true;
    if (typeof obj.status === 'string' && /^(?:error|failed|rejected|cancelled|canceled)$/i.test(obj.status.trim())) return true;
    if (Array.isArray(obj.content)) {
      const joined = obj.content.map(c => (typeof c === 'string' ? c : (c && c.text) || '')).join('\n');
      if (hasErrorText(joined)) return true;
    }
    return false;
  };
  const rawOut = payload.output ?? payload.result ?? payload.content;
  if (typeof rawOut === 'string') {
    const parsed = tryParseJsonObject(rawOut);
    if (parsed) return hasErrorObj(parsed);
    return hasErrorText(rawOut);
  }
  if (Array.isArray(rawOut)) {
    const joined = rawOut.map(c => (typeof c === 'string' ? c : (c && c.text) || '')).join('\n');
    return hasErrorText(joined);
  }
  if (rawOut && typeof rawOut === 'object') {
    return hasErrorObj(rawOut);
  }
  return false;
}

function extractCodexMessageText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.content === 'string') return payload.content;
  if (Array.isArray(payload.content)) {
    return payload.content.map(c => (typeof c === 'string' ? c : (c && c.text) || '')).join('');
  }
  if (typeof payload.text === 'string') return payload.text;
  return '';
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

  if (!lines.length && isCuaReplCall(obj)) {
    return cuaDetailText(codexCuaCode(obj));
  }

  return finalizeTaskDetail(lines.join('\n'));
}

let _cachedStatusTier = null;
let _cachedStatusText = '';

const KNOWN_CHARACTERS = new Set(['claude', 'dragon', 'gemini', 'deepseek', 'zcode']);

function normalizeCharacterKey(raw) {
  const key = String(raw || 'claude').trim().toLowerCase();
  return KNOWN_CHARACTERS.has(key) ? key : 'claude';
}

// WO-03 & Issue ①: Hold quote consistently throughout entire task, only re-pick when character or state/tier changes
function pickStatusText(tier, character = 'claude') {
  const charKey = normalizeCharacterKey(character);
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
  const map = { plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', 'pro lite': 'Pro Lite', promax: 'Pro Max', 'pro max': 'Pro Max', team: 'Team', enterprise: 'Enterprise', edu: 'Edu', free: 'Free' };
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

function parseQuotaWindows(limit, planLabel) {
  const windows = [];
  const seenIds = new Set();
  const entries = Object.entries(limit).filter(([, w]) =>
    typeof w?.usedPercent === 'number' || typeof w?.used_percent === 'number');
  const loneProWindow = ['Pro', 'Pro Lite', 'Pro Max'].includes(planLabel) && entries.length === 1;
  for (const [k, w] of entries) {
    const duration = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : (typeof w.window_minutes === 'number' ? w.window_minutes : null);
    const used = typeof w.usedPercent === 'number' ? w.usedPercent : (typeof w.used_percent === 'number' ? w.used_percent : null);
    const unknownCycle = loneProWindow && k === 'primary' && duration === null;
    const is5h = duration === 300 || (k === 'primary' && duration === null && !unknownCycle);
    const isWeek = (duration === 10080 || (k === 'secondary' && duration === null));
    const id = unknownCycle ? 'unspecified' : is5h ? 'fiveHour' : (isWeek ? 'weekly' : (duration ? `w_${duration}` : `win_${k}`));
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const label = unknownCycle ? '当前额度' : is5h ? '5h' : (isWeek ? 'Weekly' : (duration ? (duration >= 60 ? `${Math.round(duration / 60)}h` : `${duration}m`) : String(k)));
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
  return windows;
}

function parseCodexRateLimits(r, planType) {
  const buckets = r?.rateLimitsByLimitId;
  const single = r?.rateLimits;
  const legacyCodex = single?.limitId === 'codex' || (!single?.limitId && !Object.keys(buckets ?? {}).length);
  const limit = buckets?.codex ?? (legacyCodex ? single : null);
  if (!limit) return null;

  const planLabel = formatPlanLabel(limit.planType || planType);
  const windows = parseQuotaWindows(limit, planLabel);
  const count = r.rateLimitResetCredits?.availableCount;
  return {
    ok: windows.length > 0,
    planLabel,
    resetCardCount: Number.isSafeInteger(count) && count >= 0 ? count : null,
    observedAt: Date.now(),
    windows
  };
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
        done(parseCodexRateLimits(m.result, planType));
      }
    });

    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'agent_pet', title: 'AgentPet', version: '1.6.6' } }
    });
  });
}

function makeCompletion({
  source,
  rawId = '',
  turnId = '',
  kind = '',
  outcome = 'step_only',
  strictTurnEnd = false,
  eventAt = 0,
  turnStartedAtMs = 0,
  eligibleForAntigravityFinalReply = false
}) {
  const normRaw = String(rawId || 'default');
  const normTurn = String(turnId || 'unknown');
  const ts = (Number.isFinite(Number(eventAt)) && Number(eventAt) > 0) ? Number(eventAt) : 0;
  const startTs = (Number.isFinite(Number(turnStartedAtMs)) && Number(turnStartedAtMs) > 0) ? Number(turnStartedAtMs) : 0;
  return {
    strictTurnEnd: Boolean(strictTurnEnd),
    outcome,
    kind,
    source,
    sessionKey: `${source}|${normRaw}`,
    turnId: normTurn,
    eventId: `${source}|${normRaw}|${normTurn}|${outcome}`,
    eventAt: ts,
    ...(startTs > 0 ? { turnStartedAtMs: startTs } : {}),
    ...(eligibleForAntigravityFinalReply ? { eligibleForAntigravityFinalReply: true } : {})
  };
}

function finalizeSessionCompletion(state, source, rawId) {
  if (!state || !state.completion) return state;
  const compSource = state.completion.source || source || state.source || '';
  const compRaw = rawId || state.rawId || state.sessionId || 'default';
  const normTurn = String(state.completion.turnId || 'unknown');
  const outcome = state.completion.outcome || 'step_only';
  return {
    ...state,
    completion: {
      ...state.completion,
      source: compSource,
      sessionKey: `${compSource}|${compRaw}`,
      eventId: `${compSource}|${compRaw}|${normTurn}|${outcome}`
    }
  };
}

function resolveCodexTurnAnchor(lines, endIndex, fallbackTs) {
  const parseTs = (obj) => {
    const t = obj && obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    return (Number.isFinite(t) && t > 0) ? t : 0;
  };
  let turnStartedAtMs = 0;
  let endEntry = null;
  try { endEntry = JSON.parse(lines[endIndex]); } catch {}
  const endPayload = endEntry?.payload || {};
  const endExplicitTurnId = String(endPayload.turn_id || endPayload.task_id || endEntry?.turn_id || '').trim();
  let explicitTurnId = endExplicitTurnId;
  const endTs = parseTs(endEntry);

  let turnStartIdx = 0;
  for (let j = endIndex - 1; j >= 0; j--) {
    let e;
    try { e = JSON.parse(lines[j]); } catch { continue; }
    if (e.type === 'event_msg') {
      const k = String(e.payload?.type || '').toLowerCase();
      const sid = String(e.payload?.turn_id || e.payload?.task_id || e.turn_id || '').trim();
      const ts = parseTs(e);
      if (k === 'task_started' || k === 'turn_started') {
        if (endExplicitTurnId) {
          if (sid && sid !== endExplicitTurnId) continue;
          if (!sid && endTs > 0 && ts > endTs) continue;
        } else {
          if (endTs > 0 && ts > endTs) continue;
          if (sid) explicitTurnId = sid;
        }
        if (ts > 0) turnStartedAtMs = ts;
        turnStartIdx = j;
        break;
      }
      if (k === 'task_complete' || k === 'turn_complete' || k === 'turn_aborted') {
        if (endExplicitTurnId) {
          if (sid && sid !== endExplicitTurnId) continue;
          // Same-turn duplicate boundary (e.g. replayed task_complete): keep searching back for its task_started.
          if (sid === endExplicitTurnId) continue;
        }
        if (endTs > 0 && ts > endTs) continue;
        turnStartIdx = Math.min(endIndex, j + 1);
        break;
      }
    }
  }

  if (!turnStartedAtMs) {
    for (let j = turnStartIdx; j <= endIndex; j++) {
      try {
        const obj = JSON.parse(lines[j]);
        const oSid = String(obj?.payload?.turn_id || obj?.payload?.task_id || obj?.turn_id || '').trim();
        if (endExplicitTurnId && oSid && oSid !== endExplicitTurnId) continue;
        const ts = parseTs(obj);
        if (ts > 0 && (endTs <= 0 || ts <= endTs)) {
          turnStartedAtMs = ts;
          break;
        }
      } catch {}
    }
  }
  if (!turnStartedAtMs && endTs > 0) {
    turnStartedAtMs = endTs;
  }
  if (!turnStartedAtMs && Number.isFinite(Number(fallbackTs)) && Number(fallbackTs) > 0) {
    turnStartedAtMs = Number(fallbackTs);
  }
  if (endTs > 0 && turnStartedAtMs > endTs) {
    turnStartedAtMs = endTs;
  }

  let turnOrdinal = 0;
  for (let j = 0; j < turnStartIdx; j++) {
    const raw = lines[j];
    if (!raw || (!raw.includes('task_complete') && !raw.includes('turn_complete') && !raw.includes('turn_aborted'))) continue;
    try {
      const e = JSON.parse(raw);
      if (e.type === 'event_msg') {
        const k = String(e.payload?.type || '').toLowerCase();
        if (k === 'task_complete' || k === 'turn_complete' || k === 'turn_aborted') turnOrdinal += 1;
      }
    } catch {}
  }

  if (explicitTurnId) {
    return { turnId: `id:${explicitTurnId}`, explicitTurnId, turnStartedAtMs };
  }
  const anchorHash = crypto.createHash('sha1').update(String(lines[turnStartIdx] || '')).digest('hex').slice(0, 12);
  return { turnId: `t:${turnOrdinal}:${anchorHash}`, explicitTurnId: '', turnStartedAtMs };
}

function inspectCodexTurnLifecycle(lines) {
  const turns = [];
  for (let j = 0; j < lines.length; j++) {
    const raw = lines[j];
    if (!raw || (!raw.includes('task_started') && !raw.includes('turn_started') &&
        !raw.includes('task_complete') && !raw.includes('turn_complete') && !raw.includes('turn_aborted'))) {
      continue;
    }
    let e;
    try { e = JSON.parse(raw); } catch { continue; }
    if (e.type !== 'event_msg') continue;
    const k = String(e.payload?.type || '').toLowerCase();
    const tid = String(e.payload?.turn_id || e.payload?.task_id || e.turn_id || '').trim();
    const parsedTs = e.timestamp ? Date.parse(e.timestamp) : NaN;
    const evTs = (Number.isFinite(parsedTs) && parsedTs > 0) ? parsedTs : 0;

    if (k === 'task_started' || k === 'turn_started') {
      turns.push({ idx: j, turnId: tid, ts: evTs, closed: false });
    } else if (k === 'task_complete' || k === 'turn_complete' || k === 'turn_aborted') {
      if (tid) {
        for (let t = turns.length - 1; t >= 0; t--) {
          if (!turns[t].closed && turns[t].turnId === tid) {
            turns[t].closed = true;
            break;
          }
        }
      } else {
        for (let t = turns.length - 1; t >= 0; t--) {
          if (!turns[t].closed && (turns[t].ts <= 0 || evTs <= 0 || turns[t].ts <= evTs)) {
            turns[t].closed = true;
            break;
          }
        }
      }
    }
  }

  const latestOpenTurn = [...turns].reverse().find(t => !t.closed) || null;
  let fallbackOpenTurnId = '';
  if (latestOpenTurn && !latestOpenTurn.turnId) {
    let ordinal = 0;
    for (let j = 0; j < latestOpenTurn.idx; j++) {
      const raw = lines[j];
      if (!raw || (!raw.includes('task_complete') && !raw.includes('turn_complete') && !raw.includes('turn_aborted'))) continue;
      try {
        const e = JSON.parse(raw);
        if (e.type === 'event_msg') {
          const k = String(e.payload?.type || '').toLowerCase();
          if (k === 'task_complete' || k === 'turn_complete' || k === 'turn_aborted') ordinal += 1;
        }
      } catch {}
    }
    const anchorHash = crypto.createHash('sha1').update(String(lines[latestOpenTurn.idx] || '')).digest('hex').slice(0, 12);
    fallbackOpenTurnId = `t:${ordinal}:${anchorHash}`;
  }
  return {
    latestOpenTurn,
    activeTurnId: latestOpenTurn ? (latestOpenTurn.turnId ? `id:${latestOpenTurn.turnId}` : fallbackOpenTurnId) : '',
    activeTurnStartedAtMs: latestOpenTurn?.ts || 0
  };
}

function isStateFresh(state, now) {
  if (!state || !state.state) return false;
  const age = now - (state.at || 0);
  if (state.source === 'DSH' && age < -DSH_APPROVAL_FUTURE_TOLERANCE_MS) return false;
  if (state.source === 'DSH' && state.state === 'approval') return isDshApprovalFresh(state.at, now);
  if (state.kind === 'handoff') return age < HANDOFF_MAX_AGE_MS;
  if (isHeldState(state)) return age < WAITING_MAX_AGE_MS;
  if (state.state === 'success' || state.state === 'result' || state.state === 'error' || state.state === 'idle') {
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
      delete next.completion;
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

function dshPendingCalls(rows) {
  const pending = rows?.sessionStats?.val?.pendingCalls || rows?.pendingCalls?.val;
  return Object.entries(pending || {}).map(([key, value]) => ({
    id: value?.callId || value?.id || key, value
  }));
}

function isDshApprovalFresh(askedAt, now) {
  return Number.isFinite(askedAt) && askedAt > 0
    && askedAt <= now + DSH_APPROVAL_FUTURE_TOLERANCE_MS && now - askedAt < DSH_APPROVAL_TIMEOUT_MS;
}

function findFreshDshApproval(journal, now) {
  return journal?.approvals.find(approval => isDshApprovalFresh(approval.at, now)) ?? null;
}

function dshZstdFrameStarts(bytes) {
  const starts = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) return null;
    const magic = bytes.readUInt32LE(offset);
    starts.push(offset);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      if (offset + 8 > bytes.length) return null;
      offset += 8 + bytes.readUInt32LE(offset + 4);
    } else {
      if (magic !== 0xfd2fb528 || offset + 5 > bytes.length) return null;
      const descriptor = bytes[offset + 4];
      if (descriptor & 8) return null; // Reserved bit in the frame header.
      const singleSegment = Boolean(descriptor & 32);
      const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
      const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >>> 6];
      offset += 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
      let block;
      do {
        if (offset + 3 > bytes.length) return null;
        block = bytes.readUIntLE(offset, 3);
        const type = (block >>> 1) & 3;
        if (type === 3) return null;
        offset += 3 + (type === 1 ? 1 : block >>> 3);
      } while (!(block & 1));
      if (descriptor & 4) offset += 4;
    }
    if (offset > bytes.length) return null;
  }
  return starts;
}

function hasCompleteDshTurnStart(bytes) {
  const marker = '"turn/start"';
  for (let at = bytes.lastIndexOf(marker); at > 0; at = bytes.lastIndexOf(marker, at - 1)) {
    const start = bytes.lastIndexOf(10, at - 1);
    const end = bytes.indexOf(10, at);
    if (start < 0 || end < 0) continue;
    try {
      const event = JSON.parse(bytes.toString('utf8', start + 1, end));
      if (event.type === 'turn/start' && event.data) return true;
    } catch {}
  }
  return false;
}

function decodeDshZstdJournal(bytes, fileOffset) {
  const starts = dshZstdFrameStarts(bytes);
  if (!starts) return null;
  const parts = [];
  let end = bytes.length;
  for (let index = starts.length - 1; index >= 0;) {
    let start = starts[index--];
    while (index >= 0 && end - starts[index] <= DSH_ZSTD_TAIL_BYTES) start = starts[index--];
    const part = zlib.zstdDecompressSync(bytes.subarray(start, end), { chunkSize: 128 * 1024 });
    parts.push(part);
    // A suffix is authoritative only if it contains a complete start of the latest turn.
    const offset = fileOffset + start;
    if (offset === 0 || hasCompleteDshTurnStart(part)) {
      return { decoded: parts.length === 1 ? part : Buffer.concat(parts.reverse()), zstdOffset: offset };
    }
    end = start;
  }
  return null;
}

function readDshZstdRange(resolved, offset) {
  const fd = fs.openSync(resolved.file, 'r');
  try {
    const bytes = Buffer.allocUnsafe(resolved.size - offset);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(fd, bytes, read, bytes.length - read, offset + read);
      if (!count) return null;
      read += count;
    }
    const stat = fs.fstatSync(fd);
    if (stat.size !== resolved.size || stat.mtimeMs !== resolved.mtimeMs
      || stat.ctimeMs !== resolved.ctimeMs || stat.ino !== resolved.ino || stat.dev !== resolved.dev) return null;
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function dshCallTime(value) {
  return Number(value && typeof value === 'object' ? (value.at || value.startTime || value.time) : value);
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
    this.lastLiveQuotaAt = 0;
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
    this.dshDiagnostics = new Set();
    this.dshLogDirCache = new Map();
    this.isProbe = options.isProbe || false;

    // Caching layer to avoid heavy 500ms disk parsing (Issue 12)
    this.cachedDsh = { mtime: 0, file: null, state: null };
    this.cachedAg = { mtime: 0, file: null, state: null };
    this.cachedCodex = { mtime: 0, size: 0, file: null, state: null };
    this.codexStateCache = new Map();
    this.codexAsyncCache = new Map();
    this.codexSubagentCache = new Map();
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
    this.pendingForceBalance = false;
    this.pendingForceBalanceAt = 0;
    this.stopped = false;
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
    this.pendingForceBalance = false;
    this.pendingForceBalanceAt = 0;
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
      if (!deadline) return Math.floor(capMs);
      const rem = Math.floor(deadline - Date.now());
      return rem >= minReq ? Math.min(Math.floor(capMs), rem) : 0;
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
    this.stopped = false;
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
    this.stopped = true;
    this.pendingForceBalance = false;
    this.pendingForceBalanceAt = 0;
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
    let forceRequestAt = 0;
    try {
      if (fs.existsSync(this.paths.refreshBalanceFlag)) {
        const st = fs.statSync(this.paths.refreshBalanceFlag);
        if (st.mtimeMs > this.lastFlagBalanceMtime) {
          this.lastFlagBalanceMtime = st.mtimeMs;
          force = true;
          const flooredMtime = Number.isFinite(st.mtimeMs) ? Math.floor(st.mtimeMs) : 0;
          forceRequestAt = (flooredMtime > 0 && flooredMtime <= now) ? flooredMtime : now;
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
      this.pollBalance(force, force ? { requestAt: forceRequestAt } : undefined);
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

  emitBalanceThrottleReceipt(errorCode, errorMessage, now = Date.now()) {
    const base = this.cachedBalanceData
      ? {
          ...this.cachedBalanceData,
          ...(errorCode === 'RATE_LIMITED' ? { status: 'stale' } : {})
        }
      : {
          type: 'balance',
          provider: 'unknown',
          providerFamily: 'deepseek',
          credentialSource: 'dsh',
          status: 'error',
          isAvailable: null,
          currency: 'CNY',
          balances: [],
          hostCounter: null,
          fetchedAt: now,
          observedAt: null
        };
    this.onChange({
      ...base,
      lastAttemptAt: now,
      errorCode,
      errorMessage
    });
  }

  async pollBalance(force = false, options = {}) {
    if (this.balanceBusy) {
      if (force) {
        const reqAt = Number.isFinite(options?.requestAt) && options.requestAt > 0
          ? Math.floor(options.requestAt)
          : Date.now();
        this.pendingForceBalance = true;
        this.pendingForceBalanceAt = this.pendingForceBalanceAt > 0
          ? Math.min(this.pendingForceBalanceAt, reqAt)
          : reqAt;
      }
      return;
    }
    const now = Date.now();
    const config = this.readPetConfig();

    const balanceEnabled = (config.DeepSeekBalanceEnabled !== false);
    if (!balanceEnabled) {
      this.publishBalanceDisabled(now);
      return;
    }
    this.balanceDisabledPublished = false;

    if (this.lastBalanceFetchAttempt && (now - this.lastBalanceFetchAttempt < 10_000)) {
      if (force) {
        const sec = Math.max(1, Math.ceil((10_000 - (now - this.lastBalanceFetchAttempt)) / 1000));
        this.emitBalanceThrottleReceipt('COOLDOWN', `刷新过于频繁，请等待 ${sec} 秒后再试`, now);
      }
      return;
    }

    if (this.balanceRetryAfterUntil > now) {
      if (force) {
        const sec = Math.max(1, Math.ceil((this.balanceRetryAfterUntil - now) / 1000));
        this.emitBalanceThrottleReceipt('RATE_LIMITED', `请求频率超限，重试需等待 ${sec} 秒`, now);
      }
      return;
    }

    this.balanceBusy = true;
    this.lastBalanceAt = now;
    this.lastBalanceFetchAttempt = now;
    const currentGen = ++this.balanceGeneration;

    // 全链路统一总截止时间预算：10秒（前端设置15秒期限，预留5秒调度冗余；排队接力须扣除已在途等待时间，统一取整避免 AbortSignal.timeout 浮点越界）
    const TOTAL_BALANCE_BUDGET_MS = 10_000;
    const queuedAt = Number.isFinite(options?.queuedAt) && options.queuedAt > 0 ? Math.floor(options.queuedAt) : null;
    const deadline = Math.floor(
      queuedAt !== null
        ? Math.min(now + TOTAL_BALANCE_BUDGET_MS, queuedAt + TOTAL_BALANCE_BUDGET_MS)
        : (now + TOTAL_BALANCE_BUDGET_MS)
    );
    const getRemainingBudget = (capMs = 10_000, minReq = 150) => {
      const rem = Math.floor(deadline - Date.now());
      return rem >= minReq ? Math.min(Math.floor(capMs), rem) : 0;
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
        if (this.pendingForceBalance && !this.stopped) {
          const queuedAt = this.pendingForceBalanceAt > 0 ? this.pendingForceBalanceAt : Date.now();
          this.pendingForceBalance = false;
          this.pendingForceBalanceAt = 0;
          void this.pollBalance(true, { queuedAt }).catch(() => {});
        }
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
        this.lastLiveQuotaAt = live.observedAt;
        this.onChange({ type: 'quota', ...live });
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
              const planLabel = formatPlanLabel(rl.plan_type || rl.planType) || '离线快照';
              const windows = parseQuotaWindows(rl, planLabel);
              if (windows.length > 0) {
                // File mtime may advance when unrelated events are appended after an account switch.
                const eventTime = Date.parse(e.timestamp);
                if (this.lastLiveQuotaAt && (!Number.isFinite(eventTime) || eventTime <= this.lastLiveQuotaAt)) return;
                this.onChange({
                  type: 'quota',
                  ok: true,
                  source: 'offline',
                  planLabel,
                  resetCardCount: null,
                  observedAt: Number.isFinite(eventTime) ? eventTime : Math.round(Number(latest.mtime) || Date.now()),
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
      const src = a.source || '';
      const normSessions = Array.isArray(a.sessions)
        ? a.sessions.map(s => {
            const sRaw = s.rawId || s.sessionId || rawId || 'default';
            const sSrc = s.source || src;
            const withComp = finalizeSessionCompletion(s, sSrc, sRaw);
            return {
              ...withComp,
              source: sSrc,
              rawId: sRaw,
              sessionKey: withComp.sessionKey || `${sSrc}|${sRaw}`
            };
          })
        : null;
      const finalized = finalizeSessionCompletion({
        ...a,
        ...(rawId ? { rawId } : {}),
        ...(normSessions ? { sessions: normSessions } : {}),
        taskDetail
      }, src, rawId);
      return finalized;
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

    const snapshotMap = new Map();
    for (const agItem of [allAgents.antigravity, allAgents.dsh, allAgents.codex]) {
      if (!agItem) continue;
      const list = (Array.isArray(agItem.sessions) && agItem.sessions.length > 0)
        ? agItem.sessions
        : [agItem];
      for (const s of list) {
        if (!s || !s.state) continue;
        const sSource = s.source || agItem.source || '';
        const sRawId = s.rawId || s.sessionId || agItem.rawId || 'default';
        const sessionKey = s.sessionKey || `${sSource}|${sRawId}`;
        const snap = {
          source: sSource,
          rawId: sRawId,
          sessionKey,
          state: s.state,
          at: s.at || agItem.at || now,
          ...(s.turnId ? { turnId: s.turnId } : {}),
          ...(s.turnStartedAtMs > 0 ? { turnStartedAtMs: s.turnStartedAtMs } : {}),
          ...(s.completion ? { completion: s.completion } : {})
        };
        const existing = snapshotMap.get(sessionKey);
        if (!existing || this.selectBest(existing, snap, now) === snap) {
          snapshotMap.set(sessionKey, snap);
        }
      }
    }
    const sessionSnapshots = Array.from(snapshotMap.values());
    const totalActiveSessions = sessionSnapshots.filter(s => ACTIVE_WORK_STATES.has(s.state)).length;

    const sessionDigest = (s) => [
      s.sessionKey || `${s.source || ''}|${s.rawId || s.sessionId || ''}`,
      s.state || '',
      s.turnId || '',
      s.completion?.eventId || '',
      s.completion?.outcome || '',
      Boolean(s.completion?.strictTurnEnd),
      Boolean(s.completion?.eligibleForAntigravityFinalReply)
    ];

    const agentSnapshot = (a) => a ? [
      a.source || '',
      a.rawId || a.sessionId || '',
      a.state || '',
      a.turnId || '',
      a.task || '',
      a.taskDetail ?? null,
      a.sessionCount || 0,
      a.completion?.eventId || '',
      a.completion?.outcome || '',
      Boolean(a.completion?.strictTurnEnd),
      Array.isArray(a.sessions) ? a.sessions.map(sessionDigest) : []
    ] : null;

    const key = (best || sessionSnapshots.length > 0) ? JSON.stringify({
      source: best?.source || '',
      rawId: best?.rawId || best?.sessionId || '',
      state: best?.state || '',
      task: best?.task || '',
      taskDetail: best?.taskDetail ?? null,
      sessionCount: best?.sessionCount || 0,
      activeCount,
      totalActiveSessions,
      completionEventId: best?.completion?.eventId || '',
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
      ? this.readPetConfig()?.Character
      : 'claude';
    const charKey = normalizeCharacterKey(cfgCharRaw);
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
        activeCount: activeCount,
        totalActiveSessions,
        completion: best?.completion || null,
        sessionSnapshots
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
    const prio = { waiting: 7, approval: 7, error: 6, stalled: 5, working: 4, thinking: 3, result: 2, success: 1, idle: 0 };
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
    const normAgId = (id) => String(id || '').replace(/\.db$/i, '');
    const normDbId = normAgId(db?.rawId);
    const normTxId = normAgId(tx?.rawId);
    const sameConversation = Boolean(normDbId && normTxId && normDbId === normTxId);

    const pickAgWinner = (d, t, isSame) => {
      if (t && (t.state === 'waiting' || t.state === 'approval')) return t;
      if (d && (d.state === 'waiting' || d.state === 'approval')) return d;
      const dIdx = Number.isFinite(d?.stepIdx) ? d.stepIdx : -1;
      const tIdx = Number.isFinite(t?.stepIdx) ? t.stepIdx : -1;
      if (t && t.inFlight && !d) return t;
      if (t && t.inFlight && isSame && tIdx >= dIdx - 1) return t;
      if (isSame) return d || t;
      return this.selectBest(d, t, now);
    };

    const primary = pickAgWinner(db, tx, sameConversation);
    if (!primary) return null;

    // Merge sessions across DB and Transcript per normalized conversation ID so parallel AG sessions & DB-lag checks stay accurate
    const dbByConv = new Map();
    for (const s of (Array.isArray(db?.sessions) ? db.sessions : (db ? [db] : []))) {
      const k = normAgId(s.rawId || s.sessionId);
      if (k) dbByConv.set(k, s);
    }
    const txByConv = new Map();
    for (const s of (Array.isArray(tx?.sessions) ? tx.sessions : (tx ? [tx] : []))) {
      const k = normAgId(s.rawId || s.sessionId);
      if (k) txByConv.set(k, s);
    }

    const mergedKeys = new Set([...dbByConv.keys(), ...txByConv.keys()]);
    const mergedSessions = [];
    for (const k of mergedKeys) {
      const dSess = dbByConv.get(k) || null;
      let tSess = txByConv.get(k) || null;
      if (tSess && dSess && tSess.completion?.eligibleForAntigravityFinalReply) {
        const dIdx = Number.isFinite(dSess.stepIdx) ? dSess.stepIdx : -1;
        const tIdx = Number.isFinite(tSess.stepIdx) ? tSess.stepIdx : -1;
        const dbStillAheadOrBusy = Boolean(dSess.inFlight) || (dIdx > tIdx + 1) || ['working', 'thinking', 'waiting', 'approval', 'stalled'].includes(dSess.state);
        if (dbStillAheadOrBusy) {
          tSess = {
            ...tSess,
            completion: makeCompletion({
              source: 'Antigravity',
              rawId: tSess.rawId || k,
              turnId: tSess.completion.turnId,
              kind: 'ag_transcript_db_active_downgrade',
              outcome: 'step_only',
              strictTurnEnd: false,
              eventAt: tSess.completion.eventAt || tSess.at || 0
            })
          };
        }
      }
      const winner = pickAgWinner(dSess, tSess, Boolean(dSess && tSess));
      if (winner) {
        // Carry validated transcript final-reply completion metadata even when same-conversation DB step_15 is selected as display winner
        let mergedCompletion = winner.completion || null;
        if (dSess && tSess && winner === dSess && tSess.completion?.eligibleForAntigravityFinalReply) {
          mergedCompletion = tSess.completion;
        }
        const sessRaw = winner.rawId || k;
        mergedSessions.push(finalizeSessionCompletion({
          sessionId: winner.sessionId || sessRaw,
          rawId: sessRaw,
          sessionKey: `Antigravity|${sessRaw}`,
          source: 'Antigravity',
          state: winner.state,
          task: winner.task,
          at: winner.at,
          ...(mergedCompletion ? { completion: mergedCompletion } : {})
        }, 'Antigravity', sessRaw));
      }
    }

    const pKey = normAgId(primary.rawId || primary.sessionId);
    const primaryMerged = mergedSessions.find(s => normAgId(s.rawId) === pKey);
    return {
      ...primary,
      ...(primaryMerged?.completion ? { completion: primaryMerged.completion } : (primary.completion ? { completion: primary.completion } : {})),
      ...(mergedSessions.length > 0 ? { sessions: mergedSessions, sessionCount: mergedSessions.length } : {})
    };
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
        sessions.push(finalizeSessionCompletion({ ...state, sessionId: rawId, rawId }, 'Antigravity', rawId));
      }
    }
    if (this.antigravityDbCache.size > 64) this.antigravityDbCache.clear();
    if (!sessions.length) return null;
    let best = null;
    for (const session of sessions) best = this.selectBest(best, session, now);
    if (!best) return null;
    best.rawId = best.rawId || best.sessionId;
    best = finalizeSessionCompletion(best, 'Antigravity', best.rawId);
    best.sessions = sessions.map(s => ({
      sessionId: truncate(s.task || s.sessionId, 36) || s.sessionId,
      rawId: s.rawId || s.sessionId,
      sessionKey: `Antigravity|${s.rawId || s.sessionId}`,
      source: 'Antigravity',
      state: s.state,
      task: s.task,
      at: s.at,
      ...(s.inFlight ? { inFlight: true } : {}),
      ...(Number.isFinite(s.stepIdx) ? { stepIdx: s.stepIdx } : {}),
      ...(s.completion ? { completion: s.completion } : {})
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
      const rawId = path.basename(latestDb);

      const terminal = new Set([3, 5, 6, 7]);
      const inFlight = !terminal.has(Number(row.status));
      if (row.step_type === 132) {
        const baseTask = cleanSummary(p.toolSummary || p.toolName || '正在执行工具');
        const nextTask = p.toolSummary ? `推进中 (${p.toolSummary})` : '正在分析结果并构思下一步…';
        const stepDetail = p.toolDetail || null;
        if (inFlight) return { source: 'Antigravity', rawId, state: 'working', task: baseTask, baseTask, taskDetail: stepDetail, at: latestMtime, startedAt: latestMtime, stepIdx: row.idx, inFlight: true };
        if (now - latestMtime < TERMINAL_HOLD_MS) {
          return {
            source: 'Antigravity',
            rawId,
            state: 'result',
            task: p.toolSummary ? `已完成: ${p.toolSummary}` : '步骤执行完毕',
            taskDetail: stepDetail,
            nextState: { state: 'thinking', task: nextTask, taskDetail: p.toolSummary ? stepDetail : null },
            at: latestMtime,
            stepIdx: row.idx,
            inFlight: false,
            completion: makeCompletion({
              source: 'Antigravity',
              rawId,
              turnId: `db-step:${row.idx}`,
              kind: 'ag_db_step_132',
              outcome: 'step_only',
              strictTurnEnd: false,
              eventAt: latestMtime
            })
          };
        }
        return { source: 'Antigravity', rawId, state: 'thinking', task: nextTask, taskDetail: p.toolSummary ? stepDetail : null, at: latestMtime, stepIdx: row.idx, inFlight: false };
      }
      if (row.step_type === 15) {
        if (inFlight) return { source: 'Antigravity', rawId, state: 'thinking', task: '正在深度思考与规划…', baseTask: '正在深度思考与规划…', taskDetail: null, at: latestMtime, startedAt: latestMtime, stepIdx: row.idx, inFlight: true };
        if (now - latestMtime < TERMINAL_HOLD_MS) {
          return {
            source: 'Antigravity',
            rawId,
            state: 'success',
            task: '回答生成完成',
            taskDetail: null,
            at: latestMtime,
            stepIdx: row.idx,
            inFlight: false,
            completion: makeCompletion({
              source: 'Antigravity',
              rawId,
              turnId: `db-step:${row.idx}`,
              kind: 'ag_db_step_15',
              outcome: 'step_only',
              strictTurnEnd: false,
              eventAt: latestMtime
            })
          };
        }
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
      if (state && isStateFresh(state, now)) {
        const convId = path.basename(path.dirname(path.dirname(path.dirname(candidate.file))));
        sessions.push(finalizeSessionCompletion({
          ...state,
          sessionId: convId,
          rawId: convId
        }, 'Antigravity', convId));
      }
    }
    if (this.antigravityTranscriptCache.size > 128) this.antigravityTranscriptCache.clear();
    if (!sessions.length) return null;
    let best = null;
    for (const session of sessions) best = this.selectBest(best, session, now);
    if (!best) return null;
    best.rawId = best.rawId || best.sessionId;
    best = finalizeSessionCompletion(best, 'Antigravity', best.rawId);
    best.sessions = sessions.map(s => ({
      sessionId: truncate(s.task || s.sessionId, 36) || s.sessionId,
      rawId: s.rawId || s.sessionId,
      sessionKey: `Antigravity|${s.rawId || s.sessionId}`,
      source: 'Antigravity',
      state: s.state,
      task: s.task,
      at: s.at,
      ...(s.inFlight ? { inFlight: true } : {}),
      ...(Number.isFinite(s.stepIdx) ? { stepIdx: s.stepIdx } : {}),
      ...(s.completion ? { completion: s.completion } : {})
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
              const entryTs = (entry.timestamp && Date.parse(entry.timestamp)) || latestMtime;
              let turnAnchor = String(entry.step_index ?? i);
              let turnStartedAtMs = 0;
              for (let k = i; k >= 0; k--) {
                try {
                  const pe = JSON.parse(lines[k]);
                  if (pe.type === 'USER_INPUT') {
                    const pTs = pe.created_at ? Date.parse(pe.created_at) : (pe.timestamp ? Date.parse(pe.timestamp) : NaN);
                    if (Number.isFinite(pTs) && pTs > 0) turnStartedAtMs = pTs;
                    turnAnchor = `${pe.step_index ?? k}:${turnStartedAtMs || pe.step_index || k}`;
                    break;
                  }
                } catch {}
              }
              const hasTools = toolCalls.length > 0;
              res = {
                source: 'Antigravity',
                state: 'success',
                task: '回答生成完成',
                taskDetail: null,
                at: latestMtime,
                ...(Number.isFinite(entry.step_index) ? { stepIdx: entry.step_index } : {}),
                completion: hasTools
                  ? makeCompletion({
                      source: 'Antigravity',
                      turnId: `tx-step:${entry.step_index ?? i}`,
                      kind: 'ag_transcript_tool_step',
                      outcome: 'step_only',
                      strictTurnEnd: false,
                      eventAt: entryTs
                    })
                  : makeCompletion({
                      source: 'Antigravity',
                      turnId: `tx-turn:${turnAnchor}`,
                      kind: 'ag_transcript_final_text',
                      outcome: 'completed',
                      strictTurnEnd: false,
                      eligibleForAntigravityFinalReply: true,
                      eventAt: entryTs,
                      turnStartedAtMs
                    })
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
            const errTs = (entry.timestamp && Date.parse(entry.timestamp)) || latestMtime;
            res = {
              source: 'Antigravity',
              state: 'error',
              task: truncate(entry.content || '执行遇到了问题'),
              taskDetail: finalizeTaskDetail(entry.content),
              at: latestMtime,
              completion: makeCompletion({
                source: 'Antigravity',
                turnId: `tx-err:${entry.step_index ?? i}`,
                kind: 'ag_transcript_error',
                outcome: 'failed',
                strictTurnEnd: true,
                eventAt: errTs
              })
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
    if (now < this.lastDshSessionScan || now - this.lastDshSessionScan >= 2000 || this.dshSessionCandidates === null) {
      this.lastDshSessionScan = now;
      const previousJournals = new Map(this.dshSessionCandidates?.map(({ file, journal }) => [file, journal]));
      const candidates = [];
      for (const dshDir of dshDirs) {
        try {
          const files = fs.readdirSync(dshDir).filter(f => f.startsWith('session-') && f.endsWith('.json'));
          for (const file of files) {
            const fp = path.join(dshDir, file);
            try {
              const st = fs.statSync(fp);
              const cached = this.dshStateCache.get(fp);
              const log = this.resolveDshSessionLog(fp);
              const activeSince = Math.max(st.mtimeMs, log?.mtimeMs || 0);
              let coldCalls;
              if (now - activeSince >= DSH_APPROVAL_TIMEOUT_MS && cached?.state?.state !== 'approval') {
                if (this.dshSessionCandidates !== null) continue;
                // On startup an old projection is relevant only if its own live call still awaits a decision.
                coldCalls = dshPendingCalls(JSON.parse(fs.readFileSync(fp, 'utf8')).record?.rows);
                if (!coldCalls.length) continue;
              }
              const journal = this.readDshLogState(fp, previousJournals.get(fp) ?? cached?.journal, log, now);
              if (coldCalls && !journal?.approvals.some(approval => coldCalls.some(call => call.id === approval.callId))) continue;
              candidates.push({ file: fp, mtime: st.mtimeMs, journal });
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
      const activityAt = Math.max(candidate.mtime, candidate.journal?.lastTime || 0);
      const approval = findFreshDshApproval(candidate.journal, now);
      const approvalChanged = cached && cached.approval !== approval;
      // Recheck the selection when the clock enters or leaves any request's valid window.
      if (now - activityAt >= ageLimit && !approval && !approvalChanged) continue;
      let rawState = cachedState;
      const needsLogRecheck = this.isPendingDshStepBoundary(cachedState, candidate.mtime, now);
      if (!cached || cached.mtime !== candidate.mtime || cached.journal !== candidate.journal || needsLogRecheck || approvalChanged) {
        rawState = this.checkDshSingle(now, candidate.file, candidate.mtime, candidate.journal);
        this.dshStateCache.set(candidate.file, { mtime: candidate.mtime, journal: candidate.journal, state: rawState, approval });
      }
      const state = refreshDynamicState(rawState, now, this.stallEnabled, this.stallMs);
      if (state && isStateFresh(state, now)) {
        const rawId = path.basename(candidate.file);
        sessions.push(finalizeSessionCompletion({ ...state, sessionId: rawId, rawId }, 'DSH', rawId));
      }
    }
    if (this.dshStateCache.size > 128) this.dshStateCache.clear();
    if (!sessions.length) return null;
    let best = null;
    for (const session of sessions) best = this.selectBest(best, session, now);
    if (!best) return null;
    best.rawId = best.rawId || best.sessionId;
    best = finalizeSessionCompletion(best, 'DSH', best.rawId);
    best.sessions = sessions.map(s => ({
      sessionId: truncate(s.task || s.sessionId, 36) || s.sessionId,
      rawId: s.rawId || s.sessionId,
      sessionKey: `DSH|${s.rawId || s.sessionId}`,
      source: 'DSH',
      state: s.state,
      task: s.task,
      at: s.at,
      ...(s.turnId ? { turnId: s.turnId } : {}),
      ...(s.turnStartedAtMs > 0 ? { turnStartedAtMs: s.turnStartedAtMs } : {}),
      ...(s.completion ? { completion: s.completion } : {})
    }));
    best.sessionCount = sessions.length;
    return best;
  }

  isPendingDshStepBoundary(state, refMtime, now) {
    return Boolean(
      state
      && state.completion?.outcome === 'step_only'
      && !state.completion?.strictTurnEnd
      && (now - refMtime < TERMINAL_HOLD_MS)
    );
  }

  resolveDshSessionLog(projSessionFile) {
    if (!projSessionFile) return null;
    const sessDir = path.dirname(projSessionFile);
    const projCacheDir = path.dirname(sessDir);
    const storagesDir = path.dirname(projCacheDir);
    if (
      path.basename(sessDir) !== 'sessions'
      || path.basename(projCacheDir) !== 'session_projcache'
      || path.basename(storagesDir) !== 'storages'
    ) {
      return null;
    }
    const sessionsRoot = path.join(path.dirname(storagesDir), 'sessions');
    const sessionId = path.basename(projSessionFile, '.json');
    if (!sessionId || !fs.existsSync(sessionsRoot)) return null;

    let targetDir = this.dshLogDirCache.get(projSessionFile);
    if (!targetDir || !fs.existsSync(targetDir)) {
      targetDir = null;
      try {
        for (const wsName of fs.readdirSync(sessionsRoot)) {
          const candidateDir = path.join(sessionsRoot, wsName, sessionId);
          try {
            if (fs.statSync(candidateDir).isDirectory()) {
              targetDir = candidateDir;
              break;
            }
          } catch {}
        }
      } catch {
        return null;
      }
      if (!targetDir) return null;
      if (this.dshLogDirCache.size > 256) this.dshLogDirCache.clear();
      this.dshLogDirCache.set(projSessionFile, targetDir);
    }

    let bestFile = null;
    let bestVer = -1;
    let bestMtime = -1;
    let bestRaw = false;
    try {
      for (const fn of fs.readdirSync(targetDir)) {
        const m = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/i.exec(fn);
        if (!m) continue;
        const ver = m[1] ? parseInt(m[1], 10) : 0;
        const isRaw = !m[2];
        const fp = path.join(targetDir, fn);
        let stat;
        try { stat = fs.statSync(fp); } catch { continue; }
        const mtimeMs = stat.mtimeMs;
        if (
          ver > bestVer
          || (ver === bestVer && (mtimeMs > bestMtime || (mtimeMs === bestMtime && isRaw && !bestRaw)))
        ) {
          bestVer = ver;
          bestMtime = mtimeMs;
          bestRaw = isRaw;
          bestFile = {
            file: fp, compressed: !isRaw, mtimeMs, size: stat.size,
            ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev
          };
        }
      }
    } catch {
      return null;
    }
    return bestFile;
  }

  logDshOnce(key, message) {
    if (this.dshDiagnostics.has(key)) return;
    if (this.dshDiagnostics.size >= 512) this.dshDiagnostics.delete(this.dshDiagnostics.values().next().value);
    this.dshDiagnostics.add(key);
    writeErrorLog(message);
  }

  readDshLogState(projSessionFile, previous, resolved = this.resolveDshSessionLog(projSessionFile), now = Date.now()) {
    if (!resolved) return null;
    const sameFile = previous?.file === resolved.file && previous.ino === resolved.ino && previous.dev === resolved.dev;
    if (sameFile && previous.mtimeMs === resolved.mtimeMs && previous.size === resolved.size
      && previous.ctimeMs === resolved.ctimeMs) return previous;
    if (resolved.compressed && typeof zlib.zstdDecompressSync !== 'function') {
      this.logDshOnce('zstd-missing', 'DSH: 缺少 zlib.zstdDecompressSync，无法读取压缩会话日志。');
      return null;
    }
    let decoded, zstdOffset = 0;
    try {
      if (resolved.compressed) {
        let tail;
        if (sameFile && previous.zstdOffset > 0 && resolved.size > previous.size) {
          const bytes = readDshZstdRange(resolved, previous.zstdOffset);
          if (bytes) {
            try { tail = decodeDshZstdJournal(bytes, previous.zstdOffset); } catch {}
          }
        }
        tail ??= decodeDshZstdJournal(fs.readFileSync(resolved.file), 0);
        if (!tail) return previous || null;
        ({ decoded, zstdOffset } = tail);
      } else {
        decoded = fs.readFileSync(resolved.file);
      }
    } catch {
      // A compressed snapshot may still be in the middle of a write. Retry on the next scan.
      return previous || null;
    }
    const journal = { ...resolved, zstdOffset, lastTime: 0, lastSeq: 0, turnNum: 0, approvals: [],
      hadApproval: false, blockedAt: 0, unattributedAt: 0, hasQuestionCall: false, question: null,
      resumedCalls: new Map(), nonRunningCalls: new Set(), outcome: null };
    const decisions = new Map();
    const results = new Set();
    let pastStep = false;
    // Parse the latest turn in reverse so results and decisions are known before their calls.
    let end = decoded.length;
    while (end > 0) {
      const start = decoded.lastIndexOf(10, end - 1) + 1;
      const line = decoded.toString('utf8', start, end);
      end = start - 1;
      if (!/"(?:turn\/(?:start|end)|step\/(?:start|end)|approval\/(?:asked|decided)|tool\/result)"/.test(line)
        && !(line.includes('"tool/call"') && line.includes('"ask_user_question"'))) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const data = event?.data;
      if (!data) continue;
      const timestamp = Number(event.time);
      const rawAt = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
      // Keep the original request time for the approval window, never for ranking unrelated work.
      const at = rawAt <= now + DSH_APPROVAL_FUTURE_TOLERANCE_MS ? rawAt : 0;
      journal.lastTime = Math.max(journal.lastTime, at);
      journal.lastSeq = Math.max(journal.lastSeq, Number(event.seq) || 0);
      if (event.type === 'turn/start') {
        journal.turnNum = Number(data.turn) || 0;
        if (journal.outcome && journal.outcome.turnNum === journal.turnNum) {
          journal.outcome.startSeq = event.seq;
          journal.outcome.turnStartedAtMs = at;
        }
        break;
      }
      if (event.type === 'turn/end') {
        if (!pastStep && !journal.outcome) {
          journal.turnNum = Number(data.turn) || 0;
          const reasonKind = String(data.reason?.kind || '').toLowerCase();
          journal.outcome = { turnNum: journal.turnNum, startSeq: event.seq, endSeq: event.seq,
            turnStartedAtMs: 0, endTimeMs: at, reasonKind: reasonKind === 'aborted' ? 'interrupted' : reasonKind,
            errorMessage: String(data.reason?.error?.message || '') };
        }
        pastStep = true;
      } else if (event.type === 'step/start' || event.type === 'step/end') {
        pastStep = true;
      } else if (event.type === 'approval/decided' && data.id && !decisions.has(data.id)) {
        // A decision is still authoritative if the producer clock is skewed.
        const decisionAt = at || (resolved.mtimeMs <= now + DSH_APPROVAL_FUTURE_TOLERANCE_MS ? resolved.mtimeMs : 0);
        decisions.set(data.id, { at: decisionAt, outcome: data.outcome });
        journal.lastTime = Math.max(journal.lastTime, decisionAt);
      } else if (event.type === 'tool/result') {
        results.add(data.message?.toolCallId || data.callId);
      } else if (event.type === 'tool/call' && data.name === 'ask_user_question' && data.callId) {
        // A question may remain in pendingCalls after its answer while the projection catches up.
        journal.nonRunningCalls.add(data.callId);
        if (!pastStep) {
          journal.hasQuestionCall = true;
          if (!journal.question && !results.has(data.callId)) {
            const args = tryParseJsonObject(data.arguments);
            journal.question = { at, questions: Array.isArray(args?.questions) ? args.questions : [] };
          }
        }
      } else if (event.type === 'approval/asked' && data.id) {
        journal.hadApproval = true;
        const decision = decisions.get(data.id);
        const denied = decision && decision.outcome !== 'allowed-once';
        if (!pastStep && denied) {
          journal.blockedAt = Math.max(journal.blockedAt, decision.at);
          if (!data.callId) journal.unattributedAt = Math.max(journal.unattributedAt, decision.at);
          if (!['rejected', 'cancelled', 'unavailable', 'denied', 'canceled', 'deny', 'expired'].includes(decision.outcome)) {
            this.logDshOnce(`outcome:${projSessionFile}:${data.id}`, 'DSH approval: unknown outcome; execution not confirmed.');
          }
        }
        if (pastStep || (data.callId && results.has(data.callId)) || denied) {
          if (data.callId) journal.nonRunningCalls.add(data.callId);
        } else if (decision) {
          if (data.callId) journal.resumedCalls.set(data.callId, Math.max(decision.at, journal.resumedCalls.get(data.callId) || 0));
        } else {
          // An outstanding request is not proof that its tool is executing, even after timeout.
          if (data.callId) journal.nonRunningCalls.add(data.callId);
          else journal.unattributedAt = Math.max(journal.unattributedAt, at);
          journal.approvals.push({
            at: rawAt, id: data.id, callId: data.callId, toolName: data.toolName, reason: finalizeTaskDetail(data.reason)
          });
        }
      }
    }
    return journal;
  }

  checkDshSingle(now, forcedFile = null, forcedMtime = 0, journal) {
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

    if (journal === undefined) journal = this.readDshLogState(latestFile, this.cachedDshJournal, undefined, now);
    if (
      !forcedFile
      && this.cachedDsh.file === latestFile
      && this.cachedDsh.mtime === latestMtime
      && this.cachedDshJournal === journal
      && (this.cachedDsh.approval ?? null) === findFreshDshApproval(journal, now)
      && !this.isPendingDshStepBoundary(this.cachedDsh.state, latestMtime, now)
    ) {
      return refreshDynamicState(this.cachedDsh.state, now, this.stallEnabled, this.stallMs);
    }

    this.cachedDshJournal = journal;
    try {
      const data = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
      const rows = data.record?.rows || {};

      const turnBoundary = rows.turnBoundary?.val;
      const sessionStats = rows.sessionStats?.val;
      const userQuestions = rows.userQuestions?.val;
      const todos = rows.todos?.val;

      const rawTitle = String(rows.title?.val || '').trim();
      let defaultTask = truncate(rawTitle);
      let rawTurnPrompt = '';
      const turns = rows.turnOutline?.val?.turns;
      const dshLastTurn = Number.isFinite(Number(turnBoundary?.lastTurn)) && Number(turnBoundary.lastTurn) > 0
        ? Number(turnBoundary.lastTurn)
        : 0;
      const dshTurnId = dshLastTurn > 0 ? `dsh-turn:${dshLastTurn}` : '';
      // The journal and the projection are persisted independently.
      if ((journal?.turnNum && journal.turnNum < dshLastTurn)
        || (journal && journal.lastSeq < Number(turnBoundary?.openTurnStartSeq || 0))
        || (journal && journal.lastSeq < Number(turnBoundary?.lastStepBoundary?.seq || 0))) journal = null;
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

      for (const request of journal?.approvals ?? []) {
        if (request.at > now + DSH_APPROVAL_FUTURE_TOLERANCE_MS) {
          const ahead = request.at - now;
          this.logDshOnce('approval-clock-skew', `DSH approval clock skew: request timestamp is ${ahead} ms ahead of local time.`);
        } else if (!isDshApprovalFresh(request.at, now)) {
          this.logDshOnce(`expired:${latestFile}:${request.id}`, 'DSH approval expired without fresh confirmation.');
        }
      }
      const approval = findFreshDshApproval(journal, now);
      if (approval) {
        const tool = cleanSummary(String(approval.toolName || '工具'));
        const res = { source: 'DSH', state: 'approval', task: truncate(`请求批准：${tool}`),
          taskDetail: buildDshContextDetail([approval.reason || tool]),
          at: approval.at,
          ...(journal.turnNum ? { turnId: `dsh-turn:${journal.turnNum}` } : {}) };
        this.cachedDsh = { file: latestFile, mtime: latestMtime, state: res, approval };
        return res;
      }
      const lastPendingApproval = journal?.approvals[0];
      const journalOutcome = journal?.outcome;
      const turnEnded = journalOutcome && (!dshLastTurn || journal.turnNum === dshLastTurn)
        && (journal.hadApproval || journalOutcome.reasonKind === 'interrupted');
      const activityAt = lastPendingApproval ? (journal.lastTime || latestMtime)
        : (journal?.hadApproval || turnEnded ? Math.max(latestMtime, journal.lastTime) : latestMtime);
      const projectedQuestions = userQuestions?.questions?.active;
      const question = journal?.question;
      if (!turnEnded && (question || (!journal?.hasQuestionCall && projectedQuestions?.length > 0))) {
        const qTexts = (question?.questions || projectedQuestions)
          .map(q => formatDetailFieldValue(q?.question || q?.prompt || q?.text || q?.title || q?.header))
          .filter(Boolean);
        const res = {
          source: 'DSH',
          state: 'waiting',
          task: todoTask || defaultTask || '等待主人答复选择题',
          taskDetail: buildDshContextDetail(qTexts),
          at: question?.at || latestMtime
        };
        this.cachedDsh = { file: latestFile, mtime: latestMtime, state: res };
        return res;
      }

      // Check pendingCalls (Issue 2: filter out raw call_ IDs)
      const calls = dshPendingCalls(rows).filter(call => !journal?.nonRunningCalls.has(call.id)
        && (!journal?.unattributedAt || dshCallTime(call.value) > journal.unattributedAt));
      if (journal && journal.lastTime >= latestMtime) {
        for (const [id, at] of journal.resumedCalls) {
          if (!journal.nonRunningCalls.has(id) && !calls.some(call => call.id === id)) calls.push({ id, value: at });
        }
      }
      if (calls.length && !turnEnded) {
        const firstPendingCall = calls[0].value;
        const toolName = firstPendingCall?.name || firstPendingCall?.toolName;
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
        const stamps = calls.map(({ id, value }) => {
          return journal?.resumedCalls.get(id) || dshCallTime(value);
        }).filter(Number.isFinite);
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
          inFlight: true,
          ...(dshTurnId ? { turnId: dshTurnId } : {})
        };
        this.cachedDsh = { file: latestFile, mtime: latestMtime, state: res };
        return res;
      }

      if (turnBoundary?.openTurnStartSeq != null && !turnEnded) {
        if (sessionStats?.openStep) {
          const requestAt = lastPendingApproval?.at || 0;
          const blockedAt = Math.max(journal?.blockedAt || 0,
            requestAt <= now + DSH_APPROVAL_FUTURE_TOLERANCE_MS ? requestAt : activityAt);
          const tokenAt = sessionStats.openStep.firstTokenTime;
          const isGenerating = blockedAt ? Number(tokenAt) > blockedAt : Boolean(tokenAt);
          const res = {
            source: 'DSH',
            state: isGenerating ? 'working' : 'thinking',
            task: finalTask || (isGenerating ? '正在生成回复…' : '正在思考梳理…'),
            taskDetail: buildDshContextDetail(),
            at: activityAt,
            ...(dshTurnId ? { turnId: dshTurnId } : {})
          };
          this.cachedDsh = { file: latestFile, mtime: latestMtime, state: res };
          return res;
        }
        const res = {
          source: 'DSH',
          state: 'thinking',
          task: finalTask || '正在整理思路…',
          taskDetail: buildDshContextDetail(),
          at: activityAt,
          ...(dshTurnId ? { turnId: dshTurnId } : {})
        };
        this.cachedDsh = { file: latestFile, mtime: latestMtime, state: res };
        return res;
      }

      if (turnBoundary?.lastStepBoundary?.kind === 'end' || turnEnded) {
        if (now - activityAt < TERMINAL_HOLD_MS) {
          const dshTurnCount = Array.isArray(turns) ? turns.length : 0;
          const targetTurn = dshLastTurn || dshTurnCount;
          const logOutcome = (!targetTurn || journal?.outcome?.turnNum === targetTurn) ? journal?.outcome : null;
          if (logOutcome) {
            const turnNum = logOutcome.turnNum || targetTurn;
            const resolvedTurnId = turnNum > 0
              ? `dsh-turn:${turnNum}`
              : `dsh-turn:s${logOutcome.startSeq ?? logOutcome.endSeq ?? latestMtime}`;
            const eventAt = Math.max(Number(logOutcome.endTimeMs) || 0, latestMtime);
            const turnStartedAtMs = logOutcome.turnStartedAtMs || 0;
            const outcomeMap = {
              completed: { state: 'success', task: finalTask || '会话已执行完成', outcome: 'completed', kind: 'dsh_turn_end', detailExtra: [] },
              interrupted: { state: 'idle', task: finalTask || '会话已中断', outcome: 'aborted', kind: 'dsh_turn_aborted', detailExtra: [] },
              error: {
                state: 'error',
                task: truncate(cleanSummary(logOutcome.errorMessage || finalTask || '执行遇到了问题') || '执行遇到了问题'),
                outcome: 'failed',
                kind: 'dsh_turn_error',
                detailExtra: logOutcome.errorMessage ? [logOutcome.errorMessage] : []
              }
            };
            const mapped = outcomeMap[logOutcome.reasonKind];
            if (mapped) {
              const res = {
                source: 'DSH',
                state: mapped.state,
                task: mapped.task,
                taskDetail: buildDshContextDetail(mapped.detailExtra),
                at: eventAt,
                ...(turnNum > 0 ? { turnId: resolvedTurnId } : {}),
                ...(turnStartedAtMs > 0 ? { turnStartedAtMs } : {}),
                completion: makeCompletion({
                  source: 'DSH',
                  turnId: resolvedTurnId,
                  kind: mapped.kind,
                  outcome: mapped.outcome,
                  strictTurnEnd: true,
                  eventAt,
                  turnStartedAtMs
                })
              };
              this.cachedDsh = { file: latestFile, mtime: latestMtime, state: res };
              return res;
            }
          }
          const res = {
            source: 'DSH',
            state: 'success',
            task: finalTask || '会话已执行完成',
            taskDetail: buildDshContextDetail(),
            at: latestMtime,
            completion: makeCompletion({
              source: 'DSH',
              turnId: `dsh-step:${dshTurnCount}:${latestMtime}`,
              kind: 'dsh_step_boundary',
              outcome: 'step_only',
              strictTurnEnd: false,
              eventAt: latestMtime
            })
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

  // AP02: 按原始提问时间实际删除已达上限的待答记录（普通提问/授权 5 分钟，handoff 15 分钟）
  pruneCodexPending(pending, now) {
    if (!pending || !Number.isFinite(now)) return;
    for (const [callId, p] of pending) {
      const maxAge = p?.kind === 'handoff' ? HANDOFF_MAX_AGE_MS : WAITING_MAX_AGE_MS;
      if (now - p.at >= maxAge) pending.delete(callId);
    }
  }

  codexPendingState(pending, now) {
    if (!pending) return null;
    this.pruneCodexPending(pending, now);
    const latest = [...pending.values()].filter(p => p.accepted).sort((a, b) => b.at - a.at)[0];
    if (!latest) return null;
    if (latest.kind === 'approval') {
      let task = '等待主人确认权限';
      if (latest.subKind === 'cua_elicit') {
        task = '等待浏览器权限确认（推断）';
      } else if (latest.guardianReview === true && now - latest.at < APPROVAL_INFER_DELAY_MS) {
        task = '自动审查中（等待确认）';
      }
      return {
        source: 'Codex', state: 'approval',
        task,
        taskDetail: latest.detail ?? null,
        kind: 'approval',
        at: latest.at, startedAt: latest.at, inFlight: true, fromPending: true
      };
    }
    if (latest.kind === 'handoff') {
      return {
        source: 'Codex', state: 'waiting',
        task: '等待主人接管浏览器验证',
        taskDetail: latest.detail ?? null,
        kind: 'handoff',
        at: latest.at, startedAt: latest.at, inFlight: true, fromPending: true
      };
    }
    return {
      source: 'Codex', state: 'waiting',
      task: '等待主人回答问题',
      taskDetail: latest.detail ?? null,
      kind: 'question',
      at: latest.at, startedAt: latest.at, inFlight: true, fromPending: true
    };
  }

  scanCodexAsyncPrompts(file, size, mtime, now = Date.now()) {
    let item = this.codexAsyncCache.get(file);
    if (!item) {
      item = { offset: 0, remainder: Buffer.alloc(0), pending: new Map(), guardianReviewer: false };
      this.codexAsyncCache.set(file, item);
    }
    if (size < item.offset) {
      item.offset = 0;
      item.remainder = Buffer.alloc(0);
      item.pending.clear();
      item.guardianReviewer = false;
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
          const handoff = item.pending.get('handoff');
          const hasHandoff = Boolean(handoff);
          const handoffCallId = handoff?.callId;
          if (!lineBytes.includes('request_user_input_async') &&
              !lineBytes.includes('request_permissions') &&
              !lineBytes.includes('require_escalated') &&
              !lineBytes.includes('send_user_message_question_reply') &&
              !lineBytes.includes('mcp__cua_repl') &&
              !lineBytes.includes('approvals_reviewer') &&
              !(handoffCallId && lineBytes.includes(handoffCallId)) &&
              !(hasHandoff && (
                lineBytes.includes('"role":"user"') ||
                lineBytes.includes('"role": "user"') ||
                lineBytes.includes('"role":"assistant"') ||
                lineBytes.includes('"role": "assistant"') ||
                lineBytes.includes('task_started') ||
                lineBytes.includes('turn_started') ||
                lineBytes.includes('turn_aborted') ||
                lineBytes.includes('task_complete') ||
                lineBytes.includes('turn_complete') ||
                lineBytes.includes('function_call') ||
                lineBytes.includes('custom_tool_call')
              )) &&
              ![...item.pending.keys()].some(id => id !== 'handoff' && lineBytes.includes(id))) continue;
          let entry;
          try { entry = JSON.parse(lineBytes.toString('utf8')); } catch { continue; }
          if (entry.type === 'turn_context') {
            if (entry.payload && typeof entry.payload.approvals_reviewer === 'string') {
              item.guardianReviewer = entry.payload.approvals_reviewer === 'guardian_subagent';
            }
            continue;
          }
          if (entry.type === 'event_msg') {
            const evKind = String(entry.payload?.type || '').toLowerCase();
            const evTs = Date.parse(entry.timestamp) || mtime;
            if (evKind === 'task_started' || evKind === 'turn_started' || evKind === 'turn_aborted') {
              const h = item.pending.get('handoff');
              if (h && evTs >= h.at) item.pending.delete('handoff');
            } else if (evKind === 'task_complete' || evKind === 'turn_complete') {
              const h = item.pending.get('handoff');
              if (h) {
                h.accepted = true;
                h.at = evTs;
              }
            }
            continue;
          }
          if (entry.type !== 'response_item') continue;
          const payload = entry.payload || {};
          if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
            const name = String(payload.name || payload.tool || '').split('.').pop();
            if (name === 'request_user_input_async' && payload.call_id) {
              if (item.pending.has('handoff')) item.pending.delete('handoff');
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
              if (item.pending.has('handoff')) item.pending.delete('handoff');
              const guardianReview = Boolean(
                item.guardianReviewer &&
                name === 'exec' &&
                !/\btools\.request_permissions\s*\(/.test(String(payload.input || ''))
              );
              item.pending.set(payload.call_id, {
                at: Date.parse(entry.timestamp) || mtime, accepted: true,
                kind: 'approval', guardianReview, questionCount: 1, answered: [],
                detail: extractCodexToolDetail(payload)
              });
            } else if (payload.call_id && isCuaReplCall(payload)) {
              const code = codexCuaCode(payload);
              if (CUA_HANDOFF_API.test(code)) {
                item.pending.set('handoff', {
                  at: Date.parse(entry.timestamp) || mtime,
                  callId: payload.call_id,
                  accepted: false,
                  kind: 'handoff',
                  questionCount: 1,
                  answered: [],
                  detail: cuaDetailText(code, [CUA_HANDOFF_API])
                });
              } else if (CUA_ELICIT_APIS.some(re => re.test(code))) {
                if (item.pending.has('handoff')) item.pending.delete('handoff');
                item.pending.set(payload.call_id, {
                  at: Date.parse(entry.timestamp) || mtime,
                  accepted: true,
                  kind: 'approval',
                  subKind: 'cua_elicit',
                  questionCount: 1,
                  answered: [],
                  detail: cuaDetailText(code, CUA_ELICIT_APIS)
                });
              } else if (item.pending.has('handoff')) {
                item.pending.delete('handoff');
              }
            } else if (item.pending.has('handoff')) {
              item.pending.delete('handoff');
            }
          } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
            const h = item.pending.get('handoff');
            if (h && h.callId === payload.call_id) {
              if (isCuaHandoffErrorOutput(payload)) {
                item.pending.delete('handoff');
              } else {
                h.accepted = true;
                h.at = Date.parse(entry.timestamp) || h.at || mtime;
              }
              continue;
            }
            if (!item.pending.has(payload.call_id)) continue;
            if (item.pending.get(payload.call_id).kind === 'approval') {
              item.pending.delete(payload.call_id);
              continue;
            }
            let output;
            try { output = typeof payload.output === 'string' ? JSON.parse(payload.output) : payload.output; } catch {}
            if (output?.accepted === true) item.pending.get(payload.call_id).accepted = true;
            else item.pending.delete(payload.call_id);
          } else if (payload.type === 'message') {
            if (payload.role === 'assistant') {
              const h = item.pending.get('handoff');
              if (!h) continue;
              const body = extractCodexMessageText(payload).trimStart();
              if (body) {
                const firstPara = body.split(/\r?\n[ \t]*\r?\n/)[0] || body;
                h.detail = finalizeTaskDetail(firstPara) || h.detail;
              }
              h.at = Date.parse(entry.timestamp) || h.at || mtime;
              if (String(payload.phase ?? '').trim().toLowerCase() === 'final_answer') {
                h.accepted = true;
              }
              continue;
            }
            if (payload.role !== 'user') continue;
            const body = extractCodexMessageText(payload);
            const h = item.pending.get('handoff');
            const msgTs = Date.parse(entry.timestamp) || mtime;
            if (h && msgTs >= h.at && isRealUserMessageText(body)) {
              item.pending.delete('handoff');
            }
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

  isGuardianRollout(file, size, mtime) {
    const cached = this.codexSubagentCache.get(file);
    if (cached && cached.size === size && cached.mtime === mtime) return cached.guardian;

    let guardian = false;
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const maxRead = Math.min(size, 512 * 1024);
      const step = 64 * 1024;
      const chunks = [];
      let offset = 0;
      let foundNl = false;
      while (offset < maxRead && !foundNl) {
        const want = Math.min(step, maxRead - offset);
        const buf = Buffer.allocUnsafe(want);
        const n = fs.readSync(fd, buf, 0, want, offset);
        if (!n) break;
        const nl = buf.indexOf(10);
        if (nl >= 0) {
          chunks.push(buf.subarray(0, nl));
          foundNl = true;
          break;
        }
        chunks.push(n < want ? buf.subarray(0, n) : buf);
        offset += n;
      }
      if (chunks.length > 0) {
        const firstLine = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(firstLine); } catch {}
        if (parsed && parsed.payload && typeof parsed.payload === 'object') {
          const src = parsed.payload.source;
          if (src && typeof src === 'object') {
            const sub = src.subagent;
            if (sub && typeof sub === 'object' && !sub.thread_spawn) {
              guardian = sub.other === 'guardian' || sub.kind === 'guardian' || sub.type === 'guardian';
            } else if (typeof sub === 'string') {
              guardian = sub.trim().toLowerCase() === 'guardian';
            }
          } else if (typeof src === 'string') {
            guardian = src.trim().toLowerCase() === 'guardian';
          }
        } else if (!/"thread_spawn"\s*:/.test(firstLine)) {
          // 降级路径（如首行超限被截断或非合法 JSON）：仅匹配精确 source.subagent 元数据，避免误删普通会话
          guardian = /"source"\s*:\s*\{\s*"subagent"\s*:\s*(?:\{\s*"other"\s*:\s*"guardian"\s*\}|"guardian")/.test(firstLine);
        }
      }
    } catch {} finally {
      if (fd !== null) try { fs.closeSync(fd); } catch {}
    }
    this.codexSubagentCache.set(file, { size, mtime, guardian });
    return guardian;
  }

  // AP06: 最终候选窗口保留显式传入的较大窗口（如离线额度回退的七天），
  // 未知 / handoff 候选保留 15 分钟窗口，其余等待 / 在飞候选保留 300 秒规则；普通工作扫描仍为 180 秒。
  codexCandidateWindow(c, maxAgeMs) {
    const cachedState = this.codexStateCache.get(c.file)?.state;
    const hasHandoff = cachedState?.kind === 'handoff' || this.codexAsyncCache.get(c.file)?.pending?.has('handoff');
    const stateWindow = (cachedState === undefined || hasHandoff)
      ? HANDOFF_MAX_AGE_MS
      : (isHeldState(cachedState) ? WAITING_MAX_AGE_MS : 0);
    return Math.max(maxAgeMs, stateWindow);
  }

  findCodexRollouts(now, maxAgeMs = ACTIVE_MAX_AGE_MS, opts = {}) {
    const excludeGuardian = opts.excludeGuardian === true;
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
        const hasHandoff = cachedState?.kind === 'handoff' || this.codexAsyncCache.get(c.file)?.pending?.has('handoff');
        const ageLimit = (cachedState === undefined || hasHandoff)
          ? HANDOFF_MAX_AGE_MS
          : (isHeldState(cachedState) ? WAITING_MAX_AGE_MS : ACTIVE_MAX_AGE_MS);
        if (now - c.mtime >= ageLimit) {
          refreshed.push(c);
          continue;
        }
        try {
          const st = fs.statSync(c.file);
          let eventTs = c.eventTs || 0;
          if (st.size !== c.size) eventTs = this.extractLastEventTimestamp(c.file, st.size) || eventTs;
          refreshed.push({ ...c, size: st.size, statMtime: st.mtimeMs, mtime: Math.max(st.mtimeMs, eventTs), eventTs });
        } catch {}
      }
      refreshed.sort((a, b) => b.mtime - a.mtime);
      this.codexRolloutCandidates = refreshed;
      return refreshed.filter(c =>
        (!excludeGuardian || !this.isGuardianRollout(c.file, c.size, c.statMtime ?? c.mtime)) &&
        (now - c.mtime < this.codexCandidateWindow(c, maxAgeMs))
      );
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
              files.push({ file: full, name: ent.name, statMtime: st.mtimeMs, mtime: st.mtimeMs, size: st.size });
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
      candidates.push({ file: cand.file, name: cand.name, statMtime: cand.statMtime, mtime: effTime, size: cand.size, eventTs: eventTs || effTime });
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    this.codexRolloutCandidates = candidates;
    const freshCandidates = candidates.filter(c =>
      (!excludeGuardian || !this.isGuardianRollout(c.file, c.size, c.statMtime ?? c.mtime)) &&
      (now - c.mtime < this.codexCandidateWindow(c, maxAgeMs))
    );
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
      const turnLifecycle = inspectCodexTurnLifecycle(lines);
      const isSupersededTerminal = (lineIdx, entryTs, anchor) => {
        if (anchor.turnStartedAtMs > 0 && entryTs > 0 && entryTs < anchor.turnStartedAtMs) {
          return true;
        }
        const openTurn = turnLifecycle.latestOpenTurn;
        if (!openTurn) return false;
        if (anchor.explicitTurnId && openTurn.turnId && anchor.explicitTurnId !== openTurn.turnId) {
          return true;
        }
        if (openTurn.ts > 0 && entryTs > 0 && entryTs < openTurn.ts) {
          return true;
        }
        if (openTurn.idx > lineIdx) {
          return true;
        }
        return false;
      };
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
            const parsedEntryTs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
            const entryTs = (Number.isFinite(parsedEntryTs) && parsedEntryTs > 0) ? parsedEntryTs : latestMtime;
            const anchor = resolveCodexTurnAnchor(lines, i, latestMtime);
            if (isSupersededTerminal(i, entryTs, anchor)) {
              continue;
            }
            if (now - latestMtime < TERMINAL_HOLD_MS) {
              const { turnId, turnStartedAtMs } = anchor;
              const pStatus = String(payload.status ?? payload.outcome ?? payload.result ?? '').trim().toLowerCase();
              const isAborted = kind === 'turn_aborted'
                || Boolean(payload.aborted || payload.cancelled || payload.canceled)
                || ['aborted', 'cancelled', 'canceled', 'interrupted'].includes(pStatus);
              const isFailed = !isAborted && (Boolean(payload.error || payload.is_error) || ['failed', 'error'].includes(pStatus));
              const outcome = isAborted ? 'aborted' : (isFailed ? 'failed' : 'completed');
              res = {
                source: 'Codex',
                state: isAborted ? 'idle' : (isFailed ? 'error' : 'success'),
                task: isAborted ? '任务已中止' : (isFailed ? '任务执行失败' : '任务已完成'),
                at: latestMtime,
                completion: makeCompletion({
                  source: 'Codex',
                  turnId,
                  kind,
                  outcome,
                  strictTurnEnd: true,
                  eventAt: entryTs,
                  turnStartedAtMs
                })
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
                const parsedEntryTs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
                const entryTs = (Number.isFinite(parsedEntryTs) && parsedEntryTs > 0) ? parsedEntryTs : latestMtime;
                const anchor = resolveCodexTurnAnchor(lines, i, latestMtime);
                if (isSupersededTerminal(i, entryTs, anchor)) {
                  continue;
                }
                if (now - latestMtime < TERMINAL_HOLD_MS) {
                  const { turnId, turnStartedAtMs } = anchor;
                  res = {
                    source: 'Codex',
                    state: 'success',
                    task: '回复已生成完毕',
                    taskDetail: null,
                    at: latestMtime,
                    completion: makeCompletion({
                      source: 'Codex',
                      turnId,
                      kind: 'final_answer',
                      outcome: 'step_only',
                      strictTurnEnd: false,
                      eventAt: entryTs,
                      turnStartedAtMs
                    })
                  };
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
                const parsedEntryTs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
                const entryTs = (Number.isFinite(parsedEntryTs) && parsedEntryTs > 0) ? parsedEntryTs : latestMtime;
                const anchor = resolveCodexTurnAnchor(lines, i, latestMtime);
                if (isSupersededTerminal(i, entryTs, anchor)) {
                  continue;
                }
                if (now - latestMtime < TERMINAL_HOLD_MS) {
                  const { turnId, turnStartedAtMs } = anchor;
                  res = {
                    source: 'Codex',
                    state: 'success',
                    task: '回复已生成完毕',
                    taskDetail: null,
                    at: latestMtime,
                    completion: makeCompletion({
                      source: 'Codex',
                      turnId,
                      kind: 'final_answer',
                      outcome: 'step_only',
                      strictTurnEnd: false,
                      eventAt: entryTs,
                      turnStartedAtMs
                    })
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
      if (res && !res.completion && turnLifecycle.latestOpenTurn) {
        if (turnLifecycle.activeTurnId) res.turnId = turnLifecycle.activeTurnId;
        if (turnLifecycle.activeTurnStartedAtMs > 0) res.turnStartedAtMs = turnLifecycle.activeTurnStartedAtMs;
      }
      this.codexStateCache.set(latestFile, { mtime: latestMtime, size: latestSize, state: res });
      return refreshDynamicState(res, now, this.stallEnabled, this.stallMs);
    } catch {}
    return null;
  }

  checkCodex(now) {
    // AP02: 已不在候选窗口内的会话也按原始时间清理过期待答记录，避免旧记录滞留内存
    for (const item of this.codexAsyncCache.values()) this.pruneCodexPending(item.pending, now);
    const candidates = this.findCodexRollouts(now, ACTIVE_MAX_AGE_MS, { excludeGuardian: true });
    if (!candidates.length) return null;

    const sessions = [];
    for (const candidate of candidates) {
      const state = this.parseCodexFile(candidate, now);
      if (state && isStateFresh(state, now)) {
        const rawId = path.basename(candidate.file);
        sessions.push(finalizeSessionCompletion({
          ...state,
          sessionId: rawId,
          rawId
        }, 'Codex', rawId));
      }
    }
    if (!sessions.length) return null;

    let best = null;
    for (const session of sessions) {
      best = this.selectBest(best, session, now);
    }
    if (!best) return null;

    best.rawId = best.rawId || best.sessionId;
    best = finalizeSessionCompletion(best, 'Codex', best.rawId);
    // Keep the selected session as the primary Codex state while exposing
    // every active Codex session for diagnostics and future UI expansion.
    best.sessions = sessions.map(s => ({
      sessionId: truncate(s.task || s.sessionId, 36) || s.sessionId,
      rawId: s.rawId || s.sessionId,
      sessionKey: `Codex|${s.rawId || s.sessionId}`,
      source: 'Codex',
      state: s.state,
      task: s.task,
      at: s.at,
      ...(s.turnId ? { turnId: s.turnId } : {}),
      ...(s.turnStartedAtMs > 0 ? { turnStartedAtMs: s.turnStartedAtMs } : {}),
      ...(s.completion ? { completion: s.completion } : {})
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

export { AgentMonitor, parseCodexRateLimits, atomicWriteJson, writeJsonWithRetry, flushPendingWrites, dispatchRuntimeWrite, pendingWrites, isStateFresh, refreshDynamicState, isHeldState, finalizeTaskDetail, redactDetailSecrets, DETAIL_MAX_CODE_POINTS, DETAIL_TRUNCATE_SUFFIX, makeCompletion, finalizeSessionCompletion };
