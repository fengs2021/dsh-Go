---
# dsh-go:managed — 这行在，App 启动时会把这个技能更新到最新；想自己改就删掉它。
name: zhuoyitong
description: 在鸿蒙的安卓兼容容器（卓易通这类）里打开并操作安卓 App：容器界面没有无障碍节点，只能截图看屏、按坐标点；容器内的安卓 App 不在 bm 的应用列表里，用安卓包名 aa start 必然报 10104001。做法是先进容器、再把前台 Ability 的 want 参数校准成一条可复用的 aa start 命令。用户说「在卓易通里打开 XX」「帮我在容器里点一下 XX」「起点读书签到」这类话时加载它。Drive Android apps inside a HarmonyOS Android-compat container (Zhuoyitong): screenshots plus coordinates, then a calibration that turns the hand-typed path into one replayable aa start command.
whenToUse: 用户要在卓易通（或同类安卓兼容容器）里打开、操作某个安卓 App 时。原生鸿蒙 App 不要用本技能——mcp__phone__app action=launch 一条命令就够。
---

# 在卓易通里打开并操作安卓 App

## 0. 先分清对象

| 对象 | 怎么认 | 怎么开 |
| --- | --- | --- |
| 原生鸿蒙 App | `mcp__phone__app action=list` 里查得到包名 | `action=launch app=<包名>` |
| 容器里的安卓 App | `list` 里**查不到**（安卓包名如 `com.qidian.QDReader` 不在列表） | 本文：先进容器，再点开 |

容器本身是个鸿蒙 App（`list` 里查得到、名字叫卓易通的那个）；它里面装的安卓 App 不是鸿蒙 Ability，也没有鸿蒙包名。所以「用安卓包名 aa start」这条路一开始就是死的。

## 1. 三条硬事实

1. **容器界面拿不到无障碍节点**：`mcp__phone__ui action=dump` 会回 `no_nodes`。看到这一句就不要再 dump，直接改用截图。
2. **只能按坐标操作**：`action=shot` 截图 → 用 `read_image` 读图 → `action=click x=… y=…`。`action=click text=…` 在容器内通常找不到目标（容器不把安卓控件暴露给无障碍）。
3. **容器冷启动 3–8 秒**：点开图标后先 `action=wait ms=4000`，每个动作之后再截一张确认，不要连点。

## 2. 打开容器

### 2.1 有缓存就用缓存（首选）

工作区或 `$DSH_HOME` 里已经有 `container-launch.md`（§3 的校准产物）时，照里面记的 `aa start`，用 `mcp__phone__shell` 直接跑：一条命令直达容器内的目标 App，不用点屏。

### 2.2 没有缓存：从桌面点开

1. `action=key key=Home`
2. `action=dump`（可加 `filter=卓易`）拿到容器图标的中心坐标；找不到就翻页：`action=swipe x1=1000 y1=1400 x2=200 y2=1400`，再 dump。
3. `action=click x=<cx> y=<cy>` → `action=wait ms=4000` → `action=shot` → `read_image`，确认进了容器。
4. `mcp__phone__app action=current`：此时前台就是容器，message 给出它自己的 `bundle/ability`，记下来。

## 3. 校准一次：把「手点」变成「一条命令」

目的：把每次都要点屏的路径，压成一条 `aa start`，以后（换会话、锁屏唤醒后）都能复用。

1. 在容器里按坐标点开目标 App（截图 → 坐标 → 点击，动作之间 wait），直到屏幕上认得出目标 App 自己的界面（不是容器首页）。
2. `mcp__phone__app action=current`：
   - message：`前台：<容器bundle>/<ability>`；
   - data：前台 AbilityRecord 的前 3000 字符，**want 参数就在这里**（常见是 `--ps` 字符串参数里带安卓包名、uri 或 moduleName）。
3. 拿里面的参数试 replay：

   ```sh
   aa start -b <容器bundle> -a <ability> --ps <key> <value>
   ```

   字符串参数用 `--ps`，整数用 `--pi`，uri 用 `-U <uri>`。
4. 判成功：再 `action=current` 或截图，前台仍是容器、且目标 App 已经打开（不是容器首页）。
   - 成功 → 按 §3.1 写进缓存文件，以后走 §2.1。
   - 失败（`aa start` 报错，或回到容器首页）→ 这个容器不认这个参数，继续用 §2.2 的坐标路线，并把「不支持 replay」也写进缓存文件，免得下次再试一遍。
   - 拿不准 → 就写「未验证」，不要写成能用。

### 3.1 缓存文件 `$DSH_HOME/container-launch.md`

```md
# 容器启动命令（校准产物，可以手改）
- 容器：卓易通 bundle=<…> ability=<…> 校准=<日期> <成功 | 不支持 replay>
- 起点读书 com.qidian.QDReader：aa start -b <…> -a <…> --ps <k> <v>   # <日期> 校验成功
- 某 App：不支持 replay，走坐标：容器首页 → 第 2 行第 1 个图标 (x=…, y=…)
```

`$DSH_HOME` 是引擎自己的 home（一般 `~/.dsh`；手机本机引擎里是 rootfs 下的 `root/.dsh`）。放这里才跨会话可见；写进某个会话的工作区只对那一个会话有效。

## 4. 在容器里操作

- 每一步之后截图核对。连续动作可以用 `action=script` 一次发完（最多 20 步），但**脚本里不放需要判断的分支**——判断靠截图做，脚本只做确定的那几步。
- 输入文字：先点输入框，再 `action=input x=<x> y=<y> text=…`；安卓输入法可能吞字符，输入完必须截图核对，不行就分段输入或让用户自己贴一次。
- 返回：`action=key key=Back`；回桌面：`key=Home`。
- 收尾不要用 `action=stop`（就是 `aa force-stop`）：那会把用户开着的容器和里面所有安卓 App 一起杀掉。用户没说要关，就留着。

## 5. 纪律

- **先看现在的状态，再动手**：签到/领奖这类任务，先确认是不是已经完成了（今天的标记已在、按钮是「已完成」）。已完成就直接结束，不要为了「找到按钮在哪」白点几十下。
- 一次任务超过约 30 个动作就停下来，报告停在哪一屏、还差什么，不要盲目长点。
- 支付、删除、发布、改账号或安全设置的按钮，一律先问用户。
- 容器里的操作是真实生效的，不因为是自动化就打折；不要拿「应该点到了」当结论，用截图当证据。

## 6. 现象对照表

| 现象 | 含义 | 下一步 |
| --- | --- | --- |
| `aa start` 报 `10104001 The specified ability does not exist` | 你在启动安卓包名 | 走 §2，先进容器再点 |
| `dump` 回 `no_nodes` | 正常：容器界面没有节点 | 改 `shot` + `read_image` |
| `app launch` 失败 / 前台不是目标 App | `mainElementName` 猜错了 | `action=abilities app=<包名>` 查真实 ability |
| 点完还停在容器首页 | 冷启动慢，或点空了 | `wait ms=4000` 后重截，微调坐标 |
| 截图全黑 | 容器走了安全画面（视频、DRM 类） | 让用户自己操作，Agent 只做后续点击 |
| `shot` 失败 | 锁屏或正在切换动画 | `key=Power` 唤醒后重试 |
