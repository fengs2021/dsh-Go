import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const linux = { skip: process.platform !== 'linux' };
const erofs = 0xe0f5e1e2;
const bytes = Buffer.from([0, 1, 128, 255, 65, 10]);
let loaded;
async function api() {
  if (!loaded) {
    const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
    if (!prefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX to a prepared runtime');
    const root = resolve(prefix);
    const load = name => import(pathToFileURL(join(root, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
    loaded = Promise.all(['cordis', 'dsh-attachment-local', 'dsh-attachment'].map(load)).then(async parts => {
      const sharp = createRequire(join(root, 'package.json'))('sharp');
      const png = await sharp({ create: { width: 2, height: 2, channels: 3,
        background: { r: 100, g: 120, b: 140 } } }).png().toBuffer();
      return { ...Object.assign({}, ...parts), png };
    });
  }
  return loaded;
}

// Exercise the actual store, real private files and real directory handles.
// Only the root directory's sync/FS-type result is replaced, modelling the
// immutable Android EROFS ancestor without requiring a privileged mount.
async function fixture(t, options = {}) {
  const a = await api();
  const home = await fs.mkdtemp(join(tmpdir(), 'dsh-erofs-sync-'));
  const ctx = new a.Context();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    try { await ctx.fiber.dispose(); }
    finally { await fs.rm(home, { recursive: true, force: true }); }
  });
  await ctx.plugin(a.LocalAttachmentStore, { dshHome: home }).await();
  const syncError = Object.assign(new Error('synthetic directory sync failure'), { code: options.code ?? 'EINVAL' });
  const fileError = Object.assign(new Error('synthetic file sync failure'), { code: 'EINVAL' });
  const state = { fail: true, rootOpens: 0, rootCloses: 0, syncs: [], probes: [] };
  const paths = new Map();
  const open = fs.open;
  const statfs = fs.statfs;
  t.mock.method(fs, 'open', async (path, flags, ...args) => {
    const handle = await open(path, flags, ...args);
    const name = String(path);
    const fd = handle.fd;
    paths.set(fd, name);
    const sync = handle.sync.bind(handle);
    t.mock.method(handle, 'sync', async () => {
      state.syncs.push(name);
      if (state.fail && name === '/') throw syncError;
      if (options.fileSyncFailure && name.startsWith(join(home, 'attachments/v1/tmp') + '/')) throw fileError;
      return sync();
    });
    const close = handle.close.bind(handle);
    if (name === '/') state.rootOpens++;
    t.mock.method(handle, 'close', async () => {
      try { return await close(); }
      finally {
        paths.delete(fd);
        if (name === '/') state.rootCloses++;
      }
    });
    return handle;
  });
  t.mock.method(fs, 'statfs', async (path, ...args) => {
    const name = String(path);
    const fd = /^\/proc\/self\/fd\/(\d+)$/.exec(name);
    const target = fd ? paths.get(Number(fd[1])) : name;
    state.probes.push({ path: name, target });
    if (target !== '/') return statfs(path, ...args);
    if (options.probeError) throw options.probeError;
    return { type: options.type ?? erofs };
  });
  syncBuiltinESMExports();
  return { ...a, ctx, home, state, syncError, fileError };
}

async function readExact(store, ref) {
  const chunks = [];
  for await (const chunk of store.readFileStream(ref)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('EROFS root permits binary and streamed admission with exact durable bytes', linux, async t => {
  const { ctx, home, state } = await fixture(t);
  const ref = await ctx.attachments.saveFile({ data: bytes, name: 'own.bin' });
  const stream = await ctx.attachments.saveFileStream({ name: 'stream.bin',
    data: (async function* () { yield bytes.subarray(0, 2); yield bytes.subarray(2); })() });
  assert.deepEqual(await readExact(ctx.attachments, ref), bytes);
  assert.deepEqual(await readExact(ctx.attachments, stream), bytes);
  assert.equal(ref.attachmentId, stream.attachmentId);
  assert.equal((await fs.stat(ctx.attachments.fileHostPath(ref))).mode & 0o777, 0o400);
  assert.deepEqual(await fs.readdir(join(home, 'attachments/v1/tmp')), []);
  assert.ok(state.syncs.includes(home));
  assert.ok(state.syncs.includes(dirname(home)));
  assert.ok(state.syncs.some(path => path.startsWith(join(home, 'attachments/v1/tmp') + '/')));
  assert.equal(state.rootOpens, 1, 'the durable home is established once');
  assert.equal(state.rootCloses, state.rootOpens, 'the failed-sync handle is still closed');
  assert.equal(state.probes.length, 1);
  assert.equal(state.probes[0].target, '/');
});

test('EROFS root permits an actual PNG save and digest-verified read', linux, async t => {
  const { ctx, png, home, state } = await fixture(t);
  const ref = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'own.png' });
  const read = await ctx.attachments.readImage(ref);
  assert.deepEqual(Buffer.from(read.data), png);
  assert.equal(ref.width, 2);
  assert.equal(ref.height, 2);
  assert.equal(ref.bytes, png.byteLength);
  assert.equal((await fs.stat(ctx.attachments.imageHostPath(ref))).mode & 0o777, 0o400);
  assert.deepEqual(await fs.readdir(join(home, 'attachments/v1/tmp')), []);
  assert.equal(state.rootCloses, 1);
});

for (const [name, type] of [['ext4', 0xef53], ['overlayfs', 0x794c7630], ['unknown', 0]]) {
  test(`EINVAL on ${name} remains a write failure and does not cache a durable home`, linux, async t => {
    const { ctx, state, syncError, AttachmentError } = await fixture(t, { type });
    await assert.rejects(ctx.attachments.saveFile({ data: bytes, name: 'own.bin' }),
      error => error instanceof AttachmentError && error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause === syncError);
    assert.equal(state.rootCloses, 1);
    state.fail = false;
    const recovered = await ctx.attachments.saveFile({ data: bytes, name: 'recovered.bin' });
    assert.deepEqual(await readExact(ctx.attachments, recovered), bytes);
    assert.equal(state.rootOpens, 2, 'a failed boundary must be retried');
    assert.equal(state.rootCloses, 2);
  });
}

for (const code of ['EIO', 'EACCES', 'EROFS']) {
  test(`${code} is not reclassified as an unsupported EROFS directory sync`, linux, async t => {
    const { ctx, state, syncError, AttachmentError } = await fixture(t, { code });
    await assert.rejects(ctx.attachments.saveFile({ data: bytes, name: 'own.bin' }),
      error => error instanceof AttachmentError && error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause === syncError);
    assert.equal(state.rootCloses, 1);
    assert.equal(state.probes.length, 0, 'an unrelated error needs no filesystem fallback');
  });
}

test('an unavailable filesystem probe preserves the original sync failure', linux, async t => {
  const { ctx, state, syncError, AttachmentError } = await fixture(t, {
    probeError: Object.assign(new Error('synthetic proc access denied'), { code: 'EACCES' }),
  });
  await assert.rejects(ctx.attachments.saveFile({ data: bytes, name: 'own.bin' }),
    error => error instanceof AttachmentError && error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause === syncError);
  assert.equal(state.rootCloses, 1);
});

test('accepting an EROFS ancestor never suppresses the staged file fsync failure', linux, async t => {
  const { ctx, home, state, fileError, AttachmentError } = await fixture(t, { fileSyncFailure: true });
  await assert.rejects(ctx.attachments.saveFile({ data: bytes, name: 'own.bin' }),
    error => error instanceof AttachmentError && error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause === fileError);
  assert.deepEqual(await fs.readdir(join(home, 'attachments/v1/tmp')), []);
  assert.equal(state.rootCloses, 1);
});

test('Linux statfs through an open directory descriptor reports its filesystem', linux, async () => {
  const handle = await fs.open('/', constants.O_RDONLY);
  try {
    const direct = await fs.statfs('/');
    const throughFd = await fs.statfs(`/proc/self/fd/${handle.fd}`);
    assert.equal(throughFd.type, direct.type);
  } finally {
    await handle.close();
  }
});
