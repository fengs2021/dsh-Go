# 鸿蒙真机构建 / 签名 / 装机 / 验收 手册（v40–v41 实录）

本文件记录在 WSL 上从零把 DSH 鸿蒙 HAP 构建、签名、装进真机并验收的**完整可复现流程与坑**。
所有路径都是本机（fengs-pc）实测可用的路径；命令均为原样可复制。

## 0. 环境事实

| 项 | 值 |
| --- | --- |
| 仓库 | `/mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/dshgo`（partial clone，blob:none），工作树 `/mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/port40`（分支 `port/v40`） |
| hdc | `/mnt/d/tools/hdc-oh/hdc.exe`（**Windows 二进制**） |
| 设备 | `192.168.2.102:45957`（`hdc tconn` 连接；无线调试端口是设备侧 hdc 服务端口） |
| 包名 | `io.github.ccch1mneyyy.dsh_app` |
| 构建用 node | `/root/node-host/bin/node`（24.22.1）、`/root/npm1190/bin/npm`（11.9.0） |
| OHOS SDK | `/root/sdk`（native 在 `/root/sdk/native`，hvigor 6.26.9 / SDK 26.0.0.38） |
| 签名 | HoKit（Windows 应用）+ CDP 远程执行，证书 `hokit_debug` |
| 工作文件夹 | `/mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace`（Windows `D:\Users\liqih\Documents\deepseek-harness\default-workspace`）：仓库 `dshgo`、工作树 `port40`、HAP 产物 `hap-build`、脚本 `scripts`、工具 `tools`、构建中间产物 `build` 全在这里（2026-11-15 从 `/mnt/d/tools/dshgo`、`/root/port40`、`/root/*` 迁入） |
| 构建脚本 | 统一在 `<工作文件夹>/scripts`（`prep43.sh`／`compose43.sh`／`fullhap42.sh`／`probe43.sh`／`v40install.sh` 等，路径已改成新位置）；工具链（`/root/sdk`、`/root/node-host`、`/root/npm1190`、`/root/node-src`、flutter）仍在 `/root` |
| 构建中间产物 | `<工作文件夹>/build/`（`prepared43` 因 drvfs 小文件写入慢仍留在 `/root/prepared43`） |
| 产物目录 | **工作文件夹**下的 `hap-build`：WSL `/mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/hap-build`，Windows `D:\\Users\\liqih\\Documents\\deepseek-harness\\default-workspace\\hap-build`（2026-11-15 从 `D:\\hap-build` 整体迁入，旧路径已不存在；用户要求以后一律在工作文件夹操作） |
| 代理 | `https_proxy=http://127.0.0.1:7890`；git 需 `-c http.version=HTTP/1.1 -c http.postBuffer=524288000` |

## 1. 构建链（三段）

### 1.1 prepare-inputs（准备 DSH 源码与 node_modules）

```sh
bash /root/prepare40.sh        # → /root/prepared40
```

产物：`/root/prepared40/{dsh,process,target-report.json,prepared-inputs.json}`，
DSH 版本取 `runtime/locks/dsh-<版本>/package-lock.json`，必须在 node 24 下 prepare（node 22 会 EBADENGINE）。

### 1.2 compose（把 Node runtime 打成 rawfile zip）

基础版（不带 Linux）：

```sh
python3 runtime/ohos/package/compose-runtime.py --target ohos \
  --dsh-prefix /root/prepared40/dsh --process-prefix /root/prepared40/process \
  --target-report /root/prepared40/target-report.json \
  --prepared-inputs /root/prepared40/prepared-inputs.json \
  --regex-artifact /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/regex40/build/re2js-unicode.mjs \
  --esbuild-prefix /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/port40/runtime/ohos/node/build-tools \
  --imports-report /root/compose40/composition-imports.json \
  --out /root/compose40/composed \
  --node /root/node-host/bin/node \
  --runtime-core /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/port40/app/ohos/entry/src/main/ets/runtime/RuntimeCore.ets \
  --keep-expanded
```

带 Linux 六件资产（v41 起）：

```sh
# 同上，追加：
  --linux-assets /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/linux-images/assets \
  --out /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/compose41/composed
```

**关键**：只有传了 `--linux-assets`，compose 才会把 `linux: libdsh_linux.so` 写进
`nativeLibraries` 并在 `composition-report.json` 里写 `linuxAssets`；
`audit-hap.py` 把 `libdsh_linux.so` 当 optional，所以**缺它不会报错**，
只会在设备上表现为「Linux 环境：暂不可用 + 要求重开 App」（对应
`control.mjs` 的 `ERR_OHOS_LINUX_ASSETS_UNAVAILABLE` 分支）。

### 1.3 打 HAP

```sh
sed -i "s/^version: .*/version: 1.0.31+31/" app/pubspec.yaml
bash tooling/ohos/check-arkts.sh --sdk /root/sdk --work /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/arkts-hap41 \
  --hms-stubs --full \
  --aot /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/aot40/plain \
  --native /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/hap-libs-linux/arm64-v8a \
  --runtime /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/compose41/composed/dsh-runtime-rawfile.zip \
  --node-headers /root/node-src/src
```

- `--aot` 目录必须**预先存在**且含 `arm64-v8a/app.so` + `flutter_assets/AssetManifest.bin`，
  否则 `check-arkts: no such --aot dir`、RC=2。Dart 源码没改时可复用上一版 AOT
  （判断方法：`find app/lib app/pubspec.yaml -newer <aot>/arm64-v8a/app.so`）。
- `--native` 目录要**整套**六件库（libnode/libc++_shared/libdsh_host/libdsh_flock/
  libdsh_require_builtin/libdsh_linux），换线程池会重建。
- 构建耗时长（>10 min），后台进程用 `setsid` 启动：`setsid bash /root/fullhap41.sh > /root/fullhap41.log 2>&1 < /dev/null &`；
  用 `execFileSync` 包一层时即使 60 s 超时报错，子进程也会继续跑，看日志即可。
- 产物：`<work>/app/ohos/entry/build/default/outputs/default/entry-default-unsigned.hap`，
  同目录 `hap-audit.json` 有 `problems: []`、`linuxAssets`、`libs` 等逐项证据。
- execFileSync 必须显式给 PATH，否则 `rm/ls: command not found`：
  `/root/npm1190/bin:/opt/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`。

## 2. 构建 libdsh_linux.so（TinyEMU，仅首次或 TinyEMU 变更时）

```sh
cmake -S runtime/ohos/linux/native -B /root/linux-oh -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE=/root/sdk/native/build/cmake/ohos.toolchain.cmake -DOHOS_ARCH=arm64-v8a \
  -DDSH_TINYEMU_ARCHIVE=/root/tinyemu-dl/tinyemu-2019-12-21.tar.gz \
  -DDSH_NODE_HEADERS=/root/node-src/src \
  -DDSH_NODE_LIBRARY=/mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/hap-libs2/arm64-v8a/libnode.so \
  -DDSH_NODE_RENAME_HEADER=runtime/ohos/node/napi-rename.h \
  -DDSH_OH_SDK_NATIVE=/root/sdk/native
cmake --build /root/linux-oh
/root/sdk/native/llvm/bin/llvm-strip --strip-unneeded libdsh_linux.so
```

- 前提：`libnode.so` 必须是**重命名版**（`llvm-nm -D --defined-only` 里 `dsh_napi_` 有、`napi_` 为 0）。
- tinyemu 归档 sha256 必须是 `be8351f2121819b3172fcedce5cb1826fa12c87da1b7ed98f269d3e802a05555`。
- `build.py` 自己解包 + 按序 `patch -p1` 0001–0016 + `napi_isolation.verify`，不需要预展开源码树。
- strip 后约 185 KB（未 strip 234 KB）；NEEDED 只应含 `libnode.so` 与 `libc.so`。

## 3. 六件 Linux 资产

```sh
tooling/ohos/research/linux-job/prepare-inputs.py --out /root/linux-inputs \
  --alpine-mirror https://repo.huaweicloud.com/alpine
tooling/ohos/research/linux-job/build-image.py --inputs /root/linux-inputs \
  --agent runtime/ohos/linux/guest-agent.py --output /root/linux-tools
tooling/ohos/build-linux-assets.py \
  --diskimage /root/linux-inputs/diskimage-linux-riscv-2018-09-23.tar.gz \
  --alpine /root/linux-inputs/alpine-minirootfs-3.24.4-riscv64.tar.gz \
  --tools-root /root/linux-tools/root \
  --agent runtime/ohos/linux/guest-agent.py \
  --output /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/linux-images
```

固定输入 SHA（脚本会自校验）：
- `diskimage-linux-riscv-2018-09-23.tar.gz` = `808ecc1b32efdd76103172129b77b46002a616dff2270664207c291e4fde9e14`（7,969,810 B）
- `alpine-minirootfs-3.24.4-riscv64.tar.gz` = `010683db6c73b3ad1c334fc8f93f64ae748ef67ae6d69e964929aeaf8517bff3`（3,451,625 B）
- 需要本机 `mke2fs`（`/usr/sbin/mke2fs`）；产出 2×512 MiB ext4 + gzip，约 43 MB。

产物 `/mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/linux-images/assets` 必须**恰好六个文件**（`owner.mjs` 用 `O_NOFOLLOW` 只认这五个 + manifest）：
`bbl64.bin`、`kernel-riscv64.bin`、`tools.block`、`bootstrap.ext4.gz`、`empty.ext4.gz`、`install-manifest.json`。
多一个少一个都会被 `loadLinuxInstallationManifest` 拒绝。

## 4. 签名（HoKit + CDP，全自动，不需要点 GUI）

```sh
# 1) 未签名包必须放在 Windows 侧 D 盘（CDP 表达式里写死 D 盘路径）
cp <entry-default-unsigned.hap> /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/hap-build/dsh-ohos-vNN-unsigned.hap
# 2) HoKit 开着远程调试端口（--remote-debugging-port=9222）
curl -s http://127.0.0.1:9222/json/version     # 期望 Chrome/132.x，ho-kit/1.8.10
# 3) 生成表达式 /mnt/d/tools/hokit-asar/resign-expr-vNN.js（照抄上一版改包名）
cd /mnt/d/tools/hokit-asar && /opt/node22/bin/node cdp.mjs resign-expr-vNN.js
```

- `cdp.mjs`：取 `/json/list` 第一个 page → WebSocket → `Runtime.evaluate`；
  表达式里 `api.auth.getStatus()`、`api.resign.run({appPath})`、`api.resign.onProgress/onResult`（300 s 超时）。
- 成功返回示例：`{"success":true,"data":{"outputPath":"C:\\Users\\liqih\\AppData\\Local\\ho-kit\\sign\\output\\dsh-ohos-v41-unsigned_signed.hap"}}`。
- `taskkill.exe`/`cmd.exe` 在 WSL 的 PATH 里没有；若 9222 已经开着，直接用，不必重启 HoKit。
- `hap-sign-tool.jar verify-app` 在 WSL 下对 /tmp 路径报 `11012005 Not support file`（Windows java 不认 WSL 路径），
  验签请靠真机安装结果判定。

## 5. 装机

```sh
HDC=/mnt/d/tools/hdc-oh/hdc.exe
T=192.168.2.102:45957
$HDC tconn $T                      # 不在 list targets 里时
$HDC -t $T install -r "D:\Users\liqih\Documents\deepseek-harness\default-workspace\hap-build\dsh-ohos-v41-signed.hap"
$HDC -t $T shell "bm dump -n io.github.ccch1mneyyy.dsh_app | grep version"   # 装机后核对 versionCode/Name
```

- hdc.exe 是 Windows 程序：**所有传给它/从它传出的路径都必须是 Windows 路径**（`D:\\Users\\liqih\\Documents\\deepseek-harness\\default-workspace\\hap-build\\x.json`），
  用 WSL 路径会报 `Error opening file: no such file or directory, path:D:\...\tmp\x.json`。
- 应用启动前设备不能锁屏，否则 `aa start` 报
  `Error Code:10106102 The device screen is locked during the application launch`（开发者模式下不会自动解锁）。
- 装机不清理数据：老版本 `/data/storage/el2/base/files/runtime/...` 会保留，排查「怎么还是旧版本」先看 `bm dump`。

## 6. 验收方法（不改代码也能取证）

1. **界面文本抓取**（最有用）：
   ```sh
   $HDC -t $T shell "uitest dumpLayout -p /data/local/tmp/l.json"
   $HDC -t $T file recv /data/local/tmp/l.json "D:\\Users\\liqih\\Documents\\deepseek-harness\\default-workspace\\hap-build\\l.json"
   ```
   然后按 `attributes.text` / `bounds` 读状态；点击用 `uitest uiInput click <x> <y>`
   （坐标取 bounds 中点；页面滚动后坐标会变，**每次点击前重新 dump**）。
2. **App 自身日志**：`$HDC -t $T shell "hilog -x" | grep A0D051`（DSHNode 心跳、danmaku beat）
   与 `grep A03F00`（DshRuntime，含 `getLinuxStatus failed with <code>`）。
3. **进程内存**：`$HDC -t $T shell "cat /proc/<pid>/status | grep -E 'VmRSS|Threads'"`
   —— Linux 开关打开后 RSS 会到 ~1 GB（v40 空跑约 0.3–0.4 GB）。
4. `hilog -x` 里 `aa start` 前后可先 `hilog -r` 清缓冲，减少系统噪声。

## 7. 坑清单（按踩过的顺序）

1. 缺 `--linux-assets` → HAP 里没有 libdsh_linux.so 也没有资产，audit 仍然 OK，只有设备上「Linux 暂不可用」。
2. `--aot` 指向不存在目录 → RC=2、`no such --aot dir`。
3. 后台构建必须 `setsid`；`nohup &` 会被杀。
4. `execFileSync` 不显式给 PATH → `rm/ls: command not found`（`/etc/profile` 还会打印 run-parts 噪音）。
5. hdc 路径必须 Windows 风格（见 §5）。
6. 签名输入包必须在 `D:\Users\liqih\Documents\deepseek-harness\default-workspace\hap-build\`；文件名要与表达式里写的一致（曾因名字不一致报
   `Error opening file: no such file or directory, path:D:\Users\liqih\Documents\deepseek-harness\default-workspace\hap-build\dsh-ohos-v40-unsigned_signed.hap`）。
7. 屏幕锁定会挡住 `aa start`（10106102）。
8. `getLinuxStatus failed with ohos_linux_engine_unavailable` 只是「Node 引擎还没 running」，不是资产问题；
   等引擎起来后再刷新页面即可。
9. 完整退出 App 前 Linux 不会真正停止（开关页有文案提示），验收时别把「状态没立刻变」当成 bug。

## 8. v41 实测结论（2026-11-15）

- HAP：155,638,947 B（v40 为 114 MB），versionCode 31 / versionName 1.0.31，
  `audit-hap: OK`（`problems: []`、`nativeContract.problems: []`），
  `libs` 含 `libdsh_linux.so`（HAP 内 185,544 B），`linuxAssets` 六件哈希与源一致。
- 装机后：设置 · 能力 · Linux 环境 = **「已开启」**，不再出现「暂不可用 / 需要重开 App」；
  App RSS ≈ 984 MB，`hilog` 中 danmaku 心跳正常。

## 9. v42 实测结论（2026-11-15）

### 9.1 AOT 只能来自 CI（本机没有 oh-flutter）

本机 /root/f47（flutter 3.4x）与 /root/flutter 都不是 oh-flutter fork：
在两棵树的 packages/flutter_tools/lib 里 grep ohos_aot_bundle 都是 0 命中。
唯一来源是 GitHub Actions .github/workflows/ohos-compile.yml（工作流 id 416048431，repo fengs2021/dsh-Go）：

- 触发条件只匹配 claude/harmonyos-ohos 与 ohos/**，**port/v42 必须手动 dispatch**：

  ```sh
  TOKEN=$(grep -o "ghp_[A-Za-z0-9]*" /root/.git-credentials | head -1)
  printf %s "{\"ref\":\"port/v42\"}" > /tmp/dispatch.json
  curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
    https://api.github.com/repos/fengs2021/dsh-Go/actions/workflows/ohos-compile.yml/dispatches \
    -H "Accept: application/vnd.github+json" -d @/tmp/dispatch.json -w "%{http_code}\n"   # 期望 204
  ```

- artifact 名绑定 commit sha（ohos-aot-<sha40>），所以**所有改动必须先提交并推送**再 dispatch，
  否则 AOT 与代码 sha 不匹配（App 内 runtimeVersion 与实际 Dart 代码对不上）。
- 产物解包结构：flutter_assets/（191 文件）、arm64-v8a/app.so、native_assets/libs/arm64-v8a/libsqlite3.so。

### 9.2 权威 AOT 组装目录（v42 起）

```sh
cp -a /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/aot42/ohos-aot-<sha> /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/aot42/plain-new
cp /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/aot42/libsqlite3-ohos.so /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/aot42/plain-new/native_assets/libs/arm64-v8a/libsqlite3.so
```

- **必须整个 artifact 拷**，不能只挑 flutter_assets + arm64-v8a：v41 就是这么漏掉 native_assets/ 的，
  结果 HAP 里**没有 libsqlite3.so**（manifest 一直声明），设备上表现为「酒馆打不开」
  （package:sqlite3 在运行时按名字加载动态库，找不到就崩）。
- CI 自带的 libsqlite3.so **是 glibc 版，不能用**：
  NEEDED libm.so.6 / libc.so.6 / ld-linux-aarch64.so.1，strings 含 GLIBC_2.17/2.28/2.29/2.33/2.34。
  正确的那份由 tooling/ohos/build-sqlite3-native.py 用 OHOS NDK 编出：
  NEEDED libc.so、SONAME libsqlite3.so、strings 含 OHOS (dev) clang version 15.0.4、.note.ohos.ident。
- 判据命令（装包前就能查）：

  ```sh
  rm -rf /tmp/h && unzip -o -q <hap> "libs/arm64-v8a/libsqlite3.so" -d /tmp/h
  readelf -d /tmp/h/libs/arm64-v8a/libsqlite3.so | grep NEEDED
  # 通过 = 只有 libc.so（不含 libm.so.6 / ld-linux-aarch64.so.1）
  ```

### 9.3 22 MB 的 AOT 走代理很慢 → 分块并发下载

单连接要 20+ 分钟，curl -C - 续传也慢。可用手法：

1. 先拿带 SAS 的直链（无需鉴权）：
   `curl -sS -o /dev/null -D - -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/fengs2021/dsh-Go/actions/artifacts/<id>/zip | grep -i "^location:"`
2. 再按 Range 12 片并发（脚本 /root/dl-aot42-par.sh：每片 curl -r start-end、失败重试，最后按序 cat）。
3. unzip -t 必须 ZIP_OK；v42 的 artifact 是 **22,271,936 B**。

### 9.4 构建工具链缓存可以搬（省掉 atomgit 龟速下载）

check-arkts.sh 只在 [ -f "$WORK/dl/$2" ] 缺失时才 curl（:132），$WORK 只有 --clean 才 rm -rf（:124）。
所以换 --work 目录时，先把上一版 <work>/dl/ 里的三个包拷进新 <work>/dl/：
hvigor-6.26.9.tgz（16,267,839）、hvigor-ohos-plugin-6.26.9.tgz（33,683,148）、
ohos-arm64-release-artifacts.zip（15,485,641，md5 ef9d1896730d4824175157ff0fdacdea）。
下载卡住时 kill 掉 curl 和父脚本、补文件、重跑即可（缓存复用，不从头再来）。

### 9.5 签名补充

- api.cert.list 报 HTTP 401（[AppGalleryConnectUserAuthService]getTokenInfo return null）**不影响签名**：
  HoKit 用本机缓存好的 hokit_debug 证书完成重签，返回仍是 success:true + outputPath。
- v42 实测约 40 秒完成，签名产物 274,400,119 B（md5 b555bdfc16fda7885fa30f3d0232b2cf）。

### 9.6 v42 产物事实

| 项 | 值 |
| --- | --- |
| 提交 | 94fc94fc（分支 port/v42，84 文件，13967+/1412−） |
| HAP（未签名） | 274,323,138 B，md5 ac1a4eed18d34c9393d95b21d5477569 |
| HAP（已签名） | 274,400,119 B，md5 b555bdfc16fda7885fa30f3d0232b2cf |
| module.json | versionCode 32 / versionName 1.0.32 / compileSdk 26.0.0.38 / API 26 |
| runtime | ohos-4304faae5cb3ac4a61e366c8，files 55,553，bytes 589,627,270，archive 205,333,124 |
| runtime archive sha256 | 6aec90b2a4c69323b06ff6e2a8ea7450bf31aeb9a2c4765caec411d2910273c4 |
| HAP 内 libsqlite3.so | 1,437,800 B，md5 0ea0b5537d71f07326bb31c3705dc5c7（OHOS 版，NEEDED libc.so） |
| audit | audit-hap: OK，证据 /mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/build/arkts-hap42/check-e6sRSGrK/hap-audit.json |

### 9.7 设备侧注意

- 2026-11-15 13:40 起手机 192.168.2.102 从局域网消失（Windows arp -a 无该条目、
  全子网扫描 45957 端口 0 命中、hdc list targets 只剩 [Empty] 与 UART）。
  装机前先确认手机连的 Wi-Fi 与 PC 同网段且「无线调试」开着，否则只有 [Fail]Connect failed。
- 装包命令与验收方法见 §5、§6；「酒馆可打开」的判据是进入酒馆页不弹引擎错误，
  hilog 里没有 sqlite3 / Failed to load dynamic library 报错。
