import { readFileSync, renameSync, writeFileSync } from 'node:fs';

// This runtime's Node runs a --jitless V8, which has no WebAssembly at all, and Undici
// builds its HTTP/1.1 parser as WebAssembly. A plugin that bundles its own Undici never
// sees the node:http dispatcher published on the thread globals, so every upstream
// request dies with "fetch failed <- WebAssembly is not defined". Rewriting the one
// place such a bundle chooses its transport keeps the traffic on node:http.
const marker = '/* dsh-ohos:transport */';
const bundles = [{
  suffix: '/billion-context/dist/index.js',
  from: 'agent=new import_undici.Agent({headersTimeout:timeoutMs,bodyTimeout:timeoutMs,...ca?{connect:{ca}}:{}})',
  to: "agent=globalThis[Symbol.for('dsh.go.ohos.net')]?.dispatcher??(new import_undici.Agent({headersTimeout:timeoutMs,bodyTimeout:timeoutMs,...ca?{connect:{ca}}:{}}))" + marker,
}];
const seen = new Set();

/** Rewrites a known bundled transport to prefer the published dispatcher. Returns 'patched', 'cached', 'skipped' or undefined. */
export function patchBundledTransport(filename, { log = message => console.error(message) } = {}) {
  const bundle = bundles.find(candidate => filename.endsWith(candidate.suffix));
  if (!bundle) return;
  if (seen.has(filename)) return 'cached';
  seen.add(filename);
  let source;
  try { source = readFileSync(filename, 'utf8'); }
  catch (error) { log(`[ohos-vendor] cannot read ${filename}: ${error.message}`); return 'skipped'; }
  if (source.includes(marker)) return 'cached';
  if (!source.includes(bundle.from)) { log(`[ohos-vendor] no transport anchor in ${filename}`); return 'skipped'; }
  const staged = `${filename}.dsh-vendor`;
  try {
    writeFileSync(staged, source.replace(bundle.from, bundle.to));
    renameSync(staged, filename);
  } catch (error) { log(`[ohos-vendor] cannot patch ${filename}: ${error.message}`); return 'skipped'; }
  log(`[ohos-vendor] routed ${filename} through the node:http dispatcher`);
  return 'patched';
}
