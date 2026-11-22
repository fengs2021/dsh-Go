# 跟随上游基线到 1.3.0（c9d3c582）

状态：已完成合并与本地验证；出包结果见文末「构建与装机」。

## 1. 做了什么

把鸿蒙移植的 12 个补丁从旧基线 `95588b696d1f6981c711a1883fe8de3d93919dd0`
（2026-11-19，上游 1.2.0 之后的 main）整条 rebase 到新基线
`c9d3c5825f5307d2e653dbf3ffb4d00d1c632581`（2026-11-22 12:21，含上游 1.3.0 发布 `v1.3.0 = da798027`）。

区间规模（本地实测，`origin/main` 已按显式 refspec 拉取）：

```
$ git rev-list --count 95588b69..c9d3c582        → 301
$ git rev-list --merges --count 95588b69..c9d3c582 → 82
$ git diff --name-only 95588b69 c9d3c582 | wc -l  → 777
$ git rev-list --count c9d3c582..HEAD             → 14（12 个原补丁 + 2 个合并适配）
```

> 说明：本仓库的 partial clone 只把 `origin` 配成 promisor，且 `remote.origin.fetch` 原本只跟踪
> `ohos/v8`，所以 `git fetch origin` 不会更新 `origin/main`。本次用显式 refspec 拉取：
> `git fetch origin '+refs/heads/main:refs/remotes/origin/main'`。

旧分支留在 `backup/port-v71-pre130`（= `d6385094`），出问题可整条回退。

## 2. 上游这 301 个提交里影响我们的部分

审计脚本对 777 个改动文件与本地 12 个补丁的 65 个文件求交集，重合 **12 个**：

```
app/lib/l10n/app_en.arb, app/lib/l10n/app_zh.arb
app/lib/l10n/gen/app_localizations{,_en,_zh}.dart
app/lib/runtime/runtime_bridge.dart
app/lib/ui/settings/index/spots.dart
app/lib/ui/settings/interface_page.dart
app/ohos/entry/src/main/ets/runtime/{BackgroundCompute,ContinuousTaskOwner,RuntimePlugin}.ets
app/pubspec.yaml
```

其中只有两个 `.ets` 文件出现文本冲突（各 1–2 块），其余 10 个文件三方合并后逐字节自洽。
生成物一致性另行验证：`python3 tool/l10n_merge.py --check` → `✓ 79 parts, 8448 keys`；
跑完整 `l10n_merge.py`（含 `flutter gen-l10n`，Flutter 3.47.7）后 `git status --porcelain app/lib/l10n` 为空，
即仓库里入库的 `app_*.arb` 与 `gen/*` 正是重生成结果（CI 的「gen 必须等于重生成」门禁成立）。

## 3. 冲突怎么解的

### 3.1 `BackgroundCompute.ets`：上游结构 + 移植版判据（三态）

上游 `8828a323` 把 `backgroundComputePermission()` 拆成 `backgroundComputeStatus()`（返回
`supported / computePermission / permissionStatus / error / actionRequired` 五元组）+ 兼容包装，
判据只有 `MODE_TASK_KEEPING` + 受限 ACL；移植版 5654d59e 的判据是「`continuousTaskModes()` 非空」，
其中 data-transfer 只要公开权限、task-keeping 要受限 ACL。

分歧是真的会出错的那种：只带 data-transfer 的签名包**拿得到 lease**，按上游判据却报 `denied`，
UI 会写「后台任务不可用」而引擎在跑。最终做法：

- `computePermission` = 有任一可用连续模式 → `granted`，否则 `denied`（旧 getter `backgroundComputePermission()`
  直接取这个字段）；
- `permissionStatus` 仍用上游的五种值，语义不变：TASK_KEEPING 可用 → `eligible`；
  只有 fallback 可用或两种都不行时，ACL 在 → `mode_unsupported`，ACL 不在 → `eligibility_required`
  （文案仍是「需要受限 ACL 的签名包」），Dart 侧 `background_guide_page.dart` 的取值集合不用改；
- `modeSupported()` / `systemAclGranted()` 改成**三态** `true / false / null`：系统给出既非支持也非拒绝的
  答案时整条查询按 `unknown` 处理，不把「读不懂」当成「拒绝」；
- `continuousTaskModes()` 只认 `=== true`，保持给 `ContinuousTaskOwner` 用的模式顺序：task-keeping 在前。

对应地把 `lifecycle-host` 的 fixture 补齐（`MODE_DATA_TRANSFER`、`SUBMODE_LIVE_VIEW_NOTIFICATION`、
按模式分别判定支持），并把两条用例的期望改成移植版语义：请求顺序 `[9] → [7]`、模式探测 1 → 2 次、
ACL 缺失与 TASK_KEEPING 不支持时公开 getter 返回 `granted`（`permissionStatus` 仍分别是
`eligibility_required` / `mode_unsupported`）。

```
$ OHOS_TYPESCRIPT_PREFIX=/root/sdk/ets/build-tools/ets-loader/node_modules/typescript \
  node --test tooling/ohos/tests/lifecycle-host.test.mjs   → # pass 13 # fail 0
```

### 3.2 `ContinuousTaskOwner.ets`：我们的多模式循环 + 上游的稳定 failure 码

上游在同一区域加了 3 个稳定 failure 码（`ohos_continuous_cancelled` / `ohos_continuous_suspended` /
`ohos_continuous_native_failed`）、`request()` 里的失败清零与 `start_failed`、以及 `running()`；
我们的 `start()` 被改成「按 `continuousTaskModes()` 顺序尝试，data-transfer 用 240 s 进度续命」的循环。

合并保留我们的 `start()` 循环，并把上游的 failure 语义逐点补进去：

| 位置 | 行为 |
|---|---|
| `unavailable()` | 先记 `cancelled ? 'ohos_continuous_cancelled' : 'ohos_continuous_suspended'` |
| `request()` | 无未识别任务且无待清理时清空旧 failure；启动异常时补 `ohos_continuous_start_failed` |
| `start()` 取消命中 | 记 `ohos_continuous_cancelled` 再停任务 |
| `start()` `lifecycleUpdate` 非 1 | 记 `ohos_continuous_native_failed` 再停 |
| 新增 `running()` | `task !== null`，`TransientTaskOwner.continuousActive()` 依赖它 |

### 3.3 合并适配：`transient-task.test.mjs` 的桩

上游新增的 `tooling/ohos/tests/transient-task.test.mjs` 用正则把 `.ets` 的 import 整段剥掉，
只注入 `backgroundTaskManager` / `backgroundComputePermission` / `wantAgent` / `setTimeout`。
移植版还用到 `BackgroundTaskMode.MODE_DATA_TRANSFER`、`BackgroundTaskSubmode.SUBMODE_LIVE_VIEW_NOTIFICATION`、
`updateBackgroundRunning`、`hilog`、`continuousTaskModes`，缺桩会让 36 个用例整体红。

在 `tooling/ohos/tests/transient-task-fixture.mjs` 里补了这些名字（模式仍返回单一 `TASK_KEEPING`，
因此断言行为与上游一致），并把测试注入行补上 `hilog` / `continuousTaskModes`：

```
$ node --test tooling/ohos/tests/transient-task.test.mjs → # pass 36 # fail 0
```

### 3.4 上游自己的编译错误：`HostConnection`

上游 `c9d3c582` 把 `HostConnection` 构造参数改成私有命名参数 `this._label`，
但 `app/test/workspace/support.dart` 仍按 `label:` 传 —— Dart 3.13 直接报
`Named parameters can't start with an underscore`。这是基线自带的红，不是合并引入的
（`git show c9d3c582:app/test/workspace/support.dart` 同位置同写法）。

处理：字段保持私有，构造上公开 `String? label` 并在初始化列表写入 `_label`；
`// ignore: prefer_initializing_formals` 说明原因。`flutter analyze` 现为 `No issues found!`。

## 4. 验证（本机实测）

工具链：Flutter **3.47.7**（Dart 3.13.5）在 `/root/f47`；`/root/flutter` 是旧的 3.35.7，
用它分析会得到 300+ 个与私有命名参数相关的假错，别用。

| 项 | 命令 | 结果 |
|---|---|---|
| 静态分析 | `flutter analyze --no-pub` | `No issues found!`（44 s） |
| l10n 校验 | `python3 tool/l10n_merge.py --check` | `✓ 79 parts, 8448 keys` |
| l10n 生成物 | `python3 tool/l10n_merge.py` 后看 `git status app/lib/l10n` | 无改动（零漂移） |
| Dart 主套件 | `flutter test test/settings test/chat test/agents test/state test/l10n test/phone test/ui_config` | **+4470 ~1 All tests passed!**（5 分 55 秒） |
| 本次功能用例 | 思维链自动翻译 2 + 兜底 5 + 卓易通技能 + 系统操作页 + 折叠 | 74 pass / 0 fail |
| 插件图/清单/归档 | `node --test runtime/tests/ohos/{plugin-graph,plugin-manifest-fields,plugin-archive}.test.mjs` | 18 + 2 + 47 pass |
| 界面自动化 | `node --test runtime/tests/ohos/{phone-ui-tools,phone-hdc-status}.test.mjs` | 22 + 8 pass |
| 长任务门禁 | `node --test tooling/ohos/tests/transient-task.test.mjs` | 36 pass |
| 引擎补丁机制 | `python3 -I runtime/tests/test_patch_dsh.py` | Ran 33 tests, OK (skipped=1) |
| runtime 组成 | `bash scripts/prep74.sh && bash scripts/compose74.sh` | `PREPARE_RC=0` / `COMPOSE_RC=0`，`runtimeVersion ohos-938352d54e5ec9f60ee97fc1`，12421 文件 / 196,660,696 B，archive 87,479,989 B |

未能本机验证的两类：

1. `runtime/tests/ohos/linux-instance*.test.mjs`（25 例）需要带 `dsh_ohos_publication` linked binding 的
   dsh-node，本机 stock Node 22 没有该 binding，报 `ERR_INVALID_MODULE`。这是环境限制，
   合并前后一致；HAP 内走的是真正的 `libnode.so`。
2. 其余 `runtime/tests/ohos/*.test.mjs` 里需要 `DSH_PREFIX`（打好补丁的引擎前缀）的用例在本机跳过；
   CI 有前缀，仍按 CI 为准。

## 5. 与上游方向不一致、需要你知道的两点

1. **上游把「连续任务保护」默认关**（`TransientTaskOwner.setTaskEnabled` 默认 `false`）。
   我们的 data-transfer 续命只有用户打开该开关后才生效，行为与 v73 相同，没有偷偷改默认值。
2. **上游基线自带一个测试编译错误**（见 3.4）。我们在本地分支修了；如果上游后续自己修成
   `label` 命名参数，合回来会是一处纯文本重叠，直接取上游即可。

## 6. 构建与装机

- AOT：workflow `ohos-compile.yml` run `44988291274` success（第一次派发就拿到 runner，
  13:11:09 → 13:18），artifact `14740787605`，`app.so` 46,908,296 B，`AOT_COMMIT=e8adbe8e`；
  与最终 HEAD 的 `app/lib`+`packages` 差异为 0（之后只加了 `.ets` / 测试 / 文档）。
- runtime：`scripts/prep74.sh` → `PREPARE_RC=0`，`scripts/compose74.sh` → `COMPOSE_RC=0`，
  `runtimeVersion ohos-938352d54e5ec9f60ee97fc1`，12,421 文件 / 196,660,696 B。
- HAP：`FULLHAP74_RC=0`，`check-arkts: OK`，`audit-hap: OK`；`module.json` 的
  `versionName 1.3.0` / `versionCode 1`；HoKit CDP 签名 `success`。

| 产物 | 大小 | md5 |
|---|---|---|
| `hap-build/dsh-ohos-v74-unsigned.hap` | 163,426,345 B | `607b91cd47ac4e3d9103625ebf456011` |
| `hap-build/dsh-ohos-v74-signed.hap` | 163,515,134 B | `aac9682cbbed0f85ceeb0aa090f6c670` |

装机：`bash scripts/install-v74.sh 192.168.2.115:45957` → `install bundle successfully`、
`aa start ability successfully`；设备侧 `versionName 1.3.0`、`versionCode 1`、
`updateTime 2026-11-22 13:22:07`，进程在跑。

手机上还需要你自己验的三件事（桌面测不了）：后台长任务在锁屏后是否还走 data-transfer、
思维链展开是否直接出中文、卓易通技能能不能开起安卓 App。
