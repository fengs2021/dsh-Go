// bili 代理 Worker 的预载脚本（由 Worker 的 execArgv: ["--import", 本文件] 注入）。
// 为什么不用引导模块包一层：bili 的 dist/index.js 是 bin 入口，被 import() 进来时它不是主模块，
// CLI 主函数不跑、进程静默退出。所以必须让 dist/index.js 自己当主模块，只把垫片放在它前面。
// 手机 libnode 没有 WebAssembly（+ --jitless），bili 自带 undici 的 llhttp wasm 一实例化就崩，
// 表现为所有 https 上游都 502 "acp-proxy failure: unknown <private-host>"。
import { installWebAssemblyShim } from './wasm-shim.mjs';

installWebAssemblyShim();
