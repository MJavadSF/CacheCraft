import {
    CacheConfig,
    CacheEntry,
    CacheGetOptions,
    CacheSetOptions,
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
    isClient,
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
// Main Cache Engine
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
    private readonly instanceId: string;
    private readonly startTime: number;

    constructor(cfg?: CacheConfig) {
        this.config = {
            dbName:                 cfg?.dbName                 ?? "cache-db",
            version:                cfg?.version                ?? 1,
            storeName:              cfg?.storeName              ?? "cache",
            maxSize:                cfg?.maxSize                ?? 100 * 1024 * 1024,
            compressionThreshold:   cfg?.compressionThreshold   ?? 10 * 1024,
            namespace:              cfg?.namespace              ?? "",
            evictionStrategy:       cfg?.evictionStrategy       ?? "lru",
            enableStats:            cfg?.enableStats            ?? true,
            enableSync:             cfg?.enableSync             ?? false,
            encryptionKey:          cfg?.encryptionKey          ?? "",
            plugins:                cfg?.plugins                ?? [],
            onError:                cfg?.onError                ?? (() => undefined),
            autoCleanup:            cfg?.autoCleanup            ?? true,
            cleanupInterval:        cfg?.cleanupInterval        ?? 60_000,
        };

        this.instanceId = generateId();
        this.startTime  = Date.now();

        this.stats = this.emptyStats();

        // Encryption
        if (this.config.encryptionKey) {
            this.encryption = new EncryptionManager();
            this.encryption.initialize(this.config.encryptionKey).catch((err) => {
                this.handleError(new CacheError("Encryption initialization failed", "INIT_ERROR", err as Error));
            });
        }

        // Plugins
        this.plugins = [...this.config.plugins];

        // Cross-tab sync (browser only)
        if (this.config.enableSync && !isSSR() && isBroadcastChannelSupported()) {
            this.broadcastChannel = new BroadcastChannel(
                `cachecraft-${this.config.dbName}`
            );
            this.broadcastChannel.onmessage = (event) =>
                this.handleSyncMessage(event.data as SyncMessage);
        }

        // Auto-cleanup (browser only — no setInterval on the server)
        if (this.config.autoCleanup && !isSSR()) {
            this.startAutoCleanup();
        }
    }

    // ==============================
    // Core Methods
    // ==============================

    async set<T>(key: string, value: T, opt?: CacheSetOptions): Promise<void> {
        const timer = new PerformanceTimer();

        try {
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

            // Compression
            if (opt?.forceCompress || size > this.config.compressionThreshold) {
                final      = await compress(json);
                size       = (final as Uint8Array).byteLength;
                compressed = true;
            } else if (opt?.encode) {
                final = encode(value);
                size  = getSize(final);
            }

            // Encryption
            if (opt?.encrypt && this.encryption?.isInitialized()) {
                const toEncrypt =
                    typeof final === "string" ? final : JSON.stringify(Array.from(final as Uint8Array));
                final     = await this.encryption.encrypt(toEncrypt);
                size      = (final as Uint8Array).byteLength;
                encrypted = true;
            }

            const entry: CacheEntry = {
                value: final,
                isEncoded:    opt?.encode ?? false,
                isCompressed: compressed,
                isEncrypted:  encrypted,
                createdAt:    Date.now(),
                lastAccessed: Date.now(),
                accessCount:  0,
                expiresAt: (calculateTTL(opt?.ttl) ?? 0) as number,
                size,
                tags: opt?.tags ?? [],
                metadata:     opt?.metadata,
                priority:     opt?.priority,
            };

            await this.putRaw(key, entry);
            await this.evict();

            if (this.config.enableStats) {
                this.stats.sets++;
                await this.updateStats();
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
            for (const plugin of this.plugins) {
                if (plugin.beforeGet) {
                    const proceed = await plugin.beforeGet(key, opt as CacheGetOptions<unknown>);
                    if (proceed === false) return null;
                }
            }

            const entry = await this.getRaw(key);

            if (!entry) {
                if (this.config.enableStats) {
                    this.stats.misses++;
                    await this.updateStats();
                }
                this.emit("miss", { event: "miss", key, timestamp: Date.now() });
                for (const plugin of this.plugins) {
                    if (plugin.afterGet) await plugin.afterGet(key, null, null, opt as CacheGetOptions<unknown>);
                }
                return null;
            }

            const expired = isExpired(entry.expiresAt);

            if (!expired && (opt?.updateAccessTime ?? true)) {
                entry.lastAccessed = Date.now();
                entry.accessCount  = (entry.accessCount ?? 0) + 1;
                await this.putRaw(key, entry);
            }

            // Stale-while-revalidate
            if (expired && opt?.staleWhileRevalidate && opt.revalidate) {
                opt.revalidate().then((v) =>
                    this.set(key, v, { ttl: opt.ttlOnRevalidate })
                ).catch((err: Error) => this.handleError(err));
            }

            if (expired && !opt?.staleWhileRevalidate) {
                await this.deleteRaw(key);
                this.emit("expire", { event: "expire", key, timestamp: Date.now() });
                if (this.config.enableStats) {
                    this.stats.misses++;
                    await this.updateStats();
                }
                return null;
            }

            // Decrypt → decompress → decode → parse
            let v: unknown = entry.value;

            if (entry.isEncrypted && this.encryption?.isInitialized()) {
                v = await this.encryption.decrypt(v as Uint8Array);
            }

            if (entry.isCompressed) {
                v = await decompress(v as Uint8Array);
            }

            if (entry.isEncoded) {
                v = decode(v as string);
            }

            const result: T = typeof v === "string" ? (JSON.parse(v) as T) : (v as T);

            if (this.config.enableStats) {
                this.stats.hits++;
                this.stats.avgAccessTime =
                    (this.stats.avgAccessTime + timer.elapsed()) / 2;
                await this.updateStats();
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

    async remove(key: string): Promise<boolean> {
        try {
            for (const plugin of this.plugins) {
                if (plugin.beforeDelete) {
                    const proceed = await plugin.beforeDelete(key);
                    if (proceed === false) return false;
                }
            }

            const existed = (await this.getRaw(key)) !== undefined;
            await this.deleteRaw(key);

            if (this.config.enableStats && existed) {
                this.stats.deletes++;
                await this.updateStats();
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
            for (const plugin of this.plugins) {
                if (plugin.beforeClear) {
                    const proceed = await plugin.beforeClear();
                    if (proceed === false) return 0;
                }
            }

            const count = await this.count();
            await this.tx("readwrite", (s) => s.clear());

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
    // Blob helpers
    // ==============================

    async setBlob(key: string, blob: Blob, opt?: CacheSetOptions): Promise<void> {
        const uint8 = new Uint8Array(await blob.arrayBuffer());

        const entry: CacheEntry<Uint8Array> = {
            value:        uint8,
            isEncoded:    false,
            isCompressed: false,
            isEncrypted:  false,
            createdAt:    Date.now(),
            lastAccessed: Date.now(),
            accessCount:  0,
            expiresAt:    calculateTTL(opt?.ttl) as number | undefined,
            size:         uint8.byteLength,
            tags:         opt?.tags,
            metadata:     opt?.metadata,
            priority:     opt?.priority,
        };

        await this.putRaw(key, entry);
        await this.evict();
    }

    async getBlob(key: string, type = "application/octet-stream"): Promise<Blob | null> {
        const entry = await this.getRaw(key);
        if (!entry) return null;

        if (isExpired(entry.expiresAt)) {
            await this.deleteRaw(key);
            return null;
        }

        entry.lastAccessed = Date.now();
        entry.accessCount  = (entry.accessCount ?? 0) + 1;
        await this.putRaw(key, entry);

        if (entry.value instanceof Uint8Array) {
            return new Blob([entry.value as BlobPart], { type });
        }

        return null;
    }

    // ==============================
    // Advanced Methods
    // ==============================

    async has(key: string): Promise<boolean> {
        const entry = await this.getRaw(key);
        if (!entry) return false;
        if (isExpired(entry.expiresAt)) {
            await this.deleteRaw(key);
            return false;
        }
        return true;
    }

    async size(): Promise<number> {
        const entries = await this.getAllEntries();
        return entries.reduce((sum, e) => sum + e.entry.size, 0);
    }

    async count(): Promise<number> {
        const db = await this.getDB();
        return new Promise<number>((resolve, reject) => {
            const tx      = db.transaction(this.config.storeName, "readonly");
            const store   = tx.objectStore(this.config.storeName);
            const request = store.count();
            request.onsuccess = () => resolve(request.result);
            request.onerror   = () => reject(request.error);
        });
    }

    async keys(pattern?: RegExp | string): Promise<string[]> {
        const entries = await this.getAllEntries();
        let ks = entries.map((e) => parseKey(e.key, this.config.namespace));
        if (pattern) ks = ks.filter((k) => matchesPattern(k, pattern));
        return ks;
    }

    // ==============================
    // Batch Operations (parallel with Promise.allSettled)
    // ==============================

    async batchSet<T>(items: BatchSetItem<T>[]): Promise<BatchResult<T>[]> {
        const settled = await Promise.allSettled(
            items.map((item) => this.set(item.key, item.value, item.options))
        );

        return items.map((item, i) => {
            const result = settled[i]!;
            if (result.status === "fulfilled") {
                return { key: item.key, value: item.value, success: true };
            }
            return { key: item.key, value: null, success: false, error: result.reason as Error };
        });
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
        const settled = await Promise.allSettled(keys.map((k) => this.remove(k)));

        return keys.map((key, i) => {
            const result = settled[i]!;
            if (result.status === "fulfilled") {
                return { key, value: null, success: result.value };
            }
            return { key, value: null, success: false, error: result.reason as Error };
        });
    }

    // ==============================
    // Query System
    // ==============================

    async query<T>(query: CacheQuery): Promise<QueryResult<T>[]> {
        let entries = await this.getAllEntries();

        if (query.tags?.length) {
            entries = entries.filter((e) => {
                const entryTags = e.entry.tags ?? [];
                return query.tags!.some((tag) => entryTags.includes(tag));
            });
        }

        if (query.minPriority !== undefined)
            entries = entries.filter((e) => (e.entry.priority ?? 0) >= query.minPriority!);
        if (query.maxPriority !== undefined)
            entries = entries.filter((e) => (e.entry.priority ?? 0) <= query.maxPriority!);
        if (query.minAge !== undefined)
            entries = entries.filter((e) => getAge(e.entry.createdAt) >= query.minAge!);
        if (query.maxAge !== undefined)
            entries = entries.filter((e) => getAge(e.entry.createdAt) <= query.maxAge!);
        if (query.minSize !== undefined)
            entries = entries.filter((e) => e.entry.size >= query.minSize!);
        if (query.maxSize !== undefined)
            entries = entries.filter((e) => e.entry.size <= query.maxSize!);
        if (query.minAccessCount !== undefined)
            entries = entries.filter((e) => (e.entry.accessCount ?? 0) >= query.minAccessCount!);
        if (query.pattern)
            entries = entries.filter((e) => matchesPattern(e.key, query.pattern!));
        if (query.expired !== undefined) {
            entries = entries.filter((e) =>
                query.expired ? isExpired(e.entry.expiresAt) : !isExpired(e.entry.expiresAt)
            );
        }

        if (query.sortBy) {
            const dir = query.sortOrder === "desc" ? -1 : 1;
            entries.sort((a, b) => {
                let aVal: number, bVal: number;
                switch (query.sortBy) {
                    case "createdAt":    aVal = a.entry.createdAt;           bVal = b.entry.createdAt;           break;
                    case "lastAccessed": aVal = a.entry.lastAccessed;        bVal = b.entry.lastAccessed;        break;
                    case "accessCount":  aVal = a.entry.accessCount ?? 0;    bVal = b.entry.accessCount ?? 0;    break;
                    case "size":         aVal = a.entry.size;                bVal = b.entry.size;                break;
                    case "priority":     aVal = a.entry.priority ?? 0;       bVal = b.entry.priority ?? 0;       break;
                    case "expiresAt":    aVal = a.entry.expiresAt ?? Infinity; bVal = b.entry.expiresAt ?? Infinity; break;
                    default:             aVal = 0; bVal = 0;
                }
                return (aVal - bVal) * dir;
            });
        }

        if (query.offset) entries = entries.slice(query.offset);
        if (query.limit)  entries = entries.slice(0, query.limit);

        const results: QueryResult<T>[] = [];
        for (const item of entries) {
            try {
                const key   = parseKey(item.key, this.config.namespace);
                const value = await this.get<T>(key, { updateAccessTime: false });
                if (value !== null) {
                    results.push({ key, value, entry: item.entry as CacheEntry<T> });
                }
            } catch {
                // Skip failed entries
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
        const entries = await this.getAllEntries();

        const entriesByTag: Record<string, number> = {};
        const sizeByTag: Record<string, number>    = {};
        let compressedSize   = 0;
        let uncompressedSize = 0;
        let encryptedCount   = 0;
        let expiredCount     = 0;
        let oldestEntry: number | undefined;
        let newestEntry: number | undefined;
        let mostAccessed: { key: string; count: number }  | undefined;
        let largestEntry:  { key: string; size: number }  | undefined;

        for (const { key, entry } of entries) {
            for (const tag of entry.tags ?? []) {
                entriesByTag[tag] = (entriesByTag[tag] ?? 0) + 1;
                sizeByTag[tag]    = (sizeByTag[tag]    ?? 0) + entry.size;
            }

            if (entry.isCompressed) compressedSize   += entry.size;
            else                    uncompressedSize += entry.size;

            if (entry.isEncrypted) encryptedCount++;
            if (isExpired(entry.expiresAt)) expiredCount++;

            if (!oldestEntry || entry.createdAt < oldestEntry) oldestEntry = entry.createdAt;
            if (!newestEntry || entry.createdAt > newestEntry) newestEntry = entry.createdAt;

            const accessCount = entry.accessCount ?? 0;
            if (!mostAccessed || accessCount > mostAccessed.count) {
                mostAccessed = { key: parseKey(key, this.config.namespace), count: accessCount };
            }
            if (!largestEntry || entry.size > largestEntry.size) {
                largestEntry = { key: parseKey(key, this.config.namespace), size: entry.size };
            }
        }

        const compressionRatio =
            compressedSize > 0 ? uncompressedSize / (compressedSize + uncompressedSize) : 0;

        return {
            ...this.stats,
            entriesByTag,
            sizeByTag,
            compressionRatio,
            encryptedCount,
            expiredCount,
            oldestEntry,
            newestEntry,
            mostAccessed,
            largestEntry,
        };
    }

    resetStats(): void {
        this.stats = this.emptyStats();
    }

    // ==============================
    // Export / Import
    // ==============================

    async export(options?: ExportOptions): Promise<ExportData> {
        const entries = await this.getAllEntries();
        const exportEntries: Record<string, CacheEntry> = {};

        for (const item of entries) {
            const key = parseKey(item.key, this.config.namespace);
            if (!options?.includeExpired && isExpired(item.entry.expiresAt)) continue;
            if (options?.filter && !options.filter(key, item.entry)) continue;
            exportEntries[key] = item.entry;
        }

        const data: ExportData = {
            version: "0.3.0",
            timestamp: Date.now(),
            entries: exportEntries,
        };
        if (this.config.enableStats) {
            data.stats = this.getStats();
        }

        return data;
    }

    async import(data: ExportData, options?: ImportOptions): Promise<number> {
        let imported = 0;
        for (const [key, entry] of Object.entries(data.entries)) {
            try {
                if (!options?.overwrite && !options?.merge && (await this.has(key))) continue;
                await this.putRaw(key, entry);
                imported++;
            } catch (error) {
                if (!options?.skipInvalid) throw error;
            }
        }
        return imported;
    }

    // ==============================
    // Cleanup & Maintenance
    // ==============================

    async cleanup(): Promise<number> {
        const entries = await this.getAllEntries();
        let cleaned = 0;
        for (const item of entries) {
            if (isExpired(item.entry.expiresAt)) {
                await this.deleteRaw(parseKey(item.key, this.config.namespace));
                cleaned++;
            }
        }
        return cleaned;
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

    async getStorageInfo(): Promise<StorageInfo> {
        if (
            isSSR() ||
            typeof navigator === "undefined" ||
            !navigator.storage?.estimate
        ) {
            return { used: 0, available: 0, total: 0, percentage: 0, canGrow: false };
        }

        const estimate  = await navigator.storage.estimate();
        const used      = estimate.usage  ?? 0;
        const total     = estimate.quota  ?? 0;
        const available = total - used;
        const percentage = total > 0 ? used / total : 0;

        return {
            used,
            available,
            total,
            percentage,
            canGrow: typeof navigator.storage.persist === 'function'
                ? await navigator.storage.persist()
                : true,
        };
    }

    async getHealth(): Promise<HealthStatus> {
        const issues: string[] = [];

        try {
            const storageInfo  = await this.getStorageInfo();
            const currentSize  = await this.size();
            const entryCount   = await this.count();

            if (storageInfo.percentage > 0.9)
                issues.push("Storage usage above 90%");
            if (currentSize > this.config.maxSize * 0.9)
                issues.push("Cache size near configured limit");

            return {
                isHealthy:   issues.length === 0,
                uptime:      Date.now() - this.startTime,
                dbConnected: true,
                size:        currentSize,
                entryCount,
                issues,
            };
        } catch (error) {
            return {
                isHealthy:   false,
                uptime:      Date.now() - this.startTime,
                dbConnected: false,
                size:        0,
                entryCount:  0,
                issues:      ["Database connection failed"],
                lastError:   error as Error,
            };
        }
    }

    // ==============================
    // Plugin System
    // ==============================

    use(plugin: CachePlugin): void {
        this.plugins.push(plugin);
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
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, new Set());
        }
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
            try {
                listener(data);
            } catch (error) {
                this.handleError(error as Error);
            }
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
                        const entry = await this.getRaw(message.key);
                        if (entry) {
                            this.emit("sync", {
                                event:     "sync",
                                key:       message.key,
                                timestamp: message.timestamp,
                            });
                        }
                    }
                    break;
                case "delete":
                    if (message.key) await this.deleteRaw(message.key);
                    break;
                case "clear":
                    await this.tx("readwrite", (s) => s.clear());
                    break;
            }
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

                // Handle connection being force-closed (e.g. version bump in another tab)
                req.onblocked = () => {
                    this.handleError(
                        new CacheError("IndexedDB upgrade blocked by another tab", "IDB_BLOCKED")
                    );
                };
            });

            // Reset on unexpected close so the next call reopens the DB
            this.dbPromise.then((db) => {
                db.onclose = () => { this.dbPromise = null; };
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
                        if (req) {
                            req.onsuccess = () => { result = req.result as T; };
                        }
                    } catch (e) {
                        reject(e);
                        return;
                    }

                    tx.oncomplete = () => resolve(result);
                    tx.onerror    = () => reject(tx.error);
                    tx.onabort    = () => reject(new CacheError("Transaction aborted", "TX_ABORTED"));
                })
        );
    }

    private k(key: string): string {
        return buildKey(this.config.namespace, key);
    }

    private getRaw(key: string): Promise<CacheEntry | undefined> {
        return this.tx<CacheEntry | undefined>("readonly", (s) => s.get(this.k(key)));
    }

    private putRaw(key: string, val: CacheEntry): Promise<void> {
        return this.tx("readwrite", (s) => s.put(val, this.k(key)));
    }

    private deleteRaw(key: string): Promise<void> {
        return this.tx("readwrite", (s) => s.delete(this.k(key)));
    }

    private getAllEntries(): Promise<CacheEntryWithKey[]> {
        return this.getDB().then(
            (db) =>
                new Promise<CacheEntryWithKey[]>((resolve) => {
                    const tx      = db.transaction(this.config.storeName, "readonly");
                    const store   = tx.objectStore(this.config.storeName);
                    const entries: CacheEntryWithKey[] = [];

                    store.openCursor().onsuccess = (e) => {
                        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
                        if (!cursor) return resolve(entries);
                        entries.push({ key: cursor.key as string, entry: cursor.value as CacheEntry });
                        cursor.continue();
                    };
                })
        );
    }

    private async evict(): Promise<void> {
        const entries     = await this.getAllEntries();
        const currentSize = entries.reduce((sum, e) => sum + e.entry.size, 0);
        if (currentSize <= this.config.maxSize) return;

        const policy      = createEvictionPolicy(this.config.evictionStrategy);
        const keysToEvict = policy.shouldEvict(entries, this.config.maxSize, currentSize);

        for (const key of keysToEvict) {
            await this.deleteRaw(parseKey(key, this.config.namespace));
            if (this.config.enableStats) this.stats.evictions++;
        }

        if (keysToEvict.length > 0) {
            this.emit("evict", {
                event:     "evict",
                timestamp: Date.now(),
                metadata:  { keys: keysToEvict, count: keysToEvict.length },
            });

            for (const plugin of this.plugins) {
                if (plugin.onEvict) {
                    const evictedEntries = entries
                        .filter((e) => keysToEvict.includes(e.key))
                        .map((e) => e.entry);
                    await plugin.onEvict(keysToEvict, evictedEntries);
                }
            }
        }

        await this.updateStats();
    }

    private async updateStats(): Promise<void> {
        if (!this.config.enableStats) return;
        this.stats.totalSize  = await this.size();
        this.stats.entryCount = await this.count();
        const total           = this.stats.hits + this.stats.misses;
        this.stats.hitRate    = total > 0 ? this.stats.hits   / total : 0;
        this.stats.missRate   = total > 0 ? this.stats.misses / total : 0;
    }

    private handleError(error: Error): void {
        if (this.config.enableStats) this.stats.errors++;

        this.emit("error", { event: "error", timestamp: Date.now(), error });
        this.config.onError(error);

        for (const plugin of this.plugins) {
            plugin.onError?.(error, "unknown");
        }
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
        this.broadcastChannel?.close();
        this.eventListeners.clear();
        this.plugins = [];

        if (this.dbPromise) {
            const db    = await this.dbPromise;
            db.close();
            this.dbPromise = null;
        }
    }
}
