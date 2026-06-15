// ==============================
// CacheCraft v0.4
// Browser-first · SSR-safe · Next.js · React · TypeScript · Vanilla JS
// ==============================

// Core
export { CacheEngine } from "./cache-engine";

// Types
export type {
    CacheKey,
    CacheEntry,
    CacheEntryMeta,
    CacheSetOptions,
    CacheGetOptions,
    GetOrSetOptions,
    CacheConfig,
    CachePlugin,
    CacheEvent,
    CacheEventData,
    CacheEventListener,
    CacheStats,
    DetailedStats,
    CacheQuery,
    CacheSortField,
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
    SyncMessageType,
    StorageInfo,
    HealthStatus,
    AdminPanelData,
    SerializableCacheEntry,
    MigrationConfig,
    MonitorConfig,
    MetricData,
} from "./types";
export { toCacheKey } from "./types";

// Utilities
export {
    isClient,
    isSSR,
    isBroadcastChannelSupported,
    isWebCryptoAvailable,
    isSafari,
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
    getTimeUntilExpiry,
    formatBytes,
    formatDuration,
    formatPercentage,
    CacheError,
    QuotaExceededError,
    EncryptionError,
    UnsupportedEnvironmentError,
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
    SegmentedEvictionPolicy,
    ARCEvictionPolicy, // deprecated alias of SegmentedEvictionPolicy
    TTLEvictionPolicy,
    SizeBasedEvictionPolicy,
    createEvictionPolicy,
} from "./eviction";

// Admin Panel & Monitor
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

// ==============================
// Factory Helpers
// ==============================

import type { CacheConfig } from "./types";
import { CacheEngine } from "./cache-engine";
import { isSSR } from "./utils";

/**
 * Create a CacheEngine instance.
 *
 * @example
 * // Browser / client component
 * const cache = createCache({ dbName: 'my-app', maxSize: 50 * 1024 * 1024 });
 *
 * @example
 * // Next.js — safe to call at module level; throws only on actual usage in SSR
 * const cache = createCache();
 */
export function createCache(config?: CacheConfig): CacheEngine {
    return new CacheEngine(config);
}

/**
 * Create a CacheEngine only in browser contexts.
 * Returns `null` during SSR / server-side rendering.
 *
 * Useful in Next.js App Router where modules are evaluated on the server.
 *
 * @example
 * // app/layout.tsx (client boundary)
 * "use client";
 * const cache = createClientCache({ dbName: 'layout-cache' });
 */
export function createClientCache(config?: CacheConfig): CacheEngine | null {
    if (isSSR()) return null;
    return new CacheEngine(config);
}

// Default export for CJS / UMD consumers
export default CacheEngine;
