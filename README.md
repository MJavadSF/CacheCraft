# CacheEngine

> A production-grade, client-side cache engine for modern web apps  
> Built on **IndexedDB**, with compression, encoding, LRU eviction, TTL, and stale-while-revalidate support.

---

## 📖 Overview

`CacheEngine` is a reusable, framework-agnostic caching layer for client-side data.  
It is designed to:

- Persist data across page reloads
- Handle large datasets efficiently
- Reduce unnecessary network requests
- Provide smart eviction and expiration
- Support namespaces for logical separation of cache types

It is ideal for caching:

- API responses
- Media metadata
- Offline forms
- Drafts

---

## ⚙ Installation

Copy the `cache-engine.ts` file into your project, e.g.:

```
/lib/cache-engine.ts
```

Then import and initialize:

```ts
import { CacheEngine } from "@/lib/cache-engine";

export const APPCACHE = new CacheEngine({
  dbName: "yaadbood-db",
  version: 12,
  storeName: "Database",
  maxSize: 100 * 1024 * 1024, // 100 MB
  compressionThreshold: 10 * 1024, // 10 KB
});
```

---

## 🧩 API

### `set(key, value, options?)`

Store a value in cache.

```ts
await APPCACHE.set("user:42", { name: "Ali", age: 30 }, {
  ttl: 5 * 60 * 1000, // 5 minutes
  encode: false,
  forceCompress: false,
});
```

- **key** — string
- **value** — any serializable value
- **options** — `CacheSetOptions`
  - `ttl` — Time to live in ms
  - `encode` — Base64 encode value
  - `forceCompress` — Force gzip compression

---

### `get(key, options?)`

Retrieve a value from cache.

```ts
const profile = await APPCACHE.get<{ name: string; age: number }>("user:42", {
  staleWhileRevalidate: true,
  revalidate: async () => {
    const res = await fetch("/api/user/42");
    return res.json();
  },
  ttlOnRevalidate: 5 * 60 * 1000,
});
```

- **staleWhileRevalidate** — returns stale cache immediately and refreshes in background  
- **revalidate** — callback to fetch fresh data  
- **ttlOnRevalidate** — TTL for background update

Returns `T | null`.

---

### `remove(key)`

Delete a cache entry:

```ts
await APPCACHE.remove("user:42");
```

---

### `clear()`

Clear all cache entries:

```ts
await APPCACHE.clear();
```

---

### `namespace(ns)`

Create a namespaced cache instance:

```ts
const mediaCache = APPCACHE.namespace("media");
await mediaCache.set("image:123", { url: "/img/123.jpg" });
```

All keys are automatically prefixed with namespace:

```
media:image:123
```

---

## 🧪 Example Scenarios

### 1. API Response Cache

```ts
async function getPosts() {
  const cached = await APPCACHE.get("posts");
  if (cached) return cached;

  const res = await fetch("/api/posts");
  const data = await res.json();

  await APPCACHE.set("posts", data, { ttl: 5 * 60 * 1000 });
  return data;
}
```

---

### 2. Media Metadata Cache

```ts
const mediaCache = APPCACHE.namespace("media");

await mediaCache.set("image:42", {
  url: "/images/42.jpg",
  description: "Beautiful sunset",
});
```

---

### 3. Offline Form Persistence

```ts
await APPCACHE.set("draft:checkout", formState);
```

---

### 4. Large Dataset Compression

```ts
await APPCACHE.set("analytics", bigData, {
  forceCompress: true,
});
```

---

## ⚡ Features

- **IndexedDB persistence** — survives page reloads
- **LRU eviction** — prevents exceeding storage limits
- **Compression** — automatic gzip for large items
- **Encoding** — optional Base64 encoding
- **TTL expiration** — automatic expiry of cached items
- **stale-while-revalidate** — instant stale data while fetching fresh in background
- **Namespaces** — separate caches for different domains

---

## ✅ Best Practices

- Always namespace different types of data (e.g., `media`, `room`, `user`)  
- Set reasonable TTLs depending on volatility of data  
- Use compression for large datasets (>10 KB)  
- Use `staleWhileRevalidate` for API-heavy applications  

---

## ❌ Anti-patterns

- Caching sensitive data (passwords, tokens)  
- Unlimited TTL for frequently changing data  
- Using same cache instance for unrelated data  

---

## ⚙ Debugging

Clear all cache:

```ts
await APPCACHE.clear();
```

---

## 🔮 Future Extensions

- Service Worker integration for offline-first apps  
- Cache analytics & metrics  
- Priority-based eviction  
- Background sync

---

## 📌 TL;DR

`CacheEngine` provides a production-ready, reusable, and independent caching layer for client-side web applications with advanced features:

- TTL + LRU eviction  
- Compression + encoding  
- Namespaces & revalidation  
- Framework-independent (React, Vue, plain JS)  

It is designed for **reusability**, **scalability**, and **performance** in modern web applications.
