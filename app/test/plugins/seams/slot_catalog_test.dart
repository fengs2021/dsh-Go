import 'dart:convert';
import 'dart:io';

import 'package:dsh_app/plugins/seams/seams.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('every slot of 0.2.2-rc.3 (116) plus the app surface, keyed by their own key', () {
    expect(slotCatalogRelease, '0.2.2-rc.3');
    // 116 slots of the release plus the app's own dsh-go.panel.
    expect(slotCatalog.length, 117);
    expect(slotCatalog.values.where((s) => !s.synthetic).length, 116);
    expect(slotCatalog.values.where((s) => s.synthetic).map((s) => s.key), [Slots.dshGoPanel]);
    for (final MapEntry(:key, :value) in slotCatalog.entries) {
      expect(value.key, key);
    }
  });

  test('the table matches the extracted catalog', () {
    // Extracted from DSH's client runner (docs/design/plugin-seams.md, appendix A);
    // key / kind / scope / replaceRisk only. A DSH bump brings a new extract.
    final file = File('test/plugins/seams/fixtures/slot-catalog-$slotCatalogRelease.json');
    final rows = (jsonDecode(file.readAsStringSync()) as List).cast<Map<String, Object?>>();
    expect(rows.length, 116);
    for (final row in rows) {
      final info = slotInfo(row['key']! as String)!;
      expect(info.kind.name, row['kind']);
      expect(info.scope, switch (row['scope']) {
        'session' => SlotScope.session,
        'session-maybe' => SlotScope.sessionMaybe,
        _ => SlotScope.root,
      });
      // `wraps-owner-content` (rc.3's hoc slots) is not a replacement of
      // shipped UI: only `shadows-shipped-ui` is.
      expect(info.replacesShippedUi, row['replaceRisk'] == 'shadows-shipped-ui', reason: info.key);
      expect(
        info.replaceRisk,
        switch (row['replaceRisk']) {
          'shadows-shipped-ui' => SlotReplaceRisk.shadowsShippedUi,
          'wraps-owner-content' => SlotReplaceRisk.wrapsOwnerContent,
          _ => SlotReplaceRisk.none,
        },
        reason: info.key,
      );
    }
  });

  test('rc.3: hoc wraps the owner content, and only a hoc does', () {
    // The release's three hoc slots (chat.markdown.fence, hero.frame,
    // sidebar.session.action) are its only `wraps-owner-content` rows, and its
    // only rows that are not a shipped-UI replacement either way.
    for (final info in slotCatalog.values) {
      expect(info.kind == SlotKind.hoc, info.wrapsOwnerContent, reason: info.key);
      if (info.kind == SlotKind.hoc) {
        expect(info.replacesShippedUi, isFalse, reason: info.key);
        expect(info.replaceRisk, SlotReplaceRisk.wrapsOwnerContent, reason: info.key);
      }
    }
    expect(
      slotCatalog.values.where((i) => i.kind == SlotKind.hoc).map((i) => i.key).toList()..sort(),
      ['conversation.chat.markdown.fence', 'conversation.hero.frame', 'sidebar.session.action'],
    );
  });

  test('rc.3 additions sit in the band §3 gives their region', () {
    SeatPriority of(String key) => seatPolicyOf(key).priority;
    // Message level: one platform view per message (§3, 「不做岛」).
    for (final key in ['conversation.chat.commandview', 'conversation.chat.markdown.fence']) {
      expect(of(key), SeatPriority.message, reason: key);
      expect(seatPolicyOf(key).islands, isEmpty, reason: key);
    }
    // The 「插件」 panel's band: the session header action lists (P1).
    expect(of('conversation.session.header.actions.subagent.footer'), SeatPriority.p1);
    expect(seatPolicyOf('conversation.session.header.actions.subagent.footer').islands, {IslandForm.panel});
    // The app's own surfaces (§3, 「不做」): hero, model menu, settings launcher,
    // sidebar session row, workspace directory picker.
    for (final key in [
      'conversation.hero.frame',
      'conversation.input.model.options',
      'settings.launcher.notifications',
      'sidebar.session.action',
      'workspace.picker.directoryFlow',
    ]) {
      expect(slotInfo(key)!.seatable, isFalse, reason: key);
      expect(seatPolicyOf(key).priority, SeatPriority.never, reason: key);
      expect(seatPolicyOf(key).islands, isEmpty, reason: key);
    }
  });

  test("rc.4's three 「更多」 menus are known, seatable at most as a web entry, and get no seat", () {
    for (final key in [Slots.headerViewsActions, Slots.panelListActions, Slots.guideActions]) {
      final info = slotInfo(key)!;
      expect(info.kind, SlotKind.list, reason: key);
      expect(info.scope, SlotScope.root, reason: key);
      expect(info.replacesShippedUi, isFalse, reason: key);
      expect(info.policy.priority, SeatPriority.other, reason: key);
      expect(info.policy.islands, isEmpty, reason: key);
    }
  });

  test('§3 priorities', () {
    SeatPriority of(String key) => seatPolicyOf(key).priority;
    for (final key in [
      Slots.settingsSection,
      Slots.bundleConfig,
      Slots.rowConfig,
      Slots.rightPaneTab,
      Slots.main,
      Slots.panelList,
      Slots.cordisView,
    ]) {
      expect(of(key), SeatPriority.p0, reason: key);
    }
    for (final key in [...Slots.chatPanel, Slots.generalItem]) {
      expect(of(key), SeatPriority.p1, reason: key);
    }
    expect(of(Slots.shellOverlay), SeatPriority.p2);
    expect(of(Slots.dshGoPanel), SeatPriority.p2);
    for (final key in [
      'conversation.chat.turnTail',
      'conversation.chat.assistant-actions',
      'conversation.chat.node',
      'conversation.user.text.node',
      'tool.call.toolview',
      'tool.call.images',
    ]) {
      expect(of(key), SeatPriority.message, reason: key);
      expect(seatPolicyOf(key).islands, isEmpty);
    }
    for (final key in [
      'root',
      'sidebar',
      'conversation.header',
      'conversation.composer.bar',
      'conversation.session',
      'main.conversation',
      'shell.leading',
      'shell.bottom',
      'settings.trigger',
      'settings.header',
      'settings.launcher',
      Slots.rightPaneTabTitle,
    ]) {
      expect(slotInfo(key)!.seatable, isFalse, reason: key);
    }
    for (final key in [Slots.sidebarFooter, Slots.settingsPluginsTab, Slots.pluginDetailSection]) {
      expect(seatPolicyOf(key).priority, SeatPriority.p1);
      expect(seatPolicyOf(key).needsOccupancy, isTrue);
      expect(seatPolicyOf(key).islands, {IslandForm.page});
      expect(Slots.seated, contains(key));
    }
    expect(seatPolicyOf('not.a.slot'), SeatPolicy.other);
  });

  test('island forms per §3 and §6.2', () {
    expect(seatPolicyOf(Slots.settingsSection).islands, {IslandForm.page});
    expect(seatPolicyOf(Slots.inputDock).islands, {IslandForm.panel});
    expect(seatPolicyOf(Slots.inputDock).needsOccupancy, isTrue);
    expect(seatPolicyOf(Slots.shellOverlay).optIn, isTrue);
    expect(seatPolicyOf(Slots.bundleConfig).inference, SlotInference.bundleConfig);
    expect(seatPolicyOf(Slots.rowConfig).inference, SlotInference.rowConfig);
    expect(seatPolicyOf(Slots.dshGoPanel).webLink, isFalse);
    // Every island-capable slot is one the app seats.
    for (final info in slotCatalog.values) {
      if (info.policy.islands.isNotEmpty) expect(info.seatable, isTrue, reason: info.key);
    }
  });

  test('ui.json values', () {
    expect(SeatOverride.tryParse('native'), SeatOverride.native);
    expect(SeatOverride.tryParse('island'), SeatOverride.island);
    expect(SeatOverride.tryParse('web'), SeatOverride.web);
    expect(SeatOverride.tryParse('hidden'), SeatOverride.hidden);
    expect(SeatOverride.tryParse('Native'), isNull);
    expect(SeatOverride.tryParse(null), isNull);
    const a = SeatOverrides({
      'shell.overlay': {'dsh-pet': SeatOverride.island},
    });
    const b = SeatOverrides({
      'shell.overlay': {'dsh-pet': SeatOverride.island},
      'main': {},
    });
    expect(a, b);
    expect(a.hashCode, b.hashCode);
    expect(a.lookup('shell.overlay', 'dsh-pet'), SeatOverride.island);
    expect(a.lookup('shell.overlay', 'other'), isNull);
    expect(SeatOverrides.none.isEmpty, isTrue);
    expect(b.isEmpty, isFalse);
  });
}
