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
import { DanmakuService } from '../runtime/DanmakuService';
import FilesMediaPlugin from '../plugins/FilesMediaPlugin';
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
import LaunchPlugin from '../plugins/LaunchPlugin';
import LaunchClipPlugin from '../plugins/LaunchClipPlugin';
import VoicePlugin from '../plugins/VoicePlugin';
import fs from '@ohos.file.fs';
import hilog from '@ohos.hilog';
import Want from '@ohos.app.ability.Want';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import window from '@ohos.window';

export default class EntryAbility extends FlutterAbility {
  private keyboardLog: OhosKeyboardLog = new OhosKeyboardLog();

  onCreate(want: Want, launch: AbilityConstant.LaunchParam): void {
    hilog.error(0x3F00, 'DshDanmaku', 'onCreate probe v22');
    // 探针：证明 EntryAbility.onCreate 真的跑到我们这层（结果写成 files 根目录下可读文件）。
    try {
      const probe = fs.openSync(this.context.getApplicationContext().filesDir + '/danmaku-oncreate.txt', fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.WRITE_ONLY);
      try { fs.writeSync(probe.fd, 'onCreate ' + Date.now()); } finally { fs.closeSync(probe); }
    } catch (error) { hilog.error(0x3F00, 'DshDanmaku', 'onCreate probe failed'); }
    HmsShareInbox.receive(this.context, want, launch);
    ShortcutsPlugin.receive(want, launch);
    super.onCreate(want, launch);
    // 尽早挂上：即使窗口阶段回调异常，弹幕状态与通知也能起来。
    DanmakuService.shared().attachSafe(this.context);
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
    // 后台进度弹幕：前台走应用内浮层，后台走通知栏（无需任何系统级权限）。
    DanmakuService.shared().attachSafe(this.context);
  }

  onWindowStageDestroy(): void {
    this.keyboardLog.detach();
    super.onWindowStageDestroy();
  }

  onForeground(): void {
    DanmakuService.shared().onForeground();
    PastePlugin.onForeground(this);
    AppLinksPlugin.onForeground(this);
    RuntimeController.onForeground(this);
    VoicePlugin.onForeground(this);
    NativeFilesPlugin.onForeground(this);
    NativeMediaPlugin.onForeground(this);
    super.onForeground();
  }

  onBackground(): void {
    DanmakuService.shared().onBackground();
    PastePlugin.onBackground(this);
    AppLinksPlugin.onBackground(this);
    RuntimeController.onBackground(this);
    VoicePlugin.onBackground(this);
    NativeFilesPlugin.onBackground(this);
    NativeMediaPlugin.onBackground(this);
    super.onBackground();
  }

  onDestroy(): void {
    DanmakuService.shared().detach();
    PastePlugin.onBackground(this);
    RuntimeController.onDestroy(this);
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
    flutterEngine.getPlugins()?.add(new NativeMediaPlugin(async (root: string, relative: string): Promise<number> => {
      const host = await loadNativeHost();
      return host.openUserFile(root, relative);
    }, new NativeVoiceStopControl(this.context)))
    flutterEngine.getPlugins()?.add(new PerformancePlugin())
    flutterEngine.getPlugins()?.add(new DiagnosticsPlugin())
    flutterEngine.getPlugins()?.add(new UsagePlugin())
    flutterEngine.getPlugins()?.add(new PastePlugin())
    flutterEngine.getPlugins()?.add(new HmsSharePlugin())
    flutterEngine.getPlugins()?.add(new VoicePlugin())
    flutterEngine.getPlugins()?.add(new ShortcutsPlugin())
    flutterEngine.getPlugins()?.add(new LauncherIconPlugin())
    flutterEngine.getPlugins()?.add(new LaunchPlugin())
    flutterEngine.getPlugins()?.add(new LaunchClipPlugin())
  }
}
