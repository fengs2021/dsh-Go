// 调试通道（界面操作）状态导出：把 hdc 授权诊断的结果写成固定文件，
// 供 ArkTS 侧「系统操作」页展示有没有授权；同时轮询一个请求文件，支撑「重新检测」。
// 纯旁路：诊断失败只写状态，不抛给调用方，也不改变 agent 行为。
import fs from 'node:fs';
import path from 'node:path';
import { diagnoseHdc, getLink } from './hdc-link.mjs';

const homeDir = () => process.env.HOME || process.env.DSH_HOME || process.cwd();
const appDir = (home = homeDir()) => path.join(home, '.dsh', 'dsh-app');
export const statusPath = (home = homeDir()) => path.join(appDir(home), 'hdc-status.json');
export const requestPath = (home = homeDir()) => path.join(appDir(home), 'hdc-probe.json');

const brief = (text, max = 240) => String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

/** 诊断结果 → 页面直接可用的状态：authorized / no_port / unauthorized / error。 */
export function stageOf(report) {
  if (report && report.auth && report.auth.ok === true) return 'authorized';
  if (report && report.wirelessDebugging && report.wirelessDebugging.ok === false) return 'no_port';
  return 'unauthorized';
}

export function statusOf(report, source = 'boot') {
  const stage = stageOf(report);
  const key = (report && report.key) || {};
  return {
    v: 1,
    updatedAt: Date.now(),
    source,
    stage,
    authorized: stage === 'authorized',
    port: Number(report?.auth?.port) || 0,
    ports: Array.isArray(report?.wirelessDebugging?.discoveredPorts) ? report.wirelessDebugging.discoveredPorts.slice(0, 4) : [],
    defaultPort: Number(report?.wirelessDebugging?.defaultPort) || 0,
    ms: Number(report?.auth?.ms) || 0,
    error: brief(report?.auth?.error, 200),
    keySource: brief(key.source, 40),
    keyPath: brief(key.path, 200),
    pemBytes: Number(key.pemBytes) || 0,
    fingerprint: brief(key.fingerprint, 120),
    hints: Array.isArray(report?.hints) ? report.hints.slice(0, 3).map((hint) => brief(hint, 200)) : []
  };
}

/** 写一条状态；写盘失败不影响调用方。 */
export function writeStatus(status) {
  try { writeJson(statusPath(), status); } catch { /* 状态文件只是展示用 */ }
  return status;
}

/** 已知通道可用时（启动自检通过）直接记成已授权，退出码为证的探针已经跑过。 */
export function authorizedStatus(extra = {}) {
  let port = 0;
  try { port = Number(getLink().port) || 0; } catch { port = 0; }
  return writeStatus({ v: 1, updatedAt: Date.now(), source: 'probe', stage: 'authorized', authorized: true,
    port, ports: port > 0 ? [port] : [], defaultPort: port, ms: 0, error: '', keySource: '', keyPath: '',
    pemBytes: 0, fingerprint: '', hints: [], ...extra });
}

/** 跑一次诊断并落盘。返回状态；诊断本身失败也返回 error 状态。 */
export async function probeAndWrite(source = 'manual', options = {}) {
  try {
    return writeStatus(statusOf(await diagnoseHdc(options), source));
  } catch (error) {
    return writeStatus({ v: 1, updatedAt: Date.now(), source, stage: 'error', authorized: false, port: 0,
      ports: [], defaultPort: 0, ms: 0, error: brief((error && error.message) || error, 200), keySource: '',
      keyPath: '', pemBytes: 0, fingerprint: '', hints: [] });
  }
}

/** 读出「重新检测」的请求序号；文件缺失或损坏时返回 0。 */
export function readRequestedAt(file = requestPath()) {
  try { return Number(JSON.parse(fs.readFileSync(file, 'utf8')).at) || 0; } catch { return 0; }
}

/**
 * 轮询请求文件：页面点「重新检测」时会写 { at }，这里看到新序号就跑一次诊断。
 * ctx 只用于生命周期收尾，没传也不影响（返回的 stop 自己调）。
 */
export function startHdcStatusWatch(ctx, options = {}) {
  const intervalMs = Number(options.intervalMs) || 2000;
  const probe = typeof options.probe === 'function' ? options.probe : probeAndWrite;
  let seen = readRequestedAt();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const at = readRequestedAt();
    if (!at || at <= seen) return;
    seen = at;
    Promise.resolve().then(() => probe('request')).catch(() => {});
  }, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  const stop = () => { stopped = true; clearInterval(timer); };
  if (ctx && typeof ctx.effect === 'function') ctx.effect(() => stop, 'ohos hdc status watch shutdown');
  return stop;
}
