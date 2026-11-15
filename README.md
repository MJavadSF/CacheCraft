# CacheCraft 🚀

<div align="center">

[![npm version](https://img.shields.io/npm/v/cache-craft-engine.svg?color=green&style=for-the-badge)](https://www.npmjs.com/package/cache-craft-engine)
[![npm downloads](https://img.shields.io/npm/dm/cache-craft-engine.svg?style=for-the-badge)](https://www.npmjs.com/package/cache-craft-engine)
[![CI](https://img.shields.io/github/actions/workflow/status/MJavadSF/CacheCraft/ci.yml?style=for-the-badge&label=CI)](https://github.com/MJavadSF/CacheCraft/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue.svg?style=for-the-badge)](https://www.typescriptlang.org/)

**A production-grade browser cache — IndexedDB / OPFS, cross-tab coherent, encrypted, observable.**

[Install](#-installation) • [Quick start](#-quick-start) • [Storage](#-storage-backends) • [React](#%EF%B8%8F-react--nextjs) • [Vue](#-vue) • [Svelte](#-svelte) • [DevTools](#%EF%B8%8F-devtools-panel) • [API](#-api-reference) • [Migration](./MIGRATION.md)

</div>

---

## ✨ Features

- **Cache-aside done right** — `getOrSet` with single-flight (per tab *and* across tabs), stale-while-revalidate, `fallbackToStale`, retries with backoff, timeouts and `AbortSignal`.
- **Isolated namespaces** — namespaces never see, count, evict or clear each other's data.
- **Coherent across tabs and engines** — BroadcastChannel sync plus read-through, so another tab's writes are never invisible.
- **Pluggable storage** — IndexedDB (default), OPFS (large binaries), memory, localStorage / sessionStorage, or your own adapter.
- **Encryption** — AES-GCM-256, PBKDF2 (600k iterations) with a random per-database salt, `CryptoKey` support and **key rotation**.
- **Rich values** — `Date`, `Map`, `Set`, `BigInt`, `RegExp`, `URL`, typed arrays… round-trip; or plug in your own serializer.
- **Fast** — in-memory metadata index, optional memory tier (L1) of decoded values, batched access tracking, one transaction per batch.
- **Budgets** — byte size, entry count and per-tag quotas, 7 eviction strategies, automatic recovery from quota errors.
- **Safe evolution** — Standard Schema validation (Zod, Valibot, ArkType…) and `schemaVersion` + `migrate()`.
- **Integrations** — React (hooks, provider, Suspense), Vue, Svelte, TanStack Query persister, `cachedFetch` with HTTP semantics, Service Worker / Workbox handler, OpenTelemetry.
- **DevTools panel** — browse, edit, invalidate and monitor every cache on the page.
- **SSR-safe and tree-shakeable** — ~19 kB brotli for the core, subpath entry points for everything else.

---

## 📦 Installation

```bash
npm install cache-craft-engine
```

Requirements: a modern browser (Chrome/Edge 80+, Firefox 113+, Safari 16.4+) or a Web/Service Worker. Node.js ≥ 20 for SSR builds (use `storage: "memory"` to run on a server).

---

## 🚀 Quick start

```ts
import { createCache } from "cache-craft-engine";

const cache = createCache({ dbName: "my-app", maxSize: "50MB", defaultTTL: "1h" });

await cache.set("user:1", { name: "Ada", joined: new Date() }, { ttl: "10m", tags: ["users"] });
const user = await cache.get<User>("user:1"); // Date comes back as a Date

// The recommended pattern: cache-aside with single-flight.
const products = await cache.getOrSet(
    "products",
    ({ signal }) => fetch("/api/products", { signal }).then((r) => r.json()),
    { ttl: "5m", staleWhileRevalidate: true, retry: 2, timeout: "8s" }
);

await cache.invalidateByTag("users");
```

### `getOrSet` in depth

```ts
const data = await cache.getOrSet(
    "report",
    async ({ signal, attempt, stale }) => {
        // `stale` is the expired value, if any (e.g. for conditional requests)
        return api.report({ signal });
    },
    {
        ttl: "15m",
        ttlJitter: 0.1,              // expire somewhere in the last 10 % to avoid stampedes
        staleWhileRevalidate: true,  // serve the expired value now, refresh in the background
        fallbackToStale: true,       // serve the expired value if the factory fails…
        maxStale: "1d",              // …but never one older than a day
        retry: { retries: 3, delay: "200ms", factor: 2 },
        timeout: "10s",              // TimeoutError + aborts the factory's signal
        signal: controller.signal,   // this caller can give up (others keep waiting)
        crossTab: true,              // only one tab runs the factory (Web Locks)
        schema: ReportSchema,        // validate cached values (Standard Schema)
    }
);
```

Concurrent calls for the same key share one factory run. If every waiting caller aborts, the factory's `signal` is aborted too.

### Other everyday helpers

```ts
await cache.peek("k");                    // no stats, events, access tracking or deletion
await cache.getWithMeta("k");             // { value, info: { age, ttlRemaining, tags, … } }
await cache.touch("k", "30m");            // extend the lifetime without rewriting (null = never expire)
await cache.update<number>("counter", (n) => (n ?? 0) + 1); // serialised read-modify-write
await cache.invalidateByPattern(/^user:/);
await cache.getMany(["a", "b", "c"]);     // one storage transaction
```

---

## 🧱 Namespaces

```ts
const cache = createCache({ dbName: "app" });
const users = cache.namespace("users");
const images = cache.namespace("images", { maxSize: "200MB", storage: "opfs" });

await users.clear(); // only users — never the root or other namespaces
```

Each namespace has its own budget, index and eviction. Plugin factories (`plugins: [() => new MyPlugin()]`) are instantiated once per namespace; plugin instances are shared.

---

## 💾 Storage backends

| `storage`          | Persistent | Best for |
|--------------------|:---------:|----------|
| `"indexeddb"` *(default)* | ✅ | Everything |
| `"opfs"`           | ✅ | Large binary payloads (images, media, model files) |
| `"memory"`         | ❌ | Tests, Node/edge runtimes, ephemeral data |
| `"localStorage"`   | ✅ | Tiny caches where IndexedDB is unavailable (~5 MB) |
| `"sessionStorage"` | per tab | Tab-scoped data |
| your adapter       | — | Implement `StorageAdapter` (contract tests included in the repo) |

Several logical stores can share one database (`storeName`); object stores are created automatically.

> ⚠️ A `"memory"` cache created at module level on a server is shared by **all** requests. Don't cache per-user data in it during SSR.

---

## 🔐 Encryption

```ts
const cache = createCache({
    encryptionKey: process.env.NEXT_PUBLIC_CACHE_KEY, // or a non-extractable CryptoKey
    decryptionKeys: [OLD_KEY],                         // older keys stay readable
});

await cache.set("token", secret, { encrypt: true });

// Rotate: re-encrypts every encrypted entry of this namespace with the new key.
await cache.rotateKey(NEW_KEY);
```

- AES-GCM-256; passphrases are stretched with PBKDF2-SHA-256 (600 000 iterations, configurable via `kdfIterations`) and a **random salt per database**.
- Each entry records which key encrypted it; entries from ≤0.5 remain readable with the same passphrase.
- `encrypt: true` without a key throws `EncryptionError` — CacheCraft never silently stores plaintext.
- Metadata (keys, tags, `metadata`) is **not** encrypted — don't put secrets in keys.

---

## 🧬 Values, serialization and schemas

The default `"rich"` serializer round-trips `Date`, `Map`, `Set`, `BigInt`, `RegExp`, `URL`, `Error`, typed arrays, `ArrayBuffer`, `NaN`/`±Infinity`, `-0` and nested `undefined`. Use `serializer: "json"` for plain JSON, or provide `{ name, serialize, deserialize }` (e.g. superjson). Entries remember their serializer.

```ts
// Validate cached values (Zod, Valibot, ArkType… anything implementing Standard Schema)
const user = await cache.get("user:1", { schema: UserSchema }); // invalid → deleted, miss

// Evolve the shape of cached data
createCache({
    schemaVersion: 2,
    migrate: (value, fromVersion) => (fromVersion === 1 ? upgrade(value) : undefined), // undefined = drop
});
```

### Type-safe keys

```ts
type Schema = { [k: `user:${string}`]: User; settings: Settings };
const cache = createTypedCache<Schema>({ dbName: "app" });
const u = await cache.get("user:42"); // User | null
await cache.set("settings", 1);        // ✗ compile error
```

---

## ⚡ Performance features

```ts
createCache({
    memoryCache: { maxEntries: 500, maxSize: "10MB" }, // L1 of decoded values (≈50× faster hits)
    compression: { algorithm: "gzip", threshold: "10KB", minRatio: 0.9 }, // skips incompressible data
    maxSize: "100MB",
    maxEntries: 10_000,
    tagQuotas: { thumbnails: { maxSize: "20MB" } },
    evictionStrategy: "lru",   // lru | lfu | fifo | priority | segmented | ttl | size | custom
    evictionTarget: 0.9,       // when over budget, evict down to 90 %
    quotaRecovery: true,       // on QuotaExceededError: evict and retry once
});
```

Memory-tier values are shared references — treat them as immutable, or set `memoryCache: { clone: true }`. See [`bench/RESULTS.md`](./bench/RESULTS.md) for real-browser numbers against idb-keyval, localForage and Dexie (`npm run bench`).

---

## 🔄 Across tabs

- `enableSync` (default `true`): writes, deletes, evictions and clears are broadcast (keys only — never values). Other tabs refresh their index and memory tier.
- **Read-through** (default `true`): a key missing from the index is looked up in storage before reporting a miss.
- `crossTab: { singleFlight: true }`: only one tab runs a `getOrSet` factory for a key.
- `crossTab: { leaderCleanup: true }` (default): only one tab runs periodic cleanup.

---

## ⚛️ React / Next.js

```tsx
"use client";
import { CacheProvider, useCache, useSuspenseCache, useCacheDevtools } from "cache-craft-engine/react";

export function Providers({ children }: { children: React.ReactNode }) {
    useCacheDevtools(); // dev only by default; loaded lazily
    return <CacheProvider config={{ dbName: "app", memoryCache: true }}>{children}</CacheProvider>;
}

function Profile({ id }: { id: string }) {
    const { data, error, isLoading, isValidating, refresh, mutate, invalidate } = useCache(
        `user:${id}`,
        ({ signal }) => api.user(id, { signal }),
        { ttl: "5m", revalidateOnFocus: true, revalidateOnReconnect: true, keepPreviousData: true }
    );
    // mutate(next | (cur) => next) is optimistic and rolls back on failure
}

function Settings() {
    const { data } = useSuspenseCache("settings", () => api.settings()); // inside <Suspense>
}
```

- Hooks on the same key stay in sync (including across tabs); `invalidate()` makes them refetch.
- `fallbackData` lets you hydrate with data from a Server Component.
- During SSR hooks are inert (`getSharedCache()` returns `null`). Create engines on the client (`createClientCache`, `getSharedCache`, or the provider).
- `prefetchCache(engine, key, factory)` warms the cache from route loaders.

---

## 🟩 Vue

```ts
import { provideCache, useCache } from "cache-craft-engine/vue";

// in your root component's setup():
provideCache(createClientCache({ dbName: "app" }));

// anywhere below:
const { data, error, isLoading, refresh, mutate } = useCache(
    () => `user:${props.id}`,
    () => api.user(props.id),
    { ttl: "5m", revalidateOnFocus: true }
);
```

Also: `useCacheValue`, `useCacheStats`, and `CacheEngineKey` for `app.provide`.

## 🟧 Svelte

```svelte
<script>
  import { cacheStore } from "cache-craft-engine/svelte";
  const user = cacheStore(cache, `user:${id}`, () => api.user(id), { ttl: "5m" });
</script>

{#if $user.isLoading}Loading…{:else}{$user.data.name}{/if}
```

Stores follow the Svelte store contract (no dependency on `svelte`): `cacheStore`, `cacheValueStore`, `cacheStatsStore`.

## 🌸 TanStack Query

```ts
import { createCacheCraftPersister } from "cache-craft-engine/tanstack-query";

const persister = createCacheCraftPersister(cache, { maxAge: "24h", encrypt: true });
// <PersistQueryClientProvider client={queryClient} persistOptions={{ persister }}>
```

`createCacheCraftStorage(cache)` provides an AsyncStorage for `experimental_createQueryPersister`.

---

## 🌐 `cachedFetch` and Service Workers

```ts
import { cachedFetch, createFetchHandler } from "cache-craft-engine/fetch";

const res = await cachedFetch(cache, "/api/products");                 // HTTP semantics
const res2 = await cachedFetch(cache, url, init, { strategy: "stale-while-revalidate", ttl: "5m" });

// Service worker (or Workbox: registerRoute(match, handler))
const handler = createFetchHandler(cache, { strategy: "network-first", networkTimeout: "3s" });
self.addEventListener("fetch", (e) => e.respondWith(handler({ request: e.request })));
```

- `"http"` (default) honours `Cache-Control` (`max-age`, `no-store`, `no-cache`, `must-revalidate`), `Expires`, and revalidates with `ETag` / `Last-Modified` (a 304 refreshes the entry).
- Strategies: `http`, `cache-first`, `network-first`, `stale-while-revalidate`, `cache-only`, `network-only`.
- Concurrent requests for the same URL share one network request; responses carry `x-cachecraft-cache: HIT | MISS | STALE | REVALIDATED`.

---

## 🛠️ DevTools panel

```ts
import { mountDevtools } from "cache-craft-engine/devtools";

if (import.meta.env.DEV) mountDevtools(); // every cache on the page; toggle with Alt+Shift+C
```

- **Overview** — entries, size, hit rate, memory-tier hits, p50/p95 latency, health and recommendations.
- **Entries** — search (text or `/regex/`), filter by tag, inspect metadata and values (rich types shown), edit JSON, change TTL, delete.
- **Tags** — usage per tag, one-click invalidation.
- **Activity** — live event log across all caches.
- **Storage** — backend, origin quota usage, persistent-storage request, ≤0.5 data migration.
- Export / import JSON, cleanup, clear (destructive actions need a confirming second click).

Framework-agnostic (Shadow DOM — no style leaks), auto-discovers engines (`devtools: false` hides one), and supports `readOnly`, `maskEncrypted`, `position`, `theme`, `hotkey`. React users can call `useCacheDevtools()`.

---

## 📈 Observability

```ts
cache.on("operation", ({ metadata }) => console.log(metadata)); // { operation, duration, success }
const stats = await cache.getDetailedStats(); // hit rate, latency p50/p95/p99, sizes by tag…
const health = await cache.getHealth();

import { instrumentOpenTelemetry } from "cache-craft-engine/opentelemetry";
const stop = instrumentOpenTelemetry(cache, { meter: metrics.getMeter("web") });
```

Events: `set`, `get`, `hit`, `miss`, `delete`, `clear`, `evict`, `expire`, `sync`, `error`, `operation`. `on()` returns an unsubscribe function.

---

## 🔌 Plugins

Built-in: `LoggerPlugin`, `MetricsPlugin`, `ValidationPlugin`, `TTLRefreshPlugin` (sliding expiry), `CompressionOptimizerPlugin`, `TagManagerPlugin`, `RateLimiterPlugin`, `PrefetchPlugin`, `WarmupPlugin`, `PersistencePlugin` (localStorage backup; never mirrors encrypted values), `AnalyticsPlugin`, `DebugPlugin` — also available from `cache-craft-engine/plugins`.

```ts
const audit: CachePlugin = {
    name: "audit",
    init(host) { /* host.set / host.has / host.namespace */ },
    beforeSet(key, value, options) { return !key.startsWith("tmp:"); }, // false = skip
    afterGet(key, value, entry) { /* entry.expiresAt may be changed here */ },
    onEvict(keys) { /* … */ },
};
createCache({ plugins: [audit, () => new MetricsPlugin()] }); // factories: one instance per engine
```

---

## 📤 Export / import, maintenance

```ts
const blob = await cache.exportBlob();                 // JSON-safe (binary as Base64)
await other.importBlob(blob, { overwrite: true });     // re-encrypts entries for this database
await cache.export({ decrypt: true });                 // move data to a cache with another key

await cache.cleanup();            // delete expired entries now
await cache.requestPersistence(); // ask the browser not to evict this origin
await cache.migrateLegacy();      // move ≤0.5 data now (it is otherwise migrated on first read)
await cache.destroy();            // flush, stop timers, release storage
```

---

## ⚙️ Configuration

| Option | Default | Description |
|---|---|---|
| `dbName` / `storeName` | `"cache-db"` / `"cache"` | Database and logical store |
| `namespace` | `""` | Isolated key space |
| `storage` | `"indexeddb"` | `"opfs"`, `"memory"`, `"localStorage"`, `"sessionStorage"`, adapter or factory |
| `maxSize` | `"100MB"` | Byte budget (per namespace) |
| `maxEntries` | ∞ | Entry budget |
| `tagQuotas` | — | `{ [tag]: { maxEntries?, maxSize? } }` |
| `evictionStrategy` / `evictionPolicy` | `"lru"` | Strategy, or a custom policy with `"custom"` |
| `evictionTarget` | `0.9` | Evict down to this fraction of the budget |
| `defaultTTL` / `ttlJitter` | — / `0` | Default lifetime and its random shortening |
| `compression` | gzip, 10 KB, 0.9 | `false` or `{ algorithm, threshold, minRatio }` |
| `serializer` / `serializers` | `"rich"` | Writer, plus extra readers |
| `encryptionKey` / `decryptionKeys` / `kdfIterations` | — / — / 600 000 | Encryption |
| `schemaVersion` / `migrate` | — | Value-shape versioning |
| `memoryCache` | off | `true` or `{ maxEntries, maxSize, clone }` |
| `enableSync` | `true` | BroadcastChannel coherence |
| `readThrough` | `true` | Check storage on index misses |
| `crossTab` | `{ singleFlight: false, leaderCleanup: true }` | Web Locks features |
| `quotaRecovery` | `true` | Evict and retry once on quota errors |
| `legacy` | `"migrate"` | ≤0.5 data: `"migrate"` on read, or `"ignore"` |
| `autoCleanup` / `cleanupInterval` | `true` / `"1m"` | Periodic expiry cleanup |
| `persistAccessMetadata` / `accessMetadataFlushInterval` | `true` / `"1s"` | Batched LRU/LFU tracking |
| `plugins`, `onError`, `enableStats`, `devtools`, `label` | | |

Durations accept numbers (ms) or strings: `"500ms"`, `"30s"`, `"5m"`, `"1h30m"`, `"7d"`, `"1w"`. Sizes accept bytes or `"512KB"`, `"50MB"`, `"1GB"`.

---

## 🔑 API reference

**CacheEngine** — `get`, `set`, `getOrSet`, `peek`, `getWithMeta`, `has`, `touch`, `update`, `remove` (`delete`), `clear`, `namespace`, `keys`, `count`, `size`, `keysByTag`, `allTags`, `invalidateByTag(s)`, `invalidateByPattern`, `setBlob`, `getBlob`, `batchSet`, `batchGet`, `getMany`, `batchDelete`, `query`, `queryMeta`, `getStats`, `getDetailedStats`, `resetStats`, `getHealth`, `getStorageInfo`, `requestPersistence`, `export`, `exportJSON`, `exportBlob`, `import`, `importJSON`, `importBlob`, `rotateKey`, `migrateLegacy`, `dropLegacyData`, `cleanup`, `startAutoCleanup`, `stopAutoCleanup`, `flushAccessMetadata`, `ready`, `refresh`, `use`, `removePlugin`, `getPlugins`, `on`, `off`, `once`, `destroy`, `info`, `isDestroyed`.

**Factories** — `createCache`, `createClientCache`, `createTypedCache`.

**Entry points** — `cache-craft-engine`, `/react`, `/vue`, `/svelte`, `/tanstack-query`, `/fetch`, `/opentelemetry`, `/devtools`, `/plugins`, `/admin`.

**Errors** (all extend `CacheError` with a stable `code`): `QuotaExceededError` (`QUOTA_EXCEEDED`), `EncryptionError` (`ENCRYPTION_ERROR`), `UnsupportedEnvironmentError` (`UNSUPPORTED_ENV`), `TimeoutError` (`TIMEOUT`), `SchemaValidationError` (`SCHEMA_INVALID`); plus codes `INVALID_KEY`, `INVALID_VALUE`, `INVALID_ENTRY`, `INVALID_DURATION`, `INVALID_SIZE`, `UNKNOWN_SERIALIZER`, `PLUGIN_REJECTED`, `DESTROYED`, `TX_FAILED`, `IDB_BLOCKED`.

---

## 🌐 Browser support

| Feature | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| Core (IndexedDB, Web Crypto) | ✅ | ✅ | ✅ |
| Compression (`CompressionStream`) | 80+ | 113+ | 16.4+ (skipped when missing) |
| OPFS storage (`createWritable`) | 86+ | 111+ | 26+ |
| Web Locks (cross-tab single-flight, leader cleanup) | 69+ | 96+ | 15.4+ (degrades to per-tab) |
| BroadcastChannel | ✅ | ✅ | 15.4+ |

---

## 🧑‍💻 Development

```bash
npm ci
npm run check          # Biome lint + format
npm run typecheck      # TypeScript 7
npm test               # Vitest (happy-dom + fake-indexeddb)
npm run test:coverage
npm run test:browser   # real Chromium: IndexedDB, OPFS, Web Locks (CHROME_PATH=… locally)
npm run build          # tsdown → ESM + CJS + .d.ts
npm run lint:package   # publint + are-the-types-wrong
npm run size           # size-limit budgets
npm run bench          # browser benchmarks vs idb-keyval / localForage / Dexie
npm run verify         # everything above (runs before publish)
```

Releases: bump `version`, update `CHANGELOG.md`, push a `vX.Y.Z` tag — CI verifies and publishes with npm provenance.

---

## 📚 Upgrading

From 0.x: see [MIGRATION.md](./MIGRATION.md#v05--v10). Existing data is migrated automatically.

## 📝 License

MIT © [Mohammad Javad Soleymani Fard](https://github.com/MJavadSF) and contributors.
