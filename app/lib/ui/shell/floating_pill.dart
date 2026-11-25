import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../l10n/l10n.dart';
import '../../state/chat_state.dart';
import '../../state/sessions_state.dart';
import '../theme/theme.dart';

/// 应用内悬浮小窗（胶囊）：跨页面常驻，显示当前会话是否在跑，点开可回到会话。
///
/// 为什么不是系统级悬浮窗：`WindowType.TYPE_FLOAT` 要受限权限
/// `ohos.permission.SYSTEM_FLOAT_WINDOW`，第三方即使写进 module.json5，
/// `atm perm -g` 也报 `not requested by the application`（实测），所以只能做应用内浮层。
class FloatingPillController extends Notifier<bool> {
  static const _key = 'floating_pill_enabled';

  @override
  bool build() {
    // 默认开着：这是用户要的「小悬浮窗」，能在设置里关掉。
    unawaited(_restore());
    return true;
  }

  Future<void> _restore() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getBool(_key);
    if (saved != null && ref.mounted) state = saved;
  }

  Future<void> set(bool enabled) async {
    state = enabled;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_key, enabled);
  }
}

final floatingPillProvider = NotifierProvider<FloatingPillController, bool>(FloatingPillController.new);

/// 贴在屏幕右下角的可拖拽胶囊；只在开关打开时挂载。
class FloatingPill extends ConsumerStatefulWidget {
  const FloatingPill({super.key});

  @override
  ConsumerState<FloatingPill> createState() => _FloatingPillState();
}

class _FloatingPillState extends ConsumerState<FloatingPill> {
  Offset? _position;
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final sessionId = ref.watch(currentSessionProvider);
    if (sessionId == null) return const SizedBox.shrink();
    final running = ref.watch(chatProvider(sessionId).select((s) => s.running));
    final title = ref.watch(chatProvider(sessionId).select((s) => s.title));
    final scheme = Theme.of(context).colorScheme;
    final muted = DshColors.of(context).textTertiary;
    final size = MediaQuery.sizeOf(context);
    final position = _position ?? Offset(size.width - 76, size.height - 148);

    return Positioned(
      left: position.dx,
      top: position.dy,
      child: GestureDetector(
        onPanUpdate: (details) {
          setState(() {
            final next = position + details.delta;
            _position = Offset(
              next.dx.clamp(8.0, size.width - 72),
              next.dy.clamp(8.0, size.height - 120),
            );
          });
        },
        onTap: () => setState(() => _expanded = !_expanded),
        child: Material(
          color: Colors.transparent,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            width: _expanded ? 248 : 56,
            padding: EdgeInsets.symmetric(horizontal: _expanded ? 14 : 12, vertical: 12),
            decoration: BoxDecoration(
              color: scheme.surface,
              borderRadius: BorderRadius.circular(_expanded ? 18 : 28),
              border: Border.all(color: scheme.outlineVariant),
              boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 16, offset: Offset(0, 6))],
            ),
            child: _expanded
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Row(children: [
                        _Dot(running: running, on: scheme.primary, off: muted),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            (title ?? '').isEmpty ? context.l10n.chatQueue : title!,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                        ),
                      ]),
                      const SizedBox(height: 6),
                      Text(
                        running ? context.l10n.chatThinking : context.l10n.harmonyBackgroundSubtitle,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(color: muted),
                      ),
                      const SizedBox(height: 10),
                      Row(children: [
                        TextButton(
                          onPressed: () => ref.read(floatingPillProvider.notifier).set(false),
                          child: Text(context.l10n.chatQueue),
                        ),
                      ]),
                    ],
                  )
                : Center(child: _Dot(running: running, on: scheme.primary, off: muted, large: true)),
          ),
        ),
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.running, required this.on, required this.off, this.large = false});

  final bool running;
  final Color on;
  final Color off;
  final bool large;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: large ? 18 : 8,
      height: large ? 18 : 8,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: running ? on : off,
      ),
    );
  }
}
