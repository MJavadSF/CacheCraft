# 🚀 Quick Start — CacheCraft 1.0

## 1. Install

```bash
npm install cache-craft-engine
```

## 2. Create one cache per app

```ts
// cache.ts
import { createClientCache } from "cache-craft-engine";

export const cache = createClientCache({
    dbName: "my-app",
    maxSize: "50MB",
    defaultTTL: "1h",
    memoryCache: true, // fast repeated reads
}); // null during SSR
```

## 3. Cache API calls with `getOrSet`

```ts
const products = await cache!.getOrSet(
    "products",
    ({ signal }) => fetch("/api/products", { signal }).then((r) => r.json()),
    { ttl: "5m", staleWhileRevalidate: true, retry: 2, timeout: "8s", tags: ["catalog"] }
);

// after a mutation:
await cache!.invalidateByTag("catalog");
```

## 4. Use it from your framework

```tsx
// React / Next.js (client components)
import { CacheProvider, useCache } from "cache-craft-engine/react";

<CacheProvider config={{ dbName: "my-app", memoryCache: true }}>…</CacheProvider>;

const { data, error, isLoading, mutate } = useCache(`user:${id}`, () => api.user(id), { ttl: "5m" });
```

```ts
// Vue
import { useCache } from "cache-craft-engine/vue";
const { data } = useCache(() => `user:${props.id}`, () => api.user(props.id), { engine: cache });

// Svelte
import { cacheStore } from "cache-craft-engine/svelte";
const user = cacheStore(cache, `user:${id}`, () => api.user(id));
```

## 5. Open the DevTools while developing

```ts
import { mountDevtools } from "cache-craft-engine/devtools";
if (import.meta.env.DEV) mountDevtools(); // Alt+Shift+C
```

## Cheatsheet

| Task | Code |
|---|---|
| Read / write | `get(k)`, `set(k, v, { ttl: "10m", tags })` |
| Read without side effects | `peek(k)` |
| Value + age/TTL | `getWithMeta(k)` |
| Extend lifetime | `touch(k, "30m")` |
| Atomic update | `update(k, (cur) => next)` |
| Delete | `remove(k)`, `invalidateByTag(t)`, `invalidateByPattern(/^user:/)`, `clear()` |
| Many at once | `getMany(keys)`, `batchSet(items)`, `batchDelete(keys)` |
| Encrypt | `createCache({ encryptionKey })` + `set(k, v, { encrypt: true })` |
| Separate areas | `cache.namespace("users")` |
| Large files | `setBlob(k, blob)` / `getBlob(k)`, or `storage: "opfs"` |
| HTTP caching | `cachedFetch(cache, url)` from `cache-craft-engine/fetch` |
| Stats | `getStats()`, `getDetailedStats()`, `getHealth()` |

## Common questions

- **"IndexedDB is not available"** — you're on the server. Create caches on the client
  (`createClientCache`, `getSharedCache`, `<CacheProvider>`), or use `storage: "memory"` explicitly.
- **Another tab's data isn't showing** — it is, as of 1.0 (sync + read-through). If you disabled
  `enableSync`, call `cache.refresh()` to reload `keys()`/`count()`.
- **Cache is full** — raise `maxSize`/`maxEntries`, add `tagQuotas`, or pick another `evictionStrategy`.
- **Upgrading from 0.x** — nothing to do for your data; read [MIGRATION.md](./MIGRATION.md).

More in the [README](./README.md).
