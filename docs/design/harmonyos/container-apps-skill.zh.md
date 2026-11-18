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

## 3. 为什么是「校准 + 缓存」而不是写死包名

写死一个「卓易通包名 + ability + `--ps androidPackage`」看起来很省事，但我们没有能在本机验证的凭据：历史上试过的 `com.droi.tong`、`com.trim.app.ohar`、`com.easy.hmos.abroad` 都是猜测，没有任何一次读到过 `app current` 的真实 want；容器版本一更新，写死的参数也会失效，而失效的表现是「点了没反应」，比报错更难查。

所以技能把**校准动作**本身写成流程：真机上第一次跑，用 `app current` 读到真实的 bundle/ability/want，再逐参数试 replay；成功就落成一条可复用命令存到 `$DSH_HOME/container-launch.md`（跨会话可见），失败就明确记下「不支持 replay」并走坐标。这条路径不依赖任何未验证的常量，最坏情况也就是每次多点几下。

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

## 6. 没验证到的

- **真机未复验**：v66 包已重出但设备当时离线，本技能尚未在真机上跑过一次真实任务（起点读书签到那条路）。`aa start` replay 是否被容器支持、`app current` 的 want 是否带安卓包名，都还没实测。
- 手机上原有一份用户自己写的方法文档（`…/workspace/DSH-Go/卓易通应用启动命令.md`，1966 B），设备回网后应把它和本技能对照一次；两者冲突以实测为准，并把实测结论沉淀进本文件。
- 容器包名（`bm dump -a` 里卓易通那一条）未在本文写死，第一次校准时应记进 `container-launch.md`。
