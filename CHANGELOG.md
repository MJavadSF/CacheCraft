# Changelog

All notable changes to CacheCraft will be documented in this file.

## [0.4.0] - 2026-06-15

### ⚡ Performance & Ergonomics Release — Backward Compatible

### Added
- **In-memory metadata index** — every entry's lightweight metadata (size, timestamps,
  access count, tags, flags) is held in memory and hydrated once on first DB open.
  `size()`, `count()`, `keys()`, eviction, query pre-filtering and tag lookups no longer
  scan IndexedDB or deserialize payloads.
- **`getOrSet(key, factory, options?)`** — cache-aside helper with single-flight
  **stampede protection** (concurrent misses share one factory call), plus
  `staleWhileRevalidate`, `ttlOnRevalidate` and `fallbackToStale`.
- **Tag invalidation API** — `invalidateByTag()`, `invalidateByTags()`, `keysByTag()`,
  `allTags()`, backed by an in-memory tag index (no full scan).
- **Atomic batch writes** — `batchSet()` and `batchDelete()` now execute in a single
  IndexedDB transaction. New **`getMany(keys)`** reads many keys in one transaction.
- **Official React hooks** via the `cache-craft-engine/react` subpath:
  `useCache`, `useCacheValue`, `useCacheStats`, `useCacheEngine`, `getSharedCache`.
  SSR-safe; share one engine per config.
- **Custom eviction policies** — `evictionStrategy: 'custom'` + `evictionPolicy`.
- **`flushAccessMetadata()`** — manually persist buffered access metadata.
- New config: `persistAccessMetadata`, `accessMetadataFlushInterval`, `evictionPolicy`.
- New exported types: `CacheEntryMeta`, `GetOrSetOptions`.

### Changed
- **Read path no longer writes on every `get`.** Access-time / access-count updates are
  buffered in memory and flushed periodically (configurable), removing write amplification.
- **`set` stats are incremental** — no full-database rescan after each operation.
- `setBlob` now emits `set` events, updates stats and broadcasts cross-tab like `set`.
- Eviction policies now receive lightweight `CacheEntryMeta[]` instead of full entries.
- `arc` strategy renamed to **`segmented`** (frequency-segmented, scan-resistant LRU).
  `arc` and `ARCEvictionPolicy` remain as deprecated aliases.

### Fixed
- Compression combined with encoding/encryption now round-trips correctly
  (`isEncoded` is no longer set when a value is compressed; encrypted+compressed
  payloads are restored properly on read).
- `query()` no longer performs a redundant second read per result; values are decoded
  through a single shared pipeline.

## [0.2.0] - 2026-01-14

### 🎉 Major Release - 100% Backward Compatible

### Added

#### Core Features
- **Plugin System**: Extend functionality with custom plugins
- **Event System**: Listen to cache operations (set, get, delete, evict, etc.)
- **Multiple Eviction Strategies**: LRU (default), LFU, FIFO, Priority, ARC, TTL, Size-based
- **Encryption**: Built-in data encryption with WebCrypto API
- **Tab Synchronization**: Automatic sync across browser tabs using BroadcastChannel
- **Advanced Query System**: Search and filter cache entries by tags, size, age, priority
- **Batch Operations**: Efficient bulk get/set/delete operations
- **Export/Import**: Backup and restore cache data
- **Tags & Metadata**: Organize entries with tags and custom metadata
- **Priority System**: Set priority levels for cache entries

#### Admin & Monitoring
- **Admin Panel**: Built-in monitoring and management tools
- **Cache Monitor**: Real-time performance tracking
- **Detailed Statistics**: Comprehensive metrics (hit rate, compression ratio, etc.)
- **Health Checks**: System health status and recommendations
- **Storage Info**: Browser storage usage information

#### Built-in Plugins
- `LoggerPlugin`: Log cache operations
- `MetricsPlugin`: Track detailed metrics
- `ValidationPlugin`: Validate data before caching
- `TTLRefreshPlugin`: Refresh TTL on access
- `CompressionOptimizerPlugin`: Smart compression
- `TagManagerPlugin`: Manage tags efficiently
- `RateLimiterPlugin`: Rate limit cache operations
- `PrefetchPlugin`: Prefetch related data
- `WarmupPlugin`: Preload cache on startup
- `PersistencePlugin`: LocalStorage fallback
- `AnalyticsPlugin`: Send events to analytics
- `DebugPlugin`: Debug mode with detailed logging

#### New API Methods
- `has(key)`: Check if key exists
- `size()`: Get total cache size in bytes
- `count()`: Get number of entries
- `keys(pattern?)`: Get all keys (optionally filtered)
- `batchSet(items)`: Set multiple items at once
- `batchGet(items)`: Get multiple items at once
- `batchDelete(keys)`: Delete multiple items at once
- `query(options)`: Advanced search and filter
- `export(options)`: Export cache data
- `import(data, options)`: Import cache data
- `cleanup()`: Manually clean expired entries
- `getStats()`: Get cache statistics
- `getDetailedStats()`: Get detailed statistics
- `getHealth()`: Get system health status
- `getStorageInfo()`: Get storage information
- `use(plugin)`: Register a plugin
- `removePlugin(name)`: Remove a plugin
- `getPlugins()`: Get all registered plugins
- `on(event, listener)`: Add event listener
- `off(event, listener)`: Remove event listener
- `once(event, listener)`: Add one-time event listener
- `destroy()`: Clean up resources

#### Enhanced Options
- `CacheSetOptions`: Added `encrypt`, `tags`, `metadata`, `priority`, `onSet`
- `CacheGetOptions`: Added `updateAccessTime`, `onGet`
- `CacheConfig`: Added `evictionStrategy`, `enableStats`, `enableSync`, `encryptionKey`, `plugins`, `autoCleanup`, `cleanupInterval`, `onError`

#### TypeScript Types
- All new types and interfaces exported
- Better type safety with generics
- Comprehensive type definitions

### Enhanced
- **Performance**: Optimized eviction algorithms
- **Memory**: Better memory management
- **Error Handling**: Improved error messages and handling
- **Documentation**: Comprehensive README with examples
- **Examples**: Added 10+ real-world examples

### Fixed
- Better handling of quota exceeded errors
- Improved cursor iteration for large datasets
- Fixed edge cases in compression/decompression

### Backward Compatibility
- ✅ 100% compatible with v1.x
- ✅ All v1 code works without changes
- ✅ No data migration needed
- ✅ New fields in CacheEntry are optional
- ✅ Gradual adoption of new features

## [0.1.0] - 2026-01-06

### Initial Release

#### Core Features
- IndexedDB-based caching
- Automatic compression (gzip)
- Base64 encoding option
- TTL (Time To Live) support
- Stale-while-revalidate pattern
- LRU eviction
- Namespace support
- Blob storage

#### API
- `set(key, value, options)`
- `get(key, options)`
- `remove(key)`
- `clear()`
- `namespace(name)`
- `setBlob(key, blob, options)`
- `getBlob(key)`

#### Configuration
- `dbName`: Database name
- `version`: Database version
- `storeName`: Object store name
- `maxSize`: Maximum cache size
- `compressionThreshold`: Auto-compression threshold
- `namespace`: Cache namespace

#### Options
- `ttl`: Time to live in milliseconds
- `encode`: Base64 encode data
- `forceCompress`: Force compression
- `staleWhileRevalidate`: Return stale data while revalidating
- `revalidate`: Function to fetch fresh data
- `ttlOnRevalidate`: TTL for revalidated data
