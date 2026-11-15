// ==============================
// CacheCraft
// Browser-first · Workers · SSR-safe · React · Vue · Svelte · TypeScript
// ==============================

import { CacheEngine } from "./cache-engine";
import type { CacheConfig } from "./types";
import { isSSR } from "./utils";

// Admin Panel & Monitor
export { CacheAdminPanel, CacheMonitor } from "./admin";
// Core
export { CacheEngine } from "./cache-engine";
export { getRegisteredEngines, onRegistryChange } from "./core/registry";
// Crypto
export { DEFAULT_KDF_ITERATIONS, deriveKey, keyFingerprint } from "./crypto";
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
// Locks
export { isWebLocksSupported, withWebLock } from "./locks";
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
// Serializers
export { jsonSerializer, richSerializer } from "./serializer";
// Storage adapters
export {
    hasIndexedDB,
    IndexedDBAdapter,
    isOPFSSupported,
    MemoryAdapter,
    OPFSAdapter,
    type StorageAdapter,
    type StorageFactory,
    type StorageFactoryContext,
    type StoredMeta,
    type StoredPayload,
    type StoredRecord,
    WebStorageAdapter,
    type WebStorageLike,
    type WriteOp,
    type WriteResult,
} from "./storage";
// Typed facade
export { createTypedCache, type TypedCache } from "./typed";
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
    CacheFactory,
    CacheGetOptions,
    CachePlugin,
    CachePluginHost,
    CacheQuery,
    CacheSetOptions,
    CacheSortField,
    CacheStats,
    CompressionAlgorithm,
    CompressionConfig,
    CrossTabConfig,
    DetailedStats,
    Duration,
    DurationUnit,
    EngineInfo,
    EntryInfo,
    EvictionPolicy,
    EvictionStrategy,
    ExportData,
    ExportedEntry,
    ExportedPayload,
    ExportOptions,
    FactoryContext,
    GetOrSetOptions,
    HealthStatus,
    ImportOptions,
    LatencySummary,
    LegacyExportData,
    LegacyMode,
    MemoryCacheConfig,
    MetricData,
    MonitorConfig,
    QueryResult,
    RetryOptions,
    Serializer,
    Size,
    SizeUnit,
    StandardSchemaResult,
    StandardSchemaV1,
    StorageInfo,
    StorageOption,
    SyncMessage,
    SyncMessageType,
    TagQuota,
} from "./types";
// Utilities
export {
    base64ToBytes,
    buildKey,
    bytesToBase64,
    CacheError,
    calculateTTL,
    compress,
    compressBytes,
    debounce,
    decode,
    decompress,
    decompressBytes,
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
    isCompressionSupported,
    isExpired,
    isGzip,
    isSafari,
    isSSR,
    isWebCryptoAvailable,
    matchesPattern,
    PerformanceTimer,
    parseDuration,
    parseKey,
    parseSize,
    QuotaExceededError,
    SchemaValidationError,
    TimeoutError,
    throttle,
    toError,
    UnsupportedEnvironmentError,
    VERSION,
} from "./utils";

// ==============================
// Factory Helpers
// ==============================

/**
 * Create a CacheEngine. Safe to call during SSR — nothing touches storage until
 * the first operation (which throws `UnsupportedEnvironmentError` on a server
 * with the default IndexedDB storage).
 */
export function createCache(config?: CacheConfig): CacheEngine {
    return new CacheEngine(config);
}

/** A CacheEngine in browser contexts, `null` during SSR. */
export function createClientCache(config?: CacheConfig): CacheEngine | null {
    if (isSSR()) return null;
    return new CacheEngine(config);
}

// Default export for CJS / UMD consumers
export default CacheEngine;
