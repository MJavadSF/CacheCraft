# Changelog

All notable changes to CacheCraft will be documented in this file.

## [0.5.0] - 2026-10-05

### 🛠️ Correctness & Tooling Release

### Added
- `cache.ready()` — resolves once the in-memory index is hydrated (makes `allTags()` reliable).
- `cache.queryMeta(query)` — `query()` filters on metadata only, without reading/decoding payloads.
- `CachePlugin.init(host)` hook + `CachePluginHost` type (plugins can call `set`/`has`).
- `CacheAdminPanel.dispose()` (removes its event listeners) and `CacheMonitor.measure()`.
- `VERSION`, `toError`, `isGzip` exports; `CacheEntry.originalSize` (set for compressed entries).
- Cache is now usable in Web/Service Workers (the check is "is IndexedDB available", not "is `window` defined").
- Access metadata is flushed when the tab is hidden / the page is closed.

### Fixed — security & data integrity
- **`encrypt: true` could store plaintext**: the key is derived asynchronously and `set()` used to skip
  encryption if it wasn't ready — and also when no `encryptionKey` was configured. Now it awaits the key
  and throws `EncryptionError` when encryption is impossible. Reading an encrypted entry without a key
  throws instead of returning ciphertext bytes. `setBlob`/`getBlob` support `encrypt` too.
- **`namespace(ns).clear()` deleted every namespace's data** (`store.clear()`); it now deletes only its own key range.
- **Namespaces leaked into each other**: hydration indexed *all* keys, so size budget, `count()`, `keys()` and
  eviction crossed namespaces (an eviction in one namespace could delete another's entries).
- **Cross-tab sync** (`enableSync`): messages were handled by every namespace sharing the database, so a
  `delete`/`clear` in one namespace deleted the same key (or everything) in the others; receivers re-applied
  destructive operations instead of only refreshing their index; `evict` was never broadcast; values were
  broadcast (large clones, plaintext of encrypted values, and `DataCloneError` made `set()` throw after
  writing). Messages now carry the namespace, never carry values, and failures are reported via `onError`.
- **`compress()` / `decompress()` could deadlock** on payloads whose output exceeds the stream buffer
  (reproduced with ~8 MB of incompressible data). Writer and reader now run concurrently.
- `import()` accepted malformed entries (NaN size corrupted the size accounting) — entries are validated
  (`skipInvalid` now means something) and eviction runs after an import.
- `cleanup()` could delete an entry refreshed in the meantime — expiry is re-checked inside the transaction.
- `set(key, undefined)` stored an unreadable entry — it now throws `CacheError` (`INVALID_VALUE`).
- `TTLEvictionPolicy` let the cache grow past `maxSize` when entries had no TTL — falls back to LRU.
- Transactions now reject on `abort` (previously could hang); quota failures surface as `QuotaExceededError`;
  the connection closes on `versionchange` (no more blocked upgrades in other tabs).
- A throwing `"error"` listener caused infinite recursion; a throwing `onError`/plugin `onError` could break the engine.

### Fixed — behaviour
- `getOrSet` treated a cached `null` as a miss; stale-while-revalidate refreshes were not de-duplicated;
  failing to *cache* a computed value no longer loses it.
- `get()` + `staleWhileRevalidate`: the refreshed entry lost its TTL (it never expired again), tags, priority and
  metadata; concurrent reads each started a refresh.
- Expired reads now emit `miss`, count as a miss with up-to-date rates, and call `afterGet(null)` / `onGet(null)`.
- `query()`: `pattern` matched the namespaced key (inconsistent with `keys()`); `limit: 0` / `offset: 0` were
  ignored; sorting by `expiresAt` was broken for entries without TTL (`Infinity - Infinity`); each result cost a
  separate transaction (now one).
- `matchesPattern` with a global/sticky `RegExp` returned alternating results.
- `debounce` / `throttle` rejected callbacks with typed parameters (`(n: number) => void`) under `strictFunctionTypes`; the
  signature stays `<T extends function>`, so explicit `debounce<typeof fn>(…)` calls keep compiling.
- `batchSet` skipped plugin hooks (validation could be bypassed), `onSet` and cross-tab sync; `batchDelete` skipped sync.
- Encrypted + compressed payloads were stored as a JSON array of numbers (≈4× larger) — now raw bytes.
  Entries written by ≤0.4 are still read correctly.
- `compressionRatio` is now *stored size / original size* of compressed entries (it used to be a meaningless ratio);
  `avgAccessTime` is a true running mean (was an exponential average with weight ½).
- `getStorageInfo()` called `navigator.storage.persist()` (can show a permission prompt) — it now only reads `persisted()`.
- `exportData.version` is no longer hard-coded.
- Events/plugins receive namespace-free keys from eviction; plugins' `onError` gets the real operation name.

### Fixed — plugins
- `TTLRefreshPlugin` had no effect (it changed a throw-away copy). The engine now applies and persists an `expiresAt` change made in `afterGet`.
- `CompressionOptimizerPlugin` did nothing unless options were passed to `set()`.
- `PrefetchPlugin` discarded what its loader returned. It now stores the related values (an object — only the rule's own keys — or
  an array aligned with them), skips already-cached keys and de-duplicates runs. Pre-0.5 loaders (returning nothing and calling
  `cache.set` themselves) keep working unchanged.
- `TagManagerPlugin` kept tags of overwritten/evicted entries; `PersistencePlugin` ignored `clear`/eviction;
  `RateLimiterPlugin`'s map grew without bound; `ValidationPlugin` was unreliable with global regexes.
- `CacheAdminPanel`: `getData()` decoded 60 payloads just to rank keys; duplicated storage warnings; "low hit rate"
  warning on an idle cache; `critical` status was unreachable; event listeners leaked.

### Fixed — React (`cache-craft-engine/react`)
- `useCacheStats` returned a new object on every `getSnapshot` call → React threw "getSnapshot should be cached".
- `useCache` / `useCacheValue` / `useCacheStats` called `useCacheEngine` conditionally (Rules of Hooks) and created a default
  engine even when an explicit one was passed; `useCacheEngine` ignored later config changes.
- `useCache`: options were captured stale; hook-only options (`enabled`, `engine`, …) leaked into `set()`; late responses
  for an old key can no longer overwrite state; `refresh()` no longer removes the cached value before the factory
  succeeds; `isLoading` is correct after a key change.
- `useCacheValue` no longer bumps access counters/stats just by observing.

### Tooling
- **TypeScript 5.9 → 7.0** (native compiler; `tsc --noEmit` typechecks the whole project in well under a second).
- **ESLint → Biome 2** (`npm run check`); one tool for lint, format and import order.
- **Jest + ts-jest → Vitest 5** (ts-jest does not support TypeScript 7); happy-dom + fake-indexeddb.
- **Rollup + 2 plugins → tsdown**: `@rollup/plugin-typescript` needs the TS JS API that TS 7 no longer ships. The ESM/CJS
  bundles now share one engine chunk (the old build duplicated `CacheEngine` into the `/react` entry).
  Type declarations are emitted as `.d.ts` and `.d.cts` and `exports` maps them per condition.
- 91 tests added (there were none). Removed the unused, stale root `types.ts` (never part of the build or the package).
- `tsconfig`: `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`; `examples.ts` is now type-checked and
  `runAllExamples` actually runs the v0.4 examples.
- The library version now has a single source of truth (`package.json` → `VERSION`).

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
