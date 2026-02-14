import {
    CacheEngine,
    CacheAdminPanel,
    LoggerPlugin,
    MetricsPlugin,
    ValidationPlugin,
    TagManagerPlugin,
    DebugPlugin,
} from './src/index';

// ==============================
// Example 1: Basic Usage
// ==============================

async function basicUsageExample() {
    console.log('=== Basic Usage ===');
    
    const cache = new CacheEngine();

    // Set
    await cache.set('user:1', { id: 1, name: 'John' });
    
    // Get
    const user = await cache.get('user:1');
    console.log('User:', user);
    
    // Remove
    await cache.remove('user:1');
    
    // Stats
    const stats = cache.getStats();
    console.log('Stats:', stats);
}

// ==============================
// Example 2: Advanced Configuration
// ==============================

async function advancedConfigExample() {
    console.log('=== Advanced Configuration ===');
    
    const cache = new CacheEngine({
        dbName: 'my-app-cache',
        maxSize: 50 * 1024 * 1024, // 50MB
        evictionStrategy: 'lru',
        enableStats: true,
        enableSync: true,
        encryptionKey: 'my-secret-key-must-be-at-least-32-chars',
        plugins: [
            new LoggerPlugin(),
            new MetricsPlugin(),
            new DebugPlugin(false)
        ]
    });

    await cache.set('data', { value: 'encrypted' }, { encrypt: true });
    const data = await cache.get('data');
    console.log('Encrypted data:', data);
}

// ==============================
// Example 3: Plugin System
// ==============================

async function pluginExample() {
    console.log('=== Plugin System ===');
    
    const cache = new CacheEngine({ enableStats: true });
    
    // Add logger plugin
    cache.use(new LoggerPlugin(console.log));
    
    // Add metrics plugin
    const metrics = new MetricsPlugin();
    cache.use(metrics);
    
    // Add validation plugin
    const validator = new ValidationPlugin();
    validator.addValidator(/^user-/, (value) => {
        return value && value.id !== undefined;
    });
    cache.use(validator);
    
    // Add tag manager
    const tagManager = new TagManagerPlugin();
    cache.use(tagManager);
    
    // Set with tags
    await cache.set('user-1', { id: 1, name: 'John' }, {
        tags: ['users', 'active'],
        priority: 10
    });
    
    // Get keys with tag
    const activeUsers = tagManager.getKeysWithTag('active');
    console.log('Active users:', activeUsers);
    
    // Get metrics
    console.log('Metrics:', metrics.getAllMetrics());
}

// ==============================
// Example 4: Batch Operations
// ==============================

async function batchOperationsExample() {
    console.log('=== Batch Operations ===');
    
    const cache = new CacheEngine();
    
    // Batch set
    await cache.batchSet([
        { key: 'user-1', value: { id: 1, name: 'John' } },
        { key: 'user-2', value: { id: 2, name: 'Jane' } },
        { key: 'user-3', value: { id: 3, name: 'Bob' } }
    ]);
    
    // Batch get
    const results = await cache.batchGet([
        { key: 'user-1' },
        { key: 'user-2' },
        { key: 'user-3' }
    ]);
    
    console.log('Batch get results:', results);
    
    // Batch delete
    await cache.batchDelete(['user-1', 'user-2', 'user-3']);
}

// ==============================
// Example 5: Query System
// ==============================

async function queryExample() {
    console.log('=== Query System ===');
    
    const cache = new CacheEngine();
    
    // Add some data
    await cache.set('user-1', { id: 1, name: 'John', age: 30 }, {
        tags: ['users', 'premium'],
        priority: 10
    });
    
    await cache.set('user-2', { id: 2, name: 'Jane', age: 25 }, {
        tags: ['users'],
        priority: 5
    });
    
    await cache.set('product-1', { id: 1, name: 'Laptop', price: 1000 }, {
        tags: ['products'],
        priority: 7
    });
    
    // Query by tags
    const premiumUsers = await cache.query({
        tags: ['premium'],
        sortBy: 'priority',
        sortOrder: 'desc'
    });
    
    console.log('Premium users:', premiumUsers);
    
    // Query by pattern
    const allUsers = await cache.query({
        pattern: /^user-/,
        limit: 10
    });
    
    console.log('All users:', allUsers);
    
    // Query by priority
    const highPriority = await cache.query({
        minPriority: 8,
        sortBy: 'priority',
        sortOrder: 'desc'
    });
    
    console.log('High priority items:', highPriority);
}

// ==============================
// Example 6: Admin Panel
// ==============================

async function adminPanelExample() {
    console.log('=== Admin Panel ===');
    
    const cache = new CacheEngine({ enableStats: true });
    const admin = new CacheAdminPanel(cache);
    
    // Add some data
    for (let i = 0; i < 10; i++) {
        await cache.set(`item-${i}`, { value: `data-${i}` }, {
            tags: i % 2 === 0 ? ['even'] : ['odd'],
            priority: i
        });
    }
    
    // Access some items
    await cache.get('item-1');
    await cache.get('item-2');
    await cache.get('item-2'); // Access twice
    
    // Get admin data
    const data = await admin.getData();
    console.log('Admin data:', {
        stats: data.stats,
        health: data.health,
        topKeys: data.topKeys.slice(0, 3),
        recentActivity: data.recentActivity.slice(0, 5)
    });
    
    // Generate report
    const report = await admin.generateReport();
    console.log('Report:\n', report);
    
    // Dashboard data
    const dashboardData = await admin.getDashboardData();
    console.log('Dashboard data:', dashboardData);
}

// ==============================
// Example 7: Event System
// ==============================

async function eventSystemExample() {
    console.log('=== Event System ===');
    
    const cache = new CacheEngine();
    
    // Listen to events
    cache.on('set', (data) => {
        console.log('Event: Item set', data.key);
    });
    
    cache.on('hit', (data) => {
        console.log('Event: Cache hit', data.key);
    });
    
    cache.on('miss', (data) => {
        console.log('Event: Cache miss', data.key);
    });
    
    cache.on('evict', (data) => {
        console.log('Event: Eviction', data.metadata);
    });
    
    // Trigger events
    await cache.set('key1', 'value1');
    await cache.get('key1'); // Hit
    await cache.get('key2'); // Miss
}

// ==============================
// Example 8: Export/Import
// ==============================

async function exportImportExample() {
    console.log('=== Export/Import ===');
    
    const cache1 = new CacheEngine({ dbName: 'cache1' });
    
    // Add data
    await cache1.set('key1', 'value1');
    await cache1.set('key2', 'value2');
    
    // Export
    const exported = await cache1.export({
        includeExpired: false,
        compress: false
    });
    
    console.log('Exported entries:', Object.keys(exported.entries).length);
    
    // Import to another cache
    const cache2 = new CacheEngine({ dbName: 'cache2' });
    const imported = await cache2.import(exported, {
        overwrite: true
    });
    
    console.log('Imported entries:', imported);
    
    // Verify
    const value = await cache2.get('key1');
    console.log('Imported value:', value);
}

// ==============================
// Example 9: API Response Caching
// ==============================

async function apiCachingExample() {
    console.log('=== API Response Caching ===');
    
    const apiCache = new CacheEngine({
        namespace: 'api',
        maxSize: 50 * 1024 * 1024,
        evictionStrategy: 'lru',
        enableStats: true
    });
    
    async function cachedFetch(url: string) {
        const cacheKey = url;
        
        // Check cache with stale-while-revalidate
        const cached = await apiCache.get(cacheKey, {
            staleWhileRevalidate: true,
            revalidate: async () => {
                console.log('Revalidating:', url);
                const response = await fetch(url);
                return response.json();
            },
            ttlOnRevalidate: 5 * 60 * 1000
        });
        
        if (cached) {
            console.log('Cache hit:', url);
            return cached;
        }
        
        // Fresh fetch
        console.log('Cache miss, fetching:', url);
        const response = await fetch(url);
        const data = await response.json();
        
        // Cache response
        await apiCache.set(cacheKey, data, {
            ttl: 5 * 60 * 1000,
            tags: ['api-response'],
            compress: true
        });
        
        return data;
    }
    
    // Example usage
    // const userData = await cachedFetch('https://api.example.com/users/1');
    console.log('API caching setup complete');
}

// ==============================
// Example 10: Multi-Layer Cache
// ==============================

async function multiLayerCacheExample() {
    console.log('=== Multi-Layer Cache ===');
    
    // L1: Hot data (small, fast)
    const l1 = new CacheEngine({
        namespace: 'l1',
        maxSize: 10 * 1024 * 1024, // 10MB
        evictionStrategy: 'lfu'
    });
    
    // L2: Warm data (larger, slower)
    const l2 = new CacheEngine({
        namespace: 'l2',
        maxSize: 100 * 1024 * 1024, // 100MB
        evictionStrategy: 'lru'
    });
    
    async function multiGet<T>(key: string): Promise<T | null> {
        // Check L1
        let value = await l1.get<T>(key);
        if (value) {
            console.log('L1 hit:', key);
            return value;
        }
        
        // Check L2
        value = await l2.get<T>(key);
        if (value) {
            console.log('L2 hit, promoting to L1:', key);
            await l1.set(key, value);
            return value;
        }
        
        console.log('Cache miss:', key);
        return null;
    }
    
    async function multiSet<T>(key: string, value: T): Promise<void> {
        await Promise.all([
            l1.set(key, value),
            l2.set(key, value)
        ]);
        console.log('Set in both layers:', key);
    }
    
    // Example usage
    await multiSet('data', { value: 'test' });
    const result1 = await multiGet('data'); // L1 hit
    const result2 = await multiGet('data'); // L1 hit
    console.log('Multi-layer result:', result1);
}

// ==============================
// Run All Examples
// ==============================

async function runAllExamples() {
    try {
        await basicUsageExample();
        console.log('\n');
        
        await advancedConfigExample();
        console.log('\n');
        
        await pluginExample();
        console.log('\n');
        
        await batchOperationsExample();
        console.log('\n');
        
        await queryExample();
        console.log('\n');
        
        await adminPanelExample();
        console.log('\n');
        
        await eventSystemExample();
        console.log('\n');
        
        await exportImportExample();
        console.log('\n');
        
        await apiCachingExample();
        console.log('\n');
        
        await multiLayerCacheExample();
        
        console.log('\n=== All examples completed! ===');
    } catch (error) {
        console.error('Error running examples:', error);
    }
}

// Run examples
runAllExamples();
