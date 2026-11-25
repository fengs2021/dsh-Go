# HdcChannel：Android 直接操作鸿蒙手机（PoC 记录）

目标：Android 版 DSH 像现在的 PC 一样，对鸿蒙手机执行 `aa start` / `uitest uiInput` /
`power-shell` / `bm dump`。落点是新增 `HdcChannel : PrivilegedChannel`，
与 `ShizukuChannel` / `AdbChannel` 并列，复用现有 `Bundle` 协议，上层 phone 工具与计划任务不改。

## 1. 已验证的事实（源码级）

来源：OpenHarmony `developtools_hdc`（`src/common/define.h`、`src/common/session.cpp:Send`）。

| 项 | 值 |
| --- | --- |
| 包标志 | `PACKET_FLAG = "HW"`（2 字节） |
| 协议版本 | `VER_PROTOCOL = 0x01` |
| 包头 | `PayloadHead`：`flag[2]` + `protocolVer(1)` + `headSize(2, 大端)` + `dataSize(4, 大端)` = **9 字节** |
| 包头后 | `PayloadProtect`（`SerialStruct` 序列化：channelId / commandFlag / checksum / vCode） |
| 握手 banner | `HANDSHAKE_MESSAGE = "OHOS HDC"`（≤11 字节） |
| 版本串 | `"Ver: " + 版本 + 16 位十六进制 hash`（daemon 只校验形状，hash 取源码树 SHA-256 前 16 位） |
| 端口 | 鸿蒙「无线调试」页显示，实测 `45957` |
| 鉴权 | TCP 直连**不需要公钥**：`connect_validation` 默认 `VALIDATION_CLOSE`，不弹设备授权框（我们 PC 侧 `hdc.exe tconn` 全程未配对即验证过） |

**2026-11-25 抓包校正**（用 Windows/WSL TCP relay 拦了一次真实 `CNXN`，179 字节）：

```
48 57 | 00 00 | 01 | 00 08 | 00 00 00 a0 | a0 08 00 10 01 18 00 20 09 | 0a 08 "OHOS HDC" ...
 flag    reserve  ver  headSize=8  dataSize=160    PayloadProtect(序列化后 8B)      HandShake 负载
```

- 包头是 **10 字节**，之前漏了 `reserve[2]`（加密/选项位，明文链路为 `00 00`）；
- `headSize=8` 说明 `PayloadProtect` 是**压缩序列化**后的 8 字节，不是 10 字节裸结构；
- 负载里能直接看到 `0a 08 4f 48 4f 53 20 48 44 43` = `"OHOS HDC"`，与 TLV/pack 编码一致。

Rust 侧的权威定义（可直接照着移植，比啃 C++ 便宜）：

| 结构 | 字段 |
| --- | --- |
| `PayloadProtect` | `channel_id: u32`、`command_flag: u32`、`check_sum: u8`、`v_code: u8`（`v_code` 静态值 `0x09`） |
| `PayloadHead` | `flag[2]`、`reserve[2]`、`protocol_ver: u8`、`head_size: u16`、`data_size: u32` |
| `SessionHandShake` | `banner: String`、`auth_type: u8`、`session_id: u32`、`connect_key: String`、`buf: String`、`version: String` |

序列化实现规模：`hdc_rust/src/serializer/pack_struct.rs`（121 行）+ `serialize.rs`（436 行）
+ `native_struct.rs`（98 行）——这是**下一个要移植的东西**，用 Kotlin 重写这三块即可，
不必再抓包。

已落地的代码：`phone/hdc/HdcWire.kt`（包头编解码 + 常量 + 版本串）与对应 JVM 单测，
不依赖真机即可验证字节布局。

## 2. 还差什么（真正的工程量）

`PayloadProtect` 是 hdc 自研的 `SerialStruct` 序列化（不是 protobuf/flatbuffer），
再加上 `AUTH`/`OPEN`/`WRTE`/`OKAY`/`CLSE` 的会话状态机与 mux 复用。三条可行路线：

| 路线 | 做法 | 工作量 | 风险 |
| --- | --- | --- | --- |
| A. 纯 Kotlin 重写 | 照源码把 `SerialStruct` 与状态机搬到 Kotlin，只需 shell 命令 | 大（SerialStruct 反射式序列化要逐字段还原） | 协议随版本漂移要跟 |
| B. vendor 上游 C++ 客户端 + NDK 静态库 | 和 Swai 一样把 `developtools_hdc` 的客户端编成 `libhdcclient.so`，Kotlin 走 JNI | 中（要把 OpenSSL/keystore/uv 适配到 bionic） | 体积 + 编译链复杂，但语义与官方一致 |
| C. 打一个静态链接的 aarch64 `hdc` 可执行文件进 `jniLibs` | `ProcessBuilder` 直接调用，stdout 解析 | 小（如果拿得到/能编出静态二进制） | 依赖 Android 允许从 `nativeLibraryDir` 执行；静态 musl 二进制在 Android 上可跑 |

**建议 B**：官方客户端语义最稳，且 `PrivilegedChannel` 只要一个 `exec(Bundle)`，
JNI 一层薄封装即可；C 最快见效但受「可否执行」限制，可作为 M1 前的临时验证。

## 3. 里程碑与验证

- **M1（当前）**：`HdcWire` 字节布局 + 单测通过；`HdcChannel` 骨架实现 `PrivilegedChannel`。
- **M2**：路线 B 打通，`exec("echo ok")` 与 `exec("aa start -a EntryAbility -b <bundle>")` 在真机验证。
- **M3**：接 `BackgroundPolicy` 白名单；`phone` 工具在 Android 端选择 `HdcChannel` 当目标机是鸿蒙时。
- **M4**：计划任务（夜间签到）从 UI 创建并执行。

真机验证需要：鸿蒙手机开「无线调试」（`hdc tconn <ip>:45957` 可达）、Android 端与手机同网段。
