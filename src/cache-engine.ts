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
    debounce,
    generateId,
    CacheError,
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
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;
    private instanceId: string;
    private startTime: number;

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
            onError: cfg?.onError ?? (() => {}),
            autoCleanup: cfg?.autoCleanup ?? true,
            cleanupInterval: cfg?.cleanupInterval ?? 60000, // 1 minute
        };

        this.instanceId = generateId();
        this.startTime = Date.now();

        // Initialize stats
        this.stats = {
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

        // Initialize encryption if key provided
        if (this.config.encryptionKey) {
            this.encryption = new EncryptionManager();
            this.encryption.initialize(this.config.encryptionKey).catch((err) => {
                this.handleError(new CacheError("Encryption initialization failed", "INIT_ERROR", err));
            });
        }

        // Register plugins
        if (this.config.plugins.length > 0) {
            this.plugins = this.config.plugins;
        }

        // Initialize sync
        if (this.config.enableSync && typeof BroadcastChannel !== "undefined") {
            this.broadcastChannel = new BroadcastChannel(`cachecraft-${this.config.dbName}`);
            this.broadcastChannel.onmessage = (event) => this.handleSyncMessage(event.data);
        }

        // Start auto cleanup
        if (this.config.autoCleanup) {
            this.startAutoCleanup();
        }
    }

    // ==============================
    // Core Methods (Backward Compatible)
    // ==============================

    async set<T>(key: string, value: T, opt?: CacheSetOptions): Promise<void> {
        const timer = new PerformanceTimer();

        try {
            // Run beforeSet plugins
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
            let encrypted = false;

            // Compression
            if (opt?.forceCompress || size > this.config.compressionThreshold) {
                final = await compress(json);
                size = final.byteLength;
                compressed = true;
            } else if (opt?.encode) {
                final = encode(value);
                size = getSize(final);
            }

            // Encryption
            if (opt?.encrypt && this.encryption?.isInitialized()) {
                const toEncrypt = typeof final === "string" ? final : JSON.stringify(final);
                final = await this.encryption.encrypt(toEncrypt);
                size = final.byteLength;
                encrypted = true;
            }

            const entry: CacheEntry = {
                value: final,
                isEncoded: opt?.encode ?? false,
                isCompressed: compressed,
                isEncrypted: encrypted,
                createdAt: Date.now(),
                lastAccessed: Date.now(),
                accessCount: 0,
                expiresAt: calculateTTL(opt?.ttl),
                size,
                tags: opt?.tags,
                metadata: opt?.metadata,
                priority: opt?.priority,
            };

            await this.putRaw(key, entry);
            await this.evict();

            // Update stats
            if (this.config.enableStats) {
                this.stats.sets++;
                this.updateStats();
            }

            // Run afterSet plugins
            for (const plugin of this.plugins) {
                if (plugin.afterSet) {
                    await plugin.afterSet(key, value, entry, opt);
                }
            }

            // Emit event
            this.emit("set", { event: "set", key, value, timestamp: Date.now() });

            // Callback
            if (opt?.onSet) {
                opt.onSet(key, value);
            }

            // Broadcast sync
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
            // Run beforeGet plugins
            for (const plugin of this.plugins) {
                if (plugin.beforeGet) {
                    const proceed = await plugin.beforeGet(key, opt);
                    if (proceed === false) return null;
                }
            }

            const entry = await this.getRaw(key);

            if (!entry) {
                if (this.config.enableStats) {
                    this.stats.misses++;
                    this.updateStats();
                }
                this.emit("miss", { event: "miss", key, timestamp: Date.now() });

                // Run afterGet plugins
                for (const plugin of this.plugins) {
                    if (plugin.afterGet) {
                        await plugin.afterGet(key, null, null, opt);
                    }
                }

                return null;
            }

            const now = Date.now();
            const expired = isExpired(entry.expiresAt);

            // Update access time and count
            if (!expired && (opt?.updateAccessTime ?? true)) {
                entry.lastAccessed = now;
                entry.accessCount = (entry.accessCount || 0) + 1;
                await this.putRaw(key, entry);
            }

            // Handle stale-while-revalidate
            if (expired && opt?.staleWhileRevalidate && opt.revalidate) {
                opt.revalidate().then((v) =>
                    this.set(key, v, {
                        ttl: opt.ttlOnRevalidate,
                    })
                );
            }

            // Delete if expired and not using stale-while-revalidate
            if (expired && !opt?.staleWhileRevalidate) {
                await this.deleteRaw(key);
                this.emit("expire", { event: "expire", key, timestamp: Date.now() });

                if (this.config.enableStats) {
                    this.stats.misses++;
                    this.updateStats();
                }

                return null;
            }

            // Decrypt, decompress, decode
            let v: any = entry.value;

            if (entry.isEncrypted && this.encryption?.isInitialized()) {
                v = await this.encryption.decrypt(v as Uint8Array);
            }

            if (entry.isCompressed) {
                v = await decompress(v as Uint8Array);
            }

            if (entry.isEncoded) {
                v = decode(v as string);
            }

            const result: T = typeof v === "string" ? JSON.parse(v) : v;

            // Update stats
            if (this.config.enableStats) {
                this.stats.hits++;
                this.stats.avgAccessTime = (this.stats.avgAccessTime + timer.elapsed()) / 2;
                this.updateStats();
            }

            // Emit event
            this.emit("hit", { event: "hit", key, value: result, timestamp: Date.now() });
            this.emit("get", { event: "get", key, value: result, timestamp: Date.now() });

            // Run afterGet plugins
            for (const plugin of this.plugins) {
                if (plugin.afterGet) {
                    await plugin.afterGet(key, result, entry, opt);
                }
            }

            // Callback
            if (opt?.onGet) {
                opt.onGet(key, result);
            }

            return result;
        } catch (error) {
            this.handleError(error as Error);
            throw error;
        }
    }

    async remove(key: string): Promise<boolean> {
        try {
            // Run beforeDelete plugins
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
                this.updateStats();
            }

            // Run afterDelete plugins
            for (const plugin of this.plugins) {
                if (plugin.afterDelete) {
                    await plugin.afterDelete(key, existed);
                }
            }

            this.emit("delete", { event: "delete", key, timestamp: Date.now() });

            // Broadcast sync
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
            // Run beforeClear plugins
            for (const plugin of this.plugins) {
                if (plugin.beforeClear) {
                    const proceed = await plugin.beforeClear();
                    if (proceed === false) return 0;
                }
            }

            const count = await this.count();
            await this.tx("readwrite", (s) => s.clear());

            if (this.config.enableStats) {
                this.stats = {
                    ...this.stats,
                    entryCount: 0,
                    totalSize: 0,
                };
            }

            // Run afterClear plugins
            for (const plugin of this.plugins) {
                if (plugin.afterClear) {
                    await plugin.afterClear(count);
                }
            }

            this.emit("clear", { event: "clear", timestamp: Date.now(), metadata: { count } });

            // Broadcast sync
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
        return new CacheEngine({
            ...this.config,
            namespace: ns,
        });
    }

    // Backward compatible blob methods
    async setBlob(key: string, blob: Blob, opt?: CacheSetOptions): Promise<void> {
        const arrayBuffer = await blob.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);

        const entry: CacheEntry<Uint8Array> = {
            value: uint8,
            isEncoded: false,
            isCompressed: false,
            isEncrypted: false,
            createdAt: Date.now(),
            lastAccessed: Date.now(),
            accessCount: 0,
            expiresAt: calculateTTL(opt?.ttl),
            size: uint8.byteLength,
            tags: opt?.tags,
            metadata: opt?.metadata,
            priority: opt?.priority,
        };

        await this.putRaw(key, entry);
        await this.evict();
    }

    async getBlob(key: string): Promise<Blob | null> {
        const entry = await this.getRaw(key);
        if (!entry) return null;

        const now = Date.now();
        if (isExpired(entry.expiresAt)) {
            await this.deleteRaw(key);
            return null;
        }

        entry.lastAccessed = now;
        entry.accessCount = (entry.accessCount || 0) + 1;
        await this.putRaw(key, entry);

        if (entry.value instanceof Uint8Array) {
            // @ts-ignore
            return new Blob([entry.value], { type: "image/jpeg" });
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
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.config.storeName, "readonly");
            const store = tx.objectStore(this.config.storeName);
            const request = store.count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async keys(pattern?: RegExp | string): Promise<string[]> {
        const entries = await this.getAllEntries();
        let keys = entries.map((e) => parseKey(e.key, this.config.namespace));

        if (pattern) {
            keys = keys.filter((k) => matchesPattern(k, pattern));
        }

        return keys;
    }

    // ==============================
    // Batch Operations
    // ==============================

    async batchSet<T>(items: BatchSetItem<T>[]): Promise<BatchResult<T>[]> {
        const results: BatchResult<T>[] = [];

        for (const item of items) {
            try {
                await this.set(item.key, item.value, item.options);
                results.push({ key: item.key, value: item.value, success: true });
            } catch (error) {
                results.push({
                    key: item.key,
                    value: null,
                    success: false,
                    error: error as Error,
                });
            }
        }

        return results;
    }

    async batchGet<T>(items: BatchGetItem[]): Promise<BatchResult<T>[]> {
        const results: BatchResult<T>[] = [];

        for (const item of items) {
            try {
                const value = await this.get<T>(item.key, item.options);
                results.push({ key: item.key, value, success: true });
            } catch (error) {
                results.push({
                    key: item.key,
                    value: null,
                    success: false,
                    error: error as Error,
                });
            }
        }

        return results;
    }

    async batchDelete(keys: string[]): Promise<BatchResult<null>[]> {
        const results: BatchResult<null>[] = [];

        for (const key of keys) {
            try {
                const success = await this.remove(key);
                results.push({ key, value: null, success });
            } catch (error) {
                results.push({
                    key,
                    value: null,
                    success: false,
                    error: error as Error,
                });
            }
        }

        return results;
    }

    // ==============================
    // Query System
    // ==============================

    async query<T>(query: CacheQuery): Promise<QueryResult<T>[]> {
        let entries = await this.getAllEntries();
        const now = Date.now();

        // Filter by tags
        if (query.tags && query.tags.length > 0) {
            entries = entries.filter((e) => {
                const entryTags = e.entry.tags || [];
                return query.tags!.some((tag) => entryTags.includes(tag));
            });
        }

        // Filter by priority
        if (query.minPriority !== undefined) {
            entries = entries.filter((e) => (e.entry.priority ?? 0) >= query.minPriority!);
        }
        if (query.maxPriority !== undefined) {
            entries = entries.filter((e) => (e.entry.priority ?? 0) <= query.maxPriority!);
        }

        // Filter by age
        if (query.minAge !== undefined) {
            entries = entries.filter((e) => getAge(e.entry.createdAt) >= query.minAge!);
        }
        if (query.maxAge !== undefined) {
            entries = entries.filter((e) => getAge(e.entry.createdAt) <= query.maxAge!);
        }

        // Filter by size
        if (query.minSize !== undefined) {
            entries = entries.filter((e) => e.entry.size >= query.minSize!);
        }
        if (query.maxSize !== undefined) {
            entries = entries.filter((e) => e.entry.size <= query.maxSize!);
        }

        // Filter by access count
        if (query.minAccessCount !== undefined) {
            entries = entries.filter((e) => (e.entry.accessCount ?? 0) >= query.minAccessCount!);
        }

        // Filter by pattern
        if (query.pattern) {
            entries = entries.filter((e) => matchesPattern(e.key, query.pattern!));
        }

        // Filter by expired
        if (query.expired !== undefined) {
            entries = entries.filter((e) => {
                const expired = isExpired(e.entry.expiresAt);
                return query.expired ? expired : !expired;
            });
        }

        // Sort
        if (query.sortBy) {
            entries.sort((a, b) => {
                let aVal: number, bVal: number;

                switch (query.sortBy) {
                    case "createdAt":
                        aVal = a.entry.createdAt;
                        bVal = b.entry.createdAt;
                        break;
                    case "lastAccessed":
                        aVal = a.entry.lastAccessed;
                        bVal = b.entry.lastAccessed;
                        break;
                    case "accessCount":
                        aVal = a.entry.accessCount ?? 0;
                        bVal = b.entry.accessCount ?? 0;
                        break;
                    case "size":
                        aVal = a.entry.size;
                        bVal = b.entry.size;
                        break;
                    case "priority":
                        aVal = a.entry.priority ?? 0;
                        bVal = b.entry.priority ?? 0;
                        break;
                    case "expiresAt":
                        aVal = a.entry.expiresAt ?? Infinity;
                        bVal = b.entry.expiresAt ?? Infinity;
                        break;
                    default:
                        aVal = 0;
                        bVal = 0;
                }

                return query.sortOrder === "desc" ? bVal - aVal : aVal - bVal;
            });
        }

        // Offset and limit
        if (query.offset) {
            entries = entries.slice(query.offset);
        }
        if (query.limit) {
            entries = entries.slice(0, query.limit);
        }

        // Fetch values
        const results: QueryResult<T>[] = [];
        for (const item of entries) {
            try {
                const key = parseKey(item.key, this.config.namespace);
                const value = await this.get<T>(key, { updateAccessTime: false });
                if (value !== null) {
                    results.push({ key, value, entry: item.entry });
                }
            } catch (error) {
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
        const now = Date.now();

        const entriesByTag: Record<string, number> = {};
        const sizeByTag: Record<string, number> = {};
        let compressedSize = 0;
        let uncompressedSize = 0;
        let encryptedCount = 0;
        let expiredCount = 0;

        let oldestEntry: number | undefined;
        let newestEntry: number | undefined;
        let mostAccessed: { key: string; count: number } | undefined;
        let largestEntry: { key: string; size: number } | undefined;

        for (const item of entries) {
            const { entry } = item;

            // Tags
            if (entry.tags) {
                for (const tag of entry.tags) {
                    entriesByTag[tag] = (entriesByTag[tag] || 0) + 1;
                    sizeByTag[tag] = (sizeByTag[tag] || 0) + entry.size;
                }
            }

            // Compression
            if (entry.isCompressed) {
                compressedSize += entry.size;
            } else {
                uncompressedSize += entry.size;
            }

            // Encryption
            if (entry.isEncrypted) {
                encryptedCount++;
            }

            // Expired
            if (isExpired(entry.expiresAt)) {
                expiredCount++;
            }

            // Oldest/newest
            if (!oldestEntry || entry.createdAt < oldestEntry) {
                oldestEntry = entry.createdAt;
            }
            if (!newestEntry || entry.createdAt > newestEntry) {
                newestEntry = entry.createdAt;
            }

            // Most accessed
            const accessCount = entry.accessCount ?? 0;
            if (!mostAccessed || accessCount > mostAccessed.count) {
                mostAccessed = {
                    key: parseKey(item.key, this.config.namespace),
                    count: accessCount,
                };
            }

            // Largest
            if (!largestEntry || entry.size > largestEntry.size) {
                largestEntry = {
                    key: parseKey(item.key, this.config.namespace),
                    size: entry.size,
                };
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
        this.stats = {
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
    // Export/Import
    // ==============================

    async export(options?: ExportOptions): Promise<ExportData> {
        const entries = await this.getAllEntries();
        const exportEntries: Record<string, CacheEntry> = {};

        for (const item of entries) {
            const key = parseKey(item.key, this.config.namespace);
            const { entry } = item;

            // Skip expired if needed
            if (!options?.includeExpired && isExpired(entry.expiresAt)) {
                continue;
            }

            // Apply filter
            if (options?.filter && !options.filter(key, entry)) {
                continue;
            }

            exportEntries[key] = entry;
        }

        return {
            version: "2.0.0",
            timestamp: Date.now(),
            entries: exportEntries,
            stats: this.config.enableStats ? this.getStats() : undefined,
        };
    }

    async import(data: ExportData, options?: ImportOptions): Promise<number> {
        let imported = 0;

        for (const [key, entry] of Object.entries(data.entries)) {
            try {
                // Check if exists
                const exists = await this.has(key);

                if (exists && !options?.overwrite && !options?.merge) {
                    continue;
                }

                await this.putRaw(key, entry);
                imported++;
            } catch (error) {
                if (!options?.skipInvalid) {
                    throw error;
                }
            }
        }

        return imported;
    }

    // ==============================
    // Cleanup & Maintenance
    // ==============================

    async cleanup(): Promise<number> {
        const entries = await this.getAllEntries();
        const now = Date.now();
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
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        this.cleanupInterval = setInterval(() => {
            this.cleanup().catch((err) => this.handleError(err));
        }, this.config.cleanupInterval);
    }

    stopAutoCleanup(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    async getStorageInfo(): Promise<StorageInfo> {
        if (!navigator.storage || !navigator.storage.estimate) {
            return {
                used: 0,
                available: 0,
                total: 0,
                percentage: 0,
                canGrow: false,
            };
        }

        const estimate = await navigator.storage.estimate();
        const used = estimate.usage || 0;
        const total = estimate.quota || 0;
        const available = total - used;
        const percentage = total > 0 ? used / total : 0;

        return {
            used,
            available,
            total,
            percentage,
            canGrow: !navigator.storage.persist || (await navigator.storage.persisted()),
        };
    }

    async getHealth(): Promise<HealthStatus> {
        const issues: string[] = [];

        try {
            const storageInfo = await this.getStorageInfo();
            const currentSize = await this.size();
            const entryCount = await this.count();

            // Check storage
            if (storageInfo.percentage > 0.9) {
                issues.push("Storage usage above 90%");
            }

            // Check cache size
            if (currentSize > this.config.maxSize * 0.9) {
                issues.push("Cache size near limit");
            }

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
        const listeners = this.eventListeners.get(event);
        if (listeners) {
            listeners.delete(listener);
        }
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
        if (listeners) {
            listeners.forEach((listener) => {
                try {
                    listener(data);
                } catch (error) {
                    this.handleError(error as Error);
                }
            });
        }
    }

    // ==============================
    // Sync System
    // ==============================

    private broadcast(message: SyncMessage): void {
        if (this.broadcastChannel) {
            this.broadcastChannel.postMessage(message);
        }
    }

    private async handleSyncMessage(message: SyncMessage): Promise<void> {
        // Ignore own messages
        if (message.source === this.instanceId) return;

        try {
            switch (message.type) {
                case "set":
                    // Refresh from DB
                    if (message.key) {
                        const entry = await this.getRaw(message.key);
                        if (entry) {
                            this.emit("sync", {
                                event: "sync",
                                key: message.key,
                                timestamp: message.timestamp,
                            });
                        }
                    }
                    break;
                case "delete":
                    // Local delete without broadcast
                    if (message.key) {
                        await this.deleteRaw(message.key);
                    }
                    break;
                case "clear":
                    // Local clear without broadcast
                    await this.tx("readwrite", (s) => s.clear());
                    break;
            }
        } catch (error) {
            this.handleError(error as Error);
        }
    }

    // ==============================
    // Private Methods
    // ==============================

    private async getDB(): Promise<IDBDatabase> {
        if (!isClient()) throw new CacheError("IndexedDB unsupported", "UNSUPPORTED");

        if (!this.dbPromise) {
            this.dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(this.config.dbName, this.config.version);

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

    private k(key: string): string {
        return buildKey(this.config.namespace, key);
    }

    private async getRaw(key: string): Promise<CacheEntry | undefined> {
        return this.tx<CacheEntry>("readonly", (s) => s.get(this.k(key)));
    }

    private async putRaw(key: string, val: CacheEntry): Promise<void> {
        return this.tx("readwrite", (s) => s.put(val, this.k(key)));
    }

    private async deleteRaw(key: string): Promise<void> {
        return this.tx("readwrite", (s) => s.delete(this.k(key)));
    }

    private async getAllEntries(): Promise<CacheEntryWithKey[]> {
        const db = await this.getDB();
        const tx = db.transaction(this.config.storeName, "readonly");
        const store = tx.objectStore(this.config.storeName);

        const entries: CacheEntryWithKey[] = [];

        return new Promise((resolve) => {
            store.openCursor().onsuccess = (e: any) => {
                const cursor = e.target.result;
                if (!cursor) return resolve(entries);

                entries.push({
                    key: cursor.key as string,
                    entry: cursor.value,
                });

                cursor.continue();
            };
        });
    }

    private async evict(): Promise<void> {
        const entries = await this.getAllEntries();
        const currentSize = entries.reduce((sum, e) => sum + e.entry.size, 0);

        if (currentSize <= this.config.maxSize) return;

        const policy = createEvictionPolicy(this.config.evictionStrategy);
        const keysToEvict = policy.shouldEvict(entries, this.config.maxSize, currentSize);

        for (const key of keysToEvict) {
            await this.deleteRaw(parseKey(key, this.config.namespace));

            if (this.config.enableStats) {
                this.stats.evictions++;
            }
        }

        // Emit eviction event
        if (keysToEvict.length > 0) {
            this.emit("evict", {
                event: "evict",
                timestamp: Date.now(),
                metadata: { keys: keysToEvict, count: keysToEvict.length },
            });

            // Run plugin callbacks
            for (const plugin of this.plugins) {
                if (plugin.onEvict) {
                    const evictedEntries = entries
                        .filter((e) => keysToEvict.includes(e.key))
                        .map((e) => e.entry);
                    await plugin.onEvict(keysToEvict, evictedEntries);
                }
            }
        }

        this.updateStats();
    }

    private async updateStats(): Promise<void> {
        if (!this.config.enableStats) return;

        const currentSize = await this.size();
        const entryCount = await this.count();

        this.stats.totalSize = currentSize;
        this.stats.entryCount = entryCount;

        const total = this.stats.hits + this.stats.misses;
        this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
        this.stats.missRate = total > 0 ? this.stats.misses / total : 0;
    }

    private handleError(error: Error): void {
        if (this.config.enableStats) {
            this.stats.errors++;
        }

        this.emit("error", {
            event: "error",
            timestamp: Date.now(),
            error,
        });

        if (this.config.onError) {
            this.config.onError(error);
        }

        // Run plugin error handlers
        for (const plugin of this.plugins) {
            if (plugin.onError) {
                plugin.onError(error, "unknown");
            }
        }
    }

    // ==============================
    // Lifecycle
    // ==============================

    async destroy(): Promise<void> {
        this.stopAutoCleanup();

        if (this.broadcastChannel) {
            this.broadcastChannel.close();
        }

        this.eventListeners.clear();
        this.plugins = [];

        if (this.dbPromise) {
            const db = await this.dbPromise;
            db.close();
            this.dbPromise = null;
        }
    }
}