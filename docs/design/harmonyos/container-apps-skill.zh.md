# 容器里的安卓 App：内置技能 zhuoyitong

2026-11-18。内置技能 `zhuoyitong`（`app/assets/skills/zhuoyitong/`）教 agent 在鸿蒙的安卓兼容容器（卓易通这类）里打开并操作安卓 App。本文记录它解决的问题、为什么这么写、接线点，以及没验证到的部分。

## 1. 问题

容器把一整台安卓跑在鸿蒙里，容器里的 App 既不是鸿蒙 Ability，也没有鸿蒙包名：

- `bm dump -a`（即 `mcp__phone__app action=list`）**列不出**容器内的安卓 App，`com.qidian.QDReader` 这种包名根本不在列表里；
- 因此 `aa start -b <安卓包名>` 必然报 `10104001 The specified ability does not exist`；
- 容器界面**不向无障碍暴露节点**：`uitest dumpLayout` 常常只回一个空壳，`mcp__phone__ui action=dump` 落在 `no_nodes`，`click text=…` 找不到目标；
- 唯一稳的路是「截图 → 看图 → 按像素坐标点」，而这条路每一步都要人（模型）在现场判断，容易点歪、点空、点几十步还没到底。

模型不知道这些事实时会反复试 `aa start -b <安卓包名>`、反复 dump 空树，把一次简单任务烧成几十轮工具调用。技能的作用是把这些硬事实和执行纪律固定下来。

## 2. 内容（SKILL.md 的六节）

1. **先分清对象**：`list` 里有包名的是原生 App，直接 `action=launch`；容器内的安卓 App 不在列表里，走本文。
2. **三条硬事实**：没有无障碍节点、只能按坐标、容器冷启动 3–8 秒要 `wait`。
3. **打开容器两条路**：有校准缓存就直接跑缓存的 `aa start`；没有就从桌面图标翻页点开。
4. **校准一次**：点开目标 App 后 `mcp__phone__app action=current` 抓前台 AbilityRecord，它的 want 参数（`--ps`/`--pi`/`-U`）常常就带安卓包名或 uri；拿它试 `aa start -b <容器> -a <ability> --ps <k> <v>`，成功则写进 `$DSH_HOME/container-launch.md`，失败则记「不支持 replay」并永久回退坐标路线。
5. **容器内操作**：每步截图核对、`script` 最多 20 步且不放判断分支、输入后必须核对、收尾不要 `force-stop`（会把用户开着的安卓 App 一起杀掉）。
6. **纪律与现象对照表**：先读状态再动手、超约 30 个动作就停、敏感操作先问；把 10104001 / no_nodes / 黑屏 / 截图失败逐条对到下一步。

## 3. 真实机制（2026-11-18 由用户在设备上整理的文档校正）

第一版正文假设「容器里的安卓 App 不能用命令启动，只能点屏」，这个假设**是错的**，已在 v2 正文里改正。用户从手机导出的《卓易通应用启动命令.md》（1966 B，2026-11-13 写）给出的事实：

- 容器内安卓 App 走的是 **anco 虚拟包名**，所以 `bm dump -n <安卓包名>` 报 `bundle not exist` 是**正常**的；不能用它判断「没装」，也不能因此认为「不能启动」。
- 启动公式是 **`aa start -b <安卓包名> -a <入口Activity>`**，**必须带 `-a`**。只写 `aa start -b <包名>` 不报错也不启动，会落回桌面——历史上我们试的正是这种写法，于是错误地得出了「只能点屏」的结论。
- 停止用 `aa force-stop <安卓包名>`。
- 入口 Activity 两条找法：跑过的用 `aa dump -l`（mission name `#<包名>:entry:<Activity>`）；没跑过的从桌面 dumpLayout 的图标 id `AppIcon_Image_<包名><Activity>entry0…` 反推。
- 锁屏与后台：`allowAppRunWhenDeviceFirstLocked=false`，锁屏时本 App 被冻结、`uitest` 注入被系统拦截；长时间任务应把脚本推到手机侧执行、结果落盘 `/data/local/tmp/*.json`。
- 已知应用速查表（起点读书 / 创建快捷方式 / FPA / 皖事通系）已原样写进技能 §2。

因此 `mcp__phone__app action=launch` 对这类 App **无效**（它靠 `bm dump -n` 取 `mainElementName`，取不到就退回 `EntryAbility`），技能改为让 agent 用 `mcp__phone__shell` 直接发 `aa start`。截图标坐标退为**兜底**路径（拿不到 Activity、或启动后界面不对时用）。

这段校正的价值不只是纠正一条命令：**「命令没反应」和「命令报错」是两种完全不同的证据**，前者被我们当成了机制限制，实际只是漏了一个必填参数。

## 4. 接线点（新增内置技能的完整清单）

| 位置 | 改动 |
| --- | --- |
| `app/assets/skills/zhuoyitong/` | `SKILL.md`（带 `# dsh-go:managed` 行）+ `manifest.json` |
| `app/pubspec.yaml` | 资产表加 `- assets/skills/zhuoyitong/` |
| `app/lib/ui_config/ui_skill.dart` | `const containerSkillName = 'zhuoyitong'` + `extraSkillLoadersProvider` 追加一个 loader |
| `app/ohos/entry/src/main/ets/runtime/ManagedSkillCore.ets` | `MANAGED_SKILL_NAMES` 白名单加 `zhuoyitong` |
| `app/android/.../ManagedSkillInstaller.kt` + 其测试 | `names` 集合同步 |
| `docs/design/harmonyos/managed-skills.md` | `name` 白名单那一行 |
| `app/test/ui_config/zhuoyitong_skill_test.dart` | 安装、用户接管、跑通 managed 事务 |

## 5. 顺带修掉的：两侧白名单不同步

改这条链路时发现 Dart 侧要装 6 个技能，而 ArkTS 白名单只认 4 个（缺 `companion-adapt`、`pet-theme`），Android 侧只认 5 个（缺 `pet-theme`）。失败路径是静默的：`ManagedSkillRequest.parse` 返回 null → `ManagedSkillService` 回 `current:false` → Dart 的 `UiSkillAutoInstaller` 把这个 batch 判成 retired 并 `break`，于是**同一批里排在后面的技能也一起装不上**，且错误被 `catch (_) {}` 吞掉——鸿蒙上「伙伴适配」和「桌宠主题」两个技能实际从未安装成功。

现在 ArkTS 与 Android 两侧的白名单都补齐到 7 个（含新技能），ArkTS 侧改成导出的 `MANAGED_SKILL_NAMES` 常量并在注释里写明「两侧必须同名同序」，Android 侧继续保留自己的 set（Kotlin 编译单元不共享 TS 常量）。两侧仍然各写一份，仍可能再次漂移，这一点在 issue 里作为后续建议（单测里对照资产目录断言）提出。

## 6. 验证状态与剩余未知

- **正文事实来源**：用户手机上的《卓易通应用启动命令.md》（2026-11-13 写于设备，2026-11-18 导出到工作区）。这是本次唯一的一手证据；技能正文已与它逐条对齐（启动公式、`-a` 必填、`bm dump` 判断无效、找 Activity 的两条路、锁屏限制、速查表四行）。
- **仍未在本次真机复跑**：设备当时离线（`hdc list targets` 为空、`192.168.1.10` 100% 丢包）。回网后应至少复跑一条：`aa start -b com.qidian.QDReader -a com.qidian.QDReader.ui.activity.SplashActivity`，再截图确认前台。
- **ANCO 版本相关性未知**：速查表里的 Activity 名来自那台设备当时的 anco 版本；容器或 App 升级后可能变。技能 §3 给了反推方法，但没有「表过期」的自动检测。
- 手机上原有的 `…/workspace/DSH-Go/卓易通应用启动命令.md` 与本技能内容现已一致（技能里引用了同一张表）；后续任何实测结论都应回写到设备上的这份文档与 `$DSH_HOME/container-launch.md` 两处。
