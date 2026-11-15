// The App surface shows a bare ERR_OHOS_LINUX_* code and the private guest's
// sandbox is unreadable from `hdc shell`, so every failure is also written once
// to stderr: Node's stderr reaches hilog under the App's DSHNode tag, which is
// the only channel left for diagnosing a refused boot on a real device.
const LIMIT = 700;
const text = value => typeof value === 'string' ? value : value === undefined ? '' : String(value);
export function describeLinuxFailure(cause) {
  const seen = new Set(), parts = [];
  let error = cause;
  while (error && typeof error === 'object' && parts.length < 6 && !seen.has(error)) {
    seen.add(error);
    const code = /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code ?? '') ? error.code : '';
    const message = text(error.message).replace(/\s+/g, ' ').slice(0, 240);
    parts.push((code ? code + ': ' : '') + message);
    error = error.cause;
  }
  return parts.join(' <- ').slice(0, LIMIT);
}
export function noteLinux(stage, cause) {
  try { console.error('[linux] ' + stage + (cause === undefined ? '' : ' ' + describeLinuxFailure(cause))); } catch { /* logging never fails a boot */ }
}
