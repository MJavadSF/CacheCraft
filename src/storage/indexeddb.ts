import { CacheError, QuotaExceededError, UnsupportedEnvironmentError } from "../errors";
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
// IndexedDB adapter
//
// Layout (per logical store `S` inside database `D`):
//   "S::data"        payloads       key = [namespace, key]
//   "S::meta"        metadata       key = [namespace, key]
//   "__cachecraft__" system values  key = string (shared by all stores of D)
//   "S"              ≤0.5 records   key = "namespace:key" (read-only, migrated lazily)
//
// Array keys make namespaces exact: [ns] … [ns, []] bounds every key of `ns` and
// nothing else (arrays sort after strings), so "a" never sees "a:b"'s records.
//
// Object stores are created on demand: when one is missing the adapter re-opens
// the database with `version + 1` (no manual `version` bookkeeping, and several
// logical stores can share a database). Other connections are released on
// `versionchange` and transparently re-open.
// ==============================

export const SYSTEM_STORE = "__cachecraft__";

export function hasIndexedDB(): boolean {
    return typeof indexedDB !== "undefined";
}

function nsRange(namespace: string): IDBKeyRange {
    return IDBKeyRange.bound([namespace], [namespace, []]);
}

function wrapError(error: DOMException | Error | null | undefined): Error {
    if (error?.name === "QuotaExceededError") {
        return new QuotaExceededError(undefined, error);
    }
    if (error instanceof CacheError) return error;
    return new CacheError(
        error?.message || "IndexedDB transaction failed",
        "TX_FAILED",
        error ?? undefined
    );
}

function openRequest(
    name: string,
    version: number | undefined,
    required: readonly string[],
    onBlocked: () => void
): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let req: IDBOpenDBRequest;
        try {
            req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
        } catch (error) {
            reject(error);
            return;
        }
        req.onupgradeneeded = () => {
            const db = req.result;
            for (const store of required) {
                if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = onBlocked;
    });
}

export class IndexedDBAdapter implements StorageAdapter {
    readonly kind = "indexeddb";
    readonly persistent = true;

    private dbPromise: Promise<IDBDatabase> | null = null;
    private legacyCount: number | null = null;
    private readonly dataStore: string;
    private readonly metaStore: string;
    private readonly blockedListeners = new Set<() => void>();

    constructor(
        readonly dbName: string,
        readonly storeName: string
    ) {
        this.dataStore = `${storeName}::data`;
        this.metaStore = `${storeName}::meta`;
    }

    /** Called when an upgrade waits on a connection another tab doesn't release. */
    onBlocked(listener: () => void): () => void {
        this.blockedListeners.add(listener);
        return () => this.blockedListeners.delete(listener);
    }

    private get required(): string[] {
        return [this.dataStore, this.metaStore, SYSTEM_STORE];
    }

    private emitBlocked = (): void => {
        for (const listener of this.blockedListeners) {
            try {
                listener();
            } catch {
                /* ignore */
            }
        }
    };

    private open(): Promise<IDBDatabase> {
        if (!hasIndexedDB()) {
            return Promise.reject(
                new UnsupportedEnvironmentError(
                    "IndexedDB is not available here (server-side rendering?). Create the cache " +
                        "on the client only (createClientCache / getSharedCache), or use " +
                        '`storage: "memory"`.'
                )
            );
        }
        if (!this.dbPromise) {
            const promise = this.connect();
            this.dbPromise = promise;
            promise.then(
                (db) => {
                    const drop = (): void => {
                        if (this.dbPromise === promise) this.dbPromise = null;
                    };
                    db.onclose = drop;
                    // Another connection wants to upgrade: release ours, re-open lazily.
                    db.onversionchange = () => {
                        db.close();
                        drop();
                    };
                },
                () => {
                    if (this.dbPromise === promise) this.dbPromise = null;
                }
            );
        }
        return this.dbPromise;
    }

    private async connect(): Promise<IDBDatabase> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 6; attempt++) {
            const db = await openRequest(this.dbName, undefined, this.required, this.emitBlocked);
            const missing = this.required.filter((s) => !db.objectStoreNames.contains(s));
            if (missing.length === 0) return db;
            const next = db.version + 1;
            db.close();
            try {
                const upgraded = await openRequest(
                    this.dbName,
                    next,
                    this.required,
                    this.emitBlocked
                );
                if (this.required.every((s) => upgraded.objectStoreNames.contains(s))) {
                    return upgraded;
                }
                upgraded.close();
            } catch (error) {
                // Another tab upgraded first — re-read the version and try again.
                if ((error as DOMException | null)?.name !== "VersionError")
                    throw wrapError(error as Error);
                lastError = error;
            }
        }
        throw wrapError(lastError as Error);
    }

    /**
     * Run one transaction. `fn` registers requests and returns a function that
     * produces the result once the transaction has COMMITTED.
     */
    private async run<T>(
        stores: readonly string[],
        mode: IDBTransactionMode,
        fn: (tx: IDBTransaction) => () => T,
        retry = true
    ): Promise<T> {
        const db = await this.open();
        let tx: IDBTransaction;
        try {
            tx = db.transaction(stores as string[], mode);
        } catch (error) {
            // The connection closed under us (versionchange) — re-open once.
            if (retry && (error as DOMException).name === "InvalidStateError") {
                if (this.dbPromise) this.dbPromise = null;
                return this.run(stores, mode, fn, false);
            }
            throw wrapError(error as Error);
        }
        return new Promise<T>((resolve, reject) => {
            let result: () => T;
            try {
                result = fn(tx);
            } catch (error) {
                try {
                    tx.abort();
                } catch {
                    /* already finished */
                }
                reject(error);
                return;
            }
            tx.oncomplete = () => {
                try {
                    resolve(result());
                } catch (error) {
                    reject(error);
                }
            };
            tx.onerror = () => reject(wrapError(tx.error));
            tx.onabort = () => reject(wrapError(tx.error));
        });
    }

    /**
     * Read-only work resolves as soon as its requests succeed — no need to wait for
     * the transaction's `complete` event (that's only meaningful for writes).
     */
    private async read<T>(
        stores: readonly string[],
        fn: (tx: IDBTransaction) => IDBRequest[],
        result: () => T,
        retry = true
    ): Promise<T> {
        const db = await this.open();
        let tx: IDBTransaction;
        try {
            tx = db.transaction(stores as string[], "readonly");
        } catch (error) {
            if (retry && (error as DOMException).name === "InvalidStateError") {
                if (this.dbPromise) this.dbPromise = null;
                return this.read(stores, fn, result, false);
            }
            throw wrapError(error as Error);
        }
        const requests = fn(tx);
        if (requests.length === 0) return result();
        return new Promise<T>((resolve, reject) => {
            let pending = requests.length;
            const fail = (): void =>
                reject(wrapError(tx.error ?? requests.find((r) => r.error)?.error));
            for (const req of requests) {
                const onsuccess = req.onsuccess;
                req.onsuccess = (event) => {
                    if (onsuccess)
                        (onsuccess as (this: IDBRequest, ev: Event) => void).call(req, event);
                    if (--pending === 0) {
                        try {
                            resolve(result());
                        } catch (error) {
                            reject(error);
                        }
                    }
                };
                req.onerror = fail;
            }
            tx.onabort = fail;
        });
    }

    async loadMeta(namespace: string): Promise<Array<[string, StoredMeta]>> {
        let keysReq!: IDBRequest<IDBValidKey[]>;
        let valuesReq!: IDBRequest<unknown[]>;
        return this.read(
            [this.metaStore],
            (tx) => {
                const store = tx.objectStore(this.metaStore);
                keysReq = store.getAllKeys(nsRange(namespace));
                valuesReq = store.getAll(nsRange(namespace));
                return [keysReq, valuesReq];
            },
            () => {
                const keys = keysReq.result as unknown as Array<[string, string]>;
                const values = valuesReq.result as StoredMeta[];
                return keys.map((k, i): [string, StoredMeta] => [k[1], values[i] as StoredMeta]);
            }
        );
    }

    async getMeta(namespace: string, keys: readonly string[]): Promise<Map<string, StoredMeta>> {
        const out = new Map<string, StoredMeta>();
        if (keys.length === 0) return out;
        return this.read(
            [this.metaStore],
            (tx) => {
                const store = tx.objectStore(this.metaStore);
                return keys.map((key) => {
                    const req = store.get([namespace, key]);
                    req.onsuccess = () => {
                        if (req.result !== undefined) out.set(key, req.result as StoredMeta);
                    };
                    return req;
                });
            },
            () => out
        );
    }

    async get(namespace: string, keys: readonly string[]): Promise<Map<string, StoredRecord>> {
        const out = new Map<string, StoredRecord>();
        if (keys.length === 0) return out;
        const metas = new Map<string, StoredMeta>();
        const payloads = new Map<string, StoredPayload>();
        return this.read(
            [this.dataStore, this.metaStore],
            (tx) => {
                const data = tx.objectStore(this.dataStore);
                const meta = tx.objectStore(this.metaStore);
                const requests: IDBRequest[] = [];
                for (const key of keys) {
                    const m = meta.get([namespace, key]);
                    m.onsuccess = () => {
                        if (m.result !== undefined) metas.set(key, m.result as StoredMeta);
                    };
                    const d = data.get([namespace, key]);
                    d.onsuccess = () => {
                        if (d.result !== undefined) payloads.set(key, d.result as StoredPayload);
                    };
                    requests.push(m, d);
                }
                return requests;
            },
            () => {
                for (const [key, m] of metas) {
                    const payload = payloads.get(key);
                    if (payload !== undefined) out.set(key, { meta: m, payload });
                }
                return out;
            }
        );
    }

    async write(namespace: string, ops: readonly WriteOp[]): Promise<WriteResult> {
        const result: WriteResult = { deleted: [] };
        if (ops.length === 0) return result;
        return this.run([this.dataStore, this.metaStore], "readwrite", (tx) => {
            const data = tx.objectStore(this.dataStore);
            const meta = tx.objectStore(this.metaStore);
            for (const op of ops) {
                const id = [namespace, op.key];
                switch (op.type) {
                    case "put":
                        data.put(op.payload, id);
                        meta.put(op.meta, id);
                        break;
                    case "delete": {
                        const req = meta.getKey(id);
                        req.onsuccess = () => {
                            if (req.result !== undefined) result.deleted.push(op.key);
                        };
                        data.delete(id);
                        meta.delete(id);
                        break;
                    }
                    case "deleteIfExpired": {
                        const req = meta.get(id);
                        req.onsuccess = () => {
                            const stored = req.result as StoredMeta | undefined;
                            if (!stored || isExpired(stored.expiresAt, op.now)) {
                                data.delete(id);
                                meta.delete(id);
                                if (stored) result.deleted.push(op.key);
                            }
                        };
                        break;
                    }
                    case "touch": {
                        const req = meta.get(id);
                        req.onsuccess = () => {
                            const stored = req.result as StoredMeta | undefined;
                            if (!stored) return;
                            if (op.lastAccessed !== undefined) {
                                stored.lastAccessed = Math.max(
                                    stored.lastAccessed,
                                    op.lastAccessed
                                );
                            }
                            if (op.accessDelta) stored.accessCount += op.accessDelta;
                            if (op.expiresAt === null) delete stored.expiresAt;
                            else if (op.expiresAt !== undefined) stored.expiresAt = op.expiresAt;
                            meta.put(stored, id);
                        };
                        break;
                    }
                }
            }
            return () => result;
        });
    }

    async clear(namespace: string): Promise<void> {
        await this.run([this.dataStore, this.metaStore], "readwrite", (tx) => {
            tx.objectStore(this.dataStore).delete(nsRange(namespace));
            tx.objectStore(this.metaStore).delete(nsRange(namespace));
            return () => undefined;
        });
    }

    private systemKey(key: string): string {
        return `${this.storeName}::${key}`;
    }

    async getSystem(key: string): Promise<unknown> {
        let req!: IDBRequest;
        return this.read(
            [SYSTEM_STORE],
            (tx) => {
                req = tx.objectStore(SYSTEM_STORE).get(this.systemKey(key));
                return [req];
            },
            () => req.result as unknown
        );
    }

    async initSystem(key: string, create: () => unknown): Promise<unknown> {
        return this.run([SYSTEM_STORE], "readwrite", (tx) => {
            const store = tx.objectStore(SYSTEM_STORE);
            const id = this.systemKey(key);
            let value: unknown;
            const req = store.get(id);
            req.onsuccess = () => {
                value = req.result;
                if (value === undefined) {
                    value = create();
                    store.put(value, id);
                }
            };
            return () => value;
        });
    }

    // ------------------------------
    // ≤0.5 data
    // ------------------------------

    private async hasLegacyStore(): Promise<boolean> {
        const db = await this.open();
        return db.objectStoreNames.contains(this.storeName);
    }

    async hasLegacy(): Promise<boolean> {
        if (this.legacyCount === null) {
            if (!(await this.hasLegacyStore())) {
                this.legacyCount = 0;
            } else {
                this.legacyCount = await this.run([this.storeName], "readonly", (tx) => {
                    const req = tx.objectStore(this.storeName).count();
                    return () => req.result;
                });
            }
        }
        return this.legacyCount > 0;
    }

    async legacyKeys(): Promise<string[]> {
        if (!(await this.hasLegacy())) return [];
        return this.run([this.storeName], "readonly", (tx) => {
            const req = tx.objectStore(this.storeName).getAllKeys();
            return () => (req.result as IDBValidKey[]).map(String);
        });
    }

    async migrateLegacy(
        namespace: string,
        key: string,
        convert: (legacy: unknown) => StoredRecord | undefined
    ): Promise<StoredRecord | undefined> {
        if (!(await this.hasLegacy())) return undefined;
        const legacyKey = namespace ? `${namespace}:${key}` : key;
        const moved = await this.run(
            [this.storeName, this.dataStore, this.metaStore],
            "readwrite",
            (tx) => {
                let record: StoredRecord | undefined;
                let found = false;
                const legacy = tx.objectStore(this.storeName);
                const req = legacy.get(legacyKey);
                req.onsuccess = () => {
                    if (req.result === undefined) return;
                    found = true;
                    legacy.delete(legacyKey);
                    record = convert(req.result);
                    if (!record) return;
                    const id = [namespace, key];
                    // Never overwrite a record already written in the new layout.
                    const existing = tx.objectStore(this.metaStore).getKey(id);
                    existing.onsuccess = () => {
                        if (existing.result !== undefined || !record) {
                            record = undefined;
                            return;
                        }
                        tx.objectStore(this.dataStore).put(record.payload, id);
                        tx.objectStore(this.metaStore).put(record.meta, id);
                    };
                };
                return () => ({ found, record });
            }
        );
        if (moved.found && this.legacyCount !== null) {
            this.legacyCount = Math.max(this.legacyCount - 1, 0);
        }
        return moved.record;
    }

    async dropLegacy(): Promise<number> {
        if (!(await this.hasLegacy())) return 0;
        const count = this.legacyCount ?? 0;
        await this.run([this.storeName], "readwrite", (tx) => {
            tx.objectStore(this.storeName).clear();
            return () => undefined;
        });
        this.legacyCount = 0;
        return count;
    }

    close(): void {
        const pending = this.dbPromise;
        this.dbPromise = null;
        pending?.then((db) => db.close()).catch(() => undefined);
    }
}
