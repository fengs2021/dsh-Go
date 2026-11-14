/**
 * Resolve and place npm dependencies without a package manager binary.
 *
 * The OHOS build ships no `pnpm`/`npm`, so the plugin manager's `add` path is
 * served by this module: registry packuments, tarball extraction, hoisted flat
 * placement (conflicting versions nest under their parent), integrity checks and
 * the profile manifest write-back that `pnpm add` would otherwise do.
 *
 * Layout follows the profile's `nodeLinker: hoisted` workspace setting, and peer
 * dependencies are not installed, matching `autoInstallPeers: false`.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { maxSatisfying, satisfies } from './semver.mjs';
import { extractTarball } from './tar.mjs';
import { packument, registryFor, tarball } from './registry.mjs';
import { archivePackageRoot, fetchArchive, parseRemoteSpec } from './remote.mjs';

/** Files whose presence marks a directory as an installed package. */
const MANIFEST = 'package.json';

/** Read a JSON file, or undefined when it is absent or unreadable. */
export async function readJson(filename) {
    try {
        return JSON.parse(await readFile(filename, 'utf8'));
    } catch (error) {
        void error;
        return undefined;
    }
}

/** Write a JSON file atomically through a sibling temporary file. */
async function writeJson(filename, value, mode = 0o600) {
    const temporary = `${filename}.tmp-${process.pid}-x`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await rename(temporary, filename);
}

/** A non-empty string, or the fallback. */
function textOr(value, fallback) {
    return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Split `name@range` into a package name and the range it asks for. */
export function splitSpec(spec) {
    const text = spec.trim();
    const at = text.lastIndexOf('@');
    if (at <= 0) return { name: text, range: '' };
    return { name: text.slice(0, at), range: text.slice(at + 1) };
}

/** The range a spec without one asks for: the newest published version. */
const DEFAULT_RANGE = 'latest';

/** A version comparable to what `pnpm add` writes into dependencies. */
export function savedRange(version, saveExact) {
    return saveExact ? version : `^${version}`;
}

/** Where a package is resolvable from for a nested placement. */
function chainDirectories(nodeModulesDir) {
    const chain = [];
    let current = nodeModulesDir;
    for (;;) {
        chain.push(current);
        const parent = dirname(current);
        if (parent === current) return chain;
        current = join(parent, 'node_modules');
        if (chain.length > 16) return chain;
    }
}

/** The installed manifest visible to a package, preferring its nearest node_modules. */
async function installedManifest(nodeModulesDir, name) {
    for (const directory of chainDirectories(nodeModulesDir)) {
        const manifest = await readJson(join(directory, name, MANIFEST));
        if (manifest !== undefined) return { directory: join(directory, name), manifest };
    }
    return undefined;
}

/** Verify a tarball against the registry's published digest. */
export function verifyIntegrity(bytes, dist) {
    const integrity = typeof dist?.integrity === 'string' ? dist.integrity.trim() : '';
    for (const entry of integrity.split(/\s+/).filter((item) => item.length > 0)) {
        const match = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(entry);
        if (match === null) continue;
        const digest = createHash(match[1]).update(bytes).digest('base64');
        if (digest !== match[2]) return `integrity ${match[1]} mismatch`;
        return null;
    }
    const shasum = typeof dist?.shasum === 'string' ? dist.shasum.trim() : '';
    if (shasum.length > 0) {
        const digest = createHash('sha1').update(bytes).digest('hex');
        return digest === shasum ? null : 'integrity sha1 mismatch';
    }
    return null;
}

/** Packages a run placed, in the order they were written. */
export class InstallSession {
    constructor(options) {
        this.profileDir = options.dir;
        this.registry = options.registry;
        // 官方源在国内很慢，镜像排在前面；任何一个源给不出这个包/版本就换下一个。
        this.registries = Array.isArray(options.registries) && options.registries.length > 0
            ? options.registries.slice()
            : [options.registry];
        this.saveExact = options.saveExact === true;
        this.signal = options.signal;
        this.timeoutMs = options.timeoutMs;
        this.onOutput = options.onOutput ?? (() => {});
        this.rootNodeModules = join(options.dir, 'node_modules');
        this.placed = [];
        this.visiting = new Set();
        this.notes = [];
    }

    /** All dependencies the profile manifest currently declares. */
    async dependencies() {
        const manifest = await readJson(join(this.profileDir, MANIFEST));
        return { manifest: manifest ?? {}, dependencies: { ...manifest?.dependencies ?? {} } };
    }

    /** The version a range names, or a failure naming the range. */
    async resolveVersion(name, range) {
        let failure;
        for (const registry of this.registries) {
            try {
                return await this.resolveFrom(registry, name, range);
            } catch (error) {
                failure = error;
            }
        }
        throw failure;
    }

    /** Resolve a range against one registry. */
    async resolveFrom(registry, name, range) {
        const doc = await packument(registry, name, { signal: this.signal, timeoutMs: this.timeoutMs });
        const versions = Object.keys(doc.versions ?? {});
        const asked = range.length === 0 || range === '*' ? DEFAULT_RANGE : range;
        if (asked === 'latest' || asked === 'newest') {
            const newest = doc['dist-tags']?.latest;
            if (typeof newest === 'string' && versions.includes(newest)) return { doc, version: newest };
            const fallback = maxSatisfying(versions, '*');
            if (fallback !== null) return { doc, version: fallback };
            throw new Error(`${name}: the registry publishes no versions`);
        }
        const version = maxSatisfying(versions, asked);
        if (version !== null) return { doc, version };
        const tagged = doc['dist-tags']?.[asked];
        if (typeof tagged === 'string' && versions.includes(tagged)) return { doc, version: tagged };
        throw new Error(`${name}: no version matches ${asked}`);
    }

    /** Place one package and, recursively, the dependencies it needs. */
    async ensure(name, range, container, parentDirectory) {
        const existing = await installedManifest(container, name);
        if (existing !== undefined && satisfies(existing.manifest.version, range.length === 0 ? '*' : range === 'latest' ? '*' : range)) {
            return existing;
        }
        const remote = parseRemoteSpec(range);
        if (remote !== null) {
            // A repository or archive dependency: an installed copy already answers it.
            if (existing !== undefined) return existing;
            return await this.installRemote(range, container);
        }
        const wanted = await this.resolveVersion(name, range);
        const identity = `${name}@${wanted.version}`;
        if (this.visiting.has(identity)) return undefined;
        // A conflicting top-level version forces this one to nest under its dependent.
        const topLevelDir = join(this.rootNodeModules, name);
        const topLevel = await readJson(join(topLevelDir, MANIFEST));
        let target = topLevelDir;
        if (topLevel !== undefined && topLevel.version !== wanted.version && !satisfies(topLevel.version, range)) {
            target = join(container, name);
        }
        void parentDirectory;
        const entry = wanted.doc.versions[wanted.version];
        const files = await tarball(entry.dist.tarball, { signal: this.signal, timeoutMs: this.timeoutMs });
        const problem = verifyIntegrity(files, entry.dist);
        if (problem !== null) throw new Error(`${identity}: ${problem}`);
        const staging = `${target}.staging-${process.pid}-${this.placed.length}`;
        await rm(staging, { recursive: true, force: true });
        await extractTarball(files, { target: staging });
        await rm(target, { recursive: true, force: true });
        await mkdir(dirname(target), { recursive: true });
        await rename(staging, target);
        const manifest = (await readJson(join(target, MANIFEST))) ?? {};
        this.placed.push({ name, version: wanted.version, directory: target, manifest });
        this.onOutput(`+ ${name} ${wanted.version}`, 'stdout');
        // `target` lives directly under `container`, which is the node_modules directory that
        // owns it. Deriving the directory from `dirname(target)` breaks scoped names, whose
        // parent is the scope folder rather than a node_modules folder.
        const host = container;
        await this.linkBins(host, name, target, manifest);
        this.visiting.add(identity);
        try {
            const dependencies = { ...manifest.dependencies ?? {} };
            const optional = { ...manifest.optionalDependencies ?? {} };
            for (const [depName, depRange] of Object.entries(dependencies)) {
                if (Object.hasOwn(optional, depName)) continue;
                await this.ensure(depName, depRange, host, target);
            }
            for (const [depName, depRange] of Object.entries(optional)) {
                try {
                    await this.ensure(depName, depRange, host, target);
                } catch (error) {
                    this.notes.push(`skipped optional ${depName}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        } finally {
            this.visiting.delete(identity);
        }
        return { directory: target, manifest };
    }

    /** Expose a package's executables under the nearest `node_modules/.bin`. */
    async linkBins(nodeModulesDir, name, directory, manifest) {
        const bin = manifest.bin;
        if (bin === undefined || bin === null) return;
        const entries = typeof bin === 'string' ? [[name.split('/').pop() ?? name, bin]] : Object.entries(bin);
        for (const [binName, target] of entries) {
            if (typeof target !== 'string' || target.length === 0) continue;
            const script = join(directory, target);
            const present = await stat(script).then(() => true, () => false);
            if (!present) continue;
            await chmod(script, 0o755).catch(() => undefined);
            const binDir = join(nodeModulesDir, '.bin');
            await mkdir(binDir, { recursive: true });
            const link = join(binDir, binName);
            await rm(link, { force: true });
            // The app sandbox refuses symlinks, so the entry forwards to the script instead.
            const relativeScript = relative(binDir, script).split(sep).join('/');
            const shim = [
                '#!/bin/sh',
                '# Written by the DSH OHOS installer: this sandbox cannot create symlinks.',
                'exec "${DSH_NODE:-node}" "$(dirname "$0")/' + relativeScript + '" "$@"',
                '',
            ].join('\n');
            await writeFile(link, shim, { mode: 0o755 });
        }
    }

    /**
     * Install one GitHub repository or archive URL, which needs no git binary.
     *
     * The archive is unpacked into a staging directory outside `node_modules`,
     * because a package archive wraps its tree in one top-level directory; the
     * inner directory moves into place, and the package's registry dependencies
     * are then resolved the usual way.
     * @param spec The spec as typed.
     * @param container The `node_modules` directory to place into.
     * @returns The placed package and the spec that records it.
     */
    async installRemote(spec, container) {
        const remote = parseRemoteSpec(spec);
        if (remote === null) throw new Error(`${spec}: is not a repository or an archive URL`);
        const bytes = await fetchArchive(remote.url, { signal: this.signal, timeoutMs: this.timeoutMs });
        const staging = join(this.profileDir, '.plugin-manager', `remote-${process.pid}-${this.placed.length}`);
        await rm(staging, { recursive: true, force: true });
        await mkdir(dirname(staging), { recursive: true });
        try {
            await extractTarball(bytes, { target: staging, strip: 0 });
            const root = await archivePackageRoot(staging);
            if (root === null) throw new Error(`${spec}: the archive holds no package.json`);
            const manifest = (await readJson(join(root, MANIFEST))) ?? {};
            const name = textOr(manifest.name, remote.name);
            if (typeof name !== 'string' || name.length === 0) throw new Error(`${spec}: the archive names no package`);
            const target = join(this.rootNodeModules, name);
            const staged = `${target}.staging-${process.pid}-${this.placed.length}`;
            await rm(staged, { recursive: true, force: true });
            await mkdir(dirname(target), { recursive: true });
            await rename(root, staged);
            await rm(target, { recursive: true, force: true });
            await rename(staged, target);
            this.placed.push({ name, version: manifest.version, directory: target, manifest, remote });
            this.onOutput(`+ ${name} ${textOr(manifest.version, '0.0.0')} (${remote.saved})`, 'stdout');
            await this.linkBins(this.rootNodeModules, name, target, manifest);
            const optional = { ...manifest.optionalDependencies ?? {} };
            for (const [depName, depRange] of Object.entries(manifest.dependencies ?? {})) {
                if (Object.hasOwn(optional, depName)) continue;
                await this.ensure(depName, depRange, join(target, 'node_modules'), target);
            }
            for (const [depName, depRange] of Object.entries(optional)) {
                try {
                    await this.ensure(depName, depRange, join(target, 'node_modules'), target);
                } catch (error) {
                    this.notes.push(`skipped optional ${depName}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            void container;
            return { directory: target, manifest, remote };
        } finally {
            await rm(staging, { recursive: true, force: true });
        }
    }

    /** Install every spec, then write the versions back into the profile manifest. */
    async add(specs) {
        const { manifest, dependencies } = await this.dependencies();
        const added = [];
        for (const spec of specs) {
            const remote = parseRemoteSpec(spec);
            if (remote !== null) {
                const placed = await this.installRemote(spec, this.rootNodeModules);
                const name = textOr(placed.manifest.name, remote.name);
                dependencies[name] = remote.saved;
                added.push({ name, version: placed.manifest.version });
                continue;
            }
            const { name, range } = splitSpec(spec);
            if (name.length === 0) throw new Error(`invalid package spec: ${spec}`);
            const placed = await this.ensure(name, range, this.rootNodeModules, this.profileDir);
            const version = placed?.manifest.version ?? dependencies[name];
            if (typeof version !== 'string') throw new Error(`${name}: could not be installed`);
            dependencies[name] = savedRange(version, this.saveExact);
            added.push({ name, version });
        }
        await writeJson(join(this.profileDir, MANIFEST), { ...manifest, dependencies });
        return added;
    }

    /** Remove packages and their manifest entries. */
    async remove(names) {
        const { manifest, dependencies } = await this.dependencies();
        const removed = [];
        for (const name of names) {
            const target = join(this.rootNodeModules, name);
            const present = await stat(target).then(() => true, () => false);
            if (!present && !Object.hasOwn(dependencies, name)) throw new Error(`${name}: is not installed`);
            await rm(target, { recursive: true, force: true });
            delete dependencies[name];
            removed.push(name);
            this.onOutput(`- ${name}`, 'stdout');
        }
        await writeJson(join(this.profileDir, MANIFEST), { ...manifest, dependencies });
        return removed;
    }

    /** Install everything the manifest declares. */
    async installAll() {
        const { dependencies } = await this.dependencies();
        for (const [name, range] of Object.entries(dependencies)) {
            if (typeof range !== 'string' || range.startsWith('file:') || range.startsWith('link:')) {
                this.notes.push(`skipped ${name}: ${String(range)}`);
                continue;
            }
            if (parseRemoteSpec(range) !== null) {
                await this.installRemote(range, this.rootNodeModules);
                continue;
            }
            await this.ensure(name, range, this.rootNodeModules, this.profileDir);
        }
        return this.placed;
    }
}

/**
 * Read what a repository or archive spec names, before anything is installed.
 * @param spec The spec as typed.
 * @param options Cancellation, deadline and byte cap of the download.
 * @returns The spec's remote form and the manifest it declares.
 */
export async function inspectRemoteManifest(spec, options = {}) {
    const remote = parseRemoteSpec(spec);
    if (remote === null) throw new Error(`${spec}: is not a repository or an archive URL`);
    const bytes = await fetchArchive(remote.url, options);
    const staging = await mkdtemp(join(tmpdir(), 'dsh-remote-'));
    try {
        await extractTarball(bytes, { target: staging, strip: 0 });
        const root = await archivePackageRoot(staging);
        if (root === null) throw new Error(`${spec}: the archive holds no package.json`);
        return { remote, manifest: (await readJson(join(root, MANIFEST))) ?? {} };
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

/** Packages installed directly in a profile's node_modules. */
export async function listInstalled(dir) {
    const nodeModules = join(dir, 'node_modules');
    const rows = [];
    const names = await readdir(nodeModules).catch(() => []);
    for (const name of names) {
        if (name.startsWith('.')) continue;
        if (name.startsWith('@')) {
            const scoped = await readdir(join(nodeModules, name)).catch(() => []);
            for (const inner of scoped) {
                const manifest = await readJson(join(nodeModules, name, inner, MANIFEST));
                if (manifest !== undefined) rows.push({ name: `${name}/${inner}`, version: manifest.version });
            }
            continue;
        }
        const manifest = await readJson(join(nodeModules, name, MANIFEST));
        if (manifest !== undefined) rows.push({ name, version: manifest.version });
    }
    return rows;
}

export { registryFor };
