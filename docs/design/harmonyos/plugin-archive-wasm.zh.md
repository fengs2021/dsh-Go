# 插件归档策略：放行 WebAssembly，只拒原生 addon（2026-11-19）

装机反馈：装 @elvisw/dsh-magic-context@0.18.0 报
`ERR_OHOS_PLUGIN_UNSUPPORTED: 插件包含原生 addon、binding.gyp 或 WebAssembly；鸿蒙本机仅支持纯 JS 包。`
本文件记录为什么要改、改成什么、证据与未验证项。

## 1. 触发点

只有一处判据，在 `runtime/ohos/plugins/archive.mjs`：

| 位置 | 原判据 | 说明 |
| --- | --- | --- |
| `entryPath()` | 路径段以 `.node` / `.wasm` 结尾，或段名等于 `binding.gyp` | 按名字拒，报 `unsupported()` → ERR_OHOS_PLUGIN_UNSUPPORTED |
| `rejectBinary()` | 文件头 4 字节命中 `binaryMagic`（ELF 7f454c46 / WASM 0061736d / Mach-O / PE） | 按内容拒，防改名的原生件 |

## 2. 为什么 wasm 可以放行

| 形态 | 运行时需要什么 | HAP 里有吗 | 结论 |
| --- | --- | --- | --- |
| `.wasm` | V8 自带的 wasm 执行器 | libnode 就是 V8，无外部 ABI | 放行 |
| `.node` | Node addon ABI + 宿主 libc/ld | 没有（不是 Node 原生构建） | 拒 |
| `binding.gyp` | 现场编译原生 addon 的 node-gyp 工具链 | 没有编译器与头文件 | 拒 |
| ELF / Mach-O / PE | 宿主加载器 | 没有 | 拒 |

安全边界没有变化：插件 JS 本身已经拿到完整 Node 权限，
wasm 只是「另一段能在同一个 V8 里跑的代码」，不额外提权。
反过来 `.node` 会因为 ABI 不匹配在 `require` 时直接失败，留着只会给出更难懂的错。

## 3. 改动清单

- `entryPath()`：只拒 `.node` 与 `binding.gyp`，`.wasm` 放行；报错文案改为「插件包含原生 addon（.node / binding.gyp）；鸿蒙本机没有 Node 原生 ABI，只支持纯 JS 与 WebAssembly 包。」
- `binaryMagic`：去掉 `0061736d`，仍拒 ELF / Mach-O（含 universal）/ PE；`rejectBinary()` 文案改为「插件文件包含 ELF、Mach-O 或 PE 原生二进制」。
- `runtime/tests/ohos/plugin-archive.test.mjs`：删掉参数化拒绝表里的 `wasm` 行与扩展名缺失格式表里的 `WebAssembly` 行，新增正向用例「portable WebAssembly is retained while native addons stay rejected」（`.wasm` 扩展名与无扩展名的 wasm magic 都按数据原样保留）。`.node` / `binding.gyp` / `gypfile` 的拒绝用例保留不动。

## 4. 证据（本机）

- `node --test runtime/tests/ohos/plugin-archive.test.mjs` → **47 pass / 0 fail**。
- 同批 `plugin-graph` + `plugin-manifest-fields` + `plugin-archive` → **67 pass / 0 fail**。
- 预演脚本 `scripts/preflight-plugin-archive.mjs`（每个节点下载 tarball 后过真实 `extractPackage()`，因此扩展名、magic、gypfile、install 脚本、体积上限全部覆盖）：
  - `@elvisw/dsh-magic-context@0.18.0` → nodes=3 accepted=3 rejected=0，保留 `vendor/onnx/ort-wasm-simd-threaded.wasm`（14,264,838 B）
  - `dsh-mnemon@0.5.44` → nodes=41 accepted=41 rejected=0（回归对照）

用法（需要 node_modules 与代理）：

```
export HOME=/root NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:7890
cd <repo> && ln -sfn /root/prep66/dsh/node_modules node_modules
node <WS>/scripts/preflight-plugin-archive.mjs https://registry.npmjs.org '@elvisw/dsh-magic-context@0.18.0'
rm -f node_modules
```

## 5. 未验证：装得上 ≠ 跑得起来

引擎进程由 `app/ohos/entry/src/main/cpp/host_core.cpp:371` 以
`dsh-node --jitless --import <runtime>/preload.mjs <dsh>/lib/bin.js web …` 启动。
**`--jitless` 下 V8 的 wasm 代码生成默认是关闭的**，所以：
- 归档校验现在会放行，插件能装上；
- 但插件真去 `WebAssembly.instantiate()` 时很可能失败，除非它自带纯 JS 回退。

引擎侧已经如实上报能力：`runtime/ohos/capabilities/snapshot.mjs` 里
`wasm: typeof globalThis.WebAssembly === 'undefined' ? 'unsupported' : 'unknown'`，
注释写明「Presence alone does not prove that code generation is permitted」，
`runtime/ohos/process/commands.mjs` 也标了 `wasm: false`。
因此后续有两档可选：
1. 真机实测该插件是否降级可用（先做）；
2. 若必须真跑 wasm：打开 V8 的 jitless-wasm 支持（libnode 构建开关，未验证），或让上游插件改走纯 JS 路径。

## 6. 上游基线更新时怎么合

- 本改动是独立提交（补丁 `<WS>/patches/ohos-plugin-archive-wasm.patch`，2 文件 +19 −6），
  冲突面只有 `archive.mjs` 的 `entryPath()` 判据行、`binaryMagic` 集合与两句文案；
  测试文件里对应删两行、加一个用例。
- 若上游把 `.wasm` 又加回拒绝，需要重新讨论：先看该版是不是已经能跑 wasm（例如引擎不再是 `--jitless`）。
