// The product host's sole --import. Install the OS-child-process boundary before
// dependencies can capture builtin aliases. Keep sequential dynamic imports:
// network bootstrap must finish before publication's dependencies are evaluated.
// 先把 node:inspector 换成空实现，再让任何依赖去碰它：本机 libnode 是 --without-inspector 编的，
// 真模块一取用就抛 ERR_INSPECTOR_NOT_AVAILABLE，会连带把 dshmarket 这类只想知道
// “有没有开调试器”的插件整个拖死。ESM 走 loader 钩子，CJS 走 Module._load。
import Module, { register } from 'node:module';
const inspectorStub = (await import('./process/inspector-stub.mjs')).default;
try {
  register(new URL('./process/inspector-hooks.mjs', import.meta.url));
} catch (error) {
  console.warn('[ohos-inspector-stub] ESM 钩子注册失败，仅 CJS 生效：' + String(error && error.message || error));
}
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node:inspector' || request === 'inspector') return inspectorStub;
  return originalLoad.call(this, request, ...rest);
};
// 本机 libnode 没有 WebAssembly（编译期关掉 + 运行时 --jitless），而 Node 自带的 fetch
// （内部 undici）解析 HTTP 响应时要实例化 llhttp 的 wasm，缺了就整条炸掉：
// "WebAssembly is not defined"。装一个纯 JS 的 llhttp 替身，global fetch 立刻可用，
// 顺带救活所有依赖 fetch 的插件（model 请求走 bili 代理转发时也是这条路）。
try {
  const { installWebAssemblyShim } = await import('./process/wasm-shim.mjs');
  installWebAssemblyShim();
} catch (error) {
  console.warn('[wasm-shim] 安装失败，global fetch 将不可用：' + String((error && error.message) || error));
}
await import('./process/child-process.mjs');
await import('./net/dsh-preload.mjs');
await import('./publication/preload.mjs');
await import('./process/node-worker-preload.mjs');
// The plugin manager reaches the package manager through three profile operations. This device
// ships no pnpm binary, so the module answers them in process; publishing it here keeps the
// patched plugin manager free of relative paths into the runtime tree.
globalThis.__dshOhosPackageManager = await import('./plugins/package-manager.mjs');
// bili(billion-context) 的代理要靠子进程起，手机没有子进程。用 Worker 线程在引擎内把它托管起来，
// 并把 origin 写进 BILLION_CONTEXT_PROXY，插件就会改用这个代理而不是自己 spawn。
try { await (await import('./process/bili-host.mjs')).startBiliHost(); }
catch (error) { console.error('[bili-host] setup failed: ' + String((error && error.message) || error)); }
