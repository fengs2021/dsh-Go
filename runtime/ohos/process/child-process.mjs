import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// This product preload is an OHOS compatibility boundary, not an OS sandbox.
// Worker threads and the virtual runtime do not create OS child processes.
if (process.platform === 'openharmony') {
  // The engine runs on an embedded libnode inside the application process, so
  // process.execPath reports the app's own executable and its basename is not
  // "node". Launcher plugins that need a Node runtime for a helper process read
  // process.execPath, require basename === "node" and spawn it (billion-context
  // compression proxy: "cannot find a Node runtime to spawn the proxy"). Report
  // the virtual path the command router maps back into this process, so that
  // spawn becomes an in-app Node child instead of a hard failure. The path is
  // never executed by the OS: child_process is unavailable here, and the router
  // recognises this exact name.
  const virtualNode = '/dsh-go/ohos/bin/node';
  try {
    if (process.execPath !== virtualNode) process.execPath = virtualNode;
    if (process.argv[0] !== virtualNode) process.argv[0] = virtualNode;
  } catch {}
  const unavailable = () => {
    throw Object.assign(new Error('[ERR_OHOS_NO_SPAWN] OS child processes are unavailable on OpenHarmony; use the virtual runtime or a remote service.'),
      { code: 'ERR_OHOS_NO_SPAWN' });
  };
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    childProcess[name] = unavailable;
  }
  childProcess.ChildProcess.prototype.spawn = unavailable;
  syncBuiltinESMExports();
}
