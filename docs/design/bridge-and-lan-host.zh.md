# 远程主机：接入 dsh-bridge 与局域网 dsh

状态：待实现（给实现者的规格）。

## 目标

手机端 dsh-Go 现在只支持三种主机：本机引擎（`HostKind.local`）、SSH 主机（`HostKind.ssh`）、
中继设备（`HostKind.relay`）。要新增第四种：**直接连一个 HTTP 上的 DSH**，覆盖两种来源：

1. **dsh-bridge**（`@wenbin_wb/dsh-bridge` 插件）：PC 上的 DSH 由 bridge 暴露在局域网端口或
   Cloudflare 隧道域名后面，进入方式是**访问密码**（不是启动 token）。
2. **局域网 dsh web**：同一网段里 `dsh web` 已经跑着的实例，进入方式是 `?token=` 启动令牌。

两种都落到同一个新主机类型 `HostKind.web`（显示名「远程 DSH」），连接后与会话、工作区、
插件、设置等现有功能完全同构 —— 它们只是 `DshClient` 换了 baseUri 和凭证。

## 已知事实（已核实，别重新发明）

### dsh-bridge 的鉴权协议

`/root/.dsh/profiles/web/node_modules/@wenbin_wb/dsh-bridge/lib/index.js`：

| 用途 | 请求 | 响应 |
|---|---|---|
| 登录 | `POST {base}/__dsh_bridge__/login`，JSON body `{"password": "..."}` | 200 + `Set-Cookie: dsh_bridge_auth=<sessionToken>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` + `{"ok":true}`；失败 401 `{"ok":false,"error":"..."}` |
| 登出 | `POST {base}/__dsh_bridge__/logout` | 清 cookie |
| 状态（免登录） | `GET {base}/__dsh_bridge__/auth-status` | `{"enabled":true,"mode":"password_only",...}`（已脱敏，无 secretToken） |

- 登录后的所有请求带 `Cookie: dsh_bridge_auth=<token>`。
- 桌面面板还有 `/__dsh_bridge__/loopback-token`，只对物理回环发放，手机用不到。

### 客户端已有的能力

`packages/dsh_client/lib/src/session_api.dart`：

```dart
DshClient.connect({
  Uri? baseUri, String? token, String? launchUrl, DshCookie? cookie,
  String? hostHeader, bool backgroundLists = false, bool startMux = true, ...
});
```

- `token` 走 `DshConnection.login(token)`（`GET /?token=...` 换会话 cookie）；
- **`cookie` 直接给出时不再登录**，直接用这个 cookie 发请求 —— bridge 的 cookie 正好能塞进来；
- `DshCookie`（`connection.dart`）字段：`name` / `value` / `authority`（`host:port`）/ `expiresAt`，
  `header` getter 生成 `name=value`。构造时 `authority` 必须与 `baseUri` 的 `host:port` 一致，
  否则 `DshConnection` 的 Host 栅栏会拒绝。

## 实现要求

### 1. 登录与 cookie（`packages/dsh_client`）

- 新增 `Future<DshCookie> loginDshBridge(Uri baseUri, String password)`（可放在
  `lib/src/bridge_login.dart` 并导出）：
  - `POST {base}/__dsh_bridge__/login`，`Content-Type: application/json`，body `{"password": ...}`；
  - 200 时解析 `Set-Cookie` 里的 `dsh_bridge_auth=...`（可能有多条 Set-Cookie，只取这一条），
    返回 `DshCookie(name: 'dsh_bridge_auth', value: token, authority: '<host>:<port>', expiresAt: now+30d)`
    （`Max-Age` 存在就以它为准）；
  - 401 抛 `DshAuthError`（新异常类型或复用 `errors.dart` 里已有的类型，二选一，说明理由）；
  - 网络错误原样抛。
- 不加全局状态、不加重试、不加缓存 —— 一次调用一次结果。

### 2. 主机模型（`app/lib/state/hosts_state.dart`）

- `enum HostKind { local, ssh, relay, web }`；`HostRef.web(String id)`；
- `class WebHostConfig`：`id`、`name`、`baseUrl`（含 scheme/port，无 path）、`password?`、
  `token?`（两种凭证最多一种非空；都空表示裸 dsh，仅限本机回环，不给 UI 入口）、
  `lastUsedAt?`。`password`/`token` 与 SSH 密码同级对待：**进 secure storage，不进明文 prefs**；
- 沿用现有 SSH 主机的持久化方式（照着 `SshHostConfig` 的存取代码抄结构，不要自创一套存储）；
- `HostRef` 的相等性、`hostLabel()`（`connection_state.dart` 里）要给出 `web` 的显示名
  （有 `name` 用 `name`，否则用 host）。

### 3. 连接（`app/lib/remote/web/` 新目录）

- `WebHostLink implements HostLink`：connect 流程
  1. 若 `password` 非空：`loginDshBridge()` 拿 cookie（每次 connect 都重新登，cookie 只放内存，
     不落盘 —— bridge 的 session 可以随时被服务端清掉）；
  2. `DshClient.connect(baseUri: ..., cookie: cookie)` 或 `DshClient.connect(baseUri:, token: token)`；
  3. 失败映射成 `HostLinkError`：401/403 → `HostLinkErrorKind.auth`（文案「密码不对或已失效」），
     其余网络错误 → 现有网络错误类型；
- 断线重连沿用 `SshHostLink` 的 `kicks` + `Backoff` 结构（不要发明新的重试机制）；
- 在 `hostLinkProvider`（`connection_state.dart`）里加 `HostKind.web` 分支。

### 4. 局域网 dsh 发现（`app/lib/remote/web/lan_discovery.dart`）

- `Future<List<LanDshCandidate>> discoverLanDsh({Duration timeout = const Duration(milliseconds: 300), List<int> ports = const [3080, 8080]})`：
  - 取本机 IPv4 网段（`NetworkInterface.list()` → `/24`），对每个地址两个端口并发 `HTTP HEAD /`；
  - 判定：
    - `GET /__dsh_bridge__/auth-status` 返回 200 且 JSON 含 `enabled` → `kind: bridge`（可从 JSON 读 `mode`）；
    - `GET /` 返回 200 且页面/响应头带 DSH 特征（`x-dsh-*` 头，或 HTML 含 `<title>DSH`／`dsh web`）→ `kind: dsh`；
  - 返回 `LanDshCandidate(host, port, kind, title?)`，按 host 排序；
  - **不扫全端口、不扫 /24 之外、不加多轮重试**；单轮 300 ms 超时，并发上限 64；
  - 不做 mDNS/Bonjour（这个仓库没有依赖，别引新依赖）。

### 5. UI（`app/lib/ui/remote/`）

- 主机切换器（`host_switcher.dart`）与远程页（`remote_screen.dart`）里加「添加远程 DSH」入口；
- 表单（新文件 `web_host_form.dart`，参照 `ssh_host_form.dart` 的结构与错误展示）：
  - 名称（可空）、地址（必填，接受 `http://192.168.1.10:3080`、`https://dsh-pc.example.com`，
    也接受带 `?token=` 的完整 URL —— 解析出 token 后从地址里去掉）；
  - 凭证：二选一 ——「访问密码（dsh-bridge）」或「启动令牌（dsh web）」；
  - 「扫描局域网」按钮 → 列表，点一条就填好地址（bridge 的自动选密码模式）；
  - 「测试连接」按钮：成功显示工作区数或版本；失败显示映射后的错误；
- **所有文案进 `app/lib/l10n/parts/*.arb`（中英各一份），跑 `python3 app/tool/l10n_merge.py`**，
  不手改 `app_*.arb` 与 `gen/`。

### 6. 测试

- `packages/dsh_client/test/`：本地 `HttpServer` 起假 bridge，
  覆盖 200/401/缺 Set-Cookie/多条 Set-Cookie/Max-Age 解析；
- `app/test/remote/`：`WebHostLink` 用假 connector 断言「密码→cookie→connect(cookie:)」路径、
  401 映射成 auth 错误、token 路径不打 bridge 登录；
- `app/test/remote/lan_discovery_test.dart`：假 `HttpServer` 监听回环，断言 bridge/dsh 两种判定；
- 既有测试全绿，`flutter analyze` 零 issue。

## 纪律

- 只改必要文件；不改 Android 侧行为；不引新依赖（`dart:io` 足够）。
- 不手改生成物；l10n 走生成器。
- 工作树 `/mnt/d/Users/liqih/Documents/deepseek-harness/default-workspace/port71`，分支 `port/v71`。
  Flutter 用 `/root/f47/bin/flutter`（3.47.7 / Dart 3.13.5）；别用 `/root/flutter`（旧的 3.35.7）。
- 提交前先跑：`flutter --no-version-check analyze --no-pub`、相关 `flutter test`、
  `python3 app/tool/l10n_merge.py --check`；不要自己 commit / push。
