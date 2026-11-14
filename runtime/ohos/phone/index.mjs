import { PhoneQueue } from './queue.mjs';
import { createNativePhonePort } from './native-port.mjs';
import { registerPhoneRoutes } from './routes.mjs';
import { registerPhoneTools } from './tools.mjs';
import { registerUiTools } from './ui-tools.mjs';

export const name = 'dsh-go-ohos-phone';
export const inject = ['tools', 'ohosLifecycle', 'approval'];
const simulationSymbol = Symbol.for('dsh.go.ohos.sim');
const phoneSymbol = Symbol.for('dsh.go.ohos.phone');

export function apply(ctx) {
  if (process.platform !== 'openharmony' && globalThis[simulationSymbol] !== true) return;
  if (Object.hasOwn(globalThis, phoneSymbol)) throw new Error('One phone callback owner is allowed per engine');
  const queue = new PhoneQueue(createNativePhonePort(ctx.ohosLifecycle.bootId));
  let removeTools, removeUiTools;
  try { removeTools = registerPhoneTools(ctx, queue); removeUiTools = registerUiTools(ctx); }
  catch (error) { try { removeTools?.(); } catch { /* 已经失败的注册不再抛第二个错 */ } queue.close(); throw error; }
  // A disposed bridge stays closed. Reloading a plugin must never replay an old call.
  Object.defineProperty(globalThis, phoneSymbol, { value: queue, configurable: false, writable: false });
  ctx.effect(() => () => { queue.close(); removeTools(); removeUiTools(); }, 'ohos phone shutdown');
  ctx.inject(['webServer'], webCtx => registerPhoneRoutes(webCtx, queue));
}
