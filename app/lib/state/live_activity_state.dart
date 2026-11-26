// Keeps the live activity (lib/notify/live_activity.dart) fed: the global pet
// state in words, pushed to `dsh/notify` whenever it changes.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../l10n/l10n.dart';
import '../notify/live_activity.dart';
import '../pip/pip_window.dart';
import '../ui/chat/run_info.dart' show runActivityProvider;
import '../notify/live_art.dart';
import '../pets/pet_signals.dart';
import '../pets/pet_state.dart';
import 'android_features.dart';
import 'appearance_state.dart';
import 'notify_state.dart';

export '../notify/live_activity.dart';

/// Titles seen running or focused, so a finished conversation keeps its name.
final _liveTitlesProvider = Provider<Map<PetTarget, String>>((ref) => <PetTarget, String>{});

/// What the live activity shows now; null: nothing. Reads the pet's own
/// signals, so it sees exactly what the pet sees.
final liveActivityProvider = Provider<LiveActivity?>((ref) {
  final signals = ref.watch(petSignalsProvider);
  final titles = ref.watch(_liveTitlesProvider);
  learnLiveTitles(titles, signals.runs, focus: signals.focus);
  final prefs = ref.watch(notifyPrefsProvider);
  return liveActivityOf(
    pet: ref.watch(petStateProvider),
    runs: signals.runs,
    pending: signals.pending,
    focus: signals.focus,
    titles: titles,
    showDone: prefs.done,
    showFailed: prefs.failed,
  );
});

/// What `dsh/notify` is told: off with notifications or the switch, else the
/// activity and the pet whose pictures it uses.
final livePushProvider = Provider<LivePush>((ref) {
  final enabled = ref.watch(notifyPrefsProvider.select((p) => p.enabled && p.live));
  return LivePush(
    enabled: enabled,
    packId: ref.watch(petStateProvider.select((s) => s.packId == noPetId ? null : s.packId)),
    activity: enabled ? ref.watch(liveActivityProvider) : null,
  );
});

/// What iOS draws besides the [LivePush]: the theme's accent (light, dark) and
/// whether 停止 can work, which is when the floating pet's own stop can
/// ([PetState.canStop]) and the card is about the pet's conversation.
typedef IosLive = ({LivePush push, int tint, int tintDark, bool canStop});

final iosLiveProvider = Provider<IosLive>((ref) {
  final push = ref.watch(livePushProvider);
  final accent = ref.watch(accentProvider);
  final target = push.activity?.target;
  final canStop = ref.watch(petStateProvider.select((s) => s.canStop && target != null && s.target == target));
  return (push: push, tint: accent.seed.toARGB32(), tintDark: accent.seedDark.toARGB32(), canStop: canStop);
});

/// Watch it to keep the live activity fed (with the pet overlay's bridge, in
/// both 原生 and 网页 modes). Equal pushes are not sent twice.
final liveActivityBridgeProvider = Provider<void>((ref) {
  final os = ref.read(operatingSystemProvider);
  if (os == 'ios') {
    final sender = _IosLiveSender(ref);
    ref.listen<IosLive>(iosLiveProvider, (previous, next) {
      if (previous != next) sender.send(next);
    }, fireImmediately: true);
    return;
  }
  // Only OH owns an ordinary fallback here. Android keeps its original
  // native live-activity lifecycle and receives no extra disposal message.
  if (os == 'ohos') {
    final channel = ref.read(notifyChannelProvider);
    ref.onDispose(() => unawaited(channel.live(const LivePush(enabled: false))));
    // 画中画浮窗吃的是同一份实时活动：在跑时贴一枚胶囊，退到后台交给原生系统悬浮窗。
    const pip = PipWindow();
    ref.listen<LivePush>(livePushProvider, (previous, next) {
      if (previous == next) return;
      unawaited(_feedPip(pip, next));
    }, fireImmediately: true);
    ref.listen<_PipDetail?>(_pipDetailProvider, (previous, next) {
      if (previous == next) return;
      unawaited(pip.setDetail(
        detail: next?.detail ?? '',
        tool: next?.tool ?? '',
        toolsDone: next?.toolsDone ?? 0,
      ));
    }, fireImmediately: true);
  }
  ref.listen<LivePush>(livePushProvider, (previous, next) {
    if (previous == next) return;
    unawaited(ref.read(notifyChannelProvider).live(next));
  }, fireImmediately: true);
});

/// 浮窗展开态要的细节：最新一句回复/叙述 + 正在跑的工具。
/// 与实时活动同源（RunActivity 就是输入条上方那条活动条的内容），不另造状态。
typedef _PipDetail = ({String detail, String tool, int toolsDone});

final _pipDetailProvider = Provider<_PipDetail?>((ref) {
  final focus = ref.watch(petSignalsProvider).focus;
  if (focus == null) return null;
  final activity = ref.watch(runActivityProvider(focus.sessionId));
  if (activity == null) return null;
  final detail = activity.narration ?? activity.detail;
  return (detail: detail, tool: activity.toolName ?? '', toolsDone: activity.toolsDone);
});

/// 把实时活动翻译成浮窗要的三样东西：说什么、什么色的点、要不要自动升系统悬浮窗。
/// 在跑才升应用内胶囊；等你/出错误切琥珀并收起，交给通知去提醒。
Future<void> _feedPip(PipWindow pip, LivePush push) async {
  final activity = push.enabled ? push.activity : null;
  if (activity == null) {
    await pip.setContent(title: '');
    await pip.setFloatAuto(false);
    await pip.hide();
    return;
  }
  final glow = switch (activity.kind) {
    LiveKind.running => PipGlow.running,
    LiveKind.waiting => PipGlow.attention,
    LiveKind.failed => PipGlow.attention,
    LiveKind.done => PipGlow.normal,
  };
  await pip.setContent(title: activity.title, status: activity.text, glow: glow);
  await pip.setFloatAuto(activity.kind == LiveKind.running || activity.kind == LiveKind.waiting);
  if (activity.kind == LiveKind.running) {
    await pip.show(compact: true);
  } else {
    await pip.hide();
  }
}

/// One push at a time, in order: the still for an older state, slow to draw,
/// can't land on a newer one. Each picture crosses the channel once.
class _IosLiveSender {
  _IosLiveSender(this.ref);

  final Ref ref;
  Future<void> _tail = Future.value();
  final _arts = <String, LiveArt>{};
  String? _sent;

  void send(IosLive live) => _tail = _tail.then((_) => _send(live)).catchError((Object _) {});

  Future<void> _send(IosLive live) async {
    if (!ref.mounted) return;
    final push = live.push;
    final activity = push.activity, packId = push.packId;
    final art = push.enabled && activity != null && packId != null ? await _art(packId, activity.mood) : null;
    if (!ref.mounted) return;
    final l10n = appL10n;
    await ref.read(notifyChannelProvider).liveWith(push, {
      'tint': live.tint,
      'tintDark': live.tintDark,
      'canStop': live.canStop,
      'labels': {'stop': l10n.liveStop, 'stale': l10n.liveStale},
      // Null says so: native keeps extras a push leaves out, so the last pet's
      // picture would otherwise stay on a pet that has none.
      'artKey': art?.key,
      'artPixel': art?.pixelArt ?? false,
      if (art != null && art.key != _sent) 'art': art.png,
    });
    if (art != null) _sent = art.key;
  }

  Future<LiveArt?> _art(String packId, PetStateName mood) async {
    try {
      final pack = await ref.read(petPackProvider(packId).future);
      // The pack object, not its id: a pet brought again under the same id is new.
      final key = '${identityHashCode(pack)}/${mood.name}';
      if (_arts[key] case final art?) return art;
      final art = await liveArtOf(pack, mood, ref.read(petAssetBundleProvider));
      if (art == null) return null;
      if (_arts.length >= 16) _arts.remove(_arts.keys.first);
      return _arts[key] = art;
    } on Object {
      return null;
    }
  }
}

/// What the phone offers; re-read with `ref.invalidate` when the app comes back.
final liveSystemStatusProvider = FutureProvider<LiveSystemStatus>(
  (ref) => ref.watch(notifyChannelProvider).liveStatus(),
);
