// 在引擎进程内托管 billion-context（bili）代理。
// bili 的正常路径是插件自己 spawn 一个 `index.js start` 代理进程；手机 libnode 没有子进程
// （runtime/ohos/process/child-process.mjs 直接抛 ERR_OHOS_NO_SPAWN），那条路必然失败，
// 于是插件永远拿不到 base，/acp 只能报 "no proxy detected"，压缩完全不生效。
// worker_threads 是可用的，所以这里用 Worker 线程把代理跑起来，再把 origin 通过
// BILLION_CONTEXT_PROXY 交给插件 —— 插件见到该变量就不再自己 spawn（nativeBootstrapGate）。
// 就绪探测放在后台：引擎启动不能被 40+ MB 的 --jitless 解析拖住。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const log = (message) => console.error('[bili-host] ' + message);
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dshHome = () => {
  const home = process.env.DSH_HOME;
  return typeof home === 'string' && home.startsWith('/') ? home : (process.env.HOME || process.cwd());
};

// 插件可能装在任意 profile 下；web 是手机端实际在用的那个，先查它。
function findProxyScript() {
  const profiles = path.join(dshHome(), 'profiles');
  let names;
  try { names = fs.readdirSync(profiles).filter((name) => !name.startsWith('.')); }
  catch { return undefined; }
  for (const name of ['web', ...names]) {
    const script = path.join(profiles, name, 'node_modules', 'billion-context', 'dist', 'index.js');
    if (isFile(script)) return script;
  }
  return undefined;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('no free port'));
      });
    });
  });
}

async function healthy(origin) {
  try {
    const response = await fetch(origin + '/__bili/health', { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    await response.text();
    return true;
  } catch { return false; }
}

export async function startBiliHost() {
  if (process.env.DSH_GO_BILI_HOST === '0') { log('disabled by DSH_GO_BILI_HOST=0'); return; }
  const configured = String(process.env.BILLION_CONTEXT_PROXY || '').trim();
  if (configured.length > 0) { log('already configured, keeping ' + configured); return; }
  const script = findProxyScript();
  if (script === undefined) { log('billion-context is not installed in any profile; nothing to host'); return; }
  let port;
  try { port = await freePort(); }
  catch (error) { log('no free port: ' + String((error && error.message) || error)); return; }
  const origin = 'http://127.0.0.1:' + port;
  // 必须在插件 apply 之前就位：插件只在这里读一次。
  process.env.BILLION_CONTEXT_PROXY = origin;
  const started = Date.now();
  let worker;
  try {
    // dist/index.js 必须自己当 Worker 的主模块（否则 bili 的 CLI 主函数不跑、进程静默退出），
    // 所以垫片用 execArgv 的 --import 预载，抢在它加载 undici 之前装上 WebAssembly/llhttp 替身。
    worker = new Worker(script, {
      argv: ['start', '--host', '127.0.0.1', '--port', String(port), '--no-auto-update'],
      execArgv: ['--import', fileURLToPath(new URL('./bili-preshim.mjs', import.meta.url))],
      env: { ...process.env, BILI_PARENT_PID: String(process.pid) },
    });
  } catch (error) {
    delete process.env.BILLION_CONTEXT_PROXY;
    log('worker could not start: ' + String((error && error.message) || error));
    return;
  }
  worker.on('error', (error) => log('worker error: ' + String((error && (error.stack || error.message)) || error).split('\n')[0]));
  worker.on('exit', (code) => log('worker exited code=' + code));
  worker.unref();
  let size = 0;
  try { size = fs.statSync(script).size; } catch {}
  log('hosting ' + script + ' on ' + origin + ' (bundle=' + size + 'B)');
  void (async () => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await healthy(origin)) { log('proxy ready on ' + origin + ' after ' + (Date.now() - started) + 'ms'); return; }
      await sleep(500);
    }
    log('proxy not ready after ' + (Date.now() - started) + 'ms; the plugin will report an unreachable proxy');
  })();
}
