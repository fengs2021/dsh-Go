// 把 hdc shell 与 uitest 封装成 DSH 手机工具：真正能点屏、滑动、打字、读界面树的自动化。
import fs from 'node:fs';
import path from 'node:path';
import { getLink, diagnoseHdc } from './hdc-link.mjs';

const TMP = '/data/local/tmp';
const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
// 截图必须落在会话工作区里：模型的 fs 工具（read_image）只读得到工作区，
// 只有让它能"看见"屏幕，才能在拿不到无障碍节点的 Android 容器/游戏界面上按坐标点击。
// 截图必须落在**本会话的工作区**里：模型的 read_image 只读得到工作区，而引擎进程的 cwd
// 可能是沙箱根 /（不可写）。调用方把 session.header.cwd 传进来，缺失时才退回 process.cwd()。
export function resolveShotDir(workspace) {
  const base = typeof workspace === 'string' && workspace.startsWith('/') ? workspace : process.cwd();
  return path.join(base, 'phone-shots');
}
const shotDir = (context = {}) => resolveShotDir(context.workspace);
const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];

export async function shText(command, timeoutMs = 30000) {
  const out = await getLink().exec('( ' + command + ' ) 2>&1; echo "__DSH_RC=$?"', timeoutMs);
  const match = out.match(/__DSH_RC=(\d+)\s*$/);
  const code = match ? Number(match[1]) : -1;
  const body = match ? out.slice(0, match.index) : out;
  return { code, text: body.replace(/\r\n/g, '\n') };
}

// uitest uiInput 即使内部报错也会返回退出码 0，唯一可信的成功信号是 stdout 恰好为 No Error
// （ui_input.cpp 对 ApiCallErr 也返回 EXIT_SUCCESS）。输入类动作统一走这里，避免把失败报成成功。
async function uiCommand(command, timeoutMs = 30000) {
  const run = await shText(command, timeoutMs);
  if (run.code !== 0) return { ok: false, text: run.text.trim() || ('退出码 ' + run.code) };
  const body = run.text.trim();
  if (body !== 'No Error') return { ok: false, text: body || '(没有返回 No Error)' };
  return { ok: true, text: body };
}

const parseBounds = (bounds) => {
  const m = /^\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]$/.exec(String(bounds || '').trim());
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  // 零宽/零高或反向的节点在屏幕上没有可点区域，点它只会点到左上角，必须丢弃。
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
};

// 按文字挑控件：先精确、再包含、最后按 id 包含。
const pickTarget = (nodes, needle) => nodes.find((n) => n.label === needle && n.bounds)
  || nodes.find((n) => n.label.includes(needle) && n.bounds)
  || nodes.find((n) => (n.id || '').includes(needle) && n.bounds)
  || null;

export function collectNodes(root) {
  const nodes = [];
  let screen = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const a = node.attributes || {};
    const bounds = parseBounds(a.bounds);
    if (!screen && bounds && bounds.x2 - bounds.x1 > 200) screen = bounds;
    const label = String(a.text || a.hint || a.accessibilityText || a.description || a.originalText || '').trim();
    const clickable = a.clickable === 'true';
    if (label || clickable || a.focused === 'true') {
      nodes.push({ type: String(a.type || ''), label, clickable, focused: a.focused === 'true', editable: /input|textarea|search|edit/i.test(String(a.type || '')),
        id: String(a.id || a.key || ''), bundle: String(a.bundleName || ''), bounds, raw: a.bounds });
    }
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return { nodes, screen };
}

export async function dumpUi(timeoutMs = 20000) {
  const file = TMP + '/dsh-ui-' + Date.now() + '.json';
  const result = await shText('uitest dumpLayout -p ' + file, timeoutMs);
  // dumpLayout 失败时同样可能返回退出码 0，只能靠它自己的文案判断。
  const failed = /^\s*DumpLayout failed:/m.test(result.text || '');
  let buffer;
  try {
    if (result.code !== 0 || failed) throw new Error('dumpLayout 失败：' + (result.text.trim().slice(0, 300) || '无输出'));
    buffer = await getLink().execBuffer('cat ' + file + '; rm -f ' + file, timeoutMs);
  } catch (error) {
    try { await getLink().exec('rm -f ' + file, 5000); } catch { /* 清理失败不影响主错误 */ }
    throw error;
  }
  const body = buffer.toString('utf8').trim();
  if (!body.startsWith('{') && !body.startsWith('[')) throw new Error('dumpLayout 输出不是 JSON：' + body.slice(0, 200));
  return collectNodes(JSON.parse(body));
}

const describe = (node, index) => (index + 1) + '. ' + (node.label ? JSON.stringify(node.label) : '(无文字' + (node.id ? ':' + node.id : '') + ')') +
  ' · ' + (node.type || '?') + (node.clickable ? ' · 可点击' : '') + (node.editable ? ' · 可输入' : '') +
  (node.bounds ? ' · 中心 ' + node.bounds.cx + ',' + node.bounds.cy : '');

const result = (ok, code, message, data, dispatched = false) => ({ ok, code, message, data: data ?? '', dispatched });
const schema = { type: 'object', additionalProperties: false,
  properties: { ok: { type: 'boolean' }, code: { type: 'string' }, message: { type: 'string' }, data: { type: 'string' },
    dispatched: { type: 'boolean', description: '命令是否已经发到手机上（true 时动作可能已经生效，不能直接重试）' } },
  required: ['ok', 'code', 'message', 'data'] };

// 三态结果，与上游 phone 队列同一口径：成功 / 一定没发生（可安全重试）/ 已发出但结果未知
// （不要重试，先看现场）。第三态存在的原因很实在——点按和输入重试一次就是真的多按一下。
const UNKNOWN_HINT = '命令已发出但没有拿到结束回执，动作可能已经生效：不要直接重试，先用 action=dump 或 action=shot 确认现场再决定。';
export const classifyFailure = (error) => {
  const message = String((error && error.message) || error).slice(0, 500);
  const nonce = error && error.executionNonce ? '（执行 nonce ' + error.executionNonce + '）' : '';
  if (error && error.hdcPhase === 'dispatched') return { ok: false, code: 'outcome_unknown', dispatched: true, message: message + ' · ' + UNKNOWN_HINT + nonce };
  return { ok: false, code: 'failed', dispatched: false, message: message + nonce };
};

// 只读 native 快照（不 claim、不阻塞）：给「结果未知」留下当时的现场依据。
// 不套 native permit 是刻意的——hdc 通道的价值恰恰在于不依赖 App 在前台。
export function readNativeSnapshot(bindingOf = () => process._linkedBinding && process._linkedBinding('dsh_ohos_publication')) {
  try {
    const binding = bindingOf();
    const snapshot = binding && typeof binding.getPhoneSnapshot === 'function' ? binding.getPhoneSnapshot() : null;
    if (!snapshot || typeof snapshot !== 'object') return null;
    return { available: snapshot.available === true, foreground: snapshot.foreground === true,
      engineId: typeof snapshot.engineId === 'string' ? snapshot.engineId : '',
      bridgeGeneration: Number.isSafeInteger(snapshot.bridgeGeneration) ? snapshot.bridgeGeneration : 0 };
  } catch { return null; }
}
const nativeHint = () => {
  const snapshot = readNativeSnapshot();
  if (!snapshot) return '';
  return '\n本机当时：DSH ' + (snapshot.foreground ? '在前台' : '不在前台') + '，引擎 ' + (snapshot.engineId || '未知') +
    (snapshot.bridgeGeneration ? ' 第 ' + snapshot.bridgeGeneration + ' 代' : '') + (snapshot.available ? '' : '，phone 回调不可用');
};
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

async function uiDump(args) {
  const { nodes, screen } = await dumpUi();
  const filter = typeof args.filter === 'string' && args.filter.trim() ? args.filter.trim() : '';
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(400, args.limit)) : 150;
  const ordered = nodes.slice().sort((a, b) => Number(Boolean(b.label)) - Number(Boolean(a.label)));
  const matched = filter ? ordered.filter((n) => (n.label || '').includes(filter) || n.type.includes(filter) || n.id.includes(filter)) : ordered;
  const shown = matched.slice(0, limit);
  const labeled = nodes.filter((node) => node.label).length;
  const head = '屏幕 ' + (screen ? screen.x2 + 'x' + screen.y2 : '?') + ' · 控件 ' + nodes.length + ' 个' +
    (filter ? ' · 匹配 ' + matched.length + ' 个' : '');
  if (labeled === 0) {
    return result(true, 'no_nodes',
      '这个界面没有可读的无障碍节点（典型的 Android 容器、游戏、自绘界面）。改用 action=shot 截图，再用 read_image 读 phone-shots/ 下的文件看屏幕，按像素坐标 click。',
      head);
  }
  const lines = shown.map((node, index) => describe(node, index));
  if (matched.length > shown.length) lines.push('… 还有 ' + (matched.length - shown.length) + ' 个，用 filter 缩小范围');
  return result(true, 'ok', '界面树已读取', head + '\n' + lines.join('\n'));
}

async function uiClick(args) {
  let x = args.x, y = args.y;
  if (!(Number.isFinite(x) && Number.isFinite(y))) {
    const needle = typeof args.text === 'string' ? args.text.trim() : '';
    if (!needle) return result(false, 'invalid_args', 'click 需要 x/y 坐标，或 text 指定要点的文字', '');
    // 「等它出现再点」一步完成：省掉「dump → 判断 → 再 dump」的往返。
    const budget = Number.isFinite(args.waitMs) ? Math.max(0, Math.min(20000, args.waitMs)) : 0;
    const deadline = Date.now() + budget;
    let loose = null;
    for (;;) {
      const { nodes } = await dumpUi();
      loose = pickTarget(nodes, needle);
      if (loose || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    if (!loose) return result(false, 'not_found', '界面上没找到「' + needle + '」', '');
    x = loose.bounds.cx; y = loose.bounds.cy;
  }
  const run = await uiCommand('uitest uiInput click ' + Math.round(x) + ' ' + Math.round(y));
  if (!run.ok) return result(false, 'click_failed', run.text.slice(0, 300), '');
  return result(true, 'ok', '已点击 ' + Math.round(x) + ',' + Math.round(y), '');
}

async function uiLongClick(args) {
  let x = args.x, y = args.y;
  if (!(Number.isFinite(x) && Number.isFinite(y))) {
    const needle = typeof args.text === 'string' ? args.text.trim() : '';
    if (!needle) return result(false, 'invalid_args', 'longclick 需要 x/y 坐标，或 text 指定控件文字', '');
    const { nodes } = await dumpUi();
    const target = pickTarget(nodes, needle);
    if (!target) return result(false, 'not_found', '界面上没找到「' + needle + '」', '');
    x = target.bounds.cx; y = target.bounds.cy;
  }
  const run = await uiCommand('uitest uiInput longClick ' + Math.round(x) + ' ' + Math.round(y));
  if (!run.ok) return result(false, 'longclick_failed', run.text.slice(0, 300), '');
  return result(true, 'ok', '已长按 ' + Math.round(x) + ',' + Math.round(y), '');
}

async function uiInput(args) {
  const value = typeof args.text === 'string' ? args.text : '';
  if (!value) return result(false, 'invalid_args', 'input 需要 text', '');
  let x = args.x, y = args.y;
  if (!(Number.isFinite(x) && Number.isFinite(y))) {
    const { nodes } = await dumpUi();
    const field = nodes.find((n) => n.editable && n.bounds && n.bounds.y2 > 0) || nodes.find((n) => n.focused && n.bounds);
    if (!field) return result(false, 'not_found', '没找到可输入的输入框，请先 click 目标输入框再用 x/y 指定', '');
    x = field.bounds.cx; y = field.bounds.cy;
  }
  const tap = await uiCommand('uitest uiInput click ' + Math.round(x) + ' ' + Math.round(y));
  if (!tap.ok) return result(false, 'click_failed', tap.text.slice(0, 300), '');
  const run = await uiCommand('uitest uiInput inputText ' + Math.round(x) + ' ' + Math.round(y) + ' ' + shellQuote(value));
  if (!run.ok) return result(false, 'input_failed', run.text.slice(0, 300), '');
  return result(true, 'ok', '已在 ' + Math.round(x) + ',' + Math.round(y) + ' 输入 ' + value.length + ' 个字符', '');
}

async function uiSwipe(args) {
  const nums = [args.x1, args.y1, args.x2, args.y2].map(Number);
  if (!nums.every(Number.isFinite)) return result(false, 'invalid_args', 'swipe 需要 x1/y1/x2/y2', '');
  const speed = Number.isFinite(args.speed) ? Math.round(args.speed) : 600;
  const run = await uiCommand('uitest uiInput swipe ' + nums.map((n) => Math.round(n)).join(' ') + ' ' + speed);
  if (!run.ok) return result(false, 'swipe_failed', run.text.slice(0, 300), '');
  return result(true, 'ok', '已滑动', '');
}

async function uiKey(args) {
  const key = typeof args.key === 'string' && args.key.trim() ? args.key.trim() : 'Back';
  const run = await uiCommand('uitest uiInput keyEvent ' + shellQuote(key));
  if (!run.ok) return result(false, 'key_failed', run.text.slice(0, 300), '');
  return result(true, 'ok', '已发送按键 ' + key, '');
}

async function uiShot(args = {}, context = {}) {
  const file = TMP + '/dsh-shot-' + Date.now() + '.jpeg';
  const run = await shText('snapshot_display -f ' + file, 25000);
  if (run.code !== 0) return result(false, 'shot_failed', run.text.trim().slice(0, 300), '');
  const buffer = await getLink().execBuffer('cat ' + file + '; rm -f ' + file, 30000);
  if (buffer.length < 1000 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return result(false, 'shot_failed', '截图数据异常（' + buffer.length + ' 字节）', '');
  }
  const dir = shotDir(context);
  const name = 'shot-' + Date.now() + '.jpg';
  const target = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, buffer);
    try { fs.chmodSync(target, 0o644); } catch { /* 只读挂载时忽略 */ }
  } catch (error) {
    return result(false, 'shot_failed',
      '截图拿到了 ' + buffer.length + ' 字节，但写不进工作区 ' + dir + '：' + ((error && error.message) || error), '');
  }
  return result(true, 'ok', '截图已保存到工作区，用 read_image 读取即可看见屏幕', path.relative(context.workspace || process.cwd(), target) + ' (' + buffer.length + ' 字节)');
}

async function uiWait(args) {
  const ms = Number.isFinite(args.ms) ? Math.max(0, Math.min(15000, args.ms)) : 1000;
  await new Promise((resolve) => setTimeout(resolve, ms));
  return result(true, 'ok', '已等待 ' + ms + 'ms', '');
}

// 一串动作一次发完：打开设置 → 找到那一项 → 点进去 → 读回来，本来要五六次工具往返。
// 每步都用上面同一套动作函数（同一套成功口径），不做任何"新命令"，只是把它们顺序串起来。
const SCRIPT_MAX_STEPS = 20;
const SCRIPT_EFFECTS = new Set(['click', 'longclick', 'input', 'swipe', 'key']);
// 真正的执行体与动作表解耦：单测可以用假动作跑完整条链路，不需要真机。
export async function runScript(steps, actions, effects = SCRIPT_EFFECTS) {
  if (!Array.isArray(steps) || steps.length === 0) return result(false, 'invalid_args', 'script 需要 steps 数组，每步形如 {"action":"click","text":"设置"}', '');
  if (steps.length > SCRIPT_MAX_STEPS) return result(false, 'invalid_args', 'script 最多 ' + SCRIPT_MAX_STEPS + ' 步，请拆成几次调用', '');
  const lines = [];
  let dispatched = false;
  for (const [index, step] of steps.entries()) {
    const no = index + 1;
    if (!step || typeof step !== 'object' || Array.isArray(step)) return result(false, 'invalid_args', '第 ' + no + ' 步不是对象', lines.join('\n'), dispatched);
    const action = String(step.action || '');
    // 嵌套会把"几步"变成不可预测的树，直接拒绝：要长序列就多调几次。
    if (action === 'script') return result(false, 'invalid_args', 'script 不能嵌套 script', lines.join('\n'), dispatched);
    const handler = Object.hasOwn(actions, action) ? actions[action] : null;
    if (!handler) return result(false, 'invalid_args', '第 ' + no + ' 步的 action 不支持：' + (action || '(空)'), lines.join('\n'), dispatched);
    let outcome;
    try { outcome = await handler(step); }
    catch (error) {
      const failure = classifyFailure(error);
      return result(false, failure.code, '第 ' + no + ' 步 ' + action + ' 出错：' + failure.message, lines.join('\n'), dispatched || failure.dispatched);
    }
    if (outcome.ok && effects.has(action)) dispatched = true;
    const detail = String(outcome.message || '').replace(/\s+/g, ' ').trim().slice(0, 160) +
      (outcome.data ? ' · ' + String(outcome.data).replace(/\s+/g, ' ').trim().slice(0, 240) : '');
    lines.push(no + '. ' + action + ' · ' + (outcome.ok ? 'ok' : outcome.code) + ' · ' + detail);
    if (!outcome.ok) return result(false, outcome.code, '第 ' + no + ' 步 ' + action + ' 失败：' + outcome.message, lines.join('\n'), dispatched || outcome.dispatched === true);
  }
  return result(true, 'ok', '已按顺序执行 ' + steps.length + ' 步', lines.join('\n'), dispatched);
}

const UI_ACTIONS = ['dump', 'click', 'longclick', 'input', 'swipe', 'key', 'shot', 'wait', 'script'];
// 动作表每次按上下文生成：只有 shot 需要知道工作区在哪（script 里套 shot 也一样）。
function uiActions(context = {}) {
  return { dump: uiDump, click: uiClick, longclick: uiLongClick, input: uiInput, swipe: uiSwipe, key: uiKey,
    shot: (args) => uiShot(args, context), wait: uiWait, script: (args) => runScript(args.steps, uiActions(context)) };
}

async function appAction(args) {
  const action = String(args.action || 'list');
  if (action === 'list') {
    const run = await shText('bm dump -a', 40000);
    if (run.code !== 0) return result(false, 'list_failed', run.text.trim().slice(0, 300), '');
    const names = run.text.split('\n').map((line) => line.trim()).filter((line) => /^[\w.]+\.[\w.]+$/.test(line));
    return result(true, 'ok', '已安装 ' + names.length + ' 个应用', names.join('\n'));
  }
  const app = typeof args.app === 'string' ? args.app.trim() : '';
  if (!app) return result(false, 'invalid_args', action + ' 需要 app（包名）', '');
  if (action === 'stop') {
    const run = await shText('aa force-stop ' + shellQuote(app));
    return run.code === 0 ? result(true, 'ok', '已停止 ' + app, run.text.trim()) : result(false, 'stop_failed', run.text.trim().slice(0, 300), '');
  }
  if (action === 'launch') {
    const info = await shText('bm dump -n ' + shellQuote(app), 30000);
    const ability = (/"mainElementName"\s*:\s*"([^"]+)"/.exec(info.text) || [])[1] || 'EntryAbility';
    const run = await shText('aa start -b ' + shellQuote(app) + ' -a ' + shellQuote(ability), 30000);
    if (run.code !== 0 || /error/i.test(run.text)) return result(false, 'launch_failed', ('启动 ' + app + '/' + ability + ' 失败：' + run.text).trim().slice(0, 300), '');
    return result(true, 'ok', '已启动 ' + app + '（' + ability + '）', run.text.trim());
  }
  if (action === 'current') {
    // 抓前台 Ability 记录（含 want 参数线索）：用来把一个"只能手点"的容器内应用，
    // 变成可以 replay 的启动参数。
    const run = await shText('aa dump -a 2>&1', 40000);
    if (run.code !== 0) return result(false, 'current_failed', run.text.trim().slice(0, 300), '');
    const blocks = run.text.split(/AbilityRecord ID/).map((block) => block.trim()).filter(Boolean);
    const foreground = blocks.filter((block) => /state #FOREGROUND/.test(block) && !/^#?\s*app state #FOREGROUND\s*$/m.test(block.split('\n')[0] || ''));
    const picked = blocks.filter((block) => /\n\s*state #FOREGROUND/.test(block)).pop()
      || foreground.pop()
      || blocks.filter((block) => /state #FOREGROUND/.test(block)).pop();
    if (!picked) return result(false, 'not_found', '没找到前台 Ability 记录', run.text.trim().slice(0, 800));
    const field = (name) => (new RegExp(name + ' \\[([^\\]]+)\\]').exec(picked) || [])[1] || '';
    const bundle = field('bundle name');
    const ability = field('main name');
    return result(true, 'ok', '前台：' + bundle + '/' + ability, picked.slice(0, 3000));
  }
  if (action === 'abilities') {
    const run = await shText('bm dump -n ' + shellQuote(app) + ' -a 2>&1', 40000);
    if (run.code !== 0) return result(false, 'abilities_failed', run.text.trim().slice(0, 300), '');
    return result(true, 'ok', '已读取 ' + app + ' 的 ability 清单', run.text.trim().slice(0, 8000));
  }
  return result(false, 'invalid_args', 'app.action 只支持 launch/stop/list/current/abilities', '');
}

const definitions = [
  { name: 'mcp__phone__shell',
    description: '以调试 shell 身份（uid 2000）在手机上执行一条 shell 命令并返回输出。这是本机 DSH 唯一的真实系统入口：可跑 uitest、aa、bm、ls、ps、cat 等 /system/bin 工具。首次使用时手机会弹「是否信任此设备」，点「始终允许」后永久生效。拒绝执行会改动系统分区的危险命令。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      command: str('要执行的 shell 命令，例如 id 或 ls /data/local/tmp'),
      timeoutMs: num('超时毫秒，默认 30000') }, required: ['command'] },
    run: async (args) => {
      const run = await shText(String(args.command), Number.isFinite(args.timeoutMs) ? args.timeoutMs : 30000);
      return result(run.code === 0, run.code === 0 ? 'ok' : 'exit_' + run.code, run.text.trim().slice(0, 6000), run.text.trim().slice(0, 12000));
    } },
  { name: 'mcp__phone__ui',
    description: '直接操作用户的手机界面：dump 读取当前屏幕控件树（含中心坐标），click 点按（坐标或按文字，可带 waitMs 等文字出现再点），longclick 长按，input 输入文字，swipe 滑动，key 发按键（Back/Home/Power），shot 截图存档，wait 等待，script 按顺序执行多步。可用来操作任意第三方 App。坐标是手机像素，dump 返回的「中心 x,y」可直接用于 click；每个动作用 uitest 的 No Error 回执确认真实生效，失败会返回错误而不是静默成功。要连做好几步（进设置→找那一项→点进去→读回来）时用 script 一次发完，比一步步往返快得多；script 遇到第一个失败就停，并回报已完成的步骤。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['dump', 'click', 'longclick', 'input', 'swipe', 'key', 'shot', 'wait', 'script'], description: '要做的动作' },
      text: str('click 用它按文字找控件；input 用它作为要输入的文字'),
      filter: str('dump 时只保留包含该子串的控件'), limit: num('dump 最多列出多少个控件，默认 150'),
      x: num('点击/输入的 x 坐标'), y: num('点击/输入的 y 坐标'),
      x1: num('滑动起点 x'), y1: num('滑动起点 y'), x2: num('滑动终点 x'), y2: num('滑动终点 y'),
      speed: num('滑动速度，默认 600'), key: str('键名：Back/Home/Power 等'), ms: num('wait 毫秒'),
      waitMs: num('click 用文字定位时，最多等多少毫秒让它出现（默认 0 只查一次），例如 8000'),
      steps: { type: 'array', description: 'script 用：按顺序执行的动作数组，最多 20 步，每步和单独调用时同样的参数，例如 [{"action":"click","text":"设置"},{"action":"wait","ms":800},{"action":"dump","filter":"Linux"}]', items: { type: 'object' } } },
      required: ['action'] },
    run: async (args, context) => {
      const action = String(args.action || '');
      const handler = uiActions(context)[action];
      if (!handler) return result(false, 'invalid_args', 'action 只支持 ' + UI_ACTIONS.join('/'), '');
      return handler(args);
    } },
  { name: 'mcp__phone__hdc',
    description: '检查手机调试通道（HDC）为什么不通：无线调试端口、当前使用的密钥来源（随包内置 / 用户自备 / 自动生成）与公钥指纹、鉴权是否成功，并给出该让用户做哪几步。手机工具报鉴权超时、或换了别人的手机使用时先用它自检。只读，不改任何设置。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    run: async () => {
      const report = await diagnoseHdc();
      const head = report.auth.ok
        ? '调试通道可用：端口 ' + report.auth.port + '，密钥来源 ' + report.key.source + '，指纹 ' + report.key.fingerprint
        : '调试通道不可用：' + (report.auth.error || '未知原因');
      const lines = [head, '密钥文件：' + report.key.path, '无线调试端口：' + (report.wirelessDebugging.discoveredPorts.join(',') || '未发现')];
      for (const hint of report.hints) lines.push('· ' + hint);
      lines.push(nativeHint() || '本机当时：拿不到 native 快照（不在鸿蒙宿主里运行）');
      return result(report.auth.ok, report.auth.ok ? 'ok' : 'hdc_unavailable', lines.join('\n'), report);
    } },
  { name: 'mcp__phone__app',
    description: '管理手机应用：list 列出已安装包名；launch 用包名把应用拉到前台（走 aa start，不依赖桌面入口）；stop 强制停止应用；current 抓当前前台 Ability 记录（含 want 参数线索，用来把只能手点的容器应用变成可 replay 的启动参数）；abilities 列出某个包的 ability/extension（bm dump -n <pkg> -a）。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['list', 'launch', 'stop', 'current', 'abilities'], description: '动作：list/launch/stop/current(抓前台 Ability 及其 want)/abilities(列某包的 ability)' },
      app: str('包名，例如 com.tencent.mqq') }, required: ['action'] },
    run: appAction },
];

export const phoneUiCatalog = Object.freeze(definitions.map(({ name, description, parameters }) => ({ name, description, parameters })));

// 与上游 phone 工具同一套口径：默认走会话审批策略，只有 `never` 或 auto 预设才不打扰。
const asked = {
  mcp__phone__shell: ['执行手机 shell 命令', 'Run a phone shell command'],
  mcp__phone__ui: ['操作手机界面', 'Operate the phone screen'],
  mcp__phone__app: ['启停手机应用', 'Start or stop a phone app'],
};
const describeCall = (name, args) => {
  if (name === 'mcp__phone__shell') return String(args?.command || '').slice(0, 200);
  if (name === 'mcp__phone__ui') {
    const action = String(args?.action || '');
    const parts = [action];
    if (typeof args?.text === 'string' && args.text) parts.push(args.text);
    if (Number.isFinite(args?.x) && Number.isFinite(args?.y)) parts.push(args.x + ',' + args.y);
    if (Number.isFinite(args?.x1) && Number.isFinite(args?.y2)) parts.push(args.x1 + ',' + args.y1 + '→' + args.x2 + ',' + args.y2);
    // script 的审批弹窗必须能看出"要连点哪几步"，否则用户只看到 script 两个字就要点同意。
    if (Array.isArray(args?.steps)) parts.push(args.steps.length + ' 步：' + args.steps.map((step) => String(step?.action || '?')).join('→'));
    return parts.join(' · ').slice(0, 200);
  }
  if (name === 'mcp__phone__app') return [String(args?.action || ''), String(args?.app || '')].filter(Boolean).join(' · ');
  return '';
};
function askBeforeRunning(ctx) {
  return ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    const [zh, en] = asked[exec.name] ?? [];
    const session = exec.agent?.session, approval = ctx.get('approval');
    if (decision.kind !== 'allow' || !zh || !session || !approval) return decision;
    if (approval.effectivePolicy(session) === 'never' || ctx.get('permissionPresets')?.current(session) === 'auto') return decision;
    const what = describeCall(exec.name, exec.arguments);
    return { kind: 'ask', reason: `Phone action ${exec.name}: ${what}`,
      displayReason: { zh: what ? `${zh}：${what}` : zh, en: what ? `${en}: ${what}` : en } };
  });
}

// 工具的 execute 拿得到真实会话：session.header.cwd 就是这个会话的工作区。
export function sessionWorkspace(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : undefined;
}

export function registerUiTools(ctx) {
  const disposers = [];
  disposers.push(askBeforeRunning(ctx));
  try {
    for (const definition of definitions) {
      disposers.push(ctx.tools.register({
        name: definition.name, description: definition.description, parameters: definition.parameters,
        timeoutMs: 120000,
        output: { schema, render: (_args, value) => text(value) },
        async execute(args, exec) {
          try { return await definition.run(args || {}, { workspace: sessionWorkspace(exec) }); }
          catch (error) {
            const outcome = classifyFailure(error);
            return result(outcome.ok, outcome.code, outcome.message + (outcome.dispatched ? nativeHint() : ''), '', outcome.dispatched);
          }
        },
      }));
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
