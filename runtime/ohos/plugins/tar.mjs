// Dependency-free npm tarball extraction: gzip inflate plus a ustar/pax reader.
// Only the entries an npm package contains are honoured; anything that would
// escape the target directory is refused instead of sanitised silently.
import { gunzipSync } from 'node:zlib';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

const BLOCK = 512;

const cString = (block, offset, length) => {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8');
};

const octal = (block, offset, length) => {
  const text = cString(block, offset, length).trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  return Number.isNaN(value) ? 0 : value;
};

function paxRecords(buffer) {
  const records = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(buffer.subarray(offset, space).toString('utf8'), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > buffer.length) break;
    const record = buffer.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

function safeRelative(path) {
  const normalized = posix.normalize(path.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '') return null;
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

/**
 * Extract every entry of a gzipped tar into the target directory.
 * @param buffer The .tgz bytes as downloaded from a registry.
 * @param options.target Absolute destination directory.
 * @param options.strip Leading path segments to drop; npm tarballs put entries under "package/".
 * @returns How many entries were written.
 */
export async function extractTarball(buffer, options) {
  const target = options.target;
  const strip = options.strip ?? 1;
  const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const archive = isGzip ? gunzipSync(buffer) : buffer;
  let offset = 0;
  let written = 0;
  let pendingName;
  let pendingLink;
  let pendingPax = new Map();
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const type = String.fromCharCode(header[156] === 0 ? 48 : header[156]);
    const data = archive.subarray(offset, offset + size);
    offset += padded;
    if (type === 'x' || type === 'g') {
      for (const [key, value] of paxRecords(data)) pendingPax.set(key, value);
      if (type === 'x') continue;
      continue;
    }
    if (type === 'L') { pendingName = cString(data, 0, data.length); continue; }
    if (type === 'K') { pendingLink = cString(data, 0, data.length); continue; }
    const prefix = cString(header, 0, 6) === 'ustar' ? cString(header, 345, 155) : '';
    let name = pendingName ?? (prefix === '' ? cString(header, 0, 100) : prefix + '/' + cString(header, 0, 100));
    let link = pendingLink ?? cString(header, 157, 100);
    if (pendingPax.has('path')) name = pendingPax.get('path');
    if (pendingPax.has('linkpath')) link = pendingPax.get('linkpath');
    pendingName = undefined;
    pendingLink = undefined;
    pendingPax = new Map();
    const segments = name.replace(/\\/g, '/').split('/').filter((segment) => segment !== '');
    const relative = safeRelative(segments.slice(strip).join('/'));
    if (relative === null) continue;
    const destination = join(target, relative);
    if (type === '5') {
      await mkdir(destination, { recursive: true, mode: 0o755 });
      written += 1;
      continue;
    }
    if (type === '2') {
      const relativeLink = safeRelative(link);
      if (relativeLink === null) continue;
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      const created = await symlink(relativeLink, destination).then(() => true, () => false);
      // An app sandbox refuses symlinks; a copy of the target keeps the entry usable.
      if (!created) {
        const copied = await readFile(join(dirname(destination), relativeLink)).catch(() => undefined);
        if (copied === undefined) continue;
        await writeFile(destination, copied, { mode: 0o755 });
      }
      written += 1;
      continue;
    }
    if (type === '1') {
      // A hard link carries no payload: copy the file it names, which the archive also lists.
      const relativeLink = safeRelative(link);
      const copied = relativeLink === null ? undefined : await readFile(join(target, relativeLink)).catch(() => undefined);
      if (copied === undefined) continue;
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await writeFile(destination, copied, { mode: 0o644 });
      written += 1;
      continue;
    }
    if (type !== '0' && type !== '7') continue;
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, data, { mode: (octal(header, 100, 8) & 0o777) || 0o644 });
    written += 1;
  }
  await chmod(target, 0o755).catch(() => undefined);
  return written;
}
