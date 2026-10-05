// ==============================
// CacheCraft
// Browser-first · SSR-safe · Next.js · React · TypeScript · Vanilla JS
// ==============================

// Admin Panel & Monitor
export { CacheAdminPanel, CacheMonitor } from "./admin";
// Core
export { CacheEngine } from "./cache-engine";
// Eviction Policies
export {
    ARCEvictionPolicy, // deprecated alias of SegmentedEvictionPolicy
    createEvictionPolicy,
    FIFOEvictionPolicy,
    LFUEvictionPolicy,
    LRUEvictionPolicy,
    PriorityEvictionPolicy,
    SegmentedEvictionPolicy,
    SizeBasedEvictionPolicy,
    TTLEvictionPolicy,
} from "./eviction";
// Built-in Plugins
export {
    AnalyticsPlugin,
    CompressionOptimizerPlugin,
    DebugPlugin,
    LoggerPlugin,
    MetricsPlugin,
    PersistencePlugin,
    PrefetchPlugin,
    RateLimiterPlugin,
    TagManagerPlugin,
    TTLRefreshPlugin,
    ValidationPlugin,
    WarmupPlugin,
} from "./plugins";
// Types
export type {
    AdminPanelData,
    BatchGetItem,
    BatchResult,
    BatchSetItem,
    CacheConfig,
    CacheEntry,
    CacheEntryMeta,
    CacheEntryWithKey,
    CacheEvent,
    CacheEventData,
    CacheEventListener,
    CacheGetOptions,
    CacheKey,
    CachePlugin,
    CachePluginHost,
    CacheQuery,
    CacheSetOptions,
    CacheSortField,
    CacheStats,
    DetailedStats,
    EvictionPolicy,
    EvictionStrategy,
    ExportData,
    ExportOptions,
    GetOrSetOptions,
    HealthStatus,
    ImportOptions,
    MetricData,
    MigrationConfig,
    MonitorConfig,
    QueryResult,
    SerializableCacheEntry,
    StorageInfo,
    SyncConfig,
    SyncMessage,
    SyncMessageType,
} from "./types";
export { toCacheKey } from "./types";
// Utilities
export {
    buildKey,
    CacheError,
    calculateTTL,
    compress,
    debounce,
    decode,
    decompress,
    deepClone,
    EncryptionError,
    EncryptionManager,
    encode,
    formatBytes,
    formatDuration,
    formatPercentage,
    generateId,
    getAge,
    getSize,
    getTimeUntilExpiry,
    isBroadcastChannelSupported,
    isClient,
    isExpired,
    isGzip,
    isSafari,
    isSSR,
    isWebCryptoAvailable,
    matchesPattern,
    PerformanceTimer,
    parseKey,
    QuotaExceededError,
    throttle,
    toError,
    UnsupportedEnvironmentError,
    VERSION,
} from "./utils";

// ==============================
// Factory Helpers
// ==============================

import { CacheEngine } from "./cache-engine";
import type { CacheConfig } from "./types";
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
