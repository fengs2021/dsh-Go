---
# dsh-go:managed — 这行在，App 启动时会把这个技能更新到最新；想自己改就删掉它。
name: zhuoyitong
description: 在鸿蒙的安卓兼容容器（卓易通，Android 侧叫 anco）里打开安卓 App：这类 App 不在 BMS 真包列表里，但可以用一条 aa start -b <安卓包名> -a <入口Activity> 直接启动——必须带 -a，只给包名会落回桌面。附已知应用速查表、找入口 Activity 的两条路、锁屏与后台限制。用户说「在卓易通里打开 XX」「起点读书签到」「容器里的 XX 打不开」时加载它。Launch Android apps inside the Zhuoyitong / anco container on HarmonyOS with one aa start command.
whenToUse: 用户要在卓易通（anco 安卓容器）里打开、操作安卓 App，或抱怨容器里的 App 打不开/点了没反应时。原生鸿蒙 App 不要用本技能——mcp__phone__app action=launch 一条命令就够。
---

# 在卓易通（anco 容器）里打开安卓 App

## 0. 一句话

容器里的安卓 App **可以用一条命令启动**，但必须同时给包名和入口 Activity：

```sh
aa start -b <安卓包名> -a <入口Activity>
```

**只给包名的 `aa start -b <包名>` 既不报错也不启动，会落回桌面** —— 这是最容易踩的坑，别把它当成「容器里的 App 不能用命令启动」。

## 1. 三条事实

1. **不在 BMS 真包列表**：`bm dump -n com.qidian.QDReader` 报 `bundle not exist` 是**正常现象**，不代表没装，也不代表不能启动（走的是 anco 虚拟包名）。因此 `mcp__phone__app action=launch` 对它们**无效**：它先用 `bm dump -n` 取 `mainElementName`，取不到就退回 `EntryAbility`，最后拉起的是个不存在的 ability。容器里的 App 一律用 `mcp__phone__shell` 自己发 `aa start`。
2. **容器就是「卓易通」**，Android 侧叫 **anco**，桌面图标带「卓」角标。容器自身是普通鸿蒙 App（`bm dump -a` 查得到），要开容器本身可以用 `mcp__phone__app action=launch`；但要开容器内某个安卓 App，直接用 §2 的命令更快，不必点屏。
3. **锁屏与后台限制**：`allowAppRunWhenDeviceFirstLocked=false` —— 锁屏状态下本 App（DSH）会被冻结，`uitest` 注入被系统拦掉，只能人工解锁。长时间任务优先「把脚本推到手机侧执行 + 结果落盘 `/data/local/tmp/*.json`」，DSH 回到前台再读。

## 2. 首选：一条命令启动（已知应用速查表）

| 桌面标签 | 包名 | 入口 Activity |
| --- | --- | --- |
| 起点读书 | `com.qidian.QDReader` | `com.qidian.QDReader.ui.activity.SplashActivity` |
| 创建快捷方式 | `com.x7890.shortcutcreator` | `com.x7890.shortcutcreator.AppListActivity` |
| FPA | `fun.fpafun.fpa` | `fun.fpafun.fpa.MainActivity` |
| 皖事通系 | `com.hmfl.careasy.anhuinewgwcx` | `com.hmfl.careasy.anhuinewgwcx.com.hmfl.careasy.WelcomeActivity` |

```sh
# 起点读书（用 mcp__phone__shell 跑）
aa start -b com.qidian.QDReader -a com.qidian.QDReader.ui.activity.SplashActivity
# 停止（同样是安卓侧包名）
aa force-stop com.qidian.QDReader
```

判成功靠截图（§6），不要只看命令输出：`aa start` 返回成功不代表前台就是目标界面。

## 3. 表里没有的 App：两条找入口 Activity 的路

1. **跑过的应用**：`aa dump -l`，mission name 形如
   `#com.qidian.QDReader:entry:com.qidian.QDReader.ui.activity.SplashActivity`
   → 冒号后那段就是入口 Activity。
2. **从没跑过的**：读桌面布局，图标 id 里带着包名和 Activity：

   ```sh
   uitest dumpLayout -p /data/local/tmp/desk.json    # 之后 cat /data/local/tmp/desk.json 取片段
   ```

   找形如 `AppIcon_Image_<包名><Activity>entry0…` 的串，反推出 Activity。桌面第一页没有就翻页再 dump；也可以在容器里点开它一次，再用 `aa dump -l` 反推。
3. 拿到后按 §2 启动，并把这一行加进 §4 的缓存。

## 4. 把新条目落盘

追加到 `$DSH_HOME/container-launch.md`（跨会话可见；手机本机引擎里是 rootfs 的 `root/.dsh/`）：桌面标签 / 包名 / 入口 Activity / 验证日期。工作区里若有用户自己整理的 `卓易通应用启动命令.md`，先读它，冲突以实测为准并回写。

## 5. 兜底：坐标点击

只有拿不到 Activity、或启动后界面不对时才用：

```sh
mcp__phone__ui action=key key=Home          # 或 key=Back 退回桌面/容器首页
mcp__phone__ui action=dump filter=<标签>     # 拿图标中心坐标；没有就 swipe 翻页再 dump
mcp__phone__ui action=click x=<cx> y=<cy>
mcp__phone__ui action=wait ms=4000          # 容器冷启动 3–8 秒
mcp__phone__ui action=shot                  # 落到 <工作区>/phone-shots/…，再用 read_image 看
```

容器界面通常**不向无障碍暴露节点**（`dump` 回 `no_nodes`）：看到这句就不要再 dump，直接截图按像素点。

## 6. 启动之后怎么确认

- `mcp__phone__ui action=shot` + `read_image`：屏幕上是不是目标 App 的界面——这是唯一可信的判据。
- `mcp__phone__app action=current`：能看到前台 Ability 更好；容器类记录可能只显示容器自己，此时以截图为准。
- `aa dump -l`：列表里出现该安卓包名的 mission，说明它确实起过。

## 7. 纪律

- **先看现在的状态，再动手**：签到/领奖这类任务，先确认是不是已完成，已完成就结束，不要为找按钮白点几十下。
- 一次任务超过约 30 个动作就停下来报告停在哪一屏、还差什么。
- 支付、删除、发布、改账号或安全设置的按钮，一律先问用户。
- 容器里的操作真实生效，不因为是自动化就打折；用截图当证据，不要拿「应该点到了」当结论。

## 8. 现象对照表

| 现象 | 含义 | 下一步 |
| --- | --- | --- |
| `aa start -b <安卓包名>` 没反应、落回桌面 | 漏了 `-a <入口Activity>` | 按 §2/§3 补 Activity |
| `bm dump -n <安卓包名>` 报 bundle not exist | 正常（anco 虚拟包名） | 不要据此判断没装 |
| `mcp__phone__app action=launch` 对容器 App 无效 | 它靠 `bm dump -n` 取 mainElementName | 改用 §2 的 `aa start` |
| `aa start` 报 `10104001 The specified ability does not exist` | 包名或 Activity 拼错，或该 App 确实没装 | 复核速查表/§3 反推，别硬试 |
| `dump` 回 `no_nodes` | 正常：容器界面没节点 | 改 `shot` + `read_image` |
| 注入操作全部失败 | 锁屏，或 DSH 被切到后台 | 请用户亮屏解锁并保持 App 在前台 |
| 截图全黑 | 容器走了安全画面（视频/DRM） | 让用户自己操作 |
| `aa force-stop` 后图标还在 | 正常，图标不随进程消失 | 下次 `aa start` 再起 |
