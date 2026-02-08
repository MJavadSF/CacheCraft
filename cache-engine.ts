// cache-engine.ts

// ==============================
// Types
// ==============================
export type CacheEntry<T = any> = {
    value: T | string | Uint8Array;
    isEncoded: boolean;
    isCompressed: boolean;
    createdAt: number;
    lastAccessed: number;
    expiresAt?: number;
    size: number;
};

export type CacheSetOptions = {
    ttl?: number;
    encode?: boolean;
    forceCompress?: boolean;
};

export type CacheGetOptions<T> = {
    staleWhileRevalidate?: boolean;
    revalidate?: () => Promise<T>;
    ttlOnRevalidate?: number;
};

export type CacheConfig = {
    dbName?: string;
    version?: number;
    storeName?: string;
    maxSize?: number;
    compressionThreshold?: number;
    namespace?: string;
};

// ==============================
// Utils
// ==============================
function isClient() {
    return (
        typeof window !== "undefined" &&
        "indexedDB" in window &&
        "CompressionStream" in window
    );
}

async function compress(data: string): Promise<Uint8Array> {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    await writer.write(new TextEncoder().encode(data));
    await writer.close();
    const out = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(out);
}

async function decompress(data: Uint8Array): Promise<string> {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    // @ts-ignore
    await writer.write(data);
    await writer.close();
    const out = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(out);
}

function encode(v: any) {
    return btoa(encodeURIComponent(JSON.stringify(v)));
}

function decode(v: string) {
    return JSON.parse(decodeURIComponent(atob(v)));
}

// ==============================
// Cache Engine
// ==============================
export class CacheEngine {
    private dbPromise: Promise<IDBDatabase> | null = null;
    private config: Required<CacheConfig>;

    constructor(cfg?: CacheConfig) {
        this.config = {
            dbName: cfg?.dbName ?? "cache-db",
            version: cfg?.version ?? 1,
            storeName: cfg?.storeName ?? "cache",
            maxSize: cfg?.maxSize ?? 100 * 1024 * 1024,
            compressionThreshold: cfg?.compressionThreshold ?? 10 * 1024,
            namespace: cfg?.namespace ?? "",
        };
    }

    // ==============================
    // DB
    // ==============================
    private async getDB(): Promise<IDBDatabase> {
        if (!isClient()) throw new Error("IndexedDB unsupported");

        if (!this.dbPromise) {
            this.dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(
                    this.config.dbName,
                    this.config.version
                );

                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(this.config.storeName)) {
                        db.createObjectStore(this.config.storeName);
                    }
                };

                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }

        return this.dbPromise;
    }

    private async tx<T>(
        mode: IDBTransactionMode,
        fn: (store: IDBObjectStore) => IDBRequest | void
    ): Promise<T> {
        const db = await this.getDB();
        const tx = db.transaction(this.config.storeName, mode);
        const store = tx.objectStore(this.config.storeName);

        return new Promise((resolve, reject) => {
            let result: any;

            try {
                const req = fn(store);
                if (req) req.onsuccess = () => (result = req.result);
            } catch (e) {
                reject(e);
            }

            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
        });
    }

    // ==============================
    // Helpers
    // ==============================
    private k(key: string) {
        return this.config.namespace
            ? `${this.config.namespace}:${key}`
            : key;
    }

    private async getRaw(key: string) {
        return this.tx<CacheEntry>("readonly", s => s.get(this.k(key)));
    }

    private async putRaw(key: string, val: CacheEntry) {
        return this.tx("readwrite", s => s.put(val, this.k(key)));
    }

    private async deleteRaw(key: string) {
        return this.tx("readwrite", s => s.delete(this.k(key)));
    }

    // ==============================
    // Eviction (LRU)
    // ==============================
    private async evict() {
        const db = await this.getDB();
        const tx = db.transaction(this.config.storeName, "readonly");
        const store = tx.objectStore(this.config.storeName);

        const entries: any[] = [];

        await new Promise<void>(res => {
            store.openCursor().onsuccess = (e: any) => {
                const c = e.target.result;
                if (!c) return res();

                entries.push({
                    key: c.key,
                    size: c.value.size,
                    last: c.value.lastAccessed,
                });

                c.continue();
            };
        });

        let total = entries.reduce((s, e) => s + e.size, 0);

        if (total <= this.config.maxSize) return;

        entries.sort((a, b) => a.last - b.last);

        for (const e of entries) {
            if (total <= this.config.maxSize) break;
            await this.deleteRaw(e.key);
            total -= e.size;
        }
    }

    // ==============================
    // Public API
    // ==============================
    async set<T>(
        key: string,
        value: T,
        opt?: CacheSetOptions
    ) {
        const json = JSON.stringify(value);

        let final: string | Uint8Array = json;
        let size = new Blob([json]).size;
        let compressed = false;

        if (
            opt?.forceCompress ||
            size > this.config.compressionThreshold
        ) {
            final = await compress(json);
            size = final.byteLength;
            compressed = true;
        } else if (opt?.encode) {
            final = encode(value);
            size = new Blob([final]).size;
        }

        const entry: CacheEntry = {
            value: final,
            isEncoded: opt?.encode ?? false,
            isCompressed: compressed,
            createdAt: Date.now(),
            lastAccessed: Date.now(),
            expiresAt: opt?.ttl
                ? Date.now() + opt.ttl
                : undefined,
            size,
        };

        await this.putRaw(key, entry);
        await this.evict();
    }

    async get<T>(
        key: string,
        opt?: CacheGetOptions<T>
    ): Promise<T | null> {
        const entry = await this.getRaw(key);
        if (!entry) return null;

        const now = Date.now();
        const expired =
            entry.expiresAt && now > entry.expiresAt;

        if (!expired)
            entry.lastAccessed = now;

        if (expired && opt?.staleWhileRevalidate && opt.revalidate) {
            opt.revalidate().then(v =>
                this.set(key, v, {
                    ttl: opt.ttlOnRevalidate,
                })
            );
        }

        if (expired && !opt?.staleWhileRevalidate) {
            await this.deleteRaw(key);
            return null;
        }

        let v: any = entry.value;

        if (entry.isCompressed)
            v = await decompress(v as Uint8Array);

        if (entry.isEncoded)
            v = decode(v as string);

        return typeof v === "string"
            ? JSON.parse(v)
            : v;
    }

    async remove(key: string) {
        await this.deleteRaw(key);
    }

    async clear() {
        await this.tx("readwrite", s => s.clear());
    }

    namespace(ns: string) {
        return new CacheEngine({
            ...this.config,
            namespace: ns,
        });
    }
}
