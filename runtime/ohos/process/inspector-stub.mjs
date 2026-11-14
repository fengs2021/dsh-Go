// 手机上的 libnode 是 ./configure --without-inspector 编出来的（见 runtime/ohos/node/build-node.py），
// node:inspector 的模块壳子还在、底层 agent 不在：任何取用都会抛
// ERR_INSPECTOR_NOT_AVAILABLE。第三方插件常常只是在模块顶层 import 它来判断
// “是否跑在调试器下”（dshmarket 的 lib/restart.js:17、@deepseek-ai/dsh-experimental-inspector），
// 一抛错整个插件连加载都过不去，安装也会跟着回滚。
//
// 这个文件就是那个空实现：url() 恒为 undefined（= 没开调试器），open/close/waitForDebugger
// 空转，Session.post 只回一个错误。真需要调试器的插件在本机本来也用不了，
// 所以替换不会削弱任何已经能用的能力。
class Session {
  connect() {}
  disconnect() {}
  post(method, params, callback) {
    const reply = typeof params === 'function' ? params : callback;
    if (typeof reply === 'function') {
      queueMicrotask(() => reply(new Error('inspector is not available on this device: ' + String(method))));
    }
  }
  on() { return this; }
  once() { return this; }
  off() { return this; }
}
const noop = () => undefined;
export const url = () => undefined;
export const open = noop;
export const close = noop;
export const waitForDebugger = noop;
export { Session };
export const console = { log: noop, info: noop, warn: noop, error: noop, debug: noop, dir: noop, table: noop, trace: noop };
export default Object.freeze({ __dshInspectorStub: true, url, open, close, waitForDebugger, Session, console });
