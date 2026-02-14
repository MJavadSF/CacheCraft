# CacheCraft 🚀

<div align="center">

[![npm version](https://img.shields.io/npm/v/cache-craft-engine.svg?color=green&style=for-the-badge)](https://www.npmjs.com/package/cache-craft-engine)
[![npm downloads](https://img.shields.io/npm/dm/cache-craft-engine.svg?style=for-the-badge)](https://www.npmjs.com/package/cache-craft-engine)
[![GitHub stars](https://img.shields.io/github/stars/MJavadSF/CacheCraft?style=for-the-badge)](https://github.com/MJavadSF/CacheCraft)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg?style=for-the-badge)](https://www.typescriptlang.org/)

**Enterprise-grade IndexedDB caching library with advanced features for modern web applications**

[Features](#-key-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [Documentation](#-documentation) • [Examples](#-real-world-examples) • [API](#-api-reference)

</div>

---

## 🎯 What's New in v0.2

CacheCraft v0.2 is a **major upgrade** with powerful enterprise features while maintaining **100% backward compatibility** with previous versions!

### ✨ New in v0.2

- 🔌 **Plugin System** - Extend functionality with 12+ built-in plugins or create your own
- 📊 **Admin Panel** - Built-in monitoring dashboard with real-time statistics
- 🎯 **7 Eviction Strategies** - LRU, LFU, FIFO, Priority, ARC, TTL, Size-based
- 🔐 **Encryption** - Secure your sensitive data with built-in AES-GCM encryption
- 🔄 **Tab Sync** - Automatic synchronization across browser tabs
- 🔍 **Advanced Query System** - Search and filter cache entries with powerful queries
- 📦 **Batch Operations** - Efficient bulk get/set/delete operations
- 🏷️ **Tags & Metadata** - Organize and categorize your cache entries
- 📤 **Export/Import** - Backup and restore your entire cache
- 🔔 **Event System** - React to all cache operations with event listeners
- 📈 **Detailed Statistics** - Track hit rates, compression ratios, and performance metrics
- 🏥 **Health Checks** - Monitor cache health with automatic recommendations

**📚 [Migration Guide](./MIGRATION.md)** - Upgrading from older version? It's seamless!

---

## 🎯 Overview

CacheCraft is a production-ready, enterprise-grade caching solution built on IndexedDB. Perfect for PWAs, offline-first applications, API response caching, and complex data management scenarios.

### Why Choose CacheCraft?

- 🚀 **Zero Dependencies** - Lightweight (~30KB minified, ~10KB gzipped)
- 💾 **Persistent Storage** - Data survives page reloads and browser restarts
- 🗜️ **Smart Compression** - Automatic gzip compression with 60-80% size reduction
- ♻️ **Intelligent Eviction** - Multiple strategies (LRU, LFU, FIFO, Priority, ARC, TTL, Size)
- ⏱️ **Flexible TTL** - Time-based expiration with refresh-on-access support
- 🔄 **Stale-While-Revalidate** - Instant responses with background updates
- 🏷️ **Namespaces & Tags** - Organize cache by logical groups
- 📊 **Production Monitoring** - Built-in admin panel and statistics
- 🔐 **Security** - Optional encryption for sensitive data
- 📦 **TypeScript Native** - Full type safety with comprehensive types
- 🎨 **Framework Agnostic** - Works with React, Vue, Svelte, Angular, or Vanilla JS
- 🌐 **Cross-Tab Sync** - Keep cache consistent across all browser tabs
- 🔌 **Extensible** - Plugin architecture for custom functionality

---

## 📦 Installation

```bash
npm install cache-craft-engine
```

```bash
yarn add cache-craft-engine
```

```bash
pnpm add cache-craft-engine
```

---

## 🚀 Quick Start

### Basic Usage (Backward Compatible)

```typescript
import { CacheEngine } from 'cache-craft-engine';

// Initialize cache
const cache = new CacheEngine();

// Store data
await cache.set('user', { id: 1, name: 'Ali' });

// Retrieve data
const user = await cache.get('user');
console.log(user); // { id: 1, name: 'Ali' }

// Remove data
await cache.remove('user');

// Clear all
await cache.clear();
```

### Advanced Usage (v2 Features)

```typescript
import { CacheEngine, LoggerPlugin, CacheAdminPanel } from 'cache-craft-engine';

// Create cache with advanced features
const cache = new CacheEngine({
  dbName: 'my-app-cache',
  maxSize: 150 * 1024 * 1024,        // 150 MB
  compressionThreshold: 10 * 1024,    // Compress items >10KB
  evictionStrategy: 'lfu',            // Least Frequently Used
  enableStats: true,                  // Track statistics
  enableSync: true,                   // Sync across tabs
  plugins: [new LoggerPlugin()],      // Add logging
});

// Store with advanced options
await cache.set('user-profile', userData, {
  ttl: 10 * 60 * 1000,               // 10 minutes
  tags: ['users', 'active'],         // Add tags
  priority: 10,                       // High priority
  encrypt: true,                      // Encrypt data
});

// Query by tags
const activeUsers = await cache.query({
  tags: ['active'],
  sortBy: 'lastAccessed',
  limit: 20,
});

// Create admin panel
const admin = new CacheAdminPanel(cache);
const stats = await admin.getData();
console.log('Hit Rate:', stats.stats.hitRate);
console.log('Total Size:', stats.stats.totalSize);
```

---

## ✨ Key Features

### 🔌 Plugin System

Extend CacheCraft with plugins or create your own:

```typescript
import { LoggerPlugin, MetricsPlugin, ValidationPlugin } from 'cache-craft-engine';

const cache = new CacheEngine({
  plugins: [
    new LoggerPlugin(),        // Log all operations
    new MetricsPlugin(),       // Track metrics
    new ValidationPlugin(),    // Validate data
  ]
});

// Create custom plugin
class MyPlugin {
  name = 'my-plugin';
  
  async afterSet(key, value, entry) {
    console.log(`Cached ${key}: ${entry.size} bytes`);
  }
}

cache.use(new MyPlugin());
```

**Built-in Plugins:**
- `LoggerPlugin` - Operation logging
- `MetricsPlugin` - Detailed metrics tracking
- `ValidationPlugin` - Data validation before caching
- `TTLRefreshPlugin` - Refresh TTL on access
- `CompressionOptimizerPlugin` - Smart compression
- `TagManagerPlugin` - Advanced tag management
- `RateLimiterPlugin` - Rate limiting
- `PrefetchPlugin` - Prefetch related data
- `WarmupPlugin` - Cache preloading
- `PersistencePlugin` - LocalStorage fallback
- `AnalyticsPlugin` - Analytics integration
- `DebugPlugin` - Debug mode

### 📊 Admin Panel & Monitoring

Built-in dashboard for monitoring and management:

```typescript
import { CacheAdminPanel } from 'cache-craft-engine';

const admin = new CacheAdminPanel(cache);

// Get comprehensive data
const data = await admin.getData();
console.log('Statistics:', data.stats);
console.log('Health:', data.health);
console.log('Top Keys:', data.topKeys);
console.log('Recent Activity:', data.recentActivity);

// Generate text report
const report = await admin.generateReport();
console.log(report);

// Dashboard data for UI
const dashboardData = await admin.getDashboardData();
// Returns: overview, charts, alerts
```

**What You Can Monitor:**
- Hit rate & miss rate
- Total cache size & entry count
- Compression ratio
- Most accessed keys
- Recent activity log
- Health status & warnings
- Storage usage
- Performance metrics

### 🎯 Multiple Eviction Strategies

Choose the best strategy for your use case:

```typescript
// LRU (Least Recently Used) - Default
const cache = new CacheEngine({ evictionStrategy: 'lru' });

// LFU (Least Frequently Used) - Best for hot data
const cache = new CacheEngine({ evictionStrategy: 'lfu' });

// FIFO (First In First Out) - Simple and predictable
const cache = new CacheEngine({ evictionStrategy: 'fifo' });

// Priority - Keep important items longer
const cache = new CacheEngine({ evictionStrategy: 'priority' });
await cache.set('critical-data', data, { priority: 100 });

// TTL - Evict based on expiration time
const cache = new CacheEngine({ evictionStrategy: 'ttl' });

// Size - Evict largest items first
const cache = new CacheEngine({ evictionStrategy: 'size' });

// ARC (Adaptive Replacement Cache) - Self-tuning
const cache = new CacheEngine({ evictionStrategy: 'arc' });
```

### 🔐 Encryption

Secure sensitive data with built-in encryption:

```typescript
const cache = new CacheEngine({
  encryptionKey: 'your-secret-key-at-least-32-chars-long'
});

// Encrypt specific items
await cache.set('sensitive-data', secretInfo, {
  encrypt: true
});

// Automatically decrypted on get
const data = await cache.get('sensitive-data');
```

### 🔄 Tab Synchronization

Keep cache synchronized across all browser tabs:

```typescript
const cache = new CacheEngine({
  enableSync: true
});

// Changes in one tab automatically sync to others
await cache.set('shared-state', data);

// Listen to sync events
cache.on('sync', (data) => {
  console.log('Synced from another tab:', data.key);
});
```

### 🔍 Advanced Query System

Search and filter cache entries:

```typescript
// Query by multiple criteria
const results = await cache.query({
  tags: ['users', 'premium'],      // Items with these tags
  minPriority: 5,                   // Priority >= 5
  minAccessCount: 10,               // Accessed 10+ times
  pattern: /^user-/,                // Key pattern
  sortBy: 'lastAccessed',           // Sort by access time
  sortOrder: 'desc',                // Descending
  limit: 50,                        // Max 50 results
});

// Get all keys matching pattern
const userKeys = await cache.keys(/^user-\d+$/);
```

### 📦 Batch Operations

Efficient bulk operations:

```typescript
// Batch set
await cache.batchSet([
  { key: 'user-1', value: user1, options: { ttl: 60000 } },
  { key: 'user-2', value: user2, options: { ttl: 60000 } },
  { key: 'user-3', value: user3, options: { ttl: 60000 } },
]);

// Batch get
const results = await cache.batchGet([
  { key: 'user-1' },
  { key: 'user-2' },
  { key: 'user-3' },
]);

// Batch delete
await cache.batchDelete(['user-1', 'user-2', 'user-3']);
```

### 🏷️ Tags & Metadata

Organize your cache entries:

```typescript
// Add tags and metadata
await cache.set('product-123', productData, {
  tags: ['products', 'electronics', 'featured'],
  metadata: {
    source: 'api',
    version: '2.0',
    author: 'admin'
  },
  priority: 8
});

// Query by tags
const electronics = await cache.query({
  tags: ['electronics'],
});

// Get all available tags
const tagManager = new TagManagerPlugin();
cache.use(tagManager);
const allTags = tagManager.getAllTags();
```

### 📤 Export & Import

Backup and restore your cache:

```typescript
// Export entire cache
const exportData = await cache.export({
  includeExpired: false,
  compress: true,
  filter: (key, entry) => entry.size < 1024 * 1024, // Only <1MB items
});

// Save to file
const blob = new Blob([JSON.stringify(exportData)], { type: 'application/json' });
const url = URL.createObjectURL(blob);

// Import cache
await cache.import(exportData, {
  overwrite: true,
  skipInvalid: true,
});
```

### 🔔 Event System

React to cache operations:

```typescript
// Listen to events
cache.on('set', (data) => {
  console.log('Item cached:', data.key);
});

cache.on('hit', (data) => {
  console.log('Cache hit:', data.key);
});

cache.on('miss', (data) => {
  console.log('Cache miss:', data.key);
});

cache.on('evict', (data) => {
  console.log('Items evicted:', data.metadata.keys);
});

cache.on('error', (data) => {
  console.error('Cache error:', data.error);
});

// One-time listener
cache.once('clear', () => {
  console.log('Cache cleared');
});
```

### 🗜️ Smart Compression

Automatic compression for large data:

```typescript
const cache = new CacheEngine({
  compressionThreshold: 8 * 1024, // Compress items >8KB
});

// Large objects are automatically compressed
await cache.set('analytics-data', largeDataset);

// Or force compression
await cache.set('config', smallData, { 
  forceCompress: true 
});

// Check compression stats
const stats = await cache.getDetailedStats();
console.log('Compression ratio:', stats.compressionRatio);
```

### ⏱️ Flexible TTL

Time-based expiration with advanced options:

```typescript
// Basic TTL
await cache.set('session', data, {
  ttl: 60 * 60 * 1000, // 1 hour
});

// Refresh TTL on access
const ttlPlugin = new TTLRefreshPlugin(60 * 60 * 1000);
cache.use(ttlPlugin);

// Stale-while-revalidate
const data = await cache.get('key', {
  staleWhileRevalidate: true,
  revalidate: () => fetchFreshData(),
  ttlOnRevalidate: 5 * 60 * 1000,
});
```

### 🏷️ Namespaces

Organize cache into logical groups:

```typescript
const cache = new CacheEngine();

// Create separate namespaces
const userCache = cache.namespace('users');
const apiCache = cache.namespace('api');
const mediaCache = cache.namespace('media');

await userCache.set('profile-42', userData);
await apiCache.set('posts', postsData);
await mediaCache.setBlob('avatar', imageBlob);

// Each namespace is isolated
await userCache.clear(); // Only clears user cache
```

---

## 📚 Documentation

- **[Quick Start Guide](./QUICKSTART.md)** - Get started in 5 minutes
- **[Migration Guide](./MIGRATION.md)** - Upgrade from older versions
- **[API Reference](#-api-reference)** - Complete API documentation
- **[Examples](./examples.ts)** - 10+ real-world examples
- **[Project Structure](./STRUCTURE.md)** - Architecture overview
- **[Changelog](./CHANGELOG.md)** - Version history

---

## 💡 Real-World Examples

### Example 1: API Response Caching

```typescript
import { CacheEngine } from 'cache-craft-engine';

const apiCache = new CacheEngine({ 
  namespace: 'api',
  enableStats: true 
});

async function fetchUserProfile(userId: number) {
  const cacheKey = `user-${userId}`;
  
  // Try cache first with stale-while-revalidate
  let profile = await apiCache.get(cacheKey, {
    staleWhileRevalidate: true,
    revalidate: async () => {
      const response = await fetch(`/api/users/${userId}`);
      return response.json();
    },
    ttlOnRevalidate: 5 * 60 * 1000, // 5 minutes
  });
  
  if (!profile) {
    // Fresh fetch
    const response = await fetch(`/api/users/${userId}`);
    profile = await response.json();
    
    await apiCache.set(cacheKey, profile, {
      ttl: 5 * 60 * 1000,
      tags: ['users'],
      compress: true,
    });
  }
  
  return profile;
}
```

### Example 2: React Integration

```typescript
import { useEffect, useState } from 'react';
import { CacheEngine } from 'cache-craft-engine';

const cache = new CacheEngine({ enableStats: true });

function useCache<T>(key: string, fetcher: () => Promise<T>, ttl = 300000) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  useEffect(() => {
    async function loadData() {
      try {
        // Check cache
        let result = await cache.get<T>(key);
        
        if (!result) {
          // Fetch and cache
          result = await fetcher();
          await cache.set(key, result, { ttl, tags: ['react-query'] });
        }
        
        setData(result);
      } catch (err) {
        setError(err as Error);
      } finally {
        setLoading(false);
      }
    }
    
    loadData();
  }, [key]);
  
  const invalidate = async () => {
    await cache.remove(key);
    setLoading(true);
  };
  
  return { data, loading, error, invalidate };
}

// Usage
function UserProfile({ userId }: { userId: number }) {
  const { data, loading, error, invalidate } = useCache(
    `user-${userId}`,
    () => fetch(`/api/users/${userId}`).then(r => r.json()),
    600000 // 10 minutes
  );
  
  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  
  return (
    <div>
      <h1>{data?.name}</h1>
      <button onClick={invalidate}>Refresh</button>
    </div>
  );
}
```

### Example 3: Image Caching for PWA

```typescript
const imageCache = new CacheEngine({
  namespace: 'images',
  maxSize: 100 * 1024 * 1024, // 100MB
  evictionStrategy: 'lru',
});

async function cacheImage(url: string) {
  // Check cache
  const cached = await imageCache.getBlob(url);
  if (cached) {
    return URL.createObjectURL(cached);
  }
  
  // Fetch image
  const response = await fetch(url);
  const blob = await response.blob();
  
  // Cache for 7 days
  await imageCache.setBlob(url, blob, {
    ttl: 7 * 24 * 60 * 60 * 1000,
  });
  
  return URL.createObjectURL(blob);
}

// Usage
const imageUrl = await cacheImage('https://example.com/image.jpg');
imgElement.src = imageUrl;
```

### Example 4: Multi-Namespace Architecture

```typescript
class AppCache {
  private cache: CacheEngine;
  public users: CacheEngine;
  public posts: CacheEngine;
  public media: CacheEngine;
  public config: CacheEngine;
  
  constructor() {
    this.cache = new CacheEngine({
      dbName: 'app-cache',
      maxSize: 200 * 1024 * 1024,
      enableStats: true,
      enableSync: true,
    });
    
    this.users = this.cache.namespace('users');
    this.posts = this.cache.namespace('posts');
    this.media = this.cache.namespace('media');
    this.config = this.cache.namespace('config');
  }
  
  async getStats() {
    return this.cache.getDetailedStats();
  }
  
  async clearAll() {
    await this.cache.clear();
  }
}

// Usage
const appCache = new AppCache();
await appCache.users.set('profile-42', userData);
await appCache.posts.set('recent', postsData);

const stats = await appCache.getStats();
console.log('Cache hit rate:', stats.hitRate);
```

### Example 5: Admin Dashboard

```typescript
import { CacheEngine, CacheAdminPanel } from 'cache-craft-engine';

const cache = new CacheEngine({
  enableStats: true,
  plugins: [
    new LoggerPlugin(),
    new MetricsPlugin(),
  ]
});

const admin = new CacheAdminPanel(cache);

// Real-time dashboard updates
setInterval(async () => {
  const dashboardData = await admin.getDashboardData();
  
  // Update UI
  updateDashboard({
    totalSize: dashboardData.overview.totalSize,
    entryCount: dashboardData.overview.entryCount,
    hitRate: dashboardData.overview.hitRate,
    status: dashboardData.overview.status,
    alerts: dashboardData.alerts,
    charts: dashboardData.charts,
  });
}, 1000);

// Generate report
async function generateReport() {
  const report = await admin.generateReport();
  downloadFile('cache-report.txt', report);
}
```

### Example 6: Offline Form Draft

```typescript
const formCache = new CacheEngine({ 
  namespace: 'forms',
  enableSync: true // Sync across tabs
});

// Auto-save form data
function setupAutoSave(formId: string) {
  const form = document.getElementById(formId);
  
  // Debounced save
  const saveDebounced = debounce(async (data) => {
    await formCache.set(`draft-${formId}`, data, {
      ttl: 24 * 60 * 60 * 1000, // 24 hours
      tags: ['drafts'],
    });
  }, 1000);
  
  form?.addEventListener('input', (e) => {
    const formData = new FormData(form as HTMLFormElement);
    const data = Object.fromEntries(formData);
    saveDebounced(data);
  });
}

// Restore on page load
async function restoreFormDraft(formId: string) {
  const draft = await formCache.get(`draft-${formId}`);
  if (draft) {
    populateForm(formId, draft);
    showNotification('Draft restored');
  }
}

// Clear after successful submit
async function clearDraft(formId: string) {
  await formCache.remove(`draft-${formId}`);
}
```

### Example 7: Multi-Layer Cache

```typescript
// L1: Hot data (small, frequently accessed)
const l1Cache = new CacheEngine({
  namespace: 'l1',
  maxSize: 10 * 1024 * 1024,  // 10MB
  evictionStrategy: 'lfu',     // Keep frequently used
});

// L2: Warm data (larger, less frequently accessed)
const l2Cache = new CacheEngine({
  namespace: 'l2',
  maxSize: 100 * 1024 * 1024, // 100MB
  evictionStrategy: 'lru',
});

async function multiLayerGet<T>(key: string): Promise<T | null> {
  // Check L1
  let value = await l1Cache.get<T>(key);
  if (value) return value;
  
  // Check L2
  value = await l2Cache.get<T>(key);
  if (value) {
    // Promote to L1
    await l1Cache.set(key, value);
    return value;
  }
  
  return null;
}

async function multiLayerSet<T>(key: string, value: T): Promise<void> {
  await Promise.all([
    l1Cache.set(key, value),
    l2Cache.set(key, value),
  ]);
}
```

More examples in [examples.ts](./examples.ts)

---

## 📖 API Reference

### Constructor

```typescript
new CacheEngine(config?: CacheConfig)
```

#### CacheConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `dbName` | `string` | `'cache-db'` | IndexedDB database name |
| `version` | `number` | `1` | Database version |
| `storeName` | `string` | `'cache'` | Object store name |
| `maxSize` | `number` | `100 * 1024 * 1024` | Max cache size (100MB) |
| `compressionThreshold` | `number` | `10 * 1024` | Auto-compress threshold (10KB) |
| `namespace` | `string` | `''` | Default namespace |
| `evictionStrategy` | `EvictionStrategy` | `'lru'` | Eviction strategy |
| `enableStats` | `boolean` | `false` | Enable statistics |
| `enableSync` | `boolean` | `false` | Enable tab sync |
| `encryptionKey` | `string` | `''` | Encryption key |
| `plugins` | `CachePlugin[]` | `[]` | Plugins to use |
| `autoCleanup` | `boolean` | `true` | Auto cleanup expired |
| `cleanupInterval` | `number` | `60000` | Cleanup interval (ms) |
| `onError` | `(error: Error) => void` | `undefined` | Error handler |

### Core Methods

#### `set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void>`

Store a value in cache.

**Options:**
```typescript
{
  ttl?: number;              // Time to live (ms)
  encode?: boolean;          // Base64 encode
  forceCompress?: boolean;   // Force compression
  encrypt?: boolean;         // Encrypt data
  tags?: string[];           // Tags for organization
  metadata?: Record<string, any>;  // Custom metadata
  priority?: number;         // Priority (0-100)
  onSet?: (key, value) => void;    // Callback
}
```

#### `get<T>(key: string, options?: CacheGetOptions<T>): Promise<T | null>`

Retrieve a value from cache.

**Options:**
```typescript
{
  staleWhileRevalidate?: boolean;    // Return stale data
  revalidate?: () => Promise<T>;     // Fetch fresh data
  ttlOnRevalidate?: number;          // TTL for fresh data
  updateAccessTime?: boolean;        // Update access time
  onGet?: (key, value) => void;      // Callback
}
```

#### `remove(key: string): Promise<boolean>`

Remove a cache entry. Returns `true` if item existed.

#### `clear(): Promise<number>`

Clear all cache entries. Returns count of cleared items.

#### `has(key: string): Promise<boolean>`

Check if key exists (and not expired).

#### `size(): Promise<number>`

Get total cache size in bytes.

#### `count(): Promise<number>`

Get number of entries.

#### `keys(pattern?: RegExp | string): Promise<string[]>`

Get all keys, optionally filtered by pattern.

### Advanced Methods

#### `batchSet<T>(items: BatchSetItem<T>[]): Promise<BatchResult<T>[]>`

Set multiple items at once.

#### `batchGet<T>(items: BatchGetItem[]): Promise<BatchResult<T>[]>`

Get multiple items at once.

#### `batchDelete(keys: string[]): Promise<BatchResult<null>[]>`

Delete multiple items at once.

#### `query<T>(query: CacheQuery): Promise<QueryResult<T>[]>`

Advanced search and filter.

**Query Options:**
```typescript
{
  tags?: string[];           // Filter by tags
  minPriority?: number;      // Min priority
  maxPriority?: number;      // Max priority
  minAge?: number;           // Min age (ms)
  maxAge?: number;           // Max age (ms)
  minSize?: number;          // Min size (bytes)
  maxSize?: number;          // Max size (bytes)
  minAccessCount?: number;   // Min access count
  pattern?: RegExp | string; // Key pattern
  expired?: boolean;         // Include expired
  limit?: number;            // Max results
  offset?: number;           // Skip results
  sortBy?: string;           // Sort field
  sortOrder?: 'asc' | 'desc'; // Sort direction
}
```

#### `export(options?: ExportOptions): Promise<ExportData>`

Export cache data.

#### `import(data: ExportData, options?: ImportOptions): Promise<number>`

Import cache data. Returns count of imported items.

#### `cleanup(): Promise<number>`

Manually clean expired entries. Returns count of cleaned items.

### Statistics & Monitoring

#### `getStats(): CacheStats`

Get basic statistics.

#### `getDetailedStats(): Promise<DetailedStats>`

Get detailed statistics including compression ratio, tags, etc.

#### `getHealth(): Promise<HealthStatus>`

Get system health status.

#### `getStorageInfo(): Promise<StorageInfo>`

Get browser storage information.

### Plugin System

#### `use(plugin: CachePlugin): void`

Register a plugin.

#### `removePlugin(name: string): boolean`

Remove a plugin.

#### `getPlugins(): CachePlugin[]`

Get all registered plugins.

### Event System

#### `on(event: CacheEvent, listener: CacheEventListener): void`

Add event listener.

**Events:** `'set'`, `'get'`, `'delete'`, `'clear'`, `'evict'`, `'hit'`, `'miss'`, `'expire'`, `'error'`, `'sync'`

#### `off(event: CacheEvent, listener: CacheEventListener): void`

Remove event listener.

#### `once(event: CacheEvent, listener: CacheEventListener): void`

Add one-time event listener.

### Namespace

#### `namespace(namespace: string): CacheEngine`

Create a namespaced cache instance.

### Blob Storage

#### `setBlob(key: string, blob: Blob, options?: CacheSetOptions): Promise<void>`

Store a Blob (images, files, etc.).

#### `getBlob(key: string): Promise<Blob | null>`

Retrieve a Blob.

### Lifecycle

#### `destroy(): Promise<void>`

Clean up resources and close database.

---

## 🎯 Best Practices

### 1. Choose Appropriate TTLs

```typescript
// Static content - long TTL
await cache.set('app-config', config, { ttl: 24 * 60 * 60 * 1000 });

// Dynamic content - short TTL
await cache.set('live-scores', scores, { ttl: 30 * 1000 });

// User data - medium TTL
await cache.set('user-profile', profile, { ttl: 10 * 60 * 1000 });
```

### 2. Use Appropriate Eviction Strategy

```typescript
// For hot data (frequently accessed)
const cache = new CacheEngine({ evictionStrategy: 'lfu' });

// For time-sensitive data
const cache = new CacheEngine({ evictionStrategy: 'ttl' });

// For priority-based data
const cache = new CacheEngine({ evictionStrategy: 'priority' });
```

### 3. Organize with Namespaces

```typescript
const userCache = cache.namespace('users');
const apiCache = cache.namespace('api');
const mediaCache = cache.namespace('media');
```

### 4. Monitor Performance

```typescript
const cache = new CacheEngine({ enableStats: true });
const admin = new CacheAdminPanel(cache);

// Check regularly
setInterval(async () => {
  const stats = cache.getStats();
  if (stats.hitRate < 0.5) {
    console.warn('Low hit rate:', stats.hitRate);
  }
}, 60000);
```

### 5. Use Tags for Organization

```typescript
await cache.set('item', data, {
  tags: ['category', 'important', 'v2'],
});

// Later, find all items
const importantItems = await cache.query({
  tags: ['important'],
});
```

### 6. Handle Errors Gracefully

```typescript
async function getCachedData(key: string) {
  try {
    return await cache.get(key);
  } catch (error) {
    console.error('Cache error:', error);
    return await fetchFromAPI(key);
  }
}
```

### 7. Never Cache Sensitive Data Without Encryption

```typescript
// ✅ DO
await cache.set('user-token', token, {
  encrypt: true,
  ttl: 3600000,
});

// ❌ DON'T
await cache.set('credit-card', cardInfo); // NO!
```

### 8. Use Batch Operations for Better Performance

```typescript
// Instead of multiple individual sets
await cache.batchSet(items);

// Instead of multiple individual gets
await cache.batchGet(keys);
```

---

## 🔧 Advanced Configuration

### Custom Eviction Policy

```typescript
import { EvictionPolicy } from 'cache-craft-engine';

class CustomEvictionPolicy implements EvictionPolicy {
  name = 'custom';
  
  shouldEvict(entries, maxSize, currentSize) {
    // Your custom logic
    return keysToEvict;
  }
}
```

### Custom Plugin

```typescript
import { CachePlugin } from 'cache-craft-engine';

class CustomPlugin implements CachePlugin {
  name = 'my-plugin';
  version = '1.0.0';
  
  async beforeSet(key, value, options) {
    // Pre-processing
    return true; // Continue
  }
  
  async afterSet(key, value, entry, options) {
    // Post-processing
  }
  
  async onError(error, operation) {
    // Error handling
  }
}
```

---

## 🌐 Browser Support

| Browser | Version | Support |
|---------|---------|---------|
| Chrome | 80+ | ✅ Full |
| Edge | 80+ | ✅ Full |
| Firefox | 113+ | ✅ Full |
| Safari | 16.4+ | ✅ Full |
| Opera | 67+ | ✅ Full |

**Requirements:**
- IndexedDB
- CompressionStream API
- WebCrypto API (for encryption)
- BroadcastChannel (for tab sync)

---

## 📊 Performance

- **Compression**: 60-80% size reduction for JSON
- **Encryption**: ~5ms overhead for small items
- **Get/Set**: 1-5ms average
- **Eviction**: 10-50ms (depends on strategy)
- **Query**: 5-20ms (depends on complexity)
- **Bundle Size**: ~30KB minified, ~10KB gzipped

---

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md).

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🔗 Links

- **GitHub**: [https://github.com/MJavadSF/CacheCraft](https://github.com/MJavadSF/CacheCraft)
- **npm**: [https://www.npmjs.com/package/cache-craft-engine](https://www.npmjs.com/package/cache-craft-engine)
- **Issues**: [https://github.com/MJavadSF/CacheCraft/issues](https://github.com/MJavadSF/CacheCraft/issues)
- **Discussions**: [https://github.com/MJavadSF/CacheCraft/discussions](https://github.com/MJavadSF/CacheCraft/discussions)

---

## 💬 Support

- 📧 Email: mjavadsf72@gmail.com
- 🐛 Issues: [GitHub Issues](https://github.com/MJavadSF/CacheCraft/issues)
- 💡 Discussions: [GitHub Discussions](https://github.com/MJavadSF/CacheCraft/discussions)
- 📖 Documentation: [Full Docs](./README.md)

---

## 🙏 Acknowledgments

Special thanks to all contributors and the open-source community.

---