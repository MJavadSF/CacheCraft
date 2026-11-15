import { isExpired } from "../time";
import type { StorageAdapter, StoredMeta, StoredRecord, WriteOp, WriteResult } from "./types";

// ==============================
// In-memory adapter
//
// Not persistent. Useful for tests, Node/edge runtimes and as an explicit
// fallback. Data is shared by every adapter with the same (dbName, storeName)
// in this JS realm — mirroring how IndexedDB behaves — until `reset()`.
//
// ⚠️ On a server, a module-level memory cache is shared by ALL requests/users.
// Never cache per-user data in it during SSR.
// ==============================

type Space = {
    namespaces: Map<string, Map<string, StoredRecord>>;
    system: Map<string, unknown>;
};

const spaces = new Map<string, Space>();

function copyMeta(meta: StoredMeta): StoredMeta {
    return typeof structuredClone === "function"
        ? structuredClone(meta)
        : { ...meta, tags: meta.tags ? [...meta.tags] : undefined };
}

export class MemoryAdapter implements StorageAdapter {
    readonly kind = "memory";
    readonly persistent = false;
    private readonly id: string;

    constructor(
        readonly dbName = "cache-db",
        readonly storeName = "cache"
    ) {
        this.id = `${dbName}\u0000${storeName}`;
    }

    /** Resolved per call so `reset()` takes effect for live adapters too. */
    private get space(): Space {
        let space = spaces.get(this.id);
        if (!space) {
            space = { namespaces: new Map(), system: new Map() };
            spaces.set(this.id, space);
        }
        return space;
    }

    /** Drop the in-memory data of one database (or of all of them). */
    static reset(dbName?: string): void {
        if (dbName === undefined) {
            spaces.clear();
            return;
        }
        for (const id of [...spaces.keys()]) {
            if (id.startsWith(`${dbName}\u0000`)) spaces.delete(id);
        }
    }

    private ns(namespace: string): Map<string, StoredRecord> {
        let map = this.space.namespaces.get(namespace);
        if (!map) {
            map = new Map();
            this.space.namespaces.set(namespace, map);
        }
        return map;
    }

    async loadMeta(namespace: string): Promise<Array<[string, StoredMeta]>> {
        return Array.from(this.ns(namespace), ([key, r]) => [key, copyMeta(r.meta)]);
    }

    async getMeta(namespace: string, keys: readonly string[]): Promise<Map<string, StoredMeta>> {
        const map = this.ns(namespace);
        const out = new Map<string, StoredMeta>();
        for (const key of keys) {
            const r = map.get(key);
            if (r) out.set(key, copyMeta(r.meta));
        }
        return out;
    }

    async get(namespace: string, keys: readonly string[]): Promise<Map<string, StoredRecord>> {
        const map = this.ns(namespace);
        const out = new Map<string, StoredRecord>();
        for (const key of keys) {
            const r = map.get(key);
            if (r) out.set(key, { meta: copyMeta(r.meta), payload: r.payload });
        }
        return out;
    }

    async write(namespace: string, ops: readonly WriteOp[]): Promise<WriteResult> {
        const map = this.ns(namespace);
        const result: WriteResult = { deleted: [] };
        for (const op of ops) {
            switch (op.type) {
                case "put":
                    map.set(op.key, { meta: copyMeta(op.meta), payload: op.payload });
                    break;
                case "delete":
                    if (map.delete(op.key)) result.deleted.push(op.key);
                    break;
                case "deleteIfExpired": {
                    const r = map.get(op.key);
                    if (r && isExpired(r.meta.expiresAt, op.now)) {
                        map.delete(op.key);
                        result.deleted.push(op.key);
                    }
                    break;
                }
                case "touch": {
                    const r = map.get(op.key);
                    if (!r) break;
                    if (op.lastAccessed !== undefined) {
                        r.meta.lastAccessed = Math.max(r.meta.lastAccessed, op.lastAccessed);
                    }
                    if (op.accessDelta) r.meta.accessCount += op.accessDelta;
                    if (op.expiresAt === null) delete r.meta.expiresAt;
                    else if (op.expiresAt !== undefined) r.meta.expiresAt = op.expiresAt;
                    break;
                }
            }
        }
        return result;
    }

    async clear(namespace: string): Promise<void> {
        this.space.namespaces.delete(namespace);
    }

    async getSystem(key: string): Promise<unknown> {
        return this.space.system.get(key);
    }

    async initSystem(key: string, create: () => unknown): Promise<unknown> {
        if (!this.space.system.has(key)) this.space.system.set(key, create());
        return this.space.system.get(key);
    }

    close(): void {
        /* nothing to release */
    }
}
