# CacheCraft 🛠️

**A lightweight, fully client-side IndexedDB cache engine**  
With support for compression (gzip), encoding (base64), LRU eviction, TTL, stale-while-revalidate, and namespaces.

- **Framework-agnostic** → React, Vue, Svelte, Vanilla JS, etc.
- **Persistence** → Data survives page reloads and tab closures
- **Production-ready** → Smart eviction + size management + automatic compression

[![npm version](https://img.shields.io/npm/v/cache-craft-engine.svg?color=green)](https://www.npmjs.com/package/cache-craft-engine)
[![GitHub](https://img.shields.io/github/stars/MJavadSF/CacheCraft?style=social)](https://github.com/MJavadSF/CacheCraft)

---

## Key Features

- Persistent storage with **IndexedDB**
- **LRU eviction** (removes least recently used items when exceeding max size)
- **gzip compression** automatic for large items (>10KB by default)
- **Base64 encoding** optional
- **TTL** (time to live)
- **Stale-While-Revalidate** → Return stale data quickly + update in the background
- **Namespaces** for logical separation of caches (e.g., user / media / offline-forms)

---

## Installation

```bash
npm install cache-craft-engine
# Or directly from GitHub (before official release):
# npm install github:MJavadSF/CacheCraft
```

---

## Quick Usage

```ts
import { CacheEngine } from 'cache-craft-engine';

const cache = new CacheEngine({
  dbName: 'my-app-cache',
  maxSize: 150 * 1024 * 1024,     // 150 MB
  compressionThreshold: 8 * 1024, // Compress from 8 KB upwards
  namespace: 'app-v1',            // Optional
});

// Set
await cache.set('user-profile', { id: 42, name: 'Ali', avatar: '...' }, {
  ttl: 10 * 60 * 1000, // 10 minutes
});

// Simple get
const user = await cache.get<{ id: number; name: string }>('user-profile');

// Stale-while-revalidate (great for APIs)
const posts = await cache.get('posts-list', {
  staleWhileRevalidate: true,
  revalidate: async () => {
    const res = await fetch('/api/posts');
    const data = await res.json();
    await cache.set('posts-list', data, { ttl: 300_000 });
    return data;
  },
});

// Separate namespace
const imageCache = cache.namespace('images');
await imageCache.set('cover-001', { url: '/assets/cover.jpg', alt: '...' });
```

---

## Full API

```ts
// Create instance
const cache = new CacheEngine(config?: CacheConfig);

// Set
await cache.set(key: string, value: any, options?: CacheSetOptions);

// Get
await cache.get<T>(key: string, options?: CacheGetOptions<T>): Promise<T | null>;

// Remove single item
await cache.remove(key: string);

// Clear all cache
await cache.clear();

// Create sub-cache with namespace
const subCache = cache.namespace('prefix');
```

### CacheSetOptions

```ts
{
  ttl?: number;           // milliseconds
  encode?: boolean;       // Base64 encode?
  forceCompress?: boolean;// Compress even if small
}
```

### CacheGetOptions

```ts
{
  staleWhileRevalidate?: boolean;
  revalidate?: () => Promise<T>;
  ttlOnRevalidate?: number;
}
```

---

## Practical Examples

### Cache API Response with TTL

```ts
async function getUser(id: number) {
  const key = `user:${id}`;
  let data = await cache.get(key);

  if (!data) {
    const res = await fetch(`/api/users/${id}`);
    data = await res.json();
    await cache.set(key, data, { ttl: 60_000 }); // 1 minute
  }

  return data;
}
```

### Offline Form Draft

```ts
// Save on type
await cache.set('checkout:draft', formValues, { ttl: 24 * 60 * 60_000 });

// On page load
const saved = await cache.get('checkout:draft');
```

### Large Data with Forced Compression

```ts
await cache.set('analytics:2025', hugeJsonData, {
  forceCompress: true,
  ttl: 7 * 24 * 60 * 60_000, // One week
});
```

---

## Best Practices

- Always use **namespaces** for different data types
- Never cache **sensitive data** (tokens, passwords)
- Choose **appropriate TTL** (long for static, short for APIs)
- Use **staleWhileRevalidate** for high-traffic pages
- Set **maxSize** based on user devices (lower for mobile)

---

## Links

- GitHub: [CacheCraft](https://github.com/MJavadSF/CacheCraft/)
- npm: [cache-craft-engine](https://www.npmjs.com/package/cache-craft-engine)