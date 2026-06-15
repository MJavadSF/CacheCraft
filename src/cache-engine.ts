import {
    CacheConfig,
    CacheEntry,
    CacheEntryMeta,
    CacheGetOptions,
    CacheSetOptions,
    GetOrSetOptions,
    CachePlugin,
    CacheEvent,
    CacheEventData,
    CacheEventListener,
    CacheStats,
    DetailedStats,
    CacheQuery,
    QueryResult,
    BatchSetItem,
    BatchGetItem,
    BatchResult,
    ExportOptions,
    ImportOptions,
    ExportData,
    CacheEntryWithKey,
    SyncMessage,
    StorageInfo,
    HealthStatus,
} from "./types";
import {
    isSSR,
    isBroadcastChannelSupported,
    compress,
    decompress,
    encode,
    decode,
    EncryptionManager,
    getSize,
    buildKey,
    parseKey,
    matchesPattern,
    isExpired,
    calculateTTL,
    getAge,
    generateId,
    CacheError,
    UnsupportedEnvironmentError,
    PerformanceTimer,
} from "./utils";
import { createEvictionPolicy } from "./eviction";

// ==============================
// CacheCraft Main Engine — v0.4
//
// Key performance design:
//  • An in-memory metadata index (key → CacheEntryMeta) is hydrated once on
//    first DB open. All hot-path decisions (eviction, size, count, keys,
//    query pre-filtering, tag invalidation) read from it instead of scanning
//    IndexedDB and deserializing payloads.
//  • currentSize / entryCount are maintained incrementally.
//  • Read-path access-metadata updates are buffered and flushed on an interval
//    to remove per-read write amplification.
//  • getOrSet provides cache-aside semantics with single-flight (stampede)
//    protection.
// ==============================

export class CacheEngine {
    private dbPromise: Promise<IDBDatabase> | null = null;
    private readonly config: Required<CacheConfig>;
    private encryption: EncryptionManager | null = null;
    private plugins: CachePlugin[] = [];
    private eventListeners: Map<CacheEvent, Set<CacheEventListener>> = new Map();
    private stats: CacheStats;
    private broadcastChannel: BroadcastChannel | null = null;
    private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
    private flushIntervalId: ReturnType<typeof setInterval> | null = null;
    private readonly instanceId: string;
    private readonly startTime: number;

    // --- in-memory indexes (namespaced full keys) ---
    private meta: Map<string, CacheEntryMeta> = new Map();
    private tagIndex: Map<string, Set<string>> = new Map();
    private currentSize = 0;
    private indexReady: Promise<void> | null = null;

    // --- read-path access metadata buffer ---
    private dirtyAccess: Set<string> = new Set();

    // --- single-flight registry for getOrSet (stampede protection) ---
    private inflight: Map<string, Promise<unknown>> = new Map();

    constructor(cfg?: CacheConfig) {
        this.config = {
            dbName:                      cfg?.dbName                      ?? "cache-db",
            version:                     cfg?.version                     ?? 1,
            storeName:                   cfg?.storeName                   ?? "cache",
            maxSize:                     cfg?.maxSize                     ?? 100 * 1024 * 1024,
            compressionThreshold:        cfg?.compressionThreshold        ?? 10 * 1024,
            namespace:                   cfg?.namespace                   ?? "",
            evictionStrategy:            cfg?.evictionStrategy            ?? "lru",
            enableStats:                 cfg?.enableStats                 ?? true,
            enableSync:                  cfg?.enableSync                  ?? false,
            encryptionKey:               cfg?.encryptionKey               ?? "",
            plugins:                     cfg?.plugins                     ?? [],
            onError:                     cfg?.onError                     ?? (() => undefined),
            autoCleanup:                 cfg?.autoCleanup                 ?? true,
            cleanupInterval:             cfg?.cleanupInterval             ?? 60_000,
            persistAccessMetadata:       cfg?.persistAccessMetadata       ?? true,
            accessMetadataFlushInterval: cfg?.accessMetadataFlushInterval ?? 1_000,
            evictionPolicy:              cfg?.evictionPolicy              ?? (undefined as never),
        };

        this.instanceId = generateId();
        this.startTime  = Date.now();
        this.stats      = this.emptyStats();

        if (this.config.encryptionKey) {
            this.encryption = new EncryptionManager();
            this.encryption.initialize(this.config.encryptionKey).catch((err) => {
                this.handleError(new CacheError("Encryption initialization failed", "INIT_ERROR", err as Error));
            });
        }

        this.plugins = [...this.config.plugins];

        if (this.config.enableSync && !isSSR() && isBroadcastChannelSupported()) {
            this.broadcastChannel = new BroadcastChannel(`cachecraft-${this.config.dbName}`);
            this.broadcastChannel.onmessage = (event) =>
                this.handleSyncMessage(event.data as SyncMessage);
        }

        if (!isSSR()) {
            if (this.config.autoCleanup) this.startAutoCleanup();
            if (this.config.persistAccessMetadata) this.startAccessFlush();
        }
    }

    // ==============================
    // Index Hydration
    // ==============================

    /** Build the in-memory meta/tag indexes from IndexedDB exactly once. */
    private ensureIndex(): Promise<void> {
        if (!this.indexReady) {
            this.indexReady = this.getDB().then(
                (db) =>
                    new Promise<void>((resolve, reject) => {
                        const tx    = db.transaction(this.config.storeName, "readonly");
                        const store = tx.objectStore(this.config.storeName);
                        const req   = store.openCursor();

                        req.onsuccess = (e) => {
                            const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
                            if (!cursor) return;
                            const fullKey = cursor.key as string;
                            const entry   = cursor.value as CacheEntry;
                            this.indexEntry(fullKey, entry);
                            cursor.continue();
                        };
                        tx.oncomplete = () => {
                            this.refreshCountStats();
                            resolve();
                        };
                        tx.onerror = () => reject(tx.error);
                    })
            ).catch((err) => {
                // Reset so a later call can retry (e.g. transient SSR import)
                this.indexReady = null;
                throw err;
            });
        }
        return this.indexReady;
    }

    private metaOf(fullKey: string, entry: CacheEntry): CacheEntryMeta {
        return {
            key:          fullKey,
            size:         entry.size,
            createdAt:    entry.createdAt,
            lastAccessed: entry.lastAccessed,
            accessCount:  entry.accessCount ?? 0,
            expiresAt:    entry.expiresAt,
            priority:     entry.priority,
            tags:         entry.tags,
            isCompressed: entry.isCompressed,
            isEncrypted:  entry.isEncrypted ?? false,
            isEncoded:    entry.isEncoded,
        };
    }

    /** Add/replace an entry in the in-memory indexes and adjust currentSize. */
    private indexEntry(fullKey: string, entry: CacheEntry): void {
        const prev = this.meta.get(fullKey);
        if (prev) {
            this.currentSize -= prev.size;
            this.unindexTags(fullKey, prev.tags);
        }
        const m = this.metaOf(fullKey, entry);
        this.meta.set(fullKey, m);
        this.currentSize += m.size;
        this.indexTags(fullKey, m.tags);
    }

    private deindexEntry(fullKey: string): void {
        const prev = this.meta.get(fullKey);
        if (!prev) return;
        this.currentSize -= prev.size;
        this.unindexTags(fullKey, prev.tags);
        this.meta.delete(fullKey);
        this.dirtyAccess.delete(fullKey);
    }

    private indexTags(fullKey: string, tags?: readonly string[]): void {
        if (!tags) return;
        for (const tag of tags) {
            let set = this.tagIndex.get(tag);
            if (!set) { set = new Set(); this.tagIndex.set(tag, set); }
            set.add(fullKey);
        }
    }

    private unindexTags(fullKey: string, tags?: readonly string[]): void {
        if (!tags) return;
        for (const tag of tags) {
            const set = this.tagIndex.get(tag);
            if (set) { set.delete(fullKey); if (set.size === 0) this.tagIndex.delete(tag); }
        }
    }

    // ==============================
    // Core Methods
    // ==============================

    async set<T>(key: string, value: T, opt?: CacheSetOptions): Promise<void> {
        try {
            await this.ensureIndex();

            for (const plugin of this.plugins) {
                if (plugin.beforeSet) {
                    const proceed = await plugin.beforeSet(key, value, opt);
                    if (proceed === false) return;
                }
            }

            const json = JSON.stringify(value);
            let final: string | Uint8Array = json;
            let size = getSize(json);
            let compressed = false;
            let encrypted  = false;
            let encoded    = false;

            if (opt?.forceCompress || size > this.config.compressionThreshold) {
                final      = await compress(json);
                size       = (final as Uint8Array).byteLength;
                compressed = true;
            } else if (opt?.encode) {
                final   = encode(value);
                size    = getSize(final);
                encoded = true;
            }

            if (opt?.encrypt && this.encryption?.isInitialized()) {
                const toEncrypt =
                    typeof final === "string" ? final : JSON.stringify(Array.from(final as Uint8Array));
                final     = await this.encryption.encrypt(toEncrypt);
                size      = (final as Uint8Array).byteLength;
                encrypted = true;
            }

            const entry: CacheEntry = {
                value:        final,
                isEncoded:    encoded,
                isCompressed: compressed,
                isEncrypted:  encrypted,
                createdAt:    Date.now(),
                lastAccessed: Date.now(),
                accessCount:  0,
                expiresAt:    calculateTTL(opt?.ttl),
                size,
                tags:         opt?.tags ?? [],
                metadata:     opt?.metadata,
                priority:     opt?.priority,
            };

            await this.putRaw(key, entry);
            this.indexEntry(this.k(key), entry);
            await this.evict();

            if (this.config.enableStats) {
                this.stats.sets++;
                this.refreshCountStats();
            }

            for (const plugin of this.plugins) {
                if (plugin.afterSet) await plugin.afterSet(key, value, entry, opt);
            }

            this.emit("set", { event: "set", key, value, timestamp: Date.now() });
            opt?.onSet?.(key, value);

            if (this.config.enableSync) {
                this.broadcast({ type: "set", key, value, timestamp: Date.now(), source: this.instanceId });
            }
        } catch (error) {
            this.handleError(error as Error);
            throw error;
        }
    }

    async get<T>(key: string, opt?: CacheGetOptions<T>): Promise<T | null> {
        const timer = new PerformanceTimer();

        try {
            await this.ensureIndex();

            for (const plugin of this.plugins) {
                if (plugin.beforeGet) {
                    const proceed = await plugin.beforeGet(key, opt as CacheGetOptions<unknown>);
                    if (proceed === false) return null;
                }
            }

            const fullKey = this.k(key);
            const m = this.meta.get(fullKey);

            // Fast miss: not in index at all.
            if (!m) {
                if (this.config.enableStats) { this.stats.misses++; this.recomputeRates(); }
                this.emit("miss", { event: "miss", key, timestamp: Date.now() });
                for (const plugin of this.plugins) {
                    if (plugin.afterGet) await plugin.afterGet(key, null, null, opt as CacheGetOptions<unknown>);
                }
                return null;
            }

            const expired = isExpired(m.expiresAt);

            // Stale-while-revalidate: kick off refresh, fall through to serve stale.
            if (expired && opt?.staleWhileRevalidate && opt.revalidate) {
                opt.revalidate()
                    .then((v) => this.set(key, v, { ttl: opt.ttlOnRevalidate }))
                    .catch((err: Error) => this.handleError(err));
            }

            if (expired && !opt?.staleWhileRevalidate) {
                await this.deleteRaw(key);
                this.deindexEntry(fullKey);
                this.emit("expire", { event: "expire", key, timestamp: Date.now() });
                if (this.config.enableStats) { this.stats.misses++; this.refreshCountStats(); }
                return null;
            }

            const entry = await this.getRaw(key);
            if (!entry) {
                // Index/DB drift — heal the index and report a miss.
                this.deindexEntry(fullKey);
                if (this.config.enableStats) { this.stats.misses++; this.refreshCountStats(); }
                this.emit("miss", { event: "miss", key, timestamp: Date.now() });
                return null;
            }

            // Update access metadata (in index immediately; persisted lazily).
            if (opt?.updateAccessTime ?? true) {
                m.lastAccessed   = Date.now();
                m.accessCount    = (m.accessCount ?? 0) + 1;
                entry.lastAccessed = m.lastAccessed;
                entry.accessCount  = m.accessCount;
                if (this.config.persistAccessMetadata) {
                    this.dirtyAccess.add(fullKey);
                } else {
                    // No buffering: skip the write entirely.
                }
            }

            const result = await this.decodeEntry<T>(entry);

            if (this.config.enableStats) {
                this.stats.hits++;
                this.stats.avgAccessTime = (this.stats.avgAccessTime + timer.elapsed()) / 2;
                this.recomputeRates();
            }

            this.emit("hit", { event: "hit", key, value: result, timestamp: Date.now() });
            this.emit("get", { event: "get", key, value: result, timestamp: Date.now() });

            for (const plugin of this.plugins) {
                if (plugin.afterGet) await plugin.afterGet(key, result, entry, opt as CacheGetOptions<unknown>);
            }
            opt?.onGet?.(key, result);

            return result;
        } catch (error) {
            this.handleError(error as Error);
            throw error;
        }
    }

    /**
     * Cache-aside helper: return the cached value, or run `factory`, store the
     * result, and return it. Concurrent calls for the same key share a single
     * factory invocation (stampede / thundering-herd protection).
     */
    async getOrSet<T>(
        key: string,
        factory: () => Promise<T> | T,
        opt?: GetOrSetOptions<T>
    ): Promise<T> {
        await this.ensureIndex();

        const fullKey = this.k(key);
        const m = this.meta.get(fullKey);
        const fresh = m && !isExpired(m.expiresAt);

        if (fresh) {
            const cached = await this.get<T>(key, { updateAccessTime: true });
            if (cached !== null) return cached;
        }

        // Stale-while-revalidate: serve stale now, refresh in background.
        if (m && !fresh && opt?.staleWhileRevalidate) {
            const stale = await this.get<T>(key, { staleWhileRevalidate: true });
            this.runFactory(key, factory, opt).catch((err) => this.handleError(err as Error));
            if (stale !== null) return stale;
        }

        // Single-flight: join an in-progress factory for this key if present.
        const existing = this.inflight.get(fullKey);
        if (existing) return existing as Promise<T>;

        const promise = this.runFactory(key, factory, opt)
            .catch(async (err) => {
                if (opt?.fallbackToStale) {
                    const stale = await this.getRaw(key)
                        .then((e) => (e ? this.decodeEntry<T>(e) : null))
                        .catch(() => null);
                    if (stale !== null) return stale as T;
                }
                throw err;
            })
            .finally(() => this.inflight.delete(fullKey));

        this.inflight.set(fullKey, promise);
        return promise;
    }

    private async runFactory<T>(
        key: string,
        factory: () => Promise<T> | T,
        opt?: GetOrSetOptions<T>
    ): Promise<T> {
        const value = await factory();
        const setOpt: CacheSetOptions = {};
        if (opt) {
            const { staleWhileRevalidate, ttlOnRevalidate, fallbackToStale, ...rest } = opt;
            Object.assign(setOpt, rest);
        }
        await this.set(key, value, setOpt);
        return value;
    }

    async remove(key: string): Promise<boolean> {
        try {
            await this.ensureIndex();

            for (const plugin of this.plugins) {
                if (plugin.beforeDelete) {
                    const proceed = await plugin.beforeDelete(key);
                    if (proceed === false) return false;
                }
            }

            const fullKey = this.k(key);
            const existed = this.meta.has(fullKey);
            await this.deleteRaw(key);
            this.deindexEntry(fullKey);

            if (this.config.enableStats && existed) {
                this.stats.deletes++;
                this.refreshCountStats();
            }

            for (const plugin of this.plugins) {
                if (plugin.afterDelete) await plugin.afterDelete(key, existed);
            }

            this.emit("delete", { event: "delete", key, timestamp: Date.now() });

            if (this.config.enableSync) {
                this.broadcast({ type: "delete", key, timestamp: Date.now(), source: this.instanceId });
            }

            return existed;
        } catch (error) {
            this.handleError(error as Error);
            return false;
        }
    }

    async clear(): Promise<number> {
        try {
            await this.ensureIndex();

            for (const plugin of this.plugins) {
                if (plugin.beforeClear) {
                    const proceed = await plugin.beforeClear();
                    if (proceed === false) return 0;
                }
            }

            const count = this.meta.size;
            await this.tx("readwrite", (s) => s.clear());

            this.meta.clear();
            this.tagIndex.clear();
            this.dirtyAccess.clear();
            this.currentSize = 0;

            if (this.config.enableStats) {
                this.stats = { ...this.stats, entryCount: 0, totalSize: 0 };
            }

            for (const plugin of this.plugins) {
                if (plugin.afterClear) await plugin.afterClear(count);
            }

            this.emit("clear", { event: "clear", timestamp: Date.now(), metadata: { count } });

            if (this.config.enableSync) {
                this.broadcast({ type: "clear", timestamp: Date.now(), source: this.instanceId });
            }

            return count;
        } catch (error) {
            this.handleError(error as Error);
            return 0;
        }
    }

    namespace(ns: string): CacheEngine {
        return new CacheEngine({ ...this.config, namespace: ns });
    }

    // ==============================
    // Tag invalidation (O(entries-with-tag) via the in-memory tag index)
    // ==============================

    /** Keys (namespace-stripped) currently associated with a tag. */
    async keysByTag(tag: string): Promise<string[]> {
        await this.ensureIndex();
        const set = this.tagIndex.get(tag);
        if (!set) return [];
        return Array.from(set, (fk) => parseKey(fk, this.config.namespace));
    }

    /** Delete every entry carrying the given tag. Returns the count removed. */
    async invalidateByTag(tag: string): Promise<number> {
        await this.ensureIndex();
        const set = this.tagIndex.get(tag);
        if (!set) return 0;
        const fullKeys = Array.from(set);
        let removed = 0;
        for (const fk of fullKeys) {
            const key = parseKey(fk, this.config.namespace);
            if (await this.remove(key)) removed++;
        }
        return removed;
    }

    /** Delete entries matching ANY of the supplied tags. */
    async invalidateByTags(tags: readonly string[]): Promise<number> {
        let removed = 0;
        for (const tag of tags) removed += await this.invalidateByTag(tag);
        return removed;
    }

    allTags(): string[] {
        return Array.from(this.tagIndex.keys());
    }

    // ==============================
    // Blob helpers
    // ==============================

    async setBlob(key: string, blob: Blob, opt?: CacheSetOptions): Promise<void> {
        await this.ensureIndex();
        const uint8 = new Uint8Array(await blob.arrayBuffer());

        const entry: CacheEntry<Uint8Array> = {
            value:        uint8,
            isEncoded:    false,
            isCompressed: false,
            isEncrypted:  false,
            createdAt:    Date.now(),
            lastAccessed: Date.now(),
            accessCount:  0,
            expiresAt:    calculateTTL(opt?.ttl),
            size:         uint8.byteLength,
            tags:         opt?.tags ?? [],
            metadata:     opt?.metadata,
            priority:     opt?.priority,
        };

        await this.putRaw(key, entry as unknown as CacheEntry);
        this.indexEntry(this.k(key), entry as unknown as CacheEntry);
        await this.evict();

        if (this.config.enableStats) { this.stats.sets++; this.refreshCountStats(); }

        for (const plugin of this.plugins) {
            if (plugin.afterSet) await plugin.afterSet(key, blob, entry as unknown as CacheEntry, opt);
        }
        this.emit("set", { event: "set", key, timestamp: Date.now() });

        if (this.config.enableSync) {
            this.broadcast({ type: "set", key, timestamp: Date.now(), source: this.instanceId });
        }
    }

    async getBlob(key: string, type = "application/octet-stream"): Promise<Blob | null> {
        await this.ensureIndex();
        const fullKey = this.k(key);
        const m = this.meta.get(fullKey);
        if (!m) return null;

        if (isExpired(m.expiresAt)) {
            await this.deleteRaw(key);
            this.deindexEntry(fullKey);
            return null;
        }

        const entry = await this.getRaw(key);
        if (!entry) { this.deindexEntry(fullKey); return null; }

        m.lastAccessed = Date.now();
        m.accessCount  = (m.accessCount ?? 0) + 1;
        if (this.config.persistAccessMetadata) this.dirtyAccess.add(fullKey);

        if (entry.value instanceof Uint8Array) {
            return new Blob([entry.value as BlobPart], { type });
        }
        return null;
    }

    // ==============================
    // Decode pipeline (shared by get/query/getOrSet)
    // ==============================

    private async decodeEntry<T>(entry: CacheEntry): Promise<T> {
        let v: unknown = entry.value;

        if (entry.isEncrypted && this.encryption?.isInitialized()) {
            v = await this.encryption.decrypt(v as Uint8Array);
            // If the original payload was compressed bytes serialised as a JSON
            // array string before encryption, restore the Uint8Array.
            if (entry.isCompressed && typeof v === "string") {
                try {
                    const arr = JSON.parse(v as string);
                    if (Array.isArray(arr)) v = new Uint8Array(arr);
                } catch { /* not an array payload — leave as-is */ }
            }
        }

        if (entry.isCompressed) {
            v = await decompress(v as Uint8Array);
        }

        if (entry.isEncoded) {
            v = decode(v as string);
            return v as T;
        }

        return typeof v === "string" ? (JSON.parse(v) as T) : (v as T);
    }

    // ==============================
    // Advanced Methods
    // ==============================

    async has(key: string): Promise<boolean> {
        await this.ensureIndex();
        const fullKey = this.k(key);
        const m = this.meta.get(fullKey);
        if (!m) return false;
        if (isExpired(m.expiresAt)) {
            await this.deleteRaw(key);
            this.deindexEntry(fullKey);
            return false;
        }
        return true;
    }

    /** Total stored bytes (from the in-memory accumulator — O(1)). */
    async size(): Promise<number> {
        await this.ensureIndex();
        return this.currentSize;
    }

    /** Entry count (O(1)). */
    async count(): Promise<number> {
        await this.ensureIndex();
        return this.meta.size;
    }

    async keys(pattern?: RegExp | string): Promise<string[]> {
        await this.ensureIndex();
        let ks = Array.from(this.meta.keys(), (fk) => parseKey(fk, this.config.namespace));
        if (pattern) ks = ks.filter((k) => matchesPattern(k, pattern));
        return ks;
    }

    // ==============================
    // Batch Operations
    // ==============================

    /**
     * Atomically write many entries in a SINGLE IndexedDB transaction.
     * Far faster than N separate writes and all-or-nothing on failure.
     */
    async batchSet<T>(items: BatchSetItem<T>[]): Promise<BatchResult<T>[]> {
        await this.ensureIndex();

        // Prepare entries (compression/encryption) outside the transaction.
        const prepared: { item: BatchSetItem<T>; entry: CacheEntry; ok: boolean; error?: Error }[] = [];
        for (const item of items) {
            try {
                const entry = await this.buildEntry(item.value, item.options);
                prepared.push({ item, entry, ok: true });
            } catch (error) {
                prepared.push({ item, entry: null as never, ok: false, error: error as Error });
            }
        }

        const writable = prepared.filter((p) => p.ok);
        if (writable.length) {
            await this.getDB().then(
                (db) =>
                    new Promise<void>((resolve, reject) => {
                        const tx    = db.transaction(this.config.storeName, "readwrite");
                        const store = tx.objectStore(this.config.storeName);
                        for (const p of writable) store.put(p.entry, this.k(p.item.key));
                        tx.oncomplete = () => resolve();
                        tx.onerror    = () => reject(tx.error);
                        tx.onabort    = () => reject(new CacheError("Batch transaction aborted", "TX_ABORTED"));
                    })
            );

            for (const p of writable) {
                this.indexEntry(this.k(p.item.key), p.entry);
                if (this.config.enableStats) this.stats.sets++;
                this.emit("set", { event: "set", key: p.item.key, value: p.item.value, timestamp: Date.now() });
            }
            await this.evict();
            if (this.config.enableStats) this.refreshCountStats();
        }

        return prepared.map((p) =>
            p.ok
                ? { key: p.item.key, value: p.item.value, success: true }
                : { key: p.item.key, value: null, success: false, error: p.error as Error }
        );
    }

    async batchGet<T>(items: BatchGetItem[]): Promise<BatchResult<T>[]> {
        const settled = await Promise.allSettled(
            items.map((item) => this.get<T>(item.key, item.options as CacheGetOptions<T>))
        );
        return items.map((item, i) => {
            const result = settled[i]!;
            if (result.status === "fulfilled") {
                return { key: item.key, value: result.value, success: true };
            }
            return { key: item.key, value: null, success: false, error: result.reason as Error };
        });
    }

    async batchDelete(keys: string[]): Promise<BatchResult<null>[]> {
        await this.ensureIndex();
        const present = keys.filter((k) => this.meta.has(this.k(k)));

        if (present.length) {
            await this.getDB().then(
                (db) =>
                    new Promise<void>((resolve, reject) => {
                        const tx    = db.transaction(this.config.storeName, "readwrite");
                        const store = tx.objectStore(this.config.storeName);
                        for (const k of present) store.delete(this.k(k));
                        tx.oncomplete = () => resolve();
                        tx.onerror    = () => reject(tx.error);
                    })
            );
            for (const k of present) {
                this.deindexEntry(this.k(k));
                if (this.config.enableStats) this.stats.deletes++;
                this.emit("delete", { event: "delete", key: k, timestamp: Date.now() });
            }
            if (this.config.enableStats) this.refreshCountStats();
        }

        const presentSet = new Set(present);
        return keys.map((key) => ({ key, value: null, success: presentSet.has(key) }));
    }

    /** Read many keys with a single readonly transaction. */
    async getMany<T>(keys: string[]): Promise<Map<string, T | null>> {
        await this.ensureIndex();
        const out = new Map<string, T | null>();

        const raw = await this.getDB().then(
            (db) =>
                new Promise<Map<string, CacheEntry | undefined>>((resolve, reject) => {
                    const tx    = db.transaction(this.config.storeName, "readonly");
                    const store = tx.objectStore(this.config.storeName);
                    const map   = new Map<string, CacheEntry | undefined>();
                    for (const key of keys) {
                        const req = store.get(this.k(key));
                        req.onsuccess = () => map.set(key, req.result as CacheEntry | undefined);
                    }
                    tx.oncomplete = () => resolve(map);
                    tx.onerror    = () => reject(tx.error);
                })
        );

        for (const key of keys) {
            const entry = raw.get(key);
            if (!entry || isExpired(entry.expiresAt)) { out.set(key, null); continue; }
            try { out.set(key, await this.decodeEntry<T>(entry)); }
            catch { out.set(key, null); }
        }
        return out;
    }

    // ==============================
    // Query System
    // ==============================

    async query<T>(query: CacheQuery): Promise<QueryResult<T>[]> {
        await this.ensureIndex();

        // Filter on metadata only — no payload reads until the final hydration.
        let metas = Array.from(this.meta.values());

        if (query.tags?.length) {
            metas = metas.filter((m) => {
                const t = m.tags ?? [];
                return query.tags!.some((tag) => t.includes(tag));
            });
        }
        if (query.minPriority !== undefined)
            metas = metas.filter((m) => (m.priority ?? 0) >= query.minPriority!);
        if (query.maxPriority !== undefined)
            metas = metas.filter((m) => (m.priority ?? 0) <= query.maxPriority!);
        if (query.minAge !== undefined)
            metas = metas.filter((m) => getAge(m.createdAt) >= query.minAge!);
        if (query.maxAge !== undefined)
            metas = metas.filter((m) => getAge(m.createdAt) <= query.maxAge!);
        if (query.minSize !== undefined)
            metas = metas.filter((m) => m.size >= query.minSize!);
        if (query.maxSize !== undefined)
            metas = metas.filter((m) => m.size <= query.maxSize!);
        if (query.minAccessCount !== undefined)
            metas = metas.filter((m) => (m.accessCount ?? 0) >= query.minAccessCount!);
        if (query.pattern)
            metas = metas.filter((m) => matchesPattern(m.key, query.pattern!));
        if (query.expired !== undefined) {
            metas = metas.filter((m) =>
                query.expired ? isExpired(m.expiresAt) : !isExpired(m.expiresAt)
            );
        }

        if (query.sortBy) {
            const dir = query.sortOrder === "desc" ? -1 : 1;
            metas.sort((a, b) => {
                let av: number, bv: number;
                switch (query.sortBy) {
                    case "createdAt":    av = a.createdAt;            bv = b.createdAt;            break;
                    case "lastAccessed": av = a.lastAccessed;         bv = b.lastAccessed;         break;
                    case "accessCount":  av = a.accessCount ?? 0;     bv = b.accessCount ?? 0;     break;
                    case "size":         av = a.size;                 bv = b.size;                 break;
                    case "priority":     av = a.priority ?? 0;        bv = b.priority ?? 0;        break;
                    case "expiresAt":    av = a.expiresAt ?? Infinity; bv = b.expiresAt ?? Infinity; break;
                    default:             av = 0; bv = 0;
                }
                return (av - bv) * dir;
            });
        }

        if (query.offset) metas = metas.slice(query.offset);
        if (query.limit)  metas = metas.slice(0, query.limit);

        // Hydrate only the page of results we actually return.
        const results: QueryResult<T>[] = [];
        for (const m of metas) {
            try {
                const key   = parseKey(m.key, this.config.namespace);
                const entry = await this.getRaw(key);
                if (!entry) continue;
                const value = await this.decodeEntry<T>(entry);
                results.push({ key, value, entry: entry as CacheEntry<T> });
            } catch { /* skip undecodable entries */ }
        }
        return results;
    }

    // ==============================
    // Statistics
    // ==============================

    getStats(): CacheStats {
        return { ...this.stats };
    }

    async getDetailedStats(): Promise<DetailedStats> {
        await this.ensureIndex();
        const metas = Array.from(this.meta.values());

        const entriesByTag: Record<string, number> = {};
        const sizeByTag: Record<string, number>    = {};
        let compressedSize = 0, uncompressedSize = 0, encryptedCount = 0, expiredCount = 0;
        let oldestEntry: number | undefined, newestEntry: number | undefined;
        let mostAccessed: { key: string; count: number } | undefined;
        let largestEntry:  { key: string; size: number } | undefined;

        for (const m of metas) {
            for (const tag of m.tags ?? []) {
                entriesByTag[tag] = (entriesByTag[tag] ?? 0) + 1;
                sizeByTag[tag]    = (sizeByTag[tag]    ?? 0) + m.size;
            }
            if (m.isCompressed) compressedSize += m.size; else uncompressedSize += m.size;
            if (m.isEncrypted) encryptedCount++;
            if (isExpired(m.expiresAt)) expiredCount++;
            if (oldestEntry === undefined || m.createdAt < oldestEntry) oldestEntry = m.createdAt;
            if (newestEntry === undefined || m.createdAt > newestEntry) newestEntry = m.createdAt;

            const accessCount = m.accessCount ?? 0;
            if (!mostAccessed || accessCount > mostAccessed.count)
                mostAccessed = { key: parseKey(m.key, this.config.namespace), count: accessCount };
            if (!largestEntry || m.size > largestEntry.size)
                largestEntry = { key: parseKey(m.key, this.config.namespace), size: m.size };
        }

        const compressionRatio =
            compressedSize > 0 ? uncompressedSize / (compressedSize + uncompressedSize) : 0;

        return {
            ...this.stats,
            entriesByTag, sizeByTag, compressionRatio,
            encryptedCount, expiredCount,
            oldestEntry, newestEntry, mostAccessed, largestEntry,
        };
    }

    resetStats(): void {
        this.stats = this.emptyStats();
        this.refreshCountStats();
    }

    // ==============================
    // Export / Import
    // ==============================

    async export(options?: ExportOptions): Promise<ExportData> {
        await this.ensureIndex();
        const exportEntries: Record<string, CacheEntry> = {};

        for (const m of this.meta.values()) {
            if (!options?.includeExpired && isExpired(m.expiresAt)) continue;
            const key   = parseKey(m.key, this.config.namespace);
            const entry = await this.getRaw(key);
            if (!entry) continue;
            if (options?.filter && !options.filter(key, entry)) continue;
            exportEntries[key] = entry;
        }

        const data: ExportData = { version: "0.4.0", timestamp: Date.now(), entries: exportEntries };
        if (this.config.enableStats) data.stats = this.getStats();
        return data;
    }

    async import(data: ExportData, options?: ImportOptions): Promise<number> {
        await this.ensureIndex();
        let imported = 0;
        for (const [key, entry] of Object.entries(data.entries)) {
            try {
                if (!options?.overwrite && !options?.merge && (await this.has(key))) continue;
                await this.putRaw(key, entry);
                this.indexEntry(this.k(key), entry);
                imported++;
            } catch (error) {
                if (!options?.skipInvalid) throw error;
            }
        }
        if (this.config.enableStats) this.refreshCountStats();
        return imported;
    }

    // ==============================
    // Cleanup & Maintenance
    // ==============================

    async cleanup(): Promise<number> {
        await this.ensureIndex();
        const expired = Array.from(this.meta.values()).filter((m) => isExpired(m.expiresAt));
        if (expired.length === 0) return 0;

        await this.getDB().then(
            (db) =>
                new Promise<void>((resolve, reject) => {
                    const tx    = db.transaction(this.config.storeName, "readwrite");
                    const store = tx.objectStore(this.config.storeName);
                    for (const m of expired) store.delete(m.key);
                    tx.oncomplete = () => resolve();
                    tx.onerror    = () => reject(tx.error);
                })
        );
        for (const m of expired) this.deindexEntry(m.key);
        if (this.config.enableStats) this.refreshCountStats();
        return expired.length;
    }

    private startAutoCleanup(): void {
        if (this.cleanupIntervalId) clearInterval(this.cleanupIntervalId);
        this.cleanupIntervalId = setInterval(() => {
            this.cleanup().catch((err: Error) => this.handleError(err));
        }, this.config.cleanupInterval);
    }

    stopAutoCleanup(): void {
        if (this.cleanupIntervalId) {
            clearInterval(this.cleanupIntervalId);
            this.cleanupIntervalId = null;
        }
    }

    // --- buffered access-metadata flushing ---

    private startAccessFlush(): void {
        if (this.flushIntervalId) clearInterval(this.flushIntervalId);
        this.flushIntervalId = setInterval(() => {
            this.flushAccessMetadata().catch((err: Error) => this.handleError(err));
        }, this.config.accessMetadataFlushInterval);
    }

    /** Persist buffered lastAccessed/accessCount updates in one transaction. */
    async flushAccessMetadata(): Promise<void> {
        if (this.dirtyAccess.size === 0) return;
        const keys = Array.from(this.dirtyAccess);
        this.dirtyAccess.clear();

        await this.getDB().then(
            (db) =>
                new Promise<void>((resolve, reject) => {
                    const tx    = db.transaction(this.config.storeName, "readwrite");
                    const store = tx.objectStore(this.config.storeName);
                    for (const fullKey of keys) {
                        const m = this.meta.get(fullKey);
                        if (!m) continue;
                        const getReq = store.get(fullKey);
                        getReq.onsuccess = () => {
                            const entry = getReq.result as CacheEntry | undefined;
                            if (!entry) return;
                            entry.lastAccessed = m.lastAccessed;
                            entry.accessCount  = m.accessCount;
                            store.put(entry, fullKey);
                        };
                    }
                    tx.oncomplete = () => resolve();
                    tx.onerror    = () => reject(tx.error);
                })
        ).catch((err) => {
            // Re-queue on failure so updates aren't silently lost.
            for (const k of keys) this.dirtyAccess.add(k);
            throw err;
        });
    }

    async getStorageInfo(): Promise<StorageInfo> {
        if (isSSR() || typeof navigator === "undefined" || !navigator.storage?.estimate) {
            return { used: 0, available: 0, total: 0, percentage: 0, canGrow: false };
        }
        const estimate   = await navigator.storage.estimate();
        const used       = estimate.usage ?? 0;
        const total      = estimate.quota ?? 0;
        const available  = total - used;
        const percentage = total > 0 ? used / total : 0;
        return {
            used, available, total, percentage,
            canGrow: typeof navigator.storage.persist === "function"
                ? await navigator.storage.persist()
                : true,
        };
    }

    async getHealth(): Promise<HealthStatus> {
        const issues: string[] = [];
        try {
            await this.ensureIndex();
            const storageInfo = await this.getStorageInfo();
            const currentSize = this.currentSize;
            const entryCount  = this.meta.size;

            if (storageInfo.percentage > 0.9) issues.push("Storage usage above 90%");
            if (currentSize > this.config.maxSize * 0.9) issues.push("Cache size near configured limit");

            return {
                isHealthy: issues.length === 0,
                uptime: Date.now() - this.startTime,
                dbConnected: true,
                size: currentSize,
                entryCount,
                issues,
            };
        } catch (error) {
            return {
                isHealthy: false,
                uptime: Date.now() - this.startTime,
                dbConnected: false,
                size: 0,
                entryCount: 0,
                issues: ["Database connection failed"],
                lastError: error as Error,
            };
        }
    }

    // ==============================
    // Plugin System
    // ==============================

    use(plugin: CachePlugin): void { this.plugins.push(plugin); }

    removePlugin(name: string): boolean {
        const index = this.plugins.findIndex((p) => p.name === name);
        if (index !== -1) { this.plugins.splice(index, 1); return true; }
        return false;
    }

    getPlugins(): CachePlugin[] { return [...this.plugins]; }

    // ==============================
    // Event System
    // ==============================

    on(event: CacheEvent, listener: CacheEventListener): void {
        if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
        this.eventListeners.get(event)!.add(listener);
    }

    off(event: CacheEvent, listener: CacheEventListener): void {
        this.eventListeners.get(event)?.delete(listener);
    }

    once(event: CacheEvent, listener: CacheEventListener): void {
        const onceListener: CacheEventListener = (data) => {
            listener(data);
            this.off(event, onceListener);
        };
        this.on(event, onceListener);
    }

    private emit(event: CacheEvent, data: CacheEventData): void {
        const listeners = this.eventListeners.get(event);
        if (!listeners) return;
        for (const listener of listeners) {
            try { listener(data); } catch (error) { this.handleError(error as Error); }
        }
    }

    // ==============================
    // Sync System
    // ==============================

    private broadcast(message: SyncMessage): void {
        this.broadcastChannel?.postMessage(message);
    }

    private async handleSyncMessage(message: SyncMessage): Promise<void> {
        if (message.source === this.instanceId) return;
        try {
            switch (message.type) {
                case "set":
                    if (message.key) {
                        // Another tab wrote — refresh our index entry for it.
                        const entry = await this.getRaw(message.key);
                        if (entry) {
                            this.indexEntry(this.k(message.key), entry);
                            this.emit("sync", { event: "sync", key: message.key, timestamp: message.timestamp });
                        }
                    }
                    break;
                case "delete":
                    if (message.key) {
                        await this.deleteRaw(message.key);
                        this.deindexEntry(this.k(message.key));
                    }
                    break;
                case "clear":
                    await this.tx("readwrite", (s) => s.clear());
                    this.meta.clear();
                    this.tagIndex.clear();
                    this.dirtyAccess.clear();
                    this.currentSize = 0;
                    break;
            }
            if (this.config.enableStats) this.refreshCountStats();
        } catch (error) {
            this.handleError(error as Error);
        }
    }

    // ==============================
    // Private: IndexedDB Helpers
    // ==============================

    private async getDB(): Promise<IDBDatabase> {
        if (isSSR()) {
            throw new UnsupportedEnvironmentError(
                "IndexedDB is not available in server-side environments. " +
                "Wrap cache usage in an isClient() check or use dynamic imports."
            );
        }

        if (!this.dbPromise) {
            this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open(this.config.dbName, this.config.version);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(this.config.storeName)) {
                        db.createObjectStore(this.config.storeName);
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror   = () => reject(req.error);
                req.onblocked = () => {
                    this.handleError(new CacheError("IndexedDB upgrade blocked by another tab", "IDB_BLOCKED"));
                };
            });

            this.dbPromise.then((db) => {
                db.onclose = () => { this.dbPromise = null; this.indexReady = null; };
            }).catch(() => { this.dbPromise = null; });
        }
        return this.dbPromise;
    }

    private tx<T>(
        mode: IDBTransactionMode,
        fn: (store: IDBObjectStore) => IDBRequest | void
    ): Promise<T> {
        return this.getDB().then(
            (db) =>
                new Promise<T>((resolve, reject) => {
                    const tx    = db.transaction(this.config.storeName, mode);
                    const store = tx.objectStore(this.config.storeName);
                    let result: T;
                    try {
                        const req = fn(store);
                        if (req) req.onsuccess = () => { result = req.result as T; };
                    } catch (e) { reject(e); return; }
                    tx.oncomplete = () => resolve(result);
                    tx.onerror    = () => reject(tx.error);
                    tx.onabort    = () => reject(new CacheError("Transaction aborted", "TX_ABORTED"));
                })
        );
    }

    private k(key: string): string { return buildKey(this.config.namespace, key); }

    private getRaw(key: string): Promise<CacheEntry | undefined> {
        return this.tx<CacheEntry | undefined>("readonly", (s) => s.get(this.k(key)));
    }

    private putRaw(key: string, val: CacheEntry): Promise<void> {
        return this.tx("readwrite", (s) => s.put(val, this.k(key)));
    }

    private deleteRaw(key: string): Promise<void> {
        return this.tx("readwrite", (s) => s.delete(this.k(key)));
    }

    /** Compress/encrypt a value into a CacheEntry (no DB write). */
    private async buildEntry<T>(value: T, opt?: CacheSetOptions): Promise<CacheEntry> {
        const json = JSON.stringify(value);
        let final: string | Uint8Array = json;
        let size = getSize(json);
        let compressed = false, encrypted = false, encoded = false;

        if (opt?.forceCompress || size > this.config.compressionThreshold) {
            final = await compress(json); size = (final as Uint8Array).byteLength; compressed = true;
        } else if (opt?.encode) {
            final = encode(value); size = getSize(final); encoded = true;
        }
        if (opt?.encrypt && this.encryption?.isInitialized()) {
            const toEncrypt = typeof final === "string" ? final : JSON.stringify(Array.from(final as Uint8Array));
            final = await this.encryption.encrypt(toEncrypt); size = (final as Uint8Array).byteLength; encrypted = true;
        }

        return {
            value: final,
            isEncoded: encoded, isCompressed: compressed, isEncrypted: encrypted,
            createdAt: Date.now(), lastAccessed: Date.now(), accessCount: 0,
            expiresAt: calculateTTL(opt?.ttl), size,
            tags: opt?.tags ?? [], metadata: opt?.metadata, priority: opt?.priority,
        };
    }

    private async evict(): Promise<void> {
        if (this.currentSize <= this.config.maxSize) return;

        const policy = this.config.evictionStrategy === "custom" && this.config.evictionPolicy
            ? this.config.evictionPolicy
            : createEvictionPolicy(this.config.evictionStrategy);

        const metas       = Array.from(this.meta.values());
        const keysToEvict = policy.shouldEvict(metas, this.config.maxSize, this.currentSize);
        if (keysToEvict.length === 0) return;

        // Gather evicted entries for plugins BEFORE deleting (if any plugin needs them).
        const needEntries = this.plugins.some((p) => p.onEvict);
        const evictedEntries: CacheEntry[] = [];
        if (needEntries) {
            for (const fullKey of keysToEvict) {
                const e = await this.getRaw(parseKey(fullKey, this.config.namespace)).catch(() => undefined);
                if (e) evictedEntries.push(e);
            }
        }

        await this.getDB().then(
            (db) =>
                new Promise<void>((resolve, reject) => {
                    const tx    = db.transaction(this.config.storeName, "readwrite");
                    const store = tx.objectStore(this.config.storeName);
                    for (const fullKey of keysToEvict) store.delete(fullKey);
                    tx.oncomplete = () => resolve();
                    tx.onerror    = () => reject(tx.error);
                })
        );

        for (const fullKey of keysToEvict) {
            this.deindexEntry(fullKey);
            if (this.config.enableStats) this.stats.evictions++;
        }

        this.emit("evict", {
            event: "evict", timestamp: Date.now(),
            metadata: { keys: keysToEvict, count: keysToEvict.length },
        });

        for (const plugin of this.plugins) {
            if (plugin.onEvict) await plugin.onEvict(keysToEvict, evictedEntries);
        }

        if (this.config.enableStats) this.refreshCountStats();
    }

    /** Sync totalSize/entryCount stat fields from the in-memory accumulators. */
    private refreshCountStats(): void {
        if (!this.config.enableStats) return;
        this.stats.totalSize  = this.currentSize;
        this.stats.entryCount = this.meta.size;
        this.recomputeRates();
    }

    private recomputeRates(): void {
        const total = this.stats.hits + this.stats.misses;
        this.stats.hitRate  = total > 0 ? this.stats.hits   / total : 0;
        this.stats.missRate = total > 0 ? this.stats.misses / total : 0;
    }

    private handleError(error: Error): void {
        if (this.config.enableStats) this.stats.errors++;
        this.emit("error", { event: "error", timestamp: Date.now(), error });
        this.config.onError(error);
        for (const plugin of this.plugins) plugin.onError?.(error, "unknown");
    }

    private emptyStats(): CacheStats {
        return {
            hits: 0, misses: 0, sets: 0, deletes: 0,
            evictions: 0, errors: 0, totalSize: 0, entryCount: 0,
            hitRate: 0, missRate: 0, avgAccessTime: 0,
        };
    }

    // ==============================
    // Lifecycle
    // ==============================

    async destroy(): Promise<void> {
        this.stopAutoCleanup();
        if (this.flushIntervalId) { clearInterval(this.flushIntervalId); this.flushIntervalId = null; }
        await this.flushAccessMetadata().catch(() => undefined);

        this.broadcastChannel?.close();
        this.eventListeners.clear();
        this.plugins = [];
        this.meta.clear();
        this.tagIndex.clear();
        this.dirtyAccess.clear();
        this.inflight.clear();
        this.currentSize = 0;

        if (this.dbPromise) {
            const db = await this.dbPromise;
            db.close();
            this.dbPromise = null;
        }
        this.indexReady = null;
    }
}

// Retained for type compatibility with plugin onEvict signatures.
export type { CacheEntryWithKey };
