# CacheCraft 🚀

<div align="center">

[![npm version](https://img.shields.io/npm/v/cache-craft-engine.svg?color=green&style=for-the-badge)](https://www.npmjs.com/package/cache-craft-engine)
[![npm downloads](https://img.shields.io/npm/dm/cache-craft-engine.svg?style=for-the-badge)](https://www.npmjs.com/package/cache-craft-engine)
[![GitHub stars](https://img.shields.io/github/stars/MJavadSF/CacheCraft?style=for-the-badge)](https://github.com/MJavadSF/CacheCraft)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg?style=for-the-badge)](https://www.typescriptlang.org/)

**Enterprise-grade IndexedDB caching library — SSR-safe, Next.js-ready, React-friendly**

[Features](#-key-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [Next.js Guide](#-nextjs--react) • [API](#-api-reference) • [Plugins](#-built-in-plugins) • [Migration](#-migration)

</div>

---

## 🆕 What's New in v0.4

v0.4 is a major **performance and ergonomics** release. The engine now keeps an
in-memory metadata index so the hot paths never scan IndexedDB or deserialize
payloads.

- ⚡ **In-memory metadata index** — `size()`, `count()`, `keys()`, eviction, query
  pre-filtering and tag lookups are now O(1)/O(n-in-memory) instead of reading and
  decoding the whole database on every write. Hydrated once on first DB open.
- 📉 **No more read-path write amplification** — access-time / access-count updates
  are buffered in memory and flushed on an interval (`persistAccessMetadata`,
  `accessMetadataFlushInterval`), instead of writing back to IndexedDB on every `get`.
- 🧲 **`getOrSet()` (cache-aside) with stampede protection** — concurrent misses on
  the same key share a single factory call (single-flight), with optional
  stale-while-revalidate and `fallbackToStale`.
- 🏷️ **First-class tag invalidation** — `invalidateByTag()`, `invalidateByTags()`,
  `keysByTag()`, `allTags()`, backed by an in-memory tag index (no full scan).
- 🧱 **Atomic batch writes** — `batchSet()` / `batchDelete()` now run in a *single*
  IndexedDB transaction (all-or-nothing, much faster). New `getMany()` reads many
  keys in one transaction.
- ⚛️ **Official React hooks** — `import { useCache, useCacheValue, useCacheStats }
  from 'cache-craft-engine/react'`. SSR-safe, shared engine per config, SWR-style API.
- 🛠️ **Custom eviction policies** — pass `evictionStrategy: 'custom'` +
  `evictionPolicy`.
- 🐛 **Bug fixes** — compression + encoding/encryption combinations now round-trip
  correctly; `setBlob` now emits events, updates stats and broadcasts like `set`.
- ✏️ **`arc` → `segmented`** — the old "ARC" policy was never a true Adaptive
  Replacement Cache. It is renamed to the honest `segmented` (frequency-segmented,
  scan-resistant LRU). `arc` and `ARCEvictionPolicy` remain as deprecated aliases.

> **Backwards compatible.** Existing v0.3 code keeps working. See
> [MIGRATION.md](./MIGRATION.md) for the small notes.

---

## 🎯 Overview

CacheCraft is a zero-dependency, production-ready caching library built on **IndexedDB**.  
It works in React, Next.js, Vue, Svelte, Angular and plain TypeScript / JavaScript.

### Why CacheCraft?

| Feature                  | Detail                                                                                 |
|--------------------------|----------------------------------------------------------------------------------------|
| 💾 Persistent            | Survives page reloads and browser restarts                                             |
| ⚡ In-memory index       | O(1) `size`/`count`, scan-free eviction & queries — payloads read only when returned   |
| 🧲 `getOrSet`            | Cache-aside with single-flight stampede protection + stale-while-revalidate            |
| 🏷️ Tag invalidation     | `invalidateByTag` / `keysByTag` backed by an in-memory tag index                       |
| 🧱 Atomic batches        | `batchSet` / `batchDelete` in a single transaction; `getMany` in one read              |
| ⚛️ React hooks           | `useCache` / `useCacheValue` / `useCacheStats` from `cache-craft-engine/react`         |
| 🗜️ Compression          | Streams API gzip (Chrome 80+, Firefox 113+, Safari 16.4+), fallback for older browsers |
| 🔐 Encryption            | AES-GCM 256-bit via Web Crypto (all modern browsers + Node 15+)                        |
| ♻️ 7 Eviction strategies | LRU, LFU, FIFO, Priority, Segmented, TTL, Size (+ custom)                              |
| ⏱️ Flexible TTL          | With stale-while-revalidate support                                                    |
| 🌐 SSR-safe              | No crash in Next.js / Nuxt / Remix server environments                                 |
| 🔄 Tab sync              | BroadcastChannel keeps tabs (and their in-memory indexes) consistent                   |
| 🔌 Plugin system         | 12+ built-in plugins, easy to extend                                                   |
| 📊 Admin panel           | Real-time stats, health checks, top-key reports                                        |
| 🏷️ Tags & Namespaces    | Logical grouping for bulk invalidation                                                 |
| 🌳 Tree-shakeable        | `sideEffects: false` — import only what you use                                        |

---

## 📦 Installation

```bash
npm install cache-craft-engine
# or
yarn add cache-craft-engine
# or
pnpm add cache-craft-engine
```

---

## 🚀 Quick Start

### Vanilla JS / TypeScript

```typescript
import {createCache} from 'cache-craft-engine';

const cache = createCache({dbName: 'my-app'});

await cache.set('user', {id: 1, name: 'Ali'}, {ttl: 60_000});
const user = await cache.get('user');
await cache.remove('user');
await cache.clear();
```

### `getOrSet` — the cache-aside pattern (recommended)

The most common caching pattern in one call. If the key is cached and fresh it's
returned; otherwise the factory runs, the result is stored, and returned.
Concurrent calls for the same key share **one** factory execution (no stampede):

```typescript
const user = await cache.getOrSet(
    `user:${id}`,
    () => fetch(`/api/users/${id}`).then(r => r.json()),
    { ttl: 5 * 60_000, tags: ['users'] }
);

// Serve stale instantly, refresh in the background:
const feed = await cache.getOrSet('feed', loadFeed, {
    ttl: 60_000,
    staleWhileRevalidate: true,
    ttlOnRevalidate: 60_000,
});

// Keep serving the last good value if the factory fails:
const config = await cache.getOrSet('config', loadConfig, { fallbackToStale: true });
```

### Tag invalidation

```typescript
await cache.set('post:1', p1, { tags: ['posts', 'home'] });
await cache.set('post:2', p2, { tags: ['posts'] });

// After a mutation, drop everything tagged 'posts' in one O(n-tagged) call:
const removed = await cache.invalidateByTag('posts');   // → 2
await cache.invalidateByTags(['posts', 'home']);
const keys = await cache.keysByTag('posts');
```

### With Advanced Options

```typescript
import {createCache, LoggerPlugin, MetricsPlugin} from 'cache-craft-engine';

const cache = createCache({
    dbName: 'my-app-cache',
    maxSize: 150 * 1024 * 1024,  // 150 MB
    compressionThreshold: 10 * 1024,           // compress entries > 10 KB
    evictionStrategy: 'lfu',
    enableStats: true,
    enableSync: true,               // sync across browser tabs
    encryptionKey: process.env.NEXT_PUBLIC_CACHE_KEY,
    plugins: [
        new LoggerPlugin(),
        new MetricsPlugin(),
    ],
});

await cache.set('profile', userData, {
    ttl: 10 * 60 * 1000,   // 10 minutes
    tags: ['user', 'active'],
    priority: 10,
    encrypt: true,
});
```

---

## ⚛️ Next.js / React

### App Router — Client Component

```tsx
// app/components/UserCard.tsx
"use client";

import {createClientCache} from 'cache-craft-engine';
import {useEffect, useState} from 'react';

// createClientCache() returns null on the server — safe to call at module level
const cache = createClientCache({dbName: 'user-cache'});

export function UserCard({userId}: { userId: string }) {
    const [user, setUser] = useState(null);

    useEffect(() => {
        if (!cache) return;                      // guard for safety

        cache.get(`user:${userId}`).then(async (cached) => {
            if (cached) return setUser(cached);

            const data = await fetch(`/api/users/${userId}`).then(r => r.json());
            await cache.set(`user:${userId}`, data, {ttl: 5 * 60_000});
            setUser(data);
        });
    }, [userId]);

    return <div>{user?.name}</div>;
}
```

### App Router — Server Component (safe boundary)

```tsx
// app/page.tsx — Server Component, cache NOT used here
import {UserCard} from './components/UserCard';

export default function Page() {
    // CacheCraft is IndexedDB-based — browser-only.
    // Use it inside Client Components only.
    return <UserCard userId="42"/>;
}
```

### Pages Router — `getStaticProps` / `getServerSideProps`

```ts
// pages/index.tsx
import {isSSR} from 'cache-craft-engine';

export async function getServerSideProps() {
    // isSSR() === true here — do NOT instantiate CacheEngine
    const data = await fetchFromDB();
    return {props: {data}};
}
```

### Official React hooks (`cache-craft-engine/react`)

v0.4 ships first-class, SSR-safe hooks. They share one engine per `dbName`
(so multiple components reading the same key hit the same in-memory cache).

```tsx
"use client";
import { useCache } from 'cache-craft-engine/react';

export function ProductList() {
    const { data, error, isLoading, isValidating, refresh, invalidate, mutate } =
        useCache(
            'products',
            () => fetch('/api/products').then(r => r.json()),
            { ttl: 2 * 60_000, tags: ['products'], config: { dbName: 'shop' } }
        );

    if (isLoading) return <Spinner />;
    if (error) return <Error onRetry={refresh} />;

    return (
        <>
            {isValidating && <RefreshingBadge />}
            <ul>{data?.map(p => <li key={p.id}>{p.name}</li>)}</ul>
            <button onClick={refresh}>Refresh</button>
        </>
    );
}
```

Other hooks:

```tsx
import { useCacheValue, useCacheStats, useCacheEngine } from 'cache-craft-engine/react';

// Read-only subscription to a single key (updates on local + cross-tab writes)
const token = useCacheValue<string>('auth:token', { config: { dbName: 'app' } });

// Live stats snapshot via useSyncExternalStore
const stats = useCacheStats({ config: { dbName: 'app' } });

// Direct access to the shared engine for imperative calls
const cache = useCacheEngine({ dbName: 'app' });
```

> `useCache` supports `enabled` (conditional fetching), `revalidateOnFocus`,
> and all `getOrSet` options (`staleWhileRevalidate`, `fallbackToStale`, `ttl`,
> `tags`, …).


### Next.js Middleware (Edge Runtime)

> ⚠️ Edge Runtime does not support IndexedDB. CacheCraft is a **browser-only** library. Do not import or instantiate it
> in middleware.

---

## 🔌 Built-in Plugins

```typescript
import {
    LoggerPlugin,          // console.log all operations
    MetricsPlugin,         // per-key hit/miss counters
    ValidationPlugin,      // schema validation per key pattern
    TTLRefreshPlugin,      // extend TTL on every access
    CompressionOptimizerPlugin, // auto-enable compression above threshold
    TagManagerPlugin,      // in-memory tag index
    RateLimiterPlugin,     // throttle operations per key
    PrefetchPlugin,        // background-load related keys
    WarmupPlugin,          // pre-populate on startup
    PersistencePlugin,     // localStorage fallback mirror
    AnalyticsPlugin,       // custom analytics events
    DebugPlugin,           // verbose debug logging
} from 'cache-craft-engine';
```

### Custom Plugin

```typescript
import type {CachePlugin} from 'cache-craft-engine';

const sentryPlugin: CachePlugin = {
    name: 'sentry',
    onError(error, operation) {
        Sentry.captureException(error, {extra: {operation}});
    },
};

cache.use(sentryPlugin);
```

---

## 🗑️ Eviction Strategies

| Strategy        | Description                          | Best for            |
|-----------------|--------------------------------------|---------------------|
| `lru` (default) | Least Recently Used                  | General caching     |
| `lfu`           | Least Frequently Used                | Hot-data retention  |
| `fifo`          | First In First Out                   | Time-ordered data   |
| `priority`      | Lowest priority first                | Mixed criticality   |
| `segmented`     | Frequency-segmented, scan-resistant  | Workload-adaptive   |
| `ttl`           | Expire-nearest first                 | TTL-heavy workloads |
| `size`          | Largest entries first                | Storage pressure    |
| `custom`        | Your own `EvictionPolicy`            | Special cases       |

> `arc` is a deprecated alias of `segmented` (the previous "ARC" was never a true
> Adaptive Replacement Cache). Use `segmented` going forward.

### Custom eviction policy

```typescript
import { createCache, type EvictionPolicy } from 'cache-craft-engine';

const evenKeysFirst: EvictionPolicy = {
    name: 'even-first',
    shouldEvict(metas, maxSize, currentSize) {
        // metas are lightweight CacheEntryMeta (no payloads)
        let free = currentSize - maxSize;
        const out: string[] = [];
        for (const m of metas) {
            if (free <= 0) break;
            out.push(m.key);
            free -= m.size;
        }
        return out;
    },
};

const cache = createCache({ evictionStrategy: 'custom', evictionPolicy: evenKeysFirst });
```

---

## 📊 Admin Panel

```typescript
import {CacheAdminPanel} from 'cache-craft-engine';

const admin = new CacheAdminPanel(cache);

// Full data snapshot
const data = await admin.getData();
console.log(data.health.status);       // 'healthy' | 'warning' | 'critical'
console.log(data.stats.hitRate);       // 0–1

// Plain-text report
const report = await admin.generateReport();
console.log(report);

// UI dashboard data
const dashboard = await admin.getDashboardData();
// { overview, charts, alerts }
```

---

## 🔍 Query System

```typescript
// Find recently accessed user entries, largest first
const results = await cache.query({
    tags: ['users'],
    sortBy: 'lastAccessed',
    sortOrder: 'desc',
    limit: 20,
    minPriority: 5,
});

// Find expired entries for bulk cleanup
const stale = await cache.query({expired: true});
await cache.batchDelete(stale.map(r => r.key));
```

---

## 📦 Batch Operations

```typescript
// Atomic — batchSet writes all items in a SINGLE IndexedDB transaction
const setResults = await cache.batchSet([
    {key: 'a', value: 1},
    {key: 'b', value: 2, options: {ttl: 60_000}},
]);

// getMany reads many keys in one readonly transaction → Map<key, value|null>
const map = await cache.getMany(['a', 'b', 'c']);
map.get('a'); // 1

// batchGet returns per-key BatchResult objects
const getResults = await cache.batchGet([{key: 'a'}, {key: 'b'}]);

// batchDelete removes all keys in a single transaction
const deleteResults = await cache.batchDelete(['a', 'b']);

for (const r of setResults) {
    if (!r.success) console.error(r.key, r.error);
}
```

---

## 🔔 Events

```typescript
cache.on('hit', ({key}) => console.log('HIT', key));
cache.on('miss', ({key}) => console.log('MISS', key));
cache.on('evict', ({metadata}) => console.log('Evicted', metadata?.count));
cache.on('error', ({error}) => console.error(error));

// One-time listener
cache.once('set', ({key}) => console.log('First set:', key));
```

---

## 🔐 Encryption

```typescript
const cache = createCache({encryptionKey: 'my-secret-passphrase'});

await cache.set('token', sensitiveData, {encrypt: true});
const token = await cache.get('token'); // automatically decrypted
```

Uses **AES-GCM 256-bit** with PBKDF2 key derivation (100 000 iterations, SHA-256).  
Available in Chrome 37+, Firefox 34+, Safari 15+, Edge 79+, Node 15+.

---

## 📤 Export / Import

```typescript
// Backup
const snapshot = await cache.export({includeExpired: false});
localStorage.setItem('cache-backup', JSON.stringify(snapshot));

// Restore
const raw = localStorage.getItem('cache-backup')!;
const imported = await cache.import(JSON.parse(raw), {
    overwrite: false,
    skipInvalid: true,
});
console.log(`Imported ${imported} entries`);
```

---

## 🌐 Browser Compatibility

| Feature              | Chrome | Firefox | Safari | iOS Safari | Samsung Internet |
|----------------------|--------|---------|--------|------------|------------------|
| IndexedDB            | 24+    | 16+     | 10+    | 10+        | 4+               |
| CompressionStream    | 80+    | 113+    | 16.4+  | 16.4+      | 13.0+            |
| Web Crypto (AES-GCM) | 37+    | 34+     | 15+    | 15+        | 4+               |
| BroadcastChannel     | 54+    | 38+     | 15.4+  | 15.4+      | 6.0+             |
| structuredClone      | 98+    | 94+     | 15.4+  | 15.4+      | 16+              |
| crypto.randomUUID    | 92+    | 95+     | 15.4+  | 15.4+      | 16+              |

> CompressionStream and DecompressionStream fall back to identity (no compression) on unsupported browsers, so the
> library works everywhere — just without gzip compression.

---

## ⚙️ Full Configuration

```typescript
const cache = createCache({
    dbName: 'my-app',          // IndexedDB database name
    version: 1,                 // Schema version
    storeName: 'cache',           // Object store name
    maxSize: 100 * 1024 * 1024, // 100 MB
    compressionThreshold: 10 * 1024,         // 10 KB — compress larger entries
    namespace: 'v2',              // Key prefix
    evictionStrategy: 'lru',
    evictionPolicy: undefined,         // your EvictionPolicy when strategy is 'custom'
    enableStats: true,
    enableSync: false,             // Cross-tab BroadcastChannel sync
    encryptionKey: '',                // AES-GCM passphrase ('' = disabled)
    autoCleanup: true,              // Remove expired entries periodically
    cleanupInterval: 60_000,            // 1 minute
    persistAccessMetadata: true,           // Buffer & flush access-time writes (v0.4)
    accessMetadataFlushInterval: 1_000,         // Flush cadence in ms (v0.4)
    plugins: [],
    onError: (err) => console.error(err),
});
```

> **Tuning reads:** set `persistAccessMetadata: false` if you don't rely on
> persisted `lastAccessed`/`accessCount` across reloads — reads then perform
> **zero** writes. With it `true` (default), updates are coalesced and flushed
> every `accessMetadataFlushInterval` ms in a single transaction.

---

## 🔑 API Reference

### CacheEngine

| Method             | Signature                      | Description                                |
|--------------------|--------------------------------|--------------------------------------------|
| `set`              | `set<T>(key, value, options?)` | Store a value                              |
| `get`              | `get<T>(key, options?)`        | Retrieve a value (null if missing/expired) |
| `getOrSet`         | `getOrSet<T>(key, factory, options?)` | Cache-aside with single-flight stampede protection |
| `remove`           | `remove(key)`                  | Delete an entry                            |
| `clear`            | `clear()`                      | Delete all entries, returns count          |
| `has`              | `has(key)`                     | Check if key exists and is not expired     |
| `keys`             | `keys(pattern?)`               | List all keys, optionally filtered         |
| `keysByTag`        | `keysByTag(tag)`               | Keys associated with a tag                  |
| `invalidateByTag`  | `invalidateByTag(tag)`         | Delete all entries with a tag, returns count |
| `invalidateByTags` | `invalidateByTags(tags)`       | Delete entries matching ANY tag             |
| `allTags`          | `allTags()`                    | All tags currently in use                   |
| `size`             | `size()`                       | Total storage used (bytes) — O(1)          |
| `count`            | `count()`                      | Number of entries — O(1)                   |
| `namespace`        | `namespace(ns)`                | Create namespaced sub-cache                |
| `setBlob`          | `setBlob(key, blob, options?)` | Store a Blob                               |
| `getBlob`          | `getBlob(key, type?)`          | Retrieve a Blob                            |
| `batchSet`         | `batchSet(items)`              | Atomic bulk set (single transaction)       |
| `getMany`          | `getMany(keys)`                | Read many keys in one transaction → Map     |
| `batchGet`         | `batchGet(items)`              | Bulk get (per-key results)                 |
| `batchDelete`      | `batchDelete(keys)`            | Atomic bulk delete (single transaction)    |
| `query`            | `query(query)`                 | Filter/sort entries                        |
| `getStats`         | `getStats()`                   | Snapshot of cache statistics               |
| `getDetailedStats` | `getDetailedStats()`           | Full stats including per-tag data          |
| `resetStats`       | `resetStats()`                 | Reset all counters                         |
| `export`           | `export(options?)`             | Serialisable snapshot                      |
| `import`           | `import(data, options?)`       | Restore from snapshot                      |
| `cleanup`          | `cleanup()`                    | Delete expired entries                     |
| `flushAccessMetadata` | `flushAccessMetadata()`     | Force-persist buffered access metadata      |
| `getHealth`        | `getHealth()`                  | Health status + issues                     |
| `getStorageInfo`   | `getStorageInfo()`             | Browser storage quota                      |
| `use`              | `use(plugin)`                  | Register a plugin                          |
| `removePlugin`     | `removePlugin(name)`           | Unregister a plugin                        |
| `on/off/once`      | `on(event, listener)`          | Event subscription                         |
| `destroy`          | `destroy()`                    | Teardown (flush, close DB, stop timers)    |

### Factory Functions

| Function                     | Description                                                                   |
|------------------------------|-------------------------------------------------------------------------------|
| `createCache(config?)`       | Create a `CacheEngine` (throws at runtime on server if IndexedDB is accessed) |
| `createClientCache(config?)` | Returns `null` during SSR, `CacheEngine` in browser                           |

### React hooks (`cache-craft-engine/react`)

| Hook              | Description                                                       |
|-------------------|-----------------------------------------------------------------|
| `useCache`        | Cache-aside data fetching (`data/error/isLoading/refresh/mutate`) |
| `useCacheValue`   | Read-only subscription to one key (local + cross-tab updates)     |
| `useCacheStats`   | Live stats snapshot via `useSyncExternalStore`                    |
| `useCacheEngine`  | Stable shared `CacheEngine` for a given config                    |
| `getSharedCache`  | Imperative access to the per-config engine singleton             |

---

## 📚 Migration Guide

See [MIGRATION.md](./MIGRATION.md) for upgrading from v0.1 / v0.2.

---

## 📝 License

MIT © [Mohammad Javad Soleymani Fard](https://github.com/MJavadSF)
