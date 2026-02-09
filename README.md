# CacheCraft 🛠️

<div align="center">

[![npm version](https://img.shields.io/npm/v/cache-craft-engine.svg?color=green)](https://www.npmjs.com/package/cache-craft-engine)
[![npm downloads](https://img.shields.io/npm/dm/cache-craft-engine.svg)](https://www.npmjs.com/package/cache-craft-engine)
[![GitHub stars](https://img.shields.io/github/stars/MJavadSF/CacheCraft?style=social)](https://github.com/MJavadSF/CacheCraft)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)

**A lightweight, production-ready IndexedDB cache engine for modern web applications**

[Features](#-key-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [API](#-api-reference) • [Examples](#-examples) • [Best Practices](#-best-practices)

</div>

---

## 🎯 Overview

CacheCraft is a powerful client-side caching solution built on IndexedDB with advanced features like automatic compression, LRU eviction, TTL, and stale-while-revalidate patterns. Perfect for PWAs, offline-first apps, and performance optimization.

### Why CacheCraft?

- 🚀 **Zero Dependencies** - Lightweight and fast
- 💾 **Persistent Storage** - Data survives page reloads and browser restarts
- 🗜️ **Smart Compression** - Automatic gzip compression for large data (>10KB)
- ♻️ **LRU Eviction** - Intelligent cache management with configurable size limits
- ⏱️ **TTL Support** - Time-based expiration for cache entries
- 🔄 **Stale-While-Revalidate** - Serve stale data instantly while updating in background
- 🏷️ **Namespaces** - Organize cache by logical groups
- 📦 **TypeScript Native** - Full type safety out of the box
- 🎨 **Framework Agnostic** - Works with React, Vue, Svelte, Angular, or Vanilla JS

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

```typescript
import { CacheEngine } from 'cache-craft-engine';

// Initialize cache
const cache = new CacheEngine({
  dbName: 'my-app-cache',
  maxSize: 150 * 1024 * 1024, // 150 MB
  compressionThreshold: 10 * 1024, // Compress items >10KB
  namespace: 'app-v1',
});

// Store data with TTL
await cache.set('user-profile', { 
  id: 42, 
  name: 'Ali', 
  email: 'ali@example.com' 
}, {
  ttl: 10 * 60 * 1000, // 10 minutes
});

// Retrieve data
const user = await cache.get('user-profile');
console.log(user); // { id: 42, name: 'Ali', email: 'ali@example.com' }

// Remove data
await cache.remove('user-profile');

// Clear all cache
await cache.clear();
```

---

## ✨ Key Features

### 1️⃣ Automatic Compression

Data larger than the compression threshold (default: 10KB) is automatically compressed using gzip:

```typescript
const cache = new CacheEngine({
  compressionThreshold: 8 * 1024, // Compress from 8KB
});

// Large objects are automatically compressed
await cache.set('analytics-data', largeDataset);

// Or force compression for smaller items
await cache.set('config', smallData, { 
  forceCompress: true 
});
```

### 2️⃣ LRU Eviction

When cache exceeds `maxSize`, least recently used items are automatically removed:

```typescript
const cache = new CacheEngine({
  maxSize: 50 * 1024 * 1024, // 50 MB limit
});

// Cache automatically evicts old items when full
for (let i = 0; i < 1000; i++) {
  await cache.set(`item-${i}`, largeData);
}
```

### 3️⃣ TTL (Time To Live)

Set expiration times for cache entries:

```typescript
// Cache for 1 hour
await cache.set('session-data', data, {
  ttl: 60 * 60 * 1000,
});

// Expired items return null
await new Promise(r => setTimeout(r, 3601000));
const expired = await cache.get('session-data'); // null
```

### 4️⃣ Stale-While-Revalidate

Serve cached data instantly while updating in the background:

```typescript
const posts = await cache.get('blog-posts', {
  staleWhileRevalidate: true,
  revalidate: async () => {
    const response = await fetch('/api/posts');
    const freshData = await response.json();
    await cache.set('blog-posts', freshData, { 
      ttl: 5 * 60 * 1000 // 5 minutes
    });
    return freshData;
  },
});

// Returns cached data immediately
// Updates cache in background if expired
```

### 5️⃣ Namespaces

Organize cache into logical groups:

```typescript
const cache = new CacheEngine({ dbName: 'app-cache' });

// Create separate namespaces
const userCache = cache.namespace('users');
const imageCache = cache.namespace('images');
const apiCache = cache.namespace('api-responses');

await userCache.set('profile-42', userData);
await imageCache.set('avatar-42', imageBlob);
await apiCache.set('posts-list', postsData);

// Each namespace is isolated
```

### 6️⃣ Base64 Encoding

Optional encoding for special use cases:

```typescript
await cache.set('sensitive-config', data, {
  encode: true, // Base64 encode
  ttl: 24 * 60 * 60 * 1000,
});
```

---

## 📚 API Reference

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
| `maxSize` | `number` | `100 * 1024 * 1024` | Max cache size in bytes (100MB) |
| `compressionThreshold` | `number` | `10 * 1024` | Compress items larger than this (10KB) |
| `namespace` | `string` | `''` | Default namespace prefix |

### Methods

#### `set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void>`

Store a value in cache.

**Options:**
- `ttl?: number` - Time to live in milliseconds
- `encode?: boolean` - Enable base64 encoding
- `forceCompress?: boolean` - Force compression even for small items

```typescript
await cache.set('user-42', userData, {
  ttl: 3600000, // 1 hour
  forceCompress: true,
});
```

#### `get<T>(key: string, options?: CacheGetOptions<T>): Promise<T | null>`

Retrieve a value from cache.

**Options:**
- `staleWhileRevalidate?: boolean` - Enable stale-while-revalidate
- `revalidate?: () => Promise<T>` - Function to fetch fresh data
- `ttlOnRevalidate?: number` - TTL for revalidated data

```typescript
const data = await cache.get<UserProfile>('user-42', {
  staleWhileRevalidate: true,
  revalidate: () => fetchUserFromAPI(42),
  ttlOnRevalidate: 600000, // 10 minutes
});
```

#### `remove(key: string): Promise<void>`

Remove a specific cache entry.

```typescript
await cache.remove('user-42');
```

#### `clear(): Promise<void>`

Clear all cache entries.

```typescript
await cache.clear();
```

#### `namespace(namespace: string): CacheEngine`

Create a new cache instance with a namespace prefix.

```typescript
const imageCache = cache.namespace('images');
```

---

## 💡 Examples

### Example 1: API Response Caching

```typescript
async function fetchUserProfile(userId: number) {
  const cacheKey = `user:${userId}`;
  
  // Try cache first
  let profile = await cache.get(cacheKey);
  
  if (!profile) {
    // Fetch from API if not cached
    const response = await fetch(`/api/users/${userId}`);
    profile = await response.json();
    
    // Cache for 5 minutes
    await cache.set(cacheKey, profile, {
      ttl: 5 * 60 * 1000,
    });
  }
  
  return profile;
}
```

### Example 2: Offline Form Draft

```typescript
// Auto-save form data
const formCache = cache.namespace('forms');

// Save on user input
async function saveFormDraft(formData: any) {
  await formCache.set('checkout-draft', formData, {
    ttl: 24 * 60 * 60 * 1000, // 24 hours
  });
}

// Restore on page load
async function restoreFormDraft() {
  const draft = await formCache.get('checkout-draft');
  if (draft) {
    populateForm(draft);
  }
}
```

### Example 3: Image Caching for PWA

```typescript
const imageCache = cache.namespace('images');

async function cacheImage(url: string) {
  const response = await fetch(url);
  const blob = await response.blob();
  const base64 = await blobToBase64(blob);
  
  await imageCache.set(url, base64, {
    ttl: 7 * 24 * 60 * 60 * 1000, // 1 week
    forceCompress: true,
  });
}

async function getImage(url: string): Promise<string | null> {
  return await imageCache.get(url);
}
```

### Example 4: Stale-While-Revalidate Pattern

```typescript
async function getProductList() {
  return await cache.get('products', {
    staleWhileRevalidate: true,
    revalidate: async () => {
      const response = await fetch('/api/products');
      const products = await response.json();
      
      // Update cache with fresh data
      await cache.set('products', products, {
        ttl: 10 * 60 * 1000, // 10 minutes
      });
      
      return products;
    },
    ttlOnRevalidate: 10 * 60 * 1000,
  });
}
```

### Example 5: Multi-Namespace Architecture

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
      maxSize: 200 * 1024 * 1024, // 200 MB
    });
    
    this.users = this.cache.namespace('users');
    this.posts = this.cache.namespace('posts');
    this.media = this.cache.namespace('media');
    this.config = this.cache.namespace('config');
  }
  
  async clearAll() {
    await this.cache.clear();
  }
}

// Usage
const appCache = new AppCache();
await appCache.users.set('profile-42', userData);
await appCache.posts.set('recent', postsData);
```

### Example 6: React Hook Integration

```typescript
import { useEffect, useState } from 'react';
import { CacheEngine } from 'cache-craft-engine';

const cache = new CacheEngine();

function useCachedData<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl = 300000 // 5 minutes
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    async function loadData() {
      // Try cache first with stale-while-revalidate
      const cached = await cache.get<T>(key, {
        staleWhileRevalidate: true,
        revalidate: async () => {
          const fresh = await fetcher();
          await cache.set(key, fresh, { ttl });
          setData(fresh);
          return fresh;
        },
      });
      
      setData(cached);
      setLoading(false);
    }
    
    loadData();
  }, [key]);
  
  return { data, loading };
}

// Usage in component
function UserProfile({ userId }: { userId: number }) {
  const { data, loading } = useCachedData(
    `user-${userId}`,
    () => fetch(`/api/users/${userId}`).then(r => r.json()),
    600000 // 10 minutes
  );
  
  if (loading) return <div>Loading...</div>;
  return <div>{data?.name}</div>;
}
```

---

## 🎯 Best Practices

### 1. Choose Appropriate TTLs

```typescript
// Static content - long TTL
await cache.set('app-config', config, {
  ttl: 24 * 60 * 60 * 1000, // 24 hours
});

// Dynamic content - short TTL
await cache.set('live-scores', scores, {
  ttl: 30 * 1000, // 30 seconds
});

// User data - medium TTL
await cache.set('user-profile', profile, {
  ttl: 10 * 60 * 1000, // 10 minutes
});
```

### 2. Use Namespaces for Organization

```typescript
const cache = new CacheEngine();

const apiCache = cache.namespace('api');
const mediaCache = cache.namespace('media');
const offlineCache = cache.namespace('offline');

// Clear only API cache
await apiCache.clear();
```

### 3. Leverage Stale-While-Revalidate for Better UX

```typescript
// User sees instant response, data updates in background
const data = await cache.get('dashboard', {
  staleWhileRevalidate: true,
  revalidate: fetchDashboardData,
});
```

### 4. Set Appropriate Cache Size Limits

```typescript
// Mobile devices - conservative
const mobileCache = new CacheEngine({
  maxSize: 50 * 1024 * 1024, // 50 MB
});

// Desktop - generous
const desktopCache = new CacheEngine({
  maxSize: 500 * 1024 * 1024, // 500 MB
});
```

### 5. Never Cache Sensitive Data

```typescript
// ❌ DON'T
await cache.set('user-password', password);
await cache.set('credit-card', cardInfo);
await cache.set('auth-token', token);

// ✅ DO
await cache.set('user-preferences', preferences);
await cache.set('theme-settings', theme);
```

### 6. Handle Errors Gracefully

```typescript
async function getCachedData(key: string) {
  try {
    return await cache.get(key);
  } catch (error) {
    console.error('Cache error:', error);
    // Fallback to API
    return await fetchFromAPI(key);
  }
}
```

### 7. Monitor Cache Performance

```typescript
// Track cache hits/misses
let cacheHits = 0;
let cacheMisses = 0;

async function getWithStats(key: string) {
  const data = await cache.get(key);
  
  if (data) {
    cacheHits++;
  } else {
    cacheMisses++;
  }
  
  console.log(`Hit rate: ${(cacheHits / (cacheHits + cacheMisses) * 100).toFixed(2)}%`);
  
  return data;
}
```

---

## 🔧 Advanced Usage

### Custom Compression Threshold

```typescript
// Compress everything
const aggressiveCache = new CacheEngine({
  compressionThreshold: 1, // Compress from 1 byte
});

// Never auto-compress
const noCompressionCache = new CacheEngine({
  compressionThreshold: Infinity,
});
```

### Version Management

```typescript
// Upgrade database version
const cache = new CacheEngine({
  dbName: 'app-cache',
  version: 2, // Increment to trigger upgrade
});
```

---

## 🌐 Browser Support

CacheCraft requires browsers that support:
- **IndexedDB** (all modern browsers)
- **CompressionStream API** (Chrome 80+, Edge 80+, Safari 16.4+, Firefox 113+)

For older browsers, consider using a polyfill or fallback to localStorage.

---

## 📊 Performance

- **Compression**: 60-80% size reduction for JSON data
- **LRU Eviction**: O(n log n) complexity
- **Get/Set Operations**: ~1-5ms average (depending on data size)
- **Stale-While-Revalidate**: <1ms for cached responses

---

## 🤝 Contributing

Contributions are welcome! Please check out our [Contributing Guide](CONTRIBUTING.md).

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
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
- **Documentation**: [https://github.com/MJavadSF/CacheCraft/wiki](https://github.com/MJavadSF/CacheCraft/wiki)

---

## 💬 Support

- 📧 Email: mjavadsf72@gmail.com
- 🐛 Issues: [GitHub Issues](https://github.com/MJavadSF/CacheCraft/issues)
- 💡 Discussions: [GitHub Discussions](https://github.com/MJavadSF/CacheCraft/discussions)

---

<div align="center">

**Made with ❤️ by [Mohammad Javad](https://github.com/MJavadSF)**

If you find this project helpful, please consider giving it a ⭐️ on GitHub!

</div>