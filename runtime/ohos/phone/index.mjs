import { PhoneQueue } from './queue.mjs';
import { createNativePhonePort } from './native-port.mjs';
import { registerPhoneRoutes } from './routes.mjs';
import { registerPhoneTools } from './tools.mjs';
import { registerUiTools, shText, dumpUi } from './ui-tools.mjs';
import { registerSessionTools } from './session-tools.mjs';
import { startProgressFeed } from './progress-feed.mjs';
import { diagnoseHdc } from './hdc-link.mjs';
import { authorizedStatus, probeAndWrite, startHdcStatusWatch } from './hdc-status.mjs';

export const name = 'dsh-go-ohos-phone';
export const inject = ['tools', 'ohosLifecycle', 'approval'];
const simulationSymbol = Symbol.for('dsh.go.ohos.sim');
const phoneSymbol = Symbol.for('dsh.go.ohos.phone');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const brief = (value, max = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const head = (nodes, count = 4) => nodes.filter((node) => node.label).slice(0, count).map((node) => brief(node.label, 24)).join(' / ');

export function apply(ctx) {
  if (process.platform !== 'openharmony' && globalThis[simulationSymbol] !== true) return;
  if (Object.hasOwn(globalThis, phoneSymbol)) throw new Error('One phone callback owner is allowed per engine');
  const queue = new PhoneQueue(createNativePhonePort(ctx.ohosLifecycle.bootId));
  let removeTools, removeUi, removeSession;
  try { removeTools = registerPhoneTools(ctx, queue); removeUi = registerUiTools(ctx); removeSession = registerSessionTools(ctx); }
  catch (error) { removeSession?.(); removeUi?.(); removeTools?.(); queue.close(); throw error; }
  // A disposed bridge stays closed. Reloading a plugin must never replay an old call.
  Object.defineProperty(globalThis, phoneSymbol, { value: queue, configurable: false, writable: false });
  ctx.effect(() => () => { queue.close(); removeTools(); removeUi(); removeSession(); }, 'ohos phone shutdown');
  // 启动自检：验证 app 内部能否经 hdc 通道拿到 shell uid 并驱动 uitest（结果写入 engine.log，便于 PC 侧排查）。
  if (process.env.DSH_GO_PHONE_PROBE !== '0') {
    Promise.resolve().then(async () => {
      const t0 = Date.now();
      try {
        const r = await shText('id 2>&1', 60000);
        console.error('[phone-hdc] probe ok ' + (Date.now() - t0) + 'ms rc=' + r.code + ' out=' + brief(r.text, 200));
        // 通道确实可用：把「已授权」写进状态文件，ArkTS 侧「系统操作」页据此显示已授权。
        authorizedStatus();
      } catch (error) {
        console.error('[phone-hdc] probe failed ' + (Date.now() - t0) + 'ms: ' + ((error && error.message) || error));
        // 第一次使用要用户动手：把该做的几步写进 engine.log（本机引擎页的实时日志里能直接看到）。
        try {
          const report = await diagnoseHdc();
          for (const hint of report.hints) console.error('[phone-hdc] 下一步：' + hint);
          // 同一次诊断落盘：ArkTS 侧「系统操作」页据此显示未授权 + 下一步。
          await probeAndWrite('boot');
        } catch (inner) { console.error('[phone-hdc] diagnose failed: ' + ((inner && inner.message) || inner)); }
        return;
      }
      // 界面树自检：dump 当前屏幕，证明 uitest dumpLayout + 二进制回传在本进程内可用。
      try {
        const t1 = Date.now();
        const snap = await dumpUi(30000);
        console.error('[phone-probe] dump ok ' + (Date.now() - t1) + 'ms screen=' +
          (snap.screen ? (snap.screen.x2 - snap.screen.x1) + 'x' + (snap.screen.y2 - snap.screen.y1) : '?') +
          ' nodes=' + snap.nodes.length + ' top=' + brief(head(snap.nodes), 160));
      } catch (error) {
        console.error('[phone-probe] dump failed: ' + ((error && error.message) || error));
      }
      // 第三方 App 操作自检：拉起系统「设置」→ dump → 点一行 → 再 dump 校验界面变化。
      if (process.env.DSH_GO_PHONE_PROBE_XAPP === '1') {
        try {
          const t2 = Date.now();
          const info = await shText("bm dump -n 'com.huawei.hmos.settings' 2>&1", 40000);
          const ability = (/"mainElementName"\s*:\s*"([^"]+)"/.exec(info.text) || [])[1] || 'EntryAbility';
          const launched = await shText("aa start -b 'com.huawei.hmos.settings' -a '" + ability + "' 2>&1", 60000);
          console.error('[phone-probe] xapp ability=' + ability + ' rc=' + launched.code + ' out=' + brief(launched.text, 80));
          await wait(3000);
          const before = await dumpUi(30000);
          console.error('[phone-probe] xapp dump1 nodes=' + before.nodes.length + ' top=' + brief(head(before.nodes, 6), 200));
          const target = before.nodes.find((node) => node.clickable && node.bounds && node.label && node.label.length <= 12 && !/^(返回|更多|搜索|取消|设置|完成)$/.test(node.label));
          if (target) {
            const clicked = await shText('uitest uiInput click ' + target.bounds.cx + ' ' + target.bounds.cy, 30000);
            await wait(2500);
            const after = await dumpUi(30000);
            console.error('[phone-probe] xapp click(' + brief(target.label, 16) + '@' + target.bounds.cx + ',' + target.bounds.cy + ') rc=' + clicked.code +
              ' nodes=' + after.nodes.length + ' top=' + brief(head(after.nodes, 6), 200) + ' cost=' + (Date.now() - t2) + 'ms');
          } else {
            console.error('[phone-probe] xapp no clickable target');
          }
          await shText('uitest uiInput keyEvent Back 2>&1', 30000);
          await wait(800);
          await shText('aa start -b io.github.ccch1mneyyy.dsh_app -a EntryAbility 2>&1', 30000);
          console.error('[phone-probe] xapp done');
        } catch (error) {
          console.error('[phone-probe] xapp failed: ' + ((error && error.message) || error));
        }
      }
    });
  }
  // 后台进度导出：把思考/工具调用压成一行写进固定文件，供 ArkTS 侧弹幕展示。
  let stopFeed = null;
  try { stopFeed = startProgressFeed(ctx); } catch (error) { console.error('[progress-feed] start failed: ' + ((error && error.message) || error)); }
  ctx.effect(() => () => { if (typeof stopFeed === 'function') stopFeed(); }, 'ohos progress feed shutdown');
  // 「重新检测」：页面写请求文件，这里轮询到就再诊断一次并更新状态文件。
  try { startHdcStatusWatch(ctx); } catch (error) { console.error('[phone-hdc] status watch failed: ' + ((error && error.message) || error)); }
  ctx.inject(['webServer'], webCtx => registerPhoneRoutes(webCtx, queue));
}
