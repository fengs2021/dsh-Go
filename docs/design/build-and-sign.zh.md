# HAP 构建与签名流水线（可交接版）

本文把「从源码到手机装上」这条链路的**每一步、每个路径、每个前置条件**写死，
换机器 / 换人 / 隔几周回来都能照着跑。2026-11-25 校准。

## 0. 一句话

**AOT 走 GitHub Actions（macOS）→ 本地打未签名 HAP → HoKit（CDP 9222）重签 → hdc 装机。**

## 1. 目录与产物

| 角色 | 路径（WSL） | Windows 等价 |
| --- | --- | --- |
| 工作区 | `/mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace` | `D:\Users\liqih\Documents\deepseek-harness\default-workspace` |
| 源码 worktree | `port71/`（分支 `port/v71`） | `…\port71\` |
| 未签名 HAP | `hap-build/dsh-ohos-vNN-unsigned.hap` | 同 |
| 签名后 HAP | `hap-build/dsh-ohos-vNN-signed.hap` | 同 |
| 构建脚本 | `scripts/fullhapNN.sh` | 同 |
| 签名脚本 | `scripts/signNN.sh` | 同 |
| HoKit 表达式 | `tools/hokit-asar/resign-expr-vNN.js`（仓库里另存 `scripts/resign-expr-vNN.js`） | 同 |
| CDP 驱动 | `tools/hokit-asar/cdp.mjs` | 同 |
| AOT 取回 | `scripts/aot-fetch66.py` | — |
| hdc 客户端 | `tools/hdc-oh/hdc.exe` | 同 |

HoKit 自己的落点是 `C:\Users\liqih\AppData\Local\ho-kit\sign\output\<输入名>_signed.hap`，
`signNN.sh` 再把它复制到 `hap-build/` 并打 md5/sha256。**以 `hap-build/` 的副本为准。**

## 2. 第一步：AOT（Dart 侧产物，必须 macOS 编）

- 工作流：`.github/workflows/ohos-compile.yml`（`runs-on: macos-latest`，`concurrency.cancel-in-progress: false`）。
- 触发：改到 `app/**`、`packages/**`、`tooling/ohos/**` 的 push，或手动
  `gh workflow run ohos-compile.yml -R fengs2021/dsh-Go --ref port/v71`。
- 取回：`GH_BRANCH=port/v71 OHOS_SQLITE3=/root/native66/libsqlite3.so \
  python3 scripts/aot-fetch66.py <commit-sha> /root/bNN/aot --wait 10`
- 校验：`/root/bNN/aot/AOT_COMMIT` 必须与当前 HEAD 的 Dart 一致；`check-arkts.sh --full`
  发现 AOT 比代码旧会直接拒绝。
- **fork 仓库的 Actions 被 GitHub 整体禁用时没有 API 能开**：只能仓库 owner 在
  Actions 页面点「I understand my workflows, go ahead and enable them」。

## 2.5 前置：runtime 是否需要重编（只在 JS/patches 改动时）

AOT 只覆盖 Dart。若上游合入改了 `runtime/patches/`（`series` / `pins.json` / 新 `.diff`），
HAP 内引擎字节必须按新 pins 重编，否则与 pins 不一致。`fullhapNN.sh` 用 v93 起的
runtime 搜索首位 `build/composeNN/dsh-runtime-rawfile.zip`，没有就回退旧 compose。
**判据**：`git diff <上次出包commit>..HEAD -- runtime/patches/ | wc -l` 非零即需重编。

```bash
# 1) 重新准备 npm 输入（fresh npm ci，锁文件 SHA 固定；约几分钟）
bash scripts/prepNN.sh            # → /root/prepNN，看 PREPARE_RC=0 和 receiptSha256
# 2) 应用当前 pins 组成 runtime
bash scripts/composeNN.sh         # → build/composeNN/dsh-runtime-rawfile.zip，看 COMPOSE_RC=0
#    产出 runtimeVersion（如 ohos-38b312bb…），fullhapNN.sh 会自动优先用它
```

从 `prep74.sh`/`compose74.sh` 派生时改 V/OUT/PREP/DEST 即可；`composeNN.sh` 的 runtime
搜索要插到候选首位。`pins.json` 变化大（v93 合入 +751 行）时旧 prep 的 patch SHA 对不上，
必须重新 prep。文档警告的 "OH deletion source changed" 由 `runtime/session-deletion/core.mjs`
与 `bridge/.../session-deletion.js` 的改动触发；没改这两个就不会拒绝（v93 实测 OK）。

## 3. 第二步：打未签名 HAP

```bash
cd /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace
AOT=/root/bNN/aot bash scripts/fullhapNN.sh
# 期望末行：FULLHAPNN_RC=0
```

内部做四件事：编译 ArkTS（`tooling/ohos/check-arkts.sh --full`）、放入 AOT 的
`app.so` 与 `flutter_assets`、放入原生库与运行时、跑 `tooling/ohos/audit-hap.py`
逐项核对 HAP 内容与输入一致。**audit 过了才算包可用，install 成功不算。**

## 4. 第三步：签名（HoKit）

前置三件事，缺一不可：

1. **HoKit 已启动且带调试端口**
   `"C:\Users\liqih\AppData\Local\Programs\HoKit\HoKit.exe" --remote-debugging-port=9222`
   判据：`curl -s 127.0.0.1:9222/json/version` 返回 200（`cdp=200`）。
2. **HoKit 已登录华为开发者账号**（`ho-kit/auth/user_info.json` 未过期）。
3. **表达式在运行目录**：`cp scripts/resign-expr-vNN.js tools/hokit-asar/`
   （仓库只提交 `scripts/` 那份，`tools/hokit-asar/` 是运行时目录）。

执行：

```bash
bash scripts/signNN.sh
# 期望：HoKit 回报 "success": true，产物落到 hap-build/dsh-ohos-vNN-signed.hap
```

脚本里的关键约束：表达式写的是 **Windows 绝对路径**；HoKit 未报 success 一律判失败；
产物不存在也判失败；最后打印 md5/sha256。

## 5. 第四步：装机

```bash
H=tools/hdc-oh/hdc.exe
$H tconn <手机IP>:45957          # 无线调试端口，鸿蒙手机「无线调试」页显示
$H shell "aa force-stop <bundle>"  # 换包前先停
$H install -r hap-build/dsh-ohos-vNN-signed.hap
```

- `-r` = 覆盖安装，**保留应用数据**；`bundleName` 一变就是另一个 App（数据不迁移）。
- 现役 bundleName：`ccchimneyyy.dsh.go`。
- 手机 IP 会漂（随机 MAC）：用 `/24` 扫 `45957` 端口发现，缓存写 `/root/.phone-night.last`。
- 若 `install -r` 或 `file send` 卡住超过 1 分钟：先 `$H shell echo ALIVE` 判断通道——
  shell 正常而传输卡住即文件通道坏，重启整机（`hdc shell reboot`，约 60s 重新上线）后重连重装。
- 一键全链路：`bash scripts/v91-pipeline.sh`（等 AOT→构建→签名→装机→核验，日志 `/root/v91-pipeline.log`，
  终态看 `PIPELINE_RC=`）；复制成 vNN 即可用于下一版。

## 6. 失败对照表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `signNN: CDP ... 不可达` | HoKit 没起 / 没带端口 | 用带 `--remote-debugging-port=9222` 的参数重启 HoKit |
| HoKit 报失败 | 未登录 / 证书过期 / 包名不在 Profile | 重新登录 HoKit；确认 bundleName 与 Profile 一致 |
| `check-arkts: FAILED` + AOT 过期 | Dart 改了没重派 AOT | 推分支 → 派 workflow → `aot-fetch66.py` |
| `install` 报 `[E001005]` / `[Empty]` | 手机不在网 / 熄屏后无线调试掉了 | `tconn` 重连；必要时扫网段 |
| `aa start` 报 `10106102` | 设备锁屏 | `power-shell wakeup` + 上滑解锁 |
| 装了新版但看不到新功能 | 装的是旧包 / 装错 bundle | 核对 md5 与 `bm dump -n <bundle> | grep versionName` |
| AOT run `failure`，job `runner_id:0`、`steps:[]`、排队十几分钟 | **macOS runner 始终没分配**，被 GitHub 排队超时取消，不是代码问题 | 重新 `gh workflow run ...`（可能需重试 2 次）；确认新 run 的 `runner_id` 非 0 且步骤在跑 |
| `aot-fetch66.py` 报某 run `failure/cancelled` 但实际有更新的 run | 脚本原来取同 sha 的第一个 run，被旧的取消 run 挡住 | 已修：跳过 `completed` 且非 `success` 的 run，只在全部失败时才判失败 |
| `install -r` / `file send` 卡住不动、`rc=124`，但 `shell echo` 正常 | hdc **文件传输通道卡死**（shell 通道独立正常）；小文件也传不进去可确认 | shell 用户无权 kill 设备端 `hdcd`，**重启整机**（`hdc shell reboot`）后 `tconn` 重连即恢复 |
| `analyze` 报 `tooling/companion/*.dart` 之类 uri 不存在，但文件在 origin/main 里 | 工作树是 **sparse-checkout**，白名单外的目录 merge 进索引但没落地 | `git sparse-checkout add tooling`（或对应目录），文件落地后错误消失——非合并问题 |
| 整体 merge 后 HAP 里 runtime 与 pins 不一致 | runtime patches 变了但沿用了旧 compose zip | 按 §2.5 重新 prep + compose，确认 audit 里 `runtime identicalToInput=True` |

## 7. 版本记录约定

每出一版写 `hap-build/BUILD-vNN.txt`：分支、HEAD、AOT commit、unsigned/signed 的
大小与 md5、构建与签名时间、`check-arkts`/`audit-hap` 结论。v78 之后的记录缺，需要补。
