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

> ⚠ 编译根不要放工作文件夹（drvfs/9p）：会挂死在 `prepare-sdk.py` 或 `prepare-forks.py` 的 rename 上。
> 固定用 ext4 编译根、只回传 HAP，配方与实测时延见 §10。

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

## 10. 编译根必须放 ext4（2026-11-15 定案，v44 起）

**结论先写**：HAP 编译根不能放工作文件夹（drvfs / 9p），否则不是「慢」而是「必挂」；
编译根固定用 ext4（`/root/b44`、`/root/b45` …），只把最终 HAP 回落到
`<工作文件夹>/hap-build/`。ext4 上整包 **70 秒**，drvfs 上 20 分钟起步且会挂死。

### 10.1 症状（三个不同的失败面）

| 位置 | 症状 | 真因 |
| --- | --- | --- |
| `prepare-sdk.py` | 进程 `state D`、`wchan=p9_client_rpc`，几十分钟不动 | 单条 9p RPC 挂死（不是盘坏：同时刻 dd 4k×200 = 9.9 MB/s 正常） |
| `prepare-forks.py:131` | `PermissionError: [Errno 13] … .fork-stage-xxxx -> …/prepared-forks/webview_flutter_ohos` | Windows 侧不允许 rename 覆盖已存在目录 |
| `hvigor` 整体 | 20+ 分钟，热缓存也不快 | 每次全树 sha256 校验 14k 文件 + 小文件海量读写 |

### 10.2 正确配方（fullhap44c.sh / fullhap45.sh）

前置：把输入件与工具链缓存搬进 ext4 编译根，**只搬一次**，之后按目录存在就跳过：

```bash
export HOME=/root JAVA_HOME=/mnt/e/tools/ohbuild/jdk TMPDIR=/root/tmp45
export PATH=/root/node-host/bin:/root/sdk/native/llvm/bin:/usr/local/bin:/usr/bin:/bin
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890

mkdir -p /root/b45/work
# ① 下载 + fork 克隆缓存必须从上一版编译根复制过来（ext4→ext4 秒级）
[ -d /root/b45/work/dl ] || cp -a /root/b44/work/{dl,embedding,tools} /root/b45/work/
[ -d /root/b45/work/dl ] || cp -a /root/b44/work/sdk-hms-* /root/b45/work/ 2>/dev/null
# ② runtime zip（compose 产物）拷进来
cp -f <WS>/build/compose46/dsh-runtime-rawfile.zip /root/b45/runtime.zip

cd <WS>/port40
bash tooling/ohos/check-arkts.sh --sdk /root/sdk --work /root/b45/work --hms-stubs --full \
  --aot /root/b44/aot --native /root/b44/native \
  --runtime /root/b45/runtime.zip --node-headers /root/node-src/src
```

产物：`/root/b45/work/check-XXXX/app/ohos/entry/build/default/outputs/default/entry-default-unsigned.hap`
（`check-XXXX` 每次随机，用 `ls -t /root/b45/work | head -1` 取最新），再 `cp` 到
`<WS>/hap-build/dsh-ohos-vNN-unsigned.hap` 签名。

### 10.3 缓存里必须保留 dl/forks

`dl/forks/*` 是 7 个鸿蒙 fork 的 git 克隆（11 MB）。不搬进新编译根时，
check-arkts 会去 atomgit promisor 远端补对象并失败：

```
fatal: could not fetch a367f93f… from promisor remote
check-arkts: clone failed: https://atomgit.com/oh-flutter/flutter_packages.git image_picker-v1.2.1-ohos-1.0.1
```

### 10.4 实测时延

| 阶段 | drvfs | ext4 |
| --- | --- | --- |
| 工具链缓存搬迁 | — | 33.8 s（一次性） |
| 全量打包（hvigor + AOT + native + 205 MB runtime + audit） | ≥20 min，中途挂死 | **70 s** |
| 大文件回传 drvfs | 145 MB/s（rsync 实测） | — |

## 11. v43–v45 实测结论（2026-11-15）

### 11.1 Linux 环境「出错了」的真因（v44 取证）

设备上 App 私有目录**可读**（此前认为读不到是错的）：`hdc shell`（uid 2000）能读
`/data/app/el2/100/base/io.github.ccch1mneyyy.dsh_app/files/`；只有
`files/linux-tools/`（`drwx------ 20020326`）读不到。
引擎进程 stderr 落在 `files/dsh-runtime/engine.log`（含 `[linux]` 诊断行），
不必依赖 hilog —— ArkTS 侧不打日志，`hilog | grep linux` 一直是空的。

v44（1.0.34+34，含 `[linux]` 诊断）engine.log 第 4299–4300 行：

```
[linux] install start instance=51e92b3d-… attempt=979d24e4-…
[linux] install failed … ownerState=cancelled-before-vm
  ERR_OHOS_LINUX_RECOVERY_REQUIRED: The retained Linux instance has no confirmed clean close;
  automatic overwrite is forbidden
```

结论：不是镜像损坏、不是内存不足。`files/linux-tools/` 里留着上一次没有干净关闭的实例
（`instance.json` 停在 `booting`/`active`），`openLinuxInstance()` 按安全契约拒绝覆盖 ⇒ 每次启动
都失败，UI 停「出错了」+ restartRequired。`hdc install` 强杀旧进程正是制造这种残留的元凶。
`files/linux-tools` 的 mtime 停在 v41 最后一次成功（10:04），之后 v42/v43 再没写进过任何东西。

修法（提交 733a60bf，v45 起生效）：`control.mjs` 的 `#install` 捕获「残留实例类」错误码
（`ERR_OHOS_LINUX_RECOVERY_REQUIRED` / `INSTANCE_CORRUPT` / `RETAINED_INSTANCE` /
`ASSET_GENERATION` / `IMAGE_INTEGRITY` / `TARGET_IDENTITY` / `DIRECTORY_IDENTITY`）后调用
`instance.mjs` 新增的 `quarantineRetained()`，把旧实例整体改名成
`.quarantine-YYYYMMDD-HHMMSS-<原名>`，再用新 owner 重试一次；`moved.length===0` 则原样抛出。
自愈必须放 control 层而不是 owner 层——`linux-instance.test.mjs:64`、
`linux-instance-process.test.mjs:79,91` 断言 owner 必须拒绝（created/downloads 均为 0）。

### 11.2 v43 / v44 / v45 产物事实

| 版本 | versionCode | runtimeVersion | HAP 未签名 | HAP 已签名 | 说明 |
| --- | --- | --- | --- | --- | --- |
| v43 | 33 / 1.0.33 | — | — | 已装 16:06 包 | 无任何 Linux 侧日志，取证不可用 |
| v44 | 34 / 1.0.34 | ohos-ec90025405e15ff7a04aafa7 | 274,324,190 B / md5 430368b6a81d04078fe33497198ef1b0 | 274,400,117 B / md5 25c13eed3951cd38c53bda1dbed8bac2 | 只带 `[linux]` 诊断日志，取到真码 |
| v45 | 35 / 1.0.35 | ohos-d0378a6e4d61d36a1c72cb4e | 274,324,991 B | 274,400,119 B / md5 92a4c20de68bbbbcf0ed3cdaf45685e8 | 含 733a60bf 隔离自愈；**2026-11-15 17:50 装机时手机掉线，尚未验证** |

`runtime.zip` 从 v41 的 87,458,968 B / 12,425 条目涨到 205,335,121 B / 55,554 条目，
是因为 rc.3 的 npm 包里带 `src/*.ts`；HAP 因此从 155 MB 涨到 274 MB。

### 11.3 hdc 装机的两个硬坑

1. 目标列表同时有 TCP 与 USB serial 时必须显式指定：
   `hdc.exe -t 192.168.2.102:45957 install -r dsh-ohos-vNN-signed.hap`，
   否则 `[Fail]ExecuteCommand need connect-key? please confirm a device by help info`。
2. 不要在别的 cwd 里传 Windows 绝对路径——会被拼到当前 cwd 后面
   （`D:\…\workspace\D:/Users/…` no such file）。先 `cd <WS>/hap-build` 再传相对文件名。

## 12. Dart 改动怎么进包：AOT artifact 工作流（2026-11-15 v47/v48 定案）

### 12.1 事实：app.so 不在本机产生
- `tooling/ohos/check-arkts.sh` 只做 `cp "$AOT/arm64-v8a/app.so" "$LIBS/libapp.so"`（第 362 行附近），**不编译 Dart**。
- app.so 来自 GitHub Actions `.github/workflows/ohos-compile.yml`（`runs-on: macos-latest`，`flutter assemble -dTargetPlatform=ohos-arm64 -dBuildMode=release … ohos_aot_bundle_release_ohos-arm64`），产物名 `ohos-aot-<sha40>`。
- 本机是 WSL2 x86_64，oh-flutter 只发布 macOS 版 `gen_snapshot`/`frontend_server`，Linux 版快照格式对不上（`app/ohos/README.md` 宿主表）→ **本机编不了，只能等 CI**。
- 只改 `runtime/` 里 JS 的改动走 compose + `runtime.zip`，不需要新 AOT；**改 `app/lib`、`app/pubspec.yaml`、`packages/` 必须换 AOT**。

### 12.2 症状：改了 Dart 但界面没变（v47 踩过）
v46 与 v47 的 `libs/arm64-v8a/libapp.so` md5 完全相同（`226421fb…`），新代码字符串（如 `tavern-model-channel-`）在包内 grep 不到。看包就能判定，不必装机。

### 12.3 正确配方
1. 推代码到 fork 的 `port/v42`，触发（或手动 Run workflow）`OHOS compile`；
2. `python3 <WS>/scripts/aot-fetch.py <commit-sha> /root/aot<NN> [--wait MINUTES]`：轮询 run、下载 artifact、解压、写 `AOT_COMMIT`，并**自动把 `native_assets/libs/arm64-v8a/libsqlite3.so` 换成鸿蒙版**（见 12.4）；
3. `check-arkts.sh --full --aot /root/aot<NN> …` 打包（`scripts/fullhap48.sh` 是模板：编译根在 ext4，55 s）；
4. 拿包核对：`unzip … libs/arm64-v8a/libapp.so` 后 `strings | grep <新符号>` 与 md5；再签名装机。

### 12.4 坑：CI artifact 里的 libsqlite3.so 是 glibc 版
新 artifact 的 `native_assets/libs/arm64-v8a/libsqlite3.so`（1,870,928 B，md5 `d931376102ee2946d61cffb86cd1fb41`）在 macOS runner 上链了 glibc，`audit-hap` 直接失败：
`libsqlite3.so needs libc.so.6, outside the set and the SDK sysroot`、`needs ld-linux-aarch64.so.1`、大量 `@GLIBC_2.17` 未解析符号。
必须用鸿蒙版覆盖：`<WS>/build/ohos-native/libsqlite3.so`（1,437,976 B，md5 `fb0662179b9a0171dc6cb18f777be5de`，来自 `tooling/ohos/build-sqlite3-native.py`）；进包 strip 后是 1,437,800 B md5 `0ea0b5537d71f07326bb31c3705dc5c7`。`aot-fetch.py` 已自动做这一步（扫 native_assets 下所有 .so，命中 `libc.so.6` 且不是 sqlite 就报错停）。

### 12.5 守卫（防止再发旧 UI）
`check-arkts.sh --full` 在 AOT 存在性检查之后加了陈旧守卫：`$AOT/AOT_COMMIT` 存在且该 commit 在本仓库可解析时，若 `git log --format=%h $aot_commit..HEAD -- app/lib app/pubspec.yaml packages` 非空就直接 `die`（提示重跑 workflow）；没有 `AOT_COMMIT` 的老 AOT 退化为 `find … -newer app.so` 只告警。

### 12.6 v46–v48 产物
| 版本 | 版本号 | unsigned md5 | signed md5 | libapp.so md5 | 说明 |
| --- | --- | --- | --- | --- | --- |
| v46 | 1.0.36+36 | `f0254fbd87355d09765ac5f0bd941cc2` | `a3c056e7b823c874bef1f4c39ff39230` | `226421fb5dd4399445b767007706c9ed` | runtime 加 script 能力；Dart 仍是 v42 的 |
| v47 | 1.0.37+37 | `8acf64c4901434303b3f1b2bfac8e038` | `5491cfd5c485e77e28501590c62b82a8` | 同上（**作废**） | 舞台渠道代码没进包 |
| v48 | 1.0.38+38 | `91b2016fdd8fee80c05a3c8f54fb26c9` | `19338ca433984b914b15446021b9e166` | `5d36a41aa393b3100de33560ab42f890` | AOT from run 43715353136 (f9e60bfd)，含舞台渠道 |

## 13. v48 真机验证（2026-11-15 22:09，versionCode 38）

装包：`cd <WS>/hap-build && <WS>/tools/hdc-oh/hdc.exe -t 192.168.2.102:45957 install -r dsh-ohos-v48-signed.hap` → `install bundle successfully`（覆盖 v46/v47，数据目录保留）。

证据（`uitest dumpLayout` 读屏原文）：

| 检查点 | 读屏结果 |
| --- | --- |
| 舞台 · 本局 · 正在用 · 模型 | `Text "模型\nWB Proxy · hy4-preview" [212,803,1266,978]`（v47 之前只有 Flash / V4 Pro 两颗胶囊） |
| 点开模型行 | 弹层 `Header "模型"` → `Header "官方 DeepSeek"`：`Flash`、`V4 Pro`；`Header "WB Proxy"`：`hy4-preview`（带 ✓）、`hy3`、`deepseek-v4.1-flash` |
| 未填密钥提示 | 行下 `未填，去「模型服务」填`（`tavernProviderKeyMissing` 分支生效） |
| 设置 · 能力 · Linux 环境 | `Text "Linux 环境"` + `Text "已开启"` |
| 系统操作 | `系统操作 已开启` |

引擎日志（`/data/app/el2/100/base/io.github.ccch1mneyyy.dsh_app/files/dsh-runtime/engine.log`，可读）证明隔离自愈在真机生效：

```
[linux] install start instance=26f5a81b-… attempt=448694e2-…
[linux] retained Linux instance quarantined code=ERR_OHOS_LINUX_RECOVERY_REQUIRED moved=.quarantine-20261115-124…-installation-IpgdjF
[linux] install failed instance=2ddc1c92-… ownerState=stopped-quarantined ERR_OHOS_LINUX_INSTALL_TIMEOUT: Guest did not confirm opening before install deadline
[linux] install start instance=26f5a81b-… attempt=448694e2-…
[linux] install ok backend=opened instance=26f5a81b-…
```
即：残留实例被改名隔离 → 新实例首次尝试在 180 s 内没等到 guest 确认（`ERR_OHOS_LINUX_INSTALL_TIMEOUT`，首次装镜像的正常现象）→ 再开一次即 `install ok backend=opened`。同一次启动里还有 `[phone-hdc] probe ok 1874ms`、`[phone-probe] dump ok 1154ms screen=1320x2848`。

踩点记录（读屏操作两个坑）：
- `uitest uiInput click` 返回 `No Error` 但界面没变时，先截图核对；再连点会点到刚弹出的弹层遮罩把它关掉（我因此误判"点了没反应"）。
- 舞台面板里的「模型」行必须在面板滑出后再点（`y≈899`），坐标是设备像素（1320×2848），与 `uitest dumpLayout` 的 bounds 同一坐标系。

## 14. v48 全功能回归（2026-11-15 22:13–22:29，versionCode 38）

装的是 v48（1.0.38+38），App 当前连远程主机 fengs-pc。逐页点检方式：`uitest dumpLayout` 读屏 + `uitest uiInput click` 点按 + `snapshot_display` 截图，脚本在 `<WS>/tmp/{sweep,seq,step,say}.mjs`。

| 区域 | 结果 | 证据 |
| --- | --- | --- |
| 工作模式对话 | 正常（本会话即跑在手机上） | 会话详情「共 6 轮 / 步骤 240」，消息流与工具卡片实时刷新 |
| 设置 · 模型 | 正常 | `fengs-pc · 远程 · 4 个渠道 · 4 个可用`；官方 DeepSeek 已配置；自定义 minimax-cn / ZCode 积分 / WB Proxy（OpenAI 兼容 · 13 个模型） |
| 设置 · 模型 › WB Proxy | 正常 | `可用 · 127.0.0.1`、`API Key / 已保存`，点「测试连接」→ `连接正常 · 列出 21 个模型` |
| 设置 · 权限 | 正常 | 当前对话四档 + 新对话默认；页脚「系统操作也按这里的权限询问」 |
| 设置 · 个性化 | 正常（内容少） | 只有「工作方式 / Agent 预设」 |
| 设置 · 系统操作 | 正常 | 已开启；「当前连的是远程主机 / 系统操作只在本机引擎的对话里有效」 |
| 设置 · 联网搜索 | 正常 | `fengs-pc · 远程`、新版搜索 API、DeepSeek 搜索 Key 已配置、每次最多搜 5 次 |
| 设置 · 图像与视频 | 主机缺插件 | 「这台主机还没有图像与视频插件 / 在此主机上安装」（远程主机侧没装，非 App 缺陷） |
| 设置 · Linux 环境 | 正常，已开启 | 三档网络代理；「开着 Linux 时 App 大约多占 100 MB 以上内存」；engine.log 本轮无新的 ERR_OHOS_LINUX_* |
| 设置 · 插件 | 正常 | 49 个；顶部提示「fengs-pc · 远程 · 经中转只能开关，安装请在那台电脑上进行」 |
| 设置 · 外观 | 正常 | 对话字号 小/标准/大/特大；主题 雾蓝·跟随系统；完成后收起过程 |
| 酒馆 · 书架 | 正常 | Header「酒馆」+ 四 tab；继续 / 角色（林晚 示范·悬疑·日常） |
| 酒馆 · 对话 | 正常 | 会话列表（9 条 / 1 条消息），新建群聊 |
| 酒馆 · 资源库 | 正常 | 预设 1 个、世界书/正则/默认人设/快速回复 未设置 |
| 酒馆 · 我的 | 正常 | 模型来源＝自定义渠道；渠道 WB Proxy / hy4-preview；**渠道密钥「未填」** |
| 舞台 · 本局 | 正常 | 用量（提示词 2713 / 缓存命中 33% / 回复 700 / 约 US$0.0007）、模型、思考、人设、预设、世界书、外观 |
| 舞台 · 状态 | 正常（空态） | 「这张卡还没有状态 / 卡里定义了状态以后…」 |
| 舞台 · 导演 | 正常 | 自动导演开关 + 「让导演想一想」 |
| 舞台 · 本回合 | 正常 | 提示词 543 / 缓存命中 0% / 回复 175；「这回合没有条目被触发」 |
| 舞台 · 模型选择器 | 正常 | 两组：官方 DeepSeek（Flash / V4 Pro）、WB Proxy（hy4-preview✓ / hy3 / deepseek-v4.1-flash）；选中后舞台与用量同步 |
| 排版三态 | 正常 | 气泡 → 小说（多出「跟随酒馆设置」行）→ 视觉小说（会话里出现角色状态条 11/11、1/1）→ 切回气泡 |
| 掷骰 | 正常 | 1d20 → `🎲 1d20 掷出 14`，可换骰型/个数/加值、再掷一次 |
| 生成（官方 Flash） | 正常 | 输入 hello → 发送 → 新回复「…"hello"这个词在雨镇可不常听见…」；用量从 1476/17%/510 涨到 2713/33%/700 |
| 伙伴小屋 | 正常（空态） | 「把她接回家 / 导入素材包」；「素材只存在这台手机上，聊天走当前主机」 |
| 引擎日志 | 干净 | ERR_ 累计仍是 21 条：INSPECTOR_NOT_AVAILABLE x8、ENCODING_NOT_SUPPORTED x8（gbk）、LINUX_RECOVERY_REQUIRED x7、LINUX_INSTALL_TIMEOUT x1，全是本轮之前的老记录 |

### 14.1 回归里发现的两个真问题

1. **酒馆选了远程主机的自定义渠道一定发不出去，且提示词误导**（功能缺陷，v47/v48 引入）
   - 现象：舞台/我的都显示「WB Proxy · hy4-preview」，点「接着写」只弹一条 `先在设置里填 DeepSeek API Key`（`tavernErrorNoKey`），不提渠道名，也不说这条渠道其实配了 Key。
   - 根因一（代码事实）：`app/lib/state/provider_keys.dart` 顶部注释与实现——自定义渠道的 Key 只存**手机本地** Keystore（`provider_key_<id>`），「远程主机激活时输入的 Key 只进那台主机，绝不留在本地」；`tavern_provider.dart:55-58` 从该 vault 取 key，取不到就 `TavernFailure.noKey`。远程会话下 vault 必空 → 必然失败。
   - 根因二：`TavernModelConfig.baseUrl` 是主机上的 `http://127.0.0.1:9100/v1`（`packages/dsh_tavern/lib/src/api.dart:361-388`，`model_client.dart` 直连），手机上的 127.0.0.1 是手机自己，即使填了 Key 也连不上主机 loopback。
   - 结论：酒馆自定义渠道只在「本机引擎 + 手机可达地址（如 `http://192.168.x.x:9100/v1`）+ App 表单录入 Key」三者同时成立时可用；远程主机渠道目前只是能选、不能用。可选修法：把酒馆请求改成经主机引擎中转，或按「手机是否可达」过滤渠道清单。

2. **真机自动化注入中文会失败**（工具限制，非 App 缺陷）
   - `uitest uiInput text "…"` 传中文返回 `No Error` 但输入框没内容，界面改弹系统「请点击系统粘贴按钮，允许本次读取剪贴板」；ASCII（`hello`）正常。
   - 以后测中文输入走剪贴板 + 「粘贴」按钮，或直接用 ASCII 验证链路。

## 15. 让 billion-context 压缩代理在手机上真的跑起来（2026-11-15 23:11 → 11-16 00:04，v50–v53）

billion-context 的「原生插件模式」是让代理进程住进客户端里：插件在运行期自己 spawn 一个 proxy 子进程并指向 `http://127.0.0.1:<port>`。手机侧一开始一直报「当前 dsh 进程未绑定 bili 代理」，因为三道鸿蒙沙箱门依次挡住，v50/v52/v53 逐个打开。

### 15.1 三道门（按被挡的顺序）

| # | 症状（原文） | 出处 | vNN 修法 |
| --- | --- | --- | --- |
| 1 | `bili: cannot find a Node runtime to spawn the proxy (this process is not Node) — set BILLION_CONTEXT_NODE` | 插件 `dist/agent/dsh-native.js` 的 `resolveNodeRuntime()` 用 `basename(process.execPath)==='node'` 判断 | v50：`runtime/ohos/process/child-process.mjs` 把 `process.execPath`/`process.argv[0]` 虚拟化成 `/dsh-go/ohos/bin/node`（该路径早在 `command-router.mjs` 的 `isNode` 表里 → spawn 走 `pluginNode` 车道） |
| 2 | `EACCES: 工作目录不在授权工作区内`（`runtime/ohos/process/runtime.mjs` 校验 `spec.cwd`） | 插件 spawn 不传 cwd，facade 回落 `process.cwd()` | v51：facade 默认 cwd 取授权工作区之一 |
| 3 | `EACCES: OHOS_SANDBOX_DENIED: Node script entry is outside the authorized roots` | `runtime/ohos/process/node-script.mjs:99` 要求脚本入口在 roots 内，而代理脚本在 `…/profiles/web/node_modules/billion-context/dist/` | v52：新增 `scriptRoots(roots, extra)`，把 `profileDirectories`（插件安装树）并入脚本入口与 worker fs 的可读根；`command-router.mjs` 的 `pluginNode` 传 `pluginRoots` |
| 4 | `bili: failed to start: EACCES: OHOS_SANDBOX_DENIED: Node script path is outside its authorized workspace…`（栈顶 `node-worker-paths.mjs` ← `ensureConfigTemplate` ← `dist/index.js`） | worker 内被 patch 的 fs 还要读写 `$HOME/.config/billion-context/`、`$HOME/.local/state/billion-context/` | v53：`command-router.mjs` 导出 `pluginHelperRoots() = [...profileDirectories, process.env.HOME]`（只放宽「插件助手可读写」，会话 cwd 仍受 roots 限制） |

### 15.2 成功证据（v53，真机）

```
文件：/data/app/el2/100/base/io.github.ccch1mneyyy.dsh_app/files/runtime/rootfs/root/.local/state/billion-context/bili.log
2026-11-16T00:04:20.772 [info] [v=0.1.212] acp-proxy v0.1.212 (pid 12890) listening on http://127.0.0.1:18787
   — web UI: http://127.0.0.1:18787/__bili/ — zero-config: prefix any baseURL with http://127.0.0.1:18787/bili/ — MITM proxy on (whitelist)
之后持续：[conn#N] tcp closed reason=idle-timeout age=… reqs=17   ← 有真实请求走过
计数：grep -ac 'acp-proxy v0.1.212' = 8 次启动；grep -ac 'proxy bootstrap failed' = 3077（全部是历史累计）
```

用户 00:06 确认「刚才的页面就是 bili 的设置页面」，不再出现「未绑定」提示。压缩代理子进程日志在 `<app>/cache/dsh-runtime/ohos-process/bili-proxy-<port>.log`（`/data/storage/el2/base/cache/…` 是同一位置但 shell 读不了，要用 el2/100/base 那条）。

### 15.3 v50–v53 产物

| 版本 | pubspec | runtimeVersion | unsigned md5 | signed md5 |
| --- | --- | --- | --- | --- |
| v52 | 1.0.42+42 | ohos-aad2af02794a892b7df12415 | f93d3454995042b34487f665e9b09ea1 | 36c54eb7afc118356d1a89a98b9d3dda |
| v53 | 1.0.43+43 | ohos-97634bf3a258d5801dfb04a4 | 6aaf212aff74bf53ba1bf27fef303dd3 | 744116529649e70b443796513a64e5cc |

（v50/v51 见提交 a35eae7c 与 v51 日志；v52 起 compose50/compose51 + fullhap52/fullhap53，仍走 /root/b44 的 native 与 /root/aot50 的 AOT，构建 60 s 级。）

### 15.4 教训

- 插件「原生模式」在鸿蒙上的阻力不在插件本身，而在我们自己的进程沙箱：**execPath 身份、脚本入口白名单、worker fs 根、cwd** 四个面各有一道检查，插件会依次撞上。排查顺序照上表从上往下走，一轮只解一道。
- 放宽可读根时坚持「会话写权限不放宽」：`pluginHelperRoots` 只给插件助手（`pluginNode` 车道），普通会话 node 仍用 `canonicalRoots`。
- 插件中文文案在 `dist/agent/dsh-native-client.js` 里是 \uXXXX 转义字典（`var zh = {...}`），grep 中文字面量永远 0 命中——查文案直接看字典对象。

## 16. 让压缩代理的上游转发真的通：WebAssembly → node:http dispatcher（2026-11-16 00:10–00:46，v54–v55）

### 16.1 症状链
| 轮次 | 现象 | 原因 | 修法 |
| --- | --- | --- | --- |
| v53 | `502 "acp-proxy failure: unknown <private-host>"`，bili.log：`fetch failed <- WebAssembly is not defined … proxy=direct` | 插件用自己的 bundled undici，`new Agent()` 要实例化 llhttp 的 WASM；手机端引擎无 `WebAssembly` | — |
| v54 | 同上（全局符号发布没被用到） | `fetchWithTimeout` 里 `dispatcher: opts.dispatcher ?? directDispatcher(...)` **永远显式传 dispatcher**，绕过 `Symbol.for('undici.globalDispatcher.1')` | 改它的取用点 |
| v55 | `WebAssembly` 报错归零，请求真正转发 | `patchBundledTransport()` 把 `new import_undici.Agent({…})` 换成「优先用 `Symbol.for('dsh.go.ohos.net').dispatcher`」 | ✅ |

- 关键源码（手机端 `…/profiles/web/node_modules/billion-context/dist/index.js`）：
  `function fetchWithTimeout(url,opts,timeoutMs,externalSignal,forceDirect){ … dispatcher: opts.dispatcher ?? directDispatcher(idleTimerDelayOverrideMs ?? effective) … }`；
  `function directDispatcher(timeoutMs){ … agent = new import_undici.Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs, ...(ca ? { connect: { ca } } : {}) }) … }`。
- 它那份 undici 的 `require_global.js` 只认 `Symbol.for('undici.globalDispatcher.1')`，且 `lazyllhttp()` 只有 `UNDICI_NO_WASM_SIMD` 一个开关（SIMD/非 SIMD 两条路都要 WebAssembly），**没有任何环境变量能关掉 WASM**。

### 16.2 两处改动
1. `runtime/ohos/net/fetch.mjs`：新增 `publishUndiciDispatcher(dispatcher)`，把我们的 dispatcher 挂到 `Symbol.for('undici.globalDispatcher.1')` 与 `…2` 上。**只顶替「本来就没人用」或「undici 默认 Agent」的位置**，已有显式主人就放弃（`published:false`）。遇到的坑：undici 定义这两个属性为 `writable:true, configurable:false`，再 `defineProperty` 会抛 `TypeError: Cannot redefine property`，必须用普通赋值。
2. `runtime/ohos/process/vendor-patch.mjs`（新文件）：`patchBundledTransport(filename)` 在插件子进程启动前给它 bundle 里那段 `new import_undici.Agent({…})` 打补丁，改成
   `agent = globalThis[Symbol.for('dsh.go.ohos.net')]?.dispatcher ?? (new import_undici.Agent({…}))`，
   并以 `/* dsh-ohos:transport */` 标记幂等；写 `<file>.dsh-vendor` 再 rename 覆盖。接线点在 `runtime/ohos/process/node-script.mjs` 脚本入口校验通过之后。
   - 只对白名单后缀生效（当前 `/billion-context/dist/index.js`）；找不到锚点只记 `[ohos-vendor] no transport anchor in …`，不动文件。
   - 第 1 处（全局符号）本身不解决 billion-context，但保留：对「用全局 fetch 的自带 undici 插件」有效且无副作用。

### 16.3 测试
- `runtime/tests/ohos/vendor-transport-patch.test.mjs`（4 例）：打补丁 / 重复调用 cached / 无锚点 skipped / 非目标文件 undefined。
- `runtime/tests/ohos/net-undici-global-dispatcher.test.mjs`（5 例）：每例起干净子进程并**动态** `import`（静态 import 会先把符号定义成 non-configurable）。含「已有显式 owner 就让位」「重复 install 幂等」「非 OHOS 不动全局」。
- 四个文件合并：`node --test runtime/tests/ohos/vendor-transport-patch.test.mjs runtime/tests/ohos/net-undici-global-dispatcher.test.mjs runtime/tests/ohos/node-script-entry-roots.test.mjs runtime/tests/ohos/plugin-helper-roots.test.mjs` → **12 pass / 0 fail**。
- 既有 `net-proxy-env.test.mjs`（20 fail）、`net.test.mjs`、`net-bootstrap.test.mjs` 需要真机 preload，改动前后结果一致，非回归。

### 16.4 真机证据（v55，1.0.45+45）
- 重启后代理第 10 次 listening；设备上 `dist/index.js` `grep -c 'dsh-ohos:transport'` = 1，原锚点 = 0。
- bili.log 最后一条 `WebAssembly is not defined` 停在 **00:30:37（第 8074 行）**，00:38 之后 `[error]` 为 0；`forward POST → https://…/v1/chat/completions` 正常发出，00:40:11 出现 `[acp-usage] input=38554 cached=3840 (cache hit 10%)` —— **压缩代理的上游转发真的通了**。
- 累计计数（含历史）：`forward POST` 189、`upstream request failed` 158、`WebAssembly is not defined` 154、`upstream 524` 17。

### 16.5 剩下的 524 是网关侧（不是 App）
- 现象：多个会话同时 `← upstream 524`：`{"title":"Error 524: A timeout occurred", "zone":"wbtx.fengs.fun", "detail":"The origin web server did not return a complete response within the 120-second Proxy Read Timeout window…"}`，另有 `upstream awaiting first byte ≥30s` 与 `upstream-reset (pre-response network failure): fetch failed`。
- 独立取证（PC 上直连该网关，不带 key，看 TTFB）：`GET /v1/models` 返回 401 的 TTFB 采样 **23.9 s / 6.7 s / 3.1 s / 2.3 s / 2.2 s**，还夹一次连接失败（`code=000`）；同一时刻 `api.deepseek.com` 的 401 TTFB 是 **0.11 s / 0.19 s**。
- 结论：Cloudflare 边缘到源站（用户自建网关 wb-proxy / cloudflared / nginx 那条链）本身就慢，>120 s 就会回 524。App 侧只能做重试与提示，根治要在网关。
- 另有 `[degenerate-turn] plugin-passthrough-openai: turn ended length (max-output) with zero visible text and zero tool calls (thinking present)` —— 中转模型把额度全花在思考上、没吐正文，属模型/中转行为。

### 16.6 产物
| 版本 | 版本号 | runtimeVersion | unsigned md5 | signed md5 |
| --- | --- | --- | --- | --- |
| v54 | 1.0.44+44 | `ohos-c4b25566fe0fa2b656b5cbb4` | `a79b27c4cfa728fa55be76fb960abed3` | `f108e247d5d231a056b914ac12ff8149` |
| v55 | 1.0.45+45 | `ohos-1981436a1cd172953cb7e172` | `6a9983a41057d784e82b814e9690211e` | `d223fc9933fcd61cad923104c05a3b31` |

构建脚本：`scripts/compose52.sh`（v54）/ `compose53.sh`（v55）、`scripts/fullhap54.sh` / `fullhap55.sh`；签名表达式 `tools/hokit-asar/resign-expr-v54.js` / `resign-expr-v55.js`。

## 17. 手机端截图要落在「会话工作区」而不是进程 cwd（2026-11-16 07:4x，v56）

- 现象：会话里 AI 用 `mcp__phone__ui action=shot` 截图，有时能看见、有时报写不进目录；同一个会话里又想把手机文件 `cp` 进工作区，报 `EACCES: 路径不在工作区或本次运行的临时目录内`。用户在轨迹里贴出的结论是「shot 存到 `process.cwd()/phone-shots`，而引擎进程 cwd 是沙箱根 `/`，不可写」。
- 根因：`runtime/ohos/phone/ui-tools.mjs` 原来写 `const shotDir = () => path.join(process.cwd(), 'phone-shots')`。引擎进程 cwd 不保证是会话工作区（真机上常是 `/`），因此 `mkdir` 直接被拒，图留在手机侧，模型的 `read_image` 永远读不到。
- 修法（v56，`runtime/ohos/phone/ui-tools.mjs`）：
  - 新增 `resolveShotDir(workspace)`：只要传进来的是绝对路径就用它，否则退回 `process.cwd()`；`shotDir(context)` 从中取。
  - 工具注册处新增 `sessionWorkspace(exec)`，从 `exec.agent.session.header.cwd`（`@deepseek-ai/dsh-session` 的 `SessionHeader.cwd`，会话创建时的绝对工作目录）取工作区；`execute(args, exec)` 把它传给 `definition.run(args, { workspace })`。
  - 动作表改成工厂 `uiActions(context)`，`shot` 与 `script` 里套的 `shot` 都带上下文；写盘失败时返回 `shot_failed` 并说明「截图拿到了 N 字节但写不进工作区 <目录>」，不再静默丢图。
  - 成功时 data 变成相对工作区的路径（如 `phone-shots/shot-1794786391865.jpg`），配 `read_image` 直接可读。
- 测试：`runtime/tests/ohos/phone-ui-tools.test.mjs` 18 → **20 例**，新增「截图目录跟着会话工作区走」「sessionWorkspace 从上下文取 cwd」两例；`node --test` 20 pass / 0 fail。
- 产物：v56 = 1.0.46+46，runtimeVersion `ohos-63cb03ea26c6daaec797ff38`，unsigned `1fef496646702146c10a7c3a679b32ba`（274,339,861 B）、signed `a958095992be3f806919257c1056aa41`（274,416,503 B）；装机后设备上 `files/dsh-runtime/tree/runtime/ohos/phone/ui-tools.mjs` 含 `resolveShotDir`（`grep -c` = 2），即新运行时已生效。
- 顺带记下两条硬事实（不要重复踩）：
  - `/data/local/tmp` 是 `drwxrwx--x 7 shell shell`（0771），App 进程（uid 20020326）连列目录都不行，只能按确切路径读 0644 的单个文件；所以「bash 把设备文件搬进工作区」走不通。
  - 完全权限（`danger-full-access`）只决定审批，不放开路径；路径围栏在 `runtime/ohos/process/runtime.mjs:80`（`this.roots = 工作区 + 临时目录`）与 `runtime/ohos/process/filesystem.mjs:44`（那条中文 EACCES 的出处）。

## 18. 手机端 read_image 为什么报 OHOS_IMAGE_CODEC_UNAVAILABLE，以及怎么在无 sharp 的平台上把图交给模型（2026-11-16 v57）

### 18.1 现象
v56 装机后，手机本地会话里 `mcp__phone__ui action=shot` 已经把截图落到会话工作区 `phone-shots/shot-<ts>.jpg`（v56 修的就是这个），但紧接着的 `read_image` 直接失败：

```
Error: unreachable variant: "OHOS_IMAGE_CODEC_UNAVAILABLE"
```

### 18.2 根因：三条路径都要 sharp，而鸿蒙没有 sharp
`read_image` 在引擎里走 `@deepseek-ai/dsh-attachment-local`：`saveImage`（`prepareImageFile` → `inspectMetadata` → `detectImage` → `normalizeImage`）与随后发请求时的 `readImageRequest` → `createRequestImage`。这三处都调 `requireSharp()`；而 `runtime/patches/zzzzzzzzzzzz-ohos-composition.diff` 早先把这个函数在 `process.platform === "openharmony"` 下改成「直接抛 `OHOS_IMAGE_CODEC_UNAVAILABLE`」。所以不是像素超限，也不是字节超限，是**根本没有解码器**。

### 18.3 修法：只读图像头 + 原字节直通
新增补丁 `runtime/patches/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-ohos-image-facts.diff`（必须排在 `zzzzzzzzzzzz-ohos-composition.diff` 之后，因为它改的是后者引入的 `loadSharp`/`requireSharp` 文本），在 `dsh-attachment-local/lib/index.js` 里做四件事：

| 位置 | 鸿蒙分支 | 说明 |
| --- | --- | --- |
| `probeImage` / `detectImage` | 纯 JS 读 JPEG marker 流（SOI→SOF 取宽高，APP1/APP2/APP13/COM 记 `carriesMetadata`）与 PNG chunk 流（IHDR 取宽高/位深/色彩类型，acTL→animated，eXIf/iCCP/tEXt/zTXt/iTXt→metadata，tRNS→alpha） | 不再需要 sharp；坏头报 `INVALID_IMAGE`，非 JPEG/PNG 报 `OHOS_IMAGE_CODEC_UNAVAILABLE` 并说明「请先转成 JPEG/PNG」 |
| `normalizeImage` | 限额内直接返回原字节，不重编码 | 超限报错并给出「先裁小图片」的可行做法 |
| `createRequestImage` | `data.byteLength <= target.maxBytes` 时返回原字节 | 跳过缩放/缓存；超限才报错 |

`sourcePipeline`（`:998`）与 `normalizeImage` 的重编码分支在鸿蒙上永远不会被走到，因此整条链路不再触碰 sharp。

### 18.4 补丁怎么进包（顺序与登记是硬约束）
1. `runtime/patches/series` 末尾**必须**登记新补丁 —— 应用顺序以 `series` 为准，文件名里的 z 只是历史习惯，不再是排序依据。
2. `runtime/patches/pins.json` 的 `targetSets.ohos` **必须**加入补丁名，否则 `patch-dsh` 直接失败：`patch target registration mismatch: unregistered=[...]`。
3. 录入 pin：`HOME=/root python3 -I -B runtime/lib/rtbuild.py patch-dsh --prefix <dsh tree> --dsh-version 0.2.2-rc.3 --target ohos --patches runtime/patches --out /tmp/pin-out.json --target-report /tmp/pin-report.json --record`；输出里会打印每个文件的 `before -> after`，其中 `before` 必须等于上一个补丁的 `after`（本次 `dd15efce9b5b -> 2da6f48979d7`，链条连续）。
4. 改完 node_modules 树以后，旧 `prepared-inputs.json` 作废：`compose-runtime.py` 会报 `Prepared dsh input bytes/file set changed after its recipe ran`，必须重跑 `prepare-inputs.py`（`scripts/prep46.sh`，全量约 2.5 分钟）再 compose。

### 18.5 产物（v57，未装机：设备 08:35 起离线）
| 版本 | runtimeVersion | unsigned | signed |
| --- | --- | --- | --- |
| 1.0.47+47 | `ohos-7b192a15aa2cf081d2baecae` | `dsh-ohos-v57-unsigned.hap` 274,341,574 B md5 `664d7b5f6cc7590557035806bd251e0a` | `dsh-ohos-v57-signed.hap` 274,416,503 B md5 `dc99c24951914e0aa37bdb35ca88b2b5` |

构建：`scripts/prep46.sh` → `scripts/compose55.sh`（payloadFiles 55,555，`archiveBytes` 205,342,102）→ `scripts/fullhap57.sh`（08:30:52→08:31:56，`FULLHAP57_RC=0`，`audit-hap: OK`，work `/root/b57/work/check-L7lUqkcS`）→ HoKit 签名（`tools/hokit-asar/resign-expr-v57.js`）。

### 18.6 已知取舍
- 手机端**不能**缩放/重编码图像：超过归一化上限（2048×2048 像素 / 4 MB）或超过模型路由上限（DeepSeek 路由默认 2 MB）的图会被拒绝并提示「先裁小或用连接电脑的会话」。
- 元数据不剥离（EXIF/XMP/ICC 原样随图发出），因为剥离需要重编码。真要在手机上脱敏，得等一个鸿蒙原生的图像库。
- 只支持 JPEG/PNG；WebP/GIF 仍报 `OHOS_IMAGE_CODEC_UNAVAILABLE`。

## 19. 手机端 read_image 的第二道门：附件落盘为什么要 fsync 到 /data（2026-11-16 v58）

### 19.1 现象
v57 装机后，手机本地会话里 `ui · shot` 成功写出 `phone-shots/shot-1794791755443.jpg`，紧接着 `查看图片` 报：

```
Error: Unable to persist attachment.
```

即解码那一道门（§18）已经过了，卡在把图**持久化**到附件库。

### 19.2 根因：耐久边界的兜底值是「文件系统根」，而手机上 /data 不可读
`@deepseek-ai/dsh-attachment-local/lib/index.js` 的落盘链是
`saveImage` → `commitPreparedImageFile` → `stageImmutableObject` → `publishStagedObject`，
其中第一步都要 `ensureDurableHome(dirname(dirname(root)))`（`root = DSH_HOME/attachments/v1`，于是 home 就是 `DSH_HOME`）。

`ensureDurableHome` 原本这样选耐久边界（`:581`）：

```js
const directRoot = globalThis[Symbol.for("dsh.go.direct")]?.root;
const boundary = typeof directRoot === "string" && (home === directRoot || home.startsWith(directRoot + "/")) ? directRoot : parse(home).root;
```

兜底值 `parse(home).root` 就是 `/`，于是 `ensureDurableDirectory` 会从 `DSH_HOME` 一路向上，对每个祖先目录做
`open(dir, O_RDONLY)` + `handle.sync()`，包括 `/data/storage/el2/base/files/runtime/rootfs/root`、`…/files`、`…/el2/base`、`/data/storage`、`/data`、`/`。

手机上的 `/data` 是 `drwxrwx--x root:system`（other 只有 x 没有 r），应用进程 `open("/data", O_RDONLY)` 直接 **EACCES** →
`ensureDurableHome` 抛错 → 外层统一包成 `AttachmentError("Unable to persist attachment.", "ATTACHMENT_WRITE_FAILED", { cause })`，
而 UI 只显示最外层 message，所以看不到 EACCES。

这也解释了「会话能存、附件不能存」：会话 checkpoint 走的是 publication 服务（只 publish，不做祖先目录 fsync），
只有 attachment-local 这条链会一路 sync 到 `/`。

### 19.3 修法（补丁 `zzzz…zz-ohos-attachment-persist.diff`，54 个 z）
| 位置 | 修法 | 理由 |
| --- | --- | --- |
| `ensureDurableHome` | `process.platform === "openharmony"` 时 `boundary = home` | 应用无权读 `/data`；DSH_HOME 自身已经由安装/首次创建负责，不向上 sync |
| `syncDirectory` | 鸿蒙分支 try/catch：失败只打 `[attach] skipped directory fsync path=… code=…`，不抛 | 目录 fsync 是耐久性优化，不该让保存失败 |
| 三处 `ATTACHMENT_WRITE_FAILED` | 抛之前 `logPersistFailure(where, error, detail)` → `[attach] persist failed where=alias|stage|publish code=… message=… detail=…` | UI 只显示外层 message，把 cause 写进 engine.log（`<app>/files/dsh-runtime/engine.log`） |

补丁顺序与登记仍是硬约束（见 §18.4）：`series` 末尾登记、`pins.json` 的 `targetSets.ohos` 加名、用**纯净树**（`runtime/locks/dsh-0.2.2-rc.3` + `npm ci` 到 `/root/pristine47`）跑 `patch-dsh --record`，链条 `2da6f48979d7 -> 8e618d29b831` 连续。

### 19.4 顺手修的构建缺陷：陈旧 AOT 守卫自己会 141
守卫里原本是 `git log … | head -3 | tr '\n' ' '`。脚本带 `set -euo pipefail`，一旦 `git log` 的输出超过 3 行，
`head` 先退出 → `git` 收到 SIGPIPE（141）→ pipeline 141 → `set -e` 直接结束脚本，
表现为 `FULLHAP58_RC=141` 且**日志里一行解释都没有**（v57 时刚好只有 3 行所以没暴露）。
改成 `git log -n 3 --format=%h …`（不让 `head` 提前关闭管道）。

### 19.5 产物（v58，设备离线未装机）
| 版本 | runtimeVersion | unsigned | signed |
| --- | --- | --- | --- |
| 1.0.48+48 | `ohos-9d03124a23a22e747e1b9d16` | `dsh-ohos-v58-unsigned.hap` 274,341,919 B md5 `9e8a58c100e98f6698e1d50b13cecb7b` | `dsh-ohos-v58-signed.hap` 274,416,503 B md5 `9a571d507281551875e1caf0cecf506a` |

构建链：`scripts/prep47.sh`（45 s，dshFiles 93,691）→ `scripts/compose56.sh`（payloadFiles 55,555，`archiveBytes` 205,342,447）→ `scripts/fullhap58.sh`（09:29，61 s，`FULLHAP58_RC=0`，`audit-hap: OK`，versionCode 48，work `/root/b58/work/check-ZKDRlADh`）→ HoKit 签名（`tools/hokit-asar/resign-expr-v58.js`）。

### 19.6 验收判据（下次连上设备时）
1. `grep -a "\[attach\]" <app>/files/dsh-runtime/engine.log` → 期望**没有** `persist failed`；若有，读它的 `code=` 直接定位。
2. 会话里 `ui · shot` → `read_image phone-shots/shot-*.jpg` 应当能真正看到图（此前必然 `Unable to persist attachment.`）。
3. 顺带验证：手机端上传普通文件（`saveFile`）此前同样会失败，这次应当也恢复。

## 20. 会话自己读引擎日志：mcp__engine__log（2026-11-16 v59）

### 20.1 为什么要一个工具
v58 验收时用户在会话里想 grep 一下 [attach] 行，结果 $DSH_HOME 下 find 是空的：会话里的 bash 走虚拟文件系统（runtime/ohos/process/filesystem.mjs），只放行**会话工作区**与**本次运行的临时目录**，<filesDir>/dsh-runtime/engine.log 在两者之外。而引擎进程自己读得到——这个文件就是 ArkTS 宿主写的（app/ohos/entry/src/main/ets/runtime/PersistedRuntimeLog.ets:43，1 MB 滚动到 engine.log.1）。

所以「读日志」必须做成工具：工具在引擎进程内用 node:fs 读，绕开虚拟 shell 的路径围栏；同时避免把 1 MB 日志复制进工作区（save 只在你明确要一份副本时才写）。

### 20.2 日志路径怎么找（不写死，三条线索）
`runtime/ohos/phone/engine-log.mjs` 的 `engineLogPaths(env)`，按可靠性排序：

| 顺序 | 线索 | 说明 |
| --- | --- | --- |
| 1 | `DSH_GO_ENGINE_LOG` | 完整路径，宿主目前不设，留给以后（测试也用它注入） |
| 2 | `DSH_GO_OHOS_LINUX_DIRECTORY` 的兄弟目录 | 宿主每次注入 `= <filesDir>/linux-tools`（`host_core.cpp:328`），所以 `<filesDir>/dsh-runtime/engine.log` 直接可得 |
| 3 | 从 `DSH_HOME` 往上 8 层 | `DSH_HOME = <filesDir>/runtime/rootfs/root/.dsh`，向上必然经过 `<filesDir>` |

`resolveEngineLog()` 只认**真的存在**的候选；`engine.log` 不在但 `engine.log.1` 在也算找到（刚滚动过）。`action=path` 会把每个候选按 `字节数 / 缺失` 列出来，路径这类问题一眼就能定位。

### 20.3 工具动作
| action | 参数 | 行为 |
| --- | --- | --- |
| `tail` | `lines`（默认 200，上限 2000） | 文件末尾若干行，报「末尾 N 行（文件共 M 行）」 |
| `grep` | `pattern`（正则，写坏自动退回字面量）、`limit`（默认 100，上限 500）、`ignoreCase`、`includeRotated`（默认 true） | 带行号的命中行；默认连 `engine.log.1` 一起找，命中数分文件统计 |
| `path` | — | 列出候选路径与大小 |
| `save` | `lines` | 把末尾若干行写进**会话工作区** `engine-log-<ts>.log`，之后 bash/grep 就能直接看这份副本 |

只读，不进审批表（`asked` 里没有它）。正文单次上限 96 KB、单行 2000 字符；超限时**截尾不截头**（日志里最新的才是现场）。

### 20.4 挂载与测试
- 注册在已有的 `phone` 插件里（`runtime/ohos/phone/index.mjs` 的 `apply()` → `registerEngineLogTool(ctx)`），**不动宿主**：`RuntimeCore.ets:53` 与 `host_core.cpp:314` 的固定入口表不新增条目，省一次 ArkTS 侧改动风险。
- `runtime/tests/ohos/engine-log-tools.test.mjs` 13 例（本机可跑）：路径线索顺序、只认存在的文件、`tail`/`grep`/`path`/`save` 四个动作、坏正则回退、超长行与超限正文截断、空 pattern 与未知 action 报 `invalid_args`、读不了文件报 `log_unreadable`。与既有 ohos 测试合跑 45 pass / 0 fail。
- 一个刻意的顺序：**参数错误先判**，不要因为本机恰好没有日志文件，就把「action 写错」报成「找不到日志」。

### 20.5 产物（v59，设备离线未装机）
| 版本 | runtimeVersion | unsigned | signed |
| --- | --- | --- | --- |
| 1.0.49+49 | `ohos-7ec3c1e522365524b2815971` | `dsh-ohos-v59-unsigned.hap` 274,347,216 B md5 `5f5d0d8b97363604aec855176b864fc0` | `dsh-ohos-v59-signed.hap` 274,424,695 B md5 `c3f839a0fa6a11de76e37694dd067270` |

构建链：`scripts/compose57.sh`（payloadFiles 55,556，`archiveBytes` 205,347,744）→ `scripts/fullhap59.sh`（10:04:07→10:05:12，`FULLHAP59_RC=0`，`audit-hap: OK`，`archiveSHA256` `a5ea938f7d5e636907b8a21e5d944bcbd00fb4da329231e3e1b7d61dad45a4ec`，`identicalToInput: true`，work `/root/b59/work/check-yDSO4giQ`）→ HoKit 签名（`tools/hokit-asar/resign-expr-v59.js`）。

### 20.6 验收判据（下次连上设备时）
1. 会话里问「引擎日志里有没有 attach 报错」→ 模型应调用 `mcp__engine__log` `action=grep` `pattern` 为 `\[attach\]`，返回带行号的命中行或明确「没有匹配」。
2. `action=path` 的第一个候选应当形如 `/data/app/el2/100/base/io.github.ccch1mneyyy.dsh_app/files/dsh-runtime/engine.log`。
3. `action=save` 后工作区出现 `engine-log-<ts>.log`，会话 bash 能 grep 这份副本。

## 21. 插件「import 即崩」不再等于插件消失：能力垫片（2026-11-16 v60）

手机是「本机引擎 + Web GUI（ArkWeb）」的精简运行时：`icu_small` 只有 utf-8 编码、没有 inspector。症状很刺眼——上架插件在模块加载期就抛（`new TextDecoder('gbk', {fatal:true})` 写在顶层、`import inspector from 'node:inspector'` 也在顶层），插件从界面上直接消失。桌面侧灵枢给了两例热修（dshmarket 改用 `createRequire` 取 inspector、better-sidebar 把 GBK 解码器改成惰性工厂）和一份 6 条建议。本节记录**在 dsh-go 侧**核验与落地的是哪一半。

### 21.1 结论先行

| 队友建议 | 我的判定 | 处置 |
| --- | --- | --- |
| P0-1 能力垫片（缺 builtin / 旧编码 → 惰性失败） | **成立，真正的解锁点** | 已落地 `runtime/ohos/plugins/shims.mjs`，v60 起随宿主加载 |
| P0-2「`did not activate` 只有一行无主 warning，没有插件名/错因/栈」 | **不成立**（见 21.2） | 不改代码，只补 grep 配方 |
| P1-3 preflight 扫描 / P1-4 状态机 / P2-5 热修资产化 / P2-6 背 full-icu | 有价值但成本高、收益靠后 | 暂不做，记为后续 |
### 21.2 先纠正一条误判：engine.log 里本来就有插件名和栈

队友看到的是首行 `dsh: warning: 2 entries did not activate`，据此判断「没有插件名、没有错因、没有栈」。源码不是这样：
- `node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:5264`：`if (failures.length > 0) warn(activationDiagnostic(binName, failures));`，而 `auditStartupEntries(ctx, binName, warn = (line) => void process.stderr.write(line))` —— **默认 sink 就是 stderr**，在手机上即 `files/dsh-runtime/engine.log`。
- `inactiveDiagnostic({entry, outcome}, stacks = true)`（:5207）返回 `${entry.options.id} (${entry.options.name}): ${detail}`，`detail` 由 `failureDetail` 拼 `phase: ` 加 `formatActivationError(error, stacks)`（:5068，递归展开 `value.stack ?? value.message` 与 `cause`）。
- 设备侧历史证据对得上：engine.log 里 `ERR_INSPECTOR_NOT_AVAILABLE` 8 次、`ERR_ENCODING_NOT_SUPPORTED`（gbk）8 次，正是这两条链的产物。

所以不新增「结构化事件」也能定位是哪个插件、在哪个阶段崩的。会话里直接查：

```
mcp__engine__log action=grep pattern=did not activate
mcp__engine__log action=grep pattern=ERR_INSPECTOR_NOT_AVAILABLE
mcp__engine__log action=grep pattern=ERR_ENCODING_NOT_SUPPORTED
```

真正的残余缺口是**界面可见性**（插件页徽标）与机器可读事件，两者都在 Web 前端 bundle 里，不是 runtime 能顺手修的。
### 21.3 垫片做了什么

`runtime/ohos/plugins/shims.mjs`：

1. **builtin 存根**：`node:inspector` / `node:inspector/promises` 在运行时缺失时（用 `createRequire` 探测，抛 `ERR_INSPECTOR_NOT_AVAILABLE` 即判定缺失）用 `module.registerHooks` 的 resolve 钩子把它们指到一段 **data: URL** 的 ESM 存根。存根导出名齐全（`url`/`open`/`close`/`waitForDebugger`/`Session`/`console`），探测型 API 返回 `undefined`（`url()` 恒为 undefined，于是「有没有调试器」判成否），真要用才抛 `ERR_DSHGO_BUILTIN_UNAVAILABLE`。插件顶层 import 不再炸，能力按需失败。
2. **惰性 TextDecoder**：仅在 `new TextDecoder('gbk')` 会抛 `ERR_ENCODING_NOT_SUPPORTED` 的机器上安装（full-icu 的桌面不受影响）。utf-8 完全委派原生实现；非 utf-8 构造不抛，`decode()` 时才抛同名错误（带 `.encoding`/`.cause`），于是 GBK 退化成个别乱码，而不是整个插件崩掉。同时替换 `globalThis.TextDecoder` 与 `require('node:util').TextDecoder`。
3. **每次生效写一行** `[ohos-shim] …` 进 engine.log，会话可自查；`DSH_GO_NO_OHOS_SHIMS=1` 可整体关掉，全局标记保证幂等。

**一个必须记住的实测坑**：resolve 钩子里必须放过 `require` 条件 —— `const conditions = context?.conditions; if (!Array.isArray(conditions) || conditions.includes('require')) return nextResolve(specifier, context);`。否则 `require('node:inspector')` 被短路到 `data:` 会炸在 `node:internal/modules/cjs/loader` 的 `loadBuiltinWithHooks`（`TypeError: Cannot read properties of undefined (reading 'exports')`），比原来的错误更糟。CJS 侧保持原样：插件用 `createRequire` 加 `try/catch` 的写法本来就能兜住。

接线在 `runtime/ohos/plugins/preload.mjs` 最前面（`process.platform === 'openharmony'` 分支的第一件事），因为垫片必须早于任何插件 import。

### 21.4 测试
`runtime/tests/ohos/plugin-compat-shims.test.mjs` 9 例（本机可跑）：三态探测、存根源码内容、全可用时不注册钩子、ESM 短路与 require/条件缺失的 passthrough、`registerHooks` 缺失时降级、`createLazyTextDecoder` 的委派/惰性抛错/fatal/标签、`installEncodingShims` 三种返回、以及**子进程真跑**一段 `import inspector, { Session } from 'node:inspector'` 的插件代码，验证拿到的是存根而不是崩溃。与既有 10 个 ohos 测试合跑 **99 pass / 2 fail**；两个 fail 是环境性既有问题（`plugin-package-harness.mjs:16` 的 `resolve(undefined)`），在加载本改动之前就崩。

### 21.5 产物（v60，设备离线未装机）
| 版本 | runtimeVersion | unsigned | signed |
| --- | --- | --- | --- |
| 1.0.50+50 | `ohos-bb21f83be5af4f52af44ae73` | `dsh-ohos-v60-unsigned.hap` 274,350,980 B md5 `cc314ac1e21c761e336ab1af7387cc73` | `dsh-ohos-v60-signed.hap` 274,428,789 B md5 `f162f9d777e602aed62ad17e6a9407c1` |

链路：`scripts/compose58.sh`（payloadFiles 55,557，比 v59 多出 shims.mjs；`archiveBytes` 205,351,508）→ `scripts/fullhap60.sh`（`FULLHAP60_RC=0`，`audit-hap: OK`，`archiveSHA256` `90f8974980a705ef46ceadb3ba7e5f1b43521e1bc269ce62effd123034a20e65`，`identicalToInput: true`，work `/root/b60/work/check-DqXOdv9z`）→ HoKit 签名（`tools/hokit-asar/resign-expr-v60.js`）。

### 21.6 验收判据
1. `engine.log` 出现 `[ohos-shim] node:inspector is missing in this runtime` 与 `[ohos-shim] TextDecoder shim installed` 两行 → 垫片装上了。
2. 之前自动失活的插件（dshmarket / better-sidebar）在插件页恢复为可启用状态，不再从列表消失；`dsh: warning: N entries did not activate` 的 N 下降。
3. GBK 场景下界面文字退化为乱码，但插件活着（原来整插件崩）。
4. 关掉垫片可复现原症状：`DSH_GO_NO_OHOS_SHIMS=1` 时日志出现 `[ohos-shim] disabled by DSH_GO_NO_OHOS_SHIMS`，行为回到 v59。

## 22 会话体检工具 mcp__engine__sessions 与手机端重试预算（v61）

动机：用户问「鸿蒙 dshgo 的最新对话为什么这么慢」，但 App 抽屉里那条会话属于「未分组」，Remote 桥只能按 workspaceId 读，永远拿不到；同时 `files/` 下的子目录已变成 0770（shell uid 2000 无组关系），hdc 侧连 `engine.log` 都读不了。结论：**只能让引擎自己读自己的会话日志**，于是给 phone 插件加了第三个工具。

### 22.1 为什么「读个日志文件」不够
- 会话落在 `<DSH_HOME>/sessions/<工作区哈希目录>/<session-id>/session.v4.jsonl.zstd`。它不是按工作区索引的：cwd 未注册成工作区的会话（App 里的「未分组」）同样在这棵树里，只是目录名不同 —— 这就是工具能看见 Remote 看不见的会话的原因。
- 文件是**多帧 Zstandard 拼接**，每个持久化检查点一帧。Node 的 `zstdDecompressSync` 与 `createZstdDecompress()` 流**都只解第一帧**（实测 2 MB 文件只得到 319 B = 首行 header）。必须自己走帧结构：`scanZstdFrames()` 依 frame header + block header 逐帧求 `{start,end}`（魔数 `0xFD2FB528`，`descriptor & 24` 为保留位），再对每帧单独 `zstdDecompressSync`。同样的扫描逻辑在 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `scanZstdFrames()` 里（`:1304`），本工具内联了一份，不依赖引擎包解析。
- 行格式：首行 `{"type":"session","version":4,"id":…,"cwd":…,"createdAt":…}`，其后每行 `{"type":…,"seq":N,"time":<ms>,"data":{…}}`。耗时全靠 `time` 差值。

### 22.2 工具动作（`mcp__engine__sessions`）
| action | 参数 | 返回 |
| --- | --- | --- |
| `list`（默认） | — | 全部会话（最多 200 条，按文件 mtime 倒序）：id / 轮数 / 尝试数 / 失败数 / 标题（首个非系统提示的用户消息，最长 60 字）|
| `timing` | `session`（省略=最新）、`slowMs`（默认 20000）| 每轮 `startedAt`/`endedAt`/`durationMs`/步数/每次尝试时长与失败原文；`slowest` 前三名；行里 ≥ 阈值的打 `⚠慢` |
| `events` | `session`、`lines`（默认 60，上限 500）| 末尾 N 条事件的时间 + 类型 + data 摘要（单次正文上限 64 KB）|

错误码：`sessions_unavailable`（没有 DSH_HOME/DSH_GO_SESSIONS_DIR）、`sessions_not_found`（目录空或 id 不存在）、`invalid_args`、`sessions_failed`。参数校验放在路径解析**之前**，避免「动作写错」被误报成「没有会话」。

实现：`runtime/ohos/phone/sessions.mjs`（纯逻辑，全部导出便于单测）；注册走 `registerSessionsTool(ctx)`，与 `mcp__engine__log` 同层，只读、不进审批表；`sessionWorkspace(exec)` 复用 ui-tools 的取法。手机侧读会话不受 `runtime/ohos/process/filesystem.mjs` 的路径围栏限制，因为工具直接在引擎进程里 `fs.readFileSync`。

### 22.3 手机端重试预算：5 → 1
`runtime/patches/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-ohos-retry-budget.diff`（55 个 z，排最后）：
```js
const DEFAULT_MAX_RETRIES = openharmonyDefaultMaxRetries();
function openharmonyDefaultMaxRetries() {
	if (process.platform !== "openharmony") return 5;
	const raw = Number.parseInt(process.env.DSH_OHOS_MAX_RETRIES ?? "", 10);
	return Number.isInteger(raw) && raw >= 0 && raw <= 5 ? raw : 1;
}
```
理由（实测）：会话 `session-618b6fc0` 的第 5 轮，6 次尝试（1+5 重试）在 120 s 的 Cloudflare 上游超时后面排队，从 16:40:24 拖到 16:51:33，**797 秒零输出**。重试在这里不是韧性，是把一次卡死放大成十几分钟。桌面/CI 行为不变（`process.platform !== "openharmony"` 直接 5）；需要更多重试可用 `DSH_OHOS_MAX_RETRIES`。

### 22.4 产物（v61，1.0.51+51）
| 项 | 值 |
| --- | --- |
| runtimeVersion | `ohos-5418455ce3f8888cd9b33b47`（payloadFiles 55,558，+sessions.mjs）|
| 构建链 | `scripts/prep48.sh` → `scripts/compose59.sh`（`COMPOSE_RC=0`，archiveBytes 205,357,752）→ `scripts/fullhap61.sh`（`FULLHAP61_RC=0`、`audit-hap: OK`、versionCode 51 / 1.0.51、`archiveSHA256` `e5c9bce8fd03a96523c9db83f4bb0849f05baebd50a1f7dff188fa9eee036717`、`identicalToInput: true`、work `/root/b61/work/check-pL07rh9A`）|
| unsigned | `<WS>/hap-build/dsh-ohos-v61-unsigned.hap` 274,357,224 B md5 `696c7b241c9e3cf66397310ed66db281` |
| signed | `<WS>/hap-build/dsh-ohos-v61-signed.hap` 274,432,884 B md5 `1e3aaf54db4d9cfa723e33b6b4ca71cf`（`tools/hokit-asar/resign-expr-v61.js`）|
| 装机 | `cd <WS>/hap-build && ../tools/hdc-oh/hdc.exe -t 192.168.2.102:45957 install -r dsh-ohos-v61-signed.hap` → `install bundle successfully` |

### 22.5 验收判据
1. 会话里问「列一下本机会话」→ 工具返回的清单**包含 App 抽屉「未分组」里的会话**（如「起点读书福利中心任务」），这是 Remote 桥做不到的。
2. 对含失败的会话跑 `action=timing` → 每轮给出秒数与每次尝试的失败原文，慢轮带 `⚠慢`。
3. 造一次必然失败的请求（例如把渠道接口地址改成不通的域名）→ 引擎日志里 `llm/retry` 只有 1 次、界面约 2 分钟内出错误，而不是 13 分钟空转。

### 22.6 两条环境坑（本轮踩到）
- 设备锁屏时 `aa start` 报 `Error Code:10106102 … The current mode is developer mode, and the screen cannot be unlocked automatically`：**必须让用户手动解锁**，脚本无法代劳。
- `hdc shell` 偶发返回 `Check in the settings whether the current device is in developer mode…`，同一目标重试即恢复（不是设备真的不可用）。

## 23. 原生思考链翻译（v62）

### 23.1 现象与真正的缺口
用户在网页端装了 `dsh-think-translate`（思考链翻译），手机上装了同名插件却**没有任何翻译效果**。
原因不是插件坏了，而是它属于 **web 渲染层插件**：它靠 `window.__ModuleLoader__` + React + `document` 往网页 DOM 里插翻译胶囊；
DSH-Go 鸿蒙 App 的聊天界面是 **Flutter 原生渲染**，没有 DOM、也没有那个挂载点，装多少份都不会生效。

反过来，App 侧的原生实现其实**早就写完了**，缺的只是引擎侧的服务：

| 位置 | 已实现的内容 |
| --- | --- |
| `app/lib/state/cot_translation_state.dart`（153 行） | `cotTranslationProvider` 取 `cotTranslationLimits()`；`reasoningTranslatorProvider` 调 `translateReasoning(text, targetLanguage, provider, sessionId)`；`ReasoningTranslation`（按段落顺序翻译、按原文缓存、失败保留原文可重试）|
| `app/lib/ui/chat/widgets/thinking_pill.dart` | `:740` 读 limits、`:721` 建翻译器、`:810` 长按胶囊进「思考链翻译」设置 |
| `app/lib/ui/engine_settings/namespace_copy.dart:103` | `cot-translation` 命名空间的 `provider`（bing/google/deepseek-account/deepseek-official）与 `targetLanguage`（auto=跟随界面语言）文案 |

客户端调的两个 RPC（`cotTranslation.limits` / `cotTranslation.translate`）由官方插件 `@deepseek-ai/dsh-experimental-client-ui-cot-translation` 提供，
它依赖的翻译服务由 `@deepseek-ai/dsh-experimental-translator` 提供。**这两个包本来就随 runtime 打进包里了**（runtime.zip 里有 646 条 cot 相关条目），
只是没有任何东西去 `ctx.plugin` 它们 —— 网页端靠 profile bundle 的 `cordis.patch.yml` insert 两行，手机端没有 npm/profile bundle 这条路。

### 23.2 为什么不去改 C++ 的入口表
手机引擎的插件入口写死在 native：`app/ohos/entry/src/main/cpp/host_core.cpp` 的 `WriteProfile` 往 `ohos-host.patch.json` 里写固定 insert 列表
（ohos-subprocess / ohos-sandbox / ohos-lifecycle / **ohos-phone** / ohos-capabilities / dsh-go-bridge），`argv` 再加 `--patch <profile>`。
新增一个入口要同时改 ArkTS（`RuntimeCore.ets:53` 的 validateManifest 固定表）与 C++，而本机编不了 native —— 所以**挂在我们已有的 `ohos-phone` 插件里**。

### 23.3 实现（`runtime/ohos/phone/cot-translation.mjs`，101 行）
- `startCotTranslation(ctx, options)`：动态 `import()` 两个官方包 → 取 `.default` → `ctx.plugin(Translator, {provider})` → `ctx.plugin(CotTranslationController, {provider, targetLanguage})`。
  子 fiber 随宿主插件 fiber 级联销毁，不需要额外停机代码。
- 默认 **provider=bing、targetLanguage=auto**。理由：translator 只认四个 provider，匿名的只有 bing/google，
  实测 bing（`edge.microsoft.com/translate/translatetext`）0.45 s 返回 `用户要求翻译思维。`，google（`translate.googleapis.com`）国内 20 s 超时不可达；
  `auto` 让 controller 接受客户端每次请求带的目标语言（App 按界面语言算）。
- 可用环境变量临时改，不必重新打包：`DSH_GO_COT_PROVIDER`、`DSH_GO_COT_TARGET`（非法的 provider 回落 bing，不会挂载失败）。
- 幂等与降级：`globalThis[Symbol.for('dsh.go.ohos.cotTranslation')]` 防重复挂载；平台不是 openharmony（且无仿真标记）直接返回；
  取包失败/导出异常/`ctx.plugin` 不存在都只 `console.error('[cot] …')` 返回，不影响其它能力。
- `index.mjs` 在 `apply()` 末尾 `Promise.resolve().then(...)` 调用，日志形如 `[cot] mounted provider=bing target=auto`。

### 23.4 能力与已知边界
- 免费匿名可用（bing）；`deepseek-account` / `deepseek-official` 两条要密钥，手机上没有配置入口，暂不启用。
- controller 构造时 `settings.configure({ auto: false })` —— 官方**不给这个插件实例自动生成设置页**，所以 App「设置 › 思考链翻译」里没有可编辑字段；
  provider 由挂载时传的 config 决定。要换 provider 目前靠环境变量或重打补丁。
- 匿名翻译走 `TRANSLATION_SESSION_ACTIVE` 路线：`TranslationStorage` 需要 `sessionPersistence` 与活跃 session（App 传 sessionId），手机有；
  翻译结果按段落写进会话的 plugin record，可复用缓存。

### 23.5 测试与预检
- `runtime/tests/ohos/cot-translation.test.mjs` **8 例全通过**：默认挂载顺序与 config、options>env 优先级、非法 provider 回落、二次挂载被拒、
  缺包/缺 default/缺 ctx.plugin 的降级、非鸿蒙平台不挂载（仿真标记可绕过）。`node --test runtime/tests/ohos/cot-translation.test.mjs` → 8 pass / 0 fail。
- 打包前在 compose 树上做了真实 import 预检（`/root/compose60/.../files` 里跑裸包名 import）：
  `translator function Translator`（Config 键 provider/googleEndpoint/bingEndpoint/…），`controller function CotTranslationController`（inject `["translator","typert","sessionController"]`），
  证明 runtime 树的 `node_modules` 解析与导出形状都对；三个依赖服务在 `dsh-api-session-controller` / `dsh-typert-*` / `dsh-session-persistence-*` 里都有。

### 23.6 v62 产物（1.0.52+52）
| 项 | 值 |
| --- | --- |
| compose60 | `{"runtimeVersion": "ohos-169c8dbb77824640a7e42e1a", "payloadFiles": 55559, "archiveBytes": 205360526}`，COMPOSE_RC=0 |
| fullhap62 | 14:32→14:33:35（63 s），FULLHAP62_RC=0，`audit-hap: OK`，versionCode 52 / versionName 1.0.52 |
| unsigned | `<WS>/hap-build/dsh-ohos-v62-unsigned.hap` 274,359,998 B md5 `fc9b6be98758346baf914e8907567df1` |
| signed | `<WS>/hap-build/dsh-ohos-v62-signed.hap` 274,436,983 B md5 `92a0a2be68d22cf03fb4d4cef3e309bd`（`tools/hokit-asar/resign-expr-v62.js`）|

### 23.7 验收判据（装机后）
1. `engine.log`（App 内用 `mcp__engine__log action=grep pattern='\[cot\]'`）出现 `[cot] mount translator {"provider":"bing"}`、`[cot] mount cot-translation …`、`[cot] applied …`。
2. 展开一段英文思考 → 出现翻译胶囊 → 点它，思考文字就地变中文，并有「查看原文」。
3. 翻译失败时保留原文且可重试（网络问题应表现为 `[cot]` 之外的 translator 错误，不崩会话）。


## 24. 一个工具的 schema 写错，整个手机桥都没了（v63）

### 24.1 现象
v62 装到手机上后，手机桥（截图 / 点击 / shell / `mcp__engine__log` / `mcp__engine__sessions`）**整组消失**，不只是会话体检工具不可用。引擎日志里 ohos-phone 插件没有生效。

### 24.2 根因
`runtime/ohos/phone/sessions.mjs` 注册工具时把 `output.schema` 写成了一个"可执行 schema"：

```js
const schema = { parse(value) { return value; } };
ctx.tools.register({ name: 'mcp__engine__sessions', output: { schema, render } , ... });
```

新版工具注册表（`@deepseek-ai/dsh-tools` 0.2.2-rc.3）只接受 JSON Schema 的一个**子集**：

| 位置 | 行为 |
| --- | --- |
| `lib/index.js:548` | output 必须声明 `{ schema, render, presentationMeta? }`，否则 `TypeError` |
| `lib/index.js:549` | `assertSupportedJsonSchema(output.schema)` |
| `lib/shared-DGx6D7zk.js:337` | 逐节点校验，只允许 `type / oneOf / properties / required / additionalProperties / items / enum / const` + 注解；其它键抛 `JsonSchemaError: schema.parse is not a supported keyword (subset: …)` |
| `lib/shared-DGx6D7zk.js:166-175` | `required` 里的键必须出现在 `properties`；`additionalProperties` 必须是 boolean；`type` 不支持数组 |
| `lib/pipeline.js:770` | 调用期还要 `validateJsonSchemaValue(tool.output.schema, value)`，值是 `undefined` 属性会被判"非无损 JSON" |

而 `runtime/ohos/phone/index.mjs` 的 `apply()` 原本把四组注册塞进同一个 try/catch：任一组抛出就整块回滚并 rethrow → ohos-phone 插件 apply 失败 → 手机桥所有工具一起消失。

### 24.3 修法
1. `sessions.mjs` 导出真正的 `sessionsSchema`（`{type:'object', additionalProperties:false, properties:{ok,code,message,data}, required:[ok,code,message,data]}`），删掉手写 `parse`。
2. 同文件加 `jsonSafe(value)`（递归去掉值为 `undefined` 的属性），`result()` 恒返回四个字段 —— 否则 `data` 里的 `lastFailure: undefined` 会让调用期校验报 `"value.data" must be a lossless JSON object`。
3. `index.mjs` 改成 `safeRegister(label, register)`：一组失败只 `console.error('[phone] register failed …')` 并返回空的 dispose，其余三组照常注册。
4. 新测试 `runtime/tests/ohos/phone-tool-schemas.test.mjs`（4 例）：用**真的** `assertSupportedJsonSchema` / `validateJsonSchemaValue` 把 phone/ui/engine-log/engine-sessions 的 parameters 与 output.schema 全过一遍，并断言 `assertSupportedJsonSchema({ parse(v){return v;} })` 必抛 `JsonSchemaError`（钉成回归）。

回归：`node --test runtime/tests/ohos/{engine-log-tools,engine-sessions-tool,phone-ui-tools,phone-tool-schemas,cot-translation}.test.mjs` → 56 pass / 0 fail。

### 24.4 教训
- 工具注册是**契约**，不是鸭子类型：`output.schema` 必须能被 JSON Schema 子集校验器读懂。
- 一组注册失败不能带走整桥 —— 能力之间要相互隔离，错误进日志而不是静默。
- 返回值的形状也要守契约：`undefined` 属性不是"没写"，是"非法 JSON"。

## 25. 思考写完之后自己翻译（v63）

### 25.1 需求
用户 m08124：「能让它默认自动翻译，不需要我手动去点一下吗」。

### 25.2 规则
- **只翻刚刚写完的那段**：`ThinkingPill` 记住自己是否处于「思考中」（`_sawThinking`），在 `active` 由 true→false 的那一帧自动开始翻译，并把 `showTranslation` 置 true、行内一行预览也用译文。
- **历史消息仍手动**：翻旧消息会在打开长会话时一次打出几十个翻译请求（bing 匿名接口），所以只有"看着它写完"的那段自动。
- 失败仍是「翻译暂不可用」+「重试」，原文保留。

### 25.3 实现要点
- `ThinkingPill` 保持普通 `StatefulWidget`（不能用 `ConsumerState`：golden 测试里没有 `ProviderScope`，文件里 `_hasProviderScope` 就是为此存在）。
- 因此用 `ProviderScope.containerOf(context, listen: false)` 拿容器，并 `container.listen(cotTranslationProvider, …)` 订阅：既让 autoDispose 的限量 provider 活着，又在值到达时 `setState`。订阅只在这一段思考刚写完时建立，`dispose` 里 `_limits?.close()`。
- 一句判断决定翻不翻：`reasoningNeedsTranslation(text, limits.targetFor(reasoningUiLanguage))` —— 中文界面里的英文思考才翻，中文思考不翻。

### 25.4 测试
`port40/app/test/agents/thinking_translate_test.dart` 12 例（含两枚 golden 未变）：新加「a thinking block that just finished translates itself」（active true→false 后自动发请求、展开即中文、胶囊变「查看原文」、收起再展开不重发）与「an old thinking block stays manual」（历史消息不发请求）。
`flutter test test/agents test/chat` → 2314 pass / 1 skipped / 0 fail。

### 25.5 v63 产物（1.0.53+53）
| 项 | 值 |
| --- | --- |
| CI | run 43825209781（head `db1008f5`）completed/success，artifact `ohos-aot-db1008f5…` 22,288,852 B |
| AOT | `/root/aot63/arm64-v8a/app.so` 41,272,200 B（`aot-fetch.py` 已把 glibc 版 libsqlite3.so 换回鸿蒙版） |
| compose61 | `{"runtimeVersion": "ohos-2a574121ac8a0844e6ed6a33", "payloadFiles": 55559, "archiveBytes": 205361049}`，COMPOSE_RC=0；zip md5 `94356e56dc49d8a910a9f766d39734e0` |
| fullhap63 | 15:45，FULLHAP63_RC=0，`audit-hap: OK`，versionCode 53 / versionName 1.0.53，runtime `ohos-2a574121ac8a0844e6ed6a33`，`archiveSHA256 88ba9f2728c3bc4b4d60ece8c6f5d2415579c9a687176f13a568f98a6a9ea0ce` |
| unsigned | `<WS>/hap-build/dsh-ohos-v63-unsigned.hap` 274,367,405 B md5 `571d4ef7b7cf8f7eaf28b70e1023cc59` |
| signed | `<WS>/hap-build/dsh-ohos-v63-signed.hap` 274,445,178 B md5 `363d65e52bc28b0d3907231b777fdd56`（`tools/hokit-asar/resign-expr-v63.js`）|

### 25.6 验收判据（装机后）
1. 手机桥恢复：`mcp__engine__sessions`（`action=list`）、`mcp__phone__ui`（`action=shot`）、`mcp__engine__log` 都可用；引擎日志里不应再出现 `[phone] register failed`。
2. 用英文提问 + 要求英文思考，思考写完直接展开就是中文，胶囊显示「查看原文」；旧消息展开仍显示「翻译」。
