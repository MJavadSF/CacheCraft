// ==============================
// BACKWARD COMPATIBLE - Original Types
// ==============================

export type CacheEntry<T = any> = {
    value: T | string | Uint8Array;
    isEncoded: boolean;
    isCompressed: boolean;
    createdAt: number;
    lastAccessed: number;
    expiresAt?: number;
    size: number;
    // NEW: Optional fields (won't break existing data)
    isEncrypted?: boolean;
    accessCount?: number;
    tags?: string[];
    metadata?: Record<string, any>;
    priority?: number;
};

export type CacheSetOptions = {
    ttl?: number;
    encode?: boolean;
    forceCompress?: boolean;
    // NEW: Additional options
    encrypt?: boolean;
    tags?: string[];
    metadata?: Record<string, any>;
    priority?: number;
    onSet?: (key: string, value: any) => void;
};

export type CacheGetOptions<T> = {
    staleWhileRevalidate?: boolean;
    revalidate?: () => Promise<T>;
    ttlOnRevalidate?: number;
    // NEW: Additional options
    updateAccessTime?: boolean;
    onGet?: (key: string, value: T | null) => void;
};

export type CacheConfig = {
    dbName?: string;
    version?: number;
    storeName?: string;
    maxSize?: number;
    compressionThreshold?: number;
    namespace?: string;
    // NEW: Advanced configuration
    evictionStrategy?: EvictionStrategy;
    enableStats?: boolean;
    enableSync?: boolean;
    encryptionKey?: string;
    plugins?: CachePlugin[];
    onError?: (error: Error) => void;
    autoCleanup?: boolean;
    cleanupInterval?: number;
};

// ==============================
// Eviction Strategies
// ==============================

export type EvictionStrategy = "lru" | "lfu" | "fifo" | "priority" | "custom";

export interface EvictionPolicy {
    name: string;
    shouldEvict(entries: CacheEntryWithKey[], maxSize: number, currentSize: number): string[];
}

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
    beforeSet?: (key: string, value: any, options?: CacheSetOptions) => Promise<boolean> | boolean;
    afterSet?: (key: string, value: any, entry: CacheEntry, options?: CacheSetOptions) => Promise<void> | void;
    beforeGet?: (key: string, options?: CacheGetOptions<any>) => Promise<boolean> | boolean;
    afterGet?: (key: string, value: any, entry: CacheEntry | null, options?: CacheGetOptions<any>) => Promise<void> | void;
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
    value?: any;
    timestamp: number;
    metadata?: Record<string, any>;
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
    hitRate: number;
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

export type CacheQuery = {
    tags?: string[];
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
    sortBy?: "createdAt" | "lastAccessed" | "accessCount" | "size" | "priority" | "expiresAt";
    sortOrder?: "asc" | "desc";
};

export type QueryResult<T = any> = {
    key: string;
    value: T;
    entry: CacheEntry<T>;
    score?: number;
};

// ==============================
// Batch Operations
// ==============================

export type BatchSetItem<T = any> = {
    key: string;
    value: T;
    options?: CacheSetOptions;
};

export type BatchGetItem = {
    key: string;
    options?: CacheGetOptions<any>;
};

export type BatchResult<T = any> = {
    key: string;
    value: T | null;
    success: boolean;
    error?: Error;
};

// ==============================
// Export/Import
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

export type SyncMessage = {
    type: "set" | "delete" | "clear" | "evict";
    key?: string;
    value?: any;
    timestamp: number;
    source: string;
};

export type SyncConfig = {
    channel?: string;
    broadcastTimeout?: number;
    onSync?: (message: SyncMessage) => void;
};

// ==============================
// Admin Panel Data
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
    metadata?: Record<string, any>;
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
