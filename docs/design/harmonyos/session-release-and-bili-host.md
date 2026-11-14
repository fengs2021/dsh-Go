# 会话未知结果放行 + bili 代理进程内托管（v34）

本机引擎在手机上有两处「功能被平台限制卡住」的缺口，v34 都落在引擎侧（Dart 不参与本机构建，
所以改动只能是运行时 JS 与 ArkTS）。

## 1. 会话被「未知工具结果」锁死 → mcp__phone__session

### 现象
DSH 引擎在工具执行中途被杀（升级 HAP 后强制停止、崩溃、关机），该会话此后每次发消息都只得到
「本轮运行失败 / Previous tool results require reconciliation」。界面上表现为连续多轮红字失败。

### 机制
- `runtime/ohos/lifecycle/coordinator.mjs` 冷启动 `reconcileCold()`：工具已 dispatch、但没有落到结果的行，
  `basis = dispatch-without-outcome`、`blocking = true`，并 `#blocked.set(sessionId, basis)`。
- 之后 `admit()`（:180）与 `gate()`（:196）见到 blocked 或存在未解决行就抛
  `ERR_OHOS_LIFECYCLE_RESULT_UNKNOWN`。
- 唯一放行口是 `acknowledgeUnknown(sessionId)`（:460）：给每条未解决行写
  `{kind:'reconciled', basis:'explicit-abandon-unknown-without-replay', blocking:false}` 并解除 blocked。

### v34 做法
- 新增手机工具 `mcp__phone__session`（`runtime/ohos/phone/session-tools.mjs`）：
  - `action=list`：用 `ctx.ohosLifecycle.status(undefined)` 列出所有被锁会话及未结算调用；
  - `action=release`：对目标会话（可选 `sessionId`，省略即全部）调用 `acknowledgeUnknown`，
    逐条返回成功/失败（例如 `ERR_OHOS_LIFECYCLE_STILL_RUNNING`）。
  - 判定条件与 `coordinator.#unresolved` / `status().unknown` 保持一致：
    `!row.active && (row.reconciliation?.blocking === true || row.phase !== 'committed') && row.reconciliation?.blocking !== false`。
- 守卫错误文案末尾补一句可操作提示：`call mcp__phone__session with action=release (or start a new session)`，
  这样模型在会话里读到报错就知道怎么自救。

Fake 上下文的单测覆盖：list/release/invalid_args/协调器缺失降级/放行抛错，PC 侧全过（SESSION_TOOLS_TEST_OK）。

## 2. bili(billion-context) 报 "no proxy detected" → Worker 线程托管代理

### 现象
`/acp` 输出 `bili: no proxy detected — install via 'bili plugin install dsh' or launch through 'bili dsh'`，
压缩完全不生效（插件降级成「直连、无身份头」）。

### 机制
- 插件在 `nativeBootstrapGate()` 通过时（`BILLION_CONTEXT_PROXY` 为空等）自己
  `ensureProxyRunning(...)` → `spawn(`node dist/index.js start ...`)` 起代理。
- 手机 libnode 禁子进程（`runtime/ohos/process/child-process.mjs` 抛 `ERR_OHOS_NO_SPAWN`），代理永远起不来。
- 反过来，只要 `BILLION_CONTEXT_PROXY` 非空，插件就不再 spawn，直接用该 origin 作为 base
  （`proxyEnvOrigin()`）。`worker_threads` 在手机上可用。

### v34 做法
- 新增 `runtime/ohos/process/bili-host.mjs`，由 `preload.mjs` 在依赖加载前调用：
  1. 扫 `$DSH_HOME/profiles/*/node_modules/billion-context/dist/index.js`（先 web），找不到就退出；
  2. 取一个空闲本地端口，**先**写 `process.env.BILLION_CONTEXT_PROXY = http://127.0.0.1:<port>`
     （插件只读一次，必须在 apply 之前）；
  3. `new Worker(script, { argv: ['start','--host','127.0.0.1','--port',<port>,'--no-auto-update'], execArgv: ['--import', bili-preshim.mjs] })`
     ——Worker 里 CLI 取 `argv[0]` 当子命令，所以数组第一项必须是 `start`；
     `dist/index.js` 必须自己当 Worker 的主模块（用引导模块 `import()` 它时它不是主模块，CLI 主函数不跑、进程静默退出），
     所以垫片只能靠 `execArgv` 的 `--import` 预载；
  4. 就绪探测（`GET /__bili/health`）放后台轮询，不阻塞引擎启动；全程 `[bili-host] ...` 写 engine.log。
- 开关：`DSH_GO_BILI_HOST=0` 关闭；已存在 `BILLION_CONTEXT_PROXY` 时保持用户配置不动。

PC 端实测（`/root/bili-host-test.mjs`、`/root/bili-longevity.mjs`）：env 46 ms 就位，
代理 541 ms 就绪（`/__bili/health` 200），进程 RSS 142 MB，90 秒后仍健康。

## 边界
- 手机端未验证项：Worker 线程在 `--jitless` 下解析 5.8 MB 包的耗时与内存、`node:sqlite` 在 worker 内可用性。
  真机启动后看 engine.log 的 `[bili-host]` 行即可判定。
- 放行是「放弃未知结果、不重放」，不会替用户重跑被中断的那一步。

## 3. 手机 fetch 全废、模型请求 502 → WebAssembly/llhttp 纯 JS 垫片（v35）

### 现象
- 手机本机会话发消息 → 每轮重试 5/5 后红字：`502 "acp-proxy failure: unknown <private-host>"`（SERVER）。
- 引擎启动告警里 `[acp-registry] ... fetch failed`；任何走 `global fetch` 的代码都失败。

### 机制
- 本机 libnode 编译时关掉了 WebAssembly，运行时又固定 `--jitless`；V8 在无 JIT 时根本不提供 `WebAssembly`。
- Node 自带 fetch 内部是 undici，解析 HTTP 响应要 `new WebAssembly.Module(llhttp.wasm)`；缺了就直接
  `TypeError: WebAssembly is not defined`。PC 上 `node --jitless -e "fetch(...)"` 可 1:1 复现。
- bili 代理把上游请求也交给 fetch 转发，于是 https 上游一律失败；它把失败归类成
  `kind=unknown`（错误链里没有 code）→ `502 acp-proxy failure: unknown <private-host>`。
  （host 被掩码、没端口 = https 默认 443 的私有域名，所以看不到真实地址。）

### 做法：`runtime/ohos/process/wasm-shim.mjs`
纯 JS 复刻 llhttp（`llhttp_* 8 个导出 + malloc/free/memory`）的 **HTTP/1.1 响应**状态机，
在 `globalThis.WebAssembly` 缺失时装参数形状兼容的替身（`Module`/`Instance`/`validate`/`compile`/`instantiate`）。
- 分片安全：跨 execute 的 token 从句首重新计偏移；header 字段/值允许多次回调（undici 会 `Buffer.concat`）；
  空 header 值必须回调一次（undici 靠 headers 数组奇偶配对）；body 背压返回 `PAUSED(21)`，undici 用
  `llhttp_get_error_pos` 取剩余字节后再喂。
- 收尾：无正文（204/304/`Content-Length: 0`）或正文刚好在本块结束时，必须立刻回调 `message_complete`，
  否则 undici 拿不到响应。
- 块长解析：看到 `;`/`CR`/`LF` 就要把 `chunkRemaining` 定下来（分片常把 `4` 和 `;` 拆到两次 execute）。
- 安装点两处：`preload.mjs`（引擎主线程，救活引擎和插件的 global fetch）、
  `bili-preshim.mjs`（bili Worker 的 `execArgv: ['--import', ...]` 预载）。
- 自测：`/root/llhttp-shim-test.mjs` 共 15 个用例（content-length 0/1/2/3/7/13 分片、chunked 分片、
  pipelined、chunk 扩展、body 背压、无长度走 finish、空 header 值），全 PASS。

### PC 端实测证据（node v24.22.1 --jitless）
- 无垫片：`fetch('https://example.com/') → FAIL WebAssembly is not defined`（3 个 URL 全失败）。
- 有垫片：`example.com` 200 / `api.github.com/zen` 200，连续 5 个请求（含 POST 与 keep-alive 复用）全部成功。
- 经 bili 代理：`curl http://127.0.0.1:P/bili/https://api.github.com/zen` → `200 "Speak like a human."`
  —— 就是手机上产生 502 的那条转发路径。

### 边界
- 垫片只实现了**响应**解析（bili/undici 只解析响应；请求由 undici 自己序列化）。
- 不支持升级（101/WebSocket）与 CONNECT 隧道内的明文解析——这两条路 undici 走的是别的分支。


## 4. v36：未知结果的自愈（不再需要人/agent 手动放行）

v34 给了 `mcp__phone__session action=release`，但真机上仍然反复出现
`Previous tool results require reconciliation before another step`，原因是**鸡生蛋死锁**：

- `coordinator.gate()/admit()` 在工具开始前就检查「本会话有没有未解决的未知结果」；
- 于是同一条会话里 agent 连 `mcp__phone__session` 都调不起来，放行入口永远够不到；
- 而 `reconcileCold()` 每次冷启动都把 `dispatch-without-outcome` 一类行重新判成 `blocking = true` 并写进 journal，所以重启也不自愈。

### 4.1 放行工具穿透闸门

`RELEASE_TOOLS = {'phone_session', 'mcp__phone__session', 'session'}`。`gate()/admit()` 增加第三个参数 `tool`，
命中放行工具时跳过阻塞检查；其余工具一律照旧。调用点 `prepared(meta)` 传 `meta.block.name`，`run(meta)` 传 `row.identity.name`。

### 4.2 冷启动自动放弃（默认开启）

派发未完成调用的那个引擎进程已经死了，结果永远不会再到。继续阻塞只会让会话永久不可用，所以冷启动时把三类
「不可恢复」的行按 `blocking = false`、`basis = 'auto-abandon-…'` 结算，并在会话里保留「结果未知」的事实：

| 分支 | 含义 | 自动结算后的 basis |
| --- | --- | --- |
| `dispatch-without-outcome` / `returned-awaiting-ordered-finalization` | 派发了但没有结果 | `auto-abandon-unknown-without-replay` |
| `missing-ordered-recovery-slot` | 找不到配对的结果槽 | `auto-abandon-missing-recovery-slot` |
| `existing-unknown-placeholder` | 会话里已经是 unknown 占位 | `auto-abandon-existing-unknown` |

仍然保持阻塞（不能静默放过）的分支：`session-identity-mismatch`、journal 损坏、`ERR_OHOS_LIFECYCLE_SEQUENCE`。

### 4.3 幂等

二次启动时，`/abandon-unknown-without-replay$/` 的 `blocking === false` 行原样沿用，不会被重新判成阻塞。
开关：环境变量 `DSH_OHOS_LIFECYCLE_AUTO_RELEASE=0` 可关闭自动放弃（回到 v35 行为）。

### 4.4 验证

- `node --check runtime/ohos/lifecycle/coordinator.mjs` 通过；`lifecycle-engine.test.mjs` 的 `gate(sessionId)` 两参调用仍兼容（无 tool ⇒ 不放行）。
- 真机自检：装机后在被锁死的会话里发一句话，应直接开始新一轮，而不是再报 reconciliation 错误。
