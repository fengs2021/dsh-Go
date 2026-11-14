/**
 * Remote package sources that need no git binary: a GitHub repository archive
 * and a plain tarball URL.
 *
 * The OHOS app sandbox ships no `git`, so `pnpm add github:owner/repo` cannot
 * clone. GitHub renders the same tree as a codeload archive, which is fetched
 * over HTTPS and unpacked by the registry tarball reader, so a repository spec
 * installs like any other package.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { getBuffer } from './registry.mjs';

/** `github:owner/repo#ref`: the host shorthand pnpm accepts. */
const SHORTHAND = /^(?:github|git):(?!\/\/)/i;

/** `owner/repo#ref`: the shorthand without its host. */
const BARE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[^\s]*)?$/;

/** `https://github.com/owner/repo[.git][#ref]`, with or without a `git+` prefix. */
const HOSTED_REPOSITORY = /^(?:git\+)?https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[#?]([^\s]*))?$/i;

/** Anything that names an archive rather than a repository. */
const ARCHIVE = /\.(?:tgz|tar\.gz|tar)(?:[#?].*)?$/i;

/** Where a repository is rendered as an archive. */
const CODELOAD = 'https://codeload.github.com/';

/** The ref a repository spec uses when it names none. */
const DEFAULT_REF = 'HEAD';

/** The name an archive URL suggests when its manifest declares none. */
function archiveName(spec) {
    const text = spec.replace(/[#?][\s\S]*$/, '');
    const base = text.slice(text.lastIndexOf('/') + 1);
    return base.replace(/\.(?:tgz|tar\.gz|tar)$/i, '') || 'package';
}

/** One GitHub repository spec, as its archive URL and its recorded dependency value. */
function repository(spec, owner, repo, ref) {
    const name = repo.replace(/\.git$/i, '');
    if (owner.length === 0 || name.length === 0) return null;
    return {
        kind: 'github',
        spec,
        url: `${CODELOAD}${owner}/${name}/tar.gz/${ref.length === 0 ? DEFAULT_REF : ref}`,
        name,
        ref,
        saved: `github:${owner}/${name}${ref.length === 0 ? '' : `#${ref}`}`,
    };
}

/**
 * Read a spec that a package manager resolves without a registry.
 * @param raw The spec as typed.
 * @returns Its archive URL, package name and recorded form, or null for a registry spec.
 */
export function parseRemoteSpec(raw) {
    const spec = String(raw ?? '').trim();
    if (spec.length === 0) return null;
    const hosted = HOSTED_REPOSITORY.exec(spec);
    if (hosted !== null) return repository(spec, hosted[1], hosted[2], hosted[3] ?? '');
    if (/^https?:\/\//i.test(spec) || /^git\+/i.test(spec)) {
        if (!ARCHIVE.test(spec)) return null;
        const url = spec.replace(/^git\+/i, '').replace(/#[\s\S]*$/, '');
        return { kind: 'archive', spec, url, name: archiveName(spec), ref: '', saved: spec };
    }
    if (SHORTHAND.test(spec) || BARE_REPOSITORY.test(spec) && !spec.startsWith('@')) {
        const rest = spec.replace(SHORTHAND, '');
        const hash = rest.indexOf('#');
        const path = hash === -1 ? rest : rest.slice(0, hash);
        const ref = hash === -1 ? '' : rest.slice(hash + 1);
        const segments = path.split('/');
        if (segments.length !== 2) return null;
        return repository(spec, segments[0], segments[1], ref);
    }
    return null;
}

/**
 * Download one repository archive or tarball.
 * @param url The archive URL.
 * @param options Cancellation, deadline and byte cap.
 * @returns The archive bytes.
 */
export async function fetchArchive(url, options = {}) {
    const answer = await getBuffer(url, {
        headers: { accept: '*/*' },
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 120000,
        maxBytes: options.maxBytes ?? 128 * 1024 * 1024,
    });
    return answer.body;
}

/**
 * Find the package inside an unpacked archive: archives wrap their tree in one
 * top-level directory whose name is the repository and ref.
 * @param directory The unpacked root.
 * @param depth How many wrappers were already opened.
 * @returns The directory holding `package.json`, or null.
 */
export async function archivePackageRoot(directory, depth = 0) {
    const present = await stat(join(directory, 'package.json')).then(() => true, () => false);
    if (present) return directory;
    if (depth >= 3) return null;
    const entries = (await readdir(directory, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory());
    if (entries.length !== 1) return null;
    return await archivePackageRoot(join(directory, entries[0].name), depth + 1);
}
