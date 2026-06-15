// ==============================
// CacheCraft Types — v0.4
// Browser + SSR + Next.js + React compatible
// ==============================

/** Branded type for cache keys — prevents raw string misuse */
export type CacheKey = string & { readonly __brand: "CacheKey" };

/** Helper to create a CacheKey */
export function toCacheKey(key: string): CacheKey {
    return key as CacheKey;
}

export type CacheEntry<T = unknown> = {
    value: T | string | Uint8Array;
    isEncoded: boolean;
    isCompressed: boolean;
    createdAt: number;
    lastAccessed: number;
    expiresAt?: number | undefined;
    size: number;
    isEncrypted?: boolean | undefined;
    accessCount?: number | undefined;
    tags?: readonly string[] | undefined;
    metadata?: Readonly<Record<string, unknown>> | undefined;
    priority?: number | undefined;
};

export type CacheSetOptions = {
    /** Time-to-live in milliseconds */
    ttl?: number;
    /** Base64-encode the value */
    encode?: boolean;
    /** Force gzip compression regardless of size threshold */
    forceCompress?: boolean;
    /** Encrypt the value using AES-GCM (requires encryptionKey in config) */
    encrypt?: boolean;
    /** Tags for grouping and querying entries */
    tags?: readonly string[];
    /** Arbitrary metadata stored alongside the entry */
    metadata?: Readonly<Record<string, unknown>>;
    /** Priority for eviction (higher = kept longer) */
    priority?: number;
    /** Called after the value is persisted */
    onSet?: (key: string, value: unknown) => void;
};

export type CacheGetOptions<T> = {
    /** Serve stale data while revalidating in background */
    staleWhileRevalidate?: boolean;
    /** Async function to fetch fresh data during revalidation */
    revalidate?: () => Promise<T>;
    /** TTL applied to the revalidated value */
    ttlOnRevalidate?: number;
    /** Update lastAccessed timestamp on read (default: true) */
    updateAccessTime?: boolean;
    /** Called after the value is retrieved */
    onGet?: (key: string, value: T | null) => void;
};

export type GetOrSetOptions<T> = CacheSetOptions & {
    /**
     * Serve a stale (expired) value immediately and refresh in the
     * background instead of blocking on the factory. Default: false.
     */
    staleWhileRevalidate?: boolean;
    /** TTL applied to the value produced by the background refresh. */
    ttlOnRevalidate?: number;
    /**
     * When true, a rejected factory does not throw if a stale value is
     * available — the stale value is returned instead. Default: false.
     */
    fallbackToStale?: boolean;
};

export type CacheConfig = {
    dbName?: string;
    version?: number;
    storeName?: string;
    /** Maximum total size in bytes (default: 100 MB) */
    maxSize?: number;
    /** Compress values larger than this (bytes, default: 10 KB) */
    compressionThreshold?: number;
    /** Key namespace prefix */
    namespace?: string;
    evictionStrategy?: EvictionStrategy;
    enableStats?: boolean;
    /** Sync cache operations across browser tabs via BroadcastChannel */
    enableSync?: boolean;
    /** AES-GCM encryption passphrase */
    encryptionKey?: string;
    plugins?: CachePlugin[];
    onError?: (error: Error) => void;
    /** Periodically delete expired entries */
    autoCleanup?: boolean;
    /** Auto-cleanup interval in ms (default: 60 000) */
    cleanupInterval?: number;
    /**
     * Persist access-time / access-count updates back to IndexedDB on read.
     * When false, hit metadata lives only in the in-memory index until the
     * next write, eliminating read-path write amplification. (default: true)
     */
    persistAccessMetadata?: boolean;
    /**
     * Flush buffered access-metadata writes to IndexedDB at most this often
     * (ms). Only used when persistAccessMetadata is true. (default: 1000)
     */
    accessMetadataFlushInterval?: number;
    /** Optional custom eviction policy (used when evictionStrategy is "custom"). */
    evictionPolicy?: EvictionPolicy;
};

// ==============================
// Eviction Strategies
// ==============================

export type EvictionStrategy =
    | "lru"
    | "lfu"
    | "fifo"
    | "priority"
    | "segmented"
    | "arc" // deprecated alias of "segmented" — kept for backwards-compat
    | "ttl"
    | "size"
    | "custom";

export interface EvictionPolicy {
    name: string;
    shouldEvict(
        entries: CacheEntryMeta[],
        maxSize: number,
        currentSize: number
    ): string[];
}

/**
 * Lightweight metadata view of an entry used by eviction, query filtering and
 * stats. Carries everything *except* the (potentially large) stored value, so
 * the hot paths never have to read or deserialize payloads.
 */
export type CacheEntryMeta = {
    key: string;
    size: number;
    createdAt: number;
    lastAccessed: number;
    accessCount: number;
    expiresAt?: number | undefined;
    priority?: number | undefined;
    tags?: readonly string[] | undefined;
    isCompressed: boolean;
    isEncrypted: boolean;
    isEncoded: boolean;
};

export type CacheEntryWithKey = {
    key: string;
    entry: CacheEntry;
};

// ==============================
// Plugin System
// ==============================

export interface CachePlugin {
    name: string;
    version?: string;
    beforeSet?: (
        key: string,
        value: unknown,
        options?: CacheSetOptions
    ) => Promise<boolean> | boolean;
    afterSet?: (
        key: string,
        value: unknown,
        entry: CacheEntry,
        options?: CacheSetOptions
    ) => Promise<void> | void;
    beforeGet?: (
        key: string,
        options?: CacheGetOptions<unknown>
    ) => Promise<boolean> | boolean;
    afterGet?: (
        key: string,
        value: unknown,
        entry: CacheEntry | null,
        options?: CacheGetOptions<unknown>
    ) => Promise<void> | void;
    beforeDelete?: (key: string) => Promise<boolean> | boolean;
    afterDelete?: (key: string, existed: boolean) => Promise<void> | void;
    beforeClear?: () => Promise<boolean> | boolean;
    afterClear?: (count: number) => Promise<void> | void;
    onEvict?: (keys: string[], entries: CacheEntry[]) => Promise<void> | void;
    onError?: (error: Error, operation: string) => Promise<void> | void;
}

// ==============================
// Event System
// ==============================

export type CacheEvent =
    | "set"
    | "get"
    | "delete"
    | "clear"
    | "evict"
    | "hit"
    | "miss"
    | "expire"
    | "error"
    | "sync";

export type CacheEventData = {
    event: CacheEvent;
    key?: string;
    value?: unknown;
    timestamp: number;
    metadata?: Readonly<Record<string, unknown>>;
    error?: Error;
};

export type CacheEventListener = (data: CacheEventData) => void;

// ==============================
// Statistics
// ==============================

export type CacheStats = {
    hits: number;
    misses: number;
    sets: number;
    deletes: number;
    evictions: number;
    errors: number;
    totalSize: number;
    entryCount: number;
    /** 0-1 ratio */
    hitRate: number;
    /** 0-1 ratio */
    missRate: number;
    avgAccessTime: number;
    oldestEntry?: number;
    newestEntry?: number;
    mostAccessed?: { key: string; count: number };
    largestEntry?: { key: string; size: number };
};

export type DetailedStats = CacheStats & {
    entriesByTag: Record<string, number>;
    sizeByTag: Record<string, number>;
    compressionRatio: number;
    encryptedCount: number;
    expiredCount: number;
};

// ==============================
// Query System
// ==============================

export type CacheSortField =
    | "createdAt"
    | "lastAccessed"
    | "accessCount"
    | "size"
    | "priority"
    | "expiresAt";

export type CacheQuery = {
    tags?: readonly string[];
    minPriority?: number;
    maxPriority?: number;
    minAge?: number;
    maxAge?: number;
    minSize?: number;
    maxSize?: number;
    minAccessCount?: number;
    pattern?: RegExp | string;
    expired?: boolean;
    limit?: number;
    offset?: number;
    sortBy?: CacheSortField;
    sortOrder?: "asc" | "desc";
};

export type QueryResult<T = unknown> = {
    key: string;
    value: T;
    entry: CacheEntry<T>;
    score?: number;
};

// ==============================
// Batch Operations
// ==============================

export type BatchSetItem<T = unknown> = {
    key: string;
    value: T;
    options?: CacheSetOptions;
};

export type BatchGetItem = {
    key: string;
    options?: CacheGetOptions<unknown>;
};

export type BatchResult<T = unknown> = {
    key: string;
    value: T | null;
    success: boolean;
    error?: Error;
};

// ==============================
// Export / Import
// ==============================

export type ExportOptions = {
    includeExpired?: boolean;
    filter?: (key: string, entry: CacheEntry) => boolean;
    format?: "json" | "binary";
    compress?: boolean;
};

export type ImportOptions = {
    overwrite?: boolean;
    skipInvalid?: boolean;
    merge?: boolean;
};

export type ExportData = {
    version: string;
    timestamp: number;
    entries: Record<string, CacheEntry>;
    stats?: CacheStats;
};

// ==============================
// Migration
// ==============================

export type MigrationConfig = {
    fromVersion: number;
    toVersion: number;
    transform?: (entry: CacheEntry) => CacheEntry | Promise<CacheEntry>;
    onProgress?: (current: number, total: number) => void;
};

// ==============================
// Sync System
// ==============================

export type SyncMessageType = "set" | "delete" | "clear" | "evict";

export type SyncMessage = {
    type: SyncMessageType;
    key?: string;
    value?: unknown;
    timestamp: number;
    source: string;
};

export type SyncConfig = {
    channel?: string;
    broadcastTimeout?: number;
    onSync?: (message: SyncMessage) => void;
};

// ==============================
// Admin Panel
// ==============================

export type AdminPanelData = {
    stats: DetailedStats;
    entries: QueryResult[];
    topKeys: { key: string; accessCount: number; size: number }[];
    recentActivity: CacheEventData[];
    health: {
        status: "healthy" | "warning" | "critical";
        warnings: string[];
        recommendations: string[];
    };
};

// ==============================
// Monitoring
// ==============================

export type MonitorConfig = {
    enabled: boolean;
    sampleRate?: number;
    onMetric?: (metric: MetricData) => void;
};

export type MetricData = {
    operation: string;
    duration: number;
    success: boolean;
    timestamp: number;
    metadata?: Readonly<Record<string, unknown>>;
};

// ==============================
// Storage Info
// ==============================

export type StorageInfo = {
    used: number;
    available: number;
    total: number;
    percentage: number;
    canGrow: boolean;
};

// ==============================
// Health Check
// ==============================

export type HealthStatus = {
    isHealthy: boolean;
    uptime: number;
    lastError?: Error;
    dbConnected: boolean;
    size: number;
    entryCount: number;
    issues: string[];
};

// ==============================
// Next.js / React Server Component helpers
// ==============================

/**
 * Serialisable snapshot of a CacheEntry suitable for passing from
 * Next.js Server Components / getServerSideProps to the client.
 * Uint8Array values cannot be JSON-serialised and are excluded.
 */
export type SerializableCacheEntry<T = unknown> = Omit<CacheEntry<T>, "value"> & {
    value: T extends Uint8Array ? never : T | string;
};
