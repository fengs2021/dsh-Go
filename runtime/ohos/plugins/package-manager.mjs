/**
 * The OHOS stand-in for the `pnpm` executable.
 *
 * `@deepseek-ai/dsh-plugin-manager` reaches the package manager through three
 * functions: `runProfilePnpm` (every install and remove), `viewProfilePackage`
 * (what a spec names before installing it) and `readProfileRegistry` (the
 * registry pnpm's own configuration resolves). This module answers all three
 * from Node alone, so the phone-local engine can install plugins without a
 * package manager binary, which an OHOS app sandbox cannot provide.
 *
 * `runtime/ohos/preload.mjs` publishes it as `globalThis.__dshOhosPackageManager`
 * and the plugin manager's openharmony branches delegate here.
 */
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { InstallSession, inspectRemoteManifest, listInstalled, splitSpec } from './install.mjs';
import { packument, registryFor } from './registry.mjs';
import { parseRemoteSpec } from './remote.mjs';
import { maxSatisfying } from './semver.mjs';

/** The version string a package manager reports for this implementation. */
export const VERSION = '9.99.0-ohos';

/** Commands that install packages, as `pnpm` names them. */
const ADD_COMMANDS = new Set(['add', 'install', 'i', 'update', 'up']);

/** Commands that remove packages. */
const REMOVE_COMMANDS = new Set(['remove', 'rm', 'uninstall', 'un']);

/** Flags that carry a value and must not be read as a package spec. */
const VALUE_FLAGS = new Set(['--registry', '--filter', '--dir', '--config.registry', '--reporter', '--network-concurrency', '--fetch-timeout']);

/** Fields that only a full packument carries. */
const PACKUMENT_FIELDS = new Set(['versions', 'time', 'dist-tags']);

/** The profile directory a call operates on. */
export function profileDirectory(context) {
    if (typeof context?.dir === 'string' && context.dir.length > 0) return context.dir;
    const home = typeof context?.home === 'string' && context.home.length > 0 ? context.home : join(homedir(), '.dsh');
    return join(home, 'profiles', typeof context?.profile === 'string' && context.profile.length > 0 ? context.profile : 'dsh');
}

/** Split a pnpm argument list into its command, package specs and flags. */
export function parseArguments(args) {
    const list = args.map((argument) => String(argument));
    const command = list.find((argument) => !argument.startsWith('-')) ?? '';
    const commandIndex = list.indexOf(command);
    const specs = [];
    const flags = new Set();
    const values = new Map();
    for (let index = commandIndex + 1; index < list.length; index += 1) {
        const argument = list[index];
        if (!argument.startsWith('-')) {
            specs.push(argument);
            continue;
        }
        if (argument.includes('=')) {
            const [name, ...rest] = argument.split('=');
            values.set(name, rest.join('='));
            flags.add(name);
            continue;
        }
        if (VALUE_FLAGS.has(argument) && index + 1 < list.length) {
            values.set(argument, list[index + 1]);
            flags.add(argument);
            index += 1;
            continue;
        }
        flags.add(argument);
    }
    // Flags before the command ("--save-exact add x") still count.
    for (const argument of list.slice(0, Math.max(0, commandIndex))) {
        if (argument.startsWith('-')) flags.add(argument.split('=')[0]);
    }
    return { command, specs, flags, values };
}

// 设备直连 npmjs 时一个 4 MB 的包要几十秒，先走国内镜像；镜像缺包或缺版本时再回落官方源。
const DEVICE_MIRRORS = ['https://registry.npmmirror.com/', 'https://registry.npmjs.org/'];
const trimSlash = (value) => String(value).replace(/\/+$/, '');

/** Registries to try, in order: the configured one first unless it is the slow official default. */
export function registryChain(configured) {
    const official = 'https://registry.npmjs.org';
    const chain = trimSlash(configured) === official ? [] : [configured];
    for (const mirror of DEVICE_MIRRORS) {
        if (!chain.some((entry) => trimSlash(entry) === trimSlash(mirror))) chain.push(mirror);
    }
    return chain;
}

/** The registry a run uses: its own flag first, then the profile's configuration. */
export async function resolveRegistry(dir, flags, values) {
    const flagged = values.get('--registry') ?? null;
    if (typeof flagged === 'string' && flagged.length > 0) return flagged;
    return registryFor(dir);
}

/** Read the fields a lookup asked for from a repository or archive spec. */
async function lookupRemote(remote, fields, options) {
    const { manifest } = await inspectRemoteManifest(remote.spec, {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? 120000,
    });
    const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
    const view = {};
    for (const field of fields) {
        if (field === 'versions') view.versions = { [version]: version };
        else if (field === 'time') view.time = {};
        else if (field === 'dist-tags') view['dist-tags'] = { latest: version };
        else if (Object.hasOwn(manifest, field)) view[field] = manifest[field];
    }
    if (Object.keys(view).length === 0) {
        view.name = manifest.name ?? remote.name;
        view.version = version;
    }
    return view;
}

/** Collapse a packument record into the fields a lookup asked for. */
async function lookupViews(registry, spec, fields, options) {
    const remote = parseRemoteSpec(spec);
    if (remote !== null) return await lookupRemote(remote, fields, options);
    const { name, range } = splitSpec(spec);
    if (name.length === 0) throw Object.assign(new Error(`Invalid package spec: ${spec}`), { code: 'EINVALIDSPEC' });
    const full = fields.some((field) => PACKUMENT_FIELDS.has(field));
    const doc = await packument(registry, name, { full, ...options });
    const versions = Object.keys(doc.versions ?? {});
    let version = null;
    const asked = range.length === 0 ? 'latest' : range;
    if (asked === 'latest' || asked === '*') version = typeof doc['dist-tags']?.latest === 'string' ? doc['dist-tags'].latest : maxSatisfying(versions, '*');
    else version = maxSatisfying(versions, asked);
    if (version === null) throw Object.assign(new Error(`No matching version found for ${spec}`), { code: 'E404' });
    const entry = doc.versions[version] ?? {};
    const view = {};
    for (const field of fields) {
        if (field === 'versions') view.versions = Object.fromEntries(versions.map((item) => [item, doc.versions[item]?.version ?? item]));
        else if (field === 'time') view.time = doc.time ?? {};
        else if (field === 'dist-tags') view['dist-tags'] = doc['dist-tags'] ?? {};
        else if (Object.hasOwn(entry, field)) view[field] = entry[field];
        else if (Object.hasOwn(doc, field)) view[field] = doc[field];
    }
    if (Object.keys(view).length === 0) {
        view.name = entry.name ?? name;
        view.version = version;
    }
    return view;
}

/**
 * Read what a spec names, the way `pnpm view <spec> <fields> --json` reports it.
 * @returns Exit status, the JSON a lookup parses, and whether the bound stopped it.
 */
export async function viewProfilePackage(dir, spec, options) {
    const fields = Array.isArray(options?.fields) && options.fields.length > 0 ? options.fields : ['name', 'version'];
    const configured = typeof options?.registry === 'string' && options.registry.length > 0 ? options.registry : registryFor(dir);
    const registries = Array.isArray(options?.registries) && options.registries.length > 0 ? options.registries : registryChain(configured);
    let view;
    let failure;
    for (const registry of registries) {
        try {
            view = await lookupViews(registry, spec, fields, {
                timeoutMs: options?.timeoutMs,
                ...options?.signal === undefined ? {} : { signal: options.signal },
            });
            failure = undefined;
            break;
        } catch (error) {
            failure = error;
        }
    }
    try {
        if (failure !== undefined) throw failure;
        return { exitCode: 0, stdout: JSON.stringify(view), stderr: '', timedOut: false };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
        const label = code === 'E404' ? 'ERR_PNPM_FETCH_404' : 'ERR_OHOS_REGISTRY';
        return { exitCode: code === 'E404' ? 1 : 1, stdout: '', stderr: `${label}  ${message}\n`, timedOut: false };
    }
}

/** Read the registry the profile's npm configuration names, as `pnpm config get registry` prints it. */
export async function readRegistry(dir) {
    try {
        return registryFor(dir);
    } catch (error) {
        void error;
        return null;
    }
}

/** One install or remove run, with its recorded log and bounded output. */
class RunLog {
    constructor(logPath, options) {
        this.logPath = logPath;
        this.handle = undefined;
        this.limit = typeof options?.outputBytes === 'number' && options.outputBytes > 0 ? options.outputBytes : 200_000;
        this.chunks = [];
        this.length = 0;
        this.truncated = false;
        this.onOutput = typeof options?.onOutput === 'function' ? options.onOutput : undefined;
    }

    async open() {
        this.handle = await open(this.logPath, 'w', 0o600);
    }

    /** Append one message to the log, the caller's stream and the bounded result. */
    write(text, stream = 'stdout') {
        const bytes = Buffer.from(text.endsWith('\n') ? text : `${text}\n`);
        this.chunks.push(bytes);
        this.length += bytes.length;
        while (this.length > this.limit && this.chunks.length > 0) {
            const first = this.chunks[0];
            const excess = this.length - this.limit;
            if (first.length <= excess) {
                this.chunks.shift();
                this.length -= first.length;
            } else {
                this.chunks[0] = first.subarray(excess);
                this.length -= excess;
            }
            this.truncated = true;
        }
        this.onOutput?.(text.endsWith('\n') ? text : `${text}\n`, stream);
        const handle = this.handle;
        if (handle !== undefined) handle.write(bytes).catch((error) => console.error('[ohos-pnpm] log write failed', error));
        return this;
    }

    output() {
        return Buffer.concat(this.chunks).toString('utf8');
    }

    async close() {
        const handle = this.handle;
        this.handle = undefined;
        if (handle !== undefined) await handle.close().catch(() => {});
    }
}

/**
 * Run one package-manager command inside a profile.
 *
 * Supports what the plugin manager asks for: `add`, `remove`, `install`,
 * `view`, `config get registry`, `list` and `--version`. Registry specs,
 * GitHub repositories and archive URLs install; a local path on this machine is
 * refused, because the device cannot read it.
 *
 * @param context Launcher-owned profile locations (`dir`, `home`, `profile`).
 * @param args Package-manager arguments, as the plugin manager builds them.
 * @param options Output, bound and cancellation policy.
 * @returns Exit status, the bounded output, and the diagnostic log path.
 */
export async function runProfilePnpm(context, args, options = {}) {
    const dir = profileDirectory(context);
    const logRoot = join(dir, '.plugin-manager', 'logs');
    await mkdir(logRoot, { recursive: true, mode: 0o700 }).catch(() => {});
    const logDir = await mkdtemp(join(logRoot, 'operation-')).catch(() => join(logRoot, `operation-${Date.now()}`));
    await mkdir(logDir, { recursive: true }).catch(() => {});
    const logPath = join(logDir, 'pnpm.log');
    const log = new RunLog(logPath, options);
    await log.open().catch(() => {});
    const started = Date.now();
    const finish = async (exitCode) => {
        log.write(exitCode === 0 ? `Done in ${((Date.now() - started) / 1000).toFixed(1)}s` : 'The operation failed.', exitCode === 0 ? 'stdout' : 'stderr');
        await log.close();
        return { exitCode, output: log.output(), truncated: log.truncated, logPath };
    };
    const fail = async (message) => {
        log.write(message, 'stderr');
        return await finish(1);
    };
    if (options.signal?.aborted === true) return await fail('The operation was cancelled.');
    const parsed = parseArguments(args);
    const registry = await resolveRegistry(dir, parsed.flags, parsed.values).catch(() => 'https://registry.npmjs.org/');
    const registries = registryChain(registry);
    log.write(`> dsh plugin ${args.join(' ')}`);
    log.write(`registry: ${registries.join(' -> ')}`);
    if (parsed.command === 'config') {
        const key = parsed.specs[0] ?? 'get';
        if (key === 'get' || key === 'registry') return await (async () => {
            const value = parsed.specs[1] === 'registry' || key === 'registry' ? registry : '';
            log.write(value, 'stdout');
            return await finish(0);
        })();
        return await fail(`config ${parsed.specs.join(' ')} is not supported on this device.`);
    }
    if (parsed.command === '--version' || parsed.command === 'version' || parsed.command === '-v') {
        log.write(VERSION, 'stdout');
        return await finish(0);
    }
    if (parsed.command === 'view' || parsed.command === 'info' || parsed.command === 'show') {
        const spec = parsed.specs[0] ?? '';
        const fields = parsed.specs.slice(1);
        const viewed = await viewProfilePackage(dir, spec, { fields: fields.length > 0 ? fields : ['name', 'version', 'dist-tags'], registry, registries, timeoutMs: options.lookupTimeoutMs });
        if (viewed.exitCode !== 0) return await fail(viewed.stderr.trim());
        log.write(viewed.stdout, 'stdout');
        return await finish(0);
    }
    if (parsed.command === 'list' || parsed.command === 'ls') {
        for (const row of await listInstalled(dir)) log.write(`${row.name} ${row.version}`, 'stdout');
        return await finish(0);
    }
    const session = new InstallSession({
        dir,
        registry,
        registries,
        saveExact: parsed.flags.has('--save-exact') || parsed.flags.has('-E'),
        signal: options.signal,
        timeoutMs: options.lookupTimeoutMs,
        onOutput: (text, stream) => log.write(text, stream),
    });
    try {
        if (REMOVE_COMMANDS.has(parsed.command)) {
            if (parsed.specs.length === 0) return await fail('No package was named to remove.');
            const removed = await session.remove(parsed.specs.map((spec) => splitSpec(spec).name));
            log.write(`Removed ${removed.length} package(s).`, 'stdout');
            return await finish(0);
        }
        if (!ADD_COMMANDS.has(parsed.command) && parsed.command !== '') {
            return await fail(`The package-manager command "${parsed.command}" is not supported on this device.`);
        }
        // A local path names a file on the machine that asked; the device cannot read it.
        const local = parsed.specs.filter((spec) => /^(?:file|link):/i.test(spec) || spec.startsWith('/'));
        if (local.length > 0) {
            return await fail(`A local path cannot be installed on the device: ${local.join(', ')}. Install from a registry, a GitHub repository, or an archive URL instead.`);
        }
        const specs = parsed.specs;
        if (specs.length === 0) {
            const placed = await session.installAll();
            for (const note of session.notes) log.write(note, 'stderr');
            log.write(`Installed ${placed.length} package(s).`, 'stdout');
            return await finish(0);
        }
        const added = await session.add(specs);
        for (const note of session.notes) log.write(note, 'stderr');
        log.write(`Added ${added.length} package(s).`, 'stdout');
        return await finish(0);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return await fail(`ERR_OHOS_INSTALL  ${message}`);
    }
}

/** Read one installed package manifest, for callers that report versions. */
export async function installedVersion(dir, name) {
    try {
        return JSON.parse(await readFile(join(dir, 'node_modules', name, 'package.json'), 'utf8')).version ?? null;
    } catch (error) {
        void error;
        return null;
    }
}

export default { VERSION, runProfilePnpm, viewProfilePackage, readRegistry, parseArguments, profileDirectory };
