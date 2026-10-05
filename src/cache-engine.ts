import { createEvictionPolicy } from "./eviction";
import type {
    BatchGetItem,
    BatchResult,
    BatchSetItem,
    CacheConfig,
    CacheEntry,
    CacheEntryMeta,
    CacheEvent,
    CacheEventData,
    CacheEventListener,
    CacheGetOptions,
    CachePlugin,
    CacheQuery,
    CacheSetOptions,
    CacheStats,
    DetailedStats,
    EvictionPolicy,
    ExportData,
    ExportOptions,
    GetOrSetOptions,
    HealthStatus,
    ImportOptions,
    QueryResult,
    StorageInfo,
    SyncMessage,
    SyncMessageType,
} from "./types";
import {
    buildKey,
    CacheError,
    calculateTTL,
    compress,
    decode,
    decompress,
    EncryptionError,
    EncryptionManager,
    encode,
    generateId,
    getAge,
    getSize,
    isBroadcastChannelSupported,
    isExpired,
    isGzip,
    matchesPattern,
    PerformanceTimer,
    parseKey,
    QuotaExceededError,
    toError,
    UnsupportedEnvironmentError,
    VERSION,
} from "./utils";

// ==============================
// CacheCraft Main Engine
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
//  • Multi-key reads (query / export / getMany) share one transaction.
// ==============================

type ResolvedConfig = Required<Omit<CacheConfig, "evictionPolicy">> & {
    evictionPolicy: EvictionPolicy | undefined;
};

type Lookup<T> = { hit: boolean; value: T | null };

type Timer = ReturnType<typeof setInterval>;

const MISS = { hit: false, value: null } as const;

/** Keep timers from holding a Node process (SSR, tests) open. */
function unref(handle: unknown): void {
    (handle as { unref?: () => void } | null)?.unref?.();
}

function hasIndexedDB(): boolean {
    return typeof indexedDB !== "undefined";
}

function isValidEntry(entry: unknown): entry is CacheEntry {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Partial<CacheEntry>;
    return (
        e.value !== undefined &&
        typeof e.size === "number" &&
        Number.isFinite(e.size) &&
        typeof e.createdAt === "number" &&
        typeof e.lastAccessed === "number" &&
        typeof e.isEncoded === "boolean" &&
        typeof e.isCompressed === "boolean"
    );
}

export class CacheEngine {
    private dbPromise: Promise<IDBDatabase> | null = null;
    private readonly config: ResolvedConfig;
    private encryption: EncryptionManager | null = null;
    private encryptionReady: Promise<void> | null = null;
    private plugins: CachePlugin[] = [];
    private eventListeners: Map<CacheEvent, Set<CacheEventListener>> = new Map();
    private stats: CacheStats;
    private broadcastChannel: BroadcastChannel | null = null;
    private cleanupIntervalId: Timer | null = null;
    private flushIntervalId: Timer | null = null;
    private readonly instanceId: string;
    private readonly startTime: number;

    // --- in-memory indexes (namespaced full keys) ---
    private meta: Map<string, CacheEntryMeta> = new Map();
    private tagIndex: Map<string, Set<string>> = new Map();
    private currentSize = 0;
    private indexReady: Promise<void> | null = null;

    // --- read-path access metadata buffer ---
    private dirtyAccess: Set<string> = new Set();

    // --- single-flight registries ---
    private inflight: Map<string, Promise<unknown>> = new Map();
    private revalidating: Set<string> = new Set();

    private readonly onVisibilityChange = (): void => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
            this.flushQuietly();
        }
    };
    private readonly onPageHide = (): void => this.flushQuietly();

    constructor(cfg?: CacheConfig) {
        this.config = {
            dbName: cfg?.dbName ?? "cache-db",
            version: cfg?.version ?? 1,
            storeName: cfg?.storeName ?? "cache",
            maxSize: cfg?.maxSize ?? 100 * 1024 * 1024,
            compressionThreshold: cfg?.compressionThreshold ?? 10 * 1024,
            namespace: cfg?.namespace ?? "",
            evictionStrategy: cfg?.evictionStrategy ?? "lru",
            enableStats: cfg?.enableStats ?? true,
            enableSync: cfg?.enableSync ?? false,
            encryptionKey: cfg?.encryptionKey ?? "",
            plugins: cfg?.plugins ?? [],
            onError: cfg?.onError ?? (() => undefined),
            autoCleanup: cfg?.autoCleanup ?? true,
            cleanupInterval: cfg?.cleanupInterval ?? 60_000,
            persistAccessMetadata: cfg?.persistAccessMetadata ?? true,
            accessMetadataFlushInterval: cfg?.accessMetadataFlushInterval ?? 1_000,
            evictionPolicy: cfg?.evictionPolicy,
        };

        this.instanceId = generateId();
        this.startTime = Date.now();
        this.stats = this.emptyStats();

        if (this.config.encryptionKey) {
            const manager = new EncryptionManager();
            this.encryption = manager;
            this.encryptionReady = manager.initialize(this.config.encryptionKey);
            // Surface the failure once here; callers that await it still see the rejection.
            this.encryptionReady.catch((err) => {
                this.handleError(
                    new CacheError("Encryption initialization failed", "INIT_ERROR", toError(err)),
                    "init"
                );
            });
        }

        for (const plugin of this.config.plugins) this.use(plugin);

        if (hasIndexedDB()) {
            if (this.config.enableSync && isBroadcastChannelSupported()) {
                this.broadcastChannel = new BroadcastChannel(`cachecraft-${this.config.dbName}`);
                unref(this.broadcastChannel);
                this.broadcastChannel.onmessage = (event) => {
                    void this.handleSyncMessage(event.data as SyncMessage);
                };
            }
            if (this.config.autoCleanup) this.startAutoCleanup();
            if (this.config.persistAccessMetadata) this.startAccessFlush();
        }
    }

    // ==============================
    // Index Hydration
    // ==============================

    /** Resolves once the in-memory index has been loaded from IndexedDB. */
    ready(): Promise<void> {
        return this.ensureIndex();
    }

    /** Build the in-memory meta/tag indexes from IndexedDB exactly once. */
    private ensureIndex(): Promise<void> {
        if (!this.indexReady) {
            this.indexReady = this.hydrate().catch((err) => {
                // Reset so a later call can retry.
                this.indexReady = null;
                throw err;
            });
        }
        return this.indexReady;
    }

    private async hydrate(): Promise<void> {
        const ns = this.config.namespace;
        // Only this namespace's keys belong to this engine's index/budget.
        const range = ns ? IDBKeyRange.bound(`${ns}:`, `${ns}:\uffff`) : undefined;
        const loaded: Array<[string, CacheEntry]> = [];

        await this.tx("readonly", (store) => {
            const req = store.openCursor(range);
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return;
                const entry = cursor.value as CacheEntry;
                // Keep only the metadata — never retain payloads in memory.
                loaded.push([String(cursor.key), { ...entry, value: "" }]);
                cursor.continue();
            };
            return undefined;
        });

        this.resetIndex();
        for (const [fullKey, entry] of loaded) this.indexEntry(fullKey, entry);
        this.refreshCountStats();
    }

    private resetIndex(): void {
        this.meta.clear();
        this.tagIndex.clear();
        this.dirtyAccess.clear();
        this.currentSize = 0;
    }

    private metaOf(fullKey: string, entry: CacheEntry): CacheEntryMeta {
        return {
            key: fullKey,
            size: Number.isFinite(entry.size) ? entry.size : 0,
            createdAt: entry.createdAt,
            lastAccessed: entry.lastAccessed,
            accessCount: entry.accessCount ?? 0,
            expiresAt: entry.expiresAt,
            priority: entry.priority,
            tags: entry.tags,
            originalSize: entry.originalSize,
            isCompressed: entry.isCompressed,
            isEncrypted: entry.isEncrypted ?? false,
            isEncoded: entry.isEncoded,
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

    private deindexEntry(fullKey: string): boolean {
        const prev = this.meta.get(fullKey);
        if (!prev) return false;
        this.currentSize -= prev.size;
        this.unindexTags(fullKey, prev.tags);
        this.meta.delete(fullKey);
        this.dirtyAccess.delete(fullKey);
        return true;
    }

    private indexTags(fullKey: string, tags?: readonly string[]): void {
        if (!tags) return;
        for (const tag of tags) {
            let set = this.tagIndex.get(tag);
            if (!set) {
                set = new Set();
                this.tagIndex.set(tag, set);
            }
            set.add(fullKey);
        }
    }

    private unindexTags(fullKey: string, tags?: readonly string[]): void {
        if (!tags) return;
        for (const tag of tags) {
            const set = this.tagIndex.get(tag);
            if (set) {
                set.delete(fullKey);
                if (set.size === 0) this.tagIndex.delete(tag);
            }
        }
    }

    // ==============================
    // Core Methods
    // ==============================

    async set<T>(key: string, value: T, opt?: CacheSetOptions): Promise<void> {
        try {
            await this.ensureIndex();

            // Plugins may adjust the options (e.g. forceCompress) — work on a copy.
            const options: CacheSetOptions = { ...opt };
            for (const plugin of this.plugins) {
                if (plugin.beforeSet) {
                    const proceed = await plugin.beforeSet(key, value, options);
                    if (proceed === false) return;
                }
            }

            const entry = await this.buildEntry(value, options);

            await this.putRaw(key, entry);
            this.indexEntry(this.k(key), entry);
            await this.evict().catch((err) => this.handleError(toError(err), "evict"));

            if (this.config.enableStats) {
                this.stats.sets++;
                this.refreshCountStats();
            }

            for (const plugin of this.plugins) {
                if (plugin.afterSet) await plugin.afterSet(key, value, entry, options);
            }

            this.emit("set", { event: "set", key, value, timestamp: Date.now() });
            options.onSet?.(key, value);
            this.broadcast("set", key);
        } catch (error) {
            this.handleError(toError(error), "set");
            throw error;
        }
    }

    async get<T>(key: string, opt?: CacheGetOptions<T>): Promise<T | null> {
        return (await this.lookup<T>(key, opt)).value;
    }

    /**
     * Shared read path. Unlike `get`, it distinguishes "cached `null`" from a
     * miss, which `getOrSet` needs for negative caching.
     */
    private async lookup<T>(key: string, opt?: CacheGetOptions<T>): Promise<Lookup<T>> {
        const timer = new PerformanceTimer();

        try {
            await this.ensureIndex();

            for (const plugin of this.plugins) {
                if (plugin.beforeGet) {
                    const proceed = await plugin.beforeGet(key, opt as CacheGetOptions<unknown>);
                    if (proceed === false) return MISS;
                }
            }

            const fullKey = this.k(key);
            const m = this.meta.get(fullKey);

            // Fast miss: not in index at all.
            if (!m) return await this.recordMiss<T>(key, opt);

            const expired = isExpired(m.expiresAt);

            if (expired && !opt?.staleWhileRevalidate) {
                await this.deleteRaw(key);
                this.deindexEntry(fullKey);
                this.emit("expire", { event: "expire", key, timestamp: Date.now() });
                return await this.recordMiss<T>(key, opt);
            }

            const entry = await this.getRaw(key);
            if (!entry) {
                // Index/DB drift — heal the index and report a miss.
                this.deindexEntry(fullKey);
                return await this.recordMiss<T>(key, opt);
            }

            // Stale-while-revalidate: serve the stale value, refresh in background.
            if (expired && opt?.revalidate) this.revalidateInBackground(key, fullKey, entry, opt);

            // Update access metadata (in index immediately; persisted lazily).
            if (opt?.updateAccessTime ?? true) {
                const now = Date.now();
                m.lastAccessed = now;
                m.accessCount += 1;
                entry.lastAccessed = now;
                entry.accessCount = m.accessCount;
                if (this.config.persistAccessMetadata) this.dirtyAccess.add(fullKey);
            }

            const value = await this.decodeEntry<T>(entry);

            if (this.config.enableStats) {
                this.stats.hits++;
                // Running mean over all hits.
                this.stats.avgAccessTime +=
                    (timer.elapsed() - this.stats.avgAccessTime) / this.stats.hits;
                this.recomputeRates();
            }

            this.emit("hit", { event: "hit", key, value, timestamp: Date.now() });
            this.emit("get", { event: "get", key, value, timestamp: Date.now() });

            for (const plugin of this.plugins) {
                if (plugin.afterGet) {
                    await plugin.afterGet(key, value, entry, opt as CacheGetOptions<unknown>);
                }
            }
            this.applyPluginExpiry(fullKey, m, entry);
            opt?.onGet?.(key, value);

            return { hit: true, value };
        } catch (error) {
            this.handleError(toError(error), "get");
            throw error;
        }
    }

    private async recordMiss<T>(key: string, opt?: CacheGetOptions<T>): Promise<Lookup<T>> {
        if (this.config.enableStats) {
            this.stats.misses++;
            this.refreshCountStats();
        }
        this.emit("miss", { event: "miss", key, timestamp: Date.now() });
        for (const plugin of this.plugins) {
            if (plugin.afterGet) {
                await plugin.afterGet(key, null, null, opt as CacheGetOptions<unknown>);
            }
        }
        opt?.onGet?.(key, null);
        return MISS;
    }

    /** A plugin (e.g. TTLRefreshPlugin) may have changed `entry.expiresAt` in afterGet. */
    private applyPluginExpiry(fullKey: string, m: CacheEntryMeta, entry: CacheEntry): void {
        if (entry.expiresAt === m.expiresAt || this.meta.get(fullKey) !== m) return;
        m.expiresAt = entry.expiresAt;
        this.dirtyAccess.add(fullKey);
        if (!this.config.persistAccessMetadata) this.flushQuietly();
    }

    private revalidateInBackground<T>(
        key: string,
        fullKey: string,
        entry: CacheEntry,
        opt: CacheGetOptions<T>
    ): void {
        const revalidate = opt.revalidate;
        if (!revalidate || this.revalidating.has(fullKey)) return;
        this.revalidating.add(fullKey);

        // Without an explicit TTL, reuse the entry's original lifetime — otherwise the
        // refreshed value would never expire.
        const originalTtl =
            entry.expiresAt !== undefined
                ? Math.max(entry.expiresAt - entry.createdAt, 0)
                : undefined;

        void (async () => {
            try {
                let fresh: T;
                try {
                    fresh = await revalidate();
                } catch (err) {
                    this.handleError(toError(err), "revalidate");
                    return;
                }
                // set() reports its own failures.
                await this.set(key, fresh, {
                    ttl: opt.ttlOnRevalidate ?? originalTtl,
                    tags: entry.tags ? [...entry.tags] : undefined,
                    metadata: entry.metadata,
                    priority: entry.priority,
                }).catch(() => undefined);
            } finally {
                this.revalidating.delete(fullKey);
            }
        })();
    }

    /**
     * Cache-aside helper: return the cached value, or run `factory`, store the
     * result, and return it. Concurrent calls for the same key share a single
     * factory invocation (stampede / thundering-herd protection). A cached
     * `null` counts as a hit.
     */
    async getOrSet<T>(
        key: string,
        factory: () => Promise<T> | T,
        opt?: GetOrSetOptions<T>
    ): Promise<T> {
        await this.ensureIndex();

        const fullKey = this.k(key);
        const m = this.meta.get(fullKey);
        const fresh = m !== undefined && !isExpired(m.expiresAt);

        if (fresh) {
            const cached = await this.lookup<T>(key, { updateAccessTime: true });
            if (cached.hit) return cached.value as T;
        }

        // Stale-while-revalidate: serve stale now, refresh in background.
        if (m && !fresh && opt?.staleWhileRevalidate) {
            const stale = await this.lookup<T>(key, { staleWhileRevalidate: true });
            if (stale.hit) {
                this.flight(key, fullKey, factory, opt, true).catch((err) =>
                    this.handleError(toError(err), "revalidate")
                );
                return stale.value as T;
            }
        }

        try {
            return await this.flight(key, fullKey, factory, opt, false);
        } catch (err) {
            if (opt?.fallbackToStale) {
                const stale = await this.readStale<T>(key);
                if (stale.hit) return stale.value as T;
            }
            throw err;
        }
    }

    /** Single-flight: join an in-progress factory run for this key, or start one. */
    private flight<T>(
        key: string,
        fullKey: string,
        factory: () => Promise<T> | T,
        opt: GetOrSetOptions<T> | undefined,
        refresh: boolean
    ): Promise<T> {
        const existing = this.inflight.get(fullKey);
        if (existing) return existing as Promise<T>;

        const promise: Promise<T> = this.runFactory(key, factory, opt, refresh).finally(() => {
            if (this.inflight.get(fullKey) === promise) this.inflight.delete(fullKey);
        });
        this.inflight.set(fullKey, promise);
        return promise;
    }

    private async runFactory<T>(
        key: string,
        factory: () => Promise<T> | T,
        opt: GetOrSetOptions<T> | undefined,
        refresh: boolean
    ): Promise<T> {
        const value = await factory();
        // A caching failure (quota, validation…) is reported through onError but must
        // not lose a value we already computed.
        await this.set(key, value, this.toSetOptions(opt, refresh)).catch(() => undefined);
        return value;
    }

    private toSetOptions<T>(
        opt: GetOrSetOptions<T> | undefined,
        refresh: boolean
    ): CacheSetOptions {
        if (!opt) return {};
        const { staleWhileRevalidate: _swr, ttlOnRevalidate, fallbackToStale: _fts, ...rest } = opt;
        return refresh && ttlOnRevalidate !== undefined ? { ...rest, ttl: ttlOnRevalidate } : rest;
    }

    /** Read a value even if expired (used by `fallbackToStale`). */
    private async readStale<T>(key: string): Promise<Lookup<T>> {
        const raw = await this.getRaw(key).catch(() => undefined);
        if (!raw) return MISS;
        try {
            return { hit: true, value: await this.decodeEntry<T>(raw) };
        } catch {
            return MISS;
        }
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
            this.broadcast("delete", key);

            return existed;
        } catch (error) {
            this.handleError(toError(error), "remove");
            return false;
        }
    }

    /** Remove every entry of this engine's namespace (other namespaces are untouched). */
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
            await this.clearStore();
            this.resetIndex();

            if (this.config.enableStats) {
                this.stats = { ...this.stats, entryCount: 0, totalSize: 0 };
            }

            for (const plugin of this.plugins) {
                if (plugin.afterClear) await plugin.afterClear(count);
            }

            this.emit("clear", { event: "clear", timestamp: Date.now(), metadata: { count } });
            this.broadcast("clear");

            return count;
        } catch (error) {
            this.handleError(toError(error), "clear");
            return 0;
        }
    }

    private clearStore(): Promise<undefined> {
        const ns = this.config.namespace;
        return this.tx("readwrite", (store) =>
            ns ? store.delete(IDBKeyRange.bound(`${ns}:`, `${ns}:\uffff`)) : store.clear()
        );
    }

    /** A sibling engine on the same database, scoped to another key namespace. */
    namespace(ns: string): CacheEngine {
        return new CacheEngine({ ...this.config, namespace: ns, plugins: [...this.plugins] });
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
        let removed = 0;
        for (const fullKey of Array.from(set)) {
            if (await this.remove(parseKey(fullKey, this.config.namespace))) removed++;
        }
        return removed;
    }

    /** Delete entries matching ANY of the supplied tags. */
    async invalidateByTags(tags: readonly string[]): Promise<number> {
        let removed = 0;
        for (const tag of tags) removed += await this.invalidateByTag(tag);
        return removed;
    }

    /**
     * All known tags. Synchronous, so it reflects the index as loaded so far —
     * `await cache.ready()` first if no other operation has run yet.
     */
    allTags(): string[] {
        return Array.from(this.tagIndex.keys());
    }

    // ==============================
    // Blob helpers
    // ==============================

    async setBlob(key: string, blob: Blob, opt?: CacheSetOptions): Promise<void> {
        await this.ensureIndex();
        let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
        let encrypted = false;
        if (opt?.encrypt) {
            bytes = await (await this.requireEncryption()).encrypt(bytes);
            encrypted = true;
        }

        const now = Date.now();
        const entry: CacheEntry = {
            value: bytes,
            isEncoded: false,
            isCompressed: false,
            isEncrypted: encrypted,
            createdAt: now,
            lastAccessed: now,
            accessCount: 0,
            expiresAt: calculateTTL(opt?.ttl),
            size: bytes.byteLength,
            tags: opt?.tags ? [...opt.tags] : [],
            metadata: opt?.metadata,
            priority: opt?.priority,
        };

        await this.putRaw(key, entry);
        this.indexEntry(this.k(key), entry);
        await this.evict().catch((err) => this.handleError(toError(err), "evict"));

        if (this.config.enableStats) {
            this.stats.sets++;
            this.refreshCountStats();
        }

        for (const plugin of this.plugins) {
            if (plugin.afterSet) await plugin.afterSet(key, blob, entry, opt);
        }
        this.emit("set", { event: "set", key, timestamp: Date.now() });
        this.broadcast("set", key);
    }

    async getBlob(key: string, type = "application/octet-stream"): Promise<Blob | null> {
        await this.ensureIndex();
        const fullKey = this.k(key);
        const m = this.meta.get(fullKey);

        const miss = (): null => {
            if (this.config.enableStats) {
                this.stats.misses++;
                this.refreshCountStats();
            }
            return null;
        };

        if (!m) return miss();

        if (isExpired(m.expiresAt)) {
            await this.deleteRaw(key);
            this.deindexEntry(fullKey);
            return miss();
        }

        const entry = await this.getRaw(key);
        if (!entry) {
            this.deindexEntry(fullKey);
            return miss();
        }
        if (!(entry.value instanceof Uint8Array)) return miss();

        m.lastAccessed = Date.now();
        m.accessCount += 1;
        if (this.config.persistAccessMetadata) this.dirtyAccess.add(fullKey);

        let bytes: Uint8Array = entry.value;
        if (entry.isEncrypted) bytes = await (await this.requireEncryption()).decryptBytes(bytes);

        if (this.config.enableStats) {
            this.stats.hits++;
            this.recomputeRates();
        }
        return new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
    }

    // ==============================
    // Decode pipeline (shared by get/query/getOrSet)
    // ==============================

    private async decodeEntry<T>(entry: CacheEntry): Promise<T> {
        let v: unknown = entry.value;

        if (entry.isEncrypted) {
            const bytes = await (await this.requireEncryption()).decryptBytes(v as Uint8Array);
            if (entry.isCompressed) {
                if (isGzip(bytes)) {
                    v = bytes;
                } else {
                    // Legacy (≤0.4) format: compressed bytes serialised as a JSON array
                    // string before encryption.
                    v = new Uint8Array(JSON.parse(new TextDecoder().decode(bytes)) as number[]);
                }
            } else {
                v = new TextDecoder().decode(bytes);
            }
        }

        if (entry.isCompressed) {
            v = await decompress(v as Uint8Array);
        }

        if (entry.isEncoded) {
            return decode(v as string) as T;
        }

        return typeof v === "string" ? (JSON.parse(v) as T) : (v as T);
    }

    private async requireEncryption(): Promise<EncryptionManager> {
        if (!this.encryption || !this.encryptionReady) {
            throw new EncryptionError(
                "This entry is encrypted (or `encrypt: true` was requested) but no `encryptionKey` is configured"
            );
        }
        await this.encryptionReady;
        return this.encryption;
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
     * Plugin `beforeSet` / `afterSet` hooks run for every item.
     */
    async batchSet<T>(items: BatchSetItem<T>[]): Promise<BatchResult<T>[]> {
        await this.ensureIndex();

        type Prepared = {
            item: BatchSetItem<T>;
            options: CacheSetOptions;
            entry?: CacheEntry;
            error?: Error;
        };

        // Prepare entries (plugins, compression, encryption) outside the transaction.
        const prepared: Prepared[] = [];
        for (const item of items) {
            const options: CacheSetOptions = { ...item.options };
            try {
                let proceed = true;
                for (const plugin of this.plugins) {
                    if (
                        plugin.beforeSet &&
                        (await plugin.beforeSet(item.key, item.value, options)) === false
                    ) {
                        proceed = false;
                        break;
                    }
                }
                if (!proceed) {
                    prepared.push({
                        item,
                        options,
                        error: new CacheError("Rejected by a plugin", "PLUGIN_REJECTED"),
                    });
                    continue;
                }
                prepared.push({ item, options, entry: await this.buildEntry(item.value, options) });
            } catch (error) {
                prepared.push({ item, options, error: toError(error) });
            }
        }

        const writable = prepared.filter((p): p is Prepared & { entry: CacheEntry } => !!p.entry);
        if (writable.length) {
            await this.tx("readwrite", (store) => {
                for (const p of writable) store.put(p.entry, this.k(p.item.key));
                return undefined;
            });

            for (const p of writable) {
                this.indexEntry(this.k(p.item.key), p.entry);
                if (this.config.enableStats) this.stats.sets++;
            }
            await this.evict().catch((err) => this.handleError(toError(err), "evict"));
            if (this.config.enableStats) this.refreshCountStats();

            for (const p of writable) {
                try {
                    for (const plugin of this.plugins) {
                        if (plugin.afterSet)
                            await plugin.afterSet(p.item.key, p.item.value, p.entry, p.options);
                    }
                } catch (error) {
                    this.handleError(toError(error), "set");
                }
                this.emit("set", {
                    event: "set",
                    key: p.item.key,
                    value: p.item.value,
                    timestamp: Date.now(),
                });
                p.options.onSet?.(p.item.key, p.item.value);
                this.broadcast("set", p.item.key);
            }
        }

        return prepared.map((p) =>
            p.entry
                ? { key: p.item.key, value: p.item.value, success: true }
                : { key: p.item.key, value: null, success: false, error: p.error as Error }
        );
    }

    async batchGet<T>(items: BatchGetItem[]): Promise<BatchResult<T>[]> {
        const settled = await Promise.allSettled(
            items.map((item) => this.get<T>(item.key, item.options as CacheGetOptions<T>))
        );
        return items.map((item, i) => {
            const result = settled[i] as PromiseSettledResult<T | null>;
            if (result.status === "fulfilled") {
                return { key: item.key, value: result.value, success: true };
            }
            return { key: item.key, value: null, success: false, error: toError(result.reason) };
        });
    }

    async batchDelete(keys: string[]): Promise<BatchResult<null>[]> {
        await this.ensureIndex();
        const present = [...new Set(keys)].filter((k) => this.meta.has(this.k(k)));

        if (present.length) {
            await this.tx("readwrite", (store) => {
                for (const k of present) store.delete(this.k(k));
                return undefined;
            });
            for (const k of present) {
                this.deindexEntry(this.k(k));
                if (this.config.enableStats) this.stats.deletes++;
                this.emit("delete", { event: "delete", key: k, timestamp: Date.now() });
                this.broadcast("delete", k);
            }
            if (this.config.enableStats) this.refreshCountStats();
        }

        const presentSet = new Set(present);
        return keys.map((key) => ({ key, value: null, success: presentSet.has(key) }));
    }

    /** Read many keys with a single readonly transaction. Missing/expired → `null`. */
    async getMany<T>(keys: string[]): Promise<Map<string, T | null>> {
        await this.ensureIndex();
        const out = new Map<string, T | null>();
        const raw = await this.readRaw(keys);

        for (const key of keys) {
            const entry = raw.get(key);
            if (!entry || isExpired(entry.expiresAt)) {
                out.set(key, null);
                if (this.config.enableStats) this.stats.misses++;
                continue;
            }
            try {
                out.set(key, await this.decodeEntry<T>(entry));
                if (this.config.enableStats) this.stats.hits++;
            } catch (error) {
                this.handleError(toError(error), "get");
                out.set(key, null);
                if (this.config.enableStats) this.stats.misses++;
            }
        }
        if (this.config.enableStats) this.recomputeRates();
        return out;
    }

    // ==============================
    // Query System
    // ==============================

    /** Filter + sort + paginate on in-memory metadata only (no payload reads). */
    private selectMetas(query: CacheQuery): CacheEntryMeta[] {
        let metas = Array.from(this.meta.values());

        const tags = query.tags;
        if (tags?.length) {
            metas = metas.filter((m) => tags.some((tag) => m.tags?.includes(tag)));
        }
        const { minPriority, maxPriority, minAge, maxAge, minSize, maxSize, minAccessCount } =
            query;
        if (minPriority !== undefined)
            metas = metas.filter((m) => (m.priority ?? 0) >= minPriority);
        if (maxPriority !== undefined)
            metas = metas.filter((m) => (m.priority ?? 0) <= maxPriority);
        if (minAge !== undefined) metas = metas.filter((m) => getAge(m.createdAt) >= minAge);
        if (maxAge !== undefined) metas = metas.filter((m) => getAge(m.createdAt) <= maxAge);
        if (minSize !== undefined) metas = metas.filter((m) => m.size >= minSize);
        if (maxSize !== undefined) metas = metas.filter((m) => m.size <= maxSize);
        if (minAccessCount !== undefined)
            metas = metas.filter((m) => m.accessCount >= minAccessCount);
        const pattern = query.pattern;
        if (pattern) {
            metas = metas.filter((m) =>
                matchesPattern(parseKey(m.key, this.config.namespace), pattern)
            );
        }
        if (query.expired !== undefined) {
            const wantExpired = query.expired;
            metas = metas.filter((m) => isExpired(m.expiresAt) === wantExpired);
        }

        const sortBy = query.sortBy;
        if (sortBy) {
            const dir = query.sortOrder === "desc" ? -1 : 1;
            const sortValue = (m: CacheEntryMeta): number => {
                switch (sortBy) {
                    case "createdAt":
                        return m.createdAt;
                    case "lastAccessed":
                        return m.lastAccessed;
                    case "accessCount":
                        return m.accessCount;
                    case "size":
                        return m.size;
                    case "priority":
                        return m.priority ?? 0;
                    case "expiresAt":
                        return m.expiresAt ?? Number.POSITIVE_INFINITY;
                }
            };
            // Compare explicitly: `Infinity - Infinity` is NaN and breaks sort().
            metas.sort((a, b) => {
                const av = sortValue(a);
                const bv = sortValue(b);
                return av < bv ? -dir : av > bv ? dir : 0;
            });
        }

        if (query.offset !== undefined) metas = metas.slice(query.offset);
        if (query.limit !== undefined) metas = metas.slice(0, query.limit);
        return metas;
    }

    /**
     * Same filters as {@link query}, but returns lightweight metadata only —
     * no payload is read or decoded. Keys are namespace-stripped.
     */
    async queryMeta(query: CacheQuery = {}): Promise<CacheEntryMeta[]> {
        await this.ensureIndex();
        return this.selectMetas(query).map((m) => ({
            ...m,
            key: parseKey(m.key, this.config.namespace),
        }));
    }

    async query<T>(query: CacheQuery): Promise<QueryResult<T>[]> {
        await this.ensureIndex();
        const keys = this.selectMetas(query).map((m) => parseKey(m.key, this.config.namespace));

        // Hydrate only the page of results we actually return, in ONE transaction.
        const raw = await this.readRaw(keys);
        const results: QueryResult<T>[] = [];
        for (const key of keys) {
            const entry = raw.get(key);
            if (!entry) continue;
            try {
                const value = await this.decodeEntry<T>(entry);
                results.push({ key, value, entry: entry as CacheEntry<T> });
            } catch {
                /* skip undecodable entries */
            }
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

        const entriesByTag: Record<string, number> = {};
        const sizeByTag: Record<string, number> = {};
        let storedCompressed = 0;
        let originalCompressed = 0;
        let encryptedCount = 0;
        let expiredCount = 0;
        let oldestEntry: number | undefined;
        let newestEntry: number | undefined;
        let mostAccessed: { key: string; count: number } | undefined;
        let largestEntry: { key: string; size: number } | undefined;

        for (const m of this.meta.values()) {
            const key = parseKey(m.key, this.config.namespace);
            for (const tag of m.tags ?? []) {
                entriesByTag[tag] = (entriesByTag[tag] ?? 0) + 1;
                sizeByTag[tag] = (sizeByTag[tag] ?? 0) + m.size;
            }
            if (m.isCompressed && m.originalSize !== undefined && m.originalSize > 0) {
                storedCompressed += m.size;
                originalCompressed += m.originalSize;
            }
            if (m.isEncrypted) encryptedCount++;
            if (isExpired(m.expiresAt)) expiredCount++;
            if (oldestEntry === undefined || m.createdAt < oldestEntry) oldestEntry = m.createdAt;
            if (newestEntry === undefined || m.createdAt > newestEntry) newestEntry = m.createdAt;
            if (!mostAccessed || m.accessCount > mostAccessed.count) {
                mostAccessed = { key, count: m.accessCount };
            }
            if (!largestEntry || m.size > largestEntry.size) largestEntry = { key, size: m.size };
        }

        const result: DetailedStats = {
            ...this.stats,
            totalSize: this.currentSize,
            entryCount: this.meta.size,
            entriesByTag,
            sizeByTag,
            compressionRatio: originalCompressed > 0 ? storedCompressed / originalCompressed : 0,
            encryptedCount,
            expiredCount,
        };
        if (oldestEntry !== undefined) result.oldestEntry = oldestEntry;
        if (newestEntry !== undefined) result.newestEntry = newestEntry;
        if (mostAccessed) result.mostAccessed = mostAccessed;
        if (largestEntry) result.largestEntry = largestEntry;
        return result;
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
        const keys: string[] = [];
        for (const m of this.meta.values()) {
            if (!options?.includeExpired && isExpired(m.expiresAt)) continue;
            keys.push(parseKey(m.key, this.config.namespace));
        }

        const raw = await this.readRaw(keys);
        const exportEntries: Record<string, CacheEntry> = {};
        for (const key of keys) {
            const entry = raw.get(key);
            if (!entry) continue;
            if (options?.filter && !options.filter(key, entry)) continue;
            exportEntries[key] = entry;
        }

        const data: ExportData = {
            version: VERSION,
            timestamp: Date.now(),
            entries: exportEntries,
        };
        if (this.config.enableStats) data.stats = this.getStats();
        return data;
    }

    async import(data: ExportData, options?: ImportOptions): Promise<number> {
        await this.ensureIndex();
        let imported = 0;
        for (const [key, entry] of Object.entries(data.entries)) {
            try {
                if (!isValidEntry(entry)) {
                    throw new CacheError(`Invalid cache entry for key "${key}"`, "INVALID_ENTRY");
                }
                if (!options?.overwrite && !options?.merge && (await this.has(key))) continue;
                await this.putRaw(key, entry);
                this.indexEntry(this.k(key), entry);
                imported++;
            } catch (error) {
                if (!options?.skipInvalid) throw error;
            }
        }
        await this.evict().catch((err) => this.handleError(toError(err), "evict"));
        if (this.config.enableStats) this.refreshCountStats();
        return imported;
    }

    // ==============================
    // Cleanup & Maintenance
    // ==============================

    /** Delete expired entries. Returns how many were removed. */
    async cleanup(): Promise<number> {
        await this.ensureIndex();
        const candidates = Array.from(this.meta.values())
            .filter((m) => isExpired(m.expiresAt))
            .map((m) => m.key);
        if (candidates.length === 0) return 0;

        // Re-check expiry INSIDE the transaction so an entry refreshed meanwhile survives.
        const deleted: string[] = [];
        await this.tx("readwrite", (store) => {
            for (const fullKey of candidates) {
                const req = store.get(fullKey);
                req.onsuccess = () => {
                    const entry = req.result as CacheEntry | undefined;
                    if (!entry || isExpired(entry.expiresAt)) {
                        store.delete(fullKey);
                        deleted.push(fullKey);
                    }
                };
            }
            return undefined;
        });

        for (const fullKey of deleted) {
            this.deindexEntry(fullKey);
            this.emit("expire", {
                event: "expire",
                key: parseKey(fullKey, this.config.namespace),
                timestamp: Date.now(),
            });
        }
        if (this.config.enableStats) this.refreshCountStats();
        return deleted.length;
    }

    private startAutoCleanup(): void {
        if (this.cleanupIntervalId) clearInterval(this.cleanupIntervalId);
        this.cleanupIntervalId = setInterval(() => {
            this.cleanup().catch((err) => this.handleError(toError(err), "cleanup"));
        }, this.config.cleanupInterval);
        unref(this.cleanupIntervalId);
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
        this.flushIntervalId = setInterval(
            () => this.flushQuietly(),
            this.config.accessMetadataFlushInterval
        );
        unref(this.flushIntervalId);

        // Don't lose the buffer when the tab is hidden or closed.
        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", this.onVisibilityChange);
        }
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            window.addEventListener("pagehide", this.onPageHide);
        }
    }

    private flushQuietly(): void {
        this.flushAccessMetadata().catch((err) => this.handleError(toError(err), "flush"));
    }

    /** Persist buffered lastAccessed/accessCount updates in one transaction. */
    async flushAccessMetadata(): Promise<void> {
        if (this.dirtyAccess.size === 0) return;
        const keys = Array.from(this.dirtyAccess);
        this.dirtyAccess.clear();

        try {
            await this.tx("readwrite", (store) => {
                for (const fullKey of keys) {
                    const getReq = store.get(fullKey);
                    getReq.onsuccess = () => {
                        const entry = getReq.result as CacheEntry | undefined;
                        const m = this.meta.get(fullKey);
                        if (!entry || !m) return;
                        entry.lastAccessed = m.lastAccessed;
                        entry.accessCount = m.accessCount;
                        entry.expiresAt = m.expiresAt;
                        store.put(entry, fullKey);
                    };
                }
                return undefined;
            });
        } catch (err) {
            // Re-queue on failure so updates aren't silently lost.
            for (const k of keys) this.dirtyAccess.add(k);
            throw err;
        }
    }

    async getStorageInfo(): Promise<StorageInfo> {
        if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
            return { used: 0, available: 0, total: 0, percentage: 0, canGrow: false };
        }
        const estimate = await navigator.storage.estimate();
        const used = estimate.usage ?? 0;
        const total = estimate.quota ?? 0;
        // `persisted()` only *reads* the state; `persist()` would pop a permission prompt.
        const canGrow =
            typeof navigator.storage.persisted === "function"
                ? await navigator.storage.persisted()
                : true;
        return {
            used,
            available: Math.max(total - used, 0),
            total,
            percentage: total > 0 ? used / total : 0,
            canGrow,
        };
    }

    async getHealth(): Promise<HealthStatus> {
        const issues: string[] = [];
        try {
            await this.ensureIndex();
            const storageInfo = await this.getStorageInfo();

            if (storageInfo.percentage > 0.9) issues.push("Storage usage above 90%");
            if (this.currentSize > this.config.maxSize * 0.9) {
                issues.push("Cache size near configured limit");
            }

            return {
                isHealthy: issues.length === 0,
                uptime: Date.now() - this.startTime,
                dbConnected: true,
                size: this.currentSize,
                entryCount: this.meta.size,
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
                lastError: toError(error),
            };
        }
    }

    // ==============================
    // Plugin System
    // ==============================

    use(plugin: CachePlugin): void {
        this.plugins.push(plugin);
        try {
            plugin.init?.(this);
        } catch (error) {
            this.handleError(toError(error), "init");
        }
    }

    removePlugin(name: string): boolean {
        const index = this.plugins.findIndex((p) => p.name === name);
        if (index !== -1) {
            this.plugins.splice(index, 1);
            return true;
        }
        return false;
    }

    getPlugins(): CachePlugin[] {
        return [...this.plugins];
    }

    // ==============================
    // Event System
    // ==============================

    on(event: CacheEvent, listener: CacheEventListener): void {
        let set = this.eventListeners.get(event);
        if (!set) {
            set = new Set();
            this.eventListeners.set(event, set);
        }
        set.add(listener);
    }

    off(event: CacheEvent, listener: CacheEventListener): void {
        this.eventListeners.get(event)?.delete(listener);
    }

    once(event: CacheEvent, listener: CacheEventListener): void {
        const onceListener: CacheEventListener = (data) => {
            this.off(event, onceListener);
            listener(data);
        };
        this.on(event, onceListener);
    }

    private emit(event: CacheEvent, data: CacheEventData): void {
        const listeners = this.eventListeners.get(event);
        if (!listeners) return;
        for (const listener of Array.from(listeners)) {
            try {
                listener(data);
            } catch (error) {
                // A throwing "error" listener must not re-enter handleError → emit("error").
                if (event !== "error") this.handleError(toError(error), "listener");
            }
        }
    }

    // ==============================
    // Sync System
    // ==============================

    private broadcast(type: SyncMessageType, key?: string, keys?: string[]): void {
        if (!this.config.enableSync || !this.broadcastChannel) return;
        const message: SyncMessage = {
            type,
            namespace: this.config.namespace,
            timestamp: Date.now(),
            source: this.instanceId,
        };
        if (key !== undefined) message.key = key;
        if (keys) message.keys = keys;
        try {
            // Values are deliberately NOT sent: other tabs re-read from IndexedDB, which
            // avoids cloning large payloads (and leaking plaintext of encrypted ones).
            this.broadcastChannel.postMessage(message);
        } catch (error) {
            this.handleError(toError(error), "sync");
        }
    }

    private async handleSyncMessage(message: SyncMessage): Promise<void> {
        if (!message || typeof message !== "object") return;
        if (message.source === this.instanceId) return;
        // The channel is shared by every namespace of one database.
        if ((message.namespace ?? "") !== this.config.namespace) return;
        if (!this.indexReady) return; // nothing loaded yet — hydration will read fresh state

        try {
            await this.indexReady;
            // The sending tab already changed IndexedDB; we only refresh our in-memory index.
            switch (message.type) {
                case "set": {
                    if (message.key === undefined) return;
                    const entry = await this.getRaw(message.key);
                    if (entry) this.indexEntry(this.k(message.key), entry);
                    else this.deindexEntry(this.k(message.key));
                    break;
                }
                case "delete":
                    if (message.key !== undefined) this.deindexEntry(this.k(message.key));
                    break;
                case "evict":
                    for (const key of message.keys ?? []) this.deindexEntry(this.k(key));
                    break;
                case "clear":
                    this.resetIndex();
                    break;
            }
            this.emit("sync", {
                event: "sync",
                ...(message.key !== undefined ? { key: message.key } : {}),
                timestamp: message.timestamp,
            });
            if (this.config.enableStats) this.refreshCountStats();
        } catch (error) {
            this.handleError(toError(error), "sync");
        }
    }

    // ==============================
    // Private: IndexedDB Helpers
    // ==============================

    private getDB(): Promise<IDBDatabase> {
        if (!hasIndexedDB()) {
            return Promise.reject(
                new UnsupportedEnvironmentError(
                    "IndexedDB is not available in server-side environments. " +
                        "Wrap cache usage in an isClient() check or use dynamic imports."
                )
            );
        }

        if (!this.dbPromise) {
            const promise = new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open(this.config.dbName, this.config.version);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(this.config.storeName)) {
                        db.createObjectStore(this.config.storeName);
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
                req.onblocked = () => {
                    this.handleError(
                        new CacheError("IndexedDB upgrade blocked by another tab", "IDB_BLOCKED"),
                        "open"
                    );
                };
            });
            this.dbPromise = promise;

            promise.then(
                (db) => {
                    const drop = (): void => {
                        if (this.dbPromise === promise) {
                            this.dbPromise = null;
                            this.indexReady = null;
                        }
                    };
                    db.onclose = drop;
                    // Another tab wants to upgrade the schema: release our connection.
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

    private wrapTxError(error: DOMException | Error | null): Error {
        if (error?.name === "QuotaExceededError") return new QuotaExceededError(undefined, error);
        return new CacheError(
            error?.message || "IndexedDB transaction failed",
            "TX_FAILED",
            error ?? undefined
        );
    }

    /**
     * Run `fn` inside one transaction. Resolves with the returned request's
     * result once the transaction has COMMITTED; rejects on error or abort.
     */
    private async tx<T = undefined>(
        mode: IDBTransactionMode,
        fn: (store: IDBObjectStore) => IDBRequest<T> | undefined
    ): Promise<T> {
        const db = await this.getDB();
        return new Promise<T>((resolve, reject) => {
            let transaction: IDBTransaction | undefined;
            let request: IDBRequest<T> | undefined;
            try {
                transaction = db.transaction(this.config.storeName, mode);
                request = fn(transaction.objectStore(this.config.storeName));
            } catch (error) {
                try {
                    transaction?.abort();
                } catch {
                    /* already finished */
                }
                reject(error);
                return;
            }
            const t = transaction;
            t.oncomplete = () => resolve(request?.result as T);
            t.onerror = () => reject(this.wrapTxError(t.error));
            t.onabort = () => reject(this.wrapTxError(t.error));
        });
    }

    private k(key: string): string {
        return buildKey(this.config.namespace, key);
    }

    private getRaw(key: string): Promise<CacheEntry | undefined> {
        return this.tx<CacheEntry | undefined>("readonly", (s) => s.get(this.k(key)));
    }

    /** Read many entries (keyed by their un-namespaced key) in a single transaction. */
    private async readRaw(keys: readonly string[]): Promise<Map<string, CacheEntry>> {
        const out = new Map<string, CacheEntry>();
        if (keys.length === 0) return out;
        await this.tx("readonly", (store) => {
            for (const key of keys) {
                const req = store.get(this.k(key));
                req.onsuccess = () => {
                    if (req.result) out.set(key, req.result as CacheEntry);
                };
            }
            return undefined;
        });
        return out;
    }

    private putRaw(key: string, val: CacheEntry): Promise<IDBValidKey> {
        return this.tx("readwrite", (s) => s.put(val, this.k(key)));
    }

    private deleteRaw(key: string): Promise<undefined> {
        return this.tx("readwrite", (s) => s.delete(this.k(key)));
    }

    /** Serialise/compress/encrypt a value into a CacheEntry (no DB write). */
    private async buildEntry(value: unknown, opt: CacheSetOptions): Promise<CacheEntry> {
        const json = JSON.stringify(value);
        if (json === undefined) {
            throw new CacheError(
                "Value cannot be cached: it is not JSON-serialisable (undefined, function or symbol)",
                "INVALID_VALUE"
            );
        }

        const rawSize = getSize(json);
        let payload: string | Uint8Array = json;
        let size = rawSize;
        let compressed = false;
        let encrypted = false;
        let encoded = false;

        if (opt.forceCompress || rawSize > this.config.compressionThreshold) {
            payload = await compress(json);
            size = payload.byteLength;
            compressed = true;
        } else if (opt.encode) {
            payload = encode(value);
            size = getSize(payload);
            encoded = true;
        }

        if (opt.encrypt) {
            // Never silently fall back to plaintext when encryption was requested.
            payload = await (await this.requireEncryption()).encrypt(payload);
            size = payload.byteLength;
            encrypted = true;
        }

        const now = Date.now();
        return {
            value: payload,
            isEncoded: encoded,
            isCompressed: compressed,
            isEncrypted: encrypted,
            createdAt: now,
            lastAccessed: now,
            accessCount: 0,
            expiresAt: calculateTTL(opt.ttl),
            size,
            originalSize: compressed ? rawSize : undefined,
            tags: opt.tags ? [...opt.tags] : [],
            metadata: opt.metadata,
            priority: opt.priority,
        };
    }

    private async evict(): Promise<void> {
        if (this.currentSize <= this.config.maxSize) return;

        const policy =
            this.config.evictionStrategy === "custom" && this.config.evictionPolicy
                ? this.config.evictionPolicy
                : createEvictionPolicy(this.config.evictionStrategy);

        const metas = Array.from(this.meta.values());
        const requested = policy.shouldEvict(metas, this.config.maxSize, this.currentSize);
        // Ignore keys a (custom) policy invented or that another call already removed.
        const keysToEvict = [...new Set(requested)].filter((fk) => this.meta.has(fk));
        if (keysToEvict.length === 0) return;

        const userKeys = keysToEvict.map((fk) => parseKey(fk, this.config.namespace));

        // Gather evicted entries for plugins BEFORE deleting (if any plugin needs them).
        const evictedEntries: CacheEntry[] = [];
        if (this.plugins.some((p) => p.onEvict)) {
            const raw = await this.readRaw(userKeys).catch(() => new Map<string, CacheEntry>());
            for (const entry of raw.values()) evictedEntries.push(entry);
        }

        await this.tx("readwrite", (store) => {
            for (const fullKey of keysToEvict) store.delete(fullKey);
            return undefined;
        });

        for (const fullKey of keysToEvict) {
            if (this.deindexEntry(fullKey) && this.config.enableStats) this.stats.evictions++;
        }

        this.emit("evict", {
            event: "evict",
            timestamp: Date.now(),
            metadata: { keys: userKeys, count: userKeys.length },
        });
        this.broadcast("evict", undefined, userKeys);

        for (const plugin of this.plugins) {
            if (plugin.onEvict) await plugin.onEvict(userKeys, evictedEntries);
        }

        if (this.config.enableStats) this.refreshCountStats();
    }

    /** Sync totalSize/entryCount stat fields from the in-memory accumulators. */
    private refreshCountStats(): void {
        if (!this.config.enableStats) return;
        this.stats.totalSize = this.currentSize;
        this.stats.entryCount = this.meta.size;
        this.recomputeRates();
    }

    private recomputeRates(): void {
        const total = this.stats.hits + this.stats.misses;
        this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
        this.stats.missRate = total > 0 ? this.stats.misses / total : 0;
    }

    private handleError(error: Error, operation = "unknown"): void {
        if (this.config.enableStats) this.stats.errors++;
        this.emit("error", { event: "error", timestamp: Date.now(), error });
        try {
            this.config.onError(error);
        } catch {
            /* a faulty onError must never break the engine */
        }
        for (const plugin of this.plugins) {
            try {
                Promise.resolve(plugin.onError?.(error, operation)).catch(() => undefined);
            } catch {
                /* ignore plugin failures while reporting */
            }
        }
    }

    private emptyStats(): CacheStats {
        return {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0,
            evictions: 0,
            errors: 0,
            totalSize: 0,
            entryCount: 0,
            hitRate: 0,
            missRate: 0,
            avgAccessTime: 0,
        };
    }

    // ==============================
    // Lifecycle
    // ==============================

    async destroy(): Promise<void> {
        this.stopAutoCleanup();
        if (this.flushIntervalId) {
            clearInterval(this.flushIntervalId);
            this.flushIntervalId = null;
        }
        if (typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", this.onVisibilityChange);
        }
        if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
            window.removeEventListener("pagehide", this.onPageHide);
        }
        await this.flushAccessMetadata().catch(() => undefined);

        this.broadcastChannel?.close();
        this.broadcastChannel = null;
        this.eventListeners.clear();
        this.plugins = [];
        this.resetIndex();
        this.inflight.clear();
        this.revalidating.clear();

        const pending = this.dbPromise;
        this.dbPromise = null;
        this.indexReady = null;
        if (pending) {
            try {
                (await pending).close();
            } catch {
                /* the connection never opened */
            }
        }
    }
}
