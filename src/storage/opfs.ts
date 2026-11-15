import { CacheError, QuotaExceededError, UnsupportedEnvironmentError } from "../errors";
import { withWebLock } from "../locks";
import { isExpired } from "../time";
import type {
    StorageAdapter,
    StoredMeta,
    StoredPayload,
    StoredRecord,
    WriteOp,
    WriteResult,
} from "./types";

// ==============================
// Origin Private File System adapter
//
// Good for large binary payloads (images, media, model weights): payloads are
// plain files, so the browser doesn't structured-clone them through IndexedDB.
//
//   cachecraft/_<db>/_<store>/system.json
//   cachecraft/_<db>/_<store>/_<namespace>/<sha256(key)>.m   metadata (JSON)
//   cachecraft/_<db>/_<store>/_<namespace>/<sha256(key)>.d   payload
//
// Writes of one namespace are serialised across tabs with an exclusive Web Lock and
// reads take it in shared mode (a file replaced mid-read is unreadable). A batch is
// applied file by file (payload before metadata), so an interrupted write leaves
// at most an orphan payload — never metadata pointing at a missing payload that
// the engine wouldn't detect.
// ==============================

type DirHandle = FileSystemDirectoryHandle & {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};
type FileHandle = FileSystemFileHandle & {
    createWritable(): Promise<{
        write(data: BufferSource | string): Promise<void>;
        close(): Promise<void>;
    }>;
};

type MetaFile = { k: string; m: StoredMeta; t: "s" | "b" };

function dirName(name: string): string {
    return `_${encodeURIComponent(name)}`;
}

function isNotFound(error: unknown): boolean {
    const name = (error as { name?: string } | null)?.name;
    return name === "NotFoundError" || name === "TypeMismatchError";
}

function wrap(error: unknown): Error {
    if ((error as { name?: string } | null)?.name === "QuotaExceededError") {
        return new QuotaExceededError(undefined, error as Error);
    }
    if (error instanceof CacheError) return error;
    return new CacheError(
        (error as Error)?.message ?? "OPFS operation failed",
        "TX_FAILED",
        error as Error
    );
}

/** A file replaced while we read it (another tab wrote it) — worth retrying. */
function isTransient(error: unknown): boolean {
    const name = (error as { name?: string } | null)?.name;
    return name === "NotReadableError" || name === "InvalidStateError";
}

async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isOPFSSupported(): boolean {
    return (
        typeof navigator !== "undefined" &&
        typeof navigator.storage?.getDirectory === "function" &&
        typeof FileSystemFileHandle !== "undefined" &&
        typeof (FileSystemFileHandle.prototype as Partial<FileHandle>).createWritable === "function"
    );
}

export class OPFSAdapter implements StorageAdapter {
    readonly kind = "opfs";
    readonly persistent = true;
    private rootPromise: Promise<DirHandle> | null = null;

    constructor(
        readonly dbName = "cache-db",
        readonly storeName = "cache"
    ) {}

    private root(): Promise<DirHandle> {
        if (!isOPFSSupported()) {
            return Promise.reject(
                new UnsupportedEnvironmentError(
                    "The Origin Private File System (with createWritable) is not available here"
                )
            );
        }
        if (!this.rootPromise) {
            this.rootPromise = (async () => {
                let dir = (await navigator.storage.getDirectory()) as DirHandle;
                for (const part of ["cachecraft", dirName(this.dbName), dirName(this.storeName)]) {
                    dir = (await dir.getDirectoryHandle(part, { create: true })) as DirHandle;
                }
                return dir;
            })();
            this.rootPromise.catch(() => {
                this.rootPromise = null;
            });
        }
        return this.rootPromise;
    }

    private async nsDir(namespace: string, create: boolean): Promise<DirHandle | undefined> {
        try {
            return (await (
                await this.root()
            ).getDirectoryHandle(dirName(namespace), {
                create,
            })) as DirHandle;
        } catch (error) {
            if (isNotFound(error)) return undefined;
            throw wrap(error);
        }
    }

    private lockName(namespace: string): string {
        return `cachecraft-opfs:${this.dbName}:${this.storeName}:${namespace}`;
    }

    private async readFile<T>(
        dir: DirHandle,
        name: string,
        read: (file: File) => Promise<T>
    ): Promise<T | undefined> {
        for (let attempt = 0; ; attempt++) {
            try {
                const handle = await dir.getFileHandle(name);
                return await read(await handle.getFile());
            } catch (error) {
                if (isNotFound(error)) return undefined;
                if (isTransient(error) && attempt < 5) {
                    await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
                    continue;
                }
                throw wrap(error);
            }
        }
    }

    private readText(dir: DirHandle, name: string): Promise<string | undefined> {
        return this.readFile(dir, name, (file) => file.text());
    }

    private readBytes(dir: DirHandle, name: string): Promise<Uint8Array | undefined> {
        return this.readFile(dir, name, async (file) => new Uint8Array(await file.arrayBuffer()));
    }

    /** Reads hold the namespace lock in shared mode: never interleaved with a write. */
    private reading<T>(namespace: string, fn: () => Promise<T>): Promise<T> {
        return withWebLock(this.lockName(namespace), fn, { mode: "shared" });
    }

    private async writeFile(
        dir: DirHandle,
        name: string,
        data: BufferSource | string
    ): Promise<void> {
        try {
            const handle = (await dir.getFileHandle(name, { create: true })) as FileHandle;
            const writable = await handle.createWritable();
            await writable.write(data);
            await writable.close();
        } catch (error) {
            throw wrap(error);
        }
    }

    private async remove(dir: DirHandle, name: string): Promise<boolean> {
        try {
            await dir.removeEntry(name);
            return true;
        } catch (error) {
            if (isNotFound(error)) return false;
            throw wrap(error);
        }
    }

    private async readMetaFile(dir: DirHandle, hash: string): Promise<MetaFile | undefined> {
        const text = await this.readText(dir, `${hash}.m`);
        if (text === undefined) return undefined;
        try {
            return JSON.parse(text) as MetaFile;
        } catch {
            return undefined; // torn write — treat as missing
        }
    }

    loadMeta(namespace: string): Promise<Array<[string, StoredMeta]>> {
        return this.reading(namespace, () => this.loadMetaUnlocked(namespace));
    }

    private async loadMetaUnlocked(namespace: string): Promise<Array<[string, StoredMeta]>> {
        const dir = await this.nsDir(namespace, false);
        if (!dir) return [];
        const out: Array<[string, StoredMeta]> = [];
        for await (const [name] of dir.entries()) {
            if (!name.endsWith(".m")) continue;
            const file = await this.readMetaFile(dir, name.slice(0, -2));
            if (file) out.push([file.k, file.m]);
        }
        return out;
    }

    getMeta(namespace: string, keys: readonly string[]): Promise<Map<string, StoredMeta>> {
        return this.reading(namespace, () => this.getMetaUnlocked(namespace, keys));
    }

    private async getMetaUnlocked(
        namespace: string,
        keys: readonly string[]
    ): Promise<Map<string, StoredMeta>> {
        const out = new Map<string, StoredMeta>();
        const dir = await this.nsDir(namespace, false);
        if (!dir) return out;
        for (const key of keys) {
            const file = await this.readMetaFile(dir, await sha256Hex(key));
            if (file?.k === key) out.set(key, file.m);
        }
        return out;
    }

    get(namespace: string, keys: readonly string[]): Promise<Map<string, StoredRecord>> {
        return this.reading(namespace, () => this.getUnlocked(namespace, keys));
    }

    private async getUnlocked(
        namespace: string,
        keys: readonly string[]
    ): Promise<Map<string, StoredRecord>> {
        const out = new Map<string, StoredRecord>();
        const dir = await this.nsDir(namespace, false);
        if (!dir) return out;
        for (const key of keys) {
            const hash = await sha256Hex(key);
            const file = await this.readMetaFile(dir, hash);
            if (file?.k !== key) continue;
            const bytes = await this.readBytes(dir, `${hash}.d`);
            if (!bytes) continue;
            const payload: StoredPayload = file.t === "s" ? new TextDecoder().decode(bytes) : bytes;
            out.set(key, { meta: file.m, payload });
        }
        return out;
    }

    async write(namespace: string, ops: readonly WriteOp[]): Promise<WriteResult> {
        const result: WriteResult = { deleted: [] };
        if (ops.length === 0) return result;
        await withWebLock(this.lockName(namespace), async () => {
            const dir = (await this.nsDir(namespace, true)) as DirHandle;
            for (const op of ops) {
                const hash = await sha256Hex(op.key);
                switch (op.type) {
                    case "put": {
                        const isString = typeof op.payload === "string";
                        await this.writeFile(dir, `${hash}.d`, op.payload as BufferSource | string);
                        const file: MetaFile = { k: op.key, m: op.meta, t: isString ? "s" : "b" };
                        await this.writeFile(dir, `${hash}.m`, JSON.stringify(file));
                        break;
                    }
                    case "delete": {
                        // Metadata first: a record without metadata is invisible.
                        if (await this.remove(dir, `${hash}.m`)) result.deleted.push(op.key);
                        await this.remove(dir, `${hash}.d`);
                        break;
                    }
                    case "deleteIfExpired": {
                        const file = await this.readMetaFile(dir, hash);
                        if (file && isExpired(file.m.expiresAt, op.now)) {
                            await this.remove(dir, `${hash}.m`);
                            await this.remove(dir, `${hash}.d`);
                            result.deleted.push(op.key);
                        }
                        break;
                    }
                    case "touch": {
                        const file = await this.readMetaFile(dir, hash);
                        if (!file) break;
                        const meta = file.m;
                        if (op.lastAccessed !== undefined) {
                            meta.lastAccessed = Math.max(meta.lastAccessed, op.lastAccessed);
                        }
                        if (op.accessDelta) meta.accessCount += op.accessDelta;
                        if (op.expiresAt === null) delete meta.expiresAt;
                        else if (op.expiresAt !== undefined) meta.expiresAt = op.expiresAt;
                        await this.writeFile(dir, `${hash}.m`, JSON.stringify(file));
                        break;
                    }
                }
            }
        });
        return result;
    }

    async clear(namespace: string): Promise<void> {
        await withWebLock(this.lockName(namespace), async () => {
            try {
                await (await this.root()).removeEntry(dirName(namespace), { recursive: true });
            } catch (error) {
                if (!isNotFound(error)) throw wrap(error);
            }
        });
    }

    private async readSystem(): Promise<Record<string, unknown>> {
        const text = await this.readText(await this.root(), "system.json");
        if (text === undefined) return {};
        try {
            return JSON.parse(text) as Record<string, unknown>;
        } catch {
            return {};
        }
    }

    async getSystem(key: string): Promise<unknown> {
        return (await this.readSystem())[key];
    }

    async initSystem(key: string, create: () => unknown): Promise<unknown> {
        return withWebLock(`cachecraft-opfs:${this.dbName}:${this.storeName}:system`, async () => {
            const system = await this.readSystem();
            if (system[key] === undefined) {
                system[key] = create();
                await this.writeFile(await this.root(), "system.json", JSON.stringify(system));
            }
            return system[key];
        });
    }

    close(): void {
        this.rootPromise = null;
    }
}
