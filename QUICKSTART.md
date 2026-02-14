# 🚀 Quick Start Guide - CacheCraft v0.2

Get started with CacheCraft in 5 minutes!

## Installation

```bash
npm install cachecraft
```

## Basic Usage (30 seconds)

```typescript
import { CacheEngine } from 'cachecraft';

// Create cache
const cache = new CacheEngine();

// Set data
await cache.set('user', { id: 1, name: 'John' });

// Get data
const user = await cache.get('user');
console.log(user); // { id: 1, name: 'John' }
```

That's it! You're caching! 🎉

## Common Patterns

### 1. API Response Caching (2 minutes)

```typescript
import { CacheEngine } from 'cachecraft';

const apiCache = new CacheEngine({ namespace: 'api' });

async function fetchUser(id: number) {
    // Check cache
    const cached = await apiCache.get(`user-${id}`);
    if (cached) return cached;
    
    // Fetch from API
    const user = await fetch(`/api/users/${id}`).then(r => r.json());
    
    // Cache for 5 minutes
    await apiCache.set(`user-${id}`, user, { ttl: 5 * 60 * 1000 });
    
    return user;
}
```

### 2. Image Caching (2 minutes)

```typescript
const imageCache = new CacheEngine({ namespace: 'images' });

async function cacheImage(url: string) {
    // Check cache
    const cached = await imageCache.getBlob(url);
    if (cached) return URL.createObjectURL(cached);
    
    // Fetch image
    const response = await fetch(url);
    const blob = await response.blob();
    
    // Cache for 24 hours
    await imageCache.setBlob(url, blob, { ttl: 24 * 60 * 60 * 1000 });
    
    return URL.createObjectURL(blob);
}
```

### 3. Stale-While-Revalidate (Advanced)

```typescript
const data = await cache.get('key', {
    staleWhileRevalidate: true,
    revalidate: async () => {
        // Fetch fresh data in background
        return await fetchFreshData();
    },
    ttlOnRevalidate: 5 * 60 * 1000 // 5 minutes
});
```

## Enable Monitoring (1 minute)

```typescript
import { CacheEngine, CacheAdminPanel } from 'cachecraft';

const cache = new CacheEngine({ enableStats: true });
const admin = new CacheAdminPanel(cache);

// Check stats anytime
const stats = cache.getStats();
console.log('Hit rate:', stats.hitRate);
console.log('Total size:', stats.totalSize);

// Generate report
const report = await admin.generateReport();
console.log(report);
```

## Add Logging (30 seconds)

```typescript
import { CacheEngine, LoggerPlugin } from 'cachecraft';

const cache = new CacheEngine({
    plugins: [new LoggerPlugin()]
});

// All operations are now logged!
await cache.set('key', 'value'); // Logs: [CACHE] Set: key (5 bytes)
```

## Use Different Eviction (30 seconds)

```typescript
// Keep frequently used items
const cache = new CacheEngine({
    evictionStrategy: 'lfu' // or 'lru', 'fifo', 'priority'
});
```

## Organize with Tags (1 minute)

```typescript
// Set with tags
await cache.set('user-1', userData, {
    tags: ['users', 'active'],
    priority: 10
});

// Query by tags
const activeUsers = await cache.query({
    tags: ['active']
});
```

## Batch Operations (1 minute)

```typescript
// Set multiple items at once (faster!)
await cache.batchSet([
    { key: 'user-1', value: user1 },
    { key: 'user-2', value: user2 },
    { key: 'user-3', value: user3 }
]);

// Get multiple items at once
const results = await cache.batchGet([
    { key: 'user-1' },
    { key: 'user-2' },
    { key: 'user-3' }
]);
```

## React Hook Example

```typescript
import { useEffect, useState } from 'react';
import { CacheEngine } from 'cachecraft';

const cache = new CacheEngine();

function useCache<T>(key: string, fetcher: () => Promise<T>) {
    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function load() {
            // Check cache
            let result = await cache.get<T>(key);
            
            if (!result) {
                // Fetch and cache
                result = await fetcher();
                await cache.set(key, result, { ttl: 5 * 60 * 1000 });
            }
            
            setData(result);
            setLoading(false);
        }
        
        load();
    }, [key]);

    return { data, loading };
}

// Usage
function UserProfile({ userId }: { userId: number }) {
    const { data: user, loading } = useCache(
        `user-${userId}`,
        () => fetch(`/api/users/${userId}`).then(r => r.json())
    );

    if (loading) return <div>Loading...</div>;
    return <div>{user?.name}</div>;
}
```

## Configuration Options

```typescript
const cache = new CacheEngine({
    dbName: 'my-cache',              // Database name
    maxSize: 100 * 1024 * 1024,      // 100MB max
    compressionThreshold: 10 * 1024,  // Compress > 10KB
    namespace: 'app',                 // Namespace for isolation
    evictionStrategy: 'lru',          // LRU, LFU, FIFO, Priority
    enableStats: true,                // Track statistics
    enableSync: true,                 // Sync across tabs
    autoCleanup: true,                // Auto-remove expired
    cleanupInterval: 60000,           // Every 60 seconds
});
```

## Common Operations Cheatsheet

```typescript
// Basic operations
await cache.set(key, value);
const data = await cache.get(key);
await cache.remove(key);
await cache.clear();

// With options
await cache.set(key, value, {
    ttl: 60000,        // Expire after 60 seconds
    compress: true,    // Compress data
    encrypt: true,     // Encrypt data
    tags: ['tag1'],    // Add tags
    priority: 10       // Set priority
});

// Check existence
const exists = await cache.has(key);

// Get info
const size = await cache.size();      // Total size in bytes
const count = await cache.count();    // Number of entries
const keys = await cache.keys();      // All keys

// Statistics
const stats = cache.getStats();
console.log(stats.hitRate);           // Hit rate %
console.log(stats.totalSize);         // Total size

// Namespaces
const userCache = cache.namespace('users');
const productCache = cache.namespace('products');

// Events
cache.on('hit', (data) => console.log('Hit:', data.key));
cache.on('miss', (data) => console.log('Miss:', data.key));
```

## Next Steps

1. 📖 Read the [Full Documentation](./README.md)
2. 💡 Check out [More Examples](./examples.ts)
3. 🔄 See [Migration Guide](./MIGRATION.md) if coming from v1
4. 📊 Explore the Admin Panel features
5. 🔌 Create custom plugins

## Tips

1. **Use namespaces** to organize different types of data
2. **Enable stats** to monitor cache performance
3. **Set appropriate TTL** to balance freshness and performance
4. **Use batch operations** when working with multiple items
5. **Add tags** to make queries easier
6. **Try different eviction strategies** to find what works best

## Common Issues

### Q: My data isn't persisting
**A:** IndexedDB is browser storage - it persists across page reloads but can be cleared by user

### Q: Cache is full
**A:** Increase `maxSize` or use a more aggressive eviction strategy

### Q: Slow performance
**A:** Enable compression for large data, use batch operations, check eviction strategy

### Q: How to debug?
**A:** Use `DebugPlugin` for detailed logging:
```typescript
import { DebugPlugin } from 'cachecraft';
cache.use(new DebugPlugin(true)); // Verbose mode
```

## Support

- 🐛 [Report Issues](https://github.com/MJavadSF/CacheCraft/issues)
- 💬 [Discussions](https://github.com/MJavadSF/CacheCraft/discussions)
- 📧 Email: [your-email]

## That's It!

You're now ready to build with CacheCraft! 🚀

Start simple, add features as you need them. Happy caching!
