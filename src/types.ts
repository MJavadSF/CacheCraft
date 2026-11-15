// ==============================
// CacheCraft Types
// Browser · Web/Service Workers · SSR-safe · React · Vue · Svelte
// ==============================

import type { StorageAdapter, StorageFactory } from "./storage/types";

// ==============================
// Primitives
// ==============================

export type DurationUnit = "ms" | "s" | "m" | "h" | "d" | "w";

/**
 * A duration: milliseconds as a number, or a string such as `"500ms"`, `"30s"`,
 * `"5m"`, `"2h"`, `"7d"`, `"1w"` — compound forms like `"1h30m"` are accepted too.
 */
export type Duration = number | `${number}${DurationUnit}` | (string & {});

export type SizeUnit = "B" | "KB" | "MB" | "GB";

/** A byte size: a number of bytes, or a string such as `"512KB"`, `"50MB"`, `"1GB"`. */
export type Size = number | `${number}${SizeUnit}` | (string & {});

/** Built-in compression formats (all supported by `CompressionStream`). */
export type CompressionAlgorithm = "gzip" | "deflate" | "deflate-raw";

/**
 * Minimal Standard Schema v1 interface (https://standardschema.dev) — implemented
 * by Zod 3.24+, Valibot 1+, ArkType 2+ and others. No runtime dependency.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (
            value: unknown
        ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
        readonly types?: { readonly input: Input; readonly output: Output } | undefined;
    };
}

export type StandardSchemaResult<Output> =
    | { readonly value: Output; readonly issues?: undefined }
    | {
          readonly issues: ReadonlyArray<{
              readonly message: string;
              readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
          }>;
      };

/** Converts values to/from a string. Entries remember which serializer wrote them. */
export interface Serializer {
    /** Stable identifier stored with every entry (e.g. `"rich"`, `"json"`, `"superjson"`). */
    readonly name: string;
    serialize(value: unknown): string;
    deserialize(text: string): unknown;
}

// ==============================
// Entries
// ==============================

/**
 * Persisted metadata of an entry — everything except the payload. Kept in a
 * separate object store so start-up, eviction, queries and stats never read
 * payloads.
 */
export type CacheEntryMeta = {
    /** The (namespace-free) key. */
    key: string;
    /** Stored size in bytes (after compression / encryption). */
    size: number;
    /** Serialized size in bytes before compression. Only set for compressed entries. */
    originalSize?: number | undefined;
    createdAt: number;
    lastAccessed: number;
    accessCount: number;
    expiresAt?: number | undefined;
    /** The TTL (ms) the entry was written with — reused by `touch()` and revalidation. */
    ttl?: number | undefined;
    priority?: number | undefined;
    tags?: readonly string[] | undefined;
    metadata?: Readonly<Record<string, unknown>> | undefined;
    isCompressed: boolean;
    isEncrypted: boolean;
    /** Legacy Base64 obfuscation (`encode: true`). */
    isEncoded: boolean;
    /** Compression format; `undefined` = not compressed (or a ≤0.5 gzip entry). */
    compression?: CompressionAlgorithm | undefined;
    /** Name of the serializer that wrote the payload. */
    serializer?: string | undefined;
    /** Identifies the encryption key; `undefined` on encrypted entries = ≤0.5 key. */
    keyId?: string | undefined;
    /** `schemaVersion` that was configured when the entry was written. */
    schemaVersion?: number | undefined;
    /** `"blob"` for entries written with `setBlob`. */
    kind?: "value" | "blob" | undefined;
    mimeType?: string | undefined;
};

/**
 * Plugin- and query-facing view of a stored entry. `value` is the *stored*
 * payload (possibly compressed / encrypted); use the decoded value passed next
 * to it in hooks and query results.
 */
export type CacheEntry<T = unknown> = Omit<CacheEntryMeta, "key" | "accessCount"> & {
    value: T | string | Uint8Array;
    accessCount?: number | undefined;
};

export type CacheEntryWithKey = {
    key: string;
    entry: CacheEntry;
};

/** Metadata returned next to a value by {@link CacheEngine.getWithMeta}. */
export type EntryInfo = {
    key: string;
    createdAt: number;
    lastAccessed: number;
    accessCount: number;
    expiresAt?: number | undefined;
    /** Milliseconds since the entry was written. */
    age: number;
    /** Milliseconds until expiry (`null` = never expires, `0` = expired). */
    ttlRemaining: number | null;
    /** True when the entry is past its expiry (only possible with `allowStale`). */
    stale: boolean;
    size: number;
    tags: readonly string[];
    metadata?: Readonly<Record<string, unknown>> | undefined;
    priority?: number | undefined;
    isCompressed: boolean;
    isEncrypted: boolean;
};

// ==============================
// Options
// ==============================

export type CacheSetOptions = {
    /** Time-to-live (`60_000`, `"5m"`, `"1h30m"`…). Falls back to `defaultTTL`. */
    ttl?: Duration;
    /**
     * Randomly shorten the TTL by up to this fraction (0–1) so that entries written
     * together do not all expire together. Default: config `ttlJitter` (0).
     */
    ttlJitter?: number;
    /**
     * @deprecated Base64 "encoding" is obfuscation, not security, and grows the
     * payload by ~33 %. Use `encrypt: true`. Still supported for reading and writing.
     */
    encode?: boolean;
    /** Compress regardless of the size threshold. */
    forceCompress?: boolean;
    /** `false` disables compression for this entry. */
    compress?: boolean;
    /** Encrypt with AES-GCM (requires `encryptionKey`). */
    encrypt?: boolean;
    /** Tags for grouping, querying and invalidation. */
    tags?: readonly string[];
    /** Arbitrary metadata stored alongside the entry (not encrypted). */
    metadata?: Readonly<Record<string, unknown>>;
    /** Eviction priority — higher is kept longer (used by the `priority` strategy). */
    priority?: number;
    /** Called after the value is persisted. */
    onSet?: (key: string, value: unknown) => void;
};

export type CacheGetOptions<T> = {
    /** Serve an expired value (and optionally `revalidate` it in the background). */
    staleWhileRevalidate?: boolean;
    /** Produces a fresh value in the background when a stale one is served. */
    revalidate?: () => Promise<T>;
    /** TTL of the revalidated value (default: the entry's original TTL). */
    ttlOnRevalidate?: Duration;
    /** Count this read for LRU/LFU (default: true). */
    updateAccessTime?: boolean;
    /**
     * Validate (and optionally transform) the cached value. On failure the
     * entry is deleted and the read is a miss.
     */
    schema?: StandardSchemaV1<unknown, T>;
    /** Called after the lookup (`null` on a miss). */
    onGet?: (key: string, value: T | null) => void;
};

export type RetryOptions = {
    /** Extra attempts after the first failure. Default: 2. */
    retries?: number;
    /** Delay before the first retry. Default: 200 ms. */
    delay?: Duration;
    /** Backoff multiplier. Default: 2. */
    factor?: number;
    /** Upper bound for a single delay. Default: 10 s. */
    maxDelay?: Duration;
    /** Return `false` to stop retrying for this error. */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
};

/** Context passed to a `getOrSet` factory. Older zero-argument factories keep working. */
export type FactoryContext<T> = {
    key: string;
    /** Aborted on `timeout`, or when every caller waiting on this factory gave up. */
    signal: AbortSignal;
    /** 1 for the first attempt, 2 for the first retry… */
    attempt: number;
    /** The expired value, when one exists (useful for conditional requests). */
    stale: T | undefined;
};

export type CacheFactory<T> = (context: FactoryContext<T>) => Promise<T> | T;

export type GetOrSetOptions<T> = CacheSetOptions & {
    /** Serve an expired value immediately and refresh in the background. */
    staleWhileRevalidate?: boolean;
    /** TTL of the value produced by a background refresh. */
    ttlOnRevalidate?: Duration;
    /** Return an expired value instead of throwing when the factory fails. */
    fallbackToStale?: boolean;
    /** Never serve a value that expired longer ago than this (SWR / fallback). */
    maxStale?: Duration;
    /** Skip the cache and run the factory (the result is still stored). */
    forceRefresh?: boolean;
    /** Abort waiting (the factory keeps running for other callers). */
    signal?: AbortSignal;
    /** Fail with `TimeoutError` (and abort the factory's signal) after this long. */
    timeout?: Duration;
    /** Retry a failing factory with exponential backoff. A number = `retries`. */
    retry?: number | RetryOptions;
    /**
     * Single-flight across browser tabs (Web Locks): only one tab runs the factory,
     * the others wait and read its result. Default: config `crossTab.singleFlight`.
     */
    crossTab?: boolean;
    /** Validate cached values; invalid ones are treated as a miss. */
    schema?: StandardSchemaV1<unknown, T>;
};

// ==============================
// Config
// ==============================

export type MemoryCacheConfig = {
    /** Max decoded values kept in memory. Default: 500. */
    maxEntries?: number;
    /** Approximate byte budget (serialized size). Default: 10 MB. */
    maxSize?: Size;
    /**
     * `structuredClone` values going in and out of the memory tier so callers can
     * mutate what they get. Default: false (treat cached values as immutable).
     */
    clone?: boolean;
};

export type CompressionConfig = {
    /** Default: `"gzip"`. */
    algorithm?: CompressionAlgorithm;
    /** Compress serialized values larger than this. Default: 10 KB. */
    threshold?: Size;
    /**
     * Keep the uncompressed form when `compressed / original` is above this
     * (already-compressed data such as images). Default: 0.9.
     */
    minRatio?: number;
};

export type TagQuota = {
    maxEntries?: number;
    maxSize?: Size;
};

export type CrossTabConfig = {
    /** Default for `getOrSet({ crossTab })`. Default: false. */
    singleFlight?: boolean;
    /** Only one tab runs `autoCleanup` (Web Locks leader election). Default: true. */
    leaderCleanup?: boolean;
};

export type StorageOption =
    | "indexeddb"
    | "memory"
    | "localStorage"
    | "sessionStorage"
    | "opfs"
    | StorageAdapter
    | StorageFactory;

export type LegacyMode =
    /** Move ≤0.5 entries into the 1.x layout on first read (default). */
    | "migrate"
    /** Leave ≤0.5 data untouched and never read it. */
    | "ignore";

export type CacheConfig = {
    /** Database name. Default: `"cache-db"`. */
    dbName?: string;
    /** Logical store name inside the database. Default: `"cache"`. */
    storeName?: string;
    /** @deprecated Object stores are created automatically; this is ignored. */
    version?: number;
    /** Key namespace. Namespaces never see, count, evict or clear each other's keys. */
    namespace?: string;
    /** Storage backend. Default: `"indexeddb"`. */
    storage?: StorageOption;

    /** Byte budget of this namespace (default: 100 MB). */
    maxSize?: Size;
    /** Entry budget of this namespace (default: unlimited). */
    maxEntries?: number;
    /** Per-tag budgets, e.g. `{ images: { maxSize: "20MB" } }`. */
    tagQuotas?: Readonly<Record<string, TagQuota>>;
    evictionStrategy?: EvictionStrategy;
    /** Used when `evictionStrategy` is `"custom"`. */
    evictionPolicy?: EvictionPolicy;
    /**
     * When over budget, evict down to this fraction of it (0–1) so the next writes
     * don't evict again immediately. Default: 0.9.
     */
    evictionTarget?: number;

    /** Default TTL for `set`/`getOrSet` without one. Default: none (never expires). */
    defaultTTL?: Duration;
    /** Default `ttlJitter` (0–1). */
    ttlJitter?: number;

    /** @deprecated Use `compression.threshold`. */
    compressionThreshold?: Size;
    /** `false` disables compression. */
    compression?: CompressionConfig | false;
    /**
     * How values are turned into strings. `"rich"` (default) round-trips `Date`,
     * `Map`, `Set`, `BigInt`, `RegExp`, `URL`, typed arrays, `NaN`/`±Infinity`,
     * `-0` and `undefined`; `"json"` is plain `JSON.stringify`.
     */
    serializer?: "rich" | "json" | Serializer;
    /** Extra serializers able to *read* entries written by them. */
    serializers?: readonly Serializer[];

    /** AES-GCM key: a passphrase (PBKDF2-derived) or a non-extractable `CryptoKey`. */
    encryptionKey?: string | CryptoKey;
    /** Older keys that can still decrypt (for rotation). */
    decryptionKeys?: ReadonlyArray<string | CryptoKey>;
    /** PBKDF2-SHA-256 iterations for passphrases. Default: 600 000 (OWASP 2023+). */
    kdfIterations?: number;

    /** Version of the shape of your cached values. */
    schemaVersion?: number;
    /**
     * Upgrade a value written under another `schemaVersion`. Without it, such
     * entries are dropped (treated as misses).
     */
    migrate?: (value: unknown, fromVersion: number, key: string) => unknown | Promise<unknown>;

    /** In-memory tier in front of the storage (decoded values). Default: off. */
    memoryCache?: MemoryCacheConfig | boolean;

    enableStats?: boolean;
    /** Keep tabs/engines coherent via BroadcastChannel. Default: true. */
    enableSync?: boolean;
    crossTab?: CrossTabConfig;
    /**
     * When a key is missing from the in-memory index, check storage before
     * reporting a miss (another tab or engine may have written it). Default: true.
     */
    readThrough?: boolean;
    /** On a quota error, evict and retry the write once. Default: true. */
    quotaRecovery?: boolean;
    /** What to do with data written by CacheCraft ≤0.5. Default: `"migrate"`. */
    legacy?: LegacyMode;

    /** Plugin instances, or factories (called once per engine, incl. `namespace()`). */
    plugins?: ReadonlyArray<CachePlugin | (() => CachePlugin)>;
    onError?: (error: Error) => void;
    /** Periodically delete expired entries. Default: true. */
    autoCleanup?: boolean;
    /** Default: `"1m"`. */
    cleanupInterval?: Duration;
    /** Persist access time / count (for LRU/LFU across reloads). Default: true. */
    persistAccessMetadata?: boolean;
    /** Default: 1 s. */
    accessMetadataFlushInterval?: Duration;
    /** Show this engine in `mountDevtools()` auto-discovery. Default: true. */
    devtools?: boolean;
    /** Human-readable label (devtools, errors). */
    label?: string;
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
    | "arc" // deprecated alias of "segmented"
    | "ttl"
    | "size"
    | "custom";

export interface EvictionPolicy {
    name: string;
    /**
     * Keys to evict to bring `currentSize` down to `maxSize` (the engine passes its
     * eviction *target*). Entries carry namespace-free keys.
     */
    shouldEvict(entries: CacheEntryMeta[], maxSize: number, currentSize: number): string[];
    /**
     * Optional: entries ordered most-evictable first. Used for entry-count and
     * tag budgets; policies without it fall back to LRU order there.
     */
    rank?(entries: CacheEntryMeta[]): CacheEntryMeta[];
}

// ==============================
// Plugin System
// ==============================

/** The slice of the engine that plugins may use (passed to {@link CachePlugin.init}). */
export interface CachePluginHost {
    set(key: string, value: unknown, options?: CacheSetOptions): Promise<void>;
    has(key: string): Promise<boolean>;
    readonly namespace: string;
}

export interface CachePlugin {
    name: string;
    version?: string;
    /** Called once per engine the plugin is registered with. */
    init?: (host: CachePluginHost) => void;
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
    beforeGet?: (key: string, options?: CacheGetOptions<unknown>) => Promise<boolean> | boolean;
    /**
     * Called after a lookup (`entry` is `null` on a miss). A plugin may assign a
     * new `entry.expiresAt` to extend or shorten the lifetime; the engine persists it.
     */
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
    | "sync"
    /** Emitted after every timed operation: `metadata = { operation, duration, success }`. */
    | "operation";

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
    /** Mean duration of a cache hit (ms). */
    avgAccessTime: number;
    /** Hits served by the in-memory tier. */
    memoryHits: number;
    oldestEntry?: number;
    newestEntry?: number;
    mostAccessed?: { key: string; count: number };
    largestEntry?: { key: string; size: number };
};

export type LatencySummary = {
    count: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
};

export type DetailedStats = CacheStats & {
    entriesByTag: Record<string, number>;
    sizeByTag: Record<string, number>;
    /** Stored / original size across compressed entries (0-1; lower is better; 0 = none). */
    compressionRatio: number;
    encryptedCount: number;
    expiredCount: number;
    /** Latency of recent operations (ms), from a rolling window. */
    latency: Record<string, LatencySummary>;
    memoryEntries: number;
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
    | "expiresAt"
    | "key";

export type CacheQuery = {
    tags?: readonly string[];
    /** `"any"` (default) or `"all"` of `tags`. */
    tagMode?: "any" | "all";
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
    /**
     * Export decrypted values so they can be imported into a cache with another
     * key. Default: false (encrypted entries stay encrypted).
     */
    decrypt?: boolean;
};

export type ImportOptions = {
    /** Replace existing keys. */
    overwrite?: boolean;
    /** @deprecated Same as `overwrite`. */
    merge?: boolean;
    /** Skip malformed entries instead of throwing. */
    skipInvalid?: boolean;
    /** Encrypt imported plaintext entries. */
    encrypt?: boolean;
};

/** A JSON-safe stored payload. Bytes are Base64-encoded. */
export type ExportedPayload = string | { readonly b64: string };

export type ExportedEntry = {
    key: string;
    meta: Omit<CacheEntryMeta, "key">;
    payload: ExportedPayload;
};

/** Portable export format (JSON-safe). */
export type ExportData = {
    format: "cachecraft";
    formatVersion: 2;
    /** Library version that produced the export. */
    version: string;
    timestamp: number;
    namespace: string;
    /** Base64 PBKDF2 salt of the source database (lets passphrase-encrypted entries move). */
    salt?: string;
    entries: ExportedEntry[];
    stats?: CacheStats;
};

/** The ≤0.5 export shape — still accepted by `import()`. */
export type LegacyExportData = {
    version: string;
    timestamp: number;
    entries: Record<string, CacheEntry>;
    stats?: CacheStats;
};

// ==============================
// Sync System
// ==============================

export type SyncMessageType = "set" | "delete" | "clear" | "evict";

export type SyncMessage = {
    type: SyncMessageType;
    key?: string;
    /** Affected keys of `evict` / bulk messages. */
    keys?: string[];
    /** Namespace of the sending engine; engines ignore other namespaces. */
    namespace: string;
    /** Logical store of the sending engine. */
    store: string;
    timestamp: number;
    source: string;
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
// Storage Info / Health
// ==============================

export type StorageInfo = {
    used: number;
    available: number;
    total: number;
    /** 0-1 */
    percentage: number;
    /** True when the origin has persistent storage (won't be evicted by the browser). */
    persisted: boolean;
    /** @deprecated Same as `persisted`. */
    canGrow: boolean;
};

export type HealthStatus = {
    isHealthy: boolean;
    uptime: number;
    lastError?: Error;
    dbConnected: boolean;
    size: number;
    entryCount: number;
    issues: string[];
};

/** Identity of an engine (devtools, errors). */
export type EngineInfo = {
    id: string;
    label: string;
    dbName: string;
    storeName: string;
    namespace: string;
    storage: string;
    persistent: boolean;
};
