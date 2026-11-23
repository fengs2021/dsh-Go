import 'dart:io';

import 'package:dsh_app/ui_config/ui_config.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the night-run skill installs as one managed SKILL.md with the measured facts', () async {
    final bundle = await loadUiSkillBundle(readAssetFromDisk, nightRunSkillName);
    expect(nightRunSkillName, 'night-run');
    expect(bundle.name, nightRunSkillName);
    expect(bundle.files.keys, ['SKILL.md']);
    expect(bundle.writeOrder.last.key, 'SKILL.md');
    expect(isManagedUiSkill(bundle.skillMd), isTrue);

    expect(bundle.skillMd, contains('name: night-run'));
    // 可执行方案：外部定时 → 常亮 → 拉起 → 还原。
    expect(bundle.skillMd, contains('power-shell timeout -o'));
    expect(bundle.skillMd, contains('power-shell timeout -r'));
    expect(bundle.skillMd, contains('aa start -a EntryAbility'));
    expect(bundle.skillMd, contains('phone-night.sh'));
    // 已实测否掉的路径，必须写清楚，避免下次又去试。
    expect(bundle.skillMd, contains('9800005'));
    expect(bundle.skillMd, contains('KEEP_BACKGROUND_RUNNING_SYSTEM'));
    expect(bundle.skillMd, contains('WorkScheduler'));
    expect(bundle.skillMd, contains('10106102'));

    final root = tempRootfs();
    addTearDown(() => root.deleteSync(recursive: true));
    expect(await installUiSkill(root, bundle), UiSkillInstallResult.installed);
    final skill = File('${root.path}/root/.dsh/skills/$nightRunSkillName/SKILL.md');
    expect(skill.readAsStringSync(), bundle.skillMd);
  });
}
