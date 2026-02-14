# Migration Guide: v1 → v2

CacheCraft v0.2 is **100% backward compatible** with v1. Your existing code will work without any changes!

## What's New in v2?

### ✨ New Features (All Optional)

1. **Plugin System** - Extend functionality
2. **Admin Panel** - Built-in monitoring
3. **Multiple Eviction Strategies** - LRU, LFU, FIFO, Priority, ARC, TTL, Size
4. **Encryption** - Secure your data
5. **Tab Sync** - Cross-tab synchronization
6. **Advanced Query System** - Search and filter
7. **Batch Operations** - Bulk get/set/delete
8. **Event System** - React to cache operations
9. **Export/Import** - Backup and restore
10. **Tags & Metadata** - Better organization
11. **Statistics** - Detailed monitoring

## No Breaking Changes!

All v1 code works in v2:

```typescript
// v1 code - still works perfectly!
import { CacheEngine } from 'cachecraft';

const cache = new CacheEngine();
await cache.set('key', 'value');
const result = await cache.get('key');
await cache.remove('key');
await cache.clear();
```

## Gradual Adoption

You can adopt v2 features gradually without changing existing code:

### Step 1: Update Package

```bash
npm install cachecraft@latest
```

### Step 2: Keep Using v1 API

Your existing code continues to work:

```typescript
// All your existing v1 code works!
const cache = new CacheEngine({
    dbName: 'my-cache',
    version: 1,
    storeName: 'cache',
    maxSize: 100 * 1024 * 1024,
    compressionThreshold: 10 * 1024,
    namespace: 'app'
});

await cache.set('user', { id: 1, name: 'John' }, {
    ttl: 60000,
    encode: true,
    forceCompress: true
});

const user = await cache.get('user', {
    staleWhileRevalidate: true,
    revalidate: async () => fetchUser(),
    ttlOnRevalidate: 30000
});

await cache.setBlob('image', blob, { ttl: 86400000 });
const image = await cache.getBlob('image');
```

### Step 3: Try New Features When Ready

#### Add Statistics

```typescript
// Enable stats - no other changes needed
const cache = new CacheEngine({
    // ... your existing config
    enableStats: true  // NEW
});

// Now you can check stats
const stats = cache.getStats();
console.log('Hit rate:', stats.hitRate);
```

#### Add Logging

```typescript
import { CacheEngine, LoggerPlugin } from 'cachecraft';

const cache = new CacheEngine({
    // ... your existing config
    plugins: [new LoggerPlugin()]  // NEW
});

// All your existing code works, now with logging!
```

#### Monitor Performance

```typescript
import { CacheEngine, CacheAdminPanel } from 'cachecraft';

const cache = new CacheEngine({
    // ... your existing config
    enableStats: true
});

// Add admin panel
const admin = new CacheAdminPanel(cache);

// Get insights (without changing any existing code!)
const data = await admin.getData();
console.log(data.stats);
console.log(data.health);
```

### Step 4: Enhance Gradually

Now you can enhance specific parts of your app:

#### Better Eviction

```typescript
const cache = new CacheEngine({
    // ... your existing config
    evictionStrategy: 'lfu'  // NEW - try different strategies
});
```

#### Add Tags for Organization

```typescript
// Your existing code
await cache.set('user-1', userData);

// Enhanced with tags (optional)
await cache.set('user-1', userData, {
    tags: ['users', 'active'],  // NEW
    priority: 10  // NEW
});

// Query by tags later
const activeUsers = await cache.query({
    tags: ['active']
});
```

#### Batch Operations for Better Performance

```typescript
// Old way (still works)
await cache.set('user-1', user1);
await cache.set('user-2', user2);
await cache.set('user-3', user3);

// New way (faster!)
await cache.batchSet([
    { key: 'user-1', value: user1 },
    { key: 'user-2', value: user2 },
    { key: 'user-3', value: user3 }
]);
```

#### Add Encryption for Sensitive Data

```typescript
const cache = new CacheEngine({
    // ... your existing config
    encryptionKey: 'your-secret-key-32-chars'  // NEW
});

// Encrypt specific items
await cache.set('sensitive', data, {
    encrypt: true  // NEW
});
```

## Data Migration

**No data migration needed!** Your existing cache data works with v2.

The v2 CacheEntry type is backward compatible:

```typescript
// v1 CacheEntry
{
    value: any,
    isEncoded: boolean,
    isCompressed: boolean,
    createdAt: number,
    lastAccessed: number,
    expiresAt?: number,
    size: number
}

// v2 CacheEntry (all new fields are optional)
{
    value: any,
    isEncoded: boolean,
    isCompressed: boolean,
    createdAt: number,
    lastAccessed: number,
    expiresAt?: number,
    size: number,
    // NEW fields (all optional - won't break v1 data)
    isEncrypted?: boolean,
    accessCount?: number,
    tags?: string[],
    metadata?: Record<string, any>,
    priority?: number
}
```

## Feature Comparison

| Feature | v1 | v2 |
|---------|----|----|
| Basic set/get | ✅ | ✅ |
| TTL expiration | ✅ | ✅ |
| Compression | ✅ | ✅ |
| Encoding | ✅ | ✅ |
| Blob storage | ✅ | ✅ |
| Namespaces | ✅ | ✅ |
| Stale-while-revalidate | ✅ | ✅ |
| LRU eviction | ✅ | ✅ |
| Multiple eviction strategies | ❌ | ✅ |
| Encryption | ❌ | ✅ |
| Statistics | ❌ | ✅ |
| Plugins | ❌ | ✅ |
| Event system | ❌ | ✅ |
| Query system | ❌ | ✅ |
| Batch operations | ❌ | ✅ |
| Tags & metadata | ❌ | ✅ |
| Admin panel | ❌ | ✅ |
| Export/Import | ❌ | ✅ |
| Tab sync | ❌ | ✅ |
| Health checks | ❌ | ✅ |

## Examples: Before & After

### Example 1: Basic Usage

```typescript
// v1 - Still works!
const cache = new CacheEngine();
await cache.set('user', userData);
const user = await cache.get('user');

// v2 - Same code, now with optional enhancements
const cache = new CacheEngine({
    enableStats: true  // Optional
});
await cache.set('user', userData);
const user = await cache.get('user');
console.log(cache.getStats()); // New feature
```

### Example 2: API Caching

```typescript
// v1 - Still works!
const apiCache = new CacheEngine({ namespace: 'api' });

async function fetchUser(id) {
    const cached = await apiCache.get(`user-${id}`, {
        staleWhileRevalidate: true,
        revalidate: () => fetch(`/api/users/${id}`).then(r => r.json())
    });
    
    if (cached) return cached;
    
    const data = await fetch(`/api/users/${id}`).then(r => r.json());
    await apiCache.set(`user-${id}`, data, { ttl: 300000 });
    return data;
}

// v2 - Same code with optional monitoring
const apiCache = new CacheEngine({
    namespace: 'api',
    enableStats: true,  // Optional
    plugins: [new LoggerPlugin()]  // Optional
});

// Your function works unchanged!
// But now you can check stats:
console.log('API cache hit rate:', apiCache.getStats().hitRate);
```

### Example 3: Image Caching

```typescript
// v1 - Still works!
const imageCache = new CacheEngine({ namespace: 'images' });

async function cacheImage(url) {
    const cached = await imageCache.getBlob(url);
    if (cached) return URL.createObjectURL(cached);
    
    const response = await fetch(url);
    const blob = await response.blob();
    await imageCache.setBlob(url, blob, { ttl: 86400000 });
    return URL.createObjectURL(blob);
}

// v2 - Same code, now with better eviction
const imageCache = new CacheEngine({
    namespace: 'images',
    evictionStrategy: 'lfu'  // Optional - keeps frequently used images
});

// Your function works unchanged!
```

## Recommended Migration Path

### Phase 1: Update Package (Day 1)
```bash
npm install cachecraft@latest
```
✅ Test that everything still works (it will!)

### Phase 2: Enable Stats (Week 1)
```typescript
const cache = new CacheEngine({
    // ... existing config
    enableStats: true
});
```
✅ Start monitoring performance

### Phase 3: Add Admin Panel (Week 2)
```typescript
const admin = new CacheAdminPanel(cache);
const report = await admin.generateReport();
```
✅ Get insights into cache behavior

### Phase 4: Optimize Based on Data (Week 3+)
Based on admin panel data:
- Add tags for better organization
- Try different eviction strategies
- Use batch operations where helpful
- Add encryption for sensitive data
- Implement custom plugins

## Common Questions

### Q: Will my existing cache data work with v2?
**A:** Yes! v2 reads v1 data perfectly.

### Q: Do I need to migrate my data?
**A:** No migration needed.

### Q: Can I use v1 and v2 features together?
**A:** Absolutely! Mix and match as needed.

### Q: What if I don't want any new features?
**A:** Don't use them! Your v1 code works as-is.

### Q: Can I rollback to v1 if needed?
**A:** Yes, but you'll lose v2-specific features (tags, etc).

### Q: Do new features affect performance?
**A:** No! New features are opt-in and don't affect basic operations.

## Getting Help

- 📖 [Full Documentation](./README.md)
- 💬 [GitHub Discussions](https://github.com/MJavadSF/CacheCraft/discussions)
- 🐛 [Report Issues](https://github.com/MJavadSF/CacheCraft/issues)
- 💡 [See Examples](./examples.ts)

## Summary

✅ **Zero breaking changes**
✅ **100% backward compatible**
✅ **Optional new features**
✅ **Gradual adoption**
✅ **No data migration**
✅ **Better performance options**

Update today and enhance at your own pace!
