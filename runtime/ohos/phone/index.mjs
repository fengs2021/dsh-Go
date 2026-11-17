import { PhoneQueue } from './queue.mjs';
import { createNativePhonePort } from './native-port.mjs';
import { registerPhoneRoutes } from './routes.mjs';
import { registerPhoneTools } from './tools.mjs';
// 手机界面自动化：纯 JS 直连手机无线调试口说 HDC 协议，不打包 hdc 二进制。
// 设计与取舍见 issue ccch1mneyyy/dsh-Go#1459；协议层在 hdc-link.mjs，工具面在 ui-tools.mjs。
import { registerUiTools, shText, dumpUi } from './ui-tools.mjs';
import { diagnoseHdc } from './hdc-link.mjs';
import { authorizedStatus, probeAndWrite, startHdcStatusWatch } from './hdc-status.mjs';

export const name = 'dsh-go-ohos-phone';
export const inject = ['tools', 'ohosLifecycle', 'approval'];
const simulationSymbol = Symbol.for('dsh.go.ohos.sim');
const phoneSymbol = Symbol.for('dsh.go.ohos.phone');
const brief = (value, max = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const head = (nodes, count = 4) => nodes.filter((node) => node.label).slice(0, count).map((node) => brief(node.label, 24)).join(' / ');

export function apply(ctx) {
  if (process.platform !== 'openharmony' && globalThis[simulationSymbol] !== true) return;
  if (Object.hasOwn(globalThis, phoneSymbol)) throw new Error('One phone callback owner is allowed per engine');
  const queue = new PhoneQueue(createNativePhonePort(ctx.ohosLifecycle.bootId));
  let removeTools;
  try { removeTools = registerPhoneTools(ctx, queue); }
  catch (error) { queue.close(); throw error; }
  // 界面自动化单独注册：调试通道起不来（没开无线调试、没授权）不该把手机桥一起带走，
  // 所以这里不抛，只留一行日志——engine.log 里搜 [phone] register failed 就能看到原因。
  const removeUiTools = (() => {
    try { return registerUiTools(ctx); }
    catch (error) {
      console.error('[phone] register failed mcp__phone__*: ' + ((error && error.message) || error));
      return () => {};
    }
  })();
  // A disposed bridge stays closed. Reloading a plugin must never replay an old call.
  Object.defineProperty(globalThis, phoneSymbol, { value: queue, configurable: false, writable: false });
  ctx.effect(() => () => { queue.close(); removeTools(); removeUiTools(); }, 'ohos phone shutdown');
  // 启动自检：验证能否经 HDC 通道拿到 shell uid 并驱动 uitest，结论同时写 engine.log（PC 侧可读）与
  // dsh-app/hdc-status.json（App「系统操作」页据此显示已授权 / 未授权 + 下一步）。DSH_GO_PHONE_PROBE=0 可关。
  if (process.env.DSH_GO_PHONE_PROBE !== '0') {
    Promise.resolve().then(async () => {
      const t0 = Date.now();
      try {
        const r = await shText('id 2>&1', 60000);
        console.error('[phone-hdc] probe ok ' + (Date.now() - t0) + 'ms rc=' + r.code + ' out=' + brief(r.text, 200));
        authorizedStatus();
      } catch (error) {
        console.error('[phone-hdc] probe failed ' + (Date.now() - t0) + 'ms: ' + ((error && error.message) || error));
        try {
          const report = await diagnoseHdc();
          for (const hint of report.hints) console.error('[phone-hdc] 下一步：' + hint);
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
    });
  }
  // 「重新检测」：App 页写 dsh-app/hdc-probe.json 的请求序号，这里轮询到就再诊断一次并更新状态文件。
  try { startHdcStatusWatch(ctx); }
  catch (error) { console.error('[phone-hdc] status watch failed: ' + ((error && error.message) || error)); }
  ctx.inject(['webServer'], webCtx => registerPhoneRoutes(webCtx, queue));
}
