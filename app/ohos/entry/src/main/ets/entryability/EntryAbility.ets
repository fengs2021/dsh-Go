import workScheduler from '@ohos.resourceschedule.workScheduler';
import hilog from '@ohos.hilog';
import common from '@ohos.app.ability.common';
import PastePlugin from '../plugins/PastePlugin';
import AppLinksPlugin from '../plugins/AppLinksPlugin';
import SecretsPlugin from '../plugins/SecretsPlugin';
import AttachmentFilesPlugin from '../plugins/AttachmentFilesPlugin';
import IslandsPlugin from '../plugins/IslandsPlugin';
import NotifyPlugin from '../plugins/NotifyPlugin';
import { FlutterAbility, FlutterEngine } from '@ohos/flutter_ohos';
import ConnectivityPlugin from '../plugins/ConnectivityPlugin';
import { GeneratedPluginRegistrant } from '../plugins/GeneratedPluginRegistrant';
import { RuntimePlugin } from '../runtime/RuntimePlugin';
import { RuntimeController } from '../runtime/RuntimeController';
import FilesMediaPlugin from '../plugins/FilesMediaPlugin';
import AuthorizedWorkspacesPlugin from '../plugins/AuthorizedWorkspacesPlugin';
import NativeFilesPlugin from '../plugins/NativeFilesPlugin';
import NativeMediaPlugin from '../plugins/NativeMediaPlugin';
import { NativeVoiceStopControl } from '../plugins/NativeVoiceStopControl';
import PerformancePlugin from '../plugins/PerformancePlugin';
import { OhosKeyboardLog } from '../plugins/OhosKeyboardLog';
import DiagnosticsPlugin from '../plugins/DiagnosticsPlugin';
import UsagePlugin from '../plugins/UsagePlugin';
import { loadNativeHost } from '../runtime/NativeHost';
import WebFilesPlugin from '../plugins/WebFilesPlugin';
import HmsSharePlugin from '../plugins/HmsSharePlugin';
import { HmsShareInbox } from '../plugins/HmsShareInbox';
import ShortcutsPlugin from '../plugins/ShortcutsPlugin';
import LauncherIconPlugin from '../plugins/LauncherIconPlugin';
import PictureShortcutPlugin from '../plugins/PictureShortcutPlugin';
import LaunchPlugin from '../plugins/LaunchPlugin';
import LaunchClipPlugin from '../plugins/LaunchClipPlugin';
import MediaVideoPlugin from '../plugins/MediaVideoPlugin';
import VoicePlugin from '../plugins/VoicePlugin';
import SpeechPlugin from '../plugins/SpeechPlugin';
import CompanionVoicePlugin from '../plugins/CompanionVoicePlugin';
import StreamingAsrPlugin from '../plugins/StreamingAsrPlugin';
import CompanionWidgetPlugin from '../plugins/CompanionWidgetPlugin';
import Want from '@ohos.app.ability.Want';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import window from '@ohos.window';
import PipPlugin from '../plugins/PipPlugin';
import { FloatWindowManager } from '../window/FloatWindowManager';

export default class EntryAbility extends FlutterAbility {
  private keyboardLog: OhosKeyboardLog = new OhosKeyboardLog();

  onCreate(want: Want, launch: AbilityConstant.LaunchParam): void {
    hilog.warn(0x3F10, 'DshWake', 'entry onCreate entered');
    FloatWindowManager.getInstance().init(this.context);
    HmsShareInbox.receive(this.context, want, launch);
    ShortcutsPlugin.receive(want, launch);
    // 熄屏状态下启动不会有 onForeground，这里也要注册一次（幂等）。
    EntryAbility.ensureWakeWork(this.context);
    super.onCreate(want, launch);
  }

  /// 注册系统延迟任务：系统会在满足条件时拉起 EngineWakeAbility 做一次「探活」。
  ///
  /// 频率按官方约束：活跃应用最小间隔 2 小时（常用 24 小时、极少使用 48 小时），
  /// 单次回调最长 2 分钟，扩展里禁止 backgroundTaskManager —— 所以它只做兜底：
  /// 引擎不在时发一条通知，不假装能跑定时回合。重复注册幂等：先 stopWork 再 startWork。
  private static ensureWakeWork(context: common.UIAbilityContext): void {
    const work: workScheduler.WorkInfo = {
      workId: 1001,
      bundleName: 'ccchimneyyy.dsh.go',
      abilityName: 'EngineWakeAbility',
      isRepeat: true,
      repeatCycleTime: 2 * 60 * 60 * 1000,
      isPersisted: true,
      networkType: workScheduler.NetworkType.NETWORK_TYPE_ANY
    };
    // 参数要能更新：同 workId 已存在时 startWork 只会报「already added」，
    // 先按同一 workId 结束，再注册本次的条件。
    try {
      workScheduler.stopWork(work, true);
    } catch (_) {
      // 没有已注册的 work 时 stopWork 会抛，忽略。
    }
    try {
      workScheduler.startWork(work);
      hilog.warn(0x3F10, 'DshWake', 'wake work registered');
    } catch (error) {
      hilog.warn(0x3F10, 'DshWake', 'wake work rejected: %{public}s', (error as Error).message);
    }
  }

  onNewWant(want: Want, launch: AbilityConstant.LaunchParam): void {
    HmsShareInbox.receive(this.context, want, launch);
    ShortcutsPlugin.receive(want, launch);
    super.onNewWant(want, launch);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    super.onWindowStageCreate(windowStage);
    PerformancePlugin.applyFrameCache();
    this.keyboardLog.attach(windowStage);
  }

  onWindowStageDestroy(): void {
    this.keyboardLog.detach();
    super.onWindowStageDestroy();
  }

  onForeground(): void {
    EntryAbility.ensureWakeWork(this.context);
    FloatWindowManager.getInstance().onForeground();
    this.keyboardLog.setForeground(true);
    PastePlugin.onForeground(this);
    AppLinksPlugin.onForeground(this);
    RuntimeController.onForeground(this);
    VoicePlugin.onForeground(this);
    SpeechPlugin.onForeground(this);
    CompanionVoicePlugin.onForeground(this);
    StreamingAsrPlugin.onForeground(this);
    NativeFilesPlugin.onForeground(this);
    AuthorizedWorkspacesPlugin.onForeground(this);
    NativeMediaPlugin.onForeground(this);
    MediaVideoPlugin.onForeground(this);
    PictureShortcutPlugin.onForeground(this);
    super.onForeground();
  }

  onBackground(): void {
    FloatWindowManager.getInstance().onBackground();
    this.keyboardLog.setForeground(false);
    PastePlugin.onBackground(this);
    AppLinksPlugin.onBackground(this);
    RuntimeController.onBackground(this);
    VoicePlugin.onBackground(this);
    SpeechPlugin.onBackground(this);
    CompanionVoicePlugin.onBackground(this);
    StreamingAsrPlugin.onBackground(this);
    NativeFilesPlugin.onBackground(this);
    AuthorizedWorkspacesPlugin.onBackground(this);
    NativeMediaPlugin.onBackground(this);
    MediaVideoPlugin.onBackground(this);
    PictureShortcutPlugin.onBackground(this);
    super.onBackground();
  }

  onDestroy(): void {
    FloatWindowManager.getInstance().destroy();
    MediaVideoPlugin.onDestroy(this);
    PictureShortcutPlugin.onBackground(this);
    this.keyboardLog.setForeground(false);
    this.keyboardLog.detach();
    SpeechPlugin.onBackground(this);
    CompanionVoicePlugin.onBackground(this);
    StreamingAsrPlugin.onBackground(this);
    PastePlugin.onBackground(this);
    RuntimeController.onDestroy(this);
    AuthorizedWorkspacesPlugin.onBackground(this);
    super.onDestroy();
  }

  configureFlutterEngine(flutterEngine: FlutterEngine) {
    flutterEngine.getPlugins()?.add(new AppLinksPlugin())
    super.configureFlutterEngine(flutterEngine)
    flutterEngine.getPlugins()?.add(new ConnectivityPlugin())
    GeneratedPluginRegistrant.registerWith(flutterEngine)
    flutterEngine.getPlugins()?.add(new SecretsPlugin())
    flutterEngine.getPlugins()?.add(new AttachmentFilesPlugin())
    flutterEngine.getPlugins()?.add(new RuntimePlugin())
    flutterEngine.getPlugins()?.add(new FilesMediaPlugin())
    flutterEngine.getPlugins()?.add(new WebFilesPlugin())
    flutterEngine.getPlugins()?.add(new IslandsPlugin())
    flutterEngine.getPlugins()?.add(new NotifyPlugin())
    flutterEngine.getPlugins()?.add(new NativeFilesPlugin())
    flutterEngine.getPlugins()?.add(new AuthorizedWorkspacesPlugin())
    flutterEngine.getPlugins()?.add(new NativeMediaPlugin(async (root: string, relative: string): Promise<number> => {
      const host = await loadNativeHost();
      return host.openUserFile(root, relative);
    }, new NativeVoiceStopControl(this.context)))
    flutterEngine.getPlugins()?.add(new PerformancePlugin())
    flutterEngine.getPlugins()?.add(new DiagnosticsPlugin(this.keyboardLog))
    flutterEngine.getPlugins()?.add(new UsagePlugin())
    flutterEngine.getPlugins()?.add(new PastePlugin())
    flutterEngine.getPlugins()?.add(new HmsSharePlugin())
    flutterEngine.getPlugins()?.add(new VoicePlugin())
    flutterEngine.getPlugins()?.add(new SpeechPlugin())
    flutterEngine.getPlugins()?.add(new CompanionVoicePlugin())
    flutterEngine.getPlugins()?.add(new StreamingAsrPlugin())
    flutterEngine.getPlugins()?.add(new CompanionWidgetPlugin())
    flutterEngine.getPlugins()?.add(new ShortcutsPlugin())
    flutterEngine.getPlugins()?.add(new LauncherIconPlugin())
    flutterEngine.getPlugins()?.add(new PictureShortcutPlugin())
    flutterEngine.getPlugins()?.add(new LaunchPlugin())
    flutterEngine.getPlugins()?.add(new LaunchClipPlugin())
    flutterEngine.getPlugins()?.add(new PipPlugin())
    flutterEngine.getPlugins()?.add(new MediaVideoPlugin(async (root: string, relative: string): Promise<number> => {
      return (await loadNativeHost()).openUserFile(root, relative);
    }))
  }
}
