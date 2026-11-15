import { constants, createReadStream } from 'node:fs';
import * as promises from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

const fail = (code, message, cause) => Object.assign(new Error(message, { cause }), { code });
const identity = info => ({ dev: String(info.dev), ino: String(info.ino) });
const same = (a, b) => String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const inode = value => value && Object.keys(value).length === 2 && decimal(value.dev) && decimal(value.ino);
const privateFile = info => info.isFile() && info.nlink === 1n && (info.mode & 0o077n) === 0n;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function cleanGuestClose(value, epoch) {
  return exact(value, ['epoch', 'rootfsSync', 'syncMethod', 'syncScope']) && value.epoch === epoch &&
    value.rootfsSync === true && value.syncMethod === 'syncfs' && value.syncScope === 'rootfs';
}
const cleanNative = value => value?.joined === true && value.retirementError === false && [-3, -4].includes(value.apiResult);

function assetIdentity(manifest) {
  const roles = {};
  for (const key of ['bios', 'kernel', 'tools', 'bootstrap', 'empty', 'archive']) {
    const item = manifest[key];
    if (!item || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !hex(item.sha256)) throw new TypeError('Pinned Linux asset identity is required');
    roles[key] = { bytes: item.bytes, sha256: item.sha256 };
    if (key === 'bootstrap' || key === 'empty') {
      if (!Number.isSafeInteger(item.expandedBytes) || item.expandedBytes <= 0 || !hex(item.expandedSha256)) throw new TypeError('Pinned expanded Linux image identity is required');
      Object.assign(roles[key], { expandedBytes: item.expandedBytes, expandedSha256: item.expandedSha256 });
    }
  }
  return createHash('sha256').update(JSON.stringify(roles)).digest('hex');
}

function decode(text, expected) {
  let value;
  try { value = JSON.parse(text); }
  catch (cause) { throw fail('ERR_OHOS_LINUX_INSTANCE_CORRUPT', 'Linux instance record is not valid JSON', cause); }
  if (!exact(value, ['version', 'persistentInstanceId', 'state', 'epoch', 'assetIdentity', 'root', 'instance', 'target', 'guestClose', 'native']) ||
      value.version !== 2 || typeof value.persistentInstanceId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.persistentInstanceId) ||
      !['preparing', 'booting', 'active', 'clean'].includes(value.state) || !hex(value.epoch) || !hex(value.assetIdentity) ||
      !inode(value.root) || !inode(value.instance) || text !== JSON.stringify(value) + '\n') {
    throw fail('ERR_OHOS_LINUX_INSTANCE_CORRUPT', 'Unsupported or ambiguous Linux instance record');
  }
  if (value.state !== 'clean') throw fail('ERR_OHOS_LINUX_RECOVERY_REQUIRED', 'The retained Linux instance has no confirmed clean close; automatic overwrite is forbidden');
  if (value.assetIdentity !== expected) throw fail('ERR_OHOS_LINUX_ASSET_GENERATION', 'Retained Linux instance belongs to a different asset generation');
  if (!exact(value.target, ['name', 'bytes', 'dev', 'ino']) || value.target.name !== 'target.ext4' ||
      !Number.isSafeInteger(value.target.bytes) || value.target.bytes <= 0 || !decimal(value.target.dev) || !decimal(value.target.ino) ||
      !cleanGuestClose(value.guestClose, value.epoch) || !exact(value.native, ['joined', 'retirementError', 'apiResult']) || !cleanNative(value.native)) {
    throw fail('ERR_OHOS_LINUX_INSTANCE_CORRUPT', 'Linux clean record lacks exact disk or close identity');
  }
  return value;
}

/**
 * Move every retained entry aside instead of overwriting it.
 *
 * A replaced App process can leave a writable instance recorded as active or
 * booting: the flock proves no live owner, but the record still forbids an
 * automatic overwrite. Quarantining keeps the user's bytes on disk for manual
 * recovery while letting the environment be provisioned again.
 */
export async function quarantineRetained(directory, { fs = promises } = {}) {
  const kept = name => name === '.lock' || name.startsWith('.quarantine-');
  const names = (await fs.readdir(directory)).filter(name => !kept(name));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const moved = [];
  for (const name of names) {
    const target = '.quarantine-' + stamp + '-' + name.replace(/^\./, '');
    await fs.rename(join(directory, name), join(directory, target));
    moved.push(target);
  }
  return moved;
}

// All paths are fixed below the host-captured private root. The real native
// flock is held until retirement AND metadata handling finish; its inode is
// never replaced. fs is injectable only for precise persistence fault tests.
export async function openLinuxInstance({ directory, manifest, lockExclusive }, { fs = promises } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory === '/' || directory.includes('\0') || resolve(directory) !== directory) throw new TypeError('A canonical private Linux root is required');
  if (typeof lockExclusive !== 'function') throw fail('ERR_OHOS_LINUX_LOCK_UNAVAILABLE', 'The trusted native Linux installation lock is unavailable');
  const expected = assetIdentity(manifest);
  let root, lock, instance, target, rootInfo, lockInfo, instanceInfo, targetInfo, record, path, existing = false;
  const lockPath = join(directory, '.lock');
  const handles = () => [target, instance, root, lock].filter(Boolean);
  async function directoryIdentity(name, handle, saved) {
    const [named, held, canonical] = await Promise.all([fs.lstat(name, { bigint: true }), handle.stat({ bigint: true }), fs.realpath(name)]);
    if (!named.isDirectory() || !held.isDirectory() || canonical !== name || !same(named, held) || (saved && !same(held, saved))) throw fail('ERR_OHOS_LINUX_DIRECTORY_IDENTITY', 'Linux private directory identity changed');
    return held;
  }
  async function verify() {
    await directoryIdentity(directory, root, rootInfo);
    const namedLock = await fs.lstat(lockPath, { bigint: true });
    if (!privateFile(namedLock) || !same(namedLock, lockInfo) || !same(await lock.stat({ bigint: true }), lockInfo)) throw fail('ERR_OHOS_LINUX_LOCK_IDENTITY', 'Linux lock inode changed');
    await directoryIdentity(path, instance, instanceInfo);
    if (target) {
      const named = await fs.lstat(join(path, 'target.ext4'), { bigint: true }), held = await target.stat({ bigint: true });
      if (!privateFile(named) || !privateFile(held) || !same(named, targetInfo) || !same(held, targetInfo) || held.size !== BigInt(manifest.empty.expandedBytes)) throw fail('ERR_OHOS_LINUX_TARGET_IDENTITY', 'Retained Linux target identity or size changed');
    }
  }
  async function bindTarget() {
    const name = join(path, 'target.ext4');
    target = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
    targetInfo = await target.stat({ bigint: true });
    if (!privateFile(targetInfo) || targetInfo.size !== BigInt(manifest.empty.expandedBytes) ||
        (record.target && (!same(record.target, targetInfo) || record.target.bytes !== manifest.empty.expandedBytes))) throw fail('ERR_OHOS_LINUX_TARGET_IDENTITY', 'Linux target must be the original private ordinary disk file');
    await verify();
    return { name: 'target.ext4', bytes: Number(targetInfo.size), ...identity(targetInfo) };
  }
  async function write(name, value) {
    await verify();
    const pending = join(path, name + '.pending');
    const file = await fs.open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await fs.rename(pending, join(path, name));
    // A failure here does NOT undo rename. The caller reports an unconfirmed
    // checkpoint; the next process validates the current visible record only.
    await instance.sync();
  }
  async function persist(next) { await write('instance.json', next); record = next; }
  try {
    await fs.mkdir(directory, { mode: 0o700 }).catch(cause => { if (cause.code !== 'EEXIST') throw cause; });
    root = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    rootInfo = await directoryIdentity(directory, root);
    await root.chmod(0o700);
    lock = await fs.open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    lockInfo = await lock.stat({ bigint: true });
    if (!privateFile(lockInfo)) throw fail('ERR_OHOS_LINUX_LOCK_IDENTITY', 'Linux lock must be a private single-link ordinary file');
    try { if (lockExclusive(lock.fd) !== undefined) throw new TypeError('lockExclusive must return undefined synchronously'); }
    catch (cause) {
      if (['EAGAIN', 'EWOULDBLOCK'].includes(cause.code)) throw fail('ERR_OHOS_LINUX_BUSY', 'Another live owner holds this Linux environment', cause);
      throw cause;
    }
    const namedLock = await fs.lstat(lockPath, { bigint: true });
    if (!privateFile(namedLock) || !same(namedLock, lockInfo)) throw fail('ERR_OHOS_LINUX_LOCK_IDENTITY', 'Linux lock path changed during acquisition');
    const names = (await fs.readdir(directory)).filter(name => name !== '.lock' && !name.startsWith('.quarantine-'));
    if (names.length) {
      existing = true;
      if (names.length !== 1 || !/^\.installation-[A-Za-z0-9_-]+$/.test(names[0])) throw fail('ERR_OHOS_LINUX_RETAINED_INSTANCE', 'Ambiguous retained Linux data requires explicit recovery');
      path = join(directory, names[0]);
    } else path = await fs.mkdtemp(join(directory, '.installation-'));
    instance = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    instanceInfo = await directoryIdentity(path, instance);
    if ((instanceInfo.mode & 0o077n) !== 0n) throw fail('ERR_OHOS_LINUX_DIRECTORY_IDENTITY', 'Linux instance directory is not private');
    if (existing) {
      let file;
      try {
        file = await fs.open(join(path, 'instance.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await file.stat({ bigint: true });
        if (!privateFile(info) || info.size > 8192n) throw fail('ERR_OHOS_LINUX_INSTANCE_CORRUPT', 'Linux record is not a bounded private file');
        record = decode(await file.readFile('utf8'), expected);
      } catch (cause) {
        if (cause.code === 'ENOENT') throw fail('ERR_OHOS_LINUX_RETAINED_INSTANCE', 'An older or incomplete Linux instance cannot be promoted to clean', cause);
        throw cause;
      } finally { if (file) await file.close(); }
      if (!same(record.root, rootInfo) || !same(record.instance, instanceInfo)) throw fail('ERR_OHOS_LINUX_DIRECTORY_IDENTITY', 'Retained Linux directory identity changed');
      await bindTarget();
      // Mutable target bytes have no template checksum. Immutable boot copies
      // do, and are verified anew before a resumed VM opens any disk.
      for (const key of ['bios', 'kernel', 'tools']) {
        const file = await fs.open(join(path, key + '.bin'), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await file.stat({ bigint: true });
          if (!privateFile(info) || info.size !== BigInt(manifest[key].bytes)) throw fail('ERR_OHOS_LINUX_IMAGE_INTEGRITY', 'Retained boot asset identity changed');
          const hash = createHash('sha256');
          for await (const bytes of createReadStream('', { fd: file.fd, autoClose: false })) hash.update(bytes);
          if (hash.digest('hex') !== manifest[key].sha256) throw fail('ERR_OHOS_LINUX_IMAGE_INTEGRITY', 'Retained boot asset checksum changed');
        } finally { await file.close(); }
      }
    } else {
      record = { version: 2, persistentInstanceId: randomUUID(), state: 'preparing', epoch: randomBytes(32).toString('hex'), assetIdentity: expected,
        root: identity(rootInfo), instance: identity(instanceInfo), target: null, guestClose: null, native: null };
      await persist(record); await root.sync();
    }
  } catch (cause) {
    cause.linuxDataRetained = existing;
    if (!existing && path) {
      try { await fs.rm(path, { recursive: true, force: true }); await root.sync(); }
      catch (cleanup) { cause.linuxDataRetained = true; cause.linuxCleanupError = cleanup; }
    }
    for (const handle of handles()) await handle.close().catch(closeError => { cause.linuxCloseError ??= closeError; });
    throw cause;
  }
  return Object.freeze({
    directory: path, existing,
    persistentInstanceId: record.persistentInstanceId,
    epoch: existing ? randomBytes(32).toString('hex') : record.epoch,
    target: join(path, 'target.ext4'),
    verify,
    async prepared(source) {
      if (existing) throw new TypeError('A retained target cannot be prepared again');
      await verify(); await fs.rename(source, join(path, 'target.ext4'));
      record = { ...record, target: await bindTarget() };
    },
    async config(name, value) {
      if (!['guest.cfg', 'resume.cfg'].includes(name)) throw new TypeError('Fixed Linux config name required');
      await write(name, value); return join(path, name);
    },
    async booting(epoch) {
      if (!hex(epoch) || (existing && epoch === record.epoch) || !target) throw new TypeError('A fresh epoch and verified target are required');
      await persist({ ...record, state: 'booting', epoch, guestClose: null, native: null });
    },
    async active() { await persist({ ...record, state: 'active' }); },
    async clean(result) {
      if (record.state !== 'active' || result?.closed !== true || !cleanGuestClose(result.guestClose, record.epoch) || !cleanNative(result.native)) throw fail('ERR_OHOS_LINUX_CLEAN_UNCONFIRMED', 'Only this lifetime\'s fulfilled guest close and native retirement can authorize a checkpoint');
      await persist({ ...record, state: 'clean', guestClose: { ...result.guestClose }, native: { joined: true, retirementError: false, apiResult: result.native.apiResult } });
    },
    async removeUnpublished() {
      if (existing) throw new TypeError('Retained Linux data cannot be removed');
      await verify(); await fs.rm(path, { recursive: true, force: true }); await root.sync();
    },
    async release() {
      // Closing this descriptor releases flock. Call only once native resources
      // are confirmed retired; process death still relies on durable dirty state.
      const failures = [];
      for (const handle of handles()) try { await handle.close(); } catch (cause) { failures.push(cause); }
      if (failures.length) throw new AggregateError(failures, 'Linux instance descriptor release failed');
    },
  });
}
