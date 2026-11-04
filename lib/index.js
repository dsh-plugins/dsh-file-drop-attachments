import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, opendir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
const RESOLVE_ROUTE = '/api/file-drop-attachments/resolve';
const UPLOAD_ROUTE = '/api/file-drop-attachments/upload';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 32;
const MAX_SCAN_ENTRIES = 50_000;
const MAX_SCAN_MS = 5_000;
const IGNORED_SCAN_DIRECTORIES = new Set(['.git', '.gradle', '.idea', 'node_modules']);
const configuredDshHome = process.env.DSH_HOME?.trim();
const DSH_HOME = resolve(configuredDshHome === undefined || configuredDshHome === ''
    ? join(homedir(), '.dsh')
    : configuredDshHome);
const STORAGE_ROOT = join(DSH_HOME, 'file-drop-attachments');
const IMAGE_STORE_ROOT = join(DSH_HOME, 'attachments', 'v1');
const IMAGE_ALIAS_ROOT = join(STORAGE_ROOT, 'image-cache');
const IMAGE_EXTENSION_BY_MEDIA_TYPE = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
    });
    res.end(body);
}
function sameOrigin(req) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin === undefined || host === undefined)
        return true;
    return origin === `http://${host}` || origin === `https://${host}`;
}
async function readBytes(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > limit)
            throw new HttpError(413, `file exceeds ${Math.floor(limit / 1024 / 1024)} MiB limit`);
        chunks.push(bytes);
    }
    return Buffer.concat(chunks);
}
async function readJson(req) {
    const raw = (await readBytes(req, MAX_BODY_BYTES)).toString('utf8');
    return raw === '' ? {} : JSON.parse(raw);
}
function safeAttachmentName(value) {
    const leaf = basename(String(value ?? '').replace(/\\/g, '/'));
    const cleaned = leaf.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim().slice(0, 180);
    const name = cleaned === '' ? 'attachment.bin' : cleaned;
    return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) ? `_${name}` : name;
}
function safeSessionName(value) {
    const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
    return cleaned === '' ? 'unscoped' : cleaned;
}
export async function storeUploadedFile(storageRoot, sessionId, name, bytes) {
    const directory = join(storageRoot, safeSessionName(sessionId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeAttachmentName(name)}`);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return path;
}
function contentDigest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
export async function findMatchingWorkspaceFile(cwd, name, bytes, options = {}) {
    if (!isAbsolute(cwd))
        return '';
    try {
        if (!(await stat(cwd)).isDirectory())
            return '';
    }
    catch {
        return '';
    }
    const maxEntries = options.maxEntries ?? MAX_SCAN_ENTRIES;
    const deadline = Date.now() + (options.maxMs ?? MAX_SCAN_MS);
    const expectedName = basename(name).toLocaleLowerCase('en-US');
    const expectedDigest = contentDigest(bytes);
    const directories = [cwd];
    const matches = [];
    let visited = 0;
    while (directories.length > 0 && visited < maxEntries && Date.now() <= deadline) {
        const directory = directories.shift();
        let handle;
        try {
            handle = await opendir(directory);
        }
        catch {
            continue;
        }
        for await (const entry of handle) {
            visited += 1;
            if (visited > maxEntries || Date.now() > deadline)
                break;
            const candidate = join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!IGNORED_SCAN_DIRECTORIES.has(entry.name))
                    directories.push(candidate);
                continue;
            }
            if (!entry.isFile() || entry.name.toLocaleLowerCase('en-US') !== expectedName)
                continue;
            try {
                const info = await stat(candidate);
                if (info.size !== bytes.length)
                    continue;
                if (contentDigest(await readFile(candidate)) !== expectedDigest)
                    continue;
                matches.push(candidate);
                if (matches.length > 1)
                    return '';
            }
            catch {
                // Continue searching when a candidate changes or becomes unreadable.
            }
        }
    }
    return matches.length === 1 ? matches[0] : '';
}
function normalizedInput(value) {
    const input = value !== null && typeof value === 'object' ? value : {};
    const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : undefined;
    const entries = Array.isArray(input.entries)
        ? input.entries.slice(0, MAX_ENTRIES).map((value) => {
            const entry = value !== null && typeof value === 'object' ? value : {};
            return {
                name: typeof entry.name === 'string' ? entry.name.slice(0, 1024) : '',
                hint: typeof entry.hint === 'string' ? entry.hint.slice(0, 8192) : '',
            };
        })
        : [];
    return { cwd, entries };
}
export async function resolvePaths(fs, input) {
    const paths = [];
    for (const entry of input.entries) {
        let resolved = '';
        const candidates = entry.hint !== '' ? [entry.hint, entry.name] : [entry.name];
        for (const candidate of candidates) {
            if (candidate === '')
                continue;
            try {
                const target = await fs.resolve(candidate, input.cwd === undefined ? undefined : { cwd: input.cwd });
                const info = await fs.stat(target);
                const processed = info?.type === 'file' ? fs.processPath(target) : '';
                if (isAbsolute(processed)) {
                    resolved = processed;
                    break;
                }
            }
            catch {
                // Try the next candidate; unresolved drops are rejected below.
            }
        }
        paths.push(resolved);
    }
    return paths;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function imageReferenceParts(ref) {
    const match = /^sha256:([a-f0-9]{64})$/.exec(String(ref?.attachmentId ?? ''));
    const extension = IMAGE_EXTENSION_BY_MEDIA_TYPE[String(ref?.mediaType ?? '')];
    if (match === null || extension === undefined)
        return undefined;
    return { sha256: match[1], extension };
}
function imageObjectPath(ref, imageStoreRoot = IMAGE_STORE_ROOT) {
    const parts = imageReferenceParts(ref);
    if (parts === undefined)
        return '';
    return join(imageStoreRoot, 'objects', parts.sha256.slice(0, 2), parts.sha256);
}
function imageAliasRootFor(imageStoreRoot) {
    return imageStoreRoot === IMAGE_STORE_ROOT
        ? IMAGE_ALIAS_ROOT
        : join(dirname(dirname(imageStoreRoot)), 'file-drop-attachments', 'image-cache');
}
/** Return an extension-bearing, model-readable path for one durable image ref. */
export function imageCachePath(ref, imageStoreRoot = IMAGE_STORE_ROOT, aliasRoot = imageAliasRootFor(imageStoreRoot)) {
    const parts = imageReferenceParts(ref);
    if (parts === undefined)
        return '';
    return join(aliasRoot, parts.sha256.slice(0, 2), `${parts.sha256}.${parts.extension}`);
}
function historicalImageText(ref, imageStoreRoot, aliasRoot, availablePaths) {
    const path = imageCachePath(ref, imageStoreRoot, aliasRoot);
    if (path !== '' && (availablePaths === undefined || availablePaths.has(path))) {
        return `[图片缓存] \`${path.replace(/`/g, '\\`')}\``;
    }
    return `[图片缓存不可用] ${String(ref?.attachmentId ?? 'unknown')}`;
}
function stripImageBlocks(blocks, imageStoreRoot, aliasRoot, availablePaths) {
    let removedCount = 0;
    let changed = false;
    const next = [];
    for (const block of blocks) {
        if (!isRecord(block)) {
            next.push(block);
            continue;
        }
        if (block.type === 'image') {
            removedCount += 1;
            changed = true;
            next.push({
                type: 'text',
                text: historicalImageText(block.attachment, imageStoreRoot, aliasRoot, availablePaths),
            });
            continue;
        }
        if (block.type === 'tool-result' && Array.isArray(block.content)) {
            const nested = stripImageBlocks(block.content, imageStoreRoot, aliasRoot, availablePaths);
            removedCount += nested.removedCount;
            if (nested.removedCount > 0) {
                changed = true;
                next.push({ ...block, content: nested.blocks });
                continue;
            }
        }
        next.push(block);
    }
    return { blocks: changed ? next : blocks, removedCount };
}
function lastAssistantIndex(messages) {
    let index = -1;
    for (let position = 0; position < messages.length; position += 1) {
        const message = messages[position];
        if (isRecord(message) && message.role === 'assistant')
            index = position;
    }
    return index;
}
function collectImageRefs(blocks, refs) {
    for (const block of blocks) {
        if (!isRecord(block))
            continue;
        if (block.type === 'image' && isRecord(block.attachment)) {
            const key = String(block.attachment.attachmentId ?? '');
            if (key !== '' && !refs.has(key))
                refs.set(key, block.attachment);
            continue;
        }
        if (block.type === 'tool-result' && Array.isArray(block.content)) {
            collectImageRefs(block.content, refs);
        }
    }
}
function historicalImageRefs(options) {
    if (!isRecord(options) || !Array.isArray(options.messages))
        return [];
    const lastAssistant = lastAssistantIndex(options.messages);
    const refs = new Map();
    for (let index = 0; index <= lastAssistant; index += 1) {
        const message = options.messages[index];
        if (isRecord(message) && Array.isArray(message.content))
            collectImageRefs(message.content, refs);
    }
    return [...refs.values()];
}
/* Keep an extension-bearing alias so the model-facing read_image tool can resolve media type. */
async function ensureImageCacheAliases(options, imageStoreRoot, aliasRoot) {
    const availablePaths = new Set();
    for (const ref of historicalImageRefs(options)) {
        const source = imageObjectPath(ref, imageStoreRoot);
        const target = imageCachePath(ref, imageStoreRoot, aliasRoot);
        if (source === '' || target === '')
            continue;
        try {
            const info = await stat(target);
            if (info.isFile())
                availablePaths.add(target);
            continue;
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                continue;
        }
        try {
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            try {
                await link(source, target);
            }
            catch (error) {
                if (error?.code !== 'EEXIST')
                    await copyFile(source, target);
            }
            const info = await stat(target);
            if (info.isFile())
                availablePaths.add(target);
        }
        catch {
            // A missing cache object must not make an otherwise valid text request fail.
        }
    }
    return availablePaths;
}
/**
 * Replace image refs already covered by a completed assistant turn with an
 * extension-bearing cache path. The adapter still receives images from the
 * unresolved suffix of the request as binary content.
 */
export function pruneHistoricalImages(options, imageStoreRoot = IMAGE_STORE_ROOT, aliasRoot = imageAliasRootFor(imageStoreRoot), availablePaths) {
    if (!isRecord(options) || !Array.isArray(options.messages)) {
        return { options, removedCount: 0 };
    }
    const lastAssistant = lastAssistantIndex(options.messages);
    let removedCount = 0;
    const messages = options.messages.map((message, index) => {
        if (!isRecord(message) || index > lastAssistant || !Array.isArray(message.content))
            return message;
        const result = stripImageBlocks(message.content, imageStoreRoot, aliasRoot, availablePaths);
        removedCount += result.removedCount;
        return result.removedCount === 0 ? message : { ...message, content: result.blocks };
    });
    if (removedCount === 0)
        return { options, removedCount: 0 };
    const next = { ...options, messages };
    if (Object.isFrozen(options)) {
        for (let index = 0; index < messages.length; index += 1) {
            if (messages[index] !== options.messages[index] && isRecord(messages[index])) {
                Object.freeze(messages[index]);
            }
        }
        Object.freeze(messages);
        Object.freeze(next);
    }
    return { options: next, removedCount };
}
/*
 * The core stream waterfall receives a frozen request. Wrapping registered
 * adapters lets this plugin project a request copy without mutating history.
 */
function installHistoricalImagePolicy(ctx) {
    const llm = ctx.llm;
    const originals = new Map();
    const wrap = () => {
        const registrations = llm?.adapters;
        if (!(registrations instanceof Map))
            return;
        for (const registration of registrations.values()) {
            const adapter = registration?.adapter;
            if (adapter === undefined || typeof adapter.stream !== 'function' || originals.has(adapter))
                continue;
            const original = adapter.stream;
            const wrapped = async function* streamWithCurrentImages(options) {
                const imageStoreRoot = typeof ctx.attachments?.root === 'string' ? ctx.attachments.root : IMAGE_STORE_ROOT;
                const aliasRoot = imageAliasRootFor(imageStoreRoot);
                const availablePaths = await ensureImageCacheAliases(options, imageStoreRoot, aliasRoot);
                const projected = pruneHistoricalImages(options, imageStoreRoot, aliasRoot, availablePaths).options;
                yield* original.call(this, projected);
            };
            adapter.stream = wrapped;
            originals.set(adapter, { original, wrapped });
        }
    };
    wrap();
    const stopWatching = ctx.on('llm/adapters-updated', wrap);
    return () => {
        stopWatching();
        for (const [adapter, entry] of originals) {
            if (adapter.stream === entry.wrapped)
                adapter.stream = entry.original;
        }
        originals.clear();
    };
}
export default {
    name: 'dsh-file-drop-attachments',
    inject: ['webServer', 'fs', 'llm', 'attachments'],
    apply(ctx) {
        ctx.effect(() => installHistoricalImagePolicy(ctx), 'file-drop-attachments: historical image policy');
        ctx.effect(() => ctx.webServer.register({
            kind: 'exact',
            path: RESOLVE_ROUTE,
            async handler(req, res) {
                if (req.method !== 'POST') {
                    res.setHeader('allow', 'POST');
                    sendJson(res, 405, { error: 'method not allowed' });
                    return;
                }
                if (!sameOrigin(req)) {
                    sendJson(res, 403, { error: 'forbidden' });
                    return;
                }
                try {
                    const input = normalizedInput(await readJson(req));
                    const paths = await resolvePaths(ctx.fs, input);
                    sendJson(res, 200, { paths });
                }
                catch (error) {
                    const status = error instanceof HttpError ? error.status : 400;
                    const message = error instanceof Error ? error.message : String(error);
                    sendJson(res, status, { error: message });
                }
            },
        }), 'file-drop-attachments: path resolver');
        ctx.effect(() => ctx.webServer.register({
            kind: 'exact',
            path: UPLOAD_ROUTE,
            async handler(req, res) {
                if (req.method !== 'POST') {
                    res.setHeader('allow', 'POST');
                    sendJson(res, 405, { error: 'method not allowed' });
                    return;
                }
                if (!sameOrigin(req) || req.headers['x-dsh-file-drop'] !== '1') {
                    sendJson(res, 403, { error: 'forbidden' });
                    return;
                }
                try {
                    const url = new URL(req.url ?? UPLOAD_ROUTE, `http://${req.headers.host ?? '127.0.0.1'}`);
                    const name = url.searchParams.get('name') ?? '';
                    const sessionId = url.searchParams.get('sessionId') ?? '';
                    const cwd = url.searchParams.get('cwd') ?? '';
                    if (name === '' || sessionId === '')
                        throw new HttpError(400, 'missing file name or session id');
                    const declaredSize = Number(req.headers['content-length']);
                    if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD_BYTES) {
                        throw new HttpError(413, `file exceeds ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MiB limit`);
                    }
                    const bytes = await readBytes(req, MAX_UPLOAD_BYTES);
                    const sourcePath = await findMatchingWorkspaceFile(cwd, name, bytes);
                    if (sourcePath !== '') {
                        sendJson(res, 200, { path: sourcePath, copied: false });
                        return;
                    }
                    const path = await storeUploadedFile(STORAGE_ROOT, sessionId, name, bytes);
                    sendJson(res, 200, { path, copied: true });
                }
                catch (error) {
                    const status = error instanceof HttpError ? error.status : 500;
                    const message = error instanceof Error ? error.message : String(error);
                    if (status === 500)
                        console.error('[dsh-file-drop-attachments] upload failed', error);
                    sendJson(res, status, { error: message });
                }
            },
        }), 'file-drop-attachments: upload fallback');
    },
};
