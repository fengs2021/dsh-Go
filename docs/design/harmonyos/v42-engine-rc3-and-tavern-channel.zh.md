# v42 变更日志：引擎升到 0.2.2-rc.3 + 酒馆可以用自定义渠道（2026-11-15）

分支 `port/v42`，提交 `94fc94fc`（84 文件，13967+/1412−），App 版本 **1.0.32+32**。
底座仍是上游 `claude/harmonyos-ohos`（1948e7b7），本版只换 DSH 引擎版本并加功能。

## 1. 引擎 0.2.2-rc.1 → 0.2.2-rc.3

- 新锁 `runtime/locks/dsh-0.2.2-rc.3/package-lock.json`（444,037 B，md5 `0dfdd8936a4783fc59327368ad6eb414`，
  sha256 `0bef59ef89cb9c4b121da1fc7b531bb1eb5501c946698f4c9919d5ba5750dc50`）；rc.1 锁目录保留以便回退。
- 生产路径常量 17 文件 32 行同步：`composition.json`（dshVersion + dshLockSha256）、
  `prepare-inputs.py`、`compose-runtime.py`、`net/bootstrap.mjs`、`process/link-dsh.mjs`、
  `build-runtime.sh`、`sim/measure.sh`、`provider-discovery/generate.py`、`session-deletion/generate.py`、
  `run-gates.py`、`GATES.zh.md`、`COMMAND-ROUTER.md`、`slot_catalog.dart` + 测试、
  `assets/islands/recipes.json`、`assets/skills/dsh-go-ui/schema.json`。
- 未动：`packages/dsh_client/lib/src/session_activation.dart:110` 的版本白名单（是行为白名单，不是引擎定位）、
  `runtime/media/dsh-media/`（独立产品，peer 区间仍是 `0.2.1-rc.4 || 0.2.2-rc.1`）。

## 2. 补丁链：177 → 175 个，全链 175/175 绿

rc.3 安装树变了，首轮 49 个补丁失配，逐个重审（按 5 组并行）后修到全绿；
并**删掉 2 个已被上游吃掉的补丁**：

| 删除 | 理由 |
| --- | --- |
| `zzzzzzzzzz-agent-team-input-recovery.diff` | rc.3 已无 `dsh-experimental-agent-team` 包 |
| `zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-fs-parent-kind.diff` | rc.3 的 `fsErrorFromErrno` 已把 ENOENT/ENOTDIR 映射成 not found / FS_NOT_FOUND（超集），补丁锚定的 `statExisting` 不存在 |

删除三处同步：`.diff` 文件、`runtime/patches/series`、`runtime/patches/pins.json` 的 `patches` + 
`targetSets.ohos` + `targetSets.android`（现 175 patch / ohos 175 / android 143）。

较难的三个修法：

- `…-ohos-composition.diff` 重写（2496 B）：保留 attachment-local 与 sensevoice 两段；
  删掉 office-to-pdf / dsh-skill-office 段（rc.3 无此包）；新增 `dsh-office-kit` 两个 hunk——
  RemoteError 透出 `cause.message`（code 为 unavailable 时），以及 `runOperation` 里 openharmony 直接抛
  `OfficeKitError(unavailable, 鸿蒙本机不支持 Office 转换…)`。
- `…-provider-discovery-headers.diff`（1,394,289 B）：`dsh-api-remotes/lib/client.js` 是 1.16 MB 的 minified 单行，
  6 个 hunk 全 0 匹配；改为合成 1 个 `@@ -1,1 +1,223 @@` 大 hunk（带尾锚点，避免补丁膨胀到 `8 MB）。
- `…-companion-signals.diff` / `…-session-deletion.diff` / `…-ohos-plugin-packages.diff` 等：
  根因是同文件里**更早/更晚的另一个补丁**改了行数（`zzzz-plugin-config-readability`、`zzzz-title-cache-refresh`），
  改对锚点即可连带修好其它若干补丁。

验收口径统一为逐补丁 e2e 工具 `/root/e2e/upto.py`（硬链接克隆 /root/prepared43/dsh，按 series 顺序先把目标之前的补丁打完，
再对目标补丁逐 hunk 试打），最终全链探针输出 `{"selected": 175, "ok": 175, "fail": 0}`。
随后 `rtbuild patch-dsh --prefix /root/prepared43/dsh --dsh-version 0.2.2-rc.3 --target ohos --record` 重钉 pins
（191,287 B，+1373/−19，rc.1 槽位 0 处被改写、无补丁丢失）。

## 3. compose / prepare-inputs（rc.3 官方链路）

- `prepare-inputs.py` 全量成功：`{"status": "PREPARED", "receiptSha256": "887953d42c5fa73a648fbdc4d25aef9580c1551e7345aefd8d2ee89cd623961d", "dshFiles": 93691, "processFiles": 3805}`。
- compose 首跑被 `dynamic-omissions.json` 拦下（7 个 error）：rc.3 里 `dsh-office-to-pdf` 已不在安装树、
  rg 守卫从 `dsh-tool-fs-search` 搬到 `@deepseek-ai/dsh-util-ripgrep/lib/index.js`，
  白名单按 rc.3 的真实字节重算（importerSha256 + occurrences），条目 13 → 12。
- compose 结果：`{"runtimeVersion": "ohos-4304faae5cb3ac4a61e366c8", "payloadFiles": 55553, "payloadBytes": 589627270, "archiveBytes": 205333268, "archiveRoundTrip": true}`。

## 4. 酒馆可以用本机自定义渠道（llm-pi-ai 之类）

纯 Dart 改动，不动引擎（引擎的 `llm.stream` 只有 waterfall 事件、无远程 RPC；
渠道信息与密钥本来就在 App 侧：`customProvidersProvider` + `ProviderKeyVault`）。

| 文件 | 改动 |
| --- | --- |
| `packages/dsh_tavern/lib/src/api.dart` | `TavernModelConfig` 新增 `headers`（默认空） |
| `packages/dsh_tavern/lib/src/llm/model_client.dart` | 新增 `requestHeaders(config, key)`：用户 headers 先、`Authorization`/`Content-Type` 不可覆盖（大小写不敏感） |
| `app/lib/tavern/tavern_settings.dart` | `providerRoute` / `providerModel` 两个偏好（`tavern.providerRoute` / `tavern.providerModel`）+ `tavernProviderKeyStoredProvider` |
| `app/lib/tavern/tavern_provider.dart` | 新增 `tavernModelConfig(ref, settings)`：route → 渠道的 baseUrl/headers/models，key 取 `providerKeyVault.readAll()[id]`，仅 `openaiCompletions` 协议，`deepseek` 只在 host 为 api.deepseek.com 时为真，缺失/加载中回落官方 |
| `app/lib/ui/tavern/tavern_settings_page.dart` | 「模型来源」官方/自定义 + 渠道/模型/密钥三行 + 选择 sheet + 限制说明 |
| `app/lib/l10n/parts/tavern_{zh,en}.arb` | 各 +15 键（同步到 `app_{zh,en}.arb` 与 `lib/l10n/gen/`*） |

已知限制（UI 里也写着）：只讲 OpenAI Chat Completions 协议；渠道密钥只读本机引擎里由 App 表单录入的那份；
费用估算仍按 DeepSeek 官方价。

一次真实回归：设置页第一版无条件 `ref.watch(customProvidersProvider)`，把引擎连接栈（`dsh/runtime/events`、
`connectivity_status` 平台通道）拉进纯 widget 测试，导致 `tavern_st_theme_test.dart` 2 条失败；
改为仅当已选自定义渠道时才 watch，全量 `flutter test test/tavern` → **+514 全通过**。

## 5. slot 目录跟到 rc.3

从 `dsh-cordis-client-runner/lib/client.js` 重抽出 **116 项**（rc.1 是 109），新增 `kind: hoc`（可拿 children）
与 `replaceRisk: wraps-owner-content`；`slot_catalog.dart` / `slot_catalog_test.dart` / fixture 同步。

## 6. 打包相关修复

- **酒馆打不开的真正原因**：v41 的 HAP 里没有 `libsqlite3.so`——组装 AOT 目录时只拷了 `flutter_assets` 与 `arm64-v8a`，
  漏掉 `native_assets/`。v42 改为整份拷 AOT artifact，并用 `tooling/ohos/build-sqlite3-native.py` 编的 **OHOS 版**
  libsqlite3.so（CI artifact 自带的那份是 glibc 版，NEEDED `libm.so.6` / `ld-linux-aarch64.so.1`，鸿蒙加载不了）。
  HAP 内现为 1,437,800 B / md5 `0ea0b5537d71f07326bb31c3705dc5c7` / NEEDED 仅 `libc.so`。
- `check-arkts.sh` 增加 NativeAssetsManifest 缺失校验，`audit-hap.py` 把 native assets 并入 `expected_libs`。
- `app/ohos/AppScope/app.json5` 的 bundleName 落地为 `io.github.ccch1mneyyy.dsh_app`（v40 起真机装的一直是这个包名，之前没提交）。

## 7. 产物与验证状态（2026-11-15）

| 项 | 值 |
| --- | --- |
| 提交 / 分支 | `94fc94fc` / `port/v42`，已推到 fork `fengs2021/dsh-Go` |
| CI AOT | workflow run 43677262551（success），artifact `ohos-aot-94fc94fc…`，22,271,936 B |
| HAP 未签名 | 274,323,138 B，md5 `ac1a4eed18d34c9393d95b21d5477569`，`audit-hap: OK` |
| HAP 已签名 | 274,400,119 B，md5 `b555bdfc16fda7885fa30f3d0232b2cf`（HoKit，hokit_debug） |
| runtime | `ohos-4304faae5cb3ac4a61e366c8`，55,553 文件 / 589,627,270 B |

**已验证**：单元/组件测试（酒馆 514 条、phone/progress/hdc-status 27 条）、补丁链全绿、prepare/compose/HAP 构建、
签名、`audit-hap`。**未验证**：真机——2026-11-15 13:40 起手机 192.168.2.102 从局域网消失（arp 无条目、
全子网扫 45957 无响应），装机与「酒馆可打开 + 自定义渠道可用」的端到端验收**尚未进行**。

构建/签名/装机/取证的完整可复现流程见 `docs/design/harmonyos/device-build-and-verify.zh.md`（§9 是 v42 实录）。
`