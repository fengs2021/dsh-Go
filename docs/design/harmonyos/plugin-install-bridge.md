# 鸿蒙插件安装的进程内桥接

## 为什么鸿蒙需要它

DSH 的插件（bundle）安装原本完全依赖 pnpm 可执行文件：`@deepseek-ai/dsh-plugin-manager` 通过三个函数把 profile 上的包操作交给 `pnpm` 子进程。鸿蒙应用沙箱里没有 pnpm 可执行文件，也不能启动任意外部进程。

上一版的做法是"明确拒绝"：在 7 处入口拦截并返回固定文案 `OHOS_PLUGIN_INSTALL_UNAVAILABLE`。真机装上后插件市场只能看不能装，用户必须回到电脑上管理插件，这个契约已被替换。

现在的做法是"桥接"：运行时自带一个零依赖、纯 JS 的包管理器实现在进程内回答这三个函数，因此安装、卸载、查询注册表在手机本机就能完成，不需要任何外部可执行文件，也不新增 npm 依赖。

## 契约的三个委派点

补丁 `runtime/patches/zzzzzzzzzzzzz-ohos-plugin-install-bridge.diff` 修改 `@deepseek-ai/dsh-plugin-manager` 的两个产物文件：`lib/index.js`（PluginManager 自身）与 `lib/types/operations.js`（导出的 operations）。两处插入同一个 helper：

```js
function ohosPackageManager() {
	return process.platform === "openharmony" ? globalThis.__dshOhosPackageManager ?? null : null;
}
```

并在三个入口的第一行委派（taken 时立即 return，原 pnpm 代码保持不动）：

| 入口 | 委派目标 | 调用方 |
| --- | --- | --- |
| `runProfilePnpm(context, args, options)` | `ohos.runProfilePnpm(context, args, options)` | 每次 install / remove（`PluginManager.runPnpm`） |
| `readProfileRegistry(dir, options)` | `ohos.readRegistry(dir, options)` | `PluginManager.registries`（安装对话框、检查、更新） |
| `viewProfilePackage(dir, spec, options)` | `ohos.viewProfilePackage(dir, spec, options)` | `PluginManager.askRegistries`（`inspect` / `listVersions` / `updateBundle` 的注册表查询） |

判断只用真实 `process.platform === "openharmony"`；其他平台 `ohosPackageManager()` 返回 `null`，代码路径与字节行为不变。旧 refusal 的拦截代码、常量与固定文案（`OHOS_PLUGIN_INSTALL_MESSAGE` / `OHOS_PLUGIN_INSTALL_UNAVAILABLE`）在该补丁里已全部删除，补丁文件不再含这些字符串。

注册方在 `runtime/ohos/preload.mjs`（产品 host 唯一的 `--import`）：

```js
globalThis.__dshOhosPackageManager = await import('./plugins/package-manager.mjs');
```

把这句放在 preload 里，而不是让补丁文件去引用运行时目录的相对路径，补丁因此与安装位置无关。

## 包管理器模块职责

`runtime/ohos/plugins/` 是零依赖纯 JS 实现，不读模拟开关、不 spawn：

| 模块 | 职责 |
| --- | --- |
| `semver.mjs` | 版本号解析与范围求解（`maxSatisfying`），供解析 dist-tags/范围用 |
| `tar.mjs` | 解析 npm tarball（gzip+tar），还原文件与 mode |
| `registry.mjs` | `node:https` 拉 packument 与 tarball；`registryFor(dir)` 从 profile 与 `~/.npmrc` 读 `registry` / `@deepseek-ai:registry` / `:_authToken` |
| `install.mjs` | 安装会话：解析依赖图、落 `node_modules`、写 profile `package.json`、notes 收集 |
| `package-manager.mjs` | 对外三个函数（`runProfilePnpm` / `readRegistry` / `viewProfilePackage`）、参数解析、RunLog、`VERSION = '9.99.0-ohos'` |

`package-manager.mjs` 支持的子命令子集（其余一律失败并写日志）：

- `add` / `install` / `i`（含 `--save-exact` / `-E`、`--registry`）
- `remove` / `rm` / `uninstall` / `un`
- `list` / `ls`
- `view` / `info` / `show`
- `config get registry`
- `--version` / `version` / `-v`

明确拒绝（`exitCode 1`，日志与 `packageResult.output` 说明原因，不做半装）：`git:`、`git+…`、`http(s):` 直链、`file:`、`link:` 以及 `*.tgz` 本地产物。插件必须先发到注册表再按名字安装。

## RunLog

每一次 `runProfilePnpm` 都在 profile 内新建一个目录并写出固定名字的日志：

```
<profile>/.plugin-manager/logs/operation-<mkdtemp 随机后缀>/pnpm.log
```

- 目录 mode `0700`，日志文件 mode `0600`；文件内容以 `> dsh plugin <args>` 与 `registry: <url>` 开头，随后是安装/卸载过程与结尾的 `Done in …s` 或 `The operation failed.`。
- 同一份文本同时经 `options.onOutput` 流出，插件管理器据此发 `plugin-manager/install-log` 事件，界面上的安装日志与磁盘日志一致。
- 返回对象里的 `logPath` 就是该文件；`output` 受 `outputBytes`（默认 200 000 字节）约束，超出时从头裁剪并置 `truncated: true`。

## 已知限制

- 不写 `pnpm-lock.yaml`：安装只更新 profile `package.json` 与 `node_modules`，没有 lockfile 语义；跨设备复现只保证版本声明一致，不保证字节级依赖树一致。
- `optionalDependencies` 失败只记 notes：安装继续，失败项写进内部 notes 并以 stderr 行输出（`skipped optional <name>: <reason>`），不会让整次安装失败。
- 不支持 `--frozen-lockfile` 一类校验：没有 lockfile，该参数无意义，也不做只读校验。
- 只覆盖三个委派点所走的路由。插件包里需要原生效能或构建步骤的能力（`approvedBuilds`/build 审批）走的是同一 `add`，但 JS 实现不执行安装脚本。
- 目录与权限沿用 profile 现有约定，不额外申请沙箱外路径。

## 验证

Linux 上的两个驱动按平台语义各自断言（每行都用同一个脚本独立运行）：

| 驱动 | OH 语义（`--jitless --import runtime/ohos/sim/preload.mjs`，platform=openharmony） | Linux 控制 |
| --- | --- | --- |
| `runtime/tests/ohos/plugin-install-bridge.mjs` | 12/12：补丁已应用（helper + 三处委派，旧文案 0 次，`pins.json` 已换成 bridge 补丁）、三个 operation 整调用委派、`registries`/`runPnpm` 经桥接、运行时装出的模块名与补丁期望一致 | 12/12：三个 operation 与两条管理器路径都进入真实 pnpm 分支，注入的假对象 0 次调用 |
| `runtime/tests/ohos/plugin-registry-bridge.mjs` | 7/7：`readProfileRegistry`/`viewProfilePackage` 整调用委派、`registries` 解析值来自桥接且 fallback 复制、`askRegistries` 逐条走桥接、`updateBundle` 的 check 步经桥接读到 `not-bundle`、真实 `readRegistry` 读 `.npmrc` | 5/5：三个 operation 与两条管理器路径仍走 pnpm 分支，注入的假对象 0 次调用 |

两者都用假桥对象断言"委派发生/不发生"这件事本身，不联网、不读 profile；`run-gates.py` 用同一个驱动再跑一次 OH 与一次 control（见 `plugin-install-bridge-ohos`、`plugin-install-bridge-control` 等分组）。`runtime/tests/ohos/plugin-install-observer.mjs` 是注入真实 DSH 轮次的探针，改用 `list` 子命令断言进程内应答、RunLog 落盘与 profile 字节不变，不含下载。

真机取证（lead 侧实测记录，本次交付未复跑）：`install_bundle` 装 `is-odd@3.0.1` 能落盘（非插件包，最终报 `not-bundle`）；装真插件 `dsh-plugin-save-token@2.4.1` 返回 `{"stage":"enable","enabled":true,"changed":true,"application":"applied","packageResult":{"exitCode":0}}`。

## 打包

打包审计白名单已包含 `plugins`（`runtime/ohos/package/compose-runtime.py`），运行时归档会把 `runtime/ohos/plugins/` 一起打进 payload，preload 的相对导入因此成立。

## 尚未验证

- Flutter 侧仍把旧诊断前缀 `OHOS_PLUGIN_INSTALL_UNAVAILABLE` 当作"安装被拒"分支（`app/lib/state/plugins_state.dart`、`app/test/plugins/plugin_install_refused_test.dart`）。新契约不再产生该文案，该分支在鸿蒙上已成死代码；是否删除/替换属客户端改动，不在本文范围。
- 未在本环境重跑 HAP 构建、`compose-runtime.py` 与 `check-arkts.sh`；未对真实设备 UI 截图验收。
- 桥接不保证任意第三方插件的兼容性：只覆盖注册表安装路径与三个委派点。
