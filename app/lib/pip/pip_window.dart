// SPDX-FileCopyrightText: 2026 CikeSeven
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import 'package:flutter/foundation.dart' show immutable;
import 'package:flutter/services.dart';

/// 画中画小窗的状态点：绿=在跑，琥珀=等你，灰=静止。
enum PipGlow { normal, running, attention }

/// 鸿蒙画中画悬浮小窗（ArkTS 侧 `dsh/pip`）的 Dart 入口。
///
/// 两种形态由原生决定，Dart 只负责说什么、给什么颜色：
/// - 应用内浮层（同一窗口内的 ArkUI 层）：App 前台时贴在界面上；
/// - 系统悬浮窗（TYPE_FLOAT）：App 退到后台后接着显示，能压在别的应用之上。
///
/// 其它平台没有这个插件,[invoke] 吞掉 MissingPluginException 并返回 false，
/// 调用方不用按平台分支。
@immutable
class PipWindow {
  const PipWindow([this._channel = const MethodChannel('dsh/pip')]);

  final MethodChannel _channel;

  Future<bool> show({bool compact = false}) => _invoke('show', {'compact': compact});

  Future<bool> hide() => _invoke('hide');

  Future<bool> toggle() => _invoke('toggle');

  Future<bool> setContent({required String title, String status = '', PipGlow glow = PipGlow.normal}) =>
      _invoke('setContent', {'title': title, 'status': status, 'glow': glow.name});

  /// 允许 App 退到后台时自动升起系统悬浮窗。
  Future<bool> setFloatAuto(bool enabled) => _invoke('floatAuto', {'enabled': enabled});

  Future<bool> showFloat({bool compact = true}) => _invoke('float', {'show': true, 'compact': compact});

  Future<bool> hideFloat() => _invoke('float', {'show': false});

  Future<bool> bringToFront() => _invoke('bringToFront');

  /// 跨窗口没有 Material context，浮窗的色值只能由这里下发；没下发时原生用
  /// palette.dart 的默认值（雾蓝 + 跟随系统明暗）。
  Future<bool> applyTheme({
    required bool dark,
    required int surface,
    required int surfaceLow,
    required int onSurface,
    required int onSurfaceMuted,
    required int rule,
    required int accent,
  }) =>
      _invoke('setTheme', {
        'dark': dark,
        'surface': _hex(surface),
        'surfaceLow': _hex(surfaceLow),
        'onSurface': _hex(onSurface),
        'onSurfaceMuted': _hex(onSurfaceMuted),
        'rule': _hex(rule),
        'accent': _hex(accent),
      });

  Future<bool> _invoke(String method, [Map<String, Object?>? arguments]) async {
    try {
      return await _channel.invokeMethod<bool>(method, arguments) ?? false;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      // 原生侧拒绝（比如系统悬浮窗权限没给），按「没开成」处理，别炸调用方。
      return false;
    }
  }

  static String _hex(int argb) =>
      '#${(argb & 0xFFFFFF).toRadixString(16).padLeft(6, '0').toUpperCase()}';
}
