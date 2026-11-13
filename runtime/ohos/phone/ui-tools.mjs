// 把 hdc shell 与 uitest 封装成 DSH 手机工具：真正能点屏、滑动、打字、读界面树的自动化。
import fs from 'node:fs';
import path from 'node:path';
import { getLink } from './hdc-link.mjs';

const TMP = '/data/local/tmp';
const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
// 截图必须落在会话工作区里：模型的 fs 工具（read_image）只读得到工作区，
// 只有让它能"看见"屏幕，才能在拿不到无障碍节点的 Android 容器/游戏界面上按坐标点击。
const shotDir = () => path.join(process.cwd(), 'phone-shots');
const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];

export async function shText(command, timeoutMs = 30000) {
  const out = await getLink().exec('( ' + command + ' ) 2>&1; echo "__DSH_RC=$?"', timeoutMs);
  const match = out.match(/__DSH_RC=(\d+)\s*$/);
  const code = match ? Number(match[1]) : -1;
  const body = match ? out.slice(0, match.index) : out;
  return { code, text: body.replace(/\r\n/g, '\n') };
}

const parseBounds = (bounds) => {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(bounds || '');
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
};

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
  if (result.code !== 0) throw new Error('dumpLayout 失败：' + result.text.trim().slice(0, 300));
  const buffer = await getLink().execBuffer('cat ' + file + '; rm -f ' + file, timeoutMs);
  const parsed = JSON.parse(buffer.toString('utf8'));
  return collectNodes(parsed);
}

const describe = (node, index) => (index + 1) + '. ' + (node.label ? JSON.stringify(node.label) : '(无文字' + (node.id ? ':' + node.id : '') + ')') +
  ' · ' + (node.type || '?') + (node.clickable ? ' · 可点击' : '') + (node.editable ? ' · 可输入' : '') +
  (node.bounds ? ' · 中心 ' + node.bounds.cx + ',' + node.bounds.cy : '');

const result = (ok, code, message, data) => ({ ok, code, message, data: data ?? '' });
const schema = { type: 'object', additionalProperties: false,
  properties: { ok: { type: 'boolean' }, code: { type: 'string' }, message: { type: 'string' }, data: { type: 'string' } },
  required: ['ok', 'code', 'message', 'data'] };
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
    const { nodes } = await dumpUi();
    const exact = nodes.find((n) => n.label === needle && n.bounds);
    const loose = exact || nodes.find((n) => n.label.includes(needle) && n.bounds) || nodes.find((n) => (n.id || '').includes(needle) && n.bounds);
    if (!loose) return result(false, 'not_found', '界面上没找到「' + needle + '」', '');
    x = loose.bounds.cx; y = loose.bounds.cy;
  }
  const run = await shText('uitest uiInput click ' + Math.round(x) + ' ' + Math.round(y));
  if (run.code !== 0) return result(false, 'click_failed', run.text.trim().slice(0, 300), '');
  return result(true, 'ok', '已点击 ' + Math.round(x) + ',' + Math.round(y), '');
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
  const tap = await shText('uitest uiInput click ' + Math.round(x) + ' ' + Math.round(y));
  if (tap.code !== 0) return result(false, 'click_failed', tap.text.trim().slice(0, 300), '');
  const run = await shText('uitest uiInput inputText ' + Math.round(x) + ' ' + Math.round(y) + ' ' + shellQuote(value));
  if (run.code !== 0) return result(false, 'input_failed', run.text.trim().slice(0, 300), '');
  return result(true, 'ok', '已在 ' + Math.round(x) + ',' + Math.round(y) + ' 输入 ' + value.length + ' 个字符', '');
}

async function uiSwipe(args) {
  const nums = [args.x1, args.y1, args.x2, args.y2].map(Number);
  if (!nums.every(Number.isFinite)) return result(false, 'invalid_args', 'swipe 需要 x1/y1/x2/y2', '');
  const speed = Number.isFinite(args.speed) ? Math.round(args.speed) : 600;
  const run = await shText('uitest uiInput swipe ' + nums.map((n) => Math.round(n)).join(' ') + ' ' + speed);
  if (run.code !== 0) return result(false, 'swipe_failed', run.text.trim().slice(0, 300), '');
  return result(true, 'ok', '已滑动', '');
}

async function uiKey(args) {
  const key = typeof args.key === 'string' && args.key.trim() ? args.key.trim() : 'Back';
  const run = await shText('uitest uiInput keyEvent ' + shellQuote(key));
  if (run.code !== 0) return result(false, 'key_failed', run.text.trim().slice(0, 300), '');
  return result(true, 'ok', '已发送按键 ' + key, '');
}

async function uiShot() {
  const file = TMP + '/dsh-shot-' + Date.now() + '.jpeg';
  const run = await shText('snapshot_display -f ' + file, 25000);
  if (run.code !== 0) return result(false, 'shot_failed', run.text.trim().slice(0, 300), '');
  const buffer = await getLink().execBuffer('cat ' + file + '; rm -f ' + file, 30000);
  if (buffer.length < 1000 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return result(false, 'shot_failed', '截图数据异常（' + buffer.length + ' 字节）', '');
  }
  const dir = shotDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = 'shot-' + Date.now() + '.jpg';
  const target = path.join(dir, name);
  fs.writeFileSync(target, buffer);
  try { fs.chmodSync(target, 0o644); } catch { /* 只读挂载时忽略 */ }
  return result(true, 'ok', '截图已保存到工作区，用 read_image 读取即可看见屏幕', 'phone-shots/' + name + ' (' + buffer.length + ' 字节)');
}

async function uiWait(args) {
  const ms = Number.isFinite(args.ms) ? Math.max(0, Math.min(15000, args.ms)) : 1000;
  await new Promise((resolve) => setTimeout(resolve, ms));
  return result(true, 'ok', '已等待 ' + ms + 'ms', '');
}

const uiActions = { dump: uiDump, click: uiClick, input: uiInput, swipe: uiSwipe, key: uiKey, shot: uiShot, wait: uiWait };

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
  return result(false, 'invalid_args', 'app.action 只支持 launch/stop/list', '');
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
    description: '直接操作用户的手机界面：dump 读取当前屏幕控件树（含中心坐标），click 点按（坐标或文字），input 输入文字，swipe 滑动，key 发按键（Back/Home/Power），shot 截图存档，wait 等待。可用来操作任意第三方 App。坐标是手机像素，dump 返回的「中心 x,y」可直接用于 click。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['dump', 'click', 'input', 'swipe', 'key', 'shot', 'wait'], description: '要做的动作' },
      text: str('click 用它按文字找控件；input 用它作为要输入的文字'),
      filter: str('dump 时只保留包含该子串的控件'), limit: num('dump 最多列出多少个控件，默认 150'),
      x: num('点击/输入的 x 坐标'), y: num('点击/输入的 y 坐标'),
      x1: num('滑动起点 x'), y1: num('滑动起点 y'), x2: num('滑动终点 x'), y2: num('滑动终点 y'),
      speed: num('滑动速度，默认 600'), key: str('键名：Back/Home/Power 等'), ms: num('wait 毫秒') },
      required: ['action'] },
    run: async (args) => {
      const action = String(args.action || '');
      const handler = uiActions[action];
      if (!handler) return result(false, 'invalid_args', 'action 只支持 ' + Object.keys(uiActions).join('/'), '');
      return handler(args);
    } },
  { name: 'mcp__phone__app',
    description: '管理手机应用：list 列出已安装包名；launch 用包名把应用拉到前台（走 aa start，不依赖桌面入口）；stop 强制停止应用。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['list', 'launch', 'stop'], description: '动作' },
      app: str('包名，例如 com.tencent.mqq') }, required: ['action'] },
    run: appAction },
];

export const phoneUiCatalog = Object.freeze(definitions.map(({ name, description, parameters }) => ({ name, description, parameters })));

export function registerUiTools(ctx) {
  const disposers = [];
  try {
    for (const definition of definitions) {
      disposers.push(ctx.tools.register({
        name: definition.name, description: definition.description, parameters: definition.parameters,
        timeoutMs: 120000,
        output: { schema, render: (_args, value) => text(value) },
        async execute(args) {
          try { return await definition.run(args || {}); }
          catch (error) { return result(false, 'failed', String(error && error.message || error).slice(0, 500), ''); }
        },
      }));
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
