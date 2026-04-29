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

## 🆕 What's New in v0.3

- 🌐 **SSR-Safe** — No crash on server render; `isSSR()` + `createClientCache()` helpers for Next.js App Router
- ⚛️ **`createClientCache()`** — Returns `null` during SSR, a full `CacheEngine` in the browser
- 🔒 **Stricter TypeScript** — `unknown` replaces `any`, `readonly` arrays, `exactOptionalPropertyTypes`, branded
  `CacheKey`
- 🛡️ **`UnsupportedEnvironmentError`** — Descriptive error when IndexedDB is accessed server-side
- 🔁 **Parallel batch ops** — `batchSet/batchGet/batchDelete` now use `Promise.allSettled` for true parallelism
- 🍎 **Safari / iOS** — Compression falls back gracefully on Safari < 16.4; `isSafari()` helper exported
- 🌐 **`structuredClone`** — Used for deep cloning when available (Chrome 98+, Firefox 94+, Safari 15.4+)
- 🔑 **`crypto.randomUUID()`** — Used for instance IDs when available; legacy fallback retained
- 🔧 **`sideEffects: false`** in `package.json` — Enables full tree-shaking in Vite / webpack 5 / esbuild
- 📦 **Named exports only** — Cleaner import experience; default export kept for CJS compatibility

---

## 🎯 Overview

CacheCraft is a zero-dependency, production-ready caching library built on **IndexedDB**.  
It works in React, Next.js, Vue, Svelte, Angular and plain TypeScript / JavaScript.

### Why CacheCraft?

| Feature                  | Detail                                                                                 |
|--------------------------|----------------------------------------------------------------------------------------|
| 💾 Persistent            | Survives page reloads and browser restarts                                             |
| 🗜️ Compression          | Streams API gzip (Chrome 80+, Firefox 113+, Safari 16.4+), fallback for older browsers |
| 🔐 Encryption            | AES-GCM 256-bit via Web Crypto (all modern browsers + Node 15+)                        |
| ♻️ 7 Eviction strategies | LRU, LFU, FIFO, Priority, ARC, TTL, Size                                               |
| ⏱️ Flexible TTL          | With stale-while-revalidate support                                                    |
| 🌐 SSR-safe              | No crash in Next.js / Nuxt / Remix server environments                                 |
| 🔄 Tab sync              | BroadcastChannel keeps tabs consistent                                                 |
| 🔌 Plugin system         | 12+ built-in plugins, easy to extend                                                   |
| 📊 Admin panel           | Real-time stats, health checks, top-key reports                                        |
| 📦 Batch ops             | Parallel `batchSet` / `batchGet` / `batchDelete`                                       |
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

### Custom React Hook

```tsx
// hooks/useCache.ts
"use client";

import {createClientCache, type CacheConfig} from 'cache-craft-engine';
import {useRef} from 'react';

let _cache: ReturnType<typeof createClientCache> = null;

export function useCache(config?: CacheConfig) {
    const ref = useRef(_cache);

    if (!ref.current) {
        ref.current = createClientCache(config);
        _cache = ref.current;  // singleton per session
    }

    return ref.current;
}
```

```tsx
// Usage
"use client";
import {useCache} from '@/hooks/useCache';

export function ProductList() {
    const cache = useCache({dbName: 'products'});

    async function loadProducts() {
        if (!cache) return;
        const cached = await cache.get('products');
        if (cached) return cached;

        const data = await fetch('/api/products').then(r => r.json());
        await cache.set('products', data, {ttl: 2 * 60_000});
        return data;
    }

    // ...
}
```

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

| Strategy        | Description                | Best for            |
|-----------------|----------------------------|---------------------|
| `lru` (default) | Least Recently Used        | General caching     |
| `lfu`           | Least Frequently Used      | Hot-data retention  |
| `fifo`          | First In First Out         | Time-ordered data   |
| `priority`      | Lowest priority first      | Mixed criticality   |
| `arc`           | Adaptive Replacement Cache | Workload-adaptive   |
| `ttl`           | Expire-nearest first       | TTL-heavy workloads |
| `size`          | Largest entries first      | Storage pressure    |

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
// Parallel — resolves when ALL settle (no early throw)
const setResults = await cache.batchSet([
    {key: 'a', value: 1},
    {key: 'b', value: 2, options: {ttl: 60_000}},
]);

const getResults = await cache.batchGet([
    {key: 'a'},
    {key: 'b'},
]);

const deleteResults = await cache.batchDelete(['a', 'b']);

// Check individual results
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
    enableStats: true,
    enableSync: false,             // Cross-tab BroadcastChannel sync
    encryptionKey: '',                // AES-GCM passphrase ('' = disabled)
    autoCleanup: true,              // Remove expired entries periodically
    cleanupInterval: 60_000,            // 1 minute
    plugins: [],
    onError: (err) => console.error(err),
});
```

---

## 🔑 API Reference

### CacheEngine

| Method             | Signature                      | Description                                |
|--------------------|--------------------------------|--------------------------------------------|
| `set`              | `set<T>(key, value, options?)` | Store a value                              |
| `get`              | `get<T>(key, options?)`        | Retrieve a value (null if missing/expired) |
| `remove`           | `remove(key)`                  | Delete an entry                            |
| `clear`            | `clear()`                      | Delete all entries, returns count          |
| `has`              | `has(key)`                     | Check if key exists and is not expired     |
| `keys`             | `keys(pattern?)`               | List all keys, optionally filtered         |
| `size`             | `size()`                       | Total storage used (bytes)                 |
| `count`            | `count()`                      | Number of entries                          |
| `namespace`        | `namespace(ns)`                | Create namespaced sub-cache                |
| `setBlob`          | `setBlob(key, blob, options?)` | Store a Blob                               |
| `getBlob`          | `getBlob(key, type?)`          | Retrieve a Blob                            |
| `batchSet`         | `batchSet(items)`              | Parallel bulk set                          |
| `batchGet`         | `batchGet(items)`              | Parallel bulk get                          |
| `batchDelete`      | `batchDelete(keys)`            | Parallel bulk delete                       |
| `query`            | `query(query)`                 | Filter/sort entries                        |
| `getStats`         | `getStats()`                   | Snapshot of cache statistics               |
| `getDetailedStats` | `getDetailedStats()`           | Full stats including per-tag data          |
| `resetStats`       | `resetStats()`                 | Reset all counters                         |
| `export`           | `export(options?)`             | Serialisable snapshot                      |
| `import`           | `import(data, options?)`       | Restore from snapshot                      |
| `cleanup`          | `cleanup()`                    | Delete expired entries                     |
| `getHealth`        | `getHealth()`                  | Health status + issues                     |
| `getStorageInfo`   | `getStorageInfo()`             | Browser storage quota                      |
| `use`              | `use(plugin)`                  | Register a plugin                          |
| `removePlugin`     | `removePlugin(name)`           | Unregister a plugin                        |
| `on/off/once`      | `on(event, listener)`          | Event subscription                         |
| `destroy`          | `destroy()`                    | Teardown (close DB, stop timers)           |

### Factory Functions

| Function                     | Description                                                                   |
|------------------------------|-------------------------------------------------------------------------------|
| `createCache(config?)`       | Create a `CacheEngine` (throws at runtime on server if IndexedDB is accessed) |
| `createClientCache(config?)` | Returns `null` during SSR, `CacheEngine` in browser                           |

---

## 📚 Migration Guide

See [MIGRATION.md](./MIGRATION.md) for upgrading from v0.1 / v0.2.

---

## 📝 License

MIT © [Mohammad Javad Soleymani Fard](https://github.com/MJavadSF)
