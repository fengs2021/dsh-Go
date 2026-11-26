/*
 * dsh/pip：Dart 侧驱动画中画悬浮小窗的唯一入口。
 *
 * 两条路各自独立：show/hide/toggle 管应用内浮层（同一窗口内的 ArkUI），float* 管系统级
 * TYPE_FLOAT 悬浮窗（可以盖在别的应用上）。内容与配色都写进 PipState，两个宿主自己订阅。
 */
import {
  Any, FlutterPlugin, FlutterPluginBinding, MethodCall, MethodCallHandler, MethodChannel, MethodResult
} from '@ohos/flutter_ohos';
import {
  PipGlow, PipMode, PipState, PipTheme, defaultPipTheme
} from '../window/PipState';
import { FloatWindowManager } from '../window/FloatWindowManager';

export default class PipPlugin implements FlutterPlugin, MethodCallHandler {
  private channel?: MethodChannel;

  getUniqueClassName(): string {
    return 'DshPipPlugin';
  }

  onAttachedToEngine(binding: FlutterPluginBinding): void {
    this.channel = new MethodChannel(binding.getBinaryMessenger(), 'dsh/pip');
    this.channel.setMethodCallHandler(this);
  }

  onDetachedFromEngine(_binding: FlutterPluginBinding): void {
    this.channel?.setMethodCallHandler(null);
    this.channel = undefined;
  }

  onMethodCall(call: MethodCall, result: MethodResult): void {
    const state: PipState = PipState.getInstance();
    switch (call.method) {
      case 'show': {
        const compact: boolean = call.argument('compact') === true;
        if (compact) {
          state.showMini();
        } else {
          state.showExpanded();
        }
        result.success(true);
        return;
      }
      case 'hide':
        state.hide();
        result.success(true);
        return;
      case 'toggle': {
        state.toggle();
        result.success(state.isVisible());
        return;
      }
      case 'setContent': {
        const title: string = (call.argument('title') ?? '') as string;
        const status: string = (call.argument('status') ?? '') as string;
        const glow: string = (call.argument('glow') ?? PipGlow.NORMAL) as string;
        state.setContent(title, status);
        state.setGlow(PipPlugin.parseGlow(glow));
        result.success(true);
        return;
      }
      case 'setDetail': {
        const detail: string = (call.argument('detail') ?? '') as string;
        const tool: string = (call.argument('tool') ?? '') as string;
        const raw: Any = call.argument('toolsDone');
        const toolsDone: number = typeof raw === 'number' ? raw : 0;
        state.setDetail(detail, tool, toolsDone);
        result.success(true);
        return;
      }
      case 'setTheme': {
        state.setTheme(PipPlugin.parseTheme(call));
        result.success(true);
        return;
      }
      case 'float': {
        const show: boolean = call.argument('show') === true;
        const compact: boolean = call.argument('compact') === true;
        const manager: FloatWindowManager = FloatWindowManager.getInstance();
        const applied: Promise<boolean> = show
          ? manager.show(compact)
          : manager.hide().then((): boolean => false);
        applied.then((shown: boolean): void => {
          result.success(shown);
        }).catch((error: Error): void => {
          result.error('pip_float_failed', error.message, null);
        });
        return;
      }
      case 'floatAuto': {
        FloatWindowManager.getInstance().setAuto(call.argument('enabled') === true);
        result.success(true);
        return;
      }
      case 'bringToFront': {
        FloatWindowManager.getInstance().bringToFront().then((): void => {
          result.success(true);
        }).catch((error: Error): void => {
          result.error('pip_front_failed', error.message, null);
        });
        return;
      }
      default:
        result.notImplemented();
        return;
    }
  }

  private static parseGlow(value: string): PipGlow {
    if (value === PipGlow.RUNNING) {
      return PipGlow.RUNNING;
    }
    if (value === PipGlow.ATTENTION) {
      return PipGlow.ATTENTION;
    }
    return PipGlow.NORMAL;
  }

  /// 只覆盖 ColorScheme 里真有的槽位；success / warning 这类语义色随明暗切换固定值，
  /// 由 defaultPipTheme 给，避免在 Dart 侧再造一套语义色。
  private static parseTheme(call: MethodCall): PipTheme {
    const dark: boolean = call.argument('dark') === true;
    const base: PipTheme = defaultPipTheme(dark);
    const surface: Any = call.argument('surface');
    const surfaceLow: Any = call.argument('surfaceLow');
    const onSurface: Any = call.argument('onSurface');
    const onSurfaceMuted: Any = call.argument('onSurfaceMuted');
    const rule: Any = call.argument('rule');
    const accent: Any = call.argument('accent');
    return {
      dark: dark,
      surface: typeof surface === 'string' ? surface : base.surface,
      surfaceLow: typeof surfaceLow === 'string' ? surfaceLow : base.surfaceLow,
      onSurface: typeof onSurface === 'string' ? onSurface : base.onSurface,
      onSurfaceMuted: typeof onSurfaceMuted === 'string' ? onSurfaceMuted : base.onSurfaceMuted,
      rule: typeof rule === 'string' ? rule : base.rule,
      accent: typeof accent === 'string' ? accent : base.accent,
      success: base.success,
      warning: base.warning
    };
  }
}
