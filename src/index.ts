// ==============================
// CacheCraft v2.0 - Professional Edition
// ==============================

// Core
export { CacheEngine } from "./cache-engine";

// Types
export type {
    CacheEntry,
    CacheSetOptions,
    CacheGetOptions,
    CacheConfig,
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
    EvictionStrategy,
    EvictionPolicy,
    CacheEntryWithKey,
    SyncMessage,
    StorageInfo,
    HealthStatus,
    AdminPanelData,
} from "./types";

// Utilities
export {
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
    formatBytes,
    formatDuration,
    formatPercentage,
    CacheError,
    QuotaExceededError,
    EncryptionError,
    PerformanceTimer,
    debounce,
    throttle,
    deepClone,
    generateId,
} from "./utils";

// Eviction Policies
export {
    LRUEvictionPolicy,
    LFUEvictionPolicy,
    FIFOEvictionPolicy,
    PriorityEvictionPolicy,
    ARCEvictionPolicy,
    TTLEvictionPolicy,
    SizeBasedEvictionPolicy,
    createEvictionPolicy,
} from "./eviction";

// Admin Panel
export { CacheAdminPanel, CacheMonitor } from "./admin";

// Built-in Plugins
export {
    LoggerPlugin,
    MetricsPlugin,
    ValidationPlugin,
    TTLRefreshPlugin,
    CompressionOptimizerPlugin,
    TagManagerPlugin,
    RateLimiterPlugin,
    PrefetchPlugin,
    WarmupPlugin,
    PersistencePlugin,
    AnalyticsPlugin,
    DebugPlugin,
} from "./plugins";

// Import for helper function
import type { CacheConfig } from "./types";
import { CacheEngine } from "./cache-engine";

// Helper factory function
export function createCache(config?: CacheConfig): CacheEngine {
    return new CacheEngine(config);
}

// Default export
export default CacheEngine;