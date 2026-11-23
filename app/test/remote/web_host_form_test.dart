// The 远程 DSH form: what it refuses to save, what it stores where, and how a
// pasted ?token= URL lands in the token field.

import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/ui/remote/web_host_form.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../shell/golden_harness.dart';

void main() {
  Future<ProviderContainer> open(WidgetTester tester) async {
    usePhoneSurface(tester);
    SharedPreferences.setMockInitialValues({});
    final secrets = MemorySecretStore();
    await tester.pumpWidget(
      goldenApp(
        brightness: Brightness.light,
        overrides: [secretStoreProvider.overrideWithValue(secrets)],
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => Navigator.of(context).push<void>(
                MaterialPageRoute(builder: (_) => const WebHostFormPage()),
              ),
              child: const Text('Open form'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open form'));
    await tester.pumpAndSettle();
    return ProviderScope.containerOf(tester.element(find.byType(WebHostFormPage)));
  }

  testWidgets('an empty form is refused; a filled one saves without the password', (tester) async {
    final container = await open(tester);

    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pumpAndSettle();
    expect(find.text('请填写地址'), findsOneWidget);
    expect(container.read(hostsProvider).web, isEmpty);

    final fields = find.byType(TextField);
    await tester.enterText(fields.at(0), '客厅');
    await tester.enterText(fields.at(1), '192.168.1.10:3080');
    final password = find.byWidgetPredicate(
      (widget) => widget is TextField && widget.keyboardType == TextInputType.visiblePassword,
    );
    await tester.ensureVisible(password);
    await tester.enterText(password, 'hunter2');
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pumpAndSettle();

    final saved = container.read(hostsProvider).web.single;
    expect(saved.name, '客厅');
    expect(saved.baseUrl, 'http://192.168.1.10:3080');
    expect((await container.read(hostsProvider.notifier).loadWebSecrets(saved.id)).password, 'hunter2');
    final raw = (await SharedPreferences.getInstance()).getString(HostsController.webPrefsKey)!;
    expect(raw, contains('192.168.1.10:3080'));
    expect(raw, isNot(contains('hunter2')));
  });

  testWidgets('a pasted URL gives up its token and becomes a bare origin', (tester) async {
    final container = await open(tester);

    final fields = find.byType(TextField);
    await tester.enterText(fields.at(1), 'http://192.168.1.10:3080/?token=tok-9');
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pumpAndSettle();

    final saved = container.read(hostsProvider).web.single;
    expect(saved.baseUrl, 'http://192.168.1.10:3080');
    // No name typed: the authority names it.
    expect(saved.name, '192.168.1.10:3080');
    final secrets = await container.read(hostsProvider.notifier).loadWebSecrets(saved.id);
    expect(secrets.token, 'tok-9');
    expect(secrets.password, isNull);
  });

  testWidgets('an address without a host is reported on its field', (tester) async {
    final container = await open(tester);

    final fields = find.byType(TextField);
    await tester.enterText(fields.at(1), 'ftp://192.168.1.10');
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pumpAndSettle();
    expect(find.text('地址要以 http:// 或 https:// 开头，并带主机名'), findsOneWidget);
    expect(container.read(hostsProvider).web, isEmpty);
  });
}
