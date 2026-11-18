import 'dart:io';

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/ui_config/ui_config.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'skill_native_support.dart';
import 'support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the container skill installs as one managed SKILL.md and stays user owned once edited', () async {
    final bundle = await loadUiSkillBundle(readAssetFromDisk, containerSkillName);
    expect(containerSkillName, 'zhuoyitong');
    expect(bundle.name, containerSkillName);
    expect(bundle.files.keys, ['SKILL.md']);
    expect(bundle.writeOrder.last.key, 'SKILL.md');
    expect(isManagedUiSkill(bundle.skillMd), isTrue);
    // The trigger the person actually says, and the tool it must name.
    expect(bundle.skillMd, contains('name: zhuoyitong'));
    expect(bundle.skillMd, contains('mcp__phone__ui'));
    expect(bundle.skillMd, contains('10104001'));
    final root = tempRootfs();
    addTearDown(() => root.deleteSync(recursive: true));
    expect(await installUiSkill(root, bundle), UiSkillInstallResult.installed);
    final skill = File('${root.path}/root/.dsh/skills/$containerSkillName/SKILL.md');
    expect(skill.readAsStringSync(), bundle.skillMd);
    skill.writeAsStringSync(bundle.skillMd.replaceFirst(RegExp(r'^# dsh-go:managed.*\n', multiLine: true), ''));
    expect(await installUiSkill(root, bundle), UiSkillInstallResult.userOwned);
  });

  test('engine lifecycle installs the container skill through the managed transaction', () async {
    final root = tempRootfs();
    addTearDown(() => root.deleteSync(recursive: true));
    final ui = await loadUiSkillBundle(readAssetFromDisk);
    final container = await loadUiSkillBundle(readAssetFromDisk, containerSkillName);
    late SkillRuntime runtime;
    final providers = ProviderContainer(
      overrides: [
        localRuntimeProvider.overrideWith(() => runtime = SkillRuntime(RuntimePhase.installed)),
        runtimeBridgeProvider.overrideWithValue(SkillFileBridge()),
        uiRootfsResolverProvider.overrideWithValue(() async => root),
        uiSkillBundleLoaderProvider.overrideWithValue(() async => ui),
        extraSkillLoadersProvider.overrideWithValue([() async => container]),
      ],
    );
    addTearDown(providers.dispose);
    providers.listen(uiSkillAutoInstallProvider, (_, _) {});
    runtime.setPhase(RuntimePhase.running);
    await until(() => providers.read(uiSkillAutoInstallProvider) != null);
    await providers.read(uiSkillAutoInstallProvider.notifier).running;
    expect(
      File('${root.path}/root/.dsh/skills/$containerSkillName/SKILL.md').readAsStringSync(),
      container.skillMd,
    );
  });
}
